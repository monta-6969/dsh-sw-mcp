using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using Microsoft.Win32;
using SolidWorks.Interop.sldworks;

namespace SwMcp
{
    /// <summary>Discovers SOLIDWORKS add-ins from the registry, and optionally
    /// proves which ones can actually be driven.
    ///
    /// The distinction matters: the registry says a dealer installed the plug-in,
    /// but only LoadAddIn followed by GetAddInObject says we can call it. Every
    /// entry therefore carries both a declared state and a probed one, and the
    /// probed one wins.
    /// </summary>
    static class AddIns
    {
        const string VersionedKey = @"SOFTWARE\SolidWorks\SOLIDWORKS 2026\Addins";
        const string GenericKey = @"SOFTWARE\SolidWorks\Addins";
        const string StartupKey = @"SOFTWARE\SolidWorks\AddinsStartup";

        public static Dictionary<string, object> List(Dictionary<string, object> req)
        {
            bool probe = Json.Bool(req, "probe", false);
            string only = Json.Str(req, "dll", null);

            List<Dictionary<string, object>> found = new List<Dictionary<string, object>>();
            Collect(RegistryView.Registry64, VersionedKey, "versioned", found);
            Collect(RegistryView.Registry64, GenericKey, "generic", found);
            Collect(RegistryView.Registry32, VersionedKey, "versioned-x86", found);

            Dictionary<string, bool> startup = StartupFlags();

            foreach (Dictionary<string, object> entry in found)
            {
                string clsid = (string)entry["clsid"];
                bool loadAtStartup;
                if (clsid != null && startup.TryGetValue(clsid, out loadAtStartup))
                    entry["loadAtStartup"] = loadAtStartup;
                if (only != null && (string)entry["dll"] != only && clsid != only) entry["skip"] = true;
            }

            List<object> entries = new List<object>();
            foreach (Dictionary<string, object> e in found)
                if (!e.ContainsKey("skip")) entries.Add(e);

            Dictionary<string, object> result = Json.Dict(
                "count", entries.Count,
                "entries", entries,
                "probed", false);

            if (probe)
            {
                object probed = null;
                string error = null;
                try
                {
                    using (SwHost h = SwHost.Attach())
                    {
                        probed = Probe(h, entries);
                        result["probed"] = true;
                    }
                }
                catch (BridgeError be) { error = be.Code + ": " + be.Message; }
                catch (Exception ex) { error = ex.GetType().Name + ": " + ex.Message; }
                if (probed != null) result["results"] = probed;
                if (error != null) { result["probed"] = false; result["probeError"] = error; }
            }
            return result;
        }

        static void Collect(RegistryView view, string path, string kind,
            List<Dictionary<string, object>> into)
        {
            try
            {
                using (RegistryKey baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                using (RegistryKey key = baseKey.OpenSubKey(path))
                {
                    if (key == null) return;
                    foreach (string name in key.GetSubKeyNames())
                    {
                        if (Known(into, name)) continue;
                        using (RegistryKey sub = key.OpenSubKey(name))
                        {
                            if (sub == null) continue;
                            Dictionary<string, object> entry = Json.Dict(
                                "clsid", name,
                                "source", kind,
                                "registryPath", "HKLM\\" + path + "\\" + name);
                            foreach (string valueName in sub.GetValueNames())
                            {
                                string v = null;
                                try { v = sub.GetValue(valueName) as string; }
                                catch { }
                                entry[valueName] = v;
                                if (string.Equals(valueName, "DllPath", StringComparison.OrdinalIgnoreCase)
                                    || (v != null && v.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)))
                                    entry["dll"] = v;
                            }
                            if (!entry.ContainsKey("title") && entry.ContainsKey("Title"))
                                entry["title"] = entry["Title"];
                            into.Add(entry);
                        }
                    }
                }
            }
            catch (Exception) { }
        }

        static bool Known(List<Dictionary<string, object>> list, string clsid)
        {
            foreach (Dictionary<string, object> e in list)
                if (string.Equals((string)e["clsid"], clsid, StringComparison.OrdinalIgnoreCase))
                    return true;
            return false;
        }

        static Dictionary<string, bool> StartupFlags()
        {
            Dictionary<string, bool> map = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
            try
            {
                using (RegistryKey baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine,
                    RegistryView.Registry64))
                using (RegistryKey key = baseKey.OpenSubKey(StartupKey))
                {
                    if (key == null) return map;
                    foreach (string name in key.GetSubKeyNames())
                        using (RegistryKey sub = key.OpenSubKey(name))
                        {
                            if (sub == null) continue;
                            object v = null;
                            try { v = sub.GetValue("LoadAtStartup"); } catch { }
                            map[name] = v is int ? (int)v != 0 : Convert.ToString(v) == "1";
                        }
                }
            }
            catch (Exception) { }
            return map;
        }

        /// <summary>Loads each candidate and asks for its automation object.
        /// A plug-in that registers but exposes nothing is recorded as
        /// "registry-only" rather than silently reported as usable.</summary>
        static List<object> Probe(SwHost h, List<object> entries)
        {
            List<object> results = new List<object>();
            foreach (object raw in entries)
            {
                Dictionary<string, object> entry = raw as Dictionary<string, object>;
                if (entry == null) continue;
                string clsid = entry["clsid"] as string;
                string dll = entry["dll"] as string;
                if (!string.IsNullOrEmpty(dll) && !Path.IsPathRooted(dll))
                    dll = Path.Combine(SwHost.InstallDir, dll);

                Dictionary<string, object> r = Json.Dict("clsid", clsid, "dll", dll);

                if (!string.IsNullOrEmpty(dll) && !File.Exists(dll))
                {
                    r["loadAddIn"] = "file-missing";
                    r["getAddInObject"] = "skipped";
                    r["status"] = "absent";
                    results.Add(r);
                    continue;
                }

                if (!string.IsNullOrEmpty(dll))
                {
                    try
                    {
                        int rc = h.App.LoadAddIn(dll);
                        r["loadAddIn"] = rc;
                    }
                    catch (Exception ex) { r["loadAddIn"] = "error: " + Short(ex); }
                }

                if (!string.IsNullOrEmpty(clsid) && clsid.Length > 2 && clsid[0] == '{')
                {
                    try
                    {
                        object obj = h.App.GetAddInObject(clsid);
                        r["getAddInObject"] = obj == null ? null : "object";
                        r["status"] = obj == null ? "registry-only" : "callable";
                    }
                    catch (Exception ex)
                    {
                        r["getAddInObject"] = "error: " + Short(ex);
                        r["status"] = "error";
                    }
                }
                else
                {
                    r["status"] = "no-clsid";
                }
                results.Add(r);
            }
            return results;
        }

        static string Short(Exception ex)
        {
            System.Runtime.InteropServices.COMException ce =
                ex as System.Runtime.InteropServices.COMException;
            if (ce != null) return ce.Message + " (0x" + ce.HResult.ToString("X8") + ")";
            return ex.GetType().Name + ": " + ex.Message;
        }
    }
}
