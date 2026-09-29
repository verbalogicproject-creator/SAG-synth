/**
 * src/tests/ahdsr.audio.test.ts — the AHDSR envelope, rendered.
 *
 * Each render drives an envelope with a constant 1 (a DC signal), so the rendered buffer IS
 * the envelope: no oscillator to demodulate, no filter in the way.
 *
 * The first gate is the one schema_version 5 rests on. The migration claims a v4 patch
 * (plain ADSR) becomes a v5 patch with `hold: 0, decayCurve: 'exponential'` and sounds the
 * SAME. That is only true if the AHDSR subclass at those settings issues exactly what stock
 * `Tone.AmplitudeEnvelope` issues — so the two are rendered side by side and compared
 * sample for sample.
 */

import { describe, expect, it } from 'vitest';
import * as Tone from 'tone';
import { AhdsrAmplitudeEnvelope, AhdsrFrequencyEnvelope } from '../runtime/ahdsr-envelope';
import type { DecayCurve } from '../core/types';

const SR = 44100;

interface Shape {
  attack: number;
  hold: number;
  decay: number;
  decayCurve: DecayCurve;
  sustain: number;
  release: number;
}

/** Render an envelope driven by DC. `releaseAt` triggers the release; `retriggerAt` a second attack. */
async function renderEnvelope(
  make: () => Tone.AmplitudeEnvelope,
  seconds: number,
  events: { releaseAt?: number; retriggerAt?: number } = {},
): Promise<Float32Array> {
  const buffer = await Tone.Offline(
    () => {
      const env = make().toDestination();
      const dc = new Tone.Signal(1).connect(env);
      void dc;
      env.triggerAttack(0);
      if (events.retriggerAt !== undefined) env.triggerAttack(events.retriggerAt);
      if (events.releaseAt !== undefined) env.triggerRelease(events.releaseAt);
    },
    seconds,
    1,
    SR,
  );
  return buffer.getChannelData(0);
}

function ahdsr(shape: Shape): () => Tone.AmplitudeEnvelope {
  return () =>
    new AhdsrAmplitudeEnvelope({
      attack: shape.attack,
      decay: shape.decay,
      sustain: shape.sustain,
      release: shape.release,
    }).setAhdsr(shape);
}

const at = (seconds: number) => Math.round(seconds * SR);

function maxDiff(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  return worst;
}

describe('schema_version 5 migration is inaudible', () => {
  const cases: Array<[string, Omit<Shape, 'hold' | 'decayCurve'>]> = [
    ['the factory patch', { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.8 }],
    ['a percussive patch', { attack: 0.002, decay: 0.07, sustain: 0, release: 0.03 }],
    ['an instant attack', { attack: 0, decay: 0.05, sustain: 0.5, release: 0.1 }],
  ];

  for (const [name, adsr] of cases) {
    it(`hold 0 + exponential renders sample-identical to stock Tone: ${name}`, async () => {
      const events = { releaseAt: 0.3 };
      const [stock, migrated] = await Promise.all([
        renderEnvelope(() => new Tone.AmplitudeEnvelope({ ...adsr }), 0.5, events),
        renderEnvelope(ahdsr({ ...adsr, hold: 0, decayCurve: 'exponential' }), 0.5, events),
      ]);
      expect(maxDiff(stock, migrated)).toBeLessThan(1e-6);
    });
  }

  it('and on a retrigger, where Tone shortens the attack', async () => {
    const adsr = { attack: 0.05, decay: 0.1, sustain: 0.5, release: 0.2 };
    const events = { retriggerAt: 0.2, releaseAt: 0.35 };
    const [stock, migrated] = await Promise.all([
      renderEnvelope(() => new Tone.AmplitudeEnvelope({ ...adsr }), 0.6, events),
      renderEnvelope(ahdsr({ ...adsr, hold: 0, decayCurve: 'exponential' }), 0.6, events),
    ]);
    expect(maxDiff(stock, migrated)).toBeLessThan(1e-6);
  });

  it('the frequency envelope too — the filter pluck is unchanged', async () => {
    const options = { attack: 0.01, decay: 0.1, sustain: 0.2, release: 0.1, baseFrequency: 1, octaves: 3, exponent: 2 };
    const render = (make: () => Tone.FrequencyEnvelope) =>
      Tone.Offline(
        () => {
          const env = make();
          env.connect(Tone.getDestination());
          env.triggerAttack(0);
          env.triggerRelease(0.25);
        },
        0.4,
        1,
        SR,
      ).then((buffer) => buffer.getChannelData(0));
    const [stock, migrated] = await Promise.all([
      render(() => new Tone.FrequencyEnvelope(options)),
      render(() => new AhdsrFrequencyEnvelope(options).setAhdsr({ ...options, hold: 0, decayCurve: 'exponential' })),
    ]);
    expect(maxDiff(stock, migrated)).toBeLessThan(1e-6);
  });
});

describe('the hold stage', () => {
  it('stays at the peak for exactly the hold, then decays', async () => {
    // Eyal's recipe: attack 0 (the click), 50 ms of hold, then the fall.
    const data = await renderEnvelope(
      ahdsr({ attack: 0, hold: 0.05, decay: 0.1, decayCurve: 'exponential', sustain: 0, release: 0.05 }),
      0.3,
    );
    // The click: full level from the first sample on.
    expect(data[at(0.001)]!).toBeCloseTo(1, 3);
    // The plateau, all the way through the hold.
    for (const t of [0.01, 0.025, 0.045]) expect(data[at(t)]!, `at ${t}s`).toBeCloseTo(1, 3);
    // Then it falls, and is gone by hold + decay.
    expect(data[at(0.07)]!).toBeLessThan(0.5);
    expect(data[at(0.16)]!).toBeLessThan(0.001);
  });

  it('a release during the hold releases from the peak, not after the hold', async () => {
    const data = await renderEnvelope(
      ahdsr({ attack: 0, hold: 0.2, decay: 0.1, decayCurve: 'linear', sustain: 0.5, release: 0.02 }),
      0.3,
      { releaseAt: 0.05 },
    );
    expect(data[at(0.04)]!).toBeCloseTo(1, 3);
    expect(data[at(0.1)]!).toBeLessThan(0.01);
  });
});

describe('the decay shapes', () => {
  async function midDecay(decayCurve: DecayCurve): Promise<number> {
    const data = await renderEnvelope(
      ahdsr({ attack: 0, hold: 0, decay: 0.2, decayCurve, sustain: 0, release: 0.05 }),
      0.3,
    );
    return data[at(0.1)]!;
  }

  it('at the middle of the decay: logarithmic holds up, exponential has mostly fallen, linear is between', async () => {
    const [linear, exponential, logarithmic] = await Promise.all([
      midDecay('linear'),
      midDecay('exponential'),
      midDecay('logarithmic'),
    ]);
    expect(linear).toBeCloseTo(0.5, 2);
    expect(exponential).toBeLessThan(linear);
    expect(logarithmic).toBeGreaterThan(linear);
  });

  it('every shape arrives at sustain by the end of the decay', async () => {
    for (const decayCurve of ['linear', 'exponential', 'logarithmic'] as const) {
      const data = await renderEnvelope(
        ahdsr({ attack: 0, hold: 0.02, decay: 0.1, decayCurve, sustain: 0.3, release: 0.05 }),
        0.3,
      );
      expect(data[at(0.2)]!, decayCurve).toBeCloseTo(0.3, 3);
    }
  });
});
