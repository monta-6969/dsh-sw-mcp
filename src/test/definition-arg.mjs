// definition 参数容错的离线测试（不需要 SOLIDWORKS）。
//
// 现场：model action="build" 的 definition 在传输层变成 JSON 字符串时，
// normalizeDesign 只看到字符下标，报「设计定义缺少 features 数组」。
// 这一层要把它还原成对象；解析失败必须保持原字符串，让原报错照旧出现。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { coerceDefinition } from '../server/definition-arg.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const serverSource = readFileSync(join(repo, 'server', 'server.mjs'), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS ', name) }
  else { fail += 1; console.log('FAIL ', name, JSON.stringify(detail ?? null)) }
}

const definition = {
  schemaVersion: 3,
  designId: 'plate-01',
  units: 'mm',
  params: { plate_width: 60 },
  features: [{ id: 'base', kind: 'extrude', sketch: { plane: 'front' }, depth: 6 }],
}

// ── 对象：原样返回（不复制、不改内容）─────────────────────────────────────
const asObject = coerceDefinition(definition)
check('对象原样返回（同一个引用）', asObject === definition, asObject)

// ── JSON 字符串：parse 回对象，关键字段都在 ───────────────────────────────
const asString = JSON.stringify(definition)
const parsed = coerceDefinition(asString)
check('JSON 字符串被还原成对象', parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), parsed)
check('还原后 features 是数组（normalizeDesign 的判据）', Array.isArray(parsed?.features), parsed)
check('还原后 designId 读得到（build 用它当设计名）', parsed?.designId === 'plate-01', parsed?.designId)
check('还原后 params 没丢', parsed?.params?.plate_width === 60, parsed?.params)
check('带首尾空白的 JSON 字符串也能还原', coerceDefinition(`  \n${asString}\n  `)?.designId === 'plate-01')
check('带 BOM 的 JSON 字符串也能还原', coerceDefinition(`\uFEFF${asString}`)?.designId === 'plate-01')

// ── 解析失败：保持原字符串，交给原来的校验报错（不换错误码）────────────────
const broken = '{"designId":"plate-01","features":['
check('不是合法 JSON → 原字符串返回（原报错照旧）', coerceDefinition(broken) === broken, coerceDefinition(broken))

// ── 不在容错范围内的输入：一律原样返回 ───────────────────────────────────
check('不以 { 开头的字符串原样返回', coerceDefinition('plate-01') === 'plate-01')
check('JSON 数组字符串原样返回（定义只能是对象）',
  coerceDefinition('[1,2,3]') === '[1,2,3]')
check('null 原样返回', coerceDefinition(null) === null)
check('undefined 原样返回', coerceDefinition(undefined) === undefined)
check('数字原样返回', coerceDefinition(42) === 42)
check('数组对象原样返回（引用不变）', Array.isArray(coerceDefinition([definition])))

// ── 二次编码：保持原样，走原报错，不猜两层 ───────────────────────────────
const twice = JSON.stringify(asString)
check('二次编码的字符串不猜两层', coerceDefinition(twice) === twice)

// ── 接线：build/plan 两个入口都在取 designId 之前还原 ─────────────────────
const buildCoerce = serverSource.indexOf('async function handlePartBuild(args)')
const buildBody = buildCoerce >= 0 ? serverSource.slice(buildCoerce, buildCoerce + 4000) : ''
check('handlePartBuild 在校验前调用 coerceDefinition',
  buildBody.includes('coerceDefinition(args.definition)'), buildBody.slice(0, 200))
check('handlePartBuild 把还原后的 definitionArg 交给 normalizeDesign',
  buildBody.includes('normalizeDesign(definitionArg, designId)'))

const planCoerce = serverSource.indexOf('async function handlePlan(args)')
const planBody = planCoerce >= 0 ? serverSource.slice(planCoerce, planCoerce + 900) : ''
check('handlePlan 在校验前调用 coerceDefinition',
  planBody.includes('coerceDefinition(args.definition)'), planBody.slice(0, 200))
check('handlePlan 用还原后的 definitionArg 取 designId',
  planBody.includes('definitionArg?.designId'))
check('build/plan 都还在走 normalizeDesign（没有绕过校验）',
  buildBody.includes('normalizeDesign(') && planBody.includes('normalizeDesign('))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
