/**
 * src/tests/ahdsr.test.ts — the AHDSR arithmetic, without a clock.
 */

import { describe, expect, it } from 'vitest';
import {
  attackFrom,
  decayStart,
  effectiveFilterEnvelope,
  LINKED_FILTER_PATHS,
  logDecayCurve,
  silentAfter,
} from '../core/ahdsr';
import { ignoredIn } from '../core/ignored';
import { defaultPreset } from '../core/state';

describe('logDecayCurve', () => {
  const curve = logDecayCurve(1, 0.2, 32);

  it('is exact at both ends', () => {
    expect(curve).toHaveLength(32);
    expect(curve[0]).toBe(1);
    expect(curve[31]).toBeCloseTo(0.2, 12);
  });

  it('only ever falls', () => {
    for (let i = 1; i < curve.length; i += 1) expect(curve[i]!).toBeLessThanOrEqual(curve[i - 1]!);
  });

  it('holds up, then falls: above the straight line everywhere in between', () => {
    for (let i = 1; i < curve.length - 1; i += 1) {
      const straight = 1 + (0.2 - 1) * (i / 31);
      expect(curve[i]!).toBeGreaterThan(straight);
    }
  });

  it('never returns fewer than two points', () => {
    expect(logDecayCurve(1, 0, 0)).toEqual([1, 0]);
  });
});

describe('stage timing', () => {
  it('the decay starts after attack and hold', () => {
    expect(decayStart(0.002, 0.03)).toBeCloseTo(0.032, 12);
    expect(decayStart(0.002, -1)).toBe(0.002);
  });

  it('a sustain-0 note is silent after attack + hold + decay, not attack + decay', () => {
    expect(silentAfter({ attack: 0, hold: 0.03, decay: 0.06 })).toBeCloseTo(0.09, 12);
  });

  it('the psytrance bass fits its 16th: 0 + 30 ms + 60 ms is inside 103 ms at 145 BPM', () => {
    expect(silentAfter({ attack: 0, hold: 0.03, decay: 0.06 })).toBeLessThan(60 / 145 / 4);
  });
});

describe('attackFrom — a retrigger keeps the attack RATE', () => {
  it('runs the full attack from silence', () => {
    expect(attackFrom(0, 0.1)).toBe(0.1);
  });

  it('runs only the remaining distance from a level already up', () => {
    expect(attackFrom(0.75, 0.1)).toBeCloseTo(0.025, 12);
    expect(attackFrom(1, 0.1)).toBe(0);
  });
});

describe('effectiveFilterEnvelope — the filter following the amp', () => {
  function voice(linked: boolean) {
    const { voice } = defaultPreset();
    return {
      envelope: { attack: 0, hold: 0.03, decay: 0.06, decayCurve: 'logarithmic' as const, sustain: 0, release: 0.02 },
      filterEnvelope: { ...voice.filterEnvelope, attack: 0.4, hold: 0, decay: 2, sustain: 1, release: 3, linked },
    };
  }

  it('unlinked, is the filter envelope as stored — the same object', () => {
    const v = voice(false);
    expect(effectiveFilterEnvelope(v)).toBe(v.filterEnvelope);
  });

  it('linked, runs all six amp stages and keeps the filter\u2019s cutoff and amount', () => {
    const v = voice(true);
    expect(effectiveFilterEnvelope(v)).toEqual({
      ...v.envelope,
      baseFrequency: v.filterEnvelope.baseFrequency,
      octaves: v.filterEnvelope.octaves,
      linked: true,
    });
  });

  it('linking overwrites nothing: the filter\u2019s own stages are still stored', () => {
    const v = voice(true);
    effectiveFilterEnvelope(v);
    expect(v.filterEnvelope).toMatchObject({ attack: 0.4, decay: 2, sustain: 1, release: 3 });
  });

  it('the surface marks exactly the six linked stages as ignored, and only while linked', () => {
    const patch = defaultPreset();
    expect(ignoredIn(patch).filter((note) => note.path.startsWith('voice.filterEnvelope.'))).toEqual([]);
    patch.voice.filterEnvelope = { ...patch.voice.filterEnvelope, linked: true };
    const marked = ignoredIn(patch)
      .filter((note) => note.path.startsWith('voice.filterEnvelope.'))
      .map((note) => note.path);
    expect(marked.sort()).toEqual([...LINKED_FILTER_PATHS].sort());
    // Cutoff, amount and the link itself stay live.
    expect(marked).not.toContain('voice.filterEnvelope.baseFrequency');
    expect(marked).not.toContain('voice.filterEnvelope.linked');
  });
});
