// 交付前的独立审查门：行为用假 ctx 验，不依赖 DSH 与 SOLIDWORKS。
//
// 要保住的性质：
//   1. 几何改过之后，交付/标完成必须先过一次独立审查；
//   2. 审查者拿到的是图（image 块）与一个空白上下文预设，不是主模型的文字说明；
//   3. 同一版本审查过就复用，不重复 spawn；
//   4. 结论不是 passed 时拒绝交付，并把差异原样交给模型；
//   5. 能力缺失（没有 subagents/attachments/图）时降级放行并告警 —— 不把模式锁死。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, REVIEW_SCHEMA, selectForReview } from '../review-gate.js'

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

// 最小的合法 PNG（1x1），只为让 readFileSync 有东西可读。
const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
  '0d0a2db40000000049454e44ae426082', 'hex')
const dir = mkdtempSync(join(tmpdir(), 'sw-review-'))
const image = join(dir, 'shot.png')
writeFileSync(image, PNG_1x1)
// 全程隔离 live.json：真实数据目录里最近 30 分钟的其它设计会被
// syncFromLive 的「猜最近一条」捡进来，让「没有图」的场景凭空多出图。
// 这不是测试想验的行为，必须用干净的 SW_MCP_DATA。
process.env.SW_MCP_DATA = mkdtempSync(join(tmpdir(), 'sw-review-data-'))

function makeContext({ subagents, attachments } = {}) {
  const handlers = new Map()
  const warnings = []
  const infos = []
  const ctx = {
    logger: { warn: (m) => warnings.push(m), info: (m) => infos.push(m) },
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
      // 通知式事件（turn-stopping 这类）：全部跑一遍，返回值没人要。
      for (const handler of list) handler(payload)
      return undefined
    },
  }
  return { ctx, warnings, infos }
}

function fakeSubagents(structured) {
  const calls = []
  return {
    calls,
    async startActivation(spec) {
      calls.push(spec)
      return {
        childId: 'child-1',
        result: Promise.resolve({ structured, stopReason: 'stop' }),
        dispose: async () => {},
      }
    },
  }
}

const okEnvelope = (extra = {}) => ({
  content: [{ type: 'text', text: JSON.stringify({ status: 'ok', designId: 'p2', ...extra }) }],
})

// 每个场景用独立的会话 id：审查状态是按会话记的，共用一个 id 会让场景之间互相污染。
let scenario = 0
const newScenario = () => { scenario += 1; return `s${scenario}` }

// ── 本轮新增：来源标注 / 选图 / verify 前置门 / observe 缓存 的测试脚手架 ──
// 造一张真的能读的 PNG（内容相同也无妨：选图看的是路径、来源与视角，不是像素）。
function pngAt(name) {
  const full = join(dir, name)
  writeFileSync(full, PNG_1x1)
  return full
}
// 每个场景一套干净的 SW_MCP_DATA：真数据目录里最近的 live.json 记录会被
// syncFromLive 的「猜最近一条」捡进来，让「没有图/没有 origin」的场景凭空多出状态。
function isolatedDataDir(label) {
  const outer = process.env.SW_MCP_DATA
  const dataDir = mkdtempSync(join(tmpdir(), `sw-review-${label}-`))
  process.env.SW_MCP_DATA = dataDir
  return { dataDir, restore() { process.env.SW_MCP_DATA = outer } }
}
const specLabel = (spec) => spec?.request?.label ?? spec?.label ?? ''
const reviewCall = (subagents) => subagents.calls.find((spec) => specLabel(spec) === 'sw-review')
const observeCalls = (subagents) => subagents.calls.filter((spec) => specLabel(spec) === 'sw-review-observe')
const promptTextOf = (spec) => (spec.request ?? spec).prompt
  .filter((part) => part.type === 'text')
  .map((part) => part.text)
  .join(String.fromCharCode(10))
const imageCountOf = (spec) => (spec.request ?? spec).prompt.filter((part) => part.type === 'image').length
// observe 与 review 要拿到不同的结论：observe 回结构清单，review 回判定。
function fakeSubagentsByLabel({ observe, review }) {
  const calls = []
  return {
    calls,
    async startActivation(spec) {
      calls.push(spec)
      const structured = (spec.request ?? spec).label === 'sw-review-observe' ? observe : review
      return { childId: `c-${calls.length}`, result: Promise.resolve({ structured, stopReason: 'stop' }), dispose: async () => {} }
    },
  }
}
const EXPECT_REFERENCE_LINE = '按清单里的参考图（figure 裁剪块与 compare 并排图都算参考图）逐项比对模型。'
const NO_REFERENCE_LINE = '这次没有参考图纸'
const execOf = (name, args = {}, sid = 's1') => ({ name, arguments: args, agent: { id: sid, session: { id: sid } }, signal: undefined })

// ── 场景 1：改几何 → 送审 → different → 拒绝交付 ──────────────────────
{
  const sid = newScenario()
  const subagents = fakeSubagents({
    verdict: 'different',
    confidence: 0.7,
    differences: [{ region: '左下角的槽', expected: '开口通到端面', actual: '被封闭在板内' }],
  })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx, warnings } = makeContext({ subagents, attachments })
  apply(ctx, {})

  // 建模：revision 0 -> 1，并留下一张图
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope({ image: { path: image } }))
  // 交付：应当触发审查并拒绝
  const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))

  check('改了几何后交付被拦下', gate.kind === 'deny', gate.kind)
  check('拒绝理由里带着具体差异', String(gate.reason).includes('左下角的槽'), gate.reason)
  check('只 spawn 了一次审查', subagents.calls.length === 1, subagents.calls.length)

  const spec = subagents.calls[0]
  // 宿主 subagents API 的调用参数是平铺的；旧测试包了一层 request。
  const request = spec.request ?? spec
  check('审查用的是空白上下文预设', request.agentPreset === 'sw-review', request.agentPreset)
  check('审查走 spawn 且等结果', spec.provider === 'spawn' && spec.delivery === 'caller', `${spec.provider}/${spec.delivery}`)
  check('审查带 outputSchema', request.outputSchema === REVIEW_SCHEMA)
  const imageBlocks = request.prompt.filter((p) => p.type === 'image')
  check('审查者真的收到了图片块', imageBlocks.length === 1, request.prompt.map((p) => p.type))
  check('图片是附件引用不是路径字符串', typeof imageBlocks[0]?.attachment === 'string', imageBlocks[0])
  check('没有把主模型的文字结论塞给审查者', !JSON.stringify(request.prompt).includes('"summary"'))

  // 审查员得知道每张图是怎么来的，否则会把工程图裁剪当成模型照片去挑毛病。
  const promptText = (spec.request ?? spec).prompt.filter((p) => p.type === 'text').map((p) => p.text).join(String.fromCharCode(10))
  check('prompt 里写明每张图的来源', /来源 \S+/.test(promptText), promptText.slice(0, 160))
  check('prompt 里说明了只按图像判断', promptText.includes('只根据你看到的图像判断'), promptText.slice(0, 160))

  // 同一版本再交付：复用结论，不再 spawn
  const again = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  check('同版本复用结论（不重复 spawn）', again.kind === 'deny' && subagents.calls.length === 1, subagents.calls.length)
  // 又改了一次几何（新 revision、同样一张图）：必须重新审，不能拿旧版本的结论
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope({ image: { path: image } }))
  const newer = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  check('新 revision 用同一张图也要重审', newer.kind === 'deny' && subagents.calls.length === 2, `${newer.kind}/${subagents.calls.length}`)
  check('没有能力告警', warnings.length === 0, warnings)
}

// ── 场景 1b：图来自 capture 时，来源要写成 capture ────────────────────
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.9, differences: [] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope())
  await ctx.fire('tools/execute', execOf('mcp__sw__capture', {}, sid), async () => okEnvelope({ artifacts: [{ kind: 'image', path: image }] }))
  const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  const promptText = (subagents.calls[0].request ?? subagents.calls[0]).prompt.filter((p) => p.type === 'text').map((p) => p.text).join(String.fromCharCode(10))
  check('capture 产生的图来源写成 capture', promptText.includes('来源 capture'), promptText.slice(0, 160))
  check('capture 的图能通过门禁', gate.kind === 'allow', gate.kind)
}

// ── 场景 2：改完再审 → passed → 放行 ──────────────────────────────────
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.9, differences: [] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})

  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope({ image: { path: image } }))
  const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  check('审查通过后交付放行', gate.kind === 'allow', gate)
}

// ── 场景 3：几何又改了 → 旧结论作废，要重新审 ─────────────────────────
{
  const sid = newScenario()
  const answers = [
    { verdict: 'passed', confidence: 0.9, differences: [] },
    { verdict: 'different', confidence: 0.8, differences: [{ region: '右侧凸台', expected: 'Ø75 台阶', actual: '光面' }] },
  ]
  let n = 0
  const subagents = {
    calls: [],
    async startActivation(spec) {
      this.calls.push(spec)
      return { childId: 'c', result: Promise.resolve({ structured: answers[n++] }), dispose: async () => {} }
    },
  }
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})

  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope({ image: { path: image } }))
  const first = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  check('第一次审查通过', first.kind === 'allow')

  // 改参数：revision 变了
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'edit' }, sid), async () => okEnvelope({ image: { path: image } }))
  const second = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  check('改完参数后旧结论不再放行', second.kind === 'deny', second.kind)
  check('重新审了一次', subagents.calls.length === 2, subagents.calls.length)
  check('新结论的差异出现在理由里', String(second.reason).includes('右侧凸台'), second.reason)
}

// ── 场景 4：没有图 → 拒绝交付并要求先截图 ───────────────────────────
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.9, differences: [] })
  const attachments = { saveImage: async () => 'att://x' }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})

  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope())
  const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  check('没有图时拒绝交付并让人先截图', gate.kind === 'deny' && String(gate.reason).includes('capture'), gate.reason)
  check('没有图时不 spawn', subagents.calls.length === 0, subagents.calls.length)
}

// ── 场景 4b：图是改之前的 → 要求重截，不许拿旧图审 ──────────────────
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.9, differences: [] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope({ image: { path: image } }))
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'edit' }, sid), async () => okEnvelope())
  const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  check('旧图不算数，要求重新截图', gate.kind === 'deny' && String(gate.reason).includes('改之前'), gate.reason)
  check('旧图不送审', subagents.calls.length === 0, subagents.calls.length)
}

// ── 场景 5：没有 subagents 服务 → 放行并告警 ─────────────────────────
{
  const sid = newScenario()
  const { ctx, warnings } = makeContext({ attachments: { saveImage: async () => 'att://x' } })
  apply(ctx, {})
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope({ image: { path: image } }))
  const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  check('缺 subagents 时放行', gate.kind === 'allow', gate.kind)
  check('缺 subagents 时有告警', warnings.some((w) => String(w).includes('subagents')), warnings)
}

// ── 场景 7：结论要落盘，事后能回答「这单审过没有」──────────────────
{
  const outerData = process.env.SW_MCP_DATA
  const dataDir = mkdtempSync(join(tmpdir(), 'sw-review-data-'))
  process.env.SW_MCP_DATA = dataDir
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.88, differences: [] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope({ image: { path: image } }))
  await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  let lines = []
  try {
    lines = readFileSync(join(dataDir, 'logs', 'review.jsonl'), 'utf8').trim().split(String.fromCharCode(10))
  } catch (error) {
    check('审查记录文件写出来了', false, String(error?.message ?? error))
  }
  check('审查记录文件写出来了', lines.length === 1, lines.length)
  const record = JSON.parse(lines[0] ?? '{}')
  check('记录里有结论', record.verdict === 'passed', record.verdict)
  check('记录里有 revision 与把握', record.revision === 1 && record.confidence === 0.88, record)
  process.env.SW_MCP_DATA = outerData
}

// ── 场景 6：update_goal 只在 complete 时被拦 ─────────────────────────
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'different', confidence: 0.6, differences: [{ region: '顶面', expected: '有两个孔', actual: '没有孔' }] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope({ image: { path: image } }))

  const blocked = await ctx.fire('tools/pre-execute', execOf('update_goal', { action: 'blocked' }, sid), async () => ({ kind: 'allow' }))
  const complete = await ctx.fire('tools/pre-execute', execOf('update_goal', { action: 'complete' }, sid), async () => ({ kind: 'allow' }))
  check('报阻塞不被审查门拦住', blocked.kind === 'allow', blocked.kind)
  check('宣布完成要过审查门', complete.kind === 'deny', complete.kind)
}

// ── 场景 6b：建模本身不被审查门拦住（审的是结果，不是过程） ──────────
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'different', confidence: 0.6, differences: [{ region: '顶面', expected: '有孔', actual: '无孔' }] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})
  // 先留下一张会判 different 的图
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope({ image: { path: image } }))
  const build = await ctx.fire('tools/pre-execute', execOf('mcp__sw__model', { action: 'edit' }, sid), async () => ({ kind: 'allow' }))
  check('改模型不被审查门拦住', build.kind === 'allow', build.kind)
  check('改模型不触发审查', subagents.calls.length === 0, subagents.calls.length)
}

// ── 场景 7：审查没按 schema 提交 → 拒绝并说明 ────────────────────────
{
  const sid = newScenario()
  const subagents = {
    calls: [],
    async startActivation() { return { childId: 'c', result: Promise.resolve({ structured: undefined }), dispose: async () => {} } },
  }
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope({ image: { path: image } }))
  const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  check('没有结构化结论 → 拒绝', gate.kind === 'deny', gate.kind)
  check('理由指出 structured_output', String(gate.reason).includes('structured_output'), gate.reason)
}

// ── 场景 8：审查次数上限 ─────────────────────────────────────────────
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'different', confidence: 0.5, differences: [{ region: 'x', expected: 'a', actual: 'b' }] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})
  for (let i = 0; i < 8; i += 1) {
    await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'edit' }, sid), async () => okEnvelope({ image: { path: image } }))
    await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  }
  check('审查次数有上限（不会无限重试）', subagents.calls.length <= 6, subagents.calls.length)
}


// ── 场景 6：轮次结束时预热审查（有新鲜图、还没审过）─────────────────
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.9, differences: [] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope({ image: { path: image } }))
  await ctx.fire('agent/turn-stopping', { agent: { id: sid, session: { id: sid } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('轮次收尾会预热一次审查', subagents.calls.length === 1, subagents.calls.length)
  // 预热出来的结论要能复用：deliver 不再 spawn 第二次
  const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  check('预热过的结论在交付时直接复用', gate.kind === 'allow' && subagents.calls.length === 1, `${gate.kind} / ${subagents.calls.length}`)
}

// ── 场景 6b：改过但没有新鲜图 → 轮次结束只留一条痕迹，不 spawn ─────
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.9, differences: [] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx, warnings } = makeContext({ subagents, attachments })
  apply(ctx, {})
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope())
  await ctx.fire('agent/turn-stopping', { agent: { id: sid, session: { id: sid } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('没图的轮次不 spawn 审查', subagents.calls.length === 0, subagents.calls.length)
  check('没图的轮次留一条可查的日志', warnings.some((w) => String(w).includes('还没被审查过')), warnings)
}

// ── 场景 6c：已经审过且版本没变 → 轮任结束不重复送审 ───────────────
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.9, differences: [] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope({ image: { path: image } }))
  await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  const before = subagents.calls.length
  await ctx.fire('agent/turn-stopping', { agent: { id: sid, session: { id: sid } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('审过的轮次收尾不重复送审', subagents.calls.length === before, `${before} -> ${subagents.calls.length}`)
}

// ── 场景 8：只有图纸裁剪块、没有模型图 → 先拍模型，不送审 ─────────────
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.9, differences: [] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope())
  await ctx.fire('tools/execute', execOf('mcp__sw__inspect', { action: 'figure' }, sid), async () => okEnvelope({ artifacts: [{ kind: 'image', path: image }] }))
  const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  check('只有图纸块时拒绝交付', gate.kind === 'deny', gate.kind)
  check('拒绝理由要求拍模型', String(gate.reason).includes('capture'), gate.reason)
  check('只有图纸块时没有送审', subagents.calls.length === 0, subagents.calls.length)
}

// ── 场景 8b：没有参考图（纯建模任务）→ 仍送审，但要说清只能看自身缺陷 ──
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.5, differences: [] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope())
  await ctx.fire('tools/execute', execOf('mcp__sw__capture', {}, sid), async () => okEnvelope({ artifacts: [{ kind: 'image', path: image }] }))
  const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  const promptText = (subagents.calls[0].request ?? subagents.calls[0]).prompt.filter((p) => p.type === 'text').map((p) => p.text).join(String.fromCharCode(10))
  check('没有参考图时说明只能看自身缺陷', promptText.includes('这次没有参考图纸'), promptText.slice(0, 160))
  check('没有参考图时限制把握', promptText.includes('把握不要超过 0.5'), 'missing confidence cap')
  check('没有参考图也能交付（纯建模任务）', gate.kind === 'allow', gate.kind)
}

// ── 场景 8c：图文件不见了 → 拒绝并要求重截，不放行 ──────────────────
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.9, differences: [] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})
  const ghost = join(dir, 'missing-shot.png')
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope())
  await ctx.fire('tools/execute', execOf('mcp__sw__capture', {}, sid), async () => okEnvelope({ artifacts: [{ kind: 'image', path: ghost }] }))
  const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  check('图读不到时拒绝交付', gate.kind === 'deny', gate.kind)
  check('图读不到时不 spawn', subagents.calls.length === 0, subagents.calls.length)
}

// ── 场景 8d：PTC 下图只在服务端 live.json 里 → 同步后仍能送审并放行 ──
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.8, differences: [] })
  const attachments = { saveImage: async ({ name }) => `att://${name}` }
  const { ctx } = makeContext({ subagents, attachments })
  const liveDir = join(process.env.SW_MCP_DATA, 'review')
  mkdirSync(liveDir, { recursive: true })
  writeFileSync(join(liveDir, 'live.json'), JSON.stringify({
    designs: {
      'p-live': {
        designId: 'p-live', revision: 3, updatedAt: new Date().toISOString(),
        images: [{ path: image, atRevision: 3, at: new Date().toISOString() }],
      },
    },
  }))
  apply(ctx, {})
  const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', { designId: 'p-live' }, sid), async () => ({ kind: 'allow' }))
  check('live.json 里的图能同步进审查', subagents.calls.length === 1, subagents.calls.length)
  const blocks = (subagents.calls[0]?.request ?? subagents.calls[0]).prompt.filter((p) => p.type === 'image') ?? []
  check('同步来的图真的进了审查 prompt', blocks.length === 1, blocks.length)
  check('同步图 + 通过结论 → 放行', gate.kind === 'allow', gate.kind)
}

// ── 场景 8e：宿主只暴露 saveImages（批量 API）时也要能送审 ──────────
{
  const sid = newScenario()
  const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.8, differences: [] })
  const calls = []
  const attachments = {
    async saveImages(items) {
      calls.push(items)
      return items.map((_, i) => `att://batch-${i}`)
    },
  }
  const { ctx } = makeContext({ subagents, attachments })
  apply(ctx, {})
  await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope())
  await ctx.fire('tools/execute', execOf('mcp__sw__capture', {}, sid), async () => okEnvelope({ artifacts: [{ kind: 'image', path: image }] }))
  const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
  check('saveImages-only 服务也能送审', subagents.calls.length === 1, subagents.calls.length)
  check('批量 API 收到图片数据', calls.length === 1 && calls[0][0]?.data?.length > 0, calls.length)
  check('saveImages-only 服务结论通过后放行', gate.kind === 'allow', gate.kind)
}

// ══════════════════════════════════════════════════════════════════════════
// 下面这批断言对应一次实测事故：审查门在 33 分钟里触发 4 次、合计 21 分 53 秒，
// 其中 2 次是废的。四个可证成因各有一条断言盯着：
//   1. compare 的并排图没被算成参考图 → prompt 说「这次没有参考图纸」、把握封顶 0.5；
//   2. 送审盲取最后四张 → 同一视角各两张、上视一张没进；
//   3. verify 已经 failed 仍照送视觉审查；
//   4. observe 子代理的缓存键用合成图指纹 → 每轮 miss，每轮白跑。
// ══════════════════════════════════════════════════════════════════════════

// ── 场景 9：compare 的并排图算参考图（左半幅就是图纸）────────────────
{
  const sid = newScenario()
  const data = isolatedDataDir('cmp-ref')
  try {
    const subagents = fakeSubagentsByLabel({
      observe: { observations: ['外轮廓是 L 形板', '板上有一个 Ø10 的孔'] },
      review: { verdict: 'passed', confidence: 0.85, differences: [] },
    })
    const attachments = { saveImage: async ({ name }) => `att://${name}` }
    const { ctx } = makeContext({ subagents, attachments })
    apply(ctx, {})
    const drawing = pngAt('drawing-01.png')
    const shot = pngAt('shot-01.png')
    const cmp = pngAt('cmp-01.png')
    await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope())
    await ctx.fire('tools/execute', execOf('mcp__sw__capture', { view: '*等轴测' }, sid),
      async () => okEnvelope({ artifacts: [{ kind: 'image', path: shot }] }))
    await ctx.fire('tools/execute', execOf('mcp__sw__inspect', { action: 'compare', compare: { drawing, view: 'top' } }, sid),
      async () => okEnvelope({
        artifacts: [{ kind: 'image', path: cmp }],
        changes: { drawing: { source: drawing, crop: [0, 0, 700, 452] }, model: { view: '*上视' } },
      }))
    const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))

    const review = reviewCall(subagents)
    const reviewText = review === undefined ? '' : promptTextOf(review)
    check('compare 的并排图被算成参考图（references 非空）', reviewText.includes(EXPECT_REFERENCE_LINE), reviewText.slice(0, 200))
    check('有参考图时 prompt 不再说「这次没有参考图纸」', reviewText.length > 0 && !reviewText.includes(NO_REFERENCE_LINE))
    check('有参考图时不再把把握封顶在 0.5', reviewText.length > 0 && !reviewText.includes('把握不要超过 0.5'))
    check('cmp-01.png 真的进了送审清单', reviewText.includes('cmp-01.png'))
    const observe = observeCalls(subagents)[0]
    check('observe 用 compare 时明确要求只看左半幅图纸', observe !== undefined && promptTextOf(observe).includes('左半幅'))
    check('compare 参考图 + 通过结论 → 放行', gate.kind === 'allow', gate.kind)
  } finally {
    data.restore()
  }
}

// ── 场景 9b：老 live.json 没写 origin → 按文件名反推（不能整盘压成 mcp）──
{
  const sid = newScenario()
  const data = isolatedDataDir('legacy-live')
  try {
    const shot = pngAt('shot-70.png')
    const cmp = pngAt('cmp-70.png')
    mkdirSync(join(data.dataDir, 'review'), { recursive: true })
    writeFileSync(join(data.dataDir, 'review', 'live.json'), JSON.stringify({
      version: 1,
      designs: {
        'p-legacy': {
          designId: 'p-legacy',
          revision: 4,
          updatedAt: new Date().toISOString(),
          images: [{ path: shot, atRevision: 4 }, { path: cmp, atRevision: 4 }],
        },
      },
    }, null, 2))
    const subagents = fakeSubagentsByLabel({
      observe: { observations: ['矩形外轮廓', '中间有一个圆孔'] },
      review: { verdict: 'passed', confidence: 0.8, differences: [] },
    })
    const attachments = { saveImage: async ({ name }) => `att://${name}` }
    const { ctx } = makeContext({ subagents, attachments })
    apply(ctx, {})
    const gate = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', { designId: 'p-legacy' }, sid), async () => ({ kind: 'allow' }))
    const review = reviewCall(subagents)
    const reviewText = review === undefined ? '' : promptTextOf(review)
    check('老 live.json 的 shot 按文件名反推成 capture', reviewText.includes('来源 capture'), reviewText.slice(0, 200))
    check('老 live.json 的 cmp 按文件名反推成 compare', reviewText.includes('来源 compare'))
    check('反推出来的 compare 让 references 非空', reviewText.includes(EXPECT_REFERENCE_LINE))
    check('老数据 + 通过结论 → 照常放行（向后兼容）', gate.kind === 'allow', gate.kind)
  } finally {
    data.restore()
  }
}

// ── 场景 10：同一视角 shot + cmp 只留一张，且优先 compare ──────────────
{
  const sid = newScenario()
  const data = isolatedDataDir('view-dedupe')
  try {
    const subagents = fakeSubagentsByLabel({
      observe: { observations: ['前视轮廓带两个台阶'] },
      review: { verdict: 'passed', confidence: 0.8, differences: [] },
    })
    const attachments = { saveImage: async ({ name }) => `att://${name}` }
    const { ctx } = makeContext({ subagents, attachments })
    apply(ctx, {})
    const drawing = pngAt('drawing-50.png')
    const shotA = pngAt('shot-50.png')
    const shotB = pngAt('shot-51.png')
    const cmp = pngAt('cmp-02.png')
    await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope())
    await ctx.fire('tools/execute', execOf('mcp__sw__capture', { view: '*前视' }, sid),
      async () => okEnvelope({ artifacts: [{ kind: 'image', path: shotA }] }))
    await ctx.fire('tools/execute', execOf('mcp__sw__capture', { view: '*前视' }, sid),
      async () => okEnvelope({ artifacts: [{ kind: 'image', path: shotB }] }))
    await ctx.fire('tools/execute', execOf('mcp__sw__inspect', { action: 'compare', compare: { drawing, view: 'front' } }, sid),
      async () => okEnvelope({
        artifacts: [{ kind: 'image', path: cmp }],
        changes: { drawing: { source: drawing, crop: [0, 0, 700, 452] }, model: { view: '*前视' } },
      }))
    await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
    const review = reviewCall(subagents)
    const reviewText = review === undefined ? '' : promptTextOf(review)
    check('同视角的 shot 与 cmp 只留一张', review !== undefined && imageCountOf(review) === 1, review === undefined ? 'no review' : imageCountOf(review))
    check('同视角优先留 compare（并排图信息量大）', reviewText.includes('cmp-02.png') && !reviewText.includes('shot-50.png'))
    check('送审清单写明视角', reviewText.includes('视角 前视'), reviewText.slice(0, 200))
  } finally {
    data.restore()
  }
}

// ── 场景 11：产出 8 张时上视（shot-20）必须入选，且同视角不重复 ────────
{
  const sid = newScenario()
  const data = isolatedDataDir('eight-shots')
  try {
    const subagents = fakeSubagentsByLabel({
      review: { verdict: 'incomplete', confidence: 0.4, differences: [] },
    })
    const attachments = { saveImage: async ({ name }) => `att://${name}` }
    const { ctx } = makeContext({ subagents, attachments })
    apply(ctx, {})
    const plan = [
      ['shot-17', '*等轴测'], ['shot-18', '*前视'], ['shot-19', '*右视'], ['shot-20', '*上视'],
      ['shot-21', '*等轴测'], ['shot-22', '*前视'], ['shot-23', '*右视'], ['shot-24', '*等轴测'],
    ]
    await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope())
    for (const [name, view] of plan) {
      const path = pngAt(`${name}.png`)
      await ctx.fire('tools/execute', execOf('mcp__sw__capture', { view }, sid),
        async () => okEnvelope({ artifacts: [{ kind: 'image', path }] }))
    }
    await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
    const review = reviewCall(subagents)
    const reviewText = review === undefined ? '' : promptTextOf(review)
    check('八张图只送 MAX_IMAGES=4 张', review !== undefined && imageCountOf(review) === 4, review === undefined ? 'no review' : imageCountOf(review))
    check('产出 8 张时上视（shot-20）必须入选', reviewText.includes('shot-20.png'), reviewText.slice(0, 240))
    check('送审清单里写着视角（上视）', reviewText.includes('视角 上视'))
    check('同视角不重复（三张等轴测只占一格）', (reviewText.match(/视角 等轴测/g) ?? []).length === 1)
  } finally {
    data.restore()
  }
}

// ── 场景 12：verify failed → 直接 deny，不 spawn，不吃审查额度 ─────────
{
  const sid = newScenario()
  const data = isolatedDataDir('verify-gate')
  try {
    const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.9, differences: [] })
    const attachments = { saveImage: async ({ name }) => `att://${name}` }
    const { ctx } = makeContext({ subagents, attachments })
    apply(ctx, {})
    const shot = pngAt('shot-60.png')
    await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope())
    await ctx.fire('tools/execute', execOf('mcp__sw__capture', {}, sid),
      async () => okEnvelope({ artifacts: [{ kind: 'image', path: shot }] }))
    // 服务端 inspect action=verify 明确 failed（量到了但不对）
    await ctx.fire('tools/execute', execOf('mcp__sw__inspect', { action: 'verify' }, sid), async () => okEnvelope({
      status: 'failed',
      summary: '验收未通过：Ø10 通孔数量（通过 0 条 / 不符 1 条）',
      changes: { checks: [{ name: 'Ø10 通孔数量', status: 'fail' }, { name: '孔位', status: 'pass' }] },
    }))
    const deliver = () => ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
    let last = null
    for (let i = 0; i < 7; i += 1) last = await deliver()
    check('verify failed 时 gate 直接 deny', last?.kind === 'deny', last?.kind)
    check('拒绝理由写清 VERIFY_FAILED 与「先按差异改模型」',
      String(last?.reason).includes('VERIFY_FAILED') && String(last?.reason).includes('先按这些差异改模型'),
      String(last?.reason).slice(0, 200))
    check('verify failed 不 spawn 审查', subagents.calls.length === 0, subagents.calls.length)
    check('verify failed 不吃审查额度（连拒 7 次也没变成额度用尽）',
      !/已经审了 \d+ 次/.test(String(last?.reason)), String(last?.reason).slice(0, 120))
    // 改成 ok 之后照样能送审：额度没被假审查吃掉
    await ctx.fire('tools/execute', execOf('mcp__sw__inspect', { action: 'verify' }, sid), async () => okEnvelope({
      summary: '验收通过（通过 1 条）',
      changes: { checks: [{ name: 'Ø10 通孔数量', status: 'pass' }] },
    }))
    const after = await deliver()
    check('补了 verify ok 之后照常送审（额度还在）', subagents.calls.length === 1, subagents.calls.length)
    check('verify 通过 + 审查通过 → 放行', after.kind === 'allow', after.kind)
  } finally {
    data.restore()
  }
}

// ── 场景 13：同一张图纸第二轮命中 observe 缓存，不再 spawn observe ──────
{
  const sid = newScenario()
  const data = isolatedDataDir('observe-cache')
  try {
    const subagents = fakeSubagentsByLabel({
      observe: { observations: ['外轮廓是矩形板', '左侧有一个通槽'] },
      review: { verdict: 'passed', confidence: 0.9, differences: [] },
    })
    const attachments = { saveImage: async ({ name }) => `att://${name}` }
    const { ctx } = makeContext({ subagents, attachments })
    apply(ctx, {})
    const drawing = pngAt('drawing-90.png')
    const figA = pngAt('fig-90.png')
    const figB = pngAt('fig-91.png')
    const shotA = pngAt('shot-90.png')
    const shotB = pngAt('shot-91.png')
    const figureEnvelope = (output) => okEnvelope({
      artifacts: [{ kind: 'image', path: output }],
      changes: { source: drawing, crop: [0, 0, 700, 452], output },
    })
    await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope())
    await ctx.fire('tools/execute', execOf('mcp__sw__capture', {}, sid),
      async () => okEnvelope({ artifacts: [{ kind: 'image', path: shotA }] }))
    await ctx.fire('tools/execute', execOf('mcp__sw__inspect', { action: 'figure' }, sid), async () => figureEnvelope(figA))
    const first = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
    check('第一轮：图纸裁剪 + 模型图 → 送审通过', first.kind === 'allow', first.kind)
    check('第一轮跑了 observe', observeCalls(subagents).length === 1, observeCalls(subagents).length)
    // 改几何、换一张裁剪块，但图纸还是同一张：observe 不该再跑
    await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'edit' }, sid), async () => okEnvelope())
    await ctx.fire('tools/execute', execOf('mcp__sw__capture', {}, sid),
      async () => okEnvelope({ artifacts: [{ kind: 'image', path: shotB }] }))
    await ctx.fire('tools/execute', execOf('mcp__sw__inspect', { action: 'figure' }, sid), async () => figureEnvelope(figB))
    const second = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))
    check('同一张图纸第二轮不再 spawn observe（缓存命中）', observeCalls(subagents).length === 1, observeCalls(subagents).length)
    check('第二轮仍然重新审了一次', subagents.calls.filter((spec) => specLabel(spec) === 'sw-review').length === 2,
      subagents.calls.filter((spec) => specLabel(spec) === 'sw-review').length)
    const secondReview = subagents.calls.filter((spec) => specLabel(spec) === 'sw-review').at(-1)
    check('第二轮复用了第一轮的原图清单（缓存真的用上了）',
      secondReview !== undefined && promptTextOf(secondReview).includes('外轮廓是矩形板'))
    check('第二轮审过就放行', second.kind === 'allow', second.kind)
  } finally {
    data.restore()
  }
}

// ── 场景 13b：路径里的 Desktop 不能被读成「上视」（英文视角词要整词匹配）──
{
  mkdirSync(join(dir, 'Desktop'), { recursive: true })
  const shots = ['shot-80.png', 'shot-81.png', 'shot-82.png'].map((name) => {
    const full = join(dir, 'Desktop', name)
    writeFileSync(full, PNG_1x1)
    return { path: full, origin: 'capture' }
  })
  const chosen = selectForReview(shots)
  // 若 Desktop 被误判成 top：三张同视角只能留一张（长度 1）。
  check('路径里的 Desktop 没被误判成上视（英文视角词整词匹配）', chosen.length === 3, chosen.length)
}

// ── 场景 14：verify 只放行 ok —— failed / incomplete / not-run 都拒，且回注可指导下一步 ──
// 四态语义（server/handleVerify）：ok 全量到且全对、failed 量到但不对、
// incomplete 有没量成的条目、not-run 一条语义核对都没跑。交付门禁只认 ok。
{
  const sid = newScenario()
  const data = isolatedDataDir('verify-ok-only')
  try {
    const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.9, differences: [] })
    const attachments = { saveImage: async ({ name }) => `att://${name}` }
    const { ctx } = makeContext({ subagents, attachments })
    apply(ctx, {})
    const shot = pngAt('shot-70.png')
    await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build' }, sid), async () => okEnvelope())
    await ctx.fire('tools/execute', execOf('mcp__sw__capture', {}, sid),
      async () => okEnvelope({ artifacts: [{ kind: 'image', path: shot }] }))
    const verify = (extra) => ctx.fire('tools/execute', execOf('mcp__sw__inspect', { action: 'verify' }, sid),
      async () => okEnvelope(extra))
    const deliver = () => ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', {}, sid), async () => ({ kind: 'allow' }))

    // incomplete：一条没量成（带 expected 与 available 候选）+ 一条通过。
    await verify({
      status: 'incomplete',
      summary: '验收未完成：1 条没量成（通过 1 条 / 没量成 1 条）',
      changes: {
        counts: { pass: 1, fail: 0, unmeasured: 1 },
        checks: [
          {
            name: 'Ø10 通孔数量',
            status: 'unmeasured',
            measure: 'holes',
            expected: 2,
            reason: 'NO_MEASUREMENT',
            note: '按 count 没取到数',
            available: { diameters: [5, 10, 18] },
          },
          { name: '孔位', status: 'pass' },
        ],
      },
    })
    const incomplete = await deliver()
    const incompleteReason = String(incomplete?.reason ?? '')
    check('verify incomplete → 拒绝（VERIFY_INCOMPLETE，回注逐条列 unmeasured 与 available 候选）',
      incomplete?.kind === 'deny'
        && incompleteReason.startsWith('VERIFY_INCOMPLETE')
        && incompleteReason.includes('Ø10 通孔数量')
        && incompleteReason.includes('期望 2')
        && incompleteReason.includes('available.diameters')
        && incompleteReason.includes('inspect action="verify"'),
      incompleteReason.slice(0, 260))

    // not-run：一条语义核对都没跑。
    await verify({
      status: 'not-run',
      summary: '没有期望值，未执行核对',
      changes: { counts: { pass: 0, fail: 0, unmeasured: 0 }, checks: [] },
    })
    const notRun = await deliver()
    check('verify not-run → 拒绝（VERIFY_NOT_RUN，要求先带 expect 跑一次）',
      notRun?.kind === 'deny'
        && String(notRun?.reason).startsWith('VERIFY_NOT_RUN')
        && String(notRun?.reason).includes('带 expect')
        && String(notRun?.reason).includes('inspect action="verify"'),
      String(notRun?.reason).slice(0, 200))

    // failed：量到了但不对（错误码与既有行为一致）。
    await verify({
      status: 'failed',
      summary: '验收未通过：Ø10 通孔数量（通过 0 条 / 不符 1 条）',
      changes: { counts: { pass: 0, fail: 1, unmeasured: 0 }, checks: [{ name: 'Ø10 通孔数量', status: 'fail' }] },
    })
    const failed = await deliver()
    check('verify failed → 拒绝（VERIFY_FAILED，错误码不变）',
      failed?.kind === 'deny' && String(failed?.reason).startsWith('VERIFY_FAILED'),
      String(failed?.reason).slice(0, 200))

    // ok：全量到且全对 —— 才允许走视觉审查，审查通过即放行。
    await verify({
      summary: '验收通过（通过 1 条）',
      changes: { counts: { pass: 1, fail: 0, unmeasured: 0 }, checks: [{ name: 'Ø10 通孔数量', status: 'pass' }] },
    })
    const ok = await deliver()
    check('verify ok → 放行（送审通过后 allow）', ok?.kind === 'allow', ok?.kind)
  } finally {
    data.restore()
  }
}

// ── 场景 15-17：服务侧 verify 记账（live.json → 审查门），只认同一版 ──────
//
// PTC 模式下 inspect action="verify" 发生在 run_code 内部，插件看不到那次子调用，
// 所以服务把它写进 review/live.json 的 record.verify（server.mjs trackLive →
// review-live.mjs recordVerify）。这里直接写 live.json，验读取侧的三种情形：
//   ① verify 存在、revision 与记录一致、status ok → 放行（送审通过）；
//   ② revision 对不上（几何改过）→ VERIFY_NOT_RUN：旧证据不得过关；
//   ③ incomplete → VERIFY_INCOMPLETE，回注列出哪条没量到。
function writeLiveVerify({ designId, revision, image, verify }) {
  const root = process.env.SW_MCP_DATA
  mkdirSync(join(root, 'review'), { recursive: true })
  const record = {
    designId,
    revision,
    updatedAt: new Date().toISOString(),
    documentPath: join(dir, `${designId}.SLDPRT`),
    images: [{ path: image, atRevision: revision, at: new Date().toISOString(), origin: 'capture' }],
    ...(verify === undefined ? {} : { verify }),
  }
  writeFileSync(join(root, 'review', 'live.json'),
    JSON.stringify({ version: 1, designs: { [designId]: record } }, null, 2))
}
const verifyRecord = (revision, extra = {}) => ({
  status: 'ok',
  checks: [{ name: 'Ø10 通孔数量', status: 'pass' }],
  unmeasured: [],
  revision,
  at: new Date().toISOString(),
  checkCount: 1,
  summary: '验收通过（通过 1 条）',
  ...extra,
})
async function liveVerifyDeliver({ label, shotName, revision, verify }) {
  const sid = newScenario()
  const data = isolatedDataDir(label)
  try {
    const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.9, differences: [] })
    const attachments = { saveImage: async ({ name }) => `att://${name}` }
    const { ctx } = makeContext({ subagents, attachments })
    apply(ctx, {})
    const shot = pngAt(shotName)
    const designId = `p-live-${sid}`
    writeLiveVerify({ designId, revision, image: shot, verify })
    const deliver = () => ctx.fire('tools/pre-execute',
      execOf('mcp__sw__deliver', { designId }, sid), async () => ({ kind: 'allow' }))
    return { gate: await deliver(), subagents }
  } finally {
    data.restore()
  }
}
{
  const { gate } = await liveVerifyDeliver({
    label: 'live-verify-ok', shotName: 'shot-96.png', revision: 3, verify: verifyRecord(3),
  })
  check('服务侧 verify（同一 revision + ok）→ 放行', gate?.kind === 'allow',
    `${gate?.kind}: ${String(gate?.reason ?? '').slice(0, 180)}`)
}
{
  // 几何改过：记录 revision 4，verify 是 revision 3 量的 → 旧证据作废。
  const { gate } = await liveVerifyDeliver({
    label: 'live-verify-stale', shotName: 'shot-97.png', revision: 4, verify: verifyRecord(3),
  })
  check('服务侧 verify 的 revision 与记录不一致 → VERIFY_NOT_RUN（不得用旧证据过关）',
    gate?.kind === 'deny' && String(gate?.reason).startsWith('VERIFY_NOT_RUN')
      && String(gate?.reason).includes('revision 3'),
    `${gate?.kind}: ${String(gate?.reason ?? '').slice(0, 220)}`)
}
{
  const { gate } = await liveVerifyDeliver({
    label: 'live-verify-incomplete', shotName: 'shot-98.png', revision: 5,
    verify: verifyRecord(5, {
      status: 'incomplete',
      checks: [{ name: 'Ø10 通孔数量', status: 'unmeasured', expected: 2, reason: 'NO_MEASUREMENT', available: { diameters: [5, 10] } }],
      unmeasured: [{ name: 'Ø10 通孔数量', expected: 2, reason: 'NO_MEASUREMENT', available: { diameters: [5, 10] } }],
      summary: '验收未完成：1 条没量成',
    }),
  })
  check('服务侧 verify incomplete → VERIFY_INCOMPLETE（回注列出没量到的条目）',
    gate?.kind === 'deny' && String(gate?.reason).startsWith('VERIFY_INCOMPLETE')
      && String(gate?.reason).includes('Ø10 通孔数量')
      && String(gate?.reason).includes('available.diameters'),
    `${gate?.kind}: ${String(gate?.reason ?? '').slice(0, 220)}`)
}

// ══════════════════════════════════════════════════════════════════════════
// 下面这批断言对应 review-gate 的额度 / force / 留痕三处修复：
//   1. 额度按 designId 计（缺陷 #1/#10/#9）：同一会话做第二个零件时额度从 0 起算；
//   2. force:"manual" 只豁免视觉审查与额度，不豁免确定性门禁（缺陷 #6）；
//   3. bypass.jsonl 留痕要带 verdict/verify/reviews 三个字段（缺陷 #7）。
// ══════════════════════════════════════════════════════════════════════════

// ── 场景 18：额度按设计隔离 —— 设计 A 耗尽不影响设计 B ──────────────
{
  const sid = newScenario()
  const data = isolatedDataDir('budget-per-design')
  try {
    const subagents = fakeSubagents({
      verdict: 'different', confidence: 0.5,
      differences: [{ region: 'x', expected: 'a', actual: 'b' }],
    })
    const attachments = { saveImage: async ({ name }) => `att://${name}` }
    const { ctx } = makeContext({ subagents, attachments })
    apply(ctx, {})
    const shot = pngAt('shot-110.png')
    const edit = (designId) => ctx.fire('tools/execute',
      execOf('mcp__sw__model', { action: 'edit', designId }, sid),
      async () => okEnvelope({ designId, image: { path: shot } }))
    const deliver = (designId) => ctx.fire('tools/pre-execute',
      execOf('mcp__sw__deliver', { designId }, sid), async () => ({ kind: 'allow' }))

    // 设计 A：每版都改一次再交付 → 6 次真审查把额度用满。
    let lastA = null
    for (let i = 0; i < 6; i += 1) {
      await edit('A')
      lastA = await deliver('A')
    }
    check('设计 A 用满额度的最后一次仍是真 spawn（不是额度 deny）',
      lastA?.kind === 'deny' && subagents.calls.length === 6 && !/已经审了/.test(String(lastA?.reason)),
      `${lastA?.kind}/${subagents.calls.length}`)

    // 再改一版但不再审：A 的额度已耗尽 → 额度门 deny（不再 spawn）。
    await edit('A')
    const exhausted = await deliver('A')
    check('设计 A 额度耗尽 → 额度门 deny，且文案报的是「已经审了 6 次」',
      exhausted?.kind === 'deny'
        && String(exhausted?.reason).includes('已经审了 6 次')
        && subagents.calls.length === 6,
      `${subagents.calls.length}: ${String(exhausted?.reason).slice(0, 160)}`)

    // 换设计 B：B 自己一次都没审过 —— 必须真的 spawn 一次，不能继承 A 的 6 次。
    const beforeB = subagents.calls.length
    await edit('B')
    const firstB = await deliver('B')
    check('换设计 B 后仍 spawn 一次审查（额度按设计隔离，不继承 A 的 6 次）',
      subagents.calls.length === beforeB + 1, `${beforeB} -> ${subagents.calls.length}`)
    check('换设计 B 后的拒绝不是额度门（理由里没有「已经审了 … 次」）',
      firstB?.kind === 'deny' && !String(firstB?.reason).includes('已经审了'),
      String(firstB?.reason).slice(0, 160))
    check('设计 B 的拒绝理由带着它自己这一版的审查差异', String(firstB?.reason).includes('x'))
  } finally {
    data.restore()
  }
}

// ── 场景 19：force:"manual" 不豁免确定性门禁（verify failed / incomplete）──
{
  const sid = newScenario()
  const data = isolatedDataDir('force-vs-verify')
  try {
    const subagents = fakeSubagents({ verdict: 'passed', confidence: 0.9, differences: [] })
    const attachments = { saveImage: async ({ name }) => `att://${name}` }
    const { ctx } = makeContext({ subagents, attachments })
    apply(ctx, {})
    const designId = 'p-force'
    const shot = pngAt('shot-120.png')
    await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'build', designId }, sid),
      async () => okEnvelope({ designId }))
    await ctx.fire('tools/execute', execOf('mcp__sw__capture', { designId }, sid),
      async () => okEnvelope({ designId, artifacts: [{ kind: 'image', path: shot }] }))
    const verify = (extra) => ctx.fire('tools/execute',
      execOf('mcp__sw__inspect', { action: 'verify', designId }, sid),
      async () => okEnvelope({ designId, ...extra }))
    const forceDeliver = () => ctx.fire('tools/pre-execute',
      execOf('mcp__sw__deliver', { designId, force: 'manual', reason: '用户确认按现在这版交付' }, sid),
      async () => ({ kind: 'allow' }))

    await verify({ status: 'failed', changes: { checks: [{ name: 'Ø10 通孔数量', status: 'fail' }] } })
    const failed = await forceDeliver()
    check('force:"manual" 也挡不住 verify failed（必须 VERIFY_FAILED 拒绝）',
      failed?.kind === 'deny' && String(failed?.reason).startsWith('VERIFY_FAILED'),
      `${failed?.kind}: ${String(failed?.reason).slice(0, 160)}`)

    await verify({
      status: 'incomplete',
      changes: {
        counts: { pass: 0, fail: 0, unmeasured: 1 },
        checks: [{ name: 'Ø10 通孔数量', status: 'unmeasured', expected: 2, available: { diameters: [10] } }],
      },
    })
    const incomplete = await forceDeliver()
    check('force:"manual" 也挡不住 verify incomplete（必须 VERIFY_INCOMPLETE 拒绝）',
      incomplete?.kind === 'deny' && String(incomplete?.reason).startsWith('VERIFY_INCOMPLETE'),
      `${incomplete?.kind}: ${String(incomplete?.reason).slice(0, 160)}`)

    check('被确定性门禁拦下时没有 spawn 视觉审查', subagents.calls.length === 0, subagents.calls.length)
    check('被确定性门禁拦下时没有写绕过留痕（force 不再提前 return）',
      !existsSync(join(data.dataDir, 'review', 'bypass.jsonl')),
      join(data.dataDir, 'review', 'bypass.jsonl'))

    // 对照：verify 补成 ok 之后 force 才真的放行 —— 逃生口没被堵死。
    await verify({ changes: { checks: [{ name: 'Ø10 通孔数量', status: 'pass' }] } })
    const passed = await forceDeliver()
    check('verify ok 后 force:"manual" 仍然放行（人的逃生口还在）', passed?.kind === 'allow', passed?.kind)
    let bypass = ''
    try {
      bypass = readFileSync(join(data.dataDir, 'review', 'bypass.jsonl'), 'utf8')
    } catch { /* 下面的断言会失败 */ }
    check('verify ok 后 force 真的写了绕过留痕', bypass.trim().length > 0, bypass.length)
  } finally {
    data.restore()
  }
}

// ── 场景 20：bypass 留痕带 verdict / verify / reviews（缺陷 #7）──────
{
  const sid = newScenario()
  const data = isolatedDataDir('bypass-fields')
  try {
    const subagents = fakeSubagents({
      verdict: 'different', confidence: 0.5,
      differences: [{ region: 'x', expected: 'a', actual: 'b' }],
    })
    const attachments = { saveImage: async ({ name }) => `att://${name}` }
    const { ctx } = makeContext({ subagents, attachments })
    apply(ctx, {})
    const designId = 'p-bypass'
    const shot = pngAt('shot-130.png')
    const edit = () => ctx.fire('tools/execute',
      execOf('mcp__sw__model', { action: 'edit', designId }, sid),
      async () => okEnvelope({ designId, image: { path: shot } }))
    const verifyOk = () => ctx.fire('tools/execute',
      execOf('mcp__sw__inspect', { action: 'verify', designId }, sid),
      async () => okEnvelope({ designId, changes: { checks: [{ name: 'Ø10 通孔数量', status: 'pass' }] } }))
    const deliver = () => ctx.fire('tools/pre-execute',
      execOf('mcp__sw__deliver', { designId }, sid), async () => ({ kind: 'allow' }))

    // 每版都 verify ok（确定性门禁现在挡在 force 前面），审 6 次把额度用满。
    for (let i = 0; i < 6; i += 1) {
      await edit()
      await verifyOk()
      await deliver()
    }
    check('场景 20：6 次真审查都已发生', subagents.calls.length === 6, subagents.calls.length)

    // 第 7 版：verify ok 但额度已满 → 额度门 deny（不再 spawn）。
    await edit()
    await verifyOk()
    const denied = await deliver()
    check('场景 20：额度耗尽时交付被额度门拦下',
      denied?.kind === 'deny' && String(denied?.reason).includes('已经审了 6 次')
        && subagents.calls.length === 6,
      String(denied?.reason).slice(0, 140))

    const quota = readAudit(data.dataDir).find((entry) => entry.event === 'quota-deny')
    check('额度拒绝落盘，保留当前版本、上一版结论与当前核对', quota?.designId === designId
      && quota.code === 'REVIEW_QUOTA_EXCEEDED' && quota.revision === 7 && quota.reviewedRevision === 6
      && quota.reviews === 6 && quota.reviewLimit === 6 && quota.verdict === 'different'
      && quota.verify?.atRevision === 7 && quota.verify?.status === 'ok', quota)

    // 逃生口：verify ok + 图齐 + 额度耗尽 → force:"manual" 放行并留痕。
    const forced = await ctx.fire('tools/pre-execute',
      execOf('mcp__sw__deliver', { designId, force: 'manual', reason: '用户确认按现在这版交付' }, sid),
      async () => ({ kind: 'allow' }))
    check('场景 20：verify ok + 额度耗尽时 force:"manual" 放行', forced?.kind === 'allow', forced?.kind)

    let lines = []
    try {
      lines = readFileSync(join(data.dataDir, 'review', 'bypass.jsonl'), 'utf8').trim().split(String.fromCharCode(10))
    } catch { /* 下面的断言会失败 */ }
    let record = {}
    try {
      record = JSON.parse(lines.at(-1) ?? '{}')
    } catch { /* 下面的断言会失败 */ }
    check('bypass 留痕带 verdict / verify / reviews 三个键',
      Object.hasOwn(record, 'verdict') && Object.hasOwn(record, 'verify') && Object.hasOwn(record, 'reviews'),
      Object.keys(record))
    check('bypass 的 reviews 是数字且等于这条设计已审次数', record.reviews === 6, record.reviews)
    check('bypass 的 verify 记下当时的核对状态（ok）', record.verify?.status === 'ok', record.verify)
    check('bypass 的 verdict 记下当时的审查结论（different + 差异条数）',
      record.verdict?.verdict === 'different' && record.verdict?.differences === 1, record.verdict)
  } finally {
    data.restore()
  }
}

function readAudit(dataDir, ...file) {
  const path = join(dataDir, ...(file.length ? file : ['logs', 'review.jsonl']))
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

const passedVerdict = { verdict: 'passed', confidence: 0.9, differences: [] }
const saveAttachment = { saveImage: async ({ name }) => `att://${name}` }
const allow = async () => ({ kind: 'allow' })
const turn = (ctx, sid) => ctx.fire('agent/turn-stopping', { agent: execOf('', {}, sid).agent })
const endAsyncCallbacks = () => new Promise((resolve) => setImmediate(resolve))

{
  const data = isolatedDataDir('non-image-evidence')
  try {
    const { ctx } = makeContext({ subagents: fakeSubagents(passedVerdict), attachments: saveAttachment })
    apply(ctx, {})
    const sid = newScenario()
    const designId = 'filter-live-evidence'
    const reviewDir = join(data.dataDir, 'review')
    mkdirSync(reviewDir)
    const invalid = join(reviewDir, 'runs.json')
    writeFileSync(invalid, '{"sessions":{}}')
    const live = join(reviewDir, 'live.json')
    const writeLive = (images) => writeFileSync(live, JSON.stringify({
      designs: { [designId]: { designId, revision: 2, images } },
    }))
    writeLive([{ path: invalid, origin: 'capture', atRevision: 2 }])
    const deliver = () => ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', { designId }, sid), allow)
    const withoutImages = await deliver()
    check('live.json 中只有 runs.json 时不会被当成图通过', withoutImages.kind === 'deny'
      && withoutImages.reason.includes('没有留下任何图'), withoutImages)
    const valid = pngAt('shot-LIVE.PNG')
    writeLive([{ path: invalid, origin: 'capture' }, { path: valid, origin: 'capture' }, null])
    const withImage = await deliver()
    const state = JSON.parse(readFileSync(invalid, 'utf8')).sessions[sid]
    check('合法图和旧污染并存时只同步图片', withImage.kind === 'allow'
      && state?.images.length === 1 && state.images[0].path === valid, state?.images)
  } finally {
    data.restore()
  }
}

for (const variant of ['unavailable', 'exception', 'no-verdict']) {
  const data = isolatedDataDir(`prewarm-${variant}`)
  try {
    const sid = newScenario()
    const designId = `prewarm-${variant}`
    const subagents = variant === 'unavailable' ? undefined : variant === 'no-verdict'
      ? fakeSubagents(undefined)
      : { async startActivation() { throw new Error('mock route failure') } }
    const { ctx } = makeContext({ subagents, attachments: saveAttachment })
    apply(ctx, {})
    await ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'edit' }, sid),
      async () => okEnvelope({ designId, image: { path: image } }))
    await turn(ctx, sid)
    await endAsyncCallbacks()
    const [event] = readAudit(data.dataDir)
    check(`预热 ${variant} 留痕并保留设计与版本，不消耗额度`, event.event === 'prewarm-failure'
      && event.designId === designId && event.revision === 1 && event.reviews === 0
      && event.code === { unavailable: 'PREWARM_UNAVAILABLE', exception: 'REVIEW_MODEL_UNAVAILABLE', 'no-verdict': 'PREWARM_NO_VERDICT' }[variant],
      event)
    check(`预热 ${variant} 不覆盖当前结论状态盘`, !existsSync(join(data.dataDir, 'review', 'runs.json')))
  } finally {
    data.restore()
  }
}

{
  const data = isolatedDataDir('prewarm-design-race')
  try {
    const sid = newScenario()
    let resolveReview, signalStarted
    const started = new Promise((resolve) => { signalStarted = resolve })
    let calls = 0
    const subagents = {
      async startActivation() {
        calls += 1
        if (calls === 1) {
          const result = new Promise((resolve) => { resolveReview = resolve })
          signalStarted()
          return { result }
        }
        return { result: Promise.resolve({ structured: { ...passedVerdict, verdict: 'different' } }) }
      },
    }
    const { ctx } = makeContext({ subagents, attachments: saveAttachment })
    apply(ctx, {})
    const edit = (designId) => ctx.fire('tools/execute', execOf('mcp__sw__model', { action: 'edit' }, sid),
      async () => okEnvelope({ designId, image: { path: image } }))
    await edit('design-a')
    await turn(ctx, sid)
    await started
    await edit('design-b')
    resolveReview({ structured: passedVerdict })
    await endAsyncCallbacks()
    const [stale] = readAudit(data.dataDir)
    check('设计切换时，迟到的预热结论仍记在原设计和版本', stale.code === 'PREWARM_STALE'
      && stale.designId === 'design-a' && stale.revision === 1 && stale.reviews === 1, stale)
    const decision = await ctx.fire('tools/pre-execute', execOf('mcp__sw__deliver', { designId: 'design-b' }, sid), allow)
    const latest = readAudit(data.dataDir).at(-1)
    check('另一设计版本号与截图相同也必须独立审查', decision.kind === 'deny' && calls === 2
      && latest.designId === 'design-b' && latest.reviews === 1, decision)
  } finally {
    data.restore()
  }
}

for (const failAll of [false, true]) {
  const data = isolatedDataDir('manual-audit-write')
  try {
    const sid = newScenario()
    const { ctx, warnings } = makeContext()
    apply(ctx, {})
    const designId = 'manual-audit'
    mkdirSync(join(data.dataDir, 'review', 'bypass.jsonl'), { recursive: true })
    if (failAll) {
      mkdirSync(join(data.dataDir, 'logs', 'review.jsonl'), { recursive: true })
      mkdirSync(join(data.dataDir, 'review', 'gate-audit.jsonl'))
    }
    const result = await ctx.fire('tools/pre-execute',
      execOf('mcp__sw__deliver', { designId, force: 'manual', reason: '用户已确认' }, sid), allow)
    check('审批后的手动交付保留原有放行，审计故障有明确告警', result.kind === 'allow'
      && warnings.some((msg) => msg.includes('BYPASS_AUDIT_WRITE_FAILED')), warnings)
    if (!failAll) {
      const [event] = readAudit(data.dataDir)
      check('绕过主文件故障时审查时间线持久保存完整事件', event.event === 'manual-bypass'
        && event.code === 'FORCE_MANUAL' && event.designId === designId && event.reason === '用户已确认'
        && !!event.auditWriteError, event)
    } else {
      check('所有审计目标不可写时明确报告未落盘', warnings.some((msg) => msg.includes('手动交付审计未落盘')), warnings)
    }
  } finally {
    data.restore()
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(failures.map((name) => `  - ${name}`).join('\n'))
  process.exitCode = 1
}
