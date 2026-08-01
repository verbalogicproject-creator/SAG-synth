/**
 * src/tests/param-change.audio.test.ts — turning a knob while a note sounds must not click.
 *
 * Reported from the device, and it is the last purely audible defect in the instrument: hold
 * a note, move a control, hear a crack. Every parameter the runtime pushes is written as
 * `param.value = x`, which is an instantaneous step in the signal — a discontinuity, which is
 * broadband click. There is exactly one ramp in `tone-runtime.ts` and it is portamento.
 *
 * **The material is chosen so the measurement means something.** A sine at C3 has a
 * sample-to-sample delta of about `2π · 130 / 44100 ≈ 0.019` of its amplitude, so a step of a
 * few tenths stands an order of magnitude above it. A sawtooth would not work: its own
 * band-limited flyback is a large delta every cycle and would swamp the thing being measured.
 * The filter is opened and flattened (`octaves: 0`) for the same reason — a moving filter
 * envelope is a moving target under the probe.
 *
 * Each gate compares a window *across the change* against a quiet stretch of **the same
 * render**, rather than against an absolute number. An absolute threshold would encode the
 * sample rate and the note, and would need re-tuning every time either moved.
 *
 * **What this cannot see.** Nothing here says anything about graph churn — `rewireRoutes`
 * disposing and rebuilding scalers, or a filter reconstructing its biquads. An offline render
 * completes its clock pass before the first sample, so those collapse onto time zero. See
 * `src/test-harness/offline-render.ts`, whose own test asserts that blindness. Churn is
 * gated by counting calls, not by listening.
 */

import { describe, expect, it } from 'vitest';
import { maxDiscontinuity, rms } from '../test-harness/audio-assertions';
import { renderTimeline } from '../test-harness/offline-render';
import { defaultPreset } from '../core/state';
import type { SynthPreset } from '../core/types';
import { ToneRuntime } from '../runtime/tone-runtime';

const SR = 44100;
/** When the change happens. Far enough in that the attack is long over. */
const CHANGE_AT = 0.5;

/**
 * A sustained sine with a flat, wide-open filter — a steady tone with no envelope movement
 * left in it by the time the change lands.
 */
function steadyTone(): SynthPreset {
  const base = defaultPreset();
  const slot = base.voice.oscillators[0]!;
  return {
    ...base,
    voice: {
      ...base.voice,
      amplitude: 1,
      pan: 0,
      oscillators: [{ ...slot, type: 'sine', count: 1, detune: 0, spread: 0, level: 1, pan: 0 }],
      envelope: { attack: 0.01, decay: 0.01, sustain: 1, release: 0.5 },
      filterEnvelope: {
        ...base.voice.filterEnvelope,
        attack: 0.001,
        decay: 0.001,
        sustain: 1,
        baseFrequency: 12000,
        octaves: 0,
      },
    },
  };
}

/** Hold a note, apply `after` at 0.5 s, and report the jump across the change. */
async function jumpAcrossChange(after: SynthPreset): Promise<{ quiet: number; across: number }> {
  const before = steadyTone();
  const { data, at } = await renderTimeline(
    (schedule) => {
      const runtime = new ToneRuntime();
      runtime.applyPatch(before);
      runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 0.9, portamento: 0 });
      schedule(CHANGE_AT, () => runtime.applyPatch(after));
    },
    { seconds: 1, sampleRate: SR },
  );

  // Guard: a silent render would make every discontinuity zero and pass everything.
  expect(rms(data, at(0.2), at(0.45)), 'the probe tone never sounded').toBeGreaterThan(0.05);

  return {
    quiet: maxDiscontinuity(data, at(0.2), at(0.45)),
    across: maxDiscontinuity(data, at(CHANGE_AT - 0.01), at(CHANGE_AT + 0.02)),
  };
}

describe('changing a parameter while a note sounds', () => {
  it('does not click when the amplitude moves', async () => {
    const after = steadyTone();
    const { quiet, across } = await jumpAcrossChange({
      ...after,
      voice: { ...after.voice, amplitude: 0.35 },
    });

    expect(across, `jump across the change (${across}) vs quiet (${quiet})`).toBeLessThan(quiet * 3);
  });

  it('does not click when the pan moves', async () => {
    const after = steadyTone();
    const { quiet, across } = await jumpAcrossChange({
      ...after,
      voice: { ...after.voice, pan: -0.9 },
    });

    expect(across, `jump across the change (${across}) vs quiet (${quiet})`).toBeLessThan(quiet * 3);
  });

  it('does not click when the oscillator level moves', async () => {
    const after = steadyTone();
    const slot = after.voice.oscillators[0]!;
    const { quiet, across } = await jumpAcrossChange({
      ...after,
      voice: { ...after.voice, oscillators: [{ ...slot, level: 0.25 }] },
    });

    expect(across, `jump across the change (${across}) vs quiet (${quiet})`).toBeLessThan(quiet * 3);
  });

  it('survives a DRAG across 0 dB on an EQ band, which an exponential ramp does not', async () => {
    // The `convert: false` trap, and the shape of this test is the whole lesson.
    //
    // `Tone.Filter.gain` is built `units: 'decibels', convert: false`, so `Param.rampTo`
    // picks an EXPONENTIAL ramp and runs it over raw signed decibels. Exponential
    // interpolation is `v0 · (v1/v0)^t`; from −12 dB to +12 dB the ratio is −1 and a
    // fractional power of a negative number is NaN. Measured, not reasoned:
    //
    //     t=0.100  expo=-12   lin=-12
    //     t=0.105  expo=NaN   lin=-6
    //     t=0.110  expo=NaN   lin=~0
    //     t=0.120  expo=12    lin=12
    //
    // **The endpoints are fine and only the middle is poisoned**, which is why a test
    // that changes the band once and measures afterwards passes either way — the first
    // version of this test did exactly that and proved nothing. It takes a SECOND move
    // landing inside the 20 ms ramp to expose it, because `setRampPoint` reads the value
    // in flight and holds it: it reads NaN, writes NaN, and the band never recovers.
    //
    // A second move inside 20 ms is not a contrived case. It is what a drag is.
    //
    // Band 2 sits at 1120 Hz (`EQ_BAND_FREQUENCIES`), so the probe is a sine there — an
    // EQ band only proves anything at its own frequency.
    const base = steadyTone();
    const withEq = (gain: number): SynthPreset => ({
      ...base,
      effects: {
        ...base.effects,
        eq: { ...base.effects.eq, enabled: true, band2: { gain } },
      },
    });

    const { data, at } = await renderTimeline(
      (schedule) => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(withEq(-12));
        runtime.noteOn({ voiceId: 0, note: 'C6', velocity: 0.9, portamento: 0 });
        schedule(CHANGE_AT, () => runtime.applyPatch(withEq(12)));
        // Mid-ramp. The second half of one drag.
        schedule(CHANGE_AT + 0.005, () => runtime.applyPatch(withEq(0)));
      },
      { seconds: 1, sampleRate: SR },
    );

    const cut = rms(data, at(0.2), at(0.45));
    const settled = rms(data, at(0.7), at(0.95));

    expect(cut, 'the probe tone never sounded').toBeGreaterThan(0.01);
    // The band ends at 0 dB — flat — having started 12 dB down, so the tail must be
    // audibly louder than the head and must be a real number.
    expect(Number.isFinite(settled), `settled RMS was ${settled}`).toBe(true);
    expect(settled / cut, `settled (${settled}) vs cut (${cut})`).toBeGreaterThan(1.5);
  });

  it('reads no jump when nothing changes, which is what makes the gates above mean anything', async () => {
    // The negative probe, and it is load-bearing. Without it every assertion above could be
    // measuring the amplitude envelope, the filter settling, or the window boundaries rather
    // than the write — and would pass for the wrong reason once the writes are ramped.
    const { quiet, across } = await jumpAcrossChange(steadyTone());

    expect(across, 'an unchanged patch produced a jump — the probe is measuring itself').toBeLessThan(
      quiet * 3,
    );
  });
});
