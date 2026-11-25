import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * 审查门要看的「这一版模型现在长什么样」，由 MCP 服务写、宿主插件读。
 *
 * 为什么需要这一份：PTC 模式下，模型的所有 `mcp__sw__*` 调用都发生在 `run_code`
 * 内部，不经过宿主侧的 `tools/execute`；宿主插件被调用的只有外层那一个
 * `run_code`，它的返回里没有图，也没有 designId。于是审查门每次都判定「这一轮
 * 没有留下任何图」，交付被永久拒绝 —— 一次实测里模型连追 6 次，全部落空，
 * 而 `logs/review.jsonl` 里对这个零件一行记录都没有。
 *
 * 谁看得见事实，就由谁记账：MCP 服务看得到每一次 capture / build，于是它把
 * 「当前这一版是哪一版、图在哪、是哪个零件」写在这一个文件里。插件只读。
 *
 * 只保留有图的记录，按 updatedAt 取最新的；文件小（每份设计几百字节），
 * 上限 40 份设计。
 *
 * 后来加了第二类事实：确定性核对（inspect action="verify"）的结果也记在这里
 * （record.verify）。审查门读它之前先比 revision —— 只认「同一版」的核对结论，
 * 几何改过就作废，见 review-gate.js 的 syncFromLive / evaluateVerifyGate。
 */

export const LIVE_SCHEMA_VERSION = 1
const MAX_DESIGNS = 40

function livePath(dataDir) {
  return join(dataDir, 'review', 'live.json')
}

function readStore(dataDir) {
  const file = livePath(dataDir)
  try {
    const store = JSON.parse(readFileSync(file, 'utf8'))
    if (store && typeof store === 'object' && store.designs && typeof store.designs === 'object') return store
  } catch {}
  return { version: LIVE_SCHEMA_VERSION, designs: {} }
}

function writeStore(dataDir, store) {
  const file = livePath(dataDir)
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    // 记账失败永远不影响工具调用本身。
    return false
  }
}

function prune(store) {
  const entries = Object.entries(store.designs)
  if (entries.length <= MAX_DESIGNS) return store
  entries.sort((a, b) => String(b[1]?.updatedAt ?? '').localeCompare(String(a[1]?.updatedAt ?? '')))
  store.designs = Object.fromEntries(entries.slice(0, MAX_DESIGNS))
  return store
}

function recordOf(store, designId) {
  if (typeof designId !== 'string' || designId.length === 0) return null
  return store.designs[designId] ?? null
}

// ---------------------------------------------------------------------------
// 图的来源标注（origin / view）。
//
// 审查门要回答的第一个问题是「这是图纸还是模型」：把工程图裁剪块当成模型渲染图，
// 审查员会去挑「模型」的毛病；反过来把模型图当成图纸，它会把渲染出来的明暗当成轮廓。
// live.json 以前只记 path，读的人只好一律当 'mcp'，于是「参考图纸」恒为 0 ——
// 实测里审查员每次都走「这次没有参考图纸」的分支，confidence 被封在 0.5。
//
// 服务出图的命名是固定的：fig-07（figure 裁剪）、cmp-03（并排合成）、shot-12（capture）。
// 能拿到真实来源/视角时（调用方给 origin/view）优先用调用方的；否则按文件名反推，
// 两者都判不出来才留空，由读的人兜底。老数据没有这些字段，不能因此崩。
// ---------------------------------------------------------------------------
const ORIGIN_FROM_NAME = [
  [/^fig(?:ure)?[-_.]|^figure/, 'figure'],
  [/^(?:cmp|compare)[-_.]|^compare/, 'compare'],
  [/^(?:shot|capture)[-_.]|^shot|^capture/, 'capture'],
]

/** 按文件名反推来源；认不出来返回 null。 */
export function originFromImagePath(imagePath) {
  const base = basename(typeof imagePath === 'string' ? imagePath : '').toLowerCase()
  if (base.length === 0) return null
  for (const [pattern, origin] of ORIGIN_FROM_NAME) {
    if (pattern.test(base)) return origin
  }
  return null
}

/** 调用方给的来源归一：'figure' / 'compare' / 'capture'，其它一律 null。 */
export function normalizeImageOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const text = value.toLowerCase()
  if (text.includes('figure') || text === 'fig') return 'figure'
  if (text.includes('compare') || text === 'cmp') return 'compare'
  if (text.includes('capture') || text.includes('shot') || text.includes('inspect') || text.includes('model')) return 'capture'
  return null
}

/** 几何改过一次就 +1。审查结论只对得上同一个 revision。
 *
 *  verify 故意**不在这里清掉**：清掉的话旧证据会变成「没有 verify」（审查门放行），
 *  而留着它、只让 revision 对不上，审查门能判出「这条核对量的是改之前那一版」，
 *  按 VERIFY_NOT_RUN 要求重新核对。见 review-gate.js 的 syncFromLive。
 */
export function bumpRevision({ dataDir, designId, documentPath, designKey }) {
  const id = designId ?? designKey
  if (typeof id !== 'string' || id.length === 0) return null
  const store = readStore(dataDir)
  const previous = store.designs[id] ?? { designId: id, revision: 0, images: [] }
  const next = {
    ...previous,
    designId: id,
    revision: (previous.revision ?? 0) + 1,
    ...(typeof documentPath === 'string' && documentPath.length > 0 ? { documentPath } : {}),
    updatedAt: new Date().toISOString(),
  }
  store.designs[id] = next
  writeStore(dataDir, prune(store))
  return next
}

/** 记一张当前 revision 的图。同一路径同一 revision 不重复记。
 *
 *  origin / view 是可选的：调用方（server.mjs 的 trackLive）手里有 capture 的
 *  view 参数或 compare 的 view 时应当一并传进来；没传时按文件名反推 origin，
 *  推不出来就不写这一项 —— 宁可缺，也不要写一个假的来源。
 */
export function recordImage({ dataDir, designId, designKey, documentPath, imagePath, origin, view, caption }) {
  const id = designId ?? designKey
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof imagePath !== 'string' || imagePath.length === 0) return null
  if (!existsSync(imagePath)) return null
  const store = readStore(dataDir)
  const previous = store.designs[id] ?? { designId: id, revision: 0, images: [] }
  const revision = previous.revision ?? 0
  const resolvedOrigin = normalizeImageOrigin(origin) ?? originFromImagePath(imagePath) ?? 'mcp'
  const images = (previous.images ?? []).filter((item) => item.path !== imagePath)
  images.push({
    path: imagePath,
    atRevision: revision,
    at: new Date().toISOString(),
    // origin 只有四种：capture / compare / figure / mcp（认不出来才 mcp）。
    // 老数据没有这一项，读的人必须能接受缺失（review-gate 会按文件名再推一次）。
    origin: resolvedOrigin,
    ...(typeof view === 'string' && view.length > 0 ? { view } : {}),
    ...(typeof caption === 'string' && caption.length > 0 ? { caption } : {}),
  })
  const next = {
    ...previous,
    designId: id,
    revision,
    ...(typeof documentPath === 'string' && documentPath.length > 0 ? { documentPath } : {}),
    images: images.slice(-8),
    updatedAt: new Date().toISOString(),
  }
  store.designs[id] = next
  writeStore(dataDir, prune(store))
  return next
}

/** 记一次确定性核对（inspect action="verify"）的结果，挂到当前 revision 上。
 *
 *  为什么必须记：PTC 模式下 verify 发生在 run_code 内部，宿主插件看不到子调用的返回，
 *  审查快照里没有 record.verify 时，交付门要么走豁免、要么永远 VERIFY_NOT_RUN ——
 *  实测就是「核对明明跑了、门却不知道」。
 *
 *  只记审查门要判的那几项（status / checks / unmeasured / revision / at），外加摘要与
 *  条数；其余字段（measurements 的几何快照）留在工具回包里，不往 live.json 里灌。
 *  revision 记的是**这次核对量的那一版**：几何再改一次 bumpRevision 就比它大，
 *  读的人看 revision 不一致就知道这是旧证据。
 */
export function recordVerify({ dataDir, designId, designKey, documentPath, verify }) {
  const id = designId ?? designKey
  if (typeof id !== 'string' || id.length === 0) return null
  if (verify === null || typeof verify !== 'object') return null
  const store = readStore(dataDir)
  const previous = store.designs[id] ?? { designId: id, revision: 0, images: [] }
  const revision = previous.revision ?? 0
  const checks = Array.isArray(verify.checks) ? verify.checks : []
  const unmeasured = Array.isArray(verify.unmeasured)
    ? verify.unmeasured
    : checks.filter((item) => item?.status === 'unmeasured')
  const next = {
    ...previous,
    designId: id,
    revision,
    ...(typeof documentPath === 'string' && documentPath.length > 0 ? { documentPath } : {}),
    verify: {
      status: typeof verify.status === 'string' ? verify.status : null,
      // 逐条核对结果原样留着：回注要能说出「哪一条没量到、候选是什么」。
      checks,
      unmeasured,
      revision,
      at: typeof verify.at === 'string' && verify.at.length > 0 ? verify.at : new Date().toISOString(),
      ...(typeof verify.summary === 'string' && verify.summary.length > 0
        ? { summary: verify.summary.slice(0, 400) }
        : {}),
      checkCount: Number.isFinite(Number(verify.checkCount)) ? Number(verify.checkCount) : checks.length,
    },
    updatedAt: new Date().toISOString(),
  }
  store.designs[id] = next
  writeStore(dataDir, prune(store))
  return next
}

/**
 * 交付审批：deliver 成功那一刻，把「这一版已经过交付门」钉在记录上。
 *
 * 为什么必须落在 live.json 里：F4 要拦 `job action="submit" op=save`、
 * `model action="invoke" member=SaveAs*`、`task` 里的 save/export —— 这些调用
 * 由 MCP 服务自己执行，宿主侧的审查门看不见它们，唯一能判的依据就是服务侧
 * 写下的「这一版审批过了」。几何再改一次 bumpRevision 会让 revision 前进，
 * 旧审批因为 `delivery.approvedAtRevision !== revision` 自动失效，不用显式清。
 */
export function recordDeliveryApproval({ dataDir, designId, documentPath, kind, path, bytes }) {
  if (typeof designId !== 'string' || designId.length === 0) return null
  const store = readStore(dataDir)
  const previous = store.designs[designId] ?? { designId, revision: 0, images: [] }
  const revision = previous.revision ?? 0
  const next = {
    ...previous,
    designId,
    revision,
    ...(typeof documentPath === 'string' && documentPath.length > 0 ? { documentPath } : {}),
    delivery: {
      approvedAtRevision: revision,
      at: new Date().toISOString(),
      kind: typeof kind === 'string' ? kind : null,
      path: typeof path === 'string' ? path : null,
      bytes: Number.isFinite(Number(bytes)) ? Number(bytes) : null,
    },
    updatedAt: new Date().toISOString(),
  }
  store.designs[designId] = next
  writeStore(dataDir, prune(store))
  return next
}

/**
 * 设计 → 文档标题的登记（F6 的数据来源）。
 *
 * 为什么要单独记标题：桥接器按 designId 找文档，但它回包里的 `document.title`
 * 才是「这次真的量了谁」。实测里 `designId=bracket-06v1` 的 measure 回了
 * `锁盖.SLDPRT` 的数字，模型照用，验收等于量了别的零件。有了这份登记，
 * Node 侧就能在回包时对一次：登记的标题 ≠ 实际标题 → WRONG_DOCUMENT。
 *
 * 只从「没有冲突」的回包里学（调用方只在身份核对通过时调这里），否则量错了
 * 一次就把错标题学进来，第二次就永远对不上了。
 */
export function recordDocumentTitle({ dataDir, designId, title, documentPath }) {
  if (typeof designId !== 'string' || designId.length === 0) return null
  if (typeof title !== 'string' || title.trim().length === 0) return null
  const store = readStore(dataDir)
  const previous = store.designs[designId] ?? { designId, revision: 0, images: [] }
  const next = {
    ...previous,
    designId,
    revision: previous.revision ?? 0,
    documentTitle: title.trim(),
    ...(typeof documentPath === 'string' && documentPath.length > 0 ? { documentPath } : {}),
    updatedAt: new Date().toISOString(),
  }
  store.designs[designId] = next
  writeStore(dataDir, prune(store))
  return next
}

/** 按 designId 读一条原始记录；没有就是 null（不猜、不取最新）。 */
export function readLiveRecord({ dataDir, designId }) {
  if (typeof designId !== 'string' || designId.length === 0) return null
  return recordOf(readStore(dataDir), designId)
}

/** 本设计自己那一版几何的 revision。没有记录就返回 null（不许拿别人的凑）。 */
export function liveRevisionOf({ dataDir, designId }) {
  const record = readLiveRecord({ dataDir, designId })
  return Number.isFinite(record?.revision) ? record.revision : null
}

/** 所有登记过的 designId（按 updatedAt 新到旧，最多 limit 条）。 */
export function liveDesignIds({ dataDir, limit = 20 }) {
  const store = readStore(dataDir)
  return Object.values(store.designs)
    .filter((item) => typeof item?.designId === 'string' && item.designId.length > 0)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, limit)
    .map((item) => item.designId)
}

/** 读回：按 designId 取；给不出 designId 时取全局最新的一条（调用方必须自己说明
 *  这是「最新」而不是「我要的那份」）。 */
export function readLive({ dataDir, designId }) {
  const store = readStore(dataDir)
  const direct = recordOf(store, designId)
  if (direct !== null) return { record: direct, matchedBy: 'designId' }
  if (typeof designId === 'string' && designId.length > 0) return { record: null, matchedBy: null }
  const entries = Object.values(store.designs)
  if (entries.length === 0) return { record: null, matchedBy: null }
  entries.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  return { record: entries[0], matchedBy: 'latest' }
}
