// 工具面体积测量：给「描述膨胀」一个可比的数字，而不是凭感觉。
//
// 跑法：node tools/tool-face-size.mjs
// 输出：默认工具面（启动即注册）与「全部按需激活后」的工具数、description 字符数、
// 整块 JSON schema 字符数，以及每个工具一行。比较两次改动的前后值时，看这两行总数。
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const SERVER = join(repo, 'server', 'server.mjs')

const child = spawn(process.execPath, [SERVER], {
  cwd: repo,
  env: { ...process.env, SW_MCP_BROKER: '0', SW_MCP_SURFACE: 'full' },
  stdio: ['pipe', 'pipe', 'inherit'],
})
let buffer = ''
let nextId = 1
const pending = new Map()
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
    const waiter = pending.get(message.id)
    if (!waiter) continue
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  }
})
function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => reject(new Error(method + ' timeout')), 30_000)
  })
}

function summarize(tools) {
  const rows = tools.map((tool) => ({
    name: tool.name,
    description: (tool.description ?? '').length,
    schema: JSON.stringify(tool.inputSchema ?? {}).length,
    total: (tool.description ?? '').length + JSON.stringify(tool.inputSchema ?? {}).length,
  }))
  return {
    tools: rows.length,
    descriptionChars: rows.reduce((sum, row) => sum + row.description, 0),
    schemaChars: rows.reduce((sum, row) => sum + row.schema, 0),
    totalChars: rows.reduce((sum, row) => sum + row.total, 0),
    rows: rows.sort((a, b) => b.total - a.total),
  }
}

try {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'size', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const core = summarize((await request('tools/list', {})).tools)
  const onDemand = ['assembly', 'assembly_inspect', 'qa', 'workspace_ops', 'advanced_api', 'analysis', 'calculate', 'select', 'job', 'task', 'datum']
  for (const capability of onDemand) {
    try { await request('tools/call', { name: 'catalog', arguments: { action: 'activate', capability } }) } catch { /* 记在下面 */ }
  }
  const all = summarize((await request('tools/list', {})).tools)
  console.log(JSON.stringify({
    core: { tools: core.tools, descriptionChars: core.descriptionChars, schemaChars: core.schemaChars, totalChars: core.totalChars },
    all: { tools: all.tools, descriptionChars: all.descriptionChars, schemaChars: all.schemaChars, totalChars: all.totalChars },
    perTool: all.rows.map((row) => `${row.name}: ${row.description}+${row.schema}=${row.total}`),
  }, null, 2))
} finally {
  child.kill()
}
