import type { MapAssetRef, MapProject } from "./mapTypes";
import { ensureProgramIceAssets, ensureProgramIceProject } from "./mapIceGeometry";

const DATABASE_NAME = "frame-action-map-studio";
const DATABASE_VERSION = 2;
const ASSET_BUNDLE_STORE = "drafts";
const PROJECT_STORE = "projects";
const SNAPSHOT_STORE = "snapshots";
const LAST_DRAFT_KEY = "last-map";
const SNAPSHOT_INTERVAL_MS = 30_000;
const MAX_SNAPSHOTS = 20;

interface StoredAssetBundle {
  project: MapProject;
  assets: Record<string, MapAssetRef>;
  savedAt: number;
}

interface StoredProjectState {
  project: MapProject;
  savedAt: number;
}

interface StoredProjectSnapshot extends StoredProjectState {}

export interface StoredMapDraft {
  project: MapProject;
  assets: Record<string, MapAssetRef>;
  savedAt: number;
}

let persistedAssetSignature = "";
let lastSnapshotSignature = "";
let lastSnapshotAt = 0;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ASSET_BUNDLE_STORE)) database.createObjectStore(ASSET_BUNDLE_STORE);
      if (!database.objectStoreNames.contains(PROJECT_STORE)) database.createObjectStore(PROJECT_STORE);
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) database.createObjectStore(SNAPSHOT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("地图草稿数据库打开失败"));
  });
}

function requestValue<T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("地图草稿读取失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("地图草稿保存失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("地图草稿保存已中止"));
  });
}

function mapKey(project: MapProject): string {
  return `map:${(project.mapName || "未命名地图").trim()}`;
}

function assetSignature(assets: Record<string, MapAssetRef>): string {
  return Object.values(assets)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((asset) => {
      const data = asset.dataUrl || asset.url || "";
      const outlineData = JSON.stringify([asset.outlines || [], asset.draftOutlines || []]);
      return `${asset.id}:${asset.name}:${data.length}:${data.slice(0, 24)}:${data.slice(-24)}:${outlineData}`;
    })
    .join("|");
}

function projectSignature(project: MapProject): string {
  return JSON.stringify(project);
}

function assetsForStorage(assets: Record<string, MapAssetRef>): Record<string, MapAssetRef> {
  return Object.fromEntries(Object.entries(assets).map(([id, asset]) => [id, {
    ...asset,
    url: asset.dataUrl ? "" : asset.url,
  }]));
}

export async function saveMapDraft(project: MapProject, assets: Record<string, MapAssetRef>): Promise<void> {
  const persistentProject = ensureProgramIceProject(project);
  const persistentAssets = ensureProgramIceAssets(assets);
  const database = await openDatabase();
  const now = Date.now();
  const currentAssetSignature = assetSignature(persistentAssets);
  const currentProjectSignature = projectSignature(persistentProject);
  const assetsChanged = currentAssetSignature !== persistedAssetSignature;
  const shouldSnapshot = currentProjectSignature !== lastSnapshotSignature && now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS;
  try {
    const transaction = database.transaction([PROJECT_STORE, SNAPSHOT_STORE], "readwrite");
    const projectState: StoredProjectState = { project: persistentProject, savedAt: now };
    const projects = transaction.objectStore(PROJECT_STORE);
    projects.put(projectState, LAST_DRAFT_KEY);
    projects.put(projectState, mapKey(persistentProject));

    if (shouldSnapshot) {
      const snapshots = transaction.objectStore(SNAPSHOT_STORE);
      const request = snapshots.get(mapKey(persistentProject));
      request.onsuccess = () => {
        const current = Array.isArray(request.result) ? request.result as StoredProjectSnapshot[] : [];
        snapshots.put([...current, projectState].slice(-MAX_SNAPSHOTS), mapKey(persistentProject));
      };
    }

    await transactionDone(transaction);
    if (shouldSnapshot) {
      lastSnapshotSignature = currentProjectSignature;
      lastSnapshotAt = now;
    }

    if (assetsChanged) {
      try {
        const assetTransaction = database.transaction(ASSET_BUNDLE_STORE, "readwrite");
        const bundles = assetTransaction.objectStore(ASSET_BUNDLE_STORE);
        bundles.put({ project: persistentProject, assets: assetsForStorage(persistentAssets), savedAt: now } satisfies StoredAssetBundle, LAST_DRAFT_KEY);
        bundles.delete(mapKey(persistentProject));
        await transactionDone(assetTransaction);
      } catch (error) {
        console.warn("[Frame Action Map] 图片资源缓存空间不足，地图结构仍已保存", error);
      }
      persistedAssetSignature = currentAssetSignature;
    }
  } finally {
    database.close();
  }
}

export async function loadMapDraft(): Promise<StoredMapDraft | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([ASSET_BUNDLE_STORE, PROJECT_STORE], "readonly");
    const [bundle, projectState] = await Promise.all([
      requestValue<StoredAssetBundle>(transaction.objectStore(ASSET_BUNDLE_STORE), LAST_DRAFT_KEY),
      requestValue<StoredProjectState>(transaction.objectStore(PROJECT_STORE), LAST_DRAFT_KEY),
    ]);
    await transactionDone(transaction);
    const storedProject = projectState?.project || bundle?.project;
    if (!storedProject) return null;
    const project = ensureProgramIceProject(storedProject);
    const savedAt = Math.max(bundle?.savedAt || 0, projectState?.savedAt || 0);
    const assets = ensureProgramIceAssets(bundle?.assets || {});
    persistedAssetSignature = assetSignature(assets);
    lastSnapshotSignature = projectSignature(project);
    lastSnapshotAt = savedAt;
    return { project, assets, savedAt };
  } finally {
    database.close();
  }
}
