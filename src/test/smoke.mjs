// 走真实 stdio 跑一次 server.mjs，确认工具表能注册、每次调用返回统一形状。
//
// 为什么手写 JSON-RPC 而不是用官方 Client：server 包不导出 Client（它在
// @modelcontextprotocol/client 里，本工程没装），而这里要验的本来就是
// 「真实 stdio 上工具结果长什么样」。四个方法足够：initialize、
// notifications/initialized、tools/list、tools/call。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const checks = []
function record(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`)
}

const EXPECTED_TOOLS = [
  'workspace',
  'catalog',
  'model',
  'inspect',
  'select',
  'capture',
  'deliver',
  'calculate',
  'analysis',
  'job',
  'task',
]
const ENVELOPE_KEYS = ['summary', 'designId', 'status']

const child = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
})

let buffer = ''
const waiters = new Map()
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
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  }
})

let nextId = 1
function send(method, params) {
  const id = nextId++
  return new Promise((resolvePromise, rejectPromise) => {
    waiters.set(id, { resolve: resolvePromise, reject: rejectPromise })
    const timer = setTimeout(() => {
      waiters.delete(id)
      rejectPromise(new Error(`${method} timed out`))
    }, 120_000)
    const clear = () => clearTimeout(timer)
    const original = waiters.get(id)
    waiters.set(id, { resolve: (v) => { clear(); original.resolve(v) }, reject: (e) => { clear(); original.reject(e) } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

async function callTool(name, args) {
  const result = await send('tools/call', { name, arguments: args })
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}'
  return JSON.parse(text)
}

try {
  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'sw-smoke', version: '0.0.0' },
  })
  notify('notifications/initialized', {})

  const { tools = [] } = await send('tools/list', {})
  record('every expected tool is registered exactly once', tools.length === EXPECTED_TOOLS.length, tools.map((t) => t.name).join(', '))
  const missing = EXPECTED_TOOLS.filter((name) => !tools.some((t) => t.name === name))
  record('every expected tool is present', missing.length === 0, missing.length ? `missing: ${missing}` : '')
  const thin = tools.filter((t) => !t.description || t.description.length < 80)
  record('every tool has a real model-facing description', thin.length === 0, thin.map((t) => t.name).join(', '))
  const noSchema = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== 'object')
  record('every tool declares an object input schema', noSchema.length === 0, noSchema.map((t) => t.name).join(', '))

  console.log('\n--- shapes ---')
  const status = await callTool('workspace', { action: 'status' })
  record('workspace returns the shared envelope', ENVELOPE_KEYS.every((k) => k in status), Object.keys(status).join(', '))
  record(
    'workspace reports capabilities with versions',
    Array.isArray(status.capabilities?.items) && status.capabilities.items.length > 0,
    `${status.capabilities?.items?.length} capabilities, versions ${JSON.stringify(status.capabilities?.version)}`,
  )
  record('workspace says whether SOLIDWORKS is reachable', typeof status.status === 'string',
    `status=${status.status} | ${status.summary}`)
  const unavailable = status.capabilities?.items?.filter((c) => !c.available) ?? []
  record('unavailable capabilities carry a reason', unavailable.every((c) => c.note && c.status),
    unavailable.map((c) => `${c.name}=${c.status}`).join(', '))

  const lesson = await callTool('workspace', { action: 'lesson', lesson: { action: 'search', query: 'orientation' } })
  record('lesson search returns the shared envelope', ENVELOPE_KEYS.every((k) => k in lesson), lesson.summary)

  const bad = await callTool('model', { action: 'edit', designId: 'no-such-design', parameters: {} })
  record(
    'a failing call returns the envelope instead of throwing',
    ENVELOPE_KEYS.every((k) => k in bad) && bad.status === 'failed',
    `${bad.summary} code=${bad.extra?.error?.code}`,
  )
  record('a failing call names a next action', Array.isArray(bad.nextActions), String(bad.nextActions))

  const noArgs = await callTool('workspace', { action: 'lesson', lesson: { action: 'add' } })
  record('missing arguments produce an actionable code',
    noArgs.status === 'failed' && /BAD_ARGUMENT/.test(JSON.stringify(noArgs.extra ?? {})), noArgs.summary)
} finally {
  child.kill()
}

const failures = checks.filter((c) => !c.pass)
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`)
if (failures.length > 0) process.exitCode = 1
