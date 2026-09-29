/**
 * src/tests/duck.test.ts — the note-triggered duck's curve, in numbers from the genre.
 */

import { describe, expect, it } from 'vitest';
import { dbToGain, duckPoints, gainAt } from '../core/duck';

const PSY = { depthDb: 3, attackMs: 1, releaseMs: 60 };
const SIXTEENTH_AT_145 = 60 / 145 / 4; // 0.1034 s

describe('duckPoints', () => {
  it('dips to −depth dB after the attack and is back at unity after the release', () => {
    const points = duckPoints([1], PSY);
    expect(gainAt(points, 1)).toBeCloseTo(1, 9);
    expect(gainAt(points, 1.001)).toBeCloseTo(dbToGain(-3), 9);
    expect(gainAt(points, 1.061)).toBeCloseTo(1, 9);
  });

  it('is back at 0 dB before the first bass 16th at 145 BPM — the genre’s requirement', () => {
    const points = duckPoints([0], PSY);
    expect(gainAt(points, SIXTEENTH_AT_145)).toBe(1);
  });

  it('never steps when a hit lands mid-recovery, and never dips deeper than depth', () => {
    const points = duckPoints([0, 0.03], PSY);
    const before = gainAt(points, 0.03 - 1e-9);
    const at = gainAt(points, 0.03);
    expect(Math.abs(at - before)).toBeLessThan(1e-6);
    let lowest = 1;
    for (let t = 0; t < 0.2; t += 0.0005) lowest = Math.min(lowest, gainAt(points, t));
    expect(lowest).toBeGreaterThanOrEqual(dbToGain(-3) - 1e-12);
  });

  it('never steps when a hit lands mid-attack', () => {
    const points = duckPoints([0, 0.0005], { depthDb: 6, attackMs: 2, releaseMs: 60 });
    expect(Math.abs(gainAt(points, 0.0005) - gainAt(points, 0.0005 - 1e-9))).toBeLessThan(1e-6);
  });

  it('continues a curve from where an earlier window left it', () => {
    const points = duckPoints([0], PSY, 0.8);
    expect(points[0]).toEqual({ time: 0, gain: 0.8, kind: 'set' });
  });

  it('is flat at depth 0', () => {
    const points = duckPoints([0], { ...PSY, depthDb: 0 });
    for (const point of points) expect(point.gain).toBe(1);
  });
});
