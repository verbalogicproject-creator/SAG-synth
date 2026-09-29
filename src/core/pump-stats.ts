/**
 * src/core/pump-stats.ts — how close the transport came to missing its own deadlines.
 *
 * Eyal heard the sequencer go "off beat sometimes" on the phone. The mechanism is in Tone's
 * source: the worker clock posts ticks, but the tick CALLBACK runs on the main thread
 * (`Tone/core/clock/Ticker.ts`), and `Clock._loop` then schedules every tick it missed with
 * that tick's original time. If the main thread stalls for longer than the lookahead, those
 * times are already in the past, Web Audio plays them immediately, and a run of notes lands
 * bunched together. Nothing measured it.
 *
 * So every pump window reports two things against the audio clock at the moment the pump
 * ran: its HEADROOM (how far in the future its window starts — the lookahead that was left
 * after whatever the main thread was busy with) and every event it scheduled in the PAST.
 * A late event is not a guess about timing; it is `at < currentTime`, the exact condition
 * under which Web Audio starts a thing "now" instead of when it was asked to.
 *
 * Pure (D2) so the arithmetic is a runner test; the runtime only feeds it numbers.
 */

export interface PumpStats {
  /** Pump windows seen since the last reset. */
  windows: number;
  /** Events scheduled. */
  events: number;
  /** Events whose time was already in the past when scheduled — played late, by definition. */
  lateEvents: number;
  /** The smallest headroom any window had, in ms. Negative means a window started late. */
  minHeadroomMs: number;
  /** How late the latest late event was, in ms. 0 when none was late. */
  worstLateMs: number;
  /**
   * Windows the pump was handed a SECOND time and skipped. Found on the device, not by
   * theory: online, Tone's repeat event sometimes invokes the same window twice (its tick
   * arithmetic drifts — 23.999999999995453, 744.0000000000018 — so a rounding mismatch
   * creates a duplicate). Offline the clock is exact and it never happens, which is why the
   * offline gates never saw it. Each duplicate used to re-schedule the window: every bass
   * note attacked twice 0.1 ms apart (a click) and the kick threw on its second start,
   * aborting the window. 182 page errors in one minute of play on the phone.
   */
  duplicateWindows: number;
}

/**
 * Whether a pump window at `time` is new. Windows advance with the audio clock, so a window
 * whose time is not later than the last one processed is a repeat, and processing it again
 * would schedule everything in it twice. The tolerance is far below a window (~52 ms) and
 * far above float noise.
 */
export const DUPLICATE_WINDOW_TOLERANCE = 1e-4;

export function isNewWindow(lastTime: number, time: number): boolean {
  return time > lastTime + DUPLICATE_WINDOW_TOLERANCE;
}

export function recordDuplicate(stats: PumpStats): PumpStats {
  return { ...stats, duplicateWindows: stats.duplicateWindows + 1 };
}

export function emptyPumpStats(): PumpStats {
  return {
    windows: 0,
    events: 0,
    lateEvents: 0,
    minHeadroomMs: Number.POSITIVE_INFINITY,
    worstLateMs: 0,
    duplicateWindows: 0,
  };
}

/**
 * Fold one pump window into the running stats.
 *
 * @param now        the audio clock (`AudioContext.currentTime`) when the pump ran
 * @param windowTime the time the window starts at, as Tone handed it to the pump
 * @param eventTimes the times of every event the window scheduled
 */
export function recordWindow(
  stats: PumpStats,
  now: number,
  windowTime: number,
  eventTimes: readonly number[],
): PumpStats {
  let lateEvents = stats.lateEvents;
  let worstLateMs = stats.worstLateMs;
  for (const at of eventTimes) {
    if (at < now) {
      lateEvents += 1;
      worstLateMs = Math.max(worstLateMs, (now - at) * 1000);
    }
  }
  return {
    ...stats,
    windows: stats.windows + 1,
    events: stats.events + eventTimes.length,
    lateEvents,
    minHeadroomMs: Math.min(stats.minHeadroomMs, (windowTime - now) * 1000),
    worstLateMs,
  };
}

/** Rounded for a log line; `minHeadroomMs` is null before any window has run. */
export function summarise(stats: PumpStats): Record<string, number | null> {
  return {
    windows: stats.windows,
    events: stats.events,
    lateEvents: stats.lateEvents,
    minHeadroomMs: Number.isFinite(stats.minHeadroomMs) ? Math.round(stats.minHeadroomMs * 10) / 10 : null,
    worstLateMs: Math.round(stats.worstLateMs * 10) / 10,
    duplicateWindows: stats.duplicateWindows,
  };
}
