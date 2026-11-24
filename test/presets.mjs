// 预设清单自检：唯一 SW 预设装的东西是否还自洽。
//
// 这一轮里已经踩过两次同类问题：
//   · 人设里写着 `lesson { action: "add" }`，而那个工具根本不存在；
//   · 新增的插件写好了，却没登记进 cordis.patch.yml，于是它从来没跑过。
// 两个问题都不会报错，只会「安静地不生效」——这类问题只能靠清单断言抓。
//
// 2026-11-23 起 PTC 预设已删除，只留原生单步预设（id sw-native）。这里管四件事：
// 清单里只有这一块、PTC 入口没有残留、本地插件文件都真实存在、人设与开关口径一致。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const patchPath = join(repo, 'cordis.patch.yml')
const text = readFileSync(patchPath, 'utf8')

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) passed += 1
  else failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok && detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

// ── 一个够用的 YAML 扫描器：只关心「第几个预设、挂了哪些插件、config 里写了什么」。
// 不追求通用性 —— 通用解析要一个 yaml 依赖，而这个仓库故意不装运行时依赖给测试用。
function readPresets(source) {
  const rows = []
  let current = null
  let inPlugins = false
  for (const line of source.split('\n')) {
    const preset = /^\s{4}- id: (preset-[a-z0-9-]+)/.exec(line)
    if (preset) {
      current = { rowId: preset[1], configId: null, name: null, order: null, plugins: [] }
      rows.push(current)
      inPlugins = false
      continue
    }
    if (current === null) continue
    if (/^\s{8}id: /.test(line) && current.configId === null) {
      current.configId = line.trim().slice('id: '.length).trim()
      continue
    }
    if (/^\s{8}name: /.test(line) && current.name === null) {
      current.name = line.trim().slice('name: '.length).trim()
      continue
    }
    if (/^\s{8}order: /.test(line)) {
      current.order = Number(line.trim().slice('order: '.length))
      continue
    }
    if (/^\s{8}plugins:/.test(line)) { inPlugins = true; continue }
    if (!inPlugins) continue
    const pluginName = /^\s{12,}name: '?([^']+)'?/.exec(line)
    if (pluginName) { current.plugins.push(pluginName[1].trim()); continue }
    // 退出 plugins 段：出现更浅的 key（如 `      capabilities:`）
    if (/^\s{0,8}\S/.test(line) && line.trim() !== '') inPlugins = false
  }
  return rows
}

const presets = readPresets(text)
check('patch 里只读到 1 个预设', presets.length === 1, presets.map((p) => p.rowId))

const byRow = Object.fromEntries(presets.map((p) => [p.rowId, p]))
const native = byRow['preset-sw-native']
check('原生预设还在', Boolean(native), Object.keys(byRow))
check('config.id 是 sw-native', native?.configId === 'sw-native', native?.configId)
check('order 是 6', native?.order === 6, native?.order)
check('旧 sw-ptc 预设行已删除', !byRow['preset-sw-ptc'], Object.keys(byRow))
check('清单里不再有 sw-ptc 的 config.id', !/^\s{8}id:\s*sw-ptc\s*$/m.test(text), 'found "id: sw-ptc"')
check('清单里不再有 preset: sw-ptc 的插件配置', !/^\s+preset:\s*sw-ptc\s*$/m.test(text), 'found "preset: sw-ptc"')
check('没有验收子代理预设', !byRow['preset-sw-review'], Object.keys(byRow))
check('没有重名预设', new Set(presets.map((p) => p.name)).size === presets.length,
  presets.map((p) => p.name))

// 插件文件必须真实存在（本地 link 包的路径写错时，mount 才会报错，太晚）
const localPlugins = presets.flatMap((p) => p.plugins).filter((name) => name.startsWith('@local/dsh-sw-preset/'))
check('每个本地插件都指向存在的文件',
  localPlugins.length > 0 && localPlugins.every((name) => existsSync(join(repo, name.slice('@local/dsh-sw-preset/'.length)))),
  localPlugins)

// 审查门要挂在用户真正交付的那个预设上；挂在 review 预设里没有意义（它自己不会交付）。
check('原生预设挂了 review-gate', native.plugins.some((n) => n.endsWith('review-gate.js')), native.plugins)

// PTC 退场判据：预设里不能再出现 PTC 执行器，也不能再有整段程序的表达入口。
check('原生预设不再挂 PTC 执行器', !native.plugins.includes('@deepseek-ai/dsh-tool-executor-ptc'), native.plugins)
check('清单里不再引用 PTC 执行器', !/dsh-tool-executor-ptc/.test(text), 'tool-executor-ptc still referenced')
check('原生预设不再挂已废弃的 tool-presentation', !native.plugins.includes('@deepseek-ai/dsh-agent-tool-presentation'), native.plugins)
check('原生预设没有 planning（这个模式不靠 plan mode 约束顺序）',
  !native.plugins.includes('@deepseek-ai/dsh-plan-mode'), native.plugins)

// 本地插件的 config.preset 必须和预设 config.id 一致，否则会在 apply 里被静默跳过。
const presetCfgs = [...text.matchAll(/^\s+preset:\s*(\S+)\s*$/gm)].map((m) => m[1])
check('本地插件的 preset 配置都指向 sw-native',
  presetCfgs.length > 0 && presetCfgs.every((value) => value === 'sw-native'), presetCfgs)
const bypassSrc = readFileSync(join(repo, 'bili-bypass.js'), 'utf8')
check('bili-bypass 的目标预设与清单 id 一致',
  /TARGET_PRESET = 'sw-native'/.test(bypassSrc), bypassSrc.match(/TARGET_PRESET = '[^']+'/)?.[0])

// ── 人设正文：按 YAML 块标量规则取出来（和 prompt.mjs 同一套规则）。
function readBlockScalar(source) {
  const lines = source.split('\n')
  const marker = lines.findIndex((l) => /^\s*prefix:\s*\|-?\s*$/.test(l))
  if (marker < 0) return ''
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

const persona = readBlockScalar(text)
check('人设里不再出现被删掉的 part_* 名字', !/part_(create|build|edit|inspect|check|export)/.test(persona),
  persona.match(/part_\w+/g))

// 本轮起 SW 绘图只保留 native：PTC 人设里「图在程序结束后才到」「拒绝以异常抛进」
// 是 run_code 批处理特有的坑，人设已改成单步口径，这两条随之退役；改成校验 native
// 口径本身（开工先 preflight、一次一个动作）以及人设不再提整段程序入口。
check('native 人设写明开工先 preflight 一次', /preflight/.test(persona), 'missing preflight in persona')
check('native 人设写明一次只做一个动作', /(一个动作|单步)/.test(persona), 'missing single-action rule')
check('native 人设不再出现 run_code', !/run_code/.test(persona), persona.match(/run_code/))
// 新会话默认走共享 broker；否则多会话又退回各自直连、在途作业无法复用。
check('mcp-sw 默认走共享 broker', /SW_MCP_BROKER:\s*'1'/.test(text) && /SW_MCP_BROKER_ENSURE:\s*'1'/.test(text),
  'missing SW_MCP_BROKER env on mcp-sw')

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
