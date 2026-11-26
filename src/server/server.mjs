// SOLIDWORKS 建模 MCP 服务。
//
// 这个进程不懂 SOLIDWORKS：它把工具调用翻译成桥接器（SwBridge.exe）能读的
// 一行 JSON，桥接器再用 COM 把请求送进用户已经打开的那个 SOLIDWORKS 进程。
// 真正的建模逻辑在 bridge/src/*.cs 里。
//
//   MCP (stdio)  ◀──▶  server.mjs  ◀──▶  SwBridge.exe  ◀──▶  SLDWORKS.exe
//
// 三件事在这里做，不放进桥接器：
//   1. 经验与配方的读写（%LOCALAPPDATA%\sw-mcp\knowledge）—— 桥接器依赖 SOLIDWORKS，
//      而最需要记教训的时刻恰恰是 SOLIDWORKS 不在正常状态的时候。
//   2. 设计定义的持久化（项目状态）—— 同一份 JSON 既是入参也是存档。
//   3. 11 个工具的统一返回形状。
import { SW_CLIENT_ID, clientIdFor, instanceRequestParams } from './session-id.mjs'
import { boundPidForSession } from './broker/instances.mjs'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, unlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, basename, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerObserveTools } from './tools-observe.mjs'
import { registerDatumTools, planPlacementComponents } from './tools-datum.mjs'
import { planSketch, describePlan, sketchBuildCheck } from './geometry-plan.mjs'
import { registerCalculateTools } from './tools-calculate.mjs'
import { registerAnalysisTools } from './tools-analysis.mjs'
import { registerJobTools } from './tools-jobs.mjs'
import { registerTaskTools } from './tools-task.mjs'
import { registerCompactTools, reviewInspectSchema } from './tools-compact.mjs'
import {
  CAPABILITY_BRIEFS, DESCRIPTIONS, ON_DEMAND_WHOLE, TOOL_SPLITS, actionOwner, actionOwnerAnywhere, buildGroupSchema, capabilityOf,
  coreToolNames, onDemandCapabilities, sourceActions,
} from './tool-face.mjs'
import { createStageRuntime, stageBridgeContext } from './runtime.mjs'
import { formatMatrix, formatPoint, rotationReadout } from './bridge-readout.mjs'
import { geometryReadouts, runCheck, tallyChecks } from './verify.mjs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { LOG_DIR, digestArgs, newCorrelationId, pruneLogs, readEvents, writeEvent } from './logs.mjs'
import { DISPATCH } from './catalog/dispatch.generated.mjs'
import { BrokerClient } from './broker/client.mjs'
import {
  bumpRevision, liveRevisionOf, readLiveRecord, recordDeliveryApproval, recordDocumentTitle, recordImage, recordVerify,
} from './review-live.mjs'
import {
  checkDocumentIdentity, checkSavePath, designIdRequired, isGenericTitle, resolveDesignId as resolveDesignIdOnly,
} from './review-guard.mjs'
import { SELECTION_MEMBERS, convertLengthArgs } from './invoke-units.mjs'
import { expandGearPrimitives, gearSpecs, expandNativeGear } from './gear.mjs'
import { openAnalysis } from './analysis/client.mjs'
import {
  buildDesign, buildManifest, canonicalJson, designFileFor, driftOf, evaluateTiers, hashFile, hashText, manifestFileFor,
  patchDesign, readContract, restoreCad, snapshotCad, writeJsonAtomic,
} from './design-store.mjs'
// deliver 的「文档从哪儿来」决策是纯函数：多会话关掉文档后按 designId 重开/重建，
// 判据离线可测（test/deliver-route.mjs），不必起 SOLIDWORKS。
import {
  closeTargetFacts, judgeReopenedDocument, normalizeOpenDocuments, planDeliverRoute,
} from './deliver-route.mjs'
import { coerceDefinition } from './definition-arg.mjs'

// 一次工具调用一个关联号，桥接器的每一跳都带上它。这样「这次失败到底发了什么
// 给 SOLIDWORKS」是查日志能回答的，而不是靠回忆。
const cidStore = new AsyncLocalStorage()
function currentCid() {
  return cidStore.getStore() ?? null
}

/** 从工具的返回里抠出状态和摘要，写进日志。 */
function envelopeDigest(result) {
  const text = result?.content?.find((c) => c.type === 'text')?.text
  if (!text) return { images: (result?.content ?? []).filter((c) => c.type === 'image').length }
  try {
    const envelope = JSON.parse(text)
    return {
      status: envelope.status,
      summary: typeof envelope.summary === 'string' ? envelope.summary.slice(0, 300) : undefined,
      error: envelope.extra?.error ?? undefined,
      code: envelope.extra?.error?.code,
    }
  } catch {
    return { text: text.slice(0, 300) }
  }
}
import { randomUUID } from 'node:crypto'
import z from 'zod'
import {
  buildCatalog,
  searchCatalog,
  pageOf,
  brief,
  findEntry,
  SOURCES,
} from './catalog/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// 桥接器每次编译成带时间戳的新文件（跑起来会被占用，同名覆盖必然失败），
// 所以启动时扫一遍目录取最新的那个。
function newestBridge() {
  const dir = join(root, 'bridge', 'bin')
  try {
    const candidates = readdirSync(dir)
      .filter((name) => /^SwBridge(-[0-9]{14})?\.exe$/i.test(name))
      .map((name) => ({ name, time: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
    if (candidates.length > 0) return join(dir, candidates[0].name)
  } catch {
    // 目录不存在或读不了，退回约定名，让后面的启动报错带上下文。
  }
  return join(dir, 'SwBridge.exe')
}

const DEFAULTS = {
  bridgeExe: newestBridge(),
  requestTimeoutMs: 240000,
}

function loadConfig() {
  const file = process.env.SW_MCP_CONFIG || join(here, 'sw.config.json')
  if (!existsSync(file)) return { ...DEFAULTS }
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {
    process.stderr.write(`[sw-mcp] sw.config.json 解析失败，使用默认值: ${error.message}\n`)
    return { ...DEFAULTS }
  }
}

const config = loadConfig()

// ---------------------------------------------------------------------------
// 持久数据分三类，互不混用：
//
//   通用经验 notes.jsonl      —— API 用法、失败原因、有效参数。按操作和环境检索。
//   建模配方 recipes.json     —— 板件、轴件、孔组这类可参数化流程。能直接展开成设计定义。
//   项目状态 projects/<id>.json —— 设计定义 + 当前步骤 + 已产出文件 + 下一步。
//
// DSH 管会话历史，这里管跨会话的工程经验，项目记录管续接工作。
// ---------------------------------------------------------------------------
const DATA_DIR = (() => {

  // SW_MCP_DATA 让测试有一个干净的库：不写进来的话，一条测试用的经验会出现在
  // 之后每个会话的 `workspace` 提示里 —— 那正是「测试污染生产」的典型样子。
  const base = process.env.LOCALAPPDATA
  const dir = process.env.SW_MCP_DATA || (base ? join(base, 'sw-mcp') : join(tmpdir(), 'sw-mcp'))
  for (const sub of ['knowledge', 'projects', 'tmp']) {
    try {
      mkdirSync(join(dir, sub), { recursive: true })
    } catch {
      // 建不出来就让后面的读写自己报错，那里有更具体的上下文。
    }
  }
  return dir
})()
// diff 会把当前模型导出成 STEP 当证据；超过一天的中间文件没人再读，启动时收掉。
try {
  const tmpDir = join(DATA_DIR, 'tmp')
  const cutoff = Date.now() - 24 * 3600_000
  for (const name of readdirSync(tmpDir)) {
    if (!/^diff-.*\.step$/.test(name)) continue
    const path = join(tmpDir, name)
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
    } catch { }
  }
} catch { }


const NOTES_FILE = join(DATA_DIR, 'knowledge', 'notes.jsonl')
const RECIPES_FILE = join(DATA_DIR, 'knowledge', 'recipes.json')
const PROJECTS_DIR = join(DATA_DIR, 'projects')
const CATALOG_FILE = join(DATA_DIR, 'catalog', 'index.json')

// 只读工具面：审查子代理（sw-review）用 SW_MCP_TOOLS=inspect 启动本服务的第二个
// 实例，只注册 inspect —— 它需要回读关系/模型，但绝不能改用户的文档。
// 为什么要在这层做：dsh-mcp-client 没有工具白名单配置，而 restrict-tools 只作用
// 于全局工具，管不到预设里注册的 MCP 工具。
const MCP_TOOL_ALLOWLIST = (() => {
  const raw = process.env.SW_MCP_TOOLS
  if (typeof raw !== 'string' || raw.trim() === '') return null
  return new Set(raw.split(',').map((name) => name.trim()).filter(Boolean))
})()
const COMPACT_MCP = process.env.SW_MCP_SURFACE === 'compact' && MCP_TOOL_ALLOWLIST === null
const operationContext = new AsyncLocalStorage()

const NOTES_SCAN_LIMIT = 500

function readNotes() {
  let text
  try {
    if (!existsSync(NOTES_FILE)) return { entries: [], truncated: false }
    text = readFileSync(NOTES_FILE, 'utf8')
  } catch {
    return { entries: [], truncated: false }
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  const truncated = lines.length > NOTES_SCAN_LIMIT
  const slice = truncated ? lines.slice(-NOTES_SCAN_LIMIT) : lines
  const entries = []
  for (const line of slice) {
    try {
      entries.push(JSON.parse(line))
    } catch {
      // 坏行跳过：一行写坏不该让整个经验库读不出来。
    }
  }
  return { entries, truncated }
}

/**
 * 一条经验的检索键：正文、类别、标签、以及它被记下来时用的操作名与 SW 版本。
 * 检索按这些字段一起匹配，因为「孔距边不跟着改」这种问题只会出现在特定操作上。
 */
function noteHaystack(entry) {
  const conditions = entry?.conditions === undefined ? ''
    : (typeof entry.conditions === 'string' ? entry.conditions : JSON.stringify(entry.conditions))
  return [
    entry?.text ?? '',
    entry?.kind ?? '',
    entry?.op ?? '',
    entry?.swVersion ?? '',
    entry?.status ?? '',
    entry?.action ?? '',
    entry?.observation ?? '',
    conditions,
    ...(Array.isArray(entry?.tags) ? entry.tags : []),
    ...(Array.isArray(entry?.evidenceRefs) ? entry.evidenceRefs : []),
  ]
    .join(' ')
    .toLowerCase()
}

/** 经验的检索排序：命中的字段越多越靠前，同分取最近使用。 */
function noteScore(entry, needle, now) {
  const hay = noteHaystack(entry)
  let score = hay.includes(needle) ? 1 : 0
  if (needle && String(entry?.text ?? '').toLowerCase().includes(needle)) score += 2
  const savedMs = Number(entry?.benefit?.savedMs ?? entry?.benefit?.wallClockMs ?? 0)
  if (savedMs > 0) score += Math.min(1, savedMs / 60_000) * 0.5
  if (Number(entry?.useCount) > 0) score += Math.min(1, Number(entry.useCount) / 10) * 0.3
  const at = Date.parse(entry?.lastUsed ?? entry?.at ?? 0)
  if (at) score += Math.max(0, 1 - (now - at) / (90 * 24 * 3600_000)) * 0.4
  return score
}

function listNotes({ query, kind, limit, includeSuperseded } = {}) {
  const { entries, truncated } = readNotes()
  const needle = query && String(query).trim() ? String(query).trim().toLowerCase() : null
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20

  const superseded = new Set(entries.filter((e) => e?.supersedes).flatMap((e) => [e.supersedes]))

  const matched = []
  const now = Date.now()
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (!entry) continue
    if (kind && entry.kind !== kind) continue
    if (!includeSuperseded && (superseded.has(entry.id) || entry.supersededBy)) continue
    if (needle && !noteHaystack(entry).includes(needle)) continue
    matched.push({ entry, score: needle ? noteScore(entry, needle, now) : (Date.parse(entry.lastUsed ?? entry.at ?? 0) || 0) })
  }
  // 有检索词时按相关性，否则按最近使用/写入；两者都不按文件追加顺序硬截断。
  matched.sort((a, b) => b.score - a.score)
  return { entries: matched.slice(0, max).map((item) => item.entry), truncated, total: entries.length }
}

/**
 * 开工前自动带上的经验摘要：只取 curated / verified 的条目，最多 8 条，按最近使用排序。
 * 不做检索 —— 还没有任务描述可检索；这里是「这台机器上已知会咬人的地方」。
 *
 * 与 experience-digest.js 同一口径：working 状态的一次性观察不进 status，
 * 否则某次探针的尺寸与体积会在每个会话开头被原文注入。
 * 读不到、读坏了都回 undefined —— 经验库的毛病不该影响 status 的返回。
 */
function isCuratedNote(entry) {
  return entry?.curated === true || entry?.status === 'curated' || entry?.status === 'verified'
}

function notesForStatus(limit = 8) {
  try {
    const { entries } = readNotes()
    const alive = entries.filter((e) => e && isCuratedNote(e) && !e.supersededBy)
    if (alive.length === 0) return undefined
    const max = Math.min(Number.isInteger(limit) && limit > 0 ? limit : 8, 8)
    const recent = alive
      .map((e) => ({ e, at: Date.parse(e.lastUsed ?? e.at ?? 0) || 0 }))
      .sort((a, b) => b.at - a.at)
      .slice(0, max)
    return recent.map(({ e }) => ({
      id: e.id,
      kind: e.kind,
      status: e.status,
      text: e.text,
      ...(e.op ? { op: e.op } : {}),
    }))
  } catch {
    return undefined
  }
}

/**
 * 入库门槛。
 *
 * 为什么要有：经验库是长期记忆，写错一条会污染之后每一个会话。历史上它被塞进过
 * 测试脚本的临时观察（「m7-… 这条经验写在一个进程里…」）和整段设计定义 —— 前者
 * 只对那次测试成立，后者根本不是经验。所以入库前先过三道闸：
 *   1. 长度：一句话讲得完的才是经验，超过 240 字的多半是日志或设计定义；
 *   2. 来源：测试专用前缀直接拒（想记也可以，重写成结论句）；
 *   3. 重复：与已有条目重合就不再写一条。
 * 拒绝时回 LESSON_REJECTED 并给 hint，让调用方知道怎么改，而不是静默丢掉。
 */
const LESSON_MAX_CHARS = 240
const LESSON_TEST_PREFIX = /^(?:m\d+-|test[-_]|probe[-_]|acceptance[-_]|suite[-_]|smoke[-_]|kinds[-_]|unmeasured[-_]|cwd[-_]|patch[-_])/i
const LESSON_TEST_PHRASE = /这条经验写在|SW_MCP_DATA|checks passed|PASS |FAIL /i

function lessonGate(text) {
  const body = String(text ?? '').trim()
  if (!body) return { message: '经验正文是空的', hint: '写一句：做了什么 → 看到什么现象 → 结论。' }
  if (body.length > LESSON_MAX_CHARS) {
    return {
      message: `这条经验太长（${body.length} 字，上限 ${LESSON_MAX_CHARS}）`,
      hint: '压成一句：做了什么 → 看到什么 → 结论。设计定义、测量数据、日志不用抄进来。',
    }
  }
  if (LESSON_TEST_PREFIX.test(body) || LESSON_TEST_PHRASE.test(body)) {
    return {
      message: '这看起来是测试脚本留下的记录',
      hint: '测试专用的观察不要进跨会话经验库；如果结论本身有用，用不带测试前缀的一句话重写。',
    }
  }
  if (/^\s*[{[]/.test(body) || /"designId"\s*:/.test(body)) {
    return {
      message: '这是数据不是经验',
      hint: '经验是「做了什么 → 看到什么 → 结论」，不是设计定义或测量结果的拷贝。',
    }
  }
  return null
}

function normaliseLesson(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[`*"'“”‘’（）()【】\[\]{}:,，。、；;！!？?\s-]+/g, '')
}

function findDuplicateNote(text) {
  const needle = normaliseLesson(text)
  if (needle.length < 8) return null
  const loaded = readNotes()
  const entries = Array.isArray(loaded) ? loaded : (loaded?.entries ?? [])
  for (const entry of entries) {
    if (!entry?.text || entry.supersededBy) continue
    const hay = normaliseLesson(entry.text)
    if (!hay) continue
    if (hay === needle) return entry
    if (hay.length >= 12 && (hay.includes(needle) || needle.includes(hay))) return entry
  }
  return null
}

function appendNote(note) {
  appendFileSync(NOTES_FILE, `${JSON.stringify(note)}\n`, 'utf8')
}function replaceNote(id, patch) {
  const raw = existsSync(NOTES_FILE) ? readFileSync(NOTES_FILE, 'utf8') : ''
  const lines = raw.split('\n')
  let found = false
  const next = lines.map((line) => {
    if (!line.trim()) return line
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      return line
    }
    if (entry?.id !== id) return line
    found = true
    return JSON.stringify({ ...entry, ...patch, updatedAt: new Date().toISOString() })
  })
  if (found) writeFileSync(NOTES_FILE, next.join('\n'), 'utf8')
  return found
}

// --------------------------------------------------------------------------- 配方

function readRecipes() {
  try {
    if (!existsSync(RECIPES_FILE)) return []
    const parsed = JSON.parse(readFileSync(RECIPES_FILE, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeRecipes(list) {
  writeFileSync(RECIPES_FILE, JSON.stringify(list, null, 2), 'utf8')
}

// --------------------------------------------------------------------------- 项目

function projectFile(designId) {
  const safe = String(designId).replace(/[^\w.-]+/g, '_')
  return join(PROJECTS_DIR, `${safe}.json`)
}

function readProject(designId) {
  const file = projectFile(designId)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeProject(project) {
  const file = projectFile(project.designId)
  mkdirSync(PROJECTS_DIR, { recursive: true })
  writeFileSync(file, JSON.stringify(project, null, 2), 'utf8')
  return file
}

function listProjects() {
  try {
    return readdirSync(PROJECTS_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          const p = JSON.parse(readFileSync(join(PROJECTS_DIR, name), 'utf8'))
          return {
            designId: p.designId,
            goal: p.goal,
            step: p.step,
            updatedAt: p.updatedAt,
            artifacts: Array.isArray(p.artifacts) ? p.artifacts.length : 0,
          }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  } catch {
    return []
  }
}

// --------------------------------------------------------------------------- 桥接器

let child = null
const INSPECT_IMAGES = join(DATA_DIR, "images")
const NAMED_VIEWS = { iso: '*等轴测', top: '*上视', bottom: '*下视', front: '*前视', back: '*后视', left: '*左视', right: '*右视' }
function namedViewOf(view) { const key = String(view).toLowerCase(); return NAMED_VIEWS[key] ?? view }
function imageContent(shots) {
  return shots.map((shot) => ({ type: 'image', data: readFileSync(shot.path).toString('base64'), mimeType: 'image/png' }))
}
/** 关键步之后自动出三张：等轴测、上视、前视。失败不拖垮建模。 */
async function autoShots(designId, tag, views = ['iso', 'top', 'front']) {
  if (typeof designId !== 'string' || designId.length === 0) return []
  const shots = []
  try { mkdirSync(INSPECT_IMAGES, { recursive: true }) } catch { }
  for (const view of views) {
    const path = join(INSPECT_IMAGES, 'auto-' + tag + '-' + view + '-' + Date.now().toString(36) + '.png')
    try {
      const shot = await callBridge('capture', {
        designId, path, width: 960, height: 640, mutateView: true, view: namedViewOf(view), zoomToFit: true,
      })
      if (shot?.saved) shots.push({ view, path, bytes: shot.bytes })
    } catch { /* 自动出图是增值，不是交付条件 */ }
  }
  return shots
}
/** 交付文件自检：不看模型解释，只读磁盘上的事实。 */
function checkDeliveredFile(path, kind, expectedBytes) {
  const checks = []
  let size = 0
  try { size = statSync(path).size } catch { size = 0 }
  checks.push({ name: 'exists', pass: size > 0, actual: size })
  if (Number.isFinite(expectedBytes) && expectedBytes > 0) {
    checks.push({ name: 'bytes', pass: size === expectedBytes, expected: expectedBytes, actual: size })
  }
  if (kind === 'step') {
    try {
      const head = readFileSync(path, 'utf8').slice(0, 32)
      checks.push({ name: 'stepHeader', pass: head.startsWith('ISO-10303'), actual: head.slice(0, 16) })
    } catch { checks.push({ name: 'stepHeader', pass: false, actual: 'unreadable' }) }
  }
  const failed = checks.filter((c) => c.pass !== true).map((c) => c.name)
  return { ok: failed.length === 0, size, checks, failed }
}
/** 语义尺寸：{length,width,height} 按「长=X 高=Y 宽=Z」优先，其次「长=X 宽=Y 高=Z」。 */
function semanticSizeCandidates(spec) {
  if (spec === null || typeof spec !== 'object') return null
  const L = Number(spec.length), W = Number(spec.width), H = Number(spec.height)
  if (![L, W, H].every(Number.isFinite)) return null
  return [
    { values: [L, H, W], matchedAs: 'length=X, height=Y, width=Z' },
    { values: [L, W, H], matchedAs: 'length=X, width=Y, height=Z' },
  ]
}
let inspectSeq = 0

/** inspect 的预览图：桥接器只会 SaveBMP，所以先写 BMP 再转 PNG。
 *  BMP 不能直接当 MCP 图片块发（规范只保证 png/jpeg），留在 %TEMP% 也没人清。 */
function inspectImagePair() {
  mkdirSync(INSPECT_IMAGES, { recursive: true })
  inspectSeq += 1
  const stem = `insp-${String(inspectSeq).padStart(2, "0")}`
  return { bmp: join(INSPECT_IMAGES, `${stem}.bmp`), png: join(INSPECT_IMAGES, `${stem}.png`) }
}

function bmpToPng(bmp, png) {
  try {
    const run = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(here, "figure.ps1"), "-In", bmp, "-Out", png], { encoding: "utf8", timeout: 60_000 })
    if (run.status === 0 && existsSync(png)) {
      try { unlinkSync(bmp) } catch {}
      return png
    }
    writeEvent({ level: "warn", tool: "inspect", message: "bmp->png failed", bmp, stderr: String(run.stderr ?? "").slice(-200) })
  } catch {}
  return bmp
}

const pending = new Map()

/**
 * 这个会话的直连桥接器该绑到哪个 pid（R12）。
 *
 * 为什么必须有：桥接器只有在拿到 `--instance` 时才会去 ROT 里按 pid 精确绑定；
 * 没有它就是 ExpectedPid=0，而 SwHost 那条路径现在是 fail-closed 的
 * （INSTANCE_NOT_BOUND）。以前只有环境变量 SW_MCP_INSTANCE 会被传下去，而
 * cordis.patch.yml 只设了 SW_MCP_BROKER=1 —— 于是每个会话的直连 worker 都是
 * 未绑定的（今天挂了一整天的 pid 16572 就是活样本：ExpectedPid 恒为 0）。
 *
 * 取值顺序：显式 SW_MCP_INSTANCE > 登记表里分配给本会话的实例。
 * boundPidForSession（broker/instances.mjs）只回传 ownerClients 含本会话、且
 * launchedBy 是 broker/test 的实例 —— **用户实例（launchedBy:"user"）永远不会被
 * 回传**，所以这个函数不可能把 AI 绑到用户自己的窗口上。
 */
function boundBridgePid() {
  const explicit = Number(process.env.SW_MCP_INSTANCE)
  if (Number.isInteger(explicit) && explicit > 0) return explicit
  try {
    const pid = Number(boundPidForSession(SW_CLIENT_ID)) || 0
    return pid > 0 ? pid : 0
  } catch {
    // 登记表读不了（首次运行 / 路径不可用）不能变成启动失败：返回 0 表示
    // 「没有绑定实例」，桥接器会按 fail-closed 给出明确的 INSTANCE_NOT_BOUND。
    return 0
  }
}

function startBridge() {
  if (child && !child.killed) return child
  if (!existsSync(config.bridgeExe)) {
    throw fail(
      'BRIDGE_MISSING',
      `找不到桥接器 ${config.bridgeExe}。先在 sw-mcp/bridge 下跑 build.ps1 生成。`,
    )
  }
  // Windows 上「文件在、但不是可执行映像」时 spawn 会**同步抛**（code UNKNOWN），
  // 而不是发 error 事件。不接住就变成一个没有 code 的 UNKNOWN 失败，指路也丢了。
  // STA worker：隐藏窗体 + 消息泵，请求经 BeginInvoke 串行进 STA 线程。
  // 默认走 STA；SW_MCP_STA=0 可回退旧的行循环做对照。
  const boundPid = process.env.SW_MCP_STA === '0' ? 0 : boundBridgePid()
  const bridgeArgs = process.env.SW_MCP_STA === '0'
    ? []
    : ['--worker', ...(boundPid > 0 ? ['--instance', String(boundPid)] : [])]
  try {
    child = spawn(config.bridgeExe, bridgeArgs, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  } catch (error) {
    throw fail(
      'BRIDGE_SPAWN_FAILED',
      `桥接器起不来（${config.bridgeExe}）：${error?.message ?? error}。先确认它是 build.ps1 编出来的 exe，不是同名占位文件。`,
      { bridgeExe: config.bridgeExe, reason: String(error?.code ?? "") },
    )
  }

  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.ok) {
        // The bridge answers with one flat object per line; the transport fields
        // (ok / op / id) are its own and never reach a tool's return value.
        const { ok: _ok, op: _op, id: _id, ...payload } = message
        waiter.resolve(payload)
      } else {
        const error = fail(
          message.error?.code ?? 'UNKNOWN',
          message.error?.message ?? '桥接器返回失败但没有说明原因',
          message.error?.detail,
        )
        if (message.error?.lastCompletedStep) error.lastCompletedStep = message.error.lastCompletedStep
        waiter.reject(error)
      }
    }
  })

  // A reload kills the old process on purpose and spawns a replacement. This
  // handler must then leave the shared pending map alone: the replacement's
  // request is already in it, and clearing it would fail a call that is about
  // to succeed.
  const proc = child

  // 进程级错误与管道错误都是**事件**，不监听就是未捕获异常，会把整个 MCP server 带走。
  // 这两种情况都要能被下一次调用重新拉起，所以统一：拒掉本进程的 pending、把 child 置空。
  const failProcess = (code, message) => {
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer)
      waiter.reject(fail(code, message))
    }
    pending.clear()
    if (child === proc) child = null
  }
  proc.on('error', (error) => {
    writeEvent({ level: 'error', tool: 'bridge', message: 'spawn/pipe error', error: String(error?.message ?? error) })
    failProcess('BRIDGE_SPAWN_FAILED', `桥接器进程出错：${error?.message ?? error}`)
  })
  for (const stream of [proc.stdin, proc.stdout]) {
    stream?.on('error', (error) => {
      writeEvent({ level: 'error', tool: 'bridge', message: 'stream error', error: String(error?.message ?? error) })
      failProcess('BRIDGE_PIPE_FAILED', `桥接器管道出错：${error?.message ?? error}`)
    })
  }

  proc.on('exit', (code) => {
    if (child !== proc) return
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer)
      waiter.reject(fail('BRIDGE_EXITED', `桥接器退出（code ${code}）`))
    }
    pending.clear()
    child = null
  })

  return child
}

/**
 * 一次调用一个请求。桥接器按 UTF-8 读写，不带换行也能工作，但带换行让它的
 * ReadToEnd 更早返回，也方便以后改成流式。
 */
function sendBridge(op, payload = {}) {
  const proc = startBridge()
  const id = randomUUID()
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(
        fail(
          'SW_TIMEOUT',
          `调用 ${op} 超过 ${Math.round(config.requestTimeoutMs / 1000)} 秒没有返回。SOLIDWORKS 可能弹出了对话框或被占用，请切到窗口检查后重试。`,
        ),
      )
    }, config.requestTimeoutMs)

    pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
    proc.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`, (error) => {
      if (!error) return
      pending.delete(id)
      clearTimeout(timer)
      rejectPromise(fail('BRIDGE_WRITE_FAILED', `无法写入桥接器: ${error.message}`))
    })
  })
}

/** The one bridge entry point: logs the round-trip with the caller's correlation
 *  id, on both outcomes, then hands the result back unchanged.
 *
 *  Bridge traffic is logged here rather than at each call site because there are
 *  forty of them and the interesting question is always "what did the last thing
 *  I sent actually say" — which needs every hop, not the ones someone remembered
 *  to instrument. */
// 共享 broker 的建模路径：显式开启 SW_MCP_BROKER=1 后，重操作提交给 broker，
// 由实例 worker 执行；交互式小调用仍走本会话桥接器，避免多一层排队。
const BROKER_LOCKFREE_OPS = new Set(['ping', 'version', 'status', 'diagnose', 'interopIndex', 'kinds', 'addins', 'instances'])
const BROKER_OPS = new Set([
  'build', 'edit', 'save', 'export', 'measure', 'capture', 'snapshot',
  'inspect', 'faces', 'bodies', 'edges', 'open', 'newDocument',
  'assemblyNew', 'componentInsert', 'components', 'mate',
  'drawingNew', 'drawingViews', 'relations', 'project', 'cleanup', 'patternCircular',
])

let brokerClientPromise = null
async function sharedBroker() {
  if (brokerClientPromise) {
    const pending = brokerClientPromise
    const client = await pending
    if (!client.closed) return client
    if (brokerClientPromise === pending) brokerClientPromise = null
  }
  if (!brokerClientPromise) {
    brokerClientPromise = BrokerClient.connect({ spawnIfMissing: true, timeoutMs: 15_000 })
      .catch((error) => {
        brokerClientPromise = null
        throw error
      })
  }
  return brokerClientPromise
}

async function sendViaBroker(op, payload) {
  const client = await sharedBroker()
  const stage = stageBridgeContext()
  const jobTimeoutMs = Number(process.env.SW_MCP_BROKER_TIMEOUT_MS ?? 240_000)
  // 并行的关键：同一个 design 永远走同一条通道（同一个 clientId → 同一个实例），
  // 不同 design 才会被分到不同实例。payload 里没有 designId 的探针类请求落到默认通道。
  const laneSeed = payload?.designId ?? payload?.definition?.designId ?? payload?.sessionId ?? null
  const response = await client.request('jobs.run', {
    op,
    args: payload,
    timeoutMs: jobTimeoutMs,
    ensure: !operationContext.getStore()?.readOnly && process.env.SW_MCP_BROKER_ENSURE === '1',
    ensureTimeoutMs: Number(process.env.SW_MCP_BROKER_ENSURE_MS ?? 180_000),
    ...instanceRequestParams(laneSeed),
    ...(stage ? { operationId: stage.operationId } : {}),
    refs: { runId: stage?.runId ?? process.env.SW_MCP_RUN_ID ?? 'session', designId: payload?.designId ?? payload?.definition?.designId },
  }, { timeoutMs: jobTimeoutMs + 30_000 })
  const job = response?.job ?? {}
  if (job.state === 'succeeded' || (op === 'batch' && job.error?.code === 'BATCH_STEP_FAILED' && job.result)) {
    const result = job.result ?? {}
    // 哪个 SOLIDWORKS 实例执行的，调用方要能看见：多会话隔离靠它验证。
    if (job.worker?.instanceId && result && typeof result === 'object' && !result.instanceId) {
      result.instanceId = job.worker.instanceId
    }
    return result
  }
  const error = job.error ?? {}
  const detail = error.detail ?? error.details
  throw fail(error.code ?? 'BROKER_JOB_FAILED',
    error.message ?? `broker 作业 ${job.state ?? '未完成'}`,
    { ...(detail && typeof detail === 'object' ? detail : { detail }),
      jobId: job.jobId, state: job.state, instanceId: job.worker?.instanceId, effect: job.effect })
}

// ---------------------------------------------------------------------------
// 建文档 / 清扫类请求统一盖章会话归属。
//
// 桥接器给每个文档登记项记 origin + sessionId，cleanup 才能判「这条是不是本会话建的」
// （Documents.SweepDocuments：别的 sessionId 的条目跳过并计数，来源不明的算 unknown）。
// 而 server.mjs 以前发 build / newDocument / assemblyNew / drawingNew 都不带 sessionId，
// 生产条目落成 sessionId=null —— 跨会话过滤等于没有：别的会话可能关掉你的文档，你的
// cleanup 也认不出哪些是自己的。这里集中注入，值就是 workspace action="cleanup"
// 传的那个 SW_CLIENT_ID（每个 MCP 进程一个会话边界，见 session-id.mjs）。
//
// cleanup 也在名单里：build 之前那次前置清扫（callBridge('cleanup', {designId})）
// 以前同样没带，同 designId 的别的会话文档会被一起收掉。
// ---------------------------------------------------------------------------
const SESSION_SCOPED_OPS = new Set(['build', 'newDocument', 'assemblyNew', 'drawingNew', 'cleanup'])

function withSessionScope(op, payload) {
  if (!SESSION_SCOPED_OPS.has(op)) return payload
  if (payload !== null && typeof payload === 'object' && payload.sessionId !== undefined) return payload
  // 通道 id 就是会话戳：不同通道的 cleanup 互相看不见对方的文档。
  const seed = payload?.designId ?? payload?.definition?.designId ?? null
  return { ...payload, sessionId: clientIdFor(seed) }
}

function callBridge(op, payload = {}, options = {}) {
  const started = Date.now()
  const cid = currentCid()
  const body = withSessionScope(op, payload)
  // 除只读探针外全部走 broker：每个 MCP 会话有自己绑定的实例，不能靠
  // GetActiveObject 去猜「当前活动的是哪个 SOLIDWORKS」。
  // options.broker：个别不在 BROKER_OPS 里的少量 op（deliver 的 close）也要按
  // designId 走通道池，否则直连桥接器绑不到这条设计所在的实例。
  const send = process.env.SW_MCP_BROKER === '1' && (options.broker === true || !BROKER_LOCKFREE_OPS.has(op))
    ? sendViaBroker
    : sendBridge
  return send(op, body).then(
    (result) => {
      writeEvent({
        level: 'debug', tool: 'bridge', cid, op, ms: Date.now() - started,
        args: digestArgs(body), status: 'ok',
        note: result?.note ?? result?.summary ?? undefined,
      })
      return result
    },
    (error) => {
      writeEvent({
        level: 'error', tool: 'bridge', cid, op, ms: Date.now() - started,
        args: digestArgs(body), code: error?.code ?? 'BRIDGE_FAILED',
        message: error?.message ?? String(error),
      })
      throw error
    },
  )
}

function fail(code, message, detail) {
  const error = new Error(message)
  error.code = code
  if (detail !== undefined) error.detail = detail
  return error
}

/** 把定义里的 kind:"pattern" 特征摘出来。桥接器只建实体特征，原生阵列在
 *  build 完成后由同一个 worker 提交，避免把「阵列」伪装成草图几何。 */
function splitPatternFeatures(definition) {
  const core = structuredClone(definition)
  const patterns = []
  core.features = (core.features ?? []).filter((feature) => {
    if (feature?.kind === 'pattern') {
      patterns.push(feature)
      return false
    }
    return true
  })
  return { core, patterns }
}

async function buildWithPatterns(definition, extra = {}) {
  const { core, patterns } = splitPatternFeatures(definition)
  const result = await callBridge('build', { definition: core, ...extra })
  if (!patterns.length) return result
  const featureNames = new Map((result.features ?? []).map((feature) => [feature.id, feature.featureName]))
  result.patterns = []
  for (const pattern of patterns) {
    const source = featureNames.get(pattern.source) ?? pattern.source
    const applied = await callBridge('patternCircular', {
      feature: source,
      count: pattern.count,
      angleDeg: pattern.angleDeg ?? 360,
      axisPlanes: pattern.axisPlanes ?? [1, 2],
      flip: pattern.flip === true,
      ...(definition.designId ? { designId: definition.designId } : {}),
    })
    result.patterns.push(applied)
    result.features.push({
      id: pattern.id,
      kind: 'pattern',
      featureName: applied.pattern,
      source,
      count: applied.count,
      angleDeg: applied.angleDeg,
    })
  }
  // bridge 的 build 结果是在阵列之前量的；阵列会改变体积，必须回读一次，
  // 否则调用方拿到的 volume/包围盒还是「只切了一个齿槽」的中间态。
  if (definition.designId) {
    const measured = await callBridge('inspect', { designId: definition.designId, format: 'geometry' })
    if (measured?.geometry) result.geometry = measured.geometry
  }
  return result
}

// ---------------------------------------------------------------------------
// 11 个工具共用的返回形状。
//
// 每个工具都回同一组键，模型不用记每个工具自己的字段名：
//   summary      一句话结论
//   designId     这份设计是谁（所有工具都认它）
//   status       ok / failed
//   changes      这次调用的副作用（改了哪个参数、建了哪个特征）
//   measurements 可核对的数字（体积、包围盒、孔）
//   artifacts    产出文件
//   nextActions  建议的下一步
//   capabilities 当前环境能做/不能做什么
//   timings      各阶段耗时
// ---------------------------------------------------------------------------

/**
 * 统一回包。
 *
 * **changes 永远存在**（至少是 {}）。理由不是洁癖：调用方普遍写成
 * `j.changes.applied` / `j.changes.result` / `j.changes.document`，失败回包里
 * 一旦缺这个键，读到的就是 `Cannot read properties of undefined (reading 'applied')`
 * —— TypeError 把真正的错误码（DIMENSION_CREATE_FAILED 之类）整个盖住，于是下一次
 * 尝试是在修一个不存在的问题。会话 abd5f23f 的 23 次工具失败里有 11 次是这个形状。
 *
 * **measurements 同时放在 changes.measurements**。同一个数只给一个位置时，调用方
 * 只能靠猜；猜错的表现同上（`reading 'totalVolumeMm3' of undefined`，那 23 次里占 9 次）。
 * 两处指向同一个对象，怎么读都对。
 */
function envelope({ summary, designId, status = 'ok', changes, measurements, artifacts, delivery, nextActions, capabilities, timings, extra }) {
  const normalizedChanges = changes ?? {}
  return {
    summary,
    designId: designId ?? null,
    status,
    changes: measurements && normalizedChanges.measurements === undefined
      ? { ...normalizedChanges, measurements }
      : normalizedChanges,
    ...(measurements ? { measurements } : {}),
    ...(artifacts ? { artifacts } : {}),
    // deliver 的交付读数（saved/bytes/source/elapsedMs）：顶层与 changes.delivery
    // 指向同一个对象，调用方从哪边读都对（与 measurements 同一处理）。
    ...(delivery ? { delivery } : {}),
    ...(nextActions ? { nextActions } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(timings ? { timings } : {}),
    ...(extra ? { extra } : {}),
  }
}

function ok(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
}

/**
 * 失败结果也走 ok()，不设 isError。
 *
 * 原因：dsh-mcp-client 在 result.isError === true 时直接抛文字异常，图片投影和
 * 结构化字段都在那之后 —— 一条带图的失败会被整个丢掉。失败在这里是一个正常的
 * 业务结果（status:"failed" + 明确错误码 + 已完成的步骤），模型拿到的信息更多。
 *
 * nextActions 可选：同一个错误码在不同工具里下一步不同时（例如 UNKNOWN_PARAM
 * 在 model 里是「参数名写错」、在 verify 里是「核对键写错」），调用方显式给一份，
 * 不要靠全局映射硬凑。不传就退回 nextActionsFor(error)。
 */
function failed({ op, designId, error, nextActions, changes, delivery }) {
  return ok(
    envelope({
      summary: `${op} 失败：${error.message}`,
      designId,
      status: 'failed',
      // 只有需要回可核对字段的失败（deliver 的 saved/bytes/source）才传 changes；
      // 其他工具保持原样，不会多出键。
      changes,
      delivery,
      nextActions: nextActions ?? nextActionsFor(error),
      extra: {
        error: {
          code: error.code ?? 'UNKNOWN',
          message: error.message,
          ...(error.detail ? { detail: error.detail } : {}),
          ...(error.lastCompletedStep ? { lastCompletedStep: error.lastCompletedStep } : {}),
        },
      },
    }),
  )
}

/**
 * 错误码到下一步的映射。模型看到 SW_NOT_RUNNING 时最常犯的错是尝试自己启动
 * SOLIDWORKS —— 那样会多起一个进程，并且新进程里没有用户的文档。
 */
function nextActionsFor(error) {
  switch (error.code) {
    case 'COMPONENT_NOT_ON_DISK':
      return [
        'build 只在内存里：对每个零件 designId 先 capture 一张图，再 deliver kind="sldprt"',
        '把 deliver 回包里的 path 原样填进 components[].path，再调一次 assemble',
        '未存盘文档的 document.path 是空字符串 —— 组件 path 是空的，就是这个原因',
      ]
    case 'SW_NOT_RUNNING':
    case 'not-running':
      return [
        '请用户先打开 SOLIDWORKS（桌面快捷方式 SOLIDWORKS Design 2026.lnk 即可），然后重试同一调用',
        '本服务不启动、不关闭 SOLIDWORKS：已开着时再启动会多起一个无窗口的 SLDWORKS.exe',
        'SW 没开的时候 catalog 仍然可查，可以先看本机能做什么',
      ]
    case 'crashed':
      return [
        'SOLIDWORKS 在使用过程中退出了。请重新打开它 —— 上次没保存的改动已经丢失',
        '重开后先 workspace action=status 确认已连上，再用 workspace action=resume 接着做',
      ]
    case 'DIMENSION_NOT_DRIVING':
      return [
        '写下去的尺寸是**参考尺寸**（IsReferenceDim=true）：它读得出来，但改它模型不动。'
          + '别把「尺寸数对上了」当成参数化已落地。',
        '先补定义它的草图关系（对称/重合/到边距离/同轴），再重加尺寸；草图必须在编辑态里做。',
        '已经是参考尺寸的那几张不要试图 edit 数值 —— 改不动，只会得到「看起来成功」。',
      ]
    case 'SKETCH_NOT_EDITABLE':
      return [
        '选不中/进不去目标草图：确认 sketch 名字与 inspect action="sketch" 报的一致，'
          + '并确认 designId 指向的那份文档里真有这张草图。',
        '写尺寸/换关系都要求草图处于编辑态；锁着或被别的实例占用的文档进不去，'
          + '换个 designId 或让用户关掉重复窗口再试。',
      ]
    case 'SELECTION_EMPTY':
      return [
        '「调用返回了」不等于「选中了」：SelectByID2/SelectByRay 什么都没选到时同样返回 true。'
          + '0 个就是这次没选中任何东西，后面的步骤不会作用在任何几何上。',
        '先查单位：SOLIDWORKS 的 API 用米，2.5 mm 要写 0.0025；也可以直接传 units:"mm" 让服务换算。',
        '再查名字/像素：名字必须与特征树里完全一致（inspect action="model" format="tree"）；'
          + '像素必须来自同一视图状态的投影（视图切过就重拍再取）。',
        '面/边优先用持久引用 id：inspect action="faces" → select mode="byId"，失效会明确报 STALE_SELECTION。',
      ]
    case 'INVOKE_NULL_RESULT':
      return ['确认当前设计、活动草图和选集满足该 API 的前置条件，再核对参数签名和单位']
    case 'RELATIONS_INCOMPLETE':
    case 'VERIFY_FAILED':
      return [
        '这不是一次审查，是交付门禁的确定性检查没过：先把缺的东西补上，再审一次。',
        'RELATIONS_INCOMPLETE：**改过几何/尺寸之后要重新 inspect action="relations"**，'
          + '服务落账时带的是本设计实时 revision，重读一次就能追平；差值一直不变才是门禁不可达。',
        'VERIFY_FAILED：按 checks 里 failed 的那几条改模型，改完重跑 inspect action="verify" 再交付；'
          + '改「期望值」让它变绿不算，除非同时给出依据（验证器口径、图纸标注换算）。',
      ]
    case 'DOC_NOT_OPEN':
    case 'DESIGN_ID_REQUIRED':
      return [
        '先确认这份设计在不在打开状态：workspace action="projects" 看已有项目，'
          + 'workspace action="open" 按路径打开。',
        'invoke 的 target="doc" 现在**按 designId 解析**，解析不到就报 DOC_NOT_OPEN，'
          + '不会再退回前台那份文档（那正是「尺寸加到别人的零件上」的来源）。',
        '要真的操作 SOLIDWORKS 前台当前文档，写 target="activeDoc" —— 回包会带 activeDocument=true，'
          + '看见这个标记就说明动的是前台那份，不是本设计。',
      ]
    case 'UNKNOWN_PARAM':
      return [
        '按工具 schema 列出的参数名重写这次调用：detail.allowed 就是全部合法键，写错不会被忽略。',
        '拿不准时看 detail.suggestions（最接近的键）或工具说明。',
      ]
    case 'READ_ONLY_TOOLSET':
      return [
        '只读通道没有写权限：这次调用没有到达桥接器，用户的文档没有被改动。',
        '要改关系/尺寸，让主模型用 mcp__sw__inspect（不带 SW_MCP_TOOLS 白名单的那个实例）来做；在这个实例上重试不会成功。',
        '如果只是想看：relations 传 relationAction="list" 或 "infer"（推断不写入），dimensions 传 dimensionAction="list"。',
      ]
    case 'EDIT_NOT_APPLIED':
      return [
        '这次改动一条都没写进 SOLIDWORKS，几何没有变。',
        '让 SOLIDWORKS 退出再重新打开，然后 model action=build 重建这个件。',
        '重开后可先跑 test/bindings.mjs 或建一个带参数的小件，确认 changes.bindings 非空。',
      ]
    case 'EQUATION_MANAGER_REJECTED':
      return [
        'SOLIDWORKS 现在拒绝写方程式 —— 建出来的件是静态的，改参数不会动。',
        '让 SOLIDWORKS 退出再重新打开（长时间运行的实例会进入这个状态），然后重新 model action=build。',
        '重开之后先用一个带参数的小件确认绑得上：inspect action=model 看 changes.bindings 是否为空。',
      ]
    case 'not-reachable':
      return [
        'SOLIDWORKS 在运行但没接受连接：多半是刚启动还没就绪，等几秒重试',
        '如果它正弹着对话框，请在窗口里关掉再重试（本服务不会替用户点按钮）',
        '如果开了两个 SOLIDWORKS，关掉多余那个再重试',
      ]
    case 'SW_BLOCKED_BY_DIALOG':
    case 'blocked-by-dialog':
      return ['请用户切到 SOLIDWORKS 窗口关掉弹出的对话框，然后重试同一调用']
    case 'NO_ACTIVE_DOC':
      return ['先用 model action=create 建一个零件，或用 workspace(action="projects") 看已有项目']
    case 'SW_TIMEOUT':
      return ['检查 SOLIDWORKS 是否被对话框挡住；处理完重试']
    case 'BUILD_IN_PROGRESS':
      return [
        '这一件正在建：等它返回再决定下一步（workspace action="logs" 能看到实时进度），不要重复提交或换 designId 重来。',
        '要改尺寸用 model action="edit"，不要用第二次 build 覆盖正在跑的那一次。',
      ]
    case 'TEMPLATE_NOT_FOUND':
      return ['检查 SOLIDWORKS 模板目录，或在调用里显式传 template']
    case 'SAVE_TARGET_OPEN':
      return ['用 workspace(action="close", title=…) 关掉占用该路径的文档，再重试保存']
    case 'UNKNOWN_MEMBER':
      return [
        '先用 catalog action=search q=<功能名> 或 catalog action=detail id=interop:<接口名> 看准确签名',
        '再用 model action=invoke 按签名传参；参数个数必须与签名一致',
      ]
    case 'NO_TARGET':
      return ['先建或打开一个文档，再对 featureManager/sketchManager 这类文档级目标调用']
    case 'UNKNOWN_TYPE':
      return ['用 catalog action=search 找接口名，或 interopIndex mode=search q=<子串>']
    case 'NO_PROJECT':
      return ['用 catalog action=list 看看能做什么，然后 model action=build 建第一版']
    case 'FILE_NOT_FOUND':
      return ['确认路径；catalog 里的条目都带绝对路径，可直接复制']
    case 'BRIDGE_MISSING':
      return ['在 sw-mcp/bridge 下跑 build.ps1 重新编译']
    case 'EMPTY_SKETCH':
    case 'SKETCH_NOT_FOUND':
    case 'NO_SKETCH':
    case 'SKETCH_TOO_SMALL':
    case 'SKETCH_SHAPE':
      return [
        '草图里没落下几何：先看 inspect action="sketch"（段数、悬空端点、是否闭合），再决定补线还是换轮廓',
        '一张草图只放一个闭合轮廓；两个重叠/相切的轮廓会让拉伸和切除都静默返回 null',
      ]
    case 'EXTRUDE_FAILED':
    case 'CUT_FAILED':
    case 'FEATURE_CHANGED_NOTHING':
    case 'UNEXPECTED_MULTI_BODY':
    case 'EXTRUDE_SEPARATE_BODY':
    case 'BAD_DIRECTION':
      return [
        '轮廓必须与已有材料相交：完全画在已有实体内部等于没建（会报 FEATURE_CHANGED_NOTHING）',
        '轮廓的边不要正好落在另一个实体的公共面上，往有料的一侧压进 0.2–0.5 mm',
        '拉伸方向按世界轴表来（前视 −Z / 上视 −Y / 右视 −X），不要靠试布尔值',
      ]
    case 'NO_FACE':
    case 'STALE_SELECTION':
    case 'NOT_A_PART':
    case 'NOT_AN_ASSEMBLY':
    case 'NO_VIEW':
    case 'DIMENSION_FAILED':
    case 'FILLET_FAILED':
    case 'FILLET_NO_CHANGE':
      return [
        '先确认当前活动文档的类型与内容：inspect action="model"（零件）/ "assembly"（装配）',
        '面/边的 id 会随重建失效：重新 inspect action="faces" 取 id，再 select',
      ]
    default:
      // 兜底也要给方向：日志里已经有这次调用的 cid 与 detail，模型不该只得到空数组。
      return [
        '用 workspace action="logs" 查这次调用的 error.detail（里面带 featureId / builderSteps）',
        '这类失败通常不是参数写错，而是前面的几何没按预期落下来：先 inspect action="sketch" / "model" 回读',
      ]
  }
}

// --------------------------------------------------------------------------- 能力注册表

/**
 * 能力注册表：每项记录名称、来源、适配器版本、输入/输出结构、是否可用。
 *
 * 为什么要这张表：同样是「打孔」，可以用 SW 原生特征、用草图内多圆、或者降级成
 * 宏；哪条路在当前环境能用，是实测结论而不是文档承诺。模型看到 unavailable 就
 * 不要试，看到 degraded 就知道结果会差一点。
 */
const CAPABILITIES = [
  {
    name: 'basePlate',
    source: 'sw-native',
    adapter: 'builder.basePlate@1',
    available: true,
    note: '对称拉伸 + 中心矩形；宽高落在原生尺寸 D1/D2，厚度落在 D1/D2 的一半表达式',
  },
  {
    name: 'boss',
    source: 'sw-native',
    adapter: 'builder.boss@1',
    available: true,
    note: '面支承草图 + 拉伸；方向由「拉伸后体积是否变化」实测决定，不靠猜 dir 布尔值',
  },
  {
    name: 'holes',
    source: 'sw-native',
    adapter: 'builder.holes@1',
    available: true,
    note: '草图内多圆 + 贯穿切除；每圆一个原生直径尺寸，靠参数扇出而不是 sgEQUAL',
  },
  {
    name: 'holeGroupCorners',
    source: 'sw-native',
    adapter: 'builder.positionHoles@1',
    available: true,
    note: '四角孔组用中心线 + sgSYMMETRIC + 一条距边尺寸定位，改板宽时孔自动跟随',
  },
  {
    name: 'sketchProfile',
    source: 'sw-native',
    adapter: 'profiles.create@1',
    available: true,
    note: '任意轮廓：rect（宽高落原生尺寸）、circle（每圆一个原生直径）、polyline / polygon（坐标在建模时求值后烧进草图，不随参数动 —— 返回的 parametric 会如实标成 false）、gear（teeth/module/pressureAngle；只走原生路线：圆柱+一个齿槽切除（原生圆弧/样条）+原生圆周阵列，禁止折线拟合）、roundedRect/path/slot（两线两弧构造，尚未参数化）',
  },
  {
    name: 'sketchCurve',
    source: 'sw-native',
    adapter: 'curves.create@1',
    available: true,
    note: '八类曲线：line/circle/arc/ellipse/ellipticArc/spline/equationCurve/polyline。circle/arc/ellipse/ellipticArc 回读必须是原生实体；polyline 逐段 CreateLine 保持直边；equationCurve 开放区间走 CreateEquationSpline2，闭合区间会被 SolidWorks 拒绝并退回 128 点采样样条（notes 说明，parametric=false）',
  },
  {
    name: 'extrude',
    source: 'sw-native',
    adapter: 'builder.extrudeSketch@1',
    available: true,
    note: '先建草图再拉伸：depth 绑 D1；对称拉伸绑 D1/D2 各一半（只绑 D1 会让厚度只长一半）',
  },
  {
    name: 'cut',
    source: 'sw-native',
    adapter: 'builder.cutSketch@1',
    available: true,
    note: '必须 Sd=true + swStartSketchPlane + AutoSelectComponents，否则 FeatureCut4 静默返回 NULL；方向按体积是否减少实测决定，不靠布尔猜',
  },
  {
    name: 'revolve',
    source: 'sw-native',
    adapter: 'builder.revolveSketch@1',
    available: true,
    note: '旋转 360°：轴线画在轮廓草图内的构造线上（mark 0 命中）；实测 Ø20×60 轴体积 18849.5559 mm³，与 πr²h 一致',
  },
  {
    name: 'fillet',
    source: 'sw-native',
    adapter: 'builder.fillet@1',
    available: true,
    note: '竖边圆角；按 Z 与竖直性筛选边，逐条 append 选择',
  },
  {
    name: 'equationVariable',
    source: 'sw-native',
    adapter: 'compiler.equations@1',
    available: true,
    note: 'Add2 返回新方程的索引而不是成功码；派生变量可引用其他变量',
  },
  {
    name: 'sketchDimension',
    source: 'sw-native',
    adapter: 'sketchDimensioner@1',
    available: true,
    note: '中心线 + 对称 + 一条尺寸 → GetConstrainedStatus()==3（完全约束）',
  },
  {
    name: 'sketchSlot',
    source: 'sw-native',
    adapter: 'profiles.slot@1',
    available: true,
    note: 'legacy shape slot 已接入：两线两弧构造，几何与长度/宽度回读正确；但未绑定原生尺寸，parametric=false。要原生参数化优先用 circle/arc 组合',
  },
  {
    name: 'linearPattern',
    source: 'sw-native',
    adapter: 'none',
    available: false,
    status: 'unsupported-in-this-environment',
    note: 'FeatureLinearPattern5 在 mark∈{0,1,2,4} × Select2/SelectByID2 全部返回 NULL；CreateDefinition(swFmLPattern) 能拿到定义对象，但属性赋值与 AccessSelections 抛 COMException 0x80010105 (RPC_E_SERVERFAULT)。孔组改用草图内多圆。',
    errorCode: '0x80010105',
  },
  {
    name: 'circularPattern',
    source: 'sw-native',
    adapter: 'patternCircular@1',
    available: true,
    note: 'FeatureCircularPattern5 + 两个基准面交线生成 RefAxis；选择标记必须是轴 mark=1、特征 mark=4，否则返回 NULL（实测）。`model action="pattern"` 传 feature/count/axisPlanes；真机 6 项用例通过',
  },
  {
    name: 'addIn',
    source: 'sw-addin',
    adapter: 'GetAddInObject',
    available: false,
    status: 'not-yet-wired',
    note: 'ISldWorks.GetAddInObject(clsid) 可用于 Simulation / FeatureWorks / Design Checker，尚未接',
  },
  {
    name: 'macro',
    source: 'sw-macro',
    adapter: 'RunMacro2',
    available: false,
    status: 'not-yet-wired',
    note: 'ISldWorks.RunMacro2(file, module, proc, options, out errors) 已确认存在，尚未接',
  },
  {
    name: 'uiCommand',
    source: 'sw-command',
    adapter: 'RunCommand',
    available: false,
    status: 'not-yet-wired',
    note: 'ISldWorks.RunCommand(id, arg) 已确认存在，只作为打开界面命令的兜底，不用于深度自动化',
  },
  {
    name: 'introspect',
    source: 'sw-interop',
    adapter: 'reflect.kinds@1',
    available: true,
    note: 'model action="kinds" 列出现场对象真的有的成员，附 where（声明接口）、signature、paramCount，可分页；invoke 之前先看它，别撞 UNKNOWN_MEMBER',
  },
]

/** 知识文件在哪。人设里让模型「按需 read」，得先给得出完整路径 ——
 * 模型不该靠猜安装目录。缺文件时如实标 missing，不要给出一个读不到的路。 */
function skillPaths() {
  const dir = join(root, 'skills')
  const names = ['sw-drawing-read', 'sw-parametric', 'sw-troubleshooting', 'sw-setup']
  const items = names.map((name) => {
    const path = join(dir, name, 'SKILL.md')
    return { name, path, present: existsSync(path) }
  })
  return { dir, items }
}

function capabilitiesPayload(sw) {
  return {
    version: {
      schemaVersion: 4,
      bridgeProtocolVersion: 4,
      implementationVersion: '0.6.0',
    },
    solidworks: sw ?? null,
    items: CAPABILITIES,
    // 操作清单来自 Operations.cs 的真实分派表（tools/gen-dispatch.mjs 生成），
    // 人工表只补说明；两项不一致时 test/dispatch.mjs 会让构建失败。
    operations: {
      count: DISPATCH.length,
      items: DISPATCH,
    },
  }
}

// --------------------------------------------------------------------------- 设计定义

/**
 * 把配方或用户输入补全成一份可编译的设计定义。
 * schemaVersion 不一致时在这里迁移，而不是在桥接器里 —— 桥接器只认当前版本。
 */
function normalizeDesign(input, designId) {
  const definition = { ...input }
  definition.schemaVersion = definition.schemaVersion ?? 3
  if (definition.schemaVersion !== 3) {
    throw fail(
      'SCHEMA_VERSION',
      `设计定义是 schemaVersion ${definition.schemaVersion}，本服务只认 3。请按当前格式重写。`,
    )
  }
  definition.designId = designId ?? definition.designId ?? `design-${Date.now()}`
  definition.units = definition.units ?? 'mm'
  // 设计定义里参数表叫 params；早期会话与文档里也出现过 parameters。
  // 两个名字都收，避免「按文档写了 parameters → 参数没声明 → 尺寸是死数」这种
  // 看起来成功（实测过一次：体积对、改参数不动）。
  if ((!definition.params || typeof definition.params !== 'object') && definition.parameters && typeof definition.parameters === 'object') {
    definition.params = definition.parameters
  }
  if (!definition.params || typeof definition.params !== 'object') definition.params = {}
  if (!Array.isArray(definition.features)) {
    throw fail('BAD_ARGUMENT', '设计定义缺少 features 数组')
  }
  return definition
}

/** 从字典里取参数值，支持数字或「另一个参数名」两种写法。 */
function paramValue(params, key) {
  const v = params[key]
  return typeof v === 'number' ? v : undefined
}

function designSummary(definition) {
  const kinds = definition.features.map((f) => f.kind)
  const counts = kinds.reduce((acc, k) => {
    acc[k] = (acc[k] ?? 0) + 1
    return acc
  }, {})
  return `${definition.designId}: ${definition.features.length} 个特征（${Object.entries(counts)
    .map(([k, n]) => `${k}×${n}`)
    .join(', ')}）`
}

// --------------------------------------------------------------------------- 工具

const server = new McpServer({ name: 'sw', version: '0.6.0' })

// 每个工具调用都过这里：拿到关联号、记时、记下参数摘要和结果。挂在这一层是
// 因为工具分散在四个模块里，逐个手写日志一定会漏；而这里漏不掉。

// ---------------------------------------------------------------------------
// 给审查门记账：当前这一版是哪一版、图在哪。
//
// PTC 模式下，模型的所有 mcp__sw__* 调用都发生在 run_code 内部，宿主侧的
// tools/execute 只看得到外层 run_code，返回里没有图也没有 designId。审查门于是
// 每次都说「这一轮没有留下任何图」，交付被永久拒绝（实测连追 6 次全落空）。
// 谁看得见事实就谁记账：服务看得到每一次 build / capture，写在这里，插件只读。
// ---------------------------------------------------------------------------
const MUTATING_MODEL_ACTIONS = new Set(['build', 'edit', 'create', 'invoke', 'object', 'batch', 'pattern', 'rebuild', 'undo', 'assemble', 'drawing'])

function parseEnvelopeText(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  const text = result?.content?.find((chunk) => chunk?.type === 'text')?.text
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 关系审计的记账：交付门禁（review-gate.js）只信这里写下的事实。
//
// 为什么由服务写：PTC 模式下模型的所有 mcp__sw__* 调用都在 run_code 内部，
// 宿主插件看不到子调用的返回。服务看得到 build / inspect relations 的真实结果，
// 就由它把「这一版有几条关系、有没有被拒、有没有悬空端点」写进 live.json。
// ---------------------------------------------------------------------------
const RELATION_AUDIT_GAP_LIMIT = 40

function liveStorePath() {
  return join(DATA_DIR, 'review', 'live.json')
}

function readLiveStore() {
  try {
    const store = JSON.parse(readFileSync(liveStorePath(), 'utf8'))
    if (store && typeof store === 'object' && store.designs && typeof store.designs === 'object') return store
  } catch {}
  return { version: 1, designs: {} }
}

function writeLiveStore(store) {
  try {
    const file = liveStorePath()
    mkdirSync(join(DATA_DIR, 'review'), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    // 记账失败永远不影响工具调用本身。
    return false
  }
}

const MUTATING_RELATION_ACTIONS = new Set(['add', 'remove', 'edit', 'clear', 'apply'])

/** 把一次关系回读/草图构建压成交付门禁能直接判的形状。没有事实可记时返回 null。 */
function summarizeRelationsForAudit(result, relationAction = null) {
  const relations = Array.isArray(result?.relations) ? result.relations
    : Array.isArray(result?.sketch?.relations) ? result.sketch.relations : []
  const hasRelations = Array.isArray(result?.relations) || Array.isArray(result?.sketch?.relations)
  const hasAudit = result?.relationAudit !== null && typeof result?.relationAudit === 'object'
  const hasClosed = result?.closed !== undefined || result?.sketch?.closed !== undefined
  const openEnds = Number(result?.openEnds ?? result?.sketch?.openEnds ?? result?.relationAudit?.openEnds ?? NaN)
  // 既没有关系行、没有审计、没有 closed/openEnds：这是一次「只回报 applied」的写入，
  // 不能从它推断关系是否落地 —— 宁可这次不记账（保留上一份），也不要写一份假事实。
  if (!hasRelations && !hasAudit && !hasClosed && !(Number.isFinite(openEnds) && openEnds > 0)) return null
  const gaps = []
  if (Array.isArray(result?.relationAudit?.gaps)) gaps.push(...result.relationAudit.gaps)
  if (Array.isArray(result?.gaps)) gaps.push(...result.gaps)
  if (gaps.length === 0 && Number.isFinite(openEnds) && openEnds > 0) {
    gaps.push({ code: 'OPEN_END', count: openEnds })
  }
  // 回读到 0 条关系：坐标式草稿，交付门禁必须拦（除非审计本身是 build 的强审计）。
  if (gaps.length === 0 && Array.isArray(result?.relations) && relations.length === 0
    && result?.closed !== undefined && result?.relationAudit === undefined) {
    gaps.push({ code: 'MISSING_RELATION', type: 'ANY', refs: [], note: '草图里没有任何几何关系' })
  }
  // 刚写完关系还不能交付：必须再回读一次，才知道写入是否真的落地。
  if (MUTATING_RELATION_ACTIONS.has(relationAction) && !hasAudit && gaps.length === 0) {
    gaps.push({
      code: 'MISSING_RELATION',
      type: 'REREAD',
      refs: [],
      note: `${relationAction} 之后还没回读：先 relationAction=list 确认关系数与约束状态`,
    })
  }
  const rejected = Array.isArray(result?.rejected) ? result.rejected : []
  return {
    at: new Date().toISOString(),
    gaps: gaps.slice(0, RELATION_AUDIT_GAP_LIMIT),
    rejected: rejected.length,
    rejectedRows: rejected.slice(0, 10),
    openEnds: Number.isFinite(openEnds) ? openEnds : null,
    closed: result?.closed ?? result?.sketch?.closed ?? null,
    relationCount: Number(result?.count ?? relations.length ?? 0),
    constrainedStatus: result?.constrainedStatus ?? result?.sketch?.constrainedStatus ?? null,
    fullyConstrained: result?.fullyConstrained ?? result?.sketch?.fullyConstrained ?? null,
  }
}

function recordRelationAudit({ designId, documentPath, relationAction, result, revision }) {
  if (typeof designId !== 'string' || designId.length === 0) return null
  const summary = summarizeRelationsForAudit(result, relationAction)
  if (summary === null) return null
  const store = readLiveStore()
  const previous = store.designs[designId] ?? { designId, revision: 0, images: [] }
  // F2：审计必须带**本设计自己的、可信的** revision。
  //
  // 旧实现回退成 `previous.revision`（live 里该 designId 的旧值）—— 而
  // `inspect action="relations"` 的调用方根本不传 revision，于是每次回读都只把
  // 审计的版本号挪到「上一次落账的版本」，追不上几何版本：096f18c3 里连续三次
  // 关系审计都是 revision 4，而几何已经 10；四个会话为此撞了 40 次
  // RELATIONS_INCOMPLETE。现在取不到可信 revision 就**不落账**（宁缺勿假），
  // 由调用方回 AUDIT_REVISION_UNKNOWN，门禁照旧按「没有这一版的审计」处理。
  const stamp = Number.isFinite(Number(revision)) && revision !== null && revision !== ''
    ? Number(revision)
    : null
  if (stamp === null) return null
  const audit = {
    ...summary,
    relationAction: relationAction ?? null,
    revision: stamp,
  }
  const next = {
    ...previous,
    designId,
    revision: previous.revision ?? 0,
    ...(typeof documentPath === 'string' && documentPath.length > 0 ? { documentPath } : {}),
    relationAudit: audit,
    updatedAt: new Date().toISOString(),
  }
  store.designs[designId] = next
  writeLiveStore(store)
  return next
}

function trackLive(name, args, envelope) {
  if (envelope === null || typeof envelope !== 'object') return
  const designId = envelope.designId ?? args?.designId ?? args?.definition?.designId
  const doc = envelope?.changes?.document
  const documentPath = typeof doc?.path === 'string' && doc.path.length > 0 ? doc.path : undefined
  // 确定性核对（inspect action="verify"）的结果必须记到 live：PTC 模式下审查门
  // 看不到子调用返回，只能从这里读。**要在下面 failed 早退之前**处理 ——
  // verify failed 恰恰是最要被门看见的那一种（VERIFY_FAILED），不能整条丢掉。
  // 但带 extra.error 的 failed 是工具自己没跑起来（桥接器不在、参数错），
  // 不是「量到了但不对」：那种不能记成 verify failed，否则一次网络抖动就把
  // live.json 里钉死一个假的 VERIFY_FAILED。
  if (name === 'inspect' && args?.action === 'verify' && envelope?.extra?.error === undefined) {
    const changes = envelope?.changes ?? {}
    const checks = Array.isArray(changes.checks) ? changes.checks : []
    recordVerify({
      dataDir: DATA_DIR,
      designId,
      documentPath,
      verify: {
        status: envelope?.status,
        checks,
        unmeasured: Array.isArray(changes.unmeasured)
          ? changes.unmeasured
          : checks.filter((item) => item?.status === 'unmeasured'),
        summary: envelope?.summary,
        checkCount: checks.length,
      },
    })
  }
  if (envelope.status === 'failed') return
  if (name === 'model' && MUTATING_MODEL_ACTIONS.has(args?.action)) {
    const bumped = bumpRevision({ dataDir: DATA_DIR, designId, documentPath })
    // build output="sketch" 的返回里带关系审计：和 revision 一起记，交付门禁才判得准。
    const changes = envelope?.changes ?? {}
    if (changes.relationAudit !== undefined || changes.sketch !== undefined) {
      recordRelationAudit({
        designId,
        documentPath,
        relationAction: 'build',
        revision: bumped?.revision,
        result: {
          ...changes,
          relations: changes.sketch?.relations ?? changes.relations,
          openEnds: changes.sketch?.openEnds,
          closed: changes.sketch?.closed,
        },
      })
    }
  }
  // build / assemble 自带的三视图：必须在 bumpRevision 之后记进 live，否则交付门
  // 仍判 NO_CURRENT_VIEW，模型只能再手动 capture 一遍（实测 134 次）。
  const autoShots = Array.isArray(envelope?.changes?.autoShots) ? envelope.changes.autoShots : []
  for (const shot of autoShots) {
    if (typeof shot?.path === 'string' && shot.path.length > 0) {
      recordImage({ dataDir: DATA_DIR, designId, documentPath, imagePath: shot.path, origin: 'capture', view: shot.view })
    }
  }
  const imagePath = envelope?.changes?.path
    ?? envelope?.changes?.image?.path
    ?? (Array.isArray(envelope?.artifacts) ? envelope.artifacts.find((item) => item?.kind === 'image')?.path : undefined)
  const takesPicture = name === 'capture' || name === 'inspect'
  if (takesPicture && typeof imagePath === 'string' && imagePath.length > 0) {
    recordImage({ dataDir: DATA_DIR, designId, documentPath, imagePath })
  }
  // F4：deliver 成功 = 这一版过了交付门。把审批钉在 live.json 上，之后
  // `job op=save/export`、`model invoke SaveAs*`、`task` 里的 save/export 才允许。
  // 这是「谁看过这一版」的唯一凭据：宿主侧审查门拦得住 deliver，拦不住这些后门，
  // 但它们都在本进程里执行，所以在这里判。
  if (name === 'deliver' && envelope.status !== 'failed') {
    const artifact = Array.isArray(envelope?.artifacts)
      ? envelope.artifacts.find((item) => typeof item?.path === 'string' && item.path.length > 0)
      : null
    recordDeliveryApproval({
      dataDir: DATA_DIR,
      designId,
      documentPath,
      kind: args?.kind,
      path: artifact?.path,
      bytes: artifact?.bytes,
    })
    // 交付之后文档有了真正存盘的名字。F6 的「登记名」就该是这个 —— 建的时候
    // 叫 零件12，量的时候叫 锁盖，两者本来就不该相等。
    const savedTitle = typeof doc?.title === 'string' && doc.title.length > 0
      ? doc.title
      : (artifact?.path ? basename(artifact.path).replace(/\.[^.]+$/, '') : undefined)
    if (typeof savedTitle === 'string') {
      recordDocumentTitle({ dataDir: DATA_DIR, designId, title: savedTitle, documentPath: artifact?.path ?? documentPath })
    }
  }
  // F6 的学习侧：建模类动作的返回里带 document.title，那是本设计**自己**打开/新建的
  // 文档，先记下来。之后的 measure/verify/relations 才有「期望标题」可比。
  if (name === 'model' && MUTATING_MODEL_ACTIONS.has(args?.action) && typeof doc?.title === 'string') {
    recordDocumentTitle({ dataDir: DATA_DIR, designId, title: doc.title, documentPath })
  }
}

/**
 * F6：这次量到的文档，是不是 designId 登记的那一份？
 *
 * 期望标题只来自本设计自己的记录（documentTitle，其次 documentPath 的文件名）——
 * 不取全局最新，那一套正是「量了别人的零件还不知道」的来源。
 * 核对通过时把标题学回去；不通过就返回 {ok:false, error: WRONG_DOCUMENT}。
 */
function documentIdentityCheck({ designId, document }) {
  if (typeof designId !== 'string' || designId.length === 0) return { ok: true }
  const title = document?.title
  if (typeof title !== 'string' || title.trim().length === 0) return { ok: true }
  const record = readLiveRecord({ dataDir: DATA_DIR, designId })
  // 只拿**登记名**比：本次回包里的 document.path 与自己比永远相等，等于不判。
  const registered = []
  if (typeof record?.documentTitle === 'string' && record.documentTitle.length > 0) registered.push(record.documentTitle)
  if (typeof record?.documentPath === 'string' && record.documentPath.length > 0) registered.push(record.documentPath)
  const verdict = checkDocumentIdentity({ designId, expectedTitles: registered, actualTitle: title })
  if (verdict.ok) {
    // 只从「真对上了」或「还没有登记」的回包里学标题。期望是通名（零件12）时
    // 放过但**不学** —— 否则第一次量错的那份文档会把错标题登记进来，之后就再也
    // 对不上了。通名本身也没有登记价值。
    const learnable = verdict.reason === 'MATCH' || verdict.reason === 'NO_EXPECTATION'
    if (learnable && !isGenericTitle(title)) {
      recordDocumentTitle({
        dataDir: DATA_DIR,
        designId,
        title,
        documentPath: typeof document?.path === 'string' ? document.path : undefined,
      })
    }
    return { ok: true }
  }
  return { ok: false, error: verdict.error }
}

// ---------------------------------------------------------------------------
// 参数名写错时不要静默吞掉。
//
// 实测代价：一次会话里 `inspect action="figure"` 先后用了 path/source、
// x/y/width/height、w/h、region、box、crop 六种写法才成功；`catalog search`
// 用 `q` 也照样返回。工具 schema 是宽容的（多出的键被丢掉），调用方看不出
// 自己问的是另一件事。这里在进入工具之前把多余的键挑出来，回 UNKNOWN_PARAM
// 并给出最接近的键名。
// ---------------------------------------------------------------------------

/** 从一个 zod 工具 schema 里取顶层允许的键；拿不到就返回 null（表示不检查）。 */
function schemaKeys(schema) {  if (!schema || typeof schema !== 'object') return null
  try {
    const shape = typeof schema.shape === 'function' ? schema.shape() : schema.shape
    if (shape && typeof shape === 'object') return Object.keys(shape)
  } catch {}
  try {
    const def = schema._def
    const shape = typeof def?.shape === 'function' ? def.shape() : def?.shape
    if (shape && typeof shape === 'object') return Object.keys(shape)
  } catch {}
  return null
}

/** 编辑距离，只用来找「你大概想写的是哪个键」。 */
function editDistance(a, b) {
  const m = a.length
  const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i += 1) {
    const cur = [i]
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/** 人常写的那几个同义词。只用来指路，不会替调用方改参数。 */
const ARG_SYNONYMS = {
  // 路径类的常见误写：用户实测里最贵的一次（deliver/capture 写 outputPath），
  // 原来只回「没有相近的键」，模型只能再猜一轮。
  outputpath: 'path',
  outpath: 'path',
  filepath: 'path',
  saveas: 'path',
  design: 'definition',
  params: 'parameters',
  param: 'parameters',
  keyword: 'q',
  keywords: 'q',
  search: 'q',
  term: 'q',
  text: 'q',
  path: 'source',
  file: 'source',
  filename: 'source',
  image: 'source',
  unit: 'units',
  // verify 的验收条件只有一个入口 expect。实测里模型先写 expectations、再写 checks，
  // 两次都只拿到「没有相近的键」—— 这里直接把这两个写法指到 expect，省掉两轮猜。
  expectations: 'expect',
  expectation: 'expect',
  assertions: 'expect',
  checks: 'expect',
}

/** inspect action=figure 的顶层误写：这些名字只属于 figure 那一层（小写比较）。
 *
 * 它们不在 inspect 的 schema 里，所以一定会被 rejectUnknownArgs 拦下 —— 报错时
 * 要明确指回 figure.source / figure.op，而不是让模型自己去猜嵌套。 */
const FIGURE_TOP_LEVEL_KEYS = ['source', 'path', 'image', 'file', 'op', 'crop', 'region', 'box',
  'scale', 'grid', 'contrast', 'maxside', 'output']

function rejectUnknownArgs(name, definition, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const allowed = schemaKeys(definition?.inputSchema)
  if (allowed === null) return null
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unknown.length === 0) return null
  const suggestions = unknown.map((key) => {
    const synonym = ARG_SYNONYMS[key.toLowerCase()]
    if (synonym !== undefined && allowed.includes(synonym)) return { key, nearest: synonym }
    let best = null
    let bestDistance = Infinity
    for (const candidate of allowed) {
      const distance = editDistance(key.toLowerCase(), candidate.toLowerCase())
      if (distance < bestDistance) { bestDistance = distance; best = candidate }
    }
    return { key, nearest: bestDistance <= Math.max(2, Math.ceil(key.length / 2)) ? best : null }
  })
  const hint = suggestions
    .map((item) => (item.nearest ? `${item.key} → ${item.nearest}` : `${item.key}（没有相近的键）`))
    .join('; ')
  // figure 的路径/参数必须嵌在 figure 里：只说「没有相近的键」等于让模型再猜一轮。
  const figureKeys = name === 'inspect' && args?.action === 'figure'
    ? unknown.filter((key) => FIGURE_TOP_LEVEL_KEYS.includes(key.toLowerCase()))
    : []
  const figureClause = figureKeys.length
    ? `图纸路径与参数要写在 figure 里（figure.source / figure.op），顶层不收 ${figureKeys.join(', ')}。`
    : ''
  const tail = figureClause ? `。${figureClause}` : ''
  return failed({
    op: name,
    error: fail('UNKNOWN_PARAM', `${name} 不认识这些参数：${unknown.join(', ')}。${hint}${tail}`, {
      unknown,
      allowed,
      suggestions,
      example: '按工具说明里的参数名写；写错名字时它不会被忽略，而是直接报这个错。',
    }),
    // 同一个 UNKNOWN_PARAM，下一步完全取决于工具：verify 里写错的是「核对键」
    // （例如把 expect 写成顶层 expectations），指到 workspace action=project
    // 是跨域误导 —— 那是改设计参数的入口。这里按工具给真正有用的那条。
    nextActions: name === 'inspect' && args?.action === 'verify' ? verifyArgsHint()
      : name === 'model' && args?.action === 'edit' ? [
        '参数名不在这个设计定义里 —— 先 workspace action=project 看一眼 params 有哪些。',
        '要新增一个尺寸，改设计定义后 model action=build 重建，而不是直接 edit 一个新名字。',
      ]
      : figureKeys.length > 0 ? figureArgsHint()
        : undefined,
  })
}

// ── 只读实例里的写子动作 ────────────────────────────────────────────────────
// SW_MCP_TOOLS 白名单只按「工具名」裁剪，可 inspect 一个工具里同时带着读和写两类
// 子动作：relationAction 的 add/remove/edit/apply/clear、dimensionAction 的
// add/edit/remove 都会原样转给桥接器的写路径。只裁名字等于给「只读」审查通道
// （mcp__sw-ro__inspect）留了一扇改用户文档的门，所以白名单生效时必须在**进入
// handler（也就是碰桥接器）之前**把写子动作拒掉。取值规则与 tools-observe.mjs
// 的 relations / dimensions 分支保持一致：relationAction 优先，apply=true 是它的
// 旧写法；dimensionAction 省略时是 list。
const RELATION_WRITE_ACTIONS = new Set(['add', 'remove', 'edit', 'apply', 'clear'])
const DIMENSION_WRITE_ACTIONS = new Set(['add', 'edit', 'remove'])

// 工具面拆分后，relations / dimensions 这两个 action 从 inspect 迁到了 constraints
// 组（tool-face.mjs:263-270）。只按「工具名」判白名单，`SW_MCP_TOOLS=inspect,constraints`
// 就能用 constraints 走到同一个会写文档的 handler —— 实测回了 INSTANCE_NOT_BOUND，
// 即已经穿透到桥接器。所以判据按**原工具**算：两个工具名都进写子动作检查。
const READ_ONLY_ACTION_TOOLS = new Set(['inspect', 'constraints'])

/** 白名单模式下这次调用是不是写子动作；是则返回 {field, value, allowed}，否则 null。 */
function readOnlyWriteAttempt(name, args) {
  if (!READ_ONLY_ACTION_TOOLS.has(name) || args === null || typeof args !== 'object') return null
  if (args.action === 'relations') {
    const effective = args.relationAction ?? (args.apply === true ? 'apply' : 'list')
    if (!RELATION_WRITE_ACTIONS.has(effective)) return null
    const viaApply = args.relationAction === undefined
    return {
      field: viaApply ? 'apply' : 'relationAction',
      value: viaApply ? true : effective,
      allowed: ['list', 'infer'],
    }
  }
  if (args.action === 'dimensions') {
    const effective = args.dimensionAction ?? 'list'
    if (!DIMENSION_WRITE_ACTIONS.has(effective)) return null
    return { field: 'dimensionAction', value: effective, allowed: ['list'] }
  }
  return null
}

const operations = new Map()
const registerMcpTool = server.registerTool.bind(server)

// ---------------------------------------------------------------------------
// 工具面分层：核心常驻 + 领域按需（见 tool-face.mjs）。
//
// 一个原工具（model / inspect / workspace）现在登记成多个工具，共用同一个
// handler 与同一份 action 语义；每个工具只登记自己的参数、只接受自己的 action。
// 按需组不进 tools/list，直到 catalog action="activate" 真的把工具注册进
// McpServer —— 注册动作本身会 sendToolListChanged，DSH 的 mcp-client 收到
// notifications/tools/list_changed 后重新同步，下一轮 run_code 才能看见。
//
// 为什么不靠 SW_MCP_TOOLS 白名单：那是**只读审查通道**用的裁剪（按进程/按会话配
// env），不是默认工具面。默认面必须由代码决定，否则「装好就 11 个工具」永远成立。
// ---------------------------------------------------------------------------
const onDemandPlans = new Map()        // 按需工具名 -> () => RegisteredTool|undefined
const toolHandles = new Map()          // 工具名 -> McpServer 的注册句柄（支持 enable/disable）
const activatedCapabilities = new Set()

/** 结构化失败：既有 failed() 的 extra.error（错误码住在那里），也在 changes 顶层带 code。 */
function structuredFailure({ op, designId, code, message, detail, nextActions, changes }) {
  return ok(
    envelope({
      summary: `${op} 失败：${message}`,
      designId,
      status: 'failed',
      changes: { ...(changes ?? {}), code },
      nextActions,
      extra: { error: { code, message, ...(detail ? { detail } : {}) } },
    }),
  )
}

/** action 迁到别的工具了：指名道姓说清楚要激活哪一组、下一轮怎么调。 */
function actionMovedResult(toolName, args, target) {
  const action = args?.action
  return structuredFailure({
    op: `${toolName}.${action}`,
    designId: typeof args?.designId === 'string' ? args.designId : undefined,
    code: 'ACTION_MOVED',
    message: `${toolName} 不再直接执行 action="${action}"：它归 ${target} 组，而默认只注册核心工具。`,
    detail: {
      tool: toolName,
      action,
      movedTo: target,
      capability: target,
      reason: 'CORE_ONLY_BY_DEFAULT',
      activate: { tool: 'catalog', args: { action: 'activate', capability: target } },
    },
    changes: { tool: toolName, action, movedTo: target },
    nextActions: [
      `先 catalog action="activate" capability="${target}"（本轮激活，下一轮 run_code 才看得见），再调用 ${target}({action:"${action}", ...})`,
    ],
  })
}

/** 省略 action 的分组工具：默认值要么在组里、要么明确拒绝，不静默换动作。 */
function actionRequiredResult(toolName, group) {
  return structuredFailure({
    op: `${toolName}.`,
    code: 'ACTION_REQUIRED',
    message: `${toolName} 需要显式 action：${group.actions.join(' / ')}。省略 action 时的旧默认值已迁到别的工具，这里不静默替换。`,
    detail: { tool: toolName, supported: group.actions },
    changes: { tool: toolName, supported: group.actions },
    nextActions: [`按上面列表补 action；要按旧默认动作执行，先 catalog action="activate" capability="<对应工具>"`],
  })
}

/** 把一个定义登记进 McpServer 与 operations 表。返回注册句柄（被白名单/紧凑模式裁掉时是 undefined）。 */
function registerToolDefinition(name, definition, handler, preGuard) {
  if (operations.has(name)) return undefined
  // zod 默认把 schema 里没声明的键**丢掉**，等到 handler 里已经看不见了 —— 于是
  // 「写了 keyword 而不是 q」变成「没给关键词」，报的是另一件事。这里统一改成
  // passthrough，让多余的键活着到 rejectUnknownArgs，报 UNKNOWN_PARAM 并给出
  // 最接近的键名。
  const patched = definition?.inputSchema && typeof definition.inputSchema.passthrough === 'function'
    ? { ...definition, inputSchema: definition.inputSchema.passthrough() }
    : definition
  const execute = makeExecutor(name, patched, handler, preGuard)
  operations.set(name, { ...patched, execute })
  if (MCP_TOOL_ALLOWLIST !== null && !MCP_TOOL_ALLOWLIST.has(name)) return undefined
  if (COMPACT_MCP) return undefined
  if (MCP_TOOL_ALLOWLIST?.size === 1 && name === 'inspect') {
    return registerMcpTool(name, { ...patched, inputSchema: reviewInspectSchema(patched.inputSchema) }, execute)
  }
  return registerMcpTool(name, patched, execute)
}

/** 一个分组工具：裁参数、限 action、登记。 */
function registerGroupTool(sourceName, group, definition, handler) {
  const inputSchema = buildGroupSchema(z, definition.inputSchema, sourceName, group)
  const preGuard = (args) => {
    const action = args?.action
    if (action === undefined) return actionRequiredResult(group.name, group)
    if (group.actions.includes(action)) return null
    const owner = actionOwner(sourceName, action) ?? actionOwnerAnywhere(action)
    return owner === null ? null : actionMovedResult(group.name, args, owner)
  }
  const handle = registerToolDefinition(
    group.name,
    { ...definition, title: group.title, description: group.description, inputSchema },
    handler,
    preGuard,
  )
  if (handle !== undefined) toolHandles.set(group.name, handle)
  return handle
}

/**
 * 本会话此刻真正能调的 action，按工具分组。
 *
 * 为什么要有：工具的 action 是按组注册的（见 tool-face TOOL_SPLITS），没激活的组
 * 连 action 都不在 schema 里。建模会话实测因此以为「inspect 只有 model/faces/bodies/
 * sketch/figure/measure，六档验收不存在」—— 而 verify 就在 qa 组里，只是没开。
 * 与其让人去猜一个不存在的 action，不如把「现在有什么、打开哪个能力就有什么」写进
 * focus 的返回值。
 */
function toolFaceReport(activeCapabilities = []) {
  const active = new Set(activeCapabilities)
  const tools = {}
  for (const [sourceName, groups] of Object.entries(TOOL_SPLITS)) {
    const live = []
    const locked = []
    for (const group of groups) {
      // core 组启动即注册；其余组要么已激活，要么还锁着。
      const unlocked = group.core === true || active.has(group.name)
      for (const action of group.actions) {
        if (unlocked) live.push(group.name === sourceName ? action : `${group.name}.${action}`)
        else locked.push({ action, capability: group.name, group: group.name })
      }
    }
    if (live.length || locked.length) tools[sourceName] = { actions: live, locked }
  }
  return {
    tools,
    summary: 'actions 是本会话现在可调的；locked 里每条都写了「激活哪个 capability 才有」',
  }
}

/** focus 的下一句：把还锁着、且调用方最可能需要的动作指出来。 */
function inactiveFaceHint(activeCapabilities = []) {
  const active = new Set(activeCapabilities)
  const hints = []
  if (!active.has('qa')) {
    hints.push('inspect action="verify" / evidence / review / snapshot 属于按需组 qa：'
      + 'catalog action="activate" capability="qa"（或 catalog action="focus" mode="modify"）之后才在 schema 里')
  }
  if (!active.has('assembly')) hints.push('assembly/assembly_inspect 属于按需组：catalog action="activate" capability="assembly"')
  if (!active.has('advanced_api')) hints.push('advanced_api（invoke/object/kinds/batch）属于按需组：catalog action="activate" capability="advanced_api"')
  if (!active.has('workspace_ops')) hints.push('workspace_ops（status/instances/cleanup/reap）属于按需组：catalog action="activate" capability="workspace_ops"')
  return hints.length ? hints.join('；') : null
}

/** catalog.activate 的实现：真的把工具注册进 McpServer（重复激活返回 already-active）。 */
function activateCapability(capability) {
  const name = typeof capability === 'string' ? capability.trim() : ''
  const known = onDemandCapabilities()
  if (!name) {
    return { error: fail('BAD_ARGUMENT', 'activate 需要 capability（按需工具名）', { known, core: coreToolNames() }) }
  }
  if (coreToolNames().includes(name)) {
    return { error: fail('ALREADY_CORE', `${name} 是核心工具，启动即注册，不需要激活`, { core: coreToolNames() }) }
  }
  const existing = toolHandles.get(name)
  if (existing && typeof existing.enable === 'function') {
    existing.enable()
    activatedCapabilities.add(name)
    server.sendToolListChanged?.()
    return { alreadyActive: true, tools: [name] }
  }
  const plan = onDemandPlans.get(name)
  if (plan === undefined) {
    return { error: fail('NOT_FOUND', `没有叫 ${name} 的按需工具`, { known, core: coreToolNames() }) }
  }
  if (MCP_TOOL_ALLOWLIST !== null && !MCP_TOOL_ALLOWLIST.has(name)) {
    return {
      error: fail('READ_ONLY_TOOLSET', `只读通道（SW_MCP_TOOLS 白名单）里没有 ${name}，不能激活`, {
        allowlist: [...MCP_TOOL_ALLOWLIST], known,
      }),
    }
  }
  const handle = plan()
  activatedCapabilities.add(name)
  // McpServer.registerTool 自己会发；这里再显式发一次，保证「注册后一定有通知」。
  server.sendToolListChanged?.()
  return { activated: [name], tools: [name], registered: handle !== undefined }
}

/** catalog.deactivate：能停用就真停用（句柄 disable），不能就如实说不支持。 */
function deactivateCapability(capability) {
  const name = typeof capability === 'string' ? capability.trim() : ''
  if (!name) return { error: fail('BAD_ARGUMENT', 'deactivate 需要 capability（按需工具名）', { active: [...activatedCapabilities] }) }
  if (!activatedCapabilities.has(name)) {
    return { error: fail('NOT_ACTIVE', `${name} 当前没有激活，无需停用`, { active: [...activatedCapabilities] }) }
  }
  const handle = toolHandles.get(name)
  if (!handle || typeof handle.disable !== 'function') {
    return { unsupported: true, note: '这套 MCP SDK 的注册句柄不支持停用；重启会话即回到默认工具面。' }
  }
  handle.disable()
  activatedCapabilities.delete(name)
  server.sendToolListChanged?.()
  return { deactivated: [name] }
}

/** 这个工具当前能不能调（用于 catalog.search/detail 的 activation_required）。 */
function activationStateOf(toolName) {
  const capability = capabilityOf(toolName)
  if (capability === null) return { activation_required: false }
  return activatedCapabilities.has(capability)
    ? { activation_required: false }
    : { activation_required: true, capability }
}

function makeExecutor(name, definition, handler, preGuard) {
  return async (args, extra) => {
    const cid = newCorrelationId(name)
    return cidStore.run(cid, async () => {
      const started = Date.now()
      try {
        // 分层守门：迁走的 action、省略 action 的分组，都在碰 handler 之前拦下。
        if (typeof preGuard === 'function') {
          const early = preGuard(args)
          if (early !== null && early !== undefined) {
            writeEvent({
              level: 'warn',
              tool: name,
              cid,
              ms: Date.now() - started,
              args: digestArgs(args),
              status: 'failed',
              code: typeof args?.action === 'string' ? 'ACTION_ROUTED' : 'ACTION_REQUIRED',
            })
            return early
          }
        }
        // 只读实例：工具名裁过了还不够，inspect 里的写子动作也要在进入 handler
          // （也就是碰桥接器）之前拒掉 —— 否则「只读」通道照样能改用户的文档。
          // 默认实例（没有 SW_MCP_TOOLS 白名单）不走这个分支，行为不变。
          if (MCP_TOOL_ALLOWLIST !== null) {
            const attempt = readOnlyWriteAttempt(name, args)
            if (attempt !== null) {
              writeEvent({
                level: 'warn',
                tool: name,
                cid,
                ms: Date.now() - started,
                args: digestArgs(args),
                status: 'failed',
                code: 'READ_ONLY_TOOLSET',
              })
              return failed({
                op: `${name}.${attempt.field}`,
                designId: typeof args?.designId === 'string' ? args.designId : undefined,
                error: fail(
                  'READ_ONLY_TOOLSET',
                  `只读通道（SW_MCP_TOOLS 白名单）不允许 ${attempt.field}=${JSON.stringify(attempt.value)}：`
                    + '这次调用在进入桥接器之前就被拒了，用户的文档没有被改动。'
                    + `只读实例只放行 ${attempt.allowed.join(' / ')}。`,
                  {
                    tool: name,
                    field: attempt.field,
                    value: attempt.value,
                    allowed: attempt.allowed,
                    allowlist: [...MCP_TOOL_ALLOWLIST],
                  },
                ),
              })
            }
          }
          // F4：save/export 这类「绕过 deliver 直接写文件」的路径，在进入 handler
          // 之前就判。判据是服务侧自己写的 delivery.approvedAtRevision（deliver 成功那
          // 一刻落的账），不是模型说的话。逃生口是显式 force:"manual"（写
          // review/bypass.jsonl 留痕），不是「换个工具再试」。
          // 放在这里而不是各 handler 里：job / task / model(batch) 都能存盘，一处漏掉
          // 就是一条后门。
          const batchError = name === 'model' && args.action === 'batch' ? modelBatchArgumentError(args.ops) : null
          if (batchError) return failed({ op: 'model.batch', designId: args.designId, error: batchError })
          const saveCheck = checkSavePath({
            dataDir: DATA_DIR,
            clientId: SW_CLIENT_ID,
            toolName: name,
            args,
          })
          if (saveCheck.ok !== true) {
            writeEvent({
              level: 'warn',
              tool: name,
              cid,
              ms: Date.now() - started,
              args: digestArgs(args),
              status: 'failed',
              code: saveCheck.error.code ?? 'GATE_BYPASS_REFUSED',
            })
            return failed({
              op: `${name}.${saveCheck.call?.path ?? 'save'}`,
              designId: saveCheck.designId ?? args?.designId,
              error: saveCheck.error,
              nextActions: saveCheck.error.code === 'DESIGN_ID_REQUIRED'
                ? undefined
                : ['先 capture 一张模型图再 deliver：审查门在交付那一刻审这一版，交付通过后才可以导出别的格式',
                  '确实要救场（门禁本身坏了）就在这次调用里加 force:"manual"，并在汇报里写明原因 —— 会记进 review/bypass.jsonl'],
            })
          }
          if (saveCheck.bypassed === true) {
            writeEvent({
              level: 'warn',
              tool: name,
              cid,
              ms: Date.now() - started,
              args: digestArgs(args),
              status: 'ok',
              code: 'GATE_BYPASS_FORCED',
            })
          }
          const rejected = rejectUnknownArgs(name, definition, args)
          if (rejected !== null) {
            writeEvent({
              level: 'warn',
              tool: name,
              cid,
              ms: Date.now() - started,
              args: digestArgs(args),
              status: 'failed',
              code: 'UNKNOWN_PARAM',
            })
            return rejected
          }
          const result = await handler(args, extra)
          try {
            trackLive(name, args, parseEnvelopeText(result))
          } catch {
            // 记账失败不影响工具本身。
          }
          const digest = envelopeDigest(result)
          writeEvent({
            level: digest?.status === 'failed' ? 'warn' : 'info',
            tool: name,
            cid,
            ms: Date.now() - started,
            args: digestArgs(args),
            ...digest,
          })
          return result
        } catch (error) {
          writeEvent({
            level: 'error',
            tool: name,
            cid,
            ms: Date.now() - started,
            args: digestArgs(args),
            code: error?.code ?? 'UNHANDLED',
            message: error?.message ?? String(error),
            stack: (error?.stack ?? '').split('\n').slice(0, 4).join(' | '),
          })
          throw error
        }
      })
    }
  }

// ---------------------------------------------------------------------------
// 注册路由：分层表决定「现在登记」还是「先挂起，等 catalog.activate」。
//
// 未知工具名照旧直接登记（fail-open）：新加的工具不该因为没登记进分层表就消失。
// ---------------------------------------------------------------------------
server.registerTool = (name, definition, handler) => {
  const groups = TOOL_SPLITS[name]
  if (groups !== undefined) {
    for (const group of groups) {
      if (group.core) registerGroupTool(name, group, definition, handler)
      else onDemandPlans.set(group.name, () => registerGroupTool(name, group, definition, handler))
    }
    return undefined
  }
  const described = DESCRIPTIONS[name] ? { ...definition, description: DESCRIPTIONS[name] } : definition
  if (ON_DEMAND_WHOLE.includes(name)) {
    onDemandPlans.set(name, () => {
      const handle = registerToolDefinition(name, described, handler)
      if (handle !== undefined) toolHandles.set(name, handle)
      return handle
    })
    return undefined
  }
  const handle = registerToolDefinition(name, described, handler)
  if (handle !== undefined) toolHandles.set(name, handle)
  return handle
}

// Stage and direct MCP calls share the same validation, save gate and revision tracking.
function validateOperation(name, args) {
  const op = operations.get(name)
  if (!op || (MCP_TOOL_ALLOWLIST !== null && !MCP_TOOL_ALLOWLIST.has(name))) {
    return { error: failed({ op: name, designId: args?.designId, error: fail('UNKNOWN_OPERATION', `未知操作 ${name}`) }) }
  }
  const unknown = rejectUnknownArgs(name, op, args)
  if (unknown) return { error: unknown }
  const parsed = op.inputSchema.safeParse(args)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }))
    return { error: failed({ op: name, designId: args?.designId,
      error: fail('BAD_ARGUMENT', `${fields[0]?.field || name}：${fields[0]?.message ?? '参数无效'}`, { fields }) }) }
  }
  return { op, args: parsed.data }
}

async function dispatchOperation(name, args, context) {
  const checked = validateOperation(name, args)
  if (checked.error) return checked.error
  return operationContext.run(context, () => checked.op.execute(checked.args, context?.mcp))
}

/** 孔的对外形状：直径 + 轴线在 X/Y 上的位置。桥接器返回的是 SOLIDWORKS 的
 * 原始命名（axisPoint / axisDir），这里换成模型更容易直接用的一句话。 */
/** 按直径归并孔数量：design.json 里存的就是这个，验收时按直径比。 */
function holeCountsByDiameter(holes) {
  const counts = new Map()
  for (const hole of holes ?? []) {
    const diameter = Number(hole?.diameter)
    if (!Number.isFinite(diameter)) continue
    const key = Math.round(diameter * 100) / 100
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].map(([diameter, count]) => ({ diameter, count }))
}

/** 孔心位置：桥接器给的是 axisPoint，取前两维。 */
function holeCenters(holes) {
  if (!Array.isArray(holes)) return []
  return holes
    .filter((hole) => Array.isArray(hole?.axisPoint))
    .map((hole) => ({ diameter: Number(hole.diameter), at: [hole.axisPoint[0], hole.axisPoint[1]] }))
}

function shapeHole(h) {
  return {
    diameter: h.diameter,
    at: Array.isArray(h.axisPoint) ? [h.axisPoint[0], h.axisPoint[1]] : null,
    throughAxis: h.axisDir,
  }
}

/** 孔心的三维读数（axisPoint 全三分量）。孔距可以沿 Z 变化，只比 X/Y 会漏判。 */
function holeVectors(holes) {
  if (!Array.isArray(holes)) return []
  return holes
    .filter((hole) => Array.isArray(hole?.axisPoint))
    .map((hole) => ({
      diameter: Math.round(Number(hole.diameter) * 1e6) / 1e6,
      at: [0, 1, 2].map((i) => Math.round(Number(hole.axisPoint[i] ?? 0) * 1e6) / 1e6),
    }))
}

/** 孔心集合是否变了。孔位/旋转类参数改完体积可以一点不变，但孔心必须动。 */
function holesMoved(beforeHoles, afterHoles) {
  const after = holeVectors(afterHoles)
  // 旧项目记录只存了孔数（number）：没有坐标就只能比数量。build 现在同时存
  // measurements.holePositions（三维坐标数组），下一次 edit 走坐标级比较。
  if (!Array.isArray(beforeHoles)) {
    return Number.isFinite(Number(beforeHoles)) ? Number(beforeHoles) !== after.length : false
  }
  const before = holeVectors(beforeHoles)
  if (before.length !== after.length) return true
  const key = (hole) => `${Number(hole.diameter).toFixed(6)}|${hole.at.map((v) => Number(v).toFixed(6)).join(',')}`
  const set = new Set(after.map(key))
  return before.some((hole) => !set.has(key(hole)))
}

const designIdArg = z
  .string()
  .optional()
  .describe('设计标识；运行时必填，同一设计全程复用。')

/**
 * 本进程见过的 designId（只用于报错时给候选，不再当默认值用）。
 *
 * 旧实现是 `resolveDesignId = given ?? lastDesignId ?? null`，注释假设「一个 MCP
 * 进程只服务一个会话」—— 实测被打破：a00b4504 的 `designId=undefined` build 建成了
 * 上一个会话的 `tee-pipe-v1`，0bb49837 的 `bracket-06v1` 量到别的会话的锁盖。
 * 现在缺 designId 一律报 DESIGN_ID_REQUIRED（与桥接器 Operations.cs 的错误码一致）。
 */
const seenDesignIds = new Set()
function rememberDesign(id) {
  if (typeof id === 'string' && id.length > 0) seenDesignIds.add(id)
}
function resolveDesignId(given) {
  const id = resolveDesignIdOnly(given)
  if (id !== null) rememberDesign(id)
  return id
}
/** resolveDesignId 的严格版：缺了就抛 DESIGN_ID_REQUIRED（错误详情带本进程见过的 id）。 */
function requireDesignId(given, { tool, action } = {}) {
  const id = resolveDesignId(given)
  if (id !== null) return id
  throw designIdRequired({ dataDir: DATA_DIR, tool, action, projectIds: [...seenDesignIds] })
}

/**
 * 会话级文档账本：一个 MCP 进程只服务一个会话，所以这里记的就是「本会话建过、
 * 还没存盘」的文档。
 *
 * 为什么要记：build 之前那次 cleanup 只收「当前 designId 登记的那一个」文档，
 * 一个会话换着 designId 建模，历史文档就全留在内存里（实测一个会话堆到 32 个
 * 未存盘「零件N」）；上一轮修复后 model action=create 建的文档也进桥接器 registry
 * （RegisterCreated，designId 记 "created:<标题>"），cleanup 因此看得见它，按标题
 * close 只是兜底。这里把本会话的中间产物集中管起来，换 id 时
 * 一次收掉，而不是等用户自己发现窗口越开越多。
 */
const sessionDocs = new Map()
/**
 * 正在建的 designId → 并发次数。这里必须用计数而不是 Set：同一个 id 并发 build
 * 时，先完成的那次 delete 会把仍在建的那次的标记一起删掉，之后的第三方清扫就
 * 会把正在建的文档当旧账 close{title,allowDirty:true} 关掉。
 */
const inFlightDesigns = new Map()
// 上一次 build 超时后，SOLIDWORKS 往往还在建（240 s 只是客户端放弃，不是作业结束）。
// 冷却窗口内拒绝同一个 designId 的第二次 build，避免两台作业叠在同一个实例上。
const buildCooldown = new Map()
const BUILD_COOLDOWN_MS = 45000

// 正在跑的 build：同一个 designId 的第二次调用直接拒绝，不再排队。
// 只靠超时冷却不够 —— 实测并发两次 build 会串行跑完两遍（各 40s），
// 模型以为第一次失败，实际两次都成功，白花一倍时间。
const activeBuildDesigns = new Set()
const SESSION_SWEEP = process.env.SW_MCP_SESSION_SWEEP !== '0'
const SESSION_SWEEP_MAX = Number(process.env.SW_MCP_SESSION_SWEEP_MAX ?? 8)

/** 读一个非负数值环境变量；取不到或不是数就退回默认值。 */
function sweepNumberFromEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

// 账本上限：超过就丢最旧的条目（按 at）。只有 SW_MCP_SESSION_SWEEP_MAX 那个
// 「每轮扫几条」的上限挡不住表长 —— 关不掉的条目留在表里，一次长会话能堆到几百。
const SESSION_SWEEP_LIMIT = Math.max(1, Math.floor(sweepNumberFromEnv('SW_MCP_SESSION_SWEEP_LIMIT', 64)))
// 账本 TTL：六小时后还没被收掉的条目多半当时就关不掉、之后也不会再关，移出别每轮重试。
const SESSION_SWEEP_TTL_MS = sweepNumberFromEnv('SW_MCP_SESSION_SWEEP_TTL_MS', 6 * 3600_000)
// 清扫失败退避：第 n 次失败后等 min(10min, 2min × n) 再试。
const SWEEP_RETRY_MIN_MS = 2 * 60_000
const SWEEP_RETRY_MAX_MS = 10 * 60_000

/** in-flight 计数 +1：同一 id 的并发构建各持一份，谁先完成都不会提前销标记。 */
function inFlightBegin(designId) {
  if (!designId) return
  inFlightDesigns.set(designId, (inFlightDesigns.get(designId) ?? 0) + 1)
}

/** in-flight 计数 -1：归零才删；负数是调用侧漏了 begin，按 0 处理。 */
function inFlightEnd(designId) {
  if (!designId) return
  const count = inFlightDesigns.get(designId) ?? 0
  if (count <= 1) inFlightDesigns.delete(designId)
  else inFlightDesigns.set(designId, count - 1)
}

/**
 * 账本上限：TrackSessionDoc 之后按插入顺序丢最旧，直到不超过上限。
 *
 * 为什么不能只靠 SW_MCP_SESSION_SWEEP_MAX：那是「每轮扫几条」的上限，关不掉的
 * 条目会一直留在表里，一次长会话能堆到几百条，每轮扫描越来越贵。这里只保证表
 * 有界，不强求回收 —— 丢掉的条目等于放弃回收它，记一条 warn 事件留痕。
 * （at 不参与淘汰，只用于 TTL；插入顺序就是「先建先丢」。）
 */
function trimSessionDocs() {
  let dropped = 0
  while (sessionDocs.size > SESSION_SWEEP_LIMIT) {
    const oldest = sessionDocs.keys().next()
    if (oldest.done) break
    sessionDocs.delete(oldest.value)
    dropped += 1
  }
  if (dropped > 0) {
    writeEvent({
      level: 'warn',
      tool: 'session-sweep',
      message: '会话文档账本超过上限，丢弃最旧条目',
      dropped,
      limit: SESSION_SWEEP_LIMIT,
    })
  }
}

/** 记录一个本会话建的文档；有 path 说明用户已经存过盘，那是用户数据，永不回收。 */
function trackSessionDoc(designId, document) {
  if (!SESSION_SWEEP || !designId) return
  if (document?.path) {
    sessionDocs.delete(designId)
    return
  }
  if (!document) return
  sessionDocs.set(designId, { title: document.title ?? null, at: Date.now() })
  trimSessionDocs()
}

/** 关掉文档之后把账本里的对应条目划掉：留着只会让下次清扫去关一个已经不存在的窗口。 */
function forgetSessionDocs(titles) {
  const wanted = new Set()
  for (const item of titles ?? []) {
    const title = typeof item === 'string' ? item : item?.title
    if (title) wanted.add(title)
  }
  if (wanted.size === 0) return
  for (const [designId, entry] of sessionDocs) {
    if (entry?.title && wanted.has(entry.title)) sessionDocs.delete(designId)
  }
}

/**
 * 从 cleanup 的返回里尽量捞出「这次真关掉了哪些标题」。
 *
 * 桥接器把 closed 放在哪一层是实现细节（顶层 closed、或 changes.closedUnsaved 之类），
 * 元素也可能是标题字符串或 {title} 对象，所以这里都认；捞不到的条目留给下次清扫，
 * 调用方绝不能因为「返回里没看懂」就整表清空 —— 条目还可能没被关掉（用户正盯着、
 * 来源不明被跳过），清表等于让它们永久失去回收资格；create 建的文档现在也进 registry，
 * 所以 closed:[] 只说明「这次没关掉任何一条」，不是「这条不存在」。
 */
function cleanupClosedTitles(result) {
  const lists = [
    result?.closed,
    result?.closedUnsaved,
    result?.changes?.closed,
    result?.changes?.closedUnsaved,
    result?.changes?.closedTitles,
  ]
  const titles = []
  for (const list of lists) {
    if (Array.isArray(list)) titles.push(...list)
  }
  return titles
}

/**
 * 把超过 TTL 的条目移出账本。
 *
 * 为什么要有 TTL：关不掉的文档（用户正盯着、有模态框挡着）会一直留在表里，靠每轮
 * 清扫重试既收不掉又占名额；超过 TTL 就当它已经不属于「本会话中间产物」，移出账本，
 * 记一条 warn 事件留痕，不抛异常。
 */
function expireSessionDocs(now) {
  if (!(SESSION_SWEEP_TTL_MS > 0)) return []
  const expired = []
  for (const [designId, entry] of sessionDocs) {
    // 正在建的文档不算过期：它的 at 可能还是上一轮建的时候写的。
    if (inFlightDesigns.has(designId)) continue
    const at = Number(entry?.at)
    if (!Number.isFinite(at) || at <= 0) continue
    if (now - at > SESSION_SWEEP_TTL_MS) expired.push(designId)
  }
  for (const designId of expired) sessionDocs.delete(designId)
  return expired
}

/**
 * 一条清扫没成功：留在账上，但挪到队尾并记 fails / nextRetryAt。
 *
 * 不挪位置的话，前几条（每轮 SESSION_SWEEP_MAX 条）关不掉的文档会永久占住名额，
 * FIFO 一 break 后面所有条目就永远轮不到。
 */
function deferSessionDoc(designId, entry) {
  if (!entry) return
  // 期间可能已被另一轮清扫销账（条目删了或换了新对象）：不要把它复活。
  if (sessionDocs.get(designId) !== entry) return
  const fails = Math.max(0, Number(entry.fails ?? 0)) + 1
  const delay = Math.min(SWEEP_RETRY_MAX_MS, SWEEP_RETRY_MIN_MS * fails)
  sessionDocs.delete(designId)
  sessionDocs.set(designId, { ...entry, fails, nextRetryAt: Date.now() + delay })
}

/**
 * 账本里这条 designId 记下的标题，现在是不是还开着；查不到（桥接器答不上来）给 null。
 *
 * 判据选「还开着吗」而不是「registry 现在记的标题是什么」：桥接器没有单独读
 * WorkRegistry 一条登记的 op（list 只列当前打开的文档），而「这门文档还在窗口里」
 * 正是我们决定要不要关它的唯一依据 —— 开着就不关，不必知道它登记成了什么名字。
 * 查询失败不抛：清扫是尽力而为，失败只意味着这一轮不动它。
 */
async function sessionDocStillOpen(entry) {
  const title = entry?.title
  if (!title) return null
  try {
    const listing = await callBridge('list', {})
    const documents = Array.isArray(listing?.documents) ? listing.documents : null
    if (!documents) return null
    return documents.some((doc) => String(doc?.title ?? '').toLowerCase() === String(title).toLowerCase())
  } catch {
    return null
  }
}

/**
 * 收掉本会话换下来的旧文档。只动账本里记的 id —— 用户自己打开的文档不在其中。
 *
 * 每条独立成败：某个旧文档关不掉（用户正盯着它、有模态框挡着）不能让这次 build
 * 失败，也不能让后面的条目跟着不关，所以失败只记错误码交调用方写进 changes。
 * 返回空数组也照常返回，调用方据此如实报告「这次换 id 有没有前账要还」。
 */
async function sweepOtherDesigns(currentId) {
  if (!SESSION_SWEEP) return []
  const expired = expireSessionDocs(Date.now())
  if (expired.length > 0) {
    writeEvent({
      level: 'warn',
      tool: 'session-sweep',
      message: '会话文档账本条目超过 TTL，移出不再回收',
      expired,
      ttlMs: SESSION_SWEEP_TTL_MS,
    })
  }
  const limit = Number.isFinite(SESSION_SWEEP_MAX) ? Math.max(0, SESSION_SWEEP_MAX) : 8
  const swept = []
  // 先快照再动 Map：失败项要 delete+set 挪到队尾，边走边挪会让同一条被扫两遍。
  // 快照不违背 FIFO —— 条目顺序就是插入顺序，本次没轮到的留在账上下回接着收。
  const pending = [...sessionDocs.entries()]
  for (const [designId, entry] of pending) {
    if (swept.length >= limit) break
    if (designId === currentId || inFlightDesigns.has(designId)) continue
    // 取快照之后可能已被并发的另一轮清扫销账或替换：别重复处理、也别复活。
    if (sessionDocs.get(designId) !== entry) continue
    // 退避未到：这条上次没关掉，等 nextRetryAt 再试，名额让给后面排队的。
    if (Number(entry?.nextRetryAt ?? 0) > Date.now()) continue
    // D3 红线：别的 designId 的文档不是「前账」，是这个会话里另一个活的件。
    // 旧版把账本里所有「别家 id」都当旧账收（调用点 :5319 的注释写的是
    // 「收掉本服务建过、还没存盘、换过 id 的文档」—— 只有换 id 重建才算），
    // 于是同一会话连续 build A、B 时，B 的清扫把 A 的窗口关掉，A 从此
    // DOC_NOT_OPEN。现在只有「这条账的文档已经不在窗口里了」才销账：
    // 还在开的文档一律不动，哪怕它属于别的 designId。
    if (currentId && designId !== currentId) {
      const stillOpen = await sessionDocStillOpen(entry)
      if (stillOpen !== false) continue
    }
    try {
      const result = await callBridge('cleanup', { designId })
      const closed = Array.isArray(result?.closed) ? result.closed : []
      if (closed.length > 0) {
        sessionDocs.delete(designId)
        swept.push({ designId, closed })
        continue
      }
      // cleanup 只关桥接器 registry 里「来源明确是 build/create」的登记项；create 建的
      // 文档现在同样进 registry（RegisterCreated），所以 closed:[] 意味着「这条 designId
      // 没有可收的登记项」或「登记项来源不明被跳过（skippedUnknown）」，按标题 close 兜底
      // 仍然必要。明确允许丢弃脏状态 —— 这些是本会话自己的中间产物，不是用户手做的活。
      if (entry?.title) {
        const byTitle = await callBridge('close', { title: entry.title, allowDirty: true })
        if (byTitle?.found) {
          sessionDocs.delete(designId)
          swept.push({ designId, closed: [entry.title] })
          continue
        }
      }
      deferSessionDoc(designId, entry)
      swept.push({ designId, closed: [], error: 'NOT_CLOSED' })
    } catch (error) {
      deferSessionDoc(designId, entry)
      swept.push({ designId, closed: [], error: error?.code ?? 'SWEEP_FAILED' })
    }
  }
  return swept
}

// ------------------------------------------------------------------ catalog

/**
 * 能力目录是懒加载的：第一次访问才去问桥接器要 interop 索引和插件注册表，
 * 之后从 data/catalog/index.json 读。
 *
 * 为什么要这张表：首版把「我们没包装」当成了「做不到」，模型于是停在
 * UNKNOWN_FEATURE_KIND 上不动。目录把「本机能做什么、怎么调、有没有验过」
 * 变成可查询的数据，interop 那一段还给出通往任意 API 的调用路径。
 */
/** 目录里的 execute 是拆分前写死的工具名（例如 model action=invoke）。
 *  分层之后真正该调的是 advanced_api，这里按分层表改写，别把调用方指到错的工具上。 */
/** 拆分前存在、现在已没有对应 action 的历史操作。目录不能继续把调用方指向
 *  `model action=sketch` / `model action=feature` 这种不存在的签名 —— 那会让模型
 *  在 catalog 里查到「怎么调」，然后撞一个 BAD_ARGUMENT。这里统一改写成当前真
 *  入口，并把原键保留在 legacyAction 里，方便追溯是哪条历史记录。 */
const LEGACY_EXECUTE = {
  'model.sketch': { tool: 'model', action: 'build', via: 'definition' },
  'model.feature': { tool: 'model', action: 'build', via: 'definition' },
  'model.assembly': { tool: 'assembly', action: 'assemble' },
  'model.drawing': { tool: 'drawing', action: 'drawing' },
  'model.componentRotate': { tool: 'assembly', action: 'componentRotate' },
  'model.kinds': { tool: 'advanced_api', action: 'kinds' },
  'capture.view': { tool: 'capture', args: { views: ['iso', 'front', 'top'] } },
  'select.ray': { tool: 'select', action: 'select', args: { mode: 'byRay' } },
  'select.highlight': { tool: 'capture', args: { highlight: ['<persistentId>'] } },
  'deliver.export': { tool: 'deliver', args: { kind: 'step' } },
  'deliver.sldprt': { tool: 'deliver', args: { kind: 'sldprt' } },
  'inspect.tree': { tool: 'inspect', action: 'model', args: { format: 'tree' } },
  'inspect.assembly': { tool: 'assembly_inspect', action: 'assembly' },
}

function executeHow(execute) {
  if (!execute || typeof execute.tool !== 'string') return null
  let how = execute.action ? `${execute.tool} action=${execute.action}` : execute.tool
  if (execute.via === 'definition') how += '（写进 definition，不是独立 action）'
  if (execute.args && typeof execute.args === 'object') {
    const parts = Object.entries(execute.args).slice(0, 4)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    if (parts.length > 0) how += '（' + parts.join('，') + '）'
  }
  return how
}

function mapEntryToolFace(entry) {
  const tool = entry?.execute?.tool
  const action = entry?.execute?.action
  if (typeof tool !== 'string') return entry
  const key = typeof action === 'string' ? `${tool}.${action}` : tool
  const legacy = LEGACY_EXECUTE[key]
  if (legacy !== undefined) {
    return {
      ...entry,
      execute: { ...legacy, legacy: { tool, action: action ?? null } },
      legacyAction: key,
      schemaNote: '该条 schema 是历史操作参数，不是当前工具签名；按 how 调当前工具，参数以 tools/list 为准',
    }
  }
  if (typeof action !== 'string') return entry
  if (!Object.hasOwn(TOOL_SPLITS, tool)) return entry
  const owner = actionOwner(tool, action)
  if (owner === null || owner === tool) return entry
  return { ...entry, execute: { ...entry.execute, tool: owner, legacyTool: tool } }
}

/** search 的结果直接带上「怎么调、要哪些参数、示例长什么样」。
 *  以前只回 brief（id/标题），模型还得再查一次 detail 才知道参数名。 */
function describeForCall(rawEntry) {
  const entry = mapEntryToolFace(rawEntry)
  const props = entry.schema?.properties ?? null
  const activation = entry.execute ? activationStateOf(entry.execute.tool) : { activation_required: false }
  // 激活前只回能力摘要：参数与示例要等那一组工具真的注册进来才给，
  // 否则模型会以为「文档里有 = 现在能调」，然后撞一个未注册的工具名。
  if (activation.activation_required === true) {
    return {
      id: entry.id,
      title: entry.title,
      status: entry.status,
      summary: String(entry.summary ?? '').slice(0, 200),
      how: executeHow(entry.execute) ?? entry.take ?? null,
      activation_required: true,
      capability: activation.capability,
      activate: { tool: 'catalog', args: { action: 'activate', capability: activation.capability } },
      note: '先 catalog action="activate" 打开这一组，下一轮再取这里的参数与示例',
    }
  }
  return {
    id: entry.id,
    title: entry.title,
    status: entry.status,
    summary: String(entry.summary ?? '').slice(0, 200),
    how: entry.execute ? executeHow(entry.execute) : (entry.take ?? null),
    ...(entry.legacyAction ? { legacyAction: entry.legacyAction } : {}),
    ...(entry.schemaNote ? { schemaNote: entry.schemaNote } : {}),
    required: entry.schema?.required ?? null,
    params: props
      ? Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v?.description ?? v?.type ?? '']))
      : null,
    example: Array.isArray(entry.examples) && entry.examples.length > 0 ? entry.examples[0] : null,
  }
}
let catalogCache = null

async function getCatalog(force = false) {
  if (catalogCache && !force) return { ...catalogCache, fromCache: true }
  const built = await buildCatalog({
    callBridge,
    repoRoot: root,
    cacheFile: CATALOG_FILE,
    force,
  })
  catalogCache = built
  return built
}

server.registerTool(
  'catalog',
  {
    title: '能力目录',
    description: DESCRIPTIONS.catalog,
    inputSchema: z.object({
      action: z.enum(['list', 'search', 'detail', 'sources', 'probe', 'export', 'activate', 'focus', 'active', 'deactivate'])
        .default('list')
        .describe('要做什么：list/search/detail/sources/probe/export 查目录；activate/deactivate 管理按需工具；focus 按任务一次配好工具+技能+规则'),
      mode: z.enum(['part', 'modify', 'assembly', 'motion']).optional()
        .describe('focus：任务模式。part 建模 / modify 改型 / assembly 装配 / motion 可动验证'),
      capability: z.string().optional()
        .describe('activate/deactivate 的按需工具名：assembly / advanced_api / assembly_inspect / qa / '
          + 'workspace_ops / analysis / calculate / select / job / task / datum（drawing/constraints/model/inspect/workspace/capture/deliver 是核心，无需激活）'),
      q: z.string().optional().describe('关键词：子系统、功能名、接口名，中英文都可以'),
      query: z.string().optional().describe('q 的别名；两个都给时以 q 为准'),
      source: z.enum(['solidworks-native', 'local-resource', 'external', 'addin', 'interop']).optional()
        .describe('按来源过滤'),
      status: z.enum(['available', 'unverified', 'blocked', 'missing', 'absent', 'registry-only', 'registry']).optional()
        .describe('按状态过滤：available 已实测可用，unverified 接口在但没跑通，missing 当前工具面没有入口'),
      category: z.string().optional().describe('按分类过滤，如 "原生能力"、"模板"、"插件"'),
      kind: z.enum(['native-op', 'interop-member', 'addin', 'local-resource', 'external']).optional()
        .describe('按条目类型过滤'),
      id: z.string().optional().describe('detail 需要的条目 id，如 "feature.extrude"'),
      what: z.enum(['addins', 'interop']).optional().describe('probe 探什么'),
      offset: z.number().int().min(0).default(0).describe('分页起点'),
      limit: z.number().int().min(1).max(200).default(25).describe('每页条数'),
      refresh: z.boolean().default(false).describe('丢弃缓存重新采集'),
    }),
  },
  async (args) => {
    try {
      switch (args.action) {
        // ---- 真实动态披露：注册进 McpServer 才会出现在 tools/list 里 ----
        case 'activate': {
          const outcome = activateCapability(args.capability)
          if (outcome.error) return failed({ op: 'catalog.activate', designId: null, error: outcome.error })
          const capabilityName = String(args.capability ?? '').trim()
          const brief = CAPABILITY_BRIEFS[capabilityName] ?? null
          return ok(
            envelope({
              summary: outcome.alreadyActive
                ? `${capabilityName} 已经激活（重复激活不报错）`
                : `已激活 ${capabilityName}；下一轮工具面可见`,
              designId: null,
              changes: {
                status: outcome.alreadyActive ? 'already-active' : 'ok',
                activated: outcome.activated ?? [capabilityName],
                tools: outcome.tools ?? [],
                active: [...activatedCapabilities],
                activation: brief,
                note: '下一轮工具面可见',
              },
              nextActions: [
                ...(brief ? [
                  `解锁：${brief.unlocks.join('、')}；第一步：${brief.firstStep}`,
                  ...(brief.requires?.length ? [`前置：${brief.requires.join('；')}`] : []),
                  ...(brief.pitfalls?.length ? [`坑：${brief.pitfalls.join('；')}`] : []),
                  `预算：${brief.budget}；退出：${brief.exit}`,
                ] : []),
                `下一轮直接调用 ${capabilityName}({...})（本轮 tools/list 已更新）`,
              ],
            }),
          )
        }

        case 'focus': {
          // 任务模式：一次把「该挂的工具 + 该读的技能 + 该守的规则」给全。
          // 不是新工具，只是 activate/deactivate 的组合；切错随时再切回来。
          const FOCUS_MODES = {
            part: {
              tools: [],
              skills: ['skills/native-workflows/SKILL.md', 'skills/sw-parametric/SKILL.md'],
              rules: [
                'plan → build → 语义验收 → deliver；改尺寸优先 edit，不整件重建',
                '草图默认 precision="relations"，弧用真实弧，不用折线近似',
                '未标注尺寸写进 assumptions，交付时标出，不停在提问上',
              ],
            },
            modify: {
              tools: ['qa'],
              skills: ['skills/native-workflows/SKILL.md', 'skills/sw-parametric/SKILL.md', 'skills/sw-troubleshooting/SKILL.md'],
              rules: [
                '只改已登记的参数（dimensionBindings）；改完 rebuild 并重新验收',
                'edit 走不通才 build；重建前先确认下游配合是否依赖旧的面 id',
              ],
            },
            assembly: {
              tools: ['assembly', 'assembly_inspect'],
              skills: ['skills/native-workflows/SKILL.md', 'skills/sw-parametric/SKILL.md'],
              rules: [
                '先 assemblyFaces 拿面 id 与轴线（圆柱面带 axis），再 mate；两端必须属于不同零件',
                '配合后用 mates 按两端零件名核对，再 drive 验证自由度',
                '插入默认按包围盒中心；要按零件原点就显式 placement:"origin"',
              ],
            },
            motion: {
              tools: ['assembly', 'assembly_inspect'],
              skills: ['skills/native-workflows/SKILL.md', 'skills/sw-troubleshooting/SKILL.md'],
              rules: [
                'drive 是脚本驱动（mode:"scripted"），不是 Motion 算例：只认回读的实际转角',
                '验收写成「主动件转 X°，从动件同向 X°±0.1°」，回零后再测摆动',
                '没跟随的组件要报出来，不能拿 status:"ok" 当通过',
              ],
            },
          }
          // 每种模式的标准路径与调用预算：回答「理论几次做完」，也给模型一个
          // 自我约束的锚点（审计基线 88 次/会话，绝大多数花在侦察与返工）。
          const FOCUS_PLAN = {
            part: { path: ['plan', 'build', 'inspect verify', 'deliver'], budget: 4 },
            modify: { path: ['edit', 'deliver'], budget: 2 },
            assembly: { path: ['assemble', 'assemblyFaces', 'mate', 'drive', 'deliver'], budget: 6 },
            motion: { path: ['drive', 'drive 回零', 'deliver'], budget: 3 },
          }
          const mode = typeof args.mode === 'string' ? args.mode.trim() : ''
          const spec = FOCUS_MODES[mode]
          if (!spec) {
            return failed({
              op: 'catalog.focus', designId: null,
              error: fail('BAD_ARGUMENT', `mode 必须是 ${Object.keys(FOCUS_MODES).join(' / ')} 之一`, { given: mode || null }),
            })
          }
          const keep = new Set(spec.tools)
          const deactivated = []
          for (const name of [...activatedCapabilities]) {
            if (keep.has(name)) continue
            const out = deactivateCapability(name)
            if (Array.isArray(out?.deactivated)) deactivated.push(...out.deactivated)
          }
          const activated = []
          for (const name of spec.tools) {
            const out = activateCapability(name)
            if (out?.error) return failed({ op: 'catalog.focus', designId: null, error: out.error })
            if (out?.alreadyActive !== true) activated.push(...(out?.activated ?? [name]))
          }
          return ok(
            envelope({
              summary: `已切到 ${mode} 模式：${spec.tools.length ? spec.tools.join(' + ') : '核心工具'}`,
              designId: null,
              changes: {
                mode,
                activated,
                deactivated,
                active: [...activatedCapabilities],
                skills: spec.skills,
                rules: spec.rules,
                plan: FOCUS_PLAN[mode].path,
                budget: FOCUS_PLAN[mode].budget,
                // 每个工具的 action 是按组注册的：没激活的组连 action 都不在 schema 里，
                // 于是建模会话会以为「inspect 只有 6 个动作、没有 verify」。把本会话
                // 现在真正可调的动作与「激活哪个能力才有」一起写清楚，比让调用方去猜
                // 一个不存在的 action 便宜得多。
                toolFace: toolFaceReport([...activatedCapabilities]),
              },
              nextActions: [
                `需要细节时按需读：${spec.skills.join('、')}`,
                inactiveFaceHint([...activatedCapabilities]),
              ].filter(Boolean),
            }),
          )
        }
        case 'active': {
          return ok(
            envelope({
              summary: `当前已激活 ${activatedCapabilities.size} 组按需工具`,
              designId: null,
              changes: {
                active: [...activatedCapabilities],
                core: coreToolNames(),
                onDemand: onDemandCapabilities(),
                toolFace: toolFaceReport([...activatedCapabilities]),
              },
              nextActions: activatedCapabilities.size === 0
                ? ['需要装配/工程图/验收/运维/分析时：catalog action="activate" capability="<工具名>"']
                : [],
            }),
          )
        }

        case 'deactivate': {
          const outcome = deactivateCapability(args.capability)
          if (outcome.error) return failed({ op: 'catalog.deactivate', designId: null, error: outcome.error })
          if (outcome.unsupported === true) {
            return ok(
              envelope({
                summary: `不支持停用 ${args.capability}：${outcome.note}`,
                designId: null,
                status: 'failed',
                changes: { status: 'unsupported', active: [...activatedCapabilities] },
                nextActions: ['重启会话即回到默认工具面（核心常驻 + 按需激活）'],
              }),
            )
          }
          return ok(
            envelope({
              summary: `已停用 ${args.capability}`,
              designId: null,
              changes: {
                status: 'ok',
                deactivated: outcome.deactivated ?? [],
                active: [...activatedCapabilities],
              },
            }),
          )
        }

        case 'sources': {
          const catalog = await getCatalog(args.refresh)
          return ok(
            envelope({
              summary: `能力目录共 ${catalog.entries.length} 条，来自 ${Object.keys(catalog.counts).length} 个来源`,
              designId: null,
              changes: {
                builtAt: catalog.builtAt,
                fromCache: !!catalog.fromCache,
                total: catalog.entries.length,
                counts: catalog.counts,
                sources: SOURCES.map((s) => ({ ...s, count: catalog.counts[s.id] ?? 0 })),
                interop: catalog.interop,
                addins: catalog.addins,
                errors: catalog.errors,
              },
            }),
          )
        }

        case 'detail': {
          if (!args.id) {
            return failed({ op: 'catalog.detail', designId: null, error: fail('BAD_ARGUMENT', 'detail 需要 id') })
          }
          const catalog = await getCatalog(args.refresh)
          const found = findEntry(catalog.entries, args.id)
          const entry = found ? mapEntryToolFace(found) : found
          if (!entry) {
            const near = searchCatalog(catalog.entries, { q: args.id.split(/[.:]/).pop() ?? args.id }).slice(0, 5)
            return failed({
              op: 'catalog.detail',
              designId: null,
              error: fail('NOT_FOUND', `目录里没有 ${args.id}`, { suggestions: near.map(brief) }),
            })
          }

          // 接口条目自带 schema 没意义，真正的参数表在 interop 元数据里。
          let members = null
          if (entry.kind === 'interop-member') {
            try {
              const iface = entry.id.slice('interop:'.length)
              const detail = await callBridge('interopIndex', { mode: 'iface', iface })
              members = {
                iface: detail.iface,
                memberCount: detail.memberCount,
                members: (detail.members ?? []).slice(0, 80),
                truncated: (detail.members ?? []).length > 80,
              }
            } catch (error) {
              members = { error: error.code ?? String(error.message) }
            }
          }

          // 激活门槛同样管 detail：完整参数 schema / 示例 / 实时成员签名只在
          // 那一组工具真的注册进来之后才给，否则等于教模型去调一个不存在的工具。
          const activation = entry.execute ? activationStateOf(entry.execute.tool) : { activation_required: false }
          if (activation.activation_required === true) {
            const summary = {
              id: entry.id,
              title: entry.title,
              status: entry.status,
              kind: entry.kind,
              summary: String(entry.summary ?? '').slice(0, 300),
              how: executeHow(entry.execute) ?? entry.take ?? null,
              activation_required: true,
              capability: activation.capability,
            }
            return ok(
              envelope({
                summary: `${entry.id}：需要先激活 ${activation.capability}`,
                designId: null,
                changes: { entry: summary },
                nextActions: [
                  `先 catalog action="activate" capability="${activation.capability}"`,
                  '下一轮再 catalog action="detail" 取完整参数、示例与验证证据',
                ],
              }),
            )
          }

          return ok(
            envelope({
              summary: `${entry.id}：${entry.title}`,
              designId: null,
              changes: { entry, ...(members ? { members } : {}), activation_required: false },
              nextActions: entry.execute
                ? [`用 ${executeHow(entry.execute)} 执行`]
                : [],
            }),
          )
        }

        case 'probe': {
          const what = args.what ?? 'addins'
          if (what === 'addins') {
            const result = await callBridge('addins', { probe: true })
            const callable = (result.results ?? []).filter((r) => r.status === 'callable')
            return ok(
              envelope({
                summary: `探了 ${result.count} 个插件，${callable.length} 个可直接调用`,
                designId: null,
                status: result.probed ? 'ok' : 'unavailable',
                changes: result,
                nextActions: result.probed
                  ? []
                  : ['先打开 SOLIDWORKS，再重试 catalog action=probe'],
              }),
            )
          }
          const summary = await callBridge('interopIndex', { mode: 'summary' })
          return ok(
            envelope({
              summary: `interop ${summary.interopVersion}：${summary.sldworksTypes} 个类型`,
              designId: null,
              changes: summary,
            }),
          )
        }

        case 'export': {
          const catalog = await getCatalog(args.refresh)
          const path = join(DATA_DIR, 'catalog', `export-${Date.now()}.json`)
          writeFileSync(path, JSON.stringify(catalog, null, 2), 'utf8')
          return ok(
            envelope({
              summary: `目录已导出到 ${path}`,
              designId: null,
              artifacts: [{ kind: 'json', path, bytes: JSON.stringify(catalog).length }],
            }),
          )
        }

        case 'search':
        case 'list':
        default: {
          const catalog = await getCatalog(args.refresh)
          // q 与 query 都收：调用方按自然语言写 query 时不该被判成「没给关键词」。
          const keyword = args.q ?? args.query
          if (args.action === 'search' && !keyword) {
            return failed({ op: 'catalog.search', designId: null, error: fail('BAD_ARGUMENT', 'search 需要 q（或 query）') })
          }
          const matched = searchCatalog(catalog.entries, {
            q: keyword,
            source: args.source,
            status: args.status,
            category: args.category,
            kind: args.kind,
          })
          const page = pageOf(matched, { offset: args.offset, limit: args.limit })
          return ok(
            envelope({
              summary: keyword
                ? `"${keyword}" 命中 ${page.total} 条，本页 ${page.returned} 条`
                : `目录共 ${page.total} 条，本页 ${page.returned} 条`,
              designId: null,
              changes: {
                ...page,
                items: args.action === "search" ? page.items.slice(0, 10).map(describeForCall) : page.items.map(brief),
                counts: catalog.counts,
                builtAt: catalog.builtAt,
                fromCache: !!catalog.fromCache,
              },
              nextActions: page.nextOffset !== null
                ? [`继续翻页：catalog action=list offset=${page.nextOffset} limit=${page.limit}`]
                : ['用 catalog action=detail id=<条目 id> 看完整定义'],
            }),
          )
        }
      }
    } catch (error) {
      return failed({ op: `catalog.${args.action}`, designId: null, error })
    }
  },
)

// ------------------------------------------------------------------ model

/**
 * 建模入口。M1 只接通了「反射调用」与「重建/撤销」这三条，M3 会把草图、特征、
 * 装配、工程图补进来。
 *
 * 为什么先做 invoke：上一版遇到没包装的功能只能停住。有了它，任何 SOLIDWORKS
 * API 都能当场试，参数对不对由 interop 的签名决定，不由我们的封装决定。
 */
// ---------------------------------------------------------------------------
// invoke 的单位与后果
//
// SOLIDWORKS 的 API 一律用**米**，而模型和图纸讨论的是毫米。实测一次会话里，
// SelectByID2 的坐标按毫米写（2.5 / 20），什么都没选中，返回的仍是 true，
// 后面的特征建在空选集上，报错却指向别处。
//
// 两条补丁：① 允许 units:"mm"，只对已知是长度的参数位置做换算（不碰角度/枚举）；
// ② 选择类调用之后回读选中数量，为 0 就直说。
// ---------------------------------------------------------------------------

async function readSelectionCount(callBridge) {
  try {
    const listed = await callBridge('select', { mode: 'list' })
    // 桥接器把结果放在 selection 里（{count, items}），不是顶层。
    if (typeof listed?.count === 'number') return listed.count
    if (typeof listed?.selection?.count === 'number') return listed.selection.count
    if (Array.isArray(listed?.selection?.items)) return listed.selection.items.length
    if (Array.isArray(listed?.items)) return listed.items.length
    return null
  } catch {
    return null
  }
}

const BATCH_INVOKE_EXAMPLE = { op: 'invoke', args: { target: 'activeDoc', member: 'GetTitle', args: [] } }

function modelBatchArgumentError(ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return fail('BAD_ARGUMENT', 'batch 需要非空 ops 数组', { example: { ops: [BATCH_INVOKE_EXAMPLE] } })
  }
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  for (const [index, step] of ops.entries()) {
    const invalid = (field, hint) => fail('BAD_ARGUMENT', `ops[${index}]${field} ${hint}。示例 ${JSON.stringify(BATCH_INVOKE_EXAMPLE)}`, {
      index, field: `ops[${index}]${field}`, example: BATCH_INVOKE_EXAMPLE,
    })
    if (!isObject(step)) return invalid('', '必须是操作对象')
    if (typeof step.op !== 'string' || !step.op.trim()) return invalid('.op', '必须是非空操作名')
    if (step.op === 'batch') return invalid('.op', '请把嵌套批次中的操作展开到当前 ops 数组')
    if (step.args !== undefined && !isObject(step.args)) return invalid('.args', '必须是参数对象；invoke 的位置参数数组写在该对象的 args 字段中')
    if (Object.keys(step).some((key) => key !== 'op' && key !== 'args')) return invalid('', '操作参数必须写在当前步骤的 args 对象内')
    const fields = Object.keys(step.args ?? {})
    if (fields.some((key) => key.toLowerCase() === 'op')) return invalid('.args', '请把操作名写在当前步骤的 op 字段中')
    if (step.op === 'invoke') {
      const params = step.args ?? {}
      if (typeof params.member !== 'string' || !params.member.trim()) return invalid('.args.member', '必须是非空成员名')
      if (params.args !== undefined && !Array.isArray(params.args)) return invalid('.args.args', '必须是按签名顺序排列的位置参数数组')
    }
  }
  return null
}

server.registerTool(
  'model',
  {
    title: '操作模型',
    description: DESCRIPTIONS.model,
    inputSchema: z.object({
      action: z.enum(['create', 'build', 'edit', 'invoke', 'object', 'batch', 'pattern', 'diff', 'kinds', 'rebuild', 'undo', 'assemble', 'mate', 'mateDelete', 'mateLock', 'componentLock', 'componentRotate', 'componentTranslate', 'drawing', 'plan', 'feature', 'helix', 'sweep', 'loft']).default('invoke').describe('要做什么'),
      definition: z.any().optional().describe('build/plan 用的设计定义（schemaVersion 3）。传对象；也接受以 { 开头的 JSON 字符串（服务会先 JSON.parse，解析失败才按原样报错）'),
      output: z.enum(['part', 'sketch']).default('part').describe('build 的产出：part=实体零件（默认）；sketch=只建草图，不拉伸、不用体积判成败'),
      precision: z.enum(['relations', 'coordinate']).default('relations').describe('草图精度：relations（默认，必须有几何关系）或 coordinate（只画坐标草稿，永远 ready:false）'),
      assumptions: z.array(z.any()).optional().describe('plan/build 的未标注尺寸假设（字符串或 {name,value,reason}）；未确认的假设会挡住 build'),
      acceptedAssumptions: z.array(z.any()).optional().describe('用户已经明确确认过的假设名；只有列在这里的假设才允许 build'),
      dimensions: z.array(z.object({}).passthrough()).optional().describe('plan 的图纸标注尺寸（name/type/value/refs/unit），像素尺寸会被拒绝'),
      allowOpen: z.boolean().optional().describe('plan：允许开口轮廓（默认 false，草图轮廓必须闭合）'),
      requireDimensions: z.boolean().optional().describe('plan：要求至少有一个标注尺寸'),
      parameters: z.record(z.string(), z.number()).optional().describe('edit 要改的参数'),
      changes: z.record(z.string(), z.number()).optional()
        .describe('edit 的参数补丁（parameters 的别名，接受 params.x 写法）：程序负责翻成原生尺寸或重建，模型不碰草图'),
      recompile: z.boolean().optional()
        .describe('edit：CAD 文件被外部改过时仍按 design.json 重编（默认拒绝并报 CAD_DRIFT）'),
      revert: z.boolean().optional().describe('edit 时按项目记录的设计定义重建'),
      template: z.string().optional().describe('create 用的零件模板路径'),
      designId: designIdArg,
      target: z.enum(['app', 'doc', 'activeDoc', 'partDoc', 'assemblyDoc', 'drawingDoc', 'featureManager',
        'sketchManager', 'extension', 'selectionManager', 'modelView', 'mathUtility', 'dimension'])
        .default('doc')
        .describe('invoke 在哪个对象上调用。**doc 由 designId 决定是哪份文档**（解析不到就 DOC_NOT_OPEN，'
          + '绝不退回前台那份）；要显式操作 SOLIDWORKS 前台当前文档，写 activeDoc —— '
          + '旧实现把 doc 当成了「前台活动文档」，于是带着 designId 的调用命中了历史遗留的旧零件，'
          + '尺寸被静默降级成参考尺寸。dimension 取上次构建记录的原生尺寸（需 designId+param）'),
      iface: z.string().optional().describe('接口全名，如 IFeatureManager；省略时按目标对象的实际类型找'),
      member: z.string().optional().describe('成员名，如 FeatureExtrusion3'),
      handle: z.string().optional().describe('object：invoke 返回的 obj_N 句柄'),
      param: z.string().optional().describe('object target="dimension"：参数名，取上次构建记录的原生尺寸'),
      objectAction: z.enum(['get', 'set', 'call', 'release', 'list', 'clear', 'target']).default('get')
        .describe('object：读属性/写属性/调方法/释放/列句柄/清空/把命名目标变成句柄'),
      value: z.any().optional().describe('object set：要写入的属性值'),
      index: z.number().int().min(0).optional().describe('object get：数组句柄上的元素下标'),
      ops: z.array(z.unknown()).optional()
        .describe('batch：按顺序执行 {op, args:{...}}。invoke 示例 ' + JSON.stringify(BATCH_INVOKE_EXAMPLE)),
      stopOnError: z.boolean().default(true).describe('batch：某步失败后是否停止后续步骤'),
      feature: z.string().optional().describe('pattern：要阵列的特征名（build 返回的 features[].name）'),
      featureIndex: z.number().int().min(0).optional().describe('pattern：按特征树序号选特征，feature 省略时用'),
      count: z.number().int().min(2).optional().describe('pattern：阵列总数（含种子特征）'),
      angleDeg: z.number().optional().describe('pattern：整圈角度，默认 360'),
      axisPlanes: z.array(z.number().int().min(0)).max(2).optional()
        .describe('pattern：用这两个基准面（序号）的交线作轴；默认 [1,2]'),
      flip: z.boolean().optional().describe('pattern：反向'),
      // ---- helix / sweep / loft（单特征动作，作用在已打开的 designId 文档上） ----
      featureKind: z.enum(['helix', 'sweep', 'sweptCut', 'loft', 'loftedCut']).optional()
        .describe('feature 动作要建哪种特征；helix/sweep/loft 动作省略时由动作名决定'),
      profile: z.string().optional().describe('轮廓草图特征名（sweep=轮廓；helix=底圆草图；loft=单截面兜底）'),
      path: z.string().optional().describe('扫掠路径特征名（螺旋线或草图）'),
      guides: z.array(z.string()).optional().describe('引导线特征名列表'),
      sections: z.array(z.string()).optional().describe('放样截面特征名，按顺序给（最少 2 个）'),
      definedBy: z.enum(['heightAndPitch', 'pitchAndRevolution', 'heightAndRevolution', 'spiral']).optional()
        .describe('螺旋线定义方式，默认 heightAndPitch（蜗杆用这个：height + pitch）'),
      height: z.number().optional().describe('螺旋线高度 mm（definedBy 含 height 时生效）'),
      pitch: z.number().optional().describe('螺旋线螺距 mm（单头时等于导程；Ø14 m1 蜗杆 = π·m = 3.141592）'),
      revolutions: z.number().optional().describe('螺旋线圈数（definedBy 含 revolution 时生效）'),
      reversed: z.boolean().optional().describe('螺旋线反向（改变沿轴的推进方向）'),
      clockwise: z.boolean().optional().describe('螺旋线旋向；右旋螺纹与 +Z 推进组合决定手性，量完 measure kind="helix" 的 hand 再定'),
      tapered: z.boolean().optional().describe('螺旋线是否带锥度；spiral 定义不许锥度（会报 INVALID_ARGUMENT）'),
      outward: z.boolean().optional().describe('螺旋线向外'),
      taperAngle: z.number().optional().describe('锥度角，度'),
      startAngle: z.number().optional().describe('起始角，度'),
      cut: z.boolean().optional().describe('sweep/loft 是否切除（sweptCut/loftedCut 动作恒为切除）'),
      thin: z.boolean().optional().describe('薄壁扫掠/放样'),
      thickness: z.number().optional().describe('薄壁厚度 mm（thin=true 时必填）'),
      thickness2: z.number().optional().describe('薄壁第二方向厚度 mm（thinType="twoDirection" 时必填）'),
      thinType: z.enum(['oneDirection', 'oppDirection', 'midPlane', 'twoDirection']).optional()
        .describe('薄壁方向，默认 oneDirection'),
      twist: z.number().optional().describe('扭转角，度（twistControl 为 constantTwist/normalConstantTwist 时生效）'),
      twistControl: z.enum(['followPath', 'keepNormalConstant', 'followPathFirstGuideCurve', 'followFirstSecondGuideCurves', 'constantTwist', 'normalConstantTwist'])
        .optional().describe('扫掠扭转控制，默认 followPath'),
      startMatch: z.enum(['none', 'coincident', 'tangent']).optional().describe('扫掠/放样起点约束，默认 none'),
      endMatch: z.enum(['none', 'coincident', 'tangent']).optional().describe('扫掠/放样终点约束，默认 none'),
      propagate: z.boolean().optional().describe('扫掠：与相邻面合并（默认 true）'),
      alignment: z.boolean().optional().describe('扫掠：与路径对齐（默认 true）'),
      advancedSmoothing: z.boolean().optional().describe('高级光顺，默认 true'),
      merge: z.boolean().optional().describe('与已有实体合并，默认 true'),
      circularProfile: z.boolean().optional().describe('扫掠用圆截面（轮廓草图可省，半径按 circularDiameter/2）'),
      circularDiameter: z.number().optional().describe('圆截面直径 mm（circularProfile=true 时必填）'),
      reverseDirection: z.boolean().optional().describe('扫掠反向'),
      mode: z.enum(['boss', 'cut', 'surface']).optional().describe('放样模式，默认 boss'),
      closed: z.boolean().optional().describe('放样是否闭合（首尾相接）'),
      keepTangency: z.boolean().optional().describe('放样保持相切'),
      tessTolerance: z.number().optional().describe('放样曲面公差，默认 1'),
      comparePath: z.string().optional().describe('diff：基准 STEP 的绝对路径（预期）；当前文档会先导出 STEP 再与它比较'),
      volumeToleranceMm3: z.number().min(0).optional().describe('diff：体积容差，默认 max(1, |V|*1e-4)'),
      lengthToleranceMm: z.number().min(0).optional().describe('diff：包围盒容差，单位 mm，默认 0.01'),
      args: z.array(z.any()).optional().describe('按签名顺序的参数；数字会按形参类型转换'),
      units: z.enum(['m', 'mm']).optional()
        .describe('invoke 的长度单位：SOLIDWORKS API 用米（m，默认）；传 "mm" 时只把已知是坐标的参数位置换算成米'),
      offset: z.number().int().min(0).optional().describe('kinds 分页起点'),
      limit: z.number().int().min(1).max(500).optional().describe('kinds 每页条数，默认 200'),
      steps: z.number().int().min(1).max(50).default(1)
        .describe('undo 的步数。**按特征步进，不是事务回滚**：一步就可能撤掉整组孔/切除，'
          + '撤之前先看回包的 baseline，撤之后看 volumeDelta / boundingBoxChanged 是不是你预期的'),
      mateFirst: z.string().optional().describe('mate：第一个面 id（inspect action="faces" 取得的 persistentId）。'
        + '**两端目前只接受面**——顶点/边/轴还不支持，选了别的会回 MATE_UNSUPPORTED'),
      mateSecond: z.string().optional().describe('mate：第二个面 id（同上；两面必须属于不同零件，同零件会 ERROR 或过定义）'),
      mateKind: z.enum(['coincident', 'concentric', 'distance', 'angle', 'gear']).optional()
        .describe('mate：配合类型。concentric=同心（两圆柱面，留转动自由度）；coincident=重合；distance 需要 mateDistance；angle=角度（补周向相位，不会过定义）；gear=齿轮/带轮耦合（两圆柱面或轴 + mateRatio）'),
      mateRatio: z.number().positive().optional()
        .describe('mate（gear）：传动比，1=1:1、2=第一件转 1 圈第二件转 2 圈；默认 1'),
      mateReverse: z.boolean().optional()
        .describe('mate（gear）：交换转向，默认 false'),
      solve: z.boolean().optional()
        .describe('componentRotate：true=按拖动路径施加旋转（齿轮/齿条等机械配合会跟着动）；默认 false 直接设变换'),
      drivePrimary: z.string().optional()
        .describe('drive：主轴组件名（角度按它给），如 "C06-01-1"'),
      driveRatios: z.record(z.string(), z.number()).optional()
        .describe('drive：组件名→相对主轴的传动比，如 {"A-1":1,"B-1":2}；主轴也要列'),
      driveAngleDeg: z.number().optional()
        .describe('drive：主轴转过的角度（度）；从动件按 driveRatios 比例分别设位姿'),
      mateDistance: z.number().optional().describe('mate：distance 配合的间距（mm）'),
      mateAngleDeg: z.number().optional()
        .describe('mate：angle 配合的角度（度）。同心已经管住 4 个自由度、只差周向相位的界面（轴↔轮芯、轮芯↔胎）用它补最后 1 个自由度，比再叠一条重合稳'),
      mateLockRotation: z.boolean().optional()
        .describe('mate：true=刚性同转（键/粘接界面：轴与轮芯、轮芯与轮胎）。只约束同轴不加它会打滑'),
      mateName: z.string().optional().describe('mateDelete：要删除的配合名（inspect action="mates" 取得）'),
      component: z.string().optional().describe('componentRotate/componentTranslate：装配组件名，如 "C06-01-1"（inspect action="assembly" 取得，注意 -1 后缀）'),
      frame: z.enum(['global', 'local']).default('global')
        .describe('componentRotate 的坐标系：global（默认）=轴 x/y/z 是装配坐标系轴；'
          + 'local=轴是**零件自身**坐标系的轴（同一组 x/y/z 参数在 local 下含义不同，回包 rotation 是换算到装配坐标后的 3×3）。'
          + 'x/y/z 旋转点始终是装配坐标（mm）。回包给 rotation(3×3 行主序) 与 pose{origin,axes}'),
      axis: z.enum(['x', 'y', 'z']).optional()
        .describe('componentRotate：绕哪根轴转，默认 z。轴的坐标含义由 frame 决定（global=装配轴；local=零件自身轴）'),
      x: z.number().optional().describe('componentRotate：旋转点 X（mm，装配坐标）。三个都不传时绕组件包围盒中心（回包 pivotSource 说明用了哪种）'),
      y: z.number().optional().describe('componentRotate：旋转点 Y（mm，装配坐标）'),
      z: z.number().optional().describe('componentRotate：旋转点 Z（mm，装配坐标）'),
      dx: z.number().optional().describe('componentTranslate：装配坐标 X 平移量（mm），正=+X。平移永远是装配坐标系，与 frame 无关'),
      dy: z.number().optional().describe('componentTranslate：装配坐标 Y 平移量（mm）'),
      dz: z.number().optional().describe('componentTranslate：装配坐标 Z 平移量（mm）'),
      unfix: z.boolean().optional().describe('componentTranslate：true=平移前先解除固定（固定件挪不动）'),
      refix: z.boolean().optional().describe('componentTranslate：true=平移后重新固定'),
      components: z.array(z.object({        path: z.string().describe('零件文件路径'),
        x: z.number().default(0),
        y: z.number().default(0),
        z: z.number().default(0),
        placement: z.string().default('bbox-center')
          .describe('assemble：落位口径。bbox-center（默认）=x/y/z 落在零件包围盒中心；origin=x/y/z 落在零件原点；'
            + 'datum:<name>=x/y/z 落在该零件 design.json 里登记的命名基准原点（名字用 datum action="create" 建，重开不变）。'
            + 'datum 只对齐基准原点，朝向要再 componentRotate frame="local" 校。坐标一律装配坐标 mm'),
      })).optional().describe('assemble：要插进装配体的零件与位置（mm）'),
      model: z.string().optional().describe('drawing：要出图的零件/装配体路径'),
      views: z.array(z.string()).optional().describe('drawing：视图名，如 ["*前视","*等轴测"]；默认 *前视'),
      outputPath: z.string().optional().describe('assemble/drawing 的存盘路径'),
      projection: z.enum(['first', 'third']).optional()
        .describe('drawing：投影法。first=第一角（俯视图在主视图下方、左视图在右方），third=第三角。'
          + '这会决定视图落在哪一侧，不是排版偏好'),
      force: z.enum(['manual']).optional()
        .describe('逃生口：仅在门禁不可达且用户已明确授权时传 "manual"；会写进 review/bypass.jsonl 留痕，正常交付不要用'),
      reason: z.string().optional().describe('配合 force:"manual"：一句话说明为什么绕门，写进 bypass.jsonl 留痕（先取得用户确认）'),
    }),
  },
  async (args) => {
    const started = Date.now()
    try {
      switch (args.action) {
        case 'create':
          return handlePartCreate(args)
        case 'plan':
          return handlePlan(args)
        case 'build':
          return handlePartBuild(args)
        case 'edit':
          return handlePartEdit(args)
        case 'rebuild': {
          const designId = requireDesignId(args.designId, { tool: 'model', action: 'rebuild' })
          const rebuilt = await callBridge('invoke', { target: 'doc', designId, member: 'EditRebuild3' })
          const geometry = await callBridge('inspect', { designId, format: 'geometry' })
          return ok(
            envelope({
              summary: `已重建；体积 ${geometry.volume?.toFixed?.(3) ?? geometry.volume} mm³`,
              designId,
              measurements: geometry,
              timings: { totalMs: Date.now() - started },
              extra: { call: rebuilt },
            }),
          )
        }
        case 'undo': {
          // SOLIDWORKS 的 undo 是**按特征步进**，不是事务回滚：撤 2 步会把
          // 中途加进来的孔/切除一起撤掉（实测体积 24280.7 → 实心板 43200），
          // redo 也救不回来。所以撤销前后都要量一次几何，把「撤掉了什么」如实
          // 摆出来，并留一份可以照着重建的基线。
          //
          // geometry 是**两层**嵌套的：
          //   桥接器 inspect 回 { document, geometry:{ kind,bodies,boundingBox,massProperties,... }, equations }
          //   其中 boundingBox 又是 { min, max, size, units }。
          // 以前这里读的是顶层 geometry.volume —— 那个字段根本不存在，于是摘要永远
          // 打印 "undefined mm³"，调用方没有任何办法看出撤销到底改了什么。
          const undoDesignId = resolveDesignId(args.designId)
          const readShape = (payload) => {
            const geometry = payload?.geometry ?? payload ?? null
            const volume = geometry?.massProperties?.volume
            const box = geometry?.boundingBox
            return {
              volume: Number.isFinite(volume) ? volume : null,
              boundingBox: Array.isArray(box?.size) ? box.size : (Array.isArray(box) ? box : null),
              bodies: Number.isFinite(geometry?.bodies) ? geometry.bodies : null,
              faces: Number.isFinite(geometry?.faces) ? geometry.faces : null,
            }
          }
          const before = readShape(await callBridge('inspect', { designId: undoDesignId, format: 'geometry' }))
          const undone = await callBridge('invoke', {
            target: 'doc',
            ...(undoDesignId ? { designId: undoDesignId } : {}),
            member: 'EditUndo2',
            args: [args.steps],
          })
          const geometry = await callBridge('inspect', { designId: undoDesignId, format: 'geometry' })
          const after = readShape(geometry)
          const delta = before.volume !== null && after.volume !== null
            ? after.volume - before.volume
            : null
          const boxChanged = before.boundingBox !== null && after.boundingBox !== null
            ? JSON.stringify(before.boundingBox) !== JSON.stringify(after.boundingBox)
            : null
          return ok(
            envelope({
              summary: `撤销 ${args.steps} 步；体积 ${after.volume === null ? '未量到' : after.volume} mm³`
                + (delta === null ? '' : `（变化 ${delta >= 0 ? '+' : ''}${delta} mm³）`)
                + (boxChanged === true ? '；包围盒变了' : boxChanged === false ? '；包围盒没变' : ''),
              designId: undoDesignId,
              measurements: { ...after, volumeBefore: before.volume, volumeAfter: after.volume, volumeDelta: delta },
              changes: {
                steps: args.steps,
                undoReturn: undone?.result ?? undone,
                volumeBefore: before.volume,
                volumeAfter: after.volume,
                volumeDelta: delta,
                boundingBoxBefore: before.boundingBox,
                boundingBoxAfter: after.boundingBox,
                boundingBoxChanged: boxChanged,
                bodiesBefore: before.bodies,
                bodiesAfter: after.bodies,
                facesBefore: before.faces,
                facesAfter: after.faces,
                // 一条能照着重建的基线：撤错了至少知道原来是什么样。
                baseline: { volume: before.volume, boundingBox: before.boundingBox, bodies: before.bodies },
              },
              timings: { totalMs: Date.now() - started },
              nextActions: [
                'undo 是按特征步进的破坏性操作：看完 volumeDelta / boundingBoxChanged 再决定要不要往下做',
                '撤错了不要再用 undo 追：按 baseline 里的体积/包围盒用 model action=build 重建，'
                  + '重建后必查体积、包围盒、实体数、材料密度与孔数轴线',
              ],
              extra: { call: undone },
            }),
          )
        }
        case 'mateDelete': {
          if (!args.mateName) {
            return failed({
              op: 'model.mateDelete', designId: args.designId,
              error: fail('BAD_ARGUMENT', 'mateDelete 需要 mateName（inspect action="mates" 拿到的配合名）'),
            })
          }
          const delId = resolveDesignId(args.designId)
          const out = await callBridge('mateDelete', {
            name: args.mateName,
            ...(delId ? { designId: delId } : {}),
          })
          return ok(
            envelope({
              summary: out?.deleted
                ? '已删除配合 ' + args.mateName + '（' + out.matesBefore + ' → ' + out.matesAfter + '）'
                : '配合 ' + args.mateName + ' 没有删掉（配合数 ' + out?.matesBefore + ' → ' + out?.matesAfter + '）',
              designId: args.designId,
              status: out?.deleted ? 'ok' : 'failed',
              changes: { mate: out },
              nextActions: out?.deleted ? ['用 model action="mate" 按同一对实体重建，需要同转就加 mateLockRotation:true'] : [],
              timings: { totalMs: Date.now() - started },
            }),
          )
        }
        case 'componentLock': {
          if (!args.mateName || !args.component) {
            return failed({
              op: 'model.componentLock', designId: args.designId,
              error: fail('BAD_ARGUMENT', 'componentLock 需要 component（第一件）与 mateName（第二件，借这个字段传第二件名）'),
            })
          }
          const lockDesignId = resolveDesignId(args.designId)
          const out = await callBridge('componentLock', {
            first: args.component,
            second: args.mateName,
            ...(lockDesignId ? { designId: lockDesignId } : {}),
          })
          const addedLock = out?.added === true && out?.errorStatus === 1
          return ok(
            envelope({
              summary: addedLock
                ? '已锁定 ' + args.component + ' ↔ ' + args.mateName + '（刚性）'
                : '锁定没有建成（errorStatus=' + (out?.errorStatus ?? '?') + '）',
              designId: args.designId,
              status: addedLock ? 'ok' : 'failed',
              changes: { lock: out },
              timings: { totalMs: Date.now() - started },
            }),
          )
        }
        case 'mateLock': {
          if (!args.mateName) {
            return failed({
              op: 'model.mateLock', designId: args.designId,
              error: fail('BAD_ARGUMENT', 'mateLock 需要 mateName（inspect action="mates" 拿到的配合名）'),
            })
          }
          const lockId = resolveDesignId(args.designId)
          const out = await callBridge('mateLock', {
            name: args.mateName,
            lockRotation: args.mateLockRotation !== false,
            ...(lockId ? { designId: lockId } : {}),
          })
          return ok(
            envelope({
              summary: '配合 ' + args.mateName + ' 锁转 ' + (out?.lockRotationBefore ?? '?') + ' → ' + (out?.lockRotationAfter ?? '?'),
              designId: args.designId,
              status: out?.lockRotationAfter === true ? 'ok' : 'failed',
              changes: { mate: out },
              timings: { totalMs: Date.now() - started },
            }),
          )
        }
        case 'mate': {
          if (!args.mateFirst || !args.mateSecond) {
            return failed({
              op: 'model.mate', designId: args.designId,
              error: fail('BAD_ARGUMENT', 'mate 需要 mateFirst 与 mateSecond（两个面的 persistentId，用 inspect action="faces" 取）'),
            })
          }
          const mateDesignId = resolveDesignId(args.designId)
          const out = await callBridge('mate', {
            first: args.mateFirst,
            second: args.mateSecond,
            kind: args.mateKind ?? 'coincident',
            distance: args.mateDistance ?? 0,
            angle: args.mateAngleDeg ?? 0,
            ratio: args.mateRatio ?? 1,
            reverse: args.mateReverse === true,
            lockRotation: args.mateLockRotation === true,
            ...(mateDesignId ? { designId: mateDesignId } : {}),
          })
          const created = out?.added === true
          const solved = out?.errorStatus === 1
          const savedOk = out?.saved === true
          const mateOk = created && solved && savedOk
          const why = [
            '建=' + (created ? '是' : '否'),
            '求解=' + (solved ? '通过' : 'errorStatus=' + (out?.errorStatus ?? '?')),
            '存盘=' + (savedOk ? '是' : '否'),
            '锁转=' + (out?.lockRotation === true ? '开' : out?.lockRotation === false ? '关' : 'n/a'),
            ...((args.mateKind ?? 'coincident') === 'gear'
              ? ['传动比=' + (out?.gear?.ratio ?? out?.ratio ?? '?') + ':1'
                + (out?.gear?.reverse === true ? '（反向）' : '')]
              : []),
          ].join(' ')
          return ok(
            envelope({
              summary: (mateOk ? '已加 ' : '配合没有完全成功（') + (args.mateKind ?? 'coincident') + ' 配合' + (mateOk ? '' : '）') + '：' + why,
              designId: args.designId,
              status: mateOk ? 'ok' : 'failed',
              changes: {
                kind: out?.kind,
                created,
                solved,
                saved: savedOk,
                added: created,
                mate: out?.mate ?? null,
                ratio: out?.ratio ?? null,
                reverse: out?.reverse ?? null,
                gear: out?.gear ?? null,
                lockRotation: out?.lockRotation ?? null,
                lockModify: out?.lockModify ?? null,
                rebuild: out?.rebuild ?? null,
                errorStatus: out?.errorStatus ?? null,
                errorStatusMeaning: solved ? 'swAddMateError_NoError'
                  : out?.errorStatus === 5 ? 'swAddMateError_OverDefinedAssembly'
                  : out?.errorStatus === 4 ? 'swAddMateError_IncorrectSelections'
                  : out?.errorStatus === 2 ? 'swAddMateError_IncorrectMateType'
                  : out?.errorStatus === 3 ? 'swAddMateError_IncorrectAlignment'
                  : out?.errorStatus === 0 ? 'swAddMateError_ErrorUknown'
                  : null,
                returned: out?.returned ?? null,
                saveErrors: out?.saveErrors ?? null,
                saveWarnings: out?.saveWarnings ?? null,
                assembly: out?.assembly ?? null,
              },
              nextActions: mateOk
                ? ['用 inspect action="mates" 按两端零件名核对这条配合，再驱动验证自由度']
                : solved
                  ? ['求解或存盘没过：先看 errorStatusMeaning；过定义就删掉一条冗余配合再重建']
                  : ['errorStatus 非 1：换一组面重试（两面必须属于不同零件）；过定义时先删旧配合'],
              timings: { totalMs: Date.now() - started },
            }),
          )
        }
        case 'drive': {
          // 脚本驱动：SOLIDWORKS 的齿轮配合只在交互拖动/运动算例里传递运动，
          // 桥接器两条路都进不去（AddComponent 恒 false、SetTransformAndSolve3 只解
          // 几何配合）。所以这里不假装耦合，而是按「主轴角度 × 传动比」逐个设位姿
          // 再各求解一次，回包明确标 mode:"scripted"。
          const driveDesignId = requireDesignId(args.designId, { tool: 'assembly', action: 'drive' })
          const primary = args.drivePrimary
          if (typeof primary !== 'string' || primary.trim() === '') {
            return failed({
              op: 'assembly.drive', designId: driveDesignId,
              error: fail('BAD_ARGUMENT', 'drive 需要 drivePrimary（主轴组件名，inspect action="assembly" 取得）'),
            })
          }
          const ratios = { ...(args.driveRatios ?? {}) }
          if (ratios[primary] === undefined) ratios[primary] = 1
          const badRatio = Object.entries(ratios).find(([, value]) => !Number.isFinite(value) || value === 0)
          if (badRatio) {
            return failed({
              op: 'assembly.drive', designId: driveDesignId,
              error: fail('BAD_ARGUMENT', `driveRatios[${badRatio[0]}] 必须是非零数字`, { given: badRatio[1] }),
            })
          }
          const driveAxis = args.axis ?? 'y'
          const driveAngle = Number(args.driveAngleDeg ?? 0)
          const angleAbout = (transform, axisName) => {
            if (!Array.isArray(transform) || transform.length !== 16) return null
            const m = transform
            const raw = axisName === 'x' ? Math.atan2(m[7], m[4])
              : axisName === 'z' ? Math.atan2(m[3], m[0])
                : Math.atan2(m[2], m[0])
            return Math.round(raw * 180 / Math.PI * 1e6) / 1e6
          }
          const wrapDeg = (value) => {
            if (!Number.isFinite(value)) return null
            const wrapped = ((value % 360) + 360) % 360
            return Math.round((wrapped > 180 ? wrapped - 360 : wrapped) * 1e4) / 1e4
          }
          const readComponents = async () => {
            const listed = await callBridge('components', { designId: driveDesignId })
            return listed.components ?? []
          }
          try {
            const beforeList = await readComponents()
            const findComp = (name) => beforeList.find((c) => c?.name === name)
            const missing = Object.keys(ratios).filter((name) => findComp(name) === undefined)
            if (missing.length > 0) {
              return failed({
                op: 'assembly.drive', designId: driveDesignId,
                error: fail('COMPONENT_NOT_FOUND', `装配里没有这些组件：${missing.join(', ')}`, {
                  available: beforeList.map((c) => c?.name),
                }),
                nextActions: ['先用 inspect action="assembly" 拿准确的组件名（带 -1 后缀）'],
              })
            }
            const steps = []
            for (const [name, ratio] of Object.entries(ratios)) {
              const comp = findComp(name)
              const origin = Array.isArray(comp?.origin) ? comp.origin : [0, 0, 0]
              const out = await callBridge('componentRotate', {
                designId: driveDesignId,
                component: name,
                angleDeg: driveAngle * ratio,
                axis: driveAxis,
                x: origin[0] ?? 0, y: origin[1] ?? 0, z: origin[2] ?? 0,
              })
              steps.push({
                component: name,
                ratio,
                requestedDeg: Math.round(driveAngle * ratio * 1e4) / 1e4,
                applied: out?.applied === true,
                beforeDeg: angleAbout(comp?.transform, driveAxis),
              })
            }
            const afterList = await readComponents()
            for (const step of steps) {
              const after = afterList.find((c) => c?.name === step.component)
              const afterDeg = angleAbout(after?.transform, driveAxis)
              step.afterDeg = afterDeg
              step.deltaDeg = step.beforeDeg === null || afterDeg === null
                ? null
                : wrapDeg(afterDeg - step.beforeDeg)
            }
            const allApplied = steps.every((step) => step.applied)
            // 「调用成功」不等于「按传动比动了」：ASM-09 驱动齿轴 12°，轮芯读回 0°，旧回包仍是 status:"ok"。
            // 这里按回读的实际转角判定每一步有没有跟上，没跟上就降级成 partial。
            const toleranceDeg = 0.5
            const checked = steps.map((step) => {
              const want = step.requestedDeg
              const got = step.deltaDeg
              const followed = Number.isFinite(got)
                && Math.abs(Math.abs(want) - Math.abs(got)) <= toleranceDeg
                && (Math.abs(want) < 1e-9 || Math.sign(got) === Math.sign(want))
              return { component: step.component, requestedDeg: want, deltaDeg: got, followed }
            })
            const notDriven = checked.filter((item) => !item.followed).map((item) => item.component)
            // 没在 ratios 里的组件也可能该跟着动（ASM-09 的轮芯就是这样）：把它们里
            // 这一步完全没动的列出来，让调用方自己判断"固定件"还是"漏了传动"。
            const staticComponents = beforeList
              .filter((comp) => comp && ratios[comp.name] === undefined)
              .map((comp) => {
                const after = afterList.find((item) => item?.name === comp.name)
                const beforeDeg = angleAbout(comp.transform, driveAxis)
                const afterDeg = angleAbout(after?.transform, driveAxis)
                return {
                  name: comp.name,
                  deltaDeg: beforeDeg === null || afterDeg === null ? null : wrapDeg(afterDeg - beforeDeg),
                }
              })
              .filter((item) => item.deltaDeg !== null && Math.abs(item.deltaDeg) < 0.05)
              .map((item) => item.name)
              .slice(0, 12)
            const driveStatus = !allApplied ? 'failed' : notDriven.length === 0 ? 'ok' : 'partial'
            const summary = `脚本驱动 ${primary} ${driveAngle}°（${driveAxis} 轴，模式 scripted）：`
              + steps.map((step) => `${step.component} Δ${step.deltaDeg ?? '?'}°`).join('，')
              + (notDriven.length ? `；没跟上：${notDriven.join(', ')}` : '')
            return ok(
              envelope({
                summary,
                designId: driveDesignId,
                status: driveStatus,
                changes: {
                  mode: 'scripted',
                  notDriven,
                  stillStatic: staticComponents,
                  toleranceDeg,
                  followed: checked,
                  caveat: '这是程序按传动比设置每个组件的位姿后求解，不是齿轮配合的真实耦合；'
                    + 'SOLIDWORKS 的机械配合只在交互拖动/运动算例里传递运动，API 进不去。',
                  primary,
                  angleDeg: driveAngle,
                  axis: driveAxis,
                  steps,
                },
                measurements: {
                  angles: Object.fromEntries(steps.map((step) => [step.component, {
                    beforeDeg: step.beforeDeg, afterDeg: step.afterDeg, deltaDeg: step.deltaDeg, ratio: step.ratio,
                  }])),
                },
                nextActions: notDriven.length > 0
                  ? ['这些组件没按传动比跟上：先查配合（同心是否重复、锁转是否打开、传动比是否写错），只改这一处再测', 'status:"partial" 不能当通过——先修配合，别靠重跑或换 designId 绕过']
                  : allApplied
                    ? ['用 inspect action="assembly" 复核各件位姿；需要真实齿轮耦合请在 UI 里拖动主轴一次']
                    : ['有组件没接受位姿（applied=false）：检查组件是否被完全约束，或换主轴重试'],
                timings: { totalMs: Date.now() - started },
              }),
            )
          } catch (error) {
            return failed({ op: 'assembly.drive', designId: driveDesignId, error })
          }
        }
        case 'componentRotate': {
          if (!args.component) {
            return failed({
              op: 'model.componentRotate', designId: args.designId,
              error: fail('BAD_ARGUMENT', 'componentRotate 需要 component（装配组件名，如 "C06-01-1"）'),
            })
          }
          const rotateDesignId = resolveDesignId(args.designId)
          const rotateFrame = args.frame === 'local' ? 'local' : 'global'
          const rotateRequest = {
            ...(rotateDesignId ? { designId: rotateDesignId } : {}),
            component: args.component,
            angleDeg: args.angleDeg ?? 0,
            axis: args.axis ?? 'z',
            frame: rotateFrame,
            solve: args.solve === true,
          }
          // 只有调用方真的给了旋转点才把 x/y/z 发下去：桥接器用 ContainsKey 判断
          // 是否显式给点，恒发 0/0/0 会让「不传就绕包围盒中心」永远走 explicit 分支，
          // 实际绕装配原点转 —— 位姿看起来仍然 ok。
          if ([args.x, args.y, args.z].some((value) => Number.isFinite(value))) {
            rotateRequest.x = args.x ?? 0
            rotateRequest.y = args.y ?? 0
            rotateRequest.z = args.z ?? 0
          }
          const out = await callBridge('componentRotate', rotateRequest)
          const applied = out?.applied === true
          const readout = rotationReadout(out)
          const rotation = readout.rotation
          const pose = readout.pose
          // 桥接器只有在真的支持 frame 时才会回 frame。老桥接器（本轮未改 bridge）不认这个字段，
          // 于是 local 请求实际按装配坐标转了 —— 这种情况必须说破，不能回显「已按 local 转」。
          const frameAcknowledged = typeof out?.frame === 'string'
          const frameEffective = frameAcknowledged ? out.frame : (rotateFrame === 'global' ? 'global' : null)
          const frameUnsupported = rotateFrame === 'local' && !frameAcknowledged
          return ok(
            envelope({
              summary: applied
                ? '已转动 ' + args.component + ' ' + (args.angleDeg ?? 0) + '°（' + (args.axis ?? 'z') + ' 轴，'
                  + (frameEffective === 'local' ? '零件自身坐标系' : '装配坐标系') + '）'
                  + (pose?.origin ? '；新位姿 origin (' + formatPoint(pose.origin) + ')' : '')
                  + (readout.centerDriftMm === null ? '' : '；centerDrift ' + readout.centerDriftMm + ' mm')
                  + (frameUnsupported ? '；注意：当前桥接器还不认 frame="local"，这一转实际是按装配坐标转的' : '')
                : '转动没有生效（' + args.component + '）',
              designId: args.designId,
              status: applied ? (frameUnsupported ? 'incomplete' : 'ok') : 'failed',
              changes: {
                ...out,
                frame: frameEffective,
                frameRequested: rotateFrame,
                frameUnsupported,
                rotation,
                pose,
                pivot: readout.pivot,
                pivotSource: readout.pivotSource,
                centerDriftMm: readout.centerDriftMm,
                method: readout.method,
                readout: rotation === null ? null : {
                  frame: frameEffective,
                  axis: args.axis ?? 'z',
                  requestedDeg: args.angleDeg ?? 0,
                  rotationMatrix: formatMatrix(rotation),
                  poseOrigin: Array.isArray(pose?.origin) ? pose.origin : null,
                  poseAxes: formatMatrix(pose?.axes),
                  centerDriftMm: readout.centerDriftMm,
                  method: readout.method,
                },
              },
              nextActions: !applied
                ? ['组件可能被配合完全约束：先 inspect action="mates" 看约束，再决定保留哪些配合',
                  'frame 写错会转错轴：global 是装配轴、local 是零件自身轴，回包 frame 会回显实际用的那个']
                : frameUnsupported
                  ? ['这一转是退化的：frame="local" 未实现，桥接器按装配坐标转了；不要把 pose/朝向当零件坐标系结果',
                    '要按零件轴转：先在 SOLIDWORKS 里确认零件朝向，或改用 datum + placement 定位；不要连续重试 local']
                  : ['rotation/pose/centerDriftMm 就是这一转的读数：先对一遍再决定下一步（读数不对 = 转错轴或参考系写错）',
                    '再用 inspect action="assembly" 复核 origin/box；装配验收用 verify tiers=["assembly"]'],
              timings: { totalMs: Date.now() - started },
            }),
          )
        }        case 'componentTranslate': {
          if (!args.component) {
            return failed({
              op: 'model.componentTranslate', designId: args.designId,
              error: fail('BAD_ARGUMENT', 'componentTranslate 需要 component（装配组件名，如 "F20.01_枢轴-1"）'),
            })
          }
          const moveDesignId = resolveDesignId(args.designId)
          const out = await callBridge('componentTranslate', {
            ...(moveDesignId ? { designId: moveDesignId } : {}),
            component: args.component,
            dx: args.dx ?? 0, dy: args.dy ?? 0, dz: args.dz ?? 0,
            unfix: args.unfix === true, refix: args.refix === true,
          })
          const moved = out?.applied === true
          const show = (v) => (Array.isArray(v) ? v.map((n) => Math.round(n * 1000) / 1000).join(',') : '?')
          return ok(
            envelope({
              summary: moved
                ? '已平移 ' + args.component + ' [' + (args.dx ?? 0) + ',' + (args.dy ?? 0) + ',' + (args.dz ?? 0) + ']：'
                  + show(out?.before) + ' → ' + show(out?.after)
                : '平移没有生效（' + args.component + '）',
              designId: args.designId,
              status: moved ? 'ok' : 'failed',
              changes: out,
              nextActions: moved
                ? ['读 inspect action="assembly" 复核这件的 origin/box，再存盘']
                : ['组件可能被固定或完全约束：先 unfix:true，或 inspect action="mates" 看是哪条配合锁住了'],
              timings: { totalMs: Date.now() - started },
            }),
          )
        }        case 'assemble': {          if (!args.components?.length) {
            return failed({
              op: 'model.assemble', designId: args.designId,
              error: fail('BAD_ARGUMENT', 'assemble 需要 components（零件路径与位置）'),
            })
          }
          // 空 path 是「零件只在内存里」的症状：build 不落盘，assemble 只插磁盘文件。
          // 老行为是把它传给桥接器，换回 {path:"", reason:"FILE_NOT_FOUND"}，调用方
          // 只能猜是哪一步少了存盘。这里提前拦，并把补救顺序写清楚。
          const noPath = (args.components ?? []).filter((c) => !c || typeof c.path !== 'string' || !c.path.trim())
          if (noPath.length > 0) {
            return failed({
              op: 'model.assemble', designId: args.designId,
              error: fail('COMPONENT_NOT_ON_DISK',
                `有 ${noPath.length}/${args.components.length} 个组件没有 path：build 只把零件建在内存里，assemble 只认磁盘上的 SLDPRT。`
                + ' 先对每个 designId 走 capture + deliver kind="sldprt"，再把交付路径填进 components[].path。',
                { hint: '未存盘文档的 document.path 是空字符串；deliver 回包里的 path 才是可用路径' }),
            })
          }          // designId 必须往下传：桥接器的 RegisterCreated 用它当 WorkRegistry 的键，
          // 拿不到就退回 "created:<标题>"。之后 inspect action="assembly" 走的
          // components → RequireDesignDocument 是**按 designId 查这张登记表**再按标题
          // 激活窗口的，键不对就永远查不到，报 DOC_NOT_OPEN。
          //
          // 没有 designId 时保持原样不传（不要传 undefined）：字段缺失时桥接器才会走
          // "created:" 兜底，而 "designId": undefined 在 JSON 里会被整个丢掉 —— 两种写法
          // 结果一样，但显式条件展开让"这条老路还在"在源码里看得见。
          const assemblyDesignId = resolveDesignId(args.designId)
          // placement="datum:<name>"：基准位姿登记在零件旁边的 design.json 里。这里把它换算成
          // 「零件原点落位」的坐标，桥接器不需要知道基准这回事。找不到就报错 —— 静默退回
          // 包围盒中心会让零件落在离基准很远的地方，而且回包看起来成功。
          // 换算函数是纯函数（tools-datum.mjs），离线测试直接断言它；这里必须把返回的
          // components 真的传下去 —— 以前算完仍传 args.components，datum 换算被静默丢弃。
          const planned = planPlacementComponents(args.components)
          if (planned.error) {
            return failed({
              op: 'model.assemble', designId: args.designId,
              error: fail(planned.error.code, planned.error.message, planned.error.detail),
              ...(planned.error.code === 'DATUM_NOT_FOUND' ? {
                nextActions: [
                  '对那个零件跑 datum action="list" designId=<它的 designId> 看已登记的名字（基准写在零件旁边的 design.json 里）',
                  '还没有基准就 datum action="create"，再回来 assemble；不要退回 bbox-center 凑位置',
                ],
              } : {}),
            })
          }
          const componentsForBridge = planned.components
          const placementNotes = planned.notes
          const created = await callBridge('assemblyNew', {
            path: args.outputPath,
            ...(assemblyDesignId ? { designId: assemblyDesignId } : {}),
          })
          const inserted = await callBridge('componentInsert', {
            components: componentsForBridge,
            ...(assemblyDesignId ? { designId: assemblyDesignId } : {}),
            ...(args.outputPath ? { path: args.outputPath } : {}),
          })
          const placed = inserted.inserted ?? []
          const skipped = inserted.skipped ?? []
          const satisfied = placed.length + skipped.length
          const boundTo = created?.document?.path || created?.document?.title || null
          const insertedInto = inserted?.assembly?.path || inserted?.assembly?.title || null
          const normDoc = (v) => (typeof v === 'string' ? v.toLowerCase() : null)
          const sameDocument = boundTo !== null && insertedInto !== null && normDoc(boundTo) === normDoc(insertedInto)
          const saved = inserted?.saved === true
          const componentsOnDisk = saved ? (inserted?.componentCount ?? null) : null
          const complete = satisfied === args.components.length && saved && sameDocument
          const placementWarnings = placed.filter((c) => c?.warning).map((c) => (c.name ?? c.path ?? '?') + ': ' + c.warning)
          const summary = complete
            ? '装配体已存入 ' + placed.length + ' 个零件' + (skipped.length ? '（另有 ' + skipped.length + ' 个已存在，跳过重复插入）' : '') + '（' + boundTo + '）'
            : '只放进了 ' + placed.length + '/' + args.components.length + ' 个零件'
              + (saved ? '' : '；磁盘上没有确认保存')
              + (sameDocument ? '' : '；组件插入的文档与 designId 绑定的不是同一份')
          const assemblyShots = complete ? await autoShots(assemblyDesignId ?? args.designId, 'asm') : []
          const response = ok(
            envelope({
              summary,
              designId: args.designId,
              status: complete ? 'ok' : 'failed',
              changes: {
                document: created.document,
                boundTo,
                insertedInto,
                saved,
                savedBeforeInsert: created?.saved === true,
                componentsOnDisk,
                components: placed,
                skipped,
                failed: inserted.failed ?? [],
                placementWarnings,
                placementNotes,
                autoShots: assemblyShots.map((shot) => ({ path: shot.path, view: shot.view })),
              },
              nextActions: [
                ...(inserted.failed ?? []).map((f) => f.path + '：' + f.reason),
                ...placementWarnings,
                ...(placementNotes.length > 0 ? ['datum 只对齐原点；朝向校正依赖 componentRotate frame="local"，而当前桥接器未实现 local（回包标 frameUnsupported）'] : []),
                ...(sameDocument ? [] : ['boundTo 与 insertedInto 不一致：组件没插进 designId 绑定的那份装配，按 designId 重插一次']),
                ...(saved ? [] : ['组件已在内存但没写盘：给 assemble 传 outputPath，或用 deliver 存一次']),
              ],
              timings: { totalMs: Date.now() - started },
              extra: { assembly: inserted.assembly, componentCount: inserted.componentCount },
            }),
          )
          if (assemblyShots.length > 0) response.content.push(...imageContent(assemblyShots))
          return response
        }
        case 'drawing': {
          if (!args.model) {
            return failed({
              op: 'model.drawing', designId: args.designId,
              error: fail('BAD_ARGUMENT', 'drawing 需要 model（要出图的文件路径）'),
            })
          }
          const drawn = await callBridge('drawingViews', {
            model: args.model,
            views: args.views,
            path: args.outputPath,
            template: args.template,
            projection: args.projection,
          })
          const dropped = drawn.dropped ?? []
          const projection = drawn.projection ?? {}
          return ok(
            envelope({
              summary: (dropped.length
                ? `图纸上放了 ${dropped.length} 个视图：${dropped.map((d) => d.name).join('、')}`
                : '图纸上没有任何视图（导出会是空白页）')
                + (projection.after ? `；投影法 ${projection.after === 'first' ? '第一角' : '第三角'}` : ''),
              designId: args.designId,
              status: dropped.length ? 'ok' : 'failed',
              changes: {
                drawing: drawn.drawing,
                dropped,
                missed: drawn.missed ?? [],
                palette: drawn.palette ?? [],
                viewCount: drawn.viewCountAfter,
                views: drawn.views ?? [],
                unionBeforeMm: drawn.unionBeforeMm ?? null,
                unionAfterMm: drawn.unionAfterMm ?? null,
                freeAreaMm: drawn.freeAreaMm ?? null,
                repositioned: drawn.repositioned === true,
                shiftMm: drawn.shiftMm ?? null,
                projection,
              },
              nextActions: [
                ...(projection.applied === false
                  ? ['SOLIDWORKS 回读的投影法和要求的不一致：不要把「这是左视图」当定案']
                  : []),
                ...(drawn.notes ?? []),
              ],
              timings: { totalMs: Date.now() - started },
              extra: { model: drawn.model, paletteOk: drawn.paletteOk },
            }),
          )
        }
        case 'kinds': {
          const kindsDesignId = resolveDesignId(args.designId)
          const result = await callBridge('kinds', {
            target: args.target ?? 'doc',
            ...(args.iface ? { iface: args.iface } : {}),
            ...(kindsDesignId ? { designId: kindsDesignId } : {}),
            offset: args.offset ?? 0,
            limit: args.limit ?? 200,
          })
          const shown = result.members ?? []
          const preview = shown.slice(0, 12).map((m) => m.signature).join('\n')
          return ok(
            envelope({
              summary: `${result.target} 上有 ${result.total} 个成员（${(result.interfaces ?? []).slice(0, 4).join('、')}${(result.interfaces ?? []).length > 4 ? '…' : ''}）`,
              designId: resolveDesignId(args.designId),
              changes: {
                target: result.target,
                interfaces: result.interfaces,
                members: shown,
                total: result.total,
                offset: result.offset,
                limit: result.limit,
                nextOffset: result.nextOffset,
              },
              timings: { totalMs: Date.now() - started },
              nextActions: result.nextOffset
                ? [`还有更多：同一 target 传 offset=${result.nextOffset} 继续看`]
                : [],
              extra: { preview },
            }),
          )
        }
        case 'feature':
        case 'helix':
        case 'sweep':
        case 'loft': {
          // 单特征动作：作用在 designId 已打开的那份文档上，轮廓/路径都按特征名引用。
          // 与 build 里的同名 feature kind 共用桥接器的同一段代码；区别只是这里不重建整件。
          const designId = resolveDesignId(args.designId)
          if (!designId) {
            return failed({
              op: `model.${args.action}`,
              error: fail('DESIGN_ID_REQUIRED',
                `${args.action} 需要 designId：它作用在一份已存在的文档上，不猜「前台那份」`),
            })
          }
          const kind = args.action === 'helix'
            ? 'helix'
            : args.action === 'sweep'
              ? (args.cut ? 'sweptCut' : 'sweep')
              : args.action === 'loft'
                ? (args.cut ? 'loftedCut' : 'loft')
                : args.featureKind
          if (!kind) {
            return failed({
              op: `model.${args.action}`,
              error: fail('BAD_ARGUMENT', 'feature 需要 featureKind（helix | sweep | sweptCut | loft | loftedCut）'),
            })
          }
          const SPEC_KEYS = [
            'profile', 'path', 'guides', 'sections', 'definedBy', 'height', 'pitch', 'revolutions',
            'reversed', 'clockwise', 'tapered', 'outward', 'taperAngle', 'startAngle', 'cut', 'thin',
            'thickness', 'thickness2', 'thinType', 'twist', 'twistControl', 'startMatch', 'endMatch',
            'propagate', 'alignment', 'advancedSmoothing', 'merge', 'circularProfile',
            'circularDiameter', 'reverseDirection', 'mode', 'closed', 'keepTangency', 'tessTolerance',
          ]
          const spec = { kind }
          for (const key of SPEC_KEYS) if (args[key] !== undefined) spec[key] = args[key]
          const result = await callBridge('feature', { designId, feature: spec })
          const delta = Number(result?.removedMm3 ?? 0)
          return ok(
            envelope({
              summary: `${kind} 已建：${result?.feature ?? '?'}`
                + (kind === 'helix' ? '' : `；体积 ${result?.volumeBeforeMm3} → ${result?.volumeAfterMm3} mm³`
                  + (Math.abs(delta) > 1e-9 ? `（切除 ${delta.toFixed(3)}）` : '（未切除材料）'))
                + `；面数 ${result?.faces ?? '?'}`,
              designId,
              status: 'ok',
              measurements: { volumeBeforeMm3: result?.volumeBeforeMm3, volumeAfterMm3: result?.volumeAfterMm3, removedMm3: result?.removedMm3, faces: result?.faces },
              changes: result,
              timings: { totalMs: Date.now() - started },
              nextActions: kind === 'helix'
                ? ['接着建轮廓草图，再 model action="sweep" cut=true（profile=轮廓, path=这条螺旋线）',
                  '量导程用 inspect action="measure" measure={kind:"helix"}']
                : ['量读数：inspect action="model" format="geometry"；导程用 measure kind="helix"'],
            }),
          )
        }
        case 'pattern': {
          if (!args.feature && args.featureIndex === undefined) {
            return failed({ op: 'model.pattern', designId: args.designId, error: fail('BAD_ARGUMENT', 'pattern 需要 feature 或 featureIndex') })
          }
          const payload = {
            ...(args.feature ? { feature: args.feature } : {}),
            ...(args.featureIndex !== undefined ? { featureIndex: args.featureIndex } : {}),
            count: args.count ?? 4,
            angleDeg: args.angleDeg ?? 360,
            flip: args.flip === true,
          }
          if (Array.isArray(args.axisPlanes) && args.axisPlanes.length) payload.axisPlanes = args.axisPlanes
          if (args.designId) payload.designId = args.designId
          const result = await callBridge('patternCircular', payload)
          return ok(
            envelope({
              summary: `已用 ${result.feature} 建圆形阵列 ${result.pattern}（${result.count} 个，${result.angleDeg}°）`,
              designId: resolveDesignId(args.designId),
              changes: result,
              timings: { totalMs: Date.now() - started },
              nextActions: ['阵列是原生特征；改 count/角度可再调 pattern，删除用 undo 或 SOLIDWORKS 特征树'],
            }),
          )
        }
        case 'diff': {
          if (typeof args.comparePath !== 'string' || args.comparePath.length === 0) {
            return failed({ op: 'model.diff', designId: args.designId, error: fail('BAD_ARGUMENT', 'diff 需要 comparePath（基准 STEP 的绝对路径）') })
          }
          const designId = resolveDesignId(args.designId)
          const stepDir = join(DATA_DIR, 'tmp')
          mkdirSync(stepDir, { recursive: true })
          const stepPath = join(stepDir, `diff-${designId ?? 'part'}-${Date.now()}.step`)
          await callBridge('export', { designId, kind: 'step', path: stepPath })
          const workerRef = await openAnalysis()
          let diff
          try {
            diff = await workerRef.request('step.diff', {
              a: args.comparePath,
              b: stepPath,
              volumeToleranceMm3: args.volumeToleranceMm3,
              lengthToleranceMm: args.lengthToleranceMm,
            })
          } finally {
            workerRef.close()
          }
          const regions = [...new Set(diff.items.map((item) => item.region))]
          return ok(
            envelope({
              summary: diff.equal
                ? '当前模型与基准 STEP 在体积/包围盒/面边数上没有超差'
                : `当前模型与基准有 ${diff.items.length} 处差异：${regions.join('、')}`,
              designId,
              status: diff.equal ? 'ok' : 'diff',
              measurements: { equal: diff.equal, items: diff.items.length, a: diff.a, b: diff.b },
              changes: { ...diff, source: stepPath, comparePath: args.comparePath },
              artifacts: [{ kind: 'step', path: stepPath }],
              timings: { totalMs: Date.now() - started },
              nextActions: [...new Set(diff.items.map((item) => item.nextObservation))].slice(0, 4),
            }),
          )
        }
        case 'object': {
          const action = args.objectAction ?? 'get'
          const payload = { action }
          if (args.handle) payload.handle = args.handle
          if (args.target) payload.target = args.target
          // objectAction=target 的 target 也按 designId 解析（与 invoke 同一口径）；
          // dimension 另带 param 取上次构建记录的原生尺寸。
          const objectDesignId = resolveDesignId(args.designId)
          if (action === 'target' && objectDesignId) payload.designId = objectDesignId
          if (args.target === 'dimension') {
            payload.designId = objectDesignId
            payload.param = args.param
          }
          if (args.member) payload.member = args.member
          if (args.iface) payload.iface = args.iface
          if (args.value !== undefined) payload.value = args.value
          if (args.index !== undefined) payload.index = args.index
          if (Array.isArray(args.args) && args.args.length > 0) payload.args = args.args
          const result = await callBridge('object', payload)
          const targetLabel = args.handle ?? args.target ?? '对象'
          return ok(
            envelope({
              summary: `object ${action} ${targetLabel}${result.member ? `.${result.member}` : ''} → ${
                typeof result.result === 'object' ? JSON.stringify(result.result).slice(0, 80) : String(result.result)}`,
              designId: resolveDesignId(args.designId),
              changes: result,
              timings: { totalMs: Date.now() - started },
              nextActions: result.result?.handle
                ? [`继续用 handle=${result.result.handle} 调 object ${action === 'call' ? 'call' : 'get'}`]
                : [],
            }),
          )
        }
        case 'batch': {
          // The bridge's wire format stores each operation's arguments alongside op.
          const ops = args.ops.map(({ op, args: params }) => ({ ...params, op }))
          const designId = resolveDesignId(args.designId)
          const result = await callBridge('batch', {
            ops, stopOnError: args.stopOnError !== false, ...(designId ? { designId } : {}),
          })
          const failedSteps = (result.results ?? []).filter((step) => !step.ok)
          return ok(
            envelope({
              summary: `batch 执行 ${result.count} 步${failedSteps.length ? `，${failedSteps.length} 步失败` : '，全部成功'}`,
              designId,
              status: failedSteps.length ? 'failed' : 'ok',
              changes: result,
              timings: { totalMs: Date.now() - started },
            }),
          )
        }
        case 'invoke':
        default: {
          if (!args.member) {
            return failed({ op: 'model.invoke', designId: args.designId, error: fail('BAD_ARGUMENT', 'invoke 需要 member') })
          }
          const converted = convertLengthArgs(args.member, args.args ?? [], args.units)
          // designId 必须一路送到桥接器：`target:"doc"` 现在由它决定指的是哪份文档。
          // 以前这里没传，桥接器只能取前台活动文档 —— 带着 designId 的调用命中了
          // 历史遗留的「零件3」，尺寸静默降级成参考尺寸。
          const invokeDesignId = resolveDesignId(args.designId)
          const result = await callBridge('invoke', {
            target: args.target,
            ...(args.iface ? { iface: args.iface } : {}),
            ...(invokeDesignId ? { designId: invokeDesignId } : {}),
            member: args.member,
            args: converted.args,
          })
          // 选择类调用要看「选中了几个」。实测一次：SelectByID2 的坐标按毫米给了
          // （2.5 / 20），API 要米，于是什么都没选中，返回照样是 true —— 之后的
          // 特征建在了空的选集上，错误指向完全无关的地方。所以 0 个不是「警告」，
          // 是这次调用没有达成目的：直接报 SELECTION_EMPTY。
          const selection = SELECTION_MEMBERS.test(args.member)
            ? await readSelectionCount(callBridge)
            : null
          const warnings = []
          if (selection === 0) {
            return failed({
              op: 'model.invoke',
              designId: resolveDesignId(args.designId),
              error: fail('SELECTION_EMPTY',
                `${args.target}.${args.member} 执行完之后选中的对象是 0 个 —— 这个 API 什么都没选中时`
                  + '同样返回 true，所以「调用成功」不代表选集里有东西。接下来的特征会建在空选集上。',
                {
                  member: args.member,
                  target: args.target,
                  selectionCount: 0,
                  returned: result.result ?? null,
                  units: args.units ?? null,
                  convertedArgs: converted.converted,
                  ...(result.document ? { document: result.document } : {}),
                }),
              nextActions: [
                '坐标按米重给一次（2.5 mm 写成 0.0025），或直接传 units:"mm" 让服务换算，再看 selectionCount 是否不为 0',
                '名字式选择（SelectByID2 的 name）必须与特征树里的完全一致：先 inspect action="model" format="tree" 看真实名字',
                '面/边用持久引用 id 更稳：inspect action="faces" 拿 id，再走 select 工具（它会回读选中数并按 SELECTION_EMPTY 拒）',
              ],
            })
          }
          return ok(
            envelope({
              summary: `${args.target}.${result.member} → ${typeof result.result === 'object'
                ? JSON.stringify(result.result).slice(0, 80)
                : String(result.result)}`
                + (result.document?.title ? `（作用在「${result.document.title}」上）` : '')
                + (selection === null ? '' : `；选中 ${selection} 个`)
                + (warnings.length ? `；注意：${warnings[0]}` : ''),
              designId: resolveDesignId(args.designId),
              changes: {
                signature: result.signature,
                returnType: result.returnType,
                result: result.result,
                outArgs: result.outArgs,
                ...(result.document ? { document: result.document } : {}),
                ...(result.activeDocument === true ? { activeDocument: true } : {}),
                ...(selection === null ? {} : { selectionCount: selection }),
                ...(converted.converted > 0 ? { units: 'mm', convertedArgs: converted.converted } : {}),
                ...(warnings.length ? { warnings } : {}),
              },
              timings: { totalMs: Date.now() - started },
              extra: { returnsVoid: result.returnsVoid === true },
              nextActions: result.activeDocument === true
                ? ['这次动的是 SOLIDWORKS 前台那份文档（没给 designId）：确认它确实是你要改的件；'
                  + '要动本设计，传 designId 再调一次']
                : warnings.length
                  ? ['坐标按米重给一次（或传 units:"mm"），再看 selectionCount 是否不为 0']
                  : [],
            }),
          )
        }
      }
    } catch (error) {
      return failed({ op: `model.${args.action}`, designId: args.designId, error })
    }
  },
)

// ------------------------------------------------------------------ workspace
// workspace action="read" 的路径白名单。
//
// 描述写着「只在这个目录里」，实现却直接 `resolve(args.path)` 读 —— 仓库源码、
// 用户磁盘上任意文件都能被这个工具读走。这里把路径钉死在数据目录
// （%LOCALAPPDATA%\sw-mcp 或 SW_MCP_DATA）之下的**普通文件**：logs/ projects/
// knowledge/ images/ 这些子目录都在里面；拒绝 `..` 穿越、拒绝越界绝对路径、
// 拒绝目录/设备这类非普通文件，越界统一回 READ_OUTSIDE_DATA_DIR 并列出允许的根。
// 技能手册不经过这里（那走宿主 read 工具），所以收紧不影响它。
function dataReadRoots() {
  return [
    DATA_DIR,
    join(DATA_DIR, 'logs'),
    join(DATA_DIR, 'projects'),
    join(DATA_DIR, 'knowledge'),
    join(DATA_DIR, 'images'),
    join(DATA_DIR, 'catalog'),
    join(DATA_DIR, 'review'),
    join(DATA_DIR, 'tmp'),
  ].map((item) => resolve(item))
}

/** 返回 { ok: true, path } 或 { ok: false, error }（error 原样交给 failed）。 */
function resolveDataReadPath(inputPath) {
  const root = resolve(DATA_DIR)
  const roots = dataReadRoots()
  const example = join(DATA_DIR, 'logs', 'mcp-20260101-000000.jsonl')
  const rejectOutside = (message, target) => ({
    ok: false,
    error: fail('READ_OUTSIDE_DATA_DIR', message, { allowedRoots: roots, example, path: target }),
  })
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { ok: false, error: fail('BAD_ARGUMENT', 'read 需要 path（本服务数据目录下的文件）') }
  }
  // 字面 `..` 一律拒：不靠「解析后恰好还在里面」来兜，先把穿越写法挡在外面。
  if (inputPath.split(/[\\/]+/).includes('..')) {
    return rejectOutside(
      `read 只读本服务数据目录，不接受 .. 穿越：${inputPath}。`
        + `允许的根目录：${roots.join('、')}。示例：${example}`,
      inputPath,
    )
  }
  const target = resolve(inputPath)
  const rel = relative(root, target)
  // rel 为空 = 目标就是数据目录本身：那是个目录，留给下面的 isFile() 判。
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return rejectOutside(
      `read 只读本服务数据目录里的文件：${target} 越界。`
        + `允许的根目录：${roots.join('、')}。示例：${example}`,
      target,
    )
  }
  let stat = null
  try {
    stat = statSync(target)
  } catch {
    return { ok: false, error: fail('FILE_NOT_FOUND', `没有这个文件：${target}`) }
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      error: fail(
        'READ_NOT_A_FILE',
        `read 只读普通文件：${target} 不是文件（目录/设备都不行）。`
          + `允许的根目录：${roots.join('、')}。示例：${example}`,
        { allowedRoots: roots, example, path: target },
      ),
    }
  }
  return { ok: true, path: target }
}

server.registerTool(
  'workspace',
  {
    title: '环境、能力与项目',
    description: DESCRIPTIONS.workspace,
    inputSchema: z.object({
      action: z.enum(['preflight', 'status', 'instances', 'reap', 'ui', 'brief', 'projects', 'project', 'resume', 'history', 'read', 'search',
        'reload', 'cleanup', 'reclaim', 'closePath', 'close', 'open', 'quit', 'lesson', 'logs']).default('status').describe('要做什么'),
      designId: designIdArg,
      log: z
        .object({
          level: z.enum(['debug', 'info', 'warn', 'error']).optional().describe('只看这一级'),
          tool: z.string().optional().describe('只看这个工具，例如 "model" 或 "bridge"'),
          code: z.string().optional().describe('只看这个错误码，例如 "CUT_FAILED"'),
          cid: z.string().optional().describe('只看这一次调用（日志里每条都带 cid）'),
          since: z.string().optional().describe('ISO 时间，只要这之后的'),
        })
        .optional()
        .describe('logs 动作的过滤条件'),
      logLimit: z.number().int().min(1).max(500).default(50).describe('logs 动作返回多少条'),
      logOffset: z.number().int().min(0).default(0).describe('logs 动作的分页偏移'),
      pathPrefix: z.string().optional()
        .describe('closePath 要关掉的目录前缀；这个目录下保存的文档都会关掉'),
      untitled: z.boolean().optional()
        .describe('closePath 时是否连未命名文档一起关，默认 true'),
      title: z.string().optional().describe('close 的文档标题，例如 "零件12" 或 "plate.SLDPRT"'),
      keepMs: z.number().min(0).optional().describe('reclaim：临时 STEP 保留多久，默认 24 小时'),
      tag: z.string().optional().describe('reap/instances：只处理这个 tag 的实例（实例登记时的标签）'),
      dryRun: z.boolean().optional().describe('reap：只报告会回收什么，不真的关文档/退实例'),
      includeDocs: z.boolean().optional().describe('reap：连实例里的文档一起关（默认 true 由 broker 策略决定）'),
      force: z.boolean().optional().describe('reap/quit：连用户实例一起处理；默认只动本服务启动的实例'),
      graceMs: z.number().int().min(0).optional().describe('reap：空闲宽限期，覆盖 broker 的默认策略'),
      reason: z.string().optional().describe('reap：写进回收记录的原因'),
      uiAction: z.enum(['normalize', 'status']).optional()
        .describe('ui：必填。status 只读窗口状态；normalize 才整理窗口（用户有未存盘文档时跳过）。不传只报 ACTION_REQUIRED'),
      offNewsFeeds: z.boolean().optional()
        .describe('ui normalize：默认不写 swShowNewsFeedsInTaskPane 这个用户首选项；true 才改（会回读确认）'),
      pid: z.number().int().min(1).optional().describe('ui：指定实例 PID，默认当前实例'),
      path: z.string().optional().describe('read：文件绝对路径；brief：要看的目录（省略用服务进程 cwd）'),
      offset: z.number().int().min(0).default(0).describe('read 的起始行（0 基）'),
      limit: z.number().int().min(1).max(2000).default(200).describe('read 的行数'),
      q: z.string().optional().describe('search 的关键词'),
      query: z.string().optional().describe('q 的别名；两个都给时以 q 为准'),
      lesson: z
        .object({
          action: z.enum(['add', 'search', 'update', 'supersede', 'recipes', 'saveRecipe', 'reclaim', 'digest'])
            .default('search').describe('经验库要做什么'),
          text: z.string().optional().describe('经验正文；add 时可省略，由 action + observation 组成'),
          kind: z.enum(['pitfall', 'recipe', 'decision', 'api']).optional().describe('类别，默认 pitfall'),
          status: z.enum(['working', 'not-yet-working', 'unsupported-in-this-environment', 'curated', 'verified', 'deprecated'])
            .optional().describe('这条结论的把握程度；curated/verified 会进入会话开头的经验摘要'),
          conditions: z.any().optional().describe('适用条件：SW 版本、操作、模型特征等；digest 会以 [条件] 显示'),
          action: z.string().optional().describe('做了什么（与 observation 一起组成经验）'),
          observation: z.string().optional().describe('看到什么现象/结果'),
          evidenceRefs: z.array(z.string()).optional().describe('证据引用：快照、文件、任务或作业 id'),
          benefit: z.object({}).passthrough().optional().describe('收益，例如 { savedMs: 60000, fewerCalls: 4 }'),
          environment: z.object({}).passthrough().optional().describe('环境事实，例如 { swVersion: "34.3.2" }'),
          op: z.string().optional().describe('相关操作，例如 "holes"'),
          tags: z.array(z.string()).optional().describe('检索标签'),
          errorCode: z.string().optional().describe('unsupported 时的错误码'),
          tried: z.array(z.string()).optional().describe('试过但失败的组合'),
          evidence: z.string().optional().describe('复现条件或实测数字'),
          id: z.string().optional().describe('update/supersede 的目标 id'),
          query: z.string().optional().describe('search 的关键词'),
          limit: z.number().int().min(1).max(100).optional().describe('search 最多返回几条'),
          keepMs: z.number().int().min(0).optional().describe('reclaim：被替代/废弃记录保留多久，默认 30 天'),
          recipe: z.record(z.string(), z.any()).optional().describe('saveRecipe 的配方对象'),
        })
        .optional()
        .describe('action="lesson" 的经验库参数'),
    }),
  },
  async (args) => {
    try {
      switch (args.action) {
        case 'ui': {
          // 自动整理发生在真实建模操作的第一次 attach；只读 status 不会抢焦点。
          // 这里用于显式重排（比如用户把窗口拖走）或查当前窗口状态。
          //
          // A3：不允许隐式缺省。以前 args.uiAction ?? 'normalize' 让"不传 action"等于
          // "替我最大化窗口"，用户正画着的零件被反复拽到前台，看到的就是"上方操作栏跳动"。
          if (!args.uiAction) {
            throw fail(
              'ACTION_REQUIRED',
              'workspace action="ui" 必须显式指定 uiAction：'
                + '"status" 只读窗口状态（不抢焦点），"normalize" 才整理窗口'
                + '（用户有未存盘文档时会被跳过）。不传 action 的隐式最大化已取消。',
              { supported: ['normalize', 'status'] },
            )
          }
          const result = await callBridge('ui', {
            action: args.uiAction,
            pid: args.pid,
            offNewsFeeds: args.offNewsFeeds,
          })
          if (args.uiAction === 'status') {
            const summary = result.maximized ? 'SOLIDWORKS 窗口已最大化' : 'SOLIDWORKS 窗口未最大化'
            return ok(envelope({ summary, changes: result }))
          }
          // 用户有未存盘文档时桥接器会拒绝动窗口：这是成功跳过，不是失败。
          if (result.skipped === true) {
            return ok(
              envelope({
                summary: `跳过窗口整理：${result.note ?? result.reason ?? '用户有未存盘文档'}`,
                status: 'ok',
                changes: result,
                nextActions: Array.isArray(result.nextActions) && result.nextActions.length > 0
                  ? result.nextActions
                  : ['请用户自己存盘或关掉那份文档后再整理窗口'],
              }),
            )
          }
          if (result.maximized !== true && result.visible !== true) {
            throw fail('UI_NOT_READY', result.note ?? '窗口整理没有完成', result)
          }
          const summary = result.maximized ? 'SOLIDWORKS 窗口已最大化' : '已整理 SOLIDWORKS 窗口'
          return ok(envelope({ summary, changes: result }))
        }
        case 'instances': {
          // ROT 是实例身份的事实来源：pid + 启动时间，而不是「当前活动窗口」。
          // 开了 broker 时同时报告 broker 的登记表（含 worker/registry/回收策略）与
          // 本会话绑定的实例；只查不启动。
          let bound = null
          let inventory = null
          if (process.env.SW_MCP_BROKER === '1') {
            try {
              const client = await sharedBroker()
              bound = await client.request('instances.bound', { clientId: SW_CLIENT_ID }, { timeoutMs: 20_000 })
              inventory = await client.request('instances.list', {}, { timeoutMs: 20_000 })
            } catch { /* broker 没起来时退回只看 ROT */ }
          }
          const listed = await callBridge('instances', {})
          const items = Array.isArray(inventory?.instances) ? inventory.instances : (listed.instances ?? [])
          return ok(
            envelope({
              summary: items.length === 0
                ? '没有正在运行的 SOLIDWORKS 实例'
                : `正在运行 ${items.length} 个 SOLIDWORKS 实例：${items.map((item) => item.pid).join(', ')}`,
              designId: null,
              measurements: { count: items.length },
              changes: {
                instances: items,
                activePid: inventory?.activePid ?? listed.activePid ?? null,
                boundPid: bound?.pid ?? null,
                clientId: bound?.clientId ?? null,
                workers: inventory?.workers ?? null,
                registry: inventory?.registry ?? null,
                stale: inventory?.stale ?? null,
                policy: inventory?.policy ?? null,
                maxInstances: inventory?.maxInstances ?? null,
                reapGraceMs: inventory?.reapGraceMs ?? null,
                probeError: inventory?.probeError ?? null,
              },
              nextActions: items.length === 0
                ? ['用 job action="ensure" 让 broker 自动拉起并预热 SOLIDWORKS，再取实例']
                : ['把 pid 与启动时间记进 run 的 instance 引用；只对 broker 启动的实例执行退出',
                  '要收掉本服务启动的实例用 workspace action=reap（先 dryRun=true 看清单）'],
            }),
          )
        }
        case 'preflight': {
          // 开工体检：一次调用替掉 5–10 次侦察（status + instances + project + inspect + 上次 verify）。
          // 只读：不启动实例、不激活窗口、不改文档，也不打开任何文件。
          const started = Date.now()
          try {
            const designId = resolveDesignId(args.designId) ?? null
            const project = designId ? readProject(designId) : null
            const live = designId ? readLiveRecord({ dataDir: DATA_DIR, designId }) : null
            const notes = []
            let status = null
            try {
              status = await callBridge('status')
            } catch (error) {
              notes.push('桥接器 status 拿不到：' + (error?.message ?? error) + '（实例可能没起，swap 到 job action="ensure" 再试）')
            }
            let documents = []
            try {
              const listed = await callBridge('list')
              documents = Array.isArray(listed?.documents) ? listed.documents : []
            } catch (error) {
              notes.push('文档清单拿不到：' + (error?.message ?? error))
            }
            // 「哪一份是前台」只认桥接器给的标记；没有标记且不止一份时不猜（猜错的代价是
            // 在别人的文档上量尺寸）。raw 清单照样返回，调用方自己也能看。
            const flagged = documents.find((doc) => doc?.active === true || doc?.isActive === true) ?? null
            const active = flagged ?? (documents.length === 1 ? documents[0] : null)
            const activePath = typeof active?.path === 'string' && active.path.length > 0 ? active.path : null
            const activeTitle = typeof active?.title === 'string' && active.title.length > 0 ? active.title : null
            const activeType = activePath === null
              ? (active === null ? null : 'untitled')
              : (/\.sldasm$/i.test(activePath) ? 'assembly' : /\.slddrw$/i.test(activePath) ? 'drawing' : 'part')
            const document = active === null
              ? { available: documents.length, reason: documents.length > 1 ? 'MULTIPLE_DOCUMENTS_NO_ACTIVE_FLAG' : 'NO_DOCUMENT' }
              : { title: activeTitle, path: activePath, type: activeType, saved: activePath !== null }

            let binding = null
            if (designId !== null) {
              const registeredTitle = typeof live?.documentTitle === 'string' ? live.documentTitle : null
              const registeredPath = typeof live?.documentPath === 'string' ? live.documentPath : null
              const samePath = registeredPath !== null && activePath !== null
                ? registeredPath.toLowerCase() === activePath.toLowerCase()
                : null
              const sameTitle = registeredTitle !== null && activeTitle !== null ? registeredTitle === activeTitle : null
              binding = {
                designId,
                registeredTitle,
                registeredPath,
                activeTitle,
                activePath,
                consistent: samePath === true || sameTitle === true,
                reason: registeredTitle === null && registeredPath === null
                  ? 'NO_REGISTRATION'
                  : samePath === true ? 'PATH_MATCH' : sameTitle === true ? 'TITLE_MATCH' : 'MISMATCH',
              }
            }

            let broker = { enabled: process.env.SW_MCP_BROKER === '1', connected: false }
            if (broker.enabled) {
              try {
                const client = await sharedBroker()
                const bound = await client.request('instances.bound', { clientId: SW_CLIENT_ID }, { timeoutMs: 20_000 })
                const inventory = await client.request('instances.list', {}, { timeoutMs: 20_000 })
                broker = {
                  ...broker,
                  connected: true,
                  clientId: bound?.clientId ?? null,
                  boundPid: bound?.pid ?? null,
                  activePid: inventory?.activePid ?? null,
                  instanceCount: Array.isArray(inventory?.instances) ? inventory.instances.length : null,
                  workers: inventory?.workers ?? null,
                }
              } catch (error) {
                broker = { ...broker, connected: false, error: error?.message ?? String(error) }
              }
            }

            const definition = project?.definition ?? null
            const units = typeof definition?.units === 'string' && definition.units.length > 0 ? definition.units : 'mm'
            const template = project?.template ?? definition?.template ?? null
            const precision = project?.precision ?? definition?.precision ?? null
            if (template === null) notes.push('模板未记录：build 会走默认模板；要指定就传 model template')
            if (precision === null) notes.push('精度未记录：build 默认 precision="relations"')

            const activated = [...activatedCapabilities]
            const datums = Array.isArray(project?.datums) ? project.datums : []
            const lastVerify = live?.verify ?? null
            const lastDelivery = live?.delivery ?? null

            const nextActions = []
            if (active === null) {
              nextActions.push('还没有前台文档：workspace action="open" path=... 或 model action="create" 建一份（文档没激活时 build/deliver 会先自己激活并回读）')
            }
            if (binding !== null && binding.consistent !== true) {
              nextActions.push(binding.reason === 'NO_REGISTRATION'
                ? `designId=${designId} 还没有文档登记：先 build 或 workspace action="open" path=... designId=${designId} 把这份文档绑上`
                : `designId=${designId} 登记的是「${binding.registeredTitle ?? binding.registeredPath}」，前台是「${activeTitle ?? activePath}」：先确认要在哪份上量，别在别的文档上改尺寸`)
            }
            if (lastVerify === null) {
              nextActions.push('还没有验收记录：build 之后跑 inspect action="verify" tiers=[file,geometry,dimensions,positions,topology]（装配再加 assembly）')
            } else if (lastVerify.status === 'failed' || (Array.isArray(lastVerify.checks) && lastVerify.checks.some((row) => row?.pass === false))) {
              nextActions.push(`上次 verify（revision ${lastVerify.revision}）有失败项：先看回包里的 expected/actual 改设计，不要换 designId 或重跑碰运气`)
            } else if (lastVerify.status === 'incomplete' || (Array.isArray(lastVerify.unmeasured) && lastVerify.unmeasured.length > 0)) {
              nextActions.push('上次 verify 有 unmeasured 项：先补齐测量或先 deliver 一次让 design.json 里有期望值')
            }
            if (lastDelivery === null) {
              nextActions.push('还没交付过：verify 通过后 deliver kind="sldprt"，回包里有 bytes/mtimeMs 与落盘的 design.json')
            }
            if (designId !== null && datums.length === 0) {
              nextActions.push('要装配定位就先建基准：datum action="create" name=... kind=point|axis|plane|coordSys（名字稳定，重开不变）')
            }
            if (!activated.includes('assembly') && !activated.includes('assembly_inspect')) {
              nextActions.push('要动装配：catalog action="activate" capability="assembly"（再加 "assembly_inspect" / "datum"）')
            }

            const summary = `${activeTitle ?? activePath ?? '无前台文档'}`
              + `｜实例 ${status?.processId ?? '?'}（${broker.enabled ? 'broker' : 'bridge 直连'}）`
              + `｜designId ${designId ?? '未指定'}`
              + `｜上次 verify ${lastVerify?.status ?? '无'}`
              + `｜上次交付 ${lastDelivery === null ? '无' : (new Date(lastDelivery.at).toISOString ? '已交付' : '已交付')}`

            return ok(
              envelope({
                summary,
                designId,
                changes: {
                  document,
                  documents: documents.map((doc) => ({ title: doc?.title ?? null, path: doc?.path ?? null, active: doc === active })),
                  binding,
                  instance: {
                    pid: status?.processId ?? null,
                    state: status?.state ?? null,
                    message: status?.message ?? null,
                    runningProcessCount: status?.runningProcessCount ?? null,
                    channel: broker.enabled ? 'broker' : 'bridge',
                    broker,
                  },
                  units,
                  template,
                  precision,
                  capabilities: { activated, available: onDemandCapabilities() },
                  datums: { count: datums.length, names: datums.map((item) => item?.name).filter(Boolean) },
                  project: project === null ? null : {
                    step: project.step ?? null, revision: live?.revision ?? project.revision ?? null,
                    cadPath: project.cadPath ?? null, updatedAt: project.updatedAt ?? null,
                  },
                  lastVerify: lastVerify === null ? null : {
                    status: lastVerify.status ?? null,
                    at: lastVerify.at ?? null,
                    revision: lastVerify.revision ?? null,
                    checkCount: lastVerify.checkCount ?? (Array.isArray(lastVerify.checks) ? lastVerify.checks.length : null),
                    failed: Array.isArray(lastVerify.checks) ? lastVerify.checks.filter((row) => row?.pass === false).length : null,
                    unmeasured: Array.isArray(lastVerify.unmeasured) ? lastVerify.unmeasured.length : null,
                    summary: lastVerify.summary ?? null,
                  },
                  lastDelivery: lastDelivery === null ? null : {
                    at: lastDelivery.at ?? null,
                    kind: lastDelivery.kind ?? null,
                    path: lastDelivery.path ?? null,
                    bytes: lastDelivery.bytes ?? null,
                    approvedAtRevision: lastDelivery.approvedAtRevision ?? null,
                  },
                  notes,
                },
                nextActions: nextActions.length > 0 ? nextActions : ['状态干净：按任务书走 plan → build → 回读 → verify → deliver'],
                timings: { totalMs: Date.now() - started },
              }),
            )
          } catch (error) {
            return failed({ op: 'workspace.preflight', designId: args.designId, error })
          }
        }
        case 'brief': {
          // 一次看清「我在哪、这里有什么、本机有哪些设计」：替掉会话开头 5–6 次 ls/read。
          // 只读、无副作用；目录列到 40 项，设计只列最近 8 个，回包控制在 1–2 KB。
          const root = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : process.cwd()
          let entries = []
          try {
            entries = readdirSync(root, { withFileTypes: true })
              .filter((d) => !d.name.startsWith('.') && d.name !== 'node_modules')
              .slice(0, 40)
              .map((d) => (d.isDirectory() ? d.name + '/' : d.name))
          } catch (error) {
            return failed({
              op: 'workspace.brief', designId: null,
              error: fail('BAD_ARGUMENT', `读不了目录 ${root}：${error?.message ?? error}`, { path: root }),
            })
          }
          const designs = listProjects().slice(0, 8).map((p) => ({
            designId: p.designId, step: p.step ?? null, artifacts: p.artifacts, updatedAt: p.updatedAt ?? null,
          }))
          let instances = []
          try {
            const registry = JSON.parse(readFileSync(join(DATA_DIR, 'instances.json'), 'utf8'))
            instances = (registry.instances ?? []).map((i) => String(i.pid) + (i.tag ? '/' + i.tag : ''))
          } catch { /* 实例表可有可无 */ }
          return ok(
            envelope({
              summary: `${root}：${entries.length} 项；最近设计 ${designs.length} 个；SW 实例 ${instances.length} 个`,
              designId: null,
              changes: {
                path: root,
                cwd: process.cwd(),
                entries,
                designs,
                instances,
                active: [...activatedCapabilities],
              },
              nextActions: [
                '开工先 catalog action="focus" mode="part|modify|assembly|motion"',
                '接着做某个设计：workspace action="project" designId=...',
              ],
            }),
          )
        }
        case 'projects':
          return ok(
            envelope({
              summary: `本机记录 ${listProjects().length} 个设计项目`,
              designId: null,
              changes: { projects: listProjects() },
            }),
          )
        case 'project': {
          const id = resolveDesignId(args.designId)
          if (!id) return failed({ op: 'workspace.project', designId: null, error: fail('BAD_ARGUMENT', '需要 designId') })
          const project = readProject(id)
          if (!project) {
            return failed({
              op: 'workspace.project',
              designId: id,
              error: fail('PROJECT_NOT_FOUND', `没有记录过 ${id}`),
            })
          }
          rememberDesign(id)
          return ok(
            envelope({
              summary: `${id}：${project.step ?? '未知步骤'}`,
              designId: id,
              measurements: project.measurements,
              artifacts: project.artifacts,
              changes: { definition: project.definition, step: project.step, history: project.history },
            }),
          )
        }
        case 'resume': {
          const projects = listProjects()
          if (!projects.length) {
            return failed({
              op: 'workspace.resume',
              designId: null,
              error: fail('NO_PROJECT', '本机还没有记录过任何设计项目'),
            })
          }
          const latest = projects[0]
          const project = readProject(latest.designId)
          rememberDesign(latest.designId)
          return ok(
            envelope({
              summary: `接着 ${latest.designId} 继续：上一步是「${latest.step ?? '未记录'}」`,
              designId: latest.designId,
              measurements: project?.measurements,
              artifacts: project?.artifacts,
              changes: {
                definition: project?.definition ?? null,
                step: project?.step ?? null,
                lastCompletedStep: project?.history?.length ? project.history.at(-1) : null,
                historyLength: project?.history?.length ?? 0,
                otherProjects: projects.slice(1, 6),
              },
              nextActions: project?.step
                ? [`先 inspect 确认模型现状，再从「${latest.step}」之后继续`]
                : ['先 model action=build 建第一版模型'],
            }),
          )
        }
        case 'history': {
          const id = resolveDesignId(args.designId)
          if (!id) return failed({ op: 'workspace.history', designId: null, error: fail('BAD_ARGUMENT', '需要 designId') })
          const project = readProject(id)
          if (!project) {
            return failed({ op: 'workspace.history', designId: id, error: fail('PROJECT_NOT_FOUND', `没有记录过 ${id}`) })
          }
          rememberDesign(id)
          const history = Array.isArray(project.history) ? project.history : []
          return ok(
            envelope({
              summary: `${id} 有 ${history.length} 条步骤记录`,
              designId: id,
              changes: { step: project.step ?? null, history },
            }),
          )
        }
        case 'read': {
          if (!args.path) {
            return failed({ op: 'workspace.read', designId: null, error: fail('BAD_ARGUMENT', 'read 需要 path') })
          }
          // 白名单先过：越界/穿越/目录都在读任何字节之前就回错误码。
          const resolvedRead = resolveDataReadPath(args.path)
          if (!resolvedRead.ok) {
            return failed({ op: 'workspace.read', designId: null, error: resolvedRead.error })
          }
          const target = resolvedRead.path
          // Read line by line rather than slurping: these files include exported
          // catalogs that are far larger than a useful context window.
          const all = readFileSync(target, 'utf8').split(/\r?\n/)
          const slice = all.slice(args.offset, args.offset + args.limit)
          const more = args.offset + slice.length < all.length
          return ok(
            envelope({
              summary: `读了 ${slice.length} 行（第 ${args.offset + 1} 行起，共 ${all.length} 行）`,
              designId: null,
              changes: {
                path: target,
                totalLines: all.length,
                offset: args.offset,
                returned: slice.length,
                nextOffset: more ? args.offset + slice.length : null,
                text: slice.join('\n'),
              },
            }),
          )
        }
        case 'search': {
          if (!args.q) {
            return failed({ op: 'workspace.search', designId: null, error: fail('BAD_ARGUMENT', 'search 需要 q') })
          }
          const needle = args.q.toLowerCase()
          const noteHit = listNotes({ query: args.q, limit: 20 })
          const notes = noteHit.entries.map((n) => ({
            id: n.id,
            kind: n.kind,
            status: n.status,
            text: n.text,
          }))
          const projects = listProjects().filter((p) => JSON.stringify(p).toLowerCase().includes(needle))
          return ok(
            envelope({
              summary: `"${args.q}"：${notes.length} 条经验，${projects.length} 个项目`,
              designId: null,
              changes: { notes, projects },
              nextActions: notes.length
                ? ['workspace action=read path=<技能或日志文件> 可读全文']
                : ['没有命中；换一个关键词，或先 catalog action=search 找能力'],
            }),
          )
        }
        case 'reap': {
          // 回收走 broker：实例登记、空闲判定、文档关闭策略都在 broker 侧，
          // server 只做参数转发与报告，不自己数 pid —— 两处判定一定会漂。
          try {
            if (process.env.SW_MCP_BROKER !== '1') {
              throw fail('BROKER_REQUIRED', 'reap 需要 broker（SW_MCP_BROKER=1）：实例登记与回收策略都在 broker 侧')
            }
            const client = await sharedBroker()
            const result = await client.request('instances.reap', {
              tag: args.tag,
              dryRun: args.dryRun === true,
              // 不传就让 broker 用它的默认（true）；显式 false 才表示「只退实例、先不关文档」。
              includeDocs: args.includeDocs === undefined ? undefined : args.includeDocs,
              force: args.force === true,
              graceMs: args.graceMs,
              reason: args.reason,
              ...instanceRequestParams(),
            }, { timeoutMs: 120_000 })
            const reaped = Array.isArray(result?.reaped) ? result.reaped : []
            const skipped = Array.isArray(result?.skipped) ? result.skipped : []
            return ok(
              envelope({
                summary: result?.dryRun
                  ? `reap（dryRun）：将回收 ${reaped.length} 个实例、跳过 ${skipped.length} 个`
                  : `reap 完成：回收 ${reaped.length} 个实例，跳过 ${skipped.length} 个；关闭文档 ${result?.closedDocs ?? 0} 个，退出实例 ${result?.quitInstances ?? 0} 个`,
                designId: null,
                measurements: {
                  reaped: reaped.length,
                  skipped: skipped.length,
                  closedDocs: result?.closedDocs ?? 0,
                  quitInstances: result?.quitInstances ?? 0,
                },
                changes: result,
                nextActions: skipped.length > 0
                  ? ['有实例没被回收（多为用户实例或正忙）；原因在 changes.skipped，不要 force 掉用户的 SOLIDWORKS',
                    'workspace action=instances 复查剩余实例']
                  : ['workspace action=instances 确认实例已减少'],
              }),
            )
          } catch (error) {
            return failed({ op: 'workspace.reap', designId: null, error })
          }
        }
        case 'quit': {
          try {
            if (process.env.SW_MCP_BROKER === '1') {
              // 只退本会话绑定的那个实例；用户自己开的不动。没有绑定就明确失败，
              // 绝不退回「杀所有文档 + 退出」的旧路径 —— 那会带走用户的会话。
              const client = await sharedBroker()
              const result = await client.request('instances.quit', {
                force: args.force === true,
                ...instanceRequestParams(),
              }, { timeoutMs: 120_000 })
              return ok(
                envelope({
                  summary: `已退出本会话绑定的 SOLIDWORKS 实例${result?.pid ? `（pid ${result.pid}）` : ''}`,
                  designId: null,
                  changes: result,
                  nextActions: [
                    '只退了绑定实例；用户自己开的 SOLIDWORKS 不受影响',
                    '要按 tag/空闲时间全局回收用 workspace action=reap（先 dryRun=true 看清单）',
                  ],
                }),
              )
            }
            const result = await callBridge('quit', {})
            return ok(
              envelope({
                summary: `已关闭 ${result.closedCount} 个文档并请求退出 SOLIDWORKS`,
                changes: { closedDocuments: result.closedDocuments },
                nextActions: [
                  'SOLIDWORKS 退出需要几秒；确认进程消失用 workspace action="status"',
                ],
              }),
            )
          } catch (error) {
            return failed({ op: 'workspace.quit', designId: null, error })
          }
        }
        case 'reload': {
          const before = {
            path: config.bridgeExe,
            version: null,
          }
          try {
            const v = await callBridge('version')
            before.version = v.bridge
          } catch (error) {
            before.version = null
            before.error = error.code ?? String(error.message)
          }
          // Dropping the child is the whole reload: the next call spawns whatever
          // newestBridge() resolves to, and a user's open documents are untouched
          // because the bridge never owned them.
          if (child && !child.killed) child.kill()
          child = null
          config.bridgeExe = newestBridge()
          let afterVersion = null
          let afterError = null
          try {
            const v = await callBridge('version')
            afterVersion = v.bridge
          } catch (error) {
            afterError = error.code ?? String(error.message)
          }
          const changed = before.path !== config.bridgeExe || before.version !== afterVersion
          return ok(
            envelope({
              summary: changed
                ? `桥接器已切换：${before.version ?? '未知'} → ${afterVersion ?? '未连上'}`
                : `桥接器已是磁盘上最新的（${afterVersion ?? '未连上'}）`,
              designId: null,
              status: afterError ? 'unavailable' : 'ok',
              changes: {
                before,
                after: { path: config.bridgeExe, version: afterVersion, error: afterError },
                switched: changed,
              },
              nextActions: afterError ? ['桥接器没起来，检查 bridge/bin 下是否有 SwBridge.exe'] : [],
            }),
          )
        }
        case 'logs': {
          const filter = args.log ?? {}
          const page = readEvents({
            limit: args.logLimit ?? 50,
            offset: args.logOffset ?? 0,
            level: filter.level,
            tool: filter.tool,
            code: filter.code,
            correlationId: filter.cid,
            since: filter.since,
          })
          const errors = page.events.filter((e) => e.level === 'error').length
          return ok(
            envelope({
              summary: page.total === 0
                ? `没有符合条件的日志（目录 ${LOG_DIR}）`
                : `最近 ${page.events.length} 条日志（共 ${page.total} 条，其中 ${errors} 条是错误）`,
              designId: null,
              changes: {
                events: page.events,
                total: page.total,
                offset: page.offset,
                nextOffset: page.nextOffset,
                files: page.files,
                directory: LOG_DIR,
                filter,
              },
              nextActions: page.total === 0
                ? ['日志目录是空的说明这个进程还没被调用过；确认调用的是同一个 MCP 进程']
                : page.nextOffset !== null
                  ? [`再看下一页：action="logs", logOffset=${page.nextOffset}`]
                  : [],
            }),
          )
        }
        case 'lesson':
          return handleLesson(args.lesson ?? { action: 'search' })
        case 'closePath': {
          const prefix = args.pathPrefix
          if (!prefix) throw fail('BAD_ARGUMENT', 'closePath 需要 pathPrefix（要关掉的目录）')
          const result = await callBridge('close', {
            pathPrefix: prefix,
            untitled: args.untitled !== false,
          })
          // 批量关掉的文档一次销账，否则账本里会一直记着已经不存在的标题。
          forgetSessionDocs(Array.isArray(result.closed) ? result.closed : [])
          return ok(
            envelope({
              summary: `关掉 ${result.closedCount ?? 0} 个文档（${prefix} 下的，以及未命名的）`
                + `，还剩 ${result.remaining} 个`,
              designId: null,
              changes: { closed: result.closed, closedCount: result.closedCount, remaining: result.remaining },
            }),
          )
        }
        case 'cleanup': {
          // 会话级回收只清「本服务自己建出来的」：桥接器按 registry 里的 origin
          // （build/create）与会话 id 过滤，来源不明的条目（旧版本写的行、历史会话
          // 留下的 零件N）一律跳过并在 skippedUnknown 里报数 —— 那是「我为什么没关
          // 那几个」的自证。绝不把「无路径」当成本服务的。
          const cleanupDesignId = args.designId ?? null
          const laneSession = clientIdFor(cleanupDesignId ?? null)
          const result = await callBridge('cleanup',
            cleanupDesignId ? { designId: cleanupDesignId, sessionId: laneSession } : { sessionId: laneSession })
          // 只销返回里真关掉的那些标题，绝不整表 clear()：没关掉的条目必须留着，
          // 否则它们会永久失去被后续按标题清扫收掉的资格。
          forgetSessionDocs(cleanupClosedTitles(result))
          const skippedUnknown = Number(result?.skippedUnknown ?? 0)
          const skippedOtherSession = Number(result?.skippedOtherSession ?? 0)
          const closedCount = Array.isArray(result?.closed) ? result.closed.length : 0
          const notes = [
            skippedUnknown > 0
              ? `跳过 ${skippedUnknown} 个来源不明的未存盘文档（不是本服务建的，未关闭）`
              : null,
            skippedOtherSession > 0 ? `跳过 ${skippedOtherSession} 个属于其他会话的文档` : null,
          ].filter(Boolean)
          const scope = cleanupDesignId ? `只收 designId="${cleanupDesignId}" 的文档` : '如需只按某个设计收，传 designId'
          return ok(
            envelope({
              summary: `关掉 ${closedCount} 个未保存文档，剩 ${result?.remaining ?? 0} 个打开`
                + (notes.length ? `；${notes.join('；')}` : '')
                + `；${scope}`,
              designId: cleanupDesignId,
              changes: {
                closed: result?.closed,
                remaining: result?.remaining,
                skippedUnknown,
                skippedOtherSession,
              },
            }),
          )
        }
        case 'reclaim': {
          const keepMs = Number(args.keepMs ?? 24 * 3600_000)
          const roots = new Set()
          const artifactPaths = new Set()
          try {
            for (const name of readdirSync(PROJECTS_DIR)) {
              if (!name.endsWith('.json')) continue
              try {
                const p = JSON.parse(readFileSync(join(PROJECTS_DIR, name), 'utf8'))
                if (p.designId) roots.add(p.designId)
                for (const artifact of p.artifacts ?? []) if (artifact?.path) artifactPaths.add(artifact.path)
              } catch { }
            }
          } catch { }
          const listed = await callBridge('list')
          const documents = Array.isArray(listed.documents) ? listed.documents : []
          // 桥接器的 list 只带标题；designId 登记在 exe 旁的 state/documents.json。
          const titleToId = new Map()
          try {
            const registry = JSON.parse(readFileSync(join(dirname(config.bridgeExe), 'state', 'documents.json'), 'utf8'))
            for (const entry of Object.values(registry)) {
              if (entry?.title && entry?.designId) titleToId.set(entry.title, entry.designId)
            }
          } catch { }
          const closed = []
          const kept = []
          for (const document of documents) {
            const designId = document.designId ?? titleToId.get(document.title) ?? null
            const referenced = (designId && roots.has(designId))
              || (document.path && artifactPaths.has(document.path))
            // A saved file and a dirty editor buffer are both user data, even when
            // no project json points at them. Reclaim must never discard either.
            const saved = Boolean(document.path)
            const dirty = document.dirty === true
            if (referenced || !designId || saved || dirty) {
              const reason = referenced ? 'project'
                : saved ? 'saved-document'
                  : dirty ? 'dirty-document' : 'user-document'
              kept.push({ title: document.title, designId, reason })
              continue
            }
            try {
              const result = await callBridge('close', { title: document.title })
              if (result.found) closed.push({ title: document.title, designId })
              else kept.push({ title: document.title, designId, reason: 'close-failed' })
            } catch (error) {
              kept.push({ title: document.title, designId, reason: error.code ?? 'close-error' })
            }
          }
          let removedFiles = 0
          const tmpDir = join(DATA_DIR, 'tmp')
          try {
            for (const name of readdirSync(tmpDir)) {
              if (!/^diff-.*\.step$/.test(name)) continue
              const path = join(tmpDir, name)
              try {
                if (Date.now() - statSync(path).mtimeMs > keepMs) { unlinkSync(path); removedFiles++ }
              } catch { }
            }
          } catch { }
          return ok(
            envelope({
              summary: `引用图：${roots.size} 个项目为根；关闭无引用文档 ${closed.length} 个，保留 ${kept.length} 个；回收临时 STEP ${removedFiles} 个`,
              designId: null,
              changes: { roots: roots.size, closed, kept, removedFiles, keepMs },
              nextActions: kept.length ? ['保留项里 user-document 是用户自己打开的；project 是仍有项目引用的'] : [],
            }),
          )
        }
        case 'open': {
          if (!args.path) throw fail('BAD_ARGUMENT', 'open 需要 path')
          // 通道归位：open 不带 designId 时 laneSeed 为空，会落到默认通道；随后
          // inspect/mate 带着 designId 走另一条通道，两步落在不同 SOLIDWORKS 实例上，
          // 第二步报 DOC_NOT_OPEN（实测 ASM-09：open 成功、inspect 说没打开）。
          // 按文件名反推 designId（ASM-09.SLDASM → ASM-09），让 open 与后续操作同通道。
          const openDesignId = resolveDesignId(args.designId)
            ?? resolveDesignId(basename(String(args.path)).replace(/\.[^.]+$/, ''))
          const result = await callBridge('open', { path: args.path, ...(openDesignId ? { designId: openDesignId } : {}) })
          return ok(
            envelope({
              summary: `已打开 ${result.activeTitle ?? args.path}`,
              designId: openDesignId,
              changes: result,
              nextActions: ['用 inspect action=model 回读特征树与方程'],
            }),
          )
        }
        case 'close': {
          if (!args.title) return failed({ op: 'workspace.close', designId: null, error: fail('BAD_ARGUMENT', 'close 需要 title') })
          const result = await callBridge('close', { title: args.title })
          // 关掉的正是账本里的文档就立刻销账，免得下次清扫去关一个已经不存在的窗口。
          forgetSessionDocs([
            ...(Array.isArray(result.closed) ? result.closed : []),
            ...(result.found ? [args.title] : []),
          ])
          return ok(
            envelope({
              summary: result.found ? `已关闭 ${args.title}` : `没有找到 ${args.title}`,
              designId: null,
              changes: result,
            }),
          )
        }
        default: {
          const started = Date.now()
          let sw = null
          let ready = false
          let statusSource = 'bridge'
          try {
            sw = await callBridge('status')
            ready = !!sw?.ready
          } catch (error) {
            sw = { ready: false, reason: error.code ?? 'UNKNOWN', message: error.message }
          }
          // 假阴性：开了 broker 的会话，本地那条桥接器是**故意未绑定**的（ExpectedPid=0，
          // fail-closed），于是 status 恒回 INSTANCE_NOT_BOUND —— 而同一个会话的
          // build/inspect 全部走 broker、真的在跑。实测过：status 连报「不可用」，
          // 紧接着 build 成功建出 1000 mm³ 的件。这种读数会让人以为环境坏了。
          //
          // 所以本地说「没绑定」时，再问一次 broker（不 ensure：探活不该顺手拉起 SOLIDWORKS）。
          // 两个来源分别标注，谁答的就写谁。
          if (!ready && process.env.SW_MCP_BROKER === '1') {
            const reason = String(sw?.reason ?? sw?.code ?? '')
            if (/INSTANCE_NOT_BOUND|not.?bound/i.test(reason)) {
              try {
                const viaBroker = await sendViaBroker('status', {})
                if (viaBroker && typeof viaBroker === 'object') {
                  sw = { ...viaBroker, localBridge: { ready: false, reason } }
                  ready = !!viaBroker.ready
                  statusSource = 'broker'
                }
              } catch (error) {
                // broker 也答不上来：把两边的说法都留下，别只报最后一句。
                sw = {
                  ...sw,
                  broker: { ready: false, code: error?.code ?? 'UNKNOWN', message: error?.message ?? String(error) },
                  action: sw?.action,
                }
              }
            }
          }
          const lessons = notesForStatus()
          return ok(
            envelope({
              summary: ready
                ? `SOLIDWORKS ${sw.revision} 已连接，${sw.documents?.length ?? 0} 个文档打开`
                  + (statusSource === 'broker' ? '（本会话绑在 broker 的实例上；本地桥接器按设计未绑定）' : '')
                : `SOLIDWORKS 不可用（${sw.reason ?? sw.code}）：${sw.message ?? '经验库仍然可用'}`,
              designId: resolveDesignId(args.designId),
              status: ready ? 'ok' : 'unavailable',
              capabilities: { ...capabilitiesPayload(sw), skills: skillPaths() },
              changes: {
                ...(lessons ? { lessons } : {}),
                statusSource,
                ...(ready ? {} : { environment: sw }),
              },
              timings: { statusMs: Date.now() - started },
              nextActions: ready
                ? [
                  'catalog action=sources 看本机能做什么',
                  '用 model action=build 从设计定义直接建模',
                ]
                : Array.isArray(sw.action) && sw.action.length
                  ? sw.action
                  : nextActionsFor(fail(sw.reason ?? 'not-running', '')),
            }),
          )
        }
      }
    } catch (error) {
      return failed({ op: `workspace.${args.action}`, designId: args.designId, error })
    }
  },
)

// ------------------------------------------------------------------ model action=create

async function handlePartCreate(args) {
  try {
    // 换 designId 建的空白零件同样没人收：create 建的文档上一轮起已进桥接器 registry
    // （RegisterCreated，designId "created:<标题>"），但换 id 之前建的那份仍是旧账，
    // newDocument 又只会再堆一个，所以先还前账再建新的。清扫失败不阻断建文档。
    // 自己的 id 也登记 in-flight，且**在清扫之前**：清扫到一半时别的会话不该把
    // 这个 id 名下的旧文档当「没人要」关掉。出口只有 finally 一处，异常也不会漏账。
    inFlightBegin(args.designId)
    try {
      const sweptOthers = await sweepOtherDesigns(args.designId)
      // designId 必须往下传，理由与 model action="assemble" 那处完全一样：桥接器的
      // RegisterCreated 用它当 WorkRegistry 的键，拿不到就退回 "created:" + 标题。
      // newDocument 走的就是 RegisterCreated（Operations.cs:152），未存盘时标题是
      // 「零件N」，于是登记键成了 created:零件N —— 而之后 inspect/save 走
      // RequireDesignDocument → DesignDocument，是**按 designId 精确查这张表**的，
      // 用户那个 designId 永远查不到，报 DOC_NOT_OPEN。
      //
      // 注意 sessionDocs 不是这条链的替代：trackSessionDoc 写的 sessionDocs 只服务
      // sweepOtherDesigns/cleanup，而 RequireDesignDocument 读的是桥接器侧的
      // WorkRegistry —— 两张不同的表，补 sessionDocs 救不了 DOC_NOT_OPEN。
      const createdDesignId = resolveDesignId(args.designId)
      const result = await callBridge('newDocument', {
        template: args.template,
        ...(createdDesignId ? { designId: createdDesignId } : {}),
      })
      rememberDesign(args.designId)
      // 新文档立刻进账本：它是本会话的中间产物，等用户存盘才移出。
      // 用 createdDesignId 而不是 args.designId：两者对「用户真传了值」是同一个字符串，
      // 但没传时前者是 null、后者是 undefined，而 trackSessionDoc 的 !designId 守卫
      // 对两者都直接 return —— 行为一致。这里统一成解析后的值，是为了让「键就是
      // 桥接器登记用的那个 designId」在源码上一眼看得见，将来谁改 registry 不用再猜。
      trackSessionDoc(createdDesignId, result.document)
      return ok(
        envelope({
          summary: `已建空白零件 ${result.document.title}`,
          designId: args.designId,
          changes: { document: result.document, sweptPreviousDesigns: sweptOthers },
          nextActions: ['用 model action=build 建完整模型；空文档里没有特征，inspect action=model 只会返回空树'],
        }),
      )
    } finally {
      inFlightEnd(args.designId)
    }
  } catch (error) {
    return failed({ op: 'model.create', designId: args.designId, error })
  }
}

// ------------------------------------------------------------------ model action=plan

/** plan/build 共用的草图选项：只在一处归一化，两处判定才不会漂。 */
function sketchOptionsFrom(args) {
  return {
    precision: args.precision === 'coordinate' ? 'coordinate' : 'relations',
    output: 'sketch',
    assumptions: Array.isArray(args.assumptions) ? args.assumptions : [],
    acceptedAssumptions: Array.isArray(args.acceptedAssumptions) ? args.acceptedAssumptions : [],
    dimensions: Array.isArray(args.dimensions) ? args.dimensions : [],
    allowOpen: args.allowOpen === true,
    requireDimensions: args.requireDimensions === true,
  }
}

/** 齿轮展开是纯数据变换；plan 与 build 必须看同一份特征，不能各看各的。 */
function sketchPlanFor(definition, args) {
  return planSketch(definition, sketchOptionsFrom(args))
}

function planBlockedError(plan, op) {
  const first = plan?.blockers?.[0]
  return failed({
    op,
    error: fail(
      first?.code ?? 'PLAN_NOT_READY',
      first?.message ?? `草图计划不可构建：${plan?.blockers?.length ?? 0} 个阻断项`,
      {
        blockers: plan?.blockers ?? [],
        openEnds: plan?.openEnds ?? [],
        missingRelations: plan?.missingRelations ?? [],
        fitViolations: plan?.fitViolations ?? [],
        assumptions: plan?.assumptions ?? [],
      },
    ),
  })
}

async function handlePlan(args) {
  // 传输层偶尔把 definition 变成 JSON 字符串：先还原成对象再取 designId/校验，
  // 否则 designId 会丢，normalizeDesign 只看到字符下标（报“缺少 features 数组”）。
  const definitionArg = coerceDefinition(args.definition)
  const designId = definitionArg?.designId ?? resolveDesignId(args.designId) ?? null
  const started = Date.now()
  try {
    if (!definitionArg || typeof definitionArg !== 'object') {
      throw fail('BAD_ARGUMENT', 'plan 需要 definition：先有设计定义，再谈能不能建')
    }
    const definition = normalizeDesign(definitionArg, designId ?? `plan-${Date.now()}`)
    const builtDefinition = expandNativeGear(definition) ?? expandGearPrimitives(definition)
    const plan = sketchPlanFor(builtDefinition, args)
    if (designId !== null) rememberDesign(designId)
    const ready = plan.ready === true
    return ok(
      envelope({
        summary: describePlan(plan),
        designId,
        status: ready ? 'ok' : 'blocked',
        changes: { ready, plan },
        nextActions: ready
          ? [
            'model action=build + output="sketch"，definition/precision/assumptions 与这次 plan 完全一致',
            'build 后 inspect action=relations 回读，再 inspect action=verify 对照图纸',
          ]
          : plan.blockers.slice(0, 6).map((blocker) => `${blocker.code}: ${blocker.message}`)
            .concat(['按 blockers 修设计定义（补关系/圆心/标注，或删掉像素尺寸）后重新 plan；ready=true 才 build']),
        capabilities: { ready },
        timings: { totalMs: Date.now() - started },
      }),
    )
  } catch (error) {
    return failed({ op: 'model.plan', designId, error })
  }
}

// ------------------------------------------------------------------ model action=build

/**
 * 实体零件的成功判据：真的量到体积。
 *
 * 一次 build 每跳都返回了东西却没长出实体时，「已建成」是最坏的报告：空件会被
 * 存盘、被装配，而报告里唯一的破绽就是体积。
 */
function assertPartBuild(result) {
  const volume = result.geometry?.massProperties?.volume
  if (typeof volume === 'number' && volume > 0) return null
  return fail('EMPTY_MODEL', `建完之后体积是 ${volume ?? 'null'} —— 没有实体的模型不能算建成`, {
    features: result.features,
    notes: result.notes,
    hint: '检查每个 sketch 的 curves（line/circle/arc/ellipse/ellipticArc/spline/equationCurve/polyline）或 primitives（rect / circle / polyline / polygon / gear（仅原生齿形））；'
      + '键名写错时不会报错，只会画出一个空草图',
  })
}

/** 仅草图的成功判据：闭合 + 关系审计 gaps 为空 + rejected 为 0 + 假设已确认。 */
function assertSketchBuild(result, options) {
  const check = sketchBuildCheck(result, {
    assumptions: options?.assumptions ?? [],
    acceptedAssumptions: options?.acceptedAssumptions ?? [],
  })
  if (check.ok) return null
  return fail(check.error.code, check.error.message, check.error.detail)
}

async function handlePartBuild(args) {
  // 传输层偶尔把 definition 变成 JSON 字符串（模型把对象 stringify 了一次）：
  // 先还原，否则 designId 会退化成 design-<时间戳>，normalizeDesign 也只能看到
  // 字符下标，最后报“设计定义缺少 features 数组”。解析失败保持原样走原报错。
  const definitionArg = coerceDefinition(args.definition)
  // The definition names the design; the remembered id is only a fallback.
  // Getting this backwards made a build of m3-shaft record itself as m3-hexagon.
  const designId = definitionArg?.designId ?? resolveDesignId(args.designId) ?? `design-${Date.now()}`
  const started = Date.now()
  // output/precision/assumptions 是「怎么算成功」的一部分，必须在碰 SOLIDWORKS 之前定下来。
  const output = args.output === 'sketch' ? 'sketch' : 'part'
  const precision = args.precision === 'coordinate' ? 'coordinate' : 'relations'
  const assumptions = Array.isArray(args.assumptions) ? args.assumptions : []
  const acceptedAssumptions = Array.isArray(args.acceptedAssumptions) ? args.acceptedAssumptions : []
  const cooldownUntil = buildCooldown.get(designId) ?? 0
  if (cooldownUntil > Date.now()) {
    return failed({
      op: 'model.build',
      designId,
      error: fail('BUILD_IN_PROGRESS',
        `${designId} 的上一次 build 超时了，SOLIDWORKS 可能还在建：不要再排第二次（会把两台作业叠在一起，两个都超时）。`
        + `等 ${Math.ceil((cooldownUntil - Date.now()) / 1000)} 秒后用同一个 designId 重试，或先 inspect / workspace 看这份设计当前的状态。`,
        { designId, retryAfterMs: cooldownUntil - Date.now() }),
    })
  }
  // 单飞：这一件已经在建时，第二次调用立刻回 BUILD_IN_PROGRESS，不再排队。
  if (activeBuildDesigns.has(designId)) {
    return failed({
      op: 'model.build',
      designId,
      error: fail('BUILD_IN_PROGRESS',
        `${designId} 这一件正在建：重复提交只会排在后面再建一遍（实测串行两遍各 40 秒）。`
        + '等它返回，或先 workspace / inspect 看当前进度。',
        { designId, running: true }),
    })
  }
  activeBuildDesigns.add(designId)
  try {
    const definition = normalizeDesign(definitionArg, designId)
    const requestedGear = gearSpecs(definition)
    if (output === 'sketch' && precision !== 'relations') {
      return failed({
        op: 'model.build',
        designId,
        error: fail('RELATIONS_REQUIRED', 'precision="coordinate" 的坐标草稿只能用来核对形状，不能 build：交付的草图必须 precision="relations"', {
          hint: '给草图补几何关系后改成 precision="relations"，或者先用坐标草稿 model action=plan 看差异',
        }),
      })
    }
    const nativeDefinition = expandNativeGear(definition)
    const builtDefinition = nativeDefinition ?? expandGearPrimitives(definition)
    // 仅草图：先跑同一份 plan（纯 Node），计划不通过就绝不碰 SOLIDWORKS。
    const plan = output === 'sketch' ? sketchPlanFor(builtDefinition, args) : null
    if (plan !== null && plan.ready !== true) return planBlockedError(plan, 'model.build')
    // 每次 build 都会新开一个文档。迭代时（锁盖那次实测 零件12/13/19/21）
    // 旧文档既不关也不存，窗口和内存一路涨，而且「上一次的件」还留着脏状态。
    // 先收掉本服务建过、还没存盘、**已经被同 id 新文档换下来**的那几份：
    // 设计定义在 projects/ 里，重建只要几秒。别的 designId 名下还开着的文档
    // 不在此列 —— 那是这个会话里另一个活的件，不是前账（D3：连续 build A、B
    // 时 B 把 A 关掉，A 从此 DOC_NOT_OPEN）。
    //
    // 换过 designId 的会话要分两步收：下面这个 cleanup 只认「本 id 登记的那一个」，
    // 历史 id 留在会话账本里，得靠 sessionDocs 才收得掉。清扫失败不阻断本次构建。
    // in-flight 里登记本 id：别的 build 正在用同一个 id 时不要把它当旧账收掉。
    // 顺序很关键 —— 先 begin（计数 +1）再 sweep：反过来的话，两次同 id 并发构建中
    // 先 begin 的那次一完成就销了标记，另一个仍在建的文档会被第三方清扫关掉。
    inFlightBegin(designId)
    const sweptOthers = await sweepOtherDesigns(designId)
    let closed = []
    try {
      const swept = await callBridge('cleanup', { designId: definition?.designId })
      closed = Array.isArray(swept?.closed) ? swept.closed : []
    } catch {
      // 清理失败不影响这次构建 —— 但要在返回里说一声，不能装作没发生。
      closed = []
    }
    const result = await buildWithPatterns(
      output === 'sketch' ? { ...builtDefinition, output: 'sketch' } : builtDefinition,
      { template: args.template },
    )
    buildCooldown.delete(designId)

    // 仅草图：成功判据是闭合 + 关系全部落地 + 假设已确认。没有体积这回事。
    if (output === 'sketch') {
      const sketchError = assertSketchBuild(result, { assumptions, acceptedAssumptions })
      if (sketchError !== null) {
        inFlightEnd(designId)
        activeBuildDesigns.delete(designId)
        return failed({
          op: 'model.build',
          designId,
          error: fail(sketchError.code, sketchError.message, {
            ...sketchError.detail,
            plan: plan?.blockers ?? [],
          }),
        })
      }
      const finished = finishSketchBuild({
        designId, started, closed, plan, result, builtDefinition, assumptions, acceptedAssumptions, sweptOthers,
      })
      inFlightEnd(designId)
      activeBuildDesigns.delete(designId)
      return finished
    }

    const volume = result.geometry?.massProperties?.volume
    const box = result.geometry?.boundingBox?.size
    const holes = result.geometry?.holes ?? []

    // A build that produced no solid is a failure, even though every call it made
    // returned something. Saying "已建成" here is how an empty part got saved and
    // then assembled: the report was the only thing that looked wrong.
    const partError = assertPartBuild(result)
    if (partError !== null) {
      inFlightEnd(designId)
      activeBuildDesigns.delete(designId)
      return failed({ op: 'model.build', designId, error: partError })
    }

    // 存档：设计定义 + 这次量到的数字 + 已绑定的原生尺寸
    writeProject({
      designId,
      goal: designSummary(builtDefinition),
      step: 'built',
      updatedAt: new Date().toISOString(),
      definition: builtDefinition,
      // holePositions 是三维孔心：edit 里 holesMoved 靠它判断「孔位/孔距变了」。
      // 只存孔数时，孔距 60→62（体积、包围盒都不变）会被误判成「没改到」。
      measurements: { volume, boundingBox: box, holes: holes.length, holePositions: holeVectors(holes) },
      artifacts: [],
      bindings: result.bindings ?? {},
      dimensionBindings: result.dimensionBindings ?? {},
      drivers: result.drivers ?? null,
      history: [{ at: new Date().toISOString(), action: 'build', volume }],
    })
    rememberDesign(designId)
    // 刚建成的文档进账本：下次换 designId 时它就是要被收掉的那个。
    trackSessionDoc(designId, result.document)

    const nextActions = nextActionsForBuild(result)
    if (builtDefinition.gearNative) {
      nextActions.unshift('齿轮用原生圆周阵列建成：改齿数/模数要改设计定义后重建；pattern 是特征树里的原生阵列特征')
    } else if (requestedGear.length > 0) {
      nextActions.unshift('齿轮走圆柱+一个齿槽切除+原生圆周阵列（禁止折线拟合）；改齿数/模数要改设计定义后重建')
    }
    const buildShots = await autoShots(designId, 'build')
    inFlightEnd(designId)
    activeBuildDesigns.delete(designId)
    const response = ok(
      envelope({
        summary: `已建成 ${designId}：体积 ${volume} mm³，包围盒 ${box?.join('×')} mm`,
        designId,
        status: result.notes?.length ? 'ok' : 'ok',
        changes: {
          document: result.document,
          // build 的目标文档是它自己新建的那一份（桥接器 RegisterCreated 绑定 designId 并激活）。
          // 这里把「激活」写成可回读的事实，而不是让调用方猜。
          activation: result.document
            ? { active: true, title: result.document.title ?? null, path: result.document.path ?? null,
              note: 'build 新建的文档由 RegisterCreated 绑定 designId，创建时即为前台；读取一律按 designId，不按前台' }
            : { active: false, note: '桥接器没有回文档信息：先 inspect action="model" 确认前台是哪一份再继续' },
          instanceId: result.instanceId ?? null,
          documentId: result.document?.path || (result.document?.title ? `unsaved#${result.document.title}` : null),
          closedUnsaved: closed,
          sweptPreviousDesigns: sweptOthers,
          features: result.features,
          sketchPlaneMapping: result.sketchPlaneMapping ?? null,
          autoShots: buildShots.map((shot) => ({ path: shot.path, view: shot.view })),
          bindings: result.bindings,
          dimensionBindings: result.dimensionBindings ?? {},
          drivers: result.drivers ?? null,
          derivedVariables: result.derivedVariables,
          notes: result.notes,
          gear: builtDefinition.gearNative ? {
            count: 1,
            mode: 'native-pattern',
            reason: '圆柱 + 一个齿槽切除 + 原生圆周阵列（FeatureCircularPattern5）',
            teeth: [builtDefinition.gearNative.teeth],
            module: [requestedGear[0]?.module ?? 2],
            pattern: result.patterns?.[0]?.pattern ?? null,
          } : undefined,
        },
        measurements: { volume, boundingBox: box, holes: holes.map(shapeHole) },
        artifacts: args.imagePath ? [{ kind: 'image', path: args.imagePath }] : [],
        capabilities: { boundParameters: Object.keys(result.bindings ?? {}).length },
        timings: { totalMs: Date.now() - started },
        nextActions,
        extra: { builderSteps: result.builderSteps, equations: undefined },
      }),
    )
    if (buildShots.length > 0) response.content.push(...imageContent(buildShots))
    return response
  } catch (error) {
    inFlightEnd(designId)
    activeBuildDesigns.delete(designId)
    if (error?.code === 'SW_TIMEOUT') buildCooldown.set(designId, Date.now() + BUILD_COOLDOWN_MS)
    return failed({ op: 'model.build', designId, error })
  }
}

/**
 * 仅草图构建成功后的收尾：写项目、记 live 审计（trackLive 会从这里读）、给下一步。
 *
 * 这里不量体积、不做 extrude —— 任务就是一张草图。把「草图件」和「实体件」
 * 分开记（step:"sketch-built"），交付门禁才认得出来这是只允许图纸校核的产物。
 */
function finishSketchBuild({ designId, started, closed, plan, result, builtDefinition, assumptions, acceptedAssumptions, sweptOthers = [] }) {
  const sketch = result.sketch ?? {}
  const relationAudit = result.relationAudit ?? sketch.relationAudit ?? null
  const segments = Array.isArray(sketch.segments) ? sketch.segments : []
  const relations = Array.isArray(sketch.relations) ? sketch.relations : []
  const segmentCount = Number.isFinite(Number(sketch.segmentCount)) ? Number(sketch.segmentCount) : segments.length
  writeProject({
    designId,
    goal: designSummary(builtDefinition),
    step: 'sketch-built',
    updatedAt: new Date().toISOString(),
    definition: builtDefinition,
    measurements: {
      closed: sketch.closed === true,
      segments: segmentCount,
      relations: relations.length,
      openEnds: Number(sketch.openEnds ?? 0),
    },
    artifacts: [],
    bindings: result.bindings ?? {},
    dimensionBindings: result.dimensionBindings ?? {},
    drivers: result.drivers ?? null,
    assumptions,
    acceptedAssumptions,
    history: [{
      at: new Date().toISOString(),
      action: 'build-sketch',
      closed: sketch.closed === true,
      relations: relations.length,
    }],
  })
  rememberDesign(designId)
  trackSessionDoc(designId, result.document)
  return ok(
    envelope({
      summary: `草图已建 ${designId}：${segmentCount} 段，closed=${sketch.closed === true}，关系 ${relations.length} 条`,
      designId,
      changes: {
        kind: 'sketch',
        document: result.document,
        instanceId: result.instanceId ?? null,
        documentId: result.document?.path || (result.document?.title ? `unsaved#${result.document.title}` : null),
        closedUnsaved: closed,
        sweptPreviousDesigns: sweptOthers,
        sketch,
        sketchPlaneMapping: result.sketchPlaneMapping ?? null,
        relationAudit,
        applied: result.applied,
        rejected: result.rejected,
        plan,
        notes: result.notes,
      },
      nextActions: [
        'inspect action=relations 回读关系与约束状态，确认 gaps 为空、rejected 为 0',
        'inspect action=verify 对照图纸验收；仅草图任务到此为止，不要 extrude',
        ...(sketch.fullyConstrained === false
          ? ['草图没有完全约束：用 inspect action=relations relationAction=infer 看候选关系，补完再重建']
          : []),
        ...(assumptions.length > 0
          ? [`这次构建用到的已确认假设：${assumptions.map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean).join(', ')}`]
          : []),
      ],
      capabilities: {
        closed: sketch.closed === true,
        segments: segmentCount,
        relations: relations.length,
        fullyConstrained: sketch.fullyConstrained ?? null,
      },
      timings: { totalMs: Date.now() - started },
    }),
  )
}

/**
 * 建完之后建议什么。重点是把「音量到了但关系没落」这种半成功说出来：
 * 没有绑定的参数意味着用户在 SOLIDWORKS 里手改尺寸时，模型和 JSON 会分家。
 */
function nextActionsForBuild(result) {
  const actions = []
  const bound = Object.keys(result.bindings ?? {}).length
  const params = Object.keys(result.parameters?.resolved ?? {}).length
  const literal = (result.drivers?.mode ?? '') === 'literal'
  if (params > 0 && bound < params) {
    actions.push(literal
      ? '这一版参数值烘在几何里（这个 SOLIDWORKS 实例拒绝了方程式）：改参数用 model action=edit，它会按设计定义重建'
      : `${params - bound} 个参数没有绑到原生尺寸，手改 SOLIDWORKS 后不会跟着变；inspect action=model 可以看哪些绑上了`)
  }
  const unconstrained = (result.builderSteps ?? []).filter((s) => /constraintStatus=(\d)/.test(s) && !s.includes('constraintStatus=3'))
  if (unconstrained.length > 0) {
    actions.push(`有草图没有完全约束：${unconstrained.join(' | ')}`)
  }
  actions.push('用 model action=edit 改参数验证传播，用 inspect action=verify 对照需求验收')
  return actions
}

// ------------------------------------------------------------------ model action=edit

async function handlePartEdit(args) {
  const designId = resolveDesignId(args.designId)
  let contractCommit = null
  try {
    if (args.changes && typeof args.changes === 'object') {
      const merged = { ...(args.parameters ?? {}) }
      for (const [key, value] of Object.entries(args.changes)) merged[key] = value
      args = { ...args, parameters: merged }
    }

    if (args.revert) {
      if (!designId) throw fail('BAD_ARGUMENT', 'revert 需要 designId')
      const project = readProject(designId)
      if (!project?.definition) {
        throw fail('PROJECT_NOT_FOUND', `没有 ${designId} 的设计定义可重建`)
      }
      const result = await buildWithPatterns(expandNativeGear(project.definition) ?? expandGearPrimitives(project.definition))
      writeProject({
        ...project,
        step: 'reverted',
        updatedAt: new Date().toISOString(),
        measurements: { volume: result.geometry?.massProperties?.volume },
        history: [...(project.history ?? []), { at: new Date().toISOString(), action: 'revert' }],
      })
      return ok(
        envelope({
          summary: `${designId} 已按存档定义重建，体积 ${result.geometry?.massProperties?.volume} mm³`,
          designId,
          changes: { document: result.document },
          measurements: { volume: result.geometry?.massProperties?.volume },
          nextActions: ['用 inspect action=verify 验收'],
        }),
      )
    }

    if (!args.parameters || Object.keys(args.parameters).length === 0) {
      throw fail('BAD_ARGUMENT', 'model action=edit 需要 parameters，或 revert=true')
    }

    // 先确认要改的参数确实是这个设计定义里的参数。写错名字过去会被当成
    // 「新建一个全局变量」，于是 edit 返回成功、几何一点没变 —— 又是一次
    // 看起来成功。这里直接拒绝，并把可用的名字列出来。
    const project = designId ? readProject(designId) : null
    // design.json 是唯一真源：盘上有定义就以盘上为准（可能有人在文件里改了设计）。
    const editCadPath = project?.cadPath ?? null
    const editContract = editCadPath ? readContract(editCadPath) : null
    if (project && editContract?.design?.definition) project.definition = editContract.design.definition
    if (editCadPath && editContract?.manifest?.cad?.sha256) {
      const drift = driftOf({
        design: editContract.design, manifest: editContract.manifest,
        cadPath: editCadPath, cadHash: hashFile(editCadPath),
      })
      if (drift.status === 'cad-changed' && args.recompile !== true) {
        throw fail('CAD_DRIFT',
          'SLDPRT 的哈希和 manifest 对不上：文件被外部改过。确认后传 recompile=true 按 design.json 重编，或先手动合并',
          drift)
      }
    }
    // 事务：动之前先把当前有效版本存一份，失败按快照恢复，不靠 SOLIDWORKS 的 undo。
    const editSnapshot = editCadPath ? snapshotCad(editCadPath, editContract?.design?.revision ?? 0) : null
    const declared = project?.definition?.params ? Object.keys(project.definition.params) : []
    if (declared.length > 0) {
      const unknown = Object.keys(args.parameters).filter((key) => !declared.includes(key))
      if (unknown.length > 0) {
        throw fail('UNKNOWN_PARAM',
          `设计定义里没有这些参数：${unknown.join(', ')}。可用的是：${declared.join(', ')}`,
          { unknown, known: declared })
      }
    }

    // Native dimension bindings recorded at build time: editing those dimensions
    // directly keeps the feature tree intact even when equations are unavailable.
    const dimensionBindings = project?.dimensionBindings ?? {}
    const dimensions = {}
    for (const param of Object.keys(args.parameters)) {
      if (dimensionBindings[param]) dimensions[param] = dimensionBindings[param]
    }
    const result = await callBridge('edit', {
      designId,
      parameters: args.parameters,
      ...(Object.keys(dimensions).length > 0 ? { dimensions } : {}),
    })
    let volume = result.geometry?.massProperties?.volume
    let geometry = result.geometry
    let applied = result.applied ?? []
    let mode = 'equation'
    const missing = Array.isArray(result.missing) ? result.missing : []
    // 方程式写不进去（本机 SOLIDWORKS 会稳定拒绝 Add2，见 bridge/src/EquationCapability.cs）时不再
    // 假装成功，也不再要求用户重启：按设计定义重建一遍，参数值在建模时就落在几何里。
    // 这是「设计定义是唯一事实源」的直接后果 —— 改参数 = 用新值重跑同一个定义。
    const beforeVolume = Number(project?.measurements?.volume ?? NaN)
    const appliedKeys = applied
      .filter((entry) => entry && (entry.mode === 'set' || entry.mode === 'added' || entry.mode === 'rebuilt' || entry.mode === 'dimension'))
      .map((entry) => entry.param)
    // 体积不变不等于没改到：移动孔位、旋转孔组都是「改成功但体积不变」。
    // 只有一条都没写进去时才重建；体积是否变化留给返回值和 nextActions 说明。
    let volumeChanged = Number.isFinite(beforeVolume) && Math.abs(volume - beforeVolume) > Math.max(1e-6, Math.abs(beforeVolume) * 1e-9)
    const beforeBox = project?.measurements?.boundingBox
    const beforeHoles = project?.measurements?.holePositions ?? project?.measurements?.holes
    const afterBox = geometry?.boundingBox?.size
    const boxChanged = Array.isArray(beforeBox) && Array.isArray(afterBox)
      && beforeBox.some((value, index) => Math.abs(Number(value) - Number(afterBox[index] ?? NaN)) > 1e-6)
    // 「改成功」与「改到几何」不是一回事：literal 模式下方程式写得进去，
    // 但没有一条尺寸绑定到它，几何不会动。只有回读确认每个请求参数都
    // 真的驱动了尺寸，才允许不算重建；否则体积没变就必须按定义重跑。
    const covered = new Set((result.driven ?? []).filter((entry) => entry?.bound).map((entry) => entry.param))
    const allCovered = Object.keys(args.parameters).every((param) => covered.has(param))
    // 本机 SOLIDWORKS 对未绑定尺寸的参数会「写方程成功但几何不动」。literal
    // 模式下没有一条原生尺寸能证明改动生效，所以只要不是每个参数都有 bound
    // 回读，就必须按定义重建；不能拿「方程返回 0」当成功。
    const mustRebuild = missing.length > 0 || appliedKeys.length === 0 || !allCovered
    // 「工具说改了」不等于「几何真的动了」：literal 模式下重建也可能只是把同一份
    // 字面坐标再烙一遍。把是否观察到变化回给调用方，避免下一次又踩假成功。
    const geometryChanged = volumeChanged || boxChanged
    let observedGeometryChanged = geometryChanged
    const firstPass = { applied: result.applied ?? [], missing: result.missing ?? [], driven: result.driven ?? [] }
    if (mustRebuild) {
      if (!project?.definition) {
        throw fail('EDIT_NOT_APPLIED',
          `这些参数一条都没写进去（${missing.map((m) => m.param ?? m.global ?? '?').join(', ')}）：` +
          'SOLIDWORKS 拒绝了方程式写入，而这个设计没有可用的定义记录，无法重建',
          { missing })
      }
      const merged = { ...(project.definition.params ?? {}), ...args.parameters }
      const rebuilt = await buildWithPatterns(expandNativeGear({ ...project.definition, params: merged }) ?? expandGearPrimitives({ ...project.definition, params: merged }))
      volume = rebuilt.geometry?.massProperties?.volume
      geometry = rebuilt.geometry
      mode = 'rebuild'
      applied = Object.keys(args.parameters).map((param) => ({
        param, value: merged[param], mode: 'rebuilt',
      }))
      // 重建用的就是这份参数表：写回定义，下一次 edit 才是在这一次的基础上改，
      // 而不是回到最初那版（曾经的症状：先改宽 80 再改厚 30，宽度又变回 100）。
      project.definition.params = merged
      result.drivers = rebuilt.drivers
      result.dimensionBindings = rebuilt.dimensionBindings ?? dimensionBindings
      // 重建后按「这一次的读数」重新判有没有改到几何：体积、包围盒、孔心，
      // 任一变化都算改到了 —— 孔位/旋转类参数可以体积不变而孔心在动。
      volumeChanged = Number.isFinite(beforeVolume)
        && Math.abs(volume - beforeVolume) > Math.max(1e-6, Math.abs(beforeVolume) * 1e-9)
      const rebuiltBox = geometry?.boundingBox?.size
      const rebuiltBoxChanged = Array.isArray(beforeBox) && Array.isArray(rebuiltBox)
        && beforeBox.some((value, index) => Math.abs(Number(value) - Number(rebuiltBox[index] ?? NaN)) > 1e-6)
      observedGeometryChanged = volumeChanged || rebuiltBoxChanged
        || holesMoved(beforeHoles, geometry?.holes)
    } else if (applied.some((entry) => entry?.mode === 'dimension')) {
      mode = 'dimension'
      // 直接改原生尺寸不重建，但孔心照样要读回：只靠体积/包围盒判断会把
      // 「孔距 60→62」当成没改到（实测 EDIT_NOT_BOUND 误判）。
      observedGeometryChanged = volumeChanged || boxChanged || holesMoved(beforeHoles, geometry?.holes)
    }
    // 无论走方程式还是重建，这次改的参数都要进持久定义；否则下一次 edit
    // 是在旧值上改，连续两次编辑会把第一次的改动抹掉（R11）。
    if (project?.definition) {
      project.definition.params = { ...(project.definition.params ?? {}), ...args.parameters }
    }
    // 落盘提交：edit 之后磁盘上的 SLDPRT 必须跟着变，否则「内存里改好了」又是一次假成功。
    if (editCadPath && project?.definition) {
      try {
        const savedEdit = await callBridge('save', { designId, path: editCadPath })
        const fileCheck = checkDeliveredFile(editCadPath, 'sldprt', savedEdit.bytes)
        if (savedEdit.saved !== true || fileCheck.ok !== true) {
          throw fail('EDIT_SAVE_FAILED',
            '改完存盘失败：' + (fileCheck.failed.join('、') || 'SOLIDWORKS 没有返回 saved'), { fileCheck })
        }
        const finalShape = geometry ?? result.geometry ?? {}
        if (assertPartBuild({ geometry: finalShape }) !== null) {
          throw fail('EDIT_EMPTY_MODEL', '改完之后没有实体（体积 ' + (finalShape.massProperties?.volume ?? 'null') + '）')
        }
        const revision = (editContract?.design?.revision ?? project.revision ?? 0) + 1
        const expectations = {
          volume: finalShape.massProperties?.volume ?? volume ?? null,
          boundingBox: finalShape.boundingBox?.size ?? geometry?.boundingBox?.size ?? null,
          bodies: Number.isFinite(finalShape.bodies) ? finalShape.bodies : null,
          holes: holeCountsByDiameter(finalShape.holes),
          holePositions: holeCenters(finalShape.holes),
          pitches: editContract?.design?.expectations?.pitches ?? [],
        }
        const design = buildDesign({
          designId, partId: basename(editCadPath).replace(/\.[^.]+$/, ''), definition: project.definition,
          revision, expectations, cadPath: editCadPath,
        })
        const manifest = buildManifest({
          design, cadPath: editCadPath, cadBytes: statSync(editCadPath).size, cadHash: hashFile(editCadPath),
          features: project.features ?? [], bindings: result.bindings ?? project.bindings ?? {},
          dimensionBindings: result.dimensionBindings ?? project.dimensionBindings ?? {}, drivers: result.drivers ?? null,
        })
        writeJsonAtomic(designFileFor(editCadPath), design)
        writeJsonAtomic(manifestFileFor(editCadPath), manifest)
        project.cadPath = editCadPath
        project.revision = revision
        project.designFile = designFileFor(editCadPath)
        project.manifestFile = manifestFileFor(editCadPath)
        contractCommit = { revision, saved: true, bytes: fileCheck.size, designFile: designFileFor(editCadPath), manifestFile: manifestFileFor(editCadPath), designHash: manifest.designHash }
      } catch (error) {
        const restored = restoreCad(editSnapshot, editCadPath)
        throw fail('EDIT_ROLLED_BACK',
          '这次修改没有提交：' + (error?.message ?? String(error)) + (restored ? '；磁盘文件已按快照恢复' : '；没有可用快照'),
          { rollback: restored, snapshot: editSnapshot, cause: error?.code ?? null })
      }
    }
    if (project) {
      writeProject({
        ...project,
        step: 'edited',
        updatedAt: new Date().toISOString(),
        measurements: { ...(project.measurements ?? {}), volume, boundingBox: geometry?.boundingBox?.size },
        dimensionBindings: result.dimensionBindings ?? project.dimensionBindings ?? {},
        history: [
          ...(project.history ?? []),
          { at: new Date().toISOString(), action: 'edit', parameters: args.parameters, volume },
        ],
      })
    }
    rememberDesign(designId)

    // P3：参数被接受、也重建了，但体积/包围盒/孔心一个都没动 = 没改到。
    // 以前这里照样回 ok（driven[].bound=false、verified=false），Agent 会把
    // 「请求被接受」当成「几何改了」。这里不再二次重建，直接按事实回失败。
    const requestedParams = Object.keys(args.parameters)
    const anyBound = (result.driven ?? []).some((entry) => entry && entry.bound === true)
    if (requestedParams.length > 0 && !anyBound && !observedGeometryChanged) {
      return structuredFailure({
        op: 'model.edit',
        designId,
        code: 'EDIT_NOT_BOUND',
        message: `${requestedParams.join(', ')} 没有绑到任何原生尺寸，重建后体积、包围盒、孔心都没有变化：`
          + '这次 edit 没有改到几何。',
        detail: {
          parameters: args.parameters,
          dimensionBindings: result.dimensionBindings ?? project?.dimensionBindings ?? {},
          geometryChanged: false,
          mode,
          holesBefore: holeVectors(beforeHoles),
          holesAfter: holeVectors(geometry?.holes),
          holesChanged: holesMoved(beforeHoles, geometry?.holes),
          driven: result.driven ?? [],
          applied,
          volume,
          boundingBox: geometry?.boundingBox?.size,
        },
        changes: {
          parameters: args.parameters,
          dimensionBindings: result.dimensionBindings ?? project?.dimensionBindings ?? {},
          // C 场景（无原生绑定，靠定义重建）：回包必须自带「为什么没绑定、几何到底动没动、
          // 走的是哪条模式」，调用方不该靠拼 summary 去猜。verified 恒 false —— 重建没有
          // 尺寸回读可证明，这是事实。
          verified: false,
          geometryChanged: false,
          mode,
          noBindingRebuild: true,
          reason: 'no-native-binding',
          notes: [`${requestedParams.join(', ')} 在 build 里没有对应的原生尺寸绑定；` +
            '这次走的是按设计定义重建（mode="rebuild"），重建后体积/包围盒/孔心都没有变化，' +
            '判定为没有改到几何（EDIT_NOT_BOUND）'],
        },
        nextActions: [
          `这条参数在 build 里没有对应的原生尺寸：把尺寸做进定义（sketch.dimensions 里加 {name:"${requestedParams[0]}"} 的驱动尺寸），`
            + '再 build 一次，之后 edit 才会走 mode="dimension"',
          '如果它本来就不影响几何，从 params 里去掉或改成由公式/派生尺寸表达；不要继续原样重试 edit',
          '先 inspect action="sketch" / action="bodies" 回读，确认几何确实没动',
        ],
      })
    }

    // 编辑改的也是几何：交付门要当前 revision 自己的图。改完直接拍，
    // 调用方不必再补一次 capture（交付失败里半数以上栽在"没有当前版本的图"）。
    const editShots = await autoShots(designId, 'edit')

    const changedKeys = Object.keys(args.parameters)
    return ok(
      envelope({
        summary: `改了 ${changedKeys.join(', ')}，体积 ${volume} mm³`,
        designId,
        changes: {
          parameters: args.parameters,
          autoShots: editShots.map((shot) => ({ path: shot.path, view: shot.view })),
          designStore: contractCommit,
          applied,
          mode,
          // verified 只说「有原生尺寸回读证明」：靠定义重建即使几何变了也没有尺寸回读，
          // 这里如实报 false，避免把「重建过」说成「验证过」。
          verified: allCovered,
          geometryChanged: observedGeometryChanged,
          // C 场景：没绑到原生尺寸、按设计定义重建时，回包必须自带这两项，
          // 让调用方一眼看出「这次是靠重建改的，不是尺寸驱动的」。
          ...(mode === 'rebuild' && !allCovered
            ? {
              noBindingRebuild: true,
              reason: 'no-native-binding',
              dimensionBindings: result.dimensionBindings ?? project?.dimensionBindings ?? {},
            }
            : {}),
          holesBefore: holeVectors(beforeHoles),
          holesAfter: holeVectors(geometry?.holes),
          firstPass,
          drivers: result.drivers,
          driven: result.driven ?? [],
          volumeChanged,
        },
        measurements: {
          volume,
          boundingBox: geometry?.boundingBox?.size,
          holes: (geometry?.holes ?? []).map((h) => ({
            ...shapeHole(h),
          })),
        },
        timings: { evaluateRc: result.evaluateRc },
        nextActions: !allCovered && !observedGeometryChanged
          ? ['这次编辑没有观察到体积、包围盒或孔心变化：参数可能只是写进了方程/字面量，先 inspect action="sketch" 回读实际草图，再决定是否按定义重算']
          : mode === 'rebuild' && !allCovered
            ? ['这条参数没有原生尺寸绑定，这次是按设计定义重建的（mode="rebuild"、verified=false）；'
              + '几何变化已按体积/包围盒/孔心回读。要让它走 dimension 模式，得在 build 的 sketch.dimensions 里把这条尺寸做出来']
            : volumeChanged
              ? ['用 inspect action=verify 核对尺寸与孔位是否仍符合要求']
              : ['体积没有变化；若改的是孔位/旋转类参数这是正常的，用 inspect action=sketch 回读实际位置',
                '如果期望体积变化，检查该参数是否绑到了原生尺寸（inspect action=model）'],
        extra: { equations: result.equations },
      }),
    )
  } catch (error) {
    return failed({ op: 'model.edit', designId, error })
  }
}

// ------------------------------------------------------------------ inspect action=model

async function handlePartInspect(args) {
  let designId = null
  try {
    designId = requireDesignId(args.designId, { tool: 'inspect', action: 'model' })
    const format = args.includeImage ? 'both' : args.format
    const pair = args.imagePath ? null : inspectImagePair()
    const result = await callBridge('inspect', {
      designId,
      format,
      imagePath: args.imagePath ?? (args.includeImage ? pair.bmp : undefined),
      width: args.width,
      height: args.height,
    })

    // 先把 BMP 转成 PNG，再拼返回值 —— 否则 artifacts 里给的是一个已经被删掉的路径。
    if (args.includeImage && result.image?.path && existsSync(result.image.path) && !args.imagePath) {
      result.image.path = bmpToPng(result.image.path, pair.png)
    }
    // F6：读特征树也要确认读的是这一份。旧行为里「designId 指向锁盖、模型照用
    // 28 个特征」正是靠这里没人判身份。
    const identity = documentIdentityCheck({ designId, document: result.document })
    if (identity.ok !== true) return failed({ op: 'inspect.model', designId, error: identity.error })

    const content = [{ type: 'text', text: JSON.stringify(envelope({
      summary: `零件 ${result.document?.title}：${result.featureTree?.length ?? 0} 个特征`,
      designId,
      measurements: result.geometry,
      changes: {
        featureTree: result.featureTree,
        sketches: result.sketches,
        dimensions: result.dimensions,
        equations: result.equations,
      },
      artifacts: result.image ? [{ kind: 'image', path: result.image.path, bytes: result.image.bytes }] : [],
    }), null, 2) }]

    // 图作为独立内容块追加：模型一次就能看到，不用再叫一次 read_image。
    if (args.includeImage && result.image?.path && existsSync(result.image.path)) {
      const shown = result.image.path
      const mime = shown.toLowerCase().endsWith(".png") ? "image/png" : "image/bmp"
      content.push({ type: 'image', data: readFileSync(shown).toString('base64'), mimeType: mime })
    }
    return { content }
  } catch (error) {
    return failed({ op: 'inspect.model', designId, error })
  }
}

// ------------------------------------------------------------------ inspect action=verify

// expect 的合法顶层键，以及 checks[].measure 的合法值。
//
// 为什么写死在回包里：实测（R2 取证）一次建模会话里，模型为了凑对 expect 的键
// 连写了 30 个错键、8 次调用（约 7.4 s 工具时间 / 约 4.3 分钟墙钟），因为每次失败
// 只回一句「未识别的核对键 X（没有参与判定）」，不给白名单 —— 白名单本来就躺在
// 这里，让调用方猜没有道理。measure 只列 checks[].measure 的 enum（tools-observe.mjs
// 里 verify 的 schema），与 verify.mjs 的 defaultPick 六种一致；faces 只有
// inspect action=measure 的 kind 支持，不能写进 checks[]，所以不列。
const VERIFY_EXPECT_KEYS = ['checks', 'volume', 'size', 'holes', 'holeCount', 'holeDiameter', 'tolerance', 'parametric', 'features', 'sketches']
const VERIFY_MEASURES = ['axis', 'spacing', 'distance', 'holes', 'cylinders', 'planes']

/** 「可用键是什么」的唯一一份文案：摘要、有真失败项的指路、参数名写错的指路
 *  都从这里取，避免三处措辞各自漂移，也避免以后改白名单时漏掉一处。 */
function expectSchemaHint() {
  return `可用键：${VERIFY_EXPECT_KEYS.join(' / ')}；逐项核对用 expect.checks[]，measure 可取 ${VERIFY_MEASURES.join(' / ')}`
}

/** 顶层键没参与判定时的共用一句（!ran 与「有真失败项」两条分支都用它）。 */
function ignoredKeysHint(ignored) {
  return `这些键没有参与判定：${ignored.map((item) => item.key).join(', ')}；改成 expect.checks[] 才能生效`
}

/** verify 顶层参数写错时的指路：只指向 inspect 自己的 expect schema。
 *  旧文案把这里送去 workspace action=project —— 那是改设计参数的入口，与
 *  「核对条件怎么写」无关，模型照做只会再烧一轮。 */
function verifyArgsHint() {
  return [
    `verify 的验收条件写在 expect 里：${expectSchemaHint()}`,
    '逐项数值核对用 expect.checks[]：每条 {name, measure, args, expect, tol}；顶层 volume/size/holes 只是兼容旧写法',
  ]
}

/** inspect action=figure 顶层参数写错时的指路：路径嵌在 figure 里，不在顶层。
 *
 * 旧文案（tools-observe 的 BAD_ARGUMENT）写着「顶层 source 也认」，可 schema 与
 * rejectUnknownArgs 都先一步把它拒了 —— 模型照那句写只会再撞一次（实测撞过）。 */
function figureArgsHint() {
  return [
    '图纸路径写在 figure.source：{"action":"figure","figure":{"source":"<绝对路径>","op":"info"}}',
    'op / crop / region / box / scale / grid / contrast / maxSide / output 也都写在 figure 里；顶层只放 action、designId 这类公共参数',
  ]
}

async function handlePartCheck(args) {
  let designId = null
  try {
    designId = requireDesignId(args.designId, { tool: 'inspect', action: 'verify' })
    const result = await callBridge('inspect', { designId, format: 'geometry' })
    const geometry = result.geometry ?? {}
    // F6：验收数字必须来自 designId 登记的那一份文档。实测里 0bb49837 的
    // `inspect measure designId=bracket-06v1` 回的是 锁盖.SLDPRT 的数字，照旧验收。
    const identity = documentIdentityCheck({ designId, document: result.document })
    if (identity.ok !== true) return failed({ op: 'inspect.verify', designId, error: identity.error })
    const checks = []
    const auxiliary = []
    const expect = args.expect ?? {}

    // 档位验收：期望值来自 design.json，量的就是这次同一份几何回包。
    // 没记录的项一律 unmeasured —— 「没量成」不等于「对得上」。
    const tierRows = []
    const tierSkipped = []
    if (Array.isArray(args.tiers) && args.tiers.length > 0) {
      const tierProject = designId ? readProject(designId) : null
      const tierCadPath = tierProject?.cadPath ?? null
      const tierContract = tierCadPath ? readContract(tierCadPath) : null
      if (!tierContract?.design) {
        tierRows.push({
          tier: 'file', name: 'tiers.designFile', status: 'unmeasured', pass: false,
          expected: tierCadPath ?? 'no cadPath', actual: null,
          note: '没有 design.json：先 deliver 一次，档位验收才有期望值可对',
        })
      } else {
        const rows = evaluateTiers({
          tiers: args.tiers, design: tierContract.design, manifest: tierContract.manifest,
          cadPath: tierCadPath, cadHash: hashFile(tierCadPath), geometry,
        })
        for (const row of rows) {
          if (row.status === 'skipped') tierSkipped.push(row)
          else tierRows.push(row)
        }
      }
      checks.push(...tierRows)
    }

    // 兼容 M1 时代的验收写法：volume / size / holes / holeDiameter 这些**顶层键**，
    // 现在真正参与判定的是 expect.checks[]。以前没映射的键被静默丢掉 —— 一次实测
    // 里 holeDiameter 就这么没了，调用方以为在核对孔径，实际一条都没跑，报告只说
    // 「孔数量不符」。现在能映射的映射，映射不了的进 ignored，并把这件事说出来。
    const migrated = []
    const ignored = []
    const KNOWN_TOP = new Set(VERIFY_EXPECT_KEYS)
    for (const key of Object.keys(expect)) {
      if (!KNOWN_TOP.has(key)) ignored.push({ key, reason: '这个工具不认识这个核对键，它没有参与判定' })
    }

    // 体积和包围盒是**辅助**观察量：它们能说明「这次算出来的是不是一个实心件」，
    // 说明不了「按图纸建对了」。要判定后者，用 expect.checks（来自图纸解释），
    // 或者用 inspect action=measure 逐项量。所以它们单独放 auxiliary，不参与
    // 主判定 —— 以前把它们当验收依据，出现了「体积对了就当画对了」。
    if (typeof expect.volume === 'number') {
      const actual = geometry.massProperties?.volume
      const tol = typeof expect.tolerance === 'number' ? expect.tolerance : 0.001
      const relative = actual ? Math.abs(actual - expect.volume) / expect.volume : 1
      auxiliary.push({
        name: 'volume',
        pass: relative <= tol,
        expected: expect.volume,
        actual,
        delta: actual === undefined ? null : Number((actual - expect.volume).toFixed(4)),
        tolerance: `±${(tol * 100).toFixed(2)}%`,
        note: '体积对上只说明算的是一个实心件，不说明按图纸建对了',
      })
    }

    const sizeCandidates = Array.isArray(expect.size)
      ? [{ values: expect.size, matchedAs: 'X,Y,Z' }]
      : semanticSizeCandidates(expect.size)
    let sizeMatch = null
    if (sizeCandidates !== null) {
      const actual = geometry.boundingBox?.size ?? []
      for (const candidate of sizeCandidates) {
        if (candidate.values.every((v, i) => Math.abs((actual[i] ?? NaN) - v) <= 0.01)) { sizeMatch = candidate; break }
      }
      const shown = sizeMatch ?? sizeCandidates[0]
      auxiliary.push({
        name: 'boundingBox', pass: sizeMatch !== null, expected: shown.values, actual,
        matchedAs: shown.matchedAs,
        note: '包围盒能挡住方向错、尺寸错一个量级，挡不住形状错；matchedAs 说明长宽高对到了哪根轴',
      })
    }

    // 体积保持「辅助观察」：它只能说明算出来的是个实心件，不能当尺寸判据。
    // 包围盒是结构核对（方向/量级），显式给出时进主判定。
    if (typeof expect.volume === 'number') {
      migrated.push({ from: 'volume', to: 'auxiliary', note: '体积只作辅助观察，不参与判定' })
    }
    if (sizeCandidates !== null) {
      migrated.push({ from: 'size', to: 'checks[]', note: '显式期望值，参与判定（支持 {length,width,height}）' })
      checks.push({ ...auxiliary[auxiliary.length - 1], status: auxiliary[auxiliary.length - 1].pass ? 'pass' : 'fail' })
    }

    if (Array.isArray(expect.features) || typeof expect.features === 'number'
      || typeof expect.sketches === 'number') {
      try {
        const tree = await callBridge('inspect', { designId, action: 'model', format: 'tree' })
        const rawFeatures = tree?.changes?.featureTree ?? tree?.featureTree ?? tree?.features
        const features = Array.isArray(rawFeatures)
          ? rawFeatures.filter((f) => !/Folder$/.test(String(f.type ?? '')))
          : []
        const sketchList = tree?.changes?.sketches ?? tree?.sketches ?? null
        if (Array.isArray(expect.features)) {
          const names = features.map((f) => f.featureName ?? f.name ?? '')
          const missing = expect.features.filter((name) => !names.some((n) => String(n).includes(String(name))))
          checks.push({
            name: 'features', status: missing.length === 0 ? 'pass' : 'fail',
            pass: missing.length === 0, expected: expect.features,
            actual: names, missing,
          })
        } else if (typeof expect.features === 'number') {
          checks.push({
            name: 'features', status: features.length === expect.features ? 'pass' : 'fail',
            pass: features.length === expect.features, expected: expect.features, actual: features.length,
          })
        }
        if (typeof expect.sketches === 'number') {
          const sketches = Array.isArray(sketchList)
            ? sketchList
            : features.filter((f) => /sketch/i.test(String(f.type ?? f.featureType ?? '')))
          checks.push({
            name: 'sketches', status: sketches.length === expect.sketches ? 'pass' : 'fail',
            pass: sketches.length === expect.sketches, expected: expect.sketches, actual: sketches.length,
          })
        }
      } catch (error) {
        checks.push({
          name: 'features', status: 'unmeasured', pass: false,
          expected: expect.features ?? expect.sketches, reason: 'INSPECT_FAILED',
          error: { code: error?.code ?? 'INSPECT_FAILED', message: error?.message ?? String(error) },
        })
      }
    }

    // 主判定：逐条语义检查。空数组意味着「没有核对」，不是「核对通过」。
    for (const spec of Array.isArray(expect.checks) ? expect.checks : []) {
      // designId 必须往下传：桥接器的 measure 把它当可选参数，不带就量前台那份。
      // 以前这里只传两个参数，于是同一个回包里 boundingBox（带 designId）是对的，
      // 而 checks[] 里的高/厚是**另一份文档**的数字 —— 多零件时静默量错。
      checks.push(await runCheck(spec, callBridge, designId))
    }

    // 孔数量与孔径可以一起给：`holes:2, holeDiameter:5` 在 M1 时代的意思是
    // 「有 2 个 Ø5 的孔」，这里合成一条核对，而不是两条各说一半。
    const wantedHoles = typeof expect.holes === 'number'
      ? expect.holes
      : (typeof expect.holeCount === 'number' ? expect.holeCount : null)
    if (wantedHoles !== null || typeof expect.holeDiameter === 'number') {
      const hasDiameter = typeof expect.holeDiameter === 'number'
      const spec = {
        name: hasDiameter ? `Ø${expect.holeDiameter} 通孔数量` : '通孔数量',
        measure: 'holes',
        pick: 'count',
        tol: 0,
        args: hasDiameter ? { diameterEq: expect.holeDiameter } : {},
      }
      if (wantedHoles !== null) spec.expect = wantedHoles
      else spec.min = 1
      checks.push(await runCheck(spec, callBridge, designId))
      migrated.push({ from: hasDiameter ? 'holes+holeDiameter' : 'holes', to: 'checks[]', as: spec.name })
    }

    if (expect.parametric) {
      const project = designId ? readProject(designId) : null
      const bindings = project?.bindings ?? {}
      const params = Object.keys(project?.definition?.params ?? {})
      const unbound = params.filter((p) => bindings[p] === undefined)
      // 两种驱动都算参数化，但要说清是哪一种：equation（全局变量驱动尺寸）或
      // literal（本机拒绝写方程式，参数值落在驱动尺寸上，改参数靠重建）。
      const drivers = project?.drivers ?? null
      const literal = drivers?.mode === "literal"
      checks.push({
        name: "parametric",
        pass: params.length > 0 && (literal ? (drivers.appliedLiteral ?? 0) > 0 && (drivers.appliedLiteral ?? 0) >= (drivers.requested ?? 0) : unbound.length === 0),
        expected: literal
          ? (drivers.requested ?? 0) + " 个绑定全部落到尺寸上（本机走「烘进几何 + 改参数重建」）"
          : params.length + " 个参数全部绑到原生尺寸",
        actual: literal
          ? (drivers.appliedLiteral ?? 0) + "/" + (drivers.requested ?? 0) + " 个绑定已落地（literal）"
          : (params.length - unbound.length) + "/" + params.length + " 已绑定",
        mode: literal ? "literal" : "equation",
        designId,
        projectFound: !!project,
        unbound,
        bound: bindings,
      })
    }

    const counts = tallyChecks(checks)
    const failedChecks = checks.filter((c) => (c.status ?? (c.pass ? 'pass' : 'fail')) === 'fail')
    const unmeasured = checks.filter((c) => c.status === 'unmeasured')
    const failedAux = auxiliary.filter((c) => !c.pass)
    const ran = checks.length > 0
    // 四态，不是三态：
    //   ok         —— 每一条都量到了，而且都对；
    //   incomplete —— 有「没量成」的条目。没量成既不是通过也不是不符，它意味着
    //                 「这条我还不知道」，而只要有一条不知道，就不能说验收通过。
    //   failed     —— 量到了但不对；
    //   not-run    —— 一条语义核对都没有。
    // 以前 unmeasured 不参与判定，于是「10 条里 4 条没量成、6 条碰巧对」也回 ok，
    // 摘要还写「验收通过」—— 这正是用户点名的那种闭环自证。
    const status = !ran
      ? 'not-run'
      : failedChecks.length > 0
        ? 'failed'
        : counts.unmeasured > 0
          ? 'incomplete'
          : 'ok'

    const tally = `通过 ${counts.pass} 条`
      + (counts.fail ? ` / 不符 ${counts.fail} 条` : '')
      + (counts.unmeasured ? ` / 没量成 ${counts.unmeasured} 条` : '')

    // 「哪些话没被听见」必须出现在摘要里：静默丢弃是最糟的一种通过。
    // 后半句（可用键）只在真的有无识别键时追加 —— 正常回包不能被白名单噪音弄脏。
    const ignoredNote = ignored.length
      ? `；未识别的核对键 ${ignored.map((item) => item.key).join(', ')}（没有参与判定）。${expectSchemaHint()}`
      : ''

    // 可判定读数：验收看的必须是这些数字（expected/actual），不是「ok」。即使没给
    // expect/tiers，也把这一版量到的体积/实体数/包围盒/孔/组件/干涉原样带上。
    const readouts = geometryReadouts(geometry, tierRows)
    return ok(
      envelope({
        summary: (!ran
          ? (auxiliary.length
            ? `没有语义核对项，只有 ${auxiliary.length} 条辅助观察（体积/包围盒不算验收通过）`
            : '没有期望值，未执行核对')
          : failedChecks.length > 0
            ? `验收未通过：${failedChecks.map((c) => c.name).join(', ')}（${tally}）`
            : counts.unmeasured > 0
              ? `验收未完成：${counts.unmeasured} 条没量成（${tally}）。没量成不等于对得上，先补齐这些再谈通过`
              : `验收通过（${tally}，另 ${auxiliary.length} 条辅助观察）`) + ignoredNote,
        designId,
        status,
        measurements: geometry,
        changes: { checks, auxiliary, counts, migrated, ignored, tiers: { rows: tierRows, skipped: tierSkipped }, readouts },
        nextActions: !ran
          ? [
            '用 inspect action="compare" 把图纸与模型并排看一眼（给人看，不是判据）；再用 expect.checks 逐条核对',
            '或者用 inspect action=measure 直接量（孔径/孔心高/槽圆心距/筋厚）',
            ...(ignored.length ? [ignoredKeysHint(ignored)] : []),
          ]
          : unmeasured.length > 0
            ? [
              `有 ${unmeasured.length} 条没量成：${unmeasured.map((c) => `${c.name}（${c.note ?? c.reason ?? ''}）`).join('; ')}`,
              '按 measure 返回的 available.diameters 核对直径是否写对，再看 hole/boss 过滤',
            ]
            : failedChecks.length === 0
              ? ['用 deliver 出交付文件；需要图纸就 model action=drawing 再 deliver kind="pdf"']
              : [
                // 这是「真的量到了、但不对」的分支。以前这里给 undefined，模型只能自己猜下一步。
                ...(ignored.length ? [ignoredKeysHint(ignored)] : []),
                ...(ignored.length ? [expectSchemaHint()] : []),
                `逐项数值核对改成 expect.checks[]（measure 可取 ${VERIFY_MEASURES.join(' / ')}）：` +
                  '顶层键只是兼容旧写法，checks[] 里的每一条才逐项参与判定',
                '改模型后重跑 build→relations→verify：先重建，再回读关系，最后重新验收',
              ],
      }),
    )
  } catch (error) {
    return failed({ op: 'inspect.verify', designId, error })
  }
}

// ------------------------------------------------------------------ deliver

/** 导出（step/pdf/dxf/dwg）前把目标文档变成前台：桥接器的 open 会 ActivateDoc3 并
 *  回读 activeIsRequested。原生 SLDPRT 交付不再走这里（见 deliverPartFile：按
 *  designId 定位，匹配不到就重开/重建）。
 *  没有磁盘文件（还没存过的内存文档）不算失败：export 走 WorkRegistry 的 designId
 *  绑定，回包里 active:null + reason 说明，绝不假装「已激活」。 */
async function ensureActiveForDesign(designId) {
  const project = readProject(designId)
  const path = typeof project?.cadPath === 'string' ? project.cadPath : null
  if (path === null || !existsSync(path)) {
    return { active: null, reason: 'NO_FILE_YET', note: '这份设计还没有磁盘文件：保存按 designId 绑定内存文档，无需激活' }
  }
  try {
    const opened = await callBridge('open', { path, designId })
    return {
      active: opened?.activeIsRequested === true,
      title: opened?.title ?? null,
      path,
      note: opened?.activeIsRequested === true
        ? '已激活；activeIsRequested=true'
        : '激活回读不是前台文档（activeIsRequested=false）：保存前先确认前台是哪一份',
    }
  } catch (error) {
    return { active: false, path, error: { code: error?.code ?? 'ACTIVATE_FAILED', message: error?.message ?? String(error) } }
  }
}

// ---------------------------------------------------------------------------
// 原生 SLDPRT 交付：不依赖「当前活动文档」。
//
// 多会话共用一个 SOLIDWORKS 实例时，别的会话 build 会把活动文档切走或关掉，旧
// deliver 因此回 DOC_NOT_OPEN。现在的顺序是：
//   1. 按 designId（桥接器 WorkRegistry）/ 路径 / partId 精确匹配已打开的文档，
//      匹配到就激活后保存（source=active）；
//   2. 匹配不到：盘上的 SLDPRT 若被证明就是当前设计定义编译的，重开再保存
//      （source=reopened）；证明不了就按 project 里的定义重建（source=rebuilt）；
//   3. 保存后关掉重开，读实体数（装配读组件数），>0 才算交付。
// 决策本身在 deliver-route.mjs（纯函数，离线可测）。
// ---------------------------------------------------------------------------

/** 桥接器的 WorkRegistry（designId → title/path）就在 exe 旁边；只读，用来判断
 *  「这个 designId 的那一份现在开没开」。读不成（桥接器正在重写这个文件）就当没有
 *  登记：save 仍会按 designId 再解析一次，匹配不上会落到重开/重建。 */
function readWorkRegistry() {
  try {
    const file = join(dirname(config.bridgeExe), 'state', 'documents.json')
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw !== null && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/** 本实例当前打开的文档。拿不到返回 null（决策里等于"不知道"，不是"没开"）。
 *
 *  必须带 designId：broker 通道池按 designId 把请求送到这条设计绑定的那个
 *  SOLIDWORKS 实例；不带就落到默认通道，读到的是别的实例的文档清单。 */
async function listOpenDocumentsForDeliver(designId) {
  try {
    const listed = await callBridge('list', typeof designId === 'string' && designId.length > 0 ? { designId } : {})
    return normalizeOpenDocuments(listed)
  } catch {
    return null
  }
}

/** 盘上那份 SLDPRT 是不是当前设计定义编译出来的：只有设计/清单都在、漂移 clean、
 *  且定义与 project 存档一致，才允许直接重开；否则按定义重建（定义是唯一真源）。 */
function deliveredArtifactFacts(project, cadPath) {
  if (typeof cadPath !== 'string' || cadPath.length === 0) {
    return { cadPath: null, cadFile: { exists: false, bytes: 0 }, cadCurrent: null, cadWhy: 'NO_CAD_PATH' }
  }
  let bytes = 0
  try { bytes = statSync(cadPath).size } catch { bytes = 0 }
  const cadFile = { exists: bytes > 0, bytes }
  if (!cadFile.exists) return { cadPath, cadFile, cadCurrent: false, cadWhy: 'FILE_MISSING' }
  const contract = readContract(cadPath)
  if (!contract?.design || !contract?.manifest) return { cadPath, cadFile, cadCurrent: false, cadWhy: 'NO_DESIGN_CONTRACT' }
  const drift = driftOf({ design: contract.design, manifest: contract.manifest, cadPath, cadHash: hashFile(cadPath) })
  if (drift.status !== 'clean') return { cadPath, cadFile, cadCurrent: false, cadWhy: `DRIFT_${String(drift.status).toUpperCase()}` }
  const projectDefinition = project?.definition ?? null
  if (projectDefinition !== null) {
    const contractDefinition = contract.design.definition ?? null
    if (contractDefinition === null || canonicalJson(projectDefinition) !== canonicalJson(contractDefinition)) {
      return { cadPath, cadFile, cadCurrent: false, cadWhy: 'DEFINITION_DIFFERS_FROM_PROJECT' }
    }
  }
  return { cadPath, cadFile, cadCurrent: true, cadWhy: 'CLEAN' }
}

/** 给已打开文档补上"它旁边那份 design.json 是谁"：partId 匹配靠定义哈希证明
 *  身份，不靠标题撞名。读不到 sidecar 的文档保持原样（只参与 designId/路径匹配）。 */
function enrichOpenDocuments(documents) {
  if (!Array.isArray(documents)) return documents
  return documents.map((doc) => {
    if (typeof doc?.path !== 'string' || doc.path.length === 0) return doc
    const contract = readContract(doc.path)
    if (!contract?.design) return doc
    const definition = contract.design.definition ?? null
    return {
      ...doc,
      contract: {
        designId: contract.design.designId ?? null,
        partId: contract.design.partId ?? null,
        definitionHash: definition === null ? null : hashText(canonicalJson(definition)),
      },
    }
  })
}

async function collectDeliverFacts({ designId, project, targetPath }) {
  const registry = readWorkRegistry()[designId] ?? null
  return {
    designId,
    kind: 'sldprt',
    targetPath,
    registry,
    openDocuments: enrichOpenDocuments(await listOpenDocumentsForDeliver(designId)),
    hasDefinition: Boolean(project?.definition),
    definitionHash: project?.definition ? hashText(canonicalJson(project.definition)) : null,
    ...deliveredArtifactFacts(project, typeof project?.cadPath === 'string' ? project.cadPath : null),
  }
}

/** 按路由拿到目标文档，再保存。返回 save 回包与（重建时的）build 结果。 */
async function executeDeliverRoute(route, { designId, project, targetPath }) {
  let rebuilt = null
  if (route.source === 'active') {
    // designId 能直接解析；按路径/partId 匹配到的那份先 open，把 designId 重新绑上。
    if (typeof route.activatePath === 'string' && route.activatePath.length > 0) {
      await callBridge('open', { path: route.activatePath, designId })
    }
  } else if (route.source === 'reopened') {
    const opened = await callBridge('open', { path: route.reopenPath, designId })
    if (opened?.opened !== true) {
      throw fail('DELIVER_REOPEN_FAILED', `按 design store 重开 ${route.reopenPath} 失败`, {
        designId, path: route.reopenPath, opened,
      })
    }
  } else if (route.source === 'rebuilt') {
    const definition = project?.definition
    if (!definition) throw fail('DELIVER_NO_DEFINITION', `没有 ${designId} 的设计定义可重建`, { designId })
    // 复用 model action=build 的同一条路径：展开原生齿轮 → buildWithPatterns。
    const expanded = expandNativeGear(definition) ?? expandGearPrimitives(definition)
    inFlightBegin(designId)
    try {
      rebuilt = await buildWithPatterns(expanded)
    } finally {
      inFlightEnd(designId)
    }
    const partError = assertPartBuild(rebuilt)
    if (partError !== null) throw partError
    trackSessionDoc(designId, rebuilt.document)
  }
  const saved = await callBridge('save', { designId, path: targetPath })
  return { saved, rebuilt }
}

/** 保存后「关掉重开」回读：先确认按标题关关的就是目标路径这一份（同名不同目录会
 *  关错），再 open + inspect（装配读 components）。回读失败不注释成成功。 */
async function verifyDeliveredPartFile({ designId, targetPath, project }) {
  const state = {
    path: targetPath,
    closedTitle: null,
    reopened: false,
    skipped: null,
    skippedDetail: null,
    error: null,
    title: null,
    kind: 'part',
    measuredFrom: null,
    geometry: null,
    bodies: null,
    faces: null,
    volume: null,
    boundingBox: null,
    components: null,
  }
  const contract = readContract(targetPath)
  state.kind = contract?.design?.kind === 'assembly' || project?.kind === 'assembly' ? 'assembly' : 'part'

  const openDocuments = await listOpenDocumentsForDeliver(designId)
  const closable = closeTargetFacts({ openDocuments, targetPath })
  if (!closable.ok) {
    state.skipped = closable.reason
    state.skippedDetail = closable.path ?? closable.matches ?? null
  } else {
    try {
      // close 不在 BROKER_OPS 里：显式走 broker，才能按 designId 落到这条设计的
      // 实例上（通道池下直连桥接器会 INSTANCE_NOT_BOUND）。
      const closed = await callBridge('close', { title: closable.title, allowDirty: true, designId }, { broker: true })
      state.closedTitle = closed?.closed ?? null
    } catch (error) {
      state.skipped = 'CLOSE_FAILED'
      state.skippedDetail = { code: error?.code ?? null, message: error?.message ?? String(error) }
    }
  }

  try {
    const opened = await callBridge('open', { path: targetPath, designId })
    state.title = opened?.title ?? null
    state.reopened = state.closedTitle !== null && opened?.opened === true
    if (state.kind === 'assembly') {
      const listed = await callBridge('components', { designId })
      state.components = Number.isFinite(Number(listed?.count)) ? Number(listed.count) : null
      state.measuredFrom = 'components（重开后的装配文档）'
    } else {
      const measured = await callBridge('inspect', { designId, format: 'geometry' })
      state.geometry = measured?.geometry ?? null
      const shape = state.geometry ?? {}
      state.bodies = Number.isFinite(shape.bodies) ? shape.bodies : null
      state.faces = Number.isFinite(shape.faces) ? shape.faces : null
      state.volume = shape.massProperties?.volume ?? null
      state.boundingBox = Array.isArray(shape.boundingBox?.size) ? shape.boundingBox.size : null
      state.measuredFrom = state.reopened
        ? 'inspect format=geometry（关掉重开后）'
        : 'inspect format=geometry（没关掉，读的是当前文档）'
    }
  } catch (error) {
    state.error = { code: error?.code ?? 'READBACK_FAILED', message: error?.message ?? String(error) }
  }
  return state
}

/** design.json 是唯一真源：交付成功时把它落到 CAD 旁边，并把这一版期望值一起记下。
 *  之后 edit / inspect verify 的 tiers 都读它；SLDPRT 只是编译产物。 */
async function writeDeliveryContract({ designId, project, path, measuredShape, rebuilt }) {
  if (!project?.definition) return null
  const shape = measuredShape ?? {}
  const previous = readContract(path)
  const revision = (previous?.design?.revision ?? 0) + 1
  const expectations = {
    volume: shape.massProperties?.volume ?? project.measurements?.volume ?? null,
    boundingBox: Array.isArray(shape.boundingBox?.size) ? shape.boundingBox.size : (project.measurements?.boundingBox ?? null),
    bodies: Number.isFinite(shape.bodies) ? shape.bodies : null,
    holes: holeCountsByDiameter(shape.holes),
    holePositions: holeCenters(shape.holes),
    pitches: previous?.design?.expectations?.pitches ?? [],
  }
  const design = buildDesign({
    designId, partId: basename(path).replace(/\.[^.]+$/, ''), definition: project.definition,
    revision, expectations, cadPath: path,
  })
  const manifest = buildManifest({
    design, cadPath: path, cadBytes: statSync(path).size, cadHash: hashFile(path),
    features: rebuilt?.features ?? project.features ?? [],
    bindings: rebuilt?.bindings ?? project.bindings ?? {},
    dimensionBindings: rebuilt?.dimensionBindings ?? project.dimensionBindings ?? {},
    drivers: rebuilt?.drivers ?? project.drivers ?? null,
  })
  writeJsonAtomic(designFileFor(path), design)
  writeJsonAtomic(manifestFileFor(path), manifest)
  project.cadPath = path
  project.revision = revision
  project.designFile = designFileFor(path)
  project.manifestFile = manifestFileFor(path)
  // 必须立刻落盘：下面 artifacts 那次 writeProject 会重新 readProject，
  // 只改这个局部对象的话 cadPath/revision/designFile 全部丢失（真机 C04-02 上丢了）。
  writeProject({ ...project, updatedAt: new Date().toISOString() })
  return { revision, designFile: designFileFor(path), manifestFile: manifestFileFor(path), designHash: manifest.designHash }
}

// 「文档刚好被关掉」这类失败不是交付失败，而是"换个来源再来一次"的信号。
const DELIVER_RETRYABLE_CODES = new Set(['DOC_NOT_OPEN', 'DOC_MISMATCH', 'OPEN_FAILED', 'FILE_NOT_FOUND'])

/** 交付失败也回 saved/bytes/source/elapsedMs：调用方要能核对"到底落盘没有"。 */
function deliverFailure({ designId, targetPath, started, route, error, nextActions }) {
  // 失败时字节数只看磁盘：save 抛错也可能已经写出半个文件，这个数要如实回。
  let bytes = 0
  try { if (typeof targetPath === 'string' && targetPath.length > 0) bytes = statSync(targetPath).size } catch { bytes = 0 }
  const delivery = {
    saved: false,
    verified: false,
    bytes,
    designId,
    source: route?.source ?? null,
    elapsedMs: Date.now() - started,
    targetPath: targetPath ?? null,
    route: route === null || route === undefined ? null : {
      reason: route.reason ?? null,
      match: route.match ?? null,
      reopenPath: route.reopenPath ?? null,
      rebuild: route.rebuild === true,
    },
  }
  return failed({
    op: 'deliver.sldprt',
    designId,
    error,
    nextActions,
    delivery,
    // 四个核对字段同时平铺在 changes 里：调用方读 changes.saved 或
    // delivery.saved 都对（与 measurements 同一处理）。
    changes: {
      delivery,
      route: delivery.route,
      saved: delivery.saved,
      bytes: delivery.bytes,
      source: delivery.source,
      elapsedMs: delivery.elapsedMs,
    },
  })
}

async function deliverPartFile({ designId, path: targetPath, started }) {
  if (activeBuildDesigns.has(designId)) {
    return deliverFailure({
      designId, targetPath, started, route: null,
      error: fail('BUILD_IN_PROGRESS', `${designId} 正在 build：先等 build 返回再 deliver，别让两份作业叠在同一份文档上`, { designId }),
      nextActions: ['等 model action="build" 返回后重试 deliver'],
    })
  }

  let outcome = null
  let route = null
  let lastError = null
  try {
    const attempted = new Set()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const project = readProject(designId)
      const facts = await collectDeliverFacts({ designId, project, targetPath })
      // 上一轮 save 已经明说 DOC_NOT_OPEN：即使这次拿不到打开清单，也能断定
      // 「窗口里没有这一份」，不要再把 null 当成"未知"重复同一条 active 路径。
      if (facts.openDocuments === null && lastError?.code === 'DOC_NOT_OPEN') facts.openDocuments = []
      route = planDeliverRoute(facts)
      if (route.ok !== true) break
      if (attempted.has(route.source)) break
      attempted.add(route.source)
      try {
        outcome = await executeDeliverRoute(route, { designId, project, targetPath })
        break
      } catch (error) {
        lastError = error
        // 预检与保存之间文档被关掉：按新事实重新决策（active → reopened/rebuilt），
        // 而不是把 DOC_NOT_OPEN 直接交回给调用方。
        if (!DELIVER_RETRYABLE_CODES.has(error?.code) || attempt === 2) throw error
      }
    }
    if (outcome === null) {
      const error = lastError ?? fail('DELIVER_SOURCE_UNAVAILABLE',
        route?.message ?? `design "${designId}" 没有可交付的来源：文档没打开、盘上没有 SLDPRT、项目存档里也没有设计定义`,
        route ?? null)
      return deliverFailure({
        designId, targetPath, started, route, error,
        nextActions: [
          '先 workspace action="open" path=... 打开已有文件，或 model action="build" 按设计定义重建一次',
          '确认 designId 与文件旁的 design.json 是同一份（inspect action="model" 回文档标题/路径）',
        ],
      })
    }

    const savedResult = outcome.saved ?? {}
    const wrote = savedResult.saved === true
    const fileCheck = checkDeliveredFile(targetPath, 'sldprt', savedResult.bytes)

    // 保存后回读：关掉重开，实体数（装配：组件数）> 0 才算交付。
    let readback = null
    let judgement = { ok: false, metric: 'bodies', value: null, reason: 'NOT_WRITTEN' }
    if (wrote && fileCheck.ok) {
      const projectNow = readProject(designId)
      readback = await verifyDeliveredPartFile({ designId, targetPath, project: projectNow })
      judgement = judgeReopenedDocument({ kind: readback.kind, bodies: readback.bodies, components: readback.components })
    }
    // 字节数回读放在重开之后：回读过程不写文件，但它才是「交付那一刻磁盘上的事实」。
    let fileStat = null
    try { fileStat = statSync(targetPath) } catch { fileStat = null }
    const bytes = fileStat?.size ?? (Number.isFinite(savedResult.bytes) ? savedResult.bytes : 0)
    const verified = wrote && fileCheck.ok && judgement.ok === true

    if (wrote && fileCheck.ok) {
      // 只有存成 .sldprt 才让文档变成「已存盘」：账本立刻销掉，之后的清扫绝不能再碰
      // 用户文件。
      sessionDocs.delete(designId)
    }
    let designStore = null
    if (wrote && fileCheck.ok) {
      try {
        const projectNow = readProject(designId)
        designStore = await writeDeliveryContract({
          designId, project: projectNow, path: targetPath,
          measuredShape: readback?.geometry ?? null, rebuilt: outcome.rebuilt,
        })
      } catch (error) {
        designStore = { skipped: true, reason: error?.message ?? String(error) }
      }
    }
    {
      // artifacts 记账失败不能把"文件已写出"变成"交付失败"。
      try {
        const projectNow = readProject(designId)
        if (projectNow) {
          writeProject({
            ...projectNow,
            step: 'exported',
            updatedAt: new Date().toISOString(),
            artifacts: [...(projectNow.artifacts ?? []), { kind: 'sldprt', path: targetPath, bytes }],
          })
        }
      } catch { /* 账本不是交付证据 */ }
    }

    const elapsedMs = Date.now() - started
    const delivery = {
      saved: wrote,
      verified,
      bytes,
      designId,
      source: route.source,
      elapsedMs,
      targetPath,
      route: {
        reason: route.reason ?? null,
        match: route.match ?? null,
        reopenPath: route.reopenPath ?? null,
        rebuild: route.source === 'rebuilt',
      },
      fileCheck,
      judgement,
      readback,
      designStore,
    }
    const activation = {
      active: readback?.reopened === true || (readback?.title !== null && readback?.title !== undefined),
      title: readback?.title ?? null,
      path: targetPath,
      method: route.source,
      note: readback?.reopened === true
        ? '保存后关掉重开：实体读数来自磁盘上的文件'
        : readback?.skipped
          ? `没有关掉重开（${readback.skipped}）：读数是当前打开的文档，不是磁盘回读`
          : '重开回读失败：见 readback.error',
    }
    const summary = verified
      ? `已交付 ${designId} → ${targetPath}（${bytes} 字节；source=${route.source}；重开后 ${judgement.metric}=${judgement.value}）`
      : wrote && fileCheck.ok
        ? `已写出 ${targetPath}（${bytes} 字节），但重开回读没通过：${readback?.error?.message ?? judgement.reason}`
        : wrote
          ? `已写出 ${targetPath}，但文件自检不通过：${fileCheck.failed.join('、')}`
          : `写出失败：SOLIDWORKS 返回 errors=${savedResult.errors}`

    return ok(
      envelope({
        summary,
        designId,
        status: verified ? 'ok' : 'failed',
        artifacts: [{ kind: 'sldprt', path: targetPath, bytes }],
        changes: {
          repairedEquations: savedResult.repairedEquations,
          fileCheck,
          designStore,
          activation,
          readback,
          delivery,
          route: delivery.route,
          // 核对字段平铺一份：读 changes.saved 或 delivery.saved 都对。
          saved: delivery.saved,
          bytes: delivery.bytes,
          source: delivery.source,
          elapsedMs: delivery.elapsedMs,
        },
        delivery,
        nextActions: verified
          ? [
            '交付已完成并重开验证：需要复测用 inspect action=verify tiers=["file","geometry"]',
            '装配时把这个 path 原样填进 components[].path',
          ]
          : wrote && fileCheck.ok
            ? [
              '文件已写出但重开回读没过：先 workspace action="open" 打开该路径，确认实体数 > 0 再重试 deliver',
              ...(readback?.error ? [`回读失败原因：${readback.error.code} ${readback.error.message}`] : []),
            ]
            : [
              '看 save 返回的 errors；确认没有别的会话正在改同一份文档',
              '文档被关掉且盘上文件也不可信时，先 model action="build" 重建再 deliver',
            ],
        timings: { totalMs: elapsedMs },
      }),
    )
  } catch (error) {
    return deliverFailure({
      designId, targetPath, started, route, error,
      nextActions: route?.source === 'rebuilt'
        ? ['重建失败：先 model action="build" 用同一份定义建一次，确认能建成再 deliver']
        : undefined,
    })
  }
}

async function handlePartExport(args) {
  let designId = null
  const started = Date.now()
  try {
    // deliver 也件件有主：没有 designId 就不知道该把哪一份交付出去（F3）。
    designId = requireDesignId(args.designId, { tool: 'deliver', action: args.kind ?? 'sldprt' })
    const dir = join(DATA_DIR, 'out')
    mkdirSync(dir, { recursive: true })
    const name = `${designId}.${args.kind}`
    const path = args.path ?? join(dir, name)

    // 原生 SLDPRT：不依赖「当前活动文档」。按 designId 定位文档，关掉就重开或按
    // 设计定义重建，保存后再关掉重开读实体数；见 deliverPartFile。
    // step/stl/pdf/dxf/dwg 的导出语义不动：导出不改变文档存盘状态。
    if (args.kind === 'sldprt') return await deliverPartFile({ designId, path, started })

    // 交付前先确保目标文档是前台：桥接器的 save 按 designId 找文档，但「保存的到底是
    // 哪一份」必须能被回读证明。open 会 ActivateDoc3 并回 activeIsRequested。
    const activation = await ensureActiveForDesign(designId)
    const result = await callBridge('export', { designId, kind: args.kind, path })
    const wrote = result.exported
    const fileCheck = checkDeliveredFile(path, args.kind, result.bytes)
    // design.json / 关掉重开回读只属于原生 SLDPRT 那条路（deliverPartFile）；
    // 导出格式不改变文档存盘状态，这里只记 artifacts。
    {
      const project = readProject(designId)
      if (project) {
        writeProject({
          ...project,
          step: 'exported',
          updatedAt: new Date().toISOString(),
          artifacts: [...(project.artifacts ?? []), { kind: args.kind, path, bytes: result.bytes }],
        })
      }
    }

    return ok(
      envelope({
        summary: wrote && fileCheck.ok
          ? `已写出 ${path}（${fileCheck.size} 字节，自检通过）`
          : (wrote ? `已写出 ${path}，但自检不通过：${fileCheck.failed.join('、')}` : `写出失败：SOLIDWORKS 返回 errors=${result.errors}`),
        designId,
        status: wrote && fileCheck.ok ? 'ok' : 'failed',
        artifacts: [{ kind: args.kind, path, bytes: result.bytes }],
        changes: { repairedEquations: result.repairedEquations, fileCheck, designStore: null, activation, readback: null },
      }),
    )
  } catch (error) {
    return failed({ op: 'deliver.export', designId, error })
  }
}

// ------------------------------------------------------------------ lesson

async function handleLesson(args) {
  try {
    switch (args.action) {
      case 'add': {
        // 注意：这个对象的 action 也是 "add" 本身（lesson.action），不能把它当成
        // 经验条目的「动作」拼进文本，否则空的 add 会写进一条内容为 "add" 的垃圾。
        const actionText = args.action && args.action !== 'add' ? args.action : undefined
        const text = args.text ?? [actionText, args.observation].filter(Boolean).join(' → ')
        if (!text) throw fail('BAD_ARGUMENT', 'add 需要 text，或者 action + observation')
        const gateError = lessonGate(text)
        if (gateError) throw fail('LESSON_REJECTED', gateError.message, { hint: gateError.hint })
        const duplicate = findDuplicateNote(text)
        if (duplicate) {
          return ok(
            envelope({
              summary: `这条已经有了：${duplicate.id}，没有重复写入`,
              designId: null,
              changes: { note: duplicate, duplicate: true },
            }),
          )
        }
        const note = {
          id: `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          at: new Date().toISOString(),
          kind: args.kind ?? 'pitfall',
          status: args.status ?? 'working',
          text,
          ...(args.conditions !== undefined ? { conditions: args.conditions } : {}),
          ...(args.action ? { action: args.action } : {}),
          ...(args.observation ? { observation: args.observation } : {}),
          ...(args.evidenceRefs ? { evidenceRefs: args.evidenceRefs } : {}),
          ...(args.benefit ? { benefit: args.benefit } : {}),
          ...(args.environment ? { environment: args.environment } : {}),
          ...(args.op ? { op: args.op } : {}),
          ...(args.tags ? { tags: args.tags } : {}),
          ...(args.errorCode ? { errorCode: args.errorCode } : {}),
          ...(args.tried ? { tried: args.tried } : {}),
          ...(args.evidence ? { evidence: args.evidence } : {}),
          ...(args.status === 'curated' || args.status === 'verified' ? { curated: true } : {}),
        }
        appendNote(note)
        return ok(envelope({ summary: `已记下 ${note.id}`, designId: null, changes: { note } }))
      }
      case 'digest': {
        // 空闲期归纳：同一 动作+观察 的多条记录合并成一条，其余标成被它取代。
        // 只动仍然有效的记录；已废弃/已被替代的留给 reclaim 按时间清。
        const { entries } = readNotes()
        const groups = new Map()
        for (const entry of entries) {
          if (!entry?.id || entry.supersededBy || entry.status === 'deprecated') continue
          const observation = String(entry.observation ?? '').trim().toLowerCase()
          // add 动作本身也会占 entry.action，这里按“观察”归并；没有观察才退回正文。
          const key = observation || String(entry.text ?? '').trim().toLowerCase()
          if (!key) continue
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(entry)
        }
        const merged = []
        for (const [key, group] of groups) {
          if (group.length < 2) continue
          group.sort((a, b) => (Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0))
            || (Number(b.useCount ?? 0) - Number(a.useCount ?? 0)))
          const [keeper, ...rest] = group
          for (const entry of rest) {
            replaceNote(entry.id, { supersededBy: keeper.id, supersededAt: new Date().toISOString() })
          }
          replaceNote(keeper.id, { useCount: group.reduce((sum, e) => sum + Number(e.useCount ?? 0), 0) || group.length })
          merged.push({ key, kept: keeper.id, superseded: rest.map((e) => e.id) })
        }
        return ok(envelope({
          summary: merged.length ? `合并了 ${merged.length} 组重复经验` : '没有需要合并的重复经验',
          designId: null,
          changes: { merged, total: merged.reduce((sum, item) => sum + item.superseded.length, 0) },
        }))
      }
      case 'search': {
        const found = listNotes({ query: args.query, kind: args.kind, limit: args.limit })
        return ok(
          envelope({
            summary: `找到 ${found.entries.length} 条经验（库中共 ${found.total} 条）`,
            designId: null,
            // Both names on purpose: `entries` is what every other list action in this
            // server returns, `lessons` says what these entries are. Callers had to
            // guess before, and a guess that missed looked exactly like "no results".
            changes: { lessons: found.entries, entries: found.entries },
          }),
        )
      }
      case 'update': {
        if (!args.id) throw fail('BAD_ARGUMENT', 'update 需要 id')
        const patch = {
          ...(args.text ? { text: args.text } : {}),
          ...(args.status ? { status: args.status } : {}),
          ...(args.tags ? { tags: args.tags } : {}),
          ...(args.evidence ? { evidence: args.evidence } : {}),
        }
        const found = replaceNote(args.id, patch)
        if (!found) throw fail('NOT_FOUND', `没有 ${args.id}`)
        return ok(envelope({ summary: `已更新 ${args.id}`, designId: null, changes: patch }))
      }
      case 'supersede': {
        if (!args.id || !args.text) throw fail('BAD_ARGUMENT', 'supersede 需要 id 和 text')
        const note = {
          id: `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          at: new Date().toISOString(),
          kind: args.kind ?? 'decision',
          status: args.status ?? 'working',
          text: args.text,
          supersedes: args.id,
          ...(args.conditions !== undefined ? { conditions: args.conditions } : {}),
          ...(args.action ? { action: args.action } : {}),
          ...(args.observation ? { observation: args.observation } : {}),
          ...(args.evidenceRefs ? { evidenceRefs: args.evidenceRefs } : {}),
          ...(args.benefit ? { benefit: args.benefit } : {}),
          ...(args.environment ? { environment: args.environment } : {}),
          ...(args.tags ? { tags: args.tags } : {}),
          ...(args.evidence ? { evidence: args.evidence } : {}),
          ...(args.status === 'curated' || args.status === 'verified' ? { curated: true } : {}),
        }
        appendNote(note)
        // 双向替代关系：旧条目也记下被谁替代，检索时不用每次反推。
        replaceNote(args.id, { supersededBy: note.id, supersededAt: note.at })
        return ok(
          envelope({
            summary: `已用 ${note.id} 替代 ${args.id}`,
            designId: null,
            changes: { note },
          }),
        )
      }
      case 'reclaim': {
        // 只回收「已经被替代、且过了保留期」的旧记录；未替代的一律保留。
        const keepMs = Number.isFinite(args.keepMs) ? args.keepMs : 30 * 24 * 3600_000
        const raw = existsSync(NOTES_FILE) ? readFileSync(NOTES_FILE, 'utf8') : ''
        const lines = raw.split('\n').filter((line) => line.trim())
        const parsed = []
        for (const line of lines) {
          try { parsed.push(JSON.parse(line)) } catch { parsed.push(null) }
        }
        const liveIds = new Set(parsed.filter(Boolean).map((entry) => entry.id))
        const superseded = new Set(parsed.filter(Boolean).filter((entry) => entry.supersedes).map((entry) => entry.supersedes))
        const now = Date.now()
        const kept = []
        let removed = 0
        for (let i = 0; i < parsed.length; i += 1) {
          const entry = parsed[i]
          if (!entry) { kept.push(lines[i]); continue }
          const replaced = entry.supersededBy || superseded.has(entry.id)
          const at = Date.parse(entry.supersededAt ?? entry.at ?? 0) || 0
          const stale = entry.status === 'deprecated' && now - at > keepMs
          if (replaced && now - at > keepMs) { removed += 1; continue }
          if (stale) { removed += 1; continue }
          kept.push(lines[i])
        }
        // 只删不存在的目标 id 的 supersedes 指针没有意义；这里顺手保留，不做二次改写。
        if (removed > 0) writeFileSync(NOTES_FILE, `${kept.join('\n')}\n`, 'utf8')
        return ok(envelope({
          summary: `经验回收：删除 ${removed} 条过期的被替代/废弃记录`,
          designId: null,
          changes: { removed, kept: kept.length, liveIds: liveIds.size, superseded: superseded.size },
        }))
      }
      case 'recipes': {
        const recipes = readRecipes()
        return ok(
          envelope({
            summary: `${recipes.length} 条建模配方`,
            designId: null,
            changes: { recipes },
          }),
        )
      }
      case 'saveRecipe': {
        if (!args.recipe) throw fail('BAD_ARGUMENT', 'saveRecipe 需要 recipe')
        const recipes = readRecipes()
        const name = args.recipe.name ?? `recipe-${Date.now()}`
        const next = [...recipes.filter((r) => r.name !== name), { ...args.recipe, name, savedAt: new Date().toISOString() }]
        writeRecipes(next)
        return ok(envelope({ summary: `已存配方 ${name}`, designId: null, changes: { name } }))
      }
      default:
        throw fail('BAD_ARGUMENT', `未知 action ${args.action}`)
    }
  } catch (error) {
    return failed({ op: `lesson.${args.action}`, designId: null, error })
  }
}

// 观察类工具：看模型、按持久引用选面、出图、交付。
registerCalculateTools(server, z, { envelope, ok, failed, fail })

registerObserveTools(server, z, {
  envelope, ok, failed, fail, callBridge, resolveDesignId, designIdArg,
  readFileSync, join, tmpdir, dataDir: DATA_DIR, handlePartCheck, handlePartInspect, handlePartExport,
  recordRelationAudit,
  // F2：关系审计落账要用**本设计自己的实时 revision**（不传就回退旧值，那条路已删）。
  liveRevisionOf: (designId) => liveRevisionOf({ dataDir: DATA_DIR, designId }),
  // F6：量到的文档标题与 designId 登记不符 → WRONG_DOCUMENT。
  documentIdentityCheck,
  // F3：缺 designId 直接报 DESIGN_ID_REQUIRED（与桥接器同一错误码）。
  requireDesignId,
  clientId: clientIdFor(null),
})

// 命名基准几何：名字 + 全局位姿落在 design.json，装配用 placement:"datum:<name>"。
registerDatumTools(server, z, { envelope, ok, failed, fail, callBridge, readProject, writeProject, requireDesignId, designIdArg })

// 只是读文件的分析（STEP/图像）；没有 SOLIDWORKS 也能用。
registerAnalysisTools(server, z, { envelope, ok, failed, fail })

// 持久作业与任务图：作业直接走 broker，任务图在服务进程内调度 bridge 调用。
registerJobTools(server, z, { envelope, ok, failed, fail })
registerTaskTools(server, z, { envelope, ok, failed, fail, callBridge })

if (COMPACT_MCP) {
  const revisionOf = (designId) => liveRevisionOf({ dataDir: DATA_DIR, designId })
  const runtime = createStageRuntime({
    dir: join(DATA_DIR, 'stage-jobs'),
    dispatch: dispatchOperation,
    revisionOf,
    broker: process.env.SW_MCP_BROKER === '1'
      ? async (method, params) => (await sharedBroker()).request(method, params)
      : undefined,
  })
  registerCompactTools({ registerTool: registerMcpTool }, {
    runtime, dispatchOperation, validateOperation, operations, revisionOf, parseEnvelopeText,
  })
}

// --------------------------------------------------------------------------- 启动

const transport = new StdioServerTransport()
pruneLogs()
writeEvent({ level: 'info', tool: 'server', message: 'started', version: '0.6.0', logDir: LOG_DIR })
await server.connect(transport)

process.on('SIGINT', () => {
  try {
    child?.kill()
  } catch {
    // 退出路径上不该再抛
  }
  process.exit(0)
})

