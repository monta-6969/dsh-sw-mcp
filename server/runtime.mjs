// Compact-surface stage runtime.
//
// One stage request is a durable job: it is persisted before the first CAD call,
// carries (runId, operationId) for replay, records every step before and after
// execution, and reports its effect honestly (none / applied / partial / unknown).
// A process restart leaves the record behind; the next caller either reads the
// finished receipt or is told that the owner disappeared and the scene must be
// checked before writing again.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { JobStore } from './jobs.mjs'
import { createStageRegistry } from './stage-jobs.mjs'
import { isTerminalJobState } from './contracts.mjs'

const stageContext = new AsyncLocalStorage()

/** Broker jobs started under a stage inherit its run identity. */
export function stageBridgeContext() {
  return stageContext.getStore()
}

function stageFail(code, message, detail) {
  return Object.assign(new Error(message), { code, detail })
}

function unwrap(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  const text = result?.content?.find((chunk) => chunk?.type === 'text')?.text
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// A refusal that provably happened before the bridge was touched may claim
// effect:none. Anything else that failed after a mutating step is at least
// partial; transport failures stay unknown until the scene is read back.
const NO_WRITE_CODES = new Set([
  'BAD_ARGUMENT', 'UNKNOWN_PARAM', 'UNKNOWN_OPERATION', 'DESIGN_ID_REQUIRED', 'WRONG_DOCUMENT',
  'READ_ONLY_TOOLSET', 'NOT_FOUND', 'PLAN_NOT_READY', 'REVISION_CONFLICT', 'GATE_BYPASS_REFUSED',
  'INSTANCE_NOT_BOUND', 'BRIDGE_MISSING', 'SW_BUSY',
  'REVIEW_QUOTA_EXCEEDED', 'VERIFY_FAILED', 'VERIFY_INCOMPLETE', 'VERIFY_NOT_RUN',
])
const UNKNOWN_CODES = /^(WORKER_|BRIDGE_|BROKER_|ECONN|ETIMEDOUT|EPIPE|SW_BUSY)/

function errorOf(blob, fallback) {
  const error = blob?.extra?.error ?? blob?.error
  return {
    code: String(error?.code ?? fallback?.code ?? 'STAGE_STEP_FAILED').slice(0, 80),
    message: String(error?.message ?? fallback?.message ?? blob?.summary ?? '步骤失败').slice(0, 8000),
    ...(error?.detail !== undefined ? { details: error.detail }
      : error?.details !== undefined ? { details: error.details } : {}),
  }
}

function statusOf(job) {
  if (job.state === 'succeeded') return 'ok'
  if (job.state === 'failed') return 'failed'
  return 'incomplete'
}

function summaryOf(job) {
  const steps = job.result?.steps ?? []
  const done = steps.filter((step) => step.state === 'succeeded').length
  if (job.state === 'succeeded') {
    return steps.length ? `阶段完成（${done}/${steps.length} 步）` : '阶段完成'
  }
  if (job.state === 'running') return `阶段执行中（${done}/${steps.length} 步）`
  if (job.state === 'queued') return '阶段已受理，等待执行'
  if (job.state === 'cancelled') return `阶段已取消（完成 ${done}/${steps.length} 步）`
  return `${job.error?.code ?? 'STAGE_FAILED'}：${job.error?.message ?? '阶段失败'}（完成 ${done}/${steps.length} 步）`
}

function envelopeOf(job, { designId, revision } = {}) {
  const steps = (job.result?.steps ?? []).map((step) => ({
    id: step.id,
    op: step.op,
    state: step.state,
    effect: step.effect,
    ...(step.error ? { error: step.error } : {}),
    ...(step.result ? { result: step.result } : {}),
  }))
  const ready = [...steps].reverse().find((step) => step.op === 'plan' && step.state === 'succeeded')?.result?.changes?.ready
  return {
    status: statusOf(job),
    summary: summaryOf(job),
    designId: designId ?? job.refs?.designId ?? null,
    ...(revision != null ? { revision } : (job.result?.revision != null ? { revision: job.result.revision } : {})),
    ...(job.error ? { error: job.error } : {}),
    job: {
      jobId: job.jobId,
      state: job.state,
      effect: job.effect ?? 'none',
      ...(job.cancelRequested ? { cancelRequested: true } : {}),
    },
    ...(ready !== undefined ? { changes: { ready } } : {}),
    steps,
  }
}

function validateGraph(steps) {
  const ids = new Set()
  for (const step of steps) {
    if (!step?.id) throw stageFail('BAD_ARGUMENT', '每个步骤都需要 id。')
    if (ids.has(step.id)) throw stageFail('BAD_ARGUMENT', `步骤 id 重复：${step.id}`)
    ids.add(step.id)
  }
  for (const step of steps) {
    for (const dep of step.deps ?? []) {
      if (!ids.has(dep)) throw stageFail('BAD_ARGUMENT', `步骤 ${step.id} 依赖不存在的步骤 ${dep}`)
    }
  }
  const marks = new Map()
  const visit = (id) => {
    if (marks.get(id) === 2) return
    if (marks.get(id) === 1) throw stageFail('BAD_ARGUMENT', `步骤依赖成环：${id}`)
    marks.set(id, 1)
    const step = steps.find((entry) => entry.id === id)
    for (const dep of step?.deps ?? []) visit(dep)
    marks.set(id, 2)
  }
  for (const step of steps) visit(step.id)
}

export function createStageRuntime({ dir, dispatch, revisionOf, broker } = {}) {
  if (typeof dispatch !== 'function') throw new Error('createStageRuntime needs dispatch')
  const store = new JobStore({ dir })
  const registry = createStageRegistry(store)
  const owner = { pid: process.pid, token: randomBytes(16).toString('hex') }
  const inflight = new Map()

  function currentRevision(designId) {
    try {
      const value = revisionOf?.(designId)
      return Number.isInteger(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  async function execute(jobId, context) {
    let job = registry['stages.get']({ jobId })
    const steps = job.request?.steps ?? []
    const designId = job.refs?.designId
    const runId = job.refs?.runId
    const rootOperationId = job.operationId
    const states = (job.result?.steps ?? []).map((step) => ({ ...step }))
    let effect = 'none'
    let failure = null
    let skippedAfterFailure = false

    const persist = (patch = {}) => {
      job = registry['stages.checkpoint']({ jobId, owner, patch: {
        effect,
        result: { ...job.result, steps: states, revision: currentRevision(designId) ?? job.result?.revision },
        ...patch,
      } })
    }

    try {
      validateGraph(steps)
      for (const [index, step] of steps.entries()) {
        if (failure !== null) {
          states[index] = { ...states[index], state: 'skipped' }
          continue
        }
        if (job.cancelRequested) {
          states[index] = { ...states[index], state: 'skipped' }
          skippedAfterFailure = true
          continue
        }
        const deps = step.deps?.length ? step.deps : (index > 0 ? [steps[index - 1].id] : [])
        const blocked = deps.some((dep) => states.find((entry) => entry.id === dep)?.state !== 'succeeded')
        if (blocked) {
          states[index] = { ...states[index], state: 'skipped' }
          continue
        }
        states[index] = { ...states[index], state: 'running', effect: step.mutates ? 'unknown' : 'none' }
        if (step.mutates && effect === 'none') effect = 'unknown'
        persist()

        let blob = null
        let thrown = null
        try {
          const result = await stageContext.run({
            runId,
            operationId: `${rootOperationId}/${step.id}`,
            stageJobId: jobId,
            stepId: step.id,
          }, () => dispatch(step.tool, step.args, context))
          blob = unwrap(result)
          if (blob === null) thrown = stageFail('BAD_TOOL_RESULT', '操作没有返回可读回执')
        } catch (error) {
          thrown = error
        }

        const failed = thrown !== null || blob?.status === 'failed'
        if (!failed) {
          states[index] = { ...states[index], state: 'succeeded', effect: step.mutates ? 'applied' : 'none', result: blob }
          if (step.mutates && effect === 'unknown') effect = 'applied'
          if (blob?.status === 'incomplete' && step.op === 'verify') {
            // Verification that could not measure the expectation still ends the
            // stage: continuing to build on unmeasured geometry is guesswork.
            failure = errorOf(blob, { code: 'VERIFY_INCOMPLETE' })
            states[index] = { ...states[index], state: 'failed', error: failure }
          }
          if (step.op === 'plan' && blob?.changes?.ready === false) {
            failure = errorOf(blob, { code: 'PLAN_NOT_READY' })
            states[index] = { ...states[index], state: 'failed', error: failure }
          }
          persist()
          continue
        }

        const error = errorOf(blob, thrown ? { code: thrown.code, message: thrown.message } : undefined)
        if (step.mutates) {
          effect = NO_WRITE_CODES.has(error.code) ? (effect === 'unknown' ? 'none' : effect)
            : UNKNOWN_CODES.test(error.code) ? 'unknown' : 'partial'
        }
        failure = error
        states[index] = { ...states[index], state: 'failed', effect: step.mutates ? effect : 'none', error }
        persist()
      }

      if (failure === null && !states.some((step) => step.state === 'skipped')) {
        return registry['stages.checkpoint']({ jobId, owner, state: 'succeeded', patch: {
          effect,
          result: { ...job.result, steps: states, revision: currentRevision(designId) },
        } })
      }
      if (failure === null) {
        return registry['stages.checkpoint']({ jobId, owner, state: 'cancelled', patch: {
          effect,
          result: { ...job.result, steps: states, revision: currentRevision(designId) },
          error: { code: 'STAGE_CANCELLED', message: '阶段在步骤之间被取消' },
        } })
      }
      return registry['stages.checkpoint']({ jobId, owner, state: 'failed', patch: {
        effect,
        error: failure,
        result: { ...job.result, steps: states, revision: currentRevision(designId) },
      } })
    } catch (error) {
      const failure = errorOf(null, { code: error?.code ?? 'STAGE_FAILED', message: error?.message ?? String(error) })
      try {
        return registry['stages.checkpoint']({ jobId, owner, state: 'failed', patch: {
          effect: effect === 'unknown' ? 'unknown' : effect,
          error: failure,
          result: { ...job.result, steps: states },
        } })
      } catch {
        return registry['stages.interrupt']({ jobId, owner, error: failure })
      }
    }
  }

  return {
    async submit(request, { wait = true, context } = {}) {
      const { runId, operationId, designId, expectedRevision, steps } = request
      if (!runId) throw stageFail('BAD_ARGUMENT', 'run 需要 runId。')
      if (!operationId) throw stageFail('BAD_ARGUMENT', 'run 需要 operationId。')
      if (!designId) throw stageFail('BAD_ARGUMENT', 'run 需要 designId。')
      validateGraph(steps)
      const submitted = registry['stages.submit']({ runId, operationId, designId, expectedRevision, steps })
      let job = submitted.job
      if (isTerminalJobState(job.state)) return envelopeOf(job, { designId, revision: job.result?.revision })

      const revision = currentRevision(designId)
      const claimed = registry['stages.claim']({ jobId: job.jobId, owner, revision })
      job = claimed.job
      if (!claimed.claimed) {
        if (claimed.busy) {
          if (!submitted.reused && wait !== false) {
            job = await waitFor(job.jobId)
          }
          if (job.state === 'running' || job.state === 'queued') {
            return {
              ...envelopeOf(job, { designId, revision }),
              status: 'incomplete',
              summary: '同一设计已有阶段在执行；原作业仍在运行，用 read job 查询它的回执。',
              error: { code: 'STAGE_BUSY', message: '同一设计已有阶段在执行', details: { jobId: job.jobId } },
            }
          }
          return envelopeOf(job, { designId, revision })
        }
        return envelopeOf(job, { designId, revision })
      }
      if (wait === false) {
        const running = execute(job.jobId, context)
        inflight.set(job.jobId, running)
        running.finally(() => inflight.delete(job.jobId)).catch(() => {})
        return {
          ...envelopeOf(registry['stages.get']({ jobId: job.jobId }), { designId, revision }),
          status: 'incomplete',
          summary: '阶段已受理并在后台执行；用 read job 按 jobId 查询进度与回执。',
        }
      }
      const finished = await execute(job.jobId, context)
      return envelopeOf(finished, { designId, revision: finished.result?.revision ?? revision })
    },

    async get({ jobId }) {
      const job = registry['stages.get']({ jobId })
      return envelopeOf(job)
    },

    async cancel({ jobId }) {
      const job = registry['stages.cancel']({ jobId })
      return envelopeOf(job)
    },

    /** Test/diagnostic hook: run a persisted queued stage without an MCP call. */
    async resume(jobId, context) {
      const job = registry['stages.claim']({ jobId, owner, revision: currentRevision(store.get(jobId)?.refs?.designId) })
      if (!job.claimed) return envelopeOf(job.job)
      return envelopeOf(await execute(jobId, context))
    },
  }

  async function waitFor(jobId, timeoutMs = Number(process.env.SW_MCP_STAGE_WAIT_MS ?? 240_000)) {
    const deadline = Date.now() + timeoutMs
    let job = registry['stages.get']({ jobId })
    while (!isTerminalJobState(job.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      job = registry['stages.get']({ jobId })
    }
    return job
  }
}