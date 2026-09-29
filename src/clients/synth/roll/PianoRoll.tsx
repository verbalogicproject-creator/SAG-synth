/**
 * src/clients/synth/roll/PianoRoll.tsx — the pattern editor, Cubase-shaped, for a thumb.
 *
 * Keys on the left, a bar.beat ruler on top, a 16th grid, a velocity lane underneath and an
 * optional drum row above the grid (Eyal's reference roll kept its kick on C3 in the same
 * editor; here the kick is its own track, drawn in its own row). Landscape by design: at a
 * bar per screen a 16th is ~50 px, above the 44 px touch floor, where portrait gives 20.
 *
 * **It edits a pattern, not a track.** Props are a note list, a length and callbacks — no
 * `trackId`, no dispatcher. `SeqView` binds it to a song today; when SAG-DAW grows a
 * playlist of pattern blocks, the same component edits a block (`memory: sag-daw-target-model`).
 *
 * **One command per gesture.** A drag previews locally and commits ONE `onUpdate` on
 * release — the lesson of `c3ad760`, where a knob wrote the whole instrument per pointermove.
 * A velocity paint across many notes commits one `onSetNotes`.
 *
 * **Touch model.** One finger edits; two fingers pan and pinch-zoom time. So the grid sets
 * `touch-action: none` and pans itself — a native one-finger scroll would fight the pencil.
 * A mouse wheel still scrolls natively.
 *
 * Every note is a DOM element with `data-note-id` and an `aria-label` that reads like a DAW
 * ruler ("G1 · 1.1.2 · vel 70%"), so the roll is observable to Playwright and to
 * `npm run geometry` exactly like every other control on the surface. That is why it is DOM
 * and not canvas: a pattern is at most 64 steps, so the note count stays small.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Beats, NoteEvent, NoteName } from '../../../core/types';
import type { NotePatch } from '../../../core/commands';
import { COLOR, FONT } from '../tokens';
import {
  describeNote,
  dragPatch,
  hitTest,
  isBlackKey,
  nameOf,
  noteAt,
  noteRect,
  pitchOf,
  pitchToY,
  rows,
  snapFloor,
  velocityAt,
  xToBeat,
  type RollView,
} from './roll-geometry';

export type RollTool = 'pencil' | 'eraser';

export interface DrumLane {
  label: string;
  notes: readonly NoteEvent[];
  /** Toggle a hit at a 16th: add one if none starts there, remove it if one does. */
  onToggle: (beat: Beats) => void;
}

export interface PianoRollProps {
  notes: readonly NoteEvent[];
  length: Beats;
  beatsPerBar: number;
  /** Snap in beats; 0 is off. */
  grid: number;
  tool: RollTool;
  /** Velocity a new note gets. */
  velocity: number;
  mintId: () => string;
  onAdd: (note: NoteEvent) => void;
  onUpdate: (noteId: string, patch: NotePatch) => void;
  onRemove: (noteId: string) => void;
  onSetNotes: (notes: NoteEvent[]) => void;
  /** Sound a pitch briefly — when a note is drawn or dragged onto a new row. */
  onAudition?: (note: NoteName) => void;
  onSeek?: (beat: Beats) => void;
  /** The playhead in pattern beats, or null when stopped. Polled every animation frame. */
  getPlayhead?: () => Beats | null;
  drumLane?: DrumLane;
  /**
   * The other channels' notes (C5d), drawn dim and behind the grid's own.
   *
   * Context, not content: they are `pointer-events: none` and `aria-hidden`, so a finger
   * and a screen reader both pass straight through them to the channel being edited. What
   * they buy is the thing a single-channel roll cannot show — whether this line lands in
   * the gaps of the other one, which for a psytrance bass against a kick IS the part.
   */
  ghostNotes?: readonly NoteEvent[];
  /** Pitch range drawn. Default C0..C5, which covers every bass and most leads. */
  topPitch?: number;
  bottomPitch?: number;
}

const KEYS_WIDTH = 48;
const RULER_HEIGHT = 24;
const DRUM_HEIGHT = 30;
const VELOCITY_HEIGHT = 64;
const ROW_HEIGHT = 22;
const MIN_BEAT_WIDTH = 40;
const MAX_BEAT_WIDTH = 640;
/** Two taps on one note within this many ms delete it, in pencil mode. */
const DOUBLE_TAP_MS = 320;

/**
 * How far a finger may travel on the keys column and still count as a tap.
 *
 * Half a row: a tap that wandered further than that was on its way somewhere, and
 * auditioning a note under a scrolling thumb is the kind of noise that makes a surface
 * feel broken.
 */
const KEYS_DRAG_SLOP = ROW_HEIGHT / 2;

/**
 * The gesture in flight. `last` is the note as the finger has it NOW, kept here rather than
 * read back from React state: `pointermove` is a continuous-priority event that React may
 * batch past the `pointerup` that follows it, so a commit that read the preview STATE could
 * commit a frame-old position. State is for drawing; this ref is the truth.
 */
type Gesture =
  | { kind: 'draw'; pointer: number; note: NoteEvent; startX: number; last: NoteEvent }
  | { kind: 'move' | 'resize'; pointer: number; note: NoteEvent; startX: number; startY: number; last: NoteEvent }
  | { kind: 'erase'; pointer: number; erased: Set<string> }
  | {
      kind: 'twoFinger';
      pointers: Map<number, { x: number; y: number }>;
      startDistance: number;
      startBeatWidth: number;
      anchorBeat: number;
    };

export function PianoRoll(props: PianoRollProps) {
  const { notes, length, beatsPerBar, grid, tool, velocity } = props;
  const topPitch = props.topPitch ?? 60;
  const bottomPitch = props.bottomPitch ?? 0;

  const scroller = useRef<HTMLDivElement | null>(null);
  const [beatWidth, setBeatWidth] = useState(180);
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  /** The note being dragged, drawn where the finger is rather than where the song has it. */
  const [preview, setPreview] = useState<NoteEvent | null>(null);
  /** Velocities being painted, by note id, before the one commit on release. */
  const [painted, setPainted] = useState<ReadonlyMap<string, number>>(new Map());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ noteId: string; at: number } | null>(null);
  const playheadLine = useRef<HTMLDivElement | null>(null);

  const view: RollView = useMemo(
    () => ({ beatWidth, rowHeight: ROW_HEIGHT, topPitch, bottomPitch, length }),
    [beatWidth, topPitch, bottomPitch, length],
  );
  const width = length * beatWidth;
  const height = rows(view) * ROW_HEIGHT;

  /** Scroll so the notes' average pitch sits mid-view (C2 when there are none). */
  const centreOnNotes = (element: HTMLDivElement): void => {
    const pitches = notes.map((n) => pitchOf(n.note)).filter((p): p is number => p !== null);
    const centre = pitches.length > 0 ? pitches.reduce((a, b) => a + b, 0) / pitches.length : 24;
    element.scrollTop = Math.max(0, pitchToY(Math.round(centre), view) - element.clientHeight / 2);
  };

  // Fit the pattern to the width on first layout, and open on the notes rather than on C5.
  // Only on mount and when the pattern length changes — re-fitting on every edit would
  // yank the view out from under the finger.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const fit = element.clientWidth / Math.max(length, 1);
    setBeatWidth(Math.min(MAX_BEAT_WIDTH, Math.max(MIN_BEAT_WIDTH, fit)));
    centreOnNotes(element);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [length]);

  // When the set of pitches changes and NONE of the notes is on screen — a pattern written
  // from elsewhere (PSY, an agent, an undo) — go and find them. Found as a bug in the first
  // screenshot: PSY wrote a G1 roll while the view sat on C2, and the roll looked empty. The
  // "none visible" guard is what keeps this from moving the view during an edit, where the
  // note being edited is by definition on screen.
  const pitchKey = useMemo(() => [...new Set(notes.map((n) => n.note))].sort().join(','), [notes]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null || notes.length === 0) return;
    const top = element.scrollTop;
    const bottom = top + element.clientHeight;
    const visible = notes.some((note) => {
      const pitch = pitchOf(note.note);
      if (pitch === null) return false;
      const y = pitchToY(pitch, view);
      return y >= top && y + ROW_HEIGHT <= bottom;
    });
    if (!visible) centreOnNotes(element);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pitchKey]);

  // The playhead is moved by the animation frame directly, not by React: a re-render per
  // frame would redraw every note sixty times a second to move one line.
  useEffect(() => {
    const getPlayhead = props.getPlayhead;
    if (getPlayhead === undefined) return;
    let frame = 0;
    const tick = (): void => {
      const line = playheadLine.current;
      const beat = getPlayhead();
      if (line !== null) {
        if (beat === null) line.style.display = 'none';
        else {
          line.style.display = 'block';
          line.style.transform = `translateX(${(beat % length) * beatWidth}px)`;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [props.getPlayhead, length, beatWidth]);

  /** A pointer's position in grid content coordinates. */
  const local = useCallback((event: { clientX: number; clientY: number }) => {
    const element = scroller.current!;
    const box = element.getBoundingClientRect();
    return { x: event.clientX - box.left + element.scrollLeft, y: event.clientY - box.top + element.scrollTop };
  }, []);

  const shown = useMemo(() => {
    if (preview === null) return notes;
    const without = notes.filter((n) => n.noteId !== preview.noteId);
    return [...without, preview];
  }, [notes, preview]);

  // -- grid gestures ---------------------------------------------------------

  const onGridDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = gesture.current;
    // A second finger turns any edit into navigation, and drops the edit: a pinch that
    // began as a tap on a note must not also move that note.
    if (current !== null && current.kind !== 'twoFinger' && 'pointer' in current && current.pointer !== event.pointerId) {
      const first = { x: event.clientX, y: event.clientY };
      startTwoFinger(current.pointer, first, event);
      return;
    }
    if (current?.kind === 'twoFinger') {
      current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      return;
    }
    capture(event);
    const { x, y } = local(event);
    const hit = hitTest(notes, x, y, view);

    if (tool === 'eraser') {
      const erased = new Set<string>();
      if (hit !== null) {
        erased.add(hit.noteId);
        props.onRemove(hit.noteId);
      }
      gesture.current = { kind: 'erase', pointer: event.pointerId, erased };
      return;
    }

    if (hit !== null) {
      const note = notes.find((n) => n.noteId === hit.noteId)!;
      const now = performance.now();
      if (lastTap.current?.noteId === note.noteId && now - lastTap.current.at < DOUBLE_TAP_MS) {
        lastTap.current = null;
        props.onRemove(note.noteId);
        return;
      }
      lastTap.current = { noteId: note.noteId, at: now };
      gesture.current = {
        kind: hit.zone === 'end' ? 'resize' : 'move',
        pointer: event.pointerId,
        note,
        startX: x,
        startY: y,
        last: note,
      };
      return;
    }

    const drawn = noteAt(x, y, view, grid, velocity, props.mintId());
    if (drawn === null) return;
    gesture.current = { kind: 'draw', pointer: event.pointerId, note: drawn, startX: x, last: drawn };
    setPreview(drawn);
    props.onAudition?.(drawn.note);
  };

  const startTwoFinger = (
    firstPointer: number,
    second: { x: number; y: number },
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    setPreview(null);
    const element = scroller.current!;
    const pointers = new Map<number, { x: number; y: number }>();
    pointers.set(event.pointerId, second);
    // The first finger's last position is unknown here; it is filled in on its next move.
    pointers.set(firstPointer, second);
    const box = element.getBoundingClientRect();
    gesture.current = {
      kind: 'twoFinger',
      pointers,
      startDistance: 0,
      startBeatWidth: beatWidth,
      anchorBeat: xToBeat(second.x - box.left + element.scrollLeft, view),
    };
  };

  const onGridMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = gesture.current;
    if (current === null) return;

    if (current.kind === 'twoFinger') {
      const previous = current.pointers.get(event.pointerId);
      if (previous === undefined) return;
      const next = { x: event.clientX, y: event.clientY };
      current.pointers.set(event.pointerId, next);
      const element = scroller.current!;
      const points = [...current.pointers.values()];
      if (points.length >= 2) {
        const distance = Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
        if (current.startDistance === 0) current.startDistance = distance;
        else if (Math.abs(points[0]!.x - points[1]!.x) > 24) {
          // Horizontal pinch zooms time, keeping the beat under the fingers where it was.
          const zoom = Math.min(
            MAX_BEAT_WIDTH,
            Math.max(MIN_BEAT_WIDTH, current.startBeatWidth * (distance / current.startDistance)),
          );
          if (Math.abs(zoom - beatWidth) > 0.5) {
            const box = element.getBoundingClientRect();
            const midX = (points[0]!.x + points[1]!.x) / 2 - box.left;
            setBeatWidth(zoom);
            element.scrollLeft = Math.max(0, current.anchorBeat * zoom - midX);
          }
        }
      }
      // Two-finger drag pans, by half the movement of each finger (they both report it).
      element.scrollLeft -= (next.x - previous.x) / 2;
      element.scrollTop -= (next.y - previous.y) / 2;
      return;
    }

    if (current.pointer !== event.pointerId) return;
    const { x, y } = local(event);

    if (current.kind === 'erase') {
      const hit = hitTest(notes, x, y, view);
      if (hit !== null && !current.erased.has(hit.noteId)) {
        current.erased.add(hit.noteId);
        props.onRemove(hit.noteId);
      }
      return;
    }

    if (current.kind === 'draw') {
      // Dragging right while drawing sets the new note's length.
      const extra = dragPatch(current.note, 'resize', x - current.startX, 0, view, grid);
      current.last = { ...current.note, ...extra };
      setPreview(current.last);
      return;
    }

    const patch = dragPatch(current.note, current.kind, x - current.startX, y - current.startY, view, grid);
    const next = { ...current.note, ...patch };
    // Audition a pitch the moment the note lands on a new row, once per row.
    if (current.kind === 'move' && next.note !== current.last.note) props.onAudition?.(next.note);
    current.last = next;
    setPreview(Object.keys(patch).length > 0 ? next : null);
  };

  const onGridUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = gesture.current;
    if (current === null) return;
    if (current.kind === 'twoFinger') {
      current.pointers.delete(event.pointerId);
      if (current.pointers.size === 0) gesture.current = null;
      return;
    }
    if (current.pointer !== event.pointerId) return;
    gesture.current = null;

    if (current.kind === 'draw') {
      setPreview(null);
      props.onAdd(current.last);
      return;
    }
    if (current.kind === 'move' || current.kind === 'resize') {
      setPreview(null);
      const patch = changed(current.note, current.last);
      if (Object.keys(patch).length > 0) {
        lastTap.current = null;
        props.onUpdate(current.note.noteId, patch);
      }
    }
  };

  const onGridCancel = (): void => {
    gesture.current = null;
    setPreview(null);
  };

  // -- velocity lane ---------------------------------------------------------

  /** Same reasoning as `Gesture.last`: the painted values live in the ref, state only draws them. */
  const paint = useRef<{ pointer: number; values: Map<string, number> } | null>(null);
  const velocityLane = useRef<HTMLDivElement | null>(null);

  const paintAt = (event: React.PointerEvent<HTMLDivElement>): void => {
    const lane = velocityLane.current!;
    const box = lane.getBoundingClientRect();
    const x = event.clientX - box.left + (scroller.current?.scrollLeft ?? 0);
    const value = velocityAt(event.clientY - box.top, VELOCITY_HEIGHT);
    // Every note whose drawn span covers x, or whose start is within 8 px of it — a
    // psytrance 16th is narrow and the bar is narrower.
    const under = notes.filter((note) => {
      const start = note.time * beatWidth;
      const end = start + Math.max(8, note.duration * beatWidth);
      return x >= start - 4 && x < end;
    });
    const values = paint.current?.values;
    if (under.length === 0 || values === undefined) return;
    for (const note of under) values.set(note.noteId, value);
    setPainted(new Map(values));
  };

  const onLaneDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    capture(event);
    paint.current = { pointer: event.pointerId, values: new Map() };
    paintAt(event);
  };

  const onLaneMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (paint.current?.pointer !== event.pointerId) return;
    paintAt(event);
  };

  const onLaneUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (paint.current?.pointer !== event.pointerId) return;
    const values = paint.current.values;
    paint.current = null;
    const changes = [...values].filter(([id, value]) => notes.find((n) => n.noteId === id)?.velocity !== value);
    setPainted(new Map());
    if (changes.length === 0) return;
    if (changes.length === 1) {
      const [id, value] = changes[0]!;
      props.onUpdate(id, { velocity: value });
      return;
    }
    const byId = new Map(changes);
    props.onSetNotes(notes.map((note) => (byId.has(note.noteId) ? { ...note, velocity: byId.get(note.noteId)! } : note)));
  };

  // -- keys column: a tap auditions, a drag scrolls the pitch range -----------

  /**
   * One finger on the keys column moves the pitch range (C5d).
   *
   * The roll already pans pitch with TWO fingers on the grid, and that gesture is unusable
   * in portrait with one thumb — which is how the keys column, the one strip of the roll
   * that is not an edit surface, ended up owning it.
   *
   * A tap still auditions. The two are told apart by distance, not by time: the audition
   * fires on RELEASE, and only if the finger never travelled past `KEYS_DRAG_SLOP`. A
   * timer would fire the note in the middle of a slow scroll.
   */
  const keysDrag = useRef<{ pointerId: number; startY: number; lastY: number; moved: boolean } | null>(null);

  const onKeysDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    keysDrag.current = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY, moved: false };
    try {
      // Keeps the gesture on this column when the finger slides onto the grid. It throws
      // when the pointer is no longer active — a released touch, or a synthetic event —
      // and an exception here would abort the handler that just armed the drag.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Uncaptured is fine: the events still arrive while the finger is on the column.
    }
  };

  const onKeysMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = keysDrag.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const element = scroller.current;
    if (element === null) return;
    if (Math.abs(event.clientY - drag.startY) > KEYS_DRAG_SLOP) drag.moved = true;
    if (!drag.moved) return;
    // Dragging the keys DOWN reveals lower pitches, the way dragging paper moves the paper.
    element.scrollTop -= event.clientY - drag.lastY;
    drag.lastY = event.clientY;
  };

  const onKeysUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = keysDrag.current;
    keysDrag.current = null;
    // `drag.moved` is the whole tap-versus-scroll decision: a finger that travelled is
    // not asking to hear a note.
    if (drag === null || drag.pointerId !== event.pointerId || drag.moved) return;
    const key = (event.target as HTMLElement | null)?.closest?.('[data-pitch]');
    const pitch = Number(key?.getAttribute('data-pitch'));
    if (Number.isFinite(pitch)) props.onAudition?.(nameOf(pitch));
  };

  const onKeysCancel = (): void => {
    keysDrag.current = null;
  };

  /** Move the visible pitch range by an octave. `+1` scrolls down, toward lower notes. */
  const scrollOctave = (direction: number): void => {
    const element = scroller.current;
    if (element === null) return;
    element.scrollTop = Math.max(0, element.scrollTop + direction * 12 * ROW_HEIGHT);
  };

  // -- ruler and drum lane ---------------------------------------------------

  const onRulerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (props.onSeek === undefined) return;
    const box = event.currentTarget.getBoundingClientRect();
    const beat = Math.floor(xToBeat(event.clientX - box.left + (scroller.current?.scrollLeft ?? 0), view));
    if (beat >= 0 && beat < length) props.onSeek(beat);
  };

  const onDrumDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const lane = props.drumLane;
    if (lane === undefined) return;
    const box = event.currentTarget.getBoundingClientRect();
    const beat = snapFloor(xToBeat(event.clientX - box.left + (scroller.current?.scrollLeft ?? 0), view), 0.25);
    if (beat >= 0 && beat < length) lane.onToggle(beat);
  };

  // -- drawing ---------------------------------------------------------------

  const sixteenth = beatWidth / 4;
  const bar = beatWidth * beatsPerBar;
  const gridLines = [
    `repeating-linear-gradient(90deg, ${COLOR.border} 0 1px, transparent 1px ${bar}px)`,
    `repeating-linear-gradient(90deg, ${COLOR.surfaceVariant} 0 1px, transparent 1px ${beatWidth}px)`,
    `repeating-linear-gradient(90deg, ${COLOR.surfaceHigh} 0 1px, transparent 1px ${sixteenth}px)`,
  ].join(', ');

  const pitchRows: number[] = [];
  for (let pitch = topPitch; pitch >= bottomPitch; pitch -= 1) pitchRows.push(pitch);

  const barCount = Math.ceil(length / beatsPerBar);

  return (
    <div style={styles.root} data-sag-surface="piano-roll">
      {/* ruler */}
      <div style={styles.rulerRow}>
        <div style={styles.corner}>
          {/* Portrait has no room for a two-finger pan and a roll at once, and one finger
              is already the edit gesture — so the pitch range gets buttons of its own. */}
          <button
            type="button"
            onClick={() => scrollOctave(-1)}
            style={styles.octave}
            aria-label="scroll up an octave"
          >
            ▲
          </button>
          <button
            type="button"
            onClick={() => scrollOctave(1)}
            style={styles.octave}
            aria-label="scroll down an octave"
          >
            ▼
          </button>
        </div>
        <div style={styles.rulerClip} onPointerDown={onRulerDown} aria-label="ruler — tap to move the playhead">
          <div style={{ ...styles.rulerInner, width, transform: `translateX(${-scroll.left}px)` }}>
            {Array.from({ length: Math.ceil(length) }, (_unused, beat) => (
              <span
                key={beat}
                style={{
                  ...styles.rulerMark,
                  left: beat * beatWidth,
                  color: beat % beatsPerBar === 0 ? COLOR.accentText : COLOR.textDim,
                }}
              >
                {beat % beatsPerBar === 0
                  ? `${beat / beatsPerBar + 1}`
                  : `${Math.floor(beat / beatsPerBar) + 1}.${(beat % beatsPerBar) + 1}`}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* drum lane */}
      {props.drumLane !== undefined && (
        <div style={styles.laneRow}>
          <div style={{ ...styles.laneLabel, color: COLOR.overflow }}>{props.drumLane.label}</div>
          <div style={styles.drumClip} onPointerDown={onDrumDown} aria-label={`${props.drumLane.label} lane — tap a 16th to toggle`}>
            <div
              style={{
                ...styles.drumInner,
                width,
                backgroundImage: gridLines,
                transform: `translateX(${-scroll.left}px)`,
              }}
            >
              {props.drumLane.notes.map((hit) => (
                <div
                  key={hit.noteId}
                  data-drum-note-id={hit.noteId}
                  aria-label={`${props.drumLane!.label} hit · ${describeNote(hit, beatsPerBar)}`}
                  style={{
                    ...styles.drumHit,
                    left: hit.time * beatWidth + 1,
                    width: Math.max(6, Math.min(hit.duration, 0.25) * beatWidth - 2),
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* keys + grid */}
      <div style={styles.body}>
        <div
          style={styles.keysClip}
          onPointerDown={onKeysDown}
          onPointerMove={onKeysMove}
          onPointerUp={onKeysUp}
          onPointerCancel={onKeysCancel}
          aria-label="keys — tap to hear a pitch, drag to scroll"
        >
          <div style={{ transform: `translateY(${-scroll.top}px)` }}>
            {pitchRows.map((pitch) => (
              <div
                key={pitch}
                data-pitch={pitch}
                style={{
                  ...styles.key,
                  background: isBlackKey(pitch) ? COLOR.surfaceLowest : COLOR.surfaceVariant,
                  color: isBlackKey(pitch) ? COLOR.textDim : COLOR.text,
                }}
                aria-label={`key ${nameOf(pitch)}`}
              >
                {pitch % 12 === 0 ? nameOf(pitch) : ''}
              </div>
            ))}
          </div>
        </div>

        <div
          ref={scroller}
          style={styles.grid}
          onScroll={(event) =>
            setScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })
          }
          onPointerDown={onGridDown}
          onPointerMove={onGridMove}
          onPointerUp={onGridUp}
          onPointerCancel={onGridCancel}
          aria-label="piano roll grid"
          data-tool={tool}
        >
          <div style={{ position: 'relative', width, height }}>
            {pitchRows.map((pitch) => (
              <div
                key={pitch}
                style={{
                  ...styles.row,
                  top: pitchToY(pitch, view),
                  background: isBlackKey(pitch) ? COLOR.surfaceLowest : 'transparent',
                  borderBottom: pitch % 12 === 0 ? `1px solid ${COLOR.border}` : 'none',
                }}
              />
            ))}
            <div style={{ ...styles.lines, backgroundImage: gridLines }} />
            {Array.from({ length: barCount }, (_unused, index) => (
              <div key={index} style={{ ...styles.barLine, left: index * bar }} />
            ))}

            {(props.ghostNotes ?? []).map((note) => {
              const rect = noteRect(note, view);
              if (rect === null) return null;
              return (
                <div
                  key={`ghost-${note.noteId}`}
                  data-ghost-note-id={note.noteId}
                  aria-hidden="true"
                  style={{
                    ...styles.ghost,
                    left: rect.x,
                    top: rect.y + 1,
                    width: rect.width - 1,
                    height: rect.height - 2,
                  }}
                />
              );
            })}

            {shown.map((note) => {
              const rect = noteRect(note, view);
              if (rect === null) return null;
              const dragging = preview?.noteId === note.noteId;
              return (
                <div
                  key={note.noteId}
                  data-note-id={note.noteId}
                  aria-label={describeNote(note, beatsPerBar)}
                  style={{
                    ...styles.note,
                    left: rect.x,
                    top: rect.y + 1,
                    width: rect.width - 1,
                    height: rect.height - 2,
                    opacity: 0.4 + 0.6 * note.velocity,
                    outline: dragging ? `1px solid ${COLOR.accentText}` : 'none',
                  }}
                >
                  <span style={styles.grip} />
                </div>
              );
            })}

            <div ref={playheadLine} style={styles.playhead} aria-hidden="true" />
          </div>
        </div>
      </div>

      {/* velocity lane */}
      <div style={styles.laneRow}>
        <div style={styles.laneLabel}>VEL</div>
        <div
          ref={velocityLane}
          style={{ ...styles.velocityClip, height: VELOCITY_HEIGHT }}
          onPointerDown={onLaneDown}
          onPointerMove={onLaneMove}
          onPointerUp={onLaneUp}
          onPointerCancel={() => {
            paint.current = null;
            setPainted(new Map());
          }}
          aria-label="velocity lane — drag to set, swipe to paint"
        >
          <div style={{ position: 'relative', width, height: '100%', transform: `translateX(${-scroll.left}px)` }}>
            {notes.map((note) => {
              const value = painted.get(note.noteId) ?? note.velocity;
              return (
                <div
                  key={note.noteId}
                  data-velocity-of={note.noteId}
                  style={{
                    ...styles.velocityBar,
                    left: note.time * beatWidth,
                    height: `${Math.round(value * 100)}%`,
                    background: painted.has(note.noteId) ? COLOR.accentText : COLOR.accent,
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Only the fields of `after` that differ from `before` — what `updateNote` should carry. */
function changed(before: NoteEvent, after: NoteEvent): NotePatch {
  const patch: NotePatch = {};
  if (after.time !== before.time) patch.time = after.time;
  if (after.duration !== before.duration) patch.duration = after.duration;
  if (after.note !== before.note) patch.note = after.note;
  if (after.velocity !== before.velocity) patch.velocity = after.velocity;
  return patch;
}

/**
 * Capture so a drag that leaves the element keeps reporting to it. Wrapped because
 * Chromium throws for a pointer id it did not itself deliver — which a synthetic second
 * finger in a test is — and a failed capture must not abort the gesture.
 */
function capture(event: React.PointerEvent<HTMLElement>): void {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // Not fatal: without capture the gesture still works while the finger stays inside.
  }
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: COLOR.surface,
    fontFamily: FONT.mono,
    userSelect: 'none',
  },
  rulerRow: { display: 'flex', height: RULER_HEIGHT, flex: 'none', borderBottom: `1px solid ${COLOR.border}` },
  corner: {
    display: 'flex',
    width: KEYS_WIDTH,
    flex: 'none',
    background: COLOR.surfaceLowest,
    borderRight: `1px solid ${COLOR.border}`,
  },
  rulerClip: { flex: 1, overflow: 'hidden', position: 'relative', background: COLOR.surfaceLowest, cursor: 'pointer' },
  rulerInner: { position: 'relative', height: '100%' },
  rulerMark: { position: 'absolute', top: 5, fontSize: '0.6rem', paddingLeft: 3, borderLeft: `1px solid ${COLOR.border}` },
  laneRow: { display: 'flex', flex: 'none', borderBottom: `1px solid ${COLOR.border}` },
  laneLabel: {
    width: KEYS_WIDTH,
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.55rem',
    letterSpacing: '0.1em',
    color: COLOR.textDim,
    background: COLOR.surfaceLowest,
  },
  drumClip: { flex: 1, height: DRUM_HEIGHT, overflow: 'hidden', position: 'relative', touchAction: 'none' },
  drumInner: { position: 'relative', height: '100%' },
  drumHit: {
    position: 'absolute',
    top: 5,
    height: DRUM_HEIGHT - 10,
    background: COLOR.overflow,
    borderRadius: 2,
  },
  body: { display: 'flex', flex: 1, minHeight: 0 },
  keysClip: {
    width: KEYS_WIDTH,
    flex: 'none',
    overflow: 'hidden',
    borderRight: `1px solid ${COLOR.border}`,
    // The column owns a vertical drag now, so the browser must not also scroll the page
    // with it — without this the gesture fights whatever is behind the roll.
    touchAction: 'none',
  },
  ghost: {
    position: 'absolute',
    borderRadius: 2,
    background: COLOR.unwired,
    opacity: 0.45,
    // Context, never a target: the finger goes through to the channel being edited.
    pointerEvents: 'none',
  },
  octave: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    background: 'transparent',
    border: 'none',
    color: COLOR.textDim,
    fontSize: '0.6rem',
    lineHeight: 1,
    cursor: 'pointer',
  },
  key: {
    height: ROW_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingRight: 4,
    fontSize: '0.55rem',
    borderBottom: `1px solid ${COLOR.surfaceLowest}`,
    boxSizing: 'border-box',
  },
  grid: { flex: 1, overflow: 'auto', position: 'relative', touchAction: 'none', cursor: 'crosshair' },
  row: { position: 'absolute', left: 0, right: 0, height: ROW_HEIGHT, boxSizing: 'border-box' },
  lines: { position: 'absolute', inset: 0, pointerEvents: 'none', opacity: 0.8 },
  barLine: { position: 'absolute', top: 0, bottom: 0, width: 1, background: COLOR.textDim, opacity: 0.5 },
  note: {
    position: 'absolute',
    background: COLOR.accent,
    borderRadius: 2,
    boxSizing: 'border-box',
    boxShadow: `0 0 6px ${COLOR.accent}55`,
  },
  grip: {
    position: 'absolute',
    right: 2,
    top: '25%',
    bottom: '25%',
    width: 2,
    background: COLOR.surfaceLowest,
    opacity: 0.5,
  },
  playhead: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 1,
    background: COLOR.accentText,
    boxShadow: `0 0 4px ${COLOR.accent}`,
    pointerEvents: 'none',
    display: 'none',
  },
  velocityClip: { flex: 1, overflow: 'hidden', position: 'relative', touchAction: 'none', background: COLOR.surfaceLowest },
  velocityBar: { position: 'absolute', bottom: 0, width: 4, borderRadius: 1 },
} as const satisfies Record<string, React.CSSProperties>;
