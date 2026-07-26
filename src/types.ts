export type TrackKind = "damage" | "physics" | "vfx" | "sfx" | "speed" | "camera";

export interface AssetRef {
  id: string;
  name: string;
  kind: "image" | "audio";
  usage?: "character" | "vfx" | "audio";
  url: string;
  dataUrl?: string;
  byteSize?: number;
  sha256?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface AnimationFrame {
  id: string;
  name: string;
  assetId: string;
  durationTicks: number;
}

export interface ActionMarker {
  id: string;
  name: string;
  tick: number;
}

export interface TimelineEvent {
  id: string;
  name: string;
  type: string;
  startTick: number;
  durationTicks: number;
  color: string;
  triggerMode: "once" | "repeated";
  activeDurationMode: "fixed" | "untilActionEnd";
  repeatIntervalTicks: number;
  params: Record<string, any>;
}

export interface TimelineTrack {
  id: string;
  name: string;
  kind: TrackKind;
  events: TimelineEvent[];
}

export interface ActionSegment {
  id: string;
  name: string;
  fps: number;
  frameCount: number;
  sheetColumns: number;
  sheetSpacing: number;
  sheetPadding: number;
  cellWidth: number;
  cellHeight: number;
  pixelsPerUnit: number;
  pivotX: number;
  pivotY: number;
  jumpHeight: number;
  spriteSheetAssetId?: string;
  frames: AnimationFrame[];
  markers: ActionMarker[];
  tracks: TimelineTrack[];
}

export interface CharacterAction {
  id: string;
  name: string;
  type: "idleGround" | "idleAir" | "move" | "jump" | "dropThrough" | "attack" | "skill" | "hurt" | "custom";
  loop: boolean;
  acceptMovementInput: boolean;
  acceptJumpInput: boolean;
  comboCount: number;
  comboWindow: number;
  repeatWindow: number;
  allowLastRepeat: boolean;
  doubleTapWindow: number;
  movementSpeed: number;
  enemySkill?: EnemySkillSettings;
  trigger: { type: string; code: string; secondaryCode?: string };
  transitions: Record<string, "interrupt" | "buffer" | "ignore">;
  segments: ActionSegment[];
}

export interface EnemySkillSettings {
  cooldownSeconds: number;
  minRange: number;
  maxRange: number;
  selectionWeight: number;
  lockMovement: boolean;
  lockFacing: boolean;
}

export interface CharacterMotorSettings {
  enableInput: boolean;
  enableMotor: boolean;
  autoFaceMovement: boolean;
  groundAcceleration: number;
  groundDeceleration: number;
  airControl: number;
  gravityScale: number;
  maxFallSpeed: number;
  coyoteTime: number;
  jumpBufferTime: number;
  groundCheckDistance: number;
  groundLayerName: string;
  inputDeadZone: number;
}

export interface UnityCharacterSettings {
  prefabPath: string;
  actorLayerName: string;
  collideWithOtherActors: boolean;
  colliderShape: "capsule" | "box";
  colliderWidth: number;
  colliderHeight: number;
  colliderOffsetX: number;
  colliderOffsetY: number;
  hurtboxShape: "capsule" | "box";
  hurtboxWidth: number;
  hurtboxHeight: number;
  hurtboxOffsetX: number;
  hurtboxOffsetY: number;
  rigidbodyMass: number;
}

export interface CameraFollowSettings {
  enabled: boolean;
  followHorizontal: boolean;
  followVertical: boolean;
  smoothTime: number;
  offsetX: number;
  offsetY: number;
  orthographicSize: number;
  constrainToMap: boolean;
  edgePaddingX: number;
  edgePaddingY: number;
}

export interface EnemyBehaviorSettings {
  playGroundIdleOnEnable: boolean;
  returnToIdleOnComplete: boolean;
  enabled: boolean;
  tickIntervalSeconds: number;
  movement: EnemyMovementSettings;
  rootNodeId: string;
  nodes: EnemyBehaviorNode[];
}

export interface EnemyMovementSettings {
  enabled: boolean;
  targetTag: string;
  detectionRange: number;
  loseTargetRange: number;
  verticalTolerance: number;
  patrolDistance: number;
  patrolSpeed: number;
  chaseSpeed: number;
  acceleration: number;
  stopDistance: number;
  blockedWaitSeconds: number;
  turnCooldownSeconds: number;
  wallCheckDistance: number;
  ledgeCheckForwardDistance: number;
  ledgeCheckDownDistance: number;
  groundCheckDistance: number;
  environmentLayerName: string;
  gravityScale: number;
  maxFallSpeed: number;
}

export type EnemyBehaviorNodeType = "selector" | "randomSelector" | "sequence" | "cooldown" | "repeat" | "inverter" | "condition" | "playAction" | "wait" | "customTask";

export interface EnemyBehaviorNode {
  id: string;
  parentId: string;
  order: number;
  name: string;
  type: EnemyBehaviorNodeType;
  conditionKey: string;
  comparison: "isTrue" | "isFalse" | "less" | "lessOrEqual" | "greater" | "greaterOrEqual" | "equal";
  numberValue: number;
  stringValue: string;
  actionId: string;
  waitUntilComplete: boolean;
  ignoreSkillCooldown: boolean;
  durationSeconds: number;
  taskKey: string;
  positionX: number;
  positionY: number;
}

export interface CharacterProject {
  format: "frame-action-project";
  version: 11;
  projectKind: "character" | "enemy";
  tickRate: number;
  characterName: string;
  pixelsPerUnit: number;
  sourceFacing: "left" | "right";
  groundIdleId: string;
  airIdleId: string;
  motor: CharacterMotorSettings;
  cameraFollow: CameraFollowSettings;
  unityCharacter: UnityCharacterSettings;
  enemyBehavior?: EnemyBehaviorSettings;
  actions: CharacterAction[];
}
