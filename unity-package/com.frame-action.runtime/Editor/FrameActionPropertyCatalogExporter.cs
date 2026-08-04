using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FrameAction;
using Newtonsoft.Json;
using UnityEditor;
using UnityEngine;

namespace FrameAction.Editor
{
    [InitializeOnLoad]
    internal static class FrameActionPropertyCatalogExporter
    {
        [Serializable]
        private sealed class Catalog
        {
            public int version = 1;
            public List<Entry> properties = new List<Entry>();
        }

        [Serializable]
        private sealed class Entry
        {
            public string id;
            public string displayName;
            public string category;
            public bool allowTemporary;
            public bool allowPermanent;
        }

        static FrameActionPropertyCatalogExporter()
        {
            EditorApplication.delayCall += Export;
        }

        [MenuItem("Tools/SpriteCue Studio/刷新可修改属性目录")]
        private static void ExportFromMenu()
        {
            Export();
            Debug.Log("[SpriteCue Studio] 已刷新可修改属性目录。");
        }

        private static void Export()
        {
            try
            {
                Dictionary<string, Entry> entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
                foreach (Type type in TypeCache.GetTypesWithAttribute<FrameActionPropertyAttribute>())
                {
                    foreach (FrameActionPropertyAttribute attribute in type
                        .GetCustomAttributes(typeof(FrameActionPropertyAttribute), true)
                        .OfType<FrameActionPropertyAttribute>())
                    {
                        string id = (attribute.Id ?? string.Empty).Trim();
                        if (string.IsNullOrEmpty(id)) continue;
                        Entry entry = new Entry
                        {
                            id = id,
                            displayName = string.IsNullOrWhiteSpace(attribute.DisplayName) ? id : attribute.DisplayName.Trim(),
                            category = string.IsNullOrWhiteSpace(attribute.Category) ? "其他" : attribute.Category.Trim(),
                            allowTemporary = attribute.AllowTemporary,
                            allowPermanent = attribute.AllowPermanent,
                        };
                        if (entries.TryGetValue(id, out Entry existing))
                        {
                            if (existing.displayName != entry.displayName || existing.category != entry.category ||
                                existing.allowTemporary != entry.allowTemporary || existing.allowPermanent != entry.allowPermanent)
                                Debug.LogWarning($"[SpriteCue Studio] 可修改属性 ID 重复且定义不一致：{id}（{type.FullName}）");
                            continue;
                        }
                        entries.Add(id, entry);
                    }
                }

                Catalog catalog = new Catalog
                {
                    properties = entries.Values
                        .OrderBy(item => item.category, StringComparer.Ordinal)
                        .ThenBy(item => item.displayName, StringComparer.Ordinal)
                        .ThenBy(item => item.id, StringComparer.Ordinal)
                        .ToList(),
                };
                string directory = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "Library", "FrameActionStudio"));
                string catalogPath = Path.Combine(directory, "property-catalog.json");
                string json = JsonConvert.SerializeObject(catalog, Formatting.Indented);
                Directory.CreateDirectory(directory);
                if (!File.Exists(catalogPath) || File.ReadAllText(catalogPath) != json)
                    File.WriteAllText(catalogPath, json);
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
            }
        }
    }
}
