// 读图记录必须「能被追溯」，这一条由代码判，不由模型自述。
//
// 校验器只回答一个问题：每个数字、每个特征，能不能顺着引用找到它的来源。
// 它不判断尺寸对不对——那是实测几何与独立审查的事。混在一起就又变成自证。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateDrawing, EVIDENCE_SCHEMA_VERSION } from '../server/drawing-evidence.mjs'
import { repoRoot } from './lib/mcp.mjs'

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

const load = (id) => JSON.parse(readFileSync(join(repoRoot, 'drawings', id, 'drawing.json'), 'utf8'))

// ── 1. 现成的两份记录都应当通过 ────────────────────────────────────────
for (const id of ['p1', 'p2']) {
  const doc = load(id)
  const verdict = validateDrawing(doc)
  check(`${id} 读图记录通过校验`, verdict.ok, verdict.errors.map((e) => `${e.code}@${e.where}`))
  check(`${id} 记录了版本号`, typeof doc.schemaVersion === 'number', doc.schemaVersion)
  check(`${id} 的统计非空`, verdict.stats.dimensions > 5 && verdict.stats.features > 2, verdict.stats)
  // 扫描件不是等比图：p2 的 px/mm 从 1.15 到 2.33，提醒必须出现；
  // p1 的扫描件接近等比，只要求它确实写了标定数据（写不出标定才是编的）。
  // 标定要么有数据，要么明确写了「没做」——两样都没有才是漏。
  const calibrated = (doc.scaleProof ?? []).length >= 2
  const declaredGap = (doc.scaleProofNote ?? '').length > 0
    || verdict.notes.some((n) => n.code === 'SCALE_PROOF_MISSING')
  check(`${id} 对标定有交代（数据或明确说明没做）`, calibrated || declaredGap, { calibrated, declaredGap })
  if (id === 'p2') {
    check('p2 指出像素不能当毫米', verdict.notes.some((n) => n.code === 'SCALE_NOT_UNIFORM'),
      verdict.notes.map((n) => n.code))
  }
}

// ── 2. 逐条制造缺陷，看校验器能不能点出来 ──────────────────────────────
const base = () => load('p2')

{
  const doc = base()
  doc.projection = { kind: 'undetermined' }
  const v = validateDrawing(doc)
  check('投影法没定 → PROJECTION_UNKNOWN', v.errors.some((e) => e.code === 'PROJECTION_UNKNOWN'),
    v.errors.map((e) => e.code))
  check('投影法没定算阻断项', v.ok === false)
}

{
  const doc = base()
  delete doc.dimensions[0].anchor
  const v = validateDrawing(doc)
  check('标注没锚点 → DIM_NO_ANCHOR', v.errors.some((e) => e.code === 'DIM_NO_ANCHOR'), v.errors.map((e) => e.code))
}

{
  const doc = base()
  doc.chains[0].terms = [...doc.chains[0].terms, 'd-not-exist']
  const v = validateDrawing(doc)
  check('尺寸链引用不存在的标注 → CHAIN_BROKEN', v.errors.some((e) => e.code === 'CHAIN_BROKEN'),
    v.errors.map((e) => e.code))
}

{
  const doc = base()
  doc.chains[0].sum = doc.chains[0].sum + 10
  const v = validateDrawing(doc)
  check('尺寸链加起来对不上 → CHAIN_BROKEN', v.errors.some((e) => e.code === 'CHAIN_BROKEN'),
    v.errors.map((e) => e.code))
}

{
  const doc = base()
  doc.features[0].from = []
  const v = validateDrawing(doc)
  check('特征说不出由哪几条标注决定 → FEATURE_NO_SOURCE',
    v.errors.some((e) => e.code === 'FEATURE_NO_SOURCE'), v.errors.map((e) => e.code))
}

{
  const doc = base()
  doc.dimensions[1].view = 'no-such-view'
  const v = validateDrawing(doc)
  check('标注指向没登记的视图 → VIEW_UNMAPPED', v.errors.some((e) => e.code === 'VIEW_UNMAPPED'),
    v.errors.map((e) => e.code))
}

{
  const doc = base()
  doc.checks[0].from = ['d-not-exist']
  const v = validateDrawing(doc)
  check('核对指向不存在的标注 → CHECK_NO_SOURCE', v.errors.some((e) => e.code === 'CHECK_NO_SOURCE'),
    v.errors.map((e) => e.code))
}

{
  const doc = base()
  doc.dimensions[2].value = 'abc'
  const v = validateDrawing(doc)
  check('标注值不是数字 → DIM_NO_VALUE', v.errors.some((e) => e.code === 'DIM_NO_VALUE'), v.errors.map((e) => e.code))
}

// ── 3. 一份干净的最小记录也应当通过 ────────────────────────────────────
{
  const minimal = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    drawingId: 'minimal',
    projection: { kind: 'first-angle', why: '测试用' },
    // v3 起这两块是必需的：没有坐标系与视图方向，「前视图」三个字不能唯一确定三维操作。
    coordinateSystem: {
      part: { xAxis: '+X', yAxis: '+Y', zAxis: '+Z', origin: '底面左后角' },
      partToModel: { xAxis: '+X', yAxis: '-Z', zAxis: '+Y' },
    },
    views: [{ id: 'front', kind: '主视图', viewDirection: '+Y', imageRight: '+X', imageUp: '+Z', region: [0, 0, 0.5, 0.5] }],
    cuts: [],
    dimensions: [{ id: 'd1', value: 10, anchor: '板长', view: 'front' }],
    chains: [],
    features: [{ id: 'plate', kind: 'extrude', from: ['d1'] }],
    checks: [{ name: '板长', from: ['d1'] }],
    openQuestions: [],
    unresolved: [],
    scaleProof: [{ view: 'front', axis: 'x', pixels: 100, mm: 10, pxPerMm: 10 }],
  }
  const v = validateDrawing(minimal)
  check('最小可用记录通过', v.ok, v.errors)

  // 分别扣掉 v3 的三件必需品，确认每一件都能单独报出来。
  const noFrame = validateDrawing({ ...minimal, coordinateSystem: undefined })
  check('没有坐标系 → FRAME_UNKNOWN', noFrame.errors.some((e) => e.code === 'FRAME_UNKNOWN'), noFrame.errors.map((e) => e.code))

  const noMap = validateDrawing({ ...minimal, coordinateSystem: { part: minimal.coordinateSystem.part } })
  check('没有零件轴→模型轴映射 → FRAME_NO_MODEL_MAP',
    noMap.errors.some((e) => e.code === 'FRAME_NO_MODEL_MAP'), noMap.errors.map((e) => e.code))

  const noDir = validateDrawing({ ...minimal, views: [{ id: 'front', kind: '主视图' }] })
  check('视图没有观察方向 → VIEW_NO_DIRECTION',
    noDir.errors.some((e) => e.code === 'VIEW_NO_DIRECTION'), noDir.errors.map((e) => e.code))

  const dupAxis = validateDrawing({
    ...minimal,
    views: [{ id: 'front', kind: '主视图', viewDirection: '+Y', imageRight: '+Y', imageUp: '+Z' }],
  })
  check('画面右与观察方向同轴 → VIEW_NO_DIRECTION',
    dupAxis.errors.some((e) => e.code === 'VIEW_NO_DIRECTION'), dupAxis.errors.map((e) => e.code))

  const iso = validateDrawing({
    ...minimal,
    views: [...minimal.views, { id: 'iso', kind: '轴测图' }],
  })
  check('轴测图不要求观察方向', iso.ok, iso.errors)

  const badCut = validateDrawing({
    ...minimal,
    views: [...minimal.views, { id: 'section-a', kind: '剖视图', cut: 'a-a' }],
    cuts: [{ id: 'a-a', plane: 'Y=0' }],
  })
  check('剖切缺保留侧/观察方向 → CUT_UNDEFINED',
    badCut.errors.some((e) => e.code === 'CUT_UNDEFINED'), badCut.errors.map((e) => e.code))

  const goodCut = validateDrawing({
    ...minimal,
    views: [...minimal.views, { id: 'section-a', kind: '剖视图', cut: 'a-a', region: [0.5, 0, 0.9, 0.5],
      viewDirection: '+Y', imageRight: '+X', imageUp: '+Z' }],
    cuts: [{ id: 'a-a', plane: 'Y=0', keep: '后侧', viewDirection: '+Y', kind: 'full-section' }],
  })
  check('剖切三件套齐全就通过', goodCut.ok, goodCut.errors)

  // 读了却没用的标注：只给提示，不挡。
  const unusedNote = validateDrawing({
    ...minimal,
    dimensions: [...minimal.dimensions, { id: 'd2', value: 3, anchor: '板厚', view: 'front' }],
  })
  check('没被任何特征引用的标注 → DIM_UNUSED（不挡）',
    unusedNote.ok && unusedNote.notes.some((n) => n.code === 'DIM_UNUSED'),
    unusedNote.notes.map((n) => n.code))
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(failures.map((name) => `  - ${name}`).join('\n'))
  process.exitCode = 1
}
