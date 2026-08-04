const assert = require("node:assert/strict");
const test = require("node:test");

async function geometry() {
  return import("../src/mapIceGeometry.ts");
}

function options(api, overrides = {}) {
  const defaults = api.createProceduralRigidDefaults(12345);
  return {
    id: "ice-test",
    closureMode: "manual",
    userPoints: [
      { x: 20, y: 20 },
      { x: 140, y: 20 },
      { x: 140, y: 100 },
      { x: 20, y: 100 },
    ],
    ...defaults,
    visual: { ...defaults.visual, edgeJaggedness: 0.45 },
    ...overrides,
  };
}

function denseRectangle(width = 240, height = 140, step = 4) {
  const points = [];
  for (let x = 0; x < width; x += step) points.push({ x, y: 0 });
  for (let y = 0; y < height; y += step) points.push({ x: width, y });
  for (let x = width; x > 0; x -= step) points.push({ x, y: height });
  for (let y = height; y > 0; y -= step) points.push({ x: 0, y });
  return points;
}

function mapOutline(overrides = {}) {
  return {
    id: "map-ice-outline",
    layer: "rigid",
    element: "ice",
    shape: "polygon",
    collisionType: "solid",
    sideCollision: true,
    thickness: 0,
    closed: true,
    points: denseRectangle(),
    ...overrides,
  };
}

test("完整闭合程序刚体生成确定性的暴露边和分面", async () => {
  const api = await geometry();
  const first = api.buildProceduralRigidBody(options(api));
  const second = api.buildProceduralRigidBody(options(api));
  assert.equal(first.ok, true, first.message);
  assert.deepEqual(first, second);
  assert.equal(first.rigidBody.templateId, "iceCrystal");
  assert.equal(first.rigidBody.closureMode, "manual");
  assert.equal(first.rigidBody.edgeRoles.length, first.points.length);
  assert.ok(first.rigidBody.edgeRoles.every((role) => role === "exposed"));
  assert.ok(first.rigidBody.facets.length >= 4);
  assert.equal("melting" in first.rigidBody, false);
  assert.equal("reaction" in first.rigidBody, false);
});

test("不同种子只改变暴露边和晶面，不改变借用地形边", async () => {
  const api = await geometry();
  const terrain = [{
    id: "wall",
    sourceKind: "mapOutline",
    closed: true,
    points: [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
      { x: 0, y: 200 },
    ],
  }];
  const userPoints = [
    { x: 203, y: 40 },
    { x: 260, y: 40 },
    { x: 260, y: 160 },
    { x: 203, y: 160 },
  ];
  const first = api.buildProceduralRigidBody(options(api, { closureMode: "terrain", terrainContours: terrain, userPoints, seed: 11 }));
  const second = api.buildProceduralRigidBody(options(api, { closureMode: "terrain", terrainContours: terrain, userPoints, seed: 99 }));
  assert.equal(first.ok, true, first.message);
  assert.equal(second.ok, true, second.message);
  assert.equal(first.candidates.length, 2);
  assert.equal(first.rigidBody.terrainBinding.sourceId, "wall");
  const attachedEdges = (result) => result.points.map((point, index) => ({
    point,
    next: result.points[(index + 1) % result.points.length],
    role: result.rigidBody.edgeRoles[index],
  })).filter((edge) => edge.role === "terrainAttached");
  assert.deepEqual(attachedEdges(first), attachedEdges(second));
  assert.ok(attachedEdges(first).every((edge) => edge.point.x === 200 && edge.next.x === 200));
  assert.notDeepEqual(first.points, second.points);
});

test("密集自由手绘轮廓按整段弧长重采样后仍产生可见且确定的锯齿", async () => {
  const api = await geometry();
  const userPoints = denseRectangle();
  const first = api.buildProceduralRigidBody(options(api, {
    userPoints,
    seed: 31031,
    visual: { ...api.DEFAULT_PROCEDURAL_RIGID_VISUAL, edgeJaggedness: 0.8, facetScale: 24 },
  }));
  const repeated = api.buildProceduralRigidBody(options(api, {
    userPoints,
    seed: 31031,
    visual: { ...api.DEFAULT_PROCEDURAL_RIGID_VISUAL, edgeJaggedness: 0.8, facetScale: 24 },
  }));
  const rerolled = api.buildProceduralRigidBody(options(api, {
    userPoints,
    seed: 31032,
    visual: { ...api.DEFAULT_PROCEDURAL_RIGID_VISUAL, edgeJaggedness: 0.8, facetScale: 24 },
  }));
  assert.equal(first.ok, true, first.message);
  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first.points, rerolled.points);
  assert.ok(first.points.length < userPoints.length / 2, `重采样点数 ${first.points.length} 未明显少于手绘点数 ${userPoints.length}`);
  const distanceFromAuthoredRectangle = (point) => Math.min(Math.abs(point.x), Math.abs(point.x - 240), Math.abs(point.y), Math.abs(point.y - 140));
  assert.ok(Math.max(...first.points.map(distanceFromAuthoredRectangle)) >= 2, "锯齿偏移应达到肉眼可见的像素幅度");
});

test("自动程序刚体升级稳定且不会重建已有有效数据", async () => {
  const api = await geometry();
  const source = mapOutline();
  const first = api.ensureProgramRigidOutline(source);
  const repeated = api.ensureProgramRigidOutline(mapOutline());
  assert.notStrictEqual(first, source);
  assert.ok(first.rigidBody);
  assert.ok(first.rigidBody.facets.length > 0);
  assert.deepEqual(first, repeated);
  assert.strictEqual(api.ensureProgramRigidOutline(first), first, "已有有效程序刚体数据必须原样保留");

  const invalid = { ...first, rigidBody: { ...first.rigidBody, facets: [] } };
  const repaired = api.ensureProgramRigidOutline(invalid);
  assert.ok(repaired.rigidBody.facets.length > 0, "无效旧数据应在加载时确定性重建");

  const unaffected = [
    mapOutline({ closed: false }),
    mapOutline({ layer: "collision" }),
    mapOutline({ shape: "groundLine" }),
  ];
  for (const outline of unaffected) assert.strictEqual(api.ensureProgramRigidOutline(outline), outline);
});

test("旧冰算法作者数据确定性迁移到程序刚体并保留未来扩展字段", async () => {
  const api = await geometry();
  const current = api.ensureProgramRigidOutline(mapOutline());
  assert.equal(current.rigidBody.schemaVersion, 1);
  assert.equal(current.rigidBody.algorithm, "procedural-rigid-v1");

  const legacyTags = [
    { schemaVersion: 1, algorithm: "procedural-ice-v1" },
    { schemaVersion: 2, algorithm: "procedural-ice-v2" },
    { schemaVersion: 2, algorithm: "procedural-ice-v3" },
  ];
  for (const tags of legacyTags) {
    const legacy = structuredClone(current);
    legacy.iceBody = { ...legacy.rigidBody, schemaVersion: tags.schemaVersion, algorithm: tags.algorithm };
    delete legacy.rigidBody;
    legacy.iceBody.futureBodyParameter = { version: tags.algorithm };
    legacy.iceBody.visual.futureVisualParameter = 0.2718;
    legacy.iceBody.fracture.futureFractureParameter = 1618;
    delete legacy.iceBody.visual.volumeDepth;
    delete legacy.iceBody.fracture.landingBreakEnergy;

    const upgraded = api.ensureProgramRigidOutline(legacy);
    const repeated = api.ensureProgramRigidOutline(structuredClone(legacy));
    assert.deepEqual(upgraded, repeated);
    assert.equal(upgraded.rigidBody.schemaVersion, 1);
    assert.equal(upgraded.rigidBody.algorithm, "procedural-rigid-v1");
    assert.deepEqual(upgraded.rigidBody.futureBodyParameter, { version: tags.algorithm });
    assert.equal(upgraded.rigidBody.visual.futureVisualParameter, 0.2718);
    assert.equal(upgraded.rigidBody.fracture.futureFractureParameter, 1618);
    assert.equal(upgraded.rigidBody.visual.volumeDepth, api.DEFAULT_PROCEDURAL_RIGID_VISUAL.volumeDepth);
    assert.equal(upgraded.rigidBody.fracture.landingBreakEnergy, api.DEFAULT_PROCEDURAL_RIGID_FRACTURE.landingBreakEnergy);
    assert.strictEqual(api.ensureProgramRigidOutline(upgraded), upgraded);
  }
});

test("旧版冰体的过低落地阈值只在精确命中历史默认签名时迁移", async () => {
  const api = await geometry();
  const current = api.ensureProgramRigidOutline(mapOutline());
  const legacy = structuredClone(current);
  legacy.rigidBody.fracture = {
    ...legacy.rigidBody.fracture,
    collisionBreakThreshold: 7,
    landingChipEnergy: 1.5,
    landingCrackEnergy: 4,
    landingBreakEnergy: 9,
    contactStressSensitivity: 1,
  };
  delete legacy.rigidBody.fracture.impactChipEnergy;
  delete legacy.rigidBody.fracture.impactCrackEnergy;
  delete legacy.rigidBody.fracture.impactBreakEnergy;

  const upgraded = api.ensureProgramRigidOutline(legacy);
  assert.equal(upgraded.rigidBody.fracture.impactChipEnergy, 4);
  assert.equal(upgraded.rigidBody.fracture.impactCrackEnergy, 12);
  assert.equal(upgraded.rigidBody.fracture.impactBreakEnergy, 40);
  assert.equal(upgraded.rigidBody.fracture.collisionBreakThreshold, 220);
  assert.equal(upgraded.rigidBody.fracture.landingChipEnergy, 20);
  assert.equal(upgraded.rigidBody.fracture.landingCrackEnergy, 60);
  assert.equal(upgraded.rigidBody.fracture.landingBreakEnergy, 220);

  const custom = structuredClone(legacy);
  custom.rigidBody.fracture.landingBreakEnergy = 17;
  const preserved = api.ensureProgramRigidOutline(custom);
  assert.equal(preserved.rigidBody.fracture.landingChipEnergy, 1.5);
  assert.equal(preserved.rigidBody.fracture.landingCrackEnergy, 4);
  assert.equal(preserved.rigidBody.fracture.landingBreakEnergy, 17);
  assert.equal(preserved.rigidBody.fracture.collisionBreakThreshold, 7);
  assert.equal(preserved.rigidBody.fracture.impactBreakEnergy, 40,
    "缺失的攻击阶段仍应采用当前模板默认值");
});

test("闭合地形的较短和备选路径都可显式选择", async () => {
  const api = await geometry();
  const terrain = [{
    id: "box",
    sourceKind: "mapOutline",
    closed: true,
    points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }],
  }];
  const userPoints = [{ x: 200, y: 40 }, { x: 250, y: 40 }, { x: 250, y: 160 }, { x: 200, y: 160 }];
  const shorter = api.buildProceduralRigidBody(options(api, { closureMode: "terrain", terrainContours: terrain, userPoints, routePreference: "shorter", visual: { ...api.DEFAULT_PROCEDURAL_RIGID_VISUAL, edgeJaggedness: 0 } }));
  const alternate = api.buildProceduralRigidBody(options(api, { closureMode: "terrain", terrainContours: terrain, userPoints, routePreference: "alternate", visual: { ...api.DEFAULT_PROCEDURAL_RIGID_VISUAL, edgeJaggedness: 0 } }));
  assert.equal(shorter.ok, true, shorter.message);
  assert.equal(alternate.ok, true, alternate.message);
  assert.equal(shorter.candidates.length, 2);
  assert.notDeepEqual(shorter.points, alternate.points);
  assert.ok(shorter.candidates[0].terrainLength < shorter.candidates[1].terrainLength);
});

test("端点位于不同地形时拒绝借边闭合", async () => {
  const api = await geometry();
  const terrain = [
    { id: "left", sourceKind: "mapOutline", closed: false, points: [{ x: 20, y: 20 }, { x: 20, y: 180 }] },
    { id: "right", sourceKind: "mapOutline", closed: false, points: [{ x: 220, y: 20 }, { x: 220, y: 180 }] },
  ];
  const result = api.buildProceduralRigidBody(options(api, {
    closureMode: "terrain",
    terrainContours: terrain,
    userPoints: [{ x: 21, y: 30 }, { x: 100, y: 20 }, { x: 219, y: 160 }],
    snapDistance: 8,
  }));
  assert.equal(result.ok, false);
  assert.match(result.message, /同一条/);
});

test("自交轮廓被拒绝", async () => {
  const api = await geometry();
  const result = api.buildProceduralRigidBody(options(api, {
    userPoints: [{ x: 0, y: 0 }, { x: 120, y: 120 }, { x: 0, y: 120 }, { x: 120, y: 0 }],
    visual: { ...api.DEFAULT_PROCEDURAL_RIGID_VISUAL, edgeJaggedness: 0 },
  }));
  assert.equal(result.ok, false);
});

test("晶面数量随冰体面积增加", async () => {
  const api = await geometry();
  const small = api.buildProceduralRigidBody(options(api, {
    userPoints: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }],
    visual: { ...api.DEFAULT_PROCEDURAL_RIGID_VISUAL, edgeJaggedness: 0 },
  }));
  const large = api.buildProceduralRigidBody(options(api, {
    userPoints: [{ x: 0, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 240 }, { x: 0, y: 240 }],
    visual: { ...api.DEFAULT_PROCEDURAL_RIGID_VISUAL, edgeJaggedness: 0 },
  }));
  assert.equal(small.ok, true, small.message);
  assert.equal(large.ok, true, large.message);
  assert.ok(large.rigidBody.facets.length > small.rigidBody.facets.length);
  assert.ok(large.rigidBody.facets.length <= 320);
});

test("大冰体采用分布式局部晶核且不存在单点放射扇", async () => {
  const api = await geometry();
  const body = api.buildProceduralRigidBody(options(api, {
    userPoints: [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 200 }, { x: 0, y: 200 }],
    seed: 91427,
    visual: { ...api.DEFAULT_PROCEDURAL_RIGID_VISUAL, edgeJaggedness: 0, facetScale: 28 },
  }));
  assert.equal(body.ok, true, body.message);
  const degree = new Map();
  for (const facet of body.rigidBody.facets) {
    for (const point of facet.points) {
      const key = `${point.x},${point.y}`;
      degree.set(key, (degree.get(key) || 0) + 1);
    }
  }
  const maximumDegree = Math.max(...degree.values());
  const polygonArea = Math.abs(body.points.reduce((sum, point, index) => {
    const next = body.points[(index + 1) % body.points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) * 0.5);
  const facetArea = body.rigidBody.facets.reduce((sum, facet) => {
    const [a, b, c] = facet.points;
    return sum + Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * 0.5;
  }, 0);
  assert.ok(body.rigidBody.facets.length >= 40, "大刚体需要足够多的局部分面");
  assert.ok(maximumDegree <= 12, `单点连接 ${maximumDegree} 个晶面，仍会形成放射扇`);
  assert.ok(maximumDegree / body.rigidBody.facets.length < 0.12, "不得由一个视觉中心支配整体分面");
  assert.ok(Math.abs(facetArea - polygonArea) <= polygonArea * 0.0001,
    `晶面面积 ${facetArea} 必须完整覆盖碰撞轮廓 ${polygonArea}`);
});

test("命中点破碎预览生成3到8个连续晶面分区且不丢晶面", async () => {
  const api = await geometry();
  const body = api.buildProceduralRigidBody(options(api, {
    userPoints: [{ x: 0, y: 0 }, { x: 220, y: 10 }, { x: 205, y: 170 }, { x: -15, y: 150 }],
    seed: 8801,
  }));
  assert.equal(body.ok, true, body.message);
  const previewOptions = {
    points: body.points,
    rigidBody: body.rigidBody,
    impactPoint: { x: 35, y: 75 },
    incomingDirection: { x: 1, y: 0.2 },
    energy01: 0.72,
  };
  const first = api.buildIceFracturePreview(previewOptions);
  const second = api.buildIceFracturePreview(previewOptions);
  assert.deepEqual(first, second);
  assert.ok(first.fragments.length >= 3 && first.fragments.length <= 8);
  assert.ok(first.cracks.length > 0);
  const assigned = first.fragments.flatMap((fragment) => fragment.facetIds).sort((a, b) => a - b);
  const expected = body.rigidBody.facets.map((facet) => facet.id).sort((a, b) => a - b);
  assert.deepEqual(assigned, expected);
  assert.equal(new Set(assigned).size, assigned.length);
});

test("破碎预览受入射方向和能量控制", async () => {
  const api = await geometry();
  const body = api.buildProceduralRigidBody(options(api, {
    userPoints: [{ x: 0, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 160 }, { x: 0, y: 160 }],
    seed: 773,
  }));
  const common = { points: body.points, rigidBody: body.rigidBody, impactPoint: { x: 45, y: 80 } };
  const low = api.buildIceFracturePreview({ ...common, incomingDirection: { x: 1, y: 0 }, energy01: 0.1 });
  const high = api.buildIceFracturePreview({ ...common, incomingDirection: { x: 1, y: 0 }, energy01: 1 });
  const reverse = api.buildIceFracturePreview({ ...common, incomingDirection: { x: -1, y: 0 }, energy01: 1 });
  assert.ok(high.fragments.length >= low.fragments.length);
  assert.notDeepEqual(high.fragments.map((fragment) => fragment.releaseOffset), reverse.fragments.map((fragment) => fragment.releaseOffset));
});

test("冰木石铁模板按受击和坠落难度递增且各阶段严格分离", async () => {
  const api = await geometry();
  const ordered = ["iceCrystal", "wood", "stone", "metal"].map((id) => api.PROCEDURAL_RIGID_TEMPLATES[id]);
  for (const template of ordered) {
    const fracture = template.fracture;
    assert.match(template.visual.fractureColor, /^#[0-9a-f]{6}$/i,
      `${template.label} 必须提供可编辑的破碎特效色`);
    assert.ok(fracture.impactChipEnergy < fracture.impactCrackEnergy,
      `${template.label} 的攻击崩边阈值必须低于裂纹阈值`);
    assert.ok(fracture.impactCrackEnergy < fracture.impactBreakEnergy,
      `${template.label} 的攻击裂纹阈值必须低于结构断裂阈值`);
    assert.ok(fracture.landingChipEnergy < fracture.landingCrackEnergy,
      `${template.label} 的落地崩边阈值必须低于裂纹阈值`);
    assert.ok(fracture.landingCrackEnergy < fracture.landingBreakEnergy,
      `${template.label} 的落地裂纹阈值必须低于结构断裂阈值`);
  }
  assert.notEqual(ordered[0].visual.fractureColor, ordered[1].visual.fractureColor);
  assert.notEqual(ordered[1].visual.fractureColor, ordered[2].visual.fractureColor);
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(ordered[index - 1].fracture.impactBreakEnergy < ordered[index].fracture.impactBreakEnergy,
      "攻击断裂难度必须按冰、木、石、铁递增");
    assert.ok(ordered[index - 1].fracture.landingBreakEnergy < ordered[index].fracture.landingBreakEnergy,
      "坠落断裂难度必须按冰、木、石、铁递增");
  }
  assert.ok(ordered[3].physical.hardness > ordered[2].physical.hardness);
  assert.ok(ordered[3].physical.toughness > ordered[2].physical.toughness);
  assert.ok(ordered[3].physical.brittleness < ordered[0].physical.brittleness);
});

test("裂解边受命中方向控制且不会汇聚到轮廓单顶点", async () => {
  const api = await geometry();
  const body = api.buildProceduralRigidBody(options(api, {
    userPoints: [
      { x: 0, y: 35 }, { x: 18, y: 5 }, { x: 90, y: -8 }, { x: 178, y: 8 },
      { x: 230, y: 52 }, { x: 218, y: 122 }, { x: 155, y: 158 },
      { x: 68, y: 150 }, { x: 12, y: 112 },
    ],
    seed: 83041,
    visual: { ...api.DEFAULT_PROCEDURAL_RIGID_VISUAL, edgeJaggedness: 0, facetScale: 22 },
  }));
  assert.equal(body.ok, true, body.message);
  const common = { points: body.points, rigidBody: body.rigidBody, impactPoint: { x: 8, y: 78 }, energy01: 0.88 };
  const rising = api.buildIceFracturePreview({ ...common, incomingDirection: { x: 1, y: 0.35 }, seed: 71 });
  const falling = api.buildIceFracturePreview({ ...common, incomingDirection: { x: 1, y: -0.35 }, seed: 71 });
  assert.ok(rising.cracks.length >= 3, "高能命中应生成多段结构裂边");
  assert.notDeepEqual(rising.fragments.map((fragment) => fragment.facetIds),
    falling.fragments.map((fragment) => fragment.facetIds), "相反入射斜率必须改变真实碎片分区");

  const incidence = new Map();
  for (const crack of rising.cracks) {
    for (const point of [crack.start, crack.end]) {
      const key = `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`;
      incidence.set(key, (incidence.get(key) || 0) + 1);
    }
  }
  const dominant = Math.max(...incidence.values());
  assert.ok(dominant < rising.cracks.length,
    `裂纹仍有 ${dominant}/${rising.cracks.length} 条汇聚到同一个点`);
  const outlineKeys = new Set(body.points.map((point) => `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`));
  const dominantOutlineVertex = Math.max(0, ...[...incidence]
    .filter(([key]) => outlineKeys.has(key))
    .map(([, count]) => count));
  assert.ok(dominantOutlineVertex <= Math.max(2, Math.ceil(rising.cracks.length * 0.45)),
    "真实断面不能再从某个轮廓顶点形成放射扇");
});

test("旧版单顶点扇形晶面在工具加载时会确定性重建", async () => {
  const api = await geometry();
  const points = Array.from({ length: 20 }, (_, index) => {
    const angle = index / 20 * Math.PI * 2;
    return { x: 120 + Math.cos(angle) * 100, y: 100 + Math.sin(angle) * 72 };
  });
  const current = api.buildProceduralRigidBody(options(api, {
    id: "legacy-fan",
    userPoints: points,
    seed: 4051,
    visual: { ...api.DEFAULT_PROCEDURAL_RIGID_VISUAL, edgeJaggedness: 0 },
  }));
  assert.equal(current.ok, true, current.message);
  const legacyFacets = [];
  for (let index = 1; index < current.points.length - 1; index += 1) {
    legacyFacets.push({
      id: index,
      points: [current.points[0], current.points[index], current.points[index + 1]],
      shade: index / current.points.length,
    });
  }
  const stale = {
    id: "legacy-fan", layer: "rigid", element: "ice", shape: "polygon", collisionType: "solid",
    sideCollision: true, thickness: 0, closed: true, points: current.points,
    rigidBody: { ...current.rigidBody, facets: legacyFacets },
  };
  assert.equal(api.isValidProgramRigidOutline(stale), false, "旧扇形网格必须判为待修复数据");
  const repaired = api.ensureProgramRigidOutline(stale);
  assert.notDeepEqual(repaired.rigidBody.facets, legacyFacets);
  assert.equal(api.isValidProgramRigidOutline(repaired), true);
  const degree = new Map();
  for (const facet of repaired.rigidBody.facets) {
    for (const point of facet.points) {
      const key = `${point.x},${point.y}`;
      degree.set(key, (degree.get(key) || 0) + 1);
    }
  }
  assert.ok(Math.max(...degree.values()) <= Math.max(12, Math.ceil(repaired.rigidBody.facets.length * 0.15)));
});
