// Assembles the capability catalog from four sources and answers browse/search/
// detail questions over it.
//
// Why a cache: the interop index and the add-in registry are stable for a given
// SOLIDWORKS install, and rebuilding them costs a bridge round trip. The cache
// carries `builtAt` and the environment fingerprint so a stale catalog is
// visible rather than silently wrong.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { NATIVE_OPS, NATIVE_SOURCE } from './native.mjs'
import { scanLocal, LOCAL_SOURCE } from './local.mjs'
import { EXTERNAL, EXTERNAL_SOURCE } from './external.mjs'

const INTEROP_ENTRY_LIMIT = 150
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

export const SOURCES = [NATIVE_SOURCE, LOCAL_SOURCE, EXTERNAL_SOURCE, {
  id: 'addin',
  label: '已安装插件',
  description: '注册表登记的 SOLIDWORKS 插件，经 LoadAddIn + GetAddInObject 探活后给出可调用状态。',
}, {
  id: 'interop',
  label: 'SOLIDWORKS API 接口',
  description: 'interop 程序集里的接口，可浏览成员签名，并经 invoke 直接调用。',
}]

function readCache(file) {
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw?.builtAt || !Array.isArray(raw.entries)) return null
    if (Date.now() - Date.parse(raw.builtAt) > CACHE_MAX_AGE_MS) return null
    return raw
  } catch {
    return null
  }
}

function writeCache(file, catalog) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(catalog), 'utf8')
  } catch {
    // A read-only data directory must not break browsing.
  }
}

async function interopEntries(callBridge) {
  // The type list is long and the bridge pages it, so walk the pages until we
  // have enough interfaces rather than taking one page and living with whatever
  // happened to sort first.
  const interfaces = []
  let offset = 0
  for (let page = 0; page < 8 && interfaces.length < INTEROP_ENTRY_LIMIT; page++) {
    const chunk = await callBridge('interopIndex', { mode: 'types', offset, limit: 500 })
    for (const t of chunk.types ?? []) {
      if (t.kind === 'interface' && t.members > 0) interfaces.push(t)
      if (interfaces.length >= INTEROP_ENTRY_LIMIT) break
    }
    if (chunk.nextOffset === null || chunk.nextOffset === undefined) break
    offset = chunk.nextOffset
  }
  return interfaces.slice(0, INTEROP_ENTRY_LIMIT).map((t) => ({
    id: `interop:${t.name}`,
    kind: 'interop-member',
    source: 'interop',
    category: 'API 接口',
    title: t.name,
    summary: `${t.members} 个成员，可浏览签名或用 model action=invoke 直接调用。`,
    memberCount: t.members,
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '调用目标对象' },
        member: { type: 'string', description: '成员名' },
        args: { type: 'array', description: '按签名顺序的参数' },
      },
    },
    execute: { tool: 'model', action: 'invoke', args: { iface: t.name } },
    status: 'available',
  }))
}

async function addinEntries(callBridge) {
  const result = await callBridge('addins', {})
  const entries = (result.entries ?? []).map((a) => {
    const title = a.title || a.Title || a.Description || a.clsid
    return {
      id: `addin:${a.clsid}`,
      kind: 'addin',
      source: 'addin',
      category: '插件',
      title: String(title).slice(0, 120),
      summary: a.loadAtStartup
        ? '开机加载的 SOLIDWORKS 插件。'
        : '注册表登记但未设为开机加载；调用前需要 LoadAddIn。',
      clsid: a.clsid,
      dll: a.dll ?? null,
      loadAtStartup: a.loadAtStartup ?? null,
      registryPath: a.registryPath,
      schema: {
        type: 'object',
        properties: { clsid: { type: 'string', const: a.clsid }, dll: { type: 'string' } },
      },
      execute: { tool: 'catalog', action: 'probe', args: { what: 'addins' } },
      status: a.dll ? 'unverified' : 'registry-only',
    }
  })
  return { entries, probed: !!result.probed, count: result.count ?? entries.length }
}

/**
 * Builds (or reloads) the catalog.
 *
 * Sources that need the bridge are allowed to fail independently: with
 * SOLIDWORKS closed, or the bridge missing, the native and local sources are
 * still worth browsing, and the failure is recorded per source rather than
 * thrown away.
 */
export async function buildCatalog({ callBridge, repoRoot, cacheFile, force = false }) {
  if (!force) {
    const cached = readCache(cacheFile)
    if (cached) return { ...cached, fromCache: true }
  }

  const errors = []
  const entries = []

  entries.push(...NATIVE_OPS.map((op) => ({
    kind: 'native-op',
    source: 'solidworks-native',
    category: '原生能力',
    status: 'available',
    ...op,
  })))

  try {
    entries.push(...scanLocal({ repoRoot }))
  } catch (error) {
    errors.push({ source: 'local-resource', message: String(error?.message ?? error) })
  }

  entries.push(...EXTERNAL.map((e) => ({
    kind: 'external',
    source: 'external',
    category: '外部扩展',
    ...e,
  })))

  let addinInfo = { probed: false, count: 0 }
  try {
    const addins = await addinEntries(callBridge)
    entries.push(...addins.entries)
    addinInfo = { probed: addins.probed, count: addins.count }
  } catch (error) {
    errors.push({ source: 'addin', message: error?.code ?? String(error?.message ?? error) })
  }

  let interopSummary = null
  try {
    const summary = await callBridge('interopIndex', { mode: 'summary' })
    interopSummary = {
      sldworksTypes: summary.sldworksTypes,
      interopVersion: summary.interopVersion,
    }
    entries.push(...(await interopEntries(callBridge)))
  } catch (error) {
    errors.push({ source: 'interop', message: error?.code ?? String(error?.message ?? error) })
  }

  // A duplicate id would make detail lookups ambiguous; first definition wins,
  // which puts curated native ops ahead of generated interop entries.
  const seen = new Set()
  const unique = []
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    unique.push(entry)
  }

  const catalog = {
    builtAt: new Date().toISOString(),
    sources: SOURCES,
    counts: countBy(unique),
    interop: interopSummary,
    addins: addinInfo,
    errors,
    entries: unique,
  }
  writeCache(cacheFile, catalog)
  return { ...catalog, fromCache: false }
}

function countBy(entries) {
  const counts = {}
  for (const entry of entries) counts[entry.source] = (counts[entry.source] ?? 0) + 1
  return counts
}

/** 中文说法 → 英文关键词。模型手里只有 op id 和英文参数名，用户嘴里是「改尺寸」「孔阵列」
 *  这类词；没有这层映射，一条都命中不了。 */
const ALIASES = {
  '尺寸': ['dimension', 'param', 'driver', 'size'],
  '改尺寸': ['dimension', 'param', 'driver', 'edit'],
  '参数': ['param', 'driver', 'dimension'],
  '草图': ['sketch', 'profile'],
  '轮廓': ['profile', 'sketch', 'outline'],
  '拉伸': ['extrude', 'boss'],
  '旋转': ['revolve'],
  '切除': ['cut', 'pocket'],
  '孔': ['hole', 'circle', 'drill'],
  '阵列': ['pattern'],
  '圆角': ['fillet'],
  '倒角': ['chamfer'],
  '齿轮': ['gear', 'teeth', 'tooth', 'module'],
  '装配': ['assembly', 'component', 'insert'],
  '配合': ['mate', 'concentric', 'coincident'],
  '约束': ['relation', 'constraint', 'mate'],
  '测量': ['measure', 'inspect', 'geometry', 'volume'],
  '体积': ['volume', 'mass'],
  '截图': ['capture', 'image', 'shot'],
  '存盘': ['save', 'deliver', 'export'],
  '保存': ['save', 'deliver'],
  '交付': ['deliver', 'save', 'export'],
  '导出': ['export', 'step', 'pdf', 'dxf'],
  '图纸': ['drawing', 'view', 'pdf'],
  '工程图': ['drawing', 'view'],
  '修改': ['edit', 'update', 'set'],
  '删除': ['delete', 'remove'],
  '查询': ['inspect', 'list', 'get'],
  '状态': ['status', 'health'],
  '实例': ['instance', 'reap', 'broker'],
  '零件': ['part', 'model', 'design'],
  '建模': ['build', 'create', 'model'],
  '旋转体': ['revolve'],
  '键槽': ['slot', 'keyway'],
}

/** 查询词展开：整段 + 中文二元组 + 别名映射，全部小写去重。 */
function queryTokens(q) {
  const low = String(q ?? '').toLowerCase().trim()
  if (!low) return []
  const tokens = new Set()
  for (const part of low.split(/[\s,，、;；/|()（）\[\]【】]+/)) {
    if (!part) continue
    tokens.add(part)
    for (const run of part.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
      for (let i = 0; i + 2 <= run.length; i += 1) tokens.add(run.slice(i, i + 2))
    }
  }
  for (const [cn, ens] of Object.entries(ALIASES)) {
    if (low.includes(cn)) for (const en of ens) tokens.add(en)
  }
  return [...tokens].filter((tok) => tok.length >= 2)
}

/** 排序检索：标题 > id > execute.action > 分类 > 摘要 > 参数名 > 调用示例。
 *  Why 按词而不是整段：以前 "改尺寸" 一条都搜不到，整段子串匹配对中文太脆。 */
export function searchCatalog(entries, { q, source, status, category, kind } = {}) {
  let list = entries
  if (source) list = list.filter((e) => e.source === source)
  if (status) list = list.filter((e) => e.status === status)
  if (category) list = list.filter((e) => e.category === category)
  if (kind) list = list.filter((e) => e.kind === kind)
  const tokens = queryTokens(q)
  if (tokens.length === 0) return list

  const scored = []
  for (const entry of list) {
    const title = String(entry.title ?? '').toLowerCase()
    const id = String(entry.id ?? '').toLowerCase()
    const cat = String(entry.category ?? '').toLowerCase()
    const summary = String(entry.summary ?? '').toLowerCase()
    const action = String(entry.execute?.action ?? '').toLowerCase()
    const take = (Array.isArray(entry.take) ? entry.take.join(' ') : String(entry.take ?? '')).toLowerCase()
    const props = Object.keys(entry.schema?.properties ?? {}).join(' ').toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (title.includes(token)) score += 10
      if (id.includes(token)) score += 8
      if (action.includes(token)) score += 6
      if (cat.includes(token)) score += 4
      if (summary.includes(token)) score += 3
      if (props.includes(token)) score += 3
      if (take.includes(token)) score += 2
    }
    if (score > 0) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
  return scored.map((s) => s.entry)
}
export function pageOf(list, { offset = 0, limit = 25 } = {}) {
  const safeLimit = Math.min(Math.max(limit, 1), 200)
  const safeOffset = Math.max(offset, 0)
  const page = list.slice(safeOffset, safeOffset + safeLimit)
  return {
    total: list.length,
    offset: safeOffset,
    limit: safeLimit,
    returned: page.length,
    nextOffset: safeOffset + page.length < list.length ? safeOffset + page.length : null,
    items: page,
  }
}

/** Compact projection for list views. Full entries carry schemas and evidence;
 * a listing of two hundred of those would swamp a context window. */
export function brief(entry) {
  return {
    id: entry.id,
    source: entry.source,
    category: entry.category,
    title: entry.title,
    status: entry.status,
    summary: (entry.summary ?? '').slice(0, 160),
  }
}

export function findEntry(entries, id) {
  return entries.find((e) => e.id === id) ?? null
}
