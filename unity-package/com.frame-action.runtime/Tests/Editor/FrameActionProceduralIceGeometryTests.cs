using System;
using System.Collections.Generic;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;

namespace FrameAction.Tests
{
    public sealed class FrameActionProceduralRigidGeometryTests
    {
        [Test]
        public void LegacyOpticalSettingsReceiveVolumetricDefaults()
        {
            FrameActionProceduralRigidVisualSettings2D legacy = new FrameActionProceduralRigidVisualSettings2D
            {
                textureStrength = 0.64f,
                edgeBrightness = 0.81f,
            };

            FrameActionProceduralRigidVisualSettings2D upgraded = legacy.NormalizedForIceRendering();

            Assert.That(upgraded.textureStrength, Is.EqualTo(0.64f));
            Assert.That(upgraded.edgeBrightness, Is.EqualTo(0.81f));
            Assert.That(upgraded.volumeDepth, Is.GreaterThan(0.5f));
            Assert.That(upgraded.transmission, Is.GreaterThan(0.5f));
            Assert.That(upgraded.specularStrength, Is.GreaterThan(0.5f));
            Assert.That(upgraded.lightAngleDegrees, Is.EqualTo(132f).Within(0.001f));
        }

        [Test]
        public void TemplatesProduceDistinctAuthoritativePalettes()
        {
            FrameActionProceduralRigidVisualSettings2D ice = new FrameActionProceduralRigidVisualSettings2D { templateId = "iceCrystal" }.NormalizedForRendering();
            FrameActionProceduralRigidVisualSettings2D wood = new FrameActionProceduralRigidVisualSettings2D { templateId = "wood" }.NormalizedForRendering();
            FrameActionProceduralRigidVisualSettings2D metal = new FrameActionProceduralRigidVisualSettings2D { templateId = "metal" }.NormalizedForRendering();
            FrameActionProceduralRigidVisualSettings2D stone = new FrameActionProceduralRigidVisualSettings2D { templateId = "stone" }.NormalizedForRendering();

            Assert.That(ice.transmission, Is.GreaterThan(wood.transmission));
            Assert.That(metal.specularStrength, Is.GreaterThan(stone.specularStrength));
            Assert.That(wood.anisotropy, Is.GreaterThan(stone.anisotropy));
            Assert.That(ice.baseColor, Is.Not.EqualTo(wood.baseColor));
            Assert.That(wood.baseColor, Is.Not.EqualTo(metal.baseColor));
            Assert.That(metal.baseColor, Is.Not.EqualTo(stone.baseColor));
            Assert.That(ice.fractureColor, Is.Not.EqualTo(wood.fractureColor));
            Assert.That(wood.fractureColor, Is.Not.EqualTo(metal.fractureColor));
            Assert.That(metal.fractureColor, Is.Not.EqualTo(stone.fractureColor));
        }

        [Test]
        public void PhysicalRecenteringDoesNotMoveAuthoringTextureCoordinates()
        {
            GameObject gameObject = new GameObject("ice-visual-test");
            try
            {
                FrameActionProceduralRigidSource2D source = CreateTriangleSource(gameObject, 817u);
                FrameActionProceduralRigidGeometry2D geometry = gameObject.AddComponent<FrameActionProceduralRigidGeometry2D>();
                geometry.InitializeFromAuthoring(source);
                FrameActionProceduralRigidVisualFacet2D before = geometry.GetFacet(0);

                Vector2 physicalCentroidOffset = new Vector2(0.73f, -0.29f);
                geometry.TranslateLocal(physicalCentroidOffset);
                FrameActionProceduralRigidVisualFacet2D after = geometry.GetFacet(0);

                Assert.That(after.A, Is.EqualTo(before.A - physicalCentroidOffset));
                Assert.That(after.B, Is.EqualTo(before.B - physicalCentroidOffset));
                Assert.That(after.C, Is.EqualTo(before.C - physicalCentroidOffset));
                Assert.That(after.AuthoringUvA, Is.EqualTo(before.AuthoringUvA));
                Assert.That(after.AuthoringUvB, Is.EqualTo(before.AuthoringUvB));
                Assert.That(after.AuthoringUvC, Is.EqualTo(before.AuthoringUvC));
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(gameObject);
            }
        }

        [Test]
        public void RebuiltFillAndFrostRimKeepAuthoringCoordinatesAfterRecentering()
        {
            GameObject gameObject = new GameObject("ice-authoring-uv-test");
            try
            {
                FrameActionProceduralRigidSource2D source = CreateTriangleSource(gameObject, 919u);
                FrameActionProceduralRigidGeometry2D geometry = gameObject.AddComponent<FrameActionProceduralRigidGeometry2D>();
                geometry.InitializeFromAuthoring(source);
                Assert.That(geometry.RebuildVisual(0, 0), Is.True, geometry.LastVisualError);

                Mesh mesh = gameObject.GetComponent<MeshFilter>().sharedMesh;
                List<Vector2> before = new List<Vector2>();
                mesh.GetUVs(0, before);
                List<Vector2> opticalBefore = new List<Vector2>();
                mesh.GetUVs(2, opticalBefore);
                geometry.TranslateLocal(new Vector2(-1.35f, 0.84f));
                Assert.That(geometry.RebuildVisual(0, 0), Is.True, geometry.LastVisualError);
                List<Vector2> after = new List<Vector2>();
                mesh.GetUVs(0, after);
                List<Vector2> opticalAfter = new List<Vector2>();
                mesh.GetUVs(2, opticalAfter);

                Assert.That(after.Count, Is.EqualTo(before.Count));
                for (int index = 0; index < before.Count; index++)
                    Assert.That(after[index], Is.EqualTo(before[index]), $"Authoring UV changed at mesh vertex {index}.");
                Assert.That(opticalAfter.Count, Is.EqualTo(opticalBefore.Count));
                for (int index = 0; index < opticalBefore.Count; index++)
                    Assert.That(opticalAfter[index], Is.EqualTo(opticalBefore[index]), $"Optical thickness changed at mesh vertex {index}.");
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(gameObject);
            }
        }

        [Test]
        public void FacetFillHasNoVertexCentredBrightnessFan()
        {
            GameObject gameObject = new GameObject("ice-no-radial-fan-test");
            try
            {
                FrameActionProceduralRigidSource2D source = CreateTriangleSource(gameObject, 1427u);
                FrameActionProceduralRigidGeometry2D geometry = gameObject.AddComponent<FrameActionProceduralRigidGeometry2D>();
                geometry.InitializeFromAuthoring(source);
                Assert.That(geometry.RebuildVisual(0, 0), Is.True, geometry.LastVisualError);

                Color[] meshColors = gameObject.GetComponent<MeshFilter>().sharedMesh.colors;
                Assert.That(meshColors.Length, Is.GreaterThanOrEqualTo(3));
                Assert.That(meshColors[1], Is.EqualTo(meshColors[0]));
                Assert.That(meshColors[2], Is.EqualTo(meshColors[0]));
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(gameObject);
            }
        }

        [Test]
        public void FragmentKeepsMotherAppearanceSeedAndTextureRegion()
        {
            GameObject motherObject = new GameObject("ice-mother-test");
            GameObject fragmentObject = new GameObject("ice-fragment-test");
            try
            {
                FrameActionProceduralRigidSource2D source = CreateTriangleSource(motherObject, 0x3f71u);
                FrameActionProceduralRigidGeometry2D mother = motherObject.AddComponent<FrameActionProceduralRigidGeometry2D>();
                mother.InitializeFromAuthoring(source);
                FrameActionProceduralRigidVisualFacet2D copiedFacet = mother.GetFacet(0);

                FrameActionProceduralRigidGeometry2D fragment = fragmentObject.AddComponent<FrameActionProceduralRigidGeometry2D>();
                fragment.InitializeFragment(
                    mother.AppearanceSeed,
                    mother.SourcePixelsPerUnit,
                    mother.VisualSettings,
                    mother.FractureSettings,
                    new[] { copiedFacet });
                fragment.TranslateLocal(new Vector2(3.5f, -2.25f));

                FrameActionProceduralRigidVisualFacet2D fragmentFacet = fragment.GetFacet(0);
                Assert.That(fragment.AppearanceSeed, Is.EqualTo(mother.AppearanceSeed));
                Assert.That(fragmentFacet.AuthoringUvA, Is.EqualTo(copiedFacet.AuthoringUvA));
                Assert.That(fragmentFacet.AuthoringUvB, Is.EqualTo(copiedFacet.AuthoringUvB));
                Assert.That(fragmentFacet.AuthoringUvC, Is.EqualTo(copiedFacet.AuthoringUvC));
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(fragmentObject);
                UnityEngine.Object.DestroyImmediate(motherObject);
            }
        }

        [Test]
        public void SourceImageRigidAndFragmentsShareExactSourceTextureMapping()
        {
            GameObject motherObject = new GameObject("source-image-mother-test");
            GameObject fragmentObject = new GameObject("source-image-fragment-test");
            Texture2D texture = new Texture2D(16, 12, TextureFormat.RGBA32, false);
            Sprite sprite = null;
            try
            {
                sprite = Sprite.Create(texture, new Rect(3f, 2f, 8f, 6f), new Vector2(0.25f, 0.5f), 32f);
                FrameActionProceduralRigidSource2D source = CreateTriangleSource(motherObject, 0x4a31u);
                source.sourceSprite = sprite;
                source.visual.sourceMode = "sourceImage";

                FrameActionProceduralRigidGeometry2D mother = motherObject.AddComponent<FrameActionProceduralRigidGeometry2D>();
                mother.InitializeFromAuthoring(source);
                Assert.That(mother.SourceTexture, Is.SameAs(texture));
                Assert.That(mother.SourceTextureTransform, Is.EqualTo(new Vector4(
                    1f / 16f,
                    1f / 12f,
                    (3f + 2f) / 16f,
                    (2f + 3f) / 12f)));
                Assert.That(mother.RebuildVisual(0, 0), Is.True, mother.LastVisualError);

                MaterialPropertyBlock motherBlock = new MaterialPropertyBlock();
                motherObject.GetComponent<MeshRenderer>().GetPropertyBlock(motherBlock);
                Assert.That(motherBlock.GetFloat(Shader.PropertyToID("_UseSourceTexture")), Is.EqualTo(1f));
                Assert.That(motherBlock.GetTexture(Shader.PropertyToID("_SourceTexture")), Is.SameAs(texture));

                FrameActionProceduralRigidGeometry2D fragment = fragmentObject.AddComponent<FrameActionProceduralRigidGeometry2D>();
                fragment.InitializeFragment(
                    mother.AppearanceSeed,
                    mother.SourcePixelsPerUnit,
                    mother.VisualSettings,
                    mother.FractureSettings,
                    new[] { mother.GetFacet(0) },
                    mother.SourceTexture,
                    mother.SourceTextureTransform);
                Assert.That(fragment.SourceTexture, Is.SameAs(texture));
                Assert.That(fragment.SourceTextureTransform, Is.EqualTo(mother.SourceTextureTransform));
                Assert.That(fragment.RebuildVisual(0, 0), Is.True, fragment.LastVisualError);

                MaterialPropertyBlock fragmentBlock = new MaterialPropertyBlock();
                fragmentObject.GetComponent<MeshRenderer>().GetPropertyBlock(fragmentBlock);
                Assert.That(fragmentBlock.GetFloat(Shader.PropertyToID("_UseSourceTexture")), Is.EqualTo(1f));
                Assert.That(fragmentBlock.GetTexture(Shader.PropertyToID("_SourceTexture")), Is.SameAs(texture));
            }
            finally
            {
                if (sprite != null) UnityEngine.Object.DestroyImmediate(sprite);
                UnityEngine.Object.DestroyImmediate(texture);
                UnityEngine.Object.DestroyImmediate(fragmentObject);
                UnityEngine.Object.DestroyImmediate(motherObject);
            }
        }

        [Test]
        public void PresenterHasNoSteadyStateFrameCallbacks()
        {
            Type type = typeof(FrameActionProceduralRigidGeometry2D);
            BindingFlags callbacks = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            Assert.That(type.GetMethod("Update", callbacks), Is.Null);
            Assert.That(type.GetMethod("LateUpdate", callbacks), Is.Null);
            Assert.That(type.GetMethod("FixedUpdate", callbacks), Is.Null);
            Assert.That(type.GetMethod("OnWillRenderObject", callbacks), Is.Null);
        }

        [Test]
        public void RebuildUsesPackageShaderWithoutFallbackMaterial()
        {
            Shader shader = Shader.Find(FrameActionProceduralRigidGeometry2D.ShaderName);
            Assert.That(shader, Is.Not.Null, "The SpriteCue Runtime package shader must be included in the project.");
            Assert.That(shader.isSupported, Is.True);

            GameObject gameObject = new GameObject("ice-shader-test");
            try
            {
                FrameActionProceduralRigidSource2D source = CreateTriangleSource(gameObject, 123u);
                FrameActionProceduralRigidGeometry2D geometry = gameObject.AddComponent<FrameActionProceduralRigidGeometry2D>();
                geometry.InitializeFromAuthoring(source);

                Assert.That(geometry.RebuildVisual(0, 0), Is.True, geometry.LastVisualError);
                MeshRenderer renderer = gameObject.GetComponent<MeshRenderer>();
                Assert.That(renderer.sharedMaterial, Is.Not.Null);
                Assert.That(renderer.sharedMaterial.shader.name, Is.EqualTo(FrameActionProceduralRigidGeometry2D.ShaderName));
                Assert.That(renderer.sharedMaterial.shader.name, Does.Not.Contain("Error"));
                Assert.That(renderer.sharedMaterial.shader.name, Does.Not.Contain("Default"));
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(gameObject);
            }
        }

        [Test]
        public void BodiesSharePackageMaterialWhileUsingPerRendererProperties()
        {
            GameObject firstObject = new GameObject("ice-shared-material-a");
            GameObject secondObject = new GameObject("ice-shared-material-b");
            try
            {
                FrameActionProceduralRigidGeometry2D first = firstObject.AddComponent<FrameActionProceduralRigidGeometry2D>();
                first.InitializeFromAuthoring(CreateTriangleSource(firstObject, 31u));
                FrameActionProceduralRigidGeometry2D second = secondObject.AddComponent<FrameActionProceduralRigidGeometry2D>();
                second.InitializeFromAuthoring(CreateTriangleSource(secondObject, 97u));

                Assert.That(first.RebuildVisual(0, 0), Is.True, first.LastVisualError);
                Assert.That(second.RebuildVisual(0, 0), Is.True, second.LastVisualError);
                Material firstMaterial = firstObject.GetComponent<MeshRenderer>().sharedMaterial;
                Material secondMaterial = secondObject.GetComponent<MeshRenderer>().sharedMaterial;
                Assert.That(firstMaterial, Is.SameAs(secondMaterial));

                MaterialPropertyBlock firstBlock = new MaterialPropertyBlock();
                MaterialPropertyBlock secondBlock = new MaterialPropertyBlock();
                firstObject.GetComponent<MeshRenderer>().GetPropertyBlock(firstBlock);
                secondObject.GetComponent<MeshRenderer>().GetPropertyBlock(secondBlock);
                int seedProperty = Shader.PropertyToID("_AppearanceSeed");
                Assert.That(firstBlock.GetFloat(seedProperty), Is.Not.EqualTo(secondBlock.GetFloat(seedProperty)));
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(secondObject);
                UnityEngine.Object.DestroyImmediate(firstObject);
            }
        }

        [Test]
        public void MicroDebrisIsBoundedAndNeverCreatesPhysicsBodies()
        {
            GameObject gameObject = new GameObject("ice-debris-test");
            try
            {
                FrameActionProceduralRigidDebrisPresenter2D debris = gameObject.AddComponent<FrameActionProceduralRigidDebrisPresenter2D>();
                Assert.That(FrameActionProceduralRigidDebrisPresenter2D.CalculateParticleCount(0.08f),
                    Is.LessThan(FrameActionProceduralRigidDebrisPresenter2D.CalculateParticleCount(0.55f)));
                Assert.That(FrameActionProceduralRigidDebrisPresenter2D.CalculateParticleCount(0.55f),
                    Is.LessThan(FrameActionProceduralRigidDebrisPresenter2D.CalculateParticleCount(1f)));
                for (uint eventIndex = 0; eventIndex < 24u; eventIndex++)
                {
                    debris.EmitMicroDebris(Vector2.zero, Vector2.up, 1f, eventIndex + 1u);
                }

                Assert.That(debris.ActiveParticleCount, Is.LessThanOrEqualTo(debris.Capacity));
                Assert.That(gameObject.GetComponent<Rigidbody2D>(), Is.Null);
                Assert.That(gameObject.GetComponent<Collider2D>(), Is.Null);
                Assert.That(gameObject.GetComponent<ParticleSystem>().collision.enabled, Is.False);

                Type type = typeof(FrameActionProceduralRigidDebrisPresenter2D);
                BindingFlags callbacks = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
                Assert.That(type.GetMethod("Update", callbacks), Is.Null);
                Assert.That(type.GetMethod("LateUpdate", callbacks), Is.Null);
                Assert.That(type.GetMethod("FixedUpdate", callbacks), Is.Null);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(gameObject);
            }
        }

        [Test]
        public void LegacyOutlineVertexFanIsRebuiltIntoDistributedRuntimeFacets()
        {
            GameObject gameObject = new GameObject("rigid-fan-repair-test");
            try
            {
                FrameActionProceduralRigidSource2D source = CreateTriangleSource(gameObject, 4027u);
                const int outlineCount = 20;
                source.localOutline = new Vector2[outlineCount];
                source.edgeRoles = new FrameActionProceduralRigidEdgeRole[outlineCount];
                for (int index = 0; index < outlineCount; index++)
                {
                    float radians = index / (float)outlineCount * Mathf.PI * 2f;
                    source.localOutline[index] = new Vector2(Mathf.Cos(radians) * 4f, Mathf.Sin(radians) * 2.5f);
                    source.edgeRoles[index] = FrameActionProceduralRigidEdgeRole.Exposed;
                }
                source.facets = new FrameActionProceduralRigidFacet2D[outlineCount - 2];
                for (int index = 1; index < outlineCount - 1; index++)
                {
                    source.facets[index - 1] = new FrameActionProceduralRigidFacet2D
                    {
                        id = index,
                        localPoints = new[]
                        {
                            source.localOutline[0],
                            source.localOutline[index],
                            source.localOutline[index + 1],
                        },
                        shade = index / (float)outlineCount,
                    };
                }

                FrameActionProceduralRigidGeometry2D geometry =
                    gameObject.AddComponent<FrameActionProceduralRigidGeometry2D>();
                geometry.InitializeFromAuthoring(source);

                var incidence = new Dictionary<string, int>();
                int maximum = 0;
                for (int index = 0; index < geometry.FacetCount; index++)
                {
                    FrameActionProceduralRigidVisualFacet2D facet = geometry.GetFacet(index);
                    CountVertex(incidence, facet.A, ref maximum);
                    CountVertex(incidence, facet.B, ref maximum);
                    CountVertex(incidence, facet.C, ref maximum);
                }
                int allowed = Mathf.Max(12, Mathf.CeilToInt(geometry.FacetCount * 0.15f));
                Assert.That(geometry.FacetCount, Is.GreaterThanOrEqualTo(12));
                Assert.That(maximum, Is.LessThanOrEqualTo(allowed),
                    "The runtime fallback must not retain an outline-vertex radial fan.");
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(gameObject);
            }
        }

        private static void CountVertex(Dictionary<string, int> counts, Vector2 point, ref int maximum)
        {
            string key = $"{Mathf.RoundToInt(point.x * 100000f)},{Mathf.RoundToInt(point.y * 100000f)}";
            counts.TryGetValue(key, out int count);
            count++;
            counts[key] = count;
            maximum = Mathf.Max(maximum, count);
        }

        private static FrameActionProceduralRigidSource2D CreateTriangleSource(GameObject owner, uint seed)
        {
            FrameActionProceduralRigidSource2D source = owner.AddComponent<FrameActionProceduralRigidSource2D>();
            source.seed = seed;
            source.sourcePixelsPerUnit = 32f;
            source.localOutline = new[]
            {
                new Vector2(-2f, -1f),
                new Vector2(2.5f, -0.75f),
                new Vector2(0.25f, 2f),
            };
            source.edgeRoles = new[]
            {
                FrameActionProceduralRigidEdgeRole.Exposed,
                FrameActionProceduralRigidEdgeRole.Exposed,
                FrameActionProceduralRigidEdgeRole.Exposed,
            };
            source.facets = new[]
            {
                new FrameActionProceduralRigidFacet2D
                {
                    id = 7,
                    localPoints = (Vector2[])source.localOutline.Clone(),
                    shade = 0.57f,
                },
            };
            source.visual = new FrameActionProceduralRigidVisualSettings2D
            {
                templateId = "iceCrystal",
                baseColor = new Color(0.035f, 0.34f, 0.62f, 1f),
                shadowColor = new Color(0.014f, 0.082f, 0.20f, 1f),
                highlightColor = new Color(0.48f, 0.89f, 1f, 1f),
                edgeColor = new Color(0.80f, 0.98f, 1f, 1f),
                opacity = 1f,
                facetVariation = 0.55f,
                textureStrength = 0.72f,
                edgeBrightness = 0.88f,
                volumeDepth = 0.78f,
                transmission = 0.72f,
                absorption = 0.52f,
                edgeWidthPixels = 1.35f,
                specularStrength = 0.82f,
                inclusionDensity = 0.34f,
                microCrackDensity = 0.22f,
                roughness = 0.16f,
                grainDirectionDegrees = -18f,
                anisotropy = 0.34f,
                lightAngleDegrees = 132f,
            };
            source.templateId = "iceCrystal";
            return source;
        }
    }
}
