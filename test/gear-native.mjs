// 原生齿轮：圆柱 + 一个齿槽切除 + 圆周阵列。
// 断言阵列特征真的出现在特征树里，体积等于 (齿顶圆面积 − 齿数×齿槽面积)×厚度。
import { ensureSolidworks } from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'
import { spurGearGap } from '../server/gear.mjs'

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

const gap = spurGearGap({ teeth: 20, module: 2 })
const depth = 10
const expectedVolume = gap.gearArea * depth

const session = openSession({})
await session.start()
try {
  await ensureSolidworks((name, args) => session.tool(name, args))
  await session.tool('workspace', { action: 'cleanup' })
  const designId = `gear-native-${Date.now()}`
  const built = await session.tool('model', {
    action: 'build',
    definition: {
      designId,
      features: [
        { id: 'outline', kind: 'sketch', plane: 0, primitives: [{ shape: 'gear', teeth: 20, module: 2, native: true }] },
        { id: 'body', kind: 'extrude', profile: 'outline', depth, direction: '+Y' },
      ],
    },
  })
  check('原生齿轮建成', built.status === 'ok', built.summary)
  check('结果标明 native-pattern', built.changes?.gear?.mode === 'native-pattern', built.changes?.gear)
  check('体积与齿槽阵列一致', Number.isFinite(built.measurements?.volume)
    && Math.abs(built.measurements.volume - expectedVolume) / expectedVolume < 0.02,
  { measured: built.measurements?.volume, analytic: Number(expectedVolume.toFixed(2)) })

  const model = await session.tool('inspect', { action: 'model', designId })
  const names = (model.changes?.featureTree ?? []).map((feature) => feature.name)
  check('特征树里有原生圆周阵列', names.some((name) => /阵列|Pattern/i.test(name)), names.slice(-5))
  const rawBox = model.measurements?.massProperties?.boundingBox ?? model.measurements?.boundingBox ?? {}
  const box = Array.isArray(rawBox) ? rawBox : rawBox.size ?? []
  check('外径是齿顶圆', box.length === 3 && Math.abs(box[0] - gap.tipRadius * 2) < 0.2, box)
} finally {
  try { session.close() } catch { }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
