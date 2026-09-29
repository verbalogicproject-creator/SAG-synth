/**
 * src/runtime/ahdsr-envelope.ts — Tone's envelopes with a HOLD stage and a shaped decay.
 *
 * `Tone.Envelope` is ADSR only, and its decay is linear or exponential (`Envelope.ts`
 * `_setCurve` refuses anything else for decay). The psytrance bass needs attack 0, then a
 * 20–80 ms hold, then a decay with a chosen slope.
 *
 * These subclass `AmplitudeEnvelope` and `FrequencyEnvelope` rather than replace them, and
 * override `triggerAttack` ONLY. Everything else — the release, the Pow/Scale of the
 * frequency envelope, `getValueAtTime`, `set` — is Tone's, untouched. The override is
 * `Tone.Envelope.triggerAttack` transcribed line for line (linear attack, the retrigger
 * rule, the `sampleTime` shortcut), with two changes:
 *
 *   1. a `setValueAtTime(peak, attackEnd + hold)` pins the plateau, and the decay starts
 *      there instead of at `attackEnd`;
 *   2. the decay dispatches on `decayShape`: `linear` and `exponential` make the exact
 *      calls Tone makes, and `logarithmic` is a value curve (`logDecayCurve`).
 *
 * So `hold: 0, decayShape: 'exponential'` issues precisely the calls `Tone.Envelope` did,
 * which is what lets schema_version 5 migrate every earlier patch without changing its
 * sound (F65) — gated by rendering both side by side.
 *
 * The release needs no override: Tone's `triggerRelease` starts with `targetRampTo`, whose
 * `setRampPoint` cancels everything after the release time — a note let go during its hold
 * or decay releases from wherever it has got to.
 */

import * as Tone from 'tone';
import { attackFrom, logDecayCurve } from '../core/ahdsr';
import type { DecayCurve, EnvelopeConfig } from '../core/types';

type Time = Parameters<Tone.Envelope['triggerAttack']>[0];

/** What an AHDSR adds on top of Tone's ADSR. */
export interface AhdsrShape {
  hold: number;
  decayShape: DecayCurve;
}

/**
 * The attack, hold and decay, on `sig`. Shared by both subclasses; `envelope` is passed for
 * its public readings (times, sustain, current value, sample time), `sig` because it is
 * the protected signal only a subclass can reach.
 */
function scheduleAttack(
  envelope: Tone.Envelope,
  sig: Tone.Signal<'normalRange'>,
  shape: AhdsrShape,
  timeIn: Time,
  velocity: number,
): void {
  const time = envelope.toSeconds(timeIn);
  const attack = attackFrom(envelope.getValueAtTime(time), envelope.toSeconds(envelope.attack));
  const decay = envelope.toSeconds(envelope.decay);

  if (attack < envelope.sampleTime) {
    // An attack of 0 sets instantly — the click.
    sig.cancelScheduledValues(time);
    sig.setValueAtTime(velocity, time);
  } else {
    sig.linearRampTo(velocity, attack, time);
  }

  const decayAt = time + attack + Math.max(0, shape.hold);
  // Pin the plateau: the value arrived at the peak at `time + attack` and stays there until
  // this event, because nothing is scheduled between the two.
  if (shape.hold > 0) sig.setValueAtTime(velocity, decayAt);

  if (decay && envelope.sustain < 1) {
    const target = velocity * envelope.sustain;
    if (shape.decayShape === 'linear') {
      sig.linearRampToValueAtTime(target, decayAt + decay);
    } else if (shape.decayShape === 'exponential') {
      sig.exponentialApproachValueAtTime(target, decayAt, decay);
    } else {
      sig.setValueCurveAtTime(logDecayCurve(velocity, target), decayAt, decay);
    }
  }
}

/** Tone's own options, from an AHDSR config: the four fields Tone knows. */
export function toneEnvelopeOptions(env: EnvelopeConfig): {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
} {
  return { attack: env.attack, decay: env.decay, sustain: env.sustain, release: env.release };
}

export class AhdsrAmplitudeEnvelope extends Tone.AmplitudeEnvelope implements AhdsrShape {
  hold = 0;
  decayShape: DecayCurve = 'exponential';

  /**
   * The raw 0..1 contour, for routing (`env.amp` / `env.filter`, C3). Tone's own `_sig`:
   * the signal the stages are scheduled on, before this envelope's output stage.
   */
  get contour(): Tone.Signal<'normalRange'> {
    return this._sig;
  }

  override triggerAttack(time?: Time, velocity: number = 1): this {
    scheduleAttack(this, this._sig, this, time, velocity);
    return this;
  }

  /** Write the AHDSR fields Tone does not know, alongside `set` for the ones it does. */
  setAhdsr(env: EnvelopeConfig): this {
    this.set(toneEnvelopeOptions(env));
    this.hold = env.hold;
    this.decayShape = env.decayCurve;
    return this;
  }
}

export class AhdsrFrequencyEnvelope extends Tone.FrequencyEnvelope implements AhdsrShape {
  hold = 0;
  decayShape: DecayCurve = 'exponential';

  /**
   * The raw 0..1 contour, for routing (`env.amp` / `env.filter`, C3). Tone's own `_sig`:
   * the signal the stages are scheduled on, before this envelope's output stage.
   */
  get contour(): Tone.Signal<'normalRange'> {
    return this._sig;
  }

  override triggerAttack(time?: Time, velocity: number = 1): this {
    scheduleAttack(this, this._sig, this, time, velocity);
    return this;
  }

  setAhdsr(env: EnvelopeConfig): this {
    this.hold = env.hold;
    this.decayShape = env.decayCurve;
    return this;
  }
}
