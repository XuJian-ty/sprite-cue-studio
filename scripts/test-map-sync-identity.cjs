const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");

const baseUrl = process.argv[2] || "http://127.0.0.1:5188";
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frame-action-map-identity-"));
let pngDataUrl = "";
let byteSize = 0;

async function post(route, body, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (response.status !== expectedStatus) throw new Error(`${route} 返回 ${response.status}：${result.message || JSON.stringify(result)}`);
  return result;
}

function mapProject(mapName, prefabPath = "") {
  return {
    format: "frame-action-map",
    version: 1,
    mapName,
    mapType: "side2d",
    width: 16,
    height: 16,
    pixelsPerUnit: 100,
    backgroundAssetId: "background",
    unityPrefabPath: prefabPath,
    objects: [],
    outlines: [],
    draftOutlines: [],
  };
}

function backgroundAsset() {
  return {
    id: "background",
    name: "background.png",
    kind: "image",
    usage: "background",
    defaultLayer: "decoration",
    width: 16,
    height: 16,
    byteSize,
    dataUrl: pngDataUrl,
  };
}

(async () => {
  try {
    const pngBuffer = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 20, g: 120, b: 90, alpha: 1 } } }).png().toBuffer();
    pngDataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
    byteSize = pngBuffer.length;
    fs.mkdirSync(path.join(testRoot, "Assets"), { recursive: true });
    fs.mkdirSync(path.join(testRoot, "Packages"), { recursive: true });
    fs.mkdirSync(path.join(testRoot, "ProjectSettings"), { recursive: true });
    fs.writeFileSync(path.join(testRoot, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.0f1\n");
    await post("/api/unity/install-runtime", { projectPath: testRoot });

    const first = await post("/api/unity/sync-map", { projectPath: testRoot, project: mapProject("地图甲"), assets: [backgroundAsset()] });
    await post("/api/unity/sync-map", { projectPath: testRoot, project: mapProject("地图甲"), assets: [backgroundAsset()] }, 409);
    const overwritten = await post("/api/unity/sync-map", { projectPath: testRoot, project: mapProject("地图甲"), assets: [backgroundAsset()], confirmOverwrite: true });
    if (overwritten.result.jsonPath !== first.result.jsonPath) throw new Error("同名覆盖创建了新的地图身份");

    const second = await post("/api/unity/sync-map", { projectPath: testRoot, project: mapProject("地图乙"), assets: [backgroundAsset()] });
    if (second.result.jsonPath === first.result.jsonPath) throw new Error("不同名地图复用了同一身份");

    const renamed = await post("/api/unity/sync-map", {
      projectPath: testRoot,
      project: mapProject("地图甲改名", first.result.prefabPath),
      assets: [backgroundAsset()],
      targetJsonPath: first.result.jsonPath,
    });
    if (renamed.result.jsonPath !== first.result.jsonPath) throw new Error("已打开地图改名后创建了新记录");
    await post("/api/unity/sync-map", {
      projectPath: testRoot,
      project: mapProject("地图乙", first.result.prefabPath),
      assets: [backgroundAsset()],
      targetJsonPath: first.result.jsonPath,
    }, 409);

    const list = await post("/api/unity/maps", { projectPath: testRoot });
    if (list.maps.length !== 2 || !list.maps.some((item) => item.mapName === "地图甲改名") || !list.maps.some((item) => item.mapName === "地图乙")) {
      throw new Error("地图列表没有保留两个独立记录");
    }
    await post("/api/unity/delete-map", { projectPath: testRoot, jsonPath: first.result.jsonPath });
    const afterDelete = await post("/api/unity/maps", { projectPath: testRoot });
    if (afterDelete.maps.length !== 1 || afterDelete.maps[0].jsonPath !== second.result.jsonPath) throw new Error("删除地图影响了其他记录");

    process.stdout.write(`${JSON.stringify({ ok: true, first: first.result.jsonPath, second: second.result.jsonPath, remaining: afterDelete.maps[0].mapName }, null, 2)}\n`);
  } finally {
    const tempRoot = path.resolve(os.tmpdir());
    const resolvedTestRoot = path.resolve(testRoot);
    if (path.dirname(resolvedTestRoot) === tempRoot && path.basename(resolvedTestRoot).startsWith("frame-action-map-identity-")) {
      fs.rmSync(resolvedTestRoot, { recursive: true, force: true });
    }
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
