using UnityEngine;

namespace FrameAction
{
    /// <summary>
    /// Owns short scripted displacements for a dynamic character body.
    /// The motion is authored in fixed steps so character motors cannot
    /// overwrite it and the 2D solver can resolve ground contacts normally.
    /// </summary>
    [DisallowMultipleComponent]
    [RequireComponent(typeof(Rigidbody2D))]
    [DefaultExecutionOrder(1000)]
    public sealed class FrameActionPhysicsMotion2D : MonoBehaviour
    {
        private Rigidbody2D _body;
        private Collider2D _bodyCollider;
        private readonly RaycastHit2D[] _groundHits = new RaycastHit2D[12];
        private float _elapsed;
        private float _duration;
        private float _horizontalVelocity;
        private float _verticalVelocity;
        private bool _applyVerticalVelocity;
        private bool _keepGrounded;
        private int _groundLayerMask;
        private CollisionDetectionMode2D _previousCollisionDetectionMode;
        private bool _restoreCollisionDetectionMode;
        private int _generation;
        private float _hoverElapsed;
        private float _hoverDuration;
        private float _gravityScaleBeforeHover;
        private int _hoverGeneration;

        public bool IsActive { get; private set; }
        public bool IsHoverActive { get; private set; }
        public int Generation => _generation;

        private void Awake()
        {
            _body = GetComponent<Rigidbody2D>();
            _bodyCollider = ResolveBodyCollider();
        }

        private void OnDisable()
        {
            if (IsActive) StopHorizontalMotion();
            Finish();
            FinishHover();
        }

        public static bool IsActiveOn(Rigidbody2D body)
        {
            return body != null && body.GetComponent<FrameActionPhysicsMotion2D>()?.IsActive == true;
        }

        public int Begin(string effectType, Vector2 direction, float distance, float height, float duration)
        {
            if (_body == null) _body = GetComponent<Rigidbody2D>();
            // Motion is only meaningful for dynamic actor bodies. A static map
            // Rigidbody2D may be found through an overlapped terrain collider;
            // keeping this guard here makes the component safe even if another
            // caller bypasses the built-in event handler's filter.
            if (_body == null || _body.bodyType != RigidbodyType2D.Dynamic) return _generation;

            _generation++;
            _elapsed = 0f;
            _duration = Mathf.Max(Time.fixedDeltaTime, duration);
            _horizontalVelocity = direction.x * distance / _duration;
            // Only explicit launch effects own vertical motion. Knockback, pull and dash
            // stay grounded even when legacy data still contains a non-zero height value.
            _applyVerticalVelocity = effectType == "launch" || effectType == "airborne";
            _verticalVelocity = 0f;
            if (_applyVerticalVelocity)
            {
                float gravity = Mathf.Abs(Physics2D.gravity.y * Mathf.Max(0f, _body.gravityScale));
                _verticalVelocity = Mathf.Sign(height) * Mathf.Sqrt(2f * Mathf.Max(0.0001f, gravity) * Mathf.Abs(height));
            }
            ResolveGroundAdhesion();
            if (!IsActive)
            {
                _previousCollisionDetectionMode = _body.collisionDetectionMode;
                _restoreCollisionDetectionMode = _previousCollisionDetectionMode != CollisionDetectionMode2D.Continuous;
                if (_restoreCollisionDetectionMode) _body.collisionDetectionMode = CollisionDetectionMode2D.Continuous;
            }
            IsActive = true;
            return _generation;
        }

        public int BeginHover(float duration)
        {
            if (_body == null) _body = GetComponent<Rigidbody2D>();
            if (_body == null || _body.bodyType != RigidbodyType2D.Dynamic) return _hoverGeneration;

            _hoverGeneration++;
            _hoverElapsed = 0f;
            _hoverDuration = Mathf.Max(Time.fixedDeltaTime, duration);
            if (!IsHoverActive) _gravityScaleBeforeHover = _body.gravityScale;
            IsHoverActive = true;
            _body.gravityScale = 0f;
            StopVerticalMotion();
            _body.WakeUp();
            return _hoverGeneration;
        }

        public bool IsHoverActiveFor(int generation)
        {
            return IsHoverActive && generation == _hoverGeneration;
        }

        public void CancelHover(int generation)
        {
            if (generation != _hoverGeneration) return;
            FinishHover();
        }

        public bool IsActiveFor(int generation)
        {
            return IsActive && generation == _generation;
        }

        public void Cancel(int generation)
        {
            if (generation != _generation) return;
            StopHorizontalMotion();
            Finish();
        }

        public void StopAtHorizontalBoundary(float inwardNormalX)
        {
            if (!IsActive || Mathf.Abs(inwardNormalX) <= 0.0001f || _horizontalVelocity * inwardNormalX >= 0f) return;
            StopHorizontalMotion();
            Finish();
        }

        private void FixedUpdate()
        {
            UpdateHover();
            if (!IsActive || _body == null || _body.bodyType != RigidbodyType2D.Dynamic || !_body.simulated)
            {
                if (IsActive && (_body == null || _body.bodyType != RigidbodyType2D.Dynamic || !_body.simulated)) Finish();
                return;
            }

            if (_elapsed + 0.0001f >= _duration)
            {
                StopHorizontalMotion();
                Finish();
                return;
            }

            float remaining = Mathf.Max(0f, _duration - _elapsed);
            float stepScale = Mathf.Clamp01(remaining / Mathf.Max(0.0001f, Time.fixedDeltaTime));
            Vector2 velocity = BodyVelocity;
            velocity.x = _horizontalVelocity * stepScale;
            if (_applyVerticalVelocity && _elapsed <= 0.0001f) velocity.y = _verticalVelocity;
            else if (_keepGrounded) MaintainGroundContact(ref velocity);
            BodyVelocity = velocity;
            _elapsed += Time.fixedDeltaTime;
        }

        private void UpdateHover()
        {
            if (!IsHoverActive) return;
            if (_body == null || _body.bodyType != RigidbodyType2D.Dynamic || !_body.simulated)
            {
                FinishHover();
                return;
            }
            if (_hoverElapsed + 0.0001f >= _hoverDuration)
            {
                FinishHover();
                return;
            }
            _body.gravityScale = 0f;
            StopVerticalMotion();
            _hoverElapsed += Time.fixedDeltaTime;
        }

        private void StopHorizontalMotion()
        {
            if (_body == null || _body.bodyType != RigidbodyType2D.Dynamic) return;
            Vector2 velocity = BodyVelocity;
            velocity.x = 0f;
            BodyVelocity = velocity;
        }

        private void StopVerticalMotion()
        {
            if (_body == null || _body.bodyType != RigidbodyType2D.Dynamic) return;
            Vector2 velocity = BodyVelocity;
            velocity.y = 0f;
            BodyVelocity = velocity;
        }

        private void Finish()
        {
            IsActive = false;
            _elapsed = 0f;
            _duration = 0f;
            _horizontalVelocity = 0f;
            _verticalVelocity = 0f;
            _applyVerticalVelocity = false;
            _keepGrounded = false;
            _groundLayerMask = 0;
            if (_body != null && _restoreCollisionDetectionMode) _body.collisionDetectionMode = _previousCollisionDetectionMode;
            _restoreCollisionDetectionMode = false;
        }

        private void FinishHover()
        {
            if (IsHoverActive && _body != null) _body.gravityScale = _gravityScaleBeforeHover;
            IsHoverActive = false;
            _hoverElapsed = 0f;
            _hoverDuration = 0f;
        }

        private void ResolveGroundAdhesion()
        {
            _keepGrounded = false;
            _groundLayerMask = 0;
            if (_applyVerticalVelocity || Mathf.Abs(_horizontalVelocity) <= 0.0001f || _body == null) return;
            if (_bodyCollider == null) _bodyCollider = ResolveBodyCollider();
            if (_bodyCollider == null) return;

            FrameActionMotor2D playerMotor = GetComponent<FrameActionMotor2D>();
            if (playerMotor != null)
            {
                if (!playerMotor.IsGrounded) return;
                _groundLayerMask = playerMotor.GroundLayerMask;
            }
            else
            {
                FrameActionEnemyMotor2D enemyMotor = GetComponent<FrameActionEnemyMotor2D>();
                if (enemyMotor != null)
                {
                    if (!enemyMotor.IsGrounded) return;
                    _groundLayerMask = enemyMotor.EnvironmentLayerMask;
                }
            }

            if (_groundLayerMask == 0) _groundLayerMask = Physics2D.GetLayerCollisionMask(gameObject.layer);
            _keepGrounded = TryFindGround(out _, out float gap) && gap >= -0.35f && gap <= 0.25f;
        }

        private void MaintainGroundContact(ref Vector2 velocity)
        {
            if (!TryFindGround(out RaycastHit2D ground, out float gap) || gap > 0.3f)
            {
                // No support below the actor means the scripted motion reached a real ledge.
                _keepGrounded = false;
                return;
            }

            const float skin = 0.01f;
            if (gap < -skin || gap > skin)
            {
                // Recover a body that entered a thin collider during the previous solver step,
                // or close a small contact gap without adding a tunnelling downward velocity.
                float correction = gap - skin;
                _body.position += Vector2.down * correction;
                _body.WakeUp();
            }

            Vector2 normal = ground.normal.sqrMagnitude > 0.0001f ? ground.normal.normalized : Vector2.up;
            if (normal.y <= 0.2f)
            {
                velocity.y = 0f;
                return;
            }

            Rigidbody2D groundBody = ground.rigidbody;
            Vector2 surfaceVelocity = groundBody != null ? groundBody.GetPointVelocity(ground.point) : Vector2.zero;
            velocity.y = surfaceVelocity.y - (velocity.x - surfaceVelocity.x) * normal.x / normal.y;
        }

        private bool TryFindGround(out RaycastHit2D bestHit, out float surfaceGap)
        {
            bestHit = default;
            surfaceGap = float.PositiveInfinity;
            if (_bodyCollider == null || !_bodyCollider.enabled) return false;

            Bounds bounds = _bodyCollider.bounds;
            float distance = bounds.extents.y + 0.35f;
            ContactFilter2D filter = new ContactFilter2D
            {
                useTriggers = false,
                useLayerMask = true,
                layerMask = _groundLayerMask == 0 ? Physics2D.GetLayerCollisionMask(gameObject.layer) : _groundLayerMask,
            };
            int count = Physics2D.Raycast(bounds.center, Vector2.down, filter, _groundHits, distance);
            float bestDistance = float.PositiveInfinity;
            for (int i = 0; i < count; i++)
            {
                RaycastHit2D hit = _groundHits[i];
                Collider2D candidate = hit.collider;
                if (candidate == null || candidate.isTrigger || hit.rigidbody == _body || candidate.transform.root == transform.root) continue;
                if (candidate.GetComponentInParent<FrameActionPlayer>() != null || hit.normal.y <= 0.2f) continue;
                if (hit.distance >= bestDistance) continue;
                bestDistance = hit.distance;
                bestHit = hit;
            }
            if (float.IsPositiveInfinity(bestDistance)) return false;
            surfaceGap = bounds.min.y - bestHit.point.y;
            return true;
        }

        private Collider2D ResolveBodyCollider()
        {
            Collider2D[] colliders = GetComponents<Collider2D>();
            for (int i = 0; i < colliders.Length; i++)
            {
                if (colliders[i] != null && !colliders[i].isTrigger) return colliders[i];
            }
            return null;
        }

        private Vector2 BodyVelocity
        {
#if UNITY_6000_0_OR_NEWER
            get => _body.linearVelocity;
            set => _body.linearVelocity = value;
#else
            get => _body.velocity;
            set => _body.velocity = value;
#endif
        }
    }
}
