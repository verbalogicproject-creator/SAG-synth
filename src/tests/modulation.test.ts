/**
 * src/tests/modulation.test.ts — the route-overflow indicator.
 *
 * Web Audio clamps a summed `AudioParam` silently, so a patch can ask for travel it will
 * never get and sound merely "less than expected" rather than wrong. `modulationLoad`
 * exists to say so at authoring time.
 *
 * The gates below are as much about what it must NOT flag. An indicator that lights on
 * every patch with a route is worth less than none, because it trains you to ignore it —
 * so every overflow case here is paired with one that has to stay quiet.
 */

import { describe, expect, it } from 'vitest';
import { describeLoad, modulationLoad } from '../core/modulation';
import { PARAM_SPECS } from '../core/schemas';
import { defaultPreset, defaultSong, initialEngineState } from '../core/state';
import type { EngineState } from '../core/state';
import type { ModRoute } from '../core/types';

function route(partial: Partial<ModRoute> & Pick<ModRoute, 'destination'>): ModRoute {
  return {
    id: partial.id ?? `route-${partial.destination}-${partial.depth ?? 0}`,
    enabled: partial.enabled ?? true,
    source: partial.source ?? 'lfo.0',
    depth: partial.depth ?? 0.5,
    destination: partial.destination,
  };
}

/** A state carrying exactly these routes and otherwise the factory patch. */
function stateWith(routes: readonly ModRoute[], mutate?: (state: EngineState) => void): EngineState {
  const base = initialEngineState();
  const state: EngineState = {
    ...base,
    patch: { ...defaultPreset(), voice: { ...defaultPreset().voice, modRoutes: [...routes] } },
    song: defaultSong(),
  };
  mutate?.(state);
  return state;
}

describe('modulationLoad — what the routes ask of each destination', () => {
  it('reports nothing for a patch with no routes', () => {
    expect(modulationLoad(initialEngineState())).toEqual([]);
  });

  it('ignores disabled routes entirely — a disabled route asks for nothing', () => {
    const deep = { destination: 'voice.pan', depth: 1 } as const;
    expect(modulationLoad(stateWith([route({ ...deep, enabled: false })]))).toEqual([]);
    expect(modulationLoad(stateWith([route({ ...deep, enabled: true })])).length).toBe(1);
  });

  it('leaves one sensible route unflagged — the case that must stay quiet', () => {
    // The negative half of every gate below. A cutoff sweep of +/-2 octaves from the
    // factory patch's 800 Hz reaches 200 Hz to 3.2 kHz, which is well inside 20..20000
    // and is the single most ordinary thing a player will do with a route.
    const [load] = modulationLoad(
      stateWith([route({ destination: 'voice.filterEnvelope.baseFrequency', depth: 0.5 })]),
    );

    expect(load?.overflows).toBe(false);
    expect(load?.reach.min).toBeCloseTo(200, 6);
    expect(load?.reach.max).toBeCloseTo(3200, 6);
    expect(load?.limit).toEqual({ min: 20, max: 20000 });
  });

  it('flags two deep cutoff routes, which reach past the audible range in both directions', () => {
    const [load] = modulationLoad(
      stateWith([
        route({ id: 'a', destination: 'voice.filterEnvelope.baseFrequency', depth: 1 }),
        route({ id: 'b', destination: 'voice.filterEnvelope.baseFrequency', depth: 1 }),
      ]),
    );

    // +/-8 octaves from 800 Hz: 3.1 Hz to 204.8 kHz. Both ends are past the declaration,
    // and the top is past what the sample rate can represent at all.
    expect(load?.overflows).toBe(true);
    expect(load?.reach.min).toBeCloseTo(800 / 256, 6);
    expect(load?.reach.max).toBeCloseTo(800 * 256, 6);
    expect(load?.routeIds).toEqual(['a', 'b']);
  });

  it('composes octaves by multiplying, not by adding — the whole point of the curve', () => {
    // Two routes at depth 0.25 are +/-1 octave each, so together +/-2 octaves: a factor of
    // four, not a doubling of some Hz offset.
    const [load] = modulationLoad(
      stateWith([
        route({ id: 'a', destination: 'voice.filterEnvelope.baseFrequency', depth: 0.25 }),
        route({ id: 'b', destination: 'voice.filterEnvelope.baseFrequency', depth: 0.25 }),
      ]),
    );

    expect(load?.reach.max / load?.base).toBeCloseTo(4, 6);
    expect(load?.base / load?.reach.min).toBeCloseTo(4, 6);
  });

  it('lets a linear route sit exactly on the limit without calling it overflow', () => {
    // pan is -1..1 and rests at 0, so depth 1.0 swings exactly to both ends. Reporting
    // that as overflow would flag the one case that uses the declared range precisely.
    const [load] = modulationLoad(stateWith([route({ destination: 'voice.pan', depth: 1 })]));

    expect(load?.reach).toEqual({ min: -1, max: 1 });
    expect(load?.overflows).toBe(false);
  });

  it('flags two linear routes that together pass it', () => {
    const [load] = modulationLoad(
      stateWith([
        route({ id: 'a', destination: 'voice.pan', depth: 0.8 }),
        route({ id: 'b', destination: 'voice.pan', depth: 0.8 }),
      ]),
    );

    expect(load?.reach).toEqual({ min: -1.6, max: 1.6 });
    expect(load?.overflows).toBe(true);
  });

  it('treats velocity as unipolar — it adds, so the reach is asymmetric', () => {
    // Polarity belongs to the source (KIND §3.1). A velocity route never takes the
    // parameter below its resting value, and modelling it as bipolar would report a
    // downward overflow that cannot happen.
    const [load] = modulationLoad(
      stateWith([route({ destination: 'voice.pan', depth: 0.5, source: 'velocity' })]),
    );

    expect(load?.reach.min).toBe(0);
    expect(load?.reach.max).toBeCloseTo(1, 6);
    expect(load?.overflows).toBe(false);
  });

  it('does not flag a single amplitude duck — it only ever attenuates', () => {
    const [load] = modulationLoad(stateWith([route({ destination: 'voice.amplitude', depth: 0.5 })]));

    expect(load?.reach.max).toBeCloseTo(1, 6);
    expect(load?.overflows).toBe(false);
  });

  it('flags two amplitude ducks, which the runtime composes into a peak above full scale', () => {
    // The finding this indicator surfaced. `rewireRoutes` assigns the re-centred resting
    // gain once per route, so the LAST duck route wins the centre while every scaler still
    // sums — and the peak ends up ABOVE the patch's own amplitude, which is exactly what a
    // one-directional duck exists to prevent. Not arithmetic about a hypothetical: the
    // audio gate in tone-runtime.audio.test.ts renders it.
    const [load] = modulationLoad(
      stateWith([
        route({ id: 'a', destination: 'voice.amplitude', depth: 0.5 }),
        route({ id: 'b', destination: 'voice.amplitude', depth: 0.5 }),
      ]),
    );

    expect(load?.reach.max).toBeGreaterThan(1);
    expect(load?.overflows).toBe(true);
  });

  it('reports one entry per destination, in the KIND order rather than the patch order', () => {
    // Two routes at one destination are one load; two destinations are two. Declared order
    // so the report does not reshuffle itself when a route is added.
    const loads = modulationLoad(
      stateWith([
        route({ id: 'a', destination: 'voice.pan', depth: 0.2 }),
        route({ id: 'b', destination: 'voice.filterEnvelope.baseFrequency', depth: 0.2 }),
        route({ id: 'c', destination: 'voice.pan', depth: 0.2 }),
      ]),
    );

    expect(loads.map((load) => load.destination)).toEqual([
      'voice.filterEnvelope.baseFrequency',
      'voice.pan',
    ]);
    expect(loads[1]?.routeIds).toEqual(['a', 'c']);
  });

  it('never reports a reach the parameter could not hold at zero depth', () => {
    // Depth 0 must be a fixed point on every curve: the parameter does not move, so the
    // reach is the base and nothing is flagged.
    for (const { path } of [
      { path: 'voice.pan' },
      { path: 'voice.filterEnvelope.baseFrequency' },
      { path: 'voice.amplitude' },
    ] as const) {
      const [load] = modulationLoad(stateWith([route({ destination: path, depth: 0 })]));
      expect(load?.reach.min, `${path} moves at depth 0`).toBeCloseTo(load?.base ?? NaN, 9);
      expect(load?.reach.max, `${path} moves at depth 0`).toBeCloseTo(load?.base ?? NaN, 9);
      expect(load?.overflows, `${path} overflows at depth 0`).toBe(false);
    }
  });

  it('flags a destination that RESTS on its own boundary, at any depth at all', () => {
    // Found by the breadth check below rather than reasoned out, and it is a real finding
    // rather than a quirk of the indicator. `effects.distortion.wet` ships at 1.0, the top
    // of its 0..1 range, so a bipolar route there spends half its travel above full wet
    // where nothing can happen — at depth 0.01 as much as at 1.0. It is the same shape of
    // problem `voice.amplitude` has, and `duckDb` is the answer to it; distortion wet has
    // no such curve, so the honest outcome is that the indicator says so.
    const [load] = modulationLoad(
      stateWith([route({ destination: 'effects.distortion.wet', depth: 0.01 })]),
    );

    expect(load?.base).toBe(1);
    expect(load?.overflows).toBe(true);
  });

  it('flags nothing else at a shallow depth, across every declared destination', () => {
    // Breadth rather than depth, and it is the anti-noise gate: one shallow route at each
    // of the nineteen destinations, and the ONLY ones allowed to light up are the two whose
    // resting value is already at an end of their own range. Also catches a curve added to
    // the KIND that `reachOf` has no case for, long before a patch happens to use it.
    for (const [path, spec] of Object.entries(PARAM_SPECS)) {
      if (spec.kind !== 'number' || spec.modulation === undefined) continue;
      const loads = modulationLoad(stateWith([route({ destination: path as never, depth: 0.01 })]));
      // A destination whose base cannot be read yields no load at all — skipped, not guessed.
      for (const load of loads) {
        expect(
          Number.isFinite(load.reach.min) && Number.isFinite(load.reach.max),
          `"${path}" has no finite reach — is its curve handled?`,
        ).toBe(true);
        const restsOnBoundary = load.base === load.limit.min || load.base === load.limit.max;
        if (!restsOnBoundary) {
          expect(load.overflows, `"${path}" overflows at depth 0.01 with room to spare`).toBe(false);
        }
      }
    }
  });
});

describe('describeLoad — the line a control surface prints', () => {
  it('names the reach in the destination unit, without the limit when it fits', () => {
    const [load] = modulationLoad(
      stateWith([route({ destination: 'voice.filterEnvelope.baseFrequency', depth: 0.5 })]),
    );

    expect(describeLoad(load!)).toBe('1 route reach 200–3200 Hz');
  });

  it('names the limit and what is lost when it does not', () => {
    const [load] = modulationLoad(
      stateWith([
        route({ id: 'a', destination: 'voice.pan', depth: 0.8 }),
        route({ id: 'b', destination: 'voice.pan', depth: 0.8 }),
      ]),
    );

    expect(describeLoad(load!)).toBe(
      '2 routes reach -1.60–1.60, past the declared -1.00–1.00 — the travel outside is lost',
    );
  });
});
