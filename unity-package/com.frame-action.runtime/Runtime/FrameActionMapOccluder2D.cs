using System.Collections.Generic;
using UnityEngine;

namespace FrameAction
{
    [DisallowMultipleComponent]
    public sealed class FrameActionMapOccluder2D : MonoBehaviour
    {
        public SpriteRenderer targetRenderer;
        public Collider2D trigger;
        [Range(0.05f, 1f)] public float fadedAlpha = 0.35f;
        public float fadeSpeed = 5f;

        private readonly HashSet<int> _characters = new HashSet<int>();
        private float _originalAlpha = 1f;

        private void Awake()
        {
            if (targetRenderer == null) targetRenderer = GetComponent<SpriteRenderer>();
            if (trigger == null) trigger = GetComponent<Collider2D>();
            if (trigger != null) trigger.isTrigger = true;
            if (targetRenderer != null) _originalAlpha = targetRenderer.color.a;
        }

        private void OnDisable()
        {
            _characters.Clear();
            if (targetRenderer == null) return;
            Color color = targetRenderer.color;
            color.a = _originalAlpha;
            targetRenderer.color = color;
        }

        private void Update()
        {
            if (targetRenderer == null) return;
            Color color = targetRenderer.color;
            float target = _characters.Count > 0 ? Mathf.Min(_originalAlpha, fadedAlpha) : _originalAlpha;
            color.a = Mathf.MoveTowards(color.a, target, Mathf.Max(0.01f, fadeSpeed) * Time.deltaTime);
            targetRenderer.color = color;
        }

        private void OnTriggerEnter2D(Collider2D other)
        {
            FrameActionPlayer player = other != null ? other.GetComponentInParent<FrameActionPlayer>() : null;
            if (player != null) _characters.Add(player.GetInstanceID());
        }

        private void OnTriggerExit2D(Collider2D other)
        {
            FrameActionPlayer player = other != null ? other.GetComponentInParent<FrameActionPlayer>() : null;
            if (player != null) _characters.Remove(player.GetInstanceID());
        }
    }
}
