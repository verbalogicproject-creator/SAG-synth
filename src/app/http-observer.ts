/**
 * src/app/http-observer.ts — ships audio observations to the dev server.
 *
 * The point of this file, stated plainly: it lets someone who is not holding the phone
 * find out whether the synth is making sound. Every audio gate in this project runs in an
 * offline render on a development machine, and the one failure that cost the most — a
 * silent synth that passed every one of them — was invisible to all of it. This is the
 * channel that would have answered it in one step.
 *
 * DEVELOPMENT ONLY. A musical instrument that reports on itself to a remote host during
 * normal use is a different product with different consent requirements. `createEngine`
 * wires `NullSagObserver` unless a caller explicitly opts in, and the receiving endpoint
 * exists only in the Vite dev server, so a production build has nowhere to send anything.
 *
 * Layer rule D2: `src/app/` may use browser APIs — `fetch` here, `indexedDB` in the
 * persistence adapter next door — but never `tone` and never `react`.
 */

import type { SagObserver, SynthAudioObservedEvent } from '../core/sag/events';

export interface HttpSagObserverOptions {
  /** Where the dev-server middleware is listening. */
  endpoint?: string;
  /** How often to flush the buffer, ms. */
  flushIntervalMs?: number;
  /**
   * Buffer ceiling. Reached only when the receiver is gone, and dropping the OLDEST is
   * the right call for telemetry: the newest measurement is the one that says what the
   * synth is doing now.
   */
  maxBuffered?: number;
}

const DEFAULTS = {
  endpoint: '/__sag/observe',
  flushIntervalMs: 2000,
  maxBuffered: 200,
} as const;

export class HttpSagObserver implements SagObserver {
  private readonly endpoint: string;
  private readonly flushIntervalMs: number;
  private readonly maxBuffered: number;

  private buffer: SynthAudioObservedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;

  constructor(options: HttpSagObserverOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULTS.endpoint;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
    this.maxBuffered = options.maxBuffered ?? DEFAULTS.maxBuffered;
  }

  /**
   * F78 — this must never be able to break playback. It is called from a polling loop that
   * shares a thread with the UI, so it does no I/O: it appends to an array and returns.
   * Everything that can fail happens on the timer.
   */
  observe(event: SynthAudioObservedEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.maxBuffered) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffered);
    }
    this.timer ??= setInterval(() => void this.flush(), this.flushIntervalMs);
  }

  /**
   * Chained, never concurrent — the same discipline the command journal's flush uses. Two
   * overlapping posts could deliver out of order, and an observation stream read as a
   * timeline is worth less if its timeline is wrong.
   */
  private async flush(): Promise<void> {
    if (this.inFlight || this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.inFlight = true;
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        keepalive: true,
      });
    } catch {
      // Swallowed on purpose, and not re-buffered. A dev server that went away must not
      // grow this array forever, and a dropped observation means nothing — losing one
      // sample of a periodic measurement is not a gap in a record, which is precisely the
      // property that kept this out of the command journal.
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.buffer = [];
  }
}
