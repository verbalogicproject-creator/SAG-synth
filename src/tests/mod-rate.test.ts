/**
 * src/tests/mod-rate.test.ts — the FILTER tab's MOD RATE, as a reading and as commands.
 *
 * Every command list is applied through the real reducer, so a list the reducer would
 * refuse fails here rather than on the phone.
 */

import { describe, expect, it } from 'vitest';
import { MOD_RATE_DEPTH, modRateCommands, readModRate, type ModRate } from '../core/mod-rate';
import { reduce } from '../core/reduce';
import { initialEngineState, type EngineState } from '../core/state';
import { MAX_LFOS } from '../core/types';

const meta = { commandId: 'c', ts: 1 };

/** Reduce one command, failing the test on a refusal rather than reading a missing state. */
function must(state: EngineState, command: Parameters<typeof reduce>[1]): EngineState {
  const result = reduce(state, command, meta);
  if (result.status !== 'applied') throw new Error(`${command.type} refused: ${JSON.stringify(result)}`);
  return result.state;
}

function choose(state: EngineState, rate: ModRate, n = 0): EngineState {
  const result = modRateCommands(state.patch, rate, { lfoId: `lfo-mr-${n}`, routeId: `route-mr-${n}` });
  if (!result.ok) throw new Error(result.reason);
  let next = state;
  for (const command of result.commands) {
    const applied = reduce(next, command, meta);
    if (applied.status !== 'applied') throw new Error(`${command.type}: ${JSON.stringify(applied)}`);
    next = applied.state;
  }
  return next;
}

describe('MOD RATE', () => {
  it('reads NOTE on a patch with no locked LFO on the cutoff', () => {
    expect(readModRate(initialEngineState().patch)).toEqual({ rate: 'note' });
  });

  it('1/16 adds one LFO locked at 16n and one falling route into the cutoff', () => {
    const state = choose(initialEngineState(), '16n');
    expect(readModRate(state.patch).rate).toBe('16n');
    expect(state.patch.voice.lfos).toHaveLength(1);
    expect(state.patch.voice.lfos[0]).toMatchObject({ frequency: '16n', sync: true, type: 'sawtooth' });
    expect(state.patch.voice.modRoutes.at(-1)).toMatchObject({
      source: 'lfo.0',
      destination: 'voice.filterEnvelope.baseFrequency',
      depth: MOD_RATE_DEPTH,
      enabled: true,
    });
  });

  it('switching 1/16 → 1/4 retunes the same LFO instead of adding another', () => {
    const state = choose(choose(initialEngineState(), '16n'), '4n', 1);
    expect(readModRate(state.patch).rate).toBe('4n');
    expect(state.patch.voice.lfos).toHaveLength(1);
    expect(state.patch.voice.modRoutes).toHaveLength(1);
  });

  it('NOTE disables the route and keeps its depth for the way back', () => {
    let state = choose(initialEngineState(), '8n');
    const index = state.patch.voice.modRoutes.length - 1;
    state = must(state, { type: 'setParam', path: `voice.modRoutes.${index}.depth`, value: -0.7 } as never);
    state = choose(state, 'note', 1);
    expect(readModRate(state.patch).rate).toBe('note');
    expect(state.patch.voice.modRoutes[index]).toMatchObject({ enabled: false, depth: -0.7 });

    state = choose(state, '8n', 2);
    expect(readModRate(state.patch).rate).toBe('8n');
    expect(state.patch.voice.modRoutes[index]).toMatchObject({ enabled: true, depth: -0.7 });
    expect(state.patch.voice.lfos).toHaveLength(1);
  });

  it('NOTE on a patch that is already NOTE is no commands at all', () => {
    const result = modRateCommands(initialEngineState().patch, 'note', { lfoId: 'a', routeId: 'b' });
    expect(result).toEqual({ ok: true, commands: [] });
  });

  it('recognises a patch built by hand, from any LFO slot', () => {
    let state = initialEngineState();
    for (let i = 0; i < 2; i += 1) {
      state = must(state, { type: 'addLfo', config: { id: `l${i}`, enabled: true, type: 'sine', frequency: 3, sync: false, retrigger: false } });
    }
    state = must(state, { type: 'setParam', path: 'voice.lfos.1.frequency', value: '8n' } as never);
    state = must(state, {
        type: 'addRoute',
        route: { id: 'r', enabled: true, source: 'lfo.1', destination: 'voice.filterEnvelope.baseFrequency', depth: 0.2 },
      });
    expect(readModRate(state.patch)).toEqual({ rate: '8n', binding: { routeIndex: 0, lfoIndex: 1 } });
  });

  it('refuses with a reason when every LFO slot is taken, instead of half-applying', () => {
    let state = initialEngineState();
    for (let i = 0; i < MAX_LFOS; i += 1) {
      state = must(state, { type: 'addLfo', config: { id: `l${i}`, enabled: true, type: 'sine', frequency: 3, sync: false, retrigger: false } });
    }
    const result = modRateCommands(state.patch, '16n', { lfoId: 'x', routeId: 'y' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('LFO');
  });
});
