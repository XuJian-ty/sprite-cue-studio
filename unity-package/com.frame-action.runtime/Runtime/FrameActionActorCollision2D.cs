using System.Collections.Generic;
using UnityEngine;

namespace FrameAction
{
    /// <summary>
    /// Controls solid body-collider pairs between players and enemies, and between enemies.
    /// Hurtboxes remain triggers, so attacks and hit detection continue to work.
    /// </summary>
    [DisallowMultipleComponent]
    [RequireComponent(typeof(FrameActionPlayer))]
    public sealed class FrameActionActorCollision2D : MonoBehaviour
    {
        private static readonly HashSet<FrameActionActorCollision2D> Instances = new HashSet<FrameActionActorCollision2D>();

        public FrameActionPlayer player;
        public Collider2D bodyCollider;
        public bool collideWithOtherActors;

        private void Awake()
        {
            if (player == null) player = GetComponent<FrameActionPlayer>();
            if (bodyCollider == null) bodyCollider = GetComponent<Collider2D>();
        }

        private void OnEnable()
        {
            Instances.Add(this);
            ReconcileAll();
        }

        private void Start()
        {
            // FrameActionPlayer.Load runs in Awake; resolve the project kind after that.
            ReconcileAll();
        }

        private void OnDisable()
        {
            Instances.Remove(this);
            ReconcileAll();
        }

        public void Reconcile()
        {
            ReconcileAll();
        }

        private static void ReconcileAll()
        {
            FrameActionActorCollision2D[] actors = new FrameActionActorCollision2D[Instances.Count];
            Instances.CopyTo(actors);
            for (int i = 0; i < actors.Length; i++)
            {
                FrameActionActorCollision2D left = actors[i];
                if (!IsUsable(left)) continue;
                for (int j = i + 1; j < actors.Length; j++)
                {
                    FrameActionActorCollision2D right = actors[j];
                    if (!IsUsable(right) || !ShouldControlPair(left, right)) continue;
                    // Either side opting out is enough to make the pair pass through.
                    bool ignore = !left.collideWithOtherActors || !right.collideWithOtherActors;
                    Physics2D.IgnoreCollision(left.bodyCollider, right.bodyCollider, ignore);
                }
            }
        }

        private static bool IsUsable(FrameActionActorCollision2D actor)
        {
            return actor != null && actor.isActiveAndEnabled && actor.bodyCollider != null && actor.player != null;
        }

        private static bool ShouldControlPair(FrameActionActorCollision2D left, FrameActionActorCollision2D right)
        {
            string leftKind = left.player.Project?.projectKind;
            string rightKind = right.player.Project?.projectKind;
            return leftKind == "enemy" && rightKind == "enemy"
                || (leftKind == "character" && rightKind == "enemy")
                || (leftKind == "enemy" && rightKind == "character");
        }
    }
}
