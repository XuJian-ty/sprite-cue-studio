using System;
using System.Collections.Generic;
using UnityEngine;

namespace FrameAction
{
    public enum FrameActionEnemyBehaviorStatus
    {
        Running,
        Success,
        Failure,
    }

    /// <summary>
    /// Project bridge for behavior-tree blackboard conditions and game-specific tasks.
    /// Implement this on a component placed on the enemy root or assign it explicitly.
    /// </summary>
    public interface IFrameActionEnemyBehaviorAdapter
    {
        bool EvaluateCondition(string key, string comparison, float numberValue, string stringValue);
        FrameActionEnemyBehaviorStatus ExecuteTask(string key, float numberValue, string stringValue);
        void ResetTask(string key);
    }

    [DisallowMultipleComponent]
    public sealed class FrameActionEnemyBehaviorRunner2D : MonoBehaviour
    {
        private sealed class NodeRuntime
        {
            public bool started;
            // The player may automatically start an idle/move action immediately
            // after a one-shot action completes. Keep the execution id so an
            // explicit behavior-tree action can still observe that completion
            // even when the current action has already changed.
            public int actionExecutionId;
            public bool cooldownStarted;
            public int childIndex;
            public float startedAt;
            public List<int> randomOrder;
        }

        public FrameActionEnemyController2D controller;
        public FrameActionEnemyMotor2D motor;
        [Tooltip("Optional component implementing IFrameActionEnemyBehaviorAdapter. When empty, the runner searches this GameObject.")]
        public MonoBehaviour adapterBehaviour;
        [Min(0.02f)] public float tickIntervalSeconds = 0.1f;
        [Tooltip("Print combo selection, authored action steps, and failures to the Unity Console.")]
        public bool logBehaviorDecisions = true;

        public FrameActionEnemyBehaviorStatus LastRootStatus { get; private set; } = FrameActionEnemyBehaviorStatus.Running;
        public string RunningNodeId { get; private set; } = string.Empty;
        public bool IsSuspendedForActionLock { get; private set; }

        private FrameActionEnemyBehaviorSettings _settings;
        private IFrameActionEnemyBehaviorAdapter _adapter;
        private readonly Dictionary<string, FrameActionEnemyBehaviorNodeData> _nodes = new Dictionary<string, FrameActionEnemyBehaviorNodeData>(StringComparer.Ordinal);
        private readonly Dictionary<string, List<FrameActionEnemyBehaviorNodeData>> _children = new Dictionary<string, List<FrameActionEnemyBehaviorNodeData>>(StringComparer.Ordinal);
        private readonly Dictionary<string, NodeRuntime> _runtime = new Dictionary<string, NodeRuntime>(StringComparer.Ordinal);
        private readonly Dictionary<string, float> _cooldownUntil = new Dictionary<string, float>(StringComparer.Ordinal);
        private float _nextTickTime;

        private void Awake()
        {
            if (controller == null) controller = GetComponent<FrameActionEnemyController2D>();
            if (motor == null) motor = GetComponent<FrameActionEnemyMotor2D>();
            ResolveAdapter();
            ReloadFromProject();
        }

        private void OnEnable()
        {
            ReloadFromProject();
            _nextTickTime = Time.time;
            if (controller != null)
            {
                controller.ActionLockChanged -= HandleActionLockChanged;
                controller.ActionLockChanged += HandleActionLockChanged;
                UpdateActionLockState(controller.IsActionLocked);
            }
        }

        private void OnDisable()
        {
            if (controller != null) controller.ActionLockChanged -= HandleActionLockChanged;
            ResetTree();
            motor?.HaltImmediately();
            IsSuspendedForActionLock = false;
        }

        private void Update()
        {
            bool locked = controller != null && controller.IsActionLocked;
            if (locked || IsSuspendedForActionLock)
            {
                UpdateActionLockState(locked);
                if (locked) return;
            }
            if (Time.time < _nextTickTime) return;
            _nextTickTime = Time.time + Mathf.Max(0.02f, tickIntervalSeconds);
            TickOnce();
        }

        public void ReloadFromProject()
        {
            if (controller == null) controller = GetComponent<FrameActionEnemyController2D>();
            if (motor == null) motor = GetComponent<FrameActionEnemyMotor2D>();
            if (controller?.player != null && controller.player.Project == null) controller.player.Load();
            _settings = controller?.player?.Project?.enemyBehavior;
            _nodes.Clear();
            _children.Clear();
            _runtime.Clear();
            _cooldownUntil.Clear();
            if (_settings?.nodes == null) return;
            tickIntervalSeconds = Mathf.Max(0.02f, _settings.tickIntervalSeconds);
            for (int i = 0; i < _settings.nodes.Count; i++)
            {
                FrameActionEnemyBehaviorNodeData node = _settings.nodes[i];
                if (node == null || string.IsNullOrEmpty(node.id)) continue;
                _nodes[node.id] = node;
                string parentId = node.parentId ?? string.Empty;
                if (!_children.TryGetValue(parentId, out List<FrameActionEnemyBehaviorNodeData> children))
                {
                    children = new List<FrameActionEnemyBehaviorNodeData>();
                    _children[parentId] = children;
                }
                children.Add(node);
            }
            foreach (List<FrameActionEnemyBehaviorNodeData> children in _children.Values)
            {
                children.Sort((left, right) => left.order.CompareTo(right.order));
            }
            ResolveAdapter();
        }

        public FrameActionEnemyBehaviorStatus TickOnce()
        {
            if (controller != null && controller.IsActionLocked)
            {
                UpdateActionLockState(true);
                LastRootStatus = FrameActionEnemyBehaviorStatus.Running;
                return LastRootStatus;
            }
            if (IsSuspendedForActionLock) UpdateActionLockState(false);
            if (_settings == null || string.IsNullOrEmpty(_settings.rootNodeId) || !_nodes.ContainsKey(_settings.rootNodeId))
            {
                LastRootStatus = FrameActionEnemyBehaviorStatus.Failure;
                return LastRootStatus;
            }
            RunningNodeId = string.Empty;
            LastRootStatus = TickNode(_settings.rootNodeId, new HashSet<string>());
            if (LastRootStatus != FrameActionEnemyBehaviorStatus.Running) ResetNode(_settings.rootNodeId, new HashSet<string>());
            return LastRootStatus;
        }

        public void ResetTree()
        {
            if (_settings != null && !string.IsNullOrEmpty(_settings.rootNodeId)) ResetNode(_settings.rootNodeId, new HashSet<string>());
            _runtime.Clear();
            RunningNodeId = string.Empty;
            LastRootStatus = FrameActionEnemyBehaviorStatus.Running;
        }

        private void HandleActionLockChanged(bool locked)
        {
            UpdateActionLockState(locked);
        }

        private void UpdateActionLockState(bool locked)
        {
            if (locked)
            {
                if (IsSuspendedForActionLock) return;
                IsSuspendedForActionLock = true;
                ResetTree();
                motor?.HaltImmediately();
                return;
            }
            if (!IsSuspendedForActionLock) return;
            IsSuspendedForActionLock = false;
            ResetTree();
            _nextTickTime = Time.time;
        }

        private FrameActionEnemyBehaviorStatus TickNode(string nodeId, HashSet<string> path)
        {
            if (!_nodes.TryGetValue(nodeId, out FrameActionEnemyBehaviorNodeData node) || !path.Add(nodeId)) return FrameActionEnemyBehaviorStatus.Failure;
            NodeRuntime state = GetRuntime(nodeId);
            FrameActionEnemyBehaviorStatus result;
            switch (node.type)
            {
                case "selector":
                    result = TickComposite(node, state, false, path);
                    break;
                case "randomSelector":
                    result = TickRandomSelector(node, state, path);
                    break;
                case "sequence":
                    result = TickComposite(node, state, true, path);
                    break;
                case "cooldown":
                    result = TickCooldown(node, state, path);
                    break;
                case "repeat":
                    result = TickRepeat(node, state, path);
                    break;
                case "inverter":
                    result = TickInverter(node, path);
                    break;
                case "condition":
                    bool condition;
                    if (motor != null && motor.TryEvaluateCondition(node.conditionKey ?? string.Empty, node.comparison ?? "isTrue", node.numberValue, node.stringValue ?? string.Empty, out condition))
                    {
                        result = condition ? FrameActionEnemyBehaviorStatus.Success : FrameActionEnemyBehaviorStatus.Failure;
                    }
                    else
                    {
                        result = _adapter != null && _adapter.EvaluateCondition(node.conditionKey ?? string.Empty, node.comparison ?? "isTrue", node.numberValue, node.stringValue ?? string.Empty)
                            ? FrameActionEnemyBehaviorStatus.Success
                            : FrameActionEnemyBehaviorStatus.Failure;
                    }
                    break;
                case "playAction":
                    result = TickPlayAction(node, state);
                    break;
                case "wait":
                    result = TickWait(node, state);
                    break;
                case "customTask":
                    if (motor != null && motor.TryExecuteTask(node.taskKey ?? string.Empty, node.numberValue, node.stringValue ?? string.Empty, out FrameActionEnemyBehaviorStatus builtinStatus))
                    {
                        result = builtinStatus;
                    }
                    else
                    {
                        result = _adapter != null
                            ? _adapter.ExecuteTask(node.taskKey ?? string.Empty, node.numberValue, node.stringValue ?? string.Empty)
                            : FrameActionEnemyBehaviorStatus.Failure;
                    }
                    break;
                default:
                    result = FrameActionEnemyBehaviorStatus.Failure;
                    break;
            }
            path.Remove(nodeId);
            if (result == FrameActionEnemyBehaviorStatus.Running && string.IsNullOrEmpty(RunningNodeId)) RunningNodeId = nodeId;
            return result;
        }

        private FrameActionEnemyBehaviorStatus TickComposite(FrameActionEnemyBehaviorNodeData node, NodeRuntime state, bool sequence, HashSet<string> path)
        {
            if (!_children.TryGetValue(node.id, out List<FrameActionEnemyBehaviorNodeData> children) || children.Count == 0)
            {
                return sequence ? FrameActionEnemyBehaviorStatus.Success : FrameActionEnemyBehaviorStatus.Failure;
            }
            state.childIndex = Mathf.Clamp(state.childIndex, 0, children.Count - 1);
            while (state.childIndex < children.Count)
            {
                FrameActionEnemyBehaviorStatus childStatus = TickNode(children[state.childIndex].id, path);
                if (childStatus == FrameActionEnemyBehaviorStatus.Running) return childStatus;
                bool advance = sequence
                    ? childStatus == FrameActionEnemyBehaviorStatus.Success
                    : childStatus == FrameActionEnemyBehaviorStatus.Failure;
                if (!advance)
                {
                    ResetChildren(node.id);
                    state.childIndex = 0;
                    return sequence ? FrameActionEnemyBehaviorStatus.Failure : FrameActionEnemyBehaviorStatus.Success;
                }
                state.childIndex += 1;
            }
            ResetChildren(node.id);
            state.childIndex = 0;
            return sequence ? FrameActionEnemyBehaviorStatus.Success : FrameActionEnemyBehaviorStatus.Failure;
        }

        private FrameActionEnemyBehaviorStatus TickPlayAction(FrameActionEnemyBehaviorNodeData node, NodeRuntime state)
        {
            if (controller == null || string.IsNullOrEmpty(node.actionId)) return FrameActionEnemyBehaviorStatus.Failure;
            if (!state.started)
            {
                float targetDistance = motor != null ? motor.TargetHorizontalDistance : 0f;
                // Explicit play-action nodes are authored behavior-tree steps. Their availability is
                // controlled by surrounding condition/cooldown nodes, not by per-skill selection rules.
                if (!controller.PlayBehaviorAction(node.actionId, targetDistance, false, true))
                {
                    if (logBehaviorDecisions)
                    {
                        Debug.LogWarning(
                            $"[Frame Action AI] {name} 动作节点启动失败：{NodeLabel(node)} -> {ActionLabel(node.actionId)}，" +
                            $"当前动作={controller.CurrentActionId ?? "(无)"}，受击锁定={controller.IsHurtLocked}，眩晕={controller.IsStunned}。",
                            this);
                    }
                    return FrameActionEnemyBehaviorStatus.Failure;
                }
                state.started = true;
                state.actionExecutionId = controller.player != null ? controller.player.CurrentActionExecutionId : 0;
                if (logBehaviorDecisions)
                {
                    Debug.Log(
                        $"[Frame Action AI] {name} 执行动作节点：{NodeLabel(node)} -> {ActionLabel(node.actionId)} " +
                        $"(执行编号 {state.actionExecutionId})。",
                        this);
                }
                if (!node.waitUntilComplete) return FrameActionEnemyBehaviorStatus.Success;
            }
            // A completed one-shot action can be followed by the motor's
            // locomotion idle before this runner ticks again. A newer player
            // execution proves that the authored action ended successfully;
            // treating it as failure would abort sequences and, importantly,
            // prevent their cooldown nodes from ever arming.
            if (controller.player != null && controller.player.CurrentActionExecutionId != state.actionExecutionId)
            {
                return FrameActionEnemyBehaviorStatus.Success;
            }
            if (!string.Equals(controller.CurrentActionId, node.actionId, StringComparison.Ordinal))
            {
                if (logBehaviorDecisions)
                {
                    Debug.LogWarning(
                        $"[Frame Action AI] {name} 动作节点被中断：{NodeLabel(node)} -> {ActionLabel(node.actionId)}，" +
                        $"当前动作={controller.CurrentActionId ?? "(无)"}。",
                        this);
                }
                return FrameActionEnemyBehaviorStatus.Failure;
            }
            return controller.IsPlaying ? FrameActionEnemyBehaviorStatus.Running : FrameActionEnemyBehaviorStatus.Success;
        }

        private FrameActionEnemyBehaviorStatus TickRandomSelector(FrameActionEnemyBehaviorNodeData node, NodeRuntime state, HashSet<string> path)
        {
            if (!_children.TryGetValue(node.id, out List<FrameActionEnemyBehaviorNodeData> children) || children.Count == 0)
            {
                return FrameActionEnemyBehaviorStatus.Failure;
            }
            if (state.randomOrder == null || state.randomOrder.Count != children.Count)
            {
                state.randomOrder = new List<int>(children.Count);
                for (int i = 0; i < children.Count; i++) state.randomOrder.Add(i);
                for (int i = state.randomOrder.Count - 1; i > 0; i--)
                {
                    int swapIndex = UnityEngine.Random.Range(0, i + 1);
                    int value = state.randomOrder[i];
                    state.randomOrder[i] = state.randomOrder[swapIndex];
                    state.randomOrder[swapIndex] = value;
                }
                state.childIndex = 0;
            }
            while (state.childIndex < state.randomOrder.Count)
            {
                FrameActionEnemyBehaviorNodeData child = children[state.randomOrder[state.childIndex]];
                FrameActionEnemyBehaviorStatus childStatus = TickNode(child.id, path);
                if (childStatus == FrameActionEnemyBehaviorStatus.Running) return childStatus;
                if (childStatus == FrameActionEnemyBehaviorStatus.Success)
                {
                    ResetChildren(node.id);
                    state.childIndex = 0;
                    state.randomOrder = null;
                    return FrameActionEnemyBehaviorStatus.Success;
                }
                ResetNode(child.id, new HashSet<string>());
                state.childIndex += 1;
            }
            ResetChildren(node.id);
            state.childIndex = 0;
            state.randomOrder = null;
            return FrameActionEnemyBehaviorStatus.Failure;
        }

        private FrameActionEnemyBehaviorStatus TickCooldown(FrameActionEnemyBehaviorNodeData node, NodeRuntime state, HashSet<string> path)
        {
            // Once this decorator has started its child, the active cooldown must
            // not reject that same running branch on the next behavior tick.
            // It only blocks a fresh entry after the branch has exited/reset.
            if (!state.cooldownStarted
                && _cooldownUntil.TryGetValue(node.id, out float until)
                && Time.time < until)
            {
                return FrameActionEnemyBehaviorStatus.Failure;
            }
            if (!TryGetOnlyChild(node.id, out FrameActionEnemyBehaviorNodeData child)) return FrameActionEnemyBehaviorStatus.Failure;
            FrameActionEnemyBehaviorStatus childStatus = TickNode(child.id, path);
            if (childStatus == FrameActionEnemyBehaviorStatus.Running)
            {
                // Arm the cooldown as soon as the wrapped branch actually
                // starts. This makes a combo cooldown cover the full combo and
                // also protects against an interruption before final success.
                if (!state.cooldownStarted)
                {
                    _cooldownUntil[node.id] = Time.time + Mathf.Max(0f, node.durationSeconds);
                    state.cooldownStarted = true;
                    LogComboStarted(node, child);
                }
                return childStatus;
            }
            ResetNode(child.id, new HashSet<string>());
            if (childStatus == FrameActionEnemyBehaviorStatus.Success)
            {
                if (!state.cooldownStarted)
                {
                    _cooldownUntil[node.id] = Time.time + Mathf.Max(0f, node.durationSeconds);
                    state.cooldownStarted = true;
                    LogComboStarted(node, child);
                }
                return FrameActionEnemyBehaviorStatus.Success;
            }
            return FrameActionEnemyBehaviorStatus.Failure;
        }

        private FrameActionEnemyBehaviorStatus TickRepeat(FrameActionEnemyBehaviorNodeData node, NodeRuntime state, HashSet<string> path)
        {
            if (!TryGetOnlyChild(node.id, out FrameActionEnemyBehaviorNodeData child)) return FrameActionEnemyBehaviorStatus.Failure;
            int repeatCount = Mathf.Max(1, Mathf.RoundToInt(node.numberValue));
            FrameActionEnemyBehaviorStatus childStatus = TickNode(child.id, path);
            if (childStatus == FrameActionEnemyBehaviorStatus.Running) return childStatus;
            ResetNode(child.id, new HashSet<string>());
            if (childStatus == FrameActionEnemyBehaviorStatus.Failure)
            {
                state.childIndex = 0;
                return FrameActionEnemyBehaviorStatus.Failure;
            }
            state.childIndex += 1;
            if (state.childIndex < repeatCount) return FrameActionEnemyBehaviorStatus.Running;
            state.childIndex = 0;
            return FrameActionEnemyBehaviorStatus.Success;
        }

        private FrameActionEnemyBehaviorStatus TickInverter(FrameActionEnemyBehaviorNodeData node, HashSet<string> path)
        {
            if (!TryGetOnlyChild(node.id, out FrameActionEnemyBehaviorNodeData child)) return FrameActionEnemyBehaviorStatus.Failure;
            FrameActionEnemyBehaviorStatus childStatus = TickNode(child.id, path);
            if (childStatus == FrameActionEnemyBehaviorStatus.Running) return childStatus;
            ResetNode(child.id, new HashSet<string>());
            return childStatus == FrameActionEnemyBehaviorStatus.Success
                ? FrameActionEnemyBehaviorStatus.Failure
                : FrameActionEnemyBehaviorStatus.Success;
        }

        private bool TryGetOnlyChild(string parentId, out FrameActionEnemyBehaviorNodeData child)
        {
            child = null;
            if (!_children.TryGetValue(parentId, out List<FrameActionEnemyBehaviorNodeData> children) || children.Count != 1) return false;
            child = children[0];
            return true;
        }

        private static FrameActionEnemyBehaviorStatus TickWait(FrameActionEnemyBehaviorNodeData node, NodeRuntime state)
        {
            if (!state.started)
            {
                state.started = true;
                state.startedAt = Time.time;
            }
            return Time.time - state.startedAt >= Mathf.Max(0f, node.durationSeconds)
                ? FrameActionEnemyBehaviorStatus.Success
                : FrameActionEnemyBehaviorStatus.Running;
        }

        private NodeRuntime GetRuntime(string nodeId)
        {
            if (!_runtime.TryGetValue(nodeId, out NodeRuntime state))
            {
                state = new NodeRuntime();
                _runtime[nodeId] = state;
            }
            return state;
        }

        private void LogComboStarted(FrameActionEnemyBehaviorNodeData cooldownNode, FrameActionEnemyBehaviorNodeData child)
        {
            if (!logBehaviorDecisions) return;
            Debug.Log(
                $"[Frame Action AI] {name} 触发连招：{NodeLabel(child)} " +
                $"(连招节点 {child.id}，冷却 {Mathf.Max(0f, cooldownNode.durationSeconds):0.###} 秒)。",
                this);
        }

        private string ActionLabel(string actionId)
        {
            FrameActionData action = controller?.player?.FindAction(actionId);
            return action != null && !string.IsNullOrWhiteSpace(action.name)
                ? $"{action.name} [{actionId}]"
                : actionId;
        }

        private static string NodeLabel(FrameActionEnemyBehaviorNodeData node)
        {
            return node != null && !string.IsNullOrWhiteSpace(node.name) ? node.name : node?.id ?? "(无节点)";
        }

        private void ResetChildren(string parentId)
        {
            if (!_children.TryGetValue(parentId, out List<FrameActionEnemyBehaviorNodeData> children)) return;
            for (int i = 0; i < children.Count; i++) ResetNode(children[i].id, new HashSet<string>());
        }

        private void ResetNode(string nodeId, HashSet<string> visited)
        {
            if (!visited.Add(nodeId) || !_nodes.TryGetValue(nodeId, out FrameActionEnemyBehaviorNodeData node)) return;
            if (node.type == "customTask")
            {
                bool handled = motor != null && motor.ResetBuiltinTask(node.taskKey ?? string.Empty);
                if (!handled && _adapter != null) _adapter.ResetTask(node.taskKey ?? string.Empty);
            }
            if (_runtime.TryGetValue(nodeId, out NodeRuntime state))
            {
                state.started = false;
                state.actionExecutionId = 0;
                state.cooldownStarted = false;
                state.childIndex = 0;
                state.startedAt = 0f;
                state.randomOrder = null;
            }
            if (_children.TryGetValue(nodeId, out List<FrameActionEnemyBehaviorNodeData> children))
            {
                for (int i = 0; i < children.Count; i++) ResetNode(children[i].id, visited);
            }
        }

        private void ResolveAdapter()
        {
            _adapter = adapterBehaviour as IFrameActionEnemyBehaviorAdapter;
            if (_adapter != null) return;
            MonoBehaviour[] behaviours = GetComponents<MonoBehaviour>();
            for (int i = 0; i < behaviours.Length; i++)
            {
                if (behaviours[i] is IFrameActionEnemyBehaviorAdapter adapter)
                {
                    _adapter = adapter;
                    adapterBehaviour = behaviours[i];
                    return;
                }
            }
        }
    }
}
