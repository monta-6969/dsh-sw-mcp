// One MCP session over stdio, for tests and for the design runner.
//
// The JSON-RPC plumbing was copied into every test file at first; that meant five
// copies of the same framing bug every time framing changed. One client, one place.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(here, '..', '..')
export const serverEntry = join(repoRoot, 'server', 'server.mjs')

/** 从 workspace 迁到 workspace_ops 的运维动作（tool-face.mjs 的 TOOL_SPLITS）。 */
const MOVED_WORKSPACE_OPS = new Set([
  'status', 'instances', 'reap', 'ui', 'reload', 'cleanup', 'reclaim',
  'closePath', 'close', 'quit', 'logs',
])

/**
 * instance          → 给 server 进程加 `--instance <pid>`（并按 server.mjs 读取的
 *                     SW_MCP_INSTANCE 一并钉住，否则直连桥接器仍会 INSTANCE_NOT_BOUND）。
 * allowActiveObject → env 加 SW_MCP_ALLOW_ACTIVE_OBJECT=1，允许直连已打开的活动文档。
 * 两个都可选：不传时与旧行为完全一致。
 */
export function openSession({ entry = serverEntry, cwd, env, instance, allowActiveObject = false, timeoutMs = 600_000 } = {}) {
  const spawnArgs = [entry]
  const pinnedPid = Number(instance)
  const pinned = Number.isInteger(pinnedPid) && pinnedPid > 0 ? pinnedPid : null
  if (pinned !== null) spawnArgs.push('--instance', String(pinned))
  const childEnv = { ...(env ?? process.env) }
  if (allowActiveObject) childEnv.SW_MCP_ALLOW_ACTIVE_OBJECT = '1'
  if (pinned !== null && !childEnv.SW_MCP_INSTANCE) childEnv.SW_MCP_INSTANCE = String(pinned)

  const child = spawn(process.execPath, spawnArgs, {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: cwd ?? repoRoot,
    env: childEnv,
  })

  let buffer = ''
  let nextId = 1
  const waiters = new Map()
  const startedAt = Date.now()

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = waiters.get(message.id)
      if (!waiter) continue
      waiters.delete(message.id)
      waiter(message.result ?? message.error)
    }
  })

  const call = (method, params) =>
    new Promise((resolvePromise, rejectPromise) => {
      const id = nextId++
      waiters.set(id, resolvePromise)
      const timer = setTimeout(() => {
        waiters.delete(id)
        rejectPromise(new Error(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      const settle = waiters.get(id)
      waiters.set(id, (value) => {
        clearTimeout(timer)
        settle(value)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const session = {
    child,
    call,
    async start() {
      await call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'sw-mcp-client', version: '0' },
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
      return session
    },
    /** Calls a tool and parses the JSON envelope out of the text content block. */
    async tool(name, args) {
      const request = async (toolName, toolArgs) => {
        const result = await call('tools/call', { name: toolName, arguments: toolArgs ?? {} })
        const text = result?.content?.find((c) => c.type === 'text')?.text
        // 未知工具 / 协议错误 / SDK 的入参校验错误不会带回 JSON envelope。以前这里
        // 直接 JSON.parse，于是「工具没注册」被报成 SyntaxError，把真正的原因盖住。
        if (!text) {
          return {
            status: 'error',
            summary: result?.message ?? 'no text content',
            code: result?.code,
            content: result?.content,
          }
        }
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          return { status: 'error', summary: String(text).slice(0, 2000), content: result?.content }
        }
        // Images travel beside the envelope; keep them reachable without printing bytes.
        const image = result.content?.find((c) => c.type === 'image')
        if (image) parsed._image = image
        return parsed
      }

      const parsed = await request(name, args ?? {})
      // 旧测试文件仍写 workspace action=<迁走的运维动作>（status/cleanup/reap/quit/
      // open/reload/…）。这些已归按需组 workspace_ops；这里在**测试客户端**做一次
      // 兼容重路由，避免为了一个 action 改名去改十几个既有用例。
      const moved = name === 'workspace' && parsed?.status === 'error'
        && MOVED_WORKSPACE_OPS.has(args?.action)
      if (!moved) return parsed
      try { await request('catalog', { action: 'activate', capability: 'workspace_ops' }) } catch { /* 旧工具面 */ }
      return request('workspace_ops', args ?? {})
    },
    /**
     * Runs one tool call and throws when it fails, so a design script reads as a
     * sequence of steps instead of a sequence of null checks.
     */
    async must(name, args, what) {
      const result = await session.tool(name, args)
      if (result.status === 'error' || result.status === 'failed') {
        const code = result.extra?.error?.code ?? result.status
        const message = result.extra?.error?.message ?? result.summary
        throw new Error(`${what ?? name} failed [${code}] ${message}`)
      }
      return result
    },
    close() {
      child.kill()
    },
    elapsed() {
      return Date.now() - startedAt
    },
  }
  return session
}
