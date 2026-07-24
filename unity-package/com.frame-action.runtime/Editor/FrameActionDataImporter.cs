using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using UnityEditor;
using UnityEngine;

namespace FrameAction.Editor
{
    public sealed class FrameActionDataPostprocessor : AssetPostprocessor
    {
        private static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
        {
            List<string> changedData = new List<string>();
            List<string> changedMaps = new List<string>();
            for (int i = 0; i < imported.Length; i++)
            {
                if (imported[i].StartsWith("Assets/FrameActionData/", StringComparison.Ordinal) && imported[i].EndsWith(".frame-action.json", StringComparison.OrdinalIgnoreCase))
                {
                    changedData.Add(imported[i]);
                }
                else if (imported[i].StartsWith("Assets/FrameActionData/", StringComparison.Ordinal) && imported[i].EndsWith(".frame-action-map.json", StringComparison.OrdinalIgnoreCase))
                {
                    changedMaps.Add(imported[i]);
                }
            }
            if (changedData.Count > 0)
            {
                string[] queuedPaths = changedData.ToArray();
                EditorApplication.delayCall += () => FrameActionDataImporter.ImportPaths(queuedPaths);
            }
            if (changedMaps.Count > 0)
            {
                string[] queuedMapPaths = changedMaps.ToArray();
                EditorApplication.delayCall += () => FrameActionMapDataImporter.ImportPaths(queuedMapPaths);
            }
        }
    }

    [InitializeOnLoad]
    public static class FrameActionDataImporter
    {
        private const string SourceRoot = "Assets/FrameActionData/Characters";
        private const string GeneratedRoot = "Assets/FrameActionGenerated/Characters";
        private const string EnemySourceRoot = "Assets/FrameActionData/Enemies";
        private const string EnemyGeneratedRoot = "Assets/FrameActionGenerated/Enemies";
        private const string PendingImportSessionKey = "FrameAction.PendingCharacterImports";

        static FrameActionDataImporter()
        {
            EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
            if (!EditorApplication.isPlayingOrWillChangePlaymode) EditorApplication.delayCall += ImportPendingAfterPlayMode;
        }

        [MenuItem("Tools/Frame Action/Import All Character Data")]
        public static void ImportAll()
        {
            string[] guids = AssetDatabase.FindAssets("t:TextAsset", new[] { SourceRoot });
            List<string> paths = new List<string>();
            for (int i = 0; i < guids.Length; i++)
            {
                string path = AssetDatabase.GUIDToAssetPath(guids[i]);
                if (path.EndsWith(".frame-action.json", StringComparison.OrdinalIgnoreCase)) paths.Add(path);
            }
            ImportPaths(paths);
        }

        [MenuItem("Tools/Frame Action/Import All Enemy Data")]
        public static void ImportAllEnemies()
        {
            string[] guids = AssetDatabase.FindAssets("t:TextAsset", new[] { EnemySourceRoot });
            List<string> paths = new List<string>();
            for (int i = 0; i < guids.Length; i++)
            {
                string path = AssetDatabase.GUIDToAssetPath(guids[i]);
                if (path.EndsWith(".frame-action.json", StringComparison.OrdinalIgnoreCase)) paths.Add(path);
            }
            ImportPaths(paths);
        }

        public static void ImportPaths(IEnumerable<string> jsonPaths)
        {
            List<string> paths = NormalizePaths(jsonPaths);
            if (paths.Count == 0) return;
            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                QueuePending(paths);
                Debug.Log($"[Frame Action] Deferred {paths.Count} character import(s) until Play Mode exits so live actor colliders are not rebuilt.");
                return;
            }

            int importedCount = 0;
            foreach (string path in paths)
            {
                if (ImportOne(path)) importedCount += 1;
            }
            if (importedCount > 0) Debug.Log($"[Frame Action] Imported {importedCount} character data asset(s).");
        }

        private static List<string> NormalizePaths(IEnumerable<string> jsonPaths)
        {
            List<string> result = new List<string>();
            if (jsonPaths == null) return result;
            foreach (string path in jsonPaths)
            {
                if (!string.IsNullOrEmpty(path) && !result.Contains(path)) result.Add(path);
            }
            return result;
        }

        private static void QueuePending(IEnumerable<string> paths)
        {
            List<string> pending = NormalizePaths(SessionState.GetString(PendingImportSessionKey, string.Empty).Split('|'));
            foreach (string path in paths)
            {
                if (!pending.Contains(path)) pending.Add(path);
            }
            SessionState.SetString(PendingImportSessionKey, string.Join("|", pending));
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange state)
        {
            if (state == PlayModeStateChange.EnteredEditMode) EditorApplication.delayCall += ImportPendingAfterPlayMode;
        }

        private static void ImportPendingAfterPlayMode()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode) return;
            string serialized = SessionState.GetString(PendingImportSessionKey, string.Empty);
            if (string.IsNullOrEmpty(serialized)) return;
            SessionState.EraseString(PendingImportSessionKey);
            ImportPaths(serialized.Split('|'));
        }

        private static bool ImportOne(string jsonPath)
        {
            TextAsset source = AssetDatabase.LoadAssetAtPath<TextAsset>(jsonPath);
            if (source == null) return false;
            FrameActionProjectData data;
            try
            {
                data = JsonConvert.DeserializeObject<FrameActionProjectData>(source.text);
            }
            catch (Exception error)
            {
                Debug.LogError($"[Frame Action] Failed to parse {jsonPath}: {error.Message}");
                return false;
            }
            if (data == null || data.format != "frame-action-project") return false;

            bool isEnemy = string.Equals(data.projectKind, "enemy", StringComparison.OrdinalIgnoreCase);
            string sourceFolder = Path.GetDirectoryName(jsonPath)?.Replace("\\", "/") ?? (isEnemy ? EnemySourceRoot : SourceRoot);
            string slug = Path.GetFileNameWithoutExtension(Path.GetFileNameWithoutExtension(jsonPath));
            string generatedRoot = isEnemy ? EnemyGeneratedRoot : GeneratedRoot;
            EnsureFolder(generatedRoot);
            string outputFolder = $"{generatedRoot}/{slug}";
            EnsureFolder(outputFolder);
            string outputPath = $"{outputFolder}/{slug}.asset";
            FrameActionCharacterAsset asset = AssetDatabase.LoadAssetAtPath<FrameActionCharacterAsset>(outputPath);
            if (asset == null)
            {
                asset = ScriptableObject.CreateInstance<FrameActionCharacterAsset>();
                AssetDatabase.CreateAsset(asset, outputPath);
            }

            asset.sourceJson = source;
            asset.characterName = data.characterName;
            asset.projectKind = isEnemy ? "enemy" : "character";
            asset.bindings = new List<FrameActionAssetBinding>();
            if (data.assets != null)
            {
                for (int i = 0; i < data.assets.Count; i++)
                {
                    FrameAssetManifestEntry entry = data.assets[i];
                    if (entry == null || string.IsNullOrEmpty(entry.path)) continue;
                    string assetPath = $"{sourceFolder}/{entry.path}".Replace("\\", "/");
                    if (entry.kind == "image")
                    {
                        FrameActionSegmentData segment = FindSegment(data, entry.id);
                        float pixelsPerUnit = segment != null ? segment.pixelsPerUnit : data.pixelsPerUnit;
                        Vector2 pivot = entry.usage == "vfx"
                            ? new Vector2(0.5f, 0.5f)
                            : segment != null
                            ? new Vector2(
                                Mathf.Clamp01(segment.pivotX / Mathf.Max(1f, segment.cellWidth)),
                                Mathf.Clamp01(segment.pivotY / Mathf.Max(1f, segment.cellHeight)))
                            : new Vector2(0.5f, 0f);
                        ConfigureSprite(assetPath, pixelsPerUnit, pivot);
                    }
                    UnityEngine.Object referenced = entry.kind == "image"
                        ? AssetDatabase.LoadAssetAtPath<Sprite>(assetPath)
                        : AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(assetPath);
                    asset.bindings.Add(new FrameActionAssetBinding { assetId = entry.id, sourcePath = assetPath, asset = referenced });
                }
            }

            EditorUtility.SetDirty(asset);
            AssetDatabase.SaveAssets();
            try
            {
                if (isEnemy) FrameActionCharacterPrefabSynchronizer.SynchronizeEnemy(data, asset, outputFolder, slug);
                else FrameActionCharacterPrefabSynchronizer.Synchronize(data, asset, outputFolder, slug);
            }
            catch (Exception error)
            {
                Debug.LogError($"[Frame Action] Character data imported, but character prefab synchronization failed: {error}");
            }
            return true;
        }

        private static FrameActionSegmentData FindSegment(FrameActionProjectData data, string assetId)
        {
            if (data.actions == null || string.IsNullOrEmpty(assetId)) return null;
            for (int actionIndex = 0; actionIndex < data.actions.Count; actionIndex++)
            {
                FrameActionData action = data.actions[actionIndex];
                if (action?.segments == null) continue;
                for (int segmentIndex = 0; segmentIndex < action.segments.Count; segmentIndex++)
                {
                    FrameActionSegmentData segment = action.segments[segmentIndex];
                    if (segment == null) continue;
                    if (segment.spriteSheetAssetId == assetId) return segment;
                    if (segment.frames == null) continue;
                    for (int frameIndex = 0; frameIndex < segment.frames.Count; frameIndex++)
                    {
                        if (segment.frames[frameIndex]?.assetId == assetId) return segment;
                    }
                }
            }
            return null;
        }

        private static void ConfigureSprite(string assetPath, float pixelsPerUnit, Vector2 pivot)
        {
            TextureImporter importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (importer == null) return;
            float ppu = Mathf.Max(1f, pixelsPerUnit);
            TextureImporterSettings settings = new TextureImporterSettings();
            importer.ReadTextureSettings(settings);
            bool changed = importer.textureType != TextureImporterType.Sprite
                || importer.spriteImportMode != SpriteImportMode.Single
                || Mathf.Abs(importer.spritePixelsPerUnit - ppu) > 0.001f
                || settings.spriteAlignment != (int)SpriteAlignment.Custom
                || (settings.spritePivot - pivot).sqrMagnitude > 0.000001f
                || importer.mipmapEnabled;
            if (!changed) return;
            importer.textureType = TextureImporterType.Sprite;
            settings.spriteAlignment = (int)SpriteAlignment.Custom;
            settings.spritePivot = pivot;
            importer.SetTextureSettings(settings);
            // Set these after SetTextureSettings; the previously read settings can contain
            // Unity's default 100 PPU and Multiple mode and would otherwise restore them.
            importer.spriteImportMode = SpriteImportMode.Single;
            importer.spritePixelsPerUnit = ppu;
            importer.alphaIsTransparency = true;
            importer.mipmapEnabled = false;
            importer.SaveAndReimport();
        }

        private static void EnsureFolder(string assetPath)
        {
            string[] parts = assetPath.Split('/');
            string current = parts[0];
            for (int i = 1; i < parts.Length; i++)
            {
                string next = $"{current}/{parts[i]}";
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(current, parts[i]);
                current = next;
            }
        }
    }
}
