using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Compiles a design definition into builder calls.
    ///
    /// The definition carries semantic parameters and declarative features; this
    /// class is the only place that knows how a semantic name maps onto a
    /// SOLIDWORKS feature and dimension. Parameters are pushed into SOLIDWORKS
    /// global variables first, so a later edit made by a human inside SOLIDWORKS
    /// keeps the same relationships.</summary>
    sealed class Compiler
    {
        readonly SwHost _host;
        readonly IModelDoc2 _doc;
        readonly Dictionary<string, double> _params = new Dictionary<string, double>();
        readonly Dictionary<string, string> _bindings = new Dictionary<string, string>();
        // 本机 SOLIDWORKS 拒绝方程式时，尺寸仍然是原生的，只是没有全局变量。
        // 记下参数→尺寸名，编辑时直接改 SystemValue 并回读，避免整件重建。
        readonly Dictionary<string, string> _dimensionBindings = new Dictionary<string, string>();
        // Live COM references captured during the build. Dimension-name lookups are
        // unreliable in some builds; the same worker process can reuse these instead.
        readonly Dictionary<string, IDimension> _dimensionHandles = new Dictionary<string, IDimension>();
        readonly List<string> _notes = new List<string>();
        readonly Dictionary<string, IFeature> _sketches = new Dictionary<string, IFeature>();
        // 螺旋线 / 扫掠 / 放样之后的特征：后续动作可以按 id 把它当作路径或引导线引用。
        // 与 _sketches 分开是故意的 —— 它不是草图，塞进草图表会让一个后来的
        // extrude 拿它当轮廓，然后在 SketchNotSelected 上失败，错误指向完全无关的地方。
        readonly Dictionary<string, IFeature> _curves = new Dictionary<string, IFeature>();
        // Which reference plane each sketch was built on, by feature name: needed to
        // decide what "extrude towards +Y" means for that sketch.
        readonly Dictionary<string, int> _sketchPlanes = new Dictionary<string, int>();
        bool _disableBindings;
        bool _renamed;

        public Compiler(SwHost host, IModelDoc2 doc)
        {
            _host = host;
            _doc = doc;
        }

        /// <summary>Turns off equation writing. Used by the isolation experiment:
        /// building the same definition with and without bindings separates a
        /// geometry bug from an equation bug.</summary>
        public bool DisableBindings
        {
            get { return _disableBindings; }
            set { _disableBindings = value; }
        }

        public Dictionary<string, double> Params { get { return _params; } }
        public Dictionary<string, string> Bindings { get { return _bindings; } }
        public Dictionary<string, string> DimensionBindings { get { return _dimensionBindings; } }
        public Dictionary<string, IDimension> DimensionHandles { get { return _dimensionHandles; } }
        public List<string> Notes { get { return _notes; } }

        /// <summary>Resolves "plate.w", "plate.w - 2*boss.d" and plain numbers.</summary>
        public double Resolve(object expr)
        {
            string s = Convert.ToString(expr, System.Globalization.CultureInfo.InvariantCulture);
            if (string.IsNullOrEmpty(s)) return 0;
            return Expr.Eval(s, _params);
        }

        // ------------------------------------------------------------- parameters

        /// <summary>Registers every design parameter. Units are millimetres in the
        /// definition; SOLIDWORKS global variables are written in millimetres too,
        /// because a variable is a unitless number applied to a dimension whose own
        /// units decide the conversion.</summary>
        public void DeclareParameters(Dictionary<string, object> parameters)
        {
            if (parameters == null) return;
            // 数字字面量先落地，其余按依赖反复扫描：一次扫描只能解决「依赖已就绪」
            // 的参数，依赖后声明的要等下一轮。整轮没有进展就是环或拼错的名字，
            // 必须报 PARAM_CYCLE，而不是把未解析的参数悄悄算成 0。
            List<KeyValuePair<string, object>> pending = new List<KeyValuePair<string, object>>();
            foreach (KeyValuePair<string, object> kv in parameters)
            {
                string raw = Convert.ToString(kv.Value, System.Globalization.CultureInfo.InvariantCulture);
                if (Expr.IsNumericLiteral(raw))
                    _params[kv.Key] = double.Parse(raw, System.Globalization.CultureInfo.InvariantCulture);
                else
                    pending.Add(kv);
            }
            while (pending.Count > 0)
            {
                List<KeyValuePair<string, object>> deferred = new List<KeyValuePair<string, object>>();
                foreach (KeyValuePair<string, object> kv in pending)
                {
                    if (_params.ContainsKey(kv.Key)) continue;
                    try
                    {
                        _params[kv.Key] = Resolve(kv.Value);
                    }
                    catch (BridgeError be)
                    {
                        if (be.Code == "UNKNOWN_PARAM")
                        {
                            deferred.Add(kv);
                            continue;
                        }
                        throw;
                    }
                }
                if (deferred.Count == pending.Count)
                {
                    List<string> names = new List<string>();
                    foreach (KeyValuePair<string, object> kv in deferred) names.Add(kv.Key);
                    throw new BridgeError("PARAM_CYCLE",
                        "parameters cannot be resolved (cycle or unknown name): " + string.Join(", ", names),
                        Json.Dict("parameters", names));
                }
                pending = deferred;
            }
        }

        /// <summary>Writes one global variable per parameter into the SOLIDWORKS
        /// equation manager. Returns the equations that actually landed.</summary>
        /// <summary>本轮新加进去的变量数与「原来就有」的变量数。</summary>
        public int VariablesAdded = 0;
        public int VariablesExisted = 0;

        /// <summary>方程式列表里已经有这个名字的变量了吗。</summary>
        bool VariableExists(IEquationMgr eq, string name)
        {
            string prefix = "\"" + name + "\"";
            int count = eq.GetCount();
            for (int i = 0; i < count; i++)
            {
                string text = null;
                try { text = eq.get_Equation(i); }
                catch (COMException) { }
                if (text == null) continue;
                if (text.StartsWith(prefix, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        public List<object> PushGlobalVariables()
        {
            List<object> written = new List<object>();
            IEquationMgr eq = (IEquationMgr)_doc.GetEquationMgr();
            foreach (KeyValuePair<string, double> kv in _params)
            {
                string name = GlobalName(kv.Key);
                if (name == null) continue;
                // 绑定尺寸时 SW 已经隐式把这个变量建出来了：再 Add2 一条同名变量会被拒，
                // 而变量本身是对的，所以这里记「已存在」而不是制造一次假失败。
                if (VariableExists(eq, name))
                {
                    VariablesExisted++;
                    written.Add(Json.Dict("name", name, "param", kv.Key, "value", kv.Value, "rc", 2,
                        "mode", "existed"));
                    continue;
                }
                string text = "\"" + name + "\" = " + Json.Num(kv.Value);
                int rc = eq.Add2(-1, text, true);
                if (rc >= 0) VariablesAdded++;
                written.Add(Json.Dict("name", name, "param", kv.Key, "value", kv.Value, "rc", rc,
                    "text", text, "mode", "added"));
                if (rc < 0) _notes.Add("global variable " + name + " returned rc=" + rc);
            }
            return written;
        }

        /// <summary>SOLIDWORKS rejects dots in variable names, so the dotted design
        /// parameter becomes a flattened variable name. The mapping is recorded in
        /// the bindings so the JSON and the model stay connected.</summary>
        static string GlobalName(string param)
        {
            if (string.IsNullOrEmpty(param)) return null;
            string name = param.Replace('.', '_').Replace('-', '_').Replace(' ', '_');
            if (!IsIdentifier(name)) return null;
            return name;
        }

        /// <summary>Adds a derived global variable whose right-hand side is a
        /// SOLIDWORKS expression over other variables. Verified: SOLIDWORKS evaluates
        /// and re-propagates these (plateW/2 - edge went 20 -> 40 when plateW moved
        /// 60 -> 100), so a hole offset can live natively instead of in our JSON.</summary>
        public bool AddDerivedVariable(string name, string solidworksExpression)
        {
            if (!IsIdentifier(name)) return false;
            IEquationMgr eq = (IEquationMgr)_doc.GetEquationMgr();
            string text = "\"" + name + "\" = " + solidworksExpression;
            int rc = eq.Add2(-1, text, true);
            bool ok = rc >= 0;
            if (!ok) _notes.Add("derived variable " + name + " returned rc=" + rc + " (negative means rejected)");
            else _derived.Add(Json.Dict("name", name, "expression", solidworksExpression));
            return ok;
        }

        readonly List<object> _derived = new List<object>();
        public List<object> DerivedVariables { get { return _derived; } }

        static bool IsIdentifier(string s)
        {
            if (string.IsNullOrEmpty(s)) return false;
            if (!char.IsLetter(s[0]) && s[0] != '_') return false;
            foreach (char c in s)
                if (!char.IsLetterOrDigit(c) && c != '_') return false;
            return true;
        }

        /// <summary>请求过绑定、却一条都没落到 SOLIDWORKS 里。</summary>
        public int RequestedBinds = 0;
        /// <summary>方程式写不成时，靠直接改尺寸值落地的绑定数。</summary>
        public int LiteralApplied = 0;

        /// <summary>
        /// 请求过绑定，却一条都没绑上 —— 这一版根本没有变量驱动。
        /// 长跑的实例会进入这种状态（方程式管理器拒写），只有重启才恢复；
        /// 悄悄交一个静态件比在这里失败更糟。
        /// </summary>
        /// <summary>第一条写失败的绑定备注，给错误 detail 用。</summary>
        /// <summary>未保存文档里 FullName 可能带 .Part 后缀而方程式管理器不认。</summary>
        static string StripPartSuffix(string fullName)
        {
            if (fullName == null) return fullName;
            int at = fullName.LastIndexOf('@');
            if (at < 0) return fullName;
            string doc = fullName.Substring(at + 1);
            if (doc.EndsWith(".Part", StringComparison.OrdinalIgnoreCase))
                return fullName.Substring(0, at + 1) + doc.Substring(0, doc.Length - 5);
            return fullName;
        }

        public string FirstBindNote()
        {
            foreach (string note in _notes)
                if (note != null && note.StartsWith("bind ", StringComparison.Ordinal)) return note;
            return null;
        }

        public bool AllBindingsRejected()
        {
            return RequestedBinds > 0 && _bindings.Count == 0;
        }

        /// <summary>Binds an existing dimension to a global variable so the relation
        /// lives in SOLIDWORKS, not only in our JSON. Add2 returns 2 on success.</summary>
        public bool BindDimension(IDimension dim, string paramName)
        {
            string global = GlobalName(paramName);
            if (dim == null || global == null) return false;
            if (_disableBindings) { _notes.Add("bindings disabled by request"); return false; }
            RequestedBinds++;
            // 参数驱动的兜底：本机 SW 拒绝写方程式时绑定不会生效，但参数值至少要真正
            // 落到尺寸上 —— 否则「改参数重建」重建出来还是原值（又一次看起来成功）。
            double paramValueMm;
            if (_params.TryGetValue(paramName, out paramValueMm))
            {
                try
                {
                    dim.SystemValue = paramValueMm / 1000.0;
                    LiteralApplied++;
                    _dimensionBindings[paramName] = dim.FullName;
                    _dimensionHandles[paramName] = dim;
                    _notes.Add("bind " + paramName + " applied as literal value " + paramValueMm
                        + " (equations unavailable; dimension is still native)");
                }
                catch (COMException) { }
            }
            IEquationMgr eq = (IEquationMgr)_doc.GetEquationMgr();
            // 同一个「尺寸 = 变量」在不同状态下要用不同写法，实测过：
            //   · 文档里还没有这个全局变量时，带引号的 "dim" = "var" 会让 SW 隐式建变量并成功；
            //   · 变量已经存在时同样的写法返回 rc=-1，去掉变量侧的引号才成立。
            // 所以不猜，按顺序试，第一个成功的记下来；四种都不成立才算真的绑不上。
            string[] candidates = new string[]
            {
                "\"" + dim.FullName + "\" = \"" + global + "\"",
                "\"" + dim.FullName + "\" = " + global,
                "\"" + StripPartSuffix(dim.FullName) + "\" = \"" + global + "\"",
                "\"" + StripPartSuffix(dim.FullName) + "\" = " + global,
            };
            int rc = -1;
            string text = candidates[0];
            int countBefore = eq.GetCount();
            // index 也一起试：-1 是「追加」，0 是「插到最前」；有的实例只认其中一种。
            int[] indices = new int[] { -1, 0, countBefore };
            bool[] creates = new bool[] { true, false };
            string cacheVersion = EquationCapability.VersionOf(_host);
            string cacheKey = EquationCapability.KeyOf(dim.FullName);
            if (EquationCapability.IsRejected(cacheVersion, cacheKey))
            {
                _notes.Add("bind " + paramName + " skipped: " + cacheVersion + " already rejected " + cacheKey
                    + " in this process");
                return false;
            }
            // 先试上次成功的那一组，通常一次 Add2 就够；失败说明缓存过期，回退全量探测。
            string cachedStrategy;
            if (EquationCapability.TryGet(cacheVersion, cacheKey, out cachedStrategy))
            {
                string[] cells = cachedStrategy.Split('|');
                int ci, ii;
                bool cc;
                if (cells.Length == 3 && int.TryParse(cells[0], out ci) && int.TryParse(cells[1], out ii)
                    && bool.TryParse(cells[2], out cc) && ci >= 0 && ci < candidates.Length)
                {
                    int cachedRc = -1;
                    try { cachedRc = eq.Add2(ii, candidates[ci], cc); }
                    catch (COMException) { cachedRc = -1; }
                    if (cachedRc >= 0)
                    {
                        _bindings[paramName] = dim.FullName;
                        _notes.Add("bind " + paramName + " used cached form " + candidates[ci]);
                        return true;
                    }
                }
            }
            bool done = false;
            int successCandidate = -1;
            int successIndex = -1;
            bool successCreate = false;
            for (int ii = 0; ii < indices.Length && !done; ii++)
            {
                for (int cc = 0; cc < creates.Length && !done; cc++)
                {
                    for (int ci = 0; ci < candidates.Length && !done; ci++)
                    {
                        text = candidates[ci];
                        try { rc = eq.Add2(indices[ii], text, creates[cc]); }
                        catch (COMException ex) { rc = -1; _notes.Add("bind " + paramName + " threw " + ex.HResult); }
                        if (rc >= 0)
                        {
                            done = true;
                            successCandidate = ci;
                            successIndex = indices[ii];
                            successCreate = creates[cc];
                        }
                    }
                }
            }
            bool ok = rc >= 0;
            if (ok)
            {
                _bindings[paramName] = dim.FullName;
                EquationCapability.Remember(cacheVersion, cacheKey,
                    successCandidate + "|" + successIndex + "|" + successCreate);
                if (successCandidate != 0) _notes.Add("bind " + paramName + " used form: " + text);
            }
            else
            {
                EquationCapability.MarkRejected(cacheVersion, cacheKey);
                _notes.Add("bind " + paramName + " -> " + dim.FullName + " returned rc=" + rc
                    + " for all four forms; the dimension stays a literal");
            }
            return ok;
        }

        /// <summary>Binds a dimension to a SOLIDWORKS expression instead of a bare
        /// variable. Needed wherever our semantic parameter and the underlying
        /// dimension differ by a factor: a symmetric extrusion stores half the
        /// thickness, so binding the full thickness here silently doubles the part.</summary>
        public bool BindDimensionToExpression(IDimension dim, string paramName, string righthand)
        {
            if (dim == null || righthand == null) return false;
            if (_disableBindings) { _notes.Add("bindings disabled by request"); return false; }
            IEquationMgr eq = (IEquationMgr)_doc.GetEquationMgr();
            string text = "\"" + dim.FullName + "\" = " + righthand;
            int rc = eq.Add2(-1, text, true);
            bool ok = rc >= 0;
            if (ok) _bindings[paramName] = dim.FullName;
            else _notes.Add("bind " + paramName + " -> " + dim.FullName + " as " + righthand
                + " returned rc=" + rc + "; the dimension stays a literal");
            return ok;
        }

        public void Evaluate()
        {
            IEquationMgr eq = (IEquationMgr)_doc.GetEquationMgr();
            eq.EvaluateAll();
            _doc.EditRebuild3();
        }

        // ---------------------------------------------------------------- features

        /// <summary>Runs the feature list in order. Each feature is a dictionary
        /// with "kind" plus kind-specific fields; unknown kinds fail loudly rather
        /// than being skipped, because a silently missing feature is a wrong model.</summary>
        public List<object> BuildFeatures(IEnumerable<object> features, Builder b)
        {
            List<object> built = new List<object>();
            int index = 0;
            foreach (object raw in features)
            {                Dictionary<string, object> f = Json.Obj(raw);
                if (f == null) continue;
                index++;
                string kind = Json.Str(f, "kind", "");
                string id = Json.Str(f, "id", kind + "#" + index);
                _notes.Add("feature " + index + " " + kind + " id=" + id);

                // A failure three features in is useless without knowing which
                // feature, what its spec said, and what the steps before it did.
                // Re-throwing with that context turns "CUT_FAILED" into a bug report.
                int builtBefore = built.Count;
                try
                {
                    BuildOne(f, kind, id, index, b, built);
                }
                catch (BridgeError be)
                {
                    throw new BridgeError(be.Code, be.Message, Json.Dict(
                        "featureIndex", index,
                        "featureKind", kind,
                        "featureId", id,
                        "featureSpec", f,
                        "builderSteps", new List<object>(b.StepsSnapshot()),
                        "notes", new List<object>(_notes.ToArray()),
                        "inner", be.Detail));
                }
                // 每个特征之后的整件包围盒：体积和总包围盒挡不住的落位/镜像错误，
                // 在这里能直接看出来（抽屉到底落在 Y 560-700 还是 560-720）。
                Dictionary<string, object> postBox = PartBox();
                if (postBox != null)
                {
                    for (int k = builtBefore; k < built.Count; k++)
                    {
                        Dictionary<string, object> item = built[k] as Dictionary<string, object>;
                        if (item != null && !item.ContainsKey("box")) item["box"] = postBox;
                    }
                }
            }
            // Renaming a feature rewrites its dimensions' full names, and an equation
            // that drives such a dimension keeps pointing at the old name — the variable
            // then still reads back correctly while the geometry stops moving. Repair
            // once at the end so edit parameters works without a save in between.
            if (_renamed)
            {
                try
                {
                    List<object> repaired = new Editor(_doc).RepairEquationReferences();
                    if (repaired.Count > 0)
                        _notes.Add("repaired " + repaired.Count
                            + " equation reference(s) after renaming features");
                }
                catch (Exception ex)
                {
                    _notes.Add("could not repair equation references after renaming ("
                        + ex.Message + ")");
                }
            }
            return built;
        }

        /// <summary>整件包围盒（mm），所有实体求并。特征建完就量一次，用来定位。</summary>
        Dictionary<string, object> PartBox()
        {
            IPartDoc part = _doc as IPartDoc;
            if (part == null) return null;
            Array arr;
            try { arr = part.GetBodies2((int)swBodyType_e.swSolidBody, false) as Array; }
            catch (COMException) { return null; }
            if (arr == null || arr.Length == 0) return null;
            double[] box = null;
            foreach (object o in arr)
            {
                IBody2 body = o as IBody2;
                if (body == null) continue;
                double[] b = null;
                try { b = body.GetBodyBox() as double[]; } catch (COMException) { }
                if (b == null || b.Length < 6) continue;
                if (box == null) box = (double[])b.Clone();
                else
                {
                    box[0] = Math.Min(box[0], b[0]); box[1] = Math.Min(box[1], b[1]); box[2] = Math.Min(box[2], b[2]);
                    box[3] = Math.Max(box[3], b[3]); box[4] = Math.Max(box[4], b[4]); box[5] = Math.Max(box[5], b[5]);
                }
            }
            if (box == null) return null;
            return Json.Dict(
                "min", new List<object> { Json.R(box[0] * 1000), Json.R(box[1] * 1000), Json.R(box[2] * 1000) },
                "max", new List<object> { Json.R(box[3] * 1000), Json.R(box[4] * 1000), Json.R(box[5] * 1000) });
        }

        void BuildOne(Dictionary<string, object> f, string kind, string id, int index,
            Builder b, List<object> built)
        {
            {
                switch (kind)
                {
                    case "basePlate":
                    {
                        double w = Resolve(f["width"]);
                        double h = Resolve(f["height"]);
                        double t = Resolve(f["thickness"]);
                        int plane = Json.Int(f, "plane", 0);
                        IFeature feat = b.BasePlate(plane, w, h, t);
                        // Rename before binding: a bind writes the variable into the
                        // dimension, and the name it resolves against has to be final.
                        Rename(feat, id);
                        BindDisplay("plate.w", First(b.PlateDimensions, 0));
                        BindDisplay("plate.h", First(b.PlateDimensions, 1));
                        // A symmetric extrusion drives each direction from its own
                        // dimension. Binding only D1 left D2 at its drawn literal, so
                        // a thickness change grew one side by 5 mm and the part came
                        // out 25 mm thick instead of 30.
                        string halfT = "\"" + GlobalName("plate.t") + "\"/2";
                        Bind("plate.t", feat, "D1", halfT);
                        Bind("plate.t", feat, "D2", halfT);
                        built.Add(Describe(feat, kind, id, b));
                        break;
                    }
                    case "sketch":
                    {
                        Dictionary<string, object> spec = Json.Obj(f.ContainsKey("profile") ? f["profile"] : f);
                        bool parametric;
                        IFeature sketch = SketchFromSpec(b, spec, id, out parametric);
                        Dictionary<string, object> shape = Profiles.Describe(sketch);
                        if (shape.ContainsKey("openEnds") && Convert.ToInt32(shape["openEnds"]) > 0)
                            _notes.Add("sketch " + id + " is open: " + shape["openEnds"]
                                + " loose endpoint(s) — an extrusion will refuse it");
                        // Read defensively: Describe returns nothing useful when the
                        // sketch never opened (an offset plane that failed, say), and an
                        // indexer there turned "the sketch is missing" into a
                        // KeyNotFoundException with no idea which feature caused it.
                        built.Add(Json.Dict(
                            "id", id, "kind", kind,
                            "featureName", sketch == null ? null : sketch.Name,
                            "type", sketch == null ? null : sketch.GetTypeName2(),
                            "parametric", parametric,
                            "segments", shape.ContainsKey("segments") ? shape["segments"] : null,
                            "openEnds", shape.ContainsKey("openEnds") ? shape["openEnds"] : null,
                            "closed", shape.ContainsKey("closed") ? shape["closed"] : null,
                            "bound", BindNames(spec)));
                        if (sketch == null)
                            throw new BridgeError("SKETCH_NOT_CREATED",
                                "sketch " + id + " produced no feature — the plane it asked for "
                                + "probably never became the active plane");
                        break;
                    }
                    case "extrude":
                    case "cut":
                    {
                        bool parametric;
                        IFeature sketch = SketchForFeature(b, f, out parametric);
                        double depth = Resolve(f.ContainsKey("depth") ? f["depth"] : 0);
                        bool symmetric = Json.Bool(f, "symmetric", false);
                        bool reverse = Json.Bool(f, "reverse", false);
                        // "direction" is a world axis ("+Y", "-Z", …). Each sketch plane
                        // in this build only extrudes along the NEGATIVE axis of its own
                        // normal (measured: front=−Z, top=−Y, right=−X), so a caller who
                        // says "+Y" means "flip", and one who says "−Y" means "as-is".
                        // Expressing this as a world axis rather than a boolean removes
                        // the guesswork that produced parts lying on their side.
                        string direction = Json.Str(f, "direction", null);
                        bool directionExplicit = direction != null;
                        if (direction != null)
                        {
                            string axis = DirectionAxis(_sketchPlanes.ContainsKey(sketch.Name)
                                ? _sketchPlanes[sketch.Name] : -1);
                            bool flip;
                            string why = ResolveDirection(direction, axis, out flip);
                            if (why != null)
                                throw new BridgeError("BAD_DIRECTION", why);
                            reverse = flip;
                            _notes.Add("extrude " + id + " direction " + direction
                                + " on plane axis " + axis + " -> flip=" + flip);
                        }
                        bool throughAll = Json.Bool(f, "throughAll", false);
                        // A cut sketched on a plane inside the body needs both directions;
                        // without it the far half stays and the feature looks half-done.
                        bool both = Json.Bool(f, "both", false);
                        double draft = Json.Dbl(f, "draft", 0);
                        double startOffset = Json.Dbl(f, "startOffset", 0);
                        // merge=false：多实体零件。默认 true（与 SOLIDWORKS 一致），
                        // 显式 false 才允许"新实体不与旧实体合并"。
                        bool merge = Json.Bool(f, "merge", true);
                        int bodiesBefore = BodyCount();
                        IFeature feat = b.ExtrudeSketch(sketch, depth, symmetric, reverse,
                            kind == "cut", throughAll, draft, both, startOffset, directionExplicit, merge);
                        _notes.Add("extrude " + id + " merge=" + merge + " bodies " + bodiesBefore + " -> " + BodyCount());

                        // A second body means the profile never touched the material it was
                        // meant to join. That is NOT a hint that the direction was wrong:
                        // flipping it silently turned a bracket whose web sat 0.3 mm off the
                        // plate into two disconnected parts, and every later feature then
                        // worked on whichever body it happened to hit.
                        // 例外：显式 merge:false = 明确要多实体，不按错误处理。
                        if (kind == "extrude" && merge && bodiesBefore > 0 && BodyCount() > bodiesBefore)
                            throw new BridgeError("EXTRUDE_SEPARATE_BODY",
                                "extrude \"" + id + "\" produced a body that is not connected to "
                                + "the rest of the part (bodies " + bodiesBefore + " -> "
                                + BodyCount() + "). Its profile has to overlap the material it "
                                + "should join — check the sketch plane and any startOffset, "
                                + "rather than the direction flag.",
                                Json.Dict("featureId", id, "bodiesBefore", bodiesBefore,
                                    "bodiesAfter", BodyCount()));

                        Rename(feat, id);
                        string depthParam = BindNameOf(f, "depth");
                        if (depthParam != null && _params.ContainsKey(depthParam) && !throughAll)
                        {
                            if (symmetric)
                            {
                                // Symmetric extrusion drives each side from its own
                                // dimension; binding only D1 left the part half thick.
                                string half = "\"" + GlobalName(depthParam) + "\"/2";
                                Bind(depthParam, feat, "D1", half);
                                Bind(depthParam, feat, "D2", half);
                            }
                            else Bind(depthParam, feat, "D1");
                        }
                        else if (depthParam != null && throughAll)
                            _notes.Add("depth parameter " + depthParam + " is unused: the cut goes through all");

                        Rename(feat, id);
                        built.Add(Json.Dict(
                            "id", id, "kind", kind,
                            "featureName", feat == null ? null : feat.Name,
                            "type", feat == null ? null : feat.GetTypeName2(),
                            "parametric", parametric && (depthParam != null || throughAll),
                            "depth", depth,
                            "symmetric", symmetric,
                            "throughAll", throughAll,
                            "sketch", sketch == null ? null : sketch.Name));
                        break;
                    }
                    case "revolve":
                    {
                        bool parametric;
                        IFeature sketch = SketchForFeature(b, f, out parametric);
                        double angle = Json.Dbl(f, "angle", 360);
                        bool cut = Json.Bool(f, "cut", false);
                        IFeature feat = b.RevolveSketch(sketch, angle, cut, Json.Str(f, "axis", "centerline"));

                        string angleParam = BindNameOf(f, "angle");
                        if (angleParam != null && _params.ContainsKey(angleParam))
                            Bind(angleParam, feat, "D1");

                        built.Add(Json.Dict(
                            "id", id, "kind", kind,
                            "featureName", feat == null ? null : feat.Name,
                            "type", feat == null ? null : feat.GetTypeName2(),
                            "parametric", parametric && angleParam != null,
                            "angle", angle,
                            "cut", cut,
                            "sketch", sketch == null ? null : sketch.Name));
                        break;
                    }
                    case "boss":
                    {
                        double d = Resolve(f["diameter"]);
                        double hgt = Resolve(f["height"]);
                        string faceKind = Json.Str(f, "face", "top");
                        IFeature feat = b.Boss(delegate { return PickPlanarFace(faceKind); }, d, hgt);
                        BindDisplay("boss.d", First(b.BossDimensions, 0));
                        Bind("boss.h", feat, "D1");
                        built.Add(Describe(feat, kind, id, b));
                        break;
                    }
                    case "throughHoles":
                    case "holes":
                    {
                        double d = Resolve(f["diameter"]);
                        string faceKind = Json.Str(f, "face", "top");
                        List<double[]> centres = Centres(f);
                        bool throughAll = Json.Bool(f, "throughAll", true);
                        double depth = Json.Dbl(f, "depth", 0);
                        PrepareHolePosition(f, b);
                        // 两孔且没指名面时，草图画在设计平面上：拾取的面的草图坐标系
                        // 与设计平面不一定同向（u/v 可能互换），4 孔对称看不出来，两孔
                        // 会落到板外并让 FeatureCut4 回 null。
                        bool pairOnPlane = centres.Count == 2 && !f.ContainsKey("face");
                        IFeature feat;
                        if (pairOnPlane)
                            feat = b.HolesOnPlane(Json.Int(f, "plane", 1), centres, d, throughAll, depth);
                        else
                            feat = b.Holes(delegate { return PickPlanarFace(faceKind); },
                                centres, d, throughAll, depth);
                        if (!throughAll) Bind("hole.depth", feat, "D1");
                        BindCircles(b.HoleDimensions, "hole.d");
                        PositionHoleGroup(f, b);
                        built.Add(Describe(feat, kind, id, b));
                        break;
                    }
                    case "fillet":
                    {
                        double r = Resolve(f["radius"]);
                        bool onBottom = Json.Bool(f, "onBottom", true);
                        IFeature feat = b.FilletVerticalEdges(r, onBottom);
                        // A fillet's radius lives under a name the API does not document
                        // consistently (R1 on some builds, D1/D2 on others). Try the
                        // candidates and bind the one that answers, so "every parameter
                        // is bound" stays a statement about the model, not about luck.
                        string radiusParam = Json.Str(f, "radius", null);
                        if (radiusParam != null && _params.ContainsKey(radiusParam))
                        {
                            foreach (string candidate in new string[] { "R1", "D1", "D2", "R" })
                            {
                                if (BindIfPresent(radiusParam, feat, candidate)) break;
                            }
                        }
                        built.Add(Describe(feat, kind, id, b));
                        break;
                    }
                    case "edgeFillet":
                    {
                        // A fillet on a *circular* edge, chosen by the circle it lies on
                        // rather than by an edge index: "the mouth of the 14 mm slot, at
                        // the plate's top face, radius 3" survives a rebuild, an edge
                        // renumber, and a different order of features.
                        double radius = Resolve(f["radius"]);
                        double circleDiameter = Resolve(f["circleDiameter"]);
                        double atY = Resolve(f["atY"]);
                        double tolerance = Json.Dbl(f, "tolerance", 0.05);
                        IFeature feat = b.FilletCircularEdgesAtHeight(circleDiameter, atY, tolerance);
                        string radiusParam = Json.Str(f, "radius", null);
                        if (radiusParam != null && _params.ContainsKey(radiusParam))
                        {
                            foreach (string candidate in new string[] { "R1", "D1", "D2", "R" })
                            {
                                if (BindIfPresent(radiusParam, feat, candidate)) break;
                            }
                        }
                        built.Add(Describe(feat, kind, id, b));
                        break;
                    }
                    case "helix":
                    {
                        // 螺旋线：底圆草图（d1/df）→ InsertHelix → 一条 3D 曲线特征。
                        // 只有它才能让蜗杆的齿面是真螺旋面；「回转芯 + 偏心圆盘错位拉伸」
                        // 那种近似在装配里穿模 9 mm，是这张工单的起点。
                        bool parametric;
                        IFeature baseSketch = SketchForFeature(b, f, out parametric);
                        Sweeps sweeps = new Sweeps(_host, _doc);
                        IFeature helix = sweeps.Helix(baseSketch,
                            Json.Str(f, "definedBy", "heightAndPitch"),
                            Json.Bool(f, "reversed", false),
                            Json.Bool(f, "clockwise", false),
                            Json.Bool(f, "tapered", false),
                            Json.Bool(f, "outward", false),
                            Resolve(f.ContainsKey("height") ? f["height"] : 0),
                            Resolve(f.ContainsKey("pitch") ? f["pitch"] : 0),
                            f.ContainsKey("revolutions") ? Resolve(f["revolutions"]) : 0,
                            f.ContainsKey("taperAngle") ? Resolve(f["taperAngle"]) : 0,
                            f.ContainsKey("startAngle") ? Resolve(f["startAngle"]) : 0);
                        foreach (string note in sweeps.Steps) _notes.Add(note);
                        Rename(helix, id);
                        _curves[id] = helix;
                        // 螺旋线的几何尺寸由 InsertHelix 的参数直接决定；本机没有可绑定的
                        // 原生尺寸入口。bind 给了名字就必须说出来 —— 静默忽略正是本工单的缺陷。
                        string helixBind = BindNameOf(f, "pitch");
                        if (helixBind != null)
                            _notes.Add("helix " + id + ": \"pitch\" is fixed by the feature parameters; "
                                + "it is not bound to parameter \"" + helixBind + "\" (edit it with model action=edit "
                                + "or rebuild the definition)");
                        built.Add(Json.Dict(
                            "id", id, "kind", kind,
                            "featureName", helix == null ? null : helix.Name,
                            "type", helix == null ? null : helix.GetTypeName2(),
                            "parametric", false,
                            "definedBy", Json.Str(f, "definedBy", "heightAndPitch"),
                            "height", Resolve(f.ContainsKey("height") ? f["height"] : 0),
                            "pitch", Resolve(f.ContainsKey("pitch") ? f["pitch"] : 0),
                            "baseSketch", baseSketch == null ? null : baseSketch.Name));
                        break;
                    }
                    case "sweep":
                    case "sweptCut":
                    {
                        // 扫掠：轮廓（轴向平面）+ 路径（螺旋线或草图）+ 可选引导线。
                        // kind 由动作名决定：sweep 缺省是凸台，sweptCut 一定是切除；
                        // 显式 cut 参数优先于动作名（但两者矛盾时以显式参数为准并记 note）。
                        bool parametric;
                        IFeature profile = f.ContainsKey("profile") && f["profile"] != null
                            ? SketchForFeature(b, f, out parametric) : null;
                        bool cut = string.Equals(kind, "sweptCut", StringComparison.OrdinalIgnoreCase)
                            || Json.Bool(f, "cut", false);
                        IFeature path = CurveFeature(b, f.ContainsKey("path") ? f["path"] : null, "path");
                        List<IFeature> guides = CurveFeatures(b, f.ContainsKey("guides") ? f["guides"] : null, "guides");
                        Sweeps sweeps = new Sweeps(_host, _doc);
                        double thickness = f.ContainsKey("thickness") ? Resolve(f["thickness"]) : 0;
                        double thickness2 = f.ContainsKey("thickness2") ? Resolve(f["thickness2"]) : 0;
                        IFeature feat = sweeps.Sweep(profile, path, guides,
                            cut ? "cut" : "boss",
                            Json.Bool(f, "thin", false), thickness, thickness2,
                            Json.Str(f, "thinType", "oneDirection"),
                            Json.Bool(f, "reverseThickness", false),
                            Json.Bool(f, "propagate", true),
                            Json.Bool(f, "alignment", true),
                            Json.Str(f, "twistControl", "followPath"),
                            f.ContainsKey("twist") ? Resolve(f["twist"]) : 0,
                            Json.Str(f, "startMatch", "none"),
                            Json.Str(f, "endMatch", "none"),
                            Json.Bool(f, "advancedSmoothing", true),
                            Json.Bool(f, "merge", true),
                            Json.Bool(f, "circularProfile", false),
                            f.ContainsKey("circularDiameter") ? Resolve(f["circularDiameter"]) : 0,
                            Json.Bool(f, "reverseDirection", false));
                        foreach (string note in sweeps.Steps) _notes.Add(note);
                        Rename(feat, id);
                        _curves[id] = feat;
                        built.Add(Json.Dict(
                            "id", id, "kind", kind,
                            "featureName", feat == null ? null : feat.Name,
                            "type", feat == null ? null : feat.GetTypeName2(),
                            "parametric", false,
                            "cut", cut,
                            "profile", profile == null ? null : profile.Name,
                            "path", path == null ? null : path.Name,
                            "thin", Json.Bool(f, "thin", false),
                            "twistControl", Json.Str(f, "twistControl", "followPath")));
                        break;
                    }
                    case "loft":
                    case "loftedCut":
                    {
                        // 放样：两段以上截面（大端/小端渐开线）+ 可选引导线。
                        // 直齿锥齿轮的背锥展开渐开线就是靠这个从「圆锥台近似」变成真齿面。
                        List<IFeature> sections = CurveFeatures(b, f.ContainsKey("sections") ? f["sections"] : null, "sections");
                        if (sections.Count == 0 && f.ContainsKey("profile"))
                        {
                            bool profileParametric;
                            sections.Add(SketchForFeature(b, f, out profileParametric));
                        }
                        List<IFeature> guides = CurveFeatures(b, f.ContainsKey("guides") ? f["guides"] : null, "guides");
                        Sweeps sweeps = new Sweeps(_host, _doc);
                        string mode = string.Equals(kind, "loftedCut", StringComparison.OrdinalIgnoreCase)
                            ? "cut" : Json.Str(f, "mode", "boss");
                        IFeature feat = sweeps.Loft(sections, mode, guides,
                            Json.Bool(f, "closed", false), Json.Bool(f, "keepTangency", false),
                            Json.Bool(f, "thin", false),
                            f.ContainsKey("thickness") ? Resolve(f["thickness"]) : 0,
                            f.ContainsKey("thickness2") ? Resolve(f["thickness2"]) : 0,
                            Json.Str(f, "thinType", "oneDirection"),
                            Json.Bool(f, "merge", true),
                            Json.Bool(f, "advancedSmoothing", true),
                            Json.Int(f, "startMatch", 0), Json.Int(f, "endMatch", 0),
                            Json.Dbl(f, "tessTolerance", 1));
                        foreach (string note in sweeps.Steps) _notes.Add(note);
                        Rename(feat, id);
                        _sketches[id] = feat;
                        built.Add(Json.Dict(
                            "id", id, "kind", kind,
                            "featureName", feat == null ? null : feat.Name,
                            "type", feat == null ? null : feat.GetTypeName2(),
                            "parametric", false,
                            "mode", mode,
                            "sections", sections.Count));
                        break;
                    }
                    case "slot":
                    {
                        _notes.Add("slot feature is registered as a capability but is not wired into the compiler yet");
                        throw new BridgeError("CAPABILITY_PENDING",
                            "the \"slot\" feature kind is declared in the capability registry but has no "
                            + "adapter yet; use \"holes\" with a slot-shaped centre list or omit it");
                    }
                    default:
                        // 未知 kind 曾经在这里无声跳过：整个 features 数组照建不误，回包 ok，
                        // 少掉的那一步只体现在体积上。蜗杆的 helix/sweep 就因此"建成"了一个
                        // 光圆柱（6031.86 mm³ = π·8²·30，一个齿都没切）。未知就报错。
                        throw new BridgeError("UNSUPPORTED_FEATURE_KIND",
                            "feature kind \"" + kind + "\" is not implemented by this bridge; it was "
                            + "rejected instead of being skipped, because a skipped feature still "
                            + "reports ok and only shows up as missing material.",
                            Json.Dict("featureId", id, "kind", kind, "featureIndex", index));
                }
            }
        }

        /// <summary>Creates, closes and records a sketch from a profile spec, then
        /// binds whatever dimensions it managed to create. Inline <c>relations</c>
        /// and <c>dimensions</c> are applied by the same Builder.ApplyPlanDetails the
        /// sketch-only build uses, while the sketch is still in edit mode.</summary>
        IFeature SketchFromSpec(Builder builder, Dictionary<string, object> spec, string id,
            out bool parametric)
        {
            parametric = true;
            if (spec == null)
                throw new BridgeError("BAD_ARGUMENT", "feature \"" + id + "\" needs a profile");
            // An empty profile makes an empty sketch, and an extrusion of an empty
            // sketch returns null — the build then "succeeds" with no geometry at
            // all. Refuse it here, where the wrong key is still visible.
            object primitives = spec.ContainsKey("primitives") ? spec["primitives"] : null;
            int primitiveCount = 0;
            foreach (object ignored in Json.Items(primitives)) primitiveCount++;
            int curveCount = 0;
            foreach (object ignored in Json.Items(spec.ContainsKey("curves") ? spec["curves"] : null)) curveCount++;
            string topKind = Json.Str(spec, "kind", null);
            bool singleCurve = !string.IsNullOrEmpty(topKind) && Contracts.IsCurveKind(topKind);
            if (primitiveCount == 0 && curveCount == 0 && !singleCurve)
            {
                List<string> keys = new List<string>();
                foreach (string key in spec.Keys) keys.Add(key);
                throw new BridgeError("EMPTY_SKETCH",
                    "sketch \"" + id + "\" has no primitives or curves, so nothing would be drawn; "
                    + "put shapes in \"primitives\" (legacy sugar) or curves (" + string.Join(", ", Contracts.CurveKinds) + ")",
                    Json.Dict("featureId", id, "keysFound", keys));
            }

            ISketchManager sk = (ISketchManager)_doc.SketchManager;
            // Curve capture has to wrap Create: the ids that inline relations and
            // dimensions address ("h1:center") only exist on the CurveResult objects
            // Curves.CreateOne produced, and Profiles.Create does not return them.
            Curves.BeginCapture();
            ProfileResult pr;
            List<CurveResult> captured;
            try
            {
                pr = Profiles.Create(_host, _doc, sk, spec, Resolve);
            }
            finally
            {
                captured = Curves.EndCapture();
            }

            string axis = Json.Str(spec, "axis", null);
            if (!string.IsNullOrEmpty(axis))
            {
                double span = Json.Dbl(spec, "axisSpan", 500);
                Profiles.AddCenterline(sk, axis, span);
            }

            Dictionary<string, CurveResult> byId =
                new Dictionary<string, CurveResult>(StringComparer.OrdinalIgnoreCase);
            foreach (CurveResult cr in captured)
                if (!string.IsNullOrEmpty(cr.Id)) byId[cr.Id] = cr;

            // profiles 上的 relations/dimensions 以前被整段丢弃：build 报 ok，尺寸一条
            // 没落地。现在必须在 Profiles.Close 之前应用 —— 草图关了再 AddDimension2
            // 只会得到参考尺寸（IsReferenceDim=true），改它模型不动。
            int relationCount = new List<object>(Json.Items(
                spec.ContainsKey("relations") ? spec["relations"] : null)).Count;
            int dimensionCount = new List<object>(Json.Items(
                spec.ContainsKey("dimensions") ? spec["dimensions"] : null)).Count;
            Builder.PlanDetails details = null;
            if (relationCount > 0 || dimensionCount > 0)
            {
                ISketch openSketch = pr.SketchFeature == null ? null
                    : pr.SketchFeature.GetSpecificFeature2() as ISketch;
                try
                {
                    details = builder.ApplyPlanDetails(pr.SketchFeature, openSketch, spec, byId, id,
                        pr.Notes);
                }
                catch (BridgeError)
                {
                    builder.RollbackSketch(pr.SketchFeature, pr.Notes);
                    throw;
                }
                catch (Exception ex)
                {
                    builder.RollbackSketch(pr.SketchFeature, pr.Notes);
                    throw new BridgeError("SKETCH_DETAILS_FAILED",
                        "sketch \"" + id + "\" could not be completed and was rolled back: " + ex.Message,
                        Json.Dict("sketch", id, "notes", pr.Notes, "inner", ex.GetType().Name));
                }
            }

            Profiles.Close(_doc, sk, pr);
            // 绑定必须发生在改名之前：方程式引用的是「尺寸@草图@文档」这个全名，
            // 先改名再 Add2 会得到 rc=-1（实测四种写法全失败，格式本身没错）。
            // 改名之后由 BuildFeatures 末尾的 RepairEquationReferences 把引用改写到新名字。
            //
            // 同一条尺寸可能从两处到达（Profiles.Create 的曲线绑定与内联 dimensions
            // 的 name），所以按尺寸全名去重，一条只绑一次。
            HashSet<string> bound = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (KeyValuePair<string, IDisplayDimension> kv in pr.Bindings)
                BindDisplayOnce(bound, kv.Key, kv.Value);
            if (details != null)
            {
                foreach (KeyValuePair<string, IDisplayDimension> kv in details.Named)
                {
                    if (!_params.ContainsKey(kv.Key))
                    {
                        _notes.Add("dimension \"" + kv.Key + "\" is named but is not a declared "
                            + "parameter; it stays a literal dimension and will not follow an edit");
                        continue;
                    }
                    BindDisplayOnce(bound, kv.Key, kv.Value);
                }
            }

            // Name the sketch after its design id, so the feature tree reads like the
            // design instead of 草图7, and so inspect action=sketch sketch=<id> finds it.
            Rename(pr.SketchFeature, id);
            foreach (string note in pr.Notes) _notes.Add(id + ": " + note);
            parametric = pr.Parametric;
            if (pr.SketchFeature != null)
            {
                _sketches[id] = pr.SketchFeature;
                int plane = Json.Int(spec, "plane", -1);
                if (plane >= 0) _sketchPlanes[pr.SketchFeature.Name] = plane;
            }
            return pr.SketchFeature;
        }

        /// <summary>Binds one display dimension to a parameter at most once.
        ///
        /// A dimension can arrive from two places (a curve's own bind and an inline
        /// plan dimension with the same name); binding the same native dimension twice
        /// writes two equations for it, and the second Add2 can be rejected and then
        /// look like "this parameter is not bound".</summary>
        void BindDisplayOnce(HashSet<string> bound, string paramName, IDisplayDimension display)
        {
            if (display == null)
            {
                _notes.Add("bind " + paramName + ": no native dimension was created for this profile");
                return;
            }
            IDimension dim = null;
            try { dim = (IDimension)display.GetDimension2(0); }
            catch (COMException) { }
            if (dim == null)
            {
                _notes.Add("bind " + paramName + ": display dimension had no underlying dimension");
                return;
            }
            string fullName = null;
            try { fullName = dim.FullName; }
            catch (COMException) { }
            if (!string.IsNullOrEmpty(fullName) && !bound.Add(fullName))
            {
                _notes.Add("bind " + paramName + ": dimension " + fullName
                    + " is already bound once; skipped the duplicate");
                return;
            }
            BindDimension(dim, paramName);
        }

        /// <summary>Resolves the sketch an extrude/cut/revolve works on: either a
        /// sketch recorded earlier in this build, or an inline profile spec.</summary>
        IFeature SketchForFeature(Builder b, Dictionary<string, object> f, out bool parametric)
        {
            parametric = true;
            if (!f.ContainsKey("profile") || f["profile"] == null)
                throw new BridgeError("BAD_ARGUMENT",
                    "this feature needs \"profile\" (a sketch id or a profile spec)");

            string asId = f["profile"] as string;
            if (asId != null)
            {
                IFeature existing;
                if (!_sketches.TryGetValue(asId, out existing) || existing == null)
                    throw new BridgeError("SKETCH_NOT_FOUND",
                        "no sketch with id \"" + asId + "\" was built before this feature");
                return existing;
            }

            Dictionary<string, object> spec = Json.Obj(f["profile"]);
            if (spec == null)
                throw new BridgeError("BAD_ARGUMENT",
                    "\"profile\" must be a sketch id or a profile object");
            return SketchFromSpec(b, spec, Json.Str(f, "id", "inline"), out parametric);
        }

        /// <summary>解析「曲线引用」：螺旋线/扫掠/放样记在 _curves，草图记在 _sketches。
        /// 传对象则当成内联 profile 现场建一张草图（路径也可以是一条草图曲线）。
        /// 找不到就报错并说清楚「它必须出现在 features 更前面」—— 静默返回 null 会让
        /// 后面的扫掠失败在一句与原因无关的话上。</summary>
        IFeature CurveFeature(Builder b, object raw, string what)
        {
            if (raw == null) return null;
            string id = raw as string;
            if (id != null)
            {
                IFeature feature;
                if (_curves.TryGetValue(id, out feature) && feature != null) return feature;
                if (_sketches.TryGetValue(id, out feature) && feature != null) return feature;
                throw new BridgeError("CURVE_NOT_FOUND",
                    what + " \"" + id + "\" is not a sketch or curve built before this feature; "
                    + "the sketch/helix/loft it refers to has to appear earlier in \"features\"");
            }
            Dictionary<string, object> spec = Json.Obj(raw);
            if (spec == null)
                throw new BridgeError("BAD_ARGUMENT", what + " must be a feature id or a profile object");
            bool parametric;
            return SketchFromSpec(b, spec, what, out parametric);
        }

        List<IFeature> CurveFeatures(Builder b, object raw, string what)
        {
            List<IFeature> list = new List<IFeature>();
            string single = raw as string;
            if (single != null)
            {
                IFeature one = CurveFeature(b, single, what);
                if (one != null) list.Add(one);
                return list;
            }
            foreach (object item in Json.Items(raw))
            {
                IFeature feature = CurveFeature(b, item, what);
                if (feature != null) list.Add(feature);
            }
            return list;
        }

        /// <summary>Reads f.bind.depth / f.bind.angle so a feature parameter can be
        /// named inline instead of through a second map.</summary>
        static string BindNameOf(Dictionary<string, object> f, string key)
        {
            Dictionary<string, object> bind = Json.Obj(f.ContainsKey("bind") ? f["bind"] : null);
            return bind == null ? null : Json.Str(bind, key, null);
        }

        static List<object> BindNames(Dictionary<string, object> spec)
        {
            List<object> names = new List<object>();
            List<object> primitives = new List<object>(Json.Items(
                spec.ContainsKey("primitives") ? spec["primitives"] : null));
            foreach (object raw in primitives)
            {
                Dictionary<string, object> p = Json.Obj(raw);
                Dictionary<string, object> bind = p == null ? null
                    : Json.Obj(p.ContainsKey("bind") ? p["bind"] : null);
                if (bind == null) continue;
                foreach (KeyValuePair<string, object> kv in bind)
                    names.Add(Json.Dict("primitive", Json.Str(p, "shape", "?"), "key", kv.Key,
                        "param", Convert.ToString(kv.Value)));
            }
            return names;
        }


        /// <summary>The world direction a plane's "depth" actually goes.
        ///
        /// Measured on this build with a 2×3 sketch rectangle extruded 4 mm and the
        /// resulting body's box read back: plane 0 (front) goes −Z, plane 1 (top) goes
        /// −Y, plane 2 (right) goes −X. Every plane extrudes against its own normal,
        /// which is exactly the surprise that put earlier parts on their side.</summary>
        static string DirectionAxis(int plane)
        {
            switch (plane)
            {
                case 0: return "-Z";
                case 1: return "-Y";
                case 2: return "-X";
                default: return null;
            }
        }

        /// <summary>Turns "extrude towards +Y" into the boolean SOLIDWORKS wants, or
        /// explains why that direction is impossible for this sketch plane.
        ///
        /// A sketch can only extrude along its normal, so a direction on another axis
        /// is a design error worth naming rather than a flag worth flipping.</summary>
        static string ResolveDirection(string wanted, string actualAxis, out bool flip)
        {
            flip = false;
            if (actualAxis == null)
                return "direction needs a sketch built on a reference plane; "
                    + "this profile has no plane ordinal recorded";
            string dir = wanted.Trim().ToUpperInvariant();
            if (dir == actualAxis) { flip = false; return null; }
            string opposite = (actualAxis[0] == '-' ? "+" : "-") + actualAxis[1];
            if (dir == opposite) { flip = true; return null; }
            return "direction " + wanted + " is not along this plane's normal (" + actualAxis
                + "); a sketch can only extrude along ±" + actualAxis[1]
                + ". Put this feature on a plane whose normal matches.";
        }

        /// <summary>How many solid bodies the part has right now.
        ///
        /// The number a caller never asks for and always needs: two bodies means one
        /// feature went the wrong way out of its sketch plane, and everything that
        /// follows is built on a part that only looks finished.</summary>
        int BodyCount()
        {
            try
            {
                IPartDoc part = _doc as IPartDoc;
                if (part == null) return 0;
                object[] bodies = (object[])part.GetBodies2(
                    (int)SolidWorks.Interop.swconst.swBodyType_e.swSolidBody, false);
                return bodies == null ? 0 : bodies.Length;
            }
            catch (COMException) { return 0; }
        }

        /// <summary>Renames a freshly built feature to its design id. Missing names make
        /// the tree unreadable (凸台-拉伸7) and make the sketch-level inspector unable
        /// to find anything the design talks about.</summary>
        void Rename(IFeature feat, string id)
        {
            if (feat == null || string.IsNullOrEmpty(id)) return;
            try
            {
                if (feat.Name == id) return;
                feat.Name = id;
                _renamed = true;
            }
            catch (Exception ex)
            {
                _notes.Add(id + ": kept its default name (" + ex.Message + ")");
            }
        }

        Dictionary<string, object> Describe(IFeature feat, string kind, string id, Builder b)
        {
            Rename(feat, id);
            return Json.Dict(
                "id", id,
                "kind", kind,
                "featureName", feat == null ? null : feat.Name,
                "type", feat == null ? null : feat.GetTypeName2());
        }

        void Bind(string paramName, IFeature feature, string dimName)
        {
            Bind(paramName, feature, dimName, null);
        }

        /// <summary>Binds a named feature parameter. When an expression is supplied it
        /// replaces the plain variable reference, which is required whenever the
        /// SOLIDWORKS dimension is not the semantic value itself.</summary>
        /// <summary>Binds <paramref name="paramName"/> to the first of
        /// <paramref name="dimName"/> that the feature actually has. Returns false when
        /// none of them exist, so the caller can say so instead of pretending.</summary>
        bool BindIfPresent(string paramName, IFeature feature, string dimName)
        {
            if (feature == null || !_params.ContainsKey(paramName)) return false;
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
            BindDimension(dim, paramName);
            return true;
        }

        void Bind(string paramName, IFeature feature, string dimName, string righthand)
        {
            if (feature == null || !_params.ContainsKey(paramName)) return;
            IDimension dim;
            try
            {
                dim = (IDimension)feature.Parameter(dimName);
            }
            catch (COMException)
            {
                return;
            }
            if (dim == null) return;
            if (righthand != null) BindDimensionToExpression(dim, paramName, righthand);
            else BindDimension(dim, paramName);
        }

        /// <summary>Binds a display dimension to a global variable, so a later hand
        /// edit inside SOLIDWORKS keeps the same relation instead of silently
        /// detaching from the JSON.</summary>
        /// <summary>Adds native symmetry and offset dimensions to a corner hole group,
        /// then binds the offsets to the derived variables hole_x and hole_y. Without
        /// this, changing the plate width leaves the holes where they were drawn.</summary>
        /// <summary>Publishes the plate size and edge distance to the builder before
        /// the hole sketch opens, so the sketch can add its own symmetry relations
        /// and offset dimensions while it is still active.</summary>
        void PrepareHolePosition(Dictionary<string, object> f, Builder b)
        {
            if (!f.ContainsKey("pattern")) return;
            Dictionary<string, object> pattern = Json.Obj(f["pattern"]);
            if (pattern == null || Json.Str(pattern, "kind", "corners") != "corners") return;

            string wParam = Json.Str(pattern, "width", "plate.w");
            string hParam = Json.Str(pattern, "height", "plate.h");
            string eParam = Json.Str(pattern, "edge", "hole.edge");
            try
            {
                b.SetHolePosition(Expr.Eval(wParam, _params), Expr.Eval(hParam, _params),
                    Expr.Eval(eParam, _params));
            }
            catch (BridgeError be)
            {
                _notes.Add("hole positioning skipped: " + be.Message);
            }
        }

        void PositionHoleGroup(Dictionary<string, object> f, Builder b)
        {
            Dictionary<string, object> pattern = Json.Obj(f.ContainsKey("pattern") ? f["pattern"] : null);
            string kind = pattern == null ? null : Json.Str(pattern, "kind", "corners");

            // 两孔组：唯一定义尺寸是两圆心中心距。4 孔的“半距偏置”表达不了它，
            // 以前这里没有这个分支，于是两孔 build 出来的 hole.pitch 参数永远没绑定。
            if (kind == "pair")
            {
                string pitchParam = Json.Str(pattern, "pitch", "hole.pitch");
                if (b.HolePairDimension == null)
                    throw new BridgeError("HOLE_GROUP_UNSUPPORTED",
                        "the pair hole group produced no centre-distance dimension to bind \""
                        + pitchParam + "\"", Json.Dict("pitch", pitchParam));
                if (!_params.ContainsKey(pitchParam))
                {
                    _notes.Add("hole pair: no parameter \"" + pitchParam
                        + "\" is declared; the centre distance stays a literal dimension");
                    return;
                }
                BindDisplay(pitchParam, b.HolePairDimension);
                return;
            }

            if (kind == null)
            {
                // 没有 pattern 但正好两个孔：中心距同样应绑到已声明的 hole.pitch。
                List<double[]> centres = Centres(f);
                if (centres.Count == 2 && b.HolePairDimension != null
                    && _params.ContainsKey("hole.pitch"))
                {
                    BindDisplay("hole.pitch", b.HolePairDimension);
                    return;
                }
                _notes.Add("hole group has no pattern and " + centres.Count
                    + " centres; no positioning dimension was bound");
                return;
            }
            if (kind != "corners") return;

            string wParam = Json.Str(pattern, "width", "plate.w");
            string eParam = Json.Str(pattern, "edge", "hole.edge");
            List<IDisplayDimension> dims = b.HoleOffsetDimensions;
            if (dims == null || dims.Count == 0)
            {
                _notes.Add("hole group has no offset dimensions; it will not follow a plate resize");
                return;
            }
            string xExpr = "\"" + GlobalName(wParam) + "\"/2 - \"" + GlobalName(eParam) + "\"";
            BindDisplayToExpression("hole.x", dims[0], xExpr);
            if (dims.Count >= 2)
            {
                string hParam = Json.Str(pattern, "height", "plate.h");
                string yExpr = "\"" + GlobalName(hParam) + "\"/2 - \"" + GlobalName(eParam) + "\"";
                BindDisplayToExpression("hole.y", dims[1], yExpr);
            }
        }

        /// <summary>Binds a display dimension directly to a SOLIDWORKS expression.</summary>
        void BindDisplayToExpression(string paramName, IDisplayDimension display, string righthand)
        {
            if (display == null) return;
            IDimension dim = null;
            try
            {
                dim = (IDimension)display.GetDimension2(0);
            }
            catch (COMException) { }
            if (dim == null)
            {
                _notes.Add("bind " + paramName + ": display dimension had no underlying dimension");
                return;
            }
            BindDimensionToExpression(dim, paramName, righthand);
        }

        void BindDisplay(string paramName, IDisplayDimension display)
        {
            if (display == null)
            {
                _notes.Add("bind " + paramName + ": no native dimension was created for this profile");
                return;
            }
            IDimension dim = null;
            try
            {
                dim = (IDimension)display.GetDimension2(0);
            }
            catch (COMException) { }
            if (dim == null)
            {
                _notes.Add("bind " + paramName + ": display dimension had no underlying dimension");
                return;
            }
            BindDimension(dim, paramName);
        }

        /// <summary>Every circle in the sketch is bound to the same semantic
        /// parameter. sgEQUAL does not propagate a change, so the fan-out happens
        /// here: one parameter, N native diameter dimensions.</summary>
        void BindCircles(List<IDisplayDimension> displays, string paramName)
        {
            if (displays == null || displays.Count == 0)
            {
                _notes.Add("bind " + paramName + ": no circular diameter dimensions were created");
                return;
            }
            int bound = 0;
            foreach (IDisplayDimension d in displays) if (BindDisplayQuiet(d, paramName)) bound++;
            if (bound == 0)
                _notes.Add("bind " + paramName + ": " + displays.Count + " circles, none bound");
        }

        bool BindDisplayQuiet(IDisplayDimension display, string paramName)
        {
            if (display == null) return false;
            IDimension dim = null;
            try
            {
                dim = (IDimension)display.GetDimension2(0);
            }
            catch (COMException)
            {
                return false;
            }
            return dim != null && BindDimension(dim, paramName);
        }

        static IDisplayDimension First(List<IDisplayDimension> list, int index)
        {
            if (list == null || index >= list.Count) return null;
            return list[index];
        }

        /// <summary>Horizontal planar faces, ordered so "top" and "bottom" mean what
        /// a person means. Resolved lazily on each call because undo invalidates
        /// previously captured face pointers.</summary>
        IFace2 PickPlanarFace(string faceKind)
        {
            double sign = faceKind == "bottom" ? -1 : 1;
            IFace2 picked = Builder.TopPlanarFace(_doc, sign);
            if (picked == null)
                throw new BridgeError("NO_FACE",
                    "no horizontal planar face with normal sign " + sign + " was found");
            return picked;
        }

        List<double[]> Centres(Dictionary<string, object> f)
        {
            List<double[]> list = new List<double[]>();
            ArrayList raw = f.ContainsKey("centres") ? Json.Arr(f["centres"]) : null;
            if (raw == null && f.ContainsKey("pattern"))
                raw = PatternCentres(Json.Obj(f["pattern"]));
            if (raw == null)
                throw new BridgeError("BAD_FEATURE", "holes feature needs \"centres\" or \"pattern\"");

            foreach (object o in raw)
            {
                Dictionary<string, object> c = Json.Obj(o);
                if (c == null) continue;
                list.Add(new double[] { Resolve(c["x"]), Resolve(c["y"]) });
            }
            if (list.Count == 0)
                throw new BridgeError("BAD_FEATURE", "holes feature produced zero centres");
            return list;
        }

        /// <summary>Declarative corner-hole pattern. Derived from the plate size and
        /// the edge distance, so it follows a width or height change without the
        /// model having to restate coordinates.</summary>
        ArrayList PatternCentres(Dictionary<string, object> pattern)
        {
            ArrayList result = new ArrayList();
            string kind = Json.Str(pattern, "kind", "corners");
            // 两孔沿一条轴的等距布置：pitch / axis / centre。旧字段含义不变，
            // 只是多了一个 pattern.kind —— centres 的旧路径仍然优先使用。
            if (kind == "pair")
            {
                double pitch = Expr.Eval(Json.Str(pattern, "pitch", "hole.pitch"), _params);
                if (pitch <= 0)
                    throw new BridgeError("BAD_FEATURE",
                        "hole pair pitch must be positive, got " + pitch);
                string axis = (Json.Str(pattern, "axis", "x") ?? "x").ToLowerInvariant();
                Dictionary<string, object> at = Json.Obj(
                    pattern.ContainsKey("centre") ? pattern["centre"] : null);
                double cx = at == null ? 0 : Resolve(at.ContainsKey("x") ? at["x"] : 0);
                double cy = at == null ? 0 : Resolve(at.ContainsKey("y") ? at["y"] : 0);
                double half = pitch / 2.0;
                if (axis == "y")
                {
                    result.Add(Json.Dict("x", Json.Num(cx), "y", Json.Num(cy - half)));
                    result.Add(Json.Dict("x", Json.Num(cx), "y", Json.Num(cy + half)));
                }
                else if (axis == "x")
                {
                    result.Add(Json.Dict("x", Json.Num(cx - half), "y", Json.Num(cy)));
                    result.Add(Json.Dict("x", Json.Num(cx + half), "y", Json.Num(cy)));
                }
                else
                    throw new BridgeError("BAD_FEATURE",
                        "hole pair axis must be \"x\" or \"y\"; got \"" + axis + "\"",
                        Json.Dict("axis", axis));
                return result;
            }
            if (kind != "corners")
                throw new BridgeError("BAD_FEATURE", "unsupported hole pattern kind \"" + kind + "\"");

            string wParam = Json.Str(pattern, "width", "plate.w");
            string hParam = Json.Str(pattern, "height", "plate.h");
            string eParam = Json.Str(pattern, "edge", "hole.edge");
            double w = Expr.Eval(wParam, _params);
            double h = Expr.Eval(hParam, _params);
            double e = Expr.Eval(eParam, _params);
            double x = w / 2.0 - e;
            double y = h / 2.0 - e;
            if (x <= 0 || y <= 0)
                throw new BridgeError("BAD_FEATURE",
                    "edge distance " + e + " does not fit a " + w + " x " + h + " plate");

            // Mirror the derivation as native SOLIDWORKS variables so the offset
            // keeps following a hand edit made after this bridge exits.
            AddDerivedVariable("hole.x", "\"" + wParam + "\"/2 - \"" + eParam + "\"");
            AddDerivedVariable("hole.y", "\"" + hParam + "\"/2 - \"" + eParam + "\"");

            double[][] pts = new double[][] {
                new double[] { -x, -y }, new double[] { x, -y },
                new double[] { x, y }, new double[] { -x, y } };
            foreach (double[] p in pts)
                result.Add(Json.Dict("x", Json.Num(p[0]), "y", Json.Num(p[1])));
            return result;
        }
    }
}
