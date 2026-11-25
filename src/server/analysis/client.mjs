// 常驻 Python 分析 worker 的 Node 侧入口。
//
// worker 进程一次启动、多请求复用；调用方负责 close()。协议是 JSONL，
// 与 broker 共用 LineDecoder。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LineDecoder } from '../broker/protocol.mjs'

export const ANALYSIS_SCRIPT = fileURLToPath(new URL('./worker.py', import.meta.url))
export const ANALYSIS_VENV = fileURLToPath(new URL('../../.venv/Scripts/python.exe', import.meta.url))

export class AnalysisUnavailable extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'AnalysisUnavailable'
    this.code = 'ANALYSIS_UNAVAILABLE'
    this.detail = detail
  }
}

export function resolvePython({ python = process.env.SW_MCP_PYTHON } = {}) {
  if (python) return python
  return ANALYSIS_VENV
}

export async function openAnalysis({ python, script = ANALYSIS_SCRIPT, timeoutMs = 120_000 } = {}) {
  const executable = resolvePython({ python })
  if (!existsSync(executable)) {
    throw new AnalysisUnavailable('没有分析用 Python 环境（先建 .venv 并装 cadquery-ocp）', { executable })
  }
  if (!existsSync(script)) throw new AnalysisUnavailable('缺少分析 worker 脚本', { script })

  const child = spawn(executable, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  })
  const pending = new Map()
  let nextId = 1
  let stderr = ''
  let closed = false
  let failure = null

  const decoder = new LineDecoder({
    onMessage(message) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message)
      else {
        const error = new Error(message.error?.message ?? 'analysis failed')
        error.code = message.error?.code ?? 'ANALYSIS_FAILED'
        error.detail = message.error
        entry.reject(error)
      }
    },
    onError(error) { failure = error },
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => decoder.push(chunk))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000) })
  child.on('error', (error) => { failure = error; rejectAll(error) })
  child.on('exit', (code, signal) => {
    closed = true
    const reason = new Error(`分析 worker 退出（code ${code}, signal ${signal}）`)
    reason.code = 'ANALYSIS_EXITED'
    reason.detail = { stderr: stderr.trim().split(/\r?\n/).slice(-6) }
    if (!failure) failure = reason
    rejectAll(failure)
  })

  function rejectAll(error) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      pending.delete(id)
      entry.reject(error)
    }
  }

  function request(op, params = {}, { timeout } = {}) {
    if (closed) return Promise.reject(failure ?? new Error('analysis worker already closed'))
    const id = String(nextId++)
    const wait = timeout ?? timeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        const error = new Error(`分析请求超时（${op}, ${wait}ms）`)
        error.code = 'ANALYSIS_TIMEOUT'
        reject(error)
      }, wait)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`)
    })
  }

  async function health() {
    return request('health', {}, { timeout: Math.min(timeoutMs, 30_000) })
  }

  function close() {
    if (closed) return
    closed = true
    try { child.stdin.end() } catch { }
    try { child.kill() } catch { }
    rejectAll(new Error('analysis worker closed'))
  }

  return { request, health, close, get stderr() { return stderr } }
}

export function analysisStatus(health) {
  if (!health?.ocp) return { available: false, reason: 'OCP 未安装', ...health }
  return { available: true, ...health }
}

export function defaultStepPath(repoRoot) {
  return join(repoRoot, 'test', 'out', 'mcp-acceptance-a.step')
}
