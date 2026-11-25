import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStageRuntime } from '../server/runtime.mjs'

const data = mkdtempSync(join(tmpdir(), 'sw-stage-'))
const calls = []
let revision = 3
let mode = 'ok'
const envelopes = {
  plan: () => ({ status: 'ok', summary: 'plan ok', changes: { ready: true } }),
  build: () => ({ status: 'ok', summary: 'built', changes: { applied: 1 }, measurements: { totalVolumeMm3: 4800 } }),
  verify: () => ({ status: 'ok', summary: 'verified', changes: { checks: [{ name: 'size', status: 'pass' }] } }),
}
const dispatch = async (name, args) => {
  calls.push([name, args])
  if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 120))
  let blob
  if (mode === 'badArgument') blob = { status: 'failed', summary: 'bad', extra: { error: { code: 'BAD_ARGUMENT', message: 'bad' } } }
  else if (mode === 'timeout') { const error = new Error('worker timed out'); error.code = 'WORKER_TIMEOUT'; throw error }
  else blob = (envelopes[args?.action] ?? (() => ({ status: 'ok', summary: args?.action ?? 'ok' })))(args)
  return { content: [{ type: 'text', text: JSON.stringify(blob) }] }
}
const runtime = createStageRuntime({ dir: data, dispatch, revisionOf: () => revision })

let passed = 0
const check = (label, condition, value) => {
  if (!condition) console.error(JSON.stringify({ label, value }))
  assert.ok(condition, label)
  passed += 1
}

try {
  const base = { runId: 'r1', operationId: 'op-ok', designId: 'part-a' }
  const okSteps = [
    { id: 'p', op: 'plan', tool: 'model', mutates: false, args: { action: 'plan' } },
    { id: 'b', op: 'build', tool: 'model', mutates: true, args: { action: 'build' } },
    { id: 'v', op: 'verify', tool: 'inspect', mutates: false, args: { action: 'verify' } },
  ]
  const ok = await runtime.submit({ ...base, steps: okSteps })
  check('ok status', ok.status === 'ok', ok)
  check('all steps succeeded', ok.steps.every((s) => s.state === 'succeeded'), ok.steps)
  check('job applied', ok.job.effect === 'applied' && ok.job.state === 'succeeded', ok.job)
  check('revision attached', ok.revision === 3, ok.revision)

  const replay = await runtime.submit({ ...base, steps: okSteps }, {})
  check('replay same job', replay.job.jobId === ok.job.jobId, replay.job)
  check('replay did not re-dispatch', calls.length === 3, calls)

  let conflict = null
  try {
    await runtime.submit({ ...base, steps: [{ id: 'x', op: 'build', tool: 'model', mutates: true, args: { action: 'build' } }] })
  } catch (error) { conflict = error }
  check('changed args conflict', conflict?.code === 'OPERATION_ID_CONFLICT', conflict?.code)

  mode = 'ok'
  envelopes.plan = () => ({ status: 'incomplete', summary: 'not ready', changes: { ready: false } })
  const notReady = await runtime.submit({ runId: 'r1', operationId: 'op-plan-gate', designId: 'part-a', steps: [
    { id: 'p', op: 'plan', tool: 'model', mutates: false, args: { action: 'plan' } },
    { id: 'b', op: 'build', tool: 'model', mutates: true, args: { action: 'build' } },
  ] })
  check('plan gate failed', notReady.status === 'failed' && notReady.error?.code === 'PLAN_NOT_READY', notReady)
  check('plan gate skipped build', notReady.steps[1].state === 'skipped', notReady.steps)
  check('plan gate no effect', notReady.job.effect === 'none', notReady.job)

  mode = 'badArgument'
  const bad = await runtime.submit({ runId: 'r1', operationId: 'op-bad-arg', designId: 'part-a', steps: [
    { id: 'b', op: 'build', tool: 'model', mutates: true, args: { action: 'build' } },
  ] })
  check('refusal keeps effect none', bad.status === 'failed' && bad.job.effect === 'none', bad.job)

  mode = 'ok'
  envelopes.build = () => ({ status: 'failed', summary: 'no feature', extra: { error: { code: 'INVOKE_NULL_RESULT', message: 'null' } } })
  const partial = await runtime.submit({ runId: 'r1', operationId: 'op-partial', designId: 'part-a', steps: [
    { id: 'b', op: 'build', tool: 'model', mutates: true, args: { action: 'build' } },
  ] })
  check('business failure marks partial', partial.status === 'failed' && partial.job.effect === 'partial', partial.job)

  mode = 'timeout'
  const lost = await runtime.submit({ runId: 'r1', operationId: 'op-timeout', designId: 'part-a', steps: [
    { id: 'b', op: 'build', tool: 'model', mutates: true, args: { action: 'build' } },
  ] })
  check('transport failure is unknown', lost.status === 'failed' && lost.job.effect === 'unknown', lost.job)

  mode = 'slow'
  envelopes.build = () => ({ status: 'ok', summary: 'built', changes: { applied: 1 } })
  const accepted = await runtime.submit({ runId: 'r1', operationId: 'op-cancel', designId: 'part-b', steps: [
    { id: 'b', op: 'build', tool: 'model', mutates: true, args: { action: 'build' } },
    { id: 'v', op: 'verify', tool: 'inspect', mutates: false, args: { action: 'verify' } },
  ] }, { wait: false })
  check('wait false accepted', accepted.status === 'incomplete' && accepted.job.state === 'running', accepted.job)
  const cancelled = await runtime.cancel({ jobId: accepted.job.jobId })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const after = await runtime.get({ jobId: accepted.job.jobId })
  check('cancel reaches terminal', ['cancelled', 'succeeded'].includes(after.job.state), after.job)
  if (after.job.state === 'cancelled') check('cancel skips remaining', after.steps.some((s) => s.state === 'skipped'), after.steps)

  console.log(`${passed} passed, 0 failed`)
} finally {
  rmSync(data, { recursive: true, force: true })
}