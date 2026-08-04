using UnityEngine;

namespace FrameAction
{
    /// <summary>
    /// Tool-provided, physics-free event presenter for tiny program-rigid chips. Generated maps
    /// install one global fixed-capacity pool shared by object-library and brush-authored rigid
    /// bodies. The particle system owns lifetime and motion; this component creates no Rigidbody2D
    /// or Collider2D and has no managed per-frame callback.
    /// </summary>
    [DisallowMultipleComponent]
    // Adding ParticleSystem already creates its paired ParticleSystemRenderer. Requiring both
    // explicitly makes Unity 6 register the same transform twice in editor/test construction.
    [RequireComponent(typeof(ParticleSystem))]
    public class FrameActionProceduralRigidDebrisPresenter2D : MonoBehaviour
    {
        private const int ParticleCapacity = 192;
        private const int MaximumParticlesPerEvent = 28;
        private const float TwoPi = 6.28318530718f;
        public const string MaterialResourcePath = "FrameAction/ProceduralRigidDebris";
        public const string ShaderName = "FrameAction/Procedural Rigid Debris";
        private static readonly int TintId = Shader.PropertyToID("_Tint");

        [SerializeField, Min(0.01f)] private float minimumLifetime = 0.28f;
        [SerializeField, Min(0.01f)] private float maximumLifetime = 1.10f;
        [SerializeField, Min(0.001f)] private float minimumSize = 0.025f;
        [SerializeField, Min(0.001f)] private float maximumSize = 0.14f;
        [SerializeField, Min(0f)] private float baseSpeed = 0.58f;
        [SerializeField, Min(0f)] private float energySpeed = 5.2f;
        [SerializeField] private bool listenToAllBodies;
        [SerializeField] private int configuredSortingLayerId;
        [SerializeField] private int configuredSortingOrder;
        [SerializeField] private Color debrisBaseColor = new Color(0.42f, 0.46f, 0.52f, 0.92f);
        [SerializeField] private Color debrisHighlightColor = new Color(0.82f, 0.86f, 0.92f, 0.97f);

        private ParticleSystem particles;
        private ParticleSystemRenderer particleRenderer;
        private Mesh runtimeShardMesh;
        private MaterialPropertyBlock propertyBlock;
        private FrameActionProceduralRigidBodyCore2D boundBody;
        private FrameActionProceduralRigidGeometry2D boundGeometry;
        private FrameActionProceduralRigidVisualSettings2D debrisVisual;
        private bool configured;

        public int Capacity => ParticleCapacity;
        public int ActiveParticleCount => particles != null ? particles.particleCount : 0;
        public bool ListensToAllBodies => listenToAllBodies;

        private void Awake()
        {
            boundBody = GetComponent<FrameActionProceduralRigidBodyCore2D>();
            boundGeometry = GetComponent<FrameActionProceduralRigidGeometry2D>();
            if (boundGeometry != null) debrisVisual = boundGeometry.VisualSettings.NormalizedForRendering();
            EnsureConfigured();
            ApplySorting();
        }

        private void OnEnable()
        {
            FrameActionProceduralRigidBodyCore2D.AnyEventRaised += OnRigidEvent;
        }

        private void OnDisable()
        {
            FrameActionProceduralRigidBodyCore2D.AnyEventRaised -= OnRigidEvent;
        }

        /// <summary>
        /// Emits bounded, deterministic micro debris at a world-space point. Energy is normalized
        /// by the caller to 0..1. The normal controls the emission hemisphere and seed controls
        /// count, spread, lifetime and colour variation.
        /// </summary>
        public void EmitMicroDebris(Vector2 worldPoint, Vector2 normal, float energy, uint seed)
        {
            EmitMicroDebris(worldPoint, normal, Vector2.zero, energy, seed);
        }

        /// <summary>
        /// Emits visible, bounded debris whose count, apparent area, lifetime and travel distance
        /// all increase with the material-relative severity. Incoming velocity bends the outgoing
        /// hemisphere through a reflected impact direction without creating physical micro-bodies.
        /// </summary>
        public void EmitMicroDebris(
            Vector2 worldPoint,
            Vector2 normal,
            Vector2 incomingVelocity,
            float energy,
            uint seed)
        {
            if (!EnsureConfigured()) return;

            float normalizedEnergy = Mathf.Clamp01(energy);
            if (normalizedEnergy <= 0.001f) return;
            Vector2 outward = normal.sqrMagnitude > 0.000001f ? normal.normalized : Vector2.up;
            Vector2 reflected = incomingVelocity.sqrMagnitude > 0.000001f
                ? Vector2.Reflect(incomingVelocity.normalized, outward)
                : outward;
            if (Vector2.Dot(reflected, outward) < 0f) reflected = -reflected;
            Vector2 emissionAxis = (outward * 0.68f + reflected * 0.32f).normalized;
            float baseAngle = Mathf.Atan2(emissionAxis.y, emissionAxis.x);
            int count = CalculateParticleCount(normalizedEnergy);

            particles.randomSeed = seed == 0u ? 1u : seed;
            particles.useAutoRandomSeed = false;
            for (int index = 0; index < count; index++)
            {
                uint hash = Hash(seed ^ unchecked((uint)(index + 1) * 0x9e3779b9u));
                float lateral = HashUnit(hash ^ 0x85ebca6bu) * 2f - 1f;
                float angle = baseAngle + lateral * Mathf.Lerp(0.28f, 1.35f, normalizedEnergy);
                float severityCurve = Mathf.Pow(normalizedEnergy, 0.78f);
                float speed = baseSpeed + energySpeed * severityCurve
                    * Mathf.Lerp(0.58f, 1.22f, HashUnit(hash));
                Vector2 velocity = new Vector2(Mathf.Cos(angle), Mathf.Sin(angle)) * speed;
                velocity.y += Mathf.Lerp(0.16f, 1.55f, severityCurve);
                float lifetimeT = Mathf.Clamp01(normalizedEnergy * 0.76f
                    + HashUnit(hash ^ 0xc2b2ae35u) * 0.36f);
                float sizeT = Mathf.Clamp01(Mathf.Sqrt(normalizedEnergy)
                    * Mathf.Lerp(0.58f, 1f, HashUnit(hash ^ 0x27d4eb2fu)));

                ParticleSystem.EmitParams emission = new ParticleSystem.EmitParams
                {
                    position = worldPoint + outward * (0.005f + index * 0.00028f),
                    velocity = velocity,
                    startLifetime = Mathf.Lerp(minimumLifetime, maximumLifetime, lifetimeT),
                    startSize = Mathf.Lerp(minimumSize, maximumSize, sizeT),
                    rotation = HashUnit(hash ^ 0x165667b1u) * TwoPi,
                    angularVelocity = (HashUnit(hash ^ 0xd3a2646cu) * 2f - 1f) * Mathf.Lerp(2f, 11f, normalizedEnergy),
                    startColor = Color.Lerp(debrisBaseColor, debrisHighlightColor, HashUnit(hash ^ 0xfd7046c5u)),
                };
                particles.Emit(emission, 1);
            }
        }

        /// <summary>Convenience edge for a landing event; identical pool and safety rules apply.</summary>
        public void EmitLanded(Vector2 worldPoint, Vector2 contactNormal, float normalizedImpactEnergy, uint seed)
        {
            EmitMicroDebris(worldPoint, contactNormal, normalizedImpactEnergy, seed ^ 0x6a09e667u);
        }

        public static int CalculateParticleCount(float normalizedEnergy)
        {
            float severity = Mathf.Clamp01(normalizedEnergy);
            if (severity <= 0.001f) return 0;
            int requested = 2 + Mathf.RoundToInt(Mathf.Pow(severity, 0.72f) * 26f);
            return Mathf.Clamp(requested, 2, MaximumParticlesPerEvent);
        }

        public void ConfigureSorting(int sortingLayerId, int sortingOrder)
        {
            configuredSortingLayerId = sortingLayerId;
            configuredSortingOrder = sortingOrder;
            if (EnsureConfigured()) ApplySorting();
        }

        /// <summary>Marks this fixed pool as the generated map's shared program-rigid VFX sink.</summary>
        public void ConfigureAsGlobal(int sortingLayerId, int sortingOrder)
        {
            listenToAllBodies = true;
            configuredSortingLayerId = sortingLayerId;
            configuredSortingOrder = sortingOrder;
            if (Application.isPlaying && EnsureConfigured()) ApplySorting();
        }

        public void ConfigureVisual(FrameActionProceduralRigidVisualSettings2D visual)
        {
            debrisVisual = visual.NormalizedForRendering();
            debrisBaseColor = debrisVisual.baseColor;
            debrisBaseColor.a = debrisVisual.opacity;
            debrisHighlightColor = debrisVisual.highlightColor;
            debrisHighlightColor.a = debrisVisual.opacity;
            if (configured) ApplyVisualProperties();
        }

        private void OnRigidEvent(FrameActionProceduralRigidEvent2D visualEvent)
        {
            if (boundBody != null && visualEvent.BodyId != boundBody.BodyId) return;
            if (boundBody == null && !listenToAllBodies) return;
            ConfigureEventColors(visualEvent);
            float normalizedEnergy = visualEvent.Intensity01;
            switch (visualEvent.Kind)
            {
                case FrameActionProceduralRigidEventKind2D.MicroDebris:
                    EmitMicroDebris(visualEvent.WorldPoint, visualEvent.SurfaceNormalWorld,
                        visualEvent.IncomingVelocityWorld, normalizedEnergy, visualEvent.Seed);
                    break;
                case FrameActionProceduralRigidEventKind2D.Landed:
                    EmitMicroDebris(visualEvent.WorldPoint, visualEvent.SurfaceNormalWorld,
                        visualEvent.IncomingVelocityWorld, normalizedEnergy * 0.82f,
                        visualEvent.Seed ^ 0x6a09e667u);
                    break;
            }
        }

        private bool EnsureConfigured()
        {
            if (configured) return particles != null && particleRenderer != null && particleRenderer.sharedMaterial != null;

            particles = GetComponent<ParticleSystem>();
            particleRenderer = GetComponent<ParticleSystemRenderer>();
            ParticleSystem.MainModule main = particles.main;
            main.loop = false;
            main.playOnAwake = false;
            main.simulationSpace = ParticleSystemSimulationSpace.World;
            main.maxParticles = ParticleCapacity;
            main.startLifetime = maximumLifetime;
            main.startSpeed = 0f;
            main.startSize = minimumSize;
            main.gravityModifier = 0.62f;
            main.stopAction = ParticleSystemStopAction.None;

            ParticleSystem.EmissionModule emission = particles.emission;
            emission.enabled = false;
            ParticleSystem.ShapeModule shape = particles.shape;
            shape.enabled = false;
            ParticleSystem.CollisionModule collision = particles.collision;
            collision.enabled = false;
            ParticleSystem.TrailModule trails = particles.trails;
            trails.enabled = false;

            particleRenderer.renderMode = ParticleSystemRenderMode.Mesh;
            particleRenderer.alignment = ParticleSystemRenderSpace.View;
            runtimeShardMesh = new Mesh
            {
                name = $"SpriteCue Program Rigid Micro Debris [{name}]",
                hideFlags = HideFlags.DontSave,
                vertices = new[]
                {
                    new Vector3(-0.58f, -0.28f, 0f),
                    new Vector3(0.62f, -0.08f, 0f),
                    new Vector3(-0.16f, 0.57f, 0f),
                },
                colors = new[] { Color.white, Color.white, Color.white },
                uv = new[] { new Vector2(0f, 0f), new Vector2(9f, 2f), new Vector2(3f, 8f) },
                uv2 = new[] { Vector2.zero, Vector2.zero, Vector2.zero },
                triangles = new[] { 0, 1, 2 },
            };
            runtimeShardMesh.RecalculateBounds();
            particleRenderer.mesh = runtimeShardMesh;
            Material material = Resources.Load<Material>(MaterialResourcePath);
            if (material == null || material.shader == null
                || material.shader.name != ShaderName
                || !material.shader.isSupported)
            {
                configured = true;
                particleRenderer.enabled = false;
                Debug.LogError(
                    $"[SpriteCue Procedural Rigid] Micro-debris requires resource material "
                    + $"'{MaterialResourcePath}' using shader "
                    + $"'{ShaderName}'. Debris was disabled.",
                    this);
                return false;
            }

            particleRenderer.sharedMaterial = material;
            if (boundGeometry != null) ConfigureVisual(boundGeometry.VisualSettings);
            ApplyVisualProperties();
            configured = true;
            return true;
        }

        private void ApplyVisualProperties()
        {
            if (particleRenderer == null || particleRenderer.sharedMaterial == null) return;
            if (propertyBlock == null) propertyBlock = new MaterialPropertyBlock();
            propertyBlock.Clear();
            propertyBlock.SetColor(TintId, Color.white);
            particleRenderer.SetPropertyBlock(propertyBlock);
        }

        private void ConfigureEventColors(FrameActionProceduralRigidEvent2D visualEvent)
        {
            float opacity = Mathf.Clamp01(visualEvent.DebrisOpacity);
            debrisBaseColor = visualEvent.DebrisBaseColor;
            debrisBaseColor.a = opacity;
            debrisHighlightColor = visualEvent.DebrisHighlightColor;
            debrisHighlightColor.a = opacity;
        }

        private void ApplySorting()
        {
            if (particleRenderer == null) return;
            particleRenderer.sortingLayerID = configuredSortingLayerId;
            particleRenderer.sortingOrder = configuredSortingOrder;
        }

        private void OnDestroy()
        {
            if (runtimeShardMesh == null) return;
            if (Application.isPlaying) Destroy(runtimeShardMesh);
            else DestroyImmediate(runtimeShardMesh);
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
    }
}
