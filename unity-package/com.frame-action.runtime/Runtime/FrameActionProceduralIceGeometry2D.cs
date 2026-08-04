using System;
using UnityEngine;

namespace FrameAction
{
    /// <summary>Compatibility alias. New integrations use FrameActionProceduralRigidGeometry2D.</summary>
    [Obsolete("Ice is now a SpriteCue program-rigid template. Use FrameActionProceduralRigidGeometry2D.")]
    [DisallowMultipleComponent]
    public sealed class FrameActionProceduralIceGeometry2D : FrameActionProceduralRigidGeometry2D
    {
    }

    /// <summary>Compatibility value type for pre-generic procedural-ice integrations.</summary>
    [Serializable]
    [Obsolete("Use FrameActionProceduralRigidVisualFacet2D.")]
    public struct FrameActionProceduralIceFacet2D
    {
        public int Id;
        public Vector2 A;
        public Vector2 B;
        public Vector2 C;
        public Vector2 AuthoringUvA;
        public Vector2 AuthoringUvB;
        public Vector2 AuthoringUvC;
        [Range(0f, 1f)] public float Shade;

        public FrameActionProceduralIceFacet2D(
            int id, Vector2 a, Vector2 b, Vector2 c,
            Vector2 authoringUvA, Vector2 authoringUvB, Vector2 authoringUvC, float shade)
        {
            Id = id;
            A = a;
            B = b;
            C = c;
            AuthoringUvA = authoringUvA;
            AuthoringUvB = authoringUvB;
            AuthoringUvC = authoringUvC;
            Shade = Mathf.Clamp01(shade);
        }

        public static implicit operator FrameActionProceduralRigidVisualFacet2D(FrameActionProceduralIceFacet2D value)
        {
            return new FrameActionProceduralRigidVisualFacet2D(
                value.Id, value.A, value.B, value.C,
                value.AuthoringUvA, value.AuthoringUvB, value.AuthoringUvC, value.Shade);
        }

        public static implicit operator FrameActionProceduralIceFacet2D(FrameActionProceduralRigidVisualFacet2D value)
        {
            return new FrameActionProceduralIceFacet2D
            {
                Id = value.Id,
                A = value.A,
                B = value.B,
                C = value.C,
                AuthoringUvA = value.AuthoringUvA,
                AuthoringUvB = value.AuthoringUvB,
                AuthoringUvC = value.AuthoringUvC,
                Shade = value.Shade,
            };
        }
    }

    /// <summary>Compatibility value type for pre-generic procedural-ice crack presenters.</summary>
    [Serializable]
    [Obsolete("Use FrameActionProceduralRigidCrackSegment2D.")]
    public struct FrameActionProceduralIceCrackSegment2D
    {
        public Vector2 A;
        public Vector2 B;
        [Range(0f, 1f)] public float Strength;

        public FrameActionProceduralIceCrackSegment2D(Vector2 a, Vector2 b, float strength = 1f)
        {
            A = a;
            B = b;
            Strength = Mathf.Clamp01(strength);
        }

        public static implicit operator FrameActionProceduralRigidCrackSegment2D(FrameActionProceduralIceCrackSegment2D value)
        {
            return new FrameActionProceduralRigidCrackSegment2D(value.A, value.B, value.Strength);
        }

        public static implicit operator FrameActionProceduralIceCrackSegment2D(FrameActionProceduralRigidCrackSegment2D value)
        {
            return new FrameActionProceduralIceCrackSegment2D
            {
                A = value.A,
                B = value.B,
                Strength = value.Strength,
            };
        }
    }
}
