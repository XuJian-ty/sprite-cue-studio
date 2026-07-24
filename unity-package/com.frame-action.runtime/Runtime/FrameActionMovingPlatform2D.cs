using UnityEngine;

namespace FrameAction
{
    /// <summary>
    /// Moves an imported map object along one axis. Range is the one-way path length and the authored position is its initial point.
    /// </summary>
    [DefaultExecutionOrder(-200)]
    [DisallowMultipleComponent]
    [RequireComponent(typeof(Rigidbody2D))]
    public sealed class FrameActionMovingPlatform2D : MonoBehaviour
    {
        public string direction = "horizontal";
        public float speedMetersPerSecond = 2f;
        public float rangeMeters = 10f;
        [Range(0f, 1f)] public float initialProgress;
        public bool pingPong = true;
        public float endpointPauseSeconds;
        public float phaseSeconds;
        public Vector2 SurfaceVelocity { get; private set; }

        private Rigidbody2D _body;
        private Vector2 _authoredPosition;
        private Vector2 _pathStartPosition;
        private float _elapsed;

        private void Awake()
        {
            CacheBody();
            CaptureStartPosition();
        }

        private void OnEnable()
        {
            CacheBody();
            CaptureStartPosition();
            _elapsed = 0f;
            SurfaceVelocity = Vector2.zero;
        }

        private void OnDisable()
        {
            SurfaceVelocity = Vector2.zero;
        }

        private void FixedUpdate()
        {
            if (_body == null) return;
            float distance = Mathf.Max(0f, rangeMeters);
            float speed = Mathf.Max(0f, speedMetersPerSecond);
            if (distance <= 0.0001f || speed <= 0.0001f)
            {
                MoveBody(_authoredPosition);
                return;
            }

            float travelDuration = distance / speed;
            float pause = Mathf.Max(0f, endpointPauseSeconds);
            float cycleDuration = pingPong ? travelDuration * 2f + pause * 2f : travelDuration + pause;
            float cycleTime = Mathf.Repeat(_elapsed + travelDuration * Mathf.Clamp01(initialProgress) + Mathf.Max(0f, phaseSeconds), Mathf.Max(0.0001f, cycleDuration));
            float offset;
            if (!pingPong) offset = cycleTime < travelDuration ? cycleTime * speed : distance;
            else if (cycleTime < travelDuration) offset = cycleTime * speed;
            else if (cycleTime < travelDuration + pause) offset = distance;
            else if (cycleTime < travelDuration + pause + travelDuration) offset = distance - (cycleTime - travelDuration - pause) * speed;
            else offset = 0f;

            Vector2 axis = MotionAxis();
            MoveBody(_pathStartPosition + axis * Mathf.Clamp(offset, 0f, distance));
            _elapsed += Time.fixedDeltaTime;
        }

        private void MoveBody(Vector2 targetPosition)
        {
            float fixedDelta = Mathf.Max(0.000001f, Time.fixedDeltaTime);
            SurfaceVelocity = (targetPosition - _body.position) / fixedDelta;
            _body.MovePosition(targetPosition);
        }

        private void CacheBody()
        {
            if (_body == null) _body = GetComponent<Rigidbody2D>();
        }

        private void CaptureStartPosition()
        {
            if (_body == null) return;
            _authoredPosition = _body.position;
            _pathStartPosition = _authoredPosition - MotionAxis() * (Mathf.Max(0f, rangeMeters) * Mathf.Clamp01(initialProgress));
        }

        private Vector2 MotionAxis()
        {
            return string.Equals(direction, "vertical", System.StringComparison.OrdinalIgnoreCase) ? Vector2.up : Vector2.right;
        }
    }
}
