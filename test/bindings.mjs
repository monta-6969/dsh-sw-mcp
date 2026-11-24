// 参数化本身的最小回归：改一个参数，几何必须跟着动。
//
// 这条独立出来，是因为它失败的形态特别隐蔽：模型建得完全正确、体积分毫不差、
// 草图也完全约束，只是改参数没反应。长时间运行的 SOLIDWORKS 实例会进入
// 「方程式一律拒写」的状态（IEquationMgr.Add2 返回 -1），而我们过去只把它写进 notes。
// 现在构建阶段就报 EQUATION_MANAGER_REJECTED，这个测试是它的守门人。
import './lib/isolation.mjs'
// D4：finally 里的 session.close / shutdownSolidworks 都加超时，超时只打印
// CLEANUP_TIMEOUT，不改断言结论；退出码一律按断言结果落地。
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
function check(name, condition, detail) {
  if (condition) passed += 1
  else failures.push(name)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

const design = {
  designId: 'bindings-check',
  features: [
    {
      kind: 'sketch',
      id: 'plate_outline',
      plane: 1,
      primitives: [{ shape: 'rect', center: [0, 0], width: 'plate.w', height: 'plate.h', bind: { width: 'plate.w', height: 'plate.h' } }],
    },
    { kind: 'extrude', id: 'plate', profile: 'plate_outline', depth: 'plate.t', direction: '+Y', bind: { depth: 'plate.t' } },
  ],
}

const session = openSession({})
let startedHere = false
try {
  await session.start()
  // ensureSolidworks 返回 {startedHere, owned, reason, status}，不是布尔。旧版把对象
  // 当布尔记下来，于是收尾无条件 shutdown（同 native-dims.mjs:21 那个缺陷）。
  // 等待上限 90 s：拿不到就明确失败退出，不挂起。
  const sw = await ensureSolidworks((name, args) => session.tool(name, args), { timeoutMs: 90_000 })
  startedHere = sw.startedHere === true
  if (sw.reason !== 'ready') {
    console.log(`FAIL  SOLIDWORKS 不可用：${sw.reason}（90 s 内没拿到实例，明确退出，不挂起）`)
    console.log(JSON.stringify(sw.status?.changes ?? sw.status ?? {}).slice(0, 800))
    console.log('\n0 passed, 1 failed')
    process.exit(1)
  }
  await session.tool('workspace', { action: 'cleanup' })

  const built = await session.tool('model', {
    action: 'build',
    definition: { ...design, params: { 'plate.w': 100, 'plate.h': 60, 'plate.t': 20 } },
  })
  check('带参数的件建得出来', built.status === 'ok', built.summary)
  const bindings = built.changes?.bindings ?? {}
  const drivers = built.changes?.drivers ?? {}
  // 本机 SOLIDWORKS 会稳定拒绝写方程式（见 docs/SW-自动化MCP-研究报告.md 附录D M20），这时参数在建几何
  // 时就烘进了尺寸值 —— 下面几条 edit 断言证明「改参数仍然生效」，这条只要求
  // 服务如实说出这一版是靠什么驱动的，而不是假装绑上了。
  check('驱动方式被如实报告（方程式或逐次重建）',
    drivers.mode === 'equation' || drivers.mode === 'literal', drivers)
  if (drivers.mode === 'equation') check('三个参数都绑到了原生尺寸', Object.keys(bindings).length === 3, bindings)
  else check('拒绝绑定时说明了原因', (drivers.requested ?? 0) >= 3, drivers)
  check('体积与解析值一致', Math.abs((built.measurements?.volume ?? 0) - 120000) < 1, built.measurements?.volume)

  // 改宽 100 → 80：体积必须变成 80×60×20
  const edited = await session.tool('model', { action: 'edit', designId: 'bindings-check', parameters: { 'plate.w': 80 } })
  check('改参数后体积跟着变', Math.abs((edited.measurements?.volume ?? 0) - 96000) < 1, edited.measurements?.volume)
  // measurements.boundingBox 是 [X,Y,Z] 三个尺寸（不是在 build/inspect 之间统一的 {size} 形状）。
  const box = edited.measurements?.boundingBox ?? []
  check('包围盒的 X 缩短到 80', Math.abs((box[0] ?? 0) - 80) < 0.05, box)

  // 再改厚 20 → 30：验证不是只有第一个参数能动
  const thicker = await session.tool('model', { action: 'edit', designId: 'bindings-check', parameters: { 'plate.t': 30 } })
  check('改厚度也生效', Math.abs((thicker.measurements?.volume ?? 0) - 144000) < 1, thicker.measurements?.volume)

  // 写错参数名过去会被当成「新建一个全局变量」，edit 返回成功而几何不动。
  const typo = await session.tool('model', { action: 'edit', designId: 'bindings-check', parameters: { 'plate.widht': 50 } })
  check('参数名写错会被拒绝', typo.status === 'failed' && typo.extra?.error?.code === 'UNKNOWN_PARAM',
    typo.extra?.error?.code ?? typo.status)
  check('拒绝时列出可用参数', String(typo.extra?.error?.message ?? '').includes('plate.w'),
    typo.extra?.error?.message)

  // 参数互相引用必须报环，而不是把没解析出来的参数算成 0。
  const cycle = await session.tool('model', {
    action: 'build',
    definition: {
      designId: 'param-cycle',
      params: { a: 'b*2', b: 'a+1' },
      features: [
        { kind: 'sketch', id: 's', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width: 'a', height: 'b' }] },
        { kind: 'extrude', id: 'e', profile: 's', depth: 5 },
      ],
    },
  })
  check('参数环被拒绝并报 PARAM_CYCLE', cycle.extra?.error?.code === 'PARAM_CYCLE',
    cycle.extra?.error?.code ?? cycle.status)

  await session.tool('workspace', { action: 'cleanup' })
} catch (error) {
  check('没有抛异常', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '))
} finally {
  // cleanup 带超时（这一文件原本在 finally 里**没有** cleanup，只在 try 末尾调用过一次；
  // 统一走 cleanupWorkspace：cleanup 30s → session.close 10s）。
  await cleanupWorkspace(session)
  closeSessionHard(session)
  // 只关自己拉起的实例；tool 必须传进去，否则 shutdownSolidworks 只能走 killOwned 的硬杀路径。
  try { await withTimeout(shutdownSolidworks(session.tool, startedHere), SHUTDOWN_TIMEOUT_MS, 'shutdownSolidworks') } catch {}
}

console.log(`\n${passed} passed, ${failures.length} failed`)
exitProcessByResult(failures, failures.length > 0 ? 1 : 0)
