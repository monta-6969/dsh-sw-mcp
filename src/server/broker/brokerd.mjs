// 常驻 broker：跨 MCP 会话持有作业与（后续）SolidWorks 实例。
//
// 现在还没有 STA worker，所以 instances 只登记不驱动；但作业、幂等键与
// 回收已经按契约工作。worker 接入后，jobs.transition 的调用方从测试变成
// 真正的实例驱动。
import net from 'node:net'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { brokerPipeName, encodeMessage, LineDecoder, BROKER_PROTOCOL_VERSION, requestClientId } from './protocol.mjs'
import { JobStore, JobStoreError } from '../jobs.mjs'
import { Worker } from './workers.mjs'
import {
  InstanceManager,
  MAINTENANCE_INTERVAL_MS,
  defaultInstancesFile,
  preflightLaunch,
} from './instances.mjs'

const DEFAULT_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'sw-mcp', 'broker')

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const pipe = brokerPipeName({ override: argValue('--pipe', brokerPipeName()) })
const dir = argValue('--dir', process.env.SW_MCP_BROKER_DIR ?? DEFAULT_DIR)
const jobsDir = join(dir, 'jobs')
mkdirSync(jobsDir, { recursive: true })
const jobs = new JobStore({ dir: jobsDir })
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
// 识别「这个进程加载的 brokerd 源码」是不是当前盘上的那一版：客户端拿它和本地
// 文件哈希对比，旧进程会被要求退出并换成新代码，避免测试跑到上一版语义。
// 哈希必须由本进程自己算：写成字面量就会在 brokerd.mjs 再被改一次之后永久
// 对不上（客户端每次都算盘上那一版），job 类调用全部 BROKER_VERSION_MISMATCH。
// 口径只用于诊断：客户端发现不一致会让旧 broker 退出并换成新代码，而不是硬拒。
const BROKER_SOURCE_HASH = createHash('sha256')
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex')
  .slice(0, 16)
const workers = new Map()
const workerLastUsed = new Map()
// 每个 MCP 会话绑定一个 SOLIDWORKS 实例：两个会话同时建模时不能抢同一个
// 活动文档。clientId 由 server.mjs 传入（会话环境变量或服务进程 pid）。
const clientPid = new Map()
/** 会话 id 形如 mcp:<server pid>：服务进程没了就把实例让出来，避免每开一个新会话
 * 就多起一个 SOLIDWORKS。显式 SW_MCP_SESSION_ID 无法查进程，按存活处理。 */
function clientAlive(clientId) {
  const match = /^mcp:(\d+)$/.exec(String(clientId ?? ''))
  if (!match) return true
  try { process.kill(Number(match[1]), 0); return true } catch { return false }
}
// broker 退出（正常关停、被 kill、父进程消失）时不要把 SwBridge.exe 留在后台。
for (const signal of ['exit', 'SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const worker of workers.values()) worker.stop()
  })
}

function touchWorker(key) {
  workerLastUsed.set(key, Date.now())
}

/** 停掉某个实例的 worker（不碰 SOLIDWORKS 进程）。返回是否真的停了一个。 */
function stopWorkerInstance(instancePid) {
  const key = Number(instancePid) || 0
  const worker = workers.get(key)
  if (!worker) return false
  try { worker.stop() } catch { /* 已经在退 */ }
  workers.delete(key)
  workerLastUsed.delete(key)
  for (const [clientId, pid] of clientPid) {
    if (Number(pid) === key) clientPid.delete(clientId)
  }
  return true
}

/** 收掉实例上由代理创建、尚未存盘的文档；quit 之前先做，别把脏文档留在用户窗口里。 */
async function cleanupWorkerInstance(instancePid, { timeoutMs = 30_000 } = {}) {
  const worker = workerFor(instancePid)
  return worker.request('cleanup', {}, { timeoutMs })
}

/** 只退这个 pid 的 SOLIDWORKS（worker 用 --instance 绑定，不会认错窗口）。 */
async function quitWorkerInstance(instancePid, { timeoutMs = 60_000 } = {}) {
  const worker = workerFor(instancePid)
  return worker.request('quit', {}, { timeoutMs })
}

/** 最后手段：只对登记表里的 pid 用 Stop-Process -Id，绝不按进程名全杀。 */
function forceStopProcess(instancePid) {
  const pid = Number(instancePid)
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function workerCommand() {
  if (process.env.SW_MCP_BROKER_WORKER_CMD) {
    try {
      const parsed = JSON.parse(process.env.SW_MCP_BROKER_WORKER_CMD)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    } catch {
      // 保持默认：一个坏的测试配置不该让 broker 起不来。
    }
  }
  return [process.env.SW_MCP_BRIDGE_EXE ?? join(repoRoot, 'bridge', 'bin', 'SwBridge.exe'), '--worker']
}

function workerFor(instancePid) {
  const key = instancePid || 0
  let worker = workers.get(key)
  if (worker && !worker.closed) return worker
  worker = new Worker({ command: workerCommand(), instancePid: key })
  worker.start()
  workers.set(key, worker)
  touchWorker(key)
  return worker
}

/** 健康探针：只读枚举 ROT，**绝不** attach。
 *
 * R12 之前这里起的是裸 `SwBridge.exe`（既无 --worker 也无 --instance），于是每次
 * 探针都走 SwHost 的 ExpectedPid==0 分支 → Marshal.GetActiveObject("SldWorks.Application")
 * → 连上用户自己正在用的那个窗口。2026-11-15 的日志里它一分钟连 2 次用户实例
 * （136 条 ATTACHED_BY_ACTIVE_OBJECT 全部是 pid 22076）。现在命令里带 --no-attach：
 * 桥接器在该模式下只会枚举 ROT，任何 attach 尝试都直接抛 INSTANCE_NOT_BOUND。 */
function probeBridge(op, args = {}, timeoutMs = 15_000) {
  return new Promise((resolvePromise) => {
    const command = workerCommand().filter((part) => part !== '--worker')
    command.push('--no-attach')
    let child
    try {
      child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch (error) {
      resolvePromise({ error: error.message })
      return
    }
    let out = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { }
      resolvePromise(value)
    }
    const timer = setTimeout(() => finish({ error: 'BRIDGE_PROBE_TIMEOUT' }), timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
      const line = out.split('\n').find((item) => item.trim().length > 0)
      if (!line) return
      try {
        const parsed = JSON.parse(line)
        finish({ ...parsed, error: parsed.ok === false ? parsed.code ?? 'BRIDGE_ERROR' : null })
      } catch {
        // 等下一行；桥接器可能先打日志。
      }
    })
    child.on('error', (error) => finish({ error: error.message }))
    child.on('exit', () => finish({ error: 'BRIDGE_PROBE_EXITED' }))
    child.stdin.write(`${JSON.stringify({ id: 1, op, ...args })}\n`)
  })
}

function probeInstances(timeoutMs = 15_000) {
  return probeBridge('instances', {}, timeoutMs)
}

// ------------------------------------------------------ 启动目标 / 启动 / 盯守
// 桌面快捷方式在本机的目标是一个 MSI 广告入口，从 detached 进程里 Start-Process
// 它只会退出而不落进程（实测 0 个 SLDWORKS），所以优先直接起 SLDWORKS.exe。
const DEFAULT_SW_EXE = 'C:\\Program Files\\SOLIDWORKS Corp\\SOLIDWORKS\\SLDWORKS.exe'
const DEFAULT_SW_LNK = 'C:\\Users\\mota\\Desktop\\sw\\SOLIDWORKS Design 2026.lnk'

/** 解析要启动的目标：SW_MCP_SW_EXE → SLDWORKS.exe → 桌面快捷方式。 */
function resolveLaunchTarget() {
  const exe = process.env.SW_MCP_SW_EXE ?? DEFAULT_SW_EXE
  const target = process.env.SW_MCP_SW_LAUNCH ?? (existsSync(exe) ? exe : DEFAULT_SW_LNK)
  return { target, kind: target.toLowerCase().endsWith('.exe') ? 'exe' : 'lnk', exePath: exe }
}

// PowerShell 的 Start-Process 在收到含反斜杠的 -FilePath 时偶尔报
// InvalidOperationException（同一路径改成 / 就成功），这里统一用正斜杠。
const psPath = (value) => value.replace(/'/g, "''").replace(/\\/g, '/')

/**
 * 启动 SOLIDWORKS，并把「本次启动的 pid」带回来。
 * Start-Process -PassThru 的 Id 是启动守卫绑定 lease 的第一份证据；拿不到
 * （快捷方式由别的进程代理时）就退回不带 pid 的启动，靠 ROT 新出现的 pid 认领。
 */
function launchSolidworks() {
  const resolved = resolveLaunchTarget()
  const target = resolved.target
  const workingDirectory = resolved.kind === 'exe' ? dirname(target) : null
  const file = psPath(target)
  const start = (extra) => `Start-Process -FilePath '${file}'`
    + (workingDirectory ? ` -WorkingDirectory '${psPath(workingDirectory)}'` : '')
    + extra
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $p = ${start(' -PassThru')}`,
    "  if ($p) { Write-Output ('PID=' + $p.Id) }",
    '} catch {',
    '  try {',
    `    ${start('')}`,
    "  } catch { Write-Output ('ERROR=' + $_.Exception.Message) }",
    '}',
  ].join('\n')

  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn('powershell', ['-NoProfile', '-Command', script], {
        // 不要 detached：实测 detached 的 powershell 里 Start-Process 只退出、
        // 不落 SLDWORKS 进程；非 detached 的等价启动正常。
        detached: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      })
    } catch (error) {
      resolvePromise({ launched: false, target, error: error.message })
      return
    }
    let out = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.unref() } catch { /* 已经很退了 */ }
      if (value.launched) {
        console.error(`[broker] 已发出启动 ${target}${value.pid ? ` pid ${value.pid}` : '（pid 未知，靠 ROT 认领）'}，开始盯守`)
      }
      resolvePromise(value)
    }
    // Start-Process 本身很快；20 秒还没输出就按「已发出启动、pid 未知」处理，
    // 交给盯守用 ROT 判生死，不在这里阻塞。
    const timer = setTimeout(() => finish({ launched: true, target, pid: 0, warning: 'PID_TIMEOUT' }), 20_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
      const pidMatch = /PID=(\d+)/.exec(out)
      if (pidMatch) finish({ launched: true, target, pid: Number(pidMatch[1]) })
    })
    child.on('error', (error) => finish({ launched: false, target, error: error.message }))
    child.on('exit', () => {
      const pidMatch = /PID=(\d+)/.exec(out)
      const errorMatch = /ERROR=(.+)/.exec(out)
      if (pidMatch) finish({ launched: true, target, pid: Number(pidMatch[1]) })
      else if (errorMatch) finish({ launched: false, target, error: errorMatch[1].trim() })
      else finish({ launched: true, target, pid: 0 })
    })
  })
}

// ------------------------------------------- 窗口 / #32770 弹窗采样（盯守用）
// 一次启动只起一个常驻 powershell 采样器：Add-Type 编译一次，之后每 2 秒输出一
// 行 JSON（目标 pid 的顶层窗口 + #32770 模态对话框及其子控件文本），broker 侧只
// 取最新一帧。拿不到（权限/编译失败）就返回 ok:false，判定退回「只看 ROT」。
//
// 编码（真机缺陷 C）：powershell.exe 的 stdout 默认按控制台代码页（中文机器 936）
// 输出，broker 侧按 UTF-8 解码就把中文对话框正文全变成「����」。这里在写任何输出
// 之前显式把 [Console]::OutputEncoding 设成 UTF-8（无 BOM），文本统一走
// GetWindowTextLengthW + GetWindowTextW（Unicode API），不再 ANSI/UTF-8 混用。
const WINDOW_PROBE_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SwWinProbe {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int max);
  // 长度先问 GetWindowTextLengthW，再按实际长度取 Unicode 文本：不截断、不做 ANSI 转换。
  static string Txt(IntPtr h) {
    int len = GetWindowTextLengthW(h);
    if (len < 0) len = 0;
    var sb = new StringBuilder(len + 2);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }
  static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
  static string Q(string s) {
    if (s == null) return "\"\"";
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '\"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c < 32) b.Append(' ');
      else b.Append(c);
    }
    return b.Append('\"').ToString();
  }
  // 一帧的窗口快照。分两步是因为 UIA 正文要靠 PowerShell 侧取（见下面的 $uiaReady），
  // 而 JSON 序列化留在 C# 里做：Scan 收窗口，PowerShell 补 uiaTexts，Emit 出 JSON。
  public class WinInfo {
    public IntPtr H;
    public string Title = "";
    public string Cls = "";
    public bool Vis;
    public List<string> Kids = new List<string>();
    public List<string> KidObjs = new List<string>();
    public List<string> UiaTexts = new List<string>();
  }
  public static List<WinInfo> Last = new List<WinInfo>();
  public static List<IntPtr> LastDialogs = new List<IntPtr>();
  // UIA 正文采集是否可用：由 PowerShell 侧在编译成功后置 true，Emit 带进帧里。
  public static bool UiaReady = false;

  public static void Scan(int targetPid) {
    Last = new List<WinInfo>();
    LastDialogs = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if ((int)pid != targetPid) return true;
      var w = new WinInfo();
      w.H = h; w.Title = Txt(h); w.Cls = Cls(h); w.Vis = IsWindowVisible(h);
      if (w.Cls == "#32770") {
        EnumChildWindows(h, (ch, cl) => {
          string t = Txt(ch); string kc = Cls(ch);
          if (t != null && t.Trim().Length > 0) {
            w.Kids.Add(t.Trim());
            w.KidObjs.Add("{\"class\":" + Q(kc) + ",\"text\":" + Q(t.Trim()) + "}");
          }
          return true;
        }, IntPtr.Zero);
        LastDialogs.Add(h);
      }
      Last.Add(w);
      return true;
    }, IntPtr.Zero);
  }

  /// 给第 index 个 #32770 补 UIA 正文。越界/空都静默忽略。
  public static void SetUiaTexts(int index, string[] texts) {
    if (index < 0 || index >= LastDialogs.Count) return;
    for (int i = 0; i < Last.Count; i++) {
      if (Last[i].H != LastDialogs[index]) continue;
      Last[i].UiaTexts = new List<string>();
      if (texts != null) {
        foreach (string t in texts) {
          if (t == null) continue;
          string v = t.Trim();
          if (v.Length == 0) continue;
          if (!Last[i].UiaTexts.Contains(v)) Last[i].UiaTexts.Add(v);
        }
      }
      return;
    }
  }

  public static string Emit(int targetPid) {
    var sb = new StringBuilder();
    // uiaReady 是诊断位：UIA 正文采集是否真的可用。它必须出现在帧里，
    // 否则「UIA 静默降级」就完全不可观测 —— 正文采不到、白名单不命中、
    // 盯守 120 秒后杀进程，而日志里看不到任何原因（2026-11-16 踩过的坑）。
    sb.Append("{\"pid\":" + targetPid + ",\"uiaReady\":" + (UiaReady ? "true" : "false") + ",\"wins\":[");
    for (int i = 0; i < Last.Count; i++) {
      var w = Last[i];
      if (i > 0) sb.Append(",");
      var kb = new StringBuilder();
      for (int j = 0; j < w.Kids.Count; j++) { if (j > 0) kb.Append(","); kb.Append(Q(w.Kids[j])); }
      var ko = new StringBuilder();
      for (int j = 0; j < w.KidObjs.Count; j++) { if (j > 0) ko.Append(","); ko.Append(w.KidObjs[j]); }
      // uiaTexts 是「增强」字段：UIA 不可用时是空数组，老字段一个不少。
      var ut = new StringBuilder();
      for (int j = 0; j < w.UiaTexts.Count; j++) { if (j > 0) ut.Append(","); ut.Append(Q(w.UiaTexts[j])); }
      sb.Append("{\"title\":" + Q(w.Title) + ",\"class\":" + Q(w.Cls) + ",\"visible\":" + (w.Vis ? "true" : "false")
        + ",\"children\":[" + kb.ToString() + "],\"kids\":[" + ko.ToString() + "],\"uiaTexts\":[" + ut.ToString() + "]}");
    }
    sb.Append("]}");
    return sb.ToString();
  }

  public static string Sample(int targetPid) { Scan(targetPid); return Emit(targetPid); }
}
'@
# UIA 正文采集器：独立编译、独立失败。它只是「增强」——拿到就补全正文，
# 拿不到（缺程序集/权限不足/目标控件不支持）就整段跳过，采样器行为与以前完全一致。
#
# 为什么这里要把失败原因一路带到 JSON 帧和日志文件里：
#   采样器是 spawn 出来的，broker 用 stdio:['ignore','pipe','ignore'] —— **stderr 被丢弃**。
#   所以「UIA 静默降级」原本完全不可观测：正文采不到 → 白名单不命中 → 盯守 120 秒
#   后杀进程，而日志里一个字都看不出来。2026-11-16 就是这么被坑的。
#   现在 uiaReady / uiaError 随每帧 JSON 上报，同时单独写一行到日志文件。
$UiaReady = $false
$UiaError = ''
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
  $UiaRefs = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.AutomationIdentifier].Assembly.Location)
  Add-Type -ReferencedAssemblies $UiaRefs -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Windows.Automation;
public static class SwWinProbeUia {
  // 只取 Text / Hyperlink 节点的 Name：这是 #32770 里 DirectUIHWND 正文的可靠来源，
  // GetWindowTextW 对 DirectUI 容器返回空串，所以旧采样器只能拿到按钮和标题。
  public static string[] Texts(IntPtr hWnd) {
    var list = new List<string>();
    try {
      AutomationElement root = AutomationElement.FromHandle(hWnd);
      if (root == null) return list.ToArray();
      AutomationElementCollection all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
      foreach (AutomationElement e in all) {
        ControlType ct; string name;
        try { ct = e.Current.ControlType; name = e.Current.Name; } catch (Exception) { continue; }
        if (ct != ControlType.Text && ct != ControlType.Hyperlink) continue;
        if (name == null) continue;
        string v = name.Trim();
        if (v.Length == 0) continue;
        if (!list.Contains(v)) list.Add(v);
      }
    } catch (Exception) { }
    return list.ToArray();
  }
}
'@ -ErrorAction Stop
  if (('SwWinProbeUia' -as [type])) { $UiaReady = $true } else { $UiaError = 'type-not-created' }
} catch {
  $UiaReady = $false
  $msg = ''
  try { $msg = [string]$_.Exception.Message } catch { }
  if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) }
  $UiaError = $msg
}
# 把 UIA 可用性告诉 C# 侧，它会带进每一帧 JSON 的 uiaReady 字段。
[SwWinProbe]::UiaReady = $UiaReady
# 同时落一行到 broker 日志目录：即使 stdout 解析出问题，也能事后查证。
try {
  $LogDir = Join-Path $env:LOCALAPPDATA 'sw-mcp\logs'
  if (Test-Path $LogDir) {
    $Line = ((Get-Date).ToUniversalTime().ToString('o')) + ' [launch-probe] pid=' + $TargetPid + ' uiaReady=' + $UiaReady.ToString().ToLower() + ' uiaError=' + ($UiaError -replace "[\x0d\x0a]", ' ') + ' psVersion=' + $PSVersionTable.PSVersion.ToString()
    [System.IO.File]::AppendAllText((Join-Path $LogDir 'launch-probe.log'), $Line + [Environment]::NewLine)
  }
} catch { }
$deadline = [DateTime]::UtcNow.AddMilliseconds($DurationMs)
$first = $true
$UiaHitTotal = 0
while ($first -or ([DateTime]::UtcNow -lt $deadline)) {
  $first = $false
  [SwWinProbe]::Scan($TargetPid)
  $UiaHitTotal = 0
  if ($UiaReady) {
    for ($i = 0; $i -lt [SwWinProbe]::LastDialogs.Count; $i++) {
      try { [SwWinProbe]::SetUiaTexts($i, [SwWinProbeUia]::Texts([SwWinProbe]::LastDialogs[$i])) } catch { }
    }
    for ($i = 0; $i -lt [SwWinProbe]::Last.Count; $i++) { $UiaHitTotal += [SwWinProbe]::Last[$i].UiaTexts.Count }
  }
  [Console]::Out.WriteLine([SwWinProbe]::Emit($TargetPid))
  [Console]::Out.Flush()
  if ($DurationMs -le 0) { break }
  Start-Sleep -Milliseconds $IntervalMs
}
`.trim()

const windowSamplers = new Map()

/**
 * 自动应答启动确认框（「是否继续加载 SOLIDWORKS CAM 2026」→「是」；
 * 「无法生成日志文件…另一个 SOLIDWORKS 程序可能已经在此机器上运行」→「确定」；
 * 「是否继续加载 3DEXPERIENCE Marketplace」→「是，继续加载…」）。
 *
 * 安全约束（这里每一行都在为它服务）：只枚举 owner pid == 本次 lease pid 的顶层
 * 窗口、只认 class == "#32770" 的对话框、只点子控件里 class 为 Button 且文本是
 * 肯定（是/确定/继续/Yes/OK/Accept）的那一个。绝不按窗口标题/进程名去找——用户
 * 自己正在用的 SOLIDWORKS 弹窗不能被 broker 点掉。每次调用都重新枚举窗口，不缓存 hwnd。
 *
 * 编码（真机缺陷 C）：输出前把 [Console]::OutputEncoding 设成 UTF-8，按钮文本走
 * GetWindowTextLengthW + GetWindowTextW（Unicode），避免按钮文本乱码导致误点。
 */
const PROMPT_CLICK_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SwPromptClicker {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  const uint BM_CLICK = 0x00F5;
  static string Txt(IntPtr h) {
    int len = GetWindowTextLengthW(h);
    if (len < 0) len = 0;
    var sb = new StringBuilder(len + 2);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }
  static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
  static string Q(string s) {
    if (s == null) return "\"\"";
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '\"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c < 32) b.Append(' ');
      else b.Append(c);
    }
    return b.Append('\"').ToString();
  }
  // 确认框的肯定按钮：是 / yes / 确定 / 继续 / OK / 接受 / accept。
  // 「否，禁用…」「取消」「关闭」「No」一律不算——绝不替用户做否定选择。
  static bool IsAccept(string t) {
    if (string.IsNullOrEmpty(t)) return false;
    string v = t.Trim();
    string low = v.ToLower();
    if (v.StartsWith("否") || v.StartsWith("取消") || v.StartsWith("关闭")) return false;
    if (low.StartsWith("no") || low.StartsWith("cancel") || low.StartsWith("close")) return false;
    if (v.Contains("是") || v.Contains("确定") || v.Contains("继续") || v.Contains("接受")) return true;
    if (low.Contains("yes") || low.Contains("accept")) return true;
    return low == "ok" || low.StartsWith("ok ") || low.StartsWith("ok(");
  }
  public static string Click(int targetPid, string want) {
    int dialogs = 0;
    var clicked = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if ((int)pid != targetPid) return true;         // 只认本次 lease 的进程
      if (Cls(h) != "#32770") return true;            // 只认模态对话框
      if (!IsWindowVisible(h)) return true;
      dialogs++;
      string dialogTitle = Txt(h);
      IntPtr exact = IntPtr.Zero, loose = IntPtr.Zero;
      string exactText = null, looseText = null, exactTitle = null, looseTitle = null;
      EnumChildWindows(h, (ch, cl) => {
        if (Cls(ch) != "Button") return true;         // 只认标准按钮
        string t = Txt(ch);
        if (!IsAccept(t)) return true;
        if (want != null && want.Length > 0 && t.Trim() == want.Trim() && exact == IntPtr.Zero) { exact = ch; exactText = t.Trim(); exactTitle = dialogTitle; }
        if (loose == IntPtr.Zero) { loose = ch; looseText = t.Trim(); looseTitle = dialogTitle; }
        return true;
      }, IntPtr.Zero);
      IntPtr target = exact != IntPtr.Zero ? exact : loose;
      string label = exact != IntPtr.Zero ? exactText : looseText;
      string owner = exact != IntPtr.Zero ? exactTitle : looseTitle;
      if (target != IntPtr.Zero) {
        SendMessage(target, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
        clicked.Add("{\"text\":" + Q(label) + ",\"dialog\":" + Q(owner) + "}");
      }
      return true;
    }, IntPtr.Zero);
    var sb = new StringBuilder();
    sb.Append("{\"ok\":true,\"pid\":" + targetPid + ",\"dialogs\":" + dialogs + ",\"clicked\":[");
    for (int i = 0; i < clicked.Count; i++) { if (i > 0) sb.Append(","); sb.Append(clicked[i]); }
    sb.Append("]}");
    return sb.ToString();
  }
}
'@
[Console]::Out.WriteLine([SwPromptClicker]::Click($TargetPid, $Want))
[Console]::Out.Flush()
`.trim()

/**
 * 点本次 lease pid 的 CAM 询问框「是/继续」按钮。返回 {ok,pid,clicked:[{text}]}；
 * 任何失败（编译失败/超时/找不到按钮）都是 ok:false，绝不当成「已经应答」。
 */
function clickPromptButton({ pid, button } = {}) {
  const target = Number(pid)
  if (!Number.isInteger(target) || target <= 0) {
    return Promise.resolve({ ok: false, error: 'NO_PID', clicked: [] })
  }
  const want = String(button ?? '').replace(/'/g, "''")
  const script = [`$TargetPid = ${Math.floor(target)}`, `$Want = '${want}'`, PROMPT_CLICK_PS].join('\n')
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch (error) {
      resolvePromise({ ok: false, error: error.message, clicked: [] })
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
    const timer = setTimeout(() => finish({ ok: false, error: 'CLICK_TIMEOUT', clicked: [] }), 8_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
      const line = out.split('\n').map((item) => item.trim()).find((item) => item.startsWith('{'))
      if (!line) return
      try {
        const parsed = JSON.parse(line)
        const clicked = Array.isArray(parsed.clicked) ? parsed.clicked : []
        finish({
          ok: parsed.ok === true && clicked.length > 0,
          pid: target,
          dialogs: Number(parsed.dialogs) || 0,
          clicked,
          error: clicked.length > 0 ? null : 'NO_ACCEPT_BUTTON',
        })
      } catch { /* 半行/坏行：等下一行或超时 */ }
    })
    child.on('error', (error) => finish({ ok: false, error: error.message, clicked: [] }))
    child.on('exit', () => finish({ ok: false, error: 'CLICK_EXITED', clicked: [] }))
  })
}

/**
 * 拼一个 #32770 的正文。
 *
 * 真机缺陷（2026-11-16）：SW 冷启动的「工具栏信息不一致。将使用默认工具栏设定。」
 * 是 comctl32 TaskDialog，正文在 DirectUIHWND 里，GetWindowTextW 对 DirectUI 容器
 * 返回空串 —— 旧实现拼出来的 text 只有 `SOLIDWORKS Design SOLIDWORKS Design 确定`
 * （标题重复两遍 + 按钮名），正文一个字都没有，白名单永远匹配不上。
 *
 * 现在：优先用 UIA 采到的 uiaTexts（能穿透 DirectUI），没有才退回 children。
 * 去重只做两件事，避免误删正文：
 *   ① 与 title 完全相同的那一段，只保留第一次出现（老实现把标题拼了两遍）；
 *   ② 与某个按钮文本完全相同的那一段，只保留第一次出现（按钮名不是正文）。
 *      —— 正文里恰好与标题/按钮同名的词只会被「保留一份」，不会被整段删掉。
 */
function joinDialogText(win) {
  const title = String(win?.title ?? '').trim()
  const kids = Array.isArray(win?.kids) ? win.kids : []
  const buttons = new Set(
    kids
      .filter((kid) => String(kid?.class ?? '').toLowerCase() === 'button')
      .map((kid) => String(kid?.text ?? '').trim())
      .filter(Boolean),
  )
  const uiaTexts = Array.isArray(win?.uiaTexts) ? win.uiaTexts : []
  // UIA 拿得到就用 UIA 的（按节点顺序，本身就是正文顺序）；拿不到退回子控件文本。
  const source = uiaTexts.length > 0
    ? uiaTexts
    : (Array.isArray(win?.children) ? win.children : [])
  const parts = []
  const seen = new Set()
  for (const raw of [title, ...source]) {
    const value = String(raw ?? '').trim()
    if (!value) continue
    // 归一化后比对（全角/半角、空白差异不该造成重复）
    const key = value.replace(/\s+/g, ' ')
    if (seen.has(key)) continue
    seen.add(key)
    parts.push(value)
  }
  // 标题是「身份」不是「正文」，单列；正文里不再重复标题。
  const body = parts.filter((part, index) => !(index > 0 && part === title))
  return body.join(' ').replace(/\s+/g, ' ').trim()
}

/** 把采样器输出的一帧转成 instances.mjs 认的形态（只带这个 pid 的窗口）。 */
function parseWindowSample(raw, pid) {
  const wins = Array.isArray(raw?.wins) ? raw.wins : []
  const dialogs = wins
    .filter((win) => String(win?.class ?? '') === '#32770')
    .map((win) => {
      const kids = Array.isArray(win?.kids) ? win.kids : []
      // 按钮清单：盯守侧靠它判「这是询问框」并决定点哪一个（只认 Button 类）。
      const buttons = kids
        .filter((kid) => String(kid?.class ?? '').toLowerCase() === 'button')
        .map((kid) => String(kid?.text ?? '').trim())
        .filter(Boolean)
      return {
        pid,
        class: '#32770',
        title: String(win?.title ?? ''),
        text: joinDialogText(win),
        buttons,
      }
    })
  const main = wins.find((win) => win?.visible === true
    && String(win?.class ?? '') !== '#32770'
    && String(win?.title ?? '').trim().length > 0) ?? null
  return {
    ok: true,
    pid,
    at: new Date().toISOString(),
    alive: wins.length > 0,
    // UIA 正文采集是否真的可用。false 意味着正文会丢掉、白名单可能不命中 ——
    // 这个位必须一路传到日志里，否则「静默降级」无法诊断。
    uiaReady: raw?.uiaReady === true,
    hasMainWindow: Boolean(main),
    mainWindowTitle: main ? String(main.title) : '',
    dialogs,
  }
}

function startWindowSampler(instancePid, { durationMs = 120_000, intervalMs = 2_000 } = {}) {
  const pid = Number(instancePid) || 0
  const state = { pid, latest: null, error: null, closed: false, startedAt: Date.now(), stop: () => {} }
  if (!Number.isInteger(pid) || pid <= 0) {
    state.error = 'NO_PID'
    state.closed = true
    return state
  }
  const script = [
    `$TargetPid = ${Math.floor(pid)}`,
    `$DurationMs = ${Math.max(0, Math.floor(durationMs))}`,
    `$IntervalMs = ${Math.max(100, Math.floor(intervalMs))}`,
    WINDOW_PROBE_PS,
  ].join('\n')
  let child
  try {
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  } catch (error) {
    state.error = error.message
    state.closed = true
    return state
  }
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line.startsWith('{')) continue
      try { state.latest = parseWindowSample(JSON.parse(line), pid) } catch { /* 半行/坏行忽略，下一帧再说 */ }
    }
  })
  child.on('error', (error) => { state.error = error.message })
  child.on('exit', () => { state.closed = true })
  state.stop = () => { try { child.kill() } catch { /* 已经退了 */ } state.closed = true }
  state.childPid = child.pid
  return state
}

/**
 * 盯守采样：同一 pid 复用一个采样器，返回最新一帧（第一帧最多等 4 秒）。
 *
 * 每帧都带 uiaReady：UIA 正文采集是否可用。它一旦是 false，正文就会丢，
 * 白名单可能因此不命中 —— 而这一路是「静默」的（采样器 stderr 被 ignore 丢弃），
 * 所以这里必须把状态打出来，且**只在状态变化时打**，避免每 2 秒刷一行。
 */
const uiaStateLogged = new Map()
async function sampleWindowForPid(instancePid, { durationMs = 120_000, intervalMs = 2_000 } = {}) {
  const pid = Number(instancePid) || 0
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: 'NO_PID', hasMainWindow: false, mainWindowTitle: '', dialogs: [] }
  }
  let sampler = windowSamplers.get(pid)
  const stale = sampler && Date.now() - sampler.startedAt > Math.max(durationMs, 30_000) + 25_000
  if (!sampler || sampler.closed || stale) {
    sampler?.stop?.()
    sampler = startWindowSampler(pid, { durationMs: Math.max(durationMs + 20_000, 30_000), intervalMs })
    windowSamplers.set(pid, sampler)
    uiaStateLogged.delete(pid)
  }
  if (sampler.latest) {
    if (uiaStateLogged.get(pid) !== sampler.latest.uiaReady) {
      uiaStateLogged.set(pid, sampler.latest.uiaReady)
      if (sampler.latest.uiaReady) {
        console.error(`[broker] 窗口采样 pid ${pid}：UIA 正文采集可用（#32770 的 DirectUI 正文能读全）`)
      } else {
        console.error(`[broker] 警告 窗口采样 pid ${pid}：UIA 正文采集不可用，已降级到 GetWindowText —— `
          + `DirectUI 正文会丢，白名单可能不命中（详见 %LOCALAPPDATA%\\sw-mcp\\logs\\launch-probe.log）`)
      }
    }
    return sampler.latest
  }
  const waitUntil = Date.now() + Math.min(Math.max(intervalMs, 500), 4_000)
  while (Date.now() < waitUntil) {
    await sleep(120)
    if (sampler.latest) return sampler.latest
    if (sampler.closed) break
  }
  return { ok: false, error: sampler.error ?? 'NO_WINDOW_SAMPLE', hasMainWindow: false, mainWindowTitle: '', dialogs: [] }
}

/** 预检采样：只取一帧（DurationMs=0），拿不到就 ok:false（预检会跳过许可检查）。 */
async function sampleWindowOnce(instancePid) {
  const pid = Number(instancePid) || 0
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: 'NO_PID', dialogs: [] }
  const sampler = startWindowSampler(pid, { durationMs: 0, intervalMs: 1_000 })
  const waitUntil = Date.now() + 8_000
  while (Date.now() < waitUntil) {
    if (sampler.latest) break
    if (sampler.closed) break
    await sleep(120)
  }
  sampler.stop()
  return sampler.latest
    ?? { ok: false, error: sampler.error ?? 'NO_WINDOW_SAMPLE', hasMainWindow: false, mainWindowTitle: '', dialogs: [] }
}

/** 预检入口：判定逻辑在 instances.mjs，这里只提供真实世界的探针。 */
function preflightSolidworks() {
  const resolved = resolveLaunchTarget()
  return preflightLaunch({
    env: process.env,
    now: Date.now(),
    target: resolved,
    exePath: resolved.exePath,
    probe: () => probeInstances(),
    sampleWindow: (pid) => sampleWindowOnce(pid),
  })
}

/**
 * COM 可用性探测（启动守卫的误杀防护）。
 *
 * 真机踩过：实例弹着守卫没识别/点不掉的确认框，120s 后按 SW_START_FAILED 被杀，
 * 可它的 COM 明明已经能 build/save。所以「窗口没就绪」不再等于「实例不可用」：
 * 超时判失败前先来这里问一句。两步证据：
 *   ① ROT 探针里有没有这个 pid（实例已注册 COM 的硬证据，仅作参考字段）；
 *   ② worker 握手：SwBridge --instance <pid> 真的 attach 上 COM 并回 version。
 * 只有 ② 成功才算 ok（ROT 有 pid 但握不上手 → 仍按失败收尾，绝不放过真坏实例）。
 */
async function probeComUsable(instancePid) {
  const pid = Number(instancePid)
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: 'NO_PID' }
  let inRot = false
  try {
    const rot = await probeInstances(10_000)
    inRot = Array.isArray(rot?.instances) && rot.instances.some((entry) => Number(entry?.pid) === pid)
  } catch { inRot = false }
  try {
    const worker = workerFor(pid)
    const version = await worker.request('version', {}, { timeoutMs: 20_000 })
    return { ok: true, op: 'worker.version', pid, inRot, detail: version?.version ?? null }
  } catch (error) {
    // 握不上手：别把这个半坏的 worker 留着，下一次启动重新建。
    try { stopWorkerInstance(pid) } catch { /* 已经退了 */ }
    return { ok: false, op: 'worker.version', pid, inRot, error: error?.message ?? String(error) }
  }
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

const WORKER_IDLE_MS = Number(process.env.SW_MCP_WORKER_IDLE_MS ?? 30 * 60_000)
const JOB_KEEP_MS = 7 * 24 * 3_600_000
const IMAGE_KEEP_MS = 7 * 24 * 3_600_000
// 温热池下限由 instances.mjs 读 SW_MCP_MIN_WARM（默认 1）：即使空闲也保留最近
// 用过的 N 个 worker，下一次建模不用重新 attach。
const DATA_ROOT = process.env.SW_MCP_DATA
  || join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'sw-mcp')

/** 递归收集快照/审查状态里引用到的图片，回收时不能误删它们。 */
function collectImageRefs(value, out = new Set()) {
  if (typeof value === 'string') {
    if (/\.(png|bmp|jpe?g)$/i.test(value)) out.add(resolve(value))
  } else if (Array.isArray(value)) {
    for (const item of value) collectImageRefs(item, out)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectImageRefs(item, out)
  }
  return out
}

function referencedImages() {
  const refs = new Set()
  for (const name of ['snapshots.json', 'live.json']) {
    const file = join(DATA_ROOT, 'review', name)
    if (!existsSync(file)) continue
    try { collectImageRefs(JSON.parse(readFileSync(file, 'utf8')), refs) } catch { /* 坏文件不阻塞回收 */ }
  }
  return refs
}

/** 按引用回收旧图：只删 images/ 里过期且不被快照/审查状态引用的文件。 */
function reclaimImages({ keepMs = IMAGE_KEEP_MS } = {}) {
  const imagesDir = join(DATA_ROOT, 'images')
  if (!existsSync(imagesDir)) return 0
  const refs = referencedImages()
  let removed = 0
  for (const name of readdirSync(imagesDir)) {
    const file = join(imagesDir, name)
    let stat
    try { stat = statSync(file) } catch { continue }
    if (!stat.isFile() || Date.now() - stat.mtimeMs < keepMs) continue
    if (refs.has(resolve(file))) continue
    try { unlinkSync(file); removed++ } catch { /* 占用中的文件下次再试 */ }
  }
  return removed
}

/** 实例登记与回收。ROT 由桥接器探针给，SOLIDWORKS 进程由 launchSolidworks 起，
 * worker 由本进程管；instances.mjs 只做决策与落盘，测试可以整块替换掉。 */
const instanceManager = new InstanceManager({
  file: defaultInstancesFile(),
  probe: () => probeInstances(),
  launch: () => launchSolidworks(),
  // 启动守卫：预检决定该不该起，盯守采样决定起出来的实例是否可用。
  preflight: () => preflightSolidworks(),
  sampleWindow: (pid, options) => sampleWindowForPid(pid, options),
  // 启动确认框（CAM / 无法生成日志文件 / 3DEXPERIENCE Marketplace …）自动点肯定按钮：
  // clickPromptButton 内部按 pid 过滤窗口，这里再兜一层，只允许点本次 lease 的 pid。
  clickDialog: ({ pid, button }) => clickPromptButton({ pid, button }),
  // 误杀防护：超时判失败前先探 COM 可用性（ROT + worker 握手），能用就按 degraded 放行。
  verifyCom: ({ pid }) => probeComUsable(pid),
  workers,
  workerLastUsed,
  clientPid,
  clientAlive,
  workerFor,
  stopWorker: stopWorkerInstance,
  cleanupWorker: cleanupWorkerInstance,
  quitWorker: quitWorkerInstance,
  stopProcess: (pid) => forceStopProcess(pid),
  log: (message) => console.error(`[broker] ${message}`),
})

/** 空闲整理：过期终态作业、没人引用的旧图、空闲 worker、空闲够久的 broker/test
 * 实例。实例部分只回收登记过的 service/test——用户手开的 SOLIDWORKS 永不碰。 */
async function maintenance({
  keepMs = JOB_KEEP_MS,
  workerIdleMs = WORKER_IDLE_MS,
  imageKeepMs = IMAGE_KEEP_MS,
  startup = false,
  includeDocs = true,
  graceMs = null,
} = {}) {
  const removed = jobs.reclaim({ keepMs })
  const removedImages = reclaimImages({ keepMs: imageKeepMs })
  const instances = await instanceManager.maintenance({ startup, includeDocs, workerIdleMs, graceMs })
  return {
    removed,
    removedImages,
    stoppedWorkers: instances.stoppedWorkers,
    cleanedDocs: instances.closedDocs,
    closedDocs: instances.closedDocs,
    keptWarm: instances.keptWarm,
    orphanWorkers: instances.orphanWorkers,
    quitInstances: instances.quitInstances,
    removedEntries: instances.removedEntries,
    reaped: instances.reaped,
    skipped: instances.skipped,
    startup,
    at: new Date().toISOString(),
  }
}

/** 桥接器把 designId→title/path 写在 exe 同目录的 state/documents.json。
 * 这是进程间共享的工作登记表；broker 读它是为了把「打开的标题」关联回
 * 稳定的 designId，而不是把标题当身份。 */
function readWorkRegistry() {
  try {
    const file = join(repoRoot, 'bridge', 'bin', 'state', 'documents.json')
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** 把一次 bridge 请求执行完并落到 job 上；只写终态，不抛给调用方。 */
async function executeJob(job, { op, args, instancePid, timeoutMs }) {
  try {
    const worker = workerFor(instancePid)
    touchWorker(instancePid || 0)
    // 真跑过作业才算「用过」：maintenance 按 lastUsedAt 判断实例空不空闲。
    if (instancePid) instanceManager.touch(instancePid)
    const response = await worker.request(op, args, { timeoutMs })
    const { ok: _ok, op: _op, id: _id, ...result } = response
    return jobs.transition(job.jobId, 'succeeded', { result })
  } catch (error) {
    return jobs.transition(job.jobId, 'failed', {
      error: { code: error.code ?? 'WORKER_ERROR', message: error.message, details: error.details },
    })
  }
}

function errorPayload(error) {
  if (error instanceof JobStoreError) {
    return { code: error.code, message: error.message, details: error.details }
  }
  // INSTANCE_BUSY / USER_INSTANCE_REFUSED / NO_BOUND_INSTANCE 这类实例错误要原样
  // 透给调用方，不能被压成 BROKER_ERROR —— 调用方要靠 code 决定排队还是报错。
  if (error && typeof error.code === 'string' && error.code.length > 0) {
    return { code: error.code, message: error.message, details: error.details ?? error.detail }
  }
  return { code: 'BROKER_ERROR', message: error?.message ?? String(error) }
}

const methods = {
  async hello() {
    return {
      brokerVersion: BROKER_PROTOCOL_VERSION,
      sourceHash: BROKER_SOURCE_HASH,
      pid: process.pid,
      pipe,
      dir,
      protocolVersion: 4,
    }
  },

  async ping() {
    return { ok: true, at: new Date().toISOString() }
  },

  async 'jobs.submit'(params) {
    const { job, reused } = jobs.submit(params ?? {})
    return { job, reused }
  },

  async 'jobs.get'(params) {
    const job = jobs.get(params?.jobId)
    if (!job) throw new JobStoreError('JOB_NOT_FOUND', `没有 job ${params?.jobId}`, { jobId: params?.jobId })
    return { job }
  },

  async 'jobs.list'(params) {
    return { jobs: jobs.list(params ?? {}) }
  },

  async 'jobs.transition'(params) {
    const job = jobs.transition(params?.jobId, params?.state, params?.patch ?? {})
    return { job }
  },

  async 'jobs.cancel'(params) {
    return jobs.requestCancel(params?.jobId)
  },

  async 'jobs.reclaim'(params) {
    return { removed: jobs.reclaim(params ?? {}) }
  },

  async maintenance(params) {
    return maintenance(params ?? {})
  },

  /** 提交并执行：job 先落盘，再交给实例 worker；结果/错误写回同一个 job。 */
  async 'jobs.run'(params) {
    const { op, args = {}, operationId, refs, timeoutMs = 240_000 } = params ?? {}
    if (!op) throw new JobStoreError('BAD_ARGUMENT', 'jobs.run 需要 op')
    let instancePid = params?.instancePid ?? 0
    let ensured = null
    if (!instancePid && params?.ensure === true) {
      ensured = await methods['instances.ensure']({
        timeoutMs: params?.ensureTimeoutMs ?? 180_000,
        startWorker: true,
        clientId: params?.clientId,
        policy: params?.policy,
        tag: params?.tag,
        maxInstances: params?.maxInstances,
      })
      instancePid = ensured.chosenPid ?? 0
      if (!instancePid) {
        throw new JobStoreError('NO_INSTANCE',
          `作业需要 SOLIDWORKS，但没能取得实例：${ensured.launchError?.message ?? ensured.warmError?.message ?? ensured.probeError?.message ?? ensured.probeError ?? '等待超时'}`,
          ensured)
      }
    }
    const submitted = jobs.submit({ op, operationId, refs,
      worker: instancePid ? { instanceId: `inst_${instancePid}` } : undefined })
    const job = submitted.job
    if (submitted.reused) return { job, reused: true }
    jobs.transition(job.jobId, 'running')
    return { job: await executeJob(job, { op, args, instancePid, timeoutMs }), reused: false, ensured }
  },

  /**
   * 提交后立刻返回 jobId，执行在后台继续。
   * 这是「持久作业返回 jobId」的入口：调用方断开/等待超时都不影响任务，
   * 之后用 jobs.get 取状态与结果。
   */
  async 'jobs.dispatch'(params) {
    const { op, args = {}, operationId, refs, timeoutMs = 240_000 } = params ?? {}
    if (!op) throw new JobStoreError('BAD_ARGUMENT', 'jobs.dispatch 需要 op')
    let instancePid = params?.instancePid ?? 0
    let ensured = null
    if (!instancePid && params?.ensure === true) {
      ensured = await methods['instances.ensure']({
        timeoutMs: params?.ensureTimeoutMs ?? 180_000,
        startWorker: true,
        clientId: params?.clientId,
        policy: params?.policy,
        tag: params?.tag,
        maxInstances: params?.maxInstances,
      })
      instancePid = ensured.chosenPid ?? 0
      if (!instancePid) {
        throw new JobStoreError('NO_INSTANCE',
          `作业需要 SOLIDWORKS，但没能取得实例：${ensured.launchError?.message ?? ensured.warmError?.message ?? ensured.probeError?.message ?? ensured.probeError ?? '等待超时'}`,
          ensured)
      }
    }
    const submitted = jobs.submit({ op, operationId, refs,
      worker: instancePid ? { instanceId: `inst_${instancePid}` } : undefined })
    const job = submitted.job
    if (submitted.reused) return { job, reused: true }
    const started = jobs.transition(job.jobId, 'running')
    const running = executeJob(job, { op, args, instancePid, timeoutMs })
    running.catch((error) => {
      // 执行器自己会写 failed；这里只兜底，避免未处理的 rejection 让 broker 挂掉。
      console.error(`job ${job.jobId} 执行失败：${error?.message ?? error}`)
    })
    return { job: started, reused: false, ensured }
  },

  // 实例与文档注册表：ROT 是事实来源，worker 是执行位置。
  /** 这个 MCP 会话绑定的是哪个实例；没有绑定时不启动 SW，只回答 null。
   * 每个会话的工具要能确认「我操作的是我自己那个 SOLIDWORKS」。 */
  async 'instances.bound'(params) {
    return instanceManager.bound({ clientId: params?.clientId ?? null })
  },

  async 'instances.list'(params) {
    const listed = await instanceManager.list()
    return { ...listed, clientId: params?.clientId ? String(params.clientId) : null }
  },

  /** 保证有可用实例。默认 shared：ROT 里有实例就复用，绝不新起第二个；
   * isolated：独占，全被占就排队（INSTANCE_BUSY），到上限不启动新进程。
   * 启动是进程级 single-flight，并发调用只会起一个 SOLIDWORKS。
   * policy/tag/maxInstances 允许按请求覆盖（显式参数 > 调用方 env > broker env）：
   * broker 是常驻进程，只认启动时 env 的话，「会话里设 isolated/3」就永远不生效。 */
  async 'instances.ensure'(params) {
    return instanceManager.ensure({
      timeoutMs: params?.timeoutMs ?? 180_000,
      clientId: params?.clientId ?? null,
      instancePid: params?.instancePid ?? 0,
      policy: params?.policy ?? null,
      maxInstances: params?.maxInstances ?? null,
      tag: params?.tag ?? null,
      startWorker: params?.startWorker !== false,
    })
  },

  /** 会话断开时立刻释放绑定；释放后如果实例没人用了，maintenance 会很快回收它。 */
  async 'instances.release'(params) {
    const released = instanceManager.release(params?.clientId ?? null)
    if (released.released) {
      // 不等下一轮 60 秒：断开即触发一次回收判定（失败不影响释放结果）。
      void instanceManager.reap({ reason: 'client-release' })
        .catch((error) => console.error(`[broker] client-release reap: ${error?.message ?? error}`))
    }
    return released
  },

  /** 显式回收 service/test 实例：先收未存盘文档，再 quit，15 秒不退才 Stop-Process。
   * 返回 stoppedWorkers/quitInstances/closedDocs/skipped；用户实例默认 skipped。 */
  async 'instances.reap'(params) {
    return instanceManager.reap({
      tag: params?.tag ?? null,
      dryRun: params?.dryRun === true,
      includeDocs: params?.includeDocs !== false,
      force: params?.force === true,
      graceMs: params?.graceMs ?? null,
      reason: params?.reason ?? 'reap',
    })
  },

  /** 默认只退当前会话绑定的实例；用户自己开的实例要 force:true，否则 USER_INSTANCE_REFUSED。 */
  async 'instances.quit'(params) {
    return instanceManager.quit({
      pid: params?.pid ?? 0,
      clientId: params?.clientId ?? null,
      force: params?.force === true,
    })
  },

  async 'workers.list'() {
    return { workers: [...workers.values()].map((worker) => worker.describe()) }
  },

  async 'documents.list'(params) {
    const clientId = params?.clientId ? String(params.clientId) : null
    const boundPid = clientId ? (clientPid.get(clientId) ?? 0) : 0
    const probe = boundPid
      ? await (await workerFor(boundPid)).request('list', {}, { timeoutMs: 30_000 })
      : await probeBridge('list')
    const registry = readWorkRegistry()
    const byTitle = new Map()
    for (const [designId, entry] of Object.entries(registry)) {
      if (entry?.title) byTitle.set(entry.title, { designId, path: entry.path ?? null })
    }
    const documents = (probe.documents ?? []).map((doc) => ({
      ...doc,
      designId: byTitle.get(doc.title)?.designId ?? null,
      path: doc.path || (byTitle.get(doc.title)?.path ?? ''),
    }))
    return { documents, error: probe.error ?? null }
  },

  /** 按标题释放一个登记过的文档：只有调用方明确点名时才关闭，绝不按“最近”
   * 猜——用户手开的文档不是代理的回收对象。 */
  async 'documents.release'(params) {
    const designId = params?.designId
    const title = params?.title
    if (!designId && !title) {
      return { released: false, note: '需要 designId 或 title' }
    }
    let resolvedTitle = title
    const clientId = params?.clientId ? String(params.clientId) : null
    const boundPid = params?.instancePid ?? (clientId ? (clientPid.get(clientId) ?? 0) : 0)
    if (!resolvedTitle && designId) {
      const listed = boundPid
        ? await (await workerFor(boundPid)).request('list', {}, { timeoutMs: 30_000 })
        : await probeBridge('list')
      const registry = readWorkRegistry()
      const known = registry[designId]
      const found = (listed.documents ?? []).find((doc) => doc.title === known?.title)
        ?? (listed.documents ?? []).find((doc) => doc.designId === designId)
      resolvedTitle = found?.title ?? known?.title ?? null
    }
    if (!resolvedTitle) return { released: false, note: `没有登记过 ${designId ?? title}` }
    // 有会话归属时，关闭必须发生在这个会话自己的实例上：标题只在实例内部唯一，
    // 另一个实例里可能正好有同名文档，用 probeBridge 会关错。
    let closed
    if (boundPid) {
      const worker = await workerFor(boundPid)
      closed = await worker.request('close', { title: resolvedTitle, allowDirty: true }, { timeoutMs: 30_000 })
    } else {
      closed = await probeBridge('close', { title: resolvedTitle, allowDirty: true }, 30_000)
    }
    return { released: closed.found === true, title: resolvedTitle, instancePid: boundPid || null, result: closed }
  },

  async shutdown() {
    if (maintenanceTimer) { clearInterval(maintenanceTimer); maintenanceTimer = null }
    for (const worker of workers.values()) worker.stop()
    // 先让响应写回，再退出；server.close() 会等客户端断开，所以这里直接 exit。
    setTimeout(() => process.exit(0), 150)
    return { stopping: true }
  },
}

let server = null
let respondThenExit = false
const clients = new Set()
/** 连接 → 会话 id：broker 没有单独的握手，第一次带 clientId 的请求就是声明。
 * 连接断开 = 会话进程没了，立刻释放它的实例绑定（不用等下一轮维护）。 */
const socketClient = new Map()
/** 保持调度器引用，避免 GC 掉定时器；shutdown 时可以一起清掉。 */
let maintenanceTimer = null

function send(socket, message) {
  if (socket.destroyed) return
  socket.write(encodeMessage(message))
}

async function handle(socket, message) {
  const { id, method, params } = message
  if (typeof id !== 'number' || typeof method !== 'string') {
    send(socket, { id: id ?? null, ok: false, error: { code: 'BAD_REQUEST', message: '需要 id 与 method' } })
    return
  }
  const clientId = requestClientId(params)
  if (clientId) socketClient.set(socket, clientId)
  const fn = methods[method]
  if (!fn) {
    send(socket, { id, ok: false, error: { code: 'UNKNOWN_METHOD', message: `没有 broker 方法 ${method}` } })
    return
  }
  try {
    const result = await fn(params ?? {})
    send(socket, { id, ok: true, result })
  } catch (error) {
    send(socket, { id, ok: false, error: errorPayload(error) })
  } finally {
    // 响应由 send() 写入；shutdown 自己负责退出。
  }
}

server = net.createServer((socket) => {
  clients.add(socket)
  socket.setEncoding('utf8')
  const decoder = new LineDecoder({
    onMessage: (message) => { void handle(socket, message) },
    onError: (error) => { console.error(`[broker] ${error.message}`) },
  })
  socket.on('data', (chunk) => decoder.push(chunk))
  socket.on('error', () => { })
  socket.on('close', () => {
    clients.delete(socket)
    const clientId = socketClient.get(socket)
    socketClient.delete(socket)
    if (!clientId) return
    // 同一会话可能刚重连（旧连接先关）：只要还有连接带着同一个 clientId，
    // 绑定就不能释放，否则重连后的会话会拿到另一个实例/或被告知 INSTANCE_BUSY。
    if ([...socketClient.values()].some((id) => id === clientId)) return
    const released = instanceManager.release(clientId)
    // 断开后立刻判一次回收：空闲的 broker/test 实例不必等满 grace 才被看见。
    instanceManager.reap({ reason: 'client-disconnect' })
      .then((result) => { if (released.released) console.error(`[broker] client ${clientId} 断开，释放 pid ${released.pid}，回收 ${result.quitInstances} 个空闲实例`) })
      .catch((error) => console.error(`[broker] client-disconnect reap: ${error?.message ?? error}`))
  })
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    // 已有 broker 在服务同一管道：静默退出，让客户端连现有实例。
    process.exit(0)
  }
  console.error(`[broker] ${error.code ?? ''} ${error.message}`)
  process.exit(1)
})

server.listen(pipe, () => {
  console.log(JSON.stringify({ ready: true, pid: process.pid, pipe, dir }))
  // 启动即整理一次：上一次跑崩留下的 tag=test 实例（超过 10 分钟）在这里被收掉。
  maintenance({ startup: true }).catch((error) => console.error(`[broker] startup maintenance: ${error.message}`))
  // 常驻期每 60 秒整理一次；unref 保证测试进程可以正常退出。
  maintenanceTimer = setInterval(() => {
    maintenance().catch((error) => console.error(`[broker] maintenance: ${error.message}`))
  }, MAINTENANCE_INTERVAL_MS)
  maintenanceTimer.unref?.()
})

process.on('SIGTERM', () => { try { server.close() } catch { } ; process.exit(0) })
process.on('SIGINT', () => { try { server.close() } catch { } ; process.exit(0) })


