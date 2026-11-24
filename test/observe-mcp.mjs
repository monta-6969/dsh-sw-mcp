// 端到端：只通过 MCP 工具走完「看面 → 选面 → 出图」这一圈。
//
// observe.mjs 验的是桥接器的 faces/select/capture；这里验的是模型真正拿到的东西：
// 工具名、参数名、返回形状，以及 capture 是不是真的回了一个 image content block。
// 这一圈最容易被"看起来成功"骗过 —— 图出了但 highlight 没生效，或者 id 换了面。
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
    // 计时器必须在响应到达时清掉：不清的话每个调用都会把进程多留 4 分钟，
    // 套件在「用例已经打印完结果」之后一直等不到 exit（实测卡住整轮）。
    const timer = setTimeout(() => rejectPromise(new Error(`${method} 超时`)), 240_000)
    waiters.set(id, (value) => { clearTimeout(timer); resolvePromise(value) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

/** 调一个工具，回原始 content（capture 的图就在里面）。 */
async function call(name, args) {
  return rpc('tools/call', { name, arguments: args })
}
async function tool(name, args) {
  const result = await call(name, args)
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}'
  return JSON.parse(text)
}

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) passed += 1
  else failures.push(name)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

// 60×40×10 的板，四角 4×Ø6 —— 体积有闭式解，面数也稳定。
const design = {
  schemaVersion: 3,
  designId: 'mcp-observe',
  units: 'mm',
  params: {
    'plate.w': 60,
    'plate.h': 40,
    'plate.t': 10,
    'hole.d': 6,
    'hole.edge': 8,
  },
  features: [
    { kind: 'basePlate', id: 'plate', plane: 0, width: 'plate.w', height: 'plate.h', thickness: 'plate.t' },
    {
      kind: 'holes',
      id: 'corners',
      face: 'top',
      diameter: 'hole.d',
      throughAll: true,
      centres: [
        { x: 22, y: 12 },
        { x: -22, y: 12 },
        { x: -22, y: -12 },
        { x: 22, y: -12 },
      ],
    },
  ],
}
const analytic = 60 * 40 * 10 - 4 * Math.PI * 3 ** 2 * 10

try {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'observe-probe', version: '0' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)

  const built = await tool('model', { action: 'build', definition: design })
  check('model build succeeds', built.status === 'ok', built.summary)
  check(
    'the plate volume is analytic',
    Math.abs((built.measurements?.volume ?? 0) - analytic) < 0.05,
    { measured: built.measurements?.volume, analytic: Number(analytic.toFixed(4)) },
  )

  const faces = await tool('inspect', { action: 'faces', limit: 50 })
  const list = faces.changes?.faces ?? []
  check('inspect faces lists the solid faces', list.length >= 7, `${list.length} faces`)
  check('every face carries a persistent id', list.every((f) => typeof f.id === 'string' && f.id.length > 100), {
    sample: list[0]?.id?.slice(0, 24),
  })

  const top = list
    .filter((f) => f.kind === 'plane' && Math.abs(f.normal?.[2] - 1) < 1e-6)
    .sort((a, b) => b.area - a.area)[0]
  check('a plane facing +Z larger than the holes is found', Boolean(top && top.area > 1000), top && { area: top.area, normal: top.normal })

  const picked = await tool('select', { mode: 'byId', persistentId: top?.id })
  check('select byId takes exactly one face', picked.changes?.selection?.count === 1, picked.summary)
  check('select byId gives back the same id', picked.changes?.selection?.items?.[0]?.id === top?.id, {
    same: picked.changes?.selection?.items?.[0]?.id === top?.id,
  })

  const shot = await call('capture', { highlight: [top.id], caption: 'M2 observe-mcp: 高亮的那张面是我选中的' })
  const image = shot.content?.find((c) => c.type === 'image')
  check('capture returns an image content block', Boolean(image), image?.mimeType)
  check('the image is PNG', image?.mimeType === 'image/png', image?.mimeType)
  // mimeType is our own claim; the bytes have to agree with it.
  check('the bytes really are PNG', image?.data?.startsWith('iVBORw0KGgo') === true, image?.data?.slice(0, 12))
  check('the image has pixels', (image?.data?.length ?? 0) > 10_000, `${Math.round((image?.data?.length ?? 0) / 1024)} KB base64`)

  const stale = await tool('select', { mode: 'byId', persistentId: 'deadbeef' })
  check('a bogus id fails cleanly', stale.status === 'failed', stale.extra?.error?.code)

  const cleared = await tool('select', { action: 'clear' })
  check('select clear empties the selection', cleared.status === 'ok', cleared.summary)

  const verified = await tool('inspect', {
    action: 'verify',
    expect: { volume: analytic, size: [60, 40, 10], holes: 4, holeDiameter: 6 },
  })
  check('inspect verify passes on the same part', verified.status === 'ok', verified.summary)
} catch (error) {
  failures.push(error.message)
  console.error('FAIL ', error.message)
} finally {
  child.kill()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  // 显式退出：即使某个管道句柄还没关，也不该让套件等 15 分钟。
  // 留 100ms 让上面这行输出写完，避免汇总被截断。
  const code = failures.length ? 1 : 0
  setTimeout(() => process.exit(code), 100)
}
