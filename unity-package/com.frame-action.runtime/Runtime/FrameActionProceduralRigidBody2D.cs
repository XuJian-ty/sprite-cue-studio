using UnityEngine;

namespace FrameAction
{
    /// <summary>
    /// Authoritative project-independent procedural rigid body. Material templates only supply
    /// physical coefficients and fracture directionality; combat and element reactions remain in
    /// the consuming game.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class FrameActionProceduralRigidBody2D : FrameActionProceduralRigidBodyCore2D
    {
    }
}
