using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Owns the COM attachment to a user-started SOLIDWORKS instance.
    /// Never launches, never quits. Restores any preference it changes.</summary>
    sealed class SwHost : IDisposable
    {
        public const string TemplateDir = @"C:\ProgramData\SOLIDWORKS\SOLIDWORKS 2026\templates";
        public const string InstallDir = @"C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS";

        public ISldWorks App { get; private set; }
        public IModelDoc2 Doc { get; private set; }

        // Preference bookkeeping: set to false while we work so dimension creation
        // never opens the modal "Modify" dialog, then restored verbatim.
        bool _savedInputDimValOnCreate;
        bool _hasSavedPreference;

        /// <summary>Process id we last successfully talked to. Kept so a later
        /// failure can be told apart from "it was never there": a vanished pid is
        /// a crash and deserves a different message from "start SOLIDWORKS".</summary>
        public static int LastKnownProcessId;

        /// <summary>PID this worker is bound to, or 0 for "whatever is active".
        /// A broker-started worker passes --instance so a second SOLIDWORKS instance
        /// cannot silently receive the work meant for the first one.</summary>
        public static int ExpectedPid;

        /// <summary>`--instance auto`：ROT 里恰好只有一个实例时才绑定它。
        ///
        /// 为什么需要：直连 worker 的 pid 来自「本会话在 broker 登记表里的绑定」，
        /// 而登记表要等第一次 broker 作业之后才有这条记录。于是一个刚起的会话
        /// 拿着 ExpectedPid=0 进来，fail-closed 把它判成 INSTANCE_NOT_BOUND ——
        /// 哪怕这台机器上只有唯一一个 SOLIDWORKS，身份根本没有歧义。
        ///
        /// 这不是把「跟随前台」后门重新打开：绑定的对象来自 ROT 的 moniker，仍然
        /// 用 GetProcessID() 复核，attachedBy 记成 "rot-unique" 并写审计行；
        /// 两个及以上实例一律 INSTANCE_AMBIGUOUS 并列出 pid，绝不替调用方挑。</summary>
        public static bool AutoBind;

        /// <summary>--no-attach：只允许只读枚举（ROT / 进程探测），**绝不**调用
        /// GetActiveObject，也绝不 attach。brokerd 的健康探针用它，于是「探一次
        /// ROT」这条路径在设计上就不可能连上用户的窗口。</summary>
        public static bool NoAttach;

        /// <summary>The pid this process actually verified it is talking to.
        /// Set on every successful attach, from GetProcessID() -- never guessed.
        /// Ping/Status should report it (see <see cref="Attachment"/>) so
        /// "which instance am I on" is answerable without a COM round trip.</summary>
        public static int AttachedPid;

        /// <summary>How the last attach happened: "expected-pid" when this worker
        /// was handed --instance, "active-object" when it followed whatever
        /// instance COM called active. The second one is the migration risk that
        /// used to be silent; it now always leaves a WARN line in the log.</summary>
        public static string AttachedBy;

        /// <summary>Last pid we warned about following, so a long-lived bridge
        /// writes one WARN per instance instead of one per operation.</summary>
        static string _warnedActiveObject;

        /// <summary>Identity of the current attachment, shaped for a response body.
        /// Add it to "ping"/"status" with
        /// <c>foreach (KeyValuePair&lt;string, object&gt; kv in SwHost.Attachment()) response[kv.Key] = kv.Value;</c>
        /// (Operations.cs Ping/Status are owned by another change in this round).</summary>
        public static Dictionary<string, object> Attachment()
        {
            return Json.Dict(
                "attachedPid", AttachedPid > 0 ? (object)AttachedPid : null,
                "attachedBy", AttachedBy,
                "expectedPid", ExpectedPid > 0 ? (object)ExpectedPid : null,
                "bindMode", AutoBind ? (object)"auto" : (ExpectedPid > 0 ? (object)"pid" : (object)"unbound"));
        }

        // 每个进程只整理一次窗口：每次 Connect 都抢焦点会让并行建模抖动。
        static readonly HashSet<int> UiReady = new HashSet<int>();
        static readonly HashSet<int> UiBusy = new HashSet<int>();

        public static SwHost Attach()
        {
            SwHost h = new SwHost();
            h.Connect();
            return h;
        }

        void Connect()
        {
            // 语义（R11：两个 AI 会话被分到用户唯一实例的根因；R12：后门收口）：
            //   NoAttach（--no-attach）→ 只读枚举，绝不 attach。探针专用。
            //   ExpectedPid != 0 → 只认那一个 pid（Rot 的 moniker 才是身份）。
            //     ROT 里没有它 → INSTANCE_GONE / INSTANCE_NOT_IN_ROT，直接失败；
            //     **绝不回退到 GetActiveObject**。
            //   ExpectedPid == 0 → **默认拒绝**（R12）：没有 --instance 就证明不了
            //     「该操作哪个实例」，于是 fail-closed 抛 INSTANCE_NOT_BOUND。
            //     旧行为（跟随时前台 GetActiveObject）只在显式设置
            //     SW_MCP_ALLOW_ACTIVE_OBJECT=1 时保留，并且必须留下带
            //     expectedPid/attachedPid 的审计日志。
            if (NoAttach)
            {
                throw new BridgeError("INSTANCE_NOT_BOUND",
                    "this bridge was started with --no-attach: it may only enumerate the ROT and "
                    + "process list, never attach to a running SOLIDWORKS instance.",
                    Json.Dict("attachMode", "no-attach", "expectedPid", null, "attachedBy", null));
            }
            if (ExpectedPid != 0) AttachBound(ExpectedPid);
            else if (AutoBind) AttachAuto();
            else AttachUnbound();

            LastKnownProcessId = AttachedPid;
            Diagnostics.Remember(AttachedPid, SafeRevision());

            // Cheap liveness probe: a hung SOLIDWORKS usually means a modal dialog.
            // 不再在这里抛 SW_BLOCKED_BY_DIALOG。窗口「不可用」和「正在忙着重建」在
            // 外面看起来一模一样：一次 3 秒的重建会让 IsWindowEnabled 为 false、
            // IsHungAppWindow 为 true，于是每一次调用都被判定成「弹着对话框」——
            // 实测整套测试因此连挂两次，而 SOLIDWORKS 其实干得好好的。
            // 现在的规则：不去猜，直接调用；真被挡住时 COM 会失败，错误里再带上窗口诊断。
            // status 仍然会报 blocked-by-dialog，那是给人看的，不是给自己设的路障。
        }

        /// <summary>R12 fail-closed：没有 --instance 的桥接器默认拒绝工作。
        ///
        /// 为什么必须拒绝：`--instance` 是「我要操作哪个 SOLIDWORKS」的唯一可证明
        /// 声明。没有它就只能靠 GetActiveObject() 去问 COM「谁在前台」，那等于
        /// 「用户切到哪个窗口，AI 就去操作哪个」——用户原话「你是不是抢了其他
        /// 实例？」问的就是这条路径。2026-11-15 的日志里它一分钟连 2 次用户实例
        /// （136 条 ATTACHED_BY_ACTIVE_OBJECT 全都指向 pid 22076）。
        ///
        /// 逃生阀：SW_MCP_ALLOW_ACTIVE_OBJECT=1 恢复旧行为，但这一次必须写一条
        /// 带 expectedPid 与 attachedPid 的审计行，让「谁允许的、连上了谁」可查。</summary>
        void AttachUnbound()
        {
            if (!AllowActiveObject())
            {
                throw new BridgeError("INSTANCE_NOT_BOUND",
                    "this bridge was started without --instance, so it cannot prove which SOLIDWORKS "
                    + "instance it should work on. Refusing to follow whatever instance COM calls "
                    + "active -- that is how a session ends up operating the user's own window.",
                    Json.Dict(
                        "attachMode", "unbound",
                        "expectedPid", null,
                        "attachedPid", null,
                        "hint", "start the bridge with --instance <pid>; "
                            + "set SW_MCP_ALLOW_ACTIVE_OBJECT=1 only to restore the old follow-the-active "
                            + "behaviour deliberately (it is logged)"));
            }
            AttachActiveObject();
            WarnAllowedActiveObject(AttachedPid);
        }

        /// <summary>`--instance auto`：只有 ROT 里恰好一个实例时才绑定。
        ///
        /// 判定顺序是「先数再绑」而不是「先绑再看」：把候选集合缩小到唯一一个之后
        /// 才碰 COM，于是「多实例时挑了一个」这种事故在设计上就不可能发生。
        /// 0 个 → 沿用 Diagnostics 的 not-running 语义；≥2 个 → INSTANCE_AMBIGUOUS
        /// 并带上 rotPids，让调用方自己点名。</summary>
        void AttachAuto()
        {
            List<int> pids = Rot.Pids();
            if (pids.Count == 0)
            {
                Diagnostics d = Diagnostics.Snapshot();
                throw new BridgeError(d.State,
                    d.Message + "（--instance auto：ROT 里没有任何 SOLIDWORKS 实例可绑定）",
                    d.ToDict());
            }
            if (pids.Count > 1)
            {
                throw new BridgeError("INSTANCE_AMBIGUOUS",
                    "this bridge was started with --instance auto, but " + pids.Count
                    + " SOLIDWORKS instances are registered in the ROT (" + string.Join(", ", pids.ConvertAll(p => p.ToString()).ToArray())
                    + "). \"auto\" only binds when the identity is unambiguous; refusing to pick one for you.",
                    Json.Dict(
                        "bindMode", "auto",
                        "expectedPid", null,
                        "rotPids", PidsAsObjects(pids),
                        "hint", "start the bridge with --instance <pid> (see rotPids); "
                            + "the MCP server resolves this pid automatically from the broker registry"));
            }
            AttachBound(pids[0]);
            // AttachBound 已验证 GetProcessID() == pids[0]；这里只改「怎么绑上的」这一笔账。
            MarkAttached(pids[0], "rot-unique");
            WarnAutoBound(pids[0], pids);
        }

        /// <summary>auto 绑定的审计行：与 active-object 逃生阀同一套日志口径，
        /// 让「凭什么认定是这个实例」在日志里是事实（ROT 唯一 + 复核过的 pid）。</summary>
        void WarnAutoBound(int attachedPid, List<int> rotPids)
        {
            try
            {
                string dir = System.IO.Path.Combine(DataRoot(), "logs");
                System.IO.Directory.CreateDirectory(dir);
                string file = System.IO.Path.Combine(dir, "mcp-" + DateTime.Now.ToString("yyyyMMdd") + ".jsonl");
                Dictionary<string, object> detail = Json.Dict(
                    "ts", DateTime.UtcNow.ToString("o"),
                    "level", "info",
                    "tool", "bridge",
                    "code", "ATTACHED_BY_ROT_UNIQUE",
                    "message", "bound to the only SOLIDWORKS instance in the ROT (pid " + attachedPid + ")",
                    "pid", System.Diagnostics.Process.GetCurrentProcess().Id,
                    "expectedPid", 0,
                    "attachedPid", attachedPid,
                    "attachedBy", "rot-unique");
                detail["rotPids"] = PidsAsObjects(rotPids);
                System.IO.File.AppendAllText(file, Json.S(detail) + "\n", new UTF8Encoding(false));
            }
            catch
            {
                // 审计写不进去不能变成一次调用失败。
            }
        }

        /// <summary>逃生阀开关。只有字面量 "1" 才算打开：'true'/'yes' 都不算，
        /// 免得一个拼错的环境变量悄悄把后门重新打开。</summary>
        static bool AllowActiveObject()
        {
            return string.Equals(
                System.Environment.GetEnvironmentVariable("SW_MCP_ALLOW_ACTIVE_OBJECT"), "1",
                StringComparison.Ordinal);
        }

        /// <summary>绑定到指定 pid：只走 ROT，走不通就报错，没有第二条路。</summary>
        void AttachBound(int pid)
        {
            Rot.Lookup lookup = Rot.LookupByPid(pid);
            if (lookup.App == null)
            {
                // 失败必须说清楚是哪一种：进程没了 vs 进程活着但没注册。
                throw new BridgeError(lookup.Code, lookup.Message,
                    Json.Dict(
                        "expectedPid", pid,
                        "rotPids", PidsAsObjects(lookup.Pids),
                        "attachedBy", null));
            }
            App = lookup.App;

            int actual = RequireProcessId("expected-pid");
            if (actual != pid)
            {
                App = null;
                throw new BridgeError("INSTANCE_MISMATCH",
                    "this worker is bound to SOLIDWORKS pid " + pid
                    + " but the instance it got from the ROT reports pid " + actual,
                    Json.Dict("expectedPid", pid, "actualPid", actual));
            }
            MarkAttached(actual, "expected-pid");
        }

        /// <summary>没有绑定 pid 时跟随 active object。保留三段重试（SOLIDWORKS
        /// 启动/关文档的瞬间 COM 会短暂失败），但结果必须被校验和记录。</summary>
        void AttachActiveObject()
        {
            COMException last = null;
            for (int attempt = 0; App == null && attempt < 3; attempt++)
            {
                try
                {
                    App = (ISldWorks)Marshal.GetActiveObject("SldWorks.Application");
                    last = null;
                    break;
                }
                catch (COMException ex)
                {
                    last = ex;
                    if (attempt < 2) System.Threading.Thread.Sleep(250);
                }
            }

            if (App == null)
            {
                Diagnostics d = Diagnostics.Snapshot();
                throw new BridgeError(d.State,
                    d.Message + " HRESULT=0x" + (last == null ? "unknown" : last.HResult.ToString("X8")),
                    d.ToDict());
            }

            int pid = RequireProcessId("active-object");
            MarkAttached(pid, "active-object");
            WarnFollowingActiveObject(pid);
        }

        /// <summary>GetProcessID() 是唯一能把「我连上了谁」变成事实的一步。
        /// 旧代码把这里的 COMException 吞成 pid=0，于是 :85 的 mismatch 校验被整段
        /// 跳过：一个错误实例因此被当成正确的实例使用。现在失败即失败。</summary>
        int RequireProcessId(string how)
        {
            int pid = 0;
            try
            {
                pid = App.GetProcessID();
            }
            catch (COMException ex)
            {
                App = null;
                throw new BridgeError("ATTACH_UNVERIFIED",
                    "SOLIDWORKS answered COM but GetProcessID() failed, so this bridge cannot prove "
                    + "which instance it attached to (" + how + "). Refusing to work on an unverified instance.",
                    Json.Dict(
                        "expectedPid", ExpectedPid > 0 ? (object)ExpectedPid : null,
                        "attachMode", how,
                        "hresult", "0x" + ex.HResult.ToString("X8")));
            }
            if (pid <= 0)
            {
                App = null;
                throw new BridgeError("ATTACH_UNVERIFIED",
                    "GetProcessID() returned " + pid + " (" + how
                    + "); the bridge cannot identify the instance it is holding.",
                    Json.Dict("expectedPid", ExpectedPid > 0 ? (object)ExpectedPid : null, "attachMode", how));
            }
            return pid;
        }

        void MarkAttached(int pid, string how)
        {
            AttachedPid = pid;
            AttachedBy = how;
        }

        static List<object> PidsAsObjects(List<int> pids)
        {
            List<object> list = new List<object>();
            if (pids != null) foreach (int pid in pids) list.Add(pid);
            return list;
        }

        /// <summary>R12 审计行：只有 SW_MCP_ALLOW_ACTIVE_OBJECT=1 打开的旧路径才写。
        /// 内容是「这是显式放行的、expectedPid 是 0（未绑定）、实际连上 attachedPid」，
        /// 于是「谁允许跟随前台、连上了哪个实例」在日志里是事实而不是猜测。</summary>
        void WarnAllowedActiveObject(int attachedPid)
        {
            try
            {
                string root = DataRoot();
                string dir = System.IO.Path.Combine(root, "logs");
                System.IO.Directory.CreateDirectory(dir);
                string file = System.IO.Path.Combine(dir, "mcp-" + DateTime.Now.ToString("yyyyMMdd") + ".jsonl");
                string line = Json.S(Json.Dict(
                    "ts", DateTime.UtcNow.ToString("o"),
                    "level", "warn",
                    "tool", "bridge",
                    "code", "ALLOWED_ACTIVE_OBJECT_ATTACH",
                    "message", "SW_MCP_ALLOW_ACTIVE_OBJECT=1: deliberately following the active "
                        + "SOLIDWORKS instance (pid " + attachedPid + "); this bridge was not bound to any --instance",
                    "pid", System.Diagnostics.Process.GetCurrentProcess().Id,
                    "expectedPid", 0,
                    "attachedPid", attachedPid,
                    "attachedBy", "active-object-allowed-by-env"));
                System.IO.File.AppendAllText(file, line + "\n", new UTF8Encoding(false));
            }
            catch
            {
                // 审计写不进去不能变成一次调用失败。
            }
        }

        /// <summary>日志根：SW_MCP_DATA 与 Node 侧同口径，默认 %LOCALAPPDATA%\sw-mcp。</summary>
        static string DataRoot()
        {
            string data = System.Environment.GetEnvironmentVariable("SW_MCP_DATA");
            if (!string.IsNullOrEmpty(data)) return data;
            return System.IO.Path.Combine(
                System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),
                "sw-mcp");
        }

        /// <summary>「跟随用户前台」这件事不再静默：每次换到新 pid 时往
        /// %LOCALAPPDATA%\sw-mcp\logs\mcp-YYYYMMDD.jsonl 追加一行 WARN。
        /// 文件名叫 mcp-* 是故意的：server/logs.mjs 只读这个前缀，于是
        /// workspace action="logs" 能直接查到它。SW_MCP_DATA 与 Node 侧同口径。</summary>
        void WarnFollowingActiveObject(int pid)
        {
            string key = "active-object:" + pid;
            if (string.Equals(_warnedActiveObject, key, StringComparison.Ordinal)) return;
            _warnedActiveObject = key;
            try
            {
                string data = System.Environment.GetEnvironmentVariable("SW_MCP_DATA");
                string root = string.IsNullOrEmpty(data)
                    ? System.IO.Path.Combine(
                        System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),
                        "sw-mcp")
                    : data;
                string dir = System.IO.Path.Combine(root, "logs");
                System.IO.Directory.CreateDirectory(dir);
                string file = System.IO.Path.Combine(dir, "mcp-" + DateTime.Now.ToString("yyyyMMdd") + ".jsonl");
                string line = Json.S(Json.Dict(
                    "ts", DateTime.UtcNow.ToString("o"),
                    "level", "warn",
                    "tool", "bridge",
                    "code", "ATTACHED_BY_ACTIVE_OBJECT",
                    "message", "no --instance bound; following the active SOLIDWORKS instance (pid " + pid + ")",
                    "pid", System.Diagnostics.Process.GetCurrentProcess().Id,
                    "attachedPid", pid,
                    "attachedBy", "active-object",
                    "expectedPid", 0));
                System.IO.File.AppendAllText(file, line + "\n", new UTF8Encoding(false));
            }
            catch
            {
                // 日志写不进去绝不能成为一次调用的失败原因。
            }
        }

        /// <summary>Maximizes the frame and dismisses welcome/news/ad popups.
        /// Called from real (non LockFree) operations rather than Connect: a
        /// read-only status probe must not steal focus or write preferences.
        /// Only a successful normalize is remembered; a window that appears
        /// late gets retried on the next operation.</summary>
        public void NormalizeUi(bool force)
        {
            int pid = LastKnownProcessId;
            if (pid == 0 || App == null) return;
            lock (UiReady)
            {
                if (UiReady.Contains(pid) && !force) return;
                if (UiBusy.Contains(pid)) return;
                UiBusy.Add(pid);
            }
            try
            {
                // 自动路径默认不再最大化：SOLIDWORKS 是被操作的一方，不是我们的
                // 展示窗口。只有显式设置 SW_MCP_UI_MAXIMIZE=1 才恢复旧行为，且
                // 无论哪种情况都要求用户最近 120s 没有键鼠输入——否则用户画图
                // 画到一半，每 60s 心跳起的新进程就会把窗口抢成最大化。
                bool auto = string.Equals(
                    System.Environment.GetEnvironmentVariable("SW_MCP_UI_MAXIMIZE"), "1", StringComparison.Ordinal);
                Dictionary<string, object> result = UserInterface.Normalize(
                    App, pid, allowMaximize: auto, requireIdle: true);
                object ok, hwnd;
                bool done = result.TryGetValue("ok", out ok) && ok is bool && (bool)ok
                    && result.TryGetValue("mainWindow", out hwnd) && Convert.ToInt64(hwnd) != 0;
                lock (UiReady)
                {
                    if (done) UiReady.Add(pid);
                    else UiReady.Remove(pid);
                }
            }
            catch
            {
                lock (UiReady) { UiReady.Remove(pid); }
            }
            finally
            {
                lock (UiReady) { UiBusy.Remove(pid); }
            }
        }

        string SafeRevision()
        {
            try { return App.RevisionNumber(); } catch (COMException) { return null; }
        }

        /// <summary>Runs fingerprinted work, guaranteeing the InputDimValOnCreate
        /// preference is restored even when the operation throws.</summary>
        public TResult Silent<TResult>(Func<TResult> body)
        {
            SavePreference();
            try
            {
                return body();
            }
            finally
            {
                RestorePreference();
            }
        }

        void SavePreference()
        {
            if (_hasSavedPreference) return;
            try
            {
                _savedInputDimValOnCreate = App.GetUserPreferenceToggle(
                    (int)swUserPreferenceToggle_e.swInputDimValOnCreate);
                _hasSavedPreference = true;
                App.SetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate, false);
            }
            catch (COMException)
            {
                _hasSavedPreference = false;
            }
        }

        public void RestorePreference()
        {
            if (!_hasSavedPreference) return;
            try
            {
                App.SetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate,
                    _savedInputDimValOnCreate);
            }
            catch (COMException) { }
            _hasSavedPreference = false;
        }

        public void Dispose()
        {
            RestorePreference();
            Doc = null;
            App = null;
        }

        // ---------------------------------------------------------------- dialogs

        [DllImport("user32.dll")]
        static extern bool IsHungAppWindow(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern bool IsWindowEnabled(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

        /// <summary>Detects a *visible, enabled* modal dialog owned by SOLIDWORKS.
        /// SOLIDWORKS keeps several hidden "#32770" windows alive from startup, so
        /// class alone would produce a permanent false positive.</summary>
        bool IsModalBlocking()
        {
            uint pid;
            try
            {
                pid = (uint)App.GetProcessID();
            }
            catch (COMException)
            {
                return false;
            }
            if (pid == 0) return false;

            bool found = false;
            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (found) return false;
                uint wpid;
                GetWindowThreadProcessId(h, out wpid);
                if (wpid != pid) return true;
                if (!IsWindowVisible(h) || !IsWindowEnabled(h)) return true;
                StringBuilder sb = new StringBuilder(64);
                GetClassName(h, sb, sb.Capacity);
                if (sb.ToString() == "#32770") { found = true; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        // ------------------------------------------------------------ doc access

        public IModelDoc2 CurrentDoc(string designId)
        {
            if (Doc != null) return Doc;
            IModelDoc2 doc = ActiveDocOrThrow();
            Doc = doc;
            return doc;
        }

        public IModelDoc2 ActiveDocOrThrow()
        {
            IModelDoc2 doc = (IModelDoc2)App.IActiveDoc2;
            if (doc == null)
                throw new BridgeError("NO_ACTIVE_DOC",
                    "No active document in SOLIDWORKS. Call part_create (or workspace action=\"open\") first.");
            return doc;
        }

        public IEnumerable<IModelDoc2> OpenDocuments()
        {
            object raw = App.GetDocuments();
            Array arr = raw as Array;
            if (arr == null) yield break;
            foreach (object o in arr)
            {
                IModelDoc2 d = o as IModelDoc2;
                if (d != null) yield return d;
            }
        }

        // --------------------------------------------------------------- helpers

        public static string Mm(double meters)
        {
            return Math.Round(meters * 1000.0, 6).ToString("0.######", CultureInfo.InvariantCulture);
        }

        public static double ToMeters(double mm)
        {
            return mm / 1000.0;
        }

        public static double FromMeters(double meters)
        {
            return meters * 1000.0;
        }

        /// <summary>Document type from the file extension. Swapping on the
        /// extension keeps this independent of whatever the active document is.</summary>
        public static int DocTypeOf(string path)
        {
            string ext = Path.GetExtension(path ?? "").ToLowerInvariant();
            if (ext == ".sldasm") return (int)SolidWorks.Interop.swconst.swDocumentTypes_e.swDocASSEMBLY;
            if (ext == ".slddrw") return (int)SolidWorks.Interop.swconst.swDocumentTypes_e.swDocDRAWING;
            return (int)SolidWorks.Interop.swconst.swDocumentTypes_e.swDocPART;
        }

        /// <summary>The active document, insisting it is an assembly. A part that
        /// quietly answers a component call with null is worse than a clear error.</summary>
        public IModelDoc2 AssemblyDocOrThrow()
        {
            IModelDoc2 doc = ActiveDocOrThrow();
            if (!(doc is IAssemblyDoc))
                throw new BridgeError("NOT_AN_ASSEMBLY",
                    "the active document is " + doc.GetTitle() + ", not an assembly");
            return doc;
        }

        /// <summary>Feature walker that stops at the first RefPlane of the given
        /// ordinal. Plane names are localized, so ordinal + type is the only
        /// stable handle.</summary>
        public static IFeature RefPlane(IModelDoc2 doc, int ordinal)
        {
            IFeature f = (IFeature)doc.FirstFeature();
            int seen = 0;
            while (f != null)
            {
                if (f.GetTypeName2() == "RefPlane")
                {
                    if (seen == ordinal) return f;
                    seen++;
                }
                f = (IFeature)f.GetNextFeature();
            }
            return null;
        }

        public static List<IFeature> Features(IModelDoc2 doc)
        {
            List<IFeature> list = new List<IFeature>();
            IFeature f = (IFeature)doc.FirstFeature();
            while (f != null)
            {
                list.Add(f);
                f = (IFeature)f.GetNextFeature();
            }
            return list;
        }

        public static IFeature FindFeature(IModelDoc2 doc, string name)
        {
            foreach (IFeature f in Features(doc))
                if (string.Equals(f.Name, name, StringComparison.Ordinal)) return f;
            return null;
        }
    }
}
