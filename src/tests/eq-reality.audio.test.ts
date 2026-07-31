/**
 * src/tests/eq-reality.audio.test.ts — the EQ note, made true.
 *
 * `EQ_BAND_FACTORY_LIFT_DB` tells a player what +18 dB on each band will actually do to
 * the factory patch, because "this control is broken" and "this control has nothing to act
 * on" are indistinguishable from the knob and the EQ was reported broken twice while
 * working perfectly.
 *
 * The table used to live in `FxPanel.tsx` under a comment saying it was "pinned by a gate
 * on the factory patch, so a brighter default shows up as a failing test rather than as a
 * note that quietly became false". There was no gate. The sentence describing the check
 * was doing the job of the check, and the note had already quietly become false — band 3
 * was drawn as +4 dB against a measured +3.45.
 *
 * So this is the gate that comment described. It is also the reason the numbers are stated
 * to one decimal: rounding to whole dB is what let a 3.45 be written down as a 4.
 */

import * as Tone from 'tone';
import { describe, expect, it } from 'vitest';
import { ToneRuntime } from '../runtime/tone-runtime';
import { defaultPreset } from '../core/state';
import {
  EQ_BAND_FACTORY_LIFT_DB,
  EQ_BAND_FREQUENCIES,
  type SynthPreset,
} from '../core/types';

const SR = 44100;

/** Half a dB. Renders are deterministic, so this is drift, not noise. */
const TOLERANCE_DB = 0.5;

function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i]! ** 2;
  return Math.sqrt(sum / data.length);
}

async function renderLevel(patch: SynthPreset): Promise<number> {
  const buffer = await Tone.Offline(
    () => {
      const runtime = new ToneRuntime();
      runtime.applyPatch(patch);
      runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 0.9, portamento: 0 });
    },
    1,
    1,
    SR,
  );
  return rms(buffer.getChannelData(0));
}

function factoryWithEq(lift?: { band: number; gain: number }): SynthPreset {
  const patch = defaultPreset();
  const eq = { ...patch.effects.eq, enabled: true };
  if (lift !== undefined) {
    // Indexed rather than switched on five literals: the band count is declared, and a
    // sixth band should reach this loop without an edit here.
    (eq as unknown as Record<string, { gain: number }>)[`band${lift.band}`] = { gain: lift.gain };
  }
  return { ...patch, effects: { ...patch.effects, eq } };
}

describe('the EQ note is measured, not remembered', () => {
  it('lifts the factory patch by the dB each band claims', async () => {
    const base = await renderLevel(factoryWithEq());

    const wrong: string[] = [];
    for (let band = 0; band < EQ_BAND_FREQUENCIES.length; band += 1) {
      const level = await renderLevel(factoryWithEq({ band, gain: 18 }));
      const measured = 20 * Math.log10(level / base);
      const claimed = EQ_BAND_FACTORY_LIFT_DB[band]!;

      if (Math.abs(measured - claimed) > TOLERANCE_DB) {
        wrong.push(
          `band${band} @ ${EQ_BAND_FREQUENCIES[band]} Hz: says ${claimed}, measures ${measured.toFixed(2)}`,
        );
      }
    }

    expect(wrong, 'the EQ note no longer describes the factory patch').toEqual([]);
  }, 120_000);

  it('keeps the note the shape the panel needs', () => {
    // One number per band, and every one a real lift. A zero here would mean the note is
    // claiming a band does nothing, which is a different statement and needs its own words.
    expect(EQ_BAND_FACTORY_LIFT_DB).toHaveLength(EQ_BAND_FREQUENCIES.length);
    for (const lift of EQ_BAND_FACTORY_LIFT_DB) expect(lift).toBeGreaterThan(0);

    // Descending, which is the whole point of showing them: the factory patch is dark, so
    // the low bands have material to lift and the high ones do not. If this ever fails the
    // explanatory sentence beside the numbers has stopped being true.
    const descending = [...EQ_BAND_FACTORY_LIFT_DB].every(
      (lift, i, all) => i === 0 || all[i - 1]! > lift,
    );
    expect(descending, 'the bands no longer fall off with frequency').toBe(true);
  });
});
