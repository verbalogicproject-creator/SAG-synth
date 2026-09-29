/**
 * src/tests/param-coalescer.test.ts — a drag is one dispatch per frame, not one per move.
 *
 * Runs in node with an INJECTED scheduler rather than in a browser against a real
 * `requestAnimationFrame`. That is the point of the injection: a test that waited on real
 * frames would be asserting on the phone's compositor, which is the same mistake the CPU
 * probe made — a timing gate that fails for reasons unrelated to the code. Here "a frame
 * passed" is something the test decides, so the assertions are exact.
 *
 * The claim being gated has two halves and both matter:
 *   1. intermediate values collapse — N moves in one frame produce ONE dispatch;
 *   2. no value is lost — the last one always arrives.
 * A coalescer that dropped the final value would pass the first half beautifully, and
 * would be a control that stops where the finger left it minus a bit.
 */

import { describe, expect, it } from 'vitest';
import { createParamCoalescer } from '../clients/synth/param-coalescer';
import type { ParamPath, ParamValue } from '../core/types';

/** A scheduler the test drives by hand. `frame()` is "the screen refreshed". */
function manualScheduler(): { schedule: (flush: () => void) => void; frame: () => void } {
  let queued: (() => void) | null = null;
  return {
    schedule: (flush) => {
      queued = flush;
    },
    frame: () => {
      const run = queued;
      queued = null;
      run?.();
    },
  };
}

function recorder(): {
  dispatch: (path: ParamPath, value: ParamValue) => void;
  calls: { path: ParamPath; value: ParamValue }[];
} {
  const calls: { path: ParamPath; value: ParamValue }[] = [];
  return { dispatch: (path, value) => calls.push({ path, value }), calls };
}

const CUTOFF = 'voice.filterEnvelope.baseFrequency' as ParamPath;
const RESONANCE = 'voice.filter.Q' as ParamPath;

describe('createParamCoalescer', () => {
  it('collapses a 60-move drag to one dispatch per frame', () => {
    const { schedule, frame } = manualScheduler();
    const { dispatch, calls } = recorder();
    const coalescer = createParamCoalescer(dispatch, schedule);

    // Three frames' worth of pointer moves, 20 per frame — roughly what a real drag
    // produces on a 120 Hz digitiser against a 60 Hz screen.
    for (let f = 0; f < 3; f += 1) {
      for (let move = 0; move < 20; move += 1) {
        coalescer.change(CUTOFF, (f * 20 + move) as ParamValue);
      }
      frame();
    }

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.value)).toEqual([19, 39, 59]);
  });

  it('dispatches nothing at all until a frame is due', () => {
    // The negative half of the assertion above. Without it, a coalescer that dispatched
    // everything immediately AND on the frame would still produce three calls in a test
    // that only counted them at the end.
    const { schedule, frame } = manualScheduler();
    const { dispatch, calls } = recorder();
    const coalescer = createParamCoalescer(dispatch, schedule);

    coalescer.change(CUTOFF, 100 as ParamValue);
    coalescer.change(CUTOFF, 200 as ParamValue);
    expect(calls, 'dispatched before the frame').toHaveLength(0);
    expect(coalescer.pending).toBe(1);

    frame();
    expect(calls).toEqual([{ path: CUTOFF, value: 200 }]);
  });

  it('keeps separate paths separate rather than collapsing to the newest change', () => {
    // Last-value-wins is PER PATH. A single pending slot would look identical in the test
    // above and would silently drop one of two controls moved in the same frame — which is
    // exactly what the XY pad does, since it drives two parameters from one gesture.
    const { schedule, frame } = manualScheduler();
    const { dispatch, calls } = recorder();
    const coalescer = createParamCoalescer(dispatch, schedule);

    coalescer.change(CUTOFF, 1 as ParamValue);
    coalescer.change(RESONANCE, 2 as ParamValue);
    coalescer.change(CUTOFF, 3 as ParamValue);
    frame();

    // Insertion order, so the dispatch order is the order the player touched them in.
    expect(calls).toEqual([
      { path: CUTOFF, value: 3 },
      { path: RESONANCE, value: 2 },
    ]);
  });

  it('never loses the last value of a gesture', () => {
    const { schedule, frame } = manualScheduler();
    const { dispatch, calls } = recorder();
    const coalescer = createParamCoalescer(dispatch, schedule);

    for (let move = 0; move < 40; move += 1) coalescer.change(CUTOFF, move as ParamValue);
    frame();

    expect(calls.at(-1)?.value, 'the knob must stop where the finger left it').toBe(39);
    expect(coalescer.pending).toBe(0);
  });

  it('flushes on demand, for a hidden tab where no frame will ever come', () => {
    // `requestAnimationFrame` does not fire in a background tab. Lock the phone mid-drag
    // and without this the final value waits until the player comes back.
    const { schedule } = manualScheduler(); // deliberately never stepped
    const { dispatch, calls } = recorder();
    const coalescer = createParamCoalescer(dispatch, schedule);

    coalescer.change(CUTOFF, 7 as ParamValue);
    expect(calls).toHaveLength(0);

    coalescer.flush();
    expect(calls).toEqual([{ path: CUTOFF, value: 7 }]);
  });

  it('does not discard a change made from inside a dispatch', () => {
    // A dispatch re-renders synchronously, and a re-render can push another change. If the
    // pending map were cleared AFTER dispatching rather than before, that change would be
    // wiped without ever being sent — a value lost only under a condition no manual test
    // would think to reproduce.
    const { schedule, frame } = manualScheduler();
    const calls: ParamValue[] = [];
    let reentered = false;
    const coalescer = createParamCoalescer(
      (_path, value) => {
        calls.push(value);
        if (!reentered) {
          reentered = true;
          coalescer.change(RESONANCE, 99 as ParamValue);
        }
      },
      schedule,
    );

    coalescer.change(CUTOFF, 1 as ParamValue);
    frame();
    expect(calls).toEqual([1]);
    expect(coalescer.pending, 'the re-entrant change must survive to the next frame').toBe(1);

    frame();
    expect(calls).toEqual([1, 99]);
  });
});

describe('C5c — a channel is part of the key', () => {
  it('keeps one drag per channel, and sends each to the channel it was made on', () => {
    // The failure this prevents: a value still pending when the player taps another
    // channel would flush onto the NEW channel, silently editing a sound nobody touched.
    const { schedule, frame } = manualScheduler();
    const sent: Array<{ path: string; value: ParamValue; trackId?: string }> = [];
    const coalescer = createParamCoalescer(
      (path, value, trackId) => sent.push({ path, value, ...(trackId === undefined ? {} : { trackId }) }),
      schedule,
    );

    coalescer.change(CUTOFF, 1 as ParamValue, 'bass');
    coalescer.change(CUTOFF, 2 as ParamValue, 'bass'); // same channel: collapses
    coalescer.change(CUTOFF, 7 as ParamValue, 'lead'); // another channel: survives
    coalescer.change(CUTOFF, 9 as ParamValue); // the live patch: survives too
    expect(coalescer.pending).toBe(3);

    frame();
    expect(sent).toEqual([
      { path: CUTOFF, value: 2, trackId: 'bass' },
      { path: CUTOFF, value: 7, trackId: 'lead' },
      { path: CUTOFF, value: 9 },
    ]);
  });

  it('a value pending from one channel is not redirected by a later change on another', () => {
    const { schedule, frame } = manualScheduler();
    const sent: Array<{ value: ParamValue; trackId?: string }> = [];
    const coalescer = createParamCoalescer(
      (_path, value, trackId) => sent.push({ value, ...(trackId === undefined ? {} : { trackId }) }),
      schedule,
    );

    coalescer.change(RESONANCE, 4 as ParamValue, 'bass');
    coalescer.change(RESONANCE, 5 as ParamValue, 'lead');
    frame();

    expect(sent).toEqual([
      { value: 4, trackId: 'bass' },
      { value: 5, trackId: 'lead' },
    ]);
  });
});
