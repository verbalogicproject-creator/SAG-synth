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
import type { LFOConfig, ParamPath, ParamValue } from '../core/types';

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
    target: 'filterFrequency',
    type: 'sine',
    frequency: 2,
    min: 0,
    max: 1,
    sync: false,
    retrigger: false,
  };
}

/** LFO paths address slots that may be empty; fill them so every path is reachable. */
function stateWithLfos(): EngineState {
  let state = initialEngineState();
  for (let i = 0; i < 4; i += 1) {
    const result = reduce(state, { type: 'addLfo', config: lfoConfig(i) }, meta);
    if (result.status !== 'applied') throw new Error(`addLfo ${i}: ${result.error}`);
    state = result.state;
  }
  return state;
}

describe('getParam agrees with setParam', () => {
  it('covers every declared path — no path is silently unreachable', () => {
    // Guards the loop below against shrinking to nothing if PARAM_PATHS is restructured.
    expect(PARAM_PATHS.length).toBe(70);
  });

  it('reads back exactly what was written, for all 70 paths', () => {
    const base = stateWithLfos();
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
    const state = stateWithLfos();
    const before = structuredClone(state);
    for (const path of PARAM_PATHS) getParam(state, path as ParamPath);
    expect(state).toEqual(before);
  });
});
