using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Read-only measurement of the current part body. Every number here
    /// is derived from the actual body, never from what we intended to build.</summary>
    static class Geometry
    {
        public static IBody2 SingleBody(IModelDoc2 doc)
        {
            IPartDoc part = doc as IPartDoc;
            if (part == null)
                throw new BridgeError("NOT_A_PART", "the active document is not a part");
            object raw = part.GetBodies2((int)swBodyType_e.swSolidBody, false);
            Array arr = raw as Array;
            if (arr == null || arr.Length == 0)
                throw new BridgeError("NO_BODY", "the part has no solid body yet");
            // 一个零件里有多个实体时必须报错，不能默默取第一个。
            // 实测：一块角撑与板只是共面接触、没相交，SOLIDWORKS 就把它当成第二个实体；
            // 这里返回 arr[0] 之后，整条流水线报的体积从 1590 变成 2.81 mm³，
            // 后面的切除「什么都没切到」，错误却指向完全无关的特征。
            if (arr.Length > 1)
            {
                List<object> volumes = new List<object>();
                List<object> boxes = new List<object>();
                double total = 0;
                for (int i = 0; i < arr.Length; i++)
                {
                    IBody2 b = (IBody2)arr.GetValue(i);
                    volumes.Add(Json.R(VolumeMm3(b)));
                    total += VolumeMm3(b);
                    Dictionary<string, object> box = BoundingBox(b); if (box != null) boxes.Add(box);
                }
                throw new BridgeError("UNEXPECTED_MULTI_BODY",
                    "这个零件有 " + arr.Length + " 块互不相连的实体（总体积 " + Math.Round(total, 4)
                    + " mm³，逐块 " + string.Join(" / ", volumes.ConvertAll(o => o.ToString()).ToArray())
                    + "）。多半是某次拉伸只与已有实体共面接触、没有真正相交，于是没合并。"
                    + "把它的轮廓往已有实体里压进 0.2–0.5 mm 再试。",
                    Json.Dict("bodyCount", arr.Length, "volumes", volumes, "boxes", boxes, "totalVolumeMm3", Json.R(total)));
            }
            return (IBody2)arr.GetValue(0);
        }

        /// <summary>总坐体积：多实体件也要能量，不能因为「不是单一实体」就拒绝读。</summary>
        public static double TotalVolumeMm3(IModelDoc2 doc)
        {
            IPartDoc part = doc as IPartDoc;
            if (part == null) throw new BridgeError("NOT_A_PART", "the active document is not a part");
            object raw = part.GetBodies2((int)swBodyType_e.swSolidBody, false);
            Array arr = raw as Array;
            if (arr == null || arr.Length == 0) return 0;
            double total = 0;
            for (int i = 0; i < arr.Length; i++) total += VolumeMm3((IBody2)arr.GetValue(i));
            return total;
        }

        /// <summary>最大的那块实体。给「按边选」这类操作当入口：多实体件里
        /// 仍然可以对主体验倒角，而不是整台零件拒之门外。</summary>
        public static IBody2 LargestBody(IModelDoc2 doc)
        {
            IPartDoc part = doc as IPartDoc;
            if (part == null) throw new BridgeError("NOT_A_PART", "the active document is not a part");
            object raw = part.GetBodies2((int)swBodyType_e.swSolidBody, false);
            Array arr = raw as Array;
            if (arr == null || arr.Length == 0) throw new BridgeError("NO_BODY", "the part has no solid body yet");
            IBody2 best = (IBody2)arr.GetValue(0);
            double bestVolume = VolumeMm3(best);
            for (int i = 1; i < arr.Length; i++)
            {
                IBody2 candidate = (IBody2)arr.GetValue(i);
                double volume = VolumeMm3(candidate);
                if (volume > bestVolume) { best = candidate; bestVolume = volume; }
            }
            return best;
        }
        public static int BodyCount(IModelDoc2 doc)
        {
            IPartDoc part = doc as IPartDoc;
            if (part == null) return 0;
            object raw = part.GetBodies2((int)swBodyType_e.swSolidBody, false);
            Array arr = raw as Array;
            return arr == null ? 0 : arr.Length;
        }

        /// <summary>Axis-aligned bounding box in millimetres, from extreme points
        /// (robust even for bodies whose mass properties are momentarily stale).</summary>
        public static Dictionary<string, object> BoundingBox(IBody2 body)
        {
            double minX = Extreme(body, -1, 0, 0);
            double maxX = Extreme(body, 1, 0, 0);
            double minY = Extreme(body, 0, -1, 0);
            double maxY = Extreme(body, 0, 1, 0);
            double minZ = Extreme(body, 0, 0, -1);
            double maxZ = Extreme(body, 0, 0, 1);

            return Json.Dict(
                "min", Json.List(Round(minX), Round(minY), Round(minZ)),
                "max", Json.List(Round(maxX), Round(maxY), Round(maxZ)),
                "size", Json.List(Round(maxX - minX), Round(maxY - minY), Round(maxZ - minZ)),
                "units", "mm");
        }

        /// <summary>Coordinate of the body's extreme point along one signed axis.
        /// Returns the coordinate itself, not its projection onto the direction:
        /// projecting would flip the sign for negative directions and silently
        /// collapse the box.</summary>
        static double Extreme(IBody2 body, double dx, double dy, double dz)
        {
            double x, y, z;
            body.GetExtremePoint(dx, dy, dz, out x, out y, out z);
            double coord = dz != 0 ? z : (dy != 0 ? y : x);
            return coord * 1000.0;
        }

        static double Round(double v)
        {
            return Math.Round(v, 4);
        }

        // ------------------------------------------------ 特征落位（box / 草图轴）

        /// <summary>一个特征自身所有面的包围盒并集，单位 mm，形状
        /// [minX, minY, minZ, maxX, maxY, maxZ]；量不到时返回 null 并给出原因。
        ///
        /// 为什么不能只报整件包围盒：体积和整件外形都挡不住「抽屉落在 Y 660-740
        /// 还是 660-780」这类落位错误，调用方只能靠剖切反推。逐特征的面盒直接
        /// 回答「这一刀切在哪 / 这块料长在哪」。
        ///
        /// 取数路径严格是 IFeature.GetFaces → IFace2.GetBox（米），这里统一换算成
        /// 毫米；草图、参考面这类没有几何面的特征如实返回 null + boxError，不拿
        /// 整件包围盒冒充。</summary>
        public static List<object> FeatureBox(IFeature feature, out string error)
        {
            error = null;
            if (feature == null)
            {
                error = "feature not found in the feature tree (renamed or consumed?)";
                return null;
            }

            Array faces = null;
            try
            {
                faces = feature.GetFaces() as Array;
            }
            catch (COMException ex)
            {
                error = "IFeature.GetFaces threw " + ex.Message;
                return null;
            }
            if (faces == null || faces.Length == 0)
            {
                error = "IFeature.GetFaces returned no faces: this feature owns no solid geometry "
                    + "(sketches, reference planes and folders have none)";
                return null;
            }

            double minX = 0, minY = 0, minZ = 0, maxX = 0, maxY = 0, maxZ = 0;
            int used = 0;
            int failed = 0;
            string lastFailure = null;
            for (int i = 0; i < faces.Length; i++)
            {
                IFace2 face = faces.GetValue(i) as IFace2;
                if (face == null) continue;
                double[] b = null;
                try
                {
                    b = Doubles(face.GetBox());
                }
                catch (Exception ex)
                {
                    failed++;
                    lastFailure = "face[" + i + "].GetBox threw " + ex.GetType().Name + ": " + ex.Message;
                    continue;
                }
                if (b == null || b.Length < 6)
                {
                    failed++;
                    lastFailure = "face[" + i + "].GetBox returned "
                        + (b == null ? "null" : b.Length + " numbers");
                    continue;
                }
                if (used == 0)
                {
                    minX = b[0]; minY = b[1]; minZ = b[2];
                    maxX = b[3]; maxY = b[4]; maxZ = b[5];
                }
                else
                {
                    minX = Math.Min(minX, b[0]); minY = Math.Min(minY, b[1]); minZ = Math.Min(minZ, b[2]);
                    maxX = Math.Max(maxX, b[3]); maxY = Math.Max(maxY, b[4]); maxZ = Math.Max(maxZ, b[5]);
                }
                used++;
            }

            if (used == 0)
            {
                error = "no face on this feature answered GetBox (faces=" + faces.Length
                    + ", failed=" + failed + (lastFailure == null ? "" : "; " + lastFailure) + ")";
                return null;
            }

            // GetBox 给的是米；回包统一毫米。
            return Json.List(
                Json.R(minX * 1000.0), Json.R(minY * 1000.0), Json.R(minZ * 1000.0),
                Json.R(maxX * 1000.0), Json.R(maxY * 1000.0), Json.R(maxZ * 1000.0));
        }

        /// <summary>给 build 回包的 features 每一行补 box / boxError。
        /// 行里的 featureName 是建造时改好的最终名字，按名字回树里取活特征，
        /// 这样改名、重建之后量到的仍然是这一行的那个特征。</summary>
        public static void AttachFeatureBoxes(IModelDoc2 doc, IEnumerable<object> features)
        {
            if (features == null) return;
            foreach (object raw in features)
            {
                Dictionary<string, object> row = Json.Obj(raw);
                if (row == null) continue;
                string name = Json.Str(row, "featureName", Json.Str(row, "id", null));
                IFeature feature = null;
                if (!string.IsNullOrEmpty(name))
                {
                    try { feature = SwHost.FindFeature(doc, name); }
                    catch (COMException) { }
                }
                string error;
                List<object> box = FeatureBox(feature, out error);
                row["box"] = box;
                if (box == null)
                    row["boxError"] = string.IsNullOrEmpty(error) ? "box could not be measured" : error;
                else
                    row.Remove("boxError");
            }
        }

        /// <summary>回包新增的 sketchPlaneMapping：每张草图一个草图 u/v 轴到世界轴
        /// 的映射，让调用方直接看到「草图 y 映射到 -Z」这类镜像，不必靠试错。
        ///
        /// 数据源按可信度依次降级：
        ///  1. ISketch.ModelToSketchTransform（model → sketch 的旋转矩阵，行 0/1 就是
        ///     草图 u/v 轴在世界里的方向）；
        ///  2. 本版 interop 没有 Get3DSketchTransform，退到草图父级参考面的
        ///     IRefPlane.Transform（同一组 u/v 轴，前提是草图没在面内旋转）；
        ///  3. 都不行就 u/v 置 null 并给 error 原因。</summary>
        public static List<object> SketchPlaneMapping(IModelDoc2 doc)
        {
            List<object> rows = new List<object>();
            foreach (IFeature feature in SwHost.Features(doc))
            {
                if (!IsSketchFeature(feature)) continue;
                rows.Add(SketchPlaneMapping(doc, feature));
            }
            return rows;
        }

        /// <summary>单张草图的 u/v/plane 映射。</summary>
        public static Dictionary<string, object> SketchPlaneMapping(IModelDoc2 doc, IFeature feature)
        {
            string name = null;
            try { name = feature == null ? null : feature.Name; }
            catch (COMException) { }

            ISketch sketch = null;
            try { sketch = feature == null ? null : feature.GetSpecificFeature2() as ISketch; }
            catch (COMException) { }

            string error = null;
            string source = null;
            double[] axes = null; // 9 个数：u(3) v(3) n(3)，模型坐标系
            double[] modelOrigin = null; // 草图原点在世界里的位置（米）

            if (sketch != null)
            {
                try
                {
                    IMathTransform xf = sketch.ModelToSketchTransform as IMathTransform;
                    double[] data = xf == null ? null : Doubles(xf.ArrayData);
                    if (data != null && data.Length >= 9)
                    {
                        // ArrayData 实测是列主序：前 9 个数按列排（col0=u, col1=v, col2=n），
                        // 直接按行读会把 u/v 混成 (ux,vx,nx)，实测把 -Z 报成 +Z。跨 3 取行。
                        axes = new double[] {
                            data[0], data[3], data[6],
                            data[1], data[4], data[7],
                            data[2], data[5], data[8] };
                        source = "sketchTransform";
                        // model→sketch 的平移落在 [9..11]；草图原点就是把它反解回模型
                        // 的那一点：origin = -R^T * t。只用于匹配参考面，取不到就算了。
                        if (data.Length >= 12)
                        {
                            double tx = data[9], ty = data[10], tz = data[11];
                            modelOrigin = new double[] {
                                -(axes[0] * tx + axes[3] * ty + axes[6] * tz),
                                -(axes[1] * tx + axes[4] * ty + axes[7] * tz),
                                -(axes[2] * tx + axes[5] * ty + axes[8] * tz) };
                        }
                    }
                    else
                        error = "ISketch.ModelToSketchTransform "
                            + (xf == null ? "is null" : "returned " + data.Length + " numbers");
                }
                catch (COMException ex)
                {
                    error = "ISketch.ModelToSketchTransform threw " + ex.Message;
                }
            }
            else
                error = "feature is not a sketch (GetSpecificFeature2 did not return ISketch)";

            if (axes == null)
            {
                // 退路：父级参考面的坐标系与草图 u/v 轴一致（草图画在面上时拿不到父面，
                // 那就如实 null 并保留原因）。
                double[] planeAxes;
                string why;
                if (TryParentPlaneAxes(feature, out planeAxes, out why))
                {
                    axes = planeAxes;
                    source = "parentRefPlane";
                    if (error != null) error = error + "; used the parent reference plane instead";
                    else error = null;
                }
                else
                    error = (error == null ? "" : error + "; ") + why;
            }

            int plane = RefPlaneOrdinal(doc, feature);
            // 父级关系拿不到时（草图画在实体面上、或 GetParents 没回答），按
            // 「法向平行 + 原点落在该面上」再认一次参考面；认不出就 null，不猜。
            if (plane < 0 && axes != null && modelOrigin != null)
                plane = RefPlaneOrdinalByGeometry(doc, axes, modelOrigin);
            string uWhy = null, vWhy = null;
            string u = axes == null ? null : AxisLabel(axes, 0, out uWhy);
            string v = axes == null ? null : AxisLabel(axes, 1, out vWhy);
            if (uWhy != null) error = error == null ? uWhy : error + "; " + uWhy;
            if (vWhy != null) error = error == null ? vWhy : error + "; " + vWhy;

            Dictionary<string, object> row = Json.Dict(
                "sketch", name,
                "plane", plane >= 0 ? (object)plane : null,
                "u", u,
                "v", v);
            // source 只是取证：调用方要的 u/v 为 null 时，这里说明是从哪一级退下来的。
            row["source"] = source;
            if (error != null) row["error"] = error;
            return row;
        }

        static bool IsSketchFeature(IFeature feature)
        {
            if (feature == null) return false;
            try
            {
                if (string.Equals(feature.GetTypeName2(), "ProfileFeature", StringComparison.Ordinal))
                    return true;
            }
            catch (COMException) { }
            try { return feature.GetSpecificFeature2() as ISketch != null; }
            catch (COMException) { return false; }
        }

        /// <summary>草图父级里那块参考面的坐标系（u/v/n 各 3 个数）。</summary>
        static bool TryParentPlaneAxes(IFeature feature, out double[] axes, out string why)
        {
            axes = null;
            why = null;
            if (feature == null) { why = "feature is null"; return false; }

            IFeature planeFeature = null;
            try
            {
                Array parents = feature.GetParents() as Array;
                if (parents != null)
                {
                    for (int i = 0; i < parents.Length; i++)
                    {
                        IFeature p = parents.GetValue(i) as IFeature;
                        if (p == null) continue;
                        string type = null;
                        try { type = p.GetTypeName2(); } catch (COMException) { }
                        if (string.Equals(type, "RefPlane", StringComparison.Ordinal)) { planeFeature = p; break; }
                    }
                }
            }
            catch (COMException ex)
            {
                why = "GetParents threw " + ex.Message;
                return false;
            }

            if (planeFeature == null)
            {
                why = "the sketch has no parent reference plane, so the u/v axes cannot be resolved";
                return false;
            }

            IRefPlane plane = null;
            try { plane = planeFeature.GetSpecificFeature2() as IRefPlane; }
            catch (COMException) { }
            IMathTransform xf = null;
            try { xf = plane == null ? null : plane.Transform as IMathTransform; }
            catch (COMException) { }
            double[] data = xf == null ? null : Doubles(xf.ArrayData);
            if (data == null || data.Length < 9)
            {
                why = "IRefPlane.Transform returned " + (data == null ? "nothing" : data.Length + " numbers");
                return false;
            }
            axes = new double[] {
                data[0], data[1], data[2],
                data[3], data[4], data[5],
                data[6], data[7], data[8] };
            return true;
        }

        /// <summary>草图/参考面在特征树里第几块参考面（0=前视，1=上视，2=右视，
        /// 偏移出来的参考面顺延）；不是参考面驱动就 -1。</summary>
        static int RefPlaneOrdinal(IModelDoc2 doc, IFeature feature)
        {
            if (doc == null || feature == null) return -1;
            try
            {
                Array parents = feature.GetParents() as Array;
                if (parents == null) return -1;
                for (int i = 0; i < parents.Length; i++)
                {
                    IFeature p = parents.GetValue(i) as IFeature;
                    if (p == null) continue;
                    string type = null;
                    try { type = p.GetTypeName2(); } catch (COMException) { }
                    if (!string.Equals(type, "RefPlane", StringComparison.Ordinal)) continue;

                    string target = p.Name;
                    IFeature f = (IFeature)doc.FirstFeature();
                    int seen = 0;
                    while (f != null)
                    {
                        string t = null;
                        try { t = f.GetTypeName2(); } catch (COMException) { }
                        if (string.Equals(t, "RefPlane", StringComparison.Ordinal))
                        {
                            if (string.Equals(f.Name, target, StringComparison.Ordinal)) return seen;
                            seen++;
                        }
                        f = (IFeature)f.GetNextFeature();
                    }
                    return -1;
                }
            }
            catch (COMException) { }
            return -1;
        }

        /// <summary>按几何认参考面：草图法向与参考面法向平行（|cos|&gt;0.999），
        /// 且草图原点落在该面"所在平面"上（距离 &lt; 0.05 mm）。只认第一个命中的，
        /// 命不中返回 -1 —— 「序号」不能靠猜，猜错比 null 更害人。</summary>
        static int RefPlaneOrdinalByGeometry(IModelDoc2 doc, double[] axes, double[] origin)
        {
            if (doc == null || axes == null || axes.Length < 9 || origin == null) return -1;
            double nx = axes[6], ny = axes[7], nz = axes[8];
            double n = Math.Sqrt(nx * nx + ny * ny + nz * nz);
            if (n < 1e-9) return -1;
            nx /= n; ny /= n; nz /= n;

            int seen = 0;
            IFeature f = null;
            try { f = (IFeature)doc.FirstFeature(); }
            catch (COMException) { return -1; }
            while (f != null)
            {
                string type = null;
                try { type = f.GetTypeName2(); } catch (COMException) { }
                if (string.Equals(type, "RefPlane", StringComparison.Ordinal))
                {
                    IRefPlane rp = null;
                    try { rp = f.GetSpecificFeature2() as IRefPlane; } catch (COMException) { }
                    IMathTransform xf = null;
                    try { xf = rp == null ? null : rp.Transform as IMathTransform; } catch (COMException) { }
                    double[] d = xf == null ? null : Doubles(xf.ArrayData);
                    if (d != null && d.Length >= 12)
                    {
                        double px = d[6], py = d[7], pz = d[8];
                        double pn = Math.Sqrt(px * px + py * py + pz * pz);
                        if (pn > 1e-9)
                        {
                            px /= pn; py /= pn; pz /= pn;
                            double dot = Math.Abs(nx * px + ny * py + nz * pz);
                            double dist = Math.Abs((origin[0] - d[9]) * px
                                + (origin[1] - d[10]) * py + (origin[2] - d[11]) * pz);
                            if (dot > 0.999 && dist < 5e-5) return seen;
                        }
                    }
                    seen++;
                }
                try { f = (IFeature)f.GetNextFeature(); }
                catch (COMException) { return -1; }
            }
            return -1;
        }
        static string AxisLabel(double[] axes, int row, out string why)
        {
            why = null;
            if (axes == null || axes.Length < 9) { why = "no axis data"; return null; }
            int b = row * 3;
            double x = axes[b], y = axes[b + 1], z = axes[b + 2];
            double len = Math.Sqrt(x * x + y * y + z * z);
            if (len < 1e-9) { why = (row == 0 ? "u" : "v") + " axis is degenerate (zero length)"; return null; }

            x /= len; y /= len; z /= len;
            double ax = Math.Abs(x), ay = Math.Abs(y), az = Math.Abs(z);
            string axis;
            double dominant;
            if (ax >= ay && ax >= az) { axis = x >= 0 ? "X" : "-X"; dominant = ax; }
            else if (ay >= az) { axis = y >= 0 ? "Y" : "-Y"; dominant = ay; }
            else { axis = z >= 0 ? "Z" : "-Z"; dominant = az; }

            // 0.9 ≈ 26°：再偏下去「=X」会误导调用方，宁可 null。
            if (dominant < 0.9)
            {
                why = (row == 0 ? "u" : "v") + " axis is not aligned with a world axis "
                    + "(cos=" + Math.Round(dominant, 4).ToString(System.Globalization.CultureInfo.InvariantCulture) + " to " + axis + ")";
                return null;
            }
            return axis;
        }

        /// <summary>COM 返回的 double 数组可能是 double[]（常见）也可能被编组成
        /// object[]；两种都接。</summary>
        static double[] Doubles(object raw)
        {
            if (raw == null) return null;
            double[] d = raw as double[];
            if (d != null) return d;
            Array arr = raw as Array;
            if (arr == null) return null;
            double[] copy = new double[arr.Length];
            for (int i = 0; i < arr.Length; i++)
            {
                object v = arr.GetValue(i);
                copy[i] = v == null ? 0 : Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture);
            }
            return copy;
        }

        public static Dictionary<string, object> MassProperties(IBody2 body)
        {
            double[] mp = (double[])body.GetMassProperties(0);
            if (mp == null || mp.Length < 5)
                return Json.Dict("volume", 0.0, "units", Json.Dict("volume", "mm3"));
            return Json.Dict(
                "volume", Math.Round(mp[3] * 1e9, 4),
                "area", Math.Round(mp[4] * 1e6, 4),
                "units", Json.Dict("volume", "mm3", "area", "mm2"));
        }

        /// <summary>Solid volume in mm3 - the cheapest numeric proof that a feature
        /// actually did something.</summary>
        public static double VolumeMm3(IBody2 body)
        {
            double[] mp = (double[])body.GetMassProperties(0);
            if (mp == null || mp.Length < 4) return 0;
            return mp[3] * 1e9;
        }

        /// <summary>Every planar and cylindrical face, expressed in model space.
        /// Cylinders are the backbone of hole verification: axis + radius survive
        /// renames and rebuilds, unlike feature names.</summary>
        public static List<object> Faces(IBody2 body)
        {
            List<object> list = new List<object>();
            Array faces = (Array)body.GetFaces();
            if (faces == null) return list;
            for (int i = 0; i < faces.Length; i++)
            {
                IFace2 face = (IFace2)faces.GetValue(i);
                ISurface surf = (ISurface)face.GetSurface();
                if (surf == null) continue;

                if (surf.IsPlane())
                {
                    double[] pp = (double[])surf.PlaneParams;
                    if (pp == null) continue;
                    list.Add(Json.Dict(
                        "kind", "plane",
                        "normal", Json.List(R(pp[0]), R(pp[1]), R(pp[2])),
                        "point", Json.List(R(pp[3]), R(pp[4]), R(pp[5]))));
                }
                else
                {
                    double[] cp = (double[])surf.CylinderParams;
                    if (cp == null) continue;
                    list.Add(Json.Dict(
                        "kind", "cylinder",
                        "axisPoint", Json.List(R(cp[0]), R(cp[1]), R(cp[2])),
                        "axisDir", Json.List(R(cp[3]), R(cp[4]), R(cp[5])),
                        "radius", R(cp[6])));
                }
            }
            return list;
        }

        static double R(double meters)
        {
            return Math.Round(meters * 1000.0, 4);
        }

        /// <summary>Distinct cylindrical holes, merged from coaxial half-cylinders.
        /// A through hole shows up as one or two coaxial cylinder faces.</summary>
        public static List<object> Holes(IBody2 body)
        {
            List<object> holes = new List<object>();
            foreach (object o in Faces(body))
            {
                Dictionary<string, object> f = Json.Obj(o);
                if (Json.Str(f, "kind") != "cylinder") continue;

                ArrayList point = Json.Arr(f["axisPoint"]);
                ArrayList dir = Json.Arr(f["axisDir"]);
                double radius = Json.ToDouble(f["radius"], 0);
                double px = Json.ToDouble(point[0], 0), py = Json.ToDouble(point[1], 0), pz = Json.ToDouble(point[2], 0);
                double dx = Json.ToDouble(dir[0], 0), dy = Json.ToDouble(dir[1], 0), dz = Json.ToDouble(dir[2], 0);

                bool merged = false;
                foreach (object e in holes)
                {
                    Dictionary<string, object> h = Json.Obj(e);
                    if (Math.Abs(Json.ToDouble(h["diameter"], 0) - radius * 2) > 0.02) continue;
                    ArrayList hd = Json.Arr(h["axisDir"]);
                    if (Math.Abs(Json.ToDouble(hd[0], 0) - dx) > 1e-3) continue;
                    if (Math.Abs(Json.ToDouble(hd[1], 0) - dy) > 1e-3) continue;
                    if (Math.Abs(Json.ToDouble(hd[2], 0) - dz) > 1e-3) continue;
                    ArrayList hp = Json.Arr(h["axisPoint"]);
                    // coaxial: the offset between axis points has no component
                    // perpendicular to the axis
                    double ox = px - Json.ToDouble(hp[0], 0);
                    double oy = py - Json.ToDouble(hp[1], 0);
                    double oz = pz - Json.ToDouble(hp[2], 0);
                    double along = ox * dx + oy * dy + oz * dz;
                    double perpX = ox - along * dx, perpY = oy - along * dy, perpZ = oz - along * dz;
                    if (perpX * perpX + perpY * perpY + perpZ * perpZ > 0.0004) continue;
                    merged = true;
                    break;
                }
                if (merged) continue;

                holes.Add(Json.Dict(
                    "diameter", Math.Round(radius * 2, 4),
                    "axisPoint", Json.List(px, py, pz),
                    "axisDir", Json.List(dx, dy, dz)));
            }
            return holes;
        }

        /// <summary>Flat, human-readable geometry snapshot used in every tool result.</summary>
        public static Dictionary<string, object> Snapshot(IModelDoc2 doc)
        {
            IPartDoc part = doc as IPartDoc;
            if (part == null)
            {
                // 装配体：以前这里直接回 kind="non-part"，于是 verify 的 assembly 档
                // 拿到的 geometry 里没有 components、也没有 interference，两行都记
                // unmeasured —— 而调用方以为"读过了"。这里给三样真实读数：组件数、
                // 各组件包围盒的并集、干涉（布尔交集体积）。
                IAssemblyDoc asm = doc as IAssemblyDoc;
                if (asm == null) return Json.Dict("kind", "non-part");

                int count = 0;
                double[] box = null;
                Array members = null;
                try { members = asm.GetComponents(false) as Array; } catch (COMException) { }
                if (members != null)
                {
                    foreach (object entry in members)
                    {
                        IComponent2 component = entry as IComponent2;
                        if (component == null) continue;
                        count++;
                        try
                        {
                            double[] b = component.GetBox(false, false) as double[];
                            if (b == null || b.Length < 6) continue;
                            if (box == null)
                            {
                                box = new double[] { b[0], b[1], b[2], b[3], b[4], b[5] };
                            }
                            else
                            {
                                for (int i = 0; i < 3; i++) if (b[i] < box[i]) box[i] = b[i];
                                for (int i = 3; i < 6; i++) if (b[i] > box[i]) box[i] = b[i];
                            }
                        }
                        catch (COMException) { }
                    }
                }

                Dictionary<string, object> asmBox = null;
                if (box != null)
                {
                    asmBox = Json.Dict(
                        "min", Json.List(Round(box[0] * 1000.0), Round(box[1] * 1000.0), Round(box[2] * 1000.0)),
                        "max", Json.List(Round(box[3] * 1000.0), Round(box[4] * 1000.0), Round(box[5] * 1000.0)),
                        "size", Json.List(Round((box[3] - box[0]) * 1000.0), Round((box[4] - box[1]) * 1000.0), Round((box[5] - box[2]) * 1000.0)),
                        "units", "mm");
                }
                return Json.Dict(
                    "kind", "assembly",
                    "components", count,
                    "boundingBox", asmBox,
                    "interference", AssemblyOps.InterferenceBlock(asm));
            }
            object raw = part.GetBodies2((int)swBodyType_e.swSolidBody, false);
            Array arr = raw as Array;
            if (arr == null || arr.Length == 0)
                return Json.Dict("kind", "part", "bodies", 0);

            IBody2 body = (IBody2)arr.GetValue(0);
            Dictionary<string, object> d = Json.Dict(
                "kind", "part",
                "bodies", arr.Length,
                "boundingBox", BoundingBox(body),
                "massProperties", MassProperties(body),
                "holes", Holes(body),
                "faces", ((Array)body.GetFaces()).Length);
            return d;
        }
    }
}

