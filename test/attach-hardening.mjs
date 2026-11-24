// R12 离线验收：未绑定实例的桥接器必须 fail-closed，探针不得有 attach 意图。
//
// 守的是什么（2026-11-15 真机事实）：日志 mcp-20261115.jsonl 里有 136 条
// ATTACHED_BY_ACTIVE_OBJECT，全部写着 attachedPid=22076（用户自己开的实例），
// 来自 131 个不同的 SwBridge 进程，每分钟 2 次。触发链是
//   brokerd.mjs:1129 60s 定时器 → instances.mjs maintenance 探一次 + reap 再探一次
//   → brokerd.mjs:131 probeBridge spawn 裸 SwBridge.exe（无 --worker、无 --instance）
//   → SwHost.cs Connect 的 ExpectedPid==0 分支 → Marshal.GetActiveObject。
// 用户原话「你是不是抢了其他实例？」问的就是这条路。
//
// 本文件不需要 SOLIDWORKS、不启动 broker、不 attach、不杀任何进程：
//   A. 静态断言：C# 侧 fail-closed / 逃生阀 / --no-attach / 审计行都在；
//   B. 进程级断言：直接跑 SwBridge.exe，喂一行请求，看返回的 error code
//      —— 没有任何 COM 代码会被执行，因为拒绝发生在 GetActiveObject 之前；
//   C. 登记表断言：「只有用户实例」时探针一次都不许起，探针队列复用；
//   D. 源码断言：probe 命令行带 --no-attach、间隔 ≥10min 只定义一次。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InstanceManager, MAINTENANCE_INTERVAL_MS, defaultInstancesFile } from '../server/broker/instances.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..')
const readSource = (rel) => readFileSync(join(repo, rel), 'utf8')

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

// 每个用例一个独立临时目录，绝不碰真的 %LOCALAPPDATA%\sw-mcp\logs。
const tempDirs = []
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-attach-hardening-'))
  tempDirs.push(dir)
  return dir
}

// ================================================= A. C# 源代码静态断言
{
  const host = readSource('bridge/src/SwHost.cs')
  const program = readSource('bridge/src/Program.cs')
  const ops = readSource('bridge/src/Operations.cs')

  check('SwHost.cs：未绑定实例默认拒绝（INSTANCE_NOT_BOUND 在 AttachUnbound 里）',
    /void\s+AttachUnbound\s*\(/.test(host) && /if\s*\(!AllowActiveObject\(\)\)/.test(host)
      && host.includes('INSTANCE_NOT_BOUND'), 'AttachUnbound / INSTANCE_NOT_BOUND')

  // 关键顺序断言：抛错必须在 GetActiveObject 之前。否则「拒绝」只是表面文章。
  const guardIndex = host.indexOf('if (!AllowActiveObject())')
  const throwIndex = host.indexOf('INSTANCE_NOT_BOUND', guardIndex)
  const activeObjectIndex = host.indexOf('Marshal.GetActiveObject')
  // AttachActiveObject() 只许有一个调用点，且必须在 throw 之后（即只有逃生阀
  // 放行才走得到）。调用点前面必须紧挨着 WarnAllowedActiveObject 的审计行。
  const callSites = host.match(/AttachActiveObject\(\);/g) ?? []
  const callIndex = host.indexOf('AttachActiveObject();')
  const auditIndex = host.indexOf('WarnAllowedActiveObject(AttachedPid);')
  check('SwHost.cs：拒绝发生在 GetActiveObject 之前（顺序断言）',
    guardIndex >= 0 && throwIndex > guardIndex && throwIndex < activeObjectIndex
      && callSites.length === 1 && callIndex > throwIndex && auditIndex > callIndex,
    { guardIndex, throwIndex, activeObjectIndex, callIndex, auditIndex, callSites: callSites.length })

  check('SwHost.cs：逃生阀只认字面量 "1" 且用 Ordinal 比较',
    /SW_MCP_ALLOW_ACTIVE_OBJECT"\s*\)\s*,\s*"1"/.test(host) && /StringComparison\.Ordinal/.test(host))

  check('SwHost.cs：放行时写审计行，带 expectedPid 与 attachedPid',
    host.includes('ALLOWED_ACTIVE_OBJECT_ATTACH') && /"attachedPid",\s*attachedPid/.test(host)
      && /"expectedPid",\s*0/.test(host))

  check('SwHost.cs：NoAttach 哨兵存在且在 Connect 最前面就拒绝',
    /public\s+static\s+bool\s+NoAttach;/.test(host) && /if\s*\(NoAttach\)\s*\{/.test(host)
      && /attachMode",\s*"no-attach"/.test(host))

  check('Program.cs：解析 --no-attach，且与 --instance 互斥',
    program.includes("Array.IndexOf(args, \"--no-attach\")") && program.includes('mutually exclusive'))

  check('Operations.cs：--no-attach 时 instaces 走 attachFree（不 attach 取 activePid）',
    /SwHost\.NoAttach/.test(ops) && /"attachFree",\s*attachFree/.test(ops))

  // 潜在越界：EnsureDocument 必须在 LockFree 判断之后，否则带 document 的
  // status 会在用户实例上 ActivateDoc3。
  const lockFreeTest = ops.indexOf('Array.IndexOf(LockFree, op) < 0)\n                    {')
  const ensureIndex = ops.indexOf('EnsureDocument(h.App, req);')
  check('Operations.cs：EnsureDocument 在 LockFree 判断之后（不再切只读请求的文档）',
    lockFreeTest >= 0 && ensureIndex > lockFreeTest, { lockFreeTest, ensureIndex })
}

// ================================================= D. broker 侧源码断言
{
  const brokerd = readSource('server/broker/brokerd.mjs')
  const instances = readSource('server/broker/instances.mjs')
  const server = readSource('server/server.mjs')

  // probeBridge 的 spawn 命令里必须出现 --no-attach，否则探针又会去 attach。
  const probeStart = brokerd.indexOf('function probeBridge(')
  const probeEnd = brokerd.indexOf('function probeInstances(', probeStart)
  const probeBody = brokerd.slice(probeStart, probeEnd)
  check('brokerd.mjs：probeBridge 的 spawn 命令带 --no-attach',
    probeStart >= 0 && /command\.push\('--no-attach'\)/.test(probeBody), probeBody.slice(0, 200))

  check('instances.mjs：探针间隔 ≥ 10 分钟（每分钟 2 次改成每 10 分钟）',
    MAINTENANCE_INTERVAL_MS >= 10 * 60_000, MAINTENANCE_INTERVAL_MS)

  // 常量只能定义一次、brokerd 只 import 使用，不许再硬编码一个 60_000。
  const definitions = instances.match(/export const MAINTENANCE_INTERVAL_MS\s*=/g) ?? []
  check('instances.mjs：MAINTENANCE_INTERVAL_MS 只定义一次（没有第二处硬编码）',
    definitions.length === 1, definitions.length)
  check('brokerd.mjs：定时器用常量而不是字面量',
    /setInterval\(\(\)\s*=>\s*\{[\s\S]{0,200}\},\s*MAINTENANCE_INTERVAL_MS\)/.test(brokerd)
      && !/setInterval\([\s\S]{0,120}?60_000\s*\)/.test(brokerd))

  check('instances.mjs：存在 probeEligible（只探自己拉起的实例）',
    /probeEligible\(\)\s*\{/.test(instances) && instances.includes('isUserInstance(entry)'))

  // 「用户实例永远不会被回传给会话」这条保证写在 instances.mjs 的
  // boundPidForSession 里；server.mjs 只负责把它接上。
  check('server.mjs：接上 boundPidForSession（直连 worker 才有 --instance）',
    server.includes('boundPidForSession(SW_CLIENT_ID)') && server.includes('function boundBridgePid()')
      && /boundPid\s*>\s*0\s*\?\s*\['--instance'/.test(server))
  check('instances.mjs：boundPidForSession 只回传 service 实例（用户实例永不回传）',
    instances.includes('isServiceInstance(entry)') && /export function boundPidForSession/.test(instances))
}

// ================================= B. 进程级断言：真的跑 SwBridge.exe
const binDir = join(repo, 'bridge', 'bin')
const exe = pickBridge(binDir)

function pickBridge(dir) {
  if (!existsSync(dir)) return null
  const names = readdirSync(dir).filter((name) => /^SwBridge(-[0-9]{14})?\.exe$/i.test(name))
  if (!names.length) return null
  // 与 server.mjs 的 newestBridge() 同口径：取 mtime 最新的那个。
  const newest = names
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]
  return join(dir, newest.name)
}

function runBridge(args, request, env, dataRoot) {
  const result = spawnSync(exe, args, {
    input: `${JSON.stringify(request)}\n`,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: {
      ...process.env,
      // 把日志写到临时目录，这样「有没有写 ATTACHED_BY_ACTIVE_OBJECT」是可验证的。
      SW_MCP_DATA: dataRoot,
      SW_MCP_ALLOW_ACTIVE_OBJECT: '',
      ...env,
    },
  })
  const lines = String(result.stdout ?? '').split('\n').filter((line) => line.trim().length > 0)
  let response = null
  for (const line of lines) {
    try { response = JSON.parse(line); break } catch { /* 跳过非 JSON 行 */ }
  }
  return { response, status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

function logLines(dataRoot) {
  const dir = join(dataRoot, 'logs')
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!/^mcp-.*\.jsonl$/.test(name)) continue
    out.push(...readFileSync(join(dir, name), 'utf8').split('\n').filter((line) => line.trim().length > 0))
  }
  return out
}

if (!exe) {
  check('桥接器已编译（bridge/bin 下有 SwBridge*.exe；先跑 bridge/build.ps1）', false, binDir)
} else {
  console.log(`      using ${exe}`)

  // B1：未绑定 + 逃生阀未设置 → 必须拒绝，且不许产生 ATTACHED_BY_ACTIVE_OBJECT。
  {
    const dataRoot = tempRoot()
    const run = runBridge(['--worker'], { id: 1, op: 'status' }, {}, dataRoot)
    check('B1 未绑定 worker：返回 ok:false', run.response?.ok === false, run.response)
    check('B1 未绑定 worker：error.code === INSTANCE_NOT_BOUND',
      run.response?.error?.code === 'INSTANCE_NOT_BOUND', run.response?.error?.code)
    check('B1 未绑定 worker：detail 说明 attachMode=unbound 且给出下一步',
      run.response?.error?.detail?.attachMode === 'unbound'
        && /--instance/.test(String(run.response?.error?.detail?.hint ?? '')), run.response?.error?.detail)
    check('B1 未绑定 worker：attachedPid 为 null（没有连上任何实例）',
      run.response?.error?.detail?.attachedPid === null, run.response?.error?.detail?.attachedPid)
    const logs = logLines(dataRoot)
    check('B1 未绑定 worker：没有产生 ATTACHED_BY_ACTIVE_OBJECT（核心回归）',
      !logs.some((line) => line.includes('ATTACHED_BY_ACTIVE_OBJECT')), logs.length)
  }

  // B2：--no-attach → 只读枚举必须成功，activePid 为 null，且同样不 attach。
  {
    const dataRoot = tempRoot()
    const run = runBridge(['--no-attach'], { id: 2, op: 'instances' }, {}, dataRoot)
    check('B2 --no-attach instances：ok:true（只读枚举可用）', run.response?.ok === true, run.response)
    check('B2 --no-attach instances：attachFree=true 且 activePid=null',
      run.response?.attachFree === true && run.response?.activePid === null,
      { attachFree: run.response?.attachFree, activePid: run.response?.activePid })
    check('B2 --no-attach instances：instances 是数组（ROT 枚举真的跑了）',
      Array.isArray(run.response?.instances), run.response?.instances)
    const logs = logLines(dataRoot)
    check('B2 --no-attach：从不 attach，没有 ATTACHED_BY_ACTIVE_OBJECT',
      !logs.some((line) => line.includes('ATTACHED_BY_ACTIVE_OBJECT')), logs.length)
  }

  // B3：--no-attach 下别的 op 也不许 attach。status 是特例：它捕获 BridgeError
  //     后降级成「ready:false + attachError」的**正常返回**（Operations.cs Status），
  //     这本就是它「桥接器不在也能回答」的设计。要紧的是：它绝不偷偷 attach 成功。
  {
    const dataRoot = tempRoot()
    const run = runBridge(['--no-attach'], { id: 3, op: 'status' }, {}, dataRoot)
    check('B3 --no-attach status：降级为 ready:false 且 attachError=INSTANCE_NOT_BOUND',
      run.response?.ok === true && run.response?.ready === false
        && run.response?.attachError === 'INSTANCE_NOT_BOUND',
      { ready: run.response?.ready, attachError: run.response?.attachError })
    check('B3 --no-attach status：没有进程 id（证明没连上任何实例）',
      run.response?.processId === 0, run.response?.processId)
    check('B3 --no-attach status：没有 ATTACHED_BY_ACTIVE_OBJECT',
      !logLines(dataRoot).some((line) => line.includes('ATTACHED_BY_ACTIVE_OBJECT')))
  }

  // B3b：一个真正需要 COM 的 op 在 --no-attach 下必须硬拒绝，不许降级成成功。
  {
    const dataRoot = tempRoot()
    const run = runBridge(['--no-attach'], { id: 33, op: 'list' }, {}, dataRoot)
    check('B3b --no-attach list（需要 COM 的 op）：硬拒绝 INSTANCE_NOT_BOUND',
      run.response?.ok === false && run.response?.error?.code === 'INSTANCE_NOT_BOUND',
      run.response?.error?.code)
  }

  // B4：参数互斥。
  {
    const run = runBridge(['--no-attach', '--instance', '4242'], { id: 4, op: 'instances' }, {}, tempRoot())
    check('B4 --no-attach + --instance 互斥：退出码 2 且不返回 ok:true',
      run.status === 2 && run.response?.ok !== true, { status: run.status, response: run.response })
  }

  // B5：--instance 指向一个不存在的 pid → 走 ROT 精确绑定并失败，
  //     证明绑定路径没有回退到 GetActiveObject。
  {
    const dataRoot = tempRoot()
    const run = runBridge(['--instance', '999999'], { id: 5, op: 'status' }, {}, dataRoot)
    const code = run.response?.error?.code
    check('B5 --instance 不存在的 pid：失败码是 ROT 类而不是去跟随前台',
      run.response?.ok === false && ['INSTANCE_GONE', 'INSTANCE_NOT_IN_ROT'].includes(code), code)
    check('B5 --instance 不存在：仍然没有 ATTACHED_BY_ACTIVE_OBJECT',
      !logLines(dataRoot).some((line) => line.includes('ATTACHED_BY_ACTIVE_OBJECT')))
  }
}

// ================================= C. 登记表断言：只有用户实例时不探
function makeManager({ entries = [], rot = [], workers = null, clientPid = [] } = {}) {
  const dir = tempRoot()
  const file = join(dir, 'instances.json')
  writeFileSync(file, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), instances: entries }), 'utf8')
  const calls = { probe: 0, stopWorker: [], quit: [] }
  const manager = new InstanceManager({
    file,
    env: {},
    probe: async () => { calls.probe += 1; return { instances: rot.slice(), activePid: null } },
    workers: workers ?? new Map(),
    workerLastUsed: new Map(),
    clientPid: new Map(clientPid),
    stopWorker: (pid) => { calls.stopWorker.push(Number(pid)); return true },
    cleanupWorker: async () => ({ closed: [] }),
    quitWorker: async (pid) => { calls.quit.push(Number(pid)) },
    stopProcess: async () => true,
    isAlive: () => true,
    now: () => Date.now(),
    sleep: async () => {},
    graceMs: 60_000,
    workerIdleMs: 60_000,
    minWarm: 0,
    log: () => {},
  })
  return { manager, file, calls, dir }
}

const userEntry = (pid) => ({
  pid,
  startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  launchedBy: 'user',
  tag: null,
  ownerClients: [],
  lastSeen: new Date(Date.now() - 3_600_000).toISOString(),
  lastUsedAt: new Date(Date.now() - 3_600_000).toISOString(),
  workerStarted: false,
})

{
  // C1：登记表里只有用户实例 + 没有 worker + 没有会话绑定 → probeEligible=false，
  //     maintenance 一次都不许起探针进程。这正是今天 22076 那个现场。
  const { manager, calls } = makeManager({ entries: [userEntry(22076)] })
  check('C1 只有用户实例：probeEligible() === false', manager.probeEligible() === false)
  const result = await manager.maintenance({})
  check('C1 只有用户实例：maintenance 期间探针一次都没起', calls.probe === 0, calls.probe)
  check('C1 只有用户实例：计数器明确标注 probeSkipped', result.probeSkipped === true, result.probeSkipped)
  check('C1 只有用户实例：用户条目没被当成「ROT 消失」删掉',
    JSON.parse(readFileSync(manager.file, 'utf8')).instances.some((entry) => entry.pid === 22076))
}

{
  // C2：登记表里有 broker 起的实例 → 必须探（否则回收逻辑会瞎）。
  const { manager, calls } = makeManager({
    entries: [{ ...userEntry(1), launchedBy: 'broker', tag: 'service' }],
    rot: [{ pid: 1 }],
  })
  check('C2 有 broker 实例：probeEligible() === true', manager.probeEligible() === true)
  const result = await manager.maintenance({})
  check('C2 有 broker 实例：确实探了一次', calls.probe === 1, calls.probe)
  check('C2 有 broker 实例：probeSkipped=false', result.probeSkipped === false)
}

{
  // C3：一轮里只探一次。旧代码 maintenance(:2094) + reap(:1996) 固定探两次，
  //     这正是「每分钟 2 个探针进程」的来源。
  const { manager, calls } = makeManager({
    entries: [{ ...userEntry(2), launchedBy: 'broker', tag: 'service' }],
    rot: [{ pid: 2 }],
  })
  await manager.maintenance({})
  check('C3 一轮 maintenance 只探 1 次（旧代码是 2 次）', calls.probe === 1, calls.probe)
  // 同一轮内再探（reap 复用缓存）不会再起进程。
  await manager.reap({ reason: 'test' })
  check('C3 同一轮内 reap 复用缓存，不重复探', calls.probe === 1, calls.probe)
  // 缓存过期（跨过 ttl）后必须重新探，否则长驻 broker 会一直用旧 ROT。
  // 注意不能只看 probeEligible：维护结束登记条目被回收后它就变成 false 了，
  // 所以这里用「有会话绑定」保持探测资格，单独验证 ttl 行为。
  const keep = makeManager({
    entries: [{ ...userEntry(9), launchedBy: 'broker', tag: 'service' }],
    rot: [{ pid: 9 }],
    clientPid: [['sess-a', 9]],
  })
  await keep.manager.prefetchProbe()
  check('C3 ttl 内复用缓存', keep.calls.probe === 1, keep.calls.probe)
  keep.manager.invalidateProbe()
  await keep.manager.prefetchProbe()
  check('C3 缓存失效后重新探', keep.calls.probe === 2, keep.calls.probe)
}

{
  // C4：probeEligible 也看「broker 手里还有 worker」——没有登记实例但还有 worker
  //     时不能因为「只看到用户实例」就停止探测。
  const workers = new Map([[77, { describe: () => ({ pending: 0, active: 0 }), stop: () => {} }]])
  const { manager } = makeManager({ entries: [userEntry(3)], rot: [], workers })
  check('C4 有 worker 时 probeEligible() === true', manager.probeEligible() === true)
}

{
  // C5：defaultInstancesFile 仍然认 SW_MCP_INSTANCES_FILE（本文件不碰真路径）。
  check('C5 登记表路径仍可用 SW_MCP_INSTANCES_FILE 覆盖',
    defaultInstancesFile({ SW_MCP_INSTANCES_FILE: 'D:\\tmp\\x.json' }) === 'D:\\tmp\\x.json')
}

// 清理
for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
