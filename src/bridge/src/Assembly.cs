using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Assemblies: put parts together and say where they actually landed.
    ///
    /// The interesting fact on this build is that the obvious API does not work:
    /// AddComponent / AddComponent4 / AddComponent5 all return null or false, with
    /// the part saved, the assembly saved, the document activated and the selection
    /// cleared. InsertImportedComponent does work, and it returns a real component
    /// with a path and a document — which is why the component list below reads
    /// back positions instead of trusting what was asked for.</summary>
    /// <remarks>Named AssemblyOps, not Assembly: a top-level type called Assembly
    /// shadows System.Reflection.Assembly, and Reflect.cs needs that one.</remarks>
    static class AssemblyOps
    {
        public static Dictionary<string, object> New(Dictionary<string, object> req)
        {
            string template = Json.Str(req, "template");
            if (template == null)
                template = Path.Combine(SwHost.TemplateDir, "gb_assembly.asmdot");
            if (!File.Exists(template))
                throw new BridgeError("TEMPLATE_NOT_FOUND", "assembly template not found: " + template);

            using (SwHost h = SwHost.Attach())
            {
                // 复用优先：磁盘上已有同名装配、或它正开着，就打开/激活那一份，不再新建。
                // 以前每次都 NewDocument，同一路径上就挂了两份同标题文档（"装配体N"
                // 存盘后也叫 ASM-01）；ActivateDoc3 按标题选中的是旧那份，组件插进旧
                // 文档、designId 却绑在新文档 —— 返回照样 ok，两边其实对不上。
                string path = Json.Str(req, "path", null);
                if (!string.IsNullOrEmpty(path))
                {
                    path = Path.GetFullPath(path);
                    string dir0 = Path.GetDirectoryName(path);
                    if (!string.IsNullOrEmpty(dir0) && !Directory.Exists(dir0)) Directory.CreateDirectory(dir0);

                    foreach (IModelDoc2 open in Documents.OpenDocuments(h.App))
                    {
                        string openPath = null;
                        try { openPath = open.GetPathName(); }
                        catch (COMException) { }
                        if (string.IsNullOrEmpty(openPath)) continue;
                        if (!string.Equals(Path.GetFullPath(openPath), path, StringComparison.OrdinalIgnoreCase)) continue;
                        int actErrors = 0;
                        try
                        {
                            h.App.ActivateDoc3(open.GetTitle(), true,
                                (int)swRebuildOnActivation_e.swDontRebuildActiveDoc, ref actErrors);
                        }
                        catch (COMException) { }
                        return Json.Dict(
                            "document", Json.Dict("title", open.GetTitle(), "path", open.GetPathName(), "type", "assembly"),
                            "saved", true,
                            "reused", true,
                            "saveErrors", 0,
                            "saveWarnings", 0,
                            "requestedPath", path,
                            "bytes", File.Exists(path) ? new FileInfo(path).Length : 0,
                            "template", template);
                    }

                    if (File.Exists(path))
                    {
                        int oErr = 0, oWarn = 0;
                        IModelDoc2 opened = null;
                        try
                        {
                            opened = h.App.OpenDoc6(path, (int)swDocumentTypes_e.swDocASSEMBLY,
                                (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "", ref oErr, ref oWarn);
                        }
                        catch (COMException) { }
                        if (opened != null)
                        {
                            return Json.Dict(
                                "document", Json.Dict("title", opened.GetTitle(), "path", opened.GetPathName(), "type", "assembly"),
                                "saved", true,
                                "reused", true,
                                "saveErrors", 0,
                                "saveWarnings", 0,
                                "requestedPath", path,
                                "bytes", new FileInfo(path).Length,
                                "template", template);
                        }
                    }
                }

                IModelDoc2 doc = (IModelDoc2)h.App.NewDocument(template, 0, 0, 0);
                if (doc == null) throw new BridgeError("NEW_DOCUMENT_FAILED", "could not create an assembly");

                bool saved = false;
                int errors = 0, warnings = 0;
                if (!string.IsNullOrEmpty(path))
                {
                    string dir = Path.GetDirectoryName(path);
                    if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                    // Same options the part saver uses. Reporting errors/warnings
                    // matters here: a false return with no detail is unactionable.
                    saved = doc.Extension.SaveAs3(path,
                        (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                        (int)swSaveAsOptions_e.swSaveAsOptions_Silent,
                        null, null, ref errors, ref warnings);
                }

                // 标题必须在存盘**之后**再读一次。SaveAs3 会把文档改名（见
                // Operations.cs 存盘路径的注释「Saving under a new name renames the
                // document」），存盘前读到的是模板给的默认名「装配体N」，存盘后才是
                // 「drawer-asm」。这两个名字不只是显示用：RegisterCreated 拿这里的
                // title 记进 WorkRegistry，而 Operations.DesignDocument 回头靠
                // Documents.Activate(entry.Title) 按标题找窗口 —— 记下旧名，之后按
                // designId 找就永远找不到，inspect action="assembly" 报 DOC_NOT_OPEN。
                string title = doc.GetTitle();

                return Json.Dict(
                    "document", Json.Dict("title", title, "path", doc.GetPathName(), "type", "assembly"),
                    "saved", saved,
                    "saveErrors", errors,
                    "saveWarnings", warnings,
                    "requestedPath", path,
                    "bytes", !string.IsNullOrEmpty(path) && File.Exists(path) ? new FileInfo(path).Length : 0,
                    "template", template);
            }
        }

        /// <summary>Inserts parts by path at a position given in millimetres.
        ///
        /// Two APIs had to be measured rather than assumed:
        ///   InsertImportedComponent returned 0 once this morning and then returned
        ///     2 for every part afterwards — including parts made in the same
        ///     session — and a second call in the same process took SOLIDWORKS down
        ///     with RPC_S_CALL_FAILED. It is not used.
        ///   AddComponent5 returns null unless the part document is already open;
        ///     with the part open it returns a real component and honours X/Y/Z.
        ///   AddComponents3 works with the part closed and returns an Object[].
        /// So: open the part, AddComponent5, and fall back to AddComponents3.
        /// A fallback inserts at the origin, and the response says so.</summary>
        public static Dictionary<string, object> Insert(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                // 插入目标必须与 designId 指向的装配一致。以前只看「当前活动装配」，
                // 而 assemble 是先新建一份、再插进前台那一份 —— 两者不一致时照样回 ok。
                string designId = Json.Str(req, "designId", null);
                IModelDoc2 doc = string.IsNullOrEmpty(designId)
                    ? h.AssemblyDocOrThrow()
                    : Operations.RequireDesignDocument(h, designId, "assemble.insert");
                IAssemblyDoc asm = doc as IAssemblyDoc;
                if (asm == null)
                    throw new BridgeError("NOT_AN_ASSEMBLY", "the active document is not an assembly");

                // 目标路径核对：designId 解析到的那份文档，必须就是调用方要求写入的
                // 那个文件。两份同标题装配同时开着时，ActivateDoc3 会挑错，而插入
                // 依旧「成功」—— 这种静默错位只能在事后靠组件数反推，代价太高。
                string targetPath = Json.Str(req, "path", null);
                if (!string.IsNullOrEmpty(targetPath))
                {
                    string actual = null;
                    try { actual = doc.GetPathName(); }
                    catch (COMException) { }
                    string want = null;
                    try { want = Path.GetFullPath(targetPath); }
                    catch (Exception) { want = targetPath; }
                    string have = null;
                    if (!string.IsNullOrEmpty(actual))
                    {
                        try { have = Path.GetFullPath(actual); }
                        catch (Exception) { have = actual; }
                    }
                    if (have != null && !string.Equals(have, want, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new BridgeError("DOC_MISMATCH",
                            "design \"" + designId + "\" resolves to \"" + have + "\" but the caller asked to write \""
                            + want + "\"; refusing to insert into a different assembly",
                            Json.Dict("designId", designId, "resolvedPath", have, "requestedPath", want));
                    }
                }

                List<object> inserted = new List<object>();
                List<object> failed = new List<object>();
                List<object> skipped = new List<object>();

                // 复用装配时不能把同一批零件再插一遍；但「同件多实例」是正常的
                // （四瓣整机就是 4 件同型号的瓣）。所以这里按路径**计数**，不按路径
                // 一刀切：请求里第 k 次出现某路径，装配里已有 ≥k 件才算「已存在」，
                // 否则补插第 k 件。以前用 HashSet 只记「有没有」，第二次 assemble 会把
                // 缺的那两件也报成 ALREADY_PRESENT —— 回包看起来完整，磁盘上少两件。
                Dictionary<string, int> existingCount = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                HashSet<string> existingNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (object item in Components(asm))
                {
                    Dictionary<string, object> d = item as Dictionary<string, object>;
                    if (d == null) continue;
                    string p0 = d.ContainsKey("path") ? d["path"] as string : null;
                    if (!string.IsNullOrEmpty(p0))
                    {
                        string key = p0;
                        try { key = Path.GetFullPath(p0); } catch (Exception) { }
                        int have;
                        existingCount.TryGetValue(key, out have);
                        existingCount[key] = have + 1;
                    }
                    string n0 = d.ContainsKey("name") ? d["name"] as string : null;
                    if (!string.IsNullOrEmpty(n0)) existingNames.Add(n0);
                }
                Dictionary<string, int> requestCount = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                List<object> nameFailures = new List<object>();

                foreach (object raw in Json.Items(req.ContainsKey("components") ? req["components"] : null))
                {
                    Dictionary<string, object> c = Json.Obj(raw);
                    if (c == null) continue;
                    string path = Json.Str(c, "path", null);
                    // Every one of these APIs refuses relative paths, and their error
                    // codes say nothing about which argument was wrong.
                    if (!string.IsNullOrEmpty(path) && File.Exists(path)) path = Path.GetFullPath(path);
                    if (string.IsNullOrEmpty(path) || !File.Exists(path))
                    {
                        failed.Add(Json.Dict("path", path, "reason", "FILE_NOT_FOUND"));
                        continue;
                    }

                    // 显式给了实例名：名字已存在就是「这件已经在里面了」，不管路径计到第几次。
                    string instanceName = Json.Str(c, "instanceName", null);
                    if (!string.IsNullOrEmpty(instanceName) && existingNames.Contains(instanceName))
                    {
                        skipped.Add(Json.Dict("path", path, "reason", "ALREADY_PRESENT",
                            "instanceName", instanceName));
                        continue;
                    }

                    int nth;
                    requestCount.TryGetValue(path, out nth);
                    nth++;
                    requestCount[path] = nth;
                    int alreadyHave;
                    existingCount.TryGetValue(path, out alreadyHave);
                    if (nth <= alreadyHave)
                    {
                        skipped.Add(Json.Dict("path", path, "reason", "ALREADY_PRESENT",
                            "instance", nth, "existing", alreadyHave));
                        continue;
                    }

                    double x = Json.Dbl(c, "x", 0);
                    double y = Json.Dbl(c, "y", 0);
                    double z = Json.Dbl(c, "z", 0);
                    string placement = Json.Str(c, "placement", "bbox-center");

                    // AddComponent5 only works once the part is open.
                    int openErrors = 0, openWarnings = 0;
                    IModelDoc2 partDoc = null;
                    try
                    {
                        partDoc = h.App.OpenDoc6(path, (int)swDocumentTypes_e.swDocPART,
                            (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "",
                            ref openErrors, ref openWarnings);
                    }
                    catch (COMException ex)
                    {
                        failed.Add(Json.Dict("path", path, "reason", "PART_OPEN_FAILED", "message", ex.Message));
                        continue;
                    }

                    // AddComponent5 按包围盒中心落位。装配要的是“零件原点落在给定坐标”
                    // 时，先把零件自身包围盒中心量出来，再从目标里扣掉 —— 否则 226 mm
                    // 长的轴会被它的半长整体推偏。
                    double originDx = 0, originDy = 0, originDz = 0;
                    if (placement == "origin")
                    {
                        try
                        {
                            double[] pb = ((IPartDoc)partDoc).GetPartBox(false) as double[];
                            if (pb != null && pb.Length >= 6)
                            {
                                originDx = (pb[0] + pb[3]) / 2;
                                originDy = (pb[1] + pb[4]) / 2;
                                originDz = (pb[2] + pb[5]) / 2;
                            }
                        }
                        catch (COMException) { }
                    }

                    IComponent2 component = null;
                    string method = "AddComponent5";
                    try
                    {
                        component = asm.AddComponent5(path, 0, "", false, "",
                            SwHost.ToMeters(x + originDx), SwHost.ToMeters(y + originDy), SwHost.ToMeters(z + originDz));
                    }
                    catch (COMException ex)
                    {
                        failed.Add(Json.Dict("path", path, "reason", "ADD_COMPONENT_THREW",
                            "message", ex.Message));
                        continue;
                    }

                    if (component == null)
                    {
                        // Fallback: works with the part closed, ignores X/Y/Z.
                        method = "AddComponents3";
                        try
                        {
                            object names = new string[] { path };
                            object transforms = new object[] { "" };
                            object systems = new string[] { "" };
                            object result = asm.AddComponents3(names, transforms, systems);
                            Array made = result as Array;
                            if (made != null && made.Length > 0) component = made.GetValue(0) as IComponent2;
                        }
                        catch (COMException ex)
                        {
                            failed.Add(Json.Dict("path", path, "reason", "ADD_COMPONENTS3_THREW",
                                "message", ex.Message));
                            continue;
                        }
                    }

                    if (component == null)
                    {
                        failed.Add(Json.Dict("path", path, "reason", "INSERT_FAILED",
                            "tried", new object[] { "AddComponent5", "AddComponents3" }));
                        continue;
                    }

                    // 实例名：四瓣整机要按名字挑瓣（flap-1..4），不能靠 part-1/part-2 猜。
                    // IComponent2.Name2 可写，但写完必须回读 —— 重名时 SOLIDWORKS 自己加后缀，
                    // 不回读就变成「我给它起的名字」和「它实际叫什么」两回事。
                    string instanceNameApplied = null;
                    string instanceNameError = null;
                    if (!string.IsNullOrEmpty(instanceName))
                    {
                        try { component.Name2 = instanceName; }
                        catch (COMException ex) { instanceNameError = ex.Message; }
                        catch (InvalidCastException ex) { instanceNameError = ex.Message; }
                        try { instanceNameApplied = component.Name2; }
                        catch (COMException) { }
                        if (instanceNameError == null
                            && !string.Equals(instanceNameApplied, instanceName, StringComparison.Ordinal))
                        {
                            instanceNameError = "SOLIDWORKS 没采用这个名字（回读是 \"" + (instanceNameApplied ?? "?")
                                + "\"）：同名组件已存在时它会自己改后缀";
                        }
                        if (instanceNameError != null)
                        {
                            nameFailures.Add(Json.Dict("path", path, "instanceName", instanceName,
                                "reason", "INSTANCE_NAME_FAILED", "message", instanceNameError));
                        }
                    }

                    Dictionary<string, object> described = Describe(doc, component, path);
                    described["method"] = method;
                    described["instanceName"] = string.IsNullOrEmpty(instanceName) ? null : instanceName;
                    described["instanceNameApplied"] = instanceNameApplied;
                    if (instanceNameError != null) described["instanceNameError"] = instanceNameError;
                    described["requestedPosition"] = new List<object> { Json.R(x), Json.R(y), Json.R(z) };
                    described["placement"] = placement;
                    if (placement == "origin")
                        described["originOffset"] = new List<object> { Json.R(originDx), Json.R(originDy), Json.R(originDz) };
                    if (method == "AddComponents3") described["positionApplied"] = false;

                    // Where the component actually landed vs what was asked for.
                    // The API positions by bounding-box centre, not by the part origin,
                    // and that difference is what put a chair 75 mm below the table.
                    List<object> box = described.ContainsKey("box") ? described["box"] as List<object> : null;
                    if (box != null && box.Count >= 6 && method == "AddComponent5" && placement == "bbox-center")
                    {
                        double cx = (Json.ToDouble(box[0], 0) + Json.ToDouble(box[3], 0)) / 2;
                        double cy = (Json.ToDouble(box[1], 0) + Json.ToDouble(box[4], 0)) / 2;
                        double cz = (Json.ToDouble(box[2], 0) + Json.ToDouble(box[5], 0)) / 2;
                        double dx = cx - x, dy = cy - y, dz = cz - z;
                        described["boxCenter"] = new List<object> { Json.R(cx), Json.R(cy), Json.R(cz) };
                        described["placementDelta"] = new List<object> { Json.R(dx), Json.R(dy), Json.R(dz) };
                        if (Math.Abs(dx) > 0.5 || Math.Abs(dy) > 0.5 || Math.Abs(dz) > 0.5)
                            described["warning"] = "位置按包围盒中心落位（placement=bbox-center），与 requestedPosition 不一致："
                                + "delta=(" + Json.R(dx) + "," + Json.R(dy) + "," + Json.R(dz) + ") mm；"
                                + "要按零件原点落位就先从 boxCenter 反算偏移";
                    }
                    inserted.Add(described);
                }

                doc.EditRebuild3();

                // Saving the assembly at creation writes an empty shell: the file
                // exists before any component is inserted. Save again after the
                // insert so the .sldasm on disk is the assembly just made.
                string outPath = Json.Str(req, "path", null);
                bool saved = false;
                int saveErrors = 0, saveWarnings = 0;
                if (!string.IsNullOrEmpty(outPath))
                {
                    outPath = Path.GetFullPath(outPath);
                    string outDir = Path.GetDirectoryName(outPath);
                    if (!string.IsNullOrEmpty(outDir) && !Directory.Exists(outDir)) Directory.CreateDirectory(outDir);
                    saved = doc.Extension.SaveAs3(outPath,
                        (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                        (int)swSaveAsOptions_e.swSaveAsOptions_Silent,
                        null, null, ref saveErrors, ref saveWarnings);
                }

                string docPath = doc.GetPathName();
                return Json.Dict(
                    "assembly", Json.Dict("title", doc.GetTitle(), "path", docPath, "designId", Json.Str(req, "designId", null)),
                    "insertedInto", docPath,
                    "inserted", inserted,
                    "failed", failed,
                    "skipped", skipped,
                    "nameFailures", nameFailures,
                    "saved", saved,
                    "saveErrors", saveErrors,
                    "saveWarnings", saveWarnings,
                    "requestedPath", outPath,
                    "bytes", !string.IsNullOrEmpty(outPath) && File.Exists(outPath) ? new FileInfo(outPath).Length : 0,
                    "componentCount", Components(doc as IAssemblyDoc).Count);
            }
        }

        /// <summary>Reads the component tree back. Everything here comes from the
        /// assembly, not from the request that built it: a component that silently
        /// failed to insert has to be visible as missing, not as a memory of intent.</summary>
        public static Dictionary<string, object> Components(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                // A2：组件清单必须来自指定的装配体。前台正好是用户打开的另一个
                // 装配体时，"读回来的组件"和调用方以为的那个装配体就是两份东西。
                IModelDoc2 doc = Operations.RequireDesignDocument(h, Json.Str(req, "designId", null), "components");
                IAssemblyDoc asm = doc as IAssemblyDoc;
                if (asm == null) throw new BridgeError("NOT_AN_ASSEMBLY", "the document for this design is not an assembly");

                List<object> items = Components(asm);
                return Json.Dict(
                    "assembly", Json.Dict("title", doc.GetTitle(), "path", doc.GetPathName()),
                    "count", items.Count,
                    "components", items,
                    "interference", InterferenceBlock(asm));
            }
        }

        /// <summary>Reads the mate group back. A mate object that exists but whose
        /// component did not move is not proof; this returns the actual mate list
        /// so the caller can verify a constraint was stored, not just attempted.</summary>
        public static Dictionary<string, object> Mates(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                string designId = Json.Str(req, "designId", null);
                IModelDoc2 doc = string.IsNullOrEmpty(designId)
                    ? h.AssemblyDocOrThrow()
                    : Operations.RequireDesignDocument(h, designId, "mates");
                IAssemblyDoc asm = doc as IAssemblyDoc;
                if (asm == null)
                    throw new BridgeError("NOT_AN_ASSEMBLY", "the document for design \"" + designId + "\" is not an assembly");

                List<object> items = new List<object>();
                object raw = null;
                try { raw = doc.FeatureManager.GetFeatures(true); } catch (COMException) { }
                Array array = raw as Array;
                if (array != null)
                {
                    foreach (object entry in array)
                    {
                        IFeature feature = entry as IFeature;
                        if (feature == null) continue;
                        string type = null;
                        try { type = feature.GetTypeName2(); } catch (COMException) { }
                        if (type == null) continue;
                        if (type == "MateGroup")
                        {
                            // 配合不是顶层特征：它们在 MateGroup 下面。GetFeatures(true)
                            // 只给顶层，直接把 MateGroup 当“没有配合”会漏掉全部约束。
                            IFeature sub = null;
                            try { sub = feature.GetFirstSubFeature() as IFeature; } catch (COMException) { }
                            while (sub != null)
                            {
                                AddMateItem(doc, items, sub);
                                IFeature next = null;
                                try { next = sub.GetNextSubFeature() as IFeature; } catch (COMException) { }
                                sub = next;
                            }
                            continue;
                        }
                        if (type.StartsWith("Mate", StringComparison.OrdinalIgnoreCase)) AddMateItem(doc, items, feature);
                    }
                }
                return Json.Dict(
                    "assembly", Json.Dict("title", doc.GetTitle(), "path", doc.GetPathName()),
                    "count", items.Count,
                    "mates", items);
            }
        }

        /// <summary>配合清单必须带两端身份。只给名字 + 实体数时，调用方只能按编号猜：
        /// 「同心6」其实是摆臂↔辊轴，删掉它整条链就断，而配合总数仍是 8，看不出差别。</summary>
        static void AddMateItem(IModelDoc2 doc, List<object> items, IFeature feature)
        {
            if (feature == null) return;
            string type = null;
            try { type = feature.GetTypeName2(); } catch (COMException) { }
            int entityCount = -1;
            IMate2 mate = null;
            try { mate = feature.GetSpecificFeature2() as IMate2; } catch (COMException) { }
            if (mate != null)
            {
                try { entityCount = mate.GetMateEntityCount(); } catch (COMException) { }
            }
            List<object> entities = new List<object>();
            if (mate != null && entityCount > 0)
            {
                for (int i = 0; i < entityCount; i++)
                {
                    IMateEntity2 entity = null;
                    try { entity = mate.MateEntity(i) as IMateEntity2; } catch (COMException) { }
                    if (entity == null) { entities.Add(null); continue; }
                    string componentName = null, surface = null;
                    double? diameter = null;
                    try
                    {
                        IComponent2 component = entity.ReferenceComponent as IComponent2;
                        if (component != null) componentName = component.Name2;
                    }
                    catch (COMException) { }
                    try
                    {
                        IFace2 face = entity.Reference as IFace2;
                        if (face != null)
                        {
                            ISurface s = face.GetSurface() as ISurface;
                            if (s != null)
                            {
                                if (s.IsCylinder())
                                {
                                    surface = "cylinder";
                                    double[] cp = s.CylinderParams as double[];
                                    if (cp != null && cp.Length >= 7) diameter = Math.Round(2000.0 * cp[6], 3);
                                }
                                else if (s.IsPlane()) surface = "plane";
                                else if (s.IsCone()) surface = "cone";
                                else if (s.IsTorus()) surface = "torus";
                                else surface = "other";
                            }
                        }
                    }
                    catch (COMException) { }
                    entities.Add(Json.Dict("component", componentName, "surface", surface, "diameter", diameter));
                }
            }
            bool? suppressed = null;
            try { suppressed = feature.IsSuppressed(); } catch (COMException) { }
            bool? lockRotation = null;
            try
            {
                object definition = feature.GetDefinition();
                IConcentricMateFeatureData concentric = definition as IConcentricMateFeatureData;
                if (concentric != null) lockRotation = concentric.LockRotation;
            }
            catch (COMException) { }
            items.Add(Json.Dict(
                "name", feature.Name,
                "type", type,
                "entityCount", entityCount,
                "components", entities,
                "suppressed", suppressed,
                "lockRotation", lockRotation));
        }
        static List<object> Components(IAssemblyDoc asm)
        {
            List<object> items = new List<object>();
            if (asm == null) return items;
            object raw = asm.GetComponents(true);
            Array array = raw as Array;
            if (array == null) return items;
            foreach (object entry in array)
            {
                IComponent2 component = entry as IComponent2;
                if (component == null) continue;
                items.Add(Describe(null, component, null));
            }
            return items;
        }

        /// <summary>干涉读数：直接问 SOLIDWORKS 的 InterferenceDetectionMgr，不自己判。
        ///
        /// 以前这条链一直是空的：verify 的 assembly 档读 geometry.interference，
        /// 桥接器从来不回这个字段，于是一直记 unmeasured —— 而 CAD 层拿不到数，
        /// 只能自己用 OBB 近似猜"这两件碰不碰"。OBB 对回转体差得离谱（四瓣整机
        /// 的瓣与蜗杆轴线是斜交的），±1 mm 的误判会让"能转"变成"卡死"。
        ///
        /// 这里给的是布尔交集体积：volume>0 才是真干涉，volume==0 是贴面（装配里
        /// 大量存在，不能算干涉）。所以 coincidentOnly 单独计数，不混进 count。
        /// 失败不抛：回 available:false + reason，调用方据此记 unmeasured，
        /// 而不是把"没量成"当成"没有干涉"。</summary>
        internal static Dictionary<string, object> InterferenceBlock(IAssemblyDoc asm)
        {
            if (asm == null) return Json.Dict("available", false, "reason", "NOT_AN_ASSEMBLY");
            try
            {
                InterferenceDetectionMgr mgr = asm.InterferenceDetectionManager;
                if (mgr == null)
                    return Json.Dict("available", false, "reason", "INTERFERENCE_MGR_UNAVAILABLE");
                try { mgr.TreatCoincidenceAsInterference = false; } catch (COMException) { }
                try { mgr.IncludeMultibodyPartInterferences = true; } catch (COMException) { }
                try { mgr.IgnoreHiddenBodies = true; } catch (COMException) { }

                int count = 0, coincident = 0;
                double totalMm3 = 0;
                List<object> pairs = new List<object>();
                Array arr = null;
                try { arr = mgr.GetInterferences() as Array; } catch (COMException) { }
                if (arr != null)
                {
                    foreach (object entry in arr)
                    {
                        IInterference itf = entry as IInterference;
                        if (itf == null) continue;
                        bool ignored = false;
                        try { ignored = itf.Ignore; } catch (COMException) { }
                        if (ignored) continue;
                        double volumeMm3 = 0;
                        try { volumeMm3 = itf.Volume * 1e9; } catch (COMException) { }
                        List<object> names = new List<object>();
                        try
                        {
                            Array comps = itf.Components as Array;
                            if (comps != null)
                            {
                                foreach (object o in comps)
                                {
                                    IComponent2 c = o as IComponent2;
                                    if (c == null) continue;
                                    try { names.Add(c.Name2); } catch (COMException) { }
                                }
                            }
                        }
                        catch (COMException) { }
                        bool touching = volumeMm3 <= 1e-6;
                        if (touching) coincident++; else { count++; totalMm3 += volumeMm3; }
                        pairs.Add(Json.Dict(
                            "components", names,
                            "volumeMm3", Json.R(volumeMm3),
                            "coincidentOnly", touching));
                    }
                }
                try { mgr.Done(); } catch (COMException) { }
                return Json.Dict(
                    "available", true,
                    "count", count,
                    "volumeMm3", Json.R(totalMm3),
                    "coincidentCount", coincident,
                    "pairs", pairs,
                    "rule", "volume>0 才算干涉；volume==0 是贴面，记在 coincidentCount");
            }
            catch (COMException ex)
            {
                return Json.Dict("available", false, "reason", "INTERFERENCE_FAILED", "message", ex.Message);
            }
            catch (InvalidCastException ex)
            {
                return Json.Dict("available", false, "reason", "INTERFERENCE_FAILED", "message", ex.Message);
            }
        }

        static Dictionary<string, object> Describe(IModelDoc2 doc, IComponent2 component, string fallbackPath)
        {
            string name = null, componentPath = fallbackPath;
            List<object> box = null;
            try { name = component.Name2; } catch (COMException) { }
            try
            {
                string p = component.GetPathName();
                if (!string.IsNullOrEmpty(p)) componentPath = p;
            }
            catch (COMException) { }
            try
            {
                double[] b = component.GetBox(false, false) as double[];
                if (b != null && b.Length >= 6)
                {
                    box = new List<object>();
                    for (int i = 0; i < 6; i++) box.Add(Json.R(SwHost.FromMeters(b[i])));
                }
            }
            catch (COMException) { }

            List<object> transformArray = null;
            double? angleDeg = null;
            List<object> origin = null;
            try
            {
                MathTransform xf = component.Transform2 as MathTransform;
                if (xf != null)
                {
                    double[] d = ToDoubles(xf.ArrayData);
                    if (d != null && d.Length == 16)
                    {
                        transformArray = ToList(d);
                        angleDeg = Math.Round(Math.Atan2(d[3], d[0]) * 180.0 / Math.PI, 6);
                        origin = new List<object>
                        {
                            Math.Round(SwHost.FromMeters(d[9]), 4),
                            Math.Round(SwHost.FromMeters(d[10]), 4),
                            Math.Round(SwHost.FromMeters(d[11]), 4),
                        };
                    }
                }
            }
            catch (COMException) { }
            return Json.Dict(
                "name", name,
                "path", componentPath,
                "suppressed", SafeBool(delegate { return component.IsSuppressed(); }),
                "fixed", SafeBool(delegate { return component.IsFixed(); }),
                "box", box,
                "angleDeg", angleDeg,
                "origin", origin,
                "transform", transformArray);
        }

        static bool? SafeBool(Func<bool> read)
        {
            try { return read(); }
            catch (COMException) { return null; }
        }

        /// <summary>Lists every face of every component in the assembly, with the
        /// persistent reference that mate/select need.
        ///
        /// 为什么不能复用 faces：那个 op 走的是「当前设计的文档」，装配里没有实体
        /// 遍历路径，而且零件的持久引用换到装配文档里解析不出来 —— 持久引用是
        /// 文档作用域的。装配里的面必须由装配文档自己签 id，这条 op 就干这件事。
        /// 圆角半径一并给出：选「Ø42 那张圆柱面」靠它，而不是靠猜面序号。</summary>
        public static Dictionary<string, object> Faces(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                string designId = Json.Str(req, "designId", null);
                IModelDoc2 doc = string.IsNullOrEmpty(designId)
                    ? h.AssemblyDocOrThrow()
                    : Operations.RequireDesignDocument(h, designId, "assembly.faces");
                IAssemblyDoc asm = doc as IAssemblyDoc;
                if (asm == null)
                    throw new BridgeError("NOT_AN_ASSEMBLY", "the document is not an assembly");
                IModelDocExtension ext = doc.Extension;

                List<object> records = new List<object>();
                Array comps = null;
                try { comps = asm.GetComponents(true) as Array; }
                catch (COMException) { }
                if (comps == null) comps = new object[0];

                int ci = -1;
                foreach (object rawComp in comps)
                {
                    ci++;
                    IComponent2 comp = rawComp as IComponent2;
                    if (comp == null) continue;
                    string name = null;
                    try { name = comp.Name2; }
                    catch (COMException) { }

                    IBody2 body = null;
                    try { body = comp.GetBody() as IBody2; }
                    catch (COMException) { }
                    if (body == null) continue;

                    Array faces = null;
                    try { faces = body.GetFaces() as Array; }
                    catch (COMException) { }
                    if (faces == null) continue;

                    int fi = -1;
                    foreach (object rawFace in faces)
                    {
                        fi++;
                        IFace2 face = rawFace as IFace2;
                        if (face == null) continue;

                        string kind = "unknown";
                        double radius = 0;
                        double[] cyl = null;
                        try
                        {
                            ISurface surf = face.GetSurface() as ISurface;
                            if (surf != null)
                            {
                                if (surf.IsPlane()) kind = "plane";
                                else if (surf.IsCylinder())
                                {
                                    kind = "cylinder";
                                    double[] cp = surf.CylinderParams as double[];
                                    if (cp != null && cp.Length >= 7)
                                    {
                                        radius = cp[6] * 1000.0;
                                        cyl = cp;
                                    }
                                }
                                else if (surf.IsCone()) kind = "cone";
                                else if (surf.IsSphere()) kind = "sphere";
                                else if (surf.IsTorus()) kind = "torus";
                                else kind = "other";
                            }
                        }
                        catch (COMException) { }

                        Dictionary<string, object> rec = Json.Dict(
                            "component", name, "componentIndex", ci, "faceIndex", fi, "kind", kind);
                        if (radius > 0) rec["radius"] = Json.R(radius);
                        if (radius > 0) rec["diameter"] = Json.R(radius * 2);

                        // 圆柱面把轴线一起给出去：装配里的孔心 = 这条轴与端面的交点。
                        // 只给 radius + box 时，调用方只能拿包围盒中点当孔心（斜置孔直接错），
                        // 于是每次配合前都要自己反推坐标。点按 SOLIDWORKS 惯例是米，这里换成 mm。
                        if (cyl != null)
                        {
                            rec["axis"] = Json.Dict(
                                "point", new List<object>
                                {
                                    Json.R(cyl[0] * 1000.0), Json.R(cyl[1] * 1000.0), Json.R(cyl[2] * 1000.0)
                                },
                                "dir", new List<object>
                                {
                                    Json.R(cyl[3]), Json.R(cyl[4]), Json.R(cyl[5])
                                });
                        }

                        try
                        {
                            double[] box = face.GetBox() as double[];
                            if (box != null && box.Length >= 6)
                                rec["box"] = new List<object>
                                {
                                    Json.R(box[0] * 1000), Json.R(box[1] * 1000), Json.R(box[2] * 1000),
                                    Json.R(box[3] * 1000), Json.R(box[4] * 1000), Json.R(box[5] * 1000)
                                };
                        }
                        catch (COMException) { }

                        string id = null;
                        try
                        {
                            byte[] bytes = ext.GetPersistReference3(face) as byte[];
                            if (bytes != null && bytes.Length > 0) id = Hex.FromBytes(bytes);
                        }
                        catch (COMException) { }
                        rec["id"] = id;
                        records.Add(rec);
                    }
                }

                return Json.Dict(
                    "assembly", Json.Dict("title", doc.GetTitle(), "path", doc.GetPathName()),
                    "components", ci + 1,
                    "count", records.Count,
                    "faces", records);
            }
        }

        /// <summary>Adds a mate between two entities named by persistent references.
        ///
        /// AddMate4 needs the two entities selected with the marks it expects; the
        /// marks differ between mate types, so this tries the documented pair and
        /// reports exactly what happened instead of claiming success because the
        /// call returned a non-null object.</summary>
        /// <summary>Deletes one mate by the name that the mates op reported.
        ///
        /// 为什么需要它：给已有的同心配合补 lockRotation 不能「再叠一个」，那会过约束。
        /// 正确做法是删掉旧的、按同一对实体重建。配合不是顶层特征，它在 MateGroup
        /// 下面，所以这里按名字遍历子特征再 Select2，而不是用 SelectByID2("MATE")。</summary>
        public static Dictionary<string, object> MateDelete(Dictionary<string, object> req)
        {
            string name = Json.Str(req, "name", null);
            if (string.IsNullOrEmpty(name))
                throw new BridgeError("BAD_ARGUMENT", "mateDelete needs name（用 inspect action=\"mates\" 拿到的配合名）");

            using (SwHost h = SwHost.Attach())
            {
                string designId = Json.Str(req, "designId", null);
                IModelDoc2 doc = string.IsNullOrEmpty(designId)
                    ? h.AssemblyDocOrThrow()
                    : Operations.RequireDesignDocument(h, designId, "mateDelete");
                if (!(doc is IAssemblyDoc))
                    throw new BridgeError("NOT_AN_ASSEMBLY", "the document for design \"" + designId + "\" is not an assembly");

                IFeature target = FindFeatureByName(doc, name);
                if (target == null)
                    throw new BridgeError("MATE_NOT_FOUND",
                        "no feature named \"" + name + "\" in " + (doc.GetTitle() ?? "the assembly"),
                        Json.Dict("designId", designId, "name", name));

                doc.ClearSelection2(true);
                bool selected = false;
                try { selected = target.Select2(false, 0); }
                catch (COMException) { }
                if (!selected)
                    throw new BridgeError("MATE_SELECT_FAILED", "could not select mate \"" + name + "\"");

                int before = CountMates(doc);
                try { doc.EditDelete(); }
                catch (COMException ex) { throw new BridgeError("MATE_DELETE_FAILED", "EditDelete threw: " + ex.Message); }
                doc.ClearSelection2(true);

                int saveErrors = 0, saveWarnings = 0;
                bool saved = false;
                try { saved = doc.Save3((int)swSaveAsOptions_e.swSaveAsOptions_Silent, ref saveErrors, ref saveWarnings); }
                catch (COMException) { }

                int after = CountMates(doc);
                return Json.Dict(
                    "name", name,
                    "deleted", after < before,
                    "matesBefore", before,
                    "matesAfter", after,
                    "saved", saved,
                    "assembly", Json.Dict("title", doc.GetTitle(), "path", doc.GetPathName()));
            }
        }

        /// <summary>Sets LockRotation on an existing concentric mate and reads it back.
        /// Why: AddMate4's lockRotation flag does not stick on this build (mate created,
        /// read-back false), and stacking a second concentric mate would over-define.
        /// The mate has to be modified through its feature definition.</summary>
        public static Dictionary<string, object> MateLock(Dictionary<string, object> req)
        {
            string name = Json.Str(req, "name", null);
            if (string.IsNullOrEmpty(name))
                throw new BridgeError("BAD_ARGUMENT", "mateLock needs name（inspect action=\"mates\" 的配合名）");
            bool wanted = Json.Bool(req, "lockRotation", true);
            using (SwHost h = SwHost.Attach())
            {
                string designId = Json.Str(req, "designId", null);
                IModelDoc2 doc = string.IsNullOrEmpty(designId)
                    ? h.AssemblyDocOrThrow()
                    : Operations.RequireDesignDocument(h, designId, "mateLock");
                IFeature target = FindFeatureByName(doc, name);
                if (target == null)
                    throw new BridgeError("MATE_NOT_FOUND", "no feature named \"" + name + "\"", Json.Dict("designId", designId, "name", name));
                bool? before = null, after = null;
                bool modified = false;
                bool rebuilt = false;
                try
                {
                    object definition = target.GetDefinition();
                    IConcentricMateFeatureData c0 = definition as IConcentricMateFeatureData;
                    if (c0 == null)
                        throw new BridgeError("NOT_CONCENTRIC", "mate \"" + name + "\" is not a concentric mate");
                    before = c0.LockRotation;
                    c0.LockRotation = wanted;
                    modified = target.ModifyDefinition(definition, doc, null);
                    // 改定义不等于求解器已经吃到它：不重建的话 lockRotation 读回 true，
                    // 驱动仍然打滑（ASM-09 上就是这么误判成「锁转不传扭」的）。
                    try { rebuilt = doc.EditRebuild3(); } catch (COMException) { }
                    object again = target.GetDefinition();
                    IConcentricMateFeatureData c1 = again as IConcentricMateFeatureData;
                    if (c1 != null) after = c1.LockRotation;
                }
                catch (COMException ex)
                {
                    throw new BridgeError("MATE_LOCK_FAILED", ex.Message);
                }
                int saveErrors = 0, saveWarnings = 0;
                bool saved = false;
                try { saved = doc.Save3((int)swSaveAsOptions_e.swSaveAsOptions_Silent, ref saveErrors, ref saveWarnings); }
                catch (COMException) { }
                return Json.Dict(
                    "name", name,
                    "lockRotationBefore", before,
                    "lockRotationAfter", after,
                    "modified", modified,
                    "rebuild", rebuilt,
                    "saved", saved,
                    "assembly", Json.Dict("title", doc.GetTitle(), "path", doc.GetPathName()));
            }
        }
        /// <summary>Rigidly locks two components (swMateLOCK): all six DOF frozen.
        /// Why a lock mate: on this build a concentric mate with LockRotation=true
        /// reads back true but does not transmit rotation (drive the shaft 12 deg,
        /// partner stays 0), and stacking planar coincident mates lands in
        /// OverDefinedAssembly. A lock mate is the only constraint that survives
        /// the solve and is what a keyed/bonded joint actually behaves like.</summary>
        public static Dictionary<string, object> ComponentLock(Dictionary<string, object> req)
        {
            string first = Json.Str(req, "first", null);
            string second = Json.Str(req, "second", null);
            if (string.IsNullOrEmpty(first) || string.IsNullOrEmpty(second))
                throw new BridgeError("BAD_ARGUMENT", "componentLock needs first and second component names");
            using (SwHost h = SwHost.Attach())
            {
                string designId = Json.Str(req, "designId", null);
                IModelDoc2 doc = string.IsNullOrEmpty(designId)
                    ? h.AssemblyDocOrThrow()
                    : Operations.RequireDesignDocument(h, designId, "componentLock");
                IAssemblyDoc asm = doc as IAssemblyDoc;
                if (asm == null)
                    throw new BridgeError("NOT_AN_ASSEMBLY", "the document for design \"" + designId + "\" is not an assembly");
                IComponent2 c1 = asm.GetComponentByName(first);
                IComponent2 c2 = asm.GetComponentByName(second);
                if (c1 == null) throw new BridgeError("COMPONENT_NOT_FOUND", "no component named \"" + first + "\"");
                if (c2 == null) throw new BridgeError("COMPONENT_NOT_FOUND", "no component named \"" + second + "\"");
                int matesBefore = CountMates(doc);
                doc.ClearSelection2(true);
                bool s1 = false, s2 = false;
                try { s1 = c1.Select2(false, 1); } catch (COMException) { }
                try { s2 = c2.Select2(true, 2); } catch (COMException) { }
                if (!s1 || !s2)
                    throw new BridgeError("STALE_SELECTION", "could not select \"" + first + "\"/\"" + second + "\"");
                int errorStatus = 0;
                object mate = null;
                try
                {
                    mate = asm.AddMate4((int)swMateType_e.swMateLOCK, (int)swMateAlign_e.swMateAlignALIGNED, false,
                        0, 0, 0, 0, 0, 0, 0, 0, false, false, out errorStatus);
                }
                catch (COMException ex)
                {
                    throw new BridgeError("MATE_FAILED", "AddMate4(LOCK) threw: " + ex.Message);
                }
                doc.ClearSelection2(true);
                int saveErrors = 0, saveWarnings = 0;
                bool saved = false;
                try { saved = doc.Save3((int)swSaveAsOptions_e.swSaveAsOptions_Silent, ref saveErrors, ref saveWarnings); }
                catch (COMException) { }
                int matesAfter = CountMates(doc);
                return Json.Dict(
                    "first", first,
                    "second", second,
                    "added", mate != null,
                    "errorStatus", errorStatus,
                    "matesBefore", matesBefore,
                    "matesAfter", matesAfter,
                    "saved", saved,
                    "assembly", Json.Dict("title", doc.GetTitle(), "path", doc.GetPathName()));
            }
        }
        static List<string> MateNames(IModelDoc2 doc)
        {
            List<string> names = new List<string>();
            object raw = null;
            try { raw = doc.FeatureManager.GetFeatures(true); } catch (COMException) { }
            Array array = raw as Array;
            if (array == null) return names;
            foreach (object entry in array)
            {
                IFeature feature = entry as IFeature;
                if (feature == null) continue;
                string type = null;
                try { type = feature.GetTypeName2(); } catch (COMException) { }
                if (type != "MateGroup") continue;
                IFeature sub = null;
                try { sub = feature.GetFirstSubFeature() as IFeature; } catch (COMException) { }
                while (sub != null)
                {
                    string n = null;
                    try { n = sub.Name; } catch (COMException) { }
                    if (n != null) names.Add(n);
                    IFeature next = null;
                    try { next = sub.GetNextSubFeature() as IFeature; } catch (COMException) { }
                    sub = next;
                }
            }
            return names;
        }
        static IFeature FindFeatureByName(IModelDoc2 doc, string name)
        {
            object raw = null;
            try { raw = doc.FeatureManager.GetFeatures(true); } catch (COMException) { }
            Array array = raw as Array;
            if (array == null) return null;
            foreach (object entry in array)
            {
                IFeature feature = entry as IFeature;
                if (feature == null) continue;
                string type = null, fname = null;
                try { type = feature.GetTypeName2(); } catch (COMException) { }
                try { fname = feature.Name; } catch (COMException) { }
                if (string.Equals(fname, name, StringComparison.OrdinalIgnoreCase)) return feature;
                if (type == "MateGroup")
                {
                    IFeature sub = null;
                    try { sub = feature.GetFirstSubFeature() as IFeature; } catch (COMException) { }
                    while (sub != null)
                    {
                        string sn = null;
                        try { sn = sub.Name; } catch (COMException) { }
                        if (string.Equals(sn, name, StringComparison.OrdinalIgnoreCase)) return sub;
                        IFeature next = null;
                        try { next = sub.GetNextSubFeature() as IFeature; } catch (COMException) { }
                        sub = next;
                    }
                }
            }
            return null;
        }

        static int CountMates(IModelDoc2 doc)
        {
            int count = 0;
            object raw = null;
            try { raw = doc.FeatureManager.GetFeatures(true); } catch (COMException) { }
            Array array = raw as Array;
            if (array == null) return 0;
            foreach (object entry in array)
            {
                IFeature feature = entry as IFeature;
                if (feature == null) continue;
                string type = null;
                try { type = feature.GetTypeName2(); } catch (COMException) { }
                if (type == "MateGroup")
                {
                    IFeature sub = null;
                    try { sub = feature.GetFirstSubFeature() as IFeature; } catch (COMException) { }
                    while (sub != null)
                    {
                        count++;
                        IFeature next = null;
                        try { next = sub.GetNextSubFeature() as IFeature; } catch (COMException) { }
                        sub = next;
                    }
                }
                else if (type != null && type.StartsWith("Mate", StringComparison.OrdinalIgnoreCase))
                {
                    count++;
                }
            }
            return count;
        }

        /// <summary>最大公约数：齿轮配合要的是「分子:分母」两个整数，
        /// 而调用方给的是一个小数（1 / 2 / 1.5）。1.5 直接传 1.5:1 也能建，
        /// 但读回来的比例不可复算；先约分再传，回读才对得上。</summary>
        static long Gcd(long a, long b)
        {
            a = Math.Abs(a);
            b = Math.Abs(b);
            while (b != 0)
            {
                long t = a % b;
                a = b;
                b = t;
            }
            return a == 0 ? 1 : a;
        }

        public static Dictionary<string, object> Mate(Dictionary<string, object> req)
        {
            string first = Json.Str(req, "first", null);
            string second = Json.Str(req, "second", null);
            string kind = Json.Str(req, "kind", "coincident");
            if (first == null || second == null)
                throw new BridgeError("BAD_ARGUMENT", "mate needs first and second persistent ids");

            using (SwHost h = SwHost.Attach())
            {
                // mate 必须落在 designId 指定的装配上。以前这里取的是「当前活动文档」，
                // 多实例/多文档并存时配合会加到另一份装配（实测落到 ASM-01），
                // 返回 errorStatus=0 却什么也没约束住。
                string designId = Json.Str(req, "designId", null);
                IModelDoc2 doc = string.IsNullOrEmpty(designId)
                    ? h.AssemblyDocOrThrow()
                    : Operations.RequireDesignDocument(h, designId, "mate");
                IAssemblyDoc asmGuard = doc as IAssemblyDoc;
                if (asmGuard == null)
                    throw new BridgeError("NOT_AN_ASSEMBLY", "the document for design \"" + designId + "\" is not an assembly");
                IModelDocExtension ext = doc.Extension;

                bool a = SelectPersistent(ext, first, 1, false);
                bool b = SelectPersistent(ext, second, 1, true);
                if (!a || !b)
                    throw new BridgeError("STALE_SELECTION",
                    "one of the mate entities could not be resolved from its persistent reference");

                int type = kind == "distance"
                    ? (int)swMateType_e.swMateDISTANCE
                    : kind == "concentric"
                        ? (int)swMateType_e.swMateCONCENTRIC
                        : kind == "angle"
                            ? (int)swMateType_e.swMateANGLE
                            : kind == "gear"
                                ? (int)swMateType_e.swMateGEAR
                                : (int)swMateType_e.swMateCOINCIDENT;
                // 齿轮配合只用「两种圆柱面 + 传动比」：ratio=2 表示第一件转 1 圈、
                // 第二件转 2 圈；reverse 交换转向。距离/角度参数对它没有意义，
                // 传了也不该悄悄生效，所以下面这条路里一律写 0/0。
                bool isGear = kind == "gear";
                double ratio = Json.Dbl(req, "ratio", 1.0);
                if (isGear)
                {
                    if (!(ratio > 0) || double.IsNaN(ratio) || double.IsInfinity(ratio))
                        throw new BridgeError("BAD_ARGUMENT", "gear mate needs ratio > 0 (e.g. 1, 2, 1.5); got " + ratio);
                }
                bool reverse = Json.Bool(req, "reverse", false);
                double gearNum = 0, gearDen = 0;
                if (isGear)
                {
                    gearNum = Math.Round(ratio * 1000.0);
                    gearDen = 1000.0;
                    long g = Gcd((long)gearNum, (long)gearDen);
                    gearNum = gearNum / g;
                    gearDen = gearDen / g;
                }
                double distance = SwHost.ToMeters(Json.Dbl(req, "distance", 0));
                // 角度配合只吃掉「绕两平面交线」的转动，不动平移。同心已经管住 4 个
                // 自由度、只差周向相位的界面（轴↔轮芯、轮芯↔胎）用它补最后 1 个，
                // 不会像再叠一条重合那样报 OverDefinedAssembly(5)。
                double angle = Json.Dbl(req, "angle", 0) * Math.PI / 180.0;

                IAssemblyDoc asm = doc as IAssemblyDoc;
                int errorStatus = 0;
                object mate = null;
                List<object> attempts = new List<object>();
                try
                {
                    // AddMate4: MateType, Align, Flip, Distance, +upper, +lower,
                    // gear ratio num/den, angle, +upper, +lower, positioningOnly,
                    // lockRotation, out ErrorStatus.
                    int align = kind == "concentric"
                        ? (int)swMateAlign_e.swMateAlignCLOSEST
                        : (int)swMateAlign_e.swMateAlignALIGNED;
                    // 最后两个 bool 是 positioningOnly 与 lockRotation。锁转动是
                    // 「刚性同转」的开关：轴与轮芯、轮芯与轮胎这类靠键/粘接同转的
                    // 界面必须打开它，否则只约束了同轴，驱动力传不过去 ——
                    // 独立复核里「驱动辊轴 12°、轮芯 0°」就是这么来的。
                    if (isGear)
                    {
                        // 齿轮配合在真机上对齐方式会决定 AddMate 能不能解出来，
                        // 失败时 Selection 已被清掉：每次尝试前重新选一次，并把
                        // 每次的 errorStatus 原样带回去（否则只剩一个 "unknown"）。
                        object[] alignCandidates = new object[]
                        {
                            (int)swMateAlign_e.swMateAlignALIGNED,
                            (int)swMateAlign_e.swMateAlignCLOSEST,
                            (int)swMateAlign_e.swMateAlignANTI_ALIGNED,
                        };
                        foreach (object candidate in alignCandidates)
                        {
                            try { doc.ClearSelection2(true); } catch (COMException) { }
                            bool sa = SelectPersistent(ext, first, 1, false);
                            bool sb = SelectPersistent(ext, second, 1, true);
                            if (!sa || !sb)
                            {
                                attempts.Add(Json.Dict("call", "AddMate4", "align", candidate,
                                    "result", "SELECTION_LOST"));
                                continue;
                            }
                            int status = 0;
                            object made = null;
                            try
                            {
                                made = asm.AddMate4(type, (int)candidate, reverse,
                                    0, 0, 0, gearNum, gearDen, 0, 0, 0, false, false, out status);
                            }
                            catch (COMException ex)
                            {
                                attempts.Add(Json.Dict("call", "AddMate4", "align", candidate,
                                    "threw", ex.Message));
                                continue;
                            }
                            attempts.Add(Json.Dict("call", "AddMate4", "align", candidate, "errorStatus", status));
                            if (made != null || status == 1)
                            {
                                mate = made;
                                errorStatus = status;
                                break;
                            }
                        }
                        // AddMate5 比 AddMate4 多一个 WidthMateOption（齿轮配合用不到，
                        // 传 0）：个别版本上 4 号入口对 GEAR 直接回 0，5 号才建出来。
                        if (mate == null)
                        {
                            try { doc.ClearSelection2(true); } catch (COMException) { }
                            bool sa = SelectPersistent(ext, first, 1, false);
                            bool sb = SelectPersistent(ext, second, 1, true);
                            if (sa && sb)
                            {
                                int status = 0;
                                object made = null;
                                try
                                {
                                    made = asm.AddMate5(type, (int)swMateAlign_e.swMateAlignALIGNED, reverse,
                                        0, 0, 0, gearNum, gearDen, 0, 0, 0, false, false, 0, out status);
                                }
                                catch (COMException ex)
                                {
                                    attempts.Add(Json.Dict("call", "AddMate5", "threw", ex.Message));
                                }
                                if (made != null || status == 1)
                                {
                                    mate = made;
                                    errorStatus = status;
                                }
                                else
                                {
                                    attempts.Add(Json.Dict("call", "AddMate5", "errorStatus", status));
                                }
                            }
                            else
                            {
                                attempts.Add(Json.Dict("call", "AddMate5", "result", "SELECTION_LOST"));
                            }
                        }
                    }
                    else
                    {
                        mate = asm.AddMate4(type, align, false,
                            distance, distance, distance, 0, 0, angle, 0, 0, false,
                            Json.Bool(req, "lockRotation", false), out errorStatus);
                    }
                }
                catch (COMException ex)
                {
                    throw new BridgeError("MATE_FAILED", "AddMate4 threw: " + ex.Message);
                }

                // AddMate4 的返回值在不同版本里是 IMate2、IFeature、或者 object[]（一个
                // 配合可能展开成多条记录）。以前只按 IMate2 判断，数组一来 added 恒为
                // false —— 配合其实建成了，回包却说没建成。
                object mateObj = mate;
                Array mateArray = mate as Array;
                if (mateArray != null && mateArray.Length > 0) mateObj = mateArray.GetValue(0);
                IMate2 mate2 = mateObj as IMate2;
                if (mate2 == null && mateObj != null)
                {
                    IFeature feat = mateObj as IFeature;
                    if (feat != null) mate2 = feat.GetSpecificFeature2() as IMate2;
                }
                string mateName = null;
                if (mate2 != null)
                {
                    try { mateName = mate2.GetMateEntityCount() > 0 ? (mate2.MateEntity(0) == null ? null : "mate" + errorStatus) : null; }
                    catch (COMException) { }
                }
                bool lockRequested = Json.Bool(req, "lockRotation", false);
                // AddMate4 的 lockRotation 参数在本机不落盘；真正的开关是
                // IConcentricMateFeatureData.LockRotation，必须改定义再 ModifyDefinition。
                // 拿新建配合的办法：AddMate4 返回的 COM 对象不一定是 IFeature，而
                // MateGroup 里的新配合要重建之后才可见 —— 所以先 EditRebuild3，
                // 再取配合列表的最后一条（AddMate4 总是追加）。
                // 齿轮配合走同一条「重建→取最后一条→读定义」的路，只是读的是
                // IGearMateFeatureData：比例和转向必须从存下来的定义回读，
                // 不能只信调用方传了什么。
                string newMateName = null;
                bool? lockRotation = null;
                bool lockModify = false;
                bool rebuilt = false;
                Dictionary<string, object> gearReadback = null;
                if (lockRequested || isGear)
                {
                    try { doc.EditRebuild3(); } catch (COMException) { }
                    List<string> all = MateNames(doc);
                    if (all.Count > 0) newMateName = all[all.Count - 1];
                    if (newMateName != null)
                    {
                        IFeature mateFeature = FindFeatureByName(doc, newMateName);
                        if (mateFeature != null)
                        {
                            try
                            {
                                object definition = mateFeature.GetDefinition();
                                if (isGear)
                                {
                                    IGearMateFeatureData gearDef = definition as IGearMateFeatureData;
                                    if (gearDef != null)
                                    {
                                        IGearMateFeatureData final = gearDef;
                                        bool changed = gearDef.Reverse != reverse;
                                        if (changed)
                                        {
                                            gearDef.Reverse = reverse;
                                            mateFeature.ModifyDefinition(definition, doc, null);
                                            IGearMateFeatureData again = mateFeature.GetDefinition() as IGearMateFeatureData;
                                            if (again != null) final = again;
                                        }
                                        int entityCount = 0;
                                        try
                                        {
                                            Array ents = final.EntitiesToMate as Array;
                                            if (ents != null) entityCount = ents.Length;
                                        }
                                        catch (COMException) { }
                                        // AddMate4 在真机上把传入的 2:1 存成 1:2（实测），
                                        // 于是「ratio=2」名义建成、实际耦合的是 0.5 倍。
                                        // 以定义为准改回调用方给的比，再回读一遍。
                                        bool forcedRatio = false;
                                        double storedRatio = final.GearRatioDenominator != 0
                                            ? final.GearRatioNumerator / final.GearRatioDenominator : 0;
                                        if (Math.Abs(storedRatio - ratio) > 1e-9)
                                        {
                                            final.GearRatioNumerator = gearNum;
                                            final.GearRatioDenominator = gearDen;
                                            mateFeature.ModifyDefinition(final, doc, null);
                                            IGearMateFeatureData rereadRatio = mateFeature.GetDefinition() as IGearMateFeatureData;
                                            if (rereadRatio != null) final = rereadRatio;
                                            forcedRatio = true;
                                        }
                                        gearReadback = Json.Dict(
                                            "ratioNumerator", final.GearRatioNumerator,
                                            "ratioDenominator", final.GearRatioDenominator,
                                            "ratio", final.GearRatioDenominator != 0
                                                ? (object)(final.GearRatioNumerator / final.GearRatioDenominator) : null,
                                            "ratioRequested", ratio,
                                            "ratioForced", forcedRatio,
                                            "reverse", final.Reverse,
                                            "reverseRequested", reverse,
                                            "reverseChanged", changed,
                                            "entities", entityCount);
                                    }
                                }
                                else
                                {
                                    IConcentricMateFeatureData concentric = definition as IConcentricMateFeatureData;
                                    if (concentric != null)
                                    {
                                        concentric.LockRotation = true;
                                        lockModify = mateFeature.ModifyDefinition(definition, doc, null);
                                        object again = mateFeature.GetDefinition();
                                        IConcentricMateFeatureData reread = again as IConcentricMateFeatureData;
                                        if (reread != null) lockRotation = reread.LockRotation;
                                    }
                                }
                            }
                            catch (COMException) { }
                        }
                    }
                }
                // 新增/改完配合统一重建一次：求解器只认重建后的约束状态。
                try { rebuilt = doc.EditRebuild3(); } catch (COMException) { }
                doc.ClearSelection2(true);
                int saveErrors = 0, saveWarnings = 0;
                bool saved = false;
                try
                {
                    // 建 → 改锁转 → 回读 → 存盘：先存再改，改的结果重开就丢。
                    saved = doc.Save3((int)swSaveAsOptions_e.swSaveAsOptions_Silent, ref saveErrors, ref saveWarnings);
                }
                catch (COMException) { }
                bool added = mateObj != null;
                return Json.Dict(
                    "kind", kind,
                    "added", added,
                    "lockRotation", lockRotation,
                    "lockModify", lockModify,
                    "rebuild", rebuilt,
                    "saved", saved,
                    "saveErrors", saveErrors,
                    "saveWarnings", saveWarnings,
                    "mate", newMateName ?? mateName,
                    "returned", mate == null ? null : mate.GetType().Name,
                    "errorStatus", errorStatus,
                    "ratio", isGear ? (object)ratio : null,
                    "reverse", isGear ? (object)reverse : null,
                    "gear", gearReadback,
                    "attempts", attempts.Count > 0 ? attempts : null,
                    "assembly", Json.Dict(
                        "title", SafeStr(delegate { return doc.GetTitle(); }),
                        "path", SafeStr(delegate { return doc.GetPathName(); })));
            }
        }

        /// <summary>Rotates one component about a global axis through a point (mm).
        /// Transform2.ArrayData on this build is [R00..R22, Tx,Ty,Tz, 1,0,0,0]
        /// (measured on an identity transform at (0,-30,-15)). The 4x4 is
        /// composed here instead of CreateTransformRotateAxis + Multiply: those
        /// double-count the point translation once the component transform is
        /// non-identity (a 180 deg flip about the component origin landed at
        /// 3*T). Building the array explicitly keeps the pivot fixed and is
        /// auditable from the returned arrays.</summary>
        /// <summary>单件平移：只改平移分量，旋转矩阵原样带过去。
        ///
        /// 设计坐标已经烘焙在零件里（草图就画在装配坐标上），装配里再给一个非零平移，
        /// 等于把件从孔里挪出去。这类偏差旋转修不了，删了重插又会连带删掉配合；
        /// 只改 16 元数组的后三位，配合与外部引用都留着。</summary>
        public static Dictionary<string, object> TranslateComponent(Dictionary<string, object> req)
        {
            string designId = Json.Str(req, "designId", null);
            string name = Json.Str(req, "component", null);
            if (string.IsNullOrEmpty(name))
                throw new BridgeError("BAD_ARGUMENT", "componentTranslate needs component");
            double dx = Json.Dbl(req, "dx", 0);
            double dy = Json.Dbl(req, "dy", 0);
            double dz = Json.Dbl(req, "dz", 0);
            bool unfix = Json.Bool(req, "unfix", false);
            bool refix = Json.Bool(req, "refix", false);

            using (SwHost h = SwHost.Attach())
            {
                IModelDoc2 doc = string.IsNullOrEmpty(designId)
                    ? h.AssemblyDocOrThrow()
                    : Operations.RequireDesignDocument(h, designId, "componentTranslate");
                IAssemblyDoc asm = doc as IAssemblyDoc;
                if (asm == null)
                    throw new BridgeError("NOT_AN_ASSEMBLY", "the document for design \"" + designId + "\" is not an assembly");

                IComponent2 comp = FindComponentByName(asm, name);
                if (comp == null)
                    throw new BridgeError("COMPONENT_NOT_FOUND", "no component named \"" + name + "\"");

                bool wasFixed = false;
                try { wasFixed = comp.IsFixed(); } catch (COMException) { }
                bool unfixedNow = false;
                if (unfix && wasFixed)
                {
                    doc.ClearSelection2(true);
                    try { comp.Select4(false, null, false); } catch (COMException) { }
                    try { asm.UnfixComponent(); } catch (COMException) { }
                    try { unfixedNow = !comp.IsFixed(); } catch (COMException) { unfixedNow = false; }
                }

                MathTransform current = (MathTransform)comp.Transform2;
                if (current == null)
                    throw new BridgeError("COMPONENT_TRANSFORM_NULL", "component \"" + name + "\" has no Transform2");
                double[] cur = ToDoubles(current.ArrayData);
                if (cur == null || cur.Length != 16)
                    throw new BridgeError("TRANSFORM_LAYOUT", "Transform2.ArrayData did not return 16 numbers");

                double[] nextArr = (double[])cur.Clone();
                nextArr[9] = cur[9] + dx / 1000.0;
                nextArr[10] = cur[10] + dy / 1000.0;
                nextArr[11] = cur[11] + dz / 1000.0;
                IMathUtility mu = (IMathUtility)h.App.GetMathUtility();
                MathTransform next = mu.CreateTransform(nextArr) as MathTransform;
                if (next == null)
                    throw new BridgeError("TRANSFORM_BUILD_FAILED", "CreateTransform returned null for the translated array");

                bool applied = false;
                try { applied = comp.SetTransformAndSolve3(next, true); }
                catch (COMException ex) { throw new BridgeError("TRANSLATE_FAILED", ex.Message); }
                bool rebuilt = false;
                if (applied)
                {
                    try { rebuilt = doc.EditRebuild3(); } catch (COMException) { }
                }

                bool refixed = false;
                if (refix && (wasFixed || unfixedNow))
                {
                    doc.ClearSelection2(true);
                    try { comp.Select4(false, null, false); } catch (COMException) { }
                    try { asm.FixComponent(); } catch (COMException) { }
                    try { refixed = comp.IsFixed(); } catch (COMException) { refixed = false; }
                }

                double[] after = null;
                try
                {
                    MathTransform t2 = (MathTransform)comp.Transform2;
                    if (t2 != null) after = ToDoubles(t2.ArrayData);
                }
                catch (COMException) { }

                return Json.Dict(
                    "designId", designId,
                    "component", name,
                    "requested", Json.List(Json.R(dx), Json.R(dy), Json.R(dz)),
                    "wasFixed", wasFixed,
                    "unfixed", unfixedNow,
                    "applied", applied,
                    "rebuilt", rebuilt,
                    "refixed", refixed,
                    "before", new List<object>
                    {
                        Json.R(SwHost.FromMeters(cur[9])), Json.R(SwHost.FromMeters(cur[10])), Json.R(SwHost.FromMeters(cur[11]))
                    },
                    "after", after == null ? null : new List<object>
                    {
                        Json.R(SwHost.FromMeters(after[9])), Json.R(SwHost.FromMeters(after[10])), Json.R(SwHost.FromMeters(after[11]))
                    },
                    "document", Json.Dict("title", doc.GetTitle(), "path", doc.GetPathName()));
            }
        }

        /// <summary>按名字找组件：GetComponentByName 对 "-1" 后缀敏感，找不到再逐件比对。</summary>
        /// <summary>包围盒中心（mm）。6 元 box 是 [minx,miny,minz,maxx,maxy,maxz]，单位米。</summary>
        static List<object> BoxCenterMm(double[] box)
        {
            if (box == null || box.Length < 6) return null;
            return new List<object>
            {
                Json.R(SwHost.FromMeters((box[0] + box[3]) / 2.0)),
                Json.R(SwHost.FromMeters((box[1] + box[4]) / 2.0)),
                Json.R(SwHost.FromMeters((box[2] + box[5]) / 2.0)),
            };
        }

        static double? CenterDrift(double[] before, double[] after)
        {
            if (before == null || after == null || before.Length < 6 || after.Length < 6) return null;
            double dx = ((after[0] + after[3]) - (before[0] + before[3])) / 2.0;
            double dy = ((after[1] + after[4]) - (before[1] + before[4])) / 2.0;
            double dz = ((after[2] + after[5]) - (before[2] + before[5])) / 2.0;
            return Math.Round(SwHost.FromMeters(Math.Sqrt(dx * dx + dy * dy + dz * dz)), 4);
        }

        static IComponent2 FindComponentByName(IAssemblyDoc asm, string name)
        {
            IComponent2 comp = null;
            try { comp = asm.GetComponentByName(name); } catch (COMException) { }
            if (comp != null) return comp;
            object[] comps = asm.GetComponents(false) as object[];
            if (comps == null) return null;
            foreach (object item in comps)
            {
                IComponent2 c = item as IComponent2;
                if (c == null) continue;
                string n = SafeStr(delegate { return c.Name2; });
                if (n == name || (n != null && n.StartsWith(name + "-", StringComparison.OrdinalIgnoreCase)))
                    return c;
            }
            return null;
        }
        public static Dictionary<string, object> RotateComponent(Dictionary<string, object> req)
        {
            string designId = Json.Str(req, "designId", null);
            string name = Json.Str(req, "component", null);
            if (string.IsNullOrEmpty(name))
                throw new BridgeError("BAD_ARGUMENT", "componentRotate needs component");
            double angleDeg = Json.Dbl(req, "angleDeg", 0);
            string axis = Json.Str(req, "axis", "z");
            double px = Json.Dbl(req, "x", 0);
            double py = Json.Dbl(req, "y", 0);
            double pz = Json.Dbl(req, "z", 0);
            double pmx = px / 1000.0, pmy = py / 1000.0, pmz = pz / 1000.0;

            using (SwHost h = SwHost.Attach())
            {
                IModelDoc2 doc = string.IsNullOrEmpty(designId)
                    ? h.AssemblyDocOrThrow()
                    : Operations.RequireDesignDocument(h, designId, "componentRotate");
                IAssemblyDoc asm = doc as IAssemblyDoc;
                if (asm == null)
                    throw new BridgeError("NOT_AN_ASSEMBLY", "the document for design \"" + designId + "\" is not an assembly");

                IComponent2 comp = asm.GetComponentByName(name);
                if (comp == null)
                {
                    object compsObj = asm.GetComponents(false);
                    object[] comps = compsObj as object[];
                    if (comps != null)
                    {
                        foreach (object item in comps)
                        {
                            IComponent2 c = item as IComponent2;
                            if (c == null) continue;
                            string n = SafeStr(delegate { return c.Name2; });
                            if (n == name || (n != null && n.StartsWith(name + "-", StringComparison.OrdinalIgnoreCase)))
                            {
                                comp = c;
                                break;
                            }
                        }
                    }
                }
                if (comp == null)
                    throw new BridgeError("COMPONENT_NOT_FOUND", "no component named \"" + name + "\"");


                // 枢轴语义：不传 x/y/z 时，绕「这件自己的包围盒中心」转。
                // 以前默认 (0,0,0) = 装配原点：调用方按"绕自身中心转"去驱动，
                // 三次 60° 叠加就成了绕原点 180°，件被甩到对面的坐标 —— 而且回包说 ok。
                bool pivotGiven = req.ContainsKey("x") || req.ContainsKey("y") || req.ContainsKey("z");
                double[] boxBefore = null;
                try { boxBefore = comp.GetBox(false, false) as double[]; } catch (COMException) { }
                string pivotSource = "explicit";
                if (!pivotGiven)
                {
                    if (boxBefore != null && boxBefore.Length >= 6)
                    {
                        px = SwHost.FromMeters((boxBefore[0] + boxBefore[3]) / 2.0);
                        py = SwHost.FromMeters((boxBefore[1] + boxBefore[4]) / 2.0);
                        pz = SwHost.FromMeters((boxBefore[2] + boxBefore[5]) / 2.0);
                        pivotSource = "bbox-center";
                    }
                    else
                    {
                        pivotSource = "component-origin";
                    }
                }
                pmx = px / 1000.0; pmy = py / 1000.0; pmz = pz / 1000.0;
                MathTransform current = (MathTransform)comp.Transform2;
                if (current == null)
                    throw new BridgeError("COMPONENT_TRANSFORM_NULL", "component \"" + name + "\" has no Transform2");
                double[] cur = ToDoubles(current.ArrayData);
                if (cur == null || cur.Length != 16)
                    throw new BridgeError("TRANSFORM_LAYOUT", "Transform2.ArrayData did not return 16 numbers");

                double tx = cur[9], ty = cur[10], tz = cur[11];
                double[] C = new double[9];
                for (int i = 0; i < 9; i++) C[i] = cur[i];

                double a = angleDeg * Math.PI / 180.0;
                double c0 = Math.Cos(a), s0 = Math.Sin(a);
                double[] R = new double[9];
                if (axis == "x")
                {
                    R[0] = 1; R[1] = 0; R[2] = 0;
                    R[3] = 0; R[4] = c0; R[5] = -s0;
                    R[6] = 0; R[7] = s0; R[8] = c0;
                }
                else if (axis == "y")
                {
                    R[0] = c0; R[1] = 0; R[2] = s0;
                    R[3] = 0; R[4] = 1; R[5] = 0;
                    R[6] = -s0; R[7] = 0; R[8] = c0;
                }
                else
                {
                    R[0] = c0; R[1] = -s0; R[2] = 0;
                    R[3] = s0; R[4] = c0; R[5] = 0;
                    R[6] = 0; R[7] = 0; R[8] = 1;
                }

                double[] NC = new double[9];
                for (int r = 0; r < 3; r++)
                {
                    for (int c = 0; c < 3; c++)
                    {
                        NC[r * 3 + c] = R[r * 3 + 0] * C[0 * 3 + c]
                            + R[r * 3 + 1] * C[1 * 3 + c]
                            + R[r * 3 + 2] * C[2 * 3 + c];
                    }
                }

                double rpx = R[0] * pmx + R[1] * pmy + R[2] * pmz;
                double rpy = R[3] * pmx + R[4] * pmy + R[5] * pmz;
                double rpz = R[6] * pmx + R[7] * pmy + R[8] * pmz;
                double ntx = R[0] * tx + R[1] * ty + R[2] * tz + pmx - rpx;
                double nty = R[3] * tx + R[4] * ty + R[5] * tz + pmy - rpy;
                double ntz = R[6] * tx + R[7] * ty + R[8] * tz + pmz - rpz;

                double[] nextArr = new double[16];
                for (int i = 0; i < 9; i++) nextArr[i] = NC[i];
                nextArr[9] = ntx; nextArr[10] = nty; nextArr[11] = ntz;
                nextArr[12] = cur[12]; nextArr[13] = cur[13];
                nextArr[14] = cur[14]; nextArr[15] = cur[15];

                IMathUtility mu = (IMathUtility)h.App.GetMathUtility();
                MathTransform next = (MathTransform)mu.CreateTransform(nextArr);
                if (next == null)
                    throw new BridgeError("TRANSFORM_BUILD_FAILED", "CreateTransform returned null for the composed array");
                // solve=true 走「拖动」而不是「直接设变换」：机械配合（齿轮/齿条/凸轮/
                // 螺旋）只在拖动路径里传递运动，SetTransformAndSolve3 只解几何配合。
                // 实测：齿轮配合在 solve=false 下驱动 A 转 12°，B 一动不动。
                bool solve = Json.Bool(req, "solve", false);
                string method = "SetTransformAndSolve3";
                bool applied = false;
                bool dragged = false;
                List<object> dragTrace = new List<object>();
                if (solve)
                {
                    try { h.App.ActivateDoc3(doc.GetTitle(), false, (int)swRebuildOnActivation_e.swDontRebuildActiveDoc, 0); } catch (COMException) { }
                    try
                    {
                        object rawDrag = asm.GetDragOperator();
                        dragTrace.Add(Json.Dict("step", "GetDragOperator", "type", rawDrag == null ? null : rawDrag.GetType().Name));
                        // 拖动器是「前台文档」的组件工具：装配没抢到前台时，它按当前活动
                        // 文档建，把组件加进去会被拒（实测 AddComponent 恒 false）。
                        IModelDoc2 activeDoc = h.App.ActiveDoc as IModelDoc2;
                        string activeTitle = null;
                        try { activeTitle = activeDoc == null ? null : activeDoc.GetTitle(); } catch (COMException) { }
                        if (activeDoc != null && activeTitle != doc.GetTitle())
                        {
                            h.App.ActivateDoc3(doc.GetTitle(), false, (int)swRebuildOnActivation_e.swDontRebuildActiveDoc, 0);
                            activeDoc = h.App.ActiveDoc as IModelDoc2;
                            try { activeTitle = activeDoc == null ? null : activeDoc.GetTitle(); } catch (COMException) { }
                        }
                        IAssemblyDoc activeAsm = activeDoc as IAssemblyDoc;
                        if (activeAsm != null) rawDrag = activeAsm.GetDragOperator();
                        dragTrace.Add(Json.Dict("step", "activeDoc", "title", activeTitle));
                        IDragOperator drag = rawDrag as IDragOperator;
                        if (drag != null)
                        {
                            // 拖动吃的是「增量变换」：绕点 p 的纯旋转，位移 = p − R·p。
                            double[] delta = new double[16];
                            for (int i = 0; i < 9; i++) delta[i] = R[i];
                            delta[9] = pmx - rpx;
                            delta[10] = pmy - rpy;
                            delta[11] = pmz - rpz;
                            delta[12] = 0; delta[13] = 0; delta[14] = 0; delta[15] = 1;
                            MathTransform deltaXform = mu.CreateTransform(delta) as MathTransform;
                            // DragMode 收的是鼠标拖动模式（swMouseDragMode_e）：
                            // 3 = 绕轴旋转组件，正是「转动一个零件、齿轮带着另一个转」的手势。
                            // 不设它时拖动器按平移处理，机械配合不会参与求解。
                            try
                            {
                                drag.DragMode = (short)swMouseDragMode_e.swRotateAssemblyComponentAboutAxis;
                                dragTrace.Add(Json.Dict("step", "DragMode", "ok", drag.DragMode));
                            }
                            catch (COMException ex) { dragTrace.Add(Json.Dict("step", "DragMode", "threw", ex.Message)); }
                            bool added;
                            try { added = drag.AddComponent(comp, false); }
                            catch (COMException ex) { added = false; dragTrace.Add(Json.Dict("step", "AddComponent", "threw", ex.Message)); }
                            dragTrace.Add(Json.Dict("step", "AddComponent", "ok", added));
                            if (!added)
                            {
                                try { added = drag.AddComponent(comp, true); dragTrace.Add(Json.Dict("step", "AddComponentAppend", "ok", added)); }
                                catch (COMException ex) { dragTrace.Add(Json.Dict("step", "AddComponentAppend", "threw", ex.Message)); }
                            }
                            if (!added)
                            {
                                // 强类型入口：IDragOperator 是 IDispatch 包装，IAddComponent 收
                                // 强类型 Component2，封送路径不同，结果可能不同。
                                try
                                {
                                    DragOperator typed = asm.IGetDragOperator() as DragOperator;
                                    Component2 concrete = comp as Component2;
                                    if (typed != null && concrete != null)
                                    {
                                        added = typed.IAddComponent(concrete, false);
                                        dragTrace.Add(Json.Dict("step", "IAddComponent", "ok", added));
                                    }
                                    else
                                    {
                                        dragTrace.Add(Json.Dict("step", "IAddComponent", "skipped",
                                            typed == null ? "no-typed-operator" : "no-coclass"));
                                    }
                                }
                                catch (COMException ex) { dragTrace.Add(Json.Dict("step", "IAddComponent", "threw", ex.Message)); }
                            }
                            // 拖点落在旋转轴上：轴上的点转起来才只有绕轴，不带平移。
                            try { drag.SetDragPoint(new double[] { pmx, pmy, pmz }); }
                            catch (COMException ex) { dragTrace.Add(Json.Dict("step", "SetDragPoint", "threw", ex.Message)); }
                            bool began = false;
                            try { began = drag.BeginDrag(); }
                            catch (COMException ex) { dragTrace.Add(Json.Dict("step", "BeginDrag", "threw", ex.Message)); }
                            dragTrace.Add(Json.Dict("step", "BeginDrag", "ok", began));
                            if (began && deltaXform != null && !added)
                            {
                                // 最后一条路：先把组件选上，再让拖动器按当前选择去拖。
                                try
                                {
                                    doc.ClearSelection2(true);
                                    comp.Select4(true, null, false);
                                    dragged = drag.Drag(deltaXform);
                                    dragTrace.Add(Json.Dict("step", "DragBySelection", "ok", dragged));
                                }
                                catch (COMException ex) { dragTrace.Add(Json.Dict("step", "DragBySelection", "threw", ex.Message)); }
                            }
                            if (began && deltaXform != null && added)
                            {
                                try { dragged = drag.Drag(deltaXform); }
                                catch (COMException ex) { dragTrace.Add(Json.Dict("step", "Drag", "threw", ex.Message)); }
                                if (!dragged)
                                {
                                    // DragAsUI 走「像人拖一样」的路径，机械配合（齿轮）在
                                    // 这条路上才会参与求解；Drag 直接改变换不解耦合。
                                    try { dragged = drag.DragAsUI(deltaXform); }
                                    catch (COMException ex) { dragTrace.Add(Json.Dict("step", "DragAsUI", "threw", ex.Message)); }
                                }
                            }
                            dragTrace.Add(Json.Dict("step", "Drag", "ok", dragged));
                            try { drag.EndDrag(); } catch (COMException) { }
                            if (dragged) method = "DragOperator";
                        }
                    }
                    catch (COMException ex) { dragTrace.Add(Json.Dict("step", "outer", "threw", ex.Message)); }
                }
                if (!dragged)
                {
                    applied = comp.SetTransformAndSolve3(next, true);
                }
                else
                {
                    applied = true;
                }
                bool rebuilt = false;
                try { rebuilt = doc.EditRebuild3(); } catch (COMException) { }
                int saveErrors = 0, saveWarnings = 0;
                bool saved = false;
                try { saved = doc.Save3((int)swSaveAsOptions_e.swSaveAsOptions_Silent, ref saveErrors, ref saveWarnings); } catch (COMException) { }

                double[] boxAfter = null;
                try { boxAfter = comp.GetBox(false, false) as double[]; } catch (COMException) { }
                return Json.Dict(
                    "component", SafeStr(delegate { return comp.Name2; }),
                    "angleDeg", angleDeg,
                    "axis", axis,
                    "point", new List<object> { Json.R(px), Json.R(py), Json.R(pz) },
                    "pivotUsed", Json.Dict("source", pivotSource, "at", Json.List(Json.R(px), Json.R(py), Json.R(pz))),
                    "centerBeforeMm", BoxCenterMm(boxBefore),
                    "centerAfterMm", BoxCenterMm(boxAfter),
                    "centerDriftMm", CenterDrift(boxBefore, boxAfter),
                    "layout", "sw-array [R00..R22,Tx,Ty,Tz,1,0,0,0]",
                    "currentArray", ToList(cur),
                    "nextArray", ToList(nextArr),
                    "applied", applied,
                    "method", method,
                    "dragged", dragged,
                    "dragTrace", dragTrace.Count > 0 ? dragTrace : null,
                    "rebuilt", rebuilt,
                    "saved", saved,
                    "saveErrors", saveErrors,
                    "saveWarnings", saveWarnings,
                    "assembly", Json.Dict(
                        "title", SafeStr(delegate { return doc.GetTitle(); }),
                        "path", SafeStr(delegate { return doc.GetPathName(); })));
            }
        }

        static double[] ToDoubles(object data)
        {
            double[] d = data as double[];
            if (d != null) return d;
            Array a = data as Array;
            if (a == null) return null;
            double[] result = new double[a.Length];
            for (int i = 0; i < a.Length; i++)
                result[i] = Convert.ToDouble(a.GetValue(i));
            return result;
        }

        static List<object> ToList(double[] values)
        {
            List<object> list = new List<object>();
            if (values == null) return list;
            for (int i = 0; i < values.Length; i++) list.Add(Json.R(values[i]));
            return list;
        }
        static bool SelectPersistent(IModelDocExtension ext, string persistentId, int mark, bool append)
        {
            byte[] bytes = Hex.ToBytes(persistentId);
            if (bytes == null || bytes.Length == 0)
                throw new BridgeError("BAD_ARGUMENT", "persistent id is not valid hex");
            object entity = null;
            try
            {
                int error = 0;
                entity = ext.GetObjectByPersistReference3(bytes, out error);
            }
            catch (COMException) { }
            IEntity selectable = entity as IEntity;
            return selectable != null && selectable.Select2(append, mark);
        }

        static string SafeStr(Func<string> read)
        {
            try { return read(); }
            catch (COMException) { return null; }
        }
    }
}
