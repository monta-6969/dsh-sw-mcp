// 切除的起点与方向必须真的生效。
//
// 这一条是给 `Builder.CutSketch` 写的回归：它以前把 `startOffset` 丢了（永远从草图
// 基准面开始切），并且用「体积有没有变」来判断方向对不对——镜像切掉同样多的料，
// 体积一样会变，于是「切在 y 10..15」和「切在 y 0..5」在旧实现里无法区分。
//
// 现在断言的是几何位置，不是体积：同样的圆孔，startOffset=0 时孔在 0..5，
// startOffset=10 时孔在 10..15。体积两次一样，位置不一样。
import { openSession, repoRoot } from './lib/mcp.mjs'

const session = openSession({ cwd: repoRoot })
await session.start()

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

const PLATE = 120000 // 100 x 60 x 20
const HOLE = Math.PI * 10 * 10 * 5 // Ø20 深 5
const EXPECT_VOLUME = PLATE - HOLE

function design(name, startOffset) {
  return {
    designId: name,
    units: 'mm',
    features: [
      {
        id: 'plate_outline',
        kind: 'sketch',
        plane: 1,
        primitives: [{ shape: 'rect', center: [0, 0], width: 100, height: 60 }],
      },
      {
        id: 'plate',
        kind: 'extrude',
        profile: 'plate_outline',
        depth: 20,
        direction: '+Y',
      },
      {
        id: 'hole_outline',
        kind: 'sketch',
        plane: 1,
        primitives: [{ shape: 'circle', center: [0, 0], diameter: 20 }],
      },
      {
        id: 'hole',
        kind: 'cut',
        profile: 'hole_outline',
        depth: 5,
        direction: '+Y',
        ...(startOffset ? { startOffset } : {}),
      },
    ],
  }
}

async function cylinders(designId) {
  const result = await session.must(
    'inspect',
    { action: 'measure', designId, measure: { kind: 'cylinders' } },
    'measure cylinders',
  )
  const list = result.changes?.result?.cylinders ?? result.measurements?.cylinders ?? []
  return list.filter((c) => Math.abs(c.diameter - 20) < 0.05)
}

// ── 起点在草图基准面上 ───────────────────────────────────────────────
{
  const built = await session.must('model', { action: 'build', definition: design('cut-at-zero', 0) }, 'build cut-at-zero')
  const volume = built.measurements?.volume
  check('startOffset 0：体积等于解析值', Math.abs(volume - EXPECT_VOLUME) < 1, volume)

  const found = await cylinders('cut-at-zero')
  check('startOffset 0：找到一个 Ø20 孔', found.length === 1, found.length)
  const span = found[0]?.box
  check(
    'startOffset 0：孔从 y0 切到 y5',
    span !== undefined && Math.abs(span[1] - 0) < 0.05 && Math.abs(span[4] - 5) < 0.05,
    span,
  )
}

// ── 起点抬高 10 mm ─────────────────────────────────────────────────
{
  const built = await session.must(
    'model',
    { action: 'build', definition: design('cut-at-ten', 10) },
    'build cut-at-ten',
  )
  const volume = built.measurements?.volume
  check('startOffset 10：体积仍等于解析值', Math.abs(volume - EXPECT_VOLUME) < 1, volume)

  const found = await cylinders('cut-at-ten')
  check('startOffset 10：找到一个 Ø20 孔', found.length === 1, found.length)
  const span = found[0]?.box
  check(
    'startOffset 10：孔从 y10 切到 y15（不是从 0 开始）',
    span !== undefined && Math.abs(span[1] - 10) < 0.05 && Math.abs(span[4] - 15) < 0.05,
    span,
  )
}

// ── 方向：显式要求 −Y（板外）时必须报错，而不是偷偷翻到另一侧 ──────────
//
// 旧实现会试两个方向、留下「体积变了」的那个，所以「切在板外」会被悄悄翻成
// 「切在板内」。现在显式方向只有一个候选，切不动就是 CUT_FAILED，错误里写明
// 候选数 1 —— 这一条正是「不要用启发式猜方向」的回归。
{
  const flipped = design('cut-reversed', 0)
  flipped.features[3].direction = '-Y'
  const result = await session.tool('model', { action: 'build', definition: flipped })
  const code = result.error?.code ?? result.extra?.error?.code
  const message = result.error?.message ?? result.extra?.error?.message ?? result.summary ?? ''
  check('显式 -Y 切到板外：失败而不是静默翻转', result.status === 'failed' && code === 'CUT_FAILED', {
    status: result.status,
    code,
  })
  check('失败信息说明只试了一个方向', message.includes('dir candidates 1'), message)
}

await session.close()
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(failures.map((name) => `  - ${name}`).join('\n'))
  process.exitCode = 1
}
