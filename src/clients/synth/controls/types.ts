/**
 * src/clients/synth/controls/types.ts — the one shape every control takes.
 *
 * A control receives its identity, its spec and its value. It receives no range, no step,
 * no unit and no list of legal choices, because all four live on the spec and a component
 * that accepted them separately would be free to disagree with the validator. The mockups
 * are full of literal `min`/`max` attributes; copying one through is precisely how a
 * control ends up producing values the dispatcher rejects.
 *
 * `id` and `path` are both carried and both rendered onto the DOM: `data-sag-id` is the
 * permanent handle a journal row or a terminal query uses, `data-sag-path` is the contract
 * address. Two attributes, no runtime cost, and the difference between an addressable
 * surface and a screenshot.
 */

import type { ControlId } from '../../../core/controls';
import type { ParamSpec } from '../../../core/schemas';
import type { ParamPath, ParamValue } from '../../../core/types';

/**
 * What a control has to be able to say about itself.
 *
 * Note what is NOT here: `unwired`. That is a property of a modulation DESTINATION, not of
 * a control — `effects.delay.wet` is a working knob that no cable can reach, and dimming
 * it would be a decoy pointed the other way. The bay's jacks carry that state; parameters
 * do not.
 */
export type ControlState =
  /** Normal. */
  | 'live'
  /**
   * The patch sets it and the current shape cannot honour it — `width` on a sawtooth. The
   * control works and the value is stored; it simply has nowhere to land right now.
   */
  | 'ignored';

/** Modulation reach at this destination, for the ring. Both halves are 0..1 of the travel. */
export interface ModulationReach {
  up: number;
  down: number;
}

export interface ControlProps {
  id: ControlId;
  path: ParamPath;
  /** Already resolved against the drawn set by `labelWithin` — controls do not name things. */
  label: string;
  spec: ParamSpec;
  value: ParamValue | undefined;
  onChange: (path: ParamPath, value: ParamValue) => void;
  state?: ControlState;
  /** Why it is not live. Shown, not hidden behind a hover a phone does not have. */
  reason?: string;
  modulation?: ModulationReach;
}

/**
 * The attributes that make a control addressable.
 *
 * **Spread onto the element that takes the touch** — the `<input>`, the `<select>`, the
 * `<button>`, the `role="slider"` svg — never onto a wrapper that merely contains it.
 *
 * That distinction is not pedantry, it is the difference between a true measurement and a
 * flattering one. Every control here used to put these on its wrapping `<div>`, whose box
 * includes the label row, so `npm run geometry` reported a Slider as 41px tall when the
 * thing a thumb can actually hit was 22px. An agent reading the surface inherits the same
 * lie: a rect that is bigger than the target is a promise the control cannot keep.
 *
 * Both attributes always travel together — `control-kit.browser.test.ts` asserts they sit
 * on one node, because an id without an address resolves to nothing.
 */
export function sagAttributes(props: Pick<ControlProps, 'id' | 'path'>) {
  return { 'data-sag-id': props.id, 'data-sag-path': props.path } as const;
}
