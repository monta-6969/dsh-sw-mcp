// 「task」工具：按依赖与资源执行一组 bridge 操作。
//
// 与 job 的分工：job 是单个持久操作；task 是有依赖的一批操作（例如先建轮廓、
// 再拉伸、再打孔）。同一 resource 的任务串行，不同 resource 可以并行。
import { graphFromDefinition } from './tasks.mjs'

import { DESCRIPTIONS } from './tool-face.mjs'

export function registerTaskTools(server, z, deps) {
  const { envelope, ok, fail, callBridge } = deps

  server.registerTool(
    'task',
    {
      title: '任务图',
      description: DESCRIPTIONS.task,
      inputSchema: z.object({
        action: z.enum(['run', 'validate']).default('run').describe('要做什么：run 执行；validate 只检查依赖与环'),
        concurrency: z.number().int().min(1).max(16).default(4).describe('最多同时跑几个任务'),
        tasks: z.array(z.object({
          id: z.string().describe('任务 id，图内唯一'),
          op: z.string().describe('bridge 操作名'),
          args: z.object({}).passthrough().optional().describe('该操作的参数'),
          deps: z.array(z.string()).optional().describe('必须先成功的任务 id'),
          resource: z.string().optional().describe('串行键，默认 solidworks'),
        })).min(1).max(64),
        force: z.enum(['manual']).optional()
          .describe('逃生口：仅在门禁不可达且用户已明确授权时传 "manual"；会写进 review/bypass.jsonl 留痕，正常交付不要用'),
        reason: z.string().optional().describe('配合 force:"manual"：一句话说明为什么绕门，写进 bypass.jsonl 留痕（先取得用户确认）'),
      }),
    },
    async (args) => {
      try {
        const definition = {
          concurrency: args.concurrency,
          tasks: args.tasks.map((task) => ({ ...task, resource: task.resource ?? 'solidworks' })),
        }
        const graph = graphFromDefinition(definition)
        if (args.action === 'validate') {
          return ok(envelope({
            summary: `任务图有效：${args.tasks.length} 个任务，无环`,
            changes: { tasks: graph.snapshot() },
          }))
        }
        const out = await graph.run({
          executor: async (node) => {
            const result = await callBridge(node.op, node.args ?? {})
            return { op: node.op, result }
          },
        })
        const failed = out.tasks.filter((task) => task.state === 'failed' || task.state === 'skipped')
        return ok(envelope({
          summary: out.ok
            ? `任务图完成：${out.counts.succeeded} 个任务成功`
            : `任务图未完成：${out.counts.succeeded ?? 0} 成功、${out.counts.failed ?? 0} 失败、${out.counts.skipped ?? 0} 跳过`,
          status: out.ok ? 'ok' : 'failed',
          changes: {
            counts: out.counts,
            tasks: out.tasks,
            ...(failed.length > 0 ? { failures: failed.map((task) => ({ id: task.id, error: task.error })) } : {}),
          },
          ...(out.ok ? {} : { nextActions: ['按失败任务的错误码修正后，只重跑失败分支'] }),
        }))
      } catch (error) {
        return ok(envelope({
          summary: `任务图没跑起来：${error?.message ?? error}`,
          status: 'failed',
          extra: { error: { code: error?.code ?? 'TASK_ERROR', message: error?.message ?? String(error), detail: error?.detail } },
        }))
      }
    },
  )
}
