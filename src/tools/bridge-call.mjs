// 直接跟桥接器说行协议：一条请求，一条响应。
//
// 为什么需要它：MCP 那一层会把桥接器的原始返回包装成 envelope，排查「到底是桥接器
// 报的错还是 server 改写的」时，envelope 反而挡住视线。这个脚本只做一件事：
// 把一行 JSON 发给 bridge/bin/SwBridge.exe，原样打印回来的那一行。
//
//   node tools/bridge-call.mjs '{"op":"status"}'
//   node tools/bridge-call.mjs '{"op":"interopIndex","mode":"search","q":"Fillet"}'
//   node tools/bridge-call.mjs @req.json      # 从文件读请求，省掉引号地狱
//
// 不需要 SOLIDWORKS 的 op（interopIndex / version / addins）照样能跑。

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const bridgeExe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')

const raw = process.argv[2]
if (!raw) {
  console.error('用法：node tools/bridge-call.mjs \'{"op":"status"}\'  或  @req.json')
  process.exit(2)
}
if (!existsSync(bridgeExe)) {
  console.error(`桥接器不存在：${bridgeExe}（先跑 bridge/build.ps1）`)
  process.exit(2)
}

const text = raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw
let request
try {
  request = JSON.parse(text)
} catch (error) {
  console.error(`请求不是合法 JSON：${error.message}`)
  console.error(text.slice(0, 400))
  process.exit(2)
}
request.id = request.id ?? 1

const child = spawn(bridgeExe, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
let buffer = ''
let answered = false
const started = Date.now()

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    answered = true
    console.log(line)
    child.stdin.end()
    setTimeout(() => child.kill(), 50)
  }
})

child.on('exit', () => {
  if (!answered) {
    console.error(`桥接器没有回答就退了（${Date.now() - started} ms）`)
    process.exitCode = 1
  }
})

child.stdin.write(`${JSON.stringify(request)}\n`)

const timer = setTimeout(() => {
  console.error(`等了 120 秒还没有响应，判超时`)
  child.kill()
  process.exitCode = 1
}, 120_000)
timer.unref()
