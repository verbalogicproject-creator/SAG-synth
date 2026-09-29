/**
 * src/runtime/tone-shared.ts — what the synth instrument and the runtime around it both use.
 *
 * Split out of `tone-runtime.ts` at cycle 2 C4, moved verbatim: how a parameter is written
 * (step or ramp, at the audio clock), the minimum gap between events on one voice, and the
 * tanh saturation curve that both the master distortion and per-voice drive are built on.
 * One copy, so the instrument and the master chain cannot drift apart on any of it.
 */

import * as Tone from 'tone';
import type { Unit } from '../core/types';

/**
 * Drive at `amount: 1.0` — how far into the saturating part of the curve the signal is
 * pushed. The knee of `tanh(d·x)` sits at `|x| ≈ 1/d`, so this is really "the level above
 * which everything clips", read backwards.
 *
 * 12 was measured, not chosen. On the factory patch through the dispatcher, the crest
 * factor at the sustain runs 2.95 clean → 2.79 · 2.48 · 1.89 · 1.46 · 1.31 across
 * amount 0.1 → 1.0: a smooth, monotonic march from untouched to nearly square, using the
 * whole knob. At 50 the same sweep reached crest 1.37 by amount 0.2 and then had nowhere
 * left to go — four fifths of the control doing nothing distinguishable.
 *
 * The knee of `tanh(d·x)` sits at `|x| ≈ 1/d`, so this is really "the level above which
 * everything clips", read backwards. What makes 12 right rather than 50 is that the effect
 * has to bite at the level the instrument actually plays — a voice sustains near 0.1 — and
 * not at the ±1 full scale a curve is drawn for.
 */
const DISTORTION_MAX_DRIVE = 12;

/**
 * The level the makeup gain is measured against, as a peak amplitude.
 *
 * One MonoSynth voice through the factory patch arrives at the effects chain peaking near
 * 0.2 at its sustain, which is nowhere near the ±1 a waveshaper curve is drawn for. That
 * mismatch is the whole bug this replaced: at that level, Tone's own distortion curve is a
 * 2.5x gain and almost nothing else. It measured as louder and slightly duller, which is
 * exactly what it sounded like.
 *
 * Measured too. Taking the makeup reference at 0.3 left the level rising 0.4 → 3.9 dB
 * across the knob, so "more distortion" still partly meant "louder". At 0.2 — the level
 * the note actually holds — it runs 0.1 → 0.4 dB, which is flat enough that the knob
 * changes nothing but character.
 */
const DISTORTION_REFERENCE_PEAK = 0.2;

/** Curve resolution. WaveShaper interpolates linearly between entries. */
const DISTORTION_CURVE_POINTS = 1024;

/**
 * The transfer curve for one `amount`, and the makeup gain that keeps it level.
 *
 * `tanh` rather than Tone's own curve, and the reason is not taste. `Tone.Distortion`
 * builds `(3+k)·x·20°/(π + k·|x|)` with `k = 100·amount`, whose slope through the origin is
 * `(3+k)/9` — 0.33 at amount 0, 2.6 at 0.2, 11.4 at 1.0. The knob is therefore a **volume
 * control** with a saturation character attached, and on a signal peaking at 0.3 the
 * saturation is the part you cannot hear. Measured through the dispatcher on the factory
 * patch: enabling it raised the level 2.1 dB and *lowered* the absolute energy above 2 kHz
 * by 22%. "No distortion" is the correct description of that.
 *
 * `tanh(d·x)/tanh(d)` has slope `d/tanh(d)` at the origin and saturates at ±1, so amount
 * moves the KNEE and nothing else. The remaining level change is then removed outright by
 * a makeup gain measured on the curve rather than reasoned about — see below.
 */
export function distortionCurve(
  amount: Unit,
  referencePeak: number = DISTORTION_REFERENCE_PEAK,
): { curve: Float32Array; makeup: number } {
  const drive = amount * DISTORTION_MAX_DRIVE;
  // Below this the curve is indistinguishable from identity and `tanh(d)` underflows.
  const shape =
    drive < 1e-6 ? (x: number): number => x : (x: number): number => Math.tanh(drive * x) / Math.tanh(drive);

  const curve = new Float32Array(DISTORTION_CURVE_POINTS);
  for (let i = 0; i < DISTORTION_CURVE_POINTS; i++) {
    curve[i] = shape((i / (DISTORTION_CURVE_POINTS - 1)) * 2 - 1);
  }

  // Makeup, measured: run one cycle of a reference sine through the curve and compare RMS
  // in against RMS out. Computing it from the curve's own slope would only hold for the
  // linear region, which is precisely the region distortion is supposed to leave.
  //
  // The effect of this is that `amount` changes CHARACTER at constant loudness. Without it
  // the knob is a volume control wearing a distortion label, which is what it was.
  let inputEnergy = 0;
  let outputEnergy = 0;
  const cycle = 512;
  for (let i = 0; i < cycle; i++) {
    const x = referencePeak * Math.sin((2 * Math.PI * i) / cycle);
    const y = shape(x);
    inputEnergy += x * x;
    outputEnergy += y * y;
  }
  return { curve, makeup: outputEnergy > 0 ? Math.sqrt(inputEnergy / outputEnergy) : 1 };
}

/**
 * Minimum spacing between two scheduled events on the SAME voice, in seconds.
 *
 * Tone asserts that a source's start time is strictly greater than its previous one, so
 * two events landing on one voice at the same clock instant throw — which would take
 * down the whole `dispatch()` call. That happens constantly under `Tone.Offline` (the
 * callback runs synchronously, so every call reads the same `now`), and it is reachable
 * live too: `steal(id)` is issued immediately before the `noteOn` that reuses the slot,
 * and a fast retrigger of a held note lands on the voice it is already sounding.
 *
 * 0.1 ms is below the threshold of hearing for onset timing and far below one sample at
 * 44.1 kHz being audible as a shift, so nudging is inaudible.
 */
export const MIN_EVENT_GAP_SECONDS = 1e-4;

/**
 * How long a parameter takes to reach a new value.
 *
 * 20 ms. Long enough that the step is not a click — a discontinuity's energy is spread
 * over the ramp instead of arriving in one sample — and short enough that a knob still
 * feels attached to the finger. It is also comfortably shorter than the 100 ms `lookAhead`
 * every write is already scheduled behind, so a ramp begins and ends in the future and
 * never fights the render quantum.
 */
export const PARAM_RAMP_SECONDS = 0.02;

/**
 * Whether a write has a value to come FROM.
 *
 * The first push into a graph has none: every node still holds its constructor default, so
 * gliding to the patch would not be a declick — it would be an audible slide on every
 * patch load, from a value the player never chose, and a preset would take 20 ms to become
 * itself.
 *
 * That semantic reason is the whole reason. An earlier draft of this comment also claimed
 * the existing audio gates would break, since they build a runtime, apply once at offline
 * time zero and measure early. **Checked, and false**: forcing every write to ramp leaves
 * all 508 of them green. Worth recording rather than quietly deleting — the claim was
 * plausible, it was never measured, and a comment asserting something the suite does not
 * do is the defect class this project keeps closing.
 */
export type WriteMode = 'step' | 'ramp';

/**
 * The slice of a Tone parameter this needs, structurally.
 *
 * `Tone.Param` and `Tone.Signal` are unrelated classes — `Signal` *implements* `Param`
 * rather than extending it — and a class with private members is not structurally
 * assignable to another class. An interface has no such problem, so this is what lets one
 * helper serve `Param<'gain'>`, `Signal<'frequency'>` and the rest without an `any` and
 * without a fourteen-arm union.
 */
interface RampableParam<T> {
  value: T;
  rampTo(value: T, rampTime: number, startTime?: number): unknown;
  linearRampTo(value: T, rampTime: number, startTime?: number): unknown;
  cancelScheduledValues(time: number): unknown;
  setValueAtTime(value: T, time: number): unknown;
}

/**
 * The audio clock NOW — `currentTime`, not `Tone.now()`.
 *
 * Tone defines `now()` as `currentTime + lookAhead` (`Tone/core/context/Context.ts`), and
 * every write in this file used to land there: a knob, a live key, a patch write on a voice
 * built a moment ago. At Tone's default 0.1 s that was a tenth of a second of latency on
 * everything a finger does. Once the transport's lookahead is raised for stability
 * (`TRANSPORT_LOOKAHEAD`), it would have been a fifth. The lookahead exists for the
 * SEQUENCER — it is how far ahead the Transport schedules — so only the Transport uses it,
 * and every interactive write goes here instead.
 *
 * Read from the global context rather than a captured one, because the pump re-enters its
 * own context before anything it runs calls this (see `pump`).
 *
 * **The `currentTime` getter, not Tone's `immediate()`.** They are the same thing online. But
 * `OfflineContext` overrides `now()` and `currentTime` with its simulated clock and does NOT
 * override `immediate()`, which still reads the raw `OfflineAudioContext.currentTime` — 0 for
 * the whole simulated pass (`Tone/core/context/OfflineContext.ts` vs `Context.ts`). Every
 * scheduled write in the offline gates landed at t = 0 until this said `currentTime`; four
 * gates caught it on the first run.
 */
export function immediate(): number {
  return Tone.getContext().currentTime;
}

/**
 * Push `value` at an audio-rate parameter without clicking.
 *
 * Every parameter in this runtime was written as `param.value = x`, which Tone implements
 * as `setValueAtTime(x, now())` — an instantaneous step in the signal, which is a
 * discontinuity, which is broadband click. Reported from the device as a crack when a knob
 * moves under a held note, and gated by `param-change.audio.test.ts`.
 *
 * `rampTo` is safe at pointer rate by construction. It begins with `setRampPoint`, which
 * reads the value in flight, `cancelAndHoldAtTime`s there, and schedules onward from that
 * point — so a ramp interrupted by the next ramp continues from wherever it had got to
 * rather than jumping back. That is also why this had to land AFTER the diff and not
 * before: `cancelAndHoldAtTime` walks the param's automation `Timeline`, so ramping all
 * twenty-odd writes on every pointer move would have been strictly more main-thread work
 * than the steps it replaces.
 *
 * **`curve` is a correctness switch, not taste.** `Param.rampTo` picks an EXPONENTIAL ramp
 * for units `frequency`, `bpm` and `decibels` (`Tone/core/context/Param.ts`). That is right
 * when decibels are converted to gain first — `Tone.Volume.volume` is — and wrong when they
 * are not. `Tone.Filter.gain` (the five EQ bands) and `Tone.Limiter.threshold` are both
 * built `convert: false`, verified in Tone's source, so an exponential ramp would
 * interpolate raw signed decibels: `v0 · (v1/v0)^t` is undefined through zero, Web Audio
 * refuses it, and a band moved from −6 dB to +6 dB never arrives. Those pass `'linear'`.
 *
 * **What is deliberately not ramped, so it is not "fixed" later.** `filter.rolloff`,
 * `filter.type`, `chorus.delayTime`, `chorus.depth`, `reverb.dampening` and
 * `WaveShaper.curve` are plain JavaScript setters that rebuild nodes; there is no
 * automation to schedule, and the diff — not a ramp — is what stops them firing.
 * `filter.frequency` and `osc.frequency` have a Signal connected in, so Tone marks them
 * `overridden` and every scheduled value becomes 0: writes there are already dead, and
 * `rampTo` would be exactly as dead.
 */
export function writeParam<T>(
  param: RampableParam<T>,
  value: T,
  mode: WriteMode,
  curve: 'auto' | 'linear' = 'auto',
): void {
  // All three at `immediate()`, not Tone's default `now()` — see `immediate`. The step is
  // written out as cancel + set because that is exactly what Tone's `.value` setter does,
  // only at `now()`: a voice built for a live key would otherwise hold its constructor
  // defaults for the first lookahead of its own note.
  const at = immediate();
  if (mode === 'step') {
    param.cancelScheduledValues(at);
    param.setValueAtTime(value, at);
  } else if (curve === 'linear') {
    param.linearRampTo(value, PARAM_RAMP_SECONDS, at);
  } else {
    param.rampTo(value, PARAM_RAMP_SECONDS, at);
  }
}
