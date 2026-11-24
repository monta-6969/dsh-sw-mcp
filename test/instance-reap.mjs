// 实例登记表、回收与「只杀自己启动的 SW」的契约测试。
//
// 全部是 mock/registry 级：不启动 broker、不启动 SOLIDWORKS、不跑 powershell 快照，
// 所以可以在任何机器上跑。真正对着 live SW 的验收交给 T5。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readInstances,
  removeEntry,
  updateInstances,
  upsertEntry,
  defaultInstancesFile,
  InstanceManager,
} from '../server/broker/instances.mjs'
import { CLIENT_SCOPED_METHODS, requestClientId } from '../server/broker/protocol.mjs'
import { killOwned, reapTestInstances, selectOwnedTargets } from './lib/sw.mjs'

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

const tempDirs = []
function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-reap-'))
  tempDirs.push(dir)
  return join(dir, 'instances.json')
}
const entryOf = (file, pid) => readInstances(file).instances.find((entry) => entry.pid === pid) ?? null
const seed = (file, entries, now) => updateInstances(file, (list) => {
  for (const entry of entries) upsertEntry(list, entry)
  return list
}, { now })

// ------------------------------------------------------ instances.json 登记表
{
  const file = tempFile()
  seed(file, [{ pid: 101, startedAt: '2026-01-01T00:00:00.000Z', launchedBy: 'broker', tag: 'service', ownerClients: ['a'] }], Date.now())
  check('登记表：upsert 后能读回实例', entryOf(file, 101)?.launchedBy === 'broker', entryOf(file, 101))
  check('登记表：文件带 version', readInstances(file).version === 1, readInstances(file).version)

  // 同一个 pid 换了 creationDate = pid 被系统复用：整条替换，不能沿用旧会话。
  seed(file, [{ pid: 101, startedAt: '2026-02-02T00:00:00.000Z', launchedBy: 'test', tag: 'test', ownerClients: [] }], Date.now())
  const reused = entryOf(file, 101)
  check('登记表：pid 复用（startedAt 不同）时整条替换', reused?.launchedBy === 'test' && reused?.ownerClients.length === 0, reused)

  seed(file, [{ pid: 101, startedAt: '2026-02-02T00:00:00.000Z', launchedBy: 'test', tag: 'test', ownerClients: ['b'] }], Date.now())
  check('登记表：同一实例追加 ownerClient', entryOf(file, 101)?.ownerClients.includes('b'), entryOf(file, 101)?.ownerClients)

  updateInstances(file, (list) => removeEntry(list, 101), { now: Date.now() })
  check('登记表：removeEntry 真的删掉', entryOf(file, 101) === null)

  writeFileSync(file, '{ 这不是 JSON', 'utf8')
  check('登记表：坏文件当空表处理，不炸', readInstances(file).instances.length === 0, readInstances(file).instances)
}

{
  const file = tempFile()
  check('登记表：SW_MCP_INSTANCES_FILE 覆盖默认路径',
    defaultInstancesFile({ SW_MCP_INSTANCES_FILE: 'D:\\tmp\\x.json' }) === 'D:\\tmp\\x.json',
    defaultInstancesFile({ SW_MCP_INSTANCES_FILE: 'D:\\tmp\\x.json' }))
  check('登记表：默认路径在 %LOCALAPPDATA%\\sw-mcp 下',
    /sw-mcp[\\/]instances\.json$/i.test(defaultInstancesFile({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })),
    defaultInstancesFile({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }))
  void file
}

// ------------------------------------------------------------ 回收用的 manager
const T0 = Date.parse('2026-01-01T00:00:00.000Z')
function makeManager({ rot = [], entries = [], alive = null, pending = {}, clientPid = [] } = {}) {
  const clock = { t: T0 }
  const file = tempFile()
  const live = new Set(alive ?? rot.map((instance) => Number(instance.pid)))
  const calls = { cleanup: [], quit: [], stopProcess: [], stopWorker: [], warm: [] }
  const workers = new Map()
  for (const instance of rot) {
    const pid = Number(instance.pid)
    workers.set(pid, {
      describe: () => ({ instancePid: pid, pid: 8000 + pid, pending: pending[pid] ?? 0, active: 0, closed: false }),
      request: async (op) => { calls.warm.push({ pid, op }); return { ok: true } },
      stop: () => { calls.stopWorker.push(pid) },
    })
  }
  const manager = new InstanceManager({
    file,
    env: {},
    probe: async () => ({ instances: rot.slice(), activePid: rot[0]?.pid ?? null }),
    workers,
    workerLastUsed: new Map(),
    clientPid: new Map(clientPid),
    cleanupWorker: async (pid) => { calls.cleanup.push(pid); return { closed: [{ name: 'a.SLDPRT' }] } },
    quitWorker: async (pid) => { calls.quit.push(pid); live.delete(Number(pid)) },
    stopProcess: async (pid) => { calls.stopProcess.push(pid); live.delete(Number(pid)); return true },
    stopWorker: (pid) => { calls.stopWorker.push(Number(pid)); return true },
    isAlive: (pid) => live.has(Number(pid)),
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms },
    pollMs: 10,
    quitGraceMs: 100,
    graceMs: 60_000,
    workerIdleMs: 60_000,
    minWarm: 1,
    log: () => {},
  })
  seed(file, entries, clock.t)
  return { manager, file, clock, calls, live, rot }
}

const oldIso = (clock, ms) => new Date(clock.t - ms).toISOString()
const brokerEntry = (clock, pid, extra = {}) => ({
  pid,
  startedAt: oldIso(clock, 3_600_000),
  launchedBy: 'broker',
  tag: 'service',
  ownerClients: [],
  lastSeen: oldIso(clock, 3_600_000),
  lastUsedAt: oldIso(clock, 3_600_000),
  workerStarted: true,
  ...extra,
})

// -------------------------------------------------------------- 用户实例不动
{
  const file = tempFile()
  const clock = { t: T0 }
  const { manager, calls } = makeManager({ rot: [{ pid: 201, startedAt: oldIso(clock, 7_200_000) }] })
  seed(manager.file, [{ ...brokerEntry(clock, 201), launchedBy: 'user', tag: null }], clock.t)
  const result = await manager.reap({ reason: 'test' })
  check('reap：用户实例默认 skipped', result.skipped.some((item) => item.pid === 201 && item.reason === 'user-instance'), result.skipped)
  check('reap：skipped 里带 launchedBy', result.skipped.find((item) => item.pid === 201)?.launchedBy === 'user')
  check('reap：用户实例没被 cleanup/quit/杀', calls.cleanup.length === 0 && calls.quit.length === 0 && calls.stopProcess.length === 0, calls)
  check('reap：用户实例仍留在登记表', entryOf(manager.file, 201) !== null)

  const forced = await manager.reap({ force: true, reason: 'test-force' })
  check('reap force：用户实例才允许回收', forced.reaped.some((item) => item.pid === 201), forced.reaped)
  check('reap force：走的是 cleanup→quit 温和路径', calls.cleanup.includes(201) && calls.quit.includes(201), calls)
  check('reap force：登记表条目被删', entryOf(manager.file, 201) === null)
  void file
}

{
  const clock = { t: T0 }
  const { manager, calls } = makeManager({
    rot: [{ pid: 301, startedAt: oldIso(clock, 3_600_000) }],
    entries: [brokerEntry(clock, 301)],
    clientPid: [['sess-a', 301]],
  })
  const result = await manager.reap({ reason: 'test' })
  check('reap：有会话绑定的实例默认 skipped', result.skipped.some((item) => item.pid === 301 && item.reason === 'client-attached'), result.skipped)
  check('reap：skip 时列出绑定的会话', result.skipped.find((item) => item.pid === 301)?.clients?.includes('sess-a'))
  check('reap：有会话绑定时不动进程', calls.quit.length === 0, calls)

  const forced = await manager.reap({ force: true, reason: 'test-force' })
  check('reap force：有绑定的实例也可强制回收', forced.reaped.some((item) => item.pid === 301), forced.reaped)
  check('reap force：绑定被清掉', manager.clientPid.size === 0, [...manager.clientPid])
}

// ------------------------------------------------------ tag=test 立刻回收（不等空闲）
{
  const clock = { t: T0 }
  const { manager, calls } = makeManager({
    rot: [{ pid: 401, startedAt: new Date(clock.t).toISOString() }],
  })
  seed(manager.file, [{
    pid: 401,
    startedAt: new Date(clock.t).toISOString(),
    launchedBy: 'test',
    tag: 'test',
    ownerClients: [],
    lastSeen: new Date(clock.t).toISOString(),
    lastUsedAt: new Date(clock.t).toISOString(),
  }], clock.t)
  const fresh = await manager.reap({ reason: 'test' })
  check('reap：刚用过、没给 tag 的实例按 idle 规则 skipped', fresh.skipped.some((item) => item.pid === 401), fresh.skipped)
  const tagged = await manager.reap({ tag: 'test', reason: 'test-suite-cleanup' })
  check('reap tag=test：不等 idle，立刻回收', tagged.reaped.some((item) => item.pid === 401), tagged.reaped)
  check('reap tag=test：cleanup/quit 都被调用', calls.cleanup.includes(401) && calls.quit.includes(401), calls)
  check('reap tag=test：登记表条目被删', entryOf(manager.file, 401) === null)
  check('reap tag=test：返回的 reaped 带 quit=true', tagged.reaped.find((item) => item.pid === 401)?.quit === true, tagged.reaped)
}

{
  const clock = { t: T0 }
  const { manager } = makeManager({ rot: [{ pid: 501, startedAt: oldIso(clock, 3_600_000) }] })
  seed(manager.file, [brokerEntry(clock, 501, { tag: 'test' })], clock.t)
  const other = await manager.reap({ tag: 'service', reason: 'test' })
  check('reap tag 不匹配：跳过而不是回收', other.skipped.some((item) => item.pid === 501 && item.reason === 'tag-mismatch'), other.skipped)
  check('reap tag 不匹配：登记表不动', entryOf(manager.file, 501) !== null)
}

// ------------------------------------------------------------------ dry-run 不落手
{
  const clock = { t: T0 }
  const { manager, calls } = makeManager({ rot: [{ pid: 601, startedAt: oldIso(clock, 3_600_000) }] })
  seed(manager.file, [brokerEntry(clock, 601, { tag: 'test' })], clock.t)
  const preview = await manager.reap({ tag: 'test', dryRun: true })
  check('reap dryRun：列出将被回收的实例', preview.reaped.some((item) => item.pid === 601 && item.dryRun === true), preview.reaped)
  check('reap dryRun：不动进程也不动登记表', calls.cleanup.length === 0 && calls.quit.length === 0 && entryOf(manager.file, 601) !== null, calls)
}

// ------------------------------------------------------------ busy（worker 有活）
{
  const clock = { t: T0 }
  const { manager, calls } = makeManager({
    rot: [{ pid: 701, startedAt: oldIso(clock, 3_600_000) }],
    pending: { 701: 2 },
  })
  seed(manager.file, [brokerEntry(clock, 701, { tag: 'test' })], clock.t)
  const busy = await manager.reap({ tag: 'test', reason: 'test' })
  check('reap：worker 有请求排队时 skipped busy', busy.skipped.some((item) => item.pid === 701 && item.reason === 'busy'), busy.skipped)
  check('reap：busy 时不 quit', calls.quit.length === 0, calls)
  const forced = await manager.reap({ tag: 'test', force: true, reason: 'test-force' })
  check('reap force：busy 也能强制回收', forced.reaped.some((item) => item.pid === 701), forced.reaped)
}

// ------------------------------------------- 只回收登记表里的 pid（ROT 里的别人不动）
{
  const clock = { t: T0 }
  const { manager, calls } = makeManager({
    rot: [
      { pid: 801, startedAt: oldIso(clock, 3_600_000) },
      { pid: 802, startedAt: oldIso(clock, 3_600_000) },
    ],
  })
  seed(manager.file, [brokerEntry(clock, 801, { tag: 'test' })], clock.t)
  await manager.reap({ tag: 'test', reason: 'test' })
  check('reap：ROT 里没登记的实例一个都不碰', calls.cleanup.includes(801) && !calls.cleanup.includes(802), calls)
  check('reap：没登记的用户实例原样活着', !calls.stopProcess.includes(802) && entryOf(manager.file, 802) === null, calls)
}

// -------------------------------------------------------------------- quit 契约
{
  const clock = { t: T0 }
  const { manager, calls } = makeManager({
    rot: [{ pid: 901, startedAt: oldIso(clock, 3_600_000) }],
    clientPid: [['sess-u', 901]],
  })
  let noBinding = null
  try { await manager.quit({}) } catch (error) { noBinding = error }
  check('quit：没有绑定也没有 pid → NO_BOUND_INSTANCE', noBinding?.code === 'NO_BOUND_INSTANCE', noBinding?.code)

  seed(manager.file, [{ ...brokerEntry(clock, 901), launchedBy: 'user', tag: null }], clock.t)
  let refused = null
  try { await manager.quit({ clientId: 'sess-u' }) } catch (error) { refused = error }
  check('quit：用户实例非 force → USER_INSTANCE_REFUSED', refused?.code === 'USER_INSTANCE_REFUSED', refused?.code)
  check('quit：拒绝时带 pid/launchedBy 方便调用方提示', refused?.details?.launchedBy === 'user', refused?.details)
  check('quit：拒绝后进程没动', calls.quit.length === 0, calls)

  const owned = await manager.quit({ pid: 901, force: true })
  check('quit force：能把用户实例关掉', owned.quit === true && owned.pid === 901, owned)
  check('quit：走 cleanup 收回文档', owned.closedDocs === 1, owned)
  check('quit：登记表条目被删', entryOf(manager.file, 901) === null)

  const gone = await manager.quit({ pid: 999, force: true })
  check('quit：已经不存在的 pid 返回 quit=false 而不是报错', gone.quit === false && gone.pid === 999, gone)
}

// ------------------------------------------------------------- maintenance 清理
{
  const clock = { t: T0 }
  const { manager, calls } = makeManager({ rot: [] })
  seed(manager.file, [brokerEntry(clock, 1001)], clock.t)
  // 登记表里有、ROT 里没有、进程也已经不在 → 直接清成交警，不能当实例回收。
  const result = await manager.maintenance({})
  check('maintenance：清掉残留登记条目', result.removedEntries >= 1 && entryOf(manager.file, 1001) === null, result.removedEntries)
  check('maintenance：孤儿 worker 停掉并计数', calls.stopWorker.includes(1001) && result.orphanWorkers >= 1, { calls: calls.stopWorker, counters: result })
  check('maintenance：返回 at 时间戳', typeof result.at === 'string' && result.at.length > 0, result.at)
}

{
  const clock = { t: T0 }
  const { manager, calls } = makeManager({
    rot: [
      { pid: 1101, startedAt: oldIso(clock, 3_600_000) },
      { pid: 1102, startedAt: oldIso(clock, 3_600_000) },
    ],
  })
  manager.workerLastUsed.set(1101, clock.t)
  manager.workerLastUsed.set(1102, clock.t - 3_600_000)
  // 两个实例都登记成用户实例：让后面的 reap 跳过它们，只看「空闲 worker」这一段。
  seed(manager.file, [
    { ...brokerEntry(clock, 1101), launchedBy: 'user', tag: null },
    { ...brokerEntry(clock, 1102), launchedBy: 'user', tag: null },
  ], clock.t)
  const result = await manager.maintenance({ keepWarm: 1, workerIdleMs: 60_000 })
  check('maintenance：保留最近用过的 1 个 worker 温热', !calls.stopWorker.includes(1101), calls.stopWorker)
  check('maintenance：其余空闲 worker 停掉', calls.stopWorker.includes(1102), calls.stopWorker)
  check('maintenance：keptWarm 计数正确', result.keptWarm === 1, result.keptWarm)
}

{
  // 启动时收上周测试崩掉留下的 tag=test 实例。
  const clock = { t: T0 }
  const staleStart = new Date(clock.t - 20 * 60_000).toISOString()
  const { manager, calls } = makeManager({ rot: [{ pid: 1201, startedAt: staleStart }] })
  seed(manager.file, [{
    pid: 1201,
    startedAt: staleStart,
    launchedBy: 'test',
    tag: 'test',
    ownerClients: [],
    lastSeen: staleStart,
    lastUsedAt: staleStart,
    workerStarted: true,
  }], clock.t)
  const result = await manager.maintenance({ startup: true })
  check('maintenance startup：回收 10 分钟前的 tag=test 残留', calls.quit.includes(1201) && entryOf(manager.file, 1201) === null, calls)
  check('maintenance startup：reaped 标记 staleTest', result.reaped.some((item) => item.pid === 1201 && item.staleTest === true), result.reaped)
}

{
  // 刚起的 tag=test 实例不能因为 startup 就被收掉：可能另一个会话正在用。
  const clock = { t: T0 }
  const fresh = new Date(clock.t).toISOString()
  const { manager, calls } = makeManager({ rot: [{ pid: 1301, startedAt: fresh }] })
  seed(manager.file, [{
    pid: 1301,
    startedAt: fresh,
    launchedBy: 'test',
    tag: 'test',
    ownerClients: [],
    lastSeen: fresh,
    lastUsedAt: fresh,
    workerStarted: true,
  }], clock.t)
  const result = await manager.maintenance({ startup: true })
  check('maintenance startup：新鲜的 tag=test 不抢别人的正在测试的实例', !calls.quit.includes(1301), calls.quit)
  check('maintenance startup：按 idle 规则 skipped', result.skipped.some((item) => item.pid === 1301 && item.reason === 'not-idle'), result.skipped)
  check('maintenance startup：登记条目还在', entryOf(manager.file, 1301) !== null)
}

// ------------------------------------------- 测试 harness 只杀 owned（pid+CreationDate）
{
  const snapshot = [
    { pid: 1401, creationDate: '2026-01-01T00:00:00.000Z' },
    { pid: 1402, creationDate: '2026-02-02T00:00:00.000Z' },
    { pid: 1403, creationDate: null },
  ]
  const owned = [
    { pid: 1401, creationDate: '2026-01-01T00:00:00.000Z' },
    { pid: 1402, creationDate: '2026-01-01T00:00:00.000Z' },
    { pid: 1403, creationDate: null },
    { pid: 1404, creationDate: '2026-01-01T00:00:00.000Z' },
  ]
  const targets = selectOwnedTargets(snapshot, owned).map((entry) => entry.pid)
  check('killOwned：pid+CreationDate 都一致的才杀', targets.includes(1401), targets)
  check('killOwned：同一个 pid 但 CreationDate 变了（pid 复用）不杀', !targets.includes(1402), targets)
  check('killOwned：创建时间拿不到时不赌，宁可不杀', !targets.includes(1403), targets)
  check('killOwned：进程已经不在的不杀', !targets.includes(1404), targets)
  check('killOwned：只返回 owned 里的一条（不会顺手扩范围）', targets.length === 1, targets)

  const keep = killOwned({ owned, keep: true })
  check('killOwned KEEP_SW=1：只回报，不动手', keep.kept === true && keep.killed.length === 0, keep)
  check('killOwned KEEP_SW=1：owned 记录原样返回', keep.owned.length === owned.length, keep.owned.length)
  const empty = killOwned({ owned: [], keep: false })
  check('killOwned：没有 owned 时直接返回空', empty.killed.length === 0 && empty.kept === false, empty)
}

// ------------------------------------------------ 给 T2 的 workspace reap 契约
{
  const calls = []
  const brokerResult = { reaped: [{ pid: 1501 }], skipped: [], reason: 'suite-cleanup' }
  const result = await reapTestInstances(async (tool, args) => { calls.push({ tool, args }); return brokerResult })
  check('workspace reap：调用 workspace 工具', calls[0]?.tool === 'workspace', calls[0]?.tool)
  check('workspace reap：参数是 {action:reap,tag:test,includeDocs,dryRun}',
    calls[0]?.args?.action === 'reap' && calls[0]?.args?.tag === 'test' && calls[0]?.args?.includeDocs === true && calls[0]?.args?.dryRun === false,
    calls[0]?.args)
  check('workspace reap：broker 的返回原样透传', result.reaped?.[0]?.pid === 1501, result)
  await reapTestInstances(async (tool, args) => { calls.push({ tool, args }); return { ok: true } }, { includeDocs: false, dryRun: true })
  check('workspace reap：includeDocs/dryRun 可以显式关掉',
    calls[1]?.args?.includeDocs === false && calls[1]?.args?.dryRun === true, calls[1]?.args)
  check('workspace reap：tool 不是函数时降级为 skipped', (await reapTestInstances(null)).skipped === 'no-tool')
  const failed = await reapTestInstances(async () => { throw new Error('reap boom') })
  check('workspace reap：工具异常时带回 error 不炸测试', failed.error === 'reap boom', failed)
}

// ------------------------------------------------------ broker 协议：clientId 识别
{
  check('协议：instances.reap 属于会话级方法', CLIENT_SCOPED_METHODS.has('instances.reap'))
  check('协议：instances.quit 属于会话级方法', CLIENT_SCOPED_METHODS.has('instances.quit'))
  check('协议：instances.list 不需要 clientId', !CLIENT_SCOPED_METHODS.has('instances.list'))
  check('协议：requestClientId 取字符串 clientId', requestClientId({ clientId: 'mcp:123' }) === 'mcp:123')
  check('协议：requestClientId 无 clientId 时返回 null', requestClientId({}) === null)
  check('协议：requestClientId 忽略非字符串', requestClientId({ clientId: 42 }) === null)
}

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
