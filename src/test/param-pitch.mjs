// SW-PARAM-B1 回归：只读门 + 两孔中心距原生驱动尺寸 + edit + 重开 + 无效参数 + 无绑定 edit。
//
// 覆盖：
//   P0 只读通道（SW_MCP_TOOLS=inspect,constraints）写子动作必须回 READ_ONLY_TOOLSET，list 放行
//   P1 内联 sketch.dimensions（两条 Ø42 + 一条 hole.pitch=60）→ 3 条驱动尺寸、
//      dimensionBindings["hole.pitch"]、edit 60→62 走 mode="dimension" 且孔距真的 62
//   P2 holes sugar 两孔（centres 用 -hole.pitch/2 表达式）→ 同样绑定 + edit 62
//   P3 参数在 params 里但不影响几何 → edit 必须回 EDIT_NOT_BOUND，不再假 ok
//   额外：无效参数 UNKNOWN_PARAM 且几何不动；保存/关闭/重开后孔距仍是 62
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// D4：收尾全部带上限。最后一条断言之后卡在 finally 的 cleanup 上（592 s / 307 s）
// 曾让「31 passed」落不成 exit 0；现在 cleanup/session.close 超时只打印
// CLEANUP_TIMEOUT，进程一律按断言结果退出。
import {
  CLEANUP_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS,
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

function pitchOf(sketch) {
  const circles = (sketch?.changes?.segments ?? []).filter((s) => s.kind === 'circle')
  const centres = circles.map((s) => s.center).filter(Array.isArray)
  if (centres.length !== 2) return null
  return Math.abs(centres[0][1] - centres[1][1])
}

const dir = mkdtempSync(join(tmpdir(), 'sw-param-pitch-'))
const session = openSession({
  env: { ...process.env, SW_MCP_DATA: dir, SW_MCP_BROKER: '1', SW_MCP_BROKER_ENSURE: '1', SW_MCP_ALLOW_ACTIVE_OBJECT: '1' },
})
let startedHere = false
try {
  // ── P0 只读门（不碰 SOLIDWORKS）─────────────────────────────────────────
  {
    const ro = openSession({ env: { ...process.env, SW_MCP_TOOLS: 'inspect,constraints' } })
    try {
      await ro.start()
      const write = await ro.tool('constraints', {
        action: 'dimensions', designId: 'p0-readonly-gate', sketch: 'holes', dimensionAction: 'add',
        dimensions: [{ kind: 'distance', refs: ['seg:1', 'seg:2'], valueMm: 60 }],
      })
      check('P0 只读通道拒写子动作（READ_ONLY_TOOLSET）',
        write.status === 'failed' && write.extra?.error?.code === 'READ_ONLY_TOOLSET',
        write.extra?.error?.code ?? write.summary)
      const list = await ro.tool('constraints', {
        action: 'dimensions', designId: 'p0-readonly-gate', sketch: 'holes', dimensionAction: 'list',
      })
      check('P0 只读通道 list 未被只读门拦下',
        list.extra?.error?.code !== 'READ_ONLY_TOOLSET',
        list.extra?.error?.code ?? list.summary)
    } finally {
      try { ro.close() } catch { }
    }
  }

  await session.start()
  const sw = await ensureSolidworks(session.tool)
  startedHere = sw.startedHere
  check('SOLIDWORKS 可用', sw.reason === 'ready', sw.reason)
  await session.tool('workspace_ops', { action: 'cleanup' })

  // ── P1 内联 sketch.dimensions，两孔中心距 ────────────────────────────────
  const p1Id = `param-pitch-${Date.now()}`
  const p1Path = join(dir, 'param-pitch.SLDPRT')
  const p1 = await session.tool('model', {
    action: 'build',
    definition: {
      schemaVersion: 3,
      designId: p1Id,
      params: { 'plate.w': 60, 'plate.h': 120, 'plate.t': 6, 'hole.d': 42, 'hole.pitch': 60 },
      features: [
        {
          kind: 'sketch', id: 'outline', plane: 1,
          primitives: [{ shape: 'rect', center: [0, 0], width: 'plate.w', height: 'plate.h', bind: { width: 'plate.w', height: 'plate.h' } }],
        },
        { kind: 'extrude', id: 'body', profile: 'outline', depth: 'plate.t', direction: '+Y', bind: { depth: 'plate.t' } },
        {
          kind: 'sketch', id: 'holes', plane: 1,
          curves: [
            { kind: 'circle', id: 'h1', params: { center: [0, '-hole.pitch/2'], diameter: 'hole.d' } },
            { kind: 'circle', id: 'h2', params: { center: [0, 'hole.pitch/2'], diameter: 'hole.d' } },
          ],
          dimensions: [
            { kind: 'diameter', refs: ['h1'], valueMm: 42, name: 'hole.d' },
            { kind: 'diameter', refs: ['h2'], valueMm: 42, name: 'hole.d' },
            { kind: 'distance', refs: ['h1:center', 'h2:center'], valueMm: 60, name: 'hole.pitch' },
          ],
        },
        { kind: 'cut', id: 'through', profile: 'holes', throughAll: true },
      ],
    },
  })
  check('P1 两孔内联尺寸件建成', p1.status === 'ok', p1.summary)
  check('P1 dimensionBindings 含 hole.pitch', Boolean(p1.changes?.dimensionBindings?.['hole.pitch']),
    p1.changes?.dimensionBindings)

  const dims = await session.tool('constraints', {
    action: 'dimensions', designId: p1Id, sketch: 'holes', dimensionAction: 'list',
  })
  const rows = dims.changes?.dimensions ?? []
  check('P1 尺寸 ≥3 且全是驱动尺寸',
    rows.length >= 3 && (dims.changes?.driving ?? 0) >= 3 && (dims.changes?.reference ?? 0) === 0,
    { count: rows.length, driving: dims.changes?.driving, reference: dims.changes?.reference })
  check('P1 三条名字是 hole.d / hole.d / hole.pitch',
    rows.filter((r) => r.name === 'hole.d').length === 2 && rows.some((r) => r.name === 'hole.pitch'),
    rows.map((r) => ({ name: r.name, kind: r.kind, valueMm: r.valueMm })))

  const edit1 = await session.tool('model', { action: 'edit', designId: p1Id, changes: { 'hole.pitch': 62 } })
  check('P1 edit 60→62 成功', edit1.status === 'ok', edit1.summary)
  check('P1 edit 走 mode="dimension"', edit1.changes?.mode === 'dimension', edit1.changes?.mode)
  const driven1 = (edit1.changes?.driven ?? []).find((entry) => entry.param === 'hole.pitch')
  check('P1 driven hole.pitch bound=true', Boolean(driven1?.bound), driven1)

  const sketch1 = await session.tool('inspect', { action: 'sketch', designId: p1Id, sketch: 'holes' })
  check('P1 孔距实际 62', Math.abs((pitchOf(sketch1) ?? 0) - 62) < 0.02, pitchOf(sketch1))

  // 无效参数：拒绝且几何不动
  const invalid = await session.tool('model', { action: 'edit', designId: p1Id, changes: { 'plate.widht': 70 } })
  check('无效参数回 UNKNOWN_PARAM', invalid.status === 'failed' && invalid.extra?.error?.code === 'UNKNOWN_PARAM',
    invalid.extra?.error?.code ?? invalid.status)
  const afterInvalid = await session.tool('inspect', { action: 'sketch', designId: p1Id, sketch: 'holes' })
  check('无效参数后孔距仍是 62', Math.abs((pitchOf(afterInvalid) ?? 0) - 62) < 0.02, pitchOf(afterInvalid))

  // 保存 / 关闭 / 重开再读：孔距仍是 62
  const saved = await session.tool('deliver', { designId: p1Id, kind: 'sldprt', path: p1Path })
  check('P1 保存成功', saved.status === 'ok', saved.summary)
  // 真退出 SOLIDWORKS 再重开：文件锁与旧尺寸全名都随进程消失，这才是「重开」。
  await session.tool('workspace_ops', { action: 'quit' })
  await new Promise((resolve) => setTimeout(resolve, 5000))
  await session.tool('workspace_ops', { action: 'reload' })
  const again = await ensureSolidworks(session.tool)
  if (again.startedHere) startedHere = true
  const opened = await session.tool('workspace', { action: 'open', path: p1Path })
  check('P1 重开成功', opened.status === 'ok', opened.summary)
  const reopened = await session.tool('inspect', { action: 'sketch', designId: p1Id, sketch: 'holes' })
  check('重开后孔距仍是 62', Math.abs((pitchOf(reopened) ?? 0) - 62) < 0.02, pitchOf(reopened))
  const dimsReopen = await session.tool('constraints', {
    action: 'dimensions', designId: p1Id, sketch: 'holes', dimensionAction: 'list',
  })
  check('重开后尺寸仍 ≥1 条驱动',
    (dimsReopen.changes?.dimensions ?? []).length >= 1 && (dimsReopen.changes?.reference ?? 0) === 0,
    { count: (dimsReopen.changes?.dimensions ?? []).length, reference: dimsReopen.changes?.reference })

  // ── P4 dimensions.remove：解绑后删，逐目标回报 ──────────────────────────
  // 放在 P1 edit / 重开之后：remove 会删掉 hole.pitch 这条原生尺寸，先删再 edit
  // 等于把「edit 走尺寸」的测试对象自己拆了（上一轮 P1 失败就是这么来的）。
  const del = await session.tool('constraints', {
    action: 'dimensions', designId: p1Id, sketch: 'holes', dimensionAction: 'remove', relationIds: [1, 2],
  })
  console.log('P4 remove#1 返回体: ' + JSON.stringify(del.changes ?? del))
  check('P4 一次删 2 条全部成功',
    del.status === 'ok' && (del.changes?.removed ?? []).length === 2,
    { status: del.status, removed: del.changes?.removed?.length, unbound: del.changes?.unbound })
  check('P4 remove 回包带 unbound[]（解绑项）', Array.isArray(del.changes?.unbound),
    del.changes?.unbound)

  // 第二个用例必须是「可删的 1 条 + 一个越界索引」：上一轮用 [1,2] 在只剩 2 条的
  // 列表里删，两条都合法，根本测不到部分失败。99 一定越界，失败原因要全文打出来。
  const partial = await session.tool('constraints', {
    action: 'dimensions', designId: p1Id, sketch: 'holes', dimensionAction: 'remove', relationIds: [1, 99],
  })
  console.log('P4 remove#2 返回体: ' + JSON.stringify(partial.changes ?? partial))
  for (const row of partial.changes?.failures ?? []) {
    console.log('P4 failures[].reason 全文: ' + row.reason)
    if (Array.isArray(row.notes) && row.notes.length > 0) console.log('P4 failures[].notes: ' + JSON.stringify(row.notes))
  }
  check('P4 部分失败时 status=failed 且 removed/failures 同时回',
    partial.status === 'failed'
      && (partial.changes?.failures ?? []).length === 1
      && (partial.changes?.removed ?? []).length === 1,
    { status: partial.status, removed: partial.changes?.removed?.length, failures: partial.changes?.failures })
  check('P4 nextActions 指到失败目标',
    (partial.nextActions ?? []).some((a) => /failures|没删掉/.test(a)), partial.nextActions)

  // ── P2 holes sugar 两孔 ─────────────────────────────────────────────────
  const p2Id = `param-sugar-${Date.now()}`
  const p2 = await session.tool('model', {
    action: 'build',
    definition: {
      schemaVersion: 3,
      designId: p2Id,
      params: { 'plate.w': 60, 'plate.h': 120, 'plate.t': 6, 'hole.d': 42, 'hole.pitch': 60 },
      features: [
        {
          kind: 'sketch', id: 'outline', plane: 1,
          primitives: [{ shape: 'rect', center: [0, 0], width: 'plate.w', height: 'plate.h', bind: { width: 'plate.w', height: 'plate.h' } }],
        },
        { kind: 'extrude', id: 'body', profile: 'outline', depth: 'plate.t', direction: '+Y', bind: { depth: 'plate.t' } },
        {
          kind: 'holes', id: 'holes', diameter: 'hole.d', throughAll: true,
          centres: [{ x: 0, y: '-hole.pitch/2' }, { x: 0, y: 'hole.pitch/2' }],
        },
      ],
    },
  })
  check('P2 holes sugar 两孔建成', p2.status === 'ok', { summary: p2.summary, code: p2.extra?.error?.code })
  check('P2 dimensionBindings 含 hole.pitch', Boolean(p2.changes?.dimensionBindings?.['hole.pitch']),
    p2.changes?.dimensionBindings)
  if (p2.status === 'ok') {
    const edit2 = await session.tool('model', { action: 'edit', designId: p2Id, changes: { 'hole.pitch': 62 } })
    check('P2 edit 60→62 成功', edit2.status === 'ok', edit2.summary)
    check('P2 edit 走 mode="dimension"', edit2.changes?.mode === 'dimension', edit2.changes?.mode)
    const sketch2 = await session.tool('inspect', { action: 'sketch', designId: p2Id })
    check('P2 孔距实际 62', Math.abs((pitchOf(sketch2) ?? 0) - 62) < 0.02, pitchOf(sketch2))
  }

  // ── P3 参数在定义里但不影响几何 → EDIT_NOT_BOUND ────────────────────────
  const p3Id = `param-unbound-${Date.now()}`
  const p3 = await session.tool('model', {
    action: 'build',
    definition: {
      schemaVersion: 3,
      designId: p3Id,
      params: { 'plate.w': 40, 'plate.h': 30, 'plate.t': 5, 'unused.d': 10 },
      features: [
        {
          kind: 'sketch', id: 'outline', plane: 1,
          primitives: [{ shape: 'rect', center: [0, 0], width: 'plate.w', height: 'plate.h' }],
        },
        { kind: 'extrude', id: 'body', profile: 'outline', depth: 'plate.t', direction: '+Y' },
      ],
    },
  })
  check('P3 未使用参数的设计建成', p3.status === 'ok', p3.summary)
  const unbound = await session.tool('model', { action: 'edit', designId: p3Id, changes: { 'unused.d': 12 } })
  check('P3 无绑定且几何没变 → status failed', unbound.status === 'failed', unbound.status)
  check('P3 错误码 EDIT_NOT_BOUND', unbound.extra?.error?.code === 'EDIT_NOT_BOUND', unbound.extra?.error?.code)
  check('P3 detail 带 geometryChanged:false 与 mode',
    unbound.extra?.error?.detail?.geometryChanged === false && Boolean(unbound.extra?.error?.detail?.mode),
    unbound.extra?.error?.detail)
  check('P3 带 nextActions', Array.isArray(unbound.nextActions) && unbound.nextActions.length > 0,
    unbound.nextActions)
} catch (error) {
  check('测试过程没有抛异常', false, String(error?.stack ?? error).split('\n').slice(0, 4).join(' | '))
} finally {
  // 收尾：cleanup 30s、session.close 10s、shutdownSolidworks 25s（可用
  // SW_CLEANUP_TIMEOUT_MS / SW_CLOSE_TIMEOUT_MS / SW_SHUTDOWN_TIMEOUT_MS 覆盖）。
  // 任何一步超时都只打印 CLEANUP_TIMEOUT，**不改变断言结论**。
  await cleanupWorkspace(session)
  closeSessionHard(session)
  try {
    await withTimeout(shutdownSolidworks(session.tool, startedHere), SHUTDOWN_TIMEOUT_MS, 'shutdownSolidworks')
  } catch { /* owned 实例已登记在 instances.json，交给 broker reap 兜底 */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
console.log(`CLEANUP_BUDGET cleanup=${CLEANUP_TIMEOUT_MS}ms close=${CLOSE_TIMEOUT_MS}ms shutdown=${SHUTDOWN_TIMEOUT_MS}ms`)
if (failures.length > 0) {
  console.log(`FAIL: ${failures.join('; ')}`)
  exitProcessByResult(failures, 1)
}
exitProcessByResult(failures, 0)




