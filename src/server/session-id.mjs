// 每个 MCP 服务进程就是一个会话边界：DSH 为每个会话起一个 server.mjs。
// 同一进程里所有入口（callBridge / job 工具 / broker client）必须用同一个 clientId，
// 否则 broker 会把同一个会话的作业分到两个 SOLIDWORKS 实例上。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { instancePolicy, maxInstancesFor } from './broker/affinity.mjs'

// clientId 必须跨 MCP 重启稳定。以前是 mcp:${pid}：进程一重启，broker 里
// 所有 ownerClients 立刻变成孤儿实例 —— 旧 pid 名下的 SOLIDWORKS 没人认领，
// 新进程又按通道另起一批，实例越积越多（今天 15:43 那次重启就留下 3 个）。
// 优先级：env SW_MCP_SESSION_ID > %LOCALAPPDATA%\sw-mcp\client-id.cfg > 新建并落盘。
function stableClientId() {
  if (process.env.SW_MCP_SESSION_ID) return process.env.SW_MCP_SESSION_ID
  try {
    const dir = process.env.SW_MCP_DATA ?? join(process.env.LOCALAPPDATA ?? homedir(), 'sw-mcp')
    const file = join(dir, 'client-id.cfg')
    try {
      const raw = readFileSync(file, 'utf8').trim()
      if (raw) return raw
    } catch { /* 首次运行：下面写一个 */ }
    const id = `mcp:${randomUUID()}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, id, 'utf8')
    return id
  } catch {
    return `mcp:${process.pid}`
  }
}
export const SW_CLIENT_ID = stableClientId()

// ---- 并行通道池（SW_MCP_LANES） -----------------------------------------
// 事实：这个 DSH 版本只起一个 MCP 进程，多个会话共用同一个 clientId，于是 broker
// 只绑一个 SOLIDWORKS —— 会话再多也只是排队。通道池把「一个 clientId」拆成 N 个：
// 每个 designId 固定落在一条通道上，通道自己绑一个实例，建模才能真正并行。
// 归位表落盘，重启后同一零件仍回原通道（否则文档在 A、请求去 B，报 DOC_NOT_OPEN）。
// 通道数优先级：%LOCALAPPDATA%\sw-mcp\lanes.cfg 的 {"lanes":N} > env SW_MCP_LANES > 1。
// 加文件是为了「改通道数不必重装 DSH」：MCP 进程的 env 由 DSH 在拉起时固定，
// 改 cordis.patch.yml 要重装/重启宿主才生效；lanes.cfg 只要重启 MCP 进程就吃到。
function lanesFromFile() {
  try {
    const file = join(
      process.env.SW_MCP_DATA ?? join(process.env.LOCALAPPDATA ?? homedir(), 'sw-mcp'),
      'lanes.cfg',
    )
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const n = Number(parsed && parsed.lanes)
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0
  } catch { return 0 }
}
const SW_LANES_FILE = lanesFromFile()
const SW_LANES_RAW = Number(process.env.SW_MCP_LANES)
export const SW_LANES = SW_LANES_FILE >= 1
  ? Math.min(8, SW_LANES_FILE)
  : Number.isFinite(SW_LANES_RAW) && SW_LANES_RAW >= 1
    ? Math.min(8, Math.floor(SW_LANES_RAW))
    : 1

const LANE_FILE = join(
  process.env.SW_MCP_DATA ?? join(process.env.LOCALAPPDATA ?? homedir(), 'sw-mcp'),
  'lanes.json',
)

function loadLanes() {
  try { const parsed = JSON.parse(readFileSync(LANE_FILE, 'utf8')); return parsed && typeof parsed === 'object' ? parsed : {} } catch { return {} }
}
let laneMap = SW_LANES > 1 ? loadLanes() : {}
function saveLanes() {
  try { mkdirSync(dirname(LANE_FILE), { recursive: true }); writeFileSync(LANE_FILE, JSON.stringify(laneMap, null, 2), 'utf8') } catch { /* 落盘失败不影响本次分配 */ }
}

/** 这条 design 走哪条通道。首次见到时选当前最空的一条并记下来。 */
export function laneIndexFor(seed) {
  if (SW_LANES <= 1) return 0
  const key = typeof seed === 'string' && seed.trim() ? seed.trim() : '__default__'
  const known = Number(laneMap[key])
  if (Number.isInteger(known) && known >= 0 && known < SW_LANES) return known
  const counts = new Array(SW_LANES).fill(0)
  for (const value of Object.values(laneMap)) {
    const index = Number(value)
    if (Number.isInteger(index) && index >= 0 && index < SW_LANES) counts[index] += 1
  }
  let best = 0
  for (let i = 1; i < SW_LANES; i += 1) if (counts[i] < counts[best]) best = i
  laneMap[key] = best
  saveLanes()
  return best
}

/** 某个 design 对应的 broker clientId。SW_LANES=1 时与旧行为逐字相同。 */
export function clientIdFor(seed = null) {
  if (SW_LANES <= 1) return SW_CLIENT_ID
  return `${SW_CLIENT_ID}#L${laneIndexFor(seed)}`
}

// 实例策略（R11）：
//   默认 isolated —— 每个会话要么复用自己绑定的实例，要么让 broker 起一个专属实例。
//   这条改动的来由：旧默认 shared 会把「用户自己开着的那唯一一个 SOLIDWORKS」
//   当成最空的实例分给 AI 会话（实测 instances.json 里 ownerClients 同时挂着两个
//   MCP 会话），用户于是看到 AI 在自己的窗口里开文档、rebuild。
//   旧默认写在这里而不是 env 里，所以只在 affinity.mjs 改默认值没用：本文件把
//   policy 显式铺进每个 broker 请求（server.mjs 的 ...instanceRequestParams()），
//   broker 按「显式参数 > env」执行。两处必须同时改。
//   显式覆盖仍然照办：SW_MCP_INSTANCE_POLICY=shared / adopt-user / isolated。
//   **紧急回退**：如果又出现「开太多 SOLIDWORKS」的抱怨（R11-5 那类），设
//   SW_MCP_INSTANCE_POLICY=shared 即可立刻回到旧行为，不必改代码或重装。
//   注意：回退到 shared 也不改变「绝不把 user 实例分配给会话」这条硬约束——
//   那条规则在 chooseInstance 里对两种策略都生效。
//   非法值由 instancePolicy 归一化回默认（isolated），不会把 broker 弄崩。
export const SW_INSTANCE_POLICY = instancePolicy(process.env)

// 谁起的实例：service = 正常服务；test = 测试套（可以被自动回收，不需要人工确认）。
export const SW_INSTANCE_TAG = process.env.SW_MCP_INSTANCE_TAG
  ?? (process.env.SW_MCP_TEST === '1' ? 'test' : 'service')

export const SW_MAX_INSTANCES = maxInstancesFor(SW_INSTANCE_POLICY, process.env)

/** broker 请求里要带的实例归属参数：server.mjs 把它铺进 jobs.run / instances.* 的 params。 */
export function instanceRequestParams(seed = null) {
  return {
    clientId: clientIdFor(seed),
    policy: SW_INSTANCE_POLICY,
    tag: SW_INSTANCE_TAG,
    // 通道数就是实例下限：只给 2 个实例时，第 3、4 条通道只能排队。
    maxInstances: Math.max(SW_MAX_INSTANCES, SW_LANES),
  }
}
