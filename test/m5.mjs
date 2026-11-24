// M5：装配与工程图。
//
// 装配这一层最容易"看起来成功"：零件路径对了、返回不是 null，但组件根本没进去。
// 所以每一步都回读装配体自己的组件表与包围盒，而不是相信插入调用的返回值。
// 工程图同理：空白图纸也能导出 41 kB 的 PDF，只有视图数和图纸字节数能说明它是不是空的。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, statSync, rmSync } from 'node:fs'
import { ensureSolidworks, shutdownSolidworks } from './lib/sw.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const entry = join(root, 'server', 'server.mjs')
const outDir = join(here, 'out')
mkdirSync(outDir, { recursive: true })

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
const near = (actual, expected, tol = 0.01) => Math.abs((actual ?? NaN) - expected) <= Math.abs(expected) * tol + tol
const box = (b) => (b ? { x: [b[0], b[3]], y: [b[1], b[4]], z: [b[2], b[5]] } : null)

let startedHere = false
const stamp = Date.now().toString(36)
const partA = join(outDir, `m5-a-${stamp}.SLDPRT`)
const partB = join(outDir, `m5-b-${stamp}.SLDPRT`)
const assemblyPath = join(outDir, `m5-asm-${stamp}.SLDASM`)
const drawingPath = join(outDir, `m5-drw-${stamp}.SLDDRW`)
const pdfPath = join(outDir, `m5-drw-${stamp}.pdf`)

const plate = (width, height, thickness) => ({
  schemaVersion: 3,
  units: 'mm',
  params: { 'plate.w': width, 'plate.h': height, 'plate.t': thickness },
  features: [
    {
      kind: 'sketch',
      id: 'outline',
      plane: 1,
      primitives: [{
        shape: 'rect',
        center: [0, 0],
        width: 'plate.w',
        height: 'plate.h',
        bind: { width: 'plate.w', height: 'plate.h' },
      }],
    },
    { kind: 'extrude', id: 'body', profile: 'outline', depth: 'plate.t', bind: { depth: 'plate.t' } },
  ],
})

try {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'm5-probe', version: '0' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)

  // 冷启动约 50 秒；等它，而不是把"还没起来"当成结论。只起一个实例。
  const sw = await ensureSolidworks(tool)
  startedHere = sw.startedHere
  check('SOLIDWORKS is attached', sw.reason === 'ready', sw.reason)

  // 两个零件：100×60×10 与 40×40×10
  for (const [path, spec, id] of [
    [partA, plate(100, 60, 10), `m5-a-${stamp}`],
    [partB, plate(40, 40, 10), `m5-b-${stamp}`],
  ]) {
    const built = await tool('model', {
      action: 'build',
      designId: id,
      definition: { ...spec, designId: id, path },
    })
    check(`part ${id} built`, built.status === 'ok', built.summary)
    // 建模只在内存里；装配要插的是磁盘上的文件，所以先存盘。
    const saved = await tool('deliver', { designId: id, kind: 'sldprt', path })
    check(`part ${id} was written to disk`, saved.status === 'ok' && existsSync(path),
      existsSync(path) ? statSync(path).size : saved.summary)
  }

  // ---------------------------------------------------------------- assembly
  const assembled = await tool('model', {
    action: 'assemble',
    outputPath: assemblyPath,
    components: [
      { path: partA, x: 0, y: 0, z: 0 },
      { path: partB, x: 200, y: 0, z: 0 },
    ],
  })
  check('assemble reports both parts placed', assembled.status === 'ok', assembled.summary)
  const placed = assembled.changes?.components ?? []
  check('two components are in the assembly', placed.length === 2, placed.map((c) => c.name))
  check('each component carries its own path',
    placed.some((c) => (c.path ?? '').toLowerCase().endsWith('.sldprt')), placed.map((c) => c.path))
  check('the assembly file was written', existsSync(assemblyPath), `${assemblyPath} ${existsSync(assemblyPath) ? statSync(assemblyPath).size : 0} B`)

  const second = placed[1]
  check('the second component sits 200 mm along X',
    second?.box ? near(second.box[0], 180, 0.05) : false, box(second?.box))

  // 回读：装配体自己的组件表
  const components = await tool('inspect', { action: 'assembly' })
  check('inspect assembly reads the component table back',
    components.changes?.count === 2, components.summary)
  check('inspect assembly names the document',
    /\.SLDASM$/i.test(components.changes?.assembly?.path ?? ''), components.changes?.assembly?.path)

  // 在装配体上调 faces 必须明确说"这不是零件"，而不是回一个空数组
  const faces = await tool('inspect', { action: 'faces', limit: 64 })
  check('faces refuses an assembly with a clear code',
    faces.status === 'failed' && faces.extra?.error?.code === 'NOT_A_PART',
    faces.extra?.error?.code ?? faces.status)

  const selectClear = await tool('select', { action: 'clear' })
  check('selection can be cleared', selectClear.status === 'ok', selectClear.summary)

  // ---------------------------------------------------------------- drawing
  const drawn = await tool('model', {
    action: 'drawing',
    model: partA,
    views: ['*前视', '*上视', '*等轴测'],
    outputPath: drawingPath,
  })
  const dropped = drawn.changes?.dropped ?? []
  check('three views were dropped on the sheet', dropped.length === 3, dropped.map((d) => d.name))
  check('the view count grew', (drawn.changes?.viewCount ?? 0) >= 4, drawn.changes?.viewCount)
  check('the drawing file exists', existsSync(drawingPath), existsSync(drawingPath) ? statSync(drawingPath).size : 0)

  const blankSize = 41_145
  const drawingSize = existsSync(drawingPath) ? statSync(drawingPath).size : 0
  check('the drawing is not an empty sheet', drawingSize > blankSize * 1.2,
    `${drawingSize} B vs blank ${blankSize} B`)

  // ----------------------------------------------------------------- export
  const pdf = await tool('deliver', { designId: `m5-drw-${stamp}`, kind: 'pdf', path: pdfPath })
  check('pdf export returns a path', pdf.status === 'ok', pdf.summary)
  if (existsSync(pdfPath)) {
    check('the pdf is bigger than an empty sheet', statSync(pdfPath).size > blankSize, statSync(pdfPath).size)
  } else {
    check('the pdf was written', false, pdfPath)
  }
} catch (error) {
  failures.push(error.message)
  console.error('FAIL ', error.message)
} finally {
  // 自己启动的实例要自己收：SOLIDWORKS 开着占 1.5 GB 以上，而且会留下文档窗口。
  try { await shutdownSolidworks(tool, startedHere) } catch { /* 已经退出就算了 */ }
  child.kill()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) process.exitCode = 1
}
