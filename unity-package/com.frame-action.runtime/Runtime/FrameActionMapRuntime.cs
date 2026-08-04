using System;
using UnityEngine;

namespace FrameAction
{
    public sealed class FrameActionMapMetadata : MonoBehaviour
    {
        public static event Action<FrameActionMapMetadata> Enabled;

        public TextAsset sourceJson;
        public string mapName;
        public string mapType;
        public int width;
        public int height;
        public float pixelsPerUnit;

        private void OnEnable()
        {
            Enabled?.Invoke(this);
        }
    }

}
