/**
 * src/tests/telemetry.audio.test.ts — the runtime reports its headroom, or says nothing.
 *
 * The crackle report that started Phase C arrived as "there are cracks when I play a note
 * and change a parameter". That was enough to find three real defects and it could not, by
 * itself, separate any of them from the device simply running out of headroom. So
 * `observeAudio` now carries `base_latency`, `output_latency`, `render_capacity` and
 * `underrun_ratio`.
 *
 * **The contract under test is the ABSENCE, not the presence.** Every one of those keys is
 * optional and is emitted only where the running browser publishes it. An absent key means
 * "this browser did not say", which is a different fact from zero, and reporting a
 * confident 0 for a load nobody measured would put a reassuring number in front of exactly
 * the situation with no data behind it. Same rule `level_db`'s null already encodes (F76).
 *
 * An offline render is the ordinary case for absence — `OfflineAudioContext` has no sink,
 * so it has no latency to report — and every other audio gate in this project runs inside
 * one. Without this file that silence would look like working telemetry forever.
 */

import * as Tone from 'tone';
import { describe, expect, it } from 'vitest';
import {
  SYNTH_AUDIO_OBSERVED_OPTIONAL_SLOTS,
  SYNTH_AUDIO_OBSERVED_REQUIRED_SLOTS,
} from '../core/sag/events';
import { defaultPreset } from '../core/state';
import { ToneRuntime } from '../runtime';

const HEADROOM_SLOTS = [
  'base_latency',
  'output_latency',
  'render_capacity',
  'underrun_ratio',
] as const;

describe('the headroom slots are declared before they are emitted', () => {
  it('every one of them is an OPTIONAL slot, never a required one', () => {
    // Declare-before-emit, and the required/optional split is load-bearing rather than
    // bookkeeping: a consumer may assume a required slot is always present. None of these
    // can promise that, because no browser promises it.
    for (const slot of HEADROOM_SLOTS) {
      expect(SYNTH_AUDIO_OBSERVED_OPTIONAL_SLOTS, `${slot} is not declared`).toContain(slot);
      expect(SYNTH_AUDIO_OBSERVED_REQUIRED_SLOTS as readonly string[]).not.toContain(slot);
    }
  });
});

describe('observeAudio in an offline context', () => {
  it('OMITS the headroom keys rather than reporting zero for them', async () => {
    // The negative probe for the whole feature, and the reason it is not a footnote:
    // `OfflineAudioContext` has neither `baseLatency` nor `outputLatency` nor
    // `renderCapacity`. `'base_latency' in event` is asserted rather than
    // `event.base_latency === undefined`, because an explicitly-assigned `undefined`
    // would satisfy the second and still serialise into JSON as a present null.
    let event: Record<string, unknown> = {};
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(defaultPreset());
        event = runtime.observeAudio() as unknown as Record<string, unknown>;
      },
      0.05,
      1,
      44100,
    );

    // The observation itself has to be real, or "no headroom keys" is trivially true.
    expect(event.context_state, 'no observation was made at all').toBeTypeOf('string');
    expect(event.voices).toBe(0);

    for (const slot of HEADROOM_SLOTS) {
      expect(Object.hasOwn(event, slot), `${slot} was emitted by an offline context`).toBe(false);
    }
  });
});

describe('observeAudio against a real AudioContext', () => {
  it('reports the latencies the platform publishes, and only those', async () => {
    // Deliberately NOT inside `Tone.Offline`: this is the live path, where a browser does
    // have a sink to be late against. It is the half that proves the guard is a guard and
    // not a permanent "no".
    //
    // Which keys appear is a property of the browser, not of this code, so the assertion
    // is conditional by design — what it refuses is a key that appears with a value that
    // is not a real measurement. A gate that demanded `render_capacity` would fail on
    // every non-Chromium browser for being correct.
    const runtime = new ToneRuntime();
    try {
      const event = runtime.observeAudio();
      const raw = Tone.getContext().rawContext as unknown as { baseLatency?: number };

      // Chromium publishes `baseLatency`, and these tests run in Chromium — so if the
      // context offers it, the event must carry it. That is the wiring under test.
      if (typeof raw.baseLatency === 'number') {
        expect(event.base_latency, 'the context offers baseLatency and the event dropped it')
          .toBe(raw.baseLatency);
      }

      for (const slot of HEADROOM_SLOTS) {
        if (!Object.hasOwn(event, slot)) continue;
        const value = (event as unknown as Record<string, unknown>)[slot];
        expect(value, `${slot} was emitted as a non-number`).toBeTypeOf('number');
        expect(Number.isFinite(value as number), `${slot} was emitted as ${value}`).toBe(true);
      }
    } finally {
      runtime.dispose();
    }
  });

  it('survives dispose without throwing, twice', () => {
    // The capacity observer holds a callback into the runtime, so dispose has to stop it —
    // an undisposed one keeps a whole runtime alive across a hot reload, which is the
    // two-live-instances leak `instance_id` exists to make visible. Disposing twice is the
    // realistic case (React strict mode, and the app's own cleanup).
    const runtime = new ToneRuntime();
    expect(() => {
      runtime.dispose();
      runtime.dispose();
    }).not.toThrow();
  });
});
