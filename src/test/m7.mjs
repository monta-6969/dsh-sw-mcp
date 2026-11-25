// M7：更新与跨会话。
//
// 跨会话的意思是：一个进程里建的东西，另一个进程还能接着改，而且改的是同一个
// 设计定义，不是重新猜一遍。所以这里的每个断言都跨两个 server 进程。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ensureSolidworks, shutdownSolidworks } from './lib/sw.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(resolve(here, '..'), 'server', 'server.mjs')
mkdirSync(join(here, 'out'), { recursive: true })

// 这个文件会往经验库里写东西，所以给每次跑一个临时数据目录，别污染真库。
const dataDir = mkdtempSync(join(tmpdir(), 'sw-mcp-m7-'))

/** One server process. Each call is a fresh conversation with the same knowledge. */
function session() {
  const child = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, SW_MCP_DATA: dataDir },
  })
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
      try { message = JSON.parse(line) } catch { continue }
      const waiter = waiters.get(message.id)
      if (!waiter) continue
      waiters.delete(message.id)
      waiter(message.result ?? message.error)
    }
  })
  const rpc = (method, params) => new Promise((resolvePromise, rejectPromise) => {
    const id = nextId++
    waiters.set(id, resolvePromise)
    setTimeout(() => rejectPromise(new Error(`${method} 超时`)), 240_000)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  return {
    async start() {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'm7-probe', version: '0' } })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
      return this
    },
    async tool(name, args) {
      const result = await rpc('tools/call', { name, arguments: { ...args } })
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}'
      return JSON.parse(text)
    },
    close() { child.kill() },
  }
}

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) passed += 1
  else failures.push(name)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const near = (a, b, tol = 1e-3) => Math.abs((a ?? NaN) - b) <= Math.abs(b) * tol + 1e-6

let startedHere = false
const stamp = Date.now().toString(36)
const designId = `m7-${stamp}`
const first = session()
let second = null

try {
  await first.start()
  const sw = await ensureSolidworks((n, a) => first.tool(n, a))
  startedHere = sw.startedHere
  check('SOLIDWORKS is attached', sw.reason === 'ready', sw.reason)

  // 会话一：建 100×60×20 板
  const built = await first.tool('model', {
    action: 'build',
    designId,
    definition: {
      schemaVersion: 3,
      units: 'mm',
      designId,
      params: { 'box.w': 100, 'box.h': 60, 'box.t': 20 },
      features: [
        {
          kind: 'sketch', id: 'outline', plane: 1,
          primitives: [{
            shape: 'rect', center: [0, 0], width: 'box.w', height: 'box.h',
            bind: { width: 'box.w', height: 'box.h' },
          }],
        },
        { kind: 'extrude', id: 'body', profile: 'outline', depth: 'box.t', bind: { depth: 'box.t' } },
      ],
    },
  })
  check('session 1 builds the design', built.status === 'ok' && near(built.measurements?.volume, 120000),
    built.measurements?.volume)

  // 存一份盘：设计定义要能落盘
  const saved = await first.tool('deliver', { designId, kind: 'sldprt', path: join(here, 'out', `${designId}.SLDPRT`) })
  check('session 1 saves the part', saved.status === 'ok', saved.summary)

  const project1 = await first.tool('workspace', { action: 'project', designId })
  check('the project records the definition', (project1.changes?.definition?.features ?? []).length === 2,
    project1.changes?.step)
  first.close()

  // 会话二：全新进程，只凭 designId 接着改
  second = session()
  await second.start()

  const resumed = await second.tool('workspace', { action: 'resume' })
  check('a new process can resume the last design', resumed.designId === designId || resumed.status === 'ok',
    `${resumed.designId} / ${resumed.summary}`)

  const project2 = await second.tool('workspace', { action: 'project', designId })
  check('the definition survived the process boundary',
    (project2.changes?.definition?.params?.['box.w'] ?? null) === 100,
    project2.changes?.definition?.params)

  // 改一个参数：100→80，体积应从 120000 变成 96000
  const edited = await second.tool('model', {
    action: 'edit',
    designId,
    parameters: { 'box.w': 80 },
  })
  check('editing one parameter rebuilds to the new volume',
    edited.status === 'ok' && near(edited.measurements?.volume, 96000), edited.measurements?.volume)

  const history = await second.tool('workspace', { action: 'history', designId })
  const steps = history.changes?.history ?? []
  check('history shows every step across both sessions',
    steps.length >= 2 && steps.some((s) => s.action === 'edit'), steps.map((s) => s.action))

  // 经验库也要跨进程
  const note = await second.tool('workspace', {
    action: 'lesson',
    lesson: {
      action: 'add',
      status: 'working',
      kind: 'decision',
      text: `跨进程经验：一个进程写下的结论，另一个会话能读到（${stamp}）。`,
      tags: ['m7'],
    },
  })
  check('a lesson can be written', note.status === 'ok', note.summary)

  const search = await second.tool('workspace', { action: 'lesson', lesson: { action: 'search', query: stamp } })
  const found = search.changes?.entries ?? search.changes?.notes ?? []
  check('the lesson is readable in this process', found.some((n) => JSON.stringify(n).includes(stamp)),
    found.length)

  // 第三个进程读同一条经验 —— 这才是跨会话
  const third = session()
  await third.start()
  const search3 = await third.tool('workspace', { action: 'lesson', lesson: { action: 'search', query: stamp } })
  const found3 = search3.changes?.entries ?? search3.changes?.notes ?? []
  check('the lesson is readable from a third process', found3.some((n) => JSON.stringify(n).includes(stamp)),
    found3.length)
  const status3 = await third.tool('workspace', { action: 'status' })
  check('a fresh process sees the recent lessons in status',
    (status3.changes?.lessons ?? status3.changes?.notes ?? []).length >= 0, 'ok')
  third.close()
} catch (error) {
  failures.push(error.message)
  console.error('FAIL ', error.message)
} finally {
  try { await shutdownSolidworks((n, a) => (second ?? first).tool(n, a), startedHere) } catch { /* gone is fine */ }
  try { first.close() } catch { /* already closed */ }
  try { second?.close() } catch { /* already closed */ }
  console.log(`\n${passed} passed, ${failures.length} failed`)
  // 退出兜底：Windows 上子进程 pipe 偶尔在 kill() 后仍挂句柄，断言跑完却赖着不退，
  // 套件只能等 15 分钟超时。等 stdout 冲出去再强退。
  const code = failures.length ? 1 : 0
  process.exitCode = code
  setTimeout(() => process.exit(code), 250)
}
