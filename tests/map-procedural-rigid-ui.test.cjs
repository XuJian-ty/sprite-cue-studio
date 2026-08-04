const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "components", "MapEditor.tsx"), "utf8");

test("物体库点击选中后按程序刚体层显示原图适配参数", () => {
  assert.match(source, /value: "iceBody", label: "程序刚体"/);
  assert.doesNotMatch(source, /value: "rigid", label:/);
  assert.match(source, /rigid: "程序刚体层"/);
  assert.match(source, /物体素材仅支持完整手绘/);
  assert.match(source, /元素标签（素材级）/);
  assert.doesNotMatch(source, /<span>刚体元素<\/span>/);
  assert.match(source, /onClick=\{\(\) => openAssetOutlineEditor\(asset\.id\)\}/,
    "点击左侧物体素材必须直接进入该素材的参数与轮廓编辑");
  assert.match(source, /layer === "rigid"[\s\S]*setMode\("iceBody"\)/,
    "物体素材切换到程序刚体层时必须显示程序刚体参数");
  assert.match(source, /sourceMode: editingAsset \? "sourceImage" as const : "procedural" as const/,
    "物体库刚体应保留原图，地图手绘刚体才使用全程序外观");
  assert.match(source, /主体颜色、纹理和透明轮廓来自原图片/);

  for (const label of [
    "基础色", "暗部色", "高光色", "边缘色", "不透明%", "边缘锯齿%", "分面尺寸",
    "纹理强度%", "体积%", "密度", "重力倍率", "摩擦%", "弹性%", "硬度%", "韧性%", "脆性%",
    "主碎片最少", "主碎片最多", "每击预算", "家族预算", "最小面积px²", "碰撞断裂阈值", "落地断裂能",
  ]) assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `缺少可编辑参数：${label}`);

  assert.match(source, /setRigidElementTag\(\(current\) => current\.trim\(\) \? current : template\.defaultElementTag\)/,
    "切换模板不得覆盖已有自由元素标签");
  assert.match(source, /editingAsset \? "原图破损表现" : "程序外观"/);
  assert.match(source, /<summary>物理<\/summary>/);
  assert.match(source, /<summary>破碎<\/summary>/);
});
