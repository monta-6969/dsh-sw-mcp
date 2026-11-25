// 端到端：通用轮廓 —— 任意草图 → 拉伸 / 切除 / 旋转。
//
// M1 的编译器只会做四种它认识的形状（板、凸台、孔组、圆角），那是零件目录不是建模工具。
// 这里验的是「给一个轮廓，把它建出来」，以及轮廓参数是否真的落在原生尺寸上：
// 每条用例都有闭式解析体积，差一点点都算失败。
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

async function tool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args })
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
const near = (actual, expected, tol = 0.05) => Math.abs((actual ?? NaN) - expected) <= tol

// 正六边形：边长 = 外接圆半径 20，厚 10 → (3√3/2)·r²·t
const hexAnalytic = (3 * Math.sqrt(3) / 2) * 400 * 10
const hexagon = {
  schemaVersion: 3,
  designId: 'm3-hexagon',
  units: 'mm',
  params: { 'hex.r': 20, 'hex.t': 10 },
  features: [
    {
      kind: 'sketch',
      id: 'hex',
      plane: 0,
      primitives: [{ shape: 'polygon', sides: 6, diameter: '2*hex.r', center: [0, 0] }],
    },
    { kind: 'extrude', id: 'body', profile: 'hex', depth: 'hex.t', symmetric: true, bind: { depth: 'hex.t' } },
  ],
}

// 100×60×20 板，中心 Ø10 贯穿 → 用通用轮廓 + 通用切除复现 M1 的钻孔结果
const plateAnalytic = 100 * 60 * 20 - Math.PI * 5 ** 2 * 20
const plate80 = 80 * 60 * 20 - Math.PI * 5 ** 2 * 20
const plate = {
  schemaVersion: 3,
  designId: 'm3-plate',
  units: 'mm',
  params: { 'plate.w': 100, 'plate.h': 60, 'plate.t': 20, 'hole.d': 10 },
  features: [
    {
      kind: 'sketch',
      id: 'outline',
      plane: 0,
      primitives: [
        {
          shape: 'rect',
          center: [0, 0],
          width: 'plate.w',
          height: 'plate.h',
          bind: { width: 'plate.w', height: 'plate.h' },
        },
      ],
    },
    { kind: 'extrude', id: 'body', profile: 'outline', depth: 'plate.t', symmetric: true, bind: { depth: 'plate.t' } },
    {
      kind: 'sketch',
      id: 'bore',
      face: 'top',
      primitives: [{ shape: 'circle', center: [0, 0], diameter: 'hole.d', bind: { diameter: 'hole.d' } }],
    },
    { kind: 'cut', id: 'through', profile: 'bore', throughAll: true },
  ],
}

// 半剖矩形绕 Y 轴转 360° → Ø20×60 实心轴
const shaftAnalytic = Math.PI * 10 ** 2 * 60
const shaft = {
  schemaVersion: 3,
  designId: 'm3-shaft',
  units: 'mm',
  params: { 'shaft.d': 20, 'shaft.h': 60 },
  features: [
    {
      kind: 'sketch',
      id: 'half',
      plane: 0,
      axis: 'y',
      primitives: [
        {
          shape: 'polyline',
          closed: true,
          points: [
            [0, '-shaft.h/2'],
            ['shaft.d/2', '-shaft.h/2'],
            ['shaft.d/2', 'shaft.h/2'],
            [0, 'shaft.h/2'],
          ],
        },
      ],
    },
    { kind: 'revolve', id: 'shaft', profile: 'half', angle: 360 },
  ],
}

try {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'm3-probe', version: '0' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)

  // ---- 任意折线轮廓 + 拉伸
  const hex = await tool('model', { action: 'build', definition: hexagon })
  check('a polygon profile extrudes', hex.status === 'ok', hex.summary)
  check('hexagon volume is analytic', near(hex.measurements?.volume, hexAnalytic), {
    measured: hex.measurements?.volume,
    analytic: Number(hexAnalytic.toFixed(4)),
  })
  const hexBox = hex.measurements?.boundingBox ?? []
  check('hexagon bounding box is right',
    hexBox.length === 3 && Math.abs(hexBox[0] - 40) < 0.01 && Math.abs(hexBox[1] - 34.641) < 0.01 && Math.abs(hexBox[2] - 10) < 0.01,
    hexBox)
  const hexSketch = hex.changes?.features?.find((f) => f.kind === 'sketch')
  check('a baked polyline is reported as not parametric', hexSketch?.parametric === false, hexSketch?.parametric)

  // ---- 轮廓 + 切除
  const cut = await tool('model', { action: 'build', definition: plate })
  check('rect profile + through cut builds', cut.status === 'ok', cut.summary)
  check('plate with a cut hole is analytic', near(cut.measurements?.volume, plateAnalytic), {
    measured: cut.measurements?.volume,
    analytic: Number(plateAnalytic.toFixed(4)),
  })
  const rectSketch = cut.changes?.features?.find((f) => f.id === 'outline')
  check('a rect with bind names is parametric', rectSketch?.parametric === true, rectSketch?.parametric)
  const cutFeature = cut.changes?.features?.find((f) => f.kind === 'cut')
  check('the cut reports itself parametric', cutFeature?.parametric === true, cutFeature?.parametric)

  // ---- 参数经通用轮廓传播
  const edited = await tool('model', { action: 'edit', parameters: { 'plate.w': 80 } })
  check('editing a profile parameter propagates', near(edited.measurements?.volume, plate80), {
    measured: edited.measurements?.volume,
    analytic: Number(plate80.toFixed(4)),
  })

  // ---- 旋转
  const rev = await tool('model', { action: 'build', definition: shaft })
  check('a revolved profile builds', rev.status === 'ok', rev.summary)
  check('revolution volume is analytic', near(rev.measurements?.volume, shaftAnalytic), {
    measured: rev.measurements?.volume,
    analytic: Number(shaftAnalytic.toFixed(4)),
  })

  // ---- 内联轮廓（不单独声明 sketch）
  const inline = await tool('model', {
    action: 'build',
    definition: {
      schemaVersion: 3,
      designId: 'm3-inline',
      units: 'mm',
      params: { 'r': 12, 't': 5 },
      features: [
        {
          kind: 'extrude',
          id: 'disc',
          profile: { plane: 0, primitives: [{ shape: 'circle', center: [0, 0], diameter: '2*r' }] },
          depth: 't',
          bind: { depth: 't' },
        },
      ],
    },
  })
  check('an inline profile extrudes', inline.status === 'ok', inline.summary)
  check('inline disc volume is analytic', near(inline.measurements?.volume, Math.PI * 144 * 5), {
    measured: inline.measurements?.volume,
    analytic: Number((Math.PI * 144 * 5).toFixed(4)),
  })

  // ---- 失败要有可读的原因
  const missing = await tool('model', {
    action: 'build',
    definition: {
      schemaVersion: 3,
      designId: 'm3-missing',
      params: {},
      features: [{ kind: 'extrude', id: 'x', profile: 'nope', depth: 5 }],
    },
  })
  check('an unknown sketch id fails with a code', missing.status === 'failed' && missing.extra?.error?.code === 'SKETCH_NOT_FOUND',
    missing.extra?.error?.code)
  check('the failure names the missing sketch', /nope/.test(missing.extra?.error?.message ?? ''), missing.extra?.error?.message)
} catch (error) {
  failures.push(error.message)
  console.error('FAIL ', error.message)
} finally {
  child.kill()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) process.exitCode = 1
}
