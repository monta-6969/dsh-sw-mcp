// EQUATION_MANAGER_REJECTED 的守门测试（K1，第四轮）。
//
// 背景：那个「宁可在这里失败，也不要把静态件当成参数化件交出去」的检查，曾经
// 遍历的是建特征**之前**刚 new 出来的空 `variables` 表（真正填表的
// `PushGlobalVariables()` 在 `BuildFeatures` 之后），于是 rejected 恒为 0、
// 分支不可达：方程式被拒只落进 notes，模型以为参数化成功、拿到的是静态件。
//
// C# 分支没法在 node 里直接驱动，所以这里分两层钉住：
//   A) 源码顺序护栏：扫 bridge/src/Operations.cs，断言「真实回执」的扫描必须排在
//      `variables = c.PushGlobalVariables();` 之后、`EQUATION_MANAGER_REJECTED`
//      之前，并且不再在空表上统计（防止有人把这行顺序改回去）；
//   B) 契约接线：假 worker 让桥接器回 EQUATION_MANAGER_REJECTED，MCP 必须原样
//      把它交给调用方（status=failed + 码名不变 + 被拒参数名 + 指路），而没被拒时
//      回包里不许出现这个码。
//
// 全离线：broker + 本文件现写的假 worker，不设 SW_MCP_BROKER_ENSURE（不探 ROT、
// 不起 SOLIDWORKS），也不碰任何 *-live.mjs / suite.mjs。
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession, repoRoot } from './lib/mcp.mjs'
import { BrokerClient } from '../server/broker/client.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

// ── A. 源码顺序护栏 ───────────────────────────────────────────────────────
// 这五条直接对 K1 的失效形态下断言：检查读的必须是填充之后的表，而且仍然
// 保留「字面值兜底已覆盖就不失败」和「部分被拒不许报 equation」这两条边界。
{
  const source = readFileSync(join(repoRoot, 'bridge', 'src', 'Operations.cs'), 'utf8')
  const declAt = source.indexOf('List<object> variables = new List<object>();')
  const pushAt = source.indexOf('variables = c.PushGlobalVariables();')
  const scanAt = source.indexOf('foreach (object entry in variables)')
  const throwAt = source.indexOf('throw new BridgeError("EQUATION_MANAGER_REJECTED"')

  check('A1 三个锚点都在源文件里（表声明 / 填表 / 被拒抛错）',
    declAt > 0 && pushAt > 0 && scanAt > 0 && throwAt > 0,
    { declAt, pushAt, scanAt, throwAt })
  check('A2 扫描排在 PushGlobalVariables() 之后（不再遍历空表）',
    scanAt > pushAt, { scanAt, pushAt })
  check('A3 EQUATION_MANAGER_REJECTED 的抛点在扫描之后、且依赖真实回执',
    throwAt > scanAt
      && source.slice(scanAt, throwAt).includes('literalCovered')
      && source.slice(scanAt, throwAt).includes('RequestedBinds'),
    { throwAt, scanAt })
  // 空表扫不了任何东西：声明与填表之间不许再出现 rejected++（旧缺陷的形状）。
  check('A4 声明与填表之间没有任何 rejected 统计（旧缺陷不会悄悄复活）',
    declAt > 0 && pushAt > declAt && !source.slice(declAt, pushAt).includes('rejected++'),
    { between: source.slice(declAt, pushAt).trim().slice(0, 200) })
  check('A5 部分被拒时 drivers.mode 降级为 literal（不把「有的没绑上」报成 equation）',
    source.includes('"mode", equationDriven && rejectedParams.Count == 0 ? "equation" : "literal"')
      && source.includes('equations partially rejected'),
    'drivers.mode 表达式 + notes 说明')
}

// ── B. 假 worker：桥接器怎么回，MCP 就怎么交代 ─────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'sw-equation-reject-'))
const workDir = join(root, 's1')
mkdirSync(workDir, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// designId 以 eq-reject 开头 → 回 EQUATION_MANAGER_REJECTED；其余 → 回正常 build。
// 两种回包的字段照真桥接器（Operations.Build 的返回体）写，含 drivers 的三个键。
const workerSource = `
const NL = String.fromCharCode(10)
function buildResult(designId) {
  return {
    document: { title: '零件1', path: '' },
    features: [{ id: 'plate', kind: 'extrude', featureName: '拉伸1' }],
    globalVariables: [
      { name: 'plate_w', param: 'plate.w', value: 100, rc: -1, mode: 'added', text: '"plate_w" = 100' },
      { name: 'plate_h', param: 'plate.h', value: 60, rc: -1, mode: 'added', text: '"plate_h" = 60' },
      { name: 'plate_t', param: 'plate.t', value: 20, rc: -1, mode: 'added', text: '"plate_t" = 20' },
    ],
    derivedVariables: [],
    bindings: {},
    dimensionBindings: { 'plate.w': 'D1@plate_outline@零件1.Part' },
    bindingRequested: 3,
    drivers: {
      mode: 'literal',
      accepted: 0,
      appliedLiteral: 3,
      requested: 3,
      note: 'the equation manager refused 3/3 variables (plate.w, plate.h, plate.t); those parameters are baked into the geometry as literal values, so edits to them rebuild the part from the definition',
    },
    parameters: { resolved: { 'plate.w': 100, 'plate.h': 60, 'plate.t': 20 } },
    geometry: {
      massProperties: { volume: 120000 },
      boundingBox: { size: [100, 60, 20], min: [0, 0, 0], max: [100, 60, 20] },
      holes: [],
    },
    steps: [],
    builderSteps: [],
    notes: ['feature 1 sketch id=plate_outline', 'global variable plate_w returned rc=-1'],
  }
}
function handle(op, args) {
  if (op === 'instances') return { instances: [] }
  if (op === 'version') return { ready: true, revision: 'fake-equation-reject' }
  if (op === 'status') return { ready: true, revision: 'fake-equation-reject', documents: [] }
  if (op === 'cleanup') return { closed: [], remaining: 0 }
  if (op === 'inspect') return { geometry: { massProperties: { volume: 120000 }, boundingBox: { size: [100, 60, 20] }, holes: [] } }
  if (op === 'build') {
    const designId = args.definition?.designId ?? ''
    if (designId.startsWith('eq-reject')) {
      return {
        __error: {
          code: 'EQUATION_MANAGER_REJECTED',
          message: 'SOLIDWORKS 拒绝了写方程式（3/3 条），被拒参数：plate.w, plate.h, plate.t。'
            + '请求了 3 条尺寸绑定，方程式一条也没落地、字面值兜底也只落了 0 条：这个件从出生就是静态的，改参数不会动。'
            + '首次失败的方程式（SW 原话）："plate_w" = 100 → rc=-1',
          detail: {
            rejected: 3,
            attempted: 3,
            parameters: ['plate.w', 'plate.h', 'plate.t'],
            rejections: ['"plate_w" = 100 → rc=-1', '"plate_h" = 60 → rc=-1', '"plate_t" = 20 → rc=-1'],
            firstRejection: '"plate_w" = 100 → rc=-1',
            bindings: 0,
            requested: 3,
            appliedLiteral: 0,
          },
        },
      }
    }
    return buildResult(designId)
  }
  return { __error: { code: 'FAKE_UNKNOWN_OP', message: op } }
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
      outcome = { __error: { code: 'FAKE_WORKER_ERROR', message: String(error && error.message ? error.message : error) } }
    }
    const payload = outcome.__error ? { id, ok: false, error: outcome.__error } : { id, ok: true, ...outcome }
    process.stdout.write(JSON.stringify(payload) + NL)
  }
})
process.stdin.on('end', () => process.exit(0))
`
const workerPath = join(workDir, 'fake-worker.mjs')
writeFileSync(workerPath, workerSource)

const pipe = '\\\\.\\pipe\\sw-equation-reject-' + process.pid + '-' + Date.now()
const env = {
  ...process.env,
  SW_MCP_BROKER: '1',
  SW_MCP_BROKER_PIPE: pipe,
  SW_MCP_BROKER_DIR: join(workDir, 'broker'),
  SW_MCP_BROKER_WORKER_CMD: JSON.stringify([process.execPath, workerPath]),
  SW_MCP_DATA: join(workDir, 'data'),
  SW_MCP_SESSION_SWEEP: '0',
}
// 关键：不设 SW_MCP_BROKER_ENSURE —— 默认不探 ROT、不启动 SOLIDWORKS。
delete env.SW_MCP_BROKER_ENSURE
delete env.SW_MCP_SESSION_ID
delete env.SW_MCP_BROKER_INSTANCE

const definition = {
  params: { 'plate.w': 100, 'plate.h': 60, 'plate.t': 20 },
  features: [
    {
      kind: 'sketch',
      id: 'plate_outline',
      plane: 1,
      primitives: [{ shape: 'rect', center: [0, 0], width: 'plate.w', height: 'plate.h', bind: { width: 'plate.w', height: 'plate.h' } }],
    },
    { kind: 'extrude', id: 'plate', profile: 'plate_outline', depth: 'plate.t', direction: '+Y', bind: { depth: 'plate.t' } },
  ],
}

const session = openSession({ env })
try {
  await session.start()

  // ── B1. 桥接器报被拒：MCP 必须原样交出去，不许吞成 ok ────────────────────
  const rejected = await session.tool('model', {
    action: 'build',
    definition: { ...definition, designId: 'eq-reject-1' },
  })
  const rejectedError = rejected.extra?.error ?? {}
  const rejectedText = JSON.stringify(rejected)
  check('B1 被拒时 status=failed（不是 ok）', rejected.status === 'failed',
    { status: rejected.status, summary: rejected.summary })
  check('B2 错误码保持 EQUATION_MANAGER_REJECTED',
    rejectedError.code === 'EQUATION_MANAGER_REJECTED', rejectedError.code)
  check('B3 消息里列出被拒的参数名与 SW 原话（rc=-1）',
    /plate\.w/.test(String(rejectedError.message)) && /plate\.h/.test(String(rejectedError.message))
      && /rc=-1/.test(String(rejectedError.message)),
    rejectedError.message)
  // 桥接器把 rejected/attempted/parameters/firstRejection 放在 detail 里，但这一跳
  // （broker 作业错误）只把 details 写进 job.error，而 server.mjs 的 sendViaBroker 读的是
  // error.detail，于是 detail 被压缩成 {jobId,state} —— 这是既有接线缺陷（server.mjs 不在
  // 本轮写域），所以这里不要求结构化 detail，只要求「消息自带全部事实」：
  // 被拒条数、被拒参数名、SW 原话（方程式文本 + rc）。
  const rejectedMessage = String(rejectedError.message ?? '')
  check('B4 消息自带被拒条数/参数名/SW 原话（detail 会被 broker 边界压缩）',
    /3\/3/.test(rejectedMessage)
      && /plate\.w, plate\.h, plate\.t/.test(rejectedMessage)
      && /"plate_w" = 100 → rc=-1/.test(rejectedMessage)
      && rejectedError.detail !== undefined,
    { message: rejectedMessage, detail: rejectedError.detail })
  check('B5 指路没丢：要求退出 SOLIDWORKS 重开并重建',
    Array.isArray(rejected.nextActions)
      && rejected.nextActions.some((item) => String(item).includes('SOLIDWORKS'))
      && rejected.nextActions.some((item) => String(item).includes('build')),
    rejected.nextActions)
  check('B6 被拒的返回体里没有假装有绑定（bindings 不出现非空对象）',
    !/\"bindings\"\s*:\s*\{\s*\"/.test(rejectedText), 'no fake bindings')

  // ── B2. 没被拒：回包干净，不许出现这个码 ──────────────────────────────────
  const okBuild = await session.tool('model', {
    action: 'build',
    definition: { ...definition, designId: 'equation-ok-1' },
  })
  const okText = JSON.stringify(okBuild)
  check('B7 未被拒时 build 仍然 ok', okBuild.status === 'ok', okBuild.summary)
  check('B8 未被拒的回包里不出现 EQUATION_MANAGER_REJECTED',
    !okText.includes('EQUATION_MANAGER_REJECTED'), { summary: okBuild.summary })
  check('B9 未被拒时 drivers.mode 与 bindings 原样透出（成功路径字段名没改）',
    okBuild.changes?.drivers?.mode === 'literal'
      && okBuild.changes?.bindings !== undefined
      && okBuild.changes?.drivers?.requested === 3
      && okBuild.measurements?.volume === 120000,
    { drivers: okBuild.changes?.drivers, bindings: okBuild.changes?.bindings })
  check('B10 部分/全部被拒的说明进了 notes，不是静默',
    (okBuild.changes?.notes ?? []).some((line) => /rc=-1/.test(String(line)))
      || /refused/.test(String(okBuild.changes?.drivers?.note ?? '')),
    { notes: okBuild.changes?.notes, driverNote: okBuild.changes?.drivers?.note })
} finally {
  try { session.child.kill() } catch { /* 已经在退 */ }
  if (session.child.exitCode === null) await Promise.race([once(session.child, 'exit'), sleep(2000)])
  try {
    const client = await BrokerClient.connect({ pipe, spawnIfMissing: false, timeoutMs: 3000 })
    try { await client.request('shutdown', {}, { timeoutMs: 2000 }) } finally { client.close() }
  } catch { /* broker 已经没了 */ }
  await sleep(250)
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 占用中的文件留到下一轮 */ }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
