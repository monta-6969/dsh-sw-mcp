using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Semantic measurements.
    ///
    /// "How big is the model" is Geometry.Snapshot's job. This is the other
    /// question: how big is *that bore*, how high is its axis, how far apart are
    /// the two slot centres. Those answers have to survive rebuilds and renames,
    /// so they are derived from surface geometry (axis + radius + normal sense),
    /// never from feature names.
    ///
    /// The one piece of real geometry here is telling a hole from a boss: both are
    /// cylindrical faces with the same axis and radius. The difference is which
    /// side the material is on, which is the direction the surface normal points
    /// relative to the axis. A hole's normal points inwards, a boss's outwards.</summary>
    static class Measure
    {
        public static Dictionary<string, object> Dispatch(Dictionary<string, object> req)
        {
            string kind = Json.Str(req, "kind", "holes");
            IncludeIds = Json.Bool(req, "includeIds", false);
            switch (kind)
            {
                case "faces": return FaceList(req);
                case "cylinders": return Cylinders(req);
                case "holes": return Holes(req);
                case "axis": return Axis(req);
                case "spacing": return Spacing(req);
                case "distance": return Distance(req);
                case "planes": return PlaneList(req);
                case "helix": return Helix(req);
                default:
                    throw new BridgeError("BAD_ARGUMENT",
                        "measure kind \"" + kind + "\" is not supported",
                        Json.Dict("kinds", Json.List("faces", "cylinders", "holes", "axis",
                            "spacing", "distance", "planes", "helix")));
            }
        }

        // ---------------------------------------------------------------- records

        /// <summary>Whether to return the full persistent-reference ids.
        ///
        /// Those ids are 750+ characters each, so a list of ten holes came back as
        /// 15 kB of hex and no one could see the diameters. Default off: the record
        /// carries idShort for talking about a face, and the caller asks for the real
        /// ids only when it is about to select one.</summary>
        static bool IncludeIds;

        sealed class Cyl
        {
            public int BodyIndex;
            public int FaceIndex;
            public double[] Point = new double[3];   // mm
            public double[] Dir = new double[3];     // unit
            public double Radius;                    // mm
            public double Length;                    // mm
            public bool IsHole;
            public string Id;
            public double[] Box = new double[6];     // mm
            public string BodyTitle;
            public List<string> FaceIds = new List<string>();
            public int FaceCount = 1;
        }

        sealed class Plane
        {
            public int BodyIndex;
            public int FaceIndex;
            public double[] Point = new double[3];
            public double[] Normal = new double[3];
            public double[] Box = new double[6];
            public string Id;
        }

        // ---------------------------------------------------------------- surface math

        /// <summary>A point on a face plus the surface normal there.
        ///
        /// ISurface.Evaluate returns [point, du, dv, ddu, dduv, ddv]; the normal is
        /// du x dv. Sampling the middle of the parameter range keeps this away from
        /// the degenerate seams at the ends of a cylinder.</summary>
        static bool SampleFace(IFace2 face, out double[] pointMm, out double[] normal)
        {
            pointMm = null;
            normal = null;
            try
            {
                ISurface surf = face.GetSurface() as ISurface;
                if (surf == null) return false;
                double[] range = surf.Parameterization() as double[];
                if (range == null || range.Length < 4) return false;
                double u = (range[0] + range[1]) / 2.0;
                double v = (range[2] + range[3]) / 2.0;
                double[] ev = surf.Evaluate(u, v, 1, 1) as double[];
                if (ev == null || ev.Length < 9) return false;

                double[] du = new double[] { ev[3], ev[4], ev[5] };
                double[] dv = new double[] { ev[6], ev[7], ev[8] };
                double[] n = Cross(du, dv);
                double len = Norm(n);
                if (len < 1e-12) return false;
                for (int i = 0; i < 3; i++) n[i] /= len;

                // FaceInSurfaceSense flips the surface normal to the face normal.
                if (face.FaceInSurfaceSense())
                    for (int i = 0; i < 3; i++) n[i] = -n[i];

                pointMm = new double[] { ev[0] * 1000, ev[1] * 1000, ev[2] * 1000 };
                normal = n;
                return true;
            }
            catch (COMException) { return false; }
            catch (InvalidCastException) { return false; }
        }

        static double[] Cross(double[] a, double[] b)
        {
            return new double[]
            {
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0]
            };
        }

        static double Norm(double[] v)
        {
            return Math.Sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        }

        static double Dot(double[] a, double[] b)
        {
            return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        }

        static double[] Unit(double[] v)
        {
            double n = Norm(v);
            if (n < 1e-12) return new double[] { 0, 0, 0 };
            return new double[] { v[0] / n, v[1] / n, v[2] / n };
        }

        // ---------------------------------------------------------------- collection

        static List<Cyl> CylindersOf(IModelDoc2 doc, out IModelDocExtension ext)
        {
            ext = doc.Extension;
            List<Cyl> list = new List<Cyl>();
            List<IBody2> bodies = BodiesOf(doc);
            for (int bi = 0; bi < bodies.Count; bi++)
            {
                Array faces = bodies[bi].GetFaces() as Array;
                if (faces == null) continue;
                for (int fi = 0; fi < faces.Length; fi++)
                {
                    IFace2 face = faces.GetValue(fi) as IFace2;
                    if (face == null) continue;
                    ISurface surf = null;
                    try { surf = face.GetSurface() as ISurface; } catch (COMException) { continue; }
                    if (surf == null || !surf.IsCylinder()) continue;

                    double[] cp = surf.CylinderParams as double[];
                    if (cp == null || cp.Length < 7) continue;

                    Cyl c = new Cyl();
                    c.BodyIndex = bi;
                    c.FaceIndex = fi;
                    c.Point = new double[] { cp[0] * 1000, cp[1] * 1000, cp[2] * 1000 };
                    c.Dir = Unit(new double[] { cp[3], cp[4], cp[5] });
                    c.Radius = cp[6] * 1000;
                    c.Box = FaceBoxMm(face);
                    if (c.Box != null)
                    {
                        // Extent along the axis, from the face's own box.
                        double t0 = double.MaxValue, t1 = double.MinValue;
                        for (int k = 0; k < 8; k++)
                        {
                            double px = ((k & 1) == 0 ? c.Box[0] : c.Box[3]) - c.Point[0];
                            double py = ((k & 2) == 0 ? c.Box[1] : c.Box[4]) - c.Point[1];
                            double pz = ((k & 4) == 0 ? c.Box[2] : c.Box[5]) - c.Point[2];
                            double t = px * c.Dir[0] + py * c.Dir[1] + pz * c.Dir[2];
                            if (t < t0) t0 = t;
                            if (t > t1) t1 = t;
                        }
                        c.Length = t1 - t0;
                    }
                    c.IsHole = ClassifyHole(face, c);
                    try
                    {
                        byte[] bytes = ext.GetPersistReference3(face) as byte[];
                        if (bytes != null && bytes.Length > 0) c.Id = Hex.FromBytes(bytes);
                    }
                    catch (COMException) { }
                    list.Add(c);
                }
            }
            return Merge(list);
        }

        /// <summary>Material side tells a hole from a boss.
        ///
        /// Take a point on the surface and the outward normal there; the direction
        /// from the axis to that point is "outwards" too. If the normal points back
        /// towards the axis, the material is outside the cylinder — a hole. If it
        /// points away, the material is inside it — a shaft or a boss.</summary>
        static bool ClassifyHole(IFace2 face, Cyl c)
        {
            double[] p, n;
            if (!SampleFace(face, out p, out n)) return false;
            double[] radial = new double[]
            {
                p[0] - c.Point[0], p[1] - c.Point[1], p[2] - c.Point[2]
            };
            double along = Dot(radial, c.Dir);
            for (int i = 0; i < 3; i++) radial[i] -= along * c.Dir[i];
            radial = Unit(radial);
            return Dot(n, radial) < 0;
        }

        /// <summary>Merges the faces that belong to one bore.
        ///
        /// A through hole is usually two half-cylindrical faces, not one; a bore
        /// crossed by another cut can be four. Reporting faces would tell the caller
        /// there are two holes where the drawing shows one, and every count and
        /// spacing derived from it would be wrong. Two faces are the same bore when
        /// their axes are the same line and their radii match.</summary>
        static List<Cyl> Merge(List<Cyl> raw)
        {
            List<Cyl> merged = new List<Cyl>();
            foreach (Cyl c in raw)
            {
                Cyl host = null;
                foreach (Cyl m in merged)
                {
                    if (Math.Abs(m.Radius - c.Radius) > 0.01) continue;
                    if (Math.Abs(Dot(m.Dir, c.Dir)) < 0.9995) continue;
                    if (LineDistance(m, c) > 0.01) continue;
                    host = m;
                    break;
                }
                if (host == null)
                {
                    Cyl copy = new Cyl();
                    copy.BodyIndex = c.BodyIndex;
                    copy.FaceIndex = c.FaceIndex;
                    copy.Point = c.Point;
                    copy.Dir = c.Dir;
                    copy.Radius = c.Radius;
                    copy.Length = c.Length;
                    copy.Box = c.Box;
                    copy.IsHole = c.IsHole;
                    copy.Id = c.Id;
                    copy.FaceIds = new List<string>();
                    if (c.Id != null) copy.FaceIds.Add(c.Id);
                    copy.FaceCount = 1;
                    merged.Add(copy);
                }
                else
                {
                    host.FaceCount++;
                    if (c.Id != null) host.FaceIds.Add(c.Id);
                    host.Length = Math.Max(host.Length, c.Length);
                    host.IsHole = host.IsHole || c.IsHole;
                    host.Box = Union(host.Box, c.Box);
                }
            }
            return merged;
        }

        /// <summary>Perpendicular distance between the two axes, treating each as a
        /// line through its point along its direction.</summary>
        static double LineDistance(Cyl a, Cyl b)
        {
            double[] delta = new double[]
            {
                b.Point[0] - a.Point[0], b.Point[1] - a.Point[1], b.Point[2] - a.Point[2]
            };
            double along = Dot(delta, a.Dir);
            double[] perp = new double[]
            {
                delta[0] - along * a.Dir[0], delta[1] - along * a.Dir[1], delta[2] - along * a.Dir[2]
            };
            return Norm(perp);
        }

        static double[] Union(double[] a, double[] b)
        {
            if (a == null) return b;
            if (b == null) return a;
            return new double[]
            {
                Math.Min(a[0], b[0]), Math.Min(a[1], b[1]), Math.Min(a[2], b[2]),
                Math.Max(a[3], b[3]), Math.Max(a[4], b[4]), Math.Max(a[5], b[5])
            };
        }

        static List<IFace2> PlanesOf(IModelDoc2 doc)
        {
            List<IFace2> list = new List<IFace2>();
            foreach (IBody2 body in BodiesOf(doc))
            {
                Array faces = body.GetFaces() as Array;
                if (faces == null) continue;
                foreach (object o in faces)
                {
                    IFace2 f = o as IFace2;
                    if (f == null) continue;
                    try
                    {
                        ISurface s = f.GetSurface() as ISurface;
                        if (s != null && s.IsPlane()) list.Add(f);
                    }
                    catch (COMException) { }
                }
            }
            return list;
        }

        static List<IBody2> BodiesOf(IModelDoc2 doc)
        {
            List<IBody2> list = new List<IBody2>();
            IPartDoc part = doc as IPartDoc;
            if (part == null) return list;
            Array arr = part.GetBodies2((int)swBodyType_e.swSolidBody, false) as Array;
            if (arr == null) return list;
            foreach (object o in arr)
            {
                IBody2 b = o as IBody2;
                if (b != null) list.Add(b);
            }
            return list;
        }

        static double[] FaceBoxMm(IFace2 face)
        {
            try
            {
                double[] b = face.GetBox() as double[];
                if (b == null || b.Length < 6) return null;
                return new double[]
                {
                    b[0] * 1000, b[1] * 1000, b[2] * 1000,
                    b[3] * 1000, b[4] * 1000, b[5] * 1000
                };
            }
            catch (COMException) { return null; }
        }

        static Dictionary<string, object> BodyBox(IModelDoc2 doc)
        {
            List<IBody2> bodies = BodiesOf(doc);
            if (bodies.Count == 0) return null;
            return Geometry.BoundingBox(bodies[0]);
        }

        /// <summary>Outer size of the part in mm, [x,y,z]. Used to tell a through hole
        /// from a blind one: a hole whose cylinder spans the whole part along its axis
        /// goes through it.</summary>
        static double[] BodySizeMm(IModelDoc2 doc)
        {
            Dictionary<string, object> box = BodyBox(doc);
            if (box == null || !box.ContainsKey("size")) return null;
            ArrayList size = Json.Arr(box["size"]);
            if (size == null || size.Count < 3) return null;
            return new double[]
            {
                Json.ToDouble(size[0], 0), Json.ToDouble(size[1], 0), Json.ToDouble(size[2], 0)
            };
        }

        /// <summary>True when the cylinder runs the part's full thickness along its own
        /// axis, false when it stops inside, null when the axis is not one of the three
        /// model axes (a slanted hole: not guessed, and counted as "unknown").</summary>
        static bool? ThroughOf(Cyl c, double[] bodySize)
        {
            if (bodySize == null) return null;
            double ax = Math.Abs(c.Dir[0]), ay = Math.Abs(c.Dir[1]), az = Math.Abs(c.Dir[2]);
            int axis = ax >= ay && ax >= az ? 0 : (ay >= az ? 1 : 2);
            double dominant = axis == 0 ? ax : (axis == 1 ? ay : az);
            if (dominant < 0.999) return null;
            double span = bodySize[axis];
            if (span <= 0) return null;
            return c.Length >= span - 0.1;
        }

        // ---------------------------------------------------------------- kinds

        static Dictionary<string, object> Holes(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                // A2 第二类：这个 op 的参数里没有 designId 也能用（语义就是"量前台那份"）。
                // 带上 designId 就按登记找文档；不带则保持原行为，但返回体里必须说清
                // 自己量的是谁（documentFallback + documentTitle）。
                bool fallback;
                IModelDoc2 doc = Operations.OptionalDesignDocument(h, req, "measure.holes", out fallback);
                RequirePart(doc, "holes");
                IModelDocExtension ext;
                List<Cyl> all = CylindersOf(doc, out ext);

                double minDiameter = Json.Dbl(req, "minDiameter", 0.5);
                bool hasThrough = req.ContainsKey("through");
                bool wantThrough = Json.Bool(req, "through", true);
                bool hasEq = req.ContainsKey("diameterEq");
                double eq = Json.Dbl(req, "diameterEq", 0);
                double eqTol = Json.Dbl(req, "diameterTol", 0.02);
                bool hasRange = req.ContainsKey("diameterRange");
                double rangeMin = 0, rangeMax = double.MaxValue;
                if (hasRange)
                {
                    ArrayList rangeRaw = Json.Arr(req["diameterRange"]);
                    if (rangeRaw != null && rangeRaw.Count >= 2)
                    {
                        rangeMin = Json.ToDouble(rangeRaw[0], 0);
                        rangeMax = Json.ToDouble(rangeRaw[1], double.MaxValue);
                    }
                }

                // 通孔/盲孔是「孔」这个字最常见的两种含义，混在一起数就没有意义：
                // 实测一个锁盖有 2×Ø5 通孔 + 2×Ø18 沉头 + Ø14 + Ø30，直接数圆柱面
                // 得到 6，调用方要的「2 个螺栓孔」永远对不上。这里逐个孔判一次贯穿，
                // 并把分类计数一起回出去，让调用方自己选口径。
                double[] bodySize = BodySizeMm(doc);
                List<object> holes = new List<object>();
                int throughCount = 0, blindCount = 0, unknownCount = 0;
                List<string> diameters = new List<string>();
                foreach (Cyl c in all)
                {
                    if (!c.IsHole) continue;
                    double diameter = c.Radius * 2;
                    if (diameter < minDiameter) continue;
                    bool? through = ThroughOf(c, bodySize);
                    if (through == true) throughCount += 1;
                    else if (through == false) blindCount += 1;
                    else unknownCount += 1;
                    if (hasThrough && through.HasValue && through.Value != wantThrough) continue;
                    if (hasEq && Math.Abs(diameter - eq) > eqTol) continue;
                    if (hasRange && (diameter < rangeMin || diameter > rangeMax)) continue;
                    Dictionary<string, object> rec = Describe(c);
                    rec["through"] = through.HasValue ? (object)through.Value : null;
                    rec["depth"] = Json.R(c.Length);
                    holes.Add(rec);
                    string label = Json.R(diameter) + "";
                    if (!diameters.Contains(label)) diameters.Add(label);
                }
                return Operations.MarkDocumentFallback(Json.Dict(
                    "kind", "holes",
                    "count", holes.Count,
                    "holes", holes,
                    "breakdown", Json.Dict(
                        "through", throughCount,
                        "blind", blindCount,
                        "unknown", unknownCount,
                        "diameters", diameters),
                    "cylinderFaces", all.Count,
                    "document", DocInfo(doc)), doc, fallback);
            }
        }

        static Dictionary<string, object> Cylinders(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                bool fallback;
                IModelDoc2 doc = Operations.OptionalDesignDocument(h, req, "measure.cylinders", out fallback);
                RequirePart(doc, "cylinders");
                IModelDocExtension ext;
                List<Cyl> all = CylindersOf(doc, out ext);
                List<object> list = new List<object>();
                foreach (Cyl c in all) list.Add(Describe(c));
                return Operations.MarkDocumentFallback(Json.Dict(
                    "kind", "cylinders",
                    "count", list.Count,
                    "cylinders", list,
                    "document", DocInfo(doc)), doc, fallback);
            }
        }

        static Dictionary<string, object> FaceList(Dictionary<string, object> req)
        {
            return Observe.Faces(req);
        }

        static Dictionary<string, object> PlaneList(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                bool fallback;
                IModelDoc2 doc = Operations.OptionalDesignDocument(h, req, "measure.planes", out fallback);
                RequirePart(doc, "planes");
                IModelDocExtension ext = doc.Extension;
                List<object> list = new List<object>();
                foreach (IFace2 f in PlanesOf(doc))
                {
                    Dictionary<string, object> rec = Json.Dict();
                    try
                    {
                        ISurface s = f.GetSurface() as ISurface;
                        double[] pp = s.PlaneParams as double[];
                        if (pp != null && pp.Length >= 6)
                        {
                            double sense = f.FaceInSurfaceSense() ? -1.0 : 1.0;
                            double[] n = Unit(new double[] { sense * pp[0], sense * pp[1], sense * pp[2] });
                            rec["normal"] = Json.List(Json.R(n[0]), Json.R(n[1]), Json.R(n[2]));
                            rec["point"] = Json.List(
                                Json.R(pp[3] * 1000), Json.R(pp[4] * 1000), Json.R(pp[5] * 1000));
                        }
                        double[] box = FaceBoxMm(f);
                        if (box != null)
                            rec["box"] = Json.List(Json.R(box[0]), Json.R(box[1]), Json.R(box[2]),
                                Json.R(box[3]), Json.R(box[4]), Json.R(box[5]));
                        byte[] bytes = ext.GetPersistReference3(f) as byte[];
                        if (bytes != null && bytes.Length > 0) IdField(rec, Hex.FromBytes(bytes));
                    }
                    catch (COMException) { continue; }
                    list.Add(rec);
                }
                return Operations.MarkDocumentFallback(
                    Json.Dict("kind", "planes", "count", list.Count, "planes", list,
                        "document", DocInfo(doc)), doc, fallback);
            }
        }

        static Dictionary<string, object> Axis(Dictionary<string, object> req)
        {
            double diameter = Json.Dbl(req, "diameter", 0);
            // Three states, because "default to holes only" quietly hid every boss:
            // a caller measuring the Ø11 boss got zero matches, then reported the
            // dimension as wrong instead of reporting that it never measured it.
            // Absent means "either"; true and false are explicit filters.
            bool filter = req.ContainsKey("hole");
            bool wantHole = Json.Bool(req, "hole", true);
            if (diameter <= 0)
                throw new BridgeError("BAD_ARGUMENT", "measure kind=axis needs \"diameter\"");

            using (SwHost h = SwHost.Attach())
            {
                bool fallback;
                IModelDoc2 doc = Operations.OptionalDesignDocument(h, req, "measure.axis", out fallback);
                RequirePart(doc, "axis");
                IModelDocExtension ext;
                List<Cyl> all = CylindersOf(doc, out ext);

                List<object> matched = new List<object>();
                int holes = 0, bosses = 0;
                foreach (Cyl c in all)
                {
                    if (Math.Abs(c.Radius * 2 - diameter) > Math.Max(0.02, diameter * 0.002)) continue;
                    if (filter && wantHole != c.IsHole) continue;
                    if (c.IsHole) holes++; else bosses++;
                    matched.Add(Describe(c));
                }

                Dictionary<string, object> box = BodyBox(doc);
                double minY = 0;
                if (box != null)
                {
                    ArrayList min = Json.Arr(box["min"]);
                    if (min != null && min.Count >= 3) minY = Json.ToDouble(min[1], 0);
                }

                List<object> heights = new List<object>();
                foreach (object o in matched)
                {
                    Dictionary<string, object> rec = Json.Obj(o);
                    ArrayList pt = Json.Arr(rec["axisPoint"]);
                    if (pt == null || pt.Count < 3) continue;
                    heights.Add(Json.Dict(
                        "axisPoint", rec["axisPoint"],
                        "heightAboveMinY", Json.R(Json.ToDouble(pt[1], 0) - minY)));
                }

                return Operations.MarkDocumentFallback(Json.Dict(
                    "kind", "axis",
                    "diameter", diameter,
                    "count", matched.Count,
                    "holes", holes,
                    "bosses", bosses,
                    "matched", filter ? (wantHole ? "holes" : "bosses") : "either",
                    "matches", matched,
                    "available", Available(all),
                    "heightAboveMinY", heights,
                    "bodyBox", box,
                    "document", DocInfo(doc)), doc, fallback);
            }
        }

        /// <summary>What cylinders the part actually has, so an empty result says
        /// whether the diameter is missing from the part or was filtered out by the
        /// caller's own hole/boss flag. A bare empty list invites the caller to re-try
        /// the same query with a different number until it gives up.</summary>
        static Dictionary<string, object> Available(List<Cyl> all)
        {
            SortedDictionary<string, object> dia = new SortedDictionary<string, object>();
            List<object> holeList = new List<object>();
            List<object> bossList = new List<object>();
            foreach (Cyl c in all)
            {
                double d = Math.Round(c.Radius * 2, 3);
                string key = d.ToString("F3");
                dia[key] = Json.R(d);
                if (c.IsHole) holeList.Add(Json.R(d));
                else bossList.Add(Json.R(d));
            }
            List<double> diameters = new List<double>();
            foreach (KeyValuePair<string, object> kv in dia) diameters.Add(Json.ToDouble(kv.Value, 0));
            diameters.Sort();
            return Json.Dict(
                "diameters", diameters,
                "holes", holeList,
                "bosses", bossList);
        }

        static Dictionary<string, object> Spacing(Dictionary<string, object> req)
        {
            double diameter = Json.Dbl(req, "diameter", 0);
            string axis = Json.Str(req, "axis", null);

            using (SwHost h = SwHost.Attach())
            {
                bool fallback;
                IModelDoc2 doc = Operations.OptionalDesignDocument(h, req, "measure.spacing", out fallback);
                RequirePart(doc, "spacing");
                IModelDocExtension ext;
                List<Cyl> all = CylindersOf(doc, out ext);

                List<Cyl> pick = new List<Cyl>();
                foreach (Cyl c in all)
                {
                    if (!c.IsHole) continue;
                    if (diameter > 0 && Math.Abs(c.Radius * 2 - diameter) > Math.Max(0.02, diameter * 0.002)) continue;
                    if (axis != null)
                    {
                        double[] want = AxisVector(axis);
                        if (want == null) throw new BridgeError("BAD_ARGUMENT", "axis must be X, Y or Z");
                        if (Math.Abs(Dot(c.Dir, want)) < 0.99) continue;
                    }
                    pick.Add(c);
                }

                // Axis points are anywhere along the axis; centre distance is the
                // perpendicular distance between the two lines, not the point gap.
                List<object> pairs = new List<object>();
                for (int i = 0; i < pick.Count; i++)
                {
                    for (int j = i + 1; j < pick.Count; j++)
                    {
                        double[] delta;
                        double d = Perpendicular(pick[i], pick[j], out delta);
                        pairs.Add(Json.Dict(
                            "from", pick[i].Id, "to", pick[j].Id,
                            "distance", Json.R(d),
                            "delta", Json.List(Json.R(delta[0]), Json.R(delta[1]), Json.R(delta[2]))));
                    }
                }
                return Operations.MarkDocumentFallback(Json.Dict(
                    "kind", "spacing",
                    "diameter", diameter,
                    "count", pick.Count,
                    "cylinders", CountList(pick),
                    "pairs", pairs,
                    "document", DocInfo(doc)), doc, fallback);
            }
        }

        static double Perpendicular(Cyl a, Cyl b, out double[] delta)
        {
            double[] d = new double[]
            {
                b.Point[0] - a.Point[0], b.Point[1] - a.Point[1], b.Point[2] - a.Point[2]
            };
            double along = Dot(d, a.Dir);
            double[] perp = new double[]
            {
                d[0] - along * a.Dir[0], d[1] - along * a.Dir[1], d[2] - along * a.Dir[2]
            };
            delta = perp;
            return Norm(perp);
        }

        sealed class Anchor
        {
            public double[] Point = new double[3];
            public int Axis = -1;     // 0/1/2 when the anchor is a coordinate plane
            public string Name;
        }

        // ---------------------------------------------------------------- helix
        //
        // 真螺旋面做出来之后，「它到底是不是 3.1416 的导程」不能靠读回输入参数回答：
        // 扫掠失败也可能留下一个看起来像螺纹的东西。这里直接量几何 —— 取实体上
        // 半径恒定、绕轴单调转动的边（螺旋边），沿边采样后用 z = z0 + (p/2π)·θ 回归，
        // 斜率就是导程。同一个半径上两条螺旋边的轴向错位就是那条棱带的齿厚。
        //
        // 只用 IEdge.Evaluate：它给出曲线上的精确点，不经过网格化，因此读数与
        // 建模公差同级，而不是与显示精度同级。

        sealed class HelixEdge
        {
            public double Radius;
            public double Pitch;
            public double Turns;
            public double Z0;
            public string Id;
        }

        static Dictionary<string, object> Helix(Dictionary<string, object> req)
        {
            int samples = Json.Int(req, "samples", 400);
            if (samples < 50) samples = 50;
            if (samples > 4000) samples = 4000;
            double minTurns = Json.Dbl(req, "minTurns", 1.5);
            double radiusTolerance = Json.Dbl(req, "radiusTolerance", 0.02);
            bool debug = Json.Bool(req, "debug", false);
            List<object> trace = new List<object>();

            using (SwHost h = SwHost.Attach())
            {
                bool fallback;
                IModelDoc2 doc = Operations.OptionalDesignDocument(h, req, "measure.helix", out fallback);
                RequirePart(doc, "helix");
                IPartDoc part = doc as IPartDoc;
                object[] bodies = part == null ? null
                    : part.GetBodies2((int)swBodyType_e.swSolidBody, false) as object[];
                if (bodies == null || bodies.Length == 0)
                    throw new BridgeError("EMPTY_MODEL", "this part has no solid body to measure");

                List<HelixEdge> helicals = new List<HelixEdge>();                double edgeMinR = double.MaxValue, edgeMaxR = 0;
                List<object> rejected = new List<object>();
                int edgeCount = 0;
                foreach (object raw in bodies)
                {
                    IBody2 body = raw as IBody2;
                    if (body == null) continue;
                    object[] edges = null;
                    try { edges = (object[])body.GetEdges(); }
                    catch (COMException) { }
                    if (edges == null) continue;
                    foreach (object e in edges)
                    {
                        IEdge edge = e as IEdge;
                        if (edge == null) continue;
                        edgeCount++;                        SampleRadiusRange(edge, ref edgeMinR, ref edgeMaxR);
                        string why;
                        HelixEdge found = FitHelix(edge, samples, radiusTolerance, out why);
                        if (found != null && found.Turns >= minTurns) helicals.Add(found);
                        else if (debug)
                        {
                            trace.Add(Json.Dict("edge", edgeCount,
                                "turns", found == null ? null : (object)Json.R(found.Turns),
                                "radius", found == null ? null : (object)Json.R(found.Radius),
                                "why", why));
                        }
                    }
                }

                if (debug)
                    return Operations.MarkDocumentFallback(
                        Json.Dict("kind", "helixDebug", "edgeCount", edgeCount,
                            "helixCount", helicals.Count, "trace", trace, "document", DocInfo(doc)),
                        doc, fallback);

                if (helicals.Count == 0)
                    throw new BridgeError("NO_HELICAL_EDGE",
                        "no edge on this body is a helix (constant radius, monotonically turning) — "
                        + "there is nothing to measure a lead on. Build the thread as a swept cut along "
                        + "a helix first; a polar pattern of tilted cuts has no helical edge.",
                        Json.Dict("edges", edgeCount));

                // 导程取所有螺旋边的中位数：一条边上偶尔会有退化的采样点，中位数不受它影响。
                List<double> pitches = new List<double>();
                foreach (HelixEdge he in helicals) pitches.Add(Math.Abs(he.Pitch));
                pitches.Sort();
                double pitch = pitches[pitches.Count / 2];

                // 半径 → 齿顶 / 齿根：螺旋边的半径就是它所在圆柱的半径。
                double minR = double.MaxValue, maxR = 0;
                foreach (HelixEdge he in helicals)
                {
                    if (he.Radius < minR) minR = he.Radius;
                    if (he.Radius > maxR) maxR = he.Radius;
                }

                // 同一半径上的边：轴向错位 = 棱带宽度。对螺纹来说齿顶那条棱带就是齿顶齿厚。
                List<object> bands = new List<object>();
                for (int i = 0; i < helicals.Count; i++)
                {
                    for (int j = i + 1; j < helicals.Count; j++)
                    {
                        if (Math.Abs(helicals[i].Radius - helicals[j].Radius) > radiusTolerance) continue;
                        // 两条边在 θ=0 处的轴向截距差 = 它们之间那条棱带的宽度（对齿顶
                        // 圆柱面来说就是齿顶轴向齿厚）。**不做 ±p/2 折叠**：折叠会把
                        // 2.30 的槽宽折成 0.84 的齿厚，读数看起来「对上了」，实际量的
                        // 是另一半 —— 上一轮就是这样把齿/槽读反的。
                        double rawOffset = Math.Abs(helicals[i].Z0 - helicals[j].Z0) % pitch;
                        double ribbon = Math.Min(rawOffset, pitch - rawOffset);
                        bands.Add(Json.Dict(
                            "from", helicals[i].Id, "to", helicals[j].Id,
                            "radius", Json.R(helicals[i].Radius),
                            "axialOffsetMm", Json.R(rawOffset),
                            "ribbonWidthMm", Json.R(ribbon)));
                    }
                }

                List<object> rows = new List<object>();
                foreach (HelixEdge he in helicals)
                    rows.Add(Json.Dict("id", he.Id, "radius", Json.R(he.Radius),
                        "pitchMm", Json.R(Math.Abs(he.Pitch)), "turns", Json.R(he.Turns),
                        "hand", he.Pitch >= 0 ? "right" : "left"));

                double maxTurns = 0;
                foreach (HelixEdge he in helicals) if (he.Turns > maxTurns) maxTurns = he.Turns;
                return Operations.MarkDocumentFallback(Json.Dict(
                    "kind", "helix",
                    "pitchMm", Json.R(pitch),
                    "leadMm", Json.R(pitch),
                    "turns", Json.R(maxTurns),
                    "fivePitchMm", Json.R(pitch * 5.0),
                    "helixCount", helicals.Count,
                    "edgeCount", edgeCount,
                    "minRadiusMm", Json.R(edgeMinR == double.MaxValue ? minR : edgeMinR),                    "maxEdgeRadiusMm", Json.R(edgeMaxR),
                    "maxRadiusMm", Json.R(maxR),
                    "helicalEdges", rows,
                    "bands", bands,
                    "document", DocInfo(doc)), doc, fallback);
            }
        }

        /// <summary>Samples one edge and decides whether it is a helix.
        ///
        /// A helix is: constant radius (r spread under <paramref name="radiusTolerance"/>),
        /// turning monotonically about the Z axis, with z linear in the unwrapped angle.
        /// The R² of that fit is the honesty check — a B-spline approximation of a thread
        /// still fits to ~1e-6, while a random edge does not fit at all.</summary>
            /// <summary>一条边上采样点的半径范围（mm）。用来回答「这条槽到底切到多深」：
            /// 螺旋槽的底面可能是螺旋面而不是圆柱面，此时没有圆柱面可以读半径，
            /// 但它的边界边一定经过齿根 —— 取所有边的最小半径就是实际齿根。</summary>
            static void SampleRadiusRange(IEdge edge, ref double min, ref double max)
            {
                try
                {
                    ICurve curve = edge.GetCurve() as ICurve;
                    if (curve == null) return;
                    double t0, t1;
                    bool closed, periodic;
                    if (!curve.GetEndParams(out t0, out t1, out closed, out periodic)) return;
                    if (!(t1 > t0)) return;
                    const int steps = 120;
                    for (int i = 0; i <= steps; i++)
                    {
                        double[] p = curve.Evaluate(t0 + (t1 - t0) * i / steps) as double[];
                        if (p == null || p.Length < 2) continue;
                        double r = Math.Sqrt(p[0] * p[0] + p[1] * p[1]) * 1000.0;
                        if (r < min) min = r;
                        if (r > max) max = r;
                    }
                }
                catch (COMException) { }
            }

            static HelixEdge FitHelix(IEdge edge, int samples, double radiusTolerance, out string why)    {
        why = null;
        double t0, t1;
        if (!EdgeParamRange(edge, out t0, out t1)) { why = "no param range"; return null; }
        if (!(t1 > t0)) { why = "empty range " + t0 + ".." + t1; return null; }


            ICurve curve = null;
            try { curve = edge.GetCurve() as ICurve; }
            catch (COMException) { }
            if (curve == null) { why = "no curve"; return null; }
            bool closed, periodic;
            if (!curve.GetEndParams(out t0, out t1, out closed, out periodic)) { why = "no end params"; return null; }
            if (!(t1 > t0)) { why = "empty curve range " + t0 + ".." + t1; return null; }

            List<double> xs = new List<double>();
            List<double> ys = new List<double>();
            List<double> zs = new List<double>();
            for (int i = 0; i <= samples; i++)
            {
                double t = t0 + (t1 - t0) * i / samples;
                double[] p;
                try { p = (double[])curve.Evaluate(t); }
                catch (COMException) { continue; }
                catch (InvalidCastException) { continue; }
                if (p == null || p.Length < 3) continue;
                xs.Add(p[0]); ys.Add(p[1]); zs.Add(p[2]);
            }
            if (xs.Count < 10) { why = "samples " + xs.Count; return null; }

            double rMin = double.MaxValue, rMax = 0;
            for (int i = 0; i < xs.Count; i++)
            {
                double r = Math.Sqrt(xs[i] * xs[i] + ys[i] * ys[i]);
                if (r < rMin) rMin = r;
                if (r > rMax) rMax = r;
            }
            if (rMax - rMin > radiusTolerance / 1000.0) { why = "radius " + (rMin * 1000).ToString("F4") + ".." + (rMax * 1000).ToString("F4"); return null; }   // 不是恒定半径 → 不是螺旋边
            double radius = (rMin + rMax) / 2.0;
            if (radius < 1e-7) { why = "zero radius"; return null; }

            // 展开角度：逐点取相邻增量并折到 (-π, π]，累加得到单调的 θ。
            double theta = Math.Atan2(ys[0], xs[0]);
            List<double> thetas = new List<double>();
            List<double> zList = new List<double>();
            thetas.Add(theta);
            zList.Add(zs[0]);
            for (int i = 1; i < xs.Count; i++)
            {
                double a = Math.Atan2(ys[i], xs[i]);
                double d = a - theta;
                while (d > Math.PI) d -= 2 * Math.PI;
                while (d < -Math.PI) d += 2 * Math.PI;
                theta += d;
                thetas.Add(theta);
                zList.Add(zs[i]);
            }
            double turns = Math.Abs(theta - thetas[0]) / (2 * Math.PI);
            if (turns < 0.5) { why = "turns " + turns.ToString("F3") + " r=" + radius.ToString("F3"); return null; }

            // z = z0 + slope·θ 的最小二乘拟合。
            double n = thetas.Count;
            double sumT = 0, sumZ = 0, sumTT = 0, sumTZ = 0;
            for (int i = 0; i < thetas.Count; i++)
            {
                sumT += thetas[i]; sumZ += zList[i];
                sumTT += thetas[i] * thetas[i]; sumTZ += thetas[i] * zList[i];
            }
            double denom = n * sumTT - sumT * sumT;
            if (Math.Abs(denom) < 1e-12) return null;
            double slope = (n * sumTZ - sumT * sumZ) / denom;
            double z0 = (sumZ - slope * sumT) / n;
            double pitch = slope * 2 * Math.PI * 1000.0;      // 每转进给 = 导程（单头），m→mm
            if (Math.Abs(pitch) < 1e-6) { why = "zero pitch"; return null; }

            HelixEdge result = new HelixEdge();
            result.Radius = radius * 1000.0;
            result.Pitch = pitch;
            result.Turns = turns;
            result.Z0 = z0 * 1000.0;
            result.Id = SafeEdgeId(edge);
            return result;
        }

        static bool EdgeParamRange(IEdge edge, out double t0, out double t1)
        {
            t0 = 0; t1 = 0;
            // GetCurveParams2 → [startParam, endParam, startX, startY, startZ, endX, endY, endZ]
            object raw = null;
            try { raw = edge.GetCurveParams2(); }
            catch (COMException) { }
            double[] values = raw as double[];
            if (values == null || values.Length < 2) return false;
            t0 = values[0];
            t1 = values[1];
            return !double.IsNaN(t0) && !double.IsNaN(t1);
        }

        static string SafeEdgeId(IEdge edge)
        {
            // 只要一个可读的标签，不把持久引用当身份用：调用方拿到的是几何读数，
            // 边 id 只用于把「哪两条边构成那条棱带」说清楚。
            try
            {
                object raw = edge.GetCurveParams2();
                double[] values = raw as double[];
                if (values == null || values.Length < 5) return null;
                return "t=" + Json.R(Math.Round(values[0], 6)) + "@r=" + Json.R(Math.Round(Math.Sqrt(
                    values[2] * values[2] + values[3] * values[3]), 4));
            }
            catch (COMException) { return null; }
        }

        static Dictionary<string, object> Distance(Dictionary<string, object> req)
        {
            Dictionary<string, object> a = Json.Obj(req["a"]);
            Dictionary<string, object> b = Json.Obj(req["b"]);
            if (a == null || b == null)
                throw new BridgeError("BAD_ARGUMENT", "measure kind=distance needs \"a\" and \"b\"");

            using (SwHost h = SwHost.Attach())
            {
                bool fallback;
                IModelDoc2 doc = Operations.OptionalDesignDocument(h, req, "measure.distance", out fallback);
                RequirePart(doc, "distance");
                Dictionary<string, object> box = BodyBox(doc);

                Anchor pa = AnchorOf(doc, box, a);
                Anchor pb = AnchorOf(doc, box, b);
                if (pa == null || pb == null)
                    throw new BridgeError("BAD_ARGUMENT",
                        "could not resolve an anchor; use {\"plane\":\"minY\"}, {\"face\":\"<id>\"} or {\"axis\":{\"diameter\":40}}");

                // A coordinate plane only defines one number. Comparing its value to a
                // point means "how far is that point from this plane", not "how long is
                // the vector between two arbitrary points" — the other two components
                // of the point have nothing to do with this plane.
                string[] names = new string[] { "X", "Y", "Z" };
                int axis = -1;
                if (pa.Axis >= 0) axis = pa.Axis;
                else if (pb.Axis >= 0) axis = pb.Axis;

                double distance;
                int along;
                double[] delta;
                if (axis >= 0)
                {
                    double planeValue = pa.Axis >= 0 ? pa.Point[axis] : pb.Point[axis];
                    double other = pa.Axis >= 0 ? pb.Point[axis] : pa.Point[axis];
                    distance = Math.Abs(other - planeValue);
                    along = axis;
                    delta = new double[3];
                    delta[axis] = other - planeValue;
                }
                else
                {
                    delta = new double[]
                    {
                        pb.Point[0] - pa.Point[0], pb.Point[1] - pa.Point[1], pb.Point[2] - pa.Point[2]
                    };
                    distance = Norm(delta);
                    along = DominantAxis(delta);
                }

                return Operations.MarkDocumentFallback(Json.Dict(
                    "kind", "distance",
                    "from", Json.List(Json.R(pa.Point[0]), Json.R(pa.Point[1]), Json.R(pa.Point[2])),
                    "to", Json.List(Json.R(pb.Point[0]), Json.R(pb.Point[1]), Json.R(pb.Point[2])),
                    "fromName", pa.Name,
                    "toName", pb.Name,
                    "delta", Json.List(Json.R(delta[0]), Json.R(delta[1]), Json.R(delta[2])),
                    "distance", Json.R(distance),
                    "along", names[along],
                    "document", DocInfo(doc)), doc, fallback);
            }
        }

        static int DominantAxis(double[] d)
        {
            int best = 0;
            for (int i = 1; i < 3; i++)
                if (Math.Abs(d[i]) > Math.Abs(d[best])) best = i;
            return best;
        }

        static Anchor AnchorOf(IModelDoc2 doc, Dictionary<string, object> box, Dictionary<string, object> spec)
        {
            string plane = Json.Str(spec, "plane", null);
            if (plane != null && box != null)
            {
                ArrayList min = Json.Arr(box["min"]);
                ArrayList max = Json.Arr(box["max"]);
                Anchor an = new Anchor();
                an.Name = plane;
                switch (plane)
                {
                    case "minX": an.Axis = 0; an.Point[0] = Json.ToDouble(min[0], 0); return an;
                    case "maxX": an.Axis = 0; an.Point[0] = Json.ToDouble(max[0], 0); return an;
                    case "minY": an.Axis = 1; an.Point[1] = Json.ToDouble(min[1], 0); return an;
                    case "maxY": an.Axis = 1; an.Point[1] = Json.ToDouble(max[1], 0); return an;
                    case "minZ": an.Axis = 2; an.Point[2] = Json.ToDouble(min[2], 0); return an;
                    case "maxZ": an.Axis = 2; an.Point[2] = Json.ToDouble(max[2], 0); return an;
                }
            }

            Dictionary<string, object> axisSpec = Json.Obj(spec["axis"]);
            if (axisSpec != null)
            {
                double diameter = Json.Dbl(axisSpec, "diameter", 0);
                if (diameter <= 0) return null;
                IModelDocExtension ext;
                List<Cyl> all = CylindersOf(doc, out ext);
                // A boss has an axis too. Absent "hole" means either, so "how high is
                // the Ø11.1 boss" resolves without the caller having to know the flag;
                // pass true/false when the part has both at the same diameter.
                bool filter = axisSpec.ContainsKey("hole");
                bool wantHole = Json.Bool(axisSpec, "hole", true);
                foreach (Cyl c in all)
                {
                    if (filter && c.IsHole != wantHole) continue;
                    if (Math.Abs(c.Radius * 2 - diameter) > Math.Max(0.02, diameter * 0.002)) continue;
                    Anchor an = new Anchor();
                    an.Name = "axis of D" + diameter;
                    an.Point = c.Point;
                    return an;
                }
                return null;
            }

            string faceId = Json.Str(spec, "face", null);
            if (faceId != null)
            {
                IFace2 face = FaceByPersistentId(doc, faceId);
                if (face == null) return null;
                double[] p, n;
                if (!SampleFace(face, out p, out n)) return null;
                Anchor an = new Anchor();
                an.Name = "face";
                an.Point = p;
                return an;
            }

            return null;
        }

        static IFace2 FaceByPersistentId(IModelDoc2 doc, string id)
        {
            try
            {
                byte[] bytes = Hex.ToBytes(id);
                int err = 0;
                object obj = doc.Extension.GetObjectByPersistReference3(bytes, out err);
                return obj as IFace2;
            }
            catch (Exception) { return null; }
        }

        // ---------------------------------------------------------------- helpers

        static void RequirePart(IModelDoc2 doc, string what)
        {
            if (!(doc is IPartDoc))
                throw new BridgeError("NOT_A_PART",
                    "measure " + what + " only reads a part; the active document is "
                    + doc.GetTitle());
        }

        static double[] AxisVector(string axis)
        {
            switch ((axis ?? "").Trim().ToUpperInvariant())
            {
                case "X": case "+X": return new double[] { 1, 0, 0 };
                case "-X": return new double[] { -1, 0, 0 };
                case "Y": case "+Y": return new double[] { 0, 1, 0 };
                case "-Y": return new double[] { 0, -1, 0 };
                case "Z": case "+Z": return new double[] { 0, 0, 1 };
                case "-Z": return new double[] { 0, 0, -1 };
                default: return null;
            }
        }

        static List<object> CountList(List<Cyl> list)
        {
            List<object> outList = new List<object>();
            foreach (Cyl c in list) outList.Add(Describe(c));
            return outList;
        }

        /// <summary>Puts the persistent-reference id into a record, or a short stand-in.
        /// See IncludeIds for why the default is the short form.</summary>
        static void IdField(Dictionary<string, object> rec, string id)
        {
            if (id == null) return;
            if (IncludeIds)
            {
                rec["id"] = id;
                return;
            }
            rec["idShort"] = id.Length > 16 ? id.Substring(0, 16) : id;
            rec["idLength"] = id.Length;
        }

        static void IdsField(Dictionary<string, object> rec, List<string> ids)
        {
            if (ids == null) return;
            if (IncludeIds) rec["ids"] = new List<object>(ids.ToArray());
            else rec["faceCount"] = ids.Count;
        }

        static Dictionary<string, object> Describe(Cyl c)
        {
            Dictionary<string, object> rec = Json.Dict();
            IdField(rec, c.Id);
            IdsField(rec, c.FaceIds);
            rec["faceCount"] = c.FaceCount;
            rec["bodyIndex"] = c.BodyIndex;
            rec["faceIndex"] = c.FaceIndex;
            rec["diameter"] = Json.R(c.Radius * 2);
            rec["axisPoint"] = Json.List(Json.R(c.Point[0]), Json.R(c.Point[1]), Json.R(c.Point[2]));
            rec["axisDir"] = Json.List(Json.R(c.Dir[0]), Json.R(c.Dir[1]), Json.R(c.Dir[2]));
            rec["length"] = Json.R(c.Length);
            rec["isHole"] = c.IsHole;
            // Spelled out, because a boolean named isHole gets skimmed: the caller
            // reads "hole | boss" and stops wondering which of the two Ø11.1 faces
            // this record is.
            rec["kind"] = c.IsHole ? "hole" : "boss";
            rec["box"] = c.Box == null ? null : Json.List(
                Json.R(c.Box[0]), Json.R(c.Box[1]), Json.R(c.Box[2]),
                Json.R(c.Box[3]), Json.R(c.Box[4]), Json.R(c.Box[5]));
            return rec;
        }

        static Dictionary<string, object> DocInfo(IModelDoc2 doc)
        {
            return Json.Dict("title", doc.GetTitle(), "path", doc.GetPathName());
        }
    }
}

