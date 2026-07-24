const fs = require("fs");

const projectPath = process.argv[2];
if (!projectPath) throw new Error("请传入狼妖 Boss 的 frame-action.json 路径");
const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
if (project.characterName !== "狼妖Boss") throw new Error(`目标不是狼妖Boss：${project.characterName || "未命名"}`);

const actionIds = new Set((project.actions || []).map((action) => action.id));
for (const id of ["skill-claw-combo", "skill-shadow-ambush", "skill-charge-knockback"]) {
  if (!actionIds.has(id)) throw new Error(`缺少动作：${id}`);
}

function createSkill(id, name, enemySkill) {
  const track = (kind, label) => ({ id: `${id}-${kind}-track`, name: label, kind, events: [] });
  return {
    id,
    name,
    type: "skill",
    loop: false,
    comboCount: 1,
    comboWindow: 0.12,
    repeatWindow: 0.28,
    allowLastRepeat: false,
    doubleTapWindow: 0.28,
    movementSpeed: 4,
    trigger: { type: "none", code: "" },
    transitions: {},
    segments: [{
      id: `${id}-segment-1`,
      name: "主动作",
      fps: 12,
      frameCount: 8,
      sheetColumns: 5,
      sheetSpacing: 0,
      sheetPadding: 0,
      cellWidth: 500,
      cellHeight: 500,
      pixelsPerUnit: 160,
      pivotX: 230,
      pivotY: 110,
      jumpHeight: 2.4,
      frames: [],
      markers: [],
      tracks: [track("damage", "命中"), track("physics", "物理"), track("vfx", "特效"), track("sfx", "音效"), track("speed", "速度"), track("camera", "镜头")],
    }],
    enemySkill,
  };
}

function ensureSkill(id, name, enemySkill) {
  if (project.actions.some((action) => action.id === id)) return;
  const skill = createSkill(id, name, enemySkill);
  const hurtIndex = project.actions.findIndex((action) => action.type === "hurt");
  if (hurtIndex >= 0) project.actions.splice(hurtIndex, 0, skill);
  else project.actions.push(skill);
}

ensureSkill("skill-summon-lightning", "召唤落雷", { cooldownSeconds: 7, minRange: 2, maxRange: 9, selectionWeight: 75, lockMovement: true, lockFacing: true });
ensureSkill("skill-lightning-beam", "雷电光束", { cooldownSeconds: 8, minRange: 3, maxRange: 10, selectionWeight: 85, lockMovement: true, lockFacing: true });

const nodes = [];
function add(id, name, type, parentId = "", order = 0) {
  const node = {
    id,
    parentId,
    order,
    name,
    type,
    conditionKey: "hasTarget",
    comparison: "isTrue",
    numberValue: 0,
    stringValue: "",
    actionId: "",
    waitUntilComplete: true,
    ignoreSkillCooldown: false,
    durationSeconds: 0.5,
    taskKey: "moveToTarget",
    positionX: 0,
    positionY: 0,
  };
  nodes.push(node);
  return node;
}
function task(id, name, taskKey, parentId, order) {
  const node = add(id, name, "customTask", parentId, order);
  node.taskKey = taskKey;
  return node;
}
function action(id, name, actionId, parentId, order) {
  const node = add(id, name, "playAction", parentId, order);
  node.actionId = actionId;
  node.ignoreSkillCooldown = true;
  return node;
}
function combo(index, name, cooldownSeconds) {
  const cooldown = add(`wolf-combo-${index}-cooldown`, `${name}冷却`, "cooldown", "wolf-combo-random", index - 1);
  cooldown.durationSeconds = cooldownSeconds;
  const sequence = add(`wolf-combo-${index}`, name, "sequence", cooldown.id, 0);
  add(`wolf-combo-${index}-target`, "已发现目标", "condition", sequence.id, 0);
  task(`wolf-combo-${index}-stop`, "连招前停止", "stop", sequence.id, 1);
  task(`wolf-combo-${index}-face`, "面向玩家", "faceTarget", sequence.id, 2);
  return sequence;
}

const root = add("wolf-boss-ai-root-v2", "决策入口", "selector");
add("wolf-combo-random", "随机选择一套连招", "randomSelector", root.id, 0);

const combo1 = combo(1, "冲锋接四连挥爪", 6);
action("wolf-combo-1-charge", "冲锋撞击", "skill-charge-knockback", combo1.id, 3);
action("wolf-combo-1-claw", "四连挥爪", "skill-claw-combo", combo1.id, 4);

const combo2 = combo(2, "隐身背袭接四连挥爪", 6);
action("wolf-combo-2-ambush", "隐身背袭", "skill-shadow-ambush", combo2.id, 3);
action("wolf-combo-2-claw", "四连挥爪", "skill-claw-combo", combo2.id, 4);

const combo3 = combo(3, "背袭冲锋接四连挥爪", 8);
action("wolf-combo-3-ambush", "隐身背袭", "skill-shadow-ambush", combo3.id, 3);
action("wolf-combo-3-charge", "冲锋撞击", "skill-charge-knockback", combo3.id, 4);
action("wolf-combo-3-claw", "四连挥爪", "skill-claw-combo", combo3.id, 5);

const combo4 = combo(4, "三次往返冲锋", 8);
action("wolf-combo-4-charge-1", "第一次冲锋", "skill-charge-knockback", combo4.id, 3);
task("wolf-combo-4-turn-1", "第一次转向", "turnAround", combo4.id, 4);
action("wolf-combo-4-charge-2", "第二次冲锋", "skill-charge-knockback", combo4.id, 5);
task("wolf-combo-4-turn-2", "第二次转向", "turnAround", combo4.id, 6);
action("wolf-combo-4-charge-3", "第三次冲锋", "skill-charge-knockback", combo4.id, 7);

const combo5 = combo(5, "隐身背袭接雷电光束", 8);
action("wolf-combo-5-ambush", "隐身背袭", "skill-shadow-ambush", combo5.id, 3);
action("wolf-combo-5-beam", "雷电光束", "skill-lightning-beam", combo5.id, 4);

task("wolf-select-skill", "选择并释放技能", "useBestSkill", root.id, 1);
task("wolf-chase", "追击玩家", "chase", root.id, 2);
task("wolf-patrol", "场地巡逻", "patrol", root.id, 3);

const children = new Map();
for (const node of nodes) {
  const list = children.get(node.parentId) || [];
  list.push(node);
  children.set(node.parentId, list);
}
for (const list of children.values()) list.sort((left, right) => left.order - right.order);
let leafIndex = 0;
function place(id, depth) {
  const node = nodes.find((candidate) => candidate.id === id);
  const descendants = children.get(id) || [];
  let center;
  if (descendants.length) {
    const centers = descendants.map((child) => place(child.id, depth + 1));
    center = centers.reduce((sum, value) => sum + value, 0) / centers.length;
  } else {
    center = 120 + leafIndex * 230;
    leafIndex += 1;
  }
  node.positionX = Math.round(center - 95);
  node.positionY = 70 + depth * 150;
  return center;
}
place(root.id, 0);

const backupPath = `${projectPath}.before-lightning-skills-v3.bak`;
if (!fs.existsSync(backupPath)) fs.copyFileSync(projectPath, backupPath);
project.enemyBehavior = {
  ...project.enemyBehavior,
  rootNodeId: root.id,
  nodes,
};
fs.writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ projectPath, backupPath, rootNodeId: root.id, nodeCount: nodes.length }, null, 2));
