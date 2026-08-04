using System;
using System.Collections.Generic;
using UnityEngine;

namespace FrameAction
{
    /// <summary>
    /// SpriteCue's project-independent procedural rigid body. The component owns mass properties,
    /// collision damage and facet-graph fracture. Games submit impact facts only; element
    /// reactions, combat ownership and presentation policy stay outside this package.
    /// </summary>
    [DisallowMultipleComponent]
    [RequireComponent(typeof(FrameActionProceduralRigidGeometry2D))]
    [RequireComponent(typeof(PolygonCollider2D))]
    [RequireComponent(typeof(Rigidbody2D))]
    public abstract class FrameActionProceduralRigidBodyCore2D : MonoBehaviour
    {
        private const float MinimumMass = 0.035f;
        private const int ContactHistoryCapacity = 8;
        private const int SiblingDamageGraceFixedTicks = 3;
        private const int AnchorAuditIntervalTicks = 6;
        private const int AnchorLossAuditCount = 3;
        private const float Epsilon = 0.000001f;
        private const float FirstVisibleFatigueCrack = 0.25f;
        private const float StructuralFailureDamage = 1f;

        private static readonly Dictionary<uint, int> ActiveFamilyCounts = new Dictionary<uint, int>();
        private static readonly Dictionary<int, PhysicsMaterial2D> PhysicsMaterials = new Dictionary<int, PhysicsMaterial2D>();

        [SerializeField] private FrameActionProceduralRigidSource2D authoringSource;
        [SerializeField] private FrameActionProceduralRigidGeometry2D geometry;
        [SerializeField] private PolygonCollider2D polygonCollider;
        [SerializeField] private Rigidbody2D rigidBody;
        [SerializeField] private bool initializeFromSourceOnAwake = true;
        [SerializeField] private uint bodyId;
        [SerializeField] private uint parentBodyId;
        [SerializeField] private int generation;
        [SerializeField] private uint revision;
        [SerializeField, Range(0f, 1.5f)] private float accumulatedDamage;
        [SerializeField] private bool initialized;
        [SerializeField] private bool retired;
        [SerializeField] private string templateId = "custom";
        [SerializeField] private string elementTag = string.Empty;
        [SerializeField] private FrameActionProceduralRigidPhysicalProfile2D physicalProfile;
        [SerializeField] private uint familyId;
        [SerializeField] private bool terrainAnchored;
        [SerializeField] private int siblingDamageGraceTicks;

        private readonly int[] contactIds = new int[ContactHistoryCapacity];
        private readonly int[] contactTicks = new int[ContactHistoryCapacity];
        private readonly Collider2D[] anchorOverlapResults = new Collider2D[8];
        private readonly List<AnchorSegment> anchorSegments = new List<AnchorSegment>(4);
        private int contactWriteIndex;
        private int fixedTick;
        private int missingAnchorAudits;
        private int fractureDelayTicks;
        private FrameActionProceduralRigidFracturePlan2D pendingPlan;
        private FrameActionProceduralRigidImpact2D pendingImpact;
        private FrameActionProceduralRigidImpactMetrics2D pendingMetrics;
        private float areaWorld;
        private bool familyRegistered;

        public static event Action<FrameActionProceduralRigidEvent2D> AnyEventRaised;
        public event Action<FrameActionProceduralRigidEvent2D> EventRaised;

        public bool IsInitialized => initialized;
        public bool IsRetired => retired;
        public bool IsFracturePending => pendingPlan != null;
        public uint BodyId => bodyId;
        public uint ParentBodyId => parentBodyId;
        public int Generation => generation;
        public float AreaWorld => areaWorld;
        public float AccumulatedDamage => accumulatedDamage;
        public string TemplateId => templateId;
        public string ElementTag => elementTag;
        public FrameActionProceduralRigidPhysicalProfile2D PhysicalProfile => physicalProfile;
        public uint FamilyId => familyId;
        public bool IsTerrainAnchored => terrainAnchored;

        /// <summary>
        /// Updates the free-form material tag carried by this body and any fragments released
        /// later. The package stores metadata only; consuming games define every tag's meaning.
        /// </summary>
        public bool SetElementTag(string value)
        {
            string resolved = value ?? string.Empty;
            if (elementTag == resolved) return false;
            elementTag = resolved;
            if (authoringSource != null) authoringSource.elementTag = resolved;
            revision++;
            return true;
        }

        /// <summary>
        /// Applies a consuming game's runtime material state after import. This API is deliberately
        /// tag-agnostic: SpriteCue owns the generic rigid simulation, while the game decides when
        /// a reaction requires a different physical profile.
        /// </summary>
        public bool ApplyRuntimePhysicalProfile(FrameActionProceduralRigidPhysicalProfile2D value)
        {
            if (!initialized || retired || polygonCollider == null || polygonCollider.pathCount == 0)
                return false;
            physicalProfile = value.Normalized(templateId);
            Vector2[] boundary = polygonCollider.GetPath(0);
            if (boundary == null || boundary.Length < 3) return false;
            ConfigureMassAndBody(boundary, 0f);
            revision++;
            return true;
        }

        /// <summary>
        /// Removes one shallow layer from the surface nearest a world-space contact. The package
        /// updates its collider, facet mesh, source-image coordinates, mass and anchors together,
        /// while assigning no gameplay meaning to the removed material.
        /// </summary>
        public bool TryTrimSurface(
            Vector2 worldPoint,
            float depthWorld,
            out Vector2[] removedWorldBoundary)
        {
            removedWorldBoundary = Array.Empty<Vector2>();
            if (!initialized || retired || pendingPlan != null || depthWorld <= Epsilon ||
                geometry == null || !geometry.IsReady || polygonCollider == null ||
                polygonCollider.pathCount != 1 || rigidBody == null)
                return false;

            Vector2[] source = SanitizeClosedPath(polygonCollider.GetPath(0));
            if (source.Length < 3) return false;
            Vector2 centroid = FrameActionProceduralRigidPhysicsMath2D.CalculatePolygonAreaCentroid(source);
            Vector2 localContact = transform.InverseTransformPoint(worldPoint);
            Vector2 outward = localContact - centroid;
            if (outward.sqrMagnitude <= Epsilon) outward = Vector2.down;
            outward.Normalize();

            float minimum = float.PositiveInfinity;
            float maximum = float.NegativeInfinity;
            for (int index = 0; index < source.Length; index++)
            {
                float projection = Vector2.Dot(source[index], outward);
                minimum = Mathf.Min(minimum, projection);
                maximum = Mathf.Max(maximum, projection);
            }
            float span = maximum - minimum;
            if (span <= 0.0001f) return false;
            float worldPerLocalUnit = Mathf.Max(Epsilon, transform.TransformVector(outward).magnitude);
            float localDepth = Mathf.Clamp(depthWorld / worldPerLocalUnit, span * 0.0025f, span * 0.18f);
            float limit = maximum - localDepth;
            List<Vector2> residual = ClipPolygon(source, outward, limit, true);
            List<Vector2> removed = ClipPolygon(source, outward, limit, false);
            if (residual.Count < 3 || removed.Count < 3) return false;

            float originalArea = FrameActionProceduralRigidPhysicsMath2D.CalculatePolygonArea(source);
            float residualArea = FrameActionProceduralRigidPhysicsMath2D.CalculatePolygonArea(residual);
            if (residualArea <= Epsilon || residualArea >= originalArea - Epsilon) return false;
            if (!geometry.TryClipFacets(outward, limit, true)) return false;

            removedWorldBoundary = new Vector2[removed.Count];
            for (int index = 0; index < removed.Count; index++)
                removedWorldBoundary[index] = transform.TransformPoint(removed[index]);

            Vector2 newOrigin = FrameActionProceduralRigidPhysicsMath2D.CalculatePolygonAreaCentroid(residual);
            var previousAnchors = new List<AnchorSegment>(anchorSegments);
            bool wasTerrainAnchored = terrainAnchored;
            CopyAnchorsForPiece(previousAnchors, residual, newOrigin);
            terrainAnchored = wasTerrainAnchored && anchorSegments.Count > 0;
            missingAnchorAudits = 0;

            Vector2 linearVelocity = rigidBody.linearVelocity;
            float angularVelocity = rigidBody.angularVelocity;
            Vector2 worldOrigin = transform.TransformPoint(newOrigin);
            Vector2[] centeredBoundary = new Vector2[residual.Count];
            for (int index = 0; index < residual.Count; index++)
                centeredBoundary[index] = residual[index] - newOrigin;
            geometry.TranslateLocal(newOrigin);
            transform.position = worldOrigin;
            rigidBody.position = worldOrigin;
            polygonCollider.pathCount = 1;
            polygonCollider.SetPath(0, centeredBoundary);
            ConfigureMassAndBody(centeredBoundary, residualArea);
            rigidBody.linearVelocity = linearVelocity;
            rigidBody.angularVelocity = angularVelocity;
            rigidBody.WakeUp();
            MeshRenderer renderer = GetComponent<MeshRenderer>();
            geometry.RebuildVisual(
                renderer != null ? renderer.sortingLayerID : 0,
                renderer != null ? renderer.sortingOrder : 0);
            revision++;
            return true;
        }

        // Unity invokes message methods on the concrete MonoBehaviour type. These messages must
        // remain inheritable because projects attach FrameActionProceduralRigidBody2D, while this
        // core class owns the implementation.
        protected virtual void Awake()
        {
            CacheComponents();
            if (initializeFromSourceOnAwake)
            {
                if (authoringSource == null) authoringSource = GetComponent<FrameActionProceduralRigidSource2D>();
                if (authoringSource != null) InitializeFromSource(authoringSource);
            }
        }

        protected virtual void FixedUpdate()
        {
            fixedTick++;
            if (siblingDamageGraceTicks > 0) siblingDamageGraceTicks--;
            if (retired) return;
            if (terrainAnchored && fixedTick % AnchorAuditIntervalTicks == 0) AuditTerrainAnchors();
            if (pendingPlan == null) return;
            if (fractureDelayTicks > 0)
            {
                fractureDelayTicks--;
                return;
            }
            ReleasePendingFracture();
        }

        /// <summary>Initializes an authored mother body; safe to call repeatedly after map sync.</summary>
        public bool InitializeFromSource(FrameActionProceduralRigidSource2D source)
        {
            if (source == null) return false;
            CacheComponents();
            authoringSource = source;
            templateId = string.IsNullOrWhiteSpace(source.templateId)
                ? (string.IsNullOrWhiteSpace(source.visual.templateId) ? "custom" : source.visual.templateId)
                : source.templateId;
            elementTag = source.elementTag ?? string.Empty;
            physicalProfile = source.physical.Normalized(templateId);
            geometry.InitializeFromAuthoring(source);
            if (!geometry.IsReady || source.localOutline == null || source.localOutline.Length < 3) return false;

            Vector2[] outline = SanitizeClosedPath(source.localOutline);
            if (outline.Length < 3) return false;
            polygonCollider.pathCount = 1;
            polygonCollider.SetPath(0, outline);
            UnregisterFamily();
            bodyId = StableId(source.sourceId, source.seed);
            parentBodyId = 0u;
            familyId = bodyId;
            generation = 0;
            accumulatedDamage = 0f;
            retired = false;
            initialized = true;
            CaptureAuthoringAnchors(source, outline);
            RegisterFamily();
            ConfigureMassAndBody(outline, 0f);
            MeshRenderer renderer = GetComponent<MeshRenderer>();
            int sortingLayerId = renderer != null ? renderer.sortingLayerID : 0;
            int sortingOrder = renderer != null ? renderer.sortingOrder : 0;
            geometry.RebuildVisual(sortingLayerId, sortingOrder);
            revision++;
            return true;
        }

        protected virtual void OnDestroy()
        {
            UnregisterFamily();
        }

        /// <summary>
        /// Applies one already-resolved physical impact. Returns true when it changed damage,
        /// cracks or lifetime; callers never need to know how facets are partitioned.
        /// </summary>
        public bool ApplyImpact(in FrameActionProceduralRigidImpact2D impact)
        {
            if (!initialized || retired || rigidBody == null || geometry == null || !geometry.IsReady) return false;

            FrameActionProceduralRigidFractureSettings2D settings = geometry.FractureSettings;
            ResolveImpactThresholds(settings, impact.Cause, out float chip, out float crack, out float fracture);
            Vector2 surfaceNormal = impact.SurfaceNormalWorld;
            if (surfaceNormal.sqrMagnitude <= Epsilon)
            {
                surfaceNormal = impact.IncomingVelocityWorld.sqrMagnitude > Epsilon
                    ? -impact.IncomingVelocityWorld.normalized
                    : Vector2.up;
            }
            float effectiveMass = impact.EffectiveMassKilograms > Epsilon
                ? impact.EffectiveMassKilograms
                : rigidBody.mass;
            FrameActionProceduralRigidImpactMetrics2D metrics = FrameActionProceduralRigidPhysicsMath2D.EvaluateImpact(
                impact.IncomingVelocityWorld,
                surfaceNormal,
                effectiveMass,
                0f,
                impact.ContactSpanWorld > Epsilon ? impact.ContactSpanWorld : EstimateContactSpan(),
                impact.EnergyJoules,
                accumulatedDamage,
                chip,
                crack,
                fracture,
                ResolveStressSensitivity(settings));
            float intensity = FrameActionProceduralRigidPhysicsMath2D.CalculatePresentationIntensity(
                metrics.EffectiveEnergy, chip, crack, fracture, metrics.Response, accumulatedDamage);
            Emit(FrameActionProceduralRigidEventKind2D.Hit, impact, metrics.EffectiveEnergy, 0f, intensity);
            return ApplyEvaluatedImpact(impact, metrics);
        }

        public FrameActionProceduralRigidSnapshot2D GetSnapshot()
        {
            Vector2 center = rigidBody != null
                ? rigidBody.worldCenterOfMass
                : (Vector2)transform.position;
            return new FrameActionProceduralRigidSnapshot2D(
                bodyId,
                parentBodyId,
                revision,
                geometry != null ? geometry.AppearanceSeed : 0u,
                templateId,
                elementTag,
                generation,
                center,
                rigidBody != null ? rigidBody.linearVelocity : Vector2.zero,
                rigidBody != null ? rigidBody.rotation : transform.eulerAngles.z,
                rigidBody != null ? rigidBody.angularVelocity : 0f,
                areaWorld,
                accumulatedDamage,
                retired);
        }

        private bool ApplyEvaluatedImpact(
            FrameActionProceduralRigidImpact2D impact,
            FrameActionProceduralRigidImpactMetrics2D metrics)
        {
            if (metrics.Response == FrameActionProceduralRigidImpactResponse2D.None) return false;
            ResolveImpactThresholds(geometry.FractureSettings, impact.Cause,
                out float chipEnergy, out float crackEnergy, out float breakEnergy);
            float previousDamage = accumulatedDamage;
            accumulatedDamage = Mathf.Min(1.5f, accumulatedDamage
                + FrameActionProceduralRigidPhysicsMath2D.CalculateFatigueDamage(
                    metrics.EffectiveEnergy,
                    breakEnergy,
                    metrics.Response,
                    physicalProfile));
            float presentationIntensity = FrameActionProceduralRigidPhysicsMath2D.CalculatePresentationIntensity(
                metrics.EffectiveEnergy,
                chipEnergy,
                crackEnergy,
                breakEnergy,
                metrics.Response,
                accumulatedDamage);

            // Every visible damage tier sheds some material. Keeping this explicit is important:
            // a crack-only hit must still reach the shared debris presenter even when the body
            // has not accumulated enough fatigue to release persistent fragments yet.
            switch (metrics.Response)
            {
                case FrameActionProceduralRigidImpactResponse2D.MicroChip:
                    EmitImpactDebris(impact, metrics.EffectiveEnergy, 0.22f, presentationIntensity);
                    break;
                case FrameActionProceduralRigidImpactResponse2D.Crack:
                    EmitImpactDebris(impact, metrics.EffectiveEnergy, 0.42f, presentationIntensity);
                    break;
                case FrameActionProceduralRigidImpactResponse2D.Fracture:
                    EmitImpactDebris(impact, metrics.EffectiveEnergy, 1f, presentationIntensity);
                    break;
            }

            int previousCrackStage = FatigueCrackStage(previousDamage);
            int currentCrackStage = FatigueCrackStage(accumulatedDamage);
            bool directCrack = metrics.Response >= FrameActionProceduralRigidImpactResponse2D.Crack;
            if (directCrack || currentCrackStage > previousCrackStage)
            {
                float strength = Mathf.Max(
                    accumulatedDamage,
                    metrics.EffectiveEnergy / Mathf.Max(0.01f, breakEnergy));
                ShowLocalCrack(impact, strength);
                Emit(FrameActionProceduralRigidEventKind2D.Crack, impact,
                    metrics.EffectiveEnergy, 0f, presentationIntensity);
            }

            revision++;
            // Structural energy is accumulated before physical separation. A normal break-level
            // hit therefore shows cracks first; only catastrophic energy or repeated impacts can
            // cross the failure value in one step.
            if (accumulatedDamage >= StructuralFailureDamage)
                return TryQueueFracture(impact, metrics);
            return true;
        }

        private static int FatigueCrackStage(float damage)
        {
            if (damage < FirstVisibleFatigueCrack) return 0;
            return Mathf.Clamp(Mathf.FloorToInt(damage / FirstVisibleFatigueCrack), 1, 4);
        }

        private void EmitImpactDebris(
            FrameActionProceduralRigidImpact2D impact,
            float effectiveEnergy,
            float responseScale,
            float presentationIntensity)
        {
            float debrisFraction = Mathf.Clamp01(physicalProfile.debrisFraction);
            if (debrisFraction <= Epsilon || responseScale <= Epsilon) return;
            float affectedArea = Mathf.Min(
                areaWorld * debrisFraction * responseScale,
                Mathf.Max(Epsilon, effectiveEnergy) * debrisFraction * 0.025f);
            float materialScale = 0.55f + Mathf.Sqrt(debrisFraction) * 1.45f;
            float responseVisibility = Mathf.Lerp(0.75f, 1f, Mathf.Clamp01(responseScale));
            float debrisIntensity = Mathf.Clamp01(presentationIntensity * materialScale * responseVisibility);
            Emit(FrameActionProceduralRigidEventKind2D.MicroDebris, impact,
                effectiveEnergy, affectedArea, debrisIntensity);
        }

        private bool TryQueueFracture(
            FrameActionProceduralRigidImpact2D impact,
            FrameActionProceduralRigidImpactMetrics2D metrics)
        {
            if (pendingPlan != null)
            {
                if (metrics.EffectiveEnergy > pendingMetrics.EffectiveEnergy)
                {
                    pendingImpact = impact;
                    pendingMetrics = metrics;
                }
                return true;
            }

            float ppu = Mathf.Max(1f, geometry.SourcePixelsPerUnit);
            float minimumArea = Mathf.Max(Epsilon,
                geometry.FractureSettings.minimumFragmentAreaPixelsSquared / (ppu * ppu));
            if (areaWorld <= minimumArea * 1.9f)
            {
                Emit(FrameActionProceduralRigidEventKind2D.MicroDebris, impact,
                    metrics.EffectiveEnergy, areaWorld);
                RetireAndDestroy(impact);
                return true;
            }

            Vector2 localHit = transform.InverseTransformPoint(impact.WorldPoint);
            Vector2 localDirection = transform.InverseTransformVector(impact.IncomingVelocityWorld);
            if (localDirection.sqrMagnitude <= Epsilon)
                localDirection = localHit.sqrMagnitude > Epsilon ? -localHit.normalized : Vector2.right;
            if (polygonCollider != null && polygonCollider.pathCount > 0)
            {
                Vector2[] currentOutline = polygonCollider.GetPath(0);
                Vector2 towardMass = FrameActionProceduralRigidPhysicsMath2D
                    .CalculatePolygonAreaCentroid(currentOutline) - localHit;
                if (towardMass.sqrMagnitude > Epsilon && Vector2.Dot(localDirection, towardMass) < 0f)
                    localDirection = -localDirection;
            }
            ResolveImpactThresholds(geometry.FractureSettings, impact.Cause,
                out _, out _, out float fractureThreshold);
            float relativeEnergy = metrics.EffectiveEnergy / Mathf.Max(0.01f, fractureThreshold);
            uint seed = impact.Seed != 0u ? impact.Seed : Mix(bodyId, revision + 1u);
            if (!FrameActionProceduralRigidFracturePlanner2D.TryBuildPlan(
                    geometry,
                    physicalProfile,
                    localHit,
                    localDirection.normalized,
                    relativeEnergy,
                    seed,
                    out FrameActionProceduralRigidFracturePlan2D plan))
            {
                // A body that can no longer form two legal physical pieces becomes micro-debris;
                // this is an area/width terminal condition, never a fracture-depth condition.
                if (areaWorld <= minimumArea * 3.25f || geometry.FacetCount <= 1)
                {
                    Emit(FrameActionProceduralRigidEventKind2D.MicroDebris, impact,
                        metrics.EffectiveEnergy, areaWorld);
                    RetireAndDestroy(impact);
                    return true;
                }
                ShowLocalCrack(impact, relativeEnergy);
                accumulatedDamage = Mathf.Min(1.5f, accumulatedDamage + 0.18f);
                revision++;
                Emit(FrameActionProceduralRigidEventKind2D.Crack, impact, metrics.EffectiveEnergy, 0f);
                return true;
            }

            pendingPlan = plan;
            pendingImpact = impact;
            pendingMetrics = metrics;
            geometry.AppendCracks(plan.Cracks);
            fractureDelayTicks = Mathf.Max(1, geometry.FractureSettings.releaseDelayTicks);
            revision++;
            Emit(FrameActionProceduralRigidEventKind2D.Crack, impact,
                metrics.EffectiveEnergy, 0f);
            Emit(FrameActionProceduralRigidEventKind2D.FractureStarted, impact,
                metrics.EffectiveEnergy, areaWorld);
            return true;
        }

        private void ReleasePendingFracture()
        {
            FrameActionProceduralRigidFracturePlan2D plan = pendingPlan;
            FrameActionProceduralRigidImpact2D impact = pendingImpact;
            FrameActionProceduralRigidImpactMetrics2D metrics = pendingMetrics;
            pendingPlan = null;
            if (plan == null || retired) return;

            Vector2 parentLinearVelocity = rigidBody.linearVelocity;
            float parentAngularVelocity = rigidBody.angularVelocity;
            float totalArea = Mathf.Max(Epsilon, plan.SourceArea);
            plan.Pieces.Sort(ComparePiecesLargestFirst);
            int familyCount = GetFamilyCount(familyId);
            int familyBudget = ResolveFamilyBudget(geometry.FractureSettings);
            int availableAfterReplacingParent = Mathf.Max(0, familyBudget - Mathf.Max(0, familyCount - 1));
            int createCount = Mathf.Min(
                Mathf.Min(plan.Pieces.Count, ResolvePerImpactBudget(geometry.FractureSettings)),
                availableAfterReplacingParent);
            for (int index = 0; index < plan.Pieces.Count; index++)
            {
                FrameActionProceduralRigidFracturePiece2D piece = plan.Pieces[index];
                if (index < createCount)
                {
                    CreateFragment(piece, index, totalArea, impact, metrics, parentLinearVelocity, parentAngularVelocity);
                }
                else
                {
                    Emit(FrameActionProceduralRigidEventKind2D.MicroDebris,
                        impact,
                        metrics.EffectiveEnergy,
                        piece.Area);
                }
            }
            RetireAndDestroy(impact);
        }

        private void CreateFragment(
            FrameActionProceduralRigidFracturePiece2D piece,
            int pieceIndex,
            float totalArea,
            FrameActionProceduralRigidImpact2D impact,
            FrameActionProceduralRigidImpactMetrics2D metrics,
            Vector2 parentLinearVelocity,
            float parentAngularVelocity)
        {
            uint fragmentId = Mix(bodyId ^ (impact.Seed == 0u ? revision : impact.Seed), (uint)(pieceIndex + 1));
            var fragmentObject = new GameObject($"SpriteCue Rigid Fragment {fragmentId:X8}");
            fragmentObject.SetActive(false);
            fragmentObject.layer = gameObject.layer;
            fragmentObject.transform.SetPositionAndRotation(
                transform.TransformPoint(piece.Centroid),
                transform.rotation);
            fragmentObject.transform.localScale = transform.lossyScale;

            FrameActionProceduralRigidGeometry2D fragmentGeometry =
                fragmentObject.AddComponent<FrameActionProceduralRigidGeometry2D>();
            PolygonCollider2D fragmentCollider = fragmentObject.AddComponent<PolygonCollider2D>();
            Rigidbody2D fragmentBody = fragmentObject.AddComponent<Rigidbody2D>();
            FrameActionProceduralRigidBody2D fragment = fragmentObject.AddComponent<FrameActionProceduralRigidBody2D>();
            fragment.initializeFromSourceOnAwake = false;
            fragment.geometry = fragmentGeometry;
            fragment.polygonCollider = fragmentCollider;
            fragment.rigidBody = fragmentBody;
            fragment.authoringSource = null;

            fragmentGeometry.InitializeFragment(
                geometry.AppearanceSeed,
                geometry.SourcePixelsPerUnit,
                geometry.VisualSettings,
                geometry.FractureSettings,
                piece.Facets,
                geometry.SourceTexture,
                geometry.SourceTextureTransform);
            fragmentGeometry.TranslateLocal(piece.Centroid);
            Vector2[] centeredBoundary = new Vector2[piece.Boundary.Length];
            for (int index = 0; index < centeredBoundary.Length; index++)
                centeredBoundary[index] = piece.Boundary[index] - piece.Centroid;
            fragmentCollider.pathCount = 1;
            fragmentCollider.SetPath(0, centeredBoundary);

            fragment.bodyId = fragmentId;
            fragment.parentBodyId = bodyId;
            fragment.familyId = familyId;
            fragment.generation = generation + 1;
            fragment.templateId = templateId;
            fragment.elementTag = elementTag;
            fragment.physicalProfile = physicalProfile;
            fragment.CopyAnchorsForPiece(anchorSegments, piece.Boundary, piece.Centroid);
            fragment.terrainAnchored = fragment.anchorSegments.Count > 0;
            fragment.siblingDamageGraceTicks = SiblingDamageGraceFixedTicks;
            fragment.accumulatedDamage = Mathf.Clamp01(accumulatedDamage * 0.22f);
            fragment.retired = false;
            fragment.initialized = true;
            fragment.RegisterFamily();
            fragment.ConfigureMassAndBody(centeredBoundary, piece.Area);

            float areaRatio = Mathf.Clamp01(piece.Area / totalArea);
            float allocatedEnergy = metrics.KineticEnergy * Mathf.Lerp(0.35f, 1f, areaRatio);
            float launchSpeed = Mathf.Sqrt(Mathf.Max(0f, 2f * allocatedEnergy / Mathf.Max(MinimumMass, fragmentBody.mass)));
            launchSpeed = Mathf.Clamp(launchSpeed, 0.15f, 13f);
            Vector2 worldCenter = fragmentObject.transform.position;
            Vector2 radial = worldCenter - impact.WorldPoint;
            if (radial.sqrMagnitude <= Epsilon)
            {
                Vector2 localHit = transform.InverseTransformPoint(impact.WorldPoint);
                radial = transform.TransformDirection(piece.Centroid - localHit);
            }
            radial = radial.sqrMagnitude > Epsilon ? radial.normalized : Vector2.up;
            Vector2 incoming = impact.IncomingVelocityWorld.sqrMagnitude > Epsilon
                ? impact.IncomingVelocityWorld.normalized
                : radial;
            Vector2 launchDirection = (radial * 0.68f + incoming * 0.32f).normalized;
            fragmentBody.linearVelocity = parentLinearVelocity + launchDirection * launchSpeed;

            Vector2 lever = worldCenter - impact.WorldPoint;
            float impulseMagnitude = Mathf.Sqrt(Mathf.Max(0f,
                2f * fragmentBody.mass * Mathf.Max(0f, allocatedEnergy)));
            float torqueImpulse = Cross(lever, launchDirection * impulseMagnitude);
            float inertia = Mathf.Max(0.015f, fragmentBody.inertia);
            float angularDeltaDegrees = torqueImpulse / inertia * Mathf.Rad2Deg;
            fragmentBody.angularVelocity = Mathf.Clamp(
                parentAngularVelocity + angularDeltaDegrees,
                -720f,
                720f);

            MeshRenderer sourceRenderer = GetComponent<MeshRenderer>();
            int sortingLayer = sourceRenderer != null ? sourceRenderer.sortingLayerID : 0;
            int sortingOrder = sourceRenderer != null ? sourceRenderer.sortingOrder : 0;
            fragmentGeometry.RebuildVisual(sortingLayer, sortingOrder);
            fragment.revision++;
            fragmentObject.SetActive(true);
            fragment.Emit(FrameActionProceduralRigidEventKind2D.FragmentCreated,
                impact,
                metrics.EffectiveEnergy,
                piece.Area);
        }

        private void ConfigureMassAndBody(IReadOnlyList<Vector2> boundary, float measuredArea)
        {
            float localArea = measuredArea > Epsilon
                ? measuredArea
                : FrameActionProceduralRigidPhysicsMath2D.CalculatePolygonArea(boundary);
            Vector3 worldScale = transform.lossyScale;
            float scaleArea = Mathf.Max(Epsilon, Mathf.Abs(worldScale.x * worldScale.y));
            areaWorld = localArea * scaleArea;
            Vector2 centroid = FrameActionProceduralRigidPhysicsMath2D.CalculatePolygonAreaCentroid(boundary);
            bool authoredFixedMother = generation == 0
                && physicalProfile.initialMotion == FrameActionProceduralRigidInitialMotion2D.Fixed;
            rigidBody.bodyType = terrainAnchored || authoredFixedMother
                ? RigidbodyType2D.Kinematic
                : RigidbodyType2D.Dynamic;
            rigidBody.gravityScale = physicalProfile.gravityScale;
            rigidBody.interpolation = RigidbodyInterpolation2D.Interpolate;
            rigidBody.collisionDetectionMode = CollisionDetectionMode2D.Continuous;
            rigidBody.mass = Mathf.Clamp(areaWorld * Mathf.Max(0.001f, physicalProfile.density), MinimumMass, 1000f);
#if UNITY_6000_0_OR_NEWER
            rigidBody.linearDamping = physicalProfile.linearDamping;
            rigidBody.angularDamping = physicalProfile.angularDamping;
#else
            rigidBody.drag = physicalProfile.linearDamping;
            rigidBody.angularDrag = physicalProfile.angularDamping;
#endif
            rigidBody.centerOfMass = centroid;
            polygonCollider.isTrigger = false;
            polygonCollider.sharedMaterial = ResolvePhysicsMaterial(physicalProfile.friction, physicalProfile.restitution);
        }

        protected virtual void OnCollisionEnter2D(Collision2D collision)
        {
            if (!initialized || retired || collision == null || collision.contactCount <= 0) return;
            Collider2D otherCollider = collision.collider;
            FrameActionProceduralRigidBodyCore2D otherRigid = otherCollider != null
                ? otherCollider.GetComponentInParent<FrameActionProceduralRigidBodyCore2D>()
                : null;
            if (otherRigid != null
                && otherRigid.familyId == familyId
                && (siblingDamageGraceTicks > 0 || otherRigid.siblingDamageGraceTicks > 0))
                return;
            int otherId = otherCollider != null ? otherCollider.GetInstanceID() : 0;
            int cooldown = ResolveCooldownTicks(geometry.FractureSettings);
            if (!TryRecordContact(otherId, cooldown)) return;

            Vector2 point = Vector2.zero;
            Vector2 normal = Vector2.zero;
            float impulse = 0f;
            Vector2 firstPoint = Vector2.zero;
            float largestDistance = 0f;
            int contacts = collision.contactCount;
            for (int index = 0; index < contacts; index++)
            {
                ContactPoint2D contact = collision.GetContact(index);
                point += contact.point;
                normal += contact.normal;
                impulse += Mathf.Max(0f, contact.normalImpulse);
                if (index == 0) firstPoint = contact.point;
                else largestDistance = Mathf.Max(largestDistance, Vector2.Distance(firstPoint, contact.point));
            }
            point /= contacts;
            normal = normal.sqrMagnitude > Epsilon ? normal.normalized : Vector2.up;
            float span = Mathf.Max(largestDistance, 1f / Mathf.Max(1f, geometry.SourcePixelsPerUnit));
            Rigidbody2D otherBody = collision.rigidbody;
            bool otherDynamic = otherBody != null && otherBody.bodyType == RigidbodyType2D.Dynamic;
            FrameActionProceduralRigidImpactCause2D cause = otherDynamic
                ? FrameActionProceduralRigidImpactCause2D.RigidBodyCollision
                : FrameActionProceduralRigidImpactCause2D.Landing;
            float reducedMass = FrameActionProceduralRigidPhysicsMath2D.CalculateReducedMass(
                rigidBody.mass,
                otherBody != null ? otherBody.mass : 0f,
                otherDynamic);
            FrameActionProceduralRigidFractureSettings2D settings = geometry.FractureSettings;
            ResolveImpactThresholds(settings, cause, out float chip, out float crack, out float fracture);
            FrameActionProceduralRigidImpactMetrics2D metrics = FrameActionProceduralRigidPhysicsMath2D.EvaluateImpact(
                collision.relativeVelocity,
                normal,
                reducedMass,
                impulse,
                span,
                0f,
                accumulatedDamage,
                chip,
                crack,
                fracture,
                ResolveStressSensitivity(settings));
            var impact = new FrameActionProceduralRigidImpact2D
            {
                WorldPoint = point,
                IncomingVelocityWorld = collision.relativeVelocity,
                SurfaceNormalWorld = normal,
                EnergyJoules = metrics.KineticEnergy,
                EffectiveMassKilograms = reducedMass,
                ContactSpanWorld = span,
                Seed = Mix(bodyId, unchecked((uint)(fixedTick + otherId))),
                Cause = cause,
            };
            float presentationIntensity = FrameActionProceduralRigidPhysicsMath2D.CalculatePresentationIntensity(
                metrics.EffectiveEnergy, chip, crack, fracture, metrics.Response, accumulatedDamage);
            Emit(FrameActionProceduralRigidEventKind2D.Hit, impact,
                metrics.EffectiveEnergy, 0f, presentationIntensity);
            if (impact.Cause == FrameActionProceduralRigidImpactCause2D.Landing)
                Emit(FrameActionProceduralRigidEventKind2D.Landed, impact,
                    metrics.EffectiveEnergy, 0f, presentationIntensity);
            ApplyEvaluatedImpact(impact, metrics);
        }

        private bool TryRecordContact(int colliderId, int cooldownTicks)
        {
            for (int index = 0; index < contactIds.Length; index++)
            {
                if (contactIds[index] != colliderId) continue;
                if (!FrameActionProceduralRigidPhysicsMath2D.IsContactCooldownElapsed(
                        contactTicks[index], fixedTick, cooldownTicks)) return false;
                contactTicks[index] = fixedTick;
                return true;
            }
            contactIds[contactWriteIndex] = colliderId;
            contactTicks[contactWriteIndex] = fixedTick;
            contactWriteIndex = (contactWriteIndex + 1) % contactIds.Length;
            return true;
        }

        private void ShowLocalCrack(FrameActionProceduralRigidImpact2D impact, float strength)
        {
            if (geometry.FacetCount <= 0 || polygonCollider == null || polygonCollider.pathCount == 0) return;
            Vector2[] outline = polygonCollider.GetPath(0);
            if (outline == null || outline.Length < 3) return;
            Vector2 localHit = transform.InverseTransformPoint(impact.WorldPoint);
            if (!PointInPolygon(localHit, outline)) localHit = ClosestPointOnPolygon(localHit, outline);
            Vector2 center = FrameActionProceduralRigidPhysicsMath2D.CalculatePolygonAreaCentroid(outline);
            Vector2 towardCenter = center - localHit;
            Vector2 inward = transform.InverseTransformVector(impact.IncomingVelocityWorld);
            if (inward.sqrMagnitude <= Epsilon) inward = towardCenter;
            if (inward.sqrMagnitude <= Epsilon) inward = Vector2.up;
            inward.Normalize();
            if (towardCenter.sqrMagnitude > Epsilon && Vector2.Dot(inward, towardCenter) < 0f) inward = -inward;

            float grainRadians = physicalProfile.grainAngleDegrees * Mathf.Deg2Rad;
            Vector2 grain = new Vector2(Mathf.Cos(grainRadians), Mathf.Sin(grainRadians));
            if (Vector2.Dot(grain, inward) < 0f) grain = -grain;
            inward = Vector2.Lerp(inward, grain, Mathf.Clamp01(physicalProfile.anisotropy) * 0.38f).normalized;

            Bounds localBounds = new Bounds(outline[0], Vector3.zero);
            for (int index = 1; index < outline.Length; index++) localBounds.Encapsulate(outline[index]);
            float extent = Mathf.Max(0.02f, Mathf.Sqrt(
                localBounds.size.x * localBounds.size.x + localBounds.size.y * localBounds.size.y));
            float normalizedStrength = Mathf.Clamp01(strength);
            float pixel = 1f / Mathf.Max(1f, geometry.SourcePixelsPerUnit);
            Vector2 start = localHit + inward * pixel * 0.72f;
            if (!PointInPolygon(start, outline)) start = Vector2.Lerp(localHit, center, 0.025f);

            int authoredMin = Mathf.Clamp(geometry.FractureSettings.crackBranchMin <= 0
                ? 1
                : geometry.FractureSettings.crackBranchMin, 1, 6);
            int authoredMax = Mathf.Clamp(geometry.FractureSettings.crackBranchMax <= 0
                ? authoredMin + 1
                : geometry.FractureSettings.crackBranchMax, authoredMin, 8);
            int branchCount = Mathf.Clamp(
                Mathf.RoundToInt(Mathf.Lerp(authoredMin, authoredMax, normalizedStrength)),
                1,
                6);
            uint seed = impact.Seed == 0u ? Mix(bodyId, revision + 1u) : impact.Seed;
            var cracks = new List<FrameActionProceduralRigidCrackSegment2D>(branchCount * 5);
            var trunkNodes = new List<Vector2>(6);
            float trunkLength = extent * Mathf.Lerp(0.18f, 0.68f, normalizedStrength);
            int trunkSteps = Mathf.Clamp(2 + Mathf.RoundToInt(normalizedStrength * 3f), 2, 5);
            BuildCrackPath(start, inward, grain, trunkLength, trunkSteps,
                Mix(seed, 0x31u), normalizedStrength, outline, cracks, trunkNodes);

            Vector2 perpendicular = new Vector2(-inward.y, inward.x);
            for (int branch = 1; branch < branchCount; branch++)
            {
                if (trunkNodes.Count == 0) break;
                uint mixed = Mix(seed ^ 0xa511e9b3u, (uint)branch);
                int nodeIndex = Mathf.Clamp(
                    1 + (int)(mixed % (uint)Mathf.Max(1, trunkNodes.Count - 1)),
                    0,
                    trunkNodes.Count - 1);
                float side = (branch & 1) == 0 ? 1f : -1f;
                float angle = side * Mathf.Lerp(32f, 74f, HashUnit(mixed ^ 0x68bc21ebu));
                Vector2 branchDirection = Rotate(inward, angle);
                branchDirection = Vector2.Lerp(branchDirection, perpendicular * side,
                    HashUnit(mixed ^ 0x02e5be93u) * 0.26f).normalized;
                float branchLength = trunkLength * Mathf.Lerp(0.34f, 0.72f,
                    HashUnit(mixed ^ 0x9e3779b9u));
                int branchSteps = Mathf.Clamp(trunkSteps - 1 + (int)(mixed & 1u), 2, 5);
                BuildCrackPath(trunkNodes[nodeIndex], branchDirection, grain, branchLength,
                    branchSteps, mixed, normalizedStrength * 0.86f, outline, cracks, null);
            }
            geometry.AppendCracks(cracks);
        }

        private void BuildCrackPath(
            Vector2 start,
            Vector2 direction,
            Vector2 grain,
            float totalLength,
            int steps,
            uint seed,
            float strength,
            Vector2[] outline,
            List<FrameActionProceduralRigidCrackSegment2D> output,
            List<Vector2> nodes)
        {
            if (steps <= 0 || totalLength <= Epsilon || output == null) return;
            Vector2 current = start;
            Vector2 currentDirection = direction.sqrMagnitude > Epsilon ? direction.normalized : Vector2.right;
            nodes?.Add(current);
            float stepLength = totalLength / steps;
            for (int step = 0; step < steps; step++)
            {
                uint mixed = Mix(seed, (uint)(step + 1));
                float jitter = (HashUnit(mixed) * 2f - 1f) * Mathf.Lerp(9f, 24f, 1f - strength);
                Vector2 bent = Rotate(currentDirection, jitter);
                if (Vector2.Dot(grain, bent) < 0f) grain = -grain;
                bent = Vector2.Lerp(bent, grain,
                    Mathf.Clamp01(physicalProfile.anisotropy) * 0.22f).normalized;
                float lengthNoise = Mathf.Lerp(0.78f, 1.22f, HashUnit(mixed ^ 0x7f4a7c15u));
                Vector2 candidate = current + bent * stepLength * lengthNoise;
                bool candidateInside = PointInPolygon(candidate, outline);
                if (!candidateInside)
                {
                    if (!TryClipToPolygon(current, candidate, outline, out candidate)) break;
                }
                if ((candidate - current).sqrMagnitude <= Epsilon) break;
                output.Add(new FrameActionProceduralRigidCrackSegment2D(
                    current,
                    candidate,
                    Mathf.Clamp01(strength * Mathf.Lerp(1f, 0.68f, step / Mathf.Max(1f, steps - 1f)))));
                current = candidate;
                currentDirection = bent;
                nodes?.Add(current);
                if (!candidateInside) break;
            }
        }

        private static bool TryClipToPolygon(
            Vector2 start,
            Vector2 end,
            IReadOnlyList<Vector2> outline,
            out Vector2 clipped)
        {
            clipped = start;
            float best = float.PositiveInfinity;
            for (int index = 0; index < outline.Count; index++)
            {
                Vector2 a = outline[index];
                Vector2 b = outline[(index + 1) % outline.Count];
                if (!TrySegmentIntersection(start, end, a, b, out float along)) continue;
                if (along <= 0.0001f || along >= best) continue;
                best = along;
            }
            if (float.IsInfinity(best)) return false;
            clipped = Vector2.Lerp(start, end, Mathf.Clamp01(best));
            return true;
        }

        private static bool TrySegmentIntersection(
            Vector2 p,
            Vector2 p2,
            Vector2 q,
            Vector2 q2,
            out float alongFirst)
        {
            Vector2 r = p2 - p;
            Vector2 s = q2 - q;
            float denominator = Cross(r, s);
            alongFirst = 0f;
            if (Mathf.Abs(denominator) <= Epsilon) return false;
            Vector2 delta = q - p;
            float t = Cross(delta, s) / denominator;
            float u = Cross(delta, r) / denominator;
            if (t < -0.0001f || t > 1.0001f || u < -0.0001f || u > 1.0001f) return false;
            alongFirst = t;
            return true;
        }

        private static Vector2 ClosestPointOnPolygon(Vector2 point, IReadOnlyList<Vector2> outline)
        {
            Vector2 best = outline[0];
            float bestDistance = float.PositiveInfinity;
            for (int index = 0; index < outline.Count; index++)
            {
                Vector2 a = outline[index];
                Vector2 b = outline[(index + 1) % outline.Count];
                Vector2 edge = b - a;
                float t = edge.sqrMagnitude > Epsilon
                    ? Mathf.Clamp01(Vector2.Dot(point - a, edge) / edge.sqrMagnitude)
                    : 0f;
                Vector2 candidate = a + edge * t;
                float distance = (candidate - point).sqrMagnitude;
                if (distance >= bestDistance) continue;
                bestDistance = distance;
                best = candidate;
            }
            return best;
        }

        private static bool PointInPolygon(Vector2 point, IReadOnlyList<Vector2> outline)
        {
            bool inside = false;
            for (int current = 0, previous = outline.Count - 1;
                 current < outline.Count;
                 previous = current++)
            {
                Vector2 a = outline[current];
                Vector2 b = outline[previous];
                bool crosses = (a.y > point.y) != (b.y > point.y)
                    && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
                if (crosses) inside = !inside;
            }
            return inside;
        }

        private static Vector2 Rotate(Vector2 value, float degrees)
        {
            float radians = degrees * Mathf.Deg2Rad;
            float cosine = Mathf.Cos(radians);
            float sine = Mathf.Sin(radians);
            return new Vector2(value.x * cosine - value.y * sine, value.x * sine + value.y * cosine);
        }

        private static float HashUnit(uint value)
        {
            value ^= value >> 16;
            value *= 0x7feb352du;
            value ^= value >> 15;
            value *= 0x846ca68bu;
            value ^= value >> 16;
            return (value & 0x00ffffffu) / 16777215f;
        }

        private void RetireAndDestroy(FrameActionProceduralRigidImpact2D impact)
        {
            if (retired) return;
            retired = true;
            initialized = false;
            revision++;
            if (polygonCollider != null) polygonCollider.enabled = false;
            if (rigidBody != null) rigidBody.simulated = false;
            MeshRenderer renderer = GetComponent<MeshRenderer>();
            if (renderer != null) renderer.enabled = false;
            Emit(FrameActionProceduralRigidEventKind2D.Retired, impact, impact.EnergyJoules, areaWorld);
            UnregisterFamily();
            Destroy(gameObject);
        }

        /// <summary>Explicit support notification for games with non-Physics2D terrain backends.</summary>
        public void ReleaseTerrainAnchor()
        {
            if (!terrainAnchored || retired) return;
            terrainAnchored = false;
            anchorSegments.Clear();
            missingAnchorAudits = 0;
            if (rigidBody != null)
            {
                rigidBody.bodyType = RigidbodyType2D.Dynamic;
                rigidBody.WakeUp();
            }
            revision++;
            var impact = new FrameActionProceduralRigidImpact2D
            {
                WorldPoint = rigidBody != null ? rigidBody.worldCenterOfMass : (Vector2)transform.position,
                SurfaceNormalWorld = Vector2.up,
                Seed = Mix(bodyId, revision),
                Cause = FrameActionProceduralRigidImpactCause2D.External,
            };
            Emit(FrameActionProceduralRigidEventKind2D.AnchorReleased, impact, 0f, 0f);
        }

        private void Emit(
            FrameActionProceduralRigidEventKind2D kind,
            FrameActionProceduralRigidImpact2D impact,
            float energy,
            float affectedArea,
            float intensity01 = -1f)
        {
            FrameActionProceduralRigidVisualSettings2D visual = geometry != null
                ? geometry.VisualSettings.NormalizedForRendering()
                : default;
            Color fractureColor = visual.fractureColor;
            Color debrisHighlight = Color.Lerp(fractureColor, visual.highlightColor, 0.38f);
            var value = new FrameActionProceduralRigidEvent2D(
                kind,
                bodyId,
                parentBodyId,
                revision,
                templateId,
                elementTag,
                impact.WorldPoint,
                impact.IncomingVelocityWorld,
                impact.SurfaceNormalWorld,
                energy,
                affectedArea,
                impact.Seed,
                fractureColor,
                debrisHighlight,
                visual.opacity,
                intensity01 >= 0f
                    ? Mathf.Clamp01(intensity01)
                    : energy <= 0f ? 0f : energy / (energy + 8f));
            EventRaised?.Invoke(value);
            AnyEventRaised?.Invoke(value);
        }

        private void CacheComponents()
        {
            if (geometry == null) geometry = GetComponent<FrameActionProceduralRigidGeometry2D>();
            if (polygonCollider == null) polygonCollider = GetComponent<PolygonCollider2D>();
            if (rigidBody == null) rigidBody = GetComponent<Rigidbody2D>();
        }

        private void CaptureAuthoringAnchors(
            FrameActionProceduralRigidSource2D source,
            IReadOnlyList<Vector2> outline)
        {
            anchorSegments.Clear();
            bool requested = physicalProfile.anchoringMode == FrameActionProceduralRigidAnchoringMode2D.TerrainAttached;
            for (int index = 0; index < outline.Count; index++)
            {
                bool authored = source.edgeRoles != null
                    && index < source.edgeRoles.Length
                    && source.edgeRoles[index] == FrameActionProceduralRigidEdgeRole.TerrainAttached;
                if (!authored) continue;
                requested = true;
                anchorSegments.Add(new AnchorSegment(outline[index], outline[(index + 1) % outline.Count]));
            }
            terrainAnchored = requested && anchorSegments.Count > 0;
        }

        private void CopyAnchorsForPiece(
            IReadOnlyList<AnchorSegment> parentAnchors,
            IReadOnlyList<Vector2> boundary,
            Vector2 newOrigin)
        {
            anchorSegments.Clear();
            for (int edgeIndex = 0; edgeIndex < boundary.Count; edgeIndex++)
            {
                Vector2 start = boundary[edgeIndex];
                Vector2 end = boundary[(edgeIndex + 1) % boundary.Count];
                for (int anchorIndex = 0; anchorIndex < parentAnchors.Count; anchorIndex++)
                {
                    AnchorSegment anchor = parentAnchors[anchorIndex];
                    if (!SegmentLiesOnSegment(start, end, anchor.Start, anchor.End)) continue;
                    anchorSegments.Add(new AnchorSegment(start - newOrigin, end - newOrigin));
                    break;
                }
            }
        }

        private void AuditTerrainAnchors()
        {
            if (anchorSegments.Count == 0)
            {
                ReleaseTerrainAnchor();
                return;
            }
            float radius = 1.5f / Mathf.Max(1f, geometry.SourcePixelsPerUnit);
            bool supported = false;
            for (int anchorIndex = 0; anchorIndex < anchorSegments.Count && !supported; anchorIndex++)
            {
                AnchorSegment anchor = anchorSegments[anchorIndex];
                Vector2 worldPoint = transform.TransformPoint((anchor.Start + anchor.End) * 0.5f);
                ContactFilter2D filter = ContactFilter2D.noFilter;
                int count = Physics2D.OverlapCircle(worldPoint, radius, filter, anchorOverlapResults);
                for (int index = 0; index < count; index++)
                {
                    Collider2D candidate = anchorOverlapResults[index];
                    anchorOverlapResults[index] = null;
                    if (candidate == null || candidate == polygonCollider || candidate.isTrigger) continue;
                    FrameActionProceduralRigidBodyCore2D rigid =
                        candidate.GetComponentInParent<FrameActionProceduralRigidBodyCore2D>();
                    if (rigid != null && rigid.familyId == familyId) continue;
                    supported = true;
                    break;
                }
            }
            missingAnchorAudits = supported ? 0 : missingAnchorAudits + 1;
            if (missingAnchorAudits >= AnchorLossAuditCount) ReleaseTerrainAnchor();
        }

        private void RegisterFamily()
        {
            if (familyRegistered || familyId == 0u) return;
            ActiveFamilyCounts.TryGetValue(familyId, out int count);
            ActiveFamilyCounts[familyId] = count + 1;
            familyRegistered = true;
        }

        private void UnregisterFamily()
        {
            if (!familyRegistered || familyId == 0u) return;
            if (ActiveFamilyCounts.TryGetValue(familyId, out int count))
            {
                if (count <= 1) ActiveFamilyCounts.Remove(familyId);
                else ActiveFamilyCounts[familyId] = count - 1;
            }
            familyRegistered = false;
        }

        private static int GetFamilyCount(uint id)
        {
            return id != 0u && ActiveFamilyCounts.TryGetValue(id, out int count) ? count : 0;
        }

        private static int ResolvePerImpactBudget(FrameActionProceduralRigidFractureSettings2D settings)
        {
            return Mathf.Clamp(settings.maxFragmentsPerImpact <= 0 ? 8 : settings.maxFragmentsPerImpact, 2, 8);
        }

        private static int ResolveFamilyBudget(FrameActionProceduralRigidFractureSettings2D settings)
        {
            return Mathf.Clamp(settings.maxActiveFragmentsPerFamily <= 0 ? 48 : settings.maxActiveFragmentsPerFamily, 4, 256);
        }

        private static int ComparePiecesLargestFirst(
            FrameActionProceduralRigidFracturePiece2D first,
            FrameActionProceduralRigidFracturePiece2D second)
        {
            int area = second.Area.CompareTo(first.Area);
            if (area != 0) return area;
            int x = first.Centroid.x.CompareTo(second.Centroid.x);
            return x != 0 ? x : first.Centroid.y.CompareTo(second.Centroid.y);
        }

        private static PhysicsMaterial2D ResolvePhysicsMaterial(float friction, float restitution)
        {
            int frictionKey = Mathf.RoundToInt(Mathf.Clamp01(friction) * 100f);
            int restitutionKey = Mathf.RoundToInt(Mathf.Clamp01(restitution) * 100f);
            int key = frictionKey * 101 + restitutionKey;
            if (PhysicsMaterials.TryGetValue(key, out PhysicsMaterial2D material) && material != null) return material;
            material = new PhysicsMaterial2D($"SpriteCue Rigid {frictionKey}:{restitutionKey}")
            {
                friction = frictionKey / 100f,
                bounciness = restitutionKey / 100f,
                hideFlags = HideFlags.HideAndDontSave,
            };
            PhysicsMaterials[key] = material;
            return material;
        }

        private static bool SegmentLiesOnSegment(Vector2 a, Vector2 b, Vector2 start, Vector2 end)
        {
            Vector2 axis = end - start;
            float lengthSquared = axis.sqrMagnitude;
            if (lengthSquared <= Epsilon) return false;
            float tolerance = Mathf.Sqrt(lengthSquared) * 0.0002f + 0.00001f;
            if (Mathf.Abs(Cross(axis, a - start)) > tolerance
                || Mathf.Abs(Cross(axis, b - start)) > tolerance) return false;
            float first = Vector2.Dot(a - start, axis) / lengthSquared;
            float second = Vector2.Dot(b - start, axis) / lengthSquared;
            return Mathf.Max(first, second) >= -0.0001f && Mathf.Min(first, second) <= 1.0001f;
        }

        private float EstimateContactSpan()
        {
            return Mathf.Max(1f / Mathf.Max(1f, geometry.SourcePixelsPerUnit), Mathf.Sqrt(Mathf.Max(Epsilon, areaWorld)) * 0.08f);
        }

        private float ResolveChipEnergy(FrameActionProceduralRigidFractureSettings2D settings)
        {
            if (settings.landingChipEnergy > 0f) return settings.landingChipEnergy;
            return FrameActionProceduralRigidPhysicsMath2D.DefaultChipEnergyJoules
                * Mathf.Lerp(0.65f, 1.65f, physicalProfile.hardness);
        }

        private float ResolveCrackEnergy(
            FrameActionProceduralRigidFractureSettings2D settings,
            float chip)
        {
            if (settings.landingCrackEnergy > 0f) return Mathf.Max(chip, settings.landingCrackEnergy);
            float profileScale = Mathf.Lerp(0.65f, 1.85f, physicalProfile.toughness)
                * Mathf.Lerp(1.20f, 0.82f, physicalProfile.brittleness);
            return Mathf.Max(chip,
                FrameActionProceduralRigidPhysicsMath2D.DefaultCrackEnergyJoules * profileScale);
        }

        private float ResolveBreakEnergy(
            FrameActionProceduralRigidFractureSettings2D settings,
            float crack)
        {
            if (settings.landingBreakEnergy > 0f) return Mathf.Max(crack, settings.landingBreakEnergy);
            float profileScale = Mathf.Lerp(0.55f, 2.20f,
                    Mathf.Sqrt(physicalProfile.hardness * physicalProfile.toughness))
                * Mathf.Lerp(1.35f, 0.72f, physicalProfile.brittleness);
            float fallback = settings.collisionBreakThreshold > 0f
                ? Mathf.Max(FrameActionProceduralRigidPhysicsMath2D.DefaultBreakEnergyJoules,
                    settings.collisionBreakThreshold * 0.46f)
                : FrameActionProceduralRigidPhysicsMath2D.DefaultBreakEnergyJoules;
            return Mathf.Max(crack, fallback * profileScale);
        }

        private void ResolveImpactThresholds(
            FrameActionProceduralRigidFractureSettings2D settings,
            FrameActionProceduralRigidImpactCause2D cause,
            out float chip,
            out float crack,
            out float fracture)
        {
            float landingChip = ResolveChipEnergy(settings);
            float landingCrack = ResolveCrackEnergy(settings, landingChip);
            float landingBreak = ResolveBreakEnergy(settings, landingCrack);
            if (cause == FrameActionProceduralRigidImpactCause2D.External)
            {
                chip = settings.impactChipEnergy > 0f ? settings.impactChipEnergy : landingChip;
                crack = settings.impactCrackEnergy > 0f ? settings.impactCrackEnergy : landingCrack;
                fracture = settings.impactBreakEnergy > 0f ? settings.impactBreakEnergy : landingBreak;
            }
            else if (cause == FrameActionProceduralRigidImpactCause2D.RigidBodyCollision)
            {
                chip = landingChip;
                crack = landingCrack;
                fracture = settings.collisionBreakThreshold > 0f
                    ? settings.collisionBreakThreshold
                    : landingBreak;
            }
            else
            {
                chip = landingChip;
                crack = landingCrack;
                fracture = landingBreak;
            }
            chip = Mathf.Max(0.001f, chip);
            crack = Mathf.Max(chip, crack);
            fracture = Mathf.Max(crack, fracture);
        }

        private static float ResolveStressSensitivity(FrameActionProceduralRigidFractureSettings2D settings)
        {
            return settings.contactStressSensitivity > 0f
                ? Mathf.Clamp(settings.contactStressSensitivity, 0f, 4f)
                : FrameActionProceduralRigidPhysicsMath2D.DefaultContactStressSensitivity;
        }

        private static int ResolveCooldownTicks(FrameActionProceduralRigidFractureSettings2D settings)
        {
            return settings.landingCooldownTicks > 0
                ? Mathf.Clamp(settings.landingCooldownTicks, 1, 120)
                : FrameActionProceduralRigidPhysicsMath2D.DefaultLandingCooldownTicks;
        }

        private static Vector2[] SanitizeClosedPath(IReadOnlyList<Vector2> points)
        {
            if (points == null || points.Count < 3) return Array.Empty<Vector2>();
            var result = new List<Vector2>(points.Count);
            for (int index = 0; index < points.Count; index++)
            {
                Vector2 point = points[index];
                if (result.Count == 0 || (result[result.Count - 1] - point).sqrMagnitude > Epsilon)
                    result.Add(point);
            }
            if (result.Count > 1 && (result[0] - result[result.Count - 1]).sqrMagnitude <= Epsilon)
                result.RemoveAt(result.Count - 1);
            if (result.Count < 3) return Array.Empty<Vector2>();
            if (SignedArea(result) < 0f) result.Reverse();
            return result.ToArray();
        }

        private static List<Vector2> ClipPolygon(
            IReadOnlyList<Vector2> source,
            Vector2 normal,
            float limit,
            bool keepLessOrEqual)
        {
            var output = new List<Vector2>(source.Count + 2);
            Vector2 previous = source[source.Count - 1];
            float previousDistance = Vector2.Dot(previous, normal) - limit;
            bool previousInside = keepLessOrEqual ? previousDistance <= 0f : previousDistance >= 0f;
            for (int index = 0; index < source.Count; index++)
            {
                Vector2 current = source[index];
                float currentDistance = Vector2.Dot(current, normal) - limit;
                bool currentInside = keepLessOrEqual ? currentDistance <= 0f : currentDistance >= 0f;
                if (currentInside != previousInside)
                {
                    float denominator = previousDistance - currentDistance;
                    float progress = Mathf.Abs(denominator) > Epsilon
                        ? Mathf.Clamp01(previousDistance / denominator)
                        : 0f;
                    output.Add(Vector2.Lerp(previous, current, progress));
                }
                if (currentInside) output.Add(current);
                previous = current;
                previousDistance = currentDistance;
                previousInside = currentInside;
            }
            return output;
        }

        private static float SignedArea(IReadOnlyList<Vector2> points)
        {
            float sum = 0f;
            for (int index = 0; index < points.Count; index++)
            {
                Vector2 next = points[(index + 1) % points.Count];
                sum += points[index].x * next.y - next.x * points[index].y;
            }
            return sum * 0.5f;
        }

        private static uint StableId(string sourceId, uint seed)
        {
            unchecked
            {
                uint hash = seed == 0u ? 2166136261u : seed;
                if (!string.IsNullOrEmpty(sourceId))
                {
                    for (int index = 0; index < sourceId.Length; index++)
                    {
                        hash ^= sourceId[index];
                        hash *= 16777619u;
                    }
                }
                return hash == 0u ? 1u : hash;
            }
        }

        private static uint Mix(uint seed, uint value)
        {
            unchecked
            {
                uint mixed = seed ^ (value + 1u) * 0x9e3779b9u;
                mixed ^= mixed >> 16;
                mixed *= 0x7feb352du;
                mixed ^= mixed >> 15;
                mixed *= 0x846ca68bu;
                mixed ^= mixed >> 16;
                return mixed == 0u ? 1u : mixed;
            }
        }

        private static float Cross(Vector2 first, Vector2 second)
        {
            return first.x * second.y - first.y * second.x;
        }

        private readonly struct AnchorSegment
        {
            public readonly Vector2 Start;
            public readonly Vector2 End;

            public AnchorSegment(Vector2 start, Vector2 end)
            {
                Start = start;
                End = end;
            }
        }
    }
}
