// 保存/导出路径的守卫、designId 解析、文档身份核对。
//
// 为什么单独一个文件：这三件事都是「在进入桥接器之前」的纯判断，不碰 SOLIDWORKS、
// 不碰 broker，因此可以被 test/ 里的测试直接 import 验行为 —— 以前它们散在
// server.mjs 里，只能靠拉一个完整 MCP 会话去试。
//
// 三条规则对应取证报告里的 F3 / F4 / F6：
//   F3  resolveDesignId 不再回退到进程级 lastDesignId；缺 designId 报 DESIGN_ID_REQUIRED
//   F4  save/export 只能走 deliver，未审批 → GATE_BYPASS_REFUSED；force:"manual" 留痕放行
//   F6  量到的文档标题与 designId 登记的不一致 → WRONG_DOCUMENT
import { appendFileSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { liveDesignIds, readLiveRecord } from './review-live.mjs'

// ------------------------------------------------------------------ F3 designId

/**
 * designId 只认调用方显式给的值。
 *
 * 旧实现是 `given ?? lastDesignId ?? null`：`lastDesignId` 是**进程级全局**，
 * 注释假设「一个 MCP 进程只服务一个会话」—— 实测被打破：a00b4504 里十几次
 * `designId=undefined` 的 build 被解析成上一个会话的 `tee-pipe-v1`，0bb49837 的
 * `bracket-06v1` 量到了 a00b4504 的 `锁盖.SLDPRT`。所以这里不再猜。
 */
export function resolveDesignId(given) {
  if (typeof given === 'string' && given.length > 0) return given
  return null
}

/** 缺 designId 时的错误：带「本进程见过的 designId」让调用方自己挑，而不是让它猜。 */
export function designIdRequired({ dataDir, tool, action, projectIds = [], limit = 20 } = {}) {
  const known = [...new Set([...liveDesignIds({ dataDir, limit }), ...projectIds])].slice(0, limit)
  const error = new Error(
    'DESIGN_ID_REQUIRED: 这次调用必须显式带 designId，不会退回「最近一次用过的设计」。'
      + '省略 designId 是跨会话串台的根因（实测：锁盖被建成 tee-pipe-v1、bracket-06v1 量到锁盖）。'
      + (known.length
        ? `本进程见过的 designId：${known.join(', ')}。用 workspace action="projects" 看完整列表，`
          + '或显式传 designId=<你要的那一个> 重新调用。'
        : '还没有任何设计记录：先 model action=create/build 并显式带 designId。'),
  )
  error.code = 'DESIGN_ID_REQUIRED'
  error.detail = {
    tool: tool ?? null,
    action: action ?? null,
    knownDesignIds: known,
    example: '{"designId":"bracket-06v1", ...}',
  }
  return error
}

// ------------------------------------------------------------------ F4 save 路径

/** 会写文件的 bridge 操作名。 */
export const SAVE_OPS = new Set(['save', 'export'])
/** SOLIDWORKS 里直接存盘的成员名（小写比较；SaveAs2 是旧签名，同一类后门）。 */
export const SAVE_MEMBERS = new Set(['saveas', 'saveas2', 'saveas3', 'saveas4', 'saveassilent', 'savesilent'])

/** 调用是不是「绕过 deliver 的存盘/导出」。是则返回描述，否则 null。
 *
 *  覆盖四条实测出过事的路径：
 *    · job action="submit" op=save/export（096f18c3 用了 5 次）
 *    · model action="invoke" target=doc member=SaveAs4（8d1c3adf）
 *    · model action="invoke" target=extension member=SaveAs（a00b4504）
 *    · task action="run" 里某个 task 的 op=save/export（同一条后门的批量写法）
 */
export function classifySaveCall(toolName, args) {
  if (args === null || typeof args !== 'object') return null
  const tool = String(toolName ?? '')
  if (/(^|__)job$/.test(tool) && args.action === 'submit') {
    const op = String(args.op ?? '')
    if (!SAVE_OPS.has(op)) return null
    return {
      path: 'job.submit',
      op,
      designId: resolveDesignId(args.args?.designId ?? args.designId),
      detail: { op, args: args.args ?? null },
    }
  }
  if (/(^|__)task$/.test(tool) && args.action !== 'validate') {
    const tasks = Array.isArray(args.tasks) ? args.tasks : []
    const hits = tasks
      .filter((task) => SAVE_OPS.has(String(task?.op ?? '')))
      .map((task) => ({ id: task?.id ?? null, op: task.op, designId: resolveDesignId(task?.args?.designId) }))
    if (hits.length === 0) return null
    return {
      path: 'task.run',
      op: hits.map((item) => item.op).join(','),
      // 一个任务图里可能混了多份设计：按第一个带 designId 的任务判，缺的留给调用方补。
      designId: hits.find((item) => typeof item.designId === 'string')?.designId ?? null,
      detail: { tasks: hits },
    }
  }
  if (/(^|__)model$/.test(tool) && args.action === 'invoke') {
    const member = String(args.member ?? '')
    if (!SAVE_MEMBERS.has(member.toLowerCase())) return null
    return {
      path: 'model.invoke',
      op: member,
      designId: resolveDesignId(args.designId),
      detail: { member, target: args.target ?? null },
    }
  }
  if (/(^|__)model$/.test(tool) && args.action === 'batch') {
    const ops = Array.isArray(args.ops) ? args.ops : []
    const saveSteps = []
    for (const [index, step] of ops.entries()) {
      const params = step?.args ?? {}
      // The bridge reads flattened argument keys case-insensitively.
      const fields = new Map(Object.entries(params).map(([key, value]) => [key.toLowerCase(), value]))
      const member = String(fields.get('member') ?? '')
      const reflectiveSave = (step?.op === 'invoke' || (step?.op === 'object' && fields.get('action') === 'call'))
        && SAVE_MEMBERS.has(member.toLowerCase())
      if (!SAVE_OPS.has(step?.op) && !reflectiveSave) continue
      const designId = resolveDesignId(fields.has('designid') ? fields.get('designid') : args.designId)
      saveSteps.push({ index, op: reflectiveSave ? member : step.op, designId })
    }
    if (saveSteps.length === 0) return null
    return {
      path: 'model.batch',
      op: saveSteps.map((step) => step.op).join(','),
      designId: saveSteps[0].designId,
      detail: { steps: saveSteps },
    }
  }
  return null
}

/** 这一版是否已经通过交付门（deliver 成功时由 recordDeliveryApproval 写下）。 */
export function deliveryApproved(record) {
  if (record === null || typeof record !== 'object') return false
  const approved = record.delivery
  if (approved === null || typeof approved !== 'object') return false
  const revision = Number.isFinite(record.revision) ? record.revision : null
  return revision !== null && approved.approvedAtRevision === revision
}

/** GATE_BYPASS_REFUSED：没通过交付门就想 save/export。 */
export function gateBypassRefused({ designId, call, record }) {
  const revision = Number.isFinite(record?.revision) ? record.revision : null
  const approvedAt = Number.isFinite(record?.delivery?.approvedAtRevision)
    ? record.delivery.approvedAtRevision
    : null
  const error = new Error(
    `GATE_BYPASS_REFUSED: 只有 deliver 能写文件。${call.op}（${call.path}）是绕门路径：`
      + `designId=${designId ?? '(未给)'}，当前 revision ${revision ?? '(未知)'}，`
      + `最近一次通过的交付审查是 ${approvedAt ?? '无'}。`
      + ' 正常做法：先用 inspect action="review" 看这一单审到哪一步（它只回放不审），'
      + '然后先 capture 一张模型图，再 deliver（交付检查会在那一刻核对这一版（不调用模型））；'
      + ' 交付通过后再导出需要别的格式。确实要救场（门禁本身坏了）就在这次调用里加 '
      + 'force:"manual"，并在汇报里写明为什么，这一笔会记进 review/bypass.jsonl。',
  )
  error.code = 'GATE_BYPASS_REFUSED'
  error.detail = {
    designId: designId ?? null,
    path: call.path,
    op: call.op,
    revision,
    deliveryApprovedAtRevision: approvedAt,
    escape: 'force:"manual"',
    bypassLog: 'review/bypass.jsonl',
  }
  return error
}

/** 绕门留痕：一行 JSONL，含时间、designId、op、调用者 clientId、原因。 */
export function appendBypass({ dataDir, designId, op, clientId, reason, tool, detail }) {
  try {
    mkdirSync(join(dataDir, 'review'), { recursive: true })
    const line = JSON.stringify({
      at: new Date().toISOString(),
      designId: designId ?? null,
      op: op ?? null,
      tool: tool ?? null,
      clientId: clientId ?? null,
      reason: typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : '(未说明)',
      ...(detail && typeof detail === 'object' ? { detail } : {}),
    })
    appendFileSync(join(dataDir, 'review', 'bypass.jsonl'), `${line}\n`, 'utf8')
    return line
  } catch {
    // 留痕失败不能反过来挡住调用本身。
    return null
  }
}

/**
 * 进入工具之前的统一判定：这次 save/export 允许吗？
 *
 * 返回 { ok:true, bypassed } 或 { ok:false, error }（error.code 是 DESIGN_ID_REQUIRED /
 * GATE_BYPASS_REFUSED）。force:"manual" 永远放行，但先写一行留痕。
 */
export function checkSavePath({ dataDir, clientId, toolName, args }) {
  const call = classifySaveCall(toolName, args)
  if (call === null) return { ok: true, bypassed: false }
  const designIds = call.path === 'model.batch'
    ? [...new Set(call.detail.steps.map((step) => step.designId))]
    : [call.designId]
  if (designIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    return { ok: false, error: designIdRequired({ dataDir, tool: toolName, action: call.path, projectIds: [] }) }
  }
  const unapproved = []
  for (const designId of designIds) {
    const record = readLiveRecord({ dataDir, designId })
    if (!deliveryApproved(record)) unapproved.push({ designId, record })
  }
  if (unapproved.length === 0) return { ok: true, bypassed: false }
  const first = unapproved[0]
  if (args.force !== 'manual') {
    return { ok: false, error: gateBypassRefused({ ...first, call }), call, designId: first.designId }
  }
  const logs = unapproved.map(({ designId, record }) => appendBypass({
    dataDir,
    designId,
    op: call.op,
    clientId,
    reason: args.reason,
    tool: `${toolName}:${call.path}`,
    detail: { revision: record?.revision ?? null, delivery: record?.delivery ?? null },
  }))
  return { ok: true, bypassed: true, designId: first.designId, op: call.op, log: logs[0] }
}

// ------------------------------------------------------------------ F6 文档身份

/** 未存盘文档的通用名字：零件1 / 零件 12 / Part3 / Untitled。 */
const GENERIC_TITLE = /^(零件|部件|装配体|工程图|part|assembly|drawing|untitled|未命名|新建)[\s_-]*\d*$/i

/** 标题归一：去目录、去扩展名、小写、去空白。 */
export function normalizeTitle(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return null
  const base = basename(text)
  const stem = base.toLowerCase().endsWith(extname(base).toLowerCase()) && extname(base).length > 0
    ? base.slice(0, base.length - extname(base).length)
    : base
  return stem.toLowerCase().replace(/\s+/g, '')
}

export function isGenericTitle(value) {
  const normalized = normalizeTitle(value)
  if (normalized === null) return true
  return GENERIC_TITLE.test(normalized.replace(/\s+/g, ''))
}

/**
 * 文档身份核对：这次量到的是不是 designId 登记的那一份。
 *
 * 判定（保守，避免把「deliver 之后 SaveAs 改了名」误报）：
 *   · 没有期望标题（还没登记）→ 放过（调用方会把这次学进去）
 *   · 期望或实际是「零件N」这类未存盘通名 → 放过（改名窗口期的正常情况）
 *   · 归一后相等 → 放过
 *   · 否则 → WRONG_DOCUMENT（detail 里给两个标题与 designId）
 */
export function checkDocumentIdentity({ designId, expectedTitles, actualTitle }) {
  const actual = normalizeTitle(actualTitle)
  if (actual === null) return { ok: true, reason: 'NO_ACTUAL_TITLE' }
  const expected = (Array.isArray(expectedTitles) ? expectedTitles : [expectedTitles])
    .map((item) => normalizeTitle(item))
    .filter((item) => item !== null)
  if (expected.length === 0) return { ok: true, reason: 'NO_EXPECTATION' }
  if (expected.includes(actual)) return { ok: true, reason: 'MATCH' }
  if (isGenericTitle(actual)) return { ok: true, reason: 'ACTUAL_GENERIC' }
  if (expected.every((item) => isGenericTitle(item))) return { ok: true, reason: 'EXPECTATION_GENERIC' }
  const error = new Error(
    `WRONG_DOCUMENT: designId=${designId ?? '(未给)'} 登记的是「${expectedTitles?.find?.(Boolean) ?? expectedTitles}」，`
      + `当前量的却是「${actualTitle}」。这些数字量的是另一个零件，不能拿去验收。`
      + ` 先 workspace action="status" 确认打开的文档，再用 workspace action="cleanup" 收掉多出来的文档，`
      + `然后显式传这次真正要量的 designId=<实际标题或登记名>。`,
  )
  error.code = 'WRONG_DOCUMENT'
  error.detail = {
    designId: designId ?? null,
    expectedTitle: Array.isArray(expectedTitles) ? expectedTitles[0] ?? null : expectedTitles,
    expectedTitles: Array.isArray(expectedTitles) ? expectedTitles : [expectedTitles],
    actualTitle: actualTitle ?? null,
  }
  return { ok: false, error }
}
