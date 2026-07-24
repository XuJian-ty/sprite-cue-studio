import type { AssetRef, CharacterProject } from "./types";

const DATABASE_NAME = "frame-action-studio";
const DATABASE_VERSION = 2;
const ASSET_STORE_NAME = "drafts";
const PROJECT_STORE_NAME = "projects";
type DraftKind = "character" | "enemy";

interface StoredProjectState {
  project: CharacterProject;
  savedAt: number;
}

const persistedAssetSignatures: Partial<Record<DraftKind, string>> = {};

function assetSignature(assets: Record<string, AssetRef>): string {
  return Object.values(assets)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((asset) => {
      const data = asset.dataUrl || asset.url || "";
      return `${asset.id}:${asset.name}:${data.length}:${data.slice(0, 24)}:${data.slice(-24)}`;
    })
    .join("|");
}

export interface StoredProjectDraft {
  project: CharacterProject;
  assets: Record<string, AssetRef>;
  savedAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ASSET_STORE_NAME)) database.createObjectStore(ASSET_STORE_NAME);
      if (!database.objectStoreNames.contains(PROJECT_STORE_NAME)) database.createObjectStore(PROJECT_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地草稿数据库"));
  });
}

export async function loadLastProjectDraft(kind: DraftKind = "character"): Promise<StoredProjectDraft | null> {
  const draftKey = `last-${kind}`;
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction([ASSET_STORE_NAME, PROJECT_STORE_NAME], "readonly");
      const assetRequest = transaction.objectStore(ASSET_STORE_NAME).get(draftKey);
      const projectRequest = transaction.objectStore(PROJECT_STORE_NAME).get(draftKey);
      transaction.oncomplete = () => {
        const bundle = assetRequest.result as StoredProjectDraft | undefined;
        const state = projectRequest.result as StoredProjectState | undefined;
        const project = state?.project || bundle?.project;
        if (!project) {
          resolve(null);
          return;
        }
        const assets = bundle?.assets || {};
        persistedAssetSignatures[kind] = assetSignature(assets);
        resolve({ project, assets, savedAt: Math.max(state?.savedAt || 0, bundle?.savedAt || 0) });
      };
      transaction.onerror = () => reject(transaction.error || new Error("读取本地草稿失败"));
    });
  } finally {
    database.close();
  }
}

export async function saveLastProjectDraft(project: CharacterProject, assets: Record<string, AssetRef>, kind: DraftKind = "character"): Promise<void> {
  const draftKey = `last-${kind}`;
  const database = await openDatabase();
  try {
    const savedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PROJECT_STORE_NAME, "readwrite");
      transaction.objectStore(PROJECT_STORE_NAME).put({ project, savedAt } satisfies StoredProjectState, draftKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("保存本地草稿失败"));
      transaction.onabort = () => reject(transaction.error || new Error("保存本地草稿被中止"));
    });

    const currentSignature = assetSignature(assets);
    if (currentSignature === persistedAssetSignatures[kind]) return;
    const persistedAssets = Object.fromEntries(Object.entries(assets).map(([id, asset]) => [id, { ...asset, url: asset.dataUrl ? "" : asset.url }]));
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(ASSET_STORE_NAME, "readwrite");
      transaction.objectStore(ASSET_STORE_NAME).put({ project, assets: persistedAssets, savedAt } satisfies StoredProjectDraft, draftKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("保存角色资源缓存失败"));
      transaction.onabort = () => reject(transaction.error || new Error("保存角色资源缓存被中止"));
    }).catch((error) => console.warn("[Frame Action] 资源缓存空间不足，角色配置仍已保存", error));
    persistedAssetSignatures[kind] = currentSignature;
  } finally {
    database.close();
  }
}
