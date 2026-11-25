// 收尾时的经验提醒。
//
// 为什么需要它：人设里写着「有值得记的就记一条」，但那是一句软指令 —— 模型做完事、
// 目标一标完成，就顺着收尾了，多半想不起去写经验。经验库的价值全在「当时写下」，
// 隔一轮再补，细节已经丢了。
//
// 为什么不用 goal/changed 事件 + agent.followup()：
//   1. followup 需要 createUserMessage（@deepseek-ai/dsh-llm），而 link: 类型的 bundle
//      里 import 不到那个包，只能手工复刻消息结构，形状一变就静默坏掉；
//   2. followup 会多起一整轮对话，还可能搅乱目标轮次计数。
// 挂在 tools/execute 上只包一层、就地追加一段文字，同一步内生效，不碰目标状态机。
//
// 触发点两个：目标收尾（update_goal 的 complete / blocked），
// 以及交付成功（mcp__sw__deliver 返回 ok）—— 交付往往就是一个任务的自然结束。
//
// 提醒失败绝不能影响工具本身的返回：所以改写包在 try 里，出错就原样返回。
export const name = 'sw-experience-nudge'

const NUDGE = [
  '',
  '---',
  '📝 有值得记的就记一条：`workspace` 传 `{ action: "lesson", lesson: { action: "add", text, kind, status } }`。',
  '一句话写「做了什么 → 看到什么现象 → 结论」；没有就回「无新增经验」。',
].join('\n')

function isGoalDone(exec, result) {
  if (exec?.name !== 'update_goal') return false
  const action = exec.arguments?.action
  return (action === 'complete' || action === 'blocked') && result && !result.isError
}

function isDelivered(exec, result) {
  const name = String(exec?.name ?? '')
  if (!/(^|__)deliver$/.test(name)) return false
  if (!result || result.isError) return false
  // 我们的工具失败也走正常返回，所以要看文本里的 status。
  const text = Array.isArray(result.content)
    ? result.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
    : ''
  return /"status"\s*:\s*"ok"/.test(text) || /status:\s*ok/.test(text)
}

export function apply(ctx) {
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()

    try {
      if (!isGoalDone(exec, result) && !isDelivered(exec, result)) return result
      const content = Array.isArray(result.content) ? [...result.content] : []
      content.push({ type: 'text', text: NUDGE })
      return { ...result, content }
    } catch (error) {
      ctx.logger?.warn?.(`experience-nudge: 追加提醒失败，已忽略：${error?.message ?? error}`)
      return result
    }
  })
}
