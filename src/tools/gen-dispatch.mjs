// 从真实的 Operations.Dispatch 分派表生成能力清单。
//
// 手写 CAPABILITIES 已经漂移过：sketchSlot 标 unavailable 但桥接器里能用，
// linearPattern 标可用但 COM 拒绝。能力清单必须以分派表为准；人工只补说明，
// 不补「有没有」。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const sourcePath = join(root, 'bridge', 'src', 'Operations.cs')
const outPath = join(root, 'server', 'catalog', 'dispatch.generated.mjs')

function stringsFromArray(source, name) {
  const match = source.match(new RegExp(`static readonly string\\[\\] ${name}\\s*=\\s*new string\\[\\]\\s*\\{([\\s\\S]*?)\\};`))
  if (!match) throw new Error(`找不到 ${name} 数组`)
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

function dispatchCases(source) {
  const body = source.slice(source.indexOf('Dictionary<string, object> DispatchUnlocked'))
  const start = body.indexOf('switch (op)')
  if (start < 0) throw new Error('DispatchUnlocked 里找不到 switch (op)')
  const open = body.indexOf('{', start)
  let depth = 0
  let end = -1
  // 只收集 switch 本体（深度 1）里的 case；方法后面还有别的 switch，
  // 包括 Export 里的 step/stl，扫全文会把它们误当成操作。
  for (let i = open; i < body.length; i++) {
    const ch = body[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) throw new Error('DispatchUnlocked 的 switch 括号不平衡')
  const block = body.slice(open, end)
  return [...block.matchAll(/case "([A-Za-z0-9_]+)":/g)].map((m) => m[1])
}

const source = readFileSync(sourcePath, 'utf8')
const supported = stringsFromArray(source, 'SupportedOps')
const lockFree = new Set(stringsFromArray(source, 'LockFree'))
const cases = dispatchCases(source)

const missingCase = supported.filter((op) => !cases.includes(op))
const notAdvertised = cases.filter((op) => !supported.includes(op))
const entries = supported.map((op) => ({
  op,
  mutating: !lockFree.has(op),
  lockFree: lockFree.has(op),
  dispatched: cases.includes(op),
}))

const problems = []
if (missingCase.length) problems.push(`SupportedOps 里没有分派分支：${missingCase.join(', ')}`)
if (notAdvertised.length) problems.push(`有分支但未列进 SupportedOps：${notAdvertised.join(', ')}`)

const payload = `// 由 tools/gen-dispatch.mjs 生成，勿手改。
// 来源：bridge/src/Operations.cs 的 SupportedOps / LockFree / DispatchUnlocked。
export const DISPATCH_GENERATED_AT = ${JSON.stringify(new Date().toISOString())}
export const DISPATCH_VERSION = 1
export const DISPATCH = ${JSON.stringify(entries, null, 2)}
`

const check = process.argv.includes('--check')
const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null
// 时间戳不参与漂移判定；只比较操作列表本体。
const bodyOf = (text) => text?.replace(/^export const DISPATCH_GENERATED_AT = .*$/m, '') ?? null

if (check) {
  if (current === null) {
    console.error('dispatch.generated.mjs 不存在，请先运行 node tools/gen-dispatch.mjs')
    process.exit(1)
  }
  if (bodyOf(current) !== bodyOf(payload)) {
    console.error('dispatch.generated.mjs 与 Operations.cs 漂移，请重新生成')
    process.exit(1)
  }
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log(`dispatch 能力表一致：${entries.length} 个操作`)
} else {
  writeFileSync(outPath, payload, 'utf8')
  console.log(`生成 ${entries.length} 个操作 -> ${outPath}`)
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  }
}
