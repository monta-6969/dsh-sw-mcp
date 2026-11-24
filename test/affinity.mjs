// 会话→实例的绑定规则与 ensure 的排队规则：不启动 broker、不启动 SOLIDWORKS。
//
// 这是多会话不互相踩、又不会「异常打开多个 SOLIDWORKS」的根：
//   isolated（R11 起的默认）：不同会话不共用 pid，全被占就排队（busy），到上限不再新起；
//   shared：一个实例大家共用，只要 ROT 有可分配的实例就绝不返回 0；
//   adopt-user：显式逃生口，只有显式传它才允许把用户实例分配给会话。
// R11 新增一条硬规则：launchedBy="user" 的实例默认永远不分配（见 isolation-pid.mjs）。
// 最后两组用假 probe/launch 验 single-flight：并发 ensure 只允许启动一次。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chooseInstance,
  claimedPids,
  instanceOverrideFields,
  instancePolicy,
  maxInstancesFor,
  pickInstancePid,
  resolveInstanceOverrides,
} from '../server/broker/affinity.mjs'
import { InstanceManager } from '../server/broker/instances.mjs'

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

// R11：ROT 行必须带 launchedBy 才可分配；这里默认它们是 broker 起的（用户实例
// 的用例会显式覆盖成 'user'）。
const instances = (pids, launchedBy = 'broker') => pids.map((pid) => ({ pid, launchedBy }))
const userInstances = (pids) => instances(pids, 'user')
const loadOf = (table) => (pid) => table[pid] ?? 0

// ------------------------------------------------------- shared（默认策略）
{
  const clientPid = new Map()
  const a = chooseInstance({ instances: instances([101]), clientId: 'sess-a', clientPid, policy: 'shared' })
  const b = chooseInstance({ instances: instances([101]), clientId: 'sess-b', clientPid, policy: 'shared' })
  check('shared：两个会话拿到同一个实例', a.pid === 101 && b.pid === 101, { a: a.pid, b: b.pid })
  check('shared：只要 ROT 有实例就不返回 0', a.pid > 0 && b.pid > 0, { a: a.pid, b: b.pid })
  check('shared：绑定已落表', clientPid.get('sess-a') === 101 && clientPid.get('sess-b') === 101,
    Object.fromEntries(clientPid))
}

{
  const clientPid = new Map([['sess-a', 201]])
  // 即使另一个实例更空，shared 也必须回自己的实例。
  const again = chooseInstance({ instances: instances([201, 202]), clientId: 'sess-a', clientPid, load: loadOf({ 201: 9, 202: 0 }), policy: 'shared' })
  check('shared：同一会话固定回自己的实例', again.pid === 201, again.pid)
}

{
  const clientPid = new Map([['sess-a', 301]])
  // 原来那个实例没了：重新挑负载最低的，而不是返回 0 让调用方再起一个。
  const moved = chooseInstance({ instances: instances([302, 303]), clientId: 'sess-a', clientPid, load: loadOf({ 302: 5, 303: 1 }), policy: 'shared' })
  check('shared：原实例不在 ROT 时改挑负载最低的现有实例', moved.pid === 303, moved.pid)
  check('shared：重新认领后更新绑定', clientPid.get('sess-a') === 303, Object.fromEntries(clientPid))
}

{
  const choice = chooseInstance({ instances: [], clientId: 'sess-a', clientPid: new Map(), policy: 'shared' })
  check('shared：一个实例都没有时才要求启动', choice.pid === 0 && choice.needLaunch && !choice.busy, choice)
}

{
  // 没有 clientId 的探测调用只回答「哪个最空」，不落绑定。
  const clientPid = new Map()
  const pid = pickInstancePid({ instances: instances([401, 402]), clientId: null, clientPid, load: loadOf({ 401: 3, 402: 1 }), policy: 'shared' })
  check('没有 clientId 时按负载选最空', pid === 402, pid)
  check('没有 clientId 时不写绑定', clientPid.size === 0)
}

// ------------------------------------------------------------- isolated（独占）
{
  const clientPid = new Map()
  const a = chooseInstance({ instances: instances([501, 502]), clientId: 'sess-a', clientPid, policy: 'isolated', maxInstances: 2 })
  const b = chooseInstance({ instances: instances([501, 502]), clientId: 'sess-b', clientPid, policy: 'isolated', maxInstances: 2 })
  check('isolated：两个会话拿到不同 pid', a.pid !== b.pid && a.pid > 0 && b.pid > 0, { a: a.pid, b: b.pid })
  check('isolated：pid 都来自 ROT', [501, 502].includes(a.pid) && [501, 502].includes(b.pid), { a: a.pid, b: b.pid })
}

{
  const clientPid = new Map([['sess-a', 601], ['sess-b', 602]])
  const third = chooseInstance({ instances: instances([601, 602]), clientId: 'sess-c', clientPid, policy: 'isolated', maxInstances: 2 })
  check('isolated：实例都被占且到上限 → busy 排队', third.pid === 0 && third.busy === true && third.needLaunch === false, third)
  check('isolated：没有偷别的会话的绑定', clientPid.get('sess-a') === 601 && clientPid.get('sess-b') === 602,
    Object.fromEntries(clientPid))
}

{
  const clientPid = new Map([['sess-a', 701]])
  const second = chooseInstance({ instances: instances([701]), clientId: 'sess-b', clientPid, policy: 'isolated', maxInstances: 2 })
  check('isolated：没到上限时可以让 ensure 再起一个', second.pid === 0 && second.needLaunch === true && second.busy === false, second)
}

// ------------------------------------------------------------------ 上限与策略
{
  // R11：默认策略从 shared 改成 isolated（每次找/起一个专属实例）。
  check('默认策略是 isolated', instancePolicy({}) === 'isolated', instancePolicy({}))
  check('策略可以显式 isolated', instancePolicy({ SW_MCP_INSTANCE_POLICY: 'isolated' }) === 'isolated')
  check('策略可以显式 shared', instancePolicy({ SW_MCP_INSTANCE_POLICY: 'shared' }) === 'shared')
  check('策略可以显式 adopt-user（唯一允许用用户实例的口子）',
    instancePolicy({ SW_MCP_INSTANCE_POLICY: 'adopt-user' }) === 'adopt-user')
  check('坏策略值退回默认（isolated）', instancePolicy({ SW_MCP_INSTANCE_POLICY: 'weird' }) === 'isolated')
  check('shared 默认上限 1（不因为改默认策略而变）', maxInstancesFor('shared', {}) === 1)
  check('isolated 默认上限 2', maxInstancesFor('isolated', {}) === 2)
  check('SW_MCP_MAX_INSTANCES 覆盖默认上限', maxInstancesFor('shared', { SW_MCP_MAX_INSTANCES: '3' }) === 3)
  check('非法上限退回默认值', maxInstancesFor('isolated', { SW_MCP_MAX_INSTANCES: '0' }) === 2)
  const choice = chooseInstance({ instances: instances([801]), clientId: 'sess-a', clientPid: new Map(), policy: 'shared', maxInstances: 1 })
  check('shared 选了现有实例就不该再起', choice.pid === 801 && choice.needLaunch === false, choice)
}

// ------------------------------------------------------ 死会话的绑定要能释放
{
  const clientPid = new Map([['mcp:999999', 901]])
  const alive = (id) => id !== 'mcp:999999'
  const reused = chooseInstance({ instances: instances([901]), clientId: 'sess-new', clientPid, clientAlive: alive, policy: 'isolated', maxInstances: 2 })
  check('已退出会话占着的实例会被新会话复用', reused.pid === 901, reused.pid)
  check('死会话的绑定被清掉', !clientPid.has('mcp:999999'), Object.fromEntries(clientPid))
  check('claimedPids 只统计活着的会话', claimedPids(new Map([['mcp:999999', 901]]), null).has(901))
}

// ------------------------------------------ single-flight：并发 ensure 只起一次
const tempDirs = []
function fakeManager({ rot = [], launches = { count: 0 }, env = {} } = {}) {
  const clock = { t: 1_000_000 }
  const workers = new Map()
  const logs = []
  const dir = mkdtempSync(join(tmpdir(), 'sw-affinity-'))
  tempDirs.push(dir)
  const workerFor = (pid) => {
    let worker = workers.get(pid)
    if (!worker) {
      worker = {
        describe: () => ({ instancePid: pid, pid: 1000 + Number(pid), pending: 0, active: 0, closed: false }),
        request: async () => ({ ok: true, op: 'version' }),
        stop: () => { },
      }
      workers.set(pid, worker)
    }
    return worker
  }
  const manager = new InstanceManager({
    file: join(dir, 'instances.json'),
    env,
    probe: async () => ({ instances: rot.map((entry) => ({ launchedBy: 'broker', ...entry })), activePid: rot[0]?.pid ?? null }),
    launch: () => {
      launches.count += 1
      rot.push({ pid: 600 + launches.count, startedAt: new Date(clock.t).toISOString() })
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
  return { manager, launches, rot, clock, workers, logs }
}

{
  const { manager, launches } = fakeManager()
  const [a, b] = await Promise.all([
    manager.ensure({ clientId: 'race-a', policy: 'shared', timeoutMs: 60_000 }),
    manager.ensure({ clientId: 'race-b', policy: 'shared', timeoutMs: 60_000 }),
  ])
  check('single-flight：两个会话并发 ensure 只启动一次 SOLIDWORKS', launches.count === 1, launches.count)
  check('single-flight：两个会话都拿到同一个刚起的实例', a.chosenPid === b.chosenPid && a.chosenPid > 0,
    { a: a.chosenPid, b: b.chosenPid })
  check('single-flight：shared 下不会起第二个进程', launches.count === 1, launches.count)
}

{
  const { manager, launches } = fakeManager()
  const [first, second] = await Promise.all([
    manager.ensure({ clientId: 'same-client', policy: 'shared', timeoutMs: 60_000 }),
    manager.ensure({ clientId: 'same-client', policy: 'shared', timeoutMs: 60_000 }),
  ])
  check('single-flight：同一会话并发 ensure 合流成一次', first.chosenPid === second.chosenPid && launches.count === 1,
    { first: first.chosenPid, second: second.chosenPid, launches: launches.count })
}

{
  const { manager, launches } = fakeManager({ rot: [{ pid: 705, startedAt: '2026-01-01T00:00:00.000Z' }] })
  const ensured = await manager.ensure({ clientId: 'reuse', policy: 'shared', timeoutMs: 30_000 })
  check('shared ensure：ROT 已有实例时复用、不启动', ensured.chosenPid === 705 && launches.count === 0,
    { chosenPid: ensured.chosenPid, launches: launches.count })
}

{
  // isolated 到上限：排队返回 INSTANCE_BUSY，而不是又起一个进程。
  const { manager, launches } = fakeManager({ rot: [{ pid: 711, startedAt: '2026-01-01T00:00:00.000Z' }, { pid: 712, startedAt: '2026-01-01T00:00:00.000Z' }] })
  manager.clientPid.set('sess-a', 711)
  manager.clientPid.set('sess-b', 712)
  let busy = null
  try {
    await manager.ensure({ clientId: 'sess-c', policy: 'isolated', maxInstances: 2, timeoutMs: 5_000 })
  } catch (error) {
    busy = error
  }
  check('isolated 到上限：ensure 抛 INSTANCE_BUSY', busy?.code === 'INSTANCE_BUSY', busy?.code)
  check('isolated 到上限：带 retryAfterMs 让调用方排队', Number(busy?.details?.retryAfterMs) > 0, busy?.details)
  check('isolated 到上限：绝不启动新进程', launches.count === 0, launches.count)
}

{
  // isolated 没到上限：allow launch，并登记成 broker 实例。
  const { manager, launches } = fakeManager({ rot: [{ pid: 721, startedAt: '2026-01-01T00:00:00.000Z' }] })
  manager.clientPid.set('sess-a', 721)
  const ensured = await manager.ensure({ clientId: 'sess-b', policy: 'isolated', maxInstances: 2, timeoutMs: 30_000 })
  check('isolated 没到上限：起一个新实例给没实例的会话', launches.count === 1 && ensured.chosenPid > 0 && ensured.chosenPid !== 721,
    { launches: launches.count, chosenPid: ensured.chosenPid })
  check('isolated 起出来的实例登记为 broker 启动', ensured.launched?.entry?.launchedBy === 'broker',
    ensured.launched?.entry)
}

// ============================================ A：策略透传（显式参数 > env > broker）
{
  const none = resolveInstanceOverrides({}, {})
  check('覆盖解析：调用方 env 与显式参数都没设 → 一个都不传（由 broker env 决定）',
    none.policy === null && none.maxInstances === null && none.tag === null
      && none.source.policy === 'default' && none.source.maxInstances === 'default', none)
  const fromEnv = resolveInstanceOverrides({}, {
    SW_MCP_INSTANCE_POLICY: 'isolated', SW_MCP_MAX_INSTANCES: '3', SW_MCP_INSTANCE_TAG: 'multitest',
  })
  check('覆盖解析：调用方 env 的 isolated/3/multitest 被透传',
    fromEnv.policy === 'isolated' && fromEnv.maxInstances === 3 && fromEnv.tag === 'multitest'
      && fromEnv.source.policy === 'env' && fromEnv.source.maxInstances === 'env', fromEnv)
  const explicit = resolveInstanceOverrides({ policy: 'shared', maxInstances: 1, tag: 'mine' }, {
    SW_MCP_INSTANCE_POLICY: 'isolated', SW_MCP_MAX_INSTANCES: '3', SW_MCP_INSTANCE_TAG: 'multitest',
  })
  check('覆盖解析：显式参数优先于调用方 env',
    explicit.policy === 'shared' && explicit.maxInstances === 1 && explicit.tag === 'mine'
      && explicit.source.policy === 'param' && explicit.source.tag === 'param', explicit)
  const bad = resolveInstanceOverrides({ policy: 'weird', maxInstances: 0 }, { SW_MCP_INSTANCE_POLICY: 'isolated', SW_MCP_MAX_INSTANCES: '3' })
  check('覆盖解析：坏值当没传（坏策略不把 broker 的 isolated 退回 shared）',
    bad.policy === 'isolated' && bad.maxInstances === 3 && bad.source.policy === 'env', bad)
  const fields = instanceOverrideFields(fromEnv)
  check('请求字段：只带非空值（isolated/3/multitest 全带）',
    fields.policy === 'isolated' && fields.maxInstances === 3 && fields.tag === 'multitest', fields)
  check('请求字段：没设的项一个都不出现（不把「没设」覆盖成默认值）',
    Object.keys(instanceOverrideFields(none)).length === 0, instanceOverrideFields(none))
  check('请求字段：非法上限不落到请求里',
    instanceOverrideFields({ policy: 'isolated', maxInstances: 0 }).maxInstances === undefined,
    instanceOverrideFields({ policy: 'isolated', maxInstances: 0 }))
}

{
  // ensure 按请求覆盖：返回体与内部分配必须一致（真机缺陷 A 的正面用例）。
  const { manager, launches, logs } = fakeManager({
    env: { SW_MCP_INSTANCE_POLICY: 'shared', SW_MCP_MAX_INSTANCES: '1' },
    rot: [{ pid: 730, startedAt: '2026-01-01T00:00:00.000Z' }, { pid: 731, startedAt: '2026-01-01T00:00:00.000Z' }, { pid: 732, startedAt: '2026-01-01T00:00:00.000Z' }],
  })
  manager.clientPid.set('sess-a', 730)
  manager.clientPid.set('sess-b', 731)
  const ensured = await manager.ensure({
    clientId: 'sess-c', policy: 'isolated', maxInstances: 3, tag: 'multitest', timeoutMs: 30_000,
  })
  check('ensure 按请求覆盖：返回体回显 policy=isolated/maxInstances=3/tag=multitest',
    ensured.policy === 'isolated' && ensured.maxInstances === 3 && ensured.tag === 'multitest', {
      policy: ensured.policy, maxInstances: ensured.maxInstances, tag: ensured.tag,
    })
  check('ensure 返回体回显 instancePid（与 chosenPid 一致）',
    ensured.instancePid === ensured.chosenPid && ensured.chosenPid > 0,
    { instancePid: ensured.instancePid, chosenPid: ensured.chosenPid })
  check('ensure 内部分配真按 3 个上限：第三个会话拿到空闲实例 732、不新起进程',
    ensured.chosenPid === 732 && launches.count === 0, { chosenPid: ensured.chosenPid, launches: launches.count })
  check('ensure 返回体带覆盖来源（runtime override 可审计）',
    ensured.overrides?.overridden === true && ensured.overrides?.effective?.policy === 'isolated'
      && ensured.overrides?.effective?.maxInstances === 3, ensured.overrides)
  check('ensure 运行时覆盖写进 broker 日志',
    logs.some((line) => /实例策略按请求覆盖/.test(line) && /isolated/.test(line)), logs.filter((line) => /覆盖/.test(line)))
}

{
  // 不带参数：沿用 broker/环境变量里的策略。
  const { manager } = fakeManager({
    env: { SW_MCP_INSTANCE_POLICY: 'isolated', SW_MCP_MAX_INSTANCES: '3', SW_MCP_INSTANCE_TAG: 'envtag' },
    rot: [{ pid: 740, startedAt: '2026-01-01T00:00:00.000Z' }, { pid: 741, startedAt: '2026-01-01T00:00:00.000Z' }],
  })
  manager.clientPid.set('sess-x', 740)
  const ensured = await manager.ensure({ clientId: 'sess-y', timeoutMs: 30_000 })
  check('ensure 不带参数：沿用 env（isolated/3/envtag）并回显',
    ensured.policy === 'isolated' && ensured.maxInstances === 3 && ensured.tag === 'envtag'
      && ensured.chosenPid === 741, {
      policy: ensured.policy, maxInstances: ensured.maxInstances, tag: ensured.tag, chosenPid: ensured.chosenPid,
    })
  check('ensure 不带参数：没有运行时覆盖时不标 overridden',
    ensured.overrides?.overridden === false, ensured.overrides)
}

// 清理临时登记表目录
for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
