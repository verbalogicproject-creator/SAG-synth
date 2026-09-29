/**
 * src/tests/schedule.test.ts — what the transport pump plays, decided without a clock.
 */

import { describe, expect, it } from 'vitest';
import { eventsInWindow, swingDelay, windowStartBeats, type ScheduledEvent } from '../core/schedule';
import { defaultSong, defaultTrack } from '../core/state';
import type { NoteEvent, Song, SongTrack } from '../core/types';

function note(noteId: string, time: number, duration = 0.15, pitch = 'G1', velocity = 1): NoteEvent {
  return { noteId, time, duration, note: pitch, velocity };
}

function track(id: string, notes: NoteEvent[], extra: Partial<SongTrack> = {}): SongTrack {
  return { ...defaultTrack(), id, name: id, notes, ...extra };
}

function song(tracks: SongTrack[], extra: Partial<Song> = {}): Song {
  return {
    ...defaultSong(),
    tracks,
    loop: { enabled: false, start: 0, end: 4 },
    swing: 0,
    ...extra,
  };
}

const brief = (events: ScheduledEvent[]) => events.map((e) => `${e.kind}:${e.noteId}@${+e.offset.toFixed(6)}`);

describe('eventsInWindow', () => {
  it('reports ons and offs inside a half-open window, relative to its start', () => {
    const s = song([track('bass', [note('a', 0.25), note('b', 0.5)])]);
    expect(brief(eventsInWindow(s, 0.2, 0.3))).toEqual(['on:a@0.05', 'off:a@0.2']);
    // 0.5 is the window end, so b's on belongs to the next window, not this one.
    expect(brief(eventsInWindow(s, 0.5, 0.2))).toEqual(['on:b@0', 'off:b@0.15']);
  });

  it('orders an off before an on at the same instant, so a retrigger frees its voice first', () => {
    const s = song([track('bass', [note('a', 0, 0.25), note('b', 0.25, 0.25)])]);
    expect(brief(eventsInWindow(s, 0.2, 0.1))).toEqual(['off:a@0.05', 'on:b@0.05']);
  });

  it('breaks exact ties by trackId then noteId, never by array order', () => {
    const one = song([track('z', [note('n2', 0)]), track('a', [note('n1', 0)])]);
    const two = song([track('a', [note('n1', 0)]), track('z', [note('n2', 0)])]);
    expect(eventsInWindow(one, 0, 0.1)).toEqual(eventsInWindow(two, 0, 0.1));
    expect(eventsInWindow(one, 0, 0.1).map((e) => e.trackId)).toEqual(['a', 'z']);
  });

  it('wraps a window across the loop end and continues at the loop start', () => {
    const s = song([track('bass', [note('first', 0), note('last', 3.75, 0.2)])], {
      loop: { enabled: true, start: 0, end: 4 },
    });
    // [3.9, 4.0) then [0, 0.1): last's off at 3.95, then first's on at the wrap.
    expect(brief(eventsInWindow(s, 3.9, 0.2))).toEqual(['off:last@0.05', 'on:first@0.1']);
  });

  it('clips a note that crosses the loop end to the wrap, so it cannot stick', () => {
    const s = song([track('bass', [note('long', 3.5, 2)])], { loop: { enabled: true, start: 0, end: 4 } });
    const events = eventsInWindow(s, 3.5, 1);
    expect(brief(events)).toEqual(['on:long@0', 'off:long@0.5']);
  });

  it('jumps a position at or past the loop end straight to the loop start, as Tone does', () => {
    const s = song([track('bass', [note('a', 0)])], { loop: { enabled: true, start: 0, end: 4 } });
    expect(brief(eventsInWindow(s, 4, 0.1))).toEqual(['on:a@0']);
  });

  it('unrolls a window longer than the loop into several passes', () => {
    const s = song([track('bass', [note('a', 0, 0.1)])], { loop: { enabled: true, start: 0, end: 0.5 } });
    expect(brief(eventsInWindow(s, 0, 1)).filter((e) => e.startsWith('on'))).toEqual(['on:a@0', 'on:a@0.5']);
  });

  it('marks muted and non-solo tracks inaudible but still reports them, for the duck', () => {
    const s = song([
      track('kick', [note('k', 0)], { isDrum: true, muted: true }),
      track('bass', [note('b', 0.25)]),
    ]);
    const events = eventsInWindow(s, 0, 0.5);
    expect(events.find((e) => e.noteId === 'k')).toMatchObject({ audible: false, drum: true });
    expect(events.find((e) => e.noteId === 'b')).toMatchObject({ audible: true, drum: false });

    const soloed = song([track('kick', [note('k', 0)], { isDrum: true }), track('bass', [note('b', 0.25)], { solo: true })]);
    expect(eventsInWindow(soloed, 0, 0.5).find((e) => e.noteId === 'k')?.audible).toBe(false);
  });

  it('returns nothing for an empty or negative window', () => {
    const s = song([track('bass', [note('a', 0)])]);
    expect(eventsInWindow(s, 0, 0)).toEqual([]);
    expect(eventsInWindow(s, 0, -1)).toEqual([]);
  });
});

describe('swing', () => {
  it('never moves the downbeat or the pair boundary', () => {
    expect(swingDelay(0, 1, '8n')).toBe(0);
    expect(swingDelay(1, 1, '8n')).toBeCloseTo(0, 12);
    expect(swingDelay(0.5, 1, '16n')).toBeCloseTo(0, 12);
  });

  it('moves the off-beat by amount × pair / 3, Tone’s own formula', () => {
    expect(swingDelay(0.5, 1, '8n')).toBeCloseTo(1 / 3, 12);
    expect(swingDelay(0.25, 0.5, '16n')).toBeCloseTo(0.5 * (0.5 / 3), 12);
  });

  it('delays a note’s on and off by the same amount, so it moves rather than stretches', () => {
    const s = song([track('bass', [note('a', 0.25, 0.1)])], { swing: 1, swingSubdivision: '16n' });
    const [on, off] = eventsInWindow(s, 0, 1);
    expect(on!.offset).toBeCloseTo(0.25 + 0.5 / 3, 12);
    expect(off!.offset - on!.offset).toBeCloseTo(0.1, 12);
  });
});

describe('windowStartBeats — pump windows tile, whatever the tick reading says', () => {
  const PPQ = 192;
  const WINDOW = 24;

  it('snaps the drifted readings the device produced back onto the grid', () => {
    expect(windowStartBeats(23.999999999995453, WINDOW, PPQ)).toBe(0.125);
    expect(windowStartBeats(744.0000000000018, WINDOW, PPQ)).toBe(3.875);
    expect(windowStartBeats(0, WINDOW, PPQ)).toBe(0);
  });

  it('raw drifted starts double an event on the boundary; snapped starts schedule it exactly once', () => {
    // A kick on beat 1, and two consecutive windows whose readings drifted in opposite
    // directions — the device's case. Raw, the kick lands in both windows.
    const s = song([track('kick', [note('k', 1, 0.25)], { isDrum: true })]);
    const W = WINDOW / PPQ;
    const earlyEnd = 168.0000000001 / PPQ; // window N starts a hair late, so it ends a hair late
    const lateStart = 191.9999999999 / PPQ; // window N+1 starts a hair early
    const count = (from: number) => eventsInWindow(s, from, W).filter((e) => e.kind === 'on').length;

    expect(count(earlyEnd) + count(lateStart), 'the bug: scheduled twice').toBe(2);

    const snapped = [168.0000000001, 191.9999999999].map((ticks) => windowStartBeats(ticks, WINDOW, PPQ));
    expect(snapped.map(count).reduce((a, b) => a + b, 0), 'the fix: exactly once').toBe(1);
  });

  it('consecutive snapped windows tile a whole bar with no event lost or doubled', () => {
    const s = song([track('bass', [0, 0.25, 0.5, 1, 1.75, 3.875].map((t, i) => note(`n${i}`, t, 0.1)))]);
    const W = WINDOW / PPQ;
    let ons = 0;
    for (let w = 0; w < 32; w += 1) {
      // A reading that wobbles around the true grid position, like the device's.
      const drift = (w % 2 === 0 ? 1 : -1) * 1e-9;
      ons += eventsInWindow(s, windowStartBeats(w * WINDOW + drift, WINDOW, PPQ), W).filter((e) => e.kind === 'on').length;
    }
    expect(ons).toBe(6);
  });
});
