/**
 * src/core/params.ts — reading a parameter by path.
 *
 * `setParam` has existed since the frozen contract; this is its missing half. A control
 * surface has to show what a knob is currently set to, and the v0.2 SDK has to be able
 * to ask before it decides — both need the same reader, so it belongs in core rather
 * than in whichever client needed it first.
 *
 * The routing here MUST mirror `reduce.ts`'s `setParam` case exactly: `master.*` lives
 * on the song, `effects.*` and `voice.*` on the patch. Get and set disagreeing would be
 * invisible in normal use and show up as a control that snaps back to a stale value the
 * moment anything else touches it. `src/tests/params.test.ts` walks all 70 declared
 * paths and proves a set is always visible to a get, which is what actually holds the
 * two in agreement — not this comment.
 */

import { FULL_DEPTH_DUCK_DB, FULL_DEPTH_OCTAVES } from './types';
import type { ParamPath, ParamValue, SignedUnit } from './types';
import { PARAM_SPECS } from './schemas';
import type { EngineState } from './state';

/** Walk a dotted path, tolerating array indices. Undefined for anything absent. */
function deepGet(target: unknown, keys: readonly string[]): unknown {
  let current: unknown = target;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      current = (current as unknown[])[Number(key)];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * The live value at `path`, or `undefined` when the slot is genuinely empty.
 *
 * `undefined` is a real answer, not a failure: `voice.lfos.2.frequency` is a declared
 * path whether or not a third LFO has been added, because the path union is fixed at
 * MAX_LFOS while the array is not. A caller should render that as "no LFO here" rather
 * than as an error.
 */
export function getParam(state: EngineState, path: ParamPath): ParamValue | undefined {
  const segments = path.split('.');
  const [root, ...rest] = segments as [string, ...string[]];

  // Master lives on the SONG, not the patch — mirroring reduce.ts. Reading it off the
  // patch would silently return undefined for every master control.
  if (root === 'master') return deepGet(state.song.master, rest) as ParamValue | undefined;
  return deepGet(state.patch, segments) as ParamValue | undefined;
}

/**
 * What a route's `depth` actually means at its destination, as a label.
 *
 * A depth is normalised −1..1 and that number is not the thing a player is choosing —
 * `0.5` is 2 octaves of cutoff, a 30 dB tremolo, or 7.5 of resonance, depending entirely
 * on where the route points. A slider showing "0.50" is showing the storage format rather
 * than the parameter.
 *
 * This lives in core, and it is derived from the destination's declared curve, for the
 * same reason every other control is generated from `PARAM_SPECS`: the alternative is a
 * `switch` in the UI that has to be edited whenever the KIND gains a curve, which is
 * precisely the second list `arch/clients.ngf.md` forbids. Returns `undefined` for a
 * non-modulatable address, which is the honest answer rather than a guess.
 */
export function describeDepth(destination: ParamPath, depth: SignedUnit): string | undefined {
  const spec = PARAM_SPECS[destination];
  if (spec.kind !== 'number' || spec.modulation === undefined) return undefined;

  const magnitude = Math.abs(depth);
  switch (spec.modulation.curve) {
    case 'octaves':
      return signed(depth, `${(magnitude * FULL_DEPTH_OCTAVES).toFixed(2)} oct`);
    case 'duckDb':
      // The sign here is the OPPOSITE of the depth's, and deliberately: this label says
      // what happens to the parameter, not what is stored. A positive depth ducks — the
      // base is the ceiling — so it reads as a loss. A negative one boosts above the base
      // (KIND §3.3), which is out of `voice.amplitude`'s declared range immediately, and
      // reading it as "+30 dB" is the whole reason it is worth showing.
      return signed(-depth, `${(magnitude * FULL_DEPTH_DUCK_DB).toFixed(0)} dB`);
    case 'linear': {
      const swing = (magnitude * (spec.max - spec.min)) / 2;
      const unit = spec.unit === undefined ? '' : ` ${spec.unit}`;
      return signed(depth, `${swing >= 100 ? Math.round(swing) : swing.toFixed(2)}${unit}`);
    }
  }
}

/**
 * Sign prefix for a depth label. Zero gets none — there is no direction to report, and
 * `−0` is not a state anything can distinguish (KIND F82).
 *
 * `±` used to prefix all three of these, and dropping it is the point rather than a
 * casualty. `±` was describing the SOURCE's polarity — a bipolar LFO does swing both ways
 * — but polarity belongs to the source and sign belongs to the route (KIND §3.1), and a
 * function handed only `(destination, depth)` was never in a position to say which. What
 * it can say honestly is which way this connection pushes, which is also what the design's
 * `+75%` / `−20%` shows.
 */
function signed(value: number, rendered: string): string {
  if (value > 0) return `+${rendered}`;
  if (value < 0) return `−${rendered}`;
  return rendered;
}
