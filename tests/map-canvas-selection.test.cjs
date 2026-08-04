const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "components", "MapEditor.tsx"), "utf8");

test("地图画布可选中五类工具对象并编辑或删除", () => {
  assert.match(source, /selectedOutlineId/);
  assert.match(source, /selectedMatterStrokeId/);
  assert.match(source, /outlineContainsPoint/);
  assert.match(source, /matterStrokeContainsPoint/);
  assert.match(source, /selectCanvasTarget\("outline", outline\.id\)/);
  assert.match(source, /selectCanvasTarget\("matter", matterStroke\.id\)/);
  assert.match(source, /title="删除选中对象 Delete"/);
  assert.match(source, /selectedCanvasKind[\s\S]*removeSelectedCanvasTarget\(\)/,
    "Delete 和 Backspace 必须处理所有选中类型");

  for (const label of ["矩形碰撞", "程序刚体", "液体画笔", "气体画笔", "遮挡区域"]) {
    assert.match(source, new RegExp(label), `缺少${label}的选中或属性面板`);
  }

  for (const label of ["中心 X", "中心 Y", "元素标签", "基础色", "次级色", "发光色", "密度", "蒸发半衰期", "消散半衰期"]) {
    assert.match(source, new RegExp(label), `选中对象面板缺少参数：${label}`);
  }
});

test("新建轮廓和物质画笔后立即进入选中状态", () => {
  assert.match(source, /selectCanvasTarget\("matter", finishedMatter\.id\)/);
  assert.match(source, /selectCanvasTarget\("outline", rigidOutline\.id\)/);
  assert.match(source, /selectCanvasTarget\("outline", finishedDrawing\.id\)/);
  assert.match(source, /if \(completedOutline\) selectCanvasTarget\("outline", completedOutline\.id\)/);
});
