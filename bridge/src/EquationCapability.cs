using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using SolidWorks.Interop.sldworks;

namespace SwMcp
{
    /// <summary>Remembers which equation form this machine accepted for a dimension.
    ///
    /// The same dimension name (D1@Sketch1) is reused across parts, but the form that
    /// binds it varies with the instance state (variable already present or not, and
    /// this build's equation manager). Successful forms are cached by SW build
    /// number; rejected forms are only remembered in-process, so a restarted
    /// instance (or a repaired equation manager) gets another full attempt.
    /// </summary>
    static class EquationCapability
    {
        static readonly object Gate = new object();
        static Dictionary<string, string> _accepted;
        static readonly HashSet<string> _rejected = new HashSet<string>();
        static string _version;

        static string CachePath
        {
            get
            {
                string root = System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData);
                return Path.Combine(Path.Combine(Path.Combine(root, "sw-mcp"), "cache"), "equation-capability.tsv");
            }
        }

        public static string VersionOf(SwHost host)
        {
            lock (Gate)
            {
                if (_version != null) return _version;
                string version = "unknown";
                try
                {
                    string build, revision, hotfix;
                    host.App.GetBuildNumbers2(out build, out revision, out hotfix);
                    version = (build ?? "") + "." + (revision ?? "") + "." + (hotfix ?? "");
                }
                catch { }
                _version = Clean(version);
                return _version;
            }
        }

        /// <summary>D1@Sketch1@Part1.Part becomes D1@Sketch1: the document suffix is
        /// different for every part and would defeat the cache.</summary>
        public static string KeyOf(string dimensionFullName)
        {
            if (string.IsNullOrEmpty(dimensionFullName)) return dimensionFullName;
            string[] parts = dimensionFullName.Split('@');
            if (parts.Length >= 2) return parts[0] + "@" + parts[1];
            return dimensionFullName;
        }

        static string Clean(string value)
        {
            if (string.IsNullOrEmpty(value)) return "unknown";
            return value.Replace('\t', '_').Replace('\r', '_').Replace('\n', '_');
        }

        static Dictionary<string, string> Load()
        {
            if (_accepted != null) return _accepted;
            _accepted = new Dictionary<string, string>();
            try
            {
                if (!File.Exists(CachePath)) return _accepted;
                foreach (string line in File.ReadAllLines(CachePath, Encoding.UTF8))
                {
                    string[] cells = line.Split('\t');
                    if (cells.Length != 3) continue;
                    _accepted[cells[0] + "|" + cells[1]] = cells[2];
                }
            }
            catch { }
            return _accepted;
        }

        public static bool TryGet(string version, string key, out string strategy)
        {
            lock (Gate)
            {
                return Load().TryGetValue(version + "|" + key, out strategy);
            }
        }

        public static bool IsRejected(string version, string key)
        {
            lock (Gate)
            {
                return _rejected.Contains(version + "|" + key);
            }
        }

        public static void MarkRejected(string version, string key)
        {
            lock (Gate) { _rejected.Add(version + "|" + key); }
        }

        public static void Remember(string version, string key, string strategy)
        {
            lock (Gate)
            {
                Load()[version + "|" + key] = strategy;
                try
                {
                    string dir = Path.GetDirectoryName(CachePath);
                    if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                    File.AppendAllText(CachePath,
                        Clean(version) + "\t" + Clean(key) + "\t" + Clean(strategy) + System.Environment.NewLine,
                        new UTF8Encoding(false));
                }
                catch { }
            }
        }
    }
}
