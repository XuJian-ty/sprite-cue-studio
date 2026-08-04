using System;
using UnityEngine;

namespace FrameAction
{
    public enum FrameActionProceduralRigidEdgeRole
    {
        Exposed,
        TerrainAttached,
        FractureShared,
        GeneratedSeam,
    }

    [Serializable]
    public struct FrameActionProceduralRigidFacet2D
    {
        public int id;
        public Vector2[] localPoints;
        [Range(0f, 1f)] public float shade;
    }

    [Serializable]
    public enum FrameActionProceduralRigidTemplate2D
    {
        IceCrystal = 0,
        Wood = 1,
        Metal = 2,
        Stone = 3,
        Custom = 4,
    }

    [Serializable]
    public struct FrameActionProceduralRigidVisualSettings2D
    {
        public string sourceMode;
        public string templateId;
        [ColorUsage(false, false)] public Color baseColor;
        [ColorUsage(false, false)] public Color shadowColor;
        [ColorUsage(false, false)] public Color highlightColor;
        [ColorUsage(false, false)] public Color edgeColor;
        [ColorUsage(false, false)] public Color fractureColor;
        [Range(0f, 1f)] public float opacity;
        [Range(0f, 1f)] public float edgeJaggedness;
        [Min(0f)] public float facetScale;
        [Range(0f, 1f)] public float facetVariation;
        [Range(0f, 1f)] public float textureStrength;
        [Range(0f, 1f)] public float edgeBrightness;
        [Range(0f, 1f)] public float volumeDepth;
        [Range(0f, 1f)] public float transmission;
        [Range(0f, 1f)] public float absorption;
        [Min(0f)] public float edgeWidthPixels;
        [Range(0f, 1f)] public float specularStrength;
        [Range(0f, 1f)] public float inclusionDensity;
        [Range(0f, 1f)] public float microCrackDensity;
        [Range(0f, 1f)] public float roughness;
        [Range(-180f, 180f)] public float grainDirectionDegrees;
        [Range(0f, 1f)] public float anisotropy;
        [Range(-180f, 180f)] public float lightAngleDegrees;

        /// <summary>
        /// Returns renderer-safe values while preserving explicitly authored zeroes. A completely
        /// zero optical block means the data predates SpriteCue's volumetric ice authoring and is
        /// upgraded to the package defaults. This keeps old maps readable without making the
        /// Rigidbody centre of mass part of the visual contract.
        /// </summary>
        [Obsolete("Use NormalizedForRendering. Ice is a SpriteCue visual template, not a separate runtime system.")]
        public FrameActionProceduralRigidVisualSettings2D NormalizedForIceRendering()
        {
            FrameActionProceduralRigidVisualSettings2D ice = this;
            if (string.IsNullOrWhiteSpace(ice.templateId)) ice.templateId = "iceCrystal";
            return ice.NormalizedForRendering();
        }

        /// <summary>Normalizes one of SpriteCue's reusable procedural-rigid visual templates.</summary>
        public FrameActionProceduralRigidVisualSettings2D NormalizedForRendering()
        {
            FrameActionProceduralRigidVisualSettings2D result = this;
            result.sourceMode = string.Equals(sourceMode, "sourceImage", StringComparison.OrdinalIgnoreCase)
                ? "sourceImage"
                : "procedural";
            FrameActionProceduralRigidTemplate2D template = ResolveTemplate(templateId);
            result.templateId = TemplateId(template);
            bool missingPalette = IsUnset(result.baseColor)
                && IsUnset(result.shadowColor)
                && IsUnset(result.highlightColor)
                && IsUnset(result.edgeColor)
                && IsUnset(result.fractureColor);
            bool legacyOpticalBlock = volumeDepth == 0f
                && transmission == 0f
                && absorption == 0f
                && specularStrength == 0f
                && inclusionDensity == 0f
                && microCrackDensity == 0f;
            if (missingPalette || legacyOpticalBlock)
            {
                ApplyTemplateDefaults(ref result, template, missingPalette, legacyOpticalBlock);
            }

            if (IsUnset(result.baseColor)) result.baseColor = new Color(0.42f, 0.46f, 0.52f, 1f);
            if (IsUnset(result.shadowColor)) result.shadowColor = Color.Lerp(Color.black, result.baseColor, 0.34f);
            if (IsUnset(result.highlightColor)) result.highlightColor = Color.Lerp(result.baseColor, Color.white, 0.62f);
            if (IsUnset(result.edgeColor)) result.edgeColor = result.highlightColor;
            if (IsUnset(result.fractureColor)) result.fractureColor = Color.Lerp(result.baseColor, result.highlightColor, 0.72f);

            result.baseColor.r = Mathf.Clamp01(result.baseColor.r);
            result.baseColor.g = Mathf.Clamp01(result.baseColor.g);
            result.baseColor.b = Mathf.Clamp01(result.baseColor.b);
            result.baseColor.a = 1f;
            result.shadowColor.r = Mathf.Clamp01(result.shadowColor.r);
            result.shadowColor.g = Mathf.Clamp01(result.shadowColor.g);
            result.shadowColor.b = Mathf.Clamp01(result.shadowColor.b);
            result.shadowColor.a = 1f;
            result.highlightColor.r = Mathf.Clamp01(result.highlightColor.r);
            result.highlightColor.g = Mathf.Clamp01(result.highlightColor.g);
            result.highlightColor.b = Mathf.Clamp01(result.highlightColor.b);
            result.highlightColor.a = 1f;
            result.edgeColor.r = Mathf.Clamp01(result.edgeColor.r);
            result.edgeColor.g = Mathf.Clamp01(result.edgeColor.g);
            result.edgeColor.b = Mathf.Clamp01(result.edgeColor.b);
            result.edgeColor.a = 1f;
            result.fractureColor.r = Mathf.Clamp01(result.fractureColor.r);
            result.fractureColor.g = Mathf.Clamp01(result.fractureColor.g);
            result.fractureColor.b = Mathf.Clamp01(result.fractureColor.b);
            result.fractureColor.a = 1f;
            // Template/migration defaults above are the only place allowed to synthesize an
            // opacity. A newly authored 0 is intentional (fully transparent) and must survive
            // normalization just like every other explicit visual parameter.
            result.opacity = Mathf.Clamp01(result.opacity);
            result.edgeJaggedness = Mathf.Clamp01(result.edgeJaggedness);
            result.facetScale = Mathf.Max(0f, result.facetScale);
            result.facetVariation = Mathf.Clamp01(result.facetVariation);
            result.textureStrength = Mathf.Clamp01(result.textureStrength);
            result.edgeBrightness = Mathf.Clamp01(result.edgeBrightness);
            result.volumeDepth = Mathf.Clamp01(result.volumeDepth);
            result.transmission = Mathf.Clamp01(result.transmission);
            result.absorption = Mathf.Clamp01(result.absorption);
            result.edgeWidthPixels = Mathf.Max(0f, result.edgeWidthPixels);
            result.specularStrength = Mathf.Clamp01(result.specularStrength);
            result.inclusionDensity = Mathf.Clamp01(result.inclusionDensity);
            result.microCrackDensity = Mathf.Clamp01(result.microCrackDensity);
            result.roughness = Mathf.Clamp01(result.roughness);
            result.grainDirectionDegrees = Mathf.Repeat(result.grainDirectionDegrees + 180f, 360f) - 180f;
            result.anisotropy = Mathf.Clamp01(result.anisotropy);
            result.lightAngleDegrees = Mathf.Repeat(result.lightAngleDegrees + 180f, 360f) - 180f;
            return result;
        }

        public FrameActionProceduralRigidTemplate2D ResolveTemplate()
        {
            return ResolveTemplate(templateId);
        }

        private static FrameActionProceduralRigidTemplate2D ResolveTemplate(string authoredTemplate)
        {
            string value = authoredTemplate;
            if (string.IsNullOrWhiteSpace(value)) return FrameActionProceduralRigidTemplate2D.IceCrystal;
            value = value.Trim();
            if (value.Equals("iceCrystal", StringComparison.OrdinalIgnoreCase)
                || value.IndexOf("ice", StringComparison.OrdinalIgnoreCase) >= 0)
                return FrameActionProceduralRigidTemplate2D.IceCrystal;
            if (value.Equals("wood", StringComparison.OrdinalIgnoreCase)
                || value.IndexOf("wood", StringComparison.OrdinalIgnoreCase) >= 0)
                return FrameActionProceduralRigidTemplate2D.Wood;
            if (value.Equals("metal", StringComparison.OrdinalIgnoreCase)
                || value.IndexOf("metal", StringComparison.OrdinalIgnoreCase) >= 0)
                return FrameActionProceduralRigidTemplate2D.Metal;
            if (value.Equals("stone", StringComparison.OrdinalIgnoreCase)
                || value.IndexOf("rock", StringComparison.OrdinalIgnoreCase) >= 0)
                return FrameActionProceduralRigidTemplate2D.Stone;
            return FrameActionProceduralRigidTemplate2D.Custom;
        }

        private static string TemplateId(FrameActionProceduralRigidTemplate2D template)
        {
            switch (template)
            {
                case FrameActionProceduralRigidTemplate2D.Wood: return "wood";
                case FrameActionProceduralRigidTemplate2D.Metal: return "metal";
                case FrameActionProceduralRigidTemplate2D.Stone: return "stone";
                case FrameActionProceduralRigidTemplate2D.Custom: return "custom";
                default: return "iceCrystal";
            }
        }

        private static bool IsUnset(Color color)
        {
            return color.r == 0f && color.g == 0f && color.b == 0f && color.a == 0f;
        }

        private static void ApplyTemplateDefaults(
            ref FrameActionProceduralRigidVisualSettings2D value,
            FrameActionProceduralRigidTemplate2D template,
            bool palette,
            bool optical)
        {
            if (palette)
            {
                switch (template)
                {
                    case FrameActionProceduralRigidTemplate2D.Wood:
                        value.baseColor = new Color(0.48f, 0.22f, 0.075f, 1f);
                        value.shadowColor = new Color(0.105f, 0.035f, 0.014f, 1f);
                        value.highlightColor = new Color(0.91f, 0.59f, 0.25f, 1f);
                        value.edgeColor = new Color(0.66f, 0.34f, 0.12f, 1f);
                        value.fractureColor = new Color(0.94f, 0.76f, 0.52f, 1f);
                        break;
                    case FrameActionProceduralRigidTemplate2D.Metal:
                        value.baseColor = new Color(0.34f, 0.42f, 0.49f, 1f);
                        value.shadowColor = new Color(0.055f, 0.075f, 0.10f, 1f);
                        value.highlightColor = new Color(0.82f, 0.91f, 0.96f, 1f);
                        value.edgeColor = new Color(0.64f, 0.72f, 0.78f, 1f);
                        value.fractureColor = new Color(0.90f, 0.95f, 0.98f, 1f);
                        break;
                    case FrameActionProceduralRigidTemplate2D.Stone:
                        value.baseColor = new Color(0.30f, 0.34f, 0.38f, 1f);
                        value.shadowColor = new Color(0.075f, 0.085f, 0.10f, 1f);
                        value.highlightColor = new Color(0.58f, 0.63f, 0.66f, 1f);
                        value.edgeColor = new Color(0.48f, 0.52f, 0.55f, 1f);
                        value.fractureColor = new Color(0.74f, 0.77f, 0.80f, 1f);
                        break;
                    case FrameActionProceduralRigidTemplate2D.Custom:
                        value.baseColor = new Color(0.42f, 0.46f, 0.52f, 1f);
                        value.shadowColor = new Color(0.08f, 0.09f, 0.12f, 1f);
                        value.highlightColor = new Color(0.82f, 0.86f, 0.92f, 1f);
                        value.edgeColor = new Color(0.70f, 0.74f, 0.82f, 1f);
                        value.fractureColor = new Color(0.88f, 0.92f, 0.95f, 1f);
                        break;
                    default:
                        value.baseColor = new Color(0.035f, 0.34f, 0.62f, 1f);
                        value.shadowColor = new Color(0.014f, 0.082f, 0.20f, 1f);
                        value.highlightColor = new Color(0.48f, 0.89f, 1f, 1f);
                        value.edgeColor = new Color(0.80f, 0.98f, 1f, 1f);
                        value.fractureColor = new Color(0.90f, 0.99f, 1f, 1f);
                        break;
                }
            }

            if (!optical) return;
            value.opacity = 1f;
            switch (template)
            {
                case FrameActionProceduralRigidTemplate2D.Wood:
                    value.volumeDepth = 0.62f; value.transmission = 0.02f; value.absorption = 0.76f;
                    value.edgeWidthPixels = 0.60f; value.specularStrength = 0.16f; value.inclusionDensity = 0.24f;
                    value.microCrackDensity = 0.10f; value.roughness = 0.78f; value.grainDirectionDegrees = 8f;
                    value.anisotropy = 0.90f; value.lightAngleDegrees = 132f;
                    break;
                case FrameActionProceduralRigidTemplate2D.Metal:
                    value.volumeDepth = 0.36f; value.transmission = 0f; value.absorption = 0.70f;
                    value.edgeWidthPixels = 0.45f; value.specularStrength = 0.90f; value.inclusionDensity = 0.06f;
                    value.microCrackDensity = 0.04f; value.roughness = 0.22f; value.grainDirectionDegrees = 4f;
                    value.anisotropy = 0.72f; value.lightAngleDegrees = 132f;
                    break;
                case FrameActionProceduralRigidTemplate2D.Stone:
                    value.volumeDepth = 0.70f; value.transmission = 0f; value.absorption = 0.84f;
                    value.edgeWidthPixels = 0.40f; value.specularStrength = 0.08f; value.inclusionDensity = 0.52f;
                    value.microCrackDensity = 0.18f; value.roughness = 0.92f; value.grainDirectionDegrees = 0f;
                    value.anisotropy = 0.12f; value.lightAngleDegrees = 132f;
                    break;
                case FrameActionProceduralRigidTemplate2D.Custom:
                    value.volumeDepth = 0.55f; value.transmission = 0f; value.absorption = 0.55f;
                    value.edgeWidthPixels = 0.35f; value.specularStrength = 0.35f; value.inclusionDensity = 0.20f;
                    value.microCrackDensity = 0.08f; value.roughness = 0.55f; value.grainDirectionDegrees = 0f;
                    value.anisotropy = 0f; value.lightAngleDegrees = 132f;
                    break;
                default:
                    value.volumeDepth = 0.78f; value.transmission = 0.72f; value.absorption = 0.52f;
                    value.edgeWidthPixels = 1.35f; value.specularStrength = 0.82f; value.inclusionDensity = 0.34f;
                    value.microCrackDensity = 0.22f; value.roughness = 0.16f; value.grainDirectionDegrees = -18f;
                    value.anisotropy = 0.34f; value.lightAngleDegrees = 132f;
                    break;
            }
        }
    }

    public enum FrameActionProceduralRigidInitialMotion2D
    {
        Dynamic,
        Fixed,
    }

    public enum FrameActionProceduralRigidAnchoringMode2D
    {
        None,
        TerrainAttached,
    }

    /// <summary>
    /// Explicit physical coefficients shared by every procedural-rigid template. elementTag is
    /// intentionally absent: gameplay tags never select physical behavior at runtime.
    /// </summary>
    [Serializable]
    public struct FrameActionProceduralRigidPhysicalProfile2D
    {
        [Min(0.001f)] public float density;
        public float gravityScale;
        [Range(0f, 1f)] public float friction;
        [Range(0f, 1f)] public float restitution;
        [Min(0f)] public float linearDamping;
        [Min(0f)] public float angularDamping;
        [Range(0f, 1f)] public float hardness;
        [Range(0f, 1f)] public float toughness;
        [Range(0f, 1f)] public float brittleness;
        [Range(0f, 1f)] public float anisotropy;
        [Range(-180f, 180f)] public float grainAngleDegrees;
        [Range(0f, 1f)] public float debrisFraction;
        public FrameActionProceduralRigidInitialMotion2D initialMotion;
        public FrameActionProceduralRigidAnchoringMode2D anchoringMode;

        public FrameActionProceduralRigidPhysicalProfile2D Normalized(string templateId)
        {
            FrameActionProceduralRigidPhysicalProfile2D result = this;
            FrameActionProceduralRigidInitialMotion2D authoredMotion = initialMotion;
            FrameActionProceduralRigidAnchoringMode2D authoredAnchoring = anchoringMode;
            bool missing = density <= 0f
                && gravityScale == 0f
                && friction == 0f
                && restitution == 0f
                && linearDamping == 0f
                && angularDamping == 0f
                && hardness == 0f
                && toughness == 0f
                && brittleness == 0f
                && anisotropy == 0f
                && grainAngleDegrees == 0f
                && debrisFraction == 0f;
            if (missing)
            {
                result = Defaults(templateId);
                result.initialMotion = authoredMotion;
                result.anchoringMode = authoredAnchoring;
            }
            result.density = Mathf.Max(0.001f, result.density);
            result.gravityScale = Mathf.Clamp(result.gravityScale, -8f, 8f);
            result.friction = Mathf.Clamp01(result.friction);
            result.restitution = Mathf.Clamp01(result.restitution);
            result.linearDamping = Mathf.Clamp(result.linearDamping, 0f, 20f);
            result.angularDamping = Mathf.Clamp(result.angularDamping, 0f, 20f);
            result.hardness = Mathf.Clamp01(result.hardness);
            result.toughness = Mathf.Clamp01(result.toughness);
            result.brittleness = Mathf.Clamp01(result.brittleness);
            result.anisotropy = Mathf.Clamp01(result.anisotropy);
            result.grainAngleDegrees = Mathf.Repeat(result.grainAngleDegrees + 180f, 360f) - 180f;
            result.debrisFraction = Mathf.Clamp01(result.debrisFraction);
            return result;
        }

        public static FrameActionProceduralRigidPhysicalProfile2D Defaults(string templateId)
        {
            string id = string.IsNullOrWhiteSpace(templateId) ? "custom" : templateId.Trim();
            if (id.Equals("iceCrystal", StringComparison.OrdinalIgnoreCase))
                return Create(0.92f, 1f, 0.12f, 0.08f, 0.12f, 0.08f,
                    0.68f, 0.30f, 0.94f, 0.35f, -25f, 0.16f);
            if (id.Equals("wood", StringComparison.OrdinalIgnoreCase))
                return Create(0.62f, 1f, 0.48f, 0.03f, 0.16f, 0.18f,
                    0.46f, 0.52f, 0.50f, 0.88f, 0f, 0.28f);
            if (id.Equals("metal", StringComparison.OrdinalIgnoreCase))
                return Create(7.80f, 1f, 0.32f, 0.02f, 0.28f, 0.40f,
                    0.98f, 0.96f, 0.08f, 0.22f, 15f, 0.02f);
            if (id.Equals("stone", StringComparison.OrdinalIgnoreCase)
                || id.Equals("rock", StringComparison.OrdinalIgnoreCase))
                return Create(2.40f, 1f, 0.65f, 0.01f, 0.20f, 0.22f,
                    0.86f, 0.60f, 0.62f, 0.15f, 8f, 0.12f);
            return Create(1f, 1f, 0.40f, 0.05f, 0.08f, 0.10f,
                0.60f, 0.60f, 0.50f, 0f, 0f, 0.10f);
        }

        private static FrameActionProceduralRigidPhysicalProfile2D Create(
            float density, float gravity, float friction, float restitution,
            float linearDamping, float angularDamping, float hardness, float toughness,
            float brittleness, float anisotropy, float grain, float debris)
        {
            return new FrameActionProceduralRigidPhysicalProfile2D
            {
                density = density,
                gravityScale = gravity,
                friction = friction,
                restitution = restitution,
                linearDamping = linearDamping,
                angularDamping = angularDamping,
                hardness = hardness,
                toughness = toughness,
                brittleness = brittleness,
                anisotropy = anisotropy,
                grainAngleDegrees = grain,
                debrisFraction = debris,
                initialMotion = FrameActionProceduralRigidInitialMotion2D.Dynamic,
                anchoringMode = FrameActionProceduralRigidAnchoringMode2D.None,
            };
        }
    }

    [Serializable]
    public struct FrameActionProceduralRigidFractureSettings2D
    {
        [Min(0)] public int primaryFragmentMin;
        [Min(0)] public int primaryFragmentMax;
        [Min(0f)] public float minimumFragmentAreaPixelsSquared;
        [Min(0f)] public float minimumFragmentWidthPixels;
        [Min(0)] public int crackBranchMin;
        [Min(0)] public int crackBranchMax;
        [Min(0)] public int releaseDelayTicks;
        [Tooltip("External gameplay hit threshold for small chips. Zero falls back to the legacy landing threshold.")]
        [Min(0f)] public float impactChipEnergy;
        [Tooltip("External gameplay hit threshold for an immediate visible crack.")]
        [Min(0f)] public float impactCrackEnergy;
        [Tooltip("External gameplay hit threshold for structural fracture-level damage. Fatigue still gates release.")]
        [Min(0f)] public float impactBreakEnergy;
        [Min(0f)] public float collisionBreakThreshold;
        [Tooltip("Light landing/collision threshold in joules. Zero uses the selected template default.")]
        [Min(0f)] public float landingChipEnergy;
        [Tooltip("Visible crack threshold in joules. Zero uses the selected template default.")]
        [Min(0f)] public float landingCrackEnergy;
        [Tooltip("Physical re-fracture threshold in joules. Zero uses the selected template default.")]
        [Min(0f)] public float landingBreakEnergy;
        [Tooltip("0..4 multiplier for concentrating normal impulse over a small contact span.")]
        [Range(0f, 4f)] public float contactStressSensitivity;
        [Tooltip("Fixed ticks before the same collider pair may create another landing impact.")]
        [Min(0)] public int landingCooldownTicks;
        [Range(2, 8)] public int maxFragmentsPerImpact;
        [Range(4, 256)] public int maxActiveFragmentsPerFamily;
    }

    [Serializable]
    public sealed class FrameActionProceduralRigidTerrainBinding2D
    {
        public string sourceId;
        public string sourceKind;
        public string route;
        public Vector2 localStart;
        public Vector2 localEnd;
    }

    /// <summary>
    /// Read-only, project-agnostic procedural rigid authoring data emitted by SpriteCue Studio.
    /// Geometry is expressed in this component's Transform-local world units. Visual and fracture
    /// settings retain their authored pixel units and can be converted with sourcePixelsPerUnit.
    /// The consuming game decides rendering, simulation and every material or element reaction.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class FrameActionProceduralRigidSource2D : MonoBehaviour
    {
        public string sourceId;
        public int schemaVersion = 1;
        public string materialId = "custom";
        public string algorithmId = "procedural-rigid-v1";
        public string templateId = "custom";
        [Tooltip("Free-form gameplay tag passed through from SpriteCue. Rendering never interprets it.")]
        public string elementTag = string.Empty;
        public Sprite sourceSprite;
        public uint seed = 1;
        public string closureMode = "manual";
        [Min(1f)] public float sourcePixelsPerUnit = 100f;
        public Vector2[] localOutline = Array.Empty<Vector2>();
        public FrameActionProceduralRigidEdgeRole[] edgeRoles = Array.Empty<FrameActionProceduralRigidEdgeRole>();
        public FrameActionProceduralRigidFacet2D[] facets = Array.Empty<FrameActionProceduralRigidFacet2D>();
        public FrameActionProceduralRigidVisualSettings2D visual;
        public FrameActionProceduralRigidPhysicalProfile2D physical;
        public FrameActionProceduralRigidFractureSettings2D fracture;
        public FrameActionProceduralRigidTerrainBinding2D terrainBinding;
    }
}
