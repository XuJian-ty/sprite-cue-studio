const { chromium } = require("playwright-core");

const baseUrl = process.argv[2] || "http://127.0.0.1:5188";
const executablePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

(async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "敌人动作" }).click();
    await page.locator('.inspector-tabs').getByRole("button", { name: "AI", exact: true }).click();

    const canvas = page.locator(".behavior-canvas-shell");
    await canvas.waitFor();
    const nodeCount = await canvas.locator(".behavior-graph-node").count();
    if (nodeCount < 9) throw new Error(`默认行为树节点不足：${nodeCount}`);

    const nodeTypes = await canvas.locator('select[aria-label="新节点类型"] option').allTextContents();
    for (const expected of ["选择器", "随机选择器", "顺序器", "冷却", "播放动作", "行为任务"]) {
      if (!nodeTypes.includes(expected)) throw new Error(`行为树缺少节点类型：${expected}`);
    }
    if (await page.getByText("行为树运行", { exact: true }).count() !== 1) throw new Error("行为树检查器没有显示");

    process.stdout.write(`${JSON.stringify({ ok: true, nodeCount, nodeTypes }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
