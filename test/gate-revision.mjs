// F1 / F2 / F3 的回归：门禁的 revision 口径、关系审计的落账版本、designId 不许猜。
//
// 取证背景（lessons-4sessions.md 四·F1–F3）：
//   · review-gate 判 `audit.revision < state.revision`，但 `inspect action="relations"`
//     落账不传 revision，只能回退成 live 里的旧值；而 state.revision 是 agent 级单调
//     累加、换 designId 不清零 → 四个会话共撞 40 次 RELATIONS_INCOMPLETE，门禁提示
//     「重新 inspect relations」实测只把审计挪一格（4→5、6→7→8），永远追不上 10/18/21。
//   · `resolveDesignId` 回退进程级 lastDesignId → 跨会话串台（锁盖被建成 tee-pipe-v1）。
//
// 这里用假 ctx + 假 callBridge，不依赖 DSH、不依赖 SOLIDWORKS、不依赖 broker。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../review-gate.js'
import { bumpRevision, recordDeliveryApproval, readLiveRecord } from '../server/review-live.mjs'
import { designIdRequired, resolveDesignId } from '../server/review-guard.mjs'
import { registerObserveTools } from '../server/tools-observe.mjs'
import z from 'zod'

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) passed += 1
  else failures.push(name)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) {
    console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
}

const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
  '0d0a2db40000000049454e44ae426082', 'hex')
const dir = mkdtempSync(join(tmpdir(), 'sw-gate-revision-'))
const image = join(dir, 'shot-01.png')
writeFileSync(image, PNG_1x1)
process.env.SW_MCP_DATA = mkdtempSync(join(tmpdir(), 'sw-gate-revision-data-'))

// ── 与 test/review-gate.mjs 同款的最小 ctx 脚手架 ───────────────────────
function makeContext({ structured = { verdict: 'passed', confidence: 0.9, differences: [] } } = {}) {
  const handlers = new Map()
  const warnings = []
  const subagents = {
    calls: [],
    async startActivation(spec) {
      this.calls.push(spec)
      return { childId: `c-${this.calls.length}`, result: Promise.resolve({ structured, stopReason: 'stop' }), dispose: async () => {} }
    },
  }
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const ctx = {
    logger: { warn: (m) => warnings.push(m), info: () => {} },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    get(service) {
      if (service === 'subagents') return subagents
      if (service === 'attachments') return attachments
      return undefined
    },
    async fire(event, payload, fallback) {
      const list = handlers.get(event) ?? []
      if (event === 'tools/execute' || event === 'tools/pre-execute') {
        for (const handler of list) return handler(payload, fallback)
        return fallback()
      }
      for (const handler of list) handler(payload)
      return undefined
    },
  }
  return { ctx, warnings, subagents }
}

const deliver = (ctx, sid, args = {}) =>
  ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', args, sid), async () => ({ kind: 'allow' }))
const execOf = (name, args = {}, sid = 's1') => ({ name, arguments: args, agent: { id: sid, session: { id: sid } }, signal: undefined })
const okEnvelope = (extra = {}) => ({ content: [{ type: 'text', text: JSON.stringify({ status: 'ok', ...extra }) }] })
let scenario = 0
const newScenario = () => { scenario += 1; return `s${scenario}` }

/** 造一条 live 记录：revision + 关系审计 + 一张「这一版」的图。 */
function writeDesign({ designId, revision, auditRevision, image: imagePath = image, withAudit = true }) {
  const dataDir = process.env.SW_MCP_DATA
  mkdirSync(join(dataDir, 'review'), { recursive: true })
  const file = join(dataDir, 'review', 'live.json')
  let store = { version: 1, designs: {} }
  try { store = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  store.designs[designId] = {
    designId,
    revision,
    updatedAt: new Date().toISOString(),
    ...(imagePath ? { images: [{ path: imagePath, atRevision: revision, origin: 'capture' }] } : { images: [] }),
    ...(withAudit
      ? {
        relationAudit: {
          at: new Date().toISOString(),
          gaps: [],
          rejected: 0,
          openEnds: 0,
          closed: true,
          relationCount: 6,
          revision: auditRevision,
        },
      }
      : {}),
  }
  writeFileSync(file, JSON.stringify(store, null, 2))
}

// ── F1：门禁提示给出实际差值，且一次 relations 审计就追平 ────────────────
{
  const sid = newScenario()
  const { ctx, subagents } = makeContext()
  apply(ctx, {})
  // 几何 revision 5，审计还是 4（改了几何没重读关系）
  writeDesign({ designId: 'p1', revision: 5, auditRevision: 4 })
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build', designId: 'p1' }, sid), async () => okEnvelope({ designId: 'p1' }))
  const denied = await deliver(ctx, sid, { designId: 'p1' })
  check('F1 审计落后一版 → 交付被拒', denied.kind === 'deny', denied.kind)
  check('F1 拒绝理由给出实际差值（audit 4 / state 5 / 差 1）',
    String(denied.reason).includes('audit.revision=4')
      && String(denied.reason).includes('state.revision=5')
      && String(denied.reason).includes('差 1'),
    String(denied.reason).split('\n')[0].slice(0, 200))
  // 措辞收窄过：旧提示「跑一次就够」与门禁「审计必须等于当前几何版本」直接矛盾
  // —— 改完几何还只跑一次，版本必然追不上。现在要求的是「改过就重读一次」。
  check('F1 拒绝理由说明「改过就要重读一次，重读一次就能追平」',
    String(denied.reason).includes('改一次就要重读一次')
      && String(denied.reason).includes('重读一次就能追平'))
  check('F1 拒绝理由不再说「跑一次就够」（与门禁自相矛盾的那句）',
    !String(denied.reason).includes('跑一次就够'))
  check('F1 这三次失败之前不该 spawn 审查', subagents.calls.length === 0, subagents.calls.length)

  // 服务侧按新口径落账：relations 审计带上本设计实时的 revision（5）
  writeDesign({ designId: 'p1', revision: 5, auditRevision: 5 })
  const allowed = await deliver(ctx, sid, { designId: 'p1' })
  check('F1 审计 revision 追平后放行（第 1 次重读就够）', allowed.kind === 'allow', allowed)
  check('F1 放行时确实送审了一次', subagents.calls.length === 1, subagents.calls.length)
}

// ── F1：换 designId 不继承旧设计的 revision（横跨两条设计的计数器）──────────
{
  const sid = newScenario()
  const { ctx } = makeContext()
  apply(ctx, {})
  // A 设计跑到 revision 21（旧实现里 state.revision 会留在 21）
  writeDesign({ designId: 'big-a', revision: 21, auditRevision: 21 })
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build', designId: 'big-a' }, sid), async () => okEnvelope({ designId: 'big-a' }))
  const a = await deliver(ctx, sid, { designId: 'big-a' })
  check('F1 第一条设计（21）能正常交付', a.kind === 'allow', a.kind)

  // B 设计是新的：revision 0、审计 0。旧状态里 21 的残留必须不带过来。
  writeDesign({ designId: 'small-b', revision: 0, auditRevision: 0 })
  const b = await deliver(ctx, sid, { designId: 'small-b' })
  check('F1 换设计后新设计的 revision 从 0 起（不继承 21）',
    !String(b.reason ?? '').includes('revision 21') && !String(b.reason ?? '').includes('state.revision=21'),
    String(b.reason ?? '').slice(0, 160))
}

// ── F1(c)：hydrate 不再借「最近 30 分钟另一条设计」的图 ─────────────────
{
  const sid = newScenario()
  const { ctx, subagents } = makeContext()
  apply(ctx, {})
  // 另一条设计刚收过图（30 分钟内、有 image），而本设计没有任何 live 记录。
  writeDesign({ designId: 'other-design', revision: 3, auditRevision: 3 })
  writeDesign({ designId: 'mine-empty', revision: 0, auditRevision: 0, image: null, withAudit: false })
  const gate = await deliver(ctx, sid, { designId: 'mine-empty' })
  check('F1 没有自己的图时不会借别条设计的图（拒绝而不是送审）',
    gate.kind === 'deny', gate.kind)
  check('F1 拒绝理由指向「这一轮没有图」而不是审查差异',
    /没有|图/.test(String(gate.reason ?? '')), String(gate.reason ?? '').slice(0, 160))
  check('F1 借图路径删掉之后没有 spawn 审查', subagents.calls.length === 0, subagents.calls.length)
}

// ── F3：deliver 缺 designId 直接报 DESIGN_ID_REQUIRED（不再回退全局）─────────
{
  const sid = newScenario()
  const { ctx } = makeContext()
  apply(ctx, {})
  // 先让本会话「见过」一个设计，再省略 designId 交付：旧实现会用 lastDesignId。
  writeDesign({ designId: 'seen-before', revision: 2, auditRevision: 2 })
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build', designId: 'seen-before' }, sid), async () => okEnvelope({ designId: 'seen-before' }))
  // 换一个全新的会话：它没有见过任何 designId
  const sid2 = newScenario()
  const gate = await deliver(ctx, sid2, {})
  check('F3 新会话省略 designId → DESIGN_ID_REQUIRED', String(gate.reason ?? '').includes('DESIGN_ID_REQUIRED'),
    String(gate.reason ?? '').slice(0, 160))
  check('F3 错误里不带别的会话的 designId', !String(gate.reason ?? '').includes('seen-before'))
}

// ── F3（纯函数）：resolveDesignId 只认显式值；错误详情带候选 ───────────────
{
  check('F3 resolveDesignId 只认显式值', resolveDesignId('abc') === 'abc', resolveDesignId('abc'))
  check('F3 resolveDesignId(undefined) → null（不再猜上一个）', resolveDesignId(undefined) === null)
  check('F3 resolveDesignId("") → null', resolveDesignId('') === null)
  const error = designIdRequired({ dataDir: process.env.SW_MCP_DATA, tool: 'model', action: 'build', projectIds: ['proj-1'] })
  check('F3 DESIGN_ID_REQUIRED 错误码与候选列表',
    error.code === 'DESIGN_ID_REQUIRED' && error.detail.knownDesignIds.includes('proj-1'),
    error.detail)
  check('F3 错误文案说明「不会退回最近一次用过的设计」', /不会退回/.test(error.message))
}

// ── F2：inspect action=relations 落账必须带本设计实时的 revision ───────────
// 用假的 callBridge 直接驱动 tools-observe 的 handler：不碰 SOLIDWORKS。
{
  const designId = 'p2-audit'
  bumpRevision({ dataDir: process.env.SW_MCP_DATA, designId })
  bumpRevision({ dataDir: process.env.SW_MCP_DATA, designId })
  const revision = readLiveRecord({ dataDir: process.env.SW_MCP_DATA, designId }).revision
  check('F2 测试前置：这一版 revision 是 2', revision === 2, revision)

  let captured = null
  let recorded = 0
  let tools = 0
  // tools-observe 在注册时就把 deps 解构掉了，所以这里用可变闭包而不是替换 deps 字段。
  let liveRevision = 2
  const fakeServer = {
    registerTool(name, definition, handler) {
      if (name !== 'inspect') return
      tools += 1
      const capturedHandler = handler
      fakeServer.handler = capturedHandler
    },
  }
  const deps = {
    envelope: (value) => value,
    ok: (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] }),
    failed: ({ error, op }) => ({ content: [{ type: 'text', text: JSON.stringify({ status: 'failed', summary: `${op}: ${error.message}`, extra: { error: { code: error.code, message: error.message } } }) }] }),
    fail: (code, message, detail) => Object.assign(new Error(message), { code, detail }),
    callBridge: async () => ({ sketch: '草图1', count: 4, relations: [{ type: 'coincident' }], closed: true, openEnds: 0, document: { title: '零件1.SLDPRT', path: 'C:\\x\\零件1.SLDPRT' } }),
    resolveDesignId: (value) => (typeof value === 'string' && value.length > 0 ? value : null),
    designIdArg: z.string().optional(),
    readFileSync,
    join,
    tmpdir,
    dataDir: process.env.SW_MCP_DATA,
    handlePartCheck: async () => ({}),
    handlePartInspect: async () => ({}),
    handlePartExport: async () => ({}),
    recordRelationAudit: (payload) => { recorded += 1; captured = payload; return { designId: payload.designId } },
    liveRevisionOf: () => liveRevision,
    documentIdentityCheck: () => ({ ok: true }),
    requireDesignId: (value) => { if (typeof value === 'string' && value.length > 0) return value; throw Object.assign(new Error('DESIGN_ID_REQUIRED'), { code: 'DESIGN_ID_REQUIRED' }) },
  }
  registerObserveTools(fakeServer, z, deps)
  check('F2 假 server 登记了 inspect', tools === 1 && typeof fakeServer.handler === 'function', tools)

  const result = await fakeServer.handler({ action: 'relations', designId, relationAction: 'list' })
  const envelope = JSON.parse(result.content[0].text)
  check('F2 relations 回读成功', envelope.status === 'ok', envelope.status)
  check('F2 落账时带上了本设计实时的 revision=2', recorded === 1 && captured?.revision === 2, captured)
  check('F2 回包里 changes.audit.recorded=true', envelope.changes?.audit?.recorded === true, envelope.changes?.audit)

  // 取不到可信 revision：不落账，并如实回 AUDIT_REVISION_UNKNOWN
  recorded = 0
  captured = null
  liveRevision = null
  const result2 = await fakeServer.handler({ action: 'relations', designId, relationAction: 'list' })
  const envelope2 = JSON.parse(result2.content[0].text)
  check('F2 取不到可信 revision 时不落账（不再拿旧值凑）', recorded === 0, recorded)
  check('F2 回 AUDIT_REVISION_UNKNOWN', envelope2.changes?.audit?.code === 'AUDIT_REVISION_UNKNOWN',
    envelope2.changes?.audit)
  check('F2 摘要里也写明了这次没落账', /AUDIT_REVISION_UNKNOWN/.test(envelope2.summary ?? ''), envelope2.summary)
}

// ── F1 辅助：交付审批按 revision 失效（F4 的判据，顺带在这里钉住）──────────
{
  const dataDir = process.env.SW_MCP_DATA
  const designId = 'f4-approve'
  bumpRevision({ dataDir, designId })
  recordDeliveryApproval({ dataDir, designId, kind: 'sldprt', path: 'C:\\x\\a.SLDPRT' })
  const approved = readLiveRecord({ dataDir, designId })
  check('审批落在 live.json 上并带上当时的 revision',
    approved.delivery?.approvedAtRevision === approved.revision, approved.delivery)
  bumpRevision({ dataDir, designId })
  const afterChange = readLiveRecord({ dataDir, designId })
  check('几何再改一次 → 审批自动失效（revision 不再相等）',
    afterChange.delivery?.approvedAtRevision !== afterChange.revision,
    { approvedAt: afterChange.delivery?.approvedAtRevision, revision: afterChange.revision })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
