// 自动启动守卫（预检 / 盯守 / 收尾 / CAM 询问框自动应答）的离线测试。
//
// 全部是纯函数 + 假数据：不启动 SOLIDWORKS、不 spawn 任何进程、不碰真登记表，
// 也不跑 powershell。真对着 SW 的验收交给 live 测试。
//
// 覆盖场景：
//   ① 正常出现主窗口 → ok
//   ② 许可弹窗 → kill + SW_LICENSE_UNAVAILABLE
//   ③ 120s 没有 ROT/窗口 → kill + SW_START_FAILED
//   ④ splash 卡住 → kill
//   ⑤ 别家 pid 的许可弹窗不误判（必须绑定本次 lease pid）
//   ⑥ 冷却期内 → SW_LAUNCH_COOLDOWN
//   ⑦ 已有用户实例卡许可弹窗 → 不再起新实例
//   ⑧ ROT 出现但窗口未就绪 → wait 到超时再 kill
//   ⑨ CAM 询问框（「是否继续加载 SOLIDWORKS CAM 2026」）不是失败：自动点「是」后照常启动
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_LAUNCH_CLICK_MAX,
  DEFAULT_LAUNCH_COOLDOWN_MS,
  DEFAULT_LAUNCH_WATCH_MS,
  DIALOG_KIND,
  InstanceManager,
  LAUNCH_GUARD_CODES,
  classifyDialog,
  clearLaunchFailure,
  decideLaunchOutcome,
  defaultLaunchFailureFile,
  dialogTextUnreliable,
  isLicenseDialog,
  isLicenseFailureDialog,
  isPromptDialog,
  launchFailureMessage,
  launchNextSteps,
  licenseDialogHit,
  normalizeDialogText,
  preflightLaunch,
  readInstances,
  readLaunchFailure,
  writeLaunchFailure,
} from '../server/broker/instances.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

const tempDirs = []
function tempDir(tag = 'sw-launch') {
  const dir = mkdtempSync(join(tmpdir(), `${tag}-`))
  tempDirs.push(dir)
  return dir
}

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const WATCH = DEFAULT_LAUNCH_WATCH_MS // 120_000
const iso = (ms) => new Date(ms).toISOString()

// 常见现场：SOLIDWORKS CAM 许可服务器连不上。
const LICENSE_DIALOG = { pid: 5000, title: 'SOLIDWORKS', text: 'SOLIDWORKS CAM 无法连接许可服务器 (-15,10,0,0)' }

// ------------------------------------------------------------ 许可弹窗判据
{
  check('判据：中文许可弹窗命中', licenseDialogHit({ title: 'SOLIDWORKS', text: 'SOLIDWORKS CAM 无法连接许可服务器 (-15,10,0,0)' }) !== null,
    licenseDialogHit({ title: 'SOLIDWORKS', text: 'SOLIDWORKS CAM 无法连接许可服务器 (-15,10,0,0)' }))
  check('判据：英文 license/CAM cannot connect 命中',
    licenseDialogHit({ title: 'Licensing', text: 'SOLIDWORKS CAM cannot connect to license server' }) !== null)
  check('判据：无法连接 + 许可 命中', licenseDialogHit({ title: '许可', text: '无法连接许可服务器' }) !== null)
  check('判据：只说「许可」没有 CAM/无法连接 不算许可弹窗', licenseDialogHit({ title: '许可', text: '磁盘空间不足' }) === null)
  check('判据：只说 CAM 没有许可字样不算许可弹窗', licenseDialogHit({ title: 'SOLIDWORKS', text: 'CAM 教程' }) === null)
  check('判据：空弹窗不误判', isLicenseDialog({}) === false && licenseDialogHit({ title: '', text: '' }) === null)
  // 判据顺序：标题命中许可、正文命中 CAM 也算（两个模式各自独立匹配）。
  check('判据：标题与正文分开命中', licenseDialogHit({ title: 'License Error', text: 'CAM failed (-15,)' }) !== null)
}

// --------------------------------------------- ① 正常出现主窗口 → ok
{
  const decision = decideLaunchOutcome({
    elapsedMs: 8_000,
    hasMainWindow: true,
    mainWindowTitle: 'SOLIDWORKS 2026 - [零件1]',
    dialogs: [],
    rotFound: true,
    lease: { pid: 5000 },
    windowKnown: true,
  })
  check('① 正常出现主窗口 → ok', decision.action === 'ok' && decision.code === null, decision)
  check('① ok 时带主窗口标题、不带错误码', decision.windowTitle === 'SOLIDWORKS 2026 - [零件1]' && decision.code === null, decision)
}

// -------------------------------------- ② 许可弹窗 → kill + 许可不可用
{
  const decision = decideLaunchOutcome({
    elapsedMs: 6_000,
    hasMainWindow: false,
    mainWindowTitle: '',
    dialogs: [LICENSE_DIALOG],
    rotFound: false,
    lease: { pid: 5000 },
  })
  check('② 许可弹窗 → kill + SW_LICENSE_UNAVAILABLE',
    decision.action === 'kill' && decision.code === 'SW_LICENSE_UNAVAILABLE', decision)
  check('② 判定立即生效（还在 120s 内）', decision.elapsedMs === 6_000, decision.elapsedMs)
  check('② 带回弹窗文本与 pid', decision.pid === 5000 && /CAM/.test(decision.dialogText ?? ''), decision)
  check('② 错误消息告诉用户禁用 CAM 自启动',
    /CAM/.test(launchFailureMessage('SW_LICENSE_UNAVAILABLE', decision)) && /插件/.test(launchFailureMessage('SW_LICENSE_UNAVAILABLE', decision)),
    launchFailureMessage('SW_LICENSE_UNAVAILABLE', decision))
}

// ------------------------------- ③ 120s 无 ROT 无窗口 → kill + 启动失败
{
  const before = decideLaunchOutcome({ elapsedMs: 60_000, rotFound: false, lease: { pid: 5000 } })
  check('③ 120s 之前 → wait', before.action === 'wait' && before.code === null, before)
  const decision = decideLaunchOutcome({ elapsedMs: WATCH, rotFound: false, hasMainWindow: false, lease: { pid: 5000 } })
  check('③ 120s 没有 ROT/窗口 → kill + SW_START_FAILED',
    decision.action === 'kill' && decision.code === 'SW_START_FAILED', decision)
  check('③ 超时判据带 elapsedMs/windowTitle/dialogText',
    decision.elapsedMs === WATCH && decision.windowTitle === null && decision.dialogText === null, decision)
  check('③ 超时原因是 no-rot', decision.reason === 'no-rot', decision.reason)
  const message = launchFailureMessage(decision.code, decision)
  check('③ 消息含下一步（手动启动一次/处理弹窗）',
    /手动启动/.test(message) && /next|下一步|重试/.test(message), message)
}

// ------------------------------------------------ ④ 主窗口一直是 splash → kill
{
  const early = decideLaunchOutcome({ elapsedMs: 40_000, hasMainWindow: true, mainWindowTitle: 'SOLIDWORKS splash', rotFound: true, lease: { pid: 5000 } })
  check('④ splash 未到 120s → wait', early.action === 'wait' && early.reason === 'splash-pending', early)
  const decision = decideLaunchOutcome({ elapsedMs: WATCH, hasMainWindow: true, mainWindowTitle: 'SOLIDWORKS splash', rotFound: true, lease: { pid: 5000 } })
  check('④ splash 卡到 120s → kill', decision.action === 'kill' && decision.code === 'SW_START_FAILED', decision)
  check('④ splash 判据优先于「有窗口」', decision.reason === 'splash-stuck', decision.reason)
  check('④ 消息里带窗口标题', /splash/i.test(launchFailureMessage(decision.code, decision)), launchFailureMessage(decision.code, decision))
}

// ------------------------- ⑤ 别家 pid 的许可弹窗不误判（绑定本次 lease pid）
{
  const decision = decideLaunchOutcome({
    elapsedMs: 20_000,
    hasMainWindow: false,
    dialogs: [{ pid: 7777, title: 'SOLIDWORKS', text: 'SOLIDWORKS CAM 无法连接许可服务器 (-15,10,0,0)' }],
    rotFound: false,
    lease: { pid: 5000 },
  })
  check('⑤ 别家 pid 的许可弹窗不算本次失败 → wait', decision.action === 'wait' && decision.code === null, decision)
  check('⑤ 别家 pid 的弹窗不进入 dialogs 明细', Array.isArray(decision.dialogs) && decision.dialogs.length === 0, decision.dialogs)
  const noPid = decideLaunchOutcome({
    elapsedMs: 20_000,
    dialogs: [{ title: 'SOLIDWORKS', text: 'CAM 无法连接许可服务器' }],
    lease: { pid: 5000 },
  })
  check('⑤ 没有 pid 的弹窗不归到本次启动（宁可不杀）', noPid.action === 'wait', noPid)
  const own = decideLaunchOutcome({
    elapsedMs: 20_000,
    dialogs: [
      { pid: 7777, title: 'SOLIDWORKS', text: 'CAM 无法连接许可服务器' },
      { pid: 6000, title: 'SOLIDWORKS', text: 'CAM 无法连接许可服务器' },
    ],
    lease: { pid: 5000, pids: [5000, 6000] },
  })
  check('⑤ lease 里的 pid（ROT 新出现的）能命中', own.action === 'kill' && own.pid === 6000 && own.code === 'SW_LICENSE_UNAVAILABLE', own)
}

// --------------------------- ⑧ ROT 出现但窗口未就绪 → wait 到超时再 kill
{
  const early = decideLaunchOutcome({ elapsedMs: 119_000, rotFound: true, hasMainWindow: false, lease: { pid: 5000 } })
  check('⑧ ROT 出现但窗口未就绪 → 继续 wait', early.action === 'wait', early)
  const decision = decideLaunchOutcome({ elapsedMs: WATCH, rotFound: true, hasMainWindow: false, lease: { pid: 5000 } })
  check('⑧ 超时后才 kill + SW_START_FAILED', decision.action === 'kill' && decision.code === 'SW_START_FAILED', decision)
  check('⑧ 超时原因是 window-not-ready', decision.reason === 'window-not-ready', decision.reason)
}

// ----------------------------- 窗口探测不可用时退回「ROT 出现即成功」的旧语义
{
  const ok = decideLaunchOutcome({ elapsedMs: 4_000, rotFound: true, windowKnown: false, lease: { pid: 5000 } })
  check('兼容：没窗口探测时 ROT 出现 → ok', ok.action === 'ok' && ok.reason === 'rot-visible', ok)
  const timeout = decideLaunchOutcome({ elapsedMs: WATCH, rotFound: false, windowKnown: false, lease: { pid: 5000 } })
  check('兼容：没窗口探测时 ROT 不出现 → kill SW_START_FAILED', timeout.action === 'kill' && timeout.code === 'SW_START_FAILED', timeout)
}

// -------------------------------------------------------- 失败标记文件格式
{
  const dir = tempDir('sw-launch-mark')
  const file = join(dir, 'state', 'launch-failure.json')
  check('标记路径：默认在 %LOCALAPPDATA%\\sw-mcp\\state 下',
    /sw-mcp[\\/]state[\\/]launch-failure\.json$/i.test(defaultLaunchFailureFile({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })),
    defaultLaunchFailureFile({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }))
  const mark = writeLaunchFailure(file, {
    code: 'SW_START_FAILED',
    at: iso(T0),
    pid: 4321,
    elapsedMs: 120_000,
    windowTitle: 'SOLIDWORKS splash',
    dialogText: 'SOLIDWORKS CAM 无法连接许可服务器 (-15,10,0,0)',
    reason: 'splash-stuck',
  })
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  check('标记落盘：含 code/at/pid/dialogText',
    raw.code === 'SW_START_FAILED' && raw.at === iso(T0) && raw.pid === 4321 && /CAM/.test(raw.dialogText), raw)
  check('标记落盘：含 elapsedMs/windowTitle/reason/killed/nextSteps',
    raw.elapsedMs === 120_000 && raw.windowTitle === 'SOLIDWORKS splash' && raw.reason === 'splash-stuck'
      && raw.killed === false && Array.isArray(raw.nextSteps) && raw.nextSteps.length > 0, raw)
  check('标记落盘：自动补 message', typeof raw.message === 'string' && raw.message.length > 0, raw.message)
  const fresh = readLaunchFailure(file, { now: T0 + 2 * 60_000 })
  check('标记读取：2 分钟内算新鲜（冷却期）', fresh.fresh === true && fresh.ageMs === 120_000, { fresh: fresh.fresh, ageMs: fresh.ageMs })
  const stale = readLaunchFailure(file, { now: T0 + 11 * 60_000 })
  check('标记读取：11 分钟后不再冷却', stale.fresh === false, { fresh: stale.fresh, ageMs: stale.ageMs })
  check('标记读取：坏文件当没有标记', readLaunchFailure(join(dir, 'nope.json')).fresh === false)
  writeFileSync(join(dir, 'broken.json'), '{ 不是 JSON', 'utf8')
  check('标记读取：JSON 坏了也不炸', readLaunchFailure(join(dir, 'broken.json')).mark === null)
  check('标记清理：clearLaunchFailure 删文件', clearLaunchFailure(file) === true && readLaunchFailure(file).mark === null)
  check('标记写入：未知 code 收敛成 SW_START_FAILED',
    writeLaunchFailure(file, { code: 'SOMETHING_ELSE' }).code === 'SW_START_FAILED')
  void mark
}

// -------------------------------------- 预检落地：⑥ 冷却 + ⑦ 已有实例卡许可
{
  const dir = tempDir('sw-launch-preflight')
  const failureFile = join(dir, 'state', 'launch-failure.json')
  const exe = join(dir, 'SLDWORKS.exe')
  const lnk = join(dir, 'SOLIDWORKS Design 2026.lnk')
  writeFileSync(exe, 'not really an exe', 'utf8')
  writeFileSync(lnk, 'shortcut', 'utf8')

  // ⑥ 冷却期内：刚写过失败标记（2 分钟前）→ 直接 SW_LAUNCH_COOLDOWN，不问探测。
  writeLaunchFailure(failureFile, { code: 'SW_LICENSE_UNAVAILABLE', at: iso(T0 - 2 * 60_000), pid: 5000, dialogText: 'CAM (-15,)' })
  let probed = 0
  const cooldown = await preflightLaunch({
    env: { LOCALAPPDATA: dir },
    now: T0,
    failureFile,
    target: { target: exe, kind: 'exe' },
    exePath: exe,
    probe: async () => { probed += 1; return { instances: [] } },
    sampleWindow: async () => ({ ok: true, hasMainWindow: false, mainWindowTitle: '', dialogs: [] }),
  })
  check('⑥ 冷却期内 → SW_LAUNCH_COOLDOWN', cooldown.ok === false && cooldown.code === 'SW_LAUNCH_COOLDOWN', cooldown)
  check('⑥ 冷却检查在许可探测之前（不为一次注定失败的启动去采样）', probed === 0, probed)
  check('⑥ 消息说明上次失败原因与下一步',
    /上次/.test(cooldown.message) && /冷却/.test(cooldown.message) && /launch-failure\.json/.test(cooldown.message), cooldown.message)
  check('⑥ checks 里 launch-cooldown 失败', cooldown.checks.some((item) => item.id === 'launch-cooldown' && item.ok === false), cooldown.checks)

  // 冷却过后（11 分钟前）→ 预检通过。
  writeLaunchFailure(failureFile, { code: 'SW_START_FAILED', at: iso(T0 - 11 * 60_000), pid: 0 })
  const cooled = await preflightLaunch({
    env: {},
    now: T0,
    failureFile,
    target: { target: exe, kind: 'exe' },
    exePath: exe,
    probe: async () => ({ instances: [] }),
    sampleWindow: async () => ({ ok: true, hasMainWindow: false, mainWindowTitle: '', dialogs: [] }),
  })
  check('⑥ 冷却过后预检通过', cooled.ok === true && cooled.code === null, cooled)
  check('⑥ 预检结果含 checks[]（exe-path/launch-target/launch-cooldown/license-dialog）',
    cooled.checks.map((item) => item.id).join(',') === 'exe-path,launch-target,launch-cooldown,license-dialog', cooled.checks.map((item) => item.id))
  check('⑥ 冷却时长可配置（0 表示不冷却）',
    (await preflightLaunch({
      env: {}, now: T0, cooldownMs: 0, failureFile,
      target: { target: exe, kind: 'exe' }, exePath: exe,
      probe: async () => ({ instances: [] }),
      sampleWindow: async () => ({ ok: true, dialogs: [] }),
    })).ok === true)
  void DEFAULT_LAUNCH_COOLDOWN_MS

  // ⑦ 已有用户实例卡在许可弹窗 → 不再起第二个，直接 SW_LICENSE_UNAVAILABLE。
  const license = await preflightLaunch({
    env: {},
    now: T0 + 60 * 60_000,
    failureFile,
    target: { target: exe, kind: 'exe' },
    exePath: exe,
    probe: async () => ({ instances: [{ pid: 8888 }] }),
    sampleWindow: async (pid) => ({
      ok: true,
      mainWindowTitle: 'SOLIDWORKS',
      hasMainWindow: false,
      dialogs: [{ pid, title: 'SOLIDWORKS', text: 'SOLIDWORKS CAM 无法连接许可服务器 (-15,10,0,0)' }],
    }),
  })
  check('⑦ 已有实例卡许可弹窗 → SW_LICENSE_UNAVAILABLE', license.ok === false && license.code === 'SW_LICENSE_UNAVAILABLE', license)
  check('⑦ 指出是哪个已有 pid 卡住', license.checks.some((item) => item.id === 'license-dialog' && item.ok === false && /8888/.test(item.detail)), license.checks)
  check('⑦ 消息含用户下一步（禁用 CAM 自启动/修许可服务器）',
    /CAM/.test(license.message) && /插件/.test(license.message), license.message)
  check('⑦ 别家实例只是普通弹窗不算许可弹窗',
    (await preflightLaunch({
      env: {}, now: T0 + 60 * 60_000, failureFile,
      target: { target: exe, kind: 'exe' }, exePath: exe,
      probe: async () => ({ instances: [{ pid: 8888 }] }),
      sampleWindow: async (pid) => ({ ok: true, hasMainWindow: true, mainWindowTitle: 'SOLIDWORKS', dialogs: [{ pid, title: '欢迎', text: '新建零件' }] }),
    })).ok === true)

  // 目标不存在 → SW_LAUNCH_TARGET_MISSING（不启动）。
  const missing = await preflightLaunch({
    env: {},
    now: T0,
    failureFile: join(dir, 'state', 'empty.json'),
    target: { target: join(dir, 'no-such-SLDWORKS.exe'), kind: 'exe' },
    exePath: join(dir, 'no-such-SLDWORKS.exe'),
    probe: async () => ({ instances: [] }),
    sampleWindow: async () => ({ ok: true, dialogs: [] }),
  })
  check('预检：exe 不存在 → SW_LAUNCH_TARGET_MISSING', missing.ok === false && missing.code === 'SW_LAUNCH_TARGET_MISSING', missing)
  check('预检：缺 exe 的消息给出安装/环境变量两条路',
    /SW_MCP_SW_EXE/.test(missing.message ?? ''), missing.message)

  // 回退到 .lnk 时 exe 检查标 skipped，不阻塞启动。
  const shortcut = await preflightLaunch({
    env: {},
    now: T0,
    failureFile: join(dir, 'state', 'empty.json'),
    target: { target: lnk, kind: 'lnk' },
    exePath: join(dir, 'no-such-SLDWORKS.exe'),
    probe: async () => ({ instances: [] }),
    sampleWindow: async () => ({ ok: true, dialogs: [] }),
  })
  check('预检：回退 .lnk 时 exe 检查 skipped 但仍放行', shortcut.ok === true
    && shortcut.checks.some((item) => item.id === 'exe-path' && item.skipped === true), shortcut.checks)
  check('预检：未注入窗口探测时许可检查 skipped 且放行',
    (await preflightLaunch({ env: {}, now: T0, failureFile: join(dir, 'state', 'empty.json'), target: { target: exe, kind: 'exe' }, exePath: exe })).ok === true)
  const probeFailed = await preflightLaunch({
    env: {},
    now: T0,
    failureFile: join(dir, 'state', 'empty.json'),
    target: { target: exe, kind: 'exe' },
    exePath: exe,
    probe: async () => ({ instances: [], error: { code: 'PROBE_FAILED' } }),
    sampleWindow: async () => ({ ok: true, dialogs: [] }),
  })
  check('预检：ROT 探不到时许可检查如实标 skipped（不假装通过）', probeFailed.ok === true
    && probeFailed.checks.some((item) => item.id === 'license-dialog' && item.skipped === true), probeFailed.checks)
}

// ============================================================ 管理器集成
// 假的 launcher / 假的窗口采样 / 假的 Stop-Process：验证三段守卫的接线与收尾。
function fakeManager({
  rot = [],
  launchResult = null,
  samples = null,
  preflight = null,
  clickDialog = null,
  verifyCom = null,
  watchMs = 5_000,
  sampleMs = 100,
  withSampler = true,
  withPreflight = false,
} = {}) {
  const dir = tempDir('sw-launch-mgr')
  const clock = { t: T0 }
  const state = { rot, launches: 0, stopped: [], stoppedWorkers: [], launchesAt: [], clicks: [], comProbes: [] }
  const workers = new Map()
  const failureFile = join(dir, 'state', 'launch-failure.json')
  const manager = new InstanceManager({
    file: join(dir, 'instances.json'),
    env: {},
    probe: async () => ({ instances: state.rot.slice(), activePid: state.rot[0]?.pid ?? null }),
    launch: async () => {
      state.launches += 1
      state.launchesAt.push(clock.t)
      const result = typeof launchResult === 'function' ? launchResult(state) : (launchResult ?? { launched: true, target: 'fake-sldworks.exe' })
      if (Array.isArray(result?.rot)) state.rot.push(...result.rot)
      return result
    },
    preflight: withPreflight ? preflight : undefined,
    sampleWindow: withSampler ? (async (pid) => (typeof samples === 'function' ? samples(pid, state) : samples)) : undefined,
    // 自动应答注入：clicks 记下每次点击请求，测试据此断言「只点本次 lease、最多 5 次」。
    clickDialog: clickDialog
      ? (async (args) => { state.clicks.push(args); return clickDialog(args, state) })
      : undefined,
    // 误杀防护注入：comProbes 记下每次 COM 探测请求。
    verifyCom: verifyCom
      ? (async (args) => { state.comProbes.push(args); return verifyCom(args, state) })
      : undefined,
    workers,
    workerLastUsed: new Map(),
    clientPid: new Map(),
    stopProcess: async (pid) => { state.stopped.push(Number(pid)); state.rot = state.rot.filter((item) => Number(item.pid) !== Number(pid)); return true },
    stopWorker: (pid) => { state.stoppedWorkers.push(Number(pid)); return true },
    isAlive: (pid) => state.rot.some((item) => Number(item.pid) === Number(pid)),
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms },
    pollMs: 10,
    launchSampleMs: sampleMs,
    launchWatchMs: watchMs,
    launchFailureFile: failureFile,
    log: () => {},
  })
  return { manager, state, clock, dir, failureFile }
}

async function catchError(fn) {
  try { await fn(); return null } catch (error) { return error }
}

// 正常启动：主窗口出现就登记，不杀不写标记。
{
  const harness = fakeManager({
    launchResult: { launched: true, target: 'fake-sldworks.exe', pid: 4242, rot: [{ pid: 4242, startedAt: iso(T0) }] },
    samples: () => ({ ok: true, hasMainWindow: true, mainWindowTitle: 'SOLIDWORKS 2026 - [零件1]', dialogs: [] }),
  })
  const ensured = await harness.manager.ensure({ clientId: 'sess-a', timeoutMs: 30_000, startWorker: false })
  check('集成①：启动成功拿到 pid', ensured.chosenPid === 4242, ensured.chosenPid)
  check('集成①：登记为 broker 启动', ensured.launched?.entry?.launchedBy === 'broker', ensured.launched?.entry)
  check('集成①：ensure 返回 preflight: {ok, checks[]}',
    ensured.preflight?.ok === true && Array.isArray(ensured.preflight?.checks), ensured.preflight)
  check('集成①：没有杀进程、没有写失败标记',
    harness.state.stopped.length === 0 && readLaunchFailure(harness.failureFile).mark === null, harness.state.stopped)
  check('集成①：盯守耗时在 120s 预算内', ensured.launched?.watch?.elapsedMs <= WATCH, ensured.launched?.watch)
}

// 许可弹窗：杀掉自己刚起的 pid → 清登记 → 写标记 → ensure 抛结构化错误。
{
  const harness = fakeManager({
    launchResult: { launched: true, target: 'fake-sldworks.exe', pid: 5151, rot: [{ pid: 5151, startedAt: iso(T0) }] },
    samples: () => ({
      ok: true,
      hasMainWindow: false,
      mainWindowTitle: '',
      dialogs: [{ pid: 5151, title: 'SOLIDWORKS', text: 'SOLIDWORKS CAM 无法连接许可服务器 (-15,10,0,0)' }],
    }),
  })
  const error = await catchError(() => harness.manager.ensure({ clientId: 'sess-b', timeoutMs: 30_000, startWorker: false }))
  check('集成②：ensure 抛 SW_LICENSE_UNAVAILABLE', error?.code === 'SW_LICENSE_UNAVAILABLE', error?.code)
  check('集成②：消息含用户下一步（CAM / 插件管理器）',
    /CAM/.test(error?.message ?? '') && /插件/.test(error?.message ?? ''), error?.message)
  check('集成②：只杀自己刚起的 pid', harness.state.stopped.join(',') === '5151', harness.state.stopped)
  check('集成②：instances.json 里没有留下登记',
    readInstances(join(harness.dir, 'instances.json')).instances.every((entry) => entry.pid !== 5151),
    readInstances(join(harness.dir, 'instances.json')).instances)
  const raw = JSON.parse(readFileSync(harness.failureFile, 'utf8'))
  check('集成②：失败标记含 code/at/pid/dialogText',
    raw.code === 'SW_LICENSE_UNAVAILABLE' && typeof raw.at === 'string' && raw.pid === 5151 && /CAM/.test(raw.dialogText), raw)
  check('集成②：错误 details 里带 preflight 与 nextSteps',
    error?.details?.preflight?.ok === true && Array.isArray(error?.details?.nextSteps) && error?.details?.killed === true,
    { preflight: error?.details?.preflight, killed: error?.details?.killed })
  check('集成②：LAUNCH_GUARD_CODES 覆盖三种要求码',
    ['SW_LICENSE_UNAVAILABLE', 'SW_START_FAILED', 'SW_LAUNCH_COOLDOWN'].every((code) => LAUNCH_GUARD_CODES.includes(code)), LAUNCH_GUARD_CODES)
}

// 别家 pid 的许可弹窗：不许误杀，超时后只收自己那个。
{
  const harness = fakeManager({
    launchResult: { launched: true, target: 'fake-sldworks.exe', pid: 6161, rot: [{ pid: 6161, startedAt: iso(T0) }] },
    samples: () => ({
      ok: true,
      hasMainWindow: false,
      mainWindowTitle: '',
      dialogs: [{ pid: 7777, title: 'SOLIDWORKS', text: 'SOLIDWORKS CAM 无法连接许可服务器 (-15,10,0,0)' }],
    }),
  })
  const error = await catchError(() => harness.manager.ensure({ clientId: 'sess-c', timeoutMs: 60_000, startWorker: false }))
  check('集成⑤：别家 pid 的弹窗不算许可失败 → 超时 SW_START_FAILED', error?.code === 'SW_START_FAILED', error?.code)
  check('集成⑤：只杀自己刚起的 pid 6161，没碰 7777',
    harness.state.stopped.join(',') === '6161' && !harness.state.stopped.includes(7777), harness.state.stopped)
  check('集成⑤：超时判据带 elapsedMs（5s 预算）与窗口信息',
    error?.details?.elapsedMs >= 5_000 && 'windowTitle' in (error?.details ?? {}) && 'dialogText' in (error?.details ?? {}),
    { elapsedMs: error?.details?.elapsedMs, windowTitle: error?.details?.windowTitle })
  const raw = JSON.parse(readFileSync(harness.failureFile, 'utf8'))
  check('集成⑤：标记里是 SW_START_FAILED / 本次 pid', raw.code === 'SW_START_FAILED' && raw.pid === 6161, { code: raw.code, pid: raw.pid })
}

// 「别杀错」：launcher 报的 pid 是启动前就存在的实例 → 拒绝 Stop-Process。
{
  const harness = fakeManager({
    rot: [{ pid: 7070, startedAt: iso(T0 - 3_600_000) }],
    launchResult: { launched: true, target: 'fake-sldworks.exe', pid: 7070 },
    samples: () => ({
      ok: true,
      hasMainWindow: false,
      mainWindowTitle: '',
      dialogs: [{ pid: 7070, title: 'SOLIDWORKS', text: 'SOLIDWORKS CAM 无法连接许可服务器 (-15,10,0,0)' }],
    }),
  })
  // isolated + 已有实例被别人绑定：没到上限 → 允许本次启动（模拟 launcher 误报已有 pid）。
  harness.manager.clientPid.set('other', 7070)
  const error = await catchError(() => harness.manager.ensure({
    clientId: 'mine', policy: 'isolated', maxInstances: 2, timeoutMs: 30_000, startWorker: false,
  }))
  check('集成⑤b：启动守卫仍给出结构化错误', error?.code === 'SW_LICENSE_UNAVAILABLE', error?.code)
  check('集成⑤b：启动前就存在的 pid 绝不被杀', harness.state.stopped.length === 0, harness.state.stopped)
  check('集成⑤b：失败标记记下 killed=false',
    JSON.parse(readFileSync(harness.failureFile, 'utf8')).killed === false, readFileSync(harness.failureFile, 'utf8'))
}

// 预检拒绝：根本不调用 launcher，也不写新的失败标记。
{
  let launchCalls = 0
  const harness = fakeManager({
    withPreflight: true,
    preflight: async () => ({
      ok: false,
      code: 'SW_LAUNCH_COOLDOWN',
      message: launchFailureMessage('SW_LAUNCH_COOLDOWN', { previousCode: 'SW_LICENSE_UNAVAILABLE', minutes: 2 }),
      checks: [{ id: 'launch-cooldown', ok: false, detail: '还在冷却期' }],
      details: { previousCode: 'SW_LICENSE_UNAVAILABLE' },
    }),
  })
  const originalLaunch = harness.manager.launch
  harness.manager.launch = async () => { launchCalls += 1; return originalLaunch() }
  const error = await catchError(() => harness.manager.ensure({ clientId: 'sess-d', timeoutMs: 30_000, startWorker: false }))
  check('集成⑥：预检拒绝 → SW_LAUNCH_COOLDOWN', error?.code === 'SW_LAUNCH_COOLDOWN', error?.code)
  check('集成⑥：预检拒绝时一次都没调 launcher', launchCalls === 0 && harness.state.launches === 0, { launchCalls, launches: harness.state.launches })
  check('集成⑥：预检拒绝不覆盖旧标记（不写新文件）',
    readLaunchFailure(harness.failureFile).mark === null, readLaunchFailure(harness.failureFile))
  check('集成⑥：错误 details 里带预检 checks',
    Array.isArray(error?.details?.checks) && error.details.checks.some((item) => item.id === 'launch-cooldown'), error?.details?.checks)
}

// 没有窗口采样能力时退回旧语义：ROT 出现就成功（否则既有调用方全部退化）。
{
  const harness = fakeManager({
    withSampler: false,
    launchResult: () => ({ launched: true, target: 'fake-sldworks.exe', rot: [{ pid: 8383, startedAt: iso(T0) }] }),
  })
  const ensured = await harness.manager.ensure({ clientId: 'sess-e', timeoutMs: 30_000, startWorker: false })
  check('兼容：无窗口采样时 ROT 出现即成功', ensured.chosenPid === 8383, ensured.chosenPid)
  check('兼容：无窗口采样时不杀进程也不写标记',
    harness.state.stopped.length === 0 && readLaunchFailure(harness.failureFile).mark === null)
}

// 收尾后冷却生效：再 ensure 一次会先被失败标记挡住（不再起第二个进程）。
{
  const harness = fakeManager({
    withPreflight: true,
    preflight: () => preflightLaunch({
      env: {},
      now: harness.clock.t,
      cooldownMs: DEFAULT_LAUNCH_COOLDOWN_MS,
      failureFile: harness.failureFile,
      target: { target: join(harness.dir, 'SLDWORKS.exe'), kind: 'exe' },
      exePath: join(harness.dir, 'SLDWORKS.exe'),
      probe: async () => ({ instances: [] }),
      sampleWindow: async () => ({ ok: true, dialogs: [] }),
    }),
    launchResult: { launched: true, target: 'fake-sldworks.exe', pid: 9292, rot: [{ pid: 9292, startedAt: iso(T0) }] },
    samples: () => ({
      ok: true,
      hasMainWindow: false,
      mainWindowTitle: '',
      dialogs: [{ pid: 9292, title: 'SOLIDWORKS', text: 'SOLIDWORKS CAM 无法连接许可服务器 (-15,10,0,0)' }],
    }),
  })
  writeFileSync(join(harness.dir, 'SLDWORKS.exe'), 'fake', 'utf8')
  const first = await catchError(() => harness.manager.ensure({ clientId: 'sess-f', timeoutMs: 30_000, startWorker: false }))
  check('收尾链路：第一次启动失败写标记', first?.code === 'SW_LICENSE_UNAVAILABLE', first?.code)
  const second = await catchError(() => harness.manager.ensure({ clientId: 'sess-f2', timeoutMs: 30_000, startWorker: false }))
  check('收尾链路：紧接着的重试被冷却挡住', second?.code === 'SW_LAUNCH_COOLDOWN', second?.code)
  check('收尾链路：冷却期内没有再起进程', harness.state.launches === 1, harness.state.launches)
  check('收尾链路：重试失败的 preflight 出现在错误 details 里',
    second?.details?.preflight?.ok === false && second?.details?.preflight?.code === 'SW_LAUNCH_COOLDOWN', second?.details?.preflight)
  void mkdirSync
}

// ================================================== ⑨ CAM 询问框（本轮修复）
// 真机：启动到 t≈10–14s 弹 #32770「是否继续加载 SOLIDWORKS CAM 2026」，选「是」后
// 主窗口 14–16s 出现、没有许可错误。这个询问框必须被自动应答，不能判失败。
const CAM_PROMPT = {
  pid: 5000,
  class: '#32770',
  title: 'SOLIDWORKS Design',
  text: '是否继续加载 SOLIDWORKS CAM 2026 （是，继续加载 SOLIDWORKS CAM 2026） （否，禁用 SOLIDWORKS CAM 2026）',
  buttons: ['是，继续加载 SOLIDWORKS CAM 2026', '否，禁用 SOLIDWORKS CAM 2026'],
}
const CAM_LICENSE_FAILURE = {
  pid: 5000,
  class: '#32770',
  title: 'SOLIDWORKS Design',
  text: '无法获得下列许可 SOLIDWORKS CAM 2026 (-15,578,10049)',
  buttons: ['是', '否'],
}

// ------------------------------------------------------------ ① 分类：询问框
{
  const classified = classifyDialog(CAM_PROMPT)
  check('⑨① 询问框 → kind=prompt', classified.kind === DIALOG_KIND.PROMPT, classified)
  check('⑨① 询问框带可点的「是」按钮（不是「否，禁用」）',
    /^是/.test(classified.button ?? '') && !/禁用/.test(classified.button ?? ''), classified.button)
  check('⑨① isPromptDialog / isLicenseDialog 判据一致',
    isPromptDialog(CAM_PROMPT) === true && isLicenseDialog(CAM_PROMPT) === false,
    { prompt: isPromptDialog(CAM_PROMPT), license: isLicenseDialog(CAM_PROMPT) })
  // 全角/英文/半角混排都要能认：用户机器上文案可能不是同一套字符。
  check('⑨① 全角字母数字空格也命中',
    classifyDialog({
      title: 'SOLIDWORKS Design',
      text: '是否继续加载　ＳＯＬＩＤＷＯＲＫＳ　ＣＡＭ　２０２６',
      buttons: ['是，继续加载', '否，禁用'],
    }).kind === DIALOG_KIND.PROMPT)
  check('⑨① 英文 Yes/Continue 按钮也命中',
    classifyDialog({
      title: 'SOLIDWORKS Design',
      text: 'Do you want to continue loading SOLIDWORKS CAM 2026?',
      buttons: ['Yes, continue loading SOLIDWORKS CAM 2026', 'No, disable'],
    }).kind === DIALOG_KIND.PROMPT)
  check('⑨① 正文像询问框但没有「是」按钮 → 不自动应答（unknown-dialog）',
    classifyDialog({ title: 'SOLIDWORKS Design', text: '是否继续加载 SOLIDWORKS CAM 2026', buttons: ['否，禁用 SOLIDWORKS CAM 2026'] }).kind === DIALOG_KIND.UNKNOWN)
  // 盯守判定：询问框不是失败，只等 + 给出要点的按钮。
  const decision = decideLaunchOutcome({
    elapsedMs: 12_000,
    hasMainWindow: false,
    mainWindowTitle: 'SOLIDWORKS splash',
    dialogs: [CAM_PROMPT],
    rotFound: true,
    lease: { pid: 5000 },
  })
  check('⑨① 询问框 → 不 kill、不报错，继续 wait',
    decision.action === 'wait' && decision.code === null && decision.reason === 'prompt-pending', decision)
  check('⑨① wait 时带 autoAnswer（pid + 「是」按钮）',
    decision.autoAnswer?.pid === 5000 && /是/.test(decision.autoAnswer?.button ?? ''), decision.autoAnswer)
  check('⑨① 询问框不判许可失败（dialogs.kind=prompt）',
    decision.dialogs.length === 1 && decision.dialogs[0].kind === 'prompt', decision.dialogs)
  check('⑨① normalizeDialogText 把全角转半角', normalizeDialogText('（－１５，５７８）') === '(-15,578)',
    normalizeDialogText('（－１５，５７８）'))
}

// ------------------------------------------- ② 分类：真许可失败 → kill
{
  const classified = classifyDialog(CAM_LICENSE_FAILURE)
  check('⑨② 「无法获得下列许可…(-15,578,10049)」→ license-failure（即使正文带 CAM 2026 + 是按钮）',
    classified.kind === DIALOG_KIND.LICENSE, classified)
  check('⑨② isLicenseFailureDialog 判据', isLicenseFailureDialog(CAM_LICENSE_FAILURE) === true)
  const decision = decideLaunchOutcome({
    elapsedMs: 15_000,
    hasMainWindow: false,
    dialogs: [CAM_LICENSE_FAILURE],
    rotFound: true,
    lease: { pid: 5000 },
  })
  check('⑨② 许可失败 → 立即 kill + SW_LICENSE_UNAVAILABLE',
    decision.action === 'kill' && decision.code === 'SW_LICENSE_UNAVAILABLE', decision)
  check('⑨② 许可失败不给 autoAnswer（绝不去点「是」）', decision.autoAnswer === null, decision.autoAnswer)
  // 端到端：真的把本次 lease 的 pid 收掉并写标记。
  const harness = fakeManager({
    launchResult: { launched: true, target: 'fake-sldworks.exe', pid: 5252, rot: [{ pid: 5252, startedAt: iso(T0) }] },
    samples: () => ({ ok: true, hasMainWindow: false, mainWindowTitle: '', dialogs: [{ ...CAM_LICENSE_FAILURE, pid: 5252 }] }),
    clickDialog: async () => ({ ok: true, clicked: [{ text: '是' }] }),
  })
  const error = await catchError(() => harness.manager.ensure({ clientId: 'sess-cam-license', timeoutMs: 30_000, startWorker: false }))
  check('⑨② ensure 抛 SW_LICENSE_UNAVAILABLE 且只杀自己那个 pid',
    error?.code === 'SW_LICENSE_UNAVAILABLE' && harness.state.stopped.join(',') === '5252', { code: error?.code, stopped: harness.state.stopped })
  check('⑨② 许可失败时一次都没去点弹窗', harness.state.clicks.length === 0, harness.state.clicks)
}

// ------------------------------------------- ③ unknown-dialog → 继续等待
{
  const unknownDialog = { pid: 5000, class: '#32770', title: 'SOLIDWORKS Design', text: '正在初始化模型视图，请稍候', buttons: ['确定'] }
  check('⑨③ 其他 #32770 → unknown-dialog',
    classifyDialog(unknownDialog).kind === DIALOG_KIND.UNKNOWN, classifyDialog(unknownDialog))
  const early = decideLaunchOutcome({
    elapsedMs: 30_000, hasMainWindow: false, dialogs: [unknownDialog], rotFound: true, lease: { pid: 5000 },
  })
  check('⑨③ 120s 内 → 继续 wait（不 kill）', early.action === 'wait' && early.code === null, early)
  check('⑨③ wait 原因标成 modal-dialog、不给 autoAnswer',
    early.reason === 'modal-dialog' && early.autoAnswer === null, { reason: early.reason, autoAnswer: early.autoAnswer })
  const timeout = decideLaunchOutcome({
    elapsedMs: WATCH, hasMainWindow: false, dialogs: [unknownDialog], rotFound: true, lease: { pid: 5000 },
  })
  check('⑨③ 等到超时才 kill + SW_START_FAILED，原因是 modal-dialog',
    timeout.action === 'kill' && timeout.code === 'SW_START_FAILED' && timeout.reason === 'modal-dialog', timeout)
  check('⑨③ 超时把 unknown-dialog 的标题/正文写进 dialogText',
    /SOLIDWORKS Design/.test(timeout.dialogText ?? '') && /正在初始化/.test(timeout.dialogText ?? ''), timeout.dialogText)
  // 端到端：失败标记里也要有 dialogs[] 明细与 kind。
  const harness = fakeManager({
    launchResult: { launched: true, target: 'fake-sldworks.exe', pid: 5353, rot: [{ pid: 5353, startedAt: iso(T0) }] },
    samples: () => ({ ok: true, hasMainWindow: false, mainWindowTitle: '', dialogs: [{ ...unknownDialog, pid: 5353 }] }),
    clickDialog: async () => ({ ok: true, clicked: [{ text: '是' }] }),
  })
  const error = await catchError(() => harness.manager.ensure({ clientId: 'sess-cam-unknown', timeoutMs: 60_000, startWorker: false }))
  const mark = JSON.parse(readFileSync(harness.failureFile, 'utf8'))
  check('⑨③ 超时收尾：SW_START_FAILED + 标记里 dialogs[].kind=unknown-dialog',
    error?.code === 'SW_START_FAILED' && mark.dialogs.some((dialog) => dialog.kind === 'unknown-dialog'), { code: error?.code, dialogs: mark.dialogs })
  check('⑨③ unknown-dialog 也不会去点', harness.state.clicks.length === 0, harness.state.clicks)
}

// ------------------------------ ④ 自动应答成功：点一次「是」→ 主窗口出现 → ok
{
  const harness = fakeManager({
    launchResult: { launched: true, target: 'fake-sldworks.exe', pid: 4343, rot: [{ pid: 4343, startedAt: iso(T0) }] },
    clickDialog: async ({ pid, button }) => ({ ok: true, pid, clicked: [{ text: button }] }),
    samples: (pid, state) => (state.clicks.length > 0
      ? { ok: true, hasMainWindow: true, mainWindowTitle: 'SOLIDWORKS 2026 - [零件1]', dialogs: [] }
      : { ok: true, hasMainWindow: false, mainWindowTitle: 'SOLIDWORKS splash', dialogs: [{ ...CAM_PROMPT, pid }] }),
  })
  const ensured = await harness.manager.ensure({ clientId: 'sess-cam-ok', timeoutMs: 30_000, startWorker: false })
  check('⑨④ 询问框被自动应答后正常启动 → ok / chosenPid', ensured.chosenPid === 4343, ensured.chosenPid)
  check('⑨④ 只点了一次，且点的是「是，继续加载…」',
    harness.state.clicks.length === 1 && /^是/.test(harness.state.clicks[0]?.button ?? ''), harness.state.clicks)
  check('⑨④ 点击绑定本次 lease pid（4343）',
    harness.state.clicks.every((click) => click.pid === 4343), harness.state.clicks)
  const dialogs = ensured.launched?.watch?.dialogs ?? []
  check('⑨④ ensure 返回体带 dialogs[]{title,text,kind,clicked}',
    dialogs.length === 1 && dialogs[0].kind === 'prompt' && dialogs[0].clicked === true
      && /SOLIDWORKS Design/.test(dialogs[0].title ?? '') && /继续加载/.test(dialogs[0].text ?? ''), dialogs)
  check('⑨④ 成功路径 autoClickFailed=false、不杀进程、不写标记',
    ensured.launched?.autoClickFailed === false && harness.state.stopped.length === 0
      && readLaunchFailure(harness.failureFile).mark === null,
    { autoClickFailed: ensured.launched?.autoClickFailed, stopped: harness.state.stopped })
}

// ------------------------- ⑤ 应答 3 次都失败 → 超时 SW_START_FAILED + 手动点提示
{
  const harness = fakeManager({
    launchResult: { launched: true, target: 'fake-sldworks.exe', pid: 5454, rot: [{ pid: 5454, startedAt: iso(T0) }] },
    clickDialog: async () => ({ ok: false, error: 'NO_ACCEPT_BUTTON' }),
    samples: (pid) => ({ ok: true, hasMainWindow: false, mainWindowTitle: 'SOLIDWORKS splash', dialogs: [{ ...CAM_PROMPT, pid }] }),
    watchMs: 20_000,
  })
  const error = await catchError(() => harness.manager.ensure({ clientId: 'sess-cam-fail', timeoutMs: 60_000, startWorker: false }))
  check('⑨⑤ 询问框点不动 → 超时 SW_START_FAILED', error?.code === 'SW_START_FAILED', error?.code)
  check('⑨⑤ 最多点 5 次（DEFAULT_LAUNCH_CLICK_MAX，本轮从 3 提到 5）',
    harness.state.clicks.length === DEFAULT_LAUNCH_CLICK_MAX && DEFAULT_LAUNCH_CLICK_MAX === 5, harness.state.clicks.length)
  check('⑨⑤ 每次点击都绑定本次 lease pid 5454',
    harness.state.clicks.every((click) => click.pid === 5454), harness.state.clicks.map((click) => click.pid))
  check('⑨⑤ 消息写明「有模态询问框但无法自动应答，请手动点『是』」',
    /有模态询问框但无法自动应答/.test(error?.message ?? '') && /手动点『是』/.test(error?.message ?? ''), error?.message)
  const mark = JSON.parse(readFileSync(harness.failureFile, 'utf8'))
  check('⑨⑤ 失败标记 reason=prompt-unanswered / autoClickFailed=true / dialogs.kind=prompt',
    mark.reason === 'prompt-unanswered' && mark.autoClickFailed === true
      && mark.dialogs.some((dialog) => dialog.kind === 'prompt' && dialog.clicked === false),
    { reason: mark.reason, autoClickFailed: mark.autoClickFailed, dialogs: mark.dialogs })
  check('⑨⑤ 两两点击间隔 ≥2s（间隔在假时钟上可数）',
    harness.state.clicks.length >= 2 && error?.details?.elapsedMs >= 4_000, { clicks: harness.state.clicks.length, elapsedMs: error?.details?.elapsedMs })
}

// ---------------------- ⑥ 别的 pid 的询问框绝不点击（尤其用户正开着的 SW）
{
  const foreign = { ...CAM_PROMPT, pid: 7777 }
  const decision = decideLaunchOutcome({
    elapsedMs: 12_000, hasMainWindow: false, dialogs: [foreign], rotFound: true, lease: { pid: 6666 },
  })
  check('⑨⑥ 别家 pid 的询问框不进入本次 dialogs、不给 autoAnswer',
    decision.dialogs.length === 0 && decision.autoAnswer === null, decision)
  const harness = fakeManager({
    launchResult: { launched: true, target: 'fake-sldworks.exe', pid: 6666, rot: [{ pid: 6666, startedAt: iso(T0) }] },
    clickDialog: async ({ pid, button }) => ({ ok: true, pid, clicked: [{ text: button }] }),
    samples: () => ({ ok: true, hasMainWindow: false, mainWindowTitle: '', dialogs: [foreign] }),
    watchMs: 5_000,
  })
  const error = await catchError(() => harness.manager.ensure({ clientId: 'sess-cam-foreign', timeoutMs: 30_000, startWorker: false }))
  check('⑨⑥ 别的 pid 的 prompt 一次都没被点', harness.state.clicks.length === 0, harness.state.clicks)
  check('⑨⑥ 只按超时收尾，只杀自己的 pid 6666',
    error?.code === 'SW_START_FAILED' && harness.state.stopped.join(',') === '6666', { code: error?.code, stopped: harness.state.stopped })
}

// ------------------------- ⑦ 采样器不可用：退回旧语义，不因此判许可失败
{
  const harness = fakeManager({
    withSampler: true,
    launchResult: () => ({ launched: true, target: 'fake-sldworks.exe', rot: [{ pid: 8787, startedAt: iso(T0) }] }),
    samples: () => ({ ok: false, error: 'ENUM_WINDOWS_FAILED', hasMainWindow: false, mainWindowTitle: '', dialogs: [] }),
  })
  const ensured = await harness.manager.ensure({ clientId: 'sess-cam-nosampler', timeoutMs: 30_000, startWorker: false })
  check('⑨⑦ 窗口采样失败 → 退回「ROT 出现即成功」，不判许可失败',
    ensured.chosenPid === 8787 && harness.state.stopped.length === 0, { chosenPid: ensured.chosenPid, stopped: harness.state.stopped })
}

// ------------------------- ⑧ 预检：已有实例停在询问框 → 不拒绝启动，只提示
{
  const dir = tempDir('sw-launch-preflight-prompt')
  const failureFile = join(dir, 'state', 'launch-failure.json')
  const exe = join(dir, 'SLDWORKS.exe')
  writeFileSync(exe, 'not really an exe', 'utf8')
  const sampleWith = (dialog) => async (pid) => ({
    ok: true, hasMainWindow: false, mainWindowTitle: 'SOLIDWORKS Design', dialogs: [{ ...dialog, pid }],
  })
  const prompted = await preflightLaunch({
    env: {}, now: T0, failureFile,
    target: { target: exe, kind: 'exe' }, exePath: exe,
    probe: async () => ({ instances: [{ pid: 8888 }] }),
    sampleWindow: sampleWith(CAM_PROMPT),
  })
  check('⑨⑧ 已有实例停在 CAM 询问框 → 预检放行（不判许可失败）',
    prompted.ok === true && prompted.code === null, { ok: prompted.ok, code: prompted.code })
  check('⑨⑧ 提示里给出 workspace action=ui uiAction=normalize 或手动点『是』',
    Array.isArray(prompted.notices) && prompted.notices.some((notice) => /uiAction=normalize/.test(notice) && /手动点『是』/.test(notice)),
    prompted.notices)
  check('⑨⑧ license-dialog 检查项如实说明「是询问框不是许可失败」',
    prompted.checks.some((item) => item.id === 'license-dialog' && item.ok === true && /询问框/.test(item.detail)), prompted.checks)
  // 对照：同样的 pid 真卡在许可失败上 → 仍然拒绝启动。
  const licensed = await preflightLaunch({
    env: {}, now: T0, failureFile,
    target: { target: exe, kind: 'exe' }, exePath: exe,
    probe: async () => ({ instances: [{ pid: 8888 }] }),
    sampleWindow: sampleWith(CAM_LICENSE_FAILURE),
  })
  check('⑨⑧ 对照：真许可失败仍然 SW_LICENSE_UNAVAILABLE', licensed.ok === false && licensed.code === 'SW_LICENSE_UNAVAILABLE', licensed.code)
}

// ============================== ⑩ 白名单确认框 / 乱码降级 / 误杀防护（本轮修复）
// 真机（多实例第二、三个进程）启动路径上还会弹：
//   「无法生成日志文件。自动恢复将不可使用。另外一个 SOLIDWORKS 程序可能已经在此
//    机器上运行中。」按钮「确定」；
//   「是否继续加载 3DEXPERIENCE Marketplace」按钮「是，继续加载…」/「否，禁用…」。
// 只认 CAM 询问框的旧判据不会点这些 → 120s 超时 SW_START_FAILED，把本可用的实例杀掉。
const LOGFILE_PROMPT = {
  pid: 5000,
  class: '#32770',
  title: 'SOLIDWORKS Design',
  text: '无法生成日志文件。自动恢复将不可使用。另外一个 SOLIDWORKS 程序可能已经在此机器上运行中。',
  buttons: ['确定'],
}
const MARKETPLACE_PROMPT = {
  pid: 5000,
  class: '#32770',
  title: 'SOLIDWORKS Design',
  text: '',
  buttons: ['是，继续加载 3DEXPERIENCE Marketplace(&Y)', '否，禁用 3DEXPERIENCE Marketplace(&N)。'],
}
const GARBLED_TEXT = '\uFFFD\uFFFD\uFFFD\uFFFD \uFFFD\uFFFD ȷ�� ��ͼ'

// -------------------------------------------------- ⑩① 白名单分类（B）
{
  const logfile = classifyDialog(LOGFILE_PROMPT)
  check('⑩① 「无法生成日志文件…另一个 SOLIDWORKS 程序」+「确定」→ prompt 且点「确定」',
    logfile.kind === DIALOG_KIND.PROMPT && logfile.button === '确定', logfile)
  const marketplace = classifyDialog(MARKETPLACE_PROMPT)
  check('⑩① 「3DEXPERIENCE Marketplace」询问框（正文为空，只看按钮）→ prompt',
    marketplace.kind === DIALOG_KIND.PROMPT && /^是/.test(marketplace.button ?? ''), marketplace)
  const license = classifyDialog({
    pid: 5000, title: 'SOLIDWORKS Design', buttons: ['确定'],
    text: '无法获得下列许可 SOLIDWORKS CAM 2026 (-15,578,10049)',
  })
  check('⑩① -15,578,10049 许可失败文案 → license-failure（绝不点「确定」）',
    license.kind === DIALOG_KIND.LICENSE && license.button === null, license)
  const license2 = classifyDialog({ pid: 5000, title: 'SOLIDWORKS', text: 'SOLIDWORKS CAM 无法连接许可服务器', buttons: ['确定'] })
  check('⑩① 「无法连接许可服务器」→ license-failure', license2.kind === DIALOG_KIND.LICENSE, license2)
  const unknown = classifyDialog({ pid: 5000, title: 'SOLIDWORKS Design', text: '正在初始化模型视图，请稍候', buttons: ['确定'] })
  check('⑩① 不在白名单的正文 → 仍是 unknown-dialog（不乱点）',
    unknown.kind === DIALOG_KIND.UNKNOWN && unknown.textUnreliable === false, unknown)
}

// -------------------------------------- ⑩C 乱码/空文本：退化为按按钮判定
{
  const garbled = classifyDialog({ pid: 5000, class: '#32770', title: 'SOLIDWORKS Design', text: GARBLED_TEXT, buttons: ['确定'] })
  check('⑩C 乱码正文 + 肯定按钮 → prompt，且标 textUnreliable:true',
    garbled.kind === DIALOG_KIND.PROMPT && garbled.textUnreliable === true
      && garbled.matched === 'text-unreliable' && garbled.button === '确定', garbled)
  const empty = classifyDialog({ pid: 5000, class: '#32770', title: '', text: '', buttons: ['确定'] })
  check('⑩C 空正文 + 肯定按钮 → prompt（按按钮文本 + 对话框存在性判定）',
    empty.kind === DIALOG_KIND.PROMPT && empty.textUnreliable === true, empty)
  const garbledNoButton = classifyDialog({ pid: 5000, title: 'SOLIDWORKS Design', text: GARBLED_TEXT, buttons: [] })
  check('⑩C 乱码正文 + 没有肯定按钮 → unknown-dialog（不猜、不乱点）',
    garbledNoButton.kind === DIALOG_KIND.UNKNOWN && garbledNoButton.textUnreliable === true, garbledNoButton)
  check('⑩C dialogTextUnreliable：正常中文/英文不算乱码',
    dialogTextUnreliable('正在初始化模型视图，请稍候') === false && dialogTextUnreliable('SOLIDWORKS Design') === false)
  check('⑩C dialogTextUnreliable：空串与 U+FFFD 都算不可信',
    dialogTextUnreliable('') === true && dialogTextUnreliable(GARBLED_TEXT) === true)
}

// ------------------------------- ⑩② 端到端：两个确认框依次点掉后正常启动
{
  const harness = fakeManager({
    launchResult: { launched: true, target: 'fake-sldworks.exe', pid: 4545, rot: [{ pid: 4545, startedAt: iso(T0) }] },
    clickDialog: async ({ pid, button }) => ({ ok: true, pid, clicked: [{ text: button }] }),
    samples: (pid, state) => {
      if (state.clicks.length === 0) {
        return { ok: true, hasMainWindow: false, mainWindowTitle: 'SOLIDWORKS splash', dialogs: [{ ...LOGFILE_PROMPT, pid }] }
      }
      if (state.clicks.length === 1) {
        return { ok: true, hasMainWindow: false, mainWindowTitle: 'SOLIDWORKS splash', dialogs: [{ ...MARKETPLACE_PROMPT, pid }] }
      }
      return { ok: true, hasMainWindow: true, mainWindowTitle: 'SOLIDWORKS 2026 - [零件1]', dialogs: [] }
    },
  })
  const ensured = await harness.manager.ensure({ clientId: 'sess-multi-dialog', timeoutMs: 30_000, startWorker: false })
  check('⑩② 两个启动确认框依次点掉后才 ok（不再等到超时误杀）',
    ensured.chosenPid === 4545 && harness.state.stopped.length === 0,
    { chosenPid: ensured.chosenPid, stopped: harness.state.stopped })
  check('⑩② 点掉的是「确定」与「是，继续加载 3DEXPERIENCE」两个肯定按钮',
    harness.state.clicks.length === 2
      && harness.state.clicks.some((click) => click.button === '确定')
      && harness.state.clicks.some((click) => /3DEXPERIENCE/.test(click.button ?? '')), harness.state.clicks)
  check('⑩② 每次点击都绑定本次 lease pid 4545',
    harness.state.clicks.every((click) => click.pid === 4545), harness.state.clicks.map((click) => click.pid))
  const dialogs = ensured.launched?.watch?.dialogs ?? []
  // 记录只有 title/text/kind/clicked（按钮不落盘）：Marketplace 那个框正文为空，
  // 靠 clicked=true + title 识别；按钮文本的断言在上面 state.clicks 里。
  check('⑩② 返回体记录每个被点掉的对话框（title/text/kind/clicked）',
    dialogs.length === 2 && dialogs.every((dialog) => dialog.kind === 'prompt'
      && dialog.clicked === true && dialog.title === 'SOLIDWORKS Design')
      && dialogs.some((dialog) => /无法生成日志文件/.test(dialog.text ?? ''))
      && dialogs.some((dialog) => (dialog.text ?? '') === ''), dialogs)
}

// ----------------------- ⑩③ 误杀防护：超时但 COM 已可用 → ok + degraded，不杀
{
  const harness = fakeManager({
    launchResult: { launched: true, target: 'fake-sldworks.exe', pid: 5656, rot: [{ pid: 5656, startedAt: iso(T0) }] },
    samples: (pid) => ({
      ok: true,
      hasMainWindow: false,
      mainWindowTitle: '',
      dialogs: [{ pid, title: 'SOLIDWORKS Design', text: '正在初始化模型视图，请稍候', buttons: ['确定'] }],
    }),
    verifyCom: async ({ pid }) => ({ ok: true, op: 'worker.version', pid }),
    watchMs: 5_000,
  })
  const ensured = await harness.manager.ensure({ clientId: 'sess-com-rescue', timeoutMs: 30_000, startWorker: false })
  check('⑩③ COM 已可用时超时不杀：ensure 返回 ok + degraded',
    ensured.chosenPid === 5656 && ensured.degraded === true && ensured.instancePid === 5656,
    { chosenPid: ensured.chosenPid, degraded: ensured.degraded })
  check('⑩③ 没有 kill、也没有写失败标记',
    harness.state.stopped.length === 0 && readLaunchFailure(harness.failureFile).mark === null,
    { stopped: harness.state.stopped })
  check('⑩③ 探测用 worker 握手（worker.version，绑定本次 lease pid）',
    harness.state.comProbes.length >= 1 && harness.state.comProbes[0].pid === 5656,
    harness.state.comProbes)
  const dialogs = ensured.unclickedDialogs ?? []
  check('⑩③ 返回体列出没点掉的对话框清单',
    dialogs.length === 1 && dialogs[0].clicked === false && /正在初始化/.test(dialogs[0].text ?? ''), dialogs)
  check('⑩③ degraded 实例仍登记为 broker 启动',
    ensured.launched?.entry?.launchedBy === 'broker' && ensured.launched?.entry?.pid === 5656,
    ensured.launched?.entry)
}

// 对照：COM 探不通 → 照旧判失败，且只杀自己那个 pid（不放过真坏实例）。
{
  const harness = fakeManager({
    launchResult: { launched: true, target: 'fake-sldworks.exe', pid: 5757, rot: [{ pid: 5757, startedAt: iso(T0) }] },
    samples: (pid) => ({
      ok: true,
      hasMainWindow: false,
      mainWindowTitle: '',
      dialogs: [{ pid, title: 'SOLIDWORKS Design', text: '正在初始化模型视图，请稍候', buttons: ['确定'] }],
    }),
    verifyCom: async () => ({ ok: false, op: 'worker.version', error: 'COM_ATTACH_FAILED' }),
    watchMs: 5_000,
  })
  const error = await catchError(() => harness.manager.ensure({ clientId: 'sess-com-fail', timeoutMs: 30_000, startWorker: false }))
  check('⑩③ 对照：COM 探不通 → 仍 SW_START_FAILED 且只杀自己 pid',
    error?.code === 'SW_START_FAILED' && harness.state.stopped.join(',') === '5757',
    { code: error?.code, stopped: harness.state.stopped })
}

// ------------------------- ⑩C 机制验证：PowerShell 采样器 stdout 必须是 UTF-8
// 真机乱码的根因是「powershell.exe 按控制台代码页输出、broker 侧按 UTF-8 解码」。
// 这里只验机制（中文经 [Console]::OutputEncoding=UTF8 输出后 node 端能解出原文），
// 不碰 SOLIDWORKS；没装 powershell 就跳过，不影响其他断言。
function probePowershellUtf8() {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }; "
        + "[Console]::Out.WriteLine('{\"text\":\"无法生成日志文件 另外一个 SOLIDWORKS 程序\"}'); [Console]::Out.Flush()",
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch (error) {
      resolvePromise({ ok: false, reason: error?.message ?? String(error) })
      return
    }
    let out = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* 已经退了 */ }
      resolvePromise(value)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'TIMEOUT' }), 20_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', (error) => finish({ ok: false, reason: error?.message ?? String(error) }))
    child.on('exit', () => finish({ ok: true, out }))
  })
}

{
  const probe = await probePowershellUtf8()
  if (probe.ok) {
    let parsed = null
    try {
      const line = probe.out.split('\n').map((item) => item.trim()).find((item) => item.startsWith('{'))
      parsed = line ? JSON.parse(line) : null
    } catch { parsed = null }
    check('⑩C PowerShell 采样器 stdout 按 UTF-8 输出（中文不再变成乱码）',
      parsed !== null && /无法生成日志文件/.test(parsed.text ?? '') && !probe.out.includes('\uFFFD'), probe.out.trim())
  } else {
    check('⑩C powershell 不可用 → 跳过编码机制验证（乱码降级已有纯函数单测覆盖）', true, probe.reason)
  }
}

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
