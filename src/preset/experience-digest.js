// 会话开始时把本机经验直接放进上下文。
//
// 为什么需要它：经验库要靠模型自己想起来去查，等于没有。让它每轮都被「搜索一下」也很浪费 ——
// 一套测试跑下来，经验查询占了几十次调用。更好的做法是：会话一开就带着走。
//
// 做法：拦第一次工具调用，在结果后面追加一段「本机经验」。这就是模型在会话开头
// 看到的第一份工具结果（人设的第一步就是 workspace），所以等于「对话开始就加载」。
//
// 读取来源两个：knowledge/records.jsonl（新格式：条件/动作/观察/收益/版本）与
// knowledge/notes.jsonl（旧格式）。按「收益 + 最近使用 + 使用次数」排序，而不是
// 文件里的最后八条：追加顺序只反映写入时间，不反映哪条还有用。
//
// 只注入 curated 或 verified 的条目：一次性观察不该无差别地喂给每个会话。
// 库文件改动会被 mtime 发现，60 秒内复用缓存，不每次读盘。
//
// 注入失败绝不影响工具本身的返回：整个改写包在 try 里，出错就原样返回。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'sw-experience-digest'

const MAX_LINES = 8
const CACHE_MS = 60_000
const DAY_MS = 24 * 3600_000

let cache = { at: 0, stamp: '', lines: [] }
const injected = new Set()
const MAX_SESSIONS = 64
function rememberSession(key) {
  injected.add(key)
  // 单进程长期复用也要有个上限：只记住最近 64 个会话，旧的让它再注入一次也无害。
  if (injected.size > MAX_SESSIONS) injected.delete(injected.values().next().value)
}

function dataRoot() {
  return process.env.SW_MCP_DATA || path.join(process.env.LOCALAPPDATA || os.homedir(), 'sw-mcp')
}

function readJsonl(file) {
  let raw
  let stat
  try {
    stat = fs.statSync(file)
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { entries: [], stamp: 'missing' }
  }
  const entries = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      entries.push(JSON.parse(text))
    } catch {
      // 坏行跳过：一行写坏不该让整个经验库读不出来。
    }
  }
  return { entries, stamp: `${stat.mtimeMs}:${stat.size}` }
}

/** 新记录与旧 note 归一成同一形状；旧记录没有的条件字段留空。 */
function normalise(entry) {
  const text = String(entry.text ?? '').replace(/\s+/g, ' ').trim()
  const action = entry.action ? String(entry.action).trim() : ''
  const observation = entry.observation ? String(entry.observation).trim() : ''
  const composed = text || [action, observation].filter(Boolean).join(' → ')
  return {
    id: entry.id ?? null,
    text: composed,
    conditions: entry.conditions ?? entry.when ?? null,
    status: entry.status ?? (entry.curated === true ? 'curated' : 'working'),
    curated: entry.curated === true || entry.status === 'curated' || entry.status === 'verified',
    supersedes: entry.supersedes ?? null,
    supersededBy: entry.supersededBy ?? null,
    benefit: typeof entry.benefit === 'object' && entry.benefit !== null ? entry.benefit : null,
    lastUsed: entry.lastUsed ?? entry.at ?? null,
    useCount: Number.isFinite(entry.useCount) ? entry.useCount : 0,
    swVersion: entry.environment?.swVersion ?? entry.swVersion ?? null,
    kind: entry.kind ?? null,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
  }
}

function conditionText(conditions) {
  if (conditions === null || conditions === undefined) return ''
  if (typeof conditions === 'string') return conditions
  if (Array.isArray(conditions)) return conditions.map(conditionText).filter(Boolean).join('；')
  if (typeof conditions === 'object') {
    return Object.entries(conditions)
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join('；')
  }
  return String(conditions)
}

function score(entry, now) {
  const last = entry.lastUsed ? Date.parse(entry.lastUsed) : 0
  const ageDays = last ? Math.max(0, (now - last) / DAY_MS) : 90
  const recency = Math.max(0, 1 - ageDays / 90)
  const savedMs = Number(entry.benefit?.savedMs ?? entry.benefit?.wallClockMs ?? 0)
  const benefit = Math.min(1, savedMs > 0 ? savedMs / 60_000 : 0)
  const usage = Math.min(1, entry.useCount / 10)
  return 0.5 * recency + 0.3 * benefit + 0.2 * usage
}

function loadLines() {
  const root = dataRoot()
  const records = readJsonl(path.join(root, 'knowledge', 'records.jsonl'))
  const notes = readJsonl(path.join(root, 'knowledge', 'notes.jsonl'))
  const stamp = `r:${records.stamp}|n:${notes.stamp}`
  const now = Date.now()
  if (cache.stamp === stamp && now - cache.at < CACHE_MS) return cache.lines

  const merged = new Map()
  for (const entry of records.entries) {
    if (!entry || typeof entry !== 'object') continue
    const item = normalise(entry)
    if (!item.text) continue
    const key = item.id ?? `${item.text}|${item.lastUsed ?? ''}`
    merged.set(key, item)
  }
  // notes.jsonl 是旧格式；同 id 时以新记录为准。
  for (const entry of notes.entries) {
    if (!entry || typeof entry !== 'object') continue
    const item = normalise(entry)
    if (!item.text) continue
    const key = item.id ?? `${item.text}|${item.lastUsed ?? ''}`
    if (!merged.has(key)) merged.set(key, item)
  }

  const superseded = new Set()
  for (const item of merged.values()) {
    if (item.supersedes) superseded.add(item.supersedes)
  }
  // 旧记录没有 supersededBy 字段，只能从新条目的 supersedes 反推。
  const alive = [...merged.values()].filter((item) => {
    if (item.supersededBy) return false
    if (item.id && superseded.has(item.id)) return false
    if (['deprecated', 'stale', 'rejected'].includes(item.status)) return false
    return item.curated
  })

  alive.sort((a, b) => score(b, now) - score(a, now))
  const lines = alive.slice(0, MAX_LINES).map((item) => {
    const when = conditionText(item.conditions)
    const prefix = when ? `[${when}] ` : ''
    return `${prefix}${item.text}`.slice(0, 320)
  })
  cache = { at: now, stamp, lines }
  return lines
}

function sessionKey(exec) {
  const candidates = [
    exec?.sessionId,
    exec?.session?.id,
    exec?.agent?.sessionId,
    exec?.agent?.session?.id,
    exec?.context?.session?.id,
    exec?.context?.sessionId,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value) return value
  }
  return '(process)'
}

function digestText(lines) {
  if (!lines.length) return ''
  return [
    '',
    '---',
    `📌 本机经验（${lines.length} 条，都来自这台机器上的实测）：`,
    ...lines.map((line, i) => `${i + 1}. ${line}`),
  ].join('\n')
}

/**
 * 目标收尾时的轻量归并：同一个 observation 只留最新一条，其余写 supersededBy。
 * 只在文件确实有重复时重写；先写临时文件再 rename，避免半截 jsonl。
 * 并发窗口很小（收尾时 MCP 侧通常空闲），但仍以「读到的 mtime 没变」为条件。
 */
function compactNotes(root) {
  const file = path.join(root, 'knowledge', 'notes.jsonl')
  let raw
  let stat
  try {
    stat = fs.statSync(file)
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  const rows = []
  const groups = new Map()
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    let entry
    try { entry = JSON.parse(text) } catch { continue }
    rows.push(entry)
    if (!entry?.id || entry.supersededBy || entry.status === 'deprecated') continue
    const observation = String(entry.observation ?? '').trim().toLowerCase()
    if (!observation) continue
    if (!groups.has(observation)) groups.set(observation, [])
    groups.get(observation).push(entry)
  }
  let changed = 0
  const now = new Date().toISOString()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0))
    const [keeper, ...rest] = group
    for (const entry of rest) {
      entry.supersededBy = keeper.id
      entry.supersededAt = now
      changed += 1
    }
  }
  if (!changed) return 0
  try {
    const current = fs.statSync(file)
    if (current.mtimeMs !== stat.mtimeMs) return 0
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    return 0
  }
  return changed
}

let lastCompactAt = 0
function compactOnGoalDone(exec) {
  if (exec?.name !== 'update_goal') return
  if (!['complete', 'blocked'].includes(exec.arguments?.action)) return
  if (Date.now() - lastCompactAt < 60_000) return
  lastCompactAt = Date.now()
  try {
    const merged = compactNotes(dataRoot())
    if (merged > 0) ctxLogger?.(`experience-digest: 归并了 ${merged} 条重复经验`)
  } catch { /* 归并失败不影响工具结果 */ }
}
let ctxLogger = null

// 空闲归并：没有目标收尾也要整理。会话空闲 30 分钟后每隔一段时间检查一次，
// 同一批重复经验只留最新一条；6 小时内不重复扫同一个文件。
const IDLE_MS = 30 * 60_000
const IDLE_CHECK_MS = 10 * 60_000
const IDLE_COMPACT_MS = 6 * 3600_000
let lastActivityAt = Date.now()
let lastIdleCompactAt = 0
let idleTimer = null

function compactWhenIdle(logger) {
  if (Date.now() - lastActivityAt < IDLE_MS) return
  if (Date.now() - lastIdleCompactAt < IDLE_COMPACT_MS) return
  lastIdleCompactAt = Date.now()
  try {
    const merged = compactNotes(dataRoot())
    if (merged > 0) logger?.info?.(`experience-digest: 空闲归并了 ${merged} 条重复经验`)
  } catch { /* 空闲整理失败不影响后续 */ }
}

export function apply(ctx) {
  ctxLogger = ctx.logger ?? null
  idleTimer = setInterval(() => compactWhenIdle(ctx.logger), IDLE_CHECK_MS)
  idleTimer.unref?.()
  ctx.on('dispose', () => { if (idleTimer) clearInterval(idleTimer) })
  ctx.on('tools/execute', async (exec, next) => {
    lastActivityAt = Date.now()
    const result = await next()
    compactOnGoalDone(exec)

    try {
      const key = sessionKey(exec)
      if (injected.has(key)) return result

      // 会话里第一次调用就注入；之后不再打扰。
      rememberSession(key)
      const text = digestText(loadLines())
      if (!text) return result
      if (!result || result.isError) {
        // 这次调用失败也照样注入：失败原因比经验更值得先看，经验放后面。
        const content = Array.isArray(result?.content) ? [...result.content, { type: 'text', text }] : [{ type: 'text', text }]
        return { ...result, content }
      }

      const content = Array.isArray(result.content) ? [...result.content] : []
      content.push({ type: 'text', text })
      return { ...result, content }
    } catch (error) {
      ctx.logger?.warn?.(`experience-digest: 注入失败，已忽略：${error?.message ?? error}`)
      return result
    }
  })
}
