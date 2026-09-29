/**
 * src/tests/pump-stats.test.ts — the late-event arithmetic, without a clock.
 */

import { describe, expect, it } from 'vitest';
import { emptyPumpStats, isNewWindow, recordDuplicate, recordWindow, summarise } from '../core/pump-stats';

describe('recordWindow', () => {
  it('counts nothing late when every event is ahead of the audio clock', () => {
    const stats = recordWindow(emptyPumpStats(), 10, 10.1, [10.1, 10.13]);
    expect(stats).toMatchObject({ windows: 1, events: 2, lateEvents: 0, worstLateMs: 0 });
    expect(stats.minHeadroomMs).toBeCloseTo(100, 9);
  });

  it('counts an event scheduled in the past as late, and how late', () => {
    // The main thread stalled: the pump ran at 10.25 for a window that started at 10.1.
    const stats = recordWindow(emptyPumpStats(), 10.25, 10.1, [10.1, 10.2, 10.3]);
    expect(stats.lateEvents).toBe(2);
    expect(stats.worstLateMs).toBeCloseTo(150, 9);
    expect(stats.minHeadroomMs).toBeCloseTo(-150, 9);
  });

  it('keeps the minimum headroom and the worst lateness across windows', () => {
    let stats = emptyPumpStats();
    stats = recordWindow(stats, 0, 0.1, []);
    stats = recordWindow(stats, 0.2, 0.15, [0.15]);
    stats = recordWindow(stats, 0.3, 0.4, [0.4]);
    expect(stats).toMatchObject({ windows: 3, events: 2, lateEvents: 1 });
    expect(stats.minHeadroomMs).toBeCloseTo(-50, 9);
    expect(stats.worstLateMs).toBeCloseTo(50, 9);
  });

  it('an event exactly at the clock is not late — Web Audio still honours it', () => {
    expect(recordWindow(emptyPumpStats(), 5, 5, [5]).lateEvents).toBe(0);
  });
});

describe('summarise', () => {
  it('reports no headroom before any window ran, rather than Infinity', () => {
    expect(summarise(emptyPumpStats())).toEqual({
      windows: 0,
      events: 0,
      lateEvents: 0,
      minHeadroomMs: null,
      worstLateMs: 0,
      duplicateWindows: 0,
    });
  });

  it('rounds to a tenth of a millisecond', () => {
    const stats = recordWindow(emptyPumpStats(), 1, 1.123456, []);
    expect(summarise(stats).minHeadroomMs).toBe(123.5);
  });
});

describe('isNewWindow — the pump is idempotent', () => {
  it('refuses a window at the same time as the last one, which Tone hands over twice online', () => {
    expect(isNewWindow(3.95859, 3.95859)).toBe(false);
    expect(isNewWindow(3.95859, 3.95859 + 1e-9)).toBe(false);
  });

  it('refuses a window from the past', () => {
    expect(isNewWindow(4, 3.9)).toBe(false);
  });

  it('accepts the next window, a 32nd later', () => {
    expect(isNewWindow(3.95859, 4.01032)).toBe(true);
  });

  it('accepts the first window of a play', () => {
    expect(isNewWindow(Number.NEGATIVE_INFINITY, 0)).toBe(true);
  });

  it('counts the duplicates it refused', () => {
    expect(recordDuplicate(recordDuplicate(emptyPumpStats())).duplicateWindows).toBe(2);
  });
});
