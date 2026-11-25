// Exercise the model tool over MCP with a fake bridge. No SOLIDWORKS is used.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrokerClient } from '../server/broker/client.mjs'
import { bumpRevision, recordDeliveryApproval } from '../server/review-live.mjs'
import { openSession } from './lib/mcp.mjs'

const dir = mkdtempSync(join(tmpdir(), 'sw-invoke-batch-'))
const pipe = `\\\\.\\pipe\\sw-invoke-batch-${process.pid}-${Date.now()}`
const worker = join(dir, 'worker.mjs')
writeFileSync(worker, `
import { createInterface } from 'node:readline'
for await (const line of createInterface({ input: process.stdin })) {
  const { id, op, ...args } = JSON.parse(line)
  let response = { ok: true }
  if (op === 'batch') {
    response = { ok: true, count: args.ops.length, results: args.ops.map((step) => ({ ok: true, step })), sent: args }
  } else if (op === 'invoke') {
    if (args.member === 'CreateLine' || args.member === 'AddDimension2') {
      response = { ok: false, error: { code: 'INVOKE_NULL_RESULT', message: 'missing created entity',
        detail: { member: args.member, signature: args.member + '(Double)', result: null } } }
    } else {
      const returnsVoid = args.member === 'ClearSelection2'
      response = { ok: true, member: args.member, returnsVoid, result: returnsVoid ? { void: true } : null }
    }
  }
  console.log(JSON.stringify({ id, ...response }))
}
`)

const env = {
  ...process.env,
  SW_MCP_BROKER: '1',
  SW_MCP_BROKER_PIPE: pipe,
  SW_MCP_BROKER_DIR: join(dir, 'broker'),
  SW_MCP_BROKER_WORKER_CMD: JSON.stringify([process.execPath, worker]),
  SW_MCP_DATA: join(dir, 'data'),
  SW_MCP_INSTANCES_FILE: join(dir, 'instances.json'),
  SW_MCP_MIN_WARM: '0',
}
for (const key of ['SW_MCP_BROKER_ENSURE', 'SW_MCP_BROKER_INSTANCE', 'SW_MCP_SESSION_ID', 'SW_MCP_TOOLS']) delete env[key]
const session = openSession({ env, timeoutMs: 15_000 })
try {
  await session.start()
  const model = (args) => session.tool('model', args)
  const invokeStep = { op: 'invoke', args: { target: 'activeDoc', member: 'GetTitle', args: [] } }

  for (const [step, field] of [
    [{ op: 'invoke', args: [] }, 'ops[1].args'],
    [{ op: 'invoke', args: { member: 'GetTitle', args: {} } }, 'ops[1].args.args'],
    [{ op: 'invoke', args: { target: 'activeDoc' } }, 'ops[1].args.member'],
  ]) {
    const value = await model({ action: 'batch', ops: [invokeStep, step] })
    const error = value.extra?.error
    assert.equal(value.status, 'failed')
    assert.equal(error?.code, 'BAD_ARGUMENT')
    assert.equal(error.detail.index, 1)
    assert.equal(error.detail.field, field)
    assert.deepEqual(error.detail.example, invokeStep)
  }

  const blocked = await model({ action: 'batch', designId: 'fixture', ops: [
    { op: 'invoke', args: { target: 'doc', member: 'SaveAs4', args: [] } },
  ] })
  assert.equal(blocked.extra?.error?.code, 'GATE_BYPASS_REFUSED')

  bumpRevision({ dataDir: env.SW_MCP_DATA, designId: 'fixture' })
  recordDeliveryApproval({ dataDir: env.SW_MCP_DATA, designId: 'fixture', kind: 'sldprt' })
  const mixedSave = await model({ action: 'batch', designId: 'fixture', ops: [
    { op: 'export', args: {} },
    { op: 'export', args: { DesignId: 'unapproved' } },
  ] })
  assert.equal(mixedSave.extra?.error?.code, 'GATE_BYPASS_REFUSED')
  assert.equal(mixedSave.extra.error.detail.designId, 'unapproved')

  const batch = await model({ action: 'batch', designId: 'fixture', ops: [invokeStep, { op: 'measure' }], stopOnError: false })
  assert.equal(batch.status, 'ok')
  assert.equal(batch.changes.sent.designId, 'fixture')
  assert.equal(batch.changes.sent.stopOnError, false)
  assert.deepEqual(batch.changes.sent.ops, [
    { op: 'invoke', target: 'activeDoc', member: 'GetTitle', args: [] }, { op: 'measure' },
  ])

  for (const member of ['CreateLine', 'AddDimension2']) {
    const value = await model({ action: 'invoke', target: 'activeDoc', member, args: [] })
    assert.equal(value.status, 'failed')
    assert.equal(value.extra?.error?.code, 'INVOKE_NULL_RESULT')
    assert.equal(value.extra.error.detail.member, member)
    assert.equal(value.extra.error.detail.result, null)
  }

  const nullable = await model({ action: 'invoke', target: 'activeDoc', member: 'GetActiveSketch2', args: [] })
  assert.equal(nullable.status, 'ok')
  assert.equal(nullable.changes.result, null)
  assert.equal(nullable.extra.returnsVoid, false)
  assert.deepEqual(nullable.nextActions, [])

  const voidCall = await model({ action: 'invoke', target: 'activeDoc', member: 'ClearSelection2', args: [true] })
  assert.equal(voidCall.status, 'ok')
  assert.equal(voidCall.extra.returnsVoid, true)
  assert.deepEqual(voidCall.changes.result, { void: true })
  console.log('PASS model invoke null/void and batch wire contract')
} finally {
  if (session.child.exitCode === null) {
    const exited = once(session.child, 'exit')
    session.close()
    await exited
  }
  try {
    const client = await BrokerClient.connect({ pipe, spawnIfMissing: false, timeoutMs: 1000 })
    try { await client.request('shutdown', {}, { timeoutMs: 1000 }) } finally { client.close() }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
