export type MapLayer = "decoration" | "collision" | "rigid" | "occlusion";
export type MapMode = "select" | "pan" | "groundLine" | "collision" | "rigid" | "iceBody" | "occlusion" | "liquid" | "gas";
export type MapElement = "fire" | "ice" | "water" | "wind" | "light" | "dark" | "thunder";
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
  elementTag: string;
  /** Legacy migration input. New rigid instances use elementTag or their asset template tag. */
  element?: MapElement;
  motion: MapObjectMotionData;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  z: number;
}

export interface MapPoint {
  x: number;
  y: number;
}

export type ProceduralRigidTemplateId = "iceCrystal" | "wood" | "metal" | "stone" | "custom";
export type ProceduralRigidClosureMode = "manual" | "terrain";
export type ProceduralRigidEdgeRole = "exposed" | "terrainAttached" | "fractureShared" | "generatedSeam";
export type ProceduralRigidTerrainSourceKind = "mapOutline" | "assetOutline";

export interface ProceduralRigidTerrainBindingData {
  sourceId: string;
  sourceKind: ProceduralRigidTerrainSourceKind;
  route: "forward" | "backward" | "open";
  start: MapPoint;
  end: MapPoint;
}

export interface ProceduralRigidVisualAuthoringData {
  [key: string]: unknown;
  templateId: ProceduralRigidTemplateId;
  sourceMode: "procedural" | "sourceImage";
  baseColor: string;
  shadowColor: string;
  highlightColor: string;
  edgeColor: string;
  /** Color used by explicit fracture cracks and released debris. */
  fractureColor: string;
  opacity: number;
  edgeJaggedness: number;
  facetScale: number;
  facetVariation: number;
  textureStrength: number;
  edgeBrightness: number;
  edgeWidthPixels: number;
  volumeDepth: number;
  transmission: number;
  absorption: number;
  roughness: number;
  specularStrength: number;
  inclusionDensity: number;
  microCrackDensity: number;
  grainDirectionDegrees: number;
  anisotropy: number;
  lightAngleDegrees: number;
}

export interface ProceduralRigidPhysicalAuthoringData {
  [key: string]: unknown;
  anchoringMode: "dynamic" | "fixed" | "terrainAttached";
  density: number;
  gravityScale: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  hardness: number;
  toughness: number;
  brittleness: number;
  anisotropy: number;
  grainAngleDegrees: number;
  debrisFraction: number;
}

export interface ProceduralRigidFractureAuthoringData {
  [key: string]: unknown;
  primaryFragmentMin: number;
  primaryFragmentMax: number;
  maxFragmentsPerImpact: number;
  maxActiveFragmentsPerFamily: number;
  minimumFragmentArea: number;
  minimumFragmentWidth: number;
  crackBranchMin: number;
  crackBranchMax: number;
  releaseDelayTicks: number;
  /** Gameplay/external-hit energy thresholds. Kept separate from SI-like landing energy. */
  impactChipEnergy: number;
  impactCrackEnergy: number;
  impactBreakEnergy: number;
  collisionBreakThreshold: number;
  landingChipEnergy: number;
  landingCrackEnergy: number;
  landingBreakEnergy: number;
  contactStressSensitivity: number;
  landingCooldownTicks: number;
}

export interface ProceduralRigidFacetData {
  id: number;
  points: [MapPoint, MapPoint, MapPoint];
  shade: number;
}

/**
 * Game-agnostic geometry authored by SpriteCue Studio. Element reactions deliberately do not
 * live here: each game decides how its ice responds to heat, liquids or other elements.
 */
export interface ProceduralRigidAuthoringData {
  [key: string]: unknown;
  schemaVersion: 1;
  algorithm: "procedural-rigid-v1";
  templateId: ProceduralRigidTemplateId;
  elementTag: string;
  seed: number;
  closureMode: ProceduralRigidClosureMode;
  /** Source stroke before deterministic edge treatment; used for repeatable re-editing. */
  authoringPoints?: MapPoint[];
  routePreference?: "shorter" | "alternate";
  edgeRoles: ProceduralRigidEdgeRole[];
  terrainBinding?: ProceduralRigidTerrainBindingData;
  visual: ProceduralRigidVisualAuthoringData;
  physical: ProceduralRigidPhysicalAuthoringData;
  fracture: ProceduralRigidFractureAuthoringData;
  facets: ProceduralRigidFacetData[];
}

/** @deprecated Internal migration aliases. New authoring code uses ProceduralRigid* names. */
export type IceBodyClosureMode = ProceduralRigidClosureMode;
/** @deprecated Internal migration aliases. New authoring code uses ProceduralRigid* names. */
export type IceBodyEdgeRole = ProceduralRigidEdgeRole;
/** @deprecated Internal migration aliases. New authoring code uses ProceduralRigid* names. */
export type IceBodyTerrainSourceKind = ProceduralRigidTerrainSourceKind;
/** @deprecated Internal migration aliases. New authoring code uses ProceduralRigid* names. */
export type IceBodyVisualAuthoringData = ProceduralRigidVisualAuthoringData;
/** @deprecated Internal migration aliases. New authoring code uses ProceduralRigid* names. */
export type IceBodyFractureAuthoringData = ProceduralRigidFractureAuthoringData;
/** @deprecated Internal migration aliases. New authoring code uses ProceduralRigid* names. */
export type IceBodyAuthoringData = ProceduralRigidAuthoringData;

export interface MapOutlineData {
  id: string;
  layer: "collision" | "rigid" | "occlusion";
  element: MapElement;
  shape: "polygon" | "groundLine";
  collisionType: "solid" | "oneWay" | "trigger";
  sideCollision: boolean;
  thickness: number;
  closed: boolean;
  points: MapPoint[];
  rigidBody?: ProceduralRigidAuthoringData;
  /** Legacy read-only migration input. Persistence must emit rigidBody only. */
  iceBody?: Record<string, unknown>;
}

export interface MapMatterStrokeData {
  id: string;
  carrier: "liquid" | "gas";
  /** Free-form identity. The consuming game maps this tag to its own chemistry/reactions. */
  elementTag: string;
  /** Legacy migration input. New documents persist elementTag. */
  element?: MapElement;
  profile: MapMatterAuthoringProfileData;
  radius: number;
  points: MapPoint[];
}

export interface MapMatterVisualProfileData {
  baseColor: string;
  secondaryColor: string;
  emissionColor: string;
  opacity: number;
  particleScale: number;
  edgeSoftness: number;
  detailScale: number;
  refractionStrength: number;
  glowStrength: number;
  foamAmount: number;
}

export interface MapMatterPhysicalProfileData {
  density: number;
  viscosity: number;
  surfaceTension: number;
  flowSpeed: number;
  gravityScale: number;
  diffusion: number;
  buoyancy: number;
  drag: number;
  evaporationHalfLifeSeconds: number;
  dissipationHalfLifeSeconds: number;
}

export interface MapMatterAuthoringProfileData {
  schemaVersion: 1;
  visual: MapMatterVisualProfileData;
  physical: MapMatterPhysicalProfileData;
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
  matterStrokes: MapMatterStrokeData[];
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
    matterStrokes: [],
  };
}
