// 「job」工具：把 bridge 操作提交成持久作业，立即返回 jobId。
//
// 与直接调 model/workspace 的区别：作业先落盘再执行，MCP 会话断开、
// 等待超时都不会把任务杀死；之后用 job status/result 取回结果。
import { SW_CLIENT_ID } from './session-id.mjs'
import { BrokerClient } from './broker/client.mjs'
import { instanceOverrideFields, resolveInstanceOverrides } from './broker/affinity.mjs'

import { DESCRIPTIONS } from './tool-face.mjs'

export function registerJobTools(server, z, deps) {
  const { envelope, ok, fail } = deps
  let client = null

  async function broker() {
    if (client === null) client = await BrokerClient.connect({ spawnIfMissing: true })
    return client
  }

  /** 实例策略参数：显式参数 > 调用方 env > 不传（由 broker 的 env 决定）。
   * broker 是常驻进程，只认启动时 env；不把会话里的 isolated/3 透下去，
   * 隔离策略就是空谈（真机缺陷 A）。 */
  function instanceOverrideParams(args = {}) {
    return resolveInstanceOverrides({
      policy: args.policy,
      tag: args.tag,
      maxInstances: args.maxInstances,
    }, process.env)
  }

  function overrideRequestFields(overrides) {
    return instanceOverrideFields(overrides)
  }

  function jobEnvelope(job, summary) {
    return ok(envelope({
      summary,
      status: job?.state === 'failed' ? 'failed' : 'ok',
      changes: { job },
      ...(job?.error ? { extra: { error: job.error } } : {}),
    }))
  }

  server.registerTool(
    'job',
    {
      title: '持久作业',
      description: DESCRIPTIONS.job,
      inputSchema: z.object({
        action: z.enum(['submit', 'status', 'result', 'await', 'list', 'cancel', 'reclaim', 'health', 'instances', 'ensure', 'documents', 'release']).default('submit')
          .describe('要做什么：submit / status / result / await / list / cancel / reclaim / health / instances / ensure / documents / release'),
        op: z.string().optional().describe('submit：bridge 操作名'),
        args: z.object({}).passthrough().optional().describe('submit：该操作的参数'),
        operationId: z.string().optional().describe('submit：幂等键（同一 runId 内不重复执行）'),
        runId: z.string().optional().describe('submit：作业所属运行'),
        instancePid: z.number().int().optional().describe('submit/ensure：指定 SOLIDWORKS 实例 PID；省略时用默认实例'),
        policy: z.enum(['shared', 'isolated']).optional().describe('submit(ensure)/ensure：实例策略；省略时用调用方 env（SW_MCP_INSTANCE_POLICY）'),
        tag: z.string().optional().describe('submit(ensure)/ensure：实例归属标签；省略时用调用方 env（SW_MCP_INSTANCE_TAG）'),
        maxInstances: z.number().int().min(1).max(32).optional().describe('submit(ensure)/ensure：实例数量上限；省略时用调用方 env（SW_MCP_MAX_INSTANCES）'),
        startWorker: z.boolean().default(true).describe('ensure：是否为该实例预热 STA worker'),
        ensure: z.boolean().default(false).describe('submit：没有实例时先自动启动 SOLIDWORKS 并预热 worker'),
        timeoutMs: z.number().int().min(1000).max(3600000).optional().describe('submit/ensure：执行或等待超时，默认 240000/180000'),
        jobId: z.string().optional().describe('status/result/await/cancel：作业 id'),
        waitMs: z.number().int().min(1000).max(120000).default(120000)
          .describe('await：最长阻塞等待毫秒（≤120 s）；到点仍没结束就回当前状态，不要立刻再查'),
        designId: z.string().optional().describe('release：按设计 id 释放；与 title 二选一'),
        title: z.string().optional().describe('release：按文档标题释放；与 designId 二选一'),
        state: z.enum(['queued', 'running', 'waiting-ui', 'succeeded', 'failed', 'cancelled']).optional().describe('list：按状态过滤'),
        limit: z.number().int().min(1).max(200).default(20).describe('list：最多返回多少条'),
        keepMs: z.number().int().min(0).optional().describe('reclaim：保留多久内的终态记录，默认 7 天'),
        force: z.enum(['manual']).optional()
          .describe('逃生口：仅在门禁不可达且用户已明确授权时传 "manual"；会写进 review/bypass.jsonl 留痕，正常交付不要用'),
        reason: z.string().optional().describe('配合 force:"manual"：一句话说明为什么绕门，写进 bypass.jsonl 留痕（先取得用户确认）'),
      }),
    },
    async (args) => {
      try {
        const connection = await broker()
        if (args.action === 'health') {
          const [hello, workers] = await Promise.all([connection.request('hello'), connection.request('workers.list')])
          return ok(envelope({
            summary: `broker 可达（pid ${hello.pid}），${workers.workers.length} 个 worker`,
            changes: { hello, workers: workers.workers },
          }))
        }
        if (args.action === 'instances') {
          const listed = await connection.request('instances.list')
          return ok(envelope({
            summary: (listed.instances?.length ?? 0) === 0
              ? '没有正在运行的 SOLIDWORKS 实例（可用 action="ensure" 启动）'
              : `${listed.instances.length} 个实例，${listed.workers?.length ?? 0} 个 worker 已登记`,
            changes: listed,
          }))
        }
        if (args.action === 'ensure') {
          const overrides = instanceOverrideParams(args)
          const ensured = await connection.request('instances.ensure', {
            clientId: SW_CLIENT_ID,
            instancePid: args.instancePid,
            timeoutMs: args.timeoutMs,
            startWorker: args.startWorker,
            ...overrideRequestFields(overrides),
          }, { timeoutMs: (args.timeoutMs ?? 180_000) + 15_000 })
          const pid = ensured.chosenPid
          const effective = `policy=${ensured.policy ?? '?'}, maxInstances=${ensured.maxInstances ?? '?'}, tag=${ensured.tag ?? 'null'}`
          const degraded = ensured.degraded === true
            ? `，degraded：COM 可用但有 ${ensured.unclickedDialogs?.length ?? 0} 个对话框没点掉`
            : ''
          return ok(envelope({
            summary: ensured.instances?.length
              ? `实例可用：pid ${pid}（${effective}${ensured.launched?.launched ? '，本次启动' : ''}${ensured.warmed ? '，worker 已预热' : ''}）${degraded}`
              : `没能取得实例：${ensured.warmError?.message ?? ensured.probeError ?? '等待超时'}`,
            status: ensured.instances?.length ? 'ok' : 'failed',
            changes: { ...ensured, instancePid: ensured.instancePid ?? pid ?? null, requested: overrides },
            nextActions: ensured.instances?.length
              ? ['用 job action="submit" 提交到该 instancePid；同一 operationId 会复用结果']
              : ['确认本机已安装 SOLIDWORKS，或用 SW_MCP_SW_LAUNCH 指向可启动的快捷方式'],
          }))
        }
        if (args.action === 'documents') {
          const listed = await connection.request('documents.list', { clientId: SW_CLIENT_ID })
          return ok(envelope({
            summary: `实例上打开 ${listed.documents?.length ?? 0} 份文档`,
            changes: listed,
          }))
        }
        if (args.action === 'release') {
          if (!args.designId && !args.title) throw fail('BAD_ARGUMENT', 'release 需要 designId 或 title')
          const released = await connection.request('documents.release', {
        clientId: SW_CLIENT_ID,
            designId: args.designId,
            title: args.title,
          }, { timeoutMs: 60_000 })
          return ok(envelope({
            summary: released.released
              ? `已关闭并释放 ${released.title}`
              : `没有释放：${released.note ?? released.title ?? '未登记'}`,
            status: released.released ? 'ok' : 'failed',
            changes: released,
          }))
        }
        if (args.action === 'submit') {
          if (typeof args.op !== 'string' || args.op.length === 0) throw fail('BAD_ARGUMENT', 'submit 需要 op')
          const overrides = instanceOverrideParams(args)
          const result = await connection.request('jobs.dispatch', {
            clientId: SW_CLIENT_ID,
            op: args.op,
            args: args.args ?? {},
            operationId: args.operationId,
            refs: args.runId ? { runId: args.runId } : undefined,
            instancePid: args.instancePid ?? 0,
            timeoutMs: args.timeoutMs,
            ensure: args.ensure === true,
            // ensure=true 时同一套策略也要透传：作业自己的启动路径同样受 isolated/上限约束。
            ...overrideRequestFields(overrides),
          })
          return jobEnvelope(result.job, result.reused
            ? `复用已有作业 ${result.job.jobId}（${result.job.state}）`
            : `已提交 ${result.job.jobId}（${result.job.state}），用 job status 查询`)
        }
        if (args.action === 'list') {
          const result = await connection.request('jobs.list', { state: args.state, limit: args.limit })
          return ok(envelope({
            summary: `共 ${result.jobs.length} 条作业`,
            changes: { jobs: result.jobs },
          }))
        }
        if (args.action === 'reclaim') {
          const result = await connection.request('jobs.reclaim', { keepMs: args.keepMs })
          return ok(envelope({ summary: `回收了 ${result.removed} 条过期作业记录`, changes: { removed: result.removed } }))
        }
        if (typeof args.jobId !== 'string' || args.jobId.length === 0) throw fail('BAD_ARGUMENT', `${args.action} 需要 jobId`)
        if (args.action === 'await') {
          // 长轮询：DSH 里 766 次 job.status 大多是「立刻再查一次」。让这一次调用把等待包住。
          const startedAwait = Date.now()
          const deadline = startedAwait + (Number(args.waitMs) || 120000)
          let job = null
          for (;;) {
            const got = await connection.request('jobs.get', { jobId: args.jobId })
            job = got.job
            const terminal = ['succeeded', 'failed', 'cancelled'].includes(job?.state)
            if (terminal || Date.now() >= deadline) break
            await new Promise((resolve) => setTimeout(resolve, 1500))
          }
          const waitedMs = Date.now() - startedAwait
          const terminalNow = ['succeeded', 'failed', 'cancelled'].includes(job?.state)
          return jobEnvelope(job,
            '作业 ' + args.jobId + '：' + job?.state + '（等了 ' + Math.round(waitedMs / 1000) + ' s）'
            + (terminalNow ? '' : '；还没结束，先用 result 取已有进展，或继续 await，不要连发 status'))
        }
        if (args.action === 'status' || args.action === 'result') {
          const { job } = await connection.request('jobs.get', { jobId: args.jobId })
          if (args.action === 'result') {
            if (['queued', 'running', 'waiting-ui'].includes(job.state)) {
              return jobEnvelope(job, `作业还在跑（${job.state}），稍后再取结果`)
            }
            return jobEnvelope(job, job.state === 'succeeded'
              ? `作业 ${job.jobId} 成功（${job.op}）`
              : `作业 ${job.jobId} ${job.state}：${job.error?.message ?? ''}`)
          }
          return jobEnvelope(job, `作业 ${job.jobId}：${job.state}${job.error ? `（${job.error.code}）` : ''}`)
        }
        if (args.action === 'cancel') {
          const result = await connection.request('jobs.cancel', { jobId: args.jobId })
          return ok(envelope({ summary: `取消请求已记录（${result.state ?? 'unknown'}）`, changes: result }))
        }
        throw fail('UNKNOWN_ACTION', args.action)
      } catch (error) {
        return ok(envelope({
          summary: `作业操作失败：${error?.message ?? error}`,
          status: 'failed',
          extra: { error: { code: error?.code ?? 'JOB_ERROR', message: error?.message ?? String(error), detail: error?.detail } },
        }))
      }
    },
  )
}
