/**
 * 工具面收敛：SW 预设（建模/装配体）看不到 bili 的上下文管理工具与宿主无关工具。
 *
 * 为什么要单独挂一行宿主插件：bili（billion-context）在 host 层注册了五条工具
 * ——acp_status / acp_cache / compress / decompress / search_context。它们是
 * profile 级的，预设内部没有办法在 cordis.patch.yml 里声明「不要哪一条」，
 * 只能在 preset 自己的作用域里用 tools.restrict 把它们遮掉。
 *
 * 为什么 sw-ptc 现在一条都不留（这一版的变化）：
 *   旧版只遮四条、留 compress。但绘图作业的模型请求已经由 bili-bypass.js 做成
 *   raw passthrough（不进 bili 的压缩管线，见 bili-bypass.js）。
 *   这时候 compress 不再有用：它会把会话里「刚看过的那张图」折成摘要，而本模式
 *   的全部前提是模型此刻还看得见细节。留着它只会诱导模型去压，压完又回不来
 *   （decompress 同样被遮）。所以 compress 也进 PTC_DENY。
 *
 * 为什么 sw-review 仍保留 compress：
 *   审查员是 review-gate 拉起的短命只读会话，上下文只有几张图，没有长历史可压；
 *   它也不在本模式的 bypass 范围内（它的请求照常经过 bili）。要一并遮就把名字挪进
 *   GLOBAL_DENY，只需要一行。
 *
 * 时机：必须同步、且在 agent 作用域里调。异步 ctx.plugin 装赶不上第一轮的
 * 工具表快照，那几条会拖到第二轮才消失（实测过的坑）。
 *
 * 为什么要重扫（这一版的重点）：
 *   bili 在 host 层是异步注册的，第一轮扫的时候那四个名字可能还不存在，
 *   restrict 会回 `names unknown global tool "acp_status", ...`。旧实现把这句
 *   当成「这个名字永远不存在」，于是把它**永久**从 deny 里剔掉 —— 等 bili 真正
 *   注册好后，deny 已经是空的，什么都没遮住。实测：20~26 个工具的会话里，
 *   有 3/4 的会话泄漏了这四条。
 *   现在改成：每轮扫描都从完整清单开始，未知名字只影响**这一次**尝试；
 *   并且在 agent 创建、每轮开始、每次工具表变化时重扫，直到遮住为止。
 */

export const name = 'sw-restrict-tools'

export const inject = ['tools']

/**
 * 只列「本 preset 不提供」的宿主全局工具。restrict 在共享作用域里无法区分全局
 * 同名工具与本 preset 自己的注册；把 read / read_image / ask_user_question /
 * goal_* 写进 deny 会把真正要用的工具一起遮掉。
 * compress 同理不在这里：sw-review 还要用它，sw-ptc 在 PTC_DENY 里单独加。
 */
const GLOBAL_DENY = [
  'working_directory', 'load_workspace_dependencies',
  'edit', 'write', 'glob', 'grep', 'pwsh', 'skill', 'workflow',
  'todo_write', 'present', 'plugin_manager',
  'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
  'cordis_inspect_list', 'cordis_inspect_query',
  'pwsh7_install', 'pwsh7_status',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'subagent', 'subagent_fork', 'interrupt_agent', 'list_agents',
  'send_message', 'wait_agent',
  'job_kill', 'job_list', 'job_output',
  'web_fetch', 'web_search',
  'ops_discover_tools', 'acp_status', 'acp_cache', 'decompress', 'search_context'
]

/** sw-ptc 保留 read / read_image / ask / goal_* / MCP；bili 五条上下文工具全遮。 */
const PTC_DENY = [...GLOBAL_DENY, 'compress']

/** 审查员没有 goal / ask 行，也不该看到它们。 */
const REVIEW_DENY = [
  ...GLOBAL_DENY,
  'ask_user_question', 'create_goal', 'get_goal', 'update_goal'
]

/**
 * 从 restrict 的报错里取出它不认识的名字。
 * 报错形如 `tools.restrict() names unknown global tool "a", "b"; known global
 * tools: ...` —— 分号前就是全部未知名字。
 */
const unknownNames = (error) => {
  const text = error instanceof Error ? error.message : String(error)
  if (!text.includes('names unknown global tool')) return []
  return [...text.split(';')[0].matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

export function apply(ctx, config = {}) {
  const tools = ctx.tools
  if (typeof tools?.restrict !== 'function') return

  // sw-review 连 goal / ask 都不给；sw-ptc 保留 read / read_image / ask / goal_* /
  // MCP，但 bili 的五条上下文工具（含 compress）一条不留。config 由两行 preset
  // 分别传入。
  const denyNames = config.preset === 'sw-review' ? REVIEW_DENY : PTC_DENY

  let dispose = null
  let covered = []
  let lastError = null
  /** 防重入：tools.restrict 会触发 tools/change，而 tools/change 又会调回 sweep。 */
  let busy = false

  /**
   * 扫一次：从完整清单开始，遇到未知名字就只把那些从**本次**尝试里拿掉再试。
   * 拿掉的名字不写进任何长期状态 —— 下一轮扫描它们会被重新尝试。
   */
  const sweep = (reason) => {
    if (busy) return
    busy = true
    try {
    let deny = denyNames.slice()
    while (deny.length > 0) {
      try {
        const next = tools.restrict({ deny })
        if (typeof dispose === 'function') {
          try {
            dispose()
          } catch {
            // 旧的 disposer 已经失效（比如 agent 换了作用域），忽略即可。
          }
        }
        dispose = next
        covered = deny.slice()
        lastError = null
        return
      } catch (error) {
        const unknown = unknownNames(error)
        if (unknown.length === 0) {
          lastError = error
          ctx.logger?.warn?.(`sw-restrict-tools: tools.restrict 失败（${reason}）：${String(error?.message ?? error)}`)
          return
        }
        const before = deny.length
        deny = deny.filter((tool) => !unknown.includes(tool))
        if (deny.length === before) {
          // 报错里点名的名字都不在我们清单里，说明是另一种失败，不要死循环。
          lastError = error
          return
        }
      }
    }
    // 全部名字都还不存在：这一轮什么都没遮，等下一次重扫。
    } finally {
      busy = false
    }
  }

  sweep('apply')

  // 重扫时机：agent 建好之后、每轮开始之前、工具表发生变化时。
  // 这三个事件名不是每个 DSH 版本都有，注册失败就当没有。
  const retry = (label) => () => {
    if (covered.length === denyNames.length) return
    try {
      sweep(label)
    } catch (error) {
      ctx.logger?.warn?.(`sw-restrict-tools: 重扫失败（${label}）：${String(error?.message ?? error)}`)
    }
  }

  for (const [event, label] of [
    ['agent/created', 'agent/created'],
    ['tools/change', 'tools/change'],
  ]) {
    try {
      ctx.on(event, retry(label))
    } catch {
      // 事件不存在就跳过。
    }
  }

  try {
    // 宿主派发签名是 (session, event)：session 在前、事件在第二个参数。
    // 写成单参时 event.type 恒为 undefined，turn/start 这次重扫从来没执行过（审计 M1）。
    ctx.on('session/event', (session, event) => {
      const type = event?.type ?? event?.kind
      if (type === 'turn/start' || type === 'turn_start') retry('turn/start')()
    })
  } catch {
    // 同上。
  }

  ctx.logger?.debug?.(`sw-restrict-tools: 已请求遮掉 ${denyNames.join(', ')}`)

  // 让「最后失败原因」在外部可查（调试用），不参与任何逻辑。
  Object.defineProperty(ctx, 'swRestrictState', {
    value: { get covered() { return covered.slice() }, get lastError() { return lastError } },
    enumerable: false,
    configurable: true,
  })
}
