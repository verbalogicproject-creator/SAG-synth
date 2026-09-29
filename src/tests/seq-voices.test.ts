/**
 * src/tests/seq-voices.test.ts — LP1, answered as a runner test.
 *
 * ROADMAP.md has held LP1 open since 0.1.17: "Tone.Transport schedules ahead of the audio
 * clock while our allocator expects to decide at dispatch time. Nobody has measured the
 * lookahead window against a pure allocator."
 *
 * The lookahead is not a thing the offline harness can measure (it runs at lookAhead 0),
 * and it turns out not to need measuring for correctness: what has to hold is that the
 * WINDOW SIZE never changes a verdict. Online, the window is set by `context.lookAhead` and
 * `updateInterval` and varies by device; here every plausible size is tried and the
 * verdicts must be byte-identical. The number itself is reported by device telemetry.
 */

import { describe, expect, it } from 'vitest';
import { eventsInWindow } from '../core/schedule';
import { emptySeqPool, seqStep, type SeqAction, type SeqPool } from '../core/seq-voices';
import { psyPattern } from '../core/patterns/psy';
import { defaultSong, defaultTrack } from '../core/state';
import type { NoteEvent, Song } from '../core/types';

const BPM = 145;
const VOICE = { polyphony: 2, stealPolicy: 'oldest' as const };

function psySong(extraBass: NoteEvent[] = []): Song {
  const { bass, kick, length } = psyPattern({ idPrefix: 'p', bars: 2 });
  return {
    ...defaultSong(),
    bpm: BPM,
    swing: 0,
    loop: { enabled: true, start: 0, end: length },
    tracks: [
      { ...defaultTrack(), id: 'bass', notes: [...bass, ...extraBass] },
      { ...defaultTrack(), id: 'kick', isDrum: true, notes: kick },
    ],
  };
}

interface Verdict {
  beat: number;
  noteId: string;
  action: SeqAction;
}

/**
 * Drive the pool across `totalBeats` of song in windows of `window` beats — exactly what the
 * runtime pump does, one callback per window — and record every verdict with the absolute
 * beat it applies to.
 */
/** Where the Transport's position is after `elapsed` beats of play: it wraps at the loop end. */
function positionAt(song: Song, elapsed: number): number {
  const { loop } = song;
  if (!loop.enabled || elapsed < loop.end) return elapsed;
  const span = loop.end - loop.start;
  return loop.start + ((elapsed - loop.start) % span);
}

function run(song: Song, window: number, totalBeats: number): { verdicts: Verdict[]; steals: number } {
  let pool: SeqPool = emptySeqPool();
  const verdicts: Verdict[] = [];
  let steals = 0;
  for (let start = 0; start < totalBeats - 1e-9; start += window) {
    const length = Math.min(window, totalBeats - start);
    // The pump is handed the Transport's position, which Tone has already wrapped.
    for (const event of eventsInWindow(song, positionAt(song, start), length)) {
      if (event.drum || !event.audible) continue;
      const step = seqStep(pool, event, VOICE);
      pool = step.pool;
      if (step.action === null) continue;
      if (step.action.kind === 'on' && step.action.stolen !== undefined) steals += 1;
      verdicts.push({ beat: +(start + event.offset).toFixed(9), noteId: event.noteId, action: step.action });
    }
  }
  return { verdicts, steals };
}

describe('LP1 — schedule-time allocation is independent of the lookahead window', () => {
  // 1 ms to half a bar, at 145 BPM. Tone's defaults (lookAhead 0.1 s, updateInterval 0.05 s)
  // sit inside this range; so does anything a slow phone would be tuned to.
  const secondsPerBeat = 60 / BPM;
  const windows = [0.001, 0.025, 0.05, 0.1, 0.2, 0.5, 1].map((seconds) => seconds / secondsPerBeat).concat([2]);

  it('gives identical verdicts for every window size, across four passes of a two-bar loop', () => {
    const song = psySong();
    const reference = run(song, windows[0]!, 32);
    expect(reference.verdicts.length).toBeGreaterThan(0);
    for (const window of windows.slice(1)) {
      expect(run(song, window, 32).verdicts, `window ${window.toFixed(4)} beats`).toEqual(reference.verdicts);
    }
  });

  it('steals nothing across the psy pattern at polyphony 2', () => {
    for (const window of windows) expect(run(psySong(), window, 32).steals).toBe(0);
  });

  it('reuses one voice for the rolling bass: every off frees it before the next on', () => {
    const { verdicts } = run(psySong(), 0.1, 8);
    const ons = verdicts.filter((v) => v.action.kind === 'on');
    expect(new Set(ons.map((v) => v.action.voiceId))).toEqual(new Set([0]));
    expect(ons).toHaveLength(24);
  });

  it('still decides identically when notes overlap and the pool must steal', () => {
    // A held pad-length note across the bar forces the roll onto the second voice, and a
    // third overlapping note forces a steal. The verdicts must still not depend on window.
    const extra: NoteEvent[] = [
      { noteId: 'held', time: 0, duration: 8, note: 'D2', velocity: 1 },
      { noteId: 'clash', time: 1.3, duration: 1, note: 'A2', velocity: 1 },
    ];
    const song = psySong(extra);
    const reference = run(song, windows[0]!, 16);
    expect(reference.steals).toBeGreaterThan(0);
    for (const window of windows.slice(1)) {
      expect(run(song, window, 16).verdicts).toEqual(reference.verdicts);
    }
  });
});

describe('seqStep', () => {
  it('an off for a note that lost its voice is a no-op, not a release of someone else', () => {
    let pool = emptySeqPool();
    const on = (noteId: string, note: string) =>
      ({ offset: 0, kind: 'on', trackId: 't', noteId, note, velocity: 1, drum: false, audible: true }) as const;
    const off = (noteId: string, note: string) => ({ ...on(noteId, note), kind: 'off' as const });

    pool = seqStep(pool, on('a', 'C2'), { polyphony: 1, stealPolicy: 'oldest' }).pool;
    const stolen = seqStep(pool, on('b', 'E2'), { polyphony: 1, stealPolicy: 'oldest' });
    expect(stolen.action).toEqual({ kind: 'on', voiceId: 0, stolen: 0 });
    pool = stolen.pool;

    expect(seqStep(pool, off('a', 'C2'), { polyphony: 1, stealPolicy: 'oldest' }).action).toBeNull();
    expect(seqStep(pool, off('b', 'E2'), { polyphony: 1, stealPolicy: 'oldest' }).action).toEqual({
      kind: 'off',
      voiceId: 0,
    });
  });
});
