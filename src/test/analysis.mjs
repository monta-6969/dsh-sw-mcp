// 常驻 Python 分析 worker：STEP 摘要/消隐/剖面/面清点 + 图像统计。
//
// 没有 .venv 或 OCP 时跳过（打包不含 .venv），不阻塞无 SW 的基础套件。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openAnalysis, analysisStatus } from '../server/analysis/client.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..')
const stepPath = join(here, 'out', 'mcp-acceptance-a.step')
const imagePath = join(here, 'out', 'm2-observe.png')

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

if (!existsSync(join(repoRoot, '.venv', 'Scripts', 'python.exe'))) {
  console.log('SKIP  analysis: no .venv (run: python -m venv .venv && .venv/Scripts/pip install cadquery-ocp)')
  process.exit(0)
}
if (!existsSync(stepPath)) {
  console.log(`SKIP  analysis: missing ${stepPath}（先跑一次需要 SW 的用例）`)
  process.exit(0)
}

const worker = await openAnalysis()
try {
  const health = await worker.health()
  check('worker 健康检查', health.ok === true && health.python, health)
  if (!health.ocp) {
    console.log('SKIP  analysis: OCP not installed in .venv')
    process.exit(0)
  }
  check('OCP 已安装', analysisStatus(health).available === true)

  const info = await worker.request('step.info', { path: stepPath })
  check('STEP 摘要包含体积与包围盒', info.volumeMm3 > 1 && info.sizeMm.length === 3, info)
  check('STEP 至少有一个面和一条边', info.faces > 0 && info.edges > 0, { faces: info.faces, edges: info.edges })

  const faces = await worker.request('step.faces', { path: stepPath, maxFaces: 200 })
  check('面清点返回条目', Array.isArray(faces.faces) && faces.faces.length > 0, { faces: faces.faces.length })
  check('面类型可读', faces.faces.every((face) => typeof face.surfaceType === 'string'), faces.faces.slice(0, 3))

  const hlr = await worker.request('step.hlr', { path: stepPath, viewDir: [0, 0, 1], hidden: true })
  check('消隐返回可见边', hlr.visibleEdges > 0 && hlr.visible.length > 0, { visibleEdges: hlr.visibleEdges, hiddenEdges: hlr.hiddenEdges })

  const section = await worker.request('step.section', { path: stepPath, origin: [0, 0, info.bbox.min[2] + info.sizeMm[2] / 2], normal: [0, 0, 1] })
  check('剖面有环与长度', section.loops.length > 0 && section.totalLength > 0, { loops: section.loops.length, totalLength: section.totalLength })

  const same = await worker.request('step.diff', { a: stepPath, b: stepPath })
  check('同一份 STEP 无差异', same.equal === true && same.items.length === 0, { equal: same.equal, items: same.items.length })

  const otherPath = join(here, 'out', 'acceptance-b.step')
  if (existsSync(otherPath)) {
    const diff = await worker.request('step.diff', { a: stepPath, b: otherPath })
    const fields = diff.items.every((item) => typeof item.region === 'string'
      && typeof item.expected === 'number' && typeof item.measured === 'number'
      && typeof item.nextObservation === 'string' && item.entityRef.startsWith('brep:'))
    check('两份不同 STEP 给出可复核差异项', diff.equal === false && diff.items.length > 0 && fields, {
      regions: diff.items.map((item) => item.region),
    })
  } else {
    console.log(`SKIP  step.diff 异体比较: missing ${otherPath}`)
  }

  if (existsSync(imagePath)) {
    const image = await worker.request('image.analyze', { path: imagePath, threshold: 200 })
    check('图像统计出暗像素与包围盒', image.darkPixels > 0 && image.bbox?.length === 4, { darkPixels: image.darkPixels, bbox: image.bbox })
  } else {
    console.log(`SKIP  image.analyze: missing ${imagePath}`)
  }

  let unknown = null
  try { await worker.request('nope.op', {}, { timeout: 5000 }) } catch (error) { unknown = error }
  check('未知操作返回错误而不是崩溃', unknown?.code === 'UNKNOWN_OP', unknown?.code)
} finally {
  worker.close()
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
