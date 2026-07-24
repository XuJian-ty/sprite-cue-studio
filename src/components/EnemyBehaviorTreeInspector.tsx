import type { CharacterAction, EnemyBehaviorNode, EnemyBehaviorNodeType, EnemyBehaviorSettings } from "../types";
import DeferredTextInput from "./DeferredTextInput";
import NumericInput from "./NumericInput";

const NODE_LABELS: Record<EnemyBehaviorNodeType, string> = {
  selector: "选择器",
  randomSelector: "随机选择器",
  sequence: "顺序器",
  cooldown: "冷却",
  repeat: "重复",
  inverter: "结果取反",
  condition: "条件",
  playAction: "播放动作",
  wait: "等待",
  customTask: "行为任务",
};

const CONDITION_OPTIONS = [
  ["hasTarget", "已发现目标"],
  ["canUseAnySkill", "存在可释放技能"],
  ["targetDistance", "目标直线距离"],
  ["targetHorizontalDistance", "目标水平距离"],
  ["targetInRange", "目标距离"],
  ["targetVisible", "目标未被墙体阻挡"],
  ["grounded", "位于地面"],
  ["blocked", "前方受阻"],
] as const;

const TASK_OPTIONS = [
  ["patrol", "地面巡逻"],
  ["chase", "追击目标"],
  ["stop", "停止移动"],
  ["faceTarget", "面向目标"],
  ["turnAround", "转向"],
  ["useBestSkill", "选择并释放技能"],
] as const;

const MULTI_CHILD_TYPES = new Set<EnemyBehaviorNodeType>(["selector", "randomSelector", "sequence"]);
const SINGLE_CHILD_TYPES = new Set<EnemyBehaviorNodeType>(["cooldown", "repeat", "inverter"]);

export default function EnemyBehaviorTreeInspector({
  settings,
  actions,
  selectedNodeId,
  onChange,
}: {
  settings: EnemyBehaviorSettings;
  actions: CharacterAction[];
  selectedNodeId: string;
  onChange: (settings: EnemyBehaviorSettings) => void;
}) {
  const selected = settings.nodes.find((node) => node.id === selectedNodeId) || settings.nodes.find((node) => node.id === settings.rootNodeId) || settings.nodes[0];
  const selectedChildCount = selected ? settings.nodes.filter((node) => node.parentId === selected.id).length : 0;

  const mutate = (mutator: (draft: EnemyBehaviorSettings) => void) => {
    const draft = structuredClone(settings);
    mutator(draft);
    onChange(draft);
  };

  const updateMovement = (patch: Partial<EnemyBehaviorSettings["movement"]>) => {
    mutate((draft) => Object.assign(draft.movement, patch));
  };

  const updateSelected = (patch: Partial<EnemyBehaviorNode>) => {
    if (!selected) return;
    mutate((draft) => Object.assign(draft.nodes.find((node) => node.id === selected.id)!, patch));
  };

  return <div className="behavior-inspector">
    {selected && <section className="inspector-section behavior-current-node">
      <div className="section-heading"><div><strong>当前节点</strong><span>{NODE_LABELS[selected.type]} · 优先级 {selected.order + 1}</span></div></div>
      <label className="field"><span>名称</span><DeferredTextInput value={selected.name} onValueChange={(value) => updateSelected({ name: value })} /></label>
      <label className="field"><span>类型</span><select value={selected.type} disabled={selected.id === settings.rootNodeId} onChange={(event) => updateSelected({ type: event.target.value as EnemyBehaviorNodeType })}>
        {Object.entries(NODE_LABELS).filter(([type]) => selectedChildCount === 0
          || MULTI_CHILD_TYPES.has(type as EnemyBehaviorNodeType)
          || selectedChildCount === 1 && SINGLE_CHILD_TYPES.has(type as EnemyBehaviorNodeType)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>

      {selected.type === "condition" && <>
        <label className="field"><span>条件</span><select value={CONDITION_OPTIONS.some(([value]) => value === selected.conditionKey) ? selected.conditionKey : "__custom"} onChange={(event) => updateSelected({ conditionKey: event.target.value === "__custom" ? "customCondition" : event.target.value })}>
          {CONDITION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="__custom">项目自定义...</option>
        </select></label>
        {!CONDITION_OPTIONS.some(([value]) => value === selected.conditionKey) && <label className="field"><span>自定义条件键</span><DeferredTextInput value={selected.conditionKey} placeholder="例如 health" onValueChange={(value) => updateSelected({ conditionKey: value })} /></label>}
        <label className="field"><span>比较方式</span><select value={selected.comparison} onChange={(event) => updateSelected({ comparison: event.target.value as EnemyBehaviorNode["comparison"] })}>
          <option value="isTrue">为真</option><option value="isFalse">为假</option><option value="less">小于</option><option value="lessOrEqual">小于等于</option><option value="greater">大于</option><option value="greaterOrEqual">大于等于</option><option value="equal">等于</option>
        </select></label>
        {!selected.comparison.startsWith("is") && <label className="field"><span>比较数值</span><NumericInput value={selected.numberValue} step={0.1} onValueChange={(value) => updateSelected({ numberValue: value })} /></label>}
        {!CONDITION_OPTIONS.some(([value]) => value === selected.conditionKey) && <label className="field"><span>文本参数</span><DeferredTextInput value={selected.stringValue} placeholder="可选参数" onValueChange={(value) => updateSelected({ stringValue: value })} /></label>}
      </>}

      {selected.type === "playAction" && <>
        <label className="field"><span>动作</span><select value={selected.actionId} onChange={(event) => updateSelected({ actionId: event.target.value })}>
          <option value="">选择动作...</option>{actions.map((action) => <option key={action.id} value={action.id}>{action.name} · {action.id}</option>)}
        </select></label>
        <label className="toggle-row"><input type="checkbox" checked={selected.waitUntilComplete} onChange={(event) => updateSelected({ waitUntilComplete: event.target.checked })} /><span>等待动作播放完成</span></label>
      </>}

      {selected.type === "wait" && <label className="field"><span>等待秒数</span><NumericInput value={selected.durationSeconds} min={0} step={0.1} onValueChange={(value) => updateSelected({ durationSeconds: Math.max(0, value) })} /></label>}
      {selected.type === "cooldown" && <label className="field"><span>冷却秒数</span><NumericInput value={selected.durationSeconds} min={0} step={0.1} onValueChange={(value) => updateSelected({ durationSeconds: Math.max(0, value) })} /></label>}
      {selected.type === "repeat" && <label className="field"><span>重复次数</span><NumericInput value={selected.numberValue} min={1} step={1} onValueChange={(value) => updateSelected({ numberValue: Math.max(1, Math.round(value)) })} /></label>}

      {selected.type === "customTask" && <>
        <label className="field"><span>行为任务</span><select value={TASK_OPTIONS.some(([value]) => value === selected.taskKey || selected.taskKey === "moveToTarget" && value === "chase") ? (selected.taskKey === "moveToTarget" ? "chase" : selected.taskKey) : "__custom"} onChange={(event) => updateSelected({ taskKey: event.target.value === "__custom" ? "customTask" : event.target.value })}>
          {TASK_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="__custom">项目自定义...</option>
        </select></label>
        {!TASK_OPTIONS.some(([value]) => value === selected.taskKey || selected.taskKey === "moveToTarget" && value === "chase") && <>
          <label className="field"><span>自定义任务键</span><DeferredTextInput value={selected.taskKey} placeholder="例如 flee" onValueChange={(value) => updateSelected({ taskKey: value })} /></label>
          <label className="field"><span>数值参数</span><NumericInput value={selected.numberValue} step={0.1} onValueChange={(value) => updateSelected({ numberValue: value })} /></label>
          <label className="field"><span>文本参数</span><DeferredTextInput value={selected.stringValue} placeholder="可选参数" onValueChange={(value) => updateSelected({ stringValue: value })} /></label>
        </>}
      </>}
    </section>}

    <section className="inspector-section">
      <div className="section-heading"><div><strong>行为树运行</strong><span>同步到敌人 Prefab</span></div></div>
      <label className="toggle-row"><input type="checkbox" checked={settings.enabled} onChange={(event) => mutate((draft) => (draft.enabled = event.target.checked))} /><span>启用 Runtime 行为树</span></label>
      <label className="field"><span>决策间隔（秒）</span><NumericInput value={settings.tickIntervalSeconds} min={0.02} max={10} step={0.01} onValueChange={(value) => mutate((draft) => (draft.tickIntervalSeconds = Math.max(0.02, value)))} /></label>
      <p className="inspector-help">“选择并释放技能”会检查技能自身的冷却、距离和权重；手动放置的“播放动作”技能会直接执行，冷却和释放条件由冷却节点、条件节点控制。受击、眩晕会自动暂停行为树并停止移动。</p>
    </section>

    <section className="inspector-section">
      <div className="section-heading"><div><strong>横向移动</strong><span>Rigidbody2D · 无寻路依赖</span></div></div>
      <label className="toggle-row"><input type="checkbox" checked={settings.movement.enabled} onChange={(event) => updateMovement({ enabled: event.target.checked })} /><span>启用内置敌人移动</span></label>
      {settings.movement.enabled && <>
        <label className="field"><span>目标标签</span><DeferredTextInput value={settings.movement.targetTag} placeholder="Player" onValueChange={(value) => updateMovement({ targetTag: value })} /></label>
        <div className="field-grid two-columns">
          <label className="field"><span>发现范围</span><NumericInput value={settings.movement.detectionRange} min={0.01} step={0.1} onValueChange={(value) => updateMovement({ detectionRange: Math.max(0.01, value), loseTargetRange: Math.max(value, settings.movement.loseTargetRange) })} /></label>
          <label className="field"><span>丢失目标范围</span><NumericInput value={settings.movement.loseTargetRange} min={settings.movement.detectionRange} step={0.1} onValueChange={(value) => updateMovement({ loseTargetRange: Math.max(settings.movement.detectionRange, value) })} /></label>
          <label className="field"><span>纵向容差</span><NumericInput value={settings.movement.verticalTolerance} min={0} step={0.1} onValueChange={(value) => updateMovement({ verticalTolerance: Math.max(0, value) })} /></label>
          <label className="field"><span>停止距离</span><NumericInput value={settings.movement.stopDistance} min={0} step={0.1} onValueChange={(value) => updateMovement({ stopDistance: Math.max(0, value) })} /></label>
          <label className="field"><span>巡逻半径</span><NumericInput value={settings.movement.patrolDistance} min={0} step={0.1} onValueChange={(value) => updateMovement({ patrolDistance: Math.max(0, value) })} /></label>
          <label className="field"><span>巡逻速度</span><NumericInput value={settings.movement.patrolSpeed} min={0} step={0.1} onValueChange={(value) => updateMovement({ patrolSpeed: Math.max(0, value) })} /></label>
          <label className="field"><span>追击速度</span><NumericInput value={settings.movement.chaseSpeed} min={0} step={0.1} onValueChange={(value) => updateMovement({ chaseSpeed: Math.max(0, value) })} /></label>
          <label className="field"><span>加速度</span><NumericInput value={settings.movement.acceleration} min={0.01} step={0.5} onValueChange={(value) => updateMovement({ acceleration: Math.max(0.01, value) })} /></label>
          <label className="field"><span>遇墙等待（秒）</span><NumericInput value={settings.movement.blockedWaitSeconds} min={0} step={0.1} onValueChange={(value) => updateMovement({ blockedWaitSeconds: Math.max(0, value) })} /></label>
          <label className="field"><span>转身冷却（秒）</span><NumericInput value={settings.movement.turnCooldownSeconds} min={0} step={0.01} onValueChange={(value) => updateMovement({ turnCooldownSeconds: Math.max(0, value) })} /></label>
          <label className="field"><span>墙壁检测距离</span><NumericInput value={settings.movement.wallCheckDistance} min={0.001} step={0.01} onValueChange={(value) => updateMovement({ wallCheckDistance: Math.max(0.001, value) })} /></label>
          <label className="field"><span>悬崖前探距离</span><NumericInput value={settings.movement.ledgeCheckForwardDistance} min={0} step={0.01} onValueChange={(value) => updateMovement({ ledgeCheckForwardDistance: Math.max(0, value) })} /></label>
          <label className="field"><span>悬崖下探距离</span><NumericInput value={settings.movement.ledgeCheckDownDistance} min={0.001} step={0.01} onValueChange={(value) => updateMovement({ ledgeCheckDownDistance: Math.max(0.001, value) })} /></label>
          <label className="field"><span>地面检测距离</span><NumericInput value={settings.movement.groundCheckDistance} min={0.001} step={0.01} onValueChange={(value) => updateMovement({ groundCheckDistance: Math.max(0.001, value) })} /></label>
          <label className="field"><span>重力倍率</span><NumericInput value={settings.movement.gravityScale} min={0} step={0.1} onValueChange={(value) => updateMovement({ gravityScale: Math.max(0, value) })} /></label>
          <label className="field"><span>最大下落速度</span><NumericInput value={settings.movement.maxFallSpeed} min={0.01} step={0.1} onValueChange={(value) => updateMovement({ maxFallSpeed: Math.max(0.01, value) })} /></label>
        </div>
        <label className="field"><span>地面 Layer</span><DeferredTextInput value={settings.movement.environmentLayerName} placeholder="Ground；多个名称用逗号分隔" onValueChange={(value) => updateMovement({ environmentLayerName: value })} /></label>
        <p className="inspector-help">巡逻碰到墙、悬崖或巡逻边界会转身；追击受阻会先等待，超时后放弃目标并恢复巡逻。</p>
      </>}
    </section>

  </div>;
}
