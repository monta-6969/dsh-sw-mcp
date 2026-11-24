// 验证 server.mjs 从任意 cwd 启动都能工作 —— DSH 拉起它时 cwd 是工作区，不是包目录。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(resolve(here, '..'), 'server', 'server.mjs')

const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'], cwd: process.env.SystemRoot ?? 'C:\\' })
let buffer = ''
let nextId = 1
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
    waiter(message.result ?? message.error)
  }
})

const send = (method, params) =>
  new Promise((resolvePromise) => {
    const id = nextId++
    waiters.set(id, resolvePromise)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

try {
  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'cwd', version: '0' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)

  const tools = await send('tools/list', {})
  console.log('cwd          :', process.env.SystemRoot ?? 'C:\\')
  console.log('tools        :', tools.tools?.map((t) => t.name).join(', '))

  const status = await send('tools/call', { name: 'workspace', arguments: { action: 'status' } })
  const payload = JSON.parse(status.content?.[0]?.text ?? '{}')
  console.log('status       :', payload.status, '|', payload.summary)
  console.log('skills       :', payload.capabilities?.skills?.items?.map((s) => `${s.name}=${s.present}`).join(', '))
  console.log('bridge       :', payload.capabilities?.solidworks?.ready ? 'attached' : 'not attached')
} finally {
  child.kill()
}
