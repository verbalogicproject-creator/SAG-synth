/**
 * src/core/history.ts — undo/redo, and the replay function that F59 is checked against.
 *
 * The reducer is a pure function of ONE state and ONE command. Undo needs a stack, so
 * putting it in the reducer would have made `reduce` a function of history — and the
 * whole replay proof rests on it not being one. This driver sits above the reducer
 * instead: it owns the past/future stacks and delegates everything else untouched.
 *
 * Why undo is a journaled command rather than a client-side cursor: if the journal did
 * not record it, replaying the journal would rebuild the PRE-undo state, so live state
 * would disagree with its own history and an undo would not survive a reload. Recording
 * it keeps the journal the single truth. F59 restated precisely:
 *
 *   replaying a journal THROUGH `replay()` reproduces the live `HistoryState.present`.
 *
 * That is a sharper claim than the original wording, not a weaker one — it names the
 * function the replay must go through.
 */

import { advancesRevision, type SynthCommand } from './commands';
import { initialEngineState, type EngineState } from './state';
import { reduce, type ReduceMeta, type ReduceResult } from './reduce';
import type { SynthCommandAppliedEvent } from './sag/events';
import type { MidiImportPort } from './ports';

/**
 * How many states deep undo goes. Unbounded history would grow without limit across a
 * long session, and a synth session is long by nature. Replay rebuilds the same bounded
 * stack from the journal, so live and replayed histories match at any depth.
 */
export const MAX_HISTORY_DEPTH = 100;

export interface HistoryState {
  past: readonly EngineState[];
  present: EngineState;
  future: readonly EngineState[];
}

export type HistoryResult =
  | { status: 'applied'; history: HistoryState; warnings?: string[] }
  | { status: 'rejected'; error: string };

export function initialHistory(): HistoryState {
  return { past: [], present: initialEngineState(), future: [] };
}

export function canUndo(history: HistoryState): boolean {
  return history.past.length > 0;
}

export function canRedo(history: HistoryState): boolean {
  return history.future.length > 0;
}

function pushPast(past: readonly EngineState[], state: EngineState): EngineState[] {
  const next = [...past, state];
  return next.length > MAX_HISTORY_DEPTH ? next.slice(next.length - MAX_HISTORY_DEPTH) : next;
}

/**
 * Apply one command to the history. Undo and redo move whole states between the stacks;
 * everything else goes to the reducer.
 *
 * Only revision-advancing commands create an undo entry. Transient ones (noteOn,
 * noteOff, seek, panic) change nothing in EngineState, so an entry for them would make
 * undo appear to do nothing — the user would press it and watch the interface sit still.
 */
export function applyToHistory(
  history: HistoryState,
  command: SynthCommand,
  meta: ReduceMeta,
): HistoryResult {
  if (command.type === 'undo') {
    const previous = history.past[history.past.length - 1];
    if (previous === undefined) return { status: 'rejected', error: 'nothing to undo' };
    return {
      status: 'applied',
      history: {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
      },
    };
  }

  if (command.type === 'redo') {
    const [next, ...rest] = history.future;
    if (next === undefined) return { status: 'rejected', error: 'nothing to redo' };
    return {
      status: 'applied',
      history: { past: pushPast(history.past, history.present), present: next, future: rest },
    };
  }

  const result: ReduceResult = reduce(history.present, command, meta);
  if (result.status === 'rejected') return result;

  if (!advancesRevision(command)) {
    return {
      status: 'applied',
      history: { ...history, present: result.state },
      ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
    };
  }

  return {
    status: 'applied',
    // A fresh edit after an undo discards the redo branch, as every editor does —
    // keeping it would let redo jump to a state that never followed from this one.
    history: { past: pushPast(history.past, history.present), present: result.state, future: [] },
    ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
  };
}

/**
 * Rebuild history from a journal. This IS the F59 check: fold the accepted events back
 * through the same driver that produced them and the result must equal live state.
 *
 * Rejected events are skipped — they consumed a seq but never touched state (F61).
 */
export function replay(
  events: readonly SynthCommandAppliedEvent[],
  options: { midi?: MidiImportPort } = {},
): HistoryState {
  let history = initialHistory();
  for (const event of events) {
    if (event.status !== 'applied') continue;
    const meta: ReduceMeta = {
      commandId: event.command_id,
      ts: event.ts,
      ...(options.midi === undefined ? {} : { midi: options.midi }),
    };
    const result = applyToHistory(history, event.payload, meta);
    if (result.status === 'applied') history = result.history;
    // An event that applied when it was recorded but is rejected on replay means the
    // journal and the reducer genuinely disagree — exactly the F59 failure this
    // function exists to surface. Fail loudly rather than silently drifting.
    else {
      throw new Error(
        `replay diverged at seq ${event.seq} (${event.command_type}): ${result.error}`,
      );
    }
  }
  return history;
}

/**
 * The revision an emitted event must carry, per KIND-synth_command_applied slot
 * `revision` and F61. This is a function of the state BEFORE and the RESULT, never of
 * the command alone: a revision-advancing command's new revision does not exist until
 * the reducer has run, and undo/redo restore a revision recorded in a past state rather
 * than computing one.
 *
 * An earlier signature took `(history, command)` and tried to answer from the pre-state.
 * It could not: every branch could only return the pre-command revision, which is right
 * for a rejection and wrong for everything else. Reading it off the post-state makes
 * undo and redo fall out for free — `past` holds whole `EngineState`s, each carrying the
 * revision it had when it was current.
 */
export function emittedRevision(before: HistoryState, result: HistoryResult): number {
  // F61: a rejected command consumes a seq but not a revision.
  if (result.status === 'rejected') return before.present.revision;
  return result.history.present.revision;
}
