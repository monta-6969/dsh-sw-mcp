/**
 * 建模/装配体预设的 bili 旁路：让这两个预设的模型请求 raw passthrough。
 *
 * 问题：desktop profile 装了 billion-context（bili），它在宿主层对所有预设的模型
 * 请求做上下文压缩与工具注入。绘图作业恰恰不能这样 —— 图与尺寸是「读一眼就得动手」
 * 的短上下文，压缩会把刚看过的那张图的说明折成摘要，模型转头照着摘要猜；猜错一个槽
 * 形，整块就要重画。所以本预设的请求不能进 bili 的压缩管线。
 *
 * 方案：不关 bili、不改全局配置、不影响其他预设。bili 的 HTTP 代理认一个请求头
 * `x-bili-plugin-bypass: 1`：带这个头的请求在代理里 raw passthrough（不绑定会话、
 * 不做工具注入、不压缩）。本插件只在「属于 preset-sw-native 会话」的 llm/stream 调用
 * 期间，给发往模型端点的 fetch 请求盖上这个头。
 *
 * 作用域为什么必须靠 sessionId 判（这一版的关键，别退回旧写法）：
 *   `llm/stream` 是宿主级的 waterfall —— 签名是 `(this: LlmRuntime, options, next)`，
 *   没有 `Scoped<...>`，LlmRuntime 也没有 `[Context.filter]`。Cordis 的事件派发只在
 *   `thisArg[Context.filter]` 存在时才按 ctx 过滤（cordis/lib/index.js 的
 *   `EventsService._resolve`），所以预设子树里 ctx.on 注册的监听器会收到宿主里
 *   **每一个会话**的模型调用。只看「我是在 preset-sw-native 里注册的」就无条件打标记，
 *   等于全进程关压缩 —— 曾经就是这个问题。
 *   权威来源在 options 里：`GenerateOptions.sessionId`（dsh-llm 类型，可选
 *   `Branded<'SessionId'>`），agent-loop 的 buildRequest 每条请求都带上
 *   `sessionId: this.session.id`。判定链：
 *     options.sessionId
 *       → ctx.get('agents').get(sessionId).session      （AgentRegistry.get）
 *       → ctx.get('agentPresets').presetForSession(session) === 'sw-native'
 *   `presetForSession` 读的是会话的 agentPreset 投影（header.agentPreset，再被
 *   `agent-preset/selected` 事件推进），DSH 自己的 api-session-controller 也用它判
 *   「这个会话跑哪个预设」，所以是权威的、不是猜的。
 *   判不出来时一律**不加头**（保守放行）：没有 sessionId、会话不 live、服务缺失、
 *   preset 为 null、取属性抛错 —— 都不打标记。这样最坏情况是 sw-native 继续被压缩，
 *   而不是别的预设被悄悄关掉压缩。
 *
 * 为什么还要 AsyncLocalStorage：
 *   sessionId 能判定「这次调用是不是 sw-native」，但 fetch 是进程全局的，bili 又在
 *   宿主层装了自己的链，fetch 包装拿不到「这次 fetch 属于哪次调用」。所以在
 *   llm/stream 包住的那段异步执行里打一个 ALS 标记，fetch 包装只认标记 —— 其他
 *   会话的 fetch 没有标记，原样放行；两个会话并发时各自的异步链互不影响。
 *
 * 为什么既包 next() 又包迭代：
 *   `next()` 只负责「造出流」；有的适配器到**迭代**时才真正发 HTTP（惰性）。ALS
 *   沿 async/await 链继承，但下一次 next() 的调度必须发生在标记内。因此两层都包：
 *   als.run(true, () => next()) 管住创建，AsyncIterable 的每一步迭代也放进同一标记。
 *
 * 幂等与卸载：
 *   - 包装只装一次。共享状态挂在 globalThis 的 Symbol.for('sw-mcp.bili-bypass') 上，
 *     HMR 重新求值模块也复用同一份（同一 ALS、同一包装），不会套两层；
 *   - 引用计数归零时由 ctx.effect 的清理函数恢复 globalThis.fetch；
 *   - 若期间 bili（或别的插件）又在外面装了一层，globalThis.fetch 已不是我们的
 *     函数：只清自己的引用，不抢占恢复，让最外层的链自然回落到它自己的下游。
 *     这种「别人套在我外面」正是 bili 的 re-chain 行为（它把第三方 fetch 当下游）。
 *
 * 关闭开关：SW_MCP_BILI_BYPASS=0（也接受 false/off/no）。此时 apply 直接返回：
 * 不装 fetch 包装、不注册 llm/stream，行为与没装本插件完全一致。
 *
 * 边界：
 *   - 只影响 preset-sw-native 的会话：判定见上面的 sessionId 链。`TARGET_PRESET` 必须
 *     与 cordis.patch.yml 里 preset 的 `id` 一致；config.preset 存在且不是 sw-native 时
 *     apply 直接返回。
 *   - 判不出来不加头是**故意**的：宁可 sw-native 被压缩，也不让别的预设被悄悄关掉压缩。
 *     若线上发现 sw-native 的请求没带上头，先看 options.sessionId 有没有、会话是不是
 *     刚创建还没进 AgentRegistry、或 profile 有没有换掉 agentPresets 服务。
 *   - 只加在模型端点上：/chat/completions、/completions、/responses、/messages
 *     （含 bili 改写后的 `/bili/https://…/v1/messages` 形态）。健康检查、模型
 *     列表、MCP 等其他请求一个字节都不动。
 *   - bili 不在时静默 no-op：没人读这个头，请求照常发；本插件从不 import bili。
 *
 * 兜底：若将来 bili 改了头名/入口，或链上别的代理把这个头剥掉，改用
 * bridge-sw-ptc profile（它本来就不装 billion-context）。（bili 旁路未实测。）
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export const name = 'sw-bili-bypass'

/** bili 代理的旁路头。 */
export const BYPASS_HEADER = 'x-bili-plugin-bypass'

/** 共享状态键：同一进程里多次求值模块/HMR 都落在同一份状态上。 */
export const SHARED_STATE_KEY = Symbol.for('sw-mcp.bili-bypass')

/** 本预设族默认服务的会话（preset 定义里的 `id`）。 */
export const TARGET_PRESET = 'sw-native'

/** 所有需要旁路的预设 id：建模与装配体各一份实例，实例只管自己那个 id。 */
export const PRESET_IDS = ['sw-native', 'sw-assembly']

/** 关闭值：真值语义（'0'、'false'、'off'、'no'）时 no-op。 */
const OFF_RE = /^(0|false|off|no)$/i

/** 模型端点路径后缀。'/' 结尾先剥掉；query 不参与判断。 */
const MODEL_PATH_SUFFIXES = ['/chat/completions', '/completions', '/responses', '/messages']

/**
 * 环境变量关闭开关。
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isBypassDisabled(env = process.env) {
  const raw = env?.SW_MCP_BILI_BYPASS
  if (typeof raw !== 'string') return false
  const value = raw.trim()
  return value.length > 0 && OFF_RE.test(value)
}

/**
 * URL 是不是一次模型推理请求（只看 pathname 后缀，不管域名；bili DSH 版会把
 * 请求改写成 `http://127.0.0.1:<port>/bili/https://api.…/v1/messages` 后再发，
 * 所以不能要求「以 /v1/ 开头」）。
 * @param {unknown} url
 * @returns {boolean}
 */
export function isModelEndpoint(url) {
  if (typeof url !== 'string' || url.length === 0) return false
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const pathname = parsed.pathname.replace(/\/+$/, '')
  return MODEL_PATH_SUFFIXES.some((suffix) => pathname.endsWith(suffix))
}

/** 取 fetch 第一个参数的 URL 字符串；取不到返回 undefined。 */
function fetchUrlOf(input) {
  try {
    if (typeof input === 'string') return input
    if (typeof URL === 'function' && input instanceof URL) return input.href
    if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url
  } catch {
    // 故意吞掉：拿不到 URL 就当不是模型端点，原样放行。
  }
  return undefined
}

/**
 * 给一次 fetch 调用盖上旁路头。
 *
 * - 字符串 / URL 输入：只在 init.headers 上补头，不改 body、不改 method。
 * - Request 输入：clone 一份再补头，原 Request 的 body 不标记为已用，method 与
 *   body 由 clone 保留（fetch(Request, { headers }) 的语义就是 body 沿用 Request）。
 * - 已经有这个头时不重复加，返回 null 让调用方原样透传。
 *
 * @param {RequestInfo | URL} input
 * @param {RequestInit | undefined} init
 * @param {string} [headerName]
 * @returns {{ input: RequestInfo | URL, init: RequestInit } | null}
 */
export function stampBypassHeaders(input, init, headerName = BYPASS_HEADER) {
  if (typeof Headers !== 'function') return null
  const isRequest = typeof Request === 'function' && input instanceof Request
  let headers
  try {
    headers = new Headers(isRequest ? (init?.headers ?? input.headers) : init?.headers)
  } catch {
    return null
  }
  if (headers.has(headerName)) return null
  headers.set(headerName, '1')
  const nextInit = { ...(init ?? {}), headers }
  if (!isRequest) return { input, init: nextInit }
  let cloned
  try {
    cloned = input.clone()
  } catch {
    // body 已经被读过（或流式 body 不可 clone）：不硬来，原样放行。
    return null
  }
  return { input: cloned, init: nextInit }
}

/**
 * 造一个「只在 ALS 标记内、且目标是模型端点时才盖头」的 fetch。
 * 纯函数：不碰 globalThis，方便单测。
 *
 * @param {typeof fetch} original
 * @param {AsyncLocalStorage<boolean>} storage
 * @param {{ enabled?: boolean | (() => boolean) }} [options]
 * @returns {typeof fetch}
 */
export function createBypassFetch(original, storage, options = {}) {
  const enabled = typeof options.enabled === 'function'
    ? options.enabled
    : () => options.enabled !== false && !isBypassDisabled()

  return async function swBiliBypassFetch(input, init) {
    // 任何一步出意外都不能让请求失败：判断不了就当它不是模型请求。
    if (storage.getStore() === true && enabled() && isModelEndpoint(fetchUrlOf(input))) {
      let stamped = null
      try {
        stamped = stampBypassHeaders(input, init)
      } catch {
        stamped = null
      }
      if (stamped !== null) return original(stamped.input, stamped.init)
    }
    return original(input, init)
  }
}

/**
 * 包住 llm/stream 返回的 AsyncIterable：每一步迭代都在 ALS 标记内调度，
 * 惰性发请求的适配器也能被盖到头。
 *
 * @template T
 * @param {AsyncIterable<T>} stream
 * @param {AsyncLocalStorage<boolean>} storage
 * @returns {AsyncIterable<T>}
 */
export function wrapStream(stream, storage) {
  if (stream === null || stream === undefined) return stream
  let iteratorFactory
  try {
    iteratorFactory = stream[Symbol.asyncIterator]
  } catch {
    return stream
  }
  if (typeof iteratorFactory !== 'function') return stream

  return (async function* swBiliBypassStream() {
    const iterator = iteratorFactory.call(stream)
    try {
      for (;;) {
        const step = await storage.run(true, () => iterator.next())
        if (step.done) return
        yield step.value
      }
    } finally {
      if (typeof iterator.return === 'function') {
        try {
          await storage.run(true, () => iterator.return())
        } catch {
          // 收尾失败不影响已经产出的 chunk。
        }
      }
    }
  })()
}

/**
 * 从 ctx 上读一个服务，读不到（或读的时候抛）返回 undefined。
 *
 * 用 `ctx.get(name)` 而不是 `ctx.name`：前者在服务缺失时返回 undefined，后者会抛
 * `cannot get property "..." without inject`；这两个服务都不是本插件的硬依赖，
 * 缺了只该让判定失败，不该让预设装配失败。
 *
 * @param {unknown} ctx
 * @param {string} name
 * @returns {any}
 */
export function serviceOf(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * 把宿主 ctx 的两个服务包成作用域判定的数据源（惰性解析：服务晚到也能用）。
 *
 * @param {unknown} ctx
 * @returns {{ agentOf: (sessionId: unknown) => any, presetOf: (session: unknown) => unknown }}
 */
export function createScopeSources(ctx) {
  return {
    agentOf(sessionId) {
      const agents = serviceOf(ctx, 'agents') // AgentRegistry
      return typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    },
    presetOf(session) {
      const presets = serviceOf(ctx, 'agentPresets') // AgentPresetRegistry
      return typeof presets?.presetForSession === 'function' ? presets.presetForSession(session) : undefined
    },
  }
}

/**
 * 「这次模型调用属于 sw-native 会话吗」——纯函数工厂，sources 由调用方注入，方便单测。
 *
 * 判定链：options.sessionId → agents.get(sessionId) → agent.session →
 * agentPresets.presetForSession(session) === presetId。
 * 任何一步拿不到（无 sessionId、会话不 live、preset 为 null、服务缺失、抛错）都
 * 返回 false：fail closed。
 *
 * @param {{ agentOf?: (sessionId: unknown) => any, presetOf?: (session: unknown) => unknown }} sources
 * @param {string} [presetId]
 * @returns {(options: unknown) => boolean}
 */
export function createSessionPresetFilter(sources, presetId = TARGET_PRESET) {
  const wanted = Array.isArray(presetId) ? presetId : [presetId]
  return function isTargetSession(options) {
    try {
      if (sources === null || typeof sources !== 'object') return false
      const sessionId = options?.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      const agent = sources.agentOf?.(sessionId)
      const session = agent?.session
      if (session === undefined || session === null) return false
      return wanted.includes(sources.presetOf?.(session))
    } catch {
      return false
    }
  }
}

/**
 * llm/stream 的监听器。`next()` 是 waterfall 的下一环；返回包好的流。
 *
 * 这是**全进程**可见的事件（见文件头），所以先问作用域判定，不是 sw-native 的调用
 * 连 ALS 标记都不打、原样交给下游。
 *
 * @param {AsyncLocalStorage<boolean>} storage
 * @param {(options: unknown) => boolean} [isTargetSession] 作用域判定；缺省视为不命中
 *   （保守：宁可不旁路，也不全进程关压缩）。
 */
export function createStreamListener(storage, isTargetSession) {
  return function swBiliBypassStreamListener(options, next) {
    if (typeof next !== 'function') return next
    let target = false
    if (typeof isTargetSession === 'function') {
      try {
        target = isTargetSession(options) === true
      } catch {
        // 判定本身抛错不算命中。
        target = false
      }
    }
    if (!target) return next()
    return wrapStream(storage.run(true, () => next()), storage)
  }
}

/** 进程级共享状态：同一进程内只装一层包装、共用一个 ALS。 */
function sharedState() {
  const existing = globalThis[SHARED_STATE_KEY]
  if (existing !== undefined && existing !== null && existing.version === 1) return existing
  const state = {
    version: 1,
    storage: new AsyncLocalStorage(),
    refs: 0,
    original: null,
    wrapper: null,
  }
  Object.defineProperty(globalThis, SHARED_STATE_KEY, {
    value: state,
    enumerable: false,
    configurable: true,
    writable: false,
  })
  return state
}

/**
 * 装一次 globalThis.fetch 包装（幂等），返回按引用计数的卸载函数。
 *
 * @param {AsyncLocalStorage<boolean>} [storage]
 * @returns {() => void}
 */
export function installFetchBypass(storage = sharedState().storage) {
  const state = sharedState()
  const original = globalThis.fetch
  if (typeof original !== 'function') return () => {}

  if (state.wrapper === null) {
    state.original = original
    state.wrapper = createBypassFetch(original, storage)
    globalThis.fetch = state.wrapper
  }
  state.refs += 1

  let released = false
  return function releaseBypassFetch() {
    if (released) return
    released = true
    state.refs = Math.max(0, state.refs - 1)
    if (state.refs > 0) return
    // 只有最外层还是我们时才恢复；被别人套在外面时不动别人的链。
    if (globalThis.fetch === state.wrapper) globalThis.fetch = state.original
    state.wrapper = null
    state.original = null
  }
}

/**
 * 插件入口。挂在 preset-sw-model / preset-sw-assembly 的 plugins 列表里，各传自己的 id。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ preset?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const ownPreset = typeof config?.preset === 'string' && config.preset.length > 0 ? config.preset : TARGET_PRESET
  if (!PRESET_IDS.includes(ownPreset)) return
  if (isBypassDisabled()) {
    ctx?.logger?.debug?.('sw-bili-bypass: SW_MCP_BILI_BYPASS=0，跳过（请求照常进 bili）')
    return
  }

  const state = sharedState()
  let release = null
  let started = false
  let stopped = false

  // 作用域判定：llm/stream 是全进程事件，只有 options.sessionId 指向一个跑在
  // sw-native 预设下的会话时才打标记。服务惰性解析，agent 服务晚到也不影响。
  const isTargetSession = createSessionPresetFilter(createScopeSources(ctx), ownPreset)

  const start = () => {
    if (started || stopped) return
    started = true
    try {
      release = installFetchBypass(state.storage)
      ctx.on('llm/stream', createStreamListener(state.storage, isTargetSession))
      ctx.logger?.debug?.('sw-bili-bypass: 已装 fetch 包装并监听 llm/stream（仅 sw-native 会话）')
    } catch (error) {
      // 装不上也不能让预设装配失败：没有旁路只是压缩继续，模型仍然能用。
      ctx.logger?.warn?.(`sw-bili-bypass: 安装失败，本预设继续走 bili：${error?.message ?? error}`)
      release = null
    }
  }

  // llm 是宿主服务，正常都在；用 ctx.inject 是为了在它晚到时也能等它出现，
  // 而不是让整个预设装配失败（选项服务依赖的常规写法）。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['llm'], start)
    } catch (error) {
      ctx.logger?.warn?.(`sw-bili-bypass: ctx.inject 失败，直接安装：${error?.message ?? error}`)
      start()
    }
  } else {
    start()
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    if (release !== null) {
      try {
        release()
      } catch (error) {
        ctx.logger?.warn?.(`sw-bili-bypass: 恢复 fetch 失败：${error?.message ?? error}`)
      }
      release = null
    }
  }

  if (typeof ctx.effect === 'function') {
    // effect 的工厂立即执行，返回的 stop 就是卸载时调用的 disposer。
    ctx.effect(() => stop, 'sw-bili-bypass: restore globalThis.fetch')
  } else if (typeof ctx.on === 'function') {
    // 老版本没有 ctx.effect：至少挂一个 dispose 事件兜底。
    try {
      ctx.on('dispose', stop)
    } catch {
      // 没有 dispose 事件就靠进程生命周期，注释里已说明。
    }
  }
}
