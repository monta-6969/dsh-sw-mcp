using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace SwMcp
{
    /// <summary>A structured answer to "why is SOLIDWORKS not answering".
    ///
    /// The first release collapsed every attach failure into SW_NOT_RUNNING, which
    /// then pointed at the wrong fix: the user was told to start SOLIDWORKS while
    /// it was already running. The four states below are the four things a user
    /// can actually do something about.
    /// </summary>
    sealed class Diagnostics
    {
        public string State;         // ready | not-running | not-reachable | crashed | blocked-by-dialog
        public string Message;
        public int ProcessId;
        public string Revision;
        public int RunningProcessCount;
        public string[] Action;

        static string _lastRevision;
        static DateTime _lastSeenUtc = DateTime.MinValue;

        public static void Remember(int pid, string revision)
        {
            if (pid != 0) SwHost.LastKnownProcessId = pid;
            if (revision != null) _lastRevision = revision;
            _lastSeenUtc = DateTime.UtcNow;
        }

        public static Diagnostics Snapshot()
        {
            Diagnostics d = new Diagnostics();
            Process[] procs = SafeProcesses();
            d.RunningProcessCount = procs.Length;
            d.Revision = _lastRevision;
            d.ProcessId = SwHost.LastKnownProcessId;

            bool lastPidAlive = false;
            if (SwHost.LastKnownProcessId != 0)
            {
                try
                {
                    Process p = Process.GetProcessById(SwHost.LastKnownProcessId);
                    lastPidAlive = p != null && !p.HasExited;
                }
                catch (ArgumentException) { lastPidAlive = false; }
                catch (InvalidOperationException) { lastPidAlive = false; }
            }

            if (procs.Length == 0)
            {
                if (SwHost.LastKnownProcessId != 0 && !lastPidAlive && _lastSeenUtc != DateTime.MinValue)
                {
                    d.State = "crashed";
                    d.Message = "SOLIDWORKS exited after this bridge last used it (pid "
                        + SwHost.LastKnownProcessId + " is gone). Unsaved work in that "
                        + "session is lost. Start SOLIDWORKS again; the bridge will re-attach on the next call.";
                    d.Action = new string[]
                    {
                        "open the SOLIDWORKS shortcut again",
                        "call workspace action=status to confirm readiness",
                        "re-open the last project with workspace action=resume"
                    };
                }
                else
                {
                    d.State = "not-running";
                    d.Message = "SOLIDWORKS is not running. Start it (the desktop shortcut is fine); "
                        + "this bridge never launches or closes SOLIDWORKS.";
                    d.Action = new string[] { "start SOLIDWORKS", "call workspace action=status" };
                }
                return d;
            }

            if (SwHost.LastKnownProcessId != 0 && !lastPidAlive)
            {
                d.State = "not-reachable";
                d.Message = "SOLIDWORKS is running (pid " + procs[0].Id + ") but the instance this "
                    + "bridge was talking to (pid " + SwHost.LastKnownProcessId + ") is gone. This "
                    + "happens when a second instance was started and took over the COM registration.";
                d.Action = new string[]
                {
                    "close the extra SOLIDWORKS window, or",
                    "restart SOLIDWORKS once so a single instance owns the registration"
                };
                return d;
            }

            d.State = "not-reachable";
            d.Message = "SOLIDWORKS is running (pid " + procs[0].Id + ") but did not accept the COM "
                + "attachment. Usually it is still starting up, or it is showing a dialog that blocks "
                + "the main thread.";
            d.Action = new string[]
            {
                "wait a few seconds and retry",
                "if a dialog is open in SOLIDWORKS, dismiss it"
            };
            return d;
        }

        public static Process[] SafeProcesses()
        {
            try
            {
                Process[] all = Process.GetProcessesByName("SLDWORKS");
                return all ?? new Process[0];
            }
            catch (Exception) { return new Process[0]; }
        }

        /// <summary>True when the pid we last used no longer exists. Checked before
        /// expensive calls so a dead instance reports as dead instead of hanging.</summary>
        public static bool LastProcessGone()
        {
            if (SwHost.LastKnownProcessId == 0) return false;
            try
            {
                Process p = Process.GetProcessById(SwHost.LastKnownProcessId);
                return p == null || p.HasExited;
            }
            catch (ArgumentException) { return true; }
            catch (InvalidOperationException) { return true; }
        }

        public Dictionary<string, object> ToDict()
        {
            return Json.Dict(
                "state", State,
                "message", Message,
                "processId", ProcessId,
                "runningProcessCount", RunningProcessCount,
                "revision", Revision,
                "action", Action == null ? new List<object>() : new List<object>(Action));
        }
    }
}
