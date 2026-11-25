// 用 cordis.patch.yml 里**真正写着的那条命令**起 MCP server，做完握手再列工具。
//
// 为什么要这样测：新会话里 mcp__sw__* 出不来时，可能是 preset 没挂上，也可能是
// 这条 command/args 写错了。这里把第二种可能单独排掉 —— 它跑的是同一份配置文本。
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

/** 从 patch 文本里抠出 mcp-sw 那一行的 command / args / serverName。 */
function readMcpConfig(text) {
  const start = text.indexOf('- id: mcp-sw')
  // args 段必须在本块内截止：两个预设各有一个 mcp-sw 块，抓到文件末尾会带进别人的参数。
  const block = text.slice(start, text.indexOf('env:', start))
  const serverName = block.match(/serverName:\s*(\S+)/)?.[1]
  const command = block.match(/command:\s*'([^']+)'/)?.[1]
  const argsBlock = block.slice(block.indexOf('args:'))
  const args = [...argsBlock.matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1])
  return { serverName, command, args }
}

const config = readMcpConfig(patch)
console.log('serverName :', config.serverName)
console.log('command    :', config.command)
console.log('args       :', config.args)

if (!config.command || config.args.length === 0) {
  console.error('patch 里读不到 mcp-sw 的 command/args')
  process.exit(1)
}

const child = spawn(config.command, config.args, { stdio: ['pipe', 'pipe', 'inherit'] })
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
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const waiter = waiters.get(message.id)
    if (!waiter) continue
    waiters.delete(message.id)
    waiter(message.result ?? message.error)
  }
})

const send = (method, params) =>
  new Promise((resolvePromise, rejectPromise) => {
    const id = nextId++
    waiters.set(id, resolvePromise)
    // 起不来的进程只会静默不回答，超时必须自己设。
    setTimeout(() => rejectPromise(new Error(`${method} 超时`)), 60_000)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

try {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'patch-probe', version: '0' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
  console.log('server     :', init.serverInfo?.name, init.serverInfo?.version)

  const { tools = [] } = await send('tools/list', {})
  const prefixed = tools.map((t) => `mcp__${config.serverName}__${t.name}`)
  console.log('tools      :', prefixed.join(', '))

  // status 已划进按需的 workspace_ops，默认工具面上没有；这里用核心的 preflight 握手。
  const probe = await send('tools/call', { name: 'workspace', arguments: { action: 'preflight' } })
  const payload = JSON.parse(probe.content?.[0]?.text ?? '{}')
  console.log('preflight  :', payload.status, '|', String(payload.summary ?? '').slice(0, 80))

  const ok = prefixed.length >= 8 && prefixed.every((n) => n.startsWith(`mcp__${config.serverName}__`))
  console.log(ok ? '\nPASS  patch 里的命令能起 server，工具前缀正确' : '\nFAIL  工具数量或前缀不对')
  if (!ok) process.exitCode = 1
} catch (error) {
  console.error('\nFAIL ', error.message)
  process.exitCode = 1
} finally {
  child.kill()
}
