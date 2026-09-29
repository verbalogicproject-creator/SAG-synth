/**
 * src/core/mod-rate.ts — the FILTER tab's MOD RATE: NOTE | 1/16 | 1/8 | 1/4 (cycle 2, C3).
 *
 * Eyal asked for a filter modulation rate "per note, 1/16, 1/8, 1/4". It is sugar over
 * primitives, not a new mechanism:
 *
 * - NOTE is the filter envelope itself — it runs once per note, whatever the tempo.
 * - 1/x is ONE LFO locked to the transport at that note length, routed to the cutoff.
 *
 * So the selector is a reading of the patch (`readModRate`) and a list of ordinary commands
 * (`modRateCommands`): `addLfo`, `addRoute`, `setParam`. The journal records primitives, an
 * agent or a MIDI map can reach the same state without knowing the selector exists, and a
 * patch built by hand that happens to match is recognised as the selector's own.
 *
 * Pure (D2) so the decisions — which route is "the" mod-rate route, what switching does,
 * what it refuses — are runner tests.
 */

import type { SynthCommand } from './commands';
import {
  MAX_LFOS,
  MAX_ROUTES,
  lfoSlotOf,
  type LFOConfig,
  type ModRoute,
  type ParamPath,
  type SynthPreset,
} from './types';

export const MOD_RATES = ['note', '16n', '8n', '4n'] as const;
export type ModRate = (typeof MOD_RATES)[number];

export const MOD_RATE_DESTINATION = 'voice.filterEnvelope.baseFrequency' as const;

/**
 * The LFO a new mod-rate starts with: a sawtooth, falling (the route's depth is negative),
 * so every step opens the filter and lets it close — the psytrance per-16th pluck. The
 * runtime starts a locked sawtooth's ramp ON the step (see `lfoPhase`), or the jump would
 * land half a step late.
 */
export const MOD_RATE_SHAPE = 'sawtooth' as const;
/** −0.3 of the octaves curve: the cutoff falls through about 1.2 octaves per step. */
export const MOD_RATE_DEPTH = -0.3;

export interface ModRateReading {
  rate: ModRate;
  /** The route and LFO the selector drives, when the patch has them. */
  binding?: { routeIndex: number; lfoIndex: number };
}

const isRate = (value: unknown): value is Exclude<ModRate, 'note'> =>
  typeof value === 'string' && (MOD_RATES as readonly string[]).includes(value) && value !== 'note';

/**
 * The first route into the cutoff from an LFO locked at 1/4, 1/8 or 1/16. Its enabled
 * state IS the selector: disabled reads NOTE, and keeps its depth for the way back.
 */
export function readModRate(patch: SynthPreset): ModRateReading {
  const { modRoutes, lfos } = patch.voice;
  for (const [routeIndex, route] of modRoutes.entries()) {
    if (route.destination !== MOD_RATE_DESTINATION) continue;
    const lfoIndex = lfoSlotOf(route.source);
    if (lfoIndex === null) continue;
    const lfo = lfos[lfoIndex];
    if (lfo === undefined || !isRate(lfo.frequency)) continue;
    return { rate: route.enabled && lfo.enabled ? lfo.frequency : 'note', binding: { routeIndex, lfoIndex } };
  }
  return { rate: 'note' };
}

export type ModRateResult = { ok: true; commands: SynthCommand[] } | { ok: false; reason: string };

/**
 * The commands that make the patch read `rate`. `ids` are minted by the caller — core must
 * not generate an id (it would differ on replay).
 */
export function modRateCommands(
  patch: SynthPreset,
  rate: ModRate,
  ids: { lfoId: string; routeId: string },
): ModRateResult {
  const reading = readModRate(patch);
  const set = (path: string, value: unknown): SynthCommand =>
    ({ type: 'setParam', path: path as ParamPath, value }) as SynthCommand;

  if (reading.binding !== undefined) {
    const { routeIndex, lfoIndex } = reading.binding;
    const route = patch.voice.modRoutes[routeIndex]!;
    const lfo = patch.voice.lfos[lfoIndex]!;
    const commands: SynthCommand[] = [];
    if (rate === 'note') {
      if (route.enabled) commands.push(set(`voice.modRoutes.${routeIndex}.enabled`, false));
      return { ok: true, commands };
    }
    if (lfo.frequency !== rate) commands.push(set(`voice.lfos.${lfoIndex}.frequency`, rate));
    if (!lfo.enabled) commands.push(set(`voice.lfos.${lfoIndex}.enabled`, true));
    if (!route.enabled) commands.push(set(`voice.modRoutes.${routeIndex}.enabled`, true));
    return { ok: true, commands };
  }

  if (rate === 'note') return { ok: true, commands: [] };
  // Refused with the reason rather than half-applied: an LFO added with no free route slot
  // would run and move nothing.
  if (patch.voice.lfos.length >= MAX_LFOS) {
    return { ok: false, reason: `all ${MAX_LFOS} LFOs are in use — free one on the LFO tab` };
  }
  if (patch.voice.modRoutes.length >= MAX_ROUTES) {
    return { ok: false, reason: `all ${MAX_ROUTES} routes are in use — free one in ROUTING` };
  }
  const lfo: LFOConfig = { id: ids.lfoId, enabled: true, type: MOD_RATE_SHAPE, frequency: rate, sync: true, retrigger: false };
  const route: ModRoute = {
    id: ids.routeId,
    enabled: true,
    source: `lfo.${patch.voice.lfos.length}` as ModRoute['source'],
    destination: MOD_RATE_DESTINATION,
    depth: MOD_RATE_DEPTH,
  };
  return { ok: true, commands: [{ type: 'addLfo', config: lfo }, { type: 'addRoute', route }] };
}
