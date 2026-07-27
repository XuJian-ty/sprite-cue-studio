using UnityEngine;

namespace FrameAction
{
    public readonly struct FrameActionDamageContext
    {
        public readonly FrameActionPlayer source;
        public readonly float multiplier;
        public readonly float fixedDamage;
        public readonly Vector2 hitPoint;

        public FrameActionDamageContext(FrameActionPlayer source, float multiplier, float fixedDamage, Vector2 hitPoint)
        {
            this.source = source;
            this.multiplier = multiplier;
            this.fixedDamage = fixedDamage;
            this.hitPoint = hitPoint;
        }

        public FrameActionDamageContext(FrameActionPlayer source, float multiplier, Vector2 hitPoint)
            : this(source, multiplier, 0f, hitPoint)
        {
        }
    }

    public interface IFrameActionDamageReceiver
    {
        void ReceiveFrameActionDamage(FrameActionDamageContext context);
    }

    public interface IFrameActionInvincibilityReceiver
    {
        bool IsFrameActionInvincible { get; }
    }

    public interface IFrameActionDeathReceiver
    {
        void ReceiveFrameActionDeath();
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
