using System;
using UnityEngine;

namespace FrameAction
{
    [RequireComponent(typeof(FrameActionPlayer))]
    public sealed class FrameActionController2D : MonoBehaviour, IFrameActionDamageReceiver, IFrameActionStatusReceiver
    {
        public FrameActionPlayer player;
        public bool grounded = true;
        public bool playIdleOnEnable = true;
        public bool autoPlayDamageReaction = true;

        public event Action<FrameActionData, int> ActionStarted;
        public event Action<FrameActionDamageContext> DamageReceived;
        public event Action<string, float, FrameActionPlayer> StatusApplied;

        public bool IsStunned => Time.time < _stunnedUntil;
        public bool HasSuperArmor => Time.time < _superArmorUntil;
        public bool IsInvincible => Time.time < _invincibleUntil;
        public bool IsLocomotionInputLocked
        {
            get
            {
                FrameActionData action = player?.CurrentAction;
                return player != null && player.IsPlaying && action != null && action.type == "attack";
            }
        }
        public FrameActionStateMachine2D StateMachine => EnsureStateMachine();
        public FrameActionRuntimeState CurrentState => _stateMachine?.CurrentState;
        public FrameActionRuntimeState PreviousState => _stateMachine?.PreviousState;

        private FrameActionStateMachine2D _stateMachine;
        private int _segmentIndex;
        private FrameActionData _lastCompletedAttack;
        private int _lastCompletedAttackSegmentIndex;
        private float _lastAttackCompletionTime = float.NegativeInfinity;
        private float _moveAxis;
        private bool _runRequested;
        private float _stunnedUntil;
        private float _superArmorUntil;
        private float _invincibleUntil;
        private bool _wasStunned;

        private void Awake()
        {
            if (player == null) player = GetComponent<FrameActionPlayer>();
            EnsureStateMachine();
        }

        private void OnEnable()
        {
            if (player == null) return;
            EnsureStateMachine();
            player.ActionStarted += HandlePlayerActionStarted;
            player.ActionCompleted += HandleActionCompleted;
            if (player.IsPlaying && player.CurrentAction != null)
            {
                _stateMachine.Synchronize(player.CurrentAction, ResolveCurrentSegmentIndex());
            }
            if (playIdleOnEnable && !player.IsPlaying) PlayIdle();
        }

        private void OnDisable()
        {
            if (player == null) return;
            player.ActionStarted -= HandlePlayerActionStarted;
            player.ActionCompleted -= HandleActionCompleted;
        }

        private void Update()
        {
            bool stunned = IsStunned;
            if (_wasStunned && !stunned) PlayLocomotionOrIdle();
            _wasStunned = stunned;
        }

        public void SetGrounded(bool value)
        {
            if (grounded == value) return;
            grounded = value;
            FrameActionData current = player?.CurrentAction;
            if (current != null && IsLocomotionAction(current)) PlayLocomotionOrIdle();
        }

        public void SetLocomotionIntent(float moveAxis, bool runRequested)
        {
            float previousAxis = _moveAxis;
            bool previousRun = _runRequested;
            _moveAxis = Mathf.Clamp(moveAxis, -1f, 1f);
            _runRequested = runRequested && Mathf.Abs(_moveAxis) > 0.001f;
            if (Mathf.Abs(previousAxis - _moveAxis) < 0.001f && previousRun == _runRequested) return;

            FrameActionData current = player?.CurrentAction;
            if (current == null || IsLocomotionAction(current)) PlayLocomotionOrIdle();
        }

        public float GetLocomotionSpeed()
        {
            string triggerType = _runRequested ? "axisDoubleTap" : "axisTap";
            FrameActionData locomotion = FindFirstActionByTriggerType(triggerType);
            if (locomotion == null && _runRequested) locomotion = FindFirstActionByTriggerType("axisTap");
            return Mathf.Max(0f, locomotion?.movementSpeed ?? 0f);
        }

        public bool RequestByTrigger(string triggerType, string triggerCode)
        {
            FrameActionData action = player?.FindActionByTrigger(triggerType, triggerCode);
            return action != null && RequestAction(action.id);
        }

        public void ReceiveFrameActionDamage(FrameActionDamageContext context)
        {
            if (IsInvincible) return;
            DamageReceived?.Invoke(context);
            if (autoPlayDamageReaction && !HasSuperArmor) RequestDamageReaction();
        }

        public void ApplyFrameActionStatus(string statusId, float durationSeconds, FrameActionPlayer source)
        {
            float duration = Mathf.Max(0f, durationSeconds);
            float until = Time.time + duration;
            switch (statusId)
            {
                case "stun":
                    _stunnedUntil = Mathf.Max(_stunnedUntil, until);
                    _wasStunned = IsStunned;
                    _stateMachine?.ClearPending();
                    break;
                case "superArmor":
                    _superArmorUntil = Mathf.Max(_superArmorUntil, until);
                    break;
                case "invincible":
                    _invincibleUntil = Mathf.Max(_invincibleUntil, until);
                    break;
                default:
                    return;
            }
            StatusApplied?.Invoke(statusId, duration, source);
        }

        public void NotifyDamaged()
        {
            NotifyDamaged(1f, null, transform.position);
        }

        public void NotifyDamaged(float damageMultiplier)
        {
            NotifyDamaged(damageMultiplier, null, transform.position);
        }

        public void NotifyDamaged(float damageMultiplier, FrameActionPlayer source, Vector2 hitPoint)
        {
            ReceiveFrameActionDamage(new FrameActionDamageContext(source, Mathf.Max(0f, damageMultiplier), hitPoint));
        }

        public bool RequestDamageReaction()
        {
            FrameActionProjectData project = player?.Project;
            FrameActionData reaction = player?.FindActionByTrigger("damage", "Damage");
            if (reaction == null && project?.actions != null)
            {
                for (int i = 0; i < project.actions.Count; i++)
                {
                    FrameActionData candidate = project.actions[i];
                    if (candidate?.trigger != null && candidate.trigger.type == "damage")
                    {
                        reaction = candidate;
                        break;
                    }
                }
            }
            return reaction != null && RequestAction(reaction.id);
        }

        public bool RequestAction(string actionId)
        {
            if (IsStunned) return false;
            FrameActionData next = player?.FindAction(actionId);
            if (next == null) return false;

            FrameActionData current = _stateMachine?.CurrentState?.Action ?? player.CurrentAction;
            if (current == null) return EnsureStateMachine().ForceTransition(next, 0);
            if (current.id == next.id) return RequestActiveActionAgain(next);

            int segmentIndex = next.type == "attack" ? ResolveAttackSegmentAfterCompletion(next) : 0;
            return EnsureStateMachine().Request(next, segmentIndex);
        }

        public bool RequestActionSegment(string actionId, int segmentIndex)
        {
            if (IsStunned) return false;
            FrameActionData next = player?.FindAction(actionId);
            if (next?.segments == null || next.segments.Count == 0) return false;
            int resolvedIndex = Mathf.Clamp(segmentIndex, 0, next.segments.Count - 1);
            FrameActionData current = _stateMachine?.CurrentState?.Action ?? player.CurrentAction;
            if (current == null || current.id == next.id) return EnsureStateMachine().ForceTransition(next, resolvedIndex);
            return EnsureStateMachine().Request(next, resolvedIndex);
        }

        internal bool ForceMotorAction(string actionId)
        {
            if (IsStunned) return false;
            FrameActionData next = player?.FindAction(actionId);
            return next != null && EnsureStateMachine().ForceTransition(next, 0);
        }

        public void PlayIdle()
        {
            FrameActionProjectData project = player?.Project;
            if (project == null) return;
            string idleId = grounded ? project.groundIdleId : project.airIdleId;
            FrameActionData idle = player.FindAction(idleId);
            if (idle != null) EnsureStateMachine().ForceTransition(idle, 0);
        }

        private void PlayLocomotionOrIdle()
        {
            if (IsStunned || !grounded || Mathf.Abs(_moveAxis) <= 0.001f)
            {
                PlayIdle();
                return;
            }

            string triggerType = _runRequested ? "axisDoubleTap" : "axisTap";
            FrameActionData locomotion = FindFirstActionByTriggerType(triggerType);
            if (locomotion == null && _runRequested) locomotion = FindFirstActionByTriggerType("axisTap");
            if (locomotion == null)
            {
                PlayIdle();
                return;
            }
            if (player?.CurrentActionId != locomotion.id) EnsureStateMachine().ForceTransition(locomotion, 0);
        }

        private FrameActionData FindFirstActionByTriggerType(string triggerType)
        {
            FrameActionProjectData project = player?.Project;
            if (project?.actions == null) return null;
            for (int i = 0; i < project.actions.Count; i++)
            {
                FrameActionData action = project.actions[i];
                if (action?.type == "move" && action.trigger?.type == triggerType) return action;
            }
            return null;
        }

        private static bool IsLocomotionAction(FrameActionData action)
        {
            return action != null && (action.type == "idleGround" || action.type == "idleAir" || action.type == "move");
        }

        private bool RequestActiveActionAgain(FrameActionData action)
        {
            int count = Mathf.Max(1, action.segments?.Count ?? 0);
            if (action.type != "attack" || count <= 1) return EnsureStateMachine().Request(action, 0);

            int nextIndex = _segmentIndex < count - 1
                ? _segmentIndex + 1
                : action.allowLastRepeat ? _segmentIndex : 0;
            return EnsureStateMachine().Request(action, nextIndex);
        }

        private int ResolveAttackSegmentAfterCompletion(FrameActionData action)
        {
            int count = Mathf.Max(1, action?.segments?.Count ?? 0);
            if (action == null || count <= 1 || !ReferenceEquals(action, _lastCompletedAttack)) return 0;

            float elapsed = Time.unscaledTime - _lastAttackCompletionTime;
            if (elapsed < 0f) return 0;
            if (elapsed <= Mathf.Max(0.01f, action.comboWindow) && _lastCompletedAttackSegmentIndex < count - 1)
            {
                return _lastCompletedAttackSegmentIndex + 1;
            }
            if (elapsed <= Mathf.Max(action.comboWindow, action.repeatWindow)
                && (_lastCompletedAttackSegmentIndex < count - 1 || action.allowLastRepeat))
            {
                return Mathf.Clamp(_lastCompletedAttackSegmentIndex, 0, count - 1);
            }
            return 0;
        }

        private bool ExecuteState(FrameActionRuntimeState state)
        {
            if (state?.Action == null || state.Segment == null || player == null) return false;
            _segmentIndex = state.SegmentIndex;
            if (!player.Play(state.ActionId, state.SegmentId)) return false;
            return true;
        }

        private void HandleActionCompleted(FrameActionData completed)
        {
            if (completed?.type == "attack")
            {
                _lastCompletedAttack = completed;
                _lastCompletedAttackSegmentIndex = _segmentIndex;
                _lastAttackCompletionTime = Time.unscaledTime;
            }
            if (EnsureStateMachine().CompleteCurrent()) return;
            PlayLocomotionOrIdle();
        }

        private void HandlePlayerActionStarted(FrameActionData action)
        {
            int segmentIndex = ResolveCurrentSegmentIndex();
            FrameActionRuntimeState current = EnsureStateMachine().CurrentState;
            if (current != null && ReferenceEquals(current.Action, action) && current.SegmentIndex == segmentIndex) return;
            _stateMachine.Synchronize(action, segmentIndex);
            _segmentIndex = segmentIndex;
            ActionStarted?.Invoke(action, segmentIndex);
        }

        private FrameActionStateMachine2D EnsureStateMachine()
        {
            if (_stateMachine != null) return _stateMachine;
            _stateMachine = new FrameActionStateMachine2D(ExecuteState);
            _stateMachine.StateEntered += state => ActionStarted?.Invoke(state.Action, state.SegmentIndex);
            return _stateMachine;
        }

        private int ResolveCurrentSegmentIndex()
        {
            FrameActionData action = player?.CurrentAction;
            if (action?.segments == null || player.CurrentSegment == null) return 0;
            int index = action.segments.IndexOf(player.CurrentSegment);
            return index >= 0 ? index : 0;
        }
    }
}
