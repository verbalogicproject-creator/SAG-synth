/**
 * src/tests/params.test.ts — get and set must agree on every declared path.
 *
 * `getParam` duplicates routing knowledge that already lives in the reducer: which paths
 * hang off the song and which off the patch. Duplicated knowledge drifts, and this
 * particular drift is close to invisible — a control would read `undefined`, render as
 * empty or zero, and only look wrong once something else moved the same value.
 *
 * So rather than trusting the two implementations to stay aligned, this walks every one
 * of the 70 declared paths and proves a write is visible to a read.
 */

import { describe, expect, it } from 'vitest';
import { describeDepth } from '../core/params';
import { MODULATION_DESTINATIONS } from '../core/types';
import {
  FILTER_ROLLOFFS,
  PARAM_PATHS,
  PARAM_SPECS,
  validateCommand,
  type ParamSpec,
} from '../core/schemas';
import { getParam } from '../core/params';
import { reduce } from '../core/reduce';
import { initialEngineState, type EngineState } from '../core/state';
import { setParam } from '../core/commands';
import {
  MAX_LFOS,
  MAX_OSCILLATORS,
  MAX_ROUTES,
  type LFOConfig,
  type ModRoute,
  type ParamPath,
  type ParamValue,
} from '../core/types';

const meta = { commandId: 'c', ts: 1_700_000_000_000 };

/** A legal, non-default value for a spec, so a passing test cannot be a coincidence. */
function probeValue(spec: ParamSpec): ParamValue {
  switch (spec.kind) {
    case 'number':
      // Land inside the range but off both ends, and integral when required.
      return spec.integer === true
        ? Math.round((spec.min + spec.max) / 2)
        : spec.min + (spec.max - spec.min) * 0.3;
    case 'boolean':
      return true;
    case 'enum':
      return spec.values[spec.values.length - 1]!;
    case 'frequency':
      return 3;
  }
}

function lfoConfig(index: number): LFOConfig {
  return {
    id: `lfo-${index}`,
    enabled: false,
    type: 'sine',
    frequency: 2,
    sync: false,
    retrigger: false,
  };
}

function routeConfig(index: number): ModRoute {
  return {
    id: `route-${index}`,
    enabled: false,
    // Slot 0 always has an LFO by the time routes are added, and the reducer rejects a
    // route whose source slot is empty.
    source: 'lfo.0',
    destination: 'voice.filterEnvelope.baseFrequency',
    depth: 0.5,
  };
}

/**
 * LFO and route paths address slots that may be empty; fill them so every path is
 * reachable. Order matters — `addRoute` rejects a source naming an empty LFO slot.
 */
function oscConfig(index: number) {
  return {
    id: `osc-${index}`,
    enabled: true,
    type: 'sawtooth' as const,
    octave: 0,
    detune: 0,
    count: 1,
    spread: 20,
    width: 0,
    level: 1,
    pan: 0,
  };
}

function stateWithSlotsFilled(): EngineState {
  let state = initialEngineState();
  // The factory patch ships with slot 0 filled, so only the remainder are added — unlike
  // LFOs and routes, which ship empty. A voice must always have at least one slot.
  for (let i = state.patch.voice.oscillators.length; i < MAX_OSCILLATORS; i += 1) {
    const result = reduce(state, { type: 'addOscillator', config: oscConfig(i) }, meta);
    if (result.status !== 'applied') throw new Error(`addOscillator ${i}: ${result.error}`);
    state = result.state;
  }
  for (let i = 0; i < MAX_LFOS; i += 1) {
    const result = reduce(state, { type: 'addLfo', config: lfoConfig(i) }, meta);
    if (result.status !== 'applied') throw new Error(`addLfo ${i}: ${result.error}`);
    state = result.state;
  }
  for (let i = 0; i < MAX_ROUTES; i += 1) {
    const result = reduce(state, { type: 'addRoute', route: routeConfig(i) }, meta);
    if (result.status !== 'applied') throw new Error(`addRoute ${i}: ${result.error}`);
    state = result.state;
  }
  return state;
}

describe('getParam agrees with setParam', () => {
  it('covers every declared path — no path is silently unreachable', () => {
    // Guards the loop below against shrinking to nothing if PARAM_PATHS is restructured.
    expect(PARAM_PATHS.length).toBe(119);
  });

  it('reads back exactly what was written, for every declared path', () => {
    const base = stateWithSlotsFilled();
    const failures: string[] = [];

    for (const path of PARAM_PATHS) {
      const value = probeValue(PARAM_SPECS[path]);
      const result = reduce(base, setParam(path as ParamPath, value as never), meta);
      if (result.status !== 'applied') {
        failures.push(`${path}: rejected — ${result.error}`);
        continue;
      }
      const read = getParam(result.state, path as ParamPath);
      if (read !== value) failures.push(`${path}: wrote ${String(value)}, read ${String(read)}`);
    }

    expect(failures).toEqual([]);
  });

  it('routes master paths to the song, not the patch', () => {
    // The one asymmetry in the routing, and the one a naive reader gets wrong: every
    // master control would read undefined while writing correctly.
    const result = reduce(initialEngineState(), setParam('master.volume', -18), meta);
    if (result.status !== 'applied') throw new Error(result.error);

    expect(result.state.song.master.volume).toBe(-18);
    expect(getParam(result.state, 'master.volume')).toBe(-18);
  });

  it('returns undefined for an LFO slot that has not been added', () => {
    // A declared path with no data behind it. The path union is fixed at MAX_LFOS while
    // the array is not, so this is a real answer rather than an error.
    expect(getParam(initialEngineState(), 'voice.lfos.2.frequency')).toBeUndefined();
  });

  it('rejects a rolloff that is in range but not a legal slope', () => {
    // FilterRolloff is the union -12 | -24 | -48 | -96, but the spec declared a plain
    // range, so -50 validated cleanly — the type system called it impossible while the
    // runtime called it fine. Anything arriving from outside TypeScript (the v0.2 SDK,
    // imported JSON, a slider) could hand the audio graph a slope it has no behaviour
    // for. `choices` closes that; the range is now documentation.
    const illegal = validateCommand({
      type: 'setParam',
      path: 'voice.filter.rolloff',
      value: -50,
    });
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) expect(illegal.error).toContain('-12, -24, -48, -96');

    for (const slope of FILTER_ROLLOFFS) {
      const legal = validateCommand({
        type: 'setParam',
        path: 'voice.filter.rolloff',
        value: slope,
      });
      expect(legal.ok, `rolloff ${slope} should be legal`).toBe(true);
    }
  });

  it('still rejects an out-of-range value before it checks the choices', () => {
    // Two different failures with two different messages; the nearer problem should be
    // named first or the error sends a caller looking in the wrong place.
    const result = validateCommand({
      type: 'setParam',
      path: 'voice.filter.rolloff',
      value: -500,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('out of range');
  });

  it('does not mutate the state it reads', () => {
    const state = stateWithSlotsFilled();
    const before = structuredClone(state);
    for (const path of PARAM_PATHS) getParam(state, path as ParamPath);
    expect(state).toEqual(before);
  });
});

/**
 * `describeDepth` is what stands between the designed control surface and a `switch`
 * over curve names living in a component. These gates are about the CONTRACT it offers
 * that UI, not about the exact wording: it answers for every declared destination,
 * refuses to answer for anything else, and the answer moves with the depth.
 */
describe('describeDepth — what a normalised depth means where it points', () => {
  it('answers for every declared destination and for nothing else', () => {
    for (const { path } of MODULATION_DESTINATIONS) {
      expect(describeDepth(path, 0.5), `no depth label for "${path}"`).toBeDefined();
    }
    // The negative half. `voice.polyphony` is a real, well-formed parameter address that
    // is deliberately not a destination — the same probe F71 uses at the validator.
    expect(PARAM_PATHS).toContain('voice.polyphony');
    expect(describeDepth('voice.polyphony', 0.5)).toBeUndefined();
    expect(describeDepth('voice.filter.type', 0.5)).toBeUndefined();
  });

  it('reads a cutoff depth in octaves, because that is the declared curve', () => {
    // The whole point of Stage 3.5 in one assertion: this used to be ±4995 Hz.
    expect(describeDepth('voice.filterEnvelope.baseFrequency', 0.5)).toBe('±2.00 oct');
    expect(describeDepth('voice.filterEnvelope.baseFrequency', 1)).toBe('±4.00 oct');
  });

  it('reads an amplitude depth as a one-directional duck, not a swing', () => {
    // `−`, not `±`: the base value is the ceiling. A `±` here would describe a tremolo
    // that gets louder than the patch, which is the mapping this curve replaced.
    expect(describeDepth('voice.amplitude', 0.5)).toBe('−30 dB');
  });

  it('reads a linear depth in the destination unit, halved for a bipolar source', () => {
    expect(describeDepth('voice.oscillators.0.detune', 0.5)).toBe('±600 cents');
    expect(describeDepth('voice.pan', 0.5)).toBe('±0.50');
  });

  it('moves with the depth on every curve — a constant label would pass everything above', () => {
    for (const { path } of MODULATION_DESTINATIONS) {
      expect(describeDepth(path, 0.25), `"${path}" ignores its depth`).not.toBe(
        describeDepth(path, 0.75),
      );
    }
  });

  it('says zero depth is zero travel, whatever the curve', () => {
    for (const { path } of MODULATION_DESTINATIONS) {
      expect(describeDepth(path, 0), `"${path}" claims travel at depth 0`).toMatch(/^[±−]0(\.0+)?( \S+)?$/);
    }
  });
});
