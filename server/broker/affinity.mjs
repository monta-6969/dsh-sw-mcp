// 会话与 SOLIDWORKS 实例的绑定规则。单独放在这里是为了不启 broker 也能测。
//
// 两种策略（SW_MCP_INSTANCE_POLICY）：
//   shared（旧默认）：一个 broker 只养一个实例，所有会话共用它——用户抱怨的
//     「自动化又开了一个 SOLIDWORKS 窗口」就是这里每人各起一个造成的。已有
//     映射且实例还活着就回自己的 pid，否则挑负载最低的现有实例并落映射；
//     **只要 ROT 有可分配的实例就绝不返回 0**（返回 0 等于叫调用方再起一个）。
//   isolated（**R11 起的默认**）：保留独占语义，不同会话不共用 pid；全被占时返回
//     busy，由 instances.ensure 排队等待，达到 maxInstances 就绝不再起新的。
//   adopt-user（显式逃生口，默认绝不开）：只有显式传这个策略时，才允许把
//     launchedBy="user" 的实例分配给会话，且每选一次都会打
//     `WARN adopting user instance pid=...`。默认策略下用户实例**永远不分配**。
//
// 为什么默认从 shared 改成 isolated（R11）：
//   shared 的 leastLoaded 完全不看 launchedBy，于是 broker 把「用户自己开着的那唯一
//   一个 SOLIDWORKS」当成最空的那个实例分给 AI 会话（实测 instances.json 里
//    ownerClients 同时挂着两个 MCP 会话）。用户于是看到 AI 在自己的窗口里开文档、
//    rebuild、改视图——这正是「AI 会话被分配到用户的 SOLIDWORKS 实例上」这条根因。
//   默认改成 isolated 后，每个会话要么复用**自己**的实例，要么让 broker 起一个
//   专属实例；用户的窗口只属于用户自己。
//
// 实例数量上限：shared 默认 1，isolated 默认 SW_MCP_MAX_INSTANCES（2），
// adopt-user 同 isolated。shared 的 1 保持不变——改了会回到「开太多实例」的老抱怨。
//
// 「用户实例」的定义只认一条事实：instances.json / ROT 行里的 launchedBy === "user"。
// launchedBy 缺失（老登记表、只从 ROT 拿到 pid 的行）按不可分配处理（fail closed）：
// 既然无法证明它是 broker 起的，就不能悄悄把 AI 的工作落到用户窗口里。

export const DEFAULT_POLICY = 'isolated'
export const DEFAULT_MAX_INSTANCES = { shared: 1, isolated: 2, 'adopt-user': 2 }

/** 策略的合法取值。显式 'adopt-user' 是唯一的「用用户实例」开关。 */
export const POLICY_VALUES = Object.freeze(['shared', 'isolated', 'adopt-user'])

/** 归一化策略名；坏值退回默认（isolated），而不是让 broker 起不来。 */
export function instancePolicy(env = process.env) {
  const raw = String(env.SW_MCP_INSTANCE_POLICY ?? DEFAULT_POLICY).trim().toLowerCase()
  return POLICY_VALUES.includes(raw) ? raw : DEFAULT_POLICY
}

/** 只要合法策略值本身（不做 env 读取），非法的退回 DEFAULT_POLICY。 */
export function normalizePolicy(policy) {
  const raw = String(policy ?? '').trim().toLowerCase()
  return POLICY_VALUES.includes(raw) ? raw : DEFAULT_POLICY
}

/** 上限：显式 env 优先；否则按策略给默认值。非法/负数一律按默认。 */
export function maxInstancesFor(policy, env = process.env) {
  const normalized = normalizePolicy(policy)
  const raw = Number(env.SW_MCP_MAX_INSTANCES)
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw)
  return DEFAULT_MAX_INSTANCES[normalized]
}

/** 这个实例是用户自己开的吗（唯一判据：launchedBy === "user"）。 */
export function isUserInstance(inst) {
  return String(inst?.launchedBy ?? '').trim().toLowerCase() === 'user'
}

/** broker/test 起的实例才算「我们的」；launchedBy 缺失按「不是我们的」处理。 */
export function isServiceInstance(inst) {
  const by = String(inst?.launchedBy ?? '').trim().toLowerCase()
  return by === 'broker' || by === 'test'
}

/**
 * 一个实例能不能分配给会话。纯函数，可单测；chooseInstance 与 instances.list 都用它，
 * 保证「清单里说能用的」和「真的会分配到的」是同一个判断。
 *
 * 规则（按顺序）：
 *   1. pid 无效 → false；
 *   2. 用户实例（含 launchedBy 缺失的未知实例）→ false，除非显式 adoptUser；
 *   3. 别的会话已经把它占满（ownerClients 里除自己以外的 >= maxPerInstance）→ false；
 *   4. 它还没起过 worker，而调用方不允许为它起 worker（allowLaunch=false）→ false。
 *
 * @param {object} inst 一行实例（ROT 行或 instances.json 登记行）
 * @param {object} [options]
 * @param {string|null} [options.sessionId] 调用方会话 id（自己占着不算被占满）
 * @param {string} [options.policy] 策略（isolated 下每实例默认 1 个会话）
 * @param {number|null} [options.maxPerInstance] 每实例最多几个会话；默认按策略
 * @param {boolean} [options.allowLaunch] 是否允许为该实例起 worker（默认 true）
 * @param {boolean} [options.adoptUser] 显式允许分配用户实例（默认 false）
 * @returns {boolean}
 */
export function canAssign(inst, {
  sessionId = null,
  policy = DEFAULT_POLICY,
  maxPerInstance = null,
  allowLaunch = true,
  adoptUser = false,
} = {}) {
  const pid = Number(inst?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return false
  const adoptAllowed = adoptUser === true || normalizePolicy(policy) === 'adopt-user'
  const userLike = !isServiceInstance(inst)
  if (userLike && !adoptAllowed) return false
  // 显式 adoptUser 是「我知道我在用用户的窗口」：它连「已被别的会话占满」也一并
  // 越过——真机现场那个用户实例的 ownerClients 里就挂着两个会话（旧 bug 写进去的
  // 脏绑定），不放行这一条，逃生口等于不存在。
  if (adoptAllowed) {
    if (inst?.workerStarted === false && allowLaunch !== true) return false
    return true
  }
  const cap = perInstanceCap(policy, maxPerInstance)
  const owners = Array.isArray(inst?.ownerClients) ? inst.ownerClients.map(String) : []
  const me = sessionId === null || sessionId === undefined ? null : String(sessionId)
  const others = me === null ? owners : owners.filter((id) => id !== me)
  if (others.length >= cap) return false
  if (inst?.workerStarted === false && allowLaunch !== true) return false
  return true
}

/** 每个实例最多挂几个会话：shared 不限（共用本来就是它的语义），其余默认 1。 */
export function perInstanceCap(policy, maxPerInstance = null) {
  const explicit = Number(maxPerInstance)
  if (Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit)
  return normalizePolicy(policy) === 'shared' ? Number.POSITIVE_INFINITY : 1
}

/**
 * 把「显式参数 / 调用方 env」解析成一次 ensure 请求要带的实例策略覆盖值。
 *
 * 背景（真机缺陷 A）：broker 是常驻进程，用户/测试在自己的会话里设
 * SW_MCP_INSTANCE_POLICY=isolated、SW_MCP_MAX_INSTANCES=3 并不会影响一个早就
 * 起好的 broker；`job action="ensure"` 又不把这些值透传，于是 ensure 仍按 broker
 * 启动时的 shared/1 分配，隔离策略形同虚设。规则：
 *   - 显式参数 > 调用方 env；两者都没有就不传（由 broker 用自身 env 决定）；
 *   - 非法值一律当「没传」，绝不把坏值透给 broker 把启动搞崩。
 *
 * @param {{policy?:string|null, tag?:string|null, maxInstances?:number|string|null}} params
 * @param {object} env 调用方进程的环境变量
 * @returns {{policy:string|null, maxInstances:number|null, tag:string|null,
 *   source:{policy:string,maxInstances:string,tag:string}}}
 */
export function resolveInstanceOverrides({ policy = null, tag = null, maxInstances = null } = {}, env = process.env) {
  const pickText = (value) => {
    if (value === null || value === undefined) return null
    const text = String(value).trim()
    return text.length > 0 ? text : null
  }
  // 坏策略值当「没传」处理：既不能拿坏值去覆盖 env，也不能因为一个拼错的参数把
  // broker 的 isolated 配置退回 shared（那又会静默多开 SOLIDWORKS）。
  const validPolicy = (value) => {
    const text = pickText(value)?.toLowerCase() ?? null
    return POLICY_VALUES.includes(text) ? text : null
  }
  const explicitPolicy = validPolicy(policy)
  const envPolicy = validPolicy(env?.SW_MCP_INSTANCE_POLICY)
  const policyText = explicitPolicy ?? envPolicy
  const resolvedPolicy = policyText ? normalizePolicy(policyText) : null

  const explicitTag = pickText(tag)
  const envTag = pickText(env?.SW_MCP_INSTANCE_TAG)
  const resolvedTag = explicitTag ?? envTag

  const explicitCapRaw = maxInstances === null || maxInstances === undefined ? null : Number(maxInstances)
  const explicitCap = Number.isFinite(explicitCapRaw) && explicitCapRaw >= 1 ? Math.floor(explicitCapRaw) : null
  const envCapRaw = Number(env?.SW_MCP_MAX_INSTANCES)
  const envCap = Number.isFinite(envCapRaw) && envCapRaw >= 1 ? Math.floor(envCapRaw) : null
  const resolvedMax = explicitCap ?? envCap

  return {
    policy: resolvedPolicy,
    maxInstances: resolvedMax,
    tag: resolvedTag,
    source: {
      policy: explicitPolicy ? 'param' : (envPolicy ? 'env' : 'default'),
      maxInstances: explicitCap !== null ? 'param' : (envCap !== null ? 'env' : 'default'),
      tag: explicitTag ? 'param' : (envTag ? 'env' : 'default'),
    },
  }
}

/**
 * 把 resolveInstanceOverrides 的结果收敛成「请求里真正要带的字段」：null/undefined
 * 一律不出现，免得 broker 把「没设」误当成「覆盖成默认值」。
 * @param {{policy?:string|null,maxInstances?:number|null,tag?:string|null}} overrides
 * @returns {{policy?:string,maxInstances?:number,tag?:string}}
 */
export function instanceOverrideFields(overrides = {}) {
  const fields = {}
  if (overrides?.policy) fields.policy = String(overrides.policy)
  const cap = overrides?.maxInstances
  if (cap !== null && cap !== undefined && Number.isFinite(Number(cap)) && Number(cap) >= 1) fields.maxInstances = Math.floor(Number(cap))
  if (overrides?.tag) fields.tag = String(overrides.tag)
  return fields
}

export function claimedPids(clientPid, exceptClientId = null) {
  const claimed = new Set()
  for (const [clientId, pid] of clientPid) {
    if (clientId !== exceptClientId) claimed.add(pid)
  }
  return claimed
}

/** 会话进程已经退出时，它占着的实例要被释放出来给下一个会话复用。
 * 否则每次重启会话都会新起一个 SOLIDWORKS，实例越积越多。 */
export function pruneDeadClients(clientPid, clientAlive = () => true) {
  for (const clientId of clientPid.keys()) {
    if (!clientAlive(clientId)) clientPid.delete(clientId)
  }
  return clientPid
}

/**
 * ROT/登记表里的 pid 列表。
 * 默认**不含**用户实例：调用方以前只拿到 pid，于是 shared 的 leastLoaded 把用户的
 * 唯一窗口当成最空的实例分配出去；现在想包含用户实例必须显式 includeUser。
 *
 * @param {Array<object>} instances
 * @param {{includeUser?:boolean}} [options]
 * @returns {number[]}
 */
export function instancePids(instances, { includeUser = false } = {}) {
  const seen = new Set()
  for (const entry of instances ?? []) {
    const pid = Number(entry?.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!includeUser && isUserInstance(entry)) continue
    seen.add(pid)
  }
  return [...seen]
}

function leastLoaded(pids, load = () => 0) {
  const scores = new Map(pids.map((pid) => [pid, Number(load(pid)) || 0]))
  return pids.slice().sort((a, b) => (scores.get(a) - scores.get(b)) || (a - b))[0]
}

/**
 * 选实例的完整结果。affinity 只回答「用哪个 pid / 是否需要新起 / 是否该排队」，
 * 真去启动进程、预热 worker、写 instances.json 的是 instances.ensure。
 *
 * 关键规则（B1）：用户实例（launchedBy="user"）默认**永远不分配**。排除之后如果
 * 一个可用实例都没有，返回 needLaunch=true（reason="ONLY_USER_INSTANCES"），
 * 由 ensure 去起一个专属实例——「将就着用用户那个最空的」这一条已被删除。
 *
 * @param {object} input
 * @param {Array<{pid:number,launchedBy?:string,ownerClients?:string[],workerStarted?:boolean}>} input.instances
 *   ROT 里的实例 + 登记表里的事实（launchedBy/ownerClients 由 instances.mjs 合并进来）
 * @param {number} [input.requested] 显式指定 pid，优先级最高（显式=调用方自己点名，会打 WARN）
 * @param {string|null} [input.clientId] MCP 会话 id
 * @param {Map<string,number>} input.clientPid 会话→实例
 * @param {(pid:number)=>number} [input.load] 实例当前活跃作业数
 * @param {(clientId:string)=>boolean} [input.clientAlive] 会话进程是否还活着
 * @param {'shared'|'isolated'|'adopt-user'} [input.policy]
 * @param {number} [input.maxInstances] 本策略的实例数上限（只数我们自己的实例）
 * @param {boolean} [input.adoptUser] 等价于显式 adopt-user 策略的开关
 * @param {number|null} [input.maxPerInstance] 每个实例最多几个会话
 * @param {(message:string)=>void} [input.log] 审计日志（WARN 走这里，别静默）
 * @returns {{pid:number, policy:string, maxInstances:number, reuse:boolean, busy:boolean,
 *   needLaunch:boolean, requested:boolean, claimed:number[], reason:string|null,
 *   userPids:number[], candidatePids:number[], adoptedUser:boolean}}
 */
export function chooseInstance({
  instances,
  requested = 0,
  clientId = null,
  clientPid = new Map(),
  load = () => 0,
  clientAlive = () => true,
  policy = DEFAULT_POLICY,
  maxInstances,
  adoptUser = false,
  maxPerInstance = null,
  log = () => {},
}) {
  const resolvedPolicy = normalizePolicy(policy)
  const cap = Number.isFinite(Number(maxInstances)) && Number(maxInstances) >= 1
    ? Math.floor(Number(maxInstances))
    : maxInstancesFor(resolvedPolicy)
  const adoptAllowed = adoptUser === true || resolvedPolicy === 'adopt-user'
  const all = Array.isArray(instances) ? instances : []
  const userPids = [...new Set(all.filter(isUserInstance)
    .map((inst) => Number(inst?.pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0))]
  const base = {
    pid: 0,
    policy: resolvedPolicy,
    maxInstances: cap,
    reuse: false,
    busy: false,
    needLaunch: false,
    requested: false,
    claimed: [...claimedPids(clientPid)],
    reason: null,
    userPids,
    candidatePids: [],
    adoptedUser: false,
  }
  const note = typeof log === 'function' ? log : () => {}

  const explicit = Number(requested)
  if (Number.isInteger(explicit) && explicit > 0) {
    if (clientId) clientPid.set(clientId, explicit)
    const target = all.find((item) => Number(item?.pid) === explicit) ?? null
    const adopted = Boolean(target && !isServiceInstance(target))
    if (adopted) {
      // 显式点名到用户实例：这是调用方自己的手，允许，但不许静默。
      note(`WARN adopting user instance pid=${explicit}（调用方显式指定 instancePid）`)
    }
    return {
      ...base,
      pid: explicit,
      requested: true,
      adoptedUser: adopted,
      reason: adopted ? 'EXPLICIT_ADOPT' : 'EXPLICIT',
      claimed: [...claimedPids(clientPid, clientId)],
    }
  }
  pruneDeadClients(clientPid, clientAlive)

  // 粘滞优先：本会话已经绑定过、还活着的 service 实例直接复用。
  // 为什么必须放在 canAssign 之前：实例的 ownerClients 只增不减，一旦被第二个会话
  // 碰过，isolated 的 perInstanceCap=1 就会把它判成「满员」；同一个会话的 build 和
  // capture 于是被拆到两个实例上，第二步报 DOC_NOT_OPEN（实测 C04-01、ASM-09）。
  // 绑定过的实例就是本会话的实例，其他人碰过不影响复用。
  if (clientId) {
    const sticky = clientPid.get(clientId)
    if (Number.isInteger(sticky) && sticky > 0) {
      const hit = all.find((item) => Number(item?.pid) === sticky && isServiceInstance(item))
      if (hit) return { ...base, pid: sticky, reuse: true, reason: 'STICKY' }
    }
  }

  // 只有 canAssign 通过的实例才进入候选。用户实例 / launchedBy 缺失的未知实例
  // 在 adoptAllowed=false 时全部被挡在这里。
  const candidates = all.filter((inst) => canAssign(inst, {
    sessionId: clientId,
    policy: resolvedPolicy,
    maxPerInstance,
    adoptUser: adoptAllowed,
  }))
  const pids = instancePids(candidates, { includeUser: adoptAllowed })
  base.candidatePids = pids

  if (pids.length === 0) {
    // 排除用户实例后没有可用的：绝不将就，让 ensure 去起/找一个自己的实例。
    if (all.length > 0) return { ...base, needLaunch: true, reason: 'ONLY_USER_INSTANCES' }
    return { ...base, needLaunch: true, reason: 'NO_INSTANCES' }
  }

  // 没有会话身份时只回答「哪个实例最空」，不落绑定。
  if (!clientId) {
    return { ...base, pid: leastLoaded(pids, load) }
  }

  const mapped = clientPid.get(clientId)
  if (mapped && pids.includes(mapped)) return { ...base, pid: mapped, reuse: true }

  const userPidSet = new Set(userPids)
  const warnIfUser = (pid) => {
    if (userPidSet.has(pid)) note(`WARN adopting user instance pid=${pid}`)
    return pid
  }

  if (resolvedPolicy === 'shared' || resolvedPolicy === 'adopt-user') {
    // 共用策略：谁最空用谁；绝不因为别人见过就返回 0。
    const pid = warnIfUser(leastLoaded(pids, load))
    clientPid.set(clientId, pid)
    return { ...base, pid, adoptedUser: userPidSet.has(pid) }
  }

  // 独占策略：只拿没人认领的实例。
  const claimed = claimedPids(clientPid, clientId)
  const free = pids.filter((pid) => !claimed.has(pid))
  if (free.length > 0) {
    const pid = warnIfUser(leastLoaded(free, load))
    clientPid.set(clientId, pid)
    return { ...base, pid, claimed: [...claimed], adoptedUser: userPidSet.has(pid) }
  }
  // 全被别的会话占着：到上限就排队（busy），没到上限可以让 ensure 再起一个。
  return {
    ...base,
    busy: pids.length >= cap,
    needLaunch: pids.length < cap,
    reason: pids.length >= cap ? 'CAP_REACHED' : 'NEED_LAUNCH',
    claimed: [...claimed],
  }
}

/**
 * 兼容旧调用方：只要一个 pid。返回 0 表示「现在没有可用的，去 ensure」。
 * @param {object} input 同 chooseInstance
 */
export function pickInstancePid(input) {
  return chooseInstance(input).pid
}
