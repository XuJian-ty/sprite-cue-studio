const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { pathToFileURL } = require("url");
const sharp = require("sharp");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");
const PROJECT_SCHEMA_VERSION = 12;
const RUNTIME_PACKAGE_NAME = "com.frame-action.runtime";
const PORT = Number(process.env.PORT || 5188);
const JSON_BODY_LIMIT = 150 * 1024 * 1024;
const MAP_ASSET_CHUNK_LIMIT = 8 * 1024 * 1024;
const ACTOR_ASSET_CHUNK_LIMIT = 8 * 1024 * 1024;
const MAP_BACKGROUND_TILE_SIZE = 4096;
const mapAssetUploads = new Map();
const actorSyncUploads = new Map();
const actorAssetManifestCache = new Map();
let mapIceGeometry = null;

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function requestTooLarge(message) {
  const error = new Error(message);
  error.statusCode = 413;
  return error;
}

function readRawBody(req, limit, message) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) {
        reject(requestTooLarge(message));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function readBody(req) {
  return readRawBody(req, JSON_BODY_LIMIT, "同步数据超过 150MB 限制，请刷新工具后使用分块资源同步").then((buffer) => {
    try {
      return buffer.length ? JSON.parse(buffer.toString("utf8")) : {};
    } catch (error) {
      throw new Error("请求 JSON 无法解析");
    }
  });
}

function validateUnityProject(projectPath) {
  const root = path.resolve(String(projectPath || ""));
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("Unity 项目目录不存在");
  }
  for (const folder of ["Assets", "Packages", "ProjectSettings"]) {
    if (!fs.existsSync(path.join(root, folder))) throw new Error(`所选目录缺少 ${folder}，不是有效的 Unity 项目`);
  }
  return root;
}

function findRuntimeManifest(root) {
  const candidates = [path.join(root, "Packages", RUNTIME_PACKAGE_NAME, "package.json")];
  const projectManifestPath = path.join(root, "Packages", "manifest.json");
  if (fs.existsSync(projectManifestPath)) {
    const projectManifest = JSON.parse(fs.readFileSync(projectManifestPath, "utf8"));
    const dependency = projectManifest?.dependencies?.[RUNTIME_PACKAGE_NAME];
    if (typeof dependency === "string" && dependency.startsWith("file:")) {
      const localPath = decodeURIComponent(dependency.slice("file:".length));
      if (path.isAbsolute(localPath)) candidates.push(path.join(localPath, "package.json"));
      else {
        candidates.push(path.resolve(root, localPath, "package.json"));
        candidates.push(path.resolve(root, "Packages", localPath, "package.json"));
      }
    }
  }
  const packageCache = path.join(root, "Library", "PackageCache");
  if (fs.existsSync(packageCache)) {
    for (const entry of fs.readdirSync(packageCache, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === RUNTIME_PACKAGE_NAME || entry.name.startsWith(`${RUNTIME_PACKAGE_NAME}@`))) {
        candidates.push(path.join(packageCache, entry.name, "package.json"));
      }
    }
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function runtimeInfo(root) {
  const fallbackPath = path.join(root, "Packages", RUNTIME_PACKAGE_NAME);
  const manifestPath = findRuntimeManifest(root);
  if (!manifestPath) {
    return {
      installed: false,
      path: fallbackPath,
      version: null,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      schemaMin: null,
      schemaMax: null,
      compatibilityKnown: false,
      compatible: false,
    };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.name !== RUNTIME_PACKAGE_NAME) {
    throw new Error("检测到的 Runtime package.json 名称无效");
  }
  const compatibility = manifest.frameAction && typeof manifest.frameAction === "object" ? manifest.frameAction : {};
  const hasSchemaDeclaration = Object.hasOwn(compatibility, "schemaMin") || Object.hasOwn(compatibility, "schemaMax");
  const schemaMin = Number(compatibility.schemaMin);
  const schemaMax = Number(compatibility.schemaMax);
  const validSchemaRange = Number.isInteger(schemaMin) && Number.isInteger(schemaMax) && schemaMin > 0 && schemaMax >= schemaMin;
  return {
    installed: true,
    path: path.dirname(manifestPath),
    version: manifest.version || "unknown",
    schemaVersion: PROJECT_SCHEMA_VERSION,
    schemaMin: validSchemaRange ? schemaMin : null,
    schemaMax: validSchemaRange ? schemaMax : null,
    compatibilityKnown: validSchemaRange,
    compatible: !hasSchemaDeclaration || (validSchemaRange && PROJECT_SCHEMA_VERSION >= schemaMin && PROJECT_SCHEMA_VERSION <= schemaMax),
  };
}

function runtimeStatus(root) {
  return runtimeInfo(root);
}

function readUnityPropertyCatalog(root) {
  const catalogPath = path.join(root, "Library", "FrameActionStudio", "property-catalog.json");
  if (!fs.existsSync(catalogPath)) {
    return {
      properties: [],
      message: "Unity 尚未生成可修改属性目录。请等待 Unity 编译完成，或重新聚焦 Unity 编辑器。",
    };
  }
  const value = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const properties = (Array.isArray(value?.properties) ? value.properties : [])
    .filter((item) => item && typeof item === "object" && String(item.id || "").trim())
    .map((item) => ({
      id: String(item.id).trim(),
      displayName: String(item.displayName || item.id).trim(),
      category: String(item.category || "其他").trim(),
      allowTemporary: item.allowTemporary !== false,
      allowPermanent: item.allowPermanent !== false,
    }))
    .sort((left, right) => left.category.localeCompare(right.category, "zh-CN") || left.displayName.localeCompare(right.displayName, "zh-CN"));
  return {
    properties,
    message: properties.length ? "" : "Unity 属性目录为空，请在游戏代码中注册可修改属性。",
  };
}

function requireCompatibleRuntime(root) {
  const runtime = runtimeStatus(root);
  if (!runtime.installed) {
    const error = new Error("Unity 项目尚未安装 Frame Action Runtime，请通过 Unity Package Manager 安装后重新检查");
    error.statusCode = 409;
    error.code = "runtime_missing";
    throw error;
  }
  if (!runtime.compatible) {
    const supported = runtime.schemaMin === null || runtime.schemaMax === null
      ? "兼容范围声明无效"
      : `仅支持 Schema ${runtime.schemaMin}-${runtime.schemaMax}`;
    const error = new Error(`Runtime ${runtime.version} ${supported}，当前工具使用 Schema ${PROJECT_SCHEMA_VERSION}`);
    error.statusCode = 409;
    error.code = "runtime_incompatible";
    throw error;
  }
  return runtime;
}

function safeName(value, fallback) {
  const normalized = String(value || "").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\.+$/g, "");
  return normalized || fallback;
}

function characterSlug(value) {
  const ascii = String(value || "character")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || `character-${Buffer.from(String(value || "角色")).toString("hex").slice(0, 10)}`;
}

function mapSlug(value) {
  const source = String(value || "地图").trim();
  const ascii = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stem = ascii.replace(/[_-]/g, "").length >= 3
    ? ascii
    : `map-${Buffer.from(source).toString("hex").slice(0, 12)}`;
  const digest = crypto.createHash("sha256").update(source).digest("hex").slice(0, 10);
  return `${stem}-${digest}`;
}

function writeIfChanged(filePath, data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath);
    if (current.equals(buffer)) return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, filePath);
  return true;
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

function resolveContainedFile(root, relativePath) {
  if (!relativePath) return null;
  const fullPath = path.resolve(root, String(relativePath));
  const relative = path.relative(root, fullPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return fullPath;
}

function decodeDataUrl(value) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(value || ""));
  if (!match) throw new Error("资源数据不是有效的 Data URL");
  return match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
}

function mapAssetLocation(root, mapName, asset, storageSlug = "") {
  if (!asset?.id) throw new Error("地图资源缺少 ID");
  const slug = storageSlug || mapSlug(mapName);
  const dataRoot = path.join(root, "Assets", "FrameActionData", "Maps", slug);
  const folder = asset.usage === "background" ? "Background" : "Objects";
  const fileName = safeName(asset.name, `${safeName(asset.id, "asset")}.png`);
  const relativePath = `${folder}/${fileName}`.replace(/\\/g, "/");
  return { slug, dataRoot, relativePath, targetPath: path.join(dataRoot, folder, fileName) };
}

function existingMapAssetMatches(root, mapName, asset, targetPath, relativePath, expectedBytes, storageSlug = "", relativeJsonPath = "") {
  const slug = storageSlug || mapSlug(mapName);
  const jsonPath = relativeJsonPath
    ? path.resolve(root, relativeJsonPath)
    : path.join(root, "Assets", "FrameActionData", "Maps", slug, `${slug}.frame-action-map.json`);
  if (!fs.existsSync(jsonPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (asset.usage === "background" && data.backgroundSource?.id === asset.id && Number(data.backgroundSource.byteSize) === expectedBytes) {
      const sourcePath = path.resolve(root, String(data.backgroundSource.path || ""));
      const sourceRelative = path.relative(root, sourcePath);
      const dataRoot = path.dirname(jsonPath);
      const entries = new Map((Array.isArray(data.assets) ? data.assets : []).filter((item) => item?.id).map((item) => [item.id, item]));
      const tiles = Array.isArray(data.backgroundTiles) ? data.backgroundTiles : [];
      const sourceValid = sourceRelative && !sourceRelative.startsWith("..") && !path.isAbsolute(sourceRelative)
        && fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile() && fs.statSync(sourcePath).size === expectedBytes;
      const tilesValid = tiles.length > 0 && tiles.every((tile) => {
        const entry = entries.get(tile?.assetId);
        if (!entry?.path) return false;
        const tilePath = path.resolve(dataRoot, entry.path);
        const tileRelative = path.relative(dataRoot, tilePath);
        return tileRelative && !tileRelative.startsWith("..") && !path.isAbsolute(tileRelative) && fs.existsSync(tilePath) && fs.statSync(tilePath).isFile();
      });
      if (sourceValid && tilesValid) return true;
    }
    if (!fs.existsSync(targetPath)) return false;
    const entry = (Array.isArray(data.assets) ? data.assets : []).find((item) => item?.id === asset.id && item.path === relativePath);
    return Boolean(entry) && fs.statSync(targetPath).size === expectedBytes;
  } catch {
    return false;
  }
}

function startMapAssetUpload(root, payload) {
  const asset = payload.asset;
  const expectedBytes = Number(payload.byteSize);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw new Error("地图资源大小无效");
  const targetMap = findUnityMapByJsonPath(root, payload.targetJsonPath || payload.overwriteJsonPath);
  const generatedOverwrite = /^Assets\/FrameActionGenerated\/Maps\/([^/]+)\//i.exec(String(payload.overwritePrefabPath || "").replace(/\\/g, "/"));
  const storageSlug = targetMap ? path.basename(path.dirname(path.resolve(root, targetMap.jsonPath))) : generatedOverwrite?.[1] || "";
  const location = mapAssetLocation(root, payload.mapName, asset, storageSlug);
  if (existingMapAssetMatches(root, payload.mapName, asset, location.targetPath, location.relativePath, expectedBytes, storageSlug, targetMap?.jsonPath || "")) {
    return { required: false, relativePath: location.relativePath };
  }

  for (const [uploadId, session] of mapAssetUploads) {
    if (session.targetPath !== location.targetPath) continue;
    if (fs.existsSync(session.tempPath)) fs.rmSync(session.tempPath, { force: true });
    mapAssetUploads.delete(uploadId);
  }

  fs.mkdirSync(path.dirname(location.targetPath), { recursive: true });
  const uploadId = crypto.randomUUID();
  const tempPath = `${location.targetPath}.upload-${uploadId}.tmp`;
  fs.writeFileSync(tempPath, Buffer.alloc(0));
  mapAssetUploads.set(uploadId, {
    ...location,
    assetId: String(asset.id),
    expectedBytes,
    receivedBytes: 0,
    tempPath,
  });
  return { required: true, uploadId, relativePath: location.relativePath, receivedBytes: 0 };
}

function appendMapAssetUpload(uploadId, offset, chunk) {
  const session = mapAssetUploads.get(uploadId);
  if (!session) throw new Error("地图资源上传会话不存在，请重新同步");
  if (!Number.isSafeInteger(offset) || offset !== session.receivedBytes) {
    const error = new Error(`地图资源分块顺序错误，服务端已接收 ${session.receivedBytes} 字节`);
    error.statusCode = 409;
    throw error;
  }
  if (!chunk.length || session.receivedBytes + chunk.length > session.expectedBytes) throw new Error("地图资源分块大小无效");
  fs.appendFileSync(session.tempPath, chunk);
  session.receivedBytes += chunk.length;
  return { uploadId, receivedBytes: session.receivedBytes, expectedBytes: session.expectedBytes };
}

function finishMapAssetUpload(uploadId) {
  const session = mapAssetUploads.get(uploadId);
  if (!session) throw new Error("地图资源上传会话不存在，请重新同步");
  if (session.receivedBytes !== session.expectedBytes) {
    throw new Error(`地图资源尚未上传完整：${session.receivedBytes}/${session.expectedBytes} 字节`);
  }
  if (fs.existsSync(session.targetPath)) fs.rmSync(session.targetPath, { force: true });
  fs.renameSync(session.tempPath, session.targetPath);
  mapAssetUploads.delete(uploadId);
  return { assetId: session.assetId, relativePath: session.relativePath, byteSize: session.expectedBytes };
}

function removeActorSyncUpload(uploadId) {
  const session = actorSyncUploads.get(uploadId);
  if (!session) return;
  actorSyncUploads.delete(uploadId);
  if (fs.existsSync(session.tempRoot)) fs.rmSync(session.tempRoot, { recursive: true, force: true });
}

function resolveActorSyncLocation(root, project, actorKind, targetJsonPath) {
  const targetActor = findUnityActorByJsonPath(root, targetJsonPath, actorKind);
  const sameNameActor = findUnityActorOverwrite(root, project.characterName, actorKind);
  const overwriteActor = !targetActor ? sameNameActor : null;
  const existingActor = targetActor || overwriteActor;
  let slug = characterSlug(project.characterName);
  if (existingActor) slug = path.basename(path.dirname(existingActor.jsonPath));
  const dataRoot = path.join(root, "Assets", "FrameActionData", actorKind === "enemy" ? "Enemies" : "Characters", slug);
  return {
    targetActor,
    sameNameActor,
    overwriteActor,
    existingActor,
    slug,
    dataRoot,
    jsonPath: path.join(dataRoot, `${slug}.frame-action.json`),
  };
}

function startActorSyncUpload(root, payload) {
  const actorKind = payload.actorKind === "enemy" ? "enemy" : "character";
  const project = migrateCharacterProject(payload.project);
  if (!project || project.format !== "frame-action-project" || project.projectKind !== actorKind) {
    throw new Error(`${actorKind === "enemy" ? "敌人" : "角色"}动作数据格式无效`);
  }
  project.characterName = String(project.characterName || "").trim();
  if (!project.characterName) throw new Error(`${actorKind === "enemy" ? "敌人" : "角色"}名称不能为空`);
  const runtime = requireCompatibleRuntime(root);
  const location = resolveActorSyncLocation(root, project, actorKind, payload.targetJsonPath);
  let previousAssets = [];
  if (fs.existsSync(location.jsonPath)) {
    try {
      previousAssets = JSON.parse(fs.readFileSync(location.jsonPath, "utf8")).assets || [];
    } catch {
      previousAssets = [];
    }
  }
  const previousById = new Map(previousAssets.filter((asset) => asset?.id).map((asset) => [String(asset.id), asset]));
  const sourceAssets = Array.isArray(payload.assets) ? payload.assets : [];
  for (const [existingUploadId, session] of actorSyncUploads) {
    if (session.root === root && session.actorKind === actorKind) removeActorSyncUpload(existingUploadId);
  }
  const uploadId = crypto.randomUUID();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spritecue-actor-sync-"));
  const uploadAssets = new Map();
  const seenAssetIds = new Set();
  const sanitizedAssets = [];
  try {
    for (let index = 0; index < sourceAssets.length; index += 1) {
      const asset = sourceAssets[index];
      const assetId = String(asset?.id || "");
      const expectedBytes = Number(asset?.byteSize);
      const expectedSha256 = String(asset?.sha256 || "").toLowerCase();
      if (!assetId || seenAssetIds.has(assetId)) throw new Error("同步资源 ID 无效或重复");
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw new Error(`资源大小无效：${asset?.name || assetId}`);
      if (!isSha256(expectedSha256)) throw new Error(`资源哈希无效：${asset?.name || assetId}`);
      seenAssetIds.add(assetId);

      let reusedPath = "";
      const previous = previousById.get(assetId);
      const previousPath = resolveContainedFile(location.dataRoot, previous?.path);
      if (previousPath && fs.existsSync(previousPath) && fs.statSync(previousPath).isFile() && fs.statSync(previousPath).size === expectedBytes) {
        const previousSha256 = isSha256(previous?.sha256) && Number(previous?.byteSize) === expectedBytes
          ? String(previous.sha256).toLowerCase()
          : sha256File(previousPath);
        if (previousSha256 === expectedSha256) reusedPath = String(previous.path).replace(/\\/g, "/");
      }

      if (!reusedPath) {
        const tempPath = path.join(tempRoot, `${String(index).padStart(6, "0")}.part`);
        fs.writeFileSync(tempPath, Buffer.alloc(0));
        uploadAssets.set(assetId, {
          expectedBytes,
          expectedSha256,
          receivedBytes: 0,
          tempPath,
          name: String(asset.name || assetId),
        });
      }
      sanitizedAssets.push({
        id: assetId,
        name: asset.name,
        kind: asset.kind,
        usage: asset.usage,
        byteSize: expectedBytes,
        sha256: expectedSha256,
        reusedPath,
      });
    }
    actorSyncUploads.set(uploadId, {
      root,
      actorKind,
      runtime,
      tempRoot,
      assets: uploadAssets,
      payload: {
        project,
        assets: sanitizedAssets,
        confirmOverwrite: payload.confirmOverwrite === true,
        targetJsonPath: String(payload.targetJsonPath || ""),
      },
    });
  } catch (error) {
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    uploadId,
    assetCount: sanitizedAssets.length,
    uploadAssetIds: Array.from(uploadAssets.keys()),
    uploadAssetCount: uploadAssets.size,
    reusedAssetCount: sanitizedAssets.length - uploadAssets.size,
  };
}

function appendActorSyncUpload(uploadId, assetId, offset, chunk) {
  const session = actorSyncUploads.get(uploadId);
  if (!session) throw new Error("角色资源上传会话不存在，请重新同步");
  const asset = session.assets.get(assetId);
  if (!asset) throw new Error("角色资源不属于当前上传会话");
  if (!Number.isSafeInteger(offset) || offset !== asset.receivedBytes) {
    const error = new Error(`角色资源分块顺序错误，服务端已接收 ${asset.receivedBytes} 字节`);
    error.statusCode = 409;
    throw error;
  }
  if (!chunk.length || asset.receivedBytes + chunk.length > asset.expectedBytes) throw new Error("角色资源分块大小无效");
  fs.appendFileSync(asset.tempPath, chunk);
  asset.receivedBytes += chunk.length;
  return { uploadId, assetId, receivedBytes: asset.receivedBytes, expectedBytes: asset.expectedBytes };
}

function finishActorSyncUpload(uploadId) {
  const session = actorSyncUploads.get(uploadId);
  if (!session) throw new Error("角色资源上传会话不存在，请重新同步");
  try {
    for (const asset of session.assets.values()) {
      if (asset.receivedBytes !== asset.expectedBytes) {
        throw new Error(`资源“${asset.name}”尚未上传完整：${asset.receivedBytes}/${asset.expectedBytes} 字节`);
      }
      if (sha256File(asset.tempPath) !== asset.expectedSha256) throw new Error(`资源“${asset.name}”上传内容校验失败，请重新同步`);
    }
    const uploadedAssetPaths = new Map(Array.from(session.assets, ([assetId, asset]) => [assetId, asset.tempPath]));
    const result = syncCharacter(session.root, session.payload, session.actorKind, uploadedAssetPaths);
    return {
      runtime: session.runtime,
      result: {
        ...result,
        uploadedAssetCount: session.assets.size,
        reusedAssetCount: session.payload.assets.length - session.assets.size,
      },
    };
  } finally {
    removeActorSyncUpload(uploadId);
  }
}

function fileMimeType(filePath, kind) {
  const ext = path.extname(filePath).toLowerCase();
  const known = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  };
  return known[ext] || (kind === "audio" ? "audio/mpeg" : "image/png");
}

function encodeFileDataUrl(filePath, kind) {
  return `data:${fileMimeType(filePath, kind)};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function unityCharacterDataRoot(root) {
  return path.join(root, "Assets", "FrameActionData", "Characters");
}

function unityEnemyDataRoot(root) {
  return path.join(root, "Assets", "FrameActionData", "Enemies");
}

function listUnityActors(root, actorKind) {
  const charactersRoot = actorKind === "enemy" ? unityEnemyDataRoot(root) : unityCharacterDataRoot(root);
  if (!fs.existsSync(charactersRoot)) return [];
  const results = [];
  for (const entry of fs.readdirSync(charactersRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(charactersRoot, entry.name);
    const jsonFile = fs.readdirSync(folder).find((name) => name.endsWith(".frame-action.json"));
    if (!jsonFile) continue;
    const jsonPath = path.join(folder, jsonFile);
    try {
      const project = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const projectKind = project.projectKind === "enemy" ? "enemy" : "character";
      if (project.format !== "frame-action-project" || projectKind !== actorKind || !Array.isArray(project.actions)) continue;
      const prefabPath = String(project.unityCharacter?.prefabPath || "").replace(/\\/g, "/");
      const generatedFolder = `Assets/FrameActionGenerated/${actorKind === "enemy" ? "Enemies" : "Characters"}/${entry.name}/`;
      results.push({
        characterName: project.characterName || entry.name,
        jsonPath: path.relative(root, jsonPath).replace(/\\/g, "/"),
        prefabPath,
        generatedPrefab: prefabPath.startsWith(generatedFolder),
        syncedAt: project.sync?.syncedAt || fs.statSync(jsonPath).mtime.toISOString(),
      });
    } catch {
      continue;
    }
  }
  const prefabReferenceCounts = new Map();
  for (const result of results) {
    if (!result.prefabPath) continue;
    prefabReferenceCounts.set(result.prefabPath, (prefabReferenceCounts.get(result.prefabPath) || 0) + 1);
  }
  for (const result of results) result.sharedPrefab = Boolean(result.prefabPath && prefabReferenceCounts.get(result.prefabPath) > 1);
  return results.sort((left, right) => String(right.syncedAt).localeCompare(String(left.syncedAt)));
}

function listUnityCharacters(root) {
  return listUnityActors(root, "character");
}

function listUnityEnemies(root) {
  return listUnityActors(root, "enemy");
}

function findUnityActorOverwrite(root, characterName, actorKind) {
  const normalizedName = String(characterName || "").trim();
  if (!normalizedName) throw new Error(`${actorKind === "enemy" ? "敌人" : "角色"}名称不能为空`);
  return listUnityActors(root, actorKind).find((actor) => actor.characterName === normalizedName) || null;
}

function findUnityEnemyOverwrite(root, characterName) {
  return findUnityActorOverwrite(root, characterName, "enemy");
}

function findUnityCharacterOverwrite(root, characterName) {
  return findUnityActorOverwrite(root, characterName, "character");
}

function findUnityActorByJsonPath(root, relativeJsonPath, actorKind) {
  const normalizedPath = String(relativeJsonPath || "").trim().replace(/\\/g, "/");
  if (!normalizedPath) return null;
  const actor = listUnityActors(root, actorKind).find((item) => item.jsonPath === normalizedPath);
  if (!actor) throw new Error(`要更新的${actorKind === "enemy" ? "敌人" : "角色"}不存在，可能已经被删除；请重新打开同步列表后再试`);
  return actor;
}

function loadUnityActor(root, relativeJsonPath, actorKind) {
  const charactersRoot = path.resolve(actorKind === "enemy" ? unityEnemyDataRoot(root) : unityCharacterDataRoot(root));
  const jsonPath = path.resolve(root, String(relativeJsonPath || ""));
  const relative = path.relative(charactersRoot, jsonPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !jsonPath.endsWith(".frame-action.json")) {
    throw new Error(`${actorKind === "enemy" ? "敌人" : "角色"}数据路径不在对应的 FrameActionData 目录中`);
  }
  if (!fs.existsSync(jsonPath) || !fs.statSync(jsonPath).isFile()) throw new Error("角色数据文件不存在");
  const materialized = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const projectKind = materialized.projectKind === "enemy" ? "enemy" : "character";
  if (materialized.format !== "frame-action-project" || projectKind !== actorKind || !Array.isArray(materialized.actions)) throw new Error(`${actorKind === "enemy" ? "敌人" : "角色"}数据格式无效`);
  const dataRoot = path.dirname(jsonPath);
  const loadedAssets = [];
  for (const asset of Array.isArray(materialized.assets) ? materialized.assets : []) {
    if (!asset?.id || !asset.path) continue;
    const assetPath = path.resolve(dataRoot, asset.path);
    const assetRelative = path.relative(dataRoot, assetPath);
    if (assetRelative.startsWith("..") || path.isAbsolute(assetRelative) || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) continue;
    const params = new URLSearchParams({
      projectPath: root,
      jsonPath: path.relative(root, jsonPath).replace(/\\/g, "/"),
      assetId: String(asset.id),
    });
    loadedAssets.push({ ...asset, url: `/api/unity/actor-asset?${params}` });
  }
  const { assets, sync, ...project } = materialized;
  return { project, assets: loadedAssets, syncedAt: sync?.syncedAt || null };
}

function resolveUnityActorAsset(root, relativeJsonPath, assetId) {
  const jsonPath = path.resolve(root, String(relativeJsonPath || ""));
  const actorRoots = [unityCharacterDataRoot(root), unityEnemyDataRoot(root)].map((value) => path.resolve(value));
  const insideActorRoot = actorRoots.some((actorRoot) => {
    const relative = path.relative(actorRoot, jsonPath);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  if (!insideActorRoot || !jsonPath.endsWith(".frame-action.json")) throw new Error("角色资源清单路径无效");
  if (!fs.existsSync(jsonPath) || !fs.statSync(jsonPath).isFile()) throw new Error("角色资源清单不存在");

  const modifiedAt = fs.statSync(jsonPath).mtimeMs;
  let manifest = actorAssetManifestCache.get(jsonPath);
  if (!manifest || manifest.modifiedAt !== modifiedAt) {
    const materialized = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (materialized.format !== "frame-action-project" || !Array.isArray(materialized.assets)) throw new Error("角色资源清单格式无效");
    manifest = {
      modifiedAt,
      assets: new Map(materialized.assets.filter((item) => item?.id).map((item) => [String(item.id), item])),
    };
    actorAssetManifestCache.set(jsonPath, manifest);
  }
  const asset = manifest.assets.get(String(assetId || ""));
  if (!asset?.path) throw new Error("角色资源不存在");

  const dataRoot = path.dirname(jsonPath);
  const assetPath = path.resolve(dataRoot, asset.path);
  const relative = path.relative(dataRoot, assetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
    throw new Error("角色资源文件不存在或路径越界");
  }
  return { assetPath, kind: asset.kind };
}

function loadUnityCharacter(root, relativeJsonPath) {
  return loadUnityActor(root, relativeJsonPath, "character");
}

function loadUnityEnemy(root, relativeJsonPath) {
  return loadUnityActor(root, relativeJsonPath, "enemy");
}

function removeUnityActor(root, relativeJsonPath, actorKind) {
  const isEnemy = actorKind === "enemy";
  const actorLabel = isEnemy ? "敌人" : "角色";
  const actorsRoot = path.resolve(isEnemy ? unityEnemyDataRoot(root) : unityCharacterDataRoot(root));
  const jsonPath = path.resolve(root, String(relativeJsonPath || ""));
  const relative = path.relative(actorsRoot, jsonPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !jsonPath.endsWith(".frame-action.json")) {
    throw new Error(`${actorLabel}数据路径不在对应的 FrameActionData 目录中`);
  }
  const dataFolder = path.dirname(jsonPath);
  if (path.dirname(dataFolder) !== actorsRoot) throw new Error(`${actorLabel}数据必须位于独立的同步目录中`);
  if (!fs.existsSync(jsonPath) || !fs.statSync(jsonPath).isFile()) throw new Error(`${actorLabel}数据文件不存在，可能已被删除`);

  const materialized = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const materializedKind = materialized.projectKind === "enemy" ? "enemy" : "character";
  if (materialized.format !== "frame-action-project" || materializedKind !== actorKind || !Array.isArray(materialized.actions)) {
    throw new Error(`${actorLabel}数据格式无效，已停止删除`);
  }

  const slug = path.basename(dataFolder);
  const generatedFolderName = isEnemy ? "Enemies" : "Characters";
  const generatedRoot = path.resolve(root, "Assets", "FrameActionGenerated", generatedFolderName);
  const generatedFolder = path.resolve(generatedRoot, slug);
  if (path.dirname(generatedFolder) !== generatedRoot) throw new Error(`${actorLabel}生成目录校验失败，已停止删除`);

  const prefabPath = String(materialized.unityCharacter?.prefabPath || "").trim().replace(/\\/g, "/");
  const generatedRelativeFolder = `Assets/FrameActionGenerated/${generatedFolderName}/${slug}/`;
  const generatedPrefab = Boolean(prefabPath && prefabPath.startsWith(generatedRelativeFolder));
  const normalizedJsonPath = path.relative(root, jsonPath).replace(/\\/g, "/");
  const remainingActors = listUnityActors(root, actorKind).filter((actor) => actor.jsonPath !== normalizedJsonPath);
  const sharedPrefabReferences = prefabPath ? remainingActors.filter((actor) => actor.prefabPath === prefabPath) : [];
  const generatedFolderReferences = remainingActors.filter((actor) => actor.prefabPath.startsWith(generatedRelativeFolder));
  const preserveGeneratedFolder = generatedFolderReferences.length > 0;
  const preservedPrefabPath = prefabPath && (!generatedPrefab || preserveGeneratedFolder) ? prefabPath : "";
  const deletedPaths = [];

  for (const target of [dataFolder, ...(preserveGeneratedFolder ? [] : [generatedFolder])]) {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      deletedPaths.push(path.relative(root, target).replace(/\\/g, "/"));
    }
    const metaPath = `${target}.meta`;
    if (fs.existsSync(metaPath) && fs.statSync(metaPath).isFile()) fs.rmSync(metaPath, { force: true });
  }

  const stampPath = path.join(root, "Assets", "FrameActionData", ".frame-action-sync.json");
  if (fs.existsSync(stampPath)) {
    try {
      const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
      const stampKey = isEnemy ? "lastEnemy" : "lastCharacter";
      if (stamp[stampKey] === slug) {
        if (sharedPrefabReferences[0]) stamp[stampKey] = path.basename(path.dirname(sharedPrefabReferences[0].jsonPath));
        else delete stamp[stampKey];
        stamp.syncedAt = new Date().toISOString();
        fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
      }
    } catch {
      // The synchronization stamp is advisory; invalid content must not block an otherwise safe deletion.
    }
  }

  const replacementActor = sharedPrefabReferences[0] || null;
  if (replacementActor) {
    const replacementJsonPath = path.resolve(root, replacementActor.jsonPath);
    const replacementRelative = path.relative(actorsRoot, replacementJsonPath);
    if (!replacementRelative.startsWith("..") && !path.isAbsolute(replacementRelative) && fs.existsSync(replacementJsonPath)) {
      const now = new Date();
      fs.utimesSync(replacementJsonPath, now, now);
    }
  }

  return {
    characterName: materialized.characterName || slug,
    slug,
    deletedPaths,
    deletedPrefabPath: generatedPrefab && !preserveGeneratedFolder ? prefabPath : "",
    preservedPrefabPath,
    preservedGeneratedPath: preserveGeneratedFolder ? generatedRelativeFolder.replace(/\/$/, "") : "",
    sharedPrefabReferenceCount: sharedPrefabReferences.length,
    replacementEnemy: replacementActor ? { characterName: replacementActor.characterName, jsonPath: replacementActor.jsonPath } : null,
  };
}

function removeUnityEnemy(root, relativeJsonPath) {
  return removeUnityActor(root, relativeJsonPath, "enemy");
}

function removeUnityCharacter(root, relativeJsonPath) {
  return removeUnityActor(root, relativeJsonPath, "character");
}

function collectAssetIds(value, output) {
  if (!value || typeof value !== "object") return;
  if (typeof value.assetId === "string" && value.assetId) output.add(value.assetId);
  if (Array.isArray(value.frameAssetIds)) {
    for (const id of value.frameAssetIds) if (typeof id === "string" && id) output.add(id);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAssetIds(item, output);
    return;
  }
  for (const child of Object.values(value)) collectAssetIds(child, output);
}

function layoutEnemyBehaviorNodes(rootNodeId, nodes) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    const siblings = childrenByParent.get(node.parentId) || [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  for (const children of childrenByParent.values()) children.sort((left, right) => left.order - right.order);
  let leafIndex = 0;
  const visited = new Set();
  const place = (nodeId, depth) => {
    const node = nodesById.get(nodeId);
    if (!node || visited.has(nodeId)) return 120 + leafIndex * 230;
    visited.add(nodeId);
    const children = childrenByParent.get(node.id) || [];
    let centerX;
    if (children.length) {
      const childCenters = children.map((child) => place(child.id, depth + 1));
      centerX = childCenters.reduce((sum, value) => sum + value, 0) / childCenters.length;
    } else {
      centerX = 120 + leafIndex * 230;
      leafIndex += 1;
    }
    node.positionX = Math.round(centerX - 95);
    node.positionY = 70 + depth * 150;
    return centerX;
  };
  place(rootNodeId, 0);
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    node.positionX = 25 + leafIndex * 230;
    node.positionY = 70;
    leafIndex += 1;
  }
}

function stableDataId(prefix, seed) {
  return `${prefix}_${crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 16)}`;
}

function normalizeAttributeEffect(value, nested, ownerKey) {
  const source = value && typeof value === "object" ? value : {};
  const normalized = {
    id: String(source.id || stableDataId("attribute", ownerKey)),
    propertyId: String(source.propertyId || source.targetPropertyId || ""),
    fixedValue: Number.isFinite(Number(source.fixedValue)) ? Number(source.fixedValue) : 0,
    references: (Array.isArray(source.references) ? source.references : []).map((reference, referenceIndex) => ({
      id: String(reference?.id || stableDataId("reference", `${ownerKey}:${referenceIndex}`)),
      propertyId: String(reference?.propertyId || ""),
      percent: Number.isFinite(Number(reference?.percent)) ? Number(reference.percent) : 0,
      ...(nested ? { referenceObject: reference?.referenceObject === "target" ? "target" : "self" } : {}),
    })),
    changeType: source.changeType === "temporary" ? "temporary" : "permanent",
    durationSeconds: Math.max(0, Number(source.durationSeconds) || 0),
  };
  if (nested) normalized.targetObject = source.targetObject === "self" ? "self" : "target";
  return normalized;
}

function migrateCharacterProject(value) {
  if (!value || typeof value !== "object") return value;
  const project = JSON.parse(JSON.stringify(value));
  const sourceVersion = Math.max(1, Number(project.version) || 1);
  project.projectKind = project.projectKind === "enemy" ? "enemy" : "character";
  const actions = Array.isArray(project.actions) ? project.actions : [];
  project.actions = actions;
  if (project.projectKind === "character" && sourceVersion < 2 && actions.length > 0) {
    const jump = actions.find((action) => action?.type === "jump");
    const jumpSegment = jump?.segments?.[0];
    const existingIds = new Set(actions.map((action) => action?.id).filter(Boolean));
    const dropId = existingIds.has("drop-through") ? "drop-through-default" : "drop-through";
    const trackKinds = ["damage", "physics", "vfx", "sfx", "attribute", "speed", "camera"];
    const dropThrough = {
      id: dropId,
      name: "下跳",
      type: "dropThrough",
      loop: false,
      comboCount: 1,
      comboWindow: 0.12,
      repeatWindow: 0.28,
      allowLastRepeat: false,
      doubleTapWindow: 0.28,
      movementSpeed: 4,
      acceptMovementInput: true,
      acceptJumpInput: false,
      trigger: { type: "keyboardChord", code: "S", secondaryCode: "K" },
      transitions: Object.fromEntries(actions.map((action) => [action.id, action.type === "hurt" ? "interrupt" : "ignore"])),
      segments: [{
        id: "segment-drop-through-default",
        name: "主动作",
        fps: Math.max(1, Number(jumpSegment?.fps) || 12),
        frameCount: 8,
        sheetColumns: 5,
        sheetSpacing: 0,
        sheetPadding: 0,
        cellWidth: 500,
        cellHeight: 500,
        pixelsPerUnit: Math.max(1, Number(jumpSegment?.pixelsPerUnit) || Number(project.pixelsPerUnit) || 160),
        pivotX: Number(jumpSegment?.pivotX) || 0,
        pivotY: Number(jumpSegment?.pivotY) || 0,
        jumpHeight: 2.4,
        frames: [],
        markers: [],
        tracks: trackKinds.map((kind) => ({ id: `track-drop-through-${kind}`, name: ({ damage: "命中", physics: "物理", vfx: "特效", sfx: "音效", attribute: "属性", speed: "速度", camera: "镜头" })[kind], kind, events: [] })),
      }],
    };
    for (const action of actions) {
      action.transitions = action.transitions && typeof action.transitions === "object" ? action.transitions : {};
      action.transitions[dropId] = "ignore";
    }
    const jumpIndex = jump ? actions.indexOf(jump) : actions.length - 1;
    actions.splice(jumpIndex + 1, 0, dropThrough);
  }
  for (const action of actions) {
    if (!action) continue;
    action.acceptMovementInput = typeof action.acceptMovementInput === "boolean"
      ? action.acceptMovementInput
      : action.type !== "attack";
    action.acceptJumpInput = typeof action.acceptJumpInput === "boolean"
      ? action.acceptJumpInput
      : false;
    for (const segment of Array.isArray(action.segments) ? action.segments : []) {
      segment.tracks = Array.isArray(segment?.tracks) ? segment.tracks : [];
      if (!segment.tracks.some((track) => track?.kind === "attribute")) {
        segment.tracks.push({ id: stableDataId("track_attribute", segment.id || action.id || "segment"), name: "属性", kind: "attribute", events: [] });
      }
      for (const track of segment.tracks) {
        for (const event of Array.isArray(track?.events) ? track.events : []) {
          const params = event?.params && typeof event.params === "object" ? event.params : {};
          event.params = params;
          const vfxEffects = track.kind === "vfx" && Array.isArray(params.vfxEffects) ? params.vfxEffects : [];
          const damageEffects = track.kind === "damage" && Array.isArray(params.damageEffects) ? params.damageEffects : [];
          if (track.kind === "attribute") {
            params.attributeEffects = (Array.isArray(params.attributeEffects) ? params.attributeEffects : [])
              .map((effect, effectIndex) => normalizeAttributeEffect(effect, false, `${event.id || "event"}:${effectIndex}`));
          }
          for (const effect of vfxEffects) if (effect && typeof effect === "object") effect.renderLayer = effect.renderLayer === "back" ? "back" : "front";
          for (let damageIndex = 0; damageIndex < damageEffects.length; damageIndex += 1) {
            const damageEffect = damageEffects[damageIndex];
            damageEffect.onHitAttributeEffects = (Array.isArray(damageEffect?.onHitAttributeEffects) ? damageEffect.onHitAttributeEffects : [])
              .map((effect, effectIndex) => normalizeAttributeEffect(effect, true, `${event.id || "event"}:${damageIndex}:${effectIndex}`));
            const nestedEffects = [
              ...(Array.isArray(damageEffect?.companionVfxEffects) ? damageEffect.companionVfxEffects : []),
              ...(Array.isArray(damageEffect?.onHitVfxEffects) ? damageEffect.onHitVfxEffects : []),
            ];
            for (const effect of nestedEffects) if (effect && typeof effect === "object") effect.renderLayer = effect.renderLayer === "back" ? "back" : "front";
          }
        }
      }
    }
  }
  project.cameraFollow = {
    enabled: true,
    followHorizontal: true,
    followVertical: true,
    smoothTime: 0.15,
    offsetX: 0,
    offsetY: 1.5,
    orthographicSize: 5,
    constrainToMap: true,
    edgePaddingX: 0.25,
    edgePaddingY: 0.25,
    ...(project.cameraFollow && typeof project.cameraFollow === "object" ? project.cameraFollow : {}),
  };
  project.unityCharacter = {
    ...(project.unityCharacter && typeof project.unityCharacter === "object" ? project.unityCharacter : {}),
    actorLayerName: String(project.unityCharacter?.actorLayerName || (project.projectKind === "enemy" ? "Enemy" : "Player")).trim() || (project.projectKind === "enemy" ? "Enemy" : "Player"),
    collideWithOtherActors: project.unityCharacter?.collideWithOtherActors === true,
  };
  if (project.projectKind === "enemy") {
    project.motor = { ...(project.motor || {}), enableInput: false, enableMotor: false };
    project.cameraFollow.enabled = false;
    const enemyMovement = {
      enabled: true,
      targetTag: "Player",
      detectionRange: 8,
      loseTargetRange: 12,
      verticalTolerance: 2,
      patrolDistance: 3,
      patrolSpeed: 1.5,
      chaseSpeed: 3,
      acceleration: 30,
      stopDistance: 1,
      blockedWaitSeconds: 1.2,
      turnCooldownSeconds: 0.15,
      wallCheckDistance: 0.12,
      ledgeCheckForwardDistance: 0.25,
      ledgeCheckDownDistance: 0.65,
      groundCheckDistance: 0.08,
      environmentLayerName: "Ground",
      gravityScale: 3,
      maxFallSpeed: 18,
      ...(project.enemyBehavior?.movement && typeof project.enemyBehavior.movement === "object" ? project.enemyBehavior.movement : {}),
    };
    enemyMovement.enabled = enemyMovement.enabled !== false;
    enemyMovement.targetTag = String(enemyMovement.targetTag || "Player");
    enemyMovement.detectionRange = Math.max(0.01, Number(enemyMovement.detectionRange) || 8);
    enemyMovement.loseTargetRange = Math.max(enemyMovement.detectionRange, Number(enemyMovement.loseTargetRange) || 12);
    enemyMovement.verticalTolerance = Math.max(0, Number(enemyMovement.verticalTolerance) || 0);
    enemyMovement.patrolDistance = Math.max(0, Number(enemyMovement.patrolDistance) || 0);
    enemyMovement.patrolSpeed = Math.max(0, Number(enemyMovement.patrolSpeed) || 0);
    enemyMovement.chaseSpeed = Math.max(0, Number(enemyMovement.chaseSpeed) || 0);
    enemyMovement.acceleration = Math.max(0.01, Number(enemyMovement.acceleration) || 30);
    enemyMovement.stopDistance = Math.max(0, Number(enemyMovement.stopDistance) || 0);
    enemyMovement.blockedWaitSeconds = Math.max(0, Number(enemyMovement.blockedWaitSeconds) || 0);
    enemyMovement.turnCooldownSeconds = Math.max(0, Number(enemyMovement.turnCooldownSeconds) || 0);
    enemyMovement.wallCheckDistance = Math.max(0.001, Number(enemyMovement.wallCheckDistance) || 0.12);
    enemyMovement.ledgeCheckForwardDistance = Math.max(0, Number(enemyMovement.ledgeCheckForwardDistance) || 0);
    enemyMovement.ledgeCheckDownDistance = Math.max(0.001, Number(enemyMovement.ledgeCheckDownDistance) || 0.65);
    enemyMovement.groundCheckDistance = Math.max(0.001, Number(enemyMovement.groundCheckDistance) || 0.08);
    enemyMovement.environmentLayerName = String(enemyMovement.environmentLayerName || "Ground");
    enemyMovement.gravityScale = Math.max(0, Number(enemyMovement.gravityScale) || 0);
    enemyMovement.maxFallSpeed = Math.max(0.01, Number(enemyMovement.maxFallSpeed) || 18);
    let behaviorNodes = Array.isArray(project.enemyBehavior?.nodes) ? project.enemyBehavior.nodes : [];
    let behaviorRootId = String(project.enemyBehavior?.rootNodeId || "");
    const legacyDefaultTree = sourceVersion < 5
      && behaviorNodes.length === 5
      && behaviorNodes.some((node) => node?.type === "playAction" && node.actionId === "skill")
      && behaviorNodes.some((node) => node?.type === "playAction" && node.actionId === "ground-idle")
      && !behaviorNodes.some((node) => node?.type === "customTask");
    if (legacyDefaultTree || !behaviorNodes.length || !behaviorNodes.some((node) => node?.id === behaviorRootId)) {
      behaviorRootId = "enemy-ai-root";
      behaviorNodes = [
        { id: behaviorRootId, parentId: "", order: 0, name: "决策入口", type: "selector", conditionKey: "hasTarget", comparison: "isTrue", numberValue: 0, stringValue: "", actionId: "", waitUntilComplete: true, ignoreSkillCooldown: false, durationSeconds: 0.5, taskKey: "moveToTarget" },
        { id: "enemy-ai-skill", parentId: behaviorRootId, order: 0, name: "技能决策", type: "sequence", conditionKey: "hasTarget", comparison: "isTrue", numberValue: 0, stringValue: "", actionId: "", waitUntilComplete: true, durationSeconds: 0.5, taskKey: "moveToTarget" },
        { id: "enemy-ai-can-skill", parentId: "enemy-ai-skill", order: 0, name: "存在可释放技能", type: "condition", conditionKey: "canUseAnySkill", comparison: "isTrue", numberValue: 0, stringValue: "", actionId: "", waitUntilComplete: true, durationSeconds: 0.5, taskKey: "moveToTarget" },
        { id: "enemy-ai-stop", parentId: "enemy-ai-skill", order: 1, name: "技能前停止", type: "customTask", conditionKey: "hasTarget", comparison: "isTrue", numberValue: 0, stringValue: "", actionId: "", waitUntilComplete: true, durationSeconds: 0.5, taskKey: "stop" },
        { id: "enemy-ai-use-skill", parentId: "enemy-ai-skill", order: 2, name: "选择并释放技能", type: "customTask", conditionKey: "hasTarget", comparison: "isTrue", numberValue: 0, stringValue: "", actionId: "", waitUntilComplete: true, durationSeconds: 0.5, taskKey: "useBestSkill" },
        { id: "enemy-ai-chase", parentId: behaviorRootId, order: 1, name: "追击决策", type: "sequence", conditionKey: "hasTarget", comparison: "isTrue", numberValue: 0, stringValue: "", actionId: "", waitUntilComplete: true, durationSeconds: 0.5, taskKey: "moveToTarget" },
        { id: "enemy-ai-has-target", parentId: "enemy-ai-chase", order: 0, name: "已发现目标", type: "condition", conditionKey: "hasTarget", comparison: "isTrue", numberValue: 0, stringValue: "", actionId: "", waitUntilComplete: true, durationSeconds: 0.5, taskKey: "moveToTarget" },
        { id: "enemy-ai-chase-task", parentId: "enemy-ai-chase", order: 1, name: "追击目标", type: "customTask", conditionKey: "hasTarget", comparison: "isTrue", numberValue: 0, stringValue: "", actionId: "", waitUntilComplete: true, durationSeconds: 0.5, taskKey: "chase" },
        { id: "enemy-ai-patrol", parentId: behaviorRootId, order: 2, name: "地面巡逻", type: "customTask", conditionKey: "hasTarget", comparison: "isTrue", numberValue: 0, stringValue: "", actionId: "", waitUntilComplete: true, durationSeconds: 0.5, taskKey: "patrol" },
      ];
    }
    behaviorNodes = behaviorNodes.map((node, index) => ({
      ...node,
      id: String(node?.id || `enemy-ai-node-${index + 1}`),
      parentId: String(node?.parentId || ""),
      order: Number.isFinite(Number(node?.order)) ? Number(node.order) : index,
      ignoreSkillCooldown: node?.type === "playAction" || node?.ignoreSkillCooldown === true,
      positionX: Number.isFinite(Number(node?.positionX)) ? Number(node.positionX) : 0,
      positionY: Number.isFinite(Number(node?.positionY)) ? Number(node.positionY) : 0,
    }));
    if (behaviorNodes.every((node) => node.positionX === 0 && node.positionY === 0)) layoutEnemyBehaviorNodes(behaviorRootId, behaviorNodes);
    project.enemyBehavior = {
      ...(project.enemyBehavior && typeof project.enemyBehavior === "object" ? project.enemyBehavior : {}),
      playGroundIdleOnEnable: project.enemyBehavior?.playGroundIdleOnEnable !== false,
      returnToIdleOnComplete: project.enemyBehavior?.returnToIdleOnComplete === true,
      enabled: sourceVersion < 5 ? true : project.enemyBehavior?.enabled !== false,
      tickIntervalSeconds: Math.max(0.02, Number(project.enemyBehavior?.tickIntervalSeconds) || 0.1),
      movement: enemyMovement,
      rootNodeId: behaviorRootId,
      nodes: behaviorNodes,
    };
    for (const action of actions) {
      if (!action) continue;
      action.trigger = { type: "none", code: "" };
      action.transitions = {};
      action.comboCount = 1;
      if (action.type === "skill") {
        const enemySkill = {
          cooldownSeconds: 1.5,
          minRange: 0,
          maxRange: 1.5,
          selectionWeight: 1,
          lockMovement: true,
          lockFacing: true,
          ...(action.enemySkill && typeof action.enemySkill === "object" ? action.enemySkill : {}),
        };
        enemySkill.cooldownSeconds = Math.max(0, Number(enemySkill.cooldownSeconds) || 0);
        enemySkill.minRange = Math.max(0, Number(enemySkill.minRange) || 0);
        enemySkill.maxRange = Math.max(enemySkill.minRange, Number(enemySkill.maxRange) || 1.5);
        enemySkill.selectionWeight = Math.max(0.01, Number(enemySkill.selectionWeight) || 1);
        enemySkill.lockMovement = enemySkill.lockMovement !== false;
        enemySkill.lockFacing = enemySkill.lockFacing !== false;
        action.enemySkill = enemySkill;
      } else {
        delete action.enemySkill;
      }
    }
  } else {
    for (const action of actions) if (action) delete action.enemySkill;
  }
  project.version = 12;
  return project;
}

function syncCharacter(root, payload, expectedKind = "character", uploadedAssetPaths = null) {
  const project = migrateCharacterProject(payload.project);
  if (!project || project.format !== "frame-action-project" || project.projectKind !== expectedKind) throw new Error(`${expectedKind === "enemy" ? "敌人" : "角色"}动作数据格式无效`);
  const isEnemy = expectedKind === "enemy";
  const actorKind = isEnemy ? "enemy" : "character";
  const actorLabel = isEnemy ? "敌人" : "角色";
  project.characterName = String(project.characterName || "").trim();
  if (!project.characterName) throw new Error(`${actorLabel}名称不能为空`);
  const location = resolveActorSyncLocation(root, project, actorKind, payload.targetJsonPath);
  const { targetActor, sameNameActor, overwriteActor, existingActor, slug, dataRoot, jsonPath } = location;
  if (targetActor && sameNameActor && sameNameActor.jsonPath !== targetActor.jsonPath) {
    const error = new Error(`另一个已同步${actorLabel}正在使用名称“${project.characterName}”。请换一个名称后再更新当前${actorLabel}。`);
    error.statusCode = 409;
    throw error;
  }
  const configuredPrefabPath = targetActor
    ? project.unityCharacter?.prefabPath || targetActor.prefabPath
    : project.unityCharacter?.prefabPath || overwriteActor?.prefabPath || "";
  let prefabPath = isEnemy
    ? validateEnemyPrefabPath(configuredPrefabPath, slug, project.characterName)
    : validateCharacterPrefabPath(configuredPrefabPath, slug, project.characterName);
  if (overwriteActor && payload.confirmOverwrite !== true) {
    const error = new Error(`Unity 项目中已存在同名${actorLabel}“${project.characterName}”。确认覆盖后才会更新其动作数据和 Prefab。`);
    error.statusCode = 409;
    throw error;
  }
  let prefabPathAdjustedFrom = "";
  {
    const generatedMatch = new RegExp(`^Assets/FrameActionGenerated/${isEnemy ? "Enemies" : "Characters"}/([^/]+)/`, "i").exec(prefabPath);
    if (generatedMatch && generatedMatch[1] !== slug) {
      prefabPathAdjustedFrom = prefabPath;
      prefabPath = isEnemy ? validateEnemyPrefabPath("", slug, project.characterName) : validateCharacterPrefabPath("", slug, project.characterName);
    }
    const currentJsonPath = path.relative(root, jsonPath).replace(/\\/g, "/");
    const collisions = listUnityActors(root, actorKind).filter((actor) => actor.jsonPath !== currentJsonPath && actor.prefabPath === prefabPath);
    if (collisions.length) {
      const error = new Error(`目标${actorLabel} Prefab 已由“${collisions.map((actor) => actor.characterName).join("、")}”使用。请填写独立路径，或清空“目标${actorLabel} Prefab”后重新同步。`);
      error.statusCode = 409;
      throw error;
    }
  }
  const sourceAssets = Array.isArray(payload.assets) ? payload.assets : [];
  let previousAssets = [];
  let previousMaterialized = null;
  if (fs.existsSync(jsonPath)) {
    try {
      previousMaterialized = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      previousAssets = previousMaterialized.assets || [];
    } catch {
      previousAssets = [];
    }
  }
  const manifestById = new Map(previousAssets.filter((asset) => asset?.id).map((asset) => [asset.id, asset]));
  let changedFiles = 0;

  const referencedIds = new Set();
  for (const action of Array.isArray(project.actions) ? project.actions : []) {
    for (const segment of Array.isArray(action.segments) ? action.segments : []) {
      for (const frame of Array.isArray(segment.frames) ? segment.frames : []) if (frame?.assetId) referencedIds.add(frame.assetId);
      for (const track of Array.isArray(segment.tracks) ? segment.tracks : []) {
        for (const event of Array.isArray(track.events) ? track.events : []) collectAssetIds(event, referencedIds);
      }
    }
  }

  for (const asset of sourceAssets) {
    const uploadedAssetPath = asset?.id && uploadedAssetPaths ? uploadedAssetPaths.get(String(asset.id)) : "";
    if (!asset || !asset.id || !referencedIds.has(asset.id)) continue;
    const assetId = String(asset.id);
    const previous = manifestById.get(assetId);
    let relativePath = "";
    let byteSize = Number(asset.byteSize);
    let sha256 = isSha256(asset.sha256) ? String(asset.sha256).toLowerCase() : "";

    if (asset.dataUrl || uploadedAssetPath) {
      const folder = asset.kind === "audio" ? "Audio" : "Sprites";
      const fileName = safeName(asset.name, `${assetId}.${asset.kind === "audio" ? "wav" : "png"}`);
      relativePath = `${folder}/${fileName}`.replace(/\\/g, "/");
      const fullPath = path.join(dataRoot, folder, fileName);
      const contents = uploadedAssetPath ? fs.readFileSync(uploadedAssetPath) : decodeDataUrl(asset.dataUrl);
      if (writeIfChanged(fullPath, contents)) changedFiles += 1;
      byteSize = contents.length;
      sha256 ||= sha256Buffer(contents);
    } else {
      relativePath = String(asset.reusedPath || previous?.path || "").replace(/\\/g, "/");
      const fullPath = resolveContainedFile(dataRoot, relativePath);
      if (!fullPath || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        throw new Error(`资源“${asset.name || assetId}”缺少可复用文件，请重新同步`);
      }
      if (!Number.isSafeInteger(byteSize) || byteSize <= 0) byteSize = fs.statSync(fullPath).size;
      sha256 ||= isSha256(previous?.sha256) ? String(previous.sha256).toLowerCase() : sha256File(fullPath);
    }
    manifestById.set(assetId, {
      id: assetId,
      name: asset.name,
      kind: asset.kind,
      usage: asset.usage,
      path: relativePath,
      byteSize,
      sha256,
    });
  }

  const manifestAssets = Array.from(manifestById.values()).filter((asset) => referencedIds.has(asset.id));
  const retainedPaths = new Set(manifestAssets.map((asset) => asset.path));
  for (const asset of previousAssets) {
    if (!asset?.path || retainedPaths.has(asset.path)) continue;
    const fullPath = path.resolve(dataRoot, asset.path);
    const relative = path.relative(dataRoot, fullPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    for (const obsoletePath of [fullPath, `${fullPath}.meta`]) {
      if (!fs.existsSync(obsoletePath) || !fs.statSync(obsoletePath).isFile()) continue;
      fs.rmSync(obsoletePath, { force: true });
      changedFiles += 1;
    }
  }

  const syncMetadata = {
    tool: "sprite-cue-studio",
    runtimePackage: "com.frame-action.runtime",
    syncedAt: previousMaterialized?.sync?.syncedAt || new Date().toISOString(),
  };
  const materialized = {
    ...project,
    unityCharacter: { ...(project.unityCharacter || {}), prefabPath },
    assets: manifestAssets,
    sync: syncMetadata,
  };
  const withoutSyncTime = (value) => value ? { ...value, sync: { ...(value.sync || {}), syncedAt: "" } } : null;
  const dataChanged = changedFiles > 0 || JSON.stringify(withoutSyncTime(previousMaterialized)) !== JSON.stringify(withoutSyncTime(materialized));
  if (dataChanged) materialized.sync.syncedAt = new Date().toISOString();
  if (writeIfChanged(jsonPath, `${JSON.stringify(materialized, null, 2)}\n`)) changedFiles += 1;
  const stampPath = path.join(root, "Assets", "FrameActionData", ".frame-action-sync.json");
  writeIfChanged(stampPath, `${JSON.stringify({ [isEnemy ? "lastEnemy" : "lastCharacter"]: slug, syncedAt: materialized.sync.syncedAt }, null, 2)}\n`);

  return {
    character: project.characterName,
    slug,
    changedFiles,
    assetCount: manifestAssets.length,
    actionCount: Array.isArray(project.actions) ? project.actions.length : 0,
    jsonPath: path.relative(root, jsonPath).replace(/\\/g, "/"),
    prefabPath,
    prefabPathAdjustedFrom,
    updatedExisting: Boolean(existingActor),
  };
}

function validateEnemyPrefabPath(value, slug, enemyName) {
  const displayName = safeName(enemyName, "敌人");
  const fallback = `Assets/FrameActionGenerated/Enemies/${slug}/${displayName}.prefab`;
  const resolved = String(value || fallback).trim().replace(/\\/g, "/");
  if (!resolved.startsWith("Assets/") || !resolved.toLowerCase().endsWith(".prefab") || resolved.includes("../")) {
    throw new Error("敌人 Prefab 必须是 Assets 目录中的 .prefab 路径");
  }
  if (/^Assets\/FrameActionGenerated\/(Maps|Characters)\//i.test(resolved)) throw new Error("敌人模块不能绑定地图或角色模块 Prefab");
  return resolved;
}

function validateCharacterPrefabPath(value, slug, characterName) {
  const displayName = safeName(characterName, "角色");
  const fallback = `Assets/FrameActionGenerated/Characters/${slug}/${displayName}.prefab`;
  const resolved = String(value || fallback).trim().replace(/\\/g, "/");
  if (!resolved.startsWith("Assets/") || !resolved.toLowerCase().endsWith(".prefab") || resolved.includes("../")) {
    throw new Error("角色 Prefab 必须是 Assets 目录中的 .prefab 路径");
  }
  if (/^Assets\/FrameActionGenerated\/(Maps|Enemies)\//i.test(resolved)) throw new Error("角色模块不能绑定地图或敌人模块 Prefab");
  return resolved;
}

function walkFiles(folder, predicate, output = []) {
  if (!fs.existsSync(folder)) return output;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) walkFiles(fullPath, predicate, output);
    else if (entry.isFile() && predicate(fullPath, entry.name)) output.push(fullPath);
  }
  return output;
}

function listMapPrefabs(root) {
  const generatedRoot = path.join(root, "Assets", "FrameActionGenerated", "Maps");
  const mapData = listUnityMaps(root).filter((item) => !item.legacy);
  const namesByPath = new Map(mapData.filter((item) => item.prefabPath).map((item) => [item.prefabPath, item.mapName]));
  const sourcesByPath = new Map(mapData.filter((item) => item.prefabPath).map((item) => [item.prefabPath, item.jsonPath]));
  const paths = new Set(walkFiles(generatedRoot, (_, name) => name.toLowerCase().endsWith(".prefab"))
    .map((fullPath) => path.relative(root, fullPath).replace(/\\/g, "/")));
  for (const item of mapData) {
    if (!item.prefabPath) continue;
    const fullPath = path.join(root, item.prefabPath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) paths.add(item.prefabPath);
  }
  return [...paths]
    .map((prefabPath) => ({
      path: prefabPath,
      mapName: namesByPath.get(prefabPath) || path.basename(prefabPath, ".prefab"),
      sourceJsonPath: sourcesByPath.get(prefabPath) || "",
      hasSourceData: sourcesByPath.has(prefabPath),
    }))
    .sort((left, right) => left.mapName.localeCompare(right.mapName, "zh-CN", { numeric: true }));
}

function listUnityMaps(root) {
  const assetsRoot = path.join(root, "Assets");
  const files = walkFiles(assetsRoot, (_, name) => name.toLowerCase().endsWith(".frame-action-map.json") || name.toLowerCase() === "map.json");
  const results = [];
  for (const jsonPath of files) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const legacy = data.tool === "2d-game-helper-map-editor";
      if (data.format !== "frame-action-map" && !legacy) continue;
      const folderName = path.basename(path.dirname(jsonPath)).replace(/_UnityMap$/i, "");
      const relativeJsonPath = path.relative(root, jsonPath).replace(/\\/g, "/");
      const managedRoot = path.resolve(root, "Assets", "FrameActionData", "Maps");
      const dataFolder = path.dirname(path.resolve(jsonPath));
      const managed = !legacy && path.dirname(dataFolder) === managedRoot && jsonPath.toLowerCase().endsWith(".frame-action-map.json");
      const prefabPath = String(data.unityPrefabPath || "").replace(/\\/g, "/");
      results.push({
        mapName: data.mapName || folderName || "地图",
        jsonPath: relativeJsonPath,
        prefabPath,
        syncedAt: data.sync?.syncedAt || fs.statSync(jsonPath).mtime.toISOString(),
        legacy,
        managed,
        generatedPrefab: /^Assets\/FrameActionGenerated\/Maps\/[^/]+\//i.test(prefabPath),
      });
    } catch {
      continue;
    }
  }
  const prefabCounts = new Map();
  for (const item of results) if (item.prefabPath) prefabCounts.set(item.prefabPath, (prefabCounts.get(item.prefabPath) || 0) + 1);
  return results
    .map((item) => ({ ...item, sharedPrefab: Boolean(item.prefabPath && prefabCounts.get(item.prefabPath) > 1) }))
    .sort((left, right) => String(right.syncedAt).localeCompare(String(left.syncedAt)));
}

function findUnityMapByJsonPath(root, relativeJsonPath) {
  const normalizedPath = String(relativeJsonPath || "").trim().replace(/\\/g, "/");
  if (!normalizedPath) return null;
  const map = listUnityMaps(root).find((item) => item.jsonPath === normalizedPath);
  if (!map) throw new Error("要更新的地图不存在，可能已经被删除；请重新打开同步列表后再试");
  return map;
}

function findUnityMapOverwrite(root, mapName) {
  const normalizedName = String(mapName || "").trim();
  if (!normalizedName) throw new Error("地图名称不能为空");
  return listUnityMaps(root).find((item) => item.mapName === normalizedName) || null;
}

function findMapPrefabOverwrite(root, mapName, requestedPrefabPath = "") {
  const normalizedName = String(mapName || "").trim();
  const requested = String(requestedPrefabPath || "").trim().replace(/\\/g, "/");
  const expectedPath = `Assets/FrameActionGenerated/Maps/${mapSlug(normalizedName)}/${safeName(normalizedName, "地图")}.prefab`;
  return listMapPrefabs(root).find((item) => !item.hasSourceData && (item.path === requested || item.path === expectedPath || (!requested && item.mapName === normalizedName))) || null;
}

function checkMapOverwrite(root, payload) {
  const mapName = String(payload.mapName || "").trim();
  if (!mapName) throw new Error("地图名称不能为空");
  const targetMap = findUnityMapByJsonPath(root, payload.targetJsonPath);
  const sameNameMap = findUnityMapOverwrite(root, mapName);
  if (targetMap && sameNameMap && sameNameMap.jsonPath !== targetMap.jsonPath) {
    const error = new Error(`另一个已同步地图正在使用名称“${mapName}”。请换一个名称后再更新当前地图。`);
    error.statusCode = 409;
    throw error;
  }
  const requestedPrefabPath = String(payload.unityPrefabPath || "").trim().replace(/\\/g, "/");
  const prefabOwner = requestedPrefabPath ? listUnityMaps(root).find((item) => item.prefabPath === requestedPrefabPath && item.jsonPath !== targetMap?.jsonPath && item.jsonPath !== sameNameMap?.jsonPath) : null;
  if (prefabOwner) {
    const error = new Error(`目标地图 Prefab 已由“${prefabOwner.mapName}”使用。请选择独立 Prefab，或清空同步目标后重新同步。`);
    error.statusCode = 409;
    throw error;
  }
  if (targetMap) return null;
  if (sameNameMap) return sameNameMap;
  const orphanPrefab = findMapPrefabOverwrite(root, mapName, payload.unityPrefabPath);
  return orphanPrefab ? {
    mapName: orphanPrefab.mapName,
    jsonPath: "",
    prefabPath: orphanPrefab.path,
    syncedAt: "",
    orphanPrefab: true,
    managed: false,
    generatedPrefab: /^Assets\/FrameActionGenerated\/Maps\//i.test(orphanPrefab.path),
    sharedPrefab: false,
  } : null;
}

function resolveMapJson(root, relativeJsonPath) {
  const assetsRoot = path.resolve(root, "Assets");
  const jsonPath = path.resolve(root, String(relativeJsonPath || ""));
  const relative = path.relative(assetsRoot, jsonPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !jsonPath.toLowerCase().endsWith(".json")) {
    throw new Error("地图数据路径不在 Unity Assets 目录中");
  }
  if (!fs.existsSync(jsonPath) || !fs.statSync(jsonPath).isFile()) throw new Error("地图数据文件不存在");
  return jsonPath;
}

function loadMapAsset(dataRoot, entry, usage, defaultLayer) {
  if (!entry?.id || !entry.path) return null;
  const assetPath = path.resolve(dataRoot, entry.path);
  const relative = path.relative(dataRoot, assetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) return null;
  const dataUrl = encodeFileDataUrl(assetPath, "image");
  return {
    id: entry.id,
    name: entry.name || path.basename(entry.path),
    kind: "image",
    usage,
    defaultLayer: defaultLayer || "decoration",
    width: Number(entry.width) || 1,
    height: Number(entry.height) || 1,
    outlines: normalizeMapOutlineList(entry.outlines, Number(entry.width) || 1, Number(entry.height) || 1, true),
    draftOutlines: [],
    dataUrl,
    url: dataUrl,
  };
}

const MAP_ELEMENTS = new Set(["fire", "ice", "water", "wind", "light", "dark", "thunder"]);

function normalizeMapElement(value, fallback = "water") {
  const normalized = String(value || "").toLowerCase();
  return MAP_ELEMENTS.has(normalized) ? normalized : fallback;
}

const LEGACY_MATTER_COLORS = {
  fire: "#ff542c", ice: "#65cdf2", water: "#287bd8", wind: "#7be1ba",
  light: "#ffe174", dark: "#5a2d82", thunder: "#ad68ff",
};

function finiteMatterValue(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function matterColor(value, fallback) {
  const text = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
}

function normalizeMatterProfileData(carrier, elementTag, profile = {}) {
  const defaultColor = LEGACY_MATTER_COLORS[String(elementTag).toLowerCase()] || "#44aee8";
  const visual = profile.visual || {};
  const physical = profile.physical || {};
  const gas = carrier === "gas";
  return {
    schemaVersion: 1,
    visual: {
      baseColor: matterColor(visual.baseColor, defaultColor),
      secondaryColor: matterColor(visual.secondaryColor, defaultColor),
      emissionColor: matterColor(visual.emissionColor, "#000000"),
      opacity: finiteMatterValue(visual.opacity, 0.78, 0, 1),
      particleScale: finiteMatterValue(visual.particleScale, 1, 0.1, 4),
      edgeSoftness: finiteMatterValue(visual.edgeSoftness, 0.28, 0, 1),
      detailScale: finiteMatterValue(visual.detailScale, 1, 0.1, 8),
      refractionStrength: finiteMatterValue(visual.refractionStrength, gas ? 0 : 0.12, 0, 1),
      glowStrength: finiteMatterValue(visual.glowStrength, 0, 0, 8),
      foamAmount: finiteMatterValue(visual.foamAmount, gas ? 0 : 0.08, 0, 1),
    },
    physical: {
      density: finiteMatterValue(physical.density, gas ? 0.85 : 1, 0.001, 100),
      viscosity: finiteMatterValue(physical.viscosity, gas ? 0.08 : 0.18, 0, 8),
      surfaceTension: finiteMatterValue(physical.surfaceTension, gas ? 0 : 0.34, 0, 4),
      flowSpeed: finiteMatterValue(physical.flowSpeed, 1, 0.05, 8),
      gravityScale: finiteMatterValue(physical.gravityScale, gas ? 0 : 1, -4, 4),
      diffusion: finiteMatterValue(physical.diffusion, gas ? 0.42 : 0.02, 0, 4),
      buoyancy: finiteMatterValue(physical.buoyancy, gas ? 0.22 : 0, -4, 4),
      drag: finiteMatterValue(physical.drag, gas ? 0.08 : 0.04, 0, 8),
      evaporationHalfLifeSeconds: finiteMatterValue(physical.evaporationHalfLifeSeconds, gas ? 0 : 1200, 0, 86400),
      dissipationHalfLifeSeconds: finiteMatterValue(physical.dissipationHalfLifeSeconds, gas ? 1200 : 0, 0, 86400),
    },
  };
}

function normalizeMapOutlineData(outline = {}, width = Number.POSITIVE_INFINITY, height = Number.POSITIVE_INFINITY, assetTemplate = false) {
  const legacyLineRoad = outline.shape === "lineRoad" || outline.shape === "oneWayLine";
  const rectangleCollision = legacyLineRoad || outline.shape === "groundLine";
  const thickness = rectangleCollision ? Math.max(1, Number(outline.thickness) || 1) : Math.max(0, Number(outline.thickness) || 0);
  let points = Array.isArray(outline.points)
    ? outline.points.map((point) => ({
      x: Math.max(0, Math.min(width, Number(point?.x) || 0)),
      y: Math.max(0, Math.min(height, Number(point?.y) || 0)),
    }))
    : [];
  if (legacyLineRoad && points.length >= 2) {
    const start = points[0];
    const end = points[points.length - 1];
    points = [start, end, { x: end.x, y: Math.min(height, end.y + thickness) }, { x: start.x, y: Math.min(height, start.y + thickness) }];
  }
  const layer = outline.layer === "occlusion" ? "occlusion" : outline.layer === "rigid" ? "rigid" : "collision";
  const element = normalizeMapElement(outline.element, "fire");
  const normalized = {
    id: String(outline.id || `map_outline_${Date.now()}`),
    layer,
    element,
    shape: rectangleCollision ? "groundLine" : "polygon",
    collisionType: layer === "occlusion" ? "trigger" : outline.collisionType === "oneWay" ? "oneWay" : "solid",
    sideCollision: legacyLineRoad ? false : outline.sideCollision !== false,
    thickness,
    closed: outline.closed !== false,
    points,
    ...(layer === "rigid" && outline.rigidBody && typeof outline.rigidBody === "object"
      ? { rigidBody: outline.rigidBody }
      : layer === "rigid" && outline.iceBody && typeof outline.iceBody === "object"
        ? { iceBody: outline.iceBody }
        : {}),
  };
  if (layer === "rigid" && normalized.shape === "polygon" && normalized.closed) {
    if (!mapIceGeometry) throw new Error("程序刚体升级器尚未初始化");
    return assetTemplate
      ? mapIceGeometry.ensureProgramRigidAssetOutline(normalized)
      : mapIceGeometry.ensureProgramRigidOutline(normalized);
  }
  return normalized;
}

function normalizeMapOutlineList(outlines, width = Number.POSITIVE_INFINITY, height = Number.POSITIVE_INFINITY, assetTemplate = false) {
  return (Array.isArray(outlines) ? outlines : [])
    .map((outline) => normalizeMapOutlineData(outline, width, height, assetTemplate))
    .filter((outline) => outline.shape === "groundLine" ? outline.points.length >= 4 : outline.points.length >= 3);
}

function normalizeMapObjectData(item = {}) {
  const motion = item.motion || {};
  const { outlinePrecision: _legacyOutlinePrecision, ...normalizedItem } = item;
  return {
    ...normalizedItem,
    layer: ["decoration", "collision", "rigid", "occlusion"].includes(item.layer) ? item.layer : "decoration",
    elementTag: String(item.elementTag || normalizeMapElement(item.element, "fire")).trim() || "fire",
    mode: item.mode === "dynamic" ? "dynamic" : "static",
    collisionType: item.collisionType === "solid" ? "solid" : "oneWay",
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

function normalizeMatterStrokeData(stroke = {}, width = Number.POSITIVE_INFINITY, height = Number.POSITIVE_INFINITY) {
  const carrier = stroke.carrier === "gas" ? "gas" : "liquid";
  const legacyElement = normalizeMapElement(stroke.element, carrier === "gas" ? "wind" : "water");
  const elementTag = String(stroke.elementTag || legacyElement).trim() || legacyElement;
  return {
    id: String(stroke.id || `map_matter_${Date.now()}`),
    carrier,
    elementTag,
    profile: normalizeMatterProfileData(carrier, elementTag, stroke.profile),
    radius: Math.max(1, Math.min(256, Number(stroke.radius) || 12)),
    points: (Array.isArray(stroke.points) ? stroke.points : []).map((point) => ({
      x: Math.max(0, Math.min(width, Number(point?.x) || 0)),
      y: Math.max(0, Math.min(height, Number(point?.y) || 0)),
    })),
  };
}

function loadUnityMap(root, relativeJsonPath) {
  const jsonPath = resolveMapJson(root, relativeJsonPath);
  const dataRoot = path.dirname(jsonPath);
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  if (data.format === "frame-action-map") {
    const loadedAssets = (Array.isArray(data.assets) ? data.assets : [])
      .filter((entry) => entry?.usage !== "backgroundTile")
      .map((entry) => loadMapAsset(dataRoot, entry, entry.usage || "object", entry.defaultLayer || "decoration"))
      .filter(Boolean);
    if (data.backgroundSource) {
      const background = loadMapAsset(root, data.backgroundSource, "background", "decoration");
      if (background) loadedAssets.unshift(background);
    }
    const { assets, sync, backgroundTiles, backgroundSource, ...project } = data;
    return { project: { ...project, version: 2, objects: (project.objects || []).map(normalizeMapObjectData), outlines: normalizeMapOutlineList(project.outlines, project.width, project.height), matterStrokes: (project.matterStrokes || []).map((stroke) => normalizeMatterStrokeData(stroke, project.width, project.height)).filter((stroke) => stroke.points.length), draftOutlines: project.draftOutlines || [] }, assets: loadedAssets, syncedAt: sync?.syncedAt || null };
  }
  if (data.tool !== "2d-game-helper-map-editor") throw new Error("不是可识别的地图数据");

  const legacyAssets = Array.isArray(data.assets) ? data.assets : [];
  const legacyObjects = Array.isArray(data.objects) ? data.objects : [];
  const backgroundId = `map_background_${Buffer.from(String(data.background?.path || "background")).toString("hex").slice(0, 10)}`;
  const backgroundEntry = data.background ? { ...data.background, id: backgroundId } : null;
  const loadedAssets = [];
  const loadedBackground = loadMapAsset(dataRoot, backgroundEntry, "background", "decoration");
  if (loadedBackground) loadedAssets.push(loadedBackground);
  for (const entry of legacyAssets) {
    const firstObject = legacyObjects.find((item) => item?.assetId === entry.id);
    const loaded = loadMapAsset(dataRoot, entry, "object", firstObject?.layer || "decoration");
    if (loaded) loadedAssets.push(loaded);
  }
  const folderName = path.basename(dataRoot).replace(/_UnityMap$/i, "");
  const project = {
    format: "frame-action-map",
    version: 2,
    mapName: folderName || "地图",
    mapType: "side2d",
    width: Math.max(1, Number(data.width) || Number(data.background?.width) || 1024),
    height: Math.max(1, Number(data.height) || Number(data.background?.height) || 640),
    pixelsPerUnit: Math.max(1, Number(data.pixelsPerUnit) || 100),
    backgroundAssetId: loadedBackground ? backgroundId : "",
    unityPrefabPath: "",
    objects: legacyObjects.map((item) => normalizeMapObjectData({
      id: item.id || `map_object_${Date.now()}`,
      assetId: item.assetId || "",
      layer: ["decoration", "collision", "rigid", "occlusion"].includes(item.layer) ? item.layer : "decoration",
      element: normalizeMapElement(item.element, "fire"),
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      scale: Math.max(0.01, Number(item.scale) || 1),
      rotation: Number(item.rotation) || 0,
      z: Number(item.z) || 0,
    })),
    outlines: (Array.isArray(data.outlines) ? data.outlines : []).map((outline) => {
      const legacyLineRoad = outline.shape === "lineRoad" || outline.shape === "oneWayLine";
      const rectangleCollision = legacyLineRoad || outline.shape === "groundLine";
      const thickness = rectangleCollision ? Math.max(1, Number(outline.thickness) || 1) : Number(outline.thickness) || 0;
      let points = Array.isArray(outline.points) ? outline.points.map((point) => ({ x: Number(point.x) || 0, y: Number(point.y) || 0 })) : [];
      if (legacyLineRoad && points.length >= 2) {
        const start = points[0];
        const end = points[points.length - 1];
        points = [start, end, { x: end.x, y: end.y + thickness }, { x: start.x, y: start.y + thickness }];
      }
      return {
        id: outline.id || `map_outline_${Date.now()}`,
        layer: outline.layer === "occlusion" ? "occlusion" : outline.layer === "rigid" ? "rigid" : "collision",
        element: normalizeMapElement(outline.element, "fire"),
        shape: outline.shape === "groundLine" || legacyLineRoad ? "groundLine" : "polygon",
        collisionType: outline.layer === "occlusion" ? "trigger" : outline.collisionType === "oneWay" ? "oneWay" : "solid",
        sideCollision: legacyLineRoad ? false : outline.sideCollision !== false,
        thickness,
        closed: outline.closed !== false,
        points,
      };
    }),
    draftOutlines: [],
    matterStrokes: [],
  };
  return { project, assets: loadedAssets, syncedAt: fs.statSync(jsonPath).mtime.toISOString() };
}

function validateMapPrefabPath(value, slug, mapName) {
  const fallback = `Assets/FrameActionGenerated/Maps/${slug}/${safeName(mapName, "地图")}.prefab`;
  const resolved = String(value || fallback).trim().replace(/\\/g, "/");
  if (!resolved.startsWith("Assets/") || !resolved.toLowerCase().endsWith(".prefab") || resolved.includes("../")) {
    throw new Error("地图 Prefab 必须是 Assets 目录中的 .prefab 路径");
  }
  if (/^Assets\/FrameActionGenerated\/(Characters|Enemies)\//i.test(resolved)) throw new Error("地图模块不能绑定角色或敌人 Prefab");
  return resolved;
}

function backgroundSourceArchiveLocation(root, slug, asset) {
  const fileName = safeName(asset.name, `${safeName(asset.id, "background")}.png`);
  const relativePath = `FrameActionSource/Maps/${slug}/Background/${fileName}`.replace(/\\/g, "/");
  return { relativePath, fullPath: path.join(root, ...relativePath.split("/")) };
}

function reusableBackgroundBundle(dataRoot, previousData, asset, project) {
  const source = previousData?.backgroundSource;
  const tiles = Array.isArray(previousData?.backgroundTiles) ? previousData.backgroundTiles : [];
  if (!source || source.id !== asset.id || Number(source.width) !== Number(project.width) || Number(source.height) !== Number(project.height) || !tiles.length) return null;
  if (Number(asset.byteSize) > 0 && Number(source.byteSize) !== Number(asset.byteSize)) return null;
  const entriesById = new Map((Array.isArray(previousData.assets) ? previousData.assets : []).filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  const entries = [];
  let coveredPixels = 0;
  for (const tile of tiles) {
    const entry = entriesById.get(tile?.assetId);
    if (!entry?.path || entry.usage !== "backgroundTile") return null;
    const tilePath = path.resolve(dataRoot, entry.path);
    const relative = path.relative(dataRoot, tilePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(tilePath) || !fs.statSync(tilePath).isFile()) return null;
    const x = Number(tile.x);
    const y = Number(tile.y);
    const width = Number(tile.width);
    const height = Number(tile.height);
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > project.width || y + height > project.height) return null;
    coveredPixels += width * height;
    entries.push(entry);
  }
  if (coveredPixels !== Number(project.width) * Number(project.height)) return null;
  return { source, tiles, entries };
}

async function generateBackgroundTiles(sourcePath, dataRoot, asset, project) {
  const metadata = await sharp(sourcePath, { limitInputPixels: false }).metadata();
  if (Number(metadata.width) !== Number(project.width) || Number(metadata.height) !== Number(project.height)) {
    throw new Error(`地图背景尺寸不一致：资源为 ${metadata.width}×${metadata.height}，地图为 ${project.width}×${project.height}`);
  }

  const tileParent = path.join(dataRoot, "BackgroundTiles");
  const tileFolderName = safeName(asset.id, "background");
  const targetFolder = path.join(tileParent, tileFolderName);
  const buildId = crypto.randomUUID();
  const tempBase = path.join(tileParent, `.building-${buildId}`);
  const tempFiles = `${tempBase}_files`;
  const tempLevel = path.join(tempFiles, "0");
  const descriptor = `${tempBase}.dzi`;
  fs.mkdirSync(tileParent, { recursive: true });
  try {
    await sharp(sourcePath, { limitInputPixels: false, sequentialRead: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
      .tile({ size: MAP_BACKGROUND_TILE_SIZE, overlap: 0, depth: "one", layout: "dz", container: "fs" })
      .toFile(`${tempBase}.dz`);
    if (!fs.existsSync(tempLevel)) throw new Error("地图背景切片输出不完整");
    if (fs.existsSync(targetFolder)) fs.rmSync(targetFolder, { recursive: true, force: true });
    fs.renameSync(tempLevel, targetFolder);
  } finally {
    if (fs.existsSync(tempFiles)) fs.rmSync(tempFiles, { recursive: true, force: true });
    if (fs.existsSync(descriptor)) fs.rmSync(descriptor, { force: true });
  }

  const tiles = [];
  const entries = [];
  const columns = Math.ceil(project.width / MAP_BACKGROUND_TILE_SIZE);
  const rows = Math.ceil(project.height / MAP_BACKGROUND_TILE_SIZE);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const width = Math.min(MAP_BACKGROUND_TILE_SIZE, project.width - column * MAP_BACKGROUND_TILE_SIZE);
      const height = Math.min(MAP_BACKGROUND_TILE_SIZE, project.height - row * MAP_BACKGROUND_TILE_SIZE);
      const fileName = `${column}_${row}.png`;
      const tilePath = path.join(targetFolder, fileName);
      if (!fs.existsSync(tilePath)) throw new Error(`地图背景切片缺失：${fileName}`);
      const assetId = `${asset.id}__tile_${column}_${row}`;
      const relativePath = path.relative(dataRoot, tilePath).replace(/\\/g, "/");
      tiles.push({ assetId, x: column * MAP_BACKGROUND_TILE_SIZE, y: row * MAP_BACKGROUND_TILE_SIZE, width, height });
      entries.push({
        id: assetId,
        name: `${asset.name || "Background"} ${column + 1}-${row + 1}`,
        kind: "image",
        usage: "backgroundTile",
        defaultLayer: "decoration",
        width,
        height,
        path: relativePath,
      });
    }
  }
  return { tiles, entries };
}

function archiveBackgroundSource(root, slug, asset, sourcePath) {
  const archive = backgroundSourceArchiveLocation(root, slug, asset);
  fs.mkdirSync(path.dirname(archive.fullPath), { recursive: true });
  if (path.resolve(sourcePath) !== path.resolve(archive.fullPath)) {
    if (fs.existsSync(archive.fullPath)) fs.rmSync(archive.fullPath, { force: true });
    fs.renameSync(sourcePath, archive.fullPath);
    if (fs.existsSync(`${sourcePath}.meta`)) fs.rmSync(`${sourcePath}.meta`, { force: true });
  }
  return archive;
}

async function syncMap(root, payload) {
  const project = payload.project;
  if (!project || project.format !== "frame-action-map") throw new Error("地图数据格式无效");
  project.version = 2;
  project.objects = (Array.isArray(project.objects) ? project.objects : []).map(normalizeMapObjectData);
  project.outlines = normalizeMapOutlineList(project.outlines, Math.max(1, Number(project.width) || 1), Math.max(1, Number(project.height) || 1));
  project.matterStrokes = (Array.isArray(project.matterStrokes) ? project.matterStrokes : [])
    .map((stroke) => normalizeMatterStrokeData(stroke, Math.max(1, Number(project.width) || 1), Math.max(1, Number(project.height) || 1)))
    .filter((stroke) => stroke.points.length);
  project.mapName = String(project.mapName || "").trim();
  if (!project.mapName) throw new Error("地图名称不能为空");
  const targetMap = findUnityMapByJsonPath(root, payload.targetJsonPath);
  const sameNameMap = findUnityMapOverwrite(root, project.mapName);
  if (targetMap && sameNameMap && sameNameMap.jsonPath !== targetMap.jsonPath) {
    const error = new Error(`另一个已同步地图正在使用名称“${project.mapName}”。请换一个名称后再更新当前地图。`);
    error.statusCode = 409;
    throw error;
  }
  const overwriteMap = !targetMap ? sameNameMap : null;
  const orphanPrefab = !targetMap && !overwriteMap ? findMapPrefabOverwrite(root, project.mapName, project.unityPrefabPath || payload.overwritePrefabPath) : null;
  if ((overwriteMap || orphanPrefab) && payload.confirmOverwrite !== true) {
    const targetLabel = overwriteMap ? `已同步地图“${overwriteMap.mapName}”` : `缺少源数据的地图 Prefab“${orphanPrefab.mapName}”`;
    const error = new Error(`Unity 项目中已存在${targetLabel}。确认覆盖后才会写入地图数据和 Prefab。`);
    error.statusCode = 409;
    throw error;
  }
  const existingMap = targetMap || overwriteMap;
  const generatedOverwrite = /^Assets\/FrameActionGenerated\/Maps\/([^/]+)\//i.exec(String(orphanPrefab?.path || payload.overwritePrefabPath || "").replace(/\\/g, "/"));
  const slug = existingMap
    ? path.basename(path.dirname(path.resolve(root, existingMap.jsonPath)))
    : generatedOverwrite?.[1] || mapSlug(project.mapName);
  const dataRoot = existingMap ? path.dirname(path.resolve(root, existingMap.jsonPath)) : path.join(root, "Assets", "FrameActionData", "Maps", slug);
  const jsonPath = existingMap ? path.resolve(root, existingMap.jsonPath) : path.join(dataRoot, `${slug}.frame-action-map.json`);
  const configuredPrefabPath = project.unityPrefabPath || existingMap?.prefabPath || orphanPrefab?.path || "";
  let prefabPath = validateMapPrefabPath(configuredPrefabPath, slug, project.mapName);
  let prefabPathAdjustedFrom = "";
  if (!existingMap && !orphanPrefab) {
    const generatedMatch = /^Assets\/FrameActionGenerated\/Maps\/([^/]+)\//i.exec(prefabPath);
    if (generatedMatch && generatedMatch[1] !== slug) {
      prefabPathAdjustedFrom = prefabPath;
      prefabPath = validateMapPrefabPath("", slug, project.mapName);
    }
  }
  const currentJsonPath = path.relative(root, jsonPath).replace(/\\/g, "/");
  const prefabOwners = listUnityMaps(root).filter((item) => item.jsonPath !== currentJsonPath && item.prefabPath === prefabPath);
  if (prefabOwners.length) {
    const error = new Error(`目标地图 Prefab 已由“${prefabOwners.map((item) => item.mapName).join("、")}”使用。请选择独立 Prefab，或清空同步目标后重新同步。`);
    error.statusCode = 409;
    throw error;
  }
  const sourceAssets = Array.isArray(payload.assets) ? payload.assets : [];
  const objectIds = new Set((Array.isArray(project.objects) ? project.objects.map((item) => item.assetId) : []).filter(Boolean));
  let previousData = {};
  if (fs.existsSync(jsonPath)) {
    try { previousData = JSON.parse(fs.readFileSync(jsonPath, "utf8")); } catch { previousData = {}; }
  }
  const previousAssets = Array.isArray(previousData.assets) ? previousData.assets : [];
  const manifestById = new Map(previousAssets.filter((asset) => asset?.id).map((asset) => [asset.id, asset]));
  let changedFiles = 0;
  for (const asset of sourceAssets) {
    if (!asset?.id || asset.id === project.backgroundAssetId || !objectIds.has(asset.id)) continue;
    const { relativePath, targetPath } = mapAssetLocation(root, project.mapName, asset, slug);
    if (asset.dataUrl && writeIfChanged(targetPath, decodeDataUrl(asset.dataUrl))) changedFiles += 1;
    if (!fs.existsSync(targetPath)) throw new Error(`地图资源尚未上传：${asset.name || asset.id}`);
    const assetWidth = Math.max(1, Number(asset.width) || 1);
    const assetHeight = Math.max(1, Number(asset.height) || 1);
    manifestById.set(asset.id, {
      id: asset.id,
      name: asset.name,
      kind: "image",
      usage: asset.usage || "object",
      defaultLayer: asset.defaultLayer || "decoration",
      width: assetWidth,
      height: assetHeight,
      path: relativePath,
      outlines: normalizeMapOutlineList(asset.outlines, assetWidth, assetHeight, true),
    });
  }

  const backgroundAsset = sourceAssets.find((asset) => asset?.id === project.backgroundAssetId);
  if (!backgroundAsset) throw new Error("地图背景资源数据缺失");
  const reusable = reusableBackgroundBundle(dataRoot, previousData, backgroundAsset, project);
  let backgroundTiles;
  let tileEntries;
  let sourcePath;
  let sourceByteSize;
  if (reusable) {
    backgroundTiles = reusable.tiles;
    tileEntries = reusable.entries;
    sourcePath = path.resolve(root, reusable.source.path);
    sourceByteSize = Number(reusable.source.byteSize);
  } else {
    const uploadLocation = mapAssetLocation(root, project.mapName, backgroundAsset, slug);
    const archived = backgroundSourceArchiveLocation(root, slug, backgroundAsset);
    sourcePath = fs.existsSync(uploadLocation.targetPath) ? uploadLocation.targetPath : archived.fullPath;
    if (backgroundAsset.dataUrl && !fs.existsSync(sourcePath)) {
      writeIfChanged(uploadLocation.targetPath, decodeDataUrl(backgroundAsset.dataUrl));
      sourcePath = uploadLocation.targetPath;
      changedFiles += 1;
    }
    if (!fs.existsSync(sourcePath)) throw new Error(`地图背景资源尚未上传：${backgroundAsset.name || backgroundAsset.id}`);
    sourceByteSize = Number(backgroundAsset.byteSize) || fs.statSync(sourcePath).size;
    const generated = await generateBackgroundTiles(sourcePath, dataRoot, backgroundAsset, project);
    backgroundTiles = generated.tiles;
    tileEntries = generated.entries;
    changedFiles += tileEntries.length;
  }

  for (const entry of tileEntries) manifestById.set(entry.id, entry);
  manifestById.delete(project.backgroundAssetId);
  const tileIds = new Set(backgroundTiles.map((tile) => tile.assetId));
  const manifestAssets = Array.from(manifestById.values()).filter((asset) => objectIds.has(asset.id) || tileIds.has(asset.id));
  const archivedSource = archiveBackgroundSource(root, slug, backgroundAsset, sourcePath);
  const { draftOutlines, backgroundTiles: _clientTiles, backgroundSource: _clientSource, ...persistedProject } = project;
  const materialized = {
    ...persistedProject,
    unityPrefabPath: prefabPath,
    backgroundSource: {
      id: backgroundAsset.id,
      name: backgroundAsset.name,
      path: archivedSource.relativePath,
      usage: "background",
      defaultLayer: "decoration",
      width: project.width,
      height: project.height,
      byteSize: sourceByteSize,
    },
    backgroundTiles,
    assets: manifestAssets,
    sync: { tool: "sprite-cue-studio", runtimePackage: "com.frame-action.runtime", syncedAt: new Date().toISOString() },
  };
  if (writeIfChanged(jsonPath, `${JSON.stringify(materialized, null, 2)}\n`)) changedFiles += 1;
  return {
    mapName: project.mapName,
    slug,
    changedFiles,
    assetCount: manifestAssets.length,
    backgroundTileCount: backgroundTiles.length,
    objectCount: Array.isArray(project.objects) ? project.objects.length : 0,
    outlineCount: Array.isArray(project.outlines) ? project.outlines.length : 0,
    assetOutlineCount: manifestAssets.reduce((total, asset) => total + (Array.isArray(asset.outlines) ? asset.outlines.length : 0), 0),
    jsonPath: path.relative(root, jsonPath).replace(/\\/g, "/"),
    prefabPath,
    prefabPathAdjustedFrom,
    updatedExisting: Boolean(existingMap || orphanPrefab),
  };
}

function removeUnityMap(root, relativeJsonPath) {
  const mapsRoot = path.resolve(root, "Assets", "FrameActionData", "Maps");
  const jsonPath = path.resolve(root, String(relativeJsonPath || ""));
  const dataFolder = path.dirname(jsonPath);
  const relative = path.relative(mapsRoot, jsonPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.dirname(dataFolder) !== mapsRoot || !jsonPath.toLowerCase().endsWith(".frame-action-map.json")) {
    throw new Error("只能删除由本工具管理的独立地图同步目录");
  }
  if (!fs.existsSync(jsonPath) || !fs.statSync(jsonPath).isFile()) throw new Error("地图数据文件不存在，可能已被删除");
  const materialized = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  if (materialized.format !== "frame-action-map") throw new Error("地图数据格式无效，已停止删除");

  const slug = path.basename(dataFolder);
  const prefabPath = String(materialized.unityPrefabPath || "").trim().replace(/\\/g, "/");
  const generatedMatch = /^Assets\/FrameActionGenerated\/Maps\/([^/]+)\//i.exec(prefabPath);
  const generatedRoot = path.resolve(root, "Assets", "FrameActionGenerated", "Maps");
  const generatedFolder = generatedMatch ? path.resolve(generatedRoot, generatedMatch[1]) : "";
  if (generatedFolder && path.dirname(generatedFolder) !== generatedRoot) throw new Error("地图生成目录校验失败，已停止删除");
  const normalizedJsonPath = path.relative(root, jsonPath).replace(/\\/g, "/");
  const remainingMaps = listUnityMaps(root).filter((item) => item.jsonPath !== normalizedJsonPath);
  const sharedPrefabReferences = prefabPath ? remainingMaps.filter((item) => item.prefabPath === prefabPath) : [];
  const generatedFolderPrefix = generatedMatch ? `Assets/FrameActionGenerated/Maps/${generatedMatch[1]}/` : "";
  const generatedFolderReferences = generatedFolderPrefix ? remainingMaps.filter((item) => item.prefabPath.startsWith(generatedFolderPrefix)) : [];
  const preserveGeneratedFolder = generatedFolderReferences.length > 0;
  const sourceRoot = path.resolve(root, "FrameActionSource", "Maps");
  const sourceFolder = path.resolve(sourceRoot, slug);
  if (path.dirname(sourceFolder) !== sourceRoot) throw new Error("地图源文件目录校验失败，已停止删除");
  const deletedPaths = [];
  const deleteTargets = [dataFolder, sourceFolder];
  if (generatedFolder && !preserveGeneratedFolder) deleteTargets.push(generatedFolder);
  for (const target of deleteTargets) {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      deletedPaths.push(path.relative(root, target).replace(/\\/g, "/"));
    }
    const metaPath = `${target}.meta`;
    if (fs.existsSync(metaPath) && fs.statSync(metaPath).isFile()) fs.rmSync(metaPath, { force: true });
  }

  const replacementMap = sharedPrefabReferences[0] || null;
  if (replacementMap) {
    const replacementJsonPath = path.resolve(root, replacementMap.jsonPath);
    if (fs.existsSync(replacementJsonPath)) {
      const now = new Date();
      fs.utimesSync(replacementJsonPath, now, now);
    }
  }
  return {
    mapName: materialized.mapName || slug,
    slug,
    deletedPaths,
    deletedPrefabPath: generatedFolder && !preserveGeneratedFolder ? prefabPath : "",
    preservedPrefabPath: prefabPath && (!generatedFolder || preserveGeneratedFolder) ? prefabPath : "",
    preservedGeneratedPath: preserveGeneratedFolder ? generatedFolderPrefix.replace(/\/$/, "") : "",
    sharedPrefabReferenceCount: sharedPrefabReferences.length,
    replacementMap: replacementMap ? { mapName: replacementMap.mapName, jsonPath: replacementMap.jsonPath } : null,
  };
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  }[ext] || "application/octet-stream";
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, { ok: true, version: "0.35.0" });
    }
    if (req.method === "GET" && url.pathname === "/api/unity/actor-asset") {
      const root = validateUnityProject(url.searchParams.get("projectPath"));
      const { assetPath, kind } = resolveUnityActorAsset(root, url.searchParams.get("jsonPath"), url.searchParams.get("assetId"));
      const contents = fs.readFileSync(assetPath);
      res.writeHead(200, {
        "Content-Type": fileMimeType(assetPath, kind),
        "Content-Length": contents.length,
        "Cache-Control": "no-cache",
      });
      return res.end(contents);
    }
    if (req.method === "POST" && url.pathname === "/api/unity/check") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, projectPath: root, runtime: runtimeStatus(root) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/properties") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, ...readUnityPropertyCatalog(root) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/sync") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      const runtime = requireCompatibleRuntime(root);
      return sendJson(res, 200, { ok: true, runtime, result: syncCharacter(root, body) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/sync-enemy") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      const runtime = requireCompatibleRuntime(root);
      return sendJson(res, 200, { ok: true, runtime, result: syncCharacter(root, body, "enemy") });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/actor-sync/start") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, result: startActorSyncUpload(root, body) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/actor-sync/chunk") {
      const uploadId = String(req.headers["x-frame-action-upload-id"] || "");
      const assetId = decodeURIComponent(String(req.headers["x-frame-action-asset-id"] || ""));
      const offset = Number(req.headers["x-frame-action-upload-offset"]);
      const chunk = await readRawBody(req, ACTOR_ASSET_CHUNK_LIMIT, "单个角色资源分块超过 8MB 限制");
      return sendJson(res, 200, { ok: true, result: appendActorSyncUpload(uploadId, assetId, offset, chunk) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/actor-sync/finish") {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, ...finishActorSyncUpload(String(body.uploadId || "")) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/actor-sync/cancel") {
      const body = await readBody(req);
      removeActorSyncUpload(String(body.uploadId || ""));
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/characters") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, characters: listUnityCharacters(root) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/enemies") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, characters: listUnityEnemies(root) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/check-enemy-overwrite") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, existing: findUnityEnemyOverwrite(root, body.characterName) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/check-character-overwrite") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, existing: findUnityCharacterOverwrite(root, body.characterName) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/load-character") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, ...loadUnityCharacter(root, body.jsonPath) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/load-enemy") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, ...loadUnityEnemy(root, body.jsonPath) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/delete-enemy") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, result: removeUnityEnemy(root, body.jsonPath) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/delete-character") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, result: removeUnityCharacter(root, body.jsonPath) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/map-prefabs") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, prefabs: listMapPrefabs(root) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/maps") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, maps: listUnityMaps(root) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/check-map-overwrite") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, existing: checkMapOverwrite(root, body) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/load-map") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, ...loadUnityMap(root, body.jsonPath) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/delete-map") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      return sendJson(res, 200, { ok: true, result: removeUnityMap(root, body.jsonPath) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/map-asset-upload/start") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      requireCompatibleRuntime(root);
      return sendJson(res, 200, { ok: true, result: startMapAssetUpload(root, body) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/map-asset-upload/chunk") {
      const uploadId = String(req.headers["x-frame-action-upload-id"] || "");
      const offset = Number(req.headers["x-frame-action-upload-offset"]);
      const chunk = await readRawBody(req, MAP_ASSET_CHUNK_LIMIT, "单个地图资源分块超过 8MB 限制");
      return sendJson(res, 200, { ok: true, result: appendMapAssetUpload(uploadId, offset, chunk) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/map-asset-upload/finish") {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, result: finishMapAssetUpload(String(body.uploadId || "")) });
    }
    if (req.method === "POST" && url.pathname === "/api/unity/sync-map") {
      const body = await readBody(req);
      const root = validateUnityProject(body.projectPath);
      const runtime = requireCompatibleRuntime(root);
      return sendJson(res, 200, { ok: true, runtime, result: await syncMap(root, body) });
    }

    if (url.pathname.startsWith("/api/")) {
      return sendJson(res, 404, { ok: false, code: "api_not_found", message: "接口不存在" });
    }

    if (!fs.existsSync(DIST)) return sendJson(res, 503, { ok: false, message: "dist 不存在，请先运行 npm run build" });
    let relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    let filePath = path.resolve(DIST, `.${relative}`);
    if (!filePath.startsWith(DIST)) return sendJson(res, 403, { ok: false, message: "Forbidden" });
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(DIST, "index.html");
    const contents = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600" });
    res.end(contents);
  } catch (error) {
    sendJson(res, Number(error.statusCode) || 400, {
      ok: false,
      ...(error.code ? { code: error.code } : {}),
      message: error.message || "请求失败",
    });
  }
});

async function startServer() {
  mapIceGeometry = await import(pathToFileURL(path.join(ROOT, "src", "mapIceGeometry.ts")).href);
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`SpriteCue Studio running at http://127.0.0.1:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("SpriteCue Studio failed to initialize", error);
  process.exitCode = 1;
});
