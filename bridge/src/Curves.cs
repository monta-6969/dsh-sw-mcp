using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>One curve in the v4 protocol, already resolved to millimetres.</summary>
    sealed class CurveResult
    {
        public string Id;
        public string Kind;
        public Dictionary<string, object> Spec;
        public List<ISketchSegment> Segments = new List<ISketchSegment>();
        /// <summary>Sketch points this curve owns: one for a "point" curve, the
        /// centre/endpoints for the curve kinds that can be referred to as points.
        /// Relations address them as <c>curveId:start|end|center</c>.</summary>
        public List<ISketchPoint> Points = new List<ISketchPoint>();
        public Dictionary<string, IDisplayDimension> Bindings = new Dictionary<string, IDisplayDimension>();
        public Dictionary<string, object> Readback;
        public bool Parametric = true;
        public double ToleranceMm = 0.005;
        public List<string> Notes = new List<string>();
    }

    /// <summary>Creates the eight native curve kinds and reads the real geometry back.
    ///
    /// The point of this class is that "a circle" is only a circle if SOLIDWORKS says
    /// so. Every creation is followed by a readback of the actual segment type and
    /// parameters; a spline that merely looks round is reported as a spline, with the
    /// maximum deviation, instead of being passed off as a circle.</summary>
    static class Curves
    {
        const double Mm = 0.001;
        const double Eps = 1e-9;

        // ---------------------------------------------------------------- create

        public static CurveResult CreateOne(IModelDoc2 doc, ISketchManager sk,
            Dictionary<string, object> spec, Func<object, double> resolve, int index)
        {
            if (spec == null) throw new BridgeError("BAD_ARGUMENT", "curve #" + index + " is not an object");
            string kind = Json.Str(spec, "kind", null);
            if (string.IsNullOrEmpty(kind))
                throw new BridgeError("BAD_ARGUMENT",
                    "curve #" + index + " needs \"kind\" (" + string.Join(", ", Contracts.CurveKinds) + ")");
            // "point" is not in contracts curveKinds yet — a construction point is
            // not a curve in the profile sense, but the same spec list carries it,
            // and relations need it as an entity ("the arc centre is this point").
            bool isPointKind = string.Equals(kind, "point", StringComparison.OrdinalIgnoreCase)
                || string.Equals(kind, "constructionPoint", StringComparison.OrdinalIgnoreCase);
            if (!isPointKind && !Contracts.IsCurveKind(kind))
                throw new BridgeError("CURVE_UNSUPPORTED",
                    "curve #" + index + " has unknown kind \"" + kind + "\"",
                    Json.Dict("known", Contracts.CurveKinds, "extra", Json.List("point")));

            // 几何参数按契约放在 curve.params 里（contracts/schema/curve.schema.json、
            // contracts.mjs 的 Curve、samples/curves/*.json 都是这个形状）；早期探针把
            // start/end/radius 直接写在曲线顶层。两种写法都认：只认顶层时，一份在 Node
            // 侧 plan 里合格的定义到了这里只报一句 "curve point start needs [x,y]"，
            // 而且 plan 与桥接器各读一半键名，谁也发现不了对方不认。
            Dictionary<string, object> p = spec;
            Dictionary<string, object> nestedParams =
                Json.Obj(spec.ContainsKey("params") ? spec["params"] : null);
            if (nestedParams != null && nestedParams.Count > 0)
            {
                p = new Dictionary<string, object>();
                foreach (KeyValuePair<string, object> kv in spec) p[kv.Key] = kv.Value;
                foreach (KeyValuePair<string, object> kv in nestedParams) p[kv.Key] = kv.Value;
            }

            CurveResult result = new CurveResult();
            result.Kind = kind;
            result.Spec = spec;
            result.Id = Json.Str(p, "id", null);
            result.ToleranceMm = Json.Dbl(p, "toleranceMm", 0.005);
            bool construction = Json.Bool(p, "construction", false);

            // Every curve is written to the database so it can be selected for the
            // dimensions and relations that follow. Legacy sugar controls this itself.
            sk.AddToDB = true;
            if (isPointKind)
            {
                CreatePoint(sk, p, resolve, result);
            }
            else
            switch (kind)
            {
                case "line": CreateLine(sk, p, resolve, result); break;
                case "circle": CreateCircle(sk, p, resolve, result); break;
                case "arc": CreateArc(sk, p, resolve, result); break;
                case "ellipse": CreateEllipse(sk, p, resolve, result); break;
                case "ellipticArc": CreateEllipticArc(sk, p, resolve, result); break;
                case "spline": CreateSpline(sk, p, resolve, result); break;
                case "equationCurve": CreateEquationCurve(sk, p, resolve, result); break;
                case "polyline": CreatePolyline(sk, p, resolve, result); break;
                default:
                    throw new BridgeError("CURVE_UNSUPPORTED", "curve kind \"" + kind + "\" is not implemented");
            }

            foreach (ISketchSegment seg in result.Segments)
            {
                try { seg.ConstructionGeometry = construction; }
                catch (COMException) { }
            }
            // ISketchPoint exposes no ConstructionGeometry in the interop surface,
            // so a construction point is construction by role: it exists only to be
            // referenced by a relation. Say so instead of pretending it was flagged.
            if (construction && result.Points.Count > 0 && result.Segments.Count == 0)
                result.Notes.Add("point at curve \"" + (result.Id ?? "?")
                    + "\" is a construction point: sketch points have no construction flag in the API");
            if (result.Segments.Count > 0)
                result.Readback = Readback(result.Segments[result.Segments.Count - 1]);
            else if (result.Points.Count > 0)
                result.Readback = PointReadback(result.Points[result.Points.Count - 1]);
            else
                result.Readback = Json.Dict("kind", kind, "created", false);
            // Builder.BuildSketch captures what CreateOne actually drew, so an
            // inline relation can name a curveId and get the real COM entity.
            if (_capture != null) _capture.Add(result);
            return result;
        }

        static void CreatePoint(ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, CurveResult r)
        {
            double[] at = null;
            if (p.ContainsKey("at")) at = Point(p, "at", resolve);
            else if (p.ContainsKey("center")) at = Point(p, "center", resolve);
            else if (p.ContainsKey("x") || p.ContainsKey("y"))
                at = new double[] { resolve(p.ContainsKey("x") ? p["x"] : 0), resolve(p.ContainsKey("y") ? p["y"] : 0) };
            else if (p.ContainsKey("point")) at = Point(p, "point", resolve);
            else if (p.ContainsKey("start")) at = Point(p, "start", resolve);
            if (at == null)
                throw new BridgeError("BAD_ARGUMENT",
                    "point curve #" + (r.Id ?? "?") + " needs at:[x,y] (or x/y)");

            ISketchPoint pt = null;
            try { pt = sk.CreatePoint(M(at[0]), M(at[1]), 0); }
            catch (COMException) { }
            if (pt == null)
            {
                r.Parametric = false;
                r.Notes.Add("point at (" + at[0] + ", " + at[1] + ") was not created");
                return;
            }
            r.Points.Add(pt);
        }

        // ------------------------------------------------------------ curve capture

        /// <summary>Non-null while a Builder sketch is being created; CreateOne
        /// appends every CurveResult it produced. This is how inline relations name
        /// a curveId without Profiles.cs having to change its signature.</summary>
        [ThreadStatic] static List<CurveResult> _capture;

        public static void BeginCapture()
        {
            _capture = new List<CurveResult>();
        }

        public static List<CurveResult> EndCapture()
        {
            List<CurveResult> captured = _capture;
            _capture = null;
            return captured ?? new List<CurveResult>();
        }

        /// <summary>v4 readback for a construction point: same "at" shape as a
        /// line start so callers do not need a second parser.</summary>
        public static Dictionary<string, object> PointReadback(ISketchPoint pt)
        {
            Dictionary<string, object> rec = Json.Dict();
            if (pt == null) return Json.Dict("kind", "point", "type", "point", "unreadable", true);
            Dictionary<string, object> at = XY(pt);
            rec["kind"] = "point";
            rec["type"] = "point";
            rec["construction"] = false;
            rec["at"] = Json.List(at["x"], at["y"]);
            rec["start"] = at;
            rec["end"] = at;
            rec["params"] = Json.Dict("at", Json.List(at["x"], at["y"]));
            return rec;
        }

        static void CreateLine(ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, CurveResult r)
        {
            double[] a = Point(p, "start", resolve);
            double[] b = Point(p, "end", resolve);
            ISketchSegment seg = sk.CreateLine(M(a[0]), M(a[1]), 0, M(b[0]), M(b[1]), 0);
            AddSegment(r, seg, "line");
        }

        static void CreateCircle(ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, CurveResult r)
        {
            double[] c = Point(p, "center", resolve);
            double radius = p.ContainsKey("radius") && p["radius"] != null
                ? resolve(p["radius"])
                : resolve(p.ContainsKey("diameter") ? p["diameter"] : 0) / 2.0;
            if (radius <= 0)
                throw new BridgeError("BAD_ARGUMENT", "circle needs a positive radius or diameter");
            ISketchSegment seg = sk.CreateCircle(M(c[0]), M(c[1]), 0, M(c[0] + radius), M(c[1]), 0);
            AddSegment(r, seg, "circle");
            if (seg == null) r.Parametric = false;
        }

        static void CreateArc(ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, CurveResult r)
        {
            double[] c = Point(p, "center", resolve);
            double radius = resolve(p.ContainsKey("radius") ? p["radius"] : 0);
            if (radius <= 0) throw new BridgeError("BAD_ARGUMENT", "arc needs a positive radius");
            double start = FirstAngle(p, "startAngle", "startAngleRad", resolve, 0);
            double end = FirstAngle(p, "endAngle", "endAngleRad", resolve, 90);
            int dir = Json.Int(p, "direction", 1) < 0 ? -1 : 1;
            // 齿形等轮廓要求端点与相邻样条/直线完全重合：允许显式给
            // start/end 点（同一 round6 坐标），否则按角度落在圆上。
            double[] a = p.ContainsKey("start") ? Point(p, "start", resolve) : OnCircle(c, radius, start);
            double[] b = p.ContainsKey("end") ? Point(p, "end", resolve) : OnCircle(c, radius, end);
            ISketchSegment seg = sk.CreateArc(M(c[0]), M(c[1]), 0,
                M(a[0]), M(a[1]), 0, M(b[0]), M(b[1]), 0, (short)dir);
            AddSegment(r, seg, "arc");
        }

        static void CreateEllipse(ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, CurveResult r)
        {
            double[] c = Point(p, "center", resolve);
            double major = resolve(p.ContainsKey("major") ? p["major"] : 0);
            double minor = resolve(p.ContainsKey("minor") ? p["minor"] : 0);
            double rot = Json.Dbl(p, "rotation", 0);
            if (major <= 0 || minor <= 0)
                throw new BridgeError("BAD_ARGUMENT", "ellipse needs positive major and minor semi-axes");
            double[] mp = OnEllipse(c, major, minor, rot, 0);
            double[] np = OnEllipse(c, major, minor, rot, 90);
            ISketchSegment seg = sk.CreateEllipse(M(c[0]), M(c[1]), 0,
                M(mp[0]), M(mp[1]), 0, M(np[0]), M(np[1]), 0);
            AddSegment(r, seg, "ellipse");
        }

        static void CreateEllipticArc(ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, CurveResult r)
        {
            double[] c = Point(p, "center", resolve);
            double major = resolve(p.ContainsKey("major") ? p["major"] : 0);
            double minor = resolve(p.ContainsKey("minor") ? p["minor"] : 0);
            double rot = Json.Dbl(p, "rotation", 0);
            double start = Json.Dbl(p, "startParam", 0);
            double end = Json.Dbl(p, "endParam", 180);
            int dir = Json.Int(p, "direction", 1) < 0 ? -1 : 1;
            double[] mp = OnEllipse(c, major, minor, rot, 0);
            double[] np = OnEllipse(c, major, minor, rot, 90);
            double[] a = OnEllipse(c, major, minor, rot, start);
            double[] b = OnEllipse(c, major, minor, rot, end);
            ISketchSegment seg = sk.CreateEllipticalArc(M(c[0]), M(c[1]), 0,
                M(mp[0]), M(mp[1]), 0, M(np[0]), M(np[1]), 0,
                M(a[0]), M(a[1]), 0, M(b[0]), M(b[1]), 0, (short)dir);
            AddSegment(r, seg, "ellipticArc");
        }

        static void CreateSpline(ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, CurveResult r)
        {
            List<double[]> points = Points(p, "points", resolve);
            if (points.Count < 2)
                throw new BridgeError("BAD_ARGUMENT", "spline needs at least two points");
            bool closed = Json.Bool(p, "closed", false);
            if (closed && !SamePoint(points[0], points[points.Count - 1])) points.Add(points[0]);
            double[] flat = new double[points.Count * 3];
            for (int i = 0; i < points.Count; i++)
            {
                flat[i * 3] = M(points[i][0]);
                flat[i * 3 + 1] = M(points[i][1]);
                flat[i * 3 + 2] = 0;
            }
            ISketchSegment seg = null;
            try { seg = sk.CreateSpline2(flat, false); }
            catch (COMException) { }
            AddSegment(r, seg, "spline");
            if (seg == null) r.Parametric = false;
        }

        /// <summary>The live COM object returned by CreateEquationSpline2 is an
        /// ISketchSpline, not an ISketchSegment, so ask the open sketch for the
        /// segment it just added. AddToDB is true here, which is what makes the
        /// pending segment visible.</summary>
        static ISketchSegment LastSegment(ISketchManager sk)
        {
            try
            {
                Sketch active = sk.ActiveSketch;
                if (active == null) return null;
                object[] raw = active.GetSketchSegments() as object[];
                if (raw == null || raw.Length == 0) return null;
                return raw[raw.Length - 1] as ISketchSegment;
            }
            catch (COMException) { return null; }
        }

        static int SegmentCount(ISketchManager sk)
        {
            try
            {
                Sketch active = sk.ActiveSketch;
                if (active == null) return 0;
                object[] raw = active.GetSketchSegments() as object[];
                return raw == null ? 0 : raw.Length;
            }
            catch (COMException) { return 0; }
        }

        static void CreateEquationCurve(ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, CurveResult r)
        {
            Dictionary<string, object> variable = Json.Obj(p.ContainsKey("variable") ? p["variable"] : null);
            string varName = variable == null ? "t" : Json.Str(variable, "name", "t");
            double from = variable == null ? 0 : resolve(variable.ContainsKey("from") ? variable["from"] : 0);
            double to = variable == null ? 1 : resolve(variable.ContainsKey("to") ? variable["to"] : 1);
            string x = Json.Str(p, "x", "t");
            string y = Json.Str(p, "y", "0");

            if (!string.Equals(varName, "t", StringComparison.OrdinalIgnoreCase))
                r.Notes.Add("equation curve variable \"" + varName + "\" is written with SOLIDWORKS' \"t\"");

            ISketchSegment seg = null;
            try
            {
                // A 2D equation curve takes an empty Z expression; "0" makes the
                // call return null on this build (measured 2026-11-10, SW 2026 SP3.2).
                // A refusal returns null but leaves the previous segment as the
                // sketch's last one; taking that blindly reported the previous curve
                // as this one (measured: a closed equation circle swallowed Q1).
                int before = SegmentCount(sk);
                object created = sk.CreateEquationSpline2(x, y, "",
                    from.ToString("R", CultureInfo.InvariantCulture),
                    to.ToString("R", CultureInfo.InvariantCulture),
                    false, 0, 0, 0, true, true);
                // A closed range returns an object on this build but adds no segment;
                // accepting the object made the missing curve look created.
                if (SegmentCount(sk) > before)
                {
                    seg = created as ISketchSegment;
                    if (seg == null) seg = LastSegment(sk);
                }
                else if (created != null)
                {
                    r.Notes.Add("native equation curve returned an object but added no sketch segment");
                }
            }
            catch (COMException ex)
            {
                r.Notes.Add("equation curve COM exception: " + ex.Message);
            }

            if (seg != null)
            {
                AddSegment(r, seg, "equationCurve");
                return;
            }

            // Native equation curve refused: sample it and create an explicit spline.
            // The caller is told this is a fallback, so a later edit will not silently
            // move the wrong geometry.
            int samples = Math.Max(8, Math.Min(2048, Json.Int(p, "samples", 128)));
            double[] flat = new double[(samples + 1) * 3];
            for (int i = 0; i <= samples; i++)
            {
                double t = from + (to - from) * i / samples;
                flat[i * 3] = M(CurveExpr.Eval(x, t, varName));
                flat[i * 3 + 1] = M(CurveExpr.Eval(y, t, varName));
                flat[i * 3 + 2] = 0;
            }
            ISketchSegment fallback = null;
            try { fallback = sk.CreateSpline2(flat, false); }
            catch (COMException) { }
            AddSegment(r, fallback, "equationCurve");
            if (fallback == null)
                r.Notes.Add("sampled fallback spline was refused too (coincident endpoints?)");
            r.Parametric = false;
            bool closed = Math.Abs(flat[0] - flat[samples * 3]) < Eps
                && Math.Abs(flat[1] - flat[samples * 3 + 1]) < Eps;
            r.Notes.Add("native equation curve returned null"
                + (closed ? " (a closed range with start==end is not accepted by this build)" : "")
                + "; sampled " + samples + " points into a spline (fallback)");
        }

        static void CreatePolyline(ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, CurveResult r)
        {
            List<double[]> points = Points(p, "points", resolve);
            if (points.Count < 2)
                throw new BridgeError("BAD_ARGUMENT", "polyline needs at least two points");
            bool closed = Json.Bool(p, "closed", false);
            if (closed && !SamePoint(points[0], points[points.Count - 1])) points.Add(points[0]);
            for (int i = 0; i + 1 < points.Count; i++)
            {
                ISketchSegment seg = sk.CreateLine(
                    M(points[i][0]), M(points[i][1]), 0,
                    M(points[i + 1][0]), M(points[i + 1][1]), 0);
                if (seg == null)
                {
                    r.Parametric = false;
                    r.Notes.Add("polyline segment " + i + " was not created");
                    continue;
                }
                r.Segments.Add(seg);
            }
            r.Readback = Json.Dict(
                "kind", "polyline",
                "count", r.Segments.Count,
                "points", PointList(points),
                "closed", closed);
        }

        static void AddSegment(CurveResult r, ISketchSegment seg, string kind)
        {
            if (seg == null)
            {
                r.Parametric = false;
                r.Notes.Add(kind + " was not created");
                return;
            }
            r.Segments.Add(seg);
        }

        // ------------------------------------------------------- dimensions / relations

        public static void ApplyDimensions(IModelDoc2 doc, CurveResult r)
        {
            List<object> dims = new List<object>(Json.Items(
                r.Spec != null && r.Spec.ContainsKey("dimensions") ? r.Spec["dimensions"] : null));
            if (dims.Count == 0 || r.Segments.Count == 0) return;
            ISketchSegment seg = r.Segments[0];
            foreach (object raw in dims)
            {
                Dictionary<string, object> d = Json.Obj(raw);
                if (d == null) continue;
                string name = Json.Str(d, "name", null);
                string type = Json.Str(d, "type", "");
                if (string.IsNullOrEmpty(name))
                {
                    r.Notes.Add("dimension on " + r.Kind + " has no name; cannot bind it");
                    r.Parametric = false;
                    continue;
                }
                if (!string.Equals(type, "diameter", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(type, "radius", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(type, "distance", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(type, "angle", StringComparison.OrdinalIgnoreCase))
                {
                    r.Notes.Add("dimension " + name + " type \"" + type
                        + "\" has no native binding yet");
                    r.Parametric = false;
                    continue;
                }

                doc.ClearSelection2(true);
                bool selected = false;
                try { selected = seg.Select2(false, 0); }
                catch (COMException) { }
                if (!selected)
                {
                    r.Notes.Add("dimension " + name + ": segment could not be selected");
                    r.Parametric = false;
                    continue;
                }

                IDisplayDimension display = null;
                try
                {
                    if (string.Equals(type, "diameter", StringComparison.OrdinalIgnoreCase))
                    {
                        double[] c = SegmentCentreMm(seg);
                        display = doc.AddDiameterDimension2(M(c[0] + 10), M(c[1] + 10), 0) as IDisplayDimension;
                    }
                    else
                    {
                        double[] place = DimensionPlacementMm(seg);
                        display = doc.AddDimension2(M(place[0]), M(place[1]), 0) as IDisplayDimension;
                    }
                }
                catch (COMException) { }
                if (display == null)
                {
                    r.Notes.Add("dimension " + name + ": SOLIDWORKS returned no dimension for " + type);
                    r.Parametric = false;
                    continue;
                }
                r.Bindings[name] = display;
            }
        }

        public static void ApplyConstraints(IModelDoc2 doc, List<CurveResult> curves)
        {
            if (curves == null || curves.Count == 0) return;
            Dictionary<string, CurveResult> byId = new Dictionary<string, CurveResult>();
            foreach (CurveResult c in curves)
                if (!string.IsNullOrEmpty(c.Id)) byId[c.Id] = c;

            foreach (CurveResult c in curves)
            {
                List<object> list = new List<object>(Json.Items(
                    c.Spec != null && c.Spec.ContainsKey("constraints") ? c.Spec["constraints"] : null));
                foreach (object raw in list)
                {
                    Dictionary<string, object> con = Json.Obj(raw);
                    if (con == null) continue;
                    string type = Json.Str(con, "type", "");
                    string code = RelationCode(type);
                    if (code == null)
                    {
                        c.Notes.Add("constraint \"" + type + "\" has no native relation code");
                        continue;
                    }
                    List<ISketchSegment> selected = new List<ISketchSegment>();
                    foreach (object refObj in Json.Items(con.ContainsKey("refs") ? con["refs"] : null))
                    {
                        string refId = refObj as string;
                        CurveResult other;
                        if (refId != null && byId.TryGetValue(refId, out other) && other.Segments.Count > 0)
                            selected.Add(other.Segments[0]);
                    }
                    if (selected.Count == 0) selected.AddRange(c.Segments);
                    if (selected.Count == 0) continue;

                    doc.ClearSelection2(true);
                    bool first = true;
                    foreach (ISketchSegment seg in selected)
                    {
                        try { seg.Select2(!first, 0); }
                        catch (COMException) { }
                        first = false;
                    }
                    try
                    {
                        doc.SketchAddConstraints(code);
                    }
                    catch (COMException)
                    {
                        c.Notes.Add("constraint " + type + " threw a COM exception");
                        c.Parametric = false;
                    }
                }
            }
        }

        static string RelationCode(string type)
        {
            switch (type)
            {
                case "horizontal": return "sgHORIZONTAL2D";
                case "vertical": return "sgVERTICAL2D";
                case "coincident": return "sgCOINCIDENT";
                case "tangent": return "sgTANGENT";
                case "equal": return "sgEQUAL";
                case "concentric": return "sgCONCENTRIC";
                case "symmetric": return "sgSYMMETRIC";
                case "parallel": return "sgPARALLEL";
                case "perpendicular": return "sgPERPENDICULAR";
                case "fix": return "sgFIXED";
                case "midpoint": return "sgMIDPOINT";
                default: return null;
            }
        }

        // ------------------------------------------------------------------ readback

        /// <summary>Read one segment as the v4 curve shape, including the legacy
        /// "type" field so older callers keep working.</summary>
        public static Dictionary<string, object> Readback(ISketchSegment seg)
        {
            Dictionary<string, object> rec = Json.Dict();
            if (seg == null) return Json.Dict("kind", "other", "type", "other", "unreadable", true);
            bool construction = false;
            try { construction = seg.ConstructionGeometry; }
            catch (COMException) { }
            rec["construction"] = construction;

            try
            {
                int code = seg.GetType();
                if (code == (int)swSketchSegments_e.swSketchLINE)
                {
                    ISketchLine line = (ISketchLine)seg;
                    ISketchPoint a = (ISketchPoint)line.GetStartPoint2();
                    ISketchPoint b = (ISketchPoint)line.GetEndPoint2();
                    Dictionary<string, object> start = XY(a);
                    Dictionary<string, object> end = XY(b);
                    rec["type"] = "line";
                    rec["kind"] = "line";
                    rec["start"] = start;
                    rec["end"] = end;
                    rec["params"] = Json.Dict("start", start, "end", end);
                    rec["length"] = Json.R(seg.GetLength() * 1000);
                }
                else if (code == (int)swSketchSegments_e.swSketchARC)
                {
                    ISketchArc arc = (ISketchArc)seg;
                    ISketchPoint a = (ISketchPoint)arc.GetStartPoint2();
                    ISketchPoint b = (ISketchPoint)arc.GetEndPoint2();
                    ISketchPoint c = arc.GetCenterPoint2() as ISketchPoint;
                    double[] centre = c == null ? new double[] { 0, 0 } : new double[] { c.X * 1000, c.Y * 1000 };
                    double radius = arc.GetRadius() * 1000;
                    bool circle = a != null && b != null
                        && Math.Abs(a.X - b.X) < Eps && Math.Abs(a.Y - b.Y) < Eps;
                    double startAngle = a == null ? 0 : AngleDeg(centre, new double[] { a.X * 1000, a.Y * 1000 });
                    double endAngle = b == null ? 0 : AngleDeg(centre, new double[] { b.X * 1000, b.Y * 1000 });
                    int dir = 1;
                    try { dir = arc.GetRotationDir() < 0 ? -1 : 1; }
                    catch (COMException) { }
                    rec["type"] = circle ? "circle" : "arc";
                    rec["kind"] = circle ? "circle" : "arc";
                    rec["center"] = Json.List(Json.R(centre[0]), Json.R(centre[1]));
                    rec["radius"] = Json.R(radius);
                    if (circle)
                    {
                        rec["params"] = Json.Dict(
                            "center", Json.List(Json.R(centre[0]), Json.R(centre[1])),
                            "radius", Json.R(radius),
                            "diameter", Json.R(radius * 2));
                    }
                    else
                    {
                        rec["start"] = XY(a);
                        rec["end"] = XY(b);
                        rec["params"] = Json.Dict(
                            "center", Json.List(Json.R(centre[0]), Json.R(centre[1])),
                            "radius", Json.R(radius),
                            "startAngle", Json.R(startAngle),
                            "endAngle", Json.R(endAngle),
                            "direction", dir);
                    }
                }
                else if (code == (int)swSketchSegments_e.swSketchELLIPSE)
                {
                    ISketchEllipse ell = (ISketchEllipse)seg;
                    ISketchPoint c = ell.GetCenterPoint2() as ISketchPoint;
                    ISketchPoint maj = ell.GetMajorPoint2() as ISketchPoint;
                    ISketchPoint min = ell.GetMinorPoint2() as ISketchPoint;
                    ISketchPoint a = ell.GetStartPoint2() as ISketchPoint;
                    ISketchPoint b = ell.GetEndPoint2() as ISketchPoint;
                    double[] centre = c == null ? new double[] { 0, 0 } : new double[] { c.X * 1000, c.Y * 1000 };
                    double major = maj == null ? 0 : Distance(centre, new double[] { maj.X * 1000, maj.Y * 1000 });
                    double minor = min == null ? 0 : Distance(centre, new double[] { min.X * 1000, min.Y * 1000 });
                    double rotation = maj == null ? 0 : AngleDeg(centre, new double[] { maj.X * 1000, maj.Y * 1000 });
                    bool full = a != null && b != null
                        && Math.Abs(a.X - b.X) < Eps && Math.Abs(a.Y - b.Y) < Eps;
                    rec["type"] = full ? "ellipse" : "ellipticArc";
                    rec["kind"] = full ? "ellipse" : "ellipticArc";
                    rec["center"] = Json.List(Json.R(centre[0]), Json.R(centre[1]));
                    rec["params"] = Json.Dict(
                        "center", Json.List(Json.R(centre[0]), Json.R(centre[1])),
                        "major", Json.R(major),
                        "minor", Json.R(minor),
                        "rotation", Json.R(rotation));
                    if (!full)
                    {
                        double startParam = a == null ? 0 : AngleDeg(centre, new double[] { a.X * 1000, a.Y * 1000 }) - rotation;
                        double endParam = b == null ? 0 : AngleDeg(centre, new double[] { b.X * 1000, b.Y * 1000 }) - rotation;
                        rec["params"] = Json.Dict(
                            "center", Json.List(Json.R(centre[0]), Json.R(centre[1])),
                            "major", Json.R(major),
                            "minor", Json.R(minor),
                            "rotation", Json.R(rotation),
                            "startParam", Json.R(Normalize(startParam)),
                            "endParam", Json.R(Normalize(endParam)));
                    }
                }
                else if (code == (int)swSketchSegments_e.swSketchSPLINE)
                {
                    ISketchSpline spline = (ISketchSpline)seg;
                    List<double[]> pts = SplinePoints(spline);
                    string xExpr = null, yExpr = null, zExpr = null;
                    double rangeStart = 0, rangeEnd = 0, rotation = 0, xOffset = 0, yOffset = 0;
                    bool angleRange = false, lockStart = false, lockEnd = false;
                    bool eqn = false;
                    try
                    {
                        eqn = spline.GetEquationParameters2(out xExpr, out yExpr, out zExpr,
                            out rangeStart, out rangeEnd, out angleRange, out rotation,
                            out xOffset, out yOffset, out lockStart, out lockEnd);
                    }
                    catch (COMException) { }
                    if (eqn && (!string.IsNullOrEmpty(xExpr) || !string.IsNullOrEmpty(yExpr)))
                    {
                        rec["type"] = "equationCurve";
                        rec["kind"] = "equationCurve";
                        rec["params"] = Json.Dict(
                            "variable", Json.Dict("name", "t", "from", Json.R(rangeStart), "to", Json.R(rangeEnd)),
                            "x", xExpr ?? "",
                            "y", yExpr ?? "",
                            "samples", pts.Count);
                        rec["points"] = PointList(pts);
                    }
                    else
                    {
                        rec["type"] = "spline";
                        rec["kind"] = "spline";
                        rec["params"] = Json.Dict(
                            "points", PointList(pts),
                            "degree", spline.CurveDegree,
                            "closed", pts.Count > 2 && SamePoint(pts[0], pts[pts.Count - 1]));
                    }
                    rec["length"] = Json.R(seg.GetLength() * 1000);
                }
                else
                {
                    rec["type"] = "other";
                    rec["kind"] = "other";
                    rec["kindCode"] = code;
                }
            }
            catch (COMException)
            {
                rec["type"] = "unreadable";
                rec["kind"] = "unreadable";
            }
            return rec;
        }

        static List<double[]> SplinePoints(ISketchSpline spline)
        {
            List<double[]> list = new List<double[]>();
            object raw = null;
            try { raw = spline.GetPoints2(); }
            catch (COMException) { }
            Array arr = raw as Array;
            if (arr == null) return list;
            int n = arr.Length;
            // GetPoints2 returns SketchPoint COM objects; older interop builds return
            // a flat [x,y,z,...] double array. Read whichever actually arrived.
            for (int i = 0; i < n; i++)
            {
                ISketchPoint pt = arr.GetValue(i) as ISketchPoint;
                if (pt == null) continue;
                list.Add(new double[] { pt.X * 1000, pt.Y * 1000 });
            }
            if (list.Count > 0) return list;
            for (int i = 0; i + 2 < n; i += 3)
            {
                double x = Convert.ToDouble(arr.GetValue(i), CultureInfo.InvariantCulture) * 1000;
                double y = Convert.ToDouble(arr.GetValue(i + 1), CultureInfo.InvariantCulture) * 1000;
                list.Add(new double[] { x, y });
            }
            return list;
        }

        // ------------------------------------------------------------------ geometry

        static double[] Point(Dictionary<string, object> p, string key, Func<object, double> resolve)
        {
            object raw = p.ContainsKey(key) ? p[key] : null;
            List<object> items = new List<object>(Json.Items(raw));
            if (items.Count >= 2) return new double[] { resolve(items[0]), resolve(items[1]) };
            throw new BridgeError("BAD_ARGUMENT", "curve point \"" + key + "\" needs [x,y]");
        }

        static List<double[]> Points(Dictionary<string, object> p, string key, Func<object, double> resolve)
        {
            List<double[]> list = new List<double[]>();
            foreach (object raw in Json.Items(p.ContainsKey(key) ? p[key] : null))
            {
                List<object> items = new List<object>(Json.Items(raw));
                if (items.Count >= 2) list.Add(new double[] { resolve(items[0]), resolve(items[1]) });
            }
            return list;
        }

        static double FirstAngle(Dictionary<string, object> p, string degreesKey, string radiansKey,
            Func<object, double> resolve, double fallback)
        {
            if (p.ContainsKey(radiansKey) && p[radiansKey] != null)
                return resolve(p[radiansKey]) * 180.0 / Math.PI;
            if (p.ContainsKey(degreesKey) && p[degreesKey] != null)
                return resolve(p[degreesKey]);
            return fallback;
        }

        static double[] OnCircle(double[] c, double radius, double angleDeg)
        {
            double a = angleDeg * Math.PI / 180.0;
            return new double[] { c[0] + radius * Math.Cos(a), c[1] + radius * Math.Sin(a) };
        }

        static double[] OnEllipse(double[] c, double major, double minor, double rotationDeg, double paramDeg)
        {
            double rot = rotationDeg * Math.PI / 180.0;
            double t = paramDeg * Math.PI / 180.0;
            double x = major * Math.Cos(t);
            double y = minor * Math.Sin(t);
            return new double[]
            {
                c[0] + x * Math.Cos(rot) - y * Math.Sin(rot),
                c[1] + x * Math.Sin(rot) + y * Math.Cos(rot)
            };
        }

        static double RadiusOf(ISketchSegment seg)
        {
            try
            {
                if (seg is ISketchArc) return ((ISketchArc)seg).GetRadius() * 1000;
            }
            catch (COMException) { }
            return 0;
        }

        static double[] SegmentCentreMm(ISketchSegment seg)
        {
            try
            {
                ISketchArc arc = seg as ISketchArc;
                if (arc != null)
                {
                    ISketchPoint c = arc.GetCenterPoint2() as ISketchPoint;
                    if (c != null) return new double[] { c.X * 1000, c.Y * 1000 };
                }
                ISketchEllipse ell = seg as ISketchEllipse;
                if (ell != null)
                {
                    ISketchPoint c = ell.GetCenterPoint2() as ISketchPoint;
                    if (c != null) return new double[] { c.X * 1000, c.Y * 1000 };
                }
            }
            catch (COMException) { }
            return new double[] { 0, 0 };
        }

        static double[] DimensionPlacementMm(ISketchSegment seg)
        {
            try
            {
                if (seg is ISketchLine)
                {
                    ISketchLine line = (ISketchLine)seg;
                    ISketchPoint a = (ISketchPoint)line.GetStartPoint2();
                    ISketchPoint b = (ISketchPoint)line.GetEndPoint2();
                    return new double[] { (a.X + b.X) * 500, (a.Y + b.Y) * 500 + 10 };
                }
                double[] c = SegmentCentreMm(seg);
                double r = RadiusOf(seg);
                return new double[] { c[0] + r + 10, c[1] + r + 10 };
            }
            catch (COMException) { }
            return new double[] { 10, 10 };
        }

        static Dictionary<string, object> XY(ISketchPoint p)
        {
            if (p == null) return Json.Dict("x", 0, "y", 0);
            return Json.Dict("x", Json.R(p.X * 1000), "y", Json.R(p.Y * 1000));
        }

        static double Distance(double[] a, double[] b)
        {
            double dx = a[0] - b[0], dy = a[1] - b[1];
            return Math.Sqrt(dx * dx + dy * dy);
        }

        static double AngleDeg(double[] centre, double[] p)
        {
            double a = Math.Atan2(p[1] - centre[1], p[0] - centre[0]) * 180.0 / Math.PI;
            return Normalize(a);
        }

        static double Normalize(double degrees)
        {
            double d = degrees % 360.0;
            if (d < 0) d += 360.0;
            return d;
        }

        static double M(double mm) { return mm * Mm; }

        static List<object> PointList(List<double[]> points)
        {
            List<object> list = new List<object>();
            foreach (double[] p in points)
                list.Add(Json.List(Json.R(p[0]), Json.R(p[1])));
            return list;
        }

        static bool SamePoint(double[] a, double[] b)
        {
            return Math.Abs(a[0] - b[0]) < 1e-6 && Math.Abs(a[1] - b[1]) < 1e-6;
        }
    }

    /// <summary>Small evaluator for equation-curve expressions: numbers, t, pi,
    /// + - * / ^, parentheses and the usual unary functions. Deliberately not a
    /// general language: it only ever evaluates geometry, never code.</summary>
    sealed class CurveExpr
    {
        readonly string _src;
        readonly double _t;
        readonly string _var;
        int _pos;

        CurveExpr(string src, double t, string varName)
        {
            _src = src ?? "0";
            _t = t;
            _var = varName ?? "t";
            _pos = 0;
        }

        public static double Eval(string src, double t, string varName)
        {
            CurveExpr e = new CurveExpr(src, t, varName);
            double value = e.Sum();
            e.Skip();
            if (e._pos < e._src.Length)
                throw new BridgeError("BAD_EXPRESSION",
                    "unexpected \"" + e._src.Substring(e._pos) + "\" in equation \"" + src + "\"");
            return value;
        }

        double Sum()
        {
            double v = Term();
            while (true)
            {
                Skip();
                if (Take('+')) v += Term();
                else if (Take('-')) v -= Term();
                else return v;
            }
        }

        double Term()
        {
            double v = Power();
            while (true)
            {
                Skip();
                if (Take('*')) v *= Power();
                else if (Take('/')) v /= Power();
                else return v;
            }
        }

        double Power()
        {
            double v = Unary();
            Skip();
            if (Take('^')) return Math.Pow(v, Power());
            return v;
        }

        double Unary()
        {
            Skip();
            if (Take('+')) return Unary();
            if (Take('-')) return -Unary();
            return Primary();
        }

        double Primary()
        {
            Skip();
            if (Take('('))
            {
                double v = Sum();
                Expect(')');
                return v;
            }
            if (_pos < _src.Length && (char.IsDigit(_src[_pos]) || _src[_pos] == '.')) return Number();
            if (_pos < _src.Length && (char.IsLetter(_src[_pos]) || _src[_pos] == '_')) return Name();
            throw new BridgeError("BAD_EXPRESSION", "unexpected end of equation \"" + _src + "\"");
        }

        double Number()
        {
            int start = _pos;
            while (_pos < _src.Length && (char.IsDigit(_src[_pos]) || _src[_pos] == '.')) _pos++;
            if (_pos < _src.Length && (_src[_pos] == 'e' || _src[_pos] == 'E'))
            {
                _pos++;
                if (_pos < _src.Length && (_src[_pos] == '+' || _src[_pos] == '-')) _pos++;
                while (_pos < _src.Length && char.IsDigit(_src[_pos])) _pos++;
            }
            double value;
            if (!double.TryParse(_src.Substring(start, _pos - start),
                NumberStyles.Float, CultureInfo.InvariantCulture, out value))
                throw new BridgeError("BAD_EXPRESSION", "bad number in \"" + _src + "\"");
            return value;
        }

        double Name()
        {
            int start = _pos;
            while (_pos < _src.Length && (char.IsLetterOrDigit(_src[_pos]) || _src[_pos] == '_')) _pos++;
            string name = _src.Substring(start, _pos - start);
            Skip();
            if (Take('('))
            {
                List<double> args = new List<double>();
                Skip();
                if (!Take(')'))
                {
                    args.Add(Sum());
                    while (Take(',')) args.Add(Sum());
                    Expect(')');
                }
                return Call(name, args);
            }
            if (string.Equals(name, _var, StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, "t", StringComparison.OrdinalIgnoreCase)) return _t;
            if (string.Equals(name, "pi", StringComparison.OrdinalIgnoreCase)) return Math.PI;
            if (string.Equals(name, "e", StringComparison.OrdinalIgnoreCase)) return Math.E;
            throw new BridgeError("BAD_EXPRESSION", "unknown name \"" + name + "\" in equation \"" + _src + "\"");
        }

        double Call(string name, List<double> args)
        {
            string fn = name.ToLowerInvariant();
            if (fn == "atan2" && args.Count == 2) return Math.Atan2(args[0], args[1]);
            if (fn == "pow" && args.Count == 2) return Math.Pow(args[0], args[1]);
            if (fn == "min" && args.Count == 2) return Math.Min(args[0], args[1]);
            if (fn == "max" && args.Count == 2) return Math.Max(args[0], args[1]);
            if (args.Count != 1)
                throw new BridgeError("BAD_EXPRESSION", "function \"" + name + "\" takes one argument");
            double a = args[0];
            switch (fn)
            {
                case "sin": return Math.Sin(a);
                case "cos": return Math.Cos(a);
                case "tan": return Math.Tan(a);
                case "asin": return Math.Asin(a);
                case "acos": return Math.Acos(a);
                case "atan": return Math.Atan(a);
                case "sqrt": return Math.Sqrt(a);
                case "abs": return Math.Abs(a);
                case "exp": return Math.Exp(a);
                case "log": return Math.Log(a);
                case "floor": return Math.Floor(a);
                case "ceil": return Math.Ceiling(a);
                default:
                    throw new BridgeError("BAD_EXPRESSION", "unknown function \"" + name + "\"");
            }
        }

        void Expect(char c)
        {
            Skip();
            if (!Take(c))
                throw new BridgeError("BAD_EXPRESSION", "expected '" + c + "' in \"" + _src + "\"");
        }

        bool Take(char c)
        {
            Skip();
            if (_pos < _src.Length && _src[_pos] == c) { _pos++; return true; }
            return false;
        }

        void Skip()
        {
            while (_pos < _src.Length && char.IsWhiteSpace(_src[_pos])) _pos++;
        }
    }
}
