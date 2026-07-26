import { useEffect, useMemo, useRef, useState } from "react";
import { actionPlaybackDuration, frameAtTick } from "../model";
import type { ActionSegment, AssetRef, CharacterProject, TimelineEvent } from "../types";

interface Point {
  x: number;
  y: number;
}

interface Props {
  project: CharacterProject;
  segment: ActionSegment;
  actionLoop: boolean;
  assets: Record<string, AssetRef>;
  playheadTick: number;
  selectedEventId: string | null;
  background: "transparent" | "light" | "dark";
  showGrid: boolean;
  showBoxes: boolean;
  showTarget: boolean;
  sceneEditMode: boolean;
  facingLeft: boolean;
  editTarget: string;
  handlesLocked: boolean;
  target: Point;
  onTargetChange: (target: Point) => void;
  onSelectEvent: (eventId: string) => void;
  onUpdateEvent: (eventId: string, patch: Partial<TimelineEvent>) => void;
  onUpdateUnityCharacter: (patch: Partial<CharacterProject["unityCharacter"]>) => void;
}

interface DamageGeometry {
  event: TimelineEvent;
  effectIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  rotation: number;
  facingSign: number;
}

type VfxLocation =
  | { scope: "top"; effectIndex: number }
  | { scope: "companion" | "hit"; damageIndex: number; effectIndex: number };

type MotionOwner = { type: "damage"; effectIndex: number } | { type: "vfx"; location: VfxLocation };

type EditAction =
  | { kind: "bodyColliderMove" | "bodyColliderWidth" | "bodyColliderHeight" | "bodyColliderResize"; centerX: number; centerY: number }
  | { kind: "hurtboxMove" | "hurtboxWidth" | "hurtboxHeight" | "hurtboxResize"; centerX: number; centerY: number }
  | { kind: "damageMove" | "damageResize" | "damageRotate" | "damageRayEnd" | "damageRayRadius"; effectIndex: number; centerX: number; centerY: number; facingSign: number }
  | { kind: "vfxMove" | "vfxScale" | "vfxRotate"; location: VfxLocation; centerX: number; centerY: number }
  | { kind: "motionPoint"; owner: MotionOwner; fieldX: string; fieldY: string }
  | { kind: "cameraPoint"; fieldX: string; fieldY: string };

interface EditHandle {
  event: TimelineEvent | null;
  x: number;
  y: number;
  radius: number;
  action: EditAction;
}

interface DamagePreview {
  event: TimelineEvent;
  effect: any;
  effectIndex: number;
  detectionType: string;
  center: Point;
  motionOrigin: Point;
  rotation: number;
  facingSign: number;
  boxWidth: number;
  boxHeight: number;
  activeStart: number;
  hitTick: number;
  active: boolean;
  exists: boolean;
  hit: boolean;
}

const UNIT_SCALE = 72;
const TARGET_RADIUS = 0.42;
const TARGET_RETURN_DELAY_SECONDS = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundColliderValue(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeDegrees(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function isDirectionalDamageShape(effect: any, detectionType: string): boolean {
  return detectionType === "raycast" || effect.shape === "sector";
}

function damagePreviewRotation(effect: any, detectionType: string, facingSign: number): number {
  const rotation = Number(effect.rotation || 0);
  if (facingSign < 0 && isDirectionalDamageShape(effect, detectionType)) return 180 - rotation;
  return rotation * facingSign;
}

function damageConfiguredRotation(effect: any, detectionType: string, facingSign: number, previewRotation: number): number {
  const rotation = facingSign < 0 && isDirectionalDamageShape(effect, detectionType)
    ? 180 - previewRotation
    : previewRotation * facingSign;
  return normalizeDegrees(rotation);
}

function resolveBoxGrowth(effect: any, elapsedTicks: number, tickRate: number, facingSign: number, rotationDegrees: number) {
  const baseWidth = Math.max(0.05, Number(effect.boxWidth || 1));
  const baseHeight = Math.max(0.05, Number(effect.boxHeight || 1));
  if (!effect.boxGrowthEnabled || (effect.detectionType || "rangeOverlap") !== "rangeOverlap" || (effect.shape || "box") !== "box") {
    return { width: baseWidth, height: baseHeight, extension: 0, offset: { x: 0, y: 0 } };
  }
  const durationTicks = Math.max(1, Number(effect.boxGrowthDurationTicks || tickRate * 2));
  const speed = Math.max(0, Number(effect.boxGrowthSpeed || 0));
  const extension = speed * clamp(Math.max(0, elapsedTicks), 0, durationTicks) / Math.max(1, tickRate);
  const direction = ["up", "down", "left", "right"].includes(effect.boxGrowthDirection) ? effect.boxGrowthDirection : "right";
  const localDirection = direction === "up"
    ? { x: 0, y: 1 }
    : direction === "down"
      ? { x: 0, y: -1 }
      : direction === "left"
        ? { x: -facingSign, y: 0 }
        : { x: facingSign, y: 0 };
  const offset = rotate({ x: localDirection.x * extension * 0.5, y: localDirection.y * extension * 0.5 }, rotationDegrees);
  return {
    width: baseWidth + (direction === "left" || direction === "right" ? extension : 0),
    height: baseHeight + (direction === "up" || direction === "down" ? extension : 0),
    extension,
    offset,
  };
}

function rotate(point: Point, degrees: number): Point {
  const angle = degrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { x: point.x * cosine - point.y * sine, y: point.x * sine + point.y * cosine };
}

function normalize(point: Point): Point {
  const length = Math.hypot(point.x, point.y);
  return length > 0.0001 ? { x: point.x / length, y: point.y / length } : { x: 1, y: 0 };
}

function cubicBezier(start: Point, controlA: Point, controlB: Point, end: Point, progress: number): Point {
  const t = clamp(progress, 0, 1);
  const inverse = 1 - t;
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * t * controlA.x + 3 * inverse * t ** 2 * controlB.x + t ** 3 * end.x,
    y: inverse ** 3 * start.y + 3 * inverse ** 2 * t * controlA.y + 3 * inverse * t ** 2 * controlB.y + t ** 3 * end.y,
  };
}

function evaluateProgressCurve(value: any, time: number): number {
  const keys = Array.isArray(value)
    ? value.map((item) => ({ time: clamp(Number(item?.time) || 0, 0, 1), value: clamp(Number(item?.value) || 0, 0, 1), tangentMode: ["smooth", "flat"].includes(item?.tangentMode) ? item.tangentMode : "linear" })).sort((left, right) => left.time - right.time)
    : [];
  const t = clamp(time, 0, 1);
  if (keys.length < 2) return t;
  if (t <= keys[0].time) return keys[0].value;
  for (let index = 1; index < keys.length; index += 1) {
    const right = keys[index];
    if (t > right.time) continue;
    const left = keys[index - 1];
    const range = Math.max(0.0001, right.time - left.time);
    const u = (t - left.time) / range;
    const slope = (from: number, to: number) => (keys[to].value - keys[from].value) / Math.max(0.0001, keys[to].time - keys[from].time);
    const tangent = (keyIndex: number, side: "in" | "out") => {
      const key = keys[keyIndex];
      if (key.tangentMode === "flat") return 0;
      const leftSlope = keyIndex > 0 ? slope(keyIndex - 1, keyIndex) : null;
      const rightSlope = keyIndex < keys.length - 1 ? slope(keyIndex, keyIndex + 1) : null;
      if (key.tangentMode === "linear") return side === "in" ? leftSlope ?? rightSlope ?? 0 : rightSlope ?? leftSlope ?? 0;
      return leftSlope !== null && rightSlope !== null ? (leftSlope + rightSlope) * 0.5 : leftSlope ?? rightSlope ?? 0;
    };
    const m0 = tangent(index - 1, "out") * range;
    const m1 = tangent(index, "in") * range;
    const u2 = u * u;
    const u3 = u2 * u;
    return clamp((2 * u3 - 3 * u2 + 1) * left.value + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * right.value + (u3 - u2) * m1, 0, 1);
  }
  return keys.at(-1)?.value ?? t;
}

function eventTriggerTick(event: TimelineEvent, tick: number, actionEndTick: number): number | null {
  if (tick < event.startTick) return null;
  if (event.triggerMode !== "repeated") return event.startTick;
  if (event.activeDurationMode === "untilActionEnd" && event.startTick >= actionEndTick) return null;
  const interval = Math.max(1, event.repeatIntervalTicks);
  const currentIndex = Math.max(0, Math.floor((tick - event.startTick) / interval));
  const repeatDuration = event.activeDurationMode === "untilActionEnd"
    ? Math.max(0, actionEndTick - 1 - event.startTick)
    : Math.max(0, event.durationTicks);
  const lastIndex = Math.floor(repeatDuration / interval);
  return event.startTick + Math.min(currentIndex, lastIndex) * interval;
}

function eventTriggerTicksUntil(event: TimelineEvent, tick: number, actionEndTick: number): number[] {
  if (tick < event.startTick) return [];
  if (event.triggerMode !== "repeated") return [event.startTick];
  if (event.activeDurationMode === "untilActionEnd" && event.startTick >= actionEndTick) return [];
  const interval = Math.max(1, Number(event.repeatIntervalTicks || 1));
  const repeatDuration = event.activeDurationMode === "untilActionEnd"
    ? Math.max(0, actionEndTick - 1 - event.startTick)
    : Math.max(0, Number(event.durationTicks || 0));
  const lastIndex = Math.min(Math.floor((tick - event.startTick) / interval), Math.floor(repeatDuration / interval));
  return Array.from({ length: Math.max(0, lastIndex + 1) }, (_, index) => event.startTick + index * interval);
}

function damageActivationTicks(effect: any, triggerTick: number, tick: number): number[] {
  const detectionDuration = Math.max(0, Number(effect.detectionDurationTicks || 0));
  const activationTick = Math.min(Math.max(0, Number(effect.activationTick || 0)), detectionDuration);
  const effectiveStart = triggerTick + Math.max(0, Number(effect.triggerDelayTicks || 0));
  const firstTick = effectiveStart + activationTick;
  if (firstTick > tick) return [];
  const intermittent = (effect.activationMode || "continuous") === "intermittent";
  const perActivation = (effect.deduplicationScope || "wholeEvent") === "perActivation";
  if (!intermittent || !perActivation) return [firstTick];
  const activeTicks = Math.max(1, Number(effect.intermittentActiveTicks || 1));
  const intervalTicks = Math.max(0, Number(effect.intermittentIntervalTicks || 0));
  const cycleTicks = activeTicks + intervalTicks;
  const availableTicks = Math.max(0, detectionDuration - activationTick);
  const cycleCount = Math.max(1, Math.ceil(Math.max(0, availableTicks - 0.000001) / cycleTicks));
  const visibleCycles = Math.min(cycleCount, Math.floor((tick - firstTick) / cycleTicks) + 1);
  return Array.from({ length: Math.max(0, visibleCycles) }, (_, index) => firstTick + index * cycleTicks);
}

function evaluateMaxProgressUntil(curve: any, normalizedTime: number): number {
  const clampedTime = clamp(normalizedTime, 0, 1);
  const sampleCount = Math.max(2, Math.ceil(clampedTime * 24));
  let maxProgress = 0;
  for (let index = 0; index <= sampleCount; index += 1) {
    maxProgress = Math.max(maxProgress, evaluateProgressCurve(curve, clampedTime * index / sampleCount));
  }
  return maxProgress;
}

function evaluateMotion(motion: any, elapsedTicks: number, tickRate: number, facingSign = 1, origin?: Point, retarget?: Point): Point {
  if (!motion?.enabled || elapsedTicks <= 0) return { x: 0, y: 0 };
  if ((motion.mode || "linear") === "bezier") {
    const duration = Math.max(1, Number(motion.durationTicks || 1));
    const normalizedTime = clamp(elapsedTicks / duration, 0, 1);
    const progress = evaluateProgressCurve(motion.pathProgressCurve, normalizedTime);
    const point = cubicBezier(
      { x: 0, y: 0 },
      { x: Number(motion.controlAX || 0) * facingSign, y: Number(motion.controlAY || 0) },
      { x: Number(motion.controlBX || 0) * facingSign, y: Number(motion.controlBY || 0) },
      { x: Number(motion.endX || 0) * facingSign, y: Number(motion.endY || 0) },
      progress,
    );
    if (motion.retargetOnDescendingPath && origin && retarget) {
      const maxProgress = evaluateMaxProgressUntil(motion.pathProgressCurve, normalizedTime);
      if (maxProgress > 0.0001 && progress < maxProgress - 0.0001) {
        const farthest = cubicBezier(
          { x: 0, y: 0 },
          { x: Number(motion.controlAX || 0) * facingSign, y: Number(motion.controlAY || 0) },
          { x: Number(motion.controlBX || 0) * facingSign, y: Number(motion.controlBY || 0) },
          { x: Number(motion.endX || 0) * facingSign, y: Number(motion.endY || 0) },
          maxProgress,
        );
        const returnLerp = clamp(1 - progress / maxProgress, 0, 1);
        return {
          x: farthest.x + (retarget.x - origin.x - farthest.x) * returnLerp,
          y: farthest.y + (retarget.y - origin.y - farthest.y) * returnLerp,
        };
      }
    }
    return point;
  }
  const direction = normalize({ x: Number(motion.directionX || 0) * facingSign, y: Number(motion.directionY || 0) });
  const distance = Math.max(0, Number(motion.speed || 0)) * elapsedTicks / Math.max(1, tickRate);
  return { x: direction.x * distance, y: direction.y * distance };
}

function evaluatePhysicalEntityMotion(effect: any, elapsedTicks: number, tickRate: number, facingSign: number, origin: Point, retarget: Point): Point {
  const elapsedSeconds = Math.max(0, elapsedTicks) / Math.max(1, tickRate);
  const motion = evaluateMotion(effect.motion, elapsedTicks, tickRate, facingSign, origin, retarget);
  const bezier = effect.motion?.enabled && (effect.motion.mode || "linear") === "bezier";
  const pathDurationSeconds = Math.max(1, Number(effect.motion?.durationTicks || 1)) / Math.max(1, tickRate);
  const gravitySeconds = bezier ? Math.max(0, elapsedSeconds - pathDurationSeconds) : elapsedSeconds;
  return {
    x: motion.x,
    y: motion.y - 0.5 * 9.81 * Math.max(0, Number(effect.physicalGravityScale ?? 1)) * gravitySeconds * gravitySeconds,
  };
}

function vfxFrameAssetIds(effect: any): string[] {
  const ids = Array.isArray(effect.frameAssetIds) ? effect.frameAssetIds.filter((id: unknown) => typeof id === "string" && id) : [];
  if (!ids.length && effect.assetId) ids.push(effect.assetId);
  return ids;
}

function vfxNaturalDurationTicks(effect: any, tickRate: number): number {
  return Math.max(1, vfxFrameAssetIds(effect).length) * tickRate / Math.max(1, Number(effect.fps || 12));
}

function damageAnchorTick(effect: any, detectionType: string, triggerTick: number, sampleTick: number): number {
  const followsAnchor = detectionType !== "physicalEntity" && (effect.anchor || "world") !== "world";
  if (!followsAnchor || !effect.useFollowDuration) return sampleTick;
  return Math.min(sampleTick, triggerTick + Math.max(0, Number(effect.followDurationTicks || 0)));
}

function damagePreviewWindow(event: TimelineEvent, effect: any, tick: number, tickRate: number, actionEndTick: number): { trigger: number; start: number; hitTick: number; active: boolean } | null {
  const triggerDelay = Math.max(0, Number(effect.triggerDelayTicks || 0));
  const triggerTick = eventTriggerTick(event, tick - triggerDelay, actionEndTick);
  if (triggerTick === null) return null;
  const effectiveStart = triggerTick + triggerDelay;
  const detectionDuration = Math.max(0, Number(effect.detectionDurationTicks || 0));
  const activation = Math.min(Math.max(0, Number(effect.activationTick || 0)), detectionDuration);
  const physicsLifetime = Math.max(0, ...(effect.onHitPhysicsEffects || []).map((item: any) => Number(item.delayTicks || 0) + Number(item.durationTicks || 0)));
  const vfxLifetime = Math.max(0, ...(effect.onHitVfxEffects || []).map((item: any) => Number(item.triggerDelayTicks || 0) + vfxNaturalDurationTicks(item, tickRate)));
  const sfxLifetime = Math.max(0, ...(effect.onHitSfxEffects || []).map((item: any) => Number(item.triggerDelayTicks || 0) + (item.loop ? Number(item.durationTicks || 180) : 30)));
  const damageLifetime = Math.max(0, ...(effect.onHitDamageEffects || []).map((item: any) => Number(item.delayTicks || 0)));
  // This only keeps already-triggered hit feedback visible in the preview. It is not the damage event's timeline duration.
  const lifetime = Math.max(detectionDuration, activation + Math.max(physicsLifetime, vfxLifetime, sfxLifetime, damageLifetime));
  const elapsed = tick - effectiveStart;
  if (elapsed < 0 || elapsed > lifetime) return null;
  const activationElapsed = elapsed - activation;
  let active = activationElapsed >= 0 && (detectionDuration <= 0 ? activationElapsed <= 1 : elapsed <= detectionDuration);
  let activationCycle = 0;
  if (active && (effect.activationMode || "continuous") === "intermittent") {
    const activeTicks = Math.max(1, Number(effect.intermittentActiveTicks || 1));
    const interval = Math.max(0, Number(effect.intermittentIntervalTicks || 0));
    const cycleTicks = activeTicks + interval;
    const availableTicks = Math.max(0, detectionDuration - activation);
    const cycleCount = Math.max(1, Math.ceil(Math.max(0, availableTicks - 0.000001) / cycleTicks));
    activationCycle = Math.min(Math.max(0, Math.floor(Math.max(0, activationElapsed) / cycleTicks)), cycleCount - 1);
    if (activationElapsed % cycleTicks >= activeTicks) active = false;
  }
  const deduplication = effect.deduplicationScope || "wholeEvent";
  const cycleTicks = Math.max(1, Number(effect.intermittentActiveTicks || 1)) + Math.max(0, Number(effect.intermittentIntervalTicks || 0));
  const hitTick = deduplication === "perDetection"
    ? tick
    : effectiveStart + activation + (deduplication === "perActivation" ? activationCycle * cycleTicks : 0);
  return { trigger: triggerTick, start: effectiveStart, hitTick, active };
}

function pointHitsDamage(targetCenter: Point, preview: Omit<DamagePreview, "hit">): boolean {
  const effect = preview.effect;
  const relative = rotate({ x: targetCenter.x - preview.center.x, y: targetCenter.y - preview.center.y }, -preview.rotation);
  if (preview.detectionType === "raycast") {
    const distance = Math.max(0.01, Number(effect.rayMaxDistance || 0.01));
    const radius = Math.max(0, Number(effect.rayRadius || 0)) + TARGET_RADIUS;
    return relative.x >= 0 && relative.x <= distance && Math.abs(relative.y) <= radius;
  }
  if ((effect.shape || "box") === "box") {
    return Math.abs(relative.x) <= preview.boxWidth / 2 + TARGET_RADIUS
      && Math.abs(relative.y) <= preview.boxHeight / 2 + TARGET_RADIUS;
  }
  const distance = Math.hypot(relative.x, relative.y);
  if (distance > Math.max(0.01, Number(effect.radius || 0.01)) + TARGET_RADIUS) return false;
  if (effect.shape !== "sector") return true;
  const angle = Math.abs(Math.atan2(relative.y, relative.x) * 180 / Math.PI);
  return angle <= Math.max(1, Number(effect.sectorAngle || 1)) / 2;
}

function effectProgress(startTick: number, durationTicks: number, tick: number): number | null {
  if (tick < startTick) return null;
  const duration = Math.max(1, durationTicks);
  if (tick > startTick + duration) return null;
  return clamp((tick - startTick) / duration, 0, 1);
}

function resolveVfxEffect(params: Record<string, any>, location: VfxLocation): any {
  if (location.scope === "top") return params.vfxEffects?.[location.effectIndex];
  const damage = params.damageEffects?.[location.damageIndex];
  return location.scope === "companion"
    ? damage?.companionVfxEffects?.[location.effectIndex]
    : damage?.onHitVfxEffects?.[location.effectIndex];
}

function vfxLocationKey(location: VfxLocation): string {
  return location.scope === "top"
    ? `top:${location.effectIndex}`
    : `${location.scope}:${location.damageIndex}:${location.effectIndex}`;
}

export default function PreviewCanvas(props: Props) {
  const {
    project, segment, actionLoop, assets, playheadTick, selectedEventId, background, showGrid, showBoxes,
    showTarget, sceneEditMode, facingLeft, editTarget, handlesLocked, target, onTargetChange, onSelectEvent, onUpdateEvent,
    onUpdateUnityCharacter,
  } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drawRef = useRef<() => void>(() => {});
  const imageCache = useRef(new Map<string, HTMLImageElement>());
  const damageGeometry = useRef<DamageGeometry[]>([]);
  const editHandles = useRef<EditHandle[]>([]);
  const targetGeometry = useRef({ x: 0, y: 0, radius: 28 });
  const bodyColliderGeometry = useRef({ left: 0, top: 0, width: 0, height: 0, visible: false });
  const hurtboxGeometry = useRef({ left: 0, top: 0, width: 0, height: 0, visible: false });
  const dragRef = useRef<
    | { mode: "damageMove" | "damageResize"; geometry: DamageGeometry; x: number; y: number }
    | { mode: "editHandle"; handle: EditHandle; x: number; y: number }
    | { mode: "bodyColliderMove"; x: number; y: number; offsetX: number; offsetY: number }
    | { mode: "hurtboxMove"; x: number; y: number; offsetX: number; offsetY: number }
    | { mode: "target"; x: number; y: number }
    | { mode: "pan"; x: number; y: number }
    | null
  >(null);
  const [view, setView] = useState({ offsetX: 0, offsetY: 0, zoom: 1 });
  const currentFrame = useMemo(() => frameAtTick(segment, playheadTick, actionLoop), [segment, playheadTick, actionLoop]);
  const actionEndTick = useMemo(() => actionPlaybackDuration(segment), [segment]);
  const facingSign = facingLeft ? -1 : 1;
  const unitScale = UNIT_SCALE * view.zoom;

  const getImage = (assetId?: string) => {
    if (!assetId || !assets[assetId]) return null;
    if (!imageCache.current.has(assetId)) {
      const image = new Image();
      image.src = assets[assetId].url;
      image.onload = () => drawRef.current();
      imageCache.current.set(assetId, image);
    }
    return imageCache.current.get(assetId) ?? null;
  };

  const draw = () => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(dpr, dpr);
    const width = rect.width;
    const height = rect.height;
    const baseOrigin = { x: width * 0.5 + view.offsetX, y: height * 0.78 + view.offsetY };
    editHandles.current = [];
    const worldToScreen = (point: Point) => ({ x: baseOrigin.x + point.x * unitScale, y: baseOrigin.y - point.y * unitScale });
    const isEditTarget = (event: TimelineEvent, key: string) => sceneEditMode && event.id === selectedEventId && (!editTarget || editTarget === key);
    const drawEditHandle = (screen: Point, event: TimelineEvent | null, action: EditAction, label: string, color: string, radius = 7) => {
      context.save();
      context.fillStyle = "#fff";
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      if (label) {
        context.fillStyle = color;
        context.font = "600 10px system-ui";
        context.fillText(label, screen.x + radius + 3, screen.y - radius - 2);
      }
      context.restore();
      if (!handlesLocked) editHandles.current.push({ event, x: screen.x, y: screen.y, radius: radius + 5, action });
    };
    const drawMotionPath = (event: TimelineEvent, motion: any, origin: Point, owner: MotionOwner, targetKey: string, color: string) => {
      if (!isEditTarget(event, targetKey) || !motion?.enabled || motion.mode !== "bezier") return;
      const controlA = { x: origin.x + Number(motion.controlAX || 0) * facingSign, y: origin.y + Number(motion.controlAY || 0) };
      const controlB = { x: origin.x + Number(motion.controlBX || 0) * facingSign, y: origin.y + Number(motion.controlBY || 0) };
      const end = { x: origin.x + Number(motion.endX || 0) * facingSign, y: origin.y + Number(motion.endY || 0) };
      const startScreen = worldToScreen(origin);
      const controlAScreen = worldToScreen(controlA);
      const controlBScreen = worldToScreen(controlB);
      const endScreen = worldToScreen(end);
      context.save();
      context.strokeStyle = color;
      context.lineWidth = 1.5;
      context.setLineDash([5, 4]);
      context.beginPath(); context.moveTo(startScreen.x, startScreen.y); context.lineTo(controlAScreen.x, controlAScreen.y); context.stroke();
      context.beginPath(); context.moveTo(controlBScreen.x, controlBScreen.y); context.lineTo(endScreen.x, endScreen.y); context.stroke();
      context.setLineDash([]);
      context.beginPath();
      for (let index = 0; index <= 36; index += 1) {
        const point = worldToScreen(cubicBezier(origin, controlA, controlB, end, index / 36));
        if (index === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y);
      }
      context.stroke();
      context.restore();
      drawEditHandle(controlAScreen, event, { kind: "motionPoint", owner, fieldX: "controlAX", fieldY: "controlAY" }, "A", "#d89a1d", 6);
      drawEditHandle(controlBScreen, event, { kind: "motionPoint", owner, fieldX: "controlBX", fieldY: "controlBY" }, "B", "#e26d2f", 6);
      drawEditHandle(endScreen, event, { kind: "motionPoint", owner, fieldX: "endX", fieldY: "endY" }, "终", "#c93f35", 7);
    };

    if (background === "transparent") {
      for (let y = 0; y < height; y += 16) for (let x = 0; x < width; x += 16) {
        context.fillStyle = (x / 16 + y / 16) % 2 === 0 ? "#f4f4f2" : "#deded9";
        context.fillRect(x, y, 16, 16);
      }
    } else {
      context.fillStyle = background === "dark" ? "#181b1d" : "#f7f6f2";
      context.fillRect(0, 0, width, height);
    }

    if (showGrid) {
      context.strokeStyle = background === "dark" ? "rgba(255,255,255,.09)" : "rgba(20,28,31,.09)";
      context.lineWidth = 1;
      for (let x = ((baseOrigin.x % unitScale) + unitScale) % unitScale; x < width; x += unitScale) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
      for (let y = ((baseOrigin.y % unitScale) + unitScale) % unitScale; y < height; y += unitScale) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
    }
    context.strokeStyle = "#d5a328";
    context.lineWidth = 1.5;
    context.beginPath(); context.moveTo(0, baseOrigin.y); context.lineTo(width, baseOrigin.y); context.stroke();
    context.beginPath(); context.moveTo(baseOrigin.x, 0); context.lineTo(baseOrigin.x, height); context.stroke();

    const evaluateCaster = (tick: number) => {
      const offset = { x: 0, y: 0 };
      const statuses: string[] = [];
      let currentFacingSign = facingSign;
      for (const event of segment.tracks.find((track) => track.kind === "physics")?.events || []) {
        const triggerTick = eventTriggerTick(event, tick, actionEndTick);
        if (triggerTick === null) continue;
        for (const effect of event.params.physicsEffects || []) {
          const start = triggerTick + Number(effect.delayTicks || 0);
          if (effect.effectType === "teleportSelf") {
            if (tick < start) continue;
            const distance = Number(effect.distance || 0);
            if (effect.anchor === "target") {
              const targetFacingSign = target.x >= offset.x ? -1 : 1;
              offset.x = target.x + distance * targetFacingSign;
              offset.y = target.y;
              if (Math.abs(target.x - offset.x) > 0.0001) currentFacingSign = target.x < offset.x ? -1 : 1;
            } else {
              offset.x += distance * currentFacingSign;
            }
            continue;
          }
          if (effect.durationMode === "untilActionEnd" && start >= actionEndTick) continue;
          const effectDuration = effect.durationMode === "untilActionEnd"
            ? Math.max(1, actionEndTick - start)
            : Number(effect.durationTicks || 0);
          const progress = effectProgress(start, effectDuration, tick);
          if (progress === null) continue;
          if (effect.effectType === "dashSelf") offset.x += Number(effect.distance || 0) * progress * currentFacingSign;
          if (effect.effectType === "airborne") offset.y += Number(effect.height || 0) * 4 * progress * (1 - progress);
          if (effect.effectType === "hover") statuses.push("滞空");
          if (effect.effectType === "superArmor") statuses.push("霸体");
          if (effect.effectType === "invincible") statuses.push("无敌");
        }
      }
      return { position: offset, statuses, facingSign: currentFacingSign };
    };
    const casterState = evaluateCaster(playheadTick);
    const casterWorld = casterState.position;
    const casterStatuses = casterState.statuses;
    const casterFacingLeft = casterState.facingSign < 0;
    const casterScreen = { x: baseOrigin.x + casterWorld.x * unitScale, y: baseOrigin.y - casterWorld.y * unitScale };

    const drawFrame = () => {
      if (!currentFrame) return;
      const image = getImage(currentFrame.assetId);
      if (!image || !image.complete || !image.naturalWidth) return;
      const pixelScale = unitScale / Math.max(1, segment.pixelsPerUnit);
      context.save();
      context.translate(casterScreen.x, casterScreen.y);
      if ((project.sourceFacing === "left") !== casterFacingLeft) context.scale(-1, 1);
      context.drawImage(
        image,
        -segment.pivotX * pixelScale,
        -(image.naturalHeight - segment.pivotY) * pixelScale,
        image.naturalWidth * pixelScale,
        image.naturalHeight * pixelScale,
      );
      context.restore();
    };
    drawFrame();

    const bodyColliderSelected = sceneEditMode && editTarget === "bodyCollider";
    const bodyColliderVisible = showBoxes || bodyColliderSelected;
    bodyColliderGeometry.current.visible = bodyColliderVisible;
    if (bodyColliderVisible) {
      const settings = project.unityCharacter;
      const colliderWidth = Math.max(0.01, Number(settings.colliderWidth || 0.01)) * unitScale;
      const colliderHeight = Math.max(0.01, Number(settings.colliderHeight || 0.01)) * unitScale;
      const colliderCenter = {
        x: casterScreen.x + Number(settings.colliderOffsetX || 0) * unitScale,
        y: casterScreen.y - Number(settings.colliderOffsetY || 0) * unitScale,
      };
      const left = colliderCenter.x - colliderWidth / 2;
      const top = colliderCenter.y - colliderHeight / 2;
      bodyColliderGeometry.current = { left, top, width: colliderWidth, height: colliderHeight, visible: true };
      context.save();
      context.fillStyle = bodyColliderSelected ? "rgba(21,139,145,.20)" : "rgba(21,139,145,.10)";
      context.strokeStyle = bodyColliderSelected ? "#087d82" : "#159096";
      context.lineWidth = bodyColliderSelected ? 3 : 2;
      context.beginPath();
      if (settings.colliderShape === "capsule") {
        context.roundRect(left, top, colliderWidth, colliderHeight, Math.min(colliderWidth, colliderHeight) / 2);
      } else {
        context.rect(left, top, colliderWidth, colliderHeight);
      }
      context.fill();
      context.stroke();
      context.fillStyle = "#08777c";
      context.font = "12px system-ui";
      context.fillText("角色身体碰撞体", left, Math.max(14, top - 6));
      context.restore();
      if (bodyColliderSelected) {
        drawEditHandle(colliderCenter, null, { kind: "bodyColliderMove", centerX: colliderCenter.x, centerY: colliderCenter.y }, "移", "#087d82", 7);
        drawEditHandle({ x: colliderCenter.x + colliderWidth / 2, y: colliderCenter.y }, null, { kind: "bodyColliderWidth", centerX: colliderCenter.x, centerY: colliderCenter.y }, "宽", "#087d82", 6);
        drawEditHandle({ x: colliderCenter.x, y: colliderCenter.y + colliderHeight / 2 }, null, { kind: "bodyColliderHeight", centerX: colliderCenter.x, centerY: colliderCenter.y }, "高", "#087d82", 6);
        drawEditHandle({ x: colliderCenter.x + colliderWidth / 2, y: colliderCenter.y + colliderHeight / 2 }, null, { kind: "bodyColliderResize", centerX: colliderCenter.x, centerY: colliderCenter.y }, "缩", "#087d82", 6);
      }
    }

    const hurtboxSelected = sceneEditMode && editTarget === "hurtbox";
    const hurtboxVisible = showBoxes || hurtboxSelected;
    hurtboxGeometry.current.visible = hurtboxVisible;
    if (hurtboxVisible) {
      const settings = project.unityCharacter;
      const hurtboxWidth = Math.max(0.01, Number(settings.hurtboxWidth || 0.01)) * unitScale;
      const hurtboxHeight = Math.max(0.01, Number(settings.hurtboxHeight || 0.01)) * unitScale;
      const hurtboxCenter = {
        x: casterScreen.x + Number(settings.hurtboxOffsetX || 0) * unitScale,
        y: casterScreen.y - Number(settings.hurtboxOffsetY || 0) * unitScale,
      };
      const left = hurtboxCenter.x - hurtboxWidth / 2;
      const top = hurtboxCenter.y - hurtboxHeight / 2;
      hurtboxGeometry.current = { left, top, width: hurtboxWidth, height: hurtboxHeight, visible: true };
      context.save();
      context.fillStyle = hurtboxSelected ? "rgba(136,76,166,.20)" : "rgba(136,76,166,.09)";
      context.strokeStyle = hurtboxSelected ? "#764092" : "#9256ad";
      context.lineWidth = hurtboxSelected ? 3 : 2;
      context.setLineDash(hurtboxSelected ? [] : [5, 3]);
      context.beginPath();
      if (settings.hurtboxShape === "capsule") context.roundRect(left, top, hurtboxWidth, hurtboxHeight, Math.min(hurtboxWidth, hurtboxHeight) / 2);
      else context.rect(left, top, hurtboxWidth, hurtboxHeight);
      context.fill();
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = "#74408d";
      context.font = "12px system-ui";
      context.fillText("角色受击区域", left + 4, top + 15);
      context.restore();
      if (hurtboxSelected) {
        drawEditHandle(hurtboxCenter, null, { kind: "hurtboxMove", centerX: hurtboxCenter.x, centerY: hurtboxCenter.y }, "移", "#764092", 7);
        drawEditHandle({ x: hurtboxCenter.x + hurtboxWidth / 2, y: hurtboxCenter.y }, null, { kind: "hurtboxWidth", centerX: hurtboxCenter.x, centerY: hurtboxCenter.y }, "宽", "#764092", 6);
        drawEditHandle({ x: hurtboxCenter.x, y: hurtboxCenter.y + hurtboxHeight / 2 }, null, { kind: "hurtboxHeight", centerX: hurtboxCenter.x, centerY: hurtboxCenter.y }, "高", "#764092", 6);
        drawEditHandle({ x: hurtboxCenter.x + hurtboxWidth / 2, y: hurtboxCenter.y + hurtboxHeight / 2 }, null, { kind: "hurtboxResize", centerX: hurtboxCenter.x, centerY: hurtboxCenter.y }, "缩", "#764092", 6);
      }
    }

    const targetBase = { ...target };
    const targetCenterBase = { x: targetBase.x, y: targetBase.y + 0.75 };
    type TargetPhysicsRecord = {
      type: string;
      startTick: number;
      endTick: number;
      durationTicks: number;
      direction: number;
      distance: number;
      height: number;
    };
    const targetReturnDelayTicks = Math.max(1, project.tickRate * TARGET_RETURN_DELAY_SECONDS);
    const targetStateCache = new Map<number, { position: Point; statuses: string[] }>();
    const resolveTargetPhysicsOffset = (tick: number, records: TargetPhysicsRecord[]): Point => {
      const positional = records
        .filter((record) => record.startTick <= tick && ["knockback", "pull", "launch", "airborne"].includes(record.type))
        .sort((left, right) => left.startTick - right.startTick || left.endTick - right.endTick);
      if (!positional.length) return { x: 0, y: 0 };
      let chain: TargetPhysicsRecord[] = [];
      let chainEnd = Number.NEGATIVE_INFINITY;
      for (const record of positional) {
        if (chain.length && record.startTick > chainEnd + targetReturnDelayTicks) chain = [];
        if (!chain.length) chainEnd = record.endTick;
        else chainEnd = Math.max(chainEnd, record.endTick);
        chain.push(record);
      }
      if (tick > chainEnd + targetReturnDelayTicks) return { x: 0, y: 0 };
      const offset = { x: 0, y: 0 };
      for (const record of chain) {
        const progress = clamp((tick - record.startTick) / Math.max(1, record.durationTicks), 0, 1);
        offset.x += record.direction * record.distance * progress;
        if (record.type === "launch" || record.type === "airborne") offset.y += record.height * 4 * progress * (1 - progress);
      }
      return offset;
    };
    const evaluateTarget = (tick: number) => {
      const cacheKey = Math.round(tick * 1000) / 1000;
      const cached = targetStateCache.get(cacheKey);
      if (cached) return cached;
      const opportunities: Array<{ event: TimelineEvent; effect: any; effectIndex: number; triggerTick: number; hitTick: number }> = [];
      for (const event of segment.tracks.find((track) => track.kind === "damage")?.events || []) {
        for (const triggerTick of eventTriggerTicksUntil(event, tick, actionEndTick)) {
          (event.params.damageEffects || []).forEach((effect: any, effectIndex: number) => {
            for (const hitTick of damageActivationTicks(effect, triggerTick, tick)) opportunities.push({ event, effect, effectIndex, triggerTick, hitTick });
          });
        }
      }
      opportunities.sort((left, right) => left.hitTick - right.hitTick || left.triggerTick - right.triggerTick || left.effectIndex - right.effectIndex);
      const records: TargetPhysicsRecord[] = [];
      for (const opportunity of opportunities) {
        const { event, effect, effectIndex, triggerTick, hitTick } = opportunity;
        const effectiveStart = triggerTick + Math.max(0, Number(effect.triggerDelayTicks || 0));
        const detectionType = effect.detectionType || "rangeOverlap";
        const anchorMode = effect.anchor || "world";
        const casterAtTrigger = evaluateCaster(triggerTick);
        const anchorTick = hitTick <= effectiveStart
          ? triggerTick
          : damageAnchorTick(effect, detectionType, effectiveStart, hitTick);
        const casterAtHit = evaluateCaster(hitTick);
        const casterAtAnchor = evaluateCaster(anchorTick);
        const targetAtAnchorOffset = resolveTargetPhysicsOffset(anchorTick, records);
        const targetAtAnchor = { x: targetBase.x + targetAtAnchorOffset.x, y: targetBase.y + targetAtAnchorOffset.y };
        const fixedRepeatedAnchor = anchorMode === "world" && event.triggerMode === "repeated" && event.params.repeatedAnchorMode === "fixed";
        const anchorState = fixedRepeatedAnchor
          ? evaluateCaster(event.startTick)
          : anchorMode === "target"
            ? { position: targetAtAnchor, facingSign: casterAtAnchor.facingSign }
            : anchorMode === "self" && detectionType !== "physicalEntity"
              ? casterAtAnchor
              : casterAtTrigger;
        const effectFacingSign = anchorState.facingSign;
        const motionOrigin = detectionType === "raycast"
          ? { x: anchorState.position.x + Number(effect.rayOriginX || 0) * effectFacingSign, y: anchorState.position.y + Number(effect.rayOriginY || 0) }
          : { x: anchorState.position.x + Number(effect.centerX || 0) * effectFacingSign, y: anchorState.position.y + Number(effect.centerY || 0) };
        const retargetOrigin = detectionType === "raycast"
          ? { x: casterAtHit.position.x + Number(effect.rayOriginX || 0) * casterAtHit.facingSign, y: casterAtHit.position.y + Number(effect.rayOriginY || 0) }
          : { x: casterAtHit.position.x + Number(effect.centerX || 0) * casterAtHit.facingSign, y: casterAtHit.position.y + Number(effect.centerY || 0) };
        const elapsedTicks = hitTick - effectiveStart;
        const motion = detectionType === "physicalEntity"
          ? evaluatePhysicalEntityMotion(effect, elapsedTicks, project.tickRate, effectFacingSign, motionOrigin, retargetOrigin)
          : evaluateMotion(effect.motion, elapsedTicks, project.tickRate, effectFacingSign, motionOrigin, retargetOrigin);
        const rotation = damagePreviewRotation(effect, detectionType, effectFacingSign);
        const growth = resolveBoxGrowth(effect, elapsedTicks, project.tickRate, effectFacingSign, rotation);
        const center = { x: motionOrigin.x + motion.x + growth.offset.x, y: motionOrigin.y + motion.y + growth.offset.y };
        const hitPreview: Omit<DamagePreview, "hit"> = {
          event,
          effect,
          effectIndex,
          detectionType,
          center,
          motionOrigin,
          rotation,
          facingSign: effectFacingSign,
          boxWidth: growth.width,
          boxHeight: growth.height,
          activeStart: effectiveStart,
          hitTick,
          active: true,
          exists: true,
        };
        if (!pointHitsDamage(targetCenterBase, hitPreview)) continue;
        for (const physics of effect.onHitPhysicsEffects || []) {
          const startTick = hitTick + Math.max(0, Number(physics.delayTicks || 0));
          const durationTicks = physics.durationMode === "untilActionEnd"
            ? Math.max(1, actionEndTick - startTick)
            : Math.max(1, Number(physics.durationTicks || 1));
          const type = physics.effectType || "";
          const targetOffsetAtStart = resolveTargetPhysicsOffset(startTick, records);
          const targetAtStart = { x: targetBase.x + targetOffsetAtStart.x, y: targetBase.y + targetOffsetAtStart.y };
          const casterAtStart = evaluateCaster(startTick);
          const sourceX = type === "pull" ? center.x : casterAtStart.position.x;
          const deltaX = targetAtStart.x - sourceX;
          const horizontalSign = Math.abs(deltaX) > 0.0001 ? Math.sign(deltaX) : casterAtStart.facingSign;
          records.push({
            type,
            startTick,
            endTick: startTick + durationTicks,
            durationTicks,
            direction: type === "pull" ? -horizontalSign : horizontalSign,
            distance: Number(physics.distance || 0),
            height: Number(physics.height || 0),
          });
        }
      }
      const offset = resolveTargetPhysicsOffset(tick, records);
      const statuses = records
        .filter((record) => ["stun", "hover"].includes(record.type) && tick >= record.startTick && tick <= record.endTick)
        .map((record) => record.type === "hover" ? "滞空" : "眩晕");
      const result = { position: { x: targetBase.x + offset.x, y: targetBase.y + offset.y }, statuses };
      targetStateCache.set(cacheKey, result);
      return result;
    };
    const previews: DamagePreview[] = [];
    for (const event of segment.tracks.find((track) => track.kind === "damage")?.events || []) {
      (event.params.damageEffects || []).forEach((effect: any, effectIndex: number) => {
        const window = damagePreviewWindow(event, effect, playheadTick, project.tickRate, actionEndTick)
          ?? (sceneEditMode && event.id === selectedEventId ? {
            trigger: event.startTick,
            start: event.startTick + Math.max(0, Number(effect.triggerDelayTicks || 0)),
            hitTick: event.startTick + Math.max(0, Number(effect.triggerDelayTicks || 0)) + Math.min(Math.max(0, Number(effect.activationTick || 0)), Math.max(0, Number(effect.detectionDurationTicks || 0))),
            active: true,
          } : null);
        if (window === null) return;
        const releaseTick = window.trigger;
        const activeStart = window.start;
        const detectionType = effect.detectionType || "rangeOverlap";
        const anchorMode = effect.anchor || "world";
        const fixedRepeatedAnchor = anchorMode === "world" && event.triggerMode === "repeated" && event.params.repeatedAnchorMode === "fixed";
        const followsAnchor = anchorMode !== "world" && detectionType !== "physicalEntity";
        const activeCasterState = evaluateCaster(releaseTick);
        const anchorTick = playheadTick <= activeStart
          ? releaseTick
          : damageAnchorTick(effect, detectionType, activeStart, playheadTick);
        const anchorCasterState = evaluateCaster(anchorTick);
        const anchorState = fixedRepeatedAnchor
          ? evaluateCaster(event.startTick)
          : anchorMode === "target"
            ? { position: evaluateTarget(anchorTick).position, facingSign: anchorCasterState.facingSign }
          : followsAnchor
            ? anchorCasterState
            : activeCasterState;
        const anchor = anchorState.position;
        const effectFacingSign = anchorState.facingSign;
        const motionOrigin = detectionType === "raycast"
          ? { x: anchor.x + Number(effect.rayOriginX || 0) * effectFacingSign, y: anchor.y + Number(effect.rayOriginY || 0) }
          : { x: anchor.x + Number(effect.centerX || 0) * effectFacingSign, y: anchor.y + Number(effect.centerY || 0) };
        const retargetOrigin = detectionType === "raycast"
          ? { x: casterWorld.x + Number(effect.rayOriginX || 0) * casterState.facingSign, y: casterWorld.y + Number(effect.rayOriginY || 0) }
          : { x: casterWorld.x + Number(effect.centerX || 0) * casterState.facingSign, y: casterWorld.y + Number(effect.centerY || 0) };
        const elapsedTicks = playheadTick - activeStart;
        const motion = detectionType === "physicalEntity"
          ? evaluatePhysicalEntityMotion(effect, elapsedTicks, project.tickRate, effectFacingSign, motionOrigin, retargetOrigin)
          : evaluateMotion(effect.motion, elapsedTicks, project.tickRate, effectFacingSign, motionOrigin, retargetOrigin);
        const baseRotation = damagePreviewRotation(effect, detectionType, effectFacingSign);
        const growth = resolveBoxGrowth(effect, elapsedTicks, project.tickRate, effectFacingSign, baseRotation);
        const center = { x: motionOrigin.x + motion.x + growth.offset.x, y: motionOrigin.y + motion.y + growth.offset.y };
        const detectionDuration = Math.max(0, Number(effect.detectionDurationTicks || 0));
        const exists = playheadTick >= activeStart && playheadTick <= activeStart + detectionDuration;
        const physicalRotation = baseRotation
          + (detectionType === "physicalEntity" ? Number(effect.physicalInitialAngularVelocity || 0) * effectFacingSign * Math.max(0, elapsedTicks) / Math.max(1, project.tickRate) : 0);
        const base = { event, effect, effectIndex, detectionType, center, motionOrigin, rotation: physicalRotation, facingSign: effectFacingSign, boxWidth: growth.width, boxHeight: growth.height, activeStart, hitTick: window.hitTick, active: window.active, exists };
        const hitCasterState = evaluateCaster(window.hitTick);
        const hitCaster = hitCasterState.position;
        const hitAnchorTick = window.hitTick <= activeStart
          ? releaseTick
          : damageAnchorTick(effect, detectionType, activeStart, window.hitTick);
        const hitAnchorCasterState = evaluateCaster(hitAnchorTick);
        const hitAnchorState = fixedRepeatedAnchor
          ? evaluateCaster(event.startTick)
          : anchorMode === "target"
            ? { position: evaluateTarget(hitAnchorTick).position, facingSign: hitAnchorCasterState.facingSign }
          : followsAnchor
            ? hitAnchorCasterState
            : activeCasterState;
        const hitAnchor = hitAnchorState.position;
        const hitFacingSign = hitAnchorState.facingSign;
        const hitOrigin = detectionType === "raycast"
          ? { x: hitAnchor.x + Number(effect.rayOriginX || 0) * hitFacingSign, y: hitAnchor.y + Number(effect.rayOriginY || 0) }
          : { x: hitAnchor.x + Number(effect.centerX || 0) * hitFacingSign, y: hitAnchor.y + Number(effect.centerY || 0) };
        const hitRetargetOrigin = detectionType === "raycast"
          ? { x: hitCaster.x + Number(effect.rayOriginX || 0) * hitCasterState.facingSign, y: hitCaster.y + Number(effect.rayOriginY || 0) }
          : { x: hitCaster.x + Number(effect.centerX || 0) * hitCasterState.facingSign, y: hitCaster.y + Number(effect.centerY || 0) };
        const hitElapsedTicks = window.hitTick - activeStart;
        const hitMotion = detectionType === "physicalEntity"
          ? evaluatePhysicalEntityMotion(effect, hitElapsedTicks, project.tickRate, hitFacingSign, hitOrigin, hitRetargetOrigin)
          : evaluateMotion(effect.motion, hitElapsedTicks, project.tickRate, hitFacingSign, hitOrigin, hitRetargetOrigin);
        const hitBaseRotation = damagePreviewRotation(effect, detectionType, hitFacingSign);
        const hitGrowth = resolveBoxGrowth(effect, hitElapsedTicks, project.tickRate, hitFacingSign, hitBaseRotation);
        const hitPreview = {
          ...base,
          center: { x: hitOrigin.x + hitMotion.x + hitGrowth.offset.x, y: hitOrigin.y + hitMotion.y + hitGrowth.offset.y },
          motionOrigin: hitOrigin,
          rotation: hitBaseRotation
            + (detectionType === "physicalEntity" ? Number(effect.physicalInitialAngularVelocity || 0) * hitFacingSign * Math.max(0, hitElapsedTicks) / Math.max(1, project.tickRate) : 0),
          facingSign: hitFacingSign,
          boxWidth: hitGrowth.width,
          boxHeight: hitGrowth.height,
        };
        previews.push({ ...base, hit: showTarget && playheadTick >= window.hitTick && pointHitsDamage(targetCenterBase, hitPreview) });
      });
    }
    const targetState = evaluateTarget(playheadTick);
    const targetWorld = targetState.position;
    const targetStatuses = targetState.statuses;
    const targetScreen = { x: baseOrigin.x + targetWorld.x * unitScale, y: baseOrigin.y - targetWorld.y * unitScale };

    const drawCueImage = (effect: any, startTick: number, worldAnchor?: Point, durationOverride?: number, edit?: { event: TimelineEvent; location: VfxLocation }, parentRotation = 0) => {
      const frameAssetIds = vfxFrameAssetIds(effect);
      const loop = durationOverride !== undefined || Boolean(effect.loop);
      const destroyMode = loop ? effect.destroyMode || "timed" : "natural";
      if (loop && destroyMode === "onActionEnd" && startTick >= actionEndTick) return;
      const naturalDuration = vfxNaturalDurationTicks(effect, project.tickRate);
      const visibleDuration = durationOverride !== undefined
        ? Math.max(1, durationOverride)
        : loop && destroyMode === "timed"
        ? Math.max(1, Number(effect.durationTicks || 1))
        : loop && destroyMode === "onActionEnd" ? Math.max(1, actionEndTick - startTick) : naturalDuration;
      if (playheadTick < startTick || playheadTick > startTick + visibleDuration) return;
      const elapsed = Math.max(0, playheadTick - startTick);
      const followTicks = Math.max(0, Number(effect.followDurationTicks || 0));
      const anchorTick = effect.useFollowDuration ? Math.min(playheadTick, startTick + followTicks) : playheadTick;
      const anchor = effect.anchor === "target"
        ? evaluateTarget(anchorTick).position
        : effect.anchor === "world"
          ? worldAnchor || evaluateCaster(startTick).position
          : evaluateCaster(anchorTick).position;
      const localOffset = rotate({ x: Number(effect.x || 0) * facingSign, y: Number(effect.y || 0) }, parentRotation);
      const motionOrigin = { x: anchor.x + localOffset.x, y: anchor.y + localOffset.y };
      const currentCaster = evaluateCaster(playheadTick).position;
      const retargetPosition = { x: currentCaster.x + Number(effect.x || 0) * facingSign, y: currentCaster.y + Number(effect.y || 0) };
      const motion = evaluateMotion(effect.motion, playheadTick - startTick, project.tickRate, facingSign, motionOrigin, retargetPosition);
      const position = { x: motionOrigin.x + motion.x, y: motionOrigin.y + motion.y };
      const screen = { x: baseOrigin.x + position.x * unitScale, y: baseOrigin.y - position.y * unitScale };
      const frameDuration = project.tickRate / Math.max(1, Number(effect.fps || 12));
      const rawFrameIndex = Math.floor(elapsed / Math.max(0.0001, frameDuration));
      const frameCount = Math.max(1, frameAssetIds.length);
      const frameIndex = loop ? rawFrameIndex % frameCount : Math.min(frameCount - 1, rawFrameIndex);
      const image = getImage(frameAssetIds[frameIndex]);
      const pivotX = Math.min(1, Math.max(0, Number.isFinite(Number(effect.pivotX)) ? Number(effect.pivotX) : 0.5));
      const pivotY = Math.min(1, Math.max(0, Number.isFinite(Number(effect.pivotY)) ? Number(effect.pivotY) : 0.5));
      context.save();
      context.translate(screen.x, screen.y);
      const visualRotation = Number(effect.rotation || 0) * facingSign + parentRotation;
      context.rotate(-visualRotation * Math.PI / 180);
      const scale = Math.max(0.01, Number(effect.scale || 1));
      const pixelsPerUnit = Math.max(1, Number(effect.pixelsPerUnit || project.pixelsPerUnit));
      let visualWidth = 36 * scale * view.zoom;
      let visualHeight = 36 * scale * view.zoom;
      if (image && image.complete && image.naturalWidth) {
        const fit = unitScale / pixelsPerUnit;
        visualWidth = image.naturalWidth * fit * scale;
        visualHeight = image.naturalHeight * fit * scale;
        context.scale(fit * scale * facingSign, fit * scale);
        context.drawImage(image, -image.naturalWidth * pivotX, -image.naturalHeight * (1 - pivotY));
      } else {
        context.strokeStyle = "#c17a16";
        context.fillStyle = "rgba(193,122,22,.2)";
        context.beginPath(); context.arc(0, 0, 18 * scale * view.zoom, 0, Math.PI * 2); context.fill(); context.stroke();
        context.fillStyle = "#8a560d"; context.font = "11px system-ui"; context.fillText("VFX", -10, 4);
      }
      context.restore();
      if (edit && isEditTarget(edit.event, vfxLocationKey(edit.location))) {
        const rotation = visualRotation;
        context.save();
        context.translate(screen.x, screen.y);
        context.rotate(-rotation * Math.PI / 180);
        context.scale(facingSign, 1);
        context.strokeStyle = "#149c91";
        context.lineWidth = 1.5;
        context.setLineDash([5, 3]);
        context.strokeRect(-visualWidth * pivotX, -visualHeight * (1 - pivotY), visualWidth, visualHeight);
        context.setLineDash([]);
        context.restore();
        const scaleOffset = rotate({ x: visualWidth * (1 - pivotX) * facingSign, y: visualHeight * pivotY }, -rotation);
        const rotationOffset = rotate({ x: visualWidth * (0.5 - pivotX) * facingSign, y: -visualHeight * (1 - pivotY) - 28 }, -rotation);
        drawEditHandle(screen, edit.event, { kind: "vfxMove", location: edit.location, centerX: screen.x, centerY: screen.y }, "移", "#149c91", 7);
        drawEditHandle({ x: screen.x + scaleOffset.x, y: screen.y + scaleOffset.y }, edit.event, { kind: "vfxScale", location: edit.location, centerX: screen.x, centerY: screen.y }, "缩", "#149c91", 6);
        context.save(); context.strokeStyle = "#7d57a8"; context.beginPath(); context.moveTo(screen.x, screen.y); context.lineTo(screen.x + rotationOffset.x, screen.y + rotationOffset.y); context.stroke(); context.restore();
        drawEditHandle({ x: screen.x + rotationOffset.x, y: screen.y + rotationOffset.y }, edit.event, { kind: "vfxRotate", location: edit.location, centerX: screen.x, centerY: screen.y }, "转", "#7d57a8", 6);
        drawMotionPath(edit.event, effect.motion, motionOrigin, { type: "vfx", location: edit.location }, vfxLocationKey(edit.location), "#149c91");
      }
    };

    const drawVfxLayer = (renderLayer: "front" | "back") => {
      let hasEffects = false;
      const draw = (effect: any, callback: () => void) => {
        const resolvedLayer = effect.renderLayer === "back" ? "back" : "front";
        if (resolvedLayer !== renderLayer) return;
        hasEffects = true;
        callback();
      };
      for (const event of segment.tracks.find((track) => track.kind === "vfx")?.events || []) {
        (event.params.vfxEffects || []).forEach((effect: any, effectIndex: number) => {
          const delay = Math.max(0, Number(effect.triggerDelayTicks || 0));
          const triggerTick = eventTriggerTick(event, playheadTick - delay, actionEndTick);
          if (triggerTick !== null) draw(effect, () => drawCueImage(effect, triggerTick + delay, undefined, undefined, { event, location: { scope: "top", effectIndex } }));
        });
      }
      for (const preview of previews) {
        const detectionDuration = Math.max(0, Number(preview.effect.detectionDurationTicks || 0));
        (preview.effect.companionVfxEffects || []).forEach((effect: any, effectIndex: number) => draw(effect, () => drawCueImage(effect, preview.activeStart, preview.center, Math.max(1, detectionDuration), { event: preview.event, location: { scope: "companion", damageIndex: preview.effectIndex, effectIndex } }, preview.detectionType === "physicalEntity" ? preview.rotation : 0)));
        if (preview.hit) (preview.effect.onHitVfxEffects || []).forEach((effect: any, effectIndex: number) => draw(effect, () => drawCueImage(effect, preview.hitTick + Number(effect.triggerDelayTicks || 0), targetCenterBase, undefined, { event: preview.event, location: { scope: "hit", damageIndex: preview.effectIndex, effectIndex } })));
      }
      return hasEffects;
    };

    if (drawVfxLayer("back")) drawFrame();
    drawVfxLayer("front");

    damageGeometry.current = [];
    if (showBoxes) {
      for (const preview of previews.filter((item) => item.active || item.detectionType === "physicalEntity" && item.exists)) {
        const { event, effect, effectIndex, center, rotation: rotationDegrees, facingSign: damageFacingSign, detectionType } = preview;
        const centerScreen = { x: baseOrigin.x + center.x * unitScale, y: baseOrigin.y - center.y * unitScale };
        const selected = event.id === selectedEventId;
        context.save();
        context.translate(centerScreen.x, centerScreen.y);
        context.rotate(-rotationDegrees * Math.PI / 180);
        context.fillStyle = preview.active ? preview.hit ? "rgba(228,87,61,.28)" : "rgba(228,87,61,.14)" : "rgba(70,92,104,.12)";
        context.strokeStyle = preview.active ? preview.hit ? "#c73524" : "#e4573d" : "#596f7a";
        context.lineWidth = selected ? 3 : 2;
        let bounds = { left: centerScreen.x - 24, top: centerScreen.y - 24, width: 48, height: 48 };
        if (detectionType === "raycast") {
          const distance = Math.max(0.01, Number(effect.rayMaxDistance || 0.01)) * unitScale;
          const radius = Math.max(1, Number(effect.rayRadius || 0) * unitScale);
          context.beginPath(); context.moveTo(0, 0); context.lineTo(distance, 0); context.stroke();
          if (radius > 1) context.strokeRect(0, -radius, distance, radius * 2);
          bounds = { left: centerScreen.x, top: centerScreen.y - radius, width: distance, height: radius * 2 };
        } else if (effect.shape === "circle" || effect.shape === "sector") {
          const radius = Math.max(0.05, Number(effect.radius || 1)) * unitScale;
          const angle = effect.shape === "sector" ? Math.max(1, Number(effect.sectorAngle || 180)) * Math.PI / 180 : Math.PI * 2;
          context.beginPath();
          if (effect.shape === "sector") context.moveTo(0, 0);
          context.arc(0, 0, radius, -angle / 2, angle / 2);
          if (effect.shape === "sector") context.closePath();
          context.fill(); context.stroke();
          bounds = { left: centerScreen.x - radius, top: centerScreen.y - radius, width: radius * 2, height: radius * 2 };
        } else {
          const boxWidth = preview.boxWidth * unitScale;
          const boxHeight = preview.boxHeight * unitScale;
          context.fillRect(-boxWidth / 2, -boxHeight / 2, boxWidth, boxHeight);
          context.strokeRect(-boxWidth / 2, -boxHeight / 2, boxWidth, boxHeight);
          bounds = { left: centerScreen.x - boxWidth / 2, top: centerScreen.y - boxHeight / 2, width: boxWidth, height: boxHeight };
        }
        context.restore();
        damageGeometry.current.push({ event, effectIndex, ...bounds, centerX: centerScreen.x, centerY: centerScreen.y, rotation: rotationDegrees, facingSign: damageFacingSign });
        context.fillStyle = preview.hit ? "#b52f20" : "#e4573d";
        context.font = "12px system-ui";
        context.fillText(preview.hit ? `${event.name} · 命中` : event.name, bounds.left, Math.max(14, bounds.top - 6));
        if (isEditTarget(event, `damage:${effectIndex}`)) {
          drawEditHandle(centerScreen, event, { kind: "damageMove", effectIndex, centerX: centerScreen.x, centerY: centerScreen.y, facingSign: damageFacingSign }, "移", "#d83d32", 7);
          if (detectionType === "raycast") {
            const distance = Math.max(0.01, Number(effect.rayMaxDistance || 0.01)) * unitScale;
            const radius = Math.max(0.2, Number(effect.rayRadius || 0.2)) * unitScale;
            const endOffset = rotate({ x: distance, y: 0 }, -rotationDegrees);
            const radiusOffset = rotate({ x: distance * 0.5, y: -radius }, -rotationDegrees);
            drawEditHandle({ x: centerScreen.x + endOffset.x, y: centerScreen.y + endOffset.y }, event, { kind: "damageRayEnd", effectIndex, centerX: centerScreen.x, centerY: centerScreen.y, facingSign: damageFacingSign }, "长", "#d83d32", 6);
            drawEditHandle({ x: centerScreen.x + radiusOffset.x, y: centerScreen.y + radiusOffset.y }, event, { kind: "damageRayRadius", effectIndex, centerX: centerScreen.x, centerY: centerScreen.y, facingSign: damageFacingSign }, "粗", "#d83d32", 6);
          } else {
            const resizeOffset = effect.shape === "circle" || effect.shape === "sector"
              ? rotate({ x: Math.max(0.05, Number(effect.radius || 1)) * unitScale, y: 0 }, -rotationDegrees)
              : rotate({ x: preview.boxWidth * unitScale * 0.5, y: preview.boxHeight * unitScale * 0.5 }, -rotationDegrees);
            drawEditHandle({ x: centerScreen.x + resizeOffset.x, y: centerScreen.y + resizeOffset.y }, event, { kind: "damageResize", effectIndex, centerX: centerScreen.x, centerY: centerScreen.y, facingSign: damageFacingSign }, "缩", "#d83d32", 6);
          }
          if (detectionType === "raycast" || detectionType === "physicalEntity" || effect.shape === "box" || effect.shape === "sector") {
            const rotationOffset = rotate({ x: 0, y: -Math.max(bounds.width, bounds.height) * 0.5 - 28 }, -rotationDegrees);
            context.save(); context.strokeStyle = "#8b4bad"; context.beginPath(); context.moveTo(centerScreen.x, centerScreen.y); context.lineTo(centerScreen.x + rotationOffset.x, centerScreen.y + rotationOffset.y); context.stroke(); context.restore();
            drawEditHandle({ x: centerScreen.x + rotationOffset.x, y: centerScreen.y + rotationOffset.y }, event, { kind: "damageRotate", effectIndex, centerX: centerScreen.x, centerY: centerScreen.y, facingSign: damageFacingSign }, "转", "#8b4bad", 6);
          }
          drawMotionPath(event, effect.motion, preview.motionOrigin, { type: "damage", effectIndex }, `damage:${effectIndex}`, "#d83d32");
        }
      }
    }

    const drawAudioCue = (effect: any, startTick: number, worldAnchor?: Point) => {
      if (effect.loop && effect.destroyMode === "onActionEnd" && startTick >= actionEndTick) return;
      const elapsed = playheadTick - startTick;
      if (elapsed < 0 || elapsed > (effect.loop ? Math.max(30, Number(effect.durationTicks || 180)) : 30)) return;
      const anchor = effect.anchor === "target"
        ? targetWorld
        : effect.anchor === "world"
          ? worldAnchor || evaluateCaster(startTick).position
          : casterWorld;
      const screen = { x: baseOrigin.x + (anchor.x + Number(effect.x || 0) * facingSign) * unitScale, y: baseOrigin.y - (anchor.y + Number(effect.y || 0)) * unitScale };
      const pulse = (10 + (elapsed % 30) * 0.45) * view.zoom;
      context.save();
      context.strokeStyle = "#43845a";
      context.lineWidth = 2;
      context.beginPath(); context.arc(screen.x, screen.y, pulse, -0.8, 0.8); context.stroke();
      context.beginPath(); context.arc(screen.x, screen.y, pulse + 8, -0.8, 0.8); context.stroke();
      context.fillStyle = "#27643d"; context.font = "11px system-ui"; context.fillText("SFX", screen.x - 11, screen.y + 4);
      context.restore();
    };
    for (const event of segment.tracks.find((track) => track.kind === "sfx")?.events || []) {
      for (const effect of event.params.sfxEffects || []) {
        const delay = Math.max(0, Number(effect.triggerDelayTicks || 0));
        const triggerTick = eventTriggerTick(event, playheadTick - delay, actionEndTick);
        if (triggerTick !== null) drawAudioCue(effect, triggerTick + delay);
      }
    }
    for (const preview of previews.filter((item) => item.hit)) {
      for (const effect of preview.effect.onHitSfxEffects || []) drawAudioCue(effect, preview.hitTick + Number(effect.triggerDelayTicks || 0), targetCenterBase);
    }

    const cameraEvent = (segment.tracks.find((track) => track.kind === "camera")?.events || []).filter((event) => {
      const end = event.params.durationMode === "untilActionEnd" ? actionEndTick : event.startTick + Math.max(0, event.durationTicks);
      return playheadTick >= event.startTick && playheadTick <= end;
    }).sort((left, right) => left.startTick - right.startTick).at(-1);
    if (cameraEvent) {
      const params = cameraEvent.params;
      const end = params.durationMode === "untilActionEnd" ? actionEndTick : cameraEvent.startTick + Math.max(1, cameraEvent.durationTicks);
      const elapsed = playheadTick - cameraEvent.startTick;
      const durationTicks = Math.max(1, end - cameraEvent.startTick);
      const progress = clamp(elapsed / durationTicks, 0, 1);
      const pathProgress = evaluateProgressCurve(params.pathProgressCurve, progress);
      const blendIn = Math.max(0, Number(params.blendInTicks || 0));
      const blendOut = Math.max(0, Number(params.blendOutTicks || 0));
      const blendWeight = Math.min(
        blendIn > 0 ? clamp(elapsed / blendIn, 0, 1) : 1,
        blendOut > 0 ? clamp((end - playheadTick) / blendOut, 0, 1) : 1,
      );
      const offset = params.positionMode === "bezier"
        ? cubicBezier(
          { x: Number(params.pathStartX || 0) * facingSign, y: Number(params.pathStartY || 0) },
          { x: Number(params.controlAX || 0) * facingSign, y: Number(params.controlAY || 0) },
          { x: Number(params.controlBX || 0) * facingSign, y: Number(params.controlBY || 0) },
          { x: Number(params.endX || 0) * facingSign, y: Number(params.endY || 0) },
          pathProgress,
        )
        : { x: Number(params.offsetX || 0) * facingSign, y: Number(params.offsetY || 0) };
      offset.x *= blendWeight;
      offset.y *= blendWeight;
      const zoom = 1 + (Math.max(0.2, Number(params.zoom || 1)) - 1) * blendWeight;
      const cameraCenter = { x: baseOrigin.x + offset.x * unitScale, y: baseOrigin.y - offset.y * unitScale };
      context.save();
      context.strokeStyle = "#4c6992";
      context.lineWidth = 2;
      context.setLineDash([7, 4]);
      context.strokeRect(cameraCenter.x - 150 * view.zoom / zoom, cameraCenter.y - 85 * view.zoom / zoom, 300 * view.zoom / zoom, 170 * view.zoom / zoom);
      context.setLineDash([]);
      context.fillStyle = "#4c6992"; context.font = "11px system-ui"; context.fillText("镜头预览", cameraCenter.x - 28, cameraCenter.y - 92 * view.zoom / zoom);
      const lookAt = worldToScreen({ x: casterWorld.x, y: casterWorld.y + 0.9 });
      context.setLineDash([4, 4]);
      context.beginPath(); context.moveTo(cameraCenter.x, cameraCenter.y); context.lineTo(lookAt.x, lookAt.y); context.stroke();
      context.setLineDash([]);
      context.beginPath(); context.arc(lookAt.x, lookAt.y, 5, 0, Math.PI * 2); context.fill();
      context.fillText("注视角色", lookAt.x + 8, lookAt.y - 8);
      context.restore();
      if (isEditTarget(cameraEvent, "camera")) {
        if (params.positionMode === "bezier") {
          const start = { x: Number(params.pathStartX || 0) * facingSign, y: Number(params.pathStartY || 0) };
          const controlA = { x: Number(params.controlAX || 0) * facingSign, y: Number(params.controlAY || 0) };
          const controlB = { x: Number(params.controlBX || 0) * facingSign, y: Number(params.controlBY || 0) };
          const pathEnd = { x: Number(params.endX || 0) * facingSign, y: Number(params.endY || 0) };
          const startScreen = worldToScreen(start);
          const controlAScreen = worldToScreen(controlA);
          const controlBScreen = worldToScreen(controlB);
          const endScreen = worldToScreen(pathEnd);
          context.save();
          context.strokeStyle = "#4c6992";
          context.lineWidth = 2;
          context.beginPath();
          for (let index = 0; index <= 36; index += 1) {
            const sample = worldToScreen(cubicBezier(start, controlA, controlB, pathEnd, index / 36));
            if (index === 0) context.moveTo(sample.x, sample.y); else context.lineTo(sample.x, sample.y);
          }
          context.stroke();
          context.setLineDash([4, 4]);
          context.beginPath(); context.moveTo(startScreen.x, startScreen.y); context.lineTo(controlAScreen.x, controlAScreen.y); context.stroke();
          context.beginPath(); context.moveTo(controlBScreen.x, controlBScreen.y); context.lineTo(endScreen.x, endScreen.y); context.stroke();
          context.restore();
          drawEditHandle(startScreen, cameraEvent, { kind: "cameraPoint", fieldX: "pathStartX", fieldY: "pathStartY" }, "起", "#4c6992", 7);
          drawEditHandle(controlAScreen, cameraEvent, { kind: "cameraPoint", fieldX: "controlAX", fieldY: "controlAY" }, "A", "#d89a1d", 6);
          drawEditHandle(controlBScreen, cameraEvent, { kind: "cameraPoint", fieldX: "controlBX", fieldY: "controlBY" }, "B", "#e26d2f", 6);
          drawEditHandle(endScreen, cameraEvent, { kind: "cameraPoint", fieldX: "endX", fieldY: "endY" }, "终", "#c93f35", 7);
        } else {
          const holdScreen = worldToScreen({ x: Number(params.offsetX || 0) * facingSign, y: Number(params.offsetY || 0) });
          drawEditHandle(holdScreen, cameraEvent, { kind: "cameraPoint", fieldX: "offsetX", fieldY: "offsetY" }, "镜头", "#4c6992", 8);
        }
      }
    }

    if (showTarget) {
      const hit = previews.some((preview) => preview.hit);
      const targetScale = view.zoom;
      context.save();
      context.translate(targetScreen.x, targetScreen.y);
      context.strokeStyle = hit ? "#c73524" : "#426a8a";
      context.fillStyle = hit ? "rgba(228,87,61,.28)" : "rgba(66,106,138,.18)";
      context.lineWidth = 2;
      context.beginPath(); context.ellipse(0, 0, 24 * targetScale, 7 * targetScale, 0, 0, Math.PI * 2); context.fill(); context.stroke();
      context.beginPath(); context.arc(0, -66 * targetScale, 12 * targetScale, 0, Math.PI * 2); context.fill(); context.stroke();
      context.beginPath(); context.roundRect(-18 * targetScale, -53 * targetScale, 36 * targetScale, 48 * targetScale, 9 * targetScale); context.fill(); context.stroke();
      context.beginPath(); context.moveTo(-10 * targetScale, -5 * targetScale); context.lineTo(-14 * targetScale, 0); context.moveTo(10 * targetScale, -5 * targetScale); context.lineTo(14 * targetScale, 0); context.stroke();
      context.fillStyle = hit ? "#b52f20" : "#315b7d";
      context.font = "12px system-ui";
      context.fillText(hit ? "目标 · 命中" : "目标", -24 * targetScale, -84 * targetScale);
      if (targetStatuses.length) context.fillText(targetStatuses.join(" / "), -24 * targetScale, -100 * targetScale);
      context.restore();
      targetGeometry.current = { x: targetScreen.x, y: targetScreen.y - 38 * targetScale, radius: Math.max(16, 34 * targetScale) };
    }

    if (casterStatuses.length) {
      context.fillStyle = "#2d7f9d";
      context.font = "12px system-ui";
      context.fillText(casterStatuses.join(" / "), casterScreen.x - 18, casterScreen.y - 105);
    }
    const hitStop = previews.find((preview) => preview.hit && Number(preview.effect.hitStop?.durationTicks || 0) > 0 && playheadTick >= preview.hitTick && playheadTick <= preview.hitTick + Number(preview.effect.hitStop.durationTicks));
    if (hitStop) {
      context.fillStyle = "rgba(18,22,24,.58)";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#fff";
      context.font = "600 14px system-ui";
      context.fillText(`命中停顿 · ${hitStop.effect.hitStop.durationTicks} Tick`, 14, 44);
    }

    context.fillStyle = background === "dark" ? "#f5f4ef" : "#202426";
    context.font = "12px system-ui";
    context.fillText(`Tick ${Math.round(playheadTick)} · ${(playheadTick / project.tickRate).toFixed(3)}s`, 14, 22);
    context.fillText(`原点 (0, 0) · ${segment.pixelsPerUnit} PPU · Pivot (${segment.pivotX}, ${segment.pivotY})`, 14, height - 14);
  };
  drawRef.current = draw;

  useEffect(() => { drawRef.current(); });
  useEffect(() => { const observer = new ResizeObserver(() => drawRef.current()); if (wrapRef.current) observer.observe(wrapRef.current); return () => observer.disconnect(); }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const center = { x: rect.width * 0.5, y: rect.height * 0.78 };
      setView((current) => {
        const nextZoom = clamp(current.zoom * Math.exp(-event.deltaY * 0.0015), 0.25, 4);
        if (Math.abs(nextZoom - current.zoom) < 0.0001) return current;
        const worldX = (cursor.x - center.x - current.offsetX) / (UNIT_SCALE * current.zoom);
        const worldY = (center.y + current.offsetY - cursor.y) / (UNIT_SCALE * current.zoom);
        return {
          zoom: nextZoom,
          offsetX: cursor.x - center.x - worldX * UNIT_SCALE * nextZoom,
          offsetY: cursor.y - center.y + worldY * UNIT_SCALE * nextZoom,
        };
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const point = (event: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const cursor = point(event);
    if (event.button === 1) {
      dragRef.current = { mode: "pan", x: cursor.x, y: cursor.y };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const editHandle = sceneEditMode ? [...editHandles.current].reverse().find((item) => Math.hypot(cursor.x - item.x, cursor.y - item.y) <= item.radius) : null;
    if (editHandle) {
      if (editHandle.event) onSelectEvent(editHandle.event.id);
      dragRef.current = editHandle.action.kind === "bodyColliderMove"
        ? { mode: "bodyColliderMove", x: cursor.x, y: cursor.y, offsetX: project.unityCharacter.colliderOffsetX, offsetY: project.unityCharacter.colliderOffsetY }
        : editHandle.action.kind === "hurtboxMove"
        ? { mode: "hurtboxMove", x: cursor.x, y: cursor.y, offsetX: project.unityCharacter.hurtboxOffsetX, offsetY: project.unityCharacter.hurtboxOffsetY }
        : { mode: "editHandle", handle: editHandle, x: cursor.x, y: cursor.y };
    } else if (showTarget && Math.hypot(cursor.x - targetGeometry.current.x, cursor.y - targetGeometry.current.y) <= targetGeometry.current.radius) {
      dragRef.current = { mode: "target", x: cursor.x, y: cursor.y };
    } else {
      const body = bodyColliderGeometry.current;
      const hurtbox = hurtboxGeometry.current;
      if (sceneEditMode && editTarget === "hurtbox" && !handlesLocked && hurtbox.visible
        && cursor.x >= hurtbox.left && cursor.x <= hurtbox.left + hurtbox.width && cursor.y >= hurtbox.top && cursor.y <= hurtbox.top + hurtbox.height) {
        dragRef.current = { mode: "hurtboxMove", x: cursor.x, y: cursor.y, offsetX: project.unityCharacter.hurtboxOffsetX, offsetY: project.unityCharacter.hurtboxOffsetY };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
      if (sceneEditMode && editTarget === "bodyCollider" && !handlesLocked && body.visible
        && cursor.x >= body.left && cursor.x <= body.left + body.width && cursor.y >= body.top && cursor.y <= body.top + body.height) {
        dragRef.current = { mode: "bodyColliderMove", x: cursor.x, y: cursor.y, offsetX: project.unityCharacter.colliderOffsetX, offsetY: project.unityCharacter.colliderOffsetY };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
      const hit = [...damageGeometry.current].reverse().find((item) => cursor.x >= item.left && cursor.x <= item.left + item.width && cursor.y >= item.top && cursor.y <= item.top + item.height);
      if (hit) {
        onSelectEvent(hit.event.id);
        if (sceneEditMode && !handlesLocked && hit.event.id === selectedEventId && (!editTarget || editTarget === `damage:${hit.effectIndex}`)) dragRef.current = { mode: "damageMove", geometry: hit, x: cursor.x, y: cursor.y };
      } else dragRef.current = { mode: "pan", x: cursor.x, y: cursor.y };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const cursor = point(event);
    const dx = cursor.x - dragRef.current.x;
    const dy = cursor.y - dragRef.current.y;
    if (dragRef.current.mode === "pan") {
      setView((current) => ({ ...current, offsetX: current.offsetX + dx, offsetY: current.offsetY + dy }));
      dragRef.current = { mode: "pan", x: cursor.x, y: cursor.y };
      return;
    }
    if (dragRef.current.mode === "target") {
      onTargetChange({ x: target.x + dx / unitScale, y: target.y - dy / unitScale });
      dragRef.current = { mode: "target", x: cursor.x, y: cursor.y };
      return;
    }
    if (dragRef.current.mode === "bodyColliderMove") {
      const offsetX = dragRef.current.offsetX + dx / unitScale;
      const offsetY = dragRef.current.offsetY - dy / unitScale;
      onUpdateUnityCharacter({
        colliderOffsetX: roundColliderValue(offsetX),
        colliderOffsetY: roundColliderValue(offsetY),
      });
      dragRef.current = { mode: "bodyColliderMove", x: cursor.x, y: cursor.y, offsetX, offsetY };
      return;
    }
    if (dragRef.current.mode === "hurtboxMove") {
      const offsetX = dragRef.current.offsetX + dx / unitScale;
      const offsetY = dragRef.current.offsetY - dy / unitScale;
      onUpdateUnityCharacter({
        hurtboxOffsetX: roundColliderValue(offsetX),
        hurtboxOffsetY: roundColliderValue(offsetY),
      });
      dragRef.current = { mode: "hurtboxMove", x: cursor.x, y: cursor.y, offsetX, offsetY };
      return;
    }
    if (dragRef.current.mode === "editHandle") {
      const { handle } = dragRef.current;
      const action = handle.action;
      const worldDx = dx / unitScale;
      const worldDy = -dy / unitScale;
      if (action.kind.startsWith("bodyCollider")) {
        if (action.kind === "bodyColliderMove") {
          onUpdateUnityCharacter({
            colliderOffsetX: roundColliderValue(project.unityCharacter.colliderOffsetX + worldDx),
            colliderOffsetY: roundColliderValue(project.unityCharacter.colliderOffsetY + worldDy),
          });
        } else {
          const patch: Partial<CharacterProject["unityCharacter"]> = {};
          if (action.kind === "bodyColliderWidth" || action.kind === "bodyColliderResize") {
            patch.colliderWidth = roundColliderValue(Math.max(0.01, Math.abs(cursor.x - action.centerX) * 2 / unitScale));
          }
          if (action.kind === "bodyColliderHeight" || action.kind === "bodyColliderResize") {
            patch.colliderHeight = roundColliderValue(Math.max(0.01, Math.abs(cursor.y - action.centerY) * 2 / unitScale));
          }
          onUpdateUnityCharacter(patch);
        }
        dragRef.current = { ...dragRef.current, x: cursor.x, y: cursor.y };
        return;
      }
      if (action.kind.startsWith("hurtbox")) {
        const patch: Partial<CharacterProject["unityCharacter"]> = {};
        if (action.kind === "hurtboxWidth" || action.kind === "hurtboxResize") {
          patch.hurtboxWidth = roundColliderValue(Math.max(0.01, Math.abs(cursor.x - action.centerX) * 2 / unitScale));
        }
        if (action.kind === "hurtboxHeight" || action.kind === "hurtboxResize") {
          patch.hurtboxHeight = roundColliderValue(Math.max(0.01, Math.abs(cursor.y - action.centerY) * 2 / unitScale));
        }
        onUpdateUnityCharacter(patch);
        dragRef.current = { ...dragRef.current, x: cursor.x, y: cursor.y };
        return;
      }
      if (!handle.event) return;
      const params = structuredClone(handle.event.params);
      if ("effectIndex" in action && action.kind.startsWith("damage")) {
        const effect = params.damageEffects[action.effectIndex];
        if (!effect) return;
        const detectionType = effect.detectionType || "rangeOverlap";
        const damageFacingSign = action.facingSign;
        const visualRotation = damagePreviewRotation(effect, detectionType, damageFacingSign);
        if (action.kind === "damageMove") {
          if (detectionType === "raycast") {
            effect.rayOriginX = Number(effect.rayOriginX || 0) + worldDx * damageFacingSign;
            effect.rayOriginY = Number(effect.rayOriginY || 0) + worldDy;
          } else {
            effect.centerX = Number(effect.centerX || 0) + worldDx * damageFacingSign;
            effect.centerY = Number(effect.centerY || 0) + worldDy;
          }
        } else if (action.kind === "damageRotate") {
          const screenAngle = Math.atan2(cursor.y - action.centerY, cursor.x - action.centerX) * 180 / Math.PI;
          effect.rotation = damageConfiguredRotation(effect, detectionType, damageFacingSign, -(screenAngle + 90));
        } else if (action.kind === "damageRayEnd") {
          const local = rotate({ x: cursor.x - action.centerX, y: cursor.y - action.centerY }, visualRotation);
          effect.rayMaxDistance = Math.max(0.01, local.x / unitScale);
        } else if (action.kind === "damageRayRadius") {
          const local = rotate({ x: cursor.x - action.centerX, y: cursor.y - action.centerY }, visualRotation);
          effect.rayRadius = Math.max(0, Math.abs(local.y) / unitScale);
        } else {
          const local = rotate({ x: cursor.x - action.centerX, y: cursor.y - action.centerY }, visualRotation);
          if (effect.shape === "circle" || effect.shape === "sector") effect.radius = Math.max(0.05, Math.hypot(local.x, local.y) / unitScale);
          else {
            const triggerTick = eventTriggerTick(handle.event, playheadTick, actionEndTick) ?? handle.event.startTick;
            const growth = resolveBoxGrowth(effect, playheadTick - triggerTick, project.tickRate, damageFacingSign, visualRotation);
            const horizontalGrowth = effect.boxGrowthDirection === "left" || effect.boxGrowthDirection === "right" ? growth.extension : 0;
            const verticalGrowth = effect.boxGrowthDirection === "up" || effect.boxGrowthDirection === "down" ? growth.extension : 0;
            effect.boxWidth = Math.max(0.05, Math.abs(local.x) * 2 / unitScale - horizontalGrowth);
            effect.boxHeight = Math.max(0.05, Math.abs(local.y) * 2 / unitScale - verticalGrowth);
          }
        }
      } else if (action.kind === "vfxMove" || action.kind === "vfxScale" || action.kind === "vfxRotate") {
        const effect = resolveVfxEffect(params, action.location);
        if (!effect) return;
        if (action.kind === "vfxMove") {
          effect.x = Number(effect.x || 0) + worldDx * facingSign;
          effect.y = Number(effect.y || 0) + worldDy;
        } else if (action.kind === "vfxRotate") {
          const screenAngle = Math.atan2(cursor.y - action.centerY, cursor.x - action.centerX) * 180 / Math.PI;
          effect.rotation = -(screenAngle + 90) / facingSign;
        } else {
          const previousDistance = Math.max(1, Math.hypot(dragRef.current.x - action.centerX, dragRef.current.y - action.centerY));
          const currentDistance = Math.max(1, Math.hypot(cursor.x - action.centerX, cursor.y - action.centerY));
          effect.scale = Math.max(0.01, Number(effect.scale || 1) * currentDistance / previousDistance);
        }
      } else if (action.kind === "motionPoint") {
        const motion = action.owner.type === "damage"
          ? params.damageEffects?.[action.owner.effectIndex]?.motion
          : resolveVfxEffect(params, action.owner.location)?.motion;
        if (!motion) return;
        motion[action.fieldX] = Number(motion[action.fieldX] || 0) + worldDx * facingSign;
        motion[action.fieldY] = Number(motion[action.fieldY] || 0) + worldDy;
      } else if (action.kind === "cameraPoint") {
        params[action.fieldX] = Number(params[action.fieldX] || 0) + worldDx * facingSign;
        params[action.fieldY] = Number(params[action.fieldY] || 0) + worldDy;
      }
      onUpdateEvent(handle.event.id, { params });
      handle.event = { ...handle.event, params };
      dragRef.current = { ...dragRef.current, handle, x: cursor.x, y: cursor.y };
      return;
    }
    const { geometry } = dragRef.current;
    const params = structuredClone(geometry.event.params);
    const effect = params.damageEffects[geometry.effectIndex];
    if (dragRef.current.mode === "damageMove") {
      if ((effect.detectionType || "rangeOverlap") === "raycast") {
        effect.rayOriginX = Number(effect.rayOriginX || 0) + dx / unitScale * geometry.facingSign;
        effect.rayOriginY = Number(effect.rayOriginY || 0) - dy / unitScale;
      } else {
        effect.centerX = Number(effect.centerX || 0) + dx / unitScale * geometry.facingSign;
        effect.centerY = Number(effect.centerY || 0) - dy / unitScale;
      }
    }
    onUpdateEvent(geometry.event.id, { params });
    geometry.event = { ...geometry.event, params };
    dragRef.current = { ...dragRef.current, geometry, x: cursor.x, y: cursor.y };
  };

  return <div
    className="preview-canvas-wrap"
    ref={wrapRef}
    data-background={background}
    data-view-zoom={view.zoom}
    data-view-offset-x={view.offsetX}
    data-view-offset-y={view.offsetY}
    data-body-collider-width={project.unityCharacter.colliderWidth}
    data-body-collider-height={project.unityCharacter.colliderHeight}
    data-body-collider-offset-x={project.unityCharacter.colliderOffsetX}
    data-body-collider-offset-y={project.unityCharacter.colliderOffsetY}
    data-hurtbox-width={project.unityCharacter.hurtboxWidth}
    data-hurtbox-height={project.unityCharacter.hurtboxHeight}
    data-hurtbox-offset-x={project.unityCharacter.hurtboxOffsetX}
    data-hurtbox-offset-y={project.unityCharacter.hurtboxOffsetY}
  ><canvas ref={canvasRef} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={() => (dragRef.current = null)} onPointerCancel={() => (dragRef.current = null)} />{!currentFrame && <div className="preview-empty"><strong>等待动画帧</strong><span>从左侧导入 PNG 序列或 Sprite Sheet</span></div>}</div>;
}
