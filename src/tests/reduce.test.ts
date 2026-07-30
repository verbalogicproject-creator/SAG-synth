/**
 * src/tests/reduce.test.ts — the reducer, and the first concrete evidence for F59.
 *
 * F59 ("journal-is-truth") is the load-bearing claim of the whole design: replaying
 * accepted commands rebuilds state exactly, which is why the v0.2 SAG-SDK needs no
 * domain change. The replay suite at the bottom is that claim under test.
 */

import { describe, expect, it } from 'vitest';
import { reduce, validateAndReduce, type ReduceMeta } from '../core/reduce';
import { initialEngineState, type EngineState } from '../core/state';
import { setParam, type SynthCommand } from '../core/commands';
import { ToneMidiImport } from '../app/midi';
import demoMidiFixture from '../../fixtures/demo-midi.json';

const meta = (commandId = 'cmd-1', ts = 1_700_000_000_000): ReduceMeta => ({ commandId, ts });

/** Apply a command that is expected to succeed, returning the next state. */
function apply(state: EngineState, command: SynthCommand, m: ReduceMeta = meta()): EngineState {
  const result = reduce(state, command, m);
  if (result.status !== 'applied') throw new Error(`expected applied, got: ${result.error}`);
  return result.state;
}

function expectRejected(state: EngineState, command: SynthCommand): string {
  const result = reduce(state, command, meta());
  if (result.status !== 'rejected') throw new Error('expected rejected, got applied');
  return result.error;
}

describe('purity', () => {
  it('never mutates the state it was given', () => {
    const state = initialEngineState();
    const snapshot = structuredClone(state);
    apply(state, setParam('voice.filterEnvelope.baseFrequency', 440));
    apply(state, { type: 'setTempo', bpm: 200 });
    apply(state, { type: 'addTrack', trackId: 't9' });
    expect(state).toEqual(snapshot);
  });

  it('advances revision for document commands', () => {
    const state = initialEngineState();
    expect(state.revision).toBe(0);
    expect(apply(state, { type: 'setTempo', bpm: 128 }).revision).toBe(1);
  });

  it('holds revision flat for the four transient commands', () => {
    const state = initialEngineState();
    for (const command of [
      { type: 'noteOn', note: 'C4', velocity: 0.8 },
      { type: 'noteOff', note: 'C4' },
      { type: 'seek', position: 4 },
      { type: 'panic' },
    ] as SynthCommand[]) {
      const next = apply(state, command);
      expect(next.revision, command.type).toBe(0);
      // They must also be a genuine no-op, or replaying them would diverge.
      expect(next, command.type).toEqual(state);
    }
  });

  it('leaves state and revision untouched on rejection (F61)', () => {
    const state = apply(initialEngineState(), { type: 'setTempo', bpm: 128 });
    const result = reduce(state, { type: 'removeTrack', trackId: 'nope' }, meta());
    expect(result.status).toBe('rejected');
    // The reducer returns no state at all on rejection, so the caller keeps the old one.
    expect(state.revision).toBe(1);
  });
});

describe('patch commands', () => {
  it('setParam writes nested voice params immutably', () => {
    const next = apply(initialEngineState(), setParam('voice.filterEnvelope.octaves', 5));
    expect(next.patch.voice.filterEnvelope.octaves).toBe(5);
    // A sibling inside the same nested object must survive the write untouched.
    expect(next.patch.voice.filterEnvelope.baseFrequency).toBe(800);
  });

  it('setParam routes master.* to the song, not the patch', () => {
    const next = apply(initialEngineState(), setParam('master.volume', -12));
    expect(next.song.master.volume).toBe(-12);
  });

  it('setParam rejects an LFO slot that has no LFO in it', () => {
    const error = expectRejected(initialEngineState(), setParam('voice.lfos.0.frequency', 5));
    expect(error).toContain('addLfo');
  });

  it('addLfo then setParam on that slot works', () => {
    const withLfo = apply(initialEngineState(), {
      type: 'addLfo',
      config: {
        id: 'lfo-1',
        enabled: true,
        type: 'triangle',
        frequency: 2,
        sync: false,
        retrigger: true,
      },
    });
    const next = apply(withLfo, setParam('voice.lfos.0.frequency', 7));
    expect(next.patch.voice.lfos[0]?.frequency).toBe(7);
  });

  it('addLfo refuses a duplicate id and a fifth LFO', () => {
    const config = {
      id: 'lfo-1',
      enabled: true,
      target: 'pitch' as const,
      type: 'sine' as const,
      frequency: 4,
      min: -5,
      max: 5,
      sync: false,
      retrigger: false,
    };
    const withLfo = apply(initialEngineState(), { type: 'addLfo', config });
    expect(expectRejected(withLfo, { type: 'addLfo', config })).toContain('already exists');

    let state = initialEngineState();
    for (let i = 0; i < 4; i += 1) {
      state = apply(state, { type: 'addLfo', config: { ...config, id: `lfo-${i}` } });
    }
    expect(expectRejected(state, { type: 'addLfo', config: { ...config, id: 'lfo-5' } })).toContain(
      'at most 4',
    );
  });

  it('savePreset derives the new id from the command id, not a fresh uuid', () => {
    const next = apply(initialEngineState(), { type: 'savePreset', name: 'My Patch' }, meta('cmd-save'));
    expect(next.presets['cmd-save']?.name).toBe('My Patch');
    expect(next.presets['cmd-save']?.derivedFrom).toBe('factory-default');
    expect(next.presets['cmd-save']?.factory).toBe(false);
    expect(next.patch.id).toBe('cmd-save');
  });

  it('deletePreset refuses to delete a factory preset', () => {
    const error = expectRejected(initialEngineState(), {
      type: 'deletePreset',
      presetId: 'factory-default',
    });
    expect(error).toContain('factory preset');
  });

  it('loadPreset by id fails loudly for an unknown id', () => {
    expect(expectRejected(initialEngineState(), { type: 'loadPreset', presetId: 'ghost' })).toContain(
      'no preset',
    );
  });

  it('setEffectEnabled toggles just that effect', () => {
    const next = apply(initialEngineState(), { type: 'setEffectEnabled', effectId: 'reverb', enabled: true });
    expect(next.patch.effects.reverb.enabled).toBe(true);
    expect(next.patch.effects.delay.enabled).toBe(false);
  });
});

describe('song commands', () => {
  it('setStep materialises a note into the free-time list', () => {
    const state = initialEngineState();
    const next = apply(state, {
      type: 'setStep',
      trackId: 'track-1',
      stepIndex: 4,
      active: true,
      note: 'E3',
      noteId: 'n-4',
    });
    const notes = next.song.tracks[0]!.notes;
    expect(notes).toHaveLength(1);
    // Step 4 at 4 steps per beat is beat 1 — the grid is a projection, not a store.
    expect(notes[0]).toEqual({ noteId: 'n-4', time: 1, duration: 0.25, note: 'E3', velocity: 0.8 });
  });

  it('setStep on an occupied step replaces rather than stacks', () => {
    let state = initialEngineState();
    state = apply(state, { type: 'setStep', trackId: 'track-1', stepIndex: 0, active: true, noteId: 'a' });
    state = apply(state, { type: 'setStep', trackId: 'track-1', stepIndex: 0, active: true, noteId: 'b' });
    expect(state.song.tracks[0]!.notes).toHaveLength(1);
    expect(state.song.tracks[0]!.notes[0]?.noteId).toBe('b');
  });

  it('setStep active:false clears the step', () => {
    let state = initialEngineState();
    state = apply(state, { type: 'setStep', trackId: 'track-1', stepIndex: 2, active: true, noteId: 'a' });
    state = apply(state, { type: 'setStep', trackId: 'track-1', stepIndex: 2, active: false });
    expect(state.song.tracks[0]!.notes).toHaveLength(0);
  });

  it('setStep rejects a step beyond the pattern length', () => {
    expect(
      expectRejected(initialEngineState(), {
        type: 'setStep',
        trackId: 'track-1',
        stepIndex: 40,
        active: true,
        noteId: 'x',
      }),
    ).toContain('beyond the pattern length');
  });

  it('setPatternLength keeps notes past the new end rather than destroying them', () => {
    let state = initialEngineState();
    state = apply(state, {
      type: 'addNote',
      trackId: 'track-1',
      note: { noteId: 'far', time: 7, duration: 0.5, note: 'C4', velocity: 0.8 },
    });
    state = apply(state, { type: 'setPatternLength', trackId: 'track-1', length: 4 });
    expect(state.song.tracks[0]!.notes).toHaveLength(1);
  });

  it('addNote keeps notes sorted and refuses a duplicate id', () => {
    let state = initialEngineState();
    state = apply(state, {
      type: 'addNote',
      trackId: 'track-1',
      note: { noteId: 'b', time: 2, duration: 0.5, note: 'C4', velocity: 0.8 },
    });
    state = apply(state, {
      type: 'addNote',
      trackId: 'track-1',
      note: { noteId: 'a', time: 1, duration: 0.5, note: 'E4', velocity: 0.8 },
    });
    expect(state.song.tracks[0]!.notes.map((n) => n.noteId)).toEqual(['a', 'b']);
    expect(
      expectRejected(state, {
        type: 'addNote',
        trackId: 'track-1',
        note: { noteId: 'a', time: 3, duration: 0.5, note: 'G4', velocity: 0.8 },
      }),
    ).toContain('already exists');
  });

  it('addTrack embeds a preset snapshot that does not alias the live patch', () => {
    const state = apply(initialEngineState(), { type: 'addTrack', trackId: 't2' });
    const track = state.song.tracks[1]!;
    expect(track.presetSnapshot).toEqual(state.patch);
    expect(track.presetSnapshot).not.toBe(state.patch);
  });

  it('importSongFile rejects malformed JSON and invalid documents distinctly', () => {
    const state = initialEngineState();
    expect(expectRejected(state, { type: 'importSongFile', json: '{oops' })).toContain('not valid JSON');
    expect(expectRejected(state, { type: 'importSongFile', json: '{"id":"x"}' })).toContain('rejected');
  });

  it('saveSong upserts into the library and stamps updatedAt from meta', () => {
    const next = apply(
      initialEngineState(),
      { type: 'saveSong', name: 'Track One' },
      meta('cmd-song', 1_800_000_000_000),
    );
    expect(next.song.name).toBe('Track One');
    expect(next.song.updatedAt).toBe(1_800_000_000_000);
    expect(next.songs[next.song.id]?.name).toBe('Track One');
  });
});

describe('transport commands', () => {
  it('play, stop and pause move the status', () => {
    let state = initialEngineState();
    state = apply(state, { type: 'play' });
    expect(state.transport.status).toBe('playing');
    state = apply(state, { type: 'pause' });
    expect(state.transport.status).toBe('paused');
    state = apply(state, { type: 'stop' });
    expect(state.transport.status).toBe('stopped');
  });

  it('pausing a stopped transport is a no-op, not a rejection', () => {
    const state = initialEngineState();
    expect(apply(state, { type: 'pause' }).transport.status).toBe('stopped');
  });

  it('setLoop keeps the existing bounds when only enabled is sent', () => {
    const next = apply(initialEngineState(), { type: 'setLoop', enabled: true });
    expect(next.song.loop).toEqual({ enabled: true, start: 0, end: 4 });
  });
});

describe('importMidi', () => {
  const midi = new ToneMidiImport();

  it('rejects cleanly when no MidiImportPort was supplied', () => {
    const result = reduce(
      initialEngineState(),
      { type: 'importMidi', bytes: demoMidiFixture.bytes },
      meta(),
    );
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.error).toContain('MidiImportPort');
  });

  it('imports the fixture through the port and surfaces its warnings', () => {
    const result = reduce(
      initialEngineState(),
      { type: 'importMidi', bytes: demoMidiFixture.bytes, filename: 'demo.mid' },
      { ...meta('cmd-midi'), midi },
    );
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.state.song.tracks).toHaveLength(2);
    expect(result.state.song.tempoMap).toHaveLength(2);
    expect(result.warnings?.some((w) => w.startsWith('drum-channel'))).toBe(true);
    // Ids derive from the command id, which is what makes the import replayable.
    expect(result.state.song.id).toBe('cmd-midi');
    expect(result.state.song.tracks[0]?.id).toBe('cmd-midi-t0');
  });

  it('produces deep-equal state when the same command is replayed', () => {
    const command: SynthCommand = { type: 'importMidi', bytes: demoMidiFixture.bytes, filename: 'demo.mid' };
    const first = reduce(initialEngineState(), command, { ...meta('cmd-midi'), midi });
    const second = reduce(initialEngineState(), command, { ...meta('cmd-midi'), midi });
    expect(first).toEqual(second);
  });
});

describe('F59 — replaying the journal reconstructs state exactly', () => {
  /** A session that touches every category: patch edits, song edits, transport, hot path. */
  const session: Array<{ command: SynthCommand; meta: ReduceMeta }> = [
    { command: setParam('voice.filterEnvelope.baseFrequency', 850), meta: meta('c1', 1000) },
    { command: { type: 'setEffectEnabled', effectId: 'delay', enabled: true }, meta: meta('c2', 1001) },
    { command: { type: 'savePreset', name: 'Session Patch' }, meta: meta('c3', 1002) },
    { command: { type: 'setTempo', bpm: 96 }, meta: meta('c4', 1003) },
    { command: { type: 'addTrack', trackId: 't2', name: 'Lead' }, meta: meta('c5', 1004) },
    { command: { type: 'setStep', trackId: 't2', stepIndex: 0, active: true, noteId: 'n1' }, meta: meta('c6', 1005) },
    { command: { type: 'setStep', trackId: 't2', stepIndex: 6, active: true, noteId: 'n2' }, meta: meta('c7', 1006) },
    { command: { type: 'noteOn', note: 'C4', velocity: 0.9 }, meta: meta('c8', 1007) },
    { command: { type: 'play' }, meta: meta('c9', 1008) },
    { command: { type: 'seek', position: 2 }, meta: meta('c10', 1009) },
    { command: { type: 'noteOff', note: 'C4' }, meta: meta('c11', 1010) },
    { command: { type: 'setSwing', amount: 0.2 }, meta: meta('c12', 1011) },
    { command: { type: 'saveSong', name: 'Session Song' }, meta: meta('c13', 1012) },
  ];

  function run(): { state: EngineState; accepted: number } {
    let state = initialEngineState();
    let accepted = 0;
    for (const step of session) {
      const result = reduce(state, step.command, step.meta);
      expect(result.status, `${step.command.type} should have applied`).toBe('applied');
      if (result.status === 'applied') {
        state = result.state;
        accepted += 1;
      }
    }
    return { state, accepted };
  }

  it('two replays of the same journal produce deep-equal state', () => {
    expect(run().state).toEqual(run().state);
  });

  it('revision counts exactly the non-transient accepted commands', () => {
    const { state, accepted } = run();
    // 13 commands, 4 of which are transient (noteOn, noteOff, seek, and none other here).
    const transientCount = session.filter((s) =>
      ['noteOn', 'noteOff', 'seek', 'panic'].includes(s.command.type),
    ).length;
    expect(accepted).toBe(session.length);
    expect(state.revision).toBe(session.length - transientCount);
  });

  it('a rejected command in the middle does not shift the replay', () => {
    // F61: rejections consume a seq but never a revision, so a journal containing them
    // still replays to the same state.
    let withRejection = initialEngineState();
    for (const step of session) {
      const bad = reduce(withRejection, { type: 'removeTrack', trackId: 'ghost' }, step.meta);
      expect(bad.status).toBe('rejected');
      const result = reduce(withRejection, step.command, step.meta);
      if (result.status === 'applied') withRejection = result.state;
    }
    expect(withRejection).toEqual(run().state);
  });
});

describe('validateAndReduce', () => {
  it('rejects an invalid payload before the reducer sees it', () => {
    const result = validateAndReduce(initialEngineState(), { type: 'setTempo', bpm: 9000 }, meta());
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.error).toContain('setTempo rejected');
  });

  it('applies a valid payload', () => {
    const result = validateAndReduce(initialEngineState(), { type: 'setTempo', bpm: 96 }, meta());
    expect(result.status).toBe('applied');
    if (result.status === 'applied') expect(result.state.song.bpm).toBe(96);
  });
});
