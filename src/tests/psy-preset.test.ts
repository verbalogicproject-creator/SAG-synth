/**
 * src/tests/psy-preset.test.ts — the Psy Roll factory preset is a real, loadable patch whose
 * numbers say what its comment says.
 */

import { describe, expect, it } from 'vitest';
import { PSY_ROLL_PRESET_ID, initialEngineState, psyRollPreset } from '../core/state';
import { PresetSchema } from '../core/schemas';
import { reduce } from '../core/reduce';
import { silentAfter } from '../core/ahdsr';

const meta = { commandId: 'c1', ts: 1 };

describe('Psy Roll', () => {
  it('validates against the preset schema', () => {
    const result = PresetSchema.safeParse(psyRollPreset());
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
  });

  it('ships in the factory library and loads by id', () => {
    const state = initialEngineState();
    expect(state.presets[PSY_ROLL_PRESET_ID]?.name).toBe('Psy Roll');
    const loaded = reduce(state, { type: 'loadPreset', presetId: PSY_ROLL_PRESET_ID }, meta);
    expect(loaded.status).toBe('applied');
    if (loaded.status === 'applied') expect(loaded.state.patch.voice.oscillators).toHaveLength(2);
  });

  it('cannot be deleted, like every factory preset', () => {
    const result = reduce(initialEngineState(), { type: 'deletePreset', presetId: PSY_ROLL_PRESET_ID }, meta);
    expect(result.status).toBe('rejected');
  });

  it('is gone before the next 16th at 145 BPM, with sustain 0 on both contours', () => {
    const { envelope, filterEnvelope } = psyRollPreset().voice;
    const sixteenth = 60 / 145 / 4;
    expect(envelope.sustain).toBe(0);
    expect(filterEnvelope.sustain).toBe(0);
    // attack + HOLD + decay: the hold is the click's body, and it spends the 16th too.
    expect(silentAfter(envelope)).toBeLessThan(sixteenth);
  });

  it('is Eyal’s AHDSR: attack 0 for the click, a 20–80 ms hold for the body', () => {
    const { envelope } = psyRollPreset().voice;
    expect(envelope.attack).toBe(0);
    expect(envelope.hold).toBeGreaterThanOrEqual(0.02);
    expect(envelope.hold).toBeLessThanOrEqual(0.08);
  });

  it('peaks inside the recipe’s 400 Hz–1 kHz cutoff window, about an octave of envelope', () => {
    const { baseFrequency, octaves } = psyRollPreset().voice.filterEnvelope;
    const peak = baseFrequency * Math.pow(2, octaves);
    expect(peak).toBeGreaterThan(400);
    expect(peak).toBeLessThan(1000);
  });

  it('keeps everything that widens or smears the low end off', () => {
    const { effects } = psyRollPreset();
    expect(effects.chorus.enabled).toBe(false);
    expect(effects.delay.enabled).toBe(false);
    expect(effects.reverb.enabled).toBe(false);
  });
});
