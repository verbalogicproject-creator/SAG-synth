/**
 * src/clients/synth/controlProps.ts — one address, everything a control needs to draw it.
 *
 * The join every panel would otherwise perform by hand: the registry for identity and the
 * name, `PARAM_SPECS` for the value space, the patch for the value, `ignoredIn` for
 * whether the shape can honour it, and `modulationLoad` for how far the routes can push
 * it. Five sources, one call, so a panel decides layout and nothing else.
 *
 * A panel that assembled these itself would be free to skip one — and the one it would
 * skip is the ignored state, because a control looks finished without it.
 */

import { controlForPath, labelWithin } from '../../core/controls';
import { ignoredIn } from '../../core/ignored';
import { modulationLoad } from '../../core/modulation';
import { toTrack, toTrackUnclamped } from '../../core/scale';
import { PARAM_SPECS } from '../../core/schemas';
import { getParam } from '../../core/params';
import type { EngineState } from '../../core/state';
import type { ParamPath, ParamValue } from '../../core/types';
import type { ControlProps, ModulationReach } from './controls';

export type ChangeHandler = (path: ParamPath, value: ParamValue) => void;

/**
 * Everything the surface needs about the current patch, computed once per render rather
 * than once per control. `ignoredIn` and `modulationLoad` both walk the whole patch, and
 * calling them 119 times would be quadratic for no gain.
 */
export interface SurfaceContext {
  state: EngineState;
  ignored: Map<string, string>;
  reach: Map<string, ModulationReach>;
  onChange: ChangeHandler;
}

export function surfaceContext(state: EngineState, onChange: ChangeHandler): SurfaceContext {
  const ignored = new Map(ignoredIn(state.patch).map((note) => [note.path as string, note.reason]));

  const reach = new Map<string, ModulationReach>();
  for (const load of modulationLoad(state)) {
    const spec = PARAM_SPECS[load.destination];
    if (spec.kind !== 'number') continue;

    // Unclamped on purpose: a ring that stops at the end of the travel cannot show that
    // the routes ask for more than the parameter has, which is the one thing it is for.
    const base = toTrack(load.base, spec);
    reach.set(load.destination, {
      up: Math.max(toTrackUnclamped(load.reach.max, spec) - base, 0),
      down: Math.max(base - toTrackUnclamped(load.reach.min, spec), 0),
    });
  }

  return { state, ignored, reach, onChange };
}

/**
 * @param within the addresses drawn alongside this one, which decides how short its name
 * can be. Passing the wrong set produces a name that is merely long, never a wrong one.
 */
export function propsFor(
  context: SurfaceContext,
  path: ParamPath,
  within: readonly ParamPath[],
): ControlProps {
  const control = controlForPath(path);
  if (control === undefined) {
    // Every declared address has a control — `controls.test.ts` gates it in both
    // directions — so this is a caller passing something that is not an address.
    throw new Error(`propsFor: "${path}" is not a declared parameter.`);
  }

  const reason = context.ignored.get(path);

  return {
    id: control.id,
    path,
    label: labelWithin(path, within),
    spec: PARAM_SPECS[path],
    value: getParam(context.state, path),
    onChange: context.onChange,
    state: reason === undefined ? 'live' : 'ignored',
    reason,
    modulation: context.reach.get(path),
  };
}
