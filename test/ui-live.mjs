// 窗口整理：真实建模操作的第一次 attach 自动最大化并关掉欢迎/资讯/广告；
// 只读 status 不应抢焦点。先把窗口还原成非最大化，再触发自动整理，避免
// “SW 本来就最大化”导致空断言。
import { execFileSync } from 'node:child_process'
import { openSession } from './lib/mcp.mjs'
import { ensureSolidworks } from './lib/sw.mjs'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`) }
  else { failed += 1; console.log(`FAIL  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`) }
}

function setWindowState(pid, command) {
  const script = [
    "Add-Type -Name W -Namespace N -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n);'",
    `$p = Get-Process -Id ${pid}`,
    `[N.W]::ShowWindow($p.MainWindowHandle, ${command}) | Out-Null`,
  ].join('; ')
  execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' })
}

function restoreWindow(pid) {
  const script = [
    "Add-Type -Name W -Namespace N -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n);'",
    `$p = Get-Process -Id ${pid}`,
    '[N.W]::ShowWindow($p.MainWindowHandle, 1) | Out-Null',
  ].join('; ')
  execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' })
}

const session = openSession({})
await session.start()
try {
  const ready = await ensureSolidworks((name, args) => session.tool(name, args))
  check('SOLIDWORKS 可用', ready.reason === 'ready', ready.reason)

  const before = await session.tool('workspace', { action: 'ui', uiAction: 'status' })
  const pid = before.changes?.pid
  check('status 返回 pid 且不要求建模', Number.isInteger(pid) && pid > 0, before.changes)
  check('只读 status 查到窗口', before.changes?.visible === true, before.changes)

  restoreWindow(pid)
  const restored = (await session.tool('workspace', { action: 'ui', uiAction: 'status' })).changes ?? {}
  check('已还原为非最大化（前置条件）', restored.maximized === false, restored)

  // 真实建模会触发自动整理；用 build 而不是显式 ui。
  const built = await session.tool('model', {
    action: 'build',
    definition: {
      designId: `ui-${Date.now()}`,
      features: [
        { id: 'outline', kind: 'sketch', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width: 60, height: 40 }] },
        { id: 'body', kind: 'extrude', profile: 'outline', depth: 10, direction: '+Y' },
      ],
    },
  })
  check('建模成功', built.status === 'ok', built.summary)

  const after = (await session.tool('workspace', { action: 'ui', uiAction: 'status' })).changes ?? {}
  check('建模后自动最大化', after.maximized === true, after)
  check('窗口可见', after.visible === true, after)
  check('没有欢迎/资讯/广告窗口', Array.isArray(after.noiseWindows) && after.noiseWindows.length === 0, after.noiseWindows)

  // 礼貌模式（A3）：显式 normalize 也不再无条件抢窗口 —— 要求用户空闲，且用户有
  // 未存盘文档时直接跳过（skipped:true, reason:"USER_DOC_DIRTY"）；swShowNewsFeedsInTaskPane
  // 这个用户首选项默认**不写**，要关资讯必须显式传 offNewsFeeds:true。
  // 所以这里断言"要么真的整理了、要么如实跳过"，而不是"一定最大化"。
  const normalized = await session.tool('workspace', { action: 'ui', uiAction: 'normalize', offNewsFeeds: true })
  check('显式整理有结果（整理，或如实跳过）',
    normalized.status === 'ok'
      && (normalized.changes?.maximized === true || normalized.changes?.skipped === true),
    normalized.changes)
  check('资讯流首选项：默认不写；显式要求时才写且能读回关状态',
    normalized.changes?.skipped === true
      || (normalized.changes?.newsFeedsReadable === true
        && normalized.changes?.newsFeedsWritten === true
        && normalized.changes?.newsFeedsOff === true),
    normalized.changes)
  check('返回实际关闭结果数组（跳过时不需要）',
    normalized.changes?.skipped === true
      || (Array.isArray(normalized.changes?.closed) && Array.isArray(normalized.changes?.closeFailed)),
    normalized.changes)

  const again = await session.tool('workspace', { action: 'ui', uiAction: 'normalize' })
  check('重复整理不报错', again.status === 'ok', again.status)

  // 用户把 SOLIDWORKS 最小化后，后续建模不应把窗口弹出来。
  setWindowState(pid, 6)
  const minimizedBefore = (await session.tool('workspace', { action: 'ui', uiAction: 'status' })).changes ?? {}
  check('窗口已最小化（前置条件）', minimizedBefore.minimized === true, minimizedBefore)
  const builtWhileMinimized = await session.tool('model', {
    action: 'build',
    definition: {
      designId: `ui-min-${Date.now()}`,
      features: [
        { id: 'outline', kind: 'sketch', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width: 20, height: 20 }] },
        { id: 'body', kind: 'extrude', profile: 'outline', depth: 5, direction: '+Y' },
      ],
    },
  })
  check('最小化时仍能建模', builtWhileMinimized.status === 'ok', builtWhileMinimized.summary)
  const minimizedAfter = (await session.tool('workspace', { action: 'ui', uiAction: 'status' })).changes ?? {}
  check('最小化时不被还原/抢到前台', minimizedAfter.minimized === true
    && minimizedAfter.maximized === false && minimizedAfter.foreground === false, minimizedAfter)
  restoreWindow(pid)
} finally {
  try { await session.close() } catch { /* best effort */ }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
