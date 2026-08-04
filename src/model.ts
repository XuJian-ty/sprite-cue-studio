import type {
  ActionSegment,
  AssetRef,
  AnimationFrame,
  CameraFollowSettings,
  CharacterAction,
  CharacterMotorSettings,
  CharacterProject,
  UnityCharacterSettings,
  TimelineEvent,
  TimelineTrack,
  TrackKind,
  EnemyBehaviorSettings,
  EnemyBehaviorNode,
  EnemyBehaviorNodeType,
  EnemyMovementSettings,
  EnemySkillSettings,
} from "./types";

export function createEnemySkillSettings(): EnemySkillSettings {
  return {
    cooldownSeconds: 1.5,
    minRange: 0,
    maxRange: 1.5,
    selectionWeight: 1,
    lockMovement: true,
    lockFacing: true,
  };
}

export function createEnemyMovementSettings(): EnemyMovementSettings {
  return {
    enabled: true,
    targetTag: "Player",
    detectionRange: 8,
    loseTargetRange: 12,
    verticalTolerance: 2,
    patrolDistance: 3,
    patrolSpeed: 1.5,
    chaseSpeed: 3,
    acceleration: 30,
    stopDistance: 1,
    blockedWaitSeconds: 1.2,
    turnCooldownSeconds: 0.15,
    wallCheckDistance: 0.12,
    ledgeCheckForwardDistance: 0.25,
    ledgeCheckDownDistance: 0.65,
    groundCheckDistance: 0.08,
    environmentLayerName: "Ground",
    gravityScale: 3,
    maxFallSpeed: 18,
  };
}

export function createCameraFollowSettings(): CameraFollowSettings {
  return {
    enabled: true,
    followHorizontal: true,
    followVertical: true,
    smoothTime: 0.15,
    offsetX: 0,
    offsetY: 1.5,
    orthographicSize: 5,
    constrainToMap: true,
    edgePaddingX: 0.25,
    edgePaddingY: 0.25,
  };
}

export function createUnityCharacterSettings(actorLayerName = "Player"): UnityCharacterSettings {
  return {
    prefabPath: "",
    actorLayerName,
    collideWithOtherActors: false,
    colliderShape: "capsule",
    colliderWidth: 0.6,
    colliderHeight: 1.2,
    colliderOffsetX: 0,
    colliderOffsetY: 0.6,
    hurtboxShape: "capsule",
    hurtboxWidth: 0.55,
    hurtboxHeight: 1.1,
    hurtboxOffsetX: 0,
    hurtboxOffsetY: 0.6,
    rigidbodyMass: 1,
  };
}

export function createMotorSettings(): CharacterMotorSettings {
  return {
    enableInput: true,
    enableMotor: true,
    autoFaceMovement: true,
    groundAcceleration: 40,
    groundDeceleration: 55,
    airControl: 0.55,
    gravityScale: 3,
    maxFallSpeed: 18,
    coyoteTime: 0.1,
    jumpBufferTime: 0.12,
    groundCheckDistance: 0.08,
    groundLayerName: "Ground",
    inputDeadZone: 0.15,
  };
}

export const TRACK_META: Record<TrackKind, { label: string; color: string }> = {
  damage: { label: "命中", color: "#e4573d" },
  physics: { label: "物理", color: "#2d7f9d" },
  vfx: { label: "特效", color: "#c17a16" },
  sfx: { label: "音效", color: "#43845a" },
  attribute: { label: "属性", color: "#8a62b4" },
  speed: { label: "速度", color: "#8a5b3d" },
  camera: { label: "镜头", color: "#4c6992" },
};

export function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
}

export function createTrack(kind: TrackKind): TimelineTrack {
  const meta = TRACK_META[kind];
  return { id: uid("track"), name: meta.label, kind, events: [] };
}

export function createSegment(name = "主动作", actionType: CharacterAction["type"] = "custom"): ActionSegment {
  return {
    id: uid("segment"),
    name,
    fps: 12,
    frameCount: 8,
    sheetColumns: 5,
    sheetSpacing: 0,
    sheetPadding: 0,
    cellWidth: 500,
    cellHeight: 500,
    pixelsPerUnit: 160,
    pivotX: actionType === "attack" ? 360 : 230,
    pivotY: actionType === "attack" ? 13 : 110,
    jumpHeight: 2.4,
    frames: [],
    markers: [],
    tracks: (["damage", "physics", "vfx", "sfx", "attribute", "speed", "camera"] as TrackKind[]).map(createTrack),
  };
}

export function createAction(name = "新动作", type: CharacterAction["type"] = "custom"): CharacterAction {
  const comboCount = type === "attack" ? 5 : type === "jump" ? 2 : 1;
  return {
    id: uid("action"),
    name,
    type,
    loop: false,
    acceptMovementInput: type !== "attack",
    acceptJumpInput: false,
    comboCount,
    comboWindow: 0.12,
    repeatWindow: 0.28,
    allowLastRepeat: false,
    doubleTapWindow: 0.28,
    movementSpeed: 4,
    trigger: { type: "none", code: "" },
    transitions: {},
    segments: Array.from({ length: comboCount }, (_, index) => createSegment(comboCount > 1 ? `第 ${index + 1} 段` : "主动作", type)),
  };
}

export function createDropThroughAction(jumpAction?: CharacterAction): CharacterAction {
  const dropThrough = createAction("下跳", "dropThrough");
  dropThrough.id = "drop-through";
  dropThrough.trigger = { type: "keyboardChord", code: "S", secondaryCode: "K" };

  const jumpSegment = jumpAction?.segments?.[0];
  const dropSegment = dropThrough.segments[0];
  if (jumpSegment && dropSegment) {
    dropSegment.fps = jumpSegment.fps;
    dropSegment.pixelsPerUnit = jumpSegment.pixelsPerUnit;
    dropSegment.pivotX = jumpSegment.pivotX;
    dropSegment.pivotY = jumpSegment.pivotY;
  }
  return dropThrough;
}

export function createProject(): CharacterProject {
  const groundIdle = createAction("地面待机", "idleGround");
  groundIdle.id = "ground-idle";
  groundIdle.loop = true;
  const airIdle = createAction("空中待机", "idleAir");
  airIdle.id = "air-idle";
  airIdle.loop = true;
  const walk = createAction("走路", "move");
  walk.id = "walk";
  walk.loop = true;
  walk.trigger = { type: "axisTap", code: "A/D" };
  const run = createAction("跑步", "move");
  run.id = "run";
  run.loop = true;
  run.trigger = { type: "axisDoubleTap", code: "A/D" };
  run.movementSpeed = 7;
  const jump = createAction("跳跃", "jump");
  jump.id = "jump";
  jump.trigger = { type: "keyboard", code: "K" };
  const dropThrough = createDropThroughAction(jump);
  const attack = createAction("普攻", "attack");
  attack.id = "attack";
  attack.trigger = { type: "keyboard", code: "J" };
  const hurt = createAction("受击", "hurt");
  hurt.id = "hurt";
  hurt.trigger = { type: "damage", code: "Damage" };

  groundIdle.transitions = { walk: "interrupt", run: "interrupt", jump: "interrupt", "drop-through": "ignore", attack: "interrupt", hurt: "interrupt" };
  airIdle.transitions = { jump: "interrupt", "drop-through": "ignore", attack: "interrupt", hurt: "interrupt" };
  walk.transitions = { run: "interrupt", jump: "interrupt", "drop-through": "ignore", attack: "interrupt", hurt: "interrupt" };
  run.transitions = { walk: "interrupt", jump: "interrupt", "drop-through": "ignore", attack: "interrupt", hurt: "interrupt" };
  jump.transitions = { walk: "ignore", run: "ignore", "drop-through": "ignore", attack: "interrupt", hurt: "interrupt" };
  dropThrough.transitions = { "ground-idle": "ignore", "air-idle": "ignore", walk: "ignore", run: "ignore", jump: "ignore", attack: "ignore", hurt: "interrupt" };
  attack.transitions = { walk: "ignore", run: "ignore", jump: "ignore", "drop-through": "ignore", attack: "buffer", hurt: "interrupt" };
  hurt.transitions = { "drop-through": "ignore" };
  return {
    format: "frame-action-project",
    version: 12,
    projectKind: "character",
    tickRate: 600,
    characterName: "新角色",
    pixelsPerUnit: 160,
    sourceFacing: "right",
    groundIdleId: groundIdle.id,
    airIdleId: airIdle.id,
    motor: createMotorSettings(),
    cameraFollow: createCameraFollowSettings(),
    unityCharacter: createUnityCharacterSettings(),
    actions: [groundIdle, airIdle, walk, run, jump, dropThrough, attack, hurt],
  };
}

export function createEnemyProject(): CharacterProject {
  const groundIdle = createAction("地面待机", "idleGround");
  groundIdle.id = "ground-idle";
  groundIdle.loop = true;
  const airIdle = createAction("空中待机", "idleAir");
  airIdle.id = "air-idle";
  airIdle.loop = true;
  const walk = createAction("走路", "move");
  walk.id = "walk";
  walk.loop = true;
  const skill = createAction("技能", "skill");
  skill.id = "skill";
  skill.enemySkill = createEnemySkillSettings();
  const hurt = createAction("受击", "hurt");
  hurt.id = "hurt";
  const actions = [groundIdle, airIdle, walk, skill, hurt];
  for (const action of actions) {
    action.comboCount = 1;
    action.trigger = { type: "none", code: "" };
    action.transitions = {};
  }
  const motor = createMotorSettings();
  motor.enableInput = false;
  motor.enableMotor = false;
  const cameraFollow = createCameraFollowSettings();
  cameraFollow.enabled = false;
  return {
    format: "frame-action-project",
    version: 12,
    projectKind: "enemy",
    tickRate: 600,
    characterName: "新敌人",
    pixelsPerUnit: 160,
    sourceFacing: "right",
    groundIdleId: groundIdle.id,
    airIdleId: airIdle.id,
    motor,
    cameraFollow,
    unityCharacter: createUnityCharacterSettings("Enemy"),
    enemyBehavior: createEnemyBehaviorSettings(),
    actions,
  };
}

function createBehaviorNode(name: string, type: EnemyBehaviorNodeType, parentId = "", order = 0): EnemyBehaviorNode {
  return {
    id: uid("behavior"),
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
    ignoreSkillCooldown: type === "playAction",
    durationSeconds: 0.5,
    taskKey: "moveToTarget",
    positionX: 0,
    positionY: 0,
  };
}

export function layoutEnemyBehaviorNodes<T extends { rootNodeId: string; nodes: EnemyBehaviorNode[] }>(settings: T): T {
  const nodesById = new Map(settings.nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, EnemyBehaviorNode[]>();
  for (const node of settings.nodes) {
    const siblings = childrenByParent.get(node.parentId) || [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  for (const children of childrenByParent.values()) children.sort((left, right) => left.order - right.order);

  let leafIndex = 0;
  const visited = new Set<string>();
  const place = (nodeId: string, depth: number): number => {
    const node = nodesById.get(nodeId);
    if (!node || visited.has(nodeId)) return 120 + leafIndex * 230;
    visited.add(nodeId);
    const children = childrenByParent.get(node.id) || [];
    let centerX: number;
    if (children.length) {
      const childCenters = children.map((child) => place(child.id, depth + 1));
      centerX = childCenters.reduce((sum, value) => sum + value, 0) / childCenters.length;
    } else {
      centerX = 120 + leafIndex * 230;
      leafIndex += 1;
    }
    node.positionX = Math.round(centerX - 95);
    node.positionY = 70 + depth * 150;
    return centerX;
  };
  place(settings.rootNodeId, 0);
  for (const node of settings.nodes) {
    if (visited.has(node.id)) continue;
    node.positionX = 25 + leafIndex * 230;
    node.positionY = 70;
    leafIndex += 1;
  }
  return settings;
}

export function createEnemyBehaviorSettings(): EnemyBehaviorSettings {
  const root = createBehaviorNode("决策入口", "selector");
  const skillSequence = createBehaviorNode("技能决策", "sequence", root.id, 0);
  const skillCondition = createBehaviorNode("存在可释放技能", "condition", skillSequence.id, 0);
  skillCondition.conditionKey = "canUseAnySkill";
  skillCondition.comparison = "isTrue";
  const stopBeforeSkill = createBehaviorNode("技能前停止", "customTask", skillSequence.id, 1);
  stopBeforeSkill.taskKey = "stop";
  const useSkill = createBehaviorNode("选择并释放技能", "customTask", skillSequence.id, 2);
  useSkill.taskKey = "useBestSkill";
  const chaseSequence = createBehaviorNode("追击决策", "sequence", root.id, 1);
  const targetCondition = createBehaviorNode("已发现目标", "condition", chaseSequence.id, 0);
  targetCondition.conditionKey = "hasTarget";
  targetCondition.comparison = "isTrue";
  const chase = createBehaviorNode("追击目标", "customTask", chaseSequence.id, 1);
  chase.taskKey = "chase";
  const patrol = createBehaviorNode("地面巡逻", "customTask", root.id, 2);
  patrol.taskKey = "patrol";
  return layoutEnemyBehaviorNodes({
    playGroundIdleOnEnable: true,
    returnToIdleOnComplete: false,
    enabled: true,
    tickIntervalSeconds: 0.1,
    movement: createEnemyMovementSettings(),
    rootNodeId: root.id,
    nodes: [root, skillSequence, skillCondition, stopBeforeSkill, useSkill, chaseSequence, targetCondition, chase, patrol],
  });
}

export function createFrame(assetId: string, name: string, durationTicks = 50): AnimationFrame {
  return {
    id: uid("frame"),
    name,
    assetId,
    durationTicks: Math.max(1, Math.round(durationTicks)),
  };
}

export function createTimelineEvent(kind: TrackKind, startTick: number, pixelsPerUnit = 160, tickRate = 600): TimelineEvent {
  const meta = TRACK_META[kind];
  const base: TimelineEvent = {
    id: uid("event"),
    name: meta.label,
    type: kind,
    startTick,
    durationTicks: 0,
    color: meta.color,
    triggerMode: "once",
    activeDurationMode: "fixed",
    repeatIntervalTicks: 60,
    params: {},
  };

  if (kind === "damage") {
    base.name = "命中事件";
    base.type = "damage";
    base.params = {
      repeatedAnchorMode: "follow",
      damageEffects: [{
        triggerDelayTicks: 0,
        detectionDurationTicks: 0,
        activationTick: 0,
        activationMode: "continuous",
        intermittentActiveTicks: 60,
        intermittentIntervalTicks: 60,
        deduplicationScope: "wholeEvent",
        detectionType: "rangeOverlap",
        hitLayerName: "Enemy",
        anchor: "world",
        useFollowDuration: false,
        followDurationTicks: 0,
        shape: "box",
        centerX: 0.8,
        centerY: 0.9,
        rotation: 0,
        radius: 1.5,
        sectorAngle: 180,
        boxWidth: 1.2,
        boxHeight: 0.7,
        boxGrowthEnabled: false,
        boxGrowthDirection: "right",
        boxGrowthSpeed: 4,
        boxGrowthDurationTicks: Math.max(1, tickRate * 2),
        rayOriginX: 0,
        rayOriginY: 0,
        rayMaxDistance: 10,
        rayRadius: 0,
        physicalLayerName: "Ground",
        physicalMass: 10,
        physicalGravityScale: 1,
        physicalLinearDamping: 0,
        physicalAngularDamping: 0.05,
        physicalFriction: 0.6,
        physicalBounciness: 0,
        physicalAllowRotation: true,
        physicalContinuousCollision: true,
        physicalInitialAngularVelocity: 0,
        physicalInheritCasterVelocity: false,
        physicalIgnoreCasterTicks: 30,
        onHitDamageEffects: [{ delayTicks: 0, damageMultiplier: 1, fixedDamage: 0 }],
        onHitAttributeEffects: [],
        hitStop: { durationTicks: 0, timeScale: 0, pauseCamera: false },
        onHitPhysicsEffects: [],
        companionVfxEffects: [],
        onHitVfxEffects: [],
        onHitSfxEffects: [],
      }],
    };
  } else if (kind === "physics") {
    base.name = "物理事件";
    base.type = "physics";
    base.params = { physicsEffects: [{ effectType: "dashSelf", delayTicks: 0, distance: 1, height: 0, durationMode: "fixed", durationTicks: 0 }] };
  } else if (kind === "vfx") {
    base.name = "特效事件";
    base.type = "vfx";
    base.params = { vfxEffects: [{ assetId: "", frameAssetIds: [], fps: 12, pixelsPerUnit: Math.max(1, pixelsPerUnit), pivotX: 0.5, pivotY: 0.5, renderLayer: "front", loop: false, anchor: "caster", useFollowDuration: false, followDurationTicks: 0, x: 0, y: 0, rotation: 0, scale: 1, triggerDelayTicks: 0, motion: { enabled: false, mode: "linear", speed: 0, directionX: 1, directionY: 0, durationTicks: 180, controlAX: 0.4, controlAY: 0.2, controlBX: 0.8, controlBY: 0.2, endX: 1.2, endY: 0, retargetOnDescendingPath: false, pathProgressCurve: [{ time: 0, value: 0, tangentMode: "linear" }, { time: 1, value: 1, tangentMode: "linear" }] }, destroyMode: "natural", durationTicks: 0 }] };
  } else if (kind === "sfx") {
    base.name = "音效事件";
    base.type = "sfx";
    base.params = { sfxEffects: [{ assetId: "", anchor: "caster", x: 0, y: 0, triggerDelayTicks: 0, loop: false, destroyMode: "natural", durationTicks: 0 }] };
  } else if (kind === "attribute") {
    base.name = "属性事件";
    base.type = "attribute";
    base.params = {
      attributeEffects: [{
        id: uid("attribute"),
        propertyId: "",
        fixedValue: 0,
        references: [],
        changeType: "permanent",
        durationSeconds: 0,
      }],
    };
  } else if (kind === "speed") {
    base.name = "速度事件";
    base.type = "speed";
    base.params = { durationMode: "fixed", castSpeedMultiplier: 1, movementSpeedMultiplier: 1 };
  } else if (kind === "camera") {
    base.name = "镜头事件";
    base.type = "camera";
    base.params = { durationMode: "fixed", positionMode: "hold", offsetX: 0, offsetY: 0, pathStartX: 0, pathStartY: 0, controlAX: 0.4, controlAY: 0.2, controlBX: 0.8, controlBY: 0.2, endX: 1.2, endY: 0, pathProgressCurve: [{ time: 0, value: 0, tangentMode: "linear" }, { time: 1, value: 1, tangentMode: "linear" }], zoom: 1, blendInTicks: 48, blendOutTicks: 60 };
  }
  return base;
}

export function frameBoundaries(segment: ActionSegment): number[] {
  const result = [0];
  let tick = 0;
  for (const frame of segment.frames) {
    tick += Math.max(1, frame.durationTicks);
    result.push(tick);
  }
  return result;
}

export function actionPlaybackDuration(segment: ActionSegment): number {
  return frameBoundaries(segment).at(-1) ?? 0;
}

function frameAssetIds(effect: any): string[] {
  const ids = Array.isArray(effect?.frameAssetIds)
    ? effect.frameAssetIds.filter((id: unknown) => typeof id === "string" && id)
    : [];
  if (!ids.length && effect?.assetId) ids.push(effect.assetId);
  return ids;
}

function vfxLifetime(effect: any, remainingTicks: number, tickRate: number): number {
  if (!effect) return 0;
  if (effect.loop) {
    if (effect.destroyMode === "onActionEnd") return Math.max(0, remainingTicks);
    if (effect.destroyMode === "timed") return Math.max(0, Number(effect.durationTicks) || 0);
    return 0;
  }
  const count = frameAssetIds(effect).length;
  return count > 0 ? count * tickRate / Math.max(1, Number(effect.fps) || 12) : 0;
}

function sfxLifetime(effect: any, remainingTicks: number, tickRate: number, assets: Record<string, AssetRef>): number {
  if (!effect) return 0;
  if (effect.loop) {
    if (effect.destroyMode === "onActionEnd") return Math.max(0, remainingTicks);
    if (effect.destroyMode === "timed") return Math.max(0, Number(effect.durationTicks) || 0);
    return 0;
  }
  return Math.max(0, Number(assets[effect.assetId]?.durationSeconds) || 0) * tickRate;
}

function physicsLifetime(effect: any, remainingTicks: number): number {
  if (!effect) return 0;
  return effect.durationMode === "untilActionEnd" ? Math.max(0, remainingTicks) : Math.max(0, Number(effect.durationTicks) || 0);
}

function damageDetectionLifetime(effect: any): number {
  return Math.max(0, Number(effect?.detectionDurationTicks) || 0);
}

function damageEffectLifetime(effect: any, remainingTicks: number, tickRate: number, assets: Record<string, AssetRef>): number {
  if (!effect) return 0;
  return damageDetectionLifetime(effect);
}

export function timelineEventDisplayDuration(
  event: TimelineEvent,
  kind: TrackKind,
  segment: ActionSegment,
  assets: Record<string, AssetRef> = {},
  tickRate = 600,
): number {
  const baseEnd = actionPlaybackDuration(segment);
  if (kind === "speed" || kind === "camera") {
    return event.params.durationMode === "untilActionEnd"
      ? Math.max(0, baseEnd - event.startTick)
      : Math.max(0, event.durationTicks);
  }

  let repeatedDuration = 0;
  let lastTriggerOffset = 0;
  if (event.triggerMode === "repeated") {
    repeatedDuration = event.activeDurationMode === "untilActionEnd"
      ? Math.max(0, baseEnd - event.startTick)
      : Math.max(0, event.durationTicks);
    const interval = Math.max(1, event.repeatIntervalTicks);
    const lastTriggerLimit = event.activeDurationMode === "untilActionEnd"
      ? Math.max(0, repeatedDuration - 1)
      : repeatedDuration;
    lastTriggerOffset = Math.floor(lastTriggerLimit / interval) * interval;
  }
  const lastTriggerTick = event.startTick + lastTriggerOffset;
  const remainingTicks = Math.max(0, baseEnd - lastTriggerTick);
  let tail = 0;
  if (kind === "damage") {
    for (const effect of event.params.damageEffects || []) tail = Math.max(tail, damageEffectLifetime(effect, remainingTicks, tickRate, assets));
  } else if (kind === "physics") {
    for (const effect of event.params.physicsEffects || []) tail = Math.max(tail, physicsLifetime(effect, remainingTicks));
  } else if (kind === "vfx") {
    for (const effect of event.params.vfxEffects || []) tail = Math.max(tail, vfxLifetime(effect, remainingTicks, tickRate));
  } else if (kind === "sfx") {
    for (const effect of event.params.sfxEffects || []) tail = Math.max(tail, sfxLifetime(effect, remainingTicks, tickRate, assets));
  } else if (kind === "attribute") {
    for (const effect of event.params.attributeEffects || []) {
      if (effect?.changeType === "temporary") tail = Math.max(tail, Math.max(0, Number(effect.durationSeconds) || 0) * tickRate);
    }
  }
  return Math.max(0, repeatedDuration, lastTriggerOffset + tail);
}

export function actionTimelineDuration(segment: ActionSegment, assets: Record<string, AssetRef> = {}, tickRate = 600): number {
  const frameDuration = actionPlaybackDuration(segment);
  const eventDuration = segment.tracks.reduce(
    (max, track) => Math.max(max, ...track.events.map((event) => (
      event.startTick + Math.max(1, timelineEventDisplayDuration(event, track.kind, segment, assets, tickRate) + (event.triggerMode === "repeated" ? 1 : 0))
    )), 0),
    0,
  );
  return Math.max(1, frameDuration, eventDuration);
}

export function segmentDuration(segment: ActionSegment, assets: Record<string, AssetRef> = {}, tickRate = 600): number {
  return Math.max(actionTimelineDuration(segment, assets, tickRate), 300);
}

export function frameAtTick(segment: ActionSegment, tick: number, loop = true): AnimationFrame | undefined {
  const frames = segment.frames;
  if (!frames.length) return undefined;
  const total = frames.reduce((sum, frame) => sum + Math.max(1, frame.durationTicks), 0);
  const normalizedTick = total > 0
    ? loop ? Math.max(0, tick) % total : Math.min(Math.max(0, tick), total - 1)
    : 0;
  let cursor = 0;
  for (const frame of frames) {
    cursor += Math.max(1, frame.durationTicks);
    if (normalizedTick < cursor) return frame;
  }
  return frames.at(-1);
}

export function activeEvents(segment: ActionSegment, tick: number, kind?: TrackKind): TimelineEvent[] {
  const actionEndTick = actionPlaybackDuration(segment);
  return segment.tracks
    .filter((track) => !kind || track.kind === kind)
    .flatMap((track) => track.events)
    .filter((event) => {
      const untilActionEnd = event.params.durationMode === "untilActionEnd"
        || (event.triggerMode === "repeated" && event.activeDurationMode === "untilActionEnd");
      if (untilActionEnd) return tick >= event.startTick && tick <= actionEndTick;
      if (event.durationTicks <= 0) return Math.abs(event.startTick - tick) <= 1;
      return tick >= event.startTick && tick <= event.startTick + event.durationTicks;
    });
}
