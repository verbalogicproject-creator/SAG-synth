/**
 * src/clients/use-audio-observation.ts — ship a measurement of the master bus, on a timer.
 *
 * Extracted from `DebugApp`, which was the only surface that ever emitted one. That was
 * the bug: `/__sag/observe` on the Android shell returned `[]` forever, because the
 * INSTRUMENT — the surface anyone actually plays, and the only one running when the
 * question is "is this crackling on the phone" — reported nothing at all. The telemetry
 * that exists to answer that question (`render_capacity`, `underrun_ratio`) had never
 * produced a single reading on a device.
 *
 * A hook rather than a copied `useEffect`, because two surfaces observing on two
 * independently-drifting cadences would make the resulting log unreadable: a gap would
 * mean "the graph stopped" on one surface and "this is just how that screen samples" on
 * the other.
 */

import { useEffect } from 'react';
import type { SagObserver, SynthAudioObservedEvent } from '../core/sag/events';

/** Structural, not `ToneRuntime`: the only thing this needs is the measurement. */
type AudioObservable = {
  observeAudio(): Omit<SynthAudioObservedEvent, 'instance_id' | 'observed_at'>;
};

/**
 * 500 ms, chosen against what it must catch — a note's decay, a graph that stopped, a
 * second engine appearing. Fast enough to see any of those, slow enough that the buffer
 * holds a hundred seconds of history at its ceiling.
 */
export const OBSERVATION_INTERVAL_MS = 500;

/**
 * Deliberately `setInterval` and not `requestAnimationFrame`.
 *
 * rAF drives displays and stops when the tab is hidden. A synth that goes quiet when
 * backgrounded is exactly the thing worth recording, and rAF would fall silent at the
 * same moment as the evidence.
 */
export function useAudioObservation(
  runtime: AudioObservable,
  observer: SagObserver,
  instanceId: string,
): void {
  useEffect(() => {
    const id = setInterval(() => {
      observer.observe({
        ...runtime.observeAudio(),
        instance_id: instanceId,
        observed_at: Date.now(),
      });
    }, OBSERVATION_INTERVAL_MS);
    return () => clearInterval(id);
  }, [runtime, observer, instanceId]);
}
