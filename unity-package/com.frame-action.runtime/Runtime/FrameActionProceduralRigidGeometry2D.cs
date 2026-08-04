using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace FrameAction
{
    /// <summary>
    /// A single local-space structural triangle plus immutable authoring-space texture
    /// coordinates. Geometry may be recentered for a Rigidbody; the authoring coordinates must
    /// remain unchanged so a mother body and all of its fragments retain one continuous look.
    /// </summary>
    [Serializable]
    public struct FrameActionProceduralRigidVisualFacet2D
    {
        public int Id;
        public Vector2 A;
        public Vector2 B;
        public Vector2 C;
        public Vector2 AuthoringUvA;
        public Vector2 AuthoringUvB;
        public Vector2 AuthoringUvC;
        [Range(0f, 1f)] public float Shade;

        public FrameActionProceduralRigidVisualFacet2D(
            int id,
            Vector2 a,
            Vector2 b,
            Vector2 c,
            Vector2 authoringUvA,
            Vector2 authoringUvB,
            Vector2 authoringUvC,
            float shade)
        {
            Id = id;
            A = a;
            B = b;
            C = c;
            AuthoringUvA = authoringUvA;
            AuthoringUvB = authoringUvB;
            AuthoringUvC = authoringUvC;
            Shade = Mathf.Clamp01(shade);
        }

        public float Area => Mathf.Abs(Cross(B - A, C - A)) * 0.5f;
        public Vector2 Centroid => (A + B + C) / 3f;

        internal void TranslateGeometry(Vector2 offset)
        {
            A -= offset;
            B -= offset;
            C -= offset;
        }

        internal void EnsureCounterClockwise()
        {
            if (Cross(B - A, C - A) >= 0f) return;
            Swap(ref B, ref C);
            Swap(ref AuthoringUvB, ref AuthoringUvC);
        }

        private static float Cross(Vector2 first, Vector2 second)
        {
            return first.x * second.y - first.y * second.x;
        }

        private static void Swap(ref Vector2 first, ref Vector2 second)
        {
            Vector2 value = first;
            first = second;
            second = value;
        }
    }

    /// <summary>Explicit local-space fracture line. It is presentation data, not damage state.</summary>
    [Serializable]
    public struct FrameActionProceduralRigidCrackSegment2D
    {
        public Vector2 A;
        public Vector2 B;
        [Range(0f, 1f)] public float Strength;

        public FrameActionProceduralRigidCrackSegment2D(Vector2 a, Vector2 b, float strength = 1f)
        {
            A = a;
            B = b;
            Strength = Mathf.Clamp01(strength);
        }

        internal void TranslateGeometry(Vector2 offset)
        {
            A -= offset;
            B -= offset;
        }
    }

    /// <summary>
    /// Project-independent SpriteCue program-rigid presenter. It owns a deterministic mesh and
    /// material only. Damage, reactions, Rigidbody motion, collider construction and fragment
    /// lifetime remain responsibilities of the consuming game.
    ///
    /// Mesh construction occurs only through explicit initialization/rebuild calls. The class
    /// deliberately has no Update/LateUpdate and performs no steady-state managed allocation.
    /// </summary>
    [DisallowMultipleComponent]
    [RequireComponent(typeof(MeshFilter), typeof(MeshRenderer))]
    public class FrameActionProceduralRigidGeometry2D : MonoBehaviour
    {
        public const string ShaderName = "FrameAction/Procedural Rigid Body";
        public const string MaterialResourcePath = "FrameAction/ProceduralRigidBody";

        private const float MinimumPixelsPerUnit = 1f;
        private const float PointQuantization = 100000f;

        private static readonly int AppearanceSeedId = Shader.PropertyToID("_AppearanceSeed");
        private static readonly int TextureStrengthId = Shader.PropertyToID("_TextureStrength");
        private static readonly int EdgeBrightnessId = Shader.PropertyToID("_EdgeBrightness");
        private static readonly int FacetVariationId = Shader.PropertyToID("_FacetVariation");
        private static readonly int VolumeDepthId = Shader.PropertyToID("_VolumeDepth");
        private static readonly int TransmissionId = Shader.PropertyToID("_Transmission");
        private static readonly int AbsorptionId = Shader.PropertyToID("_Absorption");
        private static readonly int EdgeWidthPixelsId = Shader.PropertyToID("_EdgeWidthPixels");
        private static readonly int SpecularStrengthId = Shader.PropertyToID("_SpecularStrength");
        private static readonly int InclusionDensityId = Shader.PropertyToID("_InclusionDensity");
        private static readonly int MicroCrackDensityId = Shader.PropertyToID("_MicroCrackDensity");
        private static readonly int WorldLightDirectionId = Shader.PropertyToID("_WorldLightDirection");
        private static readonly int TemplateId = Shader.PropertyToID("_Template");
        private static readonly int BaseColorId = Shader.PropertyToID("_BaseColor");
        private static readonly int ShadowColorId = Shader.PropertyToID("_ShadowColor");
        private static readonly int HighlightColorId = Shader.PropertyToID("_HighlightColor");
        private static readonly int EdgeColorId = Shader.PropertyToID("_EdgeColor");
        private static readonly int FractureColorId = Shader.PropertyToID("_FractureColor");
        private static readonly int OpacityId = Shader.PropertyToID("_Opacity");
        private static readonly int RoughnessId = Shader.PropertyToID("_Roughness");
        private static readonly int GrainDirectionId = Shader.PropertyToID("_GrainDirection");
        private static readonly int AnisotropyId = Shader.PropertyToID("_Anisotropy");
        private static readonly int UseSourceTextureId = Shader.PropertyToID("_UseSourceTexture");
        private static readonly int SourceTextureId = Shader.PropertyToID("_SourceTexture");
        private static readonly int SourceTextureTransformId = Shader.PropertyToID("_SourceTextureTransform");

        [SerializeField] private uint appearanceSeed = 1;
        [SerializeField] private float sourcePixelsPerUnit = 100f;
        [SerializeField] private FrameActionProceduralRigidVisualSettings2D visualSettings;
        [SerializeField] private FrameActionProceduralRigidFractureSettings2D fractureSettings;
        [SerializeField] private Texture2D sourceTexture;
        [SerializeField] private Vector4 sourceTextureTransform;
        [SerializeField] private FrameActionProceduralRigidVisualFacet2D[] facets = Array.Empty<FrameActionProceduralRigidVisualFacet2D>();
        [SerializeField] private Vector2[] exactOutline = Array.Empty<Vector2>();
        [SerializeField] private Vector2[] exactOutlineAuthoringUvs = Array.Empty<Vector2>();
        [SerializeField] private FrameActionProceduralRigidEdgeRole[] exactOutlineRoles = Array.Empty<FrameActionProceduralRigidEdgeRole>();
        [SerializeField] private FrameActionProceduralRigidCrackSegment2D[] cracks = Array.Empty<FrameActionProceduralRigidCrackSegment2D>();

        private readonly List<Vector3> vertices = new List<Vector3>(256);
        private readonly List<Color> colors = new List<Color>(256);
        private readonly List<Vector2> authoringCoordinates = new List<Vector2>(256);
        private readonly List<Vector2> styleCoordinates = new List<Vector2>(256);
        private readonly List<Vector2> opticalCoordinates = new List<Vector2>(256);
        private readonly List<int> triangleIndices = new List<int>(384);
        private readonly List<RuntimeEdge> edges = new List<RuntimeEdge>(128);
        private readonly Dictionary<EdgeKey, int> edgeLookup = new Dictionary<EdgeKey, int>(128);

        private Mesh runtimeMesh;
        private Material runtimeMaterial;
        private Material packageMaterial;
        private Material materialOverride;
        private MaterialPropertyBlock propertyBlock;
        private MeshFilter meshFilter;
        private MeshRenderer meshRenderer;
        private int currentSortingLayerId;
        private int currentSortingOrder;
        private bool isReady;
        private string lastVisualError;

        public bool IsReady => isReady;
        public uint AppearanceSeed => appearanceSeed;
        public float SourcePixelsPerUnit => sourcePixelsPerUnit;
        public FrameActionProceduralRigidVisualSettings2D VisualSettings => visualSettings;
        public FrameActionProceduralRigidTemplate2D Template => visualSettings.ResolveTemplate();
        public FrameActionProceduralRigidFractureSettings2D FractureSettings => fractureSettings;
        public Texture2D SourceTexture => sourceTexture;
        public Vector4 SourceTextureTransform => sourceTextureTransform;
        public int FacetCount => facets?.Length ?? 0;
        public int CrackCount => cracks?.Length ?? 0;
        public string LastVisualError => lastVisualError;

        public FrameActionProceduralRigidVisualFacet2D GetFacet(int index)
        {
            if (facets == null || (uint)index >= (uint)facets.Length)
                throw new ArgumentOutOfRangeException(nameof(index));
            return facets[index];
        }

        public FrameActionProceduralRigidCrackSegment2D GetCrack(int index)
        {
            if (cracks == null || (uint)index >= (uint)cracks.Length)
                throw new ArgumentOutOfRangeException(nameof(index));
            return cracks[index];
        }

        /// <summary>
        /// Initializes the mother body. Authoring UVs are measured in source pixels relative to
        /// its authored pivot; they intentionally do not follow later local recenter operations.
        /// </summary>
        public void InitializeFromAuthoring(FrameActionProceduralRigidSource2D source)
        {
            if (source == null) throw new ArgumentNullException(nameof(source));

            appearanceSeed = source.seed == 0 ? 1u : source.seed;
            sourcePixelsPerUnit = Mathf.Max(MinimumPixelsPerUnit, source.sourcePixelsPerUnit);
            FrameActionProceduralRigidVisualSettings2D authoredVisual = source.visual;
            if (string.IsNullOrWhiteSpace(authoredVisual.templateId))
                authoredVisual.templateId = source.templateId;
            visualSettings = authoredVisual.NormalizedForRendering();
            CaptureSourceTexture(source.sourceSprite);
            fractureSettings = source.fracture;
            facets = CopyAuthoringFacets(source.facets, source.localOutline, sourcePixelsPerUnit, appearanceSeed);
            exactOutline = ClonePoints(source.localOutline);
            exactOutlineAuthoringUvs = CreateAuthoringCoordinates(exactOutline, sourcePixelsPerUnit);
            exactOutlineRoles = CloneRoles(source.edgeRoles, exactOutline.Length);
            cracks = Array.Empty<FrameActionProceduralRigidCrackSegment2D>();
            isReady = facets.Length > 0;
            lastVisualError = null;
        }

        /// <summary>
        /// Initializes a fragment from triangles copied from its mother. Pass the mother's
        /// AppearanceSeed, not a new physical fragment ID. Each facet already carries the
        /// immutable authoring UVs needed to keep transmission, inclusions and micro-cracks
        /// continuous across the fracture.
        /// </summary>
        public void InitializeFragment(
            uint motherAppearanceSeed,
            float pixelsPerUnit,
            FrameActionProceduralRigidVisualSettings2D visual,
            FrameActionProceduralRigidFractureSettings2D fracture,
            IReadOnlyList<FrameActionProceduralRigidVisualFacet2D> fragmentFacets)
        {
            InitializeFragment(motherAppearanceSeed, pixelsPerUnit, visual, fracture, fragmentFacets, null, Vector4.zero);
        }

        public void InitializeFragment(
            uint motherAppearanceSeed,
            float pixelsPerUnit,
            FrameActionProceduralRigidVisualSettings2D visual,
            FrameActionProceduralRigidFractureSettings2D fracture,
            IReadOnlyList<FrameActionProceduralRigidVisualFacet2D> fragmentFacets,
            Texture2D motherSourceTexture,
            Vector4 motherSourceTextureTransform)
        {
            if (fragmentFacets == null) throw new ArgumentNullException(nameof(fragmentFacets));

            appearanceSeed = motherAppearanceSeed == 0 ? 1u : motherAppearanceSeed;
            sourcePixelsPerUnit = Mathf.Max(MinimumPixelsPerUnit, pixelsPerUnit);
            visualSettings = visual.NormalizedForRendering();
            sourceTexture = visualSettings.sourceMode == "sourceImage" ? motherSourceTexture : null;
            sourceTextureTransform = sourceTexture != null ? motherSourceTextureTransform : Vector4.zero;
            fractureSettings = fracture;
            facets = new FrameActionProceduralRigidVisualFacet2D[fragmentFacets.Count];
            for (int index = 0; index < facets.Length; index++)
            {
                facets[index] = fragmentFacets[index];
                facets[index].EnsureCounterClockwise();
            }
            exactOutline = Array.Empty<Vector2>();
            exactOutlineAuthoringUvs = Array.Empty<Vector2>();
            exactOutlineRoles = Array.Empty<FrameActionProceduralRigidEdgeRole>();
            cracks = Array.Empty<FrameActionProceduralRigidCrackSegment2D>();
            isReady = facets.Length > 0;
            lastVisualError = null;
        }

        /// <summary>
        /// Subtracts a centroid/pivot from physical geometry only. Authoring UVs and appearance
        /// seed remain unchanged, which is the continuity guarantee for independently moving
        /// fragments.
        /// </summary>
        public void TranslateLocal(Vector2 offset)
        {
            for (int index = 0; index < FacetCount; index++)
            {
                FrameActionProceduralRigidVisualFacet2D facet = facets[index];
                facet.TranslateGeometry(offset);
                facets[index] = facet;
            }
            for (int index = 0; index < exactOutline.Length; index++) exactOutline[index] -= offset;
            for (int index = 0; index < CrackCount; index++)
            {
                FrameActionProceduralRigidCrackSegment2D crack = cracks[index];
                crack.TranslateGeometry(offset);
                cracks[index] = crack;
            }
        }

        public Vector2 CalculateAreaWeightedCentroid()
        {
            double weightedX = 0d;
            double weightedY = 0d;
            double totalArea = 0d;
            for (int index = 0; index < FacetCount; index++)
            {
                float area = facets[index].Area;
                Vector2 center = facets[index].Centroid;
                weightedX += center.x * area;
                weightedY += center.y * area;
                totalArea += area;
            }
            return totalArea <= 0.0000001d
                ? Vector2.zero
                : new Vector2((float)(weightedX / totalArea), (float)(weightedY / totalArea));
        }

        /// <summary>
        /// Optional explicit material. It must use the package shader; incompatible materials are
        /// rejected visibly rather than silently changing the appearance contract.
        /// </summary>
        public bool SetMaterialOverride(Material value)
        {
            if (value != null && (value.shader == null || value.shader.name != ShaderName))
            {
                ReportVisualError($"Material override must use shader '{ShaderName}'.", value);
                return false;
            }
            materialOverride = value;
            if (meshRenderer != null && value != null) meshRenderer.sharedMaterial = value;
            return true;
        }

        /// <summary>
        /// Replaces visual material coefficients without changing imported geometry, fracture
        /// settings, source texture coordinates or accumulated cracks.
        /// </summary>
        public bool ApplyRuntimeVisualSettings(FrameActionProceduralRigidVisualSettings2D value)
        {
            if (!isReady) return false;
            visualSettings = value.NormalizedForRendering();
            return RebuildVisual(currentSortingLayerId, currentSortingOrder);
        }

        /// <summary>
        /// Clips the generic visual facet set against one local-space half plane. This is a
        /// geometry operation only: consuming games decide why material was removed and what the
        /// removed material becomes. Authoring UVs are interpolated at every new cut vertex so an
        /// imported source image remains continuous while the body is trimmed.
        /// </summary>
        internal bool TryClipFacets(Vector2 normal, float limit, bool keepLessOrEqual)
        {
            if (!isReady || facets == null || facets.Length == 0 || normal.sqrMagnitude <= 0.0000001f)
                return false;
            normal.Normalize();
            var clippedFacets = new List<FrameActionProceduralRigidVisualFacet2D>(facets.Length + 8);
            for (int index = 0; index < facets.Length; index++)
                ClipFacet(facets[index], normal, limit, keepLessOrEqual, clippedFacets);
            if (clippedFacets.Count == 0) return false;

            var clippedCracks = new List<FrameActionProceduralRigidCrackSegment2D>(cracks?.Length ?? 0);
            for (int index = 0; index < CrackCount; index++)
            {
                if (TryClipSegment(cracks[index], normal, limit, keepLessOrEqual,
                        out FrameActionProceduralRigidCrackSegment2D clipped))
                    clippedCracks.Add(clipped);
            }

            facets = clippedFacets.ToArray();
            cracks = clippedCracks.ToArray();
            // The former exact rim describes the pre-cut mother silhouette. Boundary edges from
            // the clipped facet set now provide the authoritative physical and visual outline.
            exactOutline = Array.Empty<Vector2>();
            exactOutlineAuthoringUvs = Array.Empty<Vector2>();
            exactOutlineRoles = Array.Empty<FrameActionProceduralRigidEdgeRole>();
            isReady = true;
            return true;
        }

        public void ShowCracks(IReadOnlyList<FrameActionProceduralRigidCrackSegment2D> localSegments)
        {
            if (localSegments == null || localSegments.Count == 0)
            {
                ClearCracks();
                return;
            }
            if (cracks == null || cracks.Length != localSegments.Count)
                cracks = new FrameActionProceduralRigidCrackSegment2D[localSegments.Count];
            for (int index = 0; index < cracks.Length; index++)
            {
                cracks[index] = localSegments[index];
                cracks[index].Strength = Mathf.Clamp01(cracks[index].Strength);
            }
            if (isReady) RebuildVisual(currentSortingLayerId, currentSortingOrder);
        }

        /// <summary>Adds deterministic damage paths without erasing cracks from earlier hits.</summary>
        public void AppendCracks(
            IReadOnlyList<FrameActionProceduralRigidCrackSegment2D> localSegments,
            int maximumSegments = 96)
        {
            if (localSegments == null || localSegments.Count == 0) return;
            maximumSegments = Mathf.Clamp(maximumSegments, 8, 256);
            int appendCount = Mathf.Min(localSegments.Count, maximumSegments);
            int existingCount = cracks?.Length ?? 0;
            int keepCount = Mathf.Min(existingCount, maximumSegments - appendCount);
            int existingStart = Mathf.Max(0, existingCount - keepCount);
            var combined = new FrameActionProceduralRigidCrackSegment2D[keepCount + appendCount];
            for (int index = 0; index < keepCount; index++)
                combined[index] = cracks[existingStart + index];
            for (int index = 0; index < appendCount; index++)
            {
                combined[keepCount + index] = localSegments[index];
                combined[keepCount + index].Strength = Mathf.Clamp01(combined[keepCount + index].Strength);
            }
            cracks = combined;
            if (isReady) RebuildVisual(currentSortingLayerId, currentSortingOrder);
        }

        public void ClearCracks()
        {
            if (cracks == null || cracks.Length == 0) return;
            cracks = Array.Empty<FrameActionProceduralRigidCrackSegment2D>();
            if (isReady) RebuildVisual(currentSortingLayerId, currentSortingOrder);
        }

        /// <summary>Rebuilds all visual layers. Returns false and emits an error if the package shader is unavailable.</summary>
        public bool RebuildVisual(int sortingLayerId, int sortingOrder)
        {
            currentSortingLayerId = sortingLayerId;
            currentSortingOrder = sortingOrder;
            if (!EnsureComponentsAndMaterial()) return false;

            if (!isReady || facets == null || facets.Length == 0)
            {
                runtimeMesh.Clear(false);
                meshRenderer.enabled = false;
                return false;
            }

            ClearBuildBuffers();
            for (int index = 0; index < facets.Length; index++)
            {
                RegisterEdge(facets[index].A, facets[index].B, facets[index].AuthoringUvA, facets[index].AuthoringUvB);
                RegisterEdge(facets[index].B, facets[index].C, facets[index].AuthoringUvB, facets[index].AuthoringUvC);
                RegisterEdge(facets[index].C, facets[index].A, facets[index].AuthoringUvC, facets[index].AuthoringUvA);
            }
            for (int index = 0; index < facets.Length; index++) AppendFacet(facets[index]);

            float pixel = 1f / sourcePixelsPerUnit;
            float seamWidth = Mathf.Max(pixel * 0.30f, 0.00075f);
            for (int index = 0; index < edges.Count; index++)
            {
                RuntimeEdge edge = edges[index];
                if (edge.Count == 1 && exactOutline.Length >= 3) continue;
                if (edge.Count == 1)
                {
                    float fragmentRimWidth = pixel * visualSettings.edgeWidthPixels;
                    // Every authored triangle is counter-clockwise, so its interior lies on the
                    // left side of a boundary edge. Keeping the frost geometry inside the true
                    // polygon avoids a bright visual halo larger than the physics collider.
                    AppendInwardRim(edge.A, edge.B, edge.UvA, edge.UvB, fragmentRimWidth, 1f, true);
                }
                else
                {
                    float variant = HashUnit(appearanceSeed ^ unchecked((uint)index * 0x9e3779b9u));
                    Color seam = visualSettings.edgeColor;
                    // Opacity is applied exactly once by the shader. Pre-multiplying these
                    // authored alpha weights here made seams/rims fade twice after sync.
                    seam.a = Mathf.Lerp(0.13f, 0.38f, visualSettings.facetVariation);
                    AppendCenteredLine(edge.A, edge.B, edge.UvA, edge.UvB, seamWidth, seam, 1f, variant);
                }
            }

            if (exactOutline.Length >= 3) AppendExactOutlineRim(pixel);

            float crackWidth = Mathf.Max(pixel * 0.72f, 0.0015f);
            for (int index = 0; index < CrackCount; index++)
            {
                FrameActionProceduralRigidCrackSegment2D crack = cracks[index];
                float strength = Mathf.Lerp(0.35f, 1f, crack.Strength);
                Vector2 uvA = crack.A * sourcePixelsPerUnit;
                Vector2 uvB = crack.B * sourcePixelsPerUnit;
                AppendCenteredLine(crack.A, crack.B, uvA, uvB,
                    crackWidth * Mathf.Lerp(0.65f, 1.6f, strength),
                    new Color(
                        visualSettings.fractureColor.r,
                        visualSettings.fractureColor.g,
                        visualSettings.fractureColor.b,
                        Mathf.Lerp(0.55f, 1f, strength)),
                    3f, strength);
            }

            runtimeMesh.Clear(false);
            runtimeMesh.SetVertices(vertices);
            runtimeMesh.SetColors(colors);
            runtimeMesh.SetUVs(0, authoringCoordinates);
            runtimeMesh.SetUVs(1, styleCoordinates);
            runtimeMesh.SetUVs(2, opticalCoordinates);
            runtimeMesh.SetTriangles(triangleIndices, 0, true);
            runtimeMesh.RecalculateBounds();
            meshRenderer.enabled = true;
            meshRenderer.sortingLayerID = sortingLayerId;
            meshRenderer.sortingOrder = sortingOrder;
            ApplyMaterialProperties();
            lastVisualError = null;
            return true;
        }

        private void OnDestroy()
        {
            Release(runtimeMesh);
            Release(runtimeMaterial);
        }

        private bool EnsureComponentsAndMaterial()
        {
            if (meshFilter == null) meshFilter = GetComponent<MeshFilter>();
            if (meshRenderer == null) meshRenderer = GetComponent<MeshRenderer>();
            if (runtimeMesh == null)
            {
                runtimeMesh = new Mesh { name = $"SpriteCue Program Rigid [{name}]", hideFlags = HideFlags.DontSave };
                runtimeMesh.MarkDynamic();
                meshFilter.sharedMesh = runtimeMesh;
            }

            Material selected = materialOverride;
            if (selected == null)
            {
                if (packageMaterial == null)
                    packageMaterial = Resources.Load<Material>(MaterialResourcePath);
                if (packageMaterial != null)
                {
                    selected = packageMaterial;
                }
                else
                {
                    Shader shader = Shader.Find(ShaderName);
                    if (shader == null || !shader.isSupported)
                    {
                        string reason = shader == null ? "was not found" : "is unsupported by the active renderer";
                        ReportVisualError($"Required shader '{ShaderName}' {reason}. The program-rigid renderer was disabled.", this);
                        meshRenderer.enabled = false;
                        return false;
                    }
                    if (runtimeMaterial == null)
                    {
                        runtimeMaterial = new Material(shader)
                        {
                            name = $"SpriteCue Program Rigid [{name}]",
                            hideFlags = HideFlags.DontSave,
                        };
                    }
                    selected = runtimeMaterial;
                }
            }

            if (selected.shader == null || selected.shader.name != ShaderName || !selected.shader.isSupported)
            {
                ReportVisualError($"Resolved material must use supported shader '{ShaderName}'.", selected);
                meshRenderer.enabled = false;
                return false;
            }

            meshRenderer.sharedMaterial = selected;
            meshRenderer.shadowCastingMode = ShadowCastingMode.Off;
            meshRenderer.receiveShadows = false;
            meshRenderer.lightProbeUsage = LightProbeUsage.Off;
            meshRenderer.reflectionProbeUsage = ReflectionProbeUsage.Off;
            if (propertyBlock == null) propertyBlock = new MaterialPropertyBlock();
            return true;
        }

        private void ApplyMaterialProperties()
        {
            propertyBlock.Clear();
            propertyBlock.SetFloat(AppearanceSeedId, (appearanceSeed & 0x00ffffffu) / 16777215f);
            propertyBlock.SetFloat(TextureStrengthId, Mathf.Clamp01(visualSettings.textureStrength));
            propertyBlock.SetFloat(EdgeBrightnessId, Mathf.Clamp01(visualSettings.edgeBrightness));
            propertyBlock.SetFloat(FacetVariationId, Mathf.Clamp01(visualSettings.facetVariation));
            propertyBlock.SetFloat(VolumeDepthId, visualSettings.volumeDepth);
            propertyBlock.SetFloat(TransmissionId, visualSettings.transmission);
            propertyBlock.SetFloat(AbsorptionId, visualSettings.absorption);
            propertyBlock.SetFloat(EdgeWidthPixelsId, visualSettings.edgeWidthPixels);
            propertyBlock.SetFloat(SpecularStrengthId, visualSettings.specularStrength);
            propertyBlock.SetFloat(InclusionDensityId, visualSettings.inclusionDensity);
            propertyBlock.SetFloat(MicroCrackDensityId, visualSettings.microCrackDensity);
            propertyBlock.SetFloat(TemplateId, (float)visualSettings.ResolveTemplate());
            propertyBlock.SetColor(BaseColorId, visualSettings.baseColor);
            propertyBlock.SetColor(ShadowColorId, visualSettings.shadowColor);
            propertyBlock.SetColor(HighlightColorId, visualSettings.highlightColor);
            propertyBlock.SetColor(EdgeColorId, visualSettings.edgeColor);
            propertyBlock.SetColor(FractureColorId, visualSettings.fractureColor);
            propertyBlock.SetFloat(OpacityId, visualSettings.opacity);
            propertyBlock.SetFloat(RoughnessId, visualSettings.roughness);
            float grainRadians = visualSettings.grainDirectionDegrees * Mathf.Deg2Rad;
            propertyBlock.SetVector(GrainDirectionId, new Vector4(Mathf.Cos(grainRadians), Mathf.Sin(grainRadians), 0f, 0f));
            propertyBlock.SetFloat(AnisotropyId, visualSettings.anisotropy);
            bool useSourceTexture = visualSettings.sourceMode == "sourceImage" && sourceTexture != null;
            propertyBlock.SetFloat(UseSourceTextureId, useSourceTexture ? 1f : 0f);
            propertyBlock.SetTexture(SourceTextureId, useSourceTexture ? sourceTexture : Texture2D.whiteTexture);
            propertyBlock.SetVector(SourceTextureTransformId, sourceTextureTransform);
            float lightRadians = visualSettings.lightAngleDegrees * Mathf.Deg2Rad;
            Vector3 lightDirection = new Vector3(Mathf.Cos(lightRadians), Mathf.Sin(lightRadians), 1.35f).normalized;
            propertyBlock.SetVector(WorldLightDirectionId, new Vector4(lightDirection.x, lightDirection.y, lightDirection.z, 0f));
            meshRenderer.SetPropertyBlock(propertyBlock);
        }

        private void CaptureSourceTexture(Sprite sprite)
        {
            sourceTexture = null;
            sourceTextureTransform = Vector4.zero;
            if (visualSettings.sourceMode != "sourceImage" || sprite == null || sprite.texture == null) return;

            Texture2D texture = sprite.texture;
            Rect rect = sprite.rect;
            Vector2 pivot = sprite.pivot;
            sourceTexture = texture;
            sourceTextureTransform = new Vector4(
                1f / Mathf.Max(1f, texture.width),
                1f / Mathf.Max(1f, texture.height),
                (rect.x + pivot.x) / Mathf.Max(1f, texture.width),
                (rect.y + pivot.y) / Mathf.Max(1f, texture.height));
        }

        private void ClearBuildBuffers()
        {
            vertices.Clear();
            colors.Clear();
            authoringCoordinates.Clear();
            styleCoordinates.Clear();
            opticalCoordinates.Clear();
            triangleIndices.Clear();
            edges.Clear();
            edgeLookup.Clear();
        }

        private void AppendFacet(FrameActionProceduralRigidVisualFacet2D facet)
        {
            int baseIndex = vertices.Count;
            uint hash = Hash(appearanceSeed ^ unchecked((uint)facet.Id * 0x9e3779b9u));
            float random = ((hash >> 8) & 1023u) / 1023f;
            float tone = Mathf.Clamp01(Mathf.Lerp(facet.Shade, random, visualSettings.facetVariation * 0.46f));
            float pseudoNormalAngle = (hash & 0xffffu) / 65535f;
            Color deep = visualSettings.shadowColor;
            Color cyan = visualSettings.baseColor;
            Color highlight = visualSettings.highlightColor;
            Color color = tone < 0.58f
                ? Color.Lerp(deep, cyan, tone / 0.58f)
                : Color.Lerp(cyan, highlight, (tone - 0.58f) / 0.42f);
            // One colour per facet. Previous per-vertex brightness gradients could visually join
            // into fan-like rays on long triangles even when the topology itself had no centre.
            // Volume now comes from the facet normal and authoring-space optical field instead.
            AppendFillVertex(facet.A, facet.AuthoringUvA, color, pseudoNormalAngle, CalculateOpticalThickness(facet.A));
            AppendFillVertex(facet.B, facet.AuthoringUvB, color, pseudoNormalAngle, CalculateOpticalThickness(facet.B));
            AppendFillVertex(facet.C, facet.AuthoringUvC, color, pseudoNormalAngle, CalculateOpticalThickness(facet.C));
            triangleIndices.Add(baseIndex);
            triangleIndices.Add(baseIndex + 1);
            triangleIndices.Add(baseIndex + 2);
        }

        private void AppendFillVertex(
            Vector2 point,
            Vector2 authoringUv,
            Color color,
            float pseudoNormalAngle,
            float opticalThickness)
        {
            vertices.Add(new Vector3(point.x, point.y, 0f));
            colors.Add(color);
            authoringCoordinates.Add(authoringUv);
            styleCoordinates.Add(new Vector2(0f, pseudoNormalAngle));
            opticalCoordinates.Add(new Vector2(opticalThickness, 0f));
        }

        private void AppendExactOutlineRim(float pixel)
        {
            bool counterClockwise = SignedArea(exactOutline) >= 0f;
            for (int index = 0; index < exactOutline.Length; index++)
            {
                FrameActionProceduralRigidEdgeRole role = index < exactOutlineRoles.Length
                    ? exactOutlineRoles[index]
                    : FrameActionProceduralRigidEdgeRole.Exposed;
                bool attached = role == FrameActionProceduralRigidEdgeRole.TerrainAttached;
                float intensity = attached ? 0.28f : Mathf.Lerp(0.72f, 1f, visualSettings.edgeBrightness);
                float width = pixel * (attached ? Mathf.Min(0.52f, visualSettings.edgeWidthPixels) : visualSettings.edgeWidthPixels);
                Vector2 a = exactOutline[index];
                Vector2 b = exactOutline[(index + 1) % exactOutline.Length];
                Vector2 uvA = index < exactOutlineAuthoringUvs.Length
                    ? exactOutlineAuthoringUvs[index]
                    : a * sourcePixelsPerUnit;
                int nextIndex = (index + 1) % exactOutline.Length;
                Vector2 uvB = nextIndex < exactOutlineAuthoringUvs.Length
                    ? exactOutlineAuthoringUvs[nextIndex]
                    : b * sourcePixelsPerUnit;
                AppendInwardRim(a, b, uvA, uvB, width, intensity, counterClockwise);
            }
        }

        private void AppendInwardRim(
            Vector2 a,
            Vector2 b,
            Vector2 uvA,
            Vector2 uvB,
            float width,
            float intensity,
            bool counterClockwise)
        {
            if (width <= 0.000001f || intensity <= 0f) return;
            Vector2 delta = b - a;
            float length = delta.magnitude;
            if (length <= 0.000001f) return;
            Vector2 left = new Vector2(-delta.y, delta.x) / length;
            Vector2 inward = (counterClockwise ? left : -left) * width;
            int baseIndex = vertices.Count;
            Color outer = visualSettings.edgeColor;
            outer.a = intensity;
            Color inner = Color.Lerp(visualSettings.baseColor, visualSettings.edgeColor, 0.42f);
            inner.a = intensity * 0.34f;
            AppendLineVertex(a, uvA, -0.0002f, outer, 2f, intensity);
            AppendLineVertex(b, uvB, -0.0002f, outer, 2f, intensity);
            AppendLineVertex(a + inward, uvA, -0.0002f, inner, 2f, intensity);
            AppendLineVertex(b + inward, uvB, -0.0002f, inner, 2f, intensity);
            AddQuadIndices(baseIndex);
        }

        private void AppendCenteredLine(
            Vector2 a,
            Vector2 b,
            Vector2 uvA,
            Vector2 uvB,
            float width,
            Color color,
            float style,
            float variant)
        {
            Vector2 delta = b - a;
            float lengthSquared = delta.sqrMagnitude;
            if (lengthSquared <= 0.00000001f) return;
            Vector2 normal = new Vector2(-delta.y, delta.x) * (width * 0.5f / Mathf.Sqrt(lengthSquared));
            int baseIndex = vertices.Count;
            float z = -0.0001f * style;
            AppendLineVertex(a + normal, uvA, z, color, style, variant);
            AppendLineVertex(a - normal, uvA, z, color, style, variant);
            AppendLineVertex(b + normal, uvB, z, color, style, variant);
            AppendLineVertex(b - normal, uvB, z, color, style, variant);
            triangleIndices.Add(baseIndex);
            triangleIndices.Add(baseIndex + 2);
            triangleIndices.Add(baseIndex + 1);
            triangleIndices.Add(baseIndex + 2);
            triangleIndices.Add(baseIndex + 3);
            triangleIndices.Add(baseIndex + 1);
        }

        private void AppendLineVertex(Vector2 point, Vector2 authoringUv, float z, Color color, float style, float variant)
        {
            vertices.Add(new Vector3(point.x, point.y, z));
            colors.Add(color);
            authoringCoordinates.Add(authoringUv);
            styleCoordinates.Add(new Vector2(style, variant));
            opticalCoordinates.Add(Vector2.zero);
        }

        private float CalculateOpticalThickness(Vector2 point)
        {
            float minimumDistanceSquared = float.PositiveInfinity;
            if (exactOutline != null && exactOutline.Length >= 3)
            {
                for (int index = 0; index < exactOutline.Length; index++)
                {
                    Vector2 a = exactOutline[index];
                    Vector2 b = exactOutline[(index + 1) % exactOutline.Length];
                    minimumDistanceSquared = Mathf.Min(minimumDistanceSquared, PointSegmentDistanceSquared(point, a, b));
                }
            }
            else
            {
                for (int index = 0; index < edges.Count; index++)
                {
                    RuntimeEdge edge = edges[index];
                    if (edge.Count != 1) continue;
                    minimumDistanceSquared = Mathf.Min(minimumDistanceSquared, PointSegmentDistanceSquared(point, edge.A, edge.B));
                }
            }

            if (float.IsInfinity(minimumDistanceSquared)) return 0.5f;
            float distancePixels = Mathf.Sqrt(Mathf.Max(0f, minimumDistanceSquared)) * sourcePixelsPerUnit;
            // About fourteen source pixels reach the optical core. This is intentionally a
            // monotonic edge-distance field, not a distance from any body centre.
            return 1f - Mathf.Exp(-distancePixels / 14f);
        }

        private void AddQuadIndices(int baseIndex)
        {
            triangleIndices.Add(baseIndex);
            triangleIndices.Add(baseIndex + 1);
            triangleIndices.Add(baseIndex + 2);
            triangleIndices.Add(baseIndex + 1);
            triangleIndices.Add(baseIndex + 3);
            triangleIndices.Add(baseIndex + 2);
        }

        private void RegisterEdge(Vector2 a, Vector2 b, Vector2 uvA, Vector2 uvB)
        {
            EdgeKey key = new EdgeKey(a, b);
            if (edgeLookup.TryGetValue(key, out int edgeIndex))
            {
                RuntimeEdge edge = edges[edgeIndex];
                edge.Count++;
                edges[edgeIndex] = edge;
                return;
            }
            edgeLookup.Add(key, edges.Count);
            edges.Add(new RuntimeEdge(a, b, uvA, uvB));
        }

        private static FrameActionProceduralRigidVisualFacet2D[] CopyAuthoringFacets(
            FrameActionProceduralRigidFacet2D[] sourceFacets,
            Vector2[] fallbackOutline,
            float pixelsPerUnit,
            uint seed)
        {
            int count = 0;
            if (sourceFacets != null)
            {
                for (int index = 0; index < sourceFacets.Length; index++)
                {
                    int points = sourceFacets[index].localPoints?.Length ?? 0;
                    if (points >= 3) count += points - 2;
                }
            }
            if (count == 0) return TriangulateOutline(fallbackOutline, pixelsPerUnit, seed);

            FrameActionProceduralRigidVisualFacet2D[] result = new FrameActionProceduralRigidVisualFacet2D[count];
            int cursor = 0;
            for (int index = 0; index < sourceFacets.Length; index++)
            {
                FrameActionProceduralRigidFacet2D source = sourceFacets[index];
                Vector2[] points = source.localPoints;
                if (points == null || points.Length < 3) continue;
                for (int triangle = 1; triangle < points.Length - 1; triangle++)
                {
                    Vector2 a = points[0];
                    Vector2 b = points[triangle];
                    Vector2 c = points[triangle + 1];
                    FrameActionProceduralRigidVisualFacet2D facet = new FrameActionProceduralRigidVisualFacet2D(
                        unchecked(source.id * 397 + triangle - 1),
                        a, b, c,
                        a * pixelsPerUnit, b * pixelsPerUnit, c * pixelsPerUnit,
                        source.shade);
                    facet.EnsureCounterClockwise();
                    result[cursor++] = facet;
                }
            }
            return HasDominantFacetFan(result)
                ? TriangulateOutline(fallbackOutline, pixelsPerUnit, seed)
                : result;
        }

        private static bool HasDominantFacetFan(
            IReadOnlyList<FrameActionProceduralRigidVisualFacet2D> source)
        {
            if (source == null || source.Count < 8) return false;
            var incidence = new Dictionary<PointKey, int>(source.Count * 2);
            int maximum = 0;
            for (int index = 0; index < source.Count; index++)
            {
                FrameActionProceduralRigidVisualFacet2D facet = source[index];
                CountFacetVertex(facet.A, incidence, ref maximum);
                CountFacetVertex(facet.B, incidence, ref maximum);
                CountFacetVertex(facet.C, incidence, ref maximum);
            }
            // A healthy local triangulation averages roughly six incident faces. The old
            // fallback mesh could still look valid while 16/30 or 24/83 faces met at one
            // silhouette vertex, which made both shading and fracture boundaries form a fan.
            // Keep this threshold aligned with SpriteCue's authoring validator so stale maps
            // are repaired identically in the tool and at runtime.
            return maximum > Mathf.Max(12, Mathf.CeilToInt(source.Count * 0.15f));
        }

        private static void CountFacetVertex(
            Vector2 point,
            Dictionary<PointKey, int> incidence,
            ref int maximum)
        {
            PointKey key = new PointKey(point);
            incidence.TryGetValue(key, out int count);
            count++;
            incidence[key] = count;
            maximum = Mathf.Max(maximum, count);
        }

        private static FrameActionProceduralRigidVisualFacet2D[] TriangulateOutline(Vector2[] outline, float ppu, uint seed)
        {
            if (outline == null || outline.Length < 3) return Array.Empty<FrameActionProceduralRigidVisualFacet2D>();
            int count = outline.Length;
            if (count > 3 && (outline[0] - outline[count - 1]).sqrMagnitude <= 0.00000001f) count--;
            if (count < 3) return Array.Empty<FrameActionProceduralRigidVisualFacet2D>();

            int[] remaining = new int[count];
            bool ccw = SignedArea(outline, count) >= 0f;
            for (int index = 0; index < count; index++) remaining[index] = ccw ? index : count - 1 - index;
            var result = new List<FrameActionProceduralRigidVisualFacet2D>(Mathf.Max(12, count * 3));
            int remainingCount = count;
            int output = 0;
            int guard = count * count;
            while (remainingCount > 2 && guard-- > 0)
            {
                bool found = false;
                for (int cursor = 0; cursor < remainingCount; cursor++)
                {
                    int previous = remaining[(cursor + remainingCount - 1) % remainingCount];
                    int current = remaining[cursor];
                    int next = remaining[(cursor + 1) % remainingCount];
                    Vector2 a = outline[previous];
                    Vector2 b = outline[current];
                    Vector2 c = outline[next];
                    if (Cross(b - a, c - b) <= 0.0000001f) continue;
                    bool occupied = false;
                    for (int candidateIndex = 0; candidateIndex < remainingCount; candidateIndex++)
                    {
                        int candidate = remaining[candidateIndex];
                        if (candidate == previous || candidate == current || candidate == next) continue;
                        if (PointInTriangle(outline[candidate], a, b, c)) { occupied = true; break; }
                    }
                    if (occupied) continue;
                    float shade = HashUnit(seed ^ unchecked((uint)output * 0x85ebca6bu));
                    result.Add(new FrameActionProceduralRigidVisualFacet2D(
                        output, a, b, c, a * ppu, b * ppu, c * ppu, shade));
                    output++;
                    for (int move = cursor; move < remainingCount - 1; move++) remaining[move] = remaining[move + 1];
                    remainingCount--;
                    found = true;
                    break;
                }
                if (!found) return Array.Empty<FrameActionProceduralRigidVisualFacet2D>();
            }
            RefineFallbackTriangulation(result, ppu, seed, count);
            return result.ToArray();
        }

        private static void RefineFallbackTriangulation(
            List<FrameActionProceduralRigidVisualFacet2D> facets,
            float ppu,
            uint seed,
            int outlineVertexCount)
        {
            int target = Mathf.Clamp(Mathf.Max(12, outlineVertexCount * 3), 12, 64);
            int nextId = facets.Count;
            while (facets.Count + 2 <= target)
            {
                int selected = 0;
                float largestScore = float.NegativeInfinity;
                for (int index = 0; index < facets.Count; index++)
                {
                    float noise = Mathf.Lerp(0.96f, 1.04f,
                        HashUnit(seed ^ unchecked((uint)(index + 1) * 0x9e3779b9u)));
                    float score = facets[index].Area * noise;
                    if (score <= largestScore) continue;
                    largestScore = score;
                    selected = index;
                }
                FrameActionProceduralRigidVisualFacet2D parent = facets[selected];
                uint mixed = seed ^ unchecked((uint)(nextId + 1) * 0x85ebca6bu);
                float first = Mathf.Lerp(0.27f, 0.39f, HashUnit(mixed));
                float second = Mathf.Lerp(0.27f, 0.39f, HashUnit(mixed ^ 0xc2b2ae35u));
                if (first + second > 0.76f) second = 0.76f - first;
                float third = 1f - first - second;
                Vector2 site = parent.A * first + parent.B * second + parent.C * third;
                facets.RemoveAt(selected);
                facets.Add(CreateFallbackFacet(nextId++, parent.A, parent.B, site, ppu, seed));
                facets.Add(CreateFallbackFacet(nextId++, parent.B, parent.C, site, ppu, seed));
                facets.Add(CreateFallbackFacet(nextId++, parent.C, parent.A, site, ppu, seed));
            }

            // Ear clipping is robust for arbitrary silhouettes but convex outlines often leave a
            // single-vertex fan. Local edge relaxation replaces those long diagonals with shorter
            // interior connections, yielding a distributed fracture graph.
            for (int pass = 0; pass < facets.Count * 3; pass++)
            {
                var edges = new Dictionary<EdgeKey, List<FallbackEdgeRecord>>(facets.Count * 2);
                for (int index = 0; index < facets.Count; index++)
                {
                    FrameActionProceduralRigidVisualFacet2D facet = facets[index];
                    AddFallbackEdge(edges, index, facet.A, facet.B, facet.C);
                    AddFallbackEdge(edges, index, facet.B, facet.C, facet.A);
                    AddFallbackEdge(edges, index, facet.C, facet.A, facet.B);
                }
                bool flipped = false;
                foreach (KeyValuePair<EdgeKey, List<FallbackEdgeRecord>> pair in edges)
                {
                    List<FallbackEdgeRecord> records = pair.Value;
                    if (records.Count != 2) continue;
                    FallbackEdgeRecord left = records[0];
                    FallbackEdgeRecord right = records[1];
                    Vector2 shared = left.End - left.Start;
                    Vector2 alternative = right.Opposite - left.Opposite;
                    if (shared.sqrMagnitude <= alternative.sqrMagnitude * 1.025f) continue;
                    if (Cross(shared, left.Opposite - left.Start)
                        * Cross(shared, right.Opposite - left.Start) >= -0.0000001f) continue;
                    if (Cross(alternative, left.Start - left.Opposite)
                        * Cross(alternative, left.End - left.Opposite) >= -0.0000001f) continue;
                    facets[left.Facet] = CreateFallbackFacet(
                        facets[left.Facet].Id,
                        left.Opposite,
                        right.Opposite,
                        left.Start,
                        ppu,
                        seed);
                    facets[right.Facet] = CreateFallbackFacet(
                        facets[right.Facet].Id,
                        right.Opposite,
                        left.Opposite,
                        left.End,
                        ppu,
                        seed);
                    flipped = true;
                    break;
                }
                if (!flipped) break;
            }
        }

        private static FrameActionProceduralRigidVisualFacet2D CreateFallbackFacet(
            int id,
            Vector2 a,
            Vector2 b,
            Vector2 c,
            float ppu,
            uint seed)
        {
            var facet = new FrameActionProceduralRigidVisualFacet2D(
                id,
                a,
                b,
                c,
                a * ppu,
                b * ppu,
                c * ppu,
                HashUnit(seed ^ unchecked((uint)(id + 1) * 0x27d4eb2du)));
            facet.EnsureCounterClockwise();
            return facet;
        }

        private static void AddFallbackEdge(
            Dictionary<EdgeKey, List<FallbackEdgeRecord>> edges,
            int facet,
            Vector2 start,
            Vector2 end,
            Vector2 opposite)
        {
            EdgeKey key = new EdgeKey(start, end);
            if (!edges.TryGetValue(key, out List<FallbackEdgeRecord> list))
            {
                list = new List<FallbackEdgeRecord>(2);
                edges.Add(key, list);
            }
            list.Add(new FallbackEdgeRecord(facet, start, end, opposite));
        }

        private void ReportVisualError(string message, UnityEngine.Object context)
        {
            lastVisualError = message;
            Debug.LogError($"[SpriteCue Program Rigid] {message}", context);
        }

        private static void Release(UnityEngine.Object value)
        {
            if (value == null) return;
            if (Application.isPlaying) Destroy(value);
            else DestroyImmediate(value);
        }

        private static Vector2[] ClonePoints(Vector2[] source)
        {
            return source == null || source.Length == 0 ? Array.Empty<Vector2>() : (Vector2[])source.Clone();
        }

        private static void ClipFacet(
            FrameActionProceduralRigidVisualFacet2D source,
            Vector2 normal,
            float limit,
            bool keepLessOrEqual,
            List<FrameActionProceduralRigidVisualFacet2D> destination)
        {
            var input = new List<ClipVertex>(4)
            {
                new ClipVertex(source.A, source.AuthoringUvA),
                new ClipVertex(source.B, source.AuthoringUvB),
                new ClipVertex(source.C, source.AuthoringUvC),
            };
            var output = new List<ClipVertex>(4);
            ClipVertex previous = input[input.Count - 1];
            float previousDistance = Vector2.Dot(previous.Position, normal) - limit;
            bool previousInside = keepLessOrEqual ? previousDistance <= 0f : previousDistance >= 0f;
            for (int index = 0; index < input.Count; index++)
            {
                ClipVertex current = input[index];
                float currentDistance = Vector2.Dot(current.Position, normal) - limit;
                bool currentInside = keepLessOrEqual ? currentDistance <= 0f : currentDistance >= 0f;
                if (currentInside != previousInside)
                {
                    float denominator = previousDistance - currentDistance;
                    float progress = Mathf.Abs(denominator) > 0.0000001f
                        ? Mathf.Clamp01(previousDistance / denominator)
                        : 0f;
                    output.Add(ClipVertex.Lerp(previous, current, progress));
                }
                if (currentInside) output.Add(current);
                previous = current;
                previousDistance = currentDistance;
                previousInside = currentInside;
            }
            if (output.Count < 3) return;

            for (int triangle = 1; triangle < output.Count - 1; triangle++)
            {
                ClipVertex a = output[0];
                ClipVertex b = output[triangle];
                ClipVertex c = output[triangle + 1];
                var facet = new FrameActionProceduralRigidVisualFacet2D(
                    unchecked(source.Id * 17 + triangle),
                    a.Position,
                    b.Position,
                    c.Position,
                    a.AuthoringUv,
                    b.AuthoringUv,
                    c.AuthoringUv,
                    source.Shade);
                if (facet.Area <= 0.0000001f) continue;
                facet.EnsureCounterClockwise();
                destination.Add(facet);
            }
        }

        private static bool TryClipSegment(
            FrameActionProceduralRigidCrackSegment2D source,
            Vector2 normal,
            float limit,
            bool keepLessOrEqual,
            out FrameActionProceduralRigidCrackSegment2D clipped)
        {
            float firstDistance = Vector2.Dot(source.A, normal) - limit;
            float secondDistance = Vector2.Dot(source.B, normal) - limit;
            bool firstInside = keepLessOrEqual ? firstDistance <= 0f : firstDistance >= 0f;
            bool secondInside = keepLessOrEqual ? secondDistance <= 0f : secondDistance >= 0f;
            if (!firstInside && !secondInside)
            {
                clipped = default;
                return false;
            }
            Vector2 first = source.A;
            Vector2 second = source.B;
            if (firstInside != secondInside)
            {
                float denominator = firstDistance - secondDistance;
                float progress = Mathf.Abs(denominator) > 0.0000001f
                    ? Mathf.Clamp01(firstDistance / denominator)
                    : 0f;
                Vector2 intersection = Vector2.Lerp(first, second, progress);
                if (!firstInside) first = intersection;
                else second = intersection;
            }
            if ((second - first).sqrMagnitude <= 0.0000001f)
            {
                clipped = default;
                return false;
            }
            clipped = new FrameActionProceduralRigidCrackSegment2D(first, second, source.Strength);
            return true;
        }

        private static Vector2[] CreateAuthoringCoordinates(Vector2[] source, float pixelsPerUnit)
        {
            if (source == null || source.Length == 0) return Array.Empty<Vector2>();
            Vector2[] result = new Vector2[source.Length];
            for (int index = 0; index < result.Length; index++) result[index] = source[index] * pixelsPerUnit;
            return result;
        }

        private static FrameActionProceduralRigidEdgeRole[] CloneRoles(FrameActionProceduralRigidEdgeRole[] source, int count)
        {
            if (count <= 0) return Array.Empty<FrameActionProceduralRigidEdgeRole>();
            FrameActionProceduralRigidEdgeRole[] result = new FrameActionProceduralRigidEdgeRole[count];
            for (int index = 0; index < count; index++)
                result[index] = source != null && index < source.Length ? source[index] : FrameActionProceduralRigidEdgeRole.Exposed;
            return result;
        }

        private static float SignedArea(IReadOnlyList<Vector2> points)
        {
            return SignedArea(points, points?.Count ?? 0);
        }

        private static float SignedArea(IReadOnlyList<Vector2> points, int count)
        {
            if (points == null || count < 3) return 0f;
            double area = 0d;
            for (int index = 0; index < count; index++)
            {
                Vector2 a = points[index];
                Vector2 b = points[(index + 1) % count];
                area += (double)a.x * b.y - (double)b.x * a.y;
            }
            return (float)(area * 0.5d);
        }

        private static bool PointInTriangle(Vector2 point, Vector2 a, Vector2 b, Vector2 c)
        {
            float ab = Cross(b - a, point - a);
            float bc = Cross(c - b, point - b);
            float ca = Cross(a - c, point - c);
            return ab >= -0.000001f && bc >= -0.000001f && ca >= -0.000001f;
        }

        private static float PointSegmentDistanceSquared(Vector2 point, Vector2 a, Vector2 b)
        {
            Vector2 delta = b - a;
            float lengthSquared = delta.sqrMagnitude;
            if (lengthSquared <= 0.00000001f) return (point - a).sqrMagnitude;
            float fraction = Mathf.Clamp01(Vector2.Dot(point - a, delta) / lengthSquared);
            Vector2 nearest = a + delta * fraction;
            return (point - nearest).sqrMagnitude;
        }

        private static float Cross(Vector2 first, Vector2 second)
        {
            return first.x * second.y - first.y * second.x;
        }

        private static float HashUnit(uint value)
        {
            return (Hash(value) & 0x00ffffffu) / 16777215f;
        }

        private static uint Hash(uint value)
        {
            value ^= value >> 16;
            value *= 0x7feb352du;
            value ^= value >> 15;
            value *= 0x846ca68bu;
            value ^= value >> 16;
            return value;
        }

        private struct RuntimeEdge
        {
            public Vector2 A;
            public Vector2 B;
            public Vector2 UvA;
            public Vector2 UvB;
            public int Count;

            public RuntimeEdge(Vector2 a, Vector2 b, Vector2 uvA, Vector2 uvB)
            {
                A = a;
                B = b;
                UvA = uvA;
                UvB = uvB;
                Count = 1;
            }
        }

        private readonly struct PointKey : IEquatable<PointKey>, IComparable<PointKey>
        {
            private readonly int x;
            private readonly int y;

            public PointKey(Vector2 point)
            {
                x = Mathf.RoundToInt(point.x * PointQuantization);
                y = Mathf.RoundToInt(point.y * PointQuantization);
            }

            public int CompareTo(PointKey other)
            {
                int comparison = x.CompareTo(other.x);
                return comparison != 0 ? comparison : y.CompareTo(other.y);
            }
            public bool Equals(PointKey other) => x == other.x && y == other.y;
            public override bool Equals(object value) => value is PointKey other && Equals(other);
            public override int GetHashCode() => unchecked((x * 397) ^ y);
        }

        private readonly struct EdgeKey : IEquatable<EdgeKey>
        {
            private readonly PointKey first;
            private readonly PointKey second;

            public EdgeKey(Vector2 a, Vector2 b)
            {
                PointKey aKey = new PointKey(a);
                PointKey bKey = new PointKey(b);
                if (aKey.CompareTo(bKey) <= 0) { first = aKey; second = bKey; }
                else { first = bKey; second = aKey; }
            }
            public bool Equals(EdgeKey other) => first.Equals(other.first) && second.Equals(other.second);
            public override bool Equals(object value) => value is EdgeKey other && Equals(other);
            public override int GetHashCode() => unchecked((first.GetHashCode() * 397) ^ second.GetHashCode());
        }

        private readonly struct FallbackEdgeRecord
        {
            public readonly int Facet;
            public readonly Vector2 Start;
            public readonly Vector2 End;
            public readonly Vector2 Opposite;

            public FallbackEdgeRecord(int facet, Vector2 start, Vector2 end, Vector2 opposite)
            {
                Facet = facet;
                Start = start;
                End = end;
                Opposite = opposite;
            }
        }

        private readonly struct ClipVertex
        {
            public readonly Vector2 Position;
            public readonly Vector2 AuthoringUv;

            public ClipVertex(Vector2 position, Vector2 authoringUv)
            {
                Position = position;
                AuthoringUv = authoringUv;
            }

            public static ClipVertex Lerp(ClipVertex first, ClipVertex second, float progress)
            {
                return new ClipVertex(
                    Vector2.Lerp(first.Position, second.Position, progress),
                    Vector2.Lerp(first.AuthoringUv, second.AuthoringUv, progress));
            }
        }
    }
}
