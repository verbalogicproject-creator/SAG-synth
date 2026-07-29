import { describe, it, expect } from 'vitest';
import {
  rms,
  peak,
  maxDiscontinuity,
  onsets,
  hfEnergyRatio,
  estimatePitch,
} from './audio-assertions';

// Every runtime gate is only as trustworthy as these helpers, so verify them
// against synthetic signals with known-correct answers before relying on them.

const SR = 44100;

function sine(freq: number, seconds: number, amp = 1, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

describe('audio assertion helpers', () => {
  it('rms of a sine is amplitude / sqrt(2)', () => {
    const s = sine(440, 1, 0.8);
    expect(rms(s)).toBeCloseTo(0.8 / Math.SQRT2, 3);
  });

  it('peak finds the true maximum amplitude', () => {
    expect(peak(sine(440, 1, 0.63))).toBeCloseTo(0.63, 2);
  });

  it('rms honours the window bounds', () => {
    const s = new Float32Array(1000);
    s.fill(0, 0, 500);
    s.fill(1, 500, 1000);
    expect(rms(s, 0, 500)).toBeCloseTo(0, 6);
    expect(rms(s, 500, 1000)).toBeCloseTo(1, 6);
  });

  it('maxDiscontinuity catches an injected click', () => {
    const clean = sine(220, 0.1, 0.5);
    const clicked = Float32Array.from(clean);
    clicked[1000] = 0.9;
    clicked[1001] = -0.9;
    expect(maxDiscontinuity(clean)).toBeLessThan(0.1);
    expect(maxDiscontinuity(clicked)).toBeGreaterThan(1.0);
  });

  it('onsets finds gated bursts at the expected times', () => {
    const buf = new Float32Array(SR); // 1 second of silence
    const burst = sine(440, 0.05, 0.8);
    buf.set(burst, 0); //         t = 0.00s
    buf.set(burst, SR * 0.5); //  t = 0.50s
    const found = onsets(buf, SR);
    expect(found.length).toBe(2);
    expect(found[0]).toBeCloseTo(0.0, 2);
    expect(found[1]).toBeCloseTo(0.5, 2);
  });

  it('hfEnergyRatio separates a low tone from a high tone', () => {
    const low = hfEnergyRatio(sine(200, 0.5, 0.8), SR, 5000);
    const high = hfEnergyRatio(sine(9000, 0.5, 0.8), SR, 5000);
    expect(low).toBeLessThan(0.01);
    expect(high).toBeGreaterThan(0.9);
  });

  it('estimatePitch recovers the fundamental of a sine', () => {
    expect(estimatePitch(sine(440, 1, 0.8), SR, 0.2)).toBeCloseTo(440, -1);
    expect(estimatePitch(sine(880, 1, 0.8), SR, 0.2)).toBeCloseTo(880, -1);
  });
});
