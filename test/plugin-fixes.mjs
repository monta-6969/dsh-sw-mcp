// 「插件问题」这一轮的回归：全部离线（不需要 SOLIDWORKS、不起桥接器、不碰 broker）。
//
// 每一条都对着一个**真机会话里造成过损失的**行为，而不是对着实现细节：
//   1. dimensions 写动作「落地了但全是参考尺寸」必须报失败，不能报 ok；
//   2. inspect action="bodies" 不再因为字段位置不同抛 TypeError；
//   3. model action="undo" 回撤前后都给数字，并给出可回滚的 baseline；
//   4. target:"doc" 的语义：给了 designId 就按 designId 解析（桥接器侧）；
//   5. 门禁的提示词不再自相矛盾（「跑一次就够」 vs 「必须等于当前 revision」）；
//   6. 选择类调用选中 0 个对象（SelectByID2 照样返回 true）必须报失败。
//
// 桥接器侧的两条用源码断言：它们是编译期行为，离线跑不到 COM。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import z from 'zod'
import { registerObserveTools } from '../server/tools-observe.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) passed += 1
  else failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok && detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

const read = (rel) => readFileSync(join(repo, rel), 'utf8')

// ── 最小 fake server（与 test/gate-revision.mjs 同款）────────────────────────
//
// envelope/failed 必须与 server.mjs 同形，否则断言会在假的形状上通过：
//   · envelope 一定要补 status:'ok'（真实现有默认值），否则「成功路径」永远是 undefined；
//   · failed 一定要把 nextActions 带出来（真实现里就是透传），否则「下一步指向哪」验不了。
function observeHandlers({ callBridge }) {
  const handlers = new Map()
  const server = {
    registerTool(name, definition, handler) { handlers.set(name, handler) },
  }
  registerObserveTools(server, z, {
    envelope: ({ summary, designId, status = 'ok', changes, measurements, artifacts, nextActions, capabilities, timings, extra }) => ({
      summary,
      designId: designId ?? null,
      status,
      ...(changes ? { changes } : {}),
      ...(measurements ? { measurements } : {}),
      ...(artifacts ? { artifacts } : {}),
      ...(nextActions ? { nextActions } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(timings ? { timings } : {}),
      ...(extra ? { extra } : {}),
    }),
    ok: (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] }),
    failed: ({ op, designId, error, nextActions }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary: `${op} 失败：${error.message}`,
          designId: designId ?? null,
          status: 'failed',
          ...(nextActions ? { nextActions } : {}),
          extra: { error: { code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) } },
        }),
      }],
    }),
    fail: (code, message, detail) => Object.assign(new Error(message), { code, detail }),
    callBridge,
    resolveDesignId: (value) => (typeof value === 'string' && value.length > 0 ? value : null),
    designIdArg: z.string().optional(),
    readFileSync, join, tmpdir: () => 'C:\\Temp', dataDir: 'C:\\Temp\\sw-mcp',
    handlePartCheck: async () => ({}), handlePartInspect: async () => ({}), handlePartExport: async () => ({}),
    recordRelationAudit: () => null,
    liveRevisionOf: () => 1,
    documentIdentityCheck: () => ({ ok: true }),
    requireDesignId: (value) => {
      if (typeof value === 'string' && value.length > 0) return value
      throw Object.assign(new Error('DESIGN_ID_REQUIRED'), { code: 'DESIGN_ID_REQUIRED' })
    },
  })
  return handlers
}

const parse = (result) => JSON.parse(result.content.find((c) => c.type === 'text').text)

// ── 1. dimensions：写动作落地的是参考尺寸 → 必须 failed ────────────────────
{
  const handlers = observeHandlers({
    callBridge: async (op) => {
      if (op !== 'dimensions') throw new Error(`unexpected op ${op}`)
      return {
        sketch: '草图1',
        applied: [
          { index: 0, kind: 'distance', valueMm: 40, reference: true, driving: false },
        ],
        dimensions: [
          { index: 1, kind: 'distance', valueMm: 40, reference: true, driving: false },
        ],
        reference: 1,
        driving: 0,
      }
    },
  })
  const result = parse(await handlers.get('inspect')({
    action: 'dimensions', designId: 'plate-1', dimensionAction: 'add',
    dimensions: [{ kind: 'distance', refs: ['seg:1'], valueMm: 40 }],
  }))
  check('dimensions add 全是参考尺寸 → status=failed', result.status === 'failed', result.status)
  check('dimensions add 摘要点明「参考尺寸（改不动的）」',
    /参考尺寸/.test(result.summary ?? '') && /改不动/.test(result.summary ?? ''), result.summary)
  check('dimensions 回包顶层带 driving/reference 计数',
    result.changes?.driving === 0 && result.changes?.reference === 1,
    { driving: result.changes?.driving, reference: result.changes?.reference })
  check('dimensions 提示不要把它当成参数化落地',
    String(result.nextActions?.[0] ?? '').includes('驱动不了模型'), result.nextActions)
}

// ── 2. dimensions：一个尺寸都没加上 → failed，而不是「新增 0 个」的 ok ────
{
  const handlers = observeHandlers({
    callBridge: async () => ({ sketch: '草图1', applied: [], dimensions: [], reference: 0, driving: 0 }),
  })
  const result = parse(await handlers.get('inspect')({
    action: 'dimensions', designId: 'plate-2', dimensionAction: 'add',
    dimensions: [{ kind: 'distance', refs: ['seg:9'], valueMm: 40 }],
  }))
  check('dimensions add 一条没落地 → status=failed', result.status === 'failed', result.status)
  check('dimensions add 一条没落地 → 摘要说实话', /一个尺寸都没加上/.test(result.summary ?? ''), result.summary)
}

// ── 3. dimensions：真正驱动成功的老路径不能被误伤 ────────────────────────
{
  const handlers = observeHandlers({
    callBridge: async () => ({
      sketch: '草图1',
      applied: [{ index: 0, kind: 'distance', valueMm: 40, reference: false, driving: true }],
      dimensions: [{ index: 1, kind: 'distance', valueMm: 40, reference: false, driving: true }],
      reference: 0,
      driving: 1,
    }),
  })
  const result = parse(await handlers.get('inspect')({
    action: 'dimensions', designId: 'plate-3', dimensionAction: 'add',
    dimensions: [{ kind: 'distance', refs: ['seg:1'], valueMm: 40 }],
  }))
  check('dimensions add 驱动成功 → status=ok', result.status === 'ok', result.status)
  check('dimensions add 驱动成功 → 摘要仍报新增数', /新增 1 个尺寸/.test(result.summary ?? ''), result.summary)
}

// ── 4. bodies：字段在 changes.measurements 里也要读得到（不再 TypeError）──
{
  const handlers = observeHandlers({
    callBridge: async (op) => {
      if (op !== 'bodies') throw new Error(`unexpected op ${op}`)
      // 实测出现过的另一种形状：数值在 measurements 里，不在顶层。
      return {
        document: { title: '零件9.SLDPRT', path: 'C:\\x\\零件9.SLDPRT' },
        bodies: [{ index: 1 }],
        count: 1,
        measurements: { totalVolumeMm3: 4000, bodyCount: 1 },
      }
    },
  })
  const result = parse(await handlers.get('inspect')({ action: 'bodies', designId: 'b-1' }))
  check('bodies 字段在 measurements 里也算量到了（不抛 TypeError）',
    result.status === 'ok' && result.measurements?.totalVolumeMm3 === 4000,
    { status: result.status, measurements: result.measurements })
  check('bodies 摘要里带体积', /4000/.test(result.summary ?? ''), result.summary)
}

// ── 5. bodies：真量不到时给 null + 解释，而不是静默 0 ──────────────────
{
  const handlers = observeHandlers({
    callBridge: async () => ({ document: { title: '曲面1.SLDPRT' }, bodies: [], count: 0 }),
  })
  const result = parse(await handlers.get('inspect')({ action: 'bodies', designId: 'b-2' }))
  check('bodies 没量到体积 → measurements 是 null（不是 0）',
    result.measurements?.totalVolumeMm3 === null, result.measurements)
  check('bodies 没量到体积 → 给出下一步', /bodyType/.test(String(result.nextActions?.[0] ?? '')), result.nextActions)
}

// ── 6. 桥接器侧：target:"doc" 由 designId 决定（源码断言）─────────────────
{
  const reflect = read('bridge/src/Reflect.cs')
  check('Reflect.Target 接受 req（能看 designId）',
    /static object Target\(SwHost h, Dictionary<string, object> req, string name\)/.test(reflect))
  check('给了 designId → 走 Operations.DesignDocument，不退回前台',
    /if \(!string\.IsNullOrEmpty\(designId\)\)/.test(reflect)
      && /Operations\.DesignDocument\(h, designId\)/.test(reflect))
  check('解析不到 designId → DOC_NOT_OPEN（明确拒绝，不静默兜底）',
    /DOC_NOT_OPEN/.test(reflect) && /never falls back/.test(reflect))
  check('activeDoc 是显式入口（旧行为只能显式选）',
    /key == "activedoc"/.test(reflect))
  check('invoke 回包里带 document（哪份文档被动了）',
    /answer\["document"\]/.test(reflect) && /Stamp\(answer, hit, req\)/.test(reflect))
}

// ── 7. 桥接器侧：写尺寸前先进编辑态，落成参考尺寸就拒（源码断言）─────────
{
  const dims = read('bridge/src/SketchDimensioner.cs')
  check('dimensions add 前 EnsureEditMode', /action, "add"[\s\S]{0,400}EnsureEditMode\(doc, sketchName, notes\)/.test(dims))
  check('dimensions edit 前 EnsureEditMode', /action, "edit"[\s\S]{0,600}EnsureEditMode\(doc, sketchName, notes\)/.test(dims))
  check('落成参考尺寸 → DIMENSION_NOT_DRIVING', /DIMENSION_NOT_DRIVING/.test(dims))
  check('dimensions list 顶层给 driving/reference 计数',
    /result\["driving"\] = driving/.test(dims) && /result\["reference"\] = reference/.test(dims))
}

// ── 8. 门禁措辞：不再自相矛盾 ───────────────────────────────────────────
{
  const gate = read('review-gate.js')
  check('门禁提示不再说「跑一次就够」', !gate.includes('跑一次就够'), gate.includes('跑一次就够'))
  check('门禁提示改成「改一次就要重读一次」', gate.includes('改一次就要重读一次'))
  const observe = read('server/tools-observe.mjs')
  check('inspect 描述里 relations 的措辞同步收窄',
    !observe.includes('跑一次就够') && observe.includes('改过几何或尺寸之后必须重跑一次'))
}

// ── 9. undo：回撤前后都量，并给 baseline ────────────────────────────────
{
  const server = read('server/server.mjs')
  check('undo 读撤销前几何（before）', /const before = readShape\(await callBridge\('inspect'/.test(server))
  check('undo 回包里有 volumeBefore/volumeAfter/volumeDelta',
    /volumeBefore: before\.volume/.test(server) && /volumeAfter: after\.volume/.test(server) && /volumeDelta: delta/.test(server))
  check('undo 回包里有可照着重建的 baseline（体积+包围盒+实体数）',
    /baseline: \{ volume: before\.volume, boundingBox: before\.boundingBox, bodies: before\.bodies \}/.test(server))
  check('undo 按真实嵌套几何取体积（massProperties.volume，不是顶层 volume）',
    /geometry\?\.massProperties\?\.volume/.test(server))
  check('undo 按真实嵌套几何取包围盒（boundingBox.size）',
    /geometry\?\.boundingBox\?\.size/.test(server))
  check('undo schema 明说「按特征步进，不是事务回滚」',
    /按特征步进，不是事务回滚/.test(server))
  check('undo 的下一步不让继续 undo 追', /撤错了不要再用 undo 追/.test(server))
}

// ── 10. invoke 把 designId 送到桥接器，并暴露 activeDocument ─────────────
{
  const server = read('server/server.mjs')
  check('invoke 把 designId 往下传', /invokeDesignId/.test(server) && /\.\.\.\(invokeDesignId \? \{ designId: invokeDesignId \}/.test(server))
  check('invoke 的 target 枚举含 activeDoc', /'app', 'doc', 'activeDoc'/.test(server))
  check('invoke 回包暴露 activeDocument 与 document', /activeDocument: true/.test(server) && /result\.document \? \{ document: result\.document \}/.test(server))
}

// ── 11. 新错误码都有可行动的下一步 ──────────────────────────────────────
{
  const server = read('server/server.mjs')
  for (const code of ['DIMENSION_NOT_DRIVING', 'SKETCH_NOT_EDITABLE', 'RELATIONS_INCOMPLETE', 'VERIFY_FAILED', 'DOC_NOT_OPEN']) {
    check(`错误码 ${code} 在 nextActionsFor 里有分支`, server.includes(`case '${code}'`))
  }
}

// ── 12. 经验条目已落进排查手册 ──────────────────────────────────────────
{
  const skill = read('skills/sw-troubleshooting/SKILL.md')
  check('手册收录「尺寸读回同一个数 = 量错对象」', skill.includes('一套定位尺寸读回同一个数'))
  check('手册收录「undo 是特征级破坏性操作」', skill.includes('撤销（undo）是特征级的破坏性操作'))
  check('手册收录「重建是有损的，必查材料密度」', skill.includes('材料密度') && skill.includes('重建后必查'))
  check('手册收录「target:doc 由 designId 决定」', skill.includes('`target:"doc"` 到底动的是哪份文档'))
  check('手册收录「SelectByID2 返回 true 但没选中」',
    skill.includes('`SelectByID2` 返回 true，但一个都没选中') && skill.includes('SELECTION_EMPTY'))
  check('手册收录「回包怎么读：changes 永远在 / measurements 两处都有」',
    skill.includes('`changes` 永远在') && skill.includes('changes.measurements'))
}

// ── 13. SelectByID2 空选集：选完了 ≠ 选中了 ─────────────────────────────
//
// 实测过的三种「返回 true 但一个都没选中」：坐标按毫米给、名字写错、面已被重建
// 换掉。旧实现把这类结果当成功回给调用方（摘要只写「没有选中任何对象」），
// 后面的特征就建在空选集上，报错指向完全无关的地方。
{
  const handlers = observeHandlers({
    callBridge: async (op) => {
      if (op !== 'select') throw new Error(`unexpected op ${op}`)
      // 桥接器原样把 SOLIDWORKS 的 true 传回来 —— 但它没选中任何东西。
      return { mode: 'byName', selected: true, selection: { count: 0, items: [] } }
    },
  })
  const result = parse(await handlers.get('select')({
    action: 'select', mode: 'byName', name: '前视基准面X', type: 'PLANE', designId: 'plate-4',
  }))
  check('select byName 选中 0 个 → status=failed', result.status === 'failed', result.status)
  check('空选集给 SELECTION_EMPTY（不是「没有选中任何对象」的 ok）',
    result.extra?.error?.code === 'SELECTION_EMPTY', result.extra?.error?.code)
  check('报错里点明「那个返回值不代表真的选中了」',
    /不代表真的选中/.test(result.summary ?? ''), result.summary)
  check('byName 打空 → 下一步指向特征树的真实名字',
    /特征树/.test(String(result.nextActions?.[0] ?? '')), result.nextActions)
}

// 反例：真的选中了就是 ok（别把成功也一起拒掉）
{
  const handlers = observeHandlers({
    callBridge: async () => ({
      mode: 'byId', selected: true, selection: { count: 1, items: [{ id: 'abc', kind: 'plane' }] },
    }),
  })
  const result = parse(await handlers.get('select')({ action: 'select', mode: 'byId', persistentId: 'abc', designId: 'plate-5' }))
  check('select 真的选中 1 个 → status=ok', result.status === 'ok', result.status)
  check('select 成功时不给错误码', result.extra?.error === undefined, result.extra?.error)
}

// 例外：clear 之后本来就是 0 个，那是成功不是失败
{
  const handlers = observeHandlers({
    callBridge: async () => ({ mode: 'clear', selected: true, selection: { count: 0, items: [] } }),
  })
  const result = parse(await handlers.get('select')({ action: 'clear', designId: 'plate-6' }))
  check('select clear 后 0 个 → status=ok（清空本来就该是 0）', result.status === 'ok', result.status)
}

// byRay 打空要指向「同一视图状态」这条最常踩的坑
{
  const handlers = observeHandlers({
    callBridge: async () => ({ mode: 'byRay', selected: false, selection: { count: 0, items: [] }, ray: {} }),
  })
  const result = parse(await handlers.get('select')({ action: 'select', mode: 'byRay', x: 10, y: 10, designId: 'plate-7' }))
  check('select byRay 打空 → SELECTION_EMPTY', result.extra?.error?.code === 'SELECTION_EMPTY', result.extra?.error?.code)
  check('byRay 打空 → 下一步说清要用同一视图状态的像素',
    /同一视图状态/.test(String(result.nextActions?.[0] ?? '')), result.nextActions)
}

// ── 14. invoke 的选择类调用也不再静默放过 0 个 ───────────────────────────
{
  const server = read('server/server.mjs')
  check('invoke 选中 0 个 → 报 SELECTION_EMPTY 而不是一条 warnings',
    /fail\('SELECTION_EMPTY'/.test(server) && !/这次调用之后选中的对象是 0 个/.test(server))
  check('SELECTION_EMPTY 在 nextActionsFor 里有分支', /case 'SELECTION_EMPTY'/.test(server))
  check('invoke 的 SELECTION_EMPTY 下一步点明 2.5 mm 写成 0.0025',
    /0\.0025/.test(server))
  const observe = read('server/tools-observe.mjs')
  check('select 工具描述写清「选完了 ≠ 选中了」', /选完了 ≠ 选中了/.test(observe))
}

// ── 15. 回包形状：失败也必须有 changes；measurements 两处都能读到 ──────────
//
// 会话 abd5f23f 的 23 次工具失败里，**11 次**是失败的桥接器回包根本没有 changes
// 这个键（调用方写 j.changes.applied → TypeError，把真正的错误码盖住），
// 另有 **9 次**是去读 changes.measurements.totalVolumeMm3（那个数只在顶层）。
// 两条都不是「参数写错」，是回包形状逼出来的无效往返。
{
  // 用真的 server.mjs 里的 envelope 行为：这里直接断言源码里的契约。
  const server = read('server/server.mjs')
  check('envelope 无条件给 changes（失败回包也有这个键）',
    /const normalizedChanges = changes \?\? \{\}/.test(server) && /changes: measurements && normalizedChanges\.measurements === undefined/.test(server))
  check('envelope 的注释写清「缺这个键会盖住真正的错误码」',
    /Cannot read properties of undefined \(reading 'applied'\)/.test(server))
  check('measurements 同时出现在 changes.measurements 与顶层',
    /\.\.\.normalizedChanges, measurements/.test(server) && /\.\.\.\(measurements \? \{ measurements \} : \{\}\)/.test(server))
}

// 行为断言：把 envelope 从 server.mjs 里取出来跑一遍，确认两种读法都拿得到数。
{
  const source = read('server/server.mjs')
  const start = source.indexOf('function envelope(')
  const end = source.indexOf('\nfunction ok(', start)
  check('能从 server.mjs 里取出 envelope 实现', start > 0 && end > start, { start, end })
  if (start > 0 && end > start) {
    const body = source.slice(start, end)
    // eslint-disable-next-line no-new-func
    const envelope = new Function(`${body}; return envelope`)()
    const failedEnvelope = envelope({ summary: 'x 失败', status: 'failed', designId: 'd', extra: { error: { code: 'E' } } })
    check('失败回包也有 changes 对象（不是 undefined）',
      failedEnvelope.changes !== null && typeof failedEnvelope.changes === 'object', failedEnvelope.changes)
    check('失败回包里 changes.applied 读得到（空数组语义，不抛 TypeError）',
      Array.isArray(failedEnvelope.changes.applied ?? []), failedEnvelope.changes.applied)

    const measured = envelope({ summary: 'y', designId: 'd', measurements: { totalVolumeMm3: 4800 } })
    check('measurements 在顶层读得到', measured.measurements?.totalVolumeMm3 === 4800, measured.measurements)
    check('measurements 在 changes 里也读得到（同一个数）',
      measured.changes?.measurements?.totalVolumeMm3 === 4800,
      { changesMeasurements: measured.changes?.measurements, top: measured.measurements })
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
