// Running Object Table: which SOLIDWORKS processes are actually running, and
// which one a worker is bound to.
//
// Marshal.GetActiveObject("SldWorks.Application") returns *some* instance; with
// two SW windows open it can silently return the wrong one. The ROT names each
// instance "!SolidWorks_PID_<pid>", so the pid is the identity, not a guess.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using SolidWorks.Interop.sldworks;

namespace SwMcp
{
    static class Rot
    {
        [DllImport("ole32.dll")]
        static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable table);

        [DllImport("ole32.dll")]
        static extern int CreateBindCtx(int reserved, out IBindCtx ctx);

        sealed class Entry
        {
            public int Pid;
            public string Moniker;
            public DateTime? StartedAt;
        }

        static List<Entry> Enumerate()
        {
            List<Entry> found = new List<Entry>();
            IRunningObjectTable table;
            if (GetRunningObjectTable(0, out table) != 0 || table == null) return found;
            IBindCtx ctx;
            if (CreateBindCtx(0, out ctx) != 0 || ctx == null) return found;

            IEnumMoniker enumMoniker;
            table.EnumRunning(out enumMoniker);
            if (enumMoniker == null) return found;
            IMoniker[] monikers = new IMoniker[1];
            while (enumMoniker.Next(1, monikers, IntPtr.Zero) == 0)
            {
                if (monikers[0] == null) continue;
                string name;
                try { monikers[0].GetDisplayName(ctx, null, out name); }
                catch (COMException) { continue; }
                if (string.IsNullOrEmpty(name)) continue;
                string trimmed = name.TrimStart('!');
                const string prefix = "SolidWorks_PID_";
                if (!trimmed.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                int pid;
                if (!int.TryParse(trimmed.Substring(prefix.Length), out pid)) continue;
                Entry entry = new Entry();
                entry.Pid = pid;
                entry.Moniker = name;
                try
                {
                    Process process = Process.GetProcessById(pid);
                    entry.StartedAt = process.StartTime.ToUniversalTime();
                }
                catch (Exception) { }
                found.Add(entry);
            }
            return found;
        }

        public static List<object> List()
        {
            List<object> result = new List<object>();
            foreach (Entry entry in Enumerate())
            {
                result.Add(Json.Dict(
                    "pid", entry.Pid,
                    "moniker", entry.Moniker,
                    "startedAt", entry.StartedAt.HasValue
                        ? entry.StartedAt.Value.ToString("yyyy-MM-ddTHH:mm:ssZ")
                        : null));
            }
            return result;
        }

        /// <summary>Binds to exactly this pid's instance. Returns null when the pid is
        /// not in the ROT, so the caller can fall back deliberately rather than pick
        /// whichever instance COM happens to hand back.
        ///
        /// 注意：null 有两种完全不同的意思（pid 已经不在了 / pid 在跑但没在 ROT 注册）。
        /// 需要区分时用 <see cref="LookupByPid"/>：它会给出 INSTANCE_GONE 或
        /// INSTANCE_NOT_IN_ROT，调用方才能说清楚「该重启 SOLIDWORKS」还是
        /// 「这个实例被别的实例抢走了 COM 注册」。</summary>
        public static ISldWorks ByPid(int pid)
        {
            Lookup lookup = LookupByPid(pid);
            return lookup.App;
        }

        /// <summary>一次绑定尝试的完整结果：成功时 App 非空；失败时 Code 是
        /// INSTANCE_GONE（进程已经不在了）或 INSTANCE_NOT_IN_ROT（进程活着但 ROT 里
        /// 没有它的 moniker，通常是第二个实例接管了注册，或者它还在启动）。
        /// Pids 是 ROT 里现有的 pid 列表，附在错误里让调用方一眼看出「我该用哪个」。</summary>
        public sealed class Lookup
        {
            public ISldWorks App;
            public string Code;
            public string Message;
            public List<int> Pids = new List<int>();
        }

        public static Lookup LookupByPid(int pid)
        {
            Lookup result = new Lookup();
            List<Entry> entries = Enumerate();
            foreach (Entry entry in entries) result.Pids.Add(entry.Pid);
            if (pid <= 0)
            {
                result.Code = "INSTANCE_GONE";
                result.Message = "没有绑定任何 SOLIDWORKS 实例（expected pid 为 0）";
                return result;
            }

            IRunningObjectTable table;
            if (GetRunningObjectTable(0, out table) != 0 || table == null)
            {
                result.Code = "INSTANCE_NOT_IN_ROT";
                result.Message = "取不到 Running Object Table，无法确认 pid " + pid + " 是否在注册表里";
                return result;
            }
            IBindCtx ctx;
            if (CreateBindCtx(0, out ctx) != 0 || ctx == null)
            {
                result.Code = "INSTANCE_NOT_IN_ROT";
                result.Message = "CreateBindCtx 失败，无法确认 pid " + pid + " 是否在 ROT 里";
                return result;
            }
            IEnumMoniker enumMoniker;
            table.EnumRunning(out enumMoniker);
            if (enumMoniker == null)
            {
                result.Code = "INSTANCE_NOT_IN_ROT";
                result.Message = "ROT 枚举为空，pid " + pid + " 没有注册 COM 对象";
                return result;
            }
            IMoniker[] monikers = new IMoniker[1];
            while (enumMoniker.Next(1, monikers, IntPtr.Zero) == 0)
            {
                if (monikers[0] == null) continue;
                string name;
                try { monikers[0].GetDisplayName(ctx, null, out name); }
                catch (COMException) { continue; }
                if (string.IsNullOrEmpty(name)) continue;
                string trimmed = name.TrimStart('!');
                string suffix = "_PID_" + pid.ToString();
                if (!trimmed.StartsWith("SolidWorks", StringComparison.OrdinalIgnoreCase)) continue;
                if (!trimmed.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) continue;
                object instance;
                try { table.GetObject(monikers[0], out instance); }
                catch (COMException ex)
                {
                    // moniker 在但取不到对象：注册是残留的，实例实际上已经不可用。
                    result.Code = "INSTANCE_GONE";
                    result.Message = "ROT 里还有 pid " + pid + " 的 moniker（" + trimmed + "），但 GetObject 失败："
                        + ex.Message;
                    return result;
                }
                result.App = instance as ISldWorks;
                if (result.App == null)
                {
                    result.Code = "INSTANCE_NOT_IN_ROT";
                    result.Message = "ROT 里的 " + trimmed + " 不是 ISldWorks 对象";
                }
                return result;
            }

            // moniker 不在：区分「进程没了」与「进程活着但没注册」。
            bool alive = false;
            try
            {
                Process process = Process.GetProcessById(pid);
                alive = process != null && !process.HasExited;
            }
            catch (ArgumentException) { alive = false; }
            catch (InvalidOperationException) { alive = false; }
            result.Code = alive ? "INSTANCE_NOT_IN_ROT" : "INSTANCE_GONE";
            result.Message = alive
                ? "pid " + pid + " 的进程还在，但它没有在 ROT 注册 SolidWorks 对象"
                    + "（常见原因：这个实例还在启动，或者另一个实例接管了 COM 注册）"
                : "SOLIDWORKS pid " + pid + " 已经不在了（进程退出或崩溃）";
            return result;
        }
    }
}
