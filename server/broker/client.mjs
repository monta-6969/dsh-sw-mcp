// broker 客户端：优先连现有常驻进程，没有就起一个 detached 的。
//
// MCP 会话可以短命，broker 不必跟着死；作业按 jobId 落盘，重连后还能取结果。
import net from 'node:net'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { brokerPipeName, encodeMessage, LineDecoder } from './protocol.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const brokerScript = join(here, 'brokerd.mjs')
const LOCAL_SOURCE_HASH = createHash('sha256').update(readFileSync(brokerScript)).digest('hex').slice(0, 16)

export class BrokerError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'BrokerError'
    this.code = code
    this.details = details
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tryConnect(pipe, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(Object.assign(new Error(`连接 ${pipe} 超时`), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

export class BrokerClient {
  constructor(socket, pipe) {
    this.socket = socket
    this.pipe = pipe
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    socket.setEncoding('utf8')
    this.decoder = new LineDecoder({
      onMessage: (message) => this.#dispatch(message),
      onError: () => { },
    })
    socket.on('data', (chunk) => this.decoder.push(chunk))
    socket.on('close', () => this.#failAll(new BrokerError('BROKER_CLOSED', 'broker 连接已关闭')))
    socket.on('error', () => { })
  }

  static async connect({ pipe = brokerPipeName(), spawnIfMissing = true, timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let spawnOnce = spawnIfMissing
    let lastError = null
    let healed = false
    while (Date.now() < deadline) {
      try {
        const socket = await tryConnect(pipe, Math.min(2000, Math.max(250, deadline - Date.now())))
        const client = new BrokerClient(socket, pipe)
        // 常驻进程可能还加载着上一版 brokerd：源码哈希不同就让位给新代码，
        // 否则测试会连到一个「看起来能跑、语义已过期」的 broker。
        let hello = null
        try { hello = await client.request('hello', {}, { timeoutMs: 2000 }) } catch { /* 老版本可能没有 hello 超时语义 */ }
        if (hello && hello.sourceHash !== LOCAL_SOURCE_HASH) {
          if (healed) {
            client.close()
            throw new BrokerError('BROKER_VERSION_MISMATCH',
              `broker 源码版本不一致（远 ${hello.sourceHash ?? 'unknown'} / 本 ${LOCAL_SOURCE_HASH}）且重启后仍未更新`,
              { remote: hello.sourceHash, local: LOCAL_SOURCE_HASH })
          }
          try { await client.request('shutdown', {}, { timeoutMs: 1000 }) } catch { /* 旧进程可能不认 */ }
          client.close()
          healed = true
          spawnOnce = true
          await sleep(700)
          continue
        }
        return client
      } catch (error) {
        lastError = error
        if (error.code === 'EADDRINUSE') break
        if (spawnOnce) {
          spawnOnce = false
          const child = spawn(process.execPath, [brokerScript, '--pipe', pipe], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          })
          child.unref()
        }
        await sleep(120)
      }
    }
    throw new BrokerError('BROKER_UNAVAILABLE',
      `连不上 broker（${pipe}）：${lastError?.message ?? '超时'}`, { pipe, cause: lastError?.code })
  }

  #dispatch(message) {
    if (typeof message?.id !== 'number') return
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.ok) waiter.resolve(message.result)
    else {
      const error = new BrokerError(message.error?.code ?? 'BROKER_ERROR',
        message.error?.message ?? 'broker 返回失败', message.error?.details)
      waiter.reject(error)
    }
  }

  #failAll(error) {
    this.closed = true
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  request(method, params = {}, { timeoutMs = 60_000 } = {}) {
    if (this.closed) return Promise.reject(new BrokerError('BROKER_CLOSED', 'broker 连接已关闭'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BrokerError('BROKER_TIMEOUT', `${method} 超过 ${timeoutMs}ms 没有响应`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(encodeMessage({ id, method, params }))
    })
  }

  hello() { return this.request('hello') }
  submitJob(spec) { return this.request('jobs.submit', spec) }
  getJob(jobId) { return this.request('jobs.get', { jobId }) }
  listJobs(filter = {}) { return this.request('jobs.list', filter) }
  cancelJob(jobId) { return this.request('jobs.cancel', { jobId }) }

  close() {
    this.closed = true
    try { this.socket.end() } catch { }
  }
}
