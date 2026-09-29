/**
 * src/clients/synth/roll/roll-geometry.ts — the piano roll's arithmetic, with no DOM in it.
 *
 * Every question a finger on the roll asks is answered here: which beat and which pitch
 * is under it, what the grid snaps that to, whether it is on a note's body or its end, and
 * what a drag does to a note. The component only measures pointers and draws rectangles.
 * Pure on purpose, per /root/CLAUDE.md: a decision that can be a function is a runner test,
 * and a roll whose snap or hit-test were buried in pointer handlers would only ever be
 * tested by hand, on a phone, by the person least able to see why it misbehaves.
 *
 * **The roll edits a pattern — a note list and a length — not a track.** Nothing here knows
 * about `SongTrack`. That is the foundation for SAG-DAW's playlist of pattern blocks
 * (`memory: sag-daw-target-model`): when patterns stop living on tracks, this file and the
 * component above it move across unchanged.
 *
 * Pitch is an absolute semitone index with C0 = 0, so G1 is 19 and C4 is 48. It is only
 * for layout; every note stored is still a `NoteName`.
 */

import { noteName } from '../../debug/keyboard';
import type { Beats, NoteEvent, NoteName } from '../../../core/types';
import type { NotePatch } from '../../../core/commands';

export interface RollView {
  /** Horizontal zoom: pixels per beat. */
  beatWidth: number;
  /** Pixels per semitone row. */
  rowHeight: number;
  /** Highest pitch drawn, at the top row. */
  topPitch: number;
  /** Lowest pitch drawn, at the bottom row. */
  bottomPitch: number;
  /** The pattern's length; the grid ends here. */
  length: Beats;
}

/** Grid resolutions in beats. `0` is off: free placement. */
export const GRIDS = { '1/16': 0.25, '1/8': 0.5, '1/4': 1, off: 0 } as const;
export type GridName = keyof typeof GRIDS;

/** The smallest note a drag can make, whatever the grid: a 64th. */
export const MIN_DURATION: Beats = 1 / 16;

/**
 * How much of a note's right edge is the resize handle, in pixels.
 *
 * At least 12 px, and never more than 40% of the note, so a short note keeps a body to
 * grab. At the default zoom a psytrance 16th (0.15 beats) is ~30 px wide: 12 px of handle
 * and 18 px of body.
 */
export function resizeZone(noteWidthPx: number): number {
  return Math.min(Math.max(12, noteWidthPx * 0.25), noteWidthPx * 0.4);
}

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------

const LETTER: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * `NoteName` → absolute semitone (C0 = 0). Accepts every form `NOTE_NAME_RE` does:
 * sharps, flats, doubles and `x`. Returns null for anything else, so a malformed name is a
 * visible gap in the roll rather than a note drawn at pitch zero.
 */
export function pitchOf(name: NoteName): number | null {
  const match = /^([A-Ga-g])(#{1,2}|b{1,2}|x)?(-1|[0-9])$/.exec(name);
  if (match === null) return null;
  const base = LETTER[match[1]!.toUpperCase()]!;
  const accidental = match[2] ?? '';
  const shift =
    accidental === '#' ? 1 : accidental === '##' || accidental === 'x' ? 2 : accidental === 'b' ? -1 : accidental === 'bb' ? -2 : 0;
  return Number(match[3]) * 12 + base + shift;
}

/** Absolute semitone → `NoteName`, in sharps. The inverse of `pitchOf` for sharp names. */
export function nameOf(pitch: number): NoteName {
  return noteName(0, pitch);
}

export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

export function rows(view: RollView): number {
  return view.topPitch - view.bottomPitch + 1;
}

export function beatToX(beat: Beats, view: RollView): number {
  return beat * view.beatWidth;
}

export function xToBeat(x: number, view: RollView): Beats {
  return x / view.beatWidth;
}

export function pitchToY(pitch: number, view: RollView): number {
  return (view.topPitch - pitch) * view.rowHeight;
}

/** The row under `y`, clamped to the drawn range. */
export function yToPitch(y: number, view: RollView): number {
  const pitch = view.topPitch - Math.floor(y / view.rowHeight);
  return Math.min(view.topPitch, Math.max(view.bottomPitch, pitch));
}

/** Snap DOWN to the grid line at or before `beat` — where a tap on a cell places a note. */
export function snapFloor(beat: Beats, grid: number): Beats {
  if (grid <= 0) return beat;
  return Math.floor(beat / grid + 1e-9) * grid;
}

/** Snap to the NEAREST grid line — what a dragged note lands on. */
export function snapNearest(beat: Beats, grid: number): Beats {
  if (grid <= 0) return beat;
  return Math.round(beat / grid) * grid;
}

export interface NoteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a note is drawn, or null when its name is malformed or out of the drawn range. */
export function noteRect(note: NoteEvent, view: RollView): NoteRect | null {
  const pitch = pitchOf(note.note);
  if (pitch === null || pitch > view.topPitch || pitch < view.bottomPitch) return null;
  return {
    x: beatToX(note.time, view),
    y: pitchToY(pitch, view),
    width: Math.max(2, note.duration * view.beatWidth),
    height: view.rowHeight,
  };
}

export type HitZone = 'body' | 'end';

/**
 * The note under a point, and which part of it. Later notes win ties, because they are
 * drawn on top: the note you can see is the note you touch.
 */
export function hitTest(
  notes: readonly NoteEvent[],
  x: number,
  y: number,
  view: RollView,
): { noteId: string; zone: HitZone } | null {
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const note = notes[index]!;
    const rect = noteRect(note, view);
    if (rect === null) continue;
    if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) continue;
    const zone: HitZone = x >= rect.x + rect.width - resizeZone(rect.width) ? 'end' : 'body';
    return { noteId: note.noteId, zone };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gestures, as data
// ---------------------------------------------------------------------------

/**
 * The note a tap on an empty cell makes: at the grid line under the finger, one grid long
 * (a 16th when the grid is off, which is the psytrance unit).
 */
export function noteAt(
  x: number,
  y: number,
  view: RollView,
  grid: number,
  velocity: number,
  noteId: string,
): NoteEvent | null {
  const beat = snapFloor(xToBeat(x, view), grid);
  if (beat < 0 || beat >= view.length) return null;
  const duration = Math.min(grid > 0 ? grid : 0.25, view.length - beat);
  return { noteId, time: beat, duration, note: nameOf(yToPitch(y, view)), velocity };
}

/**
 * What a drag does to a note, from where the finger went down to where it is now.
 *
 * - `move` keeps the note's length and shifts its start (snapped to the nearest grid line)
 *   and its pitch (by whole rows). It stays inside the pattern.
 * - `resize` moves only the end, snapped, never shorter than `MIN_DURATION` (or one grid
 *   step when a grid is on) and never past the pattern's end.
 *
 * Returns only the fields that CHANGED. An empty patch means the drag came back to where it
 * started, and the caller dispatches nothing: `updateNote` refuses an empty patch, and a
 * journal row for a no-op would be noise.
 */
export function dragPatch(
  note: NoteEvent,
  kind: 'move' | 'resize',
  dx: number,
  dy: number,
  view: RollView,
  grid: number,
): NotePatch {
  const patch: NotePatch = {};
  if (kind === 'resize') {
    const floor = grid > 0 ? grid : MIN_DURATION;
    const end = snapNearest(note.time + note.duration + xToBeat(dx, view), grid);
    const duration = Math.min(Math.max(end - note.time, floor), view.length - note.time);
    if (!near(duration, note.duration)) patch.duration = round(duration);
    return patch;
  }

  const time = snapNearest(note.time + xToBeat(dx, view), grid);
  const clamped = Math.min(Math.max(time, 0), Math.max(0, view.length - note.duration));
  if (!near(clamped, note.time)) patch.time = round(clamped);

  const from = pitchOf(note.note);
  if (from !== null) {
    const rowsMoved = -Math.round(dy / view.rowHeight);
    const pitch = Math.min(view.topPitch, Math.max(view.bottomPitch, from + rowsMoved));
    if (pitch !== from) patch.note = nameOf(pitch);
  }
  return patch;
}

/** Velocity from a point in the velocity lane: top is 1, bottom is 0, clamped. */
export function velocityAt(y: number, laneHeight: number): number {
  if (laneHeight <= 0) return 0;
  return round(Math.min(1, Math.max(0, 1 - y / laneHeight)));
}

/** "G1 · 1.2.1 · vel 70%" — bar.beat.sixteenth, 1-based, the way a DAW ruler reads. */
export function describeNote(note: NoteEvent, beatsPerBar = 4): string {
  return `${note.note} · ${position(note.time, beatsPerBar)} · vel ${Math.round(note.velocity * 100)}%`;
}

/** 1-based bar.beat.sixteenth of a beat position. */
export function position(beat: Beats, beatsPerBar = 4): string {
  const bar = Math.floor(beat / beatsPerBar) + 1;
  const inBar = beat - (bar - 1) * beatsPerBar;
  const beatInBar = Math.floor(inBar + 1e-9) + 1;
  const sixteenth = Math.floor((inBar - (beatInBar - 1)) * 4 + 1e-9) + 1;
  return `${bar}.${beatInBar}.${sixteenth}`;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/** Six decimals: a dragged note should not be saved at 0.30000000000000004. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
