// 任务图：节点是「要执行的 bridge 操作」，边是依赖，资源键决定哪些节点不能并行。
//
// 为什么不是简单的 Promise.all：建模任务里「两个零件并行」与「同一零件上的
// 两次编辑」是两回事。后者必须串行，否则后一次在旧几何上算；前者应该并行，
// 否则自动取实例没有意义。资源键把这件事说清楚：同键串行，不同键并行。
//
// 图本身不做模型语义判断。谁提交、失败后怎么办由调用方决定；这里只保证
// 依赖满足、无环、资源不冲突，并把每个节点的状态如实记下来。

export class TaskGraphError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'TaskGraphError'
    this.code = code
    this.detail = detail
  }
}

export const TASK_STATES = ['pending', 'ready', 'running', 'succeeded', 'failed', 'skipped']

export class TaskGraph {
  constructor({ concurrency = 4 } = {}) {
    this.concurrency = Math.max(1, concurrency)
    this.nodes = new Map()
  }

  add({ id, op, args = {}, deps = [], resource = 'default' }) {
    if (typeof id !== 'string' || id.length === 0) throw new TaskGraphError('TASK_BAD_ID', '任务 id 不能为空')
    if (this.nodes.has(id)) throw new TaskGraphError('TASK_DUPLICATE', `任务 id 重复：${id}`)
    if (typeof op !== 'string' || op.length === 0) throw new TaskGraphError('TASK_BAD_OP', `任务 ${id} 缺少 op`)
    this.nodes.set(id, {
      id, op, args, deps: [...new Set(deps)], resource,
      state: 'pending', jobId: null, result: null, error: null,
    })
    return this
  }

  /** 环、悬空依赖、自依赖都在提交前拒绝，而不是跑到一半才发现。 */
  validate() {
    for (const node of this.nodes.values()) {
      for (const dep of node.deps) {
        if (!this.nodes.has(dep)) throw new TaskGraphError('TASK_UNKNOWN_DEP', `任务 ${node.id} 依赖不存在的 ${dep}`, { task: node.id, dep })
        if (dep === node.id) throw new TaskGraphError('TASK_CYCLE', `任务 ${node.id} 依赖自己`, { task: node.id })
      }
    }
    const visiting = new Set()
    const visited = new Set()
    const visit = (id, path) => {
      if (visited.has(id)) return
      if (visiting.has(id)) {
        throw new TaskGraphError('TASK_CYCLE', `任务图有环：${[...path, id].join(' -> ')}`, { cycle: [...path, id] })
      }
      visiting.add(id)
      for (const dep of this.nodes.get(id).deps) visit(dep, [...path, id])
      visiting.delete(id)
      visited.add(id)
    }
    for (const id of this.nodes.keys()) visit(id, [])
    return this
  }

  pending() {
    return [...this.nodes.values()].filter((node) => node.state === 'pending' || node.state === 'ready')
  }

  ready() {
    return [...this.nodes.values()].filter((node) => {
      if (node.state !== 'pending' && node.state !== 'ready') return false
      return node.deps.every((dep) => this.nodes.get(dep).state === 'succeeded')
    })
  }

  blocked() {
    return [...this.nodes.values()].filter((node) => (node.state === 'pending' || node.state === 'ready')
      && node.deps.some((dep) => ['failed', 'skipped'].includes(this.nodes.get(dep).state)))
  }

  snapshot() {
    return [...this.nodes.values()].map((node) => ({
      id: node.id, op: node.op, state: node.state, deps: node.deps, resource: node.resource,
      jobId: node.jobId, error: node.error,
      ...(node.result !== null && node.result !== undefined ? { result: node.result } : {}),
    }))
  }

  /**
   * 执行整张图。executor(node) 返回 Promise；并发上限与资源键同时生效：
   * 同一 resource 同时只能有一个在跑（文档级串行），不同 resource 可并行。
   */
  async run({ executor, signal, onEvent } = {}) {
    if (typeof executor !== 'function') throw new TaskGraphError('TASK_NO_EXECUTOR', 'run 需要 executor 函数')
    this.validate()
    for (const node of this.nodes.values()) if (node.state === 'pending') node.state = 'ready'
    const running = new Map()
    const resourceBusy = new Set()
    let aborted = false

    const emit = (event) => { try { onEvent?.(event) } catch { /* 观察者失败不影响调度 */ } }

    while (true) {
      if (signal?.aborted) {
        aborted = true
        break
      }
      const blocked = this.blocked()
      for (const node of blocked) {
        node.state = 'skipped'
        node.error = { code: 'TASK_DEPENDENCY_FAILED', message: `依赖失败：${node.deps.filter((dep) => ['failed', 'skipped'].includes(this.nodes.get(dep).state)).join(', ')}` }
        emit({ kind: 'skipped', id: node.id, error: node.error })
      }
      const ready = this.ready()
      for (const node of ready) {
        if (running.size >= this.concurrency) break
        // ready 是循环开始时算出来的；同一资源的前一个节点可能在本轮刚被
        // 放上运行队列，所以这里必须重新检查，不能只靠数组过滤。
        if (resourceBusy.has(node.resource)) continue
        node.state = 'running'
        resourceBusy.add(node.resource)
        emit({ kind: 'start', id: node.id, op: node.op })
        const promise = Promise.resolve()
          .then(() => executor(node))
          .then((result) => {
            node.state = 'succeeded'
            node.result = result
            emit({ kind: 'succeeded', id: node.id })
          })
          .catch((error) => {
            node.state = 'failed'
            node.error = { code: error?.code ?? 'TASK_FAILED', message: error?.message ?? String(error) }
            emit({ kind: 'failed', id: node.id, error: node.error })
          })
          .finally(() => {
            running.delete(node.id)
            resourceBusy.delete(node.resource)
          })
        running.set(node.id, promise)
      }
      if (running.size === 0) {
        if (this.ready().length === 0) break
        // 所有 ready 节点都被资源占住是不可能的（running.empty 就没人占），
        // 走到这里说明有依赖环或状态坏了；宁可报错也不要空转。
        throw new TaskGraphError('TASK_STALLED', '没有可运行的任务，但仍有未完成节点', { nodes: this.snapshot() })
      }
      await Promise.race(running.values())
    }

    if (aborted) {
      for (const node of this.nodes.values()) {
        if (node.state === 'running' || node.state === 'ready' || node.state === 'pending') node.state = 'skipped'
        node.error = node.state === 'skipped' ? { code: 'TASK_CANCELLED', message: '任务图被取消' } : node.error
      }
    }
    const counts = this.snapshot().reduce((acc, node) => { acc[node.state] = (acc[node.state] ?? 0) + 1; return acc }, {})
    return {
      ok: counts.succeeded === this.nodes.size,
      counts,
      tasks: this.snapshot(),
      ...(aborted ? { cancelled: true } : {}),
    }
  }
}

/** 从简单 JSON 定义建图：{ tasks: [{id, op, args, deps, resource}] }。 */
export function graphFromDefinition(definition) {
  const graph = new TaskGraph({ concurrency: definition?.concurrency })
  for (const task of definition?.tasks ?? []) graph.add(task)
  return graph.validate()
}
