/**
 * src/tests/route-wiring.audio.test.ts — every declared destination, asked whether it moves.
 *
 * `MODULATION_DESTINATIONS` carries a `wired` flag saying whether a scaler reaches a real
 * audio node at that address. Thirteen say yes, eighteen say no, and the surface draws
 * those two groups differently — so the flag is load-bearing, and a structural check on it
 * would only prove the table agrees with itself.
 *
 * This proves it against the engine, in both directions and for all thirty-one:
 *
 *   wired: true   -> the render CHANGES when a route at full depth is added
 *   wired: false  -> the render does not
 *
 * The reason it is worth thirty-two renders is the bug that prompted it. `ModPanel.tsx`
 * held this fact by hand and claimed seven destinations were wired while the runtime wired
 * thirteen: the list was written when there was one oscillator and never revisited when
 * v0.1.16 made oscillators a slot family, so slots 1 and 2 were drawn dead while modulating
 * audio perfectly well. Nothing could have caught that except asking the audio.
 *
 * **Stereo on purpose.** Four of the thirteen are pan destinations, and the one-channel
 * render every other audio gate uses would down-mix their movement to nothing — which is
 * exactly how `voice.oscillators.N.pan` shipped as a decoy through eighty-six audio gates
 * at 0.1.16. A mono render here would report four wired destinations as dead and be
 * believed, because it would agree with the old hand-written list.
 */

import * as Tone from 'tone';
import { describe, expect, it } from 'vitest';
import { ToneRuntime } from '../runtime/tone-runtime';
import { defaultPreset } from '../core/state';
import { MODULATION_DESTINATIONS, type ModDestination, type SynthPreset } from '../core/types';

const SR = 44100;
const SECONDS = 1;

/**
 * Two channels, unlike the shared mono helper. See the header — a mono render cannot see a
 * pan route at all, and four of the wired thirteen are pan.
 */
async function renderStereo(patch: SynthPreset): Promise<[Float32Array, Float32Array]> {
  const buffer = await Tone.Offline(
    () => {
      const runtime = new ToneRuntime();
      runtime.applyPatch(patch);
      runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 0.9, portamento: 0 });
    },
    SECONDS,
    2,
    SR,
  );
  return [buffer.getChannelData(0), buffer.getChannelData(1)];
}

/**
 * A patch where every wired destination has something to move.
 *
 * Three oscillator slots, all sounding, because the slot-family destinations resolve to
 * `null` for a slot the patch never added — a route into slot 2 of a one-slot patch is
 * correctly inert, and testing against the default preset would call nine wired
 * destinations dead. One LFO, fast enough to complete several cycles inside the render.
 */
function basePatch(): SynthPreset {
  const patch = defaultPreset();
  const slot0 = patch.voice.oscillators[0]!;
  return {
    ...patch,
    voice: {
      ...patch.voice,
      // Detune the copies so the slots are distinguishable, and drop the levels so three
      // stacked saws do not sit against the limiter, where amplitude modulation would be
      // squashed into looking unwired.
      oscillators: [
        { ...slot0, level: 0.4 },
        { ...slot0, id: 'osc-1', level: 0.4, detune: 7, pan: -0.3 },
        { ...slot0, id: 'osc-2', level: 0.4, detune: -7, pan: 0.3 },
      ],
      lfos: [
        { id: 'lfo-0', enabled: true, type: 'sine', frequency: 5, sync: false, retrigger: false },
      ],
      modRoutes: [],
    },
  };
}

function withRoute(patch: SynthPreset, destination: ModDestination): SynthPreset {
  return {
    ...patch,
    voice: {
      ...patch.voice,
      modRoutes: [
        { id: 'route-0', enabled: true, source: 'lfo.0', destination, depth: 1 },
      ],
    },
  };
}

/** How far the routed render departs from the unrouted one, relative to its own level. */
function movement(
  base: readonly [Float32Array, Float32Array],
  routed: readonly [Float32Array, Float32Array],
): number {
  let difference = 0;
  let reference = 0;
  for (let channel = 0; channel < 2; channel += 1) {
    const a = base[channel]!;
    const b = routed[channel]!;
    for (let i = 0; i < a.length; i += 1) {
      difference += (b[i]! - a[i]!) ** 2;
      reference += a[i]! ** 2;
    }
  }
  return reference === 0 ? 0 : Math.sqrt(difference / reference);
}

/**
 * Separates moved from unmoved, and the number is measured rather than guessed. Both
 * probes were run by mislabelling one destination and reading what the failure reported:
 *
 *   wired    voice.filter.Q      6.43e-1
 *   unwired  effects.delay.wet   1.49e-7
 *
 * An unwired destination is NOT bit-identical, which was worth finding out — building the
 * route still creates an LFO, and its presence perturbs the render at the seventh decimal
 * even with nothing connected. So the floor cannot be zero. At 1e-4 it sits three orders
 * above that residue and four below the quietest real movement; nothing lands in between,
 * which is the property a threshold should be able to demonstrate rather than assert.
 */
const FLOOR = 1e-4;

describe('every declared modulation destination, asked whether it moves', () => {
  it('moves audio if and only if the table says it is wired', async () => {
    const patch = basePatch();
    const base = await renderStereo(patch);

    const measured: { path: ModDestination; wired: boolean; movement: number }[] = [];
    for (const destination of MODULATION_DESTINATIONS) {
      const routed = await renderStereo(withRoute(patch, destination.path));
      measured.push({
        path: destination.path,
        wired: destination.wired,
        movement: movement(base, routed),
      });
    }

    const silentButWired = measured.filter((m) => m.wired && m.movement <= FLOOR);
    const movingButUnwired = measured.filter((m) => !m.wired && m.movement > FLOOR);

    // Reported separately: the two failures mean opposite things. A wired destination that
    // does not move is a decoy — a jack drawn live that does nothing. An unwired one that
    // does move is a surface understating the engine, which is how six working
    // destinations spent a version being drawn as dead.
    expect(
      silentButWired.map((m) => `${m.path} (${m.movement.toExponential(2)})`),
      'declared wired, moved nothing',
    ).toEqual([]);
    expect(
      movingButUnwired.map((m) => `${m.path} (${m.movement.toExponential(2)})`),
      'declared unwired, moved audio',
    ).toEqual([]);

    // And the counts, so a table that quietly emptied itself cannot pass by vacuum.
    expect(measured.filter((m) => m.wired)).toHaveLength(13);
    expect(measured.filter((m) => !m.wired)).toHaveLength(18);
  }, 120_000);

  it('sees a pan route at all, which a mono render does not', async () => {
    // The gate on the gate. If this fails, the test above is measuring a down-mix and its
    // four pan destinations are passing for reasons unrelated to their wiring — the exact
    // blind spot that let voice.oscillators.N.pan ship as a decoy.
    const patch = basePatch();
    const base = await renderStereo(patch);
    const routed = await renderStereo(withRoute(patch, 'voice.pan'));

    const stereo = movement(base, routed);
    // Same measurement collapsed to a mono sum: pan moves energy between channels without
    // changing the total, so this stays near zero while the stereo figure does not.
    let monoDifference = 0;
    let monoReference = 0;
    for (let i = 0; i < base[0].length; i += 1) {
      const a = base[0][i]! + base[1][i]!;
      const b = routed[0][i]! + routed[1][i]!;
      monoDifference += (b - a) ** 2;
      monoReference += a ** 2;
    }
    const mono = Math.sqrt(monoDifference / monoReference);

    expect(stereo).toBeGreaterThan(FLOOR);
    expect(stereo).toBeGreaterThan(mono * 2);
  }, 60_000);
});
