/**
 * src/core/song-params.ts — value spaces for the things that live on the SONG, not the patch.
 *
 * A patch address has a `ParamSpec` in `PARAM_SPECS` and a permanent ctl id, and every
 * control on the surface reads its range from there — `controls.test.ts` gates that no
 * component may state a bound of its own, because a copied literal is how a control comes to
 * emit values the reducer refuses while looking perfectly fine.
 *
 * A channel's fader, its pan and a kick's five fields are NOT patch addresses. They are
 * written with `setTrackParam` and `setTrackKick`, they carry no ctl id (they are not part
 * of the 125), and so they had nowhere to read a range from — which is exactly how the
 * channel sheet and the kick panel ended up stating their own steps in C5c.
 *
 * This is that missing declaration. Bounds come from `LIMITS`, the same source the zod
 * schemas validate against, so a slider cannot ask for something `setTrackKick` would
 * reject. The STEP is declared here rather than in the component, for the same reason the
 * bounds are: it is a property of the parameter, not of the widget drawing it.
 *
 * When C6 gives the kick its real synth and C8 maps controllers, both read this table
 * instead of restating it.
 */

import { LIMITS } from './types';

export interface SongParamSpec {
  min: number;
  max: number;
  /** The smallest move a control should make. */
  step: number;
  unit?: string;
}

/** A channel strip's own controls (`setTrackParam`). */
export const TRACK_PARAM_SPECS = {
  volume: { min: LIMITS.trackVolume.min, max: LIMITS.trackVolume.max, step: 0.5, unit: 'dB' },
  /**
   * Pan has no `LIMITS` entry because it is the one value whose bounds are structural:
   * `Tone.Panner.pan` is -1..1 by construction, and the zod schema states the same.
   */
  pan: { min: -1, max: 1, step: 0.01 },
} as const satisfies Record<string, SongParamSpec>;

/** The kick voice's five fields (`setTrackKick`). C6 adds click, drive, sweep and tail. */
export const KICK_PARAM_SPECS = {
  punch: { min: LIMITS.kickPunch.min, max: LIMITS.kickPunch.max, step: 0.1, unit: 'oct' },
  pitchDecay: { min: LIMITS.kickPitchDecay.min, max: LIMITS.kickPitchDecay.max, step: 0.001, unit: 's' },
  decay: { min: LIMITS.kickDecay.min, max: LIMITS.kickDecay.max, step: 0.01, unit: 's' },
  level: { min: LIMITS.kickLevel.min, max: LIMITS.kickLevel.max, step: 0.5, unit: 'dB' },
} as const satisfies Record<string, SongParamSpec>;

/**
 * The tunings a kick is worth having: the bottom two octaves, where a psy kick lives. The
 * recipe is "the kick in the bass's key", so the list is the keys a bass line uses.
 */
export const KICK_TUNINGS: readonly string[] = [
  'C1',
  'C#1',
  'D1',
  'D#1',
  'E1',
  'F1',
  'F#1',
  'G1',
  'G#1',
  'A1',
  'A#1',
  'B1',
  'C2',
];
