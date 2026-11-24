// 工具面分层冒烟：真 MCP 协议链路，不用推断。
//
// 跑法：node test/tool-face-smoke.mjs
// 它做的事（与重构报告里的第 3 步验证一一对应）：
//   1. 未激活时 tools/list 里没有 assembly；tools/call assembly 被 MCP 判为未知工具
//   2. catalog activate assembly 之后收到 notifications/tools/list_changed
//   3. tools/list 条数增加，且 assembly 出现在列表里
//   4. 再调 assembly 真的进到 handler（没有装配文档 → DOC_NOT_OPEN 也算通了）
//   5. 旧工具收到已迁走的 action → 结构化 ACTION_MOVED
// 不启动 SOLIDWORKS、不碰用户文档：只发只读/会立刻失败的调用。
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = dirname(fileURLToPath(import.meta.url))
const SERVER = join(serverDir, '..', 'server', 'server.mjs')
const NODE = process.env.SW_SMOKE_NODE ?? process.execPath

const child = spawn(NODE, [SERVER], {
  env: { ...process.env, SW_MCP_BROKER: '0' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const notifications = []
let buffer = ''
const pending = new Map()
let nextId = 1

child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`))

const settled = new Promise((resolve, reject) => {
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve: done, reject: fail } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) fail(new Error(JSON.stringify(message.error)))
        else done(message.result)
        continue
      }
      if (typeof message.method === 'string') notifications.push(message.method)
    }
  })
  child.on('error', reject)
  setTimeout(() => resolve(), 120_000)
})

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`${method} timeout`))
      }
    }, 30_000)
  })
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

const report = {}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'tool-face-smoke', version: '1' },
  })
  notify('notifications/initialized', {})

  const before = await request('tools/list', {})
  report.before = {
    count: before.tools.length,
    names: before.tools.map((tool) => tool.name),
    hasAssembly: before.tools.some((tool) => tool.name === 'assembly'),
  }

  // 1) 未激活直接调：MCP 层必须回「没有这个工具」
  report.callBeforeActivate = await request('tools/call', {
    name: 'assembly',
    arguments: { action: 'mates', designId: 'smoke-tool-face' },
  }).then(
    (result) => ({ ok: true, text: result?.content?.[0]?.text?.slice(0, 300) }),
    (error) => ({ ok: false, error: String(error.message).slice(0, 300) }),
  )

  // 2) 激活 assembly（以及 mates 真正所在的 assembly_inspect）
  const activate = await request('tools/call', {
    name: 'catalog',
    arguments: { action: 'activate', capability: 'assembly' },
  })
  report.activate = {
    text: activate?.content?.[0]?.text?.slice(0, 600),
    sawListChanged: notifications.includes('notifications/tools/list_changed'),
  }
  const activate2 = await request('tools/call', {
    name: 'catalog',
    arguments: { action: 'activate', capability: 'assembly_inspect' },
  })
  report.activate2 = { text: activate2?.content?.[0]?.text?.slice(0, 400) }
  const again = await request('tools/call', {
    name: 'catalog',
    arguments: { action: 'activate', capability: 'assembly' },
  })
  report.activateAgain = { text: again?.content?.[0]?.text?.slice(0, 400) }
  await sleep(300)

  // 3) 再看 tools/list
  const after = await request('tools/list', {})
  report.after = {
    count: after.tools.length,
    names: after.tools.map((tool) => tool.name),
    hasAssembly: after.tools.some((tool) => tool.name === 'assembly'),
    assemblySchemaKeys: Object.keys(
      after.tools.find((tool) => tool.name === 'assembly')?.inputSchema?.properties ?? {},
    ),
  }

  // 4) 激活后再调：必须进到 handler（没有装配文档 → DOC_NOT_OPEN 也算通）
  report.assemblyMatesMoved = await request('tools/call', {
    name: 'assembly',
    arguments: { action: 'mates', designId: 'smoke-tool-face' },
  }).then(
    (result) => ({ ok: true, text: result?.content?.[0]?.text?.slice(0, 700) }),
    (error) => ({ ok: false, error: String(error.message).slice(0, 300) }),
  )
  report.assemblyMateCallable = await request('tools/call', {
    name: 'assembly',
    arguments: { action: 'mate', designId: 'smoke-tool-face', mateFirst: 'face-a', mateSecond: 'face-b' },
  }).then(
    (result) => ({ ok: true, text: result?.content?.[0]?.text?.slice(0, 900) }),
    (error) => ({ ok: false, error: String(error.message).slice(0, 600) }),
  )
  report.assemblyInspectMatesCallable = await request('tools/call', {
    name: 'assembly_inspect',
    arguments: { action: 'mates', designId: 'smoke-tool-face' },
  }).then(
    (result) => ({ ok: true, text: result?.content?.[0]?.text?.slice(0, 900) }),
    (error) => ({ ok: false, error: String(error.message).slice(0, 600) }),
  )

  // 5) 旧工具收到迁走的 action：结构化 ACTION_MOVED
  report.actionMoved = await request('tools/call', {
    name: 'model',
    arguments: { action: 'invoke', designId: 'smoke-tool-face', member: 'GetTitle', args: [] },
  }).then(
    (result) => ({ ok: true, text: result?.content?.[0]?.text?.slice(0, 900) }),
    (error) => ({ ok: false, error: String(error.message).slice(0, 300) }),
  )

  // 6) 核心工具还在：catalog.search 正常
  report.catalogSearch = await request('tools/call', {
    name: 'catalog',
    arguments: { action: 'search', q: '改尺寸' },
  }).then(
    (result) => ({ ok: true, text: result?.content?.[0]?.text?.slice(0, 700) }),
    (error) => ({ ok: false, error: String(error.message).slice(0, 300) }),
  )

  // 7) catalog active
  report.active = await request('tools/call', {
    name: 'catalog',
    arguments: { action: 'active' },
  }).then(
    (result) => ({ ok: true, text: result?.content?.[0]?.text?.slice(0, 500) }),
    (error) => ({ ok: false, error: String(error.message).slice(0, 300) }),
  )

  // 8) 省略 action：不静默替换成别的动作
  report.modelNoAction = await request('tools/call', {
    name: 'model',
    arguments: { designId: 'smoke-tool-face' },
  }).then(
    (result) => ({ ok: true, text: result?.content?.[0]?.text?.slice(0, 400) }),
    (error) => ({ ok: false, error: String(error.message).slice(0, 300) }),
  )
  report.workspaceNoAction = await request('tools/call', {
    name: 'workspace',
    arguments: {},
  }).then(
    (result) => ({ ok: true, text: result?.content?.[0]?.text?.slice(0, 400) }),
    (error) => ({ ok: false, error: String(error.message).slice(0, 300) }),
  )

  // 9) inspect 迁走 relations → constraints（constraints 是核心工具，立即可调）
  report.relationsMoved = await request('tools/call', {
    name: 'inspect',
    arguments: { action: 'relations', designId: 'smoke-tool-face' },
  }).then(
    (result) => ({ ok: true, text: result?.content?.[0]?.text?.slice(0, 400) }),
    (error) => ({ ok: false, error: String(error.message).slice(0, 300) }),
  )
  report.constraintsCallable = await request('tools/call', {
    name: 'constraints',
    arguments: { action: 'relations', designId: 'smoke-tool-face' },
  }).then(
    (result) => ({ ok: true, text: result?.content?.[0]?.text?.slice(0, 500) }),
    (error) => ({ ok: false, error: String(error.message).slice(0, 300) }),
  )

  // 10) catalog.detail：未激活组只回能力摘要，且 execute 已按分层表改写
  report.detailBeforeActivate = await request('tools/call', {
    name: 'catalog',
    arguments: { action: 'detail', id: 'feature.extrude' },
  }).then(
    (result) => ({ ok: true, text: result?.content?.[0]?.text?.slice(0, 600) }),
    (error) => ({ ok: false, error: String(error.message).slice(0, 300) }),
  )

  // 11) deactivate：能真停用就真的从 tools/list 里消失
  report.deactivate = await request('tools/call', {
    name: 'catalog',
    arguments: { action: 'deactivate', capability: 'assembly_inspect' },
  }).then(
    (result) => ({ ok: true, text: result?.content?.[0]?.text?.slice(0, 400) }),
    (error) => ({ ok: false, error: String(error.message).slice(0, 300) }),
  )
  await sleep(200)
  const afterDeactivate = await request('tools/list', {})
  report.afterDeactivate = {
    count: afterDeactivate.tools.length,
    names: afterDeactivate.tools.map((tool) => tool.name),
  }
} finally {
  console.log(JSON.stringify(report, null, 2))
  child.kill()
  await settled
}
