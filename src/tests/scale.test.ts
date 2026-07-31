/**
 * src/tests/scale.test.ts — the value/position mapping every control shares.
 *
 * Worth its own gate because two components using it must agree: a cutoff knob and a
 * cutoff slider have to put 2.8 kHz in the same place and print the same string, and the
 * only way that holds is if neither of them owns the arithmetic.
 */

import { describe, expect, it } from 'vitest';
import { formatValue, fromTrack, isLogarithmic, stepOf, toTrack } from '../core/scale';
import { PARAM_SPECS } from '../core/schemas';
import { PARAM_PATHS } from '../core/schemas';

const cutoff = PARAM_SPECS['voice.filterEnvelope.baseFrequency'];
const sustain = PARAM_SPECS['voice.envelope.sustain'];
const rolloff = PARAM_SPECS['voice.filter.rolloff'];
const polyphony = PARAM_SPECS['voice.polyphony'];

const asNumber = (spec: typeof cutoff) => {
  if (spec.kind !== 'number') throw new Error('expected a number spec');
  return spec;
};

describe('a value and its place on the track', () => {
  it('round-trips every continuous parameter through the track and back', () => {
    // The property that matters: dragging to where a value already is must not move it.
    for (const path of PARAM_PATHS) {
      const spec = PARAM_SPECS[path];
      if (spec.kind !== 'number' || spec.choices !== undefined || spec.integer === true) continue;

      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        const value = spec.min + (spec.max - spec.min) * fraction;
        const back = fromTrack(toTrack(value, spec), spec);
        expect(back, `${path} at ${fraction}`).toBeCloseTo(value, 6);
      }
    }
  });

  it('puts a cutoff halfway up the track at its geometric middle, not its arithmetic one', () => {
    // The reason the log branch exists. On a linear track, 20–20000 Hz would put 10 kHz at
    // the halfway point and every musically useful cutoff in the bottom tenth of the
    // travel — unusable exactly where it matters.
    const spec = asNumber(cutoff);
    expect(isLogarithmic(spec)).toBe(true);

    const middle = fromTrack(0.5, spec);
    expect(middle).toBeCloseTo(Math.sqrt(20 * 20000), 0);
    // And emphatically not the arithmetic midpoint.
    expect(middle).toBeLessThan(1000);
  });

  it('keeps a plain 0..1 parameter linear', () => {
    const spec = asNumber(sustain);
    expect(isLogarithmic(spec)).toBe(false);
    expect(fromTrack(0.5, spec)).toBeCloseTo(0.5, 6);
  });

  it('never produces a value the validator would refuse', () => {
    // A track that can express an illegal value is a control that appears to work.
    // `rolloff` has four legal slopes; anywhere on the travel must land on one of them.
    const spec = asNumber(rolloff);
    for (let i = 0; i <= 20; i += 1) {
      expect(spec.choices).toContain(fromTrack(i / 20, spec));
    }

    // And an integer parameter never yields a fraction of a voice.
    const voices = asNumber(polyphony);
    for (let i = 0; i <= 20; i += 1) {
      expect(Number.isInteger(fromTrack(i / 20, voices))).toBe(true);
    }
  });

  it('clamps rather than extrapolating past either end', () => {
    const spec = asNumber(sustain);
    expect(toTrack(-5, spec)).toBe(0);
    expect(toTrack(5, spec)).toBe(1);
    expect(fromTrack(-1, spec)).toBe(spec.min);
    expect(fromTrack(2, spec)).toBe(spec.max);
  });

  it('offers a step that means something for the parameter it belongs to', () => {
    expect(stepOf(asNumber(polyphony))).toBe(1);
    expect(stepOf(asNumber(sustain))).toBeCloseTo(0.01, 6);
  });
});

describe('what the control prints', () => {
  it('reads a frequency the way an instrument does', () => {
    const spec = asNumber(cutoff);
    expect(formatValue(20, spec)).toBe('20.0 Hz');
    expect(formatValue(800, spec)).toBe('800 Hz');
    // kHz past a thousand, because "12000 Hz" is four digits nobody parses at a glance.
    expect(formatValue(12000, spec)).toBe('12.00 kHz');
  });

  it('keeps enough precision on a time that a short attack is not drawn as zero', () => {
    // An envelope moving between 1 ms and 4 ms would read "0.00 s" at two decimals, which
    // is a control reporting that it does nothing.
    const attack = asNumber(PARAM_SPECS['voice.envelope.attack']);
    expect(formatValue(0.001, attack)).toBe('0.001 s');
    expect(formatValue(0.004, attack)).toBe('0.004 s');
    expect(formatValue(0.001, attack)).not.toBe(formatValue(0.004, attack));
  });

  it('says something honest for every kind, including nothing at all', () => {
    expect(formatValue(true, PARAM_SPECS['effects.eq.enabled'])).toBe('on');
    expect(formatValue('sawtooth', PARAM_SPECS['voice.oscillators.0.type'])).toBe('sawtooth');
    expect(formatValue(4, PARAM_SPECS['voice.lfos.0.frequency'])).toBe('4 Hz');
    expect(formatValue('8n', PARAM_SPECS['voice.lfos.0.frequency'])).toBe('8n');
    // An absent value is drawn as absent rather than as the bottom of the range, which
    // would be a number the patch never asked for.
    expect(formatValue(undefined, PARAM_SPECS['voice.envelope.attack'])).toBe('—');
  });

  it('prints something for every declared address', () => {
    for (const path of PARAM_PATHS) {
      const spec = PARAM_SPECS[path];
      const sample =
        spec.kind === 'number'
          ? spec.min
          : spec.kind === 'boolean'
            ? false
            : spec.kind === 'enum'
              ? spec.values[0]
              : 4;
      expect(formatValue(sample, spec).length, `${path} prints nothing`).toBeGreaterThan(0);
    }
  });
});
