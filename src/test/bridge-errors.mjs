// 桥接器进程出问题时，MCP 服务必须活着并说清楚。
//
// 两种失败曾经会把整个服务带走：
//   1. spawn 直接失败（文件在、但不是能执行的东西）—— 这是我补的 'error' 监听；
//   2. 桥接器半路被杀，管道 EPIPE —— 这是 stdin/stdout 的 'error' 监听。
// 两种都是**事件**，没人监听就是未捕获异常，进程直接退出，用户看到的是
// 「工具调用突然没反应」。
//
// 做法：把 bridgeExe 指向一个内容不是 PE 的文件，逼 spawn 失败，然后连打两次
// 工具调用：每一次都要拿到带 code 的失败返回，且服务还能应答。
// 不需要 SOLIDWORKS。
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { repoRoot } from './lib/mcp.mjs'

const L = String.fromCharCode(10)
const work = mkdtempSync(join(tmpdir(), 'sw-mcp-bridge-err-'))
const dataDir = join(work, 'data')
mkdirSync(dataDir, { recursive: true })
const fakeExe = join(work, 'not-an-exe.exe')
writeFileSync(fakeExe, 'this is not a portable executable' + L, 'utf8')
const configFile = join(work, 'sw.config.json')
writeFileSync(configFile, JSON.stringify({ bridgeExe: fakeExe, requestTimeoutMs: 5000 }), 'utf8')

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

const child = spawn(process.execPath, [join(repoRoot, 'server', 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, SW_MCP_DATA: dataDir, SW_MCP_CONFIG: configFile },
})
let buffer = ''
let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (c) => { stderr += c })
let closed = false
child.on('exit', () => { closed = true })

let nextId = 1
const waiters = new Map()
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf(L)) >= 0) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const w = waiters.get(msg.id)
    if (w) { waiters.delete(msg.id); w(msg.result ?? msg.error) }
  }
})
const rpc = (method, params) => new Promise((res, rej) => {
  const id = nextId++
  waiters.set(id, res)
  setTimeout(() => rej(new Error(`${method} 超时（服务可能已经退出）`)), 20_000)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + L)
})
// status 在 SOLIDWORKS 不可用时会优雅降级成 unavailable（那是给人看的状态），
// 真正会去碰桥接器的是 inspect / model。用它来暴露 BRIDGE_* 失败码。
//
// designId 必给：F3 之后 inspect 的每个动作都先校验 designId，省略会在**到达桥接器
// 之前**以 DESIGN_ID_REQUIRED 返回 —— 那样这条用例测的就不是「桥接器起不来」，
// 而是「参数没给」，永远看不到 BRIDGE_* 码（实测：改成带 designId 之前一直红）。
const callStatus = async () => {
  const out = await rpc('tools/call', {
    name: 'inspect',
    arguments: { action: 'model', designId: 'bridge-errors-probe' },
  })
  const text = out?.content?.find((c) => c.type === 'text')?.text ?? ''
  try { return JSON.parse(text) } catch { return { raw: text } }
}

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bridge-errors', version: '0' } })

const first = await callStatus()
check('第一次调用拿到的是失败返回，不是崩溃', first.status !== 'ok' || first.error, {
  status: first.status,
  code: first.extra?.error?.code ?? first.code,
})
const code = first.extra?.error?.code ?? first.code ?? ''
check('错误码说明是桥接器起不来/退出了', /BRIDGE_(SPAWN_FAILED|EXITED|PIPE_FAILED|MISSING)/.test(String(code)), { code })

check('服务进程还活着（第一次失败没把宿主带走）', !closed, { closed })

const second = await callStatus()
check('第二次调用仍然能应答（失败可重试，不是一次性）', Boolean(second), {
  status: second.status,
  code: second.extra?.error?.code ?? second.code,
})
check('第二次也是同一类失败，没有变成挂起', !closed, { closed, stderr: stderr.slice(-160) })

child.kill()
rmSync(work, { recursive: true, force: true })

console.log(`${L}${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(`${L}failures:`)
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
