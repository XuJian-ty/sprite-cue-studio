using UnityEngine;

namespace FrameAction
{
    public sealed class FrameActionMapMetadata : MonoBehaviour
    {
        public TextAsset sourceJson;
        public string mapName;
        public string mapType;
        public int width;
        public int height;
        public float pixelsPerUnit;
    }

}
