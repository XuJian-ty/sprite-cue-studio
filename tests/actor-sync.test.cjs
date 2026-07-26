const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { after, before, test } = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..");
const unityRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spritecue-actor-sync-test-"));
let serverProcess;
let baseUrl;

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

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
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

function createProject(frameAssetId = "asset-a") {
  return {
    format: "frame-action-project",
    version: 11,
    projectKind: "character",
    tickRate: 600,
    pixelsPerUnit: 160,
    sourceFacing: "right",
    characterName: "Incremental Sync Test",
    unityCharacter: { prefabPath: "", actorLayerName: "Player" },
    actions: [{
      id: "action-a",
      name: "Action A",
      type: "custom",
      loop: false,
      segments: [{
        id: "segment-a",
        name: "Main",
        frames: frameAssetId ? [{ id: "frame-a", assetId: frameAssetId, name: "a.png", durationTicks: 50 }] : [],
        tracks: [],
      }],
    }],
  };
}

function assetMetadata(contents) {
  return {
    id: "asset-a",
    name: "a.png",
    kind: "image",
    usage: "character",
    byteSize: contents.length,
    sha256: sha256(contents),
  };
}

async function startSync(project, assets, targetJsonPath = "") {
  return (await postJson("/api/unity/actor-sync/start", {
    projectPath: unityRoot,
    actorKind: "character",
    project,
    assets,
    targetJsonPath,
  })).result;
}

async function uploadAsset(uploadId, assetId, contents) {
  const response = await fetch(`${baseUrl}/api/unity/actor-sync/chunk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Frame-Action-Upload-Id": uploadId,
      "X-Frame-Action-Asset-Id": encodeURIComponent(assetId),
      "X-Frame-Action-Upload-Offset": "0",
    },
    body: contents,
  });
  const result = await response.json();
  assert.equal(response.ok, true, result.message);
}

async function finishSync(uploadId) {
  return (await postJson("/api/unity/actor-sync/finish", { uploadId })).result;
}

before(async () => {
  fs.mkdirSync(path.join(unityRoot, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(unityRoot, "ProjectSettings"), { recursive: true });
  const runtimeRoot = path.join(unityRoot, "Packages", "com.frame-action.runtime");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "package.json"), JSON.stringify({
    name: "com.frame-action.runtime",
    version: "0.34.26",
    frameAction: { schemaMin: 11, schemaMax: 11 },
  }));

  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(repositoryRoot, "server.cjs")], {
    cwd: repositoryRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  await waitForServer();
});

after(() => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
  fs.rmSync(unityRoot, { recursive: true, force: true });
});

test("actor sync uploads only changed resources", async () => {
  const firstContents = Buffer.from("first");
  const firstAsset = assetMetadata(firstContents);
  const project = createProject();

  const firstStart = await startSync(project, [firstAsset]);
  assert.deepEqual(firstStart.uploadAssetIds, [firstAsset.id]);
  assert.equal(firstStart.uploadAssetCount, 1);
  assert.equal(firstStart.reusedAssetCount, 0);
  await uploadAsset(firstStart.uploadId, firstAsset.id, firstContents);
  const firstFinish = await finishSync(firstStart.uploadId);
  assert.equal(firstFinish.uploadedAssetCount, 1);
  assert.equal(firstFinish.reusedAssetCount, 0);

  const jsonPath = path.join(unityRoot, firstFinish.jsonPath);
  const manifest = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.equal(manifest.assets[0].sha256, firstAsset.sha256);
  assert.equal(manifest.assets[0].byteSize, firstContents.length);

  delete manifest.assets[0].sha256;
  delete manifest.assets[0].byteSize;
  fs.writeFileSync(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const legacyStart = await startSync(project, [firstAsset], firstFinish.jsonPath);
  assert.deepEqual(legacyStart.uploadAssetIds, []);
  assert.equal(legacyStart.reusedAssetCount, 1);
  await finishSync(legacyStart.uploadId);
  const firstJson = fs.readFileSync(jsonPath, "utf8");
  const migratedManifest = JSON.parse(firstJson);
  assert.equal(migratedManifest.assets[0].sha256, firstAsset.sha256);
  assert.equal(migratedManifest.assets[0].byteSize, firstContents.length);

  const unchangedStart = await startSync(project, [firstAsset], firstFinish.jsonPath);
  assert.deepEqual(unchangedStart.uploadAssetIds, []);
  assert.equal(unchangedStart.reusedAssetCount, 1);
  const unchangedFinish = await finishSync(unchangedStart.uploadId);
  assert.equal(unchangedFinish.changedFiles, 0);
  assert.equal(fs.readFileSync(jsonPath, "utf8"), firstJson);

  const changedProject = structuredClone(project);
  changedProject.actions[0].name = "Changed Action";
  const actionStart = await startSync(changedProject, [firstAsset], firstFinish.jsonPath);
  assert.deepEqual(actionStart.uploadAssetIds, []);
  const actionFinish = await finishSync(actionStart.uploadId);
  assert.equal(actionFinish.uploadedAssetCount, 0);
  assert.equal(actionFinish.reusedAssetCount, 1);
  assert.equal(actionFinish.changedFiles, 1);

  const replacementContents = Buffer.from("other");
  const replacementAsset = assetMetadata(replacementContents);
  const replacementStart = await startSync(changedProject, [replacementAsset], firstFinish.jsonPath);
  assert.deepEqual(replacementStart.uploadAssetIds, [replacementAsset.id]);
  await uploadAsset(replacementStart.uploadId, replacementAsset.id, replacementContents);
  const replacementFinish = await finishSync(replacementStart.uploadId);
  assert.equal(replacementFinish.uploadedAssetCount, 1);

  const removedProject = createProject("");
  const removeStart = await startSync(removedProject, [], firstFinish.jsonPath);
  assert.deepEqual(removeStart.uploadAssetIds, []);
  const removeFinish = await finishSync(removeStart.uploadId);
  assert.equal(removeFinish.assetCount, 0);
  assert.equal(fs.existsSync(path.join(path.dirname(jsonPath), "Sprites", "a.png")), false);
});
