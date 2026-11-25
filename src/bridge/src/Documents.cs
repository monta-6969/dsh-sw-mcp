using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Keeps the set of documents this bridge opened under control.
    ///
    /// Without it every build left another untitled part behind: forty builds meant
    /// forty dirty documents in the user's SOLIDWORKS session, and saving started
    /// failing because the target name was already held by an earlier document.
    ///
    /// The registry is a small JSON file next to the executable that maps a
    /// designId to the document title that currently backs it. The bridge only ever
    /// closes documents it recorded itself, never a file the user opened.</summary>
    static class WorkRegistry
    {
        /// <summary>哪个入口建出了这条登记：build（model action=build 及其存盘）、
        /// create（newDocument / assemblyNew / drawingNew）、unknown（旧版本写的行，
        /// 以及历史会话/别的实例留下的行）。
        ///
        /// 为什么必须有：registry 是 exe 目录下一个全局文件，所有会话、所有
        /// SOLIDWORKS 实例共用同一份；所以「无路径」不能当成「我们建的」。历史现场
        /// （见 docs/SW-自动化MCP-研究报告.md §3.4）里 registry 出现过 `health → 零件1`
        /// 这种无路径历史行，而用户手开的新零件默认也叫 零件N —— 只按无路径筛就等于
        /// 关掉所有无路径登记项，包括用户那份。来源不明的条目一律不关。</summary>
        public const string OriginBuild = "build";
        public const string OriginCreate = "create";
        public const string OriginUnknown = "unknown";

        public sealed class Entry
        {
            public string Title { get; set; }
            public string Path { get; set; }
            public string DesignId { get; set; }
            public string Origin { get; set; }
            public string SessionId { get; set; }
        }

        /// <summary>来源明确是「本工具建出来的」：只有这两种能进无 designId 的清理。</summary>
        public static bool IsCreatedOrigin(string origin)
        {
            return string.Equals(origin, OriginBuild, StringComparison.Ordinal)
                || string.Equals(origin, OriginCreate, StringComparison.Ordinal);
        }

        /// <summary>缺字段、值不认识、大小写不对一律落到 unknown：宁可少关一个窗口，
        /// 也不能把来源不明的登记项当自己的。</summary>
        public static string NormalizeOrigin(string origin)
        {
            return IsCreatedOrigin(origin) ? origin : OriginUnknown;
        }

        /// <summary>这条登记是否明确属于另一个会话。当前请求没带 sessionId、或条目
        /// 自己没记（旧行、以及没带会话的请求）时都不算「别人的」—— 那种情况按来源判，
        /// 否则 cleanup 会连自己刚建的东西都关不掉。</summary>
        public static bool IsForeignSession(Entry entry, string sessionId)
        {
            if (entry == null || string.IsNullOrEmpty(sessionId)) return false;
            if (string.IsNullOrEmpty(entry.SessionId)) return false;
            return !string.Equals(entry.SessionId, sessionId, StringComparison.Ordinal);
        }

        static string FilePath
        {
            get { return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "state", "documents.json"); }
        }

        public static Dictionary<string, Entry> Load()
        {
            Dictionary<string, Entry> map = new Dictionary<string, Entry>();
            try
            {
                if (!File.Exists(FilePath)) return map;
                string text = File.ReadAllText(FilePath);
                if (string.IsNullOrWhiteSpace(text)) return map;
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> raw = ser.Deserialize<Dictionary<string, object>>(text);
                foreach (KeyValuePair<string, object> kv in raw)
                {
                    Dictionary<string, object> e = kv.Value as Dictionary<string, object>;
                    if (e == null) continue;
                    map[kv.Key] = new Entry
                    {
                        Title = Str(e, "title"),
                        Path = Str(e, "path"),
                        DesignId = Str(e, "designId") ?? kv.Key,
                        Origin = NormalizeOrigin(Str(e, "origin")),
                        SessionId = Str(e, "sessionId"),
                    };
                }
            }
            catch (IOException)
            {
                // a corrupt registry must never block modelling
            }
            catch (Exception)
            {
            }
            return map;
        }

        static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : null;
        }

        public static void Save(Dictionary<string, Entry> map)
        {
            try
            {
                string dir = Path.GetDirectoryName(FilePath);
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                Dictionary<string, object> raw = new Dictionary<string, object>();
                foreach (KeyValuePair<string, Entry> kv in map)
                    raw[kv.Key] = new Dictionary<string, object>
                    {
                        { "title", kv.Value.Title },
                        { "path", kv.Value.Path },
                        { "designId", kv.Value.DesignId },
                        { "origin", NormalizeOrigin(kv.Value.Origin) },
                        { "sessionId", kv.Value.SessionId },
                    };
                JavaScriptSerializer ser = new JavaScriptSerializer();
                File.WriteAllText(FilePath, ser.Serialize(raw));
            }
            catch (IOException)
            {
            }
        }

        public static void Record(string designId, string title, string path, string origin, string sessionId)
        {
            if (string.IsNullOrEmpty(designId)) return;
            Dictionary<string, Entry> map = Load();
            map[designId] = new Entry
            {
                Title = title,
                Path = path,
                DesignId = designId,
                Origin = NormalizeOrigin(origin),
                SessionId = string.IsNullOrEmpty(sessionId) ? null : sessionId,
            };
            Save(map);
        }

        public static void Forget(string designId)
        {
            if (string.IsNullOrEmpty(designId)) return;
            Dictionary<string, Entry> map = Load();
            if (map.Remove(designId)) Save(map);
        }
    }

    /// <summary>Closes the document that currently backs a design, so rebuilding does
    /// not accumulate documents.</summary>
    static class Documents
    {
        /// <summary>这个标题的窗口是不是「本工具/本会话建出来的」。
        ///
        /// A5 的判据只有一条：registry 里有 origin=build/create 的登记，且那条登记
        /// 不属于别的会话。同名多条登记时只要有一条来源不明（unknown，旧版本写的行、
        /// 用户手开的新零件也叫 零件N）就不认 —— 关掉用户未存盘的零件的代价，
        /// 比少关一个窗口大得多。</summary>
        public static bool IsOwnedTitle(string title, string sessionId, string designId)
        {
            if (string.IsNullOrEmpty(title)) return false;
            Dictionary<string, WorkRegistry.Entry> map = WorkRegistry.Load();
            WorkRegistry.Entry direct;
            if (!string.IsNullOrEmpty(designId) && map.TryGetValue(designId, out direct) && direct != null
                && string.Equals(direct.Title, title, StringComparison.OrdinalIgnoreCase))
            {
                return WorkRegistry.IsCreatedOrigin(direct.Origin)
                    && !WorkRegistry.IsForeignSession(direct, sessionId);
            }
            bool owned = false;
            bool sawUnknown = false;
            foreach (WorkRegistry.Entry entry in map.Values)
            {
                if (entry == null || !string.Equals(entry.Title, title, StringComparison.OrdinalIgnoreCase)) continue;
                if (!WorkRegistry.IsCreatedOrigin(entry.Origin)) { sawUnknown = true; continue; }
                if (WorkRegistry.IsForeignSession(entry, sessionId)) continue;
                owned = true;
            }
            return owned && !sawUnknown;
        }

        /// <summary>CloseDesign 的结果：关掉了谁，或者为什么没关（A5 的 self-report）。</summary>
        public sealed class CloseResult
        {
            public string Closed;
            public string Title;
            public string Reason;
            public bool Skipped { get { return Closed == null && Reason != null; } }
        }

        /// <summary>Closes whatever document the registry says backed this design.
        ///
        /// A5：脏文档不再无条件丢弃。registry 里这一条如果不是本会话建出来的
        /// （origin 不明 / 属于别的会话），拒绝关闭并把原因交回去，让调用方
        /// 把它是从「要关的列表」里剔除并如实报告。</summary>
        public static CloseResult CloseDesign(ISldWorks app, string designId, string sessionId)
        {
            CloseResult outcome = new CloseResult();
            if (string.IsNullOrEmpty(designId) || app == null) return outcome;
            Dictionary<string, WorkRegistry.Entry> map = WorkRegistry.Load();
            WorkRegistry.Entry entry;
            if (!map.TryGetValue(designId, out entry) || entry == null) return outcome;
            outcome.Title = entry.Title;
            string reason = null;
            string closed = CloseByTitle(app, entry.Title, true, sessionId, designId, out reason);
            if (closed == null && reason != null)
            {
                // 没关掉就不销账：这条登记还要留给下一轮 cleanup 回答「为什么没收」。
                outcome.Reason = reason;
                return outcome;
            }
            WorkRegistry.Forget(designId);
            outcome.Closed = closed;
            return outcome;
        }

        /// <summary>Closes every open document whose saved path starts with
        /// <paramref name="prefixMm"/>-like prefix, and optionally the untitled ones.
        ///
        /// Test runs open dozens of documents and leave them as windows. Quitting
        /// SOLIDWORKS would clear them, but that costs fifty seconds to start again;
        /// closing by path costs nothing and cannot touch a file the user opened
        /// outside the test tree, because it only matches the prefix we pass in.</summary>
        public static List<string> CloseUnderPath(ISldWorks app, string prefix, bool untitled)
        {
            List<string> closed = new List<string>();
            if (app == null) return closed;
            foreach (IModelDoc2 doc in OpenDocuments(app))
            {
                string path = null;
                try { path = doc.GetPathName(); } catch (COMException) { }
                bool hit = untitled && string.IsNullOrEmpty(path);
                if (!hit && !string.IsNullOrEmpty(path) && !string.IsNullOrEmpty(prefix))
                    hit = path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
                if (!hit) continue;

                string title;
                try { title = doc.GetTitle(); } catch (COMException) { continue; }
                try { doc.SetSaveFlag(); } catch (COMException) { }
                try { app.QuitDoc(title); closed.Add(title); }
                catch (COMException) { }
            }
            return closed;
        }

        public static string CloseByTitle(ISldWorks app, string title, bool allowDirty,
            string sessionId, string designId, out string skippedReason)
        {
            skippedReason = null;
            if (string.IsNullOrEmpty(title) || app == null) return null;
            IModelDoc2 target = null;
            foreach (IModelDoc2 doc in OpenDocuments(app))
            {
                if (string.Equals(doc.GetTitle(), title, StringComparison.OrdinalIgnoreCase))
                {
                    target = doc;
                    break;
                }
            }
            if (target == null) return null;

            // Never discard edits the user made outside this tool. Cleanup passes
            // allowDirty:true only for documents this bridge created and never saved.
            bool dirty = false;
            try { dirty = target.GetSaveFlag(); } catch (COMException) { }
            if (dirty && !allowDirty)
            {
                throw new BridgeError("DOCUMENT_DIRTY",
                    "document \"" + title + "\" has unsaved changes; save it or close it explicitly",
                    Json.Dict("title", title));
            }

            // A5（红线）：脏文档只允许关「本会话建出来的」那一份。
            // 以前 allowDirty:true 就是"标记成已存盘再 QuitDoc"——用户手画的零件
            // 只要标题撞上 registry 里一条，就被静默丢掉。现在来源不明就拒绝，
            // 并把原因交回调用方（它负责把这一份从要关的列表里剔除）。
            if (dirty && allowDirty && !IsOwnedTitle(title, sessionId, designId))
            {
                skippedReason = "USER_DOC_DIRTY";
                return null;
            }

            // Marking the document as already saved suppresses the "save changes?"
            // prompt that would otherwise block a headless call. This is applied to
            // dirty documents too: a prompt here looks exactly like a hang.
            try
            {
                target.SetSaveFlag();
            }
            catch (COMException)
            {
            }

            string closedTitle = null;
            try
            {
                closedTitle = target.GetTitle();
                app.QuitDoc(closedTitle);
            }
            catch (COMException)
            {
                return null;
            }

            // QuitDoc reports nothing; the only trustworthy answer is whether the
            // document is gone.
            foreach (IModelDoc2 doc in OpenDocuments(app))
                if (string.Equals(doc.GetTitle(), closedTitle, StringComparison.OrdinalIgnoreCase))
                    return null;
            return closedTitle;
        }

        /// <summary>cleanup 的返回：关掉了哪些、因为什么没关另外那些。</summary>
        public sealed class SweepOutcome
        {
            public readonly List<string> Closed = new List<string>();
            /// <summary>A5：{title, reason} 形式的关闭记录，没有原因就是null。</summary>
            public readonly List<object> ClosedRecords = new List<object>();
            /// <summary>A5：本来要关、但是用户未存盘的文档（USER_DOC_DIRTY），一份都没动。</summary>
            public readonly List<object> SkippedDirty = new List<object>();
            /// <summary>原本会被关、但登记项来源不明（旧行、用户手开的文档）而跳过的个数。</summary>
            public int SkippedUnknown;
            /// <summary>登记项明确属于另一个会话、因而不动的个数。</summary>
            public int SkippedOtherSession;
        }

        /// <summary>cleanup 的唯一实现。带 designId 只收这一条登记，不带就是会话级清扫。
        ///
        /// 三条硬规则（两条分支都适用）：
        /// 1. 不在 registry 里的文档一律不碰 —— 用户自己打开的文档不进 registry；
        /// 2. origin 不是 build/create（旧版本写的行 → unknown）一律不关，只计数；
        /// 3. 登记项带了 sessionId 且不是当前会话的，不关，只计数。
        ///
        /// 为什么不再按「无路径」一刀切：registry 是 exe 目录下一个全局文件，所有会话、
        /// 所有 SOLIDWORKS 实例共用同一份，历史现场（见 docs/SW-自动化MCP-研究报告.md §3.4）
        /// 里出现过 `health → 零件1` 这种无路径幽灵行，而用户手开的新零件默认也叫
        /// 零件N。只按无路径筛就等于「关掉所有无路径登记项」，可能连用户那份一起关掉，
        /// 而且是无提示丢弃未保存的修改（CloseByTitle(allowDirty:true)）——那是红线。
        /// 返回里的 skippedUnknown / skippedOtherSession 就是「我为什么没关那几个」的自证。</summary>
        public static SweepOutcome SweepDocuments(ISldWorks app, string onlyDesignId, string sessionId)
        {
            SweepOutcome outcome = new SweepOutcome();
            if (app == null) return outcome;
            Dictionary<string, WorkRegistry.Entry> map = WorkRegistry.Load();
            if (map.Count == 0) return outcome;
            if (!string.IsNullOrEmpty(onlyDesignId))
            {
                SweepOne(app, map, onlyDesignId, sessionId, outcome);
                return outcome;
            }

            // 按标题归并「无路径」登记项：同一个标题有多条登记时（历史行与本次登记同名），
            // 只要有一条来源不明就不动这个标题 —— 标题是唯一的匹配键，多一条 unknown
            // 就说明我们分不清这个窗口是谁的。
            Dictionary<string, List<WorkRegistry.Entry>> byTitle =
                new Dictionary<string, List<WorkRegistry.Entry>>(StringComparer.OrdinalIgnoreCase);
            foreach (WorkRegistry.Entry e in map.Values)
            {
                if (e == null || string.IsNullOrEmpty(e.Title) || !string.IsNullOrEmpty(e.Path)) continue;
                List<WorkRegistry.Entry> list;
                if (!byTitle.TryGetValue(e.Title, out list))
                {
                    list = new List<WorkRegistry.Entry>();
                    byTitle[e.Title] = list;
                }
                list.Add(e);
            }
            if (byTitle.Count == 0) return outcome;

            List<string> targets = new List<string>();
            foreach (IModelDoc2 doc in OpenDocuments(app))
            {
                string title;
                string path;
                try
                {
                    title = doc.GetTitle();
                    path = doc.GetPathName();
                }
                catch (COMException)
                {
                    continue;
                }
                if (string.IsNullOrEmpty(title) || !string.IsNullOrEmpty(path)) continue;
                List<WorkRegistry.Entry> entries;
                if (!byTitle.TryGetValue(title, out entries) || entries.Count == 0) continue;

                bool unknown = false;
                bool foreign = false;
                foreach (WorkRegistry.Entry e in entries)
                {
                    if (!WorkRegistry.IsCreatedOrigin(e.Origin)) unknown = true;
                    else if (WorkRegistry.IsForeignSession(e, sessionId)) foreign = true;
                }
                if (unknown)
                {
                    outcome.SkippedUnknown++;
                    continue;
                }
                if (foreign)
                {
                    outcome.SkippedOtherSession++;
                    continue;
                }
                targets.Add(title);
            }

            foreach (string title in targets)
            {
                string reason = null;
                string done = CloseByTitle(app, title, true, sessionId, null, out reason);
                if (done != null)
                {
                    outcome.Closed.Add(done);
                    outcome.ClosedRecords.Add(Json.Dict("title", done, "reason", "created-unsaved"));
                }
                else if (reason != null)
                {
                    // A5：脏的就不是我们的，从要关的列表里剔除并如实报告。
                    outcome.SkippedDirty.Add(Json.Dict("title", title, "reason", reason));
                }
            }
            PruneCreatedEntries(map, sessionId);
            return outcome;
        }

        /// <summary>带 designId 的那条：只认这一条登记，来源/会话规则与全量清扫一致。</summary>
        static void SweepOne(ISldWorks app, Dictionary<string, WorkRegistry.Entry> map,
            string designId, string sessionId, SweepOutcome outcome)
        {
            WorkRegistry.Entry entry;
            if (!map.TryGetValue(designId, out entry) || entry == null) return;
            if (string.IsNullOrEmpty(entry.Title) || !string.IsNullOrEmpty(entry.Path)) return;
            if (!WorkRegistry.IsCreatedOrigin(entry.Origin))
            {
                // 来源不明的行不关：可能是用户手开的同名文档，过期的 build 由下一次
                // build 的 CloseDesign 换掉，不需要靠 cleanup 冒险。
                outcome.SkippedUnknown++;
                return;
            }
            if (WorkRegistry.IsForeignSession(entry, sessionId))
            {
                outcome.SkippedOtherSession++;
                return;
            }
            foreach (IModelDoc2 doc in OpenDocuments(app))
            {
                string title;
                string path;
                try
                {
                    title = doc.GetTitle();
                    path = doc.GetPathName();
                }
                catch (COMException)
                {
                    continue;
                }
                if (!string.Equals(title, entry.Title, StringComparison.OrdinalIgnoreCase)) continue;
                if (!string.IsNullOrEmpty(path)) continue;
                string reason = null;
                string done = CloseByTitle(app, title, true, sessionId, designId, out reason);
                if (done != null)
                {
                    outcome.Closed.Add(done);
                    outcome.ClosedRecords.Add(Json.Dict("title", done, "reason", "created-unsaved"));
                }
                else if (reason != null)
                {
                    outcome.SkippedDirty.Add(Json.Dict("title", title, "reason", reason));
                }
            }
            // 只销这一条；别的会话的、来源不明的行一律留着。
            Dictionary<string, WorkRegistry.Entry> keep = new Dictionary<string, WorkRegistry.Entry>();
            foreach (KeyValuePair<string, WorkRegistry.Entry> kv in map)
            {
                WorkRegistry.Entry e = kv.Value;
                bool prunable = e != null && !string.IsNullOrEmpty(e.Title)
                    && string.IsNullOrEmpty(e.Path)
                    && WorkRegistry.IsCreatedOrigin(e.Origin)
                    && !WorkRegistry.IsForeignSession(e, sessionId);
                if (!prunable) keep[kv.Key] = e;
            }
            if (keep.Count != map.Count) WorkRegistry.Save(keep);
        }

        /// <summary>销账只销「本来就有资格关」的那一类；unknown 与别的会话的行原样留着
        /// —— 下一轮 cleanup 还要靠它们回答「为什么这个窗口没收」。</summary>
        static void PruneCreatedEntries(Dictionary<string, WorkRegistry.Entry> map, string sessionId)
        {
            Dictionary<string, WorkRegistry.Entry> keep = new Dictionary<string, WorkRegistry.Entry>();
            foreach (KeyValuePair<string, WorkRegistry.Entry> kv in map)
            {
                WorkRegistry.Entry e = kv.Value;
                bool prunable = e != null && !string.IsNullOrEmpty(e.Title)
                    && string.IsNullOrEmpty(e.Path)
                    && WorkRegistry.IsCreatedOrigin(e.Origin)
                    && !WorkRegistry.IsForeignSession(e, sessionId);
                if (!prunable) keep[kv.Key] = e;
            }
            if (keep.Count != map.Count) WorkRegistry.Save(keep);
        }

        public static List<IModelDoc2> OpenDocuments(ISldWorks app)
        {
            List<IModelDoc2> list = new List<IModelDoc2>();
            object raw = app.GetDocuments();
            Array arr = raw as Array;
            if (arr == null) return list;
            foreach (object o in arr)
            {
                IModelDoc2 d = o as IModelDoc2;
                if (d != null) list.Add(d);
            }
            return list;
        }

        /// <summary>Closes any other open document that already holds this path, which
        /// is what makes SaveAs fail with swGenericSaveError (1). Documents the caller
        /// is saving are left alone. Returns null on success, or the title that
        /// refused to close.</summary>
        public static string CloseDocumentOnPath(ISldWorks app, string path, string keepTitle)
        {
            if (string.IsNullOrEmpty(path) || app == null) return null;
            string full;
            try
            {
                full = Path.GetFullPath(path);
            }
            catch (Exception)
            {
                return null;
            }

            List<IModelDoc2> holders = new List<IModelDoc2>();
            foreach (IModelDoc2 doc in OpenDocuments(app))
            {
                string p = doc.GetPathName();
                if (string.IsNullOrEmpty(p)) continue;
                string other;
                try
                {
                    other = Path.GetFullPath(p);
                }
                catch (Exception)
                {
                    continue;
                }
                if (!string.Equals(other, full, StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(doc.GetTitle(), keepTitle, StringComparison.OrdinalIgnoreCase)) continue;
                holders.Add(doc);
            }

            string refused = null;
            foreach (IModelDoc2 doc in holders)
            {
                string title = doc.GetTitle();
                // A5：占着这个路径的若是用户的未存盘文档，CloseByTitle 会以 USER_DOC_DIRTY
                // 拒绝，这里如实把它当"关不掉"报回去 —— 上层会报 SAVE_TARGET_OPEN，
                // 而不是替用户丢掉修改。
                string reason = null;
                if (CloseByTitle(app, title, true, null, null, out reason) == null) refused = title;
            }
            return refused;
        }

        /// <summary>Activates an already-open document by title, so a later edit finds
        /// the model it is meant to change instead of whatever happens to be in
        /// front.</summary>
        public static IModelDoc2 Activate(ISldWorks app, string title)
        {
            if (string.IsNullOrEmpty(title)) return null;
            int errors = 0;
            try
            {
                IModelDoc2 doc = (IModelDoc2)app.ActivateDoc3(title, false,
                    (int)swRebuildOnActivation_e.swDontRebuildActiveDoc, ref errors);
                return doc;
            }
            catch (COMException)
            {
                return null;
            }
        }
    }
}
