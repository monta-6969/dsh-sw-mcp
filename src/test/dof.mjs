// 装配剩余自由度（离线）：用配合清单算近似 DOF，不需要 SOLIDWORKS。
// 这条是「读数存在且算法写清」的回归，不是精度验收 —— 精度验收要在真机上比。
import { dofFromMates, removedByMate, MATE_REMOVED_DOF } from '../server/dof.mjs'

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

const comps = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ name: `c${i + 1}`, ...extra }))

// 4 个自由组件 = 24 自由度；0 配合 → 24。
{
  const dof = dofFromMates({ components: comps(4), mates: [] })
  check('4 个无约束组件 = 24 自由度', dof.remaining === 24 && dof.total === 24 && dof.removed === 0, dof.remaining)
}

// 四瓣整机常见：1 个固定底座 + 4 个瓣，每瓣一个重合 + 一个同心 → 每瓣剩 6-3-4 = -1 → clamp 0
{
  const components = [{ name: 'base', fixed: true }, ...comps(4)]
  const mates = comps(4).flatMap((c) => ([
    { type: 'Coincident', components: [{ component: 'base' }, { component: c.name }] },
    { type: 'Concentric', components: [{ component: 'base' }, { component: c.name }] },
  ]))
  const dof = dofFromMates({ components, mates })
  check('固定件不计入 6N', dof.total === 24 && dof.fixedComponents === 1, dof.total)
  check('过约束被识别（扣掉的比总量多）', dof.overConstrained === true && dof.remaining === 0, dof.removed)
  check('每种配合都有计数', dof.byType.COINCIDENT === 4 && dof.byType.CONCENTRIC === 4, dof.byType)
}

// 只剩一个转动自由度：1 个自由组件 + 同心(4) + 距离(1) → 6-5 = 1
{
  const dof = dofFromMates({
    components: [{ name: 'shaft' }, { name: 'base', fixed: true }],
    mates: [
      { type: 'Concentric', components: [{ component: 'base' }, { component: 'shaft' }] },
      { type: 'Distance', components: [{ component: 'base' }, { component: 'shaft' }] },
    ],
  })
  check('同心+距离 = 剩 1 个转动自由度', dof.remaining === 1, { total: dof.total, removed: dof.removed })
}

// 齿轮配合只扣 1；锁旋转在同心上再加 1。
check('gear 配合扣 1', removedByMate({ type: 'Gear' }) === 1, null)
check('同心 lockRotation 追加 1', removedByMate({ type: 'Concentric', lockRotation: true }) === 5, null)
check('lock 扣 6', removedByMate({ type: 'Lock' }) === 6, null)
check('未知类型扣 0 并进 unknownTypes', dofFromMates({
  components: comps(2),
  mates: [{ type: 'MadeUpMate' }],
}).unknownTypes.join() === 'MADEUPMATE', null)
check('未知类型会写进 caveats', (dofFromMates({ components: comps(2), mates: [{ type: 'MadeUpMate' }] }).caveats ?? [])
  .some((line) => /未知配合类型/.test(line)), null)

// 压缩掉的组件不算自由度；压缩掉的配合也不扣。
{
  const dof = dofFromMates({
    components: [{ name: 'a' }, { name: 'b', suppressed: true }],
    mates: [{ type: 'Concentric', suppressed: true }],
  })
  check('压缩组件/配合被跳过', dof.total === 6 && dof.removed === 0 && dof.mateCount === 0, { total: dof.total, removed: dof.removed })
}

// 方法说明必须写清，否则读报告的人不知道这是近似值。
{
  const dof = dofFromMates({ components: comps(2), mates: [] })
  check('带 method 与 caveats', typeof dof.method === 'string' && dof.method.includes('6×') && dof.caveats.length >= 3,
    dof.caveats.length)
  check('caveats 写明了没有公开 DOF 接口', dof.caveats.some((line) => /没有公开 DOF 接口/.test(line)), null)
}

check('扣分表覆盖常见配合', ['CONCENTRIC', 'COINCIDENT', 'DISTANCE', 'ANGLE', 'GEAR', 'LOCK', 'PARALLEL']
  .every((key) => typeof MATE_REMOVED_DOF[key] === 'number'), Object.keys(MATE_REMOVED_DOF).length)

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
