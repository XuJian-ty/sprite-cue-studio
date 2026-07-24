import { Focus, Link2, Plus, Trash2, Unlink, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { layoutEnemyBehaviorNodes, uid } from "../model";
import type { CharacterAction, EnemyBehaviorNode, EnemyBehaviorNodeType, EnemyBehaviorSettings } from "../types";

const NODE_WIDTH = 190;
const NODE_HEIGHT = 88;

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

const NODE_DEFAULT_NAMES: Record<EnemyBehaviorNodeType, string> = {
  selector: "选择分支",
  randomSelector: "随机选择分支",
  sequence: "顺序流程",
  cooldown: "冷却约束",
  repeat: "重复执行",
  inverter: "结果取反",
  condition: "判断条件",
  playAction: "播放动作",
  wait: "等待",
  customTask: "执行行为任务",
};

const CONDITION_LABELS: Record<string, string> = {
  hasTarget: "已发现目标",
  canUseAnySkill: "存在可释放技能",
  targetDistance: "目标直线距离",
  targetHorizontalDistance: "目标水平距离",
  targetInRange: "目标距离",
  targetVisible: "目标未被墙体阻挡",
  grounded: "位于地面",
  blocked: "前方受阻",
};

const TASK_LABELS: Record<string, string> = {
  patrol: "地面巡逻",
  chase: "追击目标",
  moveToTarget: "追击目标",
  stop: "停止移动",
  faceTarget: "面向目标",
  turnAround: "转向",
  useBestSkill: "选择并释放技能",
};

const MULTI_CHILD_TYPES = new Set<EnemyBehaviorNodeType>(["selector", "randomSelector", "sequence"]);
const SINGLE_CHILD_TYPES = new Set<EnemyBehaviorNodeType>(["cooldown", "repeat", "inverter"]);
const canParentChildren = (type: EnemyBehaviorNodeType) => MULTI_CHILD_TYPES.has(type) || SINGLE_CHILD_TYPES.has(type);

function normalizeOrders(nodes: EnemyBehaviorNode[]) {
  const parents = new Set(nodes.map((node) => node.parentId));
  for (const parentId of parents) {
    nodes
      .filter((node) => node.parentId === parentId)
      .sort((left, right) => left.positionX - right.positionX || left.order - right.order)
      .forEach((node, index) => (node.order = index));
  }
}

function nodeSummary(node: EnemyBehaviorNode, actions: CharacterAction[]) {
  if (node.type === "selector") return "从左到右选择首个可执行分支";
  if (node.type === "randomSelector") return "随机排列子分支并选择首个可执行分支";
  if (node.type === "sequence") return "从左到右依次执行所有子节点";
  if (node.type === "cooldown") return `成功后冷却 ${Math.max(0, node.durationSeconds)} 秒`;
  if (node.type === "repeat") return `重复执行 ${Math.max(1, Math.round(node.numberValue))} 次`;
  if (node.type === "inverter") return "反转子节点的成功或失败结果";
  if (node.type === "condition") return CONDITION_LABELS[node.conditionKey] || node.conditionKey || "未配置条件";
  if (node.type === "playAction") return actions.find((action) => action.id === node.actionId)?.name || node.actionId || "未选择动作";
  if (node.type === "wait") return `等待 ${Math.max(0, node.durationSeconds)} 秒`;
  return TASK_LABELS[node.taskKey] || node.taskKey || "未配置任务";
}

function createNode(type: EnemyBehaviorNodeType, parentId: string, order: number, x: number, y: number, actions: CharacterAction[]): EnemyBehaviorNode {
  return {
    id: uid("behavior"),
    parentId,
    order,
    name: NODE_DEFAULT_NAMES[type],
    type,
    conditionKey: "hasTarget",
    comparison: "isTrue",
    numberValue: 0,
    stringValue: "",
    actionId: type === "playAction" ? actions.find((action) => action.type === "skill")?.id || actions[0]?.id || "" : "",
    waitUntilComplete: true,
    ignoreSkillCooldown: type === "playAction",
    durationSeconds: 0.5,
    taskKey: "patrol",
    positionX: x,
    positionY: y,
  };
}

interface ViewTransform {
  x: number;
  y: number;
  zoom: number;
}

type PointerInteraction =
  | { type: "pan"; startClientX: number; startClientY: number; startViewX: number; startViewY: number }
  | { type: "node"; nodeId: string; startClientX: number; startClientY: number; startX: number; startY: number };

export default function EnemyBehaviorTreeCanvas({
  settings,
  actions,
  selectedNodeId,
  onSelectNode,
  onChange,
}: {
  settings: EnemyBehaviorSettings;
  actions: CharacterAction[];
  selectedNodeId: string;
  onSelectNode: (nodeId: string) => void;
  onChange: (settings: EnemyBehaviorSettings) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<PointerInteraction | null>(null);
  const [view, setView] = useState<ViewTransform>({ x: 40, y: 25, zoom: 1 });
  const [dragPreview, setDragPreview] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const [newNodeType, setNewNodeType] = useState<EnemyBehaviorNodeType>("condition");
  const [linkingFrom, setLinkingFrom] = useState("");
  const [linkCursor, setLinkCursor] = useState<{ x: number; y: number } | null>(null);
  const [message, setMessage] = useState("拖动节点调整布局；同一父节点下从左到右就是执行优先级");

  const nodesById = useMemo(() => new Map(settings.nodes.map((node) => [node.id, node])), [settings.nodes]);
  const selected = nodesById.get(selectedNodeId) || nodesById.get(settings.rootNodeId) || settings.nodes[0];
  const nodePosition = (node: EnemyBehaviorNode) => dragPreview?.nodeId === node.id
    ? { x: dragPreview.x, y: dragPreview.y }
    : { x: node.positionX, y: node.positionY };
  const maximumX = Math.max(2200, ...settings.nodes.map((node) => nodePosition(node).x + NODE_WIDTH + 300));
  const maximumY = Math.max(1400, ...settings.nodes.map((node) => nodePosition(node).y + NODE_HEIGHT + 300));

  const mutate = (mutator: (draft: EnemyBehaviorSettings) => void) => {
    const draft = structuredClone(settings);
    mutator(draft);
    onChange(draft);
  };

  const fitNodes = (nodes: EnemyBehaviorNode[]) => {
    const viewport = viewportRef.current;
    if (!viewport || !nodes.length) return;
    const positions = nodes.map((node) => ({ x: node.positionX, y: node.positionY }));
    const minX = Math.min(...positions.map((position) => position.x));
    const minY = Math.min(...positions.map((position) => position.y));
    const maxX = Math.max(...positions.map((position) => position.x + NODE_WIDTH));
    const maxY = Math.max(...positions.map((position) => position.y + NODE_HEIGHT));
    const rect = viewport.getBoundingClientRect();
    const zoom = Math.min(1.15, Math.max(0.35, Math.min((rect.width - 120) / Math.max(1, maxX - minX), (rect.height - 140) / Math.max(1, maxY - minY))));
    setView({
      zoom,
      x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom,
      y: Math.max(64, (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom),
    });
  };

  const fitCanvas = () => fitNodes(settings.nodes);

  useEffect(() => {
    const frame = requestAnimationFrame(fitCanvas);
    return () => cancelAnimationFrame(frame);
    // Only refit when a different tree is opened. Node dragging must preserve the current camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.rootNodeId]);

  const worldPoint = (clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return {
      x: ((clientX - (rect?.left || 0)) - view.x) / view.zoom,
      y: ((clientY - (rect?.top || 0)) - view.y) / view.zoom,
    };
  };

  const startNodeDrag = (event: React.PointerEvent<HTMLDivElement>, node: EnemyBehaviorNode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelectNode(node.id);
    interactionRef.current = {
      type: "node",
      nodeId: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: node.positionX,
      startY: node.positionY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current;
    if (interaction?.type === "pan") {
      setView((current) => ({ ...current, x: interaction.startViewX + event.clientX - interaction.startClientX, y: interaction.startViewY + event.clientY - interaction.startClientY }));
    } else if (interaction?.type === "node") {
      setDragPreview({
        nodeId: interaction.nodeId,
        x: Math.max(0, interaction.startX + (event.clientX - interaction.startClientX) / view.zoom),
        y: Math.max(20, interaction.startY + (event.clientY - interaction.startClientY) / view.zoom),
      });
    }
    if (linkingFrom) setLinkCursor(worldPoint(event.clientX, event.clientY));
  };

  const finishPointerInteraction = () => {
    if (interactionRef.current?.type === "node" && dragPreview) {
      mutate((draft) => {
        const node = draft.nodes.find((item) => item.id === dragPreview.nodeId);
        if (!node) return;
        node.positionX = Math.round(dragPreview.x);
        node.positionY = Math.round(dragPreview.y);
        normalizeOrders(draft.nodes);
      });
    }
    interactionRef.current = null;
    setDragPreview(null);
  };

  const connectNodes = (parentId: string, childId: string) => {
    const parent = nodesById.get(parentId);
    const child = nodesById.get(childId);
    if (!parent || !child || !canParentChildren(parent.type)) {
      setMessage("这个节点不能连接子节点");
      return;
    }
    const existingChildren = settings.nodes.filter((node) => node.parentId === parent.id && node.id !== child.id);
    if (SINGLE_CHILD_TYPES.has(parent.type) && existingChildren.length > 0) {
      setMessage("冷却、重复和结果取反节点只能连接一个子节点");
      return;
    }
    if (child.id === settings.rootNodeId) {
      setMessage("入口节点不能连接到其它节点下面");
      return;
    }
    let cursor: EnemyBehaviorNode | undefined = parent;
    while (cursor) {
      if (cursor.id === child.id) {
        setMessage("这条连线会形成循环，已取消");
        return;
      }
      cursor = nodesById.get(cursor.parentId);
    }
    mutate((draft) => {
      const target = draft.nodes.find((node) => node.id === childId);
      if (!target) return;
      target.parentId = parentId;
      normalizeOrders(draft.nodes);
    });
    setLinkingFrom("");
    setLinkCursor(null);
    setMessage("节点已连接；横向拖动同级节点可以调整执行优先级");
  };

  const addNode = () => {
    const selectedCanAccept = selected && canParentChildren(selected.type)
      && (!SINGLE_CHILD_TYPES.has(selected.type) || !settings.nodes.some((node) => node.parentId === selected.id));
    const parent = selectedCanAccept
      ? selected
      : nodesById.get(settings.rootNodeId);
    const parentId = parent && canParentChildren(parent.type) ? parent.id : "";
    const siblings = settings.nodes.filter((node) => node.parentId === parentId);
    const x = parent ? parent.positionX + (siblings.length - Math.max(0, siblings.length - 1) / 2) * 215 : 80;
    const y = parent ? parent.positionY + 150 : 80;
    const next = createNode(newNodeType, parentId, siblings.length, Math.max(20, x), y, actions);
    mutate((draft) => {
      draft.nodes.push(next);
      normalizeOrders(draft.nodes);
    });
    onSelectNode(next.id);
    setMessage(parentId ? `已添加到“${parent?.name}”下面` : "已添加未连接节点，请从组合节点的输出端口连线");
  };

  const deleteSelected = () => {
    if (!selected || selected.id === settings.rootNodeId) return;
    const removed = new Set<string>([selected.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of settings.nodes) {
        if (removed.has(node.parentId) && !removed.has(node.id)) {
          removed.add(node.id);
          changed = true;
        }
      }
    }
    const fallback = selected.parentId || settings.rootNodeId;
    mutate((draft) => {
      draft.nodes = draft.nodes.filter((node) => !removed.has(node.id));
      normalizeOrders(draft.nodes);
    });
    onSelectNode(fallback);
    setMessage(`已删除 ${removed.size} 个节点`);
  };

  const disconnectNode = (nodeId: string) => {
    const current = nodesById.get(nodeId);
    if (!current || current.id === settings.rootNodeId || !current.parentId) return;
    mutate((draft) => {
      const node = draft.nodes.find((item) => item.id === nodeId);
      if (node) node.parentId = "";
      normalizeOrders(draft.nodes);
    });
    onSelectNode(nodeId);
    setMessage("节点已断开；同步前请重新连接，否则配置校验会提示错误");
  };

  const disconnectSelected = () => {
    if (selected) disconnectNode(selected.id);
  };

  const autoLayout = () => {
    const draft = structuredClone(settings);
    layoutEnemyBehaviorNodes(draft);
    onChange(draft);
    setMessage("已根据运行顺序自动排版");
    requestAnimationFrame(() => requestAnimationFrame(() => fitNodes(draft.nodes)));
  };

  const zoomAtCenter = (factor: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    setView((current) => {
      const zoom = Math.min(1.8, Math.max(0.3, current.zoom * factor));
      return { zoom, x: centerX - (centerX - current.x) * zoom / current.zoom, y: centerY - (centerY - current.y) * zoom / current.zoom };
    });
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    setView((current) => {
      const zoom = Math.min(1.8, Math.max(0.3, current.zoom * (event.deltaY < 0 ? 1.1 : 0.9)));
      return { zoom, x: pointerX - (pointerX - current.x) * zoom / current.zoom, y: pointerY - (pointerY - current.y) * zoom / current.zoom };
    });
  };

  return <section className="behavior-canvas-shell">
    <div className="behavior-canvas-toolbar">
      <div className="behavior-node-create">
        <select aria-label="新节点类型" value={newNodeType} onChange={(event) => setNewNodeType(event.target.value as EnemyBehaviorNodeType)}>
          {Object.entries(NODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button type="button" onClick={addNode} title="添加到当前组合节点"><Plus size={15} />添加节点</button>
      </div>
      <div className="behavior-canvas-actions">
        {linkingFrom && <button type="button" className="active" onClick={() => { setLinkingFrom(""); setLinkCursor(null); }}><Link2 size={15} />取消连线</button>}
        <button type="button" onClick={disconnectSelected} disabled={!selected || selected.id === settings.rootNodeId || !selected.parentId} title="断开当前节点的父级连线"><Unlink size={15} />断开</button>
        <button type="button" className="danger-text" onClick={deleteSelected} disabled={!selected || selected.id === settings.rootNodeId} title="删除节点及其所有子节点"><Trash2 size={15} />删除</button>
        <button type="button" onClick={autoLayout} title="按照行为树执行顺序重新排版"><Focus size={15} />自动排版</button>
        <button type="button" className="icon-button" onClick={() => zoomAtCenter(0.85)} title="缩小"><ZoomOut size={16} /></button>
        <button type="button" className="behavior-zoom-label" onClick={() => fitCanvas()} title="显示全部节点">{Math.round(view.zoom * 100)}%</button>
        <button type="button" className="icon-button" onClick={() => zoomAtCenter(1.15)} title="放大"><ZoomIn size={16} /></button>
      </div>
    </div>

    <div
      ref={viewportRef}
      className={`behavior-canvas-viewport${linkingFrom ? " is-linking" : ""}`}
      tabIndex={0}
      onWheel={handleWheel}
      onPointerDown={(event) => {
        if (event.button !== 0 && event.button !== 1) return;
        interactionRef.current = { type: "pan", startClientX: event.clientX, startClientY: event.clientY, startViewX: view.x, startViewY: view.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerInteraction}
      onPointerCancel={finishPointerInteraction}
      onKeyDown={(event) => {
        if ((event.key === "Delete" || event.key === "Backspace") && selected?.id !== settings.rootNodeId) { event.preventDefault(); deleteSelected(); }
        if (event.key === "Escape") { setLinkingFrom(""); setLinkCursor(null); }
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onSelectNode(settings.rootNodeId); }}
    >
      <div className="behavior-canvas-world" style={{ width: maximumX, height: maximumY, transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        <svg className="behavior-edges" width={maximumX} height={maximumY} aria-hidden="true">
          <defs><marker id="behavior-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
          {settings.nodes.filter((node) => node.parentId && nodesById.has(node.parentId)).map((node) => {
            const parent = nodesById.get(node.parentId)!;
            const parentPosition = nodePosition(parent);
            const childPosition = nodePosition(node);
            const startX = parentPosition.x + NODE_WIDTH / 2;
            const startY = parentPosition.y + NODE_HEIGHT;
            const endX = childPosition.x + NODE_WIDTH / 2;
            const endY = childPosition.y;
            const middleY = startY + Math.max(36, (endY - startY) / 2);
            const path = `M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`;
            return <g key={`${parent.id}-${node.id}`} className={node.id === selected?.id ? "selected" : ""} onDoubleClick={(event) => { event.stopPropagation(); disconnectNode(node.id); }}>
              <path className="behavior-edge-hit" d={path} />
              <path className="behavior-edge-line" d={path} markerEnd="url(#behavior-arrow)" />
            </g>;
          })}
          {linkingFrom && linkCursor && nodesById.has(linkingFrom) && (() => {
            const parent = nodePosition(nodesById.get(linkingFrom)!);
            const startX = parent.x + NODE_WIDTH / 2;
            const startY = parent.y + NODE_HEIGHT;
            const middleY = startY + Math.max(30, (linkCursor.y - startY) / 2);
            return <path className="behavior-edge-line pending" d={`M ${startX} ${startY} C ${startX} ${middleY}, ${linkCursor.x} ${middleY}, ${linkCursor.x} ${linkCursor.y}`} />;
          })()}
        </svg>

        {settings.nodes.map((node) => {
          const position = nodePosition(node);
          const canHaveChildren = canParentChildren(node.type);
          const disconnected = node.id !== settings.rootNodeId && !node.parentId;
          return <div
            key={node.id}
            className={`behavior-graph-node type-${node.type}${node.id === selected?.id ? " selected" : ""}${disconnected ? " disconnected" : ""}`}
            style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
            onPointerDown={(event) => startNodeDrag(event, node)}
            onClick={(event) => { event.stopPropagation(); onSelectNode(node.id); }}
          >
            {node.id !== settings.rootNodeId && <button
              type="button"
              className={`behavior-node-port input${linkingFrom ? " connectable" : ""}`}
              aria-label={`连接到 ${node.name}`}
              title={linkingFrom ? "连接到此节点" : "输入端口"}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); if (linkingFrom) connectNodes(linkingFrom, node.id); else onSelectNode(node.id); }}
            />}
            <div className="behavior-node-heading"><strong>{node.name}</strong><span>{node.id === settings.rootNodeId ? "入口" : `优先级 ${node.order + 1}`}</span></div>
            <div className="behavior-node-type">{NODE_LABELS[node.type]}</div>
            <div className="behavior-node-summary">{nodeSummary(node, actions)}</div>
            {canHaveChildren && <button
              type="button"
              className={`behavior-node-port output${linkingFrom === node.id ? " active" : ""}`}
              aria-label={`从 ${node.name} 开始连线`}
              title="点击后连接到另一个节点的顶部端口"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); setLinkingFrom(node.id); setMessage(`正在从“${node.name}”连线，请点击目标节点顶部端口`); }}
            />}
          </div>;
        })}
      </div>
    </div>
    <div className="behavior-canvas-status"><span>{message}</span><span>双击连线可断开 · 滚轮缩放 · 空白处拖动平移</span></div>
  </section>;
}
