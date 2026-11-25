using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Builds an arbitrary closed profile from a declarative spec.
    ///
    /// The first version of the compiler could only make the four shapes it knew
    /// how to bind: a centred plate, a boss, a hole group, a fillet. That is a
    /// parts catalogue, not a modelling tool. This class turns "a sketch with
    /// these primitives on this plane" into geometry, and says plainly which of
    /// those primitives ended up bound to a native SOLIDWORKS dimension — a
    /// profile that cannot be driven by a parameter is still useful, but the
    /// caller has to know that it will not follow an edit.</summary>
    sealed class ProfileResult
    {
        public IFeature SketchFeature;
        public Dictionary<string, IDisplayDimension> Bindings =
            new Dictionary<string, IDisplayDimension>();
        public List<string> Notes = new List<string>();
        /// <summary>False when at least one primitive was drawn without a native
        /// dimension behind it, so a parameter change would not move it.</summary>
        public bool Parametric = true;
        /// <summary>Readback of every v4 curve created by this profile. The legacy
        /// primitives do not appear here; they are read through GeometryOf.</summary>
        public List<Dictionary<string, object>> CurveReadbacks = new List<Dictionary<string, object>>();
    }

    static class Profiles
    {
        sealed class PendingCircle
        {
            public double Diameter;
            public double[] Centre;
            public string BindName;
        }

        /// <summary>Creates the sketch that <paramref name="spec"/> describes and
        /// leaves it open; the caller closes it after adding its own geometry
        /// (a revolve centreline, for instance).</summary>
        public static ProfileResult Create(SwHost host, IModelDoc2 doc, ISketchManager sk,
            Dictionary<string, object> spec, Func<object, double> resolve)
        {
            ProfileResult result = new ProfileResult();
            if (spec == null) throw new BridgeError("BAD_ARGUMENT", "profile spec is missing");

            SelectPlane(doc, spec, resolve, result);

            // AddToDB stays false so SOLIDWORKS applies its own relations:
            // the dimensioner needs them, and an extrusion does not require a
            // fully constrained sketch.
            sk.AddToDB = false;
            sk.InsertSketch(true);

            List<object> primitives = new List<object>(Json.Items(
                spec.ContainsKey("primitives") ? spec["primitives"] : null));
            if (primitives.Count == 0)
                result.Notes.Add("profile has no primitives");

            List<PendingCircle> circles = new List<PendingCircle>();
            List<CurveResult> curveResults = new List<CurveResult>();
            int index = 0;
            foreach (object raw in primitives)
            {
                index++;
                Dictionary<string, object> p = Json.Obj(raw);
                if (p == null) continue;
                string curveKind = Json.Str(p, "kind", null);
                if (!string.IsNullOrEmpty(curveKind) && Contracts.IsCurveKind(curveKind))
                {
                    DrawCurve(doc, sk, p, resolve, result, curveResults, index);
                    continue;
                }
                string shape = Json.Str(p, "shape", "");
                switch (shape)
                {
                    case "rect":
                        AddRect(doc, sk, p, resolve, result);
                        break;
                    case "circle":
                    {
                        double[] c = Point(p, "center", resolve);
                        // radius 是几何直觉里最自然的写法；旧代码只认 diameter，传
                        // radius 会被静默当成 0，画出一个零半径圆，最后把失败报成
                        // "FeatureExtrusion3 returned null"——错误指向拉伸，真正原因
                        // 在草图上，模型只能靠猜。
                        double d = resolve(p.ContainsKey("diameter") ? p["diameter"]
                            : p.ContainsKey("radius") ? resolve(p["radius"]) * 2.0 : 0);
                        if (!(d > 0))
                            throw new BridgeError("BAD_ARGUMENT",
                                "profile primitive #" + index + " (circle) has no usable size: give "
                                + "diameter (mm) or radius (mm); got " + d);
                        sk.AddToDB = true;
                        ISketchSegment seg = sk.CreateCircle(ToM(c[0]), ToM(c[1]), 0,
                            ToM(c[0] + d / 2.0), ToM(c[1]), 0);
                        if (seg == null)
                        {
                            result.Parametric = false;
                            result.Notes.Add("circle #" + index + " was not created");
                            break;
                        }
                        circles.Add(new PendingCircle
                        {
                            Diameter = d,
                            Centre = c,
                            BindName = BindName(p, "diameter", null),
                        });
                        break;
                    }
                    case "polyline":
                    case "polygon":
                        AddPolyline(sk, p, resolve, result, index);
                        break;
                    case "roundedRect":
                        AddRoundedRect(sk, p, resolve, result, index);
                        break;
                    case "path":
                        AddPath(sk, p, resolve, result, index);
                        break;
                    case "slot":
                        AddSlot2D(sk, p, resolve, result, index);
                        break;
                    default:
                        throw new BridgeError("UNKNOWN_PROFILE_SHAPE",
                            "profile primitive \"" + shape + "\" is not supported; "
                            + "use a curve kind (" + string.Join(", ", Contracts.CurveKinds) + "), "
                            + "or a legacy shape (rect, circle, polyline, polygon, roundedRect, path, slot)");
                }
            }

            // v4 profiles may list curves directly, outside "primitives". A single
            // top-level curve object is accepted too, so {"kind":"circle",...} works
            // without wrapping it in a list.
            int curveCount = 0;
            foreach (object raw in Json.Items(spec.ContainsKey("curves") ? spec["curves"] : null))
            {
                curveCount++;
                Dictionary<string, object> p = Json.Obj(raw);
                if (p != null) DrawCurve(doc, sk, p, resolve, result, curveResults, ++index);
            }
            if (primitives.Count == 0 && curveCount == 0)
            {
                string topKind = Json.Str(spec, "kind", null);
                if (!string.IsNullOrEmpty(topKind) && Contracts.IsCurveKind(topKind))
                    DrawCurve(doc, sk, spec, resolve, result, curveResults, ++index);
            }

            if (curveResults.Count > 0)
            {
                Curves.ApplyConstraints(doc, curveResults);
                foreach (CurveResult cr in curveResults)
                {
                    Curves.ApplyDimensions(doc, cr);
                    foreach (KeyValuePair<string, IDisplayDimension> kv in cr.Bindings)
                        if (kv.Value != null) result.Bindings[kv.Key] = kv.Value;
                    foreach (string note in cr.Notes) result.Notes.Add(note);
                    if (!cr.Parametric) result.Parametric = false;
                    if (cr.Readback != null) result.CurveReadbacks.Add(cr.Readback);
                }
            }

            // Circles are dimensioned after the geometry exists, one primitive at a
            // time: each carries its own diameter parameter, and DimensionCircles
            // also adds the symmetry relations that keep a hole group centred.
            if (circles.Count > 0)
            {
                IFeature openSketch = (IFeature)doc.GetActiveSketch();
                ISketch sketch = openSketch == null ? null : (ISketch)openSketch.GetSpecificFeature2();
                if (sketch == null) result.Notes.Add("could not read back the sketch to dimension its circles");
                else
                {
                    foreach (PendingCircle pc in circles)
                    {
                        List<string> diagnostics = new List<string>();
                        List<IDisplayDimension> dims = SketchDimensioner.DimensionCircles(
                            doc, sketch, pc.Diameter,
                            new List<double[]> { pc.Centre }, diagnostics);
                        foreach (string d in diagnostics) result.Notes.Add(d);
                        if (dims == null || dims.Count == 0)
                        {
                            result.Parametric = false;
                            result.Notes.Add("circle at (" + pc.Centre[0] + ", " + pc.Centre[1]
                                + ") got no diameter dimension");
                            continue;
                        }
                        if (pc.BindName == null)
                        {
                            result.Notes.Add("circle at (" + pc.Centre[0] + ", " + pc.Centre[1]
                                + ") has a dimension but no bind name");
                            continue;
                        }
                        result.Bindings[pc.BindName] = dims[0];
                    }
                }
            }

            IFeature feature = (IFeature)doc.GetActiveSketch();
            result.SketchFeature = feature;
            return result;
        }

        /// <summary>Closes the sketch that Create left open. Separate from Create so
        /// a revolve can slip its centreline in while the sketch is still active.</summary>
        public static void Close(IModelDoc2 doc, ISketchManager sk, ProfileResult result)
        {
            // InsertSketch is a toggle. If something already closed the sketch —
            // DimensionCircles does, on some builds — calling it again would open it
            // and leave a half-finished sketch behind, which then refuses to extrude
            // with no error at all. Only close what is still open, and only ours.
            IFeature active = (IFeature)doc.GetActiveSketch();
            bool open = active != null
                && (result.SketchFeature == null || active.Name == result.SketchFeature.Name);
            if (open) sk.InsertSketch(true);
            if (result.SketchFeature == null) result.SketchFeature = active;
        }

        // ---------------------------------------------------------------- plane

        static void SelectPlane(IModelDoc2 doc, Dictionary<string, object> spec,
            Func<object, double> resolve, ProfileResult result)
        {
            doc.ClearSelection2(true);
            string faceKind = Json.Str(spec, "face", null);
            if (!string.IsNullOrEmpty(faceKind))
            {
                IFace2 face = Builder.TopPlanarFace(doc, faceKind == "bottom" ? -1 : 1);
                if (face == null)
                    throw new BridgeError("NO_FACE", "no planar face facing " + faceKind + " to sketch on");
                ((IEntity)face).Select2(false, 0);
                return;
            }

            int plane = Json.Int(spec, "plane", 0);
            IFeature refPlane = SwHost.RefPlane(doc, plane);
            if (refPlane == null)
                throw new BridgeError("NO_REF_PLANE",
                    "reference plane ordinal " + plane + " not found in this template");
            refPlane.Select2(false, 0);

            double offset = Json.Dbl(spec, "offset", 0);
            if (offset == 0) return;
            // An offset plane is a real feature, not a shifted sketch: the design
            // stays readable and a later parameter can drive the distance.
            IFeature offsetPlane = null;
            try
            {
                offsetPlane = (IFeature)doc.FeatureManager.InsertRefPlane(
                    (int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Distance,
                    ToM(offset), 0, 0, 0, 0);
            }
            catch (COMException) { }
            if (offsetPlane == null) result.Notes.Add("offset plane request returned no feature");
            else
            {
                // InsertRefPlane creates the plane but does not leave it selected;
                // without this the sketch opened on the original plane and the offset
                // silently did nothing.
                doc.ClearSelection2(true);
                offsetPlane.Select2(false, 0);
                result.Notes.Add("sketch on offset plane " + offsetPlane.Name + " at " + offset + " mm");
            }
        }

        // ------------------------------------------------------------ primitives

        /// <summary>How many segments the open sketch holds right now. Used to notice
        /// a sketch tool that silently drew nothing.</summary>
        static int SketchSegmentCount(IModelDoc2 doc)
        {
            try
            {
                IFeature openSketch = (IFeature)doc.GetActiveSketch();
                if (openSketch == null) return 0;
                ISketch sketch = openSketch.GetSpecificFeature2() as ISketch;
                if (sketch == null) return 0;
                ArrayList segments = Json.Arr(sketch.GetSketchSegments());
                return segments == null ? 0 : segments.Count;
            }
            catch (COMException) { return 0; }
        }

        static void AddRect(IModelDoc2 doc, ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, ProfileResult result)
        {
            double[] c = Point(p, "center", resolve);
            double w = resolve(p.ContainsKey("width") ? p["width"] : 0);
            double h = resolve(p.ContainsKey("height") ? p["height"] : 0);
            sk.AddToDB = true;

            double x0 = c[0] - w / 2.0, x1 = c[0] + w / 2.0;
            double y0 = c[1] - h / 2.0, y1 = c[1] + h / 2.0;

            // The rectangle tool is preferred when it works: it produces four
            // segments whose corners are genuinely coincident, so a width change
            // moves the right-hand lines instead of leaving them behind. It is not
            // used unconditionally because it silently returns nothing for small
            // rectangles (20 x 2.3 mm failed, 10 x 4 mm worked) — no error, no
            // geometry. When that happens, four plain lines are drawn instead and
            // the note says the corners are coincident only by coordinate.
            // The rectangle tool is preferred when the rectangle is big enough: it
            // produces four segments with genuinely coincident corners, so a width
            // change moves the right-hand lines instead of leaving them behind.
            //
            // It is not used for small rectangles because it silently draws nothing
            // there — measured: 20 x 2.3 mm produced zero segments, while 10 x 4 mm
            // and 8.4 x 5 mm worked. The cut-off below sits above the largest known
            // failure and below the smallest known success. There is no way to detect
            // the failure after the fact: with AddToDB the pending rectangle is
            // invisible to GetSketchSegments until the sketch closes, so a "did the
            // segment count go up" test reads zero for a rectangle that was drawn.
            bool useTool = Math.Min(w, h) >= 3.0;
            if (useTool)
            {
                sk.AddToDB = false;
                sk.CreateCenterRectangle(ToM(c[0]), ToM(c[1]), 0, ToM(x1), ToM(y1), 0);
            }
            else
            {
                sk.AddToDB = true;
                sk.CreateLine(ToM(x0), ToM(y0), 0, ToM(x1), ToM(y0), 0);
                sk.CreateLine(ToM(x1), ToM(y0), 0, ToM(x1), ToM(y1), 0);
                sk.CreateLine(ToM(x1), ToM(y1), 0, ToM(x0), ToM(y1), 0);
                sk.CreateLine(ToM(x0), ToM(y1), 0, ToM(x0), ToM(y0), 0);
                result.Notes.Add("rect " + w.ToString("F2") + " x " + h.ToString("F2")
                    + " is below the size where SOLIDWORKS' rectangle tool draws anything, "
                    + "so the outline is four lines: the corners meet by coordinate, not by "
                    + "a coincident relation");
            }

            IFeature openSketch = (IFeature)doc.GetActiveSketch();
            ISketch sketch = openSketch == null ? null : (ISketch)openSketch.GetSpecificFeature2();
            if (sketch == null)
            {
                result.Parametric = false;
                result.Notes.Add("rect could not read back its sketch");
                return;
            }

            List<IDisplayDimension> dims;
            try
            {
                dims = SketchDimensioner.Rectify(doc, sketch, sk, w, h,
                    Math.Abs(c[0]) < 1e-6 && Math.Abs(c[1]) < 1e-6);
            }
            catch (BridgeError ex)
            {
                // Losing the dimensions costs the parametric link; losing the whole
                // feature would cost the model. Say which happened and keep going.
                result.Parametric = false;
                result.Notes.Add("rect is geometry only: dimensioning failed (" + ex.Code + ": "
                    + ex.Message + ")");
                return;
            }
            if (dims == null || dims.Count < 2)
            {
                result.Parametric = false;
                result.Notes.Add("rect could not get width/height dimensions; it will not follow a parameter");
                return;
            }

            string wName = BindName(p, "width", null);
            string hName = BindName(p, "height", null);
            if (wName != null) result.Bindings[wName] = dims[0];
            else result.Notes.Add("rect width dimension has no bind name");
            if (hName != null) result.Bindings[hName] = dims[1];
            else result.Notes.Add("rect height dimension has no bind name");
        }

        static void AddPolyline(ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, ProfileResult result, int index)
        {
            sk.AddToDB = true;
            List<double[]> points = new List<double[]>();
            string shape = Json.Str(p, "shape", "polyline");

            if (shape == "polygon")
            {
                int sides = Json.Int(p, "sides", 6);
                double diameter = resolve(p.ContainsKey("diameter") ? p["diameter"] : 0);
                double[] c = Point(p, "center", resolve);
                double rotation = Json.Dbl(p, "rotate", 0) * Math.PI / 180.0;
                double radius = diameter / 2.0;
                for (int i = 0; i < sides; i++)
                {
                    double a = rotation + 2 * Math.PI * i / sides;
                    points.Add(new[] { c[0] + radius * Math.Cos(a), c[1] + radius * Math.Sin(a) });
                }
                result.Parametric = false;
                result.Notes.Add("polygon #" + index + " is geometry only: its vertices carry no "
                    + "dimensions, so a parameter change will not move it");
            }
            else
            {
                List<object> raw = new List<object>(Json.Items(
                    p.ContainsKey("points") ? p["points"] : null));
                foreach (object item in raw)
                {
                    object[] pair = item as object[];
                    if (pair != null && pair.Length >= 2)
                    {
                        points.Add(new[] { resolve(pair[0]), resolve(pair[1]) });
                        continue;
                    }
                    List<object> list = new List<object>(Json.Items(item));
                    if (list.Count >= 2) points.Add(new[] { resolve(list[0]), resolve(list[1]) });
                }
                if (points.Count < 2)
                    throw new BridgeError("BAD_ARGUMENT",
                        "polyline #" + index + " needs at least two points");
                result.Parametric = false;
                result.Notes.Add("polyline #" + index + " is geometry only: the coordinates are "
                    + "evaluated at build time and baked into the sketch");
            }

            bool closed = Json.Bool(p, "closed", true);
            int last = closed ? points.Count : points.Count - 1;
            for (int i = 0; i < last; i++)
            {
                double[] a = points[i];
                double[] b = points[(i + 1) % points.Count];
                sk.CreateLine(ToM(a[0]), ToM(a[1]), 0, ToM(b[0]), ToM(b[1]), 0);
            }
        }

        /// <summary>A rectangle whose corners may be rounded.
        ///
        /// Drawing this as a single CreateCenterRectangle would give a sharp-cornered
        /// profile; a fillet feature afterwards is a different (and harder to undo)
        /// shape. Line-plus-arc segments keep the corner radius in the sketch, which
        /// is where a drawing puts it.</summary>
        static void AddRoundedRect(ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, ProfileResult result, int index)
        {
            double[] c = Point(p, "center", resolve);
            double w = resolve(p.ContainsKey("width") ? p["width"] : 0);
            double h = resolve(p.ContainsKey("height") ? p["height"] : 0);
            double r = resolve(p.ContainsKey("radius") ? p["radius"] : 0);

            // Corner order is counter-clockwise starting bottom-left, so a caller can
            // round only the corners a drawing rounds: 0=BL, 1=BR, 2=TR, 3=TL.
            List<object> rawSkip = new List<object>(Json.Items(
                p.ContainsKey("sharp") ? p["sharp"] : null));
            HashSet<int> sharp = new HashSet<int>();
            foreach (object item in rawSkip) sharp.Add((int)resolve(item));

            double x0 = c[0] - w / 2.0, x1 = c[0] + w / 2.0;
            double y0 = c[1] - h / 2.0, y1 = c[1] + h / 2.0;
            double rMax = Math.Min(w, h) / 2.0;
            if (r > rMax) r = rMax;

            double rBL = sharp.Contains(0) ? 0 : r;
            double rBR = sharp.Contains(1) ? 0 : r;
            double rTR = sharp.Contains(2) ? 0 : r;
            double rTL = sharp.Contains(3) ? 0 : r;

            // Walk the outline counter-clockwise. For each corner the table says where
            // its arc starts, where it ends, and where its centre is; a zero radius
            // collapses arc-start and arc-end onto the corner itself.
            double[] radii = { rBL, rBR, rTR, rTL };
            double cxBL = x0 + rBL, cyBL = y0 + rBL;
            double cxBR = x1 - rBR, cyBR = y0 + rBR;
            double cxTR = x1 - rTR, cyTR = y1 - rTR;
            double cxTL = x0 + rTL, cyTL = y1 - rTL;

            double[] centreX = { cxBL, cxBR, cxTR, cxTL };
            double[] centreY = { cyBL, cyBR, cyTR, cyTL };
            // Arc entry point and exit point, per corner.
            double[] inX = { x0, x1 - rBR, x1, x0 + rTL };
            double[] inY = { y0 + rBL, y0, y1 - rTR, y1 };
            double[] outX = { x0 + rBL, x1, x1 - rTR, x0 };
            double[] outY = { y0, y0 + rBR, y1, y1 - rTL };

            // A sharp corner is just a corner whose arc has zero length: collapse its
            // entry and exit onto the vertex so the loop below needs no special case.
            sk.AddToDB = true;
            double[] vertexX = { x0, x1, x1, x0 };
            double[] vertexY = { y0, y0, y1, y1 };
            for (int i = 0; i < 4; i++)
            {
                if (radii[i] > 0) continue;
                inX[i] = vertexX[i]; inY[i] = vertexY[i];
                outX[i] = vertexX[i]; outY[i] = vertexY[i];
            }

            // SOLIDWORKS takes the turn direction per arc, and a corner arc that
            // sweeps the long way still closes the loop — it just makes a shape that
            // intersects itself, which an extrusion rejects with a bare null. The
            // direction is therefore a parameter, not a constant to guess at.
            short dir = (short)Json.Int(p, "dir", 1);
            double curX = outX[0], curY = outY[0];
            for (int corner = 1; corner <= 4; corner++)
            {
                int i = corner % 4;
                sk.CreateLine(ToM(curX), ToM(curY), 0, ToM(inX[i]), ToM(inY[i]), 0);
                if (radii[i] > 0)
                {
                    sk.CreateArc(ToM(centreX[i]), ToM(centreY[i]), 0,
                        ToM(inX[i]), ToM(inY[i]), 0, ToM(outX[i]), ToM(outY[i]), 0, dir);
                }
                curX = outX[i]; curY = outY[i];
            }

            result.Parametric = false;
            result.Notes.Add("roundedRect #" + index + " is geometry only: the outline is drawn as "
                + "line and arc segments, so no width/height dimension drives it");
        }

        /// <summary>Draws one v4 curve and records it for the readback/dimension pass.
        /// Notes are appended later, after dimensions have run, so a single curve's
        /// diagnostics stay in one place.</summary>
        static void DrawCurve(IModelDoc2 doc, ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, ProfileResult result, List<CurveResult> curveResults, int index)
        {
            CurveResult cr = Curves.CreateOne(doc, sk, p, resolve, index);
            curveResults.Add(cr);
            if (!cr.Parametric) result.Parametric = false;
        }

        /// <summary>An explicit line-and-arc outline.
        ///
        /// This is the escape hatch for silhouettes a rectangle cannot express: an
        /// arch, a keyhole, a cam. Segments are given in drawing order starting from
        /// "start"; each is either {"to":[x,y]} for a line or
        /// {"arc":{"to":[x,y],"center":[cx,cy],"dir":1}} for an arc, where dir=1 turns
        /// counter-clockwise. Geometry only — worth saying out loud, because a caller
        /// who expects a parameter to move this will be surprised.</summary>
        static void AddPath(ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, ProfileResult result, int index)
        {
            sk.AddToDB = true;
            List<object> segments = new List<object>(Json.Items(
                p.ContainsKey("segments") ? p["segments"] : null));
            if (segments.Count == 0)
                throw new BridgeError("BAD_ARGUMENT",
                    "path #" + index + " needs at least one segment in \"segments\"");

            double[] start = Point(p, "start", resolve);
            double cx = start[0], cy = start[1];
            int lines = 0, arcs = 0;

            foreach (object raw in segments)
            {
                Dictionary<string, object> s = Json.Obj(raw);
                if (s == null) continue;
                Dictionary<string, object> arc = Json.Obj(s.ContainsKey("arc") ? s["arc"] : null);
                double[] to;
                ISketchSegment seg;

                if (arc != null)
                {
                    to = Point(arc, "to", resolve);
                    double[] centre = Point(arc, "center", resolve);
                    int dir = Json.Int(arc, "dir", 1);
                    seg = sk.CreateArc(ToM(centre[0]), ToM(centre[1]), 0,
                        ToM(cx), ToM(cy), 0, ToM(to[0]), ToM(to[1]), 0, (short)dir);
                    arcs++;
                }
                else
                {
                    to = Point(s, "to", resolve);
                    seg = sk.CreateLine(ToM(cx), ToM(cy), 0, ToM(to[0]), ToM(to[1]), 0);
                    lines++;
                }

                if (seg == null)
                {
                    result.Parametric = false;
                    result.Notes.Add("path #" + index + ": segment to (" + to[0] + ", " + to[1]
                        + ") was not created");
                    break;
                }
                cx = to[0]; cy = to[1];
            }

            result.Parametric = false;
            result.Notes.Add("path #" + index + " (" + lines + " lines, " + arcs
                + " arcs) is geometry only: coordinates are baked at build time");
        }

        /// <summary>A slot profile: two parallel lines closed by two half-circle ends.
        /// The 2D counterpart of the slot feature — it extrudes into a slot-shaped boss
        /// or cuts into a slot-shaped pocket.</summary>
        static void AddSlot2D(ISketchManager sk, Dictionary<string, object> p,
            Func<object, double> resolve, ProfileResult result, int index)
        {
            sk.AddToDB = true;
            double[] c = Point(p, "center", resolve);
            double length = resolve(p.ContainsKey("length") ? p["length"] : 0);
            double width = resolve(p.ContainsKey("width") ? p["width"] : 0);
            double angle = Json.Dbl(p, "angle", 0) * Math.PI / 180.0;

            if (length <= width)
                throw new BridgeError("BAD_ARGUMENT",
                    "slot #" + index + " needs length > width (got " + length + " / " + width + ")");

            double r = width / 2.0;
            double half = (length - width) / 2.0;   // centre-to-centre of the end arcs
            double ux = Math.Cos(angle), uy = Math.Sin(angle);
            double nx = -uy, ny = ux;

            double ax = c[0] - half * ux, ay = c[1] - half * uy;   // left arc centre
            double bx = c[0] + half * ux, by = c[1] + half * uy;   // right arc centre

            // Start at the top of the left arc, run along one side to the top of the
            // right arc, sweep around it, come back along the other side.
            double s1x = ax + r * nx, s1y = ay + r * ny;
            double s2x = bx + r * nx, s2y = by + r * ny;
            double s3x = bx - r * nx, s3y = by - r * ny;
            double s4x = ax - r * nx, s4y = ay - r * ny;

            sk.CreateLine(ToM(s1x), ToM(s1y), 0, ToM(s2x), ToM(s2y), 0);
            sk.CreateArc(ToM(bx), ToM(by), 0, ToM(s2x), ToM(s2y), 0, ToM(s3x), ToM(s3y), 0, (short)1);
            sk.CreateLine(ToM(s3x), ToM(s3y), 0, ToM(s4x), ToM(s4y), 0);
            sk.CreateArc(ToM(ax), ToM(ay), 0, ToM(s4x), ToM(s4y), 0, ToM(s1x), ToM(s1y), 0, (short)1);

            result.Parametric = false;
            result.Notes.Add("slot #" + index + " (" + length + "x" + width
                + ") is geometry only: the outline carries no dimensions");
        }

        /// <summary>Every segment of a sketch with its coordinates, in mm.
        ///
        /// Counts are enough to know a profile is broken; they are not enough to know
        /// why. When a rectangle ends up somewhere other than where it was asked for
        /// — which happens as soon as a dimension or a relation moves it — the only
        /// way to see that is to read the coordinates back.</summary>
        public static Dictionary<string, object> GeometryOf(IFeature sketchFeature)
        {
            if (sketchFeature == null)
                throw new BridgeError("NO_SKETCH", "no sketch to read");
            ISketch sketch = null;
            try { sketch = (ISketch)sketchFeature.GetSpecificFeature2(); }
            catch (COMException) { }
            if (sketch == null)
                throw new BridgeError("NO_SKETCH", "sketch \"" + sketchFeature.Name + "\" is not readable");

            List<object> segments = new List<object>();
            ArrayList raw = Json.Arr(sketch.GetSketchSegments());
            if (raw != null)
            {
                foreach (object item in raw)
                {
                    ISketchSegment seg = item as ISketchSegment;
                    if (seg == null) continue;
                    Dictionary<string, object> rec;
                    try { rec = Curves.Readback(seg); }
                    catch (Exception ex)
                    {
                        rec = Json.Dict("type", "unreadable", "kind", "unreadable", "error", ex.Message);
                    }
                    segments.Add(rec);
                }
            }

            return Json.Dict(
                "sketch", sketchFeature.Name,
                "count", segments.Count,
                "units", "mm",
                "segments", segments,
                "description", Describe(sketchFeature));
        }

        /// <summary>Counts what actually landed in a sketch, and how many loose
        /// endpoints it still has.
        ///
        /// An extrusion refuses a profile with a gap by returning null, with no hint
        /// about which corner is open. Saying "11 segments, 2 open ends" turns that
        /// into a solvable problem, so every sketch reports it.</summary>
        public static Dictionary<string, object> Describe(IFeature sketchFeature)
        {
            if (sketchFeature == null) return Json.Dict("segments", 0, "openEnds", 0);
            ISketch sketch = null;
            try { sketch = (ISketch)sketchFeature.GetSpecificFeature2(); }
            catch (COMException) { }
            if (sketch == null) return Json.Dict("segments", 0, "openEnds", 0, "note", "sketch is not readable");

            object[] raw = (object[])sketch.GetSketchSegments();
            if (raw == null) return Json.Dict("segments", 0, "openEnds", 0);

            List<double[]> ends = new List<double[]>();
            int lines = 0, arcs = 0, ellipses = 0, splines = 0, others = 0, construction = 0;
            foreach (object item in raw)
            {
                ISketchSegment seg = item as ISketchSegment;
                if (seg == null) continue;
                try
                {
                    // Construction geometry is not part of the profile. The centre
                    // lines Rectify adds have four free ends between them, and
                    // counting those made every properly dimensioned profile report
                    // "4 open ends, not closed" — a false alarm on the sketches that
                    // were in fact the healthiest.
                    bool isConstruction = false;
                    try { isConstruction = seg.ConstructionGeometry; }
                    catch (COMException) { }
                    if (isConstruction) { construction++; continue; }

                    int kind = seg.GetType();
                    ISketchPoint a, b;
                    if (kind == (int)swSketchSegments_e.swSketchLINE)
                    {
                        lines++;
                        ISketchLine line = (ISketchLine)seg;
                        a = (ISketchPoint)line.GetStartPoint2();
                        b = (ISketchPoint)line.GetEndPoint2();
                    }
                    else if (kind == (int)swSketchSegments_e.swSketchARC)
                    {
                        arcs++;
                        ISketchArc arc = (ISketchArc)seg;
                        a = (ISketchPoint)arc.GetStartPoint2();
                        b = (ISketchPoint)arc.GetEndPoint2();
                    }
                    else if (kind == (int)swSketchSegments_e.swSketchELLIPSE) { ellipses++; continue; }
                    else if (kind == (int)swSketchSegments_e.swSketchSPLINE) { splines++; continue; }
                    else { others++; continue; }
                    ends.Add(new[] { a.X, a.Y });
                    ends.Add(new[] { b.X, b.Y });
                }
                catch (COMException) { others++; }
            }

            // An endpoint is loose when nothing else lands on it. A closed profile has
            // none; the count is what a caller needs to find the gap.
            const double eps = 1e-7;  // 0.0001 mm in metres
            int loose = 0;
            for (int i = 0; i < ends.Count; i++)
            {
                int matches = 0;
                for (int j = 0; j < ends.Count; j++)
                {
                    if (i == j) continue;
                    if (Math.Abs(ends[i][0] - ends[j][0]) <= eps
                        && Math.Abs(ends[i][1] - ends[j][1]) <= eps) { matches++; break; }
                }
                if (matches == 0) loose++;
            }

            return Json.Dict("segments", lines + arcs + ellipses + splines + others,
                "lines", lines, "arcs", arcs, "ellipses", ellipses, "splines", splines,
                "otherSegments", others, "constructionSegments", construction,
                "openEnds", loose, "closed", loose == 0 && lines + arcs + ellipses + splines > 0);
        }

        // --------------------------------------------------------------- helpers

        /// <summary>Draws the construction line a revolve turns about. It lives inside
        /// the profile sketch so the profile and its axis can never drift apart.</summary>
        public static void AddCenterline(ISketchManager sk, string axis, double spanMm)
        {
            ISketchSegment seg;
            if (axis == "y" || axis == "vertical")
                seg = sk.CreateLine(0, ToM(-spanMm), 0, 0, ToM(spanMm), 0);
            else
                seg = sk.CreateLine(ToM(-spanMm), 0, 0, ToM(spanMm), 0, 0);
            if (seg == null) return;
            try { seg.ConstructionGeometry = true; }
            catch (COMException) { }
        }

        static string BindName(Dictionary<string, object> primitive, string key, string fallback)
        {
            Dictionary<string, object> bind = Json.Obj(
                primitive.ContainsKey("bind") ? primitive["bind"] : null);
            if (bind != null)
            {
                string name = Json.Str(bind, key, null);
                if (!string.IsNullOrEmpty(name)) return name;
            }
            return fallback;
        }

        static double[] Point(Dictionary<string, object> p, string key, Func<object, double> resolve)
        {
            List<object> raw = new List<object>(Json.Items(p.ContainsKey(key) ? p[key] : null));
            if (raw.Count >= 2) return new[] { resolve(raw[0]), resolve(raw[1]) };
            return new[] { 0.0, 0.0 };
        }

        static double ToM(double mm) { return SwHost.ToMeters(mm); }
    }
}

