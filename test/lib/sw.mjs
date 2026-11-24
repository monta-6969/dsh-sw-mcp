// 测试用的 SOLIDWORKS 生命周期。
//
// 三个约定，都是为了不碰用户自己的窗口：
//   1. 启动前先快照 SLDWORKS 的 Id + CreationDate；只有「快照之后新出现、且
//      创建时间对得上」的 pid 才算 owned。pid 会被系统复用，所以所有权凭据
//      必须带创建时间，不能只看名字或编号。
//   2. 收尾只杀 owned（KEEP_SW=1 时连 owned 也不杀）。绝不 Get-Process SLDWORKS
//      | Stop-Process -Force —— 那会连带杀掉用户正开着的实例和里面未存盘的文档。
//   3. owned 的 pid 同时登记进 %LOCALAPPDATA%\sw-mcp\instances.json
//      （launchedBy=test, tag=test），这样 broker 的 workspace reap tag=test
//      认得它们，能先 cleanup 文档再 quit，比直接 Stop-Process 温和。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultInstancesFile,
  removeEntry,
  updateInstances,
  upsertEntry,
} from '../../server/broker/instances.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const STATE_DIR = process.env.SW_MCP_TEST_STATE ?? join(here, '..', '.state')
const STATE_FILE = join(STATE_DIR, 'sw-pids.json')
const LNK = 'C:\\Users\\mota\\Desktop\\sw\\SOLIDWORKS Design 2026.lnk'

export const TEST_TAG = process.env.SW_MCP_INSTANCE_TAG ?? 'test'
export const OWNED_STATE_FILE = STATE_FILE

function powershell(command, options = {}) {
  return execFileSync('powershell', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  })
}

/** 当前 SLDWORKS 进程的 {pid, creationDate} 快照；创建时间取不到时为 null。 */
export function snapshotSolidworks() {
  try {
    const out = powershell(
      '@(Get-Process SLDWORKS -ErrorAction SilentlyContinue | ForEach-Object {'
      + ' $created = $null; try { $created = $_.StartTime.ToUniversalTime().ToString("o") } catch { };'
      + ' [pscustomobject]@{ id = $_.Id; creationDate = $created } }) | ConvertTo-Json -Compress',
    )
    const text = String(out ?? '').trim()
    if (!text) return []
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list
      .map((entry) => ({ pid: Number(entry?.id), creationDate: entry?.creationDate ? String(entry.creationDate) : null }))
      .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0)
  } catch {
    return []
  }
}

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return {
      tag: parsed.tag ?? TEST_TAG,
      baseline: Array.isArray(parsed.baseline) ? parsed.baseline : [],
      owned: Array.isArray(parsed.owned) ? parsed.owned : [],
      updatedAt: parsed.updatedAt ?? null,
    }
  } catch {
    return { tag: TEST_TAG, baseline: [], owned: [], updatedAt: null }
  }
}

function writeState(state) {
  const next = { tag: TEST_TAG, baseline: state.baseline ?? [], owned: state.owned ?? [], updatedAt: new Date().toISOString() }
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/** 本测试进程认领的实例（pid + creationDate 双条件）。 */
export function ownedSolidworks() {
  return readState().owned
}

/**
 * 把「新出现且创建时间对得上」的进程记成 owned，并登记进 instances.json。
 * 起 SW 要 50 秒，轮询期间可能正好出现，所以每次快照后都调一次。
 */
export function adoptOwned({ baseline = null, since = 0 } = {}) {
  const state = readState()
  const baselineList = baseline ?? state.baseline
  const baselinePids = new Set(baselineList.map((entry) => Number(entry?.pid ?? entry)).filter(Boolean))
  const snapshot = snapshotSolidworks()
  const owned = state.owned.slice()
  const nowIso = new Date().toISOString()
  const added = []
  for (const process of snapshot) {
    if (baselinePids.has(process.pid)) continue
    if (process.creationDate && since && Date.parse(process.creationDate) < since - 120_000) continue
    if (owned.some((entry) => entry.pid === process.pid && entry.creationDate === process.creationDate)) continue
    owned.push({ pid: process.pid, creationDate: process.creationDate, tag: TEST_TAG, adoptedAt: nowIso })
    added.push(process)
  }
  if (added.length > 0) {
    writeState({ ...state, baseline: baselineList, owned })
    updateInstances(defaultInstancesFile(process.env), (entries) => {
      for (const process of added) {
        upsertEntry(entries, {
          pid: process.pid,
          startedAt: process.creationDate ?? nowIso,
          launchedBy: 'test',
          tag: TEST_TAG,
          ownerClients: [],
          lastSeen: nowIso,
          lastUsedAt: nowIso,
          workerStarted: false,
        })
      }
      return entries
    })
  }
  return owned
}

function startSolidworksProcess() {
  powershell(`Start-Process -FilePath '${LNK}'`, { stdio: 'ignore' })
}

/** 在 instances.json 里注销这些 pid（进程已经退掉时用）。 */
function unregisterOwned(pids) {
  if (!pids.length) return
  const targets = new Set(pids)
  try {
    updateInstances(defaultInstancesFile(process.env), (entries) => {
      for (const pid of targets) removeEntry(entries, pid)
      return entries
    })
  } catch {
    // 登记表写不进去不影响杀进程的结果，下一次 maintenance 会自己清掉。
  }
}

/**
 * 从当前快照里挑出「pid 仍在、且 CreationDate 对得上」的 owned 记录。
 *
 * pid 会被系统复用：杀之前必须证明「现在占着这个 pid 的进程就是我们当初记下的
 * 那个进程」。快照拿不到创建时间时无法证明，宁可漏杀也不能错杀用户的窗口。
 * 漏掉的实例仍然登记在 instances.json 里（launchedBy=test, tag=test），
 * broker 的 workspace reap tag=test 会先 cleanup 文档再 quit，兜底收尾。
 */
export function selectOwnedTargets(snapshot, recorded) {
  const current = new Map()
  for (const process of snapshot ?? []) {
    const pid = Number(process?.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue
    current.set(pid, process?.creationDate ? String(process.creationDate) : null)
  }
  const targets = []
  for (const entry of recorded ?? []) {
    const pid = Number(entry?.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!current.has(pid)) continue
    const actual = current.get(pid)
    const expected = entry?.creationDate ? String(entry.creationDate) : null
    if (!expected || !actual) continue
    if (expected === actual) targets.push(entry)
  }
  return targets
}

/**
 * 杀掉 owned 实例：pid 必须仍在快照里，且 CreationDate 与记录一致（防 pid 复用）。
 * KEEP_SW=1 时只回报、不动手。
 */
export function killOwned({ owned = null, keep = process.env.KEEP_SW === '1' } = {}) {
  const recorded = owned ?? ownedSolidworks()
  if (keep) return { killed: [], kept: true, owned: recorded }
  if (!recorded.length) return { killed: [], kept: false, owned: recorded }
  const targets = selectOwnedTargets(snapshotSolidworks(), recorded)
  const killed = []
  if (targets.length > 0) {
    try {
      powershell(`Stop-Process -Id ${targets.map((entry) => Number(entry.pid)).join(',')} -Force -ErrorAction SilentlyContinue`, { stdio: 'ignore' })
      killed.push(...targets.map((entry) => Number(entry.pid)))
    } catch {
      // 已经退出是想要的结果，不是错误。
    }
  }
  const killedSet = new Set(killed)
  const remaining = recorded.filter((entry) => !killedSet.has(Number(entry.pid)))
  writeState({ ...readState(), owned: remaining })
  unregisterOwned(killed)
  return { killed, kept: false, owned: remaining }
}

/**
 * 调一个已迁到按需组 workspace_ops 的运维动作：先激活，再调 workspace_ops；
 * 旧工具面上没有这个工具时回退到 workspace（同名 action），避免旧面直接崩。
 * 迁移动因见 tool-face.mjs：status/instances/reap/cleanup/... 归 workspace_ops。
 */
export async function workspaceOps(tool, args) {
  if (typeof tool !== 'function') return { status: 'error', summary: 'no tool function' }
  try { await tool('catalog', { action: 'activate', capability: 'workspace_ops' }) } catch { /* 旧工具面没有 activate */ }
  const result = await tool('workspace_ops', args)
  if (result?.status !== 'error') return result
  const missing = result?.code === -32602 || /not found|未知工具|unknown tool/i.test(result?.summary ?? '')
  if (missing) return tool('workspace', args)
  return result
}

/**
 * Makes sure at least one SOLIDWORKS answers, and remembers which one this run owns.
 * Returns {startedHere, owned, reason, status}; 调用方据此决定收尾时要不要杀。
 */
export async function ensureSolidworks(tool, { timeoutMs = 600_000, baseline = null } = {}) {
  // 工具面分层后 workspace status 归按需的 workspace_ops 组：不先激活，
  // 轮询永远拿不到 capabilities.solidworks。激活是幂等的（already-active 不报错）。
  try { await tool('catalog', { action: 'activate', capability: 'workspace_ops' }) } catch { /* 旧工具面没有 catalog.activate 时照旧走 */ }
  const startAt = Date.now()
  const snapshot = baseline ?? snapshotSolidworks()
  let startedHere = snapshot.length === 0
  // 保留上一轮记录过的 owned（可能还活着：上次 KEEP_SW 或崩了），收尾时按
  // pid+CreationDate 双条件再确认一次。基线只用来判断「哪些是这轮之前就有的」。
  writeState({ ...readState(), baseline: snapshot })
  if (startedHere) startSolidworksProcess()

  const deadline = Date.now() + timeoutMs
  let last = null
  let ownedSince = startAt
  while (Date.now() < deadline) {
    // A previous instance may still be exiting when the caller asks for a restart.
    const current = snapshotSolidworks()
    if (!startedHere && current.length === 0) {
      startedHere = true
      ownedSince = Date.now()
      writeState({ ...readState(), baseline: [] })
      startSolidworksProcess()
    }
    // 只有自己启动的实例才记所有权；用户先开着的那些一个都不认领。
    if (startedHere) adoptOwned({ baseline: [], since: ownedSince })
    last = await workspaceOps(tool, { action: 'status' })
    const reason = last.capabilities?.solidworks?.reason
    if (last.capabilities?.solidworks?.ready === true) {
      return { startedHere, owned: ownedSolidworks(), reason: 'ready', status: last }
    }
    // "还没起来"值得等；"卡在对话框里"和"崩了"等下去不会有结果。
    if (reason === 'blocked-by-dialog') {
      return { startedHere, owned: ownedSolidworks(), reason, status: last }
    }
    // A second instance is the failure mode this helper exists to prevent.
    if (!startedHere && current.length > 1) {
      return { startedHere, owned: ownedSolidworks(), reason: 'multiple-instances', status: last }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  return { startedHere, owned: ownedSolidworks(), reason: last?.changes?.solidworks?.reason ?? 'timeout', status: last }
}

/** 通过 broker 的 workspace_ops action=reap 收一次 tag=test 实例（先文档后进程）。 */
export async function reapTestInstances(tool, { includeDocs = true, dryRun = false } = {}) {
  if (typeof tool !== 'function') return { skipped: 'no-tool' }
  try {
    return await workspaceOps(tool, { action: 'reap', tag: TEST_TAG, includeDocs, dryRun })
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
}

// ── 收尾超时（D4）──────────────────────────────────────────────────────────
//
// 事故：param-pitch 打印完最后一条 PASS 后卡在 finally 的 `workspace_ops cleanup`
// 上（592 s / 307 s 无输出，exit=-1）。MCP 调用本身没有上限，一个不回的 cleanup
// 就能让「断言全绿」的一轮永远不落地成 exit 0。
//
// 约定（所有用到这里的用例一致）：
//   · 收尾每一步都有上限，超时打印 `CLEANUP_TIMEOUT <步骤>`；
//   · 超时**不改变断言结论**（不记 failure、不改 passed/failed）；
//   · 收尾结束后一律按断言结果 (re)exit，绝不把退出码交给可能挂住的收尾路径。
//
// 超时时间可用环境变量覆盖（用来人为验证超时分支）：
//   SW_CLEANUP_TIMEOUT_MS   workspace_ops cleanup（默认 30 000）
//   SW_CLOSE_TIMEOUT_MS     session.close + 杀子进程（默认 10 000）
//   SW_SHUTDOWN_TIMEOUT_MS  shutdownSolidworks → broker reap（默认 25 000）
function envMs(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export const CLEANUP_TIMEOUT_MS = envMs('SW_CLEANUP_TIMEOUT_MS', 30_000)
export const CLOSE_TIMEOUT_MS = envMs('SW_CLOSE_TIMEOUT_MS', 10_000)
export const SHUTDOWN_TIMEOUT_MS = envMs('SW_SHUTDOWN_TIMEOUT_MS', 25_000)

/**
 * 给一个 promise 加死线。超时即 reject，并**尽力取消**底下那个请求：
 * cancel 通常是 AbortSignal（会让 mcp.mjs 从 waiter 表里摘掉、给子进程发 SIGKILL），
 * 免得迟到的回包写进一个已经退出的管道。
 * 注意：Promise.race 不会让挂住的 promise 消失，只是不再等它；进程最后靠
 * exitProcessByResult 的 process.exit 收掉。
 */
export async function withTimeout(promise, ms, what, { cancel = null } = {}) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 超过 ${ms} ms 无响应`)), ms)
  })
  try {
    return await Promise.race([Promise.resolve(promise), guard])
  } catch (error) {
    console.log(`CLEANUP_TIMEOUT ${what}（${ms} ms 内没有返回：${String(error?.message ?? error)}）—— 不计入断言，继续按断言结果退出`)
    try { cancel?.() } catch { /* 取消本身失败也只能尽力 */ }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * finally 里的清理：先 workspace_ops cleanup（带超时），再关会话。
 * 任何一步失败/超时都只打印，不抛 —— 收尾不能改断言结论。
 */
export async function cleanupWorkspace(session, { cleanupMs = CLEANUP_TIMEOUT_MS, closeMs = CLOSE_TIMEOUT_MS } = {}) {
  const at = Date.now()
  const phase = (name) => `${name} ${Date.now() - at}ms`
  if (session?.tool) {
    try {
      await withTimeout(Promise.resolve().then(() => session.tool('workspace_ops', { action: 'cleanup' })), cleanupMs, 'workspace_ops cleanup')
      console.log(`CLEANUP_OK workspace_ops cleanup（${phase('')}）`)
    } catch { /* 已打印 CLEANUP_TIMEOUT / 失败原因 */ }
  }
  if (session) {
    try {
      await withTimeout(Promise.resolve().then(() => session.close()), closeMs, 'session.close')
    } catch { /* 同上 */ }
  }
  return at
}

/**
 * 关会话的硬手段：mcp.mjs 的 close() 只是 child.kill()，管道/子进程不响应时
 * 句柄还握着不放。这里再补一刀 SIGKILL，并 unref，避免它拖住退出。
 */
export function closeSessionHard(session) {
  try {
    const child = session?.child
    if (!child) return
    try { child.stdin?.destroy() } catch { /* 已关 */ }
    try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    try { child.unref?.() } catch { /* 不支持就算了 */ }
  } catch { /* best effort */ }
}

/**
 * 所有用例统一的结局：按断言结果 exit。无论收尾是否超时、子进程是否还在，
 * 都在这里落地退出码（0 / 1 / BLOCKED 时的 2）。
 */
export function exitProcessByResult(failures, code) {
  const list = Array.isArray(failures) ? failures : []
  const exitCode = code ?? (list.length > 0 ? 1 : 0)
  process.exit(exitCode)
}

/** Closes documents and exits, but only for an instance this test started. */
export async function shutdownSolidworks(tool, startedHere) {
  if (process.env.KEEP_SW === '1') return false
  if (!startedHere) return false
  // 先走温和路径（cleanup + quit），再对仍然活着的 owned 进程按 pid 收尾。
  // D4：温和路径自己带死线 —— 实例忙时 broker reap 可以很久不回。到点就打印
  // CLEANUP_TIMEOUT 并继续走 killOwned（pid+CreationDate 双条件，只杀自己拉起的）。
  // 不给死线时，一个挂住的 reap 能让「31 passed」永远落不成 exit 0。
  let timedOut = false
  try {
    await withTimeout(reapTestInstances(tool), SHUTDOWN_TIMEOUT_MS, 'reapTestInstances')
  } catch {
    timedOut = true
  }
  killOwned()
  return !timedOut
}
