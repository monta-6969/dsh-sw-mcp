// 齿轮参数闸门：锥齿/螺旋齿这类「整只齿轮的形状」不允许被接受后静默忽略。
// 这条测试不需要 SOLIDWORKS —— 拦截发生在 Node 侧的 build 入口。
import { assertGearSpecs, expandNativeGear, GEAR_KEY_WHITELIST } from '../server/gear.mjs'

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

const definitionWith = (primitive) => ({
  designId: 'gear-params',
  features: [
    { id: 'outline', kind: 'sketch', plane: 0, primitives: [{ shape: 'gear', teeth: 20, module: 2, ...primitive }] },
    { id: 'body', kind: 'extrude', profile: 'outline', depth: 10, direction: '+Y' },
  ],
})

function reasonOf(run) {
  try { run() } catch (error) { return String(error?.message ?? error) }
  return null
}

// 基准：合法定义必须通过，否则后面几条「拒绝」没有意义。
const clean = definitionWith({})
check('合法齿轮定义通过闸门', assertGearSpecs(clean) === clean, null)
check('合法齿轮定义仍能展开成原生路线', expandNativeGear(clean)?.gearNative?.mode === 'native-pattern', null)

for (const key of ['bevel', 'coneAngle', 'faceWidth', 'shaftAngle', 'pitchAngle', 'helixAngle']) {
  const value = key === 'bevel' ? 45 : 20
  const reason = reasonOf(() => assertGearSpecs(definitionWith({ [key]: value })))
  check(`${key} 被拒绝，不静默忽略`, /^UNSUPPORTED_PARAM: /.test(reason ?? '') && reason.includes(key), reason?.slice(0, 120))
}

// build 的入口是 expandNativeGear：闸门必须在这一层也拦住，否则 plan/build 各自为政。
const buildReason = reasonOf(() => expandNativeGear(definitionWith({ bevel: 45, coneAngle: 45 })))
check('expandNativeGear 同样拒绝锥齿参数', /^UNSUPPORTED_PARAM: /.test(buildReason ?? ''), buildReason?.slice(0, 120))
check('拒绝信息写清了原因与替代路线', /背锥展开/.test(buildReason ?? '') && /1\/cos/.test(buildReason ?? ''), null)

// 拼错的键也一样：多写一个不存在的参数不能"看起来生效"。
const typoReason = reasonOf(() => assertGearSpecs(definitionWith({ teeths: 20 })))
check('拼错/未知参数被拒绝', /^UNSUPPORTED_PARAM: /.test(typoReason ?? '') && typoReason.includes('teeths'), typoReason?.slice(0, 120))
check('拒绝信息列出白名单键', GEAR_KEY_WHITELIST.every((key) => typoReason?.includes(key)), null)

// 直齿本身没有 bevel：显式给了 0 也当"给了"处理吗？给 0 等于没给，放行。
const zeroReason = reasonOf(() => assertGearSpecs(definitionWith({ bevel: 0 })))
check('bevel:0 仍被拒绝（0 也是"给了"）', /^UNSUPPORTED_PARAM: /.test(zeroReason ?? ''), zeroReason?.slice(0, 80))

// 非齿轮定义不受影响。
const plain = { features: [{ id: 's', kind: 'sketch', plane: 0, primitives: [{ shape: 'circle', center: [0, 0], diameter: 10 }] }] }
check('非齿轮定义原样放过', reasonOf(() => assertGearSpecs(plain)) === null, null)

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
