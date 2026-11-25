// A7：保存 → 关闭 → 重新打开 → 特征与参数关系仍在。
// 存盘后模型名变文件名，尺寸全名后缀随之改变；这里验证重新解析后仍能直接改原生尺寸。
//
// 两处硬约束（上一轮踩过）：
//   1. workspace_ops action=quit 之后**没有任何东西会自动把 SOLIDWORKS 拉起来**
//      （reload 只换桥接器，不启动 SW），旧版在这里干等，挂了 >7 分钟。
//      现在用 ensureSolidworks 显式拉起。
//   2. 每一步都有上限：60s 内拿不到实例就明确 BLOCKED 并退出，绝不挂起。
import './lib/isolation.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// D4：收尾统一走 lib/sw.mjs 的带超时 helper（cleanup 30s / close 10s /
// shutdownSolidworks 25s，可用 SW_CLEANUP_TIMEOUT_MS 等覆盖）。超时只打印
// CLEANUP_TIMEOUT，不改断言结论；退出码一律按断言结果落地。
import {
  SHUTDOWN_TIMEOUT_MS,
  cleanupWorkspace,
  closeSessionHard,
  ensureSolidworks,
  exitProcessByResult,
  shutdownSolidworks,
} from './lib/sw.mjs'
import { designId as makeDesignId } from './lib/isolation.mjs'
import { openSession } from './lib/mcp.mjs'

// 预算：这条用例要真退出一次 SOLIDWORKS 再拉起来（本机实测重启 30–50 s），
// build+save 再加十几秒，60 s 只够跑到第 10 个断言。默认 150 s，可用
// SW_REOPEN_BUDGET_MS 调；下限钉在 60 s，不会因为配得太小而变成必然 BLOCKED。
// 无论预算多少，到点一定按 BLOCKED 退出 —— 判据要的是「不许挂起」，不是「必须秒回」。
const BUDGET_MS = Math.max(60_000, Number(process.env.SW_REOPEN_BUDGET_MS ?? 150_000) || 150_000)
const RELAUNCH_TIMEOUT_MS = Number(process.env.SW_REOPEN_TIMEOUT_MS ?? 60_000)

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) passed += 1
  else failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

function blocked(reason, detail) {
  console.log(`\nBLOCKED  ${reason}`)
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  console.log(`\n${passed} passed, ${failures.length} failed, BLOCKED`)
  process.exit(2)
}

/** 给每个等待加死线：超时就 BLOCKED，不留下一个永远挂着的进程。 */
function withTimeout(promise, ms, what) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 超过 ${ms} ms 无响应`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

const hardDeadline = setTimeout(() => {
  console.log(`\nBLOCKED  ${BUDGET_MS} ms 预算用尽（总超时）`)
  console.log(`\n${passed} passed, ${failures.length} failed, BLOCKED`)
  process.exit(2)
}, BUDGET_MS)
// 不 unref：这个计时器就是「不许挂起」的保证，宁可它多活一会儿，也要保证一定触发。
// 正常路径结束时下面会 clearTimeout 掉它（见文件末尾），不会拖慢退出。

const dir = mkdtempSync(join(tmpdir(), 'sw-reopen-'))
const path = join(dir, 'reopen.SLDPRT')
const designId = makeDesignId('reopen')
const session = openSession({ env: { ...process.env, SW_MCP_DATA: dir } })
let startedHere = false
try {
  await withTimeout(session.start(), 20_000, 'session.start')
  const first = await withTimeout(ensureSolidworks(session.tool, { timeoutMs: RELAUNCH_TIMEOUT_MS }), RELAUNCH_TIMEOUT_MS + 10_000, 'ensureSolidworks(首次)')
  if (first.reason !== 'ready') blocked(`首次没拿到可用实例：${first.reason}`, first.status?.changes ?? first.status)
  startedHere = first.startedHere === true
  await session.tool('workspace', { action: 'cleanup' })
  const built = await withTimeout(session.tool('model', {
    action: 'build',
    definition: {
      designId,
      params: { 'plate.w': 60, 'plate.h': 40, 'plate.t': 10 },
      features: [
        { kind: 'sketch', id: 'outline', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width: 'plate.w', height: 'plate.h', bind: { width: 'plate.w', height: 'plate.h' } }] },
        { kind: 'extrude', id: 'body', profile: 'outline', depth: 'plate.t', direction: '+Y', bind: { depth: 'plate.t' } },
      ],
    },
  }), 120_000, 'model.build')
  check('建成', built.status === 'ok', built.summary)
  const title = built.changes?.document?.title
  check('有文档标题', Boolean(title), title)
  const saved = await withTimeout(session.tool('deliver', { designId, kind: 'sldprt', path }), 120_000, 'deliver')
  check('保存成功', saved.status === 'ok', saved.summary)
  // 真退出 SOLIDWORKS，再重新启动并打开文件：这是最彻底的重开验证。
  const quit = await withTimeout(session.tool('workspace', { action: 'quit' }), 60_000, 'workspace.quit')
  check('SOLIDWORKS 已退出', quit.status === 'ok' || /exit|退出|quit/i.test(String(quit.summary)), quit.summary)
  await new Promise((resolve) => setTimeout(resolve, 5000))
  // The bridge still holds dead COM proxies; drop the child before reattaching.
  await withTimeout(session.tool('workspace', { action: 'reload' }), 60_000, 'workspace.reload')
  // 关键：quit 之后没人会自动拉起 SOLIDWORKS，必须自己叫。拿不到就 BLOCKED 退出。
  const again = await withTimeout(
    ensureSolidworks(session.tool, { timeoutMs: RELAUNCH_TIMEOUT_MS }),
    RELAUNCH_TIMEOUT_MS + 10_000,
    'ensureSolidworks(重开)',
  )
  if (again.startedHere) startedHere = true
  if (again.reason !== 'ready') blocked(`退出后重新拉起失败：${again.reason}`, again.status?.changes ?? again.status)
  check('退出后重新拉起 SOLIDWORKS', again.reason === 'ready', { reason: again.reason, startedHere: again.startedHere })
  const opened = await withTimeout(session.tool('workspace', { action: 'open', path }), 120_000, 'workspace.open')
  check('重新打开成功', opened.status === 'ok', opened.summary)
  const model = await session.tool('inspect', { action: 'model', designId })
  const features = model.changes?.featureTree ?? model.changes?.features ?? []
  check('特征树仍在（≥2）', features.length >= 2, features.map((f) => f.name ?? f.featureName ?? f.type))
  const edited = await session.tool('model', {
    action: 'edit', designId, parameters: { 'plate.w': 80 },
  })
  check('重开后仍能改参数', edited.status === 'ok', edited.summary)
  check('体积按 80×40×10 更新', Math.abs((edited.measurements?.volume ?? 0) - 32000) < 1,
    edited.measurements?.volume)
  // 存盘把模型名从「零件N」改成文件名，旧尺寸全名失效；第一次编辑按定义重建，
  // 同时重建会刷新绑定。第二次编辑必须恢复到原生尺寸直改。
  const second = await session.tool('model', {
    action: 'edit', designId, parameters: { 'plate.h': 50 },
  })
  check('重开后第二次编辑走原生尺寸', second.changes?.mode === 'dimension', second.changes?.mode)
  check('直接改高的体积 80×50×10', Math.abs((second.measurements?.volume ?? 0) - 40000) < 1,
    second.measurements?.volume)
  const driven = (second.changes?.driven ?? []).find((entry) => entry.param === 'plate.h')
  check('回读到 bound 的原生尺寸', Boolean(driven?.bound), driven)
} catch (error) {
  // 超时不是「失败的断言」，是环境没给到可用的 SOLIDWORKS：如实报 BLOCKED。
  const message = String(error?.message ?? error)
  if (/超过 \d+ ms 无响应/.test(message)) blocked(message)
  check('测试过程没有抛异常', false, String(error?.stack ?? error).split('\n').slice(0, 4).join(' | '))
} finally {
  // 注意：这里**不能** clearTimeout(hardDeadline)。收尾里的 shutdownSolidworks →
  // reapTestInstances 会走 broker 的 workspace_ops reap，那一步没有自己的超时；
  // 实例正忙时它会一直等下去。看门狗必须活到最后，才能在预算用尽时把进程按 BLOCKED
  // 收掉，而不是像上一版那样「断言全绿、进程挂住」。只有走到最后一行才清它。
  // D4：每一步都带超时（cleanup 30s / close 10s / shutdownSolidworks 25s），
  // 超时打印 CLEANUP_TIMEOUT，不改断言结论。
  await cleanupWorkspace(session)
  if (startedHere) {
    try {
      await withTimeout(shutdownSolidworks(session.tool, startedHere), SHUTDOWN_TIMEOUT_MS, 'shutdownSolidworks')
    } catch { /* owned 实例已登记在 instances.json，交给 broker reap 兜底 */ }
  }
  closeSessionHard(session)
  try { rmSync(dir, { recursive: true, force: true }) } catch { }
}
console.log(`\n${passed} passed, ${failures.length} failed`)
clearTimeout(hardDeadline)
if (failures.length) { console.log(failures.join('; ')); exitProcessByResult(failures, 1) }
exitProcessByResult(failures, 0)
