// F4（绕门后门 + 逃生口）与 F7（门禁熔断）的回归。
//
// 取证背景（四个会话里交付门被绕过：job submit op=save/export、extension.SaveAs、
//   四个会话**全部**绕过过交付门：job submit op=save/export ×5、extension.SaveAs、
//   SaveAs4+SaveAs、直连命名管道提交 save/export。结果「对」但审查永远没跑起来 ——
//   用户说的「调用审查失败」就是这个。绕门之所以普遍，是因为门禁本身不可达；所以
//   F4 必须和 F1/F2 同批上线，并且必须留一个显式的、留痕的 escape（force:"manual"）。
//
// 另外 0bb49837 在一段程序里把 `inspect relations` + `deliver` 重复了 20 次，
// 所以 F7 要在同一 (designId, checkCode) 连续硬失败 3 次后直接判「这条门禁不可达」。
//
// 这不依赖 SOLIDWORKS / broker：被拒的调用在进入 handler 之前就返回了，
// 熔断用的是假 ctx 与假 live.json。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SAVE_MEMBERS, SAVE_OPS, checkSavePath, classifySaveCall, deliveryApproved,
} from '../server/review-guard.mjs'
import { bumpRevision, readLiveRecord, recordDeliveryApproval } from '../server/review-live.mjs'
import { apply } from '../preset/review-gate.js'
import { openSession } from './lib/mcp.mjs'

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
const dirroot = mkdtempSync(join(tmpdir(), 'sw-gate-bypass-'))
const image = join(dirroot, 'shot-01.png')
writeFileSync(image, PNG_1x1)

// ── F4（纯分类）：哪些调用是绕门写入 ─────────────────────────────────
{
  check('SAVE_OPS 覆盖 save/export', SAVE_OPS.has('save') && SAVE_OPS.has('export'), [...SAVE_OPS])
  check('SAVE_MEMBERS 覆盖四个实测成员',
    ['SaveAs', 'SaveAs3', 'SaveAs4', 'SaveAsSilent'].every((m) => SAVE_MEMBERS.has(m.toLowerCase())),
    [...SAVE_MEMBERS])

  const cases = [
    ['job save', 'job', { action: 'submit', op: 'save', args: { designId: 'd1' } }, true],
    ['job export', 'job', { action: 'submit', op: 'export', args: { designId: 'd1' } }, true],
    ['job build（正常建模不该拦）', 'job', { action: 'submit', op: 'build', args: { designId: 'd1' } }, false],
    ['job status（不是写入）', 'job', { action: 'status', jobId: 'j1' }, false],
    ['model invoke SaveAs4', 'model', { action: 'invoke', member: 'SaveAs4', designId: 'd1' }, true],
    ['model invoke extension.SaveAs', 'model', { action: 'invoke', target: 'extension', member: 'SaveAs', designId: 'd1' }, true],
    ['model invoke FeatureExtrusion3（正常调用）', 'model', { action: 'invoke', member: 'FeatureExtrusion3', designId: 'd1' }, false],
    ['task 里的 save', 'task', { action: 'run', tasks: [{ id: 'a', op: 'save', args: { designId: 'd1' } }] }, true],
    ['task 里只有 build', 'task', { action: 'run', tasks: [{ id: 'a', op: 'build', args: { designId: 'd1' } }] }, false],
    ['model batch 里的 export', 'model', { action: 'batch', ops: [{ op: 'export', args: { designId: 'd1' } }], designId: 'd1' }, true],
  ]
  for (const [label, tool, args, expected] of cases) {
    const call = classifySaveCall(tool, args)
    check(`F4 分类：${label} → ${expected ? '绕门' : '放行'}`, (call !== null) === expected, call)
  }
}

// ── F4（判定）：未审批拒绝 / 审批后放行 / 改几何后再次拒绝 ─────────────
{
  const dataDir = mkdtempSync(join(tmpdir(), 'sw-gate-bypass-data-'))
  const designId = 'lock-cover'
  const jobCall = { action: 'submit', op: 'save', args: { designId, path: 'C:\\x\\锁盖.SLDPRT' } }

  const refused = checkSavePath({ dataDir, clientId: 'mcp:111', toolName: 'job', args: jobCall })
  check('F4 未通过审查的 job save 被拒', refused.ok === false && refused.error.code === 'GATE_BYPASS_REFUSED',
    refused.error?.code)
  check('F4 拒绝理由说明只有 deliver 能写文件', /只有 deliver 能写文件/.test(refused.error.message))
  check('F4 拒绝理由给出逃生口写法', /force:"manual"/.test(refused.error.message))
  check('F4 拒绝理由带 designId / revision / 最近审批',
    /designId=lock-cover/.test(refused.error.message) && /最近一次通过的交付审查是 无/.test(refused.error.message),
    refused.error.detail)

  const invokeCall = { action: 'invoke', target: 'doc', member: 'SaveAs4', designId }
  const refusedInvoke = checkSavePath({ dataDir, clientId: 'mcp:111', toolName: 'model', args: invokeCall })
  check('F4 SaveAs4 也被拒（同一个门，不是按工具分开写的）',
    refusedInvoke.ok === false && refusedInvoke.error.code === 'GATE_BYPASS_REFUSED', refusedInvoke.error?.code)

  const noId = checkSavePath({ dataDir, clientId: 'mcp:111', toolName: 'job', args: { action: 'submit', op: 'save', args: {} } })
  check('F4 绕门调用缺 designId → DESIGN_ID_REQUIRED（与桥接器同码）',
    noId.ok === false && noId.error.code === 'DESIGN_ID_REQUIRED', noId.error?.code)

  // deliver 成功 → 审批钉在当前 revision 上 → 同版的 save/export 放行
  bumpRevision({ dataDir, designId })
  recordDeliveryApproval({ dataDir, designId, kind: 'sldprt', path: 'C:\\x\\锁盖.SLDPRT', bytes: 1234 })
  const record = readLiveRecord({ dataDir, designId })
  check('F4 deliver 审批被记下（判据是服务自己写的账）', deliveryApproved(record) === true, record.delivery)
  const allowed = checkSavePath({ dataDir, clientId: 'mcp:111', toolName: 'job', args: jobCall })
  check('F4 交付通过后同一版的 job save 放行', allowed.ok === true && allowed.bypassed === false, allowed)

  // 几何再改一次：旧审批失效，save 回到被拒
  bumpRevision({ dataDir, designId })
  const stale = checkSavePath({ dataDir, clientId: 'mcp:111', toolName: 'job', args: jobCall })
  check('F4 改过几何后旧审批失效 → save 再次被拒',
    stale.ok === false && stale.error.code === 'GATE_BYPASS_REFUSED', stale.error?.code)
  check('F4 失效时的理由里写出「最近审批是上一版」', /最近一次通过的交付审查是 1/.test(stale.error.message),
    stale.error.detail)

  // 逃生口：force:"manual" 放行并留痕（时间 / designId / op / clientId / 原因）
  const forced = checkSavePath({
    dataDir,
    clientId: 'mcp:222',
    toolName: 'job',
    args: { ...jobCall, force: 'manual', reason: '门禁自己坏了（GATE_UNREACHABLE）' },
  })
  check('F4 force:"manual" 放行', forced.ok === true && forced.bypassed === true, forced)
  const logPath = join(dataDir, 'review', 'bypass.jsonl')
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  check('F4 绕门留痕写到 review/bypass.jsonl', lines.length === 1, lines.length)
  const line = lines[0] ?? {}
  check('F4 留痕含时间 / designId / op / clientId / 原因',
    typeof line.at === 'string' && line.designId === designId && line.op === 'save'
      && line.clientId === 'mcp:222' && line.reason === '门禁自己坏了（GATE_UNREACHABLE）',
    line)
  check('F4 留痕里带着当时的 revision 与审批状态', line.detail?.revision === record.revision + 1, line.detail)

  // 没有理由也必须留痕（写「(未说明)」），不能默默放行
  const forcedNoReason = checkSavePath({ dataDir, clientId: 'mcp:333', toolName: 'job', args: { ...jobCall, force: 'manual' } })
  const lines2 = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((entry) => JSON.parse(entry))
  check('F4 没写 reason 时留痕为 (未说明)', forcedNoReason.ok === true && lines2.at(-1)?.reason === '(未说明)',
    lines2.at(-1))
}

// ── F7：熔断（连续 3 次同一门禁硬失败 → GATE_UNREACHABLE）+ force 逃生口 ──
function makeContext({ verdict = 'passed' } = {}) {
  const handlers = new Map()
  const subagents = {
    calls: [],
    async startActivation(spec) {
      this.calls.push(spec)
      return {
        childId: `c-${this.calls.length}`,
        result: Promise.resolve({ structured: { verdict, confidence: 0.9, differences: [] }, stopReason: 'stop' }),
        dispose: async () => {},
      }
    },
  }
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
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
  return { ctx, subagents }
}

const execOf = (name, args = {}, sid = 's1') => ({ name, arguments: args, agent: { id: sid, session: { id: sid } }, signal: undefined })
const okEnvelope = (extra = {}) => ({ content: [{ type: 'text', text: JSON.stringify({ status: 'ok', ...extra }) }] })

function writeDesign({ dataDir, designId, revision, auditRevision }) {
  mkdirSync(join(dataDir, 'review'), { recursive: true })
  writeFileSync(join(dataDir, 'review', 'live.json'), JSON.stringify({
    version: 1,
    designs: {
      [designId]: {
        designId,
        revision,
        updatedAt: new Date().toISOString(),
        images: [{ path: image, atRevision: revision, origin: 'capture' }],
        relationAudit: {
          at: new Date().toISOString(), gaps: [], rejected: 0, openEnds: 0, closed: true, relationCount: 6, revision: auditRevision,
        },
      },
    },
  }, null, 2))
}

{
  const dataDir = mkdtempSync(join(tmpdir(), 'sw-gate-fuse-'))
  process.env.SW_MCP_DATA = dataDir
  const { ctx, subagents } = makeContext()
  apply(ctx, {})
  const sid = 'fuse-1'
  const designId = 'bracket-06v1'
  // 门禁不可达的典型形状：几何 revision 21，关系审计永远停在 3。
  writeDesign({ dataDir, designId, revision: 21, auditRevision: 3 })
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build', designId }, sid), async () => okEnvelope({ designId }))

  const deny = () => ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', { designId }, sid), async () => ({ kind: 'allow' }))
  const first = await deny()
  const second = await deny()
  const third = await deny()
  check('F7 第 1 次：普通 RELATIONS_INCOMPLETE', first.kind === 'deny' && /RELATIONS_INCOMPLETE/.test(first.reason), first.kind)
  check('F7 第 2 次：仍是 RELATIONS_INCOMPLETE', second.kind === 'deny' && /RELATIONS_INCOMPLETE/.test(second.reason))
  console.log('\n──── 熔断的实际输出（模拟：同一 (designId, code) 连续第 3 次）────')
  console.log(third.reason)
  console.log('──────────────────────────────────────────────────────────────\n')
  check('F7 第 3 次返回 GATE_UNREACHABLE', third.kind === 'deny' && /GATE_UNREACHABLE/.test(third.reason), third.kind)
  check('F7 熔断理由带「这条门禁当前不可达」', /这条门禁当前不可达/.test(third.reason))
  check('F7 熔断理由给出 force:"manual" 逃生口', /force:"manual"/.test(third.reason))
  check('F7 熔断理由要求汇报说明', /汇报/.test(third.reason))
  check('F7 熔断前没有 spawn 审查（不吃审查额度）', subagents.calls.length === 0, subagents.calls.length)

  // 换一条设计：计数按 (designId, code) 隔离，新设计不继承熔断
  writeDesign({ dataDir, designId: 'other-part', revision: 2, auditRevision: 2 })
  const other = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', { designId: 'other-part' }, sid), async () => ({ kind: 'allow' }))
  check('F7 熔断按 designId 隔离：另一条设计照常审', other.kind === 'allow', other.kind)

  // 逃生口：force:"manual" 放行并留痕
  const forced = await ctx.fire('tools/pre-execute',
    execOf('mcp__sw__deliver', { designId, force: 'manual', reason: '门禁不可达，用户要求先交' }, sid),
    async () => ({ kind: 'allow' }))
  check('F7 force:"manual" 交付放行', forced.kind === 'allow', forced.kind)
  const logPath = join(dataDir, 'review', 'bypass.jsonl')
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  check('F7 force 交付也写进同一个 bypass.jsonl', lines.some((line) => line.source === 'review-gate' && line.designId === designId),
    lines.map((line) => line.source))
  check('F7 留痕带 reason', lines.at(-1)?.reason === '门禁不可达，用户要求先交', lines.at(-1))

  // 门禁恢复：修好之后计数清掉，正常交付能过（不是永久拉黑）
  writeDesign({ dataDir, designId, revision: 21, auditRevision: 21 })
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build', designId }, sid), async () => okEnvelope({ designId }))
  const recovered = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', { designId }, sid), async () => ({ kind: 'allow' }))
  check('F7 门禁修好后正常交付恢复（熔断不是永久拉黑）', recovered.kind === 'allow', recovered.kind)
  check('F7 恢复交付时确实送审', subagents.calls.length >= 2, subagents.calls.length)
}

// ── F7：verify 门禁也会熔断（不是只对关系审计生效）────────────────────
{
  const dataDir = mkdtempSync(join(tmpdir(), 'sw-gate-fuse-verify-'))
  process.env.SW_MCP_DATA = dataDir
  const { ctx } = makeContext()
  apply(ctx, {})
  const sid = 'fuse-verify'
  const designId = 'p-verify'
  writeDesign({ dataDir, designId, revision: 1, auditRevision: 1 })
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build', designId }, sid), async () => okEnvelope({ designId }))
  // 服务侧记下一条「本轮 verify failed」
  await ctx.fire('tools/execute', execOf('mcp__sw__inspect', { action: 'verify' }, sid), async () => okEnvelope({
    designId,
    status: 'failed',
    changes: { checks: [{ name: '孔位', status: 'fail' }] },
  }))
  const run = () => ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', { designId }, sid), async () => ({ kind: 'allow' }))
  await run()
  await run()
  const third = await run()
  check('F7 verify 门禁同样在第 3 次熔断',
    /GATE_UNREACHABLE/.test(String(third.reason ?? '')) && /VERIFY_FAILED/.test(String(third.reason ?? '')),
    String(third.reason ?? '').slice(0, 160))
}

// ── F4（接线）：真 MCP 会话里 job/model/task 的存盘调用在进 handler 之前就被拒 ──
// 被拒发生在碰 broker / 桥接器之前，所以这条用例不需要 SOLIDWORKS，也不会拉起任何进程。
{
  const dataDir = mkdtempSync(join(tmpdir(), 'sw-gate-wire-'))
  const session = openSession({
    env: {
      ...process.env,
      SW_MCP_DATA: dataDir,
      SW_MCP_SESSION_ID: 'mcp:wire-test',
      SW_MCP_BROKER_PIPE: `\\\\.\\pipe\\sw-mcp-gate-bypass-nonexistent-${process.pid}`,
    },
  })
  try {
    await session.start()
    const jobSave = await session.tool('job', { action: 'submit', op: 'save', args: { designId: 'x', path: 'C:\\x\\a.sldprt' } })
    check('F4 真会话：job submit op=save 被 GATE_BYPASS_REFUSED 拒',
      jobSave.status === 'failed' && jobSave.extra?.error?.code === 'GATE_BYPASS_REFUSED',
      jobSave.extra?.error?.code ?? jobSave.summary)
    check('F4 真会话：拒绝理由告诉它先 capture + deliver',
      /先 capture/.test(jobSave.summary ?? '') && /deliver/.test(jobSave.summary ?? ''), jobSave.summary)

    const invoke = await session.tool('model', { action: 'invoke', designId: 'x', target: 'doc', member: 'SaveAs4' })
    check('F4 真会话：model invoke SaveAs4 被拒（extension.SaveAs 同码）',
      invoke.extra?.error?.code === 'GATE_BYPASS_REFUSED', invoke.extra?.error?.code ?? invoke.summary)

    const task = await session.tool('task', {
      action: 'run',
      tasks: [{ id: 'a', op: 'export', args: { designId: 'x' } }],
    })
    check('F4 真会话：task 里的 export 被拒',
      task.extra?.error?.code === 'GATE_BYPASS_REFUSED', task.extra?.error?.code ?? task.summary)

    const noId = await session.tool('job', { action: 'submit', op: 'export', args: {} })
    check('F4 真会话：绕门调用缺 designId → DESIGN_ID_REQUIRED',
      noId.extra?.error?.code === 'DESIGN_ID_REQUIRED', noId.extra?.error?.code ?? noId.summary)

    // 工具描述里必须写明「save/export 需要先过交付审查」—— 否则模型只会撞墙。
    const listed = await session.call('tools/list', {})
    const jobTool = (listed.tools ?? []).find((tool) => tool.name === 'job')
    const modelTool = (listed.tools ?? []).find((tool) => tool.name === 'model')
    const deliverTool = (listed.tools ?? []).find((tool) => tool.name === 'deliver')
    check('F4 job 工具描述写明 save/export 是绕门并给出逃生口',
      /绕门/.test(jobTool?.description ?? '') && /force:"manual"/.test(jobTool?.description ?? ''),
      (jobTool?.description ?? '').slice(0, 80))
    check('F4 model 工具描述写明 SaveAs* 会被拒',
      /SaveAs/.test(modelTool?.description ?? '') && /GATE_BYPASS_REFUSED|绕门/.test(modelTool?.description ?? '')),
    check('F4 deliver 工具描述写明只有它能写文件',
      /只有 deliver 能写文件/.test(deliverTool?.description ?? ''))
  } finally {
    session.close()
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
