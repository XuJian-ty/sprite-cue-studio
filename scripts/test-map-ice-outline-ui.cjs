const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright-core");

const baseUrl = process.argv[2] || "http://127.0.0.1:5192";
const screenshotPath = process.argv[3] || path.resolve(__dirname, "..", "tmp", "map-ice-authoring-ui.png");
const executablePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function drawStroke(page, points) {
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 8 });
  await page.mouse.up();
}

(async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1700, height: 960 }, deviceScaleFactor: 1 });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      localStorage.setItem("frameAction.activeModule", "map");
      localStorage.setItem("frameAction.workspaceDocuments", JSON.stringify({ map: { kind: "local" } }));
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase("frame-action-map-studio");
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      });
    });
    await page.reload({ waitUntil: "networkidle" });

    const canvas = page.locator(".map-canvas-wrap canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("找不到地图画布");

    await page.getByRole("button", { name: "碰撞区域" }).click();
    const wall = [
      { x: box.x + 190, y: box.y + 180 },
      { x: box.x + 350, y: box.y + 180 },
      { x: box.x + 350, y: box.y + 390 },
      { x: box.x + 190, y: box.y + 390 },
      { x: box.x + 190, y: box.y + 180 },
    ];
    await drawStroke(page, wall);
    await page.locator(".map-outline-item", { hasText: "实体碰撞" }).waitFor();

    await page.getByRole("button", { name: "程序冰体" }).click();
    await page.getByLabel("冰体封边方式").selectOption("terrain");
    await page.getByLabel("借用地形路径").selectOption("shorter");
    const attachedIce = [
      { x: box.x + 350, y: box.y + 225 },
      { x: box.x + 500, y: box.y + 225 },
      { x: box.x + 500, y: box.y + 345 },
      { x: box.x + 350, y: box.y + 345 },
    ];
    await drawStroke(page, attachedIce);
    await page.locator(".map-outline-item", { hasText: "程序冰体" }).waitFor();
    const attachedText = await page.locator(".map-outline-item", { hasText: "程序冰体" }).first().textContent();
    if (!attachedText?.includes("借地形")) throw new Error(`借地形冰体没有创建：${attachedText}`);

    await page.getByLabel("冰体封边方式").selectOption("manual");
    const manualIce = [
      { x: box.x + 600, y: box.y + 205 },
      { x: box.x + 790, y: box.y + 235 },
      { x: box.x + 760, y: box.y + 380 },
      { x: box.x + 570, y: box.y + 350 },
    ];
    await drawStroke(page, manualIce);
    const iceItems = page.locator(".map-outline-item", { hasText: "程序冰体" });
    if (await iceItems.count() !== 2) throw new Error(`期望 2 个程序冰体，实际 ${await iceItems.count()}`);
    const manualText = await iceItems.nth(1).textContent();
    if (!manualText?.includes("完整手绘")) throw new Error(`完整手绘冰体没有创建：${manualText}`);

    await page.getByRole("button", { name: "元素刚体" }).click();
    await page.getByLabel("刚体或物质元素").selectOption("ice");
    const ordinaryIce = [
      { x: box.x + 590, y: box.y + 465 },
      { x: box.x + 750, y: box.y + 455 },
      { x: box.x + 780, y: box.y + 565 },
      { x: box.x + 610, y: box.y + 585 },
      { x: box.x + 590, y: box.y + 465 },
    ];
    await drawStroke(page, ordinaryIce);
    await page.waitForFunction(() => [...document.querySelectorAll(".map-outline-item")].filter((item) => item.textContent?.includes("程序冰体")).length === 3);
    if (await iceItems.count() !== 3) throw new Error(`普通冰元素刚体没有自动升级，程序冰体实际 ${await iceItems.count()} 个`);

    await page.getByRole("button", { name: "程序冰体" }).click();
    await page.locator(".map-ice-authoring-hint").waitFor();
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    process.stdout.write(`${JSON.stringify({ ok: true, outlines: await page.locator(".map-outline-item").count(), iceBodies: await iceItems.count(), screenshotPath }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
