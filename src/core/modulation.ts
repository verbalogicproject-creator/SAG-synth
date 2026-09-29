/**
 * src/core/modulation.ts — what a patch's routes actually ask of each destination.
 *
 * Web Audio sums every connection into an `AudioParam` and then clamps the result to the
 * parameter's own limits, silently. That is correct behaviour and this file does not try
 * to change it: auto-normalising the depths so a sum always fits would make one route's
 * effect depend on whether a sibling happens to be enabled, which fights determinism
 * rather than serving it. Two routes at 0.8 should ask for more travel than the parameter
 * has. The defect is that nothing says so.
 *
 * So this is visibility, and only visibility. It computes where the enabled routes can
 * drive each destination, in that destination's own unit, and compares it against the
 * declared range. Nothing here touches the signal chain.
 *
 * It has to mirror the runtime's composition rules to be worth anything, and those rules
 * are not uniform — see `reachOf`. `src/tests/tone-runtime.audio.test.ts` carries the gate
 * that the prediction matches a rendered buffer, because arithmetic agreeing with itself
 * is not evidence.
 */

import { FULL_DEPTH_DUCK_DB, FULL_DEPTH_OCTAVES, MODULATION_DESTINATIONS, isPerVoiceSource } from './types';
import type { ModCurve, ModDestination, ModRoute, ModSource } from './types';
import { PARAM_SPECS } from './schemas';
import { getParam } from './params';
import type { EngineState } from './state';

/** Float slack, so a route landing exactly on the limit is not reported as past it. */
const SLACK = 1e-9;

export interface DestinationLoad {
  destination: ModDestination;
  /** Enabled routes pointing here, in patch order. Disabled ones contribute nothing. */
  routeIds: readonly string[];
  /** The parameter's resting value — where it sits with every route at zero. */
  base: number;
  /** Where the summed routes can drive it, in the destination's own declared unit. */
  reach: { min: number; max: number };
  /** The declared range. Travel outside this is travel the patch asks for and will not get. */
  limit: { min: number; max: number };
  /** `reach` leaves `limit` in at least one direction. */
  overflows: boolean;
}

/**
 * How far the routes at one destination can push it, given the runtime's own rules.
 *
 * Three rules, and the reason they are not one:
 *
 * - **Polarity is the source's** (KIND §3.1). An LFO swings both ways, so it contributes
 *   `±scale`. Velocity runs 0..1 and only ever adds, so `rewireRoutes` gives it a scaler
 *   of `scale × 2` and it contributes `0..+2·scale`. Same total travel, one direction.
 *
 * - **`octaves` composes by multiplication**, because it lands on a detune input and the
 *   audio node exponentiates it. Two routes at ±2 octaves reach ±4, which is `base × 16`
 *   at the top — not `base + 2 × something`.
 *
 * - **`duckDb` re-centres, and the last enabled route wins that centre.** This mirrors
 *   `rewireRoutes` writing `nodes.gain.gain.value = swing.baseOverride` once per route:
 *   the assignment overwrites, while the scalers sum. It is why two duck routes overflow
 *   *upward* — the peak ends up above the patch's own amplitude, which is precisely what
 *   the one-directional duck exists to prevent, and exactly the kind of thing that needs
 *   pointing at rather than reasoning about.
 */
function reachOf(
  curve: ModCurve,
  base: number,
  limit: { min: number; max: number },
  routes: readonly ModRoute[],
): { min: number; max: number } {
  /** One route's signed contribution, in whatever unit its curve composes in. */
  const scaleOf = (route: ModRoute): number => {
    if (curve === 'duckDb') {
      const trough = base * Math.pow(10, (-route.depth * FULL_DEPTH_DUCK_DB) / 20);
      return (base - trough) / 2;
    }
    return curve === 'octaves'
      ? route.depth * FULL_DEPTH_OCTAVES
      : (route.depth * (limit.max - limit.min)) / 2;
  };

  // `rewireRoutes` ASSIGNS `nodes.gain.gain.value = swing.baseOverride` per route, so the
  // last enabled one owns the resting value rather than a combination of them. Only
  // `duckDb` re-centres at all; for the others the centre is the parameter's own value.
  let centre = base;
  if (curve === 'duckDb') {
    for (const route of routes) {
      centre = (base + base * Math.pow(10, (-route.depth * FULL_DEPTH_DUCK_DB) / 20)) / 2;
    }
  }

  // Group by source before summing, and this is not a tidy-up: routes sharing a source
  // share a SIGNAL. `rewireRoutes` builds one scaler per connection and they all read the
  // same generator, so their scales sum before the swing happens — `+d` and `−d` from one
  // LFO cancel exactly, and the destination sits still with two cables plugged into it.
  // Routes on different sources are independent generators whose magnitudes add. Summing
  // everything together would report a cancelling pair as double travel, and summing
  // magnitudes everywhere would report it as double too. Neither is the answer, and the
  // difference only became reachable when depth gained a sign.
  const bySource = new Map<ModSource, number>();
  for (const route of routes) {
    bySource.set(route.source, (bySource.get(route.source) ?? 0) + scaleOf(route));
  }

  let up = 0;
  let down = 0;
  for (const [source, sum] of bySource) {
    if (isPerVoiceSource(source)) {
      // Unipolar (KIND §3.1): velocity and the envelopes run 0..1 and only ever travel one
      // way. Which way is the sign's business, and `rewireRoutes` doubles the scaler to keep
      // the total distance the same as a bipolar source's.
      if (sum >= 0) up += sum * 2;
      else down += -sum * 2;
    } else {
      // Bipolar: the same distance either side of centre, whichever way the sign points.
      up += Math.abs(sum);
      down += Math.abs(sum);
    }
  }

  if (curve === 'octaves') {
    return { min: base * Math.pow(2, -down), max: base * Math.pow(2, up) };
  }
  return { min: centre - down, max: centre + up };
}

/**
 * One entry per destination that at least one enabled route points at, in the KIND's
 * declared order rather than the patch's — so the report reads the same whichever order
 * the routes were added in.
 *
 * A destination whose base value cannot be read is skipped rather than guessed at. That is
 * not a theoretical case: `effects.*` destinations are declared and reachable long before
 * anything wires them, and a load computed against an invented base would be a confident
 * number about nothing.
 */
export function modulationLoad(state: EngineState): DestinationLoad[] {
  const enabled = state.patch.voice.modRoutes.filter((route) => route.enabled);
  if (enabled.length === 0) return [];

  const loads: DestinationLoad[] = [];
  for (const { path } of MODULATION_DESTINATIONS) {
    const routes = enabled.filter((route) => route.destination === path);
    if (routes.length === 0) continue;

    const spec = PARAM_SPECS[path];
    if (spec.kind !== 'number' || spec.modulation === undefined) continue;
    const base = getParam(state, path);
    if (typeof base !== 'number') continue;

    const limit = { min: spec.min, max: spec.max };
    const reach = reachOf(spec.modulation.curve, base, limit, routes);
    loads.push({
      destination: path,
      routeIds: routes.map((route) => route.id),
      base,
      reach,
      limit,
      overflows: reach.min < limit.min - SLACK || reach.max > limit.max + SLACK,
    });
  }
  return loads;
}

function formatValue(value: number, unit: string | undefined): string {
  const magnitude = Math.abs(value);
  const rendered =
    magnitude >= 100 ? String(Math.round(value)) : value.toFixed(magnitude >= 10 ? 1 : 2);
  return unit === undefined ? rendered : `${rendered} ${unit}`;
}

/**
 * One line describing a load, for a control surface to print.
 *
 * Here rather than in a component for the same reason `describeDepth` is: the units and
 * the curve belong to the declaration, and a component that formatted them itself would
 * be the second list `arch/clients.ngf.md` exists to prevent. Callers decide emphasis from
 * `load.overflows`; this stays factual either way.
 */
export function describeLoad(load: DestinationLoad): string {
  const spec = PARAM_SPECS[load.destination];
  const unit = spec.kind === 'number' ? spec.unit : undefined;
  const count = load.routeIds.length === 1 ? '1 route' : `${load.routeIds.length} routes`;
  const reach = `${formatValue(load.reach.min, undefined)}–${formatValue(load.reach.max, unit)}`;
  if (!load.overflows) return `${count} reach ${reach}`;
  const limit = `${formatValue(load.limit.min, undefined)}–${formatValue(load.limit.max, unit)}`;
  return `${count} reach ${reach}, past the declared ${limit} — the travel outside is lost`;
}
