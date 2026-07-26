using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace FrameAction.Editor
{
    internal static class FrameActionCharacterPrefabSynchronizer
    {
        private const int EnemyVfxBackSortingOrder = -1500;
        private const int EnemyMinimumSortingOrder = -1000;
        private const int EnemyMaximumSortingOrder = 0;
        private const int PlayerVfxBackSortingOrder = 250;
        private const int PlayerSortingOrder = 500;
        private const int EnemyVfxSortingOrder = 1000;
        private const int PlayerVfxSortingOrder = 1500;

        public static string Synchronize(FrameActionProjectData data, FrameActionCharacterAsset characterAsset, string outputFolder, string slug)
        {
            FrameActionUnityCharacterSettings settings = data.unityCharacter ?? new FrameActionUnityCharacterSettings();
            string prefabPath = ResolvePrefabPath(settings.prefabPath, outputFolder, slug, data.characterName);
            EnsureAssetFolder(Path.GetDirectoryName(prefabPath)?.Replace("\\", "/"));

            GameObject prefabAsset = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            bool updatingExisting = prefabAsset != null;
            GameObject root = updatingExisting
                ? PrefabUtility.LoadPrefabContents(prefabPath)
                : new GameObject(string.IsNullOrWhiteSpace(data.characterName) ? "Frame Action Character" : data.characterName);
            try
            {
                ConfigureCharacter(root, data, characterAsset, settings);
                PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
                return prefabPath;
            }
            finally
            {
                if (updatingExisting) PrefabUtility.UnloadPrefabContents(root);
                else UnityEngine.Object.DestroyImmediate(root);
            }
        }

        public static string SynchronizeEnemy(FrameActionProjectData data, FrameActionCharacterAsset characterAsset, string outputFolder, string slug)
        {
            FrameActionUnityCharacterSettings settings = data.unityCharacter ?? new FrameActionUnityCharacterSettings();
            string prefabPath = ResolveEnemyPrefabPath(settings.prefabPath, outputFolder, slug, data.characterName);
            EnsureAssetFolder(Path.GetDirectoryName(prefabPath)?.Replace("\\", "/"));

            GameObject prefabAsset = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            bool updatingExisting = prefabAsset != null;
            GameObject root = updatingExisting
                ? PrefabUtility.LoadPrefabContents(prefabPath)
                : new GameObject(string.IsNullOrWhiteSpace(data.characterName) ? "Frame Action Enemy" : data.characterName);
            try
            {
                ConfigureEnemy(root, data, characterAsset, settings);
                PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
                return prefabPath;
            }
            finally
            {
                if (updatingExisting) PrefabUtility.UnloadPrefabContents(root);
                else UnityEngine.Object.DestroyImmediate(root);
            }
        }

        private static void ConfigureEnemy(GameObject root, FrameActionProjectData data, FrameActionCharacterAsset characterAsset, FrameActionUnityCharacterSettings settings)
        {
            root.name = string.IsNullOrWhiteSpace(data.characterName) ? "Frame Action Enemy" : data.characterName;
            root.layer = EnsureUnityLayer(settings.actorLayerName, "Enemy");
            Rigidbody2D body = GetOrAdd<Rigidbody2D>(root);
            body.bodyType = RigidbodyType2D.Dynamic;
            body.mass = Mathf.Max(0.01f, settings.rigidbodyMass);
            body.constraints |= RigidbodyConstraints2D.FreezeRotation;
            body.interpolation = RigidbodyInterpolation2D.Interpolate;
            body.collisionDetectionMode = CollisionDetectionMode2D.Continuous;

            RemoveManagedComponent<FrameActionInputDriver2D>(root);
            RemoveManagedComponent<FrameActionMotor2D>(root);
            RemoveManagedComponent<FrameActionController2D>(root);
            RemoveManagedComponent<FrameActionCameraFollow2D>(root);

            FrameActionPlayer player = GetOrAdd<FrameActionPlayer>(root);
            FrameActionEnemyController2D controller = GetOrAdd<FrameActionEnemyController2D>(root);
            FrameActionEnemyMotor2D enemyMotor = GetOrAdd<FrameActionEnemyMotor2D>(root);
            FrameActionEnemyBehaviorRunner2D behaviorRunner = GetOrAdd<FrameActionEnemyBehaviorRunner2D>(root);
            FrameActionEnemyRenderOrder2D renderOrder = GetOrAdd<FrameActionEnemyRenderOrder2D>(root);
            FrameActionBuiltinEventHandler2D handler = GetOrAdd<FrameActionBuiltinEventHandler2D>(root);
            Collider2D bodyCollider = ConfigureBodyCollider(root, root.GetComponent<Collider2D>(), settings);
            FrameActionActorCollision2D actorCollision = GetOrAdd<FrameActionActorCollision2D>(root);
            ConfigureHurtbox(root, settings);
            SpriteRenderer renderer = ResolveRenderer(root, player);
            renderer.sortingOrder = 0;

            Sprite initialSprite = ResolveInitialSprite(data, characterAsset);
            if (renderer.sprite == null || initialSprite != null) renderer.sprite = initialSprite;

            player.characterAsset = characterAsset;
            player.spriteRenderer = renderer;
            player.visualRoot = renderer.transform;
            player.initialActionId = string.IsNullOrEmpty(data.groundIdleId) ? "ground-idle" : data.groundIdleId;
            player.playOnEnable = false;

            FrameActionEnemyBehaviorSettings behavior = data.enemyBehavior ?? new FrameActionEnemyBehaviorSettings();
            FrameActionEnemyMovementSettings movement = behavior.movement ?? new FrameActionEnemyMovementSettings();
            body.gravityScale = Mathf.Max(0f, movement.gravityScale);
            controller.player = player;
            controller.playGroundIdleOnEnable = behavior.playGroundIdleOnEnable;
            controller.returnToIdleOnComplete = behavior.returnToIdleOnComplete;
            controller.autoPlayDamageReaction = true;
            enemyMotor.controller = controller;
            enemyMotor.body = body;
            enemyMotor.bodyCollider = bodyCollider;
            enemyMotor.enabled = movement.enabled;
            actorCollision.player = player;
            actorCollision.bodyCollider = bodyCollider;
            actorCollision.collideWithOtherActors = settings.collideWithOtherActors;
            behaviorRunner.controller = controller;
            behaviorRunner.motor = enemyMotor;
            behaviorRunner.tickIntervalSeconds = Mathf.Max(0.02f, behavior.tickIntervalSeconds);
            behaviorRunner.enabled = behavior.enabled;
            renderOrder.targetRenderer = renderer;
            renderOrder.bodyCollider = bodyCollider;
            renderOrder.depthBucketsPerWorldUnit = 4f;
            renderOrder.minimumSortingOrder = EnemyMinimumSortingOrder;
            renderOrder.maximumSortingOrder = EnemyMaximumSortingOrder;
            handler.player = player;
            handler.ownerBody = body;
            handler.vfxSortingLayer = renderer.sortingLayerName;
            handler.vfxSortingOrder = EnemyVfxSortingOrder;
            handler.vfxBackSortingOrder = EnemyVfxBackSortingOrder;
            handler.cameraReceiverBehaviour = null;
        }

        private static void ConfigureCharacter(GameObject root, FrameActionProjectData data, FrameActionCharacterAsset characterAsset, FrameActionUnityCharacterSettings settings)
        {
            root.name = string.IsNullOrWhiteSpace(data.characterName) ? "Frame Action Character" : data.characterName;
            root.layer = EnsureUnityLayer(settings.actorLayerName, "Player");
            RemoveManagedComponent<FrameActionEnemyBehaviorRunner2D>(root);
            RemoveManagedComponent<FrameActionEnemyMotor2D>(root);
            RemoveManagedComponent<FrameActionEnemyController2D>(root);
            RemoveManagedComponent<FrameActionEnemyRenderOrder2D>(root);
            Rigidbody2D body = GetOrAdd<Rigidbody2D>(root);
            body.bodyType = RigidbodyType2D.Dynamic;
            body.mass = Mathf.Max(0.01f, settings.rigidbodyMass);
            body.gravityScale = Mathf.Max(0f, data.motor?.gravityScale ?? 3f);
            body.constraints |= RigidbodyConstraints2D.FreezeRotation;
            body.interpolation = RigidbodyInterpolation2D.Interpolate;
            body.collisionDetectionMode = CollisionDetectionMode2D.Continuous;

            FrameActionPlayer player = GetOrAdd<FrameActionPlayer>(root);
            FrameActionController2D controller = GetOrAdd<FrameActionController2D>(root);
            FrameActionBuiltinEventHandler2D handler = GetOrAdd<FrameActionBuiltinEventHandler2D>(root);
            FrameActionMotor2D motor = GetOrAdd<FrameActionMotor2D>(root);
            FrameActionInputDriver2D input = GetOrAdd<FrameActionInputDriver2D>(root);
            FrameActionCameraFollow2D cameraFollow = GetOrAdd<FrameActionCameraFollow2D>(root);
            Collider2D bodyCollider = ConfigureBodyCollider(root, motor.bodyCollider, settings);
            FrameActionActorCollision2D actorCollision = GetOrAdd<FrameActionActorCollision2D>(root);
            ConfigureHurtbox(root, settings);
            SpriteRenderer renderer = ResolveRenderer(root, player);
            renderer.sortingOrder = PlayerSortingOrder;

            Sprite initialSprite = ResolveInitialSprite(data, characterAsset);
            if (renderer.sprite == null || initialSprite != null) renderer.sprite = initialSprite;

            player.characterAsset = characterAsset;
            player.spriteRenderer = renderer;
            player.visualRoot = renderer.transform;
            player.initialActionId = string.IsNullOrEmpty(data.groundIdleId) ? "ground-idle" : data.groundIdleId;
            player.playOnEnable = true;

            controller.player = player;
            controller.playIdleOnEnable = true;
            motor.player = player;
            motor.controller = controller;
            motor.body = body;
            motor.bodyCollider = bodyCollider;
            input.player = player;
            input.controller = controller;
            input.motor = motor;
            actorCollision.player = player;
            actorCollision.bodyCollider = bodyCollider;
            actorCollision.collideWithOtherActors = settings.collideWithOtherActors;
            handler.player = player;
            handler.ownerBody = body;
            handler.vfxSortingLayer = renderer.sortingLayerName;
            handler.vfxSortingOrder = PlayerVfxSortingOrder;
            handler.vfxBackSortingOrder = PlayerVfxBackSortingOrder;
            ConfigureCameraFollow(cameraFollow, root.transform, data.cameraFollow);
            handler.cameraReceiverBehaviour = cameraFollow;
        }

        private static void ConfigureCameraFollow(FrameActionCameraFollow2D cameraFollow, Transform target, FrameActionCameraFollowSettings settings)
        {
            settings = settings ?? new FrameActionCameraFollowSettings();
            cameraFollow.followTarget = target;
            cameraFollow.followHorizontal = settings.followHorizontal;
            cameraFollow.followVertical = settings.followVertical;
            cameraFollow.smoothTime = Mathf.Max(0f, settings.smoothTime);
            cameraFollow.followOffset = new Vector2(settings.offsetX, settings.offsetY);
            cameraFollow.orthographicSize = Mathf.Max(0.01f, settings.orthographicSize);
            cameraFollow.constrainToMap = settings.constrainToMap;
            cameraFollow.edgePaddingX = Mathf.Max(0f, settings.edgePaddingX);
            cameraFollow.edgePaddingY = Mathf.Max(0f, settings.edgePaddingY);
            cameraFollow.enabled = settings.enabled;
        }

        private static Collider2D ConfigureBodyCollider(GameObject root, Collider2D configured, FrameActionUnityCharacterSettings settings)
        {
            Collider2D current = configured != null && configured.gameObject == root
                ? configured
                : root.GetComponent<Collider2D>();
            Type desiredType = settings.colliderShape == "box" ? typeof(BoxCollider2D) : typeof(CapsuleCollider2D);
            if (current != null && current.GetType() != desiredType)
            {
                UnityEngine.Object.DestroyImmediate(current);
                current = null;
            }
            if (current == null) current = root.AddComponent(desiredType) as Collider2D;

            Vector2 size = new Vector2(Mathf.Max(0.01f, settings.colliderWidth), Mathf.Max(0.01f, settings.colliderHeight));
            Vector2 offset = new Vector2(settings.colliderOffsetX, settings.colliderOffsetY);
            if (current is BoxCollider2D box)
            {
                box.size = size;
                box.offset = offset;
            }
            else if (current is CapsuleCollider2D capsule)
            {
                capsule.direction = CapsuleDirection2D.Vertical;
                capsule.size = size;
                capsule.offset = offset;
            }
            return current;
        }

        private static FrameActionHurtbox2D ConfigureHurtbox(GameObject root, FrameActionUnityCharacterSettings settings)
        {
            FrameActionHurtbox2D hurtbox = root.GetComponentInChildren<FrameActionHurtbox2D>(true);
            if (hurtbox == null)
            {
                GameObject hurtboxObject = new GameObject("Frame Action Hurtbox");
                hurtboxObject.transform.SetParent(root.transform, false);
                hurtbox = hurtboxObject.AddComponent<FrameActionHurtbox2D>();
            }
            hurtbox.gameObject.layer = root.layer;

            Type desiredType = settings.hurtboxShape == "box" ? typeof(BoxCollider2D) : typeof(CapsuleCollider2D);
            Collider2D current = hurtbox.hurtboxCollider != null && hurtbox.hurtboxCollider.gameObject == hurtbox.gameObject
                ? hurtbox.hurtboxCollider
                : hurtbox.GetComponent<Collider2D>();
            if (current != null && current.GetType() != desiredType)
            {
                UnityEngine.Object.DestroyImmediate(current);
                current = null;
            }
            if (current == null) current = hurtbox.gameObject.AddComponent(desiredType) as Collider2D;

            Vector2 size = new Vector2(Mathf.Max(0.01f, settings.hurtboxWidth), Mathf.Max(0.01f, settings.hurtboxHeight));
            Vector2 offset = new Vector2(settings.hurtboxOffsetX, settings.hurtboxOffsetY);
            current.isTrigger = true;
            if (current is BoxCollider2D box)
            {
                box.size = size;
                box.offset = offset;
            }
            else if (current is CapsuleCollider2D capsule)
            {
                capsule.direction = CapsuleDirection2D.Vertical;
                capsule.size = size;
                capsule.offset = offset;
            }
            hurtbox.hurtboxCollider = current;
            return hurtbox;
        }

        private static SpriteRenderer ResolveRenderer(GameObject root, FrameActionPlayer player)
        {
            SpriteRenderer renderer = player.spriteRenderer;
            bool belongsToRoot = renderer != null && (renderer.transform == root.transform || renderer.transform.IsChildOf(root.transform));
            if (!belongsToRoot) renderer = null;
            if (renderer != null) return renderer;

            Transform visual = root.transform.Find("Visual");
            if (visual == null)
            {
                GameObject visualObject = new GameObject("Visual");
                visualObject.transform.SetParent(root.transform, false);
                visual = visualObject.transform;
            }
            renderer = visual.GetComponent<SpriteRenderer>();
            if (renderer == null) renderer = visual.gameObject.AddComponent<SpriteRenderer>();
            renderer.sortingOrder = PlayerSortingOrder;
            return renderer;
        }

        private static Sprite ResolveInitialSprite(FrameActionProjectData data, FrameActionCharacterAsset characterAsset)
        {
            FrameActionData initial = null;
            if (data.actions != null)
            {
                initial = data.actions.Find(action => action != null && action.id == data.groundIdleId)
                    ?? data.actions.Find(action => action?.segments != null && action.segments.Count > 0);
            }
            if (initial?.segments == null) return null;
            for (int segmentIndex = 0; segmentIndex < initial.segments.Count; segmentIndex++)
            {
                FrameActionSegmentData segment = initial.segments[segmentIndex];
                if (segment?.frames == null) continue;
                for (int frameIndex = 0; frameIndex < segment.frames.Count; frameIndex++)
                {
                    Sprite sprite = characterAsset.FindAsset<Sprite>(segment.frames[frameIndex]?.assetId);
                    if (sprite != null) return sprite;
                }
            }
            return null;
        }

        private static T GetOrAdd<T>(GameObject root) where T : Component
        {
            T component = root.GetComponent<T>();
            return component != null ? component : root.AddComponent<T>();
        }

        private static void RemoveManagedComponent<T>(GameObject root) where T : Component
        {
            T component = root.GetComponent<T>();
            if (component != null) UnityEngine.Object.DestroyImmediate(component);
        }

        private static string ResolvePrefabPath(string configuredPath, string outputFolder, string slug, string characterName)
        {
            string path = string.IsNullOrWhiteSpace(configuredPath)
                ? $"{outputFolder}/{SafeAssetName(characterName, slug)}.prefab"
                : configuredPath.Trim().Replace("\\", "/");
            if (!path.StartsWith("Assets/", StringComparison.Ordinal) || !path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) || path.Split('/').Length < 2 || path.Contains("../"))
            {
                throw new InvalidOperationException($"Character prefab path must be an Assets/*.prefab path: {path}");
            }
            return path;
        }

        private static string ResolveEnemyPrefabPath(string configuredPath, string outputFolder, string slug, string enemyName)
        {
            string path = string.IsNullOrWhiteSpace(configuredPath)
                ? $"{outputFolder}/{SafeAssetName(enemyName, slug)}.prefab"
                : configuredPath.Trim().Replace("\\", "/");
            if (!path.StartsWith("Assets/", StringComparison.Ordinal) || !path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) || path.Split('/').Length < 2 || path.Contains("../"))
            {
                throw new InvalidOperationException($"Enemy prefab path must be an Assets/*.prefab path: {path}");
            }
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
            for (int i = 1; i < parts.Length; i++)
            {
                string next = $"{current}/{parts[i]}";
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(current, parts[i]);
                current = next;
            }
        }

        private static int EnsureUnityLayer(string configuredName, string fallbackName)
        {
            string layerName = string.IsNullOrWhiteSpace(configuredName) ? fallbackName : configuredName.Trim();
            int existing = LayerMask.NameToLayer(layerName);
            if (existing >= 0) return existing;

            UnityEngine.Object[] assets = AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/TagManager.asset");
            if (assets == null || assets.Length == 0) throw new InvalidOperationException("Unable to load ProjectSettings/TagManager.asset.");
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
            throw new InvalidOperationException($"No empty Unity Layer slot is available for '{layerName}'.");
        }
    }
}
