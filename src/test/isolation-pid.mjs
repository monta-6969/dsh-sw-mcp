// R11 隔离修复的离线验收：不启动 broker、不启动 SOLIDWORKS、不碰任何进程。
//
// 守的是什么（真机事实）：broker 把「用户自己开着的那唯一一个 SOLIDWORKS」
// （pid 41452，launchedBy="user"）合法地分给了两个 MCP 会话，instances.json 里
// ownerClients:["mcp:24228","mcp:49160"]。根因有两条：
//   1. affinity 的 shared/leastLoaded 完全不看 launchedBy → 用户实例被当成「最空的那个」；
//   2. SwBridge 在 ExpectedPid==0 时直接用 Marshal.GetActiveObject 跟随前台实例。
// 本文件把这两条都钉成断言：
//   A. canAssign / chooseInstance / instancePids 的分配规则（纯函数）；
//   B. ensure 的端到端行为：ROT 里只有用户实例时必须自己起一个，绝不返回用户 pid；
//   C. instances.list()/bound() 的观测口径：userPids / boundPids / affinityPolicy；
//   D. SwLock 的锁名生成规则（按 pid 分锁，保留旧全局名）；
//   E. SwHost.cs 静态断言：GetActiveObject 只允许出现在 ExpectedPid==0 分支里。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_POLICY,
  canAssign,
  chooseInstance,
  instancePids,
  instancePolicy,
  isServiceInstance,
  isUserInstance,
  normalizePolicy,
  perInstanceCap,
} from '../server/broker/affinity.mjs'
import {
  InstanceManager,
  boundPidForSession,
  normalizeEntry,
  readInstances,
  writeInstances,
} from '../server/broker/instances.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

const repo = fileURLToPath(new URL('..', import.meta.url))
const readSource = (relative) => readFileSync(join(repo, relative), 'utf8')

const userPid = 41452
const userInstance = { pid: userPid, launchedBy: 'user', ownerClients: ['mcp:24228', 'mcp:49160'], workerStarted: true }
const brokerInstance = (pid, extra = {}) => ({ pid, launchedBy: 'broker', ownerClients: [], workerStarted: true, ...extra })
const tempDirs = []
const tempFile = (name = 'instances.json') => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-isolation-'))
  tempDirs.push(dir)
  return join(dir, name)
}

// ============================================ A. 分配规则（纯函数）
{
  check('默认策略是 isolated（R11 决定：每次找/起一个专属实例）', DEFAULT_POLICY === 'isolated', DEFAULT_POLICY)
  check('策略归一化：adopt-user 是合法值', normalizePolicy('adopt-user') === 'adopt-user')
  check('策略归一化：坏值退回默认', normalizePolicy('weird') === DEFAULT_POLICY, normalizePolicy('weird'))
  check('launchedBy 判定：user 是用户实例', isUserInstance(userInstance) === true)
  check('launchedBy 判定：broker/test 是我们的实例',
    isServiceInstance(brokerInstance(1)) === true && isServiceInstance({ pid: 2, launchedBy: 'test' }) === true)
  check('launchedBy 缺失时既不是 user 也不是 service（fail closed）',
    isUserInstance({ pid: 3 }) === false && isServiceInstance({ pid: 3 }) === false)

  check('canAssign：用户实例 → false', canAssign(userInstance, { sessionId: 'sess-a' }) === false)
  check('canAssign：用户实例 + 显式 adoptUser → true',
    canAssign(userInstance, { sessionId: 'sess-a', adoptUser: true }) === true)
  check('canAssign：adopt-user 策略下用户实例 → true',
    canAssign(userInstance, { sessionId: 'sess-a', policy: 'adopt-user' }) === true)
  check('canAssign：broker 实例 → true', canAssign(brokerInstance(5000), { sessionId: 'sess-a' }) === true)
  check('canAssign：别的会话已经占满（isolated 每实例 1 个）→ false',
    canAssign(brokerInstance(5000, { ownerClients: ['mcp:24228'] }), { sessionId: 'sess-b' }) === false)
  check('canAssign：占着的就是自己 → true（不是「别人占」）',
    canAssign(brokerInstance(5000, { ownerClients: ['mcp:24228'] }), { sessionId: 'mcp:24228' }) === true)
  check('canAssign：shared 允许多会话共用 → true',
    canAssign(brokerInstance(5000, { ownerClients: ['mcp:24228'] }), { sessionId: 'sess-b', policy: 'shared' }) === true)
  check('canAssign：workerStarted=false 且不允许启动 → false',
    canAssign(brokerInstance(5000, { workerStarted: false }), { sessionId: 'sess-a', allowLaunch: false }) === false)
  check('canAssign：workerStarted=false 但允许启动 → true',
    canAssign(brokerInstance(5000, { workerStarted: false }), { sessionId: 'sess-a', allowLaunch: true }) === true)
  check('canAssign：pid 无效 → false',
    canAssign({ pid: 0, launchedBy: 'broker' }, {}) === false && canAssign(null, {}) === false)
  check('每实例上限：isolated=1 / shared=∞',
    perInstanceCap('isolated') === 1 && perInstanceCap('shared') === Number.POSITIVE_INFINITY,
    { isolated: perInstanceCap('isolated'), shared: String(perInstanceCap('shared')) })

  check('instancePids：默认排除用户实例', JSON.stringify(instancePids([userInstance, brokerInstance(5000)])) === '[5000]',
    instancePids([userInstance, brokerInstance(5000)]))
  check('instancePids：includeUser 时才带上用户 pid',
    JSON.stringify(instancePids([userInstance, brokerInstance(5000)], { includeUser: true })) === `[${userPid},5000]`,
    instancePids([userInstance, brokerInstance(5000)], { includeUser: true }))
}

// ============================================ A2. chooseInstance：绝不将就用户实例
{
  // 真机场景：ROT 里只有一个实例，就是用户那个。
  const choice = chooseInstance({
    instances: [userInstance],
    clientId: 'mcp:49160',
    clientPid: new Map(),
    policy: 'isolated',
  })
  check('chooseInstance：只有用户实例 → needLaunch:true', choice.needLaunch === true, choice)
  check('chooseInstance：只有用户实例 → 绝不返回用户 pid', choice.pid === 0, choice.pid)
  check('chooseInstance：reason 是 ONLY_USER_INSTANCES', choice.reason === 'ONLY_USER_INSTANCES', choice.reason)
  check('chooseInstance：用户 pid 仍被如实列在 userPids（可观测）', JSON.stringify(choice.userPids) === `[${userPid}]`, choice.userPids)

  // 关键回归：旧实现里 shared 会「最空的那个」= 唯一那个 = 用户实例。
  const sharedChoice = chooseInstance({ instances: [userInstance], clientId: 'mcp:24228', clientPid: new Map(), policy: 'shared' })
  check('chooseInstance：shared 也不分配用户实例（旧实现必中用户 pid）',
    sharedChoice.pid === 0 && sharedChoice.needLaunch === true && sharedChoice.reason === 'ONLY_USER_INSTANCES',
    { pid: sharedChoice.pid, reason: sharedChoice.reason })

  // 显式逃生口：adopt-user 策略才允许，且必须打 WARN。
  const logs = []
  const adopted = chooseInstance({
    instances: [userInstance],
    clientId: 'mcp:24228',
    clientPid: new Map(),
    policy: 'adopt-user',
    log: (line) => logs.push(String(line)),
  })
  check('chooseInstance：adopt-user 显式策略下才把用户实例分出去', adopted.pid === userPid, adopted.pid)
  check('chooseInstance：adopt-user 时打 WARN adopting user instance pid=...',
    logs.some((line) => line.includes('WARN adopting user instance pid=' + userPid)), logs)
  check('chooseInstance：adopt-user 返回体标 adoptedUser', adopted.adoptedUser === true, adopted.adoptedUser)

  // 显式 instancePid 点名用户实例：允许，但必须留 WARN（不再静默）。
  const explicitLogs = []
  const explicit = chooseInstance({
    instances: [userInstance],
    requested: userPid,
    clientId: 'mcp:24228',
    clientPid: new Map(),
    log: (line) => explicitLogs.push(String(line)),
  })
  check('chooseInstance：显式 instancePid 点名用户实例被允许且标 adoptedUser',
    explicit.pid === userPid && explicit.requested === true && explicit.adoptedUser === true, explicit)
  check('chooseInstance：显式点名用户实例也打 WARN',
    explicitLogs.some((line) => line.includes('WARN adopting user instance pid=' + userPid)), explicitLogs)

  // 有 broker 实例可用时：用户实例依然不会被选中，即使它「更空」。
  const mixed = chooseInstance({
    instances: [userInstance, brokerInstance(5000, { ownerClients: ['mcp:24228'] })],
    clientId: 'mcp:49160',
    clientPid: new Map(),
    load: (pid) => (pid === userPid ? 0 : 9),
    policy: 'isolated',
    maxInstances: 2,
  })
  check('chooseInstance：有别人的实例时宁可不分配，也不落到用户实例',
    mixed.pid === 0 && mixed.needLaunch === true && mixed.reason === 'ONLY_USER_INSTANCES', mixed)
}

// ============================================ B. ensure 端到端：起自己的实例
async function fakeManager({ rot = [], env = {} } = {}) {
  const clock = { t: 1_000_000 }
  const workers = new Map()
  const logs = []
  const launches = { count: 0 }
  const file = tempFile()
  const workerFor = (pid) => {
    let worker = workers.get(pid)
    if (!worker) {
      worker = {
        describe: () => ({ instancePid: pid, pid: 900000 + Number(pid), pending: 0, active: 0, closed: false }),
        request: async () => ({ ok: true, op: 'version' }),
        stop: () => { },
      }
      workers.set(pid, worker)
    }
    return worker
  }
  const manager = new InstanceManager({
    file,
    env,
    probe: async () => ({ instances: rot.slice(), activePid: rot[0]?.pid ?? null }),
    launch: () => {
      launches.count += 1
      rot.push({ pid: 600 + launches.count, startedAt: new Date(clock.t).toISOString(), launchedBy: 'broker' })
      return { launched: true, target: 'fake-sldworks.exe' }
    },
    workers,
    workerLastUsed: new Map(),
    clientPid: new Map(),
    workerFor,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms },
    pollMs: 100,
    launchWaitMs: 5_000,
    minWarm: 1,
    log: (message) => { logs.push(String(message)) },
  })
  return { manager, launches, rot, clock, logs, file }
}

{
  // 真机复现：ROT 只有用户实例 41452，两个会话都要工作。
  const { manager, launches, logs } = await fakeManager({ rot: [{ ...userInstance }] })
  const first = await manager.ensure({ clientId: 'mcp:24228', timeoutMs: 30_000 })
  check('ensure：ROT 只有用户实例时给会话起一个专属实例',
    first.chosenPid > 0 && first.chosenPid !== userPid, { chosenPid: first.chosenPid, userPid })
  check('ensure：启动计数 1（不是复用用户实例）', launches.count === 1, launches.count)
  check('ensure：日志写明「只有用户实例，不分配」',
    logs.some((line) => line.includes('只有用户实例')), logs.filter((line) => line.includes('affinity')))
  check('ensure：返回体标 affinityReason / adoptedUser',
    first.affinityReason !== 'EXPLICIT_ADOPT' && first.adoptedUser === false,
    { reason: first.affinityReason, adoptedUser: first.adoptedUser })

  const second = await manager.ensure({ clientId: 'mcp:49160', timeoutMs: 30_000 })
  check('ensure：第二个会话拿到的不是用户 pid，也不是第一个会话的 pid',
    second.chosenPid > 0 && second.chosenPid !== userPid && second.chosenPid !== first.chosenPid,
    { first: first.chosenPid, second: second.chosenPid })

  const registry = readInstances(manager.file).instances
  const userEntry = registry.find((entry) => entry.pid === userPid)
  check('ensure：用户实例在登记表里保持 launchedBy="user"，没被绑会话',
    userEntry?.launchedBy === 'user' && (userEntry?.ownerClients ?? []).length === 0, userEntry)
  check('ensure：用户实例没有被记成 broker 起的（不会因此被回收）',
    registry.every((entry) => entry.pid === userPid ? entry.launchedBy === 'user' : entry.launchedBy === 'broker'),
    registry.map((entry) => ({ pid: entry.pid, launchedBy: entry.launchedBy })))
}

// ============================================ C. 观测口径：instances / bound
{
  const { manager } = await fakeManager({ rot: [{ ...userInstance }] })
  // 手工登记实例（不起进程）：用户实例干净（没被绑），一个 broker 实例被 sess-a 占着，
  // 另一个 broker 实例空着可分配。
  writeInstances(manager.file, [
    normalizeEntry({ ...userInstance, ownerClients: [] }),
    normalizeEntry({ pid: 5000, launchedBy: 'broker', ownerClients: ['mcp:24228'], workerStarted: true }),
    normalizeEntry({ pid: 5001, launchedBy: 'broker', ownerClients: [], workerStarted: true }),
  ])
  manager.clientPid.set('mcp:24228', 5000)
  // list() 只报 ROT 里的实例；把三个都塞进探针。
  manager.probe = async () => ({
    instances: [
      { ...userInstance, ownerClients: [] },
      { pid: 5000, launchedBy: 'broker', startedAt: new Date(1_000_000).toISOString() },
      { pid: 5001, launchedBy: 'broker', startedAt: new Date(1_000_000).toISOString() },
    ],
    activePid: userPid,
  })
  const listed = await manager.list()
  check('list：返回体带 affinityPolicy', listed.affinityPolicy === manager.policy, listed.affinityPolicy)
  check('list：userPids 只列用户实例', JSON.stringify(listed.userPids) === `[${userPid}]`, listed.userPids)
  check('list：boundPids 只列被会话占着的实例（5000）', JSON.stringify(listed.boundPids) === '[5000]', listed.boundPids)
  check('list：unboundPids 是用户实例与空着的 broker 实例',
    listed.unboundPids.includes(userPid) && listed.unboundPids.includes(5001) && !listed.unboundPids.includes(5000),
    listed.unboundPids)
  const userRow = listed.instances.find((item) => item.pid === userPid)
  const busyRow = listed.instances.find((item) => item.pid === 5000)
  const freeRow = listed.instances.find((item) => item.pid === 5001)
  check('list：用户实例行 isUser=true 且 assignable=false',
    userRow?.isUser === true && userRow?.assignable === false, userRow)
  check('list：被占满的 broker 实例 assignable=false（新会话拿不到）',
    busyRow?.isUser === false && busyRow?.assignable === false, busyRow)
  check('list：空着的 broker 实例 assignable=true', freeRow?.isUser === false && freeRow?.assignable === true, freeRow)
  check('list：旧字段 policy/maxInstances 仍在（不破坏既有调用方）',
    typeof listed.policy === 'string' && Number(listed.maxInstances) >= 1, { policy: listed.policy, maxInstances: listed.maxInstances })

  const bound = await manager.bound({ clientId: 'mcp:24228' })
  check('bound：pid 与 boundPid 是同一个事实', bound.pid === 5000 && bound.boundPid === 5000, { pid: bound.pid, boundPid: bound.boundPid })
  check('bound：带 affinityPolicy 与 assignable', bound.affinityPolicy === manager.policy && bound.assignable === true,
    { affinityPolicy: bound.affinityPolicy, assignable: bound.assignable })
}

{
  // 真机脏数据：用户实例的 ownerClients 里挂着两个会话。观测口径必须把它标出来
  // （isUser=true + bound=true），否则「AI 被绑到用户窗口」在清单里看不出来。
  const { manager } = await fakeManager({ rot: [{ ...userInstance }] })
  writeInstances(manager.file, [normalizeEntry({ ...userInstance })])
  manager.probe = async () => ({ instances: [{ ...userInstance }], activePid: userPid })
  const listed = await manager.list()
  const row = listed.instances.find((item) => item.pid === userPid)
  check('list：被会话占着的用户实例同时出现在 userPids 与 boundPids（bug 现场可见）',
    listed.userPids.includes(userPid) && listed.boundPids.includes(userPid), { userPids: listed.userPids, boundPids: listed.boundPids })
  check('list：该行 isUser=true / bound=true / assignable=false',
    row?.isUser === true && row?.bound === true && row?.assignable === false, row)
}

// ============================================ C2. boundPidForSession（B5 的数据面）
{
  const file = tempFile()
  writeInstances(file, [
    normalizeEntry({ ...userInstance, lastUsedAt: '2026-11-14T12:00:00.000Z' }),
    normalizeEntry({ pid: 5000, launchedBy: 'broker', ownerClients: ['mcp:24228'], lastUsedAt: '2026-11-14T11:00:00.000Z' }),
  ])
  check('boundPidForSession：返回会话绑定的 broker 实例 pid',
    boundPidForSession('mcp:24228', { file, requireAlive: false }) === 5000,
    boundPidForSession('mcp:24228', { file, requireAlive: false }))
  check('boundPidForSession：没有绑定时返回 0',
    boundPidForSession('mcp:99999', { file, requireAlive: false }) === 0)
  check('boundPidForSession：用户实例永远不返回（即使登记表把它挂到会话上）',
    boundPidForSession('mcp:49160', { file, requireAlive: false }) === 0,
    boundPidForSession('mcp:49160', { file, requireAlive: false }))
}

// ============================================ C3. session-id.mjs 的默认口径（B2 的第二个落点）
//
// 只在 affinity.mjs 改默认值是不够的：session-id.mjs 把 policy 显式铺进每个 broker
// 请求（server.mjs 的 ...instanceRequestParams()），broker 按「显式参数 > env」执行。
// 所以这里用真实子进程读 SW_INSTANCE_POLICY，验证三个分支。
{
  // 必须是仓库根（不是 test/）：探针脚本用 ./server/session-id.mjs 相对 root 解析。
  const repoRoot = repo
  const probe = ['--input-type=module', '-e',
    'import { SW_INSTANCE_POLICY, SW_MAX_INSTANCES } from "./server/session-id.mjs";'
    + 'process.stdout.write(JSON.stringify({ policy: SW_INSTANCE_POLICY, max: SW_MAX_INSTANCES }))']
  const baseEnv = { ...process.env }
  delete baseEnv.SW_MCP_INSTANCE_POLICY
  delete baseEnv.SW_MCP_MAX_INSTANCES
  const readWiring = (extra) => {
    const text = execFileSync(process.execPath, probe, {
      cwd: repoRoot,
      env: { ...baseEnv, ...extra },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(text)
  }
  const noEnv = readWiring({})
  check('session-id：没有 env 时 SW_INSTANCE_POLICY=isolated（默认改了）',
    noEnv.policy === 'isolated', noEnv)
  check('session-id：没有 env 时 SW_MAX_INSTANCES=2（isolated 的默认上限，不是 undefined）',
    noEnv.max === 2, noEnv.max)
  const shared = readWiring({ SW_MCP_INSTANCE_POLICY: 'shared' })
  check('session-id：显式 shared 照办（同一实例全会话共用，紧急回退手段）',
    shared.policy === 'shared' && shared.max === 1, shared)
  const adopt = readWiring({ SW_MCP_INSTANCE_POLICY: 'adopt-user' })
  check('session-id：显式 adopt-user 照办', adopt.policy === 'adopt-user', adopt)
  const bogus = readWiring({ SW_MCP_INSTANCE_POLICY: 'weird' })
  check('session-id：非法值归一回 isolated（不是 shared）', bogus.policy === 'isolated', bogus)
  const source = readSource('server/session-id.mjs')
  check('session-id：策略来自 affinity.instancePolicy(process.env)（不再自己写三元表达式）',
    source.includes('instancePolicy(process.env)'))
  // instancePolicy 是纯函数：不抛异常、不吃全局状态（只在没传 env 时才默认 process.env）。
  const noThrow = []
  for (const env of [{}, { SW_MCP_INSTANCE_POLICY: null }, { SW_MCP_INSTANCE_POLICY: 123 }, { SW_MCP_INSTANCE_POLICY: '  ISOLATED  ' }]) {
    try { noThrow.push(instancePolicy(env)) } catch { noThrow.push('THREW') }
  }
  check('instancePolicy：怪输入不抛异常且归一化（null/数字/带空格）',
    noThrow[0] === 'isolated' && noThrow[1] === 'isolated' && noThrow[2] === 'isolated' && noThrow[3] === 'isolated', noThrow)
}

// ============================================ D. SwLock：每实例一把锁
{
  const source = readSource('bridge/src/SwLock.cs')
  // 与 C# 一一对应的名字生成规则（改任何一边这条断言都会响）。
  const mutexNameFor = (pid) => (pid > 0 ? `Local\\sw-mcp-solidworks-${pid}` : 'Local\\sw-mcp-solidworks')
  check('锁名：绑定 pid 时带 pid', mutexNameFor(userPid) === `Local\\sw-mcp-solidworks-${userPid}`, mutexNameFor(userPid))
  check('锁名：不同实例的锁名不同', mutexNameFor(userPid) !== mutexNameFor(5000))
  check('锁名：未绑定 pid 时退回旧全局名', mutexNameFor(0) === 'Local\\sw-mcp-solidworks')
  check('SwLock.cs：新前缀 Local\\\\sw-mcp-solidworks- 存在',
    source.includes('Local\\\\sw-mcp-solidworks-'), 'missing per-pid prefix')
  check('SwLock.cs：旧全局名仍保留（老 broker 还在用它）',
    /LegacyMutexName\s*=\s*"Local\\\\sw-mcp-solidworks"/.test(source) && source.includes('MutexNameFor'))
  check('SwLock.cs：旧名只出现在未绑定分支',
    /pid\s*>\s*0\s*\?\s*Prefix\s*\+\s*pid\.ToString\(\)\s*:\s*LegacyMutexName/.test(source))
  check('SwLock.cs：返回/诊断里带 lockScope（global|instance）',
    source.includes('lockScope') && source.includes('"global"') && source.includes('"instance"'))
  check('SwLock.cs：锁按 SwHost.ExpectedPid 而不是进程全局一把',
    source.includes('SwHost.ExpectedPid'))
}

// ============================================ E. SwHost.cs 静态断言（B4 的核心）
{
  const host = readSource('bridge/src/SwHost.cs')
  const rot = readSource('bridge/src/Rot.cs')
  // 只数真正的调用（Marshal.GetActiveObject(...)）；注释里提到这个名字不算。
  const occurrences = host.match(/Marshal\.GetActiveObject\s*\(/g) ?? []
  check('SwHost.cs：Marshal.GetActiveObject 调用只剩 1 处（旧实现是「主路径 + 兜底」两处）',
    occurrences.length === 1, occurrences.length)
  const declIndex = host.indexOf('void AttachActiveObject()')
  const nextIndex = host.indexOf('int RequireProcessId(', declIndex)
  const useIndex = host.indexOf('Marshal.GetActiveObject')
  check('SwHost.cs：GetActiveObject 位于 AttachActiveObject 方法体内（ExpectedPid==0 分支）',
    declIndex >= 0 && nextIndex > declIndex && useIndex > declIndex && useIndex < nextIndex,
    { declIndex, nextIndex, useIndex })
  check('SwHost.cs：ExpectedPid != 0 走 AttachBound，else 走 AttachUnbound（没有中途回退）',
    /if\s*\(ExpectedPid\s*!=\s*0\)\s*AttachBound\(ExpectedPid\);\s*else\s*AttachUnbound\(\);/.test(host))
  // R12：后门收口。未绑定实例默认必须 fail-closed，只有显式设
  // SW_MCP_ALLOW_ACTIVE_OBJECT=1 才允许旧的「跟随前台」，且那条路要留审计日志。
  check('SwHost.cs：未绑定实例 fail-closed 抛 INSTANCE_NOT_BOUND',
    host.includes('INSTANCE_NOT_BOUND') && /void\s+AttachUnbound\s*\(/.test(host))
  check('SwHost.cs：逃生阀只认 SW_MCP_ALLOW_ACTIVE_OBJECT=1',
    host.includes('SW_MCP_ALLOW_ACTIVE_OBJECT') && /StringComparison\.Ordinal/.test(host))
  check('SwHost.cs：放行路径写 expectedPid 与 attachedPid 审计行',
    host.includes('ALLOWED_ACTIVE_OBJECT_ATTACH') && /"attachedPid"/.test(host) && /"expectedPid",\s*0/.test(host))
  check('SwHost.cs：--no-attach 下 Attach 直接拒绝、不碰 COM',
    /public\s+static\s+bool\s+NoAttach/.test(host) && /if\s*\(NoAttach\)/.test(host))
  check('SwHost.cs：绑定路径只走 ROT（AttachBound 里调用 Rot.LookupByPid）',
    host.includes('Rot.LookupByPid(pid)'))
  check('SwHost.cs：取不到实例时抛 lookup.Code（INSTANCE_GONE / INSTANCE_NOT_IN_ROT）',
    host.includes('lookup.Code') && host.includes('INSTANCE_GONE'))
  check('Rot.cs：明确区分 INSTANCE_GONE 与 INSTANCE_NOT_IN_ROT',
    rot.includes('"INSTANCE_GONE"') && rot.includes('"INSTANCE_NOT_IN_ROT"'))
  check('SwHost.cs：还存在 INSTANCE_MISMATCH 校验', host.includes('INSTANCE_MISMATCH'))
  check('SwHost.cs：GetProcessID 异常不再被吞成 pid=0（旧 bug）',
    !/try\s*\{\s*pid\s*=\s*App\.GetProcessID\(\);\s*\}\s*catch\s*\(COMException\)\s*\{\s*\}/.test(host)
      && host.includes('ATTACH_UNVERIFIED'))
  check('SwHost.cs：ExpectedPid==0 路径记下 AttachedPid/AttachedBy',
    host.includes('AttachedPid') && host.includes('"active-object"') && host.includes('MarkAttached'))
  check('SwHost.cs：跟随前台会写 WARN 日志到 <data>\\logs\\mcp-*.jsonl',
    host.includes('ATTACHED_BY_ACTIVE_OBJECT') && host.includes('"logs"') && /mcp-/.test(host))
  check('SwHost.cs：对外暴露 Attachment()（attachedPid/attachedBy）',
    host.includes('Attachment()') && host.includes('"attachedPid"') && host.includes('"attachedBy"'))
}

// 清理
for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
