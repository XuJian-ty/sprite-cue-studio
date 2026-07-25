using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace FrameAction
{
    [DisallowMultipleComponent]
    public sealed class FrameActionBuiltinEventHandler2D : MonoBehaviour, IFrameActionEventHandler
    {
        public FrameActionPlayer player;
        public Rigidbody2D ownerBody;
        public Transform defaultTarget;
        public MonoBehaviour targetProviderBehaviour;
        public LayerMask defaultTargetLayers = ~0;
        public Camera previewCamera;
        public MonoBehaviour cameraReceiverBehaviour;
        public MonoBehaviour hitStopReceiverBehaviour;
        public bool applyHitStop = true;
        public string vfxSortingLayer = "Default";
        public int vfxSortingOrder = 10;

        private readonly List<GameObject> _liveObjects = new List<GameObject>();
        private readonly Dictionary<int, List<GameObject>> _actionBoundObjects = new Dictionary<int, List<GameObject>>();
        private IFrameActionCameraReceiver _cameraReceiver;
        private IFrameActionTargetProvider _targetProvider;
        private IFrameActionHitStopReceiver _hitStopReceiver;
        private Vector3 _cameraBasePosition;
        private float _cameraBaseSize;
        private bool _cameraCaptured;
        private readonly HashSet<string> _activeCameraEvents = new HashSet<string>();
        private readonly Dictionary<string, AnchorSnapshot> _fixedRepeatedAnchors = new Dictionary<string, AnchorSnapshot>();
        private readonly Dictionary<string, PhysicsMaterial2D> _physicalMaterials = new Dictionary<string, PhysicsMaterial2D>();
        private readonly RaycastHit2D[] _teleportCastHits = new RaycastHit2D[32];
        private readonly Collider2D[] _teleportOverlapHits = new Collider2D[32];
        private float _timeScaleBeforeHitStop = 1f;
        private int _hitStopVersion;
        private bool _hitStopActive;
        private int _lastEndedExecutionId;
        private float FacingSign => player != null && player.facingLeft ? -1f : 1f;

        private struct AnchorSnapshot
        {
            public Vector3 position;
            public float rotation;

            public AnchorSnapshot(Vector3 position, float rotation)
            {
                this.position = position;
                this.rotation = rotation;
            }
        }

        private void Awake()
        {
            if (player == null) player = GetComponentInParent<FrameActionPlayer>();
            if (ownerBody == null && player != null) ownerBody = player.GetComponent<Rigidbody2D>();
            if (previewCamera == null) previewCamera = Camera.main;
            _cameraReceiver = cameraReceiverBehaviour as IFrameActionCameraReceiver;
            _targetProvider = targetProviderBehaviour as IFrameActionTargetProvider;
            _hitStopReceiver = hitStopReceiverBehaviour as IFrameActionHitStopReceiver;
            if (_cameraReceiver == null) _cameraReceiver = GetComponentsInParent<MonoBehaviour>(true).OfType<IFrameActionCameraReceiver>().FirstOrDefault();
            if (_targetProvider == null) _targetProvider = GetComponentsInParent<MonoBehaviour>(true).OfType<IFrameActionTargetProvider>().FirstOrDefault();
            if (_hitStopReceiver == null) _hitStopReceiver = GetComponentsInParent<MonoBehaviour>(true).OfType<IFrameActionHitStopReceiver>().FirstOrDefault();
            if (player != null)
            {
                player.ActionExecutionEnded += HandleActionExecutionEnded;
            }
        }

        private void OnDestroy()
        {
            if (player != null)
            {
                player.ActionExecutionEnded -= HandleActionExecutionEnded;
            }
            CleanupAllState();
        }

        public bool CanHandle(string eventType)
        {
            return eventType == "damage" || eventType == "physics" || eventType == "vfx" || eventType == "sfx" || eventType == "camera";
        }

        public void OnEnter(FrameActionEventContext context)
        {
            JObject parameters = context.data.parameters ?? new JObject();
            switch (context.data.type)
            {
                case "damage":
                    foreach (JObject effect in Objects(parameters["damageEffects"])) StartCoroutine(RunDamageEffect(context, effect));
                    break;
                case "physics":
                    foreach (JObject effect in Objects(parameters["physicsEffects"])) ApplyPhysicsEffect(effect, ownerBody, null, false, default, context);
                    break;
                case "vfx":
                    foreach (JObject effect in Objects(parameters["vfxEffects"])) StartCoroutine(SpawnVfxAfterDelay(effect, null, null, null, false, null, context.actionExecutionId));
                    break;
                case "sfx":
                    foreach (JObject effect in Objects(parameters["sfxEffects"])) StartCoroutine(PlaySfxAfterDelay(effect, null, null, false, context.actionExecutionId));
                    break;
                case "camera":
                    _activeCameraEvents.Add(CameraEventKey(context));
                    CaptureCamera();
                    ApplyCamera(context);
                    break;
            }
        }

        public void OnUpdate(FrameActionEventContext context)
        {
            if (context.data.type == "camera") ApplyCamera(context);
        }

        public void OnExit(FrameActionEventContext context)
        {
            if (context.data.type == "camera")
            {
                _activeCameraEvents.Remove(CameraEventKey(context));
                if (_activeCameraEvents.Count == 0) ClearCamera();
            }
        }

        private IEnumerator RunDamageEffect(FrameActionEventContext context, JObject effect)
        {
            FrameTimelineEventData eventData = context.data;
            Transform source = player != null ? player.transform : transform;
            string detectionType = String(effect, "detectionType", "rangeOverlap");
            int detectionTicks = Mathf.Max(0, Int(effect, "detectionDurationTicks"));
            int activationTicks = Mathf.Clamp(Int(effect, "activationTick"), 0, detectionTicks);
            float activationDelay = TicksToSeconds(activationTicks);
            float detectionDuration = TicksToSeconds(detectionTicks);
            float windowDuration = detectionDuration;
            string anchorMode = String(effect, "anchor", "world");
            bool worldAnchor = anchorMode == "world";
            Transform liveAnchor = worldAnchor ? null : ResolveAnchor(anchorMode);
            bool fixedRepeatedAnchor = worldAnchor
                && eventData.triggerMode == "repeated"
                && String(eventData.parameters, "repeatedAnchorMode", "follow") == "fixed";
            AnchorSnapshot snapshot;
            if (fixedRepeatedAnchor)
            {
                string anchorKey = $"{context.actionExecutionId}:{eventData.id}";
                if (!_fixedRepeatedAnchors.TryGetValue(anchorKey, out snapshot))
                {
                    snapshot = new AnchorSnapshot(source.position, source.eulerAngles.z);
                    _fixedRepeatedAnchors[anchorKey] = snapshot;
                }
            }
            else
            {
                snapshot = new AnchorSnapshot(source.position, source.eulerAngles.z);
            }
            Vector3 fixedPosition = snapshot.position;
            float fixedRotation = snapshot.rotation;
            Vector3 anchorPosition = liveAnchor != null ? liveAnchor.position : fixedPosition;
            float anchorRotation = liveAnchor != null ? liveAnchor.eulerAngles.z : fixedRotation;
            if (detectionType == "physicalEntity")
            {
                yield return RunPhysicalEntity(context, effect, worldAnchor ? fixedPosition : anchorPosition, worldAnchor ? fixedRotation : anchorRotation);
                yield break;
            }
            bool follow = !worldAnchor;
            bool limitedFollow = follow && Bool(effect, "useFollowDuration");
            float followDuration = limitedFollow ? TicksToSeconds(Mathf.Max(0, Int(effect, "followDurationTicks"))) : float.PositiveInfinity;
            float activeDuration = TicksToSeconds(Mathf.Max(1, Int(effect, "intermittentActiveTicks", 1)));
            float inactiveDuration = TicksToSeconds(Mathf.Max(0, Int(effect, "intermittentIntervalTicks")));
            bool intermittent = String(effect, "activationMode", "continuous") == "intermittent";
            string deduplication = String(effect, "deduplicationScope", "wholeEvent");
            HashSet<int> hitIds = new HashSet<int>();
            int previousActivationCycle = -1;
            bool oneShotExecuted = false;
            float elapsed = 0f;
            List<GameObject> companionObjects = new List<GameObject>();
            GameObject companionRoot = null;

            Vector2 initialCenter = ResolveDetectionVisualCenter(effect, follow ? anchorPosition : fixedPosition, follow ? anchorRotation : fixedRotation, 0f);
            List<JObject> companionCues = Objects(effect["companionVfxEffects"]).ToList();
            if (companionCues.Count > 0)
            {
                companionRoot = new GameObject("FrameAction Companion VFX Root");
                companionRoot.transform.position = initialCenter;
                companionRoot.transform.rotation = Quaternion.Euler(0f, 0f, follow ? anchorRotation : fixedRotation);
                RegisterLiveObject(companionRoot);
                foreach (JObject cue in companionCues) StartCoroutine(SpawnVfxAfterDelay(cue, initialCenter, null, companionObjects, false, companionRoot.transform, context.actionExecutionId));
            }

            do
            {
                if (follow && liveAnchor != null && (!limitedFollow || elapsed <= followDuration))
                {
                    anchorPosition = liveAnchor.position;
                    anchorRotation = liveAnchor.eulerAngles.z;
                }
                Vector3 sourcePosition = follow ? anchorPosition : fixedPosition;
                float sourceRotation = follow ? anchorRotation : fixedRotation;
                if (companionRoot != null)
                {
                    companionRoot.transform.position = ResolveDetectionVisualCenter(effect, sourcePosition, sourceRotation, elapsed);
                    companionRoot.transform.rotation = Quaternion.Euler(0f, 0f, sourceRotation);
                }

                bool reachedActivation = elapsed + 0.0001f >= activationDelay;
                float activationElapsed = Mathf.Max(0f, elapsed - activationDelay);
                bool withinDetection = detectionDuration <= 0f
                    ? !oneShotExecuted
                    : elapsed <= detectionDuration + 0.0001f;
                int activationCycle = ResolveActivationCycleIndex(intermittent, activationElapsed, activeDuration, inactiveDuration, detectionDuration - activationDelay);
                bool active = reachedActivation
                    && withinDetection
                    && IsActivationPhaseActive(intermittent, activationElapsed, activeDuration, inactiveDuration);
                if (active && activationCycle != previousActivationCycle && deduplication == "perActivation") hitIds.Clear();
                if (active)
                {
                    if (deduplication == "perDetection") hitIds.Clear();
                    Detect(effect, sourcePosition, sourceRotation, elapsed, hitIds, context);
                    if (detectionDuration <= 0f) oneShotExecuted = true;
                    previousActivationCycle = activationCycle;
                }
                if (windowDuration <= 0f || active && detectionDuration <= 0f) break;
                elapsed += Time.deltaTime;
                yield return null;
            }
            while (elapsed <= windowDuration + 0.0001f);
            if (companionRoot != null)
            {
                _liveObjects.Remove(companionRoot);
                Destroy(companionRoot);
            }
            for (int i = companionObjects.Count - 1; i >= 0; i--)
            {
                GameObject companion = companionObjects[i];
                _liveObjects.Remove(companion);
                ReleaseOrDestroy(companion);
            }
        }

        private IEnumerator RunPhysicalEntity(FrameActionEventContext context, JObject effect, Vector3 sourcePosition, float sourceRotation)
        {
            int durationTicks = Mathf.Max(1, Int(effect, "detectionDurationTicks", 1));
            float duration = TicksToSeconds(durationTicks);
            float activationDelay = TicksToSeconds(Mathf.Clamp(Int(effect, "activationTick"), 0, durationTicks));
            float activeDuration = TicksToSeconds(Mathf.Max(1, Int(effect, "intermittentActiveTicks", 1)));
            float inactiveDuration = TicksToSeconds(Mathf.Max(0, Int(effect, "intermittentIntervalTicks")));
            bool intermittent = String(effect, "activationMode", "continuous") == "intermittent";
            string deduplication = String(effect, "deduplicationScope", "wholeEvent");
            HashSet<int> hitIds = new HashSet<int>();
            bool active = activationDelay <= 0f;
            int previousActivationCycle = -1;

            Vector2 center = ResolveDetectionCenter(effect, sourcePosition, sourceRotation, 0f);
            float rotation = sourceRotation + Float(effect, "rotation") * FacingSign;
            GameObject entity = FrameActionRuntimePool.Acquire(FrameActionPoolKind.PhysicalEntity, "FrameAction Physical Entity");
            entity.transform.position = new Vector3(center.x, center.y, 0f);
            entity.transform.rotation = Quaternion.Euler(0f, 0f, rotation);
            int configuredLayer = LayerMask.NameToLayer(String(effect, "physicalLayerName", "Ground"));
            entity.layer = configuredLayer >= 0 ? configuredLayer : player != null ? player.gameObject.layer : gameObject.layer;

            Rigidbody2D body = entity.GetComponent<Rigidbody2D>();
            if (body == null) body = entity.AddComponent<Rigidbody2D>();
            body.bodyType = RigidbodyType2D.Dynamic;
            body.mass = Mathf.Max(0.01f, Float(effect, "physicalMass", 10f));
            body.gravityScale = Mathf.Max(0f, Float(effect, "physicalGravityScale", 1f));
#if UNITY_6000_0_OR_NEWER
            body.linearDamping = Mathf.Max(0f, Float(effect, "physicalLinearDamping"));
            body.angularDamping = Mathf.Max(0f, Float(effect, "physicalAngularDamping", 0.05f));
#else
            body.drag = Mathf.Max(0f, Float(effect, "physicalLinearDamping"));
            body.angularDrag = Mathf.Max(0f, Float(effect, "physicalAngularDamping", 0.05f));
#endif
            body.constraints = Bool(effect, "physicalAllowRotation", true) ? RigidbodyConstraints2D.None : RigidbodyConstraints2D.FreezeRotation;
            body.collisionDetectionMode = Bool(effect, "physicalContinuousCollision", true) ? CollisionDetectionMode2D.Continuous : CollisionDetectionMode2D.Discrete;
            body.interpolation = RigidbodyInterpolation2D.Interpolate;

            BoxCollider2D box = entity.GetComponent<BoxCollider2D>();
            if (box == null) box = entity.AddComponent<BoxCollider2D>();
            CircleCollider2D circle = entity.GetComponent<CircleCollider2D>();
            if (circle == null) circle = entity.AddComponent<CircleCollider2D>();
            bool useCircle = String(effect, "shape", "box") == "circle";
            box.enabled = !useCircle;
            circle.enabled = useCircle;
            box.isTrigger = false;
            circle.isTrigger = false;
            box.offset = Vector2.zero;
            circle.offset = Vector2.zero;
            box.size = new Vector2(Mathf.Max(0.01f, Float(effect, "boxWidth", 1f)), Mathf.Max(0.01f, Float(effect, "boxHeight", 1f)));
            circle.radius = Mathf.Max(0.01f, Float(effect, "radius", 1f));
            Collider2D entityCollider = useCircle ? (Collider2D)circle : box;
            entityCollider.sharedMaterial = ResolvePhysicalMaterial(effect);

            FrameActionPhysicalEntity2D carrier = entity.GetComponent<FrameActionPhysicalEntity2D>();
            if (carrier == null) carrier = entity.AddComponent<FrameActionPhysicalEntity2D>();
            carrier.Configure(body, entityCollider, player != null ? player.transform : transform, TicksToSeconds(Int(effect, "physicalIgnoreCasterTicks", 30)),
                (targetCollider, hitPoint) =>
                {
                    if (active) DetectPhysicalContact(effect, targetCollider, hitPoint, entity != null ? (Vector2)entity.transform.position : center, hitIds, context);
                });

            JObject motion = effect["motion"] as JObject;
            Vector2 initialVelocity = Vector2.zero;
            if (motion != null && Bool(motion, "enabled"))
            {
                if (String(motion, "mode", "linear") == "bezier")
                {
                    float pathDuration = TicksToSeconds(Mathf.Max(1, Int(motion, "durationTicks", 1)));
                    carrier.ConfigurePath(seconds => ResolveDetectionCenter(effect, sourcePosition, sourceRotation, seconds), pathDuration);
                }
                else
                {
                    initialVelocity = (Vector2)(Quaternion.Euler(0f, 0f, sourceRotation) * EvaluateMotion(motion, 1f));
                }
            }
            if (Bool(effect, "physicalInheritCasterVelocity") && ownerBody != null) initialVelocity += GetBodyVelocity(ownerBody);
            SetBodyVelocity(body, initialVelocity);
            body.angularVelocity = Float(effect, "physicalInitialAngularVelocity") * FacingSign;
            body.WakeUp();
            RegisterLiveObject(entity);

            List<GameObject> companionObjects = new List<GameObject>();
            foreach (JObject cue in Objects(effect["companionVfxEffects"]))
            {
                StartCoroutine(SpawnVfxAfterDelay(cue, center, null, companionObjects, false, entity.transform, context.actionExecutionId, true));
            }

            float elapsed = 0f;
            while (elapsed <= duration + 0.0001f && entity != null && entity.activeInHierarchy)
            {
                bool reachedActivation = elapsed + 0.0001f >= activationDelay;
                float activationElapsed = Mathf.Max(0f, elapsed - activationDelay);
                int activationCycle = ResolveActivationCycleIndex(intermittent, activationElapsed, activeDuration, inactiveDuration, duration - activationDelay);
                active = reachedActivation && IsActivationPhaseActive(intermittent, activationElapsed, activeDuration, inactiveDuration);
                if (active && activationCycle != previousActivationCycle && deduplication == "perActivation") hitIds.Clear();
                if (active && deduplication == "perDetection") hitIds.Clear();
                if (active) previousActivationCycle = activationCycle;
                elapsed += Time.deltaTime;
                yield return null;
            }
            active = false;
            for (int i = companionObjects.Count - 1; i >= 0; i--)
            {
                GameObject companion = companionObjects[i];
                _liveObjects.Remove(companion);
                ReleaseOrDestroy(companion);
            }
            _liveObjects.Remove(entity);
            ReleaseOrDestroy(entity);
        }

        private static bool IsActivationPhaseActive(bool intermittent, float activationElapsed, float activeDuration, float inactiveDuration)
        {
            if (!intermittent) return true;
            float cycleDuration = Mathf.Max(0.0001f, activeDuration + inactiveDuration);
            float cycleSample = Mathf.Max(0f, activationElapsed) + 0.0001f;
            return Mathf.Repeat(cycleSample, cycleDuration) < activeDuration;
        }

        private static int ResolveActivationCycleIndex(bool intermittent, float activationElapsed, float activeDuration, float inactiveDuration, float availableDuration)
        {
            if (!intermittent) return 0;
            float cycleDuration = Mathf.Max(0.0001f, activeDuration + inactiveDuration);
            float cycleSample = Mathf.Max(0f, activationElapsed) + 0.0001f;
            int cycleIndex = Mathf.Max(0, Mathf.FloorToInt(cycleSample / cycleDuration));
            float boundedDuration = Mathf.Max(0f, availableDuration - 0.0001f);
            int cycleCount = Mathf.Max(1, Mathf.CeilToInt(boundedDuration / cycleDuration));
            return Mathf.Min(cycleIndex, cycleCount - 1);
        }

        private void DetectPhysicalContact(JObject effect, Collider2D targetCollider, Vector2 hitPoint, Vector2 effectOrigin, HashSet<int> hitIds, FrameActionEventContext context)
        {
            if (targetCollider == null) return;
            int mask = ResolveMask(String(effect, "hitLayerName", "Enemy"));
            if ((mask & (1 << targetCollider.gameObject.layer)) == 0) return;
            Transform hitTarget = ResolveHitTarget(targetCollider);
            Transform owner = player != null ? player.transform : transform;
            if (hitTarget == null || hitTarget == owner || hitTarget.IsChildOf(owner)) return;
            if (!IsEligibleHurtbox(targetCollider, hitTarget)) return;
            int id = hitTarget.GetInstanceID();
            if (!hitIds.Add(id)) return;
            ApplyHit(effect, targetCollider, hitTarget, hitPoint, effectOrigin, context);
        }

        private void Detect(JObject effect, Vector3 sourcePosition, float sourceRotation, float elapsed, HashSet<int> hitIds, FrameActionEventContext context)
        {
            string detectionType = String(effect, "detectionType", "rangeOverlap");
            int mask = ResolveMask(String(effect, "hitLayerName", "Enemy"));
            Vector2 center = ResolveDetectionCenter(effect, sourcePosition, sourceRotation, elapsed);
            float rotation = ResolveDetectionRotation(effect, sourceRotation);
            Vector2 boxSize = new Vector2(Mathf.Max(0.01f, Float(effect, "boxWidth", 1f)), Mathf.Max(0.01f, Float(effect, "boxHeight", 1f)));
            ApplyBoxGrowth(effect, elapsed, rotation, ref center, ref boxSize);
            IEnumerable<Collider2D> colliders;

            if (detectionType == "raycast")
            {
                Vector2 direction = Quaternion.Euler(0f, 0f, rotation) * Vector2.right;
                float distance = Mathf.Max(0.01f, Float(effect, "rayMaxDistance", 10f));
                float radius = Mathf.Max(0f, Float(effect, "rayRadius"));
                colliders = radius > 0.001f
                    ? Physics2D.CircleCastAll(center, radius, direction, distance, mask).Select(hit => hit.collider)
                    : Physics2D.RaycastAll(center, direction, distance, mask).Select(hit => hit.collider);
            }
            else if (String(effect, "shape", "box") == "box")
            {
                colliders = Physics2D.OverlapBoxAll(center, boxSize, rotation, mask);
            }
            else
            {
                float radius = Mathf.Max(0.01f, Float(effect, "radius", 1f));
                colliders = Physics2D.OverlapCircleAll(center, radius, mask);
                if (String(effect, "shape") == "sector")
                {
                    float halfAngle = Mathf.Max(1f, Float(effect, "sectorAngle", 180f)) * 0.5f;
                    Vector2 forward = Quaternion.Euler(0f, 0f, rotation) * Vector2.right;
                    colliders = colliders.Where(collider => Vector2.Angle(forward, (Vector2)collider.bounds.center - center) <= halfAngle);
                }
            }

            foreach (Collider2D targetCollider in colliders.Where(item => item != null).Distinct())
            {
                Transform hitTarget = ResolveHitTarget(targetCollider);
                Transform owner = player != null ? player.transform : transform;
                if (hitTarget == null || hitTarget == owner || hitTarget.IsChildOf(owner)) continue;
                if (!IsEligibleHurtbox(targetCollider, hitTarget)) continue;
                int id = hitTarget.GetInstanceID();
                if (!hitIds.Add(id)) continue;
                ApplyHit(effect, targetCollider, hitTarget, targetCollider.ClosestPoint(center), center, context);
            }
        }

        private void ApplyHit(JObject effect, Collider2D targetCollider, Transform hitTarget, Vector2 hitPoint, Vector2 effectOrigin, FrameActionEventContext context)
        {
            foreach (JObject damage in Objects(effect["onHitDamageEffects"])) StartCoroutine(ApplyDamageAfterDelay(damage, hitTarget, hitPoint));
            foreach (JObject physics in Objects(effect["onHitPhysicsEffects"])) ApplyPhysicsEffect(physics, targetCollider.attachedRigidbody ?? targetCollider.GetComponentInParent<Rigidbody2D>(), hitTarget, true, effectOrigin, context);
            foreach (JObject cue in Objects(effect["onHitVfxEffects"])) StartCoroutine(SpawnVfxAfterDelay(cue, targetCollider.bounds.center, hitTarget, null, true, null, context.actionExecutionId));
            foreach (JObject cue in Objects(effect["onHitSfxEffects"])) StartCoroutine(PlaySfxAfterDelay(cue, targetCollider.bounds.center, hitTarget, true, context.actionExecutionId));

            JObject hitStop = effect["hitStop"] as JObject;
            if (applyHitStop && hitStop != null && Int(hitStop, "durationTicks") > 0) StartCoroutine(ApplyHitStop(hitStop));
        }

        private IEnumerator ApplyDamageAfterDelay(JObject effect, Transform hitTarget, Vector2 hitPoint)
        {
            float delay = TicksToSeconds(Int(effect, "delayTicks"));
            if (delay > 0f) yield return new WaitForSeconds(delay);
            if (hitTarget == null) yield break;
            IFrameActionDamageReceiver receiver = hitTarget.GetComponentsInParent<MonoBehaviour>(true).OfType<IFrameActionDamageReceiver>().FirstOrDefault();
            receiver?.ReceiveFrameActionDamage(new FrameActionDamageContext(
                player,
                Mathf.Max(0f, Float(effect, "damageMultiplier", 1f)),
                Mathf.Max(0f, Float(effect, "fixedDamage", 0f)),
                hitPoint));
        }

        private void ApplyPhysicsEffect(JObject effect, Rigidbody2D body, Transform targetTransform, bool onHit, Vector2 effectOrigin, FrameActionEventContext context)
        {
            float delay = TicksToSeconds(Int(effect, "delayTicks"));
            StartCoroutine(ApplyPhysicsAfterDelay(effect, body, targetTransform, delay, effectOrigin, context));
        }

        private IEnumerator ApplyPhysicsAfterDelay(JObject effect, Rigidbody2D body, Transform targetTransform, float delay, Vector2 effectOrigin, FrameActionEventContext context)
        {
            if (delay > 0f) yield return new WaitForSeconds(delay);
            bool untilActionEnd = String(effect, "durationMode") == "untilActionEnd";
            if (untilActionEnd && IsExecutionEnded(context.actionExecutionId)) yield break;

            // A map's CompositeCollider2D is backed by a static Rigidbody2D. It can
            // be returned by targetCollider.attachedRigidbody when an attack query
            // overlaps terrain. Static/kinematic bodies are collision surfaces, not
            // actors, and must never receive scripted velocity or knockback.
            if (body != null && body.bodyType != RigidbodyType2D.Dynamic)
                yield break;

            string type = String(effect, "effectType");
            float duration = untilActionEnd
                ? TicksToSeconds(Mathf.Max(1, context.actionDurationTicks - context.currentTick - Int(effect, "delayTicks")))
                : TicksToSeconds(Mathf.Max(1, Int(effect, "durationTicks", 1)));

            Transform target = targetTransform != null ? targetTransform : body != null ? body.transform : player != null ? player.transform : transform;
            if (type == "teleportSelf")
            {
                ApplyTeleport(effect, body, target);
                yield break;
            }
            IFrameActionStatusReceiver status = target.GetComponentsInParent<MonoBehaviour>(true).OfType<IFrameActionStatusReceiver>().FirstOrDefault();
            if (type == "stun" || type == "superArmor" || type == "invincible")
            {
                status?.ApplyFrameActionStatus(type, duration, player);
                yield break;
            }

            Vector2 direction;
            if (type == "dashSelf") direction = player != null && player.facingLeft ? Vector2.left : Vector2.right;
            else if (type == "airborne") direction = Vector2.zero;
            else
            {
                Vector2 sourcePosition = type == "pull"
                    ? effectOrigin
                    : (Vector2)(player != null ? player.transform.position : transform.position);
                float deltaX = target.position.x - sourcePosition.x;
                float horizontalSign = Mathf.Abs(deltaX) > 0.0001f ? Mathf.Sign(deltaX) : FacingSign;
                direction = new Vector2(type == "pull" ? -horizontalSign : horizontalSign, 0f);
            }
            float distance = Float(effect, "distance");
            float height = Float(effect, "height");
            if (body != null)
            {
                FrameActionPhysicsMotion2D motion = body.GetComponent<FrameActionPhysicsMotion2D>();
                if (motion == null) motion = body.gameObject.AddComponent<FrameActionPhysicsMotion2D>();
                int generation = motion.Begin(type, direction, distance, height, duration);
                while (motion.IsActiveFor(generation) && (!untilActionEnd || !IsExecutionEnded(context.actionExecutionId)))
                    yield return new WaitForFixedUpdate();
                motion.Cancel(generation);
                yield break;
            }

            Vector2 start = (Vector2)target.position;
            float elapsed = 0f;
            while (elapsed < duration && (!untilActionEnd || !IsExecutionEnded(context.actionExecutionId)))
            {
                yield return new WaitForFixedUpdate();
                elapsed += Time.fixedDeltaTime;
                float progress = Mathf.Clamp01(elapsed / Mathf.Max(0.0001f, duration));
                Vector2 position = start + direction * distance * progress;
                if (type == "launch" || type == "airborne") position.y += height * 4f * progress * (1f - progress);
                target.position = new Vector3(position.x, position.y, target.position.z);
            }
        }

        private void ApplyTeleport(JObject effect, Rigidbody2D body, Transform actor)
        {
            Transform owner = player != null ? player.transform : actor != null ? actor : transform;
            bool usesTarget = String(effect, "anchor", "self") == "target";
            Transform anchor = usesTarget ? ResolveCurrentTarget() : owner;
            if (anchor == null) return;

            Vector2 start = body != null ? body.position : (Vector2)owner.position;
            float anchorFacingSign = usesTarget ? ResolveFacingSign(anchor, owner) : FacingSign;
            float distance = Float(effect, "distance");
            Vector2 requested = usesTarget
                ? new Vector2(anchor.position.x + distance * anchorFacingSign, anchor.position.y)
                : start + Vector2.right * distance * anchorFacingSign;

            Collider2D bodyCollider = ResolveTeleportCollider(body, owner);
            int environmentMask = ResolveTeleportEnvironmentMask();
            bool grounded = IsGroundedForTeleport(bodyCollider, owner, environmentMask);
            if (!TryResolveTeleportDestination(start, requested, bodyCollider, owner, environmentMask, grounded, out Vector2 destination)) return;

            if (body != null)
            {
                Vector2 velocity = GetBodyVelocity(body);
                velocity.x = 0f;
                if (grounded) velocity.y = 0f;
                body.position = destination;
                SetBodyVelocity(body, velocity);
                body.angularVelocity = 0f;
                body.WakeUp();
            }
            else
            {
                owner.position = new Vector3(destination.x, destination.y, owner.position.z);
            }

            if (usesTarget && player != null && Mathf.Abs(anchor.position.x - destination.x) > 0.0001f)
            {
                player.SetFacingLeft(anchor.position.x < destination.x);
            }
        }

        private Collider2D ResolveTeleportCollider(Rigidbody2D body, Transform owner)
        {
            Collider2D[] colliders = body != null
                ? body.GetComponentsInChildren<Collider2D>(true)
                : owner.GetComponentsInChildren<Collider2D>(true);
            return colliders.FirstOrDefault(item => item != null && item.enabled && !item.isTrigger && (body == null || item.attachedRigidbody == body));
        }

        private int ResolveTeleportEnvironmentMask()
        {
            FrameActionEnemyMotor2D enemyMotor = player != null ? player.GetComponent<FrameActionEnemyMotor2D>() : null;
            if (enemyMotor != null) return enemyMotor.EnvironmentLayerMask;
            FrameActionMotor2D motor = player != null ? player.GetComponent<FrameActionMotor2D>() : null;
            if (motor != null) return motor.GroundLayerMask;
            int groundMask = LayerMask.GetMask("Ground");
            return groundMask != 0 ? groundMask : ~0;
        }

        private bool IsGroundedForTeleport(Collider2D bodyCollider, Transform owner, int environmentMask)
        {
            FrameActionEnemyMotor2D enemyMotor = player != null ? player.GetComponent<FrameActionEnemyMotor2D>() : null;
            if (enemyMotor != null && enemyMotor.IsGrounded) return true;
            FrameActionMotor2D motor = player != null ? player.GetComponent<FrameActionMotor2D>() : null;
            if (motor != null && motor.IsGrounded) return true;
            if (bodyCollider == null || environmentMask == 0) return false;

            Bounds bounds = bodyCollider.bounds;
            Vector2 origin = new Vector2(bounds.center.x, bounds.min.y + 0.04f);
            int count = Physics2D.RaycastNonAlloc(origin, Vector2.down, _teleportCastHits, 0.16f, environmentMask);
            for (int i = 0; i < count; i++)
            {
                RaycastHit2D hit = _teleportCastHits[i];
                if (IsTeleportObstacle(hit.collider, owner) && hit.normal.y > 0.25f) return true;
            }
            return false;
        }

        private bool TryResolveTeleportDestination(Vector2 start, Vector2 requested, Collider2D bodyCollider, Transform owner, int environmentMask, bool alignGround, out Vector2 destination)
        {
            destination = requested;
            if (bodyCollider == null || environmentMask == 0) return true;

            Bounds bounds = bodyCollider.bounds;
            float step = Mathf.Max(0.1f, bounds.extents.x * 0.5f);
            int searchSteps = Mathf.Max(4, Mathf.CeilToInt(Mathf.Max(1f, bounds.size.x * 2f) / step));
            float towardStart = Mathf.Sign(start.x - requested.x);
            if (Mathf.Abs(towardStart) < 0.001f) towardStart = 1f;

            for (int index = 0; index <= searchSteps * 2; index++)
            {
                int ring = (index + 1) / 2;
                float side = index == 0 ? 0f : index % 2 == 1 ? towardStart : -towardStart;
                Vector2 candidate = requested;
                candidate.x += ring * step * side;
                candidate.x = ClampTeleportXByWalls(start.x, candidate.x, bodyCollider, owner, environmentMask);
                if (alignGround && !TryAlignTeleportToGround(start, candidate, bodyCollider, owner, environmentMask, out candidate)) continue;
                if (!IsTeleportDestinationClear(start, candidate, bodyCollider, owner, environmentMask)) continue;
                destination = candidate;
                return true;
            }
            return false;
        }

        private float ClampTeleportXByWalls(float startX, float requestedX, Collider2D bodyCollider, Transform owner, int environmentMask)
        {
            float deltaX = requestedX - startX;
            float distance = Mathf.Abs(deltaX);
            if (distance <= 0.0001f) return requestedX;
            float directionSign = Mathf.Sign(deltaX);
            ContactFilter2D filter = new ContactFilter2D { useTriggers = false, useLayerMask = true, layerMask = environmentMask };
            int count = bodyCollider.Cast(Vector2.right * directionSign, filter, _teleportCastHits, distance + 0.04f);
            float nearest = float.PositiveInfinity;
            for (int i = 0; i < count; i++)
            {
                RaycastHit2D hit = _teleportCastHits[i];
                if (!IsTeleportObstacle(hit.collider, owner) || Mathf.Abs(hit.normal.x) <= 0.25f) continue;
                nearest = Mathf.Min(nearest, hit.distance);
            }
            if (float.IsPositiveInfinity(nearest)) return requestedX;
            return startX + directionSign * Mathf.Min(distance, Mathf.Max(0f, nearest - 0.04f));
        }

        private bool TryAlignTeleportToGround(Vector2 start, Vector2 candidate, Collider2D bodyCollider, Transform owner, int environmentMask, out Vector2 aligned)
        {
            Bounds bounds = bodyCollider.bounds;
            float centerOffsetX = bounds.center.x - start.x;
            float footOffsetY = bounds.min.y - start.y;
            float topOffsetY = bounds.max.y - start.y;
            float extraHeight = Mathf.Max(0.5f, bounds.size.y * 0.5f);
            Vector2 origin = new Vector2(candidate.x + centerOffsetX, candidate.y + topOffsetY + extraHeight);
            float castDistance = Mathf.Max(3f, bounds.size.y * 4f + extraHeight);
            float expectedFootY = candidate.y + footOffsetY;
            float maxRise = Mathf.Max(0.35f, bounds.size.y * 0.5f);
            float maxDrop = Mathf.Max(1f, bounds.size.y * 2f);
            int count = Physics2D.RaycastNonAlloc(origin, Vector2.down, _teleportCastHits, castDistance, environmentMask);
            float nearest = float.PositiveInfinity;
            RaycastHit2D groundHit = default;
            for (int i = 0; i < count; i++)
            {
                RaycastHit2D hit = _teleportCastHits[i];
                if (!IsTeleportObstacle(hit.collider, owner) || hit.normal.y <= 0.25f || hit.distance >= nearest) continue;
                if (hit.point.y > expectedFootY + maxRise || hit.point.y < expectedFootY - maxDrop) continue;
                nearest = hit.distance;
                groundHit = hit;
            }
            if (groundHit.collider == null)
            {
                aligned = candidate;
                return false;
            }
            aligned = new Vector2(candidate.x, groundHit.point.y - footOffsetY + 0.02f);
            return true;
        }

        private bool IsTeleportDestinationClear(Vector2 start, Vector2 candidate, Collider2D bodyCollider, Transform owner, int environmentMask)
        {
            Bounds bounds = bodyCollider.bounds;
            Vector2 center = candidate + (Vector2)bounds.center - start;
            Vector2 size = new Vector2(Mathf.Max(0.02f, bounds.size.x - 0.04f), Mathf.Max(0.02f, bounds.size.y - 0.04f));
            float angle = bodyCollider.transform.eulerAngles.z;
            ContactFilter2D contactFilter = new ContactFilter2D
            {
                useLayerMask = true,
                layerMask = environmentMask,
                useTriggers = Physics2D.queriesHitTriggers
            };
            int count;
            CapsuleCollider2D capsule = bodyCollider as CapsuleCollider2D;
            CircleCollider2D circle = bodyCollider as CircleCollider2D;
            if (capsule != null)
            {
                count = Physics2D.OverlapCapsule(center, size, capsule.direction, angle, contactFilter, _teleportOverlapHits);
            }
            else if (circle != null)
            {
                count = Physics2D.OverlapCircle(center, Mathf.Max(0.01f, Mathf.Min(size.x, size.y) * 0.5f), contactFilter, _teleportOverlapHits);
            }
            else
            {
                count = Physics2D.OverlapBox(center, size, angle, contactFilter, _teleportOverlapHits);
            }
            for (int i = 0; i < count; i++)
            {
                if (IsTeleportObstacle(_teleportOverlapHits[i], owner)) return false;
            }
            return true;
        }

        private static bool IsTeleportObstacle(Collider2D collider, Transform owner)
        {
            if (collider == null || collider.isTrigger || collider.transform.root == owner.root) return false;
            return collider.GetComponentInParent<FrameActionPlayer>() == null;
        }

        private static float ResolveFacingSign(Transform anchor, Transform owner)
        {
            FrameActionPlayer anchorPlayer = anchor.GetComponentInParent<FrameActionPlayer>() ?? anchor.GetComponentInChildren<FrameActionPlayer>();
            if (anchorPlayer != null) return anchorPlayer.facingLeft ? -1f : 1f;
            return anchor.position.x >= owner.position.x ? -1f : 1f;
        }

        private IEnumerator SpawnVfxAfterDelay(JObject effect, Vector2? explicitPosition, Transform explicitTarget = null, List<GameObject> ownedObjects = null, bool forceOneShot = false, Transform ownedParent = null, int actionExecutionId = 0, bool parentLocalSpace = false)
        {
            bool configuredLoop = ownedObjects != null || !forceOneShot && Bool(effect, "loop");
            string configuredDestroyMode = String(effect, "destroyMode", configuredLoop ? "timed" : "natural");
            if (configuredLoop && configuredDestroyMode != "timed" && configuredDestroyMode != "onActionEnd") configuredDestroyMode = "timed";
            bool actionBound = ownedObjects == null && configuredLoop && configuredDestroyMode == "onActionEnd";
            float delay = TicksToSeconds(Int(effect, "triggerDelayTicks"));
            if (delay > 0f) yield return new WaitForSeconds(delay);
            if (actionBound && IsExecutionEnded(actionExecutionId)) yield break;
            List<Sprite> sprites = ResolveVfxSprites(effect);
            if (sprites.Count == 0) yield break;
            Sprite sprite = sprites[0];
            GameObject instance = FrameActionRuntimePool.Acquire(FrameActionPoolKind.Vfx, string.IsNullOrEmpty(sprite.name) ? "FrameAction VFX" : sprite.name);
            SpriteRenderer renderer = instance.GetComponent<SpriteRenderer>();
            if (renderer == null) renderer = instance.AddComponent<SpriteRenderer>();
            renderer.sprite = sprite;
            renderer.sortingLayerName = vfxSortingLayer;
            renderer.sortingOrder = vfxSortingOrder;
            string anchorMode = String(effect, "anchor", "caster");
            Transform anchor = ResolveAnchor(anchorMode, explicitTarget);
            float scale = Mathf.Max(0.01f, Float(effect, "scale", 1f));
            float desiredPixelsPerUnit = Mathf.Max(1f, Float(effect, "pixelsPerUnit", sprite.pixelsPerUnit));
            float visualScale = scale * Mathf.Max(0.0001f, sprite.pixelsPerUnit) / desiredPixelsPerUnit;
            float rotation = Float(effect, "rotation") * FacingSign;
            float pivotX = Mathf.Clamp01(Float(effect, "pivotX", 0.5f));
            float pivotY = Mathf.Clamp01(Float(effect, "pivotY", 0.5f));
            Vector2 pivotOffset = new Vector2(
                (0.5f - pivotX) * sprite.rect.width / desiredPixelsPerUnit * scale * FacingSign,
                (0.5f - pivotY) * sprite.rect.height / desiredPixelsPerUnit * scale);
            pivotOffset = Quaternion.Euler(0f, 0f, rotation) * pivotOffset;
            Vector2 localVisualOffset = new Vector2(Float(effect, "x") * FacingSign, Float(effect, "y")) + pivotOffset;
            if (parentLocalSpace && ownedParent != null)
            {
                instance.transform.SetParent(ownedParent, false);
                instance.transform.localPosition = new Vector3(localVisualOffset.x, localVisualOffset.y, 0f);
                instance.transform.localRotation = Quaternion.Euler(0f, 0f, rotation);
                instance.transform.localScale = new Vector3(visualScale * FacingSign, visualScale, visualScale);
            }
            else
            {
                Vector2 position = anchorMode == "world" && explicitPosition.HasValue
                    ? explicitPosition.Value
                    : anchor != null ? (Vector2)anchor.position : explicitPosition ?? (Vector2)transform.position;
                position += localVisualOffset;
                instance.transform.position = new Vector3(position.x, position.y, 0f);
                instance.transform.rotation = Quaternion.Euler(0f, 0f, rotation);
                instance.transform.localScale = new Vector3(visualScale * FacingSign, visualScale, visualScale);
                if (ownedParent != null) instance.transform.SetParent(ownedParent, true);
            }
            bool loop = configuredLoop;
            float fps = Mathf.Max(1f, Float(effect, "fps", 12f));
            FrameActionPoolLease poolLease = instance.GetComponent<FrameActionPoolLease>();
            int poolGeneration = poolLease != null ? poolLease.generation : 0;
            StartCoroutine(AnimateVfxFrames(instance, poolGeneration, renderer, sprites, fps, loop));

            JObject motion = effect["motion"] as JObject;
            bool followsAnchor = anchorMode != "world" && anchor != null;
            bool limitedFollow = followsAnchor && Bool(effect, "useFollowDuration");
            float followDuration = limitedFollow ? TicksToSeconds(Int(effect, "followDurationTicks")) : float.PositiveInfinity;
            if (followsAnchor || motion != null && Bool(motion, "enabled"))
            {
                StartCoroutine(AnimateVfx(instance, poolGeneration, motion, followsAnchor ? anchor : null, followDuration, player != null ? player.transform : transform, localVisualOffset));
            }

            string destroyMode = configuredDestroyMode;
            if (ownedObjects != null)
            {
                ownedObjects.Add(instance);
                RegisterLiveObject(instance);
            }
            else if (loop && destroyMode == "timed") FrameActionRuntimePool.ReleaseAfter(instance, TicksToSeconds(Mathf.Max(1, Int(effect, "durationTicks", 1))));
            else if (actionBound) RegisterActionBoundObject(actionExecutionId, instance);
            else FrameActionRuntimePool.ReleaseAfter(instance, Mathf.Max(0.01f, sprites.Count / fps));
        }

        private IEnumerator AnimateVfxFrames(GameObject instance, int generation, SpriteRenderer renderer, List<Sprite> sprites, float fps, bool loop)
        {
            float elapsed = 0f;
            float frameDuration = 1f / Mathf.Max(1f, fps);
            while (renderer != null && IsCurrentPoolLease(instance, generation))
            {
                int frameIndex = Mathf.FloorToInt(elapsed / frameDuration);
                if (frameIndex >= sprites.Count)
                {
                    if (!loop) yield break;
                    frameIndex %= sprites.Count;
                }
                renderer.sprite = sprites[frameIndex];
                elapsed += Time.deltaTime;
                yield return null;
            }
        }

        private IEnumerator AnimateVfx(GameObject instance, int generation, JObject motion, Transform anchor, float followDuration, Transform retargetTransform, Vector2 retargetLocalOffset)
        {
            Transform target = instance != null ? instance.transform : null;
            if (target == null) yield break;
            Vector3 start = target.position;
            Vector3 anchorStart = anchor != null ? anchor.position : Vector3.zero;
            Vector3 anchorDelta = Vector3.zero;
            float elapsed = 0f;
            bool motionEnabled = motion != null && Bool(motion, "enabled");
            bool bezier = motionEnabled && String(motion, "mode", "linear") == "bezier";
            float motionDuration = bezier ? TicksToSeconds(Mathf.Max(1, Int(motion, "durationTicks", 1))) : float.PositiveInfinity;
            while (target != null && IsCurrentPoolLease(instance, generation))
            {
                bool following = anchor != null && (float.IsPositiveInfinity(followDuration) || elapsed <= followDuration);
                if (following) anchorDelta = anchor.position - anchorStart;

                Vector2 motionOffset = motionEnabled ? EvaluateMotion(motion, elapsed) : Vector2.zero;
                Vector2 retargetPosition = Vector2.zero;
                Vector2 recoveryPoint = retargetTransform != null
                    ? (Vector2)retargetTransform.TransformPoint(new Vector3(retargetLocalOffset.x, retargetLocalOffset.y, 0f))
                    : (Vector2)(start + anchorDelta);
                bool retargeted = motionEnabled && TryEvaluateRetargetedWorldPosition(motion, start + anchorDelta, Quaternion.identity, recoveryPoint, elapsed, out retargetPosition);
                target.position = retargeted ? (Vector3)retargetPosition : start + anchorDelta + (Vector3)motionOffset;

                bool followActive = anchor != null && (float.IsPositiveInfinity(followDuration) || elapsed < followDuration);
                bool motionActive = motionEnabled && (!bezier || elapsed < motionDuration);
                if (!followActive && !motionActive) yield break;
                elapsed += Time.deltaTime;
                yield return null;
            }
        }

        private static bool IsCurrentPoolLease(GameObject instance, int generation)
        {
            if (instance == null || !instance.activeInHierarchy) return false;
            FrameActionPoolLease lease = instance.GetComponent<FrameActionPoolLease>();
            return lease != null && !lease.inPool && lease.generation == generation;
        }

        private IEnumerator PlaySfxAfterDelay(JObject effect, Vector2? explicitPosition, Transform explicitTarget = null, bool forceOneShot = false, int actionExecutionId = 0)
        {
            bool configuredLoop = !forceOneShot && Bool(effect, "loop");
            string configuredDestroyMode = String(effect, "destroyMode", configuredLoop ? "timed" : "natural");
            if (configuredLoop && configuredDestroyMode != "timed" && configuredDestroyMode != "onActionEnd") configuredDestroyMode = "timed";
            bool actionBound = configuredLoop && configuredDestroyMode == "onActionEnd";
            float delay = TicksToSeconds(Int(effect, "triggerDelayTicks"));
            if (delay > 0f) yield return new WaitForSeconds(delay);
            if (actionBound && IsExecutionEnded(actionExecutionId)) yield break;
            AudioClip clip = player?.characterAsset?.FindAsset<AudioClip>(String(effect, "assetId"));
            if (clip == null) yield break;
            string anchorMode = String(effect, "anchor", "caster");
            Transform anchor = ResolveAnchor(anchorMode, explicitTarget);
            Vector2 position = anchorMode == "world" && explicitPosition.HasValue
                ? explicitPosition.Value
                : anchor != null ? (Vector2)anchor.position : explicitPosition ?? (Vector2)transform.position;
            position += new Vector2(Float(effect, "x") * FacingSign, Float(effect, "y"));
            GameObject instance = FrameActionRuntimePool.Acquire(FrameActionPoolKind.Sfx, $"FrameAction SFX {clip.name}");
            instance.transform.position = new Vector3(position.x, position.y, 0f);
            if (anchorMode != "world" && anchor != null) instance.transform.SetParent(anchor, true);
            AudioSource source = instance.GetComponent<AudioSource>();
            if (source == null) source = instance.AddComponent<AudioSource>();
            source.clip = clip;
            source.loop = configuredLoop;
            source.volume = 1f;
            source.spatialBlend = 0f;
            source.Play();
            string destroyMode = configuredDestroyMode;
            if (!source.loop) FrameActionRuntimePool.ReleaseAfter(instance, Mathf.Max(0.05f, clip.length));
            else if (destroyMode == "timed") FrameActionRuntimePool.ReleaseAfter(instance, TicksToSeconds(Mathf.Max(1, Int(effect, "durationTicks", 1))));
            else if (actionBound) RegisterActionBoundObject(actionExecutionId, instance);
        }

        private IEnumerator ApplyHitStop(JObject effect)
        {
            float duration = TicksToSeconds(Int(effect, "durationTicks"));
            if (!_hitStopActive)
            {
                _timeScaleBeforeHitStop = Time.timeScale;
                _hitStopActive = true;
            }
            int version = ++_hitStopVersion;
            Time.timeScale = Mathf.Clamp01(Float(effect, "timeScale"));
            _hitStopReceiver?.SetFrameActionHitStop(true, Bool(effect, "pauseCamera"));
            yield return new WaitForSecondsRealtime(duration);
            if (version == _hitStopVersion) RestoreHitStop();
        }

        private Vector2 ResolveDetectionCenter(JObject effect, Vector3 sourcePosition, float sourceRotation, float elapsed)
        {
            string detectionType = String(effect, "detectionType", "rangeOverlap");
            Vector2 local = detectionType == "raycast"
                ? new Vector2(Float(effect, "rayOriginX"), Float(effect, "rayOriginY"))
                : new Vector2(Float(effect, "centerX"), Float(effect, "centerY"));
            local.x *= FacingSign;
            Quaternion basisRotation = Quaternion.Euler(0f, 0f, sourceRotation);
            Vector2 origin = (Vector2)sourcePosition + (Vector2)(basisRotation * local);
            JObject motion = effect["motion"] as JObject;
            Transform recoveryTransform = player != null ? player.transform : transform;
            Quaternion recoveryRotation = Quaternion.Euler(0f, 0f, recoveryTransform.eulerAngles.z);
            Vector2 recoveryPoint = (Vector2)recoveryTransform.position + (Vector2)(recoveryRotation * local);
            Vector2 retargeted;
            if (TryEvaluateRetargetedWorldPosition(motion, origin, basisRotation, recoveryPoint, elapsed, out retargeted)) return retargeted;
            return origin + (Vector2)(basisRotation * EvaluateMotion(motion, elapsed));
        }

        private Vector2 ResolveDetectionVisualCenter(JObject effect, Vector3 sourcePosition, float sourceRotation, float elapsed)
        {
            Vector2 center = ResolveDetectionCenter(effect, sourcePosition, sourceRotation, elapsed);
            Vector2 size = new Vector2(Mathf.Max(0.01f, Float(effect, "boxWidth", 1f)), Mathf.Max(0.01f, Float(effect, "boxHeight", 1f)));
            ApplyBoxGrowth(effect, elapsed, ResolveDetectionRotation(effect, sourceRotation), ref center, ref size);
            return center;
        }

        private void ApplyBoxGrowth(JObject effect, float elapsed, float rotation, ref Vector2 center, ref Vector2 size)
        {
            if (!Bool(effect, "boxGrowthEnabled")
                || String(effect, "detectionType", "rangeOverlap") != "rangeOverlap"
                || String(effect, "shape", "box") != "box") return;

            float growthDuration = TicksToSeconds(Mathf.Max(1, Int(effect, "boxGrowthDurationTicks", (player?.TickRate ?? 600) * 2)));
            float extension = Mathf.Max(0f, Float(effect, "boxGrowthSpeed", 4f)) * Mathf.Clamp(elapsed, 0f, growthDuration);
            string direction = String(effect, "boxGrowthDirection", "right");
            Vector2 localDirection;
            switch (direction)
            {
                case "up":
                    localDirection = Vector2.up;
                    size.y += extension;
                    break;
                case "down":
                    localDirection = Vector2.down;
                    size.y += extension;
                    break;
                case "left":
                    localDirection = Vector2.left * FacingSign;
                    size.x += extension;
                    break;
                default:
                    localDirection = Vector2.right * FacingSign;
                    size.x += extension;
                    break;
            }
            center += (Vector2)(Quaternion.Euler(0f, 0f, rotation) * localDirection) * (extension * 0.5f);
        }

        private float ResolveDetectionRotation(JObject effect, float sourceRotation)
        {
            float localRotation = Float(effect, "rotation");
            bool directional = String(effect, "detectionType", "rangeOverlap") == "raycast"
                || String(effect, "shape", "box") == "sector";
            if (directional && FacingSign < 0f) localRotation = 180f - localRotation;
            else localRotation *= FacingSign;
            return sourceRotation + localRotation;
        }

        private Vector2 EvaluateMotion(JObject motion, float elapsed)
        {
            if (motion == null || !Bool(motion, "enabled")) return Vector2.zero;
            if (String(motion, "mode", "linear") == "bezier")
            {
                float duration = TicksToSeconds(Mathf.Max(1, Int(motion, "durationTicks", 1)));
                return CubicBezier(Vector2.zero,
                    new Vector2(Float(motion, "controlAX") * FacingSign, Float(motion, "controlAY")),
                    new Vector2(Float(motion, "controlBX") * FacingSign, Float(motion, "controlBY")),
                    new Vector2(Float(motion, "endX") * FacingSign, Float(motion, "endY")), EvaluateProgressCurve(motion["pathProgressCurve"], elapsed / duration));
            }
            Vector2 direction = new Vector2(Float(motion, "directionX", 1f) * FacingSign, Float(motion, "directionY")).normalized;
            return direction * Float(motion, "speed") * elapsed;
        }

        private bool TryEvaluateRetargetedWorldPosition(JObject motion, Vector2 origin, Quaternion basisRotation, Vector2 recoveryPoint, float elapsed, out Vector2 worldPosition)
        {
            worldPosition = origin;
            if (motion == null || !Bool(motion, "enabled") || String(motion, "mode", "linear") != "bezier" || !Bool(motion, "retargetOnDescendingPath")) return false;
            float duration = TicksToSeconds(Mathf.Max(1, Int(motion, "durationTicks", 1)));
            float normalizedTime = Mathf.Clamp01(elapsed / Mathf.Max(0.0001f, duration));
            float progress = EvaluateProgressCurve(motion["pathProgressCurve"], normalizedTime);
            float maxProgress = EvaluateMaxProgressUntil(motion["pathProgressCurve"], normalizedTime);
            if (maxProgress <= 0.0001f || progress >= maxProgress - 0.0001f) return false;
            Vector2 farthest = origin + (Vector2)(basisRotation * CubicBezier(Vector2.zero,
                new Vector2(Float(motion, "controlAX") * FacingSign, Float(motion, "controlAY")),
                new Vector2(Float(motion, "controlBX") * FacingSign, Float(motion, "controlBY")),
                new Vector2(Float(motion, "endX") * FacingSign, Float(motion, "endY")), maxProgress));
            float returnLerp = Mathf.Clamp01(1f - progress / maxProgress);
            worldPosition = Vector2.Lerp(farthest, recoveryPoint, returnLerp);
            return true;
        }

        private void ApplyCamera(FrameActionEventContext context)
        {
            JObject parameters = context.data.parameters ?? new JObject();
            int durationTicks = String(parameters, "durationMode") == "untilActionEnd"
                ? Mathf.Max(1, context.actionDurationTicks - context.data.startTick)
                : Mathf.Max(1, context.data.durationTicks);
            float elapsedTicks = durationTicks * Mathf.Clamp01(context.progress);
            float remainingTicks = Mathf.Max(0f, durationTicks - elapsedTicks);
            float blendInTicks = Mathf.Max(0f, Float(parameters, "blendInTicks"));
            float blendOutTicks = Mathf.Max(0f, Float(parameters, "blendOutTicks"));
            float blend = Mathf.Min(
                blendInTicks > 0f ? Mathf.Clamp01(elapsedTicks / blendInTicks) : 1f,
                blendOutTicks > 0f ? Mathf.Clamp01(remainingTicks / blendOutTicks) : 1f);
            float pathProgress = EvaluateProgressCurve(parameters["pathProgressCurve"], context.progress);
            Vector2 offset = String(parameters, "positionMode", "hold") == "bezier"
                ? CubicBezier(
                    new Vector2(Float(parameters, "pathStartX") * FacingSign, Float(parameters, "pathStartY")),
                    new Vector2(Float(parameters, "controlAX") * FacingSign, Float(parameters, "controlAY")),
                    new Vector2(Float(parameters, "controlBX") * FacingSign, Float(parameters, "controlBY")),
                    new Vector2(Float(parameters, "endX") * FacingSign, Float(parameters, "endY")), pathProgress)
                : new Vector2(Float(parameters, "offsetX") * FacingSign, Float(parameters, "offsetY"));
            offset *= blend;
            float zoom = Mathf.Lerp(1f, Mathf.Max(0.01f, Float(parameters, "zoom", 1f)), blend);
            if (_cameraReceiver != null) _cameraReceiver.ApplyFrameActionCamera(offset, zoom, context.progress);
            else if (previewCamera != null)
            {
                previewCamera.transform.position = _cameraBasePosition + new Vector3(offset.x, offset.y, 0f);
                if (previewCamera.orthographic) previewCamera.orthographicSize = _cameraBaseSize / zoom;
            }
        }

        private void CaptureCamera()
        {
            if (_cameraCaptured || previewCamera == null) return;
            _cameraBasePosition = previewCamera.transform.position;
            _cameraBaseSize = previewCamera.orthographicSize;
            _cameraCaptured = true;
        }

        private void ClearCamera()
        {
            if (_cameraReceiver != null)
            {
                _cameraReceiver.ClearFrameActionCamera();
            }
            else if (_cameraCaptured && previewCamera != null)
            {
                previewCamera.transform.position = _cameraBasePosition;
                if (previewCamera.orthographic) previewCamera.orthographicSize = _cameraBaseSize;
            }
            _cameraCaptured = false;
        }

        private static Transform ResolveHitTarget(Collider2D collider)
        {
            if (collider == null) return null;
            MonoBehaviour damageReceiver = collider.GetComponentsInParent<MonoBehaviour>(true)
                .FirstOrDefault(component => component is IFrameActionDamageReceiver);
            if (damageReceiver != null) return damageReceiver.transform;
            MonoBehaviour statusReceiver = collider.GetComponentsInParent<MonoBehaviour>(true)
                .FirstOrDefault(component => component is IFrameActionStatusReceiver);
            if (statusReceiver != null) return statusReceiver.transform;
            if (collider.attachedRigidbody != null) return collider.attachedRigidbody.transform;
            return collider.transform;
        }

        private static bool IsEligibleHurtbox(Collider2D collider, Transform hitTarget)
        {
            FrameActionHurtbox2D[] configured = hitTarget.GetComponentsInChildren<FrameActionHurtbox2D>(true);
            if (configured == null || configured.Length == 0) return true;
            for (int i = 0; i < configured.Length; i++)
            {
                FrameActionHurtbox2D hurtbox = configured[i];
                if (hurtbox != null && (hurtbox.hurtboxCollider == collider || hurtbox.GetComponent<Collider2D>() == collider)) return true;
            }
            return false;
        }

        private Transform ResolveAnchor(string anchor, Transform explicitTarget = null)
        {
            if (anchor == "target")
            {
                Transform target = ResolveCurrentTarget(explicitTarget);
                if (target != null) return target;
            }
            return player != null ? player.transform : transform;
        }

        private Transform ResolveCurrentTarget(Transform explicitTarget = null)
        {
            if (explicitTarget != null) return explicitTarget;
            if (_targetProvider == null)
            {
                _targetProvider = GetComponentsInParent<MonoBehaviour>(true).OfType<IFrameActionTargetProvider>().FirstOrDefault();
            }
            Transform provided = _targetProvider?.ResolveFrameActionTarget();
            return provided != null ? provided : defaultTarget;
        }

        private List<Sprite> ResolveVfxSprites(JObject effect)
        {
            List<Sprite> sprites = new List<Sprite>();
            JArray frameAssetIds = effect?["frameAssetIds"] as JArray;
            if (frameAssetIds != null)
            {
                for (int i = 0; i < frameAssetIds.Count; i++)
                {
                    string assetId = frameAssetIds[i]?.Value<string>();
                    Sprite sprite = player?.characterAsset?.FindAsset<Sprite>(assetId);
                    if (sprite != null) sprites.Add(sprite);
                }
            }
            if (sprites.Count == 0)
            {
                Sprite legacy = player?.characterAsset?.FindAsset<Sprite>(String(effect, "assetId"));
                if (legacy != null) sprites.Add(legacy);
            }
            return sprites;
        }

        private int ResolveMask(string layerName)
        {
            int mask = string.IsNullOrEmpty(layerName) ? 0 : LayerMask.GetMask(layerName);
            return mask != 0 ? mask : defaultTargetLayers.value;
        }

        private PhysicsMaterial2D ResolvePhysicalMaterial(JObject effect)
        {
            float friction = Mathf.Clamp01(Float(effect, "physicalFriction", 0.6f));
            float bounciness = Mathf.Clamp01(Float(effect, "physicalBounciness"));
            string key = $"{Mathf.RoundToInt(friction * 1000f)}:{Mathf.RoundToInt(bounciness * 1000f)}";
            if (_physicalMaterials.TryGetValue(key, out PhysicsMaterial2D material) && material != null) return material;
            material = new PhysicsMaterial2D($"FrameAction Physical {key}")
            {
                friction = friction,
                bounciness = bounciness,
            };
            _physicalMaterials[key] = material;
            return material;
        }

        private static Vector2 GetBodyVelocity(Rigidbody2D body)
        {
            if (body == null) return Vector2.zero;
#if UNITY_6000_0_OR_NEWER
            return body.linearVelocity;
#else
            return body.velocity;
#endif
        }

        private static void SetBodyVelocity(Rigidbody2D body, Vector2 velocity)
        {
            if (body == null) return;
#if UNITY_6000_0_OR_NEWER
            body.linearVelocity = velocity;
#else
            body.velocity = velocity;
#endif
        }

        private bool IsExecutionEnded(int executionId)
        {
            return executionId > 0 && executionId <= _lastEndedExecutionId;
        }

        private static string CameraEventKey(FrameActionEventContext context)
        {
            return $"{context.actionExecutionId}:{context.data.id}";
        }

        private void RegisterLiveObject(GameObject instance)
        {
            if (instance != null && !_liveObjects.Contains(instance)) _liveObjects.Add(instance);
        }

        private void RegisterActionBoundObject(int executionId, GameObject instance)
        {
            if (instance == null) return;
            if (IsExecutionEnded(executionId))
            {
                ReleaseOrDestroy(instance);
                return;
            }
            RegisterLiveObject(instance);
            if (!_actionBoundObjects.TryGetValue(executionId, out List<GameObject> objects))
            {
                objects = new List<GameObject>();
                _actionBoundObjects[executionId] = objects;
            }
            if (!objects.Contains(instance)) objects.Add(instance);
        }

        private void HandleActionExecutionEnded(int executionId)
        {
            _lastEndedExecutionId = Mathf.Max(_lastEndedExecutionId, executionId);
            if (_actionBoundObjects.TryGetValue(executionId, out List<GameObject> objects))
            {
                for (int i = objects.Count - 1; i >= 0; i--)
                {
                    GameObject instance = objects[i];
                    _liveObjects.Remove(instance);
                    ReleaseOrDestroy(instance);
                }
                _actionBoundObjects.Remove(executionId);
            }
            string prefix = $"{executionId}:";
            foreach (string key in _fixedRepeatedAnchors.Keys.Where(key => key.StartsWith(prefix, StringComparison.Ordinal)).ToArray()) _fixedRepeatedAnchors.Remove(key);
        }

        private void CleanupAllState()
        {
            StopAllCoroutines();
            for (int i = _liveObjects.Count - 1; i >= 0; i--) ReleaseOrDestroy(_liveObjects[i]);
            _liveObjects.Clear();
            _actionBoundObjects.Clear();
            _fixedRepeatedAnchors.Clear();
            _activeCameraEvents.Clear();
            foreach (PhysicsMaterial2D material in _physicalMaterials.Values) if (material != null) Destroy(material);
            _physicalMaterials.Clear();
            RestoreHitStop();
            ClearCamera();
        }

        private void RestoreHitStop()
        {
            if (!_hitStopActive) return;
            Time.timeScale = _timeScaleBeforeHitStop;
            _hitStopActive = false;
            _hitStopReceiver?.SetFrameActionHitStop(false, false);
        }

        private static void ReleaseOrDestroy(GameObject instance)
        {
            if (instance == null) return;
            if (instance.GetComponent<FrameActionPoolLease>() != null) FrameActionRuntimePool.Release(instance);
            else Destroy(instance);
        }

        private float TicksToSeconds(int ticks) => Mathf.Max(0, ticks) / (float)Mathf.Max(1, player?.TickRate ?? 600);

        private static IEnumerable<JObject> Objects(JToken token) => token is JArray array ? array.OfType<JObject>() : Enumerable.Empty<JObject>();
        private static string String(JObject value, string key, string fallback = "") => value?[key]?.Value<string>() ?? fallback;
        private static int Int(JObject value, string key, int fallback = 0) => value?[key]?.Value<int?>() ?? fallback;
        private static float Float(JObject value, string key, float fallback = 0f) => value?[key]?.Value<float?>() ?? fallback;
        private static bool Bool(JObject value, string key, bool fallback = false) => value?[key]?.Value<bool?>() ?? fallback;

        private static float EvaluateProgressCurve(JToken token, float normalizedTime)
        {
            float time = Mathf.Clamp01(normalizedTime);
            if (!(token is JArray array) || array.Count < 2) return time;
            List<JObject> keys = array.OfType<JObject>().OrderBy(item => Float(item, "time")).ToList();
            if (keys.Count < 2) return time;
            if (time <= Float(keys[0], "time")) return Mathf.Clamp01(Float(keys[0], "value"));
            for (int i = 1; i < keys.Count; i++)
            {
                float rightTime = Mathf.Clamp01(Float(keys[i], "time"));
                if (time > rightTime) continue;
                float leftTime = Mathf.Clamp01(Float(keys[i - 1], "time"));
                float leftValue = Mathf.Clamp01(Float(keys[i - 1], "value"));
                float rightValue = Mathf.Clamp01(Float(keys[i], "value"));
                float range = Mathf.Max(0.0001f, rightTime - leftTime);
                float progress = Mathf.InverseLerp(leftTime, rightTime, time);
                float outTangent = EvaluateCurveTangent(keys, i - 1, false) * range;
                float inTangent = EvaluateCurveTangent(keys, i, true) * range;
                float squared = progress * progress;
                float cubed = squared * progress;
                float value = (2f * cubed - 3f * squared + 1f) * leftValue
                    + (cubed - 2f * squared + progress) * outTangent
                    + (-2f * cubed + 3f * squared) * rightValue
                    + (cubed - squared) * inTangent;
                return Mathf.Clamp01(value);
            }
            return Mathf.Clamp01(Float(keys[keys.Count - 1], "value", 1f));
        }

        private static float EvaluateCurveTangent(List<JObject> keys, int index, bool incoming)
        {
            string mode = String(keys[index], "tangentMode", "linear");
            if (mode == "flat") return 0f;
            float? left = index > 0 ? EvaluateCurveSlope(keys, index - 1, index) : (float?)null;
            float? right = index < keys.Count - 1 ? EvaluateCurveSlope(keys, index, index + 1) : (float?)null;
            if (mode == "linear") return incoming ? left ?? right ?? 0f : right ?? left ?? 0f;
            if (left.HasValue && right.HasValue) return (left.Value + right.Value) * 0.5f;
            return left ?? right ?? 0f;
        }

        private static float EvaluateMaxProgressUntil(JToken token, float normalizedTime)
        {
            float clampedTime = Mathf.Clamp01(normalizedTime);
            int sampleCount = Mathf.Max(2, Mathf.CeilToInt(clampedTime * 24f));
            float maxProgress = 0f;
            for (int i = 0; i <= sampleCount; i++)
            {
                float sampleTime = clampedTime * (i / (float)sampleCount);
                maxProgress = Mathf.Max(maxProgress, EvaluateProgressCurve(token, sampleTime));
            }
            return maxProgress;
        }

        private static float EvaluateCurveSlope(List<JObject> keys, int fromIndex, int toIndex)
        {
            float fromTime = Mathf.Clamp01(Float(keys[fromIndex], "time"));
            float toTime = Mathf.Clamp01(Float(keys[toIndex], "time"));
            float fromValue = Mathf.Clamp01(Float(keys[fromIndex], "value"));
            float toValue = Mathf.Clamp01(Float(keys[toIndex], "value"));
            return (toValue - fromValue) / Mathf.Max(0.0001f, toTime - fromTime);
        }

        private static Vector2 CubicBezier(Vector2 start, Vector2 a, Vector2 b, Vector2 end, float progress)
        {
            float t = Mathf.Clamp01(progress);
            float inverse = 1f - t;
            return inverse * inverse * inverse * start
                + 3f * inverse * inverse * t * a
                + 3f * inverse * t * t * b
                + t * t * t * end;
        }

    }
}
