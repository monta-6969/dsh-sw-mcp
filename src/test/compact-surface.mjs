import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession } from './lib/mcp.mjs'

const data = mkdtempSync(join(tmpdir(), 'sw-compact-'))
const baseEnv = { ...process.env, SW_MCP_BROKER: '0', SW_MCP_BROKER_ENSURE: '0', SW_MCP_DATA: data }
let passed = 0
const check = (label, condition, value) => {
  if (!condition) console.error(JSON.stringify({ label, value }))
  assert.ok(condition, label)
  passed += 1
}

const compact = openSession({ env: { ...baseEnv, SW_MCP_SURFACE: 'compact' } })
try {
  await compact.start()
  const listed = await compact.call('tools/list', {})
  const names = (listed?.tools ?? []).map((tool) => tool.name).sort()
  check('compact surface is exactly four entries', JSON.stringify(names) === JSON.stringify(['deliver', 'help', 'read', 'run']), names)
  const runTool = listed.tools.find((tool) => tool.name === 'run')
  const runProperties = runTool?.inputSchema?.properties ?? {}
  check('run schema exposes concrete fields', Boolean(runProperties.steps && runProperties.designId && runProperties.runId), Object.keys(runProperties))
  check('run schema is not degraded to unknown', runProperties.steps?.type === 'array', runProperties.steps)

  const helpAll = await compact.tool('help', {})
  check('help lists run stages', helpAll.run?.includes('plan') && helpAll.run?.includes('build'), helpAll)
  check('help lists read kinds', helpAll.read?.includes('bodies') && helpAll.read?.includes('job'), helpAll.read)

  const helpPlan = await compact.tool('help', { op: 'plan' })
  check('help plan has args', helpPlan.status === 'ok' && helpPlan.args?.definition, helpPlan)
  check('help plan example is run-shaped', helpPlan.example?.steps?.[0]?.op === 'plan', helpPlan.example)

  const unknownOp = await compact.tool('help', { op: 'nope' })
  check('help rejects unknown op', unknownOp.status === 'failed' && unknownOp.extra?.error?.code === 'UNKNOWN_OPERATION', unknownOp)

  const missing = await compact.tool('run', { designId: 'part-a', steps: [{ op: 'build' }] })
  check('run requires runId', missing.status === 'failed' && /runId/.test(missing.extra?.error?.message ?? ''), missing)

  const wrongDoc = await compact.tool('run', {
    designId: 'part-a', runId: 'part-a', operationId: 'wrong-doc-1',
    steps: [{ op: 'invoke', args: { target: 'activeDoc', member: 'GetTitle', args: [] } }],
  })
  check('run refuses activeDoc', wrongDoc.status === 'failed' && wrongDoc.extra?.error?.code === 'WRONG_DOCUMENT', wrongDoc)

  const badField = await compact.tool('run', {
    designId: 'part-a', runId: 'part-a', operationId: 'bad-field-1',
    steps: [{ op: 'build', args: { nope: 1 } }],
  })
  check('run refuses unknown step param', badField.status === 'failed' && badField.extra?.error?.code === 'UNKNOWN_PARAM', badField)

  const noDesign = await compact.tool('read', { kind: 'bodies' })
  check('read requires designId', noDesign.status === 'failed' && noDesign.extra?.error?.code === 'DESIGN_ID_REQUIRED', noDesign)

  const noJob = await compact.tool('read', { kind: 'job' })
  check('read job requires jobId', noJob.status === 'failed' && /jobId/.test(noJob.extra?.error?.message ?? ''), noJob)

  const noDetail = await compact.tool('read', { kind: 'detail', detailRef: 'missing' })
  check('read detail misses cleanly', noDetail.status === 'failed' && noDetail.extra?.error?.code === 'NOT_FOUND', noDetail)

  const badDeliver = await compact.tool('deliver', {})
  check('deliver requires designId', badDeliver.status === 'failed' && /designId/.test(badDeliver.extra?.error?.message ?? ''), badDeliver)
} finally {
  compact.close()
}

const legacy = openSession({ env: baseEnv })
try {
  await legacy.start()
  const listed = await legacy.call('tools/list', {})
  const names = (listed?.tools ?? []).map((tool) => tool.name)
  // 默认工具面 = 核心分组（tool-face 的 core:true）+ 不分组的常驻工具。
  // 以前这里写死 11 个：工具面拆分之后核心组变成 5 个分组 + catalog/capture/deliver，
  // 写死数字只会让「谁被挪走了」这种真问题变成更新计数。这里按分层表算期望集合。
  const { coreToolNames } = await import('../server/tool-face.mjs')
  const expected = [...coreToolNames(), 'catalog', 'capture', 'deliver'].sort()
  check('default surface = 核心分组 + catalog/capture/deliver',
    JSON.stringify([...names].sort()) === JSON.stringify(expected), { names, expected })
  check('default surface 有 inspect 与 model', names.includes('inspect') && names.includes('model'), names)
  check('datum 是按需工具，不在默认面', !names.includes('datum'), names)
  check('default surface has no compact entries', !names.includes('run') && names.includes('deliver'), names)
} finally {
  legacy.close()
  rmSync(data, { recursive: true, force: true })
}

console.log(`${passed} passed, 0 failed`)