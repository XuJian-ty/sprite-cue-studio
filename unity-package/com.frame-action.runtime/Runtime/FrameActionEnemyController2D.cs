using System;
using System.Collections.Generic;
using UnityEngine;

namespace FrameAction
{
    /// <summary>
    /// Thin behavior-tree bridge for enemies. It deliberately has no input polling,
    /// locomotion motor, camera ownership, buffering, or transition policy.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class FrameActionEnemyController2D : MonoBehaviour, IFrameActionDamageReceiver, IFrameActionStatusReceiver
    {
        public FrameActionPlayer player;
        public bool playGroundIdleOnEnable = true;
        public bool returnToIdleOnComplete;
        public bool airborne;

        public string CurrentActionId => player != null ? player.CurrentActionId : string.Empty;
        public string CurrentActionType => player?.CurrentAction?.type ?? string.Empty;
        public bool IsPlaying => player != null && player.IsPlaying;
        public bool IsStunned => Time.time < _stunnedUntil;
        public bool HasSuperArmor => Time.time < _superArmorUntil;
        public bool IsInvincible => Time.time < _invincibleUntil;
        public bool IsHurtLocked => IsPlaying && CurrentActionType == "hurt";
        public bool IsActionLocked => IsStunned || IsHurtLocked;
        public bool MovementLocked
        {
            get
            {
                if (IsActionLocked) return true;
                FrameActionData action = player?.CurrentAction;
                if (!IsPlaying || action == null) return false;
                return action.type == "skill" && (action.enemySkill?.lockMovement ?? true);
            }
        }
        public bool FacingLocked => IsActionLocked || IsPlaying && player?.CurrentAction?.type == "skill" && (player.CurrentAction.enemySkill?.lockFacing ?? true);

        public event Action<FrameActionData> ActionStarted;
        public event Action<FrameActionData> ActionCompleted;
        public event Action<FrameActionDamageContext> DamageReceived;
        public event Action<string, float, FrameActionPlayer> StatusApplied;
        public event Action<bool> ActionLockChanged;

        private readonly Dictionary<string, float> _nextSkillUseTime = new Dictionary<string, float>(StringComparer.Ordinal);
        private float _stunnedUntil;
        private float _superArmorUntil;
        private float _invincibleUntil;
        private bool _lastActionLocked;

        private void Awake()
        {
            if (player == null) player = GetComponent<FrameActionPlayer>();
            FrameActionEnemyRenderOrder2D renderOrder = GetComponent<FrameActionEnemyRenderOrder2D>();
            if (renderOrder == null) renderOrder = gameObject.AddComponent<FrameActionEnemyRenderOrder2D>();
            if (renderOrder.targetRenderer == null) renderOrder.targetRenderer = player != null ? player.spriteRenderer : GetComponentInChildren<SpriteRenderer>(true);
            if (renderOrder.bodyCollider == null) renderOrder.bodyCollider = GetComponent<Collider2D>();
            FrameActionBuiltinEventHandler2D eventHandler = GetComponent<FrameActionBuiltinEventHandler2D>();
            if (eventHandler != null) eventHandler.vfxSortingOrder = 11;
        }

        private void OnEnable()
        {
            if (player == null) return;
            player.ActionStarted += HandleActionStarted;
            player.ActionCompleted += HandleActionCompleted;
            if (playGroundIdleOnEnable) PlayIdle();
            _lastActionLocked = IsActionLocked;
        }

        private void OnDisable()
        {
            if (player == null) return;
            player.ActionStarted -= HandleActionStarted;
            player.ActionCompleted -= HandleActionCompleted;
        }

        private void Update()
        {
            RefreshActionLock();
        }

        public bool PlayAction(string actionId, bool restart = false)
        {
            FrameActionData action = player?.FindAction(actionId);
            if (action == null) return false;
            if (IsHurtLocked && action.type != "hurt") return false;
            if (IsStunned && action.type != "hurt" && action.type != "idleGround" && action.type != "idleAir") return false;
            if (!restart && player != null && player.IsPlaying && string.Equals(player.CurrentActionId, actionId, StringComparison.Ordinal)) return true;
            return player.Play(actionId);
        }

        public bool PlayBehaviorAction(string actionId, float targetDistance, bool restart = false, bool ignoreSkillCooldown = false)
        {
            FrameActionData action = player?.FindAction(actionId);
            if (action == null) return false;
            return action.type == "skill"
                ? ignoreSkillCooldown ? PlayAction(actionId, restart) : TryPlaySkill(actionId, targetDistance, restart)
                : PlayAction(actionId, restart);
        }

        public bool CanUseSkill(string actionId, float targetDistance)
        {
            if (IsActionLocked) return false;
            FrameActionData action = player?.FindAction(actionId);
            if (action == null || action.type != "skill" || action.loop) return false;
            if (!HasAuthoredTimeline(action)) return false;
            if (IsPlaying && (CurrentActionType == "skill" || CurrentActionType == "hurt")) return IsPlayingAction(actionId);
            FrameActionEnemySkillSettings settings = action.enemySkill ?? new FrameActionEnemySkillSettings();
            if (targetDistance < Mathf.Max(0f, settings.minRange) || targetDistance > Mathf.Max(settings.minRange, settings.maxRange)) return false;
            return !_nextSkillUseTime.TryGetValue(actionId, out float nextTime) || Time.time >= nextTime;
        }

        private static bool HasAuthoredTimeline(FrameActionData action)
        {
            if (action?.segments == null) return false;
            for (int segmentIndex = 0; segmentIndex < action.segments.Count; segmentIndex++)
            {
                FrameActionSegmentData segment = action.segments[segmentIndex];
                if (segment == null) continue;
                if (segment.frames != null && segment.frames.Count > 0) return true;
                if (segment.tracks == null) continue;
                for (int trackIndex = 0; trackIndex < segment.tracks.Count; trackIndex++)
                {
                    if (segment.tracks[trackIndex]?.events != null && segment.tracks[trackIndex].events.Count > 0) return true;
                }
            }
            return false;
        }

        public FrameActionData FindBestUsableSkill(float targetDistance)
        {
            List<FrameActionData> actions = player?.Project?.actions;
            FrameActionData best = null;
            float bestWeight = float.NegativeInfinity;
            if (actions == null) return null;
            for (int i = 0; i < actions.Count; i++)
            {
                FrameActionData candidate = actions[i];
                if (candidate == null || !CanUseSkill(candidate.id, targetDistance)) continue;
                float weight = Mathf.Max(0.01f, candidate.enemySkill?.selectionWeight ?? 1f);
                if (best == null || weight > bestWeight)
                {
                    best = candidate;
                    bestWeight = weight;
                }
            }
            return best;
        }

        public bool TryPlaySkill(string actionId, float targetDistance, bool restart = false)
        {
            if (!restart && IsPlayingAction(actionId)) return true;
            if (!CanUseSkill(actionId, targetDistance) || !PlayAction(actionId, restart)) return false;
            FrameActionData action = player.FindAction(actionId);
            float cooldown = Mathf.Max(0f, action?.enemySkill?.cooldownSeconds ?? 0f);
            _nextSkillUseTime[actionId] = Time.time + cooldown;
            return true;
        }

        public float GetSkillCooldownRemaining(string actionId)
        {
            return _nextSkillUseTime.TryGetValue(actionId, out float nextTime) ? Mathf.Max(0f, nextTime - Time.time) : 0f;
        }

        public bool PlayActionSegment(string actionId, string segmentId)
        {
            FrameActionData action = player?.FindAction(actionId);
            if (action == null || IsHurtLocked && action.type != "hurt") return false;
            if (IsStunned && action.type != "hurt" && action.type != "idleGround" && action.type != "idleAir") return false;
            return player.Play(actionId, segmentId);
        }

        public bool PlayFirstActionOfType(string actionType)
        {
            FrameActionData action = player?.FindFirstActionByType(actionType);
            return action != null && PlayAction(action.id, action.type == "hurt");
        }

        public bool PlayIdle()
        {
            if (player?.Project == null) return false;
            string actionId = airborne ? player.Project.airIdleId : player.Project.groundIdleId;
            return PlayAction(actionId);
        }

        public void SetAirborne(bool value, bool playIdleImmediately = false)
        {
            airborne = value;
            if (playIdleImmediately && !IsActionLocked) PlayIdle();
        }

        public void SetFacingLeft(bool value)
        {
            if (player == null || IsActionLocked) return;
            player.SetFacingLeft(value);
        }

        public bool TurnAround()
        {
            if (player == null || FacingLocked) return false;
            SetFacingLeft(!player.facingLeft);
            return true;
        }

        public bool IsPlayingAction(string actionId)
        {
            return IsPlaying && string.Equals(CurrentActionId, actionId, StringComparison.Ordinal);
        }

        public void ReceiveFrameActionDamage(FrameActionDamageContext context)
        {
            if (IsInvincible) return;
            DamageReceived?.Invoke(context);
            if (!HasSuperArmor) PlayFirstActionOfType("hurt");
            RefreshActionLock();
        }

        public void ApplyFrameActionStatus(string statusId, float durationSeconds, FrameActionPlayer source)
        {
            float duration = Mathf.Max(0f, durationSeconds);
            float until = Time.time + duration;
            switch (statusId)
            {
                case "stun":
                    _stunnedUntil = Mathf.Max(_stunnedUntil, until);
                    if (!IsHurtLocked) PlayIdle();
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
            RefreshActionLock();
        }

        public void Pause() => player?.Pause();
        public void Resume() => player?.Resume();

        private void HandleActionStarted(FrameActionData action)
        {
            ActionStarted?.Invoke(action);
            RefreshActionLock();
        }

        private void HandleActionCompleted(FrameActionData action)
        {
            ActionCompleted?.Invoke(action);
            if (action != null && action.type == "hurt" && IsStunned) PlayIdle();
            else if (returnToIdleOnComplete && action != null && !action.loop) PlayIdle();
            RefreshActionLock();
        }

        private void RefreshActionLock()
        {
            bool locked = IsActionLocked;
            if (locked == _lastActionLocked) return;
            _lastActionLocked = locked;
            ActionLockChanged?.Invoke(locked);
        }
    }
}
