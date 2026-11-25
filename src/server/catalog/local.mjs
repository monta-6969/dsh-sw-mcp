// Local resources: what is already on this machine and can be used without
// installing anything — templates, Toolbox libraries, design library, macros,
// and the skills that ship with this bundle.
//
// These are scanned rather than hard-coded because the point of the catalog is
// to answer "what can I do *here*", and a hard-coded list would drift the first
// time the user installs a Toolbox standard or adds a template.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

const TEMPLATE_DIRS = [
  'C:/ProgramData/SOLIDWORKS/SOLIDWORKS 2026/templates',
  'C:/ProgramData/SOLIDWORKS/SOLIDWORKS 2026/Templates',
]
const TOOLBOX_DIR = 'C:/Program Files/SOLIDWORKS Corp/SOLIDWORKS/Toolbox/data'
const DESIGN_LIBRARY_DIRS = [
  'C:/ProgramData/SOLIDWORKS/SOLIDWORKS 2026/Design Library',
  'C:/ProgramData/SOLIDWORKS/SOLIDWORKS 2026/design library',
]
const MACRO_DIRS = [
  join(process.env.APPDATA ?? '', 'SOLIDWORKS'),
  'C:/ProgramData/SOLIDWORKS/SOLIDWORKS 2026/macros',
]

const TEMPLATE_KIND = {
  '.prtdot': { kind: 'part', title: '零件模板' },
  '.asmdot': { kind: 'assembly', title: '装配体模板' },
  '.drwdot': { kind: 'drawing', title: '工程图模板' },
}

const SHEET_NAME = {
  'gb_a0.drwdot': 'A0 横放',
  'gb_a1.drwdot': 'A1 横放',
  'gb_a2.drwdot': 'A2 横放',
  'gb_a3.drwdot': 'A3 横放',
  'gb_a4.drwdot': 'A4 横放',
  'gb_a4p.drwdot': 'A4 竖放',
}

function safeList(dir, filter) {
  if (!dir || !existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((name) => (filter ? filter(name) : true))
      .map((name) => {
        const path = join(dir, name)
        let size = 0
        let modified = null
        try {
          const st = statSync(path)
          size = st.size
          modified = st.mtime.toISOString()
        } catch {}
        return { name, path, size, modified }
      })
  } catch {
    return []
  }
}

/** Toolbox ships its standards as .slb binaries. We do not parse them: the file
 * names and sizes are enough to tell the user which standards are installed and
 * to point a later reader at the right binary when one does get parsed. */
const TOOLBOX_LIBRARY = {
  'holefeat.slb': '孔特征库（异型孔向导的标准数据）',
  'hardware.slb': '标准件库（螺栓、螺母、垫圈）',
  'groove.slb': '槽与挡圈槽',
  'pem.slb': '压铆螺母/压铆螺柱',
  'steel.slb': '型钢截面',
  'rring.slb': '挡圈',
}

export function scanLocal({ repoRoot }) {
  const entries = []

  for (const dir of TEMPLATE_DIRS) {
    if (!existsSync(dir)) continue
    for (const file of safeList(dir, (n) => TEMPLATE_KIND[extname(n).toLowerCase()] !== undefined)) {
      const meta = TEMPLATE_KIND[extname(file.name).toLowerCase()]
      entries.push({
        id: `template:${file.name}`,
        kind: 'local-resource',
        source: 'local-resource',
        category: '模板',
        title: SHEET_NAME[file.name] ?? `${meta.title} ${basename(file.name, extname(file.name))}`,
        summary: `${meta.title}，${file.size} B`,
        path: file.path,
        size: file.size,
        modified: file.modified,
        schema: { type: 'object', properties: { template: { type: 'string', const: file.path } } },
        execute: { tool: 'model', action: 'create', args: { template: file.path, type: meta.kind } },
        status: 'available',
      })
    }
  }

  for (const file of safeList(TOOLBOX_DIR, (n) => n.toLowerCase().endsWith('.slb'))) {
    entries.push({
      id: `toolbox:${file.name}`,
      kind: 'local-resource',
      source: 'local-resource',
      category: 'Toolbox',
      title: TOOLBOX_LIBRARY[file.name] ?? `Toolbox 库 ${file.name}`,
      summary: `Toolbox 标准数据 ${file.size} B。要真正取用需先 LoadAddIn 工具箱插件再取对象。`,
      path: file.path,
      size: file.size,
      schema: { type: 'object', properties: { standard: { type: 'string' }, size: { type: 'string' } } },
      execute: { tool: 'catalog', action: 'probe', args: { what: 'addins' } },
      status: 'available',
    })
  }

  for (const dir of DESIGN_LIBRARY_DIRS) {
    const files = safeList(dir, (n) => /\.(sldlfp|sldprt|sldasm)$/i.test(n))
    if (!files.length) continue
    entries.push({
      id: 'local:designLibrary',
      kind: 'local-resource',
      source: 'local-resource',
      category: '设计库',
      title: '设计库',
      summary: `${files.length} 个可拖入的零件/库特征`,
      path: dir,
      count: files.length,
      schema: { type: 'object', properties: { name: { type: 'string' } } },
      execute: { tool: 'model', action: 'assembly', args: { partPath: join(dir, files[0].name) } },
      status: 'available',
    })
  }

  for (const dir of MACRO_DIRS) {
    for (const file of safeList(dir, (n) => /\.swp$/i.test(n))) {
      entries.push({
        id: `macro:${file.name}`,
        kind: 'local-resource',
        source: 'local-resource',
        category: '宏',
        title: `宏 ${file.name}`,
        summary: `SOLIDWORKS 宏，${file.size} B。RunMacro2 在本机尚未验证。`,
        path: file.path,
        size: file.size,
        schema: { type: 'object', properties: { macro: { type: 'string' }, module: { type: 'string' }, method: { type: 'string' } } },
        execute: { tool: 'model', action: 'invoke', args: { target: 'app', member: 'RunMacro2' } },
        status: 'unverified',
      })
    }
  }

  for (const dir of [join(repoRoot, 'skills')].filter((d) => existsSync(d))) {
    for (const name of safeList(dir, () => true)) {
      const md = join(dir, name.name, 'SKILL.md')
      if (!existsSync(md)) continue
      entries.push({
        id: `skill:${name.name}`,
        kind: 'local-resource',
        source: 'local-resource',
        category: '技能',
        title: `技能 ${name.name}`,
        summary: '本 bundle 自带的操作手册，模型可直接读。',
        path: md,
        schema: { type: 'object', properties: { path: { type: 'string', const: md } } },
        execute: { tool: 'workspace', action: 'read', args: { path: md } },
        status: 'available',
      })
    }
  }

  return entries
}

export const LOCAL_SOURCE = {
  id: 'local-resource',
  label: '本机资源',
  description: '模板、Toolbox 标准库、设计库、宏与技能文件 —— 已装好、可直接用。',
}
