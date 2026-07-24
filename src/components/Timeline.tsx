import { ClipboardCopy, ClipboardPaste, Copy, ListX, MapPin, Plus, Rows3, Trash2 } from "lucide-react";
import { useMemo, useRef } from "react";
import { actionPlaybackDuration, actionTimelineDuration, frameBoundaries, timelineEventDisplayDuration, TRACK_META } from "../model";
import type { ActionMarker, ActionSegment, AssetRef, TimelineEvent, TimelineTrack } from "../types";

interface TimelineProps {
  segment: ActionSegment;
  assets: Record<string, AssetRef>;
  tickRate: number;
  playheadTick: number;
  selectedEventId: string | null;
  selectedMarkerId: string | null;
  onPlayheadChange: (tick: number) => void;
  onSelectEvent: (trackId: string, eventId: string) => void;
  onAddEvent: (track: TimelineTrack, tick: number) => void;
  onUpdateEvent: (trackId: string, eventId: string, patch: Partial<TimelineEvent>) => void;
  onResizeEvent: (trackId: string, eventId: string, displayDuration: number) => void;
  onDuplicateEvent: () => void;
  onCopyEvent: () => void;
  onPasteEvent: () => void;
  canPasteEvent: boolean;
  stackOverlappingEvents: boolean;
  onToggleStackOverlappingEvents: () => void;
  onClearEvents: () => void;
  onDeleteEvent: () => void;
  onSelectMarker: (markerId: string) => void;
  onAddMarker: (tick: number) => void;
  onUpdateMarker: (markerId: string, patch: Partial<ActionMarker>) => void;
}

const HEADER_WIDTH = 136;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function Timeline({
  segment,
  assets,
  tickRate,
  playheadTick,
  selectedEventId,
  selectedMarkerId,
  onPlayheadChange,
  onSelectEvent,
  onAddEvent,
  onUpdateEvent,
  onResizeEvent,
  onDuplicateEvent,
  onCopyEvent,
  onPasteEvent,
  canPasteEvent,
  stackOverlappingEvents,
  onToggleStackOverlappingEvents,
  onClearEvents,
  onDeleteEvent,
  onSelectMarker,
  onAddMarker,
  onUpdateMarker,
}: TimelineProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentDuration = actionTimelineDuration(segment, assets, tickRate);
  const animationDuration = actionPlaybackDuration(segment);
  const editPaddingTicks = 300;
  const duration = Math.max(300, contentDuration + editPaddingTicks);
  const boundaries = useMemo(() => frameBoundaries(segment), [segment]);
  const frameRows = segment.frames;

  const snapTick = (raw: number) => {
    const candidates = segment.markers.map((marker) => marker.tick);
    let snapped = Math.round(raw / 10) * 10;
    let distance = 10;
    for (const candidate of candidates) {
      const nextDistance = Math.abs(candidate - raw);
      if (nextDistance < distance) {
        snapped = candidate;
        distance = nextDistance;
      }
    }
    return clamp(snapped, 0, duration);
  };

  const tickFromClientX = (clientX: number) => {
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return snapTick(((clientX - rect.left) / rect.width) * duration);
  };

  const startPlayheadDrag = (pointerEvent: React.PointerEvent) => {
    if (pointerEvent.button !== 0) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    const update = (clientX: number) => onPlayheadChange(tickFromClientX(clientX));
    update(pointerEvent.clientX);
    const handleMove = (moveEvent: PointerEvent) => update(moveEvent.clientX);
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const layoutTrackEvents = (track: TimelineTrack) => {
    const laneByEvent = new Map<string, number>();
    if (!stackOverlappingEvents || track.events.length < 2) {
      for (const event of track.events) laneByEvent.set(event.id, 0);
      return { laneByEvent, laneCount: 1 };
    }
    const minimumVisualDuration = Math.max(1, duration * 0.015);
    const laneEnds: number[] = [];
    const ordered = track.events.map((event, index) => {
      const displayDuration = timelineEventDisplayDuration(event, track.kind, segment, assets, tickRate);
      return {
        event,
        index,
        end: event.startTick + Math.max(minimumVisualDuration, displayDuration),
      };
    }).sort((left, right) => left.event.startTick - right.event.startTick || left.index - right.index);
    for (const item of ordered) {
      let lane = laneEnds.findIndex((end) => end <= item.event.startTick);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = item.end;
      laneByEvent.set(item.event.id, lane);
    }
    return { laneByEvent, laneCount: Math.max(1, laneEnds.length) };
  };

  const startEventDrag = (
    pointerEvent: React.PointerEvent,
    track: TimelineTrack,
    event: TimelineEvent,
    mode: "move" | "resize",
  ) => {
    pointerEvent.stopPropagation();
    onSelectEvent(track.id, event.id);
    const startX = pointerEvent.clientX;
    const startTick = event.startTick;
    const startDuration = timelineEventDisplayDuration(event, track.kind, segment, assets, tickRate);
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ticksPerPixel = duration / rect.width;

    const handleMove = (moveEvent: PointerEvent) => {
      const deltaTicks = (moveEvent.clientX - startX) * ticksPerPixel;
      if (mode === "move") {
        onUpdateEvent(track.id, event.id, {
          startTick: snapTick(clamp(startTick + deltaTicks, 0, duration - startDuration)),
        });
      } else {
        onResizeEvent(track.id, event.id, snapTick(Math.max(10, startDuration + deltaTicks)));
      }
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const startMarkerDrag = (pointerEvent: React.PointerEvent, marker: ActionMarker) => {
    pointerEvent.stopPropagation();
    onSelectMarker(marker.id);
    const handleMove = (moveEvent: PointerEvent) => onUpdateMarker(marker.id, { tick: tickFromClientX(moveEvent.clientX) });
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  return (
    <section className="timeline" aria-label="动作时间轴">
      <div className="timeline-toolbar">
        <div>
          <strong>动作时间轴</strong>
          <span>动画 {animationDuration} Tick · 时间轴内容 {contentDuration} Tick · 右侧预留 {editPaddingTicks} Tick</span>
        </div>
        <div className="toolbar-actions">
          <button className="icon-button" type="button" title="添加对齐标记（仅辅助编辑，不触发游戏事件）" onClick={() => onAddMarker(playheadTick)}>
            <MapPin size={16} />
          </button>
          <button className="icon-button" type="button" title="复制当前事件副本" onClick={onDuplicateEvent} disabled={!selectedEventId}>
            <Copy size={16} />
          </button>
          <button className="icon-button" type="button" title="复制事件到剪贴板" onClick={onCopyEvent} disabled={!selectedEventId}>
            <ClipboardCopy size={16} />
          </button>
          <button className="icon-button" type="button" title="粘贴事件到播放头" onClick={onPasteEvent} disabled={!canPasteEvent}>
            <ClipboardPaste size={16} />
          </button>
          <button className={`icon-button${stackOverlappingEvents ? " active" : ""}`} type="button" title={stackOverlappingEvents ? "关闭重叠事件换行" : "重叠事件换行显示"} onClick={onToggleStackOverlappingEvents}>
            <Rows3 size={16} />
          </button>
          <button className="icon-button danger" type="button" title="清空当前动作段事件" onClick={onClearEvents} disabled={!segment.tracks.some((track) => track.events.length)}>
            <ListX size={16} />
          </button>
          <button className="icon-button danger" type="button" title="删除事件" onClick={onDeleteEvent} disabled={!selectedEventId}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="timeline-scroll">
        <div className="timeline-ruler-row">
          <div className="timeline-track-header">时间</div>
          <div
            className="timeline-ruler"
            ref={bodyRef}
            onPointerDown={startPlayheadDrag}
          >
            {Array.from({ length: 11 }, (_, index) => {
              const tick = Math.round((duration * index) / 10);
              return (
                <div className="ruler-mark" key={index} style={{ left: `${index * 10}%` }}>
                  <i />
                  <span>{(tick / Math.max(1, tickRate)).toFixed(2)}s</span>
                </div>
              );
            })}
            {segment.markers.map((marker) => (
              <div className="marker-line" key={marker.id} style={{ left: `${(marker.tick / duration) * 100}%` }} title={marker.name} />
            ))}
          </div>
        </div>

        <div className="timeline-row animation-row">
          <div className="timeline-track-header">
            <span className="track-dot animation-dot" />
            动画帧
          </div>
          <div className="timeline-body" onPointerDown={startPlayheadDrag}>
            {frameRows.map((frame, index) => {
              const start = boundaries[index] ?? 0;
              return (
                <div
                  className="frame-block"
                  key={frame.id}
                  style={{
                    left: `${(start / duration) * 100}%`,
                    width: `${(frame.durationTicks / duration) * 100}%`,
                  }}
                  title={`${frame.name} · ${frame.durationTicks} Tick`}
                >
                  <span>{index + 1}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="timeline-row marker-row">
          <div className="timeline-track-header"><span className="track-dot marker-dot" />时间标记</div>
          <div className="timeline-body" onPointerDown={startPlayheadDrag}>
            {segment.markers.map((marker) => <button
              type="button"
              key={marker.id}
              className={`timeline-marker${selectedMarkerId === marker.id ? " selected" : ""}`}
              style={{ left: `${(marker.tick / duration) * 100}%` }}
              title={`${marker.name} · ${marker.tick} Tick`}
              onPointerDown={(event) => startMarkerDrag(event, marker)}
            ><MapPin size={13} /></button>)}
          </div>
        </div>

        {segment.tracks.map((track) => {
          const layout = layoutTrackEvents(track);
          return <div className={`timeline-row${layout.laneCount > 1 ? " has-event-lanes" : ""}`} key={track.id} style={{ height: 34 + (layout.laneCount - 1) * 29 }}>
            <div className="timeline-track-header">
              <span className="track-dot" style={{ background: TRACK_META[track.kind].color }} />
              <span>{track.name}</span>
              <button
                type="button"
                className="track-add-button"
                title={`添加${track.name}`}
                onClick={() => onAddEvent(track, playheadTick)}
              >
                <Plus size={14} />
              </button>
            </div>
            <div className="timeline-body" onPointerDown={startPlayheadDrag}>
              {track.events.map((event) => {
                const untilActionEnd = track.kind === "speed" || track.kind === "camera"
                  ? event.params.durationMode === "untilActionEnd"
                  : event.triggerMode === "repeated" && event.activeDurationMode === "untilActionEnd";
                const displayDuration = timelineEventDisplayDuration(event, track.kind, segment, assets, tickRate);
                const instant = displayDuration <= 0;
                const canResize = !untilActionEnd && (track.kind === "speed" || track.kind === "camera" || event.triggerMode === "repeated");
                return (
                  <button
                    type="button"
                    key={event.id}
                    className={`timeline-event${selectedEventId === event.id ? " selected" : ""}${instant ? " instant" : ""}`}
                    style={{
                      left: `${(event.startTick / duration) * 100}%`,
                      top: 4 + (layout.laneByEvent.get(event.id) || 0) * 29,
                      width: instant ? 12 : `${Math.max(1.5, (displayDuration / duration) * 100)}%`,
                      background: event.color,
                    }}
                    title={`${event.name} · ${event.startTick} Tick`}
                    onPointerDown={(pointerEvent) => startEventDrag(pointerEvent, track, event, "move")}
                  >
                    <span>{event.name}</span>
                    {!instant && canResize && (
                      <i
                        className="event-resize-handle"
                        onPointerDown={(pointerEvent) => startEventDrag(pointerEvent, track, event, "resize")}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>;
        })}

        <div
          className="timeline-playhead"
          role="slider"
          aria-label="时间轴播放头"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={playheadTick}
          tabIndex={0}
          style={{ left: `calc(${HEADER_WIDTH}px + (100% - ${HEADER_WIDTH}px) * ${playheadTick / duration})` }}
          onPointerDown={startPlayheadDrag}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              onPlayheadChange(clamp(playheadTick + (event.key === "ArrowLeft" ? -10 : 10), 0, duration));
            } else if (event.key === "Home") onPlayheadChange(0);
            else if (event.key === "End") onPlayheadChange(duration);
          }}
        >
          <i />
        </div>
      </div>
    </section>
  );
}
