const { chromium } = require("playwright-core");

const baseUrl = process.argv[2] || "http://127.0.0.1:5188";
const projectPath = process.argv[3] || "D:\\Users\\unity\\元素协奏（横版2D）";
const screenshotPath = process.argv[4] || "";
const executablePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

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

    await page.locator(".sync-button").click();
    const modal = page.locator(".map-sync-modal");
    const selector = modal.locator('select[aria-label="Unity 已同步地图"]');
    const wolfOption = await selector.locator("option", { hasText: "狼妖地图" }).getAttribute("value");
    await selector.selectOption(wolfOption || undefined);
    await modal.getByRole("button", { name: "打开地图" }).click();
    await modal.getByText(/已载入地图 狼妖地图/).waitFor({ timeout: 30000 });
    await modal.getByRole("button", { name: "关闭" }).last().click();

    const firstAsset = page.locator(".map-asset-item").first();
    await firstAsset.waitFor();
    await firstAsset.getByRole("button", { name: "绘制" }).click();
    await page.getByText("物体轮廓模板", { exact: true }).first().waitFor();
    if (!await firstAsset.evaluate((element) => element.classList.contains("active"))) throw new Error("物体库没有标记正在编辑的素材");
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });

    await page.locator(".map-mode-control").getByRole("button", { name: "矩形碰撞" }).click();
    const canvas = page.locator(".map-canvas-wrap canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("找不到地图画布");
    await canvas.dispatchEvent("pointerdown", { button: 0, pointerId: 1, clientX: box.x + box.width * 0.42, clientY: box.y + box.height * 0.48 });
    await canvas.dispatchEvent("pointermove", { button: 0, pointerId: 1, clientX: box.x + box.width * 0.62, clientY: box.y + box.height * 0.58 });
    await canvas.dispatchEvent("pointerup", { button: 0, pointerId: 1, clientX: box.x + box.width * 0.62, clientY: box.y + box.height * 0.58 });
    await page.locator(".map-outline-item").first().waitFor();

    await page.getByRole("button", { name: "返回地图" }).click();
    await page.getByText("物体轮廓模板", { exact: true }).waitFor({ state: "detached" });
    const assetText = await firstAsset.textContent();
    if (!assetText?.includes("1 条自定义轮廓")) throw new Error(`物体库没有显示模板轮廓数量：${assetText}`);

    process.stdout.write(`${JSON.stringify({ ok: true, asset: assetText.trim() }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
