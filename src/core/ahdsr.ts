/**
 * src/core/ahdsr.ts — the AHDSR envelope's arithmetic, with no clock in it.
 *
 * The runtime schedules the stages on an audio-rate signal; what each stage IS lives here,
 * where it is a runner test (per /root/CLAUDE.md, a decision that can be pure must be).
 *
 * Stages: attack (linear ramp to the peak) → HOLD (the peak, unchanged) → decay to sustain,
 * shaped by `decayCurve` → sustain → release. Eyal's psytrance bass is the reason `hold`
 * exists: attack 0 is the click, 20–80 ms of hold is the body behind it, and the decay slope
 * is the character.
 *
 * Two of the three decay shapes are scheduled by Tone's own primitives and need nothing
 * here: `linear` is a linear ramp, and `exponential` is `exponentialApproachValueAtTime`,
 * the exact call `Tone.Envelope` makes today — which is what makes a migrated patch
 * (hold 0, exponential) sound identical. `logarithmic` has no Web Audio primitive, so it is
 * a value curve, and the curve is this file.
 */

import type { EnvelopeConfig, FilterEnvelopeConfig, ParamPath, Seconds, VoiceConfig } from './types';

/** Points in a logarithmic decay curve. Tone lowers a value curve to linear segments. */
export const LOG_DECAY_POINTS = 32;

/**
 * How sharply a logarithmic decay holds up before it falls. The level at fraction `x` of
 * the decay is `1 − x^3` of the way from the peak to sustain: at a third of the way
 * through, 96% of the drop is still to come; at two thirds, 70%.
 */
export const LOG_DECAY_EXPONENT = 3;

/**
 * The value curve of a logarithmic decay from `from` to `to`, `points` values long,
 * inclusive of both ends. Monotonic, exact at both ends, and above the straight line
 * between them everywhere in between — slow, then fast.
 */
export function logDecayCurve(from: number, to: number, points = LOG_DECAY_POINTS): number[] {
  const count = Math.max(2, Math.floor(points));
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = i / (count - 1);
    values.push(to + (from - to) * (1 - Math.pow(x, LOG_DECAY_EXPONENT)));
  }
  return values;
}

/**
 * When the decay stage starts, relative to the note-on: the attack (as actually run — a
 * retrigger shortens it) plus the hold.
 */
export function decayStart(attackRun: Seconds, hold: Seconds): Seconds {
  return attackRun + Math.max(0, hold);
}

/**
 * When a sustain-0 envelope reaches silence, relative to the note-on: attack + hold + decay.
 *
 * The runtime stops the oscillators here — a percussive patch whose oscillators ran on after
 * the envelope closed would burn a voice's CPU producing nothing. Before AHDSR this was
 * attack + decay; leaving the hold out would stop the oscillators while the note is still at
 * its peak, and the psytrance click would lose its body.
 */
export function silentAfter(env: Pick<EnvelopeConfig, 'attack' | 'hold' | 'decay'>): Seconds {
  return env.attack + Math.max(0, env.hold) + env.decay;
}

/**
 * The attack Tone actually runs on a retrigger: from the current level, at the same RATE
 * as a full attack (`Tone.Envelope.triggerAttack`: remaining distance / (1 / attack)).
 * Transcribed so the rule is visible and tested rather than implied by a subclass.
 */
export function attackFrom(current: number, attack: Seconds): Seconds {
  if (current <= 0) return attack;
  return Math.max(0, 1 - current) * attack;
}

/**
 * The six stage values a linked filter envelope takes from the amp envelope. Cutoff
 * (`baseFrequency`) and amount (`octaves`) are what the filter envelope MOVES, not how it
 * moves, so they are never linked.
 */
export const LINKED_STAGE_KEYS = ['attack', 'hold', 'decay', 'decayCurve', 'sustain', 'release'] as const;

/** The filter-envelope addresses a link overrides — drawn as ignored while it is on. */
export const LINKED_FILTER_PATHS: readonly ParamPath[] = LINKED_STAGE_KEYS.map(
  (key) => `voice.filterEnvelope.${key}` as ParamPath,
);

/**
 * The filter envelope the voice actually runs. Unlinked, it is the patch's own. Linked
 * (schema_version 6, Eyal's "mirror the amp AHDSR to the filter"), the six stages are the
 * amp's and the filter's own stored stages are ignored, not overwritten: unlinking brings
 * them back. The runtime and the drawing both read this, so the two cannot disagree.
 */
export function effectiveFilterEnvelope(voice: Pick<VoiceConfig, 'envelope' | 'filterEnvelope'>): FilterEnvelopeConfig {
  const own = voice.filterEnvelope;
  if (!own.linked) return own;
  const amp = voice.envelope;
  return {
    ...own,
    attack: amp.attack,
    hold: amp.hold,
    decay: amp.decay,
    decayCurve: amp.decayCurve,
    sustain: amp.sustain,
    release: amp.release,
  };
}
