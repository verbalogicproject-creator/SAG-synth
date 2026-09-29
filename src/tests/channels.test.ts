/**
 * src/tests/channels.test.ts — C5a: a patch verb can be aimed at a channel (a song track).
 *
 * The claim under test: `trackId` is CONTEXT. With it, a verb edits that track's
 * `presetSnapshot` through the very same reducer case; without it, nothing changes from
 * before C5. And on the hot path, each synth channel has its own voice pool, so one
 * channel's notes can never steal another's voices.
 *
 * Pure: core + NullRuntime, no browser.
 */

import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../app/dispatcher';
import { NullRuntime } from '../core/runtime-contract';
import { reduce, type ReduceMeta } from '../core/reduce';
import { applyToHistory, initialHistory, type HistoryState } from '../core/history';
import { initialEngineState, type EngineState } from '../core/state';
import { setParam, type SynthCommand } from '../core/commands';
import { validateCommand } from '../core/schemas';
import { resolveChannel, soundFor, stateForChannel, synthChannels } from '../core/channels';
import { getParam } from '../core/params';

const meta = (commandId = 'cmd-1', ts = 1_700_000_000_000): ReduceMeta => ({ commandId, ts });

/**
 * The reducer trusts the dispatcher's validator and deep-sets whatever path it is given, so
 * every command here goes through `validateCommand` first — a made-up path must fail loudly.
 */
function valid(command: SynthCommand): SynthCommand {
  const validation = validateCommand(command);
  if (!validation.ok) throw new Error(`invalid command: ${validation.error}`);
  return command;
}

function apply(state: EngineState, command: SynthCommand, m: ReduceMeta = meta()): EngineState {
  const result = reduce(state, valid(command), m);
  if (result.status !== 'applied') throw new Error(`expected applied, got: ${result.error}`);
  return result.state;
}

function refusal(state: EngineState, command: SynthCommand): string {
  const result = reduce(state, valid(command), meta());
  if (result.status !== 'rejected') throw new Error('expected rejected, got applied');
  return result.error;
}

const KICK = { tune: 'G1', punch: 5, pitchDecay: 0.03, decay: 0.22, level: 0 } as const;

/** track-1 (the default synth track), 'bass' (a second synth channel), 'kick' (a kick channel). */
function threeChannels(): EngineState {
  let state = initialEngineState();
  state = apply(state, { type: 'addTrack', trackId: 'bass', name: 'Bass' });
  state = apply(state, { type: 'addTrack', trackId: 'kick', name: 'Kick' });
  state = apply(state, { type: 'setTrackKick', trackId: 'kick', kick: { ...KICK } });
  return state;
}

const track = (state: EngineState, id: string) => state.song.tracks.find((t) => t.id === id)!;

describe('a patch verb with a trackId edits that channel, and only that channel', () => {
  it('setParam lands in the track snapshot; the live patch and the other channels are untouched', () => {
    const before = threeChannels();
    const after = apply(before, { ...setParam('voice.filter.Q', 3.21), trackId: 'bass' });

    expect(track(after, 'bass').presetSnapshot.voice.filter.Q).toBe(3.21);
    expect(after.patch).toBe(before.patch);
    expect(track(after, 'track-1')).toBe(track(before, 'track-1'));
    expect(track(after, 'kick')).toBe(track(before, 'kick'));
    // An edit keeps the channel's named sound.
    expect(track(after, 'bass').presetId).toBe(track(before, 'bass').presetId);
    expect(after.revision).toBe(before.revision + 1);
  });

  it('without a trackId a verb edits the live patch exactly as before C5', () => {
    const before = threeChannels();
    const after = apply(before, setParam('voice.filter.Q', 3.21));
    expect(after.patch.voice.filter.Q).toBe(3.21);
    expect(after.song).toBe(before.song);
  });

  it('structural verbs route too: addOscillator grows only the channel', () => {
    const before = threeChannels();
    const config = structuredClone(before.patch.voice.oscillators[0]!);
    const after = apply(before, { type: 'addOscillator', config: { ...config, id: 'osc-x' }, trackId: 'bass' });
    const count = (s: EngineState) => track(s, 'bass').presetSnapshot.voice.oscillators.length;
    expect(count(after)).toBe(count(before) + 1);
    expect(after.patch.voice.oscillators).toHaveLength(before.patch.voice.oscillators.length);
  });

  it('loadPreset onto a channel replaces its sound and names it; the live patch stays', () => {
    const before = threeChannels();
    const psy = Object.values(before.presets).find((p) => p.id !== before.patch.id)!;
    const after = apply(before, { type: 'loadPreset', presetId: psy.id, trackId: 'bass' });
    expect(track(after, 'bass').presetSnapshot).toEqual(psy);
    expect(track(after, 'bass').presetId).toBe(psy.id);
    expect(after.patch).toBe(before.patch);
  });

  it('savePreset from a channel stores the channel sound with the bus FX it is heard through', () => {
    let state = threeChannels();
    state = apply(state, { ...setParam('voice.filter.Q', 7.77), trackId: 'bass' });
    state = apply(state, setParam('effects.delay.wet', 0.42));
    const after = apply(state, { type: 'savePreset', name: 'Bass 1', trackId: 'bass' }, meta('cmd-save'));

    const saved = after.presets['cmd-save']!;
    expect(saved.voice.filter.Q).toBe(7.77);
    expect(saved.effects).toEqual(state.patch.effects);
    expect(track(after, 'bass').presetId).toBe('cmd-save');
    expect(after.patch).toBe(state.patch);
  });
});

describe('refusals, each with a reason', () => {
  it('an unknown track', () => {
    expect(refusal(threeChannels(), { ...setParam('voice.polyphony', 4), trackId: 'nope' }))
      .toContain('no track with id "nope"');
  });

  it('a kick channel — it has no synth patch', () => {
    expect(refusal(threeChannels(), { ...setParam('voice.polyphony', 4), trackId: 'kick' }))
      .toContain('kick channel');
  });

  it('a master-bus path aimed at a channel (FX stay shared until C7)', () => {
    const state = threeChannels();
    expect(refusal(state, { ...setParam('effects.delay.wet', 0.42), trackId: 'bass' }))
      .toContain('shared master bus');
    expect(refusal(state, { ...setParam('master.volume', -6), trackId: 'bass' }))
      .toContain('shared master bus');
  });
});

describe('undo', () => {
  it('undoes a channel edit back to the channel sound it replaced', () => {
    let history: HistoryState = { ...initialHistory(), present: threeChannels() };
    const step = (command: SynthCommand) => {
      const result = applyToHistory(history, command, meta());
      if (result.status !== 'applied') throw new Error(result.error);
      history = result.history;
    };
    const original = track(history.present, 'bass').presetSnapshot;
    step({ ...setParam('voice.filter.Q', 5.55), trackId: 'bass' });
    step({ type: 'undo' });
    expect(track(history.present, 'bass').presetSnapshot).toBe(original);
  });
});

describe('channels as the surface sees them', () => {
  it('stateForChannel hands panels the channel sound, with the shared FX', () => {
    let state = threeChannels();
    state = apply(state, { ...setParam('voice.filter.Q', 4.44), trackId: 'bass' });
    state = apply(state, setParam('effects.delay.wet', 0.42));

    const view = stateForChannel(state, 'bass');
    expect(getParam(view, 'voice.filter.Q')).toBe(4.44);
    expect(view.patch.effects).toBe(state.patch.effects);
    // A kick channel, an unknown id, or no selection: the state as it is.
    expect(stateForChannel(state, 'kick')).toBe(state);
    expect(stateForChannel(state, 'nope')).toBe(state);
    expect(stateForChannel(state, null)).toBe(state);
  });

  it('resolveChannel keeps a remembered channel that still exists, else the first synth one', () => {
    const state = threeChannels();
    expect(resolveChannel(state, 'bass')?.id).toBe('bass');
    expect(resolveChannel(state, 'gone')?.id).toBe('track-1');
    expect(resolveChannel(state, null)?.id).toBe('track-1');
    expect(synthChannels(state).map((t) => t.id)).toEqual(['track-1', 'bass']);
  });

  it('soundFor: a synth channel plays its snapshot; no channel plays the live patch', () => {
    const state = threeChannels();
    expect(soundFor(state, 'bass')).toBe(track(state, 'bass').presetSnapshot);
    expect(soundFor(state, undefined)).toBe(state.patch);
  });
});

describe('the wire shape', () => {
  const aimed: SynthCommand[] = [
    { ...setParam('voice.polyphony', 4), trackId: 't1' },
    { type: 'loadPreset', presetId: 'p', trackId: 't1' },
    { type: 'savePreset', name: 'S', trackId: 't1' },
    { type: 'removeOscillator', oscillatorId: 'o', trackId: 't1' },
    { type: 'removeLfo', lfoId: 'l', trackId: 't1' },
    { type: 'removeRoute', routeId: 'r', trackId: 't1' },
    { type: 'noteOn', note: 'C4', velocity: 1, trackId: 't1' },
    { type: 'noteOff', note: 'C4', trackId: 't1' },
  ];

  it.each(aimed.map((command) => [command.type, command] as const))('%s accepts a trackId', (_, command) => {
    expect(validateCommand(command).ok).toBe(true);
  });

  it('refuses a trackId that is not an id', () => {
    expect(validateCommand({ ...setParam('voice.polyphony', 4), trackId: '' } as SynthCommand).ok).toBe(false);
    expect(validateCommand({ type: 'noteOn', note: 'C4', velocity: 1, trackId: 7 } as never).ok).toBe(false);
  });
});

describe('each synth channel has its own voice pool', () => {
  function engine() {
    const runtime = new NullRuntime();
    let ids = 0;
    const dispatcher = new Dispatcher({ runtime, newId: () => `cmd-${ids++}`, now: () => 1 });
    for (const command of [
      { type: 'addTrack', trackId: 'bass', name: 'Bass' },
      { type: 'addTrack', trackId: 'kick', name: 'Kick' },
      { type: 'setTrackKick', trackId: 'kick', kick: { ...KICK } },
    ] as SynthCommand[]) {
      expect(dispatcher.dispatch(command).status).toBe('applied');
    }
    runtime.calls.length = 0;
    return { dispatcher, runtime };
  }

  it("a full channel steals from itself, never from another channel or the live patch", () => {
    const { dispatcher, runtime } = engine();
    dispatcher.dispatch({ ...setParam('voice.polyphony', 1), trackId: 'bass' });

    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 1, trackId: 'track-1' });
    dispatcher.dispatch({ type: 'noteOn', note: 'E4', velocity: 1 });
    dispatcher.dispatch({ type: 'noteOn', note: 'G1', velocity: 1, trackId: 'bass' });
    dispatcher.dispatch({ type: 'noteOn', note: 'A1', velocity: 1, trackId: 'bass' });

    const steals = runtime.calls.filter((call) => call.method === 'steal').map((call) => call.arg);
    expect(steals).toEqual([{ voiceId: 0, trackId: 'bass' }]);

    const transient = dispatcher.getTransient();
    expect(transient.voices.map((v) => v.note)).toEqual(['E4']);
    expect(transient.channels.get('track-1')!.voices.map((v) => v.note)).toEqual(['C4']);
    expect(transient.channels.get('bass')!.voices.map((v) => v.note)).toEqual(['A1']);
    // The sounding set proves the runtime saw three distinct voices, not id collisions.
    expect(runtime.sounding.map((v) => v.note).sort()).toEqual(['A1', 'C4', 'E4']);
  });

  it('polyphony and portamento come from the channel sound, not the live patch', () => {
    const { dispatcher, runtime } = engine();
    dispatcher.dispatch({ ...setParam('voice.portamento', 0.25), trackId: 'bass' });
    dispatcher.dispatch({ type: 'noteOn', note: 'G1', velocity: 1, trackId: 'bass' });
    dispatcher.dispatch({ type: 'noteOn', note: 'G1', velocity: 1 });
    const ons = runtime.calls.filter((call) => call.method === 'noteOn').map((call) => call.arg);
    expect(ons).toEqual([
      { voiceId: 0, note: 'G1', velocity: 1, portamento: 0.25, trackId: 'bass' },
      { voiceId: 0, note: 'G1', velocity: 1, portamento: 0 },
    ]);
  });

  it('a note-off releases the note on its own channel only', () => {
    const { dispatcher, runtime } = engine();
    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 1, trackId: 'bass' });
    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 1 });
    dispatcher.dispatch({ type: 'noteOff', note: 'C4', trackId: 'bass' });
    // Both C4s are voice 0 of their own pool; only the trackId tells the runtime which one.
    expect(runtime.calls.filter((call) => call.method === 'noteOff').map((call) => call.arg))
      .toEqual([{ voiceId: 0, note: 'C4', trackId: 'bass' }]);
    expect(runtime.sounding).toEqual([expect.objectContaining({ note: 'C4' })]);
    expect(dispatcher.getTransient().voices.map((v) => v.note)).toEqual(['C4']);
    expect(dispatcher.getTransient().channels.get('bass')!.voices).toEqual([]);
  });

  it('refuses a note aimed at a kick channel or a missing track, and plays nothing', () => {
    const { dispatcher, runtime } = engine();
    const kick = dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 1, trackId: 'kick' });
    const ghost = dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 1, trackId: 'ghost' });
    expect(kick).toMatchObject({ status: 'rejected' });
    expect(ghost).toMatchObject({ status: 'rejected' });
    expect(runtime.calls.filter((call) => call.method === 'noteOn')).toEqual([]);
  });

  it('panic silences every channel', () => {
    const { dispatcher, runtime } = engine();
    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 1, trackId: 'bass' });
    dispatcher.dispatch({ type: 'noteOn', note: 'E4', velocity: 1, trackId: 'track-1' });
    dispatcher.dispatch({ type: 'noteOn', note: 'G4', velocity: 1 });
    dispatcher.dispatch({ type: 'panic' });
    expect(runtime.sounding).toEqual([]);
    expect(dispatcher.getTransient().channels.size).toBe(0);
  });

  it('getTransient is a copy: mutating it does not reach the engine', () => {
    const { dispatcher } = engine();
    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 1, trackId: 'bass' });
    const copy = dispatcher.getTransient();
    copy.channels.get('bass')!.voices.length = 0;
    copy.channels.clear();
    expect(dispatcher.getTransient().channels.get('bass')!.voices).toHaveLength(1);
  });
});
