// 端到端：只通过 MCP 工具（不是桥接器）把基准件 A 建出来、验、改、存档。
//
// acceptance.mjs 走的是桥接器，验的是建模内核；这里走的是模型真正会用的那条路：
// tools/call → server.mjs → SwBridge.exe。两段都绿，才说明装进 DSH 的那套能用。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(resolve(here, '..'), 'server', 'server.mjs')

const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] })
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

const rpc = (method, params) =>
  new Promise((resolvePromise, rejectPromise) => {
    const id = nextId++
    waiters.set(id, resolvePromise)
    setTimeout(() => rejectPromise(new Error(`${method} 超时`)), 240_000)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

/** 调一个工具，把 JSON 文本块解回来。 */
async function tool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args })
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}'
  return JSON.parse(text)
}

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`FAIL  ${name}`)
  }
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

// 基准件 A：100×60×20 + Ø30×10 凸台 + Ø10 中心贯穿 + 底板四竖边 R3
const analyticA = 100 * 60 * 20 + Math.PI * 15 ** 2 * 10 - Math.PI * 5 ** 2 * 30 - 4 * (3 ** 2 - (Math.PI * 3 ** 2) / 4) * 20

const design = {
  schemaVersion: 3,
  designId: 'mcp-acceptance-a',
  units: 'mm',
  params: {
    'plate.w': 100,
    'plate.h': 60,
    'plate.t': 20,
    'boss.d': 30,
    'boss.h': 10,
    'hole.d': 10,
    'fillet.r': 3,
  },
  features: [
    { kind: 'basePlate', id: 'plate', plane: 0, width: 'plate.w', height: 'plate.h', thickness: 'plate.t' },
    { kind: 'boss', id: 'centerBoss', face: 'top', diameter: 'boss.d', height: 'boss.h' },
    {
      kind: 'holes',
      id: 'centerHole',
      face: 'top',
      diameter: 'hole.d',
      throughAll: true,
      centres: [{ x: 0, y: 0 }],
    },
    { kind: 'fillet', id: 'bottomFillet', radius: 'fillet.r', onBottom: true },
  ],
}

try {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'acceptance-mcp', version: '0' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)

  const status = await tool('workspace', { action: 'status' })
  check('SOLIDWORKS reachable through MCP', status.status === 'ok', status.summary)
  check(
    'capability registry reports what works',
    status.capabilities?.items?.some((i) => i.name === 'linearPattern' && !i.available),
    status.capabilities?.items?.find((i) => i.name === 'linearPattern')?.status,
  )

  // 清掉可能残留的同名文档，让构建从一个干净状态开始
  await tool('workspace', { action: 'cleanup' })

  const built = await tool('model', { action: 'build', definition: design })
  const volume = built.measurements?.volume
  check('model build returns the reference A volume', Math.abs(volume - analyticA) < 0.05, {
    measured: volume,
    analytic: Number(analyticA.toFixed(4)),
  })
  check('model build returns the bounding box', JSON.stringify(built.measurements?.boundingBox) === '[100,60,30]', built.measurements?.boundingBox)
  const drivers = built.changes?.drivers ?? {}
  check('every parameter is accounted for (equation or baked at build)',
    drivers.mode === 'literal' ? (drivers.requested ?? 0) >= 6 : Object.keys(built.changes?.bindings ?? {}).length >= 6,
    { bindings: built.changes?.bindings, drivers })

  const checked = await tool('inspect', { action: 'verify',
    expect: { volume: analyticA, size: [100, 60, 30], parametric: true },
  })
  check('inspect verify passes on the freshly built part', checked.status === 'ok', { summary: checked.summary, checks: checked.changes?.checks })

  // 改一个参数，靠 SOLIDWORKS 自己的方程式传播
  const edited = await tool('model', { action: 'edit', parameters: { 'plate.w': 80 } })
  const expectW80 = 80 * 60 * 20 + Math.PI * 15 ** 2 * 10 - Math.PI * 5 ** 2 * 30 - 4 * (3 ** 2 - (Math.PI * 3 ** 2) / 4) * 20
  check('model edit propagates through SOLIDWORKS', Math.abs(edited.measurements?.volume - expectW80) < 0.05, {
    measured: edited.measurements?.volume,
    analytic: Number(expectW80.toFixed(4)),
  })

  const inspected = await tool('inspect', { action: 'model', format: 'both' })
  const sketches = inspected.changes?.sketches ?? []
  check('inspect model reports sketch constraint state', sketches.length >= 3 && sketches.every((s) => s.fullyConstrained), sketches.map((s) => `${s.feature}=${s.constraintStatus}`))

  const artifact = join(here, 'out', 'mcp-acceptance-a.step')
  const exported = await tool('deliver', { kind: 'step', path: artifact })
  check('deliver reports bytes on disk', exported.artifacts?.[0]?.bytes > 0, exported.artifacts?.[0])

  // 只读地验经验工具：写一条测试经验会混进每个新会话的 workspace 提示里。
  const found = await tool('workspace', { action: 'lesson', lesson: { action: 'search', query: 'acceptance', limit: 1 } })
  check('lesson answers a search', typeof found.summary === 'string' && Array.isArray(found.changes?.lessons), found.summary)

  console.log(`\n${passed}/${passed + failures.length} checks passed`)
  if (failures.length > 0) {
    console.log('failures:')
    for (const name of failures) console.log(`  - ${name}`)
    process.exitCode = 1
  }
} catch (error) {
  console.error('\nFAIL ', error.message)
  process.exitCode = 1
} finally {
  child.kill()
}
