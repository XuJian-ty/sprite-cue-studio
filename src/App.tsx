import {
  Box,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CirclePause,
  CirclePlay,
  Copy,
  Crosshair,
  Download,
  FolderOpen,
  FolderSync,
  FlipHorizontal2,
  Grid3X3,
  ImagePlus,
  Layers3,
  Lock,
  Map as MapIcon,
  Moon,
  MousePointer2,
  Plus,
  Square,
  Sun,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  X,
  Redo2,
  Unlock,
  Unlink,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ActionInspector from "./components/ActionInspector";
import DeferredTextInput from "./components/DeferredTextInput";
import EnemyBehaviorTreeInspector from "./components/EnemyBehaviorTreeInspector";
import EnemyBehaviorTreeCanvas from "./components/EnemyBehaviorTreeCanvas";
import NumericInput from "./components/NumericInput";
import PreviewCanvas from "./components/PreviewCanvas";
import SkillEventInspector from "./components/SkillEventInspector";
import Timeline from "./components/Timeline";
import MapEditor from "./components/MapEditor";
import {
  activeEvents,
  actionTimelineDuration,
  createAction,
  createCameraFollowSettings,
  createDropThroughAction,
  createEnemyBehaviorSettings,
  createEnemyMovementSettings,
  createEnemyProject,
  createEnemySkillSettings,
  createWolfBossBehaviorSettings,
  ensureWolfBossCombo4TeleportSteps,
  ensureWolfBossExtraCombos,
  ensureWolfBossSkillActions,
  createFrame,
  createMotorSettings,
  createProject,
  createSegment,
  createTrack,
  createTimelineEvent,
  createUnityCharacterSettings,
  frameAtTick,
  frameBoundaries,
  layoutEnemyBehaviorNodes,
  timelineEventDisplayDuration,
  uid,
} from "./model";
import type {
  ActionSegment,
  ActionMarker,
  AssetRef,
  CharacterAction,
  CharacterProject,
  TimelineEvent,
  TimelineTrack,
  TrackKind,
} from "./types";
import { validateProject, type ValidationIssue } from "./validation";
import { loadLastProjectDraft, saveLastProjectDraft } from "./projectDraftStore";
import { readDocumentOrigin, rememberLocalDocument, rememberUnityDocument } from "./workspaceSession";

interface EditorLayout {
  leftPanelWidth: number;
  rightPanelWidth: number;
  timelineHeight: number;
}

const DEFAULT_EDITOR_LAYOUT: EditorLayout = { leftPanelWidth: 248, rightPanelWidth: 340, timelineHeight: 294 };

function clampLayoutValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readEditorLayout(): EditorLayout {
  try {
    const stored = JSON.parse(localStorage.getItem("frameAction.editorLayout") || "null") as Partial<EditorLayout> | null;
    return {
      leftPanelWidth: clampLayoutValue(Number(stored?.leftPanelWidth) || DEFAULT_EDITOR_LAYOUT.leftPanelWidth, 190, 420),
      rightPanelWidth: clampLayoutValue(Number(stored?.rightPanelWidth) || DEFAULT_EDITOR_LAYOUT.rightPanelWidth, 260, 520),
      timelineHeight: clampLayoutValue(Number(stored?.timelineHeight) || DEFAULT_EDITOR_LAYOUT.timelineHeight, 180, 520),
    };
  } catch {
    return DEFAULT_EDITOR_LAYOUT;
  }
}

type BackgroundMode = "transparent" | "light" | "dark";
type InspectorTab = "character" | "action" | "frame" | "behavior";

interface SheetDialogState {
  file: File;
  url: string;
  width: number;
  height: number;
  columns: number;
  frameCount: number;
  spacing: number;
  padding: number;
  cellWidth: number;
  cellHeight: number;
}

interface SyncDialogState {
  path: string;
  phase: "path" | "checking" | "missing" | "outdated" | "syncing" | "overwrite" | "done" | "error";
  message: string;
  runtimeVersion?: string;
  editingPath?: boolean;
}

interface UnityCharacterSummary {
  characterName: string;
  jsonPath: string;
  prefabPath: string;
  generatedPrefab: boolean;
  sharedPrefab: boolean;
  syncedAt: string;
}

function naturalCompare(a: File, b: File): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function unityProjectName(projectPath: string): string {
  const normalized = projectPath.trim().replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized || "Unity 项目";
}

function getSheetLayout(value: SheetDialogState) {
  const columns = Math.max(1, Math.round(value.columns));
  const frameCount = Math.max(1, Math.round(value.frameCount));
  const rows = Math.ceil(frameCount / columns);
  const spacing = Math.max(0, Math.round(value.spacing));
  const padding = Math.max(0, Math.round(value.padding));
  const cellWidth = Math.max(1, Math.round(value.cellWidth));
  const cellHeight = Math.max(1, Math.round(value.cellHeight));
  const requiredWidth = padding * 2 + columns * cellWidth + Math.max(0, columns - 1) * spacing;
  const requiredHeight = padding * 2 + rows * cellHeight + Math.max(0, rows - 1) * spacing;
  return {
    columns,
    frameCount,
    rows,
    spacing,
    padding,
    cellWidth,
    cellHeight,
    requiredWidth,
    requiredHeight,
    fits: requiredWidth <= value.width && requiredHeight <= value.height,
  };
}

function readImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = url;
  });
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("资源读取失败"));
    reader.readAsDataURL(blob);
  });
}

function readAudioDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const finish = (value: number) => {
      audio.removeAttribute("src");
      audio.load();
      resolve(Number.isFinite(value) && value > 0 ? value : 0);
    };
    audio.onloadedmetadata = () => finish(audio.duration);
    audio.onerror = () => finish(0);
    audio.src = url;
  });
}

function collectReferencedAssetIds(project: CharacterProject): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.assetId === "string" && record.assetId) ids.add(record.assetId);
    if (Array.isArray(record.frameAssetIds)) {
      for (const id of record.frameAssetIds) if (typeof id === "string" && id) ids.add(id);
    }
    Object.values(record).forEach(visit);
  };
  visit(project);
  return ids;
}

function collectVfxAssetIds(project: CharacterProject): Set<string> {
  const ids = new Set<string>();
  const addEffect = (effect: any) => {
    if (typeof effect?.assetId === "string" && effect.assetId) ids.add(effect.assetId);
    for (const id of Array.isArray(effect?.frameAssetIds) ? effect.frameAssetIds : []) {
      if (typeof id === "string" && id) ids.add(id);
    }
  };
  for (const action of project.actions) for (const segment of action.segments) for (const track of segment.tracks) {
    if (track.kind === "vfx") {
      for (const event of track.events) for (const effect of event.params.vfxEffects || []) addEffect(effect);
    }
    if (track.kind === "damage") {
      for (const event of track.events) for (const damageEffect of event.params.damageEffects || []) {
        for (const effect of damageEffect.companionVfxEffects || []) addEffect(effect);
        for (const effect of damageEffect.onHitVfxEffects || []) addEffect(effect);
      }
    }
  }
  return ids;
}

function inactiveMotion() {
  return { enabled: false, mode: "linear", speed: 0, directionX: 1, directionY: 0, retargetOnDescendingPath: false, pathProgressCurve: [{ time: 0, value: 0, tangentMode: "linear" }, { time: 1, value: 1, tangentMode: "linear" }] };
}

function normalizeProgressCurve(value: unknown) {
  const keys = Array.isArray(value)
    ? value.map((item: any) => ({ time: Math.min(1, Math.max(0, Number(item?.time) || 0)), value: Math.min(1, Math.max(0, Number(item?.value) || 0)), tangentMode: ["smooth", "flat"].includes(item?.tangentMode) ? item.tangentMode : "linear" }))
    : [];
  if (keys.length < 2) return [{ time: 0, value: 0, tangentMode: "linear" }, { time: 1, value: 1, tangentMode: "linear" }];
  keys.sort((left, right) => left.time - right.time);
  return keys;
}

function normalizeVfxEffect(effect: Record<string, any>, allowTarget: boolean, defaultPixelsPerUnit: number, companion = false, forceOneShot = false) {
  const frameAssetIds = Array.isArray(effect.frameAssetIds)
    ? effect.frameAssetIds.filter((id: unknown) => typeof id === "string" && id)
    : [];
  if (!frameAssetIds.length && typeof effect.assetId === "string" && effect.assetId) frameAssetIds.push(effect.assetId);
  effect.frameAssetIds = frameAssetIds;
  effect.assetId = frameAssetIds[0] || "";
  effect.fps = Math.max(1, Number(effect.fps) || 12);
  effect.pixelsPerUnit = Math.max(1, Number(effect.pixelsPerUnit) || defaultPixelsPerUnit);
  effect.pivotX = Math.min(1, Math.max(0, Number.isFinite(Number(effect.pivotX)) ? Number(effect.pivotX) : 0.5));
  effect.pivotY = Math.min(1, Math.max(0, Number.isFinite(Number(effect.pivotY)) ? Number(effect.pivotY) : 0.5));
  effect.motion ||= inactiveMotion();
  effect.motion.pathProgressCurve = normalizeProgressCurve(effect.motion.pathProgressCurve);
  if (companion) {
    effect.loop = true;
    effect.anchor = "world";
    effect.useFollowDuration = false;
    effect.followDurationTicks = 0;
    effect.triggerDelayTicks = 0;
    effect.motion = inactiveMotion();
    effect.destroyMode = "detectionEnd";
    effect.durationTicks = 0;
    return;
  }
  effect.loop = forceOneShot ? false : Boolean(effect.loop);
  if (!effect.loop) {
    effect.destroyMode = "natural";
    effect.durationTicks = 0;
  } else if (effect.destroyMode !== "timed" && effect.destroyMode !== "onActionEnd") {
    effect.destroyMode = "timed";
    effect.durationTicks = Math.max(1, Number(effect.durationTicks) || 180);
  }
  if (!allowTarget && effect.anchor === "target") effect.anchor = "caster";
  if (!effect.anchor) effect.anchor = "caster";
  if (effect.anchor === "world") {
    effect.useFollowDuration = false;
    effect.followDurationTicks = 0;
  } else {
    effect.motion = inactiveMotion();
  }
  if (!forceOneShot) effect.triggerDelayTicks = 0;
}

function normalizeSfxEffect(effect: Record<string, any>, allowTarget: boolean) {
  if (!allowTarget && effect.anchor === "target") effect.anchor = "caster";
  if (!effect.anchor) effect.anchor = "caster";
  effect.loop = allowTarget ? false : Boolean(effect.loop);
  if (!effect.loop) {
    effect.destroyMode = "natural";
    effect.durationTicks = 0;
  } else if (effect.destroyMode !== "timed" && effect.destroyMode !== "onActionEnd") {
    effect.destroyMode = "timed";
    effect.durationTicks = Math.max(1, Number(effect.durationTicks) || 180);
  }
  if (!allowTarget) effect.triggerDelayTicks = 0;
}

function inferCharacterEntries(project: CharacterProject) {
  const groundIdle = project.actions.find((action) => action.type === "idleGround");
  const airIdle = project.actions.find((action) => action.type === "idleAir");
  project.groundIdleId = groundIdle?.id || project.actions[0]?.id || "";
  project.airIdleId = airIdle?.id || project.groundIdleId;
}

function cleanLegacyProjectData(value: CharacterProject): CharacterProject {
  const project = structuredClone(value);
  const projectRecord = project as CharacterProject & Record<string, unknown>;
  const sourceVersion = Math.max(1, Number(projectRecord.version) || 1);
  delete projectRecord.characterTransform;
  delete projectRecord.editorAssets;
  delete projectRecord.assets;
  delete projectRecord.sync;
  project.tickRate = Math.max(1, Number(project.tickRate) || 600);
  project.pixelsPerUnit = Math.max(1, Number(project.pixelsPerUnit) || 160);
  project.sourceFacing = project.sourceFacing === "left" ? "left" : "right";
  project.actions = Array.isArray(project.actions) ? project.actions : [];
  project.projectKind = project.projectKind === "enemy" ? "enemy" : "character";
  if (project.projectKind === "character" && sourceVersion < 2 && project.actions.length > 0) {
    const jumpAction = project.actions.find((action) => action.type === "jump");
    const existingIds = new Set(project.actions.map((action) => action.id));
    const dropThrough = createDropThroughAction(jumpAction);
    if (existingIds.has(dropThrough.id)) dropThrough.id = uid("drop-through");
    for (const action of project.actions) {
      action.transitions ||= {};
      action.transitions[dropThrough.id] = "ignore";
    }
    dropThrough.transitions = Object.fromEntries(project.actions.map((action) => [action.id, action.type === "hurt" ? "interrupt" : "ignore"]));
    const jumpIndex = jumpAction ? project.actions.indexOf(jumpAction) : project.actions.length - 1;
    project.actions.splice(jumpIndex + 1, 0, dropThrough);
  }
  project.version = 6;
  const defaultMotor = createMotorSettings();
  const legacyMotor = (project.motor || {}) as CharacterProject["motor"] & { walkSpeed?: number; runSpeed?: number; jumpHeight?: number };
  const legacyWalkSpeed = Math.max(0, Number(legacyMotor.walkSpeed) || 4);
  const legacyRunSpeed = Math.max(legacyWalkSpeed, Number(legacyMotor.runSpeed) || 7);
  const legacyJumpHeight = Math.max(0.01, Number(legacyMotor.jumpHeight) || 2.4);
  project.motor = { ...defaultMotor, ...(project.motor || {}) };
  delete (project.motor as CharacterProject["motor"] & Record<string, unknown>).walkSpeed;
  delete (project.motor as CharacterProject["motor"] & Record<string, unknown>).runSpeed;
  delete (project.motor as CharacterProject["motor"] & Record<string, unknown>).jumpHeight;
  project.motor.groundAcceleration = Math.max(0.01, Number(project.motor.groundAcceleration) || defaultMotor.groundAcceleration);
  project.motor.groundDeceleration = Math.max(0.01, Number(project.motor.groundDeceleration) || defaultMotor.groundDeceleration);
  project.motor.airControl = Math.min(1, Math.max(0, Number(project.motor.airControl)));
  project.motor.gravityScale = Math.max(0, Number(project.motor.gravityScale) || defaultMotor.gravityScale);
  project.motor.maxFallSpeed = Math.max(0.01, Number(project.motor.maxFallSpeed) || defaultMotor.maxFallSpeed);
  project.motor.coyoteTime = Math.max(0, Number(project.motor.coyoteTime) || 0);
  project.motor.jumpBufferTime = Math.max(0, Number(project.motor.jumpBufferTime) || 0);
  project.motor.groundCheckDistance = Math.max(0.001, Number(project.motor.groundCheckDistance) || defaultMotor.groundCheckDistance);
  project.motor.groundLayerName = String(project.motor.groundLayerName || defaultMotor.groundLayerName);
  project.motor.inputDeadZone = Math.min(0.95, Math.max(0, Number(project.motor.inputDeadZone) || defaultMotor.inputDeadZone));
  const defaultCameraFollow = createCameraFollowSettings();
  project.cameraFollow = { ...defaultCameraFollow, ...(project.cameraFollow || {}) };
  project.cameraFollow.enabled = project.cameraFollow.enabled !== false;
  project.cameraFollow.followHorizontal = project.cameraFollow.followHorizontal !== false;
  project.cameraFollow.followVertical = project.cameraFollow.followVertical !== false;
  project.cameraFollow.smoothTime = Math.max(0, Number(project.cameraFollow.smoothTime) || 0);
  project.cameraFollow.offsetX = Number(project.cameraFollow.offsetX) || 0;
  project.cameraFollow.offsetY = Number.isFinite(Number(project.cameraFollow.offsetY)) ? Number(project.cameraFollow.offsetY) : defaultCameraFollow.offsetY;
  project.cameraFollow.orthographicSize = Math.max(0.01, Number(project.cameraFollow.orthographicSize) || defaultCameraFollow.orthographicSize);
  project.cameraFollow.constrainToMap = project.cameraFollow.constrainToMap !== false;
  project.cameraFollow.edgePaddingX = Math.max(0, Number(project.cameraFollow.edgePaddingX) || 0);
  project.cameraFollow.edgePaddingY = Math.max(0, Number(project.cameraFollow.edgePaddingY) || 0);
  const defaultUnityCharacter = createUnityCharacterSettings();
  project.unityCharacter = { ...defaultUnityCharacter, ...(project.unityCharacter || {}) };
  project.unityCharacter.prefabPath = String(project.unityCharacter.prefabPath || "").trim().replace(/\\/g, "/");
  project.unityCharacter.collideWithOtherActors = project.unityCharacter.collideWithOtherActors === true;
  project.unityCharacter.colliderShape = project.unityCharacter.colliderShape === "box" ? "box" : "capsule";
  project.unityCharacter.colliderWidth = Math.max(0.01, Number(project.unityCharacter.colliderWidth) || defaultUnityCharacter.colliderWidth);
  project.unityCharacter.colliderHeight = Math.max(0.01, Number(project.unityCharacter.colliderHeight) || defaultUnityCharacter.colliderHeight);
  project.unityCharacter.colliderOffsetX = Number(project.unityCharacter.colliderOffsetX) || 0;
  project.unityCharacter.colliderOffsetY = Number(project.unityCharacter.colliderOffsetY) || 0;
  project.unityCharacter.hurtboxShape = project.unityCharacter.hurtboxShape === "box" ? "box" : "capsule";
  project.unityCharacter.hurtboxWidth = Math.max(0.01, Number(project.unityCharacter.hurtboxWidth) || defaultUnityCharacter.hurtboxWidth);
  project.unityCharacter.hurtboxHeight = Math.max(0.01, Number(project.unityCharacter.hurtboxHeight) || defaultUnityCharacter.hurtboxHeight);
  project.unityCharacter.hurtboxOffsetX = Number(project.unityCharacter.hurtboxOffsetX) || 0;
  project.unityCharacter.hurtboxOffsetY = Number(project.unityCharacter.hurtboxOffsetY) || 0;
  project.unityCharacter.rigidbodyMass = Math.max(0.01, Number(project.unityCharacter.rigidbodyMass) || defaultUnityCharacter.rigidbodyMass);
  if (project.projectKind === "enemy") {
    project.motor.enableInput = false;
    project.motor.enableMotor = false;
    project.cameraFollow.enabled = false;
    if (project.characterName === "狼妖Boss") ensureWolfBossSkillActions(project.actions);
    const defaultBehavior = createEnemyBehaviorSettings();
    const behavior = { ...defaultBehavior, ...(project.enemyBehavior || {}) };
    behavior.playGroundIdleOnEnable = behavior.playGroundIdleOnEnable !== false;
    behavior.returnToIdleOnComplete = behavior.returnToIdleOnComplete === true;
    behavior.enabled = sourceVersion < 5 ? true : behavior.enabled !== false;
    behavior.tickIntervalSeconds = Math.max(0.02, Number(behavior.tickIntervalSeconds) || 0.1);
    const defaultMovement = createEnemyMovementSettings();
    behavior.movement = { ...defaultMovement, ...(behavior.movement || {}) };
    behavior.movement.enabled = behavior.movement.enabled !== false;
    behavior.movement.targetTag = String(behavior.movement.targetTag || defaultMovement.targetTag);
    behavior.movement.detectionRange = Math.max(0, Number(behavior.movement.detectionRange) || defaultMovement.detectionRange);
    behavior.movement.loseTargetRange = Math.max(behavior.movement.detectionRange, Number(behavior.movement.loseTargetRange) || defaultMovement.loseTargetRange);
    behavior.movement.verticalTolerance = Math.max(0, Number(behavior.movement.verticalTolerance) || defaultMovement.verticalTolerance);
    behavior.movement.patrolDistance = Math.max(0, Number(behavior.movement.patrolDistance) || 0);
    behavior.movement.patrolSpeed = Math.max(0, Number(behavior.movement.patrolSpeed) || 0);
    behavior.movement.chaseSpeed = Math.max(0, Number(behavior.movement.chaseSpeed) || 0);
    behavior.movement.acceleration = Math.max(0.01, Number(behavior.movement.acceleration) || defaultMovement.acceleration);
    behavior.movement.stopDistance = Math.max(0, Number(behavior.movement.stopDistance) || 0);
    behavior.movement.blockedWaitSeconds = Math.max(0, Number(behavior.movement.blockedWaitSeconds) || 0);
    behavior.movement.turnCooldownSeconds = Math.max(0, Number(behavior.movement.turnCooldownSeconds) || 0);
    behavior.movement.wallCheckDistance = Math.max(0.001, Number(behavior.movement.wallCheckDistance) || defaultMovement.wallCheckDistance);
    behavior.movement.ledgeCheckForwardDistance = Math.max(0, Number(behavior.movement.ledgeCheckForwardDistance) || 0);
    behavior.movement.ledgeCheckDownDistance = Math.max(0.001, Number(behavior.movement.ledgeCheckDownDistance) || defaultMovement.ledgeCheckDownDistance);
    behavior.movement.groundCheckDistance = Math.max(0.001, Number(behavior.movement.groundCheckDistance) || defaultMovement.groundCheckDistance);
    behavior.movement.environmentLayerName = String(behavior.movement.environmentLayerName || defaultMovement.environmentLayerName);
    behavior.movement.gravityScale = Math.max(0, Number(behavior.movement.gravityScale) || 0);
    behavior.movement.maxFallSpeed = Math.max(0.01, Number(behavior.movement.maxFallSpeed) || defaultMovement.maxFallSpeed);
    behavior.nodes = Array.isArray(behavior.nodes) ? behavior.nodes : [];
    const legacyDefaultTree = sourceVersion < 5
      && behavior.nodes.length === 5
      && behavior.nodes.some((node) => node.type === "playAction" && node.actionId === "skill")
      && behavior.nodes.some((node) => node.type === "playAction" && node.actionId === "ground-idle")
      && !behavior.nodes.some((node) => node.type === "customTask");
    if (legacyDefaultTree || !behavior.nodes.length || !behavior.nodes.some((node) => node.id === behavior.rootNodeId)) {
      project.enemyBehavior = defaultBehavior;
    } else {
      behavior.nodes = behavior.nodes.map((node, index) => ({
        id: String(node.id || uid("behavior")),
        parentId: String(node.parentId || ""),
        order: Number.isFinite(Number(node.order)) ? Number(node.order) : index,
        name: String(node.name || "行为节点"),
        type: ["selector", "randomSelector", "sequence", "cooldown", "repeat", "inverter", "condition", "playAction", "wait", "customTask"].includes(node.type) ? node.type : "condition",
        conditionKey: String(node.conditionKey || "hasTarget"),
        comparison: ["isTrue", "isFalse", "less", "lessOrEqual", "greater", "greaterOrEqual", "equal"].includes(node.comparison) ? node.comparison : "isTrue",
        numberValue: Number(node.numberValue) || 0,
        stringValue: String(node.stringValue || ""),
        actionId: String(node.actionId || ""),
        waitUntilComplete: node.waitUntilComplete !== false,
        ignoreSkillCooldown: node.type === "playAction" || node.ignoreSkillCooldown === true,
        durationSeconds: Math.max(0, Number(node.durationSeconds) || 0),
        taskKey: String(node.taskKey || "moveToTarget"),
        positionX: Number.isFinite(Number(node.positionX)) ? Number(node.positionX) : 0,
        positionY: Number.isFinite(Number(node.positionY)) ? Number(node.positionY) : 0,
      }));
      if (behavior.nodes.every((node) => node.positionX === 0 && node.positionY === 0)) layoutEnemyBehaviorNodes(behavior);
      project.enemyBehavior = behavior;
    }
    if (project.characterName === "狼妖Boss" && (project.enemyBehavior?.rootNodeId === "wolf-ai-root"
      || !project.enemyBehavior?.nodes.some((node) => node.id === "wolf-combo-5"))) {
      project.enemyBehavior = createWolfBossBehaviorSettings(project.enemyBehavior, project.actions);
    }
    if (project.characterName === "狼妖Boss" && project.enemyBehavior) {
      project.enemyBehavior = ensureWolfBossCombo4TeleportSteps(project.enemyBehavior, project.actions);
      project.enemyBehavior = ensureWolfBossExtraCombos(project.enemyBehavior, project.actions);
    }
  }
  for (const action of project.actions) {
    delete (action as CharacterAction & Record<string, unknown>).transform;
    action.transitions ||= {};
    action.trigger ||= { type: "none", code: "" };
    if (project.projectKind === "enemy") {
      action.transitions = {};
      action.trigger = { type: "none", code: "" };
      action.comboCount = 1;
      if (action.type === "skill") {
        const defaults = createEnemySkillSettings();
        action.enemySkill = { ...defaults, ...(action.enemySkill || {}) };
        action.enemySkill.cooldownSeconds = Math.max(0, Number(action.enemySkill.cooldownSeconds) || 0);
        action.enemySkill.minRange = Math.max(0, Number(action.enemySkill.minRange) || 0);
        action.enemySkill.maxRange = Math.max(action.enemySkill.minRange, Number(action.enemySkill.maxRange) || defaults.maxRange);
        action.enemySkill.selectionWeight = Math.max(0.01, Number(action.enemySkill.selectionWeight) || defaults.selectionWeight);
        action.enemySkill.lockMovement = action.enemySkill.lockMovement !== false;
        action.enemySkill.lockFacing = action.enemySkill.lockFacing !== false;
      } else {
        delete action.enemySkill;
      }
    } else {
      delete action.enemySkill;
    }
    action.trigger.code = String(action.trigger.code || "");
    if (action.trigger.type === "keyboardChord") {
      action.trigger.code ||= "S";
      action.trigger.secondaryCode = String(action.trigger.secondaryCode || "K");
      if (action.trigger.secondaryCode === action.trigger.code) action.trigger.secondaryCode = action.trigger.code === "K" ? "S" : "K";
    } else {
      delete action.trigger.secondaryCode;
    }
    action.movementSpeed = Math.max(0, Number(action.movementSpeed) || (action.trigger.type === "axisDoubleTap" ? legacyRunSpeed : legacyWalkSpeed));
    action.segments ||= [];
    if (!action.segments.length) action.segments.push(createSegment("主动作", action.type));
    for (const segment of action.segments) {
      segment.frames ||= [];
      segment.markers ||= [];
      segment.pixelsPerUnit = Math.max(1, Number(segment.pixelsPerUnit) || project.pixelsPerUnit);
      segment.jumpHeight = Math.max(0.01, Number(segment.jumpHeight) || legacyJumpHeight);
      segment.tracks = (segment.tracks || []).filter((track) => String(track.kind) !== "attribute");
      for (const kind of ["damage", "physics", "vfx", "sfx", "speed", "camera"] as TrackKind[]) {
        if (!segment.tracks.some((track) => track.kind === kind)) segment.tracks.push(createTrack(kind));
      }
      for (const track of segment.tracks) {
        track.events ||= [];
          for (const timelineEvent of track.events) {
            const params = timelineEvent.params || {};
            delete params.attributeEffects;
          if (track.kind === "vfx") for (const effect of params.vfxEffects || []) normalizeVfxEffect(effect, true, project.pixelsPerUnit);
          if (track.kind === "sfx") for (const effect of params.sfxEffects || []) normalizeSfxEffect(effect, false);
          for (const damageEffect of params.damageEffects || []) {
            damageEffect.detectionType = ["rangeOverlap", "raycast", "physicalEntity"].includes(damageEffect.detectionType)
              ? damageEffect.detectionType
              : "rangeOverlap";
            damageEffect.detectionDurationTicks = Math.max(0, Number(damageEffect.detectionDurationTicks) || 0);
            damageEffect.activationTick = Math.min(Math.max(0, Number(damageEffect.activationTick) || 0), damageEffect.detectionDurationTicks);
            if ((damageEffect.anchor || "world") === "world") {
              damageEffect.useFollowDuration = false;
              damageEffect.followDurationTicks = 0;
            } else {
              damageEffect.useFollowDuration = Boolean(damageEffect.useFollowDuration);
              damageEffect.followDurationTicks = Math.max(0, Math.round(Number(damageEffect.followDurationTicks) || 0));
            }
            damageEffect.boxGrowthEnabled = Boolean(damageEffect.boxGrowthEnabled);
            damageEffect.boxGrowthDirection = ["up", "down", "left", "right"].includes(damageEffect.boxGrowthDirection) ? damageEffect.boxGrowthDirection : "right";
            damageEffect.boxGrowthSpeed = Number.isFinite(Number(damageEffect.boxGrowthSpeed)) ? Math.max(0, Number(damageEffect.boxGrowthSpeed)) : 4;
            damageEffect.boxGrowthDurationTicks = Number.isFinite(Number(damageEffect.boxGrowthDurationTicks))
              ? Math.max(1, Math.round(Number(damageEffect.boxGrowthDurationTicks)))
              : Math.max(1, project.tickRate * 2);
            damageEffect.motion ||= inactiveMotion();
            damageEffect.motion.pathProgressCurve = normalizeProgressCurve(damageEffect.motion.pathProgressCurve);
            damageEffect.physicalLayerName ||= "Ground";
            damageEffect.physicalMass = Math.max(0.01, Number(damageEffect.physicalMass) || 10);
            damageEffect.physicalGravityScale = Number.isFinite(Number(damageEffect.physicalGravityScale)) ? Math.max(0, Number(damageEffect.physicalGravityScale)) : 1;
            damageEffect.physicalLinearDamping = Math.max(0, Number(damageEffect.physicalLinearDamping) || 0);
            damageEffect.physicalAngularDamping = Number.isFinite(Number(damageEffect.physicalAngularDamping)) ? Math.max(0, Number(damageEffect.physicalAngularDamping)) : 0.05;
            damageEffect.physicalFriction = Number.isFinite(Number(damageEffect.physicalFriction)) ? Math.min(1, Math.max(0, Number(damageEffect.physicalFriction))) : 0.6;
            damageEffect.physicalBounciness = Math.min(1, Math.max(0, Number(damageEffect.physicalBounciness) || 0));
            damageEffect.physicalAllowRotation = damageEffect.physicalAllowRotation !== false;
            damageEffect.physicalContinuousCollision = damageEffect.physicalContinuousCollision !== false;
            damageEffect.physicalInitialAngularVelocity = Number(damageEffect.physicalInitialAngularVelocity) || 0;
            damageEffect.physicalInheritCasterVelocity = Boolean(damageEffect.physicalInheritCasterVelocity);
            damageEffect.physicalIgnoreCasterTicks = Number.isFinite(Number(damageEffect.physicalIgnoreCasterTicks)) ? Math.max(0, Math.round(Number(damageEffect.physicalIgnoreCasterTicks))) : 30;
            delete damageEffect.physicalInitialVelocityX;
            delete damageEffect.physicalInitialVelocityY;
            delete damageEffect.onHitAttributeEffects;
            if (damageEffect.detectionType === "physicalEntity") {
              damageEffect.shape = damageEffect.shape === "circle" ? "circle" : "box";
            }
            if ((damageEffect.anchor || "world") !== "world") {
              damageEffect.motion = inactiveMotion();
            }
            for (const effect of damageEffect.companionVfxEffects || []) normalizeVfxEffect(effect, false, project.pixelsPerUnit, true);
            for (const effect of damageEffect.onHitVfxEffects || []) normalizeVfxEffect(effect, true, project.pixelsPerUnit, false, true);
            for (const effect of damageEffect.onHitSfxEffects || []) normalizeSfxEffect(effect, true);
          }
          if (track.kind === "camera") {
            params.pathProgressCurve = normalizeProgressCurve(params.pathProgressCurve);
            delete params.lockInput;
          }
        }
      }
      for (const frame of segment.frames) {
        const legacyFrame = frame as typeof frame & Record<string, unknown>;
        delete legacyFrame.transform;
        delete legacyFrame.enabled;
      }
      for (const track of segment.tracks) {
        for (const timelineEvent of track.events) {
          const params = timelineEvent.params || {};
          const stack: unknown[] = [params];
          while (stack.length) {
            const current = stack.pop();
            if (!current || typeof current !== "object") continue;
            if (Array.isArray(current)) stack.push(...current);
            else {
              const record = current as Record<string, unknown>;
              if (record.motion && typeof record.motion === "object") delete (record.motion as Record<string, unknown>).retargetOnReturn;
              stack.push(...Object.values(record));
            }
          }
        }
      }
    }
  }
  inferCharacterEntries(project);
  return project;
}

function Field({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  integer = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  integer?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <NumericInput value={value} step={step} min={min} max={max} integer={integer} onValueChange={onChange} />
    </label>
  );
}

export default function App() {
  const [activeModule, setActiveModule] = useState<"character" | "enemy" | "map">(() => {
    const stored = localStorage.getItem("frameAction.activeModule");
    return stored === "map" || stored === "enemy" ? stored : "character";
  });
  const isEnemy = activeModule === "enemy";
  const actorKind = isEnemy ? "enemy" : "character";
  const [characterProject, setCharacterProject] = useState<CharacterProject>(() => createProject());
  const [enemyProject, setEnemyProject] = useState<CharacterProject>(() => createEnemyProject());
  const [characterAssets, setCharacterAssets] = useState<Record<string, AssetRef>>({});
  const [enemyAssets, setEnemyAssets] = useState<Record<string, AssetRef>>({});
  const project = isEnemy ? enemyProject : characterProject;
  const setProject = isEnemy ? setEnemyProject : setCharacterProject;
  const assets = isEnemy ? enemyAssets : characterAssets;
  const setAssets = isEnemy ? setEnemyAssets : setCharacterAssets;
  const [selectedActionId, setSelectedActionId] = useState("ground-idle");
  const [selectedSegmentId, setSelectedSegmentId] = useState(project.actions[0].segments[0].id);
  const [selectedEvent, setSelectedEvent] = useState<{ trackId: string; eventId: string } | null>(null);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [playheadTick, setPlayheadTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [background, setBackground] = useState<BackgroundMode>("transparent");
  const [showGrid, setShowGrid] = useState(true);
  const [showBoxes, setShowBoxes] = useState(true);
  const [showTarget, setShowTarget] = useState(true);
  const [sceneEditMode, setSceneEditMode] = useState(false);
  const [previewFacingLeft, setPreviewFacingLeft] = useState(false);
  const [canvasHandleTarget, setCanvasHandleTarget] = useState("");
  const [lockedCanvasTargets, setLockedCanvasTargets] = useState<string[]>([]);
  const [previewTarget, setPreviewTarget] = useState({ x: 2, y: 0 });
  const [sheetDialog, setSheetDialog] = useState<SheetDialogState | null>(null);
  const [syncDialog, setSyncDialog] = useState<SyncDialogState | null>(null);
  const [unityCharacters, setUnityCharacters] = useState<UnityCharacterSummary[]>([]);
  const [selectedUnityCharacterPath, setSelectedUnityCharacterPath] = useState(() => {
    const origin = readDocumentOrigin(activeModule === "enemy" ? "enemy" : "character");
    return origin.kind === "unity" ? origin.jsonPath : "";
  });
  const [editingUnityEnemyPath, setEditingUnityEnemyPath] = useState(() => {
    const origin = readDocumentOrigin("enemy");
    return origin.kind === "unity" ? origin.jsonPath : "";
  });
  const [editingUnityCharacterPath, setEditingUnityCharacterPath] = useState(() => {
    const origin = readDocumentOrigin("character");
    return origin.kind === "unity" ? origin.jsonPath : "";
  });
  const editingUnityActorPath = isEnemy ? editingUnityEnemyPath : editingUnityCharacterPath;
  const setEditingUnityActorPath = isEnemy ? setEditingUnityEnemyPath : setEditingUnityCharacterPath;
  const [loadingUnityCharacter, setLoadingUnityCharacter] = useState(false);
  const [pendingUnityEnemyDeletion, setPendingUnityEnemyDeletion] = useState<UnityCharacterSummary | null>(null);
  const [deletingUnityEnemy, setDeletingUnityEnemy] = useState(false);
  const [pendingEnemyOverwrite, setPendingEnemyOverwrite] = useState<UnityCharacterSummary | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("character");
  const [selectedBehaviorNodeId, setSelectedBehaviorNodeId] = useState(() => enemyProject.enemyBehavior?.rootNodeId || "");
  const [hasEventClipboard, setHasEventClipboard] = useState(false);
  const [stackTimelineEvents, setStackTimelineEvents] = useState(() => localStorage.getItem("frameAction.stackTimelineEvents") !== "false");
  const [editorLayout, setEditorLayout] = useState<EditorLayout>(readEditorLayout);
  const [characterUnityProjectPath, setCharacterUnityProjectPath] = useState(() => {
    const origin = readDocumentOrigin("character");
    return localStorage.getItem("frameAction.unityProjectPath") || (origin.kind === "unity" ? origin.projectPath : "");
  });
  const [enemyUnityProjectPath, setEnemyUnityProjectPath] = useState(() => {
    const origin = readDocumentOrigin("enemy");
    return localStorage.getItem("frameAction.enemyUnityProjectPath") || (origin.kind === "unity" ? origin.projectPath : "");
  });
  const boundUnityProjectPath = isEnemy ? enemyUnityProjectPath : characterUnityProjectPath;
  const setBoundUnityProjectPath = isEnemy ? setEnemyUnityProjectPath : setCharacterUnityProjectPath;
  const [characterStatus, setCharacterStatus] = useState(() => characterUnityProjectPath ? "已绑定角色 Unity 项目 · 等待同步" : "角色草稿 · 尚未绑定 Unity");
  const [enemyStatus, setEnemyStatus] = useState(() => enemyUnityProjectPath ? "已绑定敌人 Unity 项目 · 等待同步" : "敌人草稿 · 尚未绑定 Unity");
  const status = isEnemy ? enemyStatus : characterStatus;
  const setStatus = isEnemy ? setEnemyStatus : setCharacterStatus;
  const [draftHydrated, setDraftHydrated] = useState(false);
  const selectedCanvasEventIdRef = useRef<string | null>(null);
  const sequenceInputRef = useRef<HTMLInputElement>(null);
  const sheetInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const lastPlaybackTime = useRef(0);
  const previousTick = useRef(0);
  const historyRef = useRef<{ past: CharacterProject[]; future: CharacterProject[]; lastKey: string; lastAt: number }>({ past: [], future: [], lastKey: "", lastAt: 0 });
  const eventClipboardRef = useRef<{ kind: TrackKind; event: TimelineEvent } | null>(null);
  const [, setHistoryRevision] = useState(0);

  const restoreEditorProject = (nextProject: CharacterProject, nextAssets: Record<string, AssetRef>, message: string, kind: "character" | "enemy" = actorKind) => {
    const cleaned = cleanLegacyProjectData(nextProject);
    const restoredAssets = Object.fromEntries(Object.entries(nextAssets).map(([id, asset]) => [id, { ...asset, url: asset.dataUrl || asset.url }])) as Record<string, AssetRef>;
    const targetSetProject = kind === "enemy" ? setEnemyProject : setCharacterProject;
    const targetSetAssets = kind === "enemy" ? setEnemyAssets : setCharacterAssets;
    const targetSetStatus = kind === "enemy" ? setEnemyStatus : setCharacterStatus;
    historyRef.current = { past: [], future: [], lastKey: "", lastAt: 0 };
    setHistoryRevision((value) => value + 1);
    targetSetProject(cleaned);
    targetSetAssets(restoredAssets);
    targetSetStatus(message);
    if (kind === actorKind) {
      setSelectedActionId(cleaned.actions[0].id);
      setSelectedSegmentId(cleaned.actions[0].segments[0].id);
      setSelectedEvent(null);
      setSelectedMarkerId(null);
      setPlayheadTick(0);
      setInspectorTab("character");
    }
  };

  useEffect(() => {
    localStorage.setItem("frameAction.editorLayout", JSON.stringify(editorLayout));
  }, [editorLayout]);

  useEffect(() => {
    localStorage.setItem("frameAction.stackTimelineEvents", String(stackTimelineEvents));
  }, [stackTimelineEvents]);

  useEffect(() => {
    let cancelled = false;
    const restoreKind = async (kind: "character" | "enemy") => {
      const draft = await loadLastProjectDraft(kind);
        if (cancelled) return;
        const origin = readDocumentOrigin(kind);
        let draftProject: CharacterProject | null = null;
        if (draft?.project && origin.kind !== "default") {
          draftProject = cleanLegacyProjectData(draft.project);
          const requiredAssets = collectReferencedAssetIds(draftProject);
          const missingAssets = [...requiredAssets].some((id) => !draft.assets?.[id]);
          if (missingAssets && origin.kind === "unity") {
            // Recover large resources from Unity while retaining unsynced local configuration.
          } else {
          const message = origin.kind === "unity"
            ? `已恢复上次${kind === "enemy" ? "敌人" : "角色"} · ${draftProject.characterName}`
            : `已恢复上次${kind === "enemy" ? "敌人" : "角色"}本地草稿`;
          restoreEditorProject(draftProject, draft.assets || {}, message, kind);
          return;
          }
        }
        if (origin.kind !== "unity") return;
        const response = await fetch(kind === "enemy" ? "/api/unity/load-enemy" : "/api/unity/load-character", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectPath: origin.projectPath, jsonPath: origin.jsonPath }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || `上次${kind === "enemy" ? "敌人" : "角色"}载入失败`);
        const unityAssets = Object.fromEntries((result.assets || []).map((asset: AssetRef) => [asset.id, { ...asset, url: asset.dataUrl || asset.url }]));
        const restoredAssets = { ...unityAssets, ...(draft?.assets || {}) } as Record<string, AssetRef>;
        const restoredProject = draftProject || cleanLegacyProjectData(result.project);
        if (!cancelled) {
          restoreEditorProject(restoredProject, restoredAssets, `${draftProject ? "已恢复" : "已重新打开"}上次${kind === "enemy" ? "敌人" : "角色"} · ${restoredProject.characterName}`, kind);
          await saveLastProjectDraft(restoredProject, restoredAssets, kind);
        }
    };
    void Promise.all([
      restoreKind("character").catch((error) => console.warn("[Frame Action] 上次角色恢复失败，已使用默认数据", error)),
      restoreKind("enemy").catch((error) => console.warn("[Frame Action] 上次敌人恢复失败，已使用默认数据", error)),
    ])
      .finally(() => { if (!cancelled) setDraftHydrated(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!draftHydrated) return;
    const timer = window.setTimeout(() => {
      void saveLastProjectDraft(cleanLegacyProjectData(characterProject), characterAssets, "character").catch((error) => console.warn("[Frame Action] 角色草稿保存失败", error));
      void saveLastProjectDraft(cleanLegacyProjectData(enemyProject), enemyAssets, "enemy").catch((error) => console.warn("[Frame Action] 敌人草稿保存失败", error));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [characterProject, characterAssets, enemyProject, enemyAssets, draftHydrated]);

  useEffect(() => {
    if (!draftHydrated) return;
    const persistImmediately = () => {
      void saveLastProjectDraft(cleanLegacyProjectData(characterProject), characterAssets, "character").catch((error) => console.warn("[Frame Action] 关闭前保存角色草稿失败", error));
      void saveLastProjectDraft(cleanLegacyProjectData(enemyProject), enemyAssets, "enemy").catch((error) => console.warn("[Frame Action] 关闭前保存敌人草稿失败", error));
    };
    const handleVisibilityChange = () => { if (document.visibilityState === "hidden") persistImmediately(); };
    window.addEventListener("pagehide", persistImmediately);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", persistImmediately);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [characterProject, characterAssets, enemyProject, enemyAssets, draftHydrated]);

  useEffect(() => {
    if (selectedEvent || selectedMarkerId) setInspectorTab("action");
  }, [selectedEvent, selectedMarkerId]);

  useEffect(() => {
    if (!isEnemy || !project.enemyBehavior) return;
    if (!project.enemyBehavior.nodes.some((node) => node.id === selectedBehaviorNodeId)) setSelectedBehaviorNodeId(project.enemyBehavior.rootNodeId);
  }, [isEnemy, project.enemyBehavior, selectedBehaviorNodeId]);

  const startPanelResize = (pointerEvent: React.PointerEvent<HTMLDivElement>, target: "left" | "right" | "timeline") => {
    if (pointerEvent.button !== 0) return;
    pointerEvent.preventDefault();
    const startX = pointerEvent.clientX;
    const startY = pointerEvent.clientY;
    const startLayout = editorLayout;
    const parentRect = pointerEvent.currentTarget.parentElement?.getBoundingClientRect();
    document.body.classList.add(target === "timeline" ? "resizing-row" : "resizing-column");
    const handleMove = (moveEvent: PointerEvent) => {
      if (target === "timeline") {
        const maximum = Math.max(180, (parentRect?.height || window.innerHeight) - 48 - 5 - 180);
        setEditorLayout((current) => ({ ...current, timelineHeight: clampLayoutValue(startLayout.timelineHeight - (moveEvent.clientY - startY), 180, maximum) }));
        return;
      }
      const availableWidth = parentRect?.width || window.innerWidth;
      if (target === "left") {
        const maximum = Math.max(190, Math.min(420, availableWidth - startLayout.rightPanelWidth - 490));
        setEditorLayout((current) => ({ ...current, leftPanelWidth: clampLayoutValue(startLayout.leftPanelWidth + (moveEvent.clientX - startX), 190, maximum) }));
      } else {
        const maximum = Math.max(260, Math.min(520, availableWidth - startLayout.leftPanelWidth - 490));
        setEditorLayout((current) => ({ ...current, rightPanelWidth: clampLayoutValue(startLayout.rightPanelWidth - (moveEvent.clientX - startX), 260, maximum) }));
      }
    };
    const handleUp = () => {
      document.body.classList.remove("resizing-column", "resizing-row");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const action = project.actions.find((item) => item.id === selectedActionId) ?? project.actions[0];
  const segment = action.segments.find((item) => item.id === selectedSegmentId) ?? action.segments[0];
  const frame = frameAtTick(segment, playheadTick, action.loop);
  const duration = actionTimelineDuration(segment, assets, project.tickRate);
  const selectedTimelineEvent = selectedEvent
    ? segment.tracks.flatMap((track) => track.events).find((event) => event.id === selectedEvent.eventId) ?? null
    : null;
  const selectedTrack = selectedEvent ? segment.tracks.find((track) => track.id === selectedEvent.trackId) ?? null : null;
  const selectedMarker = selectedMarkerId ? segment.markers.find((marker) => marker.id === selectedMarkerId) ?? null : null;
  const validationIssues = useMemo(() => validateProject(project, assets), [project, assets]);
  const validationErrors = validationIssues.filter((issue) => issue.severity === "error").length;
  const canvasHandleOptions = useMemo<{ value: string; label: string }[]>(() => {
    let eventOptions: { value: string; label: string }[] = [];
    if (selectedTimelineEvent && selectedTrack?.kind === "damage") {
      eventOptions = (selectedTimelineEvent.params.damageEffects || []).flatMap((effect: any, damageIndex: number) => [
        { value: `damage:${damageIndex}`, label: `命中范围 ${damageIndex + 1}` },
        ...(effect.companionVfxEffects || []).map((_: any, effectIndex: number) => ({ value: `companion:${damageIndex}:${effectIndex}`, label: `伴随特效 ${damageIndex + 1}-${effectIndex + 1}` })),
        ...(effect.onHitVfxEffects || []).map((_: any, effectIndex: number) => ({ value: `hit:${damageIndex}:${effectIndex}`, label: `命中特效 ${damageIndex + 1}-${effectIndex + 1}` })),
      ]);
    } else if (selectedTimelineEvent && selectedTrack?.kind === "vfx") {
      eventOptions = (selectedTimelineEvent.params.vfxEffects || []).map((_: any, effectIndex: number) => ({ value: `top:${effectIndex}`, label: `特效 ${effectIndex + 1}` }));
    } else if (selectedTimelineEvent && selectedTrack?.kind === "camera") {
      eventOptions = [{ value: "camera", label: "镜头" }];
    }
    return [...eventOptions, { value: "bodyCollider", label: `${isEnemy ? "敌人" : "角色"}身体碰撞体` }, { value: "hurtbox", label: `${isEnemy ? "敌人" : "角色"}受击区域` }];
  }, [selectedTimelineEvent, selectedTrack, isEnemy]);
  const canvasLockKey = canvasHandleTarget === "bodyCollider" || canvasHandleTarget === "hurtbox"
    ? `character:${canvasHandleTarget}`
    : selectedEvent?.eventId && canvasHandleTarget ? `${selectedEvent.eventId}:${canvasHandleTarget}` : "";
  const canvasHandlesLocked = Boolean(canvasLockKey && lockedCanvasTargets.includes(canvasLockKey));

  const mutateProject = (mutator: (draft: CharacterProject) => void, historyKey = "general") => {
    setProject((current) => {
      const now = performance.now();
      const history = historyRef.current;
      const coalesce = history.lastKey === historyKey && now - history.lastAt < 450;
      if (!coalesce) {
        history.past.push(structuredClone(current));
        if (history.past.length > 100) history.past.shift();
        history.future = [];
      }
      history.lastKey = historyKey;
      history.lastAt = now;
      const next = structuredClone(current);
      mutator(next);
      inferCharacterEntries(next);
      return next;
    });
    setHistoryRevision((value) => value + 1);
    setStatus("有未同步修改");
  };

  const undoProject = () => {
    const history = historyRef.current;
    if (!history.past.length) return;
    setProject((current) => {
      const previous = history.past.pop()!;
      history.future.push(structuredClone(current));
      history.lastKey = "";
      return previous;
    });
    setHistoryRevision((value) => value + 1);
    setStatus("已撤销 · 有未同步修改");
  };

  const redoProject = () => {
    const history = historyRef.current;
    if (!history.future.length) return;
    setProject((current) => {
      const next = history.future.pop()!;
      history.past.push(structuredClone(current));
      history.lastKey = "";
      return next;
    });
    setHistoryRevision((value) => value + 1);
    setStatus("已重做 · 有未同步修改");
  };

  const findDraftSegment = (draft: CharacterProject) => {
    const draftAction = draft.actions.find((item) => item.id === selectedActionId) ?? draft.actions[0];
    return draftAction.segments.find((item) => item.id === selectedSegmentId) ?? draftAction.segments[0];
  };

  useEffect(() => {
    const nextEventId = selectedTimelineEvent?.id ?? null;
    if (selectedCanvasEventIdRef.current !== nextEventId) {
      selectedCanvasEventIdRef.current = nextEventId;
      const eventOption = canvasHandleOptions.find((option) => option.value !== "bodyCollider" && option.value !== "hurtbox");
      if (eventOption) {
        setCanvasHandleTarget(eventOption.value);
        return;
      }
    }
    if (!canvasHandleOptions.some((option) => option.value === canvasHandleTarget)) setCanvasHandleTarget(canvasHandleOptions[0]?.value || "");
  }, [canvasHandleOptions, canvasHandleTarget, selectedTimelineEvent?.id]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("frame-action-event-clipboard");
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (parsed?.kind && parsed?.event) {
        eventClipboardRef.current = parsed;
        setHasEventClipboard(true);
      }
    } catch {
      localStorage.removeItem("frame-action-event-clipboard");
    }
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    lastPlaybackTime.current = performance.now();
    const tick = (time: number) => {
      const deltaSeconds = Math.min(0.1, Math.max(0, (time - lastPlaybackTime.current) / 1000));
      lastPlaybackTime.current = time;
      setPlayheadTick((current) => {
        const speed = activeEvents(segment, current, "speed").reduce(
          (value, event) => value * Number(event.params.castSpeedMultiplier || 1),
          1,
        );
        const next = current + deltaSeconds * project.tickRate * speed;
        if (next >= duration) {
          if (action.loop) return next % duration;
          setPlaying(false);
          return 0;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, action.loop, duration, project.tickRate, segment]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoProject(); else undoProject();
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoProject();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  });

  useEffect(() => {
    const resolvedAction = project.actions.find((item) => item.id === selectedActionId) ?? project.actions[0];
    if (resolvedAction.id !== selectedActionId) setSelectedActionId(resolvedAction.id);
    const resolvedSegment = resolvedAction.segments.find((item) => item.id === selectedSegmentId) ?? resolvedAction.segments[0];
    if (resolvedSegment.id !== selectedSegmentId) setSelectedSegmentId(resolvedSegment.id);
    if (selectedEvent && !resolvedSegment.tracks.some((track) => track.id === selectedEvent.trackId && track.events.some((event) => event.id === selectedEvent.eventId))) setSelectedEvent(null);
    if (selectedMarkerId && !resolvedSegment.markers.some((marker) => marker.id === selectedMarkerId)) setSelectedMarkerId(null);
  }, [project, selectedActionId, selectedSegmentId, selectedEvent, selectedMarkerId]);

  useEffect(() => {
    if (!playing) {
      previousTick.current = playheadTick;
      return;
    }
    const previous = previousTick.current;
    const wrapped = playheadTick < previous;
    const sfxEvents = segment.tracks.find((track) => track.kind === "sfx")?.events ?? [];
    for (const event of sfxEvents) {
      const crossed = wrapped ? event.startTick > previous || event.startTick <= playheadTick : event.startTick > previous && event.startTick <= playheadTick;
      if (crossed) {
        for (const effect of event.params.sfxEffects || []) {
          if (!effect.assetId || !assets[effect.assetId]) continue;
          const audio = new Audio(assets[effect.assetId].url);
          audio.loop = Boolean(effect.loop);
          void audio.play().catch(() => undefined);
        }
      }
    }
    previousTick.current = playheadTick;
  }, [playheadTick, playing, segment, assets]);

  const switchAction = (id: string) => {
    const nextAction = project.actions.find((item) => item.id === id);
    if (!nextAction) return;
    setSelectedActionId(id);
    setSelectedSegmentId(nextAction.segments[0].id);
    setSelectedEvent(null);
    setSelectedMarkerId(null);
    setPlayheadTick(0);
  };

  const addAction = () => {
    const next = createAction(isEnemy ? `技能 ${project.actions.filter((item) => item.type === "skill").length + 1}` : `动作 ${project.actions.length + 1}`, isEnemy ? "skill" : "custom");
    if (isEnemy) {
      next.trigger = { type: "none", code: "" };
      next.transitions = {};
      next.enemySkill = createEnemySkillSettings();
    }
    next.segments.forEach((item) => (item.pixelsPerUnit = project.pixelsPerUnit));
    mutateProject((draft) => draft.actions.push(next));
    setSelectedActionId(next.id);
    setSelectedSegmentId(next.segments[0].id);
    setPlayheadTick(0);
  };

  const duplicateAction = () => {
    const clone = structuredClone(action);
    clone.id = uid("action");
    clone.name = `${action.name} 副本`;
    clone.segments.forEach((item) => {
      item.id = uid("segment");
      item.frames.forEach((entry) => (entry.id = uid("frame")));
      item.markers.forEach((entry) => (entry.id = uid("marker")));
      item.tracks.forEach((track) => {
        track.id = uid("track");
        track.events.forEach((event) => (event.id = uid("event")));
      });
    });
    mutateProject((draft) => draft.actions.push(clone));
    setSelectedActionId(clone.id);
    setSelectedSegmentId(clone.segments[0].id);
    setPlayheadTick(0);
  };

  const canDeleteAction = project.actions.length > 1 && (!isEnemy || project.actions.filter((item) => item.type === action.type).length > 1);

  const deleteAction = () => {
    if (!canDeleteAction) return;
    const nextIndex = Math.max(0, project.actions.findIndex((item) => item.id === action.id) - 1);
    const nextAction = project.actions[nextIndex];
    mutateProject((draft) => {
      draft.actions = draft.actions.filter((item) => item.id !== action.id);
      for (const item of draft.actions) delete item.transitions[action.id];
      if (draft.groundIdleId === action.id) draft.groundIdleId = draft.actions.find((item) => item.type === "idleGround")?.id || nextAction.id;
      if (draft.airIdleId === action.id) draft.airIdleId = draft.actions.find((item) => item.type === "idleAir")?.id || draft.groundIdleId;
      for (const node of draft.enemyBehavior?.nodes || []) {
        if (node.type === "playAction" && node.actionId === action.id) node.actionId = draft.actions.find((item) => item.type === action.type)?.id || draft.groundIdleId;
      }
    });
    switchAction(nextAction.id);
  };

  const moveAction = (direction: -1 | 1) => {
    const index = project.actions.findIndex((item) => item.id === action.id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= project.actions.length) return;
    mutateProject((draft) => {
      const [moved] = draft.actions.splice(index, 1);
      draft.actions.splice(targetIndex, 0, moved);
    });
  };

  const addSegment = () => {
    const next = createSegment(`动作段 ${action.segments.length + 1}`, action.type);
    next.pixelsPerUnit = project.pixelsPerUnit;
    mutateProject((draft) => {
      const target = draft.actions.find((item) => item.id === action.id)!;
      target.segments.push(next);
      if (target.type === "attack" || target.type === "jump") target.comboCount = target.segments.length;
    });
    setSelectedSegmentId(next.id);
    setSelectedMarkerId(null);
    setPlayheadTick(0);
  };

  const deleteSegment = () => {
    if (action.segments.length <= 1) return;
    const currentIndex = action.segments.findIndex((item) => item.id === segment.id);
    const nextIndex = Math.max(0, currentIndex - 1);
    const nextSegment = action.segments[nextIndex];
    mutateProject((draft) => {
      const target = draft.actions.find((item) => item.id === action.id)!;
      target.segments = target.segments.filter((item) => item.id !== segment.id);
      if (target.type === "attack" || target.type === "jump") target.comboCount = target.segments.length;
    });
    setSelectedSegmentId(nextSegment.id);
    setSelectedEvent(null);
    setSelectedMarkerId(null);
    setPlayheadTick(0);
  };

  const addImageAsset = async (file: File, url = URL.createObjectURL(file), usage: AssetRef["usage"] = "character"): Promise<AssetRef> => {
    const size = await readImageSize(url);
    return { id: uid("asset"), name: file.name, kind: "image", usage, url, dataUrl: await readDataUrl(file), ...size };
  };

  const importSequence = async (files: File[]) => {
    const sorted = [...files].filter((file) => file.type.startsWith("image/")).sort(naturalCompare);
    if (!sorted.length) return;
    const nextAssets = await Promise.all(sorted.map((file) => addImageAsset(file)));
    setAssets((current) => Object.fromEntries([...Object.entries(current), ...nextAssets.map((asset) => [asset.id, asset])]));
    mutateProject((draft) => {
      const target = findDraftSegment(draft);
      const durationTicks = draft.tickRate / Math.max(1, target.fps);
      target.frames.push(...nextAssets.map((asset) => createFrame(asset.id, asset.name, durationTicks)));
      target.frameCount = target.frames.length;
      target.cellWidth = Math.max(1, nextAssets[0].width ?? target.cellWidth);
      target.cellHeight = Math.max(1, nextAssets[0].height ?? target.cellHeight);
    });
    setPlayheadTick(0);
    setStatus(`已导入 ${nextAssets.length} 帧，等待同步`);
  };

  const prepareSpriteSheet = async (file: File) => {
    const url = URL.createObjectURL(file);
    const size = await readImageSize(url);
    const columns = Math.max(1, segment.sheetColumns);
    const frameCount = Math.max(1, segment.frameCount);
    const rows = Math.ceil(frameCount / columns);
    const spacing = Math.max(0, segment.sheetSpacing);
    const padding = Math.max(0, segment.sheetPadding);
    const derivedCellWidth = Math.max(1, Math.floor((size.width - padding * 2 - spacing * (columns - 1)) / columns));
    const derivedCellHeight = Math.max(1, Math.floor((size.height - padding * 2 - spacing * (rows - 1)) / rows));
    setSheetDialog({
      file,
      url,
      ...size,
      columns,
      frameCount,
      spacing,
      padding,
      cellWidth: segment.spriteSheetAssetId ? segment.cellWidth : derivedCellWidth,
      cellHeight: segment.spriteSheetAssetId ? segment.cellHeight : derivedCellHeight,
    });
  };

  const sliceSpriteSheet = async () => {
    if (!sheetDialog) return;
    const image = new Image();
    image.src = sheetDialog.url;
    await image.decode();
    const layout = getSheetLayout(sheetDialog);
    if (!layout.fits) {
      setStatus(`Sprite Sheet 参数超出图片范围：需要 ${layout.requiredWidth}×${layout.requiredHeight}，图片为 ${sheetDialog.width}×${sheetDialog.height}`);
      return;
    }
    const { columns, frameCount, spacing, padding, cellWidth, cellHeight } = layout;
    const sheetAsset = await addImageAsset(sheetDialog.file, sheetDialog.url);
    const nextAssets: AssetRef[] = [];

    for (let index = 0; index < frameCount; index += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = cellWidth;
      canvas.height = cellHeight;
      const context = canvas.getContext("2d")!;
      const column = index % columns;
      const row = Math.floor(index / columns);
      context.drawImage(
        image,
        padding + column * (cellWidth + spacing),
        padding + row * (cellHeight + spacing),
        cellWidth,
        cellHeight,
        0,
        0,
        cellWidth,
        cellHeight,
      );
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
      nextAssets.push({
        id: uid("asset"),
        name: `${sheetDialog.file.name.replace(/\.[^.]+$/, "")}_${String(index + 1).padStart(3, "0")}.png`,
        kind: "image",
        url: URL.createObjectURL(blob),
        dataUrl: await readDataUrl(blob),
        width: cellWidth,
        height: cellHeight,
      });
    }

    setAssets((current) => Object.fromEntries([...Object.entries(current), [sheetAsset.id, sheetAsset], ...nextAssets.map((asset) => [asset.id, asset])]));
    mutateProject((draft) => {
      const target = findDraftSegment(draft);
      const durationTicks = draft.tickRate / Math.max(1, target.fps);
      target.frames.push(...nextAssets.map((asset) => createFrame(asset.id, asset.name, durationTicks)));
      target.spriteSheetAssetId = sheetAsset.id;
      target.sheetColumns = columns;
      target.sheetSpacing = spacing;
      target.sheetPadding = padding;
      target.cellWidth = cellWidth;
      target.cellHeight = cellHeight;
      target.frameCount = frameCount;
    });
    setSheetDialog(null);
    setPlayheadTick(0);
    setStatus(`已从 Sprite Sheet 拆分 ${nextAssets.length} 帧，原图未修改`);
  };

  const selectFrame = (frameId: string) => {
    const index = segment.frames.findIndex((item) => item.id === frameId);
    const boundaries = frameBoundaries(segment);
    if (index >= 0) setPlayheadTick(boundaries[index]);
    setSelectedEvent(null);
    setSelectedMarkerId(null);
  };

  const updateFrame = (frameId: string, patch: Partial<(typeof segment.frames)[number]>) => {
    mutateProject((draft) => {
      const target = findDraftSegment(draft).frames.find((item) => item.id === frameId);
      if (target) Object.assign(target, patch);
    });
  };

  const deleteFrame = (frameId: string) => {
    mutateProject((draft) => {
      const target = findDraftSegment(draft);
      target.frames = target.frames.filter((item) => item.id !== frameId);
      target.frameCount = target.frames.length;
    });
    setPlayheadTick(0);
  };

  const clearSegmentFrames = () => {
    const count = segment.frames.length;
    if (!count || !window.confirm(`确定清空当前动作段的 ${count} 个动画帧吗？`)) return;
    mutateProject((draft) => {
      const target = findDraftSegment(draft);
      target.frames = [];
      target.frameCount = 0;
      delete target.spriteSheetAssetId;
    }, `frames:clear:${segment.id}`);
    setPlayheadTick(0);
    setStatus("当前动作段动画帧已清空");
  };

  const moveFrame = (direction: -1 | 1) => {
    if (!frame) return;
    const index = segment.frames.findIndex((item) => item.id === frame.id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= segment.frames.length) return;
    const reordered = [...segment.frames];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved);
    mutateProject((draft) => {
      findDraftSegment(draft).frames = reordered;
    });
    setPlayheadTick(reordered.slice(0, targetIndex).reduce((sum, item) => sum + Math.max(1, item.durationTicks), 0));
  };

  const addTimelineEvent = (track: TimelineTrack, startTick: number) => {
    const event = createTimelineEvent(track.kind, Math.round(startTick), project.pixelsPerUnit, project.tickRate);
    if (isEnemy && track.kind === "damage") {
      for (const effect of event.params.damageEffects || []) effect.hitLayerName = "Player";
    }
    mutateProject((draft) => {
      const targetTrack = findDraftSegment(draft).tracks.find((item) => item.id === track.id)!;
      targetTrack.events.push(event);
    });
    setSelectedEvent({ trackId: track.id, eventId: event.id });
  };

  const updateTimelineEvent = (trackId: string, eventId: string, patch: Partial<TimelineEvent>) => {
    mutateProject((draft) => {
      const event = findDraftSegment(draft)
        .tracks.find((track) => track.id === trackId)
        ?.events.find((item) => item.id === eventId);
      if (event) Object.assign(event, patch);
    }, `event:${eventId}`);
  };

  const updateEventById = (eventId: string, patch: Partial<TimelineEvent>) => {
    const track = segment.tracks.find((item) => item.events.some((event) => event.id === eventId));
    if (track) updateTimelineEvent(track.id, eventId, patch);
  };

  const resizeTimelineEvent = (trackId: string, eventId: string, displayDuration: number) => {
    const track = segment.tracks.find((item) => item.id === trackId);
    const event = track?.events.find((item) => item.id === eventId);
    if (!track || !event) return;
    if (track.kind === "speed" || track.kind === "camera") {
      updateTimelineEvent(trackId, eventId, { durationTicks: Math.max(10, Math.round(displayDuration)) });
      return;
    }
    if (event.triggerMode === "repeated") {
      const onceEvent = { ...event, triggerMode: "once" as const, durationTicks: 0 };
      const tailDuration = timelineEventDisplayDuration(onceEvent, track.kind, segment, assets, project.tickRate);
      updateTimelineEvent(trackId, eventId, { durationTicks: Math.max(10, Math.round(displayDuration - tailDuration)) });
    }
  };

  const duplicateSelectedEvent = () => {
    if (!selectedTimelineEvent || !selectedTrack) return;
    const clone = structuredClone(selectedTimelineEvent);
    clone.id = uid("event");
    clone.startTick += 20;
    clone.name = `${clone.name} 副本`;
    mutateProject((draft) => {
      findDraftSegment(draft).tracks.find((track) => track.id === selectedTrack.id)!.events.push(clone);
    });
    setSelectedEvent({ trackId: selectedTrack.id, eventId: clone.id });
  };

  const copySelectedEvent = () => {
    if (!selectedTimelineEvent || !selectedTrack) return;
    const clipboard = { kind: selectedTrack.kind, event: structuredClone(selectedTimelineEvent) };
    eventClipboardRef.current = clipboard;
    localStorage.setItem("frame-action-event-clipboard", JSON.stringify(clipboard));
    setHasEventClipboard(true);
    setStatus(`已复制${selectedTimelineEvent.name}，可粘贴到任意动作段`);
  };

  const pasteEventAtPlayhead = () => {
    const clipboard = eventClipboardRef.current;
    if (!clipboard) return;
    const targetTrack = segment.tracks.find((track) => track.kind === clipboard.kind);
    if (!targetTrack) return;
    const clone = structuredClone(clipboard.event);
    clone.id = uid("event");
    clone.startTick = Math.max(0, Math.round(playheadTick));
    mutateProject((draft) => {
      const draftTrack = findDraftSegment(draft).tracks.find((track) => track.kind === clipboard.kind);
      if (!draftTrack) return;
      draftTrack.events.push(clone);
      draftTrack.events.sort((left, right) => left.startTick - right.startTick || left.name.localeCompare(right.name));
    });
    setSelectedMarkerId(null);
    setSelectedEvent({ trackId: targetTrack.id, eventId: clone.id });
    setStatus(`已在 ${clone.startTick} Tick 粘贴${clone.name}`);
  };

  const clearSegmentEvents = () => {
    const count = segment.tracks.reduce((sum, track) => sum + track.events.length, 0);
    if (!count || !window.confirm(`确定清空当前动作段的 ${count} 个事件吗？`)) return;
    mutateProject((draft) => {
      for (const track of findDraftSegment(draft).tracks) track.events = [];
    });
    setSelectedEvent(null);
    setStatus("当前动作段事件已清空");
  };

  const locateIssue = (issue: ValidationIssue) => {
    const nextAction = project.actions.find((item) => item.id === issue.actionId);
    const nextSegment = nextAction?.segments.find((item) => item.id === issue.segmentId);
    if (!nextAction || !nextSegment) return;
    setSelectedActionId(nextAction.id);
    setSelectedSegmentId(nextSegment.id);
    setSelectedMarkerId(null);
    if (issue.trackId && issue.eventId) setSelectedEvent({ trackId: issue.trackId, eventId: issue.eventId });
    else setSelectedEvent(null);
    setPlayheadTick(Math.max(0, issue.tick || 0));
    setPlaying(false);
    setShowProblems(false);
  };

  const deleteSelectedEvent = () => {
    if (!selectedEvent) return;
    mutateProject((draft) => {
      const track = findDraftSegment(draft).tracks.find((item) => item.id === selectedEvent.trackId);
      if (track) track.events = track.events.filter((event) => event.id !== selectedEvent.eventId);
    });
    setSelectedEvent(null);
  };

  const addMarker = (tick: number) => {
    const marker: ActionMarker = { id: uid("marker"), name: `标记 ${segment.markers.length + 1}`, tick: Math.max(0, Math.round(tick)) };
    mutateProject((draft) => {
      const target = findDraftSegment(draft);
      target.markers.push(marker);
      target.markers.sort((left, right) => left.tick - right.tick);
    });
    setSelectedEvent(null);
    setSelectedMarkerId(marker.id);
  };

  const updateMarker = (markerId: string, patch: Partial<ActionMarker>) => {
    mutateProject((draft) => {
      const target = findDraftSegment(draft);
      const marker = target.markers.find((item) => item.id === markerId);
      if (marker) Object.assign(marker, patch);
      target.markers.sort((left, right) => left.tick - right.tick);
    });
  };

  const deleteMarker = (markerId: string) => {
    mutateProject((draft) => {
      const target = findDraftSegment(draft);
      target.markers = target.markers.filter((marker) => marker.id !== markerId);
    });
    if (selectedMarkerId === markerId) setSelectedMarkerId(null);
  };

  const createEventAssets = async (files: File[], kind: "image" | "audio") => {
    const sorted = kind === "image" ? [...files].sort(naturalCompare) : files;
    const nextAssets = await Promise.all(sorted.map(async (file) => {
      if (kind === "image") return addImageAsset(file, URL.createObjectURL(file), "vfx");
      const url = URL.createObjectURL(file);
      return { id: uid("asset"), name: file.name, kind, usage: "audio", url, dataUrl: await readDataUrl(file), durationSeconds: await readAudioDuration(url) } as AssetRef;
    }));
    setAssets((current) => Object.fromEntries([...Object.entries(current), ...nextAssets.map((asset) => [asset.id, asset])]));
    return nextAssets.map((asset) => asset.id);
  };

  const exportJson = () => {
    const replacerProject = cleanLegacyProjectData(project);
    const referencedAssets = collectReferencedAssetIds(replacerProject);
    const vfxAssetIds = collectVfxAssetIds(replacerProject);
    const editorAssets = Object.values(assets)
      .filter((asset) => asset.dataUrl && referencedAssets.has(asset.id))
      .map(({ id, name, kind, usage, dataUrl, width, height, durationSeconds }) => ({ id, name, kind, usage: usage || (kind === "audio" ? "audio" : vfxAssetIds.has(id) ? "vfx" : "character"), dataUrl, width, height, durationSeconds }));
    const blob = new Blob([JSON.stringify({ ...replacerProject, editorAssets }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${project.characterName || (isEnemy ? "enemy" : "character")}.${isEnemy ? "frame-action-enemy" : "frame-action"}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    setStatus("已导出动作数据 JSON");
  };

  const importJson = async (file: File) => {
    const parsed = JSON.parse(await file.text()) as CharacterProject & { editorAssets?: Array<Omit<AssetRef, "url">> };
    if (parsed.format !== "frame-action-project" || !Array.isArray(parsed.actions) || !parsed.actions.length) throw new Error("不是有效的 Frame Action 项目数据");
    const parsedKind = parsed.projectKind === "enemy" ? "enemy" : "character";
    if (parsedKind !== actorKind) throw new Error(`该 JSON 属于${parsedKind === "enemy" ? "敌人" : "角色"}模块，请先切换到对应模块再导入`);
    const restoredAssets = Object.fromEntries((parsed.editorAssets || [])
      .filter((asset) => asset.id && asset.dataUrl)
      .map((asset) => [asset.id, { ...asset, url: asset.dataUrl! } as AssetRef]));
    const assetMessage = Object.keys(restoredAssets).length ? `，包含 ${Object.keys(restoredAssets).length} 个编辑资源` : "，未包含编辑资源";
    const importingIntoOpenedActor = Boolean(editingUnityActorPath);
    const actorLabel = isEnemy ? "敌人" : "角色";
    restoreEditorProject(
      parsed,
      restoredAssets,
      importingIntoOpenedActor ? `已载入 JSON${assetMessage} · 将更新已打开${actorLabel}` : `已载入 JSON${assetMessage} · 当前仍为创建新${actorLabel}`,
    );
    if (importingIntoOpenedActor) {
      setSelectedUnityCharacterPath(editingUnityActorPath);
      if (boundUnityProjectPath) rememberUnityDocument(actorKind, boundUnityProjectPath, editingUnityActorPath, parsed.characterName);
    } else {
      rememberLocalDocument(actorKind);
      setSelectedUnityCharacterPath("");
    }
  };

  const updateActionFields = (patch: Partial<CharacterAction>) => {
    const oldId = action.id;
    mutateProject((draft) => {
      const target = draft.actions.find((item) => item.id === oldId);
      if (!target) return;
      const previousType = target.type;
      Object.assign(target, patch);
      if (draft.projectKind === "enemy") {
        target.trigger = { type: "none", code: "" };
        target.transitions = {};
        target.comboCount = 1;
      }
      if (patch.type && patch.type !== previousType && patch.comboCount === undefined) {
        target.comboCount = patch.type === "attack" ? 5 : patch.type === "jump" ? 2 : 1;
      }
      const controlsSegmentCount = target.type === "attack" || target.type === "jump";
      if (controlsSegmentCount && (patch.comboCount !== undefined || patch.type !== undefined)) {
        const segmentCount = Math.max(1, target.comboCount);
        while (target.segments.length < segmentCount) {
          const next = createSegment(`第 ${target.segments.length + 1} 段`, target.type);
          next.pixelsPerUnit = draft.pixelsPerUnit;
          target.segments.push(next);
        }
        while (target.segments.length > segmentCount) target.segments.pop();
      }
      if (patch.id && patch.id !== oldId) {
        for (const other of draft.actions) {
          if (other.transitions[oldId]) {
            other.transitions[patch.id] = other.transitions[oldId];
            delete other.transitions[oldId];
          }
        }
        if (draft.groundIdleId === oldId) draft.groundIdleId = patch.id;
        if (draft.airIdleId === oldId) draft.airIdleId = patch.id;
        for (const node of draft.enemyBehavior?.nodes || []) if (node.type === "playAction" && node.actionId === oldId) node.actionId = patch.id;
      }
    });
    if (patch.id && patch.id !== oldId) setSelectedActionId(patch.id);
  };

  const updateSegmentFields = (patch: Partial<ActionSegment>) => {
    mutateProject((draft) => {
      const target = findDraftSegment(draft);
      Object.assign(target, patch);
      if (patch.fps !== undefined) {
        const durationTicks = Math.max(1, Math.round(draft.tickRate / Math.max(1, target.fps)));
        for (const frame of target.frames) frame.durationTicks = durationTicks;
      }
    });
  };

  const postJson = async <T,>(url: string, body: unknown): Promise<T> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.message || `请求失败：${response.status}`);
    return result as T;
  };

  const refreshUnityCharacters = async (projectPath: string) => {
    if (!projectPath) return;
    try {
      const result = await postJson<{ ok: true; characters: UnityCharacterSummary[] }>(isEnemy ? "/api/unity/enemies" : "/api/unity/characters", { projectPath });
      setUnityCharacters(result.characters);
      setSelectedUnityCharacterPath((current) => result.characters.some((item) => item.jsonPath === current) ? current : result.characters[0]?.jsonPath || "");
      setPendingUnityEnemyDeletion((current) => current && result.characters.some((item) => item.jsonPath === current.jsonPath) ? current : null);
    } catch (error) {
      console.warn(`[Frame Action] 无法读取 Unity ${isEnemy ? "敌人" : "角色"}列表`, error);
      setUnityCharacters([]);
      setSelectedUnityCharacterPath("");
    }
  };

  const loadCharacterFromUnity = async () => {
    const projectPath = syncDialog?.path || boundUnityProjectPath;
    if (!projectPath || !selectedUnityCharacterPath) return;
    setLoadingUnityCharacter(true);
    try {
      const result = await postJson<{ ok: true; project: CharacterProject; assets: AssetRef[] }>(isEnemy ? "/api/unity/load-enemy" : "/api/unity/load-character", {
        projectPath,
        jsonPath: selectedUnityCharacterPath,
      });
      const restoredAssets = Object.fromEntries((result.assets || []).map((asset) => [asset.id, { ...asset, url: asset.dataUrl || asset.url }]));
      restoreEditorProject(result.project, restoredAssets, `已从 Unity 恢复${isEnemy ? "敌人" : "角色"} · ${result.project.characterName}`, actorKind);
      rememberUnityDocument(actorKind, projectPath, selectedUnityCharacterPath, result.project.characterName);
      setEditingUnityActorPath(selectedUnityCharacterPath);
      setSyncDialog((current) => current ? { ...current, phase: "done", editingPath: false, message: `已载入${isEnemy ? "敌人" : "角色"} ${result.project.characterName}，后续修改会继续自动保存为本地草稿。` } : current);
    } catch (error) {
      setSyncDialog((current) => current ? { ...current, phase: "error", message: error instanceof Error ? error.message : `从 Unity 载入${isEnemy ? "敌人" : "角色"}失败` } : current);
    } finally {
      setLoadingUnityCharacter(false);
    }
  };

  const deleteActorFromUnity = async () => {
    const projectPath = syncDialog?.path || boundUnityProjectPath;
    const target = pendingUnityEnemyDeletion;
    if (!projectPath || !target) return;
    const actorLabel = isEnemy ? "敌人" : "角色";
    setDeletingUnityEnemy(true);
    try {
      const result = await postJson<{
        ok: true;
        result: {
          characterName: string;
          deletedPaths: string[];
          deletedPrefabPath: string;
          preservedPrefabPath: string;
          preservedGeneratedPath: string;
          sharedPrefabReferenceCount: number;
          replacementEnemy: { characterName: string; jsonPath: string } | null;
        };
      }>(isEnemy ? "/api/unity/delete-enemy" : "/api/unity/delete-character", { projectPath, jsonPath: target.jsonPath });
      const origin = readDocumentOrigin(actorKind);
      if (origin.kind === "unity" && origin.projectPath === projectPath && origin.jsonPath === target.jsonPath) rememberLocalDocument(actorKind);
      if (editingUnityActorPath === target.jsonPath) setEditingUnityActorPath("");
      setPendingUnityEnemyDeletion(null);
      await refreshUnityCharacters(projectPath);
      const prefabMessage = result.result.replacementEnemy
        ? `共享 Prefab 已保留：${result.result.preservedPrefabPath}\n已安排由剩余${actorLabel}“${result.result.replacementEnemy.characterName}”重新同步该 Prefab。`
        : result.result.preservedPrefabPath
        ? `原有 Prefab 已保留：${result.result.preservedPrefabPath}\n其中既有的 Frame Action 组件不会自动还原，请在 Unity 中按需处理。`
        : result.result.deletedPrefabPath
          ? `自动生成 Prefab 已删除：${result.result.deletedPrefabPath}`
          : "该敌人没有需要单独删除的 Prefab。";
      setStatus(`已从 Unity 删除${actorLabel} ${result.result.characterName} · 本地草稿已保留`);
      setSyncDialog((current) => current ? {
        ...current,
        phase: "done",
        message: `已删除${actorLabel} ${result.result.characterName}。\n${result.result.deletedPaths.join("\n")}\n${prefabMessage}\n本地草稿仍保留，重新同步会再次创建该${actorLabel}。`,
      } : current);
    } catch (error) {
      setSyncDialog((current) => current ? { ...current, phase: "error", message: error instanceof Error ? error.message : `从 Unity 删除${actorLabel}失败` } : current);
    } finally {
      setDeletingUnityEnemy(false);
    }
  };

  const openUnitySync = () => {
    setPendingUnityEnemyDeletion(null);
    setPendingEnemyOverwrite(null);
    const savedPath = boundUnityProjectPath || localStorage.getItem(isEnemy ? "frameAction.enemyUnityProjectPath" : "frameAction.unityProjectPath") || "";
    setSyncDialog({
      path: savedPath,
      phase: "path",
      editingPath: !savedPath,
      message: savedPath
        ? !editingUnityActorPath
          ? `当前正在编辑新${isEnemy ? "敌人" : "角色"}：名称不同会创建新记录，同名时会先询问是否覆盖。`
          : "当前项目已绑定，可以直接同步最新数据。"
        : "选择 Unity 项目根目录，首次绑定会检查 Runtime 包。",
    });
    if (savedPath) void refreshUnityCharacters(savedPath);
  };

  const createNewActor = () => {
    const nextProject = isEnemy ? createEnemyProject() : createProject();
    const actorLabel = isEnemy ? "敌人" : "角色";
    restoreEditorProject(nextProject, {}, `已创建新${actorLabel} · 尚未同步到 Unity`, actorKind);
    rememberLocalDocument(actorKind);
    setEditingUnityActorPath("");
    setSelectedUnityCharacterPath("");
    setPendingUnityEnemyDeletion(null);
    setPendingEnemyOverwrite(null);
    setSyncDialog(null);
  };

  const changeUnityProject = () => {
    if (!syncDialog) return;
    setSyncDialog({ ...syncDialog, phase: "path", editingPath: true, message: "输入新的 Unity 项目根目录，确认后会检查 Runtime 并同步数据。" });
  };

  const unbindUnityProject = () => {
    localStorage.removeItem(isEnemy ? "frameAction.enemyUnityProjectPath" : "frameAction.unityProjectPath");
    rememberLocalDocument(actorKind);
    setBoundUnityProjectPath("");
    setSelectedUnityCharacterPath("");
    setEditingUnityActorPath("");
    setStatus("已解除 Unity 项目绑定 · 本地草稿未受影响");
    setSyncDialog({ path: "", phase: "path", editingPath: true, message: "已解除绑定。可以选择新的 Unity 项目继续同步。" });
  };

  const syncUnityData = async (projectPath: string, confirmOverwrite = false) => {
    const syncProject = cleanLegacyProjectData(project);
    const actorLabel = isEnemy ? "敌人" : "角色";
    if (!confirmOverwrite && !editingUnityActorPath) {
      setSyncDialog((current) => current ? { ...current, phase: "checking", message: `正在检查 Unity 项目中的同名${actorLabel}...` } : current);
      const overwriteCheck = await postJson<{ ok: true; existing: UnityCharacterSummary | null }>(isEnemy ? "/api/unity/check-enemy-overwrite" : "/api/unity/check-character-overwrite", {
        projectPath,
        characterName: syncProject.characterName,
      });
      if (overwriteCheck.existing) {
        const existing = overwriteCheck.existing;
        setPendingEnemyOverwrite(existing);
        setSyncDialog((current) => current ? {
          ...current,
          phase: "overwrite",
          message: `Unity 项目中已经存在同名${actorLabel}“${existing.characterName}”。\n${existing.jsonPath}\nPrefab：${existing.prefabPath}\n继续操作会覆盖旧动作数据，并更新这个${actorLabel}的 Prefab。`,
        } : current);
        return;
      }
    }
    setPendingEnemyOverwrite(null);
    setSyncDialog((current) => current ? { ...current, phase: "syncing", message: `正在同步${isEnemy ? "敌人" : "角色"}动作数据和资源...` } : current);
    const referencedAssets = collectReferencedAssetIds(syncProject);
    const vfxAssetIds = collectVfxAssetIds(syncProject);
    const syncAssets = Object.values(assets)
      .filter((asset) => asset.dataUrl && referencedAssets.has(asset.id))
      .map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind, usage: asset.usage || (asset.kind === "audio" ? "audio" : vfxAssetIds.has(asset.id) ? "vfx" : "character"), dataUrl: asset.dataUrl }));
    const result = await postJson<{
      ok: true;
      runtime: { version: string };
      result: { changedFiles: number; assetCount: number; actionCount: number; jsonPath: string; prefabPath: string; prefabPathAdjustedFrom?: string };
    }>(isEnemy ? "/api/unity/sync-enemy" : "/api/unity/sync", {
      projectPath,
      project: syncProject,
      assets: syncAssets,
      confirmOverwrite,
      targetJsonPath: editingUnityActorPath,
    });
    if (result.result.prefabPathAdjustedFrom) {
      mutateProject((draft) => { draft.unityCharacter.prefabPath = result.result.prefabPath; }, "unity-prefab-auto-isolate");
    }
    localStorage.setItem(isEnemy ? "frameAction.enemyUnityProjectPath" : "frameAction.unityProjectPath", projectPath);
    rememberUnityDocument(actorKind, projectPath, result.result.jsonPath, syncProject.characterName);
    setBoundUnityProjectPath(projectPath);
    setSelectedUnityCharacterPath(result.result.jsonPath);
    setEditingUnityActorPath(result.result.jsonPath);
    void refreshUnityCharacters(projectPath);
    setStatus(`Unity 同步完成 · 更新 ${result.result.changedFiles} 个文件`);
    setSyncDialog({
      path: projectPath,
      phase: "done",
      editingPath: false,
      runtimeVersion: result.runtime.version,
      message: [
        `已同步 ${result.result.actionCount} 个动作、${result.result.assetCount} 个资源。`,
        result.result.prefabPathAdjustedFrom ? `检测到旧${actorLabel}生成路径，已自动改为独立 Prefab：\n${result.result.prefabPath}` : "",
        result.result.jsonPath,
        `${isEnemy ? "敌人" : "角色"} Prefab：${result.result.prefabPath}`,
      ].filter(Boolean).join("\n"),
    });
  };

  const confirmEnemyOverwrite = async () => {
    if (!syncDialog?.path || !pendingEnemyOverwrite) return;
    try {
      await syncUnityData(syncDialog.path, true);
    } catch (error) {
      setSyncDialog((current) => current ? { ...current, phase: "error", message: error instanceof Error ? error.message : `覆盖同名${isEnemy ? "敌人" : "角色"}失败` } : current);
    }
  };

  const cancelEnemyOverwrite = () => {
    setPendingEnemyOverwrite(null);
    setSyncDialog((current) => current ? { ...current, phase: "done", message: `已取消覆盖，同名${isEnemy ? "敌人" : "角色"}的 Unity 数据没有发生变化。` } : current);
  };

  const checkAndSyncUnity = async () => {
    if (!syncDialog?.path.trim()) return;
    const projectPath = syncDialog.path.trim();
    setSyncDialog({ ...syncDialog, phase: "checking", message: "正在检查 Unity 项目..." });
    try {
      const result = await postJson<{
        ok: true;
        runtime: { installed: boolean; version: string | null; latestVersion: string; needsUpdate: boolean };
      }>("/api/unity/check", { projectPath });
      if (!result.runtime.installed) {
        setSyncDialog({ path: projectPath, phase: "missing", editingPath: false, message: "该项目尚未安装 Frame Action Runtime。", runtimeVersion: undefined });
        return;
      }
      if (result.runtime.needsUpdate) {
        setSyncDialog({
          path: projectPath,
          phase: "outdated",
          editingPath: false,
          message: `当前 Runtime ${result.runtime.version}，需要更新到 ${result.runtime.latestVersion} 后再同步。`,
          runtimeVersion: result.runtime.version ?? undefined,
        });
        return;
      }
      await syncUnityData(projectPath);
    } catch (error) {
      setSyncDialog({ path: projectPath, phase: "error", editingPath: true, message: error instanceof Error ? error.message : "Unity 项目检查失败" });
    }
  };

  const installRuntimeAndSync = async () => {
    if (!syncDialog) return;
    const projectPath = syncDialog.path;
    setSyncDialog({ ...syncDialog, phase: "checking", message: "正在安装 Embedded UPM Runtime..." });
    try {
      const result = await postJson<{ ok: true; runtime: { version: string } }>("/api/unity/install-runtime", { projectPath });
      setSyncDialog({ path: projectPath, phase: "syncing", editingPath: false, message: `Runtime ${result.runtime.version} 已安装，正在同步数据...`, runtimeVersion: result.runtime.version });
      await syncUnityData(projectPath);
    } catch (error) {
      setSyncDialog({ path: projectPath, phase: "error", editingPath: false, message: error instanceof Error ? error.message : "Runtime 安装失败" });
    }
  };

  const frameIndex = frame ? segment.frames.findIndex((item) => item.id === frame.id) : -1;
  const sheetLayout = sheetDialog ? getSheetLayout(sheetDialog) : null;
  const boundUnityProjectName = boundUnityProjectPath ? unityProjectName(boundUnityProjectPath) : "";
  const showingBoundUnityProject = Boolean(syncDialog && boundUnityProjectPath && syncDialog.path === boundUnityProjectPath && !syncDialog.editingPath);
  const actorSyncContext = editingUnityActorPath
    ? `已打开旧${isEnemy ? "敌人" : "角色"}`
    : `创建新${isEnemy ? "敌人" : "角色"}中`;

  const switchModule = (module: "character" | "enemy" | "map") => {
    setActiveModule(module);
    localStorage.setItem("frameAction.activeModule", module);
    setSyncDialog(null);
    setUnityCharacters([]);
    setSelectedUnityCharacterPath("");
    setPendingUnityEnemyDeletion(null);
    setPendingEnemyOverwrite(null);
    if (module !== "map") {
      const nextProject = module === "enemy" ? enemyProject : characterProject;
      setSelectedActionId(nextProject.actions[0].id);
      setSelectedSegmentId(nextProject.actions[0].segments[0].id);
      setSelectedEvent(null);
      setSelectedMarkerId(null);
      setPlayheadTick(0);
      setInspectorTab("character");
      historyRef.current = { past: [], future: [], lastKey: "", lastAt: 0 };
    }
  };

  if (activeModule === "map") return <MapEditor onSwitchToCharacter={() => switchModule("character")} onSwitchToEnemy={() => switchModule("enemy")} />;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <Layers3 size={22} />
          <div>
            <strong>SpriteCue Studio</strong>
            <span>{isEnemy ? "横版 2D 敌人动作编辑器" : "横版 2D 角色动作编辑器"}</span>
          </div>
        </div>
        <nav className="module-navigation" aria-label="功能模块">
          <button type="button" className={activeModule === "character" ? "active" : ""} onClick={() => switchModule("character")}><Layers3 size={15} />角色动作</button>
          <button type="button" className={activeModule === "enemy" ? "active" : ""} onClick={() => switchModule("enemy")}><Bot size={15} />敌人动作</button>
          <button type="button" onClick={() => switchModule("map")}><MapIcon size={15} />地图编辑</button>
        </nav>
        <div className="project-fields">
          <label>
            <span>{isEnemy ? "敌人" : "角色"}</span>
            <DeferredTextInput
              value={project.characterName}
              onValueChange={(value) => mutateProject((draft) => (draft.characterName = value))}
            />
          </label>
          <label className="compact-field">
            <span>默认 PPU</span>
            <NumericInput value={project.pixelsPerUnit} min={1} step={0.1} onValueChange={(value) => mutateProject((draft) => (draft.pixelsPerUnit = value))} />
          </label>
          <label className="compact-field facing-field">
            <span>素材朝向</span>
            <select value={project.sourceFacing} onChange={(event) => mutateProject((draft) => (draft.sourceFacing = event.target.value as CharacterProject["sourceFacing"]))}>
              <option value="right">朝右</option>
              <option value="left">朝左</option>
            </select>
          </label>
        </div>
        <div className="header-actions">
          <button type="button" className="icon-button" title="撤销 Ctrl+Z" onClick={undoProject} disabled={!historyRef.current.past.length}><Undo2 size={17} /></button>
          <button type="button" className="icon-button" title="重做 Ctrl+Y" onClick={redoProject} disabled={!historyRef.current.future.length}><Redo2 size={17} /></button>
          <button type="button" className="icon-button" title="导入 JSON" onClick={() => jsonInputRef.current?.click()}>
            <Upload size={17} />
          </button>
          <button type="button" className="icon-button" title="导出 JSON" onClick={exportJson}>
            <Download size={17} />
          </button>
          <button type="button" className={`problem-button${validationErrors ? " has-errors" : validationIssues.length ? " has-warnings" : ""}`} title="配置校验" onClick={() => setShowProblems(true)}>
            <TriangleAlert size={17} />
            <span>{validationIssues.length}</span>
          </button>
          <button
            type="button"
            className={`sync-button${boundUnityProjectPath ? " bound" : ""}`}
            title={boundUnityProjectPath ? `同步${isEnemy ? "敌人" : "角色"}（${actorSyncContext}）到 ${boundUnityProjectPath}` : `绑定${isEnemy ? "敌人" : "角色"} Unity 项目`}
            onClick={openUnitySync}
          >
            {boundUnityProjectPath ? <FolderSync size={17} /> : <FolderOpen size={17} />}
            <span className="sync-button-label">
              <strong>{boundUnityProjectPath ? `同步${isEnemy ? "敌人" : "角色"}（${actorSyncContext}）` : `绑定${isEnemy ? "敌人" : "角色"}项目`}</strong>
              {boundUnityProjectPath && <small>{boundUnityProjectName}</small>}
            </span>
          </button>
        </div>
        <input
          ref={jsonInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importJson(file).catch((error) => setStatus(error.message));
            event.currentTarget.value = "";
          }}
        />
      </header>

      <div className="app-main" style={{ "--left-panel-width": `${editorLayout.leftPanelWidth}px`, "--right-panel-width": `${editorLayout.rightPanelWidth}px` } as React.CSSProperties}>
        <aside className="left-sidebar">
          <section className="sidebar-section action-library">
            <div className="section-heading">
              <div>
                <strong>动作</strong>
                <span>{project.actions.length} 个</span>
              </div>
              <button type="button" className="icon-button small" title={isEnemy ? "添加技能" : "新增动作"} onClick={addAction}>
                <Plus size={15} />
              </button>
            </div>
            <div className="action-list">
              {project.actions.map((item) => (
                <button
                  type="button"
                  className={`action-item${item.id === action.id ? " active" : ""}`}
                  key={item.id}
                  onClick={() => switchAction(item.id)}
                >
                  <span>{item.name}</span>
                  <small>{isEnemy ? ({ idleGround: "地面待机", idleAir: "空中待机", move: "走路", skill: "技能", hurt: "受击" } as Record<string, string>)[item.type] : `${item.segments.length} 段`} · {item.loop ? "循环" : "单次"}</small>
                </button>
              ))}
            </div>
            <div className="row-actions">
              <button type="button" title="上移当前动作" onClick={() => moveAction(-1)} disabled={project.actions[0].id === action.id}><ChevronUp size={15} />上移</button>
              <button type="button" title="下移当前动作" onClick={() => moveAction(1)} disabled={project.actions.at(-1)?.id === action.id}><ChevronDown size={15} />下移</button>
              <button type="button" title="复制当前动作" onClick={duplicateAction}><Copy size={15} />复制</button>
              <button type="button" title={canDeleteAction ? "删除当前动作" : isEnemy ? "每种敌人动作至少保留一个" : "至少保留一个动作"} onClick={deleteAction} disabled={!canDeleteAction}><Trash2 size={15} />删除</button>
            </div>
          </section>

          <section className="sidebar-section">
            <div className="section-heading">
              <div><strong>动作段</strong><span>{action.segments.length} 段</span></div>
              <div className="toolbar-actions">
                <button type="button" className="icon-button small" title="新增动作段" onClick={addSegment}><Plus size={15} /></button>
                <button type="button" className="icon-button small danger" title="删除当前动作段" onClick={deleteSegment} disabled={action.segments.length <= 1}><Trash2 size={15} /></button>
              </div>
            </div>
            <div className="segment-tabs">
              {action.segments.map((item, index) => (
                <button
                  type="button"
                  className={item.id === segment.id ? "active" : ""}
                  key={item.id}
                  onClick={() => {
                    setSelectedSegmentId(item.id);
                    setSelectedEvent(null);
                    setSelectedMarkerId(null);
                    setPlayheadTick(0);
                  }}
                >
                  {index + 1}. {item.name}
                </button>
              ))}
            </div>
          </section>

          <section className="sidebar-section frame-library">
            <div className="section-heading">
              <div><strong>动画帧</strong><span>{segment.frames.length} 帧</span></div>
              <div className="toolbar-actions">
                <button type="button" className="icon-button small" title="上移当前帧" onClick={() => moveFrame(-1)} disabled={!frame || frameIndex <= 0}><ChevronUp size={15} /></button>
                <button type="button" className="icon-button small" title="下移当前帧" onClick={() => moveFrame(1)} disabled={!frame || frameIndex >= segment.frames.length - 1}><ChevronDown size={15} /></button>
                <button type="button" className="icon-button small danger" title="清空当前动作段动画帧" onClick={clearSegmentFrames} disabled={!segment.frames.length}><Trash2 size={15} /></button>
              </div>
            </div>
            <div className="import-buttons">
              <button type="button" onClick={() => sequenceInputRef.current?.click()}><ImagePlus size={16} />导入序列</button>
              <button type="button" onClick={() => sheetInputRef.current?.click()}><Grid3X3 size={16} />Sprite Sheet</button>
            </div>
            <input
              ref={sequenceInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => {
                void importSequence(Array.from(event.target.files ?? []));
                event.currentTarget.value = "";
              }}
            />
            <input
              ref={sheetInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void prepareSpriteSheet(file);
                event.currentTarget.value = "";
              }}
            />
            <div className="frame-list">
              {segment.frames.map((item, index) => {
                const asset = assets[item.assetId];
                return (
                  <button
                    type="button"
                    className={`frame-item${frame?.id === item.id ? " active" : ""}`}
                    key={item.id}
                    onClick={() => selectFrame(item.id)}
                  >
                    <span className="frame-thumb">{asset ? <img src={asset.url} alt="" /> : <Square size={18} />}</span>
                    <span className="frame-item-text"><strong>帧 {index + 1}</strong><small>{item.durationTicks} Tick</small></span>
                  </button>
                );
              })}
              {!segment.frames.length && <div className="list-empty">尚未导入动画帧</div>}
            </div>
          </section>
        </aside>

        <div
          className="panel-resizer column-resizer"
          role="separator"
          aria-label="调整左侧动作面板宽度"
          aria-orientation="vertical"
          aria-valuenow={editorLayout.leftPanelWidth}
          tabIndex={0}
          title="拖动调整左侧动作面板宽度"
          onPointerDown={(event) => startPanelResize(event, "left")}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setEditorLayout((current) => ({ ...current, leftPanelWidth: clampLayoutValue(current.leftPanelWidth + (event.key === "ArrowLeft" ? -20 : 20), 190, 420) }));
          }}
        />

        <main className={`workspace${inspectorTab === "behavior" ? " behavior-mode" : ""}`} style={{ "--timeline-panel-height": `${editorLayout.timelineHeight}px` } as React.CSSProperties}>
          {inspectorTab === "behavior" && project.enemyBehavior && <EnemyBehaviorTreeCanvas
            settings={project.enemyBehavior}
            actions={project.actions}
            selectedNodeId={selectedBehaviorNodeId}
            onSelectNode={setSelectedBehaviorNodeId}
            onChange={(enemyBehavior) => mutateProject((draft) => { draft.enemyBehavior = enemyBehavior; }, "enemy-behavior-canvas")}
          />}
          {inspectorTab !== "behavior" && <>
          <div className="preview-toolbar">
            <div className="playback-controls">
              <button type="button" className="icon-button" title="上一帧" onClick={() => {
                const boundaries = frameBoundaries(segment);
                let index = 0;
                for (let cursor = 0; cursor < boundaries.length; cursor += 1) {
                  if (boundaries[cursor] < playheadTick - 1) index = cursor;
                }
                setPlayheadTick(boundaries[index] ?? 0);
              }}><ChevronLeft size={18} /></button>
              <button type="button" className="play-button" title={playing ? "暂停" : "播放"} onClick={() => {
                if (playing) {
                  setPlaying(false);
                  return;
                }
                const restartingAtBeginning = playheadTick >= duration - 1;
                if (restartingAtBeginning) setPlayheadTick(0);
                if (restartingAtBeginning || playheadTick <= 0) previousTick.current = -1;
                setPlaying(true);
              }}>
                {playing ? <CirclePause size={19} /> : <CirclePlay size={19} />}
                {playing ? "暂停" : "播放"}
              </button>
              <button type="button" className="icon-button" title="下一帧" onClick={() => {
                const boundaries = frameBoundaries(segment);
                const next = boundaries.find((tick) => tick > playheadTick + 1);
                setPlayheadTick(next ?? Math.max(0, duration - 1));
              }}><ChevronRight size={18} /></button>
              <span className="playback-readout">帧 {Math.max(0, frameIndex + 1)} / {segment.frames.length} · {(playheadTick / project.tickRate).toFixed(3)}s</span>
            </div>
            <div className="view-controls">
              {sceneEditMode && canvasHandleOptions.length > 0 && <>
                <select className="canvas-handle-select" aria-label="当前画布编辑对象" value={canvasHandleTarget} onChange={(event) => setCanvasHandleTarget(event.target.value)}>
                  {canvasHandleOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                </select>
                <button type="button" className={`icon-button${canvasHandlesLocked ? " active" : ""}`} title={canvasHandlesLocked ? "解锁当前编辑对象" : "锁定当前编辑对象"} onClick={() => {
                  if (!canvasLockKey) return;
                  setLockedCanvasTargets((current) => current.includes(canvasLockKey) ? current.filter((key) => key !== canvasLockKey) : [...current, canvasLockKey]);
                }}>{canvasHandlesLocked ? <Lock size={17} /> : <Unlock size={17} />}</button>
              </>}
              <button type="button" className={`icon-button${previewFacingLeft ? " active" : ""}`} title={previewFacingLeft ? "预览朝左" : "预览朝右"} onClick={() => setPreviewFacingLeft((value) => !value)}><FlipHorizontal2 size={17} /></button>
              <button type="button" className={`icon-button${showGrid ? " active" : ""}`} title="显示网格" onClick={() => setShowGrid((value) => !value)}><Grid3X3 size={17} /></button>
              <button type="button" className={`icon-button${showBoxes ? " active" : ""}`} title="显示身体碰撞体、受击区域和命中范围" onClick={() => setShowBoxes((value) => !value)}><Box size={17} /></button>
              <button type="button" className={`icon-button${showTarget ? " active" : ""}`} title="显示预览目标" onClick={() => setShowTarget((value) => !value)}><Crosshair size={17} /></button>
              <button type="button" className={`icon-button${sceneEditMode ? " active" : ""}`} title="画布编辑模式" onClick={() => setSceneEditMode((value) => !value)}><MousePointer2 size={17} /></button>
              <div className="segmented compact" aria-label="预览背景">
                <button type="button" className={background === "transparent" ? "active" : ""} title="透明背景" onClick={() => setBackground("transparent")}><Grid3X3 size={15} /></button>
                <button type="button" className={background === "light" ? "active" : ""} title="浅色背景" onClick={() => setBackground("light")}><Sun size={15} /></button>
                <button type="button" className={background === "dark" ? "active" : ""} title="深色背景" onClick={() => setBackground("dark")}><Moon size={15} /></button>
              </div>
            </div>
          </div>

          <PreviewCanvas
            project={project}
            segment={segment}
            actionLoop={action.loop}
            assets={assets}
            playheadTick={playheadTick}
            selectedEventId={selectedEvent?.eventId ?? null}
            background={background}
            showGrid={showGrid}
            showBoxes={showBoxes}
            showTarget={showTarget}
            sceneEditMode={sceneEditMode}
            facingLeft={previewFacingLeft}
            editTarget={canvasHandleTarget}
            handlesLocked={canvasHandlesLocked}
            target={previewTarget}
            onTargetChange={setPreviewTarget}
            onSelectEvent={(eventId) => {
              const track = segment.tracks.find((item) => item.events.some((event) => event.id === eventId));
              if (track) {
                setSelectedMarkerId(null);
                setSelectedEvent({ trackId: track.id, eventId });
              }
            }}
            onUpdateEvent={updateEventById}
            onUpdateUnityCharacter={(patch) => mutateProject((draft) => Object.assign(draft.unityCharacter, patch), "unity-body-collider")}
          />

          <div
            className="panel-resizer row-resizer"
            role="separator"
            aria-label="调整预览和时间轴高度"
            aria-orientation="horizontal"
            aria-valuenow={editorLayout.timelineHeight}
            tabIndex={0}
            title="拖动调整预览和时间轴高度"
            onPointerDown={(event) => startPanelResize(event, "timeline")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              setEditorLayout((current) => ({ ...current, timelineHeight: clampLayoutValue(current.timelineHeight + (event.key === "ArrowUp" ? 20 : -20), 180, 520) }));
            }}
          />

          <Timeline
            segment={segment}
            assets={assets}
            tickRate={project.tickRate}
            playheadTick={playheadTick}
            selectedEventId={selectedEvent?.eventId ?? null}
            selectedMarkerId={selectedMarkerId}
            onPlayheadChange={(tick) => {
              setPlayheadTick(tick);
              setPlaying(false);
            }}
            onSelectEvent={(trackId, eventId) => {
              setSelectedMarkerId(null);
              setSelectedEvent({ trackId, eventId });
              if (sceneEditMode) {
                const selected = segment.tracks.find((track) => track.id === trackId)?.events.find((event) => event.id === eventId);
                if (selected) setPlayheadTick(selected.startTick);
              }
            }}
            onAddEvent={addTimelineEvent}
            onUpdateEvent={updateTimelineEvent}
            onResizeEvent={resizeTimelineEvent}
            onDuplicateEvent={duplicateSelectedEvent}
            onCopyEvent={copySelectedEvent}
            onPasteEvent={pasteEventAtPlayhead}
            canPasteEvent={hasEventClipboard}
            stackOverlappingEvents={stackTimelineEvents}
            onToggleStackOverlappingEvents={() => setStackTimelineEvents((value) => !value)}
            onClearEvents={clearSegmentEvents}
            onDeleteEvent={deleteSelectedEvent}
            onSelectMarker={(markerId) => {
              setSelectedEvent(null);
              setSelectedMarkerId(markerId);
            }}
            onAddMarker={addMarker}
            onUpdateMarker={updateMarker}
          />
          </>}
        </main>

        <div
          className="panel-resizer column-resizer"
          role="separator"
          aria-label="调整右侧属性面板宽度"
          aria-orientation="vertical"
          aria-valuenow={editorLayout.rightPanelWidth}
          tabIndex={0}
          title="拖动调整右侧属性面板宽度"
          onPointerDown={(event) => startPanelResize(event, "right")}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setEditorLayout((current) => ({ ...current, rightPanelWidth: clampLayoutValue(current.rightPanelWidth + (event.key === "ArrowLeft" ? 20 : -20), 260, 520) }));
          }}
        />

        <aside className="inspector">
          <nav className={`inspector-tabs${isEnemy ? " enemy-tabs" : ""}`} aria-label="属性范围">
            <button type="button" className={inspectorTab === "character" ? "active" : ""} onClick={() => setInspectorTab("character")}>{isEnemy ? "敌人" : "角色"}</button>
            <button type="button" className={inspectorTab === "action" ? "active" : ""} onClick={() => setInspectorTab("action")}>动作</button>
            {isEnemy && <button type="button" className={inspectorTab === "behavior" ? "active" : ""} onClick={() => { setInspectorTab("behavior"); setSelectedBehaviorNodeId(project.enemyBehavior?.rootNodeId || ""); }}>AI</button>}
            <button type="button" className={inspectorTab === "frame" ? "active" : ""} onClick={() => setInspectorTab("frame")}>单帧</button>
          </nav>

          {inspectorTab === "action" && selectedTimelineEvent && selectedTrack && (
            <SkillEventInspector
              event={selectedTimelineEvent}
              track={selectedTrack}
              tickRate={project.tickRate}
              defaultPixelsPerUnit={project.pixelsPerUnit}
              assets={assets}
              onUpdate={(patch) => updateTimelineEvent(selectedTrack.id, selectedTimelineEvent.id, patch)}
              onCreateAssets={createEventAssets}
              onDelete={deleteSelectedEvent}
            />
          )}

          {inspectorTab === "action" && selectedMarker && (
            <section className="inspector-section">
              <div className="section-heading"><div><strong>时间标记</strong><span>{selectedMarker.tick} Tick</span></div><button type="button" className="icon-button small danger" title="删除时间标记" onClick={() => deleteMarker(selectedMarker.id)}><Trash2 size={14} /></button></div>
              <label className="field"><span>名称</span><DeferredTextInput value={selectedMarker.name} onValueChange={(value) => updateMarker(selectedMarker.id, { name: value })} /></label>
              <Field label="时间 Tick" value={selectedMarker.tick} min={0} integer onChange={(value) => updateMarker(selectedMarker.id, { tick: Math.max(0, Math.round(value)) })} />
            </section>
          )}

          {(inspectorTab === "character" || inspectorTab === "action") && <ActionInspector
            scope={inspectorTab}
            project={project}
            action={action}
            segment={segment}
            onUpdateProject={(patch) => mutateProject((draft) => Object.assign(draft, patch))}
            onUpdateAction={updateActionFields}
            onUpdateSegment={updateSegmentFields}
          />}

          {inspectorTab === "behavior" && project.enemyBehavior && <EnemyBehaviorTreeInspector
            settings={project.enemyBehavior}
            actions={project.actions}
            selectedNodeId={selectedBehaviorNodeId}
            onChange={(enemyBehavior) => mutateProject((draft) => { draft.enemyBehavior = enemyBehavior; }, "enemy-behavior-tree")}
          />}

          {inspectorTab === "frame" && frame && (
            <section className="inspector-section">
              <div className="section-heading"><div><strong>当前帧</strong><span>{frame.name}</span></div></div>
              <Field label="持续 Tick" value={frame.durationTicks} min={1} integer onChange={(value) => updateFrame(frame.id, { durationTicks: Math.max(1, Math.round(value)) })} />
              <div className="row-actions">
                <button type="button" className="danger-text" onClick={() => deleteFrame(frame.id)}><Trash2 size={14} />移除帧</button>
              </div>
            </section>
          )}
          {inspectorTab === "frame" && !frame && <div className="inspector-empty"><strong>没有当前帧</strong><span>先为当前动作段导入动画帧</span></div>}

        </aside>
      </div>

      <footer className="status-bar">
        <div className="status-primary">
          <span>{status}</span>
          <span className={`unity-binding-status${boundUnityProjectPath ? " bound" : ""}`} title={boundUnityProjectPath || `尚未绑定${isEnemy ? "敌人" : "角色"} Unity 项目`}>
            {boundUnityProjectPath ? `${isEnemy ? "敌人" : "角色"} Unity · ${boundUnityProjectName}` : `${isEnemy ? "敌人" : "角色"} Unity · 未绑定`}
          </span>
        </div>
        <span>{action.name} / {segment.name} · {segment.frames.length} 帧 · {segment.tracks.reduce((sum, track) => sum + track.events.length, 0)} 个事件</span>
      </footer>

      {showProblems && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowProblems(false); }}>
        <div className="modal problems-modal" role="dialog" aria-modal="true" aria-label="配置问题">
          <div className="modal-heading">
            <div><strong>配置校验</strong><span>{validationErrors} 个错误 · {validationIssues.length - validationErrors} 个警告</span></div>
            <button type="button" className="icon-button" title="关闭" onClick={() => setShowProblems(false)}><X size={16} /></button>
          </div>
          <div className="problem-list">
            {!validationIssues.length && <div className="problem-empty">当前配置未发现问题</div>}
            {validationIssues.map((issue) => {
              const issueAction = project.actions.find((item) => item.id === issue.actionId);
              const issueSegment = issueAction?.segments.find((item) => item.id === issue.segmentId);
              return <button type="button" className={`problem-item ${issue.severity}`} key={issue.id} onClick={() => locateIssue(issue)}>
                <TriangleAlert size={16} />
                <span><strong>{issue.message}</strong><small>{issueAction?.name || "项目"} / {issueSegment?.name || "全局"}{issue.tick !== undefined ? ` · ${issue.tick} Tick` : ""}</small></span>
              </button>;
            })}
          </div>
          <div className="modal-actions"><button type="button" onClick={() => setShowProblems(false)}>关闭</button></div>
        </div>
      </div>}

      {sheetDialog && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label="拆分 Sprite Sheet">
            <div className="modal-heading"><div><strong>拆分 Sprite Sheet</strong><span>{sheetDialog.file.name} · {sheetDialog.width}×{sheetDialog.height}</span></div><button type="button" className="icon-button" title="关闭" onClick={() => setSheetDialog(null)}><Trash2 size={16} /></button></div>
            <img className="sheet-preview" src={sheetDialog.url} alt="Sprite Sheet 预览" />
            <div className="field-grid two-columns">
              <Field label="帧数" value={sheetDialog.frameCount} min={1} integer onChange={(value) => setSheetDialog({ ...sheetDialog, frameCount: Math.max(1, Math.round(value)) })} />
              <Field label="Sheet 列数" value={sheetDialog.columns} min={1} integer onChange={(value) => setSheetDialog({ ...sheetDialog, columns: Math.max(1, Math.round(value)) })} />
              <Field label="Sheet 间距" value={sheetDialog.spacing} min={0} integer onChange={(value) => setSheetDialog({ ...sheetDialog, spacing: Math.max(0, Math.round(value)) })} />
              <Field label="Sheet 边距" value={sheetDialog.padding} min={0} integer onChange={(value) => setSheetDialog({ ...sheetDialog, padding: Math.max(0, Math.round(value)) })} />
              <Field label="格宽" value={sheetDialog.cellWidth} min={1} integer onChange={(value) => setSheetDialog({ ...sheetDialog, cellWidth: Math.max(1, Math.round(value)) })} />
              <Field label="格高" value={sheetDialog.cellHeight} min={1} integer onChange={(value) => setSheetDialog({ ...sheetDialog, cellHeight: Math.max(1, Math.round(value)) })} />
            </div>
            {sheetLayout && (
              <div className={`sheet-layout-status${sheetLayout.fits ? "" : " error"}`}>
                <span>布局占用 {sheetLayout.requiredWidth}×{sheetLayout.requiredHeight} 像素 · {sheetLayout.rows} 行</span>
                {!sheetLayout.fits && <strong>当前参数超出原图范围</strong>}
              </div>
            )}
            <div className="modal-actions"><button type="button" onClick={() => setSheetDialog(null)}>取消</button><button type="button" className="primary-button" disabled={!sheetLayout?.fits} onClick={() => void sliceSpriteSheet()}>拆分并加入动作</button></div>
          </div>
        </div>
      )}

      {syncDialog && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal unity-sync-modal" role="dialog" aria-modal="true" aria-label={boundUnityProjectPath ? `${isEnemy ? "敌人" : "角色"}项目连接` : `绑定${isEnemy ? "敌人" : "角色"}项目`}>
            <div className="modal-heading">
              <div><strong>{boundUnityProjectPath ? `${isEnemy ? "敌人" : "角色"}项目连接` : `绑定${isEnemy ? "敌人" : "角色"}项目`}</strong><span>只管理{isEnemy ? "敌人" : "角色"}数据、资源和目标 Prefab</span></div>
              <button type="button" className="icon-button" title="关闭" onClick={() => { setPendingEnemyOverwrite(null); setSyncDialog(null); }}><X size={16} /></button>
            </div>
            {showingBoundUnityProject ? (
              <div className="bound-project-card">
                <FolderSync size={20} />
                <div><strong>{boundUnityProjectName}</strong><span>{boundUnityProjectPath}</span></div>
              </div>
            ) : (
              <label className="field">
                <span>Unity 项目根目录</span>
                <DeferredTextInput
                  value={syncDialog.path}
                  placeholder="例如 D:\\UnityProjects\\MyGame"
                  disabled={syncDialog.phase === "checking" || syncDialog.phase === "syncing"}
                  onValueChange={(value) => setSyncDialog({ ...syncDialog, path: value, phase: "path", editingPath: true })}
                />
              </label>
            )}
            <div className={`sync-message ${syncDialog.phase}`}>
              <strong>{syncDialog.phase === "missing" ? "需要安装 Runtime" : syncDialog.phase === "outdated" ? "需要更新 Runtime" : syncDialog.phase === "overwrite" ? `确认覆盖同名${isEnemy ? "敌人" : "角色"}` : syncDialog.phase === "done" ? "同步完成" : syncDialog.phase === "error" ? "操作失败" : showingBoundUnityProject ? "已绑定项目" : "项目连接"}</strong>
              <span>{syncDialog.message}</span>
              {syncDialog.runtimeVersion && <small>Runtime {syncDialog.runtimeVersion}</small>}
            </div>
            {showingBoundUnityProject && (
              <div className="unity-character-loader">
                <div className="section-heading">
                  <div><strong>打开已同步{isEnemy ? "敌人" : "角色"}</strong><span>{unityCharacters.length} 个</span></div>
                  <button type="button" className="create-enemy-button" onClick={createNewActor}><Plus size={14} />创建新{isEnemy ? "敌人" : "角色"}</button>
                </div>
                {unityCharacters.length ? <div className="unity-character-loader-row has-delete">
                  <select aria-label={`Unity 已同步${isEnemy ? "敌人" : "角色"}`} value={selectedUnityCharacterPath} onChange={(event) => { setSelectedUnityCharacterPath(event.target.value); setPendingUnityEnemyDeletion(null); }}>
                    {unityCharacters.map((item) => <option key={item.jsonPath} value={item.jsonPath}>{item.characterName}</option>)}
                  </select>
                  <button type="button" disabled={loadingUnityCharacter} onClick={() => void loadCharacterFromUnity()}><FolderOpen size={15} />{loadingUnityCharacter ? "载入中..." : `打开${isEnemy ? "敌人" : "角色"}`}</button>
                  <button
                    type="button"
                    className="icon-button danger"
                    title={`从 Unity 项目删除选中的${isEnemy ? "敌人" : "角色"}`}
                    disabled={!selectedUnityCharacterPath || deletingUnityEnemy}
                    onClick={() => setPendingUnityEnemyDeletion(unityCharacters.find((item) => item.jsonPath === selectedUnityCharacterPath) || null)}
                  ><Trash2 size={15} /></button>
                </div> : <span className="unity-character-loader-empty">项目中还没有已同步的{isEnemy ? "敌人" : "角色"}</span>}
                {pendingUnityEnemyDeletion && <div className="unity-delete-confirmation">
                  <TriangleAlert size={18} />
                  <div>
                    <strong>确认从 Unity 删除{isEnemy ? "敌人" : "角色"}“{pendingUnityEnemyDeletion.characterName}”？</strong>
                    <span>将删除该{isEnemy ? "敌人" : "角色"}的同步源数据、图片、音频和生成资源。</span>
                    <small>{pendingUnityEnemyDeletion.sharedPrefab
                      ? `该 Prefab 还被其他已同步${isEnemy ? "敌人" : "角色"}引用，将保留并交给剩余${isEnemy ? "敌人" : "角色"}重新同步：${pendingUnityEnemyDeletion.prefabPath}`
                      : pendingUnityEnemyDeletion.generatedPrefab
                      ? `自动生成 Prefab 也会删除：${pendingUnityEnemyDeletion.prefabPath}`
                      : `项目原有 Prefab 会保留：${pendingUnityEnemyDeletion.prefabPath || "未绑定 Prefab"}。其中已写入的组件不会自动还原。`}</small>
                    <small>工具内的本地草稿会保留，之后重新同步会再次创建该{isEnemy ? "敌人" : "角色"}。</small>
                    <div className="unity-delete-confirmation-actions">
                      <button type="button" disabled={deletingUnityEnemy} onClick={() => setPendingUnityEnemyDeletion(null)}>取消</button>
                      <button type="button" className="danger-button" disabled={deletingUnityEnemy} onClick={() => void deleteActorFromUnity()}>{deletingUnityEnemy ? "删除中..." : "确认删除"}</button>
                    </div>
                  </div>
                </div>}
              </div>
            )}
            {(syncDialog.phase === "missing" || syncDialog.phase === "outdated") && (
              <div className="runtime-summary">
                <span>安装位置：Packages/com.frame-action.runtime</span>
                <span>内容：帧动画播放器、时间事件分发、Editor 数据导入器</span>
                <span>不会修改项目业务代码，也不包含生命值、伤害计算或死亡逻辑</span>
              </div>
            )}
            <div className="modal-actions">
              {boundUnityProjectPath && syncDialog.phase !== "checking" && syncDialog.phase !== "syncing" && <div className="sync-management-actions">
                <button type="button" onClick={changeUnityProject}><FolderOpen size={14} />更换项目</button>
                <button type="button" className="danger-text" onClick={unbindUnityProject}><Unlink size={14} />解除绑定</button>
              </div>}
              {syncDialog.phase !== "overwrite" && <button type="button" onClick={() => { setPendingEnemyOverwrite(null); setSyncDialog(null); }}>关闭</button>}
              {syncDialog.phase === "overwrite" ? <>
                <button type="button" onClick={cancelEnemyOverwrite}>取消覆盖</button>
                <button type="button" className="primary-button" onClick={() => void confirmEnemyOverwrite()}>覆盖并同步</button>
              </> : syncDialog.phase === "missing" ? (
                <button type="button" className="primary-button" onClick={() => void installRuntimeAndSync()}>安装并同步</button>
              ) : syncDialog.phase === "outdated" ? (
                <button type="button" className="primary-button" onClick={() => void installRuntimeAndSync()}>更新 Runtime 并同步</button>
              ) : syncDialog.phase !== "done" ? (
                <button
                  type="button"
                  className="primary-button"
                  disabled={!syncDialog.path.trim() || syncDialog.phase === "checking" || syncDialog.phase === "syncing"}
                  onClick={() => void checkAndSyncUnity()}
                >
                  {syncDialog.phase === "checking" || syncDialog.phase === "syncing" ? "处理中..." : showingBoundUnityProject ? "立即同步" : boundUnityProjectPath ? "检查并更换" : "检查并绑定"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
