const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { after, before, test } = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..");
const unityRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spritecue-map-matter-test-"));
const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const elements = ["fire", "ice", "water", "wind", "light", "dark", "thunder"];
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

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return;
    } catch {
      // The child process may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("测试服务启动超时");
}

before(async () => {
  fs.mkdirSync(path.join(unityRoot, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(unityRoot, "ProjectSettings"), { recursive: true });
  const packageFolder = path.join(unityRoot, "Packages", "com.frame-action.runtime");
  fs.mkdirSync(packageFolder, { recursive: true });
  fs.copyFileSync(
    path.join(repositoryRoot, "unity-package", "com.frame-action.runtime", "package.json"),
    path.join(packageFolder, "package.json"));
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(repositoryRoot, "server.cjs")], {
    cwd: repositoryRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer();
});

after(() => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
  fs.rmSync(unityRoot, { recursive: true, force: true });
});

test("map sync preserves free matter tags and portable physical/visual profiles", async () => {
  const matterStrokes = elements.flatMap((element, index) => ([
    {
      id: `liquid-${element}`, carrier: "liquid", elementTag: element, radius: 4,
      profile: { schemaVersion: 1, visual: { baseColor: "#123456", particleScale: 0.45 }, physical: { density: 1.25, viscosity: 0.6 } },
      points: [{ x: index / 7, y: 0.25 }],
    },
    {
      id: `gas-${element}`, carrier: "gas", elementTag: `${element}-mist`, radius: 5,
      profile: { schemaVersion: 1, visual: { baseColor: "#abcdef", opacity: 0.42 }, physical: { density: 0.72, buoyancy: 0.16, diffusion: 0.8 } },
      points: [{ x: index / 7, y: 0.75 }],
    },
  ]));
  matterStrokes.push({ id: "legacy-water", carrier: "liquid", element: "water", radius: 2, points: [{ x: 0.5, y: 0.5 }] });
  const project = {
    format: "frame-action-map",
    version: 2,
    mapName: "元素物质验收图",
    mapType: "side2d",
    width: 1,
    height: 1,
    pixelsPerUnit: 32,
    backgroundAssetId: "background",
    unityPrefabPath: "",
    objects: [{
      id: "rigid-object",
      assetId: "rigid-art",
      layer: "rigid",
      element: "thunder",
      mode: "static",
      collisionType: "solid",
      x: 0.5,
      y: 0.5,
      scale: 1,
      rotation: 0,
      z: 0,
      outlinePrecision: "ultra",
    }],
    outlines: [{
      id: "rigid-outline",
      layer: "rigid",
      element: "dark",
      shape: "polygon",
      collisionType: "solid",
      sideCollision: true,
      thickness: 0,
      closed: true,
      points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }],
    }],
    draftOutlines: [],
    matterStrokes,
  };
  const assets = [
    { id: "background", name: "background.png", kind: "image", usage: "background", width: 1, height: 1, byteSize: 68, dataUrl: onePixelPng },
    { id: "rigid-art", name: "rigid.png", kind: "image", usage: "object", defaultLayer: "rigid", width: 1, height: 1, dataUrl: onePixelPng, outlines: [] },
  ];

  const sync = await postJson("/api/unity/sync-map", { projectPath: unityRoot, project, assets });
  const jsonPath = path.join(unityRoot, ...sync.result.jsonPath.split("/"));
  const saved = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.equal(saved.objects[0].layer, "rigid");
  assert.equal(saved.objects[0].element, "thunder");
  assert.equal(Object.hasOwn(saved.objects[0], "outlinePrecision"), false);
  assert.equal(saved.outlines[0].layer, "rigid");
  assert.equal(saved.outlines[0].element, "dark");
  assert.equal(saved.matterStrokes.length, 15);
  for (const element of elements) {
    const liquid = saved.matterStrokes.find((stroke) => stroke.elementTag === element && stroke.carrier === "liquid");
    const gas = saved.matterStrokes.find((stroke) => stroke.elementTag === `${element}-mist` && stroke.carrier === "gas");
    assert(liquid);
    assert(gas);
    assert.equal(Object.hasOwn(liquid, "element"), false);
    assert.equal(liquid.profile.visual.baseColor, "#123456");
    assert.equal(liquid.profile.visual.particleScale, 0.45);
    assert.equal(liquid.profile.physical.density, 1.25);
    assert.equal(liquid.profile.physical.viscosity, 0.6);
    assert.equal(gas.profile.physical.buoyancy, 0.16);
    assert.equal(gas.profile.physical.diffusion, 0.8);
  }
  const migrated = saved.matterStrokes.find((stroke) => stroke.id === "legacy-water");
  assert.equal(migrated.elementTag, "water");
  assert.equal(Object.hasOwn(migrated, "element"), false);
  assert.equal(migrated.profile.schemaVersion, 1);

  const loaded = await postJson("/api/unity/load-map", { projectPath: unityRoot, jsonPath: sync.result.jsonPath });
  assert.equal(loaded.project.objects[0].layer, "rigid");
  assert.equal(Object.hasOwn(loaded.project.objects[0], "outlinePrecision"), false);
  assert.equal(loaded.project.matterStrokes.length, 15);
  assert.equal(loaded.project.matterStrokes.find((stroke) => stroke.id === "legacy-water").elementTag, "water");
});
