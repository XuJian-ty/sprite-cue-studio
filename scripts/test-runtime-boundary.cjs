const fs = require("fs");
const os = require("os");
const path = require("path");

const baseUrl = process.argv[2] || "http://127.0.0.1:5188";
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frame-action-runtime-boundary-"));
const runtimeRoot = path.join(testRoot, "Packages", "com.frame-action.runtime");
const runtimeSource = path.join(runtimeRoot, "Runtime", "CustomRuntime.cs");

async function post(route, body, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") || "";
  const result = contentType.includes("application/json") ? await response.json() : { message: await response.text() };
  if (response.status !== expectedStatus) throw new Error(`${route} 返回 ${response.status}：${result.message || JSON.stringify(result)}`);
  return result;
}

function writeRuntime(schemaMin, schemaMax) {
  fs.mkdirSync(path.dirname(runtimeSource), { recursive: true });
  const manifest = {
    name: "com.frame-action.runtime",
    version: "custom-test",
  };
  if (schemaMin !== undefined || schemaMax !== undefined) manifest.frameAction = { schemaMin, schemaMax };
  fs.writeFileSync(path.join(runtimeRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (!fs.existsSync(runtimeSource)) fs.writeFileSync(runtimeSource, "// user-owned runtime customization\n", "utf8");
}

(async () => {
  try {
    fs.mkdirSync(path.join(testRoot, "Assets"), { recursive: true });
    fs.mkdirSync(path.join(testRoot, "Packages"), { recursive: true });
    fs.mkdirSync(path.join(testRoot, "ProjectSettings"), { recursive: true });

    const missing = await post("/api/unity/check", { projectPath: testRoot });
    if (missing.runtime.installed || missing.runtime.compatible) throw new Error("缺少 Runtime 时兼容状态错误");

    writeRuntime();
    const legacy = await post("/api/unity/check", { projectPath: testRoot });
    if (!legacy.runtime.compatible || legacy.runtime.compatibilityKnown) throw new Error("旧版 Runtime 兼容回退失效");

    writeRuntime(5, 5);
    const incompatible = await post("/api/unity/check", { projectPath: testRoot });
    if (!incompatible.runtime.installed || incompatible.runtime.compatible) throw new Error("不兼容 Schema 没有被识别");
    const rejected = await post("/api/unity/sync", { projectPath: testRoot, project: {} }, 409);
    if (rejected.code !== "runtime_incompatible") throw new Error("同步没有返回 runtime_incompatible");

    writeRuntime(6, 6);
    const compatible = await post("/api/unity/check", { projectPath: testRoot });
    if (!compatible.runtime.compatible || compatible.runtime.version !== "custom-test") throw new Error("兼容的自定义 Runtime 没有通过检查");

    const before = fs.readFileSync(runtimeSource, "utf8");
    await post("/api/unity/sync", { projectPath: testRoot, project: {} }, 400);
    const after = fs.readFileSync(runtimeSource, "utf8");
    if (after !== before) throw new Error("同步请求修改了 Runtime 文件");

    const localRuntimeRoot = path.join(testRoot, "LocalRuntime");
    fs.renameSync(runtimeRoot, localRuntimeRoot);
    fs.writeFileSync(path.join(testRoot, "Packages", "manifest.json"), `${JSON.stringify({
      dependencies: { "com.frame-action.runtime": `file:${localRuntimeRoot.replace(/\\/g, "/")}` },
    }, null, 2)}\n`);
    const localPackage = await post("/api/unity/check", { projectPath: testRoot });
    if (!localPackage.runtime.compatible || path.resolve(localPackage.runtime.path) !== path.resolve(localRuntimeRoot)) {
      throw new Error("Unity Package Manager 本地包没有被识别");
    }

    const removedInstaller = await post("/api/unity/install-runtime", { projectPath: testRoot }, 404);
    if (removedInstaller.code !== "api_not_found") throw new Error("旧 Runtime 安装接口仍然存在");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      runtimeVersion: compatible.runtime.version,
      schema: compatible.runtime.schemaVersion,
      runtimeUntouched: true,
      localPackageDetected: true,
    }, null, 2)}\n`);
  } finally {
    const tempRoot = path.resolve(os.tmpdir());
    const resolvedTestRoot = path.resolve(testRoot);
    if (path.dirname(resolvedTestRoot) === tempRoot && path.basename(resolvedTestRoot).startsWith("frame-action-runtime-boundary-")) {
      fs.rmSync(resolvedTestRoot, { recursive: true, force: true });
    }
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
