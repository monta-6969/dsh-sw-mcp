// 每个 SolidWorks 实例一个常驻 worker，请求串行。
//
// broker 只管排队与状态；真正的 COM 调用在 worker 的 STA 线程上。
// 这里用一行 JSON 的 stdio 协议，和 MCP 服务端直连桥接器时是同一个协议，
// 所以 worker 可以独立启动、独立诊断。
import { spawn } from 'node:child_process'

export class WorkerError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'WorkerError'
    this.code = code
    this.details = details
  }
}

export class Worker {
  constructor({ command, instancePid = 0, startupTimeoutMs = 15_000 }) {
    if (!Array.isArray(command) || command.length === 0) {
      throw new WorkerError('WORKER_COMMAND_MISSING', '没有可启动的 worker 命令')
    }
    this.command = command
    this.instancePid = instancePid
    this.startupTimeoutMs = startupTimeoutMs
    this.child = null
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.queue = Promise.resolve()
    this.active = 0
    this.closed = false
  }

  start() {
    if (this.child) return this
    const args = [...this.command.slice(1)]
    if (this.instancePid) args.push('--instance', String(this.instancePid))
    this.child = spawn(this.command[0], args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.#onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', () => { })
    this.child.on('error', (error) => this.#failAll(new WorkerError('WORKER_SPAWN_FAILED', error.message)))
    this.child.on('exit', (code) => this.#failAll(new WorkerError('WORKER_EXITED',
      `worker 退出（code=${code ?? 'null'}）`)))
    return this
  }

  #onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const waiter = this.pending.get(message.id)
      if (!waiter) continue
      this.pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.ok) waiter.resolve(message)
      else waiter.reject(new WorkerError(message.error?.code ?? 'WORKER_ERROR',
        message.error?.message ?? 'worker 返回失败', message.error?.detail))
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

  /** 串行执行：同一个实例同一时刻只有一个请求，和 SOLIDWORKS 的 STA 一致。 */
  request(op, args = {}, { timeoutMs = 240_000 } = {}) {
    const run = () => new Promise((resolve, reject) => {
      if (this.closed || !this.child) {
        reject(new WorkerError('WORKER_CLOSED', 'worker 已关闭'))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new WorkerError('WORKER_TIMEOUT', `${op} 超过 ${timeoutMs}ms 没有响应`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`)
    })
    this.active += 1
    const result = this.queue.then(run, run)
    this.queue = result.then(() => undefined, () => undefined)
    const done = () => { this.active = Math.max(0, this.active - 1) }
    result.then(done, done)
    return result
  }

  stop() {
    this.closed = true
    this.#failAll(new WorkerError('WORKER_STOPPED', 'broker 正在停止 worker'))
    try { this.child?.kill() } catch { }
  }

  describe() {
    return {
      instancePid: this.instancePid || null,
      pid: this.child?.pid ?? null,
      pending: this.pending.size,
      active: this.active,
      queued: Math.max(0, this.active - this.pending.size),
      closed: this.closed,
    }
  }
}
