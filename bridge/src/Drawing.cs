using System;
using System.Collections.Generic;
using System.IO;
using SolidWorks.Interop.sldworks;

namespace SwMcp
{
    /// <summary>Drawings.
    ///
    /// Two things did not work here and are worth remembering:
    /// Create3rdAngleViews2 returns True when the model is already open but leaves
    /// a sheet with no real views; CreateDrawViewFromModelView3 always returns null.
    /// GenerateViewPaletteViews + DropDrawingViewFromPalette2 is the path that
    /// actually produces geometry, so that is the only one implemented — the others
    /// are not "wrapped and untested", they are known-dead and left out.
    ///
    /// 2026-11-20：回包说 dropped:3、PDF 却是空白图框。根因不是"视图没生成"，而是
    /// DropDrawingViewFromPalette2 的 (X,Y) 只是"建议位置"：视图落下去以后没人读过它
    /// 真实的包围盒，也没人在导出前重建。于是三张视图互相叠着、或者压在标题栏下面，
    /// 导出的 PDF 只看得见图框。现在 drop 之后一律 GetOutline() 回读，按真实包围盒
    /// 把整组挪到"图框内、标题栏外"的空白区，重建一次再存盘。</summary>
    static class Drawing
    {
        const string DefaultSheet = "gb_a3.drwdot";

        public static Dictionary<string, object> New(Dictionary<string, object> req)
        {
            string template = Template(req);
            if (!File.Exists(template))
                throw new BridgeError("TEMPLATE_NOT_FOUND", "drawing template not found: " + template);

            using (SwHost h = SwHost.Attach())
            {
                IModelDoc2 doc = (IModelDoc2)h.App.NewDocument(template, 0, 0, 0);
                if (doc == null) throw new BridgeError("NEW_DOCUMENT_FAILED", "could not create a drawing");

                IDrawingDoc drawing = doc as IDrawingDoc;
                if (drawing == null)
                    throw new BridgeError("NEW_DOCUMENT_FAILED", "the new document is not a drawing");

                bool saved = SaveIfAsked(doc, Json.Str(req, "path", null));
                return Json.Dict(
                    "document", Json.Dict("title", doc.GetTitle(), "path", doc.GetPathName(), "type", "drawing"),
                    "saved", saved,
                    "template", template,
                    "sheets", SheetNames(drawing),
                    "viewCount", drawing.GetViewCount());
            }
        }

        /// <summary>Puts views of a model on a sheet, then reports what is actually
        /// on the sheet: the palette call can return true and still drop nothing.</summary>
        public static Dictionary<string, object> Views(Dictionary<string, object> req)
        {
            string model = Json.Str(req, "model", null);
            if (string.IsNullOrEmpty(model) || !File.Exists(model))
                throw new BridgeError("FILE_NOT_FOUND", "model to draw does not exist: " + model);
            model = Path.GetFullPath(model);

            string template = Template(req);
            if (!File.Exists(template))
                throw new BridgeError("TEMPLATE_NOT_FOUND", "drawing template not found: " + template);

            List<string> wanted = new List<string>();
            foreach (object entry in Json.Items(req.ContainsKey("views") ? req["views"] : null))
            {
                string name = entry as string;
                if (!string.IsNullOrEmpty(name)) wanted.Add(name);
            }
            if (wanted.Count == 0) wanted.Add("*前视");

            using (SwHost h = SwHost.Attach())
            {
                // The palette is built from the model, so the model has to be open.
                int openErrors = 0, openWarnings = 0;
                IModelDoc2 modelDoc = h.App.OpenDoc6(model, SwHost.DocTypeOf(model),
                    (int)SolidWorks.Interop.swconst.swOpenDocOptions_e.swOpenDocOptions_Silent,
                    "", ref openErrors, ref openWarnings);
                bool modelWasOpen = modelDoc != null;

                IModelDoc2 doc = (IModelDoc2)h.App.NewDocument(template, 0, 0, 0);
                if (doc == null) throw new BridgeError("NEW_DOCUMENT_FAILED", "could not create a drawing");
                IDrawingDoc drawing = doc as IDrawingDoc;
                if (drawing == null) throw new BridgeError("NEW_DOCUMENT_FAILED", "the new document is not a drawing");

                // 视图位置按投影法排：第一角是「俯视图在主视下方、左视图在主视右方」，
                // 第三角反过来。不按这个排，图纸上写「第一角」就只是一句声明。
                List<object> palette = new List<object>();
                bool paletteOk = false;
                // 投影法先定，再放视图：图纸是「往哪边投」的约定，放完再改，视图会留在原地。
                Dictionary<string, object> projection = SetProjection(drawing, req);
                LayoutPlan layout = LayoutPlan.Build(drawing, projection, modelDoc, wanted);

                try
                {
                    paletteOk = drawing.GenerateViewPaletteViews(model);
                    object names = drawing.GetDrawingPaletteViewNames();
                    foreach (object name in Json.Items(names))
                    {
                        string paletteName = name as string;
                        if (paletteName != null) palette.Add(paletteName);
                    }
                }
                catch (System.Runtime.InteropServices.COMException ex)
                {
                    palette.Add("palette threw: " + ex.Message);
                }

                List<object> dropped = new List<object>();
                List<object> missed = new List<object>();
                List<IView> placed = new List<IView>();
                int viewsBefore = drawing.GetViewCount();
                foreach (string name in wanted)
                {
                    double[] at = layout.PositionOf(name, placed.Count);
                    object view = null;
                    try
                    {
                        view = drawing.DropDrawingViewFromPalette2(name, at[0], at[1], 0);
                    }
                    catch (System.Runtime.InteropServices.COMException ex)
                    {
                        missed.Add(Json.Dict("view", name, "reason", "COMException", "message", ex.Message));
                        continue;
                    }

                    IView drawingView = view as IView;
                    if (drawingView == null)
                    {
                        missed.Add(Json.Dict("view", name, "reason", "DROPPED_NOTHING"));
                        continue;
                    }
                    placed.Add(drawingView);
                    dropped.Add(Json.Dict("requested", name, "name", drawingView.GetName2(),
                        "scale", drawingView.ScaleDecimal,
                        "at", Json.List(Json.R(at[0] * 1000), Json.R(at[1] * 1000))));
                }

                // 落位回读：drop 的坐标是「请求的位置」，不代表视图真的画在哪。
                bool rebuilt = false;
                try { rebuilt = doc.EditRebuild3(); }
                catch (System.Runtime.InteropServices.COMException) { }

                List<double[]> before = Outlines(placed);
                double[] unionBefore = Union(before);
                double[] free = FreeArea(drawing, layout);

                bool moved = false;
                double dx = 0, dy = 0;
                double[] unionAfter = unionBefore;
                if (unionBefore != null && unionBefore[0] <= unionBefore[2] && unionBefore[1] <= unionBefore[3])
                {
                    double cx = (unionBefore[0] + unionBefore[2]) / 2.0;
                    double cy = (unionBefore[1] + unionBefore[3]) / 2.0;
                    double tx = (free[0] + free[2]) / 2.0;
                    double ty = (free[1] + free[3]) / 2.0;
                    dx = tx - cx;
                    dy = ty - cy;
                    // 小于 0.5 mm 的位移不值得动视图：动了反而让「位置可重复」变难。
                    if (Math.Abs(dx) > 0.0005 || Math.Abs(dy) > 0.0005)
                    {
                        int ok = 0;
                        foreach (IView v in placed)
                        {
                            try
                            {
                                object rawPos = v.Position;
                                double[] pos = rawPos as double[];
                                if (pos == null || pos.Length < 2) continue;
                                v.Position = new double[] { pos[0] + dx, pos[1] + dy };
                                ok++;
                            }
                            catch (System.Runtime.InteropServices.COMException) { }
                        }
                        moved = ok > 0;
                        if (moved)
                        {
                            try { doc.EditRebuild3(); }
                            catch (System.Runtime.InteropServices.COMException) { }
                            unionAfter = Union(Outlines(placed));
                        }
                    }
                }

                List<object> outlineRows = new List<object>();
                for (int i = 0; i < placed.Count; i++)
                {
                    double[] b = i < before.Count ? before[i] : null;
                    outlineRows.Add(Json.Dict(
                        "view", placed[i].GetName2(),
                        "outlineMm", BoxMm(b),
                        "widthMm", b == null ? 0.0 : Json.R((b[2] - b[0]) * 1000),
                        "heightMm", b == null ? 0.0 : Json.R((b[3] - b[1]) * 1000)));
                }

                int viewsAfter = drawing.GetViewCount();
                // 导出前再建一次：SaveAs 到 PDF 走的是文档的显示数据，脏的显示数据
                // 会导出一张只有图框的空白页（这个坑昨晚踩过一次）。
                try { doc.ForceRebuild3(false); }
                catch (System.Runtime.InteropServices.COMException) { }

                bool saved = SaveIfAsked(doc, Json.Str(req, "path", null));
                long size = 0;
                string savedPath = doc.GetPathName();
                if (!string.IsNullOrEmpty(savedPath) && File.Exists(savedPath)) size = new FileInfo(savedPath).Length;
                // 导出 PDF/DXF 时文档路径不变（SaveAs 只写目标文件），拿 GetPathName 读大小
                // 永远得 0，于是回包里的 bytes:0 被读成"没存成功"。按请求的目标路径补读一次。
                string targetPath = Json.Str(req, "path", null);
                if (!string.IsNullOrEmpty(targetPath))
                {
                    string full = Path.GetFullPath(targetPath);
                    if (File.Exists(full)) size = new FileInfo(full).Length;
                }

                List<string> notes = new List<string>();
                if (!paletteOk) notes.Add("GenerateViewPaletteViews 返回 false");
                if (viewsAfter <= viewsBefore && placed.Count == 0)
                    notes.Add("图纸上没有任何视图 —— 导出的 PDF 会是空白页，不要当成交付");
                if (!modelWasOpen) notes.Add("模型原本没打开，为了生成视图调用了 OpenDoc6");
                if (moved) notes.Add("视图按真实包围盒重新落位（drop 的坐标只是建议）");
                if (unionAfter == null)
                    notes.Add("读不到视图包围盒：PDF 里可能只有图框");
                else if (unionAfter[0] < 0 || unionAfter[1] < 0 || unionAfter[2] > free[2] + 0.04 || unionAfter[3] > free[3] + 0.04)
                    notes.Add("视图包围盒超出图纸可用区，导出会被裁掉");

                return Json.Dict(
                    "drawing", Json.Dict(
                        "title", doc.GetTitle(),
                        "path", savedPath,
                        "type", "drawing",
                        "bytes", size),
                    "model", model,
                    "paletteOk", paletteOk,
                    "palette", palette,
                    "requested", wanted,
                    "dropped", dropped,
                    "missed", missed,
                    "views", outlineRows,
                    "unionBeforeMm", BoxMm(unionBefore),
                    "unionAfterMm", BoxMm(unionAfter),
                    "freeAreaMm", BoxMm(free),
                    "repositioned", moved,
                    "shiftMm", Json.List(Json.R(dx * 1000), Json.R(dy * 1000)),
                    "rebuild", rebuilt,
                    "viewCountBefore", viewsBefore,
                    "viewCountAfter", viewsAfter,
                    "saved", saved,
                    "projection", projection,
                    "notes", notes);
            }
        }

        static List<double[]> Outlines(List<IView> views)
        {
            List<double[]> rows = new List<double[]>();
            foreach (IView v in views)
            {
                double[] box = null;
                try { box = v.GetOutline() as double[]; }
                catch (System.Runtime.InteropServices.COMException) { }
                rows.Add(box);
            }
            return rows;
        }

        static double[] Union(List<double[]> boxes)
        {
            double[] u = null;
            foreach (double[] b in boxes)
            {
                if (b == null || b.Length < 4) continue;
                if (b[2] < b[0] || b[3] < b[1]) continue;
                if (u == null) { u = new double[] { b[0], b[1], b[2], b[3] }; continue; }
                if (b[0] < u[0]) u[0] = b[0];
                if (b[1] < u[1]) u[1] = b[1];
                if (b[2] > u[2]) u[2] = b[2];
                if (b[3] > u[3]) u[3] = b[3];
            }
            return u;
        }

        static object BoxMm(double[] box)
        {
            if (box == null || box.Length < 4) return null;
            return Json.List(Json.R(box[0] * 1000), Json.R(box[1] * 1000),
                Json.R(box[2] * 1000), Json.R(box[3] * 1000));
        }

        /// <summary>可放视图的区域（米）：去掉图框边距和右下角标题栏。
        /// 标题栏占了图纸下方一整条，视图压上去就会被白底盖住 —— 昨晚的"空白 PDF"
        /// 有一半是这么来的。</summary>
        static double[] FreeArea(IDrawingDoc drawing, LayoutPlan layout)
        {
            double sheetW = 420, sheetH = 297;
            if (layout != null && layout.SheetMm != null && layout.SheetMm.Length >= 2)
            {
                sheetW = layout.SheetMm[0];
                sheetH = layout.SheetMm[1];
            }
            double border = 15;      // 图框内边距
            double titleH = 60;      // 标题栏高度（GB A3 约 56）
            return new double[] { border / 1000.0, titleH / 1000.0,
                (sheetW - border) / 1000.0, (sheetH - border) / 1000.0 };
        }

        /// <summary>Sets the sheet's projection type (first vs third angle).
        ///
        /// This is not cosmetic: it decides which side the left view lands on. A
        /// first-angle sheet puts the left view on the right of the front view; a
        /// third-angle sheet puts it on the left. Everything downstream — "this is the
        /// left view" — depends on getting it right, so the value is read back and
        /// returned rather than assumed.
        ///
        /// ISheet.SetProperties2(PaperSz, Templ, Scale1, Scale2, FirstAngle, Width,
        /// Height, SameCustomPropAsSheetInDocProp) keeps the sheet's current paper size
        /// and scale: only the projection flag is ours to change.</summary>
        static Dictionary<string, object> SetProjection(IDrawingDoc drawing, Dictionary<string, object> req)
        {
            string requested = Json.Str(req, "projection", null);
            Dictionary<string, object> record = Json.Dict();
            try
            {
                SolidWorks.Interop.sldworks.Sheet sheet = drawing.GetCurrentSheet() as SolidWorks.Interop.sldworks.Sheet;
                if (sheet == null)
                {
                    record["error"] = "no current sheet";
                    return record;
                }

                object raw = sheet.GetProperties2();
                double[] props = raw as double[];
                if (props == null || props.Length < 7)
                {
                    record["error"] = "GetProperties2 returned " + (raw == null ? "null" : raw.GetType().Name);
                    return record;
                }

                int paperSize = (int)props[0];
                int template = (int)props[1];
                bool firstAngle = props[4] != 0;
                record["before"] = firstAngle ? "first" : "third";
                record["sheet"] = sheet.GetName();

                if (requested == null)
                {
                    record["requested"] = null;
                    record["after"] = record["before"];
                    return record;
                }

                bool want = requested == "first";
                if (want != firstAngle)
                {
                    sheet.SetProperties2(paperSize, template, props[2], props[3], want,
                        props[5], props[6], false);
                }

                object readBack = sheet.GetProperties2();
                double[] after = readBack as double[];
                bool nowFirst = after != null && after.Length >= 5 && after[4] != 0;
                record["requested"] = requested;
                record["after"] = nowFirst ? "first" : "third";
                record["applied"] = want == nowFirst;
                if (!(want == nowFirst))
                    record["warning"] = "SOLIDWORKS read back the opposite projection type";
            }
            catch (System.Runtime.InteropServices.COMException ex)
            {
                record["error"] = ex.Message;
            }
            return record;
        }

        /// <summary>Where each view goes, and at what scale, on the sheet.
        ///
        /// The projection type decides the arrangement: first angle puts the top view
        /// below the front view and the left view to its right; third angle puts the top
        /// view above and the left view to the left. Dropping views at fixed
        /// coordinates instead would make "this is the first-angle sheet" a claim about
        /// a flag rather than about the picture.
        ///
        /// The scale is chosen so everything fits: a 225 mm part at 1:1 does not leave
        /// room for the top view on an A3 sheet.</summary>
        sealed class LayoutPlan
        {
            public int Denominator = 1;
            public bool Fits = true;
            readonly List<string> _names = new List<string>();
            readonly List<double[]> _positions = new List<double[]>();  // metres
            public double[] SizeMm;      // model bounding box
            public double[] SheetMm;

            public double[] PositionOf(string name, int fallbackIndex)
            {
                int at = _names.IndexOf(name);
                if (at >= 0) return _positions[at];
                // Unknown view name: park it to the right of what is already placed.
                double x = 0.03 + 0.12 * fallbackIndex;
                return new double[] { x, 0.03 };
            }

            public static LayoutPlan Build(IDrawingDoc drawing, Dictionary<string, object> projection,
                IModelDoc2 modelDoc, List<string> wanted)
            {
                LayoutPlan plan = new LayoutPlan();
                double[] sizeMm = { 100, 60, 20 };
                try
                {
                    IBody2 body = Geometry.SingleBody(modelDoc);
                    Dictionary<string, object> bounds = Geometry.BoundingBox(body);
                    if (bounds != null && bounds.ContainsKey("min") && bounds.ContainsKey("max"))
                    {
                        double[] min = bounds["min"] as double[];
                        double[] max = bounds["max"] as double[];
                        if (min != null && max != null && min.Length >= 3 && max.Length >= 3)
                            sizeMm = new double[] { max[0] - min[0], max[1] - min[1], max[2] - min[2] };
                    }
                }
                catch (System.Runtime.InteropServices.COMException) { }
                plan.SizeMm = sizeMm;

                double sheetW = 420, sheetH = 297;
                try
                {
                    SolidWorks.Interop.sldworks.Sheet sheet = drawing.GetCurrentSheet() as SolidWorks.Interop.sldworks.Sheet;
                    object raw = sheet == null ? null : sheet.GetProperties2();
                    double[] props = raw as double[];
                    if (props != null && props.Length >= 7)
                    {
                        if (props[5] > 0.02) sheetW = props[5] * 1000;
                        if (props[6] > 0.02) sheetH = props[6] * 1000;
                    }
                }
                catch (System.Runtime.InteropServices.COMException) { }
                plan.SheetMm = new double[] { sheetW, sheetH };

                bool third = projection != null
                    && Json.Str(projection, "after", "first") == "third";

                int[] candidates = new int[] { 1, 2, 2, 5, 5, 10, 20 };
                foreach (int denom in candidates)
                {
                    if (plan.Try(sheetW, sheetH, denom, third, wanted)) break;
                }
                return plan;
            }

            bool Try(double sheetW, double sheetH, int denom, bool third, List<string> wanted)
            {
                Denominator = denom;
                double gap = 12;                       // mm between views
                double w = SizeMm[0] / denom, h = SizeMm[1] / denom, d = SizeMm[2] / denom;
                NameSize.Clear();
                NameSize["*前视"] = new double[] { w, h };
                NameSize["*后视"] = new double[] { w, h };
                NameSize["*上视"] = new double[] { w, d };
                NameSize["*下视"] = new double[] { w, d };
                NameSize["*左视"] = new double[] { d, h };
                NameSize["*右视"] = new double[] { d, h };

                Dictionary<string, double[]> offsets = new Dictionary<string, double[]>();
                offsets["*前视"] = new double[] { 0, 0 };
                offsets["*后视"] = new double[] { 0, 0 };
                double side = w / 2 + gap + d / 2;
                double vertical = h / 2 + gap + d / 2;
                // 第一角：俯视图在主视下方、左视图在主视右方；第三角：整套镜像。
                offsets["*上视"] = new double[] { 0, third ? vertical : -vertical };
                offsets["*下视"] = new double[] { 0, third ? -vertical : vertical };
                offsets["*左视"] = new double[] { third ? -side : side, 0 };
                offsets["*右视"] = new double[] { third ? side : -side, 0 };

                _names.Clear();
                _positions.Clear();
                List<string> extra = new List<string>();
                double minX = 0, minY = 0, maxX = 0, maxY = 0;
                bool any = false;
                foreach (string name in wanted)
                {
                    double[] off;
                    double[] pair;
                    if (offsets.ContainsKey(name))
                    {
                        off = offsets[name];
                        pair = NameSize[name];
                    }
                    else
                    {
                        // 等轴测之类：排在前视右下，尺寸按 1.3 倍外廓估。
                        extra.Add(name);
                        int k = extra.Count - 1;
                        off = new double[] { (w / 2 + gap + w * 0.65) , -(h / 2 + gap + h * 0.65) - k * (h * 1.4 + gap) };
                        pair = new double[] { w * 1.3, h * 1.3 };
                    }
                    double x0 = off[0] - pair[0] / 2, x1 = off[0] + pair[0] / 2;
                    double y0 = off[1] - pair[1] / 2, y1 = off[1] + pair[1] / 2;
                    if (!any) { minX = x0; maxX = x1; minY = y0; maxY = y1; any = true; }
                    else
                    {
                        minX = Math.Min(minX, x0); maxX = Math.Max(maxX, x1);
                        minY = Math.Min(minY, y0); maxY = Math.Max(maxY, y1);
                    }
                    _names.Add(name);
                    _positions.Add(off);
                }

                double margin = 25;
                double needW = (maxX - minX) + 2 * margin;
                double needH = (maxY - minY) + 2 * margin + 60;   // 60：给标题栏留位
                if (needW > sheetW || needH > sheetH)
                {
                    Fits = false;
                    return false;
                }
                Fits = true;

                // 整组平移到「左下角留 margin」的位置，再把 mm 换成米（API 要米）。
                double shiftX = margin - minX;
                double shiftY = margin + 60 - minY;
                for (int i = 0; i < _positions.Count; i++)
                {
                    _positions[i] = new double[]
                    {
                        (_positions[i][0] + shiftX) / 1000.0,
                        (_positions[i][1] + shiftY) / 1000.0,
                    };
                }
                return true;
            }

            readonly Dictionary<string, double[]> NameSize = new Dictionary<string, double[]>();
        }

        static string Template(Dictionary<string, object> req)
        {
            string template = Json.Str(req, "template", null);
            if (!string.IsNullOrEmpty(template)) return Path.GetFullPath(template);
            return Path.Combine(SwHost.TemplateDir, DefaultSheet);
        }

        static bool SaveIfAsked(IModelDoc2 doc, string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            path = Path.GetFullPath(path);
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
            int errors = 0, warnings = 0;
            return doc.Extension.SaveAs3(path, 0, 1, null, null, ref errors, ref warnings);
        }

        static List<object> SheetNames(IDrawingDoc drawing)
        {
            List<object> names = new List<object>();
            try
            {
                SolidWorks.Interop.sldworks.Sheet sheet = drawing.GetCurrentSheet() as SolidWorks.Interop.sldworks.Sheet;
                if (sheet != null) names.Add(sheet.GetName());
            }
            catch (System.Runtime.InteropServices.COMException) { }
            return names;
        }
    }
}