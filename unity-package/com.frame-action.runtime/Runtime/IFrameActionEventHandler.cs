namespace FrameAction
{
    public readonly struct FrameActionEventContext
    {
        public readonly FrameActionPlayer player;
        public readonly FrameTimelineEventData data;
        public readonly float progress;
        public readonly int actionExecutionId;
        public readonly int actionDurationTicks;
        public readonly int currentTick;

        public FrameActionEventContext(FrameActionPlayer player, FrameTimelineEventData data, float progress, int actionExecutionId, int actionDurationTicks, int currentTick)
        {
            this.player = player;
            this.data = data;
            this.progress = progress;
            this.actionExecutionId = actionExecutionId;
            this.actionDurationTicks = actionDurationTicks;
            this.currentTick = currentTick;
        }
    }

    public interface IFrameActionEventHandler
    {
        bool CanHandle(string eventType);
        void OnEnter(FrameActionEventContext context);
        void OnUpdate(FrameActionEventContext context);
        void OnExit(FrameActionEventContext context);
    }
}
