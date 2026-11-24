// broker 的传输层约定：Windows 命名管道 + 一行一个 JSON。
//
// 管道名由「用户@机器」派生，同一台机器的同一用户共享一个 broker；
// 不同 Windows 会话/用户不会互串。测试可用 SW_MCP_BROKER_PIPE 覆盖。
import { createHash } from 'node:crypto'
import { hostname, userInfo } from 'node:os'

export const BROKER_PROTOCOL_VERSION = 1

/** 会带上 clientId 的方法：broker 用它把「连接」和「MCP 会话」对上，
 * 连接一断就能立刻释放该会话的实例绑定（connect 断开 = 会话进程没了）。
 * 参数名统一是 params.clientId，server.mjs 每条请求都带同一个 SW_CLIENT_ID。 */
export const CLIENT_SCOPED_METHODS = new Set([
  'jobs.run', 'jobs.dispatch', 'instances.ensure', 'instances.bound', 'instances.release',
  'instances.reap', 'instances.quit', 'documents.list', 'documents.release',
])

/** 从请求参数里取会话 id；没有就返回 null（不猜、不按进程名找）。
 * 只认非空字符串：调用方拼错了参数就当作匿名连接，不要拿数字或对象去对会话。 */
export function requestClientId(params) {
  const value = params?.clientId
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

export function brokerPipeName({ user, host, override = process.env.SW_MCP_BROKER_PIPE } = {}) {
  if (override) return override
  const name = `${user ?? userInfo().username}@${host ?? hostname()}`.toLowerCase()
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 16)
  return `\\\\.\\pipe\\sw-mcp-broker-${hash}`
}

export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`
}

/** 把 socket 的任意分片切成完整 JSON 行；坏行丢弃而不是让整个 broker 崩掉。 */
export class LineDecoder {
  constructor({ maxBytes = 8 * 1024 * 1024, onMessage, onError } = {}) {
    this.buffer = ''
    this.maxBytes = maxBytes
    this.onMessage = onMessage
    this.onError = onError
  }

  push(chunk) {
    this.buffer += chunk
    if (this.buffer.length > this.maxBytes) {
      const dropped = this.buffer.length
      this.buffer = ''
      this.onError?.(new Error(`broker 行超过 ${this.maxBytes} 字节（收到 ${dropped}），已丢弃`))
      return
    }
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch (error) {
        this.onError?.(new Error(`broker 收到坏 JSON：${error.message}`))
        continue
      }
      this.onMessage?.(message)
    }
  }
}
