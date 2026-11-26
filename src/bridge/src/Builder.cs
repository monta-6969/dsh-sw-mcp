using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Builds a parametric part from a compiled design definition.
    ///
    /// Two invariants hold for every feature this class creates:
    ///  1. relations and dimensions live inside the sketch, so they survive after
    ///     the bridge exits and a human edits the model;
    ///  2. every feature is verified by re-measuring the body. SOLIDWORKS happily
    ///     returns a non-null feature that changes nothing, which is why "the call
    ///     succeeded" is never treated as "the geometry is right".</summary>
    sealed class Builder
    {
        readonly SwHost _host;
        readonly IModelDoc2 _doc;
        readonly ISketchManager _sk;
        readonly List<string> _steps = new List<string>();
        // 全局轴（x/y/z）每次构建只建一条参考轴，后面同一个方向复用。
        readonly Dictionary<string, IFeature> _globalAxes = new Dictionary<string, IFeature>();
        IFeature _lastSketch;

        public Builder(SwHost host, IModelDoc2 doc)
        {
            _host = host;
            _doc = doc;
            _sk = doc.SketchManager;
        }

        public List<string> Steps { get { return _steps; } }

        /// <summary>The sketch that produced the most recent feature. Callers bind
        /// profile dimensions (width, height, diameter) onto it; the extrusion
        /// feature itself only owns the depth.</summary>
        public IFeature LastSketch { get { return _lastSketch; } }

        // AddToDB stays false on purpose: with true the sketch arrives with zero
        // relations, and adding horizontal/vertical afterwards over-constrains it.
        // With false SOLIDWORKS supplies its own relations and our explicit
        // dimensions land on top of them.
        void Begin()
        {
            _sk.AddToDB = false;
        }

        // ------------------------------------------------------------------ base

        /// <summary>Centered rectangle extruded symmetrically about the plane, so a
        /// later thickness change moves both faces instead of growing one way.
        /// The verified combination is Sd=false with both D1 and D2 set; Sd=true
        /// extrudes only one side and silently halves the body.</summary>
        public IFeature BasePlate(int planeOrdinal, double widthMm, double heightMm, double thicknessMm)
        {
            IFeature plane = SwHost.RefPlane(_doc, planeOrdinal);
            if (plane == null)
                throw new BridgeError("NO_REF_PLANE",
                    "reference plane ordinal " + planeOrdinal + " not found in this template");

            _doc.ClearSelection2(true);
            plane.Select2(false, 0);
            Begin();
            _sk.InsertSketch(true);

            _sk.CreateCenterRectangle(0, 0, 0,
                SwHost.ToMeters(widthMm / 2.0), SwHost.ToMeters(heightMm / 2.0), 0);
            ISketch plateSketch = (ISketch)((IFeature)_doc.GetActiveSketch()).GetSpecificFeature2();
            List<IDisplayDimension> plateDims =
                SketchDimensioner.Rectify(_doc, plateSketch, _sk, widthMm, heightMm);
            MarkSketch("BasePlate sketch");
            _sk.InsertSketch(true);

            double half = SwHost.ToMeters(thicknessMm / 2.0);
            IFeature feature = _doc.FeatureManager.FeatureExtrusion3(
                false, false, true,
                (int)swEndConditions_e.swEndCondBlind, (int)swEndConditions_e.swEndCondBlind,
                half, half,
                false, false, false, false, 0, 0,
                false, false, false, false,
                true, false, true,
                0, 0, false);

            if (feature == null)
                throw new BridgeError("EXTRUDE_FAILED", "base plate extrusion returned no feature").At(LastStep());
            _plateDims = plateDims;
            VerifyGrowth("BasePlate", 0);
            _steps.Add("BasePlate " + feature.Name);
            return feature;
        }

        List<ISketchArc> _holeArcs;
        List<ISketchArc> _holeArcsForPosition;
        IList<double[]> _holeCentres;
        List<IDisplayDimension> _holeOffsetDims;
        IDisplayDimension _holePairDim;
        double[] _holePosition;

        /// <summary>Supplies [plateWidth, plateHeight, edgeDistance] so the hole
        /// sketch can constrain itself symmetrically while it is still open.</summary>
        public void SetHolePosition(double widthMm, double heightMm, double edgeMm)
        {
            _holePosition = new double[] { widthMm, heightMm, edgeMm };
        }

        /// <summary>Offset dimensions placed inside the hole sketch, in
        /// [x, y] order. They must be created while the sketch is open: selecting
        /// sketch points and adding dimensions fails once the sketch is closed.</summary>
        public List<IDisplayDimension> HoleOffsetDimensions { get { return _holeOffsetDims; } }

        /// <summary>Native centre-distance dimension of a two-hole group, or null when
        /// the group is not a pair. Compiler binds it to the pitch parameter.</summary>
        public IDisplayDimension HolePairDimension { get { return _holePairDim; } }

        /// <summary>The circle objects created for the most recent hole sketch, in
        /// creation order. Needed to add symmetry relations to their centres.</summary>
        public List<ISketchArc> HoleArcs { get { return _holeArcs; } }

        List<IDisplayDimension> _plateDims;
        List<IDisplayDimension> _bossDims;
        List<IDisplayDimension> _holeDims;

        /// <summary>Native profile dimensions for the most recent plate sketch, in
        /// [width, height] order.</summary>
        public List<IDisplayDimension> PlateDimensions { get { return _plateDims; } }

        /// <summary>Native diameter dimension for the most recent boss sketch.</summary>
        public List<IDisplayDimension> BossDimensions { get { return _bossDims; } }

        /// <summary>Native diameter dimensions for the most recent hole sketch, one
        /// per circle, in creation order.</summary>
        public List<IDisplayDimension> HoleDimensions { get { return _holeDims; } }

        // ------------------------------------------------------------------- boss

        /// <summary>Boss on a planar face. The sketch sits on the face and the
        /// extrusion runs inward, which is what puts the boss on the outside while
        /// keeping the support relation intact.</summary>
        public IFeature Boss(Func<IFace2> pickFace, double diameterMm, double heightMm)
        {
            return ExtrudeWithVerifiedDirection("Boss", pickFace, delegate(IFace2 face, bool dir)
            {
                Begin();
                _sk.InsertSketch(true);
                _sk.CreateCircle(0, 0, 0, SwHost.ToMeters(diameterMm / 2.0), 0, 0);
                ISketch bossSketch = (ISketch)((IFeature)_doc.GetActiveSketch()).GetSpecificFeature2();
                _bossDims = SketchDimensioner.DimensionCircles(_doc, bossSketch, diameterMm,
                    new List<double[]> { new double[] { 0, 0 } }, _steps);
                MarkSketch("Boss sketch");
                _sk.InsertSketch(true);

                return _doc.FeatureManager.FeatureExtrusion3(
                    true, false, dir,
                    (int)swEndConditions_e.swEndCondBlind, (int)swEndConditions_e.swEndCondBlind,
                    SwHost.ToMeters(heightMm), 0,
                    false, false, false, false, 0, 0,
                    false, false, false, false,
                    true, false, true,
                    0, 0, false);
            });
        }

        // ------------------------------------------------------------------ holes

        /// <summary>Holes as circles inside one sketch, each carrying its own
        /// diameter dimension, because sgEQUAL does not propagate a change and a
        /// single dimension would move exactly one hole.</summary>
        public IFeature Holes(Func<IFace2> pickFace, IList<double[]> centresMm, double diameterMm,
            bool throughAll, double depthMm)
        {
            _holeCentres = centresMm;
            _holePairDim = null;
            _holeOffsetDims = null;
            return ExtrudeWithVerifiedDirection("Holes", pickFace, delegate(IFace2 face, bool dir)
            {
                Begin();
                _sk.InsertSketch(true);
                double r = SwHost.ToMeters(diameterMm / 2.0);
                List<ISketchArc> arcs = new List<ISketchArc>();
                foreach (double[] c in centresMm)
                {
                    ISketchSegment seg = _sk.CreateCircle(SwHost.ToMeters(c[0]), SwHost.ToMeters(c[1]), 0,
                        SwHost.ToMeters(c[0]) + r, SwHost.ToMeters(c[1]), 0);
                    ISketchArc arc = seg as ISketchArc;
                    if (arc != null) arcs.Add(arc);
                }
                _holeArcs = arcs;
                _holeArcsForPosition = arcs;
                ISketch holeSketch = (ISketch)((IFeature)_doc.GetActiveSketch()).GetSpecificFeature2();
                _holeDims = SketchDimensioner.DimensionCircles(_doc, holeSketch, diameterMm, centresMm, _steps);
                _holePairDim = null;
                if (centresMm.Count == 2)
                    // 两孔：一条两圆心中心距就是它的定义尺寸（4 孔那套半距偏置表达不了）。
                    _holePairDim = SketchDimensioner.PositionHolePair(_doc, holeSketch, arcs,
                        centresMm, _steps);
                else if (_holePosition != null)
                    _holeOffsetDims = SketchDimensioner.PositionHoles(_doc, _sk, arcs,
                        _holePosition[0], _holePosition[1], _holePosition[2], _steps);
                MarkSketch("Holes sketch");
                _sk.InsertSketch(true);

                return _doc.FeatureManager.FeatureCut4(
                    true, false, dir,
                    throughAll ? (int)swEndConditions_e.swEndCondThroughAll : (int)swEndConditions_e.swEndCondBlind,
                    (int)swEndConditions_e.swEndCondBlind,
                    SwHost.ToMeters(depthMm), 0,
                    false, false, false, false, 0, 0,
                    false, false, false, false,
                    false, true, true,
                    false, true, false,
                    (int)swStartConditions_e.swStartSketchPlane, 0, false, false);
            });
        }

        /// <summary>Holes sketched on a reference plane instead of a picked face.
        ///
        /// A two-hole pair must lie on the axis the design names. The picked face's
        /// sketch frame need not match the design plane (u/v can be swapped), and a
        /// symmetric 4-hole group hides that — a pair does not: the circles land on the
        /// short edge and FeatureCut4 returns null. Sketching on the design plane keeps
        /// the coordinates the caller wrote, and the cut goes through both directions
        /// because the plane usually sits inside the material.</summary>
        public IFeature HolesOnPlane(int planeOrdinal, IList<double[]> centresMm, double diameterMm,
            bool throughAll, double depthMm)
        {
            IFeature plane = SwHost.RefPlane(_doc, planeOrdinal);
            if (plane == null)
                throw new BridgeError("NO_REF_PLANE",
                    "reference plane ordinal " + planeOrdinal + " not found in this template");
            _doc.ClearSelection2(true);
            plane.Select2(false, 0);
            Begin();
            _sk.InsertSketch(true);

            double r = SwHost.ToMeters(diameterMm / 2.0);
            List<ISketchArc> arcs = new List<ISketchArc>();
            foreach (double[] c in centresMm)
            {
                ISketchSegment seg = _sk.CreateCircle(SwHost.ToMeters(c[0]), SwHost.ToMeters(c[1]), 0,
                    SwHost.ToMeters(c[0]) + r, SwHost.ToMeters(c[1]), 0);
                ISketchArc arc = seg as ISketchArc;
                if (arc != null) arcs.Add(arc);
            }
            _holeArcs = arcs;
            _holeArcsForPosition = arcs;
            _holePairDim = null;
            _holeOffsetDims = null;
            ISketch holeSketch = (ISketch)((IFeature)_doc.GetActiveSketch()).GetSpecificFeature2();
            _holeDims = SketchDimensioner.DimensionCircles(_doc, holeSketch, diameterMm, centresMm, _steps);
            if (centresMm.Count == 2)
                _holePairDim = SketchDimensioner.PositionHolePair(_doc, holeSketch, arcs, centresMm, _steps);
            else if (_holePosition != null)
                _holeOffsetDims = SketchDimensioner.PositionHoles(_doc, _sk, arcs,
                    _holePosition[0], _holePosition[1], _holePosition[2], _steps);

            IFeature sketchFeature = (IFeature)_doc.GetActiveSketch();
            MarkSketch("Holes sketch");
            _sk.InsertSketch(true);
            IFeature feat = ExtrudeSketch(sketchFeature, depthMm, false, false, true, throughAll, 0, true);
            _steps.Add("HolesOnPlane plane=" + planeOrdinal + " -> "
                + (feat == null ? "NULL" : feat.Name));
            return feat;
        }

        // ---------------------------------------------------------------- fillets
        /// <summary>Constant-radius fillets on every vertical edge lying on the
        /// body's bottom (or top) face. Edges are chosen geometrically, so a rebuild
        /// or a rename cannot invalidate the selection.</summary>
        public IFeature FilletVerticalEdges(double radiusMm, bool onBottom)
        {
            IBody2 body = Geometry.LargestBody(_doc);
            Array edges = (Array)body.GetEdges();
            if (edges == null || edges.Length == 0)
                throw new BridgeError("NO_EDGE", "body has no edges to fillet");

            double targetZ = onBottom ? double.MaxValue : double.MinValue;
            bool found = false;
            for (int i = 0; i < edges.Length; i++)
            {
                IEdge e = (IEdge)edges.GetValue(i);
                if (!IsVertical(e)) continue;
                double z = StartZ(e);
                if (onBottom ? z < targetZ : z > targetZ) { targetZ = z; found = true; }
            }
            if (!found)
                throw new BridgeError("NO_EDGE", "no vertical edge found on this body");

            double before = Geometry.TotalVolumeMm3(_doc);

            _doc.ClearSelection2(true);
            int count = 0;
            for (int i = 0; i < edges.Length; i++)
            {
                IEdge e = (IEdge)edges.GetValue(i);
                if (!IsVertical(e)) continue;
                if (Math.Abs(StartZ(e) - targetZ) * 1000.0 > 0.01) continue;
                if (count == 0) { if (SelectEntity(e, false)) count++; }
                else if (SelectEntity(e, true)) count++;
            }
            if (count == 0)
                throw new BridgeError("NO_EDGE", "vertical edges at the target face were not selectable");

            object raw = _doc.FeatureManager.FeatureFillet3(195, SwHost.ToMeters(radiusMm), 0, 0, 0, 0, 0,
                null, null, null, null, null, null, null);
            IFeature fillet = raw as IFeature;
            if (fillet == null)
                throw new BridgeError("FILLET_FAILED",
                    "fillet returned no feature; radius " + radiusMm + " mm may exceed what these "
                    + count + " edges allow").At(LastStep());

            double after = Geometry.TotalVolumeMm3(_doc);
            if (Math.Abs(after - before) < 1e-6)
                throw new BridgeError("FILLET_NO_CHANGE",
                    "fillet returned feature \"" + fillet.Name + "\" but the volume did not change ("
                    + before.ToString("F3") + " mm3); treat this as a failure, not a success").At(LastStep());

            _steps.Add("Fillet " + fillet.Name + " (" + count + " edges, volume "
                + before.ToString("F2") + " -> " + after.ToString("F2") + ")");
            return fillet;
        }

        /// <summary>Fillets the circular edges of radius <paramref name="diameterMm"/>/2
        /// that lie at height <paramref name="atYmm"/>.
        ///
        /// Why this exists: a slot's mouth is bounded by straight edges and one
        /// semicircular arc, and the drawing asks for the round on the arc only. The
        /// arc is picked by measuring the circle it lies on rather than by remembering
        /// an edge index, so a rebuild that renumbers edges cannot silently fillet the
        /// wrong thing: three points are sampled off the curve and the circumradius is
        /// compared with the requested diameter.
        ///
        /// The fillet itself goes through the same FeatureFillet3 call as
        /// FilletVerticalEdges (options 195 measured to work on this build), and it is
        /// only reported as applied when the volume actually moved.</summary>
        public IFeature FilletCircularEdgesAtHeight(double diameterMm, double atYmm, double toleranceMm)
        {
            IBody2 body = Geometry.LargestBody(_doc);
            Array edges = (Array)body.GetEdges();
            if (edges == null || edges.Length == 0)
                throw new BridgeError("NO_EDGE", "body has no edges to fillet");

            double targetY = atYmm;
            double targetR = diameterMm / 2.0;
            double tol = toleranceMm;

            double before = Geometry.TotalVolumeMm3(_doc);

            _doc.ClearSelection2(true);
            int count = 0;
            for (int i = 0; i < edges.Length; i++)
            {
                IEdge e = (IEdge)edges.GetValue(i);
                double radius, y;
                if (!CircleThrough(e, out radius, out y)) continue;
                if (Math.Abs(y - targetY) > tol) continue;
                if (Math.Abs(radius - targetR) > tol) continue;
                if (SelectEntity(e, count > 0)) count++;
            }
            if (count == 0)
                throw new BridgeError("NO_EDGE",
                    "no circular edge of diameter " + diameterMm.ToString("F2") + " mm lies at "
                    + atYmm.ToString("F2") + " mm; nothing was selected for the fillet").At(LastStep());

            object raw = _doc.FeatureManager.FeatureFillet3(195, SwHost.ToMeters(targetR), 0, 0, 0, 0, 0,
                null, null, null, null, null, null, null);
            IFeature fillet = raw as IFeature;
            if (fillet == null)
                throw new BridgeError("FILLET_FAILED",
                    "fillet returned no feature on " + count + " circular edges (radius "
                    + (diameterMm / 2.0).ToString("F2") + " mm may be too large for this wall)").At(LastStep());

            double after = Geometry.TotalVolumeMm3(_doc);
            if (Math.Abs(after - before) < 1e-6)
                throw new BridgeError("FILLET_NO_CHANGE",
                    "fillet returned feature \"" + fillet.Name + "\" but the volume did not change ("
                    + before.ToString("F3") + " mm3); treat this as a failure, not a success").At(LastStep());

            _steps.Add("Fillet " + fillet.Name + " (" + count + " circular edges, volume "
                + before.ToString("F2") + " -> " + after.ToString("F2") + ")");
            return fillet;
        }

        /// <summary>Circumradius and height of the circle an edge lies on, or false
        /// when the edge is not an arc.</summary>
        static bool CircleThrough(IEdge e, out double radiusMm, out double yMm)
        {
            radiusMm = 0;
            yMm = 0;
            try
            {
                ICurve curve = e.GetCurve() as ICurve;
                if (curve == null || !curve.IsCircle()) return false;

                double t0, t1;
                bool closed, periodic;
                if (!curve.GetEndParams(out t0, out t1, out closed, out periodic)) return false;

                double[] a = (double[])curve.Evaluate(t0);
                double[] b = (double[])curve.Evaluate((t0 + t1) / 2.0);
                double[] c = (double[])curve.Evaluate(t1);
                if (a == null || b == null || c == null) return false;

                double radius = Circumradius(a, b, c);
                if (radius <= 0) return false;
                radiusMm = radius * 1000.0;
                yMm = b[1] * 1000.0;
                return true;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>Radius of the circle through three 3D points (0 when they are
        /// collinear, which is what a straight edge degenerates to).</summary>
        static double Circumradius(double[] a, double[] b, double[] c)
        {
            double ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
            double bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
            double cx = ay * bz - az * by;
            double cy = az * bx - ax * bz;
            double cz = ax * by - ay * bx;
            double area2 = Math.Sqrt(cx * cx + cy * cy + cz * cz);
            if (area2 < 1e-18) return 0;
            double la = Math.Sqrt(ax * ax + ay * ay + az * az);
            double lb = Math.Sqrt(bx * bx + by * by + bz * bz);
            double lc = Math.Sqrt((c[0] - b[0]) * (c[0] - b[0]) + (c[1] - b[1]) * (c[1] - b[1])
                + (c[2] - b[2]) * (c[2] - b[2]));
            return la * lb * lc / (2.0 * area2);
        }

        // --------------------------------------------------------------- verified

        /// <summary>Runs a sketch+extrude/cut attempt with a candidate direction,
        /// measures the body, and retries with the other direction if the feature
        /// came back null or the volume did not move.
        ///
        /// The working direction depends on the sketch-plane normal, not on a flag's
        /// meaning, so it is discovered rather than assumed: measured on a top-face
        /// sketch, a boss needs dir=false and a through cut also needs dir=false,
        /// while dir=true produces a boss that returns a feature and changes nothing.
        ///
        /// The face is re-picked before every attempt, because undoing a failed
        /// attempt destroys the sketch and leaves the previously captured face
        /// pointer dangling.</summary>
        IFeature ExtrudeWithVerifiedDirection(string what, Func<IFace2> pickFace,
            Func<IFace2, bool, IFeature> attempt)
        {
            double before = Geometry.TotalVolumeMm3(_doc);

            IFace2 face = pickFace();
            if (face == null)
                throw new BridgeError("NO_FACE", what + ": support face was not found");

            IFeature feature = null;
            bool[] candidates = new bool[] { false, true };
            List<string> tried = new List<string>();

            foreach (bool dir in candidates)
            {
                _doc.ClearSelection2(true);
                SelectEntity(face, false);
                feature = attempt(face, dir);
                double after = Geometry.TotalVolumeMm3(_doc);
                bool moved = Math.Abs(after - before) > 1e-9;
                _steps.Add("try " + what + " dir=" + dir + " feature="
                    + (feature == null ? "null" : feature.Name)
                    + " volume " + before.ToString("F2") + " -> " + after.ToString("F2")
                    + " sketchReused=" + (feature == null ? "?" : "n/a"));

                if (feature != null && moved)
                {
                    _steps.Add(what + " accepted dir=" + dir);
                    return feature;
                }

                tried.Add("dir=" + dir + (feature == null ? " -> null feature" : " -> no volume change"));
                _doc.ClearSelection2(true);
                _doc.EditUndo2(1);
                face = pickFace();      // the undo invalidated the previous face
                if (face == null) break;
            }

            throw new BridgeError(what == "Holes" ? "CUT_FAILED" : "EXTRUDE_FAILED",
                what + " failed in both directions (" + string.Join("; ", tried.ToArray())
                + "). Volume stayed at " + before.ToString("F2") + " mm3.").At(LastStep());
        }

        // ------------------------------------------------- generic sketch features

        /// <summary>Extrudes or cuts whatever sketch is currently selected.
        ///
        /// This is the general path the declarative profile compiler uses; the
        /// named builders below it (BasePlate, Boss, Holes) are sugar over the same
        /// FeatureExtrusion3/FeatureCut4 calls. Both signatures are the ones
        /// verified on this SOLIDWORKS build: 23 arguments for the boss/extrude and
        /// 27 for the cut, with angular values in radians.</summary>
        public IFeature ExtrudeSketch(IFeature sketch, double depthMm, bool symmetric,
            bool reverse, bool cut, bool throughAll, double draftDeg)
        {
            return ExtrudeSketch(sketch, depthMm, symmetric, reverse, cut, throughAll, draftDeg, false);
        }

        /// <summary>Same, with the option of cutting through the body in both
        /// directions. A sketch drawn on a plane that sits inside the material — the
        /// front plane of a plate, say — only removes half a body under plain
        /// through-all; swEndCondThroughAllBoth (9) is the one-direction-free version.</summary>
        public IFeature ExtrudeSketch(IFeature sketch, double depthMm, bool symmetric,
            bool reverse, bool cut, bool throughAll, double draftDeg, bool throughAllBoth)
        {
            return ExtrudeSketch(sketch, depthMm, symmetric, reverse, cut, throughAll, draftDeg,
                throughAllBoth, 0);
        }

        /// <summary>Same, but the extrusion starts <paramref name="startOffsetMm"/> away
        /// from the sketch plane.
        ///
        /// Without this, a feature sitting on top of another one (a pad on a plate) needs
        /// a whole extra reference plane just to be sketched on — and that plane then
        /// shows up as orange wireframe in every screenshot.</summary>
        public IFeature ExtrudeSketch(IFeature sketch, double depthMm, bool symmetric,
            bool reverse, bool cut, bool throughAll, double draftDeg, bool throughAllBoth,
            double startOffsetMm)
        {
            return ExtrudeSketch(sketch, depthMm, symmetric, reverse, cut, throughAll, draftDeg,
                throughAllBoth, startOffsetMm, false);
        }

        /// <summary>Same, and tells the cut path whether <paramref name="reverse"/> came
        /// from the caller's explicit world-axis request.
        ///
        /// When it did, the cut must not be silently flipped to the other side just
        /// because that side happens to remove material too: a mirrored cut still
        /// changes the volume, so the old "did the volume move?" test could not tell
        /// the requested cut from its mirror image.</summary>
        public IFeature ExtrudeSketch(IFeature sketch, double depthMm, bool symmetric,
            bool reverse, bool cut, bool throughAll, double draftDeg, bool throughAllBoth,
            double startOffsetMm, bool directionExplicit)
        {
            return ExtrudeSketch(sketch, depthMm, symmetric, reverse, cut, throughAll, draftDeg,
                throughAllBoth, startOffsetMm, directionExplicit, true);
        }

        /// <summary>merge=false 时新拉伸的实体不与已有实体合并 —— 多实体零件必须走这条
        /// （两个相交轮廓画在同一草图里是「非简单区域」，SOLIDWORKS 直接拒绝拉伸，
        /// 报 null；正确做法是两个草图 + 第二次拉伸 merge:false）。</summary>
        public IFeature ExtrudeSketch(IFeature sketch, double depthMm, bool symmetric,
            bool reverse, bool cut, bool throughAll, double draftDeg, bool throughAllBoth,
            double startOffsetMm, bool directionExplicit, bool merge)
        {
            if (sketch == null) throw new BridgeError("NO_SKETCH", "no profile sketch to extrude");
            if (cut) return CutSketch(sketch, depthMm, throughAll, reverse, throughAllBoth,
                startOffsetMm, directionExplicit);

            SelectSketch(sketch);

            double depth = SwHost.ToMeters(depthMm);
            double d1 = symmetric ? depth / 2.0 : depth;
            double d2 = symmetric ? depth / 2.0 : 0;
            int end = throughAll
                ? (int)swEndConditions_e.swEndCondThroughAll
                : (int)swEndConditions_e.swEndCondBlind;
            double draft = draftDeg * Math.PI / 180.0;

            // Sd (single direction) decides which pair of dimensions is live. A
            // symmetric extrude needs Sd=false with both D1 and D2 set to half the
            // thickness; a one-sided extrude needs Sd=true with D1 only. Mixing them
            // up makes FeatureExtrusion3 return null without an error — symmetric
            // worked, every blind extrude failed, until this was split.
            bool single = !symmetric;
            // Flip (the 2nd argument) does nothing in this build: asking for the
            // reverse side of the top plane still extruded downwards. Dir (3rd) is
            // the argument that actually decides the side, so "reverse" moves there
            // and Flip stays false.
            double beforeVolume = SafeVolume();
            // 拔模角只有在 Dchk1/Dchk2（「允许方向 1/2 拔模」）为 true 时才生效。
            // 之前这两个开关写死 false，draft=10° 的形状与 draft=0 逐位相同（同一个
            // Ø10×20 圆柱 1570.7963 mm³），调用方拿到的仍是 ok —— 参数被吃掉却不报错。
            bool draftOn = Math.Abs(draftDeg) > 1e-9;
            IFeature feature = _doc.FeatureManager.FeatureExtrusion3(
                single, false, !reverse,
                end, (int)swEndConditions_e.swEndCondBlind,
                d1, d2,
                draftOn, draftOn, false, false, draft, draftOn && symmetric ? draft : 0,
                false, false, false, false,
                merge, false, true,
                startOffsetMm == 0 ? 0 : (int)swStartConditions_e.swStartOffset,
                SwHost.ToMeters(startOffsetMm), false);
            _steps.Add("genericExtrude depth=" + depthMm + " symmetric=" + symmetric
                + " merge=" + merge
                + " -> " + (feature == null ? "NULL" : feature.Name));
            if (feature == null)
                throw new BridgeError("EXTRUDE_FAILED",
                    "FeatureExtrusion3 returned null for this profile (depth " + depthMm + " mm, merge=" + merge + ")"
                    + "；最可能的原因：轮廓自交或两个轮廓重叠成一个非简单区域（同一草图里画两个相交矩形/圆就是这种），"
                    + "其次是开放轮廓、或轮廓完全落在草图平面外。多实体请分两个草图、第二次拉伸用 merge:false。");

            VerifyChanged("Extrude", beforeVolume);
            return feature;
        }

        /// <summary>Selects a sketch feature for a feature operation, and says so when
        /// the selection did not take.
        ///
        /// Selecting the feature object works in most cases, but a sketch that was
        /// just closed can still be bound to an object that no longer accepts
        /// Select2; the name-based path picks up the live one.</summary>
        void SelectSketch(IFeature sketch)
        {
            _doc.ClearSelection2(true);
            bool selected = false;
            try { selected = sketch.Select2(false, 0); }
            catch (COMException) { }
            if (!selected)
            {
                string name = sketch.Name;
                selected = _doc.Extension.SelectByID2(name, "SKETCH", 0, 0, 0, false, 0, null, 0);
                _steps.Add("selectSketch byName " + name + " -> " + selected);
            }
            if (!selected)
                throw new BridgeError("SKETCH_NOT_SELECTED",
                    "could not select sketch \"" + sketch.Name + "\" to build on");
        }

        /// <summary>Cuts the selected profile out of the solid.
        ///
        /// This is deliberately not "the extrusion call with cut=true". A cut needs
        /// Sd=true, the sketch-plane start condition and AutoSelectComponents, or
        /// SOLIDWORKS returns null without an error — the combination is the one
        /// the hole builder has been using, which is why holes work and a naive
        /// cut does not. Direction is verified against the volume instead of being
        /// assumed: the same sketch cuts into the material or away from it
        /// depending on which side the face normal points.</summary>
        IFeature CutSketch(IFeature sketch, double depthMm, bool throughAll, bool reverse)
        {
            return CutSketch(sketch, depthMm, throughAll, reverse, false);
        }

        IFeature CutSketch(IFeature sketch, double depthMm, bool throughAll, bool reverse,
            bool throughAllBoth)
        {
            return CutSketch(sketch, depthMm, throughAll, reverse, throughAllBoth, 0, false);
        }

        /// <summary>Cuts, honouring a start offset and an explicit direction.
        ///
        /// Two things used to be lost here. The start offset never reached
        /// FeatureCut4 (it always started on the sketch plane), and the direction
        /// was chosen by trying both sides and keeping whichever changed the volume —
        /// which cannot distinguish a cut from its mirror image because both remove
        /// material. Now the requested side is authoritative whenever the caller gave
        /// a world axis, and the opposite side is only tried when the side is unknown
        /// (no "direction" in the design).</summary>
        IFeature CutSketch(IFeature sketch, double depthMm, bool throughAll, bool reverse,
            bool throughAllBoth, double startOffsetMm, bool directionExplicit)
        {
            double before = Geometry.TotalVolumeMm3(_doc);
            List<string> tried = new List<string>();
            bool[] candidates = directionExplicit
                ? new bool[] { reverse }
                : (reverse ? new bool[] { true, false } : new bool[] { false, true });
            int t0 = startOffsetMm != 0
                ? (int)swStartConditions_e.swStartOffset
                : (int)swStartConditions_e.swStartSketchPlane;

            foreach (bool dir in candidates)
            {
                SelectSketch(sketch);
                // Sd (first argument) is "single direction". With Sd=true only T1 is
                // consulted, so a through-all-both cut silently removes one half —
                // measured on a 44 mm web: 795 mm2 of profile removed 17490 mm3,
                // exactly 795 x 22. Both directions need Sd=false.
                IFeature feature = _doc.FeatureManager.FeatureCut4(
                    !throughAllBoth, false, dir,
                    throughAll
                        ? (int)swEndConditions_e.swEndCondThroughAll
                        : (int)swEndConditions_e.swEndCondBlind,
                    throughAllBoth
                        ? (int)swEndConditions_e.swEndCondThroughAll
                        : (int)swEndConditions_e.swEndCondBlind,
                    SwHost.ToMeters(depthMm), 0,
                    false, false, false, false, 0, 0,
                    false, false, false, false,
                    false, true, true,
                    false, true, false,
                    t0, SwHost.ToMeters(startOffsetMm), false, false);

                double after = Geometry.TotalVolumeMm3(_doc);
                _steps.Add("genericCut dir=" + dir + " startOffset=" + startOffsetMm
                    + " t0=" + t0 + " feature="
                    + (feature == null ? "null" : feature.Name)
                    + " volume " + before.ToString("F2") + " -> " + after.ToString("F2"));

                if (feature != null && Math.Abs(after - before) > 1e-9)
                {
                    _steps.Add("genericCut accepted dir=" + dir);
                    return feature;
                }
                tried.Add("dir=" + dir + (feature == null ? " -> null feature" : " -> no volume change"));
                if (feature != null) _doc.EditUndo2(1);
            }

            throw new BridgeError("CUT_FAILED",
                "FeatureCut4 removed nothing (dir candidates " + candidates.Length
                + ", startOffset " + startOffsetMm + " mm; " + string.Join("; ", tried.ToArray())
                + "). Volume stayed at " + before.ToString("F2") + " mm3.");
        }

        /// <summary>Revolves the selected sketch about an axis that lives in it.
        ///
        /// The axis mark is not documented consistently: some samples select the
        /// construction line with mark 0, others with mark 4. Rather than guess, try
        /// both and keep the one that produced a feature.</summary>
        public IFeature RevolveSketch(IFeature sketch, double angleDeg, bool cut, string axisName)
        {
            if (sketch == null) throw new BridgeError("NO_SKETCH", "no profile sketch to revolve");
            string axis = (axisName ?? "centerline").Trim().ToLowerInvariant();
            if (axis != "centerline")
            {
                IFeature axisFeature = GlobalAxis(axis);
                _doc.ClearSelection2(true);
                sketch.Select2(false, 0);
                // 参考轴放进选集后按 mark 4 尝试，与中心线的两种 mark 约定一致：
                // FeatureRevolve2 只认「草图 + 轴」这个组合，mark 值随版本不同。
                foreach (int mark in new[] { 0, 4 })
                {
                    _doc.ClearSelection2(true);
                    sketch.Select2(false, 0);
                    axisFeature.Select2(true, mark);
                    IFeature made = RevolveOnce(angleDeg, cut);
                    if (made != null)
                    {
                        _steps.Add("revolve about global " + axis + " via " + axisFeature.Name);
                        VerifyGrowth(cut ? "RevolveCut" : "Revolve", 0);
                        return made;
                    }
                }
                throw new BridgeError("REVOLVE_FAILED",
                    "FeatureRevolve2 returned null about the explicit \"" + axis + "\" axis (" + axisFeature.Name
                    + "); the profile has to lie entirely on one side of that axis");
            }

            ISketchSegment axisSeg = FindCenterline(sketch);
            int[] marks = new[] { 0, 4 };
            foreach (int mark in marks)
            {
                _doc.ClearSelection2(true);
                sketch.Select2(false, 0);
                if (axisSeg != null) axisSeg.Select2(true, mark);

                IFeature feature = RevolveOnce(angleDeg, cut);
                _steps.Add("genericRevolve axisMark=" + mark + " angle=" + angleDeg
                    + " -> " + (feature == null ? "NULL" : feature.Name));
                if (feature != null)
                {
                    VerifyGrowth(cut ? "RevolveCut" : "Revolve", 0);
                    return feature;
                }
            }
            throw new BridgeError("REVOLVE_FAILED",
                "FeatureRevolve2 returned null with both axis selection marks; the profile "
                + "must lie entirely on one side of its centreline. To revolve about a global "
                + "axis pass axis=\"x\" / \"y\" / \"z\" and leave the sketch without a centreline.");
        }

        IFeature RevolveOnce(double angleDeg, bool cut)
        {
            return _doc.FeatureManager.FeatureRevolve2(
                true, true, false, cut, false, false,
                (int)swEndConditions_e.swEndCondBlind, (int)swEndConditions_e.swEndCondBlind,
                angleDeg * Math.PI / 180.0, 0,
                false, false, 0, 0,
                (int)swThinWallType_e.swThinWallOneDirection, 0, 0,
                true, true, true);
        }

        /// <summary>Creates (once per build) a reference axis for a global direction.
        ///
        /// 全局轴不是可选实体：X/Y/Z 是默认基准面两两相交的线。以前 revolve 只认
        /// 「草图里的构造线」，于是 axis="z" 这种请求看起来被接受、实际绕的是草图
        /// 里的那条线（或者干脆失败）。现在按 axis 建一条真的参考轴，选择它再转。</summary>
        IFeature GlobalAxis(string axis)
        {
            if (axis != "x" && axis != "y" && axis != "z")
                throw new BridgeError("UNSUPPORTED_PARAM",
                    "revolve axis=\"" + axis + "\" is not supported; use centerline, x, y or z",
                    Json.Dict("param", "axis", "value", axis, "supported", Json.List("centerline", "x", "y", "z")));
            if (_globalAxes.ContainsKey(axis)) return _globalAxes[axis];

            // 默认基准面序号：0=前视(XY) 1=上视(XZ) 2=右视(YZ)。
            // X = 前视∩上视，Y = 前视∩右视，Z = 上视∩右视。
            int[] pair = axis == "x" ? new[] { 0, 1 } : axis == "y" ? new[] { 0, 2 } : new[] { 1, 2 };
            IFeature first = SwHost.RefPlane(_doc, pair[0]);
            IFeature second = SwHost.RefPlane(_doc, pair[1]);
            if (first == null || second == null)
                throw new BridgeError("NO_REF_PLANE",
                    "cannot build the global " + axis + " axis: default reference planes "
                    + pair[0] + "/" + pair[1] + " are missing from this template");
            _doc.ClearSelection2(true);
            first.Select2(false, 0);
            second.Select2(true, 0);
            // InsertAxis2 在 IModelDoc2 上（IFeatureManager 没有这个成员），返回 bool：
            // 选中「两个平面」之后它建一条参考轴特征，名字要从特征树里取回来。
            int before = SwHost.Features(_doc).Count;
            bool madeAxis = _doc.InsertAxis2(true);
            if (!madeAxis)
                throw new BridgeError("AXIS_CREATE_FAILED",
                    "InsertAxis2 returned false for the intersection of planes "
                    + pair[0] + " and " + pair[1] + "; select exactly two planes first");
            List<IFeature> after = SwHost.Features(_doc);
            IFeature created = after.Count > before ? after[after.Count - 1] : null;
            if (created == null)
                throw new BridgeError("AXIS_CREATE_FAILED", "the axis feature was not added to the tree");
            _steps.Add("global axis " + axis + " -> " + created.Name);
            _globalAxes[axis] = created;
            return created;
        }

        static ISketchSegment FindCenterline(IFeature sketchFeature)
        {
            ISketch sketch = sketchFeature == null ? null : (ISketch)sketchFeature.GetSpecificFeature2();
            if (sketch == null) return null;
            object[] segments = sketch.GetSketchSegments() as object[];
            if (segments == null) return null;
            foreach (object raw in segments)
            {
                ISketchSegment seg = raw as ISketchSegment;
                if (seg == null) continue;
                bool construction = false;
                try { construction = seg.ConstructionGeometry; }
                catch (COMException) { }
                if (construction) return seg;
            }
            return null;
        }

        void VerifyGrowth(string what, double expectedDeltaMm3)
        {
            double after = Geometry.TotalVolumeMm3(_doc);
            if (after <= 0)
                throw new BridgeError("EMPTY_BODY", what + " produced no solid volume").At(LastStep());
        }

        /// <summary>Volume of the current body, or 0 when there is none yet.
        ///
        /// The first feature of a part has nothing to measure against, and calling
        /// SingleBody on an empty document throws — the check below is meant to catch
        /// "the feature ran but changed nothing", not to police an empty model.</summary>
        double SafeVolume()
        {
            try
            {
                return Geometry.TotalVolumeMm3(_doc);
            }
            catch (BridgeError)
            {
                return 0;
            }
        }

        /// <summary>Fails when a feature reports success but the model did not change.
        ///
        /// This is the single most expensive class of bug in this bridge: a profile that
        /// lands entirely inside existing material (or a cut that passes through empty
        /// space) returns a feature object, produces no geometry, and every later
        /// measurement then blames the wrong feature. A gusset that was swallowed by the
        /// rib next to it stayed invisible for hours because nothing checked this.</summary>
        void VerifyChanged(string what, double beforeMm3)
        {
            double after = Geometry.TotalVolumeMm3(_doc);
            if (Math.Abs(after - beforeMm3) <= 1e-6)
                throw new BridgeError("FEATURE_CHANGED_NOTHING",
                    what + " returned a feature but the volume did not move ("
                    + beforeMm3.ToString("F3") + " mm3 before and after). Either the profile "
                    + "sits entirely inside existing material, passes through empty space, or "
                    + "the sketch never reached the model — treat this as a failure, not a "
                    + "success.").At(LastStep());
            _steps.Add(what + " volume " + beforeMm3.ToString("F2") + " -> "
                + after.ToString("F2") + " mm3");
        }

        // --------------------------------------------------------------- helpers

        bool SelectEntity(object entity)
        {
            return SelectEntity(entity, false);
        }

        /// <summary>Selects with an explicit append flag. Passing false for every
        /// edge silently reduced a four-edge fillet to a one-edge fillet, so the
        /// append decision is never implicit.</summary>
        bool SelectEntity(object entity, bool append)
        {
            IEntity ent = entity as IEntity;
            if (ent == null) return false;
            try
            {
                return ent.Select4(append, null);
            }
            catch (COMException)
            {
                return false;
            }
        }

        void MarkSketch(string what)
        {
            IFeature sketch = (IFeature)_doc.GetActiveSketch();
            if (sketch == null) return;
            _lastSketch = sketch;
            ISketch obj = (ISketch)sketch.GetSpecificFeature2();
            if (obj == null) return;
            _steps.Add(what + " constraintStatus=" + obj.GetConstrainedStatus());
        }

        // ------------------------------------------------------------ sketch only

        /// <summary>Builds one sketch from a plan and reports what actually landed.
        ///
        /// The plan carries the same curve specs Profiles.Create accepts, plus the
        /// three things a picture needs to become a design:
        ///   * inline <c>relations</c> that name curves by their <c>id</c>
        ///     (<c>"arc1:center"</c>, <c>"arc2"</c>) — resolved to the real COM
        ///     entities Create produced, applied through Relations.Apply, and audited
        ///     afterwards with the same seg:&lt;index&gt; grammar the relations op uses;
        ///   * inline <c>dimensions</c> ({kind, refs, valueMm, name}) placed with
        ///     SketchDimensioner.AddOne;
        ///   * construction curves and construction points.
        ///
        /// A relation that does not land is fatal here: the half-made sketch feature is
        /// deleted and RELATION_APPLY_FAILED is thrown. A sketch-only build that keeps
        /// the sketch but reports "some relations were rejected" is exactly the state
        /// the hook profile got stuck in.</summary>
        public Dictionary<string, object> BuildSketch(Dictionary<string, object> plan, string defaultId,
            Func<object, double> resolve, bool strictRelations)
        {
            if (plan == null) throw new BridgeError("BAD_ARGUMENT", "sketch plan is missing");
            string id = Json.Str(plan, "id", Json.Str(plan, "name", defaultId));
            List<string> notes = new List<string>();

            Dictionary<string, object> spec = NormalizePlan(plan);
            Curves.BeginCapture();
            // 自动推断：界面里画一条线落在已有端点上，SOLIDWORKS 自己会给一条重合
            // 关系；API 造几何默认不推断，于是「端点坐标相同」只是碰巧对齐，草图里
            // 一条关系都没有。真机实测 SketchAddConstraints("sgCOINCIDENT") 对两个
            // 草图点加不出关系（AddRelation 更是直接 COM 0x80010105），所以闭合轮廓
            // 的重合关系只能靠这条原生推断路。它只影响本张草图的几何创建。
            bool inferenceWas = false;
            try { inferenceWas = _sk.AutoInference; } catch (COMException) { }
            if (!inferenceWas)
            {
                try { _sk.AutoInference = true; } catch (COMException) { }
                notes.Add("sketch auto-inference on: endpoints that land on existing geometry get their native relation");
            }
            ProfileResult pr;
            List<CurveResult> captured;
            try
            {
                pr = Profiles.Create(_host, _doc, _sk, spec, resolve);
            }
            finally
            {
                if (!inferenceWas)
                {
                    try { _sk.AutoInference = false; } catch (COMException) { }
                }
                captured = Curves.EndCapture();
            }

            IFeature feature = (IFeature)_doc.GetActiveSketch();
            ISketch sketch = feature == null ? null : (ISketch)feature.GetSpecificFeature2();
            if (sketch == null)
                throw new BridgeError("SKETCH_NOT_CREATED",
                    "sketch " + id + " produced no open sketch — the plane it asked for "
                    + "probably never became the active plane");

            Dictionary<string, CurveResult> byId = new Dictionary<string, CurveResult>(StringComparer.OrdinalIgnoreCase);
            foreach (CurveResult cr in captured)
            {
                if (string.IsNullOrEmpty(cr.Id)) continue;
                CurveResult existing;
                if (byId.TryGetValue(cr.Id, out existing))
                    notes.Add("curve id \"" + cr.Id + "\" was declared twice; the relation resolver uses the last one");
                byId[cr.Id] = cr;
            }

            IFeature created = pr.SketchFeature == null ? feature : pr.SketchFeature;

            // relations/dimensions 只在草图仍处于编辑态时才写得进去。这段逻辑必须与
            // Compiler.SketchFromSpec（内联 profile 上的 relations/dimensions）共用
            // 同一份：分开写两份的话，一处拒绝参考尺寸、另一处静默接受，而两处都报 ok。
            PlanDetails details;
            try
            {
                details = ApplyPlanDetails(created, sketch, plan, byId, id, notes);
                sketch = details.Sketch;
            }
            catch (BridgeError)
            {
                RollbackSketch(created, notes);
                throw;
            }
            catch (Exception ex)
            {
                RollbackSketch(created, notes);
                throw new BridgeError("SKETCH_DETAILS_FAILED",
                    "sketch \"" + id + "\" could not be completed and was rolled back: " + ex.Message,
                    Json.Dict("sketch", id, "notes", notes, "inner", ex.GetType().Name));
            }

            Profiles.Close(_doc, _sk, pr);
            created = pr.SketchFeature == null ? created : pr.SketchFeature;
            if (created != null && !string.IsNullOrEmpty(id))
            {
                try { if (created.Name != id) created.Name = id; }
                catch (Exception ex) { notes.Add(id + ": kept its default name (" + ex.Message + ")"); }
            }

            Dictionary<string, object> shape = Profiles.Describe(created);
            int openEnds = shape.ContainsKey("openEnds") ? Convert.ToInt32(shape["openEnds"]) : 0;
            bool closed = shape.ContainsKey("closed") && Convert.ToBoolean(shape["closed"]);
            List<object> segmentRows = SegmentRows(sketch);
            int constrained = Relations.ConstraintStatus(sketch);
            Dictionary<string, object> audit = Relations.Audit(sketch,
                created == null ? id : created.Name, details.Required, strictRelations);

            List<object> readbacks = new List<object>();
            foreach (CurveResult cr in captured)
                if (cr.Readback != null) readbacks.Add(cr.Readback);
            foreach (string note in pr.Notes) if (!notes.Contains(note)) notes.Add(note);

            return Json.Dict(
                "name", id,
                "sketch", created == null ? id : created.Name,
                "feature", created == null ? null : created.Name,
                "closed", closed,
                "openEnds", Json.R(openEnds),
                "segments", segmentRows,
                "segmentCount", segmentRows.Count,
                "relations", Relations.Rows(sketch),
                "relationCount", Relations.Rows(sketch).Count,
                "constrainedStatus", Json.R(constrained),
                "fullyConstrained", constrained == 0,
                "relationAudit", audit,
                "applied", details.Applied,
                "rejected", details.Rejected,
                "dimensions", details.Dimensions,
                "curveReadbacks", readbacks,
                "notes", notes);
        }

        /// <summary>What applying a plan's inline relations and dimensions produced.
        /// <see cref="Named"/> is how a caller binds an inline dimension
        /// (<c>{"name":"hole.pitch"}</c>) to the design parameter of the same name:
        /// the live display dimension is handed over instead of being re-resolved by
        /// name, which is unreliable across a feature rename.</summary>
        public sealed class PlanDetails
        {
            public ISketch Sketch;
            public List<object> Applied = new List<object>();
            public List<object> Rejected = new List<object>();
            public List<Dictionary<string, object>> Required = new List<Dictionary<string, object>>();
            public List<object> Dimensions = new List<object>();
            public Dictionary<string, IDisplayDimension> Named =
                new Dictionary<string, IDisplayDimension>(StringComparer.OrdinalIgnoreCase);
        }

        /// <summary>Applies a plan's inline relations, then its inline dimensions, to
        /// a sketch that is still open. Shared by Builder.BuildSketch and
        /// Compiler.SketchFromSpec; the caller closes the sketch afterwards.
        ///
        /// A dimension that comes back as a reference dimension is fatal here. It
        /// reads back fine but cannot drive the model, and accepting it is exactly how
        /// a build used to report "3 dimensions" while nothing followed a parameter
        /// (IsReferenceDim=true was silently ignored on the build path).</summary>
        public PlanDetails ApplyPlanDetails(IFeature created, ISketch sketch,
            Dictionary<string, object> plan, Dictionary<string, CurveResult> byId,
            string id, List<string> notes)
        {
            PlanDetails details = new PlanDetails();
            details.Sketch = sketch;
            if (plan == null) return details;

            // 关系只能写进一张「正在编辑」的草图：真机实测里，草图关闭后
            // SketchRelationManager.AddRelation 返回 null（不报错），草图处于编辑态但
            // 拿的是旧代理时直接 COM 0x80010105。写关系前先确认活动草图就是这一张，
            // 不是就重新进入编辑态，并把这件事记进 notes（失败时要能看出是哪一种）。
            {
                IFeature activeNow = (IFeature)_doc.GetActiveSketch();
                bool isActive = activeNow != null && created != null
                    && string.Equals(activeNow.Name, created.Name, StringComparison.OrdinalIgnoreCase);
                string relationPhase = "relations: activeSketch="
                    + (activeNow == null ? "null" : activeNow.Name)
                    + " target=" + (created == null ? "null" : created.Name)
                    + " active=" + isActive;
                if (!isActive && created != null)
                {
                    try
                    {
                        _doc.ClearSelection2(true);
                        if (created.Select2(false, 0))
                        {
                            _doc.EditSketch();
                            IFeature reopened = (IFeature)_doc.GetActiveSketch();
                            if (reopened != null && (ISketch)reopened.GetSpecificFeature2() != null)
                            {
                                details.Sketch = (ISketch)reopened.GetSpecificFeature2();
                                relationPhase += "; reopened=" + reopened.Name;
                            }
                            else relationPhase += "; reopen failed (no active sketch)";
                        }
                        else relationPhase += "; reopen failed (feature not selectable)";
                    }
                    catch (Exception ex)
                    {
                        relationPhase += "; reopen threw " + ex.GetType().Name + ": " + ex.Message;
                    }
                }
                notes.Add(relationPhase);
            }

            foreach (object raw in Json.Items(plan.ContainsKey("relations") ? plan["relations"] : null))
            {
                Dictionary<string, object> rel = Json.Obj(raw);
                Dictionary<string, object> row = AddPlanRelation(details.Sketch, byId, rel,
                    details.Required, notes);
                if (Convert.ToBoolean(row["ok"])) details.Applied.Add(row);
                else
                {
                    details.Rejected.Add(row);
                    throw new BridgeError("RELATION_APPLY_FAILED",
                        "relation " + Convert.ToString(row["type"]) + " on "
                        + string.Join(", ", PlanRefs(Json.Obj(rel)).ToArray())
                        + " could not be applied to sketch \"" + id + "\": " + Convert.ToString(row["error"]),
                        Json.Dict("sketch", id, "applied", details.Applied,
                            "rejected", details.Rejected, "notes", notes));
                }
            }

            foreach (object raw in Json.Items(plan.ContainsKey("dimensions") ? plan["dimensions"] : null))
            {
                Dictionary<string, object> d = Json.Obj(raw);
                if (d == null) continue;
                List<object> com = new List<object>();
                string why;
                if (!ResolvePlanRefs(byId, d, out com, out why))
                    throw new BridgeError("DIMENSION_CREATE_FAILED",
                        "dimension references a curve that is not in this sketch: " + why,
                        Json.Dict("sketch", id, "dimension", d));
                string kind = Json.Str(d, "kind", Json.Str(d, "type", "distance"));
                double value = Json.Dbl(d, "valueMm", Json.Dbl(d, "value", 0));
                string dimName = Json.Str(d, "name", null);
                double[] at = null;
                Dictionary<string, object> pos = Json.Obj(d.ContainsKey("position") ? d["position"] : null);
                if (pos != null)
                    at = new double[] { Json.Dbl(pos, "xMm", Json.Dbl(pos, "x", 0)),
                                        Json.Dbl(pos, "yMm", Json.Dbl(pos, "y", 0)) };
                IDisplayDimension display;
                Dictionary<string, object> row = SketchDimensioner.AddOne(_doc, details.Sketch, kind,
                    com.ToArray(), value, dimName, at, notes, out display);
                List<string> refs = PlanRefs(d);
                row["refs"] = refs;

                bool reference = false;
                try { reference = display != null && display.IsReferenceDim(); }
                catch (COMException) { }
                if (reference)
                    throw new BridgeError("DIMENSION_NOT_DRIVING",
                        "dimension \"" + (dimName ?? kind) + "\" on " + string.Join(", ", refs.ToArray())
                        + " in sketch \"" + id + "\" came back as a reference dimension "
                        + "(IsReferenceDim=true): it can be read but it cannot drive the model, "
                        + "so it is not accepted as built",
                        Json.Dict("sketch", id, "refs", refs, "name", dimName, "kind", kind,
                            "valueMm", Json.R(value),
                            "reason", "IsReferenceDim=true right after creation; the sketch was not "
                                + "in edit mode, or the relation that would define this value is missing"));

                details.Dimensions.Add(row);
                if (!string.IsNullOrEmpty(dimName) && display != null)
                {
                    IDisplayDimension previous;
                    if (details.Named.TryGetValue(dimName, out previous) && previous != null)
                        notes.Add("dimension name \"" + dimName + "\" is declared twice; the last one is bound");
                    details.Named[dimName] = display;
                }
            }
            return details;
        }

        /// <summary>Copy of the plan with every curve entry normalised to "kind"
        /// (accepting "type" as an alias) and every construction point moved out of
        /// "primitives" — Profiles.Create's primitive switch only knows legacy shapes
        /// and curve kinds, not the point.</summary>
        static Dictionary<string, object> NormalizePlan(Dictionary<string, object> plan)
        {
            Dictionary<string, object> spec = new Dictionary<string, object>();
            foreach (KeyValuePair<string, object> kv in plan) spec[kv.Key] = kv.Value;

            List<object> curves = new List<object>();
            foreach (object raw in Json.Items(plan.ContainsKey("curves") ? plan["curves"] : null))
            {
                Dictionary<string, object> normalized = NormalizeCurve(raw);
                if (normalized != null) curves.Add(normalized);
            }
            List<object> primitives = new List<object>();
            foreach (object raw in Json.Items(plan.ContainsKey("primitives") ? plan["primitives"] : null))
            {
                Dictionary<string, object> entry = Json.Obj(raw);
                string kind = entry == null ? null : Json.Str(entry, "kind", Json.Str(entry, "type", null));
                if (kind != null && (Contracts.IsCurveKind(kind) || IsPointKind(kind)))
                {
                    Dictionary<string, object> normalized = NormalizeCurve(raw);
                    if (normalized != null) curves.Add(normalized);
                }
                else primitives.Add(raw);
            }
            spec["curves"] = curves;
            spec["primitives"] = primitives;
            return spec;
        }

        static Dictionary<string, object> NormalizeCurve(object raw)
        {
            Dictionary<string, object> entry = Json.Obj(raw);
            if (entry == null) return null;
            Dictionary<string, object> copy = new Dictionary<string, object>();
            foreach (KeyValuePair<string, object> kv in entry) copy[kv.Key] = kv.Value;
            if (!copy.ContainsKey("kind") || copy["kind"] == null)
            {
                string type = Json.Str(copy, "type", null);
                if (type != null) copy["kind"] = type;
            }
            return copy;
        }

        static bool IsPointKind(string kind)
        {
            return string.Equals(kind, "point", StringComparison.OrdinalIgnoreCase)
                || string.Equals(kind, "constructionPoint", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Resolves one inline relation through the curve map and applies it.
        /// The required row is recorded in seg&lt;index&gt; form so Relations.Audit can
        /// compare it against what the sketch carries.</summary>
        Dictionary<string, object> AddPlanRelation(ISketch sketch, Dictionary<string, CurveResult> byId,
            Dictionary<string, object> rel, List<Dictionary<string, object>> required, List<string> notes)
        {
            string typeName = Json.Str(rel, "type", Json.Str(rel, "relation", null));
            List<string> refs = PlanRefs(rel);
            Dictionary<string, object> row = Json.Dict("type", typeName, "refs", refs);
            List<object> com = new List<object>();
            string why;
            if (!ResolvePlanRefs(byId, rel, out com, out why))
            {
                row["ok"] = false;
                row["error"] = why;
                row["code"] = "RELATION_APPLY_FAILED";
                return row;
            }
            Relations.RelationOutcome outcome = Relations.Apply(_doc, sketch, typeName, com.ToArray(), false);
            row["ok"] = outcome.Ok;
            row["fallback"] = outcome.ViaFallback;
            if (!outcome.Ok)
            {
                row["error"] = outcome.Why;
                row["code"] = "RELATION_APPLY_FAILED";
                return row;
            }
            List<string> canonical = new List<string>();
            foreach (object entity in com)
            {
                Dictionary<string, object> described = Relations.Describe(sketch, entity);
                string reference = described.ContainsKey("ref") && described["ref"] is string
                    ? (string)described["ref"] : null;
                if (!string.IsNullOrEmpty(reference)) canonical.Add(reference);
            }
            row["entities"] = canonical;
            if (canonical.Count != com.Count)
                notes.Add("relation " + typeName + ": only " + canonical.Count + " of " + com.Count
                    + " entities could be named for the audit");
            required.Add(Json.Dict("type", typeName, "refs", canonical));
            if (outcome.ViaFallback)
                notes.Add("relation " + typeName + " on " + string.Join(",", canonical.ToArray())
                    + " was applied through the sketch-point fallback");
            return row;
        }

        static List<string> PlanRefs(Dictionary<string, object> spec)
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
                    if (text != null) refs.Add(text);
                    else
                    {
                        Dictionary<string, object> row = Json.Obj(item);
                        string nested = row == null ? null : Json.Str(row, "ref", Json.Str(row, "id", null));
                        if (nested != null) refs.Add(nested);
                    }
                }
            }
            return refs;
        }

        static bool ResolvePlanRefs(Dictionary<string, CurveResult> byId, Dictionary<string, object> spec,
            out List<object> com, out string error)
        {
            com = new List<object>();
            error = null;
            List<string> refs = PlanRefs(spec);
            if (refs.Count == 0)
            {
                error = "the entry has no refs; name curves by id (\"arc1\", \"arc1:center\")";
                return false;
            }
            foreach (string text in refs)
            {
                object entity;
                string why;
                if (!Relations.TryCurveEntity(byId, text, out entity, out why))
                {
                    error = why;
                    return false;
                }
                com.Add(entity);
            }
            return true;
        }

        /// <summary>Deletes a half-built sketch feature. The sketch is closed first
        /// only when it is still the active sketch, because InsertSketch is a toggle
        /// and calling it on a closed sketch would open a new one.</summary>
        public void RollbackSketch(IFeature feature, List<string> notes)
        {
            try
            {
                IFeature active = (IFeature)_doc.GetActiveSketch();
                if (active != null && feature != null && active.Name == feature.Name)
                    _sk.InsertSketch(true);
            }
            catch (COMException) { }
            if (feature == null)
            {
                notes.Add("the failed sketch produced no feature to delete");
                return;
            }
            try
            {
                _doc.ClearSelection2(true);
                if (!feature.Select2(false, 0))
                {
                    notes.Add("could not select the failed sketch feature for rollback");
                    return;
                }
                _doc.EditDelete();
                notes.Add("deleted the failed sketch feature " + feature.Name);
            }
            catch (COMException ex)
            {
                notes.Add("could not delete the failed sketch feature: " + ex.Message);
            }
        }

        static List<object> SegmentRows(ISketch sketch)
        {
            List<object> rows = new List<object>();
            if (sketch == null) return rows;
            object[] raw = null;
            try { raw = (object[])sketch.GetSketchSegments(); }
            catch (COMException) { }
            if (raw == null) return rows;
            int index = 0;
            foreach (object item in raw)
            {
                ISketchSegment seg = item as ISketchSegment;
                if (seg == null) continue;
                index++;
                Dictionary<string, object> row = Curves.Readback(seg);
                row["index"] = Json.R(index);
                rows.Add(row);
            }
            return rows;
        }

        /// <summary>Pure plan validation: no SOLIDWORKS, no COM. This is what
        /// build(validate:true) and the Node test suite run.</summary>
        public static Dictionary<string, object> ValidatePlan(Dictionary<string, object> definition,
            Dictionary<string, object> req)
        {
            List<object> errors = new List<object>();
            List<object> sketchRows = new List<object>();
            List<object> relationRows = new List<object>();
            List<object> dimensionRows = new List<object>();
            List<object> notes = new List<object>();
            if (definition == null)
            {
                errors.Add(PlanError("MISSING_DEFINITION", "build needs a \"definition\" object", "definition", 0));
                return PlanResult(errors, sketchRows, relationRows, dimensionRows, notes);
            }
            string output = Json.Str(definition, "output", Json.Str(req, "output", "part"));
            List<object> plans = SketchPlans(definition);
            if (plans.Count == 0)
                errors.Add(PlanError("MISSING_SKETCH_PLAN",
                    "no sketch plan found in \"sketch\", \"sketches\" or a feature with kind \"sketch\"",
                    "definition", 0));

            int planIndex = 0;
            foreach (object raw in plans)
            {
                planIndex++;
                Dictionary<string, object> plan = Json.Obj(raw);
                if (plan == null) continue;
                string id = Json.Str(plan, "id", Json.Str(plan, "name", "sketch" + planIndex));
                bool hasPlane = plan.ContainsKey("plane") || plan.ContainsKey("face");
                if (!hasPlane)
                    errors.Add(PlanError("MISSING_SKETCH_PLANE",
                        "sketch \"" + id + "\" needs \"plane\" (ordinal or name) or \"face\"",
                        id, planIndex));

                Dictionary<string, string> declaredIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                int curveIndex = 0;
                foreach (object curveRaw in Json.Items(plan.ContainsKey("curves") ? plan["curves"] : null))
                {
                    curveIndex++;
                    Dictionary<string, object> curve = NormalizeCurve(curveRaw);
                    if (curve == null) continue;
                    string kind = Json.Str(curve, "kind", null);
                    string curveId = Json.Str(curve, "id", null);
                    if (kind == null)
                        errors.Add(PlanError("MISSING_CURVE_KIND",
                            "curve #" + curveIndex + " in sketch \"" + id + "\" has no kind", id, curveIndex));
                    else if (!Contracts.IsCurveKind(kind) && !IsPointKind(kind))
                        errors.Add(PlanError("UNKNOWN_CURVE_KIND",
                            "curve #" + curveIndex + " in sketch \"" + id + "\" has unknown kind \"" + kind + "\"",
                            id, curveIndex));
                    if (string.IsNullOrEmpty(curveId))
                        errors.Add(PlanError("MISSING_CURVE_ID",
                            "curve #" + curveIndex + " in sketch \"" + id + "\" has no id; inline relations "
                            + "can only name curves by id", id, curveIndex));
                    else if (declaredIds.ContainsKey(curveId))
                        errors.Add(PlanError("DUPLICATE_CURVE_ID",
                            "curve id \"" + curveId + "\" is declared twice in sketch \"" + id + "\"", id, curveIndex));
                    else declaredIds[curveId] = kind;
                    CheckCurveFields(curve, kind, id, curveIndex, errors);
                }

                int relationIndex = 0;
                foreach (object relRaw in Json.Items(plan.ContainsKey("relations") ? plan["relations"] : null))
                {
                    relationIndex++;
                    Dictionary<string, object> rel = Json.Obj(relRaw);
                    if (rel == null) continue;
                    string type = Json.Str(rel, "type", Json.Str(rel, "relation", null));
                    Dictionary<string, object> row = Json.Dict("sketch", id, "index", Json.R(relationIndex), "type", type);
                    if (type == null || !Relations.IsKnownRelationType(type))
                    {
                        errors.Add(PlanError("UNKNOWN_RELATION_TYPE",
                            "relation #" + relationIndex + " in sketch \"" + id + "\" has unknown type \""
                            + Convert.ToString(type) + "\"; known: " + Relations.KnownTypes(), id, relationIndex));
                        row["valid"] = false;
                        relationRows.Add(row);
                        continue;
                    }
                    List<string> refs = PlanRefs(rel);
                    row["refs"] = refs;
                    bool ok = refs.Count > 0;
                    List<string> problems = new List<string>();
                    if (refs.Count == 0) problems.Add("no refs");
                    foreach (string text in refs)
                    {
                        string curveId;
                        string why;
                        if (!PlanCurveId(text, out curveId, out why))
                        {
                            ok = false;
                            problems.Add(why);
                            continue;
                        }
                        if (!declaredIds.ContainsKey(curveId))
                        {
                            ok = false;
                            problems.Add("ref \"" + text + "\" names curve \"" + curveId
                                + "\", which this sketch does not declare");
                        }
                    }
                    row["valid"] = ok;
                    if (!ok) row["error"] = string.Join("; ", problems.ToArray());
                    relationRows.Add(row);
                    if (!ok)
                        errors.Add(PlanError("BAD_RELATION_REF",
                            "relation #" + relationIndex + " in sketch \"" + id + "\": "
                            + string.Join("; ", problems.ToArray()), id, relationIndex));
                }

                int dimensionIndex = 0;
                foreach (object dimRaw in Json.Items(plan.ContainsKey("dimensions") ? plan["dimensions"] : null))
                {
                    dimensionIndex++;
                    Dictionary<string, object> dim = Json.Obj(dimRaw);
                    if (dim == null) continue;
                    string kind = Json.Str(dim, "kind", Json.Str(dim, "type", "distance"));
                    Dictionary<string, object> row = Json.Dict("sketch", id, "index", Json.R(dimensionIndex),
                        "kind", kind);
                    bool ok = true;
                    List<string> problems = new List<string>();
                    if (!IsDimensionKind(kind))
                    {
                        ok = false;
                        problems.Add("kind must be distance, diameter, radius or angle");
                    }
                    List<string> refs = PlanRefs(dim);
                    row["refs"] = refs;
                    if (refs.Count == 0) { ok = false; problems.Add("no refs"); }
                    foreach (string text in refs)
                    {
                        string curveId;
                        string why;
                        if (!PlanCurveId(text, out curveId, out why)) { ok = false; problems.Add(why); continue; }
                        if (!declaredIds.ContainsKey(curveId))
                        {
                            ok = false;
                            problems.Add("ref \"" + text + "\" names curve \"" + curveId
                                + "\", which this sketch does not declare");
                        }
                    }
                    if (!dim.ContainsKey("valueMm") && !dim.ContainsKey("value"))
                    {
                        ok = false;
                        problems.Add("missing valueMm");
                    }
                    row["valid"] = ok;
                    if (!ok) row["error"] = string.Join("; ", problems.ToArray());
                    dimensionRows.Add(row);
                    if (!ok)
                        errors.Add(PlanError("BAD_DIMENSION", "dimension #" + dimensionIndex
                            + " in sketch \"" + id + "\": " + string.Join("; ", problems.ToArray()), id, dimensionIndex));
                }

                sketchRows.Add(Json.Dict("sketch", id, "curves", declaredIds.Count,
                    "relations", relationRows.Count, "dimensions", dimensionRows.Count,
                    "construction", CountConstruction(plan)));
            }

            Dictionary<string, object> result = PlanResult(errors, sketchRows, relationRows, dimensionRows, notes);
            result["output"] = output;
            return result;
        }

        static bool IsDimensionKind(string kind)
        {
            return string.Equals(kind, "distance", StringComparison.OrdinalIgnoreCase)
                || string.Equals(kind, "diameter", StringComparison.OrdinalIgnoreCase)
                || string.Equals(kind, "radius", StringComparison.OrdinalIgnoreCase)
                || string.Equals(kind, "angle", StringComparison.OrdinalIgnoreCase);
        }

        static void CheckCurveFields(Dictionary<string, object> curve, string kind, string sketchId,
            int index, List<object> errors)
        {
            string label = "curve #" + index + " (" + kind + ") in sketch \"" + sketchId + "\"";
            if (kind == null) return;
            if (string.Equals(kind, "line", StringComparison.OrdinalIgnoreCase))
            {
                if (!curve.ContainsKey("start") || !curve.ContainsKey("end"))
                    errors.Add(PlanError("MISSING_CURVE_POINT", label + " needs start and end", sketchId, index));
            }
            else if (string.Equals(kind, "circle", StringComparison.OrdinalIgnoreCase))
            {
                if (!curve.ContainsKey("center"))
                    errors.Add(PlanError("MISSING_CURVE_POINT", label + " needs center", sketchId, index));
                if (!curve.ContainsKey("radius") && !curve.ContainsKey("diameter"))
                    errors.Add(PlanError("MISSING_CURVE_SIZE", label + " needs radius or diameter", sketchId, index));
            }
            else if (string.Equals(kind, "arc", StringComparison.OrdinalIgnoreCase))
            {
                if (!curve.ContainsKey("center"))
                    errors.Add(PlanError("MISSING_CURVE_POINT", label + " needs center", sketchId, index));
                if (!curve.ContainsKey("radius"))
                    errors.Add(PlanError("MISSING_CURVE_SIZE", label + " needs radius", sketchId, index));
            }
            else if (IsPointKind(kind))
            {
                bool hasAt = curve.ContainsKey("at") || curve.ContainsKey("center")
                    || curve.ContainsKey("x") || curve.ContainsKey("y") || curve.ContainsKey("point");
                if (!hasAt)
                    errors.Add(PlanError("MISSING_CURVE_POINT", label + " needs \"at\":[x,y]", sketchId, index));
            }
        }

        static bool PlanCurveId(string text, out string curveId, out string why)
        {
            curveId = null;
            why = null;
            if (string.IsNullOrEmpty(text))
            {
                why = "empty reference";
                return false;
            }
            string[] parts = text.Trim().Split(':');
            string head = parts[0];
            if (string.Equals(head, "seg", StringComparison.OrdinalIgnoreCase)
                || string.Equals(head, "curve", StringComparison.OrdinalIgnoreCase))
            {
                why = "reference \"" + text + "\" addresses an existing sketch; a build plan must name "
                    + "the curve id it declares (\"arc1\" or \"arc1:center\")";
                return false;
            }
            if (parts.Length > 2)
            {
                why = "reference \"" + text + "\" has more than one \":\" part";
                return false;
            }
            if (parts.Length == 2)
            {
                string part = parts[1].ToLowerInvariant();
                if (part != "start" && part != "end" && part != "center")
                {
                    why = "reference \"" + text + "\" must end in :start, :end or :center";
                    return false;
                }
            }
            if (!Relations.IsCurveIdText(head))
            {
                why = "reference \"" + text + "\" is not a curve id (ids start with a letter or _ and "
                    + "contain letters, digits, _ or -)";
                return false;
            }
            curveId = head;
            return true;
        }

        /// <summary>Sketch plans in a definition: an explicit "sketches" array, a single
        /// "sketch" object, or features whose kind is "sketch".</summary>
        public static List<object> SketchPlans(Dictionary<string, object> definition)
        {
            List<object> plans = new List<object>();
            foreach (object raw in Json.Items(definition.ContainsKey("sketches") ? definition["sketches"] : null))
                if (raw != null) plans.Add(raw);
            object single = definition.ContainsKey("sketch") ? definition["sketch"] : null;
            if (single != null) plans.Add(single);
            foreach (object raw in Json.Items(definition.ContainsKey("features") ? definition["features"] : null))
            {
                Dictionary<string, object> f = Json.Obj(raw);
                if (f == null) continue;
                string kind = Json.Str(f, "kind", Json.Str(f, "type", null));
                if (string.Equals(kind, "sketch", StringComparison.OrdinalIgnoreCase)) plans.Add(f);
            }
            return plans;
        }

        static int CountConstruction(Dictionary<string, object> plan)
        {
            int count = 0;
            foreach (string key in new string[] { "curves", "primitives" })
            {
                foreach (object raw in Json.Items(plan.ContainsKey(key) ? plan[key] : null))
                {
                    Dictionary<string, object> entry = Json.Obj(raw);
                    if (entry == null) continue;
                    if (Json.Bool(entry, "construction", false)) count++;
                }
            }
            return count;
        }

        static Dictionary<string, object> PlanError(string code, string message, string where, int index)
        {
            return Json.Dict("code", code, "message", message, "where", where, "index", Json.R(index));
        }

        static Dictionary<string, object> PlanResult(List<object> errors, List<object> sketches,
            List<object> relations, List<object> dimensions, List<object> notes)
        {
            return Json.Dict(
                "kind", "plan",
                "valid", errors.Count == 0,
                "document", null,
                "sketches", sketches,
                "relations", relations,
                "dimensions", dimensions,
                "errors", errors,
                "errorCount", errors.Count,
                "notes", notes);
        }

        /// <summary>Every step this builder has taken, in order. Included in a
        /// failure's detail so the log shows what the document looked like when the
        /// step that broke it ran.</summary>
        public List<string> StepsSnapshot()
        {
            return new List<string>(_steps);
        }

        string LastStep()
        {
            return _steps.Count == 0 ? null : _steps[_steps.Count - 1];
        }

        static bool IsVertical(IEdge e)
        {
            object a = e.GetStartVertex();
            object b = e.GetEndVertex();
            IVertex v0 = a as IVertex;
            IVertex v1 = b as IVertex;
            if (v0 == null || v1 == null) return false;
            double[] p0 = (double[])v0.GetPoint();
            double[] p1 = (double[])v1.GetPoint();
            if (p0 == null || p1 == null) return false;
            return Math.Abs(p1[0] - p0[0]) < 1e-7 && Math.Abs(p1[1] - p0[1]) < 1e-7
                && Math.Abs(p1[2] - p0[2]) > 1e-7;
        }

        static double StartZ(IEdge e)
        {
            IVertex v = e.GetStartVertex() as IVertex;
            if (v == null) return double.NaN;
            double[] p = (double[])v.GetPoint();
            return p == null ? double.NaN : p[2];
        }

        public static IFace2 TopPlanarFace(IModelDoc2 doc, double normalSign)
        {
            IBody2 body = Geometry.LargestBody(doc);
            Array faces = (Array)body.GetFaces();
            IFace2 best = null;
            double bestZ = normalSign > 0 ? double.MinValue : double.MaxValue;
            for (int i = 0; i < faces.Length; i++)
            {
                IFace2 f = (IFace2)faces.GetValue(i);
                ISurface s = (ISurface)f.GetSurface();
                if (s == null || !s.IsPlane()) continue;
                double[] pp = (double[])s.PlaneParams;
                if (pp == null) continue;
                if (Math.Abs(Math.Abs(pp[2]) - 1.0) > 1e-6) continue;
                double z = pp[5];
                if (normalSign > 0 ? z > bestZ : z < bestZ) { bestZ = z; best = f; }
            }
            return best;
        }
    }
}
