// 契约 v4 的单元测试：不需要 SOLIDWORKS，也不启动 MCP 服务。
//
// 这里验三件事：
//   1. enums.json 与 zod schema 能覆盖计划里承诺的每一条记录形状；
//   2. 引用字符串稳定：同一文件的大小写/斜杠/长路径前缀不改变 documentId；
//   3. 生成物没有漂移：contracts/schema 与 Contracts.Generated.cs 必须是最新的。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENUMS, Schemas, jsonSchemas, validate, assertValid, ContractError } from '../server/contracts.mjs'
import {
  parseRef,
  refToString,
  documentIdFor,
  documentRefFor,
  artifactRefFor,
  revisionRef,
  canonicalPath,
  newRef,
  BadRefError,
} from '../server/refs.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`FAIL  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  }
}

function valid(kind, value) {
  const result = validate(kind, value)
  if (!result.ok) return { ok: false, errors: result.errors }
  return { ok: true, errors: [] }
}

// ── 1. 枚举 ──────────────────────────────────────────────────────────
check('schemaVersion 是 4', ENUMS.schemaVersion === 4, ENUMS.schemaVersion)
for (const key of ['refKinds', 'jobStates', 'curveKinds', 'constraintTypes', 'dimensionTypes', 'eventNames', 'errorCodes']) {
  const list = ENUMS[key]
  check(`枚举 ${key} 非空且无重复`, Array.isArray(list) && list.length > 0 && new Set(list).size === list.length, list?.length)
}
check('八类曲线齐全', ['line', 'circle', 'arc', 'ellipse', 'ellipticArc', 'spline', 'equationCurve', 'polyline'].every((k) => ENUMS.curveKinds.includes(k)), ENUMS.curveKinds)
check('终态是作业状态子集', ENUMS.terminalJobStates.every((s) => ENUMS.jobStates.includes(s)))

// ── 2. 作业 ──────────────────────────────────────────────────────────
const job = {
  schemaVersion: 4,
  jobId: 'job_0123456789abcdef01234567',
  operationId: 'run_1:build:1',
  op: 'build',
  state: 'queued',
  refs: { projectId: 'proj_1', documentId: 'doc_1', revision: 0 },
  createdAt: '2026-11-10T12:00:00Z',
}
check('合法作业通过', valid('job', job).ok, valid('job', job).errors)
check('未知作业状态被拒', !valid('job', { ...job, state: 'paused' }).ok)
check('缺 createdAt 被拒', !valid('job', { schemaVersion: 4, jobId: 'j', op: 'x', state: 'queued' }).ok)
check('失败作业保留 error.code', valid('job', { ...job, state: 'failed', error: { code: 'SW_BUSY', message: 'busy' } }).ok)

// ── 3. 任务 DAG ──────────────────────────────────────────────────────
const task = {
  schemaVersion: 4,
  taskId: 'task_1',
  nodes: [
    { nodeId: 'n1', op: 'build', resource: 'ui' },
    { nodeId: 'n2', op: 'capture', dependsOn: ['n1'], resource: 'ui' },
  ],
}
check('合法任务通过', valid('task', task).ok, valid('task', task).errors)
check('空节点被拒', !valid('task', { schemaVersion: 4, taskId: 't', nodes: [] }).ok)
check('任务缺省 dependsOn 被补成数组', validate('task', { schemaVersion: 4, taskId: 't', nodes: [{ nodeId: 'a', op: 'ping' }] }).value?.nodes?.[0]?.dependsOn?.length === 0)

// ── 4. 曲线 ──────────────────────────────────────────────────────────
const curves = {
  line: { kind: 'line', params: { start: [0, 0], end: [10, 0] } },
  circle: { kind: 'circle', params: { center: [0, 0], radius: 5 }, dimensions: [{ name: 'dia', type: 'diameter', value: 10 }] },
  arc: { kind: 'arc', params: { center: [0, 0], radius: 5, startAngle: 0, endAngle: 90, direction: 1 } },
  ellipse: { kind: 'ellipse', params: { center: [0, 0], major: 10, minor: 5, rotation: 0 } },
  ellipticArc: { kind: 'ellipticArc', params: { center: [0, 0], major: 10, minor: 5, rotation: 0, startParam: 0, endParam: 90 } },
  spline: { kind: 'spline', params: { points: [[0, 0], [5, 3], [10, 0]], degree: 3, closed: false }, toleranceMm: 0.01 },
  equationCurve: { kind: 'equationCurve', params: { variable: { name: 't', from: 0, to: 6.283 }, x: '10*cos(t)', y: '10*sin(t)', samples: 64 } },
  polyline: { kind: 'polyline', params: { points: [[0, 0], [10, 0], [10, 10]], closed: true } },
}
for (const [kind, curve] of Object.entries(curves)) {
  const result = valid('curve', curve)
  check(`曲线 ${kind} 通过`, result.ok, result.errors)
}
check('未知曲线种类被拒', !valid('curve', { kind: 'bezier', params: {} }).ok)
check('曲线缺 params 被拒', !valid('curve', { kind: 'line' }).ok)
check('约束类型合法', valid('curve', { ...curves.line, constraints: [{ type: 'tangent', refs: ['c2'] }] }).ok)
check('未知约束被拒', !valid('curve', { ...curves.line, constraints: [{ type: 'weld' }] }).ok)

// ── 5. 快照 / 事件 / 经验 / 能力表 / 差异 ─────────────────────────────
const sha = 'a'.repeat(64)
const snapshot = {
  schemaVersion: 4,
  snapshotId: 'snap_1',
  documentId: 'doc_1',
  revision: 3,
  at: '2026-11-10T12:00:00Z',
  files: [
    { kind: 'image', path: 'C:/tmp/a.png', sha256: sha, bytes: 100 },
    { kind: 'step', path: 'C:/tmp/a.step', sha256: sha, bytes: 200 },
  ],
  measurements: { volume: 120000 },
}
check('合法快照通过', valid('snapshot', snapshot).ok, valid('snapshot', snapshot).errors)
check('快照缺文件被拒', !valid('snapshot', { ...snapshot, files: [] }).ok)
check('快照坏 sha 被拒', !valid('snapshot', { ...snapshot, files: [{ kind: 'image', path: 'x', sha256: 'abc', bytes: 1 }] }).ok)

check('合法事件通过', valid('event', { schemaVersion: 4, eventId: 'ev_1', at: '2026-11-10T12:00:00Z', name: 'job.succeeded' }).ok)
check('未知事件被拒', !valid('event', { schemaVersion: 4, eventId: 'ev_1', at: '2026-11-10T12:00:00Z', name: 'job.exploded' }).ok)

const experience = {
  schemaVersion: 4,
  id: 'exp_1',
  kind: 'lesson',
  title: '槽用两条线加两个原生弧比样条稳',
  conditions: { taskKinds: ['plate'], featureKinds: ['slot'], swVersion: '34.3.2' },
  action: '用 slot profile 建槽',
  observation: '原生弧回读半径一致，样条近圆偏差 0.006%',
  evidenceRefs: [{ kind: 'snapshot', ref: 'snap_1' }],
  status: 'curated',
  createdAt: '2026-11-10T12:00:00Z',
}
check('合法经验通过', valid('experience', experience).ok, valid('experience', experience).errors)
check('未知经验状态被拒', !valid('experience', { ...experience, status: 'archived' }).ok)
check('supersededBy 可为 null', valid('experience', { ...experience, supersededBy: null }).ok)

const capabilities = {
  schemaVersion: 4,
  protocolVersion: 4,
  bridgeVersion: '0.5.0',
  generatedAt: '2026-11-10T12:00:00Z',
  ops: [{ name: 'build', summary: 'build a part from a definition', mutates: true, requiresDocument: false, lockClass: 'write' }],
}
check('合法能力表通过', valid('capabilities', capabilities).ok, valid('capabilities', capabilities).errors)

const diff = {
  schemaVersion: 4,
  snapshotId: 'snap_1',
  sourceKey: 'draw_1',
  items: [
    {
      id: 'd1',
      severity: 'major',
      kind: 'hole',
      view: 'front',
      region: { x: 10, y: 20, w: 30, h: 30 },
      entityRef: { kind: 'face', id: 'face_1', synthetic: false },
      expected: { value: 8, unit: 'mm', source: 'drawing' },
      measured: { value: 6, unit: 'mm', source: 'model' },
      delta: -2,
      confidence: 0.9,
      nextObservation: '看剖视确认孔径',
    },
  ],
}
check('合法差异通过', valid('evidenceDiff', diff).ok, valid('evidenceDiff', diff).errors)
check('差异 severity 受控', !valid('evidenceDiff', { ...diff, items: [{ ...diff.items[0], severity: 'fatal' }] }).ok)

// ── 6. 引用 ──────────────────────────────────────────────────────────
const docA = documentIdFor({ path: 'C:\\Temp\\A.SLDPRT', designId: 'plate' })
const docB = documentIdFor({ path: 'c:/temp/a.sldprt', designId: 'plate' })
const docC = documentIdFor({ path: '\\\\?\\C:\\Temp\\A.SLDPRT', designId: 'plate' })
check('同一文档大小写/斜杠/长路径前缀得到同一 id', docA === docB && docB === docC, { docA, docB, docC })
check('设计名不同则 id 不同', docA !== documentIdFor({ path: 'C:\\Temp\\A.SLDPRT', designId: 'bracket' }))
check('canonicalPath 去掉长路径前缀', canonicalPath('\\\\?\\C:\\Temp\\A.SLDPRT').toLowerCase() === 'c:\\temp\\a.sldprt', canonicalPath('\\\\?\\C:\\Temp\\A.SLDPRT'))

const ref = { kind: 'document', id: docA }
check('ref 字符串往返', refToString(parseRef(refToString(ref))) === refToString(ref))
check('ref 对象解析', parseRef(ref).id === docA)
check('非法 ref 被拒', (() => { try { parseRef('C:\\Temp\\A.SLDPRT'); return false } catch (e) { return e instanceof BadRefError && e.code === 'BAD_REF' } })())
check('新引用来自已知种类', newRef('job').kind === 'job' && newRef('job').id.startsWith('job_'))
check('产物引用需要完整 sha', artifactRefFor(sha).kind === 'artifact' && (() => { try { artifactRefFor('abc'); return false } catch { return true } })())
check('修订引用绑定文档', revisionRef(documentRefFor({ path: 'C:\\Temp\\A.SLDPRT' }), 3).kind === 'revision')

// ── 7. 断言风格 ──────────────────────────────────────────────────────
let threw = null
try {
  assertValid('job', { schemaVersion: 4 })
} catch (error) {
  threw = error
}
check('assertValid 抛 ContractError', threw instanceof ContractError && threw.code === 'CONTRACT_INVALID' && Array.isArray(threw.details?.errors))

// ── 8. 生成物 ────────────────────────────────────────────────────────
const schemaDir = join(root, 'contracts', 'schema')
const schemaNames = readdirSync(schemaDir).filter((name) => name.endsWith('.schema.json'))
check('每个契约都有 schema 文件', Object.keys(Schemas).every((name) => schemaNames.includes(`${name}.schema.json`)), schemaNames)
for (const name of schemaNames) {
  const parsed = JSON.parse(readFileSync(join(schemaDir, name), 'utf8'))
  check(`${name} 是 JSON Schema`, parsed.$schema?.includes('json-schema.org') && parsed.type === 'object')
}
check('C# 常量文件存在', existsSync(join(root, 'bridge', 'src', 'Contracts.Generated.cs')))
check('jsonSchemas() 与 Schemas 同名', Object.keys(jsonSchemas()).sort().join(',') === Object.keys(Schemas).sort().join(','))

const checkRun = spawnSync(process.execPath, [join(root, 'tools', 'check-contracts.mjs')], { cwd: root, encoding: 'utf8' })
check('生成物没有漂移', checkRun.status === 0, { status: checkRun.status, stderr: checkRun.stderr?.slice(-500) })

// ── 9. 样例 ──────────────────────────────────────────────────────────
const curveSamples = readdirSync(join(root, 'examples', 'samples', 'curves')).filter((name) => name.endsWith('.json'))
check('八类曲线都有样例', curveSamples.length >= 8, curveSamples)
for (const name of curveSamples) {
  const value = JSON.parse(readFileSync(join(root, 'examples', 'samples', 'curves', name), 'utf8'))
  const result = valid('curve', value)
  check(`样例 ${name} 合法`, result.ok, result.errors)
}
const jobSample = JSON.parse(readFileSync(join(root, 'examples', 'samples', 'job', 'build.json'), 'utf8'))
check('作业样例合法', valid('job', jobSample).ok, valid('job', jobSample).errors)
const diffSample = JSON.parse(readFileSync(join(root, 'examples', 'samples', 'diff', 'plate-vs-drawing.json'), 'utf8'))
check('差异样例合法', valid('evidenceDiff', diffSample).ok, valid('evidenceDiff', diffSample).errors)
const profileSamples = readdirSync(join(root, 'examples', 'samples', 'profiles')).filter((name) => name.endsWith('.json'))
check('slot/roundedRect/path 样例齐全', ['slot.json', 'roundedRect.json', 'path-arc.json'].every((name) => profileSamples.includes(name)), profileSamples)
for (const name of profileSamples) {
  const value = JSON.parse(readFileSync(join(root, 'examples', 'samples', 'profiles', name), 'utf8'))
  check(`profile ${name} 有 shape`, typeof value.shape === 'string' && value.shape.length > 0, value.shape)
}

// ── 汇总 ─────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
