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
        private const int OcclusionSortingOrder = 2000;

        private static readonly string[] ManagedLayerNames = { "BackgroundLayer", "DecorationLayer", "CollisionLayer", "MovingPlatformLayer", "OcclusionLayer", "BoundaryLayer", "DeathBoundaryLayer" };

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
                    bool dynamic = string.Equals(item.mode, "dynamic", StringComparison.OrdinalIgnoreCase);
                    GameObject parent = dynamic ? movingPlatformLayer : item.layer == "collision" ? collisionLayer : item.layer == "occlusion" ? occlusionLayer : decorationLayer;
                    GameObject instance = new GameObject(string.IsNullOrEmpty(entry.name) ? item.id : entry.name);
                    instance.transform.SetParent(parent.transform, false);
                    instance.layer = parent.layer;
                    SpriteRenderer renderer = instance.AddComponent<SpriteRenderer>();
                    renderer.sprite = sprite;
                    renderer.sortingOrder = ResolveMapObjectSortingOrder(item.layer, index);
                    float scale = Mathf.Max(0.01f, item.scale);
                    float width = Mathf.Max(1, entry.width) * scale;
                    float height = Mathf.Max(1, entry.height) * scale;
                    instance.transform.localPosition = PixelCenterToWorld(item.x + width * 0.5f, item.y + height * 0.5f, data.height, ppu, item.z);
                    instance.transform.localRotation = Quaternion.Euler(0f, 0f, -item.rotation);
                    instance.transform.localScale = Vector3.one * scale;
                    if (dynamic) ConfigureMovingObject(instance, item);

                    if (item.layer == "collision")
                    {
                        CreateObjectCollider(instance, sprite, item.collisionType, item.outlinePrecision);
                    }
                    else if (item.layer == "occlusion" && !HasAssetOutlineLayer(entry, "occlusion"))
                    {
                        PolygonCollider2D trigger = CreateAutoOutlineCollider(instance, sprite, item.outlinePrecision, true);
                        FrameActionMapOccluder2D occluder = instance.AddComponent<FrameActionMapOccluder2D>();
                        occluder.targetRenderer = renderer;
                        occluder.trigger = trigger;
                    }
                    CreateAssetOutlineColliders(instance, renderer, entry, ppu, collisionLayer.layer, occlusionLayer.layer);
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
                    GameObject parent = outline.layer == "occlusion" ? occlusionLayer : collisionLayer;
                    GameObject instance = new GameObject(rectangleCollision ? $"rectangle_collision_{index + 1}" : legacyLineRoad ? $"line_road_{index + 1}" : $"{outline.layer}_outline_{index + 1}");
                    instance.transform.SetParent(parent.transform, false);
                    instance.layer = parent.layer;
                    Vector2[] points = new Vector2[outline.points.Count];
                    for (int pointIndex = 0; pointIndex < outline.points.Count; pointIndex++)
                    {
                        FrameActionMapPoint point = outline.points[pointIndex];
                        points[pointIndex] = new Vector2(point.x / ppu, (data.height - point.y) / ppu);
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

        private static void CreateObjectCollider(GameObject instance, Sprite sprite, string collisionType, string precision)
        {
            if (!string.Equals(collisionType, "oneWay", StringComparison.OrdinalIgnoreCase))
            {
                CreateAutoOutlineCollider(instance, sprite, precision, false);
                return;
            }

            List<Vector2[]> surfaces = BuildStableOneWaySurfaces(sprite, precision);
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

        private static bool HasAssetOutlineLayer(FrameActionMapAssetEntry entry, string layer)
        {
            return entry?.outlines != null && entry.outlines.Any(outline =>
                outline != null
                && string.Equals(outline.layer, layer, StringComparison.OrdinalIgnoreCase)
                && outline.points != null
                && outline.points.Count >= (string.Equals(outline.shape, "groundLine", StringComparison.OrdinalIgnoreCase) ? 4 : 3));
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

        private static List<Vector2[]> BuildStableOneWaySurfaces(Sprite sprite, string precision)
        {
            List<Vector2[]> surfaces = new List<Vector2[]>();
            if (sprite == null) return surfaces;

            int shapeCount = sprite.GetPhysicsShapeCount();
            float ppu = Mathf.Max(1f, sprite.pixelsPerUnit);
            float sampleSpacing = PrecisionPixels(precision) / ppu;
            int sampleLimit = PrecisionVertexLimit(precision);
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

        private static PolygonCollider2D CreateAutoOutlineCollider(GameObject instance, Sprite sprite, string precision, bool isTrigger)
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
            float tolerance = PrecisionPixels(precision) / Mathf.Max(1f, sprite.pixelsPerUnit);
            int vertexLimit = PrecisionVertexLimit(precision);
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

        private static float PrecisionPixels(string precision)
        {
            if (precision == "low") return 12f;
            if (precision == "high") return 2f;
            if (precision == "ultra") return 0.5f;
            return 5f;
        }

        private static int PrecisionVertexLimit(string precision)
        {
            if (precision == "ultra") return 256;
            if (precision == "high") return 128;
            if (precision == "low") return 24;
            return 48;
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
