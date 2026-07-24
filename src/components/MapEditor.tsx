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
  Trash2,
  TriangleAlert,
  Unlink,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DeferredTextInput from "./DeferredTextInput";
import NumericInput from "./NumericInput";
import { loadMapDraft, saveMapDraft } from "../mapDraftStore";
import { readDocumentOrigin, rememberLocalDocument, rememberUnityDocument } from "../workspaceSession";
import { createGroundLinePoints, finishBrushDrawing, pointDistance } from "../mapGeometry";
import { createMapProject, type MapAssetRef, type MapLayer, type MapMode, type MapObjectData, type MapObjectMotionData, type MapOutlineData, type MapPoint, type MapProject, type OutlinePrecision } from "../mapTypes";
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
  phase: "path" | "checking" | "missing" | "outdated" | "ready" | "overwrite" | "syncing" | "done" | "error";
  message: string;
  runtimeVersion?: string;
}

interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

interface PointerOperation {
  type: "pan" | "drag" | "draw";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPanX?: number;
  startPanY?: number;
  objectId?: string;
  offsetX?: number;
  offsetY?: number;
  historyRecorded?: boolean;
}

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

const layerLabels: Record<MapLayer, string> = { decoration: "装饰层", collision: "地面/碰撞层", occlusion: "遮挡层" };
const layerColors: Record<MapLayer, string> = { decoration: "#168178", collision: "#d15343", occlusion: "#4767ad" };
const rectangleCollisionColors = {
  "solid-sides": { stroke: "#d15343", fill: "rgba(209,83,67,.18)" },
  "solid-open": { stroke: "#cc8618", fill: "rgba(204,134,24,.18)" },
  "oneWay-sides": { stroke: "#21965a", fill: "rgba(33,150,90,.18)" },
  "oneWay-open": { stroke: "#3478c7", fill: "rgba(52,120,199,.18)" },
} as const;
const HORIZONTAL_SNAP_SCREEN_PX = 10;
const MAP_ASSET_BASE64_CHUNK_SIZE = 8 * 1024 * 1024;
const precisionLabels: Record<OutlinePrecision, string> = { low: "低", medium: "中", high: "高", ultra: "极高" };

function normalizeMapOutline(outline: MapOutlineData): MapOutlineData {
  const legacyLineRoad = String(outline.shape) === "lineRoad" || String(outline.shape) === "oneWayLine";
  const rectangleCollision = legacyLineRoad || String(outline.shape) === "groundLine";
  const thickness = rectangleCollision ? Math.max(1, Number(outline.thickness) || 1) : Math.max(0, Number(outline.thickness) || 0);
  const sourcePoints = Array.isArray(outline.points) ? outline.points : [];
  const start = sourcePoints[0];
  const end = sourcePoints[sourcePoints.length - 1];
  return {
    ...outline,
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
    outlines: (asset.outlines || []).map(normalizeMapOutline),
    draftOutlines: (asset.draftOutlines || []).map(normalizeMapOutline),
  };
}

function normalizeMapObject(object: MapObjectData): MapObjectData {
  const motion = object.motion || {} as MapObjectMotionData;
  return {
    ...object,
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
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    usage: asset.usage,
    defaultLayer: asset.defaultLayer,
    width: asset.width,
    height: asset.height,
    outlines: asset.outlines || [],
    draftOutlines: asset.draftOutlines || [],
    byteSize,
  };
}

function scaleProjectForBackground(project: MapProject, asset: MapAssetRef): MapProject {
  const scaleX = asset.width / Math.max(1, project.width);
  const scaleY = asset.height / Math.max(1, project.height);
  const scaleOutline = (outline: MapOutlineData): MapOutlineData => ({
    ...outline,
    thickness: outline.shape === "groundLine" ? Math.max(1, outline.thickness * scaleY) : outline.thickness * scaleY,
    points: outline.points.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY })),
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
  };
}

function formatScale(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : "1";
}

export default function MapEditor({ onSwitchToCharacter, onSwitchToEnemy }: MapEditorProps) {
  const [project, setProject] = useState<MapProject>(() => createMapProject());
  const [assets, setAssets] = useState<Record<string, MapAssetRef>>({});
  const [selectedObjectId, setSelectedObjectId] = useState("");
  const [editingAssetId, setEditingAssetId] = useState("");
  const [mode, setMode] = useState<MapMode>("select");
  const [activeLayer, setActiveLayer] = useState<MapLayer>("decoration");
  const [groundThickness, setGroundThickness] = useState(18);
  const [groundCollisionType, setGroundCollisionType] = useState<"solid" | "oneWay">("solid");
  const [groundSideCollision, setGroundSideCollision] = useState(true);
  const [autoHorizontalSnap, setAutoHorizontalSnap] = useState(false);
  const [drawing, setDrawing] = useState<MapOutlineData | null>(null);
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

  const applySnapshot = useCallback((snapshot: MapSnapshot) => {
    projectRef.current = snapshot.project;
    assetsRef.current = snapshot.assets;
    setProject(snapshot.project);
    setAssets(snapshot.assets);
    setSelectedObjectId("");
    setDrawing(null);
    setDropPreview(null);
  }, []);

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
    const restoredAssets = Object.fromEntries(Object.entries(nextAssets).map(([id, asset]) => [id, normalizeMapAsset(asset)])) as Record<string, MapAssetRef>;
    const restoredProject = {
      ...createMapProject(),
      ...nextProject,
      version: 2 as const,
      objects: (nextProject.objects || []).map(normalizeMapObject),
      outlines: (nextProject.outlines || []).map(normalizeMapOutline),
      draftOutlines: (nextProject.draftOutlines || []).map(normalizeMapOutline),
    };
    projectRef.current = restoredProject;
    assetsRef.current = restoredAssets;
    setProject(restoredProject);
    setAssets(restoredAssets);
    historyRef.current = { past: [], future: [] };
    setHistoryRevision((value) => value + 1);
    setSelectedObjectId("");
    setEditingAssetId("");
    setStatus(message);
  }, []);

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
      context.globalAlpha = object.layer === "collision" ? 0.65 : object.layer === "occlusion" ? 0.8 : 1;
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
    const drawOutline = (outline: MapOutlineData, draft: boolean) => {
      if (outline.points.length < 2) return;
      context.save();
      const rectangleStyle = outline.shape === "groundLine" ? rectangleCollisionStyle(outline.collisionType, outline.sideCollision !== false) : null;
      context.strokeStyle = outline.layer === "occlusion" ? layerColors.occlusion : rectangleStyle?.stroke || layerColors.collision;
      context.fillStyle = outline.layer === "occlusion" ? "rgba(71,103,173,.15)" : rectangleStyle?.fill || "rgba(209,83,67,.18)";
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
    if (drawing) drawOutline(drawing, true);
    context.strokeStyle = "#5e6662";
    context.lineWidth = 1 / view.zoom;
    context.setLineDash([]);
    context.strokeRect(0, 0, documentWidth, documentHeight);
    context.restore();
  }, [activeDraftOutlines, activeOutlines, assets, backgroundAsset, canvasSize, documentHeight, documentWidth, drawing, dropPreview, editingAsset, getImage, imageRevision, project, selectedObjectId, view]);

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

  const addObject = (asset: MapAssetRef, point: MapPoint) => {
    recordHistory();
    const scale = defaultObjectScale(asset, projectRef.current);
    const object: MapObjectData = {
      id: uid("map_object"),
      assetId: asset.id,
      layer: asset.defaultLayer,
      mode: "static",
      collisionType: "oneWay",
      motion: { direction: "horizontal", speedMetersPerSecond: 2, rangeMeters: 10, initialProgress: 0, pingPong: true, endpointPauseSeconds: 0, phaseSeconds: 0 },
      x: Math.round(point.x - asset.width * scale / 2),
      y: Math.round(point.y - asset.height * scale / 2),
      scale,
      rotation: 0,
      z: 0,
      outlinePrecision: asset.defaultLayer === "occlusion" ? "high" : "medium",
    };
    updateProject((current) => ({ ...current, objects: [...current.objects, object] }));
    setSelectedObjectId(object.id);
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
    if (mode === "groundLine" || mode === "collision" || mode === "occlusion") {
      if (!isPointInsideMap(rawPoint)) return;
      const outline: MapOutlineData = {
        id: uid("map_outline"),
        layer: mode === "occlusion" ? "occlusion" : "collision",
        shape: mode === "groundLine" ? "groundLine" : "polygon",
        collisionType: mode === "occlusion" ? "trigger" : mode === "collision" ? "solid" : groundCollisionType,
        sideCollision: mode === "groundLine" ? groundSideCollision : true,
        thickness: mode === "groundLine" ? groundThickness : 0,
        closed: false,
        points: mode === "groundLine" ? createGroundLinePoints(point, point, groundThickness) : [point],
      };
      drawingRef.current = outline;
      setDrawing(outline);
      pointerRef.current = { type: "draw", pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const object = hitObject(point);
    setSelectedObjectId(object?.id || "");
    if (object) {
      pointerRef.current = { type: "drag", pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY, objectId: object.id, offsetX: point.x - object.x, offsetY: point.y - object.y };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
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
    const finishedDrawing = drawingRef.current;
    if (operation.type !== "draw" || !finishedDrawing) return;
    const outlineSource = editingAssetId ? assetsRef.current[editingAssetId] : projectRef.current;
    const currentOutlines = outlineSource?.outlines || [];
    const currentDraftOutlines = outlineSource?.draftOutlines || [];
    if (finishedDrawing.shape === "groundLine") {
      if (pointDistance(finishedDrawing.points[0], finishedDrawing.points[1]) > 3 / view.zoom) {
        recordHistory();
        updateActiveOutlineCollections((outlines, draftOutlines) => ({ outlines: [...outlines, { ...finishedDrawing, closed: true }], draftOutlines }));
      }
    } else if (finishedDrawing.points.length >= 2) {
      const result = finishBrushDrawing(finishedDrawing, currentDraftOutlines);
      if (result.outline || result.draftOutlines !== currentDraftOutlines) {
        recordHistory();
        updateActiveOutlineCollections(() => ({
          outlines: result.outline ? [...currentOutlines, result.outline] : currentOutlines,
          draftOutlines: result.draftOutlines,
        }));
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
    downloadJson({
      format: "frame-action-map-bundle",
      version: 2,
      project,
      assets: Object.fromEntries(Object.entries(assets).map(([id, asset]) => [id, { ...asset, url: asset.dataUrl || asset.url }])),
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

  const removeSelectedObject = () => {
    if (!selectedObjectId) return;
    recordHistory();
    updateProject((current) => ({ ...current, objects: current.objects.filter((object) => object.id !== selectedObjectId) }));
    setSelectedObjectId("");
    setStatus("已删除物体 · 有未同步修改");
  };

  const patchAssetLayer = (assetId: string, layer: MapLayer) => {
    const asset = assetsRef.current[assetId];
    if (!asset || asset.defaultLayer === layer) return;
    recordHistory();
    updateAssets((current) => ({ ...current, [assetId]: { ...current[assetId], defaultLayer: layer } }));
    setStatus("已修改物体默认图层 · 有未同步修改");
  };

  const openAssetOutlineEditor = (assetId: string) => {
    const asset = assetsRef.current[assetId];
    if (!asset) return;
    drawingRef.current = null;
    setDrawing(null);
    setDropPreview(null);
    setSelectedObjectId("");
    setEditingAssetId(assetId);
    setMode("collision");
    setStatus(`正在编辑物体轮廓模板 · ${asset.name}`);
  };

  const closeAssetOutlineEditor = () => {
    drawingRef.current = null;
    setDrawing(null);
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
    setStatus(editingAsset ? "已清空物体模板全部轮廓" : "已清空全部地图轮廓 · 有未同步修改");
  };

  const deleteOutline = (outlineId: string) => {
    recordHistory();
    updateActiveOutlineCollections((outlines, draftOutlines) => ({ outlines: outlines.filter((outline) => outline.id !== outlineId), draftOutlines }));
    setStatus(editingAsset ? "已删除物体模板轮廓" : "已删除地图轮廓 · 有未同步修改");
  };

  const deleteDraftOutline = (outlineId: string) => {
    recordHistory();
    updateActiveOutlineCollections((outlines, draftOutlines) => ({ outlines, draftOutlines: draftOutlines.filter((outline) => outline.id !== outlineId) }));
    setStatus(editingAsset ? "已删除物体模板轮廓草稿" : "已删除地图轮廓草稿 · 有未同步修改");
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
      if ((event.key === "Delete" || event.key === "Backspace") && !editing && selectedObjectId) {
        event.preventDefault();
        removeSelectedObject();
      }
      if (event.key === "Escape") {
        drawingRef.current = null;
        setDrawing(null);
        setDropPreview(null);
        setIsPanning(false);
        pointerRef.current = null;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [redoMap, selectedObjectId, undoMap]);

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
      if (!result.runtime.installed) { setConnection({ path, phase: "missing", message: "该项目尚未安装 Frame Action Runtime。" }); return; }
      if (result.runtime.needsUpdate) { setConnection({ path, phase: "outdated", message: `Runtime ${result.runtime.version} 可单独更新到 ${result.runtime.latestVersion}，地图数据也可以继续使用当前版本同步。`, runtimeVersion: result.runtime.version }); return; }
      await listUnityContent(path);
      setBoundMapUnityProjectPath(path);
      localStorage.setItem("frameAction.mapUnityProjectPath", path);
      setConnection({ path, phase: "ready", message: "项目已连接，可以绑定地图 Prefab。", runtimeVersion: result.runtime.version });
    } catch (error) {
      setConnection({ path, phase: "error", message: error instanceof Error ? error.message : "Unity 项目检查失败" });
    }
  };

  const installRuntime = async () => {
    if (!connection) return;
    setConnection({ ...connection, phase: "checking", message: "正在为当前地图项目安装 Frame Action Runtime..." });
    try {
      const response = await fetch("/api/unity/install-runtime", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectPath: connection.path }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Runtime 安装失败");
      await listUnityContent(connection.path);
      setBoundMapUnityProjectPath(connection.path);
      localStorage.setItem("frameAction.mapUnityProjectPath", connection.path);
      setConnection({ ...connection, phase: "ready", message: "Runtime 已安装，可以绑定地图 Prefab。", runtimeVersion: result.runtime.version });
    } catch (error) {
      setConnection({ ...connection, phase: "error", message: error instanceof Error ? error.message : "Runtime 安装失败" });
    }
  };

  const continueWithCurrentRuntime = async () => {
    if (!connection) return;
    try {
      await listUnityContent(connection.path);
      setBoundMapUnityProjectPath(connection.path);
      localStorage.setItem("frameAction.mapUnityProjectPath", connection.path);
      setConnection({ ...connection, phase: "ready", message: `继续使用 Runtime ${connection.runtimeVersion || "当前版本"}，可以同步地图数据。` });
    } catch (error) {
      setConnection({ ...connection, phase: "error", message: error instanceof Error ? error.message : "Unity 项目连接失败" });
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
      if (startResult.code === "runtime_missing" || startResult.code === "runtime_outdated") {
        setConnection({ path, phase: startResult.code === "runtime_missing" ? "missing" : "outdated", message: startResult.message });
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
      const referencedIds = new Set([project.backgroundAssetId, ...project.objects.map((item) => item.assetId)].filter(Boolean));
      const referencedAssets = Object.values(assets).filter((asset) => referencedIds.has(asset.id));
      for (let index = 0; index < referencedAssets.length; index += 1) {
        await uploadMapAsset(path, referencedAssets[index], index, referencedAssets.length, overwriteTarget);
      }
      setStatus("正在写入地图结构和 Prefab...");
      const response = await fetch("/api/unity/sync-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: path,
          project,
          assets: referencedAssets.map(mapAssetMetadata),
          targetJsonPath: editingUnityMapPath,
          overwriteJsonPath: overwriteTarget?.jsonPath || "",
          overwritePrefabPath: overwriteTarget?.prefabPath || "",
          confirmOverwrite,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (result.code === "runtime_missing" || result.code === "runtime_outdated") {
          setConnection({ path, phase: result.code === "runtime_missing" ? "missing" : "outdated", message: result.message });
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
              onDragStart={(event) => startAssetDrag(event, asset)}
              onDragEnd={stopAssetDrag}
            >
              <GripVertical className="map-asset-grip" size={14} />
              <img src={asset.url} alt="" draggable={false} />
              <span><strong>{asset.name}</strong><small>{asset.width}×{asset.height}{asset.outlines?.length ? ` · ${asset.outlines.length} 条自定义轮廓` : ""}</small><select aria-label={`${asset.name} 默认图层`} value={asset.defaultLayer} onClick={(event) => event.stopPropagation()} onChange={(event) => patchAssetLayer(asset.id, event.target.value as MapLayer)}>{Object.entries(layerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></span>
              <button type="button" className="map-asset-draw-button" title={`在独立画布绘制 ${asset.name} 的碰撞或遮挡轮廓`} onClick={(event) => { event.stopPropagation(); openAssetOutlineEditor(asset.id); }}><Pencil size={12} /><span>绘制</span></button>
            </div>)}
          </div>
        </section>
      </aside>

      <main className="map-workspace">
        <div className="map-toolbar">
          <div className="map-toolbar-main">
            {editingAsset && <button type="button" className="map-return-button" title="保存当前模板数据并返回地图画布" onClick={closeAssetOutlineEditor}><ChevronLeft size={14} /><span>返回地图</span></button>}
            <div className="map-mode-control">{modes.filter((item) => !editingAsset || item.value !== "select").map((item) => <button type="button" key={item.value} className={mode === item.value ? "active" : ""} title={item.label} onClick={() => setMode(item.value)}>{item.icon}<span>{item.label}</span></button>)}</div>
          </div>
          <div className="map-tool-options">
            {mode === "groundLine" && <>
              <span className="map-collision-swatch" title={rectangleCollisionLabel(groundCollisionType, groundSideCollision)} style={{ backgroundColor: rectangleCollisionStyle(groundCollisionType, groundSideCollision).stroke }} />
              <label><span>方向</span><select value={groundCollisionType} onChange={(event) => setGroundCollisionType(event.target.value as "solid" | "oneWay")}><option value="solid">双向</option><option value="oneWay">单向</option></select></label>
              <label className="map-snap-option"><input type="checkbox" checked={groundSideCollision} onChange={(event) => setGroundSideCollision(event.target.checked)} /><span>侧面碰撞</span></label>
              <label><span>厚度</span><NumericInput value={groundThickness} min={1} max={256} integer onValueChange={(value) => setGroundThickness(Math.max(1, Math.min(256, value)))} /></label>
              <label className="map-snap-option" title="开启后，终点接近起点水平线时自动对齐"><input type="checkbox" checked={autoHorizontalSnap} onChange={(event) => setAutoHorizontalSnap(event.target.checked)} /><span>自动水平吸附</span></label>
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
        </div>
        <div className="map-canvas-status"><span>{modes.find((item) => item.value === mode)?.label} · {documentWidth}×{documentHeight} · {Math.round(view.zoom * 100)}%</span><span>{editingAsset ? `${editingAsset.name} · ${activeOutlines.length} 条模板轮廓${activeDraftOutlines.length ? ` · ${activeDraftOutlines.length} 条草稿` : ""}` : `${project.objects.length} 个物体 · ${project.outlines.length} 条地图轮廓${project.draftOutlines.length ? ` · ${project.draftOutlines.length} 条草稿` : ""}`}</span></div>
      </main>

      <aside className="map-inspector">
        <section className="inspector-section map-object-inspector">
          <div className="section-heading"><div><strong>{editingAsset ? "物体轮廓模板" : "物体属性"}</strong><span>{editingAsset ? "素材级" : selectedObject ? `${project.objects.findIndex((item) => item.id === selectedObject.id) + 1}/${project.objects.length}` : "未选择"}</span></div>{!editingAsset && selectedObject && <button type="button" className="icon-button small danger" title="删除物体 Delete" onClick={removeSelectedObject}><Trash2 size={14} /></button>}</div>
          {editingAsset ? <>
            <div className="map-selected-preview"><img src={editingAsset.url} alt="" /><div><strong>{editingAsset.name}</strong><span>{editingAsset.width}×{editingAsset.height}</span></div></div>
            <div className="map-asset-template-help">在中间画布直接绘制。碰撞轮廓会进入 Unity 的地面碰撞层，遮挡轮廓会进入遮挡层；地图中所有使用这张素材的物体都会继承模板，并随实例缩放、旋转和移动。</div>
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
            <label className="field"><span>透明轮廓精度</span><select value={selectedObject.outlinePrecision} onChange={(event) => patchSelectedObject({ outlinePrecision: event.target.value as OutlinePrecision })}>{Object.entries(precisionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </> : <div className="inspector-empty"><MousePointer2 size={24} /><strong>未选择物体</strong></div>}
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
            {activeOutlines.map((outline) => { const style = outline.shape === "groundLine" ? rectangleCollisionStyle(outline.collisionType, outline.sideCollision !== false) : null; return <div className="map-outline-item" key={outline.id}><CircleDot size={13} style={{ color: outline.layer === "occlusion" ? layerColors.occlusion : style?.stroke || layerColors.collision }} /><span><strong>{outline.layer === "occlusion" ? "遮挡区域" : outline.shape === "groundLine" ? "矩形碰撞" : "实体碰撞"}</strong><small>{outline.shape === "groundLine" ? `${rectangleCollisionLabel(outline.collisionType, outline.sideCollision !== false)} · ${Math.round(outline.thickness)}px` : `${outline.points.length} 点`}</small></span><button type="button" title="删除轮廓" onClick={() => deleteOutline(outline.id)}><X size={13} /></button></div>; })}
            {activeDraftOutlines.map((outline) => <div className="map-outline-item draft" key={outline.id}><Pencil size={13} style={{ color: outline.layer === "occlusion" ? layerColors.occlusion : layerColors.collision }} /><span><strong>{outline.layer === "occlusion" ? "遮挡草稿" : "碰撞草稿"}</strong><small>{outline.points.length} 点 · 未闭合</small></span><button type="button" title="删除草稿" onClick={() => deleteDraftOutline(outline.id)}><X size={13} /></button></div>)}
          </div>
        </section>
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
      <div className={`sync-message ${connection.phase}`}><strong>{connection.phase === "missing" ? "需要安装 Runtime" : connection.phase === "outdated" ? "需要更新 Runtime" : connection.phase === "overwrite" ? "确认覆盖同名地图" : connection.phase === "done" ? "操作完成" : connection.phase === "error" ? "操作失败" : showingBoundMapProject ? "已绑定项目" : "项目连接"}</strong><span>{connection.message}</span>{connection.runtimeVersion && <small>Runtime {connection.runtimeVersion}</small>}</div>
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
        {connection.phase === "overwrite" ? <><button type="button" onClick={() => { setPendingMapOverwrite(null); setConnection({ ...connection, phase: "ready", message: "已取消覆盖，当前页面数据没有写入 Unity。" }); }}>取消覆盖</button><button type="button" className="primary-button" onClick={() => void syncMap(true)}>覆盖并同步</button></> : connection.phase === "missing" ? <button type="button" className="primary-button" onClick={() => void installRuntime()}>安装并继续</button> : connection.phase === "outdated" ? <><button type="button" onClick={() => void continueWithCurrentRuntime()}>使用当前 Runtime</button><button type="button" className="primary-button" onClick={() => void installRuntime()}>更新 Runtime</button></> : connection.phase !== "done" ? <button type="button" className="primary-button" disabled={!connection.path.trim() || connection.phase === "checking" || connection.phase === "syncing" || (showingBoundMapProject && !backgroundAsset)} onClick={() => showingBoundMapProject ? void syncMap() : void checkConnection()}>{connection.phase === "checking" || connection.phase === "syncing" ? "处理中..." : showingBoundMapProject ? "立即同步" : "检查并绑定"}</button> : null}
      </div>
    </div></div>}
  </div>;
}
