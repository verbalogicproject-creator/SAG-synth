/**
 * src/tests/keyboard-geometry.test.ts — the derivation, checked without a browser.
 *
 * `xy-pad.browser.test.ts` is the important gate: it clicks the centre of each key the
 * browser actually painted and asserts the note that sounds. This file asserts the property
 * that makes the interpolation between those keys *legal* in the first place, which is
 * cheaper to state here than to infer from a pixel.
 *
 * The property is **monotonic in both axes**. `pitchAtFraction` walks the anchors looking
 * for the first whose `x` is at or past the position, and interpolates from the one before
 * it. That is only correct if x ascends; and the result is only a pitch surface — moving
 * right always raises the note — if the semitone ascends with it. An anchor table that
 * sorted correctly by x but zig-zagged in semitone would still pass every centre-of-key
 * assertion in the browser test and glide backwards between them.
 */

import { describe, expect, it } from 'vitest';
import {
  BLACK_KEYS,
  KEY_ANCHORS,
  WHITE_KEYS,
  noteName,
  pitchAtFraction,
} from '../clients/debug/keyboard';

describe('the key anchors are a valid interpolation table', () => {
  it('holds one anchor per drawn key and no more', () => {
    // Derived from the two tables, so this fails if a key is added to one and the
    // derivation is not what produced the anchors.
    expect(KEY_ANCHORS).toHaveLength(WHITE_KEYS.length + BLACK_KEYS.length);
  });

  it('ascends in x and in pitch together', () => {
    for (let i = 1; i < KEY_ANCHORS.length; i += 1) {
      const previous = KEY_ANCHORS[i - 1]!;
      const current = KEY_ANCHORS[i]!;
      expect(current.x, `${previous.label} -> ${current.label} does not move right`).toBeGreaterThan(
        previous.x,
      );
      expect(
        current.semitone,
        `${previous.label} -> ${current.label} does not rise in pitch`,
      ).toBeGreaterThan(previous.semitone);
    }
  });

  it('stays inside the keyboard', () => {
    for (const anchor of KEY_ANCHORS) {
      expect(anchor.x).toBeGreaterThan(0);
      expect(anchor.x).toBeLessThan(1);
    }
  });
});

describe('pitchAtFraction', () => {
  it('sounds each anchor exactly at its own centre', () => {
    const OCTAVE = 3;
    for (const anchor of KEY_ANCHORS) {
      const { note, detuneCents } = pitchAtFraction(anchor.x, OCTAVE);
      expect(note, `at the centre of ${anchor.label}`).toBe(noteName(OCTAVE, anchor.semitone));
      expect(Math.abs(detuneCents), `at the centre of ${anchor.label}`).toBeLessThan(1e-9);
    }
  });

  it('bends between two anchors instead of snapping to one', () => {
    // The whole reason a pad beats a row of buttons.
    const first = KEY_ANCHORS[0]!;
    const second = KEY_ANCHORS[1]!;
    const { detuneCents } = pitchAtFraction((first.x + second.x) / 2, 3);
    expect(Math.abs(detuneCents)).toBeGreaterThan(0);
  });

  it('clamps past either edge rather than running off the keyboard', () => {
    const lowest = KEY_ANCHORS[0]!;
    const highest = KEY_ANCHORS[KEY_ANCHORS.length - 1]!;
    expect(pitchAtFraction(-5, 3).note).toBe(noteName(3, lowest.semitone));
    expect(pitchAtFraction(5, 3).note).toBe(noteName(3, highest.semitone));
  });
});
