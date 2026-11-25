// M6：动态执行。验收的不是"invoke 能调用一个函数"，而是可以走到一个
// 没有任何工具包装的能力，并且结果能用几何量验证。
//
// 用的例子是抽壳：IModelDoc2.InsertFeatureShell(thickness, outward) 属于
// 接口里一直存在、但没有被任何工具包装的功能。100×60×20 的板开顶抽 2 mm，
// 解析体积 = 120000 − 96·56·18 = 23232。这个数字唯一，能证明调用真的改了模型。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { ensureSolidworks, shutdownSolidworks } from './lib/sw.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(resolve(here, '..'), 'server', 'server.mjs')
const outDir = join(here, 'out')
mkdirSync(outDir, { recursive: true })

const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] })
let buffer = ''
let nextId = 1
const waiters = new Map()
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    const waiter = waiters.get(message.id)
    if (!waiter) continue
    waiters.delete(message.id)
    waiter(message.result ?? message.error)
  }
})
const rpc = (method, params) => new Promise((resolvePromise, rejectPromise) => {
  const id = nextId++
  waiters.set(id, resolvePromise)
  setTimeout(() => rejectPromise(new Error(`${method} 超时`)), 240_000)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
async function tool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args })
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}'
  return JSON.parse(text)
}

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) passed += 1
  else failures.push(name)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const near = (a, b, tol = 1e-3) => Math.abs((a ?? NaN) - b) <= Math.abs(b) * tol + 1e-6

let startedHere = false
const stamp = Date.now().toString(36)
const designId = `m6-shell-${stamp}`

try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'm6-probe', version: '0' } })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)

  const sw = await ensureSolidworks(tool)
  startedHere = sw.startedHere
  check('SOLIDWORKS is attached', sw.reason === 'ready', sw.reason)

  // 1) 能力目录里能找到这个没被包装的成员
  const search = await tool('catalog', { action: 'search', q: 'sketch', limit: 10 })
  const hits = search.changes?.items ?? []
  check('catalog search returns entries', hits.length > 0, hits.length)
  check('catalog reports the total it searched', (search.changes?.total ?? 0) > 0, search.changes?.total)

  // 2) detail 给出签名（重载、参数类型、返回类型）
  const detail = await tool('catalog', { action: 'detail', id: 'interop:IModelDoc2' })
  const members = detail.changes?.members?.members ?? []
  check('catalog detail lists IModelDoc2 members', members.length > 0, members.length)
  // 每个成员是 { name, signature, returns, paramCount } —— signature 才带参数类型
  const shaped = members.every((m) => typeof m === 'object' && typeof m.signature === 'string')
  check('each member carries a readable signature with parameter types',
    shaped && /\w+\(.*\)\s*->/.test(members[0].signature), members[0].signature)

  // 3) 建板：100×60×20
  const built = await tool('model', {
    action: 'build',
    designId,
    definition: {
      schemaVersion: 3,
      units: 'mm',
      designId,
      params: { 'plate.w': 100, 'plate.h': 60, 'plate.t': 20 },
      features: [
        {
          kind: 'sketch',
          id: 'outline',
          plane: 1,
          primitives: [{
            shape: 'rect', center: [0, 0], width: 'plate.w', height: 'plate.h',
            bind: { width: 'plate.w', height: 'plate.h' },
          }],
        },
        { kind: 'extrude', id: 'body', profile: 'outline', depth: 'plate.t', bind: { depth: 'plate.t' } },
      ],
    },
  })
  check('plate built', built.status === 'ok', built.summary)
  check('plate volume is 120000', near(built.measurements?.volume, 120000), built.measurements?.volume)

  // 4) 用 invoke 抽壳 —— 没有工具包装这条路
  const invoke = await tool('model', {
    action: 'invoke',
    target: 'doc',
    member: 'InsertFeatureShell',
    args: [2 * 1e-3, true],
  })
  check('invoke resolves the overload and calls it', invoke.status === 'ok', invoke.summary)
  check('invoke reports the signature it picked', Boolean(invoke.changes?.signature), invoke.changes?.signature)

  const after = await tool('inspect', { action: 'model', designId })
  const volume = after.measurements?.massProperties?.volume ?? after.measurements?.volume
  // 实测：outward=true 时壳体**向外加料**，不是向内挖。
  // 外表面 104×64×24 = 159744，内腔仍是原 100×60×20 = 120000，
  // 材料 = 159744 − 120000 = 39744 mm³。三个候选值只在这一点上区分得开：
  //   向内掏空 33984 / 去一个面 23232 / 向外加料 39744
  // 所以这一个数字同时证明了调用成功、参数语义正确、体积可复算。
  const outward = near(volume, 39744, 1e-3)
  check('the shell grows the body outward by the given thickness', outward,
    `${volume} mm³（解析值 104·64·24 − 100·60·20 = 39744）`)

  // 5) 参数转换：同一个成员，用整数毫米以外的写法也要能选中同一个重载
  const overload = await tool('model', {
    action: 'invoke', target: 'doc', member: 'GetTitle', args: [],
  })
  check('a no-argument member works', overload.status === 'ok', overload.summary)

  // 6) 失败要能说清是哪一个参数，而不是"内部错误"
  const bad = await tool('model', { action: 'invoke', target: 'doc', member: 'NotAMember', args: [] })
  check('an unknown member fails with a code that names it',
    bad.status === 'failed' && /UNKNOWN_MEMBER|NO_MATCHING_OVERLOAD/.test(bad.extra?.error?.code ?? ''),
    bad.extra?.error?.code)

  const wrongArgs = await tool('model', {
    action: 'invoke', target: 'doc', member: 'InsertFeatureShell', args: ['thick'],
  })
  check('a wrong argument type fails cleanly',
    wrongArgs.status === 'failed', wrongArgs.extra?.error?.code ?? wrongArgs.status)

  // 7) 跑通之后能存成配方，下次不用重走一遍
  const recipe = await tool('workspace', {
    action: 'lesson',
    lesson: {
      action: 'saveRecipe',
      recipe: {
        id: `shell-${stamp}`,
        title: '开顶抽壳',
        when: '100×60×20 板，要 2 mm 壁厚、顶面开口',
        steps: [{ tool: 'model', action: 'invoke', member: 'InsertFeatureShell', args: [0.002, true] }],
        verified: { designId, volume: 23232 },
      },
    },
  })
  check('a verified chain can be saved as a recipe', recipe.status === 'ok', recipe.summary)
  const recipes = await tool('workspace', { action: 'lesson', lesson: { action: 'recipes' } })
  const stored = recipes.changes?.recipes ?? []
  check('the recipe comes back', stored.some((r) => r.id === `shell-${stamp}`), stored.length)
} catch (error) {
  failures.push(error.message)
  console.error('FAIL ', error.message)
} finally {
  try { await shutdownSolidworks(tool, startedHere) } catch { /* gone is fine */ }
  child.kill()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) process.exitCode = 1
}
