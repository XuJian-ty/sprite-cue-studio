const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { after, before, test } = require("node:test");
const sharp = require("sharp");

const repositoryRoot = path.resolve(__dirname, "..");
const unityRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spritecue-map-ice-test-"));
let serverProcess;
let baseUrl;

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function postJson(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.message || `HTTP ${response.status}`);
  return result;
}

before(async () => {
  fs.mkdirSync(path.join(unityRoot, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(unityRoot, "ProjectSettings"), { recursive: true });
  const packageFolder = path.join(unityRoot, "Packages", "com.frame-action.runtime");
  fs.mkdirSync(packageFolder, { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, "unity-package", "com.frame-action.runtime", "package.json"), path.join(packageFolder, "package.json"));
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(repositoryRoot, "server.cjs")], {
    cwd: repositoryRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/status`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("测试服务启动超时");
});

after(() => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
  fs.rmSync(unityRoot, { recursive: true, force: true });
});

test("旧冰体与缺失刚体配置经连续两次同步后稳定迁移到通用程序刚体", async () => {
  const points = [{ x: 40, y: 40 }, { x: 180, y: 40 }, { x: 180, y: 140 }, { x: 40, y: 140 }];
  const iceBody = {
    schemaVersion: 1,
    material: "iceRigid",
    algorithm: "procedural-ice-v1",
    seed: 40231,
    closureMode: "terrain",
    edgeRoles: ["exposed", "exposed", "exposed", "terrainAttached"],
    terrainBinding: { sourceId: "wall", sourceKind: "mapOutline", route: "backward", start: { x: 40, y: 40 }, end: { x: 40, y: 140 } },
    visual: {
      jaggedness: 0.45,
      facetSize: 28,
      facetVariation: 0.55,
      textureStrength: 0.65,
      edgeBrightness: 0.85,
      volumeDepth: 1.1,
      transmission: 0.62,
      absorption: 0.31,
      frostWidth: 3.25,
      specularStrength: 1.2,
      inclusionDensity: 0.22,
      microCrackDensity: 0.16,
      lightAngleDegrees: -42,
      futureVisualParameter: 0.314,
    },
    fracture: {
      primaryFragmentMin: 3,
      primaryFragmentMax: 8,
      minimumFragmentArea: 20,
      minimumFragmentWidth: 3,
      crackBranchMin: 1,
      crackBranchMax: 2,
      releaseDelayTicks: 2,
      collisionBreakThreshold: 7,
      landingChipEnergy: 1.75,
      landingCrackEnergy: 4.5,
      landingBreakEnergy: 10.25,
      contactStressSensitivity: 1.3,
      landingCooldownTicks: 9,
      futureFractureParameter: 2718,
    },
    futureBodyParameter: { retained: true },
    facets: [
      { id: 1, points: [points[0], points[1], points[2]], shade: 0.25 },
      { id: 2, points: [points[0], points[2], points[3]], shade: 0.75 },
    ],
  };
  const project = {
    format: "frame-action-map",
    version: 2,
    mapName: "程序冰体往返",
    mapType: "side2d",
    width: 256,
    height: 192,
    pixelsPerUnit: 32,
    backgroundAssetId: "background",
    unityPrefabPath: "",
    objects: [],
    outlines: [
      { id: "ice-body", layer: "rigid", element: "ice", shape: "polygon", collisionType: "solid", sideCollision: true, thickness: 0, closed: true, points, iceBody },
      { id: "ice-body-missing", layer: "rigid", element: "ice", shape: "polygon", collisionType: "solid", sideCollision: true, thickness: 0, closed: true, points: points.map((point) => ({ x: point.x + 12, y: point.y + 8 })) },
    ],
    draftOutlines: [],
    matterStrokes: [],
  };
  const backgroundBytes = await sharp({ create: { width: 256, height: 192, channels: 4, background: { r: 20, g: 35, b: 48, alpha: 1 } } }).png().toBuffer();
  const assets = [{ id: "background", name: "background.png", kind: "image", usage: "background", width: 256, height: 192, byteSize: backgroundBytes.length, dataUrl: `data:image/png;base64,${backgroundBytes.toString("base64")}` }];

  const sync = await postJson("/api/unity/sync-map", { projectPath: unityRoot, project, assets });
  const jsonPath = path.join(unityRoot, ...sync.result.jsonPath.split("/"));
  const saved = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const upgraded = saved.outlines[0].rigidBody;
  assert.equal(upgraded.schemaVersion, 1);
  assert.equal(upgraded.algorithm, "procedural-rigid-v1");
  assert.equal(upgraded.templateId, "iceCrystal");
  assert.equal(upgraded.elementTag, "ice");
  assert.equal(upgraded.seed, iceBody.seed);
  assert.ok(upgraded.facets.length > 0);
  assert.deepEqual(upgraded.futureBodyParameter, { retained: true });
  assert.equal(upgraded.visual.futureVisualParameter, 0.314);
  assert.equal(upgraded.fracture.futureFractureParameter, 2718);
  assert.equal(upgraded.visual.volumeDepth, 1, "已知视觉参数迁移时应钳制到工具公开的 0..1 范围");
  assert.match(upgraded.visual.fractureColor, /^#[0-9a-f]{6}$/i,
    "旧数据缺少破碎特效色时应补齐模板默认色");
  assert.equal(upgraded.fracture.landingBreakEnergy, 10.25);
  assert.equal(Object.hasOwn(upgraded, "melting"), false);
  assert.equal(Object.hasOwn(upgraded, "reaction"), false);
  assert.equal(Object.hasOwn(saved.outlines[0], "iceBody"), false, "持久化结果不得继续写旧 iceBody 字段");
  assert.equal(saved.outlines[1].rigidBody.schemaVersion, 1, "缺失配置的闭合刚体必须自动生成程序刚体");
  assert.ok(saved.outlines[1].rigidBody.facets.length > 0);

  const loaded = await postJson("/api/unity/load-map", { projectPath: unityRoot, jsonPath: sync.result.jsonPath });
  assert.deepEqual(loaded.project.outlines[0].rigidBody, upgraded);

  const repeated = await postJson("/api/unity/sync-map", {
    projectPath: unityRoot,
    project: loaded.project,
    assets: loaded.assets,
    targetJsonPath: sync.result.jsonPath,
  });
  const repeatedPath = path.join(unityRoot, ...repeated.result.jsonPath.split("/"));
  const savedAgain = JSON.parse(fs.readFileSync(repeatedPath, "utf8"));
  assert.deepEqual(savedAgain.outlines[0].rigidBody, upgraded, "第二次同步不得改变 seed、分面或作者参数");
  assert.deepEqual(savedAgain.outlines[1].rigidBody, saved.outlines[1].rigidBody, "自动生成的程序刚体也必须幂等");

  const loadedAgain = await postJson("/api/unity/load-map", { projectPath: unityRoot, jsonPath: repeated.result.jsonPath });
  assert.deepEqual(loadedAgain.project.outlines.map((outline) => outline.rigidBody), savedAgain.outlines.map((outline) => outline.rigidBody));
});

test("物体素材的程序刚体层同步为唯一通用刚体并保留自由元素标签", async () => {
  const backgroundBytes = await sharp({ create: { width: 256, height: 192, channels: 4, background: { r: 12, g: 22, b: 35, alpha: 1 } } }).png().toBuffer();
  const objectBytes = await sharp({ create: { width: 128, height: 64, channels: 4, background: { r: 96, g: 186, b: 220, alpha: 1 } } }).png().toBuffer();
  const project = {
    format: "frame-action-map", version: 2, mapName: "素材程序刚体", mapType: "side2d",
    width: 256, height: 192, pixelsPerUnit: 32, backgroundAssetId: "background", unityPrefabPath: "",
    objects: [{ id: "rigid-instance", assetId: "rigid-art", layer: "rigid", mode: "static", collisionType: "solid", element: "fire", x: 48, y: 64, scale: 1, rotation: 0, z: 0 }],
    outlines: [], draftOutlines: [], matterStrokes: [],
  };
  const assets = [
    { id: "background", name: "background.png", kind: "image", usage: "background", width: 256, height: 192, byteSize: backgroundBytes.length, dataUrl: `data:image/png;base64,${backgroundBytes.toString("base64")}` },
    {
      id: "rigid-art", name: "rigid-art.png", kind: "image", usage: "object", defaultLayer: "rigid", width: 128, height: 64,
      byteSize: objectBytes.length, dataUrl: `data:image/png;base64,${objectBytes.toString("base64")}`,
      outlines: [{ id: "asset-rigid", layer: "rigid", element: "ice", shape: "polygon", collisionType: "solid", sideCollision: true, thickness: 0, closed: true, points: [{ x: 8, y: 8 }, { x: 120, y: 8 }, { x: 112, y: 56 }, { x: 16, y: 56 }] }],
      draftOutlines: [],
    },
  ];

  const sync = await postJson("/api/unity/sync-map", { projectPath: unityRoot, project, assets });
  const saved = JSON.parse(fs.readFileSync(path.join(unityRoot, ...sync.result.jsonPath.split("/")), "utf8"));
  const entry = saved.assets.find((asset) => asset.id === "rigid-art");
  assert.ok(entry);
  assert.equal(entry.outlines.length, 1);
  assert.equal(entry.outlines[0].rigidBody.algorithm, "procedural-rigid-v1");
  assert.equal(entry.outlines[0].rigidBody.templateId, "iceCrystal");
  assert.equal(entry.outlines[0].rigidBody.elementTag, "冰");
  assert.equal(entry.outlines[0].rigidBody.closureMode, "manual");
  assert.equal(entry.outlines[0].rigidBody.physical.anchoringMode, "dynamic");
  assert.equal(Object.hasOwn(entry.outlines[0], "iceBody"), false);

  const synchronizer = fs.readFileSync(path.join(repositoryRoot, "unity-package", "com.frame-action.runtime", "Editor", "FrameActionMapPrefabSynchronizer.cs"), "utf8");
  assert.match(synchronizer, /FindAssetProceduralRigidOutline/);
  assert.match(synchronizer, /renderer\.enabled = false/);
  assert.match(synchronizer, /AddComponent<FrameActionProceduralRigidBody2D>/);
  assert.match(synchronizer, /CreateAutomaticAssetProceduralRigidBody/,
    "旧素材缺少作者轮廓时也必须进入通用程序刚体，不能退回旧刚体路径");
  assert.match(synchronizer, /CreateProceduralRigidEffectsLayer/);
  assert.match(synchronizer, /ConfigureAsGlobal/);
  assert.doesNotMatch(synchronizer, /AddComponent<FrameActionProceduralIceBody2D>/);
  assert.match(synchronizer, /authored\.elementTag/);
  assert.match(synchronizer, /multiple rigid outlines/);
});

test("物体库程序刚体的全部物理与落地破碎参数可往返且运行时自带共享碎屑入口", async () => {
  const backgroundBytes = await sharp({ create: { width: 192, height: 128, channels: 4, background: { r: 10, g: 16, b: 25, alpha: 1 } } }).png().toBuffer();
  const objectBytes = await sharp({ create: { width: 80, height: 72, channels: 4, background: { r: 92, g: 176, b: 214, alpha: 1 } } }).png().toBuffer();
  const rigidBody = {
    schemaVersion: 1,
    algorithm: "procedural-rigid-v1",
    templateId: "iceCrystal",
    elementTag: "冰",
    seed: 240731,
    closureMode: "manual",
    authoringPoints: [{ x: 4, y: 5 }, { x: 76, y: 8 }, { x: 70, y: 68 }, { x: 8, y: 64 }],
    routePreference: "shorter",
    edgeRoles: ["exposed", "exposed", "exposed", "exposed"],
    visual: {
      sourceMode: "sourceImage", templateId: "iceCrystal",
      baseColor: "#79d5ee", shadowColor: "#123e64", highlightColor: "#e7fbff", edgeColor: "#a9edff",
      fractureColor: "#f2fdff",
      opacity: 0.93, edgeJaggedness: 0.61, facetScale: 21, facetVariation: 0.57,
      textureStrength: 0.72, edgeBrightness: 0.88, edgeWidthPixels: 2.75,
      volumeDepth: 0.84, transmission: 0.7, absorption: 0.45, roughness: 0.13,
      specularStrength: 0.91, inclusionDensity: 0.29, microCrackDensity: 0.24,
      grainDirectionDegrees: -25, anisotropy: 0.35, lightAngleDegrees: 126,
    },
    physical: {
      anchoringMode: "dynamic", density: 0.92, gravityScale: 1.15, friction: 0.12,
      restitution: 0.08, linearDamping: 0.12, angularDamping: 0.08,
      hardness: 0.72, toughness: 0.35, brittleness: 0.9, anisotropy: 0.35,
      grainAngleDegrees: -25, debrisFraction: 0.16,
    },
    fracture: {
      primaryFragmentMin: 3, primaryFragmentMax: 8, maxFragmentsPerImpact: 7,
      maxActiveFragmentsPerFamily: 48, minimumFragmentArea: 20, minimumFragmentWidth: 3,
      crackBranchMin: 1, crackBranchMax: 2, releaseDelayTicks: 2,
      impactChipEnergy: 4, impactCrackEnergy: 12, impactBreakEnergy: 40,
      collisionBreakThreshold: 7, landingChipEnergy: 1.5, landingCrackEnergy: 4,
      landingBreakEnergy: 9, contactStressSensitivity: 1.2, landingCooldownTicks: 6,
    },
    facets: [
      { id: 1, points: [{ x: 4, y: 5 }, { x: 76, y: 8 }, { x: 70, y: 68 }], shade: 0.3 },
      { id: 2, points: [{ x: 4, y: 5 }, { x: 70, y: 68 }, { x: 8, y: 64 }], shade: 0.7 },
    ],
  };
  const project = {
    format: "frame-action-map", version: 2, mapName: "物体库刚体参数往返", mapType: "side2d",
    width: 192, height: 128, pixelsPerUnit: 50, backgroundAssetId: "parameter-background", unityPrefabPath: "",
    objects: [{ id: "parameter-rigid-instance", assetId: "parameter-rigid-art", layer: "rigid", mode: "static", collisionType: "solid", elementTag: "冰", x: 48, y: 20, scale: 0.65, rotation: 12, z: 0 }],
    outlines: [], draftOutlines: [], matterStrokes: [],
  };
  const assets = [
    { id: "parameter-background", name: "background.png", kind: "image", usage: "background", width: 192, height: 128, byteSize: backgroundBytes.length, dataUrl: `data:image/png;base64,${backgroundBytes.toString("base64")}` },
    {
      id: "parameter-rigid-art", name: "parameter-rigid.png", kind: "image", usage: "object", defaultLayer: "rigid", width: 80, height: 72,
      byteSize: objectBytes.length, dataUrl: `data:image/png;base64,${objectBytes.toString("base64")}`,
      outlines: [{ id: "parameter-rigid-outline", layer: "rigid", shape: "polygon", collisionType: "solid", sideCollision: true, thickness: 0, closed: true, points: rigidBody.authoringPoints, rigidBody }],
      draftOutlines: [],
    },
  ];

  const sync = await postJson("/api/unity/sync-map", { projectPath: unityRoot, project, assets });
  const saved = JSON.parse(fs.readFileSync(path.join(unityRoot, ...sync.result.jsonPath.split("/")), "utf8"));
  const savedBody = saved.assets.find((asset) => asset.id === "parameter-rigid-art").outlines[0].rigidBody;
  assert.equal(savedBody.visual.sourceMode, "sourceImage");
  assert.equal(savedBody.visual.fractureColor, "#f2fdff");
  assert.equal(savedBody.physical.density, 0.92);
  assert.equal(savedBody.physical.gravityScale, 1.15);
  assert.equal(savedBody.physical.debrisFraction, 0.16);
  assert.equal(savedBody.fracture.maxFragmentsPerImpact, 7);
  assert.equal(savedBody.fracture.impactChipEnergy, 4);
  assert.equal(savedBody.fracture.impactCrackEnergy, 12);
  assert.equal(savedBody.fracture.impactBreakEnergy, 40);
  assert.equal(savedBody.fracture.landingChipEnergy, 1.5);
  assert.equal(savedBody.fracture.landingCrackEnergy, 4);
  assert.equal(savedBody.fracture.landingBreakEnergy, 9);
  assert.equal(savedBody.fracture.contactStressSensitivity, 1.2);

  const loaded = await postJson("/api/unity/load-map", { projectPath: unityRoot, jsonPath: sync.result.jsonPath });
  assert.deepEqual(loaded.assets.find((asset) => asset.id === "parameter-rigid-art").outlines[0].rigidBody, savedBody);

  const core = fs.readFileSync(path.join(repositoryRoot, "unity-package", "com.frame-action.runtime", "Runtime", "FrameActionProceduralRigidBodyCore2D.cs"), "utf8");
  const presenter = fs.readFileSync(path.join(repositoryRoot, "unity-package", "com.frame-action.runtime", "Runtime", "FrameActionProceduralRigidDebrisPresenter2D.cs"), "utf8");
  assert.match(core, /case FrameActionProceduralRigidImpactResponse2D\.Crack:[\s\S]*EmitImpactDebris/);
  assert.match(core, /case FrameActionProceduralRigidImpactResponse2D\.Fracture:[\s\S]*EmitImpactDebris/);
  assert.match(presenter, /MaterialResourcePath = "FrameAction\/ProceduralRigidDebris"/);
  assert.match(presenter, /visualEvent\.DebrisBaseColor/);
});
