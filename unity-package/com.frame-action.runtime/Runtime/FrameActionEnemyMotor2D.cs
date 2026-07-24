using System;
using UnityEngine;

namespace FrameAction
{
    public enum FrameActionEnemyMovementMode
    {
        Stop,
        Patrol,
        Chase,
    }

    /// <summary>
    /// Built-in one-dimensional enemy locomotion for side-scrollers. It patrols,
    /// chases, turns at walls/ledges, and deliberately has no jumping or pathfinding.
    /// </summary>
    [DisallowMultipleComponent]
    [RequireComponent(typeof(Rigidbody2D))]
    public sealed class FrameActionEnemyMotor2D : MonoBehaviour, IFrameActionTargetProvider
    {
        public FrameActionEnemyController2D controller;
        public Rigidbody2D body;
        public Collider2D bodyCollider;
        [Tooltip("Optional explicit target. When empty, the motor finds the configured tag, then falls back to a FrameActionController2D player.")]
        public Transform target;
        public LayerMask fallbackEnvironmentLayers = ~0;

        public FrameActionEnemyMovementMode MovementMode { get; private set; } = FrameActionEnemyMovementMode.Stop;
        public bool IsGrounded { get; private set; }
        public bool IsBlocked { get; private set; }
        public bool HasTarget => target != null;
        public int EnvironmentLayerMask => EnvironmentMask(Settings);
        public float TargetDistance => target == null ? float.PositiveInfinity : Vector2.Distance(body != null ? body.position : (Vector2)transform.position, target.position);
        public float TargetHorizontalDistance => target == null ? float.PositiveInfinity : Mathf.Abs(target.position.x - (body != null ? body.position.x : transform.position.x));

        private readonly RaycastHit2D[] _castHits = new RaycastHit2D[12];
        private float _patrolOriginX;
        private int _patrolDirection = 1;
        private float _nextTurnTime;
        private float _nextTargetSearchTime;
        private float _blockedSince = -1f;
        private string _activeSkillId = string.Empty;
        private bool _hasPreviousFootPosition;
        private float _previousFootY;
        private float _nextGroundCrossingWarningTime;

        private FrameActionEnemyMovementSettings Settings
        {
            get
            {
                FrameActionEnemyMovementSettings settings = controller?.player?.Project?.enemyBehavior?.movement;
                return settings ?? new FrameActionEnemyMovementSettings();
            }
        }

        private void Awake()
        {
            if (controller == null) controller = GetComponent<FrameActionEnemyController2D>();
            if (body == null) body = GetComponent<Rigidbody2D>();
            if (bodyCollider == null) bodyCollider = GetComponent<Collider2D>();
        }

        private void OnEnable()
        {
            _patrolOriginX = body != null ? body.position.x : transform.position.x;
            _patrolDirection = controller != null && controller.player != null && controller.player.facingLeft ? -1 : 1;
            _nextTargetSearchTime = 0f;
            _blockedSince = -1f;
            MovementMode = FrameActionEnemyMovementMode.Stop;
        }

        private void OnDisable()
        {
            SetHorizontalVelocity(0f, true);
            MovementMode = FrameActionEnemyMovementMode.Stop;
            _activeSkillId = string.Empty;
            _hasPreviousFootPosition = false;
        }

        private void FixedUpdate()
        {
            FrameActionEnemyMovementSettings settings = Settings;
            if (!settings.enabled || body == null || bodyCollider == null) return;

            RecoverCrossedGround(settings);
            body.gravityScale = Mathf.Max(0f, settings.gravityScale);
            RefreshTarget(settings);
            IsGrounded = DetectGrounded(settings);
            controller?.SetAirborne(!IsGrounded);

            if (FrameActionPhysicsMotion2D.IsActiveOn(body))
            {
                RecordFootPosition();
                return;
            }

            bool actionLocked = controller != null && controller.IsActionLocked;
            float desiredVelocity = actionLocked ? 0f : ResolveDesiredVelocity(settings);
            if (!actionLocked && controller != null && controller.MovementLocked) desiredVelocity = 0f;
            SetHorizontalVelocity(desiredVelocity, actionLocked);
            if (actionLocked)
            {
                RecordFootPosition();
                return;
            }
            UpdateFacing(desiredVelocity);
            UpdateLocomotionAnimation(desiredVelocity);
            RecordFootPosition();
        }

        private void RecoverCrossedGround(FrameActionEnemyMovementSettings settings)
        {
            if (bodyCollider == null || !bodyCollider.enabled)
            {
                _hasPreviousFootPosition = false;
                return;
            }

            Bounds bounds = bodyCollider.bounds;
            float currentFootY = bounds.min.y;
            if (!_hasPreviousFootPosition)
            {
                _previousFootY = currentFootY;
                _hasPreviousFootPosition = true;
                return;
            }

            Vector2 velocity = BodyVelocity;
            if (velocity.y > 0.05f || currentFootY >= _previousFootY - 0.001f) return;

            float skin = Mathf.Max(0.01f, Physics2D.defaultContactOffset);
            float originY = _previousFootY + Mathf.Max(0.08f, skin * 2f);
            float castDistance = originY - currentFootY + Mathf.Max(0.08f, settings.groundCheckDistance);
            if (castDistance <= 0f) return;

            ContactFilter2D filter = new ContactFilter2D
            {
                useTriggers = false,
                useLayerMask = true,
                layerMask = EnvironmentMask(settings),
            };
            int count = Physics2D.Raycast(new Vector2(bounds.center.x, originY), Vector2.down, filter, _castHits, castDistance);
            RaycastHit2D best = default;
            float bestSurfaceY = float.NegativeInfinity;
            for (int i = 0; i < count; i++)
            {
                RaycastHit2D hit = _castHits[i];
                Collider2D candidate = hit.collider;
                if (candidate == null || candidate.isTrigger || candidate.transform.root == transform.root || hit.normal.y <= 0.2f) continue;
                if (candidate.GetComponentInParent<FrameActionPlayer>() != null) continue;
                if (hit.point.y > _previousFootY + skin || hit.point.y <= currentFootY + skin) continue;
                if (hit.point.y <= bestSurfaceY) continue;
                best = hit;
                bestSurfaceY = hit.point.y;
            }
            if (float.IsNegativeInfinity(bestSurfaceY))
            {
                if (_previousFootY - currentFootY > 0.02f && Time.unscaledTime >= _nextGroundCrossingWarningTime)
                {
                    _nextGroundCrossingWarningTime = Time.unscaledTime + 0.5f;
                    Debug.LogWarning($"[Frame Action] Ground sweep found no surface under {name}: bodySimulated={body.simulated}, colliderEnabled={bodyCollider.enabled}, bodyLayer={gameObject.layer}, environmentMask=0x{EnvironmentMask(settings):X8}, previousFootY={_previousFootY:F3}, currentFootY={currentFootY:F3}, position={body.position}.", this);
                }
                return;
            }

            float correction = bestSurfaceY + skin - currentFootY;
            if (correction <= 0f) return;
            body.position += Vector2.up * correction;
            Rigidbody2D groundBody = best.rigidbody;
            Vector2 surfaceVelocity = groundBody != null ? groundBody.GetPointVelocity(best.point) : Vector2.zero;
            velocity = BodyVelocity;
            velocity.y = Mathf.Max(velocity.y, surfaceVelocity.y);
            BodyVelocity = velocity;
            body.WakeUp();

            if (Time.unscaledTime >= _nextGroundCrossingWarningTime)
            {
                _nextGroundCrossingWarningTime = Time.unscaledTime + 0.5f;
                Debug.LogWarning($"[Frame Action] Prevented {name} from crossing ground collider '{best.collider.name}' between physics steps.", this);
            }
        }

        private void RecordFootPosition()
        {
            if (bodyCollider == null || !bodyCollider.enabled)
            {
                _hasPreviousFootPosition = false;
                return;
            }
            _previousFootY = bodyCollider.bounds.min.y;
            _hasPreviousFootPosition = true;
        }

        public void RequestPatrol()
        {
            if (controller != null && controller.IsActionLocked) { HaltImmediately(); return; }
            MovementMode = FrameActionEnemyMovementMode.Patrol;
        }

        public bool RequestChase()
        {
            if (controller != null && controller.IsActionLocked) { HaltImmediately(); return false; }
            RefreshTarget(Settings);
            if (!HasTarget) return false;
            MovementMode = FrameActionEnemyMovementMode.Chase;
            return true;
        }

        public void RequestStop()
        {
            MovementMode = FrameActionEnemyMovementMode.Stop;
            IsBlocked = false;
            _blockedSince = -1f;
        }

        public void HaltImmediately()
        {
            RequestStop();
            SetHorizontalVelocity(0f, true);
        }

        public void SetPatrolOrigin(float worldX)
        {
            _patrolOriginX = worldX;
        }

        public void ForgetTarget(float reacquireDelay = 0.25f)
        {
            target = null;
            _nextTargetSearchTime = Time.time + Mathf.Max(0f, reacquireDelay);
        }

        public Transform ResolveFrameActionTarget()
        {
            RefreshTarget(Settings);
            return target;
        }

        public bool TryEvaluateCondition(string key, string comparison, float numberValue, string stringValue, out bool result)
        {
            RefreshTarget(Settings);
            float value;
            switch (key)
            {
                case "hasTarget":
                    value = HasTarget ? 1f : 0f;
                    break;
                case "canUseAnySkill":
                    value = HasTarget && controller?.FindBestUsableSkill(TargetHorizontalDistance) != null ? 1f : 0f;
                    break;
                case "targetDistance":
                    value = TargetDistance;
                    break;
                case "targetHorizontalDistance":
                case "targetInRange":
                    value = TargetHorizontalDistance;
                    break;
                case "targetVisible":
                    value = HasTarget && HasClearLineToTarget(Settings) ? 1f : 0f;
                    break;
                case "grounded":
                    value = IsGrounded ? 1f : 0f;
                    break;
                case "blocked":
                    value = IsBlocked ? 1f : 0f;
                    break;
                default:
                    result = false;
                    return false;
            }
            result = Compare(value, comparison, numberValue);
            return true;
        }

        public bool TryExecuteTask(string key, float numberValue, string stringValue, out FrameActionEnemyBehaviorStatus status)
        {
            if (controller != null && controller.IsActionLocked)
            {
                HaltImmediately();
                status = FrameActionEnemyBehaviorStatus.Failure;
                return key == "patrol" || key == "chase" || key == "moveToTarget" || key == "stop" || key == "faceTarget" || key == "turnAround" || key == "useBestSkill";
            }
            switch (key)
            {
                case "patrol":
                    RequestPatrol();
                    status = FrameActionEnemyBehaviorStatus.Success;
                    return true;
                case "chase":
                case "moveToTarget":
                    status = RequestChase() ? FrameActionEnemyBehaviorStatus.Success : FrameActionEnemyBehaviorStatus.Failure;
                    return true;
                case "stop":
                    RequestStop();
                    status = FrameActionEnemyBehaviorStatus.Success;
                    return true;
                case "faceTarget":
                    status = FaceTarget() ? FrameActionEnemyBehaviorStatus.Success : FrameActionEnemyBehaviorStatus.Failure;
                    return true;
                case "turnAround":
                    RequestStop();
                    bool facingLeftBeforeTurn = controller?.player != null && controller.player.facingLeft;
                    status = controller != null && controller.TurnAround() ? FrameActionEnemyBehaviorStatus.Success : FrameActionEnemyBehaviorStatus.Failure;
                    Debug.Log(
                        $"[Frame Action AI] {name} 执行转向：{(status == FrameActionEnemyBehaviorStatus.Success ? "成功" : "失败")}，" +
                        $"朝向 {(facingLeftBeforeTurn ? "左" : "右")} -> " +
                        $"{(controller?.player != null && controller.player.facingLeft ? "左" : "右")}，" +
                        $"当前动作={controller?.CurrentActionId ?? "(无)"}，朝向锁定={controller != null && controller.FacingLocked}。",
                        this);
                    return true;
                case "useBestSkill":
                    status = TickBestSkill();
                    return true;
                default:
                    status = FrameActionEnemyBehaviorStatus.Failure;
                    return false;
            }
        }

        public bool ResetBuiltinTask(string key)
        {
            if (key == "useBestSkill")
            {
                if (string.IsNullOrEmpty(_activeSkillId) || controller == null || !controller.IsPlayingAction(_activeSkillId)) _activeSkillId = string.Empty;
                return true;
            }
            return key == "patrol" || key == "chase" || key == "moveToTarget" || key == "stop" || key == "faceTarget" || key == "turnAround";
        }

        private FrameActionEnemyBehaviorStatus TickBestSkill()
        {
            if (controller == null || !HasTarget) return FrameActionEnemyBehaviorStatus.Failure;
            RequestStop();
            if (!string.IsNullOrEmpty(_activeSkillId))
            {
                if (controller.IsPlayingAction(_activeSkillId)) return FrameActionEnemyBehaviorStatus.Running;
                _activeSkillId = string.Empty;
                return FrameActionEnemyBehaviorStatus.Success;
            }

            FrameActionData skill = controller.FindBestUsableSkill(TargetHorizontalDistance);
            if (skill == null) return FrameActionEnemyBehaviorStatus.Failure;
            FaceTarget();
            if (!controller.TryPlaySkill(skill.id, TargetHorizontalDistance)) return FrameActionEnemyBehaviorStatus.Failure;
            _activeSkillId = skill.id;
            Debug.Log(
                $"[Frame Action AI] {name} 选择并释放技能：{skill.name} [{skill.id}]，" +
                $"目标水平距离 {TargetHorizontalDistance:0.###}，技能冷却 {Mathf.Max(0f, skill.enemySkill?.cooldownSeconds ?? 0f):0.###} 秒。",
                this);
            return FrameActionEnemyBehaviorStatus.Running;
        }

        private float ResolveDesiredVelocity(FrameActionEnemyMovementSettings settings)
        {
            IsBlocked = false;
            if (MovementMode == FrameActionEnemyMovementMode.Stop) return 0f;
            if (MovementMode == FrameActionEnemyMovementMode.Chase)
            {
                if (!HasTarget)
                {
                    MovementMode = FrameActionEnemyMovementMode.Patrol;
                    return ResolvePatrolVelocity(settings);
                }
                float deltaX = target.position.x - body.position.x;
                if (Mathf.Abs(deltaX) <= Mathf.Max(0f, settings.stopDistance))
                {
                    _blockedSince = -1f;
                    return 0f;
                }
                int direction = deltaX < 0f ? -1 : 1;
                if (HasWall(direction, settings) || HasLedge(direction, settings))
                {
                    IsBlocked = true;
                    if (_blockedSince < 0f) _blockedSince = Time.time;
                    if (Time.time - _blockedSince >= Mathf.Max(0f, settings.blockedWaitSeconds))
                    {
                        ForgetTarget(Mathf.Max(1f, settings.blockedWaitSeconds));
                        MovementMode = FrameActionEnemyMovementMode.Patrol;
                        TurnPatrol(-direction, settings);
                    }
                    return 0f;
                }
                _blockedSince = -1f;
                return direction * Mathf.Max(0f, settings.chaseSpeed);
            }
            return ResolvePatrolVelocity(settings);
        }

        private float ResolvePatrolVelocity(FrameActionEnemyMovementSettings settings)
        {
            _blockedSince = -1f;
            float distance = Mathf.Max(0f, settings.patrolDistance);
            if (distance <= 0f || settings.patrolSpeed <= 0f) return 0f;
            if (body.position.x >= _patrolOriginX + distance) TurnPatrol(-1, settings);
            else if (body.position.x <= _patrolOriginX - distance) TurnPatrol(1, settings);
            if (HasWall(_patrolDirection, settings) || HasLedge(_patrolDirection, settings))
            {
                IsBlocked = true;
                TurnPatrol(-_patrolDirection, settings);
            }
            return _patrolDirection * Mathf.Max(0f, settings.patrolSpeed);
        }

        private void TurnPatrol(int direction, FrameActionEnemyMovementSettings settings)
        {
            if (Time.time < _nextTurnTime) return;
            _patrolDirection = direction < 0 ? -1 : 1;
            _nextTurnTime = Time.time + Mathf.Max(0f, settings.turnCooldownSeconds);
        }

        private bool FaceTarget()
        {
            if (!HasTarget || controller == null || controller.FacingLocked) return false;
            controller.SetFacingLeft(target.position.x < transform.position.x);
            return true;
        }

        private void UpdateFacing(float desiredVelocity)
        {
            if (controller == null || controller.FacingLocked || Mathf.Abs(desiredVelocity) < 0.001f) return;
            controller.SetFacingLeft(desiredVelocity < 0f);
        }

        private void UpdateLocomotionAnimation(float desiredVelocity)
        {
            if (controller == null) return;
            string type = controller.CurrentActionType;
            bool locomotionAction = string.IsNullOrEmpty(type) || type == "idleGround" || type == "idleAir" || type == "move";
            if (!locomotionAction && controller.IsPlaying) return;
            if (!IsGrounded)
            {
                if (type != "idleAir") controller.PlayFirstActionOfType("idleAir");
            }
            else if (Mathf.Abs(desiredVelocity) > 0.01f)
            {
                if (type != "move") controller.PlayFirstActionOfType("move");
            }
            else if (type != "idleGround")
            {
                controller.PlayFirstActionOfType("idleGround");
            }
        }

        private void SetHorizontalVelocity(float desired, bool immediate)
        {
            if (body == null) return;
            Vector2 velocity = BodyVelocity;
            float acceleration = Mathf.Max(0.01f, Settings.acceleration);
            velocity.x = immediate ? desired : Mathf.MoveTowards(velocity.x, desired, acceleration * Time.fixedDeltaTime);
            velocity.y = Mathf.Max(velocity.y, -Mathf.Max(0.01f, Settings.maxFallSpeed));
            BodyVelocity = velocity;
        }

        private bool DetectGrounded(FrameActionEnemyMovementSettings settings)
        {
            ContactFilter2D filter = EnvironmentFilter(settings);
            int count = bodyCollider.Cast(Vector2.down, filter, _castHits, Mathf.Max(0.001f, settings.groundCheckDistance));
            for (int i = 0; i < count; i++)
            {
                RaycastHit2D hit = _castHits[i];
                if (hit.collider != null && hit.collider.transform.root != transform.root && hit.normal.y > 0.25f) return true;
            }
            return false;
        }

        private bool HasWall(int direction, FrameActionEnemyMovementSettings settings)
        {
            ContactFilter2D filter = CollisionFilter();
            int count = bodyCollider.Cast(Vector2.right * direction, filter, _castHits, Mathf.Max(0.001f, settings.wallCheckDistance));
            for (int i = 0; i < count; i++)
            {
                RaycastHit2D hit = _castHits[i];
                if (hit.collider == null || hit.collider.transform.root == transform.root) continue;
                if (Mathf.Abs(hit.normal.x) > 0.35f && hit.normal.x * direction < 0f) return true;
            }
            return false;
        }

        private bool HasLedge(int direction, FrameActionEnemyMovementSettings settings)
        {
            if (!IsGrounded) return false;
            Bounds bounds = bodyCollider.bounds;
            Vector2 origin = new Vector2(
                bounds.center.x + direction * (bounds.extents.x + Mathf.Max(0f, settings.ledgeCheckForwardDistance)),
                bounds.min.y + Mathf.Min(0.05f, bounds.extents.y * 0.25f));
            int mask = EnvironmentMask(settings);
            RaycastHit2D hit = Physics2D.Raycast(origin, Vector2.down, Mathf.Max(0.001f, settings.ledgeCheckDownDistance), mask);
            return hit.collider == null || hit.collider.transform.root == transform.root;
        }

        private bool HasClearLineToTarget(FrameActionEnemyMovementSettings settings)
        {
            if (!HasTarget) return false;
            Vector2 origin = bodyCollider != null ? bodyCollider.bounds.center : transform.position;
            Vector2 delta = (Vector2)target.position - origin;
            if (delta.sqrMagnitude <= 0.0001f) return true;
            RaycastHit2D hit = Physics2D.Raycast(origin, delta.normalized, delta.magnitude, EnvironmentMask(settings));
            return hit.collider == null || hit.collider.transform.root == target.root;
        }

        private ContactFilter2D EnvironmentFilter(FrameActionEnemyMovementSettings settings)
        {
            return new ContactFilter2D
            {
                useTriggers = false,
                useLayerMask = true,
                layerMask = EnvironmentMask(settings),
            };
        }

        private int EnvironmentMask(FrameActionEnemyMovementSettings settings)
        {
            string[] names = string.IsNullOrWhiteSpace(settings.environmentLayerName)
                ? Array.Empty<string>()
                : settings.environmentLayerName.Split(new[] { ',', ';', '|', '，' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < names.Length; i++) names[i] = names[i].Trim();
            int mask = names.Length == 0 ? 0 : LayerMask.GetMask(names);
            return mask == 0 ? fallbackEnvironmentLayers.value : mask;
        }

        private ContactFilter2D CollisionFilter()
        {
            int mask = Physics2D.GetLayerCollisionMask(gameObject.layer);
            if (mask == 0) mask = ~0;
            return new ContactFilter2D
            {
                useTriggers = false,
                useLayerMask = true,
                layerMask = mask,
            };
        }

        private void RefreshTarget(FrameActionEnemyMovementSettings settings)
        {
            if (target != null)
            {
                Vector2 delta = target.position - transform.position;
                if (!target.gameObject.activeInHierarchy || Mathf.Abs(delta.y) > Mathf.Max(0f, settings.verticalTolerance) || delta.magnitude > Mathf.Max(settings.detectionRange, settings.loseTargetRange))
                {
                    target = null;
                }
            }
            if (target != null || Time.time < _nextTargetSearchTime) return;
            _nextTargetSearchTime = Time.time + 0.25f;

            Transform best = null;
            float bestDistance = Mathf.Max(0f, settings.detectionRange);
            if (!string.IsNullOrWhiteSpace(settings.targetTag))
            {
                try
                {
                    GameObject[] tagged = GameObject.FindGameObjectsWithTag(settings.targetTag);
                    for (int i = 0; i < tagged.Length; i++) ConsiderTarget(tagged[i] != null ? tagged[i].transform : null, settings, ref best, ref bestDistance);
                }
                catch (UnityException)
                {
                    // Missing custom tags are allowed; the standard player component fallback still works.
                }
            }
            if (best == null)
            {
                FrameActionController2D[] players = FindObjectsOfType<FrameActionController2D>();
                for (int i = 0; i < players.Length; i++) ConsiderTarget(players[i] != null ? players[i].transform : null, settings, ref best, ref bestDistance);
            }
            target = best;
        }

        private void ConsiderTarget(Transform candidate, FrameActionEnemyMovementSettings settings, ref Transform best, ref float bestDistance)
        {
            if (candidate == null || candidate.root == transform.root || !candidate.gameObject.activeInHierarchy) return;
            Vector2 delta = candidate.position - transform.position;
            if (Mathf.Abs(delta.y) > Mathf.Max(0f, settings.verticalTolerance)) return;
            float distance = delta.magnitude;
            if (distance > bestDistance) return;
            best = candidate;
            bestDistance = distance;
        }

        private static bool Compare(float value, string comparison, float expected)
        {
            switch (comparison)
            {
                case "isFalse": return value <= 0f;
                case "less": return value < expected;
                case "lessOrEqual": return value <= expected;
                case "greater": return value > expected;
                case "greaterOrEqual": return value >= expected;
                case "equal": return Mathf.Approximately(value, expected);
                default: return value > 0f;
            }
        }

        private Vector2 BodyVelocity
        {
#if UNITY_6000_0_OR_NEWER
            get => body.linearVelocity;
            set => body.linearVelocity = value;
#else
            get => body.velocity;
            set => body.velocity = value;
#endif
        }

#if UNITY_EDITOR
        private void OnDrawGizmosSelected()
        {
            FrameActionEnemyMovementSettings settings = Settings;
            Gizmos.color = new Color(1f, 0.75f, 0.15f, 0.6f);
            Gizmos.DrawWireSphere(transform.position, Mathf.Max(0f, settings.detectionRange));
            Gizmos.color = new Color(0.25f, 0.8f, 1f, 0.7f);
            Gizmos.DrawLine(new Vector3(_patrolOriginX - settings.patrolDistance, transform.position.y), new Vector3(_patrolOriginX + settings.patrolDistance, transform.position.y));
        }
#endif
    }
}
