/**
 * src/core/scale.ts — value to track position, and value to text.
 *
 * Two questions every control asks and none of them should answer privately: where along
 * its travel does this value sit, and what does it say underneath. Both are facts about
 * the PARAMETER, not about the widget — a cutoff knob and a cutoff slider put 2.8 kHz in
 * the same place and print the same string, or one of them is lying.
 *
 * Lifted out of `debug/ParamControl.tsx`, which had them right and had them alone. The
 * designed surface needs the identical logic for six components, and copying it would
 * have been the fourth time today an engine fact was duplicated into a client.
 *
 * The track position is normalised 0..1, which is the Universal I/O Interface's own
 * percentage signal wearing different units — `NodeDirector.convertSignal(pct, type)`
 * doing `min + pct * range` is `fromTrack` with the same argument order. This file is that
 * middleware, typed and given a range it cannot invent.
 *
 * Layer rule D2: core, zod only. No DOM, no widget vocabulary — nothing here knows whether
 * the track is horizontal.
 */

import type { ParamSpec } from './schemas';
import type { ParamValue, Unit } from './types';

type NumberSpec = Extract<ParamSpec, { kind: 'number' }>;

/**
 * Frequencies get a logarithmic track; everything else is linear.
 *
 * A 20–20000 Hz cutoff on a linear track puts every musically useful position in the
 * bottom tenth of the travel — unusable exactly where it matters most. Pitch is perceived
 * logarithmically, so the track has to be, and this is the same reason `EQ_BAND_FREQUENCIES`
 * is spaced by ratio rather than by difference.
 */
export function isLogarithmic(spec: ParamSpec): boolean {
  return spec.kind === 'number' && spec.unit === 'Hz' && spec.min > 0;
}

/** Where a value sits along its control's travel, 0..1. */
export function toTrack(value: number, spec: NumberSpec): Unit {
  const clamped = Math.min(Math.max(value, spec.min), spec.max);
  if (!isLogarithmic(spec)) {
    return spec.max === spec.min ? 0 : (clamped - spec.min) / (spec.max - spec.min);
  }
  return Math.log(clamped / spec.min) / Math.log(spec.max / spec.min);
}

/**
 * The value at a position along the travel. Rounds when the spec says the parameter is
 * discrete, and snaps to the nearest legal choice when the spec lists them — a track that
 * can express a value the validator refuses is a control that appears to work.
 */
export function fromTrack(position: Unit, spec: NumberSpec): number {
  const ratio = Math.min(Math.max(position, 0), 1);
  const raw = isLogarithmic(spec)
    ? spec.min * (spec.max / spec.min) ** ratio
    : spec.min + ratio * (spec.max - spec.min);

  if (spec.choices !== undefined) {
    return spec.choices.reduce((best, choice) =>
      Math.abs(choice - raw) < Math.abs(best - raw) ? choice : best,
    );
  }
  return spec.integer === true ? Math.round(raw) : raw;
}

/**
 * What the control prints. Precision follows the unit rather than a global rule, because
 * three decimals on a hertz value is noise and none on a seconds value is a lie: an
 * envelope attack moving between 0.001 s and 0.004 s would read as 0 either way.
 */
export function formatValue(value: ParamValue | undefined, spec: ParamSpec): string {
  if (value === undefined) return '—';

  switch (spec.kind) {
    case 'boolean':
      return value === true ? 'on' : 'off';
    case 'enum':
      return String(value);
    case 'frequency':
      // Hz or a Tone subdivision like "8n" — the sync toggle decides which, and the raw
      // form is the honest rendering of both.
      return typeof value === 'number' ? `${value} Hz` : String(value);
    case 'number': {
      if (typeof value !== 'number') return String(value);
      const unit = spec.unit === undefined ? '' : ` ${spec.unit}`;
      if (spec.integer === true) return `${value}${unit}`;
      if (spec.unit === 'Hz') {
        return value >= 1000
          ? `${(value / 1000).toFixed(2)} kHz`
          : `${value >= 100 ? Math.round(value) : value.toFixed(1)}${unit}`;
      }
      if (spec.unit === 's') return `${value.toFixed(3)}${unit}`;
      return `${value.toFixed(2)}${unit}`;
    }
  }
}

/**
 * A sensible nudge for one press of an arrow key or one detent of a fine drag: a hundredth
 * of the travel, or one step where the parameter is discrete.
 */
export function stepOf(spec: NumberSpec): number {
  if (spec.integer === true) return 1;
  return (spec.max - spec.min) / 100;
}
