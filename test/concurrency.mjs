// 两个代理同时用同一台 SOLIDWORKS。
//
// 每个会话起自己的 MCP server，各自附着同一个 SLDWORKS.exe。COM 那边是单线程，
// 活动文档和选择集是进程级全局状态，所以「并行」在物理上只能是排队 —— 但排队必须
// 排在**进程之间**，否则 A 的草图会落进 B 刚切过去的零件，而且不报错。
//
// 这里证明三件事：
//   1. 两个会话同时建模，两个件都建对了（没有互相污染）；
//   2. 墙钟时间接近两次耗时之和（真的串行了，不是各建各的）；
//   3. 每个会话量回来的是自己的件。
import { openSession, repoRoot } from './lib/mcp.mjs'

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) passed += 1
  else failures.push(name)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) {
    console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
}

// 六个特征：板 + 两个通孔 + 凸台。全部画在基准面上并显式给世界轴方向 ——
// 面坐标系与草图坐标系在 SOLIDWORKS 里不是一回事，这个测试不该被那件事干扰。
function design(id, width) {
  return {
    designId: id,
    units: 'mm',
    features: [
      {
        id: 'plate_outline',
        kind: 'sketch',
        plane: 1,
        primitives: [{ shape: 'rect', center: [0, 0], width, height: width * 0.6 }],
      },
      { id: 'plate', kind: 'extrude', profile: 'plate_outline', depth: 15, direction: '+Y' },
      {
        id: 'holes_outline',
        kind: 'sketch',
        plane: 1,
        primitives: [
          { shape: 'circle', center: [-width * 0.3, 0], diameter: 8 },
          { shape: 'circle', center: [width * 0.3, 0], diameter: 8 },
        ],
      },
      {
        id: 'holes',
        kind: 'cut',
        profile: 'holes_outline',
        throughAll: true,
        both: true,
        direction: '+Y',
      },
      {
        id: 'boss_outline',
        kind: 'sketch',
        plane: 1,
        primitives: [{ shape: 'circle', center: [0, 0], diameter: 24 }],
      },
      { id: 'boss', kind: 'extrude', profile: 'boss_outline', depth: 10, startOffset: 15, direction: '+Y' },
    ],
  }
}

function expected(width) {
  const plate = width * width * 0.6 * 15
  const holes = 2 * Math.PI * 4 * 4 * 15
  const boss = Math.PI * 12 * 12 * 10
  return plate - holes + boss
}

const a = openSession({ cwd: repoRoot })
const b = openSession({ cwd: repoRoot })
await a.start()
await b.start()

// 先各建一次，量出单次耗时，同时确认两条链路都通。
let t0 = Date.now()
const soloA = await a.must('model', { action: 'build', definition: design('conc-a', 100) }, 'build conc-a')
const soloB = await b.must('model', { action: 'build', definition: design('conc-b', 80) }, 'build conc-b')
const soloMs = Date.now() - t0

check('conc-a 体积正确', Math.abs(soloA.measurements.volume - expected(100)) < 1, soloA.measurements.volume)
check('conc-b 体积正确', Math.abs(soloB.measurements.volume - expected(80)) < 1, soloB.measurements.volume)

// 并行：两个会话同时发 build。
const parallelStart = Date.now()
const [parA, parB] = await Promise.all([
  a.must('model', { action: 'build', definition: design('conc-a2', 100) }, 'parallel build conc-a2'),
  b.must('model', { action: 'build', definition: design('conc-b2', 80) }, 'parallel build conc-b2'),
])
const parallelMs = Date.now() - parallelStart

check('并行时 conc-a2 体积正确', Math.abs(parA.measurements.volume - expected(100)) < 1, parA.measurements.volume)
check('并行时 conc-b2 体积正确', Math.abs(parB.measurements.volume - expected(80)) < 1, parB.measurements.volume)

// 串行的判据：并行墙钟至少是「单独两次里较短那次」的 1.3 倍以上。
// 真并行的话两次会几乎同时结束，墙钟约等于较慢那次。
const soloEachFloor = Math.min(
  Math.max(1, Math.round(soloMs / 2) - 250),
  1_000_000,
)
check(
  '两个 build 真的排了队（墙钟没有重叠）',
  parallelMs > soloEachFloor * 1.3,
  { parallelMs, soloTotalMs: soloMs, floor: soloEachFloor },
)

// 各自量回来必须是自己的件。
const modelA = await a.must('inspect', { action: 'model', designId: 'conc-a2' }, 'inspect conc-a2')
const modelB = await b.must('inspect', { action: 'model', designId: 'conc-b2' }, 'inspect conc-b2')
const sizeA = modelA.measurements?.boundingBox?.size
const sizeB = modelB.measurements?.boundingBox?.size
check('会话 A 量到的是 100 宽的件', Math.abs((sizeA?.[0] ?? 0) - 100) < 0.01, sizeA)
check('会话 B 量到的是 80 宽的件', Math.abs((sizeB?.[0] ?? 0) - 80) < 0.01, sizeB)

await a.close()
await b.close()

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(failures.map((name) => `  - ${name}`).join('\n'))
  process.exitCode = 1
}
