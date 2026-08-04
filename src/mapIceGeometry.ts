import type {
  IceBodyAuthoringData,
  IceBodyClosureMode,
  IceBodyEdgeRole,
  IceBodyFractureAuthoringData,
  IceBodyTerrainSourceKind,
  IceBodyVisualAuthoringData,
  MapAssetRef,
  MapOutlineData,
  MapPoint,
  MapProject,
  ProceduralRigidPhysicalAuthoringData,
  ProceduralRigidTemplateId,
} from "./mapTypes";

const EPSILON = 1e-5;
const MIN_ICE_BODY_AREA = 64;
const MAX_BOUNDARY_POINTS = 160;
// Full hand-authored jagged boundaries must remain part of the triangulation. A 160-point
// silhouette already needs 158 triangles before any interior crystal nuclei are inserted.
const MAX_FACETS = 320;

export type IceTerrainRoutePreference = "shorter" | "alternate";
export type ProceduralRigidTerrainRoutePreference = IceTerrainRoutePreference;

export interface IceTerrainContour {
  id: string;
  sourceKind: IceBodyTerrainSourceKind;
  points: MapPoint[];
  closed: boolean;
}

export interface IceBodyBuildOptions {
  id: string;
  userPoints: MapPoint[];
  closureMode: IceBodyClosureMode;
  terrainContours?: IceTerrainContour[];
  routePreference?: IceTerrainRoutePreference;
  seed: number;
  templateId?: ProceduralRigidTemplateId;
  elementTag?: string;
  visual: IceBodyVisualAuthoringData;
  physical?: ProceduralRigidPhysicalAuthoringData;
  fracture: IceBodyFractureAuthoringData;
  snapDistance?: number;
}

export interface IceBodyBuildCandidate {
  points: MapPoint[];
  rigidBody: IceBodyAuthoringData;
  terrainLength: number;
}

export interface IceBodyBuildResult {
  ok: boolean;
  message: string;
  points: MapPoint[];
  rigidBody?: IceBodyAuthoringData;
  candidates: IceBodyBuildCandidate[];
  selectedCandidateIndex: number;
}

/** Generic public names used by all procedural-rigid templates. Ice names remain load aliases. */
export type ProceduralRigidTerrainContour = IceTerrainContour;
export type ProceduralRigidBuildOptions = IceBodyBuildOptions;
export type ProceduralRigidBuildCandidate = IceBodyBuildCandidate;
export type ProceduralRigidBuildResult = IceBodyBuildResult;
export type ProceduralRigidFracturePreviewOptions = IceFracturePreviewOptions;
export type ProceduralRigidFracturePreviewResult = IceFracturePreviewResult;

export interface IceFracturePreviewOptions {
  points: MapPoint[];
  rigidBody: IceBodyAuthoringData;
  impactPoint: MapPoint;
  incomingDirection: MapPoint;
  energy01: number;
  seed?: number;
}

export interface IceFracturePreviewFragment {
  id: number;
  facetIds: number[];
  centroid: MapPoint;
  area: number;
  releaseOffset: MapPoint;
  linearVelocity: MapPoint;
  angularVelocityDegrees: number;
}

export interface IceFracturePreviewCrack {
  start: MapPoint;
  end: MapPoint;
  intensity: number;
}

export interface IceFracturePreviewResult {
  impactPoint: MapPoint;
  fragments: IceFracturePreviewFragment[];
  cracks: IceFracturePreviewCrack[];
}

interface TerrainAnchor {
  segmentIndex: number;
  distanceAlong: number;
  distance: number;
  point: MapPoint;
}

interface RawCandidate {
  points: MapPoint[];
  roles: IceBodyEdgeRole[];
  sourceId?: string;
  sourceKind?: IceBodyTerrainSourceKind;
  route?: "forward" | "backward" | "open";
  start?: MapPoint;
  end?: MapPoint;
  terrainLength: number;
}

interface Triangle {
  points: [MapPoint, MapPoint, MapPoint];
  key: number;
}

export const DEFAULT_ICE_BODY_VISUAL: IceBodyVisualAuthoringData = Object.freeze({
  templateId: "iceCrystal",
  sourceMode: "procedural",
  baseColor: "#69cbe8",
  shadowColor: "#173d73",
  highlightColor: "#e8fbff",
  edgeColor: "#b7f4ff",
  fractureColor: "#f4fdff",
  // In a 2D renderer, background alpha blending makes an ice body read as a flat ghost.
  // Keep authored ice coverage opaque by default; transmission/absorption provide the
  // glassy volume cues without leaking the level artwork through the body.
  opacity: 1,
  edgeJaggedness: 0.45,
  facetScale: 28,
  facetVariation: 0.55,
  textureStrength: 0.65,
  edgeBrightness: 0.85,
  edgeWidthPixels: 2.5,
  volumeDepth: 0.72,
  transmission: 0.58,
  absorption: 0.35,
  roughness: 0.24,
  specularStrength: 0.85,
  inclusionDensity: 0.18,
  microCrackDensity: 0.12,
  grainDirectionDegrees: -25,
  anisotropy: 0.35,
  lightAngleDegrees: -35,
});

export const DEFAULT_ICE_BODY_FRACTURE: IceBodyFractureAuthoringData = Object.freeze({
  primaryFragmentMin: 3,
  primaryFragmentMax: 8,
  maxFragmentsPerImpact: 8,
  maxActiveFragmentsPerFamily: 48,
  minimumFragmentArea: 20,
  minimumFragmentWidth: 3,
  crackBranchMin: 1,
  crackBranchMax: 2,
  releaseDelayTicks: 2,
  impactChipEnergy: 4,
  impactCrackEnergy: 12,
  impactBreakEnergy: 40,
  collisionBreakThreshold: 220,
  landingChipEnergy: 20,
  landingCrackEnergy: 60,
  landingBreakEnergy: 220,
  contactStressSensitivity: 0.85,
  landingCooldownTicks: 6,
});

export const DEFAULT_PROCEDURAL_RIGID_VISUAL = DEFAULT_ICE_BODY_VISUAL;
export const DEFAULT_PROCEDURAL_RIGID_FRACTURE = DEFAULT_ICE_BODY_FRACTURE;

export interface ProceduralRigidTemplateDefinition {
  id: ProceduralRigidTemplateId;
  label: string;
  defaultElementTag: string;
  visual: IceBodyVisualAuthoringData;
  physical: ProceduralRigidPhysicalAuthoringData;
  fracture: IceBodyFractureAuthoringData;
}

const makePhysical = (value: Record<string, number>): ProceduralRigidPhysicalAuthoringData => ({ anchoringMode: "dynamic", ...value } as ProceduralRigidPhysicalAuthoringData);
const makeVisual = (templateId: ProceduralRigidTemplateId, value: Partial<IceBodyVisualAuthoringData>): IceBodyVisualAuthoringData => ({ ...DEFAULT_ICE_BODY_VISUAL, ...value, templateId });
const makeFracture = (value: Partial<IceBodyFractureAuthoringData>): IceBodyFractureAuthoringData => ({ ...DEFAULT_ICE_BODY_FRACTURE, ...value });

/** Complete authoring defaults. templateId selects defaults only; elementTag remains editable data. */
export const PROCEDURAL_RIGID_TEMPLATES: Readonly<Record<ProceduralRigidTemplateId, ProceduralRigidTemplateDefinition>> = Object.freeze({
  iceCrystal: Object.freeze({
    id: "iceCrystal", label: "晶体冰", defaultElementTag: "冰",
    visual: Object.freeze(makeVisual("iceCrystal", {})),
    physical: Object.freeze(makePhysical({ density: 0.92, gravityScale: 1, friction: 0.12, restitution: 0.08, linearDamping: 0.12, angularDamping: 0.08, hardness: 0.68, toughness: 0.3, brittleness: 0.94, anisotropy: 0.35, grainAngleDegrees: -25, debrisFraction: 0.16 })),
    fracture: Object.freeze(makeFracture({})),
  }),
  wood: Object.freeze({
    id: "wood", label: "木材", defaultElementTag: "木",
    visual: Object.freeze(makeVisual("wood", { baseColor: "#9c5c2f", shadowColor: "#402315", highlightColor: "#e4ad6f", edgeColor: "#c8874e", fractureColor: "#f0c184", opacity: 1, edgeJaggedness: 0.28, facetScale: 34, transmission: 0, absorption: 0.72, roughness: 0.78, specularStrength: 0.12, inclusionDensity: 0.32, microCrackDensity: 0.18, grainDirectionDegrees: 0, anisotropy: 0.88 })),
    physical: Object.freeze(makePhysical({ density: 0.62, gravityScale: 1, friction: 0.48, restitution: 0.03, linearDamping: 0.16, angularDamping: 0.18, hardness: 0.46, toughness: 0.52, brittleness: 0.5, anisotropy: 0.88, grainAngleDegrees: 0, debrisFraction: 0.28 })),
    fracture: Object.freeze(makeFracture({ primaryFragmentMin: 2, primaryFragmentMax: 6, maxFragmentsPerImpact: 6, maxActiveFragmentsPerFamily: 36, impactChipEnergy: 8, impactCrackEnergy: 25, impactBreakEnergy: 90, collisionBreakThreshold: 420, landingChipEnergy: 30, landingCrackEnergy: 100, landingBreakEnergy: 360, contactStressSensitivity: 0.58 })),
  }),
  metal: Object.freeze({
    id: "metal", label: "金属", defaultElementTag: "铁",
    visual: Object.freeze(makeVisual("metal", { baseColor: "#7d8c99", shadowColor: "#27313a", highlightColor: "#e7f3fa", edgeColor: "#c5d4de", fractureColor: "#f1f7fb", opacity: 1, edgeJaggedness: 0.12, facetScale: 42, textureStrength: 0.38, edgeBrightness: 0.72, transmission: 0, absorption: 0.82, roughness: 0.3, specularStrength: 0.9, inclusionDensity: 0.08, microCrackDensity: 0.05, grainDirectionDegrees: 15, anisotropy: 0.22 })),
    physical: Object.freeze(makePhysical({ density: 7.8, gravityScale: 1, friction: 0.32, restitution: 0.02, linearDamping: 0.28, angularDamping: 0.4, hardness: 0.98, toughness: 0.96, brittleness: 0.08, anisotropy: 0.22, grainAngleDegrees: 15, debrisFraction: 0.02 })),
    fracture: Object.freeze(makeFracture({ primaryFragmentMin: 2, primaryFragmentMax: 4, maxFragmentsPerImpact: 4, maxActiveFragmentsPerFamily: 16, impactChipEnergy: 40, impactCrackEnergy: 180, impactBreakEnergy: 800, collisionBreakThreshold: 7500, landingChipEnergy: 250, landingCrackEnergy: 1400, landingBreakEnergy: 7000, contactStressSensitivity: 0.18 })),
  }),
  stone: Object.freeze({
    id: "stone", label: "岩石", defaultElementTag: "石",
    visual: Object.freeze(makeVisual("stone", { baseColor: "#737981", shadowColor: "#30343a", highlightColor: "#bbc2c9", edgeColor: "#969da5", fractureColor: "#d4d8dc", opacity: 1, edgeJaggedness: 0.58, facetScale: 30, textureStrength: 0.72, transmission: 0, absorption: 0.88, roughness: 0.9, specularStrength: 0.08, inclusionDensity: 0.48, microCrackDensity: 0.26, grainDirectionDegrees: 8, anisotropy: 0.15 })),
    physical: Object.freeze(makePhysical({ density: 2.4, gravityScale: 1, friction: 0.65, restitution: 0.01, linearDamping: 0.2, angularDamping: 0.22, hardness: 0.86, toughness: 0.6, brittleness: 0.62, anisotropy: 0.15, grainAngleDegrees: 8, debrisFraction: 0.12 })),
    fracture: Object.freeze(makeFracture({ primaryFragmentMin: 3, primaryFragmentMax: 7, maxFragmentsPerImpact: 7, maxActiveFragmentsPerFamily: 40, impactChipEnergy: 15, impactCrackEnergy: 50, impactBreakEnergy: 180, collisionBreakThreshold: 1100, landingChipEnergy: 90, landingCrackEnergy: 300, landingBreakEnergy: 1000, contactStressSensitivity: 0.52 })),
  }),
  custom: Object.freeze({
    id: "custom", label: "自定义", defaultElementTag: "",
    visual: Object.freeze(makeVisual("custom", { baseColor: "#a0b5c2", shadowColor: "#384750", highlightColor: "#eefaff", edgeColor: "#c8e0eb", fractureColor: "#e5edf1", opacity: 1, transmission: 0.08, absorption: 0.55, roughness: 0.55, specularStrength: 0.35, anisotropy: 0 })),
    physical: Object.freeze(makePhysical({ density: 1, gravityScale: 1, friction: 0.4, restitution: 0.04, linearDamping: 0.15, angularDamping: 0.16, hardness: 0.6, toughness: 0.6, brittleness: 0.5, anisotropy: 0, grainAngleDegrees: 0, debrisFraction: 0.1 })),
    fracture: Object.freeze(makeFracture({ primaryFragmentMin: 2, primaryFragmentMax: 6, maxFragmentsPerImpact: 6, maxActiveFragmentsPerFamily: 32, impactChipEnergy: 10, impactCrackEnergy: 35, impactBreakEnergy: 120, collisionBreakThreshold: 900, landingChipEnergy: 70, landingCrackEnergy: 240, landingBreakEnergy: 850, contactStressSensitivity: 0.45 })),
  }),
});

export function stableIceBodySeed(id: string, points: MapPoint[]): number {
  let hash = 0x811c9dc5;
  const mix = (value: number) => {
    hash ^= value | 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (let index = 0; index < id.length; index += 1) mix(id.charCodeAt(index));
  mix(points.length);
  for (const point of points) {
    mix(Math.round(point.x * 4));
    mix(Math.round(point.y * 4));
  }
  return normalizeSeed(hash);
}

export const stableProceduralRigidSeed = stableIceBodySeed;

export function isValidProgramRigidOutline(outline: MapOutlineData): boolean {
  const rigidBody = outline.rigidBody;
  if (!rigidBody
    || rigidBody.schemaVersion !== 1
    || rigidBody.algorithm !== "procedural-rigid-v1"
    || !PROCEDURAL_RIGID_TEMPLATES[rigidBody.templateId]
    || typeof rigidBody.elementTag !== "string"
    || (rigidBody.closureMode !== "manual" && rigidBody.closureMode !== "terrain")
    || !Array.isArray(rigidBody.edgeRoles)
    || rigidBody.edgeRoles.length !== outline.points.length
    || !Array.isArray(rigidBody.facets)
    || !rigidBody.facets.length
    || !rigidBody.visual
    || !rigidBody.physical
    || !rigidBody.fracture) return false;
  const visualNumbers = [
    rigidBody.visual.opacity,
    rigidBody.visual.edgeJaggedness,
    rigidBody.visual.facetScale,
    rigidBody.visual.facetVariation,
    rigidBody.visual.textureStrength,
    rigidBody.visual.edgeBrightness,
    rigidBody.visual.edgeWidthPixels,
    rigidBody.visual.volumeDepth,
    rigidBody.visual.transmission,
    rigidBody.visual.absorption,
    rigidBody.visual.roughness,
    rigidBody.visual.specularStrength,
    rigidBody.visual.inclusionDensity,
    rigidBody.visual.microCrackDensity,
    rigidBody.visual.grainDirectionDegrees,
    rigidBody.visual.anisotropy,
    rigidBody.visual.lightAngleDegrees,
  ];
  const physicalNumbers = [
    rigidBody.physical.density,
    rigidBody.physical.gravityScale,
    rigidBody.physical.friction,
    rigidBody.physical.restitution,
    rigidBody.physical.linearDamping,
    rigidBody.physical.angularDamping,
    rigidBody.physical.hardness,
    rigidBody.physical.toughness,
    rigidBody.physical.brittleness,
    rigidBody.physical.anisotropy,
    rigidBody.physical.grainAngleDegrees,
    rigidBody.physical.debrisFraction,
  ];
  const fractureNumbers = [
    rigidBody.fracture.primaryFragmentMin,
    rigidBody.fracture.primaryFragmentMax,
    rigidBody.fracture.maxFragmentsPerImpact,
    rigidBody.fracture.maxActiveFragmentsPerFamily,
    rigidBody.fracture.minimumFragmentArea,
    rigidBody.fracture.minimumFragmentWidth,
    rigidBody.fracture.crackBranchMin,
    rigidBody.fracture.crackBranchMax,
    rigidBody.fracture.releaseDelayTicks,
    rigidBody.fracture.impactChipEnergy,
    rigidBody.fracture.impactCrackEnergy,
    rigidBody.fracture.impactBreakEnergy,
    rigidBody.fracture.collisionBreakThreshold,
    rigidBody.fracture.landingChipEnergy,
    rigidBody.fracture.landingCrackEnergy,
    rigidBody.fracture.landingBreakEnergy,
    rigidBody.fracture.contactStressSensitivity,
    rigidBody.fracture.landingCooldownTicks,
  ];
  if (!visualNumbers.every(Number.isFinite) || !physicalNumbers.every(Number.isFinite) || !fractureNumbers.every(Number.isFinite)) return false;
  if (!["dynamic", "fixed", "terrainAttached"].includes(rigidBody.physical.anchoringMode)) return false;
  if (![rigidBody.visual.baseColor, rigidBody.visual.shadowColor, rigidBody.visual.highlightColor, rigidBody.visual.edgeColor, rigidBody.visual.fractureColor].every((value) => typeof value === "string" && value.length > 0)) return false;
  if (rigidBody.fracture.landingChipEnergy > rigidBody.fracture.landingCrackEnergy
    || rigidBody.fracture.landingCrackEnergy > rigidBody.fracture.landingBreakEnergy) return false;
  if (rigidBody.fracture.impactChipEnergy > rigidBody.fracture.impactCrackEnergy
    || rigidBody.fracture.impactCrackEnergy > rigidBody.fracture.impactBreakEnergy) return false;
  if (!outline.points.every(isFinitePoint)) return false;
  if (!rigidBody.edgeRoles.every((role) => role === "exposed" || role === "terrainAttached" || role === "fractureShared" || role === "generatedSeam")) return false;
  if (!rigidBody.facets.every((facet) => Number.isFinite(facet.id)
    && Number.isFinite(facet.shade)
    && Array.isArray(facet.points)
    && facet.points.length === 3
    && facet.points.every(isFinitePoint))) return false;
  return hasValidFacetTopology(outline.points, rigidBody.facets);
}

export const isValidProgramIceOutline = isValidProgramRigidOutline;

function templateFromLegacyElement(element: string): ProceduralRigidTemplateId {
  if (element === "ice") return "iceCrystal";
  if (element === "thunder") return "metal";
  if (element === "wind") return "wood";
  return "custom";
}

function suggestedElementTag(element: string, templateId: ProceduralRigidTemplateId): string {
  if (element && element !== "fire") return element;
  return PROCEDURAL_RIGID_TEMPLATES[templateId].defaultElementTag;
}

/**
 * Upgrades only committed map-level ice rigid polygons. Asset templates and open drafts
 * deliberately stay untouched; callers decide where the map/template boundary lives.
 */
export function ensureProgramIceOutline(outline: MapOutlineData): MapOutlineData {
  if (outline.layer !== "rigid"
    || outline.shape !== "polygon"
    || outline.closed !== true
    || outline.points.length < 3) return outline;
  if (isValidProgramRigidOutline(outline) && !outline.iceBody) return outline;
  const legacy = outline.iceBody as Record<string, unknown> | undefined;
  const previous = (outline.rigidBody || legacy) as Record<string, any> | undefined;
  const templateId = PROCEDURAL_RIGID_TEMPLATES[previous?.templateId as ProceduralRigidTemplateId]
    ? previous?.templateId as ProceduralRigidTemplateId
    : legacy ? "iceCrystal" : templateFromLegacyElement(outline.element);
  const template = PROCEDURAL_RIGID_TEMPLATES[templateId];
  if (previous && outline.points.every(isFinitePoint) && Math.abs(polygonArea(outline.points)) >= MIN_ICE_BODY_AREA) {
    const seed = normalizeSeed(previous.seed || stableIceBodySeed(outline.id, outline.points));
    const visual = normalizeVisual(previous.visual || template.visual, templateId);
    const physical = normalizePhysical(previous.physical || template.physical, template.physical, previous.closureMode === "terrain");
    const fracture = normalizeFracture(previous.fracture || template.fracture, template.fracture);
    const facets = buildFacets(outline.points, seed, visual);
    if (facets.length) {
      const edgeRoles = Array.isArray(previous.edgeRoles) && previous.edgeRoles.length === outline.points.length
        ? previous.edgeRoles.map((role) => role === "terrainAttached" || role === "fractureShared" || role === "generatedSeam" ? role : "exposed")
        : outline.points.map(() => "exposed" as IceBodyEdgeRole);
      const terrainBinding = previous.closureMode === "terrain" && previous.terrainBinding
        ? {
          ...previous.terrainBinding,
          start: clonePoint(previous.terrainBinding.start),
          end: clonePoint(previous.terrainBinding.end),
        }
        : undefined;
      const previousRecord = previous as Record<string, unknown>;
      const {
        schemaVersion: _oldSchemaVersion,
        algorithm: _oldAlgorithm,
        templateId: _oldTemplateId,
        elementTag: _oldElementTag,
        seed: _oldSeed,
        closureMode: _oldClosureMode,
        edgeRoles: _oldEdgeRoles,
        terrainBinding: _oldTerrainBinding,
        visual: _oldVisual,
        physical: _oldPhysical,
        fracture: _oldFracture,
        facets: _oldFacets,
        ...preservedBodyFields
      } = previousRecord;
      return {
        ...outline,
        iceBody: undefined,
        rigidBody: {
          ...preservedBodyFields,
          schemaVersion: 1,
          algorithm: "procedural-rigid-v1",
          templateId,
          elementTag: typeof previous.elementTag === "string" ? previous.elementTag : suggestedElementTag(outline.element, templateId),
          seed,
          closureMode: terrainBinding ? "terrain" : "manual",
          edgeRoles,
          ...(terrainBinding ? { terrainBinding } : {}),
          visual,
          physical,
          fracture,
          facets,
        },
      };
    }
  }
  const defaults = createIceBodyDefaults(stableIceBodySeed(outline.id, outline.points), templateId);
  const result = buildIceBody({
    id: outline.id,
    userPoints: outline.points,
    closureMode: "manual",
    ...defaults,
  });
  if (!result.ok || !result.rigidBody) return outline;
  return { ...outline, points: result.points, iceBody: undefined, rigidBody: result.rigidBody };
}

export const ensureProgramRigidOutline = ensureProgramIceOutline;

/**
 * Reusable image assets cannot depend on a particular map's terrain. Their procedural ice
 * outline is therefore always a complete, manually closed polygon. Legacy asset data that once
 * referenced terrain keeps its authored polygon, seed, facets and extension fields, while the
 * map-specific binding and edge roles are removed deterministically.
 */
export function ensureProgramIceAssetOutline(outline: MapOutlineData): MapOutlineData {
  const upgraded = ensureProgramIceOutline(outline);
  if (!upgraded.rigidBody) return upgraded;
  if (upgraded.rigidBody.closureMode === "manual"
    && !upgraded.rigidBody.terrainBinding
    && upgraded.rigidBody.physical.anchoringMode !== "terrainAttached"
    && upgraded.rigidBody.edgeRoles.every((role) => role !== "terrainAttached")) return upgraded;
  const { terrainBinding: _terrainBinding, ...rigidBody } = upgraded.rigidBody;
  return {
    ...upgraded,
    iceBody: undefined,
    rigidBody: {
      ...rigidBody,
      closureMode: "manual",
      edgeRoles: upgraded.points.map(() => "exposed" as IceBodyEdgeRole),
      physical: { ...rigidBody.physical, anchoringMode: "dynamic" },
    },
  };
}

export const ensureProgramRigidAssetOutline = ensureProgramIceAssetOutline;

/** Upgrades every committed and draft outline before it crosses a persistence boundary. */
export function ensureProgramIceProject(project: MapProject): MapProject {
  return {
    ...project,
    outlines: (project.outlines || []).map(ensureProgramIceOutline),
    draftOutlines: (project.draftOutlines || []).map(ensureProgramIceOutline),
  };
}

/** Applies the same guarantee to outlines authored inside reusable map image assets. */
export function ensureProgramIceAssets(assets: Record<string, MapAssetRef>): Record<string, MapAssetRef> {
  return Object.fromEntries(Object.entries(assets).map(([id, asset]) => [id, {
    ...asset,
    outlines: (asset.outlines || []).map(ensureProgramIceAssetOutline),
    draftOutlines: (asset.draftOutlines || []).map(ensureProgramIceAssetOutline),
  }]));
}

export const ensureProgramRigidProject = ensureProgramIceProject;
export const ensureProgramRigidAssets = ensureProgramIceAssets;

export function createIceBodyDefaults(seed = 1, templateId: ProceduralRigidTemplateId = "iceCrystal"): Pick<IceBodyBuildOptions, "seed" | "templateId" | "elementTag" | "visual" | "physical" | "fracture"> {
  const template = PROCEDURAL_RIGID_TEMPLATES[templateId];
  return {
    seed: normalizeSeed(seed),
    templateId,
    elementTag: template.defaultElementTag,
    visual: { ...template.visual },
    physical: { ...template.physical },
    fracture: { ...template.fracture },
  };
}

export const createProceduralRigidDefaults = createIceBodyDefaults;

export function buildIceBody(options: IceBodyBuildOptions): IceBodyBuildResult {
  const templateId = PROCEDURAL_RIGID_TEMPLATES[options.templateId || options.visual?.templateId]
    ? (options.templateId || options.visual.templateId)
    : "custom";
  const template = PROCEDURAL_RIGID_TEMPLATES[templateId];
  const userPoints = simplifyPolyline(options.userPoints, 0.75);
  if (userPoints.length < 3) return failure("至少画出三个有效点");

  const rawCandidates = options.closureMode === "terrain"
    ? buildTerrainCandidates(userPoints, options.terrainContours || [], Math.max(1, options.snapDistance ?? 14))
    : [{ points: userPoints, roles: userPoints.map(() => "exposed" as const), terrainLength: 0 }];

  if (!rawCandidates.length) {
    return failure(options.closureMode === "terrain"
      ? "起点和终点需要吸附到同一条已提交的实体地形轮廓"
      : "轮廓无法形成有效闭合区域");
  }

  const candidates: IceBodyBuildCandidate[] = [];
  let lastReason = "轮廓无效";
  for (const raw of rawCandidates) {
    // Dense freehand input may exceed the authored boundary budget. It is validated here,
    // then the exposed-chain resampler reduces it before the final bounded validation.
    const normalized = normalizePolygonWithRoles(raw.points, raw.roles, true, false);
    if (!normalized.ok) {
      lastReason = normalized.message;
      continue;
    }
    const jagged = applyExposedJaggedness(normalized.points, normalized.roles, options.seed, options.visual);
    const finalShape = normalizePolygonWithRoles(jagged.points, jagged.roles, false);
    if (!finalShape.ok) {
      lastReason = finalShape.message;
      continue;
    }
    const rigidBody: IceBodyAuthoringData = {
      schemaVersion: 1,
      algorithm: "procedural-rigid-v1",
      templateId,
      elementTag: typeof options.elementTag === "string" ? options.elementTag : template.defaultElementTag,
      seed: normalizeSeed(options.seed),
      closureMode: options.closureMode,
      authoringPoints: userPoints.map(clonePoint),
      routePreference: options.routePreference === "alternate" ? "alternate" : "shorter",
      edgeRoles: finalShape.roles,
      ...(raw.sourceId && raw.sourceKind && raw.route && raw.start && raw.end ? {
        terrainBinding: {
          sourceId: raw.sourceId,
          sourceKind: raw.sourceKind,
          route: raw.route,
          start: clonePoint(raw.start),
          end: clonePoint(raw.end),
        },
      } : {}),
      visual: normalizeVisual(options.visual, templateId),
      physical: normalizePhysical(options.physical || template.physical, template.physical, options.closureMode === "terrain"),
      fracture: normalizeFracture(options.fracture, template.fracture),
      facets: buildFacets(finalShape.points, options.seed, options.visual),
    };
    candidates.push({ points: finalShape.points, rigidBody, terrainLength: raw.terrainLength });
  }

  if (!candidates.length) return failure(lastReason);
  candidates.sort((a, b) => a.terrainLength - b.terrainLength || Math.abs(polygonArea(a.points)) - Math.abs(polygonArea(b.points)));
  const selectedCandidateIndex = options.routePreference === "alternate" && candidates.length > 1 ? 1 : 0;
  const selected = candidates[selectedCandidateIndex];
  return {
    ok: true,
    message: candidates.length > 1 ? `已找到 ${candidates.length} 条闭合路径` : "程序刚体轮廓有效",
    points: selected.points,
    rigidBody: selected.rigidBody,
    candidates,
    selectedCandidateIndex,
  };
}

export const buildProceduralRigidBody = buildIceBody;

/**
 * Editor-only structural preview. It partitions the already-authored crystal facets into
 * connected regions, so it does not prescribe heat, element reactions or a game runtime.
 */
export function buildIceFracturePreview(options: IceFracturePreviewOptions): IceFracturePreviewResult {
  const facets = options.rigidBody.facets;
  if (!facets.length) return { impactPoint: clonePoint(options.impactPoint), fragments: [], cracks: [] };
  const seed = normalizeSeed(options.seed ?? options.rigidBody.seed);
  const energy = clamp(Number(options.energy01) || 0, 0, 1);
  const incoming = normalizeVector(options.incomingDirection, { x: 1, y: 0 });
  const perpendicular = { x: -incoming.y, y: incoming.x };
  const centroids = facets.map((facet) => triangleCentroid(facet.points));
  const areas = facets.map((facet) => Math.max(0.001, triangleArea(facet.points)));
  const edgeMap = new Map<string, { facet: number; start: MapPoint; end: MapPoint }[]>();
  for (let facetIndex = 0; facetIndex < facets.length; facetIndex += 1) {
    const points = facets[facetIndex].points;
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
      const start = points[edgeIndex];
      const end = points[(edgeIndex + 1) % 3];
      const key = undirectedEdgeKey(start, end);
      const entries = edgeMap.get(key) || [];
      entries.push({ facet: facetIndex, start: clonePoint(start), end: clonePoint(end) });
      edgeMap.set(key, entries);
    }
  }
  const neighbors: { facet: number; start: MapPoint; end: MapPoint }[][] = facets.map(() => []);
  for (const entries of edgeMap.values()) {
    if (entries.length !== 2) continue;
    neighbors[entries[0].facet].push({ facet: entries[1].facet, start: entries[0].start, end: entries[0].end });
    neighbors[entries[1].facet].push({ facet: entries[0].facet, start: entries[1].start, end: entries[1].end });
  }

  const fracture = options.rigidBody.fracture;
  const minimumCount = clamp(Math.round(fracture.primaryFragmentMin), 2, 12);
  const maximumCount = clamp(Math.round(fracture.primaryFragmentMax), minimumCount, 16);
  const desiredCount = Math.max(1, Math.min(facets.length, minimumCount + Math.round((maximumCount - minimumCount) * energy)));
  const seeds: number[] = [];
  while (seeds.length < desiredCount) {
    let bestFacet = -1;
    const owner = seeds.length;
    if (owner < 3) {
      const side = owner === 0 ? 0 : owner === 1 ? 1 : -1;
      const depth = owner === 0 ? 0.28 : 0.56;
      const extent = Math.max(1, Math.sqrt(Math.abs(polygonArea(options.points))));
      const lateral = side * extent * (0.18 + hashUnit(seed, owner * 991 + 17) * 0.16);
      const target = {
        x: options.impactPoint.x + incoming.x * extent * depth + perpendicular.x * lateral,
        y: options.impactPoint.y + incoming.y * extent * depth + perpendicular.y * lateral,
      };
      let nearestScore = Number.POSITIVE_INFINITY;
      for (let index = 0; index < facets.length; index += 1) {
        if (seeds.includes(index)) continue;
        const score = pointDistance(centroids[index], target);
        if (score < nearestScore) {
          nearestScore = score;
          bestFacet = index;
        }
      }
    } else {
      let bestScore = -1;
      for (let index = 0; index < facets.length; index += 1) {
        if (seeds.includes(index)) continue;
        const minimumSeedDistance = Math.min(...seeds.map((seedIndex) => pointDistance(centroids[index], centroids[seedIndex])));
        const fromImpact = { x: centroids[index].x - options.impactPoint.x, y: centroids[index].y - options.impactPoint.y };
        const forward = Math.max(-1, Math.min(1, fromImpact.x * incoming.x + fromImpact.y * incoming.y));
        const lateral = Math.abs(fromImpact.x * perpendicular.x + fromImpact.y * perpendicular.y);
        const stressBias = 0.78 + Math.max(0, forward) * 0.12 + Math.min(0.28, lateral * 0.012);
        const score = minimumSeedDistance * stressBias * (0.9 + hashUnit(seed, index * 911 + owner * 37) * 0.2);
        if (score > bestScore) {
          bestScore = score;
          bestFacet = index;
        }
      }
    }
    if (bestFacet < 0) break;
    seeds.push(bestFacet);
  }

  const owners = facets.map(() => -1);
  const costs = facets.map(() => Number.POSITIVE_INFINITY);
  const queue: { facet: number; owner: number; cost: number }[] = [];
  seeds.forEach((facet, owner) => {
    owners[facet] = owner;
    costs[facet] = 0;
    queue.push({ facet, owner, cost: 0 });
  });
  while (queue.length) {
    queue.sort((left, right) => left.cost - right.cost || left.owner - right.owner || left.facet - right.facet);
    const current = queue.shift();
    if (!current || current.cost > costs[current.facet] + EPSILON || owners[current.facet] !== current.owner) continue;
    for (const neighbor of neighbors[current.facet]) {
      const delta = normalizeVector({ x: centroids[neighbor.facet].x - centroids[current.facet].x, y: centroids[neighbor.facet].y - centroids[current.facet].y }, incoming);
      const alongImpact = Math.abs(delta.x * incoming.x + delta.y * incoming.y);
      const directionCost = 0.72 + (1 - alongImpact) * (0.58 + energy * 0.32);
      const noise = 0.84 + hashUnit(seed, current.facet * 4099 + neighbor.facet * 131 + current.owner * 17) * 0.34;
      const nextCost = current.cost + pointDistance(centroids[current.facet], centroids[neighbor.facet]) * directionCost * noise;
      if (nextCost < costs[neighbor.facet] - EPSILON || (Math.abs(nextCost - costs[neighbor.facet]) <= EPSILON && current.owner < owners[neighbor.facet])) {
        costs[neighbor.facet] = nextCost;
        owners[neighbor.facet] = current.owner;
        queue.push({ facet: neighbor.facet, owner: current.owner, cost: nextCost });
      }
    }
  }
  for (let index = 0; index < owners.length; index += 1) {
    if (owners[index] >= 0) continue;
    let nearestOwner = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    seeds.forEach((seedFacet, owner) => {
      const distance = pointDistance(centroids[index], centroids[seedFacet]);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestOwner = owner;
      }
    });
    owners[index] = nearestOwner;
  }

  const fragments: IceFracturePreviewFragment[] = [];
  for (let owner = 0; owner < seeds.length; owner += 1) {
    const facetIndices = owners.map((value, index) => value === owner ? index : -1).filter((index) => index >= 0);
    if (!facetIndices.length) continue;
    const area = facetIndices.reduce((sum, index) => sum + areas[index], 0);
    const centroid = facetIndices.reduce((sum, index) => ({ x: sum.x + centroids[index].x * areas[index], y: sum.y + centroids[index].y * areas[index] }), { x: 0, y: 0 });
    centroid.x /= area;
    centroid.y /= area;
    const radial = normalizeVector({ x: centroid.x - options.impactPoint.x, y: centroid.y - options.impactPoint.y }, perpendicular);
    const direction = normalizeVector({ x: radial.x * 0.72 + incoming.x * 0.48, y: radial.y * 0.72 + incoming.y * 0.48 }, incoming);
    const speed = (3.5 + energy * 10) * (0.78 + hashUnit(seed, owner * 733 + 71) * 0.44);
    fragments.push({
      id: owner + 1,
      facetIds: facetIndices.map((index) => facets[index].id),
      centroid,
      area,
      releaseOffset: { x: direction.x * (2 + energy * 8), y: direction.y * (2 + energy * 8) },
      linearVelocity: { x: direction.x * speed, y: direction.y * speed },
      angularVelocityDegrees: (hashUnit(seed, owner * 1291 + 193) * 2 - 1) * (70 + energy * 260),
    });
  }
  const cracks: IceFracturePreviewCrack[] = [];
  for (const entries of edgeMap.values()) {
    if (entries.length !== 2 || owners[entries[0].facet] === owners[entries[1].facet]) continue;
    const midpoint = { x: (entries[0].start.x + entries[0].end.x) * 0.5, y: (entries[0].start.y + entries[0].end.y) * 0.5 };
    const distance = pointDistance(midpoint, options.impactPoint);
    cracks.push({
      start: entries[0].start,
      end: entries[0].end,
      intensity: clamp(0.35 + energy * 0.65 - distance / Math.max(40, Math.sqrt(Math.abs(polygonArea(options.points))) * 3), 0.2, 1),
    });
  }
  return { impactPoint: clonePoint(options.impactPoint), fragments, cracks };
}

function failure(message: string): IceBodyBuildResult {
  return { ok: false, message, points: [], candidates: [], selectedCandidateIndex: 0 };
}

function buildTerrainCandidates(userPoints: MapPoint[], contours: IceTerrainContour[], snapDistance: number): RawCandidate[] {
  const start = userPoints[0];
  const end = userPoints[userPoints.length - 1];
  let best: { contour: IceTerrainContour; points: MapPoint[]; start: TerrainAnchor; end: TerrainAnchor; score: number } | null = null;

  for (const contour of contours) {
    const points = simplifyPolyline(contour.points, 0.05);
    if (points.length < 2) continue;
    const startAnchor = projectToContour(start, points, contour.closed);
    const endAnchor = projectToContour(end, points, contour.closed);
    if (!startAnchor || !endAnchor || startAnchor.distance > snapDistance || endAnchor.distance > snapDistance) continue;
    if (pointDistance(startAnchor.point, endAnchor.point) < 2) continue;
    const score = startAnchor.distance + endAnchor.distance;
    if (!best || score < best.score - EPSILON || (Math.abs(score - best.score) < EPSILON && contour.id < best.contour.id)) {
      best = { contour, points, start: startAnchor, end: endAnchor, score };
    }
  }

  if (!best) return [];
  const snappedUser = userPoints.map(clonePoint);
  snappedUser[0] = clonePoint(best.start.point);
  snappedUser[snappedUser.length - 1] = clonePoint(best.end.point);
  const routes = best.contour.closed
    ? [
      { route: "forward" as const, ...pathAlongContour(best.points, true, best.end, best.start, 1) },
      { route: "backward" as const, ...pathAlongContour(best.points, true, best.end, best.start, -1) },
    ]
    : [{ route: "open" as const, ...pathAlongContour(best.points, false, best.end, best.start, best.end.distanceAlong <= best.start.distanceAlong ? 1 : -1) }];

  const results: RawCandidate[] = [];
  for (const route of routes) {
    if (route.points.length < 2 || route.length < 2) continue;
    const combined = [...snappedUser, ...route.points.slice(1, -1).map(clonePoint)];
    const exposedCount = snappedUser.length - 1;
    const terrainCount = route.points.length - 1;
    const roles: IceBodyEdgeRole[] = [
      ...Array.from({ length: exposedCount }, () => "exposed" as const),
      ...Array.from({ length: terrainCount }, () => "terrainAttached" as const),
    ];
    results.push({
      points: combined,
      roles,
      sourceId: best.contour.id,
      sourceKind: best.contour.sourceKind,
      route: route.route,
      start: best.start.point,
      end: best.end.point,
      terrainLength: route.length,
    });
  }
  return results;
}

function projectToContour(point: MapPoint, points: MapPoint[], closed: boolean): TerrainAnchor | null {
  const segmentCount = closed ? points.length : points.length - 1;
  const cumulative = contourCumulative(points, closed);
  let best: TerrainAnchor | null = null;
  for (let index = 0; index < segmentCount; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < EPSILON) continue;
    const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
    const projected = { x: a.x + dx * t, y: a.y + dy * t };
    const distance = pointDistance(point, projected);
    const distanceAlong = cumulative[index] + Math.sqrt(lengthSquared) * t;
    if (!best || distance < best.distance - EPSILON || (Math.abs(distance - best.distance) < EPSILON && index < best.segmentIndex)) {
      // Terrain anchors remain byte-for-byte on the authored collision segment. Visual edge
      // quantization is deliberately restricted to exposed ice edges.
      best = { segmentIndex: index, distanceAlong, distance, point: projected };
    }
  }
  return best;
}

function contourCumulative(points: MapPoint[], closed: boolean): number[] {
  const result = [0];
  const segmentCount = closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    result.push(result[index] + pointDistance(points[index], points[(index + 1) % points.length]));
  }
  return result;
}

function pathAlongContour(points: MapPoint[], closed: boolean, from: TerrainAnchor, to: TerrainAnchor, direction: 1 | -1): { points: MapPoint[]; length: number } {
  if (direction === -1) {
    const reverse = pathAlongContour(points, closed, to, from, 1);
    return { points: reverse.points.slice().reverse(), length: reverse.length };
  }
  const cumulative = contourCumulative(points, closed);
  const total = cumulative[cumulative.length - 1];
  if (total < EPSILON) return { points: [], length: 0 };
  if (!closed && from.distanceAlong > to.distanceAlong + EPSILON) return { points: [], length: 0 };
  const target = closed && to.distanceAlong < from.distanceAlong ? to.distanceAlong + total : to.distanceAlong;
  const route = [clonePoint(from.point)];
  const interiorVertices: { value: number; point: MapPoint }[] = [];
  for (let vertexIndex = 1; vertexIndex < cumulative.length; vertexIndex += 1) {
    let value = cumulative[vertexIndex];
    if (closed && value <= from.distanceAlong + EPSILON) value += total;
    if (value > from.distanceAlong + EPSILON && value < target - EPSILON) {
      interiorVertices.push({ value, point: points[vertexIndex % points.length] });
    }
  }
  interiorVertices.sort((a, b) => a.value - b.value);
  interiorVertices.forEach((item) => route.push(clonePoint(item.point)));
  route.push(clonePoint(to.point));
  return { points: route, length: Math.max(0, target - from.distanceAlong) };
}

function normalizePolygonWithRoles(points: MapPoint[], roles: IceBodyEdgeRole[], simplify = true, enforcePointLimit = true): { ok: true; points: MapPoint[]; roles: IceBodyEdgeRole[]; message: string } | { ok: false; points: MapPoint[]; roles: IceBodyEdgeRole[]; message: string } {
  if (points.length !== roles.length) return { ok: false, points: [], roles: [], message: "边分类与轮廓点数量不一致" };
  let cleanPoints = points.map(clonePoint);
  let cleanRoles = roles.slice();
  if (pointDistance(cleanPoints[0], cleanPoints[cleanPoints.length - 1]) < 0.25) {
    cleanPoints.pop();
    cleanRoles.pop();
  }
  ({ points: cleanPoints, roles: cleanRoles } = removeShortPolygonEdges(cleanPoints, cleanRoles, simplify ? 0.35 : 0.1));
  if (cleanPoints.length < 3) return { ok: false, points: [], roles: [], message: "闭合区域有效点不足" };
  if (enforcePointLimit && cleanPoints.length > MAX_BOUNDARY_POINTS) return { ok: false, points: [], roles: [], message: `轮廓点过多（上限 ${MAX_BOUNDARY_POINTS}）` };
  const area = polygonArea(cleanPoints);
  if (Math.abs(area) < MIN_ICE_BODY_AREA) return { ok: false, points: [], roles: [], message: `闭合区域过小（至少 ${MIN_ICE_BODY_AREA}px²）` };
  if (polygonSelfIntersects(cleanPoints)) return { ok: false, points: [], roles: [], message: "闭合轮廓发生自交" };
  if (area < 0) ({ points: cleanPoints, roles: cleanRoles } = reversePolygonWithRoles(cleanPoints, cleanRoles));
  ({ points: cleanPoints, roles: cleanRoles } = rotatePolygonToCanonicalStart(cleanPoints, cleanRoles));
  return { ok: true, points: cleanPoints, roles: cleanRoles, message: "有效" };
}

function removeShortPolygonEdges(points: MapPoint[], roles: IceBodyEdgeRole[], minimumLength: number): { points: MapPoint[]; roles: IceBodyEdgeRole[] } {
  const cleanPoints: MapPoint[] = [];
  const cleanRoles: IceBodyEdgeRole[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (!cleanPoints.length) {
      cleanPoints.push(clonePoint(point));
      cleanRoles.push(roles[index] || "exposed");
      continue;
    }
    if (pointDistance(cleanPoints[cleanPoints.length - 1], point) < minimumLength) {
      if (roles[index] === "terrainAttached") cleanRoles[cleanRoles.length - 1] = "terrainAttached";
      continue;
    }
    cleanPoints.push(clonePoint(point));
    cleanRoles.push(roles[index] || "exposed");
  }
  if (cleanPoints.length > 2 && pointDistance(cleanPoints[0], cleanPoints[cleanPoints.length - 1]) < minimumLength) {
    cleanPoints.pop();
    const closingRole = cleanRoles.pop();
    if (closingRole === "terrainAttached") cleanRoles[cleanRoles.length - 1] = "terrainAttached";
  }
  while (cleanRoles.length > cleanPoints.length) cleanRoles.pop();
  while (cleanRoles.length < cleanPoints.length) cleanRoles.push("exposed");
  return { points: cleanPoints, roles: cleanRoles };
}

function reversePolygonWithRoles(points: MapPoint[], roles: IceBodyEdgeRole[]): { points: MapPoint[]; roles: IceBodyEdgeRole[] } {
  const count = points.length;
  const reversedPoints = points.slice().reverse();
  const reversedRoles = Array.from({ length: count }, (_, index) => roles[(count - 2 - index + count) % count]);
  return { points: reversedPoints, roles: reversedRoles };
}

function rotatePolygonToCanonicalStart(points: MapPoint[], roles: IceBodyEdgeRole[]): { points: MapPoint[]; roles: IceBodyEdgeRole[] } {
  let start = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].x < points[start].x - EPSILON || (Math.abs(points[index].x - points[start].x) < EPSILON && points[index].y < points[start].y)) start = index;
  }
  return {
    points: [...points.slice(start), ...points.slice(0, start)],
    roles: [...roles.slice(start), ...roles.slice(0, start)],
  };
}

function applyExposedJaggedness(points: MapPoint[], roles: IceBodyEdgeRole[], seed: number, visual: IceBodyVisualAuthoringData): { points: MapPoint[]; roles: IceBodyEdgeRole[] } {
  const normalizedVisual = normalizeVisual(visual);
  if (normalizedVisual.edgeJaggedness <= EPSILON) return { points: points.map(clonePoint), roles: roles.slice() };
  const spacing = clamp(normalizedVisual.facetScale * 0.42, 6, 24);
  for (const scale of [1, 0.5, 0]) {
    const candidate = roles.every((role) => role === "exposed")
      ? resampleClosedExposedLoop(points, seed, spacing, normalizedVisual.edgeJaggedness, scale)
      : resampleMixedBoundary(points, roles, seed, spacing, normalizedVisual.edgeJaggedness, scale);
    const candidatePoints = candidate.points;
    const candidateRoles = candidate.roles;
    if (candidatePoints.length <= MAX_BOUNDARY_POINTS && !polygonSelfIntersects(candidatePoints) && Math.abs(polygonArea(candidatePoints)) >= MIN_ICE_BODY_AREA) {
      return { points: candidatePoints, roles: candidateRoles };
    }
  }
  return { points: points.map(clonePoint), roles: roles.slice() };
}

function resampleClosedExposedLoop(points: MapPoint[], seed: number, spacing: number, jaggedness: number, scale: number): { points: MapPoint[]; roles: IceBodyEdgeRole[] } {
  const closed = [...points.map(clonePoint), clonePoint(points[0])];
  const totalLength = polylineLength(closed);
  if (totalLength <= EPSILON) return { points: points.map(clonePoint), roles: points.map(() => "exposed") };
  const sampleCount = Math.max(3, Math.min(MAX_BOUNDARY_POINTS, Math.round(totalLength / spacing)));
  const actualSpacing = totalLength / sampleCount;
  const sampled: MapPoint[] = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const sample = samplePolyline(closed, actualSpacing * sampleIndex);
    if (sampleIndex === 0 || scale <= EPSILON) {
      sampled.push(sampleIndex === 0 ? clonePoint(points[0]) : quantizePoint(sample.point));
      continue;
    }
    sampled.push(jaggedSample(sample, seed, sampleIndex, actualSpacing, jaggedness, scale, 1));
  }
  return { points: sampled, roles: sampled.map(() => "exposed") };
}

function resampleMixedBoundary(points: MapPoint[], roles: IceBodyEdgeRole[], seed: number, spacing: number, jaggedness: number, scale: number): { points: MapPoint[]; roles: IceBodyEdgeRole[] } {
  const count = points.length;
  const start = roles.findIndex((role, index) => role === "exposed" && roles[(index - 1 + count) % count] !== "exposed");
  if (start < 0) return { points: points.map(clonePoint), roles: roles.slice() };
  const candidatePoints: MapPoint[] = [clonePoint(points[start])];
  const candidateRoles: IceBodyEdgeRole[] = [];
  let edgeIndex = start;
  let processed = 0;
  let chainIndex = 0;
  while (processed < count) {
    const role = roles[edgeIndex];
    const chainPoints: MapPoint[] = [clonePoint(points[edgeIndex])];
    const chainStartEdge = edgeIndex;
    while (processed < count && roles[edgeIndex] === role) {
      edgeIndex = (edgeIndex + 1) % count;
      processed += 1;
      chainPoints.push(clonePoint(points[edgeIndex]));
    }
    const samples = role === "exposed"
      ? resampleOpenExposedChain(chainPoints, seed, spacing, jaggedness, scale, chainStartEdge * 4099 + chainIndex * 131)
      : chainPoints;
    for (let index = 1; index < samples.length; index += 1) {
      candidateRoles.push(role);
      candidatePoints.push(samples[index]);
    }
    chainIndex += 1;
  }
  candidatePoints.pop();
  return { points: candidatePoints, roles: candidateRoles };
}

function resampleOpenExposedChain(points: MapPoint[], seed: number, spacing: number, jaggedness: number, scale: number, keyBase: number): MapPoint[] {
  const totalLength = polylineLength(points);
  if (totalLength <= EPSILON) return points.map(clonePoint);
  const segmentCount = Math.max(1, Math.min(MAX_BOUNDARY_POINTS - 1, Math.ceil(totalLength / spacing)));
  const actualSpacing = totalLength / segmentCount;
  const sampled: MapPoint[] = [clonePoint(points[0])];
  for (let sampleIndex = 1; sampleIndex < segmentCount; sampleIndex += 1) {
    const t = sampleIndex / segmentCount;
    const sample = samplePolyline(points, actualSpacing * sampleIndex);
    sampled.push(scale <= EPSILON
      ? quantizePoint(sample.point)
      : jaggedSample(sample, seed, keyBase + sampleIndex, actualSpacing, jaggedness, scale, Math.sin(Math.PI * t)));
  }
  sampled.push(clonePoint(points[points.length - 1]));
  return sampled;
}

function jaggedSample(sample: { point: MapPoint; tangent: MapPoint }, seed: number, key: number, spacing: number, jaggedness: number, scale: number, envelope: number): MapPoint {
  const outward = { x: sample.tangent.y, y: -sample.tangent.x };
  const random = hashUnit(seed, key * 977 + 17) * 2 - 1;
  const alternating = (key & 1) === 0 ? 1 : -1;
  const signed = clamp(random * 0.68 + alternating * 0.32, -1, 1);
  const amplitudeVariation = 0.58 + hashUnit(seed, key * 1543 + 71) * 0.28;
  const offset = signed * spacing * amplitudeVariation * jaggedness * scale * envelope;
  return quantizePoint({ x: sample.point.x + outward.x * offset, y: sample.point.y + outward.y * offset });
}

function polylineLength(points: MapPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += pointDistance(points[index - 1], points[index]);
  return total;
}

function samplePolyline(points: MapPoint[], distance: number): { point: MapPoint; tangent: MapPoint } {
  let remaining = Math.max(0, distance);
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    const length = pointDistance(a, b);
    if (length <= EPSILON) continue;
    if (remaining <= length + EPSILON) {
      const t = clamp(remaining / length, 0, 1);
      return {
        point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        tangent: { x: (b.x - a.x) / length, y: (b.y - a.y) / length },
      };
    }
    remaining -= length;
  }
  const end = points[points.length - 1];
  for (let index = points.length - 1; index > 0; index -= 1) {
    const a = points[index - 1];
    const length = pointDistance(a, end);
    if (length > EPSILON) return { point: clonePoint(end), tangent: { x: (end.x - a.x) / length, y: (end.y - a.y) / length } };
  }
  return { point: clonePoint(end), tangent: { x: 1, y: 0 } };
}

function buildFacets(points: MapPoint[], seed: number, visual: IceBodyVisualAuthoringData) {
  const normalized = normalizeVisual(visual);
  // Preserve the exact collision silhouette. Simplifying here used to discard many small teeth,
  // leaving the renderer and the rigid collider with different areas and contact edges.
  const facetBoundary = points.map(clonePoint);
  const initial = earClip(facetBoundary);
  if (!initial.length) return [];

  // The old implementation refined each ear independently. On a convex body those ears form a
  // fan, so every visible seam converged on one arbitrary outline vertex. Insert sites into the
  // complete constrained mesh and legalize shared edges instead. The result has many local
  // nuclei and no global visual centre; the body's physical centre of mass remains a separate
  // Unity concern.
  let facets: Triangle[] = initial.map((triangle, index) => ({
    points: orientTriangle(triangle.map(clonePoint) as [MapPoint, MapPoint, MapPoint]),
    key: index + 1,
  }));
  const area = Math.abs(polygonArea(facetBoundary));
  const targetSiteArea = Math.max(72, normalized.facetScale * normalized.facetScale *
    (2.15 + (1 - normalized.facetVariation) * 0.95));
  const desiredInteriorSites = Math.max(2, Math.round(area / targetSiteArea));
  const insertionBudget = Math.max(0, Math.min(
    Math.floor((MAX_FACETS - facets.length) / 2),
    desiredInteriorSites,
  ));
  const acceptedSites = facetBoundary.map(clonePoint);
  const minimumSpacing = Math.max(2.25, normalized.facetScale * 0.34);
  let inserted = 0;
  for (let attempt = 0; attempt < insertionBudget * 48 && inserted < insertionBudget; attempt += 1) {
    const sourceIndex = chooseTriangleByArea(facets, seed, attempt);
    if (sourceIndex < 0) break;
    const source = facets[sourceIndex].points;
    const root = Math.sqrt(0.08 + hashUnit(seed, attempt * 1907 + 17) * 0.84);
    const mix = 0.08 + hashUnit(seed, attempt * 3469 + 43) * 0.84;
    const candidate = quantizePoint({
      x: source[0].x * (1 - root) + source[1].x * root * (1 - mix) + source[2].x * root * mix,
      y: source[0].y * (1 - root) + source[1].y * root * (1 - mix) + source[2].y * root * mix,
    });
    if (!pointStrictlyInsideTriangle(candidate, source, Math.max(0.3, normalized.facetScale * 0.025))) continue;
    if (acceptedSites.some((point) => pointDistance(point, candidate) < minimumSpacing)) continue;

    const parent = facets[sourceIndex];
    const split: Triangle[] = [
      { points: orientTriangle([clonePoint(parent.points[0]), clonePoint(parent.points[1]), clonePoint(candidate)]), key: parent.key * 3 + 1 },
      { points: orientTriangle([clonePoint(parent.points[1]), clonePoint(parent.points[2]), clonePoint(candidate)]), key: parent.key * 3 + 2 },
      { points: orientTriangle([clonePoint(parent.points[2]), clonePoint(parent.points[0]), clonePoint(candidate)]), key: parent.key * 3 + 3 },
    ];
    facets.splice(sourceIndex, 1, ...split);
    acceptedSites.push(candidate);
    inserted += 1;
    facets = legalizeTriangulation(facets, Math.min(256, facets.length * 6));
  }
  facets = legalizeTriangulation(facets, Math.min(1024, facets.length * facets.length));

  return facets
    .filter((triangle) => triangleArea(triangle.points) > 0.1)
    .map((triangle, index) => ({
      id: index + 1,
      points: triangle.points.map(clonePoint) as [MapPoint, MapPoint, MapPoint],
      shade: quantize(hashUnit(seed, triangle.key * 1103 + Math.round((triangle.points[0].x + triangle.points[1].y + triangle.points[2].x) * 17)), 0.001),
    }));
}

function chooseTriangleByArea(triangles: Triangle[], seed: number, attempt: number): number {
  let total = 0;
  for (const triangle of triangles) total += triangleArea(triangle.points);
  if (total <= EPSILON) return -1;
  let cursor = hashUnit(seed, attempt * 811 + 101) * total;
  for (let index = 0; index < triangles.length; index += 1) {
    cursor -= triangleArea(triangles[index].points);
    if (cursor <= 0) return index;
  }
  return triangles.length - 1;
}

function pointStrictlyInsideTriangle(point: MapPoint, triangle: [MapPoint, MapPoint, MapPoint], margin: number): boolean {
  const twiceArea = Math.abs(cross(triangle[0], triangle[1], triangle[2]));
  if (twiceArea <= EPSILON) return false;
  const distances = [
    Math.abs(cross(triangle[0], triangle[1], point)) / Math.max(EPSILON, pointDistance(triangle[0], triangle[1])),
    Math.abs(cross(triangle[1], triangle[2], point)) / Math.max(EPSILON, pointDistance(triangle[1], triangle[2])),
    Math.abs(cross(triangle[2], triangle[0], point)) / Math.max(EPSILON, pointDistance(triangle[2], triangle[0])),
  ];
  return pointInTriangle(point, triangle) && distances.every((distance) => distance >= margin);
}

function orientTriangle(points: [MapPoint, MapPoint, MapPoint]): [MapPoint, MapPoint, MapPoint] {
  return cross(points[0], points[1], points[2]) >= 0 ? points : [points[0], points[2], points[1]];
}

function legalizeTriangulation(source: Triangle[], maximumFlips: number): Triangle[] {
  const triangles = source.map((triangle) => ({
    points: orientTriangle(triangle.points.map(clonePoint) as [MapPoint, MapPoint, MapPoint]),
    key: triangle.key,
  }));
  for (let flip = 0; flip < maximumFlips; flip += 1) {
    const adjacency = new Map<string, { triangle: number; a: MapPoint; b: MapPoint; opposite: MapPoint }[]>();
    for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex += 1) {
      const points = triangles[triangleIndex].points;
      for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
        const a = points[edgeIndex];
        const b = points[(edgeIndex + 1) % 3];
        const opposite = points[(edgeIndex + 2) % 3];
        const key = undirectedEdgeKey(a, b);
        const entries = adjacency.get(key) || [];
        entries.push({ triangle: triangleIndex, a, b, opposite });
        adjacency.set(key, entries);
      }
    }

    let changed = false;
    for (const entries of adjacency.values()) {
      if (entries.length !== 2) continue; // polygon boundary is a hard constraint
      const first = entries[0];
      const second = entries[1];
      const a = first.a;
      const b = first.b;
      const c = first.opposite;
      const d = second.opposite;
      if (cross(a, b, c) * cross(a, b, d) >= -EPSILON) continue;
      if (cross(c, d, a) * cross(c, d, b) >= -EPSILON) continue;
      if (!circumcircleContains(d, a, b, c)) continue;
      const replacementA = orientTriangle([clonePoint(c), clonePoint(d), clonePoint(a)]);
      const replacementB = orientTriangle([clonePoint(d), clonePoint(c), clonePoint(b)]);
      if (triangleArea(replacementA) <= 0.1 || triangleArea(replacementB) <= 0.1) continue;
      triangles[first.triangle] = { points: replacementA, key: triangles[first.triangle].key };
      triangles[second.triangle] = { points: replacementB, key: triangles[second.triangle].key };
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return triangles;
}

function simplifyClosedPolygon(points: MapPoint[], epsilon: number): MapPoint[] {
  if (points.length <= 6) return points.map(clonePoint);
  let opposite = 1;
  let farthest = 0;
  for (let index = 1; index < points.length; index += 1) {
    const distance = pointDistance(points[0], points[index]);
    if (distance > farthest) {
      farthest = distance;
      opposite = index;
    }
  }
  const first = rdp(points.slice(0, opposite + 1), epsilon);
  const second = rdp([...points.slice(opposite), points[0]], epsilon);
  const simplified = [...first.slice(0, -1), ...second.slice(0, -1)];
  if (simplified.length < 3 || polygonSelfIntersects(simplified) || Math.abs(polygonArea(simplified)) < MIN_ICE_BODY_AREA) return points.map(clonePoint);
  return simplified;
}

function delaunayTriangle(points: MapPoint[], keyBase: number): Triangle[] {
  if (points.length === 3) return [{ points: points.map(clonePoint) as [MapPoint, MapPoint, MapPoint], key: keyBase }];
  const bounds = points.reduce((value, point) => ({
    left: Math.min(value.left, point.x),
    top: Math.min(value.top, point.y),
    right: Math.max(value.right, point.x),
    bottom: Math.max(value.bottom, point.y),
  }), { left: points[0].x, top: points[0].y, right: points[0].x, bottom: points[0].y });
  const span = Math.max(1, bounds.right - bounds.left, bounds.bottom - bounds.top) * 8;
  const center = { x: (bounds.left + bounds.right) * 0.5, y: (bounds.top + bounds.bottom) * 0.5 };
  const vertices = [...points.map(clonePoint),
    { x: center.x - span * 2, y: center.y + span },
    { x: center.x, y: center.y - span * 2 },
    { x: center.x + span * 2, y: center.y + span },
  ];
  const superStart = points.length;
  let triangles: [number, number, number][] = [[superStart, superStart + 1, superStart + 2]];
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const bad: number[] = [];
    for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex += 1) {
      const triangle = triangles[triangleIndex];
      if (circumcircleContains(vertices[pointIndex], vertices[triangle[0]], vertices[triangle[1]], vertices[triangle[2]])) bad.push(triangleIndex);
    }
    const edges = new Map<string, [number, number]>();
    const duplicateEdges = new Set<string>();
    for (const triangleIndex of bad) {
      const triangle = triangles[triangleIndex];
      for (const edge of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]] as [number, number][]) {
        const key = edge[0] < edge[1] ? `${edge[0]}:${edge[1]}` : `${edge[1]}:${edge[0]}`;
        if (edges.has(key)) duplicateEdges.add(key); else edges.set(key, edge);
      }
    }
    triangles = triangles.filter((_, index) => !bad.includes(index));
    for (const [key, edge] of edges) {
      if (duplicateEdges.has(key)) continue;
      triangles.push([edge[0], edge[1], pointIndex]);
    }
  }
  return triangles
    .filter((triangle) => triangle.every((index) => index < superStart))
    .map((triangle, index) => {
      let polygon = triangle.map((vertex) => clonePoint(vertices[vertex])) as [MapPoint, MapPoint, MapPoint];
      if (cross(polygon[0], polygon[1], polygon[2]) < 0) polygon = [polygon[0], polygon[2], polygon[1]];
      return { points: polygon, key: keyBase * 1000 + index + 1 };
    });
}

function circumcircleContains(point: MapPoint, a: MapPoint, b: MapPoint, c: MapPoint): boolean {
  const ax = a.x - point.x;
  const ay = a.y - point.y;
  const bx = b.x - point.x;
  const by = b.y - point.y;
  const cx = c.x - point.x;
  const cy = c.y - point.y;
  const determinant = (ax * ax + ay * ay) * (bx * cy - cx * by)
    - (bx * bx + by * by) * (ax * cy - cx * ay)
    + (cx * cx + cy * cy) * (ax * by - bx * ay);
  const orientation = cross(a, b, c);
  return orientation > 0 ? determinant > EPSILON : determinant < -EPSILON;
}

function earClip(points: MapPoint[]): [MapPoint, MapPoint, MapPoint][] {
  const indices = points.map((_, index) => index);
  const result: [MapPoint, MapPoint, MapPoint][] = [];
  let guard = 0;
  while (indices.length > 3 && guard < points.length * points.length) {
    guard += 1;
    let earFound = false;
    for (let cursor = 0; cursor < indices.length; cursor += 1) {
      const previous = indices[(cursor - 1 + indices.length) % indices.length];
      const current = indices[cursor];
      const next = indices[(cursor + 1) % indices.length];
      const triangle: [MapPoint, MapPoint, MapPoint] = [points[previous], points[current], points[next]];
      if (cross(triangle[0], triangle[1], triangle[2]) <= EPSILON) continue;
      let containsPoint = false;
      for (const index of indices) {
        if (index === previous || index === current || index === next) continue;
        if (pointInTriangle(points[index], triangle)) {
          containsPoint = true;
          break;
        }
      }
      if (containsPoint) continue;
      result.push(triangle.map(clonePoint) as [MapPoint, MapPoint, MapPoint]);
      indices.splice(cursor, 1);
      earFound = true;
      break;
    }
    if (!earFound) break;
  }
  if (indices.length === 3) result.push(indices.map((index) => clonePoint(points[index])) as [MapPoint, MapPoint, MapPoint]);
  return result;
}

export function polygonArea(points: MapPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea * 0.5;
}

export function polygonSelfIntersects(points: MapPoint[]): boolean {
  if (points.length < 4) return false;
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (first === 0 && secondNext === 0) continue;
      if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext])) return true;
    }
  }
  return false;
}

export function pointInPolygon(point: MapPoint, points: MapPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const currentPoint = points[index];
    const previousPoint = points[previous];
    if (Math.abs(cross(previousPoint, currentPoint, point)) <= EPSILON && pointOnSegment(point, previousPoint, currentPoint)) return true;
    const intersects = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < (previousPoint.x - currentPoint.x) * (point.y - currentPoint.y) / ((previousPoint.y - currentPoint.y) || EPSILON) + currentPoint.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function simplifyPolyline(points: MapPoint[], epsilon: number): MapPoint[] {
  const clean: MapPoint[] = [];
  for (const point of points || []) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
    if (!clean.length || pointDistance(clean[clean.length - 1], point) >= Math.max(0.05, epsilon * 0.5)) clean.push(clonePoint(point));
  }
  if (clean.length <= 2) return clean;
  return rdp(clean, epsilon);
}

function rdp(points: MapPoint[], epsilon: number): MapPoint[] {
  if (points.length <= 2) return points.map(clonePoint);
  let maxDistance = 0;
  let split = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = pointSegmentDistance(points[index], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      split = index;
    }
  }
  if (maxDistance <= epsilon) return [clonePoint(points[0]), clonePoint(points[points.length - 1])];
  const left = rdp(points.slice(0, split + 1), epsilon);
  const right = rdp(points.slice(split), epsilon);
  return [...left.slice(0, -1), ...right];
}

function pointSegmentDistance(point: MapPoint, a: MapPoint, b: MapPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < EPSILON) return pointDistance(point, a);
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  return pointDistance(point, { x: a.x + dx * t, y: a.y + dy * t });
}

function segmentsIntersect(a: MapPoint, b: MapPoint, c: MapPoint, d: MapPoint): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
    && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))) return true;
  return Math.abs(abC) <= EPSILON && pointOnSegment(c, a, b)
    || Math.abs(abD) <= EPSILON && pointOnSegment(d, a, b)
    || Math.abs(cdA) <= EPSILON && pointOnSegment(a, c, d)
    || Math.abs(cdB) <= EPSILON && pointOnSegment(b, c, d);
}

function pointOnSegment(point: MapPoint, a: MapPoint, b: MapPoint): boolean {
  return point.x >= Math.min(a.x, b.x) - EPSILON && point.x <= Math.max(a.x, b.x) + EPSILON
    && point.y >= Math.min(a.y, b.y) - EPSILON && point.y <= Math.max(a.y, b.y) + EPSILON;
}

function pointInTriangle(point: MapPoint, triangle: [MapPoint, MapPoint, MapPoint]): boolean {
  const a = cross(triangle[0], triangle[1], point);
  const b = cross(triangle[1], triangle[2], point);
  const c = cross(triangle[2], triangle[0], point);
  return a >= -EPSILON && b >= -EPSILON && c >= -EPSILON;
}

function triangleArea(points: [MapPoint, MapPoint, MapPoint]): number {
  return Math.abs(cross(points[0], points[1], points[2])) * 0.5;
}

function triangleCentroid(points: [MapPoint, MapPoint, MapPoint]): MapPoint {
  return { x: (points[0].x + points[1].x + points[2].x) / 3, y: (points[0].y + points[1].y + points[2].y) / 3 };
}

function undirectedEdgeKey(a: MapPoint, b: MapPoint): string {
  const first = `${quantize(a.x, 0.001)},${quantize(a.y, 0.001)}`;
  const second = `${quantize(b.x, 0.001)},${quantize(b.y, 0.001)}`;
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function pointTopologyKey(point: MapPoint): string {
  return `${quantize(point.x, 0.001)},${quantize(point.y, 0.001)}`;
}

/**
 * Schema tags alone cannot distinguish every retired first-ear fan from the current constrained
 * mesh because an early build briefly emitted a misleading current tag. Validate the topology so a load
 * or save repairs stale maps instead of treating their non-watertight facets as authoritative.
 */
function hasValidFacetTopology(points: MapPoint[], facets: IceBodyAuthoringData["facets"]): boolean {
  if (points.length < 3 || points.length > MAX_BOUNDARY_POINTS || !facets.length || facets.length > MAX_FACETS) return false;
  if (polygonSelfIntersects(points) || Math.abs(polygonArea(points)) < MIN_ICE_BODY_AREA) return false;

  const ids = new Set<number>();
  const edgeCounts = new Map<string, number>();
  const vertexDegrees = new Map<string, number>();
  let facetArea = 0;
  for (const facet of facets) {
    if (ids.has(facet.id)) return false;
    ids.add(facet.id);
    const area = triangleArea(facet.points);
    if (area <= 0.1) return false;
    facetArea += area;
    const centroid = triangleCentroid(facet.points);
    if (!pointInPolygon(centroid, points)) return false;
    for (let index = 0; index < 3; index += 1) {
      const point = facet.points[index];
      const vertexKey = pointTopologyKey(point);
      vertexDegrees.set(vertexKey, (vertexDegrees.get(vertexKey) || 0) + 1);
      const edgeKey = undirectedEdgeKey(point, facet.points[(index + 1) % 3]);
      const count = (edgeCounts.get(edgeKey) || 0) + 1;
      if (count > 2) return false;
      edgeCounts.set(edgeKey, count);
    }
  }

  const outlineEdges = new Set<string>();
  for (let index = 0; index < points.length; index += 1) {
    const edgeKey = undirectedEdgeKey(points[index], points[(index + 1) % points.length]);
    if (outlineEdges.has(edgeKey)) return false;
    outlineEdges.add(edgeKey);
  }
  const facetBoundary = new Set([...edgeCounts].filter(([, count]) => count === 1).map(([key]) => key));
  if (facetBoundary.size !== outlineEdges.size) return false;
  for (const edge of outlineEdges) if (!facetBoundary.has(edge)) return false;

  const outlineArea = Math.abs(polygonArea(points));
  if (Math.abs(facetArea - outlineArea) > Math.max(0.01, outlineArea * 0.0001)) return false;

  // A healthy local triangulation averages about six incident faces. Allow boundary/detail
  // variation, while rejecting the old 16/30 and 24/83 single-anchor fans seen in saved maps.
  const maximumDegree = Math.max(...vertexDegrees.values());
  const maximumAllowedDegree = Math.max(12, Math.ceil(facets.length * 0.15));
  return maximumDegree <= maximumAllowedDegree;
}

function normalizeVector(value: MapPoint, fallback: MapPoint): MapPoint {
  const length = Math.hypot(value.x, value.y);
  if (length < EPSILON) return clonePoint(fallback);
  return { x: value.x / length, y: value.y / length };
}

function cross(a: MapPoint, b: MapPoint, c: MapPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointDistance(a: MapPoint, b: MapPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isFinitePoint(point: MapPoint): boolean {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function normalizeSeed(value: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value) >>> 0 : 1;
  return normalized || 1;
}

function hashUnit(seed: number, key: number): number {
  let value = (normalizeSeed(seed) ^ Math.imul(key | 0, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

function normalizeVisual(value: IceBodyVisualAuthoringData | Record<string, unknown>, templateId: ProceduralRigidTemplateId = "iceCrystal"): IceBodyVisualAuthoringData {
  const fallback = PROCEDURAL_RIGID_TEMPLATES[templateId]?.visual || DEFAULT_ICE_BODY_VISUAL;
  const source = value && typeof value === "object" ? value as Record<string, unknown> : fallback as unknown as Record<string, unknown>;
  return {
    ...source,
    templateId,
    sourceMode: source.sourceMode === "sourceImage" ? "sourceImage" : "procedural",
    baseColor: normalizeColor(source.baseColor, fallback.baseColor),
    shadowColor: normalizeColor(source.shadowColor, fallback.shadowColor),
    highlightColor: normalizeColor(source.highlightColor, fallback.highlightColor),
    edgeColor: normalizeColor(source.edgeColor, fallback.edgeColor),
    fractureColor: normalizeColor(source.fractureColor, fallback.fractureColor || blendColors(fallback.baseColor, fallback.highlightColor, 0.72)),
    opacity: clamp(finiteNumber(source.opacity, fallback.opacity), 0, 1),
    edgeJaggedness: clamp(finiteNumber(source.edgeJaggedness ?? source.jaggedness, fallback.edgeJaggedness), 0, 1),
    facetScale: clamp(finiteNumber(source.facetScale ?? source.facetSize, fallback.facetScale), 6, 128),
    facetVariation: clamp(finiteNumber(source.facetVariation, fallback.facetVariation), 0, 1),
    textureStrength: clamp(finiteNumber(source.textureStrength, fallback.textureStrength), 0, 1),
    edgeBrightness: clamp(finiteNumber(source.edgeBrightness, fallback.edgeBrightness), 0, 1),
    edgeWidthPixels: clamp(finiteNumber(source.edgeWidthPixels ?? source.frostWidth, fallback.edgeWidthPixels), 0, 24),
    volumeDepth: clamp(finiteNumber(source.volumeDepth, fallback.volumeDepth), 0, 1),
    transmission: clamp(finiteNumber(source.transmission, fallback.transmission), 0, 1),
    absorption: clamp(finiteNumber(source.absorption, fallback.absorption), 0, 1),
    roughness: clamp(finiteNumber(source.roughness, fallback.roughness), 0, 1),
    specularStrength: clamp(finiteNumber(source.specularStrength, fallback.specularStrength), 0, 1),
    inclusionDensity: clamp(finiteNumber(source.inclusionDensity, fallback.inclusionDensity), 0, 1),
    microCrackDensity: clamp(finiteNumber(source.microCrackDensity, fallback.microCrackDensity), 0, 1),
    grainDirectionDegrees: clamp(finiteNumber(source.grainDirectionDegrees, fallback.grainDirectionDegrees), -180, 180),
    anisotropy: clamp(finiteNumber(source.anisotropy, fallback.anisotropy), 0, 1),
    lightAngleDegrees: clamp(finiteNumber(source.lightAngleDegrees, fallback.lightAngleDegrees), -180, 180),
  };
}

function normalizePhysical(value: ProceduralRigidPhysicalAuthoringData | Record<string, unknown>, fallback: ProceduralRigidPhysicalAuthoringData, terrainAttached: boolean): ProceduralRigidPhysicalAuthoringData {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : fallback as unknown as Record<string, unknown>;
  const authoredMode = source.anchoringMode === "fixed" || source.anchoringMode === "terrainAttached" ? source.anchoringMode : "dynamic";
  return {
    ...source,
    anchoringMode: terrainAttached ? "terrainAttached" : authoredMode,
    density: clamp(finiteNumber(source.density, fallback.density), 0.001, 1000),
    gravityScale: clamp(finiteNumber(source.gravityScale, fallback.gravityScale), -8, 8),
    friction: clamp(finiteNumber(source.friction, fallback.friction), 0, 1),
    restitution: clamp(finiteNumber(source.restitution, fallback.restitution), 0, 1),
    linearDamping: clamp(finiteNumber(source.linearDamping, fallback.linearDamping), 0, 20),
    angularDamping: clamp(finiteNumber(source.angularDamping, fallback.angularDamping), 0, 20),
    hardness: clamp(finiteNumber(source.hardness, fallback.hardness), 0, 1),
    toughness: clamp(finiteNumber(source.toughness, fallback.toughness), 0, 1),
    brittleness: clamp(finiteNumber(source.brittleness, fallback.brittleness), 0, 1),
    anisotropy: clamp(finiteNumber(source.anisotropy, fallback.anisotropy), 0, 1),
    grainAngleDegrees: clamp(finiteNumber(source.grainAngleDegrees, fallback.grainAngleDegrees), -180, 180),
    debrisFraction: clamp(finiteNumber(source.debrisFraction, fallback.debrisFraction), 0, 1),
  };
}

function normalizeFracture(value: IceBodyFractureAuthoringData | Record<string, unknown>, fallback: IceBodyFractureAuthoringData = DEFAULT_ICE_BODY_FRACTURE): IceBodyFractureAuthoringData {
  const rawSource = value && typeof value === "object" ? value as Record<string, unknown> : fallback as unknown as Record<string, unknown>;
  const source = migrateLegacyFractureDefaults(rawSource, fallback);
  const minimum = clamp(Math.round(finiteNumber(source.primaryFragmentMin, fallback.primaryFragmentMin)), 2, 8);
  const maximum = clamp(Math.round(finiteNumber(source.primaryFragmentMax, fallback.primaryFragmentMax)), minimum, 8);
  const perImpact = clamp(Math.round(finiteNumber(source.maxFragmentsPerImpact, fallback.maxFragmentsPerImpact)), 2, 8);
  const impactChipEnergy = clamp(finiteNumber(source.impactChipEnergy, fallback.impactChipEnergy), 0, 100000);
  const impactCrackEnergy = clamp(finiteNumber(source.impactCrackEnergy, fallback.impactCrackEnergy), impactChipEnergy, 100000);
  const landingChipEnergy = clamp(finiteNumber(source.landingChipEnergy, fallback.landingChipEnergy), 0, 100000);
  const landingCrackEnergy = clamp(finiteNumber(source.landingCrackEnergy, fallback.landingCrackEnergy), landingChipEnergy, 100000);
  return {
    ...source,
    primaryFragmentMin: minimum,
    primaryFragmentMax: Math.min(maximum, perImpact),
    maxFragmentsPerImpact: perImpact,
    maxActiveFragmentsPerFamily: clamp(Math.round(finiteNumber(source.maxActiveFragmentsPerFamily, fallback.maxActiveFragmentsPerFamily)), perImpact, 256),
    minimumFragmentArea: clamp(finiteNumber(source.minimumFragmentArea, fallback.minimumFragmentArea), 1, 100000),
    minimumFragmentWidth: clamp(finiteNumber(source.minimumFragmentWidth, fallback.minimumFragmentWidth), 1, 1024),
    crackBranchMin: clamp(Math.round(finiteNumber(source.crackBranchMin, fallback.crackBranchMin)), 0, 8),
    crackBranchMax: clamp(Math.round(finiteNumber(source.crackBranchMax, fallback.crackBranchMax)), 0, 12),
    releaseDelayTicks: clamp(Math.round(finiteNumber(source.releaseDelayTicks, fallback.releaseDelayTicks)), 0, 120),
    impactChipEnergy,
    impactCrackEnergy,
    impactBreakEnergy: clamp(finiteNumber(source.impactBreakEnergy, fallback.impactBreakEnergy), impactCrackEnergy, 100000),
    collisionBreakThreshold: clamp(finiteNumber(source.collisionBreakThreshold, fallback.collisionBreakThreshold), 0, 100000),
    landingChipEnergy,
    landingCrackEnergy,
    landingBreakEnergy: clamp(finiteNumber(source.landingBreakEnergy, fallback.landingBreakEnergy), landingCrackEnergy, 100000),
    contactStressSensitivity: clamp(finiteNumber(source.contactStressSensitivity, fallback.contactStressSensitivity), 0, 4),
    landingCooldownTicks: clamp(Math.round(finiteNumber(source.landingCooldownTicks, fallback.landingCooldownTicks)), 0, 120),
  };
}

/**
 * A short-lived procedural-ice build wrote 1.5/4/9 landing thresholds and 7 for
 * rigid-body collision, before attack fatigue had its own three-stage authoring
 * fields. Those values make a normal drop look catastrophic. Upgrade only that
 * exact inherited signature; hand-tuned legacy values remain authoritative.
 */
function migrateLegacyFractureDefaults(
  source: Record<string, unknown>,
  fallback: IceBodyFractureAuthoringData,
): Record<string, unknown> {
  const hasAttackStages = ["impactChipEnergy", "impactCrackEnergy", "impactBreakEnergy"]
    .some((key) => Object.prototype.hasOwnProperty.call(source, key) && Number.isFinite(Number(source[key])));
  if (hasAttackStages) return source;

  const approximately = (value: unknown, expected: number) => Number.isFinite(Number(value))
    && Math.abs(Number(value) - expected) <= 0.0001;
  const inheritedIceSignature = approximately(source.collisionBreakThreshold, 7)
    && approximately(source.landingChipEnergy, 1.5)
    && approximately(source.landingCrackEnergy, 4)
    && approximately(source.landingBreakEnergy, 9)
    && approximately(source.contactStressSensitivity, 1);
  if (!inheritedIceSignature) return source;

  return {
    ...source,
    impactChipEnergy: fallback.impactChipEnergy,
    impactCrackEnergy: fallback.impactCrackEnergy,
    impactBreakEnergy: fallback.impactBreakEnergy,
    collisionBreakThreshold: fallback.collisionBreakThreshold,
    landingChipEnergy: fallback.landingChipEnergy,
    landingCrackEnergy: fallback.landingCrackEnergy,
    landingBreakEnergy: fallback.landingBreakEnergy,
    contactStressSensitivity: fallback.contactStressSensitivity,
  };
}

function normalizeColor(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(text) ? text : fallback;
}

function blendColors(first: string, second: string, amount: number): string {
  const parse = (value: string) => {
    const match = /^#([0-9a-f]{6})$/i.exec(value || "");
    if (!match) return null;
    return [0, 2, 4].map((offset) => parseInt(match[1].slice(offset, offset + 2), 16));
  };
  const a = parse(first);
  const b = parse(second);
  if (!a || !b) return first;
  const t = clamp(amount, 0, 1);
  return `#${a.map((value, index) => Math.round(value + (b[index] - value) * t).toString(16).padStart(2, "0")).join("")}`;
}

function finiteNumber(value: unknown, fallback: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number(fallback);
}

function quantizePoint(point: MapPoint): MapPoint {
  return { x: quantize(point.x, 0.25), y: quantize(point.y, 0.25) };
}

function quantize(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function clonePoint(point: MapPoint): MapPoint {
  return { x: point.x, y: point.y };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
