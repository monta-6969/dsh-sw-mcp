// 草图计划与「仅草图」成败判据的离线验收：不启动 SOLIDWORKS，也不碰桥接器。
//
// 判定必须发生在碰 SOLIDWORKS 之前：坐标式草稿、折线拟合、像素尺寸、未确认假设
// 都会在这里被挡住，而不是到桥接器里才炸、或者「建出来了」却根本不可编辑。
// 三处共用同一份判定（model action=plan、build output=sketch、review-gate 的交付门），
// 所以这里测的是那份共用实现，不是某个入口的措辞。
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RELATION_TYPES,
  auditRelations,
  describePlan,
  planSketch,
  sketchBuildCheck,
} from '../server/geometry-plan.mjs'
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

const line = (id, start, end) => ({ id, kind: 'line', params: { start, end } })
const TRIANGLE = [
  line('l1', [0, 0], [40, 0]),
  line('l2', [40, 0], [20, 30]),
  line('l3', [20, 30], [0, 0]),
]
// 三条边首尾相接：每个端点都显式参与一条重合关系，这才是「按关系建」的草稿。
const TRIANGLE_RELATIONS = [
  { type: 'coincident', refs: ['l1:end', 'l2:start'] },
  { type: 'coincident', refs: ['l2:end', 'l3:start'] },
  { type: 'coincident', refs: ['l3:end', 'l1:start'] },
]
const sketch = (curves, relations = []) => ({
  kind: 'sketch', id: 's1', plane: 1, curves, relations,
})
const definition = (curves, relations = []) => ({
  designId: 'plan-fixture',
  features: [sketch(curves, relations)],
})
const codesOf = (plan) => plan.blockers.map((blocker) => blocker.code)

// --------------------------------------------------------------- 坐标式草稿
{
  const plan = planSketch(definition(TRIANGLE, []))
  check('坐标式轮廓：ready=false', plan.ready === false, codesOf(plan))
  check('坐标式轮廓：三个实体都缺关系', plan.missingRelations.length === 3,
    plan.missingRelations.map((item) => item.refs.join('+')))
  check('坐标式轮廓：六个端点都记成悬空', plan.openEnds.length === 6, plan.openEnds.length)
  check('坐标式轮廓：几何重合但不是关系的端点给出候选',
    plan.relationCandidates.length === 3 && plan.relationCandidates.every((item) => item.distance === 0),
    plan.relationCandidates.map((item) => item.refs.join('=')))
  check('坐标式轮廓：blockers 同时有 SKETCH_OPEN 与 RELATIONS_REQUIRED',
    codesOf(plan).includes('SKETCH_OPEN') && codesOf(plan).includes('RELATIONS_REQUIRED'), codesOf(plan))
  check('坐标式轮廓：describePlan 指到第一个阻断项', /SKETCH_OPEN/.test(describePlan(plan)), describePlan(plan))
}

// --------------------------------------------------------------- 关系齐全
{
  const plan = planSketch(definition(TRIANGLE, TRIANGLE_RELATIONS))
  check('关系齐全：ready=true', plan.ready === true, codesOf(plan))
  check('关系齐全：没有悬空端点', plan.openEnds.length === 0, plan.openEnds.length)
  check('关系齐全：三条关系都解析到两个实体',
    plan.relations.length === 3 && plan.relations.every((relation) => relation.entityIds.length === 2),
    plan.relations.map((relation) => relation.entityIds.join('=')))
  check('关系齐全：plan.ready === true（判据是字段，不是 describePlan 的中文措辞）',
    plan.ready === true, codesOf(plan))
}

// --------------------------------------------------------------- 禁止折线拟合
{
  const plan = planSketch(definition([{
    id: 'p1',
    kind: 'polyline',
    params: { points: [[0, 0], [40, 0], [40, 30], [0, 30]], closed: true },
  }]))
  check('polyline 轮廓：报 POLYLINE_NOT_ALLOWED',
    plan.fitViolations.some((item) => item.code === 'POLYLINE_NOT_ALLOWED'), plan.fitViolations)
  check('polyline 轮廓：ready=false', plan.ready === false, codesOf(plan))
}
{
  // 12 条 1.3mm 的短直线拼出 90° 圆弧：这是「像素拟合」最典型的样子。
  const radius = 10
  const count = 12
  const chain = []
  for (let index = 0; index < count; index += 1) {
    const from = (Math.PI / 2) * (index / count)
    const to = (Math.PI / 2) * ((index + 1) / count)
    chain.push({
      id: `a${index + 1}`,
      kind: 'line',
      params: {
        start: [Number((radius * Math.cos(from)).toFixed(4)), Number((radius * Math.sin(from)).toFixed(4))],
        end: [Number((radius * Math.cos(to)).toFixed(4)), Number((radius * Math.sin(to)).toFixed(4))],
      },
    })
  }
  const plan = planSketch(definition(chain, []))
  check('连续短直线拟圆弧：报 ARC_APPROXIMATED_BY_SHORT_LINES',
    plan.fitViolations.some((item) => item.code === 'ARC_APPROXIMATED_BY_SHORT_LINES'), plan.fitViolations)
  check('连续短直线拟圆弧：ready=false', plan.ready === false, codesOf(plan))
}
{
  const plan = planSketch(definition([{ id: 'arc1', kind: 'arc', params: { radius: 10 } }]))
  check('圆弧没有圆心：ARC_CENTER_MISSING',
    codesOf(plan).includes('ARC_CENTER_MISSING'), codesOf(plan))
}

// --------------------------------------------------------------- 尺寸与假设
{
  const plan = planSketch(definition(TRIANGLE, TRIANGLE_RELATIONS), {
    dimensions: [{ name: '槽宽', value: 16.5, unit: 'px' }],
  })
  check('像素尺寸：PIXEL_DIMENSION', codesOf(plan).includes('PIXEL_DIMENSION'), codesOf(plan))
  check('像素尺寸：原值原样记录，不做 px→mm 换算',
    plan.dimensionSources.dimension.length === 1 && plan.dimensionSources.dimension[0].value === 16.5,
    plan.dimensionSources)
}
{
  const plan = planSketch(definition(TRIANGLE, TRIANGLE_RELATIONS), {
    assumptions: [{ name: 'slot.width', value: 16.5, reason: '图纸前视约 22.8，断面标注 16.5' }],
  })
  check('未确认假设：DIMENSIONS_UNCONFIRMED', codesOf(plan).includes('DIMENSIONS_UNCONFIRMED'), codesOf(plan))
  check('未确认假设：逐条列在 unconfirmedAssumptions',
    plan.unconfirmedAssumptions.includes('slot.width')
    && plan.assumptions[0].confirmed === false, plan.assumptions)
}
{
  const plan = planSketch(definition(TRIANGLE, TRIANGLE_RELATIONS), {
    assumptions: [{ name: 'slot.width', value: 16.5 }],
    acceptedAssumptions: ['slot.width'],
  })
  check('假设被用户确认后：ready=true', plan.ready === true, codesOf(plan))
  check('假设被用户确认后：状态是 accepted',
    plan.dimensionSources.assumption[0].status === 'accepted', plan.dimensionSources)
}
{
  const coordinate = planSketch(definition(TRIANGLE, TRIANGLE_RELATIONS), { precision: 'coordinate' })
  check('precision=coordinate：不能当作可交付草图',
    codesOf(coordinate).includes('RELATIONS_REQUIRED'), codesOf(coordinate))
  const needDims = planSketch(definition(TRIANGLE, TRIANGLE_RELATIONS), { requireDimensions: true })
  check('要求标注但没有标注：DIMENSIONS_UNCONFIRMED',
    codesOf(needDims).includes('DIMENSIONS_UNCONFIRMED'), codesOf(needDims))
}

// --------------------------------------------------------------- 交付前关系审计
{
  const nothing = auditRelations({})
  check('没有审计事实：known=false，绝不当通过',
    nothing.known === false && nothing.ok === false && nothing.gaps === null, nothing)
  const clean = auditRelations({ audit: { gaps: [], rejected: 0, missingRelations: [], assumptions: [] } })
  check('审计干净：ok=true / source=live-audit',
    clean.ok === true && clean.source === 'live-audit', clean)
  const gapped = auditRelations({ audit: { gaps: [{ type: 'coincident' }], rejected: 0 } })
  check('有缺口：ok=false', gapped.ok === false, gapped.gaps)
  const rejected = auditRelations({ audit: { gaps: [], rejected: [{ code: 'RELATION_REJECTED' }] } })
  check('被拒关系按条数计：ok=false', rejected.ok === false && rejected.rejected === 1, rejected.rejected)
  // 非数组非数字的 rejected 是「不知道有没有被拒」，不许静默当 0 通过（L2）。
  const rejectedObject = auditRelations({ audit: { gaps: [], rejected: {} } })
  check('rejected 是对象（{}）：known=false / ok=false，并给出原因',
    rejectedObject.known === false && rejectedObject.ok === false
    && rejectedObject.rejectedKnown === false
    && /rejected/.test(rejectedObject.reason ?? ''), rejectedObject)
  const rejectedText = auditRelations({ audit: { gaps: [], rejected: 'abc' } })
  check('rejected 是字符串（"abc"）：known=false / ok=false，并给出原因',
    rejectedText.known === false && rejectedText.ok === false
    && rejectedText.rejectedKnown === false
    && /rejected/.test(rejectedText.reason ?? ''), rejectedText)
  const unknown = auditRelations({ audit: { rejected: 0 } })
  check('审计记录缺 gaps 字段：known=false', unknown.known === false, unknown)
  const fromDefinition = auditRelations({ definition: definition(TRIANGLE, TRIANGLE_RELATIONS) })
  check('从设计定义推导：source=project-definition 且 ok=true',
    fromDefinition.source === 'project-definition' && fromDefinition.ok === true, fromDefinition)
  const coordinateDefinition = auditRelations({ definition: definition(TRIANGLE, []) })
  check('从设计定义推导：坐标草稿不通过', coordinateDefinition.ok === false, coordinateDefinition.gaps.length)
}

// --------------------------------------------------------------- 仅草图 build 判据
{
  const open = sketchBuildCheck({ sketch: { closed: false, relationAudit: { gaps: [], rejected: 0 } } })
  check('草图未闭合：SKETCH_OPEN', open.error?.code === 'SKETCH_OPEN', open.error)
  const noAudit = sketchBuildCheck({ sketch: { closed: true } })
  check('没有关系审计：RELATIONS_REQUIRED', noAudit.error?.code === 'RELATIONS_REQUIRED', noAudit.error)
  const clean = sketchBuildCheck({ sketch: { closed: true, relationAudit: { gaps: [], rejected: 0 } } })
  check('闭合 + 关系审计干净：通过', clean.ok === true, clean.details)
  const gaps = sketchBuildCheck({ sketch: { closed: true, relationAudit: { gaps: [{ type: 'coincident' }], rejected: 0 } } })
  check('有缺口：RELATIONS_REQUIRED', gaps.error?.code === 'RELATIONS_REQUIRED', gaps.error)
  // 与 auditRelations 同构：rejected 形态不认识时不许当 0 放行（L2）。
  const rejectedObject = sketchBuildCheck({ sketch: { closed: true, relationAudit: { gaps: [], rejected: {} } } })
  check('sketchBuildCheck：rejected 是对象（{}）→ 不放行',
    rejectedObject.ok === false && rejectedObject.error?.code === 'RELATIONS_REQUIRED'
    && rejectedObject.details?.rejectedKnown === false, rejectedObject.error)
  const rejectedText = sketchBuildCheck({ sketch: { closed: true, relationAudit: { gaps: [], rejected: 'abc' } } })
  check('sketchBuildCheck：rejected 是字符串（"abc"）→ 不放行',
    rejectedText.ok === false && rejectedText.error?.code === 'RELATIONS_REQUIRED'
    && rejectedText.details?.rejectedKnown === false, rejectedText.error)
  const unconfirmed = sketchBuildCheck(
    { sketch: { closed: true, relationAudit: { gaps: [], rejected: 0 } } },
    { assumptions: [{ name: 'slot.width' }] },
  )
  check('假设未确认：DIMENSIONS_UNCONFIRMED', unconfirmed.error?.code === 'DIMENSIONS_UNCONFIRMED', unconfirmed.error)
  const topLevel = sketchBuildCheck({ sketch: { closed: true }, relationAudit: { gaps: [], rejected: 0 } })
  check('relationAudit 在顶层也认', topLevel.ok === true, topLevel.details)
}

// --------------------------------------------------------------- 与契约同源
{
  const enums = JSON.parse(readFileSync(join(repoRoot, 'contracts', 'enums.json'), 'utf8'))
  check('关系类型白名单与 contracts/enums.json 的 constraintTypes 一致',
    JSON.stringify([...RELATION_TYPES].sort()) === JSON.stringify([...(enums.constraintTypes ?? [])].sort()),
    { code: RELATION_TYPES, enums: enums.constraintTypes })
}

// --------------------------------------------------------------- MCP 工具面（真服务，无 SOLIDWORKS）
{
  const work = mkdtempSync(join(tmpdir(), 'sw-mcp-sketch-plan-'))
  const dataDir = join(work, 'data')
  mkdirSync(dataDir, { recursive: true })
  const session = openSession({ env: { ...process.env, SW_MCP_DATA: dataDir } })
  await session.start()
  try {
    const planned = await session.tool('model', { action: 'plan', definition: definition(TRIANGLE, TRIANGLE_RELATIONS) })
    check('model action=plan：合格定义 ready=true',
      planned.status === 'ok' && planned.changes?.ready === true, planned.summary)
    check('model action=plan：返回实体与关系明细',
      planned.changes?.plan?.entities?.length === 3 && planned.changes?.plan?.relations?.length === 3,
      planned.changes?.plan?.blockers)

    const blocked = await session.tool('model', { action: 'plan', definition: definition(TRIANGLE, []) })
    check('model action=plan：坐标草稿 status=blocked 且带阻断项',
      blocked.status === 'blocked' && blocked.changes?.ready === false
      && blocked.changes?.plan?.blockers?.length > 0, blocked.changes?.plan?.blockers?.map((b) => b.code))

    const noDefinition = await session.tool('model', { action: 'plan' })
    check('model action=plan：没有 definition 时 BAD_ARGUMENT',
      noDefinition.status === 'failed' && noDefinition.extra?.error?.code === 'BAD_ARGUMENT',
      noDefinition.extra?.error)

    const coordinateBuild = await session.tool('model', {
      action: 'build',
      output: 'sketch',
      precision: 'coordinate',
      definition: definition(TRIANGLE, TRIANGLE_RELATIONS),
    })
    check('build output=sketch + precision=coordinate：RELATIONS_REQUIRED 直接拒',
      coordinateBuild.status === 'failed' && coordinateBuild.extra?.error?.code === 'RELATIONS_REQUIRED',
      coordinateBuild.extra?.error?.code)

    const blockedBuild = await session.tool('model', {
      action: 'build',
      output: 'sketch',
      definition: definition(TRIANGLE, []),
    })
    // 计划不过时 build 必须在调用桥接器之前就失败：错误码来自 plan.blockers，
    // detail 里带的是纯 Node 计划（blockers/openEnds），不是桥接器的错误形状。
    // 「不碰 SOLIDWORKS」的判据就是这两条证据，光有错误码不算数（M5）。
    const blockedDetail = blockedBuild.extra?.error?.detail ?? {}
    check('build output=sketch：计划不过时在调用桥接器之前就以 SKETCH_OPEN 失败（纯 Node 判定）',
      blockedBuild.status === 'failed'
      && blockedBuild.extra?.error?.code === 'SKETCH_OPEN'
      && Array.isArray(blockedDetail.blockers)
      && blockedDetail.blockers.length > 0
      && blockedDetail.blockers[0]?.code === 'SKETCH_OPEN'
      && Array.isArray(blockedDetail.openEnds)
      && blockedDetail.openEnds.length > 0,
      blockedBuild.extra?.error)
  } finally {
    session.close()
    rmSync(work, { recursive: true, force: true })
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  FAIL  ${failure}`)
  process.exitCode = 1
}
