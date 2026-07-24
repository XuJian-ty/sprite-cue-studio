import type { AssetRef, CharacterProject, TimelineEvent, TrackKind } from "./types";

export interface ValidationIssue {
  id: string;
  severity: "error" | "warning";
  message: string;
  actionId: string;
  segmentId: string;
  trackId?: string;
  eventId?: string;
  tick?: number;
}

interface IssueLocation {
  actionId: string;
  segmentId: string;
  trackId?: string;
  eventId?: string;
  tick?: number;
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function effectAssets(effect: any): string[] {
  const ids = Array.isArray(effect?.frameAssetIds)
    ? effect.frameAssetIds.filter((id: unknown) => typeof id === "string" && id)
    : [];
  if (!ids.length && typeof effect?.assetId === "string" && effect.assetId) ids.push(effect.assetId);
  return ids;
}

export function validateProject(project: CharacterProject, assets: Record<string, AssetRef>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const isEnemy = project.projectKind === "enemy";
  const eventIds = new Map<string, IssueLocation>();
  let serial = 0;
  const add = (severity: ValidationIssue["severity"], message: string, location: IssueLocation) => {
    issues.push({ id: `issue-${serial++}`, severity, message, ...location });
  };

  const validateCurve = (curve: unknown, label: string, location: IssueLocation) => {
    if (!Array.isArray(curve) || curve.length < 2) {
      add("error", `${label}至少需要两个关键点`, location);
      return;
    }
    const keys = curve.map((key: any) => ({ time: number(key?.time, -1), value: number(key?.value, -1) })).sort((left, right) => left.time - right.time);
    if (keys.some((key) => key.time < 0 || key.time > 1 || key.value < 0 || key.value > 1)) add("error", `${label}关键点必须位于 0~1`, location);
    if (Math.abs(keys[0].time) > 0.0001 || Math.abs(keys.at(-1)!.time - 1) > 0.0001) add("warning", `${label}建议从时间 0 覆盖到 1`, location);
    for (let index = 1; index < keys.length; index += 1) {
      if (Math.abs(keys[index].time - keys[index - 1].time) < 0.0001) {
        add("error", `${label}存在重叠时间关键点`, location);
        break;
      }
    }
  };

  const validateMotion = (motion: any, label: string, location: IssueLocation) => {
    if (!motion?.enabled) return;
    if ((motion.mode || "linear") === "bezier") {
      if (number(motion.durationTicks) <= 0) add("error", `${label}路径时长必须大于 0`, location);
      validateCurve(motion.pathProgressCurve, `${label}路径曲线`, location);
    } else {
      if (number(motion.speed) <= 0) add("warning", `${label}直线速度为 0`, location);
      if (Math.hypot(number(motion.directionX), number(motion.directionY)) < 0.0001) add("error", `${label}直线方向不能为零`, location);
    }
  };

  const validateVfx = (effect: any, label: string, location: IssueLocation, forceOneShot = false) => {
    const ids = effectAssets(effect);
    if (!ids.length) add("error", `${label}未绑定特效序列`, location);
    else if (ids.some((id) => !assets[id])) add("warning", `${label}引用了当前工具中不可用的特效资源`, location);
    if (number(effect?.fps, 12) <= 0) add("error", `${label}播放 FPS 必须大于 0`, location);
    if (number(effect?.pixelsPerUnit, project.pixelsPerUnit) <= 0) add("error", `${label}的 PPU 必须大于 0`, location);
    if (number(effect?.pivotX, 0.5) < 0 || number(effect?.pivotX, 0.5) > 1) add("error", `${label}的 Pivot X 必须在 0 到 1 之间`, location);
    if (number(effect?.pivotY, 0.5) < 0 || number(effect?.pivotY, 0.5) > 1) add("error", `${label}的 Pivot Y 必须在 0 到 1 之间`, location);
    const loop = !forceOneShot && Boolean(effect?.loop);
    if (loop && !["timed", "onActionEnd", "detectionEnd"].includes(effect?.destroyMode)) add("error", `${label}循环结束条件无效`, location);
    if (loop && effect?.destroyMode === "timed" && number(effect?.durationTicks) <= 0) add("error", `${label}指定时长必须大于 0`, location);
    validateMotion(effect?.motion, label, location);
  };

  const validateSfx = (effect: any, label: string, location: IssueLocation, forceOneShot = false) => {
    if (!effect?.assetId) add("error", `${label}未绑定音频资源`, location);
    else if (!assets[effect.assetId]) add("warning", `${label}引用了当前工具中不可用的音频资源`, location);
    const loop = !forceOneShot && Boolean(effect?.loop);
    if (loop && !["timed", "onActionEnd"].includes(effect?.destroyMode)) add("error", `${label}循环结束条件无效`, location);
    if (loop && effect?.destroyMode === "timed" && number(effect?.durationTicks) <= 0) add("error", `${label}指定时长必须大于 0`, location);
  };

  const validateEvent = (event: TimelineEvent, kind: TrackKind, location: IssueLocation) => {
    if (!event.name.trim()) add("warning", "事件标识为空", location);
    if (!event.id.trim()) add("error", "事件 ID 为空", location);
    else if (eventIds.has(event.id)) add("error", `事件 ID 重复：${event.id}`, location);
    else eventIds.set(event.id, location);
    if (event.startTick < 0) add("error", "触发时间不能小于 0", location);
    if (event.triggerMode === "repeated") {
      if (event.activeDurationMode === "fixed" && event.durationTicks <= 0) add("error", "重复事件持续时间必须大于 0", location);
      if (event.repeatIntervalTicks <= 0) add("error", "重复间隔必须大于 0", location);
      if (event.activeDurationMode === "fixed" && event.repeatIntervalTicks > event.durationTicks) add("warning", "重复间隔大于事件持续时间，只会触发一次", location);
    }
    if ((kind === "speed" || kind === "camera") && event.params.durationMode !== "untilActionEnd" && event.durationTicks <= 0) add("error", `${kind === "speed" ? "速度" : "镜头"}事件持续时间必须大于 0`, location);

    if (kind === "damage") {
      const effects = event.params.damageEffects || [];
      if (!effects.length) add("warning", "命中事件没有检测效果", location);
      effects.forEach((effect: any, index: number) => {
        const label = `命中检测 ${index + 1}`;
        if (!String(effect.hitLayerName || "").trim()) add("error", `${label}的命中层为空`, location);
        const detectionType = effect.detectionType || "rangeOverlap";
        if (detectionType === "raycast") {
          if (number(effect.rayMaxDistance) <= 0) add("error", `${label}的射线距离必须大于 0`, location);
          if (number(effect.rayRadius) < 0) add("error", `${label}的射线半径不能小于 0`, location);
        } else if (detectionType === "rangeOverlap" || detectionType === "physicalEntity") {
          const shape = effect.shape || "box";
          if (shape === "box" && (number(effect.boxWidth) <= 0 || number(effect.boxHeight) <= 0)) add("error", `${label}的盒体尺寸必须大于 0`, location);
          if ((shape === "circle" || shape === "sector") && number(effect.radius) <= 0) add("error", `${label}的半径必须大于 0`, location);
          if (shape === "sector" && (number(effect.sectorAngle) <= 0 || number(effect.sectorAngle) > 360)) add("error", `${label}的扇形角度必须位于 0~360`, location);
          if (detectionType === "physicalEntity") {
            if (shape !== "box" && shape !== "circle") add("error", `${label}的物理实体只支持盒体或圆形`, location);
            if (number(effect.detectionDurationTicks) <= 0) add("error", `${label}的持续时长必须大于 0`, location);
            if (!String(effect.physicalLayerName || "").trim()) add("error", `${label}的实体 Layer 为空`, location);
            if (number(effect.physicalMass) <= 0) add("error", `${label}的质量必须大于 0`, location);
            if (number(effect.physicalGravityScale) < 0) add("error", `${label}的重力倍率不能小于 0`, location);
            if (number(effect.physicalLinearDamping) < 0 || number(effect.physicalAngularDamping) < 0) add("error", `${label}的阻尼不能小于 0`, location);
            if (number(effect.physicalFriction) < 0 || number(effect.physicalFriction) > 1) add("error", `${label}的摩擦力必须位于 0~1`, location);
            if (number(effect.physicalBounciness) < 0 || number(effect.physicalBounciness) > 1) add("error", `${label}的弹性必须位于 0~1`, location);
            if (number(effect.physicalIgnoreCasterTicks) < 0) add("error", `${label}忽略施法者碰撞 Tick 不能小于 0`, location);
          }
        }
        if (effect.boxGrowthEnabled) {
          const shape = effect.shape || "box";
          if (detectionType !== "rangeOverlap" || shape !== "box") add("error", `${label}只有范围检测盒体支持随时间伸长`, location);
          if (!["up", "down", "left", "right"].includes(effect.boxGrowthDirection)) add("error", `${label}的盒体伸长方向无效`, location);
          if (number(effect.boxGrowthSpeed) <= 0) add("error", `${label}的盒体伸长速度必须大于 0`, location);
          if (number(effect.boxGrowthDurationTicks) <= 0) add("error", `${label}的盒体伸长时长必须大于 0`, location);
          if (number(effect.detectionDurationTicks) <= 0) add("error", `${label}启用盒体伸长时检测时长必须大于 0`, location);
          if (number(effect.detectionDurationTicks) > 0 && number(effect.boxGrowthDurationTicks) > number(effect.detectionDurationTicks)) add("warning", `${label}的伸长时长超过检测时长，盒体会在检测结束时提前停止`, location);
        }
        const durationLabel = detectionType === "physicalEntity" ? "持续时长" : "检测时长";
        if (number(effect.detectionDurationTicks) < 0) add("error", `${label}的${durationLabel}不能小于 0`, location);
        if (number(effect.activationTick) < 0) add("error", `${label}的激活时刻不能小于 0`, location);
        if (number(effect.activationTick) > number(effect.detectionDurationTicks)) {
          add("error", `${label}的激活时刻不能大于${durationLabel}`, location);
        }
        if (effect.activationMode === "intermittent" && number(effect.intermittentActiveTicks) <= 0) add("error", `${label}的间歇激活时长必须大于 0`, location);
        if ((effect.anchor || "world") === "world") validateMotion(effect.motion, label, location);
        (effect.companionVfxEffects || []).forEach((cue: any, cueIndex: number) => validateVfx(cue, `${label}伴随特效 ${cueIndex + 1}`, location));
        (effect.onHitVfxEffects || []).forEach((cue: any, cueIndex: number) => validateVfx(cue, `${label}命中特效 ${cueIndex + 1}`, location, true));
        (effect.onHitSfxEffects || []).forEach((cue: any, cueIndex: number) => validateSfx(cue, `${label}命中音效 ${cueIndex + 1}`, location, true));
      });
    } else if (kind === "physics") {
      if (!(event.params.physicsEffects || []).length) add("warning", "物理事件没有物理效果", location);
    } else if (kind === "vfx") {
      const effects = event.params.vfxEffects || [];
      if (!effects.length) add("warning", "特效事件没有特效", location);
      effects.forEach((effect: any, index: number) => validateVfx(effect, `特效 ${index + 1}`, location));
    } else if (kind === "sfx") {
      const effects = event.params.sfxEffects || [];
      if (!effects.length) add("warning", "音效事件没有音效", location);
      effects.forEach((effect: any, index: number) => validateSfx(effect, `音效 ${index + 1}`, location));
    } else if (kind === "camera" && event.params.positionMode === "bezier") {
      validateCurve(event.params.pathProgressCurve, "镜头路径曲线", location);
    }
  };

  if (!project.characterName.trim()) add("error", `${isEnemy ? "敌人" : "角色"}名称为空`, { actionId: project.actions[0]?.id || "", segmentId: project.actions[0]?.segments[0]?.id || "" });
  if (project.pixelsPerUnit <= 0) add("error", "项目默认 PPU 必须大于 0", { actionId: project.actions[0]?.id || "", segmentId: project.actions[0]?.segments[0]?.id || "" });
  const projectLocation = { actionId: project.actions[0]?.id || "", segmentId: project.actions[0]?.segments[0]?.id || "" };
  if (isEnemy) {
    const behavior = project.enemyBehavior;
    if (!behavior) {
      add("error", "敌人行为树配置缺失", projectLocation);
    } else {
      if (behavior.tickIntervalSeconds < 0.02) add("error", "行为树决策间隔不能小于 0.02 秒", projectLocation);
      const movement = behavior.movement;
      if (!movement) {
        add("error", "敌人横向移动配置缺失", projectLocation);
      } else if (movement.enabled) {
        if (movement.detectionRange <= 0) add("error", "敌人发现范围必须大于 0", projectLocation);
        if (movement.loseTargetRange < movement.detectionRange) add("error", "敌人丢失目标范围不能小于发现范围", projectLocation);
        if (movement.patrolDistance < 0 || movement.patrolSpeed < 0 || movement.chaseSpeed < 0) add("error", "敌人巡逻或追击参数不能小于 0", projectLocation);
        if (movement.acceleration <= 0 || movement.maxFallSpeed <= 0) add("error", "敌人加速度和最大下落速度必须大于 0", projectLocation);
        if (movement.wallCheckDistance <= 0 || movement.ledgeCheckDownDistance <= 0 || movement.groundCheckDistance <= 0) add("error", "敌人地面、墙壁或悬崖检测距离必须大于 0", projectLocation);
        if (!movement.environmentLayerName.trim()) add("warning", "敌人没有配置环境 Layer，将检测所有碰撞层", projectLocation);
      }
      const nodesById = new Map<string, typeof behavior.nodes[number]>();
      for (const node of behavior.nodes) {
        if (!node.id.trim()) add("error", "行为树存在空节点 ID", projectLocation);
        else if (nodesById.has(node.id)) add("error", `行为树节点 ID 重复：${node.id}`, projectLocation);
        else nodesById.set(node.id, node);
      }
      if (!nodesById.has(behavior.rootNodeId)) add("error", "行为树入口节点不存在", projectLocation);
      const actionIdsForBehavior = new Set(project.actions.map((item) => item.id));
      for (const node of behavior.nodes) {
        if (!Number.isFinite(node.positionX) || !Number.isFinite(node.positionY)) add("error", `行为节点“${node.name}”的画布坐标无效`, projectLocation);
        if (node.id !== behavior.rootNodeId && !nodesById.has(node.parentId)) add("error", `行为节点“${node.name}”的父节点不存在`, projectLocation);
        if ((node.type === "selector" || node.type === "sequence") && !behavior.nodes.some((item) => item.parentId === node.id)) add("warning", `组合节点“${node.name}”没有子节点`, projectLocation);
        if (node.type === "condition" && !node.conditionKey.trim()) add("error", `条件节点“${node.name}”未配置黑板条件键`, projectLocation);
        if (node.type === "playAction" && !actionIdsForBehavior.has(node.actionId)) add("error", `动作节点“${node.name}”引用了不存在的动作`, projectLocation);
        if (node.type === "wait" && node.durationSeconds < 0) add("error", `等待节点“${node.name}”的时长不能小于 0`, projectLocation);
        if (node.type === "customTask" && !node.taskKey.trim()) add("error", `项目任务节点“${node.name}”未配置任务键`, projectLocation);
        const ancestors = new Set<string>([node.id]);
        let parentId = node.parentId;
        while (parentId) {
          if (ancestors.has(parentId)) { add("error", `行为节点“${node.name}”形成循环引用`, projectLocation); break; }
          ancestors.add(parentId);
          parentId = nodesById.get(parentId)?.parentId || "";
        }
      }
    }
  }
  const prefabPath = project.unityCharacter?.prefabPath || "";
  if (prefabPath && (!prefabPath.startsWith("Assets/") || !prefabPath.toLowerCase().endsWith(".prefab") || prefabPath.split("/").includes(".."))) add("error", "目标角色 Prefab 必须是 Assets 下的 .prefab 路径", projectLocation);
  if (project.unityCharacter.colliderWidth <= 0 || project.unityCharacter.colliderHeight <= 0) add("error", "Unity 身体碰撞体尺寸必须大于 0", projectLocation);
  if (project.unityCharacter.colliderShape === "capsule" && project.unityCharacter.colliderHeight < project.unityCharacter.colliderWidth) add("warning", "竖向胶囊碰撞体高度小于宽度，Unity 会限制其形状", projectLocation);
  if (project.unityCharacter.hurtboxWidth <= 0 || project.unityCharacter.hurtboxHeight <= 0) add("error", "Unity 受击区域尺寸必须大于 0", projectLocation);
  if (project.unityCharacter.hurtboxShape === "capsule" && project.unityCharacter.hurtboxHeight < project.unityCharacter.hurtboxWidth) add("warning", "竖向胶囊受击区域高度小于宽度，Unity 会限制其形状", projectLocation);
  if (project.unityCharacter.rigidbodyMass <= 0) add("error", "Unity 刚体质量必须大于 0", projectLocation);
  if (!isEnemy && project.cameraFollow?.enabled) {
    if (!project.cameraFollow.followHorizontal && !project.cameraFollow.followVertical) add("warning", "摄像机跟随已启用，但横向和纵向跟随均已关闭", projectLocation);
    if (project.cameraFollow.smoothTime < 0) add("error", "摄像机平滑时间不能小于 0", projectLocation);
    if (project.cameraFollow.orthographicSize <= 0) add("error", "摄像机正交尺寸必须大于 0", projectLocation);
    if (project.cameraFollow.edgePaddingX < 0 || project.cameraFollow.edgePaddingY < 0) add("error", "摄像机地图边缘留白不能小于 0", projectLocation);
  }
  const actionIds = new Map<string, IssueLocation>();
  const triggerOwners = new Map<string, IssueLocation>();
  const actionIdSet = new Set(project.actions.map((action) => action.id).filter(Boolean));
  const enemyActionTypes = new Set(["idleGround", "idleAir", "move", "skill", "hurt"]);
  for (const action of project.actions) {
    const location = { actionId: action.id, segmentId: action.segments[0]?.id || "" };
    if (!action.id.trim()) add("error", `${action.name || "未命名动作"}的动作 ID 为空`, location);
    else if (actionIds.has(action.id)) add("error", `动作 ID 重复：${action.id}`, location);
    else actionIds.set(action.id, location);
    if (action.type === "move" && action.movementSpeed < 0) add("error", `${action.name}的移动速度不能小于 0`, location);

    if (isEnemy && !enemyActionTypes.has(action.type)) add("error", `${action.name}使用了敌人模块不支持的动作类型`, location);
    if (isEnemy && action.type === "skill") {
      const skill = action.enemySkill;
      if (!skill) add("error", `${action.name}缺少技能释放配置`, location);
      else {
        if (skill.cooldownSeconds < 0) add("error", `${action.name}的冷却时间不能小于 0`, location);
        if (skill.minRange < 0 || skill.maxRange < skill.minRange) add("error", `${action.name}的释放距离配置无效`, location);
        if (skill.selectionWeight <= 0) add("error", `${action.name}的选择权重必须大于 0`, location);
      }
      if (action.loop) add("warning", `${action.name}是循环技能，自动行为树将一直等待该技能结束`, location);
    }
    const triggerType = isEnemy ? "none" : action.trigger?.type || "none";
    const triggerCode = action.trigger?.code || "";
    if (triggerType !== "none") {
      if (!triggerCode.trim()) add("error", `${action.name}的触发值为空`, location);
      else {
        const secondaryCode = action.trigger?.secondaryCode || "";
        if (triggerType === "keyboardChord" && !secondaryCode.trim()) add("error", `${action.name}的第二个组合按键为空`, location);
        if (triggerType === "keyboardChord" && secondaryCode === triggerCode) add("error", `${action.name}的两个组合按键不能相同`, location);
        const key = `${triggerType}\u0000${triggerCode}\u0000${secondaryCode}`;
        if (triggerOwners.has(key)) add("error", `动作触发重复：${triggerType} / ${triggerCode}`, location);
        else triggerOwners.set(key, location);
      }
    }

    const segmentIds = new Set<string>();
    for (const segment of action.segments) {
      const segmentLocation = { actionId: action.id, segmentId: segment.id };
      if (!segment.id.trim()) add("error", `${action.name}存在空动作段 ID`, segmentLocation);
      else if (segmentIds.has(segment.id)) add("error", `${action.name}的动作段 ID 重复：${segment.id}`, segmentLocation);
      else segmentIds.add(segment.id);
      if (action.type === "jump" && segment.jumpHeight <= 0) add("error", `${action.name}的动作段跳跃高度必须大于 0`, segmentLocation);
    }
    for (const [targetId, policy] of Object.entries(isEnemy ? {} : action.transitions || {})) {
      if (!actionIdSet.has(targetId)) add("warning", `${action.name}引用了不存在的转换目标：${targetId}`, location);
      if (!['interrupt', 'buffer', 'ignore'].includes(policy)) add("error", `${action.name}到 ${targetId} 的转换策略无效`, location);
    }
  }

  const groundIdle = project.actions.find((action) => action.id === project.groundIdleId);
  const airIdle = project.actions.find((action) => action.id === project.airIdleId);
  if (!groundIdle) add("error", "地面待机入口引用了不存在的动作", projectLocation);
  else if (groundIdle.type !== "idleGround") add("warning", "地面待机入口不是地面待机类型", { actionId: groundIdle.id, segmentId: groundIdle.segments[0]?.id || "" });
  if (!airIdle) add("error", "空中待机入口引用了不存在的动作", projectLocation);
  else if (airIdle.type !== "idleAir") add("warning", "空中待机入口不是空中待机类型", { actionId: airIdle.id, segmentId: airIdle.segments[0]?.id || "" });
  if (isEnemy) {
    for (const [type, label] of [["move", "走路"], ["skill", "技能"], ["hurt", "受击"]] as const) {
      if (!project.actions.some((action) => action.type === type)) add("error", `敌人动作列表缺少${label}动作`, projectLocation);
    }
  }

  if (!isEnemy && project.motor?.enableMotor) {
    if (project.motor.groundAcceleration <= 0 || project.motor.groundDeceleration <= 0) add("error", "横版运动加减速度必须大于 0", projectLocation);
    if (project.motor.maxFallSpeed <= 0) add("error", "最大下落速度必须大于 0", projectLocation);
    if (project.motor.airControl < 0 || project.motor.airControl > 1) add("error", "空中控制必须位于 0~1", projectLocation);
    if (project.motor.coyoteTime < 0 || project.motor.jumpBufferTime < 0 || project.motor.groundCheckDistance <= 0) add("error", "横版运动的时间或检测距离配置无效", projectLocation);
    if (!project.motor.groundLayerName.trim()) add("warning", "标准运动未配置地面 Layer，将使用 Runtime 回退层", projectLocation);
    if (!project.actions.some((action) => action.type === "jump" && action.segments.length > 0)) add("warning", "标准运动已启用，但没有可用的跳跃动作", projectLocation);
  }
  if (!isEnemy && project.motor?.enableInput) {
    if (!project.actions.some((action) => action.type === "move" && action.trigger?.type === "axisTap")) add("warning", "标准输入已启用，但没有方向单击移动动作", projectLocation);
    if (project.motor.inputDeadZone < 0 || project.motor.inputDeadZone >= 1) add("error", "输入死区必须位于 0~1", projectLocation);
  }

  for (const action of project.actions) {
    for (const segment of action.segments) {
      const base = { actionId: action.id, segmentId: segment.id };
      if (!segment.frames.length) add("warning", `${action.name} / ${segment.name} 尚未导入动画帧`, base);
      if (segment.pixelsPerUnit <= 0) add("error", `${action.name} / ${segment.name} 的 PPU 必须大于 0`, base);
      for (const track of segment.tracks) {
        for (const event of track.events) {
          validateEvent(event, track.kind, { ...base, trackId: track.id, eventId: event.id, tick: event.startTick });
        }
      }
    }
  }
  return issues;
}
