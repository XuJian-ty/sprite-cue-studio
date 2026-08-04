using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;

namespace FrameAction.Tests
{
    public sealed class FrameActionProceduralRigidPhysicsTests
    {
        [Test]
        public void AreaCentroidUsesPolygonMassNotVertexAverage()
        {
            Vector2[] polygon =
            {
                new Vector2(0f, 0f),
                new Vector2(4f, 0f),
                new Vector2(4f, 1f),
                new Vector2(1f, 1f),
                new Vector2(1f, 3f),
                new Vector2(0f, 3f),
            };

            Vector2 center = FrameActionProceduralRigidPhysicsMath2D.CalculatePolygonAreaCentroid(polygon);

            Assert.That(center.x, Is.EqualTo(1.5f).Within(0.0001f));
            Assert.That(center.y, Is.EqualTo(1f).Within(0.0001f));
            Assert.That(FrameActionProceduralRigidPhysicsMath2D.CalculatePolygonArea(polygon),
                Is.EqualTo(6f).Within(0.0001f));
        }

        [Test]
        public void HeightVelocityAndMassIncreaseLandingEnergyWithoutDoubleCounting()
        {
            const float gravity = 9.81f;
            float lowVelocity = Mathf.Sqrt(2f * gravity * 0.25f);
            float highVelocity = Mathf.Sqrt(2f * gravity * 2f);
            FrameActionProceduralRigidImpactMetrics2D low = Evaluate(new Vector2(0f, -lowVelocity), 0.5f);
            FrameActionProceduralRigidImpactMetrics2D high = Evaluate(new Vector2(0f, -highVelocity), 0.5f);
            FrameActionProceduralRigidImpactMetrics2D heavy = Evaluate(new Vector2(0f, -highVelocity), 2f);

            Assert.That(high.KineticEnergy, Is.GreaterThan(low.KineticEnergy));
            Assert.That(heavy.KineticEnergy, Is.GreaterThan(high.KineticEnergy));
            Assert.That(high.KineticEnergy, Is.EqualTo(0.5f * 0.5f * highVelocity * highVelocity).Within(0.0001f));

            FrameActionProceduralRigidImpactMetrics2D explicitEnergy =
                FrameActionProceduralRigidPhysicsMath2D.EvaluateImpact(
                    new Vector2(0f, -100f), Vector2.up, 20f, 0f, 1f, 7f, 0f,
                    1f, 4f, 9f, 0f);
            Assert.That(explicitEnergy.KineticEnergy, Is.EqualTo(7f).Within(0.0001f),
                "Explicit energy replaces the velocity-derived term; it is not added twice.");
        }

        [Test]
        public void GrazingImpactWithLowNormalVelocityDoesNotBreak()
        {
            FrameActionProceduralRigidImpactMetrics2D result =
                FrameActionProceduralRigidPhysicsMath2D.EvaluateImpact(
                    new Vector2(30f, -0.03f), Vector2.up, 4f, 0f, 0.2f, 0f, 0f,
                    1.5f, 4f, 9f, 1f);

            Assert.That(result.NormalSpeed, Is.EqualTo(0.03f).Within(0.0001f));
            Assert.That(result.Response, Is.EqualTo(FrameActionProceduralRigidImpactResponse2D.None));
        }

        [Test]
        public void ContactCooldownRejectsRestingDuplicatesAndAllowsLaterImpact()
        {
            Assert.That(FrameActionProceduralRigidPhysicsMath2D.IsContactCooldownElapsed(100, 102, 6), Is.False);
            Assert.That(FrameActionProceduralRigidPhysicsMath2D.IsContactCooldownElapsed(100, 106, 6), Is.True);
            Assert.That(FrameActionProceduralRigidPhysicsMath2D.IsContactCooldownElapsed(100, 100, 0), Is.True);
        }

        [Test]
        public void MaterialTemplatesProduceDistinctPhysicalProfiles()
        {
            FrameActionProceduralRigidPhysicalProfile2D ice =
                FrameActionProceduralRigidPhysicalProfile2D.Defaults("iceCrystal");
            FrameActionProceduralRigidPhysicalProfile2D wood =
                FrameActionProceduralRigidPhysicalProfile2D.Defaults("wood");
            FrameActionProceduralRigidPhysicalProfile2D metal =
                FrameActionProceduralRigidPhysicalProfile2D.Defaults("metal");
            FrameActionProceduralRigidPhysicalProfile2D stone =
                FrameActionProceduralRigidPhysicalProfile2D.Defaults("stone");

            Assert.That(metal.density, Is.GreaterThan(stone.density));
            Assert.That(stone.density, Is.GreaterThan(ice.density));
            Assert.That(wood.anisotropy, Is.GreaterThan(ice.anisotropy));
            Assert.That(ice.brittleness, Is.GreaterThan(metal.brittleness));
            Assert.That(metal.toughness, Is.GreaterThan(stone.toughness));
        }

        [Test]
        public void FatigueMakesIceFailBeforeWoodStoneAndMetalWhileStillShowingCracksFirst()
        {
            FrameActionProceduralRigidPhysicalProfile2D ice =
                FrameActionProceduralRigidPhysicalProfile2D.Defaults("iceCrystal");
            FrameActionProceduralRigidPhysicalProfile2D wood =
                FrameActionProceduralRigidPhysicalProfile2D.Defaults("wood");
            FrameActionProceduralRigidPhysicalProfile2D stone =
                FrameActionProceduralRigidPhysicalProfile2D.Defaults("stone");
            FrameActionProceduralRigidPhysicalProfile2D metal =
                FrameActionProceduralRigidPhysicalProfile2D.Defaults("metal");

            float iceAtBreak = FrameActionProceduralRigidPhysicsMath2D.CalculateFatigueDamage(
                40f, 40f, FrameActionProceduralRigidImpactResponse2D.Fracture, ice);
            float woodAtBreak = FrameActionProceduralRigidPhysicsMath2D.CalculateFatigueDamage(
                90f, 90f, FrameActionProceduralRigidImpactResponse2D.Fracture, wood);
            float stoneAtBreak = FrameActionProceduralRigidPhysicsMath2D.CalculateFatigueDamage(
                180f, 180f, FrameActionProceduralRigidImpactResponse2D.Fracture, stone);
            float metalAtBreak = FrameActionProceduralRigidPhysicsMath2D.CalculateFatigueDamage(
                800f, 800f, FrameActionProceduralRigidImpactResponse2D.Fracture, metal);

            Assert.That(iceAtBreak, Is.LessThan(1f),
                "A threshold-level ice hit must create visible structural cracking before separation.");
            Assert.That(iceAtBreak, Is.GreaterThan(woodAtBreak));
            Assert.That(woodAtBreak, Is.GreaterThan(stoneAtBreak));
            Assert.That(stoneAtBreak, Is.GreaterThan(metalAtBreak));
            Assert.That(metalAtBreak, Is.LessThan(0.1f),
                "Iron must require many fracture-band attacks before it releases a piece.");

            float lowIceLanding = FrameActionProceduralRigidPhysicsMath2D.CalculateFatigueDamage(
                60f, 220f, FrameActionProceduralRigidImpactResponse2D.Crack, ice);
            float catastrophicIceLanding = FrameActionProceduralRigidPhysicsMath2D.CalculateFatigueDamage(
                660f, 220f, FrameActionProceduralRigidImpactResponse2D.Fracture, ice);
            Assert.That(lowIceLanding, Is.GreaterThan(0f).And.LessThan(0.25f),
                "A modest ice landing may leave a crack but cannot split the body immediately.");
            Assert.That(catastrophicIceLanding, Is.GreaterThanOrEqualTo(1f),
                "A genuinely catastrophic fall may still fracture ice in one contact.");
        }

        [Test]
        public void VisualEventCarriesPerBodyDebrisColoursWithoutBreakingLegacyConstructor()
        {
            Color baseColor = new Color(0.12f, 0.55f, 0.82f, 0.9f);
            Color highlightColor = new Color(0.81f, 0.96f, 1f, 1f);
            var styled = new FrameActionProceduralRigidEvent2D(
                FrameActionProceduralRigidEventKind2D.MicroDebris,
                11u, 0u, 3u, "iceCrystal", "冰",
                Vector2.one, Vector2.down, Vector2.up,
                7f, 0.2f, 99u,
                baseColor, highlightColor, 0.73f, 0.64f);
            Assert.That(styled.DebrisBaseColor, Is.EqualTo(baseColor));
            Assert.That(styled.DebrisHighlightColor, Is.EqualTo(highlightColor));
            Assert.That(styled.DebrisOpacity, Is.EqualTo(0.73f).Within(0.0001f));
            Assert.That(styled.Intensity01, Is.EqualTo(0.64f).Within(0.0001f));

            var legacy = new FrameActionProceduralRigidEvent2D(
                FrameActionProceduralRigidEventKind2D.Hit,
                12u, 0u, 1u, "custom", "石",
                Vector2.zero, Vector2.zero, Vector2.up,
                1f, 0f, 100u);
            Assert.That(legacy.DebrisOpacity, Is.EqualTo(1f));
            Assert.That(legacy.DebrisBaseColor.a, Is.EqualTo(1f));
            Assert.That(legacy.Intensity01, Is.GreaterThan(0f));
        }

        [Test]
        public void PresentationSeverityAndDebrisIncreaseAcrossPhysicalImpactBands()
        {
            float chip = FrameActionProceduralRigidPhysicsMath2D.CalculatePresentationIntensity(
                4f, 4f, 12f, 40f, FrameActionProceduralRigidImpactResponse2D.MicroChip, 0.05f);
            float crack = FrameActionProceduralRigidPhysicsMath2D.CalculatePresentationIntensity(
                20f, 4f, 12f, 40f, FrameActionProceduralRigidImpactResponse2D.Crack, 0.35f);
            float breakLevel = FrameActionProceduralRigidPhysicsMath2D.CalculatePresentationIntensity(
                40f, 4f, 12f, 40f, FrameActionProceduralRigidImpactResponse2D.Fracture, 0.72f);
            float catastrophic = FrameActionProceduralRigidPhysicsMath2D.CalculatePresentationIntensity(
                120f, 4f, 12f, 40f, FrameActionProceduralRigidImpactResponse2D.Fracture, 1f);

            Assert.That(chip, Is.LessThan(crack));
            Assert.That(crack, Is.LessThan(breakLevel));
            Assert.That(breakLevel, Is.LessThan(catastrophic));
            Assert.That(FrameActionProceduralRigidDebrisPresenter2D.CalculateParticleCount(chip),
                Is.LessThan(FrameActionProceduralRigidDebrisPresenter2D.CalculateParticleCount(crack)));
            Assert.That(FrameActionProceduralRigidDebrisPresenter2D.CalculateParticleCount(catastrophic),
                Is.GreaterThanOrEqualTo(26));
        }

        [Test]
        public void FractureIsConnectedConservativeAndCanRepeatAtLaterGenerations()
        {
            List<FrameActionProceduralRigidVisualFacet2D> source = BuildGridFacets(4, 3, 10f);
            FrameActionProceduralRigidFractureSettings2D settings = Settings(0.25f, 0.05f);
            float sourceArea = SumArea(source);

            Assert.That(FrameActionProceduralRigidFracturePlanner2D.TryBuildPlan(
                source, 10f, settings, new Vector2(1.2f, 1.1f), new Vector2(1f, -0.25f),
                2.5f, 123u, out FrameActionProceduralRigidFracturePlan2D first), Is.True);
            Assert.That(first.Pieces.Count, Is.InRange(3, 8));
            Assert.That(SumPieceArea(first), Is.EqualTo(sourceArea).Within(0.0001f));

            FrameActionProceduralRigidFracturePiece2D largest = first.Pieces[0];
            for (int index = 1; index < first.Pieces.Count; index++)
                if (first.Pieces[index].Area > largest.Area) largest = first.Pieces[index];
            Assert.That(FrameActionProceduralRigidFracturePlanner2D.TryBuildPlan(
                largest.Facets, 10f, settings, largest.Centroid, Vector2.down,
                2.2f, 456u, out FrameActionProceduralRigidFracturePlan2D second), Is.True);
            Assert.That(SumPieceArea(second), Is.EqualTo(largest.Area).Within(0.0001f));
        }

        [Test]
        public void PerImpactBudgetCapsPhysicalFragmentsAndConservesArea()
        {
            List<FrameActionProceduralRigidVisualFacet2D> source = BuildGridFacets(5, 4, 10f);
            FrameActionProceduralRigidFractureSettings2D settings = Settings(0.1f, 0.02f);
            settings.maxFragmentsPerImpact = 4;
            Assert.That(FrameActionProceduralRigidFracturePlanner2D.TryBuildPlan(
                source, 10f, settings, FrameActionProceduralRigidPhysicalProfile2D.Defaults("iceCrystal"),
                new Vector2(2f, 2f), Vector2.right, 3f, 761u,
                out FrameActionProceduralRigidFracturePlan2D plan), Is.True);
            Assert.That(plan.Pieces.Count, Is.InRange(2, 4));
            Assert.That(SumPieceArea(plan), Is.EqualTo(SumArea(source)).Within(0.0001f));
        }

        [Test]
        public void FractureGraphFollowsImpactDirectionWithoutOneOutlineVertexFan()
        {
            List<FrameActionProceduralRigidVisualFacet2D> source = BuildGridFacets(8, 5, 10f);
            FrameActionProceduralRigidFractureSettings2D settings = Settings(0.08f, 0.02f);
            FrameActionProceduralRigidPhysicalProfile2D ice =
                FrameActionProceduralRigidPhysicalProfile2D.Defaults("iceCrystal");
            Vector2 hit = new Vector2(0.05f, 2.4f);
            Assert.That(FrameActionProceduralRigidFracturePlanner2D.TryBuildPlan(
                source, 10f, settings, ice, hit, new Vector2(1f, 0.35f), 2.4f, 517u,
                out FrameActionProceduralRigidFracturePlan2D rising), Is.True);
            Assert.That(FrameActionProceduralRigidFracturePlanner2D.TryBuildPlan(
                source, 10f, settings, ice, hit, new Vector2(1f, -0.35f), 2.4f, 517u,
                out FrameActionProceduralRigidFracturePlan2D falling), Is.True);

            Assert.That(FractureSignature(rising), Is.Not.EqualTo(FractureSignature(falling)),
                "Changing incoming direction must change the physical partition, not only VFX velocity.");
            Assert.That(rising.Cracks.Count, Is.GreaterThanOrEqualTo(3));
            var incidence = new Dictionary<string, int>();
            for (int index = 0; index < rising.Cracks.Count; index++)
            {
                Increment(incidence, rising.Cracks[index].A);
                Increment(incidence, rising.Cracks[index].B);
            }
            int maximum = 0;
            foreach (int count in incidence.Values) maximum = Mathf.Max(maximum, count);
            Assert.That(maximum, Is.LessThan(rising.Cracks.Count),
                "No single facet or outline vertex may anchor every fracture edge.");
        }

        [Test]
        public void RealBodyShowsContactDrivenCracksBeforeItQueuesPhysicalSeparation()
        {
            GameObject owner = new GameObject("staged-rigid-impact-test");
            try
            {
                FrameActionProceduralRigidSource2D source = owner.AddComponent<FrameActionProceduralRigidSource2D>();
                source.sourceId = "staged-ice";
                source.seed = 0x731u;
                source.templateId = "iceCrystal";
                source.elementTag = "冰";
                source.sourcePixelsPerUnit = 32f;
                source.localOutline = new[]
                {
                    new Vector2(-2f, -1f), new Vector2(2f, -1f),
                    new Vector2(2f, 1f), new Vector2(-2f, 1f),
                };
                source.edgeRoles = new[]
                {
                    FrameActionProceduralRigidEdgeRole.Exposed,
                    FrameActionProceduralRigidEdgeRole.Exposed,
                    FrameActionProceduralRigidEdgeRole.Exposed,
                    FrameActionProceduralRigidEdgeRole.Exposed,
                };
                source.facets = new[]
                {
                    AuthoringFacet(1, source.localOutline[0], source.localOutline[1], source.localOutline[2]),
                    AuthoringFacet(2, source.localOutline[0], source.localOutline[2], source.localOutline[3]),
                };
                source.visual = new FrameActionProceduralRigidVisualSettings2D
                {
                    templateId = "iceCrystal",
                    opacity = 1f,
                    baseColor = new Color(0.3f, 0.75f, 0.9f, 1f),
                    shadowColor = new Color(0.03f, 0.12f, 0.28f, 1f),
                    highlightColor = Color.white,
                    edgeColor = new Color(0.7f, 0.95f, 1f, 1f),
                    facetScale = 24f,
                    volumeDepth = 0.75f,
                    transmission = 0.6f,
                    absorption = 0.35f,
                    roughness = 0.2f,
                    specularStrength = 0.8f,
                };
                source.physical = FrameActionProceduralRigidPhysicalProfile2D.Defaults("iceCrystal");
                source.fracture = Settings(12f, 1f);
                source.fracture.impactChipEnergy = 4f;
                source.fracture.impactCrackEnergy = 12f;
                source.fracture.impactBreakEnergy = 40f;
                source.fracture.contactStressSensitivity = 0.35f;

                FrameActionProceduralRigidBody2D body = owner.AddComponent<FrameActionProceduralRigidBody2D>();
                Assert.That(body.InitializeFromSource(source), Is.True);
                FrameActionProceduralRigidGeometry2D geometry =
                    owner.GetComponent<FrameActionProceduralRigidGeometry2D>();
                var impact = new FrameActionProceduralRigidImpact2D
                {
                    WorldPoint = new Vector2(-2f, 0.15f),
                    IncomingVelocityWorld = Vector2.right * 8f,
                    SurfaceNormalWorld = Vector2.left,
                    EnergyJoules = 40f,
                    ContactSpanWorld = 0.25f,
                    Seed = 0x991u,
                    Cause = FrameActionProceduralRigidImpactCause2D.External,
                };

                Assert.That(body.ApplyImpact(impact), Is.True);
                Assert.That(body.IsFracturePending, Is.False,
                    "A normal fracture-band attack must leave a readable crack phase first.");
                Assert.That(body.AccumulatedDamage, Is.InRange(0.25f, 0.99f));
                Assert.That(geometry.CrackCount, Is.GreaterThanOrEqualTo(3));
                PolygonCollider2D collider = owner.GetComponent<PolygonCollider2D>();
                Assert.That(collider.pathCount, Is.EqualTo(1));
                CollectionAssert.AreEqual(source.localOutline, collider.GetPath(0),
                    "Pre-fracture crack VFX must not cut or replace the authoritative collider.");
                Assert.That(geometry.FacetCount, Is.EqualTo(2),
                    "Pre-fracture crack VFX must not repartition physical facet ownership.");
                FrameActionProceduralRigidCrackSegment2D first = geometry.GetCrack(0);
                for (int vertex = 0; vertex < source.localOutline.Length; vertex++)
                    Assert.That(Vector2.Distance(first.A, source.localOutline[vertex]), Is.GreaterThan(0.05f),
                        "The visual crack may start at the physical contact, never at an arbitrary outline vertex.");

                int hits = 1;
                while (!body.IsFracturePending && hits++ < 8) body.ApplyImpact(impact);
                Assert.That(body.IsFracturePending, Is.True,
                    "Repeated structural attacks must eventually queue physical separation.");
            }
            finally
            {
                Object.DestroyImmediate(owner);
            }
        }

        [Test]
        public void GenericSurfaceTrimUpdatesColliderFacetsAndMassTogether()
        {
            GameObject owner = new GameObject("generic-rigid-surface-trim-test");
            try
            {
                FrameActionProceduralRigidSource2D source = owner.AddComponent<FrameActionProceduralRigidSource2D>();
                source.sourceId = "generic-surface-trim";
                source.seed = 0x814u;
                source.templateId = "stone";
                source.elementTag = "game-defined-tag";
                source.sourcePixelsPerUnit = 32f;
                source.localOutline = new[]
                {
                    new Vector2(-2f, -1f), new Vector2(2f, -1f),
                    new Vector2(2f, 1f), new Vector2(-2f, 1f),
                };
                source.facets = new[]
                {
                    AuthoringFacet(1, source.localOutline[0], source.localOutline[1], source.localOutline[2]),
                    AuthoringFacet(2, source.localOutline[0], source.localOutline[2], source.localOutline[3]),
                };
                source.visual = new FrameActionProceduralRigidVisualSettings2D
                {
                    templateId = "stone",
                    opacity = 1f,
                    baseColor = Color.gray,
                    shadowColor = Color.black,
                    highlightColor = Color.white,
                    edgeColor = Color.white,
                    fractureColor = Color.white,
                    facetScale = 24f,
                    roughness = 0.8f,
                };
                source.physical = FrameActionProceduralRigidPhysicalProfile2D.Defaults("stone");
                source.fracture = Settings(12f, 1f);
                FrameActionProceduralRigidBody2D body = owner.AddComponent<FrameActionProceduralRigidBody2D>();
                Assert.That(body.InitializeFromSource(source), Is.True);
                float areaBefore = body.AreaWorld;

                Assert.That(body.TryTrimSurface(
                    new Vector2(2f, 0f),
                    0.25f,
                    out Vector2[] removedWorldBoundary), Is.True);

                Assert.That(removedWorldBoundary.Length, Is.GreaterThanOrEqualTo(4));
                Assert.That(body.AreaWorld, Is.LessThan(areaBefore));
                Assert.That(body.AreaWorld, Is.EqualTo(7.5f).Within(0.01f));
                PolygonCollider2D collider = owner.GetComponent<PolygonCollider2D>();
                Assert.That(collider.bounds.max.x, Is.EqualTo(1.75f).Within(0.01f));
                FrameActionProceduralRigidGeometry2D geometry =
                    owner.GetComponent<FrameActionProceduralRigidGeometry2D>();
                Assert.That(geometry.FacetCount, Is.GreaterThanOrEqualTo(2));
                for (int index = 0; index < geometry.FacetCount; index++)
                {
                    FrameActionProceduralRigidVisualFacet2D facet = geometry.GetFacet(index);
                    Assert.That(owner.transform.TransformPoint(facet.A).x, Is.LessThanOrEqualTo(1.751f));
                    Assert.That(Vector2.Distance(
                        facet.AuthoringUvA / source.sourcePixelsPerUnit,
                        owner.transform.TransformPoint(facet.A)), Is.LessThan(0.001f));
                }
            }
            finally
            {
                Object.DestroyImmediate(owner);
            }
        }

        [Test]
        public void SubdivisionKeepsMotherAuthoringCoordinates()
        {
            var source = new List<FrameActionProceduralRigidVisualFacet2D>
            {
                Facet(1, new Vector2(0f, 0f), new Vector2(4f, 0f), new Vector2(0f, 4f), 10f),
            };
            FrameActionProceduralRigidFractureSettings2D settings = Settings(0.01f, 0.005f);
            Assert.That(FrameActionProceduralRigidFracturePlanner2D.TryBuildPlan(
                source, 10f, settings, new Vector2(0.4f, 0.4f), Vector2.right,
                2.5f, 91u, out FrameActionProceduralRigidFracturePlan2D plan), Is.True);

            for (int piece = 0; piece < plan.Pieces.Count; piece++)
            for (int index = 0; index < plan.Pieces[piece].Facets.Count; index++)
            {
                FrameActionProceduralRigidVisualFacet2D facet = plan.Pieces[piece].Facets[index];
                Assert.That(facet.AuthoringUvA, Is.EqualTo(facet.A * 10f));
                Assert.That(facet.AuthoringUvB, Is.EqualTo(facet.B * 10f));
                Assert.That(facet.AuthoringUvC, Is.EqualTo(facet.C * 10f));
            }
        }

        private static FrameActionProceduralRigidImpactMetrics2D Evaluate(Vector2 velocity, float mass)
        {
            return FrameActionProceduralRigidPhysicsMath2D.EvaluateImpact(
                velocity, Vector2.up, mass, 0f, 0.5f, 0f, 0f,
                1.5f, 4f, 9f, 1f);
        }

        private static FrameActionProceduralRigidFractureSettings2D Settings(float minArea, float minWidth)
        {
            return new FrameActionProceduralRigidFractureSettings2D
            {
                primaryFragmentMin = 3,
                primaryFragmentMax = 8,
                minimumFragmentAreaPixelsSquared = minArea,
                minimumFragmentWidthPixels = minWidth,
                crackBranchMin = 1,
                crackBranchMax = 2,
                releaseDelayTicks = 1,
                impactChipEnergy = 1.5f,
                impactCrackEnergy = 4f,
                impactBreakEnergy = 9f,
                collisionBreakThreshold = 7f,
                landingChipEnergy = 1.5f,
                landingCrackEnergy = 4f,
                landingBreakEnergy = 9f,
                contactStressSensitivity = 1f,
                landingCooldownTicks = 6,
                maxFragmentsPerImpact = 8,
                maxActiveFragmentsPerFamily = 48,
            };
        }

        private static List<FrameActionProceduralRigidVisualFacet2D> BuildGridFacets(int width, int height, float ppu)
        {
            var result = new List<FrameActionProceduralRigidVisualFacet2D>(width * height * 2);
            int id = 1;
            for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++)
            {
                Vector2 a = new Vector2(x, y);
                Vector2 b = new Vector2(x + 1, y);
                Vector2 c = new Vector2(x + 1, y + 1);
                Vector2 d = new Vector2(x, y + 1);
                result.Add(Facet(id++, a, b, c, ppu));
                result.Add(Facet(id++, a, c, d, ppu));
            }
            return result;
        }

        private static FrameActionProceduralRigidVisualFacet2D Facet(
            int id, Vector2 a, Vector2 b, Vector2 c, float ppu)
        {
            return new FrameActionProceduralRigidVisualFacet2D(
                id, a, b, c, a * ppu, b * ppu, c * ppu, 0.5f);
        }

        private static FrameActionProceduralRigidFacet2D AuthoringFacet(
            int id, Vector2 a, Vector2 b, Vector2 c)
        {
            return new FrameActionProceduralRigidFacet2D
            {
                id = id,
                localPoints = new[] { a, b, c },
                shade = 0.5f,
            };
        }

        private static float SumArea(IReadOnlyList<FrameActionProceduralRigidVisualFacet2D> facets)
        {
            float area = 0f;
            for (int index = 0; index < facets.Count; index++) area += facets[index].Area;
            return area;
        }

        private static float SumPieceArea(FrameActionProceduralRigidFracturePlan2D plan)
        {
            float area = 0f;
            for (int index = 0; index < plan.Pieces.Count; index++) area += plan.Pieces[index].Area;
            return area;
        }

        private static string FractureSignature(FrameActionProceduralRigidFracturePlan2D plan)
        {
            var result = new System.Text.StringBuilder();
            for (int piece = 0; piece < plan.Pieces.Count; piece++)
            {
                var ids = new List<int>();
                for (int index = 0; index < plan.Pieces[piece].Facets.Count; index++)
                    ids.Add(plan.Pieces[piece].Facets[index].Id);
                ids.Sort();
                result.Append('[').Append(string.Join(",", ids)).Append(']');
            }
            return result.ToString();
        }

        private static void Increment(Dictionary<string, int> counts, Vector2 point)
        {
            string key = $"{Mathf.RoundToInt(point.x * 10000f)},{Mathf.RoundToInt(point.y * 10000f)}";
            counts.TryGetValue(key, out int count);
            counts[key] = count + 1;
        }
    }
}
