using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace SwMcp
{
    /// <summary>Reads the windows SOLIDWORKS owns, without touching them.
    ///
    /// This exists because COM can answer while the application is unusable. A
    /// crash-report dialog sits on top of a live process: ping succeeds, models
    /// stay open, and every "is it running" check says ready. Reporting ready
    /// there sends the caller off to build a plate while the user stares at a
    /// dialog — so the window state is part of the diagnosis, not a decoration.
    /// </summary>
    sealed class SwWindows
    {
        public int MainHandle;
        public string MainTitle;
        public bool MainEnabled = true;
        public List<Dictionary<string, object>> Dialogs = new List<Dictionary<string, object>>();
        public bool Blocking;
        public string BlockingTitle;

        const int GWL_MAIN = 0;

        delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);
        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")]
        static extern bool IsWindowEnabled(IntPtr hWnd);
        [DllImport("user32.dll")]
        static extern bool IsHungAppWindow(IntPtr hWnd);

        // Titles that mean "the user has to click something before this app is
        // usable again". Kept as substrings: SOLIDWORKS varies the surrounding
        // wording between service packs and languages.
        static readonly string[] Alarming =
        {
            "错误报告", "意外关闭", "错误", "Error Report", "Unexpectedly", "Unexpected error",
            "SOLIDWORKS Rx", "Crash", "Recover", "恢复"
        };

        public static SwWindows Probe(int pid)
        {
            SwWindows w = new SwWindows();
            if (pid == 0) return w;
            try
            {
                EnumWindows(delegate(IntPtr h, IntPtr l)
                {
                    uint owner;
                    GetWindowThreadProcessId(h, out owner);
                    if (owner != (uint)pid) return true;
                    if (!IsWindowVisible(h)) return true;

                    StringBuilder cls = new StringBuilder(256);
                    GetClassNameW(h, cls, 256);
                    StringBuilder title = new StringBuilder(512);
                    GetWindowTextW(h, title, 512);
                    string klass = cls.ToString();
                    string text = title.ToString();

                    bool isDialog = klass == "#32770";
                    if (isDialog)
                    {
                        bool enabled = true;
                        try { enabled = IsWindowEnabled(h); } catch (Exception) { }
                        w.Dialogs.Add(Json.Dict("title", text, "className", klass, "enabled", enabled));
                        if (LooksAlarming(text))
                        {
                            w.Blocking = true;
                            if (w.BlockingTitle == null) w.BlockingTitle = text;
                        }
                        return true;
                    }

                    // The frame window is the one with a title; the rest are
                    // tooltips, combo listboxes and hidden IE hosts.
                    if (text.Length > 0 && w.MainHandle == 0)
                    {
                        w.MainHandle = h.ToInt32();
                        w.MainTitle = text;
                        try { w.MainEnabled = IsWindowEnabled(h); } catch (Exception) { }
                    }
                    return true;
                }, IntPtr.Zero);
            }
            catch (Exception)
            {
                // Window enumeration is best-effort: a failure here must not make
                // status itself fail.
                return w;
            }

            // A disabled frame is not proof of a dialog: a heavy rebuild disables the
            // frame for seconds while it is working perfectly well. Two samples 250 ms
            // apart were not enough — that is still a rebuild — so the test is now the
            // one Windows itself uses: is the window hung?
            if (w.MainHandle != 0 && !w.MainEnabled)
            {
                bool hung = false;
                try { hung = IsHungAppWindow(new IntPtr(w.MainHandle)); }
                catch (Exception) { hung = false; }
                if (hung)
                {
                    w.Blocking = true;
                    w.MainEnabled = false;
                    if (w.BlockingTitle == null) w.BlockingTitle = w.MainTitle;
                }
                else
                {
                    // Busy, not blocked. Let the caller try: a build that takes three
                    // seconds should not be reported as a dialog.
                    w.MainEnabled = true;
                }
            }
            return w;
        }

        static bool LooksAlarming(string title)
        {
            if (string.IsNullOrEmpty(title)) return false;
            foreach (string needle in Alarming)
            {
                if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            }
            return false;
        }

        public Dictionary<string, object> ToDict()
        {
            List<object> dialogs = new List<object>();
            foreach (Dictionary<string, object> d in Dialogs) dialogs.Add(d);
            return Json.Dict(
                "mainTitle", MainTitle,
                "mainEnabled", MainEnabled,
                "dialogs", dialogs,
                "blocking", Blocking,
                "blockingTitle", BlockingTitle);
        }
    }
}
