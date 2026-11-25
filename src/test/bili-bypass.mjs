// bili-bypass.js 的离线单测。
//
// 为什么要有：这个插件是「静默生效」的 —— 头加错了不会报错，只会让绘图会话继续
// 被 bili 压缩；卸载没恢复也不会报错，只会把进程里所有预设的 fetch 都套一层。
// 两种失败都看不出来，所以这里把每条判断都钉死。
//
// 不依赖真实 bili、不发网络请求、不需要 SOLIDWORKS：fetch 是假的，llm/stream 是
// 手工调的 waterfall 监听器。
//
// 这一版补的重点是**作用域**：llm/stream 是全进程可见的事件，旧实现无条件打标记
// 等于全进程关压缩。现在只有 options.sessionId 指向 sw-native 会话时才打标记，所以
// 这里把「谁命中、谁不命中、判不出来怎么办」逐条钉死。

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  BYPASS_HEADER,
  SHARED_STATE_KEY,
  TARGET_PRESET,
  apply,
  createBypassFetch,
  createScopeSources,
  createSessionPresetFilter,
  createStreamListener,
  installFetchBypass,
  isBypassDisabled,
  isModelEndpoint,
  name as pluginName,
  serviceOf,
  stampBypassHeaders,
  wrapStream,
} from '../preset/bili-bypass.js'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

/** 共享状态挂在 globalThis 上；每个用例开始前清掉，避免上一段的包装/ALS 串进来。 */
function resetSharedState() {
  try {
    delete globalThis[SHARED_STATE_KEY]
  } catch {
    // 不可配置时说明有人改过 defineProperty，忽略即可。
  }
}

const realFetch = globalThis.fetch
const REAL_ENV = process.env.SW_MCP_BILI_BYPASS

/** 假 fetch：记录调用，并从 Request/init 里读出旁路头。 */
function makeRecorder() {
  const calls = []
  const fakeFetch = async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input?.url
    const headers = new Headers(init?.headers ?? input?.headers)
    calls.push({ url, method: init?.method ?? input?.method, header: headers.get(BYPASS_HEADER) })
    return { ok: true, url }
  }
  return { fakeFetch, calls }
}

/** 假 ctx：只实现插件真正用到的 inject / on / effect / logger / get。 */
function fakeCtx({ withInject = true, withEffect = true, services = {} } = {}) {
  const handlers = new Map()
  const effects = []
  const logs = []
  const ctx = {
    logger: {
      debug: (message) => logs.push(`debug ${message}`),
      warn: (message) => logs.push(`warn ${message}`),
    },
    // 真实 Cordis 里 ctx.get(name) 是 reflect.get 的 mixin：服务缺失返回 undefined，
    // 不抛。这里照抄这个语义（fake 没给的 key 就是 undefined）。
    get(name) {
      return services?.[name]
    },
    services,
    on(event, listener) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(listener)
      return () => {}
    },
    has(event) {
      return handlers.has(event)
    },
    emit(event, ...args) {
      for (const listener of handlers.get(event) ?? []) listener(...args)
    },
    handler(event) {
      return handlers.get(event)?.[0]
    },
    effects,
    logs,
    runEffects() {
      for (const dispose of effects.splice(0).reverse()) {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  if (withInject) {
    ctx.inject = (_names, callback) => {
      callback(ctx)
      return () => {}
    }
  }
  if (withEffect) {
    ctx.effect = (factory) => {
      const dispose = factory()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    }
  }
  return ctx
}

/**
 * 假的作用域服务：会话表 sessionId → preset id。
 *
 * 对应真实宿主的两个服务：`ctx.agents`（AgentRegistry.get）与
 * `ctx.agentPresets`（presetForSession）。这里只复刻本插件用到的那两个方法，
 * 并把调用记下来，方便断言「判定真的走了这条链」。
 */
function makeScopeServices(table = { 'sess-ptc': 'sw-native', 'sess-review': 'sw-review' }) {
  const sessions = new Map()
  for (const [id, preset] of Object.entries(table)) sessions.set(id, { id, preset })
  const calls = { agentOf: [], presetOf: [] }
  const services = {
    agents: {
      get(id) {
        calls.agentOf.push(id)
        const session = sessions.get(id)
        return session === undefined ? undefined : { id, session }
      },
    },
    agentPresets: {
      presetForSession(session) {
        calls.presetOf.push(session)
        return session?.preset ?? null
      },
    },
  }
  return { sessions, services, calls }
}

// ------------------------------------------------------------------ 元数据
const exportedFunctions = {
  apply,
  isModelEndpoint,
  isBypassDisabled,
  stampBypassHeaders,
  createBypassFetch,
  createStreamListener,
  createSessionPresetFilter,
  createScopeSources,
  serviceOf,
  wrapStream,
}
check('插件名与导出面正确', pluginName === 'sw-bili-bypass', { name: pluginName })
check('关键函数都是可测的导出', Object.values(exportedFunctions).every((fn) => typeof fn === 'function'), {
  keys: Object.keys(exportedFunctions),
})
check('目标预设 id 固定为 sw-native', TARGET_PRESET === 'sw-native', { target: TARGET_PRESET })

// --------------------------------------------------------- isModelEndpoint
{
  const positives = [
    'https://api.deepseek.com/v1/chat/completions',
    'https://api.deepseek.com/beta/chat/completions?stream=true',
    'https://api.anthropic.com/v1/messages',
    'https://api.openai.com/v1/responses',
    'https://api.openai.com/v1/completions',
    'http://127.0.0.1:8787/bili/https://api.anthropic.com/v1/messages',
    'http://127.0.0.1:8787/bili/responses/https://api.openai.com/v1/responses',
  ]
  const negatives = [
    '',
    'not a url',
    'https://api.deepseek.com/v1/models',
    'https://api.deepseek.com/v1/messages/123',
    'https://example.com/healthz',
    'file:///v1/messages',
  ]
  for (const url of positives) check(`模型端点识别：${url}`, isModelEndpoint(url) === true, url)
  for (const url of negatives) check(`非模型端点不碰：${url || '(空)'}`, isModelEndpoint(url) === false, url)
}

// ------------------------------------------------------- isBypassDisabled
{
  const cases = [
    [undefined, false],
    ['', false],
    ['1', false],
    ['true', false],
    ['yes', false],
    ['0', true],
    ['false', true],
    ['off', true],
    ['  No  ', true],
  ]
  for (const [value, expected] of cases) {
    check(`SW_MCP_BILI_BYPASS=${JSON.stringify(value)} → disabled=${expected}`, isBypassDisabled({ SW_MCP_BILI_BYPASS: value }) === expected, value)
  }
}

// ----------------------------------------------------- stampBypassHeaders
{
  const url = 'https://api.deepseek.com/v1/chat/completions'
  const stamped = stampBypassHeaders(url, undefined)
  check('字符串输入：补出头的 init', stamped !== null && stamped.input === url, {
    hasInput: stamped?.input === url,
  })
  check('字符串输入：头值是 "1"', new Headers(stamped?.init?.headers).get(BYPASS_HEADER) === '1', {
    header: new Headers(stamped?.init?.headers).get(BYPASS_HEADER),
  })

  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"x"}' }
  const stamped2 = stampBypassHeaders(url, init)
  const headers2 = new Headers(stamped2?.init?.headers)
  check('字符串输入：method/body 原样保留', stamped2?.init?.method === 'POST' && stamped2?.init?.body === '{"model":"x"}', {
    method: stamped2?.init?.method,
    body: stamped2?.init?.body,
  })
  check('字符串输入：原有 header 不被覆盖', headers2.get('content-type') === 'application/json' && headers2.get(BYPASS_HEADER) === '1', {
    contentType: headers2.get('content-type'),
    bypass: headers2.get(BYPASS_HEADER),
  })
  check('字符串输入：不原地改调用方的 init', init.headers[BYPASS_HEADER] === undefined, init.headers)

  check('已有旁路头时不重复加', stampBypassHeaders(url, { headers: { [BYPASS_HEADER]: '1' } }) === null)
  check('URL 对象输入也能加头', new Headers(stampBypassHeaders(new URL(url), undefined)?.init?.headers).get(BYPASS_HEADER) === '1')

  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"model":"x"}',
  })
  const stamped3 = stampBypassHeaders(request, undefined)
  const clone = stamped3?.input
  check('Request 输入：返回的是 clone，不是原对象', clone instanceof Request && clone !== request, {
    isRequest: clone instanceof Request,
    same: clone === request,
  })
  check('Request 输入：method 保留', clone?.method === 'POST' && clone?.url === url, {
    method: clone?.method,
    url: clone?.url,
  })
  check('Request 输入：原 Request 的 body 没被消费', request.bodyUsed === false, { bodyUsed: request.bodyUsed })
  check('Request 输入：clone 上补了旁路头', new Headers(stamped3?.init?.headers).get(BYPASS_HEADER) === '1')
  const bodyText = await clone?.text()
  check('Request 输入：body 原样保留', bodyText === '{"model":"x"}', { bodyText })

  const request2 = new Request(url, { method: 'POST', body: '{}' })
  const stamped4 = stampBypassHeaders(request2, { headers: { 'x-test': '1' } })
  check('Request 输入：init.headers 里的自定义头保留', new Headers(stamped4?.init?.headers).get('x-test') === '1', {
    xTest: new Headers(stamped4?.init?.headers).get('x-test'),
  })

  const used = new Request(url, { method: 'POST', body: '{}' })
  await used.text()
  check('Request 已被消费时放弃加头（不抛错）', stampBypassHeaders(used, undefined) === null)
}

// --------------------------------------------------------- createBypassFetch
{
  const storage = new AsyncLocalStorage()
  const { fakeFetch, calls } = makeRecorder()
  const wrapped = createBypassFetch(fakeFetch, storage)

  await wrapped('https://api.deepseek.com/v1/chat/completions', { method: 'POST', headers: {} })
  check('ALS 标记外：不加头', calls.at(-1)?.header === null, calls.at(-1))

  await storage.run(true, () => wrapped('https://api.deepseek.com/v1/chat/completions', { method: 'POST', headers: {} }))
  check('ALS 标记内 + 模型端点：加头', calls.at(-1)?.header === '1' && calls.at(-1)?.method === 'POST', calls.at(-1))

  await storage.run(true, () => wrapped('https://api.deepseek.com/v1/models', { headers: {} }))
  check('ALS 标记内 + 非模型端点：不加头', calls.at(-1)?.header === null, calls.at(-1))

  await storage.run(true, () => wrapped('https://api.deepseek.com/v1/chat/completions', {
    headers: { [BYPASS_HEADER]: '1' },
  }))
  check('ALS 标记内但头已存在：只调用一次、不重复加', calls.at(-1)?.header === '1', calls.at(-1))

  const off = createBypassFetch(fakeFetch, storage, { enabled: () => false })
  await storage.run(true, () => off('https://api.deepseek.com/v1/chat/completions', { headers: {} }))
  check('enabled=false（SW_MCP_BILI_BYPASS=0）时 no-op', calls.at(-1)?.header === null, calls.at(-1))

  // 上游 fetch 自己读 input.url；这里换成不读 url 的替身，单验「包装判断不出 URL 时
  // 不抛自己的错、把请求原样交给上游」。
  const tolerant = async () => ({ ok: true })
  const tolerantWrapped = createBypassFetch(tolerant, storage)
  const throwing = {
    get url() {
      throw new Error('boom')
    },
  }
  let error = null
  try {
    await storage.run(true, () => tolerantWrapped(throwing, {}))
  } catch (caught) {
    error = caught
  }
  check('URL 取值抛错时不影响请求（原样透传）', error === null, error?.message)

  const init = { headers: {} }
  await wrapped('https://api.deepseek.com/v1/chat/completions', init)
  check('不原地改调用方的 init（标记外）', init.headers[BYPASS_HEADER] === undefined, init.headers)
}

// ------------------------------------------------ createSessionPresetFilter
// 这是「只影响 sw-native」的全部依据：llm/stream 是全进程事件，谁能打标记只由这里决定。
{
  const sessionPtc = { id: 's1', preset: 'sw-native' }
  const sessionReview = { id: 's2', preset: 'sw-review' }
  const sessionNoPreset = { id: 's3', preset: null }
  const sources = {
    agentOf(sessionId) {
      if (sessionId === 's1') return { session: sessionPtc }
      if (sessionId === 's2') return { session: sessionReview }
      if (sessionId === 's3') return { session: sessionNoPreset }
      if (sessionId === 's4') return {}
      return undefined
    },
    presetOf(session) {
      return session?.preset ?? null
    },
  }
  const isTarget = createSessionPresetFilter(sources)
  check('sw-native 会话：命中', isTarget({ sessionId: 's1' }) === true)
  check('sw-review 会话：不命中（审查员照常进 bili）', isTarget({ sessionId: 's2' }) === false)
  check('preset 为 null 的会话：不命中', isTarget({ sessionId: 's3' }) === false)
  check('live 但拿不到 session：不命中', isTarget({ sessionId: 's4' }) === false)
  check('未知会话：不命中（fail closed）', isTarget({ sessionId: 'nope' }) === false)
  check('没有 sessionId：不命中', isTarget({}) === false, isTarget({}))
  check('options 为 undefined：不命中', isTarget(undefined) === false)
  check('sessionId 不是字符串：不命中', isTarget({ sessionId: 42 }) === false)
  check('sessionId 是空串：不命中', isTarget({ sessionId: '' }) === false)
  check('自定义 presetId 生效', createSessionPresetFilter(sources, 'sw-review')({ sessionId: 's2' }) === true)
  check('sources 为 null：不命中', createSessionPresetFilter(null)({ sessionId: 's1' }) === false)
  check('agentOf 抛错：不命中（不让异常冒到 waterfall）', createSessionPresetFilter({
    agentOf() {
      throw new Error('boom')
    },
  })({ sessionId: 's1' }) === false)
  check('presetOf 抛错：不命中', createSessionPresetFilter({
    agentOf: () => ({ session: sessionPtc }),
    presetOf() {
      throw new Error('boom')
    },
  })({ sessionId: 's1' }) === false)
}

// ------------------------------------------------------- serviceOf / sources
{
  check('serviceOf：服务缺失返回 undefined', serviceOf({ get: () => undefined }, 'agents') === undefined)
  check('serviceOf：ctx 没有 get 也不抛', serviceOf({}, 'agents') === undefined)
  check('serviceOf：ctx 是 undefined 也不抛', serviceOf(undefined, 'agents') === undefined)
  check('serviceOf：get 抛错时吞掉', serviceOf({
    get() {
      throw new Error('cannot get property without inject')
    },
  }, 'agents') === undefined)

  const scope = makeScopeServices()
  const fromCtx = createScopeSources({ get: (name) => scope.services[name] })
  const isTarget = createSessionPresetFilter(fromCtx)
  check('createScopeSources：从 ctx.get 解析出 sw-native 判定', isTarget({ sessionId: 'sess-ptc' }) === true, scope.calls.agentOf)
  check('createScopeSources：判定确实走了 agents → agentPresets 链', scope.calls.agentOf.at(-1) === 'sess-ptc' && scope.calls.presetOf.length > 0, {
    agentOf: scope.calls.agentOf,
    presetOf: scope.calls.presetOf.length,
  })
  check('createScopeSources：别的预设不命中', isTarget({ sessionId: 'sess-review' }) === false)
  check('createScopeSources：服务全缺时不命中', createSessionPresetFilter(
    createScopeSources({ get: () => undefined }),
  )({ sessionId: 'sess-ptc' }) === false)

  // 惰性：sources 先建好、服务后到（宿主服务晚于预设装配出现的情况）。
  const late = { services: {} }
  const lateFilter = createSessionPresetFilter(createScopeSources({ get: (name) => late.services[name] }))
  check('服务晚到之前：不命中', lateFilter({ sessionId: 'sess-ptc' }) === false)
  Object.assign(late.services, scope.services)
  check('服务晚到之后同一判定函数命中（惰性解析）', lateFilter({ sessionId: 'sess-ptc' }) === true)
}

// --------------------------------------------------- createStreamListener 作用域
// 直接验监听器：命中才打 ALS 标记，不命中连标记都不打。
{
  const storage = new AsyncLocalStorage()
  const { fakeFetch, calls } = makeRecorder()
  const wrapped = createBypassFetch(fakeFetch, storage)
  const modelUrl = 'https://api.deepseek.com/v1/chat/completions'
  const adapter = async function* () {
    await wrapped(modelUrl, { method: 'POST', headers: {} })
    yield { type: 'text-delta', text: 'ok' }
  }

  const listener = createStreamListener(storage, (options) => options?.sessionId === 'sess-ptc')
  const drain = async (fn) => {
    const out = []
    for await (const chunk of fn()) out.push(chunk)
    return out
  }

  check('命中：加头', (await drain(() => listener({ sessionId: 'sess-ptc' }, () => adapter()))).length === 1 && calls.at(-1)?.header === '1', calls.at(-1))
  check('不命中（别的会话）：不加头', (await drain(() => listener({ sessionId: 'other' }, () => adapter()))).length === 1 && calls.at(-1)?.header === null, calls.at(-1))
  check('不命中也照样把 chunk 原样传出去', (await drain(() => listener({ sessionId: 'other' }, () => adapter())))[0]?.type === 'text-delta')

  // 缺省判定：必须保守 —— 这是防止「退回旧写法」的闸门。
  const bare = createStreamListener(storage)
  check('没给作用域判定时不打标记（不允许全进程旁路）', (await drain(() => bare({ sessionId: 'sess-ptc' }, () => adapter()))).length === 1 && calls.at(-1)?.header === null, calls.at(-1))
  check('判定函数抛错时按不命中处理', (await drain(() => createStreamListener(storage, () => {
    throw new Error('boom')
  })({ sessionId: 'sess-ptc' }, () => adapter()))).length === 1 && calls.at(-1)?.header === null, calls.at(-1))
  check('next 不是函数时原样返回（不炸 waterfall）', bare({ sessionId: 'sess-ptc' }, undefined) === undefined)
  check('next 返回 null 也不炸', bare({ sessionId: 'sess-ptc' }, () => null) === null)
}

// ------------------------------------------------ 并发：标记不能在会话之间串
// 两个会话同时在流：sw-native 的标记活在它自己的异步链里，不能漏到另一个会话的请求上。
{
  const storage = new AsyncLocalStorage()
  const seen = []
  const fakeFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url
    seen.push({ url, header: new Headers(init?.headers ?? input?.headers).get(BYPASS_HEADER) })
    return { ok: true, url }
  }
  const wrapped = createBypassFetch(fakeFetch, storage)
  const listener = createStreamListener(storage, (options) => options?.sessionId === 'sess-ptc')
  const streamOf = (host) => (async function* () {
    for (let index = 0; index < 5; index += 1) {
      await wrapped(`https://${host}/v1/chat/completions`, { headers: {} })
      await new Promise((resolve) => setTimeout(resolve, 1))
      yield index
    }
  })()
  const drain = async (fn) => {
    for await (const chunk of fn()) void chunk
  }
  await Promise.all([
    drain(() => listener({ sessionId: 'sess-ptc' }, () => streamOf('a.example'))),
    drain(() => listener({ sessionId: 'sess-review' }, () => streamOf('b.example'))),
  ])
  const ptcCalls = seen.filter((call) => call.url.includes('a.example'))
  const otherCalls = seen.filter((call) => call.url.includes('b.example'))
  check('并发：sw-native 会话的每条请求都带旁路头', ptcCalls.length === 5 && ptcCalls.every((call) => call.header === '1'), {
    count: ptcCalls.length,
    headers: ptcCalls.map((call) => call.header),
  })
  check('并发：另一会话的请求一条都不带（标记不串）', otherCalls.length === 5 && otherCalls.every((call) => call.header === null), {
    count: otherCalls.length,
    headers: otherCalls.map((call) => call.header),
  })
}

// ---------------------------------------------------- installFetchBypass
{
  resetSharedState()
  globalThis.fetch = async () => ({ ok: true })
  try {
    const storage = new AsyncLocalStorage()
    const { fakeFetch, calls } = makeRecorder()
    globalThis.fetch = fakeFetch
    const release1 = installFetchBypass(storage)
    const installed = globalThis.fetch
    check('install 换掉 globalThis.fetch', installed !== fakeFetch && typeof installed === 'function', {
      same: installed === fakeFetch,
    })

    const release2 = installFetchBypass(storage)
    check('重复 install 不会套第二层（幂等）', globalThis.fetch === installed)

    await globalThis.fetch('https://api.deepseek.com/v1/chat/completions', { headers: {} })
    check('安装后：标记外不加头', calls.at(-1)?.header === null, calls.at(-1))

    await storage.run(true, () => globalThis.fetch('https://api.deepseek.com/v1/chat/completions', { headers: {} }))
    check('安装后：标记内加头', calls.at(-1)?.header === '1', calls.at(-1))

    release1()
    check('引用计数未归零时继续保留包装', globalThis.fetch === installed)
    release2()
    check('引用计数归零后恢复原 fetch', globalThis.fetch === fakeFetch, {
      restored: globalThis.fetch === fakeFetch,
    })
    release2()
    check('重复释放是 no-op', globalThis.fetch === fakeFetch)
  } finally {
    resetSharedState()
    globalThis.fetch = realFetch
  }
}

// --------------------------------------------------- apply + llm/stream 全链
{
  resetSharedState()
  delete process.env.SW_MCP_BILI_BYPASS
  const { fakeFetch, calls } = makeRecorder()
  globalThis.fetch = fakeFetch
  const url = 'https://api.deepseek.com/v1/chat/completions'
  const adapter = async function* () {
    await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"x"}',
    })
    yield { type: 'text-delta', text: 'ok' }
  }
  const drain = async (fn) => {
    const out = []
    for await (const chunk of fn()) out.push(chunk)
    return out
  }
  try {
    const scope = makeScopeServices()
    const ctx = fakeCtx({ services: scope.services })
    apply(ctx)
    check('apply 注册了 llm/stream', ctx.has('llm/stream'), { events: [...['llm/stream']].filter((event) => ctx.has(event)) })
    check('apply 换掉了 globalThis.fetch', globalThis.fetch !== fakeFetch)

    const listener = ctx.handler('llm/stream')
    const chunks = await drain(() => listener({ provider: 'deepseek', model: 'x', sessionId: 'sess-ptc' }, () => adapter()))
    check('sw-native 会话的 llm/stream：模型请求带旁路头', calls.at(-1)?.header === '1', calls.at(-1))
    check('llm/stream 的 chunk 原样传出去', chunks.length === 1 && chunks[0]?.type === 'text-delta', chunks)

    calls.length = 0
    const foreignChunks = await drain(() => listener({ provider: 'deepseek', model: 'x', sessionId: 'sess-review' }, () => adapter()))
    check('别的预设的会话：同一个监听器不加头（按会话收敛，不是按注册位置）', calls.at(-1)?.header === null, calls.at(-1))
    check('别的预设的 chunk 照样原样传出去', foreignChunks.length === 1 && foreignChunks[0]?.type === 'text-delta', foreignChunks)

    calls.length = 0
    await drain(() => listener({ provider: 'deepseek', model: 'x', sessionId: 'sess-unknown' }, () => adapter()))
    check('未知会话：不加头', calls.at(-1)?.header === null, calls.at(-1))

    calls.length = 0
    await drain(() => listener({ provider: 'deepseek', model: 'x' }, () => adapter()))
    check('没有 sessionId：不加头（fail closed）', calls.at(-1)?.header === null, calls.at(-1))

    calls.length = 0
    await globalThis.fetch(url, { headers: {} })
    check('llm/stream 之外的请求不加头', calls.at(-1)?.header === null, calls.at(-1))

    calls.length = 0
    await globalThis.fetch('https://api.deepseek.com/v1/models', { headers: {} })
    check('非模型请求不加头（模型没被附加无谓请求头）', calls.at(-1)?.header === null, calls.at(-1))

    ctx.runEffects()
    check('插件卸载后恢复 globalThis.fetch', globalThis.fetch === fakeFetch)
  } finally {
    resetSharedState()
    globalThis.fetch = realFetch
  }
}

// ----------------------------- apply：宿主没有 agents / agentPresets 时保守不旁路
{
  resetSharedState()
  delete process.env.SW_MCP_BILI_BYPASS
  const { fakeFetch, calls } = makeRecorder()
  globalThis.fetch = fakeFetch
  try {
    const ctx = fakeCtx() // services 里什么都没有
    apply(ctx)
    const listener = ctx.handler('llm/stream')
    const adapter = async function* () {
      await globalThis.fetch('https://api.deepseek.com/v1/chat/completions', { headers: {} })
      yield 'ok'
    }
    for await (const chunk of listener({ sessionId: 'sess-ptc' }, () => adapter())) void chunk
    check('取不到 agents/agentPresets 时不加头（宁可不旁路，不全进程关压缩）', calls.at(-1)?.header === null, calls.at(-1))
    ctx.runEffects()
  } finally {
    resetSharedState()
    globalThis.fetch = realFetch
  }
}

// ------------------------------------------- apply：bili 不在、两处 ctx 差异
{
  resetSharedState()
  delete process.env.SW_MCP_BILI_BYPASS
  const { fakeFetch } = makeRecorder()
  globalThis.fetch = fakeFetch
  try {
    const ctx = fakeCtx({ withInject: false })
    apply(ctx)
    check('ctx 没有 inject 时也能装（降级直接安装）', ctx.has('llm/stream') && globalThis.fetch !== fakeFetch)
    ctx.runEffects()
    check('降级路径也恢复了 fetch', globalThis.fetch === fakeFetch)
  } finally {
    resetSharedState()
    globalThis.fetch = realFetch
  }
}

{
  resetSharedState()
  delete process.env.SW_MCP_BILI_BYPASS
  const { fakeFetch } = makeRecorder()
  globalThis.fetch = fakeFetch
  try {
    const ctx1 = fakeCtx()
    const ctx2 = fakeCtx()
    apply(ctx1)
    const installed = globalThis.fetch
    apply(ctx2)
    check('同一进程两次 apply 复用同一层包装', globalThis.fetch === installed)
    ctx1.runEffects()
    check('只卸载一处时包装还在', globalThis.fetch === installed)
    ctx2.runEffects()
    check('两处都卸载后恢复', globalThis.fetch === fakeFetch)
  } finally {
    resetSharedState()
    globalThis.fetch = realFetch
  }
}

// -------------------------------------------------------- 关闭与预设作用域
{
  resetSharedState()
  const { fakeFetch } = makeRecorder()
  globalThis.fetch = fakeFetch
  process.env.SW_MCP_BILI_BYPASS = '0'
  try {
    const ctx = fakeCtx()
    apply(ctx)
    check('SW_MCP_BILI_BYPASS=0：不注册 llm/stream', !ctx.has('llm/stream'))
    check('SW_MCP_BILI_BYPASS=0：不换 globalThis.fetch', globalThis.fetch === fakeFetch)
  } finally {
    delete process.env.SW_MCP_BILI_BYPASS
    resetSharedState()
    globalThis.fetch = realFetch
  }
}

{
  resetSharedState()
  const { fakeFetch } = makeRecorder()
  globalThis.fetch = fakeFetch
  try {
    const ctx = fakeCtx()
    apply(ctx, { preset: 'sw-review' })
    check('config.preset 不是 sw-native 时 no-op', !ctx.has('llm/stream') && globalThis.fetch === fakeFetch)
  } finally {
    resetSharedState()
    globalThis.fetch = realFetch
  }
}

// ------------------------------------------------------- wrapStream 单独验
{
  const storage = new AsyncLocalStorage()
  let seen = null
  const stream = {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next() {
          if (index === 0) {
            seen = storage.getStore()
            index += 1
            return { done: false, value: 'a' }
          }
          return { done: true, value: undefined }
        },
      }
    },
  }
  const wrapped = wrapStream(stream, storage)
  const iterator = wrapped[Symbol.asyncIterator]()
  const first = await iterator.next()
  check('wrapStream 迭代时也带着 ALS 标记', seen === true && first.value === 'a', { seen, first })
}

if (REAL_ENV === undefined) delete process.env.SW_MCP_BILI_BYPASS
else process.env.SW_MCP_BILI_BYPASS = REAL_ENV
globalThis.fetch = realFetch

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAILED: ${failure}`)
  process.exitCode = 1
}
