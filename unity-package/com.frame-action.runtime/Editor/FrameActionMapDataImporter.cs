using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using UnityEditor;
using UnityEngine;

namespace FrameAction.Editor
{
    [InitializeOnLoad]
    public static class FrameActionMapDataImporter
    {
        private const string SourceRoot = "Assets/FrameActionData/Maps";
        private const string PendingImportSessionKey = "FrameAction.PendingMapImports";

        static FrameActionMapDataImporter()
        {
            EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
            if (!EditorApplication.isPlayingOrWillChangePlaymode) EditorApplication.delayCall += ImportPendingAfterPlayMode;
        }

        [MenuItem("Tools/Frame Action/Import All Map Data")]
        public static void ImportAll()
        {
            string[] guids = AssetDatabase.FindAssets("t:TextAsset", new[] { SourceRoot });
            List<string> paths = new List<string>();
            for (int i = 0; i < guids.Length; i++)
            {
                string path = AssetDatabase.GUIDToAssetPath(guids[i]);
                if (path.EndsWith(".frame-action-map.json", StringComparison.OrdinalIgnoreCase)) paths.Add(path);
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
                Debug.Log($"[Frame Action] Deferred {paths.Count} map import(s) until Play Mode exits so live terrain colliders are not rebuilt.");
                return;
            }

            int imported = 0;
            foreach (string jsonPath in paths)
            {
                if (ImportOne(jsonPath)) imported += 1;
            }
            if (imported > 0) Debug.Log($"[Frame Action] Imported {imported} map data asset(s).");
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
            FrameActionMapProjectData data;
            try
            {
                data = JsonConvert.DeserializeObject<FrameActionMapProjectData>(source.text);
            }
            catch (Exception error)
            {
                Debug.LogError($"[Frame Action] Failed to parse map {jsonPath}: {error.Message}");
                return false;
            }
            if (data == null || data.format != "frame-action-map") return false;

            string sourceFolder = Path.GetDirectoryName(jsonPath)?.Replace("\\", "/") ?? SourceRoot;
            Dictionary<string, Sprite> sprites = new Dictionary<string, Sprite>(StringComparer.Ordinal);
            if (data.assets != null)
            {
                for (int i = 0; i < data.assets.Count; i++)
                {
                    FrameActionMapAssetEntry entry = data.assets[i];
                    if (entry == null || string.IsNullOrEmpty(entry.id) || string.IsNullOrEmpty(entry.path)) continue;
                    string assetPath = $"{sourceFolder}/{entry.path}".Replace("\\", "/");
                    ConfigureSprite(assetPath, data.pixelsPerUnit, entry.usage == "backgroundTile");
                    Sprite sprite = AssetDatabase.LoadAssetAtPath<Sprite>(assetPath);
                    if (sprite != null) sprites[entry.id] = sprite;
                }
            }

            string slug = Path.GetFileNameWithoutExtension(Path.GetFileNameWithoutExtension(jsonPath));
            try
            {
                FrameActionMapPrefabSynchronizer.Synchronize(data, source, sprites, slug);
            }
            catch (Exception error)
            {
                Debug.LogError($"[Frame Action] Map prefab synchronization failed: {error}");
                return false;
            }
            return true;
        }

        private static void ConfigureSprite(string assetPath, float pixelsPerUnit, bool losslessBackgroundTile)
        {
            TextureImporter importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (importer == null) return;
            float ppu = Mathf.Max(1f, pixelsPerUnit);
            TextureImporterSettings settings = new TextureImporterSettings();
            importer.ReadTextureSettings(settings);
            Vector2 pivot = new Vector2(0.5f, 0.5f);
            bool needsPhysicsShape = !losslessBackgroundTile;
            bool changed = importer.textureType != TextureImporterType.Sprite
                || importer.spriteImportMode != SpriteImportMode.Single
                || Mathf.Abs(importer.spritePixelsPerUnit - ppu) > 0.001f
                || settings.spriteAlignment != (int)SpriteAlignment.Custom
                || (settings.spritePivot - pivot).sqrMagnitude > 0.000001f
                || importer.mipmapEnabled
                || (needsPhysicsShape && (settings.spriteMeshType != SpriteMeshType.Tight
                    || !settings.spriteGenerateFallbackPhysicsShape))
                || (losslessBackgroundTile && (importer.maxTextureSize != 4096
                    || importer.textureCompression != TextureImporterCompression.Uncompressed
                    || importer.filterMode != FilterMode.Bilinear
                    || importer.wrapMode != TextureWrapMode.Clamp
                    || importer.npotScale != TextureImporterNPOTScale.None));
            if (!changed) return;
            importer.textureType = TextureImporterType.Sprite;
            settings.spriteAlignment = (int)SpriteAlignment.Custom;
            settings.spritePivot = pivot;
            if (needsPhysicsShape)
            {
                settings.spriteMeshType = SpriteMeshType.Tight;
                settings.spriteGenerateFallbackPhysicsShape = true;
            }
            importer.SetTextureSettings(settings);
            importer.spriteImportMode = SpriteImportMode.Single;
            importer.spritePixelsPerUnit = ppu;
            importer.alphaIsTransparency = true;
            importer.mipmapEnabled = false;
            if (losslessBackgroundTile)
            {
                importer.maxTextureSize = 4096;
                importer.textureCompression = TextureImporterCompression.Uncompressed;
                importer.filterMode = FilterMode.Bilinear;
                importer.wrapMode = TextureWrapMode.Clamp;
                importer.npotScale = TextureImporterNPOTScale.None;
            }
            importer.SaveAndReimport();
        }
    }
}
