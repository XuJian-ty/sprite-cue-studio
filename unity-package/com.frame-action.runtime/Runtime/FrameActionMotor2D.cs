using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace FrameAction
{
    [DisallowMultipleComponent]
    [RequireComponent(typeof(Rigidbody2D))]
    public sealed class FrameActionMotor2D : MonoBehaviour
    {
        public FrameActionPlayer player;
        public FrameActionController2D controller;
        public Rigidbody2D body;
        public Collider2D bodyCollider;
        public LayerMask fallbackGroundLayers = ~0;

        public float MoveInput { get; private set; }
        public bool IsGrounded { get; private set; }
        public int GroundLayerMask
        {
            get
            {
                int configured = string.IsNullOrWhiteSpace(Settings?.groundLayerName) ? 0 : LayerMask.GetMask(Settings.groundLayerName);
                return configured != 0 ? configured : fallbackGroundLayers.value;
            }
        }

        private readonly RaycastHit2D[] _groundHits = new RaycastHit2D[8];
        private readonly Collider2D[] _nearbyGroundColliders = new Collider2D[32];
        private readonly List<Collider2D> _groundColliders = new List<Collider2D>();
        private readonly Dictionary<Collider2D, float> _groundSurfaceY = new Dictionary<Collider2D, float>();
        private readonly List<Collider2D> _ignoredDropColliders = new List<Collider2D>();
        private readonly List<Collider2D> _sideIgnoredOneWayColliders = new List<Collider2D>();
        private readonly List<Collider2D> _nextSideIgnoredOneWayColliders = new List<Collider2D>();
        private FrameActionData _queuedJumpAction;
        private float _jumpBufferTimer;
        private float _coyoteTimer;
        private int _jumpsUsed;
        private bool _warnedMissingCollider;
        private float _appliedMovementMultiplier = 1f;
        private float _externalMovementMultiplier = 1f;
        private Vector2 _velocityBeforeMovementPause;
        private Vector2 _groundPointVelocity;
        private Vector2 _groundNormal = Vector2.up;
        private Coroutine _restoreDropCollisionRoutine;
        private float _dropClearanceSurfaceY = float.NegativeInfinity;
        private bool _hasPreviousFootPosition;
        private float _previousFootY;
        private float _nextGroundCrossingWarningTime;

        private void Awake()
        {
            if (player == null) player = GetComponent<FrameActionPlayer>();
            if (controller == null) controller = GetComponent<FrameActionController2D>();
            if (body == null) body = GetComponent<Rigidbody2D>();
            if (bodyCollider == null) bodyCollider = GetComponent<Collider2D>();
        }

        public void SetMoveInput(float value)
        {
            MoveInput = Mathf.Clamp(value, -1f, 1f);
        }

        public void SetExternalMovementMultiplier(float value)
        {
            _externalMovementMultiplier = Mathf.Max(0f, value);
            if (body != null) ApplyMovementMultiplierChange(ResolveMovementMultiplier());
        }

        public bool QueueJump(FrameActionData jumpAction)
        {
            if (jumpAction == null || controller != null && controller.IsStunned) return false;
            FrameActionMotorSettings settings = Settings;
            _queuedJumpAction = jumpAction;
            _jumpBufferTimer = Mathf.Max(Time.fixedDeltaTime, settings?.jumpBufferTime ?? 0f);
            return true;
        }

        public bool TryDropThrough(FrameActionData dropAction)
        {
            if (dropAction == null || bodyCollider == null || body == null || controller == null || controller.IsStunned || !IsGrounded) return false;
            if (_groundColliders.Count == 0) return false;

            List<Collider2D> dropColliders = new List<Collider2D>();
            float clearanceSurfaceY = float.PositiveInfinity;
            for (int i = 0; i < _groundColliders.Count; i++)
            {
                Collider2D candidate = _groundColliders[i];
                if (!IsOneWayPlatform(candidate)) return false;
                if (!dropColliders.Contains(candidate)) dropColliders.Add(candidate);
                if (_groundSurfaceY.TryGetValue(candidate, out float surfaceY)) clearanceSurfaceY = Mathf.Min(clearanceSurfaceY, surfaceY);
            }
            if (dropColliders.Count == 0 || !controller.ForceMotorAction(dropAction.id)) return false;

            RestoreDropCollisions();
            _dropClearanceSurfaceY = float.IsPositiveInfinity(clearanceSurfaceY) ? dropColliders[0].bounds.max.y : clearanceSurfaceY;
            for (int i = 0; i < dropColliders.Count; i++)
            {
                Collider2D platform = dropColliders[i];
                if (platform == null) continue;
                Physics2D.IgnoreCollision(bodyCollider, platform, true);
                _ignoredDropColliders.Add(platform);
            }

            _queuedJumpAction = null;
            _jumpBufferTimer = 0f;
            _coyoteTimer = 0f;
            _jumpsUsed = Mathf.Max(1, _jumpsUsed);
            Vector2 velocity = BodyVelocity;
            velocity.y = Mathf.Min(velocity.y, -2f);
            BodyVelocity = velocity;
            IsGrounded = false;
            controller.SetGrounded(false);
            _restoreDropCollisionRoutine = StartCoroutine(RestoreDropCollisionsAfterClearance());
            return true;
        }

        private void OnDisable()
        {
            RestoreDropCollisions();
            RestoreSidePassThroughCollisions();
            _hasPreviousFootPosition = false;
        }

        private void FixedUpdate()
        {
            FrameActionMotorSettings settings = Settings;
            if (settings == null || !settings.enableMotor || body == null) return;

            RecoverCrossedGround(settings);
            float movementMultiplier = ResolveMovementMultiplier();
            ApplyMovementMultiplierChange(movementMultiplier);
            body.gravityScale = Mathf.Max(0f, settings.gravityScale) * movementMultiplier;
            bool scriptedMotion = FrameActionPhysicsMotion2D.IsActiveOn(body);
            if (scriptedMotion) RestoreSidePassThroughCollisions();
            else UpdateOneWaySidePassThrough(settings);
            bool wasGrounded = IsGrounded;
            IsGrounded = DetectGrounded(settings);
            controller?.SetGrounded(IsGrounded);
            if (IsGrounded)
            {
                _coyoteTimer = Mathf.Max(0f, settings.coyoteTime);
                if (!wasGrounded) _jumpsUsed = 0;
            }
            else _coyoteTimer = Mathf.Max(0f, _coyoteTimer - Time.fixedDeltaTime);

            if (scriptedMotion)
            {
                _jumpBufferTimer = Mathf.Max(0f, _jumpBufferTimer - Time.fixedDeltaTime);
                RecordFootPosition();
                return;
            }

            if (_jumpBufferTimer > 0f)
            {
                _jumpBufferTimer -= Time.fixedDeltaTime;
                TryConsumeJump(settings);
            }

            ApplyHorizontalMovement(settings, movementMultiplier);
            Vector2 velocity = BodyVelocity;
            velocity.y = Mathf.Max(velocity.y, -Mathf.Max(0f, settings.maxFallSpeed) * movementMultiplier);
            BodyVelocity = velocity;
            RecordFootPosition();
        }

        private void RecoverCrossedGround(FrameActionMotorSettings settings)
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

            int layerMask = GroundLayerMask;
            ContactFilter2D filter = new ContactFilter2D
            {
                useTriggers = false,
                useLayerMask = true,
                layerMask = layerMask == 0 ? Physics2D.GetLayerCollisionMask(gameObject.layer) : layerMask,
            };
            int count = Physics2D.Raycast(new Vector2(bounds.center.x, originY), Vector2.down, filter, _groundHits, castDistance);
            RaycastHit2D best = default;
            float bestSurfaceY = float.NegativeInfinity;
            for (int i = 0; i < count; i++)
            {
                RaycastHit2D hit = _groundHits[i];
                Collider2D candidate = hit.collider;
                if (candidate == null || candidate.isTrigger || candidate.transform.root == transform.root || hit.normal.y <= 0.2f) continue;
                if (_ignoredDropColliders.Contains(candidate) || _sideIgnoredOneWayColliders.Contains(candidate)) continue;
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
                    Debug.LogWarning($"[Frame Action] Ground sweep found no surface under {name}: bodySimulated={body.simulated}, colliderEnabled={bodyCollider.enabled}, bodyLayer={gameObject.layer}, groundMask=0x{layerMask:X8}, previousFootY={_previousFootY:F3}, currentFootY={currentFootY:F3}, position={body.position}.", this);
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

        private FrameActionMotorSettings Settings => player?.Project?.motor;

        private float ResolveMovementMultiplier()
        {
            float actionMultiplier = player != null ? Mathf.Max(0f, player.CurrentMovementSpeedMultiplier) : 1f;
            return actionMultiplier * Mathf.Max(0f, _externalMovementMultiplier);
        }

        private void ApplyHorizontalMovement(FrameActionMotorSettings settings, float movementMultiplier)
        {
            float speed = controller != null ? controller.GetLocomotionSpeed() : Mathf.Max(0f, player?.CurrentAction?.movementSpeed ?? 0f);
            bool inputLocked = controller != null && (controller.IsStunned || controller.IsLocomotionInputLocked);
            float effectiveInput = inputLocked ? 0f : MoveInput;
            Vector2 velocity = BodyVelocity;
            float acceleration = Mathf.Abs(effectiveInput) > 0.001f ? settings.groundAcceleration : settings.groundDeceleration;
            float accelerationStep = Mathf.Max(0.01f, acceleration * movementMultiplier) * Time.fixedDeltaTime;
            if (IsGrounded)
            {
                Vector2 normal = _groundNormal.sqrMagnitude > 0.001f ? _groundNormal.normalized : Vector2.up;
                Vector2 tangent = new Vector2(normal.y, -normal.x);
                Vector2 relativeVelocity = velocity - _groundPointVelocity;
                float currentSurfaceSpeed = Vector2.Dot(relativeVelocity, tangent);
                float targetSurfaceSpeed = effectiveInput * speed * movementMultiplier;
                // Attacks lock ordinary locomotion immediately instead of letting
                // the previous run velocity decay into a visible slide. Scripted
                // timeline motion is handled above and never reaches this branch.
                float nextSurfaceSpeed = inputLocked
                    ? 0f
                    : Mathf.MoveTowards(currentSurfaceSpeed, targetSurfaceSpeed, accelerationStep);
                float separatingSpeed = Mathf.Max(0f, Vector2.Dot(relativeVelocity, normal));
                velocity = _groundPointVelocity + tangent * nextSurfaceSpeed + normal * separatingSpeed;

                // Cancel only downhill gravity. The normal component remains so the collider stays seated on the slope.
                Vector2 gravityAcceleration = Physics2D.gravity * body.gravityScale;
                Vector2 surfaceGravity = tangent * Vector2.Dot(gravityAcceleration, tangent);
                body.AddForce(-surfaceGravity * body.mass, ForceMode2D.Force);
            }
            else
            {
                float targetVelocityX = _groundPointVelocity.x + effectiveInput * speed * movementMultiplier;
                float airAccelerationStep = accelerationStep * Mathf.Clamp01(settings.airControl);
                velocity.x = inputLocked
                    ? _groundPointVelocity.x
                    : Mathf.MoveTowards(velocity.x, targetVelocityX, airAccelerationStep);
            }
            BodyVelocity = velocity;

            if (player != null && settings.autoFaceMovement && Mathf.Abs(effectiveInput) > 0.001f) player.facingLeft = effectiveInput < 0f;
        }

        private void TryConsumeJump(FrameActionMotorSettings settings)
        {
            if (_queuedJumpAction?.segments == null || _queuedJumpAction.segments.Count == 0) return;
            int jumpIndex;
            if (IsGrounded || _coyoteTimer > 0f) jumpIndex = 0;
            else jumpIndex = Mathf.Max(1, _jumpsUsed);
            if (jumpIndex >= _queuedJumpAction.segments.Count) return;
            if (controller != null && !controller.RequestActionSegment(_queuedJumpAction.id, jumpIndex)) return;

            FrameActionSegmentData jumpSegment = _queuedJumpAction.segments[jumpIndex];
            float gravity = Mathf.Abs(Physics2D.gravity.y * Mathf.Max(0.01f, settings.gravityScale));
            float movementMultiplier = ResolveMovementMultiplier();
            float jumpVelocity = Mathf.Sqrt(2f * gravity * Mathf.Max(0.01f, jumpSegment?.jumpHeight ?? 2.4f)) * movementMultiplier;
            Vector2 velocity = BodyVelocity;
            velocity.y = jumpVelocity + _groundPointVelocity.y;
            BodyVelocity = velocity;
            IsGrounded = false;
            controller?.SetGrounded(false);
            _jumpsUsed = jumpIndex + 1;
            _coyoteTimer = 0f;
            _jumpBufferTimer = 0f;
            _queuedJumpAction = null;
        }

        private void ApplyMovementMultiplierChange(float multiplier)
        {
            if (Mathf.Abs(multiplier - _appliedMovementMultiplier) < 0.0001f) return;
            if (_appliedMovementMultiplier > 0.0001f)
            {
                _velocityBeforeMovementPause = BodyVelocity / _appliedMovementMultiplier;
            }
            BodyVelocity = multiplier > 0.0001f ? _velocityBeforeMovementPause * multiplier : Vector2.zero;
            _appliedMovementMultiplier = multiplier;
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

        private void UpdateOneWaySidePassThrough(FrameActionMotorSettings settings)
        {
            if (bodyCollider == null) return;

            int layerMask = string.IsNullOrWhiteSpace(settings.groundLayerName) ? 0 : LayerMask.GetMask(settings.groundLayerName);
            if (layerMask == 0) layerMask = fallbackGroundLayers.value;
            ContactFilter2D filter = new ContactFilter2D { useTriggers = false, useLayerMask = true, layerMask = layerMask };
            Bounds bounds = bodyCollider.bounds;
            Vector2 velocity = BodyVelocity;
            float horizontalMargin = Mathf.Abs(velocity.x) * Time.fixedDeltaTime + 0.04f;
            float verticalMargin = Mathf.Abs(velocity.y) * Time.fixedDeltaTime + Mathf.Max(0.04f, settings.groundCheckDistance);
            Vector2 querySize = new Vector2(bounds.size.x + horizontalMargin * 2f, bounds.size.y + verticalMargin * 2f);
            int count = Physics2D.OverlapBox((Vector2)bounds.center, querySize, 0f, filter, _nearbyGroundColliders);

            _nextSideIgnoredOneWayColliders.Clear();
            for (int i = 0; i < count; i++)
            {
                Collider2D candidate = _nearbyGroundColliders[i];
                if (!TryGetOneWayEdge(candidate, out EdgeCollider2D edge) || candidate.transform.root == transform.root) continue;
                bool alreadyIgnored = _sideIgnoredOneWayColliders.Contains(candidate);
                if (ShouldIgnoreOneWaySurface(edge, bounds, velocity, settings.groundCheckDistance, alreadyIgnored)
                    && !_nextSideIgnoredOneWayColliders.Contains(candidate))
                {
                    _nextSideIgnoredOneWayColliders.Add(candidate);
                }
            }

            for (int i = _sideIgnoredOneWayColliders.Count - 1; i >= 0; i--)
            {
                Collider2D candidate = _sideIgnoredOneWayColliders[i];
                if (candidate != null && _nextSideIgnoredOneWayColliders.Contains(candidate)) continue;
                if (candidate != null && !_ignoredDropColliders.Contains(candidate)) Physics2D.IgnoreCollision(bodyCollider, candidate, false);
                _sideIgnoredOneWayColliders.RemoveAt(i);
            }
            for (int i = 0; i < _nextSideIgnoredOneWayColliders.Count; i++)
            {
                Collider2D candidate = _nextSideIgnoredOneWayColliders[i];
                if (candidate == null || _sideIgnoredOneWayColliders.Contains(candidate)) continue;
                Physics2D.IgnoreCollision(bodyCollider, candidate, true);
                _sideIgnoredOneWayColliders.Add(candidate);
            }
        }

        private static bool ShouldIgnoreOneWaySurface(EdgeCollider2D edge, Bounds actorBounds, Vector2 actorVelocity, float groundCheckDistance, bool alreadyIgnored)
        {
            if (!TrySampleOneWaySurface(edge, actorBounds.center.x, out float surfaceY, out float minimumX, out float maximumX, out Vector2 surfaceNormal)) return false;
            float tolerance = Mathf.Max(0.02f, groundCheckDistance * 0.35f);
            float horizontalMargin = Mathf.Abs(actorVelocity.x) * Time.fixedDeltaTime + 0.02f;
            float verticalMargin = Mathf.Abs(actorVelocity.y) * Time.fixedDeltaTime + tolerance;
            if (actorBounds.max.x < minimumX - horizontalMargin || actorBounds.min.x > maximumX + horizontalMargin) return false;
            if (actorBounds.max.y < surfaceY - verticalMargin || actorBounds.min.y > surfaceY + verticalMargin) return false;

            float footClearance = actorBounds.min.y - surfaceY;
            if (footClearance < -tolerance) return true;

            Rigidbody2D surfaceBody = edge.attachedRigidbody;
            Vector2 surfaceVelocity = surfaceBody != null ? surfaceBody.GetPointVelocity(new Vector2(actorBounds.center.x, surfaceY)) : Vector2.zero;
            float separatingSpeed = Vector2.Dot(actorVelocity - surfaceVelocity, surfaceNormal);
            // A visually flat edge can have a tiny authored slope. Horizontal motion on
            // that slope must not be treated as entering the one-way surface from below,
            // otherwise IgnoreCollision removes the actor's only ground contact.
            bool centerIsBelowSurface = actorBounds.center.y <= surfaceY + tolerance;
            if (centerIsBelowSurface && separatingSpeed > 0.01f && footClearance < tolerance) return true;
            return alreadyIgnored && footClearance < tolerance;
        }

        private bool CanUseAsGround(Collider2D candidate, float groundCheckDistance)
        {
            if (!TryGetOneWayEdge(candidate, out EdgeCollider2D edge)) return true;
            if (_sideIgnoredOneWayColliders.Contains(candidate)) return false;
            Bounds bounds = bodyCollider.bounds;
            if (!TrySampleOneWaySurface(edge, bounds.center.x, out float surfaceY, out float minimumX, out float maximumX, out _)) return false;
            if (bounds.center.x < minimumX - 0.001f || bounds.center.x > maximumX + 0.001f) return false;
            float tolerance = Mathf.Max(0.02f, groundCheckDistance * 0.35f);
            return bounds.min.y >= surfaceY - tolerance;
        }

        private static bool TryGetOneWayEdge(Collider2D candidate, out EdgeCollider2D edge)
        {
            edge = candidate as EdgeCollider2D;
            return edge != null && IsOneWayPlatform(edge) && edge.points != null && edge.points.Length >= 2;
        }

        private static bool TrySampleOneWaySurface(EdgeCollider2D edge, float worldX, out float surfaceY, out float minimumX, out float maximumX, out Vector2 surfaceNormal)
        {
            surfaceY = 0f;
            minimumX = float.PositiveInfinity;
            maximumX = float.NegativeInfinity;
            surfaceNormal = Vector2.up;
            Vector2[] points = edge?.points;
            if (points == null || points.Length < 2) return false;

            float bestHorizontalDistance = float.PositiveInfinity;
            for (int i = 0; i < points.Length - 1; i++)
            {
                Vector2 start = edge.transform.TransformPoint(points[i]);
                Vector2 end = edge.transform.TransformPoint(points[i + 1]);
                minimumX = Mathf.Min(minimumX, start.x, end.x);
                maximumX = Mathf.Max(maximumX, start.x, end.x);
                float deltaX = end.x - start.x;
                float t = Mathf.Abs(deltaX) > 0.0001f ? Mathf.Clamp01((worldX - start.x) / deltaX) : 0.5f;
                float sampledX = Mathf.Lerp(start.x, end.x, t);
                float horizontalDistance = Mathf.Abs(worldX - sampledX);
                if (horizontalDistance >= bestHorizontalDistance) continue;
                bestHorizontalDistance = horizontalDistance;
                surfaceY = Mathf.Lerp(start.y, end.y, t);
                Vector2 tangent = end - start;
                if (tangent.sqrMagnitude > 0.000001f)
                {
                    tangent.Normalize();
                    surfaceNormal = new Vector2(-tangent.y, tangent.x);
                    if (surfaceNormal.y < 0f) surfaceNormal = -surfaceNormal;
                }
            }
            return !float.IsPositiveInfinity(bestHorizontalDistance);
        }

        private bool DetectGrounded(FrameActionMotorSettings settings)
        {
            _groundPointVelocity = Vector2.zero;
            _groundNormal = Vector2.up;
            _groundColliders.Clear();
            _groundSurfaceY.Clear();
            if (bodyCollider == null)
            {
                if (!_warnedMissingCollider)
                {
                    Debug.LogWarning("[Frame Action] FrameActionMotor2D requires a Collider2D for grounded detection.", this);
                    _warnedMissingCollider = true;
                }
                return false;
            }

            int layerMask = string.IsNullOrWhiteSpace(settings.groundLayerName) ? 0 : LayerMask.GetMask(settings.groundLayerName);
            if (layerMask == 0) layerMask = fallbackGroundLayers.value;
            ContactFilter2D filter = new ContactFilter2D { useTriggers = false, useLayerMask = true, layerMask = layerMask };
            int count = bodyCollider.Cast(Vector2.down, filter, _groundHits, Mathf.Max(0.001f, settings.groundCheckDistance));
            Collider2D primaryGround = null;
            RaycastHit2D primaryHit = default;
            float primaryDistance = float.PositiveInfinity;
            for (int i = 0; i < count; i++)
            {
                Collider2D candidate = _groundHits[i].collider;
                if (candidate == null || candidate.transform.root == transform.root || _ignoredDropColliders.Contains(candidate)) continue;
                if (_groundHits[i].normal.y <= 0.05f) continue;
                if (!CanUseAsGround(candidate, settings.groundCheckDistance)) continue;
                if (!_groundColliders.Contains(candidate)) _groundColliders.Add(candidate);
                if (!_groundSurfaceY.TryGetValue(candidate, out float surfaceY) || _groundHits[i].point.y > surfaceY)
                {
                    _groundSurfaceY[candidate] = _groundHits[i].point.y;
                }
                float distance = Mathf.Max(0f, _groundHits[i].distance);
                if (primaryGround == null
                    || distance < primaryDistance - 0.001f
                    || Mathf.Abs(distance - primaryDistance) <= 0.001f && _groundHits[i].normal.y < primaryHit.normal.y)
                {
                    primaryGround = candidate;
                    primaryHit = _groundHits[i];
                    primaryDistance = distance;
                }
            }
            if (primaryGround != null)
            {
                _groundNormal = primaryHit.normal.normalized;
                Rigidbody2D groundBody = primaryGround.attachedRigidbody;
                if (groundBody != null)
                {
                    FrameActionMovingPlatform2D movingPlatform = groundBody.GetComponent<FrameActionMovingPlatform2D>();
                    _groundPointVelocity = movingPlatform != null
                        ? movingPlatform.SurfaceVelocity
                        : groundBody.GetPointVelocity(primaryHit.point);
                }
            }
            return _groundColliders.Count > 0;
        }

        private static bool IsOneWayPlatform(Collider2D candidate)
        {
            if (candidate == null || !candidate.usedByEffector) return false;
            PlatformEffector2D effector = candidate.GetComponent<PlatformEffector2D>();
            return effector != null && effector.enabled && effector.useOneWay;
        }

        private IEnumerator RestoreDropCollisionsAfterClearance()
        {
            float elapsed = 0f;
            const float minimumIgnoreTime = 0.08f;
            const float maximumIgnoreTime = 0.75f;
            while (elapsed < maximumIgnoreTime)
            {
                yield return new WaitForFixedUpdate();
                elapsed += Time.fixedDeltaTime;
                if (elapsed >= minimumIgnoreTime && HasClearedIgnoredPlatforms()) break;
            }
            _restoreDropCollisionRoutine = null;
            RestoreDropCollisions();
        }

        private bool HasClearedIgnoredPlatforms()
        {
            return bodyCollider == null
                || _ignoredDropColliders.Count == 0
                || bodyCollider.bounds.max.y < _dropClearanceSurfaceY - 0.02f;
        }

        private void RestoreDropCollisions()
        {
            if (_restoreDropCollisionRoutine != null)
            {
                StopCoroutine(_restoreDropCollisionRoutine);
                _restoreDropCollisionRoutine = null;
            }
            if (bodyCollider != null)
            {
                for (int i = 0; i < _ignoredDropColliders.Count; i++)
                {
                    Collider2D platform = _ignoredDropColliders[i];
                    if (platform != null && !_sideIgnoredOneWayColliders.Contains(platform)) Physics2D.IgnoreCollision(bodyCollider, platform, false);
                }
            }
            _ignoredDropColliders.Clear();
            _dropClearanceSurfaceY = float.NegativeInfinity;
        }

        private void RestoreSidePassThroughCollisions()
        {
            if (bodyCollider != null)
            {
                for (int i = 0; i < _sideIgnoredOneWayColliders.Count; i++)
                {
                    Collider2D platform = _sideIgnoredOneWayColliders[i];
                    if (platform != null && !_ignoredDropColliders.Contains(platform)) Physics2D.IgnoreCollision(bodyCollider, platform, false);
                }
            }
            _sideIgnoredOneWayColliders.Clear();
            _nextSideIgnoredOneWayColliders.Clear();
        }
    }
}
