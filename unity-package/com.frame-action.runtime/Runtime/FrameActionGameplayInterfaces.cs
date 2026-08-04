using System;
using UnityEngine;

namespace FrameAction
{
    public readonly struct FrameActionDamageContext
    {
        public readonly FrameActionPlayer source;
        public readonly float multiplier;
        public readonly float fixedDamage;
        public readonly Vector2 hitPoint;
        public readonly int actionExecutionId;

        public FrameActionDamageContext(FrameActionPlayer source, float multiplier, float fixedDamage, Vector2 hitPoint)
            : this(source, multiplier, fixedDamage, hitPoint, 0)
        {
        }

        public FrameActionDamageContext(
            FrameActionPlayer source,
            float multiplier,
            float fixedDamage,
            Vector2 hitPoint,
            int actionExecutionId)
        {
            this.source = source;
            this.multiplier = multiplier;
            this.fixedDamage = fixedDamage;
            this.hitPoint = hitPoint;
            this.actionExecutionId = actionExecutionId;
        }

        public FrameActionDamageContext(FrameActionPlayer source, float multiplier, Vector2 hitPoint)
            : this(source, multiplier, 0f, hitPoint, 0)
        {
        }
    }

    public interface IFrameActionDamageReceiver
    {
        void ReceiveFrameActionDamage(FrameActionDamageContext context);
    }

    /// <summary>
    /// Marks a damage receiver as authored world matter.  Attack effects include these
    /// receivers even when their physics layer is terrain rather than the action's
    /// usual enemy layer; regular terrain remains unaffected.
    /// </summary>
    public interface IFrameActionEnvironmentalDamageReceiver
    {
    }

    /// <summary>
    /// Project-independent notice that an action affected a world-space matter region. The
    /// package deliberately carries no element enum or chemistry; the consuming game resolves
    /// the action's free-form element identity and owns every reaction rule.
    /// </summary>
    public readonly struct FrameActionMatterImpactContext
    {
        public readonly FrameActionPlayer source;
        public readonly Vector2 worldPoint;
        public readonly float radius;
        public readonly float strength;
        public readonly int actionExecutionId;

        public FrameActionMatterImpactContext(
            FrameActionPlayer source,
            Vector2 worldPoint,
            float radius,
            float strength,
            int actionExecutionId)
        {
            this.source = source;
            this.worldPoint = worldPoint;
            this.radius = Mathf.Max(0.01f, radius);
            this.strength = Mathf.Max(0f, strength);
            this.actionExecutionId = actionExecutionId;
        }
    }

    public static class FrameActionMatterImpactBus
    {
        public static event Action<FrameActionMatterImpactContext> Impacted;

        public static void Publish(FrameActionMatterImpactContext context)
        {
            Impacted?.Invoke(context);
        }
    }

    public interface IFrameActionInvincibilityReceiver
    {
        bool IsFrameActionInvincible { get; }
    }

    public interface IFrameActionDeathReceiver
    {
        void ReceiveFrameActionDeath();
    }

    [AttributeUsage(AttributeTargets.Class, AllowMultiple = true, Inherited = true)]
    public sealed class FrameActionPropertyAttribute : Attribute
    {
        public string Id { get; }
        public string DisplayName { get; }
        public string Category { get; }
        public bool AllowTemporary { get; }
        public bool AllowPermanent { get; }

        public FrameActionPropertyAttribute(
            string id,
            string displayName,
            string category,
            bool allowTemporary = true,
            bool allowPermanent = true)
        {
            Id = id;
            DisplayName = displayName;
            Category = category;
            AllowTemporary = allowTemporary;
            AllowPermanent = allowPermanent;
        }
    }

    public enum FrameActionPropertyChangeType
    {
        Temporary,
        Permanent,
    }

    public readonly struct FrameActionPropertyChangeContext
    {
        public readonly string propertyId;
        public readonly float amount;
        public readonly FrameActionPropertyChangeType changeType;
        public readonly float durationSeconds;
        public readonly string modifierId;
        public readonly FrameActionPlayer source;

        public FrameActionPropertyChangeContext(
            string propertyId,
            float amount,
            FrameActionPropertyChangeType changeType,
            float durationSeconds,
            string modifierId,
            FrameActionPlayer source)
        {
            this.propertyId = propertyId;
            this.amount = amount;
            this.changeType = changeType;
            this.durationSeconds = durationSeconds;
            this.modifierId = modifierId;
            this.source = source;
        }
    }

    public interface IFrameActionPropertyReceiver
    {
        bool TryGetFrameActionProperty(string propertyId, out float value);
        bool ApplyFrameActionProperty(FrameActionPropertyChangeContext context);
    }

    public interface IFrameActionStatusReceiver
    {
        void ApplyFrameActionStatus(string statusId, float durationSeconds, FrameActionPlayer source);
    }

    public interface IFrameActionCameraReceiver
    {
        void ApplyFrameActionCamera(Vector2 localOffset, float zoom, float progress);
        void ClearFrameActionCamera();
    }

    public interface IFrameActionTargetProvider
    {
        Transform ResolveFrameActionTarget();
    }

    public interface IFrameActionHitStopReceiver
    {
        void SetFrameActionHitStop(bool active, bool pauseCameraInput);
    }

    public interface IFrameActionCommandSink
    {
        void SubmitMoveAxis(float axis);
        bool TriggerAction(string actionId);
        bool TriggerCustom(string code);
    }
}
