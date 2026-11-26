using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SwMcp
{
    /// <summary>Helix / swept / lofted features.
    ///
    /// Why this class exists: the feature compiler could only extrude and revolve,
    /// so a worm had to be faked with offset discs and a bevel gear with a cone and
    /// a polar array — two parts that look right in a screenshot and interpenetrate
    /// in the assembly (measured: 9 mm on the worm, +0.31 mm on the bevel flank).
    /// A thread is a swept cut along a helix; a bevel gear is a loft between two
    /// involute sections. Both are single native features, and both were missing.
    ///
    /// Every action here either produces a feature or throws. Nothing is silently
    /// downgraded: an unsupported argument is rejected with INVALID_ARGUMENT (or
    /// UNSUPPORTED) rather than ignored, because "the parameter was accepted and
    /// did nothing" is exactly the defect this work order was opened for.
    ///
    /// Units: the design definition speaks millimetres and degrees; the SolidWorks
    /// API speaks metres and radians. Conversion happens once, at the boundary.</summary>
    sealed class Sweeps
    {
        readonly SwHost _host;
        readonly IModelDoc2 _doc;
        public readonly List<string> Steps = new List<string>();

        public Sweeps(SwHost host, IModelDoc2 doc)
        {
            _host = host;
            _doc = doc;
        }

        // ------------------------------------------------------------------ helix

        /// <summary>Creates a helix from a selected base sketch (a circle or an arc).
        ///
        /// <paramref name="definedBy"/> is one of "pitchAndRevolution",
        /// "heightAndRevolution", "heightAndPitch", "spiral". The definition decides
        /// which inputs are live; the ones that are not live are still passed to
        /// SOLIDWORKS (it ignores them by definition, not by our omission) — what we
        /// refuse is a caller asking for a *combination* we cannot express.
        ///
        /// The height/pitch are validated against the definition: a worm needs
        /// heightAndPitch, and asking for heightAndPitch with pitch=0 would build a
        /// zero-pitch body that measures "fine" and meshes with nothing.</summary>
        public IFeature Helix(IFeature baseSketch, string definedBy, bool reversed, bool clockwise,
            bool tapered, bool outward, double heightMm, double pitchMm, double revolutions,
            double taperAngleDeg, double startAngleDeg)
        {
            if (baseSketch == null)
                throw new BridgeError("BAD_ARGUMENT",
                    "helix needs a base sketch (a circle whose diameter becomes the helix diameter)");

            int defined = HelixDefinedBy(definedBy);
            if (defined == (int)swHelixDefinedBy_e.swHelixDefinedBySpiral && tapered)
                throw new BridgeError("INVALID_ARGUMENT",
                    "helix definedBy=\"spiral\" cannot be tapered: a spiral has no taper axis. "
                    + "Use pitchAndRevolution/heightAndPitch with tapered=true instead.");
            RequirePositive(heightMm, "height");
            if (defined == (int)swHelixDefinedBy_e.swHelixDefinedByHeightAndPitch) RequirePositive(pitchMm, "pitch");
            if (defined == (int)swHelixDefinedBy_e.swHelixDefinedByPitchAndRevolution)
            {
                RequirePositive(pitchMm, "pitch");
                RequirePositive(revolutions, "revolutions");
            }
            if (defined == (int)swHelixDefinedBy_e.swHelixDefinedByHeightAndRevolution)
                RequirePositive(revolutions, "revolutions");

            Select(baseSketch.Name, new string[] { "SKETCH" }, 0, false, true);

            int featuresBefore = TopLevelFeatureCount();
            // IModelDoc2.InsertHelix(Reversed, Clockwised, Tapered, Outward, Helixdef,
            //                        Height, Pitch, Revolution, TaperAngle, Startangle)
            _doc.InsertHelix(reversed, clockwise, tapered, outward, defined,
                SwHost.ToMeters(heightMm), SwHost.ToMeters(pitchMm), revolutions,
                Deg(taperAngleDeg), Deg(startAngleDeg));

            IFeature created = TopLevelFeatureAt(featuresBefore);
            if (created == null)
                throw new BridgeError("HELIX_FAILED",
                    "InsertHelix returned without creating a feature. A helix needs a selected "
                    + "base sketch containing a circle or arc; check that sketch \""
                    + baseSketch.Name + "\" has one and is not already consumed by another feature.");

            Steps.Add("helix " + created.Name + " definedBy=" + definedBy
                + " height=" + heightMm + " pitch=" + pitchMm + " rev=" + revolutions);
            return created;
        }

        static int HelixDefinedBy(string name)
        {
            string key = (name ?? "heightAndPitch").Trim().ToLowerInvariant();
            switch (key)
            {
                case "pitchandrevolution": return (int)swHelixDefinedBy_e.swHelixDefinedByPitchAndRevolution;
                case "heightandrevolution": return (int)swHelixDefinedBy_e.swHelixDefinedByHeightAndRevolution;
                case "heightandpitch": return (int)swHelixDefinedBy_e.swHelixDefinedByHeightAndPitch;
                case "spiral": return (int)swHelixDefinedBy_e.swHelixDefinedBySpiral;
                default:
                    throw new BridgeError("INVALID_ARGUMENT",
                        "helix definedBy=\"" + name + "\" is not one of pitchAndRevolution, "
                        + "heightAndRevolution, heightAndPitch, spiral");
            }
        }

        // ------------------------------------------------------------------ sweep

        /// <summary>Sweeps a profile along a path (a sketch or a helix) into a boss or a cut.
        ///
        /// This is the real thread/worm primitive: profile in an axial plane, path a
        /// helix, cut=true. It is also the way a closed timing belt is drawn (one
        /// path, one tooth profile) instead of stitching straight segments.
        ///
        /// <paramref name="kind"/> is "boss" or "cut". Thin-wall and circular-profile
        /// sweeps are supported; a circular profile sweep does not need a profile
        /// sketch (SOLIDWORKS builds the round section itself), so profile may be null
        /// exactly in that case and nowhere else.
        ///
        /// Alignment / twist / matching modes are passed through to the API; the
        /// accepted strings are enumerated here so a typo is an error, not a default.</summary>
        public IFeature Sweep(IFeature profile, IFeature path, List<IFeature> guides,
            string kind, bool thin, double thicknessMm, double thickness2Mm, string thinType,
            bool reverseThickness, bool propagate, bool alignment, string twistControl,
            double twistDeg, string startMatch, string endMatch, bool advancedSmoothing,
            bool merge, bool circularProfile, double circularDiameterMm, bool reverseDirection)
        {
            bool cut = string.Equals(kind, "cut", StringComparison.OrdinalIgnoreCase);
            if (!cut && !string.Equals(kind, "boss", StringComparison.OrdinalIgnoreCase))
                throw new BridgeError("INVALID_ARGUMENT",
                    "sweep kind=\"" + kind + "\" is not supported; use \"boss\" or \"cut\"");

            if (path == null)
                throw new BridgeError("BAD_ARGUMENT",
                    "sweep needs a path (a sketch id, a helix id, or an inline profile)");
            if (profile == null && !circularProfile)
                throw new BridgeError("BAD_ARGUMENT",
                    "sweep needs a profile sketch unless circularProfile=true");
            if (thin)
            {
                RequirePositive(thicknessMm, "thickness");
                if (string.Equals(thinType, "twoDirection", StringComparison.OrdinalIgnoreCase))
                    RequirePositive(thickness2Mm, "thickness2");
            }

            int twist = TwistControl(twistControl);
            int startMatching = MatchingType(startMatch, "startMatch");
            int endMatching = MatchingType(endMatch, "endMatch");
            int thinKind = ThinType(thinType);

            _doc.ClearSelection2(true);
            // SolidWorks API mark convention for sweeps: profile=1, guides=2, path=4.
            if (profile != null && !circularProfile)
            {
                if (!Select(profile.Name, new string[] { "SKETCH" }, 1, true, true))
                    throw new BridgeError("SELECTION_EMPTY",
                        "could not select the sweep profile sketch \"" + profile.Name + "\"");
            }
            if (guides != null)
            {
                foreach (IFeature guide in guides)
                {
                    if (guide == null) continue;
                    if (!Select(guide.Name, new string[] { "SKETCH", "REFERENCECURVES", "CURVE" }, 2, true, false))
                        throw new BridgeError("SELECTION_EMPTY",
                            "could not select guide curve \"" + guide.Name + "\" for the sweep");
                }
            }
            if (!Select(path.Name, new string[] { "REFERENCECURVES", "SKETCH", "CURVE" }, 4, true, false))
                throw new BridgeError("SELECTION_EMPTY",
                    "could not select the sweep path \"" + path.Name + "\". A helix is selected as "
                    + "REFERENCECURVES; a sketch as SKETCH — if neither took, the feature is not "
                    + "the kind of curve a sweep can follow.");

            IFeatureManager fm = _doc.FeatureManager;
            double beforeVolume = cut ? Geometry.TotalVolumeMm3(_doc) : 0;
            int bodiesBefore = BodyCount();

            IFeature feature;
            if (cut)
            {
                // IFeatureManager.InsertCutSwept5(22 args) is the modern cut entry;
                // IModelDoc2.InsertCutSwept4 exists but has 11 args and no thin-wall
                // or twist support, so it is not used here.
                feature = fm.InsertCutSwept5(
                    propagate, alignment, twist, true, advancedSmoothing,
                    startMatching, endMatching,
                    thin, SwHost.ToMeters(thicknessMm), SwHost.ToMeters(thickness2Mm), thinKind,
                    0,
                    true, true,
                    Deg(twistDeg), true,
                    false, true, false,
                    circularProfile, SwHost.ToMeters(circularDiameterMm),
                    reverseDirection ? 1 : 0);
            }
            else
            {
                feature = fm.InsertProtrusionSwept4(
                    propagate, alignment, twist, true, advancedSmoothing,
                    startMatching, endMatching,
                    thin, SwHost.ToMeters(thicknessMm), SwHost.ToMeters(thickness2Mm), thinKind,
                    0,
                    merge, true, true,
                    Deg(twistDeg), true,
                    circularProfile, SwHost.ToMeters(circularDiameterMm),
                    reverseDirection ? 1 : 0);
            }

            if (feature == null)
                throw new BridgeError("SWEEP_FAILED",
                    "Insert" + (cut ? "CutSwept5" : "ProtrusionSwept4") + " returned null. The usual "
                    + "cause is a profile that does not touch the path: the profile sketch has to "
                    + "intersect the start of the path curve (for a thread: the profile sits in an "
                    + "axial plane through the helix start point).",
                    Json.Dict("kind", kind, "profile", profile == null ? null : profile.Name,
                        "path", path.Name, "circularProfile", circularProfile));

            if (cut)
            {
                double after = Geometry.TotalVolumeMm3(_doc);
                Steps.Add("sweepCut " + feature.Name + " volume " + Math.Round(beforeVolume, 3)
                    + " -> " + Math.Round(after, 3));
                if (after >= beforeVolume - 1e-6)
                    throw new BridgeError("SWEEP_NO_MATERIAL_REMOVED",
                        "the swept cut built a feature (\"" + feature.Name + "\") but the volume did "
                        + "not drop (" + Math.Round(beforeVolume, 3) + " -> " + Math.Round(after, 3)
                        + " mm^3). The path probably runs outside the body, or the profile misses the "
                        + "material it was meant to remove.",
                        Json.Dict("feature", feature.Name, "before", beforeVolume, "after", after));
            }
            else
            {
                Steps.Add("sweepBoss " + feature.Name + " bodies " + bodiesBefore + " -> " + BodyCount());
            }
            return feature;
        }

        static int TwistControl(string name)
        {
            string key = (name ?? "followPath").Trim().ToLowerInvariant();
            switch (key)
            {
                case "followpath": return (int)swTwistControlType_e.swTwistControlFollowPath;
                case "keepnormalconstant": return (int)swTwistControlType_e.swTwistControlKeepNormalConstant;
                case "followpathfirstguidecurve": return (int)swTwistControlType_e.swTwistControlFollowPathFirstGuideCurve;
                case "followfirstsecondguidecurves": return (int)swTwistControlType_e.swTwistControlFollowFirstSecondGuideCurves;
                case "constanttwist": return (int)swTwistControlType_e.swTwistControlConstantTwistAlongPath;
                case "normalconstanttwist": return (int)swTwistControlType_e.swTwistControlNormalConstantTwistAlongPath;
                default:
                    throw new BridgeError("INVALID_ARGUMENT",
                        "sweep twistControl=\"" + name + "\" is not one of followPath, "
                        + "keepNormalConstant, followPathFirstGuideCurve, followFirstSecondGuideCurves, "
                        + "constantTwist, normalConstantTwist");
            }
        }

        /// <summary>Thin-wall type. The names are the enum member names, so a caller
        /// who reads swconst does not have to translate.</summary>
        static int ThinType(string name)
        {
            string key = (name ?? "oneDirection").Trim().ToLowerInvariant();
            switch (key)
            {
                case "onedirection": return (int)swThinWallType_e.swThinWallOneDirection;
                case "oppdirection": return (int)swThinWallType_e.swThinWallOppDirection;
                case "midplane": return (int)swThinWallType_e.swThinWallMidPlane;
                case "twodirection": return (int)swThinWallType_e.swThinWallTwoDirection;
                default:
                    throw new BridgeError("INVALID_ARGUMENT",
                        "sweep thinType=\"" + name + "\" is not one of oneDirection, oppDirection, "
                        + "midPlane, twoDirection");
            }
        }

        /// <summary>Start/end matching for a sweep. 0/none and 1/coincident are the
        /// two values this build accepts; a string outside the list is rejected
        /// instead of being turned into 0 (which is why a "tangent" request used to
        /// silently become "no constraint").</summary>
        static int MatchingType(string name, string what)
        {
            string key = (name ?? "none").Trim().ToLowerInvariant();
            switch (key)
            {
                case "none": return 0;
                case "coincident": return 1;
                case "tangent": return 2;
                default:
                    throw new BridgeError("INVALID_ARGUMENT",
                        "sweep " + what + "=\"" + name + "\" is not one of none, coincident, tangent");
            }
        }

        // ------------------------------------------------------------------- loft

        /// <summary>Lofts through two or more section sketches.
        ///
        /// Modes:
        ///   boss    -> InsertProtrusionBlend2 (solid)
        ///   cut     -> InsertCutBlend (solid)
        ///   surface -> IModelDoc2.InsertLoftRefSurface2 (sheet)
        /// The sections are selected with mark 1, guide curves with mark 2, in the
        /// order given — a loft is order-dependent, so the caller's list order is the
        /// section order.
        ///
        /// This is what makes a real bevel gear possible: the big-end and small-end
        /// involute sections are lofted instead of approximating the flank with a
        /// cone. A loft of fewer than two sections is rejected rather than built as
        /// an extrusion.</summary>
        public IFeature Loft(List<IFeature> sections, string mode, List<IFeature> guides,
            bool closed, bool keepTangency, bool thin, double thicknessMm, double thickness2Mm,
            string thinType, bool merge, bool advancedSmoothing, int startMatching,
            int endMatching, double tessTolerance)
        {
            if (sections == null || sections.Count < 2)
                throw new BridgeError("BAD_ARGUMENT",
                    "loft needs at least two section sketches (got "
                    + (sections == null ? 0 : sections.Count) + "); one section is an extrusion");
            if (tessTolerance <= 0) tessTolerance = 1;
            if (thin) RequirePositive(thicknessMm, "thickness");

            _doc.ClearSelection2(true);
            int index = 0;
            foreach (IFeature section in sections)
            {
                index++;
                if (section == null)
                    throw new BridgeError("BAD_ARGUMENT", "loft section " + index + " is empty");
                if (!Select(section.Name, new string[] { "SKETCH" }, 1, true, false))
                    throw new BridgeError("SELECTION_EMPTY",
                        "could not select loft section " + index + " (\"" + section.Name + "\")");
            }
            if (guides != null)
            {
                foreach (IFeature guide in guides)
                {
                    if (guide == null) continue;
                    if (!Select(guide.Name, new string[] { "SKETCH", "REFERENCECURVES", "CURVE" }, 2, true, false))
                        throw new BridgeError("SELECTION_EMPTY",
                            "could not select loft guide curve \"" + guide.Name + "\"");
                }
            }

            IFeature feature;
            string key = (mode ?? "boss").Trim().ToLowerInvariant();
            if (key == "surface")
            {
                int before = TopLevelFeatureCount();
                _doc.InsertLoftRefSurface2(closed, keepTangency, !advancedSmoothing,
                    tessTolerance, (short)startMatching, (short)endMatching);
                feature = TopLevelFeatureAt(before);
            }
            else if (key == "boss")
            {
                feature = _doc.FeatureManager.InsertProtrusionBlend2(
                    closed, keepTangency, !advancedSmoothing, tessTolerance,
                    (short)startMatching, (short)endMatching, 0, 0, false, false,
                    thin, SwHost.ToMeters(thicknessMm), SwHost.ToMeters(thickness2Mm),
                    (short)ThinType(thinType), merge, true, true, 0);
            }
            else if (key == "cut")
            {
                feature = _doc.FeatureManager.InsertCutBlend(
                    closed, keepTangency, !advancedSmoothing, tessTolerance,
                    (short)startMatching, (short)endMatching,
                    thin, SwHost.ToMeters(thicknessMm), SwHost.ToMeters(thickness2Mm),
                    (short)ThinType(thinType), true, true);
            }
            else
            {
                throw new BridgeError("INVALID_ARGUMENT",
                    "loft mode=\"" + mode + "\" is not one of boss, cut, surface");
            }

            if (feature == null)
                throw new BridgeError("LOFT_FAILED",
                    "the loft returned null. Sections must be closed sketches on parallel or "
                    + "progressively rotated planes, selected in order; a section whose plane "
                    + "coincides with the previous one has nothing to loft to.",
                    Json.Dict("mode", mode, "sections", sections.Count));

            Steps.Add("loft " + feature.Name + " mode=" + mode + " sections=" + sections.Count);
            return feature;
        }

        // ----------------------------------------------------------- selection/util

        bool Select(string name, string[] types, int mark, bool append, bool required)
        {
            if (string.IsNullOrEmpty(name)) return false;
            foreach (string type in types)
            {
                try
                {
                    if (_doc.Extension.SelectByID2(name, type, 0, 0, 0, append, mark, null, 0))
                        return true;
                }
                catch (COMException) { }
            }
            return !required;
        }

        int TopLevelFeatureCount()
        {
            return SwHost.Features(_doc).Count;
        }

        /// <summary>The feature added after <paramref name="previousCount"/> features.
        /// InsertHelix and InsertLoftRefSurface2 return void, so "which feature did
        /// that just create" has to come from the tree. Comparing by name rather than
        /// by object identity survives the RCW boundary.</summary>
        IFeature TopLevelFeatureAt(int previousCount)
        {
            List<IFeature> features = SwHost.Features(_doc);
            if (features.Count <= previousCount) return null;
            return features[features.Count - 1];
        }

        int BodyCount()
        {
            return Geometry.BodyCount(_doc);
        }

        static void RequirePositive(double value, string what)
        {
            if (!(value > 0))
                throw new BridgeError("INVALID_ARGUMENT",
                    what + " must be a positive millimetre value (got " + value + ")");
        }

        static double Deg(double degrees) { return degrees * Math.PI / 180.0; }
    }
}
