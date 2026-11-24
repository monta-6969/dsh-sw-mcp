// 曲线契约的首个真实用例：八种曲线一种都不能"看起来像"就算数。
//
// 断言只看 SOLIDWORKS 回读出来的 type / centre / radius，不看请求里写了什么。
// 方程曲线允许退回采样样条，但必须自己说明（notes 里有 fallback），
// 否则调用方会以为它是可参数化的原生曲线。
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

const near = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) <= tol
const kindsOf = (segments) => [...new Set((segments ?? []).map((s) => s.type))].sort()

const session = openSession({})
await session.start()

try {
  const design = {
    designId: 'curve-zoo',
    params: { r: 15, depth: 5 },
    features: [
      {
        kind: 'sketch',
        id: 'curve_zoo',
        plane: 1,
        curves: [
          { kind: 'line', id: 'L1', start: [0, 0], end: [20, 0] },
          { kind: 'circle', id: 'C1', center: [0, 10], radius: 5 },
          {
            kind: 'arc', id: 'A1', center: [30, 10], radius: 5,
            startAngle: 0, endAngle: 90,
          },
          { kind: 'ellipse', id: 'E1', center: [50, 10], major: 8, minor: 4 },
          {
            kind: 'ellipticArc', id: 'EA1', center: [70, 10], major: 8, minor: 4,
            startParam: 0, endParam: 90,
          },
          {
            kind: 'spline', id: 'S1',
            points: [[0, 30], [5, 35], [10, 30], [15, 35]],
          },
          {
            kind: 'equationCurve', id: 'Q1',
            x: '10*cos(t)', y: '10*sin(t)',
            variable: { name: 't', from: 0, to: 4.71238898038469 },
          },
          {
            kind: 'equationCurve', id: 'Q2',
            x: '6*cos(t)', y: '6*sin(t)',
            variable: { name: 't', from: 0, to: 6.283185307179586 },
          },
          {
            kind: 'polyline', id: 'P1',
            points: [[0, 50], [10, 50], [10, 60], [0, 60]],
          },
        ],
      },
      {
        kind: 'sketch',
        id: 'profile',
        plane: 1,
        curves: [{ kind: 'circle', id: 'C2', center: [0, 0], radius: 'r' }],
      },
      { kind: 'extrude', id: 'body', profile: 'profile', depth: 'depth', direction: '+Y' },
    ],
  }

  const built = await session.must('model', { action: 'build', designId: 'curve-zoo', definition: design }, '建曲线测试件')
  check('建成后体积为正', Number(built.measurements?.volume ?? 0) > 0, { volume: built.measurements?.volume })

  const zoo = await session.must('inspect', { action: 'sketch', designId: 'curve-zoo', sketch: 'curve_zoo' }, '回读曲线草图')
  const segments = zoo.changes?.segments ?? []
  const kinds = kindsOf(segments)
  console.log('回读的 type：', kinds, '段数', segments.length,
    segments.map((s) => `${s.type}${s.params?.variable ? '(eq)' : ''}`))
  console.log(JSON.stringify(segments, null, 2))

  check('回读里有八类曲线的实体表现', kinds.length >= 6, { kinds })
  check('直线仍是 line', kinds.includes('line'), { kinds })
  check('圆是原生 circle', kinds.includes('circle'), { kinds })
  check('圆弧是原生 arc', kinds.includes('arc'), { kinds })
  check('椭圆是原生 ellipse', kinds.includes('ellipse'), { kinds })
  check('椭圆弧是 ellipticArc', kinds.includes('ellipticArc'), { kinds })
  check('样条是 spline', kinds.includes('spline'), { kinds })
  check('方程曲线是 equationCurve（未退回采样）', kinds.includes('equationCurve'), { kinds })
  const buildNotes = built.changes?.notes ?? []
  console.log('构建 notes：', JSON.stringify(buildNotes))
  check('闭合方程曲线退回采样时，说明原因', buildNotes.some((n) => n.includes('closed range with start==end')),
    { notes: buildNotes.filter((n) => n.includes('equation')) })

  const circle = segments.find((s) => s.type === 'circle')
  check('圆的半径回读为 5', circle && near(circle.radius, 5), { circle })
  check('圆心回读为 (0,10)', circle && near(circle.center?.[0], 0) && near(circle.center?.[1], 10), { circle })

  const arc = segments.find((s) => s.type === 'arc')
  check('圆弧半径回读为 5', arc && near(arc.radius, 5), { arc })
  check('圆弧圆心回读为 (30,10)', arc && near(arc.center?.[0], 30) && near(arc.center?.[1], 10), { arc })

  const ellipse = segments.find((s) => s.type === 'ellipse')
  check('椭圆长半轴 8、短半轴 4', ellipse && near(ellipse.params?.major, 8) && near(ellipse.params?.minor, 4),
    { ellipse })

  const poly = segments.filter((s) => s.type === 'line' && s.start && s.end)
  check('多段线保持三段直边（未变成样条）', poly.length >= 4, { lineSegments: poly.length })

  const profile = await session.must('inspect', { action: 'sketch', designId: 'curve-zoo', sketch: 'profile' }, '回读拉伸轮廓')
  const profSeg = (profile.changes?.segments ?? []).find((s) => s.type === 'circle')
  check('拉伸轮廓仍是原生圆，半径 15', profSeg && near(profSeg.radius, 15), { profSeg })

  const verified = await session.must('inspect', { action: 'verify', designId: 'curve-zoo' }, '核对模型')
  check('验证没有失败项', (verified.changes?.failures ?? []).length === 0, { checks: verified.changes?.checks })
} finally {
  session.close()
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
