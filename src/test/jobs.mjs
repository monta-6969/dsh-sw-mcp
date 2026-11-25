// 作业状态机与持久化：jobId 要在进程重启后还能取回结果。
//
// 这些断言都对着真实落盘文件，不对着内存 Map —— 恢复路径才是这个模块存在的理由。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore, JobStoreError } from '../server/jobs.mjs'
import { assertValid } from '../server/contracts.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}
function throws(fn) {
  try { fn(); return null } catch (error) { return error }
}

const dir = mkdtempSync(join(tmpdir(), 'sw-jobs-'))
let clock = new Date('2026-11-10T00:00:00Z')
const now = () => clock

try {
  const store = new JobStore({ dir, now })
  const first = store.submit({ op: 'build', operationId: 'op-1', refs: { runId: 'run-a', documentId: 'doc_x' } })
  check('submit 返回 queued', first.job.state === 'queued', first.job)
  check('jobId 有前缀', first.job.jobId.startsWith('job_'), first.job.jobId)
  check('作业文件已落盘', existsSync(join(dir, `${first.job.jobId}.json`)), first.job.jobId)
  check('落盘记录符合 Job 契约', (() => { try { assertValid('job', JSON.parse(readFileSync(join(dir, `${first.job.jobId}.json`), 'utf8'))); return true } catch { return false } })())
  check('首次提交不是复用', first.reused === false)

  const again = store.submit({ op: 'build', operationId: 'op-1', refs: { runId: 'run-a' } })
  check('同 (runId,operationId) 复用现有 job', again.reused === true && again.job.jobId === first.job.jobId,
    { first: first.job.jobId, again: again.job.jobId })
  const otherRun = store.submit({ op: 'build', operationId: 'op-1', refs: { runId: 'run-b' } })
  check('不同 run 的同 operationId 是新 job', otherRun.job.jobId !== first.job.jobId,
    { first: first.job.jobId, other: otherRun.job.jobId })

  const running = store.transition(first.job.jobId, 'running', { worker: { pid: 1234 } })
  check('queued -> running 记 startedAt', running.state === 'running' && Boolean(running.startedAt), running)
  const succeeded = store.transition(first.job.jobId, 'succeeded', { result: { volume: 120000 } })
  check('running -> succeeded 记 finishedAt 与结果',
    succeeded.state === 'succeeded' && Boolean(succeeded.finishedAt) && succeeded.result.volume === 120000, succeeded)
  const illegal = throws(() => store.transition(first.job.jobId, 'running'))
  check('终态不能再变回 running', illegal?.code === 'JOB_STATE_INVALID', illegal?.code)
  const missing = throws(() => store.transition('job_nope', 'running'))
  check('未知 jobId 明确报 JOB_NOT_FOUND', missing?.code === 'JOB_NOT_FOUND', missing?.code)
  const jumping = throws(() => store.transition(otherRun.job.jobId, 'succeeded'))
  check('queued 不能直接 succeeded', jumping?.code === 'JOB_STATE_INVALID', jumping?.code)

  // 重新打开：进程重启后按 jobId 取回同一状态与结果。
  const reopened = new JobStore({ dir, now })
  const recovered = reopened.get(first.job.jobId)
  check('重启后按 jobId 取回终态', recovered?.state === 'succeeded' && recovered?.result?.volume === 120000, recovered)

  const second = reopened.submit({ op: 'measure', operationId: 'op-2', refs: { runId: 'run-a' } })
  const list = reopened.list({ limit: 10 })
  check('list 按创建时间倒序', list[0].jobId === second.job.jobId, list.map((j) => j.jobId))
  check('list 支持按状态过滤', reopened.list({ state: 'succeeded' }).every((j) => j.state === 'succeeded'),
    reopened.list({ state: 'succeeded' }).map((j) => j.jobId))

  const cancelQueued = reopened.requestCancel(second.job.jobId)
  check('queued 作业取消后立即终态', cancelQueued.cancelled && cancelQueued.job.state === 'cancelled', cancelQueued.job)
  const third = reopened.submit({ op: 'build', operationId: 'op-3', refs: { runId: 'run-a' } })
  reopened.transition(third.job.jobId, 'running')
  const cancelRunning = reopened.requestCancel(third.job.jobId)
  check('running 作业只置 cancelRequested', cancelRunning.cancelled === false
    && cancelRunning.job.cancelRequested === true && cancelRunning.job.state === 'running', cancelRunning.job)

  // 回收：终态 + 超过保留期才删；运行中的永远不删。
  clock = new Date('2026-11-20T00:00:00Z')
  const removed = reopened.reclaim({ keepMs: 24 * 3600_000 })
  check('回收删掉过期终态', removed.includes(first.job.jobId) && removed.includes(second.job.jobId), removed)
  check('回收不碰运行中的作业', reopened.get(third.job.jobId)?.state === 'running', reopened.get(third.job.jobId))
  check('回收后文件也删掉', !existsSync(join(dir, `${first.job.jobId}.json`)))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
