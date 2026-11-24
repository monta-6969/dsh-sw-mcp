// 机械配算工具：把工程公式做成可复算的调用。
//
// 为什么单独一个工具而不是塞进 model：算数字不需要 SOLIDWORKS 在场，
// 而且"这个设计成不成立"和"这个模型建得对不对"是两个问题，混在一个工具里
// 会让回答变成"体积对了所以设计对了"。这里只算、只判约束，不碰模型。
import { listCalculators, runCalculator, CodeError } from './calculators/index.mjs'

import { DESCRIPTIONS } from './tool-face.mjs'

export function registerCalculateTools(server, z, deps) {
  const { envelope, ok, failed, fail } = deps

  server.registerTool(
    'calculate',
    {
      title: '机械配算',
      description: DESCRIPTIONS.calculate,
      inputSchema: z.object({
        action: z.enum(['list', 'run', 'formula']).default('run').describe('要做什么'),
        calculator: z.string().optional().describe('计算器 id，例如 planetary / spur / bearing'),
        inputs: z.record(z.string(), z.any()).optional().describe('该计算器的输入参数'),
      }),
    },
    async (args) => {
      try {
        if (args.action === 'list') {
          const items = listCalculators()
          return ok(
            envelope({
              summary: `${items.length} 个计算器：${items.map((c) => c.id).join('、')}`,
              changes: { calculators: items },
              nextActions: [
                'calculate action="formula" calculator="<id>" 先看公式和假设',
                '算完把 checks 里没通过的条件先解决，再拿去建模',
              ],
            }),
          )
        }

        if (!args.calculator) throw fail('BAD_ARGUMENT', '需要 calculator；先 calculate action="list" 看有哪些')

        if (args.action === 'formula') {
          const item = listCalculators().find((c) => c.id === args.calculator)
          if (!item) {
            throw new CodeError('UNKNOWN_CALCULATOR', `没有叫 ${args.calculator} 的计算器`, {
              available: listCalculators().map((c) => c.id),
            })
          }
          return ok(
            envelope({
              summary: `${item.title}：${item.formulas.length} 条公式，${item.assumptions.length} 条适用边界`,
              changes: { calculator: item },
            }),
          )
        }

        const outcome = runCalculator(args.calculator, args.inputs)
        const failedChecks = (outcome.checks ?? []).filter((c) => !c.passed)
        const summary = buildSummary(args.calculator, outcome.result, failedChecks)

        return ok(
          envelope({
            summary,
            status: failedChecks.length === 0 ? 'ok' : 'failed',
            measurements: outcome.result,
            extra: {
              calculator: args.calculator,
              inputs: args.inputs ?? {},
              steps: outcome.steps,
              checks: outcome.checks,
              warnings: outcome.warnings,
            },
            nextActions: failedChecks.length === 0
              ? []
              : failedChecks.map((c) => `${c.name}：${c.note}`),
          }),
        )
      } catch (error) {
        return failed({ op: `calculate.${args.action}`, designId: null, error })
      }
    },
  )
}

/** 一句话说清这次算出了什么。不同计算器的结论形状差别很大，所以按 id 挑关键字段。 */
function buildSummary(id, result, failedChecks) {
  const tail = failedChecks.length ? `；${failedChecks.length} 条约束没通过` : ''
  switch (id) {
    case 'planetary':
      return `总传动比 ${result.totalRatio}，输入 ${result.inputSpeed} rpm → 输出 ${result.outputSpeed} rpm，`
        + `${result.stages.length} 级${tail}`
    case 'spur':
      return `传动比 ${result.ratio}，中心距 ${result.centerDistance} mm，重合度 ${result.contactRatio}${tail}`
    case 'belt':
      return `传动比 ${result.ratio}，节圆 Ø${result.d1}/Ø${result.d2} mm，带长 ${result.pitchLength} mm`
        + `（${result.beltTeeth} 齿）${tail}`
    case 'bearing':
      return `L10 = ${result.revolutions} 转，即 ${result.hours} 小时${tail}`
    case 'spring':
      return `刚度 ${result.rate} N/mm，旋绕比 ${result.index}，压并高度 ${result.solidHeight} mm${tail}`
    case 'thread':
      return `M${result.nominal}×${result.pitch}：应力截面积 ${result.stressArea} mm²`
        + `${result.tighteningTorque === undefined ? '' : `，拧紧扭矩 ${result.tighteningTorque} N·m`}${tail}`
    case 'shaft':
      return result.diameter === undefined
        ? `所需轴径 ${result.requiredDiameter} mm${tail}`
        : `Ø${result.diameter} mm 轴：合成应力 ${result.equivalentStress} MPa${tail}`
    case 'spline':
      return `${result.teeth} 齿花键：切应力 ${result.shearStress} MPa${tail}`
    default:
      return `已算出 ${id}${tail}`
  }
}
