using System;
using System.Collections.Generic;
using UnityEngine;

namespace FrameAction
{
    [CreateAssetMenu(menuName = "Frame Action/Character Asset", fileName = "FrameActionCharacter")]
    public sealed class FrameActionCharacterAsset : ScriptableObject
    {
        public TextAsset sourceJson;
        public string characterName;
        public string projectKind = "character";
        public List<FrameActionAssetBinding> bindings = new List<FrameActionAssetBinding>();

        public T FindAsset<T>(string assetId) where T : UnityEngine.Object
        {
            if (string.IsNullOrEmpty(assetId)) return null;
            for (int i = 0; i < bindings.Count; i++)
            {
                FrameActionAssetBinding binding = bindings[i];
                if (binding != null && binding.assetId == assetId) return binding.asset as T;
            }
            return null;
        }
    }

    [Serializable]
    public sealed class FrameActionAssetBinding
    {
        public string assetId;
        public string sourcePath;
        public UnityEngine.Object asset;
    }
}
