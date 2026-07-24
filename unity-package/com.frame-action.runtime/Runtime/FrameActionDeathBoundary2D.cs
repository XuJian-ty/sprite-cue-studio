using System.Linq;
using UnityEngine;

namespace FrameAction
{
    /// <summary>
    /// A map-bottom trigger that delegates defeat to the owning game's health runtime.
    /// The runtime package stays game-agnostic through IFrameActionDeathReceiver.
    /// </summary>
    [DisallowMultipleComponent]
    [RequireComponent(typeof(Collider2D))]
    public sealed class FrameActionDeathBoundary2D : MonoBehaviour
    {
        public bool playersOnly = true;
        public string playerTag = "Player";

        private void Awake()
        {
            Collider2D boundary = GetComponent<Collider2D>();
            if (boundary != null) boundary.isTrigger = true;
        }

        private void OnTriggerEnter2D(Collider2D other) => TryDefeat(other);
        private void OnTriggerStay2D(Collider2D other) => TryDefeat(other);

        private void TryDefeat(Collider2D other)
        {
            if (other == null || playersOnly && !HasPlayerIdentity(other.transform)) return;
            MonoBehaviour receiver = other.GetComponentsInParent<MonoBehaviour>(true)
                .FirstOrDefault(component => component is IFrameActionDeathReceiver);
            if (receiver is IFrameActionDeathReceiver deathReceiver) deathReceiver.ReceiveFrameActionDeath();
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

        private void OnDrawGizmosSelected()
        {
            BoxCollider2D box = GetComponent<BoxCollider2D>();
            if (box == null) return;
            Gizmos.color = new Color(0.9f, 0.08f, 0.12f, 0.35f);
            Matrix4x4 previous = Gizmos.matrix;
            Gizmos.matrix = transform.localToWorldMatrix;
            Gizmos.DrawCube(box.offset, box.size);
            Gizmos.matrix = previous;
        }
    }
}
