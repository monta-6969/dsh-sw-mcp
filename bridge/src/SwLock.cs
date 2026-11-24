// 一个 SOLIDWORKS 实例，多个桥接器进程。
//
// 每个 DSH 会话都会起自己的 MCP server，也就各自起一个 SwBridge.exe；它们全都附着
// 同一个 SLDWORKS.exe。而 COM 那边是单线程公寓，活动文档、选择集都是进程级全局状态：
// 两个代理一起干活时，A 刚建好的草图可能落在 B 刚切过去的零件上，而且没有任何报错。
// 所以串行化必须做在**进程之间**，进程内排队是不够的。
//
// R11 起锁的粒度是「每个实例一把」：锁名带 pid（Local\sw-mcp-solidworks-<pid>）。
// 理由：多个 SOLIDWORKS 实例互不相干，全局一把锁会让「A 在实例 1 重建」把
// 「B 在实例 2 查数」也一起卡住，与 isolated 策略（每会话一个专属实例）直接冲突。
//
// 向后兼容：没有被 broker 指定实例（ExpectedPid == 0）的桥接器——比如老版本
// broker 起的 worker、或者手工直连的 SwBridge.exe——仍然用旧的全名
// Local\sw-mcp-solidworks，并在返回/诊断里标 lockScope="global"。旧名字这一段
// 必须保留：正在跑的老进程只认它，删掉就等于把它们排除在串行化之外。
//
// 这里用命名互斥体（Local\ 覆盖同一登录会话）。写操作与读操作都持锁：读操作本身不改
// 状态，但它依赖「哪个文档是活动的」这份全局状态，别的进程换一下活动文档，读回来的
// 就是另一个零件的面。
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

namespace SwMcp
{
    internal static class SwLock
    {
        /// <summary>旧的全名。只在「没有绑定 pid」时使用，老进程只认这个名字。</summary>
        private const string LegacyMutexName = "Local\\sw-mcp-solidworks";
        private const string Prefix = "Local\\sw-mcp-solidworks-";
        private const int DefaultWaitMs = 180000;

        // 每个 pid 一个 Mutex 实例。Mutex 一旦创建就持有内核句柄，这里按名字缓存，
        // 避免每次调用都新建（同名 mutex 重复创建并不互斥，但会泄漏句柄）。
        private static readonly object GatesLock = new object();
        private static readonly Dictionary<string, Mutex> Gates = new Dictionary<string, Mutex>(StringComparer.Ordinal);

        private static readonly Mutex LegacyGate = new Mutex(false, LegacyMutexName);

        /// <summary>最近一次 Run 用的锁身份；诊断（owner.json / SW_BUSY）用它说明
        /// 「这次是全局锁还是单实例锁」。</summary>
        public static string LastScope = "global";
        public static string LastLockName = LegacyMutexName;

        /// <summary>锁名是 pid 的函数：pid&gt;0 → 单实例锁；否则退回旧的全名。</summary>
        public static string MutexNameFor(int pid)
        {
            return pid > 0 ? Prefix + pid.ToString() : LegacyMutexName;
        }

        /// <summary>"instance" 或 "global"，给响应体/诊断用。</summary>
        public static string ScopeFor(int pid)
        {
            return pid > 0 ? "instance" : "global";
        }

        /// <summary>本次进程的锁身份，供 Ping/Status 直接贴出来。</summary>
        public static Dictionary<string, object> ScopeInfo()
        {
            int pid = SwHost.ExpectedPid;
            return Json.Dict(
                "lockScope", ScopeFor(pid),
                "lockName", MutexNameFor(pid),
                "expectedPid", pid > 0 ? (object)pid : null);
        }

        private static Mutex GateFor(int pid)
        {
            if (pid <= 0) return LegacyGate;
            string name = MutexNameFor(pid);
            lock (GatesLock)
            {
                Mutex gate;
                if (!Gates.TryGetValue(name, out gate))
                {
                    gate = new Mutex(false, name);
                    Gates[name] = gate;
                }
                return gate;
            }
        }

        private static string OwnerPath()
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "sw-mcp", "locks");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, "owner.json");
        }

        /// <summary>Runs <paramref name="body"/> while holding the cross-process gate.
        ///
        /// Waiting longer than <c>lockWaitMs</c> fails with SW_BUSY rather than
        /// hanging: a silent wait looks exactly like a crash from the caller's side,
        /// and the caller needs to know which run is holding the instance.</summary>
        public static T Run<T>(string op, System.Collections.Generic.Dictionary<string, object> req, Func<T> body)
        {
            // 锁的粒度跟着「我绑定的是哪个实例」走：broker 指定的 pid 才有资格
            // 拿单实例锁；没有绑定信息时只能用旧的全局锁（老进程也在这把锁上）。
            int boundPid = SwHost.ExpectedPid;
            string scope = ScopeFor(boundPid);
            string lockName = MutexNameFor(boundPid);
            LastScope = scope;
            LastLockName = lockName;

            Mutex gate = GateFor(boundPid);
            int waitMs = Json.Int(req, "lockWaitMs", DefaultWaitMs);
            bool held = false;
            try
            {
                held = gate.WaitOne(waitMs, false);
            }
            catch (AbandonedMutexException)
            {
                // 上一个持锁者被强杀。互斥体已经归我们，继续。
                held = true;
            }

            if (!held)
            {
                string owner = ReadOwner();
                throw new BridgeError("SW_BUSY",
                    "another agent is using SOLIDWORKS (waited " + waitMs + " ms for op \"" + op
                    + "\", lock " + lockName + ", scope " + scope + "). "
                    + (owner.Length > 0 ? "holder: " + owner : "holder: unknown")
                    + " — retry once it finishes, or raise lockWaitMs.",
                    Json.Dict("lockScope", scope, "lockName", lockName, "owner", owner));
            }

            string mine = "{\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id
                + ",\"op\":\"" + op + "\",\"document\":\"" + Json.Str(req, "document", "") + "\""
                + ",\"lockScope\":\"" + scope + "\",\"lockName\":\"" + lockName + "\""
                + ",\"expectedPid\":" + boundPid
                + ",\"at\":\"" + DateTime.UtcNow.ToString("o") + "\"}";
            try
            {
                File.WriteAllText(OwnerPath(), mine, new UTF8Encoding(false));
            }
            catch { /* 诊断文件写不进去不影响正确性 */ }

            try
            {
                return body();
            }
            finally
            {
                try { File.Delete(OwnerPath()); } catch { }
                try { gate.ReleaseMutex(); } catch { }
            }
        }

        private static string ReadOwner()
        {
            try
            {
                return File.Exists(OwnerPath()) ? File.ReadAllText(OwnerPath()) : "";
            }
            catch
            {
                return "";
            }
        }
    }
}
