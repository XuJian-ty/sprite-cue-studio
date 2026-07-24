using UnityEngine;

namespace FrameAction
{
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(1000)]
    public sealed class FrameActionCameraFollow2D : MonoBehaviour, IFrameActionCameraReceiver
    {
        public Camera targetCamera;
        public Transform followTarget;
        public bool followHorizontal = true;
        public bool followVertical = true;
        [Min(0f)] public float smoothTime = 0.15f;
        public Vector2 followOffset = new Vector2(0f, 1.5f);
        [Min(0.01f)] public float orthographicSize = 5f;
        public bool constrainToMap = true;
        [Min(0f)] public float edgePaddingX = 0.25f;
        [Min(0f)] public float edgePaddingY = 0.25f;
        public FrameActionMapMetadata mapOverride;

        private static FrameActionCameraFollow2D _automaticOwner;
        private FrameActionMapMetadata _activeMap;
        private Vector2 _smoothVelocity;
        private Vector2 _eventOffset;
        private float _eventZoom = 1f;
        private float _nextMapSearchTime;
        private Camera _resolvedCamera;
        private bool _hasSnapped;

        private void Awake()
        {
            if (followTarget == null) followTarget = transform;
        }

        private void OnEnable()
        {
            _hasSnapped = false;
            _smoothVelocity = Vector2.zero;
            _nextMapSearchTime = 0f;
        }

        private void OnDisable()
        {
            if (_automaticOwner == this) _automaticOwner = null;
            _smoothVelocity = Vector2.zero;
            _eventOffset = Vector2.zero;
            _eventZoom = 1f;
            _hasSnapped = false;
        }

        private void LateUpdate()
        {
            Camera camera = ResolveCamera();
            Transform target = followTarget != null ? followTarget : transform;
            if (camera == null || target == null || !AcquireOwnership()) return;

            float zoom = Mathf.Max(0.01f, _eventZoom);
            if (camera.orthographic) camera.orthographicSize = Mathf.Max(0.01f, orthographicSize) / zoom;

            Vector3 current = camera.transform.position;
            Vector2 targetCenter = (Vector2)target.position + followOffset + _eventOffset;
            Vector2 desired = new Vector2(
                followHorizontal ? targetCenter.x : current.x,
                followVertical ? targetCenter.y : current.y);

            if (constrainToMap && camera.orthographic)
            {
                ResolveMap(target.position);
                if (_activeMap != null) desired = ClampToMap(desired, camera, WorldBounds(_activeMap));
            }

            Vector2 next;
            if (!_hasSnapped || smoothTime <= 0f)
            {
                next = desired;
                _smoothVelocity = Vector2.zero;
                _hasSnapped = true;
            }
            else
            {
                next = Vector2.SmoothDamp(current, desired, ref _smoothVelocity, smoothTime, Mathf.Infinity, Time.unscaledDeltaTime);
                if (constrainToMap && camera.orthographic && _activeMap != null)
                {
                    next = ClampToMap(next, camera, WorldBounds(_activeMap));
                }
            }

            camera.transform.position = new Vector3(next.x, next.y, current.z);
        }

        public void ApplyFrameActionCamera(Vector2 localOffset, float zoom, float progress)
        {
            _eventOffset = localOffset;
            _eventZoom = Mathf.Max(0.01f, zoom);
        }

        public void ClearFrameActionCamera()
        {
            _eventOffset = Vector2.zero;
            _eventZoom = 1f;
        }

        private Camera ResolveCamera()
        {
            Camera camera = targetCamera != null ? targetCamera : Camera.main;
            if (camera == _resolvedCamera) return camera;
            _resolvedCamera = camera;
            _hasSnapped = false;
            _smoothVelocity = Vector2.zero;
            return camera;
        }

        private bool AcquireOwnership()
        {
            if (_automaticOwner == null || !_automaticOwner.isActiveAndEnabled) _automaticOwner = this;
            return _automaticOwner == this;
        }

        private void ResolveMap(Vector3 targetPosition)
        {
            if (mapOverride != null)
            {
                _activeMap = mapOverride;
                return;
            }

            bool currentContainsTarget = _activeMap != null && Contains2D(WorldBounds(_activeMap), targetPosition);
            if (currentContainsTarget && Time.unscaledTime < _nextMapSearchTime) return;
            _nextMapSearchTime = Time.unscaledTime + 1f;

            FrameActionMapMetadata[] maps = FindObjectsByType<FrameActionMapMetadata>(FindObjectsInactive.Exclude, FindObjectsSortMode.None);
            FrameActionMapMetadata best = null;
            float bestDistance = float.PositiveInfinity;
            for (int index = 0; index < maps.Length; index++)
            {
                FrameActionMapMetadata candidate = maps[index];
                if (candidate == null || candidate.width <= 0 || candidate.height <= 0 || candidate.pixelsPerUnit <= 0f) continue;
                Bounds bounds = WorldBounds(candidate);
                float distance = DistanceSquared2D(bounds, targetPosition);
                if (distance > bestDistance) continue;
                best = candidate;
                bestDistance = distance;
                if (distance <= 0f) break;
            }
            _activeMap = best;
        }

        private Vector2 ClampToMap(Vector2 center, Camera camera, Bounds bounds)
        {
            float halfHeight = Mathf.Max(0.01f, camera.orthographicSize);
            float halfWidth = halfHeight * Mathf.Max(0.01f, camera.aspect);
            center.x = ClampAxis(center.x, bounds.min.x, bounds.max.x, halfWidth + Mathf.Max(0f, edgePaddingX));
            center.y = ClampAxis(center.y, bounds.min.y, bounds.max.y, halfHeight + Mathf.Max(0f, edgePaddingY));
            return center;
        }

        private static float ClampAxis(float value, float minimum, float maximum, float inset)
        {
            float allowedMinimum = minimum + inset;
            float allowedMaximum = maximum - inset;
            return allowedMinimum <= allowedMaximum
                ? Mathf.Clamp(value, allowedMinimum, allowedMaximum)
                : (minimum + maximum) * 0.5f;
        }

        private static Bounds WorldBounds(FrameActionMapMetadata map)
        {
            float ppu = Mathf.Max(0.0001f, map.pixelsPerUnit);
            float width = map.width / ppu;
            float height = map.height / ppu;
            Vector3 first = map.transform.TransformPoint(Vector3.zero);
            Vector3 second = map.transform.TransformPoint(new Vector3(width, 0f, 0f));
            Vector3 third = map.transform.TransformPoint(new Vector3(0f, height, 0f));
            Vector3 fourth = map.transform.TransformPoint(new Vector3(width, height, 0f));
            Vector3 minimum = Vector3.Min(Vector3.Min(first, second), Vector3.Min(third, fourth));
            Vector3 maximum = Vector3.Max(Vector3.Max(first, second), Vector3.Max(third, fourth));
            return new Bounds((minimum + maximum) * 0.5f, maximum - minimum);
        }

        private static bool Contains2D(Bounds bounds, Vector3 point)
        {
            return point.x >= bounds.min.x && point.x <= bounds.max.x
                && point.y >= bounds.min.y && point.y <= bounds.max.y;
        }

        private static float DistanceSquared2D(Bounds bounds, Vector3 point)
        {
            float x = Mathf.Max(bounds.min.x - point.x, 0f, point.x - bounds.max.x);
            float y = Mathf.Max(bounds.min.y - point.y, 0f, point.y - bounds.max.y);
            return x * x + y * y;
        }
    }
}
