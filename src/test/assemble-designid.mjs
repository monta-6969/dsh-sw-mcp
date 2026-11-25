// 装配体 designId 的离线回归：model action="assemble" 必须把 designId 传给桥接器。
//
// 这条用例来自一个真机 bug（装配体建完就永久 DOC_NOT_OPEN）：
//   1. server.mjs 的 assemble 分支调 assemblyNew 只传 { path }，（旧代码）从不带 designId；
//   2. 桥接器 Operations.cs 的 RegisterCreated 拿不到 designId，就用 "created:" + 标题兜底；
//   3. 于是 WorkRegistry 里这条登记键是 created:装配体1，而不是调用方以为的 drawer_asm；
//   4. 之后 inspect action="assembly" → components → RequireDesignDocument 是**按 designId
//      查这张登记表**的，查不到就报 DOC_NOT_OPEN —— 文档明明开着，却永远说没开。
//
// 同一处还有第二个缺陷（Assembly.cs）：标题在 SaveAs3 **之前**读取。存盘会把文档改名
// （Operations.cs 存盘路径的原话：「Saving under a new name renames the document」），
// 所以存盘前读到的是模板默认名「装配体1」，存盘后才是 drawer-asm；而 DesignDocument
// 回头是 Documents.Activate(entry.Title) **按这个标题找窗口**的。两处都得对，只修一处
// 仍然找不到。
//
// 这里全部用假 broker + 假 worker，不需要 SOLIDWORKS，能进 CI：
//   - assemble 带 designId   → assemblyNew 请求体必须带同一个 designId（修复前为 undefined）
//   - assemble 不带 designId → 请求体必须**不含** designId 字段（向后兼容，别传 undefined）
//   - 装配体建档必须仍是「一个可回收的建档」：sessionId 照样带上（SESSION_SCOPED_OPS）
//   - 源码级：Assembly.cs 的 title 读取必须排在 SaveAs3 之后（C# 桩无法在 CI 里跑）
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession, repoRoot } from './lib/mcp.mjs'
import { BrokerClient } from '../server/broker/client.mjs'

const root = mkdtempSync(join(tmpdir(), 'sw-assemble-designid-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) passed++
  else failures.push(`${name}: ${JSON.stringify(detail)}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
}

/**
 * 假 worker：只认 assemble 需要的那两个 op，把每次请求的 args 原样记进 ops.jsonl。
 *
 * 这里**故意不复刻**桥接器的兜底逻辑（"created:" + title），因为要验的是「server 发出去
 * 的请求体里到底有没有 designId」—— 兜底是下游的事，混进来只会让断言变模糊。
 */
function fakeWorkerSource(opsPath) {
  return `
import { appendFileSync } from 'node:fs'
const OPS = ${JSON.stringify(opsPath)}
const NL = String.fromCharCode(10)
let serial = 1
function record(op, args) {
  appendFileSync(OPS, JSON.stringify({ op, args }) + NL)
}
function handle(op, args) {
  switch (op) {
    case 'instances': return { result: { instances: [] } }
    case 'version': return { result: { ready: true, revision: 'fake-assemble' } }
    case 'status': return { result: { ready: true, revision: 'fake-assemble', documents: [] } }
    case 'cleanup': return { result: { closed: [], remaining: 0, skippedUnknown: 0, skippedOtherSession: 0 } }
    case 'assemblyNew': {
      // 复刻真桥接器：没有 designId 时用 "created:" + 标题兜底；有则原样用。
      const title = '装配体' + serial
      serial += 1
      const designId = args.designId ?? ('created:' + title)
      return { result: { document: { title, path: args.path ?? '', type: 'assembly' }, saved: Boolean(args.path), designId } }
    }
    case 'componentInsert':
      return { result: { assembly: { title: '装配体1', path: args.path ?? '' }, inserted: (args.components ?? []).map((c) => ({ name: 'c', path: c.path, placement: 'bbox-center' })), failed: [], saved: Boolean(args.path), componentCount: (args.components ?? []).length } }
    case 'newDocument': {
      // 同样只回显、不兜底：验的是 server 发出去的请求体。
      const title = '零件' + serial
      serial += 1
      const designId = args.designId ?? ('created:' + title)
      return { result: { document: { title, path: '', template: args.template ?? '' }, designId } }
    }
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
    record(op, args)
    let outcome
    try { outcome = handle(op, args) } catch (error) {
      outcome = { error: { code: 'FAKE_WORKER_ERROR', message: String(error && error.message ? error.message : error) } }
    }
    const payload = outcome.error ? { id, ok: false, error: outcome.error } : { id, ok: true, ...outcome.result }
    process.stdout.write(JSON.stringify(payload) + NL)
  }
})
process.stdin.on('end', () => process.exit(0))
`
}

const sessions = []
async function openAsmSession(name) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const opsPath = join(dir, 'ops.jsonl')
  writeFileSync(opsPath, '')
  const workerPath = join(dir, 'fake-worker.mjs')
  writeFileSync(workerPath, fakeWorkerSource(opsPath))
  const pipe = '\\\\.\\pipe\\sw-assemble-designid-' + process.pid + '-' + Date.now() + '-' + name
  const env = {
    ...process.env,
    SW_MCP_BROKER: '1',
    SW_MCP_BROKER_PIPE: pipe,
    SW_MCP_BROKER_DIR: join(dir, 'broker'),
    SW_MCP_BROKER_WORKER_CMD: JSON.stringify([process.execPath, workerPath]),
    SW_MCP_DATA: join(dir, 'data'),
    SW_MCP_INSTANCES_FILE: join(dir, 'instances.json'),
    SW_MCP_TEST: '1',
    SW_MCP_SESSION_SWEEP: '1',
  }
  // 不设 SW_MCP_BROKER_ENSURE：绝不探 ROT、绝不启动 SOLIDWORKS。
  delete env.SW_MCP_BROKER_ENSURE
  delete env.SW_MCP_SESSION_ID
  delete env.SW_MCP_BROKER_INSTANCE
  const session = openSession({ env })
  const ctx = { name, dir, pipe, opsPath, session }
  sessions.push(ctx)
  await session.start()
  return ctx
}

async function closeAsmSession(ctx) {
  try { ctx.session.child.kill() } catch { /* 已经在退 */ }
  if (ctx.session.child.exitCode === null) await Promise.race([once(ctx.session.child, 'exit'), sleep(2000)])
  try {
    const client = await BrokerClient.connect({ pipe: ctx.pipe, spawnIfMissing: false, timeoutMs: 3000 })
    try { await client.request('shutdown', {}, { timeoutMs: 2000 }) } finally { client.close() }
  } catch { /* broker 已经没了 */ }
  await sleep(250)
  try { rmSync(ctx.dir, { recursive: true, force: true }) } catch { /* 占用中的文件留到下一轮 */ }
}

function readOps(ctx) {
  try {
    return readFileSync(ctx.opsPath, 'utf8').split('\n').map((line) => line.trim())
      .filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

const assembleArgs = {
  components: [{ path: 'D:\\fake\\part-a.SLDPRT', x: 0, y: 0, z: 0 }],
  outputPath: 'D:\\fake\\drawer-asm.SLDASM',
}

// ── 1. 带 designId：请求体必须带上它（这就是那个 bug）──────────────────
{
  console.log('\n--- 带 designId ---')
  const ctx = await openAsmSession('with-designid')
  try {
    const designId = 'drawer_asm'
    const result = await ctx.session.tool('model', { action: 'assemble', designId, ...assembleArgs })
    const ops = readOps(ctx)
    const newOps = ops.filter((entry) => entry.op === 'assemblyNew')
    const insertOps = ops.filter((entry) => entry.op === 'componentInsert')
    console.log(`  assemblyNew 请求体：${JSON.stringify(newOps.map((entry) => entry.args))}`)

    check('assemble 成功返回', result.status === 'ok', result?.summary)
    check('assemblyNew 被调用了一次', newOps.length === 1, newOps.length)
    // 核心断言：修复前这里是 undefined。
    check('assemblyNew 收到了 designId',
      newOps[0]?.args?.designId === designId,
      { got: newOps[0]?.args?.designId ?? null, expected: designId, rawArgs: newOps[0]?.args })
    check('designId 是调用方传的那个值（没被改名/加前缀）',
      newOps[0]?.args?.designId === designId && !String(newOps[0]?.args?.designId).startsWith('created:'),
      newOps[0]?.args?.designId)
    check('存盘路径照旧传下去', newOps[0]?.args?.path === assembleArgs.outputPath, newOps[0]?.args?.path)
    // 建档请求仍要走会话级注入（SESSION_SCOPED_OPS 里有 assemblyNew）。
    check('assemblyNew 仍带本会话 sessionId',
      typeof newOps[0]?.args?.sessionId === 'string' && newOps[0].args.sessionId.length > 0,
      newOps[0]?.args?.sessionId)
    check('componentInsert 照旧执行', insertOps.length === 1 && result.changes?.components?.length === 1,
      { insertOps: insertOps.length, placed: result.changes?.components?.length })
  } finally {
    await closeAsmSession(ctx)
  }
}

// ── 2. 不带 designId：请求体必须不含这个键（向后兼容）─────────────────
//
// 老路子（如 test/m5.mjs、test/assembly-parallel.mjs）不传 designId，靠桥接器的
// "created:" 兜底。修复不能把这条路改坏，也不能塞一个 "designId": undefined 进去。
{
  console.log('\n--- 不带 designId（向后兼容）---')
  const ctx = await openAsmSession('without-designid')
  try {
    const result = await ctx.session.tool('model', { action: 'assemble', ...assembleArgs })
    const newOps = readOps(ctx).filter((entry) => entry.op === 'assemblyNew')
    console.log(`  assemblyNew 请求体：${JSON.stringify(newOps.map((entry) => entry.args))}`)
    const hasKey = newOps.length === 1 && Object.prototype.hasOwnProperty.call(newOps[0].args, 'designId')

    check('assemble 仍然成功返回', result.status === 'ok', result?.summary)
    check('assemblyNew 被调用了一次', newOps.length === 1, newOps.length)
    // 核心断言：不能传 undefined，也不能传空串 —— 字段本身就不该出现。
    check('请求体不含 designId 字段',
      newOps.length === 1 && hasKey === false,
      { hasDesignIdKey: hasKey, rawArgs: newOps[0]?.args })
    check('请求体里没有 undefined / null / 空串形式的 designId',
      newOps[0]?.args?.designId === undefined,
      { designIdValue: newOps[0]?.args?.designId ?? null })
    check('path 照旧传下去', newOps[0]?.args?.path === assembleArgs.outputPath, newOps[0]?.args?.path)
  } finally {
    await closeAsmSession(ctx)
  }
}

// ── 3. model action="create" → newDocument：同一类缺陷的第二处 ─────────
//
// 与 assemble 完全同构：newDocument 也走 Operations.cs:152 的 RegisterCreated，
// 拿不到 designId 就把登记键记成 created:零件N；而之后 inspect/save 走
// RequireDesignDocument → DesignDocument，是**按 designId 精确查 WorkRegistry** 的
// （Operations.cs:1608-1611），用户那个 designId 永远查不到 → DOC_NOT_OPEN。
//
// 注意这里**不能**拿 trackSessionDoc 当反证：它写的 sessionDocs 只服务
// sweepOtherDesigns/cleanup（server.mjs:1912-1988），而 RequireDesignDocument 读的是
// 桥接器侧的 WorkRegistry —— 两张不同的表，补前者救不了后者。
{
  console.log('\n--- model create 带 designId ---')
  const ctx = await openAsmSession('create-with-designid')
  try {
    const designId = 'blank_part_v1'
    const result = await ctx.session.tool('model', { action: 'create', designId })
    const newOps = readOps(ctx).filter((entry) => entry.op === 'newDocument')
    console.log(`  newDocument 请求体：${JSON.stringify(newOps.map((entry) => entry.args))}`)

    check('model create 成功返回', result.status === 'ok', result?.summary)
    check('newDocument 被调用了一次', newOps.length === 1, newOps.length)
    // 核心断言：修复前这里是 undefined。传空就白建，文档从此查不到。
    check('newDocument 收到了 designId',
      newOps[0]?.args?.designId === designId,
      { got: newOps[0]?.args?.designId ?? null, expected: designId, rawArgs: newOps[0]?.args })
    check('create 的 designId 不是 created: 兜底键',
      typeof newOps[0]?.args?.designId === 'string'
        && !newOps[0].args.designId.startsWith('created:'),
      newOps[0]?.args?.designId)
    check('create 仍带本会话 sessionId',
      typeof newOps[0]?.args?.sessionId === 'string' && newOps[0].args.sessionId.length > 0,
      newOps[0]?.args?.sessionId)
    check('返回体照旧带 document.title', typeof result.changes?.document?.title === 'string',
      result.changes?.document?.title)
  } finally {
    await closeAsmSession(ctx)
  }
}

// ── 3b. model create 不带 designId：请求体必须不含这个键 ────────────────
{
  console.log('\n--- model create 不带 designId（向后兼容）---')
  const ctx = await openAsmSession('create-without-designid')
  try {
    const result = await ctx.session.tool('model', { action: 'create' })
    const newOps = readOps(ctx).filter((entry) => entry.op === 'newDocument')
    console.log(`  newDocument 请求体：${JSON.stringify(newOps.map((entry) => entry.args))}`)
    const hasKey = newOps.length === 1 && Object.prototype.hasOwnProperty.call(newOps[0].args, 'designId')

    check('model create 仍然成功返回', result.status === 'ok', result?.summary)
    check('newDocument 被调用了一次', newOps.length === 1, newOps.length)
    check('create 请求体不含 designId 字段',
      newOps.length === 1 && hasKey === false,
      { hasDesignIdKey: hasKey, rawArgs: newOps[0]?.args })
    check('create 请求体里没有 undefined / null / 空串形式的 designId',
      newOps[0]?.args?.designId === undefined,
      { designIdValue: newOps[0]?.args?.designId ?? null })
  } finally {
    await closeAsmSession(ctx)
  }
}

// ── 3c. 源码级：server.mjs 的 create 分支必须调 resolveDesignId ─────────
//
// 3/3b 验的是运行行为；这条钉住「接线」本身，防止将来有人把参数改成直接传
// args.designId（那样没传时就会塞一个 undefined 进请求体）。
{
  console.log('\n--- 源码级：create 分支接线 ---')
  const source = readFileSync(join(repoRoot, 'server', 'server.mjs'), 'utf8')
  const createAt = source.indexOf('async function handlePartCreate(')
  const nextFn = createAt >= 0 ? source.indexOf('\nasync function ', createAt + 10) : -1
  const body = createAt >= 0 ? source.slice(createAt, nextFn > createAt ? nextFn : createAt + 6000) : ''
  const resolvedAt = body.indexOf('resolveDesignId(args.designId)')
  const callAt = body.indexOf("callBridge('newDocument'")
  console.log(`  handlePartCreate 里 resolveDesignId 位置=${resolvedAt}，newDocument 调用位置=${callAt}`)
  check('能定位 handlePartCreate()', createAt >= 0 && body.length > 0, { createAt })
  check('create 分支解析了 designId', resolvedAt >= 0, resolvedAt)
  check('newDocument 调用存在', callAt >= 0, callAt)
  check('解析发生在发送之前', resolvedAt >= 0 && callAt >= 0 && resolvedAt < callAt,
    { resolveAt: resolvedAt, callAt })
}

// ── 4. 源码级：Assembly.cs 的标题必须在 SaveAs3 之后读 ─────────────────
//
// C# 编译不进 CI，但这一处缺陷的本质是**两个语句的先后顺序**，在源码上可以直接判定。
// 判据：在 New() 方法体里，SaveAs3 调用必须出现在 string title = doc.GetTitle() 之前。
{
  console.log('\n--- 源码级：Assembly.cs 标题读取时机 ---')
  const cs = readFileSync(join(repoRoot, 'bridge', 'src', 'Assembly.cs'), 'utf8')
  // 只取 New() 这一段：从 "public static ... New(" 到下一个 "public static"。
  const start = cs.indexOf('public static Dictionary<string, object> New(')
  const nextPublic = start >= 0 ? cs.indexOf('public static', start + 10) : -1
  const body = start >= 0 ? cs.slice(start, nextPublic > start ? nextPublic : cs.length) : ''
  const saveAt = body.indexOf('SaveAs3')
  const titleAt = body.indexOf('string title = doc.GetTitle()')
  console.log(`  New() 里 SaveAs3 位置=${saveAt}，title 读取位置=${titleAt}`)

  check('能在 Assembly.cs 里定位 New() 方法', start >= 0 && body.length > 0, { start })
  check('New() 里确实调用了 SaveAs3', saveAt >= 0, saveAt)
  check('New() 里确实读取了标题', titleAt >= 0, titleAt)
  // 核心断言：修复前 title 在 SaveAs3 之前（titleAt < saveAt）。
  check('标题在 SaveAs3 之后才读（存盘会把文档改名）',
    saveAt >= 0 && titleAt >= 0 && titleAt > saveAt,
    { saveAs3At: saveAt, titleReadAt: titleAt })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAILED: ${failure}`)
  process.exitCode = 1
}
