// 交付前的程序化检查门（不调用模型）。
//
// 这个插件只做三件可验证的事，都在 tools/pre-execute 上：
//   1. designId 必须显式给出（不猜「上一个 / 最近用过的」）；
//   2. 关系审计与 inspect action="verify" 必须对当前 revision 成立；
//   3. 当前 revision 至少有一张自己拍的图（capture / compare），输出路径上的旧文件
//      不能早于最近一次几何修改。
//
// 它不再拉子代理、不再让另一个模型看图判「像不像」：没有参考图纸时那种判定只能给
// incomplete（把握 0.4）、differences 为空却要求按差异改。交付文件本身的核对放在
// 服务端（deliver 写完后自检存在 / 字节 / 时间戳），这里只挡「这一版根本没证据」
// 的交付。拒绝不关闭任何文档。

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
// 与 server.mjs 共用同一份判定：交付门禁与服务端不各写一套「什么算有关系的草图」。
import { auditRelations } from './server/geometry-plan.mjs'

export const name = 'sw-review-gate'
export const inject = ['tools']

// 审查员必须显式走一个模型路由。DSH 的 subagent startActivation 支持 agentOptions
// {provider, model}；这里给默认值，cordis.patch.yml 的 review-gate config.reviewModel
// 或环境变量都能覆盖。拿不到显式路由时拒绝交付（fail closed），绝不静默用父模型。
const DEFAULT_REVIEW_MODEL = { provider: 'deepseek-account', model: 'deepseek-flash' }
const MUTATING_ACTIONS = new Set(['build', 'edit', 'create', 'invoke', 'rebuild', 'undo', 'assemble', 'drawing'])
const MAX_IMAGES = 4
// 额度按「每条设计」计，不按会话计：同一会话里做多个零件是常态，按会话计会让后续
// 零件还没审就「额度用尽」（review.jsonl L718-723：6 个设计共用 6 个额度就是铁证）。
const MAX_REVIEWS_PER_DESIGN = 6

// 会话 → 审查状态。模块级而不是 file 级：同一个会话里插件只该有一份状态。
const SESSIONS = new Map()

/**
 * 第一轮只看原图：让一个没见过模型的人先说出「图纸上有什么」。
 * 这份清单和后面的成品审查是两条独立的证据链 —— 主模型不能参与写它。
 */
const OBSERVATION_SCHEMA = {
  type: 'object',
  properties: {
    observations: { type: 'array', items: { type: 'string' } },
    unresolved: { type: 'array', items: { type: 'string' } },
  },
  required: ['observations'],
  additionalProperties: false,
}

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'observations'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['passed', 'different', 'incomplete'],
      description: 'passed = 两张图在形状与相对位置上一致；different = 有不一致且你能指出位置；incomplete = 图不够，无法判断',
    },
    observations: {
      type: 'array',
      description: '逐项观察结果；每条都要指出在哪张图的哪个区域',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'status', 'sourceRegion', 'modelRegion'],
        properties: {
          item: { type: 'string', description: '看的是哪一项：外轮廓 / 某处切口 / 孔位 / 支承与筋' },
          status: { type: 'string', enum: ['match', 'different', 'uncertain'] },
          sourceRegion: {
            type: 'array', description: '在参考图上的区域，0—1 归一化 [x0,y0,x1,y1]',
            items: { type: 'number' },
          },
          modelRegion: {
            type: 'array', description: '在模型图上的对应区域，同样 0—1 归一化',
            items: { type: 'number' },
          },
          observedDifference: { type: 'string', description: 'different 时写清看到的不同（形状/位置）' },
          neededView: { type: 'string', description: '看不清时：需要补看哪个视图或哪处剖面' },
        },
      },
    },
    unresolved: {
      type: 'array',
      description: '看不清的项：缺什么证据',
      items: { type: 'string' },
    },
    differences: {
      type: 'array',
      description: '旧字段：没填 observations 时才读',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['region', 'expected', 'actual'],
        properties: {
          region: { type: 'string', description: '在图的哪个位置（区域描述）' },
          expected: { type: 'string', description: '图纸上是什么样' },
          actual: { type: 'string', description: '模型图上是什么样' },
          severity: { type: 'string', enum: ['blocking', 'minor'] },
        },
      },
    },
    confidence: { type: 'number', description: '0..1，你自己对这个判定的把握' },
    notes: { type: 'string', description: '可选补充' },
  },
}

function sessionKey(agent) {
  return agent?.session?.id ?? agent?.id ?? agent?.session?.header?.id ?? 'unknown'
}

/**
 * 同一会话里的「每个设计自己的几何版本号」。
 *
 * 为什么必须按 designId 隔离：`state.revision` 原来是 agent 级单调累加、换 designId
 * 也不清零（Math.max），而 live.json 的 revision 是**每个设计**自己的计数器。于是
 * 换一条设计之后门禁拿「新设计的小 revision」去比「旧设计留下的 10/18/21」，
 * 永远追不上 —— 四个会话为此撞了 40 次 RELATIONS_INCOMPLETE。现在换设计就换计数器：
 * 见过的那条设计从它自己的值继续，没见过的新设计从 0 开始。
 */
function rememberRevision(state) {
  if (typeof state.designId === 'string' && state.designId.length > 0) {
    state.designRevisions.set(state.designId, state.revision)
  }
}

/**
 * 切到某条设计：换计数器，并把它名下的证据全部作废。
 *
 * 图/核对/关系审计/审查结论都是「这一版这个件」的证据，跨设计借用等于让 A 的
 * 证据给 B 签字。实测的跨设计污染正是从「hydrate 时借了别条设计的记录」开始的。
 */
function activateDesign(state, designId) {
  if (typeof designId !== 'string' || designId.length === 0) return false
  if (state.designId === designId) return false
  const had = typeof state.designId === 'string' && state.designId.length > 0
  rememberRevision(state)
  const known = state.designRevisions.get(designId)
  state.designId = designId
  state.revision = Number.isFinite(known) ? known : 0
  // 额度按设计计：换设计时把镜像同步到这条设计自己的计数（新设计从 0 开始）。
  state.reviews = reviewsFor(state, designId)
  state.liveSynced = false
  state.verify = null
  state.verifyStale = null
  state.relationAudit = null
  state.relationGate = null
  state.verdict = null
  state.reviewedRevision = -1
  state.measurements = null
  state.snapshotId = null
  state.artifactHash = null
  if (had) state.documentId = null
  // 换设计时清图：旧图是另一个零件的照片，留着会让「这一版有图」凭空成立。
  if (had) state.images = []
  return true
}

function stateOf(agent) {
  const key = sessionKey(agent)
  let state = SESSIONS.get(key)
  if (state === undefined) {
    state = {
      key,
      revision: 0,
      reviewedRevision: -1,
      verdict: null,
      images: [],
      measurements: null,
      designId: null,
      documentId: null,
      snapshotId: null,
      artifactHash: null,
      reviews: 0,
      reviewCache: new Map(),
      lastMutationAt: 0,
      relationAudit: null,
      relationGate: null,
      reviewModel: null,
      unavailable: null,
      // 确定性核对（inspect action=verify）的最近一次结果；交付前先看它，再看图。
      verify: null,
      // 记录里那份 verify 的 revision 和当前对不上时留个痕（几何改过 → 旧证据作废）。
      verifyStale: null,
      // 图纸源文件指纹：observe 子代理的缓存键要用它，而不是每轮都变的合成图指纹。
      drawingDigest: null,
      // 每条设计自己的几何版本号（见 activateDesign）。
      designRevisions: new Map(),
      // 每条设计已消耗的审查次数。额度按设计计：同一会话做多个零件是常态，按会话
      // 计会让后续零件无额度可用（review.jsonl L718-723 的 6 个设计共用 6 个额度
      // 就是铁证）。state.reviews 只是「当前设计」的镜像，供日志字段沿用。
      designReviews: new Map(),
      // 这一条设计的 revision 是否已经由服务侧的 live.json 接管过。
      // 服务是几何版本的唯一事实源：接管之后就以它为准，不再两边各自 +1。
      liveSynced: false,
      // F7 熔断：`designId::code` → 连续硬失败次数。
      gateFailures: new Map(),
    }
    SESSIONS.set(key, state)
  }
  return state
}

/** 这条设计已消耗的审查次数（额度按设计计，见 review.jsonl L718-723 的铁证）。 */
function reviewsFor(state, designId) {
  return state.designReviews.get(designId) ?? 0
}

/** 记一次真审查；同时维护 state.reviews 作为「当前设计」的镜像，保持日志字段语义。 */
function bumpReview(state, designId) {
  if (typeof designId !== 'string' || designId.length === 0) return 0
  const next = reviewsFor(state, designId) + 1
  state.designReviews.set(designId, next)
  if (designId === state.designId || state.designId === null) state.reviews = next
  return next
}

/** 文件指纹：用来回答「审查的是不是交付的这一版」。读不到就返回 null，不编一个假哈希。 */
function fileDigest(path, length = 16) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, length)
  } catch {
    return null
  }
}

// 状态里留多少张图。审查只送 MAX_IMAGES 张，但「从哪些图里挑」必须比 4 张多：
// 以前状态一收进来就砍到 4 张，于是「按视角去重、补一张上视」根本无从谈起。
const MAX_STATE_IMAGES = 16

// 视角归一。capture 的 view 参数是「*上视」这种中文名，compare 的 view 是 top/front/iso，
// 文件名或 caption 里也常带中文视图名 —— 都落到同一套键上，才能「同视角只留一张」。
// 顺序即优先级：上视/俯视排最前，保证「至少一张上视入选」不会被名额挤掉。
const VIEW_ORDER = ['top', 'bottom', 'iso', 'front', 'back', 'left', 'right']
const VIEW_ALIASES = [
  ['top', ['上视', '俯视', '顶视', 'top']],
  ['bottom', ['下视', '仰视', 'bottom']],
  ['iso', ['等轴测', '轴测', 'isometric', 'iso']],
  ['front', ['前视', '主视', 'front']],
  ['back', ['后视', 'back']],
  ['left', ['左视', 'left']],
  ['right', ['右视', 'right']],
]
const VIEW_LABELS = { top: '上视', bottom: '下视', iso: '等轴测', front: '前视', back: '后视', left: '左视', right: '右视' }
// 同一视角里优先哪一类：compare 是「图纸 | 模型」并排图，一次能看两样，信息量最大。
const KIND_RANK = { compare: 0, figure: 1, capture: 2, other: 3 }

/** 从显式的 view 参数里认出视角（'top' / '*上视' / '等轴测'）。认不出返回 null。 */
export function matchView(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const text = value.toLowerCase()
  for (const [key, aliases] of VIEW_ALIASES) {
    if (aliases.some((alias) => text.includes(alias))) return key
  }
  return null
}

/** 从 caption / 文件名里认视角：英文词必须整词（否则 Desktop 会被读成 top、
 *  background 会被读成 back），中文照旧按子串。 */
function matchViewInText(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const text = value.toLowerCase()
  for (const [key, aliases] of VIEW_ALIASES) {
    for (const alias of aliases) {
      if (/^[a-z]+$/.test(alias)) {
        if (new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`).test(text)) return key
      } else if (text.includes(alias)) {
        return key
      }
    }
  }
  return null
}

/** origin 字段 → 图的类别。'inspect.figure' / 'figure' 都算 figure。 */
function originKindOf(origin) {
  const text = String(origin ?? '').toLowerCase()
  if (text.length === 0) return null
  if (text.includes('figure') || /^fig\b/.test(text)) return 'figure'
  if (text.includes('compare') || /^cmp\b/.test(text)) return 'compare'
  if (/capture|shot|inspect|model|render/.test(text)) return 'capture'
  return null
}

/** 文件名 → 图的类别（fig-07 / cmp-03 / shot-12）。认不出返回 null。 */
function pathKindOf(path) {
  const base = basename(String(path ?? '')).toLowerCase()
  if (base.length === 0) return null
  if (/^fig(?:ure)?[-_.]|^figure/.test(base)) return 'figure'
  if (/^(?:cmp|compare)[-_.]|^compare/.test(base)) return 'compare'
  if (/^shot|^capture/.test(base)) return 'capture'
  return null
}

/** 这张图是怎么来的：figure 裁剪块 / compare 并排图 / capture 渲染图 / 其它。
 *
 *  旧代码只有一句 `!/figure/.test(origin)`：compare 被当成模型图，于是「参考图纸」
 *  恒为空，prompt 每次都走「这次没有参考图纸」分支、confidence 封顶 0.5。
 *  compare 的左半幅就是图纸，它必须算参考图。
 */
export function kindOfImage(item) {
  return originKindOf(item?.origin) ?? pathKindOf(item?.path) ?? 'other'
}

const isReferenceKind = (kind) => kind === 'figure' || kind === 'compare'

/** 视角：优先显式 view，其次 caption，最后文件名里带的视图名。
 *  只看文件名、不看整条路径 —— 路径里的 Desktop 会被误读成「上视」。 */
function viewOfImage(item) {
  return matchView(item?.view)
    ?? matchViewInText(item?.caption)
    ?? matchViewInText(basename(String(item?.path ?? '')))
}

/** 缺 origin 的老数据按文件名回填一次；认不出来就保留原值（不覆盖真实来源）。 */
function backfillOrigin(item) {
  if (originKindOf(item?.origin) !== null) return
  const inferred = pathKindOf(item?.path)
  if (inferred !== null) item.origin = inferred
}

function preference(a, b) {
  const rank = (KIND_RANK[a.kind] ?? 3) - (KIND_RANK[b.kind] ?? 3)
  if (rank !== 0) return rank
  const atA = Date.parse(a.item?.at ?? '') || 0
  const atB = Date.parse(b.item?.at ?? '') || 0
  if (atA !== atB) return atB - atA
  return String(a.item?.path ?? '').localeCompare(String(b.item?.path ?? ''))
}

/**
 * 送审选图（不超过 MAX_IMAGES 张）。
 *
 * 旧做法是 `ordered.slice(-MAX_IMAGES)`：主会话产出 8 张时刚好取到最后四张，
 * 同一视角各两张、上视一张没进，审查员只能说「现在只有前视和右视」→ 只能判 incomplete。
 *
 * 现在的规则：
 *   1. 每个已知视角留一张「模型侧」图（capture 或 compare），优先 compare；视角按
 *      上视/下视 → 等轴测 → 前视 → 后视 → 左视 → 右视 排，上视先占位；
 *   2. 视角未知的（PTC 下 live.json 只有路径）按 compare 优先、再 capture 补位 ——
 *      实测里 4 张 compare 并排图正好覆盖等轴测/前视/上视/右视；
 *   3. 还有名额就补参考图（figure 裁剪块），再补剩下的图；
 *   4. 有参考图时留一格给它，否则又退化成「只有模型图、只能看自身缺陷」。
 *
 * 视角在缺少元数据时只能是估计，所以它只影响「送哪几张」，不会被写进 prompt 当事实。
 */
export function selectForReview(items) {
  const entries = (Array.isArray(items) ? items : [])
    .filter((item) => typeof item?.path === 'string' && item.path.length > 0)
    .map((item) => ({ item, kind: kindOfImage(item), view: viewOfImage(item) }))
  const picked = []
  const pickedPaths = new Set()
  const takenViews = new Set()
  const take = (entry) => {
    if (entry === undefined || picked.length >= MAX_IMAGES) return false
    if (pickedPaths.has(entry.item.path)) return false
    if (entry.view !== null && takenViews.has(entry.view)) return false
    picked.push(entry)
    pickedPaths.add(entry.item.path)
    if (entry.view !== null) takenViews.add(entry.view)
    return true
  }
  const modelSide = entries.filter((entry) => entry.kind !== 'figure')
  const hasReference = entries.some((entry) => isReferenceKind(entry.kind))
  // 有参考图就给它留一格：名额全被模型图吃掉，等于又回到「没有参考图纸」。
  const modelBudget = hasReference ? Math.max(1, MAX_IMAGES - 1) : MAX_IMAGES
  const knownViews = new Map()
  for (const entry of modelSide) {
    if (entry.view === null) continue
    const list = knownViews.get(entry.view) ?? []
    list.push(entry)
    knownViews.set(entry.view, list)
  }
  for (const view of VIEW_ORDER) {
    if (picked.length >= modelBudget) break
    const group = knownViews.get(view)
    if (group === undefined || group.length === 0) continue
    take([...group].sort(preference)[0])
  }
  for (const entry of modelSide.filter((entry) => entry.view === null).sort(preference)) {
    if (picked.length >= modelBudget) break
    take(entry)
  }
  for (const entry of [...entries].sort(preference)) {
    if (picked.length >= MAX_IMAGES) break
    take(entry)
  }
  // 参考图排在前面：审查员按「先看图纸、再看模型」的顺序读更稳。
  return picked.sort(preference).map((entry) => entry.item)
}

/** observe 子代理的缓存键：图纸原始块的指纹，不是合成图的指纹。
 *
 *  旧键用的是「这一轮送给审查的参考图」的指纹，compare 每轮重新合成一次 → 每轮都 miss，
 *  于是每轮都白跑一次 observe 子代理（实测里那是最贵的一半）。改成按图纸源文件算：
 *  同一张图纸跨 revision 命中。
 *  PTC 的 live.json 只有合成图路径、拿不到图纸源：退化成「固定裁块 0,0,700,452 + 设计」
 *  当稳定键 —— 设计没换，它仍然跨 revision 命中。
 */
export function drawingObservationKey(refs, state) {
  const sources = [...new Set((refs ?? [])
    .map((item) => (typeof item?.drawingSource === 'string' ? item.drawingSource : ''))
    .filter(Boolean))].sort()
  if (sources.length > 0) {
    const parts = sources.map((path) => `${path}:${fileDigest(path, 16) ?? 'unreadable'}`)
    return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12)
  }
  if (typeof state?.drawingDigest === 'string' && state.drawingDigest.length > 0) return state.drawingDigest
  const design = state?.designId ?? state?.documentId ?? 'unknown'
  const crop = (refs ?? []).map((item) => (typeof item?.drawingCrop === 'string' ? item.drawingCrop : '')).find(Boolean) ?? '0,0,700,452'
  return createHash('sha256').update(`drawing-crop:${crop}:${design}`).digest('hex').slice(0, 12)
}

/**
 * 三条 VERIFY_NOT_RUN 共用的收尾：同一句话只在模板里写一次。
 * 被三个分支复用（无记录/记录过期/not-run），这里保留测试钉死的两个子串：
 * `inspect action="verify"` 与 `带 expect`。
 */
/**
 * 交付前的程序化检查：只看本机可验证的事实，不调用模型。
 *
 * 判据只有两条：
 *   · 当前 revision 至少有一张自己拍的图（capture / compare）—— 没有图的交付
 *     事后无法复核，至少让人能看到「交出去的是什么样」；
 *   · 输出路径上若已有旧文件，它不能早于最近一次几何修改 —— 防止把上一次的
 *     结果当成这一次的交付。
 * 图纸一致性与外观缺陷不在这里判：那是人看交付文件要做的事。
 */
export function evaluateDeliveryEvidence(state, exec = {}) {
  const revision = Number.isFinite(state?.revision) ? state.revision : 0
  const images = Array.isArray(state?.images)
    ? state.images.filter((item) => item.atRevision === revision)
    : []
  const issues = []
  if (images.length === 0) {
    issues.push({
      code: 'NO_CURRENT_VIEW',
      message: `revision ${revision} 还没有截图：交付前先 capture 一张当前模型——这里只检查「有没有这一版的图」，不判断像不像。`,
    })
  }
  const path = typeof exec?.arguments?.path === 'string' && exec.arguments.path.length > 0
    ? exec.arguments.path
    : null
  if (path !== null && existsSync(path) && Number.isFinite(state?.lastMutationAt) && state.lastMutationAt > 0) {
    const mtime = statSync(path).mtimeMs
    if (mtime < state.lastMutationAt - 2000) {
      issues.push({
        code: 'ARTIFACT_STALE',
        message: `${path} 上已有一份更早的文件（${new Date(mtime).toISOString()}，早于最近一次几何修改）：换一个输出路径，或先删掉旧文件，避免把上一次的结果当成这一次的。`,
      })
    }
  }
  return {
    ok: issues.length === 0,
    code: issues[0]?.code ?? 'OK',
    issues,
    detail: {
      designId: state?.designId ?? null,
      revision,
      images: images.length,
      lastMutationAt: state?.lastMutationAt ?? null,
      path,
    },
  }
}

const VERIFY_RERUN = '先对当前这一版重新跑 inspect action="verify" 带 expect，量到 status:"ok" 才谈交付。'

/**
 * 确定性核对（inspect action=verify）的前置门。
 *
 * 视觉审查回答的是「像不像」，它盖不过一条已经量出来的事实 —— 所以这里只放行
 * status === 'ok'（每一条期望都量到了、而且都对），其余三态一律退回：
 *   · failed     —— 量到了但不对（VERIFY_FAILED）；
 *   · incomplete —— 有「没量成」的条目（VERIFY_INCOMPLETE）。没量成既不是通过也不是
 *                   不符，它意味着「这一条我还不知道」：只要有一条不知道，就不能说
 *                   验收通过。回注里逐条列出哪条期望没量到、available 里有什么候选。
 *   · not-run    —— 一条语义核对都没跑（VERIFY_NOT_RUN）：没有 expect 就是没有验收。
 * 只认「这一版」的结论：几何改过之后 revision 对不上，旧结论就不算数 —— 而且不是
 * 「忽略」（忽略等于放行），而是按 VERIFY_NOT_RUN 要求对当前这一版重跑（旧证据不得过关）。
 *
 * 既有豁免原样保留 —— 这两类交付本来就没有零件尺寸验收的对象：
 *   · 仅草图项目（项目定义 output="sketch" / step="sketch-built"）按关系审计判；
 *   · 工程图交付（deliver kind="pdf"/"dxf"）不是零件验收。
 * 豁免只挡住新增的 incomplete / not-run；failed 照样拒 —— 量出来不对就是不对。
 */
export function evaluateVerifyGate(state, options = {}) {
  const verify = state?.verify
  if (!verify || typeof verify !== 'object') {
    // 记录里有一份 verify、但 revision 对不上（几何改过）：当「这一版没核对过」处理 ——
    // 旧证据不得过关，否则改完模型可以拿着改之前的 ok 直接交付。
    const stale = state?.verifyStale
    if (stale && typeof stale === 'object') {
      return {
        ok: false,
        code: 'VERIFY_NOT_RUN',
        message: `没有当前这一版的 inspect action="verify" 结论（记录里那份是 revision ${stale.revision} 量的，`
          + `现在 revision ${stale.currentRevision}）：几何改过它就不再证明这一版。`
          + VERIFY_RERUN,
        detail: {
          revision: state.revision,
          verifyRevision: stale.revision ?? null,
          verifyAt: stale.at ?? null,
          status: stale.status ?? null,
          stale: true,
        },
      }
    }
    return { ok: true, skipped: true }
  }
  const status = String(verify.status ?? '')
  // 先比 revision：同一条核对结论只对量它的那一版有效，对不上就是「这一版没核对过」。
  // 必须在 status 分派**之前** —— 旧 ok 结论若在这里放行，就是拿旧证据过关；
  // 只有 failed 被拦、ok 被沿用，等于「改完几何不用重验」。
  if (typeof verify.atRevision === 'number' && verify.atRevision !== state.revision) {
    return {
      ok: false,
      code: 'VERIFY_NOT_RUN',
      message: `这条 verify 结论是 revision ${verify.atRevision} 量的，现在 revision ${state.revision}，`
        + `对不上就等于这一版没核对过。` + VERIFY_RERUN,
      detail: {
        revision: state.revision,
        verifyRevision: verify.atRevision,
        verifyAt: verify.at ?? null,
        status,
        stale: true,
      },
    }
  }
  // 旧数据没有 status（服务端早版本只回 checks 列表）：维持老规矩，只认 failed。
  if (status !== 'failed' && status !== 'incomplete' && status !== 'not-run') return { ok: true, status }
  const summaryTail = typeof verify.summary === 'string' && verify.summary.length > 0
    ? `\n服务端摘要：${verify.summary}`
    : ''
  if (status === 'failed') {
    const failed = Array.isArray(verify.failed) ? verify.failed.map((name) => String(name)).slice(0, 6) : []
    return {
      ok: false,
      code: 'VERIFY_FAILED',
      message: `本轮 inspect action=verify 明确 failed${failed.length > 0 ? `（不符：${failed.join('、')}）` : ''}：`
        + '已量出这一版不对，不要拿视觉审查去盖它。先按这些差异改模型，再重新 verify。'
        + summaryTail,
      detail: { revision: state.revision, verifyAt: verify.at ?? null, status, failed },
    }
  }
  const exemption = verifyExemption(state, options)
  if (exemption !== null) return { ok: true, skipped: true, reason: exemption, status }
  if (status === 'not-run') {
    return {
      ok: false,
      code: 'VERIFY_NOT_RUN',
      message: '本轮 inspect action=verify 是 not-run：一条语义核对都没跑（没有期望值，就没有验收）。'
        + VERIFY_RERUN
        + summaryTail,
      detail: {
        revision: state.revision,
        verifyAt: verify.at ?? null,
        status,
        checks: verify.checkCount ?? 0,
      },
    }
  }
  // incomplete：逐条说清「哪条期望没量到、available 里有什么候选」。
  const unmeasured = Array.isArray(verify.unmeasured) ? verify.unmeasured.slice(0, 6) : []
  const lines = unmeasured.map((item, index) => {
    const expected = item?.expected === undefined || item?.expected === null
      ? '期望值未记录'
      : `期望 ${JSON.stringify(item.expected)}`
    const note = typeof item?.note === 'string' && item.note.length > 0
      ? item.note
      : (item?.reason ?? '没量到')
    return `${index + 1}. ${item?.name ?? '?'}：${expected}；${note}${availableHint(item)}`
  })
  return {
    ok: false,
    code: 'VERIFY_INCOMPLETE',
    message: `本轮 inspect action=verify 是 incomplete：${unmeasured.length} 条期望没量到（没量成不等于对得上）。`
      + (lines.length > 0 ? `\n${lines.join('\n')}\n` : '\n')
      + '交付前每一条都要量到：用 expect.checks[] 重跑 inspect action="verify"，'
      + '把 measure/args/pick 限定到唯一对象（index / allowFirst），'
      + '对照 available（如 available.diameters）确认没量错对象。'
      + summaryTail,
    detail: {
      revision: state.revision,
      verifyAt: verify.at ?? null,
      status,
      unmeasured,
      checks: verify.checkCount ?? 0,
    },
  }
}

/** 交付物本身没有尺寸验收对象时的豁免：仅草图项目、工程图交付。 */
function verifyExemption(state, options) {
  const kind = typeof options?.deliveryKind === 'string' ? options.deliveryKind.toLowerCase() : ''
  if (kind === 'pdf' || kind === 'dxf') return `工程图交付（kind=${kind}）不是零件验收，不做尺寸核对`
  const project = readProjectRecord(options?.designId ?? state?.designId)
  const definition = project?.definition ?? null
  if (project?.step === 'sketch-built' || definition?.output === 'sketch') {
    return '仅草图项目按关系审计判，尺寸核对没量成不拦交付'
  }
  return null
}

/** 回注里给「量错了对象」提供线索：优先用候选值，其次用零件上真实存在的直径。 */
function availableHint(item) {
  const candidates = Array.isArray(item?.candidates) ? item.candidates.slice(0, 6) : []
  if (candidates.length > 0) return `；候选 ${JSON.stringify(candidates)}`
  const diameters = Array.isArray(item?.available?.diameters) ? item.available.diameters.slice(0, 8) : []
  if (diameters.length > 0) return `；available.diameters = ${JSON.stringify(diameters)}`
  const available = item?.available
  if (available !== null && typeof available === 'object' && Object.keys(available).length > 0) {
    return `；available = ${JSON.stringify(available).slice(0, 160)}`
  }
  return ''
}

/** 快照标识：同一 revision 下若干张图的指纹合起来，几何不变它就稳定。 */
function snapshotIdOf(state) {
  const fresh = state.images.filter((item) => item.atRevision === state.revision)
  if (fresh.length === 0) return null
  const joined = fresh.map((item) => item.digest ?? item.path).sort().join('|')
  return `snap-${state.revision}-${createHash('sha256').update(joined).digest('hex').slice(0, 8)}`
}

function freshImages(state) {
  return state.images.filter((item) => {
    if (item.atRevision === state.revision) return true
    // 截图本身可能把服务侧 revision 推高，而几何并没有再改：这时图片比
    // revision 旧一版仍然代表当前几何。只有「最近一次几何修改之后拍的」才算旧。
    if (!state.lastMutationAt) return false
    const at = Date.parse(item.at ?? '')
    return Number.isFinite(at) && at >= state.lastMutationAt - 1000
  })
}

function toolText(result) {
  if (!Array.isArray(result?.content)) return ''
  return result.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
}

function parseEnvelope(result) {
  const text = toolText(result)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** MCP 服务那一侧记的「当前这一版」：PTC 模式下这是唯一能拿到图的地方。
 *
 * 实测：`sw-ptc` 会话里模型 capture 了 10 次以上，但所有 `mcp__sw__*` 调用都发生在
 * `run_code` 内部，宿主侧只看到外层 `run_code`（返回里没有图、没有 artifacts），
 * 于是本插件每次送审都说「这一轮没有留下任何图」，交付被永久拒绝，而
 * `logs/review.jsonl` 里对这个零件一行记录都没有。
 *
 * 服务看得到每一次 build / capture，所以以它写的 `review/live.json` 为准同步。
 * 只增不减：本地已经收下的图不因为同步而丢掉。
 */
function livePath() {
  return join(dataRoot(), 'review', 'live.json')
}

function isImagePath(path) {
  return typeof path === 'string' && /\.(png|jpe?g|webp|bmp)$/i.test(path)
}

function syncFromLive(state, preferredId) {
  let store
  try {
    store = JSON.parse(readFileSync(livePath(), 'utf8'))
  } catch {
    return false
  }
  const designs = store?.designs ?? {}
  const ids = Object.keys(designs)
  if (ids.length === 0) return false
  let record = null
  const wanted = preferredId ?? state.designId
  // F1(c)：不再「猜最近一条」。旧实现在没有 designId 时会从 30 分钟内动过、有图的
  // 记录里挑一条并记住它的 designId —— 那等于让 A 设计的图/审计/核对混进 B 设计，
  // 也正是「bracket-06v1 量到锁盖」的读取侧同款。没有 designId 就什么都不同步，
  // 由调用方报 DESIGN_ID_REQUIRED（见 apply 里的 pre-execute 分支）。
  if (!(typeof wanted === 'string' && wanted.length > 0)) return false
  record = designs[wanted] ?? null
  if (record === null) return false
  // 记录自己的 designId 才是权威（老数据里可能没有这一项）。
  activateDesign(state, typeof record.designId === 'string' && record.designId.length > 0 ? record.designId : wanted)
  const revision = typeof record.revision === 'number' ? record.revision : state.revision
  const merged = state.images.filter((item) => isImagePath(item.path))
  for (const item of Array.isArray(record.images) ? record.images : []) {
    if (!isImagePath(item?.path)) continue
    const atRevision = typeof item.atRevision === 'number' ? item.atRevision : revision
    const view = typeof item?.view === 'string' && item.view.length > 0 ? item.view : undefined
    const known = merged.find((item2) => item2.path === item.path)
    if (known !== undefined) {
      // 同一张图先从工具结果进来时已经带了真实来源（capture/figure/compare）；
      // 同步只补版本与时间，不能用 'mcp' 把它盖掉，否则审查员会以为这是图纸。
      known.atRevision = Math.max(known.atRevision ?? 0, atRevision)
      if (item.at) known.at = item.at
      if (!known.view && view !== undefined) known.view = view
      if (!known.digest) known.digest = fileDigest(item.path, 12)
      // 老数据（或服务端只记了路径时的老版本）origin 是 'mcp'/缺失：按文件名反推一次
      // fig-→figure、cmp-→compare、shot-→capture；都判不出来才留原值 'mcp'。
      // 「参考图纸恒为空、confidence 封顶 0.5」的根因就是这里把它一律压成 'mcp'。
      if (originKindOf(known.origin) === null) {
        known.origin = originKindOf(item?.origin) ?? pathKindOf(item.path) ?? 'mcp'
      }
      continue
    }
    // 新入账的图：优先用服务端写的 origin，没有就按文件名反推，最后才 'mcp'。
    const origin = originKindOf(item?.origin) ?? pathKindOf(item.path) ?? 'mcp'
    merged.push({
      path: item.path,
      atRevision,
      at: item.at,
      origin,
      ...(view === undefined ? {} : { view }),
      digest: fileDigest(item.path, 12),
    })
  }
  // 留住比 MAX_IMAGES 更多的候选：选图要按视角去重、要补上视，只有 4 张时无图可选。
  state.images = merged.slice(-MAX_STATE_IMAGES)
  // F1：服务侧对这一条设计的 revision 是事实源。第一次接上之后就**以它为准**
  // （不是 Math.max）—— Math.max 会把本地因为 PTC 重复记账而多出来的 +1 留在
  // 上面，于是门禁要求的最新一版永远比关系审计能落账的版本大，追不上。
  state.revision = state.liveSynced ? (Number.isFinite(revision) ? revision : state.revision)
    : Math.max(state.revision, revision)
  state.liveSynced = true
  if (typeof record.documentPath === 'string' && record.documentPath.length > 0) state.documentId = record.documentPath
  if (typeof record.designId === 'string' && record.designId.length > 0) state.designId = record.designId
  // 服务在 build output="sketch" / inspect action=relations 后写下关系审计；
  // 交付门禁先看这份事实，再谈视觉审查。
  if (record.relationAudit && typeof record.relationAudit === 'object') {
    state.relationAudit = record.relationAudit
  }
  // 服务如果记了确定性核对结果（新数据才有这一项）：只接受比本地更新的那一份。
  // 而且只认「同一版」的证据：record.verify.revision 必须等于记录当前的 revision。
  // 几何改过之后（服务侧 bumpRevision）旧核对结果还留在记录里、revision 却对不上 ——
  // 这正是「拿旧证据过关」的形状：不匹配就当「没有这一版的 verify」，交付门会按
  // VERIFY_NOT_RUN 要求重跑，而不是当作没跑过就放行。
  if (record.verify && typeof record.verify === 'object') {
    const verifyRevision = Number.isFinite(record.verify.revision)
      ? record.verify.revision
      : (Number.isFinite(record.verify.atRevision) ? record.verify.atRevision : revision)
    // 本地若已经有一条同一 revision 的核对结论（PTC 外直接调用的情形），那是更新的证据，不能被旧记录盖掉。
    const localFresh = state.verify && state.verify.atRevision === state.revision
    if (verifyRevision !== revision) {
      if (!localFresh) {
        state.verify = null
        state.verifyStale = {
          revision: verifyRevision,
          currentRevision: revision,
          status: record.verify.status ?? null,
          at: record.verify.at ?? null,
        }
      }
    } else {
      const incomingAt = String(record.verify.at ?? '')
      if (!state.verify || incomingAt > String(state.verify.at ?? '')) {
        state.verify = {
          ...record.verify,
          atRevision: verifyRevision,
        }
        state.verifyStale = null
      }
    }
  }
  state.snapshotId = snapshotIdOf(state)
  return true
}

/** 收集这一轮里产出的图：它们就是审查者能看到的东西。
 *
 *  origin 就是「这张图是怎么来的」：figure 的裁剪块、compare 的并排图、capture 的渲染图。
 *  审查员需要知道自己在看哪一种，否则会把一张工程图裁剪当成模型照片去挑毛病。
 *  选图还要按视角去重，所以能拿到的 view / caption / 图纸源文件也一并记在图上。
 */
function collectImages(state, envelope, origin, meta = {}) {
  const paths = []
  const push = (value) => {
    if (isImagePath(value)) paths.push(value)
  }
  push(envelope?.image?.path)
  for (const artifact of envelope?.artifacts ?? []) push(artifact?.path)
  const metaFields = (item) => {
    if (typeof meta.view === 'string' && meta.view.length > 0) item.view = meta.view
    if (typeof meta.caption === 'string' && meta.caption.length > 0) item.caption = meta.caption
    if (typeof meta.drawingSource === 'string' && meta.drawingSource.length > 0) item.drawingSource = meta.drawingSource
    if (typeof meta.drawingCrop === 'string' && meta.drawingCrop.length > 0) item.drawingCrop = meta.drawingCrop
    backfillOrigin(item)
    if (!item.digest) item.digest = fileDigest(item.path, 12)
  }
  for (const p of paths) {
    // 每张图记住它是在哪个 revision 拍的：改完几何之后旧图只是旧模型的照片，
    // 拿它去审等于让审查员看一个已经不存在的东西。
    const existing = state.images.find((item) => item.path === p)
    if (existing !== undefined) {
      // 同步先到时会用 'mcp' 占位；工具结果随后到了就换成真实来源。
      existing.atRevision = state.revision
      existing.at = new Date().toISOString()
      if (origin && origin !== 'mcp') existing.origin = origin
      metaFields(existing)
    } else {
      state.images.push({
        path: p,
        atRevision: state.revision,
        at: new Date().toISOString(),
        origin: origin ?? 'unknown',
        digest: fileDigest(p, 12),
        ...(typeof meta.view === 'string' && meta.view.length > 0 ? { view: meta.view } : {}),
        ...(typeof meta.caption === 'string' && meta.caption.length > 0 ? { caption: meta.caption } : {}),
        ...(typeof meta.drawingSource === 'string' && meta.drawingSource.length > 0 ? { drawingSource: meta.drawingSource } : {}),
        ...(typeof meta.drawingCrop === 'string' && meta.drawingCrop.length > 0 ? { drawingCrop: meta.drawingCrop } : {}),
      })
      backfillOrigin(state.images[state.images.length - 1])
    }
  }
  while (state.images.length > MAX_STATE_IMAGES) state.images.shift()
  state.snapshotId = snapshotIdOf(state)
}

/**
 * 把审查结论落一行 JSONL。
 *
 * 主模型能看到的是「被拒绝的理由」，但事后没人能回答「这一单到底审过没有、谁审的」。
 * 日志放在数据目录里（SW_MCP_DATA 覆盖得到），和服务的 logs 分开：那是工具调用日志，
 * 这是判定记录，用途不同，混在一起反而难查。
 */
function dataRoot() {
  return process.env.SW_MCP_DATA || join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'sw-mcp')
}

function appendAuditLine(file, entry) {
  const path = join(dataRoot(), ...file)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8')
}

function reviewAuditState(state) {
  return {
    sessionKey: state.key,
    designId: state.designId ?? null,
    revision: state.revision,
    reviewedRevision: state.reviewedRevision,
    snapshotId: state.snapshotId ?? null,
    reviews: state.reviews,
    model: state.reviewModel,
    verdict: state.verdict?.verdict ?? null,
    confidence: state.verdict?.confidence ?? null,
    differences: (normalizeVerdict(state.verdict)?.differences ?? []).slice(0, 6),
    verify: verifyAuditState(state.verify),
  }
}

function verifyAuditState(verify) {
  return verify ? {
    status: verify.status ?? null,
    atRevision: Number.isFinite(verify.atRevision) ? verify.atRevision : null,
    checkCount: Number.isFinite(verify.checkCount) ? verify.checkCount : null,
  } : null
}

function writeGateEvent(ctx, entry) {
  try {
    appendAuditLine(['logs', 'review.jsonl'], entry)
    return true
  } catch (error) {
    try {
      appendAuditLine(['review', 'gate-audit.jsonl'], {
        ...entry,
        timelineWriteError: error?.message ?? String(error),
      })
      ctx.logger?.warn?.('review-gate: REVIEW_AUDIT_WRITE_FAILED，已写备用记录 review/gate-audit.jsonl')
      return true
    } catch (fallbackError) {
      ctx.logger?.warn?.('review-gate: REVIEW_AUDIT_WRITE_FAILED，主记录与备用记录均未写入：'
        + (fallbackError?.message ?? fallbackError) + '；事件 ' + JSON.stringify(entry))
      return false
    }
  }
}

/** 手动交付留痕。主文件写不进时，把同一条事件写入审查时间线。 */
function writeBypassLine(ctx, { tool, designId, op, reason, revision, code, verdict, verify, reviews }) {
  const entry = {
    at: new Date().toISOString(),
    source: 'review-gate',
    tool,
    designId,
    op,
    revision,
    code,
    verdict: verdict ? {
      verdict: verdict.verdict ?? null,
      confidence: verdict.confidence ?? null,
      differences: (normalizeVerdict(verdict)?.differences ?? []).length,
    } : null,
    verify: verifyAuditState(verify),
    reviews,
    reason: typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : '(未说明)',
  }
  try {
    appendAuditLine(['review', 'bypass.jsonl'], entry)
    return 'review/bypass.jsonl'
  } catch (error) {
    const logged = writeGateEvent(ctx, {
      ...entry,
      event: 'manual-bypass',
      auditWriteError: error?.message ?? String(error),
    })
    if (logged) {
      ctx.logger?.warn?.('review-gate: BYPASS_AUDIT_WRITE_FAILED，手动交付审计已写入审查时间线或备用记录')
      return '备用审计'
    }
    ctx.logger?.warn?.('review-gate: BYPASS_AUDIT_WRITE_FAILED，手动交付审计未落盘')
    return null
  }
}

// ---------------------------------------------------------------------------
// F7 熔断：同一条设计上同一个门禁码连续硬失败 3 次 → 直接说「这条门禁当前不可达」。
//
// 为什么必须有：门禁的整改建议如果本身追不平（实测 RELATIONS_INCOMPLETE 里审计
// 版本永远落后几何版本），模型会把「再交付一次」当成唯一动作，一段程序里连撞 20 次
// （0bb49837 的 19:32–19:34 纯卡死）。硬失败三次之后继续重试不会有新信息，只会
// 烧掉整段程序 —— 这时候该让它停下来、换策略或者显式走人的口子。
const GATE_FAILURE_LIMIT = 3

function gateFailureKey(designId, code) {
  return `${designId ?? '(none)'}::${code}`
}

/** 记一次硬失败，返回累计次数。 */
function noteGateFailure(state, designId, code) {
  const key = gateFailureKey(designId, code)
  const count = (state.gateFailures.get(key) ?? 0) + 1
  state.gateFailures.set(key, count)
  return count
}

/** 门禁放行/换了设计时清掉计数：只有「连续」失败才熔断。 */
function clearGateFailures(state, designId) {
  if (designId === undefined) {
    state.gateFailures.clear()
    return
  }
  const prefix = `${designId}::`
  for (const key of [...state.gateFailures.keys()]) {
    if (key.startsWith(prefix)) state.gateFailures.delete(key)
  }
}

/** 本会话见过的 designId：报 DESIGN_ID_REQUIRED 时给候选，不让调用方猜。 */
function knownDesignIds(state) {
  const ids = [state.designId, ...state.designRevisions.keys()]
    .filter((item) => typeof item === 'string' && item.length > 0)
  return [...new Set(ids)].slice(0, 20)
}

/** 熔断后的拒绝：说清是哪条门、试了几次、还能怎么办。 */
function gateUnreachable({ designId, code, count, lastReason }) {
  return {
    kind: 'deny',
    reason: `GATE_UNREACHABLE: ${code} 在 designId=${designId ?? '(未给)'} 上连续硬失败 ${count} 次，`
      + '这条门禁当前不可达 —— 继续原样重试不会有新信息。\n'
      + `最后一次的理由：${String(lastReason ?? '').split('\n')[0].slice(0, 400)}\n`
      + '换策略再试，或者走人的口子：①读到门禁源码确认条件（这是工具链，不是你的模型）；'
      + '②换 designId / 重新 workspace action="status" 确认文档；'
      + '③确实要交付，就在这次调用里加 force:"manual" 并写 reason，'
      + '这一笔会记进 review/bypass.jsonl，汇报里也要说明为什么门禁走不通。',
  }
}


/** 审查员显式模型路由：config > 环境变量 > 默认。任一项缺失就不送审。 */
export function resolveReviewModel(config) {
  const configured = config?.reviewModel && typeof config.reviewModel === 'object' ? config.reviewModel : {}
  const provider = process.env.SW_REVIEW_PROVIDER ?? configured.provider ?? DEFAULT_REVIEW_MODEL.provider
  const model = process.env.SW_REVIEW_MODEL ?? configured.model ?? DEFAULT_REVIEW_MODEL.model
  const reasoningEffort = process.env.SW_REVIEW_REASONING ?? configured.reasoningEffort
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
}

function readProjectRecord(designId) {
  if (typeof designId !== 'string' || designId.length === 0) return null
  try {
    return JSON.parse(readFileSync(join(dataRoot(), 'projects', `${designId}.json`), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 交付前的确定性关系门禁：只看关系审计与项目定义，不看图。
 *
 * 为什么必须在视觉审查之前：一个用坐标/短折线拟合出来的轮廓，看起来也可以「像图纸」。
 * 视觉审查只能回答「像不像」，回答不了「是不是按关系建的」。所以缺关系、关系被拒、
 * 假设没被用户确认，一律先拒（RELATIONS_INCOMPLETE），不要让视觉软审查给它盖章。
 *
 * 没有审计记录且不是仅草图项目时返回 skipped —— 普通实体零件的交付照旧走视觉审查。
 */
export function evaluateRelationGate(state, designId) {
  const id = designId ?? state?.designId ?? null
  const project = readProjectRecord(id)
  const definition = project?.definition ?? null
  const sketchProject = project?.step === 'sketch-built' || definition?.output === 'sketch'
  const audit = state?.relationAudit ?? null
  if (audit === null && !sketchProject) {
    return { ok: true, skipped: true, reason: '这一单没有草图关系审计，也不是仅草图项目' }
  }
  if (audit === null) {
    return {
      ok: false,
      code: 'RELATIONS_INCOMPLETE',
      message: `项目 ${id ?? '(未知)'} 是仅草图构建，但没有关系审计记录。先 model action=build output="sketch"，或 inspect action=relations relationAction=list，再交付。`,
      detail: { designId: id, step: project?.step ?? null },
    }
  }
  const accepted = Array.isArray(project?.acceptedAssumptions) ? project.acceptedAssumptions : []
  const result = auditRelations({ audit, project, definition, acceptedAssumptions: accepted })
  if (result.known !== true) {
    return {
      ok: false,
      code: 'RELATIONS_INCOMPLETE',
      message: '关系审计记录里没有 gaps 字段 —— 无法证明关系已经落地，不能交付。',
      detail: { designId: id, audit },
    }
  }
  if (typeof audit.revision === 'number' && typeof state?.revision === 'number' && audit.revision < state.revision) {
    const gap = state.revision - audit.revision
    return {
      ok: false,
      code: 'RELATIONS_INCOMPLETE',
      message: `关系审计是 revision ${audit.revision} 的，当前几何已是 revision ${state.revision}`
        + `（audit.revision=${audit.revision}, state.revision=${state.revision}，差 ${gap}）。`
        + ' 改过几何之后要重新 inspect action="relations" 再交付 —— 而且**改一次就要重读一次**：'
        + '服务在落账时会带上本设计的实时 revision，所以重读一次就能追平，不需要反复 inspect 去试。'
        + ' 如果跑完一次差值仍然不变，那是门禁本身不可达，别再重试：按提示用 force:"manual" 或在汇报里说明。',
      detail: { designId: id, auditRevision: audit.revision, revision: state.revision, gap },
    }
  }
  if (result.ok !== true) {
    const gaps = Array.isArray(result.gaps) ? result.gaps.slice(0, 6) : []
    return {
      ok: false,
      code: 'RELATIONS_INCOMPLETE',
      message: `关系审计没通过（gaps / rejected / 未确认假设的明细见 detail）：不要靠视觉审查绕过，先补关系/圆心/标注。`,
      detail: {
        designId: id,
        gaps,
        rejected: result.rejected,
        missingRelations: result.missingRelations.slice(0, 6),
        unconfirmedAssumptions: result.unconfirmedAssumptions,
      },
    }
  }
  return { ok: true, result }
}

/** 阶段由状态推出来，不单独维护：维护一份「当前阶段」迟早会和实际状态对不上。 */
export function phaseOf(state) {
  if (state.verdict !== null && state.reviewedRevision === state.revision) {
    const v = normalizeVerdict(state.verdict)
    if (v.verdict === 'passed') return 'passed'
    if (v.verdict === 'different') return 'different'
    return 'incomplete'
  }
  const fresh = state.images.filter((item) => item.atRevision === state.revision)
  if (fresh.length === 0) return 'unverified'
  return 'reviewing'
}

/**
 * 落一盘「这一单现在到哪一步」。
 *
 * review.jsonl 是时间线（谁在什么时候判了什么），runs.json 是状态盘（当前这一版是什么结论、
 * 证据在哪一版）。两者都要：只有时间线时，想知道「现在能不能交付」得读完整个文件；
 * 只有状态盘时，事后追不了「它改过几次、每次差在哪」。
 *
 * 字段与施工提示词里的记录对齐：runId / documentId / modelRevision / evidenceRevision /
 * snapshotId / artifactHash / phase / result。插件这一层拿不到 documentId 与工件哈希
 * （那是 MCP 服务那边的事），所以这两项由 MCP 侧回填，这里先留 null 而不是编一个。
 */
function writeRunRecord(ctx, state, verdict) {
  try {
    const dir = join(dataRoot(), 'review')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'runs.json')
    let store = { version: 1, sessions: {} }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.sessions) store = parsed
    } catch {
      // 文件不存在或坏了：重开一盘。坏数据不该让审查门整个失效。
    }
    const normalized = normalizeVerdict(verdict)
    const previous = store.sessions[state.key] ?? null
    const entry = {
      runId: previous?.runId ?? `run-${state.key}-${Date.now().toString(36)}`,
      sessionKey: state.key,
      designId: state.designId ?? previous?.designId ?? null,
      documentId: state.documentId ?? previous?.documentId ?? null,
      // 同一份设计可能先后落在两个零件文件上；只按 designId 匹配会把上一版的
      // 结论当成这一版的（实测就是这样把别的零件判成了 passed）。
      documentPath: state.documentId ?? previous?.documentPath ?? null,
      modelRevision: state.revision,
      reviewedRevision: state.reviewedRevision,
      evidenceRevision: previous?.evidenceRevision ?? null,
      snapshotId: state.snapshotId ?? previous?.snapshotId ?? null,
      artifactHash: state.artifactHash ?? previous?.artifactHash ?? null,
      reviewModel: state.reviewModel ?? previous?.reviewModel ?? null,
      phase: phaseOf(state),
      result: normalized?.verdict ?? 'incomplete',
      confidence: normalized?.confidence ?? null,
      observations: normalized?.observations ?? [],
      unresolved: normalized?.unresolved ?? [],
      differences: normalized?.differences ?? [],
      images: state.images.map((item) => ({ path: item.path, atRevision: item.atRevision, origin: item.origin })),
      reviews: state.reviews,
      updatedAt: new Date().toISOString(),
      history: [...(previous?.history ?? []), {
        at: new Date().toISOString(),
        modelRevision: state.revision,
        result: normalized?.verdict ?? 'incomplete',
        confidence: normalized?.confidence ?? null,
        differences: (normalized?.differences ?? []).slice(0, 8),
      }].slice(-12),
    }
    store.sessions[state.key] = entry
    writeFileSync(file, `${JSON.stringify(store, null, 2)}
`)
  } catch (error) {
    ctx.logger?.warn?.(`review-gate: 状态盘没写下去（已忽略）：${error?.message ?? error}`)
  }
}

function recordVerdict(ctx, state, verdict) {
  try {
    const dir = join(dataRoot(), 'logs')
    mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({
      at: new Date().toISOString(),
      designId: state.designId ?? null,
      revision: state.reviewedRevision,
      reviews: state.reviews,
      model: state.reviewModel ?? null,
      verdict: verdict?.verdict ?? null,
      confidence: verdict?.confidence ?? null,
      differences: (normalizeVerdict(verdict)?.differences ?? []).slice(0, 6),
      observations: (verdict?.observations ?? []).slice(0, 12),
    })
    appendFileSync(join(dir, 'review.jsonl'), `${line}
`)
    writeRunRecord(ctx, state, verdict)
  } catch (error) {
    ctx.logger?.warn?.(`review-gate: 审查记录没写下去（已忽略）：${error?.message ?? error}`)
  }
}

function recordPrewarmFailure(ctx, target, code, reason) {
  writeGateEvent(ctx, {
    at: new Date().toISOString(),
    event: 'prewarm-failure',
    ...target,
    code,
    reason,
  })
  ctx.logger?.warn?.(`review-gate: 预热审查 ${code}：${reason}`)
}

function reviewTargetIsCurrent(state, target) {
  if (state.designId !== target.designId) return false
  syncFromLive(state)
  return state.designId === target.designId && state.revision === target.revision
    && state.snapshotId === target.snapshotId
}

/**
 * 宿主实际暴露的是 `saveImages([{data,mimeType,name}])`（MCP 客户端也这么用）；
 * 早期这里按单张 `saveImage({data,name})` 写，真实会话里一调用就抛，
 * 被 catch 吞成「图都读不到」——单测的假 attachments 恰好只实现了单张版，
 * 于是这个错误一直没被测试发现。两种都支持。
 */
export function normalizeVerdict(verdict) {
  if (!verdict) return verdict
  const observations = Array.isArray(verdict.observations) ? verdict.observations : []
  const derived = observations
    .filter((o) => o?.status === 'different')
    .map((o) => ({
      region: Array.isArray(o.modelRegion) ? `区域 [${o.modelRegion.map((n) => Number(n).toFixed(2)).join(', ')}]` : (o.item ?? '未标注位置'),
      expected: o.item ? `${o.item}（见参考图）` : '与参考图一致',
      actual: o.observedDifference ?? '模型图上不一致',
      severity: 'blocking',
    }))
  const uncertain = observations.filter((o) => o?.status === 'uncertain')
  const differences = Array.isArray(verdict.differences) && verdict.differences.length > 0
    ? verdict.differences
    : derived
  return { ...verdict, differences, uncertain: uncertain.length }
}

function verdictSummary(raw) {
  const verdict = normalizeVerdict(raw)
  if (!verdict) return '还没有审查结论'
  const differences = verdict.differences ?? []
  if (verdict.verdict === 'passed') return `审查通过（把握 ${verdict.confidence ?? '?'}）`
  const lines = differences.slice(0, 4).map((d) => `· ${d.region}：图纸「${d.expected}」，模型「${d.actual}」`)
  return [
    `审查结论 ${verdict.verdict}（把握 ${verdict.confidence ?? '?'}）`,
    ...lines,
    differences.length > 4 ? `· 另有 ${differences.length - 4} 处` : '',
    verdict.uncertain ? `· 另有 ${verdict.uncertain} 处看不清（缺视图）` : '',
    verdict.notes ? `· ${verdict.notes}` : '',
  ].filter(Boolean).join('\n')
}

export function apply(ctx, config = {}) {
  // 只拦「交付」与「宣布完成」。建模本身当然要被允许：审的是结果，不是过程。
  const gateNames = config.gate ?? [/(^|__)deliver$/]
  let lastAgent = null

  const isGateCall = (exec) => {
    const toolName = String(exec?.name ?? '')
    if (/(^|__)update_goal$/.test(toolName)) return exec?.arguments?.action === 'complete'
    return gateNames.some((pattern) => pattern.test(toolName))
  }

  // 1) 记版本与图：几何改一次，之前的审查就作废。
  ctx.on('tools/execute', async (exec, next) => {
    if (exec?.agent !== undefined) lastAgent = exec.agent
    const result = await next()
    try {
      const toolName = String(exec?.name ?? '')
      const envelope = parseEnvelope(result)
      // 先对齐服务侧 revision：两边各自 +1 会漂移，PTC 模式下服务才是几何版本的
      // 事实来源。同步到了新版本就不要再自己加一，否则截图会被标成旧版本。
      const current = stateOf(exec.agent)
      const syncedLive = syncFromLive(current, envelope?.designId)
      if (!syncedLive) activateDesign(current, envelope?.designId)
      if (/(^|__)model$/.test(toolName) && MUTATING_ACTIONS.has(exec?.arguments?.action) && envelope?.status !== 'failed') {
        const state = stateOf(exec.agent)
        state.lastMutationAt = Date.now()
        // 服务侧是 revision 的唯一事实源：它已经 +1 时这里不能再 +1，
        // 否则同一段 capture→deliver 里图会被标成「改之前」。实测过
        // PTC 下同一个 build 会走到这里两次（外层与子调用各一次），
        // 两次都加就把 revision 推高了一版。只有服务侧完全没记录时才自增。
        // F1(b)：还要求这次调用真的**成功**了（status==="ok"）。以前 `!== 'failed'`
        // 把 partial / not-run 也算成一次几何改动，于是 revision 被一堆什么都没改的
        // 调用推高，关系审计永远落后。
        if (!syncedLive && envelope?.status === 'ok' && MUTATING_ACTIONS.has(exec?.arguments?.action)) {
          state.revision += 1
          rememberRevision(state)
        }
        state.documentId = envelope?.changes?.document?.path ?? envelope?.changes?.document?.title ?? state.documentId
        // 几何一改，之前那一版交付出来的文件的指纹就不代表现在这个模型了。
        state.artifactHash = null
        if (state.verdict !== null) {
          ctx.logger?.info?.(`review-gate: 几何改了（revision ${state.revision}），上一次审查结论作废`)
        }
      }
      if (envelope !== null) {
        const state = stateOf(exec.agent)
        const doc = envelope?.changes?.document
        const docId = doc?.path ?? doc?.title ?? envelope?.document?.path ?? envelope?.document?.title
        if (typeof docId === 'string' && docId.length > 0) state.documentId = docId
        // MCP 侧的 inspect action="snapshot" 会把图/测量/文件钉成同一个 id：
        // 有就用它的，那才是「审查员看的那一版」与「服务量出来的那一版」对得上的唯一凭据。
        const mcpSnapshot = envelope?.changes?.snapshotId
        if (typeof mcpSnapshot === 'string' && mcpSnapshot.length > 0) state.snapshotId = mcpSnapshot
        // 交付成功：把真正写出去的文件指纹记下来。审查结论和交付文件必须对得上同一版，
        // 否则「审过了」和「交出去的那个」可以是两个东西。
        if (/(^|__)deliver$/.test(toolName) && envelope?.status !== 'failed') {
          const artifacts = Array.isArray(envelope?.artifacts) ? envelope.artifacts : []
          const artifact = artifacts.find((a) => typeof a?.path === 'string' && existsSync(a.path))
          if (artifact) {
            state.artifactHash = fileDigest(artifact.path, 16)
            // 交付成功且这一版已经审过：把「审过的结论」与「交出去的文件指纹」写进同一行，
            // 以后要回答「这份文件是不是审过的那一版」只看这一行就够。
            if (state.verdict !== null && state.reviewedRevision === state.revision) {
              writeRunRecord(ctx, state, state.verdict)
            }
          }
        }
        // 确定性核对（inspect action=verify）的结论先记下来：交付门禁不等视觉审查。
        // 只有 status:"ok" 会放行；failed / incomplete / not-run 都在这里退回
        // （VERIFY_FAILED / VERIFY_INCOMPLETE / VERIFY_NOT_RUN），不 spawn、不吃审查额度。
        // incomplete 要逐条回注「哪条期望没量到、available 里有什么候选」，所以这里
        // 把没量成的条目连 expected / candidates / available 一并记下来。
        const action = exec?.arguments?.action
        if (/(^|__)inspect$/.test(toolName) && action === 'verify' && typeof envelope?.status === 'string') {
          const checks = Array.isArray(envelope?.changes?.checks) ? envelope.changes.checks : []
          const checkStatus = (c) => String(c?.status ?? (c?.pass ? 'pass' : 'fail'))
          // 本地刚跑的这一版核对结果，比记录里那份新：清掉「旧证据」的痕。
          state.verifyStale = null
          state.verify = {
            status: envelope.status,
            atRevision: state.revision,
            at: new Date().toISOString(),
            summary: typeof envelope?.summary === 'string' ? envelope.summary.slice(0, 400) : null,
            checkCount: checks.length,
            failed: checks
              .filter((c) => checkStatus(c) === 'fail')
              .map((c) => String(c?.name ?? '?'))
              .slice(0, 8),
            unmeasured: checks
              .filter((c) => checkStatus(c) === 'unmeasured')
              .slice(0, 6)
              .map((c) => ({
                name: String(c?.name ?? '?'),
                expected: c?.expected === undefined ? null : c.expected,
                measure: c?.measure ?? null,
                reason: c?.reason ?? null,
                note: typeof c?.note === 'string' ? c.note.slice(0, 200) : null,
                candidates: Array.isArray(c?.candidates) ? c.candidates.slice(0, 6) : null,
                available: c?.available ?? null,
              })),
          }
        }
        // 图纸源文件（figure 的 source / compare 的 drawing.source）：observe 子代理的
        // 缓存键要用它的指纹，否则 compare 每轮重新合成一次就把缓存全打掉。
        const drawingSource = typeof envelope?.changes?.source === 'string' && envelope.changes.source.length > 0
          ? envelope.changes.source
          : (typeof envelope?.changes?.drawing?.source === 'string' && envelope.changes.drawing.source.length > 0
            ? envelope.changes.drawing.source
            : undefined)
        if (drawingSource !== undefined) {
          const digest = fileDigest(drawingSource, 16)
          if (digest !== null) state.drawingDigest = digest
        }
        const drawingCrop = Array.isArray(envelope?.changes?.crop)
          ? envelope.changes.crop.join(',')
          : (Array.isArray(envelope?.changes?.drawing?.crop) ? envelope.changes.drawing.crop.join(',') : undefined)
        // 视角：capture 的 view 参数、compare 的 compare.view、以及服务回写的 view 都认。
        const viewArg = exec?.arguments?.view
          ?? envelope?.changes?.view
          ?? exec?.arguments?.compare?.view
          ?? envelope?.changes?.model?.view
        const origin = `${toolName.replace(/^mcp__sw__/, '')}${action ? `.${action}` : ''}`
        collectImages(state, envelope, origin, {
          view: typeof viewArg === 'string' ? viewArg : undefined,
          caption: typeof exec?.arguments?.caption === 'string' ? exec.arguments.caption : undefined,
          drawingSource,
          drawingCrop,
        })
        // 审查员只有图像会漏掉「尺寸对了但形状不对」的另一半：把这一版测出来的数字
        // 一起给它，它就能说「图上这处开口在图里存在、但实测缺这个孔」。
        const measured = envelope?.measurements ?? envelope?.changes?.measurements
        if (measured && typeof measured === 'object') {
          state.measurements = { atRevision: state.revision, value: measured }
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`review-gate: 记账失败（已忽略）：${error?.message ?? error}`)
    }
    return result
  })

  // 2) 交付/完成前审一次。审查是异步的，所以放在 pre-execute（waterfall 允许 await）。
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec?.agent !== undefined) lastAgent = exec.agent
    if (!isGateCall(exec)) return next()
    const agent = exec.agent
    if (agent === undefined) return next()

    const state = stateOf(agent)
    const toolName = String(exec?.name ?? '')
    const explicitId = typeof exec?.arguments?.designId === 'string' && exec.arguments.designId.length > 0
      ? exec.arguments.designId
      : undefined

    // 先同步服务那一侧的账：PTC 下这是唯一有图的地方（见 syncFromLive 的注释）。
    if (!syncFromLive(state, explicitId)) activateDesign(state, explicitId)
    // F3 的读取侧：没有 designId 就不知道该交付哪一份 —— 不再从进程级「上一个」
    // 或「最近 30 分钟那条」里猜（那正是跨会话串台的入口）。
    const deliverId = explicitId ?? state.designId
    if (!(typeof deliverId === 'string' && deliverId.length > 0)) {
      const known = knownDesignIds(state)
      return {
        kind: 'deny',
        reason: 'DESIGN_ID_REQUIRED: deliver / update_goal 必须带 designId：'
          + '省略时不再回退到「最近一次用过的设计」（实测会把 A 会话的件当成 B 会话的）。'
          + (known.length ? ` 本会话见过的 designId：${known.join(', ')}。` : '')
          + ' 用 workspace action="projects" 看已有项目，然后显式传 designId=<你要交付的那一个>。',
      }
    }
    // 确定性关系审计先于视觉审查：缺关系/被拒/假设未确认 → 直接拒绝，不进软审查。
    // 这一步不消耗审查额度，也不启动子代理 —— 交付失败的理由必须是可修的。
    // 确定性核对只作提示，不再拦交付（用户选择：警告而非阻断）。
    // 关系审计与 verify 仍然照常计算、照常写日志，模型看得到该补什么；但它们
    // 不再决定这一单能不能交出去。
    const relationGate = evaluateRelationGate(state, deliverId)
    state.relationGate = relationGate.skipped ? null : relationGate
    const verifyGate = evaluateVerifyGate(state, {
      deliveryKind: exec?.arguments?.kind,
      designId: deliverId,
    })
    const warnings = []
    if (!relationGate.ok) warnings.push(relationGate.code + ": " + relationGate.message)
    if (!verifyGate.ok) warnings.push(verifyGate.code + ": " + verifyGate.message)
    if (warnings.length > 0) {
      ctx.logger?.warn?.("review-gate: 交付提示（不阻断）— "
        + warnings.map((line) => line.split("\n")[0]).join(" | "))
    }
    clearGateFailures(state, deliverId)

    // ── 程序化交付检查（不调用模型）──────────────────────────────────
    // 只回答「这一版有没有可交付的证据」：当前 revision 有图；输出路径上没有
    // 早于最近一次几何修改的旧文件。图纸一致性与外观缺陷交给人看交付文件。
    const evidence = evaluateDeliveryEvidence(state, exec)
    if (!evidence.ok) {
      const count = noteGateFailure(state, deliverId, evidence.code)
      const reason = `${evidence.code}: ${evidence.issues.map((issue) => issue.message).join('\n')}\n`
        + '（这是程序化检查，没有调用任何模型；也没有关闭任何文档：documentsClosed=[]）'
      if (count >= GATE_FAILURE_LIMIT) {
        return gateUnreachable({ designId: deliverId, code: evidence.code, count, lastReason: reason })
      }
      return { kind: 'deny', reason }
    }

    // 逃生口：显式 force:"manual" 放行一次，并留痕。
    if (exec?.arguments?.force === 'manual') {
      const logged = writeBypassLine(ctx, {
        tool: toolName,
        designId: deliverId,
        op: exec?.arguments?.kind ?? exec?.arguments?.action ?? 'deliver',
        reason: exec?.arguments?.reason,
        revision: state.revision,
        code: 'FORCE_MANUAL',
        verdict: null,
        verify: state.verify,
        reviews: 0,
      })
      ctx.logger?.warn?.(`review-gate: force:"manual" 放行 ${toolName}（designId=${deliverId}，`
        + `审计=${logged ?? '未落盘'}；verify=${state.verify?.status ?? 'none'}）`)
      return next()
    }

    ctx.logger?.info?.(`review-gate: 程序化检查通过（revision ${state.revision}，`
      + `图 ${evidence.detail.images} 张）`)
    return next()
  })
}
