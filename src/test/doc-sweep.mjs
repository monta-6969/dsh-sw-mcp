// 会话级文档清扫的离线回归（broker + 假 worker，不需要 SOLIDWORKS）。
//
// 契约（server.mjs）：一个 MCP 进程只服务一个会话，会话里换 designId 建的旧文档
// 在下次 build/create 之前由 sweepOtherDesigns 收掉；存过盘的文档永不回收；某条
// 清扫失败只记错误码、不阻断本次构建；并发构建不能把对方当旧账收掉。
//
// 25 条断言：1-5、11、19 在 s1，6 在 s2（开关关掉），7 在 s3（存盘保护），8 在 s4
// （清扫失败不阻断 + 失败退避），9 在 s5（同 designId 并发 / in-flight 计数），
// 10 在 s6（workspace cleanup 按 result.closed 销账；create 建档已登记，cleanup 收得掉），
// 13 在 s7（SW_MCP_SESSION_SWEEP_LIMIT 上限丢最旧），14 在 s8（SW_MCP_SESSION_SWEEP_TTL_MS
// 过期移出），15-18 在 s9（create 建档进 registry / cleanup 能回收 / 用户路径文档不被碰 /
// 三个建档入口都走 RegisterCreated），12 是收尾。
// 第二轮加固（无 designId 的 cleanup 只清「自己建的」）追加 s10-s13，分别在
// s10（origin:"unknown" 的条目不被关）、s11（origin:"create" 的本会话条目被关）、
// s12（别的 sessionId 的 build 条目不被关）、s13（返回体里的 skippedUnknown 数值正确）。
// 第三轮加固追加：19 在 s1（生产 build/create 请求体带本会话 sessionId，与 cleanup 同源）、
// 20 在 s14（workspace action="read" 只读数据目录：目录内可读、.. 穿越与越界绝对路径被拒）、
// 21 在 s14（inspect action="verify" 的结果写进 review/live.json 的 record.verify）。
// 每条的观察值都打在日志里，失败时能直接看出哪一项不对。
//
// 假的 SolidWorks 由本文件写进临时目录：一行 {id,op,...args} 进、一行 {id,ok,...} 出，
// 文档状态写 state.json、操作流水追加到 ops.jsonl。不探 ROT、不启动 SOLIDWORKS。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession, repoRoot } from './lib/mcp.mjs'
import { BrokerClient } from '../server/broker/client.mjs'

const root = mkdtempSync(join(tmpdir(), 'sw-doc-sweep-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let passed = 0
const failures = []
/** 一条断言一个 PASS/FAIL：conditions 里任何一项不为真就算没过，明细照打。 */
function check(id, name, conditions, detail) {
  const failed = Object.entries(conditions).filter(([, value]) => !value).map(([key]) => key)
  const ok = failed.length === 0
  if (ok) passed += 1
  else failures.push(`${id} ${name}（未通过：${failed.join(', ')}）`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}`)
  if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`)
  if (!ok) console.log(`      未通过的条件：${failed.join(', ')}`)
}

/**
 * 假 worker 的源码。路径在生成时嵌进去，所以每个测试会话一份独立的 ops/state。
 *
 * 语义照真桥接器复刻：build 先关同 designId 的旧文档、cleanup 只认已登记的 id、
 * close 按标题、newDocument 不登记 designId（Operations.cs:876-896 的那个缺陷）。
 */
function fakeWorkerSource(opsPath, statePath) {
  return `
// 由 test/doc-sweep.mjs 生成：假 SolidWorks worker。
import { appendFileSync, writeFileSync } from 'node:fs'
const OPS = ${JSON.stringify(opsPath)}
const STATE = ${JSON.stringify(statePath)}
const NL = String.fromCharCode(10)
const LOGGED = new Set(['build', 'cleanup', 'close', 'newDocument', 'save', 'export'])
const documents = []
let serial = 1

function snapshot() {
  writeFileSync(STATE, JSON.stringify({ documents }))
}
function argsDigest(op, args) {
  if (op === 'build') return { designId: args.definition?.designId ?? null, features: (args.definition?.features ?? []).length, sessionId: args.sessionId ?? null }
  if (op === 'newDocument') return { sessionId: args.sessionId ?? null }
  if (op === 'cleanup') return { designId: args.designId ?? null, sessionId: args.sessionId ?? null }
  if (op === 'close') return { title: args.title ?? null, allowDirty: args.allowDirty === true, pathPrefix: args.pathPrefix ?? null }
  if (op === 'save') return { designId: args.designId ?? null, path: args.path ?? null }
  if (op === 'export') return { designId: args.designId ?? null, kind: args.kind ?? null }
  if (op === 'open') return { path: args.path ?? null, title: args.title ?? null, origin: args.origin ?? null, sessionId: args.sessionId ?? null }
  return {}
}
function resultDigest(op, outcome) {
  if (outcome.error) return { error: outcome.error.code ?? String(outcome.error) }
  const result = outcome.result ?? {}
  if (op === 'build' || op === 'newDocument') return { document: result.document, autoClosed: result.autoClosed ?? [] }
  if (op === 'cleanup') return { closed: result.closed, remaining: result.remaining, skippedUnknown: result.skippedUnknown, skippedOtherSession: result.skippedOtherSession }
  if (op === 'close') return { found: result.found, closed: result.closed, remaining: result.remaining }
  if (op === 'save') return { saved: result.saved, path: result.path }
  if (op === 'export') return { exported: result.exported }
  return {}
}
function record(op, args, outcome) {
  appendFileSync(OPS, JSON.stringify({ op, args: argsDigest(op, args), result: resultDigest(op, outcome) }) + NL)
}
function closeWhere(predicate) {
  const closed = []
  for (let index = documents.length - 1; index >= 0; index -= 1) {
    if (!predicate(documents[index])) continue
    closed.unshift(documents[index].title)
    documents.splice(index, 1)
  }
  return closed
}
function handle(op, args) {
  switch (op) {
    case 'instances':
      // broker 启动维护用这个探 ROT；必须回空表，而且不写 STATE —— 探针是另一个进程，
      // 写空表会把真 worker 的状态覆盖掉。
      return { result: { instances: [] } }
    case 'version':
      return { result: { ready: true, revision: 'fake-2026' } }
    case 'status':
      return { result: { ready: true, revision: 'fake-2026', documents: documents.map((doc) => ({ title: doc.title, path: doc.path })) } }
    case 'list':
      return { result: { documents: documents.map((doc) => ({ title: doc.title, path: doc.path, designId: doc.designId })) } }
    case 'inspect':
      // verify 前置要回读一次 geometry（之后 expect 为空就不跑 runCheck）：给一份固定几何。
      return {
        result: {
          geometry: { massProperties: { volume: 1000 }, boundingBox: { size: [10, 10, 10] }, holes: [] },
        },
      }
    case 'build': {
      // 复刻 Documents.CloseUnsavedBuilds(onlyDesignId)：同 designId 的旧文档先自关。
      const designId = args.definition?.designId ?? null
      const autoClosed = closeWhere((doc) => designId !== null && doc.designId === designId && !doc.path)
      const title = '零件' + serial
      serial += 1
      documents.push({ title, designId, path: '', dirty: true, origin: 'build', sessionId: args.sessionId ?? null })
      return {
        result: {
          autoClosed,
          document: { title, path: '' },
          features: [],
          geometry: { massProperties: { volume: 1000 }, boundingBox: { size: [10, 10, 10] }, holes: [] },
          bindings: {},
          dimensionBindings: {},
          drivers: { mode: 'literal' },
          builderSteps: [],
          notes: [],
        },
      }
    }
    case 'newDocument': {
      // 复刻修复后的 Operations.cs RegisterCreated：create 建的文档以 "created:<标题>"
      // 登记 designId、origin 记 create，cleanup 因此看得见它。
      const title = '零件' + serial
      serial += 1
      documents.push({ title, designId: args.designId ?? ('created:' + title), path: '', dirty: true, origin: 'create', sessionId: args.sessionId ?? null })
      return { result: { document: { title, path: '' } } }
    }
    case 'open': {
      // 用户自己打开的文档：带 path、没有 designId、不在 registry —— 任何回收都不许碰。
      // 测试还能用 title/origin 造一条「registry 里的历史行 + 同名窗口」：origin 缺省即
      // unknown，用来验证无 designId 的 cleanup 不会关它。
      const path = String(args.path ?? '')
      const fallback = path.split(/[\\\\/]/).filter(Boolean).pop() ?? '用户零件'
      const title = args.title ?? fallback
      const origin = args.origin ?? null
      documents.push({
        title,
        designId: args.designId ?? (origin ? 'legacy:' + title : null),
        path,
        dirty: false,
        origin,
        sessionId: args.sessionId ?? null,
      })
      return { result: { activeTitle: title, path } }
    }
    case 'cleanup': {
      // 让清扫失败，用来看「失败不阻断本次构建」和「失败退避」。BOOM 开头的 id 都失败：
      // 上限用例要用多个都关不掉的条目把账本顶过上限。
      if (typeof args.designId === 'string' && args.designId.startsWith('BOOM')) {
        return { error: { code: 'FAKE_SWEEP_BOOM', message: '这条清扫故意失败' } }
      }
      // 复刻真桥接器 Documents.SweepDocuments：带 designId 只收这一条登记；不带就是
      // 会话级清扫。两条分支都只关 origin 为 build/create 的无路径登记项；origin 缺失
      // （历史行）算 unknown 跳过并计数；条目带了 sessionId 且不是当前会话的也跳过。
      // 带 path 的用户文档永不回收（它要么不在账上、要么路径非空）。
      const sessionId = args.sessionId ?? null
      const closed = []
      let skippedUnknown = 0
      let skippedOtherSession = 0
      for (let index = documents.length - 1; index >= 0; index -= 1) {
        const doc = documents[index]
        if (doc.designId === null || doc.path) continue
        if (args.designId && doc.designId !== args.designId) continue
        const origin = doc.origin ?? 'unknown'
        if (origin !== 'build' && origin !== 'create') { skippedUnknown += 1; continue }
        if (sessionId && doc.sessionId && doc.sessionId !== sessionId) { skippedOtherSession += 1; continue }
        closed.unshift(doc.title)
        documents.splice(index, 1)
      }
      return { result: { closed, remaining: documents.length, skippedUnknown, skippedOtherSession } }
    }
    case 'close': {
      let targets = []
      if (args.pathPrefix) targets = documents.filter((doc) => (doc.path ?? '').startsWith(args.pathPrefix))
      else if (args.title) targets = documents.filter((doc) => doc.title === args.title)
      const blocked = targets.filter((doc) => !doc.path && args.allowDirty !== true)
      if (blocked.length > 0) return { error: { code: 'DOCUMENT_DIRTY', message: blocked[0].title + ' 有未保存修改' } }
      const closed = closeWhere((doc) => targets.includes(doc))
      return { result: { found: closed.length > 0, closed, remaining: documents.length } }
    }
    case 'save': {
      const doc = documents.find((item) => item.designId === args.designId)
      if (!doc) return { result: { saved: false, errors: 1 } }
      doc.path = args.path ?? doc.title + '.SLDPRT'
      doc.dirty = false
      return { result: { saved: true, path: doc.path, bytes: 2048 } }
    }
    case 'export':
      return { result: { exported: true, bytes: 512, path: args.path ?? null } }
    default:
      return { error: { code: 'FAKE_UNKNOWN_OP', message: op } }
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf(NL)) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let request
    try { request = JSON.parse(line) } catch { continue }
    const { id, op, ...args } = request
    let outcome
    try { outcome = handle(op, args) } catch (error) {
      outcome = { error: { code: error && error.code ? error.code : 'FAKE_WORKER_ERROR', message: String(error && error.message ? error.message : error) } }
    }
    if (LOGGED.has(op)) record(op, args, outcome)
    if (op !== 'instances') snapshot()
    const payload = outcome.error ? { id, ok: false, error: outcome.error } : { id, ok: true, ...outcome.result }
    process.stdout.write(JSON.stringify(payload) + NL)
  }
})
process.stdin.on('end', () => process.exit(0))
`
}

const sessions = []
/** 一个会话 = 一个 MCP 服务进程 + 一个独立 broker + 一份假 worker。 */
async function openSweepSession(name, { sweep = true, env: extraEnv = {} } = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const opsPath = join(dir, 'ops.jsonl')
  const statePath = join(dir, 'state.json')
  writeFileSync(opsPath, '')
  writeFileSync(statePath, JSON.stringify({ documents: [] }))
  const workerPath = join(dir, 'fake-worker.mjs')
  writeFileSync(workerPath, fakeWorkerSource(opsPath, statePath))
  const pipe = '\\\\.\\pipe\\sw-doc-sweep-' + process.pid + '-' + Date.now() + '-' + name
  const env = {
    ...process.env,
    SW_MCP_BROKER: '1',
    SW_MCP_BROKER_PIPE: pipe,
    SW_MCP_BROKER_DIR: join(dir, 'broker'),
    SW_MCP_BROKER_WORKER_CMD: JSON.stringify([process.execPath, workerPath]),
    SW_MCP_DATA: join(dir, 'data'),
    SW_MCP_INSTANCES_FILE: join(dir, 'instances.json'),
    SW_MCP_TEST: '1',
    SW_MCP_SESSION_SWEEP: sweep ? '1' : '0',
    ...extraEnv,
  }
  // 关键：不设 SW_MCP_BROKER_ENSURE —— 默认不探 ROT、不启动 SOLIDWORKS。
  delete env.SW_MCP_BROKER_ENSURE
  delete env.SW_MCP_SESSION_ID
  delete env.SW_MCP_BROKER_INSTANCE
  const session = openSession({ env })
  const ctx = { name, dir, pipe, opsPath, statePath, session, closed: false }
  sessions.push(ctx)
  await session.start()
  return ctx
}

async function closeSweepSession(ctx) {
  try { ctx.session.child.kill() } catch { /* 已经在退 */ }
  if (ctx.session.child.exitCode === null) await Promise.race([once(ctx.session.child, 'exit'), sleep(2000)])
  try {
    const client = await BrokerClient.connect({ pipe: ctx.pipe, spawnIfMissing: false, timeoutMs: 3000 })
    try { await client.request('shutdown', {}, { timeoutMs: 2000 }) } finally { client.close() }
  } catch { /* broker 已经没了 */ }
  await sleep(250)
  try { rmSync(ctx.dir, { recursive: true, force: true }) } catch { /* 占用中的文件留到下一轮 */ }
  ctx.closed = true
}

function readOps(ctx) {
  try {
    return readFileSync(ctx.opsPath, 'utf8').split('\n').map((line) => line.trim())
      .filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}
function readDocs(ctx) {
  try {
    return JSON.parse(readFileSync(ctx.statePath, 'utf8')).documents ?? []
  } catch {
    return []
  }
}
/**
 * 读服务进程写的事件日志（SW_MCP_DATA=临时目录 → 日志在 <dir>/data/logs/mcp-*.jsonl）。
 *
 * 上限/TTL 这两条没有「结果里能直接看见」的返回值：账本被淘汰/过期后只会少一次
 * cleanup，和「本来就没这条」看不出区别，所以拿服务自己记的 warn 事件当证据。
 * 事件是 appendFileSync 写的，工具调用返回时已经落盘。
 */
function readEvents(ctx, predicate) {
  const dir = join(ctx.dir, 'data', 'logs')
  const events = []
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('mcp-') || !name.endsWith('.jsonl')) continue
      let text = ''
      try { text = readFileSync(join(dir, name), 'utf8') } catch { continue }
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try { events.push(JSON.parse(trimmed)) } catch { /* 半行忽略 */ }
      }
    }
  } catch {
    return []
  }
  return predicate ? events.filter(predicate) : events
}
function opIndex(ctx, predicate) {
  return readOps(ctx).findIndex(predicate)
}
function buildRun(ctx, designId) {
  return ctx.session.tool('model', {
    action: 'build',
    definition: { designId, units: 'mm', params: {}, features: [] },
  })
}
function createRun(ctx, designId) {
  return ctx.session.tool('model', { action: 'create', designId })
}
/**
 * 借 job 工具把一条「不是本会话造的」登记写进假 worker：op 与参数原样交给桥接器，
 * 所以可以给定 sessionId / origin 来复刻「另一个会话建的」「旧版本留下的历史行」。
 * 会话级 cleanup 的输入是 MCP 工具参数，唯一能带 sessionId 的路就是 cleanup 本体，
 * 因此这类前置条件只能从作业通道塞进 worker。
 */
async function seedViaJob(ctx, op, args, operationId) {
  const submitted = await ctx.session.tool('job', { action: 'submit', op, args, operationId })
  const jobId = submitted?.changes?.job?.jobId
  let job = submitted?.changes?.job
  for (let attempt = 0; attempt < 80 && jobId && !['succeeded', 'failed'].includes(job?.state); attempt += 1) {
    await sleep(25)
    const status = await ctx.session.tool('job', { action: 'status', jobId })
    job = status?.changes?.job
  }
  return job
}
function requireOk(result, what) {
  if (result?.status !== 'ok') throw new Error(`${what} 失败：${JSON.stringify(result).slice(0, 800)}`)
  return result
}
function sweptOf(result) {
  return result?.changes?.sweptPreviousDesigns ?? []
}
function docsBrief(ctx) {
  return readDocs(ctx).map((doc) => ({ title: doc.title, designId: doc.designId, path: doc.path }))
}
/** 打印某个会话的桥接器流水与假 worker 里的文档，作为日志里的证据。 */
function timeline(ctx) {
  console.log(`  [${ctx.name}] 假 worker 流水：`)
  for (const [index, entry] of readOps(ctx).entries()) {
    console.log(`    ${index + 1}. ${entry.op} ${JSON.stringify(entry.args)} -> ${JSON.stringify(entry.result)}`)
  }
  console.log(`  [${ctx.name}] 结束时文档：${JSON.stringify(docsBrief(ctx))}`)
}

/** 一个场景一个会话；场景里抛错只记一条失败，不拖垮后面的场景。 */
async function scenario(name, options, run) {
  console.log(`\n--- ${name} ---`)
  let ctx = null
  try {
    ctx = await openSweepSession(name, options)
    await run(ctx)
  } catch (error) {
    const message = `${name} 运行中断：${error?.message ?? String(error)}`
    failures.push(message)
    console.log(`FAIL  ${message}`)
    if (ctx) timeline(ctx)
  } finally {
    if (ctx) await closeSweepSession(ctx)
  }
}

console.log(`临时目录：${root}`)

// ---------------------------------------------------------------- 1-5, 11：换 id 清扫
await scenario('s1', {}, async (ctx) => {
  // 1. build A 之前只做了一次 cleanup{designId:"A"}（旧行为未破坏）
  const buildA = requireOk(await buildRun(ctx, 'A'), 'build A')
  const buildAIndex = opIndex(ctx, (entry) => entry.op === 'build' && entry.args.designId === 'A')
  const beforeA = readOps(ctx).slice(0, buildAIndex)
  const cleanupsBeforeA = beforeA.filter((entry) => entry.op === 'cleanup')
  check('01', 'build A 之前只有一次 cleanup{designId:"A"}（旧行为未破坏）', {
    buildHappenedAfterCleanup: buildAIndex > 0,
    exactlyOneCleanup: cleanupsBeforeA.length === 1,
    cleanupTargetsA: cleanupsBeforeA[0]?.args.designId === 'A',
    noCloseBeforeBuild: beforeA.every((entry) => entry.op !== 'close'),
    nothingToSweepYet: sweptOf(buildA).length === 0,
  }, { buildIndex: buildAIndex, cleanupsBeforeA, swept: sweptOf(buildA), summary: buildA.summary })
  const aTitle = buildA.changes?.document?.title

  // 2. build B（换 id）→ A 的旧文档被清扫，假 worker 里只剩 1 个
  const buildB = requireOk(await buildRun(ctx, 'B'), 'build B')
  const buildBIndex = opIndex(ctx, (entry) => entry.op === 'build' && entry.args.designId === 'B')
  const betweenAB = readOps(ctx).slice(buildAIndex + 1, buildBIndex)
  const sweptB = sweptOf(buildB)
  const docsAfterB = readDocs(ctx)
  check('02', '换 designId 建 B 时收掉 A 的旧文档，worker 里只剩 1 个', {
    cleanupABeforeBuildB: betweenAB.some((entry) => entry.op === 'cleanup' && entry.args.designId === 'A'),
    sweptHasA: sweptB.some((entry) => entry.designId === 'A'),
    sweptClosedATitle: sweptB.some((entry) => entry.designId === 'A' && (entry.closed ?? []).includes(aTitle)),
    oneDocLeft: docsAfterB.length === 1,
    onlyBDocLeft: docsAfterB[0]?.designId === 'B',
  }, { aTitle, betweenAB, sweptB, docs: docsBrief(ctx) })
  const bTitle = docsAfterB[0]?.title

  // 3. 再 build A → 关掉 B 的文档，来回换 id 不再积累
  const buildA2 = requireOk(await buildRun(ctx, 'A'), 'build A（第二次）')
  const sweptA2 = sweptOf(buildA2)
  const docsAfterA2 = readDocs(ctx)
  check('03', '再建 A 时收掉 B 的文档，来回换 id 只保留 1 个', {
    sweptHasB: sweptA2.some((entry) => entry.designId === 'B'),
    sweptClosedBTitle: sweptA2.some((entry) => entry.designId === 'B' && (entry.closed ?? []).includes(bTitle)),
    oneDocLeft: docsAfterA2.length === 1,
    onlyADocLeft: docsAfterA2[0]?.designId === 'A',
  }, { bTitle, sweptA2, docs: docsBrief(ctx) })

  // 4. create C 建的孤儿文档（不带 designId）由 build D 按标题 close 兜住
  const createdC = requireOk(await createRun(ctx, 'C'), 'create C')
  const cTitle = createdC.changes?.document?.title
  const newDocumentIndex = opIndex(ctx, (entry) => entry.op === 'newDocument')
  const buildD = requireOk(await buildRun(ctx, 'D'), 'build D')
  const buildDIndex = opIndex(ctx, (entry) => entry.op === 'build' && entry.args.designId === 'D')
  const betweenCD = readOps(ctx).slice(newDocumentIndex + 1, buildDIndex)
  const closeC = betweenCD.filter((entry) => entry.op === 'close' && entry.args.title === cTitle)
  const sweptD = sweptOf(buildD)
  check('04', 'create 的孤儿文档被 build D 按标题 close{allowDirty:true} 收掉', {
    closeCalled: closeC.length === 1,
    allowDirty: closeC.some((entry) => entry.args.allowDirty === true),
    workerFoundIt: closeC.some((entry) => entry.result?.found === true),
    sweptHasC: sweptD.some((entry) => entry.designId === 'C'),
    sweptClosedCTitle: sweptD.some((entry) => entry.designId === 'C' && (entry.closed ?? []).includes(cTitle)),
    oneDocLeft: readDocs(ctx).length === 1,
  }, { cTitle, closeC, sweptD, docs: docsBrief(ctx) })

  // 5. 同 designId 连 build 两次：旧语义 closedUnsaved 仍然生效
  const same1 = requireOk(await buildRun(ctx, 'same'), 'build same（第一次）')
  const same2 = requireOk(await buildRun(ctx, 'same'), 'build same（第二次）')
  const closedUnsaved = same2.changes?.closedUnsaved ?? []
  check('05', '同 designId 再 build：closedUnsaved 非空，最终只剩 1 个文档', {
    closedUnsavedIsArray: Array.isArray(same2.changes?.closedUnsaved),
    closedUnsavedNotEmpty: closedUnsaved.length > 0,
    firstBuildHadNothing: (same1.changes?.closedUnsaved ?? []).length === 0,
    oneDocLeft: readDocs(ctx).length === 1,
    onlySameDocLeft: readDocs(ctx)[0]?.designId === 'same',
  }, { closedUnsaved, docs: docsBrief(ctx) })

  // 11. 返回形状
  const samples = [buildB, buildA2, buildD, same2].map((result, index) => ({ index, changes: result?.changes }))
  check('11', '返回形状：closedUnsaved 仍是数组，sweptPreviousDesigns 是数组且元素含 designId/closed', {
    closedUnsavedIsArray: samples.every((sample) => Array.isArray(sample.changes?.closedUnsaved)),
    sweptIsArray: samples.every((sample) => Array.isArray(sample.changes?.sweptPreviousDesigns)),
    sweptEntriesWellFormed: samples.every((sample) => (sample.changes?.sweptPreviousDesigns ?? [])
      .every((entry) => typeof entry?.designId === 'string' && Array.isArray(entry?.closed))),
    nonTrivialSweepSeen: samples.some((sample) => (sample.changes?.sweptPreviousDesigns ?? []).length > 0),
  }, samples.map((sample) => ({
    index: sample.index,
    closedUnsaved: sample.changes?.closedUnsaved,
    sweptPreviousDesigns: sample.changes?.sweptPreviousDesigns,
  })))

  // 19. G1：建文档请求必须带本会话 sessionId —— 桥接器按它做跨会话清扫，
  // 不带的话生产条目落成 sessionId=null，跨会话过滤形同虚设。假 worker 把
  // build/newDocument/cleanup 的 args.sessionId 都记进了流水，直接对值。
  const expectedSession = `mcp:${ctx.session.child.pid}`
  const buildOps = readOps(ctx).filter((entry) => entry.op === 'build')
  const createOps = readOps(ctx).filter((entry) => entry.op === 'newDocument')
  const cleanupOps = readOps(ctx).filter((entry) => entry.op === 'cleanup')
  const serverSource = readFileSync(join(repoRoot, 'server', 'server.mjs'), 'utf8')
  check('19', '生产 build/create 请求体带本会话 sessionId（与 cleanup 同源），跨会话清扫才分得清', {
    buildsCarrySession: buildOps.length > 0 && buildOps.every((entry) => entry.args.sessionId === expectedSession),
    createsCarrySession: createOps.length > 0 && createOps.every((entry) => entry.args.sessionId === expectedSession),
    cleanupsCarrySameValue: cleanupOps.length > 0 && cleanupOps.every((entry) => entry.args.sessionId === expectedSession),
    // assemblyNew / drawingNew 假 worker 没有分支，只能查源码里同一个注入点覆盖到它们。
    assemblyDrawingWired: /SESSION_SCOPED_OPS\s*=\s*new Set\(\[[^\]]*assemblyNew[^\]]*drawingNew/.test(serverSource),
  }, {
    expectedSession,
    buildSessions: buildOps.map((entry) => entry.args.sessionId),
    createSessions: createOps.map((entry) => entry.args.sessionId),
  })

  timeline(ctx)
})

// ---------------------------------------------------------------- 20：workspace read 白名单（G3）
//
// 描述承诺「只在这个目录里」。修复前 `resolve(args.path)` 直接读：仓库源码、用户
// 磁盘上任意文件都能被读走。这里验三件事：数据目录里的文件读得到；`..` 穿越被拒；
// 绝对路径越界被拒（都回 READ_OUTSIDE_DATA_DIR，且消息里给出允许的根与示例）。
await scenario('s14', {}, async (ctx) => {
  const dataDir = join(ctx.dir, 'data')
  const inside = join(dataDir, 'projects', 'g3-note.json')
  writeFileSync(inside, JSON.stringify({ note: '数据目录里的普通文件' }) + '\n')
  const readInside = await ctx.session.tool('workspace', { action: 'read', path: inside })
  const traversal = await ctx.session.tool('workspace', { action: 'read', path: join(dataDir, '..', '..', 'hosts') })
  const outside = await ctx.session.tool('workspace', { action: 'read', path: join(repoRoot, 'package.json') })
  const directory = await ctx.session.tool('workspace', { action: 'read', path: dataDir })
  const codeOf = (result) => result?.extra?.error?.code ?? null
  check('20', 'workspace read 只读数据目录：目录内可读，.. 穿越/绝对路径越界被拒（READ_OUTSIDE_DATA_DIR）', {
    insideOk: readInside.status === 'ok' && String(readInside.changes?.text ?? '').includes('数据目录里的普通文件'),
    traversalCode: codeOf(traversal) === 'READ_OUTSIDE_DATA_DIR',
    outsideCode: codeOf(outside) === 'READ_OUTSIDE_DATA_DIR',
    messageListsRoots: /允许的根目录/.test(String(outside?.extra?.error?.message ?? ''))
      && /logs/.test(String(outside?.extra?.error?.message ?? '')),
    directoryRejected: codeOf(directory) === 'READ_NOT_A_FILE',
    nothingLeaked: traversal?.changes?.text === undefined && outside?.changes?.text === undefined,
  }, {
    insideStatus: readInside.status,
    totalLines: readInside.changes?.totalLines,
    traversalCode: codeOf(traversal),
    outsideCode: codeOf(outside),
    directoryCode: codeOf(directory),
    outsideMessage: String(outside?.extra?.error?.message ?? '').slice(0, 200),
  })
  // 21. G2：服务把 inspect action="verify" 的结果写进 review/live.json 的 record.verify。
  // PTC 模式下审查门看不到 verify 的子调用返回，只能读这里；没有这条，门要么走豁免、
  // 要么永远 VERIFY_NOT_RUN。空 expect → not-run（不碰 runCheck，离线可跑）。
  const buildG2 = requireOk(await buildRun(ctx, 'G2'), 'build G2（给 verify 一个 revision）')
  const verifyResult = await ctx.session.tool('inspect', { action: 'verify', designId: 'G2', expect: {} })
  let live = null
  try {
    live = JSON.parse(readFileSync(join(dataDir, 'review', 'live.json'), 'utf8'))
  } catch {
    live = null
  }
  const liveRecord = live?.designs?.G2 ?? null
  const verifyRecord = liveRecord?.verify ?? null
  check('21', 'verify 结果进 live.json：record.verify 带 status/checks/unmeasured/revision/at，且 revision 是当前这一版', {
    verifyRan: verifyResult?.status === 'not-run',
    recordExists: liveRecord !== null,
    statusRecorded: verifyRecord?.status === 'not-run',
    checksArray: Array.isArray(verifyRecord?.checks),
    unmeasuredArray: Array.isArray(verifyRecord?.unmeasured),
    revisionIsCurrent: typeof verifyRecord?.revision === 'number'
      && verifyRecord.revision === liveRecord?.revision,
    atIsIso: typeof verifyRecord?.at === 'string' && Number.isFinite(Date.parse(verifyRecord.at)),
    buildSeenFirst: buildG2.status === 'ok',
  }, {
    verifyStatus: verifyResult?.status,
    revision: liveRecord?.revision,
    verify: verifyRecord === null ? null : { ...verifyRecord, checks: verifyRecord.checks?.length },
  })
  timeline(ctx)
})

// ---------------------------------------------------------------- 6：开关关掉
await scenario('s2', { sweep: false }, async (ctx) => {
  const buildA = requireOk(await buildRun(ctx, 'A'), 'build A')
  const buildB = requireOk(await buildRun(ctx, 'B'), 'build B')
  const allCleanups = readOps(ctx).filter((entry) => entry.op === 'cleanup')
  const cleanupA = allCleanups.filter((entry) => entry.args.designId === 'A')
  // 第二次换 id 之后不该再出现针对 A 的 cleanup；假 worker 里两份文档并存。
  const buildAIndex = opIndex(ctx, (entry) => entry.op === 'build' && entry.args.designId === 'A')
  check('06', 'SW_MCP_SESSION_SWEEP="0"：换 id 不扫旧文档，worker 里两份文档并存', {
    sweepReturnedNothing: sweptOf(buildA).length === 0 && sweptOf(buildB).length === 0,
    onlyOwnCleanupForA: cleanupA.length === 1,
    ownCleanupBeforeBuild: cleanupA.length === 1 && readOps(ctx).indexOf(cleanupA[0]) < buildAIndex,
    twoDocsCoexist: readDocs(ctx).length === 2,
    bothDesignIdsPresent: readDocs(ctx).some((doc) => doc.designId === 'A')
      && readDocs(ctx).some((doc) => doc.designId === 'B'),
  }, { cleanupDesignIds: allCleanups.map((entry) => entry.args.designId), sweptB: sweptOf(buildB), docs: docsBrief(ctx) })
  timeline(ctx)
})

// ---------------------------------------------------------------- 7：存盘保护
await scenario('s3', {}, async (ctx) => {
  const buildA = requireOk(await buildRun(ctx, 'A'), 'build A')
  const aTitle = buildA.changes?.document?.title
  const delivered = requireOk(await ctx.session.tool('deliver', { designId: 'A', kind: 'sldprt' }), 'deliver A sldprt')
  const buildB = requireOk(await buildRun(ctx, 'B'), 'build B')
  const saveIndex = opIndex(ctx, (entry) => entry.op === 'save')
  const afterSave = readOps(ctx).slice(saveIndex + 1)
  const aTargets = afterSave.filter((entry) => (entry.op === 'cleanup' && entry.args.designId === 'A')
    || (entry.op === 'close' && entry.args.title === aTitle))
  const savedDoc = readDocs(ctx).find((doc) => doc.title === aTitle)
  // 再换一次 id：账本里已经没有 A，C 的清扫不该顺手把它收掉。
  const buildC = requireOk(await buildRun(ctx, 'C'), 'build C')
  const afterSaveAndC = readOps(ctx).slice(saveIndex + 1)
  const aTargetsAfterC = afterSaveAndC.filter((entry) => (entry.op === 'cleanup' && entry.args.designId === 'A')
    || (entry.op === 'close' && entry.args.title === aTitle))
  const aAfterC = readDocs(ctx).find((doc) => doc.title === aTitle)
  check('07', '存过盘的 A 文档不再进清扫：build B / build C 都不 cleanup、不 close 它', {
    deliverOk: delivered.status === 'ok',
    workerMarkedSaved: Boolean(savedDoc?.path),
    bSweptNothing: sweptOf(buildB).length === 0,
    bSweptNoA: !sweptOf(buildB).some((entry) => entry.designId === 'A'),
    noATargetAfterB: aTargets.length === 0,
    aStillOpenAfterB: Boolean(savedDoc),
    noATargetAfterC: aTargetsAfterC.length === 0,
    aStillOpenAfterC: Boolean(aAfterC?.path),
    cSweptOnlyB: sweptOf(buildC).every((entry) => entry.designId !== 'A'),
  }, { aTitle, deliveredSummary: delivered.summary, aTargets, aTargetsAfterC, docs: docsBrief(ctx) })
  timeline(ctx)
})

// ---------------------------------------------------------------- 8：清扫失败不阻断 + 退避
await scenario('s4', {}, async (ctx) => {
  const buildBoom = requireOk(await buildRun(ctx, 'BOOM'), 'build BOOM')
  // 紧接着的 build x 撞上 BOOM：cleanup{BOOM} 失败，但不阻断 x，错误码写进返回。
  const buildX = requireOk(await buildRun(ctx, 'x'), 'build x（清扫 BOOM 失败）')
  const sweptX = sweptOf(buildX)
  const boomEntry = sweptX.find((entry) => entry.designId === 'BOOM')
  // 再紧接着 build y：BOOM 进过退避（nextRetryAt = now + 2min），这轮不能再撞它。
  const buildY = requireOk(await buildRun(ctx, 'y'), 'build y（BOOM 退避期内）')
  const sweptY = sweptOf(buildY)
  // build 自己的前置 cleanup{designId} 也打 "cleanup BOOM"，所以只数 build BOOM 之后的：
  // 那一次是 x 的 sweep 撞上的，y 的 sweep 必须已被退避挡住（总数仍为 1）。
  const buildBoomIndex = opIndex(ctx, (entry) => entry.op === 'build' && entry.args.designId === 'BOOM')
  const boomSweepCleanups = readOps(ctx).slice(buildBoomIndex + 1)
    .filter((entry) => entry.op === 'cleanup' && entry.args.designId === 'BOOM')
  check('08', '清扫失败（FAKE_SWEEP_BOOM）不阻断构建，错误码进 sweptPreviousDesigns；失败退避：下一次 build 不再撞它', {
    firstBuildOk: buildBoom.status === 'ok',
    secondBuildStillOk: buildX.status === 'ok',
    thirdBuildStillOk: buildY.status === 'ok',
    sweptHasBoom: Boolean(boomEntry),
    errorCodeRecorded: boomEntry?.error === 'FAKE_SWEEP_BOOM',
    closedEmpty: Array.isArray(boomEntry?.closed) && boomEntry.closed.length === 0,
    xSweptBoom: sweptX.some((entry) => entry.designId === 'BOOM'),
    ySweptNoBoom: !sweptY.some((entry) => entry.designId === 'BOOM'),
    boomSweepAttemptedOnce: boomSweepCleanups.length === 1,
  }, {
    secondStatus: buildX.status,
    summary: buildX.summary,
    sweptX,
    sweptY,
    boomSweepCleanups,
    docs: docsBrief(ctx),
  })
  timeline(ctx)
})

// ---------------------------------------------------------------- 9：同 designId 并发（in-flight 计数）
//
// 先 build X 让账本里有 X，再同时发 build X + build Y：
//   - 第二个 X 与 Y 都在**清扫之前**登记 in-flight（计数，不是 Set）；
//   - Y 的 sweep 看到 X 还在建 → 跳过，不能把 X 的文档当旧账收掉；
//   - 两个都成功；并发结束后再 build 一次 X，把并发留下的 Y 收掉，最终只剩 1 份当前文档。
await scenario('s5', {}, async (ctx) => {
  const buildXFirst = requireOk(await buildRun(ctx, 'X'), 'build X（先让账本里有 X）')
  const [buildXSecond, buildY] = await Promise.all([buildRun(ctx, 'X'), buildRun(ctx, 'Y')])
  requireOk(buildXSecond, '并发 build X')
  requireOk(buildY, '并发 build Y')
  const sweptXSecond = sweptOf(buildXSecond)
  const sweptY = sweptOf(buildY)
  const docsDuringConcurrent = docsBrief(ctx)
  // 收尾：再建一次 X，把仍在账本里的 Y 收掉，证明并发留下的是可回收旧账。
  const buildXFinal = requireOk(await buildRun(ctx, 'X'), 'build X（收并发留下的 Y）')
  const sweptFinal = sweptOf(buildXFinal)
  const docs = readDocs(ctx)
  check('09', '同 designId 并发：in-flight 计数让 Y 不把正在建的 X 当旧账收；收尾后只剩 1 份当前文档', {
    ledgerHadX: sweptOf(buildXFirst).length === 0,
    bothOk: buildXSecond.status === 'ok' && buildY.status === 'ok',
    xSelfSweepEmpty: sweptXSecond.every((entry) => entry.designId !== 'X'),
    yDoesNotSweepX: !sweptY.some((entry) => entry.designId === 'X'),
    finalSweptY: sweptFinal.some((entry) => entry.designId === 'Y'),
    oneDocLeft: docs.length === 1,
    onlyXDocLeft: docs[0]?.designId === 'X',
  }, {
    sweptXSecond,
    sweptY,
    sweptFinal,
    docsDuringConcurrent,
    docs: docsBrief(ctx),
    timeline: readOps(ctx),
  })
  timeline(ctx)
})

// ---------------------------------------------------------------- 10：cleanup 按 result.closed 销账
//
// 真桥接器的 cleanup 只关 registry 里登记的文档。F3 之后 model action=create 建的
// newDocument 也以 "created:<标题>" 登记，所以 workspace cleanup 收得掉它 ——
// 旧契约「create 孤儿 cleanup 关不掉、只能靠按标题 close 兜」已经作废。
// 仍然必须成立的是销账方式：只按 result.closed 里的标题销账，被收掉的条目不留下
// 让后续 build 再补一次 close 的旧账。
await scenario('s6', {}, async (ctx) => {
  const buildA = requireOk(await buildRun(ctx, 'A'), 'build A')
  const aTitle = buildA.changes?.document?.title
  // 第一次 workspace cleanup：A 在 registry 里，应被关掉并且账本销账。
  const wipedA = requireOk(await ctx.session.tool('workspace', { action: 'cleanup' }), 'workspace cleanup（登记文档 A）')
  const firstWipeIndex = opIndex(ctx, (entry) => entry.op === 'cleanup' && entry.args.designId === null)
  // create C：修复后同样进 registry（"created:<标题>"）。
  const createdC = requireOk(await createRun(ctx, 'C'), 'create C')
  const cTitle = createdC.changes?.document?.title
  const cDoc = readDocs(ctx).find((doc) => doc.title === cTitle)
  // 第二次 workspace cleanup：create 文档已登记 → 这次应该关掉它。
  const wipedC = requireOk(await ctx.session.tool('workspace', { action: 'cleanup' }), 'workspace cleanup（create 文档 C）')
  const secondWipeIndex = readOps(ctx)
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.op === 'cleanup' && entry.args.designId === null)
    .at(-1)?.index ?? -1
  const cAliveAfterWipe = readDocs(ctx).some((doc) => doc.title === cTitle)
  const buildD = requireOk(await buildRun(ctx, 'D'), 'build D')
  const buildDIndex = opIndex(ctx, (entry) => entry.op === 'build' && entry.args.designId === 'D')
  const betweenWipeD = readOps(ctx).slice(secondWipeIndex + 1, buildDIndex)
  const closeC = betweenWipeD.filter((entry) => entry.op === 'close' && entry.args.title === cTitle)
  const sweptD = sweptOf(buildD)
  check('10', 'workspace cleanup 按 result.closed 销账：create 文档已登记 → cleanup 收掉它、账本销账，后续 build D 不再重复 close', {
    bareCleanupCalled: firstWipeIndex >= 0 && secondWipeIndex > firstWipeIndex,
    firstCleanupClosedA: (wipedA.changes?.closed ?? []).includes(aTitle),
    createRegistered: Boolean(cDoc?.designId),
    secondCleanupClosedC: (wipedC.changes?.closed ?? []).includes(cTitle),
    cGoneAfterWipe: !cAliveAfterWipe,
    dSweptNoC: !sweptD.some((entry) => entry.designId === 'C'),
    noRepeatedCloseForC: closeC.length === 0,
    oneDocLeft: readDocs(ctx).length === 1,
    onlyDDocLeft: readDocs(ctx)[0]?.designId === 'D',
  }, {
    aTitle,
    cTitle,
    cDoc,
    wipedAClosed: wipedA.changes?.closed,
    wipedCClosed: wipedC.changes?.closed,
    closeC,
    sweptD,
    docs: docsBrief(ctx),
  })
  timeline(ctx)
})

// ---------------------------------------------------------------- 13：账本上限（丢最旧）
//
// 为什么不用「build A → build B → build C」：每次清扫都成功时，B 的 sweep 会先把 A
// 收掉，账本长度永远 ≤ 1，上限分支根本走不到（那会测成「正常清扫」，测不到上限）。
// 要观察上限，必须让条目关不掉、留在账本里：BOOM 开头的 id 的 cleanup 一律失败（2min
// 退避窗口内不会重试），于是插入第二条时表长 2 > LIMIT=1，trimSessionDocs 丢最旧。
// 证据是服务自己写的 warn 事件（dropped/limit），以及被丢弃的条目不再有第二次 cleanup。
await scenario('s7', { env: { SW_MCP_SESSION_SWEEP_LIMIT: '1' } }, async (ctx) => {
  const first = requireOk(await buildRun(ctx, 'BOOM1'), 'build BOOM1')
  const second = requireOk(await buildRun(ctx, 'BOOM2'), 'build BOOM2（撞 BOOM1 失败 + 超上限）')
  const third = requireOk(await buildRun(ctx, 'okA'), 'build okA（撞 BOOM2 失败 + 超上限）')
  const fourth = requireOk(await buildRun(ctx, 'okB'), 'build okB（正常换 id 收 okA）')
  const dropEvents = readEvents(ctx, (event) => event.tool === 'session-sweep' && /超过上限/.test(event.message ?? ''))
  // 只数 build BOOM1 之后的 cleanup{BOOM1}：build 自己那次前置 cleanup 不算清扫尝试。
  // 被上限丢掉之后，后面 build okA 的 sweep 不会再清它（流水里仍是 1 次）。
  const firstBuildIndex = opIndex(ctx, (entry) => entry.op === 'build' && entry.args.designId === 'BOOM1')
  const boom1Cleanups = readOps(ctx).slice(firstBuildIndex + 1)
    .filter((entry) => entry.op === 'cleanup' && entry.args.designId === 'BOOM1')
  check('13', 'SW_MCP_SESSION_SWEEP_LIMIT=1：账本超上限按插入顺序丢最旧（warn 事件 dropped=1/limit=1），被丢条目不再重试', {
    buildsOk: first.status === 'ok' && second.status === 'ok' && third.status === 'ok' && fourth.status === 'ok',
    dropEventsTwice: dropEvents.length === 2,
    eachDroppedOne: dropEvents.every((event) => event.dropped === 1),
    eachLimitOne: dropEvents.every((event) => event.limit === 1),
    boom1SweepAttemptedOnce: boom1Cleanups.length === 1,
    laterSweepsHaveNoBoom: sweptOf(fourth).every((entry) => !String(entry.designId).startsWith('BOOM')),
  }, {
    dropEvents,
    boom1SweepAttemptedOnce: boom1Cleanups.length,
    secondSwept: sweptOf(second),
    thirdSwept: sweptOf(third),
    fourthSwept: sweptOf(fourth),
    docs: docsBrief(ctx),
  })
  timeline(ctx)
})

// ---------------------------------------------------------------- 14：账本 TTL（过期不回收）
await scenario('s8', { env: { SW_MCP_SESSION_SWEEP_TTL_MS: '1' } }, async (ctx) => {
  const buildA = requireOk(await buildRun(ctx, 'A'), 'build A')
  const aTitle = buildA.changes?.document?.title
  const buildAIndex = opIndex(ctx, (entry) => entry.op === 'build' && entry.args.designId === 'A')
  // 睡过 TTL（1ms），A 在账本里过期；下一次 sweep 应在扫描前把它移出，不再尝试回收。
  await sleep(60)
  const buildB = requireOk(await buildRun(ctx, 'B'), 'build B（A 已过 TTL）')
  const buildBIndex = opIndex(ctx, (entry) => entry.op === 'build' && entry.args.designId === 'B')
  const betweenAB = readOps(ctx).slice(buildAIndex + 1, buildBIndex)
  const aTargets = betweenAB.filter((entry) => (entry.op === 'cleanup' && entry.args.designId === 'A')
    || (entry.op === 'close' && entry.args.title === aTitle))
  const ttlEvents = readEvents(ctx, (event) => event.tool === 'session-sweep' && /TTL/.test(event.message ?? ''))
  check('14', 'SW_MCP_SESSION_SWEEP_TTL_MS=1：过期条目移出账本、不再回收（没有 cleanup{A}、没有 close{A 标题}）', {
    bOk: buildB.status === 'ok',
    bSweptNoA: !sweptOf(buildB).some((entry) => entry.designId === 'A'),
    noATargetBetweenAB: aTargets.length === 0,
    aDocStillOpen: readDocs(ctx).some((doc) => doc.title === aTitle),
    ttlEventRecorded: ttlEvents.length >= 1,
  }, { aTitle, betweenAB, aTargets, ttlEvents, sweptB: sweptOf(buildB), docs: docsBrief(ctx) })
  timeline(ctx)
})

// ---------------------------------------------------------------- 15-18：create 建档登记（F3）
//
// 修复前 newDocument 建完就返回，WorkRegistry 里没有它；cleanup 只关 registry 里的
// 标题，于是每个 create 都是要等退出 SOLIDWORKS 才能收掉的永久孤儿。
// 15：create 出来的文档在 registry 里带 designId；16：cleanup 能关掉它；
// 17：用户自己打开的带路径文档不被碰；18：三个建档入口都接到 RegisterCreated。
await scenario('s9', {}, async (ctx) => {
  const createdC = requireOk(await createRun(ctx, 'C'), 'create C')
  const cTitle = createdC.changes?.document?.title
  const cDoc = readDocs(ctx).find((doc) => doc.title === cTitle)
  // 用户自己打开的文档：带 path、不在 registry —— 任何回收都不许碰它。
  const userPath = join(ctx.dir, '用户自己打开的.SLDPRT')
  requireOk(await ctx.session.tool('workspace', { action: 'open', path: userPath }), 'workspace open 用户文档')
  const userDoc = readDocs(ctx).find((doc) => doc.path === userPath)
  const wiped = requireOk(await ctx.session.tool('workspace', { action: 'cleanup' }), 'workspace cleanup')
  const afterWipe = readDocs(ctx)
  const closed = wiped.changes?.closed ?? []
  check('15', 'create 建档后 designId 进 registry（不再是永久孤儿）', {
    createOk: createdC.status === 'ok',
    registered: Boolean(cDoc?.designId),
    createdPrefix: String(cDoc?.designId ?? '').startsWith('created:'),
  }, { cTitle, cDoc })
  check('16', 'cleanup 能收掉 create 建档的文档（workspace cleanup 关掉它）', {
    cleanupReported: closed.includes(cTitle),
    goneFromWorker: !afterWipe.some((doc) => doc.title === cTitle),
  }, { cTitle, closed, docs: afterWipe })
  check('17', '用户自己打开的带路径文档不被 cleanup 碰（有 path → 永不回收）', {
    userDocWasOpen: Boolean(userDoc),
    userDocStillOpen: afterWipe.some((doc) => doc.path === userPath),
    userDocNotInClosed: !closed.includes(userDoc?.title),
  }, { userPath, userDoc, closed, docs: afterWipe })

  // 18：assemblyNew / drawingNew 在假 worker 里没有分支，只能查源码接线。
  const opsSource = readFileSync(join(repoRoot, 'bridge', 'src', 'Operations.cs'), 'utf8')
  const wrapped = ['newDocument', 'assemblyNew', 'drawingNew']
    .map((op) => new RegExp(`case "${op}": return RegisterCreated\\(req,`).test(opsSource))
  check('18', '源码级：newDocument / assemblyNew / drawingNew 三个建档入口都走 RegisterCreated（补登记不遗漏）', {
    allWrapped: wrapped.every(Boolean),
    helperRecords: opsSource.includes('WorkRegistry.Record(designId, title'),
    fallbackPrefix: opsSource.includes('CreatedDesignIdPrefix + title'),
  }, { wrapped })
  timeline(ctx)
})

// ---------------------------------------------------------------- s10 / s13：unknown 不关
//
// 红线：无 designId 的 cleanup 不许「关掉 registry 里所有无路径登记项」。桥接器 registry
// 是 exe 目录下一个全局文件，历史行（旧版本写的、别的实例留下的）没有 origin 字段 ——
// 它们可能是用户手开的 零件N 同名条目。这里造两条无路径历史行（一条显式
// origin:"unknown"，一条连字段都没有），再建一个本服务自己的文档：
//   - 自己的（origin:build）要关掉，证明 cleanup 没瘫；
//   - 两条 unknown 必须留下，并且 skippedUnknown 报 2（「我为什么没关那几个」的自证）。
await scenario('s10', {}, async (ctx) => {
  const buildA = requireOk(await buildRun(ctx, 'A'), 'build A')
  const aTitle = buildA.changes?.document?.title
  const legacy1 = await seedViaJob(ctx, 'open', { path: '', title: '零件101', origin: 'unknown' }, 'seed-unknown-1')
  // 第二条模拟「registry 行有 designId 键、但没有 origin 字段」的旧版本登记。
  const legacy2 = await seedViaJob(ctx, 'open', { path: '', title: '零件102', designId: 'legacy:零件102' }, 'seed-unknown-2')
  const before = readDocs(ctx)
  const wiped = requireOk(await ctx.session.tool('workspace', { action: 'cleanup' }), 'workspace cleanup（unknown 历史行在账上）')
  const closed = wiped.changes?.closed ?? []
  const after = readDocs(ctx)
  check('s10', '无 designId 的 cleanup 不关 origin:"unknown"/缺字段的条目（历史行与用户手开同名窗口都留下）', {
    bothSeeded: ['零件101', '零件102'].every((title) => before.some((doc) => doc.title === title)),
    unknownStillOpen: ['零件101', '零件102'].every((title) => after.some((doc) => doc.title === title)),
    unknownNotInClosed: !closed.includes('零件101') && !closed.includes('零件102'),
    ownBuildClosed: closed.includes(aTitle) && !after.some((doc) => doc.title === aTitle),
  }, {
    aTitle,
    seeds: [legacy1?.state, legacy2?.state],
    closed,
    before: before.map((doc) => ({ title: doc.title, designId: doc.designId, origin: doc.origin ?? null })),
    docs: docsBrief(ctx),
  })
  check('s13', 'cleanup 返回体含 skippedUnknown，且数值等于被跳过的来源不明条目数（2）', {
    fieldPresent: typeof wiped.changes?.skippedUnknown === 'number',
    valueMatches: wiped.changes?.skippedUnknown === 2,
    summaryMentionsSkip: /跳过 2 个来源不明/.test(wiped.summary ?? ''),
    noOtherSessionSkips: (wiped.changes?.skippedOtherSession ?? 0) === 0,
  }, { skippedUnknown: wiped.changes?.skippedUnknown, skippedOtherSession: wiped.changes?.skippedOtherSession, summary: wiped.summary })
  timeline(ctx)
})

// ---------------------------------------------------------------- s11：create 的本会话条目
await scenario('s11', {}, async (ctx) => {
  const createdC = requireOk(await createRun(ctx, 'C'), 'create C')
  const cTitle = createdC.changes?.document?.title
  const wiped = requireOk(await ctx.session.tool('workspace', { action: 'cleanup' }), 'workspace cleanup（create 条目）')
  const closed = wiped.changes?.closed ?? []
  const after = readDocs(ctx)
  check('s11', 'cleanup 会关 origin:"create" 的本会话条目（create 不再游离在回收之外）', {
    closedIt: closed.includes(cTitle) && !after.some((doc) => doc.title === cTitle),
    nothingSkipped: (wiped.changes?.skippedUnknown ?? -1) === 0,
  }, { cTitle, closed, docs: after })
  timeline(ctx)
})

// ---------------------------------------------------------------- s12：别的会话不关
//
// 两个会话共用一个 SOLIDWORKS 实例时，A 的 cleanup 不能关 B 的文档。桥接器只认登记项上
// 记的 sessionId；这里用作业通道造一条 sessionId="mcp:other-session" 的 build 条目，
// 再跑本会话的 cleanup：它必须留下，并在 skippedOtherSession 里报 1。
await scenario('s12', {}, async (ctx) => {
  const buildA = requireOk(await buildRun(ctx, 'A'), 'build A')
  const aTitle = buildA.changes?.document?.title
  const foreign = await seedViaJob(ctx, 'build', {
    definition: { designId: 'other-session-design', units: 'mm', params: {}, features: [] },
    sessionId: 'mcp:other-session',
  }, 'seed-foreign-build')
  const foreignDocs = readDocs(ctx).filter((doc) => doc.sessionId === 'mcp:other-session')
  const wiped = requireOk(await ctx.session.tool('workspace', { action: 'cleanup' }), 'workspace cleanup（别的会话在建）')
  const closed = wiped.changes?.closed ?? []
  const after = readDocs(ctx)
  const cleanupOps = readOps(ctx).filter((entry) => entry.op === 'cleanup' && entry.args.designId === null)
  const lastCleanupArgs = cleanupOps.at(-1)?.args ?? {}
  check('s12', '跨会话：别的 sessionId 的 build 条目不被本会话 cleanup 关掉，并计入 skippedOtherSession', {
    foreignSeeded: foreign?.state === 'succeeded' && foreignDocs.length === 1,
    ownBuildClosed: closed.includes(aTitle) && !after.some((doc) => doc.title === aTitle),
    foreignStillOpen: after.some((doc) => doc.sessionId === 'mcp:other-session'),
    foreignNotInClosed: !closed.some((title) => foreignDocs.some((doc) => doc.title === title)),
    skipReported: wiped.changes?.skippedOtherSession === 1,
    cleanupCarriedSession: lastCleanupArgs.sessionId === `mcp:${ctx.session.child.pid}`,
  }, {
    aTitle,
    foreignDocs: foreignDocs.map((doc) => ({ title: doc.title, sessionId: doc.sessionId })),
    closed,
    skippedOtherSession: wiped.changes?.skippedOtherSession,
    lastCleanupArgs,
    docs: docsBrief(ctx),
  })
  timeline(ctx)
})

// ---------------------------------------------------------------- 12：收尾
rmSync(root, { recursive: true, force: true })
check('12', '收尾：临时目录已删、所有会话与 broker 已关闭、进程正常退出（exit 0）', {
  tempGone: !existsSync(root),
  allSessionsClosed: sessions.every((ctx) => ctx.closed === true),
}, {
  sessions: sessions.map((ctx) => ({ name: ctx.name, closed: ctx.closed })),
  exitCode: process.exitCode ?? 0,
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exitCode = 1
}
