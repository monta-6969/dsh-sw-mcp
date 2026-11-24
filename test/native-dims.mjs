// 原生尺寸直改：本机方程式管理系统会稳定拒绝 Add2，但构建时每条尺寸都
// 已经用 SystemValue 落成原生尺寸。这条用例证明 build 会记住参数→尺寸名，
// edit 直接改原生尺寸并回读，而不是靠重跑整个设计定义把值烘进几何。
import './lib/isolation.mjs'
import { designId as makeDesignId } from './lib/isolation.mjs'
// D4：finally 里的 cleanup / session.close / shutdownSolidworks 都加超时，
// 超时只打印 CLEANUP_TIMEOUT，不改断言结论；退出码一律按断言结果落地。
import {
  SHUTDOWN_TIMEOUT_MS,
  cleanupWorkspace,
  closeSessionHard,
  ensureSolidworks,
  exitProcessByResult,
  shutdownSolidworks,
  withTimeout,
} from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) passed += 1
  else failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

const designId = makeDesignId('native-dims')
const session = openSession({})
// ensureSolidworks 返回的是 {startedHere, owned, reason, status}，不是布尔。
// 旧版直接把对象赋给 startedHere，它是恒真值，于是收尾**无条件** shutdownSolidworks，
// 把用户正开着 reopen.SLDPRT 的实例（pid 27256）一起关掉。现在只认自己拉起的那个。
let startedHere = false
try {
  await session.start()
  const sw = await ensureSolidworks((name, args) => session.tool(name, args))
  startedHere = sw.startedHere === true
  console.log(`ensureSolidworks: reason=${sw.reason} startedHere=${startedHere} owned=${(sw.owned ?? []).map((e) => e.pid).join(',') || '-'}`)
  check('SOLIDWORKS 可用', sw.reason === 'ready', sw.reason)
  await session.tool('workspace', { action: 'cleanup' })

  const built = await session.tool('model', {
    action: 'build',
    definition: {
      designId,
      params: { 'plate.w': 100, 'plate.h': 60, 'plate.t': 20 },
      features: [
        {
          kind: 'sketch',
          id: 'outline',
          plane: 1,
          primitives: [{
            shape: 'rect', center: [0, 0], width: 'plate.w', height: 'plate.h',
            bind: { width: 'plate.w', height: 'plate.h' },
          }],
        },
        {
          kind: 'extrude', id: 'body', profile: 'outline', depth: 'plate.t', direction: '+Y',
          bind: { depth: 'plate.t' },
        },
      ],
    },
  })
  check('带参数底板建成', built.status === 'ok', built.summary)
  const dims = built.changes?.dimensionBindings ?? {}
  const bindings = built.changes?.bindings ?? {}
  check('原生尺寸绑定被记录（三条）', Object.keys(dims).length === 3, dims)
  check('bindings 与 dimensionBindings 至少一套覆盖三个参数',
    Object.keys(bindings).length === 3 || Object.keys(dims).length === 3,
    { bindings, dims })

  const before = built.measurements?.volume
  const edited = await session.tool('model', { action: 'edit', designId, parameters: { 'plate.w': 80 } })
  check('改宽 100→80 体积变为 96000', Math.abs((edited.measurements?.volume ?? 0) - 96000) < 1,
    edited.measurements?.volume)
  check('没有走整件重建', edited.changes?.mode !== 'rebuild', JSON.stringify(edited.changes))
  check('编辑模式是 dimension', edited.changes?.mode === 'dimension', edited.changes?.mode)
  const driven = (edited.changes?.driven ?? []).find((entry) => entry.param === 'plate.w')
  check('回读到 plate.w 绑定的尺寸且 bound', Boolean(driven?.bound), driven)
  check('回读值就是 80', (driven?.dimensions ?? []).some((d) => Math.abs((d.valueMm ?? 0) - 80) < 1e-6),
    driven?.dimensions)

  const thick = await session.tool('model', { action: 'edit', designId, parameters: { 'plate.t': 30 } })
  check('连续第二次编辑保留宽度 80', Math.abs((thick.measurements?.volume ?? 0) - 144000) < 1,
    thick.measurements?.volume)
  check('第二次也没有重建', thick.changes?.mode !== 'rebuild', thick.changes?.mode)
  check('体积确实从第一次的结果变化', Math.abs((thick.measurements?.volume ?? 0) - (before ?? 0)) > 1,
    { before, after: thick.measurements?.volume })
} finally {
  await cleanupWorkspace(session)
  closeSessionHard(session)
  // 只关自己拉起的实例，且必须把 tool 传进去（shutdownSolidworks(tool, startedHere)
  // 才能走 cleanup+quit 的温和路径）。别人的实例、用户开着的实例一个都不动。
  if (startedHere) {
    try {
      await withTimeout(shutdownSolidworks(session.tool, startedHere), SHUTDOWN_TIMEOUT_MS, 'shutdownSolidworks')
    } catch { /* owned 实例已登记在 instances.json，交给 broker reap 兜底 */ }
  } else console.log('未拉起实例：收尾不动任何 SOLIDWORKS 进程')
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(`FAIL: ${failures.join('; ')}`)
  exitProcessByResult(failures, 1)
}
exitProcessByResult(failures, 0)
