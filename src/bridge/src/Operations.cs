using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>One bridge operation per process invocation. Operations never
    /// leak COM objects past the call and never change user state they do not own.</summary>
    sealed class Operations
    {
        public const string BridgeVersion = "0.4.1";
        public const int ProtocolVersion = 4;

        /// <summary>Every op this bridge answers. The UNKNOWN_OP error quotes this list,
        /// so it must be the same list the switch actually handles — a test walks it and
        /// fails if any name falls through to UNKNOWN_OP.</summary>
        public static readonly string[] SupportedOps = new string[]
        {
            "status", "ping", "version", "diagnose", "list", "inspect",
            "newDocument", "build", "edit", "save", "export", "cleanup", "close",
            "interopIndex", "invoke", "kinds", "addins", "capture",
            "open", "faces", "bodies", "edges", "select", "project", "relations",
            "assemblyNew", "componentInsert", "components", "assemblyFaces", "mates", "mate", "mateDelete", "mateLock", "componentLock", "componentRotate", "componentTranslate",
            "drawingNew", "drawingViews", "quit", "measure", "sketchGeometry",
            "object", "batch", "snapshot", "instances", "patternCircular", "ui",
            "dimensions", "feature",
        };

        /// <summary>Ops that neither read nor move the shared SOLIDWORKS state, so they
        /// may answer while another process is modelling.
        ///
        /// "instances" and "list" belong here because the broker runs them on a
        /// 60s heartbeat. Every non-LockFree op calls SwHost.NormalizeUi, i.e.
        /// ShowWindow(maximize) in a brand-new process whose per-process UiReady
        /// set is empty — so the heartbeat used to grab the user's window every
        /// minute while they were drawing. The ROT probe and the document list
        /// must never be a reason to touch the frame.</summary>
        static readonly string[] LockFree = new string[]
        {
            "ping", "version", "status", "diagnose", "interopIndex", "kinds", "addins",
            "instances", "list",
        };

        /// <summary>Every op that touches the shared instance runs behind one
        /// cross-process gate; see SwLock for why a per-process queue is not enough.</summary>
        public Dictionary<string, object> Dispatch(string op, Dictionary<string, object> req)
        {
            if (Array.IndexOf(LockFree, op) >= 0) return DispatchUnlocked(op, req);
            return SwLock.Run(op, req, delegate
            {
                return DispatchUnlocked(op, req);
            });
        }

        Dictionary<string, object> DispatchUnlocked(string op, Dictionary<string, object> req)
        {
            // Plan validation is pure parsing: no COM, no attach, no document. It has to
            // answer with SOLIDWORKS closed, because that is how the Node tests and a
            // dry-run of a design definition are exercised.
            bool pureRequest = IsPureRequest(op, req);
            // R12：--no-attach（只读枚举模式）下整条请求都不 attach —— 探针要的只是
            // ROT 清单，而 Instances() 自己会在 attachFree 下跳过 activePid 读取。
            // 其它 op 在 --no-attach 下会走各自内部的 SwHost.Attach()，从而拿到明确的
            // INSTANCE_NOT_BOUND，而不是偷偷连上一个实例。
            //
            // LockFree 名单必须一起排除：那几条 op 的契约是「不碰共享状态、可以在
            // 别人建模时回答」（见上面的注释），但这里曾经对它们照样 Attach()，于是
            // status / instances（ROT 与登记表的诊断读数）在未绑定的 worker 上直接
            // 抛 INSTANCE_NOT_BOUND —— 一个只读诊断因为拿不到实例而整条失败。两份
            // 名单现在同源：LockFree 的 op 真的不 attach；需要文档的 op 自己 attach，
            // 失败信息仍然明确。
            bool lockFree = Array.IndexOf(LockFree, op) >= 0;
            bool attachAllowed = !pureRequest && !SwHost.NoAttach && !lockFree;
            int pid = 0;
            bool wasMinimized = false;
            // 用户当时在看哪一份文档。任何改文档的操作都要先把目标文档切到前台
            // （EnsureDocument / DesignDocument 都会 ActivateDoc3），操作结束后必须
            // 还回去 —— 否则用户看到的就是自己的零件被反复换掉（A4）。
            // 这里只读标题，不 Attach 额外实例，也不碰任何文档状态。
            string originalActiveTitle = null;
            if (attachAllowed)
            {
                using (SwHost h = SwHost.Attach())
                {
                    pid = SwHost.LastKnownProcessId;
                    originalActiveTitle = ActiveDocumentTitle(h.App);
                    wasMinimized = UserInterface.IsMinimized(pid);
                    // R12：切文档必须在 LockFree 判断之后。以前 EnsureDocument 在
                    // :84 之前无条件执行，于是「带 document 参数的 status」这种只读
                    // 请求也会先 ActivateDoc3 切走用户的文档 —— 而 status 故意不
                    // NormalizeUi（不是它的活）。只读 op 不许动别人的活动文档。
                    if (Array.IndexOf(LockFree, op) < 0)
                    {
                        EnsureDocument(h.App, req);
                        if (op != "ui") h.NormalizeUi(false);
                    }
                    // Window cleanup is a desktop side effect, so only real operations
                    // do it; status/ping/diagnose stay quiet.
                }
            }
            try
            {
                Dictionary<string, object> result = RunOp(op, req);
                // quit 之后 SOLIDWORKS 已经不在了：这时候"切回原文档"既做不到也不该报警。
                if (op == "quit")
                {
                    if (result != null) result["restoredActiveDocument"] = null;
                    return result;
                }
                return WithRestoredDocument(result, originalActiveTitle);
            }
            catch
            {
                // 失败路径同样要还：失败最可能正好停在"别人的文档"上。
                RestoreActiveDocument(originalActiveTitle);
                throw;
            }
            finally
            {
                // SW 的 COM 操作常把最小化窗口拉起来；用户最小化时操作结束就收回去。
                if (wasMinimized && pid != 0) UserInterface.Minimize(pid);
            }
        }

        /// <summary>True for requests that answer by parsing the definition only.
        ///
        /// They must not attach to SOLIDWORKS: a plan check is useful before the app
        /// is open, and attaching would also mean holding the cross-process gate for a
        /// call that never touches the model.</summary>
        static bool IsPureRequest(string op, Dictionary<string, object> req)
        {
            if (op == "build" && Json.Bool(req, "validate", false)) return true;
            if (op == "relations")
            {
                string action = Json.Str(req, "action", "infer");
                return string.Equals(action, "validate", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(action, "plan", StringComparison.OrdinalIgnoreCase);
            }
            return false;
        }

        Dictionary<string, object> RunOp(string op, Dictionary<string, object> req)
        {
            switch (op)
            {
                case "status": return Status(req);
                case "ping": return Ping(req);
                case "version": return Version(req);
                case "diagnose": return Diagnose(req);
                case "list": return ListDocuments(req);
                case "inspect": return Inspect(req);
                // 建档的三个入口都走 RegisterCreated：创建出来的文档必须进
                // WorkRegistry，否则 cleanup（只认 registry）永远收不掉它。
                case "newDocument": return RegisterCreated(req, NewDocument(req));
                case "build":
                    try { return Build(req); }
                    catch (Exception) { RollbackBuild(req); throw; }
                case "edit": return Edit(req);
                case "patternCircular": return PatternCircular(req);
                case "feature": return FeatureOp(req);
                case "ui": return Ui(req);
                case "save": return Save(req);
                case "export": return Export(req);
                case "cleanup": return Cleanup(req);
                case "close": return Close(req);
                case "interopIndex": return Reflect.Index(req);
                case "invoke": return InvokeOp(req);
                case "kinds": return KindsOp(req);
                case "addins": return AddIns.List(req);
                case "capture": return Capture(req);
                case "open": return Observe.Open(req);
                case "faces": return Observe.Faces(req);
                case "bodies": return Observe.Bodies(req);
                case "edges": return Observe.Edges(req);
                case "select": return Observe.Select(req);
                case "project": return Observe.Project(req);
                case "relations": return Relations.Dispatch(req);
                case "dimensions": return SketchDimensioner.Dispatch(req);
                case "sketchGeometry": return SketchGeometry(req);
                case "assemblyNew": return RegisterCreated(req, AssemblyOps.New(req));
                case "componentInsert": return AssemblyOps.Insert(req);
                case "components": return AssemblyOps.Components(req);
                case "assemblyFaces": return AssemblyOps.Faces(req);
                case "mates": return AssemblyOps.Mates(req);
                case "mate": return AssemblyOps.Mate(req);
                case "mateDelete": return AssemblyOps.MateDelete(req);
                case "mateLock": return AssemblyOps.MateLock(req);
                case "componentLock": return AssemblyOps.ComponentLock(req);
                case "componentRotate": return AssemblyOps.RotateComponent(req);
                case "componentTranslate": return AssemblyOps.TranslateComponent(req);
                case "drawingNew": return RegisterCreated(req, Drawing.New(req));
                case "drawingViews": return Drawing.Views(req);
                case "measure": return Measure.Dispatch(req);
                case "object": return Reflect.ObjectOp(SwHost.Attach(), req);
                case "batch": return Batch(req);
                case "snapshot": return Snapshot(req);
                case "instances": return Instances(req);
                case "quit": return Quit(req);
                default:
                    throw new BridgeError("UNKNOWN_OP", "unsupported bridge op \"" + op + "\"",
                        Json.Dict("supported", new List<object>(SupportedOps)));
            }
        }

        /// <summary>Runs several bridge ops in one worker turn.
        ///
        /// Motivation: one COM round trip per call is the dominant cost in a long
        /// modelling sequence. Batch keeps the same document binding and error
        /// semantics, but pays the lock/message-pump cost once. Errors are per-step
        /// so a caller can see how far it got; stopOnError defaults to true because
        /// a failed feature makes the rest of the sequence meaningless.</summary>
        Dictionary<string, object> Batch(Dictionary<string, object> req)
        {
            ArrayList steps = req.ContainsKey("ops") ? req["ops"] as ArrayList : null;
            if (steps == null || steps.Count == 0)
                throw new BridgeError("BAD_ARGUMENT", "batch requires a non-empty \"ops\" array");
            object stopSetting;
            bool stopOnError = !req.TryGetValue("stopOnError", out stopSetting)
                || (stopSetting is bool ? (bool)stopSetting : Json.ToDouble(stopSetting, 1) != 0);
            List<object> results = new List<object>();
            foreach (object raw in steps)
            {
                Dictionary<string, object> step = raw as Dictionary<string, object>;
                if (step == null) { results.Add(Json.Dict("ok", false, "error", Json.Dict("code", "BAD_STEP", "message", "each batch step must be an object"))); if (stopOnError) break; continue; }
                string subOp = Json.Str(step, "op", null);
                if (string.IsNullOrEmpty(subOp)) { results.Add(Json.Dict("ok", false, "error", Json.Dict("code", "BAD_STEP", "message", "step.op is required"))); if (stopOnError) break; continue; }
                Dictionary<string, object> sub = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                foreach (KeyValuePair<string, object> pair in step) sub[pair.Key] = pair.Value;
                foreach (KeyValuePair<string, object> pair in req)
                    if (!sub.ContainsKey(pair.Key) && pair.Key != "ops" && pair.Key != "stopOnError") sub[pair.Key] = pair.Value;
                try
                {
                    results.Add(Json.Dict("op", subOp, "ok", true, "result", DispatchUnlocked(subOp, sub)));
                }
                catch (BridgeError error)
                {
                    results.Add(Json.Dict("op", subOp, "ok", false,
                        "error", Json.Dict("code", error.Code, "message", error.Message, "detail", error.Detail)));
                    if (stopOnError) break;
                }
                catch (Exception error)
                {
                    results.Add(Json.Dict("op", subOp, "ok", false,
                        "error", Json.Dict("code", "BATCH_STEP_FAILED", "message", error.Message)));
                    if (stopOnError) break;
                }
            }
            return Json.Dict("results", results, "count", results.Count);
        }

        /// <summary>Brings the document named by the request to the front and proves it is
        /// there.
        ///
        /// Several agents share one SOLIDWORKS. Every operation that touches geometry has
        /// to say which document it means, because "the active document" is global state
        /// another agent can change between two calls. Without this, a sketch lands in
        /// whatever part happens to be in front and nothing reports a problem.</summary>
        void EnsureDocument(ISldWorks app, Dictionary<string, object> req)
        {
            string wanted = Json.Str(req, "document", null);
            if (string.IsNullOrEmpty(wanted)) return;

            string full = wanted;
            try { full = Path.GetFullPath(wanted); }
            catch (Exception) { }

            IModelDoc2 target = null;
            foreach (IModelDoc2 doc in Documents.OpenDocuments(app))
            {
                string p = doc.GetPathName();
                if (string.IsNullOrEmpty(p)) continue;
                string other = p;
                try { other = Path.GetFullPath(p); }
                catch (Exception) { }
                if (string.Equals(other, full, StringComparison.OrdinalIgnoreCase))
                {
                    target = doc;
                    break;
                }
            }

            if (target == null)
                throw new BridgeError("DOC_NOT_OPEN",
                    "document \"" + wanted + "\" is not open in SOLIDWORKS. Open it first, or omit "
                    + "\"document\" when this call works on the active document.");

            Documents.Activate(app, target.GetTitle());
            IModelDoc2 active = (IModelDoc2)app.IActiveDoc2;
            string activePath = active == null ? "" : (active.GetPathName() ?? "");
            bool same = string.Equals(activePath, full, StringComparison.OrdinalIgnoreCase);
            if (!same && activePath.Length > 0)
            {
                string normalized = activePath;
                try { normalized = Path.GetFullPath(activePath); }
                catch (Exception) { }
                same = string.Equals(normalized, full, StringComparison.OrdinalIgnoreCase);
            }
            if (!same)
                throw new BridgeError("DOC_MISMATCH",
                    "asked to work on \"" + wanted + "\" but SOLIDWORKS is showing \""
                    + (active == null ? "(no document)" : active.GetTitle()) + "\". "
                    + "Another agent may have switched documents; retry this operation.");
        }

        // ------------------------------------------------- polite mode (A2 / A4)

        /// <summary>当前活动文档标题。只读：不 Attach 新实例、不切文档、不改状态。</summary>
        static string ActiveDocumentTitle(ISldWorks app)
        {
            if (app == null) return null;
            try
            {
                IModelDoc2 doc = (IModelDoc2)app.IActiveDoc2;
                return doc == null ? null : doc.GetTitle();
            }
            catch (COMException) { return null; }
            catch (Exception) { return null; }
        }

        /// <summary>registry 里登记过的 designId（排序后），给 DESIGN_ID_REQUIRED /
        /// DOC_NOT_OPEN 的调用方自救用：不退货单，只给已知的编号。</summary>
        static List<object> KnownDesignIds()
        {
            List<object> ids = new List<object>();
            try
            {
                Dictionary<string, WorkRegistry.Entry> map = WorkRegistry.Load();
                List<string> names = new List<string>(map.Keys);
                names.Sort(StringComparer.Ordinal);
                foreach (string name in names) ids.Add(name);
            }
            catch (Exception) { }
            return ids;
        }

        /// <summary>必须由 designId 指定的文档。
        ///
        /// 这条替换掉九处「doc == null → h.ActiveDocOrThrow()」的兜底。现场事实：
        /// 用户机器上只有一个 SOLIDWORKS，同时开着两个 AI 会话和他自己手画的零件；
        /// 任何一次静默退回"当前活动文档"，都可能把参数、存盘、导出落在他正在编辑的
        /// 那份上。宁可报错让他补 designId，也不要"看起来成功"地改错零件。</summary>
        public static IModelDoc2 RequireDesignDocument(SwHost h, string designId, string op)
        {
            if (string.IsNullOrEmpty(designId))
                throw new BridgeError("DESIGN_ID_REQUIRED",
                    "该操作必须指定 designId；未指定时不会退回到当前活动文档（避免改到用户正在编辑的零件）",
                    Json.Dict("op", op, "designId", null, "knownDesignIds", KnownDesignIds(),
                        "openDocuments", OpenDocumentBrief(h.App)));
            IModelDoc2 doc = DesignDocument(h, designId);
            if (doc == null)
                throw new BridgeError("DOC_NOT_OPEN",
                    "the document for design \"" + designId + "\" is not open in SOLIDWORKS; open it "
                    + "first (workspace action=\"open\") or build it again — this operation never falls "
                    + "back to whichever document happens to be in front",
                    Json.Dict("op", op, "designId", designId, "knownDesignIds", KnownDesignIds(),
                        "openDocuments", OpenDocumentBrief(h.App)));
            return doc;
        }

        /// <summary>本实例当前开着的文档清单，挂在 DOC_NOT_OPEN / DESIGN_ID_REQUIRED 的
        /// detail 里。为什么：模型每次遇到「文档没开」都会先花两三个调用去侦察环境
        /// （查进程、列目录、试各种 designId），而这些信息本来就该由报错自带。</summary>
        private static List<object> OpenDocumentBrief(ISldWorks app)
        {
            List<object> brief = new List<object>();
            try
            {
                foreach (IModelDoc2 open in Documents.OpenDocuments(app))
                {
                    if (open == null) continue;
                    string title = null, path = null;
                    bool? dirty = null;
                    try { title = open.GetTitle(); } catch (COMException) { }
                    try { path = open.GetPathName(); } catch (COMException) { }
                    try { dirty = open.GetSaveFlag(); } catch (COMException) { }
                    brief.Add(Json.Dict("title", title, "path", path, "dirty", dirty));
                }
            }
            catch (COMException) { }
            return brief;
        }

        /// <summary>可选 designId 的读操作：带了就按 designId 找文档；没带才用前台那份，
        /// 并在返回体里如实标出 documentFallback / documentTitle（A2 的第二类）。</summary>
        public static IModelDoc2 OptionalDesignDocument(SwHost h, Dictionary<string, object> req,
            string op, out bool fallback)
        {
            string designId = Json.Str(req, "designId", null);
            if (!string.IsNullOrEmpty(designId))
            {
                fallback = false;
                return RequireDesignDocument(h, designId, op);
            }
            fallback = true;
            return h.ActiveDocOrThrow();
        }

        /// <summary>把「这次没指定 designId、动的是前台那份」写进返回体。</summary>
        public static Dictionary<string, object> MarkDocumentFallback(Dictionary<string, object> result,
            IModelDoc2 doc, bool fallback)
        {
            if (result == null) return null;
            result["documentFallback"] = fallback;
            if (!fallback) return result;
            string title = null;
            try { title = doc == null ? null : doc.GetTitle(); } catch (COMException) { }
            result["documentTitle"] = title;
            AddWarning(result, "未指定 designId：本次操作作用在前台文档 \"" + (title ?? "(无)") + "\" 上");
            return result;
        }

        /// <summary>给返回体追加一条 warnings。
        ///
        /// save/export 的 "warnings" 是 SOLIDWORKS 的整数返回值，类型不能改；那种情况下
        /// 别的提醒落到 politeWarnings，宁可多一个字段，也不能把调用方读的类型换掉。</summary>
        public static void AddWarning(Dictionary<string, object> result, string message)
        {
            if (result == null || string.IsNullOrEmpty(message)) return;
            object raw;
            if (result.TryGetValue("warnings", out raw))
            {
                IList list = raw as IList;
                if (list != null) { list.Add(message); return; }
                List<object> extra = null;
                object existing;
                if (result.TryGetValue("politeWarnings", out existing)) extra = existing as List<object>;
                if (extra == null) { extra = new List<object>(); result["politeWarnings"] = extra; }
                extra.Add(message);
                return;
            }
            result["warnings"] = new List<object> { message };
        }

        /// <summary>把用户原来的活动文档还回去（A4）。只动窗口，不动文档内容。
        /// 失败返回 null，由调用方记 warnings，绝不抛错。</summary>
        static string RestoreActiveDocument(string title)
        {
            if (string.IsNullOrEmpty(title)) return null;
            try
            {
                using (SwHost h = SwHost.Attach())
                {
                    string current = ActiveDocumentTitle(h.App);
                    if (string.Equals(current, title, StringComparison.OrdinalIgnoreCase)) return current;
                    IModelDoc2 restored = Documents.Activate(h.App, title);
                    if (restored == null) return null;
                    string after = null;
                    try { after = restored.GetTitle(); } catch (COMException) { }
                    return string.Equals(after, title, StringComparison.OrdinalIgnoreCase) ? after : null;
                }
            }
            catch (BridgeError) { return null; }
            catch (COMException) { return null; }
            catch (Exception) { return null; }
        }

        /// <summary>给结果盖章：restoredActiveDocument + 切不回去时的 warnings。</summary>
        Dictionary<string, object> WithRestoredDocument(Dictionary<string, object> result,
            string originalActiveTitle)
        {
            string restored = RestoreActiveDocument(originalActiveTitle);
            if (result != null) result["restoredActiveDocument"] = restored;
            if (!string.IsNullOrEmpty(originalActiveTitle) && restored == null)
                AddWarning(result, "操作把活动文档切走了，但切回 \"" + originalActiveTitle
                    + "\" 失败；用户窗口现在停在别的文档上");
            return result;
        }

        // ------------------------------------------------------------ liveness

        /// <summary>Cheapest possible round trip. Exists so the supervisor can tell
        /// "no answer" from "wrong answer" without running a real operation.</summary>
        Dictionary<string, object> Ping(Dictionary<string, object> req)
        {
            DateTime started = DateTime.UtcNow;
            using (SwHost h = SwHost.Attach())
            {
                string rev = SafeString(delegate { return h.App.RevisionNumber(); });
                int pid = SafeInt(delegate { return h.App.GetProcessID(); });
                Diagnostics.Remember(pid, rev);
                IModelDoc2 doc = (IModelDoc2)h.App.IActiveDoc2;
                return Json.Dict(
                    "alive", true,
                    "revision", rev,
                    "processId", pid,
                    "activeDoc", doc == null ? null : SafeString(delegate { return doc.GetTitle(); }),
                    "roundTripMs", Json.R((DateTime.UtcNow - started).TotalMilliseconds));
            }
        }

        Dictionary<string, object> Version(Dictionary<string, object> req)
        {
            string swRevision = null;
            int pid = 0;
            string state = "not-running";
            try
            {
                using (SwHost h = SwHost.Attach())
                {
                    swRevision = SafeString(delegate { return h.App.RevisionNumber(); });
                    pid = SafeInt(delegate { return h.App.GetProcessID(); });
                    state = "ready";
                }
            }
            catch (BridgeError be) { state = be.Code; }

            return Json.Dict(
                "bridge", BridgeVersion,
                "protocol", ProtocolVersion,
                "interop", typeof(ISldWorks).Assembly.GetName().Version.ToString(),
                "executable", System.Reflection.Assembly.GetExecutingAssembly().Location,
                // 常驻进程自己占多少内存，长期跑下来会不会只增不减 —— 用这个数看得出。
                "bridgeWorkingSetMb", Json.R(Process.GetCurrentProcess().WorkingSet64 / 1048576.0),
                "swState", state,
                "swRevision", swRevision,
                "swProcessId", pid);
        }

        // -------------------------------------------------------------- invoke

        Dictionary<string, object> InvokeOp(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                return Reflect.Invoke(h, req);
            }
        }

        /// <summary>What this object can do, before the caller guesses. Same attachment
        /// rules as invoke: a read of the live proxy, nothing written.</summary>
        Dictionary<string, object> KindsOp(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                return Reflect.Kinds(h, req);
            }
        }

        // ------------------------------------------------------------- capture

        Dictionary<string, object> Capture(Dictionary<string, object> req)
        {
            string path = Json.Str(req, "path");
            int width = Json.Int(req, "width", 1280);
            int height = Json.Int(req, "height", 800);
            string designId = Json.Str(req, "designId", null);
            if (string.IsNullOrEmpty(path))
                throw new BridgeError("BAD_ARGUMENT", "capture requires \"path\" (absolute BMP path)");

            // A1：默认只出图、不动文档。
            //
            // view / zoomToFit / hideReferenceGeometry 走的是 ShowNamedView2 /
            // ViewZoomtofit2 / BlankRefGeom —— 这三个改的是**会随 save 落盘的视口与显示
            // 状态**，不是截图的临时动作。用户存一次盘，看到的就是 AI 留下的构图和
            // 被藏掉的参考几何。所以默认一律不碰，要改必须显式 mutateView:true。
            bool mutateView = Json.Bool(req, "mutateView", false);
            bool wantZoom = Json.Bool(req, "zoomToFit", false);
            bool wantBlank = Json.Bool(req, "hideReferenceGeometry", false);
            string named = Json.Str(req, "view", null);
            List<object> warnings = new List<object>();
            if (!mutateView)
            {
                // 不静默忽略：调用方以为"切了视图"，实际拍到的是用户当前视角。
                if (!string.IsNullOrEmpty(named)) warnings.Add("view 参数需要 mutateView:true 才生效");
                if (wantZoom) warnings.Add("zoomToFit 需要 mutateView:true 才生效");
                if (wantBlank) warnings.Add("hideReferenceGeometry 需要 mutateView:true 才生效");
            }

            using (SwHost h = SwHost.Attach())
            {
                IModelDoc2 doc = RequireDesignDocument(h, designId, "capture");
                bool namedApplied = false, zoomApplied = false, blankApplied = false;
                if (mutateView)
                {
                    // Named view first, zoom second. A named view restores the zoom it was
                    // saved with, so zooming first left every screenshot framed for
                    // whatever the camera happened to be looking at — a 20 mm bracket came
                    // out as a speck in the middle of a 1100 px frame.
                    if (!string.IsNullOrEmpty(named))
                        namedApplied = TryVoid(delegate { doc.ShowNamedView2(named, -1); });

                    if (wantZoom)
                        zoomApplied = TryVoid(delegate { doc.ViewZoomtofit2(); });

                    // Reference planes and sketches are drawn as orange wireframe over the
                    // part. A screenshot is supposed to show the part, so hide them first
                    // (BlankRefGeom hides planes, axes and sketches in one call) — only
                    // when the caller asked for it in writing.
                    if (wantBlank)
                        blankApplied = TryVoid(delegate { doc.BlankRefGeom(); });
                }

                // Highlight before rendering: the selection is drawn by
                // SOLIDWORKS itself, so the picture cannot disagree with the ids
                // the caller was given.
                List<object> highlightIds = new List<object>(Json.Items(
                    req.ContainsKey("highlight") ? req["highlight"] : null));
                Dictionary<string, object> highlighted = Observe.Highlight(doc, highlightIds);

                DateTime started = DateTime.UtcNow;
                // SaveBMP lives on IModelDoc2 in this interop version, not on the
                // extension object where the 2024 help pages put it.
                string written = Observe.RenderTo(doc, path, width, height);
                bool ok = written != null;

                string caption = Json.Str(req, "caption", null);
                if (ok && !string.IsNullOrEmpty(caption))
                    Observe.DrawCaption(path, caption);
                if (highlightIds.Count > 0)
                    SafeVoid(delegate { doc.ClearSelection2(true); });
                double ms = (DateTime.UtcNow - started).TotalMilliseconds;
                long size = 0;
                try { if (File.Exists(path)) size = new FileInfo(path).Length; } catch { }

                Dictionary<string, object> result = Json.Dict(
                    "saved", ok,
                    "path", path,
                    "bytes", size,
                    "width", width,
                    "height", height,
                    "view", named,
                    // 到底动没动文档视图，如实回报。三个都是 false 才叫"只出图、不动文档"。
                    "viewMutated", Json.Dict(
                        "zoomToFit", zoomApplied,
                        "blankRefGeom", blankApplied,
                        "namedView", namedApplied ? named : null),
                    "highlight", highlighted,
                    "ms", Json.R(ms),
                    // A screenshot is evidence only if the document it came from is
                    // identifiable: two parts open at once made "capture the model"
                    // photograph the wrong one and still report success.
                    "document", Json.Dict(
                        "title", SafeString(delegate { return doc.GetTitle(); }),
                        "path", SafeString(delegate { return doc.GetPathName(); }),
                        "saved", !string.IsNullOrEmpty(SafeString(delegate { return doc.GetPathName(); })),
                        "dirty", SafeBool(delegate { return doc.GetSaveFlag(); }),
                        "configuration", ConfigurationName(doc)),
                    "geometry", Geometry.Snapshot(doc));
                if (warnings.Count > 0) result["warnings"] = warnings;
                return result;
            }
        }

        /// <summary>The active configuration name, read without touching the nested
        /// ConfigurationManager.ActiveConfiguration path: that one returns null in this
        /// interop build and took the whole capture down with it.</summary>
        static string ConfigurationName(IModelDoc2 doc)
        {
            try
            {
                object raw = doc.GetConfigurationNames();
                Array names = raw as Array;
                if (names == null || names.Length == 0) return null;
                // GetConfigurationNames puts the active configuration first on this build.
                return SafeString(delegate { return names.GetValue(0) as string; });
            }
            catch (Exception) { return null; }
        }

        static void SafeVoid(Action a)
        {
            try { a(); } catch (COMException) { }
        }

        /// <summary>像 SafeVoid，但回答"到底做成了没有"。capture 的 viewMutated 要靠它：
        /// 吞掉异常再报"改过了"就是另一种说谎。</summary>
        static bool TryVoid(Action a)
        {
            try { a(); return true; }
            catch (COMException) { return false; }
            catch (Exception) { return false; }
        }
        /// <summary>Reads a sketch's segments back with coordinates, in mm.
        ///
        /// "the profile is wrong" is not actionable; "the arc's centre is at
        /// (-55, 20) instead of (-55, 60)" is. This is the op that answers that,
        /// and it is also how a caller verifies a rectangle did not move after it
        /// was dimensioned.</summary>
        Dictionary<string, object> SketchGeometry(Dictionary<string, object> req)
        {
            string name = Json.Str(req, "sketch", null);
            int index = Json.Int(req, "index", -1);
            string designId = Json.Str(req, "designId", null);
            using (SwHost h = SwHost.Attach())
            {
                // A2：这条以前"有 designId 就用 registry，没有就用前台那份"。有保护的是
                // 「designId 登记了但文档没开」，无保护的是「干脆不给 designId」—— 那等于
                // 读用户正在编辑的那份草图，并把它的几何挂在这个设计名下报回去。
                IModelDoc2 doc = RequireDesignDocument(h, designId, "sketchGeometry");
                IFeature wanted = null;
                int seen = 0;
                IFeature feature = (IFeature)doc.FirstFeature();
                while (feature != null)
                {
                    string type = SafeString(delegate { return feature.GetTypeName2(); });
                    if (type == "ProfileFeature")
                    {
                        if (name != null && SafeString(delegate { return feature.Name; }) == name) wanted = feature;
                        else if (name == null && seen == index) wanted = feature;
                        seen++;
                    }
                    feature = (IFeature)feature.GetNextFeature();
                }

                if (wanted == null && name == null && seen > 0 && index < 0)
                {
                    // Default: the last sketch in the tree.
                    feature = (IFeature)doc.FirstFeature();
                    while (feature != null)
                    {
                        string type = SafeString(delegate { return feature.GetTypeName2(); });
                        if (type == "ProfileFeature") wanted = feature;
                        feature = (IFeature)feature.GetNextFeature();
                    }
                }

                if (wanted == null)
                    throw new BridgeError("NO_SKETCH",
                        name != null
                            ? "no sketch named \"" + name + "\" in this document"
                            : "this document has no sketches",
                        Json.Dict("sketchCount", seen));

                Dictionary<string, object> geometry = Profiles.GeometryOf(wanted);
                Dictionary<string, object> document = Json.Dict();
                document["title"] = doc.GetTitle();
                document["path"] = doc.GetPathName();
                document["saved"] = !string.IsNullOrEmpty(doc.GetPathName());
                geometry["document"] = document;
                return geometry;
            }
        }

        // 「designId 登记了但文档没开」与「干脆没给 designId」现在是同一处判断：
        // RequireDesignDocument（见 polite mode 小节）。旧的那个只处理前一半的
        // EnsureDesignOpen 已经删掉 —— 留着它就会有人再写一条"找不到就退回前台"的路径。


        // ------------------------------------------------------------------- edit

        /// <summary>Changes parameters in the live model and reports both the new
        /// equations and the measured geometry. Never rebuilds coordinates: the write
        /// goes to a global variable and SOLIDWORKS does the propagation.</summary>
        Dictionary<string, object> Edit(Dictionary<string, object> req)
        {
            Dictionary<string, object> parameters = Json.Obj(req["parameters"]);
            if (parameters == null || parameters.Count == 0)
                throw new BridgeError("BAD_ARGUMENT", "edit requires a non-empty \"parameters\" object");

            string designId = Json.Str(req, "designId", null);
            using (SwHost h = SwHost.Attach())
            {
                return h.Silent(delegate
                {
                    // A2：这条以前 doc 找不到就退回前台。改参数是最不能猜的一步 ——
                    // 前台正好是用户手画的零件时，"猜"的代价是改掉他的尺寸。
                    IModelDoc2 doc = RequireDesignDocument(h, designId, "edit");
                    Editor e = new Editor(doc);
                    Dictionary<string, object> dimensions =
                        req.ContainsKey("dimensions") ? Json.Obj(req["dimensions"]) : null;
                    Dictionary<string, object> result = e.SetParameters(parameters, dimensions, designId);
                    result["geometry"] = Geometry.Snapshot(doc);
                    result["document"] = Json.Dict(
                        "title", doc.GetTitle(),
                        "path", doc.GetPathName());
                    return result;
                });
            }
        }

        // -------------------------------------------------------- circular pattern

        /// <summary>
        /// Native circular pattern of one feature about a reference axis built from
        /// two default planes. Selections are explicit because FeatureCirPattern
        /// consumes whatever is selected when it is called; an implicit selection
        /// left over from a previous op is how a pattern lands on the wrong feature.
        /// </summary>
        // ------------------------------------------------------- helix/sweep/loft

        /// <summary>Applies one helix / sweep / loft to the current design document.
        ///
        /// The declarative compiler already understands these three as features
        /// inside a design definition; this op is the interactive counterpart: the
        /// sketches and curves are already in the tree (built by build / sketch), and
        /// the request names them by feature name (which for compiled features is the
        /// design id). It exists because the tool face must offer them as *actions* —
        /// "build the whole part again" is not an acceptable way to add a thread.
        ///
        /// Nothing here guesses: a missing sketch, an unknown kind, an unsupported
        /// argument all throw with the name that failed. Parameters are passed through
        /// to Sweeps, which enumerates the accepted strings itself.</summary>
        Dictionary<string, object> FeatureOp(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                string designId = Json.Str(req, "designId", null);
                IModelDoc2 doc = RequireDesignDocument(h, designId, "feature");
                Dictionary<string, object> f = Json.Obj(req.ContainsKey("feature") ? req["feature"] : req);
                if (f == null)
                    throw new BridgeError("BAD_ARGUMENT", "feature needs a \"feature\" object");
                string kind = Json.Str(f, "kind", null);
                if (string.IsNullOrEmpty(kind))
                    throw new BridgeError("BAD_ARGUMENT",
                        "feature.kind is required (helix | sweep | loft)");

                Sweeps sweeps = new Sweeps(h, doc);
                double before = Geometry.TotalVolumeMm3(doc);
                IFeature made;
                string id = Json.Str(f, "id", null);

                if (string.Equals(kind, "helix", StringComparison.OrdinalIgnoreCase))
                {
                    IFeature baseSketch = RequiredFeature(doc, Json.Str(f, "profile", Json.Str(f, "sketch", null)), "profile");
                    made = sweeps.Helix(baseSketch,
                        Json.Str(f, "definedBy", "heightAndPitch"),
                        Json.Bool(f, "reversed", false), Json.Bool(f, "clockwise", false),
                        Json.Bool(f, "tapered", false), Json.Bool(f, "outward", false),
                        Json.Dbl(f, "height", 0), Json.Dbl(f, "pitch", 0),
                        Json.Dbl(f, "revolutions", 0), Json.Dbl(f, "taperAngle", 0),
                        Json.Dbl(f, "startAngle", 0));
                }
                else if (string.Equals(kind, "sweep", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(kind, "sweptCut", StringComparison.OrdinalIgnoreCase))
                {
                    bool circular = Json.Bool(f, "circularProfile", false);
                    IFeature profile = circular ? null
                        : RequiredFeature(doc, Json.Str(f, "profile", null), "profile");
                    IFeature path = RequiredFeature(doc, Json.Str(f, "path", null), "path");
                    List<IFeature> guides = NamedFeatures(doc, f.ContainsKey("guides") ? f["guides"] : null, "guides");
                    bool cut = string.Equals(kind, "sweptCut", StringComparison.OrdinalIgnoreCase)
                        || Json.Bool(f, "cut", false);
                    made = sweeps.Sweep(profile, path, guides, cut ? "cut" : "boss",
                        Json.Bool(f, "thin", false), Json.Dbl(f, "thickness", 0), Json.Dbl(f, "thickness2", 0),
                        Json.Str(f, "thinType", "oneDirection"), Json.Bool(f, "reverseThickness", false),
                        Json.Bool(f, "propagate", true), Json.Bool(f, "alignment", true),
                        Json.Str(f, "twistControl", "followPath"), Json.Dbl(f, "twist", 0),
                        Json.Str(f, "startMatch", "none"), Json.Str(f, "endMatch", "none"),
                        Json.Bool(f, "advancedSmoothing", true), Json.Bool(f, "merge", true),
                        circular, Json.Dbl(f, "circularDiameter", 0), Json.Bool(f, "reverseDirection", false));
                }
                else if (string.Equals(kind, "loft", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(kind, "loftedCut", StringComparison.OrdinalIgnoreCase))
                {
                    List<IFeature> sections = NamedFeatures(doc, f.ContainsKey("sections") ? f["sections"] : null, "sections");
                    if (sections.Count == 0)
                        throw new BridgeError("BAD_ARGUMENT", "loft needs \"sections\": [feature names]");
                    List<IFeature> guides = NamedFeatures(doc, f.ContainsKey("guides") ? f["guides"] : null, "guides");
                    string mode = string.Equals(kind, "loftedCut", StringComparison.OrdinalIgnoreCase)
                        ? "cut" : Json.Str(f, "mode", "boss");
                    made = sweeps.Loft(sections, mode, guides,
                        Json.Bool(f, "closed", false), Json.Bool(f, "keepTangency", false),
                        Json.Bool(f, "thin", false), Json.Dbl(f, "thickness", 0), Json.Dbl(f, "thickness2", 0),
                        Json.Str(f, "thinType", "oneDirection"), Json.Bool(f, "merge", true),
                        Json.Bool(f, "advancedSmoothing", true), Json.Int(f, "startMatch", 0),
                        Json.Int(f, "endMatch", 0), Json.Dbl(f, "tessTolerance", 1));
                }
                else
                {
                    throw new BridgeError("INVALID_ARGUMENT",
                        "feature.kind=\"" + kind + "\" is not one of helix, sweep, sweptCut, loft, loftedCut");
                }

                if (made == null)
                    throw new BridgeError("FEATURE_FAILED", "the " + kind + " produced no feature");
                // 编译路径用设计 id 命名特征；这里保持同一套约定，后续按 id 引用才找得到。
                if (!string.IsNullOrEmpty(id) && !string.Equals(made.Name, id, StringComparison.Ordinal))
                {
                    try { made.Name = id; } catch (COMException) { }
                }

                double after = Geometry.TotalVolumeMm3(doc);
                return Json.Dict(
                    "kind", kind,
                    "id", id,
                    "feature", made.Name,
                    "type", SafeString(delegate { return made.GetTypeName2(); }),
                    "steps", new List<object>(sweeps.Steps.ToArray()),
                    "volumeBeforeMm3", Json.R(before),
                    "volumeAfterMm3", Json.R(after),
                    "removedMm3", Json.R(before - after),
                    "faces", SafeInt(delegate { return FaceCount(doc); }));
            }
        }

        /// <summary>Resolves a feature the request named. A miss is FEATURE_NOT_FOUND
        /// with the names that do exist, because "which sketch did you mean" is the
        /// question a sweep failure should never have to ask.</summary>
        static IFeature RequiredFeature(IModelDoc2 doc, string name, string what)
        {
            if (string.IsNullOrEmpty(name))
                throw new BridgeError("BAD_ARGUMENT", what + " is required (a feature name)");
            IFeature feature = SwHost.FindFeature(doc, name);
            if (feature == null)
            {
                List<object> known = new List<object>();
                foreach (IFeature f in SwHost.Features(doc))
                    if (f != null) known.Add(f.Name);
                throw new BridgeError("FEATURE_NOT_FOUND",
                    what + " \"" + name + "\" is not in this document's feature tree",
                    Json.Dict("what", what, "name", name, "features", known));
            }
            return feature;
        }

        static List<IFeature> NamedFeatures(IModelDoc2 doc, object raw, string what)
        {
            List<IFeature> list = new List<IFeature>();
            if (raw == null) return list;
            string single = raw as string;
            if (single != null)
            {
                list.Add(RequiredFeature(doc, single, what));
                return list;
            }
            foreach (object item in Json.Items(raw))
            {
                string name = item as string;
                if (name != null) list.Add(RequiredFeature(doc, name, what));
            }
            return list;
        }

        static int FaceCount(IModelDoc2 doc)
        {
            IPartDoc part = doc as IPartDoc;
            if (part == null) return 0;
            object[] bodies = null;
            try { bodies = (object[])part.GetBodies2((int)swBodyType_e.swSolidBody, false); }
            catch (COMException) { }
            if (bodies == null) return 0;
            int faces = 0;
            foreach (object raw in bodies)
            {
                IBody2 body = raw as IBody2;
                if (body == null) continue;
                object[] list = null;
                try { list = (object[])body.GetFaces(); }
                catch (COMException) { }
                if (list != null) faces += list.Length;
            }
            return faces;
        }

        Dictionary<string, object> PatternCircular(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                // A2：阵列会在选中的特征上真的写几何，不能落在"前台那份"上。
                IModelDoc2 doc = RequireDesignDocument(h, Json.Str(req, "designId", null), "patternCircular");

                string name = Json.Str(req, "feature", null);
                int ordinal = Json.Int(req, "featureIndex", -1);
                IFeature target = !string.IsNullOrEmpty(name)
                    ? SwHost.FindFeature(doc, name)
                    : FeatureAt(doc, ordinal);
                if (target == null)
                    throw new BridgeError("FEATURE_NOT_FOUND",
                        "no feature named \"" + (name ?? "") + "\" and no feature at index " + ordinal);

                ArrayList planes = Json.Arr(req.ContainsKey("axisPlanes") ? req["axisPlanes"] : null);
                int firstPlane = planes.Count > 0 ? Convert.ToInt32(planes[0]) : 1;
                int secondPlane = planes.Count > 1 ? Convert.ToInt32(planes[1]) : 2;
                int count = Math.Max(2, Json.Int(req, "count", 4));
                double angleDeg = Json.Dbl(req, "angleDeg", 360.0);
                bool flip = Json.Bool(req, "flip", false);

                IFeature planeA = SwHost.RefPlane(doc, firstPlane);
                IFeature planeB = SwHost.RefPlane(doc, secondPlane);
                if (planeA == null || planeB == null)
                    throw new BridgeError("REF_PLANE_NOT_FOUND",
                        "axis needs two reference planes; got ordinals " + firstPlane + " and " + secondPlane);

                doc.ClearSelection2(true);
                if (!target.Select2(false, 0))
                    throw new BridgeError("SELECTION_FAILED", "could not select feature \"" + target.Name + "\"");
                planeA.Select2(true, 0);
                planeB.Select2(true, 0);
                if (!doc.InsertAxis2(true))
                    throw new BridgeError("AXIS_FAILED",
                        "InsertAxis2 refused planes " + firstPlane + "/" + secondPlane);
                IFeature axis = LastFeature(doc);
                if (axis == null)
                    throw new BridgeError("AXIS_FAILED", "no axis feature appeared after InsertAxis2");

                doc.ClearSelection2(true);
                IModelDocExtension ext = (IModelDocExtension)doc.Extension;
                bool selAxis = ext.SelectByID2(axis.Name, "AXIS", 0, 0, 0, false, 1, null, 0)
                    || axis.Select2(false, 0);
                if (!selAxis)
                    throw new BridgeError("SELECTION_FAILED", "could not select axis \"" + axis.Name + "\"");
                bool selFeature = ext.SelectByID2(target.Name, "BODYFEATURE", 0, 0, 0, true, 4, null, 0)
                    || ext.SelectByID2(target.Name, "FEATURE", 0, 0, 0, true, 4, null, 0)
                    || target.Select2(true, 0);
                if (!selFeature)
                    throw new BridgeError("SELECTION_FAILED", "could not select feature \"" + target.Name + "\"");
                int selected = ((ISelectionMgr)doc.SelectionManager).GetSelectedObjectCount2(-1);
                HashSet<string> before = FeatureNames(doc);
                IFeatureManager fm = (IFeatureManager)doc.FeatureManager;
                object created = fm.FeatureCircularPattern5(
                    count, angleDeg * Math.PI / 180.0, flip, "",
                    false, true, false, false, false, false, 1, 0.0, "", true);
                IFeature pattern = created as IFeature;
                if (pattern == null) pattern = NewFeature(doc, before);
                if (pattern == null)
                {
                    doc.FeatureCirPattern(count, angleDeg * Math.PI / 180.0, flip, "");
                    pattern = NewFeature(doc, before);
                }
                string patternName = pattern != null ? pattern.Name : null;
                if (string.IsNullOrEmpty(patternName))
                    throw new BridgeError("PATTERN_FAILED",
                        "FeatureCircularPattern5/FeatureCirPattern did not create a pattern feature",
                        Json.Dict("selected", selected, "feature", target.Name, "axis", axis.Name,
                            "features", new ArrayList(new List<string>(FeatureNames(doc)))));

                return Json.Dict(
                    "feature", target.Name,
                    "axis", axis.Name,
                    "pattern", patternName,
                    "count", count,
                    "angleDeg", angleDeg,
                    "flip", flip);
            }
        }

        static IFeature FeatureAt(IModelDoc2 doc, int ordinal)
        {
            if (ordinal < 0) return null;
            IFeature f = (IFeature)doc.FirstFeature();
            int i = 0;
            while (f != null)
            {
                if (i == ordinal) return f;
                i++;
                f = (IFeature)f.GetNextFeature();
            }
            return null;
        }

        static IFeature LastFeature(IModelDoc2 doc)
        {
            IFeature f = (IFeature)doc.FirstFeature();
            IFeature last = null;
            while (f != null)
            {
                last = f;
                f = (IFeature)f.GetNextFeature();
            }
            return last;
        }

        static HashSet<string> FeatureNames(IModelDoc2 doc)
        {
            HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
            IFeature f = (IFeature)doc.FirstFeature();
            while (f != null)
            {
                names.Add(f.Name);
                f = (IFeature)f.GetNextFeature();
            }
            return names;
        }

        /// <summary>First feature that did not exist before the last operation. A pattern
        /// can be inserted above the axis in the tree, so "last feature" is not reliable.</summary>
        static IFeature NewFeature(IModelDoc2 doc, HashSet<string> before)
        {
            IFeature f = (IFeature)doc.FirstFeature();
            while (f != null)
            {
                if (!before.Contains(f.Name)) return f;
                f = (IFeature)f.GetNextFeature();
            }
            return null;
        }

        // ------------------------------------------------------------------- save

        Dictionary<string, object> Save(Dictionary<string, object> req)
        {
            string path = Json.Str(req, "path");
            string designId = Json.Str(req, "designId", null);
            using (SwHost h = SwHost.Attach())
            {
                // A2：存盘是最不能猜的一步。前台是用户的未存盘零件时，一次"顺手存"
                // 就会把他的文档写成 AI 的路径（现场：20:17 的 零件13 * 在 20:26 变成
                // 轴承支架.SLDPRT，正是 SaveAs 打在了别人的文档上）。
                IModelDoc2 doc = RequireDesignDocument(h, designId, "save");
                if (string.IsNullOrEmpty(path))
                {
                    if (string.IsNullOrEmpty(doc.GetPathName()))
                        throw new BridgeError("BAD_ARGUMENT",
                            "the document has never been saved; pass an explicit \"path\"");
                    bool okSave = doc.Save3((int)swSaveAsOptions_e.swSaveAsOptions_Silent, 0, 0);
                    if (okSave)
                        WorkRegistry.Record(designId, doc.GetTitle(), doc.GetPathName(),
                            WorkRegistry.OriginBuild, Json.Str(req, "sessionId", null));
                    return Json.Dict("saved", okSave, "path", doc.GetPathName());
                }

                string dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);

                // A previous run can leave a document open on the same path. Saving
                // over it returns swGenericSaveError (1) even though the model is
                // fine, so that document is closed first.
                string blocker = Documents.CloseDocumentOnPath(h.App, path, doc.GetTitle());
                if (blocker != null)
                    throw new BridgeError("SAVE_TARGET_OPEN",
                        "SOLIDWORKS has another document open on " + path
                        + " (" + blocker + ") and could not close it; close it and retry");

                int errors = 0, warnings = 0;
                bool ok = ((IModelDocExtension)doc.Extension).SaveAs3(
                    path, (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                    (int)swSaveAsOptions_e.swSaveAsOptions_Silent,
                    null, null, ref errors, ref warnings);
                if (ok)
                    WorkRegistry.Record(designId, doc.GetTitle(), path,
                        WorkRegistry.OriginBuild, Json.Str(req, "sessionId", null));

                // Saving under a new name renames the document, which leaves every
                // equation reference pointing at the old name. Repair them now, while
                // the mismatch is still known, instead of letting the next edit
                // silently do nothing.
                List<object> repaired = ok
                    ? new Editor(doc).RepairEquationReferences()
                    : new List<object>();
                return Json.Dict(
                    "saved", ok,
                    "path", path,
                    "errors", errors,
                    "warnings", warnings,
                    "bytes", File.Exists(path) ? new FileInfo(path).Length : 0,
                    "repairedEquations", repaired);
            }
        }

        /// <summary>Closes every document and exits SOLIDWORKS.
        ///
        /// Worth having as an operation rather than a taskkill: SOLIDWORKS holds
        /// about 1.5 GB while it is open, and a long-running session that keeps
        /// opening documents grows it further. Exiting cleanly also lets it write
        /// its own recovery data.</summary>
        Dictionary<string, object> Quit(Dictionary<string, object> req)
        {
            bool closeDocuments = Json.Bool(req, "closeDocuments", true);
            using (SwHost h = SwHost.Attach())
            {
                List<object> closed = new List<object>();
                if (closeDocuments)
                {
                    object raw = h.App.GetDocuments();
                    Array docs = raw as Array;
                    if (docs != null)
                    {
                        foreach (object entry in docs)
                        {
                            IModelDoc2 doc = entry as IModelDoc2;
                            if (doc == null) continue;
                            string title = null;
                            try { title = doc.GetTitle(); } catch (COMException) { continue; }
                            try
                            {
                                doc.SetSaveFlag();
                                h.App.CloseDoc(title);
                                closed.Add(title);
                            }
                            catch (COMException) { }
                        }
                    }
                }

                // ExitApp returns void, so there is no status to report — the caller
                // confirms the process is gone by asking Diagnostics afterwards.
                h.App.ExitApp();
                return Json.Dict(
                    "closedDocuments", closed,
                    "closedCount", closed.Count,
                    "exitRequested", true);
            }
        }

        // ----------------------------------------------------------------- export

        /// <summary>Writes the document out as one file (STEP by default).
        ///
        /// The selection is cleared before SaveAs3, and that is not cosmetic.
        /// Measured 2026-11-13 on a part whose geometry is 41 faces and
        /// 642,853.408595 mm³: with a face left selected, SaveAs3 to .step returned
        /// true and wrote 10,642 B, and analysis read 0 mm³ / 1 face / 8 edges. The
        /// same document exported after `select clear` wrote 98,948 B. SaveAs3
        /// reports nothing wrong, so the selection state is part of the export's
        /// correctness, not a display detail.
        ///
        /// Because the return code is not trustworthy on its own, success is decided
        /// by a self-check of what actually landed on disk and the size is returned
        /// so a caller can compare runs. Parsing the STEP is deliberately out of
        /// scope: that is analysis action="step", which is what nextActions points at
        /// when the self-check fails.</summary>
        Dictionary<string, object> Export(Dictionary<string, object> req)
        {
            string kind = Json.Str(req, "kind", "step");
            string path = Json.Str(req, "path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeError("BAD_ARGUMENT", "export requires \"path\"");

            // "all" was never read by this op. Rejecting it is the point: silently
            // ignoring it let a caller believe all:true changed the output, and the
            // next measurement then "proved" a fix that never happened.
            if (req.ContainsKey("all"))
                throw new BridgeError("DEPRECATED_ARG",
                    "all 对文件导出无效：export 只写一个文件，多体导出不是这个 op 的开关；"
                    + "多体/全部实体统计请把 all:true 传给 measure holes",
                    Json.Dict(
                        "argument", "all",
                        "nextActions", Json.List(
                            "去掉 all 后按原路径重新导出",
                            "要按实体统计用 measure kind=\"holes\" all:true")));

            int version;
            switch (kind)
            {
                case "step": version = (int)swSaveAsVersion_e.swSaveAsCurrentVersion; break;
                case "stl": version = (int)swSaveAsVersion_e.swSaveAsCurrentVersion; break;
                default: version = (int)swSaveAsVersion_e.swSaveAsCurrentVersion; break;
            }

            string designId = Json.Str(req, "designId", null);
            using (SwHost h = SwHost.Attach())
            {
                // A2：导出会在文档上清选择、再 SaveAs；落在用户那份上等于替他改了
                // 选择状态还写了一个文件出去。
                IModelDoc2 doc = RequireDesignDocument(h, designId, "export");
                string dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);

                // Selection first: a selected face is what turns this export into a
                // 10 kB file that still reports success.
                bool selectionCleared = ClearSelectionForExport(doc);

                int errors = 0, warnings = 0;
                bool ok = ((IModelDocExtension)doc.Extension).SaveAs3(
                    path, version, (int)swSaveAsOptions_e.swSaveAsOptions_Silent,
                    null, null, ref errors, ref warnings);

                bool exists = File.Exists(path);
                long bytes = exists ? new FileInfo(path).Length : 0;
                Dictionary<string, object> selfCheck = Json.Dict("bytes", bytes, "path", path);
                if (!ok || !exists || bytes == 0)
                {
                    // 返回码、文件是否存在、字节数三者任一不成立都不叫「导出了」。
                    // 这里不解析 STEP：几何复核是 analysis action="step" 的事。
                    throw new BridgeError("EXPORT_DEGENERATE",
                        "导出退化：SaveAs3 returned " + ok + "，文件 "
                        + (exists ? bytes + " 字节" : "不存在") + "（" + path + "）。"
                        + "先用 analysis action=\"step\" 复核体积与面数，再决定重导还是重建。",
                        Json.Dict(
                            "kind", kind,
                            "selfCheck", selfCheck,
                            "selectionCleared", selectionCleared,
                            "saveAsReturned", ok,
                            "errors", errors,
                            "warnings", warnings,
                            "nextActions", Json.List(
                                "analysis action=\"step\" path=\"" + path + "\"：读回体积/面数，确认不是 0 mm³ / 1 面",
                                "重新导出同一路径（本 op 已内置清空选择），再跑一次 analysis action=\"step\" 对比字节数",
                                "仍退化就 build 重建该 designId 再导出——长时间运行的实例会写不出 STEP")));
                }

                return Json.Dict(
                    "exported", ok && bytes > 0,
                    "kind", kind,
                    "path", path,
                    "bytes", bytes,
                    "errors", errors,
                    "warnings", warnings,
                    "selfCheck", selfCheck,
                    "selectionCleared", selectionCleared);
            }
        }

        /// <summary>Clears the selection before an export, covering the two forms
        /// SOLIDWORKS builds disagree about. A false return is not fatal: the file is
        /// self-checked anyway, and refusing to export because a selection could not
        /// be cleared would be worse than exporting and reporting the byte count.</summary>
        static bool ClearSelectionForExport(IModelDoc2 doc)
        {
            if (doc == null) return false;
            try { doc.ClearSelection2(true); return true; }
            catch (COMException) { }
            catch (Exception) { }
            try { doc.ClearSelection2(false); return true; }
            catch (COMException) { }
            catch (Exception) { }
            return false;
        }

        /// <summary>Registers a document this bridge just created, so the registry —
        /// not the caller's memory — is what says the window belongs to us.
        ///
        /// newDocument, assemblyNew and drawingNew used to return a document and
        /// record nothing. cleanup only closes titles it finds in WorkRegistry
        /// (Documents.SweepCreatedDocuments), so those documents were permanent
        /// orphans: every create left a window nobody could reclaim without quitting
        /// SOLIDWORKS. The document itself needs no change — only the record — so the
        /// registration sits once, around all three entry points.
        ///
        /// The key is the caller's designId when it sends one, otherwise a
        /// title-derived key under the "created:" prefix: a create has no design id of
        /// its own, and WorkRegistry.Record drops an empty key, which is why the
        /// fallback is not optional. A document already saved to a path is recorded
        /// with that path, and the sweep never touches a document with a path, because
        /// that file may be the user's work.
        ///
        /// 来源固定记成 create（build 入口记 build）：无 designId 的 cleanup 只认
        /// 这两种来源，缺 origin 的历史行一律跳过。请求里带了 sessionId 就一并记上，
        /// 让别的会话的 cleanup 不碰这一条。</summary>
        static Dictionary<string, object> RegisterCreated(
            Dictionary<string, object> req, Dictionary<string, object> result)
        {
            if (result == null) return null;
            object raw;
            if (!result.TryGetValue("document", out raw)) return result;
            Dictionary<string, object> doc = Json.Obj(raw);
            if (doc == null) return result;
            string title = Json.Str(doc, "title");
            if (string.IsNullOrEmpty(title)) return result;
            string designId = Json.Str(req, "designId", null);
            if (string.IsNullOrEmpty(designId)) designId = CreatedDesignIdPrefix + title;
            string path = Json.Str(doc, "path", null);
            WorkRegistry.Record(designId, title, string.IsNullOrEmpty(path) ? null : path,
                WorkRegistry.OriginCreate, Json.Str(req, "sessionId", null));
            return result;
        }

        /// <summary>Key prefix for a document created without a designId. Visible in
        /// state/documents.json so a human can see where an untitled window came
        /// from.</summary>
        public const string CreatedDesignIdPrefix = "created:";

        /// <summary>Closes one document by title, for the case where a stale document
        /// still holds a path the caller wants to write to.</summary>
        Dictionary<string, object> Close(Dictionary<string, object> req)
        {
            string title = Json.Str(req, "title");
            string prefix = Json.Str(req, "pathPrefix");
            if (string.IsNullOrEmpty(title) && string.IsNullOrEmpty(prefix))
                throw new BridgeError("BAD_ARGUMENT",
                    "close requires \"title\" (one document by name) or "
                    + "\"pathPrefix\" (every document saved under that directory)");
            using (SwHost h = SwHost.Attach())
            {
                if (!string.IsNullOrEmpty(prefix))
                {
                    List<string> many = Documents.CloseUnderPath(h.App, prefix,
                        Json.Bool(req, "untitled", false));
                    return Json.Dict(
                        "closed", Json.List(many.ToArray()),
                        "closedCount", many.Count,
                        "found", many.Count > 0,
                        "remaining", Documents.OpenDocuments(h.App).Count);
                }
                string reason = null;
                string closed = Documents.CloseByTitle(h.App, title,
                    Json.Bool(req, "allowDirty", false), Json.Str(req, "sessionId", null),
                    Json.Str(req, "designId", null), out reason);
                if (closed == null && reason != null)
                {
                    // A5：脏的就不是我们的 —— 不静默丢修改，明确报 USER_DOC_DIRTY。
                    throw new BridgeError(reason,
                        "文档 \"" + title + "\" 有未存盘的修改，而且不是本会话/build 出来的："
                        + "关掉它会丢掉用户的改动，所以拒绝关闭。要关请让用户自己存盘后关，"
                        + "或先 workspace action=\"instances\" 确认这个窗口是谁的。",
                        Json.Dict("title", title, "reason", reason,
                            "remaining", Documents.OpenDocuments(h.App).Count));
                }
                return Json.Dict(
                    "closed", closed,
                    "closedDocuments", closed == null
                        ? new List<object>()
                        : new List<object> { Json.Dict("title", closed, "reason", "explicit-close") },
                    "skippedDirty", new List<object>(),
                    "found", closed != null,
                    "remaining", Documents.OpenDocuments(h.App).Count);
            }
        }

        /// <summary>Closes untitled documents this bridge created and never saved.
        /// Only titles recorded in the work registry are touched, so a document the
        /// user opened by hand is never closed.
        ///
        /// 两条分支都只关「来源明确是本工具建的」登记项（origin 为 build/create）；
        /// registry 里缺 origin 的旧行一律按 unknown 跳过并计数 —— registry 是全局
        /// 文件，历史行可能是用户手开的 零件N 同名条目，宁可少关一个窗口。</summary>
        Dictionary<string, object> Cleanup(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                // 带 designId 的清理只关这个设计自己的未存盘文档；多个会话共用一个
                // SOLIDWORKS 实例时，不能把别人正在建的零件一起关掉（实测两会话
                // 交替 build 会互相清掉对方文档）。不带 designId 才是会话级清扫。
                string onlyDesignId = Json.Str(req, "designId");
                string sessionId = Json.Str(req, "sessionId", null);
                Documents.SweepOutcome sweep = Documents.SweepDocuments(h.App, onlyDesignId, sessionId);
                return Json.Dict(
                    "closed", sweep.Closed,
                    "closedDocuments", sweep.ClosedRecords,
                    "skippedUnknown", sweep.SkippedUnknown,
                    "skippedOtherSession", sweep.SkippedOtherSession,
                    // A5：用户未存盘的文档一份都没动，这里如实列出来（含原因）。
                    "skippedDirty", sweep.SkippedDirty,
                    "remaining", Documents.OpenDocuments(h.App).Count);
            }
        }

        // ----------------------------------------------------------- newDocument

        Dictionary<string, object> NewDocument(Dictionary<string, object> req)
        {
            string template = Json.Str(req, "template");
            if (template == null)
                template = Path.Combine(SwHost.TemplateDir, "gb_part.prtdot");
            if (!File.Exists(template))
                throw new BridgeError("TEMPLATE_NOT_FOUND", "part template not found: " + template);

            using (SwHost h = SwHost.Attach())
            {
                IModelDoc2 doc = (IModelDoc2)h.App.NewDocument(template, 0, 0, 0);
                if (doc == null)
                    throw new BridgeError("NEW_DOCUMENT_FAILED",
                        "SOLIDWORKS refused to create a document from " + template);
                return Json.Dict(
                    "document", Json.Dict(
                        "title", doc.GetTitle(),
                        "path", doc.GetPathName(),
                        "template", template));
            }
        }

        // ------------------------------------------------------------------ build

        /// <summary>Builds a part from a design definition in one call: new document,
        /// parameters as global variables, features in order, then a rebuild and a
        /// geometry read-back. The read-back is the point: a feature that returns
        /// non-null but changes nothing is indistinguishable from success until the
        /// body is measured.</summary>
        /// <summary>A build that throws must not leave its half-made document behind.
        ///
        /// Without this the failed attempt stays open as an untitled part, the next
        /// attempt stacks another one on top of it, and "the active document" quietly
        /// stops being the thing the caller thinks it is. The registry already knows
        /// which document belongs to which design, so undoing is one lookup.</summary>
        void RollbackBuild(Dictionary<string, object> req)
        {
            try
            {
                Dictionary<string, object> definition = Json.Obj(req["definition"]);
                if (definition == null) return;
                string designId = Json.Str(definition, "designId", null);
                if (string.IsNullOrEmpty(designId)) return;
                using (SwHost h = SwHost.Attach())
                    Documents.CloseDesign(h.App, designId, Json.Str(req, "sessionId", null));
            }
            catch (Exception)
            {
                // Rolling back is best effort: the caller is already being told
                // about the original failure, and a rollback error would hide it.
            }
        }

        Dictionary<string, object> Build(Dictionary<string, object> req)
        {
            Dictionary<string, object> definition = Json.Obj(req["definition"]);
            if (definition == null)
                throw new BridgeError("BAD_ARGUMENT", "build requires a \"definition\" object");

            // Definition-only checks first: no COM, no document, no SOLIDWORKS needed.
            if (Json.Bool(req, "validate", false))
                return Builder.ValidatePlan(definition, req);

            // "sketch" stops after the sketch: no extrusion, no volume, no judgement
            // based on a body that was never asked for.
            string output = Json.Str(req, "output", Json.Str(definition, "output", "part"));
            if (string.Equals(output, "sketch", StringComparison.OrdinalIgnoreCase))
                return BuildSketchDocument(req, definition);

            string template = Json.Str(req, "template");
            if (template == null)
                template = Path.Combine(SwHost.TemplateDir, "gb_part.prtdot");
            if (!File.Exists(template))
                throw new BridgeError("TEMPLATE_NOT_FOUND", "part template not found: " + template);

            List<string> steps = new List<string>();
            // A5：build 开头那次前置关闭只关「本会话 build/create 出来的」。这两份清单
            // 就是"关掉了谁 / 为什么没关"的凭据，直接进返回体。
            List<object> closedDocuments = new List<object>();
            List<object> skippedDirty = new List<object>();
            string requestedId = Json.Str(definition, "designId", null);
            string sessionId = Json.Str(req, "sessionId", null);
            using (SwHost h = SwHost.Attach())
            {
                return h.Silent(delegate
                {
                    // A rebuild of the same design replaces the old document rather
                    // than stacking another untitled part on top of it.
                    Documents.CloseResult previous = Documents.CloseDesign(h.App, requestedId, sessionId);
                    if (previous.Closed != null)
                    {
                        steps.Add("closed previous document " + previous.Closed);
                        closedDocuments.Add(Json.Dict("title", previous.Closed, "reason", "replaced-by-build"));
                    }
                    else if (previous.Skipped)
                    {
                        // 不关用户的未存盘件：继续建，但把它留在这里并说清原因。
                        steps.Add("kept \"" + (previous.Title ?? "?") + "\" (" + previous.Reason + ")");
                        skippedDirty.Add(Json.Dict("title", previous.Title, "reason", previous.Reason));
                    }

                    IModelDoc2 doc = (IModelDoc2)h.App.NewDocument(template, 0, 0, 0);
                    if (doc == null)
                        throw new BridgeError("NEW_DOCUMENT_FAILED", "could not create a document");
                    // 关掉「输入尺寸值」弹框。这个首选项开着时，每画一条线都可能弹出尺寸输入框，
                    // 而弹框会挡住 COM：后续调用一律回 SW_BLOCKED_BY_DIALOG，看起来像随机失败。
                    // 只改我们刚建的这个文档，不动用户的全局设置。
                    try
                    {
                        doc.SetUserPreferenceToggle(
                            (int)SolidWorks.Interop.swconst.swUserPreferenceToggle_e.swInputDimValOnCreate,
                            false);

                        steps.Add("dialogSuppression on");
                    }
                    catch (COMException ex)
                    {
                        steps.Add("dialogSuppression failed: " + ex.Message);
                    }
                    steps.Add("newDocument " + template);
                    string designId = Json.Str(definition, "designId", null);
                    WorkRegistry.Record(designId, doc.GetTitle(), null,
                        WorkRegistry.OriginBuild, Json.Str(req, "sessionId", null));
                    Compiler c = new Compiler(h, doc);
                    c.DisableBindings = Json.Bool(req, "noBindings", false);
                    c.DeclareParameters(definition.ContainsKey("params") ? Json.Obj(definition["params"]) : null);
                    steps.Add("parameters " + c.Params.Count);

                    // 全局变量不在建特征之前写：实测「先写全局变量、再绑尺寸」时方程式管理器
                    // 一律返回 rc=-1（四种写法都试过），而「先绑尺寸」时 SW 会隐式把变量建出来。
                    // 顺序改成：建特征（绑定在这里发生）→ 补齐没被绑定带出来的参数。
                    // variables 只有 PushGlobalVariables() 才会填上，所以「方程式被拒」的
                    // 判定必须放在它之后 —— 见下面那段。
                    List<object> variables = new List<object>();

                    Builder b = new Builder(h, doc);
                    List<object> features = c.BuildFeatures(
                        Json.Items(definition["features"]), b);
                    steps.Add("features " + features.Count);

                    variables = c.PushGlobalVariables();
                    steps.Add("globalVariables " + variables.Count
                        + " (added " + c.VariablesAdded + ", existed " + c.VariablesExisted + ")");

                    // 往方程式管理器写全局变量失败，是环境问题，不是设计问题 ——
                    // 而且它不会以异常形式出现：Add2 只是返回 -1，几何照样建对，
                    // 于是「看起来成功」的件再也不能被参数驱动。
                    //
                    // 这段以前放在建特征之前，遍历的是刚 new 出来的空表，rejected 恒为 0：
                    // 方程式被拒只落进 notes（Compiler.cs 的 PushGlobalVariables），
                    // 「宁可失败也不交静态件」这条承诺其实从未生效。现在按真实回执判，
                    // 并且分清三种情况：
                    //   · 全部被拒，但每条绑定都落了字面值（M20 的字面值路径）→ 不失败，
                    //     但把被拒的参数写清楚，drivers.mode 如实报 literal；
                    //   · 部分被拒（有的绑上、有的没绑上）→ 不失败，但绝不能报 equation：
                    //     这些参数的改写会退化成重建，drivers.mode 降级为 literal 并记 notes；
                    //   · 请求过绑定却一条都没落地（方程式没有、字面值也没有）→ 这个件
                    //     从出生就是静态且改不动的，抛 EQUATION_MANAGER_REJECTED。
                    List<string> rejectedParams = new List<string>();
                    List<string> rejectionTexts = new List<string>();
                    string firstRejection = null;
                    foreach (object entry in variables)
                    {
                        Dictionary<string, object> row = entry as Dictionary<string, object>;
                        if (row == null) continue;
                        object rcValue = row["rc"];
                        int rc = rcValue == null ? 0 : Convert.ToInt32(rcValue);
                        if (rc >= 0) continue;
                        string param = Convert.ToString(row["param"]);
                        string text = Convert.ToString(row["text"]);
                        string line = (text ?? "?") + " → rc=" + rc;
                        rejectedParams.Add(param ?? "?");
                        rejectionTexts.Add(line);
                        if (firstRejection == null) firstRejection = line;
                    }
                    bool equationDriven = c.Bindings.Count > 0;
                    // 字面值兜底：绑定没写成时 BindDimension 直接把参数值写进尺寸，
                    // 改参数靠重建。只有「请求过绑定、且每一条都落成了字面值」才算兜住。
                    bool literalCovered = c.RequestedBinds > 0
                        && c.LiteralApplied >= c.RequestedBinds;
                    if (rejectedParams.Count > 0 && !equationDriven && !literalCovered
                        && c.RequestedBinds > 0)
                    {
                        throw new BridgeError("EQUATION_MANAGER_REJECTED",
                            "SOLIDWORKS 拒绝了写方程式（" + rejectedParams.Count + "/"
                            + variables.Count + " 条），被拒参数：" + string.Join(", ", rejectedParams.ToArray())
                            + "。请求了 " + c.RequestedBinds + " 条尺寸绑定，方程式一条也没落地、"
                            + "字面值兜底也只落了 " + c.LiteralApplied + " 条：这个件从出生就是静态的，"
                            + "改参数不会动。先让 SOLIDWORKS 退出再重新打开，然后重新建模。"
                            + "首次失败的方程式（SW 原话）：" + firstRejection,
                            Json.Dict("rejected", rejectedParams.Count,
                                "attempted", variables.Count,
                                "parameters", rejectedParams,
                                "rejections", rejectionTexts,
                                "firstRejection", firstRejection,
                                "bindings", c.Bindings.Count,
                                "requested", c.RequestedBinds,
                                "appliedLiteral", c.LiteralApplied,
                                "notes", c.Notes));
                    }
                    if (rejectedParams.Count > 0 && equationDriven)
                    {
                        // 部分被拒：绑上的参数仍由方程式驱动，没绑上的只能靠重建。
                        // 这一条必须进 notes，不能让「equation」这个说法把它盖住。
                        c.Notes.Add("equations partially rejected: " + rejectedParams.Count
                            + "/" + variables.Count + " variables refused ("
                            + string.Join(", ", rejectedParams.ToArray())
                            + "); drivers.mode downgraded to literal, edits to these "
                            + "parameters rebuild the part");
                    }

                    c.Evaluate();
                    steps.Add("rebuild");

                    Dictionary<string, object> geometry = Geometry.Snapshot(doc);
                    NativeDimensionCache.Register(designId, c.DimensionHandles, c.DimensionBindings);

                    // 落位回读：features 每一行补 box / boxError（该特征所有面的
                    // GetBox 并集，mm），并给每张草图一条 u/v 世界轴映射。体积和
                    // 整件包围盒看不出「切在哪一侧 / 草图 y 是 +Z 还是 -Z」，这两块
                    // 就是给调用方的落位凭据。
                    Geometry.AttachFeatureBoxes(doc, features);
                    int boxed = 0;
                    foreach (object raw in features)
                    {
                        Dictionary<string, object> row = Json.Obj(raw);
                        if (row != null && row.ContainsKey("box") && row["box"] != null) boxed++;
                    }
                    List<object> sketchPlaneMapping = Geometry.SketchPlaneMapping(doc);
                    steps.Add("featureBoxes " + boxed + "/" + features.Count);
                    steps.Add("sketchPlaneMapping " + sketchPlaneMapping.Count);

                    return Json.Dict(
                        "document", Json.Dict(
                            "title", doc.GetTitle(),
                            "path", doc.GetPathName(),
                            "template", template),
                        "features", features,
                        "sketchPlaneMapping", sketchPlaneMapping,
                        "globalVariables", variables,
                        "derivedVariables", c.DerivedVariables,
                        "bindings", c.Bindings,
                        "dimensionBindings", c.DimensionBindings,
                        "bindingRequested", c.RequestedBinds,
                        "drivers", Json.Dict(
                            // 驱动方式只有两种诚实答案：全部参数都由方程式驱动（equation），
                            // 否则就是字面值驱动、改参数靠重建（literal）。部分参数被拒时
                            // 不能报 equation —— 那些参数改不动，报 equation 就把「改参数没反应」
                            // 重新藏了起来。字段名不变，只按事实选值。
                            "mode", equationDriven && rejectedParams.Count == 0 ? "equation" : "literal",
                            "accepted", c.Bindings.Count,
                            "appliedLiteral", c.LiteralApplied,
                            "requested", c.RequestedBinds,
                            "note", equationDriven && rejectedParams.Count == 0
                                ? "dimensions follow global variables; edit parameters rewrites the variables"
                                : rejectedParams.Count > 0
                                    ? "the equation manager refused " + rejectedParams.Count + "/"
                                        + variables.Count + " variables ("
                                        + string.Join(", ", rejectedParams.ToArray())
                                        + "); those parameters are baked into the geometry as literal values, "
                                        + "so edits to them rebuild the part from the definition"
                                    : "this instance refused every equation binding, so parameter values are baked into the geometry at build; edit parameters rebuilds the part from the definition"),
                        "parameters", Json.Dict(
                            "resolved", ToPlain(c.Params)),
                        "geometry", geometry,
                        "steps", steps,
                        "closedDocuments", closedDocuments,
                        "skippedDirty", skippedDirty,
                        "builderSteps", b.Steps,
                        "notes", c.Notes);
                });
            }
        }

        /// <summary>output:"sketch" — build the sketch plan and stop there.
        ///
        /// No extrusion, no volume, no parameter bindings: the point of this mode is a
        /// sketch that can be handed to a human or to a later build. Judging it by the
        /// body's volume would fail every call that legitimately makes no solid, which
        /// is exactly what "钩子仅草图" asked for.</summary>
        Dictionary<string, object> BuildSketchDocument(Dictionary<string, object> req,
            Dictionary<string, object> definition)
        {
            string template = Json.Str(req, "template");
            if (template == null)
                template = Path.Combine(SwHost.TemplateDir, "gb_part.prtdot");
            if (!File.Exists(template))
                throw new BridgeError("TEMPLATE_NOT_FOUND", "part template not found: " + template);

            List<string> steps = new List<string>();
            // A5：同 Build —— 只关本会话建出来的，脏的剔出来并如实报告。
            List<object> closedDocuments = new List<object>();
            List<object> skippedDirty = new List<object>();
            string sketchSessionId = Json.Str(req, "sessionId", null);
            using (SwHost h = SwHost.Attach())
            {
                return h.Silent(delegate
                {
                    string requestedId = Json.Str(definition, "designId", null);
                    Documents.CloseResult previous = Documents.CloseDesign(h.App, requestedId, sketchSessionId);
                    if (previous.Closed != null)
                    {
                        steps.Add("closed previous document " + previous.Closed);
                        closedDocuments.Add(Json.Dict("title", previous.Closed, "reason", "replaced-by-build"));
                    }
                    else if (previous.Skipped)
                    {
                        steps.Add("kept \"" + (previous.Title ?? "?") + "\" (" + previous.Reason + ")");
                        skippedDirty.Add(Json.Dict("title", previous.Title, "reason", previous.Reason));
                    }

                    IModelDoc2 doc = (IModelDoc2)h.App.NewDocument(template, 0, 0, 0);
                    if (doc == null)
                        throw new BridgeError("NEW_DOCUMENT_FAILED", "could not create a document");
                    try
                    {
                        doc.SetUserPreferenceToggle(
                            (int)SolidWorks.Interop.swconst.swUserPreferenceToggle_e.swInputDimValOnCreate,
                            false);
                        steps.Add("dialogSuppression on");
                    }
                    catch (COMException ex)
                    {
                        steps.Add("dialogSuppression failed: " + ex.Message);
                    }
                    steps.Add("newDocument " + template);

                    string designId = Json.Str(definition, "designId", null);
                    WorkRegistry.Record(designId, doc.GetTitle(), null,
                        WorkRegistry.OriginBuild, Json.Str(req, "sessionId", null));
                    Compiler c = new Compiler(h, doc);
                    c.DeclareParameters(definition.ContainsKey("params") ? Json.Obj(definition["params"]) : null);
                    steps.Add("parameters " + c.Params.Count);

                    bool strict = Json.Bool(req, "strictRelations",
                        Json.Bool(definition, "strictRelations", Json.Bool(definition, "strict", false)));
                    List<object> plans = Builder.SketchPlans(definition);
                    if (plans.Count == 0)
                        throw new BridgeError("MISSING_SKETCH_PLAN",
                            "output=\"sketch\" needs a sketch plan in \"sketch\", \"sketches\" "
                            + "or a feature with kind \"sketch\"",
                            Json.Dict("definition", definition));

                    Builder b = new Builder(h, doc);
                    List<object> sketches = new List<object>();
                    List<object> allApplied = new List<object>();
                    List<object> allRejected = new List<object>();
                    List<object> notes = new List<object>();
                    int index = 0;
                    foreach (object raw in plans)
                    {
                        index++;
                        Dictionary<string, object> plan = Json.Obj(raw);
                        if (plan == null) continue;
                        string id = Json.Str(plan, "id", Json.Str(plan, "name", "sketch" + index));
                        Dictionary<string, object> built = b.BuildSketch(plan, id, c.Resolve, strict);
                        sketches.Add(built);
                        foreach (object item in Json.Items(built["applied"])) allApplied.Add(item);
                        foreach (object item in Json.Items(built["rejected"])) allRejected.Add(item);
                        foreach (object item in Json.Items(built["notes"])) notes.Add(item);
                    }
                    if (sketches.Count == 0)
                        throw new BridgeError("MISSING_SKETCH_PLAN", "every sketch plan in the definition was empty");
                    steps.Add("sketches " + sketches.Count);
                    Dictionary<string, object> first = (Dictionary<string, object>)sketches[0];

                    // 草图落位：每张草图的 u/v 轴在世界里的方向（"y 映射到 -Z"
                    // 这类镜像只有这里能读出来，草图自身的尺寸看不出来）。
                    List<object> sketchPlaneMapping = Geometry.SketchPlaneMapping(doc);
                    steps.Add("sketchPlaneMapping " + sketchPlaneMapping.Count);

                    return Json.Dict(
                        "kind", "sketch",
                        "output", "sketch",
                        "document", Json.Dict(
                            "title", doc.GetTitle(),
                            "path", doc.GetPathName(),
                            "saved", false,
                            "template", template),
                        "sketch", first,
                        "sketches", sketches,
                        "sketchCount", sketches.Count,
                        "closed", first["closed"],
                        "openEnds", first["openEnds"],
                        "segmentCount", first["segmentCount"],
                        "relationAudit", first["relationAudit"],
                        "applied", allApplied,
                        "rejected", allRejected,
                        "constraints", Json.Dict(
                            "constrainedStatus", first["constrainedStatus"],
                            "fullyConstrained", first["fullyConstrained"]),
                        "features", sketches,
                        "sketchPlaneMapping", sketchPlaneMapping,
                        "parameters", Json.Dict("resolved", ToPlain(c.Params)),
                        "steps", steps,
                        "closedDocuments", closedDocuments,
                        "skippedDirty", skippedDirty,
                        "builderSteps", b.Steps,
                        "notes", notes);
                });
            }
        }

        /// <summary>Finds the open document that backs a designId by looking it up in
        /// the registry, then activating it. Returns null when the design has no
        /// recorded document.
        ///
        /// 注意：返回 null 不再意味着"请退回前台文档" —— 需要文档的 op 一律走
        /// <see cref="RequireDesignDocument"/>，它会把 null 变成 DESIGN_ID_REQUIRED /
        /// DOC_NOT_OPEN 并带上 knownDesignIds。</summary>
        public static IModelDoc2 DesignDocument(SwHost h, string designId)
        {
            if (string.IsNullOrEmpty(designId)) return null;
            Dictionary<string, WorkRegistry.Entry> map = WorkRegistry.Load();
            WorkRegistry.Entry entry;
            if (!map.TryGetValue(designId, out entry) || entry == null) return null;
            return Documents.Activate(h.App, entry.Title);
        }

        static Dictionary<string, object> ToPlain(Dictionary<string, double> d)
        {
            Dictionary<string, object> o = new Dictionary<string, object>();
            foreach (KeyValuePair<string, double> kv in d)
                o[kv.Key] = Math.Round(kv.Value, 6);
            return o;
        }

        // ----------------------------------------------------------------- inspect

        Dictionary<string, object> Inspect(Dictionary<string, object> req)
        {
            string format = Json.Str(req, "format", "geometry");
            string imagePath = Json.Str(req, "imagePath");
            int width = Json.Int(req, "width", 1280);
            int height = Json.Int(req, "height", 800);

            string designId = Json.Str(req, "designId", null);
            using (SwHost h = SwHost.Attach())
            {
                // A2：检查报告必须说的是"这个设计的文档"，不能是前台那份。
                IModelDoc2 doc = RequireDesignDocument(h, designId, "inspect");
                Dictionary<string, object> result = Json.Dict(
                    "document", Json.Dict(
                        "title", doc.GetTitle(),
                        "path", doc.GetPathName(),
                        "saved", !string.IsNullOrEmpty(doc.GetPathName())));

                List<string> want = new List<string>(format.Split(','));
                if (want.Contains("tree") || want.Contains("both"))
                {
                    result["featureTree"] = FeatureTree(doc);
                    result["sketches"] = SketchStates(doc);
                }
                if (want.Contains("geometry") || want.Contains("both"))
                    result["geometry"] = Geometry.Snapshot(doc);
                result["equations"] = new Editor(doc).DumpEquations((IEquationMgr)doc.GetEquationMgr());
                // An image is captured when the caller names a path for it. "both"
                // means tree + geometry; overloading it to also mean "and a picture"
                // made every plain structural read fail with a missing-path error.
                bool wantsImage = imagePath != null
                    || want.Contains("view") || want.Contains("image");
                if (wantsImage)
                {
                    if (imagePath == null)
                        throw new BridgeError("BAD_ARGUMENT", "format requests an image but imagePath is missing");
                    string error;
                    result["image"] = CaptureView(doc, imagePath, width, height, out error);
                    if (error != null) result["imageError"] = error;
                }
                return result;
            }
        }

        /// <summary>Writes a viewport snapshot as indexed BMP. Kept as BMP on
        /// purpose: the conversion to PNG happens in Node so a failure there can
        /// never lose a model that already exists.</summary>
        static Dictionary<string, object> CaptureView(IModelDoc2 doc, string path, int width, int height, out string error)
        {
            error = null;
            try
            {
                string dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                bool ok = doc.SaveBMP(path, width, height);
                if (!ok)
                {
                    error = "SaveBMP returned false";
                    return Json.Dict("path", path, "captured", false);
                }
                FileInfo fi = new FileInfo(path);
                if (!fi.Exists || fi.Length == 0)
                {
                    error = "SaveBMP reported success but wrote no bytes";
                    return Json.Dict("path", path, "captured", false);
                }
                return Json.Dict("path", path, "captured", true, "bytes", fi.Length, "format", "bmp");
            }
            catch (COMException ex)
            {
                error = "SaveBMP failed: " + ex.Message;
                return Json.Dict("path", path, "captured", false);
            }
        }

        /// <summary>Constraint state per sketch. 3 means fully constrained; anything
        /// less means a later dimension change can drag the profile sideways, which is
        /// exactly the failure a user notices but the geometry read-back cannot see.</summary>
        static List<object> SketchStates(IModelDoc2 doc)
        {
            List<object> list = new List<object>();
            IFeature f = (IFeature)doc.FirstFeature();
            int guard = 0;
            while (f != null && guard++ < 3000)
            {
                if (f.GetTypeName2() == "ProfileFeature")
                {
                    int status = -1;
                    try
                    {
                        ISketch sketch = (ISketch)f.GetSpecificFeature2();
                        if (sketch != null) status = sketch.GetConstrainedStatus();
                    }
                    catch (COMException) { }
                    list.Add(Json.Dict(
                        "feature", f.Name,
                        "constraintStatus", status,
                        "fullyConstrained", status == 3));
                }
                f = (IFeature)f.GetNextFeature();
            }
            return list;
        }

        static List<object> FeatureTree(IModelDoc2 doc)
        {
            List<object> list = new List<object>();
            IFeature f = (IFeature)doc.FirstFeature();
            while (f != null)
            {
                Dictionary<string, object> node = Json.Dict(
                    "name", f.Name,
                    "type", f.GetTypeName2(),
                    "id", f.GetID());
                list.Add(node);
                f = (IFeature)f.GetNextFeature();
            }
            return list;
        }

        // ------------------------------------------------------------------ status

        Dictionary<string, object> Status(Dictionary<string, object> req)
        {
            SwHost h = null;
            string attachError = null;
            try { h = SwHost.Attach(); }
            catch (BridgeError be) { attachError = be.Code; }

            if (h == null)
            {
                Diagnostics d = Diagnostics.Snapshot();
                Dictionary<string, object> down = d.ToDict();
                down["ready"] = false;
                down["reason"] = d.State;
                if (attachError != null) down["attachError"] = attachError;
                return down;
            }

            using (h)
            {
                int pid = SafeInt(delegate { return h.App.GetProcessID(); });
                string rev = SafeString(delegate { return h.App.RevisionNumber(); });
                Diagnostics.Remember(pid, rev);

                // COM answering is not the same as the user being able to work.
                // A crash-report dialog leaves the process live and the API
                // responsive, so the window state decides between ready and
                // blocked-by-dialog.
                SwWindows windows = SwWindows.Probe(pid);
                Dictionary<string, object> ok = Json.Dict(
                    "ready", !windows.Blocking,
                    "reason", windows.Blocking ? "blocked-by-dialog" : "ready",
                    "revision", rev,
                    "processId", pid,
                    "bridge", BridgeVersion,
                    "protocol", ProtocolVersion,
                    // 常驻桥接器自己占多少内存：长期跑只增不减时，这个数字是唯一线索。
                    "bridgeWorkingSetMb", Json.R(Process.GetCurrentProcess().WorkingSet64 / 1048576.0),
                    "documents", DescribeDocuments(h),
                    "preferences", Json.Dict(
                        "inputDimValOnCreate", SafeBool(delegate
                        {
                            return h.App.GetUserPreferenceToggle(
                                (int)swUserPreferenceToggle_e.swInputDimValOnCreate);
                        })));
                ok["windows"] = windows.ToDict();
                if (windows.Blocking)
                {
                    ok["message"] = "SOLIDWORKS is running but showing \""
                        + (windows.BlockingTitle ?? windows.MainTitle) + "\". The API still answers, "
                        + "so work could proceed, but the user is probably looking at a dialog.";
                    ok["action"] = new List<object>
                    {
                        "tell the user which dialog is open and ask them to dismiss it",
                        "if it is the crash report, the session it refers to is already lost: start SOLIDWORKS again",
                        "retry the same call afterwards"
                    };
                }
                return ok;
            }
        }

        List<object> DescribeDocuments(SwHost h)
        {
            List<object> list = new List<object>();
            foreach (IModelDoc2 doc in h.OpenDocuments())
            {
                string path = SafeString(delegate { return doc.GetPathName(); });
                list.Add(Json.Dict(
                    "title", SafeString(delegate { return doc.GetTitle(); }),
                    "path", path,
                    "saved", !string.IsNullOrEmpty(path),
                    "type", SafeInt(delegate { return doc.GetType(); }),
                    "dirty", SafeBool(delegate { return doc.GetSaveFlag(); })));
            }
            return list;
        }

        // ---------------------------------------------------------------- diagnose

        Dictionary<string, object> Diagnose(Dictionary<string, object> req)
        {
            List<object> checks = new List<object>();

            checks.Add(Check("installDir", Directory.Exists(SwHost.InstallDir), SwHost.InstallDir,
                "SOLIDWORKS install directory"));

            string exe = Path.Combine(SwHost.InstallDir, "SLDWORKS.exe");
            checks.Add(Check("executable", File.Exists(exe), exe, "SLDWORKS.exe"));

            string sldworks = Path.Combine(SwHost.InstallDir, "SolidWorks.Interop.sldworks.dll");
            checks.Add(Check("interop", File.Exists(sldworks), sldworks, "SolidWorks interop assembly"));

            string swconst = Path.Combine(SwHost.InstallDir, "SolidWorks.Interop.swconst.dll");
            checks.Add(Check("interopConst", File.Exists(swconst), swconst, "SolidWorks constant assembly"));

            string template = Path.Combine(SwHost.TemplateDir, "gb_part.prtdot");
            checks.Add(Check("partTemplate", File.Exists(template), template, "default part template"));

            // A verified, user-visible failure mode: an executable living under a
            // directory whose ACL denies delete-child breaks COM activation of a
            // local server. Report it instead of letting the caller guess.
            string exeDir = Path.GetDirectoryName(
                System.Reflection.Assembly.GetExecutingAssembly().Location);
            bool restricted = IsRestrictedDirectory(exeDir);
            checks.Add(Check("bridgeLocation", !restricted, exeDir,
                restricted
                    ? "bridge executable sits in a directory whose ACL denies DC; COM activation fails from here"
                    : "bridge executable location"));

            bool attached = false;
            string revision = null;
            int pid = 0;
            string attachError = null;
            try
            {
                using (SwHost h = SwHost.Attach())
                {
                    attached = true;
                    revision = SafeString(delegate { return h.App.RevisionNumber(); });
                    pid = SafeInt(delegate { return h.App.GetProcessID(); });
                }
            }
            catch (BridgeError be)
            {
                attachError = be.Code + ": " + be.Message;
            }

            checks.Add(Check("attachment", attached, revision, attachError ?? "attached to a running instance"));

            Dictionary<string, object> result = Json.Dict(
                "checks", checks,
                "summary", Json.Dict(
                    "swRunning", attached,
                    "revision", revision,
                    "processId", pid,
                    "error", attachError,
                    "restrictedLocation", restricted));
            return result;
        }

        static bool IsRestrictedDirectory(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return false;
            try
            {
                // ACL probing through .NET requires an assembly reference we do not
                // need elsewhere; probing behaviourally is enough here: a directory
                // that rejects creating and deleting a sentinel child is exactly the
                // condition that breaks local-server COM activation.
                string probe = Path.Combine(dir, ".swmcp-probe-" + Guid.NewGuid().ToString("N"));
                using (FileStream fs = File.Create(probe, 1, FileOptions.DeleteOnClose)) { }
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return true;
            }
            catch (IOException)
            {
                return true;
            }
        }

        static Dictionary<string, object> Check(string name, bool ok, string value, string description)
        {
            return Json.Dict("name", name, "ok", ok, "value", value, "description", description);
        }

        // -------------------------------------------------------------------- list

        Dictionary<string, object> ListDocuments(Dictionary<string, object> req)
        {
            using (SwHost h = SwHost.Attach())
            {
                return Json.Dict("documents", DescribeDocuments(h));
            }
        }

        // ----------------------------------------------------------------- helpers

        static SwHost TryAttach()
        {
            try
            {
                return SwHost.Attach();
            }
            catch (BridgeError)
            {
                return null;
            }
        }

        static string SafeString(Func<string> f)
        {
            try { return f(); }
            catch (COMException) { return null; }
        }

        static int SafeInt(Func<int> f)
        {
            try { return f(); }
            catch (COMException) { return 0; }
        }

        static bool SafeBool(Func<bool> f)
        {
            try { return f(); }
            catch (COMException) { return false; }
        }

        /// <summary>One worker turn: image, measurements, feature tree and (optionally)
        /// the exported STEP all come from the same revision. Doing this as three
        /// separate bridge calls looked equivalent but let a rebuild slip between the
        /// screenshot and the numbers, so the picture and the dimensions could describe
        /// different parts. Sub-calls reuse the active document; the outer Dispatch
        /// already holds the gate.</summary>
        Dictionary<string, object> Snapshot(Dictionary<string, object> req)
        {
            string imagePath = Json.Str(req, "imagePath", Json.Str(req, "path", null));
            if (string.IsNullOrEmpty(imagePath))
                throw new BridgeError("BAD_ARGUMENT", "snapshot requires \"imagePath\" (absolute image path)");

            string designId = Json.Str(req, "designId", null);
            List<object> measurements = new List<object>();
            List<object> specs = new List<object>(Json.Items(
                req.ContainsKey("measures") ? req["measures"] : null));
            foreach (object raw in specs)
            {
                Dictionary<string, object> spec = raw as Dictionary<string, object>;
                if (spec == null) continue;
                string name = Json.Str(spec, "name", Json.Str(spec, "kind", "measure"));
                Dictionary<string, object> request;
                if (spec.ContainsKey("measure") && spec["measure"] is Dictionary<string, object>)
                    request = new Dictionary<string, object>((Dictionary<string, object>)spec["measure"]);
                else
                    request = new Dictionary<string, object>(spec);
                if (!string.IsNullOrEmpty(designId) && !request.ContainsKey("designId"))
                    request["designId"] = designId;
                try
                {
                    measurements.Add(Json.Dict("name", name, "ok", true,
                        "result", Measure.Dispatch(request)));
                }
                catch (BridgeError error)
                {
                    measurements.Add(Json.Dict("name", name, "ok", false,
                        "error", Json.Dict("code", error.Code, "message", error.Message,
                            "detail", error.Detail)));
                }
            }

            object step = null;
            string stepPath = Json.Str(req, "stepPath", null);
            if (!string.IsNullOrEmpty(stepPath))
                step = Export(Merged(req, "kind", "step", "path", stepPath));

            Dictionary<string, object> inspectReq = Merged(req, "format", "tree,geometry");
            inspectReq.Remove("imagePath");
            inspectReq.Remove("path");
            Dictionary<string, object> features = Inspect(inspectReq);
            Dictionary<string, object> capture = Merged(req, "path", imagePath);
            if (!string.IsNullOrEmpty(designId)) capture["designId"] = designId;
            Dictionary<string, object> image = Capture(capture);

            return Json.Dict(
                "sameTurn", true,
                "document", image.ContainsKey("document") ? image["document"] : features["document"],
                "image", image,
                "measurements", measurements,
                "features", features.ContainsKey("featureTree") ? features["featureTree"] : null,
                "sketches", features.ContainsKey("sketches") ? features["sketches"] : null,
                "geometry", features.ContainsKey("geometry") ? features["geometry"] : null,
                "step", step);
        }

        /// <summary>Which SOLIDWORKS instances exist right now (ROT), plus the pid
        /// this process would attach to. Identity is pid + start time, not "the
        /// active one": that is what lets a broker hand work to a specific instance.</summary>
        /// <summary>Maximizes the SOLIDWORKS frame and closes welcome/news/ad
        /// popups. Auto-runs once per instance on first attach; this op is for
        /// an explicit re-normalize or for checking the current window state.</summary>
        public Dictionary<string, object> Ui(Dictionary<string, object> req)
        {
            // A3：不再有隐式缺省。不传 action 就等于"替我最大化窗口"，而最大化会
            // 把用户正在画的零件窗口从后台拽到前台 —— 这条缺省已经被删掉。
            string action = Json.Str(req, "action", null);
            if (string.IsNullOrEmpty(action))
                throw new BridgeError("ACTION_REQUIRED",
                    "ui 必须显式指定 action：\"normalize\" 会动窗口（用户有未存盘文档时直接跳过），"
                    + "\"status\" 只读。不传 action 的隐式最大化已取消。",
                    Json.Dict("supported", Json.List("normalize", "status")));
            int requested = 0;
            object rawPid;
            if (req.TryGetValue("pid", out rawPid) && rawPid != null) requested = Convert.ToInt32(rawPid);

            if (action == "status")
            {
                // 只读：没有 SOLIDWORKS 时也应当能回答窗口状态。
                int statusPid = requested != 0 ? requested : SwHost.LastKnownProcessId;
                if (statusPid == 0)
                {
                    // 只读查询没有绑定实例时，从 ROT 取第一个，避免返回 pid=0
                    // 让调用方误判成“没有窗口”。
                    foreach (object item in Rot.List())
                    {
                        Dictionary<string, object> row = item as Dictionary<string, object>;
                        if (row != null && row.ContainsKey("pid")) { statusPid = Convert.ToInt32(row["pid"]); break; }
                    }
                }
                return UserInterface.Status(statusPid);
            }
            if (action != "normalize")
                throw new BridgeError("BAD_ARGUMENT",
                    "unknown ui action \"" + action + "\"",
                    Json.Dict("supported", Json.List("normalize", "status")));

            using (SwHost host = SwHost.Attach())
            {
                int appPid = SwHost.LastKnownProcessId;
                if (requested != 0 && requested != appPid)
                {
                    throw new BridgeError("BAD_ARGUMENT",
                        "ui normalize 只能整理当前绑定的实例（当前 pid " + appPid + "，请求 pid " + requested + "）",
                        Json.Dict("currentPid", appPid, "requestedPid", requested));
                }

                // A3（闸）：用户手上有未存盘的文档时，绝不抢前台。现场事实是
                // [零件13 *] 被 AI 的 ui normalize 反复最大化/切文档，用户看到的就是
                // "上方操作栏跳动"。有脏文档时连最大化都不做，直接跳过并说明原因。
                string dirtyTitle = FirstDirtyDocumentTitle(host.App);
                if (dirtyTitle != null)
                {
                    return Json.Dict(
                        "ok", true,
                        "skipped", true,
                        "reason", "USER_DOC_DIRTY",
                        "activeDirtyDocument", dirtyTitle,
                        "note", "用户有未存盘文档 \"" + dirtyTitle + "\"，本次不整理/不最大化窗口，也不写任何首选项",
                        "nextActions", Json.List(
                            "请用户自己存盘或关掉那份文档后再调用",
                            "需要确认窗口是谁的先 workspace action=\"instances\"",
                            "只读窗口状态用 uiAction=\"status\""));
                }

                // 显式 ui normalize 仍然要求用户空闲：刚点完菜单就抢窗口同样是"跳动"。
                return UserInterface.Normalize(host.App, appPid, allowMaximize: true, requireIdle: true,
                    writeNewsFeeds: Json.Bool(req, "offNewsFeeds", false));
            }
        }

        /// <summary>第一个有未存盘修改的文档标题（GetSaveFlag()==true），没有就 null。</summary>
        static string FirstDirtyDocumentTitle(ISldWorks app)
        {
            if (app == null) return null;
            try
            {
                foreach (IModelDoc2 doc in Documents.OpenDocuments(app))
                {
                    bool dirty = false;
                    try { dirty = doc.GetSaveFlag(); } catch (COMException) { }
                    if (!dirty) continue;
                    string title = null;
                    try { title = doc.GetTitle(); } catch (COMException) { }
                    return title ?? "(untitled)";
                }
            }
            catch (Exception) { }
            return null;
        }

        Dictionary<string, object> Instances(Dictionary<string, object> req)
        {
            int activePid = 0;
            // --no-attach（探针）：只枚举 ROT，绝不 GetActiveObject。activePid 因此
            // 是 null —— 这是设计结果，不是探测失败。
            bool attachFree = SwHost.NoAttach;
            if (!attachFree)
            {
                try
                {
                    using (SwHost h = SwHost.Attach())
                    {
                        activePid = h.App.GetProcessID();
                    }
                }
                catch (BridgeError) { }
                catch (COMException) { }
            }
            return Json.Dict(
                "instances", Rot.List(),
                "activePid", activePid > 0 ? (object)activePid : null,
                "expectedPid", SwHost.ExpectedPid > 0 ? (object)SwHost.ExpectedPid : null,
                // 绑定状态是排障的第一读数：expectedPid=null 且 autoBind=false 时，
                // 「这个 worker 没绑定」是设计结果而不是探测失败，读的人要能分辨。
                "bindMode", SwHost.AutoBind ? (object)"auto" : (SwHost.ExpectedPid > 0 ? (object)"pid" : (object)"unbound"),
                "attachedPid", SwHost.AttachedPid > 0 ? (object)SwHost.AttachedPid : null,
                "attachedBy", SwHost.AttachedBy,
                "attachFree", attachFree);
        }

        static Dictionary<string, object> Merged(Dictionary<string, object> source, params string[] pairs)        {
            Dictionary<string, object> copy = new Dictionary<string, object>(source);
            for (int i = 0; i + 1 < pairs.Length; i += 2)
                copy[pairs[i]] = pairs[i + 1];
            return copy;
        }
    }
}
