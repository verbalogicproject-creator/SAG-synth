/**
 * src/tests/mixer-cost.audio.test.ts — what a phone can afford, measured before it is promised.
 *
 * Phase 5 asks for FL Studio's model: tracks with their own ordered effect chains. Every
 * cap in that contract becomes part of the address space, so "how many chains" is a
 * contract decision — and a contract written first and found unplayable second is the
 * expensive order. `design/PHASE-5-BRIEF.md` says this probe comes before 5.0. This is it.
 *
 * **What is being measured, and what is not.** `Tone.Offline` renders as fast as it can,
 * so this is not a realtime CPU reading. It is the ratio of wall time to audio time for
 * the identical node graph the runtime builds, which makes it a sound RELATIVE measure:
 * a chain that costs twice another here costs about twice in a live context too, and a
 * configuration whose ratio approaches 1.0 offline has no chance of holding up live,
 * where it must also share a thread with the UI and leave headroom for scheduling.
 *
 * That it runs under PRoot on the target phone rather than on a workstation is the point.
 * The numbers are from the class of hardware this instrument is built for.
 *
 * Recorded rather than asserted tightly: the assertion below is a floor that catches a
 * catastrophic regression, not a benchmark to defend. Machine-dependent numbers make
 * brittle gates, and a gate that fails for the wrong reason gets disabled.
 */

import * as Tone from 'tone';
import { describe, expect, it } from 'vitest';
import { EQ_BAND_FREQUENCIES } from '../core/types';

const SR = 44100;
/** Long enough that construction cost does not dominate the reading. */
const SECONDS = 2;
const EQ_BAND_Q = 1.3;

/** One full chain, node-for-node what `ToneRuntime` builds today. */
function buildChain(input: Tone.ToneAudioNode, destination: Tone.InputNode): void {
  const distortion = new Tone.WaveShaper(makeCurve());
  const chorus = new Tone.Chorus({ frequency: 4, delayTime: 2.5, depth: 0.5, wet: 0.5 }).start();
  const delay = new Tone.FeedbackDelay({ delayTime: 0.25, feedback: 0.3, wet: 0.5 });
  const reverb = new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.5 });
  const bands = EQ_BAND_FREQUENCIES.map(
    (frequency) => new Tone.Filter({ type: 'peaking', frequency, Q: EQ_BAND_Q, gain: 3 }),
  );

  input.chain(distortion, chorus, delay, reverb, ...bands, destination as Tone.ToneAudioNode);
}

function makeCurve(): Float32Array {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i += 1) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 3);
  }
  return curve;
}

/** Wall-clock milliseconds to render `SECONDS` of audio through `build`. */
/**
 * Wall-clock cost of rendering `build`, as the FASTEST of three runs.
 *
 * The minimum, not the mean, and that is the fix for a real failure rather than a
 * refinement. This is a wall-clock measurement taken inside a suite vitest runs in
 * parallel across projects, on a phone. A single timing therefore measures the machine's
 * mood as much as the graph: the same "1 full chain" that reads 0.29x alone read 0.59x
 * inside the full suite and 0.84x with a background agent also running. The assertion
 * below went red on the second of those, and the diagnosis "the code got slower" was
 * wrong — nothing in this file touches `ToneRuntime` at all.
 *
 * Contention can only ever make a timing LONGER, so the minimum of several is the closest
 * available estimate of the uncontended cost, and it is the standard answer for exactly
 * this reason. A gate that fails for the wrong reason is a gate that gets disabled.
 */
async function cost(build: (destination: Tone.InputNode) => void): Promise<number> {
  const RUNS = 3;
  let best = Infinity;
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    await Tone.Offline(
      ({ destination }) => {
        build(destination);
      },
      SECONDS,
      2,
      SR,
    );
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

function source(): Tone.Oscillator {
  return new Tone.Oscillator({ type: 'sawtooth', frequency: 110 }).start();
}

describe('what N effect chains cost on this device', () => {
  it('measures the shapes Phase 5 has to choose between', async () => {
    const readings: { name: string; ms: number }[] = [];

    // Bare source: everything below is measured against this, so the oscillator's own
    // cost is not attributed to the effects.
    readings.push({ name: 'dry (no effects)', ms: await cost((destination) => {
      source().connect(destination);
    }) });

    // Each effect alone, because "which one is expensive" decides whether a slot model
    // helps at all. If reverb dominates, a track WITHOUT a reverb slot is nearly free and
    // the slot model wins; if the cost is flat, the cap is the only lever.
    const singles: [string, (input: Tone.Oscillator, destination: Tone.InputNode) => void][] = [
      ['distortion only', (input, destination) => {
        input.chain(new Tone.WaveShaper(makeCurve()), destination as Tone.ToneAudioNode);
      }],
      ['chorus only', (input, destination) => {
        input.chain(new Tone.Chorus({ frequency: 4, delayTime: 2.5, depth: 0.5, wet: 0.5 }).start(), destination as Tone.ToneAudioNode);
      }],
      ['delay only', (input, destination) => {
        input.chain(new Tone.FeedbackDelay({ delayTime: 0.25, feedback: 0.3, wet: 0.5 }), destination as Tone.ToneAudioNode);
      }],
      ['freeverb only', (input, destination) => {
        input.chain(new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.5 }), destination as Tone.ToneAudioNode);
      }],
      ['eq only (5 bands)', (input, destination) => {
        const bands = EQ_BAND_FREQUENCIES.map(
          (frequency) => new Tone.Filter({ type: 'peaking', frequency, Q: EQ_BAND_Q, gain: 3 }),
        );
        input.chain(...bands, destination as Tone.ToneAudioNode);
      }],
    ];

    for (const [name, build] of singles) {
      readings.push({ name, ms: await cost((destination) => build(source(), destination)) });
    }

    // Then the question the contract actually turns on: how does a full chain scale.
    for (const chains of [1, 2, 3, 4, 6, 8]) {
      readings.push({
        name: `${chains} full chain${chains === 1 ? '' : 's'}`,
        ms: await cost((destination) => {
          for (let i = 0; i < chains; i += 1) buildChain(source(), destination);
        }),
      });
    }

    const audioMs = SECONDS * 1000;
    const table = readings.map(
      (reading) =>
        `${reading.name.padEnd(20)} ${reading.ms.toFixed(0).padStart(6)} ms   ` +
        `${(reading.ms / audioMs).toFixed(3)}x realtime`,
    );

    // The numbers are the deliverable, and the default reporter hides stdout for a
    // PASSING test — which is every run of this one. Read them with:
    //   npx vitest run --project audio src/tests/mixer-cost.audio.test.ts --reporter=verbose
    // eslint-disable-next-line no-console
    console.log(`\n${table.join('\n')}\n`);

    // The floor. Not a benchmark: one full chain must render comfortably faster than
    // realtime, or nothing in Phase 5 is affordable and the caps question is moot.
    const oneChain = readings.find((reading) => reading.name === '1 full chain')!;
    expect(oneChain.ms / audioMs).toBeLessThan(0.5);
  }, 300_000);
});
