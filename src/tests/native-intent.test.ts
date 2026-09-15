/**
 * src/tests/native-intent.test.ts — which surface a deep link asks for.
 *
 * Pure, so it is a runner test. The side effect it feeds (setting the hash and reloading)
 * lives in `main.tsx`, which mounts on import and therefore cannot be tested here — that
 * separation is why `surface-route.ts` exists as its own module at all.
 */

import { describe, expect, it } from 'vitest';
import { hashForSurface, isDebugSurface, surfaceFromIntent } from '../clients/surface-route';

describe('surfaceFromIntent', () => {
  it.each([
    ['sagsynth://debug', 'debug'],
    ['sagsynth:///debug', 'debug'],
    ['sagsynth://debug/', 'debug'],
    ['sagsynth://debug?from=adb', 'debug'],
    ['sagsynth://open#debug', 'debug'],
    ['sagsynth://#debug', 'debug'],
    ['SAGSYNTH://DEBUG', 'debug'],
  ])('%s -> %s', (uri, expected) => {
    expect(surfaceFromIntent(uri)).toBe(expected);
  });

  it.each([
    ['sagsynth://', 'instrument'],
    ['sagsynth://instrument', 'instrument'],
    ['sagsynth://debugger', 'instrument'],
    ['sagsynth://x/debug', 'instrument'],
    ['sagsynth://open#debugger', 'instrument'],
    ['', 'instrument'],
    ['not a uri at all', 'instrument'],
  ])('%s -> %s', (uri, expected) => {
    expect(surfaceFromIntent(uri)).toBe(expected);
  });

  it('opens the instrument for anything it cannot read', () => {
    // A deep link that fails to parse should land on the thing the user was reaching
    // for, never on a diagnostic wall.
    expect(surfaceFromIntent('sagsynth://%%%')).toBe('instrument');
  });

  it('agrees with the hash predicate main.tsx already mounts on', () => {
    // The two must not drift: one decides at boot from location.hash, the other decides
    // from an intent and then SETS that hash.
    expect(isDebugSurface(hashForSurface('debug'))).toBe(true);
    expect(isDebugSurface(hashForSurface('instrument'))).toBe(false);
  });
});

describe('hashForSurface', () => {
  it('is empty for the instrument, so a deep link home leaves no fragment behind', () => {
    expect(hashForSurface('instrument')).toBe('');
    expect(hashForSurface('debug')).toBe('#debug');
  });
});
