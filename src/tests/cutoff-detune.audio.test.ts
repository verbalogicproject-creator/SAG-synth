/**
 * src/tests/cutoff-detune.audio.test.ts — the cutoff base moved, and must sound identical.
 *
 * `voice.filterEnvelope.baseFrequency` no longer reaches `FrequencyEnvelope.baseFrequency`.
 * The envelope is pinned at 1 Hz and the base rides as cents on `filter.detune`, because a
 * biquad computes `frequency × 2^(detune/1200)` and `detune` is a `Signal` that can ramp
 * while `baseFrequency` is a JavaScript setter that cannot. See `baseFrequencyCents`.
 *
 * A refactor of the most heavily gated part of the codebase, in other words, and the
 * question is not "does it work" but **"is it the same sound"**. So the first two tests
 * here are equivalence tests against absolute, independently-computed expectations rather
 * than against remembered numbers.
 *
 * It did not survive first contact, which is the argument for the tests below existing:
 * `noteOn` had a SECOND writer of the base, applying `toFilterOctaves` as
 * `baseFrequency = base × 2^octaves`. Left alone it applied the base twice — multiplying
 * where it should have offset — and put the cutoff above nyquist. Sixteen existing gates
 * went red, which is the only reason the change was not shipped looking correct.
 *
 * **What is deliberately NOT asserted here.** That the cutoff no longer clicks — it never
 * did. A stepped cutoff changes a biquad's coefficients, not its output, and the state
 * variables carry over, so there is no discontinuity to find. Measured, and recorded in
 * `param-change.audio.test.ts` rather than quietly dropped.
 */

import { describe, expect, it } from 'vitest';
import { rms, spectralEdgeOctaves } from '../test-harness/audio-assertions';
import { renderTimeline } from '../test-harness/offline-render';
import { defaultPreset } from '../core/state';
import type { SynthPreset } from '../core/types';
import { ToneRuntime } from '../runtime';

const SR = 44100;

/** A patch whose filter sits exactly where it is put — no sweep, no envelope movement. */
function atCutoff(hz: number, shape: 'sawtooth' | 'sine' = 'sawtooth'): SynthPreset {
  const base = defaultPreset();
  const slot = base.voice.oscillators[0]!;
  return {
    ...base,
    voice: {
      ...base.voice,
      amplitude: 1,
      pan: 0,
      oscillators: [{ ...slot, type: shape, count: 1, detune: 0, spread: 0, level: 1, pan: 0 }],
      envelope: { attack: 0.005, hold: 0, decay: 0.01, decayCurve: 'exponential', sustain: 1, release: 0.1 },
      // `toFilterOctaves: 0` so the base under test is the ONLY thing setting the cutoff.
      // With it non-zero, note-on adds velocity × octaves cents on top and every expected
      // value below would carry a hidden term.
      velocity: { ...base.voice.velocity, toFilterOctaves: 0 },
      filterEnvelope: {
        attack: 0.001, hold: 0,
        decay: 0.001, decayCurve: 'exponential',
        sustain: 1,
        release: 0.1,
        baseFrequency: hz,
        octaves: 0, linked: false,
      },
      filter: { ...base.voice.filter, type: 'lowpass', rolloff: -24 },
    },
  };
}

async function renderAt(patch: SynthPreset, note = 'C2', seconds = 0.5): Promise<Float32Array> {
  const { data } = await renderTimeline(
    () => {
      const runtime = new ToneRuntime();
      runtime.applyPatch(patch);
      runtime.noteOn({ voiceId: 0, note, velocity: 0.9, portamento: 0 });
    },
    { seconds, sampleRate: SR },
  );
  return data;
}

describe('the cutoff still lands where the patch says', () => {
  it('tracks the base across four octaves of it', async () => {
    // Absolute, not remembered. `spectralEdgeOctaves` reports where the energy stops in
    // octaves above 20 Hz, so doubling the cutoff must move it by about one — and that is
    // a property of the filter, checkable without knowing what this code used to print.
    const bases = [400, 800, 1600, 3200];
    const edges: number[] = [];
    for (const hz of bases) {
      const data = await renderAt(atCutoff(hz));
      expect(rms(data, 0, data.length), `nothing sounded at ${hz} Hz`).toBeGreaterThan(0.01);
      edges.push(spectralEdgeOctaves(data, SR, Math.floor(0.2 * SR)));
    }

    for (let i = 1; i < edges.length; i += 1) {
      const step = edges[i]! - edges[i - 1]!;
      expect(
        step,
        `${bases[i - 1]} -> ${bases[i]} Hz moved the edge ${step.toFixed(2)} octaves, not ~1`,
      ).toBeGreaterThan(0.55);
      expect(step).toBeLessThan(1.45);
    }
  });

  it('puts the edge at the cutoff itself, not at some multiple of it', async () => {
    // The equivalence test that would catch the base being applied twice — which is
    // exactly what happened while this was being written. A doubled base does not break
    // the monotonic spacing above; it breaks the absolute position.
    const data = await renderAt(atCutoff(800));
    const edge = spectralEdgeOctaves(data, SR, Math.floor(0.2 * SR));
    // 800 Hz is log2(800/20) = 5.32 octaves above the 20 Hz floor the helper measures
    // from. A -24 dB/oct lowpass leaves some energy above its corner, so the 99% edge sits
    // a little higher; a full octave of slack either way still refuses a doubled base,
    // which would land at 6.32.
    expect(edge, `edge at ${edge.toFixed(2)} octaves, expected near 5.3`).toBeGreaterThan(4.6);
    expect(edge).toBeLessThan(6.1);
  });
});

describe('the cutoff now glides rather than jumping', () => {
  it('is still part-way there 10 ms after the change, where a step would have arrived', async () => {
    // The behaviour the move to `filter.detune` actually buys, and the only window in
    // which it is observable: a 20 ms ramp is far shorter than an FFT frame, so this
    // measures LEVEL rather than spectrum. A 4 kHz sine below the cutoff is attenuated;
    // open the cutoff and it rises, and at 4 kHz a 2 ms window holds eight cycles, so RMS
    // over 2 ms is steady enough to resolve a 20 ms movement into stages.
    //
    // **The window is +10 ms and the choice is measured, not guessed.** The trajectory,
    // RMS per 2 ms:
    //
    //     -10ms 0.0137   +5ms 0.0135   +10ms 0.0664   +15ms 0.3375
    //     +20ms 0.2831   +25ms 0.2329   +30ms 0.2265   +40ms 0.2298
    //
    // Nothing moves until about +7 ms — that is the offline clock's 128-sample tick
    // granularity, and a STEP would be just as late, so +5 ms cannot tell the two apart.
    // And +15 ms OVERSHOOTS the settled level: real filter behaviour as a resonant corner
    // sweeps past the tone, not a measurement artefact, but it makes any "strictly
    // between" assertion there wrong. +10 ms is inside the ramp and before the ring.
    const CHANGE_AT = 0.3;
    const { data, at } = await renderTimeline(
      (schedule) => {
        const runtime = new ToneRuntime();
        // 2 kHz start, not lower: at -24 dB/oct a 4 kHz tone one octave above the corner
        // is already ~26 dB down, and starting at 700 Hz buried it 62 dB down where the
        // "before" window reads as silence and the ratios below mean nothing.
        runtime.applyPatch(atCutoff(2000, 'sine'));
        // C8 is 4186 Hz; the exact pitch does not matter, only that it is above the
        // starting cutoff and well below the ending one.
        runtime.noteOn({ voiceId: 0, note: 'C8', velocity: 0.9, portamento: 0 });
        schedule(CHANGE_AT, () => runtime.applyPatch(atCutoff(18000, 'sine')));
      },
      { seconds: 0.5, sampleRate: SR },
    );

    const window = (from: number): number => rms(data, at(from), at(from + 0.002));
    const before = window(CHANGE_AT - 0.005);
    const during = window(CHANGE_AT + 0.01);
    const after = window(CHANGE_AT + 0.04);

    expect(before, 'the probe tone never sounded').toBeGreaterThan(0.001);
    expect(after, 'opening the filter should raise a 4 kHz tone').toBeGreaterThan(before * 5);
    // Strictly between: under way, and nowhere near finished. A stepped base puts `during`
    // at or above `after`; no movement at all leaves it on `before`. Both fail here.
    expect(during, `during (${during}) should exceed before (${before})`).toBeGreaterThan(
      before * 2,
    );
    expect(during, `during (${during}) should fall well short of after (${after})`).toBeLessThan(
      after * 0.5,
    );
  });
});
