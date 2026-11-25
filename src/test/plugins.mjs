// 三个本地插件的离线用例。
//
// 为什么要有：这三个插件不在 MCP server 里，跑整套 SOLIDWORKS 测试也覆盖不到它们，
// 而不起作用时**看不出来** —— restrict 没遮住时只是多几个工具，digest 没注入时
// 只是模型不知道经验，nudge 没触发时只是没人提醒记经验。都属于「静默失效」。
//
// 做法：假 ctx（只实现用到的 on / logger / effect / tools.restrict），把真插件加载进来，
// 用真数据（真的 notes.jsonl 格式、真的报错文本）跑。
//
// 不需要 SOLIDWORKS。

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { repoRoot } from './lib/mcp.mjs'
import { readFileSync } from 'node:fs'
const readPlugin = readFileSync(join(repoRoot, 'preset', 'restrict-tools.js'), 'utf8')

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

function fakeCtx({ restrict } = {}) {
  const handlers = new Map()
  const logs = []
  const ctx = {
    logger: {
      warn: (m) => logs.push(`warn ${m}`),
      error: (m) => logs.push(`error ${m}`),
      debug: (m) => logs.push(`debug ${m}`),
    },
    effect: () => () => {},
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {}
    },
    emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args)
    },
    has(event) {
      return handlers.has(event)
    },
    logs,
  }
  if (restrict) {
    // 真的 tools.restrict 会同步发出 tools/change；不发的话重入回环测不出来。
    ctx.tools = {
      restrict: (options) => {
        const dispose = restrict(options)
        ctx.emit("tools/change")
        return dispose
      },
    }
  }
  return ctx
}

async function load(file) {
  const url = pathToFileURL(join(repoRoot, file)).href
  return import(`${url}?t=${Date.now()}-${Math.random()}`)
}

// ---------------------------------------------------------------- restrict
{
  // 复刻 bili 异步注册的时序：一开始只有一部分名字存在，之后全部就位。
  const attempts = []
  let registered = false
  const restrict = ({ deny }) => {
    attempts.push([...deny])
    if (!registered) {
      throw new Error(
        'tools.restrict() names unknown global tool "acp_status", "decompress"; known global tools: compress, read',
      )
    }
    return () => {}
  }
  const ctx = fakeCtx({ restrict })
  const plugin = await load('preset/restrict-tools.js')
  plugin.apply(ctx)

  check('restrict 插件的名字与注入正确', plugin.name === 'sw-restrict-tools' && plugin.inject?.includes('tools'), {
    name: plugin.name,
    inject: plugin.inject,
  })
  check('遇到未知名字会收窄后重试，而不是直接放弃', attempts.length >= 2, {
    attempts: attempts.map((a) => a.length),
  })
  // PTC_DENY = GLOBAL_DENY（43 个）+ compress；遇到 2 个未知名字时应收窄成 42。
  const ptcDenySize = attempts[0]?.length
  check('首轮用完整 PTC_DENY（44 个，含 compress）', ptcDenySize === 44 && attempts[0]?.includes('compress'), {
    size: ptcDenySize,
    hasCompress: attempts[0]?.includes('compress'),
  })
  check(
    'PTC_DENY 盖全 bili 五条上下文工具',
    ['compress', 'acp_status', 'acp_cache', 'decompress', 'search_context'].every((name) => attempts[0]?.includes(name)),
    { has: ['compress', 'acp_status', 'acp_cache', 'decompress', 'search_context'].filter((name) => attempts[0]?.includes(name)) },
  )
  check(
    '收窄只针对这一次尝试：另外两个仍被遮住',
    attempts.at(-1)?.length === ptcDenySize - 2 && attempts.at(-1).includes('acp_cache') && !attempts.at(-1).includes('decompress'),
    { last: attempts.at(-1) },
  )

  registered = true
  ctx.emit('agent/created')
  check(
    '名字补齐后重扫，四个全部遮住（旧实现会把它们永久剔除）',
    attempts.at(-1)?.length === ptcDenySize,
    { attempts: attempts.map((a) => a.length) },
  )
  check('注册了重扫时机', ctx.has('agent/created') || ctx.has('tools/change') || ctx.has('session/event'), {
    events: ['agent/created', 'tools/change', 'session/event'].filter((e) => ctx.has(e)),
  })

  // 全未知的极端情况：一次都没遮住，但这不算失败，等下一次重扫
  const attempts2 = []
  let ready = false
  const restrict2 = ({ deny }) => {
    attempts2.push([...deny])
    if (!ready) {
      throw new Error('tools.restrict() names unknown global tool "acp_status", "acp_cache", "decompress", "search_context"; known global tools: compress')
    }
    return () => {}
  }
  const ctx2 = fakeCtx({ restrict: restrict2 })
  ;(await load('preset/restrict-tools.js')).apply(ctx2)
  const beforeRetry = attempts2.length
  ready = true
  ctx2.emit('agent/created')
  check('有防重入守卫（tools.restrict 会同步发 tools/change，没有它会递归到栈溢出）', /busy/.test(readPlugin), { hasGuard: /busy/.test(readPlugin) })
  check('重入被挡住：每条路径的 restrict 调用次数是有限个位数', attempts2.length <= 8 && attempts.length <= 8,
    { first: attempts.length, second: attempts2.length })
  check('第一次全未知不会把名字永久剔除；重扫能真的遮住', attempts2.length > beforeRetry && attempts2.at(-1).length === ptcDenySize, {
    attempts: attempts2.map((a) => a.length),
  })
}

// ------------------------------------------------------------------ digest
{
  const dataDir = mkdtempSync(join(tmpdir(), 'sw-mcp-digest-'))
  mkdirSync(join(dataDir, 'knowledge'), { recursive: true })
  const notes = [
    { id: 'n-cur-0', at: '2026-11-08T00:00:00Z', kind: 'pitfall', status: 'working', curated: true, text: '一张草图只放一个闭合轮廓。' },
    { id: 'n-cur-1', at: '2026-11-08T00:00:00Z', kind: 'pitfall', status: 'working', curated: true, text: '轮廓边落在公共面上，切除会返回 null。' },
    { id: 'n-x', at: '2026-11-08T00:00:00Z', kind: 'pitfall', status: 'working', text: '这条是某次实验的一次性观察，不该进每个会话。' },
  ]
  writeFileSync(join(dataDir, 'knowledge', 'notes.jsonl'), notes.map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf8')
  process.env.SW_MCP_DATA = dataDir

  try {
    const ctx = fakeCtx()
    const plugin = await load('preset/experience-digest.js')
    plugin.apply(ctx)

    const handler = (ctx._first = (ctx.on && null)) // 占位，实际从 emit 里拿
    // 直接取注册的 tools/execute 处理器
    let wrapped = null
    const ctx2 = fakeCtx()
    const origOn = ctx2.on.bind(ctx2)
    ctx2.on = (event, fn) => {
      if (event === 'tools/execute') wrapped = fn
      return origOn(event, fn)
    }
    plugin.apply(ctx2)
    check('digest 注册了 tools/execute 包装', typeof wrapped === 'function')

    const next = async () => ({ content: [{ type: 'text', text: '{"status":"ok"}' }] })
    const first = await wrapped({ name: 'mcp__sw__workspace', sessionId: 's1' }, next)
    const firstText = first.content.map((c) => c.text).join('\n')
    check('第一次调用就带上了本机经验', /本机经验/.test(firstText), { chars: firstText.length })
    check('只带 curated 条目', firstText.includes('一张草图只放一个闭合轮廓') && !firstText.includes('一次性观察'), {
      curated: firstText.includes('一张草图只放一个闭合轮廓'),
      leak: firstText.includes('一次性观察'),
    })

    const second = await wrapped({ name: 'mcp__sw__workspace', sessionId: 's1' }, next)
    check('同一会话不重复注入', !/本机经验/.test(second.content.map((c) => c.text).join('\n')))

    const otherSession = await wrapped({ name: 'mcp__sw__model', sessionId: 's2' }, next)
    check('换一个会话会重新注入', /本机经验/.test(otherSession.content.map((c) => c.text).join('\n')))
  } finally {
    delete process.env.SW_MCP_DATA
    rmSync(dataDir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------- nudge
{
  let wrapped = null
  const ctx = fakeCtx()
  const origOn = ctx.on.bind(ctx)
  ctx.on = (event, fn) => {
    if (event === 'tools/execute') wrapped = fn
    return origOn(event, fn)
  }
  ;(await load('preset/experience-nudge.js')).apply(ctx)
  check('nudge 注册了 tools/execute 包装', typeof wrapped === 'function')

  const okResult = { content: [{ type: 'text', text: '{"status":"ok"}' }] }
  const next = async () => okResult

  const goalDone = await wrapped({ name: 'update_goal', arguments: { action: 'complete' } }, next)
  check('目标收尾时提醒记经验', /记经验|经验/.test(goalDone.content.map((c) => c.text).join('\n')), {
    chars: goalDone.content.map((c) => c.text).join('\n').length,
  })

  const delivered = await wrapped({ name: 'mcp__sw__deliver', arguments: { kind: 'step' } }, next)
  check('交付成功也会提醒', delivered.content.length > 1, { blocks: delivered.content.length })

  const ordinary = await wrapped({ name: 'mcp__sw__inspect', arguments: { action: 'model' } }, next)
  check('普通工具调用不追加任何东西', ordinary.content.length === 1, { blocks: ordinary.content.length })

  const failedDeliver = await wrapped(
    { name: 'mcp__sw__deliver', arguments: {} },
    async () => ({ content: [{ type: 'text', text: '{"status":"failed"}' }] }),
  )
  check('失败的交付不提醒', failedDeliver.content.length === 1, { blocks: failedDeliver.content.length })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
