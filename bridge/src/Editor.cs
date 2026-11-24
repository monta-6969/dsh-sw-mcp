using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Edits an existing model through its SOLIDWORKS equations.
    ///
    /// The point of writing parameters into global variables is that this path
    /// changes one variable and lets SOLIDWORKS propagate, instead of rebuilding
    /// geometry from our own coordinates. If propagation works, a human editing the
    /// model sees the same result our JSON predicts.</summary>
    sealed class Editor
    {
        readonly IModelDoc2 _doc;

        public Editor(IModelDoc2 doc)
        {
            _doc = doc;
        }

        public Dictionary<string, object> SetParameters(Dictionary<string, object> parameters)
        {
            return SetParameters(parameters, null, null);
        }

        // Native dimension path: when SolidWorks refuses equation writes, the
        // dimension is still native. Editing its SystemValue and rebuilding keeps
        // the model parametric without rebuilding the whole feature tree.
        public Dictionary<string, object> SetParameters(Dictionary<string, object> parameters,
            Dictionary<string, object> dimensions, string designId)
        {
            IEquationMgr eq = (IEquationMgr)_doc.GetEquationMgr();
            List<object> applied = new List<object>();
            List<object> missing = new List<object>();
            // Some builds only create the dimension objects during a rebuild;
            // Parameter(name) returns null before it. One rebuild makes the names usable.
            if (dimensions != null && dimensions.Count > 0)
            {
                try { _doc.EditRebuild3(); } catch (COMException) { }
            }

            foreach (KeyValuePair<string, object> kv in parameters)
            {
                double valueMm = Convert.ToDouble(kv.Value,
                    System.Globalization.CultureInfo.InvariantCulture);
                object rawName = null;
                if (dimensions != null && dimensions.ContainsKey(kv.Key))
                    rawName = dimensions[kv.Key];
                string dimensionName = rawName == null ? null : Convert.ToString(rawName,
                    System.Globalization.CultureInfo.InvariantCulture);
                if (!string.IsNullOrEmpty(dimensionName))
                {
                    try
                    {
                        IDimension dim = NativeDimensionCache.Get(designId, kv.Key);
                        // build 回包里 dimensionBindings 存的是尺寸全名；本进程缓存按
                        // 「参数名」登记时，这两把 key 不是同一把。全名再查一次，
                        // 避免「build 明明记了绑定、edit 却说没绑」。
                        if (dim == null) dim = NativeDimensionCache.GetByFullName(designId, dimensionName);
                        if (dim == null) dim = _doc.Parameter(dimensionName) as IDimension;
                        if (dim == null)
                        {
                            // Saving renames the model, so the recorded suffix (零件N.Part)
                            // no longer matches. Retry with the current title as suffix.
                            int at = dimensionName.LastIndexOf('@');
                            if (at > 0)
                            {
                                string retry = dimensionName.Substring(0, at + 1) + _doc.GetTitle();
                                dim = _doc.Parameter(retry) as IDimension;
                                if (dim != null) dimensionName = retry;
                            }
                        }
                        if (dim == null)
                        {
                            missing.Add(Json.Dict("param", kv.Key, "reason",
                                "dimension " + dimensionName + " not found"));
                            continue;
                        }
                        double beforeMm = dim.SystemValue * 1000.0;
                        dim.SystemValue = valueMm / 1000.0;
                        applied.Add(Json.Dict("param", kv.Key, "dimension", dimensionName,
                            "value", valueMm, "mode", "dimension", "beforeMm", beforeMm));
                        continue;
                    }
                    catch (COMException ex)
                    {
                        missing.Add(Json.Dict("param", kv.Key, "reason",
                            "dimension " + dimensionName + " failed 0x" + ex.HResult.ToString("X8")));
                        continue;
                    }
                }

                string global = kv.Key.Replace('.', '_').Replace('-', '_');
                string value = Convert.ToString(kv.Value,
                    System.Globalization.CultureInfo.InvariantCulture);
                int index = FindEquation(eq, global);
                if (index < 0)
                {
                    int rc = eq.Add2(-1, "\"" + global + "\" = " + value, true);
                    applied.Add(Json.Dict("param", kv.Key, "global", global, "value", value,
                        "mode", rc >= 0 ? "added" : "add-failed", "rc", rc));
                    if (rc < 0) missing.Add(Json.Dict("param", kv.Key, "reason", "Add2 returned " + rc));
                    continue;
                }
                string before = eq.get_Equation(index);
                eq.set_Equation(index, "\"" + global + "\" = " + value);
                applied.Add(Json.Dict("param", kv.Key, "global", global, "value", value,
                    "mode", "set", "before", before));
            }

            int evalRc = eq.EvaluateAll();
            _doc.EditRebuild3();

            List<object> driven = ReadDrivenDimensions(eq, applied);
            if (dimensions != null) ReadNativeDimensions(applied, driven, designId);

            return Json.Dict(
                "applied", applied,
                "missing", missing,
                "evaluateRc", evalRc,
                "driven", driven,
                "equations", DumpEquations(eq));
        }

        // Re-reads SystemValue after rebuild for parameters edited through a native
        // dimension; a value that did not move is reported as read=false.
        void ReadNativeDimensions(List<object> applied, List<object> driven, string designId)
        {
            foreach (object item in applied)
            {
                Dictionary<string, object> rec = item as Dictionary<string, object>;
                if (rec == null) continue;
                string mode = Convert.ToString(rec.ContainsKey("mode") ? rec["mode"] : "");
                if (mode != "dimension") continue;
                string name = Convert.ToString(rec["dimension"]);
                double expected = Convert.ToDouble(rec["value"]);
                double readMm = double.NaN;
                try
                {
                    IDimension dim = NativeDimensionCache.Get(designId, Convert.ToString(rec["param"]));
                    if (dim == null) dim = _doc.Parameter(name) as IDimension;
                    if (dim != null) readMm = dim.SystemValue * 1000.0;
                }
                catch (COMException) { }
                List<object> dims = new List<object>();
                dims.Add(Json.Dict("name", name, "valueMm", readMm,
                    "read", !double.IsNaN(readMm) && Math.Abs(readMm - expected) < 1e-6));
                driven.Add(Json.Dict(
                    "param", rec["param"],
                    "global", null,
                    "dimensions", dims,
                    "bound", !double.IsNaN(readMm) && Math.Abs(readMm - expected) < 1e-6));
            }
        }

        /// <summary>For every applied global variable, finds the dimension equations
        /// that point at it and reads the dimension's live value (mm).
        ///
        /// A binding that reads back the old value is a silent no-op; returning it as
        /// data is how the caller tells "the equation text changed" from "the model
        /// changed".</summary>
        List<object> ReadDrivenDimensions(IEquationMgr eq, List<object> applied)
        {
            Dictionary<string, List<string>> byGlobal = new Dictionary<string, List<string>>(
                StringComparer.OrdinalIgnoreCase);
            int count = eq.GetCount();
            for (int i = 0; i < count; i++)
            {
                string text = null;
                try { text = eq.get_Equation(i); }
                catch (COMException) { }
                if (text == null) continue;
                int at = text.IndexOf('=');
                if (at <= 0) continue;
                string lhs = TrimQuotes(text.Substring(0, at).Trim());
                string rhs = TrimQuotes(text.Substring(at + 1).Trim());
                if (lhs.Length == 0 || rhs.Length == 0) continue;
                if (lhs[0] != 'D' && lhs[0] != 'd') continue;   // dimension names start with D
                if (rhs.IndexOf('@') >= 0) continue;            // both sides are dimensions
                List<string> list;
                if (!byGlobal.TryGetValue(rhs, out list))
                {
                    list = new List<string>();
                    byGlobal[rhs] = list;
                }
                list.Add(lhs);
            }

            List<object> result = new List<object>();
            foreach (object item in applied)
            {
                Dictionary<string, object> rec = item as Dictionary<string, object>;
                if (rec == null) continue;
                string param = Json.Str(rec, "param", null);
                string global = Json.Str(rec, "global", null);
                if (param == null || global == null) continue;
                List<object> dims = new List<object>();
                List<string> names;
                if (byGlobal.TryGetValue(global, out names))
                {
                    foreach (string name in names)
                    {
                        object raw = null;
                        try { raw = _doc.Parameter(name); }
                        catch (COMException) { }
                        double mm = 0;
                        bool ok = raw != null && double.TryParse(
                            Convert.ToString(raw, System.Globalization.CultureInfo.InvariantCulture),
                            System.Globalization.NumberStyles.Float,
                            System.Globalization.CultureInfo.InvariantCulture, out mm);
                        object valueMm = ok ? (object)Json.R(mm * 1000) : null;
                        dims.Add(Json.Dict("name", name, "valueMm", valueMm, "read", ok));
                    }
                }
                result.Add(Json.Dict("param", param, "global", global,
                    "dimensions", dims, "bound", dims.Count > 0));
            }
            return result;
        }

        static string TrimQuotes(string s)
        {
            if (s == null) return null;
            s = s.Trim();
            if (s.Length >= 2 && s[0] == '"' && s[s.Length - 1] == '"') return s.Substring(1, s.Length - 2);
            return s;
        }

        /// <summary>Repairs equation references that still point at the document name
        /// the model had before it was saved.
        ///
        /// A dimension reference reads "D1@Sketch1@Part26.Part". Saving the document
        /// as a real file renames it, but the equation keeps the old suffix, so it no
        /// longer resolves and the dimension silently stops following its variable.
        /// Everything looks correct: the variable evaluates, the equation text reads
        /// back right, and the geometry never changes. This rewrites each stale
        /// reference to the dimension that actually exists now.
        ///
        /// Returns the repaired references so a caller can report them instead of
        /// pretending nothing happened.</summary>
        public List<object> RepairEquationReferences()
        {
            List<object> repaired = new List<object>();
            Dictionary<string, string> live = DimensionNamesByKey();
            if (live.Count == 0) return repaired;

            IEquationMgr eq = (IEquationMgr)_doc.GetEquationMgr();
            int count = eq.GetCount();
            for (int i = 0; i < count; i++)
            {
                string text = eq.get_Equation(i);
                if (string.IsNullOrEmpty(text)) continue;
                int sign = text.IndexOf('=');
                if (sign < 0) continue;
                string lhs = text.Substring(0, sign).Trim();
                if (!lhs.StartsWith("\"")) continue;
                string name = lhs.Trim('"');
                if (name.IndexOf('@') < 0) continue;

                string key = Key(name);
                string current;
                if (!live.TryGetValue(key, out current)) continue;
                if (string.Equals(current, name, StringComparison.Ordinal)) continue;

                string right = text.Substring(sign + 1).Trim();
                eq.set_Equation(i, "\"" + current + "\" = " + right);
                repaired.Add(Json.Dict("index", i, "from", name, "to", current));
            }
            if (repaired.Count > 0)
            {
                eq.EvaluateAll();
                _doc.EditRebuild3();
            }
            return repaired;
        }

        /// <summary>Maps "D1@Sketch1" to the dimension's current full name. The key
        /// stops before the document name because that is the part that goes stale.</summary>
        Dictionary<string, string> DimensionNamesByKey()
        {
            Dictionary<string, string> map = new Dictionary<string, string>();
            IFeature feature = (IFeature)_doc.FirstFeature();
            int guard = 0;
            while (feature != null && guard++ < 4000)
            {
                IDisplayDimension display;
                try
                {
                    display = (IDisplayDimension)feature.GetFirstDisplayDimension();
                }
                catch (COMException)
                {
                    display = null;
                }
                int inner = 0;
                while (display != null && inner++ < 500)
                {
                    IDimension dim = null;
                    try
                    {
                        dim = (IDimension)display.GetDimension2(0);
                    }
                    catch (COMException) { }
                    if (dim != null && !string.IsNullOrEmpty(dim.FullName) && dim.FullName.IndexOf('@') > 0)
                        map[Key(dim.FullName)] = dim.FullName;

                    try
                    {
                        display = (IDisplayDimension)feature.GetNextDisplayDimension(display);
                    }
                    catch (COMException)
                    {
                        break;
                    }
                }
                try
                {
                    feature = (IFeature)feature.GetNextFeature();
                }
                catch (COMException)
                {
                    break;
                }
            }
            return map;
        }

        /// <summary>Everything before the document name: "D1@Sketch1@Part1.Part" keeps
        /// "D1@Sketch1".</summary>
        static string Key(string fullName)
        {
            int first = fullName.IndexOf('@');
            if (first < 0) return fullName;
            int second = fullName.IndexOf('@', first + 1);
            return second < 0 ? fullName : fullName.Substring(0, second);
        }

        /// <summary>Copies parameter values out of the model's own equations, so the
        /// design JSON can be reconciled with what the model actually holds.</summary>
        public Dictionary<string, object> ReadParameters(IEnumerable<string> names)
        {
            IEquationMgr eq = (IEquationMgr)_doc.GetEquationMgr();
            Dictionary<string, object> values = new Dictionary<string, object>();
            foreach (string name in names)
            {
                string global = name.Replace('.', '_').Replace('-', '_');
                int index = FindEquation(eq, global);
                values[name] = index < 0 ? null : (object)Math.Round(eq.get_Value(index), 6);
            }
            return values;
        }

        public List<object> DumpEquations(IEquationMgr eq)
        {
            List<object> list = new List<object>();
            int count = eq.GetCount();
            for (int i = 0; i < count; i++)
            {
                list.Add(Json.Dict(
                    "index", i,
                    "text", eq.get_Equation(i),
                    "value", Math.Round(eq.get_Value(i), 6),
                    "isGlobal", eq.get_GlobalVariable(i)));
            }
            return list;
        }

        /// <summary>Finds the equation whose left-hand side is the given variable.
        /// Matching is by parsed name, not by substring, so "plate_t" cannot match
        /// "plate_t2".</summary>
        static int FindEquation(IEquationMgr eq, string variable)
        {
            int count = eq.GetCount();
            for (int i = 0; i < count; i++)
            {
                string text = eq.get_Equation(i);
                if (string.IsNullOrEmpty(text)) continue;
                int eqSign = text.IndexOf('=');
                if (eqSign < 0) continue;
                string lhs = text.Substring(0, eqSign).Trim().Trim('"');
                if (string.Equals(lhs, variable, StringComparison.Ordinal)) return i;
            }
            return -1;
        }

        /// <summary>Feature-level parameter write for cases the equation manager
        /// cannot express (a cut depth that is not a global variable).</summary>
        public bool SetFeatureParameter(string featureName, string dimName, double valueMm)
        {
            IFeature feature = SwHost.FindFeature(_doc, featureName);
            if (feature == null) return false;
            IDimension dim;
            try
            {
                dim = (IDimension)feature.Parameter(dimName);
            }
            catch (COMException)
            {
                return false;
            }
            if (dim == null) return false;
            try
            {
                dim.SystemValue = valueMm / 1000.0;
                return true;
            }
            catch (COMException)
            {
                return false;
            }
        }
    }

    // Keeps the IDimension RCWs captured at build time for the lifetime of this
    // worker process. Parameter(name) can return null in a fresh call even for a
    // dimension that was just created; the live reference does not have that problem.
    static class NativeDimensionCache
    {
        static readonly Dictionary<string, IDimension> _map = new Dictionary<string, IDimension>();

        public static void Register(string designId, Dictionary<string, IDimension> handles,
            Dictionary<string, string> bindings)
        {
            if (string.IsNullOrEmpty(designId)) return;
            lock (_map)
            {
                if (handles != null)
                {
                    foreach (KeyValuePair<string, IDimension> kv in handles)
                        _map[designId + "|p:" + kv.Key] = kv.Value;
                }
                // 同一个 RCW 再按 build 记录的全名登记一份，调用方用回包里的全名也能取到。
                if (bindings != null)
                {
                    foreach (KeyValuePair<string, string> kv in bindings)
                    {
                        IDimension dim;
                        if (string.IsNullOrEmpty(kv.Value)) continue;
                        if (handles == null || !handles.TryGetValue(kv.Key, out dim) || dim == null) continue;
                        _map[designId + "|d:" + kv.Value] = dim;
                    }
                }
            }
        }

        public static IDimension Get(string designId, string param)
        {
            if (string.IsNullOrEmpty(designId) || string.IsNullOrEmpty(param)) return null;
            lock (_map)
            {
                IDimension dim;
                return _map.TryGetValue(designId + "|p:" + param, out dim) ? dim : null;
            }
        }

        public static IDimension GetByFullName(string designId, string fullName)
        {
            if (string.IsNullOrEmpty(designId) || string.IsNullOrEmpty(fullName)) return null;
            lock (_map)
            {
                IDimension dim;
                return _map.TryGetValue(designId + "|d:" + fullName, out dim) ? dim : null;
            }
        }
    }

}
