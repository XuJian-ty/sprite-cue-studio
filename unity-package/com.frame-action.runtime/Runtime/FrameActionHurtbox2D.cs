using UnityEngine;

namespace FrameAction
{
    [DisallowMultipleComponent]
    public sealed class FrameActionHurtbox2D : MonoBehaviour
    {
        public Collider2D hurtboxCollider;

        private void Awake()
        {
            if (hurtboxCollider == null) hurtboxCollider = GetComponent<Collider2D>();
        }
    }
}
