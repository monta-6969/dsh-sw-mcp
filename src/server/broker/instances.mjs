// SOLIDWORKS 实例登记表与生命周期管理。
//
// 这张表回答两个问题，而这两件事以前都没人管：
//   1. 这个 pid「是谁」起的？broker / test / 用户自己。用户手开的实例永远不回收。
//   2. 这个 pid 现在忙不忙、有没有会话绑着、该不该收？空闲够久就 cleanup + quit，
//      15 秒还不退才按 pid 强杀——强杀只对登记表里的 pid 生效，绝不按进程名全杀。
//
// 落盘位置：%LOCALAPPDATA%\sw-mcp\instances.json（测试可用 SW_MCP_INSTANCES_FILE 覆盖）。
// 每次写都是「读最新 → 改 → 临时文件 → rename」，避免半截 JSON 让下一个进程起不来。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  canAssign,
  chooseInstance,
  instancePolicy,
  isServiceInstance,
  isUserInstance,
  maxInstancesFor,
} from './affinity.mjs'

// R12：维护间隔从 60 秒抬到 10 分钟。60 秒的理由本来是「尽快回收空闲实例」，
// 但每轮会起探针进程去问 ROT（用户实例也在 ROT 里），代价是每分钟 2 个 SwBridge.exe；
// 而真正的回收触发点是会话断开（brokerd 的 client-disconnect reap）和启动整理，
// 不靠这个心跳。10 分钟只影响「长时间没人用的实例多久被发现」，不影响响应。
export const MAINTENANCE_INTERVAL_MS = 10 * 60_000
export const DEFAULT_REAP_GRACE_MS = 60_000
export const DEFAULT_STALE_TEST_MS = 10 * 60_000
export const DEFAULT_QUIT_GRACE_MS = 15_000
export const LAUNCHED_BY = ['broker', 'test', 'user']

// 自动启动守卫（预检 / 盯守 / 收尾）的默认值。以前 broker 起了 SLDWORKS.exe 就
// 不管了，实例卡在 splash 或许可弹窗上能挂几个小时；这套数值就是那次的教训。
export const DEFAULT_LAUNCH_WATCH_MS = 120_000
export const DEFAULT_LAUNCH_SAMPLE_MS = 2_000
export const DEFAULT_LAUNCH_COOLDOWN_MS = 10 * 60_000
export const LAUNCH_FAILURE_VERSION = 1
export const LAUNCH_GUARD_CODES = Object.freeze([
  'SW_LICENSE_UNAVAILABLE',
  'SW_START_FAILED',
  'SW_LAUNCH_COOLDOWN',
  'SW_LAUNCH_TARGET_MISSING',
])
// 许可弹窗判据：标题/文本命中「许可|license」且命中「CAM|cannot connect|无法连接|-15,」
// 才算许可弹窗；单独出现 license 字样的普通对话框不算，避免误杀。
export const LICENSE_HINT_RE = /许可|license/i
export const LICENSE_CAUSE_RE = /CAM|cannot connect|无法连接|-15,/i
export const SPLASH_TITLE_RE = /splash/i

// ---------------------------------------------------------- 模态对话框分类
//
// 真机实测（多实例）：SW 启动路径上会弹好几种 #32770 确认框，它们都不是失败：
//   a) 「是否继续加载 SOLIDWORKS CAM 2026」按钮「是，继续加载…」/「否，禁用…」；
//   b) 第二个实例的「无法生成日志文件。自动恢复将不可使用。另外一个 SOLIDWORKS
//      程序可能已经在此机器上运行中。」按钮「确定」；
//   c) 「是否继续加载 3DEXPERIENCE Marketplace」按钮「是，继续加载…」/「否，禁用…」；
//   d) 许可协议/重新激活这类只要求「是/确定/接受」的确认。
// 上一轮的判据只认 CAM 询问框，于是 b/c 一路无人应答 → 120s 超时 SW_START_FAILED，
// 还把一个 COM 已经能正常 build 的实例 kill 了。所以分类改成白名单式：
//   prompt          —— 正文命中白名单且有肯定按钮 → 自动点掉后继续等主窗口；
//   license-failure —— 只认真实 -15 许可失败信号，立刻收尾（绝不点）；
//   unknown-dialog  —— 其他 #32770，继续等；超时时先做 COM 探测再决定杀不杀。
export const DIALOG_KIND = Object.freeze({
  PROMPT: 'prompt',
  LICENSE: 'license-failure',
  UNKNOWN: 'unknown-dialog',
})
export const DIALOG_KINDS = Object.freeze([DIALOG_KIND.PROMPT, DIALOG_KIND.LICENSE, DIALOG_KIND.UNKNOWN])
// 询问框正文判据（白名单）：拆成几条小正则（别拼一条超长正则），逐条可单测。
// 只有命中这里的正文才允许自动应答；不在白名单里的对话框宁可继续等也不乱点。
export const PROMPT_BODY_RES = Object.freeze([
  // 2026-11-16 真机：SW 2026 冷启动被这个弹窗挡住，broker 判 unknown-dialog 等了
  // 120 秒后把进程 kill 掉（launch-failure.json: killed=true, reason=splash-stuck）。
  //
  // 文案：标题「SOLIDWORKS Design」/ 正文「工具栏信息不一致。将使用默认工具栏设定。」
  //      / 唯一按钮「确定」（#32770 + DirectUIHWND，Button 类，CtrlId=0 不是 IDOK）。
  //
  // 为什么可以自动点（安全论证，经人工批准）：
  //   · 单一「确定」按钮，没有「是/否」「保存/不保存」这类二选一，点了不会替用户做选择；
  //   · 正文是陈述性告知：工具栏布局配置与当前版本/SKU 不匹配，将回退到默认布局；
  //   · 只影响界面工具栏布局（下次启动会按默认重建），不触碰任何文档/模型/文件数据；
  //   · 不含许可、路径、保存、覆盖、删除字样，不属于 LICENSE_FAILURE 或危险操作。
  // 正则只用「工具栏信息不一致」这一精确片段，**故意不用 /工具栏/** ——
  // 免得命中「工具栏未保存」「工具栏文件损坏」之类可能另有含义的提示。
  /工具栏信息不一致/,
  /继续加载/,
  /3DEXPERIENCE/i,
  /Marketplace/i,
  /无法生成日志文件/,
  // 真机文案是「另**外**一个 SOLIDWORKS 程序可能已经在此机器上运行中。」——中间是
  // 汉字「外」，不是空格。原来的 /另一个\s*SOLIDWORKS\s*程序/ 匹配不到它（实测 False），
  // 之前能工作只是因为同一段文案里还有「无法生成日志文件」，被上面那条捞住了。
  // 那是脆弱的巧合：某版本若只剩这一句，就会静默退化成 unknown-dialog → 等 120 秒 → 杀进程。
  // 用 另[外]?一个 同时兼容「另一个」「另外一个」。
  /另[外]?一个\s*SOLIDWORKS\s*程序/,
  /重新激活/,
  /许可协议/,
  /accept/i,
  /是否[^。！？!?]{0,24}加载/,
  /SOLIDWORKS\s*CAM\s*20\d\d/i,
])
// 询问框的肯定按钮判据：是 / 确定 / 继续 / OK / Yes / Accept。
// 「否，禁用…」「取消」「关闭」「No」一律不算（negative 正则单独列出来）。
export const PROMPT_BUTTON_RE = /是|yes|确定|继续|ok\b|accept/i
export const PROMPT_BUTTON_NEGATIVE_RE = /^(?:否|no\b|cancel|取消|关闭)/i
// 许可失败正文判据：只认具体失败信号（真实 -15 许可错误 / 连不上许可服务器）。
// 普通带 CAM 字样的对话框、启动确认框都不算——不然第二个实例的「无法生成日志文件…」
// 会被误杀。注意真机文案是「SOLIDWORKS CAM 无法连接许可服务器」，不是「无法连接到服务器」，
// 所以这里单独留一条「无法连接…许可」。
export const LICENSE_FAILURE_RES = Object.freeze([
  /无法获得下列许可/,
  /cannot\s*connect/i,
  /无法连接到服务器/,
  /无法连接[^。！？!?]{0,12}许可/,
  /-\s*15\s*,/,
  /(?<![\d-])-?15\s*,\s*\d+/, // 15,578,10049 / -15,10,0,0
])
// 自动应答：同一个询问框最多点 5 次，两次之间至少 2 秒（每次重新枚举窗口，不缓存 hwnd）。
//
// 为什么是「重试式」而不是「点一次就判失败」（2026-11-16 实测）：
//   BM_CLICK 是 SendMessage 到**目标进程的消息队列**，要等它的 UI 线程自己处理。
//   SW 冷启动时 UI 线程正忙着初始化，一次点击可能迟迟不被处理甚至被吃掉。
//   实测：同进程内的 TaskDialog 60ms 就消失；跨进程点 SW 的同类弹窗，1.8s 复查
//   才看到消失（400ms 复查会误判成「点了没反应」）。
//   所以这里保留「最多 5 次、间隔 ≥2s」的重试语义，别把它改成一次就放弃。
export const DEFAULT_LAUNCH_CLICK_MAX = 5
export const DEFAULT_LAUNCH_CLICK_GAP_MS = 2_000

// 点按钮的方式必须是「按 Win32 类名找 Button 子控件 + SendMessage(BM_CLICK)」，
// **不要改成 UI Automation 的 Invoke**：
//   实测那个「确定」按钮在 UIA 里暴露成 ControlType.Pane 而不是 Button
//   （comctl32 TaskDialog 的 DirectUIHWND 自绘），按 ControlType.Button 去找会找不到；
//   它的 Win32 子窗口类名却是标准的 "Button"、文本「确定」，GetWindowTextW 能读出来。
//   同理不要按 IDOK(1) 去 PostMessage(WM_COMMAND)：该按钮的 GetDlgCtrlID 是 0，不是 1。

export class InstanceError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'InstanceError'
    this.code = code
    this.details = details
  }
}

function safeIso(value) {
  if (!value) return null
  const time = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function envNumber(env, name, fallback) {
  const raw = Number(env?.[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

export function defaultInstancesFile(env = process.env) {
  if (env.SW_MCP_INSTANCES_FILE) return env.SW_MCP_INSTANCES_FILE
  const root = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'sw-mcp') : join(homedir(), 'AppData', 'Local', 'sw-mcp')
  return join(root, 'instances.json')
}

/** 一条登记记录的规范形态；pid 不可用的记录直接丢掉（坏数据不该让 broker 崩）。 */
export function normalizeEntry(entry) {
  const pid = Number(entry?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return null
  const launchedBy = LAUNCHED_BY.includes(entry?.launchedBy) ? entry.launchedBy : 'broker'
  const ownerClients = Array.isArray(entry?.ownerClients)
    ? [...new Set(entry.ownerClients.map(String))]
    : []
  return {
    pid,
    startedAt: safeIso(entry?.startedAt),
    launchedBy,
    tag: entry?.tag ? String(entry.tag) : null,
    ownerClients,
    lastSeen: safeIso(entry?.lastSeen) ?? new Date().toISOString(),
    lastUsedAt: safeIso(entry?.lastUsedAt) ?? safeIso(entry?.lastSeen) ?? new Date().toISOString(),
    workerStarted: entry?.workerStarted === true,
  }
}

/** 读登记表。文件不存在/坏掉都当成空表——它只是缓存，不能成为启动阻塞项。 */
export function readInstances(file = defaultInstancesFile(), { now = Date.now() } = {}) {
  let parsed = null
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch { parsed = null }
  const raw = Array.isArray(parsed) ? parsed : parsed?.instances
  const instances = (Array.isArray(raw) ? raw : []).map(normalizeEntry).filter(Boolean)
  return {
    version: 1,
    updatedAt: safeIso(parsed?.updatedAt) ?? null,
    now: new Date(now).toISOString(),
    instances,
  }
}

/** 原子写：临时文件 + rename；rename 失败（占用）时清掉临时文件再抛。 */
export function writeInstances(file = defaultInstancesFile(), entries = [], { now = Date.now() } = {}) {
  const state = {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    instances: entries.map(normalizeEntry).filter(Boolean),
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 临时文件清不掉就先留着 */ }
    throw error
  }
  return state
}

/** 读-改-写。mutate 可以原地改数组，也可以返回新数组。 */
export function updateInstances(file = defaultInstancesFile(), mutate, { now = Date.now() } = {}) {
  const state = readInstances(file, { now })
  const next = mutate(state.instances.slice()) ?? state.instances
  return writeInstances(file, next, { now })
}

/** 同 pid 合并；pid 被复用（startedAt 变了）时整条替换，别把旧会话的绑定带过来。 */
export function upsertEntry(entries, entry) {
  const normalized = normalizeEntry(entry)
  if (!normalized) return entries
  const index = entries.findIndex((item) => item.pid === normalized.pid)
  if (index < 0) {
    entries.push(normalized)
    return entries
  }
  const existing = entries[index]
  const reused = Boolean(existing.startedAt && normalized.startedAt && existing.startedAt !== normalized.startedAt)
  if (reused) {
    entries[index] = normalized
    return entries
  }
  entries[index] = {
    ...existing,
    ...normalized,
    startedAt: normalized.startedAt ?? existing.startedAt,
    ownerClients: normalized.ownerClients.length > 0 ? normalized.ownerClients : existing.ownerClients,
  }
  return entries
}

export function removeEntry(entries, pid) {
  const target = Number(pid)
  return entries.filter((entry) => entry.pid !== target)
}

// ============================================================ 启动守卫
//
// 「保留自动启 SW，但加许可预检」：允许 broker 自动起 SOLIDWORKS，但一次启动要
// 走完三段，任何一段判定失败都不会留下卡住的实例：
//   1 预检 preflightLaunch()：目标 exe 可执行 / 没有新鲜失败标记（10 分钟冷却）/
//     已有实例没卡在许可弹窗上 —— 不合格就直接返回 SW_LAUNCH_COOLDOWN 等错误；
//   2 盯守：启动后每 2 秒采样 ROT、目标 pid 的顶层窗口、#32770 模态对话框，
//     120 秒内没就绪就按 SW_START_FAILED 收尾；
//   3 收尾：只 Stop-Process 本次 lease 里的 pid → 清 instances.json → 写失败标记
//     %LOCALAPPDATA%\sw-mcp\state\launch-failure.json → ensure 抛结构化错误。
// 判定本身全是纯函数（decideLaunchOutcome / licenseDialogHit），离线可测。

/** 失败标记落盘位置：state 目录单独一层，不和 instances.json 混。 */
export function defaultLaunchFailureFile(env = process.env) {
  if (env.SW_MCP_LAUNCH_FAILURE_FILE) return env.SW_MCP_LAUNCH_FAILURE_FILE
  const root = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'sw-mcp') : join(homedir(), 'AppData', 'Local', 'sw-mcp')
  return join(root, 'state', 'launch-failure.json')
}

function clipText(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * 许可弹窗判据（纯函数）：标题/文本同时命中「许可|license」与
 * 「CAM|cannot connect|无法连接|-15,」才返回命中的文本，否则 null。
 */
export function licenseDialogHit({ title = '', text = '' } = {}) {
  const blob = `${title ?? ''}\n${text ?? ''}`.replace(/\s+/g, ' ').trim()
  if (!blob) return null
  if (!LICENSE_HINT_RE.test(blob)) return null
  if (!LICENSE_CAUSE_RE.test(blob)) return null
  return clipText(blob, 400)
}

export function isLicenseDialog(dialog) {
  return licenseDialogHit(dialog) !== null
}

/**
 * 全角转半角 + 合并空白：系统文案里「（－１５，…）」和「(-15,…)」是一回事，
 * 「ＳＯＬＩＤＷＯＲＫＳ　ＣＡＭ　２０２６」和「SOLIDWORKS CAM 2026」也是。
 */
export function normalizeDialogText(value) {
  return String(value ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\u3000\u00A0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 采样来的对话框文本是否不可信（乱码/空）。
 *
 * 真机踩过：采样器是 PowerShell 子进程，stdout 按控制台代码页（中文机器是 936）
 * 输出，broker 侧按 UTF-8 解码 → 采到的正文全是「���� ��」「ȷ��」。这种文本不能
 * 交给正文正则分类（CAM 询问框都可能匹配不上），只能退化为「按钮文本 + 对话框
 * 存在性」判定，并在日志/返回体里标 textUnreliable:true。
 *
 * 判据：空串、含 U+FFFD 替换符、或非中日韩的可疑扩展字符占比过高（真乱码特征）。
 * 正常中文/英文/全角文案不会被误判。
 */
export function dialogTextUnreliable(...values) {
  const blob = normalizeDialogText(values.filter((value) => value !== null && value !== undefined).join(' '))
  if (!blob) return true
  if (blob.includes('\uFFFD')) return true
  const chars = [...blob]
  const suspicious = chars.filter((ch) => /[\u00C0-\u00FF\u0100-\u06FF]/.test(ch)).length
  return suspicious / chars.length > 0.4
}

/**
 * 从按钮清单里挑「是/继续/确定」那一个。采样器给了按钮清单就用清单（精确，「否，
 * 禁用…」「取消」「关闭」被排除）；没给清单时才退回正文分段（正文里也带着子控件
 * 文本），且排除「是否…」这种问句片段——它不是按钮。
 */
function pickPromptButton(buttons, text, { explicitOnly = false } = {}) {
  const acceptable = (item) => PROMPT_BUTTON_RE.test(item) && !PROMPT_BUTTON_NEGATIVE_RE.test(item)
  const explicit = buttons.find(acceptable)
  if (explicit) return explicit
  if (explicitOnly) return null
  const segments = String(text ?? '')
    .split(/[，,；;|。]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^是否/.test(part))
  const lead = segments.find((part) => /^(?:是|yes|继续|确定)/i.test(part))
  if (lead) return lead
  return segments.find(acceptable) ?? null
}

/**
 * 分类一个 #32770 对话框（纯函数，可单测）：
 *   prompt / license-failure / unknown-dialog。
 *
 * 顺序：① 文本不可信 → 只看按钮；② 真实许可失败信号 → 判失败；③ 白名单正文 +
 * 肯定按钮 → 询问框；④ 其余 → unknown-dialog（继续等，超时时先做 COM 探测）。
 *
 * @returns {{kind:string,title:string,text:string,buttons:string[],
 *   button:string|null,matched:string|null,textUnreliable:boolean}}
 */
export function classifyDialog(dialog = {}) {
  const title = normalizeDialogText(dialog?.title)
  const text = normalizeDialogText(dialog?.text)
  const hasButtonList = Array.isArray(dialog?.buttons)
  const buttons = (hasButtonList ? dialog.buttons : [])
    .map((item) => normalizeDialogText(item))
    .filter(Boolean)
  const blob = `${title} ${text}`.trim()
  const textUnreliable = dialogTextUnreliable(title, text)
  const build = (kind, extra = {}) => ({ kind, title, text, buttons, button: null, matched: null, textUnreliable, ...extra })
  // ① 文本不可信（乱码/空）：正文正则不可用 → 退化为「按钮文本 + 对话框存在性」。
  //    只要这个 #32770 上有一个肯定按钮（是/确定/继续），就按可自动应答的确认框处理。
  if (textUnreliable) {
    const button = pickPromptButton(buttons, text, { explicitOnly: hasButtonList })
    if (button) return build(DIALOG_KIND.PROMPT, { matched: 'text-unreliable', button })
    return build(DIALOG_KIND.UNKNOWN)
  }
  // ② 许可失败：只认具体失败信号（不在这里的「许可协议」确认框不算失败）。
  const licenseMatch = LICENSE_FAILURE_RES.find((re) => re.test(blob))
  if (licenseMatch) return build(DIALOG_KIND.LICENSE, { matched: String(licenseMatch) })
  // ③ 白名单询问框：正文/标题/按钮文本命中白名单，且存在肯定按钮（两个条件都要）。
  //    真机采样会碰到正文为空、只有按钮文本的确认框（例如 3DEXPERIENCE Marketplace），
  //    所以按钮文本也进白名单 haystack。
  const haystack = `${blob} ${buttons.join(' ')}`.trim()
  const promptMatch = PROMPT_BODY_RES.find((re) => re.test(haystack))
  if (promptMatch) {
    const button = pickPromptButton(buttons, text, { explicitOnly: hasButtonList })
    if (button) return build(DIALOG_KIND.PROMPT, { matched: String(promptMatch), button })
  }
  // ④ 都不匹配 → unknown-dialog（继续等；超时前先探 COM，见 #rescueByCom）。
  return build(DIALOG_KIND.UNKNOWN)
}

export function isPromptDialog(dialog) {
  return classifyDialog(dialog).kind === DIALOG_KIND.PROMPT
}

export function isLicenseFailureDialog(dialog) {
  return classifyDialog(dialog).kind === DIALOG_KIND.LICENSE
}

/** 盯守期间同一对话框的去重键：pid + 类别 + 标题 + 正文。 */
function dialogWatchKey(dialog) {
  return `${Number(dialog?.pid) || 0}|${dialog?.kind ?? DIALOG_KIND.UNKNOWN}|${normalizeDialogText(dialog?.title).slice(0, 120)}|${normalizeDialogText(dialog?.text).slice(0, 240)}`
}

/** 记住盯守期间见过的对话框（含已自动应答的），最多留 10 条防止异常窗口刷爆内存。 */
function rememberDialogs(seen, dialogs) {
  for (const dialog of Array.isArray(dialogs) ? dialogs : []) {
    if (seen.size >= 10 && !seen.has(dialogWatchKey(dialog))) continue
    const key = dialogWatchKey(dialog)
    const record = seen.get(key) ?? {
      pid: Number(dialog?.pid) || 0,
      title: String(dialog?.title ?? ''),
      text: String(dialog?.text ?? ''),
      kind: dialog?.kind ?? DIALOG_KIND.UNKNOWN,
      clicked: false,
      textUnreliable: dialog?.textUnreliable === true,
    }
    if (dialog?.clicked === true) record.clicked = true
    if (dialog?.textUnreliable === true) record.textUnreliable = true
    seen.set(key, record)
  }
  return seen
}

/** 收敛成 {title,text,kind,clicked,textUnreliable}：ensure 返回体与失败标记都用这一份。 */
function summarizeDialogs(seen) {
  return [...seen.values()].map((dialog) => ({
    pid: dialog.pid,
    title: clipText(dialog.title, 200),
    text: clipText(dialog.text, 400),
    kind: dialog.kind,
    clicked: dialog.clicked === true,
    textUnreliable: dialog.textUnreliable === true,
  }))
}

/**
 * 许可/询问/其他分类后的对话框判定（纯函数）。见 classifyDialog。
 * @param {object} dialog {pid,title,text,buttons?}
 */
export function dialogKindOf(dialog) {
  return classifyDialog(dialog).kind
}


/** 失败标记/返回体里的弹窗记录：只留 title/text/kind/clicked/textUnreliable，避免把 hwnd 等写进磁盘。 */
function normalizeDialogRecord(value) {
  if (!value || typeof value !== 'object') return null
  return {
    pid: Number(value.pid) || 0,
    title: clipText(value.title, 200),
    text: clipText(value.text, 400),
    kind: DIALOG_KINDS.includes(value.kind) ? value.kind : DIALOG_KIND.UNKNOWN,
    clicked: value.clicked === true,
    textUnreliable: value.textUnreliable === true,
  }
}

/** lease 允许 {pid} 也允许 {pids:[...]}; 判定只认这组 pid 的弹窗。 */
function leasePidsOf(lease) {
  const pids = new Set()
  const primary = Number(lease?.pid)
  if (Number.isInteger(primary) && primary > 0) pids.add(primary)
  for (const value of Array.isArray(lease?.pids) ? lease.pids : []) {
    const pid = Number(value)
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return pids
}

/**
 * 启动盯守的判定核心（纯函数，不做 IO）：
 *
 * @param {object} input
 * @param {number} [input.elapsedMs] 已盯守时长
 * @param {boolean} [input.hasMainWindow] 目标 pid 是否已有可见顶层窗口
 * @param {string} [input.mainWindowTitle] 主窗口标题（splash 也算有窗口）
 * @param {Array<{pid:number,title?:string,text?:string}>} [input.dialogs] #32770 模态对话框
 * @param {boolean} [input.rotFound] ROT 里是否出现本次 lease 的 pid
 * @param {{pid?:number,pids?:number[]}} [input.lease] 本次启动的 pid（只认这组）
 * @param {boolean} [input.windowKnown] 窗口探测是否可用；false 时退回「ROT 出现即成功」
 * @param {number} [input.watchMs] 盯守上限，默认 120 秒
 * @param {boolean} [input.autoAnswerFailed] 询问框自动应答是否已经用尽重试
 * @returns {{action:'wait'|'ok'|'kill', code:string|null, reason:string,
 *   pid:number, elapsedMs:number, leasePids:number[], windowTitle:string|null,
 *   dialogText:string|null, hasMainWindow:boolean, dialogs:Array, textUnreliable:boolean,
 *   promptDialog:object|null, autoAnswer:object|null, autoClickFailed:boolean}}
 */
export function decideLaunchOutcome({
  elapsedMs = 0,
  hasMainWindow = false,
  mainWindowTitle = '',
  dialogs = [],
  rotFound = false,
  lease = null,
  windowKnown = true,
  watchMs = DEFAULT_LAUNCH_WATCH_MS,
  autoAnswerFailed = false,
} = {}) {
  const leasePids = leasePidsOf(lease)
  const elapsed = Math.max(0, Number(elapsedMs) || 0)
  const watch = Math.max(1, Number(watchMs) || DEFAULT_LAUNCH_WATCH_MS)
  const title = mainWindowTitle ? String(mainWindowTitle) : ''
  const observable = windowKnown !== false
  const primary = Number([...leasePids][0]) || 0
  // 只保留属于本次 lease 的弹窗：别家实例（用户自己开的、别的 broker 起的）的
  // 弹窗绝不能算到这次启动头上。
  const owned = []
  for (const dialog of Array.isArray(dialogs) ? dialogs : []) {
    const pid = Number(dialog?.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (leasePids.size > 0 && !leasePids.has(pid)) continue
    const classified = classifyDialog(dialog)
    owned.push({
      pid,
      title: String(dialog?.title ?? ''),
      text: String(dialog?.text ?? ''),
      class: String(dialog?.class ?? '#32770'),
      kind: classified.kind,
      buttons: classified.buttons,
      button: classified.button,
      matched: classified.matched,
      textUnreliable: classified.textUnreliable === true,
    })
  }
  const license = owned.find((dialog) => dialog.kind === DIALOG_KIND.LICENSE) ?? null
  const prompt = owned.find((dialog) => dialog.kind === DIALOG_KIND.PROMPT) ?? null
  const unknown = owned.filter((dialog) => dialog.kind === DIALOG_KIND.UNKNOWN)
  const base = {
    pid: license ? license.pid : (prompt ? prompt.pid : primary),
    elapsedMs: elapsed,
    leasePids: [...leasePids],
    windowTitle: title || null,
    dialogText: owned.length > 0 ? clipText(owned.map((dialog) => `${dialog.title} ${dialog.text}`).join(' | '), 400) : null,
    hasMainWindow: hasMainWindow === true,
    dialogs: owned,
    // 有对话框的正文是乱码：调用方据此知道「别信 dialogText，按 kind/button 看」。
    textUnreliable: owned.some((dialog) => dialog.textUnreliable === true),
    // 询问框不算失败：告诉调用方「点哪个按钮」，由盯守循环去 SendMessage BM_CLICK。
    promptDialog: prompt
      ? { pid: prompt.pid, title: prompt.title, text: clipText(prompt.text, 400), button: prompt.button, textUnreliable: prompt.textUnreliable === true }
      : null,
    autoAnswer: prompt
      ? { pid: prompt.pid, button: prompt.button, title: prompt.title, text: clipText(prompt.text, 400), textUnreliable: prompt.textUnreliable === true }
      : null,
    autoClickFailed: autoAnswerFailed === true,
  }
  if (license) {
    return {
      action: 'kill',
      code: 'SW_LICENSE_UNAVAILABLE',
      reason: 'license-dialog',
      ...base,
      pid: license.pid,
      dialogText: clipText(`${license.title} ${license.text}`, 400),
    }
  }
  const splash = observable && SPLASH_TITLE_RE.test(title)
  const ready = observable ? (rotFound === true && hasMainWindow === true && !splash) : rotFound === true
  if (ready) {
    return { action: 'ok', code: null, reason: observable ? 'main-window-ready' : 'rot-visible', ...base }
  }
  if (elapsed < watch) {
    const reason = prompt
      ? 'prompt-pending'
      : (splash ? 'splash-pending' : (unknown.length > 0 ? 'modal-dialog' : 'waiting'))
    return { action: 'wait', code: null, reason, ...base }
  }
  // 超时：有询问框就先说明「问不了」，否则按 splash/ROT/窗口各自的原因。
  const reason = prompt
    ? 'prompt-unanswered'
    : (splash
      ? 'splash-stuck'
      : (unknown.length > 0
        ? 'modal-dialog'
        : (rotFound !== true ? 'no-rot' : (hasMainWindow !== true ? 'window-not-ready' : 'not-ready'))))
  return { action: 'kill', code: 'SW_START_FAILED', reason, ...base }
}

/** 读失败标记：fresh=true 表示还在冷却期内（默认 10 分钟），不要重试启动。 */
export function readLaunchFailure(file = defaultLaunchFailureFile(), { now = Date.now(), cooldownMs = DEFAULT_LAUNCH_COOLDOWN_MS } = {}) {
  let parsed = null
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch { parsed = null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { mark: null, fresh: false, ageMs: null, file }
  }
  const rawAt = parsed.at
  const at = typeof rawAt === 'string' ? Date.parse(rawAt) : Number(rawAt)
  const ageMs = Number.isFinite(at) ? Math.max(0, now - at) : null
  const cooldown = cooldownMs === null || cooldownMs === undefined
    ? DEFAULT_LAUNCH_COOLDOWN_MS
    : Math.max(0, Number(cooldownMs) || 0)
  const mark = {
    version: Number(parsed.version) || LAUNCH_FAILURE_VERSION,
    code: LAUNCH_GUARD_CODES.includes(parsed.code) ? parsed.code : 'SW_START_FAILED',
    at: Number.isFinite(at) ? new Date(at).toISOString() : null,
    pid: Number(parsed.pid) || 0,
    elapsedMs: parsed.elapsedMs === null || parsed.elapsedMs === undefined ? null : (Number.isFinite(Number(parsed.elapsedMs)) ? Number(parsed.elapsedMs) : null),
    windowTitle: parsed.windowTitle ? String(parsed.windowTitle) : null,
    dialogText: parsed.dialogText ? String(parsed.dialogText) : null,
    reason: parsed.reason ? String(parsed.reason) : null,
    target: parsed.target ? String(parsed.target) : null,
    message: parsed.message ? String(parsed.message) : null,
    nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps.map(String) : [],
    // 盯守期间见过的对话框（title/text/kind/clicked）与自动应答结果：排查「为什么没起来」要看这个。
    dialogs: (Array.isArray(parsed.dialogs) ? parsed.dialogs : []).map(normalizeDialogRecord).filter(Boolean),
    autoClickFailed: parsed.autoClickFailed === true,
  }
  return { mark, fresh: ageMs !== null && ageMs < cooldown, ageMs, file }
}

/** 写失败标记（原子写）。字段：code/at/pid/elapsedMs/windowTitle/dialogText/reason/target/message/nextSteps/dialogs。 */
export function writeLaunchFailure(file = defaultLaunchFailureFile(), failure = {}, { now = Date.now() } = {}) {
  const code = LAUNCH_GUARD_CODES.includes(failure.code) ? failure.code : 'SW_START_FAILED'
  const elapsedMs = failure.elapsedMs === null || failure.elapsedMs === undefined || !Number.isFinite(Number(failure.elapsedMs))
    ? null
    : Number(failure.elapsedMs)
  const mark = {
    version: LAUNCH_FAILURE_VERSION,
    code,
    at: safeIso(failure.at) ?? new Date(now).toISOString(),
    pid: Number(failure.pid) || 0,
    elapsedMs,
    windowTitle: failure.windowTitle ? String(failure.windowTitle) : null,
    dialogText: failure.dialogText ? String(failure.dialogText) : null,
    reason: failure.reason ? String(failure.reason) : null,
    target: failure.target ? String(failure.target) : null,
    killed: failure.killed === true,
    message: failure.message ? String(failure.message) : launchFailureMessage(code, failure),
    nextSteps: Array.isArray(failure.nextSteps) ? failure.nextSteps.map(String) : launchNextSteps(code),
    dialogs: (Array.isArray(failure.dialogs) ? failure.dialogs : []).map(normalizeDialogRecord).filter(Boolean),
    autoClickFailed: failure.autoClickFailed === true,
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(mark, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 临时文件清不掉就先留着 */ }
    throw error
  }
  return mark
}

/** 启动成功后清掉旧标记：下一次失败重新开始算 10 分钟冷却。 */
export function clearLaunchFailure(file = defaultLaunchFailureFile()) {
  try { unlinkSync(file); return true } catch { return false }
}

const LAUNCH_REASON_TEXT = {
  'license-dialog': '卡在许可弹窗',
  'no-rot': '进程没有注册到 ROT',
  'splash-stuck': '主窗口一直停在 splash',
  'window-not-ready': 'ROT 已出现但主窗口还没就绪',
  'not-ready': '窗口没就绪',
  'modal-dialog': '卡在模态对话框',
  'prompt-pending': '在等 CAM 询问框被应答',
  'prompt-unanswered': '有模态询问框但无法自动应答',
}

export function launchFailureReasonText(reason) {
  return LAUNCH_REASON_TEXT[reason] ?? String(reason ?? '未知原因')
}

/** 错误消息的「用户下一步该做什么」：每一条都要能照着做。 */
export function launchNextSteps(code) {
  switch (code) {
    case 'SW_LICENSE_UNAVAILABLE':
      return [
        '在 SOLIDWORKS 的「插件」里取消勾选 SOLIDWORKS CAM 的自启动',
        '或修复 CAM 许可服务器（-15, cannot connect）后重试',
        '如果已有实例卡在许可弹窗上，先手动关闭那个弹窗',
      ]
    case 'SW_START_FAILED':
      return [
        '手动启动一次 SOLIDWORKS，确认能进到主窗口',
        '检查是否弹着许可/欢迎对话框，处理后再让 broker 重试',
        '确认没问题后重试；10 分钟冷却期内可用 SW_MCP_LAUNCH_COOLDOWN_MS=0 或删除失败标记',
      ]
    case 'SW_LAUNCH_COOLDOWN':
      return [
        '先按失败标记里的 message 处理上一次的失败原因',
        '冷却结束后重试；确需立即重试可删除 %LOCALAPPDATA%\\sw-mcp\\state\\launch-failure.json',
      ]
    case 'SW_LAUNCH_TARGET_MISSING':
      return [
        '确认本机已安装 SOLIDWORKS',
        '或用 SW_MCP_SW_EXE / SW_MCP_SW_LAUNCH 指向 SLDWORKS.exe / 桌面快捷方式',
      ]
    default:
      return ['检查 SOLIDWORKS 是否能手动启动，然后重试']
  }
}

/** 结构化错误消息：code + 现场 + 用户下一步。 */
export function launchFailureMessage(code, details = {}) {
  const steps = launchNextSteps(code)
  const tail = steps.length > 0 ? `下一步：${steps.join('；')}` : ''
  const seconds = Number.isFinite(Number(details.elapsedMs)) ? Math.round(Number(details.elapsedMs) / 1000) : null
  const where = details.dialogText ? `（弹窗：${clipText(details.dialogText, 160)}）` : ''
  switch (code) {
    case 'SW_LICENSE_UNAVAILABLE': {
      const pid = Number(details.pid) > 0 ? `pid ${details.pid} ` : ''
      return `SOLIDWORKS CAM 许可服务器连不上${where}：${pid}卡在许可弹窗上，不能拿它干活。${tail}`
    }
    case 'SW_START_FAILED': {
      const pid = Number(details.pid) > 0 ? `（pid ${Number(details.pid)}）` : ''
      const killed = details.killed === true ? '，已停止本次启动的进程并清理登记' : ''
      const title = details.windowTitle ? `，窗口标题：${clipText(details.windowTitle, 120)}` : ''
      // 询问框点不动时，原因直接写成能照着做的动作：手动点『是』永远是最后一条路。
      const reason = details.reason === 'prompt-unanswered'
        ? '有模态询问框但无法自动应答，请手动点『是』'
        : launchFailureReasonText(details.reason)
      return `SOLIDWORKS ${seconds !== null ? `${seconds} 秒内` : ''}没有就绪：${reason}${pid}${title}${killed}${where}。${tail}`
    }
    case 'SW_LAUNCH_COOLDOWN': {
      const minutes = Number.isFinite(Number(details.minutes)) ? Number(details.minutes) : null
      const previous = details.previousMessage ? `：${clipText(details.previousMessage, 160)}` : ''
      return `上次自动启动 SOLIDWORKS 失败（${details.previousCode ?? 'SW_START_FAILED'}`
        + `${minutes !== null ? `，${minutes} 分钟前` : ''}）${previous}。为了不每分钟重试把机器刷爆，`
        + `冷却期内不再自动启动。${tail}`
    }
    case 'SW_LAUNCH_TARGET_MISSING':
      return `找不到可执行的 SOLIDWORKS 启动入口${details.target ? `（${clipText(details.target, 160)}）` : ''}。${tail}`
    default:
      return `启动 SOLIDWORKS 失败（${code ?? 'UNKNOWN'}）${where}。${tail}`
  }
}

/**
 * 启动预检（不启动任何进程）。返回 {ok, code, message, checks[], failure}：
 * - exe-path：SLDWORKS.exe 存在且是可执行文件（回退到 .lnk 时标记 skipped）；
 * - launch-target：真正要 Start-Process 的目标存在；
 * - launch-cooldown：上一次失败标记是否还在 10 分钟冷却期内；
 * - license-dialog：已有实例是否卡在许可弹窗（有就不再起第二个）。
 */
export async function preflightLaunch({
  env = process.env,
  now = Date.now(),
  cooldownMs = null,
  failureFile = null,
  target = null,
  exePath = null,
  probe = null,
  sampleWindow = null,
  maxLicenseProbes = 4,
} = {}) {
  const file = failureFile ?? defaultLaunchFailureFile(env)
  const cooldownRaw = cooldownMs === null || cooldownMs === undefined ? null : Number(cooldownMs)
  const cooldown = Number.isFinite(cooldownRaw) && cooldownRaw >= 0
    ? cooldownRaw
    : envNumber(env, 'SW_MCP_LAUNCH_COOLDOWN_MS', DEFAULT_LAUNCH_COOLDOWN_MS)
  const checks = []
  const targetPath = target?.target ? String(target.target) : null
  const exe = exePath ? String(exePath) : targetPath

  const fileCheck = (label, path) => {
    let present = false
    try { present = existsSync(path) } catch { present = false }
    if (!present) return { ok: false, detail: `${label} 不存在：${path}` }
    if (/\.exe$/i.test(path)) {
      let isFile = false
      try { isFile = statSync(path).isFile() } catch { isFile = false }
      if (!isFile) return { ok: false, detail: `${label} 不是可执行文件：${path}` }
    }
    return { ok: true, detail: `${label} 可用：${path}` }
  }

  const kind = target?.kind ?? (targetPath && /\.exe$/i.test(targetPath) ? 'exe' : 'lnk')
  const failure = readLaunchFailure(file, { now, cooldownMs: cooldown })
  // 提示（不是失败）：例如「已有实例停在 CAM 询问框」。写进 notices 让调用方能照着做。
  const notices = []
  const finish = (code, details = null) => ({
    ok: code === null,
    code,
    message: code ? launchFailureMessage(code, details ?? {}) : null,
    checks,
    failure: failure.mark,
    file,
    notices,
    details: code ? details : null,
    at: new Date(now).toISOString(),
  })

  if (exe) {
    const result = fileCheck('SLDWORKS.exe', exe)
    checks.push({ id: 'exe-path', ok: result.ok || kind !== 'exe', skipped: kind !== 'exe', detail: result.detail })
  }
  if (targetPath) {
    const result = fileCheck('启动目标', targetPath)
    checks.push({ id: 'launch-target', ok: result.ok, detail: result.detail })
  } else {
    checks.push({ id: 'launch-target', ok: false, detail: '没有解析出要启动的目标' })
  }
  // 目标不合格就不必再看冷却/许可：一次注定失败的启动不该去采样窗口。
  const targetFailed = checks.find((check) => !check.ok) ?? null
  if (targetFailed) {
    return finish('SW_LAUNCH_TARGET_MISSING', {
      target: targetPath,
      exePath: exe,
      markFile: file,
      failedCheck: targetFailed.id,
      detail: targetFailed.detail,
    })
  }

  // 冷却：上次启动失败还新鲜（默认 10 分钟）就直接返回，避免每分钟把机器刷爆。
  if (failure.fresh) {
    const minutes = failure.ageMs === null ? null : Math.max(0, Math.round(failure.ageMs / 60_000))
    checks.push({ id: 'launch-cooldown', ok: false, detail: `上次失败在 ${minutes ?? '?'} 分钟前（${failure.mark.code}），还在冷却期` })
    return finish('SW_LAUNCH_COOLDOWN', {
      previousCode: failure.mark?.code ?? 'SW_START_FAILED',
      previousMessage: failure.mark?.message ?? failure.mark?.reason ?? null,
      at: failure.mark?.at ?? null,
      minutes,
      markFile: file,
    })
  }
  checks.push({
    id: 'launch-cooldown',
    ok: true,
    detail: failure.mark
      ? `上次失败在 ${Math.round((failure.ageMs ?? 0) / 60_000)} 分钟前，已过冷却`
      : '没有失败标记',
  })

  // 许可：已有实例真卡在许可失败弹窗上（用户自己开的）就不能再起第二个。
  // 只是停在 CAM 询问框上不算失败——那只是没人点「是」，给句提示继续启动。
  if (typeof probe === 'function' && typeof sampleWindow === 'function') {
    let instances = []
    let probeFailed = false
    try {
      const probed = await probe()
      if (probed?.error) probeFailed = true
      instances = Array.isArray(probed?.instances) ? probed.instances : []
    } catch { probeFailed = true; instances = [] }
    const pids = instances
      .map((instance) => Number(instance?.pid))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .slice(0, Math.max(0, Number(maxLicenseProbes) || 4))
    let hit = null
    let promptHit = null
    for (const pid of pids) {
      let sample = null
      try { sample = await sampleWindow(pid) } catch { sample = null }
      if (!sample || sample.ok === false) continue
      for (const dialog of Array.isArray(sample.dialogs) ? sample.dialogs : []) {
        if (Number(dialog?.pid) !== pid) continue
        const classified = classifyDialog(dialog)
        if (classified.kind === DIALOG_KIND.LICENSE) {
          hit = { pid, text: clipText(`${classified.title} ${classified.text}`, 400), title: sample.mainWindowTitle ?? null, dialogTitle: dialog?.title ?? '', kind: classified.kind }
          break
        }
        if (classified.kind === DIALOG_KIND.PROMPT && !promptHit) {
          promptHit = { pid, text: clipText(`${classified.title} ${classified.text}`, 400), button: classified.button }
        }
      }
      if (hit) break
    }
    if (hit) {
      const detail = `已有实例 pid ${hit.pid} 卡在许可弹窗：${clipText(hit.text, 160)}`
      checks.push({ id: 'license-dialog', ok: false, detail })
      return finish('SW_LICENSE_UNAVAILABLE', { pid: hit.pid, dialogText: hit.text, markFile: file, detail })
    }
    if (promptHit) {
      // 询问框不是失败：不拒绝启动，只提示怎么把它点掉（uiAction 用现有实现里真实存在的 normalize）。
      // 白名单里的确认框不止 CAM（还有「无法生成日志文件…」「3DEXPERIENCE Marketplace」），
      // 所以文案统一说「启动确认框」，并把要点的按钮标出来。
      const notice = `已有实例 pid ${promptHit.pid} 停在启动确认框（询问框，不是许可失败），要点的按钮是『${clipText(promptHit.button ?? '是', 60)}』；`
        + '可用 workspace action=ui uiAction=normalize 或手动点『是』/「确定」'
      notices.push(notice)
      checks.push({ id: 'license-dialog', ok: true, detail: notice })
    } else if (probeFailed && pids.length === 0) {
      // ROT 都探不到时不能断言「没有许可弹窗」，如实标 skipped 而不是假装通过。
      checks.push({ id: 'license-dialog', ok: true, skipped: true, detail: 'ROT 探测失败，跳过许可弹窗检查' })
    } else {
      checks.push({
        id: 'license-dialog',
        ok: true,
        detail: pids.length > 0 ? `检查了 ${pids.length} 个已有实例，没有许可弹窗` : '当前没有已有实例',
      })
    }
  } else {
    checks.push({ id: 'license-dialog', ok: true, skipped: true, detail: '未注入窗口探测，跳过许可弹窗检查' })
  }

  return finish(null)
}

/**
 * 实例管理器。ROT / worker / 启动进程由 brokerd 注入，这样 registry 级测试
 * 不必真起 SOLIDWORKS。
 */
export class InstanceManager {
  constructor({
    file = defaultInstancesFile(),
    env = process.env,
    probe = async () => ({ instances: [], activePid: null }),
    launch = null,
    // 启动守卫：preflight 回答「该不该起」，sampleWindow 回答「起出来什么样」。
    // 两者都不注入时行为退回旧语义（只看 ROT），既有测试/离线环境不受影响。
    preflight = null,
    sampleWindow = null,
    // 自动应答启动确认框：clickDialog({pid,button,title,text}) → {ok, clicked}。
    // 只允许点本次 lease pid 的窗口（brokerd 的实现在 PowerShell 侧按 pid 过滤）。
    clickDialog = null,
    // 误杀防护：超时判失败前先问「这个实例的 COM 已经能用了吗」。
    // verifyCom({pid,reason}) → {ok, op?, detail?}；不注入就退回旧语义（照常收尾）。
    verifyCom = null,
    workers = new Map(),
    workerLastUsed = new Map(),
    clientPid = new Map(),
    clientAlive = () => true,
    workerFor = () => { throw new InstanceError('NO_WORKER', '没有 worker 工厂') },
    stopWorker = () => false,
    cleanupWorker = null,
    quitWorker = null,
    stopProcess = null,
    isAlive = (pid) => {
      try { process.kill(Number(pid), 0); return true } catch { return false }
    },
    sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    now = () => Date.now(),
    pollMs = envNumber(env, 'SW_MCP_INSTANCE_POLL_MS', 2_500),
    launchWaitMs = envNumber(env, 'SW_MCP_INSTANCE_LAUNCH_WAIT_MS', 120_000),
    launchWatchMs = envNumber(env, 'SW_MCP_LAUNCH_WATCH_MS', envNumber(env, 'SW_MCP_INSTANCE_LAUNCH_WAIT_MS', DEFAULT_LAUNCH_WATCH_MS)),
    launchSampleMs = envNumber(env, 'SW_MCP_LAUNCH_SAMPLE_MS', DEFAULT_LAUNCH_SAMPLE_MS),
    launchCooldownMs = envNumber(env, 'SW_MCP_LAUNCH_COOLDOWN_MS', DEFAULT_LAUNCH_COOLDOWN_MS),
    launchFailureFile = defaultLaunchFailureFile(env),
    launchClickMax = envNumber(env, 'SW_MCP_LAUNCH_CLICK_MAX', DEFAULT_LAUNCH_CLICK_MAX),
    launchClickGapMs = envNumber(env, 'SW_MCP_LAUNCH_CLICK_GAP_MS', DEFAULT_LAUNCH_CLICK_GAP_MS),
    graceMs = envNumber(env, 'SW_MCP_REAP_GRACE_MS', DEFAULT_REAP_GRACE_MS),
    staleTestMs = envNumber(env, 'SW_MCP_STALE_TEST_MS', DEFAULT_STALE_TEST_MS),
    quitGraceMs = envNumber(env, 'SW_MCP_QUIT_GRACE_MS', DEFAULT_QUIT_GRACE_MS),
    workerIdleMs = envNumber(env, 'SW_MCP_WORKER_IDLE_MS', 30 * 60_000),
    minWarm = envNumber(env, 'SW_MCP_MIN_WARM', 1),
    touchThrottleMs = 5_000,
    log = () => {},
  } = {}) {
    this.file = file
    this.env = env
    this.probe = probe
    this.launch = launch
    this.preflight = typeof preflight === 'function' ? preflight : null
    this.sampleWindow = typeof sampleWindow === 'function' ? sampleWindow : null
    this.clickDialog = typeof clickDialog === 'function' ? clickDialog : null
    this.verifyCom = typeof verifyCom === 'function' ? verifyCom : null
    this.launchSampleMs = Math.max(10, launchSampleMs)
    this.launchWatchMs = Math.max(this.launchSampleMs, launchWatchMs)
    this.launchCooldownMs = Math.max(0, launchCooldownMs)
    this.launchFailureFile = launchFailureFile
    // 启动确认框自动应答：最多 5 次、每次至少间隔 2 秒（低于 2 秒的注入值也抬到 2 秒）。
    // 每次点击都重新枚举窗口（不缓存 hwnd）：对话框点掉后可能紧接着弹下一个。
    this.launchClickMax = Math.max(1, Math.floor(Number(launchClickMax) || DEFAULT_LAUNCH_CLICK_MAX))
    this.launchClickGapMs = Math.max(DEFAULT_LAUNCH_CLICK_GAP_MS, Number(launchClickGapMs) || DEFAULT_LAUNCH_CLICK_GAP_MS)
    this.lastPreflight = null
    this.lastLaunchFailure = null
    this.workers = workers
    this.workerLastUsed = workerLastUsed
    this.clientPid = clientPid
    this.clientAlive = clientAlive
    this.workerFor = workerFor
    this.stopWorker = stopWorker
    this.cleanupWorker = cleanupWorker
    this.quitWorker = quitWorker
    this.stopProcess = stopProcess
    this.isAlive = isAlive
    this.sleep = sleep
    this.now = now
    this.pollMs = Math.max(10, pollMs)
    this.launchWaitMs = Math.max(this.pollMs, launchWaitMs)
    this.graceMs = graceMs
    this.staleTestMs = staleTestMs
    this.quitGraceMs = quitGraceMs
    this.workerIdleMs = workerIdleMs
    this.minWarm = Math.max(0, minWarm)
    this.touchThrottleMs = Math.max(0, touchThrottleMs)
    this.log = log
    this.ensureFlights = new Map()
    this.launchFlight = null
    this.lastTouch = new Map()
    // 「ROT 里只有用户实例」的日志去重：同一组 pid 只记一次。
    this.userOnlyNoted = new Set()
  }

  /** R11：这一轮只能看见用户实例。记一次，说清楚为什么去起新的而不是将就。 */
  #noteUserOnly(pids) {
    const key = (pids ?? []).slice().sort((a, b) => a - b).join(',')
    if (!key) return
    if (this.userOnlyNoted.has(key)) return
    this.userOnlyNoted.add(key)
    this.log(`affinity：ROT 里只有用户实例（pid ${key}），策略不分配用户实例；改为给会话准备专属实例`)
  }

  #iso() {
    return new Date(this.now()).toISOString()
  }

  get policy() {
    return instancePolicy(this.env)
  }

  get maxInstances() {
    return maxInstancesFor(this.policy, this.env)
  }

  #load(pid) {
    const worker = this.workers?.get(Number(pid)) ?? null
    try { return Number(worker?.describe?.()?.active) || 0 } catch { return 0 }
  }

  #pending(pid) {
    const worker = this.workers?.get(Number(pid)) ?? null
    try { return Number(worker?.describe?.()?.pending) || 0 } catch { return 0 }
  }

  #clientsFor(pid) {
    const target = Number(pid)
    const clients = new Set()
    for (const [clientId, bound] of this.clientPid ?? []) {
      if (Number(bound) === target && this.clientAlive(clientId)) clients.add(String(clientId))
    }
    const entry = readInstances(this.file, { now: this.now() }).instances.find((item) => item.pid === target)
    for (const clientId of entry?.ownerClients ?? []) {
      if (this.clientAlive(clientId)) clients.add(String(clientId))
    }
    return [...clients]
  }

  async #probeSafe() {
    try {
      const probe = await this.probe()
      return {
        instances: Array.isArray(probe?.instances) ? probe.instances : [],
        activePid: probe?.activePid ?? null,
        error: probe?.error ?? null,
        // 装配所限（probeEligible/prefetchProbe 存在）且这一轮是「不探」。调用方
        // 必须能把它和「探了但 ROT 是空的」区分开，否则会把一堆还活着的实例
        // 当成 ROT 已消失。
        skipped: probe?.skipped === true,
      }
    } catch (error) {
      return { instances: [], activePid: null, error: { code: 'PROBE_FAILED', message: error?.message ?? String(error) }, skipped: false }
    }
  }

  /**
   * 这一轮到底该不该起探针进程（R12）。
   *
   * 为什么要有这个判断：`instances.json` 里常常只有一条「用户自己开的」实例
   * （launchedBy:"user"），而维护循环每分钟仍会探 2 次（maintenance:2094 一次、
   * reap:1996 一次），每次都是一个 SwBridge.exe 进程。探用户实例既没用（用户
   * 实例永不回收、永不分配），又要付一次进程启动和一次 COM 往返的代价。
   *
   * 规则：登记表里有「非用户」的实例，或者 broker 自己还挂着 worker / 有会话绑定，
   * 才探；否则这一轮跳过。用 pid 快照而不是布尔值懒求值，是为了让同一轮
   * maintenance + reap 只探一次（见 prefetchProbe）。
   */
  probeEligible() {
    if (!this.probe) return false
    if ((this.workers?.size ?? 0) > 0) return true
    if ((this.clientPid?.size ?? 0) > 0) return true
    let state = null
    try { state = readInstances(this.file, { now: this.now() }) } catch { return true }
    const entries = state?.instances ?? []
    return entries.some((entry) => !isUserInstance(entry))
  }

  /**
   * 一轮里探一次、给这轮所有探测方复用。
   *
   * 之前 maintenance() 先探一次（:2094），reap() 再探一次（:1996），所以每个周期
   * 固定 2 个探针进程。这里把结果按「一轮」缓存：传进来的 ttl 用完了才重新探。
   */
  async prefetchProbe({ ttlMs = 1_000 } = {}) {
    const now = this.now()
    if (this.probeCache && now - this.probeCache.at < ttlMs) return this.probeCache.value
    const value = await this.#probeSafe()
    this.probeCache = { at: this.now(), value }
    return value
  }

  /** 让下一个 prefetchProbe 重新探一次（实例刚起/刚退时用）。 */
  invalidateProbe() {
    this.probeCache = null
  }

  /** ROT 里有、登记表没有的实例 = 在我们开始管之前就开着的 → 用户实例。
   *
   * 但如果探针自己带了 launchedBy（brokerd 的探针以后可以带上它），就以探针为准：
   * 只从 ROT 拿到 pid 时才默认 user。这条「默认 user」是 R11 的 fail-closed 依据：
   * 无法证明是我们起的实例，就不能分配给 AI 会话。 */
  #adopt(rot) {
    if (!Array.isArray(rot) || rot.length === 0) return
    const state = readInstances(this.file, { now: this.now() })
    const known = new Set(state.instances.map((entry) => entry.pid))
    const fresh = []
    for (const instance of rot) {
      const pid = Number(instance?.pid)
      if (!Number.isInteger(pid) || pid <= 0 || known.has(pid)) continue
      fresh.push(normalizeEntry({
        pid,
        startedAt: instance.startedAt ?? null,
        launchedBy: LAUNCHED_BY.includes(instance?.launchedBy) ? instance.launchedBy : 'user',
        tag: instance?.tag ?? null,
        ownerClients: [],
        lastSeen: this.#iso(),
        lastUsedAt: this.#iso(),
        workerStarted: false,
      }))
    }
    if (fresh.length === 0) return
    updateInstances(this.file, (entries) => {
      for (const entry of fresh) upsertEntry(entries, entry)
      return entries
    }, { now: this.now() })
  }

  /** 把「ROT 行」补成「可分配判定需要的样子」：pid + launchedBy + ownerClients +
   * workerStarted。ROT 只知道 pid，登记表才知道是谁起的、被谁占着；affinity 的
   * 规则（绝不分配用户实例）必须看到合并后的事实，否则 equal 于没改。 */
  #roster(rot, state) {
    const byPid = new Map((state?.instances ?? []).map((entry) => [entry.pid, entry]))
    return (rot ?? []).map((instance) => {
      const pid = Number(instance?.pid)
      const entry = byPid.get(pid) ?? null
      // 登记表里没有的行也照实给出 launchedBy：探针带就信探针，没带就按 user
      // （fail closed，宁可让 ensure 去起一个专属实例，也不碰用户的窗口）。
      const launchedBy = entry?.launchedBy
        ?? (LAUNCHED_BY.includes(instance?.launchedBy) ? instance.launchedBy : 'user')
      const worker = this.workers?.get(pid) ?? null
      return {
        ...instance,
        pid,
        launchedBy,
        tag: entry?.tag ?? instance?.tag ?? null,
        ownerClients: Array.isArray(entry?.ownerClients) ? entry.ownerClients : [],
        workerStarted: Boolean(worker) || entry?.workerStarted === true,
      }
    })
  }

  #mutateEntry(pid, mutate) {
    const target = Number(pid)
    let changed = false
    updateInstances(this.file, (entries) => {
      const index = entries.findIndex((entry) => entry.pid === target)
      if (index < 0) return entries
      const next = mutate(entries[index])
      if (next) { entries[index] = normalizeEntry(next); changed = true }
      return entries
    }, { now: this.now() })
    return changed
  }

  #bindOwner(pid, clientId, rotEntry = null) {
    const target = Number(pid)
    const nowIso = this.#iso()
    updateInstances(this.file, (entries) => {
      const index = entries.findIndex((entry) => entry.pid === target)
      if (index < 0) {
        entries.push(normalizeEntry({
          pid: target,
          startedAt: rotEntry?.startedAt ?? null,
          launchedBy: 'user',
          tag: null,
          ownerClients: clientId ? [clientId] : [],
          lastSeen: nowIso,
          lastUsedAt: nowIso,
          workerStarted: false,
        }))
        return entries
      }
      const entry = entries[index]
      const owners = new Set(entry.ownerClients)
      if (clientId) owners.add(String(clientId))
      entries[index] = { ...entry, startedAt: entry.startedAt ?? safeIso(rotEntry?.startedAt), ownerClients: [...owners], lastSeen: nowIso }
      return entries
    }, { now: this.now() })
  }

  #dropOwner(pid, clientId) {
    this.#mutateEntry(pid, (entry) => ({
      ...entry,
      ownerClients: entry.ownerClients.filter((id) => id !== String(clientId)),
      lastSeen: this.#iso(),
    }))
  }

  #markWorkerStarted(pid, started) {
    this.#mutateEntry(pid, (entry) => ({ ...entry, workerStarted: started === true, lastSeen: this.#iso() }))
  }

  /** 作业真的跑过就算一次「用过」：maintenance 的空闲判据看它，不看绑定。 */
  touch(pid) {
    const target = Number(pid)
    if (!Number.isInteger(target) || target <= 0) return
    const stamp = this.now()
    const previous = this.lastTouch.get(target) ?? 0
    this.lastTouch.set(target, stamp)
    if (stamp - previous < this.touchThrottleMs) return
    this.#mutateEntry(target, (entry) => ({ ...entry, lastUsedAt: this.#iso(), lastSeen: this.#iso() }))
  }

  async #warm(pid, startWorker) {
    if (!startWorker) return { warmed: false, warmError: null }
    try {
      const worker = this.workerFor(pid)
      await worker.request('version', {}, { timeoutMs: 20_000 })
      this.#markWorkerStarted(pid, true)
      return { warmed: true, warmError: null }
    } catch (error) {
      this.#markWorkerStarted(pid, false)
      return { warmed: false, warmError: { code: error?.code ?? 'WARM_FAILED', message: error?.message ?? String(error) } }
    }
  }

  #hasIncomingLaunch(rot) {
    const running = new Set((rot ?? []).map((instance) => Number(instance?.pid)).filter(Boolean))
    const state = readInstances(this.file, { now: this.now() })
    return state.instances.some((entry) => (entry.launchedBy === 'broker' || entry.launchedBy === 'test')
      && !running.has(entry.pid)
      && this.isAlive(entry.pid))
  }

  /**
   * 预检：注入的 preflight 回答「exe 可执行 / 冷却 / 已有实例卡许可弹窗」。
   * 没注入就当成通过；预检自己抛错也放行（一次探测失败不该成为启动阻塞项，
   * 但会写进 lastPreflight 与日志，出问题能查到）。
   */
  async #preflightSafe() {
    if (!this.preflight) {
      return {
        ok: true,
        code: null,
        message: null,
        checks: [{ id: 'preflight', ok: true, skipped: true, detail: '未注入预检' }],
        notices: [],
        at: this.#iso(),
      }
    }
    try {
      const result = await this.preflight({
        env: this.env,
        now: this.now(),
        cooldownMs: this.launchCooldownMs,
        failureFile: this.launchFailureFile,
      })
      const checks = Array.isArray(result?.checks) ? result.checks : []
      const notices = Array.isArray(result?.notices) ? result.notices.map(String) : []
      const payload = {
        ok: result?.ok !== false,
        code: result?.code ?? null,
        message: result?.message ?? null,
        checks,
        failure: result?.failure ?? null,
        details: result?.details ?? null,
        notices,
        at: this.#iso(),
      }
      this.lastPreflight = payload
      // 提示不是失败：只记日志，不拦启动。
      for (const notice of notices) this.log(`预检提示：${notice}`)
      if (payload.ok) {
        this.log(`预检通过：${checks.map((check) => `${check.id}=${check.ok ? 'ok' : 'fail'}${check.skipped ? '(skip)' : ''}`).join(', ') || '无检查项'}`)
      } else {
        this.log(`预检未通过 ${payload.code ?? ''}：${payload.message ?? ''}`)
      }
      return payload
    } catch (error) {
      const payload = {
        ok: true,
        code: null,
        message: null,
        checks: [{ id: 'preflight', ok: true, skipped: true, detail: `预检异常（放行）：${error?.message ?? error}` }],
        at: this.#iso(),
      }
      this.lastPreflight = payload
      this.log(`预检异常（放行）：${error?.message ?? error}`)
      return payload
    }
  }

  /** 采样目标 pid 的顶层窗口/#32770 弹窗；没有注入探测时 ok:false（退回只看 ROT）。 */
  async #sampleWindowSafe(pid) {
    const target = Number(pid) || 0
    if (!this.sampleWindow || target <= 0) {
      return { ok: false, error: 'NO_WINDOW_SAMPLER', hasMainWindow: false, mainWindowTitle: '', dialogs: [], at: this.#iso() }
    }
    try {
      const sample = await this.sampleWindow(target, { durationMs: this.launchWatchMs, intervalMs: this.launchSampleMs })
      if (!sample || sample.ok === false) {
        return { ok: false, error: sample?.error ?? 'WINDOW_SAMPLE_FAILED', hasMainWindow: false, mainWindowTitle: '', dialogs: [], at: this.#iso() }
      }
      return {
        ok: true,
        hasMainWindow: sample.hasMainWindow === true,
        mainWindowTitle: sample.mainWindowTitle ? String(sample.mainWindowTitle) : '',
        dialogs: Array.isArray(sample.dialogs) ? sample.dialogs : [],
        at: sample.at ?? this.#iso(),
      }
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error), hasMainWindow: false, mainWindowTitle: '', dialogs: [], at: this.#iso() }
    }
  }

  /** 写失败标记（%LOCALAPPDATA%\sw-mcp\state\launch-failure.json）。写不下去也不能丢错误。 */
  #recordLaunchFailure({ code, reason, pid, elapsedMs, windowTitle, dialogText, target, killed, dialogs, autoClickFailed }) {
    const details = {
      code,
      reason,
      pid: Number(pid) || 0,
      elapsedMs: elapsedMs === null || elapsedMs === undefined || !Number.isFinite(Number(elapsedMs)) ? null : Number(elapsedMs),
      windowTitle: windowTitle ? String(windowTitle) : null,
      dialogText: dialogText ? String(dialogText) : null,
      target: target ? String(target) : null,
      killed: killed === true,
      dialogs: (Array.isArray(dialogs) ? dialogs : []).map(normalizeDialogRecord).filter(Boolean),
      autoClickFailed: autoClickFailed === true,
    }
    const message = launchFailureMessage(code, details)
    const nextSteps = launchNextSteps(code)
    try {
      const mark = writeLaunchFailure(this.launchFailureFile, { ...details, at: this.#iso(), message, nextSteps }, { now: this.now() })
      this.log(`已写失败标记 ${this.launchFailureFile}：${code} pid=${mark.pid}`)
      return mark
    } catch (error) {
      this.log(`写失败标记 ${this.launchFailureFile} 失败：${error?.message ?? error}`)
      return { ...details, at: this.#iso(), message, nextSteps, writeError: error?.message ?? String(error) }
    }
  }

  /**
   * 启动守卫收尾：只杀本次启动的 pid（启动前就在 ROT/登记表里的 pid 一律不碰）
   * → 清登记 → 写失败标记。杀错实例的代价远大于漏杀，所以这里必须核对 pid。
   */
  async #abortLaunch({ decision, lease, beforePids, launchPid, target, dialogs }) {
    const before = new Set(beforePids ?? [])
    const candidates = []
    if (Number(decision?.pid) > 0) candidates.push(Number(decision.pid))
    for (const pid of lease?.pids ?? []) candidates.push(Number(pid))
    if (Number(launchPid) > 0) candidates.push(Number(launchPid))
    const ordered = [...new Set(candidates)].filter((pid) => Number.isInteger(pid) && pid > 0)
    // 只有「启动前不存在」的 pid 才是本次起出来的。
    const killPid = ordered.find((pid) => !before.has(pid)) ?? 0
    if (ordered.length > 0 && killPid === 0) {
      this.log(`拒绝收尾：候选 pid ${ordered.join(',')} 都是启动前就存在的实例，不是本次启动的`)
    }
    let killed = false
    if (killPid > 0) {
      if (!this.isAlive(killPid)) {
        killed = true // 自己已经退了，等于收尾完成
      } else if (typeof this.stopProcess === 'function') {
        try {
          killed = (await this.stopProcess(killPid, { force: true })) !== false
        } catch (error) {
          this.log(`Stop-Process ${killPid} 失败：${error?.message ?? error}`)
        }
      }
    }
    if (killPid > 0) {
      updateInstances(this.file, (entries) => removeEntry(entries, killPid), { now: this.now() })
      try { this.stopWorker(killPid) } catch { /* 停不掉 worker 也不影响收尾 */ }
      for (const [clientId, bound] of this.clientPid ?? []) {
        if (Number(bound) === killPid) this.clientPid.delete(clientId)
      }
      this.workerLastUsed?.delete(killPid)
    }
    const mark = this.#recordLaunchFailure({
      code: decision?.code ?? 'SW_START_FAILED',
      reason: decision?.reason ?? 'unknown',
      pid: killPid || (Number(decision?.pid) || 0),
      elapsedMs: decision?.elapsedMs ?? null,
      windowTitle: decision?.windowTitle ?? null,
      dialogText: decision?.dialogText ?? null,
      target,
      killed,
      dialogs,
      autoClickFailed: decision?.autoClickFailed === true,
    })
    return { killed, pid: killPid, mark, markFile: this.launchFailureFile }
  }

  /** 把一次「盯守判定为失败」变成结构化错误（ensure 会按 code 抛出）。 */
  async #launchFailed({ decision, lease, before, launchPid, target, preflight, dialogs }) {
    const abort = await this.#abortLaunch({ decision, lease, beforePids: before, launchPid, target, dialogs })
    const code = decision?.code ?? 'SW_START_FAILED'
    const details = {
      code,
      reason: decision?.reason ?? 'unknown',
      elapsedMs: decision?.elapsedMs ?? null,
      windowTitle: decision?.windowTitle ?? null,
      dialogText: decision?.dialogText ?? null,
      pid: abort.pid || (Number(decision?.pid) || 0),
      killed: abort.killed,
      target,
      leasePids: decision?.leasePids ?? [],
      dialogs: (Array.isArray(dialogs) ? dialogs : []).map(normalizeDialogRecord).filter(Boolean),
      autoClickFailed: decision?.autoClickFailed === true,
      checks: preflight?.checks ?? [],
      preflight,
      markFile: abort.markFile,
      mark: abort.mark,
      nextSteps: launchNextSteps(code),
      legacyCode: code === 'SW_START_FAILED' ? 'LAUNCH_TIMEOUT' : null,
    }
    const message = launchFailureMessage(code, details)
    this.lastLaunchFailure = { code, message, details, at: this.#iso() }
    this.log(`盯守判定 ${code}（${details.reason}）：pid=${details.pid} killed=${abort.killed}，失败标记 ${abort.markFile}`)
    return { ok: false, launched: true, pid: details.pid, error: { code, message, details }, target, preflight }
  }

  /** 启动成功（或 COM 探测救回）时的统一登记：写 instances.json + 清旧失败标记。 */
  #registerLaunchSuccess({ pid, rotEntry = null, tag = null, clientId = null }) {
    const nowIso = this.#iso()
    const entry = normalizeEntry({
      pid,
      startedAt: rotEntry?.startedAt ?? nowIso,
      launchedBy: tag === 'test' ? 'test' : 'broker',
      tag: tag ?? null,
      ownerClients: clientId ? [String(clientId)] : [],
      lastSeen: nowIso,
      lastUsedAt: nowIso,
      workerStarted: false,
    })
    updateInstances(this.file, (entries) => upsertEntry(entries, entry), { now: this.now() })
    // 启动成功 → 旧的失败标记作废，下一次失败重新算冷却。
    clearLaunchFailure(this.launchFailureFile)
    return entry
  }

  /**
   * 误杀防护：超时判失败之前，先问「这个实例的 COM 已经能干活了吗」。
   *
   * 真机踩过：第二个实例弹着「无法生成日志文件…另一个 SOLIDWORKS 程序可能正在运行」
   * 这类守卫没识别（或点不掉）的确认框，120s 后按 SW_START_FAILED kill 掉——可那个
   * 实例的 COM 明明已经能 build/save。所以「窗口没就绪」不再等于「实例不可用」：
   * 只要注入的 COM 探针（brokerd 侧用 worker 握手，见 probeComUsable）返回 ok，
   * 就按 ok + degraded 登记，并把没点掉的对话框清单交回调用方。
   */
  async #rescueByCom({ decision, lease, launchPid, tag, clientId, preflight, seenDialogs, lastRot, target, startedAt }) {
    if (typeof this.verifyCom !== 'function') return null
    const candidates = [...new Set([
      Number(decision?.pid) || 0,
      Number(lease?.pid) || 0,
      ...(Array.isArray(lease?.pids) ? lease.pids : []).map((pid) => Number(pid) || 0),
      Number(launchPid) || 0,
    ].filter((pid) => Number.isInteger(pid) && pid > 0))]
    if (candidates.length === 0) return null
    let probe = null
    let confirmed = 0
    for (const pid of candidates) {
      try {
        probe = await this.verifyCom({ pid, reason: decision?.reason ?? 'timeout' })
      } catch (error) {
        probe = { ok: false, error: error?.message ?? String(error) }
      }
      if (probe?.ok === true) { confirmed = pid; break }
    }
    if (!confirmed) {
      this.log(`COM 探测未通过（pid ${candidates.join(',')}）：${probe?.error ?? 'unknown'}，按启动失败收尾`)
      return null
    }
    const entry = this.#registerLaunchSuccess({
      pid: confirmed,
      rotEntry: (lastRot ?? []).find((instance) => Number(instance?.pid) === confirmed) ?? null,
      tag,
      clientId,
    })
    const dialogs = summarizeDialogs(seenDialogs)
    const unclicked = dialogs.filter((dialog) => dialog.clicked !== true)
    const watch = {
      elapsedMs: this.now() - startedAt,
      reason: decision?.reason ?? 'timeout',
      samplePid: confirmed,
      rotPids: (lastRot ?? []).map((instance) => Number(instance?.pid)).filter(Boolean),
      windowKnown: true,
      hasMainWindow: decision?.hasMainWindow === true,
      mainWindowTitle: decision?.windowTitle ?? null,
      dialogs,
      degraded: true,
    }
    const comProbe = { ok: true, pid: confirmed, op: probe?.op ?? 'com-probe', detail: probe?.detail ?? null }
    this.log(`判超时但 COM 已可用（pid ${confirmed}，探测 ${comProbe.op}）：不杀进程，按 ok+degraded 登记；`
      + `未点掉的对话框 ${unclicked.length} 个`)
    return {
      ok: true,
      launched: true,
      pid: confirmed,
      entry,
      target: target ?? null,
      preflight,
      watch: { ...watch, comProbe },
      dialogs,
      degraded: true,
      unclickedDialogs: unclicked,
      comProbe,
      autoClickFailed: decision?.autoClickFailed === true,
    }
  }

  /** 真正去起 SOLIDWORKS：全局只允许一个在飞；预检 → 启动 → 每 2 秒盯守 120 秒。 */
  async #launchOnce({ beforePids, clientId, tag }) {
    if (this.launchFlight) return this.launchFlight
    const flight = this.#doLaunch({ beforePids, clientId, tag })
      .finally(() => { this.launchFlight = null })
    this.launchFlight = flight
    return flight
  }

  async #doLaunch({ beforePids, clientId, tag }) {
    if (typeof this.launch !== 'function') {
      return { ok: false, launched: false, pid: 0, error: { code: 'NO_LAUNCHER', message: '没有注入 SOLIDWORKS 启动函数' }, preflight: null }
    }
    // ① 预检：还没起进程，先判断该不该起。冷却/许可/目标不合格直接返回结构化错误。
    const preflight = await this.#preflightSafe()
    const preflightView = {
      ok: preflight.ok,
      code: preflight.code ?? null,
      checks: preflight.checks,
      // 提示（如「已有实例停在 CAM 询问框」）如实带给调用方，但不影响 ok。
      notices: Array.isArray(preflight.notices) ? preflight.notices : [],
      at: preflight.at ?? this.#iso(),
    }
    if (!preflight.ok) {
      const code = preflight.code ?? 'SW_LAUNCH_COOLDOWN'
      const message = preflight.message ?? launchFailureMessage(code, preflight.details ?? {})
      const details = {
        ...(preflight.details ?? {}),
        checks: preflight.checks,
        preflight: preflightView,
        nextSteps: launchNextSteps(code),
        legacyCode: null,
      }
      this.lastLaunchFailure = { code, message, details, at: this.#iso() }
      this.log(`预检拒绝启动：${code} ${message}`)
      return { ok: false, launched: false, pid: 0, error: { code, message, details }, target: null, preflight: preflightView }
    }

    let launched
    try {
      launched = await this.launch()
    } catch (error) {
      // 半启动清理：抛错就不写登记表，不留下「起了一半」的条目。
      return { ok: false, launched: false, pid: 0, error: { code: 'LAUNCH_FAILED', message: error?.message ?? String(error) }, preflight: preflightView }
    }
    if (!launched || launched.launched === false) {
      return {
        ok: false,
        launched: false,
        pid: 0,
        error: { code: launched?.code ?? 'LAUNCH_FAILED', message: launched?.error ?? '启动 SOLIDWORKS 失败' },
        target: launched?.target ?? null,
        preflight: preflightView,
      }
    }

    // ② 盯守：启动器给的 pid 是「本次 lease」的第一份证据；ROT 里新出现的 pid 也归本次。
    const target = launched?.target ?? null
    const launchPid = Number(launched?.pid) > 0 ? Number(launched.pid) : 0
    const before = new Set(beforePids ?? [])
    const startedAt = this.now()
    let lease = { pid: launchPid, pids: launchPid > 0 ? [launchPid] : [] }
    let lastRot = []
    // 启动确认框的自动应答账本：每个确认框最多点 launchClickMax 次，间隔 ≥2 秒，
    // 每次点击都重新枚举窗口（brokerd 的点击器按 pid 现枚举，不缓存 hwnd）。
    const seenDialogs = new Map()
    const clickState = new Map()
    let autoAnswerFailed = false
    let loggedUnreliable = false
    for (let round = 0; round < 20_000; round += 1) {
      const remain = startedAt + this.launchWatchMs - this.now()
      await this.sleep(Math.min(this.launchSampleMs, Math.max(1, remain)))
      const probe = await this.#probeSafe()
      lastRot = probe.instances
      const rotPids = lastRot.map((instance) => Number(instance?.pid)).filter((pid) => Number.isInteger(pid) && pid > 0)
      const fresh = rotPids.filter((pid) => !before.has(pid))
      if (fresh.length > 0) {
        // ROT 里的 pid 才是「我们的实例」最硬的证据：主采样对象优先它。
        lease = { pid: fresh[0], pids: [...new Set([...(lease.pids ?? []), ...fresh])] }
      }
      const sample = lease.pid > 0
        ? await this.#sampleWindowSafe(lease.pid)
        : { ok: false, error: 'NO_LEASE_PID', hasMainWindow: false, mainWindowTitle: '', dialogs: [] }
      const rotFound = (lease.pids ?? []).some((pid) => rotPids.includes(Number(pid)))
      const decision = decideLaunchOutcome({
        elapsedMs: this.now() - startedAt,
        hasMainWindow: sample.hasMainWindow === true,
        mainWindowTitle: sample.mainWindowTitle ?? '',
        dialogs: sample.dialogs ?? [],
        rotFound,
        lease,
        windowKnown: sample.ok === true,
        watchMs: this.launchWatchMs,
        autoAnswerFailed,
      })
      rememberDialogs(seenDialogs, decision.dialogs)
      if (decision.textUnreliable && !loggedUnreliable) {
        loggedUnreliable = true
        this.log('对话框采样文本不可信（乱码/空）：按按钮文本 + 对话框存在性判定，不看正文')
      }
      if (decision.action === 'ok') {
        const pid = Number(lease.pid) || Number(lease.pids?.[0]) || 0
        const rotEntry = lastRot.find((instance) => Number(instance?.pid) === pid) ?? null
        const entry = this.#registerLaunchSuccess({ pid, rotEntry, tag, clientId })
        const dialogs = summarizeDialogs(seenDialogs)
        const watch = {
          elapsedMs: this.now() - startedAt,
          reason: decision.reason,
          samplePid: lease.pid,
          rotPids,
          windowKnown: sample.ok === true,
          hasMainWindow: decision.hasMainWindow,
          mainWindowTitle: decision.windowTitle,
          dialogs,
        }
        this.lastPreflight = preflight
        this.log(`盯守通过（${decision.reason}，${Math.round(watch.elapsedMs / 1000)}s）：pid ${pid} 已登记`
          + (dialogs.some((dialog) => dialog.clicked) ? '，已自动应答启动确认框' : ''))
        return { ok: true, launched: true, pid, entry, target, preflight: preflightView, watch, dialogs, degraded: false, autoClickFailed: autoAnswerFailed === true }
      }
      if (decision.action === 'kill') {
        // 误杀防护（真机踩过）：超时/卡在模态框 ≠ 实例不可用。判失败前先做一次
        // COM 可用性探测；只要 COM 已经能用，就按 ok + degraded 登记，绝不 kill。
        const rescued = await this.#rescueByCom({
          decision, lease, launchPid, tag, clientId, preflight: preflightView, seenDialogs, lastRot, target, startedAt,
        })
        if (rescued) return rescued
        return this.#launchFailed({ decision, lease, before, launchPid, target, preflight: preflightView, dialogs: summarizeDialogs(seenDialogs) })
      }
      // action=wait → 询问框先应答，然后再继续盯。
      const answer = decision.autoAnswer
      if (answer) {
        const key = dialogWatchKey({ pid: answer.pid, kind: DIALOG_KIND.PROMPT, title: answer.title, text: answer.text })
        const state = clickState.get(key) ?? { count: 0, at: 0, failed: false }
        clickState.set(key, state)
        if (typeof this.clickDialog !== 'function') {
          // 采样器在、点击器不在：别再重试，等到超时按 prompt-unanswered 收尾并让人手动点。
          if (!state.failed) {
            state.failed = true
            this.log(`识别到启动确认框（pid ${answer.pid}）但没有注入自动应答，请手动点『${clipText(answer.button ?? '是', 40)}』`)
          }
        } else if (state.count >= this.launchClickMax) {
          if (!state.failed) {
            state.failed = true
            this.log(`启动确认框（pid ${answer.pid}）点了 ${this.launchClickMax} 次仍在，请手动点『${clipText(answer.button ?? '是', 40)}』`)
          }
        } else if (this.now() - state.at >= this.launchClickGapMs) {
          state.count += 1
          state.at = this.now()
          let result = null
          try {
            // 只点本次 lease pid 的窗口：answer.pid 来自只含 lease pid 的 decision.dialogs。
            // 点击器每次重新枚举窗口，所以这里不需要（也不允许）缓存 hwnd。
            result = await this.clickDialog({
              pid: answer.pid,
              button: answer.button,
              title: answer.title,
              text: answer.text,
            })
          } catch (error) {
            result = { ok: false, error: error?.message ?? String(error) }
          }
          if (result?.ok === true) {
            const record = seenDialogs.get(key)
            if (record) record.clicked = true
            this.log(`自动应答启动确认框 pid ${answer.pid}：点了『${clipText(answer.button ?? '是', 60)}』`)
          } else {
            this.log(`自动应答启动确认框失败（第 ${state.count}/${this.launchClickMax} 次）：${result?.error ?? 'unknown'}`)
          }
          if (state.count >= this.launchClickMax && result?.ok !== true) state.failed = true
        }
        autoAnswerFailed = [...clickState.values()].some((item) => item.failed === true)
      }
    }
    // 采样循环兜底（理论上不会走到）：按超时收尾，绝不留着不管。
    const forced = decideLaunchOutcome({
      elapsedMs: this.launchWatchMs,
      rotFound: false,
      lease,
      watchMs: this.launchWatchMs,
      autoAnswerFailed,
    })
    return this.#launchFailed({ decision: forced, lease, before, launchPid, target, preflight: preflightView, dialogs: summarizeDialogs(seenDialogs) })
  }

  /**
   * 保证会话有一个可用实例。
   * - shared：ROT 有实例就复用（绝不新起第二个）。
   * - isolated：没有空闲实例且已达上限 → INSTANCE_BUSY 排队等待，不启动新进程。
   * - 需要启动时全进程 single-flight，并发调用只起一次。
   *
   * 策略/上限/tag 按「显式参数 > 本请求带来的 env > broker 自己的 env」解析：
   * broker 是常驻进程，profile 级的 env 只在它启动时有效；若调用方的会话 env
   * 是 isolated/3，就必须按请求覆盖，否则 isolated 形同虚设（真机缺陷 A）。
   */
  async ensure({
    timeoutMs = 180_000,
    clientId = null,
    instancePid = 0,
    policy = null,
    maxInstances = null,
    tag = null,
    startWorker = false,
  } = {}) {
    const envPolicy = this.policy
    const envMax = this.maxInstances
    const envTag = this.env.SW_MCP_INSTANCE_TAG ? String(this.env.SW_MCP_INSTANCE_TAG) : null
    const resolvedPolicy = policy ? instancePolicy({ SW_MCP_INSTANCE_POLICY: policy }) : envPolicy
    const explicitCap = Number.isFinite(Number(maxInstances)) && Number(maxInstances) >= 1
    const cap = explicitCap ? Math.floor(Number(maxInstances)) : maxInstancesFor(resolvedPolicy, this.env)
    const resolvedTag = tag ? String(tag) : (this.env.SW_MCP_INSTANCE_TAG ? String(this.env.SW_MCP_INSTANCE_TAG) : null)
    // 生效值从哪来：param（显式参数）/ env（请求带来的环境变量或 broker 自身 env）。
    const overrides = {
      policy: policy ? 'param' : 'env',
      maxInstances: explicitCap ? 'param' : 'env',
      tag: tag ? 'param' : 'env',
      // 与 broker 进程 env 相比是否有运行时覆盖：有就记日志，出问题能追到「这次按什么起的」。
      overridden: resolvedPolicy !== envPolicy || cap !== envMax || resolvedTag !== envTag,
      env: { policy: envPolicy, maxInstances: envMax, tag: envTag },
      effective: { policy: resolvedPolicy, maxInstances: cap, tag: resolvedTag },
    }
    if (overrides.overridden) {
      this.log(`实例策略按请求覆盖（运行时）：env(policy=${envPolicy},maxInstances=${envMax},tag=${envTag ?? 'null'})`
        + ` → 请求(policy=${resolvedPolicy},maxInstances=${cap},tag=${resolvedTag ?? 'null'})，来源 ${overrides.policy}/${overrides.maxInstances}/${overrides.tag}`)
    }
    const key = `${resolvedPolicy}|${resolvedTag ?? ''}|${clientId ? String(clientId) : ''}|${Number(instancePid) || 0}`
    const running = this.ensureFlights.get(key)
    if (running) return running
    const flight = this.#ensureOnce({
      timeoutMs: Math.max(5_000, Math.min(Number(timeoutMs) || 180_000, 300_000)),
      clientId: clientId ? String(clientId) : null,
      requested: Number(instancePid) || 0,
      policy: resolvedPolicy,
      maxInstances: cap,
      tag: resolvedTag,
      startWorker: startWorker !== false,
      overrides,
    }).finally(() => { this.ensureFlights.delete(key) })
    this.ensureFlights.set(key, flight)
    return flight
  }

  async #ensureOnce({ timeoutMs, clientId, requested, policy, maxInstances, tag, startWorker, overrides = null }) {
    const startedAt = this.now()
    const deadline = startedAt + timeoutMs
    let probe = { instances: [], activePid: null }
    let probeError = null
    let launched = null
    let launchError = null
    let guardError = null
    for (let round = 0; round < 10_000; round += 1) {
      probe = await this.#probeSafe()
      probeError = probe.error
      const rot = probe.instances
      if (!this.launchFlight) this.#adopt(rot)
      // ROT 只给 pid；launchedBy / ownerClients 在登记表里。affinity 的分配规则
      // 要看到合并后的事实，否则「用户实例不分配」等于没实现。
      const roster = this.#roster(rot, readInstances(this.file, { now: this.now() }))
      const choice = chooseInstance({
        instances: roster,
        requested,
        clientId,
        clientPid: this.clientPid,
        load: (pid) => this.#load(pid),
        clientAlive: this.clientAlive,
        policy,
        maxInstances,
        log: (message) => this.log(message),
      })
      if (choice.reason === 'ONLY_USER_INSTANCES') {
        // R11：ROT 里只剩用户自己开的实例。绝不将就，继续往下走「起/复用自己
        // 的实例」；只记一次日志，免得等待循环每 2.5 秒刷一行。
        this.#noteUserOnly(choice.userPids)
      }
      if (choice.pid) {
        const rotEntry = rot.find((instance) => Number(instance?.pid) === choice.pid) ?? null
        this.#bindOwner(choice.pid, clientId, rotEntry)
        const warm = await this.#warm(choice.pid, startWorker)
        return {
          instances: rot,
          activePid: probe.activePid ?? null,
          chosenPid: choice.pid,
          // 生效值回显：调用方可以自证「这次是按 isolated/3 起的」，不用再猜 broker env。
          instancePid: choice.pid,
          warmed: warm.warmed,
          warmError: warm.warmError,
          launched,
          degraded: launched?.degraded === true,
          unclickedDialogs: launched?.unclickedDialogs ?? [],
          launchError,
          probeError,
          // 这次没有走启动流程：预检没跑过，字段如实给 null（只增字段，不改既有字段）。
          preflight: launched?.preflight ?? null,
          launchFailure: launched?.error ?? null,
          waitedMs: this.now() - startedAt,
          timeoutMs,
          policy,
          maxInstances,
          tag,
          overrides,
          clientId,
          busy: false,
          retryAfterMs: null,
          // R11：这次是不是显式点名用了用户实例？把证据交给调用方。
          adoptedUser: choice.adoptedUser === true,
          affinityReason: choice.reason ?? null,
        }
      }
      // 守卫已经确认启动成功、但 ROT 还没来得及登记这个 pid（degraded 救回的实例尤其
      // 常见）：直接绑定它，别让循环把它当成「没有实例」再起一个 SOLIDWORKS。
      if (launched?.ok === true && Number(launched.pid) > 0 && this.isAlive(Number(launched.pid))) {
        const pid = Number(launched.pid)
        this.#bindOwner(pid, clientId, rot.find((instance) => Number(instance?.pid) === pid) ?? null)
        const warm = await this.#warm(pid, startWorker)
        return {
          instances: rot,
          activePid: probe.activePid ?? null,
          chosenPid: pid,
          instancePid: pid,
          warmed: warm.warmed,
          warmError: warm.warmError,
          launched,
          degraded: launched?.degraded === true,
          unclickedDialogs: launched?.unclickedDialogs ?? [],
          launchError,
          probeError,
          preflight: launched?.preflight ?? null,
          launchFailure: null,
          waitedMs: this.now() - startedAt,
          timeoutMs,
          policy,
          maxInstances,
          tag,
          overrides,
          clientId,
          busy: false,
          retryAfterMs: null,
          // R11：这次是不是显式点名用了用户实例？把证据交给调用方。
          adoptedUser: choice.adoptedUser === true,
          affinityReason: choice.reason ?? null,
        }
      }
      if (choice.busy) {
        const remain = deadline - this.now()
        if (remain <= 0) {
          throw new InstanceError(
            'INSTANCE_BUSY',
            `实例已到上限（${maxInstances} 个）且全被占用，没有空闲实例可分配`,
            { retryAfterMs: this.pollMs, policy, maxInstances, instances: rot.map((instance) => Number(instance?.pid)), tag },
          )
        }
        await this.sleep(Math.min(this.pollMs, Math.max(1, remain)))
        continue
      }
      const remain = deadline - this.now()
      if (remain <= 0) break
      if (this.#hasIncomingLaunch(rot)) {
        // 另一个 broker 已经登记了「正在启动」的 pid：等它出现，不要再起一个。
        await this.sleep(Math.min(this.pollMs, Math.max(1, remain)))
        continue
      }
      launched = await this.#launchOnce({ beforePids: rot.map((instance) => Number(instance?.pid)).filter(Boolean), clientId, tag })
      if (!launched.ok) {
        launchError = launched.error
        // 启动守卫的拒绝（冷却/许可/启动失败/目标不存在）必须是结构化错误：
        // 否则调用方只会看到「等待超时」，不知道下一步该做什么。
        if (LAUNCH_GUARD_CODES.includes(launchError?.code)) {
          guardError = new InstanceError(
            launchError.code,
            launchError.message ?? launchFailureMessage(launchError.code, launchError.details ?? {}),
            {
              ...(launchError.details ?? {}),
              preflight: launched.preflight ?? null,
              timeoutMs,
              policy,
              maxInstances,
              tag,
              clientId,
            },
          )
        }
        break
      }
      await this.sleep(Math.min(this.pollMs, Math.max(1, remain)))
    }
    // 先让 ensure 的「启动守卫」结论以结构化错误抛出去（与 INSTANCE_BUSY 同级）。
    if (guardError) throw guardError
    return {
      instances: probe.instances ?? [],
      activePid: probe.activePid ?? null,
      chosenPid: null,
      instancePid: null,
      warmed: false,
      warmError: null,
      launched,
      degraded: launched?.degraded === true,
      unclickedDialogs: launched?.unclickedDialogs ?? [],
      launchError,
      probeError,
      preflight: launched?.preflight ?? null,
      launchFailure: launched?.error ?? null,
      waitedMs: this.now() - startedAt,
      timeoutMs,
      policy,
      maxInstances,
      tag,
      overrides,
      clientId,
      busy: false,
      retryAfterMs: null,
      adoptedUser: choice.adoptedUser === true,
      affinityReason: choice.reason ?? null,
    }
  }

  /** 会话断开：立刻释放绑定，让实例能被别的会话复用 / 被 maintenance 回收。 */
  release(clientId) {
    if (!clientId) return { released: false, pid: null }
    const pid = this.clientPid.get(String(clientId)) ?? null
    if (!pid) return { released: false, pid: null }
    this.clientPid.delete(String(clientId))
    this.#dropOwner(pid, clientId)
    return { released: true, pid }
  }

  /** 当前会话绑的是哪个实例；绑定指向已经不在 ROT 的 pid 就顺手清掉。
   *
   * R11：除了 pid，同时回 affinityPolicy / affinityReason / canAssign 结论，
   * 让「我是谁、我能不能用这个实例」一眼可读；boundPid 是给 server.mjs 传
   * `--instance` 用的显式别名（见文件末尾 boundPidForSession 的说明）。 */
  async bound({ clientId = null } = {}) {
    const probe = await this.#probeSafe()
    const pids = new Set(probe.instances.map((instance) => Number(instance?.pid)))
    const key = clientId ? String(clientId) : null
    let pid = key ? (this.clientPid.get(key) ?? null) : null
    if (pid && !pids.has(Number(pid))) {
      this.clientPid.delete(key)
      this.#dropOwner(pid, key)
      pid = null
    }
    const state = readInstances(this.file, { now: this.now() })
    const roster = this.#roster(probe.instances, state)
    const current = pid ? roster.find((item) => item.pid === Number(pid)) ?? null : null
    return {
      clientId: key,
      pid: pid ?? null,
      // 同一个事实的显式名字：调用方不必猜 pid 字段的语义。
      boundPid: pid ?? null,
      instances: probe.instances,
      policy: this.policy,
      affinityPolicy: this.policy,
      maxInstances: this.maxInstances,
      boundIsUser: current ? isUserInstance(current) : false,
      assignable: current
        ? canAssign(current, { sessionId: key, policy: this.policy })
        : false,
      probeError: probe.error,
    }
  }

  /** 实例清单：ROT 是事实来源，登记表补上 launchedBy/tag/clients/idleMs。
   *
   * R11：把「用户实例」与「会话绑定的实例」分开列出来（userPids / boundPids /
   * unboundPids），每个实例再带 isUser / assignable / bound。这样
   * workspace action="instances" 一眼能看出哪个窗口是用户的、AI 会碰哪个。 */
  async list() {
    const probe = await this.#probeSafe()
    const state = readInstances(this.file, { now: this.now() })
    const byPid = new Map(state.instances.map((entry) => [entry.pid, entry]))
    const now = this.now()
    const roster = this.#roster(probe.instances, state)
    const instances = roster.map((instance) => {
      const pid = Number(instance?.pid)
      const entry = byPid.get(pid) ?? null
      const worker = this.workers?.get(pid) ?? null
      const description = worker ? (() => { try { return worker.describe() } catch { return null } })() : null
      const lastUsed = entry ? Date.parse(entry.lastUsedAt ?? entry.lastSeen ?? '') : Number.NaN
      const clients = this.#clientsFor(pid)
      return {
        pid,
        startedAt: safeIso(instance.startedAt) ?? entry?.startedAt ?? null,
        launchedBy: entry?.launchedBy ?? instance.launchedBy ?? 'user',
        tag: entry?.tag ?? null,
        clients,
        workers: description ? [description] : [],
        workerStarted: Boolean(description) || entry?.workerStarted === true,
        lastSeen: entry?.lastSeen ?? null,
        idleMs: Number.isFinite(lastUsed) ? Math.max(0, now - lastUsed) : null,
        alive: true,
        // R11 观测口径：用户的窗口永远标出来；能不能分配是纯函数算出来的，
        // 和真正分配时用的是同一条规则。
        isUser: isUserInstance(instance),
        bound: clients.length > 0,
        assignable: canAssign(instance, { sessionId: null, policy: this.policy }),
      }
    })
    const userPids = instances.filter((item) => item.isUser).map((item) => item.pid)
    const boundPids = instances.filter((item) => item.bound).map((item) => item.pid)
    const unboundPids = instances.filter((item) => !item.bound).map((item) => item.pid)
    const stale = state.instances
      .filter((entry) => !probe.instances.some((instance) => Number(instance?.pid) === entry.pid))
      .map((entry) => ({ ...entry, alive: this.isAlive(entry.pid) }))
    return {
      instances,
      activePid: probe.activePid ?? null,
      workers: [...(this.workers?.values() ?? [])].map((worker) => { try { return worker.describe() } catch { return null } }).filter(Boolean),
      registry: state.instances,
      stale,
      policy: this.policy,
      affinityPolicy: this.policy,
      // 用户的窗口 / 已被会话占用的 / 空着可分配的：三段一眼分开。
      userPids,
      boundPids,
      unboundPids,
      assignablePids: instances.filter((item) => item.assignable).map((item) => item.pid),
      maxInstances: this.maxInstances,
      reapGraceMs: this.graceMs,
      probeError: probe.error,
    }
  }

  #reapable(entry, { force, clients, now, graceMs, tagExplicit }) {
    if (entry.launchedBy === 'user' && !force) return { ok: false, reason: 'user-instance' }
    if (clients.length > 0 && !force) return { ok: false, reason: 'client-attached', clients }
    if (this.#pending(entry.pid) > 0 && !force) return { ok: false, reason: 'busy' }
    if (tagExplicit || force) return { ok: true }
    const lastUsed = Date.parse(entry.lastUsedAt ?? entry.lastSeen ?? '')
    const idleMs = Number.isFinite(lastUsed) ? now - lastUsed : Number.POSITIVE_INFINITY
    if (idleMs < graceMs) return { ok: false, reason: 'not-idle', idleMs }
    return { ok: true }
  }

  /** 单个实例的回收：先 cleanup 文档，再 quit，15 秒不退才按 pid 强杀。 */
  async #reapOne(pid, { includeDocs = true, force = false } = {}) {
    const target = Number(pid)
    let closedDocs = 0
    if (includeDocs && typeof this.cleanupWorker === 'function') {
      try {
        const closed = await this.cleanupWorker(target, { timeoutMs: 30_000 })
        closedDocs = Array.isArray(closed?.closed) ? closed.closed.length : 0
      } catch (error) {
        this.log(`cleanup ${target} 失败：${error?.message ?? error}`)
      }
    }
    let quit = false
    if (typeof this.quitWorker === 'function') {
      try {
        await this.quitWorker(target, { timeoutMs: 60_000 })
        quit = true
      } catch (error) {
        this.log(`quit ${target} 失败：${error?.message ?? error}`)
      }
    }
    const waitUntil = this.now() + this.quitGraceMs
    while (this.now() < waitUntil) {
      if (!this.isAlive(target)) break
      await this.sleep(Math.min(1_000, Math.max(1, waitUntil - this.now())))
    }
    let killed = false
    if (this.isAlive(target)) {
      // 只强杀登记表里的 pid：ROT 里别的实例、用户自己开的窗口都碰不到。
      const registered = readInstances(this.file, { now: this.now() }).instances.some((entry) => entry.pid === target)
      if (registered) {
        try {
          const result = typeof this.stopProcess === 'function' ? await this.stopProcess(target, { force }) : false
          killed = result !== false
        } catch (error) {
          this.log(`Stop-Process ${target} 失败：${error?.message ?? error}`)
        }
      }
    }
    const stoppedWorker = this.stopWorker(target) !== false
    updateInstances(this.file, (entries) => removeEntry(entries, target), { now: this.now() })
    for (const [clientId, bound] of this.clientPid ?? []) {
      if (Number(bound) === target) this.clientPid.delete(clientId)
    }
    this.workerLastUsed?.delete(target)
    return { closedDocs, quit, stoppedWorker, killed, pid: target }
  }

  /**
   * 显式回收。只动 service/test 实例；用户实例默认 skipped，force:true 才动。
   * tag 给定时不要求「空闲够久」（测试收尾就该立刻收），否则要超过 grace。
   */
  async reap({ tag = null, dryRun = false, includeDocs = true, force = false, graceMs = null, reason = 'reap' } = {}) {
    const now = this.now()
    // R12：这一轮该不该起探针进程。不该探就完全不起（以前每 60 秒固定 2 个
    // SwBridge.exe 进程，哪怕登记表里只有用户自己的实例）。
    const probe = this.probeEligible()
      ? await this.prefetchProbe()
      : { instances: [], activePid: null, error: null, skipped: true }
    const rotPids = new Set(probe.instances.map((instance) => Number(instance?.pid)))
    const tagFilter = tag ? String(tag) : null
    const tagExplicit = Boolean(tagFilter)
    const counters = {
      reason,
      dryRun,
      tag: tagFilter,
      force,
      probeSkipped: probe.skipped === true,
      stoppedWorkers: 0,
      quitInstances: 0,
      closedDocs: 0,
      removedEntries: 0,
      skipped: [],
      reaped: [],
    }
    const state = readInstances(this.file, { now })
    for (const entry of state.instances) {
      const pid = entry.pid
      // R12：这一轮没探测，就不能把「ROT 里没有它」当成它已经没了 —— pid 判活
      // 仍然可靠，所以只要有活着的证据，条目就一个都不删。
      const alive = probe.skipped ? true : (rotPids.has(pid) || this.isAlive(pid))
      if (!alive) {
        if (!dryRun) {
          updateInstances(this.file, (entries) => removeEntry(entries, pid), { now })
          if (this.stopWorker(pid) !== false) counters.stoppedWorkers += 1
          counters.removedEntries += 1
        }
        continue
      }
      if (tagFilter && entry.tag !== tagFilter) {
        counters.skipped.push({ pid, reason: 'tag-mismatch', tag: entry.tag, launchedBy: entry.launchedBy })
        continue
      }
      const clients = this.#clientsFor(pid)
      const guard = this.#reapable(entry, { force, clients, now, graceMs: graceMs ?? this.graceMs, tagExplicit })
      if (!guard.ok) {
        counters.skipped.push({ pid, reason: guard.reason, launchedBy: entry.launchedBy, tag: entry.tag, ...(guard.idleMs !== undefined ? { idleMs: guard.idleMs } : {}), ...(guard.clients ? { clients: guard.clients } : {}) })
        continue
      }
      if (dryRun) {
        counters.reaped.push({ pid, launchedBy: entry.launchedBy, tag: entry.tag, dryRun: true })
        continue
      }
      const outcome = await this.#reapOne(pid, { includeDocs, force })
      counters.closedDocs += outcome.closedDocs
      counters.quitInstances += outcome.quit ? 1 : 0
      counters.stoppedWorkers += outcome.stoppedWorker ? 1 : 0
      counters.reaped.push({ pid, launchedBy: entry.launchedBy, tag: entry.tag, quit: outcome.quit, killed: outcome.killed, closedDocs: outcome.closedDocs })
    }
    return counters
  }

  /**
   * action=quit：默认只退当前会话绑定的实例；用户实例必须 force:true，
   * 否则抛 USER_INSTANCE_REFUSED，让调用方明确知道自己在动别人的窗口。
   */
  async quit({ pid = 0, clientId = null, force = false } = {}) {
    const target = Number(pid) || (clientId ? Number(this.clientPid.get(String(clientId)) ?? 0) : 0)
    if (!target) {
      throw new InstanceError('NO_BOUND_INSTANCE', '当前会话没有绑定实例，也没有指定 pid', { clientId })
    }
    const entry = readInstances(this.file, { now: this.now() }).instances.find((item) => item.pid === target) ?? null
    const probe = await this.#probeSafe()
    const inRot = probe.instances.some((instance) => Number(instance?.pid) === target)
    const launchedBy = entry?.launchedBy ?? (inRot ? 'user' : 'unknown')
    if (!force && (launchedBy === 'user' || launchedBy === 'unknown')) {
      throw new InstanceError(
        'USER_INSTANCE_REFUSED',
        `实例 ${target} 是用户自己打开的 SOLIDWORKS（launchedBy=${launchedBy}），拒绝退出；确认要退出请显式传 force:true`,
        { pid: target, launchedBy },
      )
    }
    if (!inRot && !this.isAlive(target)) {
      updateInstances(this.file, (entries) => removeEntry(entries, target), { now: this.now() })
      return { quit: false, pid: target, launchedBy, closedDocs: 0, note: '进程已经不在了' }
    }
    const outcome = await this.#reapOne(target, { includeDocs: true, force: true })
    return { quit: outcome.quit, pid: target, launchedBy, closedDocs: outcome.closedDocs, killed: outcome.killed, stoppedWorker: outcome.stoppedWorker }
  }

  /**
   * 每 60 秒一轮的整理：清 ROT 消失的条目与孤儿 worker、停空闲 worker（保留
   * MIN_WARM）、回收空闲够久的 broker/test 实例。启动时额外收掉超过 10 分钟的
   * tag=test 残留。
   */
  async maintenance({ startup = false, includeDocs = true, graceMs = null, workerIdleMs = null, keepWarm = null } = {}) {
    const now = this.now()
    const counters = {
      at: this.#iso(),
      startup,
      probeSkipped: false,
      stoppedWorkers: 0,
      orphanWorkers: 0,
      quitInstances: 0,
      closedDocs: 0,
      removedEntries: 0,
      keptWarm: 0,
      reaped: [],
      skipped: [],
    }
    // R12：先决定这一轮要不要探，需要 ROT 时才探，而且这一轮只探一次（reap 复用）。
    // 以前这里无条件探一次，reap() 里再探一次 —— 每分钟 2 个探针进程去连用户实例。
    const eligible = this.probeEligible()
    const probe = eligible
      ? await this.prefetchProbe()
      : { instances: [], activePid: null, error: null, skipped: true }
    counters.probeSkipped = probe.skipped === true
    const rotPids = new Set(probe.instances.map((instance) => Number(instance?.pid)).filter(Boolean))
    // ROT 探不到但进程还在（COM 卡住）：不能当它死了，交给 idle/reap 逻辑判断。
    // 这一轮没探时 ROT 是空的，更不能据此删条目。
    const state = readInstances(this.file, { now })
    for (const entry of state.instances) {
      if (probe.skipped) break
      if (rotPids.has(entry.pid)) continue
      if (this.isAlive(entry.pid)) continue
      updateInstances(this.file, (entries) => removeEntry(entries, entry.pid), { now })
      counters.removedEntries += 1
      if (this.stopWorker(entry.pid) !== false) { counters.stoppedWorkers += 1; counters.orphanWorkers += 1 }
    }

    // 停空闲 worker：ROT 里没有的 worker 一定是孤儿，直接停；其余按空闲时间排队，
    // 只保留最近用过的 MIN_WARM 个，下一次建模不用重新 attach。
    // 这一轮没探（probe.skipped）时「ROT 里没有」不构成孤儿证据，全部放行。
    const idle = []
    for (const [key, worker] of this.workers ?? []) {
      const pid = Number(key) || 0
      let description = null
      try { description = worker.describe() } catch { description = null }
      if ((description?.pending ?? 0) > 0 || (description?.active ?? 0) > 0) continue
      if (!probe.skipped && !rotPids.has(pid)) {
        if (this.stopWorker(pid) !== false) { counters.stoppedWorkers += 1; counters.orphanWorkers += 1 }
        continue
      }
      const lastUsed = this.workerLastUsed?.get(key) ?? 0
      idle.push({ key, pid, lastUsed })
    }
    const idleMs = workerIdleMs ?? this.workerIdleMs
    const warmFloor = Math.min(Math.max(0, keepWarm ?? this.minWarm), idle.length)
    idle.sort((a, b) => (b.lastUsed - a.lastUsed) || (a.pid - b.pid))
    // 最近用过的 warmFloor 个即使空闲也留着（温热池），其余空闲够久才停。
    const toStop = idle.slice(warmFloor).filter((item) => now - item.lastUsed >= idleMs)
    for (const item of toStop) {
      if (typeof this.cleanupWorker === 'function') {
        try {
          const closed = await this.cleanupWorker(item.pid, { timeoutMs: 30_000 })
          counters.closedDocs += Array.isArray(closed?.closed) ? closed.closed.length : 0
        } catch { /* 清理失败也要停，不能因为一个实例卡住整轮回收 */ }
      }
      if (this.stopWorker(item.pid) !== false) counters.stoppedWorkers += 1
    }
    counters.keptWarm = warmFloor

    if (startup) {
      for (const entry of readInstances(this.file, { now }).instances) {
        if (entry.tag !== 'test') continue
        const startedAt = Date.parse(entry.startedAt ?? entry.lastUsedAt ?? entry.lastSeen ?? '')
        const age = Number.isFinite(startedAt) ? now - startedAt : Number.POSITIVE_INFINITY
        if (age < this.staleTestMs) continue
        if (!rotPids.has(entry.pid) && !this.isAlive(entry.pid)) continue
        const outcome = await this.#reapOne(entry.pid, { includeDocs, force: true })
        counters.closedDocs += outcome.closedDocs
        counters.quitInstances += outcome.quit ? 1 : 0
        counters.stoppedWorkers += outcome.stoppedWorker ? 1 : 0
        counters.reaped.push({ pid: entry.pid, launchedBy: entry.launchedBy, tag: entry.tag, quit: outcome.quit, killed: outcome.killed, staleTest: true })
      }
    }

    const reaped = await this.reap({ tag: null, dryRun: false, includeDocs, force: false, graceMs: graceMs ?? this.graceMs, reason: 'maintenance' })
    counters.stoppedWorkers += reaped.stoppedWorkers
    counters.quitInstances += reaped.quitInstances
    counters.closedDocs += reaped.closedDocs
    counters.removedEntries += reaped.removedEntries
    counters.reaped.push(...reaped.reaped)
    counters.skipped.push(...reaped.skipped)
    return counters
  }
}

/** 只有登记表里的 pid 会被强杀：这个判断放在这里，调用方不需要再重复一遍。 */
export function registeredPids(file = defaultInstancesFile()) {
  return new Set(readInstances(file).instances.map((entry) => entry.pid))
}

export function instanceFileExists(file = defaultInstancesFile()) {
  return existsSync(file)
}

// 供测试/诊断：把放久了的老条目清掉（不碰进程）。
export function pruneRegistry(file = defaultInstancesFile(), { olderThanMs = 7 * 24 * 3_600_000, now = Date.now() } = {}) {
  return updateInstances(file, (entries) => entries.filter((entry) => {
    const seen = Date.parse(entry.lastSeen ?? '')
    return !Number.isFinite(seen) || now - seen < olderThanMs
  }), { now })
}

/**
 * B5：给直连桥接器找「这个会话绑的是哪个 pid」，同步读登记表，不需要 broker。
 *
 * 为什么需要它：server.mjs 只在有 SW_MCP_INSTANCE 环境变量时才给桥接器传
 * `--instance`（server.mjs:467-469），而 cordis.patch.yml 只设了 SW_MCP_BROKER=1，
 * 于是每个会话的直连桥接器都是 ExpectedPid=0 —— 它 attach 的是「用户当前激活的
 * 窗口」，也就是本轮要切断的那条路径。server.mjs 是别人在改的文件，这里只把
 * 数据准备好，让那一行 `args.push('--instance', String(boundPid))` 有东西可传：
 *
 *   import { boundPidForSession } from './broker/instances.mjs'
 *   const boundPid = Number(process.env.SW_MCP_INSTANCE) || boundPidForSession(SW_CLIENT_ID)
 *
 * 只认 ownerClients 里出现该会话、且 launchedBy 是 broker/test 的实例：用户实例
 * 永远不会被回传（即使登记表把某个会话挂到了用户实例上，那是旧 bug 留下的脏数据）。
 *
 * @param {string|null} clientId 形如 mcp:<server pid>
 * @param {{file?:string, env?:object, requireAlive?:boolean}} [options]
 * @returns {number} 绑定的 pid，没有就 0
 */
export function boundPidForSession(clientId, { file = defaultInstancesFile(), env = process.env, requireAlive = true } = {}) {
  const key = clientId ? String(clientId) : ''
  if (!key) return 0
  let state = null
  try { state = readInstances(file, { now: Date.now() }) } catch { return 0 }
  const candidates = (state?.instances ?? [])
    .filter((entry) => (entry.ownerClients ?? []).map(String).includes(key))
    .filter((entry) => isServiceInstance(entry))
    .sort((a, b) => (Date.parse(b.lastUsedAt ?? b.lastSeen ?? '') || 0) - (Date.parse(a.lastUsedAt ?? a.lastSeen ?? '') || 0))
  if (candidates.length === 0) return 0
  const pid = Number(candidates[0].pid)
  if (!Number.isInteger(pid) || pid <= 0) return 0
  if (requireAlive) {
    try { process.kill(pid, 0) } catch { return 0 }
  }
  // 有 broker 时还可以用 broker 的 bound() 交叉验证；离线/无 broker 时就信登记表。
  void env
  return pid
}

