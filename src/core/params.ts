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

import type { ParamPath, ParamValue } from './types';
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
