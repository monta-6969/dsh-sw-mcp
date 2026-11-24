/**
 * SOLIDWORKS 预设的提示词收敛层（只在本 preset 的 agent 作用域内生效）。
 *
 * 基础平面会注入几段本模式用不到的全局说明：
 *   - harness:identity  「You are an AI agent powered by DeepSeek Harness.」
 *   - tool:jobs         宿主 job_* 工具（本模式没挂 tool-jobs）
 *   - tool:workflow     workflow 工具（本模式没挂）
 * sw-review 是只读审查员，再遮 goal / subagent（ask_user_question 没有提示段，
 * 只在 restrict-tools.js 里按工具遮，见 REVIEW_DENY）；
 * 保留 tool:read：sw-ptc 与 sw-review 都实际挂了 tool-fs read。
 *
 * 文本为空字符串时 renderPrompt 会整段丢掉；同名冲突只告警，不中断装配。
 */

export const name = 'sw-prompt-surface'

export const inject = ['systemPrompt']

const BASE_SHADOWED = [
  ['harness:identity', 'HARNESS_IDENTITY'],
  ['tool:jobs', 'TOOL_JOBS'],
  ['tool:workflow', 'TOOL_WORKFLOW'],
  // sw-ptc / sw-review 都没有终端（pwsh 已 deny、bash 未挂载），
  // 提示词里的 exit-code 说明只会把模型引向不存在的工具。
  ['tool:pwsh', 'TOOL_PWSH'],
  ['tool:bash', 'TOOL_BASH'],
]

// 只列「真有提示段」的：ask_user_question 由 dsh-tool-ask-user 注册的是工具本身，
// 全库没有 tool:ask_user_question 段、SECTION_ORDERS 里也没有对应 key，
// 所以它的准入只能靠 restrict-tools.js 的 REVIEW_DENY 遮工具，不在这里遮段（审计 M2）。
const REVIEW_SHADOWED = [
  ['tool:goal', 'TOOL_GOAL'],
  ['tool:subagent', 'TOOL_SUBAGENT'],
]

export function apply(ctx, config = {}) {
  const sp = ctx.systemPrompt
  const shadowed = config.preset === 'sw-review'
    ? [...BASE_SHADOWED, ...REVIEW_SHADOWED]
    : BASE_SHADOWED

  for (const [section, key] of shadowed) {
    try {
      const order = sp.getSectionOrder(key)
      if (typeof order !== 'number') {
        ctx.logger?.warn?.(`sw: no section order for ${key}, skip ${section}`)
        continue
      }
      ctx.effect(
        () => sp.section({ name: section, order, text: '', interpolate: false }),
        `sw: shadow ${section}`,
      )
    } catch (error) {
      // 同层已有同名 section 时只告警，不让整个预设装配失败。
      ctx.logger?.warn?.(
        `sw: cannot shadow ${section}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
