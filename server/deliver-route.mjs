// deliver 的「这份设计的文档从哪儿来」决策（纯函数，不碰 SOLIDWORKS、不读磁盘）。
//
// 背景：多会话共用一个 SOLIDWORKS 实例时，另一个会话的 build 会把活动文档切走
// 甚至直接关掉，随后 deliver 回 DOC_NOT_OPEN。deliver 不能依赖「当前活动文档」，
// 必须按 designId 找到它自己的那一份；找不到就按 design store 里的定义重开或
// 重建，再把文件落到目标路径。
//
// 这里只回答「用哪条路」，不执行；执行与回读在 server.mjs：
//   source=active   窗口里已有这一份（按 designId 登记 / 路径 / 同目录同名匹配）
//   source=reopened 盘上的 SLDPRT 就是当前设计定义编译出来的（关掉后重开）
//   source=rebuilt  没有可用文档或可用文件，按 project 里的设计定义重建
//
// 决策与执行分开，是为了「活动文档不匹配 → rebuilt」这类判据能离线单测
// （test/deliver-route.mjs），不必起 SOLIDWORKS。

export const DELIVER_SOURCES = Object.freeze(['active', 'reopened', 'rebuilt'])

/** 文件名去掉扩展名：design.json 里的 partId 就是它（M6-14.SLDPRT → M6-14）。 */
export function partIdOf(path) {
  if (typeof path !== 'string' || path.length === 0) return null
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem.length > 0 ? stem : null
}

/** list 回包 → 文档数组。拿不到（null / 形状不对）一律返回 null：
 *  「不知道」和「一个都没开」在决策里必须区分开。 */
export function normalizeOpenDocuments(listed) {
  if (Array.isArray(listed)) return listed
  if (listed !== null && typeof listed === 'object' && Array.isArray(listed.documents)) return listed.documents
  return null
}

function pathKey(path) {
  if (typeof path !== 'string' || path.length === 0) return null
  const normalized = path.replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/\\+$/, '')
  return normalized.length > 0 ? normalized.toLowerCase() : null
}

function titleKey(title) {
  return typeof title === 'string' && title.length > 0 ? title.toLowerCase() : null
}

/**
 * 在已打开文档里按 designId / 路径 / partId 精确匹配这一份设计。
 *
 * 优先级：
 *   1. designId：WorkRegistry 里这个 designId 登记的标题正好开着；
 *   2. path：文档的完整路径等于登记路径 / 项目 cadPath / 交付目标路径；
 *   3. partId：文件名 stem 与设计相同，且文档旁 design.json 里的定义哈希等于
 *      project 里的定义哈希 —— 证明这是同一份设计（例如换过 designId 后缀、
 *      或文件被复制到别处），不是"标题撞名"。
 * 匹配只认"同一条登记 / 同一路径 / 同一份定义"；标题撞名但证明不了身份的一律不认，
 * 宁可重建，也不能把用户手开的同名零件当成自己的。
 *
 * 文档对象可带 contract:{designId,partId,definitionHash}（server 读文件旁
 * design.json 后附加）；没有 contract 的文档只参与第 1、2 步。
 */
export function matchOpenDeliverDocument({ designId, registry, openDocuments, knownPaths = [], definitionHash = null } = {}) {
  const docs = Array.isArray(openDocuments) ? openDocuments.filter((doc) => doc && typeof doc === 'object') : []
  if (docs.length === 0) return null

  const wantedTitle = titleKey(registry?.title)
  if (wantedTitle !== null) {
    const hit = docs.find((doc) => titleKey(doc.title) === wantedTitle)
    // 登记里记了路径时，标题对上还要路径对上：否则可能是「我们那份被关掉、
    // 用户又手开了同名文件」，按标题保存就会写进别人的文档。
    const registryPath = pathKey(registry?.path)
    const hitPath = pathKey(hit?.path)
    if (hit && (registryPath === null || hitPath === registryPath)) {
      return {
        by: 'designId',
        designId: designId ?? null,
        title: typeof hit.title === 'string' ? hit.title : registry.title,
        path: hitPath !== null ? hit.path : (registry?.path ?? null),
        dirty: hit.dirty === true,
      }
    }
  }

  const known = [registry?.path, ...knownPaths].filter((path) => pathKey(path) !== null)
  const knownPathsSet = new Set(known.map(pathKey))
  for (const doc of docs) {
    if (pathKey(doc.path) === null) continue
    if (!knownPathsSet.has(pathKey(doc.path))) continue
    return { by: 'path', designId: designId ?? null, title: doc.title ?? null, path: doc.path, dirty: doc.dirty === true }
  }

  // partId：同一份定义编译出来的文件，文件名 stem 与本设计一致。definitionHash
  // 是 project 定义的 sha256；文档旁 design.json 的 definition 哈希必须相等。
  if (typeof definitionHash !== 'string' || definitionHash.length === 0) return null
  const stems = new Set(known.map((path) => partIdOf(path)?.toLowerCase()).filter(Boolean))
  if (designId) stems.add(String(designId).toLowerCase())
  if (stems.size === 0) return null
  for (const doc of docs) {
    if (pathKey(doc.path) === null) continue
    const stem = partIdOf(doc.path)?.toLowerCase()
    if (!stem || !stems.has(stem)) continue
    if (doc.contract?.definitionHash !== definitionHash) continue
    return { by: 'partId', designId: designId ?? null, title: doc.title ?? null, path: doc.path, dirty: doc.dirty === true }
  }
  return null
}

function route(plan) {
  return {
    ok: true,
    source: null,
    reason: null,
    match: null,
    activatePath: null,
    reopenPath: null,
    rebuild: false,
    targetPath: null,
    ...plan,
  }
}

/**
 * 交付路由。facts 由 server.mjs 采集：
 *   designId, kind, targetPath,
 *   registry: {title, path} | null          —— 桥接器 WorkRegistry 里这个 designId 的登记
 *   openDocuments: 数组 | null              —— 本实例当前打开的文档；null=拿不到
 *   cadPath / cadFile:{exists,bytes}         —— 项目记录里上次编译出来的 SLDPRT
 *   cadCurrent: true|false|null             —— 该文件是否被证明就是当前设计定义编译的
 *   hasDefinition: boolean                  —— project 里有没有可重建的设计定义
 *
 * 决策顺序：
 *   active（登记/路径匹配） → reopened（文件可信） → rebuilt（有定义） → reopened（只有文件） → 失败。
 * 「文件可信」= design.json/manifest.json 与文件哈希一致、且定义与 project 存档一致；
 * 证明不了就不重开旧文件，按定义重建 —— 定义是唯一真源。
 */
export function planDeliverRoute(facts = {}) {
  const kind = typeof facts.kind === 'string' ? facts.kind : 'sldprt'
  const targetPath = typeof facts.targetPath === 'string' ? facts.targetPath : null
  const base = { designId: facts.designId ?? null, kind, targetPath }
  const cadPath = typeof facts.cadPath === 'string' && facts.cadPath.length > 0 ? facts.cadPath : null
  const cadExists = facts.cadFile?.exists === true
  const cadCurrent = facts.cadCurrent === true

  if (kind !== 'sldprt') {
    return { ...route(base), ok: false, reason: 'UNSUPPORTED_KIND', message: `deliver 路由只处理 kind="sldprt"，收到 ${kind}` }
  }

  if (facts.openDocuments === null || facts.openDocuments === undefined) {
    // 打开清单拿不到（桥接器预热/实例绑定失败）：先按 designId 直接存一份。
    // 保存若报 DOC_NOT_OPEN，server 会重新取事实再走重开/重建，不会停在这里。
    return route({ ...base, source: 'active', reason: 'PREFLIGHT_UNAVAILABLE' })
  }

  const match = matchOpenDeliverDocument({
    designId: facts.designId,
    registry: facts.registry ?? null,
    openDocuments: facts.openDocuments,
    knownPaths: [facts.registry?.path, cadPath, targetPath].filter(Boolean),
    definitionHash: facts.definitionHash ?? null,
  })
  if (match !== null) {
    return route({
      ...base,
      source: 'active',
      reason: match.by === 'designId' ? 'OPEN_DOC_REGISTRY' : match.by === 'path' ? 'OPEN_DOC_PATH' : 'OPEN_DOC_PARTID',
      match,
      // 登记标题能直接激活；按路径/partId 匹配到的那一份要先 open 一次，
      // 让桥接器把它和 designId 重新绑上，save 才不会又找不到。
      activatePath: match.by === 'designId' ? null : match.path,
    })
  }

  if (cadExists && cadCurrent) {
    return route({ ...base, source: 'reopened', reason: 'ARTIFACT_CURRENT', reopenPath: cadPath })
  }
  if (facts.hasDefinition === true) {
    return route({ ...base, source: 'rebuilt', reason: cadExists ? 'ARTIFACT_STALE_OR_UNPROVEN' : 'NO_OPEN_DOC_NO_FILE', rebuild: true })
  }
  if (cadExists) {
    // 没有定义可重建，但盘上还有这份文件：重开并保存它，并在回包里说明这是
    // "只有文件、没有设计存档"的降级路径（不能算严格意义的交付）。
    return route({ ...base, source: 'reopened', reason: 'ARTIFACT_WITHOUT_DEFINITION', reopenPath: cadPath })
  }
  return {
    ...route(base),
    ok: false,
    reason: 'NO_SOURCE',
    message: `design "${facts.designId ?? ''}" 没有可交付的来源：文档没打开、盘上没有 SLDPRT、项目存档里也没有设计定义`,
  }
}

/**
 * 保存后「重新打开读一次」的判据：零件看实体数，装配看组件数，必须 > 0。
 * 体积/面数只作为读数回给调用方，不参与这条判据。
 */
export function judgeReopenedDocument({ kind = 'part', bodies = null, components = null } = {}) {
  const assembly = String(kind).toLowerCase() === 'assembly'
  const raw = assembly ? components : bodies
  const value = raw === null || raw === undefined ? null : Number(raw)
  const finite = Number.isFinite(value)
  const metric = assembly ? 'components' : 'bodies'
  const ok = finite && value > 0
  return {
    ok,
    metric,
    value: finite ? value : null,
    reason: ok ? 'GEOMETRY_PRESENT' : assembly ? 'NO_COMPONENTS' : 'NO_SOLID_BODIES',
  }
}

/**
 * 保存后关掉重开之前，先确认「按标题关」关的就是目标路径这一份。
 * SOLIDWORKS 的 close 只按标题找；同名不同目录的两份同时开着时按标题关会关错，
 * 所以只有在标题唯一且路径完全一致时才允许关。
 */
export function closeTargetFacts({ openDocuments, targetPath } = {}) {
  const base = typeof targetPath === 'string' ? targetPath.split(/[\\/]/).pop() ?? '' : ''
  if (base.length === 0) return { ok: false, title: null, reason: 'NO_TARGET' }
  if (!Array.isArray(openDocuments)) return { ok: false, title: base, reason: 'OPEN_LIST_UNKNOWN' }
  const sameTitle = openDocuments.filter((doc) => doc && titleKey(doc.title) === base.toLowerCase())
  if (sameTitle.length === 0) return { ok: false, title: base, reason: 'NOT_OPEN' }
  if (sameTitle.length > 1) return { ok: false, title: base, reason: 'TITLE_AMBIGUOUS', matches: sameTitle.length }
  const doc = sameTitle[0]
  if (pathKey(doc.path) !== pathKey(targetPath)) {
    return { ok: false, title: base, reason: 'TITLE_POINTS_ELSEWHERE', path: typeof doc.path === 'string' ? doc.path : null }
  }
  if (doc.dirty === true) return { ok: false, title: base, reason: 'DIRTY' }
  return { ok: true, title: typeof doc.title === 'string' ? doc.title : base, reason: 'UNIQUE' }
}
