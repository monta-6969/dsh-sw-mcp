// 提示词面整改的离线断言（不需要 SOLIDWORKS、不起桥接器、不调 broker）。
//
// 背景（2026-11-23 参数化会话实测）：build 丢弃内联 dimensions 后
// `constraints dimensions list` 回 0 条，而 `constraints` 的 description 原文写着
// 「precise 建模后补关系/尺寸」—— 这句话正好把 Agent 引向 `dimensions.add`，绕过
// `model action="edit"`。文案改完之后没有回归测试，下次改说明又会漂回去。
//
// 这个文件只读三样东西：MCP 的 `tools/list`、三个 SKILL.md、cordis.patch.yml 的 persona。
// 会话用 SW_MCP_TOOLS 白名单开成**只读通道**（只注册 model/inspect/constraints），
// 只发 `tools/list`，所以它不可能改文档，也不依赖真机。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSession } from './lib/mcp.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}`)
    return
  }
  failures.push(name)
  console.log(`FAIL  ${name}`)
  if (detail !== undefined) {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
    console.log(`      实际片段：${text.length > 1200 ? `${text.slice(0, 1200)}…` : text}`)
  }
}

const read = (relative) => readFileSync(join(repo, relative), 'utf8')

// 「0 条 = build 没落地尺寸」这句判据（或等价写法）必须在每个面向模型的文本里出现。
const ZERO_LANDING = /0\s*条\s*=\s*build\s*没落地尺寸|build\s*没落地尺寸/
const ADD_MENTION = /dimensions?\.add|dimensionAction\s*[=:]\s*["']?add\b/

/** `dimensions.add` 只能以禁止项出现；拿它当「修 build 漏尺寸」的手段就算回归。 */
function addUsedAsFix(text) {
  const hits = []
  text.split('\n').forEach((line, index) => {
    if (!ADD_MENTION.test(line)) return
    if (/不要|不用|禁止|不得|不用于|不是|只用于|别再|而不是/.test(line)) return
    hits.push({ line: index + 1, text: line.trim() })
  })
  return hits
}

/** 从 YAML 块标量里取 persona（和 test/presets.mjs 同一套规则）。 */
function readBlockScalar(source) {
  const lines = source.split('\n')
  const marker = lines.findIndex((line) => /^\s*prefix:\s*\|-?\s*$/.test(line))
  if (marker < 0) return ''
  const indent = lines[marker].match(/^\s*/)[0].length
  const body = []
  for (let index = marker + 1; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) { body.push(''); continue }
    const lead = line.match(/^\s*/)[0].length
    if (lead <= indent) break
    body.push(line)
  }
  const nonEmpty = body.filter((line) => line.trim())
  const common = Math.min(...nonEmpty.map((line) => line.match(/^\s*/)[0].length))
  return body.map((line) => (line.trim() ? line.slice(common) : '')).join('\n')
}

const skillFiles = [
  'skills/sw-parametric/SKILL.md',
  'skills/native-workflows/SKILL.md',
  'skills/sw-troubleshooting/SKILL.md',
]

// 只读会话：白名单只放这三个工具，桥接器钉在不存在的位置（任何真调用只会 BRIDGE_MISSING）。
const work = mkdtempSync(join(tmpdir(), 'sw-mcp-prompt-surface-'))
const dataDir = join(work, 'data')
mkdirSync(dataDir, { recursive: true })
const configPath = join(work, 'sw.config.json')
writeFileSync(configPath, JSON.stringify({ bridgeExe: join(work, 'no-such-bridge', 'SwBridge.exe') }), 'utf8')
const env = { ...process.env, SW_MCP_DATA: dataDir, SW_MCP_CONFIG: configPath, SW_MCP_BROKER: '0' }
delete env.SW_MCP_TOOLS
env.SW_MCP_TOOLS = 'model,inspect,constraints'

const session = openSession({ env })
try {
  await session.start()
  const listed = await session.call('tools/list', {})
  const tools = Array.isArray(listed?.tools) ? listed.tools : []
  const names = tools.map((tool) => tool.name).sort()
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  check('只读会话只注册 model/inspect/constraints', JSON.stringify(names) === JSON.stringify(['constraints', 'inspect', 'model']), names)

  const descriptionOf = (name) => byName[name]?.description ?? ''
  const constraints = descriptionOf('constraints')
  const model = descriptionOf('model')
  const inspect = descriptionOf('inspect')

  // 1. constraints 不再是「建模后补关系/尺寸」的入口，改参数指向 model action="edit"
  check('constraints.description 含 model action="edit"', /model\s+action="edit"/.test(constraints),
    { 片段: constraints.match(/.{0,40}action="edit".{0,40}/)?.[0] ?? constraints.slice(0, 300) })
  check('constraints.description 不含「建模后补关系/尺寸」', !/建模后补关系\/尺寸/.test(constraints),
    { 片段: constraints.match(/.{0,40}建模后补关系.{0,40}/)?.[0] ?? constraints.slice(0, 300) })
  check('constraints.description 写明 build 后 dimensions 为 0 条先报缺口',
    /0\s*条先报缺口/.test(constraints), { 片段: constraints.match(/.{0,60}0 条.{0,60}/)?.[0] ?? constraints })

  // 2. model.description 写明 build 一次声明
  check('model.description 含「build 一次声明」', /build\s*一次声明/.test(model),
    { 片段: model.match(/.{0,60}一次声明.{0,80}/)?.[0] ?? model.slice(0, 400) })
  check('model.description 写明改参数只用 model action="edit"',
    /改参数只用\s*model\s+action="edit"/.test(model),
    { 片段: model.match(/.{0,40}改参数只用.{0,60}/)?.[0] ?? model.slice(0, 400) })

  // 3. inspect.description 对尺寸/约束指路到 constraints，且 schema 里不再有 dimensionAction
  check('inspect.description 指路 constraints 工具', /尺寸与会话级约束在 constraints 工具/.test(inspect),
    { 片段: inspect.match(/.{0,40}constraints 工具.{0,40}/)?.[0] ?? inspect.slice(0, 400) })
  const inspectProps = Object.keys(byName.inspect?.inputSchema?.properties ?? {})
  check('inspect.inputSchema 里没有 dimensionAction（指路靠 description，不靠参数）',
    !inspectProps.includes('dimensionAction'), inspectProps)

  // 4. 三个 SKILL.md：都有「0 条 = build 没落地尺寸」，都不把 dimensions.add 当修 build 的手段
  for (const file of skillFiles) {
    const text = read(file)
    check(`${file} 含「0 条 = build 没落地尺寸」判据`, ZERO_LANDING.test(text),
      { 片段: text.match(/.{0,60}没落地尺寸.{0,60}/)?.[0] ?? '未找到该判据' })
    const hits = addUsedAsFix(text)
    check(`${file} 不把 dimensions.add 当修 build 的手段`, hits.length === 0, hits)
  }

  // DIMENSION_NOT_DRIVING / EDIT_NOT_BOUND 要有动作与禁止项
  const trouble = read('skills/sw-troubleshooting/SKILL.md')
  check('sw-troubleshooting 写了 DIMENSION_NOT_DRIVING 的禁止项（不 remove 后重加）',
    /DIMENSION_NOT_DRIVING/.test(trouble) && /不要\s*`?dimensions\.remove`?\s*后重加/.test(trouble),
    { 片段: trouble.match(/.{0,60}后重加.{0,40}/)?.[0] ?? '未找到' })
  check('sw-troubleshooting 写了 EDIT_NOT_BOUND 的触发与禁止项',
    /EDIT_NOT_BOUND/.test(trouble) && /bound=false|bound"?\s*[:=]\s*false/.test(trouble)
    && /不要连续\s*`?edit`?/.test(trouble),
    { 片段: trouble.match(/.{0,40}EDIT_NOT_BOUND.{0,80}/)?.[0] ?? '未找到' })

  // 5. persona：build 后 0 条的报缺口规则 + 改参数只用 edit
  const persona = readBlockScalar(read('cordis.patch.yml'))
  check('persona 含「build 后 dimensions 为 0 条」', /build\s*后\s*dimensions\s*为\s*0\s*条/.test(persona),
    { 片段: persona.match(/.{0,60}dimensions 为 0 条.{0,60}/)?.[0] ?? persona.slice(0, 600) })
  check('persona 含 model action="edit"', /model\s+action="edit"/.test(persona),
    { 片段: persona.match(/.{0,60}action="edit".{0,60}/)?.[0] ?? persona.slice(0, 600) })
  check('persona 写明一次声明完整几何/尺寸/约束/语义参数', /一次声明完整几何\/尺寸\/约束\/语义参数/.test(persona),
    { 片段: persona.match(/.{0,60}一次声明.{0,80}/)?.[0] ?? persona.slice(0, 600) })
} finally {
  session.close()
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  FAIL  ${failure}`)
  process.exitCode = 1
}
