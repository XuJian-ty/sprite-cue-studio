using System.Collections.Generic;
using UnityEngine;

namespace FrameAction
{
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(1000)]
    public sealed class FrameActionEnemyRenderOrder2D : MonoBehaviour
    {
        public SpriteRenderer targetRenderer;
        public Collider2D bodyCollider;
        [Min(0.1f)] public float depthBucketsPerWorldUnit = 4f;
        public int minimumSortingOrder = -1000;
        public int maximumSortingOrder = 0;

        private static readonly List<FrameActionEnemyRenderOrder2D> ActiveEnemies = new List<FrameActionEnemyRenderOrder2D>();
        private int _instanceId;

        private void Awake()
        {
            ResolveReferences();
            _instanceId = GetInstanceID();
        }

        private void OnEnable()
        {
            if (!ActiveEnemies.Contains(this)) ActiveEnemies.Add(this);
            UpdateSortingOrder();
        }

        private void OnDisable()
        {
            ActiveEnemies.Remove(this);
        }

        private void LateUpdate()
        {
            UpdateSortingOrder();
        }

        private void ResolveReferences()
        {
            if (targetRenderer == null) targetRenderer = GetComponentInChildren<SpriteRenderer>(true);
            if (bodyCollider == null) bodyCollider = GetComponent<Collider2D>();
        }

        private void UpdateSortingOrder()
        {
            if (targetRenderer == null) ResolveReferences();
            if (targetRenderer == null) return;

            int bucket = DepthBucket();
            int activeCount = 0;
            int rankBehind = 0;
            for (int index = 0; index < ActiveEnemies.Count; index++)
            {
                FrameActionEnemyRenderOrder2D other = ActiveEnemies[index];
                if (other == null || !other.isActiveAndEnabled) continue;
                activeCount += 1;
                if (other == this) continue;
                int otherBucket = other.DepthBucket();
                if (otherBucket < bucket || otherBucket == bucket && other._instanceId < _instanceId) rankBehind += 1;
            }

            int order = maximumSortingOrder - Mathf.Max(0, activeCount - 1 - rankBehind);
            targetRenderer.sortingOrder = Mathf.Clamp(order, minimumSortingOrder, maximumSortingOrder);
        }

        private int DepthBucket()
        {
            float footY = bodyCollider != null && bodyCollider.enabled ? bodyCollider.bounds.min.y : transform.position.y;
            return Mathf.RoundToInt(-footY * Mathf.Max(0.1f, depthBucketsPerWorldUnit));
        }
    }
}
