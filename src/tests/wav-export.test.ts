/**
 * src/tests/wav-export.test.ts — the WAV bytes and the unrolled song, without a clock.
 */

import { describe, expect, it } from 'vitest';
import { WAV_HEADER_BYTES, encodeWav, toInt16 } from '../core/wav';
import { EXPORT_MAX_RELEASE_SECONDS, EXPORT_TAIL_SECONDS, exportPlan } from '../core/export';
import { defaultSong, defaultTrack } from '../core/state';
import type { NoteEvent, Song } from '../core/types';

describe('encodeWav', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1]);
  const right = new Float32Array([0, -1, 2, Number.NaN]);
  const bytes = encodeWav([left, right], 44100);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));

  it('writes a standard 44-byte PCM header', () => {
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(28, true)).toBe(44100 * 2 * 2);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(4 * 2 * 2);
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect(bytes.length).toBe(WAV_HEADER_BYTES + 16);
  });

  it('interleaves left and right, frame by frame', () => {
    const sample = (frame: number, channel: number) => view.getInt16(WAV_HEADER_BYTES + (frame * 2 + channel) * 2, true);
    expect([sample(1, 0), sample(1, 1)]).toEqual([toInt16(0.5), -32768]);
    expect([sample(3, 0), sample(3, 1)]).toEqual([32767, 0]);
  });

  it('clamps past full scale instead of wrapping into a click, and silences NaN', () => {
    expect(toInt16(2)).toBe(32767);
    expect(toInt16(-7)).toBe(-32768);
    expect(toInt16(Number.NaN)).toBe(0);
    expect(toInt16(0)).toBe(0);
    expect(toInt16(-0)).toBe(0);
  });
});

const note = (noteId: string, time: number, duration: number): NoteEvent => ({ noteId, time, duration, note: 'G1', velocity: 1 });

function looped(notes: NoteEvent[], loop = { enabled: true, start: 0, end: 4 }): Song {
  return { ...defaultSong(), bpm: 120, tracks: [{ ...defaultTrack(), id: 'bass', name: 'bass', notes }], loop };
}

describe('exportPlan — the loop unrolled', () => {
  it('writes the loop out N times end to end, with unique ids and no loop left', () => {
    const plan = exportPlan(looped([note('a', 0, 0.5), note('b', 2, 0.5)]), 3, 0);
    const notes = plan.song.tracks[0]!.notes;
    expect(notes.map((n) => n.time)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(new Set(notes.map((n) => n.noteId)).size).toBe(6);
    expect(plan.song.loop.enabled).toBe(false);
    expect(plan.beats).toBe(12);
    expect(plan.musicSeconds).toBeCloseTo(6, 9);
  });

  it('starts at the loop start, cuts a note that crosses the loop end, and drops notes outside', () => {
    const plan = exportPlan(
      looped([note('before', 0, 1), note('in', 2, 1), note('crosses', 5, 3), note('after', 9, 1)], { enabled: true, start: 2, end: 6 }),
      2,
      0,
    );
    const notes = plan.song.tracks[0]!.notes;
    expect(notes.map((n) => [n.time, n.duration])).toEqual([[0, 1], [3, 1], [4, 1], [7, 1]]);
  });

  it('with the loop off, renders the song once up to its last note', () => {
    const plan = exportPlan(looped([note('a', 0, 1), note('b', 9, 2)], { enabled: false, start: 0, end: 4 }), 8, 0);
    expect(plan.beats).toBe(11);
    expect(plan.song.tracks[0]!.notes).toHaveLength(2);
  });

  it('an empty song still renders a bar of silence', () => {
    expect(exportPlan(looped([], { enabled: false, start: 0, end: 4 }), 1, 0).beats).toBe(4);
  });

  it('lets the release ring out, capped so a long pad does not bloat the file', () => {
    expect(exportPlan(looped([note('a', 0, 1)]), 1, 0.5).renderSeconds).toBeCloseTo(2 + EXPORT_TAIL_SECONDS + 0.5, 9);
    expect(exportPlan(looped([note('a', 0, 1)]), 1, 30).renderSeconds).toBeCloseTo(
      2 + EXPORT_TAIL_SECONDS + EXPORT_MAX_RELEASE_SECONDS,
      9,
    );
  });

  it('caps the length at five minutes of music', () => {
    const plan = exportPlan(looped([note('a', 0, 1)]), 10_000, 0);
    expect(plan.musicSeconds).toBeLessThanOrEqual(300);
    expect(plan.musicSeconds).toBeGreaterThan(290);
  });
});
