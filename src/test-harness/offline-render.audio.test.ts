/**
 * src/test-harness/offline-render.audio.test.ts — the instrument, checked before it is used.
 *
 * `renderTimeline` is about to be the sole evidence for whether the crackle is fixed, so it
 * gets the same treatment as any other gate: proven to do what it claims, and proven to fail
 * when it should. Four claims, and the fourth is the one that matters most.
 *
 * 1. A scheduled change happens at its time and not before.
 * 2. A stepped parameter renders as a discontinuity the assertions can see.
 * 3. A ramped one, at the same instant, does not — so the instrument tells the two apart,
 *    which is the entire premise of the fix.
 * 4. **Graph churn is invisible to it.** Asserted rather than footnoted, so nobody later
 *    writes a churn gate through this helper and gets a green that means nothing.
 */

import * as Tone from 'tone';
import { describe, expect, it } from 'vitest';
import { maxDiscontinuity, rms } from './audio-assertions';
import { renderTimeline } from './offline-render';

const SR = 44100;

/** A steady sine through a gain — the simplest graph a change can be observed against. */
function sineThroughGain(gainValue = 1): { source: Tone.Oscillator; gain: Tone.Gain } {
  const gain = new Tone.Gain(gainValue).toDestination();
  const source = new Tone.Oscillator({ type: 'sine', frequency: 220 }).connect(gain).start();
  return { source, gain };
}

describe('renderTimeline', () => {
  it('runs a scheduled change at its time and not before', async () => {
    const { data, at } = await renderTimeline(
      (schedule) => {
        const { gain } = sineThroughGain();
        schedule(0.5, () => {
          gain.gain.value = 0;
        });
      },
      { seconds: 1, sampleRate: SR },
    );

    // Loud before, silent after. If `setTimeout` did not fire in the offline context this
    // would be loud throughout; if it fired at time zero, silent throughout.
    expect(rms(data, at(0.1), at(0.45)), 'sounding before the change').toBeGreaterThan(0.1);
    expect(rms(data, at(0.55), at(1)), 'silenced after the change').toBeLessThan(0.001);
  });

  it('renders a stepped parameter as a discontinuity', async () => {
    const { data, at } = await renderTimeline(
      (schedule) => {
        const { gain } = sineThroughGain();
        schedule(0.5, () => {
          gain.gain.value = 0.2;
        });
      },
      { seconds: 1, sampleRate: SR },
    );

    // A 220 Hz sine's own sample-to-sample delta is about 0.031 at full scale, so a step of
    // 0.8 stands far above it. Measured against a quiet stretch of the same render rather
    // than an absolute number, so the assertion does not encode the sample rate.
    const quiet = maxDiscontinuity(data, at(0.2), at(0.45));
    const across = maxDiscontinuity(data, at(0.49), at(0.52));
    expect(across, 'a step should be visible as a jump').toBeGreaterThan(quiet * 5);
  });

  it('does not render a ramped parameter as a discontinuity', async () => {
    const { data, at } = await renderTimeline(
      (schedule) => {
        const { gain } = sineThroughGain();
        schedule(0.5, () => {
          gain.gain.linearRampTo(0.2, 0.02);
        });
      },
      { seconds: 1, sampleRate: SR },
    );

    // The same change, the same instant, the same window — declicked. This pair is what
    // makes the crackle gate falsifiable: the instrument demonstrably separates the two.
    const quiet = maxDiscontinuity(data, at(0.2), at(0.45));
    const across = maxDiscontinuity(data, at(0.49), at(0.52));
    expect(across, 'a 20 ms ramp should not read as a jump').toBeLessThan(quiet * 2);
  });

  it('cannot see graph churn, and that is asserted rather than assumed', async () => {
    // `filter.rolloff` disconnects and reconstructs its biquads. In a live context that is a
    // discontinuity; here the clock pass completes before the first sample, so the rebuild
    // applies to the whole render and leaves no mark at 0.5 s.
    //
    // This test exists so that a future churn gate written through this helper fails review
    // rather than passing vacuously. If it ever goes red, the helper's limitation changed
    // and every conclusion drawn from `lastApplied` should be revisited.
    const { data, at } = await renderTimeline(
      (schedule) => {
        const gain = new Tone.Gain(1).toDestination();
        const filter = new Tone.Filter({ type: 'lowpass', frequency: 2000, rolloff: -12 }).connect(
          gain,
        );
        new Tone.Oscillator({ type: 'sawtooth', frequency: 110 }).connect(filter).start();
        schedule(0.5, () => {
          filter.rolloff = -48;
        });
      },
      { seconds: 1, sampleRate: SR },
    );

    const quiet = maxDiscontinuity(data, at(0.2), at(0.45));
    const across = maxDiscontinuity(data, at(0.49), at(0.52));
    expect(across, 'offline rendering is blind to graph rebuilds — see the header').toBeLessThan(
      quiet * 2,
    );
  });
});
