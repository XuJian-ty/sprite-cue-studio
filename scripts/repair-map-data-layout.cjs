const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(process.argv[2] || "");
const apply = process.argv.includes("--apply");
if (!projectRoot || !fs.existsSync(path.join(projectRoot, "Assets"))) {
  throw new Error("请传入有效的 Unity 项目根目录");
}

const mainSlug = "map-e4b8bbe59f8e";
const wolfSlug = "map-e78bbce5a696";
const mapsRoot = path.join(projectRoot, "Assets", "FrameActionData", "Maps");
const generatedRoot = path.join(projectRoot, "Assets", "FrameActionGenerated", "Maps");
const sourceRoot = path.join(projectRoot, "FrameActionSource", "Maps");
const mainDataRoot = path.join(mapsRoot, mainSlug);
const wolfDataRoot = path.join(mapsRoot, wolfSlug);
const oldJsonPath = path.join(mainDataRoot, `${mainSlug}.frame-action-map.json`);
const wolfJsonPath = path.join(wolfDataRoot, `${wolfSlug}.frame-action-map.json`);
const mainJsonPath = path.join(mainDataRoot, `${mainSlug}.frame-action-map.json`);
const mainPrefabPath = path.join(generatedRoot, mainSlug, "主城地图.prefab");
const mainSourcePath = path.join(sourceRoot, mainSlug, "Background", "主城地图.png");
const misplacedWolfSourcePath = path.join(sourceRoot, mainSlug, "Background", "狼妖地图.png");
const wolfSourcePath = path.join(sourceRoot, wolfSlug, "Background", "狼妖地图.png");

function pngSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") throw new Error(`不是有效的 PNG：${filePath}`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function copyTree(source, target) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(target, name));
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function ensureUnityMeta(targetPath, folderAsset = false) {
  const metaPath = `${targetPath}.meta`;
  if (fs.existsSync(metaPath)) {
    const existing = fs.readFileSync(metaPath, "utf8");
    const guid = /^guid:\s*([a-f0-9]{32})$/mi.exec(existing)?.[1];
    if (guid) return guid;
  }
  const guid = require("crypto").randomBytes(16).toString("hex");
  const importer = folderAsset ? "folderAsset: yes\nDefaultImporter:" : "TextScriptImporter:";
  fs.writeFileSync(metaPath, `fileFormatVersion: 2\nguid: ${guid}\n${importer}\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`);
  return guid;
}

function round(value) {
  const normalized = Math.round(value * 1e6) / 1e6;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function yamlDocuments(contents) {
  const documents = new Map();
  const headers = [...contents.matchAll(/^--- !u!(\d+) &(-?\d+)\r?$/gm)];
  for (let index = 0; index < headers.length; index += 1) {
    const match = headers[index];
    const bodyStart = match.index + match[0].length;
    const bodyEnd = headers[index + 1]?.index ?? contents.length;
    documents.set(match[2], { classId: Number(match[1]), body: contents.slice(bodyStart, bodyEnd) });
  }
  return documents;
}

function componentIds(body) {
  return [...body.matchAll(/component: \{fileID: (-?\d+)\}/g)].map((match) => match[1]);
}

function colliderPoints(body) {
  return [...body.matchAll(/^\s*-\s*(?:-\s*)?\{x:\s*([-+\d.eE]+),\s*y:\s*([-+\d.eE]+)\}/gm)]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
}

function recoverMainOutlines(prefabPath, width, height, pixelsPerUnit) {
  const documents = yamlDocuments(fs.readFileSync(prefabPath, "utf8"));
  const rectangles = [];
  for (const [gameObjectId, document] of documents) {
    if (document.classId !== 1) continue;
    const nameMatch = /^  m_Name: rectangle_collision_(\d+)\r?$/m.exec(document.body);
    if (!nameMatch) continue;
    const components = componentIds(document.body).map((id) => documents.get(id)).filter(Boolean);
    const polygon = components.find((item) => item.classId === 60);
    const edges = components.filter((item) => item.classId === 68);
    let worldPoints = polygon ? colliderPoints(polygon.body) : [];
    let collisionType = "solid";
    let sideCollision = Boolean(polygon);
    let thickness = 5;
    if (!polygon) {
      if (!edges.length) throw new Error(`主城碰撞 ${nameMatch[1]} 缺少 Collider2D`);
      const edgeData = edges.map((edge) => ({
        points: colliderPoints(edge.body),
        oneWay: /^  m_UsedByEffector: 1$/m.test(edge.body),
      })).filter((edge) => edge.points.length >= 2);
      collisionType = edgeData.some((edge) => edge.oneWay) ? "oneWay" : "solid";
      sideCollision = collisionType === "oneWay" ? edgeData.length > 1 : edgeData.length > 2;
      const top = (edgeData.find((edge) => edge.oneWay) || [...edgeData].sort((left, right) => {
        const leftY = (left.points[0].y + left.points[1].y) / 2;
        const rightY = (right.points[0].y + right.points[1].y) / 2;
        return rightY - leftY;
      })[0]);
      if (!top) throw new Error(`主城碰撞 ${nameMatch[1]} 无法恢复顶边`);
      worldPoints = top.points.slice(0, 2);
    }
    const topPoints = worldPoints.slice(0, 2).map((point) => ({
      x: round(point.x * pixelsPerUnit),
      y: round(height - point.y * pixelsPerUnit),
    }));
    let points;
    if (polygon && worldPoints.length >= 4) {
      points = worldPoints.slice(0, 4).map((point) => ({
        x: round(point.x * pixelsPerUnit),
        y: round(height - point.y * pixelsPerUnit),
      }));
      thickness = round(Math.abs(points[3].y - points[0].y));
    } else {
      points = [topPoints[0], topPoints[1], { x: topPoints[1].x, y: round(topPoints[1].y + thickness) }, { x: topPoints[0].x, y: round(topPoints[0].y + thickness) }];
    }
    rectangles.push({
      order: Number(nameMatch[1]),
      outline: {
        id: `map_outline_recovered_main_${String(nameMatch[1]).padStart(2, "0")}`,
        layer: "collision",
        shape: "groundLine",
        collisionType,
        sideCollision,
        thickness,
        closed: true,
        points,
      },
      gameObjectId,
    });
  }
  rectangles.sort((left, right) => left.order - right.order);
  if (rectangles.length !== 32) throw new Error(`预计恢复 32 条主城碰撞，实际得到 ${rectangles.length} 条`);
  return rectangles.map((item) => item.outline);
}

function backgroundBundle(dataRoot, assetId, sourceName, width, height) {
  const tileRoot = path.join(dataRoot, "BackgroundTiles", assetId);
  const tileFiles = fs.readdirSync(tileRoot)
    .filter((name) => /^\d+_\d+\.png$/i.test(name))
    .sort((left, right) => {
      const [leftColumn, leftRow] = left.split(/[_.]/).map(Number);
      const [rightColumn, rightRow] = right.split(/[_.]/).map(Number);
      return leftRow - rightRow || leftColumn - rightColumn;
    });
  const tiles = [];
  const assets = [];
  for (const fileName of tileFiles) {
    const [column, row] = fileName.split(/[_.]/).map(Number);
    const dimensions = pngSize(path.join(tileRoot, fileName));
    const tileAssetId = `${assetId}__tile_${column}_${row}`;
    tiles.push({ assetId: tileAssetId, x: column * 4096, y: row * 4096, width: dimensions.width, height: dimensions.height });
    assets.push({
      id: tileAssetId,
      name: `${sourceName} ${column + 1}-${row + 1}`,
      kind: "image",
      usage: "backgroundTile",
      defaultLayer: "decoration",
      width: dimensions.width,
      height: dimensions.height,
      path: `BackgroundTiles/${assetId}/${fileName}`,
    });
  }
  const coveredPixels = tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0);
  if (!tiles.length || coveredPixels !== width * height) throw new Error(`背景切片覆盖不完整：${assetId}`);
  return { tiles, assets };
}

if (!fs.existsSync(oldJsonPath) || !fs.existsSync(mainPrefabPath) || !fs.existsSync(mainSourcePath) || !fs.existsSync(misplacedWolfSourcePath)) {
  throw new Error("当前 Unity 项目状态与预期不符，已停止迁移");
}
const wolfData = JSON.parse(fs.readFileSync(oldJsonPath, "utf8"));
if (wolfData.mapName !== "狼妖地图" || !wolfData.backgroundAssetId) throw new Error("原数据目录中的狼妖地图 JSON 无法识别");
const mainDimensions = pngSize(mainSourcePath);
const mainAssetId = "map_asset_4pww0e_mrnc07qb";
const mainBackground = backgroundBundle(mainDataRoot, mainAssetId, "主城地图.png", mainDimensions.width, mainDimensions.height);
const mainOutlines = recoverMainOutlines(mainPrefabPath, mainDimensions.width, mainDimensions.height, 50);
const wolfTileFolder = path.join(mainDataRoot, "BackgroundTiles", wolfData.backgroundAssetId);
if (!fs.existsSync(wolfTileFolder)) throw new Error("狼妖地图背景切片目录不存在");

const report = {
  projectRoot,
  apply,
  main: {
    width: mainDimensions.width,
    height: mainDimensions.height,
    backgroundTiles: mainBackground.tiles.length,
    outlines: mainOutlines.length,
    solidOutlines: mainOutlines.filter((outline) => outline.collisionType === "solid").length,
    oneWayOutlines: mainOutlines.filter((outline) => outline.collisionType === "oneWay").length,
  },
  wolf: { width: wolfData.width, height: wolfData.height, backgroundTiles: wolfData.backgroundTiles?.length || 0, outlines: wolfData.outlines?.length || 0 },
};
if (!apply) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}
if (fs.existsSync(wolfDataRoot) || fs.existsSync(wolfJsonPath)) throw new Error("狼妖地图目标数据目录已存在，已停止以避免覆盖");

const backupRoot = path.join(projectRoot, "FrameActionMigrationBackup", `map-layout-repair-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(backupRoot, { recursive: true });
copyTree(mainDataRoot, path.join(backupRoot, "Assets", "FrameActionData", "Maps", mainSlug));
copyTree(path.join(sourceRoot, mainSlug), path.join(backupRoot, "FrameActionSource", "Maps", mainSlug));
fs.copyFileSync(mainPrefabPath, path.join(backupRoot, "主城地图.prefab"));

fs.mkdirSync(path.join(wolfDataRoot, "BackgroundTiles"), { recursive: true });
fs.renameSync(wolfTileFolder, path.join(wolfDataRoot, "BackgroundTiles", wolfData.backgroundAssetId));
if (fs.existsSync(`${wolfTileFolder}.meta`)) fs.renameSync(`${wolfTileFolder}.meta`, path.join(wolfDataRoot, "BackgroundTiles", `${wolfData.backgroundAssetId}.meta`));
fs.renameSync(oldJsonPath, wolfJsonPath);
if (fs.existsSync(`${oldJsonPath}.meta`)) fs.renameSync(`${oldJsonPath}.meta`, `${wolfJsonPath}.meta`);
fs.mkdirSync(path.dirname(wolfSourcePath), { recursive: true });
fs.renameSync(misplacedWolfSourcePath, wolfSourcePath);

wolfData.backgroundSource.path = `FrameActionSource/Maps/${wolfSlug}/Background/狼妖地图.png`;
wolfData.sync = { ...(wolfData.sync || {}), syncedAt: new Date().toISOString() };
fs.writeFileSync(wolfJsonPath, `${JSON.stringify(wolfData, null, 2)}\n`);

const mainData = {
  format: "frame-action-map",
  version: 1,
  mapName: "主城地图",
  mapType: "side2d",
  width: mainDimensions.width,
  height: mainDimensions.height,
  pixelsPerUnit: 50,
  backgroundAssetId: mainAssetId,
  unityPrefabPath: `Assets/FrameActionGenerated/Maps/${mainSlug}/主城地图.prefab`,
  objects: [],
  outlines: mainOutlines,
  backgroundSource: {
    id: mainAssetId,
    name: "主城地图.png",
    path: `FrameActionSource/Maps/${mainSlug}/Background/主城地图.png`,
    usage: "background",
    defaultLayer: "decoration",
    width: mainDimensions.width,
    height: mainDimensions.height,
    byteSize: fs.statSync(mainSourcePath).size,
  },
  backgroundTiles: mainBackground.tiles,
  assets: mainBackground.assets,
  sync: { tool: "sprite-cue-studio", runtimePackage: "com.frame-action.runtime", syncedAt: new Date().toISOString() },
};
fs.writeFileSync(mainJsonPath, `${JSON.stringify(mainData, null, 2)}\n`);
ensureUnityMeta(wolfDataRoot, true);
ensureUnityMeta(path.join(wolfDataRoot, "BackgroundTiles"), true);
const mainJsonGuid = ensureUnityMeta(mainJsonPath);
const mainPrefab = fs.readFileSync(mainPrefabPath, "utf8").replace(/sourceJson: \{fileID: [^}]*\}/, `sourceJson: {fileID: 4900000, guid: ${mainJsonGuid}, type: 3}`);
fs.writeFileSync(mainPrefabPath, mainPrefab);

report.backupRoot = backupRoot;
report.main.jsonPath = path.relative(projectRoot, mainJsonPath).replace(/\\/g, "/");
report.wolf.jsonPath = path.relative(projectRoot, wolfJsonPath).replace(/\\/g, "/");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
