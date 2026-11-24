// 设计契约的离线回归：edit 的事务、漂移检测、档位验收。
// 用假 broker + 假 worker，不需要 SOLIDWORKS。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession } from './lib/mcp.mjs'
import { BrokerClient } from '../server/broker/client.mjs'
import { buildDesign, buildManifest, designFileFor, hashFile, manifestFileFor, writeJsonAtomic } from '../server/design-store.mjs'

const root = mkdtempSync(join(tmpdir(), 'sw-design-contract-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) passed += 1
  else failures.push(`${name}: ${JSON.stringify(detail)}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
}

const CAD = join(root, 'C04-02.SLDPRT')
const failSentinel = join(root, 'fail-save')
writeFileSync(CAD, 'v1')

const geometryV1 = {
  bodies: 1,
  massProperties: { volume: 24280.7 },
  boundingBox: { size: [60, 120, 6] },
  holes: [{ diameter: 42, axisPoint: [0, 30, 0] }, { diameter: 42, axisPoint: [0, -30, 0] }],
}
const geometryV2 = { ...geometryV1, massProperties: { volume: 24280.7 } }

function fakeWorkerSource(opsPath) {
  return `
import { appendFileSync, writeFileSync, existsSync } from 'node:fs'
const OPS = ${JSON.stringify(opsPath)}
const NL = String.fromCharCode(10)
const CAD = ${JSON.stringify(CAD)}
const G1 = ${JSON.stringify(geometryV1)}
const G2 = ${JSON.stringify(geometryV2)}
const FAIL_SENTINEL = ${JSON.stringify(failSentinel)}
function record(op, args) { appendFileSync(OPS, JSON.stringify({ op, args }) + NL) }
function handle(op, args) {
  switch (op) {
    case 'instances': return { instances: [] }
    case 'version': return { ready: true, revision: 'fake-design' }
    case 'status': return { ready: true, revision: 'fake-design', documents: [{ title: 'C04-02', path: CAD, saved: true }] }
    case 'cleanup': return { closed: [], remaining: 0 }
    case 'documents': return { documents: [{ title: 'C04-02', path: CAD, saved: true }] }
    case 'inspect': return { document: { title: 'C04-02', path: CAD }, geometry: G1 }
    case 'edit': return { geometry: G2, applied: [{ param: 'pitch', mode: 'dimension' }], driven: [{ param: 'pitch', bound: true }], missing: [], dimensionBindings: {} }
    case 'save': {
      if (existsSync(FAIL_SENTINEL)) return { saved: false, errors: 1 }
      writeFileSync(args.path ?? CAD, 'v2')
      return { saved: true, bytes: 2, path: CAD, repairedEquations: 0 }
    }
    case 'capture': return { saved: false }
    default: return {}
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
    try { outcome = handle(op, args) } catch (error) { outcome = { __error: String(error && error.message ? error.message : error) } }
    const payload = outcome.__error ? { id, ok: false, error: { code: 'FAKE_ERROR', message: outcome.__error } } : { id, ok: true, ...outcome }
    process.stdout.write(JSON.stringify(payload) + NL)
  }
})
process.stdin.on('end', () => process.exit(0))
`
}

const workerDir = join(root, 'worker')
mkdirSync(workerDir, { recursive: true })
const opsPath = join(workerDir, 'ops.jsonl')
writeFileSync(opsPath, '')
const workerPath = join(workerDir, 'fake-worker.mjs')
writeFileSync(workerPath, fakeWorkerSource(opsPath))
const pipe = '\\\\.\\pipe\\sw-design-contract-' + process.pid + '-' + Date.now()
const dataDir = join(root, 'data')
mkdirSync(join(dataDir, 'projects'), { recursive: true })

const design = buildDesign({
  designId: 'c04-02', partId: 'C04-02',
  definition: { schemaVersion: 3, designId: 'c04-02', params: { pitch: 60, width: 60 }, features: [] },
  revision: 1,
  expectations: { volume: 24280.7, boundingBox: [60, 120, 6], bodies: 1, holes: [{ diameter: 42, count: 2 }], holePositions: [{ diameter: 42, at: [0, 30] }, { diameter: 42, at: [0, -30] }], pitches: [{ a: [0, 30], b: [0, -30], distance: 60 }] },
  cadPath: CAD,
})
writeJsonAtomic(designFileFor(CAD), design)
writeJsonAtomic(manifestFileFor(CAD), buildManifest({ design, cadPath: CAD, cadBytes: 2, cadHash: hashFile(CAD), features: [], bindings: { pitch: 'D1@Sketch1' }, dimensionBindings: { pitch: 'D1@Sketch1' } }))
writeJsonAtomic(join(dataDir, 'projects', 'c04-02.json'), {
  designId: 'c04-02', step: 'exported', definition: design.definition,
  measurements: { volume: 24280.7, boundingBox: [60, 120, 6] },
  dimensionBindings: { pitch: 'D1@Sketch1' }, bindings: { pitch: 'D1@Sketch1' },
  cadPath: CAD, revision: 1, designFile: designFileFor(CAD), manifestFile: manifestFileFor(CAD),
})

const env = {
  ...process.env,
  SW_MCP_BROKER: '1',
  SW_MCP_BROKER_PIPE: pipe,
  SW_MCP_BROKER_DIR: join(root, 'broker'),
  SW_MCP_BROKER_WORKER_CMD: JSON.stringify([process.execPath, workerPath]),
  SW_MCP_DATA: dataDir,
  SW_MCP_INSTANCES_FILE: join(root, 'instances.json'),
  SW_MCP_TEST: '1',
}
delete env.SW_MCP_BROKER_ENSURE
delete env.SW_MCP_SESSION_ID

const session = openSession({ env })
const readOps = () => readFileSync(opsPath, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))

try {
  await session.start()

  // 1) 档位验收：期望值来自 design.json，全档应通过
  const verify = await session.tool('inspect', { action: 'verify', designId: 'c04-02', tiers: ['file', 'geometry', 'dimensions', 'positions', 'topology'] })
  const tiers = verify.changes?.tiers?.rows ?? []
  check('档位验收跑出了 rows', tiers.length >= 6, tiers.length)
  check('档位全部通过', tiers.every((row) => row.status === 'pass'), tiers.filter((row) => row.status !== 'pass'))
  check('状态是 ok', verify.status === 'ok', verify.status)

  // 2) 正常 edit：改参数 → 存盘 → revision+1 → design.json 里是新值
  const edit = await session.tool('model', { action: 'edit', designId: 'c04-02', changes: { pitch: 62 } })
  check('edit 成功', edit.status === 'ok', edit.summary)
  const savedDesign = JSON.parse(readFileSync(designFileFor(CAD), 'utf8'))
  check('revision 递增到 2', savedDesign.revision === 2, savedDesign.revision)
  check('design.json 记下新参数', savedDesign.parameters.pitch === 62, savedDesign.parameters)
  check('SLDPRT 被重新保存', readFileSync(CAD, 'utf8') === 'v2', readFileSync(CAD, 'utf8'))
  check('回包带 designStore', edit.changes?.designStore?.revision === 2, edit.changes?.designStore)

  // 3) CAD 被外部改动 → 拒绝，不静默覆盖
  writeFileSync(CAD, 'hand-edited')
  const drift = await session.tool('model', { action: 'edit', designId: 'c04-02', changes: { pitch: 64 } })
  check('外部改动 → 失败', drift.status === 'failed', drift.summary)
  check('错误码 CAD_DRIFT', drift.extra?.error?.code === 'CAD_DRIFT', drift.extra?.error?.code)
  check('文件没有被覆盖', readFileSync(CAD, 'utf8') === 'hand-edited', readFileSync(CAD, 'utf8'))

  // 4) 明确 recompile → 允许重编并提交
  const recompile = await session.tool('model', { action: 'edit', designId: 'c04-02', changes: { pitch: 64 }, recompile: true })
  check('recompile 后提交成功', recompile.status === 'ok', recompile.summary)
  check('revision 到 3', JSON.parse(readFileSync(designFileFor(CAD), 'utf8')).revision === 3)

  // 5) 存盘失败 → 回滚，磁盘保持上一版
  writeFileSync(failSentinel, '1')
  const before = readFileSync(CAD)
  const failedSave = await session.tool('model', { action: 'edit', designId: 'c04-02', changes: { pitch: 66 } })
  check('存盘失败 → 失败', failedSave.status === 'failed', failedSave.summary)
  check('错误码 EDIT_ROLLED_BACK', failedSave.extra?.error?.code === 'EDIT_ROLLED_BACK', failedSave.extra?.error?.code)
  check('回滚后文件字节不变', Buffer.compare(before, readFileSync(CAD)) === 0)
  check('design.json 没被写成新版本', JSON.parse(readFileSync(designFileFor(CAD), 'utf8')).revision === 3)
  rmSync(failSentinel, { force: true })

  // 6) deliver 时把 design.json / manifest.json 落到 CAD 旁边
  const outDir = join(root, 'deliver')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, 'C04-03.SLDPRT')
  const delivered = await session.tool('deliver', {
    designId: 'c04-02', kind: 'sldprt', path: outPath, force: 'manual', reason: '离线测试',
  })
  check('deliver 成功', delivered.status === 'ok', delivered.summary)
  check('design.json 落在 CAD 旁边', existsSync(designFileFor(outPath)), designFileFor(outPath))
  check('manifest.json 落在 CAD 旁边', existsSync(manifestFileFor(outPath)), manifestFileFor(outPath))
  check('deliver 记下 revision 1', delivered.changes?.designStore?.revision === 1, delivered.changes?.designStore)
  const deliveredDesign = JSON.parse(readFileSync(designFileFor(outPath), 'utf8'))
  check('交付时记录了期望包围盒', JSON.stringify(deliveredDesign.expectations?.boundingBox) === JSON.stringify([60, 120, 6]), deliveredDesign.expectations)
  const deliveredRecord = JSON.parse(readFileSync(join(dataDir, 'projects', 'c04-02.json'), 'utf8'))
  check('deliver 把 cadPath 写回项目记录', deliveredRecord.cadPath === outPath, deliveredRecord.cadPath)
  check('deliver 把 revision 写回项目记录', deliveredRecord.revision === 1, deliveredRecord.revision)
} finally {
  try { session.child.kill() } catch { /* 已退出 */ }
  if (session.child.exitCode === null) await Promise.race([once(session.child, 'exit'), sleep(2000)])
  try {
    const client = await BrokerClient.connect({ pipe, spawnIfMissing: false, timeoutMs: 3000 })
    try { await client.request('shutdown', {}, { timeoutMs: 2000 }) } finally { client.close() }
  } catch { /* broker 已退出 */ }
  await sleep(200)
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 占用文件留到下一轮 */ }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) { for (const failure of failures) console.log('  - ' + failure); process.exit(1) }