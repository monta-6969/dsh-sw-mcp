// 关系写入的真机验收：本文件需要一台正在运行的 SOLIDWORKS（没起就打印 SKIP）。
//
// 为什么单独一个文件：关系写入是本仓库唯一「离线全绿、真机全红」的一段。离线用例
// （test/relations-edit.mjs）只能证明引用语法与工具面形状；真正决定成败的三件事只能在
// 真机上验：
//   1. 关系能不能真的写进去（Count 增加、回读能读回来）；
//   2. 写不进去时是不是如实报错（RELATION_REJECTED + 每条的 error），而不是静默跳过；
//   3. atomic 语义：一条成功一条失败时，这次调用加进去的关系要回滚掉。
//
// 实测记要（2026-11-13，SOLIDWORKS 2026 SP3.2）：
//   · ISketchRelationManager.AddRelation 对任何类型/任何实体都抛 COM 0x80010105
//     (RPC_E_SERVERFAULT)；改用「Select4/SelectByID2 选中实体 + SketchAddConstraints」
//     这条路之后，CONCENTRIC / TANGENT / HORIZONTAL / VERTICAL 都能落地；
//   · 点-点 COINCIDENT 仍然一条都加不出来（见 test/sketch-live.mjs 的说明），
//     这里只断言它「必须如实被拒」，不许静默成功。
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession, repoRoot } from './lib/mcp.mjs'

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

/** 直接驱动桥接器：一行请求、一行应答。造「没有关系的松散草图」用它，因为
 *  model build 的仅草图门禁要求每段都带关系，而这里要的正是「一条关系都没有」。 */
function bridgeSession() {
  const child = spawn(join(repoRoot, 'bridge', 'bin', 'SwBridge.exe'), [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let buffer = ''
  const waiters = new Map()
  let nextId = 1
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const waiter = waiters.get(message.id)
      if (waiter) { waiters.delete(message.id); waiter(message) }
    }
  })
  const call = (payload) => new Promise((resolvePromise, rejectPromise) => {
    const id = nextId++
    waiters.set(id, resolvePromise)
    const timer = setTimeout(() => {
      waiters.delete(id)
      rejectPromise(new Error(`桥接器 ${payload.op} 超时`))
    }, 180_000)
    waiters.set(id, (value) => { clearTimeout(timer); resolvePromise(value) })
    child.stdin.write(JSON.stringify({ id, ...payload }) + '\n')
  })
  return { call, close: () => child.kill() }
}

const circle = (id, center, radius) => ({ id, kind: 'circle', params: { center, radius } })
const line = (id, start, end) => ({ id, kind: 'line', params: { start, end } })

const bridge = bridgeSession()
const work = mkdtempSync(join(tmpdir(), 'sw-mcp-relations-live-'))
const dataDir = join(work, 'data')
mkdirSync(dataDir, { recursive: true })
let session = null
try {
  // ---------------------------------------------------------------- 有没有 SW
  const status = await bridge.call({ op: 'status' })
  if (status?.ready !== true) {
    console.log(`SKIP  SOLIDWORKS 没在运行（status reason=${status?.reason ?? 'unknown'}）；` +
      ' 先起 SOLIDWORKS 再跑这个文件')
    process.exitCode = 0
  } else {
    const designId = `relations-live-${Date.now()}`
    // 松散草图：两个同心圆 + 一条横线 + 一条竖线（竖线 x=10 与 r=10 的圆相切）。
    // 段号按创建顺序：seg:1=c1 seg:2=c2 seg:3=横线 seg:4=竖线。
    const built = await bridge.call({
      op: 'build',
      definition: {
        designId,
        output: 'sketch',
        sketch: {
          id: 's1',
          plane: 1,
          curves: [
            circle('c1', [0, 0], 10),
            circle('c2', [0, 0], 4),
            line('lh', [-20, -20], [20, -20]),
            line('lv', [10, -20], [10, 20]),
          ],
        },
      },
    })
    check('桥接器建出用于改关系的松散草图（4 段、0 条关系）',
      built?.ok === true && built?.sketch?.segmentCount === 4 && built?.sketch?.relationCount === 0,
      { ok: built?.ok, error: built?.error?.code, segmentCount: built?.sketch?.segmentCount })

    const call = (payload) => bridge.call({ op: 'relations', designId, ...payload })
    const list = () => call({ action: 'list' })

    const empty = await list()
    check('初始 list：0 条关系',
      empty?.ok === true && empty?.count === 0, { count: empty?.count })

    // ------------------------------------------------------------ 三种以上关系 add
    const horizontal = await call({ action: 'add', relations: [{ type: 'horizontal', refs: ['seg:3'] }] })
    check('add HORIZONTAL（单实体）落地：applied=1、rejected=0',
      horizontal?.ok === true && horizontal?.applied?.length === 1 && horizontal?.rejected?.length === 0,
      { ok: horizontal?.ok, error: horizontal?.error?.code, applied: horizontal?.applied?.length })
    const afterHorizontal = await list()
    check('回读：关系条数 0 -> 1，且读回来的类型就是 HORIZONTAL',
      afterHorizontal?.count === 1 && afterHorizontal?.relations?.[0]?.type === 'HORIZONTAL',
      afterHorizontal?.relations)

    const vertical = await call({ action: 'add', relations: [{ type: 'vertical', refs: ['seg:4'] }] })
    check('add VERTICAL 落地', vertical?.ok === true && vertical?.applied?.length === 1,
      { ok: vertical?.ok, error: vertical?.error?.code })

    const concentric = await call({ action: 'add', relations: [{ type: 'concentric', refs: ['seg:1', 'seg:2'] }] })
    check('add CONCENTRIC（圆-圆）落地', concentric?.ok === true && concentric?.applied?.length === 1,
      { ok: concentric?.ok, error: concentric?.error?.code })

    const tangent = await call({ action: 'add', relations: [{ type: 'tangent', refs: ['seg:1', 'seg:4'] }] })
    check('add TANGENT（圆-线）落地', tangent?.ok === true && tangent?.applied?.length === 1,
      { ok: tangent?.ok, error: tangent?.error?.code })

    const afterAdds = await list()
    check('回读：4 条关系、类型集合与写入一致',
      afterAdds?.count === 4
      && new Set((afterAdds?.relations ?? []).map((row) => row.type)).size === 4,
      { count: afterAdds?.count, types: (afterAdds?.relations ?? []).map((row) => row.type) })
    check('每次 add 的返回都报出写的是哪张草图/哪个文档（不许含糊）',
      Boolean(horizontal?.sketch && horizontal?.document?.title),
      { sketch: horizontal?.sketch, document: horizontal?.document })

    // ------------------------------------------------------------ remove / clear
    const removed = await call({ action: 'remove', relationIds: [1] })
    check('remove 一条：removed=1、回读少一条',
      removed?.ok === true && removed?.removed?.length === 1,
      { ok: removed?.ok, removed: removed?.removed })
    const afterRemove = await list()
    check('回读：4 -> 3 条', afterRemove?.count === 3, { count: afterRemove?.count })

    const cleared = await call({ action: 'clear', confirm: true })
    check('clear（confirm:true）：剩余 0 条',
      cleared?.ok === true && cleared?.remaining === 0,
      { ok: cleared?.ok, remaining: cleared?.remaining, deleted: cleared?.deleted })
    const afterClear = await list()
    check('回读：0 条', afterClear?.count === 0, { count: afterClear?.count })

    const refusedClear = await call({ action: 'clear' })
    check('clear 不带 confirm：BAD_ARGUMENT，不会误删',
      refusedClear?.ok === false && refusedClear?.error?.code === 'BAD_ARGUMENT',
      refusedClear?.error?.code)

    // ------------------------------------------------------------ 失败必须如实
    const badRef = await call({
      action: 'add',
      relations: [{ type: 'coincident', refs: ['seg:99:start', 'seg:1'] }],
    })
    const badRow = badRef?.error?.detail?.rejected?.[0] ?? {}
    check('不存在的段引用 seg:99：RELATION_REJECTED，且原因写明段数',
      badRef?.ok === false
      && badRef?.error?.code === 'RELATION_REJECTED'
      && /segment 99 does not exist/.test(String(badRow.error ?? '')),
      { code: badRef?.error?.code, why: badRow.error })

    const atomic = await call({
      action: 'add',
      relations: [
        { type: 'horizontal', refs: ['seg:3'] },
        { type: 'coincident', refs: ['seg:99', 'seg:1'] },
      ],
    })
    check('atomic（默认 true）：一条成功一条失败 → RELATION_REJECTED + rolledBack=true',
      atomic?.ok === false
      && atomic?.error?.code === 'RELATION_REJECTED'
      && atomic?.error?.detail?.rolledBack === true,
      { code: atomic?.error?.code, rolledBack: atomic?.error?.detail?.rolledBack })
    const afterAtomic = await list()
    check('atomic 回滚后回读：0 条（成功的那条没有留在草图里）',
      afterAtomic?.count === 0, { count: afterAtomic?.count })

    // COINCIDENT 点-点：这台机器上写不进去，但必须「如实被拒」，不许静默成功。
    const coincident = await call({
      action: 'add',
      relations: [{ type: 'coincident', refs: ['seg:3:start', 'seg:4:start'] }],
    })
    check('点-点 COINCIDENT：要么真落地，要么 RELATION_REJECTED 带原因（不许静默跳过）',
      coincident?.ok === true
        ? coincident?.applied?.length === 1
        : coincident?.error?.code === 'RELATION_REJECTED'
          && Array.isArray(coincident?.error?.detail?.rejected)
          && coincident.error.detail.rejected.length === 1,
      {
        ok: coincident?.ok,
        code: coincident?.error?.code,
        why: coincident?.error?.detail?.rejected?.[0]?.error,
      })

    // ------------------------------------------------------------ 不存在的 designId
    session = openSession({ env: { ...process.env, SW_MCP_DATA: dataDir } })
    await session.start()
    const unknown = await session.tool('inspect', {
      action: 'relations', relationAction: 'list', designId: 'no-such-design-relations-live',
    })
    const unknownCode = unknown?.extra?.error?.code ?? null
    const namesDocument = Boolean(unknown?.changes?.document?.title || unknown?.changes?.document?.path)
    check('不存在的 designId：要么诚实报错，要么明说读的是哪个文档（不许假装是这份设计）',
      (unknown.status === 'failed' && typeof unknownCode === 'string')
      || (unknown.status !== 'failed' && namesDocument),
      { status: unknown.status, code: unknownCode, document: unknown?.changes?.document })
  }
} finally {
  if (session) session.close()
  bridge.close()
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  FAIL  ${failure}`)
  process.exitCode = 1
}
