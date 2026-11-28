// 预设清单自检：两个 SW 预设（建模 / 装配体）装的东西是否还自洽。
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


// ── 两个预设：建模（sw-native）与装配体（sw-assembly）。
// 共用同一套插件行，差别只在人设与各自的 config.preset；这里把「清单自洽」钉死。
const presets = readPresets(text)
check('patch 里读到 2 个预设', presets.length === 2, presets.map((p) => p.rowId))

const byRow = Object.fromEntries(presets.map((p) => [p.rowId, p]))
const model = byRow['preset-sw-model']
const assembly = byRow['preset-sw-assembly']
check('建模预设行还在', Boolean(model), Object.keys(byRow))
check('装配预设行还在', Boolean(assembly), Object.keys(byRow))
check('建模预设 config.id 是 sw-native', model?.configId === 'sw-native', model?.configId)
check('装配预设 config.id 是 sw-assembly', assembly?.configId === 'sw-assembly', assembly?.configId)
check('建模预设显示名是 sw建模自动化', model?.name === 'sw建模自动化', model?.name)
check('装配预设显示名是 sw装配体自动化', assembly?.name === 'sw装配体自动化', assembly?.name)
check('order 分别是 6 / 7', model?.order === 6 && assembly?.order === 7, [model?.order, assembly?.order])
check('没有重名预设', new Set(presets.map((p) => p.name)).size === presets.length, presets.map((p) => p.name))
check('旧 sw-ptc 预设行已删除', !byRow['preset-sw-ptc'], Object.keys(byRow))
check('清单里不再有 sw-ptc 的 config.id', !/^\s{8}id:\s*sw-ptc\s*$/m.test(text), 'found "id: sw-ptc"')
check('没有验收子代理预设', !byRow['preset-sw-review'], Object.keys(byRow))

// 插件文件必须真实存在（本地 link 包的路径写错时，mount 才会报错，太晚）
const localPlugins = presets.flatMap((p) => p.plugins).filter((name) => name.startsWith('dsh-sw-preset/'))
check('每个本地插件都指向存在的文件',
  localPlugins.length > 0 && localPlugins.every((name) => existsSync(join(repo, name.slice('dsh-sw-preset/'.length)))),
  localPlugins)

check('两个预设的插件行数一致', model?.plugins.length > 0 && model?.plugins.length === assembly?.plugins.length,
  [model?.plugins.length, assembly?.plugins.length])
for (const [label, preset] of [['建模', model], ['装配', assembly]]) {
  check(`${label}预设挂了 review-gate`, Boolean(preset?.plugins.some((n) => n.endsWith('review-gate.js'))), preset?.plugins)
  check(`${label}预设不挂 PTC 执行器`, !preset?.plugins.includes('@deepseek-ai/dsh-tool-executor-ptc'), preset?.plugins)
  check(`${label}预设不挂 planning`, !preset?.plugins.includes('@deepseek-ai/dsh-plan-mode'), preset?.plugins)
  check(`${label}预设不挂已废弃的 tool-presentation`, !preset?.plugins.includes('@deepseek-ai/dsh-agent-tool-presentation'), preset?.plugins)
}
check('清单里不再引用 PTC 执行器', !/dsh-tool-executor-ptc/.test(text), 'tool-executor-ptc still referenced')

// 本地插件的 config.preset 必须和它所在预设的 config.id 一致，否则 apply 里被静默跳过。
const blocks = text.split(/(?=^\s{4}- id: preset-)/m).slice(1)
check('按预设切出 2 段', blocks.length === 2, blocks.length)
for (const block of blocks) {
  const rowId = block.match(/- id: (preset-[\w-]+)/)?.[1]
  const configId = block.match(/^\s{8}id:\s*(\S+)\s*$/m)?.[1]
  const cfgs = [...block.matchAll(/^\s+preset:\s*(\S+)\s*$/gm)].map((m) => m[1])
  check(`${rowId}: 每个 preset 配置都指向自己的 id`,
    cfgs.length > 0 && cfgs.every((value) => value === configId), { configId, cfgs })
}
const bypassSrc = readFileSync(join(repo, 'preset', 'bili-bypass.js'), 'utf8')
check('bili-bypass 的目标预设与清单 id 一致', /TARGET_PRESET = 'sw-native'/.test(bypassSrc),
  bypassSrc.match(/TARGET_PRESET = '[^']+'/)?.[0])
check('bili-bypass 的 PRESET_IDS 覆盖两个预设',
  /PRESET_IDS = \['sw-native', 'sw-assembly'\]/.test(bypassSrc), bypassSrc.match(/PRESET_IDS = \[[^\]]+\]/)?.[0])

// ── 人设正文：按 YAML 块标量规则取出每一段（和 prompt.mjs 同一套规则）。
function readBlockScalars(source) {
  const out = []
  const lines = source.split('\n')
  let index = 0
  while (index < lines.length) {
    if (!/^\s*prefix:\s*\|-?\s*$/.test(lines[index])) { index += 1; continue }
    const indent = lines[index].match(/^\s*/)[0].length
    const body = []
    let i = index + 1
    for (; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line.trim()) { body.push(''); continue }
      const lead = line.match(/^\s*/)[0].length
      if (lead <= indent) break
      body.push(line)
    }
    const nonEmpty = body.filter((l) => l.trim())
    const common = Math.min(...nonEmpty.map((l) => l.match(/^\s*/)[0].length))
    out.push(body.map((l) => (l.trim() ? l.slice(common) : '')).join('\n'))
    index = i
  }
  return out
}

const personas = readBlockScalars(text)
check('两段人设', personas.length === 2, personas.length)
for (const [label, persona] of [['建模', personas[0] ?? ''], ['装配', personas[1] ?? '']]) {
  check(`${label}人设写明开工先 preflight`, /preflight/.test(persona), 'missing preflight')
  check(`${label}人设写明一次只做一个动作`, /(一个动作|单步)/.test(persona), 'missing single-action rule')
  check(`${label}人设不再出现 run_code`, !/run_code/.test(persona), persona.match(/run_code/))
  check(`${label}人设不再出现 part_* 名字`, !/part_(create|build|edit|inspect|check|export)/.test(persona), persona.match(/part_\w+/g))
}
check('装配人设写清“零件先落盘”', /assemble 只认磁盘上的 SLDPRT/.test(personas[1] ?? ''), 'missing on-disk rule')
check('装配人设写清 mates 复核', /action="mates"/.test(personas[1] ?? ''), 'missing mates check')

// 新会话默认走共享 broker；否则多会话又退回各自直连、在途作业无法复用。
check('mcp-sw 默认走共享 broker', /SW_MCP_BROKER:\s*'1'/.test(text) && /SW_MCP_BROKER_ENSURE:\s*'1'/.test(text),
  'missing SW_MCP_BROKER env on mcp-sw')

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1