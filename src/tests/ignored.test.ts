/**
 * src/tests/ignored.test.ts — the surface's reasons agree with the runtime's gaps.
 *
 * Two descriptions of the same fact exist on purpose: the runtime says
 * `oscillator.0.width.sawtooth` to a diagnostic list, and `ignoredIn` says "only a pulse
 * has width" under a knob. Two vocabularies for one audience each is fine. Two OPINIONS is
 * the defect this project has shipped six times, so the agreement is gated rather than
 * assumed.
 */

import { describe, expect, it } from 'vitest';
import { ignoredIn, ignoredReason } from '../core/ignored';
import { defaultPreset } from '../core/state';
import { unsupportedOscillatorFeatures } from '../runtime';
import type { SupportedWaveShape, SynthPreset } from '../core/types';

function patchWith(mutate: (patch: SynthPreset) => void): SynthPreset {
  const patch = defaultPreset();
  mutate(patch);
  return patch;
}

/** Every oscillator shape crossed with the settings that can conflict with it. */
const SHAPES: SupportedWaveShape[] = ['sine', 'triangle', 'sawtooth', 'square', 'pulse', 'pwm', 'noise'];

describe('the surface and the runtime agree about what is ignored', () => {
  it('names the same oscillator addresses the runtime reports, for every shape', () => {
    for (const type of SHAPES) {
      for (const width of [0, 0.4]) {
        for (const count of [1, 4]) {
          const patch = patchWith((p) => {
            p.voice.oscillators = [{ ...p.voice.oscillators[0]!, type, width, count }];
          });

          const fromRuntime = unsupportedOscillatorFeatures(patch.voice.oscillators[0]!, 0);
          const fromSurface = ignoredIn(patch)
            .filter((note) => note.path.startsWith('voice.oscillators.'))
            .map((note) => note.path);

          // The two speak about the same facts at different granularity, which is the
          // point of having both: the runtime names a FEATURE for a diagnostic list, the
          // surface names the CONTROL a player is looking at. `oscillator.0.noise` is the
          // type control; one unison gap is two controls. Normalise, then compare.
          const runtimeKeys = new Set(
            fromRuntime
              .map((gap) => gap.split('.')[2])
              .map((key) => (key === 'unison' ? 'count' : key === 'noise' ? 'type' : key)),
          );
          const surfaceKeys = new Set(
            fromSurface.map((path) => path.split('.')[3]).map((key) => (key === 'spread' ? 'count' : key)),
          );

          expect(
            [...surfaceKeys].sort(),
            `${type} width=${width} count=${count}`,
          ).toEqual([...runtimeKeys].sort());
        }
      }
    }
  });

  it('says nothing at all about the factory patch', () => {
    // A state that is always on is furniture. The patch that ships must be honourable in
    // full, or the first thing a player sees is a wall of amber.
    expect(ignoredIn(defaultPreset())).toEqual([]);
  });
});

describe('the reasons a player reads', () => {
  it('explains a width that has nowhere to land, naming the shape', () => {
    const patch = patchWith((p) => {
      p.voice.oscillators = [{ ...p.voice.oscillators[0]!, type: 'sawtooth', width: 0.5 }];
    });

    expect(ignoredReason(patch, 'voice.oscillators.0.width')).toBe(
      'only a pulse has width — this is a sawtooth',
    );
    // And the width control on a pulse is live, so the state tracks the patch.
    const pulse = patchWith((p) => {
      p.voice.oscillators = [{ ...p.voice.oscillators[0]!, type: 'pulse', width: 0.5 }];
    });
    expect(ignoredReason(pulse, 'voice.oscillators.0.width')).toBeUndefined();
  });

  it('marks both halves of unison, because both controls are on screen', () => {
    const patch = patchWith((p) => {
      p.voice.oscillators = [{ ...p.voice.oscillators[0]!, type: 'pwm', count: 4 }];
    });

    expect(ignoredReason(patch, 'voice.oscillators.0.count')).toBe('no unison on a pwm');
    expect(ignoredReason(patch, 'voice.oscillators.0.spread')).toBe('no unison on a pwm');
  });

  it('finally says something about lfo sync', () => {
    // The decoy found on 2026-07-31: four toggles that changed no sound and reported
    // nothing. The runtime now reports them; this is the half a player can see.
    const patch = patchWith((p) => {
      p.voice.lfos = [
        { id: 'l0', enabled: true, type: 'sine', frequency: 4, sync: true, retrigger: true },
      ];
    });

    expect(ignoredReason(patch, 'voice.lfos.0.sync')).toContain('transport');
    expect(ignoredReason(patch, 'voice.lfos.0.retrigger')).toContain('shared');
    // The rate itself is honoured — it is a real 4 Hz — so it must NOT be marked.
    expect(ignoredReason(patch, 'voice.lfos.0.frequency')).toBeUndefined();
  });

  it('marks a synced rate, which really does run at the wrong speed', () => {
    const patch = patchWith((p) => {
      p.voice.lfos = [
        { id: 'l0', enabled: true, type: 'sine', frequency: '8n', sync: false, retrigger: false },
      ];
    });

    expect(ignoredReason(patch, 'voice.lfos.0.frequency')).toContain('1 Hz');
  });

  it('gives every note a real sentence, not a code', () => {
    const patch = patchWith((p) => {
      p.voice.oscillators = [{ ...p.voice.oscillators[0]!, type: 'noise', width: 0.3, count: 2 }];
      p.voice.lfos = [
        { id: 'l0', enabled: true, type: 'sine', frequency: '8n', sync: true, retrigger: true },
      ];
    });

    for (const note of ignoredIn(patch)) {
      expect(note.reason.length, `${note.path} has no reason`).toBeGreaterThan(10);
      expect(note.reason, `${note.path} reads like an identifier`).not.toMatch(/^[a-z]+\.[a-z]/);
    }
  });
});
