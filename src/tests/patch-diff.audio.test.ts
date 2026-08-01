/**
 * src/tests/patch-diff.audio.test.ts — `applyPatch` writes only what changed.
 *
 * The dispatcher calls `applyPatch` on every `pointermove`, because `setParam` returns a
 * new patch document for any change and `syncRuntime` pushes on a changed reference. Until
 * this landed, one move rewrote every parameter of every live voice, rebuilt the distortion
 * curve, reconstructed Freeverb's dampening filters, and disposed and rebuilt the entire
 * modulation graph. That is the crackle, and most of it is not ramping — it is work.
 *
 * **Why this is a counting gate and not a listening one.** `Tone.Offline` completes its
 * whole clock pass before the first sample, so `connect`, `disconnect`, `dispose` and node
 * construction leave no mark in the buffer at all. `src/test-harness/offline-render.ts`
 * asserts that blindness in its own test rather than footnoting it. Churn is therefore
 * proven through `getLastApplied()`, which reports the sections the last call wrote.
 *
 * **The vacuity guards, which are the point.** A diff can fail in two directions and both
 * look green from most angles:
 *
 * - degenerate to "nothing ever changed" — every write silently stops happening, and every
 *   test that only asserts *absence* still passes. Caught by the first-call test, which
 *   demands the complete section list.
 * - degenerate to "everything always changed" — the diff does nothing and the crackle
 *   remains. Caught by every single-section assertion below.
 *
 * The audio tests are the other half: `lastApplied` is a readout of the control variable,
 * so it proves which branches ran, and the renders prove the branches were the right ones.
 */

import { describe, expect, it } from 'vitest';
import * as Tone from 'tone';
import { PATCH_SECTIONS, ToneRuntime } from '../runtime';
import { rms } from '../test-harness/audio-assertions';
import { renderTimeline } from '../test-harness/offline-render';
import { defaultLfo, defaultPreset } from '../core/state';
import type { ModRoute, SynthPreset } from '../core/types';

const SR = 44100;

/**
 * Run `drive` against a real runtime inside an offline context and report what it saw.
 *
 * The runtime must be constructed INSIDE `Tone.Offline` — one built outside wires itself
 * to the online destination. Nothing here is rendered; the context exists only so the
 * nodes are real.
 */
async function inspect<T>(drive: (runtime: ToneRuntime) => T): Promise<T> {
  let result: T | undefined;
  await Tone.Offline(
    () => {
      result = drive(new ToneRuntime());
    },
    0.01,
    1,
    SR,
  );
  return result as T;
}

/** A patch with one duck route from LFO 0 onto `voice.amplitude`. */
function duckingPatch(amplitude: number): SynthPreset {
  const base = defaultPreset();
  const route: ModRoute = {
    id: 'route-duck',
    enabled: true,
    source: 'lfo.0',
    destination: 'voice.amplitude',
    depth: 0.5,
  };
  return {
    ...base,
    voice: {
      ...base.voice,
      amplitude,
      // A slow LFO so a one-second render sits on roughly one part of the cycle rather
      // than averaging the whole swing away.
      lfos: [{ ...defaultLfo(), id: 'lfo-duck', frequency: 0.5 }],
      modRoutes: [route],
      envelope: { attack: 0.01, decay: 0.01, sustain: 1, release: 0.5 },
    },
  };
}

describe('applyPatch writes only the sections that changed', () => {
  it('writes every section on the first call, because there is nothing to have kept', async () => {
    // The anti-vacuity guard for the whole file. Without it the diff could degenerate to a
    // permanent no-op — no writes, no sound, and every "did not write X" assertion below
    // still green.
    const applied = await inspect((runtime) => {
      runtime.applyPatch(defaultPreset());
      return runtime.getLastApplied();
    });

    expect(applied).toEqual([...PATCH_SECTIONS]);
  });

  it('writes nothing when handed the same document twice', async () => {
    const applied = await inspect((runtime) => {
      const patch = defaultPreset();
      runtime.applyPatch(patch);
      runtime.applyPatch(patch);
      return runtime.getLastApplied();
    });

    expect(applied).toEqual([]);
  });

  it('writes one section for a one-parameter change, and never `routes`', async () => {
    // The phase's headline claim: turning an ordinary knob does not touch the modulation
    // graph. `rewireRoutes` disposes every scaler and reconnects every LFO, and it used to
    // do that on every pointer move.
    const cases: { label: string; expected: string; change: (p: SynthPreset) => SynthPreset }[] = [
      {
        label: 'filter Q',
        expected: 'filter',
        change: (p) => ({ ...p, voice: { ...p.voice, filter: { ...p.voice.filter, Q: 4 } } }),
      },
      {
        label: 'reverb room size',
        expected: 'reverb',
        change: (p) => ({
          ...p,
          effects: { ...p.effects, reverb: { ...p.effects.reverb, roomSize: 0.8 } },
        }),
      },
      {
        label: 'delay feedback',
        expected: 'delay',
        change: (p) => ({
          ...p,
          effects: { ...p.effects, delay: { ...p.effects.delay, feedback: 0.6 } },
        }),
      },
      {
        label: 'amp envelope',
        expected: 'envelope',
        change: (p) => ({
          ...p,
          voice: { ...p.voice, envelope: { ...p.voice.envelope, attack: 0.4 } },
        }),
      },
      {
        label: 'voice pan',
        expected: 'pan',
        change: (p) => ({ ...p, voice: { ...p.voice, pan: -0.7 } }),
      },
    ];

    for (const { label, expected, change } of cases) {
      const applied = await inspect((runtime) => {
        const before = defaultPreset();
        runtime.applyPatch(before);
        runtime.applyPatch(change(before));
        return runtime.getLastApplied();
      });

      expect(applied, `${label} should write exactly ['${expected}']`).toEqual([expected]);
    }
  });

  it('rewires when the route list, the LFO set, or the amplitude changes', async () => {
    // Three inputs, one section. The third is the one that reads redundant: see
    // `SECTION_INPUTS` — `routeSwing` takes `voice.amplitude` as the base for the depth
    // scaler and for the `duckDb` curve's re-centred resting value, so amplitude is an
    // input to the wiring rather than a parameter the wiring ignores.
    const applied = await inspect((runtime) => {
      const before = duckingPatch(1);
      runtime.applyPatch(before);
      runtime.applyPatch({ ...before, voice: { ...before.voice, amplitude: 0.4 } });
      return runtime.getLastApplied();
    });

    expect(applied).toEqual(['routes']);
  });
});

describe('the amplitude knob still reaches the graph', () => {
  /** Hold a note through a one-second render, changing the patch at 0.5 s. */
  async function levelAcross(
    before: SynthPreset,
    after: SynthPreset,
  ): Promise<{ first: number; second: number }> {
    const { data, at } = await renderTimeline(
      (schedule) => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(before);
        runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 1, portamento: 0 });
        schedule(0.5, () => runtime.applyPatch(after));
      },
      { seconds: 1, sampleRate: SR },
    );

    return { first: rms(data, at(0.2), at(0.45)), second: rms(data, at(0.55), at(0.95)) };
  }

  it('turns the level down with no routes at all', async () => {
    // `applyPatch` no longer writes `nodes.gain.gain` — `rewireRoutes` is the sole writer,
    // and it is now conditional. So the ordinary case, a patch with no modulation
    // whatsoever, is exactly where deleting that line could have killed the control
    // outright. It is a plain knob and it must still work.
    const before = defaultPreset();
    const { first, second } = await levelAcross(before, {
      ...before,
      voice: { ...before.voice, amplitude: 0.2 },
    });

    expect(first, 'the probe tone never sounded').toBeGreaterThan(0.02);
    expect(second, `level after (${second}) should be well below before (${first})`).toBeLessThan(
      first * 0.5,
    );
  });

  it('turns the level down with a duck route active', async () => {
    // The trap this phase was written around. With a `duckDb` route the resting gain is
    // NOT `voice.amplitude` — it is the midpoint between the peak and the trough, computed
    // from the amplitude. Drop `voice.amplitude` from the `routes` inputs and this render
    // is identical on both sides of the change: a knob that reads correctly, journals,
    // replays and moves nothing. That is the defect class this project keeps closing, so
    // it gets a gate rather than a comment.
    const before = duckingPatch(1);
    const { first, second } = await levelAcross(before, {
      ...before,
      voice: { ...before.voice, amplitude: 0.2 },
    });

    expect(first, 'the probe tone never sounded').toBeGreaterThan(0.02);
    expect(second, `level after (${second}) should be well below before (${first})`).toBeLessThan(
      first * 0.5,
    );
  });
});

describe('a new voice joins the modulation graph instead of rebuilding it', () => {
  // `voiceFor` used to call `rewireRoutes` for every new voice, which disposed every
  // scaler and reconnected every LFO — so the second note of a chord tore down and
  // rebuilt the modulation of the note already sounding. The effects chain is fixed-shape
  // precisely because "reconnecting nodes mid-performance produces clicks"; the modulation
  // graph was doing exactly that, once per note.

  it('does not rewire when a chord is played', async () => {
    const count = await inspect((runtime) => {
      runtime.applyPatch(duckingPatch(1));
      const after = runtime.getRewireCount();
      for (const voiceId of [0, 1, 2, 3]) {
        runtime.noteOn({ voiceId, note: 'C3', velocity: 0.8, portamento: 0 });
      }
      return { afterPatch: after, afterChord: runtime.getRewireCount() };
    }).then((r) => r);

    expect(count.afterPatch, 'the initial applyPatch wires the graph once').toBe(1);
    expect(count.afterChord, 'four notes must not rebuild the graph four times').toBe(1);
  });

  it('still rewires when the routing actually changes', async () => {
    // The vacuity guard. Without it the counter could be frozen — or `rewireRoutes` could
    // have stopped being called at all — and the assertion above would still be green.
    const count = await inspect((runtime) => {
      const before = duckingPatch(1);
      runtime.applyPatch(before);
      runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 0.8, portamento: 0 });
      runtime.applyPatch({
        ...before,
        voice: { ...before.voice, modRoutes: [] },
      });
      return runtime.getRewireCount();
    });

    expect(count).toBe(2);
  });

  it('modulates a voice that did not exist when the patch landed', async () => {
    // The guard, not the gate — the old wholesale rebuild wired the late voice correctly
    // too, so this passes either way. It is here because the cheap path could easily wire
    // nothing at all and the counter would look *better*, not worse. A gate that only
    // rewards doing less is a gate that rewards deleting the feature.
    //
    // The LFO is 0.5 Hz starting at phase 0, so over two seconds it peaks near t=0.5 and
    // troughs near t=1.5. At full duck depth the trough is far below the peak — but only
    // for a voice that is actually connected.
    const patch = duckingPatch(1);
    const deep: SynthPreset = {
      ...patch,
      voice: {
        ...patch.voice,
        modRoutes: [{ ...patch.voice.modRoutes[0]!, depth: 1 }],
      },
    };

    const { data, at } = await renderTimeline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(deep);
        // Voice 7 has never been built, so `voiceFor` creates it here — after the graph
        // was already wired by `applyPatch`.
        runtime.noteOn({ voiceId: 7, note: 'C3', velocity: 1, portamento: 0 });
      },
      { seconds: 2, sampleRate: SR },
    );

    const peak = rms(data, at(0.45), at(0.55));
    const trough = rms(data, at(1.45), at(1.55));

    expect(peak, 'the probe tone never sounded').toBeGreaterThan(0.02);
    expect(trough / peak, `trough (${trough}) vs peak (${peak})`).toBeLessThan(0.5);
  });
});

describe('a voice built after a change matches one built before', () => {
  /**
   * The invariant the whole diff rests on, and it holds by agreement between two lists
   * rather than by construction.
   *
   * Voices are lazy, so one can appear after the writes it missed. That is safe only
   * because `voiceFor` builds every node from the CURRENT patch — the same nine things
   * `applyPatch` writes. Let those two lists drift and a parameter changed before the
   * first note would apply to nothing, silently, and only for notes played later.
   */
  async function renderNote(order: 'change then play' | 'play then change'): Promise<Float32Array> {
    const before = defaultPreset();
    const after: SynthPreset = {
      ...before,
      voice: {
        ...before.voice,
        filter: { ...before.voice.filter, Q: 6 },
        envelope: { ...before.voice.envelope, attack: 0.2, sustain: 0.4 },
        filterEnvelope: { ...before.voice.filterEnvelope, baseFrequency: 400, octaves: 3 },
        pan: 0,
        oscillators: [{ ...before.voice.oscillators[0]!, type: 'square', detune: 12 }],
      },
    };

    const { data } = await renderTimeline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(before);
        if (order === 'play then change') {
          // A voice exists when the change arrives, so it takes the writes.
          runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 1, portamento: 0 });
          runtime.applyPatch(after);
        } else {
          // No voice exists yet, so every write is skipped for it — `voiceFor` has to
          // build it correctly from the patch alone.
          runtime.applyPatch(after);
          runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 1, portamento: 0 });
        }
      },
      { seconds: 1, sampleRate: SR },
    );
    return data;
  }

  it('renders the same buffer either way', async () => {
    const [played, built] = await Promise.all([
      renderNote('play then change'),
      renderNote('change then play'),
    ]);

    expect(rms(played, 0, played.length), 'the probe tone never sounded').toBeGreaterThan(0.01);

    // Not sample-exact: the two runs start their note at slightly different points of the
    // offline clock's block schedule. Energy over the whole render is the honest question
    // — "did the late-built voice get the same sound" — and a missed write here is not
    // subtle. Dropping the filter from the write list moves this far more than 5%.
    const difference = Math.abs(rms(played, 0, played.length) - rms(built, 0, built.length));
    expect(difference / rms(played, 0, played.length)).toBeLessThan(0.05);
  });
});
