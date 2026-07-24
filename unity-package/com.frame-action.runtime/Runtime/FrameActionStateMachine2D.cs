using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

namespace FrameAction
{
    public enum FrameActionTransitionPolicy
    {
        Interrupt,
        Buffer,
        Ignore,
    }

    public readonly struct FrameActionPendingRequest
    {
        public FrameActionData Action { get; }
        public int SegmentIndex { get; }
        public bool IsValid => Action != null;

        public FrameActionPendingRequest(FrameActionData action, int segmentIndex)
        {
            Action = action;
            SegmentIndex = segmentIndex;
        }
    }

    public sealed class FrameActionRuntimeState
    {
        public FrameActionData Action { get; }
        public FrameActionSegmentData Segment { get; }
        public int SegmentIndex { get; }
        public string ActionId => Action?.id ?? string.Empty;
        public string SegmentId => Segment?.id ?? string.Empty;

        internal FrameActionRuntimeState(FrameActionData action, FrameActionSegmentData segment, int segmentIndex)
        {
            Action = action;
            Segment = segment;
            SegmentIndex = segmentIndex;
        }
    }

    /// <summary>
    /// Data-driven action state machine. Each configured action segment is a reusable runtime state,
    /// so adding gameplay actions does not require adding hard-coded state classes.
    /// </summary>
    public sealed class FrameActionStateMachine2D
    {
        private readonly struct StateKey : IEquatable<StateKey>
        {
            private readonly FrameActionData _action;
            private readonly FrameActionSegmentData _segment;
            private readonly int _segmentIndex;

            public StateKey(FrameActionData action, FrameActionSegmentData segment, int segmentIndex)
            {
                _action = action;
                _segment = segment;
                _segmentIndex = segmentIndex;
            }

            public bool Equals(StateKey other)
            {
                return ReferenceEquals(_action, other._action)
                    && ReferenceEquals(_segment, other._segment)
                    && _segmentIndex == other._segmentIndex;
            }

            public override bool Equals(object obj) => obj is StateKey other && Equals(other);

            public override int GetHashCode()
            {
                unchecked
                {
                    int hash = RuntimeHelpers.GetHashCode(_action);
                    hash = hash * 397 ^ RuntimeHelpers.GetHashCode(_segment);
                    return hash * 397 ^ _segmentIndex;
                }
            }
        }

        private readonly Func<FrameActionRuntimeState, bool> _stateExecutor;
        private readonly Dictionary<StateKey, FrameActionRuntimeState> _stateCache = new Dictionary<StateKey, FrameActionRuntimeState>();
        private FrameActionPendingRequest _pending;

        public FrameActionRuntimeState CurrentState { get; private set; }
        public FrameActionRuntimeState PreviousState { get; private set; }
        public FrameActionPendingRequest PendingRequest => _pending;
        public bool HasPendingRequest => _pending.IsValid;

        public event Action<FrameActionRuntimeState> StateEntered;
        public event Action<FrameActionRuntimeState> StateExited;
        public event Action<FrameActionRuntimeState> StateCompleted;

        public FrameActionStateMachine2D(Func<FrameActionRuntimeState, bool> stateExecutor)
        {
            _stateExecutor = stateExecutor ?? throw new ArgumentNullException(nameof(stateExecutor));
        }

        public bool Request(FrameActionData action, int segmentIndex = 0)
        {
            if (!TryResolveState(action, segmentIndex, out FrameActionRuntimeState next)) return false;
            if (CurrentState == null) return TransitionTo(next);

            switch (ResolvePolicy(CurrentState.Action, action.id))
            {
                case FrameActionTransitionPolicy.Ignore:
                    return false;
                case FrameActionTransitionPolicy.Buffer:
                    _pending = new FrameActionPendingRequest(action, next.SegmentIndex);
                    return true;
                default:
                    return TransitionTo(next);
            }
        }

        public bool ForceTransition(FrameActionData action, int segmentIndex = 0)
        {
            return TryResolveState(action, segmentIndex, out FrameActionRuntimeState next) && TransitionTo(next);
        }

        public bool CompleteCurrent()
        {
            if (CurrentState != null) StateCompleted?.Invoke(CurrentState);
            if (!_pending.IsValid) return false;

            FrameActionPendingRequest pending = _pending;
            _pending = default;
            return TryResolveState(pending.Action, pending.SegmentIndex, out FrameActionRuntimeState next) && TransitionTo(next);
        }

        public void Synchronize(FrameActionData action, int segmentIndex = 0)
        {
            if (!TryResolveState(action, segmentIndex, out FrameActionRuntimeState state)) return;
            if (CurrentState != null && !ReferenceEquals(CurrentState, state)) PreviousState = CurrentState;
            CurrentState = state;
        }

        public void ClearPending()
        {
            _pending = default;
        }

        public static FrameActionTransitionPolicy ResolvePolicy(FrameActionData current, string nextActionId)
        {
            if (current?.transitions == null
                || string.IsNullOrEmpty(nextActionId)
                || !current.transitions.TryGetValue(nextActionId, out string configured))
            {
                return FrameActionTransitionPolicy.Interrupt;
            }

            if (string.Equals(configured, "buffer", StringComparison.OrdinalIgnoreCase)) return FrameActionTransitionPolicy.Buffer;
            if (string.Equals(configured, "ignore", StringComparison.OrdinalIgnoreCase)) return FrameActionTransitionPolicy.Ignore;
            return FrameActionTransitionPolicy.Interrupt;
        }

        private bool TransitionTo(FrameActionRuntimeState next)
        {
            if (next == null) return false;

            FrameActionRuntimeState previous = CurrentState;
            FrameActionRuntimeState previousHistory = PreviousState;
            PreviousState = previous;
            CurrentState = next;
            if (!_stateExecutor(next))
            {
                CurrentState = previous;
                PreviousState = previousHistory;
                return false;
            }
            _pending = default;
            if (previous != null) StateExited?.Invoke(previous);
            StateEntered?.Invoke(next);
            return true;
        }

        private bool TryResolveState(FrameActionData action, int segmentIndex, out FrameActionRuntimeState state)
        {
            state = null;
            if (action?.segments == null || action.segments.Count == 0) return false;
            int resolvedIndex = Math.Max(0, Math.Min(segmentIndex, action.segments.Count - 1));
            FrameActionSegmentData segment = action.segments[resolvedIndex];
            if (segment == null) return false;

            StateKey key = new StateKey(action, segment, resolvedIndex);
            if (!_stateCache.TryGetValue(key, out state))
            {
                state = new FrameActionRuntimeState(action, segment, resolvedIndex);
                _stateCache[key] = state;
            }
            return true;
        }
    }
}
