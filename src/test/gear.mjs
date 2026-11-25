// 齿轮必须走原生路线：圆柱 + 一个齿形切除 + 原生圆周阵列。
// 不允许把渐开线拟合成大量直线；这里断言没有折线路径，并回读齿形草图的
// 原生段类型（spline / arc / line）。
import { ensureSolidworks } from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'
import { spurGearOutline, spurGearCurves, expandGearPrimitives, expandNativeGear } from '../server/gear.mjs'

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

const gear = spurGearOutline({ teeth: 20, module: 2 })
const depth = 10
const expectedVolume = gear.area * depth

let refused = false
try { expandGearPrimitives({ features: [{ primitives: [{ shape: 'gear', teeth: 20, module: 2 }] }] }) }
catch (error) { refused = /GEAR_NATIVE_REQUIRED/.test(String(error?.message)) }
check('折线拟合入口被明确拒绝', refused, refused)

let mixedRefused = false
try {
  expandNativeGear({
    features: [
      { kind: 'sketch', id: 'outline', plane: 1, primitives: [{ shape: 'gear', teeth: 20, module: 2 }] },
      { kind: 'extrude', id: 'body', profile: 'outline', depth: 10, direction: '+Y' },
      { kind: 'sketch', id: 'hole', plane: 1, primitives: [{ shape: 'circle', center: [0, 0], diameter: 5 }] },
      { kind: 'cut', id: 'holeCut', profile: 'hole', throughAll: true },
    ],
  })
} catch (error) { mixedRefused = /GEAR_COMBINATION_UNSUPPORTED/.test(String(error?.message)) }
check('gear 混入其它特征会被拒绝，不静默丢特征', mixedRefused, mixedRefused)

let paramsRefused = false
try {
  expandNativeGear({
    params: { m: 2 },
    features: [
      { kind: 'sketch', id: 'outline', plane: 1, primitives: [{ shape: 'gear', teeth: 20, module: 2 }] },
      { kind: 'extrude', id: 'body', profile: 'outline', depth: 10, direction: '+Y' },
    ],
  })
} catch (error) { paramsRefused = /GEAR_COMBINATION_UNSUPPORTED/.test(String(error?.message)) }
check('gear 带 params 会被拒绝，避免参数看起来生效', paramsRefused, paramsRefused)

let planeRefused = false
try {
  expandNativeGear({
    features: [
      { kind: 'sketch', id: 'outline', plane: 2, primitives: [{ shape: 'gear', teeth: 20, module: 2 }] },
      { kind: 'extrude', id: 'body', profile: 'outline', depth: 10, direction: '+Y' },
    ],
  })
} catch (error) { planeRefused = /GEAR_COMBINATION_UNSUPPORTED/.test(String(error?.message)) }
check('非 0 草图平面会被拒绝，不静默换面', planeRefused, planeRefused)

const session = openSession({})
await session.start()
try {
  await ensureSolidworks((name, args) => session.tool(name, args))
  await session.tool('workspace', { action: 'cleanup' })
  const designId = `gear-${Date.now()}`
  const built = await session.tool('model', {
    action: 'build',
    definition: {
      designId,
      features: [
        // 不写 native:true 也必须是原生路线。
        { id: 'outline', kind: 'sketch', plane: 0, primitives: [{ shape: 'gear', teeth: 20, module: 2, pressureAngle: 20 }] },
        { id: 'body', kind: 'extrude', profile: 'outline', depth, direction: '+Y' },
      ],
    },
  })
  check('齿轮能建成实体', built.status === 'ok', built.summary)
  const gearChange = built.changes?.gear ?? {}
  check('走原生齿形阵列，不是采样折线', gearChange.mode === 'native-pattern'
    && (gearChange.teeth ?? []).includes(20) && gearChange.pattern, gearChange)
  const measured = built.measurements?.volume
  check('齿轮体积与解析面积×厚度一致', Number.isFinite(measured)
    && Math.abs(measured - expectedVolume) / expectedVolume < 0.01, {
    measured, analytic: Number(expectedVolume.toFixed(3)), area: Number(gear.area.toFixed(3)),
  })
  const box = built.measurements?.boundingBox ?? []
  const diameter = gear.tipRadius * 2
  check('外径等于齿顶圆直径', box.length === 3
    && box.filter((value) => Math.abs(value - diameter) < 0.1).length === 2, box)

  const sketch = await session.tool('inspect', { action: 'sketch', designId })
  const segments = sketch.changes?.segments ?? sketch.changes?.geometry?.segments ?? []
  const kinds = [...new Set(segments.map((segment) => segment.type ?? segment.kind))]
  check('齿形草图是原生圆弧/样条，不是几百条直线', segments.length > 0 && segments.length < 40
    && kinds.includes('spline') && kinds.includes('arc'), { count: segments.length, kinds })
  const gapCurves = spurGearCurves({ teeth: 20, module: 2 }).curves
  const curveEnds = (curve) => curve.kind === 'spline'
    ? [curve.points[0], curve.points[curve.points.length - 1]]
    : [curve.start, curve.end]
  let maxGap = 0
  for (let i = 0; i < gapCurves.length; i++) {
    const end = curveEnds(gapCurves[i])[1]
    const next = curveEnds(gapCurves[(i + 1) % gapCurves.length])[0]
    maxGap = Math.max(maxGap, Math.abs(end[0] - next[0]), Math.abs(end[1] - next[1]))
  }
  check('齿槽曲线逐段闭合（Node 侧端点重合）', maxGap === 0, { maxGap })
} finally {
  try { session.close() } catch { }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
