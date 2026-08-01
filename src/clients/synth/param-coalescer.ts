/**
 * src/clients/synth/param-coalescer.ts — one dispatch per frame during a drag.
 *
 * A `pointermove` fires far faster than a screen refreshes, and every one of them used to
 * become a full `setParam`: validated, reduced into a new immutable state, **journalled**,
 * and pushed at the audio graph. A two-second drag wrote hundreds of journal entries.
 *
 * Three costs, and only the first is about speed:
 *
 * - the work itself, which is now much smaller per dispatch (`applyPatch` diffs, see
 *   `PATCH_SECTIONS`) but is still paid at pointer rate rather than at frame rate;
 * - **the journal**, which Phase D is about to start persisting to IndexedDB. A record of
 *   every intermediate value of every drag is a record nobody wants and a database nobody
 *   wants to write;
 * - **undo granularity**, which is one `pointermove` — so undoing a knob turn means
 *   pressing undo a hundred times.
 *
 * ---
 *
 * **Where this deliberately does NOT live.**
 *
 * Not in `src/core/`. There is no transient-command concept in the contract and there
 * should not be one: a command is a command, and a reducer that treated some of them as
 * provisional would have to say what happens when a provisional command is journalled,
 * replayed or undone. Three new questions to avoid one UI problem.
 *
 * Not in the journal either. The journal is a truthful record of **what was dispatched**,
 * and replay depends on that being exactly true. Coalescing there would make the record
 * disagree with what happened.
 *
 * So it sits in front of `dispatch`, in the client, where rate genuinely is a UI concern —
 * the same layer that already decides a drag is a drag. Fewer things are dispatched; the
 * journal then records all of them, honestly.
 *
 * ---
 *
 * **Last value wins, per path, and nothing is ever dropped.** The pending map is keyed by
 * path, so a drag on the cutoff collapses to its most recent value while a simultaneous
 * change to something else survives alongside it. The final value of a gesture is always
 * dispatched, at worst one frame later — which is invisible next to the 100 ms `lookAhead`
 * every parameter write is already scheduled behind.
 *
 * ---
 *
 * **The XY pad deliberately does not use this**, and that is not an oversight to tidy up
 * later. Its gesture interleaves `noteOn`/`noteOff` with `setParam` — the detune has to be
 * in place when the note starts. Coalescing only the parameter half would reorder it
 * behind the note, and the symptom would be one frame of the wrong pitch at the start of
 * every pad note. It already carries the diff it needs (`onPadPitch` returns early when
 * the rounded detune is unchanged), which is what solved the flooding it actually had.
 *
 * The general rule that falls out: coalesce a stream of writes to the same parameter;
 * never coalesce one member of an ordered pair.
 */

import type { ParamPath, ParamValue } from '../../core/types';

/** Runs `flush` when the next frame is due. Injectable so a test need not chase a clock. */
export type ScheduleFlush = (flush: () => void) => void;

export interface ParamCoalescer {
  /** Record a change. Dispatched on the next scheduled flush, latest value per path. */
  change(path: ParamPath, value: ParamValue): void;
  /**
   * Dispatch everything pending immediately.
   *
   * Needed because `requestAnimationFrame` does not fire in a hidden tab: switch away
   * mid-drag and the last value would sit pending until the tab came back. Call it when a
   * gesture ends or the surface goes away.
   */
  flush(): void;
  /** Whether anything is waiting. For gates, and for deciding whether a flush is worth it. */
  readonly pending: number;
}

const nextFrame: ScheduleFlush = (flush) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
};

export function createParamCoalescer(
  dispatch: (path: ParamPath, value: ParamValue) => void,
  schedule: ScheduleFlush = nextFrame,
): ParamCoalescer {
  // A Map, so iteration order is insertion order: paths are dispatched in the order they
  // were first touched during the frame, which is the order the player moved them in.
  const waiting = new Map<ParamPath, ParamValue>();
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    if (waiting.size === 0) return;
    // Drained BEFORE dispatching. A dispatch synchronously re-renders and could call
    // `change` again; draining first means that lands in the NEXT frame rather than being
    // silently discarded by the clear below it.
    const batch = [...waiting];
    waiting.clear();
    for (const [path, value] of batch) dispatch(path, value);
  };

  return {
    change(path, value) {
      waiting.set(path, value);
      if (scheduled) return;
      scheduled = true;
      schedule(flush);
    },
    flush,
    get pending() {
      return waiting.size;
    },
  };
}
