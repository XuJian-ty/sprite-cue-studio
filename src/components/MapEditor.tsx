import {
  Box,
  Bot,
  ChevronLeft,
  CircleDot,
  Download,
  Eye,
  FolderOpen,
  FolderSync,
  GripVertical,
  Hand,
  ImagePlus,
  Layers3,
  Map as MapIcon,
  MousePointer2,
  Pencil,
  Plus,
  Redo2,
  RotateCcw,
  Snowflake,
  Trash2,
  TriangleAlert,
  Unlink,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DeferredTextInput from "./DeferredTextInput";
import { UNITY_RUNTIME_GIT_URL } from "../unityRuntime";
import NumericInput from "./NumericInput";
import { loadMapDraft, saveMapDraft } from "../mapDraftStore";
import { readDocumentOrigin, rememberLocalDocument, rememberUnityDocument } from "../workspaceSession";
import { createGroundLinePoints, finishBrushDrawing, pointDistance } from "../mapGeometry";
import { buildProceduralRigidBody, buildIceFracturePreview, DEFAULT_PROCEDURAL_RIGID_FRACTURE, DEFAULT_PROCEDURAL_RIGID_VISUAL, ensureProgramRigidAssetOutline, ensureProgramRigidAssets, ensureProgramRigidOutline, ensureProgramRigidProject, pointInPolygon, PROCEDURAL_RIGID_TEMPLATES, type ProceduralRigidBuildResult, type IceFracturePreviewResult, type ProceduralRigidTerrainContour, type ProceduralRigidTerrainRoutePreference } from "../mapIceGeometry";
import { createMatterProfile, normalizeMatterProfile } from "../mapMatterProfiles";
import { createMapProject, type IceBodyClosureMode, type MapAssetRef, type MapElement, type MapLayer, type MapMatterAuthoringProfileData, type MapMatterStrokeData, type MapMode, type MapObjectData, type MapObjectMotionData, type MapOutlineData, type MapPoint, type MapProject, type ProceduralRigidFractureAuthoringData, type ProceduralRigidPhysicalAuthoringData, type ProceduralRigidTemplateId, type ProceduralRigidVisualAuthoringData } from "../mapTypes";
import { uid } from "../model";

interface MapEditorProps {
  onSwitchToCharacter: () => void;
  onSwitchToEnemy: () => void;
}

interface UnityMapSummary {
  mapName: string;
  jsonPath: string;
  prefabPath: string;
  syncedAt: string;
  legacy?: boolean;
  managed?: boolean;
  generatedPrefab?: boolean;
  sharedPrefab?: boolean;
  orphanPrefab?: boolean;
}

interface UnityMapPrefabSummary {
  path: string;
  mapName: string;
  sourceJsonPath?: string;
  hasSourceData?: boolean;
}

interface ConnectionState {
  path: string;
  phase: "path" | "checking" | "missing" | "incompatible" | "ready" | "overwrite" | "syncing" | "done" | "error";
  message: string;
  runtimeVersion?: string;
}

interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

interface PointerOperation {
  type: "pan" | "drag" | "draw" | "matter";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPanX?: number;
  startPanY?: number;
  objectId?: string;
  offsetX?: number;
  offsetY?: number;
  historyRecorded?: boolean;
  drawMode?: MapMode;
}

type CanvasSelectionKind = "object" | "outline" | "matter";

interface MapSnapshot {
  project: MapProject;
  assets: Record<string, MapAssetRef>;
}

interface AssetDropPreview {
  assetId: string;
  point: MapPoint;
}

interface PendingBackgroundReplacement {
  asset: MapAssetRef;
}

interface IceFracturePreviewTarget {
  outlineId: string;
  impactPoint: MapPoint;
}

const layerLabels: Record<MapLayer, string> = { decoration: "装饰层", collision: "地面/碰撞层", rigid: "程序刚体层", occlusion: "遮挡层" };
const layerColors: Record<MapLayer, string> = { decoration: "#168178", collision: "#d15343", rigid: "#9a4fd1", occlusion: "#4767ad" };
const elementLabels: Record<MapElement, string> = { fire: "火", ice: "冰", water: "水", wind: "风", light: "光", dark: "暗", thunder: "雷" };
const elementColors: Record<MapElement, string> = { fire: "#ff542c", ice: "#65cdf2", water: "#287bd8", wind: "#7be1ba", light: "#ffe174", dark: "#5a2d82", thunder: "#ad68ff" };
const rectangleCollisionColors = {
  "solid-sides": { stroke: "#d15343", fill: "rgba(209,83,67,.18)" },
  "solid-open": { stroke: "#cc8618", fill: "rgba(204,134,24,.18)" },
  "oneWay-sides": { stroke: "#21965a", fill: "rgba(33,150,90,.18)" },
  "oneWay-open": { stroke: "#3478c7", fill: "rgba(52,120,199,.18)" },
} as const;
const HORIZONTAL_SNAP_SCREEN_PX = 10;
const MAP_ASSET_BASE64_CHUNK_SIZE = 8 * 1024 * 1024;

function previewNoise(seed: number, key: number): number {
  let value = ((seed >>> 0) ^ Math.imul(key | 0, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  return (value >>> 0) / 0x100000000;
}

function colorWithAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return `rgba(255,255,255,${Math.max(0, Math.min(1, alpha))})`;
  const value = Number.parseInt(match[1], 16);
  return `rgba(${value >> 16},${value >> 8 & 255},${value & 255},${Math.max(0, Math.min(1, alpha))})`;
}

function mixHexColor(first: string, second: string, amount: number): string {
  const parse = (value: string) => Number.parseInt(value.replace("#", ""), 16);
  const a = parse(first);
  const b = parse(second);
  const t = Math.max(0, Math.min(1, amount));
  const channel = (shift: number) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t);
  return `rgb(${channel(16)},${channel(8)},${channel(0)})`;
}

function collisionOutlineContours(outline: MapOutlineData, sourceId: string, points = outline.points, sourceKind: ProceduralRigidTerrainContour["sourceKind"] = "mapOutline"): ProceduralRigidTerrainContour[] {
  if (outline.layer !== "collision" || outline.collisionType !== "solid" || points.length < 2) return [];
  if (outline.shape !== "groundLine") {
    return points.length >= 3 ? [{ id: sourceId, sourceKind, points, closed: outline.closed !== false }] : [];
  }
  if (points.length < 4) return [];
  if (outline.sideCollision !== false) return [{ id: sourceId, sourceKind, points: points.slice(0, 4), closed: true }];
  return [
    { id: `${sourceId}:top`, sourceKind, points: [points[0], points[1]], closed: false },
    { id: `${sourceId}:bottom`, sourceKind, points: [points[3], points[2]], closed: false },
  ];
}

function transformAssetOutlinePoint(point: MapPoint, object: MapObjectData, asset: MapAssetRef): MapPoint {
  const width = asset.width * object.scale;
  const height = asset.height * object.scale;
  const localX = (point.x - asset.width * 0.5) * object.scale;
  const localY = (point.y - asset.height * 0.5) * object.scale;
  const radians = object.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: object.x + width * 0.5 + localX * cosine - localY * sine,
    y: object.y + height * 0.5 + localX * sine + localY * cosine,
  };
}

function collectIceTerrainContours(project: MapProject, assets: Record<string, MapAssetRef>): ProceduralRigidTerrainContour[] {
  const contours = project.outlines.flatMap((outline) => collisionOutlineContours(outline, outline.id));
  for (const object of project.objects) {
    if (object.layer !== "collision" || object.mode === "dynamic") continue;
    const asset = assets[object.assetId];
    if (!asset) continue;
    for (const outline of asset.outlines || []) {
      const points = outline.points.map((point) => transformAssetOutlinePoint(point, object, asset));
      contours.push(...collisionOutlineContours(outline, `${object.id}:${outline.id}`, points, "assetOutline"));
    }
  }
  return contours;
}

function averagePoint(points: MapPoint[]): MapPoint {
  if (!points.length) return { x: 0, y: 0 };
  const sum = points.reduce((value, point) => ({ x: value.x + point.x, y: value.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}
function normalizeMapOutline(outline: MapOutlineData): MapOutlineData {
  const legacyLineRoad = String(outline.shape) === "lineRoad" || String(outline.shape) === "oneWayLine";
  const rectangleCollision = legacyLineRoad || String(outline.shape) === "groundLine";
  const thickness = rectangleCollision ? Math.max(1, Number(outline.thickness) || 1) : Math.max(0, Number(outline.thickness) || 0);
  const sourcePoints = Array.isArray(outline.points) ? outline.points : [];
  const start = sourcePoints[0];
  const end = sourcePoints[sourcePoints.length - 1];
  return {
    ...outline,
    layer: String(outline.layer) === "rigid" ? "rigid" : String(outline.layer) === "occlusion" ? "occlusion" : "collision",
    element: elementLabels[outline.element] ? outline.element : "fire",
    shape: legacyLineRoad ? "groundLine" : outline.shape,
    thickness,
    sideCollision: legacyLineRoad ? false : outline.sideCollision !== false,
    points: legacyLineRoad && start && end ? createGroundLinePoints(start, end, thickness) : sourcePoints,
  };
}

function normalizeMapAsset(asset: MapAssetRef): MapAssetRef {
  return {
    ...asset,
    url: asset.dataUrl || asset.url,
    outlines: (asset.outlines || []).map(normalizeMapOutline).map(ensureProgramRigidAssetOutline),
    draftOutlines: (asset.draftOutlines || []).map(normalizeMapOutline).map(ensureProgramRigidAssetOutline),
  };
}

function normalizeMapObject(object: MapObjectData): MapObjectData {
  const motion = object.motion || {} as MapObjectMotionData;
  const normalized = { ...object } as MapObjectData & { outlinePrecision?: unknown };
  // v2 maps may still contain the retired selector. Discard it during load so the
  // next save exports one deterministic ArcaneMatter contour policy.
  delete normalized.outlinePrecision;
  return {
    ...normalized,
    layer: (["decoration", "collision", "rigid", "occlusion"] as string[]).includes(object.layer) ? object.layer : "decoration",
    elementTag: String(object.elementTag || (object.element && elementLabels[object.element] ? object.element : "fire")).trim() || "fire",
    element: undefined,
    mode: object.mode === "dynamic" ? "dynamic" : "static",
    collisionType: object.collisionType === "solid" ? "solid" : "oneWay",
    motion: {
      direction: motion.direction === "vertical" ? "vertical" : "horizontal",
      speedMetersPerSecond: Math.max(0.1, Math.min(100, Number(motion.speedMetersPerSecond) || 2)),
      rangeMeters: Math.max(0.1, Math.min(1000, Number(motion.rangeMeters) || 10)),
      initialProgress: Math.max(0, Math.min(1, Number(motion.initialProgress) || 0)),
      pingPong: motion.pingPong !== false,
      endpointPauseSeconds: Math.max(0, Number(motion.endpointPauseSeconds) || 0),
      phaseSeconds: Math.max(0, Number(motion.phaseSeconds) || 0),
    },
  };
}

function normalizeMatterStroke(stroke: MapMatterStrokeData): MapMatterStrokeData {
  const carrier = stroke.carrier === "gas" ? "gas" : "liquid";
  const legacyElement = stroke.element && elementLabels[stroke.element] ? stroke.element : "water";
  const elementTag = String(stroke.elementTag || legacyElement).trim() || legacyElement;
  return {
    ...stroke,
    carrier,
    elementTag,
    element: undefined,
    profile: normalizeMatterProfile(carrier, elementTag, stroke.profile),
    radius: Math.max(1, Number(stroke.radius) || 12),
    points: (stroke.points || []).map((point) => ({ x: Number(point.x) || 0, y: Number(point.y) || 0 })),
  };
}

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("资源读取失败"));
    reader.readAsDataURL(file);
  });
}

function readImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("图片读取失败"));
    image.src = url;
  });
}

async function createMapAsset(file: File, usage: MapAssetRef["usage"], defaultLayer: MapLayer): Promise<MapAssetRef> {
  const dataUrl = await readDataUrl(file);
  const size = await readImageSize(dataUrl);
  return { id: uid("map_asset"), name: file.name, kind: "image", usage, defaultLayer, url: dataUrl, dataUrl, ...size, outlines: [], draftOutlines: [] };
}

function projectName(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized || "Unity 项目";
}

function defaultObjectScale(asset: MapAssetRef, project: MapProject): number {
  return Math.min(1, Math.max(0.05, Math.min(project.width * 0.24 / asset.width, project.height * 0.24 / asset.height)));
}

function rectangleCollisionStyle(collisionType: MapOutlineData["collisionType"], sideCollision: boolean) {
  const direction = collisionType === "oneWay" ? "oneWay" : "solid";
  return rectangleCollisionColors[`${direction}-${sideCollision ? "sides" : "open"}`];
}

function rectangleCollisionLabel(collisionType: MapOutlineData["collisionType"], sideCollision: boolean): string {
  return `${collisionType === "oneWay" ? "单向" : "双向"} · ${sideCollision ? "侧面碰撞" : "侧面穿透"}`;
}

function distanceToSegment(point: MapPoint, start: MapPoint, end: MapPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.000001) return pointDistance(point, start);
  const progress = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + dx * progress), point.y - (start.y + dy * progress));
}

function pointNearPath(point: MapPoint, points: MapPoint[], tolerance: number, closed = false): boolean {
  if (!points.length) return false;
  if (points.length === 1) return pointDistance(point, points[0]) <= tolerance;
  for (let index = 1; index < points.length; index += 1) {
    if (distanceToSegment(point, points[index - 1], points[index]) <= tolerance) return true;
  }
  return closed && distanceToSegment(point, points[points.length - 1], points[0]) <= tolerance;
}

function outlineContainsPoint(outline: MapOutlineData, point: MapPoint, tolerance: number): boolean {
  if (outline.points.length >= 3 && outline.closed && pointInPolygon(point, outline.points)) return true;
  return pointNearPath(point, outline.points, tolerance, outline.closed);
}

function matterStrokeContainsPoint(stroke: MapMatterStrokeData, point: MapPoint, tolerance: number): boolean {
  return pointNearPath(point, stroke.points, Math.max(1, stroke.radius) + tolerance);
}

function pointsBounds(points: MapPoint[]): { left: number; top: number; right: number; bottom: number; centerX: number; centerY: number } {
  if (!points.length) return { left: 0, top: 0, right: 0, bottom: 0, centerX: 0, centerY: 0 };
  const bounds = points.reduce((current, point) => ({
    left: Math.min(current.left, point.x),
    top: Math.min(current.top, point.y),
    right: Math.max(current.right, point.x),
    bottom: Math.max(current.bottom, point.y),
  }), { left: points[0].x, top: points[0].y, right: points[0].x, bottom: points[0].y });
  return { ...bounds, centerX: (bounds.left + bounds.right) * 0.5, centerY: (bounds.top + bounds.bottom) * 0.5 };
}

function translateOutline(outline: MapOutlineData, offsetX: number, offsetY: number): MapOutlineData {
  const move = (point: MapPoint): MapPoint => ({ x: point.x + offsetX, y: point.y + offsetY });
  if (!outline.rigidBody) return { ...outline, points: outline.points.map(move) };
  const rigidBody = outline.rigidBody;
  return {
    ...outline,
    points: outline.points.map(move),
    rigidBody: {
      ...rigidBody,
      ...(rigidBody.authoringPoints ? { authoringPoints: rigidBody.authoringPoints.map(move) } : {}),
      ...(rigidBody.terrainBinding ? {
        terrainBinding: {
          ...rigidBody.terrainBinding,
          start: move(rigidBody.terrainBinding.start),
          end: move(rigidBody.terrainBinding.end),
        },
      } : {}),
      facets: rigidBody.facets.map((facet) => ({ ...facet, points: facet.points.map(move) as [MapPoint, MapPoint, MapPoint] })),
    },
  };
}

function selectionOutlineLabel(outline: MapOutlineData): string {
  if (outline.rigidBody) return `${PROCEDURAL_RIGID_TEMPLATES[outline.rigidBody.templateId].label}程序刚体`;
  if (outline.layer === "occlusion") return "遮挡区域";
  if (outline.shape === "groundLine") return "矩形碰撞";
  return outline.layer === "rigid" ? "程序刚体（待迁移）" : "碰撞区域";
}

function downloadJson(value: unknown, fileName: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function base64Payload(dataUrl: string): string {
  const separator = dataUrl.indexOf(",");
  if (separator < 0 || !dataUrl.slice(0, separator).toLowerCase().includes(";base64")) throw new Error("地图资源不是有效的 Base64 Data URL");
  return dataUrl.slice(separator + 1);
}

function base64ByteSize(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}

function decodeBase64Chunk(value: string): Uint8Array<ArrayBuffer> {
  const binary = window.atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function mapAssetMetadata(asset: MapAssetRef, byteSize = base64ByteSize(base64Payload(asset.dataUrl || asset.url))): Omit<MapAssetRef, "dataUrl" | "url"> & { byteSize: number } {
  const persistentAsset = ensureProgramRigidAssets({ [asset.id]: asset })[asset.id];
  return {
    id: persistentAsset.id,
    name: persistentAsset.name,
    kind: persistentAsset.kind,
    usage: persistentAsset.usage,
    defaultLayer: persistentAsset.defaultLayer,
    width: persistentAsset.width,
    height: persistentAsset.height,
    outlines: persistentAsset.outlines || [],
    draftOutlines: persistentAsset.draftOutlines || [],
    byteSize,
  };
}

function scaleProjectForBackground(project: MapProject, asset: MapAssetRef): MapProject {
  const scaleX = asset.width / Math.max(1, project.width);
  const scaleY = asset.height / Math.max(1, project.height);
  const scaleAverage = (scaleX + scaleY) * 0.5;
  const scalePoint = (point: MapPoint): MapPoint => ({ x: point.x * scaleX, y: point.y * scaleY });
  const scaleOutline = (outline: MapOutlineData): MapOutlineData => ({
    ...outline,
    thickness: outline.shape === "groundLine" ? Math.max(1, outline.thickness * scaleY) : outline.thickness * scaleY,
    points: outline.points.map(scalePoint),
    ...(outline.rigidBody ? {
      rigidBody: {
        ...outline.rigidBody,
        ...(outline.rigidBody.authoringPoints ? { authoringPoints: outline.rigidBody.authoringPoints.map(scalePoint) } : {}),
        edgeRoles: outline.rigidBody.edgeRoles.slice(),
        ...(outline.rigidBody.terrainBinding ? {
          terrainBinding: {
            ...outline.rigidBody.terrainBinding,
            start: scalePoint(outline.rigidBody.terrainBinding.start),
            end: scalePoint(outline.rigidBody.terrainBinding.end),
          },
        } : {}),
        ...(outline.rigidBody.authoringPoints ? {
          authoringPoints: outline.rigidBody.authoringPoints.map(scalePoint),
        } : {}),
        visual: { ...outline.rigidBody.visual, facetScale: outline.rigidBody.visual.facetScale * scaleAverage, edgeWidthPixels: outline.rigidBody.visual.edgeWidthPixels * scaleAverage },
        fracture: {
          ...outline.rigidBody.fracture,
          minimumFragmentArea: outline.rigidBody.fracture.minimumFragmentArea * scaleX * scaleY,
          minimumFragmentWidth: outline.rigidBody.fracture.minimumFragmentWidth * scaleAverage,
        },
        facets: outline.rigidBody.facets.map((facet) => ({ ...facet, points: facet.points.map(scalePoint) as [MapPoint, MapPoint, MapPoint] })),
      },
    } : {}),
  });
  return {
    ...project,
    width: asset.width,
    height: asset.height,
    pixelsPerUnit: Math.max(1, project.pixelsPerUnit * scaleX),
    backgroundAssetId: asset.id,
    objects: project.objects.map((object) => ({
      ...object,
      x: object.x * scaleX,
      y: object.y * scaleY,
      scale: object.scale * scaleX,
    })),
    outlines: project.outlines.map(scaleOutline),
    draftOutlines: project.draftOutlines.map(scaleOutline),
    matterStrokes: (project.matterStrokes || []).map((stroke) => ({
      ...stroke,
      radius: Math.max(1, stroke.radius * (scaleX + scaleY) * 0.5),
      points: stroke.points.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY })),
    })),
  };
}

function formatScale(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : "1";
}

export default function MapEditor({ onSwitchToCharacter, onSwitchToEnemy }: MapEditorProps) {
  const [project, setProject] = useState<MapProject>(() => createMapProject());
  const [assets, setAssets] = useState<Record<string, MapAssetRef>>({});
  const [selectedObjectId, setSelectedObjectId] = useState("");
  const [selectedOutlineId, setSelectedOutlineId] = useState("");
  const [selectedMatterStrokeId, setSelectedMatterStrokeId] = useState("");
  const [editingAssetId, setEditingAssetId] = useState("");
  const [mode, setMode] = useState<MapMode>("select");
  const [activeLayer, setActiveLayer] = useState<MapLayer>("decoration");
  const [groundThickness, setGroundThickness] = useState(18);
  const [groundCollisionType, setGroundCollisionType] = useState<"solid" | "oneWay">("solid");
  const [groundSideCollision, setGroundSideCollision] = useState(true);
  const [matterElement, setMatterElement] = useState<MapElement>("water");
  const [matterElementTag, setMatterElementTag] = useState("water");
  const [matterProfiles, setMatterProfiles] = useState<Record<"liquid" | "gas", MapMatterAuthoringProfileData>>({
    liquid: createMatterProfile("liquid", "water"),
    gas: createMatterProfile("gas", "wind"),
  });
  const [matterBrushRadius, setMatterBrushRadius] = useState(14);
  const [iceClosureMode, setIceClosureMode] = useState<IceBodyClosureMode>("manual");
  const [rigidTemplateId, setRigidTemplateId] = useState<ProceduralRigidTemplateId>("iceCrystal");
  const [rigidElementTag, setRigidElementTag] = useState(PROCEDURAL_RIGID_TEMPLATES.iceCrystal.defaultElementTag);
  const [iceRoutePreference, setIceRoutePreference] = useState<ProceduralRigidTerrainRoutePreference>("shorter");
  const [iceSeed, setIceSeed] = useState(240731);
  const [rigidBaseColor, setRigidBaseColor] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.baseColor);
  const [rigidShadowColor, setRigidShadowColor] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.shadowColor);
  const [rigidHighlightColor, setRigidHighlightColor] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.highlightColor);
  const [rigidEdgeColor, setRigidEdgeColor] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.edgeColor);
  const [rigidFractureColor, setRigidFractureColor] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.fractureColor);
  const [rigidOpacity, setRigidOpacity] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.opacity);
  const [iceJaggedness, setIceJaggedness] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.edgeJaggedness);
  const [iceFacetSize, setIceFacetSize] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.facetScale);
  const [iceTextureStrength, setIceTextureStrength] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.textureStrength);
  const [iceVolumeDepth, setIceVolumeDepth] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.volumeDepth);
  const [iceTransmission, setIceTransmission] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.transmission);
  const [iceAbsorption, setIceAbsorption] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.absorption);
  const [iceFrostWidth, setIceFrostWidth] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.edgeWidthPixels);
  const [iceSpecularStrength, setIceSpecularStrength] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.specularStrength);
  const [iceInclusionDensity, setIceInclusionDensity] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.inclusionDensity);
  const [iceMicroCrackDensity, setIceMicroCrackDensity] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.microCrackDensity);
  const [rigidFacetVariation, setRigidFacetVariation] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.facetVariation);
  const [rigidEdgeBrightness, setRigidEdgeBrightness] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.edgeBrightness);
  const [rigidRoughness, setRigidRoughness] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.roughness);
  const [rigidGrainDirection, setRigidGrainDirection] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.grainDirectionDegrees);
  const [rigidVisualAnisotropy, setRigidVisualAnisotropy] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.anisotropy);
  const [iceLightAngleDegrees, setIceLightAngleDegrees] = useState(DEFAULT_PROCEDURAL_RIGID_VISUAL.lightAngleDegrees);
  const [rigidPhysical, setRigidPhysical] = useState<ProceduralRigidPhysicalAuthoringData>({ ...PROCEDURAL_RIGID_TEMPLATES.iceCrystal.physical });
  const [rigidFractureParameters, setRigidFractureParameters] = useState<ProceduralRigidFractureAuthoringData>({ ...DEFAULT_PROCEDURAL_RIGID_FRACTURE });
  const [editingRigidOutlineId, setEditingRigidOutlineId] = useState("");
  const [autoHorizontalSnap, setAutoHorizontalSnap] = useState(false);
  const [drawing, setDrawing] = useState<MapOutlineData | null>(null);
  const [matterDrawing, setMatterDrawing] = useState<MapMatterStrokeData | null>(null);
  const [dropPreview, setDropPreview] = useState<AssetDropPreview | null>(null);
  const [pendingBackgroundReplacement, setPendingBackgroundReplacement] = useState<PendingBackgroundReplacement | null>(null);
  const [importDropTarget, setImportDropTarget] = useState<"background" | "objects" | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [view, setView] = useState<ViewState>({ zoom: 1, panX: 0, panY: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [imageRevision, setImageRevision] = useState(0);
  const [status, setStatus] = useState("地图草稿 · 未同步");
  const [hydrated, setHydrated] = useState(false);
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [boundMapUnityProjectPath, setBoundMapUnityProjectPath] = useState(() => {
    const origin = readDocumentOrigin("map");
    return localStorage.getItem("frameAction.mapUnityProjectPath") || (origin.kind === "unity" ? origin.projectPath : "");
  });
  const [prefabs, setPrefabs] = useState<UnityMapPrefabSummary[]>([]);
  const [unityMaps, setUnityMaps] = useState<UnityMapSummary[]>([]);
  const [selectedUnityMapPath, setSelectedUnityMapPath] = useState(() => {
    const origin = readDocumentOrigin("map");
    return origin.kind === "unity" ? origin.jsonPath : "";
  });
  const [editingUnityMapPath, setEditingUnityMapPath] = useState(() => {
    const origin = readDocumentOrigin("map");
    return origin.kind === "unity" ? origin.jsonPath : "";
  });
  const [pendingUnityMapDeletion, setPendingUnityMapDeletion] = useState<UnityMapSummary | null>(null);
  const [deletingUnityMap, setDeletingUnityMap] = useState(false);
  const [pendingMapOverwrite, setPendingMapOverwrite] = useState<UnityMapSummary | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const backgroundInputRef = useRef<HTMLInputElement>(null);
  const assetInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const imageCacheRef = useRef(new Map<string, HTMLImageElement>());
  const pointerRef = useRef<PointerOperation | null>(null);
  const drawingRef = useRef<MapOutlineData | null>(null);
  const matterDrawingRef = useRef<MapMatterStrokeData | null>(null);
  const draggedAssetIdRef = useRef("");
  const projectRef = useRef(project);
  const assetsRef = useRef(assets);
  const historyRef = useRef<{ past: MapSnapshot[]; future: MapSnapshot[] }>({ past: [], future: [] });

  projectRef.current = project;
  assetsRef.current = assets;

  const backgroundAsset = project.backgroundAssetId ? assets[project.backgroundAssetId] : null;
  const editingAsset = editingAssetId ? assets[editingAssetId] ?? null : null;
  const documentWidth = editingAsset?.width ?? project.width;
  const documentHeight = editingAsset?.height ?? project.height;
  const activeOutlines = editingAsset?.outlines ?? project.outlines;
  const activeDraftOutlines = editingAsset?.draftOutlines ?? project.draftOutlines;
  const selectedObject = project.objects.find((item) => item.id === selectedObjectId) ?? null;
  const selectedObjectAsset = selectedObject ? assets[selectedObject.assetId] : null;
  const selectedObjectRigidOutline = selectedObjectAsset?.outlines?.find((outline) => outline.layer === "rigid" && outline.rigidBody) ?? null;
  const selectedOutline = activeOutlines.find((item) => item.id === selectedOutlineId) ?? null;
  const selectedMatterStroke = !editingAsset
    ? (project.matterStrokes || []).find((item) => item.id === selectedMatterStrokeId) ?? null
    : null;
  const selectedOutlineBounds = selectedOutline ? pointsBounds(selectedOutline.points) : null;
  const selectedMatterBounds = selectedMatterStroke ? pointsBounds(selectedMatterStroke.points) : null;
  const selectedCanvasKind: CanvasSelectionKind | null = selectedObject
    ? "object"
    : selectedOutline
      ? "outline"
      : selectedMatterStroke
        ? "matter"
        : null;
  const iceTerrainContours = useMemo(() => editingAsset ? [] : collectIceTerrainContours(project, assets), [assets, editingAsset, project]);
  const rigidTemplate = PROCEDURAL_RIGID_TEMPLATES[rigidTemplateId];
  const matterCarrier = mode === "gas" ? "gas" : "liquid";
  const activeMatterProfile = matterProfiles[matterCarrier];
  const patchMatterProfile = (updater: (current: MapMatterAuthoringProfileData) => MapMatterAuthoringProfileData) => {
    setMatterProfiles((current) => ({ ...current, [matterCarrier]: updater(current[matterCarrier]) }));
  };
  const iceVisual = useMemo(() => ({
    ...rigidTemplate.visual,
    templateId: rigidTemplateId,
    sourceMode: editingAsset ? "sourceImage" as const : "procedural" as const,
    baseColor: rigidBaseColor,
    shadowColor: rigidShadowColor,
    highlightColor: rigidHighlightColor,
    edgeColor: rigidEdgeColor,
    fractureColor: rigidFractureColor,
    opacity: rigidOpacity,
    edgeJaggedness: iceJaggedness,
    facetScale: iceFacetSize,
    facetVariation: rigidFacetVariation,
    textureStrength: iceTextureStrength,
    edgeBrightness: rigidEdgeBrightness,
    volumeDepth: iceVolumeDepth,
    transmission: iceTransmission,
    absorption: iceAbsorption,
    roughness: rigidRoughness,
    edgeWidthPixels: iceFrostWidth,
    specularStrength: iceSpecularStrength,
    inclusionDensity: iceInclusionDensity,
    microCrackDensity: iceMicroCrackDensity,
    grainDirectionDegrees: rigidGrainDirection,
    anisotropy: rigidVisualAnisotropy,
    lightAngleDegrees: iceLightAngleDegrees,
  }), [editingAsset, iceAbsorption, iceFacetSize, iceFrostWidth, iceInclusionDensity, iceJaggedness, iceLightAngleDegrees, iceMicroCrackDensity, iceSpecularStrength, iceTextureStrength, iceTransmission, iceVolumeDepth, rigidBaseColor, rigidEdgeBrightness, rigidEdgeColor, rigidFacetVariation, rigidFractureColor, rigidGrainDirection, rigidHighlightColor, rigidOpacity, rigidRoughness, rigidShadowColor, rigidTemplate.visual, rigidTemplateId, rigidVisualAnisotropy]);
  const iceFracture = useMemo(() => ({
    ...rigidFractureParameters,
    primaryFragmentMax: Math.max(rigidFractureParameters.primaryFragmentMin, rigidFractureParameters.primaryFragmentMax),
    crackBranchMax: Math.max(rigidFractureParameters.crackBranchMin, rigidFractureParameters.crackBranchMax),
    landingCrackEnergy: Math.max(rigidFractureParameters.landingChipEnergy, rigidFractureParameters.landingCrackEnergy),
    landingBreakEnergy: Math.max(rigidFractureParameters.landingChipEnergy, rigidFractureParameters.landingCrackEnergy, rigidFractureParameters.landingBreakEnergy),
  }), [rigidFractureParameters]);
  const icePreview = useMemo<ProceduralRigidBuildResult | null>(() => {
    if (mode !== "iceBody" || !drawing || drawing.points.length < 3) return null;
    return buildProceduralRigidBody({
      id: drawing.id,
      userPoints: drawing.points,
      closureMode: editingAsset ? "manual" : iceClosureMode,
      terrainContours: iceTerrainContours,
      routePreference: iceRoutePreference,
      seed: iceSeed,
      templateId: rigidTemplateId,
      elementTag: rigidElementTag,
      visual: iceVisual,
      physical: { ...rigidPhysical, anchoringMode: editingAsset ? "dynamic" : iceClosureMode === "terrain" ? "terrainAttached" : rigidPhysical.anchoringMode },
      fracture: iceFracture,
      snapDistance: 14 / Math.max(0.05, view.zoom),
    });
  }, [drawing, editingAsset, iceClosureMode, iceFracture, iceRoutePreference, iceSeed, iceTerrainContours, iceVisual, mode, rigidElementTag, rigidPhysical, rigidTemplateId, view.zoom]);

  const updateProject = useCallback((updater: (current: MapProject) => MapProject) => {
    setProject((current) => {
      const next = updater(current);
      projectRef.current = next;
      return next;
    });
  }, []);

  const updateAssets = useCallback((updater: (current: Record<string, MapAssetRef>) => Record<string, MapAssetRef>) => {
    setAssets((current) => {
      const next = updater(current);
      assetsRef.current = next;
      return next;
    });
  }, []);

  const patchSelectedAssetRigidTag = (elementTag: string) => {
    if (!selectedObjectAsset || !selectedObjectRigidOutline?.rigidBody) return;
    recordHistory();
    updateAssets((current) => {
      const asset = current[selectedObjectAsset.id];
      if (!asset) return current;
      return {
        ...current,
        [asset.id]: {
          ...asset,
          outlines: (asset.outlines || []).map((outline) => outline.id === selectedObjectRigidOutline.id && outline.rigidBody
            ? { ...outline, rigidBody: { ...outline.rigidBody, elementTag } }
            : outline),
        },
      };
    });
    setStatus("已修改素材程序刚体标签 · 有未同步修改");
  };

  const updateActiveOutlineCollections = useCallback((updater: (outlines: MapOutlineData[], draftOutlines: MapOutlineData[]) => { outlines: MapOutlineData[]; draftOutlines: MapOutlineData[] }) => {
    if (editingAssetId) {
      updateAssets((current) => {
        const asset = current[editingAssetId];
        if (!asset) return current;
        const next = updater(asset.outlines || [], asset.draftOutlines || []);
        return { ...current, [editingAssetId]: { ...asset, ...next } };
      });
      return;
    }
    updateProject((current) => ({ ...current, ...updater(current.outlines, current.draftOutlines) }));
  }, [editingAssetId, updateAssets, updateProject]);

  const recordHistory = useCallback(() => {
    const history = historyRef.current;
    const snapshot = { project: projectRef.current, assets: assetsRef.current };
    const previous = history.past[history.past.length - 1];
    if (previous?.project === snapshot.project && previous.assets === snapshot.assets) return;
    history.past.push(snapshot);
    if (history.past.length > 100) history.past.shift();
    history.future = [];
    setHistoryRevision((value) => value + 1);
  }, []);

  const clearCanvasSelection = useCallback(() => {
    setSelectedObjectId("");
    setSelectedOutlineId("");
    setSelectedMatterStrokeId("");
  }, []);

  const selectCanvasTarget = useCallback((kind: CanvasSelectionKind, id: string) => {
    setSelectedObjectId(kind === "object" ? id : "");
    setSelectedOutlineId(kind === "outline" ? id : "");
    setSelectedMatterStrokeId(kind === "matter" ? id : "");
  }, []);

  const applySnapshot = useCallback((snapshot: MapSnapshot) => {
    projectRef.current = snapshot.project;
    assetsRef.current = snapshot.assets;
    setProject(snapshot.project);
    setAssets(snapshot.assets);
    clearCanvasSelection();
    setDrawing(null);
    setMatterDrawing(null);
    setDropPreview(null);
  }, [clearCanvasSelection]);

  const undoMap = useCallback(() => {
    const history = historyRef.current;
    const snapshot = history.past.pop();
    if (!snapshot) return;
    history.future.push({ project: projectRef.current, assets: assetsRef.current });
    applySnapshot(snapshot);
    setStatus("已撤销 · 地图有未同步修改");
    setHistoryRevision((value) => value + 1);
  }, [applySnapshot]);

  const redoMap = useCallback(() => {
    const history = historyRef.current;
    const snapshot = history.future.pop();
    if (!snapshot) return;
    history.past.push({ project: projectRef.current, assets: assetsRef.current });
    applySnapshot(snapshot);
    setStatus("已重做 · 地图有未同步修改");
    setHistoryRevision((value) => value + 1);
  }, [applySnapshot]);

  const restoreProject = useCallback((nextProject: MapProject, nextAssets: Record<string, MapAssetRef>, message: string) => {
    const restoredAssets = ensureProgramRigidAssets(Object.fromEntries(Object.entries(nextAssets).map(([id, asset]) => [id, normalizeMapAsset(asset)])) as Record<string, MapAssetRef>);
    const restoredProject = ensureProgramRigidProject({
      ...createMapProject(),
      ...nextProject,
      version: 2 as const,
      objects: (nextProject.objects || []).map(normalizeMapObject),
      outlines: (nextProject.outlines || []).map(normalizeMapOutline).map(ensureProgramRigidOutline),
      draftOutlines: (nextProject.draftOutlines || []).map(normalizeMapOutline),
      matterStrokes: (nextProject.matterStrokes || []).map(normalizeMatterStroke),
    });
    projectRef.current = restoredProject;
    assetsRef.current = restoredAssets;
    setProject(restoredProject);
    setAssets(restoredAssets);
    historyRef.current = { past: [], future: [] };
    setHistoryRevision((value) => value + 1);
    clearCanvasSelection();
    setEditingAssetId("");
    setStatus(message);
  }, [clearCanvasSelection]);

  useEffect(() => {
    let cancelled = false;
    void loadMapDraft().then(async (draft) => {
      if (cancelled) return;
      let origin = readDocumentOrigin("map");
      if (origin.kind === "unity" && origin.name) {
        const unityOrigin = origin;
        try {
          const listResponse = await fetch("/api/unity/maps", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectPath: unityOrigin.projectPath }),
          });
          const listResult = await listResponse.json();
          if (listResponse.ok) {
            const maps = (listResult.maps || []) as UnityMapSummary[];
            const currentPathMap = maps.find((item) => item.jsonPath === unityOrigin.jsonPath);
            const nameMatches = maps.filter((item) => item.mapName === unityOrigin.name);
            if (currentPathMap?.mapName !== unityOrigin.name && nameMatches.length === 1) {
              const resolvedOrigin = { kind: "unity" as const, projectPath: unityOrigin.projectPath, jsonPath: nameMatches[0].jsonPath, name: unityOrigin.name };
              origin = resolvedOrigin;
              rememberUnityDocument("map", resolvedOrigin.projectPath, resolvedOrigin.jsonPath, resolvedOrigin.name);
              setEditingUnityMapPath(resolvedOrigin.jsonPath);
              setSelectedUnityMapPath(resolvedOrigin.jsonPath);
            }
          }
        } catch {
          // The draft can still be restored locally when the Unity project is temporarily unavailable.
        }
      }
      let draftProject: MapProject | null = null;
      if (draft?.project && origin.kind !== "default") {
        draftProject = draft.project;
        const requiredAssets = new Set([draftProject.backgroundAssetId, ...draftProject.objects.map((item) => item.assetId)].filter(Boolean));
        const missingAssets = [...requiredAssets].some((id) => !draft.assets?.[id]);
        if (missingAssets && origin.kind === "unity") {
          // Recover large images from Unity while retaining local collision and object edits.
        } else {
          const message = origin.kind === "unity" ? `已恢复上次地图 · ${draftProject.mapName}` : "已恢复地图本地草稿";
          restoreProject(draftProject, draft.assets || {}, message);
          return;
        }
      }
      if (origin.kind !== "unity") return;
      const response = await fetch("/api/unity/load-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: origin.projectPath, jsonPath: origin.jsonPath }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "上次地图载入失败");
      const unityAssets = Object.fromEntries((result.assets || []).map((asset: MapAssetRef) => [asset.id, { ...asset, url: asset.dataUrl || asset.url }]));
      const restoredAssets = { ...unityAssets, ...(draft?.assets || {}) } as Record<string, MapAssetRef>;
      const restoredProject = draftProject || result.project;
      if (!cancelled) {
        restoreProject(restoredProject, restoredAssets, `${draftProject ? "已恢复" : "已重新打开"}上次地图 · ${restoredProject.mapName}`);
        await saveMapDraft(restoredProject, restoredAssets);
      }
    }).catch((error) => console.warn("[Frame Action Map] 上次地图恢复失败，已使用默认数据", error)).finally(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, [restoreProject]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => void saveMapDraft(project, assets).catch((error) => console.warn("[Frame Action Map] 草稿保存失败", error)), 500);
    return () => window.clearTimeout(timer);
  }, [project, assets, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const persistImmediately = () => {
      void saveMapDraft(projectRef.current, assetsRef.current).catch((error) => console.warn("[Frame Action Map] 关闭前保存失败", error));
    };
    const handleVisibilityChange = () => { if (document.visibilityState === "hidden") persistImmediately(); };
    window.addEventListener("pagehide", persistImmediately);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", persistImmediately);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      persistImmediately();
    };
  }, [hydrated]);

  const fitCanvas = useCallback(() => {
    const rect = canvasWrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = Math.max(0.05, Math.min((rect.width - 44) / Math.max(1, documentWidth), (rect.height - 44) / Math.max(1, documentHeight), 2));
    setView({ zoom, panX: (rect.width - documentWidth * zoom) / 2, panY: (rect.height - documentHeight * zoom) / 2 });
  }, [documentWidth, documentHeight]);

  useEffect(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(1, Math.round(entry.contentRect.width));
      const height = Math.max(1, Math.round(entry.contentRect.height));
      setCanvasSize({ width, height });
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { fitCanvas(); }, [documentWidth, documentHeight, fitCanvas]);

  const getImage = useCallback((asset: MapAssetRef | null | undefined): HTMLImageElement | null => {
    if (!asset?.url) return null;
    const cached = imageCacheRef.current.get(asset.url);
    if (cached) return cached;
    const image = new Image();
    image.onload = () => setImageRevision((value) => value + 1);
    image.src = asset.url;
    imageCacheRef.current.set(asset.url, image);
    return image;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(canvasSize.width * pixelRatio));
    canvas.height = Math.max(1, Math.round(canvasSize.height * pixelRatio));
    canvas.style.width = `${canvasSize.width}px`;
    canvas.style.height = `${canvasSize.height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, canvasSize.width, canvasSize.height);
    context.fillStyle = "#d8d9d5";
    context.fillRect(0, 0, canvasSize.width, canvasSize.height);
    context.save();
    context.translate(view.panX, view.panY);
    context.scale(view.zoom, view.zoom);
    context.save();
    context.shadowColor = "rgba(29, 35, 32, 0.28)";
    context.shadowBlur = 18 / view.zoom;
    context.shadowOffsetY = 5 / view.zoom;
    context.fillStyle = "#f8f8f5";
    context.fillRect(0, 0, documentWidth, documentHeight);
    context.restore();
    if (editingAsset) {
      const checkerSize = 24;
      for (let y = 0; y < documentHeight; y += checkerSize) {
        for (let x = 0; x < documentWidth; x += checkerSize) {
          context.fillStyle = ((x / checkerSize + y / checkerSize) % 2) === 0 ? "#f5f5f2" : "#e3e5e1";
          context.fillRect(x, y, checkerSize, checkerSize);
        }
      }
      const image = getImage(editingAsset);
      if (image?.complete) context.drawImage(image, 0, 0, documentWidth, documentHeight);
    } else if (backgroundAsset) {
      const image = getImage(backgroundAsset);
      if (image?.complete) context.drawImage(image, 0, 0, project.width, project.height);
    } else {
      context.strokeStyle = "#d5d8d3";
      context.lineWidth = 1 / view.zoom;
      for (let x = 0; x <= project.width; x += 64) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, project.height); context.stroke(); }
      for (let y = 0; y <= project.height; y += 64) { context.beginPath(); context.moveTo(0, y); context.lineTo(project.width, y); context.stroke(); }
    }
    const drawMatterStroke = (stroke: MapMatterStrokeData, draft = false, selected = false) => {
      if (!stroke.points.length) return;
      context.save();
      context.strokeStyle = stroke.profile.visual.baseColor;
      context.fillStyle = stroke.profile.visual.baseColor;
      context.globalAlpha = Math.max(0.08, Math.min(1, stroke.profile.visual.opacity)) *
        (draft ? 0.88 : stroke.carrier === "gas" ? 0.52 : 0.74);
      context.lineWidth = Math.max(1, stroke.radius * 2);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.setLineDash(stroke.carrier === "gas" ? [Math.max(4, stroke.radius * 1.4), Math.max(3, stroke.radius)] : []);
      context.beginPath();
      stroke.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
      if (stroke.points.length === 1) {
        context.arc(stroke.points[0].x, stroke.points[0].y, stroke.radius, 0, Math.PI * 2);
        context.fill();
      } else context.stroke();
      context.restore();
      if (selected) {
        context.save();
        context.globalAlpha = 1;
        context.strokeStyle = "#f0a51d";
        context.lineWidth = 3 / view.zoom;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.setLineDash([8 / view.zoom, 5 / view.zoom]);
        context.beginPath();
        if (stroke.points.length === 1) {
          context.arc(stroke.points[0].x, stroke.points[0].y, stroke.radius + 3 / view.zoom, 0, Math.PI * 2);
        } else {
          stroke.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
        }
        context.stroke();
        context.restore();
      }
    };
    if (!editingAsset) {
      (project.matterStrokes || []).forEach((stroke) => drawMatterStroke(stroke, false, stroke.id === selectedMatterStrokeId));
      if (matterDrawing) drawMatterStroke(matterDrawing, true);
    }
    if (!editingAsset) for (const object of project.objects) {
      const asset = assets[object.assetId];
      const image = getImage(asset);
      if (!asset || !image?.complete) continue;
      const width = asset.width * object.scale;
      const height = asset.height * object.scale;
      if (object.mode === "dynamic") {
        const currentX = object.x + width / 2;
        const currentY = object.y + height / 2;
        const distance = Math.max(0.1, object.motion.rangeMeters) * Math.max(1, project.pixelsPerUnit);
        const initialProgress = Math.max(0, Math.min(1, object.motion.initialProgress));
        const startX = object.motion.direction === "vertical" ? currentX : currentX - distance * initialProgress;
        const startY = object.motion.direction === "vertical" ? currentY + distance * initialProgress : currentY;
        const endX = object.motion.direction === "vertical" ? startX : startX + distance;
        const endY = object.motion.direction === "vertical" ? startY - distance : startY;
        context.save();
        context.strokeStyle = "#d88b20";
        context.fillStyle = "#d88b20";
        context.lineWidth = 2 / view.zoom;
        context.setLineDash([9 / view.zoom, 6 / view.zoom]);
        context.beginPath();
        context.moveTo(startX, startY);
        context.lineTo(endX, endY);
        context.stroke();
        context.setLineDash([]);
        context.beginPath();
        context.arc(startX, startY, 4 / view.zoom, 0, Math.PI * 2);
        context.arc(endX, endY, 4 / view.zoom, 0, Math.PI * 2);
        context.fill();
        if (object.id === selectedObjectId) {
          context.font = `${12 / view.zoom}px sans-serif`;
          context.fillText(`${object.motion.rangeMeters}m`, (startX + endX) / 2 + 7 / view.zoom, (startY + endY) / 2 - 7 / view.zoom);
        }
        context.restore();
      }
      context.save();
      context.translate(object.x + width / 2, object.y + height / 2);
      context.rotate((object.rotation * Math.PI) / 180);
      context.globalAlpha = object.layer === "collision" ? 0.65 : object.layer === "rigid" ? 0.82 : object.layer === "occlusion" ? 0.8 : 1;
      context.drawImage(image, -width / 2, -height / 2, width, height);
      context.globalAlpha = 1;
      context.strokeStyle = object.id === selectedObjectId ? "#d49a25" : layerColors[object.layer];
      context.lineWidth = (object.id === selectedObjectId ? 3 : 1.5) / view.zoom;
      context.setLineDash(object.id === selectedObjectId ? [9 / view.zoom, 5 / view.zoom] : [5 / view.zoom, 4 / view.zoom]);
      context.strokeRect(-width / 2, -height / 2, width, height);
      context.restore();
    }
    if (!editingAsset && dropPreview) {
      const asset = assets[dropPreview.assetId];
      const image = getImage(asset);
      if (asset && image?.complete) {
        const scale = defaultObjectScale(asset, project);
        const width = asset.width * scale;
        const height = asset.height * scale;
        context.save();
        context.globalAlpha = 0.62;
        context.drawImage(image, dropPreview.point.x - width / 2, dropPreview.point.y - height / 2, width, height);
        context.globalAlpha = 1;
        context.strokeStyle = layerColors[asset.defaultLayer];
        context.lineWidth = 2 / view.zoom;
        context.setLineDash([8 / view.zoom, 5 / view.zoom]);
        context.strokeRect(dropPreview.point.x - width / 2, dropPreview.point.y - height / 2, width, height);
        context.restore();
      }
    }
    const drawProgramRigidBody = (outline: MapOutlineData, draft: boolean) => {
      const rigidBody = outline.rigidBody;
      if (!rigidBody || outline.points.length < 3) return;
      const points = outline.points;
      const bounds = points.reduce((value, point) => ({
        left: Math.min(value.left, point.x),
        top: Math.min(value.top, point.y),
        right: Math.max(value.right, point.x),
        bottom: Math.max(value.bottom, point.y),
      }), { left: points[0].x, top: points[0].y, right: points[0].x, bottom: points[0].y });
      const pathBody = () => {
        context.beginPath();
        points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
        context.closePath();
      };
      context.save();
      const visual = rigidBody.visual;
      context.globalAlpha = (draft ? 0.78 : 1) * visual.opacity;
      const bodyWidth = Math.max(1, bounds.right - bounds.left);
      const bodyHeight = Math.max(1, bounds.bottom - bounds.top);
      const bodySpan = Math.max(bodyWidth, bodyHeight);
      const centerX = (bounds.left + bounds.right) * 0.5;
      const centerY = (bounds.top + bounds.bottom) * 0.5;
      const lightRadians = visual.lightAngleDegrees * Math.PI / 180;
      const lightX = Math.cos(lightRadians);
      const lightY = Math.sin(lightRadians);
      pathBody();
      const bodyGradient = context.createLinearGradient(
        centerX - lightX * bodySpan * 0.55,
        centerY - lightY * bodySpan * 0.55,
        centerX + lightX * bodySpan * 0.55,
        centerY + lightY * bodySpan * 0.55,
      );
      bodyGradient.addColorStop(0, visual.shadowColor);
      bodyGradient.addColorStop(0.48, visual.baseColor);
      bodyGradient.addColorStop(1, visual.highlightColor);
      context.fillStyle = bodyGradient;
      context.fill();
      context.save();
      pathBody();
      context.clip();
      for (const facet of rigidBody.facets) {
        const shade = Math.max(0, Math.min(1, facet.shade));
        const centroidX = (facet.points[0].x + facet.points[1].x + facet.points[2].x) / 3;
        const centroidY = (facet.points[0].y + facet.points[1].y + facet.points[2].y) / 3;
        const pseudoAngle = previewNoise(rigidBody.seed, facet.id * 977 + 31) * Math.PI * 2;
        const pseudoLight = Math.max(0, Math.cos(pseudoAngle) * lightX + Math.sin(pseudoAngle) * lightY);
        const facetSpan = Math.max(5, Math.max(
          Math.hypot(facet.points[1].x - facet.points[0].x, facet.points[1].y - facet.points[0].y),
          Math.hypot(facet.points[2].x - facet.points[1].x, facet.points[2].y - facet.points[1].y),
          Math.hypot(facet.points[0].x - facet.points[2].x, facet.points[0].y - facet.points[2].y),
        ));
        const facetGradient = context.createLinearGradient(
          centroidX - lightX * facetSpan * 0.5,
          centroidY - lightY * facetSpan * 0.5,
          centroidX + lightX * facetSpan * 0.5,
          centroidY + lightY * facetSpan * 0.5,
        );
        facetGradient.addColorStop(0, mixHexColor(visual.shadowColor, visual.baseColor, 0.22 + shade * 0.42));
        facetGradient.addColorStop(1, mixHexColor(visual.baseColor, visual.highlightColor, 0.18 + pseudoLight * visual.specularStrength * 0.55));
        context.fillStyle = facetGradient;
        context.beginPath();
        facet.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
        context.closePath();
        context.fill();
        context.strokeStyle = colorWithAlpha(visual.highlightColor, 0.08 + visual.textureStrength * 0.2 + pseudoLight * 0.08);
        context.lineWidth = (0.45 + visual.volumeDepth * 0.35) / view.zoom;
        context.stroke();
      }
      const inclusionCount = Math.min(72, Math.round(bodyWidth * bodyHeight / Math.max(140, visual.facetScale * visual.facetScale) * (1 + visual.inclusionDensity * 5)));
      for (let index = 0; index < inclusionCount; index += 1) {
        const x = bounds.left + bodyWidth * previewNoise(rigidBody.seed, 4103 + index * 67);
        const y = bounds.top + bodyHeight * previewNoise(rigidBody.seed, 8209 + index * 71);
        const radius = (0.45 + previewNoise(rigidBody.seed, 12011 + index * 53) * 2.2) * (0.5 + visual.inclusionDensity);
        context.save();
        context.translate(x, y);
        context.rotate(previewNoise(rigidBody.seed, 17027 + index * 43) * Math.PI);
        context.beginPath();
        context.ellipse(0, 0, radius * 1.8, radius * 0.52, 0, 0, Math.PI * 2);
        context.fillStyle = index % 3 === 0
          ? colorWithAlpha(visual.highlightColor, 0.06 + visual.inclusionDensity * 0.2)
          : colorWithAlpha(visual.shadowColor, 0.035 + visual.inclusionDensity * 0.13);
        context.fill();
        context.restore();
      }
      const microCrackCount = Math.min(48, Math.round((bodyWidth + bodyHeight) / Math.max(18, visual.facetScale) * visual.microCrackDensity * 5));
      for (let index = 0; index < microCrackCount; index += 1) {
        const x = bounds.left + bodyWidth * previewNoise(rigidBody.seed, 23003 + index * 61);
        const y = bounds.top + bodyHeight * previewNoise(rigidBody.seed, 29009 + index * 79);
        const direction = previewNoise(rigidBody.seed, 31013 + index * 83) * Math.PI * 2;
        const length = Math.max(3, visual.facetScale * (0.18 + previewNoise(rigidBody.seed, 37003 + index * 89) * 0.32));
        const bend = (previewNoise(rigidBody.seed, 41011 + index * 97) - 0.5) * length * 0.42;
        const dx = Math.cos(direction) * length;
        const dy = Math.sin(direction) * length;
        const nx = -Math.sin(direction) * bend;
        const ny = Math.cos(direction) * bend;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + dx * 0.48 + nx, y + dy * 0.48 + ny);
        context.lineTo(x + dx, y + dy);
        context.strokeStyle = colorWithAlpha(visual.highlightColor, 0.1 + visual.microCrackDensity * 0.34);
        context.lineWidth = (0.45 + visual.textureStrength * 0.4) / view.zoom;
        context.stroke();
      }
      context.restore();
      context.setLineDash([]);
      context.lineCap = "round";
      context.lineJoin = "round";
      const signedArea = points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length];
        return sum + point.x * next.y - next.x * point.y;
      }, 0);
      for (let index = 0; index < points.length; index += 1) {
        const start = points[index];
        const end = points[(index + 1) % points.length];
        const attached = rigidBody.edgeRoles[index] === "terrainAttached";
        const edgeX = end.x - start.x;
        const edgeY = end.y - start.y;
        const inverseLength = 1 / Math.max(0.0001, Math.hypot(edgeX, edgeY));
        const normalX = (signedArea >= 0 ? edgeY : -edgeY) * inverseLength;
        const normalY = (signedArea >= 0 ? -edgeX : edgeX) * inverseLength;
        const edgeLight = Math.max(0, normalX * lightX + normalY * lightY);
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.strokeStyle = attached ? "#2ed5b5" : colorWithAlpha(visual.edgeColor, 0.42 + visual.edgeBrightness * 0.32 + edgeLight * 0.25);
        context.lineWidth = (attached ? 2.1 : Math.max(1.4, visual.edgeWidthPixels * (0.58 + edgeLight * 0.48))) / view.zoom;
        context.setLineDash(attached ? [6 / view.zoom, 4 / view.zoom] : []);
        context.stroke();
      }
      context.restore();
    };
    const drawOutline = (outline: MapOutlineData, draft: boolean) => {
      if (outline.points.length < 2) return;
      if (outline.rigidBody && outline.closed) {
        drawProgramRigidBody(outline, draft);
        return;
      }
      context.save();
      const rectangleStyle = outline.shape === "groundLine" ? rectangleCollisionStyle(outline.collisionType, outline.sideCollision !== false) : null;
      context.strokeStyle = outline.layer === "occlusion" ? layerColors.occlusion : outline.layer === "rigid" ? elementColors[outline.element] : rectangleStyle?.stroke || layerColors.collision;
      context.fillStyle = outline.layer === "occlusion" ? "rgba(71,103,173,.15)" : outline.layer === "rigid" ? `${elementColors[outline.element]}38` : rectangleStyle?.fill || "rgba(209,83,67,.18)";
      context.lineWidth = (draft ? 3 : 2) / view.zoom;
      context.setLineDash(draft ? [8 / view.zoom, 5 / view.zoom] : []);
      if (outline.shape === "groundLine" && outline.points.length >= 4) {
        context.beginPath();
        outline.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
        context.closePath();
        context.fill();
        const segments: [MapPoint, MapPoint][] = [[outline.points[0], outline.points[1]]];
        if (outline.collisionType !== "oneWay") segments.push([outline.points[3], outline.points[2]]);
        if (outline.sideCollision !== false) segments.push([outline.points[0], outline.points[3]], [outline.points[1], outline.points[2]]);
        context.beginPath();
        segments.forEach(([start, end]) => { context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); });
        context.stroke();
      } else {
        context.beginPath();
        outline.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
        if (outline.closed && outline.points.length > 2) { context.closePath(); context.fill(); }
        context.stroke();
      }
      if (outline.shape === "groundLine" && outline.collisionType === "oneWay" && outline.points.length >= 2) {
        const start = outline.points[0];
        const end = outline.points[1];
        const centerX = (start.x + end.x) * 0.5;
        const centerY = (start.y + end.y) * 0.5;
        const arrowSize = 13 / view.zoom;
        context.setLineDash([]);
        context.lineWidth = 2 / view.zoom;
        context.beginPath();
        context.moveTo(centerX, centerY);
        context.lineTo(centerX, centerY - arrowSize);
        context.lineTo(centerX - arrowSize * 0.35, centerY - arrowSize * 0.65);
        context.moveTo(centerX, centerY - arrowSize);
        context.lineTo(centerX + arrowSize * 0.35, centerY - arrowSize * 0.65);
        context.stroke();
      }
      context.restore();
    };
    activeOutlines.forEach((outline) => drawOutline(outline, false));
    activeDraftOutlines.forEach((outline) => drawOutline(outline, true));
    if (selectedOutline) {
      context.save();
      context.strokeStyle = "#f0a51d";
      context.fillStyle = "#fff7df";
      context.lineWidth = 3 / view.zoom;
      context.setLineDash([9 / view.zoom, 5 / view.zoom]);
      context.beginPath();
      selectedOutline.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
      if (selectedOutline.closed && selectedOutline.points.length > 2) context.closePath();
      context.stroke();
      context.setLineDash([]);
      for (const point of selectedOutline.points) {
        const size = 5 / view.zoom;
        context.fillRect(point.x - size * 0.5, point.y - size * 0.5, size, size);
        context.strokeRect(point.x - size * 0.5, point.y - size * 0.5, size, size);
      }
      context.restore();
    }
    if (drawing) {
      if (mode === "iceBody" && icePreview?.ok && icePreview.rigidBody) {
        drawOutline({ ...drawing, points: icePreview.points, closed: true, rigidBody: icePreview.rigidBody }, true);
      } else {
        drawOutline(drawing, true);
        if (mode === "iceBody" && icePreview && !icePreview.ok) {
          context.save();
          context.strokeStyle = "#e64b45";
          context.lineWidth = 3 / view.zoom;
          context.setLineDash([7 / view.zoom, 4 / view.zoom]);
          context.beginPath();
          drawing.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
          context.stroke();
          context.restore();
        }
      }
    }
    context.strokeStyle = "#5e6662";
    context.lineWidth = 1 / view.zoom;
    context.setLineDash([]);
    context.strokeRect(0, 0, documentWidth, documentHeight);
    context.restore();
  }, [activeDraftOutlines, activeOutlines, assets, backgroundAsset, canvasSize, documentHeight, documentWidth, drawing, dropPreview, editingAsset, getImage, icePreview, imageRevision, matterDrawing, mode, project, selectedMatterStrokeId, selectedObjectId, selectedOutline, view]);

  const rawMapPointFromClient = (clientX: number, clientY: number): MapPoint => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left - view.panX) / view.zoom, y: (clientY - rect.top - view.panY) / view.zoom };
  };

  const mapPointFromClient = (clientX: number, clientY: number): MapPoint => {
    const point = rawMapPointFromClient(clientX, clientY);
    return { x: Math.max(0, Math.min(documentWidth, point.x)), y: Math.max(0, Math.min(documentHeight, point.y)) };
  };

  const isPointInsideMap = (point: MapPoint): boolean => point.x >= 0 && point.x <= documentWidth && point.y >= 0 && point.y <= documentHeight;

  const hitObject = (point: MapPoint): MapObjectData | null => {
    if (editingAsset) return null;
    for (let index = project.objects.length - 1; index >= 0; index -= 1) {
      const object = project.objects[index];
      const asset = assets[object.assetId];
      if (!asset) continue;
      const width = asset.width * object.scale;
      const height = asset.height * object.scale;
      const centerX = object.x + width / 2;
      const centerY = object.y + height / 2;
      const radians = (-object.rotation * Math.PI) / 180;
      const dx = point.x - centerX;
      const dy = point.y - centerY;
      const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
      const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
      if (Math.abs(localX) <= width / 2 && Math.abs(localY) <= height / 2) return object;
    }
    return null;
  };

  const hitActiveOutline = (point: MapPoint): MapOutlineData | null => {
    const tolerance = 7 / Math.max(0.05, view.zoom);
    for (let index = activeOutlines.length - 1; index >= 0; index -= 1) {
      if (outlineContainsPoint(activeOutlines[index], point, tolerance)) return activeOutlines[index];
    }
    return null;
  };

  const hitMatterStroke = (point: MapPoint): MapMatterStrokeData | null => {
    if (editingAsset) return null;
    const strokes = project.matterStrokes || [];
    const tolerance = 5 / Math.max(0.05, view.zoom);
    for (let index = strokes.length - 1; index >= 0; index -= 1) {
      if (matterStrokeContainsPoint(strokes[index], point, tolerance)) return strokes[index];
    }
    return null;
  };

  const addObject = (asset: MapAssetRef, point: MapPoint) => {
    recordHistory();
    const scale = defaultObjectScale(asset, projectRef.current);
    const object: MapObjectData = {
      id: uid("map_object"),
      assetId: asset.id,
      layer: asset.defaultLayer,
      elementTag: asset.outlines?.find((outline) => outline.layer === "rigid" && outline.rigidBody)?.rigidBody?.elementTag || rigidElementTag || "untagged",
      mode: "static",
      collisionType: "oneWay",
      motion: { direction: "horizontal", speedMetersPerSecond: 2, rangeMeters: 10, initialProgress: 0, pingPong: true, endpointPauseSeconds: 0, phaseSeconds: 0 },
      x: Math.round(point.x - asset.width * scale / 2),
      y: Math.round(point.y - asset.height * scale / 2),
      scale,
      rotation: 0,
      z: 0,
    };
    updateProject((current) => ({ ...current, objects: [...current.objects, object] }));
    selectCanvasTarget("object", object.id);
    setMode("select");
    setStatus("地图有未同步修改");
  };

  const startPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button === 1 || event.button === 2 || (event.button === 0 && mode === "pan")) {
      event.preventDefault();
      pointerRef.current = { type: "pan", pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY, startPanX: view.panX, startPanY: view.panY };
      setIsPanning(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const rawPoint = rawMapPointFromClient(event.clientX, event.clientY);
    const point = mapPointFromClient(event.clientX, event.clientY);
    if (!editingAsset && (mode === "liquid" || mode === "gas")) {
      if (!isPointInsideMap(rawPoint)) return;
      const stroke: MapMatterStrokeData = {
        id: uid("map_matter"),
        carrier: mode,
        elementTag: matterElementTag.trim() || "untagged",
        profile: normalizeMatterProfile(mode, matterElementTag, activeMatterProfile),
        radius: matterBrushRadius,
        points: [point],
      };
      matterDrawingRef.current = stroke;
      setMatterDrawing(stroke);
      pointerRef.current = { type: "matter", pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (mode === "groundLine" || mode === "collision" || mode === "rigid" || mode === "iceBody" || mode === "occlusion") {
      if (!isPointInsideMap(rawPoint)) return;
      const outline: MapOutlineData = {
        id: uid("map_outline"),
        layer: mode === "occlusion" ? "occlusion" : mode === "rigid" || mode === "iceBody" ? "rigid" : "collision",
        element: mode === "iceBody" ? "ice" : matterElement,
        shape: mode === "groundLine" ? "groundLine" : "polygon",
        collisionType: mode === "occlusion" ? "trigger" : mode === "groundLine" ? groundCollisionType : "solid",
        sideCollision: mode === "groundLine" ? groundSideCollision : true,
        thickness: mode === "groundLine" ? groundThickness : 0,
        closed: false,
        points: mode === "groundLine" ? createGroundLinePoints(point, point, groundThickness) : [point],
      };
      drawingRef.current = outline;
      setDrawing(outline);
      pointerRef.current = { type: "draw", pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY, drawMode: mode };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const outline = hitActiveOutline(point);
    if (outline) {
      selectCanvasTarget("outline", outline.id);
      setStatus(`已选中${selectionOutlineLabel(outline)}`);
      return;
    }
    const object = hitObject(point);
    if (object) {
      selectCanvasTarget("object", object.id);
      pointerRef.current = { type: "drag", pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY, objectId: object.id, offsetX: point.x - object.x, offsetY: point.y - object.y };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const matterStroke = hitMatterStroke(point);
    if (matterStroke) {
      selectCanvasTarget("matter", matterStroke.id);
      setStatus(`已选中${matterStroke.carrier === "gas" ? "气体" : "液体"}画笔 · ${matterStroke.elementTag || "无标签"}`);
      return;
    }
    clearCanvasSelection();
    pointerRef.current = { type: "pan", pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY, startPanX: view.panX, startPanY: view.panY };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const movePointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const operation = pointerRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    if (operation.type === "pan") {
      setView((current) => ({ ...current, panX: (operation.startPanX || 0) + event.clientX - operation.startClientX, panY: (operation.startPanY || 0) + event.clientY - operation.startClientY }));
      return;
    }
    const point = mapPointFromClient(event.clientX, event.clientY);
    if (operation.type === "drag" && operation.objectId) {
      if (!operation.historyRecorded) {
        recordHistory();
        operation.historyRecorded = true;
      }
      updateProject((current) => ({ ...current, objects: current.objects.map((object) => object.id === operation.objectId ? { ...object, x: Math.round(point.x - (operation.offsetX || 0)), y: Math.round(point.y - (operation.offsetY || 0)) } : object) }));
      setStatus("地图有未同步修改");
      return;
    }
    if (operation.type === "draw") {
      setDrawing((current) => {
        if (!current) return current;
        if (current.shape === "groundLine") {
          const snapTolerance = autoHorizontalSnap ? HORIZONTAL_SNAP_SCREEN_PX / view.zoom : 0;
          const next = { ...current, points: createGroundLinePoints(current.points[0], point, current.thickness, snapTolerance) };
          drawingRef.current = next;
          return next;
        }
        const last = current.points[current.points.length - 1];
        if (pointDistance(last, point) < 4 / view.zoom) return current;
        const next = { ...current, points: [...current.points, point] };
        drawingRef.current = next;
        return next;
      });
    }
    if (operation.type === "matter") {
      setMatterDrawing((current) => {
        if (!current) return current;
        const last = current.points[current.points.length - 1];
        if (pointDistance(last, point) < Math.max(2, matterBrushRadius * 0.22) / view.zoom) return current;
        const next = { ...current, points: [...current.points, point] };
        matterDrawingRef.current = next;
        return next;
      });
    }
  };

  const endPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const operation = pointerRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    pointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (operation.type === "pan") {
      setIsPanning(false);
      return;
    }
    if (operation.type === "matter") {
      const finishedMatter = matterDrawingRef.current;
      if (finishedMatter?.points.length) {
        recordHistory();
        updateProject((current) => ({ ...current, matterStrokes: [...(current.matterStrokes || []), finishedMatter] }));
        selectCanvasTarget("matter", finishedMatter.id);
        setStatus("元素物质画笔有未同步修改");
      }
      matterDrawingRef.current = null;
      setMatterDrawing(null);
      return;
    }
    const finishedDrawing = drawingRef.current;
    if (operation.type !== "draw" || !finishedDrawing) return;
    const outlineSource = editingAssetId ? assetsRef.current[editingAssetId] : projectRef.current;
    const currentOutlines = outlineSource?.outlines || [];
    const currentDraftOutlines = outlineSource?.draftOutlines || [];
    if (operation.drawMode === "iceBody") {
      const result = buildProceduralRigidBody({
        id: finishedDrawing.id,
        userPoints: finishedDrawing.points,
        closureMode: editingAssetId ? "manual" : iceClosureMode,
        terrainContours: iceTerrainContours,
        routePreference: iceRoutePreference,
        seed: iceSeed,
        templateId: rigidTemplateId,
        elementTag: rigidElementTag,
        visual: iceVisual,
        physical: { ...rigidPhysical, anchoringMode: editingAssetId ? "dynamic" : iceClosureMode === "terrain" ? "terrainAttached" : rigidPhysical.anchoringMode },
        fracture: iceFracture,
        snapDistance: 14 / Math.max(0.05, view.zoom),
      });
      if (result.ok && result.rigidBody) {
        const existingRigid = currentOutlines.filter((outline) => outline.layer === "rigid");
        if (editingAssetId && existingRigid.length > 0) {
          setStatus("物体素材的程序刚体只支持一个闭合轮廓；请先删除已有刚体轮廓");
          drawingRef.current = null;
          setDrawing(null);
          return;
        }
        recordHistory();
        const rigidOutline: MapOutlineData = { ...finishedDrawing, layer: "rigid", closed: true, points: result.points, rigidBody: result.rigidBody };
        updateActiveOutlineCollections((outlines, draftOutlines) => ({ outlines: [...outlines, rigidOutline], draftOutlines }));
        selectCanvasTarget("outline", rigidOutline.id);
        setIceSeed((value) => (value + 1) >>> 0 || 1);
        setStatus(`已创建${PROCEDURAL_RIGID_TEMPLATES[result.rigidBody.templateId].label}程序刚体 · ${result.rigidBody.facets.length} 个分面${result.candidates.length > 1 ? ` · 使用${iceRoutePreference === "alternate" ? "另一侧" : "较短"}地形路径` : ""}`);
      } else {
        setStatus(`程序刚体未创建：${result.message}`);
      }
      drawingRef.current = null;
      setDrawing(null);
      return;
    }
    if (finishedDrawing.shape === "groundLine") {
      if (pointDistance(finishedDrawing.points[0], finishedDrawing.points[1]) > 3 / view.zoom) {
        recordHistory();
        updateActiveOutlineCollections((outlines, draftOutlines) => ({ outlines: [...outlines, { ...finishedDrawing, closed: true }], draftOutlines }));
        selectCanvasTarget("outline", finishedDrawing.id);
      }
    } else if (finishedDrawing.points.length >= 2) {
      const result = finishBrushDrawing(finishedDrawing, currentDraftOutlines);
      const completedOutline = result.outline ? (editingAssetId ? ensureProgramRigidAssetOutline(result.outline) : ensureProgramRigidOutline(result.outline)) : result.outline;
      if (result.outline || result.draftOutlines !== currentDraftOutlines) {
        recordHistory();
        updateActiveOutlineCollections(() => ({
          outlines: completedOutline ? [...currentOutlines, completedOutline] : currentOutlines,
          draftOutlines: result.draftOutlines,
        }));
        if (completedOutline) selectCanvasTarget("outline", completedOutline.id);
      }
    }
    drawingRef.current = null;
    setDrawing(null);
    setStatus(editingAssetId ? "物体轮廓模板有未同步修改" : "地图有未同步修改");
  };

  const zoomCanvas = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const mapX = (cursorX - view.panX) / view.zoom;
    const mapY = (cursorY - view.panY) / view.zoom;
    const zoom = Math.min(6, Math.max(0.04, view.zoom * Math.exp(-event.deltaY * 0.0015)));
    setView({ zoom, panX: cursorX - mapX * zoom, panY: cursorY - mapY * zoom });
  };

  const startAssetDrag = (event: React.DragEvent<HTMLElement>, asset: MapAssetRef) => {
    if (editingAsset || (event.target as HTMLElement).closest("select, button")) {
      event.preventDefault();
      return;
    }
    draggedAssetIdRef.current = asset.id;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("text/plain", `map-asset:${asset.id}`);
  };

  const stopAssetDrag = () => {
    draggedAssetIdRef.current = "";
    setDropPreview(null);
  };

  const dragAssetOverCanvas = (event: React.DragEvent<HTMLDivElement>) => {
    if (editingAsset) return;
    const assetId = draggedAssetIdRef.current;
    if (!assetId || !assets[assetId]) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const rawPoint = rawMapPointFromClient(event.clientX, event.clientY);
    setDropPreview(isPointInsideMap(rawPoint) ? { assetId, point: rawPoint } : null);
  };

  const leaveCanvasDrag = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropPreview(null);
  };

  const dropAssetOnCanvas = (event: React.DragEvent<HTMLDivElement>) => {
    if (editingAsset) return;
    event.preventDefault();
    const transferred = event.dataTransfer.getData("text/plain");
    const assetId = transferred.startsWith("map-asset:") ? transferred.slice("map-asset:".length) : draggedAssetIdRef.current;
    const asset = assets[assetId];
    const rawPoint = rawMapPointFromClient(event.clientX, event.clientY);
    if (asset && isPointInsideMap(rawPoint)) addObject(asset, rawPoint);
    stopAssetDrag();
  };

  const exportMapBundle = () => {
    const cleanName = (project.mapName || "地图").replace(/[\\/:*?"<>|]+/g, "_");
    const persistentProject = ensureProgramRigidProject(project);
    const persistentAssets = ensureProgramRigidAssets(assets);
    downloadJson({
      format: "frame-action-map-bundle",
      version: 2,
      project: persistentProject,
      assets: Object.fromEntries(Object.entries(persistentAssets).map(([id, asset]) => [id, { ...asset, url: asset.dataUrl || asset.url }])),
    }, `${cleanName}.frame-action-map.json`);
    setStatus("已导出完整地图 JSON");
  };

  const importMapBundle = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      const nextProject = parsed?.format === "frame-action-map-bundle" ? parsed.project : parsed;
      const nextAssets = parsed?.format === "frame-action-map-bundle" ? parsed.assets : parsed.assets;
      if (nextProject?.format !== "frame-action-map" || !nextAssets || typeof nextAssets !== "object") throw new Error("请选择由本工具导出的完整地图 JSON");
      const assetRecord = Array.isArray(nextAssets)
        ? Object.fromEntries(nextAssets.filter((asset: MapAssetRef) => asset?.id).map((asset: MapAssetRef) => [asset.id, asset]))
        : nextAssets;
      const missingData = Object.values(assetRecord as Record<string, MapAssetRef>).some((asset) => !asset.dataUrl && !asset.url?.startsWith("data:"));
      if (missingData) throw new Error("该 JSON 只记录了 Unity 资源路径，请从“地图项目”中打开它");
      const importingIntoOpenedMap = Boolean(editingUnityMapPath);
      restoreProject(
        nextProject,
        assetRecord as Record<string, MapAssetRef>,
        importingIntoOpenedMap ? `已载入地图 JSON · 将更新已打开地图` : `已载入地图 JSON · 当前仍为创建新地图`,
      );
      if (importingIntoOpenedMap) {
        setSelectedUnityMapPath(editingUnityMapPath);
        const currentOrigin = readDocumentOrigin("map");
        if (boundMapUnityProjectPath) rememberUnityDocument("map", boundMapUnityProjectPath, editingUnityMapPath, currentOrigin.kind === "unity" ? currentOrigin.name : nextProject.mapName);
      } else {
        rememberLocalDocument("map");
        setSelectedUnityMapPath("");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "地图 JSON 打开失败");
    }
  };

  const applyBackgroundReplacement = (asset: MapAssetRef, scaleMapData: boolean) => {
    const previousBackgroundId = projectRef.current.backgroundAssetId;
    recordHistory();
    updateAssets((current) => {
      const next = { ...current, [asset.id]: asset };
      if (previousBackgroundId && previousBackgroundId !== asset.id) delete next[previousBackgroundId];
      return next;
    });
    updateProject((current) => {
      const next = scaleMapData ? scaleProjectForBackground(current, asset) : { ...current, width: asset.width, height: asset.height, backgroundAssetId: asset.id };
      return { ...next, mapName: current.mapName === "新地图" ? asset.name.replace(/\.[^.]+$/, "") : current.mapName };
    });
    setPendingBackgroundReplacement(null);
    setStatus(scaleMapData ? "已替换背景并缩放地图数据 · 有未同步修改" : "已替换背景 · 有未同步修改");
  };

  const importBackground = async (file: File) => {
    const asset = await createMapAsset(file, "background", "decoration");
    const current = projectRef.current;
    if (current.backgroundAssetId && (current.width !== asset.width || current.height !== asset.height)) {
      setPendingBackgroundReplacement({ asset });
      return;
    }
    applyBackgroundReplacement(asset, false);
  };

  const importObjects = async (files: FileList) => {
    const loaded = await Promise.all(Array.from(files).filter((file) => file.type.startsWith("image/")).map((file) => createMapAsset(file, "object", activeLayer)));
    if (!loaded.length) return;
    loaded.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    recordHistory();
    updateAssets((current) => ({ ...current, ...Object.fromEntries(loaded.map((asset) => [asset.id, asset])) }));
    setStatus(`已导入 ${loaded.length} 个地图物体 · 有未同步修改`);
  };

  const dropBackgroundFile = (event: React.DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setImportDropTarget(null);
    const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/"));
    if (file) void importBackground(file);
  };

  const dropObjectFiles = (event: React.DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setImportDropTarget(null);
    if (event.dataTransfer.files.length) void importObjects(event.dataTransfer.files);
  };

  const patchSelectedObject = (patch: Partial<MapObjectData>) => {
    if (!selectedObjectId) return;
    recordHistory();
    updateProject((current) => ({ ...current, objects: current.objects.map((object) => object.id === selectedObjectId ? { ...object, ...patch } : object) }));
    setStatus("地图有未同步修改");
  };

  const patchSelectedOutline = (updater: (outline: MapOutlineData) => MapOutlineData) => {
    if (!selectedOutlineId) return;
    recordHistory();
    updateActiveOutlineCollections((outlines, draftOutlines) => ({
      outlines: outlines.map((outline) => outline.id === selectedOutlineId ? updater(outline) : outline),
      draftOutlines,
    }));
    setStatus(editingAsset ? "物体模板轮廓有未同步修改" : "地图轮廓有未同步修改");
  };

  const patchSelectedRigidVisual = (patch: Partial<ProceduralRigidVisualAuthoringData>) => {
    patchSelectedOutline((outline) => outline.rigidBody ? {
      ...outline,
      rigidBody: {
        ...outline.rigidBody,
        visual: { ...outline.rigidBody.visual, ...patch },
      },
    } : outline);
  };

  const patchSelectedRigidPhysical = (patch: Partial<ProceduralRigidPhysicalAuthoringData>) => {
    patchSelectedOutline((outline) => outline.rigidBody ? {
      ...outline,
      rigidBody: {
        ...outline.rigidBody,
        physical: { ...outline.rigidBody.physical, ...patch },
      },
    } : outline);
  };

  const patchSelectedRigidFracture = (patch: Partial<ProceduralRigidFractureAuthoringData>) => {
    patchSelectedOutline((outline) => outline.rigidBody ? {
      ...outline,
      rigidBody: {
        ...outline.rigidBody,
        fracture: { ...outline.rigidBody.fracture, ...patch },
      },
    } : outline);
  };

  const moveSelectedOutlineCenter = (centerX: number, centerY: number) => {
    if (!selectedOutline || !selectedOutlineBounds) return;
    patchSelectedOutline((outline) => translateOutline(
      outline,
      centerX - selectedOutlineBounds.centerX,
      centerY - selectedOutlineBounds.centerY,
    ));
  };

  const patchSelectedMatterStroke = (updater: (stroke: MapMatterStrokeData) => MapMatterStrokeData) => {
    if (!selectedMatterStrokeId) return;
    recordHistory();
    updateProject((current) => ({
      ...current,
      matterStrokes: (current.matterStrokes || []).map((stroke) => stroke.id === selectedMatterStrokeId ? updater(stroke) : stroke),
    }));
    setStatus("元素物质画笔有未同步修改");
  };

  const patchSelectedMatterVisual = (patch: Partial<MapMatterAuthoringProfileData["visual"]>) => {
    patchSelectedMatterStroke((stroke) => ({
      ...stroke,
      profile: { ...stroke.profile, visual: { ...stroke.profile.visual, ...patch } },
    }));
  };

  const patchSelectedMatterPhysical = (patch: Partial<MapMatterAuthoringProfileData["physical"]>) => {
    patchSelectedMatterStroke((stroke) => ({
      ...stroke,
      profile: { ...stroke.profile, physical: { ...stroke.profile.physical, ...patch } },
    }));
  };

  const moveSelectedMatterCenter = (centerX: number, centerY: number) => {
    if (!selectedMatterStroke || !selectedMatterBounds) return;
    const offsetX = centerX - selectedMatterBounds.centerX;
    const offsetY = centerY - selectedMatterBounds.centerY;
    patchSelectedMatterStroke((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ x: point.x + offsetX, y: point.y + offsetY })),
    }));
  };

  const removeSelectedObject = () => {
    if (!selectedObjectId) return;
    recordHistory();
    updateProject((current) => ({ ...current, objects: current.objects.filter((object) => object.id !== selectedObjectId) }));
    clearCanvasSelection();
    setStatus("已删除物体 · 有未同步修改");
  };

  const loadRigidBodyControls = (
    outlineId: string,
    rigidBody: NonNullable<MapOutlineData["rigidBody"]>,
    assetScoped: boolean,
  ) => {
    setEditingRigidOutlineId(outlineId);
    setMode("iceBody");
    setRigidTemplateId(rigidBody.templateId);
    setRigidElementTag(rigidBody.elementTag);
    setIceClosureMode(assetScoped ? "manual" : rigidBody.closureMode);
    setIceRoutePreference(rigidBody.routePreference === "alternate" ? "alternate" : "shorter");
    setIceSeed(rigidBody.seed);
    setRigidBaseColor(rigidBody.visual.baseColor);
    setRigidShadowColor(rigidBody.visual.shadowColor);
    setRigidHighlightColor(rigidBody.visual.highlightColor);
    setRigidEdgeColor(rigidBody.visual.edgeColor);
    setRigidFractureColor(rigidBody.visual.fractureColor);
    setRigidOpacity(rigidBody.visual.opacity);
    setIceJaggedness(rigidBody.visual.edgeJaggedness);
    setIceFacetSize(rigidBody.visual.facetScale);
    setRigidFacetVariation(rigidBody.visual.facetVariation);
    setIceTextureStrength(rigidBody.visual.textureStrength);
    setRigidEdgeBrightness(rigidBody.visual.edgeBrightness);
    setIceFrostWidth(rigidBody.visual.edgeWidthPixels);
    setIceVolumeDepth(rigidBody.visual.volumeDepth);
    setIceTransmission(rigidBody.visual.transmission);
    setIceAbsorption(rigidBody.visual.absorption);
    setRigidRoughness(rigidBody.visual.roughness);
    setIceSpecularStrength(rigidBody.visual.specularStrength);
    setIceInclusionDensity(rigidBody.visual.inclusionDensity);
    setIceMicroCrackDensity(rigidBody.visual.microCrackDensity);
    setRigidGrainDirection(rigidBody.visual.grainDirectionDegrees);
    setRigidVisualAnisotropy(rigidBody.visual.anisotropy);
    setIceLightAngleDegrees(rigidBody.visual.lightAngleDegrees);
    setRigidPhysical({ ...rigidBody.physical });
    setRigidFractureParameters({ ...rigidBody.fracture });
  };

  const patchAssetLayer = (assetId: string, layer: MapLayer) => {
    const asset = assetsRef.current[assetId];
    if (!asset) return;
    if (asset.defaultLayer !== layer) {
      recordHistory();
      updateAssets((current) => ({ ...current, [assetId]: { ...current[assetId], defaultLayer: layer } }));
    }
    setEditingAssetId(assetId);
    clearCanvasSelection();
    setEditingRigidOutlineId("");
    if (layer === "rigid") {
      const authoredRigid = asset.outlines?.find((outline) => outline.layer === "rigid" && outline.rigidBody)?.rigidBody;
      const authoredOutline = asset.outlines?.find((outline) => outline.rigidBody === authoredRigid);
      if (authoredRigid && authoredOutline) loadRigidBodyControls(authoredOutline.id, authoredRigid, true);
      else setMode("iceBody");
    } else {
      setMode(layer === "occlusion" ? "occlusion" : "collision");
    }
    setStatus(`${asset.defaultLayer === layer ? "已选择" : "已修改"}物体素材 · ${asset.name} · ${layerLabels[layer]}`);
  };

  const openAssetOutlineEditor = (assetId: string) => {
    const asset = assetsRef.current[assetId];
    if (!asset) return;
    drawingRef.current = null;
    setDrawing(null);
    setDropPreview(null);
    clearCanvasSelection();
    setEditingRigidOutlineId("");
    setEditingAssetId(assetId);
    if (asset.defaultLayer === "rigid") {
      const authoredOutline = asset.outlines?.find((outline) => outline.layer === "rigid" && outline.rigidBody);
      if (authoredOutline?.rigidBody) loadRigidBodyControls(authoredOutline.id, authoredOutline.rigidBody, true);
      else setMode("iceBody");
    } else {
      setMode(asset.defaultLayer === "occlusion" ? "occlusion" : "collision");
    }
    setStatus(`已选择物体素材 · ${asset.name} · ${layerLabels[asset.defaultLayer]}`);
  };

  const closeAssetOutlineEditor = () => {
    drawingRef.current = null;
    setDrawing(null);
    setEditingRigidOutlineId("");
    clearCanvasSelection();
    setEditingAssetId("");
    setMode("select");
    setStatus("已返回地图画布");
  };

  const undoOutline = () => {
    if (!activeOutlines.length && !activeDraftOutlines.length) return;
    recordHistory();
    updateActiveOutlineCollections((outlines, draftOutlines) => outlines.length
      ? { outlines: outlines.slice(0, -1), draftOutlines }
      : { outlines, draftOutlines: draftOutlines.slice(0, -1) });
    setSelectedOutlineId("");
    setStatus(editingAsset ? "已撤销物体模板的上一条轮廓" : "已撤销上一条地图轮廓 · 有未同步修改");
  };

  const clearDraftOutlines = () => {
    if (!activeDraftOutlines.length) return;
    recordHistory();
    updateActiveOutlineCollections((outlines) => ({ outlines, draftOutlines: [] }));
    setStatus(editingAsset ? "已清空物体模板轮廓草稿" : "已清空地图轮廓草稿 · 有未同步修改");
  };

  const clearAllOutlines = () => {
    if (!activeOutlines.length && !activeDraftOutlines.length) return;
    recordHistory();
    updateActiveOutlineCollections(() => ({ outlines: [], draftOutlines: [] }));
    setEditingRigidOutlineId("");
    setSelectedOutlineId("");
    setStatus(editingAsset ? "已清空物体模板全部轮廓" : "已清空全部地图轮廓 · 有未同步修改");
  };

  const deleteOutline = (outlineId: string) => {
    recordHistory();
    updateActiveOutlineCollections((outlines, draftOutlines) => ({ outlines: outlines.filter((outline) => outline.id !== outlineId), draftOutlines }));
    if (editingRigidOutlineId === outlineId) setEditingRigidOutlineId("");
    if (selectedOutlineId === outlineId) setSelectedOutlineId("");
    setStatus(editingAsset ? "已删除物体模板轮廓" : "已删除地图轮廓 · 有未同步修改");
  };

  const convertOutlineToProgramRigid = (outlineId: string) => {
    const outline = activeOutlines.find((item) => item.id === outlineId);
    if (!outline || outline.layer !== "rigid" || outline.rigidBody || outline.points.length < 3) return;
    if (editingAsset && activeOutlines.filter((item) => item.layer === "rigid").length > 1) {
      setStatus("物体素材含多条刚体轮廓，无法确定唯一程序刚体；请保留一条闭合轮廓后再转换");
      return;
    }
    const result = buildProceduralRigidBody({
      id: outline.id,
      userPoints: outline.points,
      closureMode: "manual",
      seed: iceSeed,
      templateId: rigidTemplateId,
      elementTag: rigidElementTag,
      visual: iceVisual,
      physical: { ...rigidPhysical, anchoringMode: "dynamic" },
      fracture: iceFracture,
    });
    if (!result.ok || !result.rigidBody) {
      setStatus(`转换程序刚体失败：${result.message}`);
      return;
    }
    recordHistory();
    updateActiveOutlineCollections((outlines, draftOutlines) => ({
      outlines: outlines.map((item) => item.id === outlineId
        ? { ...item, closed: true, points: result.points, iceBody: undefined, rigidBody: result.rigidBody }
        : item),
      draftOutlines,
    }));
    setIceSeed((value) => (value + 1) >>> 0 || 1);
    setStatus(`已转换为${PROCEDURAL_RIGID_TEMPLATES[result.rigidBody.templateId].label}程序刚体 · ${result.rigidBody.facets.length} 个分面`);
  };

  const applyProceduralRigidTemplate = (templateId: ProceduralRigidTemplateId) => {
    const template = PROCEDURAL_RIGID_TEMPLATES[templateId];
    setRigidTemplateId(templateId);
    setRigidElementTag((current) => current.trim() ? current : template.defaultElementTag);
    setRigidBaseColor(template.visual.baseColor);
    setRigidShadowColor(template.visual.shadowColor);
    setRigidHighlightColor(template.visual.highlightColor);
    setRigidEdgeColor(template.visual.edgeColor);
    setRigidFractureColor(template.visual.fractureColor);
    setRigidOpacity(template.visual.opacity);
    setIceJaggedness(template.visual.edgeJaggedness);
    setIceFacetSize(template.visual.facetScale);
    setIceTextureStrength(template.visual.textureStrength);
    setIceVolumeDepth(template.visual.volumeDepth);
    setIceTransmission(template.visual.transmission);
    setIceAbsorption(template.visual.absorption);
    setIceFrostWidth(template.visual.edgeWidthPixels);
    setIceSpecularStrength(template.visual.specularStrength);
    setIceInclusionDensity(template.visual.inclusionDensity);
    setIceMicroCrackDensity(template.visual.microCrackDensity);
    setRigidFacetVariation(template.visual.facetVariation);
    setRigidEdgeBrightness(template.visual.edgeBrightness);
    setRigidRoughness(template.visual.roughness);
    setRigidGrainDirection(template.visual.grainDirectionDegrees);
    setRigidVisualAnisotropy(template.visual.anisotropy);
    setIceLightAngleDegrees(template.visual.lightAngleDegrees);
    setRigidPhysical({ ...template.physical });
    setRigidFractureParameters({ ...template.fracture });
  };

  const loadProceduralRigidParameters = (outlineId: string) => {
    const outline = activeOutlines.find((item) => item.id === outlineId);
    const rigidBody = outline?.rigidBody;
    if (!outline || !rigidBody) return;
    selectCanvasTarget("outline", outlineId);
    loadRigidBodyControls(outlineId, rigidBody, Boolean(editingAsset));
    setStatus(`正在编辑程序刚体参数 · ${rigidBody.elementTag || "无标签"}`);
  };

  const rebuildEditingRigid = (outline: MapOutlineData, assetScoped: boolean): ProceduralRigidBuildResult => {
    const previous = outline.rigidBody;
    if (!previous) return { ok: false, message: "目标程序刚体缺少作者参数", points: [], candidates: [], selectedCandidateIndex: -1 };
    const closureMode = assetScoped ? "manual" : iceClosureMode;
    return buildProceduralRigidBody({
      id: outline.id,
      userPoints: previous.authoringPoints?.length && previous.authoringPoints.length >= 3
        ? previous.authoringPoints
        : outline.points,
      closureMode,
      terrainContours: assetScoped ? [] : iceTerrainContours,
      routePreference: iceRoutePreference,
      seed: iceSeed,
      templateId: rigidTemplateId,
      elementTag: rigidElementTag,
      visual: iceVisual,
      physical: {
        ...rigidPhysical,
        anchoringMode: assetScoped ? "dynamic" : closureMode === "terrain" ? "terrainAttached" : rigidPhysical.anchoringMode,
      },
      fracture: iceFracture,
      snapDistance: 14 / Math.max(0.05, view.zoom),
    });
  };

  const mergeRebuiltRigid = (outline: MapOutlineData, result: ProceduralRigidBuildResult): MapOutlineData => {
    const previous = outline.rigidBody;
    const rebuilt = result.rigidBody;
    if (!previous || !result.ok || !rebuilt) return outline;
    return {
      ...outline,
      points: result.points,
      iceBody: undefined,
      rigidBody: {
        ...previous,
        ...rebuilt,
        terrainBinding: rebuilt.terrainBinding,
        visual: { ...previous.visual, ...rebuilt.visual },
        physical: { ...previous.physical, ...rebuilt.physical },
        fracture: { ...previous.fracture, ...rebuilt.fracture },
      },
    };
  };

  const applyParametersToEditingRigid = () => {
    if (!editingRigidOutlineId) return;
    const outline = activeOutlines.find((item) => item.id === editingRigidOutlineId);
    const previous = outline?.rigidBody;
    if (!outline || !previous) {
      setEditingRigidOutlineId("");
      setStatus("目标程序刚体已不存在，请重新选择");
      return;
    }
    const result = rebuildEditingRigid(outline, Boolean(editingAsset));
    if (!result.ok || !result.rigidBody) {
      setStatus(`程序刚体参数未应用：${result.message}`);
      return;
    }
    const nextOutline = mergeRebuiltRigid(outline, result);
    const nextRigidBody = nextOutline.rigidBody!;
    recordHistory();
    updateActiveOutlineCollections((outlines, draftOutlines) => ({
      outlines: outlines.map((item) => item.id === editingRigidOutlineId ? nextOutline : item),
      draftOutlines,
    }));
    setStatus(`已应用程序刚体参数 · ${nextRigidBody.elementTag || "无标签"} · ${nextRigidBody.facets.length} 分面`);
  };

  const stageEditingRigidForPersistence = (
    sourceProject: MapProject,
    sourceAssets: Record<string, MapAssetRef>,
  ): { project: MapProject; assets: Record<string, MapAssetRef>; error?: string; changed: boolean } => {
    if (!editingRigidOutlineId) return { project: sourceProject, assets: sourceAssets, changed: false };
    if (editingAssetId) {
      const asset = sourceAssets[editingAssetId];
      const outline = asset?.outlines?.find((item) => item.id === editingRigidOutlineId);
      if (!asset || !outline?.rigidBody) return { project: sourceProject, assets: sourceAssets, error: "正在编辑的物体库程序刚体已不存在", changed: false };
      const result = rebuildEditingRigid(outline, true);
      if (!result.ok || !result.rigidBody) return { project: sourceProject, assets: sourceAssets, error: result.message, changed: false };
      const nextOutline = mergeRebuiltRigid(outline, result);
      return {
        project: sourceProject,
        assets: {
          ...sourceAssets,
          [asset.id]: {
            ...asset,
            outlines: (asset.outlines || []).map((item) => item.id === outline.id ? nextOutline : item),
          },
        },
        changed: true,
      };
    }
    const outline = sourceProject.outlines.find((item) => item.id === editingRigidOutlineId);
    if (!outline?.rigidBody) return { project: sourceProject, assets: sourceAssets, error: "正在编辑的地图程序刚体已不存在", changed: false };
    const result = rebuildEditingRigid(outline, false);
    if (!result.ok || !result.rigidBody) return { project: sourceProject, assets: sourceAssets, error: result.message, changed: false };
    const nextOutline = mergeRebuiltRigid(outline, result);
    return {
      project: { ...sourceProject, outlines: sourceProject.outlines.map((item) => item.id === outline.id ? nextOutline : item) },
      assets: sourceAssets,
      changed: true,
    };
  };

  const deleteDraftOutline = (outlineId: string) => {
    recordHistory();
    updateActiveOutlineCollections((outlines, draftOutlines) => ({ outlines, draftOutlines: draftOutlines.filter((outline) => outline.id !== outlineId) }));
    setStatus(editingAsset ? "已删除物体模板轮廓草稿" : "已删除地图轮廓草稿 · 有未同步修改");
  };

  const deleteMatterStroke = (strokeId: string) => {
    recordHistory();
    updateProject((current) => ({ ...current, matterStrokes: (current.matterStrokes || []).filter((stroke) => stroke.id !== strokeId) }));
    if (selectedMatterStrokeId === strokeId) setSelectedMatterStrokeId("");
    setStatus("已删除元素物质画笔 · 有未同步修改");
  };

  const removeSelectedCanvasTarget = () => {
    if (selectedObjectId) {
      removeSelectedObject();
      return;
    }
    if (selectedOutlineId) {
      deleteOutline(selectedOutlineId);
      return;
    }
    if (selectedMatterStrokeId) deleteMatterStroke(selectedMatterStrokeId);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !editing) {
        event.preventDefault();
        if (event.shiftKey) redoMap(); else undoMap();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y" && !editing) {
        event.preventDefault();
        redoMap();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && !editing && selectedCanvasKind) {
        event.preventDefault();
        removeSelectedCanvasTarget();
      }
      if (event.key === "Escape") {
        drawingRef.current = null;
        setDrawing(null);
        matterDrawingRef.current = null;
        setMatterDrawing(null);
        setDropPreview(null);
        setIsPanning(false);
        pointerRef.current = null;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [redoMap, selectedCanvasKind, selectedMatterStrokeId, selectedObjectId, selectedOutlineId, undoMap]);

  const listUnityContent = async (path: string) => {
    const [prefabResponse, mapResponse] = await Promise.all([
      fetch("/api/unity/map-prefabs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectPath: path }) }),
      fetch("/api/unity/maps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectPath: path }) }),
    ]);
    const prefabResult = await prefabResponse.json();
    const mapResult = await mapResponse.json();
    if (!prefabResponse.ok) throw new Error(prefabResult.message || "Prefab 列表读取失败");
    if (!mapResponse.ok) throw new Error(mapResult.message || "地图列表读取失败");
    setPrefabs(prefabResult.prefabs || []);
    setUnityMaps(mapResult.maps || []);
    setSelectedUnityMapPath((current) => {
      if (mapResult.maps?.some((item: UnityMapSummary) => item.jsonPath === current)) return current;
      const origin = readDocumentOrigin("map");
      if (origin.kind === "unity" && mapResult.maps?.some((item: UnityMapSummary) => item.jsonPath === origin.jsonPath)) return origin.jsonPath;
      return mapResult.maps?.[0]?.jsonPath || "";
    });
  };

  const checkConnection = async () => {
    if (!connection?.path.trim()) return;
    const path = connection.path.trim();
    setConnection({ ...connection, phase: "checking", message: "正在检查 Unity 项目和 Runtime..." });
    try {
      const response = await fetch("/api/unity/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectPath: path }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Unity 项目检查失败");
      if (!result.runtime.installed) {
        setConnection({ path, phase: "missing", message: "请先通过 Unity Package Manager 安装独立的 com.frame-action.runtime 包，安装完成后重新检查。" });
        return;
      }
      if (!result.runtime.compatible) {
        const supported = result.runtime.schemaMin === null || result.runtime.schemaMax === null
          ? "兼容范围声明无效"
          : `支持 Schema ${result.runtime.schemaMin}-${result.runtime.schemaMax}`;
        setConnection({
          path,
          phase: "incompatible",
          message: `Runtime ${result.runtime.version} ${supported}，当前工具使用 Schema ${result.runtime.schemaVersion}。请在 Unity Package Manager 中选择兼容版本。`,
          runtimeVersion: result.runtime.version,
        });
        return;
      }
      await listUnityContent(path);
      setBoundMapUnityProjectPath(path);
      localStorage.setItem("frameAction.mapUnityProjectPath", path);
      setConnection({ path, phase: "ready", message: "项目已连接，可以绑定地图 Prefab。", runtimeVersion: result.runtime.version });
    } catch (error) {
      setConnection({ path, phase: "error", message: error instanceof Error ? error.message : "Unity 项目检查失败" });
    }
  };

  const openConnection = async () => {
    setPendingUnityMapDeletion(null);
    setPendingMapOverwrite(null);
    const path = boundMapUnityProjectPath || localStorage.getItem("frameAction.mapUnityProjectPath") || "";
    setConnection({
      path,
      phase: "path",
      message: path
        ? editingUnityMapPath
          ? "当前项目已绑定，可以直接同步最新地图数据。"
          : "当前正在创建新地图：名称不同会创建新记录，同名时会先询问是否覆盖。"
        : "选择 Unity 项目根目录，首次绑定会检查 Runtime 包。",
    });
    if (!path) return;
    try {
      await listUnityContent(path);
      setConnection({ path, phase: "ready", message: editingUnityMapPath ? "当前项目已绑定，可以直接同步最新地图数据。" : "当前正在创建新地图：名称不同会创建新记录，同名时会先询问是否覆盖。" });
    } catch {
      setConnection({ path, phase: "path", message: "请重新检查 Unity 项目。" });
    }
  };

  const loadUnityMap = async () => {
    if (!connection || !selectedUnityMapPath) return;
    setConnection({ ...connection, phase: "checking", message: "正在从 Unity 恢复地图数据和资源..." });
    try {
      const response = await fetch("/api/unity/load-map", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectPath: connection.path, jsonPath: selectedUnityMapPath }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "地图载入失败");
      const restoredAssets = Object.fromEntries((result.assets || []).map((asset: MapAssetRef) => [asset.id, { ...asset, url: asset.dataUrl || asset.url }]));
      restoreProject(result.project, restoredAssets, `已从 Unity 恢复地图 · ${result.project.mapName}`);
      rememberUnityDocument("map", connection.path, selectedUnityMapPath, result.project.mapName);
      setEditingUnityMapPath(selectedUnityMapPath);
      setPendingUnityMapDeletion(null);
      setPendingMapOverwrite(null);
      setConnection({ ...connection, phase: "done", message: `已载入地图 ${result.project.mapName}，后续同步会更新这条记录。` });
    } catch (error) {
      setConnection({ ...connection, phase: "error", message: error instanceof Error ? error.message : "地图载入失败" });
    }
  };

  const createNewMap = () => {
    restoreProject(createMapProject(), {}, "已创建新地图 · 尚未同步到 Unity");
    rememberLocalDocument("map");
    setEditingUnityMapPath("");
    setSelectedUnityMapPath("");
    setPendingUnityMapDeletion(null);
    setPendingMapOverwrite(null);
    setConnection(null);
  };

  const deleteMapFromUnity = async () => {
    const target = pendingUnityMapDeletion;
    const path = connection?.path || boundMapUnityProjectPath;
    if (!target || !path) return;
    setDeletingUnityMap(true);
    try {
      const response = await fetch("/api/unity/delete-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: path, jsonPath: target.jsonPath }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "从 Unity 删除地图失败");
      const origin = readDocumentOrigin("map");
      if (origin.kind === "unity" && origin.projectPath === path && origin.jsonPath === target.jsonPath) rememberLocalDocument("map");
      if (editingUnityMapPath === target.jsonPath) setEditingUnityMapPath("");
      setPendingUnityMapDeletion(null);
      await listUnityContent(path);
      const prefabMessage = result.result.replacementMap
        ? `共享 Prefab 已保留：${result.result.preservedPrefabPath}\n已安排由剩余地图“${result.result.replacementMap.mapName}”重新同步。`
        : result.result.preservedPrefabPath
          ? `项目原有 Prefab 已保留：${result.result.preservedPrefabPath}`
          : result.result.deletedPrefabPath
            ? `自动生成 Prefab 已删除：${result.result.deletedPrefabPath}`
            : "该地图没有需要单独删除的 Prefab。";
      setStatus(`已从 Unity 删除地图 ${result.result.mapName} · 本地草稿已保留`);
      setConnection((current) => current ? {
        ...current,
        phase: "done",
        message: `已删除地图 ${result.result.mapName}。\n${result.result.deletedPaths.join("\n")}\n${prefabMessage}\n当前页面仍保留原草稿，重新同步会再次创建该地图。`,
      } : current);
    } catch (error) {
      setConnection((current) => current ? { ...current, phase: "error", message: error instanceof Error ? error.message : "从 Unity 删除地图失败" } : current);
    } finally {
      setDeletingUnityMap(false);
    }
  };

  const changeMapUnityProject = () => {
    if (!connection) return;
    setConnection({ ...connection, phase: "path", message: "输入新的 Unity 项目根目录，确认后会检查 Runtime。" });
  };

  const unbindMapUnityProject = () => {
    setBoundMapUnityProjectPath("");
    setSelectedUnityMapPath("");
    setEditingUnityMapPath("");
    setPendingUnityMapDeletion(null);
    setPendingMapOverwrite(null);
    localStorage.removeItem("frameAction.mapUnityProjectPath");
    rememberLocalDocument("map");
    setStatus("已解除地图 Unity 项目绑定 · 本地草稿未受影响");
    setConnection({ path: "", phase: "path", message: "已解除绑定。可以选择新的 Unity 项目继续同步。" });
  };

  const uploadMapAsset = async (path: string, asset: MapAssetRef, assetIndex: number, assetCount: number, overwriteTarget: UnityMapSummary | null) => {
    const base64 = base64Payload(asset.dataUrl || asset.url);
    const byteSize = base64ByteSize(base64);
    const startResponse = await fetch("/api/unity/map-asset-upload/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: path,
        mapName: project.mapName,
        targetJsonPath: editingUnityMapPath,
        overwriteJsonPath: overwriteTarget?.jsonPath || "",
        overwritePrefabPath: overwriteTarget?.prefabPath || "",
        asset: mapAssetMetadata(asset, byteSize),
        byteSize,
      }),
    });
    const startResult = await startResponse.json();
    if (!startResponse.ok) {
      if (startResult.code === "runtime_missing" || startResult.code === "runtime_incompatible") {
        setConnection({ path, phase: startResult.code === "runtime_missing" ? "missing" : "incompatible", message: startResult.message });
      }
      throw new Error(startResult.message || `地图资源准备失败：${asset.name}`);
    }
    if (!startResult.result.required) return;

    const uploadId = String(startResult.result.uploadId || "");
    let uploadedBytes = 0;
    for (let offset = 0; offset < base64.length; offset += MAP_ASSET_BASE64_CHUNK_SIZE) {
      const chunk = decodeBase64Chunk(base64.slice(offset, offset + MAP_ASSET_BASE64_CHUNK_SIZE));
      const chunkResponse = await fetch("/api/unity/map-asset-upload/chunk", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Frame-Action-Upload-Id": uploadId,
          "X-Frame-Action-Upload-Offset": String(uploadedBytes),
        },
        body: chunk.buffer,
      });
      const chunkResult = await chunkResponse.json();
      if (!chunkResponse.ok) throw new Error(chunkResult.message || `地图资源分块上传失败：${asset.name}`);
      uploadedBytes = Number(chunkResult.result.receivedBytes) || uploadedBytes + chunk.byteLength;
      const progress = Math.round(((assetIndex + uploadedBytes / Math.max(1, byteSize)) / Math.max(1, assetCount)) * 100);
      setStatus(`正在同步地图资源 · ${asset.name} · ${Math.min(100, progress)}%`);
    }

    const finishResponse = await fetch("/api/unity/map-asset-upload/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId }),
    });
    const finishResult = await finishResponse.json();
    if (!finishResponse.ok) throw new Error(finishResult.message || `地图资源写入失败：${asset.name}`);
  };

  const syncMap = async (confirmOverwrite = false) => {
    const path = boundMapUnityProjectPath || connection?.path || "";
    if (!path) { void openConnection(); return; }
    if (!backgroundAsset) { setStatus("请先导入地图背景"); return; }
    let overwriteTarget = confirmOverwrite ? pendingMapOverwrite : null;
    setStatus("正在同步地图数据和资源...");
    try {
      if (!confirmOverwrite) {
        setConnection((current) => current ? { ...current, phase: "checking", message: "正在检查 Unity 项目中的同名地图和 Prefab..." } : current);
        const checkResponse = await fetch("/api/unity/check-map-overwrite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectPath: path, mapName: project.mapName, unityPrefabPath: project.unityPrefabPath, targetJsonPath: editingUnityMapPath }),
        });
        const checkResult = await checkResponse.json();
        if (!checkResponse.ok) throw new Error(checkResult.message || "地图覆盖检查失败");
        if (checkResult.existing) {
          overwriteTarget = checkResult.existing as UnityMapSummary;
          setPendingMapOverwrite(overwriteTarget);
          setConnection((current) => current ? {
            ...current,
            phase: "overwrite",
            message: overwriteTarget?.orphanPrefab
              ? `Unity 项目中已有同名地图 Prefab“${overwriteTarget.mapName}”，但对应的可编辑源数据已经缺失。\nPrefab：${overwriteTarget.prefabPath}\n继续操作会用当前页面数据建立新的同步记录，并覆盖这个 Prefab。`
              : `Unity 项目中已经存在同名地图“${overwriteTarget?.mapName}”。\n${overwriteTarget?.jsonPath}\nPrefab：${overwriteTarget?.prefabPath}\n继续操作会覆盖旧地图数据，并更新这个 Prefab。`,
          } : current);
          return;
        }
      }
      setPendingMapOverwrite(null);
      setConnection((current) => current ? { ...current, phase: "syncing", message: "正在同步地图数据、资源和 Prefab..." } : current);
      const staged = stageEditingRigidForPersistence(projectRef.current, assetsRef.current);
      if (staged.error) throw new Error(`程序刚体参数无法保存：${staged.error}`);
      if (staged.changed) {
        projectRef.current = staged.project;
        assetsRef.current = staged.assets;
        setProject(staged.project);
        setAssets(staged.assets);
      }
      const persistentProject = ensureProgramRigidProject(staged.project);
      const persistentAssets = ensureProgramRigidAssets(staged.assets);
      const referencedIds = new Set([persistentProject.backgroundAssetId, ...persistentProject.objects.map((item) => item.assetId)].filter(Boolean));
      const referencedAssets = Object.values(persistentAssets).filter((asset) => referencedIds.has(asset.id));
      for (let index = 0; index < referencedAssets.length; index += 1) {
        await uploadMapAsset(path, referencedAssets[index], index, referencedAssets.length, overwriteTarget);
      }
      setStatus("正在写入地图结构和 Prefab...");
      const response = await fetch("/api/unity/sync-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: path,
          project: persistentProject,
          assets: referencedAssets.map(mapAssetMetadata),
          targetJsonPath: editingUnityMapPath,
          overwriteJsonPath: overwriteTarget?.jsonPath || "",
          overwritePrefabPath: overwriteTarget?.prefabPath || "",
          confirmOverwrite,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (result.code === "runtime_missing" || result.code === "runtime_incompatible") {
          setConnection({ path, phase: result.code === "runtime_missing" ? "missing" : "incompatible", message: result.message });
          return;
        }
        throw new Error(result.message || "地图同步失败");
      }
      updateProject((current) => ({ ...current, unityPrefabPath: result.result.prefabPath }));
      rememberUnityDocument("map", path, result.result.jsonPath, project.mapName);
      setSelectedUnityMapPath(result.result.jsonPath);
      setEditingUnityMapPath(result.result.jsonPath);
      setBoundMapUnityProjectPath(path);
      localStorage.setItem("frameAction.mapUnityProjectPath", path);
      void listUnityContent(path);
      setStatus(`已同步地图 Prefab · ${result.result.prefabPath}`);
      setConnection((current) => current ? {
        ...current,
        phase: "done",
        message: [
          `已同步 ${result.result.objectCount} 个物体、${result.result.outlineCount} 条地图轮廓、${result.result.assetOutlineCount || 0} 条物体模板轮廓。`,
          result.result.prefabPathAdjustedFrom ? `检测到其他地图的生成路径，已自动改为独立 Prefab：\n${result.result.prefabPath}` : "",
          result.result.jsonPath,
          `地图 Prefab：${result.result.prefabPath}`,
        ].filter(Boolean).join("\n"),
        runtimeVersion: result.runtime.version,
      } : current);
    } catch (error) {
      const message = error instanceof Error ? error.message : "地图同步失败";
      setStatus(message);
      setConnection((current) => current ? { ...current, phase: "error", message } : current);
    }
  };

  const objectAssets = useMemo(() => Object.values(assets).filter((asset) => asset.usage === "object"), [assets]);
  const replacementAsset = pendingBackgroundReplacement?.asset ?? null;
  const replacementScaleX = replacementAsset ? replacementAsset.width / Math.max(1, project.width) : 1;
  const replacementScaleY = replacementAsset ? replacementAsset.height / Math.max(1, project.height) : 1;
  const replacementPpu = Math.max(1, project.pixelsPerUnit * replacementScaleX);
  const orphanMapPrefabs = prefabs.filter((item) => !item.hasSourceData);
  const mapSyncContext = editingUnityMapPath ? "已打开旧地图" : "创建新地图中";
  const showingBoundMapProject = Boolean(connection && boundMapUnityProjectPath && connection.path === boundMapUnityProjectPath && connection.phase !== "path");
  const modes: { value: MapMode; label: string; icon: React.ReactNode }[] = [
    { value: "select", label: "选择", icon: <MousePointer2 size={15} /> },
    { value: "pan", label: "平移", icon: <Hand size={15} /> },
    { value: "groundLine", label: "矩形碰撞", icon: <Box size={15} /> },
    { value: "collision", label: "碰撞区域", icon: <Pencil size={15} /> },
    { value: "iceBody", label: "程序刚体", icon: <Snowflake size={15} /> },
    { value: "liquid", label: "液体画笔", icon: <CircleDot size={15} /> },
    { value: "gas", label: "气体画笔", icon: <Eye size={15} /> },
    { value: "occlusion", label: "遮挡区域", icon: <Eye size={15} /> },
  ];

  return <div className="app-shell map-editor-shell">
    <header className="app-header">
      <div className="brand-block map-brand"><MapIcon size={22} /><div><strong>SpriteCue Studio</strong><span>横版 2D 地图编辑器</span></div></div>
      <nav className="module-navigation" aria-label="功能模块">
        <button type="button" onClick={onSwitchToCharacter}><Layers3 size={15} />角色动作</button>
        <button type="button" onClick={onSwitchToEnemy}><Bot size={15} />敌人动作</button>
        <button type="button" className="active"><MapIcon size={15} />地图编辑</button>
      </nav>
      <div className="project-fields map-project-fields">
        <label><span>地图</span><DeferredTextInput value={project.mapName} onValueChange={(value) => { recordHistory(); updateProject((current) => ({ ...current, mapName: value })); setStatus("地图有未同步修改"); }} /></label>
        <label className="compact-field"><span>PPU</span><NumericInput value={project.pixelsPerUnit} min={1} step={1} integer onValueChange={(value) => { recordHistory(); updateProject((current) => ({ ...current, pixelsPerUnit: Math.max(1, value) })); setStatus("地图有未同步修改"); }} /></label>
      </div>
      <div className="header-actions">
        <button type="button" className="icon-button" title="撤销 Ctrl+Z" disabled={!historyRef.current.past.length} onClick={undoMap}><Undo2 size={17} /></button>
        <button type="button" className="icon-button" title="重做 Ctrl+Y" disabled={!historyRef.current.future.length} onClick={redoMap}><Redo2 size={17} /></button>
        <button type="button" className="icon-button" title="适应画布" onClick={fitCanvas}><RotateCcw size={17} /></button>
        <button type="button" className="icon-button" title="打开地图 JSON" onClick={() => jsonInputRef.current?.click()}><Upload size={17} /></button>
        <button type="button" className="icon-button" title="导出地图 JSON" onClick={exportMapBundle}><Download size={17} /></button>
        <button type="button" className={`sync-button${boundMapUnityProjectPath ? " bound" : ""}`} onClick={() => void openConnection()} title={boundMapUnityProjectPath ? `同步地图（${mapSyncContext}）到 ${boundMapUnityProjectPath}` : "绑定地图 Unity 项目"}>
          {boundMapUnityProjectPath ? <FolderSync size={17} /> : <FolderOpen size={17} />}
          <span className="sync-button-label"><strong>{boundMapUnityProjectPath ? `同步地图（${mapSyncContext}）` : "绑定地图项目"}</strong>{boundMapUnityProjectPath && <small>{projectName(boundMapUnityProjectPath)}</small>}</span>
        </button>
      </div>
      <input ref={jsonInputRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void importMapBundle(file); event.currentTarget.value = ""; }} />
    </header>

    <div className="map-editor-main">
      <aside className="map-assets-panel">
        <section className="sidebar-section map-resource-section">
          <div className="section-heading"><div><strong>地图资源</strong><span>{backgroundAsset ? `${project.width}×${project.height}` : "未导入背景"}</span></div></div>
          <div className="map-import-actions">
            <button
              type="button"
              className={`map-drop-button${importDropTarget === "background" ? " dragover" : ""}`}
              onClick={() => backgroundInputRef.current?.click()}
              onDragEnter={(event) => { event.preventDefault(); setImportDropTarget("background"); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setImportDropTarget(null)}
              onDrop={dropBackgroundFile}
            ><ImagePlus size={16} /><span><strong>背景地图</strong><small>{backgroundAsset ? backgroundAsset.name : "选择或拖入图片"}</small></span></button>
            <button
              type="button"
              className={`map-drop-button${importDropTarget === "objects" ? " dragover" : ""}`}
              onClick={() => assetInputRef.current?.click()}
              onDragEnter={(event) => { event.preventDefault(); setImportDropTarget("objects"); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setImportDropTarget(null)}
              onDrop={dropObjectFiles}
            ><Plus size={16} /><span><strong>物体图片</strong><small>支持多选和拖入</small></span></button>
          </div>
          <input ref={backgroundInputRef} type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBackground(file); event.currentTarget.value = ""; }} />
          <input ref={assetInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { if (event.target.files?.length) void importObjects(event.target.files); event.currentTarget.value = ""; }} />
          <label className="field map-default-layer"><span>导入默认图层</span><select value={activeLayer} onChange={(event) => setActiveLayer(event.target.value as MapLayer)}>{Object.entries(layerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </section>
        <section className="sidebar-section map-asset-library">
          <div className="section-heading"><div><strong>物体库</strong><span>{objectAssets.length} 个</span></div></div>
          <div className="map-asset-list">
            {!objectAssets.length && <div className="list-empty">尚未导入物体图片</div>}
            {objectAssets.map((asset) => <div
              key={asset.id}
              className={`map-asset-item${editingAssetId === asset.id ? " active" : ""}`}
              draggable
              aria-label={`拖动 ${asset.name}`}
              title={editingAssetId === asset.id ? "正在编辑该物体的轮廓模板" : "拖到地图画布"}
              onClick={() => openAssetOutlineEditor(asset.id)}
              onDragStart={(event) => startAssetDrag(event, asset)}
              onDragEnd={stopAssetDrag}
            >
              <GripVertical className="map-asset-grip" size={14} />
              <img src={asset.url} alt="" draggable={false} />
              <span><strong>{asset.name}</strong><small>{asset.width}×{asset.height}{asset.outlines?.length ? ` · ${asset.outlines.length} 条自定义轮廓` : ""}</small><select aria-label={`${asset.name} 默认图层`} value={asset.defaultLayer} onClick={(event) => event.stopPropagation()} onChange={(event) => patchAssetLayer(asset.id, event.target.value as MapLayer)}>{Object.entries(layerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></span>
              <button type="button" className="map-asset-draw-button" title={`编辑 ${asset.name} 的层级参数和轮廓`} onClick={(event) => { event.stopPropagation(); openAssetOutlineEditor(asset.id); }}><Pencil size={12} /><span>编辑</span></button>
            </div>)}
          </div>
        </section>
      </aside>

      <main className="map-workspace">
        <div className="map-toolbar">
          <div className="map-toolbar-main">
            {editingAsset && <button type="button" className="map-return-button" title="保存当前模板数据并返回地图画布" onClick={() => { if (editingRigidOutlineId) applyParametersToEditingRigid(); closeAssetOutlineEditor(); }}><ChevronLeft size={14} /><span>保存并返回地图</span></button>}
            <div className="map-mode-control">{modes.filter((item) => !editingAsset || !["select", "liquid", "gas"].includes(item.value)).map((item) => <button type="button" key={item.value} className={mode === item.value ? "active" : ""} title={item.label} onClick={() => setMode(item.value)}>{item.icon}<span>{item.label}</span></button>)}</div>
          </div>
          <div className="map-tool-options">
            {mode === "groundLine" && <>
              <span className="map-collision-swatch" title={rectangleCollisionLabel(groundCollisionType, groundSideCollision)} style={{ backgroundColor: rectangleCollisionStyle(groundCollisionType, groundSideCollision).stroke }} />
              <label><span>方向</span><select value={groundCollisionType} onChange={(event) => setGroundCollisionType(event.target.value as "solid" | "oneWay")}><option value="solid">双向</option><option value="oneWay">单向</option></select></label>
              <label className="map-snap-option"><input type="checkbox" checked={groundSideCollision} onChange={(event) => setGroundSideCollision(event.target.checked)} /><span>侧面碰撞</span></label>
              <label><span>厚度</span><NumericInput value={groundThickness} min={1} max={256} integer onValueChange={(value) => setGroundThickness(Math.max(1, Math.min(256, value)))} /></label>
              <label className="map-snap-option" title="开启后，终点接近起点水平线时自动对齐"><input type="checkbox" checked={autoHorizontalSnap} onChange={(event) => setAutoHorizontalSnap(event.target.checked)} /><span>自动水平吸附</span></label>
            </>}
            {(mode === "liquid" || mode === "gas") && <>
              <label><span>元素标签</span><input aria-label="物质元素标签" value={matterElementTag} placeholder="例如 water / ice / 自定义名称" onChange={(event) => setMatterElementTag(event.target.value)} /></label>
              <label><span>画笔半径</span><NumericInput value={matterBrushRadius} min={1} max={256} integer onValueChange={(value) => setMatterBrushRadius(Math.max(1, Math.min(256, value)))} /></label>
              <details className="map-rigid-settings" open><summary>{matterCarrier === "liquid" ? "液体外观参数" : "气体外观参数"}</summary><div>
                <label><span>基础色</span><input type="color" value={activeMatterProfile.visual.baseColor} onChange={(event) => patchMatterProfile((profile) => ({ ...profile, visual: { ...profile.visual, baseColor: event.target.value } }))} /></label>
                <label><span>辅色</span><input type="color" value={activeMatterProfile.visual.secondaryColor} onChange={(event) => patchMatterProfile((profile) => ({ ...profile, visual: { ...profile.visual, secondaryColor: event.target.value } }))} /></label>
                <label><span>发光色</span><input type="color" value={activeMatterProfile.visual.emissionColor} onChange={(event) => patchMatterProfile((profile) => ({ ...profile, visual: { ...profile.visual, emissionColor: event.target.value } }))} /></label>
                <label><span>不透明度%</span><NumericInput value={Math.round(activeMatterProfile.visual.opacity * 100)} min={0} max={100} integer onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, visual: { ...profile.visual, opacity: Math.max(0, Math.min(100, value)) / 100 } }))} /></label>
                <label><span>颗粒大小</span><NumericInput value={activeMatterProfile.visual.particleScale} min={0.1} max={4} step={0.05} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, visual: { ...profile.visual, particleScale: Math.max(0.1, Math.min(4, value)) } }))} /></label>
                <label><span>边缘柔和</span><NumericInput value={activeMatterProfile.visual.edgeSoftness} min={0} max={1} step={0.05} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, visual: { ...profile.visual, edgeSoftness: Math.max(0, Math.min(1, value)) } }))} /></label>
                <label><span>细节缩放</span><NumericInput value={activeMatterProfile.visual.detailScale} min={0.1} max={8} step={0.1} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, visual: { ...profile.visual, detailScale: Math.max(0.1, Math.min(8, value)) } }))} /></label>
                <label><span>折射</span><NumericInput value={activeMatterProfile.visual.refractionStrength} min={0} max={1} step={0.05} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, visual: { ...profile.visual, refractionStrength: Math.max(0, Math.min(1, value)) } }))} /></label>
                <label><span>发光强度</span><NumericInput value={activeMatterProfile.visual.glowStrength} min={0} max={8} step={0.1} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, visual: { ...profile.visual, glowStrength: Math.max(0, Math.min(8, value)) } }))} /></label>
                {matterCarrier === "liquid" && <label><span>泡沫量</span><NumericInput value={activeMatterProfile.visual.foamAmount} min={0} max={1} step={0.05} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, visual: { ...profile.visual, foamAmount: Math.max(0, Math.min(1, value)) } }))} /></label>}
              </div></details>
              <details className="map-rigid-settings" open><summary>{matterCarrier === "liquid" ? "液体物理参数" : "气体物理参数"}</summary><div>
                <label><span>密度</span><NumericInput value={activeMatterProfile.physical.density} min={0.001} max={100} step={0.05} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, physical: { ...profile.physical, density: Math.max(0.001, Math.min(100, value)) } }))} /></label>
                <label><span>黏度</span><NumericInput value={activeMatterProfile.physical.viscosity} min={0} max={8} step={0.05} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, physical: { ...profile.physical, viscosity: Math.max(0, Math.min(8, value)) } }))} /></label>
                <label><span>流动速度</span><NumericInput value={activeMatterProfile.physical.flowSpeed} min={0.05} max={8} step={0.05} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, physical: { ...profile.physical, flowSpeed: Math.max(0.05, Math.min(8, value)) } }))} /></label>
                <label><span>重力倍率</span><NumericInput value={activeMatterProfile.physical.gravityScale} min={-4} max={4} step={0.05} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, physical: { ...profile.physical, gravityScale: Math.max(-4, Math.min(4, value)) } }))} /></label>
                <label><span>扩散</span><NumericInput value={activeMatterProfile.physical.diffusion} min={0} max={4} step={0.05} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, physical: { ...profile.physical, diffusion: Math.max(0, Math.min(4, value)) } }))} /></label>
                <label><span>浮力</span><NumericInput value={activeMatterProfile.physical.buoyancy} min={-4} max={4} step={0.05} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, physical: { ...profile.physical, buoyancy: Math.max(-4, Math.min(4, value)) } }))} /></label>
                <label><span>阻力</span><NumericInput value={activeMatterProfile.physical.drag} min={0} max={8} step={0.05} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, physical: { ...profile.physical, drag: Math.max(0, Math.min(8, value)) } }))} /></label>
                {matterCarrier === "liquid" && <>
                  <label><span>表面张力</span><NumericInput value={activeMatterProfile.physical.surfaceTension} min={0} max={4} step={0.05} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, physical: { ...profile.physical, surfaceTension: Math.max(0, Math.min(4, value)) } }))} /></label>
                  <label><span>蒸发半衰期秒</span><NumericInput value={activeMatterProfile.physical.evaporationHalfLifeSeconds} min={0} max={86400} step={10} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, physical: { ...profile.physical, evaporationHalfLifeSeconds: Math.max(0, Math.min(86400, value)) } }))} /></label>
                </>}
                {matterCarrier === "gas" && <label><span>逸散半衰期秒</span><NumericInput value={activeMatterProfile.physical.dissipationHalfLifeSeconds} min={0} max={86400} step={10} onValueChange={(value) => patchMatterProfile((profile) => ({ ...profile, physical: { ...profile.physical, dissipationHalfLifeSeconds: Math.max(0, Math.min(86400, value)) } }))} /></label>}
              </div></details>
            </>}
            {mode === "iceBody" && <>
              <label><span>模板</span><select aria-label="程序刚体模板" value={rigidTemplateId} onChange={(event) => applyProceduralRigidTemplate(event.target.value as ProceduralRigidTemplateId)}>{Object.values(PROCEDURAL_RIGID_TEMPLATES).map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}</select></label>
              <label><span>元素标签</span><input aria-label="程序刚体元素标签" value={rigidElementTag} placeholder={`建议：${rigidTemplate.defaultElementTag || "自定义"}`} onChange={(event) => setRigidElementTag(event.target.value)} /></label>
              <button type="button" className="map-ice-reroll" disabled={!rigidTemplate.defaultElementTag} onClick={() => setRigidElementTag(rigidTemplate.defaultElementTag)}>采用建议标签</button>
              {editingRigidOutlineId && <>
                <span className="map-template-closure-note">正在编辑已有刚体</span>
                <button type="button" className="map-ice-reroll" onClick={applyParametersToEditingRigid}>应用到当前刚体</button>
                <button type="button" className="map-ice-reroll" onClick={() => setEditingRigidOutlineId("")}>退出编辑</button>
              </>}
              {editingAsset ? <span className="map-template-closure-note">物体素材仅支持完整手绘</span> : <label><span>封边</span><select aria-label="程序刚体封边方式" value={iceClosureMode} onChange={(event) => setIceClosureMode(event.target.value as IceBodyClosureMode)}><option value="manual">完整手绘</option><option value="terrain">借地形闭合</option></select></label>}
              {!editingAsset && iceClosureMode === "terrain" && <label><span>路径</span><select aria-label="借用地形路径" value={iceRoutePreference} onChange={(event) => setIceRoutePreference(event.target.value as ProceduralRigidTerrainRoutePreference)}><option value="shorter">较短侧</option><option value="alternate">另一侧</option></select></label>}
              <label><span>种子</span><NumericInput value={iceSeed} min={1} max={4294967295} integer onValueChange={(value) => setIceSeed(Math.max(1, Math.floor(value)) >>> 0 || 1)} /></label>
              <button type="button" className="map-ice-reroll" title="更换程序纹理随机种子" onClick={() => setIceSeed((value) => (Math.imul(value, 1664525) + 1013904223) >>> 0 || 1)}><RotateCcw size={13} />换纹理</button>
              <details className="map-rigid-settings" open><summary>{editingAsset ? "原图破损表现" : "程序外观"}</summary><div>
                {editingAsset && <span className="map-template-closure-note">主体颜色、纹理和透明轮廓来自原图片；这里仅配置裂纹、断面和碎屑表现</span>}
                {!editingAsset && <>
                <label><span>基础色</span><input type="color" aria-label="程序刚体基础色" value={rigidBaseColor} onChange={(event) => setRigidBaseColor(event.target.value)} /></label>
                <label><span>暗部色</span><input type="color" aria-label="程序刚体暗部色" value={rigidShadowColor} onChange={(event) => setRigidShadowColor(event.target.value)} /></label>
                <label><span>高光色</span><input type="color" aria-label="程序刚体高光色" value={rigidHighlightColor} onChange={(event) => setRigidHighlightColor(event.target.value)} /></label>
                </>}
                <label><span>破碎特效色</span><input type="color" aria-label="程序刚体破碎特效色" value={rigidFractureColor} onChange={(event) => setRigidFractureColor(event.target.value)} /></label>
                <label><span>边缘色</span><input type="color" aria-label="程序刚体边缘色" value={rigidEdgeColor} onChange={(event) => setRigidEdgeColor(event.target.value)} /></label>
                {!editingAsset && <>
                <label><span>不透明%</span><NumericInput value={Math.round(rigidOpacity * 100)} min={0} max={100} integer onValueChange={(value) => setRigidOpacity(Math.max(0, Math.min(100, value)) / 100)} /></label>
                <label><span>边缘锯齿%</span><NumericInput value={Math.round(iceJaggedness * 100)} min={0} max={100} integer onValueChange={(value) => setIceJaggedness(Math.max(0, Math.min(100, value)) / 100)} /></label>
                <label><span>分面尺寸</span><NumericInput value={iceFacetSize} min={6} max={128} integer onValueChange={(value) => setIceFacetSize(Math.max(6, Math.min(128, value)))} /></label>
                <label><span>分面变化%</span><NumericInput value={Math.round(rigidFacetVariation * 100)} min={0} max={100} integer onValueChange={(value) => setRigidFacetVariation(Math.max(0, Math.min(100, value)) / 100)} /></label>
                <label><span>纹理强度%</span><NumericInput value={Math.round(iceTextureStrength * 100)} min={0} max={100} integer onValueChange={(value) => setIceTextureStrength(Math.max(0, Math.min(100, value)) / 100)} /></label>
                </>}
                <label><span>边缘亮度%</span><NumericInput value={Math.round(rigidEdgeBrightness * 100)} min={0} max={100} integer onValueChange={(value) => setRigidEdgeBrightness(Math.max(0, Math.min(100, value)) / 100)} /></label>
                <label><span>边缘宽度</span><NumericInput value={iceFrostWidth} min={0} max={24} onValueChange={(value) => setIceFrostWidth(Math.max(0, Math.min(24, value)))} /></label>
                {!editingAsset && <>
                <label><span>体积%</span><NumericInput value={Math.round(iceVolumeDepth * 100)} min={0} max={100} integer onValueChange={(value) => setIceVolumeDepth(Math.max(0, Math.min(100, value)) / 100)} /></label>
                <label><span>透光%</span><NumericInput value={Math.round(iceTransmission * 100)} min={0} max={100} integer onValueChange={(value) => setIceTransmission(Math.max(0, Math.min(100, value)) / 100)} /></label>
                <label><span>吸收%</span><NumericInput value={Math.round(iceAbsorption * 100)} min={0} max={100} integer onValueChange={(value) => setIceAbsorption(Math.max(0, Math.min(100, value)) / 100)} /></label>
                <label><span>粗糙度%</span><NumericInput value={Math.round(rigidRoughness * 100)} min={0} max={100} integer onValueChange={(value) => setRigidRoughness(Math.max(0, Math.min(100, value)) / 100)} /></label>
                <label><span>高光%</span><NumericInput value={Math.round(iceSpecularStrength * 100)} min={0} max={100} integer onValueChange={(value) => setIceSpecularStrength(Math.max(0, Math.min(100, value)) / 100)} /></label>
                <label><span>夹杂%</span><NumericInput value={Math.round(iceInclusionDensity * 100)} min={0} max={100} integer onValueChange={(value) => setIceInclusionDensity(Math.max(0, Math.min(100, value)) / 100)} /></label>
                </>}
                <label><span>微裂%</span><NumericInput value={Math.round(iceMicroCrackDensity * 100)} min={0} max={100} integer onValueChange={(value) => setIceMicroCrackDensity(Math.max(0, Math.min(100, value)) / 100)} /></label>
                {!editingAsset && <>
                <label><span>纹理方向°</span><NumericInput value={rigidGrainDirection} min={-180} max={180} onValueChange={(value) => setRigidGrainDirection(Math.max(-180, Math.min(180, value)))} /></label>
                <label><span>方向性%</span><NumericInput value={Math.round(rigidVisualAnisotropy * 100)} min={0} max={100} integer onValueChange={(value) => setRigidVisualAnisotropy(Math.max(0, Math.min(100, value)) / 100)} /></label>
                <label><span>光向°</span><NumericInput value={iceLightAngleDegrees} min={-180} max={180} integer onValueChange={(value) => setIceLightAngleDegrees(Math.max(-180, Math.min(180, value)))} /></label>
                </>}
              </div></details>
              <details className="map-rigid-settings"><summary>物理</summary><div>
                <label><span>锚定</span><select value={editingAsset ? "dynamic" : iceClosureMode === "terrain" ? "terrainAttached" : rigidPhysical.anchoringMode} disabled={Boolean(editingAsset || iceClosureMode === "terrain")} onChange={(event) => setRigidPhysical((current) => ({ ...current, anchoringMode: event.target.value as ProceduralRigidPhysicalAuthoringData["anchoringMode"] }))}><option value="dynamic">动态</option><option value="fixed">固定</option><option value="terrainAttached">附着地形</option></select></label>
                <label><span>密度</span><NumericInput value={rigidPhysical.density} min={0.001} max={100} onValueChange={(value) => setRigidPhysical((current) => ({ ...current, density: Math.max(0.001, value) }))} /></label>
                <label><span>重力倍率</span><NumericInput value={rigidPhysical.gravityScale} min={-8} max={8} onValueChange={(value) => setRigidPhysical((current) => ({ ...current, gravityScale: Math.max(-8, Math.min(8, value)) }))} /></label>
                <label><span>摩擦%</span><NumericInput value={Math.round(rigidPhysical.friction * 100)} min={0} max={100} integer onValueChange={(value) => setRigidPhysical((current) => ({ ...current, friction: Math.max(0, Math.min(100, value)) / 100 }))} /></label>
                <label><span>弹性%</span><NumericInput value={Math.round(rigidPhysical.restitution * 100)} min={0} max={100} integer onValueChange={(value) => setRigidPhysical((current) => ({ ...current, restitution: Math.max(0, Math.min(100, value)) / 100 }))} /></label>
                <label><span>线性阻尼</span><NumericInput value={rigidPhysical.linearDamping} min={0} max={20} onValueChange={(value) => setRigidPhysical((current) => ({ ...current, linearDamping: Math.max(0, Math.min(20, value)) }))} /></label>
                <label><span>旋转阻尼</span><NumericInput value={rigidPhysical.angularDamping} min={0} max={20} onValueChange={(value) => setRigidPhysical((current) => ({ ...current, angularDamping: Math.max(0, Math.min(20, value)) }))} /></label>
                <label><span>硬度%</span><NumericInput value={Math.round(rigidPhysical.hardness * 100)} min={0} max={100} integer onValueChange={(value) => setRigidPhysical((current) => ({ ...current, hardness: Math.max(0, Math.min(100, value)) / 100 }))} /></label>
                <label><span>韧性%</span><NumericInput value={Math.round(rigidPhysical.toughness * 100)} min={0} max={100} integer onValueChange={(value) => setRigidPhysical((current) => ({ ...current, toughness: Math.max(0, Math.min(100, value)) / 100 }))} /></label>
                <label><span>脆性%</span><NumericInput value={Math.round(rigidPhysical.brittleness * 100)} min={0} max={100} integer onValueChange={(value) => setRigidPhysical((current) => ({ ...current, brittleness: Math.max(0, Math.min(100, value)) / 100 }))} /></label>
                <label><span>各向异性%</span><NumericInput value={Math.round(rigidPhysical.anisotropy * 100)} min={0} max={100} integer onValueChange={(value) => setRigidPhysical((current) => ({ ...current, anisotropy: Math.max(0, Math.min(100, value)) / 100 }))} /></label>
                <label><span>材料纹向°</span><NumericInput value={rigidPhysical.grainAngleDegrees} min={-180} max={180} onValueChange={(value) => setRigidPhysical((current) => ({ ...current, grainAngleDegrees: Math.max(-180, Math.min(180, value)) }))} /></label>
                <label><span>碎屑比例%</span><NumericInput value={Math.round(rigidPhysical.debrisFraction * 100)} min={0} max={100} integer onValueChange={(value) => setRigidPhysical((current) => ({ ...current, debrisFraction: Math.max(0, Math.min(100, value)) / 100 }))} /></label>
              </div></details>
              <details className="map-rigid-settings"><summary>破碎</summary><div>
                <p className="map-rigid-settings-note">攻击能量和落地能量分别判定。结构损伤会累积：先崩边，再出现裂纹，累计到失效值后才释放主碎片。硬度、韧性越高，累积越慢；脆性越高，裂纹扩展越快、碎片越多。</p>
                <label><span>主碎片最少</span><NumericInput value={rigidFractureParameters.primaryFragmentMin} min={2} max={8} integer onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, primaryFragmentMin: Math.max(2, Math.min(8, value)) }))} /></label>
                <label><span>主碎片最多</span><NumericInput value={rigidFractureParameters.primaryFragmentMax} min={2} max={8} integer onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, primaryFragmentMax: Math.max(2, Math.min(8, value)) }))} /></label>
                <label><span>每击预算</span><NumericInput value={rigidFractureParameters.maxFragmentsPerImpact} min={2} max={8} integer onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, maxFragmentsPerImpact: Math.max(2, Math.min(8, value)) }))} /></label>
                <label><span>家族预算</span><NumericInput value={rigidFractureParameters.maxActiveFragmentsPerFamily} min={4} max={256} integer onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, maxActiveFragmentsPerFamily: Math.max(4, Math.min(256, value)) }))} /></label>
                <label><span>最小面积px²</span><NumericInput value={rigidFractureParameters.minimumFragmentArea} min={1} max={100000} onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, minimumFragmentArea: Math.max(1, value) }))} /></label>
                <label><span>最小宽度px</span><NumericInput value={rigidFractureParameters.minimumFragmentWidth} min={1} max={1024} onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, minimumFragmentWidth: Math.max(1, value) }))} /></label>
                <label><span>裂纹分支最少</span><NumericInput value={rigidFractureParameters.crackBranchMin} min={0} max={16} integer onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, crackBranchMin: Math.max(0, Math.min(16, value)) }))} /></label>
                <label><span>裂纹分支最多</span><NumericInput value={rigidFractureParameters.crackBranchMax} min={0} max={16} integer onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, crackBranchMax: Math.max(0, Math.min(16, value)) }))} /></label>
                <label><span>释放延迟tick</span><NumericInput value={rigidFractureParameters.releaseDelayTicks} min={0} max={120} integer onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, releaseDelayTicks: Math.max(0, Math.min(120, value)) }))} /></label>
                <label title="玩家、投射物或技能造成轻微表面损伤的最低能量"><span>攻击崩边能</span><NumericInput value={rigidFractureParameters.impactChipEnergy} min={0} max={100000} onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, impactChipEnergy: Math.max(0, value) }))} /></label>
                <label title="单次攻击直接显示裂纹的最低能量；较弱攻击也可通过长期疲劳达到裂纹阶段"><span>攻击裂纹能</span><NumericInput value={rigidFractureParameters.impactCrackEnergy} min={0} max={100000} onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, impactCrackEnergy: Math.max(0, value) }))} /></label>
                <label title="攻击进入结构破坏级别的能量；仍需累计结构损伤，普通情况下不会首击直接碎裂"><span>攻击断裂能</span><NumericInput value={rigidFractureParameters.impactBreakEnergy} min={0} max={100000} onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, impactBreakEnergy: Math.max(0, value) }))} /></label>
                <label title="两个动态刚体互相撞击时进入断裂级别的能量"><span>碰撞断裂阈值</span><NumericInput value={rigidFractureParameters.collisionBreakThreshold} min={0} max={100000} onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, collisionBreakThreshold: Math.max(0, value) }))} /></label>
                <label><span>落地崩边能</span><NumericInput value={rigidFractureParameters.landingChipEnergy} min={0} max={100000} onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, landingChipEnergy: Math.max(0, value) }))} /></label>
                <label><span>落地裂纹能</span><NumericInput value={rigidFractureParameters.landingCrackEnergy} min={0} max={100000} onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, landingCrackEnergy: Math.max(0, value) }))} /></label>
                <label><span>落地断裂能</span><NumericInput value={rigidFractureParameters.landingBreakEnergy} min={0} max={100000} onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, landingBreakEnergy: Math.max(0, value) }))} /></label>
                <label title="尖角、小接触面会放大损伤；金属通常较低，脆性冰通常较高"><span>应力敏感度</span><NumericInput value={rigidFractureParameters.contactStressSensitivity} min={0} max={4} onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, contactStressSensitivity: Math.max(0, Math.min(4, value)) }))} /></label>
                <label><span>落地冷却tick</span><NumericInput value={rigidFractureParameters.landingCooldownTicks} min={0} max={120} integer onValueChange={(value) => setRigidFractureParameters((current) => ({ ...current, landingCooldownTicks: Math.max(0, Math.min(120, value)) }))} /></label>
              </div></details>
            </>}
          </div>
        </div>
        <div
          className={`map-canvas-wrap mode-${mode}${isPanning ? " is-panning" : ""}${dropPreview ? " dragover" : ""}`}
          ref={canvasWrapRef}
          onDragOver={dragAssetOverCanvas}
          onDragLeave={leaveCanvasDrag}
          onDrop={dropAssetOnCanvas}
        >
          <canvas ref={canvasRef} onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer} onWheel={zoomCanvas} onContextMenu={(event) => event.preventDefault()} />
          {!editingAsset && !backgroundAsset && <div className="preview-empty"><strong>等待地图背景</strong><span>{project.width}×{project.height}</span></div>}
          {editingAsset && <div className="map-asset-edit-badge"><Pencil size={13} /><span><strong>物体轮廓模板</strong>{editingAsset.name}</span></div>}
          {mode === "iceBody" && <div className={`map-ice-authoring-hint${icePreview && !icePreview.ok ? " error" : ""}`}><Snowflake size={14} /><span>{drawing && icePreview ? icePreview.message : editingAsset ? "在素材图片上画出唯一的完整闭合程序刚体轮廓" : iceClosureMode === "terrain" ? `从同一条实体地形起笔并落笔 · 可借用 ${iceTerrainContours.length} 条轮廓` : "按住鼠标画出程序刚体边界，松开后自动闭合"}</span><small>模板只提供物理和美术默认值；元素标签由游戏自行解释</small></div>}
        </div>
        <div className="map-canvas-status"><span>{modes.find((item) => item.value === mode)?.label} · {documentWidth}×{documentHeight} · {Math.round(view.zoom * 100)}%</span><span>{editingAsset ? `${editingAsset.name} · ${activeOutlines.length} 条模板轮廓${activeDraftOutlines.length ? ` · ${activeDraftOutlines.length} 条草稿` : ""}` : `${project.objects.length} 个物体 · ${project.outlines.length} 条地图轮廓${project.draftOutlines.length ? ` · ${project.draftOutlines.length} 条草稿` : ""}`}</span></div>
      </main>

      <aside className="map-inspector">
        <section className="inspector-section map-object-inspector">
          <div className="section-heading"><div><strong>{editingAsset && !selectedOutline ? "物体轮廓模板" : "选中对象"}</strong><span>{selectedObject ? `贴图物体 ${project.objects.findIndex((item) => item.id === selectedObject.id) + 1}/${project.objects.length}` : selectedOutline ? selectionOutlineLabel(selectedOutline) : selectedMatterStroke ? `${selectedMatterStroke.carrier === "gas" ? "气体" : "液体"}画笔` : editingAsset ? "素材级" : "未选择"}</span></div>{selectedCanvasKind && <button type="button" className="icon-button small danger" title="删除选中对象 Delete" onClick={removeSelectedCanvasTarget}><Trash2 size={14} /></button>}</div>
          {editingAsset && !selectedOutline ? <>
            <div className="map-selected-preview"><img src={editingAsset.url} alt="" /><div><strong>{editingAsset.name}</strong><span>{editingAsset.width}×{editingAsset.height}</span></div></div>
            <div className="map-asset-template-help">在中间画布直接绘制。碰撞轮廓进入地面层，程序刚体使用唯一闭合轮廓，遮挡轮廓进入遮挡层；使用该素材的实例会继承同一套外观、物理和破碎参数。</div>
          </> : selectedObject && selectedObjectAsset ? <>
            <div className="map-selected-preview"><img src={selectedObjectAsset.url} alt="" /><div><strong>{selectedObjectAsset.name}</strong><span>{layerLabels[selectedObject.layer]}</span></div></div>
            <div className="map-inspector-label">变换</div>
            <div className="field-grid two-columns"><label className="field"><span>X</span><NumericInput value={selectedObject.x} step={1} onValueChange={(value) => patchSelectedObject({ x: value })} /></label><label className="field"><span>Y</span><NumericInput value={selectedObject.y} step={1} onValueChange={(value) => patchSelectedObject({ y: value })} /></label></div>
             <div className="field-grid two-columns"><label className="field"><span>缩放</span><NumericInput value={selectedObject.scale} min={0.01} max={16} step={0.05} onValueChange={(value) => patchSelectedObject({ scale: Math.max(0.01, value) })} /></label><label className="field"><span>旋转</span><NumericInput value={selectedObject.rotation} step={1} onValueChange={(value) => patchSelectedObject({ rotation: value })} /></label></div>
             <div className="map-inspector-label">运动</div>
             <label className="field"><span>运动类型</span><select value={selectedObject.mode} onChange={(event) => patchSelectedObject({ mode: event.target.value as MapObjectData["mode"] })}><option value="static">静态</option><option value="dynamic">动态</option></select></label>
             {selectedObject.mode === "dynamic" && <div className="map-motion-settings">
               <label className="field"><span>移动方向</span><select value={selectedObject.motion.direction} onChange={(event) => patchSelectedObject({ motion: { ...selectedObject.motion, direction: event.target.value as MapObjectMotionData["direction"] } })}><option value="horizontal">左右移动</option><option value="vertical">上下移动</option></select></label>
               <div className="field-grid two-columns"><label className="field"><span>速度（米/秒）</span><NumericInput value={selectedObject.motion.speedMetersPerSecond} min={0.1} max={100} step={0.1} onValueChange={(value) => patchSelectedObject({ motion: { ...selectedObject.motion, speedMetersPerSecond: Math.max(0.1, Math.min(100, value)) } })} /></label><label className="field"><span>单程范围（米）</span><NumericInput value={selectedObject.motion.rangeMeters} min={0.1} max={1000} step={0.1} onValueChange={(value) => patchSelectedObject({ motion: { ...selectedObject.motion, rangeMeters: Math.max(0.1, Math.min(1000, value)) } })} /></label></div>
               <label className="field"><span>初始位置（%）</span><NumericInput value={Math.round(selectedObject.motion.initialProgress * 100)} min={0} max={100} step={5} onValueChange={(value) => patchSelectedObject({ motion: { ...selectedObject.motion, initialProgress: Math.max(0, Math.min(100, value)) / 100 } })} /></label>
               <small className="map-motion-help">0% 为左/下端点，50% 为路径中间，100% 为右/上端点；当前摆放位置就是开场位置。</small>
             </div>}
             <div className="map-inspector-label">图层轮廓</div>
            <label className="field"><span>图层</span><select value={selectedObject.layer} onChange={(event) => patchSelectedObject({ layer: event.target.value as MapLayer })}>{Object.entries(layerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {selectedObject.layer === "rigid" && (selectedObjectRigidOutline?.rigidBody
              ? <label className="field"><span>元素标签（素材级）</span><DeferredTextInput value={selectedObjectRigidOutline.rigidBody.elementTag} onValueChange={patchSelectedAssetRigidTag} /></label>
              : <label className="field"><span>元素标签</span><DeferredTextInput value={selectedObject.elementTag} onValueChange={(elementTag) => patchSelectedObject({ elementTag })} /></label>)}
          </> : selectedOutline && selectedOutlineBounds ? <>
            <div className="map-selection-summary">
              <span className="map-selection-icon" style={{ color: selectedOutline.rigidBody ? selectedOutline.rigidBody.visual.baseColor : selectedOutline.layer === "occlusion" ? layerColors.occlusion : layerColors.collision }}>
                {selectedOutline.rigidBody ? <Snowflake size={19} /> : selectedOutline.shape === "groundLine" ? <Box size={19} /> : <Eye size={19} />}
              </span>
              <div><strong>{selectionOutlineLabel(selectedOutline)}</strong><span>{selectedOutline.points.length} 个点 · {Math.round(selectedOutlineBounds.right - selectedOutlineBounds.left)}×{Math.round(selectedOutlineBounds.bottom - selectedOutlineBounds.top)}px</span></div>
            </div>
            <div className="map-inspector-label">位置</div>
            <div className="field-grid two-columns">
              <label className="field"><span>中心 X</span><NumericInput value={selectedOutlineBounds.centerX} step={1} onValueChange={(value) => moveSelectedOutlineCenter(value, selectedOutlineBounds.centerY)} /></label>
              <label className="field"><span>中心 Y</span><NumericInput value={selectedOutlineBounds.centerY} step={1} onValueChange={(value) => moveSelectedOutlineCenter(selectedOutlineBounds.centerX, value)} /></label>
            </div>
            {selectedOutline.rigidBody ? <>
              <div className="map-inspector-label">基本参数</div>
              <label className="field"><span>模板</span><select value={selectedOutline.rigidBody.templateId} onChange={(event) => {
                const templateId = event.target.value as ProceduralRigidTemplateId;
                patchSelectedOutline((outline) => outline.rigidBody ? { ...outline, rigidBody: { ...outline.rigidBody, templateId, visual: { ...outline.rigidBody.visual, templateId } } } : outline);
              }}>{Object.values(PROCEDURAL_RIGID_TEMPLATES).map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}</select></label>
              <label className="field"><span>元素标签</span><DeferredTextInput value={selectedOutline.rigidBody.elementTag} onValueChange={(elementTag) => patchSelectedOutline((outline) => outline.rigidBody ? { ...outline, rigidBody: { ...outline.rigidBody, elementTag } } : outline)} /></label>
              <div className="field-grid two-columns">
                <label className="field"><span>外观来源</span><select value={selectedOutline.rigidBody.visual.sourceMode} disabled><option value="procedural">程序生成</option><option value="sourceImage">原始图片</option></select></label>
                <label className="field"><span>封边</span><select value={selectedOutline.rigidBody.closureMode} disabled={Boolean(editingAsset)} onChange={(event) => patchSelectedOutline((outline) => outline.rigidBody ? { ...outline, rigidBody: { ...outline.rigidBody, closureMode: event.target.value as IceBodyClosureMode } } : outline)}><option value="manual">完整手绘</option><option value="terrain">借地形闭合</option></select></label>
              </div>
              {selectedOutline.rigidBody.closureMode === "terrain" && <label className="field"><span>地形路径</span><select value={selectedOutline.rigidBody.routePreference || "shorter"} onChange={(event) => patchSelectedOutline((outline) => outline.rigidBody ? { ...outline, rigidBody: { ...outline.rigidBody, routePreference: event.target.value as ProceduralRigidTerrainRoutePreference } } : outline)}><option value="shorter">较短侧</option><option value="alternate">另一侧</option></select></label>}
              <div className="field-grid two-columns">
                <label className="field"><span>纹理种子</span><NumericInput value={selectedOutline.rigidBody.seed} min={1} max={4294967295} integer onValueChange={(value) => patchSelectedOutline((outline) => outline.rigidBody ? { ...outline, rigidBody: { ...outline.rigidBody, seed: Math.max(1, Math.floor(value)) >>> 0 || 1 } } : outline)} /></label>
                <label className="field"><span>分面数量</span><NumericInput value={selectedOutline.rigidBody.facets.length} onValueChange={() => {}} min={0} integer disabled /></label>
              </div>
              <details className="map-selection-details" open><summary>外观参数</summary><div>
                <div className="field-grid three-columns">
                  <label className="field"><span>基础色</span><input type="color" value={selectedOutline.rigidBody.visual.baseColor} onChange={(event) => patchSelectedRigidVisual({ baseColor: event.target.value })} /></label>
                  <label className="field"><span>暗部色</span><input type="color" value={selectedOutline.rigidBody.visual.shadowColor} onChange={(event) => patchSelectedRigidVisual({ shadowColor: event.target.value })} /></label>
                  <label className="field"><span>高光色</span><input type="color" value={selectedOutline.rigidBody.visual.highlightColor} onChange={(event) => patchSelectedRigidVisual({ highlightColor: event.target.value })} /></label>
                </div>
                <div className="field-grid two-columns">
                  <label className="field"><span>边缘色</span><input type="color" value={selectedOutline.rigidBody.visual.edgeColor} onChange={(event) => patchSelectedRigidVisual({ edgeColor: event.target.value })} /></label>
                  <label className="field"><span>破碎特效色</span><input type="color" value={selectedOutline.rigidBody.visual.fractureColor} onChange={(event) => patchSelectedRigidVisual({ fractureColor: event.target.value })} /></label>
                </div>
                <div className="field-grid two-columns">
                  <label className="field"><span>不透明度（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.visual.opacity * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidVisual({ opacity: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                  <label className="field"><span>边缘锯齿（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.visual.edgeJaggedness * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidVisual({ edgeJaggedness: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                </div>
                <div className="field-grid two-columns">
                  <label className="field"><span>分面尺寸</span><NumericInput value={selectedOutline.rigidBody.visual.facetScale} min={6} max={128} integer onValueChange={(value) => patchSelectedRigidVisual({ facetScale: Math.max(6, Math.min(128, value)) })} /></label>
                  <label className="field"><span>分面变化（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.visual.facetVariation * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidVisual({ facetVariation: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                </div>
                <div className="field-grid two-columns">
                  <label className="field"><span>纹理强度（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.visual.textureStrength * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidVisual({ textureStrength: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                  <label className="field"><span>边缘亮度（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.visual.edgeBrightness * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidVisual({ edgeBrightness: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                </div>
                <label className="field"><span>边缘宽度（px）</span><NumericInput value={selectedOutline.rigidBody.visual.edgeWidthPixels} min={0} max={24} onValueChange={(value) => patchSelectedRigidVisual({ edgeWidthPixels: Math.max(0, Math.min(24, value)) })} /></label>
                <div className="field-grid two-columns">
                  <label className="field"><span>体积感（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.visual.volumeDepth * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidVisual({ volumeDepth: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                  <label className="field"><span>透光率（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.visual.transmission * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidVisual({ transmission: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                </div>
                <div className="field-grid two-columns">
                  <label className="field"><span>吸收率（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.visual.absorption * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidVisual({ absorption: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                  <label className="field"><span>粗糙度（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.visual.roughness * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidVisual({ roughness: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                </div>
                <div className="field-grid two-columns">
                  <label className="field"><span>高光强度（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.visual.specularStrength * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidVisual({ specularStrength: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                  <label className="field"><span>夹杂密度（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.visual.inclusionDensity * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidVisual({ inclusionDensity: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                </div>
                <label className="field"><span>微裂纹密度（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.visual.microCrackDensity * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidVisual({ microCrackDensity: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                <div className="field-grid three-columns">
                  <label className="field"><span>纹理方向（°）</span><NumericInput value={selectedOutline.rigidBody.visual.grainDirectionDegrees} min={-180} max={180} onValueChange={(value) => patchSelectedRigidVisual({ grainDirectionDegrees: Math.max(-180, Math.min(180, value)) })} /></label>
                  <label className="field"><span>方向性（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.visual.anisotropy * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidVisual({ anisotropy: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                  <label className="field"><span>光照方向（°）</span><NumericInput value={selectedOutline.rigidBody.visual.lightAngleDegrees} min={-180} max={180} onValueChange={(value) => patchSelectedRigidVisual({ lightAngleDegrees: Math.max(-180, Math.min(180, value)) })} /></label>
                </div>
              </div></details>
              <details className="map-selection-details" open><summary>物理参数</summary><div>
                <label className="field"><span>锚定模式</span><select value={selectedOutline.rigidBody.physical.anchoringMode} onChange={(event) => patchSelectedRigidPhysical({ anchoringMode: event.target.value as ProceduralRigidPhysicalAuthoringData["anchoringMode"] })}><option value="dynamic">动态</option><option value="fixed">固定</option><option value="terrainAttached">附着地形</option></select></label>
                <div className="field-grid two-columns">
                  <label className="field"><span>密度</span><NumericInput value={selectedOutline.rigidBody.physical.density} min={0.001} max={100} onValueChange={(value) => patchSelectedRigidPhysical({ density: Math.max(0.001, Math.min(100, value)) })} /></label>
                  <label className="field"><span>重力倍率</span><NumericInput value={selectedOutline.rigidBody.physical.gravityScale} min={-8} max={8} onValueChange={(value) => patchSelectedRigidPhysical({ gravityScale: Math.max(-8, Math.min(8, value)) })} /></label>
                </div>
                <div className="field-grid two-columns">
                  <label className="field"><span>摩擦力（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.physical.friction * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidPhysical({ friction: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                  <label className="field"><span>弹性（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.physical.restitution * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidPhysical({ restitution: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                </div>
                <div className="field-grid two-columns">
                  <label className="field"><span>线性阻尼</span><NumericInput value={selectedOutline.rigidBody.physical.linearDamping} min={0} max={20} onValueChange={(value) => patchSelectedRigidPhysical({ linearDamping: Math.max(0, Math.min(20, value)) })} /></label>
                  <label className="field"><span>旋转阻尼</span><NumericInput value={selectedOutline.rigidBody.physical.angularDamping} min={0} max={20} onValueChange={(value) => patchSelectedRigidPhysical({ angularDamping: Math.max(0, Math.min(20, value)) })} /></label>
                </div>
                <div className="field-grid three-columns">
                  <label className="field"><span>硬度（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.physical.hardness * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidPhysical({ hardness: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                  <label className="field"><span>韧性（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.physical.toughness * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidPhysical({ toughness: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                  <label className="field"><span>脆性（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.physical.brittleness * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidPhysical({ brittleness: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                </div>
                <div className="field-grid two-columns">
                  <label className="field"><span>各向异性（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.physical.anisotropy * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidPhysical({ anisotropy: Math.max(0, Math.min(100, value)) / 100 })} /></label>
                  <label className="field"><span>材料纹向（°）</span><NumericInput value={selectedOutline.rigidBody.physical.grainAngleDegrees} min={-180} max={180} onValueChange={(value) => patchSelectedRigidPhysical({ grainAngleDegrees: Math.max(-180, Math.min(180, value)) })} /></label>
                </div>
                <label className="field"><span>碎屑比例（%）</span><NumericInput value={Math.round(selectedOutline.rigidBody.physical.debrisFraction * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedRigidPhysical({ debrisFraction: Math.max(0, Math.min(100, value)) / 100 })} /></label>
              </div></details>
              <details className="map-selection-details" open><summary>破碎参数</summary><div>
                <div className="field-grid two-columns">
                  <label className="field"><span>主碎片最少</span><NumericInput value={selectedOutline.rigidBody.fracture.primaryFragmentMin} min={2} max={8} integer onValueChange={(value) => patchSelectedRigidFracture({ primaryFragmentMin: Math.max(2, Math.min(8, value)) })} /></label>
                  <label className="field"><span>主碎片最多</span><NumericInput value={selectedOutline.rigidBody.fracture.primaryFragmentMax} min={2} max={8} integer onValueChange={(value) => patchSelectedRigidFracture({ primaryFragmentMax: Math.max(2, Math.min(8, value)) })} /></label>
                </div>
                <div className="field-grid two-columns">
                  <label className="field"><span>每次冲击碎片上限</span><NumericInput value={selectedOutline.rigidBody.fracture.maxFragmentsPerImpact} min={2} max={8} integer onValueChange={(value) => patchSelectedRigidFracture({ maxFragmentsPerImpact: Math.max(2, Math.min(8, value)) })} /></label>
                  <label className="field"><span>同源碎片上限</span><NumericInput value={selectedOutline.rigidBody.fracture.maxActiveFragmentsPerFamily} min={4} max={256} integer onValueChange={(value) => patchSelectedRigidFracture({ maxActiveFragmentsPerFamily: Math.max(4, Math.min(256, value)) })} /></label>
                </div>
                <div className="field-grid two-columns">
                  <label className="field"><span>最小碎片面积（px²）</span><NumericInput value={selectedOutline.rigidBody.fracture.minimumFragmentArea} min={1} max={100000} onValueChange={(value) => patchSelectedRigidFracture({ minimumFragmentArea: Math.max(1, value) })} /></label>
                  <label className="field"><span>最小碎片宽度（px）</span><NumericInput value={selectedOutline.rigidBody.fracture.minimumFragmentWidth} min={1} max={1024} onValueChange={(value) => patchSelectedRigidFracture({ minimumFragmentWidth: Math.max(1, value) })} /></label>
                </div>
                <div className="field-grid two-columns">
                  <label className="field"><span>裂纹分支最少</span><NumericInput value={selectedOutline.rigidBody.fracture.crackBranchMin} min={0} max={16} integer onValueChange={(value) => patchSelectedRigidFracture({ crackBranchMin: Math.max(0, Math.min(16, value)) })} /></label>
                  <label className="field"><span>裂纹分支最多</span><NumericInput value={selectedOutline.rigidBody.fracture.crackBranchMax} min={0} max={16} integer onValueChange={(value) => patchSelectedRigidFracture({ crackBranchMax: Math.max(0, Math.min(16, value)) })} /></label>
                </div>
                <label className="field"><span>释放延迟（tick）</span><NumericInput value={selectedOutline.rigidBody.fracture.releaseDelayTicks} min={0} max={120} integer onValueChange={(value) => patchSelectedRigidFracture({ releaseDelayTicks: Math.max(0, Math.min(120, value)) })} /></label>
                <div className="field-grid three-columns">
                  <label className="field"><span>攻击崩边能量</span><NumericInput value={selectedOutline.rigidBody.fracture.impactChipEnergy} min={0} max={100000} onValueChange={(value) => patchSelectedRigidFracture({ impactChipEnergy: Math.max(0, value) })} /></label>
                  <label className="field"><span>攻击裂纹能量</span><NumericInput value={selectedOutline.rigidBody.fracture.impactCrackEnergy} min={0} max={100000} onValueChange={(value) => patchSelectedRigidFracture({ impactCrackEnergy: Math.max(0, value) })} /></label>
                  <label className="field"><span>攻击断裂能量</span><NumericInput value={selectedOutline.rigidBody.fracture.impactBreakEnergy} min={0} max={100000} onValueChange={(value) => patchSelectedRigidFracture({ impactBreakEnergy: Math.max(0, value) })} /></label>
                </div>
                <label className="field"><span>碰撞断裂阈值</span><NumericInput value={selectedOutline.rigidBody.fracture.collisionBreakThreshold} min={0} max={100000} onValueChange={(value) => patchSelectedRigidFracture({ collisionBreakThreshold: Math.max(0, value) })} /></label>
                <div className="field-grid three-columns">
                  <label className="field"><span>落地崩边能量</span><NumericInput value={selectedOutline.rigidBody.fracture.landingChipEnergy} min={0} max={100000} onValueChange={(value) => patchSelectedRigidFracture({ landingChipEnergy: Math.max(0, value) })} /></label>
                  <label className="field"><span>落地裂纹能量</span><NumericInput value={selectedOutline.rigidBody.fracture.landingCrackEnergy} min={0} max={100000} onValueChange={(value) => patchSelectedRigidFracture({ landingCrackEnergy: Math.max(0, value) })} /></label>
                  <label className="field"><span>落地断裂能量</span><NumericInput value={selectedOutline.rigidBody.fracture.landingBreakEnergy} min={0} max={100000} onValueChange={(value) => patchSelectedRigidFracture({ landingBreakEnergy: Math.max(0, value) })} /></label>
                </div>
                <div className="field-grid two-columns">
                  <label className="field"><span>应力敏感度</span><NumericInput value={selectedOutline.rigidBody.fracture.contactStressSensitivity} min={0} max={4} onValueChange={(value) => patchSelectedRigidFracture({ contactStressSensitivity: Math.max(0, Math.min(4, value)) })} /></label>
                  <label className="field"><span>落地冷却（tick）</span><NumericInput value={selectedOutline.rigidBody.fracture.landingCooldownTicks} min={0} max={120} integer onValueChange={(value) => patchSelectedRigidFracture({ landingCooldownTicks: Math.max(0, Math.min(120, value)) })} /></label>
                </div>
              </div></details>
            </> : selectedOutline.shape === "groundLine" ? <>
              <div className="map-inspector-label">碰撞参数</div>
              <label className="field"><span>碰撞方向</span><select value={selectedOutline.collisionType} onChange={(event) => patchSelectedOutline((outline) => ({ ...outline, collisionType: event.target.value as MapOutlineData["collisionType"] }))}><option value="solid">双向</option><option value="oneWay">单向</option></select></label>
              <label className="field checkbox-field"><input type="checkbox" checked={selectedOutline.sideCollision !== false} onChange={(event) => patchSelectedOutline((outline) => ({ ...outline, sideCollision: event.target.checked }))} /><span>启用侧面碰撞</span></label>
              <label className="field"><span>厚度（px）</span><NumericInput value={selectedOutline.thickness} min={1} max={256} integer onValueChange={(value) => patchSelectedOutline((outline) => { const thickness = Math.max(1, Math.min(256, value)); return { ...outline, thickness, points: createGroundLinePoints(outline.points[0], outline.points[1], thickness) }; })} /></label>
            </> : selectedOutline.layer === "collision" ? <>
              <div className="map-inspector-label">碰撞参数</div>
              <label className="field"><span>碰撞类型</span><select value={selectedOutline.collisionType} onChange={(event) => patchSelectedOutline((outline) => ({ ...outline, collisionType: event.target.value as MapOutlineData["collisionType"] }))}><option value="solid">实体</option><option value="oneWay">单向穿透</option><option value="trigger">触发区</option></select></label>
            </> : <div className="map-asset-template-help">遮挡区域会按当前闭合轮廓同步到 Unity。可以修改中心位置，需要更换形状时删除后重新绘制。</div>}
          </> : selectedMatterStroke && selectedMatterBounds ? <>
            <div className="map-selection-summary">
              <span className="map-selection-icon" style={{ color: selectedMatterStroke.profile.visual.baseColor }}><CircleDot size={19} /></span>
              <div><strong>{selectedMatterStroke.elementTag || "未命名"} · {selectedMatterStroke.carrier === "gas" ? "气体" : "液体"}</strong><span>{selectedMatterStroke.points.length} 个点 · 画笔半径 {Math.round(selectedMatterStroke.radius)}px</span></div>
            </div>
            <div className="map-inspector-label">基本参数</div>
            <label className="field"><span>相态</span><select value={selectedMatterStroke.carrier} onChange={(event) => { const carrier = event.target.value as MapMatterStrokeData["carrier"]; patchSelectedMatterStroke((stroke) => ({ ...stroke, carrier, profile: normalizeMatterProfile(carrier, stroke.elementTag, stroke.profile) })); }}><option value="liquid">液体</option><option value="gas">气体</option></select></label>
            <label className="field"><span>元素标签</span><DeferredTextInput value={selectedMatterStroke.elementTag} onValueChange={(elementTag) => patchSelectedMatterStroke((stroke) => ({ ...stroke, elementTag: elementTag.trim() || "untagged" }))} /></label>
            <div className="field-grid two-columns">
              <label className="field"><span>中心 X</span><NumericInput value={selectedMatterBounds.centerX} step={1} onValueChange={(value) => moveSelectedMatterCenter(value, selectedMatterBounds.centerY)} /></label>
              <label className="field"><span>中心 Y</span><NumericInput value={selectedMatterBounds.centerY} step={1} onValueChange={(value) => moveSelectedMatterCenter(selectedMatterBounds.centerX, value)} /></label>
            </div>
            <label className="field"><span>画笔半径（px）</span><NumericInput value={selectedMatterStroke.radius} min={1} max={256} integer onValueChange={(value) => patchSelectedMatterStroke((stroke) => ({ ...stroke, radius: Math.max(1, Math.min(256, value)) }))} /></label>
            <details className="map-selection-details" open><summary>外观参数</summary><div>
              <div className="field-grid three-columns"><label className="field"><span>基础色</span><input type="color" value={selectedMatterStroke.profile.visual.baseColor} onChange={(event) => patchSelectedMatterVisual({ baseColor: event.target.value })} /></label><label className="field"><span>次级色</span><input type="color" value={selectedMatterStroke.profile.visual.secondaryColor} onChange={(event) => patchSelectedMatterVisual({ secondaryColor: event.target.value })} /></label><label className="field"><span>发光色</span><input type="color" value={selectedMatterStroke.profile.visual.emissionColor} onChange={(event) => patchSelectedMatterVisual({ emissionColor: event.target.value })} /></label></div>
              <label className="field"><span>不透明度（%）</span><NumericInput value={Math.round(selectedMatterStroke.profile.visual.opacity * 100)} min={0} max={100} integer onValueChange={(value) => patchSelectedMatterVisual({ opacity: Math.max(0, Math.min(100, value)) / 100 })} /></label>
              <div className="field-grid two-columns"><label className="field"><span>粒子尺寸</span><NumericInput value={selectedMatterStroke.profile.visual.particleScale} min={0.1} max={4} step={0.05} onValueChange={(value) => patchSelectedMatterVisual({ particleScale: Math.max(0.1, Math.min(4, value)) })} /></label><label className="field"><span>边缘柔化</span><NumericInput value={selectedMatterStroke.profile.visual.edgeSoftness} min={0} max={1} step={0.05} onValueChange={(value) => patchSelectedMatterVisual({ edgeSoftness: Math.max(0, Math.min(1, value)) })} /></label></div>
              <div className="field-grid two-columns"><label className="field"><span>细节尺度</span><NumericInput value={selectedMatterStroke.profile.visual.detailScale} min={0.1} max={8} step={0.1} onValueChange={(value) => patchSelectedMatterVisual({ detailScale: Math.max(0.1, Math.min(8, value)) })} /></label><label className="field"><span>折射强度</span><NumericInput value={selectedMatterStroke.profile.visual.refractionStrength} min={0} max={1} step={0.05} onValueChange={(value) => patchSelectedMatterVisual({ refractionStrength: Math.max(0, Math.min(1, value)) })} /></label></div>
              <div className="field-grid two-columns"><label className="field"><span>发光强度</span><NumericInput value={selectedMatterStroke.profile.visual.glowStrength} min={0} max={8} step={0.1} onValueChange={(value) => patchSelectedMatterVisual({ glowStrength: Math.max(0, Math.min(8, value)) })} /></label>{selectedMatterStroke.carrier === "liquid" && <label className="field"><span>泡沫量</span><NumericInput value={selectedMatterStroke.profile.visual.foamAmount} min={0} max={1} step={0.05} onValueChange={(value) => patchSelectedMatterVisual({ foamAmount: Math.max(0, Math.min(1, value)) })} /></label>}</div>
            </div></details>
            <details className="map-selection-details" open><summary>物理参数</summary><div>
              <label className="field"><span>密度</span><NumericInput value={selectedMatterStroke.profile.physical.density} min={0.001} max={100} step={0.05} onValueChange={(value) => patchSelectedMatterPhysical({ density: Math.max(0.001, Math.min(100, value)) })} /></label>
              {selectedMatterStroke.carrier === "liquid" ? <>
                <div className="field-grid two-columns"><label className="field"><span>黏度</span><NumericInput value={selectedMatterStroke.profile.physical.viscosity} min={0} max={8} step={0.05} onValueChange={(value) => patchSelectedMatterPhysical({ viscosity: Math.max(0, Math.min(8, value)) })} /></label><label className="field"><span>表面张力</span><NumericInput value={selectedMatterStroke.profile.physical.surfaceTension} min={0} max={4} step={0.05} onValueChange={(value) => patchSelectedMatterPhysical({ surfaceTension: Math.max(0, Math.min(4, value)) })} /></label></div>
                <div className="field-grid two-columns"><label className="field"><span>流动速度</span><NumericInput value={selectedMatterStroke.profile.physical.flowSpeed} min={0.05} max={8} step={0.05} onValueChange={(value) => patchSelectedMatterPhysical({ flowSpeed: Math.max(0.05, Math.min(8, value)) })} /></label><label className="field"><span>重力倍率</span><NumericInput value={selectedMatterStroke.profile.physical.gravityScale} min={-4} max={4} step={0.05} onValueChange={(value) => patchSelectedMatterPhysical({ gravityScale: Math.max(-4, Math.min(4, value)) })} /></label></div>
                <label className="field"><span>蒸发半衰期（秒）</span><NumericInput value={selectedMatterStroke.profile.physical.evaporationHalfLifeSeconds} min={0} max={86400} step={10} onValueChange={(value) => patchSelectedMatterPhysical({ evaporationHalfLifeSeconds: Math.max(0, Math.min(86400, value)) })} /></label>
              </> : <>
                <div className="field-grid two-columns"><label className="field"><span>浮力</span><NumericInput value={selectedMatterStroke.profile.physical.buoyancy} min={-4} max={4} step={0.05} onValueChange={(value) => patchSelectedMatterPhysical({ buoyancy: Math.max(-4, Math.min(4, value)) })} /></label><label className="field"><span>扩散率</span><NumericInput value={selectedMatterStroke.profile.physical.diffusion} min={0} max={4} step={0.05} onValueChange={(value) => patchSelectedMatterPhysical({ diffusion: Math.max(0, Math.min(4, value)) })} /></label></div>
                <label className="field"><span>阻力</span><NumericInput value={selectedMatterStroke.profile.physical.drag} min={0} max={8} step={0.05} onValueChange={(value) => patchSelectedMatterPhysical({ drag: Math.max(0, Math.min(8, value)) })} /></label>
                <label className="field"><span>消散半衰期（秒）</span><NumericInput value={selectedMatterStroke.profile.physical.dissipationHalfLifeSeconds} min={0} max={86400} step={10} onValueChange={(value) => patchSelectedMatterPhysical({ dissipationHalfLifeSeconds: Math.max(0, Math.min(86400, value)) })} /></label>
              </>}
            </div></details>
          </> : <div className="inspector-empty"><MousePointer2 size={24} /><strong>点击画布对象进行选择</strong></div>}
        </section>
        <section className="inspector-section map-outline-section">
          <div className="section-heading"><div><strong>{editingAsset ? "物体模板轮廓" : "地图轮廓"}</strong><span>{activeOutlines.length} 条{activeDraftOutlines.length ? ` · ${activeDraftOutlines.length} 条草稿` : ""}</span></div></div>
          <div className="map-outline-actions">
            <button type="button" title="撤销上一条轮廓" disabled={!activeOutlines.length && !activeDraftOutlines.length} onClick={undoOutline}><ChevronLeft size={14} />撤销轮廓</button>
            <button type="button" title="清空未闭合草稿" disabled={!activeDraftOutlines.length} onClick={clearDraftOutlines}><X size={14} />清空草稿</button>
            <button type="button" className="danger-text" title="清空全部轮廓" disabled={!activeOutlines.length && !activeDraftOutlines.length} onClick={clearAllOutlines}><Trash2 size={14} />清空全部</button>
          </div>
          <div className="map-outline-list">
            {!activeOutlines.length && !activeDraftOutlines.length && <div className="list-empty">{editingAsset ? "暂无物体模板轮廓" : "暂无地图轮廓"}</div>}
            {activeOutlines.map((outline) => {
              const style = outline.shape === "groundLine" ? rectangleCollisionStyle(outline.collisionType, outline.sideCollision !== false) : null;
              const color = outline.rigidBody ? outline.rigidBody.visual.baseColor : outline.layer === "occlusion" ? layerColors.occlusion : outline.layer === "rigid" ? elementColors[outline.element] : style?.stroke || layerColors.collision;
              const convertibleRigid = !outline.rigidBody && outline.layer === "rigid" && outline.closed && outline.points.length >= 3;
              return <div className={`map-outline-item${selectedOutlineId === outline.id ? " selected" : ""}`} key={outline.id} onClick={() => selectCanvasTarget("outline", outline.id)}>
                {outline.rigidBody ? <Snowflake size={13} style={{ color }} /> : <CircleDot size={13} style={{ color }} />}
                <span><strong>{outline.rigidBody ? `${PROCEDURAL_RIGID_TEMPLATES[outline.rigidBody.templateId].label}程序刚体` : outline.layer === "occlusion" ? "遮挡区域" : outline.layer === "rigid" ? "程序刚体（待迁移）" : outline.shape === "groundLine" ? "矩形碰撞" : "实体碰撞"}</strong><small>{outline.rigidBody ? `${outline.rigidBody.closureMode === "terrain" ? "借地形" : "完整手绘"} · 标签 ${outline.rigidBody.elementTag || "无"} · ${outline.rigidBody.facets.length} 分面 · Seed ${outline.rigidBody.seed}` : outline.shape === "groundLine" ? `${rectangleCollisionLabel(outline.collisionType, outline.sideCollision !== false)} · ${Math.round(outline.thickness)}px` : `${outline.points.length} 点`}</small></span>
                <div className="map-outline-item-actions">
                  {outline.rigidBody && <button type="button" className={editingRigidOutlineId === outline.id ? "active" : ""} title="载入并编辑程序刚体全部参数" onClick={(event) => { event.stopPropagation(); loadProceduralRigidParameters(outline.id); }}><Pencil size={13} /></button>}
                  {convertibleRigid && <button type="button" className="map-outline-convert-ice" title="转换为当前模板的程序刚体" onClick={(event) => { event.stopPropagation(); convertOutlineToProgramRigid(outline.id); }}><Snowflake size={13} /></button>}
                  <button type="button" title="删除轮廓" onClick={(event) => { event.stopPropagation(); deleteOutline(outline.id); }}><X size={13} /></button>
                </div>
              </div>;
            })}
            {activeDraftOutlines.map((outline) => <div className="map-outline-item draft" key={outline.id}><Pencil size={13} style={{ color: outline.layer === "occlusion" ? layerColors.occlusion : outline.layer === "rigid" ? layerColors.rigid : layerColors.collision }} /><span><strong>{outline.layer === "occlusion" ? "遮挡草稿" : outline.layer === "rigid" ? "程序刚体草稿" : "碰撞草稿"}</strong><small>{outline.points.length} 点 · 未闭合</small></span><button type="button" title="删除草稿" onClick={() => deleteDraftOutline(outline.id)}><X size={13} /></button></div>)}
          </div>
        </section>
        {!editingAsset && <section className="inspector-section map-outline-section">
          <div className="section-heading"><div><strong>元素物质</strong><span>{(project.matterStrokes || []).length} 条画笔</span></div></div>
          <div className="map-outline-list">
            {!(project.matterStrokes || []).length && <div className="list-empty">暂无液体或气体画笔</div>}
            {(project.matterStrokes || []).map((stroke) => <div className={`map-outline-item${selectedMatterStrokeId === stroke.id ? " selected" : ""}`} key={stroke.id} onClick={() => selectCanvasTarget("matter", stroke.id)}><CircleDot size={13} style={{ color: stroke.profile.visual.baseColor }} /><span><strong>{stroke.elementTag || "未命名"} · {stroke.carrier === "gas" ? "气体" : "液体"}</strong><small>{stroke.points.length} 点 · 半径 {Math.round(stroke.radius)}px · 密度 {stroke.profile.physical.density}</small></span><button type="button" title="删除画笔" onClick={(event) => { event.stopPropagation(); deleteMatterStroke(stroke.id); }}><X size={13} /></button></div>)}
          </div>
        </section>}
      </aside>
    </div>

    <footer className="status-bar"><div className="status-primary"><span>{status}</span><span className={`unity-binding-status${boundMapUnityProjectPath ? " bound" : ""}`}>{boundMapUnityProjectPath ? `地图 Unity · ${projectName(boundMapUnityProjectPath)}` : "地图 Unity · 未绑定"}</span></div><span>{project.mapName} · {project.objects.length} 个物体</span></footer>

    {replacementAsset && <div className="modal-backdrop" role="presentation"><div className="modal background-replace-modal" role="dialog" aria-modal="true" aria-label="替换背景地图">
      <div className="modal-heading"><div><strong>替换背景地图</strong><span>{replacementAsset.name}</span></div><button type="button" className="icon-button" title="取消" onClick={() => setPendingBackgroundReplacement(null)}><X size={16} /></button></div>
      <div className="background-replace-summary">
        <div><span>原尺寸</span><strong>{project.width}×{project.height}</strong></div>
        <div><span>新尺寸</span><strong>{replacementAsset.width}×{replacementAsset.height}</strong></div>
        <div><span>坐标倍率</span><strong>X {formatScale(replacementScaleX)} · Y {formatScale(replacementScaleY)}</strong></div>
        <div><span>PPU</span><strong>{formatScale(project.pixelsPerUnit)} → {formatScale(replacementPpu)}</strong></div>
      </div>
      <div className="modal-actions">
        <button type="button" onClick={() => setPendingBackgroundReplacement(null)}>取消</button>
        <button type="button" onClick={() => applyBackgroundReplacement(replacementAsset, false)}>仅替换图片</button>
        <button type="button" className="primary-button" onClick={() => applyBackgroundReplacement(replacementAsset, true)}>缩放地图数据</button>
      </div>
    </div></div>}

    {connection && <div className="modal-backdrop" role="presentation"><div className="modal map-sync-modal" role="dialog" aria-modal="true" aria-label="地图项目连接">
      <div className="modal-heading"><div><strong>{boundMapUnityProjectPath ? "地图项目连接" : "绑定地图项目"}</strong><span>只管理地图数据、资源和目标 Prefab</span></div><button type="button" className="icon-button" title="关闭" onClick={() => { setPendingMapOverwrite(null); setConnection(null); }}><X size={16} /></button></div>
      {showingBoundMapProject ? <div className="bound-project-card"><FolderSync size={20} /><div><strong>{projectName(boundMapUnityProjectPath)}</strong><span>{boundMapUnityProjectPath}</span></div></div> : <label className="field"><span>Unity 项目根目录</span><DeferredTextInput value={connection.path} placeholder="例如 D:\\UnityProjects\\MyGame" disabled={connection.phase === "checking" || connection.phase === "syncing"} onValueChange={(value) => setConnection({ ...connection, path: value, phase: "path" })} /></label>}
      <div className={`sync-message ${connection.phase}`}><strong>{connection.phase === "missing" ? "需要安装 Runtime" : connection.phase === "incompatible" ? "Runtime 不兼容" : connection.phase === "overwrite" ? "确认覆盖同名地图" : connection.phase === "done" ? "操作完成" : connection.phase === "error" ? "操作失败" : showingBoundMapProject ? "已绑定项目" : "项目连接"}</strong><span>{connection.message}</span>{connection.runtimeVersion && <small>Runtime {connection.runtimeVersion}</small>}</div>
      {(connection.phase === "missing" || connection.phase === "incompatible") && <div className="runtime-summary"><span>包名：com.frame-action.runtime</span><code className="runtime-package-url">{UNITY_RUNTIME_GIT_URL}</code><span>SpriteCue 只检查 Schema，不会安装或覆盖 Runtime</span></div>}
      {showingBoundMapProject && <>
        <div className="unity-character-loader">
          <div className="section-heading"><div><strong>打开已同步地图</strong><span>{unityMaps.length} 个</span></div><button type="button" className="create-enemy-button" onClick={createNewMap}><Plus size={14} />创建新地图</button></div>
          {unityMaps.length ? <div className="unity-character-loader-row has-delete"><select aria-label="Unity 已同步地图" value={selectedUnityMapPath} onChange={(event) => { setSelectedUnityMapPath(event.target.value); setPendingUnityMapDeletion(null); }}>{unityMaps.map((item) => <option key={item.jsonPath} value={item.jsonPath}>{item.mapName}{item.legacy ? " · 旧工具" : ""}</option>)}</select><button type="button" onClick={() => void loadUnityMap()}><FolderOpen size={15} />打开地图</button><button type="button" className="icon-button danger" title="从 Unity 项目删除选中的地图" disabled={!selectedUnityMapPath || deletingUnityMap || unityMaps.find((item) => item.jsonPath === selectedUnityMapPath)?.managed === false} onClick={() => setPendingUnityMapDeletion(unityMaps.find((item) => item.jsonPath === selectedUnityMapPath) || null)}><Trash2 size={15} /></button></div> : <span className="unity-character-loader-empty">项目中还没有可打开的地图同步数据</span>}
          {orphanMapPrefabs.length > 0 && <div className="map-orphan-prefab-note"><TriangleAlert size={15} /><span>检测到 {orphanMapPrefabs.length} 个缺少可编辑源数据的地图 Prefab，无法直接打开：{orphanMapPrefabs.map((item) => item.mapName).join("、")}。创建同名地图并同步时会先提示覆盖。</span></div>}
          {pendingUnityMapDeletion && <div className="unity-delete-confirmation"><TriangleAlert size={18} /><div><strong>确认从 Unity 删除地图“{pendingUnityMapDeletion.mapName}”？</strong><span>将删除该地图的同步源数据、归档背景、物体图片和生成资源。</span><small>{pendingUnityMapDeletion.sharedPrefab ? `该 Prefab 还被其他已同步地图引用，将保留：${pendingUnityMapDeletion.prefabPath}` : pendingUnityMapDeletion.generatedPrefab ? `自动生成 Prefab 也会删除：${pendingUnityMapDeletion.prefabPath}` : `项目原有 Prefab 会保留：${pendingUnityMapDeletion.prefabPath || "未绑定 Prefab"}。其中已写入的组件不会自动还原。`}</small><small>工具内的本地草稿会保留，之后重新同步会再次创建该地图。</small><div className="unity-delete-confirmation-actions"><button type="button" disabled={deletingUnityMap} onClick={() => setPendingUnityMapDeletion(null)}>取消</button><button type="button" className="danger-button" disabled={deletingUnityMap} onClick={() => void deleteMapFromUnity()}>{deletingUnityMap ? "删除中..." : "确认删除"}</button></div></div></div>}
        </div>
      </>}
      <div className="modal-actions">
        {boundMapUnityProjectPath && connection.phase !== "checking" && connection.phase !== "syncing" && <div className="sync-management-actions"><button type="button" onClick={changeMapUnityProject}><FolderOpen size={14} />更换项目</button><button type="button" className="danger-text" onClick={unbindMapUnityProject}><Unlink size={14} />解除绑定</button></div>}
        {connection.phase !== "overwrite" && <button type="button" onClick={() => { setPendingMapOverwrite(null); setConnection(null); }}>关闭</button>}
        {connection.phase === "overwrite" ? <><button type="button" onClick={() => { setPendingMapOverwrite(null); setConnection({ ...connection, phase: "ready", message: "已取消覆盖，当前页面数据没有写入 Unity。" }); }}>取消覆盖</button><button type="button" className="primary-button" onClick={() => void syncMap(true)}>覆盖并同步</button></> : connection.phase === "missing" || connection.phase === "incompatible" ? <button type="button" className="primary-button" onClick={() => void checkConnection()}>重新检查</button> : connection.phase !== "done" ? <button type="button" className="primary-button" disabled={!connection.path.trim() || connection.phase === "checking" || connection.phase === "syncing" || (showingBoundMapProject && !backgroundAsset)} onClick={() => showingBoundMapProject ? void syncMap() : void checkConnection()}>{connection.phase === "checking" || connection.phase === "syncing" ? "处理中..." : showingBoundMapProject ? "立即同步" : "检查并绑定"}</button> : null}
      </div>
    </div></div>}
  </div>;
}
