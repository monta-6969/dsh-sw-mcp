import { isTerminalJobState } from './contracts.mjs'
import { JobStoreError, operationFingerprint } from './jobs.mjs'

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

export function stageError(error, fallback = 'STAGE_FAILED') {
  return {
    code: String(error?.code || fallback).slice(0, 80),
    message: String(error?.message || error || fallback).slice(0, 8000),
    ...(error?.detail || error?.details ? { details: error.detail ?? error.details } : {}),
  }
}

/** Broker and standalone profiles use the same persisted admission protocol. */
export function createStageRegistry(store, { ownerAlive = alive } = {}) {
  function getStage(jobId) {
    const job = store.get(jobId)
    if (job?.op !== 'stage') throw new JobStoreError('JOB_NOT_FOUND', `没有阶段作业 ${jobId}`)
    return job
  }

  function assertOwner(job, owner) {
    if (!owner?.token || job.owner?.token !== owner.token || job.owner?.pid !== owner.pid) {
      throw new JobStoreError('STAGE_OWNER_CHANGED', '阶段执行权已转移', { jobId: job.jobId })
    }
  }

  function interrupt(job, error) {
    const steps = job.result?.steps ?? []
    let effect = job.effect ?? 'none'
    if (steps.some((step) => step.state === 'running' && step.mutates)) effect = 'unknown'
    if (effect === 'applied' && steps.some((step) => step.state !== 'succeeded')) effect = 'partial'
    return store.transition(job.jobId, 'failed', {
      effect,
      error,
      result: {
        ...job.result,
        steps: steps.map((step) => {
          if (step.state === 'running') return {
            ...step,
            state: 'failed',
            effect: step.mutates ? 'unknown' : 'none',
            error,
          }
          if (step.state === 'pending') return { ...step, state: 'skipped' }
          return step
        }),
      },
    })
  }

  function refresh(job) {
    if (job.state !== 'running' || (job.owner?.pid && ownerAlive(job.owner.pid))) return job
    return interrupt(job, {
      code: 'STAGE_INTERRUPTED',
      message: '阶段执行进程已退出，请根据最后一次回执核对现场',
    })
  }

  return {
    'stages.submit'({ runId, operationId, designId, expectedRevision, steps }) {
      const request = { expectedRevision, steps }
      const refs = { runId, designId }
      return store.submit({
        op: 'stage',
        operationId,
        refs,
        request,
        fingerprint: operationFingerprint({ ...refs, ...request }),
        result: {
          steps: steps.map(({ id, op, mutates }) => ({ id, op, mutates, state: 'pending' })),
        },
      })
    },

    'stages.get'({ jobId }) {
      return refresh(getStage(jobId))
    },

    'stages.claim'({ jobId, owner, revision }) {
      const job = refresh(getStage(jobId))
      if (job.state !== 'queued') return { job, claimed: false }
      const designJobs = store.list({ op: 'stage', designId: job.refs.designId, limit: Infinity }).map(refresh)
      const blocked = designJobs.find((other) => other.effect === 'unknown' && !other.reconciliation)
      if (blocked) {
        return { job: store.transition(jobId, 'failed', {
          effect: 'none',
          error: {
            code: 'STAGE_RECOVERY_REQUIRED',
            message: '该设计有尚待核实的写操作',
            details: { jobId: blocked.jobId },
          },
        }), claimed: false }
      }
      if (designJobs.some((other) => other.state === 'running')) return { job, claimed: false, busy: true }
      const expected = job.request?.expectedRevision
      if (expected !== undefined && expected !== revision) {
        return { job: store.transition(jobId, 'failed', {
          effect: 'none',
          error: {
            code: 'REVISION_CONFLICT',
            message: '设计版本与提交时的预期不一致',
            details: { expectedRevision: expected, actualRevision: revision },
          },
          result: { ...job.result, revision },
        }), claimed: false }
      }
      return {
        job: store.transition(jobId, 'running', { owner, effect: 'none', result: { ...job.result, revision } }),
        claimed: true,
      }
    },

    'stages.checkpoint'({ jobId, owner, patch, state }) {
      const job = getStage(jobId)
      assertOwner(job, owner)
      if (job.state !== 'running') throw new JobStoreError('JOB_STATE_INVALID', `阶段已进入 ${job.state}`)
      if (state) return store.transition(jobId, state, patch)
      return store.update(jobId, patch)
    },

    'stages.cancel'({ jobId }) {
      const job = refresh(getStage(jobId))
      return store.requestCancel(job.jobId).job
    },

    'stages.interrupt'({ jobId, owner, error }) {
      const job = getStage(jobId)
      if (isTerminalJobState(job.state)) return job
      assertOwner(job, owner)
      return interrupt(job, error)
    },

    'stages.reconcile'({ jobId, note, revision }) {
      const job = refresh(getStage(jobId))
      if (job.state !== 'failed' || job.effect !== 'unknown') {
        throw new JobStoreError('STAGE_RECONCILE_STATE', '只有结果待核实的失败阶段需要登记回读')
      }
      if (job.reconciliation) return job
      return store.update(jobId, {
        reconciliation: { at: new Date().toISOString(), note, revision },
      })
    },
  }
}
