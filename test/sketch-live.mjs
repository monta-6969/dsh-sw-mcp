// 仅草图构建的真机验收：本文件需要一台正在运行的 SOLIDWORKS（没起就打印 SKIP）。
//
// 三步，一条比一条更靠真机：
//   1. `model action=plan` 对「直线 + 圆弧 + 重合关系」的闭合轮廓说 ready=true ——
//      这一步是纯 Node 判定，证明计划侧接受这份定义；
//   2. `model action=build output=sketch precision=relations` 的返回形状：闭合、
//      relationAudit 落在哪一层、gaps/rejected 的真实层级、以及回读的关系数；
//   3. 失败必须如实 + 回滚：写不进去的关系要回 RELATION_APPLY_FAILED，半成品草图
//      要被删掉，不能留一张「看着像建成了」的草图。
//
// 实测记要（2026-11-13，SOLIDWORKS 2026 SP3.2，bridge 0.4.1）：
//   · 内置几何工具（矩形）建出来的草图自带 19 条原生关系：closed=true、审计
//     gaps=[] —— 仅草图门禁端到端通过；
//   · 用 curves 手工画的「端点坐标相同」轮廓拿不到重合关系：点-点 COINCIDENT 在
//     这台机器上写不进去（AddRelation 抛 COM 0x80010105；选中两点后
//     SketchAddConstraints("sgCOINCIDENT") 也一条都加不出来），所以那份定义会在
//     build 时如实报 RELATION_APPLY_FAILED 并回滚。这一条现在按「必须如实失败」断言，
//     等关系写入修好后改成「必须建成」。
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

const arcPoint = (center, radius, deg) => [
  Number((center[0] + radius * Math.cos((deg * Math.PI) / 180)).toFixed(6)),
  Number((center[1] + radius * Math.sin((deg * Math.PI) / 180)).toFixed(6)),
]
const arc = (id, center, radius, startAngle, endAngle) => ({
  id,
  kind: 'arc',
  params: {
    center, radius, startAngle, endAngle,
    start: arcPoint(center, radius, startAngle),
    end: arcPoint(center, radius, endAngle),
  },
})
const line = (id, start, end) => ({ id, kind: 'line', params: { start, end } })

/**
 * 跑道形闭合轮廓：两条直线 + 两个半圆弧，四个角各一条重合关系（curve id 引用）。
 * 这正是「直线 + 圆弧 + center + 重合」该有的样子。
 */
const STADIUM = {
  designId: 'sketch-live-stadium',
  features: [{
    kind: 'sketch',
    id: 's1',
    plane: 1,
    curves: [
      line('l1', [0, 0], [60, 0]),
      arc('a1', [60, 10], 10, -90, 90),
      line('l2', [60, 20], [0, 20]),
      arc('a2', [0, 10], 10, 90, 270),
    ],
    relations: [
      { type: 'coincident', refs: ['l1:start', 'a2:end'] },
      { type: 'coincident', refs: ['l1:end', 'a1:start'] },
      { type: 'coincident', refs: ['a1:end', 'l2:start'] },
      { type: 'coincident', refs: ['l2:end', 'a2:start'] },
    ],
  }],
}

/** 只用内置矩形工具：闭合轮廓 + 原生关系（这台机器上唯一能过仅草图门禁的形状）。 */
const RECT = {
  designId: 'sketch-live-rect',
  features: [{
    kind: 'sketch',
    id: 'plate',
    plane: 1,
    primitives: [{ shape: 'rect', center: [0, 0], width: 60, height: 40 }],
  }],
}

const bridge = bridgeSession()
const work = mkdtempSync(join(tmpdir(), 'sw-mcp-sketch-live-'))
const dataDir = join(work, 'data')
mkdirSync(dataDir, { recursive: true })
let session = null
try {
  const status = await bridge.call({ op: 'status' })
  if (status?.ready !== true) {
    console.log(`SKIP  SOLIDWORKS 没在运行（status reason=${status?.reason ?? 'unknown'}）；` +
      ' 先起 SOLIDWORKS 再跑这个文件')
    process.exitCode = 0
  } else {
    session = openSession({ env: { ...process.env, SW_MCP_DATA: dataDir } })
    await session.start()

    // ------------------------------------------------- 1) plan：计划侧接受这份定位
    const planned = await session.tool('model', { action: 'plan', definition: STADIUM })
    check('plan：直线 + 圆弧 + 4 条重合的闭合轮廓 ready=true、无阻断项',
      planned.status === 'ok' && planned.changes?.ready === true
      && (planned.changes?.plan?.blockers ?? []).length === 0,
      { status: planned.status, ready: planned.changes?.ready, blockers: planned.changes?.plan?.blockers })

    // ------------------------------------------------- 2) 真机 build：矩形草图
    const rectBuild = await session.tool('model', {
      action: 'build', output: 'sketch', precision: 'relations', definition: RECT,
    })
    const rectSketch = rectBuild.changes?.sketch ?? {}
    check('build output=sketch（内置矩形）：status=ok，summary 报出段数与关系数',
      rectBuild.status === 'ok' && /关系/.test(String(rectBuild.summary ?? '')),
      { status: rectBuild.status, summary: rectBuild.summary, error: rectBuild.extra?.error?.code })
    check('返回 changes.sketch.closed=true、openEnds=0',
      rectSketch.closed === true && rectSketch.openEnds === 0,
      { closed: rectSketch.closed, openEnds: rectSketch.openEnds })
    check('返回 changes.sketch.relationCount≥10（内置矩形自带原生关系）',
      Number(rectSketch.relationCount ?? 0) >= 10, { relationCount: rectSketch.relationCount })

    // 字段层级：relationAudit 在顶层和 sketch 里各有一份（同一个对象），gaps 在
    // relationAudit.gaps；rejected 不在这份审计里，它是 build 顶层的数组。
    const topAudit = rectBuild.changes?.relationAudit
    const nestedAudit = rectSketch.relationAudit
    check('relationAudit 同时落在 changes.relationAudit 与 changes.sketch.relationAudit（同一份）',
      topAudit !== undefined && nestedAudit !== undefined
      && JSON.stringify(topAudit) === JSON.stringify(nestedAudit),
      { topKeys: topAudit && Object.keys(topAudit), nestedKeys: nestedAudit && Object.keys(nestedAudit) })
    check('关系审计真实形状：gaps 为空数组、evaluated/requiredCount 是数字',
      Array.isArray(topAudit?.gaps) && topAudit.gaps.length === 0
      && Number.isFinite(Number(topAudit?.requiredCount)),
      {
        gaps: topAudit?.gaps,
        gapCount: topAudit?.gapCount,
        requiredCount: topAudit?.requiredCount,
        evaluated: topAudit?.evaluated,
      })
    check('changes.rejected 是数组（顶层拒绝行），审计本身没有 rejected 字段',
      Array.isArray(rectBuild.changes?.rejected) && rectBuild.changes.rejected.length === 0
      && topAudit?.rejected === undefined,
      { rejected: rectBuild.changes?.rejected, auditRejected: topAudit?.rejected })

    // ------------------------------------------------- 回读：关系数与定义一致
    const readBack = await session.tool('inspect', {
      action: 'relations', relationAction: 'list', designId: RECT.designId,
    })
    check('inspect action=relations list：回读条数 == build 返回的 relationCount',
      readBack.status === 'ok'
      && readBack.changes?.count === rectSketch.relationCount,
      { listCount: readBack.changes?.count, buildCount: rectSketch.relationCount })
    // 两边都 undefined 也相等 —— 那不叫一致，叫都没验到。先要求两边是 number。
    const listStatus = readBack.changes?.constrainedStatus
    const buildStatus = rectSketch.constrainedStatus
    check('回读的约束状态与 build 报的一致',
      typeof listStatus === 'number' && typeof buildStatus === 'number' && listStatus === buildStatus,
      { listStatus, buildStatus })

    // ------------------------------------------------- 3) 带重合关系的轮廓：如实失败
    // 先清掉矩形那个文档：失败回滚会把 stadium 的文档也关掉，留一个活动文档在
    // 场时，按 designId 回读会静默落到「当前活动文档」上，回滚就看不出来了。
    await bridge.call({ op: 'cleanup' })
    const stadiumBuild = await session.tool('model', {
      action: 'build', output: 'sketch', precision: 'relations', definition: STADIUM,
    })
    const stadiumCode = stadiumBuild.extra?.error?.code ?? stadiumBuild.error?.code ?? null
    const stadiumRejected = stadiumBuild.extra?.error?.detail?.rejected?.[0] ?? {}
    check('点-点重合写不进去时：RELATION_APPLY_FAILED 如实报错（不假装建成）',
      stadiumBuild.status === 'failed' && stadiumCode === 'RELATION_APPLY_FAILED',
      { code: stadiumCode, why: stadiumRejected.error })
    check('失败路径写明是哪条关系、哪两个引用',
      stadiumRejected.type === 'coincident' && Array.isArray(stadiumRejected.refs)
      && stadiumRejected.refs.length === 2,
      { type: stadiumRejected.type, refs: stadiumRejected.refs })

    // ------------------------------------------------- 4) 回滚：半成品草图不留着
    // 失败后桥接器会删掉半成品草图并关掉那个文档；registry 里这份 designId 也被
    // 忘掉，所以这里不能再用 designId 回读（那会落到「当前活动文档」上），要看
    // 错误 detail 里的 notes。
    const rollbackNotes = stadiumBuild.extra?.error?.detail?.notes ?? []
    check('失败后回滚：半成品草图被删除（notes 有删除记录）',
      rollbackNotes.some((note) => /deleted the failed sketch feature/.test(String(note))),
      { notes: rollbackNotes })
    const afterRollback = await bridge.call({
      op: 'relations', action: 'list', designId: STADIUM.designId,
    })
    check('失败后回滚：designId 回读不再给出草图（没有文档/没有草图，而不是一份半成品）',
      afterRollback?.ok === false
      && /^(NO_ACTIVE_DOC|NO_SKETCH|NO_DOCUMENT|DOC_NOT_OPEN)$/.test(String(afterRollback?.error?.code)),
      {
        ok: afterRollback?.ok,
        code: afterRollback?.error?.code,
        count: afterRollback?.count,
        document: afterRollback?.document,
      })

    // ------------------------------------------------- 5) builder 内联关系失败 + 回滚
    // 走桥接器直连：这条路径要验的是「关系应用失败 → 删掉半成品草图」，
    // 而 model build 会在碰 SOLIDWORKS 之前先用 plan 门禁挡一批定义。
    const inlineFail = await bridge.call({
      op: 'build',
      definition: {
        designId: `sketch-live-inline-fail-${Date.now()}`,
        output: 'sketch',
        sketch: {
          id: 's1',
          plane: 1,
          curves: [
            line('l1', [0, 0], [60, 0]),
            line('l2', [60, 0], [60, 40]),
          ],
          relations: [{ type: 'tangent', refs: ['l1', 'l2'] }],
        },
      },
    })
    const inlineDetail = inlineFail?.error?.detail ?? {}
    check('builder 内联关系应用失败：RELATION_APPLY_FAILED，且写明应用失败原因',
      inlineFail?.ok === false && inlineFail?.error?.code === 'RELATION_APPLY_FAILED'
      && /could not be applied/.test(String(inlineFail?.error?.message ?? '')),
      { code: inlineFail?.error?.code, message: inlineFail?.error?.message })
    check('失败后草图被回滚删除（notes 里有删除记录或没有草图留下）',
      (inlineDetail.notes ?? []).some((note) => /deleted the failed sketch feature/.test(String(note)))
      || inlineDetail.sketch === undefined,
      { notes: inlineDetail.notes })
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
