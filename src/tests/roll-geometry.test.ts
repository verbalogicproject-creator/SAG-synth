/**
 * src/tests/roll-geometry.test.ts — the piano roll's decisions, without a browser.
 *
 * `roll.browser.test.ts` taps the real painted roll. This file owns the arithmetic those
 * taps depend on — snap, hit zones, what a drag does — where a wrong answer is cheap to see.
 */

import { describe, expect, it } from 'vitest';
import {
  GRIDS,
  MIN_DURATION,
  describeNote,
  dragPatch,
  hitTest,
  isBlackKey,
  nameOf,
  noteAt,
  noteRect,
  pitchOf,
  pitchToY,
  position,
  resizeZone,
  snapFloor,
  snapNearest,
  velocityAt,
  yToPitch,
  type RollView,
} from '../clients/synth/roll/roll-geometry';
import type { NoteEvent } from '../core/types';

// A bar of 16ths at 200 px/beat — 50 px per 16th, the landscape phone's zoom.
const VIEW: RollView = { beatWidth: 200, rowHeight: 20, topPitch: 48, bottomPitch: 12, length: 4 };
const G1 = 19;

function note(noteId: string, time: number, duration = 0.15, name = 'G1', velocity = 1): NoteEvent {
  return { noteId, time, duration, note: name, velocity };
}

describe('pitch', () => {
  it('reads every NOTE_NAME_RE form', () => {
    expect(pitchOf('C0')).toBe(0);
    expect(pitchOf('G1')).toBe(19);
    expect(pitchOf('C4')).toBe(48);
    expect(pitchOf('F#2')).toBe(30);
    expect(pitchOf('Gb2')).toBe(30);
    expect(pitchOf('Cb4')).toBe(47);
    expect(pitchOf('Ex3')).toBe(42);
    expect(pitchOf('c-1')).toBe(-12);
    expect(pitchOf('H2')).toBeNull();
  });

  it('names round-trip through sharps', () => {
    for (let pitch = 0; pitch < 96; pitch += 1) expect(pitchOf(nameOf(pitch))).toBe(pitch);
  });

  it('knows the black keys', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter(isBlackKey)).toEqual([1, 3, 6, 8, 10]);
  });
});

describe('coordinates', () => {
  it('draws high pitches at the top and maps a row back to its pitch', () => {
    expect(pitchToY(48, VIEW)).toBe(0);
    expect(pitchToY(G1, VIEW)).toBe((48 - G1) * 20);
    expect(yToPitch((48 - G1) * 20 + 5, VIEW)).toBe(G1);
    expect(yToPitch(-100, VIEW)).toBe(48);
    expect(yToPitch(1e6, VIEW)).toBe(12);
  });

  it('snaps a tap down to the cell it is in, and a drag to the nearest line', () => {
    expect(snapFloor(0.49, GRIDS['1/16'])).toBe(0.25);
    expect(snapFloor(0.5, GRIDS['1/16'])).toBe(0.5);
    expect(snapNearest(0.37, GRIDS['1/16'])).toBe(0.25);
    expect(snapNearest(0.38, GRIDS['1/16'])).toBe(0.5);
    expect(snapFloor(0.37, GRIDS.off)).toBe(0.37);
  });

  it('draws nothing for a note it cannot place', () => {
    expect(noteRect(note('x', 0, 0.25, 'C7'), VIEW)).toBeNull();
    expect(noteRect(note('x', 0, 0.25, 'nope'), VIEW)).toBeNull();
  });
});

describe('hitTest', () => {
  const notes = [note('a', 0.25), note('b', 0.5)];
  const y = pitchToY(G1, VIEW) + 10;

  it('finds a psytrance 16th’s body and its end, 12 px of handle on 30 px of note', () => {
    expect(resizeZone(30)).toBe(12);
    expect(hitTest(notes, 0.25 * 200 + 5, y, VIEW)).toEqual({ noteId: 'a', zone: 'body' });
    expect(hitTest(notes, 0.25 * 200 + 25, y, VIEW)).toEqual({ noteId: 'a', zone: 'end' });
  });

  it('misses between notes and on other rows', () => {
    expect(hitTest(notes, 0.45 * 200, y, VIEW)).toBeNull();
    expect(hitTest(notes, 0.25 * 200 + 5, y + 20, VIEW)).toBeNull();
  });

  it('gives an overlap to the note drawn on top', () => {
    const stacked = [note('under', 0, 1), note('over', 0.25, 0.25)];
    expect(hitTest(stacked, 0.3 * 200, y, VIEW)?.noteId).toBe('over');
  });

  it('never lets the handle swallow a short note', () => {
    expect(resizeZone(10)).toBe(4);
  });
});

describe('noteAt — a tap on an empty cell', () => {
  it('places a note one grid step long at the cell’s start, on the row’s pitch', () => {
    expect(noteAt(0.3 * 200, pitchToY(G1, VIEW) + 3, VIEW, GRIDS['1/16'], 0.8, 'n1')).toEqual({
      noteId: 'n1',
      time: 0.25,
      duration: 0.25,
      note: 'G1',
      velocity: 0.8,
    });
  });

  it('makes a 16th when the grid is off, and nothing past the pattern', () => {
    expect(noteAt(0.3 * 200, 0, VIEW, GRIDS.off, 1, 'n')?.duration).toBe(0.25);
    expect(noteAt(4 * 200 + 1, 0, VIEW, GRIDS['1/16'], 1, 'n')).toBeNull();
  });

  it('never runs past the end of the pattern', () => {
    expect(noteAt(3.9 * 200, 0, VIEW, GRIDS['1/4'], 1, 'n')).toMatchObject({ time: 3, duration: 1 });
  });
});

describe('dragPatch', () => {
  const a = note('a', 0.25, 0.15);

  it('moves by whole grid steps and whole rows, reporting only what changed', () => {
    expect(dragPatch(a, 'move', 0.26 * 200, 0, VIEW, GRIDS['1/16'])).toEqual({ time: 0.5 });
    expect(dragPatch(a, 'move', 0, -40, VIEW, GRIDS['1/16'])).toEqual({ note: 'A1' });
    expect(dragPatch(a, 'move', 5, 5, VIEW, GRIDS['1/16'])).toEqual({});
  });

  it('keeps a moved note inside the pattern', () => {
    expect(dragPatch(a, 'move', -1000, 0, VIEW, GRIDS['1/16'])).toEqual({ time: 0 });
    expect(dragPatch(a, 'move', 1e5, 0, VIEW, GRIDS.off).time).toBeCloseTo(4 - 0.15, 9);
  });

  it('resizes the end to the nearest line, never below one step or past the pattern', () => {
    expect(dragPatch(a, 'resize', 0.1 * 200, 0, VIEW, GRIDS['1/16'])).toEqual({ duration: 0.25 });
    expect(dragPatch(a, 'resize', -1000, 0, VIEW, GRIDS['1/16'])).toEqual({ duration: 0.25 });
    expect(dragPatch(a, 'resize', -1000, 0, VIEW, GRIDS.off)).toEqual({ duration: MIN_DURATION });
    expect(dragPatch(a, 'resize', 1e5, 0, VIEW, GRIDS['1/16'])).toEqual({ duration: 3.75 });
  });
});

describe('velocity lane and labels', () => {
  it('maps the lane top to 1 and the bottom to 0', () => {
    expect(velocityAt(0, 80)).toBe(1);
    expect(velocityAt(80, 80)).toBe(0);
    expect(velocityAt(24, 80)).toBe(0.7);
    expect(velocityAt(-5, 80)).toBe(1);
  });

  it('reads positions the way a DAW ruler does', () => {
    expect(position(0)).toBe('1.1.1');
    expect(position(0.25)).toBe('1.1.2');
    expect(position(1.75)).toBe('1.2.4');
    expect(position(4)).toBe('2.1.1');
    expect(describeNote(note('a', 0.25, 0.15, 'G1', 0.7))).toBe('G1 · 1.1.2 · vel 70%');
  });
});
