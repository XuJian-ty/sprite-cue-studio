using System;
using UnityEngine;

namespace FrameAction
{
    /// <summary>
    /// Legacy component name retained for prefab/script migration. It inherits the same single
    /// collision implementation as FrameActionProceduralRigidBody2D; SpriteCue never adds both.
    /// </summary>
    [Obsolete("Use FrameActionProceduralRigidBody2D. Ice is a material template, not a separate physics engine.")]
    [DisallowMultipleComponent]
    public sealed class FrameActionProceduralIceBody2D : FrameActionProceduralRigidBodyCore2D
    {
    }
}
