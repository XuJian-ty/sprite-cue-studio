using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace FrameAction.Editor
{
    internal static class FrameActionMapPrefabSynchronizer
    {
        // Ground lines are often drawn as a thin strip in the map editor. A solid strip that is
        // thinner than a nearby step can leave an actual hole below the raised strip at their seam.
        // Keep the authored walking surface intact, but give solid terrain enough depth to overlap.
        private const float MinimumSolidGroundDepth = 1f;
        private const float BoundaryWallThickness = 1f;
        private const float BoundaryVerticalPadding = 4f;
        private const float DeathBoundaryHeight = 6f;
        private const float DeathBoundaryTopGap = 0.35f;
        private const int BackgroundSortingOrder = -10000;
        private const int DecorationSortingOrder = -5000;
        private const int CollisionSortingOrder = -3000;
        private const int RigidSortingOrder = -1000;
        private const int OcclusionSortingOrder = 2000;
        // Keep antialiased beauty pixels out of automatic rigid-body collision. The value follows
        // ArcaneMatter's production rule; manual SpriteCue rigid outlines remain exact authoring.
        private const byte RigidPhysicalAlphaThreshold = 224;
        private const int AuthoredRigidColliderVertexLimit = 24;
        private const float AutomaticOutlineTolerancePixels = 0.5f;
        private const int AutomaticOutlineVertexLimit = 256;

        private static readonly string[] ManagedLayerNames = { "BackgroundLayer", "DecorationLayer", "CollisionLayer", "MovingPlatformLayer", "RigidBodyLayer", "ElementMatterLayer", "OcclusionLayer", "BoundaryLayer", "DeathBoundaryLayer" };

        public static string Synchronize(FrameActionMapProjectData data, TextAsset source, Dictionary<string, Sprite> sprites, string slug)
        {
            string prefabPath = ResolvePrefabPath(data.unityPrefabPath, slug, data.mapName);
            EnsureAssetFolder(Path.GetDirectoryName(prefabPath)?.Replace("\\", "/"));
            GameObject prefabAsset = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            bool updatingExisting = prefabAsset != null;
            GameObject root = updatingExisting
                ? PrefabUtility.LoadPrefabContents(prefabPath)
                : new GameObject(string.IsNullOrWhiteSpace(data.mapName) ? "Frame Action Map" : data.mapName);
            try
            {
                ConfigureMap(root, data, source, sprites);
                PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
                return prefabPath;
            }
            finally
            {
                if (updatingExisting) PrefabUtility.UnloadPrefabContents(root);
                else UnityEngine.Object.DestroyImmediate(root);
            }
        }

        private static void ConfigureMap(GameObject root, FrameActionMapProjectData data, TextAsset source, Dictionary<string, Sprite> sprites)
        {
            root.name = string.IsNullOrWhiteSpace(data.mapName) ? "Frame Action Map" : data.mapName;
            for (int i = 0; i < ManagedLayerNames.Length; i++)
            {
                Transform child = root.transform.Find(ManagedLayerNames[i]);
                if (child != null) UnityEngine.Object.DestroyImmediate(child.gameObject);
            }

            FrameActionMapMetadata metadata = GetOrAdd<FrameActionMapMetadata>(root);
            metadata.sourceJson = source;
            metadata.mapName = data.mapName;
            metadata.mapType = string.IsNullOrEmpty(data.mapType) ? "side2d" : data.mapType;
            metadata.width = Mathf.Max(1, data.width);
            metadata.height = Mathf.Max(1, data.height);
            metadata.pixelsPerUnit = Mathf.Max(1f, data.pixelsPerUnit);
            FrameActionMapBounds2D mapBounds = GetOrAdd<FrameActionMapBounds2D>(root);
            mapBounds.localMinX = 0f;
            mapBounds.localMaxX = metadata.width / metadata.pixelsPerUnit;
            mapBounds.innerPadding = 0.02f;
            mapBounds.playersOnly = false;
            mapBounds.playerTag = "Player";

            GameObject backgroundLayer = CreateLayer(root.transform, "BackgroundLayer", "Background");
            GameObject decorationLayer = CreateLayer(root.transform, "DecorationLayer", "Decoration");
            GameObject collisionLayer = CreateLayer(root.transform, "CollisionLayer", "Ground");
            ConfigureSolidGroundComposite(collisionLayer);
            GameObject movingPlatformLayer = CreateLayer(root.transform, "MovingPlatformLayer", "Ground");
            GameObject rigidBodyLayer = CreateLayer(root.transform, "RigidBodyLayer", "Ground");
            CreateProceduralRigidEffectsLayer(rigidBodyLayer);
            GameObject elementMatterLayer = CreateLayer(root.transform, "ElementMatterLayer", "Default");
            GameObject occlusionLayer = CreateLayer(root.transform, "OcclusionLayer", "Occlusion");
            GameObject boundaryLayer = CreateLayer(root.transform, "BoundaryLayer", "Ground");
            GameObject deathBoundaryLayer = CreateLayer(root.transform, "DeathBoundaryLayer", "Default");
            float ppu = metadata.pixelsPerUnit;
            ConfigureAutomaticBoundaries(boundaryLayer, deathBoundaryLayer, metadata.width / ppu, metadata.height / ppu);

            if (data.backgroundTiles != null && data.backgroundTiles.Count > 0)
            {
                for (int index = 0; index < data.backgroundTiles.Count; index++)
                {
                    FrameActionMapBackgroundTileData tile = data.backgroundTiles[index];
                    if (tile == null || string.IsNullOrEmpty(tile.assetId) || !sprites.TryGetValue(tile.assetId, out Sprite tileSprite)) continue;
                    GameObject tileObject = new GameObject($"Background_{index + 1}");
                    tileObject.transform.SetParent(backgroundLayer.transform, false);
                    tileObject.layer = backgroundLayer.layer;
                    SpriteRenderer renderer = tileObject.AddComponent<SpriteRenderer>();
                    renderer.sprite = tileSprite;
                    renderer.sortingOrder = BackgroundSortingOrder;
                    tileObject.transform.localPosition = PixelCenterToWorld(tile.x + tile.width * 0.5f, tile.y + tile.height * 0.5f, data.height, ppu, 0f);
                }
            }
            else if (!string.IsNullOrEmpty(data.backgroundAssetId) && sprites.TryGetValue(data.backgroundAssetId, out Sprite background))
            {
                GameObject backgroundObject = new GameObject("Background");
                backgroundObject.transform.SetParent(backgroundLayer.transform, false);
                backgroundObject.layer = backgroundLayer.layer;
                SpriteRenderer renderer = backgroundObject.AddComponent<SpriteRenderer>();
                renderer.sprite = background;
                renderer.sortingOrder = BackgroundSortingOrder;
                backgroundObject.transform.localPosition = PixelCenterToWorld(data.width * 0.5f, data.height * 0.5f, data.height, ppu, 0f);
            }

            Dictionary<string, FrameActionMapAssetEntry> entries = data.assets?
                .Where(entry => entry != null && !string.IsNullOrEmpty(entry.id))
                .GroupBy(entry => entry.id)
                .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal)
                ?? new Dictionary<string, FrameActionMapAssetEntry>(StringComparer.Ordinal);

            if (data.objects != null)
            {
                for (int index = 0; index < data.objects.Count; index++)
                {
                    FrameActionMapObjectData item = data.objects[index];
                    if (item == null || !entries.TryGetValue(item.assetId ?? string.Empty, out FrameActionMapAssetEntry entry) || !sprites.TryGetValue(item.assetId, out Sprite sprite)) continue;
                    bool rigid = string.Equals(item.layer, "rigid", StringComparison.OrdinalIgnoreCase);
                    bool dynamic = !rigid && string.Equals(item.mode, "dynamic", StringComparison.OrdinalIgnoreCase);
                    GameObject parent = rigid ? rigidBodyLayer : dynamic ? movingPlatformLayer : item.layer == "collision" ? collisionLayer : item.layer == "occlusion" ? occlusionLayer : decorationLayer;
                    GameObject instance = new GameObject(string.IsNullOrEmpty(entry.name) ? item.id : entry.name);
                    instance.transform.SetParent(parent.transform, false);
                    instance.layer = parent.layer;
                    GameObject visualObject = instance;
                    if (rigid)
                    {
                        visualObject = new GameObject("AuthoredRigidSpriteSource");
                        visualObject.layer = instance.layer;
                        visualObject.transform.SetParent(instance.transform, false);
                    }
                    SpriteRenderer renderer = visualObject.AddComponent<SpriteRenderer>();
                    renderer.sprite = sprite;
                    renderer.sortingOrder = ResolveMapObjectSortingOrder(item.layer, index);
                    float scale = Mathf.Max(0.01f, item.scale);
                    float width = Mathf.Max(1, entry.width) * scale;
                    float height = Mathf.Max(1, entry.height) * scale;
                    instance.transform.localPosition = PixelCenterToWorld(item.x + width * 0.5f, item.y + height * 0.5f, data.height, ppu, item.z);
                    instance.transform.localRotation = Quaternion.Euler(0f, 0f, -item.rotation);
                    instance.transform.localScale = Vector3.one * scale;
                    if (dynamic) ConfigureMovingObject(instance, item);

                    if (rigid)
                    {
                        FrameActionMapOutlineData proceduralOutline = FindAssetProceduralRigidOutline(entry);
                        bool automaticRigidContour = !HasAssetOutlineLayer(entry, "rigid");
                        CreateRigidObjectCollider(instance, sprite, entry, ppu);
                        PolygonCollider2D rigidCollider = instance.GetComponent<PolygonCollider2D>();
                        Vector2[] sourcePoints = rigidCollider == null || rigidCollider.pathCount == 0
                            ? null
                            : rigidCollider.GetPath(0);
                        FrameActionMapProceduralRigidBodyData authored = proceduralOutline != null
                            ? ResolveProceduralRigidBody(proceduralOutline)
                            : CreateAutomaticAssetProceduralRigidBody(item);
                        renderer.enabled = false; // Immutable source image sampled by the generated program-rigid mesh.
                        ConfigureRigidMatterSource(instance, item.id, authored.elementTag, sourcePoints, automaticRigidContour);
                        float assetWidth = Mathf.Max(1f, entry.width);
                        float assetHeight = Mathf.Max(1f, entry.height);
                        float pixelsPerUnit = Mathf.Max(1f, ppu);
                        ConfigureProceduralRigidSource(
                            instance,
                            authored,
                            proceduralOutline != null ? $"{item.id}:{proceduralOutline.id}" : $"{item.id}:automatic-program-rigid",
                            sourcePoints,
                            ppu,
                            sprite,
                            point => new Vector2(
                                (point.x - assetWidth * 0.5f) / pixelsPerUnit,
                                (assetHeight * 0.5f - point.y) / pixelsPerUnit));
                        EnsureProceduralRigidRuntime(instance, renderer.sortingOrder);
                    }
                    else if (item.layer == "collision")
                    {
                        CreateObjectCollider(instance, sprite, item.collisionType);
                    }
                    else if (item.layer == "occlusion" && !HasAssetOutlineLayer(entry, "occlusion"))
                    {
                        PolygonCollider2D trigger = CreateAutoOutlineCollider(instance, sprite, true);
                        FrameActionMapOccluder2D occluder = instance.AddComponent<FrameActionMapOccluder2D>();
                        occluder.targetRenderer = renderer;
                        occluder.trigger = trigger;
                    }
                    if (!rigid) CreateAssetOutlineColliders(instance, renderer, entry, ppu, collisionLayer.layer, occlusionLayer.layer);
                }
            }

            if (data.outlines != null)
            {
                for (int index = 0; index < data.outlines.Count; index++)
                {
                    FrameActionMapOutlineData outline = data.outlines[index];
                    bool rectangleCollision = outline != null && outline.shape == "groundLine";
                    bool legacyLineRoad = outline != null && (outline.shape == "lineRoad" || outline.shape == "oneWayLine");
                    int minimumPointCount = legacyLineRoad ? 2 : 3;
                    if (outline?.points == null || outline.points.Count < minimumPointCount) continue;
                    bool rigid = string.Equals(outline.layer, "rigid", StringComparison.OrdinalIgnoreCase);
                    bool proceduralRigid = rigid && (outline.rigidBody != null || outline.iceBody != null);
                    GameObject parent = rigid ? rigidBodyLayer : outline.layer == "occlusion" ? occlusionLayer : collisionLayer;
                    GameObject instance = new GameObject(proceduralRigid ? $"program_rigid_outline_{index + 1}" : rectangleCollision ? $"rectangle_collision_{index + 1}" : legacyLineRoad ? $"line_road_{index + 1}" : $"{outline.layer}_outline_{index + 1}");
                    instance.transform.SetParent(parent.transform, false);
                    instance.layer = parent.layer;
                    Vector2[] points = new Vector2[outline.points.Count];
                    for (int pointIndex = 0; pointIndex < outline.points.Count; pointIndex++)
                    {
                        FrameActionMapPoint point = outline.points[pointIndex];
                        points[pointIndex] = new Vector2(point.x / ppu, (data.height - point.y) / ppu);
                    }

                    if (rigid)
                    {
                        Vector2[] colliderPoints = points;
                        Vector2 pivot = Vector2.zero;
                        if (proceduralRigid)
                        {
                            pivot = ComputePolygonCentroid(points);
                            instance.transform.localPosition = new Vector3(pivot.x, pivot.y, 0f);
                            colliderPoints = MakeLocalPoints(points, pivot);
                        }
                        PolygonCollider2D rigidCollider = instance.AddComponent<PolygonCollider2D>();
                        rigidCollider.pathCount = 1;
                        rigidCollider.SetPath(0, colliderPoints);
                        FrameActionMapProceduralRigidBodyData authored = proceduralRigid ? ResolveProceduralRigidBody(outline) : null;
                        ConfigureRigidMatterSource(instance, outline.id, proceduralRigid ? authored.elementTag : outline.element, colliderPoints, false);
                        if (proceduralRigid)
                        {
                            ConfigureProceduralRigidSource(
                                instance,
                                authored,
                                outline.id,
                                colliderPoints,
                                ppu,
                                null,
                                point => ConvertMapPointToLocal(point, pivot, data.height, ppu));
                            EnsureProceduralRigidRuntime(instance, RigidSortingOrder + Mathf.Clamp(index, 0, 899));
                        }
                        continue;
                    }

                    if (legacyLineRoad)
                    {
                        EdgeCollider2D edge = instance.AddComponent<EdgeCollider2D>();
                        edge.points = points;
                        ConfigureOpenEdgeAdjacency(edge);
                        if (outline.collisionType == "oneWay")
                        {
                            edge.usedByEffector = true;
                            CreateOneWayEdgeEffector(instance, points[0], points[points.Length - 1]);
                        }
                        continue;
                    }

                    if (rectangleCollision && points.Length >= 4)
                    {
                        bool oneWay = outline.collisionType == "oneWay";
                        bool sideCollision = outline.sideCollision;
                        if (!oneWay) EnsureMinimumSolidGroundDepth(points);
                        if (!oneWay && sideCollision)
                        {
                            PolygonCollider2D rectangle = instance.AddComponent<PolygonCollider2D>();
                            rectangle.pathCount = 1;
                            rectangle.SetPath(0, points);
                            // Merge every closed solid ground strip into the CollisionLayer composite.
                            // This removes internal fixture edges and T-junctions that can remain even
                            // when two individually thick colliders overlap visually.
                            rectangle.compositeOperation = Collider2D.CompositeOperation.Merge;
                            continue;
                        }

                        EdgeCollider2D top = CreateEdgeCollider(instance, points[0], points[1]);
                        if (!sideCollision) ConfigureOpenEdgeAdjacency(top);
                        if (oneWay)
                        {
                            top.usedByEffector = true;
                            CreateOneWayEdgeEffector(instance, points[0], points[1]);
                        }
                        else
                        {
                            EdgeCollider2D bottom = CreateEdgeCollider(instance, points[3], points[2]);
                            if (!sideCollision) ConfigureOpenEdgeAdjacency(bottom);
                        }
                        if (sideCollision)
                        {
                            CreateEdgeCollider(instance, points[0], points[3]);
                            CreateEdgeCollider(instance, points[1], points[2]);
                        }
                        continue;
                    }

                    PolygonCollider2D collider = instance.AddComponent<PolygonCollider2D>();
                    collider.isTrigger = outline.layer == "occlusion";
                    collider.pathCount = 1;
                    collider.SetPath(0, points);
                    if (outline.layer == "collision" && outline.collisionType == "oneWay")
                    {
                        collider.usedByEffector = true;
                        PlatformEffector2D effector = instance.AddComponent<PlatformEffector2D>();
                        effector.useOneWay = true;
                        effector.useOneWayGrouping = true;
                        effector.surfaceArc = 160f;
                    }
                }
            }

            if (data.matterStrokes != null)
            {
                for (int index = 0; index < data.matterStrokes.Count; index++)
                {
                    FrameActionMapMatterStrokeData stroke = data.matterStrokes[index];
                    if (stroke?.points == null || stroke.points.Count == 0) continue;
                    GameObject instance = new GameObject($"{stroke.carrier}_stroke_{index + 1}");
                    instance.transform.SetParent(elementMatterLayer.transform, false);
                    FrameActionElementMatterSource2D sourceData = instance.AddComponent<FrameActionElementMatterSource2D>();
                    sourceData.sourceId = stroke.id;
                    sourceData.carrier = string.Equals(stroke.carrier, "gas", StringComparison.OrdinalIgnoreCase)
                        ? FrameActionMatterCarrier.Gas
                        : FrameActionMatterCarrier.Liquid;
                    string legacyTag = string.IsNullOrWhiteSpace(stroke.element) ? "water" : stroke.element;
                    sourceData.elementTag = string.IsNullOrWhiteSpace(stroke.elementTag)
                        ? legacyTag
                        : stroke.elementTag.Trim();
#pragma warning disable CS0618
                    sourceData.element = sourceData.elementTag;
#pragma warning restore CS0618
                    FrameActionMapMatterAuthoringProfileData authoredProfile = stroke.profile ?? new FrameActionMapMatterAuthoringProfileData();
                    FrameActionMapMatterVisualProfileData visual = authoredProfile.visual ?? new FrameActionMapMatterVisualProfileData();
                    FrameActionMapMatterPhysicalProfileData physical = authoredProfile.physical ?? new FrameActionMapMatterPhysicalProfileData();
                    sourceData.visual = new FrameActionMatterVisualProfile2D
                    {
                        baseColor = ParseHtmlColor(visual.baseColor, new Color(0.267f, 0.682f, 0.91f)),
                        secondaryColor = ParseHtmlColor(visual.secondaryColor, new Color(0.267f, 0.682f, 0.91f)),
                        emissionColor = ParseHtmlColor(visual.emissionColor, Color.black),
                        opacity = Mathf.Clamp01(visual.opacity),
                        particleScale = Mathf.Clamp(visual.particleScale, 0.1f, 4f),
                        edgeSoftness = Mathf.Clamp01(visual.edgeSoftness),
                        detailScale = Mathf.Clamp(visual.detailScale, 0.1f, 8f),
                        refractionStrength = Mathf.Clamp01(visual.refractionStrength),
                        glowStrength = Mathf.Clamp(visual.glowStrength, 0f, 8f),
                        foamAmount = Mathf.Clamp01(visual.foamAmount),
                    };
                    sourceData.physical = new FrameActionMatterPhysicalProfile2D
                    {
                        density = Mathf.Clamp(physical.density, 0.001f, 100f),
                        viscosity = Mathf.Clamp(physical.viscosity, 0f, 8f),
                        surfaceTension = Mathf.Clamp(physical.surfaceTension, 0f, 4f),
                        flowSpeed = Mathf.Clamp(physical.flowSpeed, 0.05f, 8f),
                        gravityScale = Mathf.Clamp(physical.gravityScale, -4f, 4f),
                        diffusion = Mathf.Clamp(physical.diffusion, 0f, 4f),
                        buoyancy = Mathf.Clamp(physical.buoyancy, -4f, 4f),
                        drag = Mathf.Clamp(physical.drag, 0f, 8f),
                        evaporationHalfLifeSeconds = Mathf.Clamp(physical.evaporationHalfLifeSeconds, 0f, 86400f),
                        dissipationHalfLifeSeconds = Mathf.Clamp(physical.dissipationHalfLifeSeconds, 0f, 86400f),
                    };
                    sourceData.radiusWorldUnits = Mathf.Max(0.5f, stroke.radius) / ppu;
                    sourceData.localPoints = new Vector2[stroke.points.Count];
                    for (int pointIndex = 0; pointIndex < stroke.points.Count; pointIndex++)
                    {
                        FrameActionMapPoint point = stroke.points[pointIndex];
                        sourceData.localPoints[pointIndex] = new Vector2(point.x / ppu, (data.height - point.y) / ppu);
                    }
                }
            }
        }

        private static void ConfigureRigidMatterSource(GameObject instance, string sourceId, string element, Vector2[] localPoints = null, bool autoGeneratedRigidContour = false)
        {
            Rigidbody2D body = instance.AddComponent<Rigidbody2D>();
            body.bodyType = RigidbodyType2D.Dynamic;
            body.gravityScale = 1f;
            body.interpolation = RigidbodyInterpolation2D.Interpolate;
            body.collisionDetectionMode = CollisionDetectionMode2D.Continuous;
            body.sleepMode = RigidbodySleepMode2D.StartAwake;

            FrameActionElementMatterSource2D source = instance.AddComponent<FrameActionElementMatterSource2D>();
            source.sourceId = sourceId;
            source.carrier = FrameActionMatterCarrier.Rigid;
            source.element = element?.Trim() ?? string.Empty;
            source.localPoints = localPoints ?? Array.Empty<Vector2>();
            source.autoGeneratedRigidContour = autoGeneratedRigidContour;
        }

        private static void ConfigureProceduralRigidSource(
            GameObject instance,
            FrameActionMapProceduralRigidBodyData authored,
            string sourceId,
            Vector2[] localOutline,
            float ppu,
            Sprite sourceSprite,
            Func<FrameActionMapPoint, Vector2> convertPoint)
        {
            if (authored == null || convertPoint == null) return;

            FrameActionProceduralRigidSource2D source = instance.AddComponent<FrameActionProceduralRigidSource2D>();
            source.sourceId = sourceId;
            source.schemaVersion = Mathf.Max(1, authored.schemaVersion);
            source.templateId = string.IsNullOrWhiteSpace(authored.templateId) ? "custom" : authored.templateId.Trim();
            source.materialId = source.templateId; // Compatibility only. Gameplay uses free-form elementTag.
            source.elementTag = authored.elementTag?.Trim() ?? string.Empty;
            source.algorithmId = string.IsNullOrWhiteSpace(authored.algorithm) ? "procedural-rigid-v1" : authored.algorithm;
            source.seed = authored.seed == 0 ? 1u : authored.seed;
            source.closureMode = string.IsNullOrWhiteSpace(authored.closureMode) ? "manual" : authored.closureMode;
            source.sourcePixelsPerUnit = Mathf.Max(1f, ppu);
            source.sourceSprite = sourceSprite;
            source.localOutline = localOutline != null ? (Vector2[])localOutline.Clone() : Array.Empty<Vector2>();

            int edgeCount = source.localOutline.Length;
            source.edgeRoles = new FrameActionProceduralRigidEdgeRole[edgeCount];
            for (int edgeIndex = 0; edgeIndex < edgeCount; edgeIndex++)
            {
                string role = authored.edgeRoles != null && edgeIndex < authored.edgeRoles.Count
                    ? authored.edgeRoles[edgeIndex]
                    : null;
                source.edgeRoles[edgeIndex] = ParseProceduralRigidEdgeRole(role);
            }

            List<FrameActionProceduralRigidFacet2D> facets = new List<FrameActionProceduralRigidFacet2D>();
            if (authored.facets != null)
            {
                for (int facetIndex = 0; facetIndex < authored.facets.Count; facetIndex++)
                {
                    FrameActionMapProceduralRigidFacetData facet = authored.facets[facetIndex];
                    if (facet?.points == null || facet.points.Count < 3) continue;
                    Vector2[] localPoints = ConvertPoints(facet.points, convertPoint);
                    if (localPoints.Length < 3) continue;
                    facets.Add(new FrameActionProceduralRigidFacet2D
                    {
                        id = facet.id,
                        localPoints = localPoints,
                        shade = Mathf.Clamp01(facet.shade),
                    });
                }
            }
            source.facets = facets.ToArray();

            FrameActionMapProceduralRigidVisualData visual = authored.visual ?? new FrameActionMapProceduralRigidVisualData();
            source.visual = new FrameActionProceduralRigidVisualSettings2D
            {
                sourceMode = string.Equals(visual.sourceMode, "sourceImage", StringComparison.OrdinalIgnoreCase)
                    && sourceSprite != null
                    ? "sourceImage"
                    : "procedural",
                templateId = string.IsNullOrWhiteSpace(visual.templateId) ? source.templateId : visual.templateId.Trim(),
                baseColor = ParseHtmlColor(visual.baseColor, new Color(0.42f, 0.46f, 0.52f, 1f)),
                shadowColor = ParseHtmlColor(visual.shadowColor, new Color(0.08f, 0.09f, 0.12f, 1f)),
                highlightColor = ParseHtmlColor(visual.highlightColor, new Color(0.82f, 0.86f, 0.92f, 1f)),
                edgeColor = ParseHtmlColor(visual.edgeColor, new Color(0.70f, 0.74f, 0.82f, 1f)),
                fractureColor = ParseHtmlColor(visual.fractureColor, Color.Lerp(
                    ParseHtmlColor(visual.baseColor, new Color(0.42f, 0.46f, 0.52f, 1f)),
                    ParseHtmlColor(visual.highlightColor, new Color(0.82f, 0.86f, 0.92f, 1f)),
                    0.72f)),
                opacity = Mathf.Clamp01(visual.opacity),
                edgeJaggedness = Mathf.Clamp01(visual.edgeJaggedness),
                facetScale = Mathf.Max(0f, visual.facetScale),
                facetVariation = Mathf.Clamp01(visual.facetVariation),
                textureStrength = Mathf.Clamp01(visual.textureStrength),
                edgeBrightness = Mathf.Clamp01(visual.edgeBrightness),
                edgeWidthPixels = Mathf.Max(0f, visual.edgeWidthPixels),
                volumeDepth = Mathf.Clamp01(visual.volumeDepth),
                transmission = Mathf.Clamp01(visual.transmission),
                absorption = Mathf.Clamp01(visual.absorption),
                roughness = Mathf.Clamp01(visual.roughness),
                specularStrength = Mathf.Clamp01(visual.specularStrength),
                inclusionDensity = Mathf.Clamp01(visual.inclusionDensity),
                microCrackDensity = Mathf.Clamp01(visual.microCrackDensity),
                grainDirectionDegrees = Mathf.Clamp(visual.grainDirectionDegrees, -180f, 180f),
                anisotropy = Mathf.Clamp01(visual.anisotropy),
                lightAngleDegrees = Mathf.Clamp(visual.lightAngleDegrees, -180f, 180f),
            };

            FrameActionMapProceduralRigidPhysicalData physical = authored.physical ?? new FrameActionMapProceduralRigidPhysicalData();
            bool fixedMother = string.Equals(physical.anchoringMode, "fixed", StringComparison.OrdinalIgnoreCase);
            bool terrainAttached = string.Equals(physical.anchoringMode, "terrainAttached", StringComparison.OrdinalIgnoreCase);
            source.physical = new FrameActionProceduralRigidPhysicalProfile2D
            {
                density = Mathf.Max(0.001f, physical.density),
                gravityScale = Mathf.Clamp(physical.gravityScale, -8f, 8f),
                friction = Mathf.Clamp01(physical.friction),
                restitution = Mathf.Clamp01(physical.restitution),
                linearDamping = Mathf.Max(0f, physical.linearDamping),
                angularDamping = Mathf.Max(0f, physical.angularDamping),
                hardness = Mathf.Clamp01(physical.hardness),
                toughness = Mathf.Clamp01(physical.toughness),
                brittleness = Mathf.Clamp01(physical.brittleness),
                anisotropy = Mathf.Clamp01(physical.anisotropy),
                grainAngleDegrees = Mathf.Clamp(physical.grainAngleDegrees, -180f, 180f),
                debrisFraction = Mathf.Clamp01(physical.debrisFraction),
                initialMotion = fixedMother
                    ? FrameActionProceduralRigidInitialMotion2D.Fixed
                    : FrameActionProceduralRigidInitialMotion2D.Dynamic,
                anchoringMode = terrainAttached
                    ? FrameActionProceduralRigidAnchoringMode2D.TerrainAttached
                    : FrameActionProceduralRigidAnchoringMode2D.None,
            };

            FrameActionMapProceduralRigidFractureData fracture = authored.fracture ?? new FrameActionMapProceduralRigidFractureData();
            int primaryMinimum = Mathf.Max(0, fracture.primaryFragmentMin);
            int branchMinimum = Mathf.Max(0, fracture.crackBranchMin);
            source.fracture = new FrameActionProceduralRigidFractureSettings2D
            {
                primaryFragmentMin = primaryMinimum,
                primaryFragmentMax = Mathf.Max(primaryMinimum, fracture.primaryFragmentMax),
                minimumFragmentAreaPixelsSquared = Mathf.Max(0f, fracture.minimumFragmentArea),
                minimumFragmentWidthPixels = Mathf.Max(0f, fracture.minimumFragmentWidth),
                crackBranchMin = branchMinimum,
                crackBranchMax = Mathf.Max(branchMinimum, fracture.crackBranchMax),
                releaseDelayTicks = Mathf.Max(0, fracture.releaseDelayTicks),
                impactChipEnergy = Mathf.Max(0f, fracture.impactChipEnergy),
                impactCrackEnergy = Mathf.Max(fracture.impactChipEnergy, fracture.impactCrackEnergy),
                impactBreakEnergy = Mathf.Max(fracture.impactCrackEnergy, fracture.impactBreakEnergy),
                collisionBreakThreshold = Mathf.Max(0f, fracture.collisionBreakThreshold),
                landingChipEnergy = Mathf.Max(0f, fracture.landingChipEnergy),
                landingCrackEnergy = Mathf.Max(fracture.landingChipEnergy, fracture.landingCrackEnergy),
                landingBreakEnergy = Mathf.Max(fracture.landingCrackEnergy, fracture.landingBreakEnergy),
                contactStressSensitivity = Mathf.Clamp(fracture.contactStressSensitivity, 0f, 4f),
                landingCooldownTicks = Mathf.Clamp(fracture.landingCooldownTicks, 0, 120),
                maxFragmentsPerImpact = Mathf.Clamp(fracture.maxFragmentsPerImpact, 2, 8),
                maxActiveFragmentsPerFamily = Mathf.Clamp(fracture.maxActiveFragmentsPerFamily, 4, 256),
            };

            FrameActionMapProceduralRigidTerrainBindingData binding = authored.terrainBinding;
            if (binding?.start != null && binding.end != null)
            {
                source.terrainBinding = new FrameActionProceduralRigidTerrainBinding2D
                {
                    sourceId = binding.sourceId,
                    sourceKind = binding.sourceKind,
                    route = binding.route,
                    localStart = convertPoint(binding.start),
                    localEnd = convertPoint(binding.end),
                };
            }
        }

        private static void EnsureProceduralRigidRuntime(GameObject instance, int sortingOrder)
        {
            FrameActionProceduralRigidGeometry2D geometry = instance.GetComponent<FrameActionProceduralRigidGeometry2D>();
            if (geometry == null) geometry = instance.AddComponent<FrameActionProceduralRigidGeometry2D>();
            MeshRenderer renderer = instance.GetComponent<MeshRenderer>();
            if (renderer != null) renderer.sortingOrder = sortingOrder;
            if (instance.GetComponent<FrameActionProceduralRigidBody2D>() == null)
                instance.AddComponent<FrameActionProceduralRigidBody2D>();
        }

        private static void CreateProceduralRigidEffectsLayer(GameObject rigidBodyLayer)
        {
            GameObject effects = new GameObject("ProgramRigidEffects");
            effects.layer = rigidBodyLayer.layer;
            effects.transform.SetParent(rigidBodyLayer.transform, false);
            FrameActionProceduralRigidDebrisPresenter2D presenter =
                effects.AddComponent<FrameActionProceduralRigidDebrisPresenter2D>();
            presenter.ConfigureAsGlobal(0, RigidSortingOrder + 900);
        }

        /// <summary>
        /// A rigid-layer object is always a program rigid body. Older maps may predate authored
        /// per-asset contours; they still receive the tool's generic source-image profile instead
        /// of silently falling back to the retired Rigidbody2D-only path. Re-authoring the asset in
        /// SpriteCue replaces these defaults with the exact visual, physical and fracture values.
        /// </summary>
        private static FrameActionMapProceduralRigidBodyData CreateAutomaticAssetProceduralRigidBody(
            FrameActionMapObjectData item)
        {
            string elementTag = string.IsNullOrWhiteSpace(item.elementTag) ? item.element : item.elementTag;
            var result = new FrameActionMapProceduralRigidBodyData
            {
                schemaVersion = 1,
                algorithm = "procedural-rigid-v1",
                templateId = "custom",
                elementTag = elementTag?.Trim() ?? string.Empty,
                seed = StableAuthoringSeed(item.id),
                closureMode = "manual",
            };
            result.visual.sourceMode = "sourceImage";
            result.visual.templateId = "custom";
            result.physical.anchoringMode = "dynamic";
            return result;
        }

        private static uint StableAuthoringSeed(string value)
        {
            unchecked
            {
                uint hash = 2166136261u;
                if (!string.IsNullOrEmpty(value))
                {
                    for (int index = 0; index < value.Length; index++)
                    {
                        hash ^= value[index];
                        hash *= 16777619u;
                    }
                }
                return hash == 0u ? 1u : hash;
            }
        }

        private static FrameActionMapOutlineData FindAssetProceduralRigidOutline(FrameActionMapAssetEntry entry)
        {
            List<FrameActionMapOutlineData> rigidOutlines = entry?.outlines?
                .Where(outline => outline?.points != null
                    && string.Equals(outline.layer, "rigid", StringComparison.OrdinalIgnoreCase)
                    && outline.points.Count >= 3)
                .ToList();
            if (rigidOutlines == null || rigidOutlines.Count == 0) return null;
            List<FrameActionMapOutlineData> procedural = rigidOutlines
                .Where(outline => outline.rigidBody != null || outline.iceBody != null)
                .ToList();
            if (procedural.Count == 0) return null;
            if (procedural.Count != 1 || rigidOutlines.Count != 1)
                throw new InvalidOperationException($"SpriteCue asset '{entry.id}' has multiple rigid outlines. A procedural rigid asset requires exactly one closed rigid outline.");
            FrameActionMapOutlineData result = procedural[0];
            FrameActionMapProceduralRigidBodyData authored = ResolveProceduralRigidBody(result);
            if (!result.closed || !string.Equals(authored.closureMode, "manual", StringComparison.OrdinalIgnoreCase) || authored.terrainBinding != null)
                throw new InvalidOperationException($"SpriteCue asset '{entry.id}' must use one manually closed procedural rigid outline; terrain closure belongs to map-local authoring.");
            return result;
        }

        private static FrameActionMapProceduralRigidBodyData ResolveProceduralRigidBody(FrameActionMapOutlineData outline)
        {
            if (outline?.rigidBody != null) return outline.rigidBody;
            FrameActionMapIceBodyData legacy = outline?.iceBody;
            if (legacy == null) return null;

            FrameActionMapProceduralRigidBodyData upgraded = new FrameActionMapProceduralRigidBodyData
            {
                schemaVersion = Mathf.Max(1, legacy.schemaVersion),
                algorithm = "procedural-rigid-v1",
                templateId = "iceCrystal",
                elementTag = string.IsNullOrWhiteSpace(outline.element) ? "ice" : outline.element,
                seed = legacy.seed == 0 ? 1u : legacy.seed,
                closureMode = string.IsNullOrWhiteSpace(legacy.closureMode) ? "manual" : legacy.closureMode,
                edgeRoles = legacy.edgeRoles != null ? new List<string>(legacy.edgeRoles) : new List<string>(),
                visual = new FrameActionMapProceduralRigidVisualData
                {
                    templateId = "iceCrystal",
                    baseColor = "#69cbe8",
                    shadowColor = "#173d73",
                    highlightColor = "#e8fbff",
                    edgeColor = "#b7f4ff",
                    opacity = 0.92f,
                    edgeJaggedness = legacy.visual?.jaggedness ?? 0.45f,
                    facetScale = legacy.visual?.facetSize ?? 28f,
                    facetVariation = legacy.visual?.facetVariation ?? 0.55f,
                    textureStrength = legacy.visual?.textureStrength ?? 0.65f,
                    edgeBrightness = legacy.visual?.edgeBrightness ?? 0.85f,
                    edgeWidthPixels = legacy.visual?.frostWidth ?? 2.5f,
                    volumeDepth = legacy.visual?.volumeDepth ?? 0.72f,
                    transmission = legacy.visual?.transmission ?? 0.58f,
                    absorption = legacy.visual?.absorption ?? 0.35f,
                    roughness = 0.24f,
                    specularStrength = legacy.visual?.specularStrength ?? 0.85f,
                    inclusionDensity = legacy.visual?.inclusionDensity ?? 0.18f,
                    microCrackDensity = legacy.visual?.microCrackDensity ?? 0.12f,
                    grainDirectionDegrees = -25f,
                    anisotropy = 0.35f,
                    lightAngleDegrees = legacy.visual?.lightAngleDegrees ?? -35f,
                },
                physical = new FrameActionMapProceduralRigidPhysicalData
                {
                    anchoringMode = string.Equals(legacy.closureMode, "terrain", StringComparison.OrdinalIgnoreCase) ? "terrainAttached" : "dynamic",
                    density = 0.92f,
                    gravityScale = 1f,
                    friction = 0.12f,
                    restitution = 0.08f,
                    linearDamping = 0.12f,
                    angularDamping = 0.08f,
                    hardness = 0.72f,
                    toughness = 0.35f,
                    brittleness = 0.9f,
                    anisotropy = 0.35f,
                    grainAngleDegrees = -25f,
                    debrisFraction = 0.16f,
                },
            };
            FrameActionMapIceFractureData oldFracture = legacy.fracture ?? new FrameActionMapIceFractureData();
            upgraded.fracture = new FrameActionMapProceduralRigidFractureData
            {
                primaryFragmentMin = oldFracture.primaryFragmentMin,
                primaryFragmentMax = oldFracture.primaryFragmentMax,
                maxFragmentsPerImpact = Mathf.Clamp(oldFracture.primaryFragmentMax, 2, 8),
                maxActiveFragmentsPerFamily = 48,
                minimumFragmentArea = oldFracture.minimumFragmentArea,
                minimumFragmentWidth = oldFracture.minimumFragmentWidth,
                crackBranchMin = oldFracture.crackBranchMin,
                crackBranchMax = oldFracture.crackBranchMax,
                releaseDelayTicks = oldFracture.releaseDelayTicks,
                impactChipEnergy = oldFracture.impactChipEnergy > 0f ? oldFracture.impactChipEnergy : oldFracture.landingChipEnergy,
                impactCrackEnergy = oldFracture.impactCrackEnergy > 0f ? oldFracture.impactCrackEnergy : oldFracture.landingCrackEnergy,
                impactBreakEnergy = oldFracture.impactBreakEnergy > 0f ? oldFracture.impactBreakEnergy : oldFracture.landingBreakEnergy,
                collisionBreakThreshold = oldFracture.collisionBreakThreshold,
                landingChipEnergy = oldFracture.landingChipEnergy,
                landingCrackEnergy = oldFracture.landingCrackEnergy,
                landingBreakEnergy = oldFracture.landingBreakEnergy,
                contactStressSensitivity = oldFracture.contactStressSensitivity,
                landingCooldownTicks = oldFracture.landingCooldownTicks,
            };
            upgraded.facets = new List<FrameActionMapProceduralRigidFacetData>();
            if (legacy.facets != null)
            {
                for (int index = 0; index < legacy.facets.Count; index++)
                {
                    FrameActionMapIceFacetData facet = legacy.facets[index];
                    if (facet == null) continue;
                    upgraded.facets.Add(new FrameActionMapProceduralRigidFacetData
                    {
                        id = facet.id,
                        points = facet.points != null ? new List<FrameActionMapPoint>(facet.points) : new List<FrameActionMapPoint>(),
                        shade = facet.shade,
                    });
                }
            }
            if (legacy.terrainBinding != null)
            {
                upgraded.terrainBinding = new FrameActionMapProceduralRigidTerrainBindingData
                {
                    sourceId = legacy.terrainBinding.sourceId,
                    sourceKind = legacy.terrainBinding.sourceKind,
                    route = legacy.terrainBinding.route,
                    start = legacy.terrainBinding.start,
                    end = legacy.terrainBinding.end,
                };
            }
            return upgraded;
        }

        private static Color ParseHtmlColor(string value, Color fallback)
        {
            if (!string.IsNullOrWhiteSpace(value) && ColorUtility.TryParseHtmlString(value.Trim(), out Color parsed))
                return new Color(parsed.r, parsed.g, parsed.b, 1f);
            return fallback;
        }

        private static FrameActionProceduralRigidEdgeRole ParseProceduralRigidEdgeRole(string value)
        {
            if (string.Equals(value, "terrainAttached", StringComparison.OrdinalIgnoreCase)) return FrameActionProceduralRigidEdgeRole.TerrainAttached;
            if (string.Equals(value, "fractureShared", StringComparison.OrdinalIgnoreCase)) return FrameActionProceduralRigidEdgeRole.FractureShared;
            if (string.Equals(value, "generatedSeam", StringComparison.OrdinalIgnoreCase)) return FrameActionProceduralRigidEdgeRole.GeneratedSeam;
            return FrameActionProceduralRigidEdgeRole.Exposed;
        }

        private static Vector2[] ConvertPoints(List<FrameActionMapPoint> points, Func<FrameActionMapPoint, Vector2> convertPoint)
        {
            if (points == null || points.Count == 0) return Array.Empty<Vector2>();
            Vector2[] result = new Vector2[points.Count];
            for (int index = 0; index < points.Count; index++)
            {
                if (points[index] == null) return Array.Empty<Vector2>();
                result[index] = convertPoint(points[index]);
            }
            return result;
        }

        private static Vector2 ConvertMapPointToLocal(FrameActionMapPoint point, Vector2 pivot, int mapHeight, float ppu)
        {
            float pixelsPerUnit = Mathf.Max(1f, ppu);
            return new Vector2(point.x / pixelsPerUnit, (mapHeight - point.y) / pixelsPerUnit) - pivot;
        }

        private static Vector2[] MakeLocalPoints(Vector2[] points, Vector2 pivot)
        {
            if (points == null || points.Length == 0) return Array.Empty<Vector2>();
            Vector2[] result = new Vector2[points.Length];
            for (int index = 0; index < points.Length; index++) result[index] = points[index] - pivot;
            return result;
        }

        private static Vector2 ComputePolygonCentroid(Vector2[] points)
        {
            if (points == null || points.Length == 0) return Vector2.zero;
            float crossSum = 0f;
            Vector2 weighted = Vector2.zero;
            Vector2 average = Vector2.zero;
            for (int index = 0; index < points.Length; index++)
            {
                Vector2 current = points[index];
                Vector2 next = points[(index + 1) % points.Length];
                float cross = current.x * next.y - next.x * current.y;
                crossSum += cross;
                weighted += (current + next) * cross;
                average += current;
            }
            if (Mathf.Abs(crossSum) <= 0.000001f) return average / points.Length;
            return weighted / (3f * crossSum);
        }

        private static void ConfigureMovingObject(GameObject instance, FrameActionMapObjectData item)
        {
            Rigidbody2D body = instance.AddComponent<Rigidbody2D>();
            body.bodyType = RigidbodyType2D.Kinematic;
            body.gravityScale = 0f;
            body.interpolation = RigidbodyInterpolation2D.Interpolate;
            body.collisionDetectionMode = CollisionDetectionMode2D.Continuous;
            body.constraints = RigidbodyConstraints2D.FreezeRotation;
            body.useFullKinematicContacts = true;

            FrameActionMapMotionData motion = item.motion ?? new FrameActionMapMotionData();
            FrameActionMovingPlatform2D mover = instance.AddComponent<FrameActionMovingPlatform2D>();
            mover.direction = string.Equals(motion.direction, "vertical", StringComparison.OrdinalIgnoreCase) ? "vertical" : "horizontal";
            mover.speedMetersPerSecond = Mathf.Max(0f, motion.speedMetersPerSecond);
            mover.rangeMeters = Mathf.Max(0f, motion.rangeMeters);
            mover.initialProgress = Mathf.Clamp01(motion.initialProgress);
            mover.pingPong = motion.pingPong;
            mover.endpointPauseSeconds = Mathf.Max(0f, motion.endpointPauseSeconds);
            mover.phaseSeconds = Mathf.Max(0f, motion.phaseSeconds);
        }

        private static int ResolveMapObjectSortingOrder(string layer, int index)
        {
            if (string.Equals(layer, "occlusion", StringComparison.OrdinalIgnoreCase))
            {
                return OcclusionSortingOrder + Mathf.Clamp(index, 0, 999);
            }
            if (string.Equals(layer, "collision", StringComparison.OrdinalIgnoreCase))
            {
                return CollisionSortingOrder + Mathf.Clamp(index, 0, 899);
            }
            if (string.Equals(layer, "rigid", StringComparison.OrdinalIgnoreCase))
            {
                return RigidSortingOrder + Mathf.Clamp(index, 0, 899);
            }
            return DecorationSortingOrder + Mathf.Clamp(index, 0, 899);
        }

        private static void ConfigureSolidGroundComposite(GameObject collisionLayer)
        {
            Rigidbody2D body = collisionLayer.AddComponent<Rigidbody2D>();
            body.bodyType = RigidbodyType2D.Static;
            body.simulated = true;

            CompositeCollider2D composite = collisionLayer.AddComponent<CompositeCollider2D>();
            composite.geometryType = CompositeCollider2D.GeometryType.Polygons;
            composite.generationType = CompositeCollider2D.GenerationType.Synchronous;
            composite.vertexDistance = 0.005f;
            composite.edgeRadius = 0.02f;
        }

        private static void ConfigureAutomaticBoundaries(GameObject boundaryLayer, GameObject deathBoundaryLayer, float mapWidth, float mapHeight)
        {
            float width = Mathf.Max(0.01f, mapWidth);
            float height = Mathf.Max(0.01f, mapHeight);
            float wallHeight = height + BoundaryVerticalPadding * 2f;
            float wallCenterY = height * 0.5f;

            CreateBoundaryWall(boundaryLayer.transform, "AutoBoundary_Left", -BoundaryWallThickness * 0.5f, wallCenterY, wallHeight);
            CreateBoundaryWall(boundaryLayer.transform, "AutoBoundary_Right", width + BoundaryWallThickness * 0.5f, wallCenterY, wallHeight);

            GameObject deathBoundary = new GameObject("AutoDeathBoundary_Bottom");
            deathBoundary.transform.SetParent(deathBoundaryLayer.transform, false);
            deathBoundary.layer = deathBoundaryLayer.layer;
            deathBoundary.transform.localPosition = new Vector3(width * 0.5f, -DeathBoundaryTopGap - DeathBoundaryHeight * 0.5f, 0f);
            BoxCollider2D trigger = deathBoundary.AddComponent<BoxCollider2D>();
            trigger.size = new Vector2(width + BoundaryWallThickness * 2f, DeathBoundaryHeight);
            trigger.isTrigger = true;
            FrameActionDeathBoundary2D death = deathBoundary.AddComponent<FrameActionDeathBoundary2D>();
            death.playersOnly = true;
            death.playerTag = "Player";
        }

        private static void CreateBoundaryWall(Transform parent, string name, float centerX, float centerY, float height)
        {
            GameObject wall = new GameObject(name);
            wall.transform.SetParent(parent, false);
            wall.layer = parent.gameObject.layer;
            wall.transform.localPosition = new Vector3(centerX, centerY, 0f);
            BoxCollider2D collider = wall.AddComponent<BoxCollider2D>();
            collider.size = new Vector2(BoundaryWallThickness, height);
        }

        private static void CreateObjectCollider(GameObject instance, Sprite sprite, string collisionType)
        {
            if (!string.Equals(collisionType, "oneWay", StringComparison.OrdinalIgnoreCase))
            {
                CreateAutoOutlineCollider(instance, sprite, false);
                return;
            }

            List<Vector2[]> surfaces = BuildStableOneWaySurfaces(sprite);
            if (surfaces.Count == 0)
            {
                Bounds bounds = sprite != null ? sprite.bounds : new Bounds(Vector3.zero, new Vector3(2f, 0.2f, 0f));
                float inset = Mathf.Min(0.04f, bounds.size.x * 0.02f);
                surfaces.Add(new[]
                {
                    new Vector2(bounds.min.x + inset, bounds.max.y),
                    new Vector2(bounds.max.x - inset, bounds.max.y),
                });
                Debug.LogWarning($"[Frame Action] '{instance.name}' had no usable sprite physics outline; its one-way surface used sprite bounds.");
            }

            for (int surfaceIndex = 0; surfaceIndex < surfaces.Count; surfaceIndex++)
            {
                Vector2[] points = surfaces[surfaceIndex];
                if (points == null || points.Length < 2) continue;
                EdgeCollider2D edge = instance.AddComponent<EdgeCollider2D>();
                edge.points = points;
                edge.edgeRadius = 0.02f;
                ConfigureOpenEdgeAdjacency(edge);
                edge.usedByEffector = true;
            }
            CreateOneWayEdgeEffector(instance, surfaces[0][0], surfaces[0][surfaces[0].Length - 1]);
        }

        private static void CreateRigidObjectCollider(GameObject instance, Sprite sprite, FrameActionMapAssetEntry entry, float ppu)
        {
            List<FrameActionMapOutlineData> authored = entry?.outlines?
                .Where(outline => outline?.points != null
                    && string.Equals(outline.layer, "rigid", StringComparison.OrdinalIgnoreCase)
                    && outline.points.Count >= 3)
                .ToList();
            if (authored == null || authored.Count == 0)
            {
                CreateAutoRigidCollider(instance, sprite);
                return;
            }

            float assetWidth = Mathf.Max(1f, entry.width);
            float assetHeight = Mathf.Max(1f, entry.height);
            float pixelsPerUnit = Mathf.Max(1f, ppu);
            PolygonCollider2D collider = instance.AddComponent<PolygonCollider2D>();
            collider.pathCount = authored.Count;
            for (int pathIndex = 0; pathIndex < authored.Count; pathIndex++)
            {
                FrameActionMapOutlineData outline = authored[pathIndex];
                Vector2[] points = new Vector2[outline.points.Count];
                for (int pointIndex = 0; pointIndex < points.Length; pointIndex++)
                {
                    FrameActionMapPoint point = outline.points[pointIndex];
                    points[pointIndex] = new Vector2(
                        (point.x - assetWidth * 0.5f) / pixelsPerUnit,
                        (assetHeight * 0.5f - point.y) / pixelsPerUnit);
                }
                collider.SetPath(pathIndex, points);
            }
        }

        private static bool HasAssetOutlineLayer(FrameActionMapAssetEntry entry, string layer)
        {
            return entry?.outlines != null && entry.outlines.Any(outline =>
                outline != null
                && string.Equals(outline.layer, layer, StringComparison.OrdinalIgnoreCase)
                && outline.points != null
                && outline.points.Count >= (string.Equals(outline.shape, "groundLine", StringComparison.OrdinalIgnoreCase) ? 4 : 3));
        }

        private static PolygonCollider2D CreateAutoRigidCollider(GameObject instance, Sprite sprite)
        {
            if (TryBuildAlphaRigidColliderPath(sprite, out Vector2[] path))
            {
                PolygonCollider2D collider = instance.AddComponent<PolygonCollider2D>();
                collider.pathCount = 1;
                collider.SetPath(0, path);
                return collider;
            }
            return CreateAutoOutlineCollider(instance, sprite, false);
        }

        /// <summary>
        /// Direct adaptation of ArcaneMatter's intact authored-rigid path. The image alpha mask
        /// supplies the collision silhouette, while ElementRigidBody2D rebuilds its compact
        /// convex hull only when a fracture needs to be computed.
        /// </summary>
        private static bool TryBuildAlphaRigidColliderPath(Sprite sprite, out Vector2[] path)
        {
            path = null;
            if (sprite == null || sprite.texture == null || !sprite.texture.isReadable) return false;
            Rect textureRect = sprite.textureRect;
            int minX = Mathf.Clamp(Mathf.FloorToInt(textureRect.xMin), 0, sprite.texture.width);
            int minY = Mathf.Clamp(Mathf.FloorToInt(textureRect.yMin), 0, sprite.texture.height);
            int maxX = Mathf.Clamp(Mathf.CeilToInt(textureRect.xMax), 0, sprite.texture.width);
            int maxY = Mathf.Clamp(Mathf.CeilToInt(textureRect.yMax), 0, sprite.texture.height);
            if (maxX <= minX || maxY <= minY) return false;

            Color32[] pixels = sprite.texture.GetPixels32();
            float pixelsPerUnit = Mathf.Max(1f, sprite.pixelsPerUnit);
            Vector2 pivot = sprite.pivot;
            List<Vector2> candidates = new List<Vector2>();
            Vector2 textureRectOffset = sprite.textureRectOffset;
            for (int textureY = minY; textureY < maxY; textureY++)
            {
                for (int textureX = minX; textureX < maxX; textureX++)
                {
                    if (pixels[textureY * sprite.texture.width + textureX].a < RigidPhysicalAlphaThreshold) continue;
                    int localX = textureX - minX;
                    int localY = textureY - minY;
                    AddAlphaPixelCorner(candidates, textureRectOffset, pivot, pixelsPerUnit, localX, localY);
                    AddAlphaPixelCorner(candidates, textureRectOffset, pivot, pixelsPerUnit, localX + 1, localY);
                    AddAlphaPixelCorner(candidates, textureRectOffset, pivot, pixelsPerUnit, localX + 1, localY + 1);
                    AddAlphaPixelCorner(candidates, textureRectOffset, pivot, pixelsPerUnit, localX, localY + 1);
                }
            }
            if (candidates.Count < 3) return false;
            path = BuildConvexAlphaOutline(candidates);
            return path != null;
        }

        private static void AddAlphaPixelCorner(
            List<Vector2> candidates,
            Vector2 textureRectOffset,
            Vector2 pivot,
            float pixelsPerUnit,
            int x,
            int y)
        {
            candidates.Add(new Vector2(
                (textureRectOffset.x + x - pivot.x) / pixelsPerUnit,
                (textureRectOffset.y + y - pivot.y) / pixelsPerUnit));
        }

        private static Vector2[] BuildConvexAlphaOutline(List<Vector2> candidates)
        {
            candidates.Sort((first, second) =>
            {
                int horizontal = first.x.CompareTo(second.x);
                return horizontal != 0 ? horizontal : first.y.CompareTo(second.y);
            });
            List<Vector2> unique = new List<Vector2>(candidates.Count);
            for (int index = 0; index < candidates.Count; index++)
            {
                if (index == 0 || candidates[index] != candidates[index - 1]) unique.Add(candidates[index]);
            }
            if (unique.Count < 3) return null;

            List<Vector2> hull = new List<Vector2>(unique.Count * 2);
            for (int index = 0; index < unique.Count; index++)
            {
                while (hull.Count >= 2 && Cross(hull[hull.Count - 2], hull[hull.Count - 1], unique[index]) <= 0f)
                    hull.RemoveAt(hull.Count - 1);
                hull.Add(unique[index]);
            }
            int lowerCount = hull.Count;
            for (int index = unique.Count - 2; index >= 0; index--)
            {
                while (hull.Count > lowerCount && Cross(hull[hull.Count - 2], hull[hull.Count - 1], unique[index]) <= 0f)
                    hull.RemoveAt(hull.Count - 1);
                hull.Add(unique[index]);
            }
            hull.RemoveAt(hull.Count - 1);
            if (hull.Count < 3) return null;

            int outputCount = Mathf.Min(AuthoredRigidColliderVertexLimit, hull.Count);
            Vector2[] result = new Vector2[outputCount];
            for (int index = 0; index < outputCount; index++)
            {
                int hullIndex = hull.Count <= AuthoredRigidColliderVertexLimit
                    ? index
                    : Mathf.FloorToInt(index * hull.Count / (float)outputCount);
                result[index] = hull[hullIndex];
            }
            return result;
        }

        private static float Cross(Vector2 origin, Vector2 first, Vector2 second)
        {
            return (first.x - origin.x) * (second.y - origin.y) -
                   (first.y - origin.y) * (second.x - origin.x);
        }

        private static void CreateAssetOutlineColliders(GameObject instance, SpriteRenderer renderer, FrameActionMapAssetEntry entry, float ppu, int collisionLayer, int occlusionLayer)
        {
            if (instance == null || entry?.outlines == null || entry.outlines.Count == 0) return;
            float assetWidth = Mathf.Max(1f, entry.width);
            float assetHeight = Mathf.Max(1f, entry.height);
            float pixelsPerUnit = Mathf.Max(1f, ppu);
            List<Vector2[]> occlusionPaths = new List<Vector2[]>();

            for (int outlineIndex = 0; outlineIndex < entry.outlines.Count; outlineIndex++)
            {
                FrameActionMapOutlineData outline = entry.outlines[outlineIndex];
                if (outline?.points == null) continue;
                bool rectangle = string.Equals(outline.shape, "groundLine", StringComparison.OrdinalIgnoreCase);
                int minimumPoints = rectangle ? 4 : 3;
                if (outline.points.Count < minimumPoints) continue;

                Vector2[] points = new Vector2[outline.points.Count];
                for (int pointIndex = 0; pointIndex < outline.points.Count; pointIndex++)
                {
                    FrameActionMapPoint point = outline.points[pointIndex];
                    points[pointIndex] = new Vector2((point.x - assetWidth * 0.5f) / pixelsPerUnit, (assetHeight * 0.5f - point.y) / pixelsPerUnit);
                }

                if (string.Equals(outline.layer, "occlusion", StringComparison.OrdinalIgnoreCase))
                {
                    occlusionPaths.Add(points);
                    continue;
                }

                GameObject colliderObject = new GameObject($"CustomCollision_{outlineIndex + 1}");
                colliderObject.transform.SetParent(instance.transform, false);
                colliderObject.layer = collisionLayer;
                bool oneWay = string.Equals(outline.collisionType, "oneWay", StringComparison.OrdinalIgnoreCase);

                if (rectangle)
                {
                    bool sideCollision = outline.sideCollision;
                    if (!oneWay && sideCollision)
                    {
                        PolygonCollider2D rectangleCollider = colliderObject.AddComponent<PolygonCollider2D>();
                        rectangleCollider.pathCount = 1;
                        rectangleCollider.SetPath(0, points);
                        continue;
                    }

                    EdgeCollider2D top = CreateEdgeCollider(colliderObject, points[0], points[1]);
                    if (!sideCollision) ConfigureOpenEdgeAdjacency(top);
                    if (oneWay)
                    {
                        top.usedByEffector = true;
                        CreateOneWayEdgeEffector(colliderObject, points[0], points[1]);
                    }
                    else
                    {
                        EdgeCollider2D bottom = CreateEdgeCollider(colliderObject, points[3], points[2]);
                        if (!sideCollision) ConfigureOpenEdgeAdjacency(bottom);
                    }
                    if (sideCollision)
                    {
                        CreateEdgeCollider(colliderObject, points[0], points[3]);
                        CreateEdgeCollider(colliderObject, points[1], points[2]);
                    }
                    continue;
                }

                PolygonCollider2D polygon = colliderObject.AddComponent<PolygonCollider2D>();
                polygon.pathCount = 1;
                polygon.SetPath(0, points);
                if (oneWay)
                {
                    polygon.usedByEffector = true;
                    PlatformEffector2D effector = colliderObject.AddComponent<PlatformEffector2D>();
                    effector.useOneWay = true;
                    effector.useOneWayGrouping = true;
                    effector.surfaceArc = 160f;
                }
            }

            if (occlusionPaths.Count == 0) return;
            GameObject occlusionObject = new GameObject("CustomOcclusion");
            occlusionObject.transform.SetParent(instance.transform, false);
            occlusionObject.layer = occlusionLayer;
            PolygonCollider2D occlusionTrigger = occlusionObject.AddComponent<PolygonCollider2D>();
            occlusionTrigger.isTrigger = true;
            occlusionTrigger.pathCount = occlusionPaths.Count;
            for (int pathIndex = 0; pathIndex < occlusionPaths.Count; pathIndex++) occlusionTrigger.SetPath(pathIndex, occlusionPaths[pathIndex]);
            FrameActionMapOccluder2D customOccluder = occlusionObject.AddComponent<FrameActionMapOccluder2D>();
            customOccluder.targetRenderer = renderer;
            customOccluder.trigger = occlusionTrigger;
        }

        private static List<Vector2[]> BuildStableOneWaySurfaces(Sprite sprite)
        {
            List<Vector2[]> surfaces = new List<Vector2[]>();
            if (sprite == null) return surfaces;

            int shapeCount = sprite.GetPhysicsShapeCount();
            float ppu = Mathf.Max(1f, sprite.pixelsPerUnit);
            float sampleSpacing = AutomaticOutlineTolerancePixels / ppu;
            int sampleLimit = AutomaticOutlineVertexLimit;
            for (int shapeIndex = 0; shapeIndex < shapeCount; shapeIndex++)
            {
                List<Vector2> shape = new List<Vector2>();
                sprite.GetPhysicsShape(shapeIndex, shape);
                if (shape.Count < 3) continue;

                float minimumX = float.PositiveInfinity;
                float maximumX = float.NegativeInfinity;
                for (int pointIndex = 0; pointIndex < shape.Count; pointIndex++)
                {
                    minimumX = Mathf.Min(minimumX, shape[pointIndex].x);
                    maximumX = Mathf.Max(maximumX, shape[pointIndex].x);
                }
                float width = maximumX - minimumX;
                if (width <= 0.001f) continue;

                int sampleCount = Mathf.Clamp(Mathf.CeilToInt(width / Mathf.Max(0.0001f, sampleSpacing)) + 1, 8, sampleLimit);
                List<Vector2> envelope = new List<Vector2>(sampleCount);
                List<float> heights = new List<float>(sampleCount);
                for (int sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++)
                {
                    float x = Mathf.Lerp(minimumX, maximumX, sampleIndex / (float)(sampleCount - 1));
                    if (!TrySampleUpperOutline(shape, x, out float y)) continue;
                    envelope.Add(new Vector2(x, y));
                    heights.Add(y);
                }
                if (envelope.Count < 2) continue;

                // Decorative towers, grass, glow, and chipped pixels create separated
                // upward-facing polygon edges. A moving one-way platform must instead
                // expose one continuous support plane. The lower quartile of the alpha
                // silhouette's upper envelope reliably selects the broad platform deck
                // while rejecting narrow peaks and low tapered end pixels.
                heights.Sort();
                float surfaceY = heights[Mathf.Clamp(Mathf.FloorToInt((heights.Count - 1) * 0.25f), 0, heights.Count - 1)];
                if (!TryFindWidestSupportedRun(envelope, surfaceY, out float startX, out float endX)) continue;
                float inset = Mathf.Min(0.04f, (endX - startX) * 0.02f);
                startX += inset;
                endX -= inset;
                if (endX - startX <= 0.001f) continue;
                surfaces.Add(new[] { new Vector2(startX, surfaceY), new Vector2(endX, surfaceY) });
            }
            return surfaces;
        }

        private static bool TrySampleUpperOutline(List<Vector2> shape, float x, out float upperY)
        {
            upperY = float.NegativeInfinity;
            const float epsilon = 0.0001f;
            for (int pointIndex = 0; pointIndex < shape.Count; pointIndex++)
            {
                Vector2 start = shape[pointIndex];
                Vector2 end = shape[(pointIndex + 1) % shape.Count];
                float minimumX = Mathf.Min(start.x, end.x);
                float maximumX = Mathf.Max(start.x, end.x);
                if (x < minimumX - epsilon || x > maximumX + epsilon) continue;

                float deltaX = end.x - start.x;
                float y;
                if (Mathf.Abs(deltaX) <= epsilon)
                {
                    if (Mathf.Abs(x - start.x) > epsilon) continue;
                    y = Mathf.Max(start.y, end.y);
                }
                else
                {
                    float t = (x - start.x) / deltaX;
                    if (t < -epsilon || t > 1f + epsilon) continue;
                    y = Mathf.Lerp(start.y, end.y, Mathf.Clamp01(t));
                }
                upperY = Mathf.Max(upperY, y);
            }
            return !float.IsNegativeInfinity(upperY);
        }

        private static bool TryFindWidestSupportedRun(List<Vector2> envelope, float surfaceY, out float startX, out float endX)
        {
            startX = 0f;
            endX = 0f;
            float currentStart = 0f;
            bool inside = false;
            for (int index = 0; index < envelope.Count; index++)
            {
                bool supported = envelope[index].y >= surfaceY - 0.0001f;
                if (supported && !inside)
                {
                    currentStart = envelope[index].x;
                    inside = true;
                }
                bool closes = inside && (!supported || index == envelope.Count - 1);
                if (!closes) continue;
                float currentEnd = supported ? envelope[index].x : envelope[Mathf.Max(0, index - 1)].x;
                if (currentEnd - currentStart > endX - startX)
                {
                    startX = currentStart;
                    endX = currentEnd;
                }
                inside = false;
            }
            return endX - startX > 0.001f;
        }

        private static EdgeCollider2D CreateEdgeCollider(GameObject instance, Vector2 start, Vector2 end)
        {
            EdgeCollider2D edge = instance.AddComponent<EdgeCollider2D>();
            edge.points = new[] { start, end };
            edge.edgeRadius = 0.02f;
            return edge;
        }

        private static void EnsureMinimumSolidGroundDepth(Vector2[] points)
        {
            if (points == null || points.Length < 4) return;

            // groundLine point order is: top-left, top-right, bottom-right, bottom-left.
            // Only move the underside so the visible/walkable surface and its slope never change.
            points[2].y = Mathf.Min(points[2].y, points[1].y - MinimumSolidGroundDepth);
            points[3].y = Mathf.Min(points[3].y, points[0].y - MinimumSolidGroundDepth);
        }

        private static PlatformEffector2D CreateOneWayEdgeEffector(GameObject instance, Vector2 start, Vector2 end)
        {
            PlatformEffector2D effector = instance.AddComponent<PlatformEffector2D>();
            effector.useOneWay = true;
            effector.useOneWayGrouping = true;
            effector.useSideFriction = false;
            effector.useSideBounce = false;

            Vector2 tangent = end - start;
            if (tangent.sqrMagnitude > 0.000001f)
            {
                tangent.Normalize();
                Vector2 surfaceNormal = new Vector2(-tangent.y, tangent.x);
                if (surfaceNormal.y < 0f) surfaceNormal = -surfaceNormal;
                effector.rotationalOffset = Vector2.SignedAngle(Vector2.up, surfaceNormal);
            }
            // A narrow slope-aligned arc accepts the walking surface without treating edge endpoints as side walls.
            effector.surfaceArc = 70f;
            return effector;
        }

        private static void ConfigureOpenEdgeAdjacency(EdgeCollider2D edge)
        {
            Vector2[] points = edge.points;
            if (points == null || points.Length < 2) return;
            Vector2 start = points[0];
            Vector2 end = points[points.Length - 1];
            Vector2 direction = end - start;
            if (direction.sqrMagnitude < 0.000001f) return;
            direction.Normalize();
            edge.useAdjacentStartPoint = true;
            edge.adjacentStartPoint = start - direction;
            edge.useAdjacentEndPoint = true;
            edge.adjacentEndPoint = end + direction;
        }

        private static PolygonCollider2D CreateAutoOutlineCollider(GameObject instance, Sprite sprite, bool isTrigger)
        {
            PolygonCollider2D collider = instance.AddComponent<PolygonCollider2D>();
            collider.isTrigger = isTrigger;
            if (sprite == null) return collider;
            int shapeCount = sprite.GetPhysicsShapeCount();
            if (shapeCount <= 0)
            {
                Bounds bounds = sprite.bounds;
                collider.pathCount = 1;
                collider.SetPath(0, new[]
                {
                    new Vector2(bounds.min.x, bounds.min.y), new Vector2(bounds.max.x, bounds.min.y),
                    new Vector2(bounds.max.x, bounds.max.y), new Vector2(bounds.min.x, bounds.max.y),
                });
                return collider;
            }
            float tolerance = AutomaticOutlineTolerancePixels / Mathf.Max(1f, sprite.pixelsPerUnit);
            int vertexLimit = AutomaticOutlineVertexLimit;
            List<List<Vector2>> paths = new List<List<Vector2>>();
            for (int shapeIndex = 0; shapeIndex < shapeCount; shapeIndex++)
            {
                List<Vector2> source = new List<Vector2>();
                sprite.GetPhysicsShape(shapeIndex, source);
                if (source.Count < 3) continue;
                List<Vector2> simplified = Simplify(source, tolerance, vertexLimit);
                if (simplified.Count >= 3) paths.Add(simplified);
            }
            if (paths.Count == 0) return collider;
            collider.pathCount = paths.Count;
            for (int pathIndex = 0; pathIndex < paths.Count; pathIndex++) collider.SetPath(pathIndex, paths[pathIndex]);
            return collider;
        }

        private static List<Vector2> Simplify(List<Vector2> source, float tolerance, int vertexLimit)
        {
            List<Vector2> closed = new List<Vector2>(source);
            if ((closed[0] - closed[closed.Count - 1]).sqrMagnitude > 0.000001f) closed.Add(closed[0]);
            List<Vector2> output = new List<Vector2>();
            float currentTolerance = Mathf.Max(0.0001f, tolerance);
            for (int attempt = 0; attempt < 8; attempt++)
            {
                output.Clear();
                LineUtility.Simplify(closed, currentTolerance, output);
                if (output.Count > 1 && (output[0] - output[output.Count - 1]).sqrMagnitude <= 0.000001f) output.RemoveAt(output.Count - 1);
                if (output.Count <= vertexLimit) break;
                currentTolerance *= 1.6f;
            }
            return output.Count >= 3 ? new List<Vector2>(output) : new List<Vector2>(source);
        }

        private static Vector3 PixelCenterToWorld(float x, float y, int mapHeight, float ppu, float z)
        {
            return new Vector3(x / ppu, (mapHeight - y) / ppu, z);
        }

        private static GameObject CreateLayer(Transform parent, string name, string unityLayerName)
        {
            GameObject layer = new GameObject(name);
            layer.transform.SetParent(parent, false);
            int layerIndex = EnsureUnityLayer(unityLayerName);
            if (layerIndex >= 0) layer.layer = layerIndex;
            return layer;
        }

        private static int EnsureUnityLayer(string layerName)
        {
            int existing = LayerMask.NameToLayer(layerName);
            if (existing >= 0) return existing;
            UnityEngine.Object[] assets = AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/TagManager.asset");
            if (assets == null || assets.Length == 0) return -1;
            SerializedObject tagManager = new SerializedObject(assets[0]);
            SerializedProperty layers = tagManager.FindProperty("layers");
            for (int index = 8; index < layers.arraySize; index++)
            {
                SerializedProperty layer = layers.GetArrayElementAtIndex(index);
                if (!string.IsNullOrEmpty(layer.stringValue)) continue;
                layer.stringValue = layerName;
                tagManager.ApplyModifiedProperties();
                AssetDatabase.SaveAssets();
                return index;
            }
            Debug.LogWarning($"[Frame Action] No empty Unity Layer slot for '{layerName}'.");
            return -1;
        }

        private static T GetOrAdd<T>(GameObject root) where T : Component
        {
            T component = root.GetComponent<T>();
            return component != null ? component : root.AddComponent<T>();
        }

        private static string ResolvePrefabPath(string configuredPath, string slug, string mapName)
        {
            string path = string.IsNullOrWhiteSpace(configuredPath)
                ? $"Assets/FrameActionGenerated/Maps/{slug}/{SafeAssetName(mapName, slug)}.prefab"
                : configuredPath.Trim().Replace("\\", "/");
            if (!path.StartsWith("Assets/", StringComparison.Ordinal) || !path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) || path.Contains("../"))
                throw new InvalidOperationException($"Map prefab path must be an Assets/*.prefab path: {path}");
            return path;
        }

        private static string SafeAssetName(string value, string fallback)
        {
            string result = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
            foreach (char invalid in Path.GetInvalidFileNameChars()) result = result.Replace(invalid, '_');
            return string.IsNullOrWhiteSpace(result) ? fallback : result;
        }

        private static void EnsureAssetFolder(string assetFolder)
        {
            if (string.IsNullOrEmpty(assetFolder) || AssetDatabase.IsValidFolder(assetFolder)) return;
            string[] parts = assetFolder.Split('/');
            string current = parts[0];
            for (int index = 1; index < parts.Length; index++)
            {
                string next = $"{current}/{parts[index]}";
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(current, parts[index]);
                current = next;
            }
        }
    }
}
