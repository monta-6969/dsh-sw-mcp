using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Places real SOLIDWORKS dimensions inside a sketch and constrains it
    /// symmetrically about the sketch origin.
    ///
    /// This is the difference between a model that looks right and one that stays
    /// right: coordinates drawn with AddToDB produce geometry with no native
    /// dimensions, so nothing in SOLIDWORKS can drive it afterwards. Every profile
    /// therefore gets
    ///   1. two construction centre lines through the origin,
    ///   2. sgSYMMETRIC from each opposite edge pair to its centre line,
    ///   3. one dimension per direction, which the caller binds to a variable.
    /// Measured result: the rectangle reaches swFullyConstrained (3).</summary>
    static class SketchDimensioner
    {
        /// <summary>Adds centre lines plus symmetry and two dimensions to a
        /// rectangle profile. Returns the display dimensions in the order
        /// [width, height] so the caller can bind D1 and D2.</summary>
        public static List<IDisplayDimension> Rectify(IModelDoc2 doc, ISketch sketch,
            ISketchManager sk, double widthMm, double heightMm)
        {
            return Rectify(doc, sketch, sk, widthMm, heightMm, true);
        }

        /// <summary>Same, but only centres the profile when it was drawn centred.
        ///
        /// The symmetry relations pull each edge pair onto the construction lines
        /// through the sketch origin. For a rectangle that was requested anywhere
        /// other than the origin, that is not "constrain the rectangle" — it is "move
        /// the rectangle to the origin", and it happens silently: the sketch still
        /// reports four closed segments, so the caller sees nothing wrong until a
        /// face ends up in the wrong place or a cut removes the wrong material.
        /// Measured: a 20 x 14 rectangle asked for at (-102.5, -55) was dragged to the
        /// origin, and the cut that followed took 24932 mm3 instead of 4200.
        ///
        /// So an off-origin rectangle gets its two dimensions and nothing else: it is
        /// then sized parametrically but positioned by its drawn coordinates, which is
        /// what the caller asked for.</summary>
        public static List<IDisplayDimension> Rectify(IModelDoc2 doc, ISketch sketch,
            ISketchManager sk, double widthMm, double heightMm, bool centredAtOrigin)
        {
            List<ISketchSegment> lines = SegmentList(sketch);
            if (lines.Count < 4)
                throw new BridgeError("SKETCH_TOO_SMALL",
                    "expected 4 sketch segments for the rectangle, found " + lines.Count);

            ISketchSegment left, right, top, bottom;
            Classify(lines, out left, out right, out top, out bottom);
            if (left == null || right == null || top == null || bottom == null)
                throw new BridgeError("SKETCH_SHAPE",
                    "could not classify the rectangle edges into left/right/top/bottom");

            List<IDisplayDimension> dims = new List<IDisplayDimension>();

            if (!centredAtOrigin)
            {
                IDisplayDimension wDim = AddDim(doc, left, right, 0, -(heightMm / 1000.0) * 0.8, 0);
                if (wDim != null) dims.Add(wDim);
                IDisplayDimension hDim = AddDim(doc, top, bottom, (widthMm / 1000.0) * 0.8, 0, 0);
                if (hDim != null) dims.Add(hDim);
                if (dims.Count < 2)
                    throw new BridgeError("DIMENSION_FAILED",
                        "could only create " + dims.Count + " of 2 dimensions for an off-centre rectangle");
                return dims;
            }

            // construction centre lines through the sketch origin
            double reach = Math.Max(widthMm, heightMm) / 1000.0;
            ISketchSegment vAxis = sk.CreateLine(0, -reach, 0, 0, reach, 0);
            ISketchSegment hAxis = sk.CreateLine(-reach, 0, 0, reach, 0, 0);
            MarkConstruction(vAxis);
            MarkConstruction(hAxis);

            // width: left and right edges symmetric about the vertical axis
            Symmetrize(doc, left, right, vAxis);
            IDisplayDimension widthDim = AddDim(doc, left, right, 0, -(heightMm / 1000.0) * 0.8, 0);
            if (widthDim == null)
                throw new BridgeError("DIMENSION_FAILED", "width dimension could not be created");
            dims.Add(widthDim);

            // height: top and bottom edges symmetric about the horizontal axis
            Symmetrize(doc, top, bottom, hAxis);
            IDisplayDimension heightDim = AddDim(doc, top, bottom, (widthMm / 1000.0) * 0.8, 0, 0);
            if (heightDim == null)
                throw new BridgeError("DIMENSION_FAILED", "height dimension could not be created");
            dims.Add(heightDim);

            return dims;
        }

        /// <summary>Adds a diameter dimension to the circles the caller names.
        ///
        /// Every arc in the sketch is examined, but only the ones matching a
        /// requested centre get a dimension. That matters because callers dimension
        /// circles one primitive at a time (each circle carries its own parameter):
        /// an implementation that walked all arcs would re-dimension earlier circles
        /// on every later call, leaving the sketch with duplicate diameters and one
        /// circle undimensioned — which then fails the cut that follows.
        ///
        /// The placement point comes from the caller's own centre list rather than
        /// from ISketchArc.GetCenterPoint2, which returns a bare __ComObject on some
        /// builds; matching, however, does read the real centre, falling back to
        /// creation order only when it cannot be read.</summary>
        public static List<IDisplayDimension> DimensionCircles(IModelDoc2 doc, ISketch sketch,
            double diameterMm, IList<double[]> centresMm, List<string> diagnostics)
        {
            List<IDisplayDimension> result = new List<IDisplayDimension>();
            ArrayList segments = Json.Arr(sketch.GetSketchSegments());
            if (segments == null)
            {
                if (diagnostics != null) diagnostics.Add("DimensionCircles: sketch reported no segments");
                return result;
            }

            List<ISketchSegment> arcs = new List<ISketchSegment>();
            List<double[]> arcCentres = new List<double[]>();
            foreach (object o in segments)
            {
                ISketchSegment seg = o as ISketchSegment;
                if (seg == null) continue;
                if (seg.GetType() != (int)swSketchSegments_e.swSketchARC) continue;
                arcs.Add(seg);
                arcCentres.Add(CentreOf(seg));
            }

            if (diagnostics != null)
                diagnostics.Add("DimensionCircles: " + arcs.Count + " arcs, "
                    + centresMm.Count + " known centres");

            double offset = diameterMm / 1000.0;
            bool[] taken = new bool[arcs.Count];
            for (int k = 0; k < centresMm.Count; k++)
            {
                int index = NearestFreeArc(arcCentres, taken, centresMm[k]);
                if (index < 0)
                {
                    if (diagnostics != null)
                        diagnostics.Add("no circle found near (" + centresMm[k][0] + ", "
                            + centresMm[k][1] + "); it gets no dimension");
                    continue;
                }
                taken[index] = true;

                double cx = centresMm[k][0] / 1000.0;
                double cy = centresMm[k][1] / 1000.0;

                doc.ClearSelection2(true);
                if (!SelectSegment(arcs[index], false))
                {
                    if (diagnostics != null) diagnostics.Add("arc " + index + " could not be selected");
                    continue;
                }

                try
                {
                    IDisplayDimension display = doc.AddDiameterDimension2(
                        cx + offset, cy + offset, 0) as IDisplayDimension;
                    if (display != null) result.Add(display);
                    else if (diagnostics != null) diagnostics.Add("AddDiameterDimension2 returned null for arc " + index);
                }
                catch (COMException ex)
                {
                    if (diagnostics != null)
                        diagnostics.Add("arc " + index + " AddDiameterDimension2 threw 0x"
                            + ex.HResult.ToString("X8"));
                }
            }
            if (diagnostics != null) diagnostics.Add("DimensionCircles: " + result.Count + " dimensions");
            return result;
        }

        /// <summary>Centre of an arc in mm, or null when this build refuses to hand it
        /// over as a sketch point (it does that for some arc types).</summary>
        static double[] CentreOf(ISketchSegment seg)
        {
            try
            {
                ISketchArc arc = seg as ISketchArc;
                if (arc == null) return null;
                ISketchPoint p = arc.GetCenterPoint2() as ISketchPoint;
                if (p == null) return null;
                return new double[] { p.X * 1000.0, p.Y * 1000.0 };
            }
            catch (COMException) { return null; }
        }

        /// <summary>Index of the untaken arc nearest the wanted centre, or -1.
        ///
        /// The tolerance is generous on purpose: this is matching our own request to
        /// the geometry we just drew, not measuring. Two circles closer together than
        /// this would be ambiguous anyway, and picking the wrong one would put the
        /// diameter on the wrong hole.</summary>
        static int NearestFreeArc(List<double[]> arcCentres, bool[] taken, double[] wantedMm)
        {
            int best = -1;
            double bestDistance = 1.0;   // mm
            for (int i = 0; i < arcCentres.Count; i++)
            {
                if (taken[i]) continue;
                double[] c = arcCentres[i];
                if (c == null) continue;
                double d = Math.Sqrt(
                    (c[0] - wantedMm[0]) * (c[0] - wantedMm[0])
                    + (c[1] - wantedMm[1]) * (c[1] - wantedMm[1]));
                if (d < bestDistance)
                {
                    bestDistance = d;
                    best = i;
                }
            }
            if (best >= 0) return best;

            // Nothing matched: fall back to creation order so a build that cannot
            // report arc centres still gets its dimensions.
            for (int i = 0; i < taken.Length; i++)
                if (!taken[i]) return i;
            return -1;
        }

        /// <summary>Positions a rectangular hole group with native relations instead
        /// of coordinates.
        ///
        /// Coordinates alone mean that widening the plate leaves the holes where they
        /// were, so the edge distance silently collapses to zero. With two
        /// construction centre lines, a symmetry relation per pair, and one
        /// dimension per direction, SOLIDWORKS itself keeps every hole at the
        /// requested distance from the edge - and keeps doing so after this bridge
        /// exits.
        ///
        /// Centres are expected in creation order: bottom-left, bottom-right,
        /// top-right, top-left.</summary>
        public static List<IDisplayDimension> PositionHoles(IModelDoc2 doc, ISketchManager sk,
            IList<ISketchArc> arcs, double widthMm, double heightMm, double edgeMm,
            List<string> diagnostics)
        {
            List<IDisplayDimension> dims = new List<IDisplayDimension>();
            if (arcs == null || arcs.Count == 0 || diagnostics == null)
                return dims;

            double reach = Math.Max(widthMm, heightMm) / 1000.0;
            ISketchSegment vAxis = sk.CreateLine(0, -reach, 0, 0, reach, 0);
            ISketchSegment hAxis = sk.CreateLine(-reach, 0, 0, reach, 0, 0);
            MarkConstruction(vAxis);
            MarkConstruction(hAxis);

            List<ISketchPoint> centres = new List<ISketchPoint>();
            foreach (ISketchArc arc in arcs)
            {
                ISketchPoint p = arc.GetCenterPoint2() as ISketchPoint;
                if (p == null) return dims;
                centres.Add(p);
            }
            if (centres.Count != 4)
                throw new BridgeError("HOLE_GROUP_UNSUPPORTED",
                    "a corner hole group needs exactly 4 centres, got " + centres.Count
                    + "; a two-hole group uses the pair path (one centre-distance dimension)",
                    Json.Dict("count", centres.Count, "supported", Json.List(2, 4)));

            if (!SymmetrizePoints(doc, centres[0], centres[1], vAxis))
                diagnostics.Add("PositionHoles: bottom pair symmetry failed");
            if (!SymmetrizePoints(doc, centres[3], centres[2], vAxis))
                diagnostics.Add("PositionHoles: top pair symmetry failed");
            if (!SymmetrizePoints(doc, centres[0], centres[3], hAxis))
                diagnostics.Add("PositionHoles: left pair symmetry failed");
            if (!SymmetrizePoints(doc, centres[1], centres[2], hAxis))
                diagnostics.Add("PositionHoles: right pair symmetry failed");

            double x = widthMm / 2.0 - edgeMm;
            double y = heightMm / 2.0 - edgeMm;

            IDisplayDimension dx = AddPointToLineDim(doc, centres[0], vAxis,
                -x / 1000.0, -(y / 1000.0) * 0.5, 0);
            if (dx != null) dims.Add(dx);
            else diagnostics.Add("PositionHoles: x offset dimension failed");

            IDisplayDimension dy = AddPointToLineDim(doc, centres[0], hAxis,
                -(x / 1000.0) * 0.5, -y / 1000.0, 0);
            if (dy != null) dims.Add(dy);
            else diagnostics.Add("PositionHoles: y offset dimension failed");

            diagnostics.Add("PositionHoles: " + dims.Count + " offset dimensions over "
                + arcs.Count + " holes");
            return dims;
        }

        /// <summary>Positions a two-hole group with one native centre-distance
        /// dimension.
        ///
        /// A pair is the one hole group whose defining dimension is a single distance:
        /// two circles selected together produce the centre-to-centre distance. The
        /// 4-centre path cannot express it (it is written as two half offsets), and
        /// silently returning no dimension here is what left two-hole designs with an
        /// unbound "hole.pitch" parameter.
        ///
        /// The dimension is not given a value: the circles were drawn at the resolved
        /// pitch, and the caller binds the dimension to that parameter afterwards.</summary>
        public static IDisplayDimension PositionHolePair(IModelDoc2 doc, ISketch sketch,
            IList<ISketchArc> arcs, IList<double[]> centresMm, List<string> diagnostics)
        {
            if (arcs == null || arcs.Count != 2)
                throw new BridgeError("HOLE_GROUP_UNSUPPORTED",
                    "a two-hole pair needs exactly 2 circles, got " + (arcs == null ? 0 : arcs.Count),
                    Json.Dict("count", arcs == null ? 0 : arcs.Count, "supported", Json.List(2, 4)));
            if (diagnostics == null) diagnostics = new List<string>();

            double[] a = centresMm != null && centresMm.Count == 2 ? centresMm[0] : new double[] { 0, 0 };
            double[] b = centresMm != null && centresMm.Count == 2 ? centresMm[1] : new double[] { 0, 0 };
            double[] at = new double[] { (a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0 + 5 };

            IDisplayDimension display;
            Dictionary<string, object> row = AddOne(doc, sketch, "distance",
                new object[] { arcs[0], arcs[1] }, 0, null, at, diagnostics, out display);
            if (display == null)
                throw new BridgeError("DIMENSION_CREATE_FAILED",
                    "the two-hole centre distance produced no native dimension",
                    Json.Dict("sketch", "hole pair", "row", row));
            string created = Convert.ToString(row.ContainsKey("type") ? row["type"] : "?");
            if (!string.Equals(created, "distance", StringComparison.OrdinalIgnoreCase))
            {
                DeleteDisplay(doc, display, diagnostics);
                throw new BridgeError("DIMENSION_CREATE_FAILED",
                    "the two-circle selection produced a \"" + created + "\" dimension instead of "
                    + "a centre distance; it was deleted so it cannot be mistaken for the pitch",
                    Json.Dict("kind", created, "holeCount", arcs.Count));
            }
            diagnostics.Add("PositionHolePair: 1 centre-distance dimension over 2 holes");
            return display;
        }

        static bool SymmetrizePoints(IModelDoc2 doc, ISketchPoint a, ISketchPoint b, ISketchSegment axis)        {
            doc.ClearSelection2(true);
            if (!SelectPoint(a, false)) return false;
            if (!SelectPoint(b, true)) return false;
            if (!SelectSegment(axis, true)) return false;
            try
            {
                doc.SketchAddConstraints("sgSYMMETRIC");
                return true;
            }
            catch (COMException)
            {
                return false;
            }
        }

        static bool SelectPoint(ISketchPoint p, bool append)
        {
            if (p == null) return false;
            try
            {
                return p.Select4(append, null);
            }
            catch (COMException)
            {
                return false;
            }
        }

        static IDisplayDimension AddPointToLineDim(IModelDoc2 doc, ISketchPoint p,
            ISketchSegment line, double x, double y, double z)
        {
            doc.ClearSelection2(true);
            if (!SelectPoint(p, false)) return null;
            if (!SelectSegment(line, true)) return null;
            try
            {
                return doc.AddDimension2(x, y, z) as IDisplayDimension;
            }
            catch (COMException)
            {
                return null;
            }
        }

        /// <summary>Applies sgSYMMETRIC between an opposite edge pair and a centre
        /// line, then pins the centre line. This is what makes a width change move
        /// both sides equally instead of dragging the profile off-centre.
        ///
        /// Segments are selected with ISketchSegment.Select2: a sketch segment is
        /// not exposed as IEntity (the cast fails with E_NOINTERFACE), while a
        /// feature and a face both are.</summary>
        static void Symmetrize(IModelDoc2 doc, ISketchSegment a, ISketchSegment b, ISketchSegment axis)
        {
            doc.ClearSelection2(true);
            if (!SelectSegment(a, false)) return;
            if (!SelectSegment(b, true)) return;
            if (!SelectSegment(axis, true)) return;
            try
            {
                doc.SketchAddConstraints("sgSYMMETRIC");
            }
            catch (COMException)
            {
                // a symmetry relation that cannot be applied leaves the sketch
                // under-constrained, which the caller reports via status
            }
            doc.ClearSelection2(true);
            if (SelectSegment(axis, false))
            {
                try
                {
                    doc.SketchAddConstraints("sgFIXED");
                }
                catch (COMException) { }
            }
        }

        // ------------------------------------------------- generic dimension editing

        /// <summary>List/add/edit/remove the dimensions of one sketch.
        ///
        /// Request: <c>{designId?, sketch?, action:list|add|edit|remove,
        /// dimensions:[{kind, refs, valueMm, name, position?, index?}]}</c>.
        /// Every failure is explicit: a dimension that cannot be created throws
        /// DIMENSION_CREATE_FAILED, a value that does not stick is reported as
        /// unverified, and a delete that SOLIDWORKS refuses throws
        /// DIMENSION_DELETE_UNSUPPORTED instead of being counted as done.</summary>
        public static Dictionary<string, object> Dispatch(Dictionary<string, object> req)
        {
            string action = (Json.Str(req, "action", "list") ?? "list").ToLowerInvariant();
            using (SwHost h = SwHost.Attach())
            {
                string sketchName;
                IModelDoc2 doc;
                ISketch sketch = Relations.GetSketch(h, Json.Str(req, "designId", null),
                    Json.Str(req, "sketch", null), out sketchName, out doc);
                if (sketch == null) throw new BridgeError("NO_SKETCH", "no sketch to inspect dimensions on");

                List<string> notes = new List<string>();
                IFeature feature = Relations.SketchFeature(doc, sketchName);
                if (feature == null) notes.Add("the sketch feature is not readable; dimensions may be unavailable");

                List<object> items = new List<object>(Json.Items(req.ContainsKey("dimensions") ? req["dimensions"] : null));
                Dictionary<string, object> result = Json.Dict(
                    "action", action,
                    "sketch", sketchName,
                    "document", Relations.DocumentOf(doc),
                    "notes", notes);

                if (string.Equals(action, "list", StringComparison.Ordinal))
                {
                    List<IDisplayDimension> displays;
                    List<object> rows = DimensionRows(feature, out displays, notes);
                    result["dimensions"] = rows;
                    result["count"] = rows.Count;
                    // 「几张是驱动尺寸」必须在顶层能一眼看到：参考尺寸读得出来但
                    // 改不动，逐行翻 reference 字段是最容易漏掉的那种读法。
                    int driving = 0, reference = 0;
                    foreach (object raw in rows)
                    {
                        Dictionary<string, object> row = Json.Obj(raw);
                        if (row == null) continue;
                        if (Json.Bool(row, "driving", false)) driving++; else reference++;
                    }
                    result["driving"] = driving;
                    result["reference"] = reference;
                    result["fullyDriving"] = reference == 0;
                    if (reference > 0)
                        notes.Add(reference + " of " + rows.Count + " dimension(s) are reference dimensions "
                            + "(readable, not driving). Those will not move the model — give them the "
                            + "constraint that defines them first, or rebuild the sketch parametrically.");
                    return result;
                }

                if (string.Equals(action, "add", StringComparison.Ordinal))
                {
                    List<object> applied = new List<object>();
                    // 一条都没写进去就别报成功：多数「加了尺寸但模型不动」都是
                    // 草图不在编辑态，SOLIDWORKS 静默产出参考尺寸。
                    EnsureEditMode(doc, sketchName, notes);
                    foreach (object raw in items)
                    {
                        Dictionary<string, object> spec = Json.Obj(raw);
                        if (spec == null) continue;
                        string kind = Json.Str(spec, "kind", Json.Str(spec, "type", "distance"));
                        List<string> refs = RefTexts(spec);
                        List<object> com = new List<object>();
                        foreach (string text in refs)
                        {
                            object entity;
                            string why;
                            if (!Relations.TryEntity(sketch, text, out entity, out why))
                                throw new BridgeError("DIMENSION_CREATE_FAILED",
                                    "dimension reference \"" + text + "\" does not resolve: " + why,
                                    Json.Dict("kind", kind, "refs", refs));
                            com.Add(entity);
                        }
                        double[] at = Position(spec);
                        Dictionary<string, object> row = AddOne(doc, sketch, kind, com.ToArray(),
                            Json.Dbl(spec, "valueMm", Json.Dbl(spec, "value", 0)),
                            Json.Str(spec, "name", null), at, notes);
                        row["refs"] = refs;
                        applied.Add(row);
                    }
                    // 首次落参考尺寸 = 这次「新增」是假的：报错并说清怎么修。
                    RejectReferenceDims(applied, notes, "add");
                    result["applied"] = applied;
                    result["count"] = applied.Count;
                    List<IDisplayDimension> displays;
                    result["dimensions"] = DimensionRows(feature, out displays, notes);
                    return result;
                }

                if (string.Equals(action, "edit", StringComparison.Ordinal))
                {
                    List<IDisplayDimension> displays;
                    DimensionRows(feature, out displays, notes);
                    EnsureEditMode(doc, sketchName, notes);
                    List<object> updated = new List<object>();
                    foreach (object raw in items)
                    {
                        Dictionary<string, object> spec = Json.Obj(raw);
                        if (spec == null) continue;
                        int index = Json.Int(spec, "index", 0);
                        if (index <= 0)
                            throw new BridgeError("DIMENSION_EDIT_FAILED",
                                "edit needs \"index\": the 1-based index reported by action=list");
                        if (index > displays.Count)
                            throw new BridgeError("DIMENSION_NOT_FOUND",
                                "no dimension " + index + " in sketch \"" + sketchName + "\" ("
                                + displays.Count + " dimension(s))",
                                Json.Dict("index", Json.R(index), "count", Json.R(displays.Count),
                                    "dimensions", DimensionRows(feature, out displays, notes)));
                        IDisplayDimension display = displays[index - 1];
                        IDimension dim = AsDimension(display);
                        if (dim == null)
                            throw new BridgeError("DIMENSION_EDIT_FAILED",
                                "dimension " + index + " exposes no IDimension",
                                Json.Dict("index", Json.R(index)));
                        bool angle = IsAngle(display);
                        double previous = ReadValue(dim, angle);
                        double value = Json.Dbl(spec, "valueMm", Json.Dbl(spec, "value", 0));
                        SetValue(dim, angle, value, notes);
                        string name = Json.Str(spec, "name", null);
                        if (name != null)
                        {
                            try { dim.Name = name; }
                            catch (COMException ex) { notes.Add("could not rename dimension " + index + ": " + ex.Message); }
                        }
                        Dictionary<string, object> row = Row(display, dim, index, angle, notes);
                        row["previousMm"] = Json.R(previous);
                        double readBack = ReadValue(dim, angle);
                        if (Math.Abs(readBack - value) > (angle ? 0.01 : 0.005))
                        {
                            row["unverified"] = true;
                            notes.Add("dimension " + index + " reads back " + Json.Num(readBack)
                                + " instead of " + Json.Num(value));
                        }
                        updated.Add(row);
                    }
                    RejectReferenceDims(updated, notes, "edit");
                    result["updated"] = updated;
                    result["count"] = updated.Count;
                    List<IDisplayDimension> after;
                    result["dimensions"] = DimensionRows(feature, out after, notes);
                    return result;
                }

                if (string.Equals(action, "remove", StringComparison.Ordinal))
                {
                    // 删除也必须先进入草图编辑态：草图关闭时维度不在可选集合里，
                    // SelectByID2 + EditDelete 会“成功”但没有删掉（实测重开后 0 条能删）。
                    // 顺序必须是「先编辑态、再取 DimensionRows」：进编辑态会重建草图
                    // 的显示尺寸，之前取到的 IDisplayDimension 会失效，报「no selection
                    // name」（实测重开后删 [1,2] 时 index 1 就是这么失败的）。
                    EnsureEditMode(doc, sketchName, notes);
                    List<IDisplayDimension> displays;
                    DimensionRows(feature, out displays, notes);
                    List<int> indices = Indices(req, items);
                    List<object> removed = new List<object>();
                    List<object> failures = new List<object>();
                    List<object> unbound = new List<object>();
                    indices.Sort();
                    indices.Reverse();
                    foreach (int index in indices)
                    {
                        if (index <= 0 || index > displays.Count)
                        {
                            failures.Add(Json.Dict("index", Json.R(index), "reason",
                                "no dimension at this index (" + displays.Count + " dimension(s))",
                                "notes", new List<object>(notes.ToArray())));
                            continue;
                        }
                        // 每删一条，草图会重建，之前取到的 IDisplayDimension 随之失效
                        // （下一条报「no selection name」）。每条都在删除前重新取一次：
                        // 按降序处理，删掉的高序号不会改变低序号在列表里的位置。
                        List<IDisplayDimension> live;
                        DimensionRows(feature, out live, notes);
                        if (index > live.Count)
                        {
                            failures.Add(Json.Dict("index", Json.R(index), "reason",
                                "no dimension at this index (" + live.Count + " dimension(s) left)",
                                "notes", new List<object>(notes.ToArray())));
                            continue;
                        }
                        // 先解绑再删：被方程式驱动的尺寸直接 EditDelete 会失败（或被
                        // 方程式管理器当场恢复）。解绑项要逐条回报，调用方才知道这次
                        // 删掉的不只是几何，还拆掉了一条参数绑定。
                        Dictionary<string, object> unboundRow = UnbindOne(doc, live[index - 1], notes);
                        if (unboundRow != null) unbound.Add(unboundRow);
                        Dictionary<string, object> row = RemoveOne(doc, feature, live, index, notes);
                        if (row == null)
                        {
                            // 失败行要把 notes 原文带上：只说「see notes」的话，调用方
                            // 还得再翻一次回包才知道是选不中、还是 SOLIDWORKS 拒删。
                            string failedDim = null;
                            try { failedDim = displays[index - 1].GetNameForSelection(); }
                            catch (COMException) { }
                            failures.Add(Json.Dict("index", Json.R(index), "dimension", failedDim,
                                "reason", "SOLIDWORKS did not delete the dimension",
                                "notes", new List<object>(notes.ToArray())));
                            continue;
                        }
                        removed.Add(row);
                    }
                    // 逐目标回报：一条删不掉不再把这次调用整体判死，也不能把成功项
                    // 藏在 error.detail 里。服务端按 failures.length 判 status，Agent
                    // 只需要看失败的那几条，不用整批重试。
                    int requested = indices.Count;
                    result["removed"] = removed;
                    result["failures"] = failures;
                    result["unbound"] = unbound;
                    result["removedCount"] = removed.Count;
                    result["failureCount"] = failures.Count;
                    result["requested"] = requested;
                    result["count"] = removed.Count;
                    if (failures.Count > 0 && removed.Count == 0)
                        result["code"] = "DIMENSION_DELETE_UNSUPPORTED";
                    List<IDisplayDimension> remaining;
                    result["dimensions"] = DimensionRows(feature, out remaining, notes);
                    return result;
                }

                throw new BridgeError("BAD_ARGUMENT",
                    "dimensions action must be one of list, add, edit or remove; got \"" + action + "\"",
                    Json.Dict("actions", Json.List("list", "add", "edit", "remove")));
            }
        }

        /// <summary>把目标草图切进编辑态。
        ///
        /// 为什么写尺寸必须先做这一步：SOLIDWORKS 允许在草图关闭时调用
        /// AddDimension2，但产出的是一张**参考尺寸**——IsReferenceDim()=true，
        /// 双击它改数值模型不动。真机会话因此调了 69 次 dimensions，每次都看到
        /// reference:true，还当成成功继续往下走。</summary>
        static void EnsureEditMode(IModelDoc2 doc, string sketchName, List<string> notes)
        {
            IFeature active = null;
            try { active = (IFeature)doc.GetActiveSketch(); } catch (COMException) { }
            if (active != null && string.Equals(active.Name, sketchName, StringComparison.OrdinalIgnoreCase))
                return;
            bool opened = false;
            try
            {
                IFeature feature = Relations.SketchFeature(doc, sketchName);
                if (feature != null)
                {
                    try { doc.ClearSelection2(true); } catch (COMException) { }
                    opened = feature.Select2(false, 0);
                }
                if (!opened)
                    throw new BridgeError("SKETCH_NOT_EDITABLE",
                        "could not select sketch \"" + sketchName + "\" to edit its dimensions",
                        Json.Dict("sketch", sketchName));
                doc.EditSketch();
                notes.Add("entered sketch-edit mode for \"" + sketchName + "\" "
                    + "(dimensions created outside edit mode come back as reference dimensions)");
            }
            catch (COMException ex)
            {
                throw new BridgeError("SKETCH_NOT_EDITABLE",
                    "entering sketch \"" + sketchName + "\" failed with COM 0x"
                    + ex.HResult.ToString("X8")
                    + "; dimensions added outside edit mode are reference-only",
                    Json.Dict("sketch", sketchName));
            }
            IFeature reopened = null;
            try { reopened = (IFeature)doc.GetActiveSketch(); } catch (COMException) { }
            if (reopened == null
                || !string.Equals(reopened.Name, sketchName, StringComparison.OrdinalIgnoreCase))
            {
                throw new BridgeError("SKETCH_NOT_EDITABLE",
                    "SOLIDWORKS did not enter edit mode for sketch \"" + sketchName + "\"",
                    Json.Dict("sketch", sketchName,
                        "active", reopened == null ? null : reopened.Name));
            }
        }

        /// <summary>写尺寸的结果里只要还有 reference=true，就说明没真正落地。
        ///
        /// 「加了尺寸但模型不动」是这条链路上最贵的一种假成功：返回体看着是
        /// applied/updated，实际每一张都是参考尺寸。宁可报错，也不要让它通过。</summary>
        static void RejectReferenceDims(List<object> rows, List<string> notes, string action)
        {
            List<object> reference = new List<object>();
            foreach (object raw in rows)
            {
                Dictionary<string, object> row = Json.Obj(raw);
                if (row == null) continue;
                if (!Json.Bool(row, "reference", false) && Json.Bool(row, "driving", true)) continue;
                reference.Add(Json.Dict(
                    "index", row.ContainsKey("index") ? row["index"] : null,
                    "kind", row.ContainsKey("kind") ? row["kind"] : null,
                    "valueMm", row.ContainsKey("valueMm") ? row["valueMm"] : null,
                    "reference", true));
            }
            if (reference.Count == 0) return;
            throw new BridgeError("DIMENSION_NOT_DRIVING",
                reference.Count + " of " + rows.Count + " dimension(s) came back as reference dimensions "
                + "(IsReferenceDim=true) — they can be read but they cannot drive the model, so this "
                + action + " did NOT land. The usual cause is the sketch not being in edit mode.",
                Json.Dict("action", action, "reference", reference,
                    "fix", "open the sketch (EditSketch) and add the dimensions while it is open; "
                        + "if they still come back reference, the constraint that would define them is "
                        + "missing — add the sketch relation (symmetric/coincident) first",
                    "notes", notes));
        }

        /// <summary>Creates one dimension from already-resolved COM entities. Shared by
        /// the dimensions op and by a sketch plan built through Builder.</summary>
        public static Dictionary<string, object> AddOne(IModelDoc2 doc, ISketch sketch, string kind,
            object[] entities, double value, string name, double[] atMm, List<string> notes)
        {
            IDisplayDimension ignored;
            return AddOne(doc, sketch, kind, entities, value, name, atMm, notes, out ignored);
        }

        /// <summary>Same, and hands the created display dimension back. A caller that
        /// has to bind the new dimension to a parameter (Compiler.SketchFromSpec)
        /// cannot re-resolve it by name reliably, so it takes the live object here.</summary>
        public static Dictionary<string, object> AddOne(IModelDoc2 doc, ISketch sketch, string kind,
            object[] entities, double value, string name, double[] atMm, List<string> notes,
            out IDisplayDimension created)
        {
            string normalized = NormalizeKind(kind);
            created = null;
            if (entities == null || entities.Length == 0)
                throw new BridgeError("DIMENSION_CREATE_FAILED",
                    "a " + normalized + " dimension needs at least one entity");
            if (atMm == null)
                atMm = entities.Length >= 2
                    ? PlacementBetween(entities[0], entities[1], normalized)
                    : PlacementOf(entities[0], normalized);

            // 选择计数是「尺寸没生成」与「选择根本没进去」的分界：Select2 返回 true
            // 不代表选中（select 工具那边同样的坑）。真机实测两颗圆心点 Select2 全
            // 返回 true，AddDimension2 仍然回 null —— 需要知道到底是没选中，还是
            // SOLIDWORKS 不接受「两个圆心点」这种组合。
            //
            // 更贵的一课：只选中一个圆时 AddDimension2 会生成**半径**尺寸，再按
            // 「距离」写值就把圆半径改成了 60。所以选择没整组进去时宁可不创建。
            string selectionUsed = "entities";
            int selectedCount = SelectForDimension(doc, entities, normalized, notes);
            IDisplayDimension display = null;
            if (selectedCount >= entities.Length)
                display = CreateDisplay(doc, normalized, atMm, notes);
            else
                notes.Add("dimension " + normalized + ": only " + selectedCount + "/"
                    + entities.Length + " entities joined the selection; no dimension was created");

            // 两个圆心点被拒时改选两个圆本身：SW 对两条圆/弧调用 AddDimension2 生成
            // 的是圆心距，仍是原生驱动尺寸。只对 distance + 两个 ISketchPoint 生效，
            // 且只在第一次真的没生成尺寸时尝试一次。
            if (display == null && normalized == "distance")
            {
                object[] circles = CirclePairFor(sketch, entities);
                if (circles != null)
                {
                    notes.Add("distance dimension: the given selection produced no dimension; "
                        + "retrying with the two circles themselves");
                    int circleCount = SelectForDimension(doc, circles, normalized, notes);
                    if (circleCount >= 2)
                        display = CreateDisplay(doc, normalized, atMm, notes);
                    if (display != null)
                    {
                        string createdKind = KindOf(DisplayType(display));
                        if (!string.Equals(createdKind, normalized, StringComparison.OrdinalIgnoreCase))
                        {
                            notes.Add("distance dimension: the circle selection produced a \""
                                + createdKind + "\" dimension, not a distance; it was deleted instead of "
                                + "being written with the wrong value");
                            DeleteDisplay(doc, display, notes);
                            display = null;
                        }
                        else
                        {
                            selectionUsed = "circles";
                            selectedCount = circleCount;
                        }
                    }
                }
            }
            doc.ClearSelection2(true);
            if (display == null)
                throw new BridgeError("DIMENSION_CREATE_FAILED",
                    "SOLIDWORKS returned no " + normalized + " dimension for the selection",
                    Json.Dict("kind", normalized, "entities", entities.Length,
                        "selectionCount", Json.R(selectedCount), "selection", selectionUsed,
                        "placementMm", new List<object> { Json.R(atMm[0]), Json.R(atMm[1]) },
                        "notes", notes));

            IDimension dim = AsDimension(display);
            if (dim == null)
                throw new BridgeError("DIMENSION_CREATE_FAILED",
                    "the " + normalized + " dimension exposes no IDimension",
                    Json.Dict("kind", normalized));

            bool angle = IsAngle(display);
            if (value != 0) SetValue(dim, angle, value, notes);
            if (name != null)
            {
                try { dim.Name = name; }
                catch (COMException ex) { notes.Add("could not name the dimension \"" + name + "\": " + ex.Message); }
            }

            Dictionary<string, object> row = Row(display, dim, 0, angle, notes);
            row["kind"] = normalized;
            row["requestedMm"] = Json.R(value);
            double readBack = ReadValue(dim, angle);
            if (Math.Abs(readBack - value) > (angle ? 0.01 : 0.005))
            {
                row["unverified"] = true;
                notes.Add("dimension value reads back " + Json.Num(readBack)
                    + " instead of " + Json.Num(value));
            }
            created = display;
            row["selection"] = selectionUsed;
            row["selectedCount"] = Json.R(selectedCount);
            return row;
        }

        /// <summary>Selects a dimension's entities and returns how many SOLIDWORKS
        /// actually shows selected. -1 means the selection manager could not be read.
        ///
        /// Select2 returning true is not proof of selection — the select tool has the
        /// same trap — and "no dimension for the selection" is otherwise ambiguous
        /// between "nothing was selected" and "this combination is refused".</summary>
        static int SelectForDimension(IModelDoc2 doc, object[] entities, string kind, List<string> notes)
        {
            doc.ClearSelection2(true);
            int rejected = 0;
            bool append = false;
            foreach (object entity in entities)
            {
                if (!SelectOne(doc, entity, append)) rejected++;
                append = true;
            }
            int count = SelectedCount(doc);
            if (rejected > 0 || (count >= 0 && count < entities.Length))
                notes.Add("dimension " + kind + ": " + count + "/" + entities.Length
                    + " selected (" + rejected + " entity selection(s) failed); selected: "
                    + SelectionSummary(doc));
            return count;
        }

        /// <summary>Selects one entity and proves it joined the selection.
        ///
        /// Select2 returning true is not proof (measured: two centre points both
        /// "selected", selection count 1), so the count is checked. When the entity's
        /// own Select4 does not join, the coordinate route SelectByID2 is used — the
        /// same two routes Relations.SelectEntity takes for sketch relations.
        /// </summary>
        static bool SelectOne(IModelDoc2 doc, object entity, bool append)
        {
            int before = SelectedCount(doc);
            ISketchPoint point = entity as ISketchPoint;
            if (point != null)
            {
                try { if (point.Select4(append, null) && SelectedCount(doc) > before) return true; }
                catch (COMException) { }
            }
            ISketchSegment seg = entity as ISketchSegment;
            if (seg != null)
            {
                try { if (seg.Select4(append, null) && SelectedCount(doc) > before) return true; }
                catch (COMException) { }
            }
            double xMm, yMm;
            string type;
            if (!SelectionPoint(entity, out xMm, out yMm, out type)) return false;
            IModelDocExtension ext = doc.Extension;
            if (ext == null) return false;
            try
            {
                return ext.SelectByID2("", type, xMm * 0.001, yMm * 0.001, 0, append, 0, null, 0)
                    && SelectedCount(doc) > before;
            }
            catch (COMException) { return false; }
        }

        /// <summary>A point on the entity plus the SelectByID2 type string that picks
        /// it. An arc is picked by its start point (not its centre: the centre is not on
        /// the curve and does not hit the entity).</summary>
        static bool SelectionPoint(object entity, out double xMm, out double yMm, out string type)
        {
            xMm = 0;
            yMm = 0;
            type = null;
            ISketchPoint point = entity as ISketchPoint;
            if (point != null)
            {
                xMm = point.X * 1000.0;
                yMm = point.Y * 1000.0;
                type = "SKETCHPOINT";
                return true;
            }
            ISketchSegment seg = entity as ISketchSegment;
            if (seg == null) return false;
            try
            {
                int code = seg.GetType();
                if (code == (int)swSketchSegments_e.swSketchLINE)
                {
                    ISketchLine line = (ISketchLine)seg;
                    ISketchPoint a = (ISketchPoint)line.GetStartPoint2();
                    ISketchPoint b = (ISketchPoint)line.GetEndPoint2();
                    if (a == null || b == null) return false;
                    xMm = (a.X + b.X) / 2.0 * 1000.0;
                    yMm = (a.Y + b.Y) / 2.0 * 1000.0;
                    type = "SKETCHLINE";
                    return true;
                }
                if (code == (int)swSketchSegments_e.swSketchARC)
                {
                    ISketchPoint a = (ISketchPoint)((ISketchArc)seg).GetStartPoint2();
                    if (a == null) return false;
                    xMm = a.X * 1000.0;
                    yMm = a.Y * 1000.0;
                    type = "SKETCHARC";
                    return true;
                }
                if (code == (int)swSketchSegments_e.swSketchELLIPSE)
                {
                    ISketchPoint a = (ISketchPoint)((ISketchEllipse)seg).GetStartPoint2();
                    if (a == null) return false;
                    xMm = a.X * 1000.0;
                    yMm = a.Y * 1000.0;
                    type = "SKETCHELLIPSE";
                    return true;
                }
                if (code == (int)swSketchSegments_e.swSketchSPLINE)
                {
                    object[] points = (object[])((ISketchSpline)seg).GetPoints2();
                    ISketchPoint a = points != null && points.Length > 0 ? points[0] as ISketchPoint : null;
                    if (a == null) return false;
                    xMm = a.X * 1000.0;
                    yMm = a.Y * 1000.0;
                    type = "SKETCHSPLINE";
                    return true;
                }
            }
            catch (COMException) { }
            return false;
        }

        static int DisplayType(IDisplayDimension display)
        {
            if (display == null) return -1;
            try { return display.GetType(); }
            catch (COMException) { return -1; }
        }

        /// <summary>Deletes a dimension created by mistake (wrong type). Never leaves it
        /// behind: a stray radius dimension written with a distance value is worse than
        /// a clean failure.</summary>
        static void DeleteDisplay(IModelDoc2 doc, IDisplayDimension display, List<string> notes)
        {
            string name = null;
            try { name = display.GetNameForSelection(); }
            catch (COMException) { }
            if (string.IsNullOrEmpty(name))
            {
                notes.Add("could not delete the unwanted dimension (it has no selection name)");
                return;
            }
            try
            {
                doc.ClearSelection2(true);
                if (doc.Extension.SelectByID2(name, "DIMENSION", 0, 0, 0, false, 0, null, 0))
                {
                    doc.EditDelete();
                    notes.Add("deleted the unwanted dimension " + name);
                }
                else notes.Add("could not select the unwanted dimension " + name + " for deletion");
            }
            catch (COMException ex)
            {
                notes.Add("could not delete the unwanted dimension: COM 0x"
                    + ex.HResult.ToString("X8"));
            }
            finally
            {
                try { doc.ClearSelection2(true); }
                catch (COMException) { }
            }
        }

        /// <summary>What actually sits in the selection: a centre point that selects
        /// nothing is the difference between "SOLIDWORKS refused the combination" and
        /// "we never selected two things".</summary>
        static string SelectionSummary(IModelDoc2 doc)
        {
            try
            {
                ISelectionMgr mgr = (ISelectionMgr)doc.SelectionManager;
                int n = mgr.GetSelectedObjectCount2(-1);
                List<string> parts = new List<string>();
                for (int i = 1; i <= n; i++)
                {
                    object o = mgr.GetSelectedObject6(i, -1);
                    if (o is ISketchPoint) parts.Add("point");
                    else if (o is ISketchSegment) parts.Add("segment");
                    else if (o is IFace2) parts.Add("face");
                    else if (o is IFeature) parts.Add("feature");
                    else parts.Add(o == null ? "null" : "other");
                }
                return "[" + string.Join(",", parts.ToArray()) + "]";
            }
            catch (Exception) { return "?"; }
        }

        static int SelectedCount(IModelDoc2 doc)
        {
            try { return ((ISelectionMgr)doc.SelectionManager).GetSelectedObjectCount2(-1); }
            catch (Exception) { return -1; }
        }

        static IDisplayDimension CreateDisplay(IModelDoc2 doc, string normalized, double[] atMm,
            List<string> notes)
        {
            try
            {
                if (normalized == "diameter")
                    return doc.AddDiameterDimension2(atMm[0] * 0.001, atMm[1] * 0.001, 0) as IDisplayDimension;
                if (normalized == "radius")
                    return doc.AddRadialDimension2(atMm[0] * 0.001, atMm[1] * 0.001, 0) as IDisplayDimension;
                return doc.AddDimension2(atMm[0] * 0.001, atMm[1] * 0.001, 0) as IDisplayDimension;
            }
            catch (COMException ex)
            {
                notes.Add("dimension creation threw COM 0x" + ex.HResult.ToString("X8") + ": " + ex.Message);
                return null;
            }
        }

        /// <summary>Placement for a two-entity dimension: halfway between the two
        /// anchors. Placing it next to the first entity put the text inside one of the
        /// circles, and SOLIDWORKS refused the dimension; the midpoint is empty space
        /// between the two entities, which is where a person would place it too.</summary>
        static double[] PlacementBetween(object a, object b, string kind)
        {
            double[] pa = AnchorMm(a);
            double[] pb = AnchorMm(b);
            double offset = string.Equals(kind, "angle", StringComparison.OrdinalIgnoreCase) ? 20 : 5;
            return new double[] { (pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0 + offset };
        }

        static double[] AnchorMm(object entity)
        {
            ISketchPoint point = entity as ISketchPoint;
            if (point != null) return new double[] { point.X * 1000.0, point.Y * 1000.0 };
            ISketchSegment seg = entity as ISketchSegment;
            if (seg != null)
            {
                try
                {
                    int code = seg.GetType();
                    if (code == (int)swSketchSegments_e.swSketchARC)
                    {
                        ISketchPoint c = (ISketchPoint)((ISketchArc)seg).GetCenterPoint2();
                        if (c != null) return new double[] { c.X * 1000.0, c.Y * 1000.0 };
                    }
                    else if (code == (int)swSketchSegments_e.swSketchLINE)
                    {
                        ISketchLine line = (ISketchLine)seg;
                        ISketchPoint st = (ISketchPoint)line.GetStartPoint2();
                        ISketchPoint en = (ISketchPoint)line.GetEndPoint2();
                        if (st != null && en != null)
                            return new double[] { (st.X + en.X) / 2.0 * 1000.0,
                                                  (st.Y + en.Y) / 2.0 * 1000.0 };
                    }
                }
                catch (COMException) { }
            }
            return new double[] { 0, 0 };
        }

        /// <summary>The two circles whose centres are the given sketch points, or null
        /// when the entities are not exactly two centre points.</summary>
        static object[] CirclePairFor(ISketch sketch, object[] entities)
        {
            if (sketch == null || entities == null || entities.Length != 2) return null;
            ISketchPoint a = entities[0] as ISketchPoint;
            ISketchPoint b = entities[1] as ISketchPoint;
            if (a == null || b == null) return null;
            ISketchSegment ca = CircleAt(sketch, a);
            ISketchSegment cb = CircleAt(sketch, b);
            if (ca == null || cb == null) return null;
            return new object[] { ca, cb };
        }

        /// <summary>The arc/circle segment whose centre is the given sketch point.
        /// Compares metres with a 1 µm tolerance: this matches our own freshly drawn
        /// geometry, it is not a measurement.</summary>
        static ISketchSegment CircleAt(ISketch sketch, ISketchPoint point)
        {
            if (sketch == null || point == null) return null;
            object[] raw = null;
            try { raw = sketch.GetSketchSegments() as object[]; }
            catch (COMException) { return null; }
            if (raw == null) return null;
            double px = point.X;
            double py = point.Y;
            foreach (object item in raw)
            {
                ISketchSegment seg = item as ISketchSegment;
                if (seg == null) continue;
                int code;
                try { code = seg.GetType(); }
                catch (COMException) { continue; }
                if (code != (int)swSketchSegments_e.swSketchARC) continue;
                double[] c = CentreOf(seg);
                if (c == null) continue;
                if (Math.Abs(c[0] * 0.001 - px) + Math.Abs(c[1] * 0.001 - py) > 1e-6) continue;
                return seg;
            }
            return null;
        }

        static List<object> DimensionRows(IFeature feature, out List<IDisplayDimension> displays,
            List<string> notes)
        {
            List<object> rows = new List<object>();
            displays = new List<IDisplayDimension>();
            if (feature == null) return rows;
            object raw = null;
            try { raw = feature.GetFirstDisplayDimension(); }
            catch (COMException) { raw = null; }
            int guard = 0;
            int index = 0;
            while (raw != null && guard++ < 500)
            {
                object next = null;
                try { next = feature.GetNextDisplayDimension(raw); }
                catch (COMException) { }
                IDisplayDimension display = raw as IDisplayDimension;
                if (display != null)
                {
                    index++;
                    displays.Add(display);
                    IDimension dim = AsDimension(display);
                    Dictionary<string, object> row = Row(display, dim, index, IsAngle(display), notes);
                    rows.Add(row);
                }
                raw = next;
            }
            return rows;
        }

        static IDimension AsDimension(IDisplayDimension display)
        {
            if (display == null) return null;
            try { return display.GetDimension2(0) as IDimension; }
            catch (COMException) { }
            try { return display.GetDimension() as IDimension; }
            catch (COMException) { }
            return null;
        }

        static Dictionary<string, object> Row(IDisplayDimension display, IDimension dim, int index,
            bool angle, List<string> notes)
        {
            int type = -1;
            try { type = display.GetType(); }
            catch (COMException) { }
            string kind = KindOf(type);
            string name = null, fullName = null;
            if (dim != null)
            {
                try { name = dim.Name; }
                catch (COMException) { }
                try { fullName = dim.FullName; }
                catch (COMException) { }
            }
            if (name == null)
            {
                try { name = display.GetNameForSelection(); }
                catch (COMException) { }
            }
            bool reference = false;
            try { reference = display.IsReferenceDim(); }
            catch (COMException) { }
            return Json.Dict(
                "index", Json.R(index),
                "kind", kind,
                "type", kind,
                "displayType", Json.R(type),
                "name", name,
                "fullName", fullName,
                "valueMm", Json.R(ReadValue(dim, angle)),
                "value", Json.R(ReadValue(dim, angle)),
                "unit", angle ? "deg" : "mm",
                "reference", reference,
                "driving", !reference);
        }

        static string KindOf(int type)
        {
            switch ((swDimensionType_e)type)
            {
                case swDimensionType_e.swDiameterDimension: return "diameter";
                case swDimensionType_e.swRadialDimension: return "radius";
                case swDimensionType_e.swAngularDimension: return "angle";
                case swDimensionType_e.swLinearDimension:
                case swDimensionType_e.swHorLinearDimension:
                case swDimensionType_e.swVertLinearDimension:
                case swDimensionType_e.swScalarDimension: return "distance";
                default: return "other";
            }
        }

        static string NormalizeKind(string kind)
        {
            string k = (kind ?? "distance").ToLowerInvariant();
            if (k == "radial") return "radius";
            if (k == "diametric") return "diameter";
            if (k == "angular") return "angle";
            if (k == "linear") return "distance";
            if (k != "distance" && k != "diameter" && k != "radius" && k != "angle")
                throw new BridgeError("DIMENSION_CREATE_FAILED",
                    "dimension kind must be distance, diameter, radius or angle; got \"" + kind + "\"",
                    Json.Dict("kinds", Json.List("distance", "diameter", "radius", "angle")));
            return k;
        }

        static bool IsAngle(IDisplayDimension display)
        {
            try { return KindOf(display.GetType()) == "angle"; }
            catch (COMException) { return false; }
        }

        static double ReadValue(IDimension dim, bool angle)
        {
            if (dim == null) return 0;
            try { return angle ? dim.SystemValue * 180.0 / Math.PI : dim.SystemValue * 1000.0; }
            catch (COMException) { return 0; }
        }

        static void SetValue(IDimension dim, bool angle, double value, List<string> notes)
        {
            double target = angle ? value * Math.PI / 180.0 : value * 0.001;
            try
            {
                dim.SetSystemValue2(target, 0);
                return;
            }
            catch (COMException ex)
            {
                notes.Add("SetSystemValue2 failed (COM 0x" + ex.HResult.ToString("X8")
                    + "), trying the SystemValue property");
            }
            try { dim.SystemValue = target; }
            catch (COMException ex) { notes.Add("SystemValue setter failed: " + ex.Message); }
        }

        static bool SelectEntity(object entity, bool append)
        {
            ISketchPoint point = entity as ISketchPoint;
            if (point != null)
            {
                try { return point.Select2(append, 0); }
                catch (COMException) { }
                try { return point.Select4(append, null); }
                catch (COMException) { return false; }
            }
            ISketchSegment seg = entity as ISketchSegment;
            if (seg != null) return SelectSegment(seg, append);
            return false;
        }

        static double[] PlacementOf(object entity, string kind)
        {
            double x = 10, y = 10;
            ISketchPoint point = entity as ISketchPoint;
            if (point != null)
            {
                x = point.X * 1000.0;
                y = point.Y * 1000.0;
            }
            else
            {
                ISketchSegment seg = entity as ISketchSegment;
                if (seg != null)
                {
                    try
                    {
                        int code = seg.GetType();
                        if (code == (int)swSketchSegments_e.swSketchARC)
                        {
                            ISketchPoint c = (ISketchPoint)((ISketchArc)seg).GetCenterPoint2();
                            if (c != null) { x = c.X * 1000.0; y = c.Y * 1000.0; }
                        }
                        else if (code == (int)swSketchSegments_e.swSketchLINE)
                        {
                            ISketchLine line = (ISketchLine)seg;
                            ISketchPoint a = (ISketchPoint)line.GetStartPoint2();
                            ISketchPoint b = (ISketchPoint)line.GetEndPoint2();
                            if (a != null && b != null)
                            {
                                x = (a.X + b.X) / 2.0 * 1000.0;
                                y = (a.Y + b.Y) / 2.0 * 1000.0;
                            }
                        }
                    }
                    catch (COMException) { }
                }
            }
            double offset = string.Equals(kind, "angle", StringComparison.OrdinalIgnoreCase) ? 20 : 10;
            return new double[] { x + offset, y + offset };
        }

        /// <summary>Deletes the equation that drives this dimension, if any, and
        /// reports it for the caller's unbound[] list. A dimension with an equation
        /// cannot be deleted reliably; the caller must be able to tell that removing
        /// it also removed a parameter binding.</summary>
        static Dictionary<string, object> UnbindOne(IModelDoc2 doc, IDisplayDimension display, List<string> notes)
        {
            IDimension dim = AsDimension(display);
            if (dim == null) return null;
            string fullName = null;
            try { fullName = dim.FullName; } catch (COMException) { return null; }
            if (string.IsNullOrEmpty(fullName)) return null;
            IEquationMgr eq = null;
            try { eq = (IEquationMgr)doc.GetEquationMgr(); } catch (COMException) { return null; }
            if (eq == null) return null;
            int count = eq.GetCount();
            for (int i = 0; i < count; i++)
            {
                string text = null;
                try { text = eq.get_Equation(i); } catch (COMException) { }
                if (text == null) continue;
                int sign = text.IndexOf('=');
                if (sign <= 0) continue;
                if (!string.Equals(Unquoted(text.Substring(0, sign)), fullName, StringComparison.OrdinalIgnoreCase))
                    continue;
                string rhs = Unquoted(text.Substring(sign + 1));
                int rc = -1;
                try { rc = eq.Delete(i); }
                catch (COMException ex)
                {
                    notes.Add("unbind " + fullName + " Delete threw COM 0x" + ex.HResult.ToString("X8"));
                }
                notes.Add("unbind " + fullName + ": \"" + text + "\" -> Delete rc=" + rc);
                if (rc < 0) return null;
                return Json.Dict("param", dim.Name, "global", rhs, "dimension", fullName,
                    "equation", text, "rc", rc);
            }
            return null;
        }

        static string Unquoted(string s)
        {
            if (s == null) return null;
            s = s.Trim();
            if (s.Length >= 2 && s[0] == '"' && s[s.Length - 1] == '"') return s.Substring(1, s.Length - 2);
            return s;
        }

        /// <summary>Deletes one dimension and verifies the deletion by re-reading the
        /// sketch. Returns the removed row, or null when SOLIDWORKS still shows it.
        /// A dimension that cannot be selected is reported, never silently skipped.</summary>
        static Dictionary<string, object> RemoveOne(IModelDoc2 doc, IFeature feature,
            List<IDisplayDimension> displays, int index, List<string> notes)
        {
            IDisplayDimension display = displays[index - 1];
            IDimension dim = AsDimension(display);
            string shortName = null;
            try { shortName = dim == null ? null : dim.Name; }
            catch (COMException) { }
            if (shortName == null)
            {
                try { shortName = display.GetNameForSelection(); }
                catch (COMException) { }
            }
            bool angle = IsAngle(display);
            Dictionary<string, object> row = Row(display, dim, index, angle, notes);

            // 选择名要按 GetNameForSelection / FullName 取，不能只用 dim.Name：
            // 两条直径都命名成 hole.d 时，按短名 SelectByID2 一条也选不中
            // （实测「dimension 2 (\"hole.d\") could not be selected by name」，
            // 删除整批 0 条）。
            List<string> candidates = new List<string>();
            string selectionName = null;
            try { selectionName = display.GetNameForSelection(); }
            catch (COMException) { }
            if (!string.IsNullOrEmpty(selectionName)) candidates.Add(selectionName);
            string fullName = null;
            try { fullName = dim == null ? null : dim.FullName; }
            catch (COMException) { }
            if (!string.IsNullOrEmpty(fullName) && !candidates.Contains(fullName)) candidates.Add(fullName);
            if (!string.IsNullOrEmpty(shortName) && !candidates.Contains(shortName)) candidates.Add(shortName);
            if (candidates.Count == 0)
            {
                notes.Add("dimension " + index + " has no selection name");
                doc.ClearSelection2(true);
                return null;
            }

            doc.ClearSelection2(true);
            bool selected = false;
            string used = null;
            foreach (string candidate in candidates)
            {
                try { selected = doc.Extension.SelectByID2(candidate, "DIMENSION", 0, 0, 0, false, 0, null, 0); }
                catch (COMException ex) { notes.Add("SelectByID2 on \"" + candidate + "\" threw: " + ex.Message); }
                if (selected) { used = candidate; break; }
            }
            if (!selected)
            {
                notes.Add("dimension " + index + " (\"" + shortName + "\") could not be selected by name "
                    + "(tried: " + string.Join(", ", candidates.ToArray()) + ")");
                doc.ClearSelection2(true);
                return null;
            }
            try { doc.EditDelete(); }
            catch (COMException ex)
            {
                notes.Add("EditDelete threw COM 0x" + ex.HResult.ToString("X8") + ": " + ex.Message);
            }
            doc.ClearSelection2(true);

            List<IDisplayDimension> after;
            List<object> rows = DimensionRows(feature, out after, notes);
            if (after.Count >= displays.Count)
            {
                notes.Add("the dimension count did not drop after deletion (" + displays.Count
                    + " -> " + after.Count + "): SOLIDWORKS kept it");
                return null;
            }
            row["deleted"] = true;
            return row;
        }

        static List<int> Indices(Dictionary<string, object> req, List<object> items)
        {
            List<int> list = new List<int>();
            foreach (object raw in Json.Items(req.ContainsKey("relationIds") ? req["relationIds"] : null))
                AddIndex(list, raw);
            foreach (object raw in Json.Items(req.ContainsKey("indices") ? req["indices"] : null))
                AddIndex(list, raw);
            foreach (string key in new string[] { "index", "dimensionId" })
                if (req.ContainsKey(key)) AddIndex(list, req[key]);
            foreach (object raw in items)
            {
                Dictionary<string, object> spec = Json.Obj(raw);
                if (spec == null) continue;
                int index = Json.Int(spec, "index", 0);
                if (index > 0 && !list.Contains(index)) list.Add(index);
            }
            return list;
        }

        static void AddIndex(List<int> list, object raw)
        {
            if (raw == null) return;
            try
            {
                int index = Convert.ToInt32(raw);
                if (index > 0 && !list.Contains(index)) list.Add(index);
            }
            catch (Exception) { }
        }

        static double[] Position(Dictionary<string, object> spec)
        {
            Dictionary<string, object> pos = Json.Obj(spec.ContainsKey("position") ? spec["position"] : null);
            if (pos == null) return null;
            return new double[] { Json.Dbl(pos, "xMm", Json.Dbl(pos, "x", 0)),
                                  Json.Dbl(pos, "yMm", Json.Dbl(pos, "y", 0)) };
        }

        static List<string> RefTexts(Dictionary<string, object> spec)
        {
            List<string> refs = new List<string>();
            foreach (string key in new string[] { "refs", "entities" })
            {
                object raw = spec.ContainsKey(key) ? spec[key] : null;
                string single = raw as string;
                if (single != null) { refs.Add(single); continue; }
                foreach (object item in Json.Items(raw))
                {
                    string text = item as string;
                    if (text != null) { refs.Add(text); continue; }
                    Dictionary<string, object> row = Json.Obj(item);
                    string nested = row == null ? null : Json.Str(row, "ref", Json.Str(row, "id", null));
                    if (nested != null) refs.Add(nested);
                }
            }
            return refs;
        }

        /// <summary>Reads a COM array returned as VARIANT. Some accessors hand back a
        /// raw __ComObject instead of double[], so both the array cast and the
        /// IEnumerable path are tried before giving up.</summary>
        static double[] ToArray(object raw)
        {
            if (raw == null) return null;
            double[] direct = raw as double[];
            if (direct != null) return direct;
            IEnumerable seq = raw as IEnumerable;
            if (seq == null) return null;
            List<double> values = new List<double>();
            foreach (object o in seq)
            {
                try { values.Add(Convert.ToDouble(o, System.Globalization.CultureInfo.InvariantCulture)); }
                catch (Exception) { return null; }
            }
            return values.Count >= 3 ? values.ToArray() : null;
        }

        static bool SelectSegment(ISketchSegment seg, bool append)
        {
            if (seg == null) return false;
            try
            {
                return seg.Select2(append, 0);
            }
            catch (COMException)
            {
                return false;
            }
        }

        static IDisplayDimension AddDim(IModelDoc2 doc, ISketchSegment a, ISketchSegment b,
            double x, double y, double z)
        {
            doc.ClearSelection2(true);
            if (!SelectSegment(a, false)) return null;
            if (!SelectSegment(b, true)) return null;
            try
            {
                return (IDisplayDimension)doc.AddDimension2(x, y, z);
            }
            catch (COMException)
            {
                return null;
            }
        }

        static void MarkConstruction(ISketchSegment seg)
        {
            if (seg == null) return;
            try
            {
                seg.ConstructionGeometry = true;
            }
            catch (COMException) { }
        }

        static List<ISketchSegment> SegmentList(ISketch sketch)
        {
            List<ISketchSegment> list = new List<ISketchSegment>();
            ArrayList raw = Json.Arr(sketch.GetSketchSegments());
            if (raw == null) return list;
            foreach (object o in raw)
            {
                ISketchSegment s = o as ISketchSegment;
                if (s != null && s.GetType() == (int)swSketchSegments_e.swSketchLINE) list.Add(s);
            }
            return list;
        }

        /// <summary>Finds the leftmost, rightmost, topmost and bottommost lines of a
        /// rectangle profile from their midpoints, so the classification does not
        /// depend on creation order.</summary>
        static void Classify(List<ISketchSegment> lines,
            out ISketchSegment left, out ISketchSegment right,
            out ISketchSegment top, out ISketchSegment bottom)
        {
            left = right = top = bottom = null;
            double minX = double.MaxValue, maxX = double.MinValue;
            double minY = double.MaxValue, maxY = double.MinValue;

            foreach (ISketchSegment s in lines)
            {
                ISketchLine line = s as ISketchLine;
                if (line == null) continue;
                ISketchPoint p0 = (ISketchPoint)line.GetStartPoint2();
                ISketchPoint p1 = (ISketchPoint)line.GetEndPoint2();
                if (p0 == null || p1 == null) continue;
                double dx = Math.Abs(p1.X - p0.X);
                double dy = Math.Abs(p1.Y - p0.Y);
                double mx = (p0.X + p1.X) / 2.0;
                double my = (p0.Y + p1.Y) / 2.0;

                if (dy > dx)
                {
                    if (mx < minX) { minX = mx; left = s; }
                    if (mx > maxX) { maxX = mx; right = s; }
                }
                else
                {
                    if (my < minY) { minY = my; bottom = s; }
                    if (my > maxY) { maxY = my; top = s; }
                }
            }
        }
    }
}
