/**
 * src/tests/psy-pattern.test.ts — the rolling bass, checked against Eyal's reference roll
 * (bass on G1, three 16ths per beat, the first softer, the kick on every beat).
 */

import { describe, expect, it } from 'vitest';
import { psyPattern } from '../core/patterns/psy';
import { NoteEventSchema } from '../core/schemas';

describe('psyPattern', () => {
  it('rolls: twelve bass notes a bar on 16ths 2, 3, 4 of each beat, the kick on every beat', () => {
    const { bass, kick, length } = psyPattern({ idPrefix: 'p' });
    expect(length).toBe(4);
    expect(kick.map((n) => n.time)).toEqual([0, 1, 2, 3]);
    expect(bass).toHaveLength(12);
    expect(bass.map((n) => n.time)).toEqual([0.25, 0.5, 0.75, 1.25, 1.5, 1.75, 2.25, 2.5, 2.75, 3.25, 3.5, 3.75]);
    expect(new Set(bass.map((n) => n.note))).toEqual(new Set(['G1']));
  });

  it('makes the first bass note after each kick ~30% softer', () => {
    const { bass } = psyPattern({ idPrefix: 'p' });
    expect(bass.map((n) => n.velocity)).toEqual([0.7, 1, 1, 0.7, 1, 1, 0.7, 1, 1, 0.7, 1, 1]);
  });

  it('gallops: K . B B', () => {
    const { bass } = psyPattern({ idPrefix: 'p', style: 'gallop' });
    expect(bass.map((n) => n.time)).toEqual([0.5, 0.75, 1.5, 1.75, 2.5, 2.75, 3.5, 3.75]);
    expect(bass[0]!.velocity).toBe(0.7);
  });

  it('keeps every note shorter than a 16th, so each is silent before the next', () => {
    for (const gate of [0.5, 0.6, 0.75]) {
      for (const n of psyPattern({ idPrefix: 'p', gate }).bass) expect(n.duration).toBeLessThan(0.25);
    }
  });

  it('nudges the first note late without moving its end', () => {
    const plain = psyPattern({ idPrefix: 'p' }).bass[0]!;
    const nudged = psyPattern({ idPrefix: 'p', firstNudge: 0.024 }).bass[0]!;
    expect(nudged.time).toBeCloseTo(plain.time + 0.024, 12);
    expect(nudged.time + nudged.duration).toBeCloseTo(plain.time + plain.duration, 12);
  });

  it('clamps an absurd nudge so no note gets a non-positive length', () => {
    for (const n of psyPattern({ idPrefix: 'p', gate: 0.05, firstNudge: 10 }).bass) {
      expect(n.duration).toBeGreaterThan(0);
    }
  });

  it('mints deterministic, unique ids from the caller’s prefix, and every note validates', () => {
    const a = psyPattern({ idPrefix: 'x', bars: 4 });
    const b = psyPattern({ idPrefix: 'x', bars: 4 });
    expect(a).toEqual(b);
    const ids = [...a.bass, ...a.kick].map((n) => n.noteId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of [...a.bass, ...a.kick]) expect(NoteEventSchema.safeParse(n).success).toBe(true);
  });
});
