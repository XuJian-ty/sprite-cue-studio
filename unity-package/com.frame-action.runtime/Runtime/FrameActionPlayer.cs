using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace FrameAction
{
    public sealed class FrameActionPlayer : MonoBehaviour
    {
        public FrameActionCharacterAsset characterAsset;
        public SpriteRenderer spriteRenderer;
        public Transform visualRoot;
        public string initialActionId = "ground-idle";
        public string initialSegmentId = "";
        public bool playOnEnable = true;
        public float playbackSpeed = 1f;
        public bool facingLeft;

        public int CurrentTick { get; private set; }
        public string CurrentActionId => _action?.id;
        public string CurrentSegmentId => _segment?.id;
        public FrameActionProjectData Project => _project;
        public FrameActionData CurrentAction => _action;
        public FrameActionSegmentData CurrentSegment => _segment;
        public bool IsPlaying => _playing;
        public int TickRate => Mathf.Max(1, _project?.tickRate ?? 600);
        public int CurrentSegmentDurationTicks => _segmentDurationTicks;
        public int CurrentBaseSegmentDurationTicks => _baseSegmentDurationTicks;
        public int CurrentActionExecutionId => _actionExecutionId;
        public float CurrentMovementSpeedMultiplier { get; private set; } = 1f;
        public event Action<FrameActionData> ActionStarted;
        public event Action<FrameActionData> ActionCompleted;
        public event Action<int> ActionExecutionEnded;
        public event Action<FrameActionProjectData> ProjectLoaded;

        private FrameActionProjectData _project;
        private FrameActionData _action;
        private FrameActionSegmentData _segment;
        private bool _playing;
        private float _tickRemainder;
        private int _baseSegmentDurationTicks;
        private int _segmentDurationTicks;
        private int _actionExecutionId;
        private bool _executionActive;
        private bool _timelinePaused;
        private readonly Dictionary<string, FrameActionData> _actionsById = new Dictionary<string, FrameActionData>(StringComparer.Ordinal);
        private readonly List<IFrameActionEventHandler> _handlers = new List<IFrameActionEventHandler>();
        private readonly List<TimelineExecution> _timelineExecutions = new List<TimelineExecution>();
        private TimelineExecution _currentTimelineExecution;

        private sealed class TimelineExecution
        {
            public int id;
            public FrameActionSegmentData segment;
            public int actionDurationTicks;
            public int timelineDurationTicks;
            public int currentTick;
            public float tickRemainder;
            public bool actionEnded;
            public int actionEndTick;
            public readonly Dictionary<string, FrameTimelineEventData> activeEvents = new Dictionary<string, FrameTimelineEventData>();
        }

        private void Awake()
        {
            if (spriteRenderer == null) spriteRenderer = GetComponentInChildren<SpriteRenderer>();
            if (visualRoot == null && spriteRenderer != null) visualRoot = spriteRenderer.transform;
            _handlers.AddRange(GetComponentsInChildren<MonoBehaviour>(true).OfType<IFrameActionEventHandler>());
            Load();
        }

        private void OnEnable()
        {
            if (playOnEnable && _project != null) Play(initialActionId, initialSegmentId);
        }

        private void Update()
        {
            if (!_playing || _project == null || _segment == null) return;
            CurrentMovementSpeedMultiplier = EvaluateMovementSpeedMultiplier(CurrentTick);
            float speed = Mathf.Max(0f, playbackSpeed) * EvaluateSpeedMultiplier(CurrentTick);
            _tickRemainder += Time.deltaTime * Mathf.Max(1, _project.tickRate) * speed;
            int ticks = Mathf.FloorToInt(_tickRemainder);
            if (ticks <= 0) return;
            _tickRemainder -= ticks;
            Advance(ticks);
        }

        public void Load()
        {
            _project = characterAsset != null && characterAsset.sourceJson != null
                ? JsonConvert.DeserializeObject<FrameActionProjectData>(characterAsset.sourceJson.text)
                : null;
            _actionsById.Clear();
            if (_project?.actions != null)
            {
                for (int i = 0; i < _project.actions.Count; i++)
                {
                    FrameActionData action = _project.actions[i];
                    if (action != null && !string.IsNullOrEmpty(action.id)) _actionsById[action.id] = action;
                }
            }
            ProjectLoaded?.Invoke(_project);
        }

        public void SetFacingLeft(bool value)
        {
            facingLeft = value;
            ApplyVisualFacing();
        }

        public FrameActionData FindAction(string actionId)
        {
            if (string.IsNullOrEmpty(actionId)) return null;
            if (_project == null) Load();
            return _actionsById.TryGetValue(actionId, out FrameActionData action) ? action : null;
        }

        public FrameActionData FindFirstActionByType(string actionType)
        {
            if (_project == null) Load();
            if (_project?.actions == null) return null;
            for (int i = 0; i < _project.actions.Count; i++)
            {
                FrameActionData action = _project.actions[i];
                if (action != null && action.type == actionType) return action;
            }
            return null;
        }

        public FrameActionData FindActionByTrigger(string triggerType, string triggerCode)
        {
            if (_project == null) Load();
            if (_project?.actions == null) return null;
            for (int i = 0; i < _project.actions.Count; i++)
            {
                FrameActionData action = _project.actions[i];
                if (action?.trigger != null && action.trigger.type == triggerType && action.trigger.code == triggerCode) return action;
            }
            return null;
        }

        public bool Play(string actionId, string segmentId = "")
        {
            if (_project == null) Load();
            FrameActionData nextAction = FindAction(actionId);
            if (nextAction == null) return false;
            FrameActionSegmentData nextSegment = !string.IsNullOrEmpty(segmentId)
                ? nextAction.segments?.FirstOrDefault(item => item != null && item.id == segmentId)
                : nextAction.segments?.FirstOrDefault();
            if (nextSegment == null) return false;
            EndCurrentExecution();
            _action = nextAction;
            _segment = nextSegment;
            _baseSegmentDurationTicks = GetAnimationDuration(_segment);
            _segmentDurationTicks = _baseSegmentDurationTicks;
            _actionExecutionId += 1;
            _executionActive = true;
            CurrentTick = 0;
            _tickRemainder = 0f;
            _playing = true;
            _timelinePaused = false;
            CurrentMovementSpeedMultiplier = EvaluateMovementSpeedMultiplier(0);
            ActionStarted?.Invoke(_action);
            ApplyCurrentState(-1, 0, false);
            BeginTimelineExecution(_segment, _actionExecutionId, _baseSegmentDurationTicks);
            return true;
        }

        public void Pause()
        {
            _playing = false;
            _timelinePaused = true;
        }

        public void Resume()
        {
            _timelinePaused = false;
            _playing = _segment != null && _executionActive;
        }

        public void Seek(int tick, bool triggerEvents = false)
        {
            if (_segment == null) return;
            int duration = _segmentDurationTicks;
            int next = Mathf.Clamp(tick, 0, Mathf.Max(0, duration - 1));
            int previous = CurrentTick;
            CurrentTick = next;
            if (_currentTimelineExecution != null)
            {
                int timelinePrevious = _currentTimelineExecution.currentTick;
                if (!triggerEvents) ExitAllEvents(_currentTimelineExecution);
                _currentTimelineExecution.currentTick = next;
                _currentTimelineExecution.tickRemainder = 0f;
                if (triggerEvents) EvaluateEvents(_currentTimelineExecution, timelinePrevious, next);
            }
            ApplyCurrentState(previous, next, false);
        }

        private void Advance(int ticks)
        {
            int duration = _segmentDurationTicks;
            if (duration <= 0) return;
            if (_action.loop)
            {
                int remaining = ticks;
                while (CurrentTick + remaining >= duration)
                {
                    int cyclePrevious = CurrentTick;
                    int endTick = Mathf.Max(0, duration - 1);
                    if (cyclePrevious < endTick)
                    {
                        CurrentTick = endTick;
                        ApplyCurrentState(cyclePrevious, CurrentTick, true);
                    }
                    remaining -= Mathf.Max(1, duration - cyclePrevious);
                    EndCurrentExecution();
                    _actionExecutionId += 1;
                    _executionActive = true;
                    CurrentTick = 0;
                    ApplyCurrentState(-1, 0, false);
                    BeginTimelineExecution(_segment, _actionExecutionId, _baseSegmentDurationTicks);
                }
                if (remaining <= 0) return;
                int loopPrevious = CurrentTick;
                CurrentTick += remaining;
                ApplyCurrentState(loopPrevious, CurrentTick, false);
                return;
            }

            int previous = CurrentTick;
            int next = CurrentTick + ticks;
            if (next >= duration)
            {
                CurrentTick = Mathf.Max(0, duration - 1);
                if (previous < CurrentTick) ApplyCurrentState(previous, CurrentTick, false);
                _playing = false;
                EndCurrentExecution();
                ActionCompleted?.Invoke(_action);
                return;
            }

            CurrentTick = next;
            ApplyCurrentState(previous, next, false);
        }

        private void ApplyCurrentState(int previousTick, int tick, bool triggerEvents)
        {
            ApplyFrame(tick);
        }

        private void ApplyFrame(int tick)
        {
            List<FrameAnimationFrameData> frames = _segment.frames;
            if (frames == null || frames.Count == 0) return;
            int animationDuration = 0;
            for (int i = 0; i < frames.Count; i++) if (frames[i] != null) animationDuration += Mathf.Max(1, frames[i].durationTicks);
            if (animationDuration <= 0) return;
            int sampleTick = _action.loop && animationDuration > 0 ? tick % animationDuration : Mathf.Min(tick, animationDuration - 1);
            int cursor = 0;
            FrameAnimationFrameData frame = null;
            for (int i = 0; i < frames.Count; i++)
            {
                if (frames[i] == null) continue;
                cursor += Mathf.Max(1, frames[i].durationTicks);
                frame = frames[i];
                if (sampleTick < cursor)
                {
                    break;
                }
            }

            if (spriteRenderer != null && frame != null) spriteRenderer.sprite = characterAsset.FindAsset<Sprite>(frame.assetId);
            ApplyVisualFacing();
        }

        private void ApplyVisualFacing()
        {
            if (visualRoot == null) return;
            Vector3 scale = visualRoot.localScale;
            bool sourceFacesLeft = _project != null && _project.sourceFacing == "left";
            bool flip = sourceFacesLeft != facingLeft;
            scale.x = Mathf.Abs(scale.x) * (flip ? -1f : 1f);
            visualRoot.localScale = scale;
        }

        private void EvaluateEvents(TimelineExecution execution, int previousTick, int tick)
        {
            IEnumerable<FrameTimelineEventData> events = execution.segment.tracks?
                .Where(track => track != null && track.kind != "speed")
                .SelectMany(track => track.events ?? new List<FrameTimelineEventData>())
                ?? Enumerable.Empty<FrameTimelineEventData>();

            foreach (FrameTimelineEventData data in events)
            {
                if (data.triggerMode == "repeated")
                {
                    EvaluateRepeatedEvent(execution, data, previousTick, tick);
                    continue;
                }
                int endTick = GetEventEndTick(execution, data);
                if (data.GetString("durationMode") == "untilActionEnd" && endTick <= data.startTick) continue;
                bool hasDuration = endTick > data.startTick;
                bool active = hasDuration && tick >= data.startTick && tick < endTick;
                bool wasActive = execution.activeEvents.ContainsKey(data.id);
                bool crossedInstant = !hasDuration
                    && ((previousTick < data.startTick && tick >= data.startTick)
                        || (previousTick == tick && tick == data.startTick));
                bool crossedWholeDuration = hasDuration && previousTick < data.startTick && tick >= endTick;
                if (crossedWholeDuration)
                {
                    DispatchEnter(execution, data);
                    DispatchUpdate(execution, data, 1f);
                    DispatchExit(execution, data);
                    execution.activeEvents.Remove(data.id);
                    continue;
                }
                if ((active && !wasActive) || crossedInstant) DispatchEnter(execution, data);
                if (active) DispatchUpdate(execution, data, Mathf.InverseLerp(data.startTick, endTick, tick));
                if (!active && wasActive) DispatchExit(execution, data);
                if (active) execution.activeEvents[data.id] = data;
                else execution.activeEvents.Remove(data.id);
            }
        }

        private void EvaluateRepeatedEvent(TimelineExecution execution, FrameTimelineEventData data, int previousTick, int tick)
        {
            int interval = Mathf.Max(1, data.repeatIntervalTicks);
            int limit = data.activeDurationMode == "untilActionEnd"
                ? GetActionEndTick(execution) - 1
                : data.startTick + Mathf.Max(0, data.durationTicks);
            if (tick < data.startTick || previousTick >= limit) return;
            int firstIndex = Mathf.Max(0, Mathf.FloorToInt((previousTick - data.startTick) / (float)interval) + 1);
            for (int index = firstIndex; ; index++)
            {
                int triggerTick = data.startTick + index * interval;
                if (triggerTick > tick || triggerTick > limit) break;
                DispatchEnter(execution, data);
                DispatchUpdate(execution, data, 1f);
                DispatchExit(execution, data);
            }
        }

        private int GetEventEndTick(TimelineExecution execution, FrameTimelineEventData data)
        {
            if (data.GetString("durationMode") == "untilActionEnd") return GetActionEndTick(execution);
            return data.startTick + Mathf.Max(0, data.durationTicks);
        }

        private static int GetActionEndTick(TimelineExecution execution)
        {
            return execution.actionEnded ? execution.actionEndTick : execution.actionDurationTicks;
        }

        private float EvaluateSpeedMultiplier(int tick)
        {
            return EvaluateSpeedField(_segment, _currentTimelineExecution, tick, "castSpeedMultiplier", 0.01f);
        }

        private float EvaluateMovementSpeedMultiplier(int tick)
        {
            return EvaluateSpeedField(_segment, _currentTimelineExecution, tick, "movementSpeedMultiplier", 0f);
        }

        private float EvaluateSpeedField(FrameActionSegmentData segment, TimelineExecution execution, int tick, string field, float minimum)
        {
            float multiplier = 1f;
            if (segment?.tracks == null) return multiplier;
            for (int trackIndex = 0; trackIndex < segment.tracks.Count; trackIndex++)
            {
                FrameTimelineTrackData track = segment.tracks[trackIndex];
                if (track?.kind != "speed" || track.events == null) continue;
                for (int eventIndex = 0; eventIndex < track.events.Count; eventIndex++)
                {
                    FrameTimelineEventData data = track.events[eventIndex];
                    int endTick = data != null && data.GetString("durationMode") == "untilActionEnd"
                        ? execution != null ? GetActionEndTick(execution) : _baseSegmentDurationTicks
                        : data != null ? data.startTick + Mathf.Max(0, data.durationTicks) : 0;
                    if (data == null || tick < data.startTick || tick >= endTick) continue;
                    multiplier *= Mathf.Max(minimum, data.GetFloat(field, 1f));
                }
            }
            return multiplier;
        }

        private void DispatchEnter(TimelineExecution execution, FrameTimelineEventData data)
        {
            FrameActionEventContext context = new FrameActionEventContext(this, data, 0f, execution.id, execution.actionDurationTicks, execution.currentTick);
            for (int i = 0; i < _handlers.Count; i++) if (_handlers[i].CanHandle(data.type)) _handlers[i].OnEnter(context);
        }

        private void DispatchUpdate(TimelineExecution execution, FrameTimelineEventData data, float progress)
        {
            FrameActionEventContext context = new FrameActionEventContext(this, data, progress, execution.id, execution.actionDurationTicks, execution.currentTick);
            for (int i = 0; i < _handlers.Count; i++) if (_handlers[i].CanHandle(data.type)) _handlers[i].OnUpdate(context);
        }

        private void DispatchExit(TimelineExecution execution, FrameTimelineEventData data)
        {
            FrameActionEventContext context = new FrameActionEventContext(this, data, 1f, execution.id, execution.actionDurationTicks, execution.currentTick);
            for (int i = 0; i < _handlers.Count; i++) if (_handlers[i].CanHandle(data.type)) _handlers[i].OnExit(context);
        }

        private void ExitAllEvents(TimelineExecution execution)
        {
            foreach (FrameTimelineEventData data in execution.activeEvents.Values.ToArray()) DispatchExit(execution, data);
            execution.activeEvents.Clear();
        }

        private void EndCurrentExecution()
        {
            if (!_executionActive) return;
            _executionActive = false;
            TimelineExecution execution = _currentTimelineExecution;
            if (execution != null && !execution.actionEnded)
            {
                execution.actionEnded = true;
                execution.actionEndTick = Mathf.Clamp(CurrentTick + 1, 0, execution.actionDurationTicks);
            }
            _currentTimelineExecution = null;
            ActionExecutionEnded?.Invoke(execution?.id ?? _actionExecutionId);
        }

        private void BeginTimelineExecution(FrameActionSegmentData segment, int executionId, int actionDurationTicks)
        {
            TimelineExecution execution = new TimelineExecution
            {
                id = executionId,
                segment = segment,
                actionDurationTicks = Mathf.Max(1, actionDurationTicks),
                timelineDurationTicks = GetTimelineDuration(segment, actionDurationTicks),
                currentTick = 0,
                tickRemainder = 0f,
                actionEnded = false,
                actionEndTick = Mathf.Max(1, actionDurationTicks),
            };
            _timelineExecutions.Add(execution);
            _currentTimelineExecution = execution;
            StartCoroutine(RunTimelineExecution(execution));
        }

        private IEnumerator RunTimelineExecution(TimelineExecution execution)
        {
            EvaluateEvents(execution, -1, 0);
            while (execution.currentTick < execution.timelineDurationTicks - 1)
            {
                yield return null;
                if (_timelinePaused) continue;
                float speed = Mathf.Max(0f, playbackSpeed) * EvaluateSpeedField(
                    execution.segment,
                    execution,
                    execution.currentTick,
                    "castSpeedMultiplier",
                    0.01f);
                execution.tickRemainder += Time.deltaTime * TickRate * speed;
                int ticks = Mathf.FloorToInt(execution.tickRemainder);
                if (ticks <= 0) continue;
                execution.tickRemainder -= ticks;
                int previousTick = execution.currentTick;
                execution.currentTick = Mathf.Min(execution.timelineDurationTicks - 1, execution.currentTick + ticks);
                EvaluateEvents(execution, previousTick, execution.currentTick);
            }
            ExitAllEvents(execution);
            _timelineExecutions.Remove(execution);
            if (_currentTimelineExecution == execution && !_executionActive) _currentTimelineExecution = null;
        }

        private static int GetAnimationDuration(FrameActionSegmentData segment)
        {
            int animationDuration = segment.frames?.Where(item => item != null).Sum(item => Mathf.Max(1, item.durationTicks)) ?? 0;
            return Mathf.Max(1, animationDuration);
        }

        private int GetTimelineDuration(FrameActionSegmentData segment, int animationDuration)
        {
            int duration = Mathf.Max(1, animationDuration);
            if (segment?.tracks == null) return duration;
            for (int trackIndex = 0; trackIndex < segment.tracks.Count; trackIndex++)
            {
                FrameTimelineTrackData track = segment.tracks[trackIndex];
                if (track?.events == null) continue;
                for (int eventIndex = 0; eventIndex < track.events.Count; eventIndex++)
                {
                    FrameTimelineEventData data = track.events[eventIndex];
                    if (data == null) continue;
                    int displayDuration = GetTimelineEventDisplayDuration(data, track.kind, animationDuration);
                    if (data.triggerMode == "repeated") displayDuration += 1;
                    duration = Mathf.Max(duration, Mathf.Max(0, data.startTick) + Mathf.Max(1, displayDuration));
                }
            }
            return duration;
        }

        private int GetTimelineEventDisplayDuration(FrameTimelineEventData data, string kind, int animationDuration)
        {
            if (kind == "speed" || kind == "camera")
            {
                return data.GetString("durationMode") == "untilActionEnd"
                    ? Mathf.Max(0, animationDuration - data.startTick)
                    : Mathf.Max(0, data.durationTicks);
            }

            int repeatedDuration = 0;
            int lastTriggerOffset = 0;
            if (data.triggerMode == "repeated")
            {
                repeatedDuration = data.activeDurationMode == "untilActionEnd"
                    ? Mathf.Max(0, animationDuration - data.startTick)
                    : Mathf.Max(0, data.durationTicks);
                int interval = Mathf.Max(1, data.repeatIntervalTicks);
                int lastTriggerLimit = data.activeDurationMode == "untilActionEnd"
                    ? Mathf.Max(0, repeatedDuration - 1)
                    : repeatedDuration;
                lastTriggerOffset = Mathf.FloorToInt(lastTriggerLimit / (float)interval) * interval;
            }

            int lastTriggerTick = data.startTick + lastTriggerOffset;
            int remainingTicks = Mathf.Max(0, animationDuration - lastTriggerTick);
            int tail = 0;
            if (kind == "damage")
            {
                foreach (JObject effect in Objects(data.parameters?["damageEffects"]))
                {
                    tail = Mathf.Max(tail, Mathf.Max(0, ValueInt(effect, "triggerDelayTicks"))
                        + Mathf.Max(0, ValueInt(effect, "detectionDurationTicks")));
                }
            }
            else if (kind == "physics")
            {
                foreach (JObject effect in Objects(data.parameters?["physicsEffects"]))
                {
                    int lifetime = ValueString(effect, "durationMode") == "untilActionEnd"
                        ? remainingTicks
                        : Mathf.Max(0, ValueInt(effect, "delayTicks")) + Mathf.Max(0, ValueInt(effect, "durationTicks"));
                    tail = Mathf.Max(tail, lifetime);
                }
            }
            else if (kind == "vfx")
            {
                foreach (JObject effect in Objects(data.parameters?["vfxEffects"]))
                {
                    tail = Mathf.Max(tail, GetVfxLifetimeTicks(effect, remainingTicks));
                }
            }
            else if (kind == "sfx")
            {
                foreach (JObject effect in Objects(data.parameters?["sfxEffects"]))
                {
                    tail = Mathf.Max(tail, GetSfxLifetimeTicks(effect, remainingTicks));
                }
            }
            return Mathf.Max(repeatedDuration, lastTriggerOffset + tail);
        }

        private int GetVfxLifetimeTicks(JObject effect, int remainingTicks)
        {
            int triggerDelayTicks = Mathf.Max(0, ValueInt(effect, "triggerDelayTicks"));
            if (ValueBool(effect, "loop"))
            {
                string destroyMode = ValueString(effect, "destroyMode");
                if (destroyMode == "onActionEnd") return remainingTicks;
                if (destroyMode == "timed") return triggerDelayTicks + Mathf.Max(0, ValueInt(effect, "durationTicks"));
                return triggerDelayTicks;
            }
            int frameCount = (effect?["frameAssetIds"] as JArray)?.Values<string>().Count(value => !string.IsNullOrEmpty(value)) ?? 0;
            if (frameCount == 0 && !string.IsNullOrEmpty(ValueString(effect, "assetId"))) frameCount = 1;
            float fps = Mathf.Max(1f, ValueFloat(effect, "fps", 12f));
            return triggerDelayTicks + (frameCount > 0 ? Mathf.CeilToInt(frameCount * TickRate / fps) : 0);
        }

        private int GetSfxLifetimeTicks(JObject effect, int remainingTicks)
        {
            int triggerDelayTicks = Mathf.Max(0, ValueInt(effect, "triggerDelayTicks"));
            if (ValueBool(effect, "loop"))
            {
                string destroyMode = ValueString(effect, "destroyMode");
                if (destroyMode == "onActionEnd") return remainingTicks;
                if (destroyMode == "timed") return triggerDelayTicks + Mathf.Max(0, ValueInt(effect, "durationTicks"));
                return triggerDelayTicks;
            }
            AudioClip clip = characterAsset != null ? characterAsset.FindAsset<AudioClip>(ValueString(effect, "assetId")) : null;
            return triggerDelayTicks + (clip != null ? Mathf.CeilToInt(Mathf.Max(0f, clip.length) * TickRate) : 0);
        }

        private static IEnumerable<JObject> Objects(JToken token)
        {
            return token is JArray array ? array.OfType<JObject>() : Enumerable.Empty<JObject>();
        }

        private static int ValueInt(JObject value, string key, int fallback = 0)
        {
            JToken token = value?[key];
            return token != null && token.Type != JTokenType.Null ? token.Value<int>() : fallback;
        }

        private static float ValueFloat(JObject value, string key, float fallback = 0f)
        {
            JToken token = value?[key];
            return token != null && token.Type != JTokenType.Null ? token.Value<float>() : fallback;
        }

        private static bool ValueBool(JObject value, string key, bool fallback = false)
        {
            JToken token = value?[key];
            return token != null && token.Type != JTokenType.Null ? token.Value<bool>() : fallback;
        }

        private static string ValueString(JObject value, string key, string fallback = "")
        {
            JToken token = value?[key];
            return token != null && token.Type != JTokenType.Null ? token.Value<string>() : fallback;
        }

    }
}
