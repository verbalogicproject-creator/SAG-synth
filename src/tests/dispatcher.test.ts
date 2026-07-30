/**
 * src/tests/dispatcher.test.ts — the seam under test.
 *
 * Every other test in this suite exercises one part in isolation. This one drives the
 * whole engine the way a client will and then asks the question the whole architecture
 * exists to answer: does the journal it produced rebuild the state it produced?
 *
 * Runs in the `core` (node) project. NullRuntime and MemoryPersistence need no browser,
 * which is the point of both.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher, type DispatcherDeps } from '../app/dispatcher';
import { NullRuntime } from '../core/runtime-contract';
import { MemoryPersistence } from '../core/ports';
import { MemorySagJournal, type SagTransport, type SynthCommandAppliedEvent } from '../core/sag/events';
import { replay } from '../core/history';
import { setParam, type SynthCommand } from '../core/commands';
import { initialEngineState } from '../core/state';

/** Deterministic id and clock sources — the whole reason both are injected. */
function fixtures(overrides: Partial<DispatcherDeps> = {}): {
  dispatcher: Dispatcher;
  runtime: NullRuntime;
  journal: MemorySagJournal;
} {
  const runtime = new NullRuntime();
  const journal = new MemorySagJournal();
  let ids = 0;
  let clock = 1_700_000_000_000;
  const dispatcher = new Dispatcher({
    runtime,
    journal,
    newId: () => `cmd-${ids++}`,
    now: () => clock++,
    ...overrides,
  });
  return { dispatcher, runtime, journal };
}

function calls(runtime: NullRuntime, method: string): unknown[] {
  return runtime.calls.filter((call) => call.method === method).map((call) => call.arg);
}

describe('F60 — seq is gapless, and rejections consume one', () => {
  it('numbers every dispatch consecutively from zero', () => {
    const { dispatcher, journal } = fixtures();
    dispatcher.dispatch({ type: 'setTempo', bpm: 96 });
    dispatcher.dispatch({ type: 'setTempo', bpm: 140 });
    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 0.8 });

    expect(journal.read().map((event) => event.seq)).toEqual([0, 1, 2]);
  });

  it('gives a rejected command a seq of its own, so the journal never skips', () => {
    const { dispatcher, journal } = fixtures();
    dispatcher.dispatch({ type: 'setTempo', bpm: 96 });
    dispatcher.dispatch({ type: 'setTempo', bpm: 9000 }); // out of range
    dispatcher.dispatch({ type: 'setTempo', bpm: 140 });

    const events = journal.read();
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(events.map((event) => event.status)).toEqual(['applied', 'rejected', 'applied']);
  });

  it('every dispatch produces exactly one event, whatever its outcome', () => {
    const { dispatcher, journal } = fixtures();
    const commands: SynthCommand[] = [
      { type: 'setTempo', bpm: 96 },
      { type: 'removeTrack', trackId: 'ghost' }, // rejected by the reducer
      { type: 'noteOn', note: 'C4', velocity: 0.8 },
      { type: 'panic' },
      { type: 'undo' },
      { type: 'undo' }, // rejected — nothing left
    ];
    for (const command of commands) dispatcher.dispatch(command);
    expect(journal.read()).toHaveLength(commands.length);
  });
});

describe('F61 — a rejected command touches nothing', () => {
  it('never reaches the reducer or the runtime, and holds revision flat', () => {
    const { dispatcher, runtime, journal } = fixtures();
    dispatcher.dispatch({ type: 'setTempo', bpm: 96 });
    const revisionBefore = dispatcher.getState().revision;
    const stateBefore = dispatcher.getState();
    runtime.calls.length = 0;

    const result = dispatcher.dispatch({ type: 'setTempo', bpm: 9000 });

    expect(result.status).toBe('rejected');
    expect(result.error).toContain('setTempo');
    expect(dispatcher.getState().revision).toBe(revisionBefore);
    // Same object, not merely an equal one: the reducer was never invoked.
    expect(dispatcher.getState()).toBe(stateBefore);
    expect(runtime.calls).toEqual([]);

    const event = journal.read().at(-1)!;
    expect(event.status).toBe('rejected');
    expect(event.revision).toBe(revisionBefore);
    expect(event.error).toBe(result.error);
  });

  it('rejects an unknown verb without throwing', () => {
    const { dispatcher } = fixtures();
    const result = dispatcher.dispatch({ type: 'noSuchCommand' } as unknown as SynthCommand);
    expect(result.status).toBe('rejected');
    expect(result.error).toContain('unknown command type');
  });

  it('a reducer rejection also holds revision flat', () => {
    const { dispatcher, journal } = fixtures();
    dispatcher.dispatch({ type: 'setTempo', bpm: 96 });
    const result = dispatcher.dispatch({ type: 'removeTrack', trackId: 'ghost' });

    expect(result.status).toBe('rejected');
    expect(result.revision).toBe(1);
    expect(journal.read().at(-1)!.revision).toBe(1);
  });
});

describe('F62 — the event carries the command verbatim', () => {
  it('journals the dispatched object, not zod output', () => {
    const { dispatcher, journal } = fixtures();
    const command: SynthCommand = { type: 'setTempo', bpm: 96 };
    dispatcher.dispatch(command);

    const event = journal.read()[0]!;
    expect(event.payload).toEqual(command);
    expect(event.command_type).toBe('setTempo');
  });

  it('does not let zod strip a field on the way into the journal', () => {
    // zod object schemas drop keys they do not know about. If the dispatcher journalled
    // the parsed value, this extra key would vanish — and the live reducer would then be
    // fed a different object than replay() feeds it, because replay does not validate.
    const { dispatcher, journal } = fixtures();
    const command = { type: 'setTempo', bpm: 96, sentBy: 'agent-7' } as unknown as SynthCommand;
    dispatcher.dispatch(command);

    expect(journal.read()[0]!.payload).toEqual(command);
    expect((journal.read()[0]!.payload as unknown as Record<string, unknown>).sentBy).toBe('agent-7');
  });

  it('records the source, so the v0.2 SDK path is distinguishable in the journal', () => {
    const { dispatcher, journal } = fixtures();
    dispatcher.dispatch({ type: 'setTempo', bpm: 96 }, 'agent');
    expect(journal.read()[0]!.source).toBe('agent');
  });
});

describe('the hot path', () => {
  it('drives the runtime with the voice core allocated, and holds revision flat', () => {
    const { dispatcher, runtime } = fixtures();
    const revisionBefore = dispatcher.getState().revision;

    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 0.8 });
    dispatcher.dispatch({ type: 'noteOn', note: 'E4', velocity: 0.6 });

    expect(calls(runtime, 'noteOn')).toEqual([
      { voiceId: 0, note: 'C4', velocity: 0.8, portamento: 0 },
      { voiceId: 1, note: 'E4', velocity: 0.6, portamento: 0 },
    ]);
    expect(dispatcher.getState().revision).toBe(revisionBefore);
  });

  it('keeps held notes and voices out of EngineState entirely', () => {
    // This is what makes F59 satisfiable: a replay cannot know which keys were down.
    const { dispatcher } = fixtures();
    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 0.8 });

    expect(dispatcher.getTransient().heldNotes.has('C4')).toBe(true);
    expect(dispatcher.getState()).toEqual(initialEngineState());
  });

  it('releases the stolen voice BEFORE sounding the new note on that slot', () => {
    // Reversed, the stolen voice's release tail plays over the new note on the same id.
    const { dispatcher, runtime } = fixtures();
    dispatcher.dispatch(setParam('voice.polyphony', 2));
    runtime.calls.length = 0;

    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 0.8 });
    dispatcher.dispatch({ type: 'noteOn', note: 'E4', velocity: 0.8 });
    dispatcher.dispatch({ type: 'noteOn', note: 'G4', velocity: 0.8 });

    const ordered = runtime.calls.map((call) => call.method);
    const stealIndex = ordered.indexOf('steal');
    expect(stealIndex).toBeGreaterThan(-1);
    expect(ordered[stealIndex + 1]).toBe('noteOn');
    // C4 was oldest, so its slot is the one reused.
    expect(runtime.calls[stealIndex]!.arg).toBe(0);
  });

  it('treats a note-off for an already-stolen note as a no-op, not an error', () => {
    const { dispatcher, runtime } = fixtures();
    dispatcher.dispatch(setParam('voice.polyphony', 1));
    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 0.8 });
    dispatcher.dispatch({ type: 'noteOn', note: 'E4', velocity: 0.8 }); // steals C4
    runtime.calls.length = 0;

    const result = dispatcher.dispatch({ type: 'noteOff', note: 'C4' });

    expect(result.status).toBe('applied');
    expect(calls(runtime, 'noteOff')).toEqual([]);
    expect(dispatcher.getTransient().heldNotes.has('C4')).toBe(false);
  });

  it('retriggers rather than burning a second slot for a held note', () => {
    const { dispatcher, runtime } = fixtures();
    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 0.8 });
    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 0.4 });

    expect(calls(runtime, 'noteOn')).toEqual([
      { voiceId: 0, note: 'C4', velocity: 0.8, portamento: 0 },
      { voiceId: 0, note: 'C4', velocity: 0.4, portamento: 0 },
    ]);
    expect(dispatcher.getTransient().voices).toHaveLength(1);
  });
});

describe('panic and seek', () => {
  it('panic releases every sounding voice and clears held notes', () => {
    const { dispatcher, runtime } = fixtures();
    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 0.8 });
    dispatcher.dispatch({ type: 'noteOn', note: 'E4', velocity: 0.8 });
    runtime.calls.length = 0;

    dispatcher.dispatch({ type: 'panic' });

    expect(calls(runtime, 'noteOff')).toEqual([
      { voiceId: 0, note: 'C4' },
      { voiceId: 1, note: 'E4' },
    ]);
    expect(dispatcher.getTransient().voices).toEqual([]);
    expect(dispatcher.getTransient().heldNotes.size).toBe(0);
  });

  it('panic does not rewind the note counter', () => {
    // It is the ordering key the 'oldest' steal policy sorts on. Rewinding it would make
    // notes played after a panic look older than notes played before one.
    const { dispatcher } = fixtures();
    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 0.8 });
    dispatcher.dispatch({ type: 'noteOn', note: 'E4', velocity: 0.8 });
    const before = dispatcher.getTransient().noteCounter;

    dispatcher.dispatch({ type: 'panic' });

    expect(dispatcher.getTransient().noteCounter).toBe(before);
  });

  it('seek drives the transport without advancing revision', () => {
    const { dispatcher, runtime } = fixtures();
    const revisionBefore = dispatcher.getState().revision;
    dispatcher.dispatch({ type: 'seek', position: 8 });

    expect(calls(runtime, 'transport.seek')).toEqual([8]);
    expect(dispatcher.getState().revision).toBe(revisionBefore);
  });
});

describe('runtime sync', () => {
  it('pushes the patch only when the patch actually changed', () => {
    const { dispatcher, runtime } = fixtures();
    dispatcher.dispatch(setParam('voice.filter.frequency', 850));
    dispatcher.dispatch({ type: 'setTempo', bpm: 96 }); // song, not patch

    expect(calls(runtime, 'applyPatch')).toHaveLength(1);
    expect(calls(runtime, 'applySong')).toHaveLength(1);
  });

  it('drives the transport on a status change', () => {
    const { dispatcher, runtime } = fixtures();
    dispatcher.dispatch({ type: 'play' });
    dispatcher.dispatch({ type: 'pause' });
    dispatcher.dispatch({ type: 'stop' });

    expect(runtime.calls.map((call) => call.method).filter((m) => m.startsWith('transport.'))).toEqual([
      'transport.play',
      'transport.pause',
      'transport.stop',
    ]);
  });

  it('re-syncs the graph on undo, without knowing anything about history', () => {
    const { dispatcher, runtime } = fixtures();
    dispatcher.dispatch(setParam('voice.filter.frequency', 850));
    runtime.calls.length = 0;

    dispatcher.dispatch({ type: 'undo' });

    // Undo swaps in a whole earlier EngineState, so the patch reference differs and the
    // reference check fires — no undo-specific branch needed.
    expect(calls(runtime, 'applyPatch')).toHaveLength(1);
    expect(dispatcher.getState().patch.voice.filter.frequency).toBe(2000);
  });
});

describe('F59 — the journal rebuilds the state that produced it', () => {
  /** A session with edits, performance gestures, a rejection, an undo and a redo. */
  function drive(dispatcher: Dispatcher): void {
    dispatcher.dispatch({ type: 'setTempo', bpm: 96 });
    dispatcher.dispatch(setParam('voice.filter.frequency', 850));
    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 0.8 });
    dispatcher.dispatch({ type: 'setTempo', bpm: 9000 }); // rejected
    dispatcher.dispatch(setParam('voice.envelope.attack', 0.5));
    dispatcher.dispatch({ type: 'noteOff', note: 'C4' });
    dispatcher.dispatch({ type: 'undo' });
    dispatcher.dispatch({ type: 'seek', position: 4 });
    dispatcher.dispatch({ type: 'redo' });
    dispatcher.dispatch({ type: 'play' });
    dispatcher.dispatch(setParam('voice.polyphony', 4));
    dispatcher.dispatch({ type: 'undo' });
  }

  it('reproduces present, past and future exactly', () => {
    const { dispatcher, journal } = fixtures();
    drive(dispatcher);

    const rebuilt = replay(journal.read());

    expect(rebuilt.present).toEqual(dispatcher.getHistory().present);
    // The stacks too — `present` alone would pass even if undo depth had drifted.
    expect(rebuilt.past).toEqual(dispatcher.getHistory().past);
    expect(rebuilt.future).toEqual(dispatcher.getHistory().future);
  });

  it('the rebuilt revision matches the last applied event', () => {
    const { dispatcher, journal } = fixtures();
    drive(dispatcher);

    const lastApplied = [...journal.read()].reverse().find((e) => e.status === 'applied')!;
    expect(replay(journal.read()).present.revision).toBe(lastApplied.revision);
  });

  it('two runs with the same id source produce identical journals', () => {
    // Determinism is the whole claim. If ids or timestamps leaked in from a real clock,
    // these would differ and every replay proof above would be luck.
    const first = fixtures();
    const second = fixtures();
    drive(first.dispatcher);
    drive(second.dispatcher);

    expect(first.journal.read()).toEqual(second.journal.read());
  });
});

describe('the durable mirror', () => {
  let persistence: MemoryPersistence;

  beforeEach(() => {
    persistence = new MemoryPersistence();
  });

  it('writes every event through to persistence once flushed', async () => {
    const { dispatcher, journal } = fixtures({ persistence });
    dispatcher.dispatch({ type: 'setTempo', bpm: 96 });
    dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 0.8 });
    dispatcher.dispatch({ type: 'setTempo', bpm: 9000 });
    await dispatcher.flush();

    expect(await persistence.readJournal()).toEqual(journal.read());
  });

  it('does not re-append events it has already mirrored', async () => {
    // The durable cursor is separate from the transport's ack cursor on purpose: sharing
    // them would re-append the whole journal on every dispatch, since nothing acks.
    const appended: number[] = [];
    const counting = new MemoryPersistence();
    const original = counting.appendJournal.bind(counting);
    counting.appendJournal = (events: readonly SynthCommandAppliedEvent[]) => {
      appended.push(events.length);
      return original(events);
    };

    const { dispatcher } = fixtures({ persistence: counting });
    dispatcher.dispatch({ type: 'setTempo', bpm: 96 });
    await dispatcher.flush();
    dispatcher.dispatch({ type: 'setTempo', bpm: 140 });
    await dispatcher.flush();

    expect(appended).toEqual([1, 1]);
    expect(await counting.readJournal()).toHaveLength(2);
  });

  it('leaves everything pending when the transport is disconnected', async () => {
    const { dispatcher, journal } = fixtures({ persistence });
    dispatcher.dispatch({ type: 'setTempo', bpm: 96 });
    await dispatcher.flush();

    // NullSagTransport acknowledges nothing, which is the correct state for a buffered
    // emitter with no backend — the events wait for a reconnect rather than being lost.
    expect(journal.lastAckedSeq()).toBe(-1);
    expect(await persistence.loadLastAckedSeq()).toBe(-1);
  });

  it('advances both cursors once a transport does acknowledge', async () => {
    const sent: SynthCommandAppliedEvent[][] = [];
    const transport: SagTransport = {
      isConnected: true,
      send: (events) => {
        sent.push([...events]);
        return Promise.resolve({ ackedSeq: events.at(-1)!.seq });
      },
    };

    const { dispatcher, journal } = fixtures({ persistence, transport });
    dispatcher.dispatch({ type: 'setTempo', bpm: 96 });
    dispatcher.dispatch({ type: 'setTempo', bpm: 140 });
    await dispatcher.flush();

    expect(journal.lastAckedSeq()).toBe(1);
    expect(await persistence.loadLastAckedSeq()).toBe(1);
    expect(sent.flat().map((e) => e.seq)).toEqual([0, 1]);
  });

  it('retains a flush failure instead of swallowing it', async () => {
    const failing = new MemoryPersistence();
    failing.appendJournal = () => Promise.reject(new Error('disk full'));

    const seen: unknown[] = [];
    const { dispatcher } = fixtures({
      persistence: failing,
      onFlushError: (error) => seen.push(error),
    });
    dispatcher.dispatch({ type: 'setTempo', bpm: 96 });
    await dispatcher.flush();

    expect(dispatcher.getFlushErrors()).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe('disk full');
  });

  it('a mirror failure never breaks the live engine', async () => {
    const failing = new MemoryPersistence();
    failing.appendJournal = () => Promise.reject(new Error('disk full'));
    const { dispatcher } = fixtures({ persistence: failing });

    dispatcher.dispatch({ type: 'setTempo', bpm: 96 });
    await dispatcher.flush();
    const result = dispatcher.dispatch({ type: 'setTempo', bpm: 140 });

    expect(result.status).toBe('applied');
    expect(dispatcher.getState().song.bpm).toBe(140);
  });
});

describe('subscribers', () => {
  it('receives every dispatch, applied or rejected, and can unsubscribe', () => {
    const { dispatcher } = fixtures();
    const seen: string[] = [];
    const unsubscribe = dispatcher.subscribe((update) => seen.push(update.result.status));

    dispatcher.dispatch({ type: 'setTempo', bpm: 96 });
    dispatcher.dispatch({ type: 'setTempo', bpm: 9000 });
    unsubscribe();
    dispatcher.dispatch({ type: 'setTempo', bpm: 140 });

    expect(seen).toEqual(['applied', 'rejected']);
  });
});
