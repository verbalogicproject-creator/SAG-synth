/**
 * src/tests/shell.browser.test.ts — one engine, one surface.
 *
 * Adding a second mount point is how this project silences a tab. On 2026-07-30 three
 * engine ids reported from one page and the sound stopped; the `globalThis` slot exists
 * because a module variable dies with its module and a hot update builds a second graph
 * that nothing holds a reference to.
 *
 * The instrument makes that risk live again, so both halves are gated: the routing picks
 * exactly one surface, and both surfaces resolve to the same engine.
 */

import { describe, expect, it } from 'vitest';
import { isDebugSurface } from '../clients/surface-route';
import { getEngine } from '../clients/engine';

describe('the hash decides which surface, and only one', () => {
  it('sends #debug to the wall and everything else to the instrument', () => {
    expect(isDebugSurface('#debug')).toBe(true);
    expect(isDebugSurface('debug')).toBe(true);
    // A query on the hash still means debug — a bookmarked `#debug?x=1` must not silently
    // land a developer on the instrument while they think they are on the wall.
    expect(isDebugSurface('#debug?trace=1')).toBe(true);

    expect(isDebugSurface('')).toBe(false);
    expect(isDebugSurface('#')).toBe(false);
    expect(isDebugSurface('#osc')).toBe(false);
    // Near misses go to the instrument rather than half-matching.
    expect(isDebugSurface('#debugger')).toBe(false);
    expect(isDebugSurface('#not-debug')).toBe(false);
  });
});

describe('both surfaces share one audio graph', () => {
  it('returns the same engine however many times it is asked', () => {
    // The property the `globalThis` slot exists for. If this ever returns two handles,
    // switching surfaces builds a second graph and the first keeps summing into the
    // destination with nothing referencing it.
    const first = getEngine();
    const second = getEngine();

    expect(second).toBe(first);
    expect(second.dispatcher).toBe(first.dispatcher);
    expect(second.runtime).toBe(first.runtime);
    expect(second.instanceId).toBe(first.instanceId);
  });

  it('keeps the slot on globalThis, not in the module', () => {
    // The subtle half, and the one that actually bit. A module-scoped variable is fresh in
    // every hot-updated copy of its module, so the new copy cannot find the old graph to
    // dispose of it. Asserting the slot is reachable from globalThis is asserting that a
    // second copy of this module would find the same engine.
    const engine = getEngine();
    const slot = (globalThis as Record<string, unknown>)['__sagSynthEngine__'];

    expect(slot).toBe(engine);
  });
});
