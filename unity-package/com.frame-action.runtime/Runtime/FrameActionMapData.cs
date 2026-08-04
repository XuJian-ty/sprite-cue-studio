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
        public List<FrameActionMapMatterStrokeData> matterStrokes = new List<FrameActionMapMatterStrokeData>();
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
        public string elementTag;
        [Obsolete("Legacy load-only field. New rigid map objects persist elementTag.")]
        public string element = "fire";
        public float x;
        public float y;
        public float scale = 1f;
        public float rotation;
        public float z;
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
        public string element = "fire";
        public bool sideCollision = true;
        public float thickness;
        public bool closed;
        public List<FrameActionMapPoint> points = new List<FrameActionMapPoint>();
        public FrameActionMapProceduralRigidBodyData rigidBody;
        [Obsolete("Legacy load-only field. SpriteCue persists rigidBody.")]
        public FrameActionMapIceBodyData iceBody;
    }

    [Serializable]
    public sealed class FrameActionMapProceduralRigidBodyData
    {
        public int schemaVersion = 1;
        public string algorithm = "procedural-rigid-v1";
        public string templateId = "custom";
        public string elementTag;
        public uint seed = 1;
        public string closureMode = "manual";
        public List<string> edgeRoles = new List<string>();
        public FrameActionMapProceduralRigidTerrainBindingData terrainBinding;
        public FrameActionMapProceduralRigidVisualData visual = new FrameActionMapProceduralRigidVisualData();
        public FrameActionMapProceduralRigidPhysicalData physical = new FrameActionMapProceduralRigidPhysicalData();
        public FrameActionMapProceduralRigidFractureData fracture = new FrameActionMapProceduralRigidFractureData();
        public List<FrameActionMapProceduralRigidFacetData> facets = new List<FrameActionMapProceduralRigidFacetData>();
    }

    [Serializable]
    public sealed class FrameActionMapProceduralRigidTerrainBindingData
    {
        public string sourceId;
        public string sourceKind;
        public string route;
        public FrameActionMapPoint start;
        public FrameActionMapPoint end;
    }

    [Serializable]
    public sealed class FrameActionMapProceduralRigidVisualData
    {
        public string sourceMode = "procedural";
        public string templateId = "custom";
        public string baseColor = "#a0b5c2";
        public string shadowColor = "#384750";
        public string highlightColor = "#eefaff";
        public string edgeColor = "#c8e0eb";
        public string fractureColor;
        public float opacity = 1f;
        public float edgeJaggedness = 0.45f;
        public float facetScale = 28f;
        public float facetVariation = 0.55f;
        public float textureStrength = 0.65f;
        public float edgeBrightness = 0.85f;
        public float edgeWidthPixels = 2.5f;
        public float volumeDepth = 0.72f;
        public float transmission = 0.08f;
        public float absorption = 0.55f;
        public float roughness = 0.55f;
        public float specularStrength = 0.35f;
        public float inclusionDensity = 0.18f;
        public float microCrackDensity = 0.12f;
        public float grainDirectionDegrees;
        public float anisotropy;
        public float lightAngleDegrees = -35f;
    }

    [Serializable]
    public sealed class FrameActionMapProceduralRigidPhysicalData
    {
        public string anchoringMode = "dynamic";
        public float density = 1f;
        public float gravityScale = 1f;
        public float friction = 0.4f;
        public float restitution = 0.04f;
        public float linearDamping = 0.15f;
        public float angularDamping = 0.16f;
        public float hardness = 0.6f;
        public float toughness = 0.6f;
        public float brittleness = 0.5f;
        public float anisotropy;
        public float grainAngleDegrees;
        public float debrisFraction = 0.1f;
    }

    [Serializable]
    public sealed class FrameActionMapProceduralRigidFractureData
    {
        public int primaryFragmentMin = 2;
        public int primaryFragmentMax = 6;
        public int maxFragmentsPerImpact = 6;
        public int maxActiveFragmentsPerFamily = 32;
        public float minimumFragmentArea = 20f;
        public float minimumFragmentWidth = 3f;
        public int crackBranchMin = 1;
        public int crackBranchMax = 2;
        public int releaseDelayTicks = 2;
        public float impactChipEnergy = 10f;
        public float impactCrackEnergy = 35f;
        public float impactBreakEnergy = 120f;
        public float collisionBreakThreshold = 900f;
        public float landingChipEnergy = 70f;
        public float landingCrackEnergy = 240f;
        public float landingBreakEnergy = 850f;
        public float contactStressSensitivity = 0.45f;
        public int landingCooldownTicks = 6;
    }

    [Serializable]
    public sealed class FrameActionMapProceduralRigidFacetData
    {
        public int id;
        public List<FrameActionMapPoint> points = new List<FrameActionMapPoint>();
        [Range(0f, 1f)] public float shade;
    }

    [Serializable]
    public sealed class FrameActionMapIceBodyData
    {
        public int schemaVersion = 1;
        public string material = "iceRigid";
        public string algorithm = "procedural-ice-v1";
        public uint seed = 1;
        public string closureMode = "manual";
        public List<string> edgeRoles = new List<string>();
        public FrameActionMapIceTerrainBindingData terrainBinding;
        public FrameActionMapIceVisualData visual = new FrameActionMapIceVisualData();
        public FrameActionMapIceFractureData fracture = new FrameActionMapIceFractureData();
        public List<FrameActionMapIceFacetData> facets = new List<FrameActionMapIceFacetData>();
    }

    [Serializable]
    public sealed class FrameActionMapIceTerrainBindingData
    {
        public string sourceId;
        public string sourceKind;
        public string route;
        public FrameActionMapPoint start;
        public FrameActionMapPoint end;
    }

    [Serializable]
    public sealed class FrameActionMapIceVisualData
    {
        [Range(0f, 1f)] public float jaggedness = 0.45f;
        public float facetSize = 28f;
        [Range(0f, 1f)] public float facetVariation = 0.55f;
        [Range(0f, 1f)] public float textureStrength = 0.65f;
        [Range(0f, 1f)] public float edgeBrightness = 0.85f;
        [Range(0f, 1f)] public float volumeDepth = 0.78f;
        [Range(0f, 1f)] public float transmission = 0.72f;
        [Range(0f, 1f)] public float absorption = 0.52f;
        [Range(0f, 1f)] public float frostWidth = 0.68f;
        [Range(0f, 1f)] public float specularStrength = 0.82f;
        [Range(0f, 1f)] public float inclusionDensity = 0.34f;
        [Range(0f, 1f)] public float microCrackDensity = 0.22f;
        [Range(-180f, 180f)] public float lightAngleDegrees = 132f;
    }

    [Serializable]
    public sealed class FrameActionMapIceFractureData
    {
        public int primaryFragmentMin = 3;
        public int primaryFragmentMax = 8;
        public float minimumFragmentArea = 20f;
        public float minimumFragmentWidth = 3f;
        public int crackBranchMin = 1;
        public int crackBranchMax = 2;
        public int releaseDelayTicks = 2;
        public float impactChipEnergy;
        public float impactCrackEnergy;
        public float impactBreakEnergy;
        public float collisionBreakThreshold = 7f;
        public float landingChipEnergy = 1.5f;
        public float landingCrackEnergy = 4f;
        public float landingBreakEnergy = 9f;
        public float contactStressSensitivity = 1f;
        public int landingCooldownTicks = 6;
    }

    [Serializable]
    public sealed class FrameActionMapIceFacetData
    {
        public int id;
        public List<FrameActionMapPoint> points = new List<FrameActionMapPoint>();
        [Range(0f, 1f)] public float shade;
    }

    [Serializable]
    public sealed class FrameActionMapMatterStrokeData
    {
        public string id;
        public string carrier = "liquid";
        public string elementTag;
        [Obsolete("Legacy load-only field. New SpriteCue maps persist elementTag.")]
        public string element = "water";
        public FrameActionMapMatterAuthoringProfileData profile = new FrameActionMapMatterAuthoringProfileData();
        public float radius = 12f;
        public List<FrameActionMapPoint> points = new List<FrameActionMapPoint>();
    }

    [Serializable]
    public sealed class FrameActionMapMatterAuthoringProfileData
    {
        public int schemaVersion = 1;
        public FrameActionMapMatterVisualProfileData visual = new FrameActionMapMatterVisualProfileData();
        public FrameActionMapMatterPhysicalProfileData physical = new FrameActionMapMatterPhysicalProfileData();
    }

    [Serializable]
    public sealed class FrameActionMapMatterVisualProfileData
    {
        public string baseColor = "#44aee8";
        public string secondaryColor = "#44aee8";
        public string emissionColor = "#000000";
        public float opacity = 0.78f;
        public float particleScale = 1f;
        public float edgeSoftness = 0.28f;
        public float detailScale = 1f;
        public float refractionStrength = 0.12f;
        public float glowStrength;
        public float foamAmount = 0.08f;
    }

    [Serializable]
    public sealed class FrameActionMapMatterPhysicalProfileData
    {
        public float density = 1f;
        public float viscosity = 0.18f;
        public float surfaceTension = 0.34f;
        public float flowSpeed = 1f;
        public float gravityScale = 1f;
        public float diffusion = 0.02f;
        public float buoyancy;
        public float drag = 0.04f;
        public float evaporationHalfLifeSeconds = 1200f;
        public float dissipationHalfLifeSeconds;
    }

    [Serializable]
    public sealed class FrameActionMapPoint
    {
        public float x;
        public float y;
    }
}
