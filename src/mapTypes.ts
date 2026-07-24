export type MapLayer = "decoration" | "collision" | "occlusion";
export type MapMode = "select" | "pan" | "groundLine" | "collision" | "occlusion";
export type OutlinePrecision = "low" | "medium" | "high" | "ultra";
export type MapObjectMode = "static" | "dynamic";
export type MapObjectMotionDirection = "horizontal" | "vertical";

export interface MapObjectMotionData {
  direction: MapObjectMotionDirection;
  speedMetersPerSecond: number;
  rangeMeters: number;
  initialProgress: number;
  pingPong: boolean;
  endpointPauseSeconds: number;
  phaseSeconds: number;
}

export interface MapAssetRef {
  id: string;
  name: string;
  kind: "image";
  usage: "background" | "object";
  defaultLayer: MapLayer;
  url: string;
  dataUrl: string;
  width: number;
  height: number;
  outlines: MapOutlineData[];
  draftOutlines: MapOutlineData[];
}

export interface MapObjectData {
  id: string;
  assetId: string;
  layer: MapLayer;
  mode: MapObjectMode;
  collisionType: "solid" | "oneWay";
  motion: MapObjectMotionData;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  z: number;
  outlinePrecision: OutlinePrecision;
}

export interface MapPoint {
  x: number;
  y: number;
}

export interface MapOutlineData {
  id: string;
  layer: "collision" | "occlusion";
  shape: "polygon" | "groundLine";
  collisionType: "solid" | "oneWay" | "trigger";
  sideCollision: boolean;
  thickness: number;
  closed: boolean;
  points: MapPoint[];
}

export interface MapProject {
  format: "frame-action-map";
  version: 2;
  mapName: string;
  mapType: "side2d";
  width: number;
  height: number;
  pixelsPerUnit: number;
  backgroundAssetId: string;
  unityPrefabPath: string;
  objects: MapObjectData[];
  outlines: MapOutlineData[];
  draftOutlines: MapOutlineData[];
}

export function createMapProject(): MapProject {
  return {
    format: "frame-action-map",
    version: 2,
    mapName: "新地图",
    mapType: "side2d",
    width: 1024,
    height: 640,
    pixelsPerUnit: 100,
    backgroundAssetId: "",
    unityPrefabPath: "",
    objects: [],
    outlines: [],
    draftOutlines: [],
  };
}
