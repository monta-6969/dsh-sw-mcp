// 错误码 ↔ 指路：每个桥接器会抛的码，都必须带回非空的 nextActions。
//
// 为什么需要：失败时回空数组等于「不知道下一步做什么」，模型就会开始瞎试。
// 之前 nextActionsFor 只覆盖 13 个码，而桥接器实际抛 ~30 个 —— CUT_FAILED、
// EMPTY_SKETCH、UNEXPECTED_MULTI_BODY 这些最常撞的全都没有指路。
//
// 做法：从 C# 与 server 源码里静态抽出所有错误码，逐个问 nextActionsFor。
// 不需要 SOLIDWORKS。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './lib/mcp.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(name)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

const bridgeDir = join(repoRoot, 'bridge', 'src')
const bridgeSources = readdirSync(bridgeDir)
  .filter((f) => f.endsWith('.cs'))
  .map((f) => readFileSync(join(bridgeDir, f), 'utf8'))
  .join('\n')
const serverSource = readFileSync(join(repoRoot, 'server', 'server.mjs'), 'utf8')

const codes = new Set()
for (const m of bridgeSources.matchAll(/BridgeError\(\s*"([A-Z_]{3,})"/g)) codes.add(m[1])
// server 自己的失败码；BRIDGE_* 也是它能返回的。
for (const m of serverSource.matchAll(/fail\(\s*'([A-Z_]{3,})'/g)) codes.add(m[1])

// 从函数体里取 case 标签，逐个调用真函数。
const fnMatch = serverSource.match(/function nextActionsFor\(error\) \{[\s\S]*?\n\}/)
check('能在 server.mjs 里找到 nextActionsFor', Boolean(fnMatch), { found: Boolean(fnMatch) })

// 用动态 import 会执行整个 server（会连 stdio），所以这里做一个受控求值：
// 把函数体抽出来，包成独立函数求值，依赖只有 switch 与字符串。
const body = fnMatch[0]
  .replace('function nextActionsFor(error) {', '')
  .replace(/\n\}$/, '')
const evaluate = new Function('error', body)

const handled = [...body.matchAll(/case '([A-Z_]+)'/g)].map((m) => m[1])
const missing = [...codes].filter((code) => {
  const actions = evaluate({ code })
  return !Array.isArray(actions) || actions.length === 0
})
check('每个错误码都有非空 nextActions', missing.length === 0, {
  codes: codes.size,
  handled: handled.length,
  missing,
})

// 兜底不许是空数组：未知码也要给方向。
const fallback = evaluate({ code: 'SOME_FUTURE_CODE' })
check('未知码走兜底而不是空数组', Array.isArray(fallback) && fallback.length > 0, { fallback })

// 几条最常撞的码，文本里要真的指向可用的工具（不是泛泛安慰）。
for (const [code, needle] of [
  ['EMPTY_SKETCH', 'sketch'],
  ['CUT_FAILED', '轮廓'],
  ['UNEXPECTED_MULTI_BODY', '轮廓'],
  ['STALE_SELECTION', 'faces'],
  ['SW_NOT_RUNNING', 'SOLIDWORKS'],
]) {
  const text = evaluate({ code }).join(' ')
  check(`${code} 的指路提到 ${needle}`, text.includes(needle), { text: text.slice(0, 120) })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
