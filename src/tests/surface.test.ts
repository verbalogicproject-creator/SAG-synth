/**
 * src/tests/surface.test.ts — the emitted surface, generated and drift-gated by one file.
 *
 * `public/sag-surface.json` is committed, so it can go stale, and a stale awareness layer
 * is worse than none: it answers confidently about a control that moved. The file snapshot
 * makes the generator and the checker the same code — the suite fails the moment the
 * emitted form stops matching what core would produce, and `vitest -u` is the only way to
 * update it, which keeps the change visible in a diff.
 *
 * No new dependency and no build step for this: `tsx` is not installed, and adding a
 * release-path tool to emit one JSON would be a heavier commitment than the artifact is
 * worth.
 */

import { describe, expect, it } from 'vitest';
import { buildSurface, serialiseSurface } from '../core/surface';
import { CONTROLS, resolveControl } from '../core/controls';
import { MODULATION_DESTINATIONS } from '../core/types';

describe('the emitted surface', () => {
  it('matches the committed public/sag-surface.json', async () => {
    // The drift gate. If this fails, the committed artifact and core disagree — run
    // `npx vitest run -u src/tests/surface.test.ts` and read the diff before accepting it.
    await expect(serialiseSurface()).toMatchFileSnapshot('../../public/sag-surface.json');
  });

  it('describes every control exactly once', () => {
    const surface = buildSurface();
    expect(surface.counts.controls).toBe(CONTROLS.length);
    expect(surface.controls).toHaveLength(CONTROLS.length);

    const ids = surface.controls.map((control) => control.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('agrees with the wiring table it is reporting', () => {
    const surface = buildSurface();
    const described = surface.controls.filter((control) => control.modulation !== undefined);

    expect(described).toHaveLength(MODULATION_DESTINATIONS.length);
    expect(described.filter((control) => control.modulation?.wired)).toHaveLength(
      surface.counts.wired,
    );
    expect(surface.counts.wired + surface.counts.unwired).toBe(surface.counts.destinations);
  });

  it('marks the delay mix live as a control and unwired as a target', () => {
    // The distinction the whole artifact has to get right. `effects.delay.wet` is a
    // working parameter — the knob changes the sound, which tone-runtime.audio.test.ts
    // proves — and is simultaneously a modulation destination that no cable reaches. A
    // surface that collapsed those two into one "unwired" flag would dim a control that
    // works, which is a decoy pointed the other way.
    const wet = buildSurface().controls.find((c) => c.path === 'effects.delay.wet');

    expect(wet?.name).toBe('delay mix');
    expect(wet?.location).toEqual({ kind: 'tab', tab: 'fx', group: 'fx' });
    expect(wet?.modulation?.wired).toBe(false);
    // And nothing at the top level says the control itself is dead, because it is not.
    expect(wet).not.toHaveProperty('wired');
  });

  it('carries enough for an agent to drive a control it has never seen', () => {
    // The reason the file exists. Everything needed to turn a knob correctly — where it
    // is, what to call it, what it accepts — without reading any TypeScript.
    const cutoff = buildSurface().controls.find((c) => c.id === 'ctl-011');

    expect(cutoff).toMatchObject({
      path: 'voice.filterEnvelope.baseFrequency',
      name: 'filter cutoff',
      widget: 'knob',
      location: { kind: 'tab', tab: 'filter', group: 'filter' },
      kind: 'number',
      range: [20, 20000],
      unit: 'Hz',
      modulation: { curve: 'octaves', perVoice: true, wired: true },
    });

    // And the name in the file is the name that resolves, so an agent reading the artifact
    // and an agent talking to a human are using one vocabulary.
    expect(resolveControl(cutoff!.name)?.id).toBe('ctl-011');
  });

  it('states the value space for every kind, so nothing has to be guessed', () => {
    const surface = buildSurface();
    for (const control of surface.controls) {
      switch (control.kind) {
        case 'number':
          expect(control.range, `${control.id} is a number with no range`).toBeDefined();
          break;
        case 'enum':
          expect(control.choices?.length, `${control.id} is an enum with no choices`).toBeGreaterThan(
            0,
          );
          break;
        default:
          break;
      }
    }
  });
});
