// 提示词不是文档，是对模型的指令：名字写错，等于那个功能不存在。
//
// 这条用例来自一次真实事故：提示词里让模型调 `lesson { action: "add" }`，但
// `lesson` 从来不是工具（真身是 workspace 的嵌套参数）；同一份提示词还漏掉了
// measure / sketch / logs —— 于是模型在四分钟里拿 `invoke` 去试原生 API，
// 而能用的东西它一个都不知道。
//
// 事故之后的结构变了：人设只留「人设 / 任务分类 / 工作偏好 / 流程」，
// 工具用法全部下沉到工具自己的 description。所以这里的检查也跟着变：
//   1. 人设要**短**（长了就说明又在往里堆用法）；
//   2. 人设里出现的 工具+action 必须真实存在（不能发明工具）；
//   3. 人设不再逐个介绍工具，但关键能力必须在**工具说明**里有入口；
//   4. 工具返回里的提示也要指向真实动作。
//
// 不需要 SOLIDWORKS。

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './lib/mcp.mjs'
import { DESCRIPTIONS } from '../server/tool-face.mjs'

/** 取出 cordis.patch.yml 里 persona 块的正文。
 *
 * 不用 yaml 库：这份文件结构固定（`prefix: |-` 后面一整段缩进文本），而 yaml
 * 依赖在仓库里没有，只能借 DSH 解包目录 —— 一条测试不该依赖一个临时目录还在不在。
 * 规则就是 YAML 的块标量规则：缩进比 `prefix:` 更深的行属于正文，遇到缩进不
 * 更深的行就结束，然后按最小的公共缩进去掉。 */
function readPersona() {
  const text = readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8')
  const lines = text.split('\n')
  const marker = lines.findIndex((l) => /^\s*prefix:\s*\|-?\s*$/.test(l))
  if (marker < 0) throw new Error('cordis.patch.yml 里没找到 persona 的 prefix 块')
  const indent = lines[marker].match(/^\s*/)[0].length
  const body = []
  for (let i = marker + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) { body.push(''); continue }
    const lead = line.match(/^\s*/)[0].length
    if (lead <= indent) break
    body.push(line)
  }
  const nonEmpty = body.filter((l) => l.trim())
  const common = Math.min(...nonEmpty.map((l) => l.match(/^\s*/)[0].length))
  return body.map((l) => (l.trim() ? l.slice(common) : '')).join('\n')
}

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

// ---------------------------------------------------------------- read tools

const serverFiles = [
  'server/server.mjs',
  'server/tools-observe.mjs',
  'server/tools-calculate.mjs',
  'server/tool-face.mjs',
]

/** 描述已经集中到 tool-face 的 DESCRIPTIONS：注册块里写的是 DESCRIPTIONS.x，
 *  这里把名字解析成真正的文案，否则「说明太短」检查量的是一行标识符。 */
function resolveDescription(text) {
  const match = text.match(/^DESCRIPTIONS\.([A-Za-z_]+)$/)
  if (!match) return text
  return DESCRIPTIONS[match[1]] ?? ''
}

/** 从注册块里取出 description 的文字（支持单行、多行拼接、数组 join 三种写法）。 */
function readDescription(block) {
  const at = block.indexOf('description:')
  if (at < 0) return ''
  const slice = block.slice(at + 'description:'.length)
  const stop = slice.search(/\n\s*inputSchema\s*:|\n\s*\}\s*,\n\s*\)/)
  const body = stop >= 0 ? slice.slice(0, stop) : slice.slice(0, 6000)
  const parts = [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1])
  if (parts.length > 0) return parts.join('')
  const direct = body.match(/^\s*"([\s\S]*?)"/)
  if (direct) return direct[1]
  // 集中式写法：description: DESCRIPTIONS.model —— 没有引号，返回标识符给
  // resolveDescription 去 tool-face 里取真正的文案。
  const bare = body.trim().match(/^(DESCRIPTIONS\.[A-Za-z_]+)/)
  return bare ? bare[1] : ''
}

/** 每个工具名 → { actions, description }。 */
function readToolSurface() {
  const tools = new Map()
  for (const rel of serverFiles) {
    const text = readFileSync(join(repoRoot, rel), 'utf8')
    const starts = [...text.matchAll(/registerTool\(\s*\n?\s*'([a-z_]+)'/g)]
    for (let i = 0; i < starts.length; i++) {
      const name = starts[i][1]
      const from = starts[i].index
      const to = i + 1 < starts.length ? starts[i + 1].index : text.length
      const block = text.slice(from, to)
      const enumMatch = block.match(/action:\s*z\s*\n?\s*\.enum\(\[([\s\S]*?)\]/)
      const actions = enumMatch ? [...enumMatch[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]) : null
      // description 有两种写法：单行字符串，和「'…' + '…' +」这样的多行拼接。
      // 过去只认前者，改成分行拼接之后这三个工具被误判成「说明太短」。
      const description = resolveDescription(readDescription(block))
      if (!tools.has(name)) tools.set(name, { actions, description })
    }
  }
  return tools
}

const tools = readToolSurface()
const toolNames = [...tools.keys()].sort()
console.log(`· 工具面：${toolNames.length} 个（${toolNames.join(', ')}）`)
check('至少认出了 7 个工具', toolNames.length >= 7, toolNames)

// ---------------------------------------------------------------- read persona

const persona = readPersona()
check('读到了人格文本', persona.length > 200, { chars: persona.length })

// 人设只放「人设 / 任务分类 / 工作偏好 / 流程」，工具用法在工具说明里。
// 这条上限不是为了省 token，是为了防止用法悄悄长回人设里。
check('人设保持精简（≤1200 字）', persona.length <= 1200, {
  chars: persona.length,
  hint: '工具怎么用写进工具 description；人设只留身份、任务分类、偏好、流程',
})

// PTC 版人设只有两节：怎么用（run_code 一段程序做完一步）+ 规则。
// 身份写在开头那一句，不单独成节 —— 人设越短，模型越不会把它当清单去背。
const requiredSections = ['## 这个模式怎么用', '## 规则']
const missingSections = requiredSections.filter((s) => !persona.includes(s))
check('人设两节齐全（怎么用 + 规则）', missingSections.length === 0, { missing: missingSections })
const notToolNames = [
  'action', 'figure', 'lesson', 'measure', 'compare', 'log', 'op', 'zoom', 'view',
  'kind', 'status', 'text', 'evidence', 'query', 'json', 'yaml', 'plan',
]
// 人设里以「名字 {」形式出现的词，应该都是真工具（反引号里的用法示例不算）。
const usedAsTool = new Set([...persona.matchAll(/(?:^|[\s（(])([a-z][a-z0-9_]*)\s*\{/g)].map((m) => m[1]))
const invented = [...usedAsTool].filter((n) => !tools.has(n) && !notToolNames.includes(n))
check('提示词里没有把不存在的名字当工具用', invented.length === 0, { invented })

const bareLesson = [...persona.matchAll(/(?:^|[\s`（(])lesson\s*\{/g)].length
check('没有把 lesson 写成独立工具', bareLesson === 0, {
  hits: bareLesson,
  hint: '真身是 workspace action="lesson"，参数放进 lesson:{action,text,kind,status}',
})

// ------------------------------------------------- 2. action 必须在枚举里

const refs = []
for (const m of persona.matchAll(/([a-z]+)\s+action="([a-zA-Z]+)"/g)) refs.push([m[1], m[2]])
for (const m of persona.matchAll(/`([a-z]+)`\s*(?:的)?\s*`?action="?([a-zA-Z]+)/g)) refs.push([m[1], m[2]])
const badRefs = []
for (const [tool, action] of refs) {
  if (!tools.has(tool)) { badRefs.push({ tool, action, reason: 'no such tool' }); continue }
  const allowed = tools.get(tool).actions
  if (Array.isArray(allowed) && !allowed.includes(action)) {
    badRefs.push({ tool, action, reason: 'action not in enum', allowed })
  }
}
check('提示词里每个 工具+action 都真实存在', badRefs.length === 0, {
  refs: refs.length, bad: badRefs.slice(0, 6),
})

// ------------------------------------------------- 3. 关键能力在工具说明里

// 这些关键词必须出现在 server 源码里（也就是某个工具的描述或报错里），
// 否则模型根本不知道有这条路。
const allServerText = serverFiles.map((rel) => readFileSync(join(repoRoot, rel), 'utf8')).join('\n')
const mustExist = {
  'action="figure"': '读图（放大 + 网格）',
  'action="measure"': '语义测量（验收的数字来源）',
  'action="sketch"': '读回草图几何',
  'action="verify"': '对照图纸验收',
  'action="compare"': '原图与模型并排看',
  'action="lesson"': '经验库入口',
  'action="logs"': '结构化日志',
  'action="kinds"': '列出一个对象上真有的成员',
  unmeasured: '「没量成」不等于「尺寸不对」',
  available: '量空时先看零件上有哪些直径',
  tryTarget: 'invoke 打错对象时的指路',
  cid: '日志里的关联号',
}
const missing = Object.entries(mustExist)
  .filter(([needle]) => !allServerText.includes(needle))
  .map(([needle, why]) => `${needle} —— ${why}`)
check('关键能力在工具说明里都有入口', missing.length === 0, { missing })

// 每个工具都要有一段说得清的 description：用户要求用法写在工具里。
const thin = toolNames.filter((n) => String(tools.get(n).description ?? '').length < 60)
check('每个工具的说明都不少于 60 字', thin.length === 0, { thin })

// ------------------------------------------------- 4. 插件文件与登记

// 宿主侧插件都在 preset/ 下；用相对仓库根的路径，登记与 exports 两处都比对同一条。
const pluginFiles = {
  'preset/restrict-tools.js': '遮掉 bili 的上下文工具',
  'preset/experience-nudge.js': '收尾提醒记经验',
  'preset/experience-digest.js': '会话开始注入本机经验',
}
const missingPlugins = Object.entries(pluginFiles)
  .filter(([file]) => !existsSync(join(repoRoot, file)))
  .map(([file]) => file)
check('三个本地插件文件都在', missingPlugins.length === 0, { missing: missingPlugins })

const patchText = readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8')
const unregistered = Object.keys(pluginFiles).filter((file) => !patchText.includes(file))
check('三个本地插件都登记进了预设', unregistered.length === 0, { unregistered })

// 登记进预设还不够：它们是以 package 子路径引用的（@local/dsh-sw-preset/xxx.js），
// package.json 的 exports 里没有这一条，整个预设会在启动时解析失败 —— 而不是某个插件失效。
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const badExports = Object.keys(pluginFiles)
  .map((file) => `./${file}`)
  .filter((sub) => !(pkg.exports && pkg.exports[sub] === sub))
check('每个插件的 package 子路径都在 exports 里', badExports.length === 0, {
  missingExports: badExports,
  exports: Object.keys(pkg.exports ?? {}),
})

// ------------------------------------------------- 5. 工具返回里的提示也要真实

const fakeHints = [...allServerText.matchAll(/workspace action=([a-zA-Z]+)/g)]
  .map((m) => m[1])
  .filter((a) => !tools.get('workspace')?.actions?.includes(a))
check('工具返回里没有指向不存在的 workspace 动作', fakeHints.length === 0, {
  fake: [...new Set(fakeHints)],
})

// ------------------------------------------------- 6. PowerShell 辅助脚本的输出编码
//
// 仓库路径里有中文。PowerShell 默认按控制台代码页写 stdout，Node 按 utf8 读，
// 中文路径会变成乱码，接着就是 ENOENT —— 报错里还看不出是编码问题。
const psHelpers = ['compare.ps1', 'figure.ps1']
const badEncoding = psHelpers.filter((name) => {
  const text = readFileSync(join(repoRoot, 'server', name), 'utf8')
  return !text.includes('[Console]::OutputEncoding')
})
check('中文路径下跑得通的 PowerShell 脚本都设了 UTF-8 输出', badEncoding.length === 0, { missing: badEncoding })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
