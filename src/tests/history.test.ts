/**
 * src/tests/history.test.ts — undo/redo, and F59 restated.
 *
 * The claim under test: replaying a journal through `replay()` reproduces the live
 * `present` state, INCLUDING when that journal contains undo and redo. That is the
 * property that made undo a journaled verb rather than a client-side cursor, so it is
 * the one worth proving hardest.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY_DEPTH,
  applyToHistory,
  canRedo,
  canUndo,
  emittedRevision,
  initialHistory,
  replay,
  type HistoryState,
} from '../core/history';
import { reduce, type ReduceMeta } from '../core/reduce';
import { initialEngineState } from '../core/state';
import { createEnvelope, setParam, type SynthCommand } from '../core/commands';
import { buildCommandAppliedEvent, type SynthCommandAppliedEvent } from '../core/sag/events';

const meta = (commandId: string, ts = 1_700_000_000_000): ReduceMeta => ({ commandId, ts });

function apply(history: HistoryState, command: SynthCommand, id = 'c'): HistoryState {
  const result = applyToHistory(history, command, meta(id));
  if (result.status !== 'applied') throw new Error(`expected applied, got: ${result.error}`);
  return result.history;
}

/** Drive a session and journal it exactly as the dispatcher will. */
function runSession(commands: SynthCommand[]): {
  history: HistoryState;
  journal: SynthCommandAppliedEvent[];
} {
  let history = initialHistory();
  const journal: SynthCommandAppliedEvent[] = [];
  commands.forEach((command, index) => {
    const id = `c${index}`;
    const ts = 1_700_000_000_000 + index;
    const envelope = createEnvelope(command, 'ui', id, ts);
    const before = history;
    const result = applyToHistory(history, command, meta(id, ts));
    if (result.status === 'applied') history = result.history;
    journal.push(
      buildCommandAppliedEvent(
        envelope,
        result.status === 'applied'
          ? { status: 'applied' }
          : { status: 'rejected', error: result.error },
        // The same helper the dispatcher will use, so these journals are shaped by the
        // real rule rather than by a copy of it that could drift away from it.
        { seq: index, revision: emittedRevision(before, result) },
      ),
    );
  });
  return { history, journal };
}

describe('undo and redo', () => {
  it('starts with nothing to undo or redo', () => {
    const history = initialHistory();
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
    expect(applyToHistory(history, { type: 'undo' }, meta('c'))).toEqual({
      status: 'rejected',
      error: 'nothing to undo',
    });
    expect(applyToHistory(history, { type: 'redo' }, meta('c'))).toEqual({
      status: 'rejected',
      error: 'nothing to redo',
    });
  });

  it('restores the previous state and its revision', () => {
    let history = apply(initialHistory(), { type: 'setTempo', bpm: 128 });
    expect(history.present.song.bpm).toBe(128);
    expect(history.present.revision).toBe(1);

    history = apply(history, { type: 'undo' });
    expect(history.present.song.bpm).toBe(120);
    // Undo RESTORES revision 0 rather than advancing to 2 — it is not a new edit.
    expect(history.present.revision).toBe(0);
    expect(canRedo(history)).toBe(true);
  });

  it('round-trips through redo back to the identical state', () => {
    const edited = apply(initialHistory(), { type: 'setTempo', bpm: 96 });
    const undone = apply(edited, { type: 'undo' });
    const redone = apply(undone, { type: 'redo' });
    expect(redone.present).toEqual(edited.present);
  });

  it('discards the redo branch when a new edit follows an undo', () => {
    let history = apply(initialHistory(), { type: 'setTempo', bpm: 96 });
    history = apply(history, { type: 'undo' });
    expect(canRedo(history)).toBe(true);

    history = apply(history, { type: 'setSwing', amount: 0.3 });
    // Keeping the branch would let redo jump to a state that never followed from here.
    expect(canRedo(history)).toBe(false);
    expect(history.present.song.bpm).toBe(120);
    expect(history.present.song.swing).toBe(0.3);
  });

  it('does not record an undo entry for transient commands', () => {
    // A transient command changes nothing in EngineState, so an entry for it would make
    // undo appear to do nothing at all — the user presses it and the interface sits still.
    let history = apply(initialHistory(), { type: 'setTempo', bpm: 96 });
    const depthAfterEdit = history.past.length;
    history = apply(history, { type: 'noteOn', note: 'C4', velocity: 0.8 });
    history = apply(history, { type: 'seek', position: 3 });
    history = apply(history, { type: 'panic' });
    expect(history.past.length).toBe(depthAfterEdit);

    history = apply(history, { type: 'undo' });
    expect(history.present.song.bpm).toBe(120);
  });

  it('does not record an entry for a rejected command', () => {
    let history = apply(initialHistory(), { type: 'setTempo', bpm: 96 });
    const before = history;
    const result = applyToHistory(history, { type: 'removeTrack', trackId: 'ghost' }, meta('c'));
    expect(result.status).toBe('rejected');
    history = apply(history, { type: 'undo' });
    expect(before.past.length).toBe(1);
    expect(history.present.song.bpm).toBe(120);
  });

  it('bounds the stack so a long session cannot grow without limit', () => {
    let history = initialHistory();
    for (let i = 0; i < MAX_HISTORY_DEPTH + 25; i += 1) {
      history = apply(history, { type: 'setTempo', bpm: 60 + (i % 100) }, `c${i}`);
    }
    expect(history.past.length).toBe(MAX_HISTORY_DEPTH);
  });

  it('never mutates the history it was given', () => {
    const history = apply(initialHistory(), { type: 'setTempo', bpm: 96 });
    const snapshot = structuredClone({
      past: history.past,
      present: history.present,
      future: history.future,
    });
    apply(history, { type: 'undo' });
    expect(history.past).toEqual(snapshot.past);
    expect(history.present).toEqual(snapshot.present);
  });
});

describe('the reducer refuses history commands outright', () => {
  it('points at the history driver rather than silently no-opping', () => {
    for (const type of ['undo', 'redo'] as const) {
      const result = reduce(initialEngineState(), { type }, meta('c'));
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.error).toContain('history driver');
    }
  });
});

describe('emittedRevision — the revision slot of KIND-synth_command_applied', () => {
  function revisionOf(history: HistoryState, command: SynthCommand): number {
    return emittedRevision(history, applyToHistory(history, command, meta('c')));
  }

  it('advances for a document edit', () => {
    const start = initialHistory();
    expect(start.present.revision).toBe(0);
    expect(revisionOf(start, { type: 'setTempo', bpm: 96 })).toBe(1);
  });

  it('holds flat for a transient command, which changes nothing in EngineState', () => {
    const history = apply(initialHistory(), { type: 'setTempo', bpm: 96 });
    expect(history.present.revision).toBe(1);
    expect(revisionOf(history, { type: 'seek', position: 4 })).toBe(1);
  });

  it('F61: holds flat for a rejected command, which consumes a seq but not a revision', () => {
    const history = apply(initialHistory(), { type: 'setTempo', bpm: 96 });
    const result = applyToHistory(history, { type: 'removeTrack', trackId: 'ghost' }, meta('c'));
    expect(result.status).toBe('rejected');
    expect(emittedRevision(history, result)).toBe(1);
  });

  it('RESTORES rather than advances on undo, then again on redo', () => {
    // The case the deleted `revisionAfter` could never have got right: read off the
    // pre-state, undo reports the revision it is leaving, not the one it returns to.
    let history = apply(initialHistory(), { type: 'setTempo', bpm: 96 });
    history = apply(history, { type: 'setTempo', bpm: 140 }, 'c2');
    expect(history.present.revision).toBe(2);

    const undone = applyToHistory(history, { type: 'undo' }, meta('c3'));
    expect(emittedRevision(history, undone)).toBe(1);
    if (undone.status !== 'applied') throw new Error('undo should have applied');

    const redone = applyToHistory(undone.history, { type: 'redo' }, meta('c4'));
    expect(emittedRevision(undone.history, redone)).toBe(2);
  });

  it('never reports a revision the state does not actually carry', () => {
    // Whatever it returns must be observable in a real state — otherwise the journal
    // records a version of the document that never existed.
    let history = initialHistory();
    const seen = new Set<number>([history.present.revision]);
    for (const command of [
      { type: 'setTempo', bpm: 96 },
      setParam('voice.filter.frequency', 850),
      { type: 'undo' },
      { type: 'redo' },
      { type: 'seek', position: 2 },
    ] as SynthCommand[]) {
      const result = applyToHistory(history, command, meta('c'));
      const revision = emittedRevision(history, result);
      if (result.status === 'applied') history = result.history;
      seen.add(history.present.revision);
      expect(seen.has(revision), `revision ${revision} was never a real state`).toBe(true);
    }
  });
});

describe('F59 — replay reproduces live state', () => {
  const session: SynthCommand[] = [
    setParam('voice.filter.frequency', 850),
    { type: 'setTempo', bpm: 96 },
    { type: 'addTrack', trackId: 't2', name: 'Lead' },
    { type: 'setStep', trackId: 't2', stepIndex: 0, active: true, noteId: 'n1' },
    { type: 'noteOn', note: 'C4', velocity: 0.9 },
    { type: 'setSwing', amount: 0.25 },
    { type: 'noteOff', note: 'C4' },
  ];

  it('reproduces a straight-line session exactly', () => {
    const { history, journal } = runSession(session);
    expect(replay(journal).present).toEqual(history.present);
  });

  it('reproduces a session containing an undo', () => {
    // This is the case that forced undo to become a journaled verb. Without it in the
    // journal, replay would rebuild the PRE-undo state and diverge here.
    const { history, journal } = runSession([...session, { type: 'undo' }]);
    expect(history.present.song.swing).toBe(0);
    expect(replay(journal).present).toEqual(history.present);
  });

  it('reproduces a session containing undo then redo', () => {
    const { history, journal } = runSession([...session, { type: 'undo' }, { type: 'redo' }]);
    expect(history.present.song.swing).toBe(0.25);
    expect(replay(journal).present).toEqual(history.present);
  });

  it('reproduces a session where a new edit killed the redo branch', () => {
    const { history, journal } = runSession([
      ...session,
      { type: 'undo' },
      { type: 'undo' },
      { type: 'setTempo', bpm: 140 },
    ]);
    expect(replay(journal).present).toEqual(history.present);
    expect(replay(journal).future).toEqual([]);
  });

  it('reproduces the full past and future stacks, not just the present', () => {
    const { history, journal } = runSession([...session, { type: 'undo' }]);
    const replayed = replay(journal);
    expect(replayed.past).toEqual(history.past);
    expect(replayed.future).toEqual(history.future);
  });

  it('skips rejected events, which consumed a seq but never touched state (F61)', () => {
    const { history, journal } = runSession([
      { type: 'setTempo', bpm: 96 },
      { type: 'removeTrack', trackId: 'ghost' },
      { type: 'setSwing', amount: 0.1 },
    ]);
    expect(journal[1]?.status).toBe('rejected');
    expect(journal).toHaveLength(3);
    expect(replay(journal).present).toEqual(history.present);
  });

  it('throws rather than drifting when a journaled event no longer applies', () => {
    // If an event recorded as applied is rejected on replay, the journal and the reducer
    // genuinely disagree. That is the F59 failure this function exists to surface, so it
    // must be loud — a silent skip would produce a plausible but wrong state.
    const { journal } = runSession([{ type: 'setTempo', bpm: 96 }]);
    const corrupted: SynthCommandAppliedEvent[] = [
      { ...journal[0]!, payload: { type: 'removeTrack', trackId: 'ghost' }, command_type: 'removeTrack' },
    ];
    expect(() => replay(corrupted)).toThrow(/replay diverged at seq 0/);
  });
});
