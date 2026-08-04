const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const input = process.argv[2];
if (!input) {
  console.error("用法: node scripts/upgrade-program-ice-map.cjs <frame-action-map.json>");
  process.exit(2);
}

const mapPath = path.resolve(input);
if (!fs.existsSync(mapPath)) {
  console.error(`地图不存在: ${mapPath}`);
  process.exit(2);
}

const bundlePath = path.join(os.tmpdir(), `spritecue-map-ice-${process.pid}.cjs`);

async function main() {
  try {
    const { rolldown } = await import("rolldown");
    const sourcePath = path.resolve(__dirname, "../src/mapIceGeometry.ts");
    const bundle = await rolldown({ input: sourcePath });
    await bundle.write({ file: bundlePath, format: "cjs" });
  const { ensureProgramIceOutline } = require(bundlePath);
  const data = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const outlines = Array.isArray(data.outlines) ? data.outlines : [];
  let upgraded = 0;
  let repaired = 0;
  data.outlines = outlines.map((outline) => {
    const previous = outline?.iceBody;
    const next = ensureProgramIceOutline(outline);
    if (next !== outline) {
      if (previous) repaired += 1;
      else upgraded += 1;
    }
    return next;
  });
  if (upgraded || repaired) {
    fs.writeFileSync(mapPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
    console.log(JSON.stringify({ mapPath, upgraded, repaired, outlineCount: outlines.length }));
  } finally {
    if (fs.existsSync(bundlePath)) fs.rmSync(bundlePath, { force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
