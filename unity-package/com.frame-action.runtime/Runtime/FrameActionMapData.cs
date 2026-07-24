using System;
using System.Collections.Generic;
using UnityEngine;

namespace FrameAction
{
    [Serializable]
    public sealed class FrameActionMapProjectData
    {
        public string format;
        public int version;
        public string mapName;
        public string mapType;
        public int width;
        public int height;
        public float pixelsPerUnit = 100f;
        public string backgroundAssetId;
        public string unityPrefabPath;
        public List<FrameActionMapBackgroundTileData> backgroundTiles = new List<FrameActionMapBackgroundTileData>();
        public List<FrameActionMapAssetEntry> assets = new List<FrameActionMapAssetEntry>();
        public List<FrameActionMapObjectData> objects = new List<FrameActionMapObjectData>();
        public List<FrameActionMapOutlineData> outlines = new List<FrameActionMapOutlineData>();
    }

    [Serializable]
    public sealed class FrameActionMapBackgroundTileData
    {
        public string assetId;
        public float x;
        public float y;
        public float width;
        public float height;
    }

    [Serializable]
    public sealed class FrameActionMapAssetEntry
    {
        public string id;
        public string name;
        public string path;
        public string usage;
        public string defaultLayer;
        public int width;
        public int height;
        public List<FrameActionMapOutlineData> outlines = new List<FrameActionMapOutlineData>();
    }

    [Serializable]
    public sealed class FrameActionMapObjectData
    {
        public string id;
        public string assetId;
        public string layer;
        public string mode = "static";
        public string collisionType = "oneWay";
        public float x;
        public float y;
        public float scale = 1f;
        public float rotation;
        public float z;
        public string outlinePrecision = "medium";
        public FrameActionMapMotionData motion = new FrameActionMapMotionData();
    }

    [Serializable]
    public sealed class FrameActionMapMotionData
    {
        public string direction = "horizontal";
        public float speedMetersPerSecond = 2f;
        public float rangeMeters = 10f;
        [Range(0f, 1f)] public float initialProgress;
        public bool pingPong = true;
        public float endpointPauseSeconds;
        public float phaseSeconds;
    }

    [Serializable]
    public sealed class FrameActionMapOutlineData
    {
        public string id;
        public string layer;
        public string shape;
        public string collisionType;
        public bool sideCollision = true;
        public float thickness;
        public bool closed;
        public List<FrameActionMapPoint> points = new List<FrameActionMapPoint>();
    }

    [Serializable]
    public sealed class FrameActionMapPoint
    {
        public float x;
        public float y;
    }
}
