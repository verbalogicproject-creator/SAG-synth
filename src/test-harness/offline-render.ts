/**
 * src/test-harness/offline-render.ts — render audio while something changes part-way through.
 *
 * Every audio gate in this project renders a graph that is fully configured at time zero:
 * `render(drive)` in `tone-runtime.audio.test.ts` calls `drive` synchronously and then lets
 * the buffer play out. That answers "does this patch sound right", which is most of what
 * needs asking — and it cannot ask the one question a crackle is: **what happens to the
 * signal at the instant a parameter moves.**
 *
 * So this is the missing mechanism. `context.setTimeout` is used rather than a wall-clock
 * timer because Tone's own docs say it is "guaranteed by the clock source" and "also runs in
 * the offline context": `OfflineContext._renderClock` emits a tick per 128-sample block, and
 * inside the callback `Tone.now()` is the offline `currentTime` (offline `lookAhead` is 0).
 * A `.value =` write or a `rampTo` scheduled from in there lands exactly where asked.
 *
 * ---
 *
 * **The limitation, which is load-bearing and is asserted in this file's own test rather
 * than left as a footnote.**
 *
 * `OfflineContext.render()` runs the ENTIRE simulated clock, 0 → duration, before a single
 * sample is produced. AudioParam automation carries absolute times and is honoured, so a
 * stepped parameter really does render as a discontinuity at the right instant. But anything
 * NOT scheduled on an AudioParam — `connect`, `disconnect`, `dispose`, `new Tone.Gain`, a
 * `WaveShaper` curve assignment, a filter rebuild — is not automation. It happens during the
 * clock pass and therefore applies to the whole render.
 *
 * **This helper can see a stepped parameter. It cannot see graph churn at all.** A gate about
 * churn has to count calls, not measure audio — which is why `ToneRuntime` grows a
 * `lastApplied` affordance rather than being probed through a buffer.
 */

import * as Tone from 'tone';

/** Schedule `fn` to run when the offline clock reaches `seconds`. */
export type ScheduleAt = (seconds: number, fn: () => void) => void;

export interface OfflineRenderOptions {
  /** Rendered length. Default 1. */
  seconds?: number;
  /** Default 1 — mono, like every existing gate. Pass 2 to inspect the stereo field. */
  channels?: number;
  /** Default 44100. */
  sampleRate?: number;
}

export interface OfflineRender {
  /** Channel 0, for the mono assertions. */
  data: Float32Array;
  channels: readonly Float32Array[];
  sampleRate: number;
  /**
   * Sample index for a time in seconds, clamped to the buffer.
   *
   * Exists so no gate writes `Math.floor(t * SR)` by hand again — that expression appearing
   * in twenty tests is twenty chances to be off by a sample rate.
   */
  at(seconds: number): number;
}

/**
 * Render `seconds` of audio, running scheduled callbacks at their offline times.
 *
 * @param drive receives a scheduler. Build the graph immediately; schedule changes with it.
 */
export async function renderTimeline(
  drive: (at: ScheduleAt) => void,
  options: OfflineRenderOptions = {},
): Promise<OfflineRender> {
  const seconds = options.seconds ?? 1;
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 44100;

  const buffer = await Tone.Offline(
    (context) => {
      drive((when, fn) => {
        context.setTimeout(fn, when);
      });
    },
    seconds,
    channels,
    sampleRate,
  );

  const data = Array.from({ length: buffer.numberOfChannels }, (_unused, index) =>
    buffer.getChannelData(index),
  );
  const length = data[0]?.length ?? 0;

  return {
    data: data[0] ?? new Float32Array(0),
    channels: data,
    sampleRate,
    at: (when) => Math.max(0, Math.min(length, Math.round(when * sampleRate))),
  };
}
