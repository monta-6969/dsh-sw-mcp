using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using SolidWorks.Interop.sldworks;

namespace SwMcp
{
    // Keeps the SOLIDWORKS window usable for unattended work: maximize the main
    // frame, bring it to the front, and dismiss the welcome/news/ad dialogs that
    // otherwise sit on top of the model.
    //
    // Safety rules learned from review:
    //  - only close dialog-class windows (or very specific titles), never a
    //    document window that happens to contain the word "欢迎" in its name;
    //  - report what actually happened instead of assuming the API succeeded;
    //  - read the news-feed preference back so callers can trust the flag.
    internal static class UserInterface
    {
        private const int SW_MAXIMIZE = 3;
        private const int SW_MINIMIZE = 6;
        private const int SW_RESTORE = 9;
        private const int WM_CLOSE = 0x0010;
        private const int GW_OWNER = 4;
        private const int MAX_CLOSE = 5;
        private const int SW_SHOW = 5;

        // 自动路径只在用户最近这么久（毫秒）没有键鼠输入时才敢整理窗口。
        private const int IdleBeforeMaximizeMs = 120000;

        // Anchored titles only. "Home" without SOLIDWORKS is too broad.
        private static readonly Regex NoiseTitle = new Regex(
            @"^(欢迎使用\s*SOLIDWORKS|SOLIDWORKS\s*(欢迎|Home|资讯|新闻|广告)|资讯|广告|新闻|Welcome\s+to\s+SOLIDWORKS|SOLIDWORKS\s*News)",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private static readonly Regex DocumentTitle = new Regex(
            @"\.(SLDPRT|SLDASM|SLDDRW|STEP|STP|DXF|DWG)$",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int X, Y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct WINDOWPLACEMENT
        {
            public int length, flags, showCmd;
            public POINT ptMinPosition, ptMaxPosition;
            public RECT rcNormalPosition;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct LASTINPUTINFO
        {
            public uint cbSize;
            public uint dwTime;
        }

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int command);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint command);
        [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
        [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

        public static Dictionary<string, object> Normalize(ISldWorks app, int pid, bool allowMaximize = false,
            bool requireIdle = false, bool writeNewsFeeds = false)
        {
            var result = new Dictionary<string, object>();
            result["pid"] = pid;
            IntPtr main = MainWindow(pid);
            result["mainWindow"] = main.ToInt64();
            if (main == IntPtr.Zero)
            {
                result["ok"] = false;
                result["note"] = "SOLIDWORKS 主窗口还没出现";
                return result;
            }

            // 用户最小化时绝不还原、不抢焦点：后台建模不该反复把窗口弹出来。
            // 只在窗口可见且未最大化时整理一次，且不调用 SetForegroundWindow。
            //
            // 自动路径（每 60s 心跳 / 每个新进程第一次 attach）只有在
            // allowMaximize 且用户最近 120s 没有键鼠输入时才动窗口：用户正在
            // 画草图时被 ShowWindow(SW_MAXIMIZE) 抢走窗口是这次 bug 的根因。
            bool minimized = IsIconic(main);
            bool foreground = GetForegroundWindow() == main;
            bool maximized = IsZoomed(main);
            bool userActive = LastInputAgoMs() < IdleBeforeMaximizeMs;
            bool canMaximize = allowMaximize && (!requireIdle || !userActive) && !minimized && !maximized;
            string maximizeSkipped = null;
            if (!allowMaximize) maximizeSkipped = "env-off";
            else if (minimized) maximizeSkipped = "minimized";
            else if (maximized) maximizeSkipped = "already-maximized";
            else if (requireIdle && userActive) maximizeSkipped = "user-active";
            if (canMaximize)
            {
                ShowWindow(main, SW_MAXIMIZE);
                for (int i = 0; i < 20; i++)
                {
                    maximized = IsZoomed(main);
                    if (maximized) break;
                    System.Threading.Thread.Sleep(100);
                }
                if (!maximized) maximizeSkipped = "failed";
            }

            // A3：这个首选项**默认不写**。
            //
            // 原来这里无条件 SetUserPreferenceToggle(swShowNewsFeedsInTaskPane,false)
            // —— 那是改用户的全局设置，而且没有任何调用方要求过。现在只先读原值、
            // 原值记到 restoredPreference 里；要写必须是显式参数 writeNewsFeeds:true，
            // 并回读确认真的写成。
            bool newsBefore = false, newsAfter = false, newsReadable = false, newsWritten = false;
            try
            {
                newsBefore = app.GetUserPreferenceToggle(
                    (int)SolidWorks.Interop.swconst.swUserPreferenceToggle_e.swShowNewsFeedsInTaskPane);
                newsReadable = true;
                if (writeNewsFeeds)
                {
                    app.SetUserPreferenceToggle(
                        (int)SolidWorks.Interop.swconst.swUserPreferenceToggle_e.swShowNewsFeedsInTaskPane, false);
                    newsWritten = true;
                }
                newsAfter = app.GetUserPreferenceToggle(
                    (int)SolidWorks.Interop.swconst.swUserPreferenceToggle_e.swShowNewsFeedsInTaskPane);
            }
            catch { newsReadable = false; }

            var closed = new List<string>();
            var closeFailed = new List<string>();
            var targets = new List<IntPtr>();
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                uint owner;
                GetWindowThreadProcessId(hWnd, out owner);
                if (owner != (uint)pid || hWnd == main || !IsWindowVisible(hWnd)) return true;
                string title = TitleOf(hWnd);
                if (title.Length == 0 || !NoiseTitle.IsMatch(title)) return true;
                if (DocumentTitle.IsMatch(title)) return true;          // 文档标题绝不当广告
                if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) return true; // 有 owner 的是子对话框
                string cls = ClassOf(hWnd);
                // 欢迎/资讯可能不是对话框；只接受明确的广告/资讯/欢迎标题，
                // 且限制数量，避免误伤用户窗口。
                if (cls != "#32770" && !Regex.IsMatch(title, @"SOLIDWORKS|欢迎|资讯|广告|新闻|Welcome", RegexOptions.IgnoreCase)) return true;
                targets.Add(hWnd);
                return targets.Count < MAX_CLOSE;
            }, IntPtr.Zero);

            foreach (IntPtr hWnd in targets)
            {
                string title = TitleOf(hWnd);
                PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                bool gone = false;
                for (int i = 0; i < 15; i++)
                {
                    if (!IsWindow(hWnd) || !IsWindowVisible(hWnd)) { gone = true; break; }
                    System.Threading.Thread.Sleep(100);
                }
                if (gone) closed.Add(title); else closeFailed.Add(title);
            }

            result["ok"] = true;
            result["maximized"] = maximized;
            result["maximizeAllowed"] = canMaximize;
            result["maximizeSkipped"] = maximizeSkipped;
            result["foreground"] = foreground && GetForegroundWindow() == main;
            result["wasVisible"] = IsWindowVisible(main);
            result["title"] = TitleOf(main);
            // 语义保持：newsFeedsOff 说的是"现在这个首选项是关的吗"。
            result["newsFeedsOff"] = newsReadable && newsAfter == false;
            result["newsFeedsBefore"] = newsReadable ? (object)newsBefore : null;
            result["newsFeedsReadable"] = newsReadable;
            result["newsFeedsWritten"] = newsWritten;
            // A3：写清楚"原值是多少、到底有没有写"。默认 written=false，用户的设置没被动过。
            result["restoredPreference"] = new Dictionary<string, object>
            {
                { "showNewsFeedsInTaskPane", newsReadable ? (object)newsBefore : null },
                { "written", newsWritten },
                { "note", newsWritten
                    ? "显式要求才写：已把这个首选项改成 false"
                    : "默认不写用户首选项；要关资讯请显式传 offNewsFeeds:true" },
            };
            result["closed"] = closed;
            result["closeFailed"] = closeFailed;
            return result;
        }

        /// <summary>用户是否把主窗口最小化了。建模前记一下，操作后要恢复。</summary>
        public static bool IsMinimized(int pid)
        {
            IntPtr main = MainWindow(pid);
            return main != IntPtr.Zero && IsIconic(main);
        }

        /// <summary>SOLIDWORKS 自己会在 COM 操作中把窗口拉起来；操作结束再最小化回去。</summary>
        public static void Minimize(int pid)
        {
            IntPtr main = MainWindow(pid);
            if (main != IntPtr.Zero && !IsIconic(main)) ShowWindow(main, SW_MINIMIZE);
        }

        public static Dictionary<string, object> Status(int pid)
        {
            var result = new Dictionary<string, object>();
            result["pid"] = pid;
            IntPtr main = MainWindow(pid);
            result["mainWindow"] = main.ToInt64();
            if (main == IntPtr.Zero)
            {
                result["ok"] = false;
                result["visible"] = false;
                result["maximized"] = false;
                result["noiseWindows"] = new List<string>();
                result["note"] = "没有找到主窗口（SOLIDWORKS 未启动或还在启动）";
                return result;
            }
            result["ok"] = true;
            result["visible"] = IsWindowVisible(main);
            result["maximized"] = IsZoomed(main);
            result["minimized"] = IsIconic(main);
            result["foreground"] = GetForegroundWindow() == main;
            result["title"] = TitleOf(main);
            var noise = new List<string>();
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                uint owner;
                GetWindowThreadProcessId(hWnd, out owner);
                if (owner == (uint)pid && hWnd != main && IsWindowVisible(hWnd))
                {
                    string title = TitleOf(hWnd);
                    if (title.Length > 0 && NoiseTitle.IsMatch(title) && !DocumentTitle.IsMatch(title)) noise.Add(title);
                }
                return true;
            }, IntPtr.Zero);
            result["noiseWindows"] = noise;
            return result;
        }

        private static IntPtr MainWindow(int pid)
        {
            try
            {
                using (var process = Process.GetProcessById(pid))
                {
                    if (process.MainWindowHandle != IntPtr.Zero) return process.MainWindowHandle;
                }
            }
            catch { }
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                uint owner;
                GetWindowThreadProcessId(hWnd, out owner);
                if (owner == (uint)pid && IsWindowVisible(hWnd) && TitleOf(hWnd).StartsWith("SOLIDWORKS", StringComparison.OrdinalIgnoreCase))
                {
                    found = hWnd;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        private static string TitleOf(IntPtr hWnd)
        {
            int length = GetWindowTextLength(hWnd);
            if (length <= 0) return string.Empty;
            var builder = new StringBuilder(length + 1);
            GetWindowText(hWnd, builder, builder.Capacity);
            return builder.ToString();
        }

        private static string ClassOf(IntPtr hWnd)
        {
            var builder = new StringBuilder(256);
            GetClassName(hWnd, builder, builder.Capacity);
            return builder.ToString();
        }

        /// <summary>距上一次用户键盘/鼠标输入的毫秒数。
        ///
        /// GetLastInputInfo 在锁屏或无交互会话里会失败；读不到就当作“空闲”
        /// （int.MaxValue）。真正的保护在 allowMaximize/env 开关上，不能让一次
        /// 读取失败把显式路径也堵死。</summary>
        private static int LastInputAgoMs()
        {
            LASTINPUTINFO info = new LASTINPUTINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            info.dwTime = 0;
            try
            {
                if (!GetLastInputInfo(ref info)) return int.MaxValue;
                uint elapsed = unchecked((uint)System.Environment.TickCount - info.dwTime);
                return elapsed > int.MaxValue ? int.MaxValue : (int)elapsed;
            }
            catch
            {
                return int.MaxValue;
            }
        }
    }
}
