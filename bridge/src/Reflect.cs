using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Turns the interop assemblies into a browsable index, and lets the
    /// caller call any member by name.
    ///
    /// This exists because the first release treated "we did not wrap it" as
    /// "it cannot be done". The interop assembly is a complete, machine-readable
    /// description of what SOLIDWORKS exposes; the catalog is generated from it,
    /// and <see cref="Invoke"/> is the escape hatch for anything we have not
    /// wrapped yet.
    ///
    /// Two rules keep this safe. Nothing here writes to disk, and nothing here
    /// serialises a live COM object: results are summarised to primitives, so a
    /// caller can never hold a proxy we do not own.
    /// </summary>
    static class Reflect
    {
        // These members return the entity they create. Query members such as
        // GetActiveSketch and FeatureByName legitimately return null.
        static readonly Regex RequiredInvokeResult = new Regex(
            @"^(?:I?Create(?:Line|CenterLine|Circle(?:ByRadius)?|Arc|3PointArc|Ellipse|Point|Spline|Feature)\d*|"
            + @"I?Add(?:Dimension|HorizontalDimension|VerticalDimension|DiameterDimension|RadialDimension)\d*|"
            + @"I?Feature(?:Extrusion|Cut|Fillet|CircularPattern|LinearPattern|Revolve)\d*)$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        static void RequireCreatedResult(MethodInfo member, object result, Dictionary<string, object> detail)
        {
            if (result == null && member.ReturnType != typeof(void) && RequiredInvokeResult.IsMatch(member.Name))
                throw new BridgeError("INVOKE_NULL_RESULT",
                    member.Name + " returned null instead of the entity it creates", detail);
        }

        static Type[] _types;
        static Dictionary<string, Type> _byName;

        /// <summary>Every public type in the two interop assemblies, keyed by
        /// simple name, case-insensitive. Built once per process.</summary>
        static Dictionary<string, Type> ByName()
        {
            if (_byName != null) return _byName;
            List<Type> all = new List<Type>();
            try { all.AddRange(typeof(ISldWorks).Assembly.GetTypes()); }
            catch (ReflectionTypeLoadException e)
            {
                foreach (Type t in e.Types) if (t != null) all.Add(t);
            }
            try { all.AddRange(typeof(swDocumentTypes_e).Assembly.GetTypes()); }
            catch (ReflectionTypeLoadException e)
            {
                foreach (Type t in e.Types) if (t != null) all.Add(t);
            }
            catch (Exception) { }
            _types = all.ToArray();
            Dictionary<string, Type> map = new Dictionary<string, Type>(StringComparer.OrdinalIgnoreCase);
            foreach (Type t in _types)
                if (!map.ContainsKey(t.Name)) map[t.Name] = t;
            _byName = map;
            return _byName;
        }

        public static Type Find(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            Type t;
            if (ByName().TryGetValue(name, out t)) return t;
            // Accept a bare name where the interface carries the I prefix, and the
            // other way round: callers copy names out of help pages either way.
            if (!name.StartsWith("I", StringComparison.Ordinal)
                && ByName().TryGetValue("I" + name, out t)) return t;
            if (name.StartsWith("I", StringComparison.Ordinal)
                && ByName().TryGetValue(name.Substring(1), out t)) return t;
            return null;
        }

        // ------------------------------------------------------------------ index

        /// <summary>Browsable view of the interop surface.
        ///
        /// mode=summary  counts per assembly
        /// mode=types    pageable list of type names with member counts
        /// mode=iface    every member of one type, with a rendered signature
        /// mode=search   substring match over type and member names
        /// </summary>
        public static Dictionary<string, object> Index(Dictionary<string, object> req)
        {
            string mode = Json.Str(req, "mode", "summary");
            if (mode == "iface") return Iface(req);
            if (mode == "search") return Search(req);
            if (mode == "types") return Types(req);

            int total = _typesOrEmpty().Length;
            int withMembers = 0;
            foreach (Type t in _typesOrEmpty())
                if (t.GetMethods().Length > 0) withMembers++;
            return Json.Dict(
                "mode", "summary",
                "sldworksTypes", typeof(ISldWorks).Assembly.GetTypes().Length,
                "swconstTypes", SafeCount(typeof(swDocumentTypes_e).Assembly),
                "typesWithMembers", withMembers,
                "interopVersion", typeof(ISldWorks).Assembly.GetName().Version.ToString());
        }

        static Type[] _typesOrEmpty()
        {
            ByName();
            return _types ?? new Type[0];
        }

        static int SafeCount(Assembly a)
        {
            try { return a.GetTypes().Length; } catch { return -1; }
        }

        static Dictionary<string, object> Types(Dictionary<string, object> req)
        {
            string filter = Json.Str(req, "q", null);
            int offset = Json.Int(req, "offset", 0);
            int limit = Json.Int(req, "limit", 100);
            if (limit <= 0 || limit > 500) limit = 100;

            List<Dictionary<string, object>> matched = new List<Dictionary<string, object>>();
            foreach (Type t in _typesOrEmpty())
            {
                if (!string.IsNullOrEmpty(filter)
                    && t.Name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                MethodInfo[] ms;
                try { ms = t.GetMethods(); } catch { ms = new MethodInfo[0]; }
                matched.Add(Json.Dict(
                    "name", t.Name,
                    "kind", t.IsInterface ? "interface" : (t.IsEnum ? "enum" : "class"),
                    "members", ms.Length));
            }
            matched.Sort(delegate(Dictionary<string, object> a, Dictionary<string, object> b)
            {
                int ma = (int)a["members"];
                int mb = (int)b["members"];
                return mb.CompareTo(ma);
            });

            List<object> page = new List<object>();
            for (int i = offset; i < matched.Count && page.Count < limit; i++) page.Add(matched[i]);
            bool more = offset + page.Count < matched.Count;
            return Json.Dict(
                "mode", "types",
                "total", matched.Count,
                "offset", offset,
                "limit", limit,
                "returned", page.Count,
                "nextOffset", more ? (object)Json.R(offset + page.Count) : null,
                "types", page);
        }

        static Dictionary<string, object> Iface(Dictionary<string, object> req)
        {
            string name = Json.Str(req, "iface");
            Type t = Find(name);
            if (t == null)
                throw new BridgeError("UNKNOWN_TYPE", "no interop type named \"" + name + "\"",
                    Json.Dict("hint", "call interopIndex mode=search q=<substring> first"));

            bool onlyCallable = Json.Bool(req, "callableOnly", false);
            List<object> members = new List<object>();
            foreach (MethodInfo m in t.GetMethods())
            {
                if (m.IsSpecialName) continue;               // property getters/setters
                if (onlyCallable && m.GetParameters().Length > 8) continue;
                members.Add(Json.Dict(
                    "name", m.Name,
                    "signature", Signature(m),
                    "returns", m.ReturnType.Name,
                    "paramCount", m.GetParameters().Length));
            }
            List<object> props = new List<object>();
            foreach (PropertyInfo p in t.GetProperties())
                props.Add(Json.Dict("name", p.Name, "type", p.PropertyType.Name));

            return Json.Dict(
                "mode", "iface",
                "iface", t.FullName,
                "memberCount", members.Count,
                "members", members,
                "properties", props);
        }

        static Dictionary<string, object> Search(Dictionary<string, object> req)
        {
            string q = Json.Str(req, "q", "");
            if (string.IsNullOrEmpty(q))
                throw new BridgeError("BAD_ARGUMENT", "search requires \"q\"");
            int limit = Json.Int(req, "limit", 60);
            if (limit <= 0 || limit > 300) limit = 60;

            List<object> hits = new List<object>();
            foreach (Type t in _typesOrEmpty())
            {
                if (hits.Count >= limit) break;
                if (t.Name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    hits.Add(Json.Dict("kind", "type", "type", t.Name, "iface", t.Name,
                        "signature", t.Name));
                    continue;
                }
                MethodInfo[] ms;
                try { ms = t.GetMethods(); } catch { continue; }
                foreach (MethodInfo m in ms)
                {
                    if (hits.Count >= limit) break;
                    if (m.Name.IndexOf(q, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    hits.Add(Json.Dict("kind", "member", "type", t.Name, "iface", t.Name,
                        "name", m.Name, "signature", Signature(m)));
                }
            }
            return Json.Dict("mode", "search", "q", q, "count", hits.Count, "hits", hits);
        }

        public static string Signature(MethodBase m)
        {
            StringBuilder sb = new StringBuilder(m.Name);
            sb.Append('(');
            ParameterInfo[] ps = m.GetParameters();
            for (int i = 0; i < ps.Length; i++)
            {
                if (i > 0) sb.Append(", ");
                ParameterType(ps[i], sb);
                sb.Append(' ').Append(ps[i].Name);
            }
            sb.Append(')');
            MethodInfo mi = m as MethodInfo;
            if (mi != null) sb.Append(" -> ").Append(mi.ReturnType.Name);
            return sb.ToString();
        }

        static void ParameterType(ParameterInfo p, StringBuilder sb)
        {
            if (p.ParameterType.IsByRef) sb.Append(p.IsOut ? "out " : "ref ");
            sb.Append(SimpleName(p.ParameterType));
        }

        static string SimpleName(Type t)
        {
            if (t.IsByRef) t = t.GetElementType();
            if (!t.IsArray) return t.Name;
            return SimpleName(t.GetElementType()) + "[]";
        }

        // ----------------------------------------------------------------- invoke

        /// <summary>Calls any member on a resolved live object.
        ///
        /// The target is named rather than passed: a caller cannot hand us an
        /// arbitrary COM pointer, only pick from the objects the current document
        /// legitimately exposes.
        /// </summary>
        public static Dictionary<string, object> Invoke(SwHost h, Dictionary<string, object> req)
        {
            string targetName = Json.Str(req, "target", "doc");
            string member = Json.Str(req, "member");
            if (string.IsNullOrEmpty(member))
                throw new BridgeError("BAD_ARGUMENT", "invoke requires \"member\"");

            object target = Target(h, req, targetName);
            if (target == null)
                throw new BridgeError("NO_TARGET", "target \"" + targetName + "\" is not available",
                    Json.Dict("targets", new List<object> { "app", "doc", "activeDoc", "partDoc", "assemblyDoc",
                        "drawingDoc", "featureManager", "sketchManager", "extension",
                        "selectionManager", "modelView", "mathUtility" }));

            // The runtime type of a COM object is __ComObject unless the field it came
            // from was typed. ActiveDoc is an Object, so looking members up on
            // target.GetType() finds nothing at all — the declared interop interface is
            // the only place the members exist.
            Type surface = Surface(target, targetName, Json.Str(req, "iface", null));
            MethodInfo chosen = Pick(surface, member, Json.Str(req, "iface", null), req);
            if (chosen == null)
            {
                // "no overload matched" on its own sent a caller round four times:
                // FeatureFillet3 with 0 args, then 7, then FeatureExtrusion3 on the
                // wrong interface, then SelectByID2 on a selection manager. The error
                // has to say what the member looks like and where it actually lives.
                List<object> candidates = CandidateSignatures(surface, member, 3);
                string elsewhere = WhereElse(member, targetName);
                Dictionary<string, object> detail = Json.Dict(
                    "supplied", Json.Dict("count", (Args(req) ?? new ArrayList()).Count,
                        "types", ArgTypes(req)),
                    "candidates", candidates,
                    "hint", "call interopIndex mode=iface iface=" + surface.Name
                        + " to see every signature");
                if (elsewhere != null)
                {
                    detail["tryTarget"] = elsewhere;
                    detail["tryTargetHint"] = "\"" + member + "\" is not on " + surface.Name
                        + "; call it with target=\"" + elsewhere + "\"";
                }
                throw new BridgeError("UNKNOWN_MEMBER",
                    "no overload of \"" + member + "\" matched the supplied args on " + surface.Name
                    + (elsewhere != null ? " (it lives on target \"" + elsewhere + "\")" : ""),
                    detail);
            }

            ParameterInfo[] ps = chosen.GetParameters();
            ArrayList rawArgs = Args(req);
            object[] call = new object[ps.Length];
            for (int i = 0; i < ps.Length; i++)
            {
                object supplied = (rawArgs != null && i < rawArgs.Count) ? rawArgs[i] : null;
                call[i] = Convert(supplied, ps[i].ParameterType);
            }

            object result = chosen.Invoke(target, call);

            List<object> outs = new List<object>();
            for (int i = 0; i < ps.Length; i++)
                if (ps[i].ParameterType.IsByRef)
                    outs.Add(Json.Dict("name", ps[i].Name, "value", Summarise(call[i])));

            bool returnsVoid = chosen.ReturnType == typeof(void);
            Dictionary<string, object> answer = Json.Dict(
                "target", targetName,
                "member", chosen.Name,
                "signature", Signature(chosen),
                "returnType", chosen.ReturnType.Name,
                // A void member returning null is success. Saying so keeps the caller
                // from reading "null" as "the call did nothing".
                "returnsVoid", returnsVoid,
                "result", returnsVoid ? Json.Dict("void", true) : Summarise(result),
                "outArgs", outs);
            // 「这次动的是哪份文档」必须明说：同一台机器上同时开着用户的零件和
            // 几条会话的文档，量错了零件却报成功是最贵的错误。
            IModelDoc2 hit = target as IModelDoc2;
            if (hit != null) Stamp(answer, hit, req);
            answer["activeDocument"] = req.ContainsKey("_documentFallback");
            RequireCreatedResult(chosen, result, answer);
            return answer;
        }

        /// <summary>把「这次落在哪份文档上」写进回包（标题 + 路径 + 是不是前台兜底）。</summary>
        static void Stamp(Dictionary<string, object> answer, IModelDoc2 doc, Dictionary<string, object> req)
        {
            if (answer == null || doc == null) return;
            string title = null, path = null;
            try { title = doc.GetTitle(); } catch (COMException) { }
            try { path = doc.GetPathName(); } catch (COMException) { }
            answer["document"] = Json.Dict("title", title, "path", path,
                "saved", !string.IsNullOrEmpty(path));
            if (req != null && req.ContainsKey("_documentFallback"))
                answer["documentFallback"] = true;
        }

        /// <summary>Reads, calls and writes members on an object returned earlier.
        ///
        /// This is what makes chaining possible without re-resolving targets by
        /// name every time: invoke returns {kind:"comObject",handle:"obj_7"}, and
        /// the next call passes that handle with member="GetSketchSegments".</summary>
        public static Dictionary<string, object> ObjectOp(SwHost h, Dictionary<string, object> req)
        {
            string action = Json.Str(req, "action", "get");
            if (action == "list") return Json.Dict("handles", Handles.List());
            if (action == "target")
            {
                string targetName = Json.Str(req, "target", "doc");
                if (targetName == "dimension")
                {
                    // Native dimensions captured by the last build. Parameter(name)
                    // returns null on this SolidWorks build, so the live RCW is the
                    // only reliable way to reach the same dimension from a new call.
                    string designId = Json.Str(req, "designId", null);
                    string param = Json.Str(req, "param", null);
                    IDimension d = NativeDimensionCache.Get(designId, param);
                    if (d == null)
                        throw new BridgeError("NO_TARGET",
                            "no native dimension for designId=" + designId + " param=" + param,
                            Json.Dict("designId", designId, "param", param));
                    return Json.Dict("target", "dimension", "designId", designId, "param", param,
                        "handle", Handles.Register(d, "IDimension"));
                }
                object live = Target(h, req, targetName);
                if (live == null)
                    throw new BridgeError("NO_TARGET", "target \"" + targetName + "\" is not available");
                return Json.Dict("target", targetName, "handle", Handles.Register(live, live.GetType().Name));
            }

            string id = Json.Str(req, "handle", null);
            if (string.IsNullOrEmpty(id))
            {
                if (action == "clear") { Handles.Clear(); return Json.Dict("cleared", true); }
                throw new BridgeError("BAD_ARGUMENT", "object requires \"handle\"");
            }
            if (action == "release") return Json.Dict("handle", id, "released", Handles.Release(id));

            object target = Handles.Require(id);
            // Arrays are returned as summaries with their own handle; indexing is a
            // separate action because Array has no meaningful "member" to get.
            Array array = target as Array;
            if (array != null && req.ContainsKey("index"))
            {
                int index = Json.Int(req, "index", -1);
                if (index < 0 || index >= array.Length)
                    throw new BridgeError("INDEX_OUT_OF_RANGE", "index " + index + " is outside 0.." + (array.Length - 1));
                return Json.Dict("handle", id, "index", index, "length", array.Length,
                    "result", Summarise(array.GetValue(index)));
            }
            string member = Json.Str(req, "member", null);
            if (string.IsNullOrEmpty(member))
            {
                if (action == "get") return Json.Dict("handle", id, "type", target.GetType().Name, "value", Summarise(target));
                throw new BridgeError("BAD_ARGUMENT", "object action \"" + action + "\" requires \"member\"");
            }

            string iface = Json.Str(req, "iface", null);
            Type surface = SurfaceWithMember(target, iface, member);

            if (action == "get")
            {
                PropertyInfo property = surface.GetProperty(member);
                if (property == null)
                    throw new BridgeError("UNKNOWN_MEMBER",
                        "\"" + member + "\" is not a property on " + surface.Name,
                        Json.Dict("candidates", CandidateSignatures(surface, member, 5)));
                object value = property.GetValue(target, null);
                return Json.Dict("handle", id, "member", member, "memberKind", "property",
                    "result", Summarise(value));
            }

            if (action == "set")
            {
                PropertyInfo property = surface.GetProperty(member);
                if (property == null)
                    throw new BridgeError("UNKNOWN_MEMBER",
                        "\"" + member + "\" is not a settable property on " + surface.Name,
                        Json.Dict("candidates", CandidateSignatures(surface, member, 5)));
                object raw = req.ContainsKey("value") ? req["value"] : null;
                property.SetValue(target, Convert(raw, property.PropertyType), null);
                return Json.Dict("handle", id, "member", member, "memberKind", "property",
                    "set", true, "value", Summarise(property.GetValue(target, null)));
            }

            if (action != "call")
                throw new BridgeError("BAD_ARGUMENT", "object action must be get|set|call|release|list|clear");

            MethodInfo chosen = Pick(surface, member, iface, req);
            if (chosen == null)
                throw new BridgeError("UNKNOWN_MEMBER",
                    "no overload of \"" + member + "\" matched on " + surface.Name,
                    Json.Dict("candidates", CandidateSignatures(surface, member, 3),
                        "supplied", Json.Dict("count", (Args(req) ?? new ArrayList()).Count, "types", ArgTypes(req))));

            ParameterInfo[] ps = chosen.GetParameters();
            ArrayList rawArgs = Args(req);
            object[] call = new object[ps.Length];
            for (int i = 0; i < ps.Length; i++)
            {
                object supplied = (rawArgs != null && i < rawArgs.Count) ? rawArgs[i] : null;
                call[i] = Convert(supplied, ps[i].ParameterType);
            }
            object result = chosen.Invoke(target, call);
            List<object> outs = new List<object>();
            for (int i = 0; i < ps.Length; i++)
                if (ps[i].ParameterType.IsByRef)
                    outs.Add(Json.Dict("name", ps[i].Name, "value", Summarise(call[i])));
            bool returnsVoid = chosen.ReturnType == typeof(void);
            Dictionary<string, object> answer = Json.Dict("handle", id, "member", chosen.Name, "memberKind", "method",
                "signature", Signature(chosen), "returnType", chosen.ReturnType.Name, "returnsVoid", returnsVoid,
                "result", returnsVoid ? Json.Dict("void", true) : Summarise(result), "outArgs", outs);
            RequireCreatedResult(chosen, result, answer);
            return answer;
        }

        /// <summary>Finds the interface that actually declares the member.
        ///
        /// COM proxies answer GetType() with __ComObject, which has no useful
        /// members. The declared interfaces are the real surface; the one that
        /// contains the requested member is the one to invoke on.</summary>
        static Type SurfaceWithMember(object target, string iface, string member)
        {
            if (!string.IsNullOrEmpty(iface))
            {
                Type named = Find(iface);
                if (named != null) return named;
            }
            Type runtime = target.GetType();
            if (runtime.GetMember(member).Length > 0) return runtime;
            foreach (Type candidate in runtime.GetInterfaces())
                if (candidate.GetMember(member).Length > 0) return candidate;
            return runtime;
        }

        /// <summary>What a live object can actually do, spelled out.
        ///
        /// The caller used to guess: invoke "SelectByID2" on the selection manager and
        /// learn nothing but "unknown member", then guess again. A COM object answers
        /// GetType() with __ComObject, so the members have to come from the interfaces
        /// it implements — and those are exactly where the "where" column comes from:
        /// SelectByID2 lives on IModelDocExtension, FeatureExtrusion3 on IModelDoc2.</summary>
        public static Dictionary<string, object> Kinds(SwHost h, Dictionary<string, object> req)
        {
            string targetName = Json.Str(req, "target", "doc");
            object target = Target(h, req, targetName);
            if (target == null)
                throw new BridgeError("NO_TARGET",
                    "there is no " + targetName + " in the current session; open a document first");

            string ifaceName = Json.Str(req, "iface", null);
            if (!string.IsNullOrEmpty(ifaceName))
            {
                Type named = Find(ifaceName);
                if (named == null) throw new BridgeError("UNKNOWN_TYPE", "no interop type named " + ifaceName);
                return Describe(named, targetName, req, true);
            }

            // The declared surface first, then every interface the live proxy implements.
            List<Type> types = new List<Type>();
            Type surface = Surface(target, targetName, null);
            if (surface != null) types.Add(surface);
            try
            {
                Type[] faces = ((object)target).GetType().GetInterfaces();
                foreach (Type t in faces)
                    if (t.Namespace != null && t.Namespace.StartsWith("SolidWorks"))
                        if (!types.Contains(t)) types.Add(t);
            }
            catch (Exception) { }

            List<object> members = new List<object>();
            Dictionary<string, int> perIface = new Dictionary<string, int>();
            Dictionary<string, bool> seen = new Dictionary<string, bool>();

            foreach (Type t in types)
            {
                int count = 0;
                foreach (MemberInfo mi in t.GetMembers(BindingFlags.Public | BindingFlags.Instance))
                {
                    MethodInfo m = mi as MethodInfo;
                    PropertyInfo p = mi as PropertyInfo;
                    string name = mi.Name;
                    if (name.StartsWith("get_") || name.StartsWith("set_") || name == "GetType" ||
                        name == "ToString" || name == "GetHashCode" || name == "Equals") continue;

                    string kind = m != null ? "method" : (p != null ? "property" : null);
                    if (kind == null) continue;

                    string dedupe = kind + ":" + name + ":" + (m != null ? m.GetParameters().Length.ToString() : "-");
                    if (seen.ContainsKey(dedupe)) continue;
                    seen[dedupe] = true;
                    count++;

                    Dictionary<string, object> row = Json.Dict("name", name, "kind", kind, "where", t.Name);
                    if (m != null)
                    {
                        ParameterInfo[] ps = m.GetParameters();
                        row["paramCount"] = ps.Length;
                        row["returns"] = m.ReturnType.Name;
                        row["signature"] = Signature(m);
                    }
                    else
                    {
                        row["returns"] = p.PropertyType.Name;
                        row["signature"] = name + " : " + p.PropertyType.Name;
                    }
                    members.Add(row);
                }
                if (count > 0) perIface[t.Name] = count;
            }

            members.Sort(delegate(object a, object b)
            {
                string na = Json.S(Json.Obj(a)["name"]);
                string nb = Json.S(Json.Obj(b)["name"]);
                return string.Compare(na, nb, StringComparison.OrdinalIgnoreCase);
            });

            List<string> names = new List<string>();
            foreach (KeyValuePair<string, int> kv in perIface) names.Add(kv.Key + " (" + kv.Value + ")");

            return Paged(members, targetName, names, req);
        }

        /// <summary>Members of one named interface, without asking a live object anything.</summary>
        static Dictionary<string, object> Describe(Type t, string targetName, Dictionary<string, object> req, bool live)
        {
            List<object> members = new List<object>();
            foreach (MethodInfo m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (m.Name.StartsWith("get_") || m.Name.StartsWith("set_")) continue;
                members.Add(Json.Dict(
                    "name", m.Name, "kind", "method", "where", t.Name,
                    "paramCount", m.GetParameters().Length,
                    "returns", m.ReturnType.Name, "signature", Signature(m)));
            }
            foreach (PropertyInfo p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
                members.Add(Json.Dict("name", p.Name, "kind", "property", "where", t.Name,
                    "returns", p.PropertyType.Name, "signature", p.Name + " : " + p.PropertyType.Name));

            List<string> names = new List<string>();
            names.Add(t.Name + " (" + members.Count + ")");
            return Paged(members, targetName, names, req);
        }

        /// <summary>Same shape as every other paged read in this bridge: total, offset,
        /// limit, nextOffset, so a caller with a 400-member interface can walk it.</summary>
        static Dictionary<string, object> Paged(List<object> members, string targetName, List<string> interfaces,
            Dictionary<string, object> req)
        {
            int offset = Json.Int(req, "offset", 0);
            int limit = Json.Int(req, "limit", 200);
            if (offset < 0) offset = 0;
            if (limit <= 0) limit = 200;

            List<object> page = new List<object>();
            for (int i = offset; i < members.Count && page.Count < limit; i++) page.Add(members[i]);
            int next = offset + page.Count;

            return Json.Dict(
                "target", targetName,
                "interfaces", interfaces,
                "total", members.Count,
                "offset", offset,
                "limit", limit,
                "nextOffset", next < members.Count ? (object)next : null,
                "members", page);
        }

        /// <summary>Which interface the member should be looked up on.
        ///
        /// A COM object from Object-typed field reports its .NET type as __ComObject,
        /// which has no members at all; calling something on it fails with a message
        /// that blames the arguments. Naming the interface by target avoids that.</summary>
        static Type Surface(object target, string targetName, string ifaceName)
        {
            if (!string.IsNullOrEmpty(ifaceName))
            {
                Type named = Find(ifaceName);
                if (named != null) return named;
            }

            string[] candidates;
            switch (targetName)
            {
                case "app": candidates = new[] { "ISldWorks" }; break;
                case "partDoc": candidates = new[] { "IPartDoc", "IModelDoc2" }; break;
                case "assemblyDoc": candidates = new[] { "IAssemblyDoc", "IModelDoc2" }; break;
                case "drawingDoc": candidates = new[] { "IDrawingDoc", "IModelDoc2" }; break;
                case "featureManager": candidates = new[] { "IFeatureManager" }; break;
                case "sketchManager": candidates = new[] { "ISketchManager" }; break;
                case "extension": candidates = new[] { "IModelDocExtension" }; break;
                case "selectionManager": candidates = new[] { "ISelectionMgr" }; break;
                case "modelView": candidates = new[] { "IModelView" }; break;
                case "mathUtility": candidates = new[] { "IMathUtility" }; break;
                default: candidates = new[] { "IModelDoc2", "IModelDoc" }; break;
            }

            foreach (string name in candidates)
            {
                Type found = Find(name);
                if (found == null) continue;
                // Prefer the interface that actually declares the target's real type.
                if (target != null)
                {
                    string runtime = ((object)target).GetType().Name;
                    if (runtime == found.Name) return found;
                }
                return found;
            }

            return target.GetType();
        }

        /// <summary>The signatures of a member, closest to the supplied argument count
        /// first. Three is enough to make the shape obvious without turning an error
        /// into a manual.</summary>
        static List<object> CandidateSignatures(Type surface, string member, int limit)
        {
            List<object> list = new List<object>();
            try
            {
                MethodInfo[] all = surface.GetMethods(BindingFlags.Public | BindingFlags.Instance);
                List<MethodInfo> hits = new List<MethodInfo>();
                foreach (MethodInfo m in all)
                {
                    if (!string.Equals(m.Name, member, StringComparison.Ordinal)) continue;
                    if (m.IsSpecialName) continue;
                    hits.Add(m);
                }
                hits.Sort(delegate (MethodInfo a, MethodInfo b)
                {
                    return a.GetParameters().Length.CompareTo(b.GetParameters().Length);
                });
                for (int i = 0; i < hits.Count && list.Count < limit; i++)
                    list.Add(Signature(hits[i]));
            }
            catch
            {
                /* reflection failure must not mask the original error */
            }
            return list;
        }

        /// <summary>Which other target interface declares this member, so "wrong
        /// object" can be answered instead of retried. SelectByID2 lives on
        /// IModelDocExtension, FeatureExtrusion3 on IModelDoc2 — both were called on
        /// the wrong object in one session.</summary>
        static string WhereElse(string member, string currentTarget)
        {
            string[,] map = new string[,]
            {
                { "app", "ISldWorks" },
                { "doc", "IModelDoc2" },
                { "partDoc", "IPartDoc" },
                { "assemblyDoc", "IAssemblyDoc" },
                { "drawingDoc", "IDrawingDoc" },
                { "featureManager", "IFeatureManager" },
                { "sketchManager", "ISketchManager" },
                { "extension", "IModelDocExtension" },
                { "selectionManager", "ISelectionMgr" },
                { "modelView", "IModelView" },
                { "mathUtility", "IMathUtility" },
            };
            for (int i = 0; i < map.GetLength(0); i++)
            {
                string target = map[i, 0];
                if (string.Equals(target, currentTarget, StringComparison.OrdinalIgnoreCase)) continue;
                Type t = Find(map[i, 1]);
                if (t == null) continue;
                try
                {
                    foreach (MethodInfo m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance))
                        if (string.Equals(m.Name, member, StringComparison.Ordinal)) return target;
                }
                catch
                {
                    continue;
                }
            }
            return null;
        }

        /// <summary>What the caller actually passed, by JSON type — the other half of
        /// "why did no overload match".</summary>
        static List<object> ArgTypes(Dictionary<string, object> req)
        {
            List<object> types = new List<object>();
            ArrayList raw = Args(req);
            if (raw == null) return types;
            foreach (object o in raw)
                types.Add(o == null ? "null" : o.GetType().Name);
            return types;
        }

        /// <summary>Reads the optional "args" array without assuming the key exists;
        /// a KeyNotFoundException here would surface as INTERNAL_ERROR and look
        /// like a bridge bug rather than a missing argument.</summary>
        static ArrayList Args(Dictionary<string, object> req)
        {
            object raw;
            if (req == null || !req.TryGetValue("args", out raw)) return new ArrayList();
            ArrayList list = Json.Arr(raw);
            return list ?? new ArrayList();
        }

        /// <summary>Resolves the document a request means, then the target on it.
        ///
        /// 这里是「target: doc 到底指谁」的唯一答案。旧实现无条件取
        /// `h.App.IActiveDoc2` —— 也就是 SOLIDWORKS 前台活动文档，**与请求里的
        /// designId 无关**。现场后果（会话 abd5f23f，271 步 / 两轮零交付）：
        /// 模型带着 designId 调 invoke，命中的却是历史遗留的未保存旧文档
        /// 「零件3」（restoredActiveDocument 统计里 60 次），尺寸全部被降级成
        /// 参考尺寸，而参数名叫 doc，调用方自然理解为「我这次的文档」。
        ///
        /// 现在的规则：**给了 designId 就按 designId 解析**（走
        /// RequireDesignDocument，解析不到就 DOC_NOT_OPEN，绝不退回前台）；
        /// 要前台那份必须显式写 target="activeDoc"，且回包里标 activeDocument=true。
        /// 其余文档级 target（partDoc / featureManager / extension …）一律跟着
        /// 同一个文档走 —— 否则 SelectionManager 选中 A、特征建到 B。
        /// </summary>
        static object Target(SwHost h, Dictionary<string, object> req, string name)
        {
            string key = (name ?? "doc").ToLowerInvariant();
            if (key == "app" || key == "sldworks") return h.App;
            if (key == "mathutility") return h.App.GetMathUtility();

            IModelDoc2 doc = Document(h, req, key);
            if (doc == null)
            {
                if (key == "doc" || key == "modeldoc" || key == "activedoc") return null;
                throw new BridgeError("NO_ACTIVE_DOC",
                    "no active document; open or create one before invoking \"" + name + "\"");
            }
            switch (key)
            {
                // doc / modelDoc / activeDoc 都回文档对象本身：前三者的差别只在
                // **怎么选出这份文档**（designId vs 前台），已经在 Document() 里决定了。
                case "doc": case "modeldoc": case "activedoc": return doc;
                case "partdoc": return doc as IPartDoc;
                case "assemblydoc": return doc as IAssemblyDoc;
                case "drawingdoc": return doc as IDrawingDoc;
                case "featuremanager": return doc.FeatureManager;
                case "sketchmanager": return doc.SketchManager;
                case "extension": return doc.Extension;
                case "selectionmanager": return doc.SelectionManager;
                case "modelview": return doc.ActiveView;
            }
            throw new BridgeError("UNKNOWN_TARGET", "unknown target \"" + name + "\"");
        }

        /// <summary>request 的 designId 决定了 target 落在哪份文档上。</summary>
        static IModelDoc2 Document(SwHost h, Dictionary<string, object> req, string key)
        {
            string designId = Json.Str(req, "designId", null);
            if (key == "activedoc")
            {
                // 显式点名「前台那份」：旧行为，保留，但必须写清楚才能用。
                return (IModelDoc2)h.App.IActiveDoc2;
            }
            if (!string.IsNullOrEmpty(designId))
            {
                IModelDoc2 doc = Operations.DesignDocument(h, designId);
                if (doc == null)
                    throw new BridgeError("DOC_NOT_OPEN",
                        "no open document for design \"" + designId + "\"; invoke never falls back to "
                        + "whichever document happens to be in front (that is how dimensions ended up "
                        + "attached to an unrelated old part). Open/build it first, or pass "
                        + "target=\"activeDoc\" to mean the front document on purpose.",
                        Json.Dict("designId", designId, "target", key));
                return doc;
            }
            IModelDoc2 front = (IModelDoc2)h.App.IActiveDoc2;
            if (front != null)
            {
                // 回包里会带 documentFallback=true / activeDocument=true，调用方看得见
                // 「这次没按 designId，动的是前台」。沉默的兜底才是危险的那种。
                req["_documentFallback"] = true;
            }
            return front;
        }

        /// <summary>Picks the overload that best fits the supplied arguments.
        /// Overloads differing only in numeric width (Double vs Int32) are common
        /// in this API, so an all-numeric argument list must be scored, not matched
        /// literally.</summary>
        static MethodInfo Pick(Type type, string member, string ifaceName, Dictionary<string, object> req)
        {
            Type scope = Find(ifaceName) ?? type;
            ArrayList rawArgs = Args(req);
            int argCount = rawArgs == null ? 0 : rawArgs.Count;

            List<MethodInfo> candidates = new List<MethodInfo>();
            foreach (MethodInfo m in scope.GetMethods())
            {
                if (!string.Equals(m.Name, member, StringComparison.OrdinalIgnoreCase)) continue;
                if (m.GetParameters().Length != argCount) continue;
                candidates.Add(m);
            }
            if (candidates.Count == 0)
                foreach (MethodInfo m in type.GetMethods())
                {
                    if (!string.Equals(m.Name, member, StringComparison.OrdinalIgnoreCase)) continue;
                    if (m.GetParameters().Length != argCount) continue;
                    candidates.Add(m);
                }
            if (candidates.Count == 0) return null;
            if (candidates.Count == 1) return candidates[0];

            int explicitIndex = Json.Int(req, "overload", -1);
            if (explicitIndex >= 0 && explicitIndex < candidates.Count) return candidates[explicitIndex];

            int best = 0;
            int bestScore = int.MinValue;
            for (int i = 0; i < candidates.Count; i++)
            {
                int score = 0;
                ParameterInfo[] ps = candidates[i].GetParameters();
                for (int j = 0; j < ps.Length; j++)
                {
                    object v = rawArgs[j];
                    Type t = ps[j].ParameterType;
                    if (t.IsByRef) t = t.GetElementType();
                    if (v == null) continue;
                    if (t == typeof(double) && v is double) score += 2;
                    else if (t == typeof(int) && v is double) score += 1;
                    else if (t == typeof(bool) && v is bool) score += 2;
                    else if (t == typeof(string) && v is string) score += 2;
                    else if (t.IsAssignableFrom(v.GetType())) score += 2;
                }
                if (score > bestScore) { bestScore = score; best = i; }
            }
            return candidates[best];
        }

        static object Convert(object v, Type t)
        {
            if (t.IsByRef) t = t.GetElementType();
            if (v == null) return t.IsValueType ? Activator.CreateInstance(t) : null;
            // {"$ref":"obj_3"} means "the live object behind this handle", so a
            // sequence can pass one call's result into the next without the model
            // ever holding a COM pointer.
            Dictionary<string, object> byRef = v as Dictionary<string, object>;
            if (byRef != null && byRef.ContainsKey("$ref"))
            {
                object live = Handles.Require(Json.Str(byRef, "$ref", null));
                if (t.IsAssignableFrom(live.GetType())) return live;
                return live;
            }
            if (t == typeof(double)) return Json.ToDouble(v, 0);
            if (t == typeof(float)) return (float)Json.ToDouble(v, 0);
            if (t == typeof(int)) return (int)Json.ToDouble(v, 0);
            if (t == typeof(short)) return (short)Json.ToDouble(v, 0);
            if (t == typeof(long)) return (long)Json.ToDouble(v, 0);
            if (t == typeof(bool)) return v is bool ? v : Json.ToDouble(v, 0) != 0;
            if (t == typeof(string)) return v.ToString();
            if (t.IsArray)
            {
                ArrayList src = v as ArrayList;
                if (src == null) return null;
                Type el = t.GetElementType();
                Array arr = Array.CreateInstance(el, src.Count);
                for (int i = 0; i < src.Count; i++) arr.SetValue(Convert(src[i], el), i);
                return arr;
            }
            if (t.IsAssignableFrom(v.GetType())) return v;
            return v;
        }

        /// <summary>Reduces a call result to something JSON can carry. Live COM
        /// objects are never serialised by value: only their type and a few safe
        /// scalars, so the caller cannot end up holding a proxy we do not own.</summary>
        internal static object Summarise(object v)
        {
            if (v == null) return null;
            if (v is string || v is bool) return v;
            if (v is int || v is long || v is short) return v;
            if (v is double) return Json.R((double)v);
            if (v is float) return Json.R((float)v);

            Array arr = v as Array;
            if (arr != null)
            {
                List<object> items = new List<object>();
                for (int i = 0; i < arr.Length && i < 24; i++) items.Add(Summarise(arr.GetValue(i)));
                return Json.Dict("kind", "array", "length", arr.Length,
                    "handle", Handles.Register(arr, "Array"), "items", items);
            }
            if (v is IEnumerable && !(v is string))
            {
                List<object> items = new List<object>();
                foreach (object o in (IEnumerable)v)
                {
                    if (items.Count >= 24) break;
                    items.Add(Summarise(o));
                }
                return Json.Dict("kind", "sequence", "items", items);
            }
            bool isCom = System.Runtime.InteropServices.Marshal.IsComObject(v);
            if (isCom)
            {
                // A live COM object is not JSON. Give it a handle so the next call
                // can chain onto it (SketchManager -> segments, feature -> faces...).
                string handle = Handles.Register(v, v.GetType().Name);
                return Json.Dict("kind", "comObject", "handle", handle,
                    "type", v.GetType().Name, "text", SafeToText(v));
            }
            return Json.Dict("kind", "object", "type", v.GetType().Name, "text", SafeToText(v));
        }

        static string SafeToText(object v)
        {
            try
            {
                string s = v.ToString();
                if (s == null) return null;
                return s.Length > 200 ? s.Substring(0, 200) : s;
            }
            catch { return null; }
        }
    }
}
