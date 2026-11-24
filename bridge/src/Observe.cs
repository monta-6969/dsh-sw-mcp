using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Reading the model back: what faces exist, which one the user means,
    /// and where a 3D point lands on screen.
    ///
    /// Every selection the bridge makes is described by a *persistent reference*
    /// — the byte blob SOLIDWORKS itself uses to recognise a face across rebuilds.
    /// Names and indices are not usable for this: the tree renumbers, and face
    /// order changes when a feature is edited. A stable id is what lets a later
    /// call mean the same face the earlier call meant.
    /// </summary>
    sealed class Observe
    {
        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [DllImport("user32.dll")]
        static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")]
        static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        // ------------------------------------------------------------- open

        public static Dictionary<string, object> Open(Dictionary<string, object> req)
        {
            string path = Json.Str(req, "path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeError("BAD_ARGUMENT", "open requires \"path\"");
            // OpenDoc6 does not resolve relative paths — it fails with a generic
            // error instead. Normalise here so callers can pass either.
            path = Path.GetFullPath(path);
            if (!File.Exists(path))
                throw new BridgeError("FILE_NOT_FOUND", "no such file: " + path,
                    Json.Dict("path", path));

            using (SwHost h = SwHost.Attach())
            {
                int type = DocTypeFor(path);
                int errors = 0;
                int warnings = 0;
                IModelDoc2 doc = h.App.OpenDoc6(path, type,
                    (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "", ref errors, ref warnings);
                if (doc == null)
                {
                    throw new BridgeError("OPEN_FAILED",
                        "OpenDoc6 returned null (errors=" + errors + ", warnings=" + warnings + ")",
                        Json.Dict("path", path, "errors", errors, "warnings", warnings));
                }
                // OpenDoc6 with Silent does NOT make the document active — opening a second
                // part left the first one active, so "open B then capture" photographed A
                // and still reported success. Activate explicitly, every time.
                int activateErrors = 0;
                try
                {
                    h.App.ActivateDoc3(doc.GetTitle(), false,
                        (int)swRebuildOnActivation_e.swDontRebuildActiveDoc, ref activateErrors);
                }
                catch (Exception) { /* activation is best-effort; the caller still gets the doc */ }
                IModelDoc2 active = null;
                try { active = h.App.ActiveDoc as IModelDoc2; } catch (Exception) { }
                string activeTitle = active == null ? null : active.GetTitle();
                // open 也要登记 designId：以前这里只开文档不登记，随后所有带 designId 的
                // inspect/mate 都报 DOC_NOT_OPEN，调用方只能靠标题猜当前文档。
                string designId = Json.Str(req, "designId", null);
                if (!string.IsNullOrEmpty(designId))
                {
                    WorkRegistry.Record(designId, doc.GetTitle(), doc.GetPathName(),
                        WorkRegistry.OriginUnknown, Json.Str(req, "sessionId", null));
                }
                return Json.Dict(
                    "designId", designId,
                    "activeTitle", activeTitle,
                    "activeIsRequested", activeTitle == doc.GetTitle(),
                    "opened", true,
                    "path", path,
                    "title", doc.GetTitle(),
                    "type", type,
                    "errors", errors,
                    "warnings", warnings,
                    "faces", CountFaces(doc));
            }
        }

        static int DocTypeFor(string path)
        {
            string ext = Path.GetExtension(path).ToLowerInvariant();
            if (ext == ".sldasm") return (int)swDocumentTypes_e.swDocASSEMBLY;
            if (ext == ".slddrw") return (int)swDocumentTypes_e.swDocDRAWING;
            return (int)swDocumentTypes_e.swDocPART;
        }

        static int CountFaces(IModelDoc2 doc)
        {
            try
            {
                IBody2 body = Geometry.SingleBody(doc);
                if (body == null) return 0;
                return FacesOf(body).Count;
            }
            catch (Exception) { return 0; }
        }

        // ------------------------------------------------------------ faces

        public static Dictionary<string, object> Faces(Dictionary<string, object> req)
        {
            int limit = Json.Int(req, "limit", 200);
            bool withIds = Json.Bool(req, "persistentIds", true);
            bool withBox = Json.Bool(req, "box", true);

            using (SwHost h = SwHost.Attach())
            {
                // A2 第二类：faces 的参数里没有 designId 也能用（语义就是"读前台那份"）。
                // 带了就按 designId 找文档；没带则保持原行为，但返回体里标出
                // documentFallback / documentTitle，调用方别以为自己在读指定文档。
                bool fallback;
                IModelDoc2 doc = Operations.OptionalDesignDocument(h, req, "faces", out fallback);
                if (!(doc is IPartDoc))
                    throw new BridgeError("NOT_A_PART",
                        "faces only reads a part; the active document is " + doc.GetTitle()
                        + " — use inspect action=assembly for an assembly, or model action=drawing for a drawing");
                IModelDocExtension ext = doc.Extension;
                List<object> outFaces = new List<object>();

                int index = 0;
                foreach (IBody2 body in Bodies(doc))
                {
                    List<IFace2> faces = FacesOf(body);
                    for (int i = 0; i < faces.Count && outFaces.Count < limit; i++)
                    {
                        Dictionary<string, object> rec = DescribeFace(ext, faces[i], index, withIds, withBox);
                        if (rec == null) continue;
                        rec["bodyIndex"] = index;
                        rec["faceIndex"] = i;
                        outFaces.Add(rec);
                    }
                    index++;
                }

                // 有实体却没有面，说明这次读到的实体是空的（重建还没结束或 COM 读到旧状态）。
                // 返回「0 张面」比报错更危险：调用方会以为这个零件真的没有面。
                if (outFaces.Count == 0)
                    throw new BridgeError("NO_FACE",
                        "零件 " + doc.GetTitle() + " 有 " + Geometry.BodyCount(doc)
                        + " 个实体但没有读到任何面 —— 多半是重建还没结束。重试一次；仍然为空就先 EditRebuild3。");

                return Operations.MarkDocumentFallback(Json.Dict(
                    "count", outFaces.Count,
                    "faces", outFaces,
                    "document", Json.Dict("title", doc.GetTitle(), "path", doc.GetPathName())),
                    doc, fallback);
            }
        }

        // ------------------------------------------------------------ bodies

        // ------------------------------------------------------------- edges

        /// <summary>Every edge of the body, with the circle it lies on made explicit.
        ///
        /// Filleting "the round edge of the slot" needs a way to say which edge that
        /// is, and an edge index is not it: rebuilds renumber edges. This op reports
        /// what the selection filter actually sees — is the curve a circle, what radius
        /// the three sampled points give, at what height it sits, how long it is — so a
        /// filter that selects nothing can be diagnosed instead of guessed at.</summary>
        public static Dictionary<string, object> Edges(Dictionary<string, object> req)
        {
            bool arcsOnly = Json.Bool(req, "arcsOnly", false);
            using (SwHost h = SwHost.Attach())
            {
                bool fallback;
                IModelDoc2 doc = Operations.OptionalDesignDocument(h, req, "edges", out fallback);
                IBody2 body = Geometry.SingleBody(doc);
                Array edges = (Array)body.GetEdges();
                List<object> outEdges = new List<object>();
                if (edges != null)
                {
                    for (int i = 0; i < edges.Length; i++)
                    {
                        IEdge e = (IEdge)edges.GetValue(i);
                        ICurve curve = null;
                        bool isCircle = false;
                        double radiusMm = 0;
                        double midY = 0;
                        bool sampled = false;
                        double[] start = null;
                        double[] end = null;
                        try
                        {
                            curve = e.GetCurve() as ICurve;
                            if (curve != null)
                            {
                                isCircle = curve.IsCircle();
                                double t0, t1;
                                bool closed, periodic;
                                if (curve.GetEndParams(out t0, out t1, out closed, out periodic))
                                {
                                    start = (double[])curve.Evaluate(t0);
                                    double[] mid = (double[])curve.Evaluate((t0 + t1) / 2.0);
                                    end = (double[])curve.Evaluate(t1);
                                    if (start != null && mid != null && end != null)
                                    {
                                        sampled = true;
                                        midY = mid[1] * 1000.0;
                                        radiusMm = CircumradiusMm(start, mid, end);
                                    }
                                }
                            }
                        }
                        catch
                        {
                            sampled = false;
                        }

                        if (arcsOnly && !isCircle) continue;

                        List<object> rec = new List<object>();
                        rec.Add(Json.Dict("index", i, "isCircle", isCircle, "sampled", sampled,
                            "sampledRadiusMm", Json.R(radiusMm),
                            "midYMm", Json.R(midY),
                            "lengthMm", Json.R(EdgeLengthMm(e)),
                            "startMm", Point3(start), "endMm", Point3(end)));
                        outEdges.Add(rec[0]);
                    }
                }
                return Operations.MarkDocumentFallback(Json.Dict("count", outEdges.Count, "edges", outEdges,
                    "document", Json.Dict("title", doc.GetTitle(), "path", doc.GetPathName())), doc, fallback);
            }
        }

        static object Point3(double[] p)
        {
            if (p == null) return null;
            return Json.List(Json.R(p[0] * 1000.0), Json.R(p[1] * 1000.0), Json.R(p[2] * 1000.0));
        }

        static double CircumradiusMm(double[] a, double[] b, double[] c)
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
            double dx = c[0] - b[0], dy = c[1] - b[1], dz = c[2] - b[2];
            double lc = Math.Sqrt(dx * dx + dy * dy + dz * dz);
            return la * lb * lc / (2.0 * area2) * 1000.0;
        }

        /// <summary>Edge length by walking the curve. IEdge.GetLength exists on some
        /// builds and not others, and a length is only ever used as a hint here, so it
        /// is sampled rather than trusted.</summary>
        static double EdgeLengthMm(IEdge e)
        {
            try
            {
                ICurve curve = e.GetCurve() as ICurve;
                if (curve == null) return 0;
                double t0, t1;
                bool closed, periodic;
                if (!curve.GetEndParams(out t0, out t1, out closed, out periodic)) return 0;
                const int steps = 12;
                double total = 0;
                double[] prev = (double[])curve.Evaluate(t0);
                for (int i = 1; i <= steps; i++)
                {
                    double[] p = (double[])curve.Evaluate(t0 + (t1 - t0) * i / steps);
                    if (p == null || prev == null) return total * 1000.0;
                    double dx = p[0] - prev[0], dy = p[1] - prev[1], dz = p[2] - prev[2];
                    total += Math.Sqrt(dx * dx + dy * dy + dz * dz);
                    prev = p;
                }
                return total * 1000.0;
            }
            catch
            {
                return 0;
            }
        }

        /// <summary>One record per solid body: where it sits and how big it is.
        ///
        /// The single-body measurement elsewhere reports only the first body, so a part
        /// whose features landed as separate lumps still answers with a plausible volume
        /// and box. This op is how a caller notices there are two of them, and which way
        /// each one went.</summary>
        public static Dictionary<string, object> Bodies(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                bool fallback;
                IModelDoc2 doc = Operations.OptionalDesignDocument(h, req, "bodies", out fallback);
                if (!(doc is IPartDoc))
                    throw new BridgeError("NOT_A_PART",
                        "bodies only reads a part; the active document is " + doc.GetTitle());

                List<object> list = new List<object>();
                int index = 0;
                double total = 0;
                foreach (IBody2 body in Bodies(doc))
                {
                    Dictionary<string, object> box = Geometry.BoundingBox(body);
                    double volume = 0;
                    try
                    {
                        Array mp = body.GetMassProperties(1.0) as Array;
                        if (mp != null && mp.Length > 3)
                        {
                            volume = Math.Abs(Convert.ToDouble(mp.GetValue(3))) * 1e9;
                            total += volume;
                        }
                    }
                    catch (COMException) { }
                    list.Add(Json.Dict(
                        "index", index,
                        "volumeMm3", Json.R(volume),
                        "faces", FacesOf(body).Count,
                        "box", box));
                    index++;
                }

                return Operations.MarkDocumentFallback(Json.Dict(
                    "count", list.Count,
                    "bodies", list,
                    "totalVolumeMm3", Json.R(total),
                    "document", Json.Dict("title", doc.GetTitle(), "path", doc.GetPathName())), doc, fallback);
            }
        }

        static List<IBody2> Bodies(IModelDoc2 doc)
        {
            List<IBody2> list = new List<IBody2>();
            IPartDoc part = doc as IPartDoc;
            if (part == null) return list;
            object raw = part.GetBodies2((int)swBodyType_e.swSolidBody, false);
            Array arr = raw as Array;
            if (arr == null) return list;
            foreach (object o in arr)
            {
                IBody2 b = o as IBody2;
                if (b != null) list.Add(b);
            }
            return list;
        }

        static List<IFace2> FacesOf(IBody2 body)
        {
            List<IFace2> list = new List<IFace2>();
            object raw = body.GetFaces();
            Array arr = raw as Array;
            if (arr == null) return list;
            foreach (object o in arr)
            {
                IFace2 f = o as IFace2;
                if (f != null) list.Add(f);
            }
            return list;
        }

        static Dictionary<string, object> DescribeFace(IModelDocExtension ext, IFace2 face,
            int bodyIndex, bool withIds, bool withBox)
        {
            Dictionary<string, object> rec = Json.Dict("bodyIndex", bodyIndex);
            try
            {
                string kind = SurfaceKind(face);
                rec["kind"] = kind;
                rec["area"] = Math.Round(face.GetArea() * 1e6, 4);
            }
            catch (COMException) { return null; }

            if (withBox)
            {
                try
                {
                    double[] box = face.GetBox() as double[];
                    if (box != null && box.Length >= 6)
                    {
                        rec["box"] = new List<object>
                        {
                            Json.R(box[0] * 1000), Json.R(box[1] * 1000), Json.R(box[2] * 1000),
                            Json.R(box[3] * 1000), Json.R(box[4] * 1000), Json.R(box[5] * 1000)
                        };
                        // The face centre is the middle of its box, not the plane
                        // point: for a cylinder the plane point is meaningless.
                        rec["center"] = new List<object>
                        {
                            Json.R((box[0] + box[3]) * 500),
                            Json.R((box[1] + box[4]) * 500),
                            Json.R((box[2] + box[5]) * 500)
                        };
                    }
                }
                catch (COMException) { }
            }

            try
            {
                ISurface surf = face.GetSurface() as ISurface;
                if (surf != null && surf.IsPlane())
                {
                    double[] pp = surf.PlaneParams as double[];
                    if (pp != null && pp.Length >= 6)
                    {
                        // PlaneParams is the *surface* normal; the face may be the
                        // back side of it. Without this sign the top and bottom of
                        // a plate both report -Z and nothing can tell them apart.
                        double sense = face.FaceInSurfaceSense() ? -1.0 : 1.0;
                        double len = Math.Sqrt(pp[0] * pp[0] + pp[1] * pp[1] + pp[2] * pp[2]);
                        if (len > 1e-9)
                            rec["normal"] = new List<object>
                            {
                                Json.R(sense * pp[0] / len), Json.R(sense * pp[1] / len), Json.R(sense * pp[2] / len)
                            };
                        rec["planePoint"] = new List<object>
                        {
                            Json.R(pp[3] * 1000), Json.R(pp[4] * 1000), Json.R(pp[5] * 1000)
                        };
                    }
                }
            }
            catch (COMException) { }

            if (withIds)
            {
                string id = null;
                try
                {
                    object blob = ext.GetPersistReference3(face);
                    byte[] bytes = blob as byte[];
                    if (bytes != null && bytes.Length > 0) id = Hex(bytes);
                }
                catch (COMException) { }
                rec["id"] = id;
            }
            return rec;
        }

        static string SurfaceKind(IFace2 face)
        {
            ISurface s = face.GetSurface() as ISurface;
            if (s == null) return "unknown";
            if (s.IsPlane()) return "plane";
            if (s.IsCylinder()) return "cylinder";
            if (s.IsCone()) return "cone";
            if (s.IsSphere()) return "sphere";
            if (s.IsTorus()) return "torus";
            return "other";
        }

        // ----------------------------------------------------------- select

        public static Dictionary<string, object> Select(Dictionary<string, object> req)
        {
            string mode = Json.Str(req, "mode", "list");
            bool append = Json.Bool(req, "append", false);
            int mark = Json.Int(req, "mark", 0);

            using (SwHost h = SwHost.Attach())
            {
                bool fallback;
                IModelDoc2 doc = Operations.OptionalDesignDocument(h, req, "select", out fallback);
                IModelDocExtension ext = doc.Extension;
                if (!append) doc.ClearSelection2(true);

                Dictionary<string, object> outcome = Json.Dict("mode", mode);
                // A2 第二类：选择改的是文档状态，谁被选中必须说清楚。
                outcome["documentFallback"] = fallback;
                if (fallback)
                {
                    string fallbackTitle = null;
                    try { fallbackTitle = doc.GetTitle(); } catch (COMException) { }
                    outcome["documentTitle"] = fallbackTitle;
                }

                if (mode == "byId")
                {
                    // "persistentId" first: on the wire, "id" is the request's
                    // correlation field and is overwritten by the transport.
                    string id = Json.Str(req, "persistentId");
                    if (string.IsNullOrEmpty(id)) id = Json.Str(req, "id");
                    if (string.IsNullOrEmpty(id))
                        throw new BridgeError("BAD_ARGUMENT", "select byId requires \"persistentId\"");
                    byte[] bytes = Unhex(id);
                    int err = 0;
                    object target = ext.GetObjectByPersistReference3(bytes, out err);
                    if (target == null)
                    {
                        throw new BridgeError("STALE_SELECTION",
                            "persistent reference did not resolve (code " + err + "). The face was "
                            + "probably deleted or the model was rebuilt into a different shape.",
                            Json.Dict("id", id, "code", err));
                    }
                    IEntity entity = target as IEntity;
                    if (entity == null)
                        throw new BridgeError("NOT_SELECTABLE", "persistent reference is not an entity",
                            Json.Dict("type", target.GetType().Name));
                    bool ok = entity.Select2(append, mark);
                    outcome["selected"] = ok;
                    outcome["target"] = DescribeEntity(ext, target, "selection");
                }
                else if (mode == "byRay")
                {
                    double px = Json.Dbl(req, "x", 0);
                    double py = Json.Dbl(req, "y", 0);
                    double radius = Json.Dbl(req, "radius", 0.0001);
                    int typeWanted = Json.Int(req, "typeWanted", (int)swSelectType_e.swSelFACES);

                    IModelView view = doc.ActiveView as IModelView;
                    if (view == null) throw new BridgeError("NO_VIEW", "no active model view");
                    double ax, ay, az, bx, by, bz;
                    view.UnprojectModelPoint(px, py, 0, out ax, out ay, out az);
                    view.UnprojectModelPoint(px, py, 1, out bx, out by, out bz);
                    double dx = bx - ax, dy = by - ay, dz = bz - az;
                    double len = Math.Sqrt(dx * dx + dy * dy + dz * dz);
                    if (len < 1e-12) throw new BridgeError("NO_RAY", "unproject produced a zero-length ray");
                    dx /= len; dy /= len; dz /= len;

                    bool ok = ext.SelectByRay(ax, ay, az, dx, dy, dz, radius, typeWanted,
                        append, mark, Json.Int(req, "option", 0));
                    outcome["selected"] = ok;
                    outcome["ray"] = Json.Dict(
                        "from", new List<object> { Json.R(ax), Json.R(ay), Json.R(az) },
                        "dir", new List<object> { Json.R(dx), Json.R(dy), Json.R(dz) },
                        "pixel", new List<object> { Json.R(px), Json.R(py) });
                }
                else if (mode == "byName")
                {
                    string name = Json.Str(req, "name");
                    string type = Json.Str(req, "type", "PLANE");
                    bool ok = ext.SelectByID2(name, type, 0, 0, 0, append, mark, null,
                        Json.Int(req, "option", 0));
                    outcome["selected"] = ok;
                }
                else if (mode == "clear")
                {
                    outcome["selected"] = true;
                }
                else if (mode != "list")
                {
                    throw new BridgeError("BAD_ARGUMENT", "unknown select mode \"" + mode + "\"",
                        Json.Dict("supported", new List<object> { "byId", "byRay", "byName", "clear", "list" }));
                }

                outcome["selection"] = CurrentSelection(ext, doc);
                return outcome;
            }
        }

        static Dictionary<string, object> CurrentSelection(IModelDocExtension ext, IModelDoc2 doc)
        {
            ISelectionMgr sel = doc.SelectionManager as ISelectionMgr;
            List<object> items = new List<object>();
            int count = 0;
            try { count = sel.GetSelectedObjectCount2(-1); }
            catch (Exception) { }
            for (int i = 1; i <= count; i++)
            {
                object obj = null;
                int typeCode = 0;
                try
                {
                    obj = sel.GetSelectedObject6(i, -1);
                    typeCode = sel.GetSelectedObjectType3(i, -1);
                }
                catch (Exception) { }
                if (obj == null) continue;
                Dictionary<string, object> rec = DescribeEntity(ext, obj, "selected");
                rec["index"] = i;
                rec["typeCode"] = typeCode;
                rec["typeName"] = SelectTypeName(typeCode);
                items.Add(rec);
            }
            return Json.Dict("count", items.Count, "items", items);
        }

        static string SelectTypeName(int code)
        {
            try { return ((swSelectType_e)code).ToString(); }
            catch (Exception) { return "code:" + code; }
        }

        static Dictionary<string, object> DescribeEntity(IModelDocExtension ext, object obj, string label)
        {
            Dictionary<string, object> rec = Json.Dict("kind", EntityKind(obj), "label", label);
            string id = null;
            try
            {
                object blob = ext.GetPersistReference3(obj);
                byte[] bytes = blob as byte[];
                if (bytes != null && bytes.Length > 0) id = Hex(bytes);
            }
            catch (COMException) { }
            rec["id"] = id;

            IFace2 face = obj as IFace2;
            if (face != null)
            {
                try { rec["surface"] = SurfaceKind(face); } catch (COMException) { }
                try { rec["area"] = Math.Round(face.GetArea() * 1e6, 4); } catch (COMException) { }
            }
            IFeature feat = obj as IFeature;
            if (feat != null)
            {
                try { rec["name"] = feat.Name; } catch (COMException) { }
                try { rec["type"] = feat.GetTypeName2(); } catch (COMException) { }
            }
            return rec;
        }

        static string EntityKind(object obj)
        {
            if (obj == null) return "null";
            if (obj is IFace2) return "face";
            if (obj is IEdge) return "edge";
            if (obj is IVertex) return "vertex";
            if (obj is IFeature) return "feature";
            if (obj is IBody2) return "body";
            return "other";
        }

        // ---------------------------------------------------------- project

        public static Dictionary<string, object> Project(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                bool fallback;
                IModelDoc2 doc = Operations.OptionalDesignDocument(h, req, "project", out fallback);
                IModelView view = doc.ActiveView as IModelView;
                if (view == null) throw new BridgeError("NO_VIEW", "no active model view");

                List<object> outPoints = new List<object>();
                foreach (object raw in Json.Items(req.ContainsKey("points") ? req["points"] : null))
                {
                    double[] p = ToDoubles(raw);
                    if (p == null || p.Length < 3) continue;
                    outPoints.Add(ProjectPoint(view, p[0], p[1], p[2]));
                }

                return Operations.MarkDocumentFallback(Json.Dict(
                    "count", outPoints.Count,
                    "points", outPoints,
                    "document", Json.Dict("title", doc.GetTitle(), "path", doc.GetPathName()),
                    "view", ViewInfo(view)), doc, fallback);
            }
        }

        static List<object> ProjectPoint(IModelView view, double x, double y, double z)
        {
            double ox, oy, oz;
            // Input is millimetres (what every other op speaks); the API wants metres.
            view.ProjectModelPoint(x / 1000.0, y / 1000.0, z / 1000.0, out ox, out oy, out oz);
            return new List<object> { Json.R(ox), Json.R(oy), Json.R(oz) };
        }

        static Dictionary<string, object> ViewInfo(IModelView view)
        {
            int w = 0, h = 0, left = 0, top = 0, right = 0, bottom = 0;
            try
            {
                IntPtr hwnd = (IntPtr)view.GetViewHWnd();
                RECT r;
                if (GetClientRect(hwnd, out r))
                {
                    w = r.Right - r.Left;
                    h = r.Bottom - r.Top;
                }
                RECT wr;
                if (GetWindowRect(hwnd, out wr))
                {
                    left = wr.Left; top = wr.Top; right = wr.Right; bottom = wr.Bottom;
                }
            }
            catch (Exception) { }
            return Json.Dict(
                "clientWidth", w, "clientHeight", h,
                "windowLeft", left, "windowTop", top, "windowRight", right, "windowBottom", bottom);
        }

        static double[] ToDoubles(object raw)
        {
            // JSON arrays arrive as ArrayList, COM arrays as object[]: accepting
            // only one of the two silently turned every request into an empty result.
            ArrayList list = Json.Arr(raw);
            if (list == null) return null;
            double[] outp = new double[list.Count];
            for (int i = 0; i < list.Count; i++)
                outp[i] = Json.ToDouble(list[i], 0);
            return outp;
        }

        // ---------------------------------------------------------- drawing

        // --------------------------------------------------------- rendering

        /// <summary>Renders the model to a file, transcoding when the caller asks
        /// for PNG.
        ///
        /// SaveBMP is the only raster export SOLIDWORKS offers, and an MCP image
        /// part has to be PNG or JPEG to be displayed. Converting here keeps the
        /// whole BMP-to-PNG detail inside the one process that already has GDI+.</summary>
        public static string RenderTo(IModelDoc2 doc, string path, int width, int height)
        {
            string ext = (Path.GetExtension(path) ?? "").ToLowerInvariant();
            if (ext != ".png") return doc.SaveBMP(path, width, height) ? path : null;

            string temp = Path.Combine(Path.GetDirectoryName(path) ?? ".",
                Path.GetFileNameWithoutExtension(path) + ".tmp.bmp");
            try
            {
                if (!doc.SaveBMP(temp, width, height)) return null;
                using (Bitmap loaded = new Bitmap(temp))
                {
                    Bitmap canvas = new Bitmap(loaded.Width, loaded.Height,
                        System.Drawing.Imaging.PixelFormat.Format24bppRgb);
                    using (Graphics copy = Graphics.FromImage(canvas))
                        copy.DrawImageUnscaled(loaded, 0, 0);
                    using (canvas)
                        canvas.Save(path, System.Drawing.Imaging.ImageFormat.Png);
                }
                return path;
            }
            finally
            {
                try { if (File.Exists(temp)) File.Delete(temp); } catch (Exception) { }
            }
        }

        // ------------------------------------------------------- annotating

        /// <summary>Selects entities so SOLIDWORKS draws them highlighted.
        ///
        /// The first attempt drew circles at projected coordinates, and they
        /// landed in the wrong place: SaveBMP frames the model itself, and its
        /// framing does not match the space ProjectModelPoint reports. Rather
        /// than reverse-engineer two private framings, the highlight is made by
        /// the renderer that owns the pixels — it cannot be off by a margin.
        /// Callers get the ids back so the picture and the JSON agree.</summary>
        public static Dictionary<string, object> Highlight(IModelDoc2 doc, List<object> ids)
        {
            Dictionary<string, object> result = Json.Dict("requested", ids == null ? 0 : ids.Count);
            List<object> applied = new List<object>();
            List<object> failed = new List<object>();
            if (ids == null || ids.Count == 0)
            {
                result["applied"] = applied;
                result["failed"] = failed;
                result["count"] = 0;
                return result;
            }

            IModelDocExtension ext = doc.Extension;
            doc.ClearSelection2(true);
            foreach (object raw in ids)
            {
                string id = raw as string;
                if (string.IsNullOrEmpty(id)) continue;
                try
                {
                    int err = 0;
                    object target = ext.GetObjectByPersistReference3(Unhex(id), out err);
                    IEntity entity = target as IEntity;
                    if (entity == null)
                    {
                        failed.Add(Json.Dict("id", id, "reason", "not an entity"));
                        continue;
                    }
                    entity.Select2(true, 0);
                    applied.Add(id);
                }
                catch (BridgeError be)
                {
                    failed.Add(Json.Dict("id", id, "reason", be.Code));
                }
                catch (COMException ex)
                {
                    failed.Add(Json.Dict("id", id, "reason", ex.Message));
                }
            }
            result["applied"] = applied;
            result["failed"] = failed;
            result["count"] = applied.Count;
            return result;
        }

        /// <summary>Writes one line of text into a corner of the bitmap.
        ///
        /// Text only: it makes no claim about where anything is in the picture,
        /// so it stays true whatever framing SOLIDWORKS chose.</summary>
        public static void DrawCaption(string path, string caption)
        {
            if (string.IsNullOrEmpty(caption) || !File.Exists(path)) return;

            Bitmap canvas;
            using (Bitmap loaded = new Bitmap(path))
            {
                canvas = new Bitmap(loaded.Width, loaded.Height,
                    System.Drawing.Imaging.PixelFormat.Format24bppRgb);
                using (Graphics copy = Graphics.FromImage(canvas))
                    copy.DrawImageUnscaled(loaded, 0, 0);
            }

            using (canvas)
            using (Graphics g = Graphics.FromImage(canvas))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (Font font = new Font("Microsoft YaHei", 11f, FontStyle.Bold))
                {
                    SizeF size = g.MeasureString(caption, font);
                    int pad = 10;
                    using (Brush back = new SolidBrush(Color.FromArgb(190, 20, 20, 20)))
                        g.FillRectangle(back, pad, pad, size.Width + 16, size.Height + 12);
                    using (Brush ink = new SolidBrush(Color.FromArgb(245, 245, 245)))
                        g.DrawString(caption, font, ink, pad + 8, pad + 6);
                }
                // The caption must not silently change the file's format: the
                // whole point of RenderTo is that a .png request really is PNG.
                canvas.Save(path, path.EndsWith(".png", StringComparison.OrdinalIgnoreCase)
                    ? System.Drawing.Imaging.ImageFormat.Png
                    : System.Drawing.Imaging.ImageFormat.Bmp);
            }
        }

        // ------------------------------------------------------------ bytes

        static string Hex(byte[] bytes)
        {
            StringBuilder sb = new StringBuilder(bytes.Length * 2);
            foreach (byte b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        /// <summary>Parses a hex persistent id. Written by hand rather than with
        /// Convert.ToByte(value, 16) because a malformed id must come back as
        /// BAD_ARGUMENT — a raw FormatException escapes as INTERNAL_ERROR and tells
        /// the caller nothing about what to fix.</summary>
        static byte[] Unhex(string hex)
        {
            if (string.IsNullOrEmpty(hex) || hex.Length % 2 != 0)
                throw new BridgeError("BAD_ARGUMENT", "persistent id must be an even-length hex string",
                    Json.Dict("length", hex == null ? 0 : hex.Length));
            byte[] bytes = new byte[hex.Length / 2];
            for (int i = 0; i < bytes.Length; i++)
            {
                int hi = HexDigit(hex[i * 2]);
                int lo = HexDigit(hex[i * 2 + 1]);
                if (hi < 0 || lo < 0)
                    throw new BridgeError("BAD_ARGUMENT", "persistent id contains a non-hex character",
                        Json.Dict("at", i * 2));
                bytes[i] = (byte)((hi << 4) | lo);
            }
            return bytes;
        }

        static int HexDigit(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        }
    }
}
