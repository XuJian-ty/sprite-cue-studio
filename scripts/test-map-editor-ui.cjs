const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const baseUrl = process.argv[2] || "http://127.0.0.1:5188";
const projectPath = process.argv[3] || "D:\\Users\\unity\\元素协奏（横版2D）";
const executablePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const screenshotPath = path.join(os.tmpdir(), "frame-action-map-sync-modal.png");

(async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate((unityPath) => {
      localStorage.setItem("frameAction.activeModule", "map");
      localStorage.setItem("frameAction.mapUnityProjectPath", unityPath);
      localStorage.setItem("frameAction.workspaceDocuments", JSON.stringify({ map: { kind: "local" } }));
    }, projectPath);
    await page.reload({ waitUntil: "networkidle" });
    const syncButton = page.locator(".sync-button");
    await syncButton.click();
    const modal = page.locator(".map-sync-modal");
    await modal.getByText("打开已同步地图", { exact: true }).waitFor();
    const options = modal.locator('select[aria-label="Unity 已同步地图"] option');
    if (await options.count() !== 2) throw new Error(`预计显示 2 张已同步地图，实际为 ${await options.count()} 张`);
    const optionNames = await options.allTextContents();
    if (!optionNames.includes("主城地图") || !optionNames.includes("狼妖地图")) throw new Error(`地图列表内容不正确：${optionNames.join("、")}`);
    if (await modal.getByText("创建新地图", { exact: true }).count() !== 1) throw new Error("缺少创建新地图按钮");
    if (await modal.getByText("同步目标", { exact: true }).count() !== 0) throw new Error("地图身份同步模式不应再显示同步目标");
    if (!await syncButton.textContent().then((text) => text?.includes("同步地图（创建新地图中）"))) throw new Error("顶部新地图状态提示不正确");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const selector = modal.locator('select[aria-label="Unity 已同步地图"]');
    const wolfOption = await selector.locator("option", { hasText: "狼妖地图" }).getAttribute("value");
    await selector.selectOption(wolfOption || undefined);
    await modal.getByRole("button", { name: "打开地图" }).click();
    await modal.getByText(/已载入地图 狼妖地图/).waitFor({ timeout: 30000 });
    await modal.getByRole("button", { name: "关闭" }).last().click();
    if (!await syncButton.textContent().then((text) => text?.includes("同步地图（已打开旧地图）"))) throw new Error("顶部已打开地图状态提示不正确");

    process.stdout.write(`${JSON.stringify({ ok: true, maps: optionNames, screenshotPath }, null, 2)}\n`);
  } finally {
    await browser.close();
    if (fs.existsSync(screenshotPath)) fs.rmSync(screenshotPath, { force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
