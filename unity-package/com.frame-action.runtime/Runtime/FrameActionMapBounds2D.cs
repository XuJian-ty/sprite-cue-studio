using System;
using UnityEngine;

namespace FrameAction
{
    /// <summary>
    /// Final safety net for authored horizontal map limits. Solid wall colliders handle
    /// ordinary motion; this guard catches scripted knockback, dash, and direct position
    /// changes that could otherwise keep forcing a dynamic actor through a wall.
    /// </summary>
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(32000)]
    public sealed class FrameActionMapBounds2D : MonoBehaviour
    {
        public float localMinX;
        public float localMaxX = 1f;
        public float innerPadding = 0.02f;
        public bool playersOnly = true;
        public string playerTag = "Player";

        private FrameActionPlayer[] _players = Array.Empty<FrameActionPlayer>();
        private float _nextRefreshTime;

        private void OnEnable()
        {
            _nextRefreshTime = 0f;
            RefreshPlayers();
        }

        private void FixedUpdate()
        {
            ConstrainKnownPlayers();
        }

        private void LateUpdate()
        {
            if (Time.unscaledTime >= _nextRefreshTime) RefreshPlayers();
            ConstrainKnownPlayers();
        }

        private void RefreshPlayers()
        {
#if UNITY_2023_1_OR_NEWER
            _players = FindObjectsByType<FrameActionPlayer>(FindObjectsInactive.Exclude, FindObjectsSortMode.None);
#else
            _players = FindObjectsOfType<FrameActionPlayer>();
#endif
            _nextRefreshTime = Time.unscaledTime + 0.5f;
        }

        private void ConstrainKnownPlayers()
        {
            float first = transform.TransformPoint(new Vector3(localMinX, 0f, 0f)).x;
            float second = transform.TransformPoint(new Vector3(localMaxX, 0f, 0f)).x;
            float minimumX = Mathf.Min(first, second) + Mathf.Max(0f, innerPadding);
            float maximumX = Mathf.Max(first, second) - Mathf.Max(0f, innerPadding);
            if (maximumX <= minimumX) return;

            for (int index = 0; index < _players.Length; index++)
            {
                FrameActionPlayer player = _players[index];
                if (player == null || !player.isActiveAndEnabled || playersOnly && !HasPlayerIdentity(player.transform)) continue;
                Rigidbody2D body = player.GetComponent<Rigidbody2D>();
                if (body == null || !body.simulated || body.bodyType != RigidbodyType2D.Dynamic) continue;
                Collider2D bodyCollider = ResolveBodyCollider(player, body);
                if (bodyCollider == null) continue;

                Bounds bounds = bodyCollider.bounds;
                float correction = bounds.min.x < minimumX
                    ? minimumX - bounds.min.x
                    : bounds.max.x > maximumX
                        ? maximumX - bounds.max.x
                        : 0f;
                if (Mathf.Abs(correction) <= 0.0001f) continue;

                body.position += Vector2.right * correction;
                Vector2 velocity = BodyVelocity(body);
                if (velocity.x * correction < 0f) velocity.x = 0f;
                SetBodyVelocity(body, velocity);
                body.GetComponent<FrameActionPhysicsMotion2D>()?.StopAtHorizontalBoundary(Mathf.Sign(correction));
                body.WakeUp();
            }
        }

        private bool HasPlayerIdentity(Transform candidate)
        {
            if (string.IsNullOrWhiteSpace(playerTag)) return true;
            Transform current = candidate;
            while (current != null)
            {
                if (current.CompareTag(playerTag)) return true;
                current = current.parent;
            }
            return false;
        }

        private static Collider2D ResolveBodyCollider(FrameActionPlayer player, Rigidbody2D body)
        {
            Collider2D[] colliders = player.GetComponentsInChildren<Collider2D>(true);
            for (int index = 0; index < colliders.Length; index++)
            {
                Collider2D candidate = colliders[index];
                if (candidate != null && candidate.enabled && !candidate.isTrigger && candidate.attachedRigidbody == body) return candidate;
            }
            return null;
        }

        private static Vector2 BodyVelocity(Rigidbody2D body)
        {
#if UNITY_6000_0_OR_NEWER
            return body.linearVelocity;
#else
            return body.velocity;
#endif
        }

        private static void SetBodyVelocity(Rigidbody2D body, Vector2 velocity)
        {
#if UNITY_6000_0_OR_NEWER
            body.linearVelocity = velocity;
#else
            body.velocity = velocity;
#endif
        }
    }
}
