using System;
using System.Collections.Generic;
using UnityEngine;

namespace FrameAction
{
    /// <summary>Origin of an impact. Element/reaction semantics deliberately stay outside the package.</summary>
    public enum FrameActionProceduralRigidImpactCause2D
    {
        External,
        Landing,
        RigidBodyCollision,
    }

    public enum FrameActionProceduralRigidImpactResponse2D
    {
        None,
        MicroChip,
        Crack,
        Fracture,
    }

    public enum FrameActionProceduralRigidEventKind2D
    {
        Hit,
        // Presentation-only precursor. Receiving this event never means the collider or facet
        // ownership has changed; FractureStarted is the first structural-separation edge.
        Crack,
        MicroDebris,
        FractureStarted,
        FragmentCreated,
        Landed,
        AnchorReleased,
        Retired,
    }

    /// <summary>
    /// Project-independent impact command. EnergyJoules is authoritative when positive. When it
    /// is zero, the runtime derives kinetic energy once from EffectiveMassKilograms and the
    /// normal component of IncomingVelocityWorld. Incoming velocity is still used for direction
    /// and momentum when energy is supplied, but is never added to EnergyJoules a second time.
    /// </summary>
    [Serializable]
    public struct FrameActionProceduralRigidImpact2D
    {
        public Vector2 WorldPoint;
        public Vector2 IncomingVelocityWorld;
        public Vector2 SurfaceNormalWorld;
        [Min(0f)] public float EnergyJoules;
        [Min(0f)] public float EffectiveMassKilograms;
        [Min(0f)] public float ContactSpanWorld;
        public uint Seed;
        public FrameActionProceduralRigidImpactCause2D Cause;
    }

    /// <summary>Read-only measurement emitted before the runtime changes fracture state.</summary>
    public readonly struct FrameActionProceduralRigidImpactMetrics2D
    {
        public readonly float NormalSpeed;
        public readonly float EffectiveMass;
        public readonly float KineticEnergy;
        public readonly float NormalImpulse;
        public readonly float ContactStress;
        public readonly float EffectiveEnergy;
        public readonly FrameActionProceduralRigidImpactResponse2D Response;

        public FrameActionProceduralRigidImpactMetrics2D(
            float normalSpeed,
            float effectiveMass,
            float kineticEnergy,
            float normalImpulse,
            float contactStress,
            float effectiveEnergy,
            FrameActionProceduralRigidImpactResponse2D response)
        {
            NormalSpeed = normalSpeed;
            EffectiveMass = effectiveMass;
            KineticEnergy = kineticEnergy;
            NormalImpulse = normalImpulse;
            ContactStress = contactStress;
            EffectiveEnergy = effectiveEnergy;
            Response = response;
        }
    }

    public readonly struct FrameActionProceduralRigidEvent2D
    {
        public readonly FrameActionProceduralRigidEventKind2D Kind;
        public readonly uint BodyId;
        public readonly uint ParentBodyId;
        public readonly uint Revision;
        public readonly string TemplateId;
        public readonly string ElementTag;
        public readonly Vector2 WorldPoint;
        public readonly Vector2 IncomingVelocityWorld;
        public readonly Vector2 SurfaceNormalWorld;
        public readonly float EnergyJoules;
        public readonly float AffectedAreaWorld;
        public readonly uint Seed;
        public readonly Color DebrisBaseColor;
        public readonly Color DebrisHighlightColor;
        public readonly float DebrisOpacity;
        /// <summary>
        /// Threshold-relative visual severity, independent of the material's absolute joule scale.
        /// Presenters use this for count, size, lifetime and travel distance.
        /// </summary>
        public readonly float Intensity01;

        public FrameActionProceduralRigidEvent2D(
            FrameActionProceduralRigidEventKind2D kind,
            uint bodyId,
            uint parentBodyId,
            uint revision,
            string templateId,
            string elementTag,
            Vector2 worldPoint,
            Vector2 incomingVelocityWorld,
            Vector2 surfaceNormalWorld,
            float energyJoules,
            float affectedAreaWorld,
            uint seed)
            : this(
                kind,
                bodyId,
                parentBodyId,
                revision,
                templateId,
                elementTag,
                worldPoint,
                incomingVelocityWorld,
                surfaceNormalWorld,
                energyJoules,
                affectedAreaWorld,
                seed,
                new Color(0.42f, 0.46f, 0.52f, 1f),
                new Color(0.82f, 0.86f, 0.92f, 1f),
                1f,
                LegacyIntensity(energyJoules))
        {
        }

        public FrameActionProceduralRigidEvent2D(
            FrameActionProceduralRigidEventKind2D kind,
            uint bodyId,
            uint parentBodyId,
            uint revision,
            string templateId,
            string elementTag,
            Vector2 worldPoint,
            Vector2 incomingVelocityWorld,
            Vector2 surfaceNormalWorld,
            float energyJoules,
            float affectedAreaWorld,
            uint seed,
            Color debrisBaseColor,
            Color debrisHighlightColor,
            float debrisOpacity)
            : this(
                kind,
                bodyId,
                parentBodyId,
                revision,
                templateId,
                elementTag,
                worldPoint,
                incomingVelocityWorld,
                surfaceNormalWorld,
                energyJoules,
                affectedAreaWorld,
                seed,
                debrisBaseColor,
                debrisHighlightColor,
                debrisOpacity,
                LegacyIntensity(energyJoules))
        {
        }

        public FrameActionProceduralRigidEvent2D(
            FrameActionProceduralRigidEventKind2D kind,
            uint bodyId,
            uint parentBodyId,
            uint revision,
            string templateId,
            string elementTag,
            Vector2 worldPoint,
            Vector2 incomingVelocityWorld,
            Vector2 surfaceNormalWorld,
            float energyJoules,
            float affectedAreaWorld,
            uint seed,
            Color debrisBaseColor,
            Color debrisHighlightColor,
            float debrisOpacity,
            float intensity01)
        {
            Kind = kind;
            BodyId = bodyId;
            ParentBodyId = parentBodyId;
            Revision = revision;
            TemplateId = templateId;
            ElementTag = elementTag;
            WorldPoint = worldPoint;
            IncomingVelocityWorld = incomingVelocityWorld;
            SurfaceNormalWorld = surfaceNormalWorld;
            EnergyJoules = energyJoules;
            AffectedAreaWorld = affectedAreaWorld;
            Seed = seed;
            DebrisBaseColor = debrisBaseColor;
            DebrisHighlightColor = debrisHighlightColor;
            DebrisOpacity = Mathf.Clamp01(debrisOpacity);
            Intensity01 = Mathf.Clamp01(intensity01);
        }

        private static float LegacyIntensity(float energyJoules)
        {
            return energyJoules <= 0f ? 0f : energyJoules / (energyJoules + 8f);
        }
    }

    /// <summary>Allocation-free state query for presentation, diagnostics and save adapters.</summary>
    public readonly struct FrameActionProceduralRigidSnapshot2D
    {
        public readonly uint BodyId;
        public readonly uint ParentBodyId;
        public readonly uint Revision;
        public readonly uint AppearanceSeed;
        public readonly string TemplateId;
        public readonly string ElementTag;
        public readonly int Generation;
        public readonly Vector2 WorldCenterOfMass;
        public readonly Vector2 LinearVelocity;
        public readonly float RotationDegrees;
        public readonly float AngularVelocity;
        public readonly float AreaWorld;
        public readonly float AccumulatedDamage;
        public readonly bool IsRetired;

        public FrameActionProceduralRigidSnapshot2D(
            uint bodyId,
            uint parentBodyId,
            uint revision,
            uint appearanceSeed,
            string templateId,
            string elementTag,
            int generation,
            Vector2 worldCenterOfMass,
            Vector2 linearVelocity,
            float rotationDegrees,
            float angularVelocity,
            float areaWorld,
            float accumulatedDamage,
            bool isRetired)
        {
            BodyId = bodyId;
            ParentBodyId = parentBodyId;
            Revision = revision;
            AppearanceSeed = appearanceSeed;
            TemplateId = templateId;
            ElementTag = elementTag;
            Generation = generation;
            WorldCenterOfMass = worldCenterOfMass;
            LinearVelocity = linearVelocity;
            RotationDegrees = rotationDegrees;
            AngularVelocity = angularVelocity;
            AreaWorld = areaWorld;
            AccumulatedDamage = accumulatedDamage;
            IsRetired = isRetired;
        }
    }

    /// <summary>Pure calculations shared by runtime collision handling and deterministic tests.</summary>
    public static class FrameActionProceduralRigidPhysicsMath2D
    {
        public const float DefaultChipEnergyJoules = 0.30f;
        public const float DefaultCrackEnergyJoules = 1.10f;
        public const float DefaultBreakEnergyJoules = 3.25f;
        public const float DefaultContactStressSensitivity = 0.35f;
        public const int DefaultLandingCooldownTicks = 5;

        public static Vector2 CalculatePolygonAreaCentroid(IReadOnlyList<Vector2> points)
        {
            if (points == null || points.Count == 0) return Vector2.zero;
            double crossSum = 0d;
            double weightedX = 0d;
            double weightedY = 0d;
            Vector2 average = Vector2.zero;
            for (int index = 0; index < points.Count; index++)
            {
                Vector2 current = points[index];
                Vector2 next = points[(index + 1) % points.Count];
                double cross = (double)current.x * next.y - (double)next.x * current.y;
                crossSum += cross;
                weightedX += (current.x + next.x) * cross;
                weightedY += (current.y + next.y) * cross;
                average += current;
            }
            if (Math.Abs(crossSum) <= 0.0000001d) return average / points.Count;
            return new Vector2(
                (float)(weightedX / (3d * crossSum)),
                (float)(weightedY / (3d * crossSum)));
        }

        public static float CalculatePolygonArea(IReadOnlyList<Vector2> points)
        {
            if (points == null || points.Count < 3) return 0f;
            double sum = 0d;
            for (int index = 0; index < points.Count; index++)
            {
                Vector2 next = points[(index + 1) % points.Count];
                sum += (double)points[index].x * next.y - (double)next.x * points[index].y;
            }
            return Mathf.Abs((float)(sum * 0.5d));
        }

        public static float CalculateReducedMass(float firstMass, float secondMass, bool secondIsDynamic)
        {
            firstMass = Mathf.Max(0.0001f, firstMass);
            if (!secondIsDynamic) return firstMass;
            secondMass = Mathf.Max(0.0001f, secondMass);
            return firstMass * secondMass / (firstMass + secondMass);
        }

        public static bool IsContactCooldownElapsed(int previousTick, int currentTick, int cooldownTicks)
        {
            return cooldownTicks <= 0 || currentTick - previousTick >= cooldownTicks;
        }

        /// <summary>
        /// Computes one collision score in SI-like Unity units (kilograms, world units/second,
        /// joules). Contact stress only amplifies the already-computed kinetic energy; height is
        /// represented through impact velocity and must never be supplied as a second term.
        /// </summary>
        public static FrameActionProceduralRigidImpactMetrics2D EvaluateImpact(
            Vector2 relativeVelocity,
            Vector2 contactNormal,
            float effectiveMass,
            float reportedNormalImpulse,
            float contactSpanWorld,
            float explicitEnergyJoules,
            float accumulatedDamage01,
            float chipThresholdJoules,
            float crackThresholdJoules,
            float breakThresholdJoules,
            float contactStressSensitivity)
        {
            Vector2 normal = contactNormal.sqrMagnitude > 0.000001f
                ? contactNormal.normalized
                : Vector2.up;
            float normalSpeed = Mathf.Abs(Vector2.Dot(relativeVelocity, normal));
            effectiveMass = Mathf.Max(0.0001f, effectiveMass);
            float kineticEnergy = explicitEnergyJoules > 0f
                ? explicitEnergyJoules
                : 0.5f * effectiveMass * normalSpeed * normalSpeed;
            float predictedImpulse = effectiveMass * normalSpeed;
            float normalImpulse = Mathf.Max(Mathf.Max(0f, reportedNormalImpulse), predictedImpulse);
            float span = Mathf.Max(0.025f, contactSpanWorld);
            float stress = normalImpulse / span;
            float normalizedStress = stress / Mathf.Max(0.25f, effectiveMass * 4f);
            float stressGain = 1f + Mathf.Clamp(contactStressSensitivity, 0f, 4f)
                * Mathf.Clamp01(normalizedStress);
            float damageGain = 1f + Mathf.Clamp01(accumulatedDamage01) * 0.65f;
            float effectiveEnergy = kineticEnergy * stressGain * damageGain;

            chipThresholdJoules = ResolvePositive(chipThresholdJoules, DefaultChipEnergyJoules);
            crackThresholdJoules = Mathf.Max(chipThresholdJoules,
                ResolvePositive(crackThresholdJoules, DefaultCrackEnergyJoules));
            breakThresholdJoules = Mathf.Max(crackThresholdJoules,
                ResolvePositive(breakThresholdJoules, DefaultBreakEnergyJoules));
            FrameActionProceduralRigidImpactResponse2D response = effectiveEnergy >= breakThresholdJoules
                ? FrameActionProceduralRigidImpactResponse2D.Fracture
                : effectiveEnergy >= crackThresholdJoules
                    ? FrameActionProceduralRigidImpactResponse2D.Crack
                    : effectiveEnergy >= chipThresholdJoules
                        ? FrameActionProceduralRigidImpactResponse2D.MicroChip
                        : FrameActionProceduralRigidImpactResponse2D.None;
            return new FrameActionProceduralRigidImpactMetrics2D(
                normalSpeed,
                effectiveMass,
                kineticEnergy,
                normalImpulse,
                stress,
                effectiveEnergy,
                response);
        }

        /// <summary>
        /// Converts material properties into structural-fatigue speed. Hard, tough, ductile
        /// materials accumulate damage slowly; brittle low-toughness bodies accumulate it fast.
        /// Explicit energy thresholds still define when one hit chips, cracks or reaches the
        /// fracture band, while this scale defines how many such hits are needed for separation.
        /// </summary>
        public static float CalculateFatigueScale(
            float hardness,
            float toughness,
            float brittleness)
        {
            float brittleGain = Mathf.Lerp(0.48f, 1.42f, Mathf.Clamp01(brittleness));
            float toughnessResistance = Mathf.Lerp(1.18f, 0.42f, Mathf.Clamp01(toughness));
            float hardnessResistance = Mathf.Lerp(1.08f, 0.72f, Mathf.Clamp01(hardness));
            return Mathf.Clamp(brittleGain * toughnessResistance * hardnessResistance, 0.12f, 1.65f);
        }

        public static float CalculateFatigueDamage(
            float effectiveEnergy,
            float breakThresholdEnergy,
            FrameActionProceduralRigidImpactResponse2D response,
            FrameActionProceduralRigidPhysicalProfile2D profile)
        {
            if (response == FrameActionProceduralRigidImpactResponse2D.None) return 0f;
            float responseGain = response == FrameActionProceduralRigidImpactResponse2D.MicroChip
                ? 0.07f
                : response == FrameActionProceduralRigidImpactResponse2D.Crack ? 0.24f : 0.36f;
            float relativeEnergy = Mathf.Max(0f, effectiveEnergy)
                / Mathf.Max(0.001f, breakThresholdEnergy);
            return relativeEnergy * responseGain * CalculateFatigueScale(
                profile.hardness,
                profile.toughness,
                profile.brittleness);
        }

        /// <summary>
        /// Maps material-relative impact bands to a stable visual scale. Absolute joules cannot
        /// drive presentation directly: 40 J is catastrophic for authored ice but barely marks
        /// authored metal. The response band supplies the base tier and fatigue makes warning
        /// cracks/debris progressively clearer before structural separation.
        /// </summary>
        public static float CalculatePresentationIntensity(
            float effectiveEnergy,
            float chipThresholdEnergy,
            float crackThresholdEnergy,
            float breakThresholdEnergy,
            FrameActionProceduralRigidImpactResponse2D response,
            float accumulatedDamage01)
        {
            if (response == FrameActionProceduralRigidImpactResponse2D.None) return 0f;
            float chip = ResolvePositive(chipThresholdEnergy, DefaultChipEnergyJoules);
            float crack = Mathf.Max(chip, ResolvePositive(crackThresholdEnergy, DefaultCrackEnergyJoules));
            float fracture = Mathf.Max(crack, ResolvePositive(breakThresholdEnergy, DefaultBreakEnergyJoules));
            float energy = Mathf.Max(0f, effectiveEnergy);
            float bandIntensity;
            if (response == FrameActionProceduralRigidImpactResponse2D.MicroChip)
            {
                bandIntensity = Mathf.Lerp(0.10f, 0.32f, InverseLerpSafe(chip, crack, energy));
            }
            else if (response == FrameActionProceduralRigidImpactResponse2D.Crack)
            {
                bandIntensity = Mathf.Lerp(0.34f, 0.68f, InverseLerpSafe(crack, fracture, energy));
            }
            else
            {
                bandIntensity = Mathf.Lerp(0.70f, 1f,
                    InverseLerpSafe(fracture, Mathf.Max(fracture + 0.001f, fracture * 3f), energy));
            }
            return Mathf.Clamp01(Mathf.Max(bandIntensity, Mathf.Clamp01(accumulatedDamage01) * 0.72f));
        }

        private static float InverseLerpSafe(float minimum, float maximum, float value)
        {
            if (maximum <= minimum + 0.000001f) return value >= maximum ? 1f : 0f;
            return Mathf.Clamp01((value - minimum) / (maximum - minimum));
        }

        public static float ResolvePositive(float value, float fallback)
        {
            return value > 0.000001f ? value : fallback;
        }
    }
}
