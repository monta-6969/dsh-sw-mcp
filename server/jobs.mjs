// Durable job store：作业状态先落盘，再回给调用方。
//
// 为什么不是内存 Map：MCP 会话断开、DSH 重启、等待期很长，都要求
// 「按 jobId 取回原结果」。契约里 (runId, operationId) 幂等，所以重试
// 提交必须拿到同一个 job，而不是再建一个。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newId } from './refs.mjs'
import { assertValid, isTerminalJobState } from './contracts.mjs'

const TRANSITIONS = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['waiting-ui', 'succeeded', 'failed', 'cancelled'],
  'waiting-ui': ['running', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

export class JobStoreError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'JobStoreError'
    this.code = code
    this.details = details
  }
}

const iso = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z')

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
}

// Fingerprint the JSON the worker will see, including array order and excluding
// undefined object fields omitted on the wire.
export function operationFingerprint(request) {
  const normalized = JSON.parse(JSON.stringify(request))
  return createHash('sha256').update(JSON.stringify(canonicalJson(normalized))).digest('hex')
}

export class JobStore {
  constructor({ dir, now = () => new Date() }) {
    this.dir = dir
    this.now = now
    this.jobs = new Map()
    this.byOperation = new Map()
    mkdirSync(dir, { recursive: true })
    this.#load()
  }

  #load() {
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const record = JSON.parse(readFileSync(join(this.dir, name), 'utf8'))
        assertValid('job', record)
        this.jobs.set(record.jobId, record)
        this.#index(record)
      } catch {
        // 半个文件（掉电、进程被杀）不应该让整个 store 起不来；保留它，
        // 下次 reclaim 时会清掉，调用方看到的是「没有这个 job」而不是启动失败。
      }
    }
  }

  #index(record) {
    if (record.operationId) this.byOperation.set(this.#operationKey(record), record.jobId)
  }

  #operationKey(record) {
    return JSON.stringify([record.refs?.runId ?? '', record.operationId])
  }

  #persist(record) {
    assertValid('job', record)
    const path = join(this.dir, `${record.jobId}.json`)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  }

  find({ op, operationId, refs, fingerprint } = {}) {
    if (!operationId) return null
    const existing = this.jobs.get(this.byOperation.get(this.#operationKey({ refs, operationId })))
    if (!existing) return null
    if (existing.op !== op || existing.fingerprint !== fingerprint) {
      const legacy = existing.fingerprint === undefined && fingerprint !== undefined
      throw new JobStoreError(legacy ? 'OPERATION_REPLAY_UNVERIFIED' : 'OPERATION_ID_CONFLICT',
        legacy ? '旧作业缺少参数指纹，请先查询原作业并核对现场' : '同一 operationId 对应不同操作或参数',
        { jobId: existing.jobId, runId: refs?.runId, operationId })
    }
    return existing
  }

  submit({ op, operationId, refs, worker, retention, fingerprint, request, result } = {}) {
    if (!op || typeof op !== 'string') {
      throw new JobStoreError('BAD_ARGUMENT', 'submit 需要 op')
    }
    const existing = this.find({ op, operationId, refs, fingerprint })
    if (existing) return { job: existing, reused: true }
    const createdAt = iso(this.now())
    const record = {
      schemaVersion: 4,
      jobId: newId('job'),
      ...(operationId ? { operationId } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      ...(request ? { request } : {}),
      ...(result ? { result } : {}),
      op,
      state: 'queued',
      ...(refs ? { refs } : {}),
      ...(worker ? { worker } : {}),
      ...(retention ? { retention } : {}),
      createdAt,
    }
    this.#persist(record)
    this.jobs.set(record.jobId, record)
    this.#index(record)
    return { job: record, reused: false }
  }

  get(jobId) {
    return this.jobs.get(jobId) ?? null
  }

  list({ state, op, designId, effect, limit = 100 } = {}) {
    return [...this.jobs.values()]
      .filter((job) => (state ? job.state === state : true))
      .filter((job) => (op ? job.op === op : true))
      .filter((job) => (designId ? job.refs?.designId === designId : true))
      .filter((job) => (effect ? job.effect === effect : true))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, Math.max(1, limit))
  }

  transition(jobId, next, patch = {}) {
    const current = this.jobs.get(jobId)
    if (!current) throw new JobStoreError('JOB_NOT_FOUND', `没有 job ${jobId}`, { jobId })
    if (!TRANSITIONS[current.state]) {
      throw new JobStoreError('JOB_STATE_INVALID', `未知状态 ${current.state}`, { jobId })
    }
    if (!TRANSITIONS[current.state].includes(next)) {
      throw new JobStoreError('JOB_STATE_INVALID',
        `job ${jobId} 不能从 ${current.state} 变成 ${next}`, { jobId, from: current.state, to: next })
    }
    const at = iso(this.now())
    const record = { ...current, ...patch, state: next }
    if (next === 'running' && !record.startedAt) record.startedAt = at
    if (isTerminalJobState(next)) record.finishedAt = patch.finishedAt ?? at
    this.#persist(record)
    this.jobs.set(jobId, record)
    return record
  }

  update(jobId, patch = {}) {
    const current = this.jobs.get(jobId)
    if (!current) throw new JobStoreError('JOB_NOT_FOUND', `没有 job ${jobId}`, { jobId })
    const { progress, worker, effect, result, error, owner, reconciliation } = patch
    const record = { ...current, ...Object.fromEntries(Object.entries({
      progress, worker, effect, result, error, owner, reconciliation,
    }).filter(([, value]) => value !== undefined)) }
    this.#persist(record)
    this.jobs.set(jobId, record)
    return record
  }

  requestCancel(jobId) {
    const current = this.jobs.get(jobId)
    if (!current) throw new JobStoreError('JOB_NOT_FOUND', `没有 job ${jobId}`, { jobId })
    if (isTerminalJobState(current.state)) return { job: current, cancelled: false }
    const record = { ...current, cancelRequested: true }
    if (current.state === 'queued') {
      record.state = 'cancelled'
      record.finishedAt = iso(this.now())
    }
    this.#persist(record)
    this.jobs.set(jobId, record)
    return { job: record, cancelled: record.state === 'cancelled' }
  }

  /** 回收终态且超过保留期的记录；返回删掉的 jobId。 */
  reclaim({ keepMs = 7 * 24 * 3600_000 } = {}) {
    const removed = []
    const cutoff = this.now().getTime() - keepMs
    for (const [jobId, job] of this.jobs) {
      if (!isTerminalJobState(job.state)) continue
      if (job.effect === 'unknown' && !job.reconciliation) continue
      const until = job.retention?.until ? Date.parse(job.retention.until) : NaN
      const finished = job.finishedAt ? Date.parse(job.finishedAt) : NaN
      const expired = Number.isFinite(until) ? until <= this.now().getTime()
        : Number.isFinite(finished) ? finished <= cutoff : false
      if (!expired) continue
      const path = join(this.dir, `${jobId}.json`)
      if (existsSync(path)) unlinkSync(path)
      this.jobs.delete(jobId)
      if (job.operationId) this.byOperation.delete(this.#operationKey(job))
      removed.push(jobId)
    }
    return removed
  }
}
