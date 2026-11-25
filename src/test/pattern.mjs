// 原生圆形阵列：一个切除特征 + 两个基准面交线作轴，FeatureCirPattern。
// 断言阵列特征真的生成了 4 个孔，而不是把种子孔复制进草图。
import { ensureSolidworks } from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'

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

const session = openSession({})
await session.start()
try {
  await ensureSolidworks((name, args) => session.tool(name, args))
  await session.tool('workspace', { action: 'cleanup' })
  const designId = `pattern-${Date.now()}`
  const built = await session.tool('model', {
    action: 'build',
    definition: {
      designId,
      features: [
        { kind: 'sketch', id: 'outline', plane: 0, primitives: [{ shape: 'rect', center: [0, 0], width: 100, height: 60 }] },
        { kind: 'extrude', id: 'body', profile: 'outline', depth: 10 },
        { kind: 'sketch', id: 'bore', plane: 0, primitives: [{ shape: 'circle', center: [20, 0], diameter: 10 }] },
        { kind: 'cut', id: 'through', profile: 'bore', throughAll: true },
      ],
    },
  })
  check('底板与单个切除孔建成', built.status === 'ok', built.summary)
  const cut = (built.changes?.features ?? []).find((feature) => feature.kind === 'cut')
  const cutName = cut?.featureName ?? cut?.name
  check('build 返回切除特征名', Boolean(cutName), cut)

  const patterned = await session.tool('model', {
    action: 'pattern',
    designId,
    feature: cutName,
    count: 4,
    angleDeg: 360,
    axisPlanes: [1, 2],
  })
  check('原生圆形阵列成功', patterned.status === 'ok' && patterned.changes?.pattern, patterned.changes ?? patterned.summary)

  const measured = await session.tool('inspect', { action: 'measure', designId, measure: { kind: 'holes' } })
  const holes = measured.changes?.result?.holes ?? []
  check('量到 4 个孔', holes.length === 4, holes.map((hole) => hole.diameter))
  const expected = 100 * 60 * 10 - 4 * Math.PI * 25 * 10
  const model = await session.tool('inspect', { action: 'model', designId })
  const volume = model.measurements?.massProperties?.volume ?? model.measurements?.volume
  check('体积与 4 个贯穿孔一致', Number.isFinite(volume) && Math.abs(volume - expected) < 30,
    { volume, expected: Number(expected.toFixed(2)) })
  check('特征树里有圆周阵列特征', (model.changes?.featureTree ?? []).some((feature) => /阵列|Pattern/i.test(feature.name)),
    (model.changes?.featureTree ?? []).map((feature) => feature.name).slice(-4))
} finally {
  try { session.close() } catch { }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
