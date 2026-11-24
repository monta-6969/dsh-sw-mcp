using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Turns the geometry a profile happened to get into the relations the
    /// drawing actually meant, and edits those relations afterwards.
    ///
    /// A profile built from coordinates is a picture of a part: every distance is a
    /// literal, nothing holds the shape together, and changing one parameter leaves
    /// the rest behind. Relations are what make it a design — horizontal and vertical
    /// sides, coincident corners, tangency where an arc meets a line, concentric
    /// holes, equal diameters, and the "centre of this arc lies on that arc" pair the
    /// hook profile needs.
    ///
    /// Two rules hold for every edit path here:
    ///   1. <c>GetAllowedRelations</c> is asked before <c>AddRelation</c> is called.
    ///      A relation the solver would refuse leaves an over-defined sketch that looks
    ///      fine until something rebuilds.
    ///   2. A relation that does not land is reported (<c>RELATION_REJECTED</c>) and
    ///      rolled back. Silently skipping one is how a sketch ends up looking
    ///      constrained while nothing holds the two arcs together.
    ///
    /// The old <c>h.Doc</c> read is gone: a worker creates a fresh <see cref="SwHost"/>
    /// per request, so <c>Doc</c> is always null and every relations call died with
    /// NO_DOCUMENT. Documents are resolved by designId through
    /// <see cref="Operations.DesignDocument"/>, falling back to the active document.</summary>
    static class Relations
    {
        /// <summary>Relation types worth inferring, by the geometry they need.</summary>
        static readonly int[] Linear = { (int)swConstraintType_e.swConstraintType_HORIZONTAL,
                                         (int)swConstraintType_e.swConstraintType_VERTICAL,
                                         (int)swConstraintType_e.swConstraintType_COLINEAR,
                                         (int)swConstraintType_e.swConstraintType_PARALLEL,
                                         (int)swConstraintType_e.swConstraintType_PERPENDICULAR,
                                         (int)swConstraintType_e.swConstraintType_SAMELENGTH };

        /// <summary>Relation names this bridge accepts, mapped to swConstraintType_e.
        /// The spelling on the wire is SOLIDWORKS' own (COINCIDENT, ATMIDDLE, …) plus
        /// the prose names the design DSL already used (EQUAL, MIDPOINT, FIX), so a
        /// caller can stay in whichever vocabulary it started with.</summary>
        static readonly Dictionary<string, int> TypeNames = BuildTypeNames();

        sealed class Seg
        {
            public int Index;
            public ISketchSegment Segment;
            public int Kind;              // 0 line, 1 arc, other: ignored
            public double X1, Y1, X2, Y2; // endpoints, metres
            public double Cx, Cy, R;      // arc only
            public bool IsLine { get { return Kind == 0; } }
            public bool IsArc { get { return Kind == 1; } }
            public double Length
            {
                get { return IsLine ? Math.Sqrt((X2 - X1) * (X2 - X1) + (Y2 - Y1) * (Y2 - Y1)) : R; }
            }
        }

        static Dictionary<string, int> BuildTypeNames()
        {
            Dictionary<string, int> map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            Add(map, "COINCIDENT", swConstraintType_e.swConstraintType_COINCIDENT);
            Add(map, "TANGENT", swConstraintType_e.swConstraintType_TANGENT);
            Add(map, "CONCENTRIC", swConstraintType_e.swConstraintType_CONCENTRIC);
            Add(map, "EQUAL", swConstraintType_e.swConstraintType_SAMELENGTH);
            Add(map, "SAMELENGTH", swConstraintType_e.swConstraintType_SAMELENGTH);
            Add(map, "PARALLEL", swConstraintType_e.swConstraintType_PARALLEL);
            Add(map, "PERPENDICULAR", swConstraintType_e.swConstraintType_PERPENDICULAR);
            Add(map, "HORIZONTAL", swConstraintType_e.swConstraintType_HORIZONTAL);
            Add(map, "VERTICAL", swConstraintType_e.swConstraintType_VERTICAL);
            Add(map, "SYMMETRIC", swConstraintType_e.swConstraintType_SYMMETRIC);
            Add(map, "MIDPOINT", swConstraintType_e.swConstraintType_ATMIDDLE);
            Add(map, "ATMIDDLE", swConstraintType_e.swConstraintType_ATMIDDLE);
            Add(map, "FIX", swConstraintType_e.swConstraintType_FIXED);
            Add(map, "FIXED", swConstraintType_e.swConstraintType_FIXED);
            Add(map, "COLINEAR", swConstraintType_e.swConstraintType_COLINEAR);
            Add(map, "INTERSECTION", swConstraintType_e.swConstraintType_INTERSECTION);
            Add(map, "ATINTERSECT", swConstraintType_e.swConstraintType_ATINTERSECT);
            Add(map, "PIERCE", swConstraintType_e.swConstraintType_ATPIERCE);
            Add(map, "ATPIERCE", swConstraintType_e.swConstraintType_ATPIERCE);
            Add(map, "HORIZPOINTS", swConstraintType_e.swConstraintType_HORIZPOINTS);
            Add(map, "VERTPOINTS", swConstraintType_e.swConstraintType_VERTPOINTS);
            return map;
        }

        static void Add(Dictionary<string, int> map, string name, swConstraintType_e type)
        {
            map[name] = (int)type;
        }

        // ------------------------------------------------------------ dispatch

        public static Dictionary<string, object> Dispatch(Dictionary<string, object> req)
        {
            string action = Json.Str(req, "action", "infer");
            // Validation is pure parsing: no COM, no document. It is what the Node
            // tests use to exercise the reference grammar without SOLIDWORKS running.
            if (string.Equals(action, "validate", StringComparison.OrdinalIgnoreCase)
                || string.Equals(action, "plan", StringComparison.OrdinalIgnoreCase))
                return Validate(req);

            using (SwHost h = SwHost.Attach())
            {
                switch ((action ?? "").ToLowerInvariant())
                {
                    case "infer": return Infer(h, req, false);
                    case "apply": return Infer(h, req, true);
                    case "status":
                    case "list": return Status(h, req);
                    case "add": return Mutate(h, req, "add");
                    case "edit": return Mutate(h, req, "edit");
                    case "remove": return Mutate(h, req, "remove");
                    case "clear": return Clear(h, req);
                    default:
                        throw new BridgeError("BAD_ARGUMENT",
                            "relations action must be one of infer, apply, list, status, add, edit, "
                            + "remove, clear or validate; got \"" + action + "\"",
                            Json.Dict("actions", Json.List("infer", "apply", "list", "status",
                                "add", "edit", "remove", "clear", "validate")));
                }
            }
        }

        // ------------------------------------------------------------ references

        /// <summary>One entity reference inside a relation.
        ///
        /// Wire syntax: <c>"seg:3"</c> for the third sketch segment,
        /// <c>"seg:3:start|end|center"</c> for one of its points, and bare curve ids
        /// (<c>"arc1:center"</c>) inside a build definition, where the id is the curve
        /// id the definition just declared.</summary>
        sealed class Ref
        {
            public string Text;
            public int Index;       // 1-based segment ordinal, 0 when CurveId is set
            public string CurveId;
            public int Part;        // 0 whole entity, 1 start, 2 end, 3 centre
            public bool IsPoint { get { return Part != 0; } }

            public string Canonical
            {
                get
                {
                    string head = Index > 0 ? "seg:" + Index : CurveId;
                    return Part == 0 ? head : head + ":" + PartName(Part);
                }
            }
        }

        static string PartName(int part)
        {
            switch (part)
            {
                case 1: return "start";
                case 2: return "end";
                case 3: return "center";
                default: return null;
            }
        }

        static int PartOf(string text)
        {
            string t = (text ?? "").Trim().ToLowerInvariant();
            if (t == "start") return 1;
            if (t == "end") return 2;
            if (t == "center" || t == "centre") return 3;
            return 0;
        }

        static Ref ParseRef(string text)
        {
            if (text == null)
                throw new BridgeError("BAD_REF", "each relation reference must be a string, got null");
            string raw = text.Trim();
            if (raw.Length == 0)
                throw new BridgeError("BAD_REF", "relation reference is empty");

            string body = raw;
            bool askedSegment = false;
            if (body.StartsWith("seg:", StringComparison.OrdinalIgnoreCase))
            {
                askedSegment = true;
                body = body.Substring(4);
            }
            else if (body.StartsWith("curve:", StringComparison.OrdinalIgnoreCase))
            {
                body = body.Substring(6);
            }

            string[] parts = body.Split(':');
            if (parts.Length > 2)
                throw new BridgeError("BAD_REF",
                    "reference \"" + raw + "\" has " + parts.Length + " ':'-separated parts; "
                    + "expected seg:<index> or seg:<index>:start|end|center",
                    Json.Dict("reference", raw));

            string head = parts[0].Trim();
            int part = 0;
            if (parts.Length == 2)
            {
                part = PartOf(parts[1]);
                if (part == 0)
                    throw new BridgeError("BAD_REF",
                        "reference \"" + raw + "\" names an unknown point \"" + parts[1].Trim()
                        + "\"; expected start, end or center",
                        Json.Dict("reference", raw, "points", Json.List("start", "end", "center")));
            }
            if (head.Length == 0)
                throw new BridgeError("BAD_REF", "reference \"" + raw + "\" has an empty head",
                    Json.Dict("reference", raw));

            int index;
            if (int.TryParse(head, NumberStyles.Integer, CultureInfo.InvariantCulture, out index))
            {
                if (index <= 0)
                    throw new BridgeError("BAD_REF",
                        "reference \"" + raw + "\" uses segment index " + index
                        + "; sketch segments are numbered from 1",
                        Json.Dict("reference", raw));
                Ref seg = new Ref();
                seg.Text = raw;
                seg.Index = index;
                seg.Part = part;
                return seg;
            }

            if (askedSegment)
                throw new BridgeError("BAD_REF",
                    "reference \"" + raw + "\" must be seg:<positive integer>[:start|end|center]",
                    Json.Dict("reference", raw));
            if (!IsCurveId(head))
                throw new BridgeError("BAD_REF",
                    "reference \"" + raw + "\" is neither seg:<index> nor a curve id "
                    + "(letters, digits, '_', '.' and '-'; must not start with a digit)",
                    Json.Dict("reference", raw));

            Ref curve = new Ref();
            curve.Text = raw;
            curve.CurveId = head;
            curve.Part = part;
            return curve;
        }

        static bool IsCurveId(string text)
        {
            if (string.IsNullOrEmpty(text)) return false;
            if (!char.IsLetter(text[0]) && text[0] != '_') return false;
            foreach (char c in text)
                if (!char.IsLetterOrDigit(c) && c != '_' && c != '.' && c != '-') return false;
            return true;
        }

        // ------------------------------------------------------------- entities

        /// <summary>A reference resolved against the live sketch.</summary>
        sealed class Entity
        {
            public Ref Ref;
            public object Com;        // ISketchSegment or ISketchPoint
            public int SegmentIndex;  // 1-based when known
            public int Part;
            public bool IsPoint;
            public string Label;

            public ISketchPoint Point { get { return Com as ISketchPoint; } }
            public ISketchSegment Segment { get { return Com as ISketchSegment; } }
        }

        static bool TryResolve(List<Seg> segs, Ref r, out Entity entity, out string error)
        {
            entity = null;
            error = null;
            if (r.CurveId != null)
            {
                error = "curve id \"" + r.CurveId + "\" only resolves while the sketch that "
                    + "declares it is being built; use seg:<index> for an existing sketch";
                return false;
            }

            Seg seg = null;
            foreach (Seg s in segs)
                if (s.Index == r.Index) { seg = s; break; }
            if (seg == null)
            {
                error = "segment " + r.Index + " does not exist in this sketch, which has "
                    + segs.Count + " segment(s)";
                return false;
            }

            entity = new Entity();
            entity.Ref = r;
            entity.SegmentIndex = seg.Index;
            entity.Label = r.Canonical;

            if (r.Part == 0)
            {
                entity.Com = seg.Segment;
                entity.IsPoint = false;
                return true;
            }

            ISketchPoint point;
            string why;
            if (!TryPointOf(seg, r.Part, out point, out why))
            {
                entity = null;
                error = "seg:" + seg.Index + ":" + PartName(r.Part) + ": " + why;
                return false;
            }
            entity.Com = point;
            entity.Part = r.Part;
            entity.IsPoint = true;
            return true;
        }

        /// <summary>The start/end/centre point of a segment. Centre only exists for
        /// arcs and circles, which is exactly the combination the hook profile needs.</summary>
        static bool TryPointOf(Seg seg, int part, out ISketchPoint point, out string error)
        {
            point = null;
            error = null;
            try
            {
                if (part == 3)
                {
                    if (!seg.IsArc)
                    {
                        error = "only arcs and circles have a centre point";
                        return false;
                    }
                    point = (ISketchPoint)((ISketchArc)seg.Segment).GetCenterPoint2();
                }
                else if (seg.IsLine)
                {
                    ISketchLine line = (ISketchLine)seg.Segment;
                    point = (ISketchPoint)(part == 1 ? line.GetStartPoint2() : line.GetEndPoint2());
                }
                else if (seg.IsArc)
                {
                    ISketchArc arc = (ISketchArc)seg.Segment;
                    point = (ISketchPoint)(part == 1 ? arc.GetStartPoint2() : arc.GetEndPoint2());
                }
                else
                {
                    int kind;
                    try { kind = seg.Segment.GetType(); }
                    catch (COMException) { kind = -1; }
                    if (kind == (int)swSketchSegments_e.swSketchELLIPSE)
                    {
                        ISketchEllipse ellipse = (ISketchEllipse)seg.Segment;
                        point = (ISketchPoint)(part == 1 ? ellipse.GetStartPoint2() : ellipse.GetEndPoint2());
                    }
                    else if (kind == (int)swSketchSegments_e.swSketchSPLINE)
                    {
                        ISketchSpline spline = (ISketchSpline)seg.Segment;
                        object[] points = (object[])spline.GetPoints2();
                        if (points == null || points.Length == 0)
                        {
                            error = "spline has no readable points";
                            return false;
                        }
                        point = (ISketchPoint)(part == 1 ? points[0] : points[points.Length - 1]);
                    }
                    else
                    {
                        error = "this segment type has no readable start/end point";
                        return false;
                    }
                }
            }
            catch (COMException ex)
            {
                error = "SOLIDWORKS refused the point (COM 0x" + ex.HResult.ToString("X8") + ")";
                return false;
            }
            if (point == null)
            {
                error = "SOLIDWORKS returned no point";
                return false;
            }
            return true;
        }

        // ------------------------------------------------------------ validation

        /// <summary>Parses and checks a relation plan without touching SOLIDWORKS.
        ///
        /// Request: <c>{action:"validate", segments?: n, refs?: ["seg:1:center", …],
        /// relations?: [{type, refs}]}</c>. Response: one row per reference and one per
        /// relation, with <c>valid</c> and an <c>error</c> string when it is not. This is
        /// the entry the Node tests use: the grammar lives in C#, so testing a copy of it
        /// in JavaScript would only prove the copy is consistent with itself.</summary>
        static Dictionary<string, object> Validate(Dictionary<string, object> req)
        {
            int declared = Json.Int(req, "segments", 0);
            List<object> refRows = new List<object>();
            List<object> errors = new List<object>();

            List<string> refTexts = new List<string>();
            foreach (object raw in Json.Items(req.ContainsKey("refs") ? req["refs"] : null))
            {
                if (raw is string) refTexts.Add((string)raw);
            }
            foreach (Dictionary<string, object> rel in RelationSpecs(req))
            {
                foreach (string text in RefTexts(rel))
                    if (!refTexts.Contains(text)) refTexts.Add(text);
            }

            foreach (string text in refTexts)
            {
                Dictionary<string, object> row = Json.Dict("reference", text);
                try
                {
                    Ref r = ParseRef(text);
                    row["valid"] = true;
                    row["kind"] = r.Index > 0 ? "segment" : "curveId";
                    row["index"] = r.Index > 0 ? (object)Json.R(r.Index) : null;
                    row["curveId"] = r.CurveId;
                    row["point"] = PartName(r.Part);
                    row["canonical"] = r.Canonical;
                    if (declared > 0 && r.Index > declared)
                    {
                        row["valid"] = false;
                        row["error"] = "segment " + r.Index + " is beyond the declared segment count " + declared;
                        errors.Add(row["error"]);
                    }
                }
                catch (BridgeError error)
                {
                    row["valid"] = false;
                    row["error"] = error.Message;
                    errors.Add(error.Message);
                }
                refRows.Add(row);
            }

            List<object> relationRows = new List<object>();
            foreach (Dictionary<string, object> rel in RelationSpecs(req))
            {
                Dictionary<string, object> row = Json.Dict(
                    "type", Json.Str(rel, "type", Json.Str(rel, "relation", null)));
                List<object> refs = new List<object>(RefTexts(rel));
                row["refs"] = refs;
                List<string> problems = new List<string>();
                int type;
                if (!TryRelationType(Json.Str(rel, "type", Json.Str(rel, "relation", null)), out type))
                    problems.Add("unknown relation type \"" + Json.Str(rel, "type", Json.Str(rel, "relation", null))
                        + "\"; known: " + KnownTypeNames());
                else
                    row["relationType"] = Json.R(type);
                if (refs.Count == 0)
                    problems.Add("relation has no refs");
                if (refs.Count > 0 && refs.Count > 3)
                    problems.Add("a relation takes at most 3 entities; got " + refs.Count);
                foreach (object r in refs)
                {
                    try
                    {
                        Ref parsed = ParseRef((string)r);
                        if (declared > 0 && parsed.Index > declared)
                            problems.Add("reference \"" + r + "\" is beyond the declared segment count " + declared);
                    }
                    catch (BridgeError error) { problems.Add(error.Message); }
                }
                row["valid"] = problems.Count == 0;
                if (problems.Count > 0)
                {
                    row["error"] = string.Join("; ", problems.ToArray());
                    errors.Add(row["error"]);
                }
                relationRows.Add(row);
            }

            return Json.Dict(
                "valid", errors.Count == 0,
                "action", "validate",
                "segments", declared > 0 ? (object)Json.R(declared) : null,
                "refs", refRows,
                "relations", relationRows,
                "errors", errors);
        }

        static List<Dictionary<string, object>> RelationSpecs(Dictionary<string, object> req)
        {
            List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
            if (req == null) return list;
            object single = req.ContainsKey("relation") ? req["relation"] : null;
            Dictionary<string, object> one = Json.Obj(single);
            if (one != null) list.Add(one);
            foreach (object raw in Json.Items(req.ContainsKey("relations") ? req["relations"] : null))
            {
                Dictionary<string, object> row = Json.Obj(raw);
                if (row != null) list.Add(row);
            }
            return list;
        }

        static List<string> RefTexts(Dictionary<string, object> rel)
        {
            List<string> texts = new List<string>();
            if (rel == null) return texts;
            object[] keys = { "refs", "entities" };
            foreach (object key in keys)
            {
                string name = (string)key;
                foreach (object raw in Json.Items(rel.ContainsKey(name) ? rel[name] : null))
                {
                    string text = raw as string;
                    if (text == null)
                        throw new BridgeError("BAD_REF",
                            "relation refs must be strings; entity objects are only valid when a "
                            + "sketch is being built and its curve ids are known",
                            Json.Dict("value", Convert.ToString(raw, CultureInfo.InvariantCulture)));
                    texts.Add(text);
                }
            }
            return texts;
        }

        static string KnownTypeNames()
        {
            List<string> names = new List<string>(TypeNames.Keys);
            names.Sort(StringComparer.Ordinal);
            return string.Join(", ", names.ToArray());
        }

        static bool TryRelationType(string name, out int type)
        {
            type = 0;
            if (string.IsNullOrEmpty(name)) return false;
            int mapped;
            if (TypeNames.TryGetValue(name.Trim(), out mapped)) { type = mapped; return true; }
            int numeric;
            if (int.TryParse(name.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out numeric))
            {
                type = numeric;
                return true;
            }
            return false;
        }

        static int RelationType(string name)
        {
            int type;
            if (!TryRelationType(name, out type))
                throw new BridgeError("BAD_ARGUMENT",
                    "unknown relation type \"" + name + "\"; known: " + KnownTypeNames(),
                    Json.Dict("type", name));
            return type;
        }

        static string RelationName(int type)
        {
            foreach (KeyValuePair<string, int> kv in TypeNames)
                if (kv.Value == type) return kv.Key;
            return "TYPE_" + type.ToString(CultureInfo.InvariantCulture);
        }

        // ------------------------------------------------------------- mutation

        /// <summary>add / edit / remove on the live sketch.
        ///
        /// Every added relation is verified by counting relations before and after:
        /// <c>AddRelation</c> returning an object is not proof (the solver can drop it
        /// again), and a relation that silently did not land is the exact failure this
        /// whole operation exists to prevent. With <c>atomic</c> (default true) a
        /// rejected relation rolls back everything this call added and the operation
        /// throws RELATION_REJECTED.</summary>
        static Dictionary<string, object> Mutate(SwHost h, Dictionary<string, object> req, string action)
        {
            string designId = Json.Str(req, "designId", null);
            string sketchName;
            IModelDoc2 doc;
            ISketch sketch = GetSketch(h, designId, Json.Str(req, "sketch", null), out sketchName, out doc);
            if (sketch == null) throw new BridgeError("NO_SKETCH", "no sketch to edit relations on");

            List<string> notes = new List<string>();
            // 关系写入要求这张草图处于编辑态：真机实测草图关闭时 AddRelation 返回
            // null，选择式写入也一个实体都选不中。改完再把编辑态恢复回去。
            bool openedByUs = EnsureEditing(doc, sketchName, ref sketch, notes);

            ISketchRelationManager mgr = (ISketchRelationManager)sketch.RelationManager;
            List<Seg> segs = ReadSegments(sketch);
            bool atomic = Json.Bool(req, "atomic", true);
            bool skipAllowed = Json.Bool(req, "skipAllowedCheck", false);
            bool dryRun = Json.Bool(req, "dryRun", false);

            List<Dictionary<string, object>> specs = RelationSpecs(req);
            int before = mgr.GetRelationsCount(0);
            List<object> applied = new List<object>();
            List<object> rejected = new List<object>();
            List<object> removed = new List<object>();
            List<object> replaced = new List<object>();

            if (string.Equals(action, "remove", StringComparison.OrdinalIgnoreCase))
            {
                foreach (int index in IndexSpecs(req, specs))
                {
                    if (dryRun)
                    {
                        removed.Add(Json.Dict("index", Json.R(index), "dryRun", true));
                        continue;
                    }
                    object gone = RemoveAt(mgr, index, rejected, notes);
                    if (gone != null) removed.Add(gone);
                }
            }
            else if (string.Equals(action, "edit", StringComparison.OrdinalIgnoreCase))
            {
                foreach (Dictionary<string, object> spec in specs)
                {
                    EditOne(doc, sketch, mgr, segs, spec, skipAllowed, atomic, dryRun,
                        applied, rejected, replaced, notes);
                }
            }
            else
            {
                foreach (Dictionary<string, object> spec in specs)
                {
                    Dictionary<string, object> outcome = AddOne(doc, sketch, mgr, segs, spec,
                        skipAllowed, dryRun, notes);
                    if (Convert.ToBoolean(outcome["ok"])) applied.Add(outcome);
                    else rejected.Add(outcome);
                }
            }

            int after = mgr.GetRelationsCount(0);
            bool rolledBack = false;
            if (atomic && rejected.Count > 0 && !string.Equals(action, "remove", StringComparison.OrdinalIgnoreCase))
            {
                int dropped = RollbackTo(mgr, before);
                rolledBack = dropped > 0;
                if (dropped > 0)
                    notes.Add("rolled back " + dropped + " relation change(s) made by this call");
                after = mgr.GetRelationsCount(0);
            }

            int constrained = ConstrainedStatus(sketch);
            Dictionary<string, object> result = Json.Dict(
                "sketch", sketchName,
                "document", DocumentOf(doc),
                "action", action,
                "applied", applied,
                "rejected", rejected,
                "removed", removed,
                "replaced", replaced,
                "requested", applied.Count + rejected.Count,
                "appliedCount", applied.Count,
                "rejectedCount", rejected.Count,
                "removedCount", removed.Count,
                "relationsApplied", applied,
                "rejectedRelations", rejected,
                "removedRelations", removed,
                "rolledBack", rolledBack,
                "dryRun", dryRun,
                "relationCount", Json.R(after),
                "constrainedStatus", Json.R(constrained),
                "fullyConstrained", constrained == 0,
                "notes", notes,
                "relations", ReadRelationRows(sketch));

            if (rejected.Count > 0
                && (atomic || string.Equals(action, "remove", StringComparison.OrdinalIgnoreCase)))
            {
                LeaveEditing(doc, openedByUs);
                throw new BridgeError("RELATION_REJECTED",
                    rejected.Count + " of " + (applied.Count + rejected.Count)
                    + " relation(s) could not be applied to sketch \"" + sketchName + "\""
                    + (rolledBack ? "; every relation this call added was rolled back" : ""),
                    Json.Dict("sketch", sketchName, "document", DocumentOf(doc),
                        "applied", applied, "rejected", rejected, "removed", removed,
                        "rolledBack", rolledBack, "constrainedStatus", Json.R(constrained),
                        "notes", notes));
            }
            LeaveEditing(doc, openedByUs);
            return result;
        }

        static List<int> IndexSpecs(Dictionary<string, object> req, List<Dictionary<string, object>> specs)
        {
            List<int> list = new List<int>();
            foreach (object raw in Json.Items(req.ContainsKey("relationIds") ? req["relationIds"] : null))
            {
                int index = ToInt(raw);
                if (index > 0 && !list.Contains(index)) list.Add(index);
            }
            foreach (object raw in Json.Items(req.ContainsKey("indices") ? req["indices"] : null))
            {
                int index = ToInt(raw);
                if (index > 0 && !list.Contains(index)) list.Add(index);
            }
            foreach (string key in new string[] { "index", "relationId" })
            {
                object single = req.ContainsKey(key) ? req[key] : null;
                int index = ToInt(single);
                if (index > 0 && !list.Contains(index)) list.Add(index);
            }
            foreach (Dictionary<string, object> spec in specs)
            {
                int index = Json.Int(spec, "index", Json.Int(spec, "relationIndex", 0));
                if (index > 0 && !list.Contains(index)) list.Add(index);
            }
            return list;
        }

        static int ToInt(object value)
        {
            if (value == null) return 0;
            try { return Convert.ToInt32(value); }
            catch (Exception) { return 0; }
        }

        /// <summary>Replaces one relation in place: delete the old one, add the new
        /// description, and put the old one back if the new one does not land.</summary>
        static void EditOne(IModelDoc2 doc, ISketch sketch, ISketchRelationManager mgr, List<Seg> segs,
            Dictionary<string, object> spec, bool skipAllowed, bool atomic, bool dryRun,
            List<object> applied, List<object> rejected, List<object> replaced, List<string> notes)
        {
            string typeName = Json.Str(spec, "type", Json.Str(spec, "relation", null));
            int index = Json.Int(spec, "index", Json.Int(spec, "relationIndex", 0));
            if (index <= 0)
            {
                rejected.Add(RejectedRow(-1, typeName,
                    "edit needs \"index\": the 1-based index reported by action=status", spec));
                return;
            }
            SketchRelation old = RelationAt(mgr, index);
            if (old == null)
            {
                rejected.Add(RejectedRow(index, typeName,
                    "no relation at index " + index + " (" + mgr.GetRelationsCount(0) + " relation(s))", spec));
                return;
            }
            int oldType = old.GetRelationType();
            object[] oldEntities = null;
            try { oldEntities = (object[])old.GetEntities(); }
            catch (COMException) { }
            if (dryRun)
            {
                applied.Add(Json.Dict("index", Json.R(index), "dryRun", true,
                    "replacedType", RelationName(oldType), "type", typeName));
                return;
            }
            int beforeCount = mgr.GetRelationsCount(0);
            bool deleted = false;
            try { deleted = mgr.DeleteRelation(old); }
            catch (COMException ex)
            {
                notes.Add("DeleteRelation threw 0x" + ex.HResult.ToString("X8") + ": " + ex.Message);
            }
            if (!deleted || mgr.GetRelationsCount(0) >= beforeCount)
            {
                rejected.Add(RejectedRow(index, RelationName(oldType),
                    "SOLIDWORKS refused to delete the relation being edited", spec));
                return;
            }
            Dictionary<string, object> outcome = AddOne(doc, sketch, mgr, segs, spec, skipAllowed, false, notes);
            if (Convert.ToBoolean(outcome["ok"]))
            {
                outcome["index"] = Json.R(index);
                outcome["replacedType"] = RelationName(oldType);
                applied.Add(outcome);
                replaced.Add(Json.Dict("index", Json.R(index),
                    "from", RelationName(oldType), "to", Convert.ToString(outcome["type"])));
                return;
            }
            rejected.Add(outcome);
            if (atomic && oldEntities != null && oldEntities.Length > 0)
            {
                try
                {
                    if (mgr.AddRelation(oldEntities, oldType) == null)
                        notes.Add("could not restore relation " + index + " after a failed edit");
                }
                catch (Exception)
                {
                    notes.Add("could not restore relation " + index + " after a failed edit");
                }
            }
        }

        /// <summary>Adds one relation and verifies it landed. Never throws for a
        /// solver refusal: the caller decides whether that is fatal, and a rejected row
        /// always carries the reason so it cannot be read as "done".</summary>
        static Dictionary<string, object> AddOne(IModelDoc2 doc, ISketch sketch,
            ISketchRelationManager mgr, List<Seg> segs, Dictionary<string, object> spec,
            bool skipAllowed, bool dryRun, List<string> notes)
        {
            string typeName = Json.Str(spec, "type", Json.Str(spec, "relation", null));
            List<string> refs = RefTexts(spec);
            Dictionary<string, object> row = Json.Dict("type", typeName, "refs", refs);
            int type;
            if (!TryRelationType(typeName, out type))
            {
                return Fail(row, "unknown relation type \"" + typeName + "\"; known: " + KnownTypeNames());
            }
            row["relationType"] = Json.R(type);
            if (refs.Count == 0)
                return Fail(row, "relation needs refs (seg:<index> or seg:<index>:start|end|center)");

            List<Entity> entities = new List<Entity>();
            foreach (string text in refs)
            {
                Entity entity;
                string error;
                Ref parsed;
                try { parsed = ParseRef(text); }
                catch (BridgeError be) { return Fail(row, be.Message); }
                if (!TryResolve(segs, parsed, out entity, out error)) return Fail(row, error);
                entities.Add(entity);
            }

            List<object> com = new List<object>();
            List<string> labels = new List<string>();
            foreach (Entity entity in entities)
            {
                com.Add(entity.Com);
                labels.Add(entity.Label);
            }
            row["entities"] = DescribeEntities(segs, com);
            row["labels"] = labels;

            if (dryRun)
            {
                string allowed;
                bool ok = Allowed(mgr, com.ToArray(), type, skipAllowed, out allowed);
                row["ok"] = ok;
                row["dryRun"] = true;
                if (!ok)
                    row["error"] = "SOLIDWORKS does not allow " + RelationName(type) + " on this selection"
                        + (allowed != null ? " (allowed: " + allowed + ")" : "");
                return row;
            }

            RelationOutcome outcome = ApplyType(doc, sketch, type, com.ToArray(), skipAllowed);
            row["ok"] = outcome.Ok;
            row["fallback"] = outcome.ViaFallback;
            if (!outcome.Ok)
            {
                row["code"] = "RELATION_REJECTED";
                row["error"] = outcome.Why;
            }
            if (outcome.ViaFallback)
                notes.Add("relation " + RelationName(type) + " on " + string.Join(",", labels.ToArray())
                    + " was applied through the sketch-point fallback");
            return row;
        }

        static Dictionary<string, object> Fail(Dictionary<string, object> row, string why)
        {
            row["ok"] = false;
            row["code"] = "RELATION_REJECTED";
            row["error"] = why;
            return row;
        }

        static Dictionary<string, object> RejectedRow(int index, string type, string why,
            Dictionary<string, object> spec)
        {
            return Json.Dict("index", Json.R(index), "type", type, "ok", false, "why", why,
                "refs", spec == null ? null : (object)RefTexts(spec));
        }

        static SketchRelation RelationAt(ISketchRelationManager mgr, int index)
        {
            object[] all = (object[])mgr.GetRelations(0);
            if (all == null || index <= 0 || index > all.Length) return null;
            return all[index - 1] as SketchRelation;
        }

        static object RemoveAt(ISketchRelationManager mgr, int index, List<object> rejected, List<string> notes)
        {
            SketchRelation rel = RelationAt(mgr, index);
            if (rel == null)
            {
                rejected.Add(RejectedRow(index, null, "no relation at index " + index, null));
                return null;
            }
            int type = rel.GetRelationType();
            int before = mgr.GetRelationsCount(0);
            bool deleted = false;
            try { deleted = mgr.DeleteRelation(rel); }
            catch (COMException ex)
            {
                notes.Add("DeleteRelation threw 0x" + ex.HResult.ToString("X8") + " for index " + index);
            }
            int after = mgr.GetRelationsCount(0);
            if (!deleted || after >= before)
            {
                rejected.Add(RejectedRow(index, RelationName(type),
                    "SOLIDWORKS did not delete the relation (count " + before + " -> " + after + ")", null));
                return null;
            }
            return Json.Dict("index", Json.R(index), "type", RelationName(type), "deleted", true);
        }

        static int RollbackTo(ISketchRelationManager mgr, int keep)
        {
            int removed = 0;
            object[] all = (object[])mgr.GetRelations(0);
            if (all == null) return 0;
            for (int i = all.Length - 1; i >= keep; i--)
            {
                SketchRelation rel = all[i] as SketchRelation;
                if (rel == null) continue;
                try
                {
                    if (mgr.DeleteRelation(rel)) removed++;
                }
                catch (COMException) { }
            }
            return removed;
        }

        static int ConstrainedStatus(ISketch sketch)
        {
            try { return sketch.GetConstrainedStatus(); }
            catch (Exception) { return -1; }
        }

        // ------------------------------------------------------ relation apply

        /// <summary>Outcome of one relation attempt, including whether it needed the
        /// coordinate fallback.</summary>
        public sealed class RelationOutcome
        {
            public bool Ok;
            public string Why;
            public bool ViaFallback;
        }

        /// <summary>Applies one relation: allowed-check, then <c>AddRelation</c>, then
        /// the sketch-point fallback. Never throws for a refusal.
        ///
        /// The fallback exists because "centre of this arc lies on that arc" is not a
        /// relation the relation manager reliably accepts as a point-to-curve pair:
        /// SOLIDWORKS' own UI does it by picking the centre mark and the arc in the
        /// sketch and hitting COINCIDENT, which is <c>SelectByID2(…,"SKETCHPOINT")</c>
        /// plus <c>SelectByID2(…,"SKETCHARC")</c> and <c>SketchAddConstraints</c>.
        /// Skipping that path left the hook's two arcs unconstrained while the build
        /// reported success.</summary>
        public static RelationOutcome Apply(IModelDoc2 doc, ISketch sketch, string typeName,
            object[] entities, bool skipAllowed)
        {
            int type;
            if (!TryRelationType(typeName, out type))
            {
                RelationOutcome bad = new RelationOutcome();
                bad.Why = "unknown relation type \"" + typeName + "\"; known: " + KnownTypeNames();
                return bad;
            }
            return ApplyType(doc, sketch, type, entities, skipAllowed);
        }

        static RelationOutcome ApplyType(IModelDoc2 doc, ISketch sketch, int type,
            object[] entities, bool skipAllowed)
        {
            RelationOutcome outcome = new RelationOutcome();
            if (entities == null || entities.Length == 0)
            {
                outcome.Why = "relation needs at least one entity";
                return outcome;
            }
            ISketchRelationManager mgr = (ISketchRelationManager)sketch.RelationManager;
            string member;
            if (!Allowed(mgr, entities, type, skipAllowed, out member))
            {
                string why;
                if (TrySelection(doc, mgr, type, entities, out why))
                {
                    outcome.Ok = true;
                    outcome.ViaFallback = true;
                    return outcome;
                }
                outcome.Why = "SOLIDWORKS does not allow " + RelationName(type) + " on this selection"
                    + (member != null ? " (allowed: " + member + ")" : "")
                    + (why == null ? "" : "; fallback: " + why);
                return outcome;
            }

            int before = mgr.GetRelationsCount(0);
            string message = null;
            try
            {
                SketchRelation rel = mgr.AddRelation(entities, type);
                if (rel == null) message = "AddRelation returned null";
                else if (mgr.GetRelationsCount(0) <= before)
                    message = "AddRelation returned a relation but the count did not change";
            }
            catch (COMException ex)
            {
                message = "AddRelation threw COM 0x" + ex.HResult.ToString("X8") + ": " + ex.Message;
            }
            catch (Exception ex)
            {
                message = "AddRelation threw " + ex.GetType().Name + ": " + ex.Message;
            }
            if (message == null)
            {
                outcome.Ok = true;
                return outcome;
            }

            string fallbackWhy;
            if (TrySelection(doc, mgr, type, entities, out fallbackWhy))
            {
                outcome.Ok = true;
                outcome.ViaFallback = true;
                outcome.Why = message + " (applied through the sketch-point fallback)";
                return outcome;
            }
            outcome.Why = message + (fallbackWhy == null ? "" : "; fallback: " + fallbackWhy);
            return outcome;
        }

        static bool Allowed(ISketchRelationManager mgr, object[] entities, int type,
            bool skipAllowed, out string allowedNames)
        {
            allowedNames = null;
            if (skipAllowed) return true;
            try
            {
                int[] allowed = (int[])mgr.GetAllowedRelations(entities);
                if (allowed == null || allowed.Length == 0) return true; // nothing to check against
                List<string> names = new List<string>();
                foreach (int a in allowed)
                {
                    if (a == type) return true;
                    names.Add(RelationName(a));
                }
                allowedNames = string.Join(", ", names.ToArray());
                return false;
            }
            catch (Exception)
            {
                return true; // older builds may not implement the query
            }
        }

        /// <summary>Which <c>SketchAddConstraints</c> command name belongs to a relation
        /// type. The 2D spellings for horizontal/vertical are the ones this bridge has
        /// used since before this change (Curves.RelationCode): a relation that is asked
        /// for and lands as a different relation is worse than one that is refused.
        /// Types without a known command are not guessed at.</summary>
        static Dictionary<int, string> BuildConstraintCommands()
        {
            Dictionary<int, string> map = new Dictionary<int, string>();
            map[(int)swConstraintType_e.swConstraintType_COINCIDENT] = "sgCOINCIDENT";
            map[(int)swConstraintType_e.swConstraintType_HORIZONTAL] = "sgHORIZONTAL2D";
            map[(int)swConstraintType_e.swConstraintType_VERTICAL] = "sgVERTICAL2D";
            map[(int)swConstraintType_e.swConstraintType_TANGENT] = "sgTANGENT";
            map[(int)swConstraintType_e.swConstraintType_CONCENTRIC] = "sgCONCENTRIC";
            map[(int)swConstraintType_e.swConstraintType_SAMELENGTH] = "sgEQUAL";
            map[(int)swConstraintType_e.swConstraintType_PARALLEL] = "sgPARALLEL";
            map[(int)swConstraintType_e.swConstraintType_PERPENDICULAR] = "sgPERPENDICULAR";
            map[(int)swConstraintType_e.swConstraintType_SYMMETRIC] = "sgSYMMETRIC";
            map[(int)swConstraintType_e.swConstraintType_ATMIDDLE] = "sgMIDPOINT";
            map[(int)swConstraintType_e.swConstraintType_FIXED] = "sgFIXED";
            map[(int)swConstraintType_e.swConstraintType_COLINEAR] = "sgCOLINEAR";
            return map;
        }

        static readonly Dictionary<int, string> ConstraintCommands = BuildConstraintCommands();

        /// <summary>Selects the entities and lets the sketch solver add the relation —
        /// the same route SOLIDWORKS' own command takes.
        ///
        /// Why this exists: on the live SOLIDWORKS 2026 SP3.2 this bridge drives,
        /// <c>ISketchRelationManager.AddRelation</c> faults with COM 0x80010105
        /// (RPC_E_SERVERFAULT) for every relation type and entity shape tried
        /// (single-segment HORIZONTAL, point-point COINCIDENT, two-segment TANGENT), even
        /// with the sketch open for editing and while the same manager still answers
        /// GetRelations/GetRelationsCount. Selection + SketchAddConstraints is the path
        /// the UI takes; measured there, CONCENTRIC and TANGENT land. AddRelation is
        /// still tried first: on a build where it works it is the more direct route.</summary>
        static bool TrySelection(IModelDoc2 doc, ISketchRelationManager mgr, int type,
            object[] entities, out string why)
        {
            why = null;
            if (entities == null || entities.Length == 0)
            {
                why = "nothing to select";
                return false;
            }
            string command;
            if (!ConstraintCommands.TryGetValue(type, out command))
            {
                why = "no known SketchAddConstraints command for " + RelationName(type);
                return false;
            }

            int before = mgr.GetRelationsCount(0);
            int selected = 0;
            try { doc.ClearSelection2(true); } catch (COMException) { }
            bool append = false;
            foreach (object entity in entities)
            {
                string miss;
                if (!SelectEntity(doc, entity, append, out miss))
                {
                    why = "could not select entity " + (selected + 1).ToString(CultureInfo.InvariantCulture)
                        + " of " + entities.Length.ToString(CultureInfo.InvariantCulture) + ": " + miss;
                    try { doc.ClearSelection2(true); } catch (COMException) { }
                    return false;
                }
                selected++;
                append = true;
            }

            try { doc.SketchAddConstraints(command); }
            catch (COMException ex)
            {
                why = "SketchAddConstraints(\"" + command + "\") threw COM 0x"
                    + ex.HResult.ToString("X8");
            }
            catch (Exception ex)
            {
                why = "SketchAddConstraints(\"" + command + "\") threw " + ex.Message;
            }

            int after = mgr.GetRelationsCount(0);
            if (after > before)
            {
                try { doc.ClearSelection2(true); } catch (COMException) { }
                return true;
            }
            // 同一件事的另一个入口：IModelDoc2.AddRelation 走的是文档级的关系表。
            // SketchAddConstraints 对「点-点重合」在真机上一条关系都加不出来（选中的
            // 两个点也确实进了选择集），换这个入口再试一次，避免把可写的类型判死。
            try { doc.AddRelation(command); }
            catch (COMException) { }
            catch (Exception) { }
            try { doc.ClearSelection2(true); } catch (COMException) { }

            after = mgr.GetRelationsCount(0);
            if (after > before) return true;
            if (why == null)
                why = "SketchAddConstraints(\"" + command + "\") added no relation (count "
                    + before.ToString(CultureInfo.InvariantCulture) + " -> "
                    + after.ToString(CultureInfo.InvariantCulture) + ")";
            return false;
        }

        static int SelectedCount(IModelDoc2 doc)
        {
            // IModelDoc2.SelectionManager is declared as object in this interop build.
            ISelectionMgr manager = null;
            try { manager = doc.SelectionManager as ISelectionMgr; }
            catch (COMException) { }
            if (manager == null) return 0;
            try { return manager.GetSelectedObjectCount2(-1); }
            catch (COMException) { }
            catch (Exception) { }
            try { return manager.GetSelectedObjectCount(); }
            catch (Exception) { return 0; }
        }

        /// <summary>Selects one sketch entity for SketchAddConstraints.
        ///
        /// Two routes, because they are good at different things: Select4 on the COM
        /// entity is exact for segments (two circles can share a radius) but measured
        /// unreliable for sketch points; SelectByID2 by coordinates is what the previous
        /// code used and it does select points, but it cannot tell two coincident points
        /// apart. Either way the selection count is verified: "Select returned true" is
        /// how a selection that missed used to be counted as success.</summary>
        static bool SelectEntity(IModelDoc2 doc, object entity, bool append, out string why)
        {
            why = null;
            int before = SelectedCount(doc);
            ISketchPoint point = entity as ISketchPoint;
            if (point != null)
            {
                try { if (point.Select4(append, null) && SelectedCount(doc) > before) return true; }
                catch (COMException) { }
            }
            else
            {
                ISketchSegment segment = entity as ISketchSegment;
                if (segment != null)
                {
                    try { if (segment.Select4(append, null) && SelectedCount(doc) > before) return true; }
                    catch (COMException) { }
                }
            }

            double x, y;
            string type;
            if (!PointOnEntity(entity, out x, out y, out type))
            {
                why = "no coordinates to select it by";
                return false;
            }
            IModelDocExtension ext = doc.Extension;
            if (ext == null) { why = "document has no Extension object"; return false; }
            try
            {
                if (ext.SelectByID2("", type, x, y, 0, append, 0, null, 0)
                    && SelectedCount(doc) > before) return true;
            }
            catch (COMException ex)
            {
                why = "SelectByID2 threw COM 0x" + ex.HResult.ToString("X8");
                return false;
            }
            why = "neither Select4 nor SelectByID2 (" + type + " at "
                + Json.Num(x * 1000) + ", " + Json.Num(y * 1000) + " mm) joined the selection";
            return false;
        }

        /// <summary>A point on the entity plus the SelectByID2 type string used to pick
        /// it: a line's midpoint, an arc's (or circle's) start point, an ellipse's start
        /// point, a spline's first point.</summary>
        static bool PointOnEntity(object entity, out double x, out double y, out string type)
        {
            x = y = 0;
            type = null;
            ISketchPoint point = entity as ISketchPoint;
            if (point != null)
            {
                x = point.X;
                y = point.Y;
                type = "SKETCHPOINT";
                return true;
            }
            ISketchSegment segment = entity as ISketchSegment;
            if (segment == null) return false;
            try
            {
                int kind = segment.GetType();
                if (kind == (int)swSketchSegments_e.swSketchLINE)
                {
                    ISketchLine line = (ISketchLine)segment;
                    ISketchPoint a = (ISketchPoint)line.GetStartPoint2();
                    ISketchPoint b = (ISketchPoint)line.GetEndPoint2();
                    x = (a.X + b.X) / 2.0;
                    y = (a.Y + b.Y) / 2.0;
                    type = "SKETCHLINE";
                    return true;
                }
                if (kind == (int)swSketchSegments_e.swSketchARC)
                {
                    ISketchPoint a = (ISketchPoint)((ISketchArc)segment).GetStartPoint2();
                    x = a.X;
                    y = a.Y;
                    type = "SKETCHARC";
                    return true;
                }
                if (kind == (int)swSketchSegments_e.swSketchELLIPSE)
                {
                    ISketchPoint a = (ISketchPoint)((ISketchEllipse)segment).GetStartPoint2();
                    x = a.X;
                    y = a.Y;
                    type = "SKETCHELLIPSE";
                    return true;
                }
                if (kind == (int)swSketchSegments_e.swSketchSPLINE)
                {
                    object[] points = (object[])((ISketchSpline)segment).GetPoints2();
                    if (points == null || points.Length == 0) return false;
                    ISketchPoint a = points[0] as ISketchPoint;
                    if (a == null) return false;
                    x = a.X;
                    y = a.Y;
                    type = "SKETCHSPLINE";
                    return true;
                }
            }
            catch (COMException) { }
            return false;
        }

        // ------------------------------------------------------------- clearing

        static Dictionary<string, object> Clear(SwHost h, Dictionary<string, object> req)
        {
            if (!Json.Bool(req, "confirm", false))
                throw new BridgeError("BAD_ARGUMENT",
                    "clearing every relation from a sketch cannot be undone by this bridge; "
                    + "pass confirm:true to delete them all, or action=remove with relation indices",
                    Json.Dict("hint", "confirm:true"));

            string sketchName;
            IModelDoc2 doc;
            ISketch sketch = GetSketch(h, Json.Str(req, "designId", null), Json.Str(req, "sketch", null),
                out sketchName, out doc);
            if (sketch == null) throw new BridgeError("NO_SKETCH", "no sketch to clear");
            List<string> notes = new List<string>();
            bool openedByUs = EnsureEditing(doc, sketchName, ref sketch, notes);
            ISketchRelationManager mgr = (ISketchRelationManager)sketch.RelationManager;
            int before = mgr.GetRelationsCount(0);
            bool deleted = false;
            try { deleted = mgr.DeleteAllRelations(); }
            catch (COMException) { }
            int after = mgr.GetRelationsCount(0);
            LeaveEditing(doc, openedByUs);
            return Json.Dict(
                "sketch", sketchName,
                "document", DocumentOf(doc),
                "action", "clear",
                "deleted", before - after,
                "requested", Json.R(before),
                "remaining", Json.R(after),
                "ok", deleted && after < before,
                "notes", notes,
                "constrainedStatus", Json.R(ConstrainedStatus(sketch)),
                "fullyConstrained", ConstrainedStatus(sketch) == 0);
        }

        // --------------------------------------------------------------- status

        /// <summary>Every relation in the sketch, one row each. The pre-hook version
        /// returned only type + entity count, which cannot answer "is the centre of arc
        /// 1 on arc 2?" — the index and the entity references are the point.</summary>
        static Dictionary<string, object> Status(SwHost h, Dictionary<string, object> req)
        {
            string sketchName;
            IModelDoc2 doc;
            ISketch sketch = GetSketch(h, Json.Str(req, "designId", null), Json.Str(req, "sketch", null),
                out sketchName, out doc);
            if (sketch == null) throw new BridgeError("NO_SKETCH", "no sketch to inspect");

            List<object> rows = ReadRelationRows(sketch);
            int status = ConstrainedStatus(sketch);
            string action = Json.Str(req, "action", "status");
            if (string.Equals(action, "list", StringComparison.OrdinalIgnoreCase)) action = "list";
            else action = "status";
            Dictionary<string, object> result = Json.Dict(
                "sketch", sketchName,
                "document", DocumentOf(doc),
                "action", action,
                "relations", rows,
                "count", rows.Count,
                "relationCount", Json.R(rows.Count),
                "constrainedStatus", Json.R(status),
                "fullyConstrained", status == 0,
                "notes", new List<object>(),
                "segments", ReadSegments(sketch).Count);
            Dictionary<string, object> audit = AuditSummary(sketch);
            result["openEnds"] = audit["openEnds"];
            result["closed"] = audit["closed"];
            return result;
        }

        static List<object> ReadRelationRows(ISketch sketch)
        {
            List<object> rows = new List<object>();
            ISketchRelationManager mgr = (ISketchRelationManager)sketch.RelationManager;
            object[] all = (object[])mgr.GetRelations(0);
            if (all == null) return rows;
            List<Seg> segs = ReadSegments(sketch);
            int index = 0;
            foreach (object raw in all)
            {
                index++;
                SketchRelation rel = raw as SketchRelation;
                if (rel == null) continue;
                int type = -1;
                try { type = rel.GetRelationType(); }
                catch (COMException) { }
                List<object> entities = new List<object>();
                object[] rawEntities = null;
                try { rawEntities = (object[])rel.GetEntities(); }
                catch (COMException) { }
                if (rawEntities != null)
                    foreach (object entity in rawEntities)
                        entities.Add(DescribeEntity(segs, entity));
                rows.Add(Json.Dict(
                    "index", Json.R(index),
                    "type", type >= 0 ? RelationName(type) : null,
                    "relationType", Json.R(type),
                    "entityCount", entities.Count,
                    "entities", entities));
            }
            return rows;
        }

        /// <summary>The audit half of a sketch report: how many closed loops it has and
        /// which endpoints are still loose. Kept next to the relations because "closed"
        /// in this codebase means "every endpoint has a co-located partner", which is a
        /// geometric claim, not a relation claim.</summary>
        static Dictionary<string, object> AuditSummary(ISketch sketch)
        {
            List<Seg> segs = ReadSegments(sketch);
            List<double[]> ends = new List<double[]>();
            int construction = 0;
            foreach (Seg seg in segs)
            {
                bool isConstruction = false;
                try { isConstruction = seg.Segment.ConstructionGeometry; }
                catch (COMException) { }
                if (isConstruction) { construction++; continue; }
                if (seg.IsLine || seg.IsArc)
                {
                    ends.Add(new[] { seg.X1, seg.Y1 });
                    ends.Add(new[] { seg.X2, seg.Y2 });
                }
            }
            const double eps = 1e-7;
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
            return Json.Dict(
                "segments", Json.R(segs.Count),
                "constructionSegments", Json.R(construction),
                "openEnds", Json.R(loose),
                "closed", loose == 0 && ends.Count > 0);
        }

        static Dictionary<string, object> DescribeEntity(List<Seg> segs, object entity)
        {
            ISketchPoint point = entity as ISketchPoint;
            if (point != null)
            {
                int index = 0, part = 0;
                MatchPoint(segs, point, out index, out part);
                Dictionary<string, object> row = Json.Dict(
                    "kind", "point",
                    "segment", Json.R(index),
                    "part", PartName(part),
                    "xMm", Json.R(point.X * 1000.0),
                    "yMm", Json.R(point.Y * 1000.0));
                if (index > 0 && part > 0) row["ref"] = "seg:" + index + ":" + PartName(part);
                return row;
            }
            ISketchSegment segment = entity as ISketchSegment;
            if (segment != null)
            {
                int index = IndexOf(segs, segment);
                return Json.Dict(
                    "kind", KindName(segment),
                    "segment", Json.R(index),
                    "ref", index > 0 ? "seg:" + index : null);
            }
            return Json.Dict("kind", "other");
        }

        static List<object> DescribeEntities(List<Seg> segs, List<object> entities)
        {
            List<object> rows = new List<object>();
            foreach (object entity in entities) rows.Add(DescribeEntity(segs, entity));
            return rows;
        }

        static string KindName(ISketchSegment segment)
        {
            try
            {
                switch (segment.GetType())
                {
                    case (int)swSketchSegments_e.swSketchLINE: return "line";
                    case (int)swSketchSegments_e.swSketchARC: return "arc";
                    case (int)swSketchSegments_e.swSketchELLIPSE: return "ellipse";
                    case (int)swSketchSegments_e.swSketchSPLINE: return "spline";
                    default: return "other";
                }
            }
            catch (COMException) { return "unreadable"; }
        }

        static int IndexOf(List<Seg> segs, ISketchSegment segment)
        {
            foreach (Seg s in segs)
                if (ReferenceEquals(s.Segment, segment)) return s.Index;
            // COM wrappers are not always reference-identical: fall back to geometry.
            // Arcs and circles need this too: without it every CONCENTRIC/TANGENT row
            // reported ref=null for its curves, and Relations.Audit then said the very
            // relation it had just read back was "not in the sketch" (measured: a
            // two-circle sketch with one CONCENTRIC landed and still scored
            // MISSING_RELATION, evaluated=0).
            try
            {
                int kind = segment.GetType();
                foreach (Seg s in segs)
                {
                    if (s.Kind != KindOf(kind)) continue;
                    if (s.IsLine && s.Segment != null)
                    {
                        ISketchLine a = (ISketchLine)s.Segment;
                        ISketchLine b = (ISketchLine)segment;
                        ISketchPoint a1 = (ISketchPoint)a.GetStartPoint2();
                        ISketchPoint b1 = (ISketchPoint)b.GetStartPoint2();
                        if (SamePoint(a1, b1, 1e-7)) return s.Index;
                    }
                    if (s.IsArc && s.Segment != null)
                    {
                        ISketchArc a = s.Segment as ISketchArc;
                        ISketchArc b = segment as ISketchArc;
                        if (a == null || b == null) continue;
                        // Centre + radius identifies an arc or circle; two concentric
                        // circles differ by radius, two tangent arcs by centre.
                        ISketchPoint ca = (ISketchPoint)a.GetCenterPoint2();
                        ISketchPoint cb = (ISketchPoint)b.GetCenterPoint2();
                        if (!SamePoint(ca, cb, 1e-7)) continue;
                        if (Math.Abs(a.GetRadius() - b.GetRadius()) > 1e-7) continue;
                        return s.Index;
                    }
                }
            }
            catch (COMException) { }
            return 0;
        }

        static int KindOf(int sketchSegmentType)
        {
            if (sketchSegmentType == (int)swSketchSegments_e.swSketchLINE) return 0;
            if (sketchSegmentType == (int)swSketchSegments_e.swSketchARC) return 1;
            return 2;
        }

        static int IndexOf(List<Seg> segs, double x, double y)
        {
            const double eps = 1e-7;
            foreach (Seg s in segs)
            {
                if ((s.IsLine || s.IsArc)
                    && Math.Abs(s.X1 - x) <= eps && Math.Abs(s.Y1 - y) <= eps) return s.Index;
                if ((s.IsLine || s.IsArc)
                    && Math.Abs(s.X2 - x) <= eps && Math.Abs(s.Y2 - y) <= eps) return s.Index;
                if (s.IsArc && Math.Abs(s.Cx - x) <= eps && Math.Abs(s.Cy - y) <= eps) return s.Index;
            }
            return 0;
        }

        static bool MatchPoint(List<Seg> segs, ISketchPoint point, out int index, out int part)
        {
            index = 0;
            part = 0;
            const double eps = 1e-7;
            foreach (Seg s in segs)
            {
                if (!s.IsLine && !s.IsArc) continue;
                if (Math.Abs(s.X1 - point.X) <= eps && Math.Abs(s.Y1 - point.Y) <= eps)
                {
                    index = s.Index;
                    part = 1;
                    return true;
                }
                if (Math.Abs(s.X2 - point.X) <= eps && Math.Abs(s.Y2 - point.Y) <= eps)
                {
                    index = s.Index;
                    part = 2;
                    return true;
                }
                if (s.IsArc && Math.Abs(s.Cx - point.X) <= eps && Math.Abs(s.Cy - point.Y) <= eps)
                {
                    index = s.Index;
                    part = 3;
                    return true;
                }
            }
            return false;
        }

        static bool SamePoint(ISketchPoint a, ISketchPoint b, double eps)
        {
            if (a == null || b == null) return false;
            return Math.Abs(a.X - b.X) <= eps && Math.Abs(a.Y - b.Y) <= eps;
        }

        // ---------------------------------------------------------------- audit

        /// <summary>Compares the relations the design asked for with the ones the sketch
        /// actually carries, and reports what is missing. <paramref name="required"/>
        /// rows are already normalised to <c>seg:&lt;index&gt;</c> form by the builder
        /// (the curve ids only exist while the sketch is being built).
        ///
        /// This is the "did the relations that matter actually land" check: a sketch can
        /// be closed and still be a picture, because closed only means the endpoints
        /// touch, not that anything holds them there.</summary>
        /// <summary>Compares the relations the design asked for with the ones the sketch
        /// actually carries, and reports what is missing. <paramref name="required"/>
        /// rows are already normalised to <c>seg:&lt;index&gt;</c> form by the builder
        /// (the curve ids only exist while the sketch is being built).
        ///
        /// This is the "did the relations that matter actually land" check: a sketch can
        /// be closed and still be a picture, because closed only means the endpoints
        /// touch, not that anything holds them there.</summary>
        public static Dictionary<string, object> Audit(ISketch sketch, string sketchName,
            List<Dictionary<string, object>> required, bool strict)
        {
            List<object> gaps = new List<object>();
            List<object> rows = ReadRelationRows(sketch);
            Dictionary<string, object> summary = AuditSummary(sketch);
            int openEnds = Convert.ToInt32(summary["openEnds"]);
            if (openEnds > 0)
            {
                gaps.Add(Json.Dict(
                    "code", "OPEN_END",
                    "kind", "openEnds",
                    "count", Json.R(openEnds),
                    "why", "the sketch still has " + openEnds + " endpoint(s) with no partner"));
            }

            List<string> present = new List<string>();
            foreach (object raw in rows)
            {
                Dictionary<string, object> row = raw as Dictionary<string, object>;
                if (row == null) continue;
                present.Add(KeyOf(Convert.ToString(row["type"]), row["entities"]));
            }

            int requiredCount = 0;
            int evaluated = 0;
            if (required != null)
            {
                foreach (Dictionary<string, object> want in required)
                {
                    requiredCount++;
                    string type = Json.Str(want, "type", Json.Str(want, "relation", null));
                    List<string> refs = new List<string>();
                    foreach (object r in Json.Items(want.ContainsKey("refs") ? want["refs"] : null))
                        if (r is string) refs.Add(NormalizeRefText((string)r));
                    string key = KeyOf(CanonicalType(type), refs);
                    if (present.Contains(key)) { evaluated++; continue; }
                    gaps.Add(Json.Dict(
                        "code", "MISSING_RELATION",
                        "kind", "missingRelation",
                        "type", type,
                        "refs", refs,
                        "index", Json.R(requiredCount),
                        "why", "relation " + type + " on " + string.Join(", ", refs.ToArray())
                            + " is not in the sketch"));
                }
            }

            int status = ConstrainedStatus(sketch);
            Dictionary<string, object> result = Json.Dict(
                "sketch", sketchName,
                "ok", gaps.Count == 0,
                "strict", strict,
                "relations", rows,
                "count", rows.Count,
                "relationCount", Json.R(rows.Count),
                "requiredCount", Json.R(requiredCount),
                "evaluated", Json.R(evaluated),
                "gaps", gaps,
                "gapCount", gaps.Count,
                "openEnds", Json.R(openEnds),
                "closed", summary["closed"],
                "constrainedStatus", Json.R(status),
                "fullyConstrained", status == 0);
            if (strict && gaps.Count > 0)
                throw new BridgeError("RELATION_AUDIT_FAILED",
                    "sketch \"" + (sketchName ?? "?") + "\" has " + gaps.Count
                    + " relation gap(s); strict mode refuses to hand it over",
                    Json.Dict("audit", result));
            return result;
        }

        /// <summary>Read-only view of the sketch for callers that do not want the
        /// audit's pass/fail semantics (the builder reports what it built).</summary>
        public static Dictionary<string, object> Summary(ISketch sketch)
        {
            return AuditSummary(sketch);
        }

        public static List<object> Rows(ISketch sketch)
        {
            return ReadRelationRows(sketch);
        }

        /// <summary>Describes one COM entity (segment or point) as the wire row
        /// {kind, segment, part, ref, xMm, yMm}. The builder uses it to turn the
        /// entities it just constrained into audit references.</summary>
        public static Dictionary<string, object> Describe(ISketch sketch, object entity)
        {
            return DescribeEntity(ReadSegments(sketch), entity);
        }

        public static string TypeName(int type)
        {
            return RelationName(type);
        }

        static string CanonicalType(string name)
        {
            int type;
            return TryRelationType(name, out type) ? RelationName(type) : name;
        }

        static string NormalizeRefText(string text)
        {
            try { return ParseRef(text).Canonical; }
            catch (BridgeError) { return text; }
        }

        static string KeyOf(string type, object entities)
        {
            List<string> parts = new List<string>();
            foreach (object raw in Json.Items(entities))
            {
                Dictionary<string, object> row = raw as Dictionary<string, object>;
                string refText = row != null ? Json.Str(row, "ref", null) : raw as string;
                if (refText != null) parts.Add(NormalizeRefText(refText));
            }
            parts.Sort(StringComparer.Ordinal);
            return (type ?? "?") + "|" + string.Join(",", parts.ToArray());
        }

        // -------------------------------------------------------------- inference

        /// <summary>Infers relations and, for "apply", adds them.
        ///
        /// Order matters: coincidence first (it merges the endpoints so later
        /// tangency and equality tests see one shape), then the directional
        /// relations, then tangency and equality.</summary>
        static Dictionary<string, object> Infer(SwHost h, Dictionary<string, object> req, bool apply)
        {
            double tol = Mm(Json.Dbl(req, "tolerance", 0.02));
            string sketchName;
            IModelDoc2 doc;
            ISketch sketch = GetSketch(h, Json.Str(req, "designId", null), Json.Str(req, "sketch", null),
                out sketchName, out doc);
            if (sketch == null) throw new BridgeError("NO_SKETCH", "no sketch to read relations from");

            List<Seg> segs = ReadSegments(sketch);
            if (segs.Count == 0) throw new BridgeError("EMPTY_SKETCH", "this sketch has no segments");

            List<Dictionary<string, object>> candidates = new List<Dictionary<string, object>>();
            candidates.AddRange(Coinident(segs, tol));
            candidates.AddRange(Directional(segs, tol));
            candidates.AddRange(Tangency(segs, tol));
            candidates.AddRange(Concentric(segs, tol));
            candidates.AddRange(Equal(segs, tol));

            ISketchRelationManager mgr = (ISketchRelationManager)sketch.RelationManager;
            List<Dictionary<string, object>> accepted = new List<Dictionary<string, object>>();
            List<Dictionary<string, object>> rejected = new List<Dictionary<string, object>>();
            bool skipAllowed = Json.Bool(req, "skipAllowedCheck", false);

            foreach (Dictionary<string, object> c in candidates)
            {
                int type = (int)c["relationType"];
                object[] entities = (object[])c["entities"];
                if (!apply)
                {
                    if (Allowed(mgr, entities, type, skipAllowed, out _unused))
                        accepted.Add(c);
                    else
                    {
                        c["why"] = "SOLIDWORKS does not allow this relation on that selection";
                        rejected.Add(c);
                    }
                    continue;
                }
                RelationOutcome outcome = ApplyType(doc, sketch, type, entities, skipAllowed);
                if (outcome.Ok)
                {
                    if (outcome.ViaFallback) c["fallback"] = true;
                    accepted.Add(c);
                }
                else
                {
                    c["why"] = outcome.Why;
                    rejected.Add(c);
                }
            }

            int status = ConstrainedStatus(sketch);
            return Json.Dict(
                "sketch", sketchName,
                "document", DocumentOf(doc),
                "applied", apply,
                "toleranceMm", Json.R(tol * 1000.0),
                "segments", Json.R(segs.Count),
                "candidates", Json.R(candidates.Count),
                "accepted", accepted.Count,
                "rejected", rejected.Count,
                "relations", accepted,
                "skipped", rejected,
                "constrainedStatus", Json.R(status),
                "fullyConstrained", status == 0,
                "byType", CountByType(accepted));
        }

        static string _unused;

        /// <summary>Coincident endpoints: the single most valuable relation, because
        /// it is what turns four loose lines into a closed loop the extrusion can use.</summary>
        static IEnumerable<Dictionary<string, object>> Coinident(List<Seg> segs, double tol)
        {
            for (int i = 0; i < segs.Count; i++)
                for (int j = i + 1; j < segs.Count; j++)
                {
                    double[][] a = { new[] { segs[i].X1, segs[i].Y1 }, new[] { segs[i].X2, segs[i].Y2 } };
                    double[][] b = { new[] { segs[j].X1, segs[j].Y1 }, new[] { segs[j].X2, segs[j].Y2 } };
                    for (int ai = 0; ai < 2; ai++)
                        for (int bi = 0; bi < 2; bi++)
                        {
                            if (Dist(a[ai], b[bi]) > tol) continue;
                            yield return Candidate("COINCIDENT",
                                (int)swConstraintType_e.swConstraintType_COINCIDENT,
                                new object[] { Endpoint(segs[i], ai), Endpoint(segs[j], bi) },
                                "segments " + segs[i].Index + " and " + segs[j].Index
                                + " share an endpoint");
                        }
                }
        }

        static IEnumerable<Dictionary<string, object>> Directional(List<Seg> segs, double tol)
        {
            foreach (Seg s in segs)
            {
                if (!s.IsLine) continue;
                double dx = s.X2 - s.X1, dy = s.Y2 - s.Y1;
                if (Math.Abs(dy) <= tol)
                    yield return Candidate("HORIZONTAL",
                        (int)swConstraintType_e.swConstraintType_HORIZONTAL,
                        new object[] { s.Segment }, "line " + s.Index + " is horizontal");
                if (Math.Abs(dx) <= tol)
                    yield return Candidate("VERTICAL",
                        (int)swConstraintType_e.swConstraintType_VERTICAL,
                        new object[] { s.Segment }, "line " + s.Index + " is vertical");
            }

            for (int i = 0; i < segs.Count; i++)
            {
                if (!segs[i].IsLine) continue;
                for (int j = i + 1; j < segs.Count; j++)
                {
                    if (!segs[j].IsLine) continue;
                    double a1 = Math.Atan2(segs[i].Y2 - segs[i].Y1, segs[i].X2 - segs[i].X1);
                    double a2 = Math.Atan2(segs[j].Y2 - segs[j].Y1, segs[j].X2 - segs[j].X1);
                    double diff = Math.Abs(Normalize(a1 - a2));
                    double deg = diff * 180.0 / Math.PI;
                    if (deg <= 0.2 || Math.Abs(deg - 180.0) <= 0.2)
                        yield return Candidate("PARALLEL",
                            (int)swConstraintType_e.swConstraintType_PARALLEL,
                            new object[] { segs[i].Segment, segs[j].Segment },
                            "lines " + segs[i].Index + " and " + segs[j].Index + " are parallel");
                    if (Math.Abs(deg - 90.0) <= 0.2)
                        yield return Candidate("PERPENDICULAR",
                            (int)swConstraintType_e.swConstraintType_PERPENDICULAR,
                            new object[] { segs[i].Segment, segs[j].Segment },
                            "lines " + segs[i].Index + " and " + segs[j].Index + " meet at a right angle");
                }
            }
        }

        /// <summary>Tangency between a line and an arc, or between two arcs.
        /// The test is geometric rather than clever: the distance from the arc centre
        /// to the line equals the radius, or the centre distance equals the sum or
        /// difference of the radii.</summary>
        static IEnumerable<Dictionary<string, object>> Tangency(List<Seg> segs, double tol)
        {
            for (int i = 0; i < segs.Count; i++)
                for (int j = 0; j < segs.Count; j++)
                {
                    if (i == j) continue;
                    Seg line = segs[i], arc = segs[j];
                    if (!line.IsLine || !arc.IsArc) continue;
                    double d = PointLineDistance(arc.Cx, arc.Cy, line);
                    if (Math.Abs(d - arc.R) <= tol)
                        yield return Candidate("TANGENT",
                            (int)swConstraintType_e.swConstraintType_TANGENT,
                            new object[] { line.Segment, arc.Segment },
                            "line " + line.Index + " touches arc " + arc.Index);
                }

            for (int i = 0; i < segs.Count; i++)
                for (int j = i + 1; j < segs.Count; j++)
                {
                    if (!segs[i].IsArc || !segs[j].IsArc) continue;
                    double d = Math.Sqrt(Sq(segs[i].Cx - segs[j].Cx) + Sq(segs[i].Cy - segs[j].Cy));
                    bool external = Math.Abs(d - (segs[i].R + segs[j].R)) <= tol;
                    bool internalTouch = Math.Abs(d - Math.Abs(segs[i].R - segs[j].R)) <= tol;
                    if (external || internalTouch)
                        yield return Candidate("TANGENT",
                            (int)swConstraintType_e.swConstraintType_TANGENT,
                            new object[] { segs[i].Segment, segs[j].Segment },
                            "arcs " + segs[i].Index + " and " + segs[j].Index + " touch");
                }
        }

        static IEnumerable<Dictionary<string, object>> Concentric(List<Seg> segs, double tol)
        {
            for (int i = 0; i < segs.Count; i++)
                for (int j = i + 1; j < segs.Count; j++)
                {
                    if (!segs[i].IsArc || !segs[j].IsArc) continue;
                    if (Math.Abs(segs[i].Cx - segs[j].Cx) > tol) continue;
                    if (Math.Abs(segs[i].Cy - segs[j].Cy) > tol) continue;
                    if (Math.Abs(segs[i].R - segs[j].R) <= tol) continue; // same circle, not concentric pair
                    yield return Candidate("CONCENTRIC",
                        (int)swConstraintType_e.swConstraintType_CONCENTRIC,
                        new object[] { segs[i].Segment, segs[j].Segment },
                        "arcs " + segs[i].Index + " and " + segs[j].Index + " share a centre");
                }
        }

        static IEnumerable<Dictionary<string, object>> Equal(List<Seg> segs, double tol)
        {
            for (int i = 0; i < segs.Count; i++)
                for (int j = i + 1; j < segs.Count; j++)
                {
                    if (segs[i].IsLine != segs[j].IsLine) continue;
                    if (segs[i].IsArc)
                    {
                        if (Math.Abs(segs[i].R - segs[j].R) > tol) continue;
                        if (Math.Abs(segs[i].Cx - segs[j].Cx) <= tol
                            && Math.Abs(segs[i].Cy - segs[j].Cy) <= tol) continue;
                        yield return Candidate("EQUAL",
                            (int)swConstraintType_e.swConstraintType_SAMELENGTH,
                            new object[] { segs[i].Segment, segs[j].Segment },
                            "arcs " + segs[i].Index + " and " + segs[j].Index + " have equal radius");
                    }
                    else
                    {
                        if (Math.Abs(segs[i].Length - segs[j].Length) > tol) continue;
                        yield return Candidate("EQUAL",
                            (int)swConstraintType_e.swConstraintType_SAMELENGTH,
                            new object[] { segs[i].Segment, segs[j].Segment },
                            "lines " + segs[i].Index + " and " + segs[j].Index + " are equal length");
                    }
                }
        }

        // ---------------------------------------------------------------- helpers

        static Dictionary<string, object> Candidate(string name, int type, object[] entities, string why)
        {
            return Json.Dict("relation", name, "relationType", Json.R(type),
                "entities", entities, "why", why);
        }

        static object Endpoint(Seg s, int which)
        {
            try
            {
                if (s.IsLine)
                {
                    ISketchLine line = (ISketchLine)s.Segment;
                    return which == 0 ? line.GetStartPoint2() : line.GetEndPoint2();
                }
                ISketchArc arc = (ISketchArc)s.Segment;
                return which == 0 ? arc.GetStartPoint2() : arc.GetEndPoint2();
            }
            catch (Exception)
            {
                return s.Segment;
            }
        }

        static List<Seg> ReadSegments(ISketch sketch)
        {
            List<Seg> result = new List<Seg>();
            object[] raw = (object[])sketch.GetSketchSegments();
            if (raw == null) return result;
            int index = 0;
            foreach (object item in raw)
            {
                index++;
                ISketchSegment seg = item as ISketchSegment;
                if (seg == null) continue;
                Seg s = new Seg { Index = index, Segment = seg };
                try
                {
                    int kind = seg.GetType();
                    if (kind == (int)swSketchSegments_e.swSketchLINE)
                    {
                        ISketchLine line = (ISketchLine)seg;
                        s.Kind = 0;
                        ISketchPoint a = (ISketchPoint)line.GetStartPoint2();
                        ISketchPoint b = (ISketchPoint)line.GetEndPoint2();
                        s.X1 = a.X; s.Y1 = a.Y; s.X2 = b.X; s.Y2 = b.Y;
                    }
                    else if (kind == (int)swSketchSegments_e.swSketchARC)
                    {
                        ISketchArc arc = (ISketchArc)seg;
                        s.Kind = 1;
                        ISketchPoint a = (ISketchPoint)arc.GetStartPoint2();
                        ISketchPoint b = (ISketchPoint)arc.GetEndPoint2();
                        ISketchPoint c = (ISketchPoint)arc.GetCenterPoint2();
                        s.X1 = a.X; s.Y1 = a.Y; s.X2 = b.X; s.Y2 = b.Y;
                        s.Cx = c.X; s.Cy = c.Y; s.R = arc.GetRadius();
                    }
                    else { s.Kind = 2; }
                }
                catch (Exception) { s.Kind = 3; }
                result.Add(s);
            }
            return result;
        }

        // 写尺寸用的「先进编辑态」入口曾经在这里暴露过一份公开包装（GetSketchForWrite /
        // EndWrite），但 SketchDimensioner 用的是它自己的 EnsureEditMode：两套并行的
        // 「进草图再写」实现迟早会漂移，而漂移的表现恰恰是「有的写动作进得去、有的进不去」。
        // 那对没人调的包装已经删掉，只留真正在用的 EnsureEditing / LeaveEditing 组合
        // （Mutate 与下面 GetSketch 的两处调用）。
        /// <summary>Resolves the document a relations request means, then the sketch
        /// inside it.
        ///
        /// The designId path is not optional: a worker creates a new <see cref="SwHost"/>
        /// for every request, so <c>h.Doc</c> is null and the old code threw
        /// <c>NO_DOCUMENT</c> even with the right part on screen. Resolution goes
        /// through the same registry lookup every other operation uses.</summary>
        public static ISketch GetSketch(SwHost h, string designId, string name,
            out string resolvedName, out IModelDoc2 doc)
        {
            resolvedName = name;
            // A2：这条以前 doc == null 就退回前台。relations 是**写**关系/改草图的入口，
            // 猜错文档等于把关系加到用户正在画的草图里。没给 designId 直接报错。
            doc = Operations.RequireDesignDocument(h, designId, "relations");
            if (doc == null) throw new BridgeError("NO_DOCUMENT", "no document for this relations request");

            IFeature want = null;
            IFeature feat = (IFeature)doc.FirstFeature();
            IFeature lastSketch = null;
            while (feat != null)
            {
                if (feat.GetTypeName2() == "ProfileFeature")
                {
                    if (name == null || feat.Name == name) lastSketch = feat;
                    if (name != null && feat.Name == name) break;
                }
                feat = (IFeature)feat.GetNextFeature();
            }
            want = lastSketch;
            if (want != null) resolvedName = want.Name;
            if (want == null)
            {
                string message = name == null
                    ? "this document has no sketch yet"
                    : "no sketch named \"" + name + "\" in this document";
                throw new BridgeError("NO_SKETCH", message);
            }
            return (ISketch)want.GetSpecificFeature2();
        }

        public static Dictionary<string, object> DocumentOf(IModelDoc2 doc)
        {
            if (doc == null) return null;
            string title = null, path = null;
            try { title = doc.GetTitle(); } catch (COMException) { }
            try { path = doc.GetPathName(); } catch (COMException) { }
            return Json.Dict("title", title, "path", path,
                "saved", !string.IsNullOrEmpty(path));
        }

        /// <summary>Finds the sketch feature by name so the sketch can be entered for
        /// editing. GetSketch already walks this list; that one returns the ISketch
        /// because most reads only need it, while writes need the feature too.</summary>
        static IFeature FindSketchFeature(IModelDoc2 doc, string name)
        {
            IFeature found = null;
            IFeature feat = (IFeature)doc.FirstFeature();
            while (feat != null)
            {
                if (feat.GetTypeName2() == "ProfileFeature")
                {
                    if (name == null || feat.Name == name) found = feat;
                    if (name != null && feat.Name == name) break;
                }
                feat = (IFeature)feat.GetNextFeature();
            }
            return found;
        }

        /// <summary>Puts the target sketch into sketch-edit mode.
        ///
        /// Measured on the live build: with the sketch closed, AddRelation returns null
        /// and nothing can be selected, so every write reported "SOLIDWORKS does not
        /// allow" or "rejected" for a relation the UI takes without complaint. Returns
        /// true when this call opened the sketch, so the caller can close it again.</summary>
        static bool EnsureEditing(IModelDoc2 doc, string sketchName, ref ISketch sketch, List<string> notes)
        {
            IFeature active = null;
            try { active = (IFeature)doc.GetActiveSketch(); }
            catch (COMException) { }
            if (active != null && string.Equals(active.Name, sketchName, StringComparison.OrdinalIgnoreCase))
                return false;

            IFeature want = FindSketchFeature(doc, sketchName);
            if (want == null)
                throw new BridgeError("NO_SKETCH", "no sketch named \"" + sketchName + "\" in this document");
            try { doc.ClearSelection2(true); } catch (COMException) { }
            bool selected = false;
            try { selected = want.Select2(false, 0); } catch (COMException) { }
            if (!selected)
                throw new BridgeError("SKETCH_NOT_EDITABLE",
                    "could not select the feature for sketch \"" + sketchName + "\" to edit its relations",
                    Json.Dict("sketch", sketchName));
            try { doc.EditSketch(); }
            catch (COMException ex)
            {
                throw new BridgeError("SKETCH_NOT_EDITABLE",
                    "entering sketch \"" + sketchName + "\" failed with COM 0x"
                    + ex.HResult.ToString("X8"),
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
            sketch = (ISketch)reopened.GetSpecificFeature2();
            notes.Add("entered sketch-edit mode for \"" + sketchName + "\" (relations are written there)");
            return true;
        }

        /// <summary>Closes the sketch-edit mode this bridge opened, so the document is
        /// handed back the way it was found.</summary>
        static void LeaveEditing(IModelDoc2 doc, bool openedByUs)
        {
            if (!openedByUs || doc == null) return;
            try
            {
                ISketchManager sketchManager = doc.SketchManager;
                if (sketchManager != null) sketchManager.InsertSketch(true);
            }
            catch (COMException) { }
        }

        // ------------------------------------------------------------ public API

        /// <summary>Resolves one reference against the curves a build plan just drew:
        /// <c>"arc1"</c>, <c>"arc1:center"</c>, <c>"line1:start"</c>, <c>"pt1"</c>.
        /// The point forms are what "the centre of this arc lies on the other arc"
        /// is spelled with.</summary>
        public static bool TryCurveEntity(Dictionary<string, CurveResult> curves, string text,
            out object entity, out string error)
        {
            entity = null;
            error = null;
            if (curves == null || curves.Count == 0)
            {
                error = "this sketch has no named curves to reference";
                return false;
            }
            Ref r;
            try { r = ParseRef(text); }
            catch (BridgeError be) { error = be.Message; return false; }
            string id = r.CurveId;
            if (id == null && r.Index > 0) id = r.Index.ToString(CultureInfo.InvariantCulture);
            if (id == null)
            {
                error = "reference \"" + text + "\" does not name a curve id";
                return false;
            }
            CurveResult curve;
            if (!curves.TryGetValue(id, out curve))
            {
                List<string> ids = new List<string>(curves.Keys);
                error = "curve \"" + id + "\" is not declared in this sketch (declared: "
                    + string.Join(", ", ids.ToArray()) + ")";
                return false;
            }
            if (r.Part == 0)
            {
                if (curve.Segments.Count == 1) { entity = curve.Segments[0]; return true; }
                if (curve.Segments.Count > 1)
                {
                    error = "curve \"" + id + "\" is made of " + curve.Segments.Count
                        + " segments; name one with :start or :end";
                    return false;
                }
                if (curve.Points.Count == 1) { entity = curve.Points[0]; return true; }
                error = "curve \"" + id + "\" produced no selectable geometry";
                return false;
            }
            ISketchPoint point;
            string why;
            if (!CurvePoint(curve, r.Part, out point, out why))
            {
                error = id + ":" + PartName(r.Part) + ": " + why;
                return false;
            }
            entity = point;
            return true;
        }

        static bool CurvePoint(CurveResult curve, int part, out ISketchPoint point, out string error)
        {
            point = null;
            error = null;
            if (curve.Points.Count == 1 && curve.Segments.Count == 0)
            {
                if (part == 3) { point = curve.Points[0]; return true; }
                error = "a point curve has no start or end; refer to it by its id";
                return false;
            }
            if (curve.Segments.Count == 0)
            {
                error = "the curve produced no segments";
                return false;
            }
            if (curve.Segments.Count > 1)
            {
                error = "the curve produced " + curve.Segments.Count
                    + " segments; use a single-segment curve for a point reference";
                return false;
            }
            ISketchSegment seg = curve.Segments[0];
            try
            {
                int kind = seg.GetType();
                if (part == 3)
                {
                    if (kind == (int)swSketchSegments_e.swSketchARC)
                        point = (ISketchPoint)((ISketchArc)seg).GetCenterPoint2();
                    else if (kind == (int)swSketchSegments_e.swSketchELLIPSE)
                        point = (ISketchPoint)((ISketchEllipse)seg).GetCenterPoint2();
                    else
                    {
                        error = "only arcs, circles and ellipses have a centre point";
                        return false;
                    }
                }
                else if (kind == (int)swSketchSegments_e.swSketchLINE)
                {
                    ISketchLine line = (ISketchLine)seg;
                    point = (ISketchPoint)(part == 1 ? line.GetStartPoint2() : line.GetEndPoint2());
                }
                else if (kind == (int)swSketchSegments_e.swSketchARC)
                {
                    ISketchArc arc = (ISketchArc)seg;
                    point = (ISketchPoint)(part == 1 ? arc.GetStartPoint2() : arc.GetEndPoint2());
                }
                else if (kind == (int)swSketchSegments_e.swSketchELLIPSE)
                {
                    ISketchEllipse ellipse = (ISketchEllipse)seg;
                    point = (ISketchPoint)(part == 1 ? ellipse.GetStartPoint2() : ellipse.GetEndPoint2());
                }
                else if (kind == (int)swSketchSegments_e.swSketchSPLINE)
                {
                    object[] pts = (object[])((ISketchSpline)seg).GetPoints2();
                    if (pts == null || pts.Length == 0) { error = "spline has no readable points"; return false; }
                    point = (ISketchPoint)(part == 1 ? pts[0] : pts[pts.Length - 1]);
                }
                else
                {
                    error = "this segment type has no readable point";
                    return false;
                }
            }
            catch (COMException ex)
            {
                error = "SOLIDWORKS refused the point (COM 0x" + ex.HResult.ToString("X8") + ")";
                return false;
            }
            if (point == null) { error = "SOLIDWORKS returned no point"; return false; }
            return true;
        }

        /// <summary>Resolves a seg:&lt;index&gt;[:part] reference against a live sketch,
        /// for callers outside this class (the dimensions op).</summary>
        public static bool TryEntity(ISketch sketch, string text, out object entity, out string error)
        {
            entity = null;
            error = null;
            Ref r;
            try { r = ParseRef(text); }
            catch (BridgeError be) { error = be.Message; return false; }
            Entity resolved;
            if (!TryResolve(ReadSegments(sketch), r, out resolved, out error)) return false;
            entity = resolved.Com;
            return true;
        }

        public static bool IsKnownRelationType(string name)
        {
            int type;
            return TryRelationType(name, out type);
        }

        public static string KnownTypes()
        {
            return KnownTypeNames();
        }

        public static bool IsCurveIdText(string text)
        {
            return IsCurveId(text);
        }

        public static int ConstraintStatus(ISketch sketch)
        {
            return ConstrainedStatus(sketch);
        }

        /// <summary>Finds a sketch feature by name; with no name, the last sketch in
        /// the tree. Used by the dimensions op, which needs the feature (dimensions
        /// hang off it) and not just the ISketch.</summary>
        public static IFeature SketchFeature(IModelDoc2 doc, string name)
        {
            if (doc == null) return null;
            IFeature found = null;
            IFeature feat = (IFeature)doc.FirstFeature();
            while (feat != null)
            {
                string type = null;
                try { type = feat.GetTypeName2(); }
                catch (COMException) { }
                if (type == "ProfileFeature")
                {
                    string featName = null;
                    try { featName = feat.Name; }
                    catch (COMException) { }
                    if (name == null || featName == name) found = feat;
                    if (name != null && featName == name) return feat;
                }
                feat = (IFeature)feat.GetNextFeature();
            }
            return found;
        }

        public static string PartLabel(int part)
        {
            return PartName(part);
        }

        static double PointLineDistance(double px, double py, Seg line)
        {
            double dx = line.X2 - line.X1, dy = line.Y2 - line.Y1;
            double len = Math.Sqrt(dx * dx + dy * dy);
            if (len < 1e-12) return double.MaxValue;
            return Math.Abs(dy * (px - line.X1) - dx * (py - line.Y1)) / len;
        }

        static double Dist(double[] a, double[] b)
        {
            return Math.Sqrt(Sq(a[0] - b[0]) + Sq(a[1] - b[1]));
        }

        static double Sq(double v) { return v * v; }

        static double Normalize(double angle)
        {
            while (angle > Math.PI) angle -= 2 * Math.PI;
            while (angle < -Math.PI) angle += 2 * Math.PI;
            return angle;
        }

        static double Mm(double mm) { return SwHost.ToMeters(mm); }

        static Dictionary<string, object> CountByType(List<Dictionary<string, object>> rows)
        {
            Dictionary<string, object> counts = new Dictionary<string, object>();
            foreach (Dictionary<string, object> row in rows)
            {
                string key = Json.Str(row, "relation", "?");
                object existing;
                counts.TryGetValue(key, out existing);
                counts[key] = (existing == null ? 0 : Convert.ToInt32(existing)) + 1;
            }
            return counts;
        }
    }
}
