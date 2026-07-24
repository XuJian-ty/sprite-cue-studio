using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace FrameAction
{
    [DisallowMultipleComponent]
    public sealed class FrameActionPhysicalEntity2D : MonoBehaviour, IFrameActionPoolable
    {
        private readonly List<Collider2D> _ignoredOwnerColliders = new List<Collider2D>();
        private Rigidbody2D _body;
        private Collider2D _entityCollider;
        private Action<Collider2D, Vector2> _onContact;
        private Func<float, Vector2> _pathPosition;
        private float _pathDuration;
        private float _pathElapsed;
        private Coroutine _restoreOwnerCollision;

        public void Configure(
            Rigidbody2D body,
            Collider2D entityCollider,
            Transform owner,
            float ignoreOwnerSeconds,
            Action<Collider2D, Vector2> onContact)
        {
            ResetState();
            _body = body;
            _entityCollider = entityCollider;
            _onContact = onContact;
            if (_body != null) _body.simulated = true;
            if (_entityCollider != null) _entityCollider.enabled = true;

            if (_entityCollider == null || owner == null || ignoreOwnerSeconds <= 0f) return;
            foreach (Collider2D ownerCollider in owner.GetComponentsInChildren<Collider2D>(true))
            {
                if (ownerCollider == null || ownerCollider == _entityCollider) continue;
                Physics2D.IgnoreCollision(_entityCollider, ownerCollider, true);
                _ignoredOwnerColliders.Add(ownerCollider);
            }
            if (_ignoredOwnerColliders.Count > 0) _restoreOwnerCollision = StartCoroutine(RestoreOwnerCollisionsAfter(ignoreOwnerSeconds));
        }

        public void ConfigurePath(Func<float, Vector2> positionAtSeconds, float durationSeconds)
        {
            _pathPosition = positionAtSeconds;
            _pathDuration = Mathf.Max(0f, durationSeconds);
            _pathElapsed = 0f;
        }

        public void ResetState()
        {
            if (_restoreOwnerCollision != null)
            {
                StopCoroutine(_restoreOwnerCollision);
                _restoreOwnerCollision = null;
            }
            RestoreOwnerCollisions();
            _onContact = null;
            _pathPosition = null;
            _pathDuration = 0f;
            _pathElapsed = 0f;
            if (_entityCollider != null) _entityCollider.enabled = false;
            if (_body != null)
            {
#if UNITY_6000_0_OR_NEWER
                _body.linearVelocity = Vector2.zero;
#else
                _body.velocity = Vector2.zero;
#endif
                _body.angularVelocity = 0f;
                _body.simulated = false;
            }
            _entityCollider = null;
            _body = null;
        }

        public void OnFrameActionPoolAcquire()
        {
        }

        public void OnFrameActionPoolRelease()
        {
            ResetState();
        }

        private void FixedUpdate()
        {
            if (_body == null || _pathPosition == null) return;
            _pathElapsed = Mathf.Min(_pathDuration, _pathElapsed + Time.fixedDeltaTime);
            _body.MovePosition(_pathPosition(_pathElapsed));
            if (_pathElapsed >= _pathDuration) _pathPosition = null;
        }

        private void OnCollisionEnter2D(Collision2D collision) => NotifyCollision(collision);
        private void OnCollisionStay2D(Collision2D collision) => NotifyCollision(collision);
        private void OnTriggerEnter2D(Collider2D other) => Notify(other, other != null ? other.ClosestPoint(transform.position) : (Vector2)transform.position);
        private void OnTriggerStay2D(Collider2D other) => Notify(other, other != null ? other.ClosestPoint(transform.position) : (Vector2)transform.position);

        private void NotifyCollision(Collision2D collision)
        {
            if (collision == null) return;
            Vector2 point = collision.contactCount > 0 ? collision.GetContact(0).point : collision.collider.ClosestPoint(transform.position);
            Notify(collision.collider, point);
        }

        private void Notify(Collider2D other, Vector2 point)
        {
            if (other != null && other != _entityCollider) _onContact?.Invoke(other, point);
        }

        private IEnumerator RestoreOwnerCollisionsAfter(float delay)
        {
            yield return new WaitForSeconds(delay);
            _restoreOwnerCollision = null;
            RestoreOwnerCollisions();
        }

        private void RestoreOwnerCollisions()
        {
            if (_entityCollider != null)
            {
                foreach (Collider2D ownerCollider in _ignoredOwnerColliders)
                {
                    if (ownerCollider != null) Physics2D.IgnoreCollision(_entityCollider, ownerCollider, false);
                }
            }
            _ignoredOwnerColliders.Clear();
        }
    }
}
