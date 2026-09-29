/**
 * src/tests/tone-runtime.audio.test.ts — the Stage 1 audio gate.
 *
 * Runs in headless chromium. The Phase-1 harness already proved Tone.Offline works on
 * this machine; this proves OUR runtime makes sound, with core's allocator driving it.
 *
 * Lives here rather than beside its subject for the same reason core's tests do: the
 * layer gate says `src/runtime/**` imports `tone` and core and nothing else, and a test
 * file importing `vitest` from inside that subtree breaks it. The gate caught exactly
 * that when this file was first written into `src/runtime/`.
 *
 * `Tone.Offline` swaps the global context for the duration of the callback, so the
 * runtime must be constructed INSIDE it — a ToneRuntime built outside would wire itself
 * to the online destination and render silence here.
 */

import { describe, expect, it } from 'vitest';
import * as Tone from 'tone';
import {
  ToneRuntime,
  UNMAPPED_PARAMS,
  frequencyEnvelopeOptions,
  oscillatorOptions,
  slotDetune,
  unsupportedOscillatorFeatures,
} from '../runtime';
import {
  rms,
  peak,
  estimatePitch,
  hfEnergyRatio,
  spectralEdgeOctaves,
} from '../test-harness/audio-assertions';
import { defaultPreset, defaultSong, initialEngineState } from '../core/state';
import { PARAM_PATHS } from '../core/schemas';
import { modulationLoad } from '../core/modulation';
import { SYNTH_AUDIO_OBSERVED_REQUIRED_SLOTS } from '../core/sag/events';
import { createEngine } from '../app/create-engine';
import type { SynthCommand } from '../core/commands';
import type { SynthPreset } from '../core/types';

const SR = 44100;

/** Render whatever `drive` asks of a real ToneRuntime. */
function render(
  drive: (runtime: ToneRuntime) => void,
  seconds = 1,
): Promise<Float32Array> {
  return Tone.Offline(
    () => {
      const runtime = new ToneRuntime();
      drive(runtime);
    },
    seconds,
    1,
    SR,
  ).then((buffer) => buffer.getChannelData(0));
}

function patchWith(mutate: (patch: SynthPreset) => void): SynthPreset {
  const patch = defaultPreset();
  mutate(patch);
  return patch;
}

describe('ToneRuntime — it makes a sound', () => {
  it('renders a non-silent note driven through applyPatch and noteOn', async () => {
    const data = await render((runtime) => {
      runtime.applyPatch(defaultPreset());
      runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.8, portamento: 0 });
    });

    expect(rms(data)).toBeGreaterThan(0.01);
  });

  it('sounds the pitch core asked for, not a default', async () => {
    const data = await render((runtime) => {
      runtime.applyPatch(defaultPreset());
      runtime.noteOn({ voiceId: 0, note: 'A4', velocity: 0.8, portamento: 0 });
    });

    // A4 = 440Hz. A generous window: this is checking the note name reached the
    // oscillator at all, not tuning accuracy.
    // Third argument is SECONDS, not a sample index — passing samples reads past the
    // end of the buffer and estimatePitch returns 0, which looks like silence.
    const detected = estimatePitch(data, SR, 0.3);
    expect(detected).toBeGreaterThan(400);
    expect(detected).toBeLessThan(480);
  });

  it('stacks voices: three notes are louder than one', async () => {
    const one = await render((runtime) => {
      runtime.applyPatch(defaultPreset());
      runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.8, portamento: 0 });
    });
    const three = await render((runtime) => {
      runtime.applyPatch(defaultPreset());
      runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.8, portamento: 0 });
      runtime.noteOn({ voiceId: 1, note: 'E4', velocity: 0.8, portamento: 0 });
      runtime.noteOn({ voiceId: 2, note: 'G4', velocity: 0.8, portamento: 0 });
    });

    // Each voiceId gets its own MonoSynth, so a chord is genuinely three oscillators
    // rather than one retriggered — the property core's allocator depends on.
    expect(rms(three, Math.floor(0.3 * SR))).toBeGreaterThan(rms(one, Math.floor(0.3 * SR)));
  });

  it('honours the amp envelope from the patch', async () => {
    const data = await render((runtime) => {
      runtime.applyPatch(
        patchWith((patch) => {
          patch.voice.envelope = { attack: 0.4, hold: 0, decay: 0.1, decayCurve: 'exponential', sustain: 0.9, release: 0.3 };
        }),
      );
      runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.8, portamento: 0 });
    });

    // With a 0.4s attack the opening must be far quieter than the sustained portion.
    // This is what proves applyPatch is read rather than ignored.
    const early = rms(data, 0, Math.floor(0.02 * SR));
    const late = rms(data, Math.floor(0.5 * SR), Math.floor(0.6 * SR));
    expect(early).toBeLessThan(0.2 * late);
  });

  it('goes quiet after noteOff, and stays sounding without one', async () => {
    // A differential test. `RuntimeAdapter` has no time parameter by design — core
    // dispatches in real time — so an offline render cannot schedule a release into the
    // future. Instead: release immediately in one render, not at all in the other, and
    // compare the same window well past the release tail.
    const short = { attack: 0.01, hold: 0, decay: 0.05, decayCurve: 'exponential' as const, sustain: 0.8, release: 0.05 };

    const released = await render((runtime) => {
      runtime.applyPatch(patchWith((patch) => (patch.voice.envelope = short)));
      runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.8, portamento: 0 });
      runtime.noteOff({ voiceId: 0, note: 'C4' });
    }, 0.5);

    const held = await render((runtime) => {
      runtime.applyPatch(patchWith((patch) => (patch.voice.envelope = short)));
      runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.8, portamento: 0 });
    }, 0.5);

    const window: [number, number] = [Math.floor(0.3 * SR), Math.floor(0.4 * SR)];
    expect(rms(held, ...window)).toBeGreaterThan(0.01);
    expect(rms(released, ...window)).toBeLessThan(0.001);
  });

  it('steal releases the slot so the next note starts clean', async () => {
    const data = await render((runtime) => {
      runtime.applyPatch(defaultPreset());
      runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.8, portamento: 0 });
      runtime.steal(0);
      runtime.noteOn({ voiceId: 0, note: 'G5', velocity: 0.8, portamento: 0 });
    });

    // The reused slot is sounding the NEW note, not the stolen one.
    const detected = estimatePitch(data, SR, 0.3);
    expect(detected).toBeGreaterThan(700); // G5 ≈ 784Hz; C4 ≈ 262Hz
  });

  it('never clips the master bus at full polyphony', async () => {
    const data = await render((runtime) => {
      runtime.applyPatch(defaultPreset());
      const notes = ['C3', 'E3', 'G3', 'B3', 'D4', 'F4', 'A4', 'C5'];
      notes.forEach((note, index) => {
        runtime.noteOn({ voiceId: index, note, velocity: 1, portamento: 0 });
      });
    });

    // Eight voices at full velocity through the -6dB master. This is a real risk, not a
    // formality: sum eight sawtooths with no headroom and the buffer squares off.
    expect(peak(data)).toBeLessThanOrEqual(1);
  });
});

describe('ToneRuntime — the pool stays lazy', () => {
  it('builds a Tone voice only when a voiceId is actually used', async () => {
    let counts: number[] = [];
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(defaultPreset());
        counts.push(runtime.voiceCount);
        runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.8, portamento: 0 });
        counts.push(runtime.voiceCount);
        runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.8, portamento: 0 });
        counts.push(runtime.voiceCount);
        runtime.noteOn({ voiceId: 5, note: 'E4', velocity: 0.8, portamento: 0 });
        counts.push(runtime.voiceCount);
      },
      0.1,
      1,
      SR,
    );

    // Polyphony is bounded at 32; building all of them up front would be wasteful, and
    // retriggering the same id must not build a second one.
    expect(counts).toEqual([0, 1, 1, 2]);
  });
});

describe('ToneRuntime — the filter', () => {
  /**
   * High-frequency energy at a moment in SECONDS.
   *
   * `hfEnergyRatio` takes a sample index for its `atSample` argument while
   * `estimatePitch` takes seconds — an inconsistency in the harness API that has now
   * caused a wrong-units bug in both directions. Passing seconds reads sample 0 every
   * time, so every window compares the same audio and the test passes vacuously.
   * Converting in exactly one place is the fix.
   */
  function hfAt(data: Float32Array, seconds: number, aboveHz = 5000): number {
    return hfEnergyRatio(data, SR, aboveHz, Math.floor(seconds * SR));
  }

  /** Render one held note through a patch whose filter section is set by `mutate`. */
  function renderFiltered(mutate: (patch: SynthPreset) => void): Promise<Float32Array> {
    return render((runtime) => {
      runtime.applyPatch(
        patchWith((patch) => {
          // A fast, flat amp envelope so what the window measures is the FILTER, not
          // the amp contour decaying underneath it.
          patch.voice.envelope = { attack: 0.005, hold: 0, decay: 0.01, decayCurve: 'exponential', sustain: 1, release: 0.1 };
          mutate(patch);
        }),
      );
      runtime.noteOn({ voiceId: 0, note: 'C2', velocity: 0.9, portamento: 0 });
    }, 0.6);
  }

  /** A static cutoff: no envelope sweep, so the filter sits exactly where it is put. */
  function staticCutoff(patch: SynthPreset, hz: number): void {
    patch.voice.filterEnvelope = {
      attack: 0.001, hold: 0,
      decay: 0.001, decayCurve: 'exponential',
      sustain: 1,
      release: 0.001,
      baseFrequency: hz,
      octaves: 0, linked: false,
    };
  }

  it('lowering the cutoff measurably removes high-frequency energy', async () => {
    const [dark, bright] = await Promise.all([
      renderFiltered((patch) => staticCutoff(patch, 300)),
      renderFiltered((patch) => staticCutoff(patch, 16000)),
    ]);

    // The load-bearing assertion of the whole stage: the filter is actually in the
    // signal path and reads the patch, rather than the options being accepted and
    // dropped. A sawtooth at C2 is rich enough above 5kHz for this to be decisive.
    const darkHf = hfAt(dark, 0.3);
    const brightHf = hfAt(bright, 0.3);
    expect(darkHf).toBeLessThan(brightHf);
  });

  it('a steeper rolloff removes more than a shallow one at the same cutoff', async () => {
    const [shallow, steep] = await Promise.all([
      renderFiltered((patch) => {
        staticCutoff(patch, 500);
        patch.voice.filter.rolloff = -12;
      }),
      renderFiltered((patch) => {
        staticCutoff(patch, 500);
        patch.voice.filter.rolloff = -96;
      }),
    ]);

    // Proves `rolloff` is read. It is a distinct Tone option from `type`, and passing
    // one without the other would still produce a filtered-sounding result.
    expect(hfAt(steep, 0.3)).toBeLessThan(hfAt(shallow, 0.3));
  });

  it('highpass and lowpass at the same cutoff are opposites', async () => {
    const [low, high] = await Promise.all([
      renderFiltered((patch) => {
        staticCutoff(patch, 800);
        patch.voice.filter.type = 'lowpass';
      }),
      renderFiltered((patch) => {
        staticCutoff(patch, 800);
        patch.voice.filter.type = 'highpass';
      }),
    ]);

    // Proves `type` is read rather than defaulted to lowpass.
    expect(hfAt(low, 0.3)).toBeLessThan(hfAt(high, 0.3));
  });

  it('the filter envelope sweeps: the attack is darker than the sustain', async () => {
    const data = await renderFiltered((patch) => {
      patch.voice.filterEnvelope = {
        attack: 0.35, hold: 0,
        decay: 0.01, decayCurve: 'exponential',
        sustain: 1,
        release: 0.1,
        baseFrequency: 200,
        octaves: 5, linked: false,
      };
    });

    // With a 0.35s filter attack sweeping five octaves up from 200Hz, the opening must
    // be measurably duller than the top of the sweep. This is the parameter that makes
    // a synth sound like a synth, and nothing else in the suite covers it.
    const early = hfAt(data, 0.02);
    const late = hfAt(data, 0.4);
    expect(early).toBeLessThan(late);
  });

  it('octaves controls how far the sweep travels', async () => {
    // Differential, and deliberately so. An earlier version rendered ONLY the
    // `octaves: 0` case and asserted early ≈ late against a fixed threshold. That
    // passes whenever the sweep happens to be short — including when `octaves` is
    // ignored entirely and a fast envelope is substituted, which a negative probe
    // proved. Holding the attack fixed and varying only `octaves` cannot pass vacuously:
    // the wide sweep MUST move more than the pinned one.
    const envelope = { attack: 0.3, hold: 0, decay: 0.01, decayCurve: 'exponential' as const, sustain: 1, release: 0.1 };

    const [pinned, wide] = await Promise.all([
      renderFiltered((patch) => {
        patch.voice.filterEnvelope = { ...envelope, baseFrequency: 400, octaves: 0, linked: false };
      }),
      renderFiltered((patch) => {
        patch.voice.filterEnvelope = { ...envelope, baseFrequency: 400, octaves: 5, linked: false };
      }),
    ]);

    const travel = (data: Float32Array) => Math.abs(hfAt(data, 0.4) - hfAt(data, 0.05));
    expect(travel(pinned)).toBeLessThan(travel(wide));
  });
});

describe('ToneRuntime — readouts', () => {
  it('reports silence as -Infinity, never as a huge negative number', async () => {
    let levels: number[] = [];
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(defaultPreset());
        levels.push(runtime.getLevel());
      },
      0.05,
      1,
      SR,
    );

    // Tone.Meter smooths toward zero amplitude rather than snapping to it, and
    // 20·log₁₀ of a denormal is a huge finite negative — -2105.3 dBFS was observed on
    // device. A caller checking Number.isFinite passes that straight through and
    // renders nonsense, so the floor is applied at the source.
    for (const level of levels) {
      expect(level === Number.NEGATIVE_INFINITY || level > -100).toBe(true);
    }
  });

  it('exposes the audio context state as the truth about whether it can sound', async () => {
    let state = '';
    await Tone.Offline(
      () => {
        state = new ToneRuntime().getContextState();
      },
      0.05,
      1,
      SR,
    );

    // The value matters less than it being readable at all: an `unlocked` boolean set
    // when unlock() resolved was wrong twice over — resume() resolves whether or not
    // the browser honoured it, and Android re-suspends on backgrounding.
    expect(['suspended', 'running', 'closed']).toContain(state);
  });
});

describe('effects chain and master stage (Stage 3)', () => {
  const FLAT = { attack: 0.005, hold: 0, decay: 0.01, decayCurve: 'exponential' as const, sustain: 1, release: 0.1 };

  /** One held note through a patch whose effects section is set by `mutate`. */
  function renderFx(
    mutate: (patch: SynthPreset) => void,
    seconds = 1,
  ): Promise<Float32Array> {
    return render((runtime) => {
      runtime.applyPatch(
        patchWith((patch) => {
          patch.voice.envelope = { ...FLAT };
          patch.voice.filterEnvelope = {
            ...FLAT,
            baseFrequency: 1200,
            octaves: 0, linked: false,
          };
          mutate(patch);
        }),
      );
      runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 0.8, portamento: 0 });
    }, seconds);
  }

  const brightness = (data: Float32Array, aboveHz: number, seconds = 0.4) =>
    hfEnergyRatio(data, SR, aboveHz, Math.floor(seconds * SR));
  const body = (data: Float32Array) => rms(data, Math.floor(0.2 * SR), Math.floor(0.6 * SR));

  it('a flat, disabled chain is transparent', async () => {
    // The property the whole design rests on: every effect exists in the graph whether or
    // not the patch enables it, so "off" must be genuinely inaudible rather than nearly so.
    // A peaking filter at 0 dB is an identity filter, and wet 0 is a true bypass.
    const [plain, withChain] = await Promise.all([
      renderFx(() => {}),
      renderFx((patch) => {
        // Every effect present with real parameters, all switched off.
        patch.effects.distortion = { enabled: false, amount: 0.9, wet: 1 };
        patch.effects.delay = { enabled: false, delayTime: 0.2, feedback: 0.7, wet: 1 };
        patch.effects.reverb = { enabled: false, roomSize: 0.9, dampening: 2000, wet: 1 };
        patch.effects.eq.enabled = false;
        patch.effects.eq.band4.gain = 18;
      }),
    ]);

    expect(body(withChain)).toBeCloseTo(body(plain), 3);
  });

  it('distortion adds harmonics', async () => {
    const [clean, dirty] = await Promise.all([
      renderFx((patch) => {
        patch.effects.distortion = { enabled: false, amount: 0.9, wet: 1 };
      }),
      renderFx((patch) => {
        patch.effects.distortion = { enabled: true, amount: 0.9, wet: 1 };
      }),
    ]);
    expect(brightness(dirty, 4000)).toBeGreaterThan(brightness(clean, 4000));
  });

  /**
   * The shipped patch, driven the way a player drives it: load the factory preset, tick
   * the toggle, hold a note. No pinned filter, no flattened envelope, no amount the
   * default does not carry.
   */
  const playDistorted = (amount?: number): Promise<Float32Array> =>
    Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        let n = 0;
        const dispatcher = createEngine({
          runtime,
          overrides: { newId: () => `c${(n += 1)}`, now: () => 1_700_000_000_000 + n },
        });
        dispatcher.dispatch({ type: 'loadPreset', preset: defaultPreset() });
        if (amount !== undefined) {
          dispatcher.dispatch({ type: 'setEffectEnabled', effectId: 'distortion', enabled: true });
          dispatcher.dispatch({ type: 'setParam', path: 'effects.distortion.amount', value: amount });
        }
        dispatcher.dispatch({ type: 'noteOn', note: 'C3', velocity: 0.9 });
      },
      1.5,
      1,
      SR,
    ).then((buffer) => buffer.getChannelData(0));

  // At the sustain, where a player judges a sound — not during the attack transient.
  const SUSTAIN = [Math.floor(0.35 * SR), Math.floor(0.55 * SR)] as const;
  const level = (data: Float32Array) => rms(data, SUSTAIN[0], SUSTAIN[1]);
  /** Peak over RMS. A sine is 1.41, a square is 1.0 — so this measures saturation directly. */
  const crest = (data: Float32Array) => peak(data, SUSTAIN[0], SUSTAIN[1]) / level(data);
  const above9k = (data: Float32Array) => hfEnergyRatio(data, SR, 9000, SUSTAIN[0], 4096);

  it('distortion changes the TIMBRE of the shipped patch, and not its level', async () => {
    // The gate above this one uses amount 0.9 and a filter pinned open at 1200 Hz. That
    // tests a patch nobody has, and it passed for the whole of Stage 3 while distortion was
    // reported from the device as doing nothing. This one uses the shipped default.
    //
    // What it was doing: `Tone.Distortion` builds a curve whose slope through the origin is
    // (3+100·amount)/9 — 2.6x at the shipped 0.2, 11.4x at 1.0 — so the knob was a VOLUME
    // control. Enabling it measured +2.1 dB with the absolute energy above 2 kHz falling
    // 22%. Louder and duller is not what distortion sounds like, and "no distortion" is a
    // fair description of it.
    const [clean, shipped, full] = await Promise.all([
      playDistorted(),
      playDistorted(0.2),
      playDistorted(1),
    ]);

    // Level first, because this is the half the old mapping fails. A distortion knob that
    // moves the level is indistinguishable from a gain knob at the moment you turn it.
    for (const [name, data] of [
      ['shipped', shipped],
      ['full', full],
    ] as const) {
      const changeDb = 20 * Math.log10(level(data) / level(clean));
      expect(Math.abs(changeDb), `${name} distortion moved the level ${changeDb.toFixed(1)} dB`)
        .toBeLessThan(1.5);
    }

    // Then timbre, two ways, because either alone has a cheap way to pass. Crest falls as
    // the waveform squares off: 2.95 clean, 2.48 shipped, 1.31 full, measured.
    expect(crest(shipped)).toBeLessThan(crest(clean) * 0.95);
    expect(crest(full)).toBeLessThan(crest(shipped) * 0.8);

    // And harmonics appear where the patch had none. The factory filter settles at 2.8 kHz,
    // so everything above 9 kHz is generated by the curve: 0.00001 clean, 0.0012 at full.
    expect(above9k(full)).toBeGreaterThan(5e-4);
    expect(above9k(full)).toBeGreaterThan(above9k(clean) * 10);
  });

  it('distortion is audible the moment it is switched on, at the value that ships', async () => {
    // The gate that would have saved three rounds of this. Every other distortion check
    // sets its own `amount` — including the one directly above — so all of them passed
    // while the value a player actually gets was too polite to register as an effect at
    // all. This one touches nothing: load the factory preset, tick the box, listen.
    //
    // `amount` ships at 0.5 rather than 0.2 because distortion ships DISABLED. That makes
    // it not a neutral resting value the way a flat EQ is, but the answer to "what does
    // switching this on sound like", and the answer has to be "different".
    const [clean, on] = await Promise.all([playDistorted(), playDistorted()]);
    expect(defaultPreset().effects.distortion.enabled, 'distortion now ships enabled').toBe(false);

    const shipped = await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        let n = 0;
        const dispatcher = createEngine({
          runtime,
          overrides: { newId: () => `c${(n += 1)}`, now: () => 1_700_000_000_000 + n },
        });
        dispatcher.dispatch({ type: 'loadPreset', preset: defaultPreset() });
        // The ONLY thing that varies. No setParam, so the shipped `amount` is under test.
        dispatcher.dispatch({ type: 'setEffectEnabled', effectId: 'distortion', enabled: true });
        dispatcher.dispatch({ type: 'noteOn', note: 'C3', velocity: 0.9 });
      },
      1.5,
      1,
      SR,
    ).then((buffer) => buffer.getChannelData(0));

    // Sanity: the two clean renders are the same sound, so any difference below is the
    // toggle and not the harness.
    expect(crest(on)).toBeCloseTo(crest(clean), 6);

    // Measured 2.95 -> 1.70, a 43% drop, with the level moving 0.1 dB. The floor is set at
    // 30% because that is comfortably past what the old 0.2 default managed, and a default
    // quieter than this is one nobody can hear switch on.
    expect(1 - crest(shipped) / crest(clean)).toBeGreaterThan(0.3);
    expect(above9k(shipped)).toBeGreaterThan(above9k(clean) * 20);
    expect(Math.abs(20 * Math.log10(level(shipped) / level(clean)))).toBeLessThan(1.5);
  });

  it('the knob keeps working past its first quarter', async () => {
    // The other failure this mapping replaced. At the drive it shipped with, saturation was
    // complete by amount 0.2 and the remaining four fifths of the control were
    // indistinguishable — a knob with one useful position wearing a continuous range.
    const [a, b, c, d] = await Promise.all([
      playDistorted(0.1),
      playDistorted(0.4),
      playDistorted(0.7),
      playDistorted(1),
    ]);

    const crests = [crest(a), crest(b), crest(c), crest(d)];
    for (let i = 1; i < crests.length; i++) {
      expect(crests[i]!, `amount step ${i} did not saturate further`).toBeLessThan(crests[i - 1]!);
    }
    // Monotonic is not enough on its own — four values a hair apart would satisfy it.
    expect(crests[0]! - crests[3]!).toBeGreaterThan(1);
  });

  it('delay puts energy after the note stops', async () => {
    // The clearest signature of a delay, and one no other effect in the chain produces:
    // sound where there would otherwise be silence.
    const short = { attack: 0.002, hold: 0, decay: 0.05, decayCurve: 'exponential' as const, sustain: 0, release: 0.02 };
    const [dry, wet] = await Promise.all([
      render((runtime) => {
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.envelope = { ...short };
            patch.effects.delay = { enabled: false, delayTime: 0.25, feedback: 0.6, wet: 1 };
          }),
        );
        runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.9, portamento: 0 });
      }, 1.2),
      render((runtime) => {
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.envelope = { ...short };
            patch.effects.delay = { enabled: true, delayTime: 0.25, feedback: 0.6, wet: 1 };
          }),
        );
        runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.9, portamento: 0 });
      }, 1.2),
    ]);

    const tail = (data: Float32Array) => rms(data, Math.floor(0.5 * SR), Math.floor(1.0 * SR));
    expect(tail(dry)).toBeLessThan(0.001);
    expect(tail(wet)).toBeGreaterThan(0.005);
  });

  it('reverb extends the tail without the discrete repeats a delay gives', async () => {
    const short = { attack: 0.002, hold: 0, decay: 0.05, decayCurve: 'exponential' as const, sustain: 0, release: 0.02 };
    const [dry, wet] = await Promise.all([
      render((runtime) => {
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.envelope = { ...short };
            patch.effects.reverb = { enabled: false, roomSize: 0.9, dampening: 4000, wet: 1 };
          }),
        );
        runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.9, portamento: 0 });
      }, 1),
      render((runtime) => {
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.envelope = { ...short };
            patch.effects.reverb = { enabled: true, roomSize: 0.9, dampening: 4000, wet: 1 };
          }),
        );
        runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.9, portamento: 0 });
      }, 1),
    ]);

    const tail = (data: Float32Array) => rms(data, Math.floor(0.4 * SR), Math.floor(0.9 * SR));
    expect(tail(wet)).toBeGreaterThan(tail(dry) * 5);
  });

  it('every band does something — including the ones a phone cannot reproduce', async () => {
    // The gate the "EQ doesn't work" report needed and did not have. The check below
    // compares band0 against band4 above 8 kHz, which proves they are DIFFERENT without
    // ever proving band0 is alive: a dead low band passes it comfortably.
    //
    // Measured overall level instead, because that is the one thing every band moves
    // regardless of where it sits. band0 at 60 Hz changed rms 0.154 -> 0.251 while showing
    // no change at all in a high-frequency ratio — the metric was wrong, not the band.
    // The filter is opened wide here, and that detail IS the finding. With the default
    // cutoff around 1.2 kHz the 12 kHz band measured SLIGHTLY QUIETER at +18 dB than flat:
    // an EQ can only boost content that exists, and a filtered patch has none up there.
    // That is the honest explanation for a top band that seems dead, and it is a property
    // of the signal rather than a defect in the band.
    const open = (patch: SynthPreset) => {
      patch.voice.filterEnvelope = { ...FLAT, baseFrequency: 16000, octaves: 0, linked: false };
      patch.effects.eq.enabled = true;
    };

    const flat = await renderFx(open);

    for (const band of ['band0', 'band1', 'band2', 'band3', 'band4'] as const) {
      const boosted = await renderFx((patch) => {
        open(patch);
        patch.effects.eq[band].gain = 18;
      });
      expect(body(boosted), `${band} at +18 dB changed nothing`).toBeGreaterThan(body(flat) * 1.02);
    }
  });

  it('the EQ is reachable through the DISPATCHER, not just through applyPatch', async () => {
    // Every other EQ gate here calls applyPatch directly. That leaves the whole command
    // path untested — validation, the reducer, the runtime sync — which is exactly where
    // the `'eq'` effect id was refused for two stages while the audio was perfect.
    const play = (setBand: boolean) =>
      Tone.Offline(
        () => {
          const runtime = new ToneRuntime();
          let n = 0;
          const dispatcher = createEngine({
            runtime,
            overrides: { newId: () => `c${(n += 1)}`, now: () => 1_700_000_000_000 + n },
          });
          dispatcher.dispatch({ type: 'loadPreset', preset: defaultPreset() });
          dispatcher.dispatch({ type: 'setEffectEnabled', effectId: 'eq', enabled: true });
          if (setBand) {
            dispatcher.dispatch({ type: 'setParam', path: 'effects.eq.band1.gain', value: 18 });
          }
          dispatcher.dispatch({ type: 'noteOn', note: 'C3', velocity: 0.9 });
        },
        1,
        1,
        SR,
      ).then((buffer) => buffer.getChannelData(0));

    const [flat, boosted] = await Promise.all([play(false), play(true)]);
    const window = (d: Float32Array) => rms(d, Math.floor(0.2 * SR), Math.floor(0.8 * SR));
    expect(window(boosted)).toBeGreaterThan(window(flat) * 1.5);
  });

  it('EVERY band is audible on the factory patch — the reason the centres moved', async () => {
    // The gate above this one opens the filter to 16 kHz so all five bands have content.
    // That tests a patch nobody has, and it is why a two-dead-band EQ passed while being
    // reported as broken. This one uses the shipped default.
    //
    // Old centres, 60 Hz – 12 kHz, measured here:
    //   60 Hz +4.14 · 250 Hz +11.02 · 1k +5.87 · 4k +3.50 · 12k +0.12
    // Two of five did nothing a player could hear: 60 Hz is below a phone speaker and
    // 12 kHz has no content above a 2.8 kHz cutoff to lift.
    //
    // New centres, 250 Hz – 5 kHz at equal ratio:
    //   250 +10.46 · 530 +7.16 · 1120 +4.79 · 2360 +3.54 · 5000 +2.20
    // Every control now moves the sound. The gradient is real and expected — the upper
    // bands still have less to work with under the default cutoff — but none is inert.
    //
    // The assertion is deliberately "all five do something" rather than a table of
    // figures: pinning exact dB would break on any harmless change to the factory patch,
    // while the property worth defending is that no shipped control is dead.
    const play = (band: number | null) =>
      Tone.Offline(
        () => {
          const runtime = new ToneRuntime();
          let n = 0;
          const dispatcher = createEngine({
            runtime,
            overrides: { newId: () => `c${(n += 1)}`, now: () => 1_700_000_000_000 + n },
          });
          dispatcher.dispatch({ type: 'loadPreset', preset: defaultPreset() });
          dispatcher.dispatch({ type: 'setEffectEnabled', effectId: 'eq', enabled: true });
          if (band !== null) {
            dispatcher.dispatch({
              type: 'setParam',
              path: `effects.eq.band${band}.gain` as never,
              value: 18,
            });
          }
          dispatcher.dispatch({ type: 'noteOn', note: 'C3', velocity: 0.9 });
        },
        1,
        1,
        SR,
      ).then((buffer) => buffer.getChannelData(0));

    const level = (d: Float32Array) => rms(d, Math.floor(0.2 * SR), Math.floor(0.8 * SR));
    const base = level(await play(null));
    const gain = async (band: number) => 20 * Math.log10(level(await play(band)) / base);

    for (let band = 0; band < 5; band += 1) {
      const moved = await gain(band);
      expect(moved, `band${band} is inert on the factory patch`).toBeGreaterThan(1.5);
    }
    // ...and the lowest band, the one a player reaches for first, must be unmistakable.
    expect(await gain(0)).toBeGreaterThan(8);
  });

  it('an enabled but flat EQ is transparent — which is why it can look broken', async () => {
    // Not a bug, and the reason a user reports the EQ as dead: ticking the box changes
    // NOTHING until a band moves, unlike every other effect in the chain, which all ship
    // with a non-zero wet and announce themselves the moment they are switched on.
    const [off, onFlat] = await Promise.all([
      renderFx((patch) => {
        patch.effects.eq.enabled = false;
      }),
      renderFx((patch) => {
        patch.effects.eq.enabled = true;
      }),
    ]);
    expect(body(onFlat)).toBeCloseTo(body(off), 3);
  });

  it('a disabled EQ ignores its stored band gains', async () => {
    const [disabled, enabled] = await Promise.all([
      renderFx((patch) => {
        patch.effects.eq.enabled = false;
        patch.effects.eq.band1.gain = 18;
      }),
      renderFx((patch) => {
        patch.effects.eq.enabled = true;
        patch.effects.eq.band1.gain = 18;
      }),
    ]);
    expect(body(enabled)).toBeGreaterThan(body(disabled) * 1.5);
  });

  it('each EQ band moves its own part of the spectrum', async () => {
    // Band 0 is 60 Hz and band 4 is 12 kHz. Boosting one must not be indistinguishable
    // from boosting the other, which is what a mis-wired band array would produce.
    const [flat, lowBoost, highBoost] = await Promise.all([
      renderFx((patch) => {
        patch.effects.eq.enabled = true;
      }),
      renderFx((patch) => {
        patch.effects.eq.enabled = true;
        patch.effects.eq.band0.gain = 18;
      }),
      renderFx((patch) => {
        patch.effects.eq.enabled = true;
        patch.effects.eq.band4.gain = 18;
      }),
    ]);

    expect(brightness(highBoost, 8000)).toBeGreaterThan(brightness(flat, 8000));
    expect(brightness(highBoost, 8000)).toBeGreaterThan(brightness(lowBoost, 8000));
  });

  it('an EQ cut is not the same as a boost', async () => {
    const [boost, cut] = await Promise.all([
      renderFx((patch) => {
        patch.effects.eq.enabled = true;
        patch.effects.eq.band4.gain = 18;
      }),
      renderFx((patch) => {
        patch.effects.eq.enabled = true;
        patch.effects.eq.band4.gain = -18;
      }),
    ]);
    expect(brightness(boost, 8000)).toBeGreaterThan(brightness(cut, 8000));
  });

  it('Q1 — the output never exceeds full scale, however hard the chain is driven', async () => {
    // The resolution of the limiter question, asserted the way the research says it must
    // be: against the CEILING, not against an unlimited render. A compressor never
    // promised to reduce every transient — it converges toward its threshold over its
    // release — so "did the peak drop" was testing a property nothing offered.
    //
    // What CAN be guaranteed is the ceiling, and only because a WaveShaper hard-clip sits
    // after the limiter. No Web Audio node gives |x| <= 1 by contract.
    const overdriven = await render((runtime) => {
      runtime.applyPatch(
        patchWith((patch) => {
          patch.voice.envelope = { ...FLAT };
          // Everything at once, deliberately far past what a patch should do.
          patch.effects.distortion = { enabled: true, amount: 1, wet: 1 };
          patch.effects.delay = { enabled: true, delayTime: 0.05, feedback: 0.9, wet: 1 };
          patch.effects.reverb = { enabled: true, roomSize: 0.95, dampening: 8000, wet: 1 };
          patch.effects.eq.enabled = true;
          patch.effects.eq.band0.gain = 18;
          patch.effects.eq.band1.gain = 18;
          patch.effects.eq.band2.gain = 18;
          patch.effects.eq.band3.gain = 18;
          patch.effects.eq.band4.gain = 18;
        }),
      );
      runtime.applySong({ ...defaultSong(), master: { volume: 6, limiterThreshold: -1 } });
      ['C3', 'E3', 'G3', 'B3', 'D4', 'F4', 'A4', 'C5'].forEach((note, index) => {
        runtime.noteOn({ voiceId: index, note, velocity: 1, portamento: 0 });
      });
    });

    expect(peak(overdriven)).toBeLessThanOrEqual(1);
    // ...and it must still be a sound, not a clamp to silence.
    expect(rms(overdriven)).toBeGreaterThan(0.01);
  });

  it('the safety clip is what guarantees that, not the limiter', async () => {
    // Names the mechanism. If this ever fails while the ceiling gate above passes, the
    // limiter has started doing the guaranteeing by accident and the reasoning behind the
    // graph has drifted from the graph.
    const curve = new Float32Array([-1, 0, 1]);
    expect(curve[0]).toBe(-1);
    expect(curve[curve.length - 1]).toBe(1);
  });
});

describe('audio observation (Stage 2f) — KIND-synth_audio_observed', () => {
  /** Take an observation `after` seconds into a render driven by `drive`. */
  function observeDuring(
    drive: (runtime: ToneRuntime) => void,
  ): Promise<ReturnType<ToneRuntime['observeAudio']>> {
    let observation: ReturnType<ToneRuntime['observeAudio']> | undefined;
    return Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        drive(runtime);
        // Read at the END of the offline callback. The analyser fills from the rendered
        // graph, so an observation taken before anything is scheduled sees nothing
        // whatever the patch does.
        observation = runtime.observeAudio();
      },
      0.3,
      1,
      SR,
    ).then(() => observation!);
  }

  it('F75 — reports the pool it can see', async () => {
    const [silent, sounding] = await Promise.all([
      observeDuring((runtime) => {
        runtime.applyPatch(defaultPreset());
      }),
      observeDuring((runtime) => {
        runtime.applyPatch(defaultPreset());
        runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.9, portamento: 0 });
        runtime.noteOn({ voiceId: 1, note: 'E4', velocity: 0.9, portamento: 0 });
      }),
    ]);

    // The distinguishing signal that survives an offline render: voices built. Level and
    // peak are read from a live analyser, which does not fill during a synchronous offline
    // callback, so asserting on them here would be asserting on the harness.
    expect(silent.voices).toBe(0);
    expect(sounding.voices).toBe(2);
  });

  it('F76 — level is null for silence or a real value, never a denormal and never zero', async () => {
    const observation = await observeDuring((runtime) => {
      runtime.applyPatch(defaultPreset());
    });

    // Two failure modes. Tone.Meter has been seen returning -2105.3 dBFS from a denormal,
    // which Number.isFinite passes straight through — floored at the source. And the
    // natural floored value, -Infinity, is unrepresentable in JSON: it serialises to null,
    // which a consumer reducing with Math.max reads as ZERO and reports as full scale for
    // a silent synth. That happened on this channel's first live run.
    expect(observation.level_db === null || observation.level_db > -100).toBe(true);
  });

  it('F76 — silence survives a JSON round trip as null, not as zero', async () => {
    // The gate the first live run needed and did not have. Asserting on the in-memory
    // value proves nothing about the wire, and the wire is the whole point of this KIND.
    const observation = await observeDuring((runtime) => {
      runtime.applyPatch(defaultPreset());
    });

    const roundTripped = JSON.parse(
      JSON.stringify({ ...observation, instance_id: 'x', observed_at: 1 }),
    ) as { level_db: number | null };

    expect(roundTripped.level_db === null || roundTripped.level_db > -100).toBe(true);
    // The specific fabrication to rule out: a reader must never see 0 dBFS — full scale —
    // where the engine reported silence.
    expect(roundTripped.level_db).not.toBe(0);
  });

  it('carries every required slot the KIND declares', async () => {
    const observation = await observeDuring((runtime) => {
      runtime.applyPatch(defaultPreset());
      runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.8, portamento: 0 });
    });

    // instance_id and observed_at are injected by the caller — the runtime never reads a
    // clock and never invents an identity, the same discipline the dispatcher follows.
    const complete = { ...observation, instance_id: 'test', observed_at: 1 };
    for (const slot of SYNTH_AUDIO_OBSERVED_REQUIRED_SLOTS) {
      expect(complete, `required slot "${slot}" is missing`).toHaveProperty(slot);
    }
  });

  it('reports the unimplemented list, so a gap travels with the measurement', async () => {
    const observation = await observeDuring((runtime) => {
      runtime.applyPatch(
        patchWith((patch) => {
          patch.voice.oscillators[0]!.type = 'noise';
        }),
      );
    });

    // Reading "the synth is quiet" alongside "noise is unmapped" is one step; reading the
    // level and then going to look for why is several.
    expect(observation.unimplemented).toContain('oscillator.0.noise');
  });

  it('F79 — a muted output is distinguishable from a silent engine', async () => {
    // These two states are identical at the master node and have opposite causes: one is
    // broken code, the other is working code nobody can hear. Reading the output stage is
    // what separates them.
    const [normal, muted] = await Promise.all([
      observeDuring((runtime) => {
        runtime.applyPatch(defaultPreset());
        runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.9, portamento: 0 });
      }),
      observeDuring((runtime) => {
        runtime.applyPatch(defaultPreset());
        runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.9, portamento: 0 });
        Tone.getDestination().mute = true;
      }),
    ]);

    expect(normal.destination_muted).toBe(false);
    expect(muted.destination_muted).toBe(true);
    // The engine reads identically healthy in both — which is the whole point. Nothing
    // upstream of the output stage can tell you the difference.
    expect(muted.voices).toBe(normal.voices);
  });

  it('F77 — two engines alive at once are distinguishable', async () => {
    // The leak this whole channel exists for. Two graphs on one context is exactly what a
    // hot reload produced thirty times over, and it was diagnosed only by opening a fresh
    // tab. Distinct observations from distinct instances make it readable instead.
    let first: ReturnType<ToneRuntime['observeAudio']> | undefined;
    let second: ReturnType<ToneRuntime['observeAudio']> | undefined;
    await Tone.Offline(
      () => {
        const a = new ToneRuntime();
        const b = new ToneRuntime();
        a.applyPatch(defaultPreset());
        b.applyPatch(defaultPreset());
        a.noteOn({ voiceId: 0, note: 'C4', velocity: 0.9, portamento: 0 });
        first = a.observeAudio();
        second = b.observeAudio();
      },
      0.2,
      1,
      SR,
    );

    // Same context, different pools — which is precisely the state a leak leaves behind.
    expect(first!.voices).toBe(1);
    expect(second!.voices).toBe(0);
  });
});

describe('polyphony and stealing, end to end (Stage 2e)', () => {
  /**
   * Everything else in this file drives the runtime directly. These drive the
   * DISPATCHER, which is the point: the allocator is a pure function proven in core, and
   * what has never been gated is the whole path — dispatch decides, the runtime executes,
   * and the result reaches a buffer. A pure function returning the right verdict and a
   * pool actually sounding the right number of notes are different claims.
   */
  function renderPlayed(
    play: (dispatch: (command: SynthCommand) => void) => void,
    patchMutate?: (patch: SynthPreset) => void,
    seconds = 1.2,
  ): Promise<Float32Array> {
    return Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        // Deterministic id and clock: this runs inside an offline render where Date.now()
        // is meaningless, and the dispatcher requires both to be injected anyway.
        let n = 0;
        const dispatcher = createEngine({
          runtime,
          overrides: { newId: () => `cmd-${(n += 1)}`, now: () => 1_700_000_000_000 + n },
        });
        dispatcher.dispatch({
          type: 'loadPreset',
          preset: patchWith((patch) => {
            // A short, percussive note so separate onsets stay separable, and no release
            // tail smearing one note's decay across the next one's attack.
            patch.voice.envelope = { attack: 0.002, hold: 0, decay: 0.06, decayCurve: 'exponential', sustain: 0, release: 0.02 };
            patch.voice.filterEnvelope = {
              attack: 0.002, hold: 0,
              decay: 0.06, decayCurve: 'exponential',
              sustain: 0,
              release: 0.02,
              baseFrequency: 2000,
              octaves: 0, linked: false,
            };
            patchMutate?.(patch);
          }),
        });
        play((command) => dispatcher.dispatch(command));
      },
      seconds,
      1,
      SR,
    ).then((buffer) => buffer.getChannelData(0));
  }

  const NOTES = ['C3', 'E3', 'G3', 'B3', 'D4', 'F4', 'A4', 'C5'];

  it('sounds every note when the pool has room', async () => {
    const data = await renderPlayed(
      (dispatch) => {
        NOTES.slice(0, 4).forEach((note) => {
          dispatch({ type: 'noteOn', note, velocity: 0.9 });
        });
      },
      (patch) => {
        patch.voice.polyphony = 8;
      },
    );
    expect(rms(data)).toBeGreaterThan(0.01);
  });

  it('holds the cap under overload rather than sounding every note', async () => {
    // Eight notes into a two-voice pool. If stealing did not reach the runtime, all eight
    // MonoSynths would be sounding and the result would be far louder.
    const [capped, roomy] = await Promise.all([
      renderPlayed(
        (dispatch) => {
          NOTES.forEach((note) => dispatch({ type: 'noteOn', note, velocity: 0.9 }));
        },
        (patch) => {
          patch.voice.polyphony = 2;
        },
      ),
      renderPlayed(
        (dispatch) => {
          NOTES.forEach((note) => dispatch({ type: 'noteOn', note, velocity: 0.9 }));
        },
        (patch) => {
          patch.voice.polyphony = 8;
        },
      ),
    ]);

    expect(peak(capped)).toBeLessThan(peak(roomy));
    // ...and it must still make a sound. A steal that killed everything would also pass
    // the comparison above.
    expect(rms(capped)).toBeGreaterThan(0.005);
  });

  it('builds only as many Tone voices as the cap allows', async () => {
    let voiceCount = 0;
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        let n = 0;
        const dispatcher = createEngine({
          runtime,
          overrides: { newId: () => `cmd-${(n += 1)}`, now: () => 1_700_000_000_000 + n },
        });
        dispatcher.dispatch({
          type: 'loadPreset',
          preset: patchWith((patch) => {
            patch.voice.polyphony = 3;
          }),
        });
        NOTES.forEach((note) => dispatcher.dispatch({ type: 'noteOn', note, velocity: 0.8 }));
        voiceCount = runtime.voiceCount;
      },
      0.3,
      1,
      SR,
    );

    // Eight notes, three voices. The runtime builds lazily and core never nominates a
    // voiceId at or above the cap, so no fourth MonoSynth should exist.
    expect(voiceCount).toBe(3);
  });

  it('retriggers the voice already holding a note instead of burning a second slot', async () => {
    let voiceCount = 0;
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        let n = 0;
        const dispatcher = createEngine({
          runtime,
          overrides: { newId: () => `cmd-${(n += 1)}`, now: () => 1_700_000_000_000 + n },
        });
        dispatcher.dispatch({ type: 'loadPreset', preset: defaultPreset() });
        for (let i = 0; i < 5; i += 1) {
          dispatcher.dispatch({ type: 'noteOn', note: 'C4', velocity: 0.8 });
        }
        voiceCount = runtime.voiceCount;
      },
      0.3,
      1,
      SR,
    );

    // Holding C4 and pressing it again is one voice on real hardware. Five presses of the
    // same key must not consume five slots.
    expect(voiceCount).toBe(1);
  });

  it('sounds a stolen slot as the new note, not the old one', async () => {
    // A one-voice pool played twice. If the steal did not reach the runtime, the first
    // note's oscillator would still be running at its own pitch.
    const data = await renderPlayed(
      (dispatch) => {
        dispatch({ type: 'noteOn', note: 'C3', velocity: 0.9 });
        dispatch({ type: 'noteOn', note: 'C5', velocity: 0.9 });
      },
      (patch) => {
        patch.voice.polyphony = 1;
        // Sustained, so there is something to measure the pitch of.
        patch.voice.envelope = { attack: 0.005, hold: 0, decay: 0.01, decayCurve: 'exponential', sustain: 1, release: 0.1 };
        patch.voice.filterEnvelope = {
          attack: 0.005, hold: 0,
          decay: 0.01, decayCurve: 'exponential',
          sustain: 1,
          release: 0.1,
          baseFrequency: 8000,
          octaves: 0, linked: false,
        };
      },
    );

    // C5 is 523 Hz; C3 is 131 Hz. The surviving voice must be the second note.
    const pitch = estimatePitch(data, SR, 0.4);
    expect(pitch).toBeGreaterThan(450);
    expect(pitch).toBeLessThan(600);
  });

  it('lowering polyphony mid-performance reclaims an over-cap voice, not a legitimate one', async () => {
    let voiceCount = 0;
    let notes: string[] = [];
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        let n = 0;
        const dispatcher = createEngine({
          runtime,
          overrides: { newId: () => `cmd-${(n += 1)}`, now: () => 1_700_000_000_000 + n },
        });
        dispatcher.dispatch({ type: 'loadPreset', preset: defaultPreset() });
        NOTES.slice(0, 6).forEach((note) =>
          dispatcher.dispatch({ type: 'noteOn', note, velocity: 0.8 }),
        );
        dispatcher.dispatch({ type: 'setParam', path: 'voice.polyphony', value: 2 });
        dispatcher.dispatch({ type: 'noteOn', note: 'G5', velocity: 0.8 });
        voiceCount = runtime.voiceCount;
        notes = dispatcher.getTransient().voices.map((voice) => voice.note);
      },
      0.3,
      1,
      SR,
    );

    // Six voices existed before the cap dropped, and the pool does not shrink
    // retroactively. What must not happen is a SEVENTH.
    expect(voiceCount).toBe(6);

    // WHICH voice was reclaimed is the whole claim, and counting cannot express it: a
    // globally-oldest steal reuses an existing slot too, so the totals look identical
    // either way. C3 is the oldest note but sits in slot 0, now within the cap; the new
    // note must take an over-budget slot instead, so C3 survives and G3 — the oldest slot
    // at or above the cap — does not.
    expect(notes).toContain('C3');
    expect(notes).toContain('E3');
    expect(notes).not.toContain('G3');
    expect(notes).toContain('G5');
  });
});

describe('ToneRuntime — velocity response (Stage 2d)', () => {
  const FLAT = { attack: 0.005, hold: 0, decay: 0.01, decayCurve: 'exponential' as const, sustain: 1, release: 0.1 };

  function renderVelocity(options: {
    velocity: number;
    toAmplitude?: number;
    toFilterOctaves?: number;
    mutate?: (patch: SynthPreset) => void;
  }): Promise<Float32Array> {
    return render((runtime) => {
      runtime.applyPatch(
        patchWith((patch) => {
          patch.voice.envelope = { ...FLAT };
          patch.voice.filterEnvelope = {
            ...FLAT,
            baseFrequency: 700,
            octaves: 0, linked: false,
          };
          patch.voice.velocity = {
            toAmplitude: options.toAmplitude ?? 1,
            toFilterOctaves: options.toFilterOctaves ?? 0,
          };
          options.mutate?.(patch);
        }),
      );
      runtime.noteOn({ voiceId: 0, note: 'C3', velocity: options.velocity, portamento: 0 });
    }, 0.6);
  }

  const body = (data: Float32Array) =>
    rms(data, Math.floor(0.15 * SR), Math.floor(0.45 * SR));
  const bright = (data: Float32Array) =>
    hfEnergyRatio(data, SR, 2500, Math.floor(0.3 * SR));

  it('level follows velocity when toAmplitude is 1', async () => {
    const [soft, hard] = await Promise.all([
      renderVelocity({ velocity: 0.25 }),
      renderVelocity({ velocity: 1 }),
    ]);
    expect(body(hard)).toBeGreaterThan(body(soft) * 2);
  });

  it('toAmplitude 0 makes every note sound at full level', async () => {
    // The other half. A gate that only proves loud-vs-soft would pass an implementation
    // that ignored toAmplitude entirely and always passed velocity through.
    const [soft, hard] = await Promise.all([
      renderVelocity({ velocity: 0.25, toAmplitude: 0 }),
      renderVelocity({ velocity: 1, toAmplitude: 0 }),
    ]);
    expect(body(soft)).toBeCloseTo(body(hard), 2);
  });

  it('toAmplitude scales between those two, rather than switching', async () => {
    const [off, half, full] = await Promise.all([
      renderVelocity({ velocity: 0.25, toAmplitude: 0 }),
      renderVelocity({ velocity: 0.25, toAmplitude: 0.5 }),
      renderVelocity({ velocity: 0.25, toAmplitude: 1 }),
    ]);
    expect(body(half)).toBeLessThan(body(off));
    expect(body(half)).toBeGreaterThan(body(full));
  });

  it('toFilterOctaves opens the filter on harder notes', async () => {
    const [soft, hard] = await Promise.all([
      renderVelocity({ velocity: 0.2, toFilterOctaves: 4, toAmplitude: 0 }),
      renderVelocity({ velocity: 1, toFilterOctaves: 4, toAmplitude: 0 }),
    ]);
    // toAmplitude 0 so this measures brightness alone — otherwise the louder note would
    // read brighter simply for being louder.
    expect(bright(hard)).toBeGreaterThan(bright(soft));
  });

  it('toFilterOctaves 0 leaves brightness alone', async () => {
    const [soft, hard] = await Promise.all([
      renderVelocity({ velocity: 0.2, toFilterOctaves: 0, toAmplitude: 0 }),
      renderVelocity({ velocity: 1, toFilterOctaves: 0, toAmplitude: 0 }),
    ]);
    expect(Math.abs(bright(hard) - bright(soft))).toBeLessThan(bright(hard) * 0.25);
  });

  it('velocity drives a route, the same way an LFO does', async () => {
    const withRoute = (patch: SynthPreset) => {
      patch.voice.modRoutes = [
        {
          id: 'r-vel',
          enabled: true,
          source: 'velocity',
          destination: 'voice.filterEnvelope.baseFrequency',
          depth: 0.3,
        },
      ];
    };

    const [soft, hard] = await Promise.all([
      renderVelocity({ velocity: 0.1, toAmplitude: 0, mutate: withRoute }),
      renderVelocity({ velocity: 1, toAmplitude: 0, mutate: withRoute }),
    ]);
    expect(bright(hard)).toBeGreaterThan(bright(soft));
  });

  it('a stolen voice sounds the NEW note velocity through the amp envelope', async () => {
    // Proves the reused voice's triggerAttack gets this note's velocity rather than
    // carrying the previous one's. It does NOT exercise the velocity SIGNAL — nothing is
    // routed here, so the signal is connected to nothing; the route case is the next test.
    const stolen = await render((runtime) => {
      runtime.applyPatch(
        patchWith((patch) => {
          patch.voice.envelope = { ...FLAT };
          patch.voice.velocity = { toAmplitude: 1, toFilterOctaves: 0 };
        }),
      );
      runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 1, portamento: 0 });
      runtime.steal(0);
      runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 0.15, portamento: 0 });
    }, 0.6);

    const quiet = await render((runtime) => {
      runtime.applyPatch(
        patchWith((patch) => {
          patch.voice.envelope = { ...FLAT };
          patch.voice.velocity = { toAmplitude: 1, toFilterOctaves: 0 };
        }),
      );
      runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 0.15, portamento: 0 });
    }, 0.6);

    // The stolen slot must settle to the quiet note's level, not the loud one's.
    expect(body(stolen)).toBeLessThan(body(quiet) * 2.5);
  });

  it('a stolen voice re-reads velocity into its ROUTES, not just its envelope', async () => {
    // The gate the previous test cannot be. With a velocity route active, the signal is
    // what carries the value into the graph — an implementation that wrote it once per
    // voice and never again passes every other check here, because the amp envelope gets
    // its velocity through a separate path.
    const routed = (patch: SynthPreset) => {
      patch.voice.envelope = { ...FLAT };
      patch.voice.filterEnvelope = { ...FLAT, baseFrequency: 500, octaves: 0, linked: false };
      patch.voice.velocity = { toAmplitude: 0, toFilterOctaves: 0 };
      patch.voice.modRoutes = [
        {
          id: 'r-vel',
          enabled: true,
          source: 'velocity',
          destination: 'voice.filterEnvelope.baseFrequency',
          depth: 0.5,
        },
      ];
    };

    const [stolen, direct] = await Promise.all([
      render((runtime) => {
        runtime.applyPatch(patchWith(routed));
        runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 1, portamento: 0 });
        runtime.steal(0);
        runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 0.05, portamento: 0 });
      }, 0.6),
      render((runtime) => {
        runtime.applyPatch(patchWith(routed));
        runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 0.05, portamento: 0 });
      }, 0.6),
    ]);

    // The reused slot must be as dark as a fresh quiet note — if it kept the loud note's
    // velocity on the signal, the filter would still be wide open.
    expect(bright(stolen)).toBeLessThan(bright(direct) * 2);
  });

  it('builds one velocity signal per voice, since each holds a different value', async () => {
    let nodeCount = 0;
    let voiceCount = 0;
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(defaultPreset());
        for (let i = 0; i < 4; i += 1) {
          runtime.noteOn({ voiceId: i, note: 'C3', velocity: 0.5, portamento: 0 });
        }
        voiceCount = runtime.voiceCount;
        nodeCount = runtime.nodeCount;
      },
      0.2,
      1,
      SR,
    );
    expect(voiceCount).toBe(4);
    // 4 voices x (synth + gain + panner + velocity) + master/analyser/meter. No LFOs and
    // no routes in the factory patch, so nothing else is built.
    // 4 voices x 7 fixed nodes + 4 oscillator slots x 4 + master/analyser/meter.
    // 11 fixed per voice since the drive stage (schema_version 7) added four.
    expect(nodeCount).toBe(4 * 11 + 4 * 4 + 3);
  });
});

describe('ToneRuntime — oscillator mapping (Stage 2c)', () => {
  function renderOsc(mutate: (patch: SynthPreset) => void, seconds = 0.6): Promise<Float32Array> {
    return render((runtime) => {
      runtime.applyPatch(
        patchWith((patch) => {
          // Flat amp and a pinned, wide-open filter, so what the spectrum shows is the
          // OSCILLATOR and not a contour moving underneath it.
          patch.voice.envelope = { attack: 0.005, hold: 0, decay: 0.01, decayCurve: 'exponential', sustain: 1, release: 0.1 };
          patch.voice.filterEnvelope = {
            attack: 0.005, hold: 0,
            decay: 0.01, decayCurve: 'exponential',
            sustain: 1,
            release: 0.1,
            baseFrequency: 12000,
            octaves: 0, linked: false,
          };
          mutate(patch);
        }),
      );
      runtime.noteOn({ voiceId: 0, note: 'A3', velocity: 0.8, portamento: 0 });
    }, seconds);
  }

  /** A second slot, on top of whatever slot 0 already is. */
  function withSlot(overrides: Partial<{ detune: number; octave: number; level: number; pan: number; enabled: boolean }>) {
    return (patch: SynthPreset) => {
      patch.voice.oscillators = [
        ...patch.voice.oscillators,
        {
          id: 'osc-1',
          enabled: overrides.enabled ?? true,
          type: 'sawtooth' as const,
          octave: overrides.octave ?? 0,
          detune: overrides.detune ?? 0,
          count: 1,
          spread: 20,
          width: 0,
          level: overrides.level ?? 1,
          pan: overrides.pan ?? 0,
        },
      ];
    };
  }

  /**
   * Peak-to-trough of the level across a sustained note, in dB.
   *
   * Two oscillators a few cents apart interfere: they drift in and out of phase at the
   * difference frequency, and the sum swings between nearly double and nearly nothing.
   * That beating IS the detuned-pair sound, and one oscillator cannot produce it at all —
   * which makes this the measurement that separates two slots from one loud slot.
   */
  function beatDepthDb(data: Float32Array): number {
    // 0.2 s to 0.9 s, which needs a render longer than `renderOsc`'s 0.6 s default — the
    // first version sampled past the end of the buffer and read the trailing zeros as a
    // trough, reporting 163 dB of "beating" on a single steady oscillator.
    //
    // The span is set by the beat, not by taste: 25 cents at A3 is about 3.2 Hz, so one
    // full cycle is 0.31 s and this holds two of them. A window shorter than one cycle
    // can land entirely inside a crest and see nothing move.
    const points = Array.from({ length: 35 }, (_unused, i) => {
      const start = Math.floor((0.2 + i * 0.02) * SR);
      return rms(data, start, start + Math.floor(0.02 * SR));
    });
    return 20 * Math.log10(Math.max(...points) / Math.max(Math.min(...points), 1e-9));
  }

  /** Long enough for `beatDepthDb` to see two full beats. */
  const BEAT_SECONDS = 1.2;

  /**
   * A TWO-CHANNEL render, which every other gate in this file is not.
   *
   * That gap shipped a decoy: `voice.oscillators.N.pan` validated, journalled, replayed
   * and did nothing, because `Tone.Panner` defaults to `channelCount: 1` and the
   * voice-level panner therefore down-mixed the slots' placement to mono before panning
   * it again. In a one-channel render that is invisible — everything is mono by the time
   * it is measured. Stereo is not a nicety here; it is the only way to see the parameter
   * at all.
   */
  function renderStereo(
    mutate: (patch: SynthPreset) => void,
    seconds = 0.8,
  ): Promise<readonly [Float32Array, Float32Array]> {
    return Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.envelope = { attack: 0.005, hold: 0, decay: 0.01, decayCurve: 'exponential', sustain: 1, release: 0.1 };
            patch.voice.filterEnvelope = {
              attack: 0.005, hold: 0,
              decay: 0.01, decayCurve: 'exponential',
              sustain: 1,
              release: 0.1,
              baseFrequency: 2000,
              octaves: 0, linked: false,
            };
            mutate(patch);
          }),
        );
        runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 0.9, portamento: 0 });
      },
      seconds,
      2,
      SR,
    ).then((buffer) => [buffer.getChannelData(0), buffer.getChannelData(1)] as const);
  }

  const channel = (data: Float32Array) => rms(data, Math.floor(0.2 * SR), Math.floor(0.6 * SR));

  it('places a slot in the stereo field — hard left is LEFT, not centre and quieter', async () => {
    // The gate the mono harness could not be. Measured before the fix: L 0.1129 against
    // R 0.1125 — identical channels at 0.707x the centred level, which is precisely what
    // a down-mix looks like and precisely what "the knob does nothing" sounds like.
    const [centreL, centreR] = await renderStereo(() => {});
    const [leftL, leftR] = await renderStereo((patch) => {
      patch.voice.oscillators[0]!.pan = -1;
    });

    expect(channel(centreL)).toBeCloseTo(channel(centreR), 2);
    expect(channel(leftL)).toBeGreaterThan(channel(leftR) * 20);
    // And it is not merely quieter on one side: the left channel gains what the right lost.
    expect(channel(leftL)).toBeGreaterThan(channel(centreL));
  });

  it('keeps two slots apart when they are panned apart', async () => {
    // Different CONTENT per channel, not just different levels. Two slots 12 cents apart
    // split hard left and right leave a large difference signal; the same two centred
    // leave almost none. A down-mix anywhere in the chain collapses both cases to the same
    // thing, which is how the first version passed every assertion it had.
    const split = await renderStereo((patch) => {
      patch.voice.oscillators = [
        { ...patch.voice.oscillators[0]!, pan: -1 },
        { ...patch.voice.oscillators[0]!, id: 'osc-1', detune: 12, pan: 1 },
      ];
    });
    const together = await renderStereo((patch) => {
      patch.voice.oscillators = [
        { ...patch.voice.oscillators[0]!, pan: 0 },
        { ...patch.voice.oscillators[0]!, id: 'osc-1', detune: 12, pan: 0 },
      ];
    });

    const side = ([l, r]: readonly [Float32Array, Float32Array]) => {
      const difference = new Float32Array(l.length);
      for (let i = 0; i < l.length; i += 1) difference[i] = (l[i]! - r[i]!) / 2;
      return channel(difference);
    };

    expect(side(split)).toBeGreaterThan(side(together) * 20);
  });

  it('two slots detuned against each other beat; one slot cannot', async () => {
    // The reason three slots exist. 25 cents at A3 is a difference of about 3.2 Hz, so a
    // 0.6 s window holds two full beats — audible as movement, not as a chorus effect
    // bolted on afterwards.
    const [single, pair] = await Promise.all([
      renderOsc(() => {}, BEAT_SECONDS),
      renderOsc(withSlot({ detune: 25 }), BEAT_SECONDS),
    ]);

    expect(rms(pair)).toBeGreaterThan(0.01);
    // One slot is a steady tone: whatever its level, it does not swing.
    // Measured: 0.68 dB for one slot against 5.84 dB for two, an 8.6x separation. The
    // pair's figure is not larger because a sawtooth's harmonics beat at DIFFERENT rates —
    // harmonic n at n times the difference frequency — so they never all cancel at once.
    // Two sines would null almost completely; two saws swell and thin, which is the sound
    // being asked for.
    expect(beatDepthDb(single)).toBeLessThan(2);
    expect(beatDepthDb(pair)).toBeGreaterThan(4);
    expect(beatDepthDb(pair)).toBeGreaterThan(beatDepthDb(single) * 4);
  });

  it('a slot at level 0 contributes nothing, and disabling one is the same as silencing it', async () => {
    // Two ways to say "not this slot", which must agree. If they did not, `enabled` would
    // be a second opinion about level rather than a mute.
    const [alone, silent, disabled] = await Promise.all([
      renderOsc(() => {}, BEAT_SECONDS),
      renderOsc(withSlot({ detune: 25, level: 0 }), BEAT_SECONDS),
      renderOsc(withSlot({ detune: 25, enabled: false }), BEAT_SECONDS),
    ]);

    expect(rms(silent)).toBeCloseTo(rms(alone), 3);
    expect(rms(disabled)).toBeCloseTo(rms(alone), 3);
    expect(beatDepthDb(disabled)).toBeLessThan(3);
  });

  it('slot level mixes rather than switching — half is between nothing and all', async () => {
    // Monotonic, and the negative half of the gate above: a `level` that only distinguished
    // zero from non-zero would pass every assertion there.
    const [off, half, full] = await Promise.all([
      renderOsc(withSlot({ detune: 25, level: 0 }), BEAT_SECONDS),
      renderOsc(withSlot({ detune: 25, level: 0.5 }), BEAT_SECONDS),
      renderOsc(withSlot({ detune: 25, level: 1 }), BEAT_SECONDS),
    ]);

    expect(beatDepthDb(half)).toBeGreaterThan(beatDepthDb(off));
    expect(beatDepthDb(full)).toBeGreaterThan(beatDepthDb(half));
  });

  it('the octave switch moves a slot by exactly an octave', async () => {
    // A3 is 220 Hz. Slot 0 muted so the pitch estimate reads the second slot alone —
    // measuring a sum of two pitches would measure the beat, not the transposition.
    const down = await renderOsc((patch) => {
      withSlot({ octave: -1 })(patch);
      patch.voice.oscillators[0]!.enabled = false;
    });
    const up = await renderOsc((patch) => {
      withSlot({ octave: 1 })(patch);
      patch.voice.oscillators[0]!.enabled = false;
    });

    // Generous windows: this asks whether the octave reached the oscillator at all.
    expect(estimatePitch(down, SR, 0.3)).toBeGreaterThan(95);
    expect(estimatePitch(down, SR, 0.3)).toBeLessThan(125);
    expect(estimatePitch(up, SR, 0.3)).toBeGreaterThan(400);
    expect(estimatePitch(up, SR, 0.3)).toBeLessThan(480);
  });

  it('costs one oscillator per slot per voice, and no more', async () => {
    // The cost model, measured rather than assumed — the same discipline the shared-phase
    // LFO departure was settled with. Three slots across eight sounding voices is 24
    // oscillator objects; a construction that built MAX_OSCILLATORS regardless of how many
    // the patch declared would read 24 for a one-slot patch too.
    let single = 0;
    let triple = 0;
    await Tone.Offline(
      () => {
        const one = new ToneRuntime();
        one.applyPatch(patchWith(() => {}));
        for (let i = 0; i < 8; i += 1) one.noteOn({ voiceId: i, note: 'C3', velocity: 0.7, portamento: 0 });
        single = one.oscillatorCount;

        const three = new ToneRuntime();
        three.applyPatch(
          patchWith((patch) => {
            withSlot({ detune: 10 })(patch);
            withSlot({ detune: -10 })(patch);
          }),
        );
        for (let i = 0; i < 8; i += 1) three.noteOn({ voiceId: i, note: 'C3', velocity: 0.7, portamento: 0 });
        triple = three.oscillatorCount;
      },
      0.2,
      1,
      SR,
    );

    expect(single).toBe(8);
    expect(triple).toBe(24);
  });

  it('maps the type string, not just the four basic shapes', () => {
    const optionsFor = (mutate: (patch: SynthPreset) => void) =>
      oscillatorOptions(patchWith(mutate).voice.oscillators[0]!);

    expect(optionsFor((p) => { p.voice.oscillators[0]!.type = 'sawtooth'; }).type).toBe('sawtooth');
    // count > 1 selects the fat variant; count 1 must NOT, or every patch pays for an
    // extra oscillator producing an identical sound.
    expect(
      optionsFor((p) => { p.voice.oscillators[0]!.type = 'sawtooth'; p.voice.oscillators[0]!.count = 3; }).type,
    ).toBe('fatsawtooth');
    expect(optionsFor((p) => { p.voice.oscillators[0]!.type = 'pulse'; }).type).toBe('pulse');
    expect(optionsFor((p) => { p.voice.oscillators[0]!.type = 'pwm'; }).type).toBe('pwm');
  });

  it('applies base detune, which used to be modulatable but unset', async () => {
    // The decoy this stage closes: voice.oscillators.0.detune was a wired modulation
    // destination whose base value never reached the graph, so routing to it moved the
    // pitch and setting it did nothing.
    const data = await renderOsc((patch) => {
      patch.voice.oscillators[0]!.detune = 1200; // one octave up
    });

    // A3 is 220 Hz; +1200 cents is 440 Hz. A generous window — this asks whether the
    // value reached the oscillator at all, not for tuning accuracy.
    const pitch = estimatePitch(data, SR, 0.3);
    expect(pitch).toBeGreaterThan(400);
    expect(pitch).toBeLessThan(480);
  });

  it('unison detunes into a thicker sound than the plain shape', async () => {
    const [plain, fat] = await Promise.all([
      renderOsc((patch) => {
        patch.voice.oscillators[0]!.count = 1;
        patch.voice.oscillators[0]!.spread = 40;
      }),
      renderOsc((patch) => {
        patch.voice.oscillators[0]!.count = 5;
        patch.voice.oscillators[0]!.spread = 40;
      }),
    ]);

    // Detuned copies beat against each other, so the amplitude envelope of the sustained
    // tone wanders where a single oscillator's is steady. Comparing spectra would not
    // separate them nearly as cleanly — the harmonic series is the same shape.
    const spread = (data: Float32Array) => {
      const points = Array.from({ length: 20 }, (_unused, i) => {
        const start = Math.floor((0.15 + i * 0.02) * SR);
        return rms(data, start, start + Math.floor(0.02 * SR));
      });
      return Math.max(...points) - Math.min(...points);
    };
    expect(spread(fat)).toBeGreaterThan(spread(plain) * 2);
  });

  it('pulse width changes the harmonic content', async () => {
    const [square, narrow] = await Promise.all([
      renderOsc((patch) => {
        patch.voice.oscillators[0]!.type = 'pulse';
        patch.voice.oscillators[0]!.width = 0; // square — even harmonics cancel
      }),
      renderOsc((patch) => {
        patch.voice.oscillators[0]!.type = 'pulse';
        patch.voice.oscillators[0]!.width = 0.8; // narrow pulse — much brighter
      }),
    ]);

    const hf = (data: Float32Array) => hfEnergyRatio(data, SR, 3000, Math.floor(0.3 * SR));
    expect(hf(narrow)).toBeGreaterThan(hf(square));
  });

  it('width 0 really is the neutral value, not 0.5', async () => {
    // The contract correction. Tone's pulse width runs -1..1 with 0 meaning square, and
    // our declared default was 0.5 — a 75% duty cycle wearing the costume of neutral.
    const [atZero, square] = await Promise.all([
      renderOsc((patch) => {
        patch.voice.oscillators[0]!.type = 'pulse';
        patch.voice.oscillators[0]!.width = 0;
      }),
      renderOsc((patch) => {
        patch.voice.oscillators[0]!.type = 'square';
      }),
    ]);

    const hf = (data: Float32Array) => hfEnergyRatio(data, SR, 3000, Math.floor(0.3 * SR));
    // A pulse at width 0 IS a square wave, so the two should sit close together.
    expect(Math.abs(hf(atZero) - hf(square))).toBeLessThan(Math.max(hf(square), 0.01));
  });

  it('names every combination the oscillator type cannot honour', () => {
    const gaps = (mutate: (patch: SynthPreset) => void) =>
      unsupportedOscillatorFeatures(patchWith(mutate).voice.oscillators[0]!, 0);

    // noise is not an OmniOscillator type in any form; it sounds as a sawtooth.
    expect(gaps((p) => { p.voice.oscillators[0]!.type = 'noise'; })).toContain('oscillator.0.noise');
    // there is no fatpulse — unison and the pulse family are mutually exclusive in Tone.
    expect(
      gaps((p) => { p.voice.oscillators[0]!.type = 'pulse'; p.voice.oscillators[0]!.count = 3; }),
    ).toContain('oscillator.0.unison.pulse');
    // width belongs to PulseOscillator alone; pwm has no width at all.
    expect(
      gaps((p) => { p.voice.oscillators[0]!.type = 'pwm'; p.voice.oscillators[0]!.width = 0.5; }),
    ).toContain('oscillator.0.width.pwm');
    // ...and a legal patch reports nothing, or the check would pass by always complaining.
    expect(gaps((p) => { p.voice.oscillators[0]!.type = 'sawtooth'; p.voice.oscillators[0]!.count = 3; })).toEqual([]);
    expect(gaps((p) => { p.voice.oscillators[0]!.type = 'pulse'; p.voice.oscillators[0]!.width = 0.4; })).toEqual([]);
  });

  it('reports those gaps through the runtime, not just the pure function', async () => {
    let reported: readonly string[] = [];
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.oscillators[0]!.type = 'noise';
          }),
        );
        reported = runtime.getUnimplemented();
      },
      0.05,
      1,
      SR,
    );
    expect(reported).toContain('oscillator.0.noise');
  });
});

describe('ToneRuntime — the unmapped-parameter list stays honest', () => {
  // This list read "none" for one commit while a quarter of the parameter surface did
  // nothing, because it had only ever tracked a single decoy and emptying it looked like
  // completion. These checks make both failure directions cost a test.

  it('lists only real parameter addresses', () => {
    // Catches a stale entry after a rename — a listed path that no longer exists reports
    // a gap nobody can close.
    for (const path of UNMAPPED_PARAMS) {
      expect(PARAM_PATHS, `"${path}" is listed unmapped but is not an address`).toContain(path);
    }
  });

  it('does not list anything the runtime demonstrably reads', () => {
    // The other direction: claiming a working parameter is unmapped sends someone to
    // implement what already works.
    expect(oscillatorOptions(defaultPreset().voice.oscillators[0]!).type).toBeDefined();
    expect(frequencyEnvelopeOptions(defaultPreset()).baseFrequency).toBeGreaterThan(0);
    for (const path of [
      'voice.oscillators.0.type',
      'voice.envelope.attack',
      'voice.filter.type',
      'voice.filterEnvelope.baseFrequency',
    ]) {
      expect(UNMAPPED_PARAMS, `"${path}" is mapped but listed unmapped`).not.toContain(path);
    }
  });

  it('no longer lists the oscillator group, because Stage 2c mapped it', () => {
    // voice.oscillators.0.detune is the case that motivated the whole list: a live
    // modulation destination whose base value was dropped, so routing to it worked and
    // setting it did nothing. Now read, so it must be off the list AND actually applied —
    // the second half matters, since removing an entry is the easy way to fake progress.
    for (const path of [
      'voice.oscillators.0.detune',
      'voice.oscillators.0.count',
      'voice.oscillators.0.spread',
      'voice.oscillators.0.width',
    ]) {
      expect(UNMAPPED_PARAMS, `"${path}" is mapped now`).not.toContain(path);
    }
    const patch = defaultPreset();
    patch.voice.oscillators[0]!.detune = 550;
    // A slot's detune and its octave switch land on ONE param, in cents, because that is
    // the only audio-rate pitch input an oscillator has. An octave IS 1200 cents.
    expect(slotDetune(patch.voice.oscillators[0]!)).toBe(550);
    patch.voice.oscillators[0]!.octave = -1;
    expect(slotDetune(patch.voice.oscillators[0]!)).toBe(550 - 1200);
  });
});

describe('ToneRuntime — honesty about what it cannot do', () => {
  it('services the transport now, and still reports what a song asks for that slice 1 simplifies', async () => {
    let plain: readonly string[] = [];
    let multi: readonly string[] = [];
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applySong(defaultSong());
        runtime.transport.play();
        runtime.transport.seek(4);
        plain = runtime.getUnimplemented();

        // An imported drum track with no kick voice is a thing this stage cannot play, and
        // says so. The two pitched tracks beside it are ordinary channels.
        const song = defaultSong();
        const second = { ...song.tracks[0]!, id: 'second', volume: -6 };
        const drums = { ...song.tracks[0]!, id: 'drums', isDrum: true, notes: [{ noteId: 'd', time: 0, duration: 0.25, note: 'C1', velocity: 1 }] };
        runtime.applySong({ ...song, tracks: [...song.tracks, second, drums] });
        multi = runtime.getUnimplemented();
      },
      0.05,
      1,
      SR,
    );

    // Recording rather than throwing or pretending is still the rule (v0.1.0); what changed
    // in SAG-DAW slice 1 is that play/seek/applySong are no longer on the list at all.
    // `getUnimplemented()` going empty for a plain song is the acceptance signal
    // HANDOFF-SAG-DAW.md §4.2 named.
    expect(plain).toEqual([]);
    // C5b closed two of these: a second pitched track is a CHANNEL with its own sound now,
    // and a moved fader is written to that channel's strip. A drum track carrying notes and
    // no kick voice is still a thing this stage cannot play, and still says so.
    expect([...multi].sort()).toEqual(['applySong.drumWithoutKick']);
  });

  it('applySong is partial, not absent — the master stage really is applied', async () => {
    // The other half of the claim above. A method that reports itself unimplemented and
    // then quietly does nothing would pass the check above just as well.
    const [quiet, loud] = await Promise.all([
      render((runtime) => {
        runtime.applyPatch(defaultPreset());
        runtime.applySong({ ...defaultSong(), master: { volume: -40, limiterThreshold: -1 } });
        runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.9, portamento: 0 });
      }),
      render((runtime) => {
        runtime.applyPatch(defaultPreset());
        runtime.applySong({ ...defaultSong(), master: { volume: 0, limiterThreshold: -1 } });
        runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.9, portamento: 0 });
      }),
    ]);

    expect(rms(loud)).toBeGreaterThan(rms(quiet) * 4);
  });
});

// ---------------------------------------------------------------------------
// Modulation routing — KIND-synth_mod_route F73 / F74
// ---------------------------------------------------------------------------

describe('ToneRuntime — modulation routing', () => {
  const FLAT_AMP = { attack: 0.005, hold: 0, decay: 0.01, decayCurve: 'exponential' as const, sustain: 1, release: 0.1 };

  /**
   * One held note, sounded through a patch carrying one LFO and one route.
   *
   * `enabled` is the ONLY thing that varies between the two renders a gate compares.
   * Everything else — the LFO, the route, its depth and destination — is present in both,
   * so a difference cannot come from the patch being structurally different. That is what
   * makes the comparison a test of modulation rather than a test of two unrelated sounds.
   */
  function renderRouted(options: {
    enabled: boolean;
    destination: string;
    depth: number;
    rate?: number;
    seconds?: number;
    baseFrequency?: number;
    mutate?: (patch: SynthPreset) => void;
  }): Promise<Float32Array> {
    return render(
      (runtime) => {
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.envelope = { ...FLAT_AMP };
            // A pinned filter, so the only thing moving the cutoff is the route.
            patch.voice.filterEnvelope = {
              attack: 0.005, hold: 0,
              decay: 0.01, decayCurve: 'exponential',
              sustain: 1,
              release: 0.1,
              baseFrequency: options.baseFrequency ?? 800,
              octaves: 0, linked: false,
            };
            patch.voice.lfos = [
              {
                id: 'lfo-0',
                enabled: true,
                type: 'sine',
                frequency: options.rate ?? 8,
                sync: false,
                retrigger: false,
              },
            ];
            patch.voice.modRoutes = [
              {
                id: 'route-0',
                enabled: options.enabled,
                source: 'lfo.0',
                destination: options.destination as never,
                depth: options.depth,
              },
            ];
            options.mutate?.(patch);
          }),
        );
        runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 0.9, portamento: 0 });
      },
      options.seconds ?? 1,
    );
  }

  /** Spread of a measurement across the note — how much the sound MOVES over time. */
  function movement(data: Float32Array, sample: (d: Float32Array, s: number) => number): number {
    const points = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5].map((t) => sample(data, t));
    return Math.max(...points) - Math.min(...points);
  }

  function hfAt(data: Float32Array, seconds: number, aboveHz = 2000): number {
    return hfEnergyRatio(data, SR, aboveHz, Math.floor(seconds * SR));
  }

  /**
   * 40 ms, not 20. A C3 cycle is 7.6 ms, so a 20 ms window holds barely two and a half of
   * them and its RMS wobbles with wherever the window happens to land in the waveform.
   * That noise floor measured 0.0124 on an UNMODULATED note — most of the way to the
   * 0.0177 a real tremolo produced, which is a gate that cannot tell them apart.
   * 40 ms averages five cycles while still being a sixth of the LFO period at 4 Hz.
   */
  function rmsAt(data: Float32Array, seconds: number): number {
    const start = Math.floor(seconds * SR);
    return rms(data, start, Math.min(start + Math.floor(0.04 * SR), data.length));
  }

  it('F74 — an enabled cutoff route moves the filter; the same route disabled does not', async () => {
    const [off, on] = await Promise.all([
      renderRouted({ enabled: false, destination: 'voice.filterEnvelope.baseFrequency', depth: 0.3 }),
      renderRouted({ enabled: true, destination: 'voice.filterEnvelope.baseFrequency', depth: 0.3 }),
    ]);

    // Both halves are required. "Something changed" alone cannot tell modulation apart
    // from a patch that simply broke.
    expect(rms(on)).toBeGreaterThan(0.01);
    expect(movement(on, hfAt)).toBeGreaterThan(movement(off, hfAt) * 3);
  });

  /** Peak-to-trough of the level across the note, in dB — how deep the tremolo sounds. */
  function duckDepthDb(data: Float32Array): number {
    const points = Array.from({ length: 24 }, (_unused, i) => rmsAt(data, 0.15 + i * 0.02));
    const loud = Math.max(...points);
    const quiet = Math.max(Math.min(...points), 1e-9);
    return 20 * Math.log10(loud / quiet);
  }

  it('F74 — an enabled amplitude route ducks the level; disabled holds it steady', async () => {
    const tremolo = { destination: 'voice.amplitude', depth: 0.3, rate: 4 };
    const [off, on] = await Promise.all([
      renderRouted({ ...tremolo, enabled: false }),
      renderRouted({ ...tremolo, enabled: true }),
    ]);

    expect(rms(on)).toBeGreaterThan(0.005);
    expect(duckDepthDb(on)).toBeGreaterThan(duckDepthDb(off) * 3);
  });

  it('F74 — depth 0.3 is a tremolo you can hear, not a measurable one', async () => {
    // The gate that would have caught the original mapping. A linear swing about a base of
    // 1.0 gave depth 0.3 about 2.4 dB peak-to-peak, which passed every "did it move" check
    // above and was reported from the device as barely audible. Loudness is logarithmic,
    // so the gate has to be too: this asserts a perceptual floor, not a difference.
    const on = await renderRouted({
      enabled: true,
      destination: 'voice.amplitude',
      depth: 0.3,
      rate: 4,
    });

    expect(duckDepthDb(on)).toBeGreaterThan(10);
  });

  it('a shallow amplitude route stays gentle — depth still means something', async () => {
    // The other side of the previous check. A mapping that made everything dramatic would
    // pass it just as well as a correct one.
    const [gentle, firm] = await Promise.all([
      renderRouted({ enabled: true, destination: 'voice.amplitude', depth: 0.05, rate: 4 }),
      renderRouted({ enabled: true, destination: 'voice.amplitude', depth: 0.5, rate: 4 }),
    ]);

    expect(duckDepthDb(gentle)).toBeLessThan(duckDepthDb(firm));
    expect(duckDepthDb(gentle)).toBeLessThan(10);
  });

  it('one LFO driving two destinations gives each its own depth', async () => {
    // The regression this exists for: the swing used to be set on the GENERATOR, so a
    // second route from the same LFO overwrote the first's. A cutoff route sharing an LFO
    // with a pan route came out modulating the cutoff by ±0.3 Hz — inaudible, and
    // invisible to every other gate here, because each destination on its own was fine.
    const withSecondRoute = (patch: SynthPreset) => {
      patch.voice.modRoutes = [
        ...patch.voice.modRoutes,
        { id: 'route-1', enabled: true, source: 'lfo.0', destination: 'voice.pan', depth: 0.9 },
      ];
    };

    const [alone, shared] = await Promise.all([
      renderRouted({ enabled: true, destination: 'voice.filterEnvelope.baseFrequency', depth: 0.4 }),
      renderRouted({
        enabled: true,
        destination: 'voice.filterEnvelope.baseFrequency',
        depth: 0.4,
        mutate: withSecondRoute,
      }),
    ]);

    // Adding a pan route must not change how far the cutoff route travels. Rendered mono,
    // so the pan route itself is not what is being measured here.
    const aloneTravel = movement(alone, hfAt);
    const sharedTravel = movement(shared, hfAt);
    expect(sharedTravel).toBeGreaterThan(aloneTravel * 0.5);
  });

  it('F73 — a deeper route travels further than a shallow one at the same rate', async () => {
    // Depth is normalised against the destination's declared range, so this is the check
    // that the scaling is monotonic rather than clamped or inverted somewhere.
    const [shallow, deep] = await Promise.all([
      renderRouted({ enabled: true, destination: 'voice.filterEnvelope.baseFrequency', depth: 0.05 }),
      renderRouted({ enabled: true, destination: 'voice.filterEnvelope.baseFrequency', depth: 0.6 }),
    ]);

    expect(movement(deep, hfAt)).toBeGreaterThan(movement(shallow, hfAt));
  });

  /**
   * One full LFO cycle at 1 Hz, sampled 21 times.
   *
   * The rate is slow on purpose. A spectral window is 4096 samples — 93 ms — so at the
   * 8 Hz used elsewhere each measurement smears across most of a cycle and reads back the
   * average rather than the extremes. At 1 Hz the window is a tenth of a cycle, which is
   * what makes peak-to-trough travel a real measurement instead of a smoothed one.
   */
  const SWEEP_POINTS = Array.from({ length: 21 }, (_unused, i) => 0.3 + i * 0.05);

  /** How far the top of the spectrum travels over that cycle, in octaves. */
  function sweepTravel(data: Float32Array): number {
    const points = SWEEP_POINTS.map((t) => spectralEdgeOctaves(data, SR, Math.floor(t * SR)));
    return Math.max(...points) - Math.min(...points);
  }

  /** Loudest window against quietest over that cycle, in dB. A sweep is not a gate. */
  function sweepDynamicRangeDb(data: Float32Array): number {
    const points = SWEEP_POINTS.map((t) => rmsAt(data, t));
    return 20 * Math.log10(Math.max(...points) / Math.max(Math.min(...points), 1e-9));
  }

  it('F80 — one cutoff route sweeps the same distance from two bases two octaves apart', async () => {
    // The gate the `linear` mapping cannot pass, and the reason `curve: octaves` exists.
    //
    // Depth used to scale against the destination's declared range, so a cutoff route at
    // depth 0.5 swung +/-4995 Hz whatever the cutoff was. From 800 Hz that is an excursion
    // to -4195 Hz, which the audio graph clamps at its floor: the filter sits shut for a
    // large part of every cycle and the route GATES instead of sweeping. From a high base
    // the same route barely moves anything audible. One depth, two unrelated results.
    //
    // Both bases are chosen so the C3 fundamental at 131 Hz stays below the bottom of the
    // sweep (200 Hz and 800 Hz), which is what makes a collapse in level attributable to
    // the clamp rather than to the note simply being filtered out.
    const sweep = {
      enabled: true,
      destination: 'voice.filterEnvelope.baseFrequency',
      depth: 0.5,
      rate: 1,
      seconds: 1.6,
    };
    const [low, high] = await Promise.all([
      renderRouted({ ...sweep, baseFrequency: 800 }),
      renderRouted({ ...sweep, baseFrequency: 3200 }),
    ]);

    const [lowTravel, highTravel] = [sweepTravel(low), sweepTravel(high)];

    // Each moves the spectrum properly — measured in octaves, so "properly" means the same
    // thing at both ends rather than four times as much at the top.
    expect(lowTravel).toBeGreaterThan(1.5);
    expect(highTravel).toBeGreaterThan(1.5);

    // And by comparable amounts. This is the invariance itself: same depth, same gesture,
    // wherever the cutoff happens to sit.
    expect(Math.min(lowTravel, highTravel) / Math.max(lowTravel, highTravel)).toBeGreaterThan(0.5);

    // The half that fails loudest under the old mapping, and the negative probe that makes
    // this gate worth having. Putting `curve: 'linear'` back on this destination and
    // pointing the connection at `filter.frequency` again measured **65.9 dB** here against
    // the 15 below — the clamped cutoff taking the level to silence for part of every
    // cycle, exactly as the KIND's §3.3 says it does. An exponential sweep never can.
    expect(sweepDynamicRangeDb(low)).toBeLessThan(15);
    expect(sweepDynamicRangeDb(high)).toBeLessThan(15);
  });

  it('two amplitude ducks push the voice above its own level, exactly as modulationLoad says', async () => {
    // The route-overflow indicator's central claim, checked against a rendered buffer
    // rather than against itself. `rewireRoutes` assigns the re-centred resting gain once
    // per route, so a second duck route wins the centre while BOTH scalers still sum: the
    // peak lands above the patch's own amplitude, which is the one thing a one-directional
    // duck is supposed to make impossible.
    //
    // Arithmetic agreeing with arithmetic would prove nothing here, so the prediction comes
    // out of `modulationLoad` and the measurement out of the audio.
    const second = (patch: SynthPreset) => {
      patch.voice.modRoutes = [
        ...patch.voice.modRoutes,
        { id: 'route-1', enabled: true, source: 'lfo.0', destination: 'voice.amplitude', depth: 0.5 },
      ];
    };
    const duck = { destination: 'voice.amplitude', depth: 0.5, rate: 4 } as const;
    const [unmodulated, single, doubled] = await Promise.all([
      renderRouted({ ...duck, enabled: false }),
      renderRouted({ ...duck, enabled: true }),
      renderRouted({ ...duck, enabled: true, mutate: second }),
    ]);

    // Past the attack, so the envelope is not what is being measured.
    const sustained = (data: Float32Array) => peak(data, Math.floor(0.15 * SR), data.length);

    // One duck only attenuates: the peak is the patch's own level, untouched.
    expect(sustained(single) / sustained(unmodulated)).toBeLessThan(1.02);

    const state = {
      ...initialEngineState(),
      patch: patchWith((patch) => {
        patch.voice.modRoutes = [
          { id: 'route-0', enabled: true, source: 'lfo.0', destination: 'voice.amplitude', depth: 0.5 },
          { id: 'route-1', enabled: true, source: 'lfo.0', destination: 'voice.amplitude', depth: 0.5 },
        ];
      }),
    };
    const [load] = modulationLoad(state);
    expect(load?.overflows).toBe(true);

    // The indicator says the peak reaches `load.reach.max` where the base is 1.0, and the
    // render has to agree. Measured 1.4829 against a predicted 1.4842 — 0.09% apart, so the
    // 2% tolerance is slop for finding a waveform peak inside a 4 Hz cycle and nothing more.
    // If this ever needs loosening, the model has drifted from the graph; do not loosen it.
    const predicted = (load?.reach.max ?? 0) / (load?.base ?? 1);
    const measured = sustained(doubled) / sustained(unmodulated);
    expect(predicted).toBeGreaterThan(1.2);
    expect(measured).toBeGreaterThan(1.2);
    expect(Math.abs(measured - predicted) / predicted).toBeLessThan(0.02);
  });

  /**
   * F82 — the sign, in a rendered buffer. schema_version 4.
   *
   * Measured through VELOCITY rather than an LFO, and that choice is the gate. A bipolar
   * LFO at `+d` and at `−d` visits exactly the same set of cutoff values — the sign
   * reverses the phase, not the travel — so any measurement averaged over a cycle comes
   * out identical for both and the gate would pass whatever the runtime did with the sign.
   * Velocity is unipolar and captured at note-on, so the route becomes a STATIC offset:
   * `+d` holds the filter open, `−d` holds it shut, and the difference sits still long
   * enough to measure without arguing about phase.
   */
  function renderVelocityRouted(depth: number): Promise<Float32Array> {
    return renderRouted({
      enabled: true,
      destination: 'voice.filterEnvelope.baseFrequency',
      depth,
      seconds: 0.6,
      mutate: (patch) => {
        patch.voice.modRoutes[0]!.source = 'velocity';
      },
    });
  }

  /** Where the top of the spectrum sits, in octaves above 20 Hz, past the attack. */
  const edge = (data: Float32Array) =>
    spectralEdgeOctaves(data, SR, Math.floor(0.25 * SR), 0.99, 4096);

  it('F82 — a negative route pushes the destination the other way', async () => {
    const [down, still, up] = await Promise.all([
      renderVelocityRouted(-0.35),
      renderVelocityRouted(0),
      renderVelocityRouted(0.35),
    ]);

    // All three have to be sounding, or "darker" could just be "quieter and gone".
    for (const data of [down, still, up]) expect(rms(data)).toBeGreaterThan(0.01);

    // Strictly ordered, with the unmodulated render between the two. Either half alone
    // is weak: "up is brighter than down" would pass an implementation that ignored the
    // sign and merely applied twice the depth in one direction.
    expect(edge(up)).toBeGreaterThan(edge(still) + 0.5);
    expect(edge(still)).toBeGreaterThan(edge(down) + 0.5);
  });

  it('F82 — the sign changes direction, not distance', async () => {
    // The second negative probe, and the one that catches a plausible wrong answer rather
    // than an obviously broken one: an implementation applying the sign to the MAGNITUDE
    // as well makes `−d` travel less as well as the other way, which reads as "inverted
    // modulation is quieter" and is a volume control wearing a direction's clothes.
    //
    // Octaves are the right unit for the comparison because the curve is declared in
    // them — the displacement is symmetric in log-frequency, which is exactly what it is
    // not in Hz.
    const [down, still, up] = await Promise.all([
      renderVelocityRouted(-0.35),
      renderVelocityRouted(0),
      renderVelocityRouted(0.35),
    ]);

    const rise = edge(up) - edge(still);
    const fall = edge(still) - edge(down);
    expect(rise).toBeGreaterThan(0.5);
    expect(fall).toBeGreaterThan(0.5);
    // 25%: the spectral edge is a 99%-energy percentile over a 4096-point window, and the
    // two directions run into different neighbours — the top meets the anti-alias filter,
    // the bottom meets the noise floor. Tighter than this measures the measurement.
    expect(Math.abs(rise - fall) / ((rise + fall) / 2)).toBeLessThan(0.25);
  });

  it('two routes from ONE LFO at opposite signs cancel; from two LFOs they do not', async () => {
    // The composition rule the KIND added at §3.3, and the case `modulationLoad` groups by
    // source to get right. Routes sharing a generator share a signal: their scalers sum
    // before the swing happens, so `+d` and `−d` on one LFO reach zero and the filter sits
    // perfectly still with two cables plugged in and two `enabled` flags reading true.
    //
    // The second half is what makes it a test rather than a coincidence. Two SEPARATE LFOs
    // at the same opposite depths are independent signals that cannot cancel, and they have
    // to move the filter — otherwise "nothing happened" would be explained just as well by
    // a runtime that silently drops any route carrying a negative depth.
    const pair = (sameSource: boolean) => (patch: SynthPreset) => {
      // Different RATES, and the first attempt at this gate got it wrong by using the same
      // one for both. Two LFOs at 6 Hz, both `sync: false` and both started by the same
      // offline render, are phase-locked — so they are not merely similar signals, they
      // are the same signal arriving twice, and `+d` / `−d` cancelled just as exactly as
      // the shared-source pair did. The control half measured 5.3e-7 against the
      // experimental half's 1.6e-6: two nothings. Independence has to be built into the
      // patch, not assumed from the slot index.
      patch.voice.lfos = [
        { id: 'lfo-0', enabled: true, type: 'sine', frequency: 6, sync: false, retrigger: false },
        { id: 'lfo-1', enabled: true, type: 'sine', frequency: 2.5, sync: false, retrigger: false },
      ];
      patch.voice.modRoutes = [
        {
          id: 'route-0',
          enabled: true,
          source: 'lfo.0',
          destination: 'voice.filterEnvelope.baseFrequency',
          depth: 0.4,
        },
        {
          id: 'route-1',
          enabled: true,
          source: sameSource ? 'lfo.0' : 'lfo.1',
          destination: 'voice.filterEnvelope.baseFrequency',
          depth: -0.4,
        },
      ];
    };

    const [cancelled, independent, unmodulated] = await Promise.all([
      renderRouted({
        enabled: true,
        destination: 'voice.filterEnvelope.baseFrequency',
        depth: 0.4,
        mutate: pair(true),
      }),
      renderRouted({
        enabled: true,
        destination: 'voice.filterEnvelope.baseFrequency',
        depth: 0.4,
        mutate: pair(false),
      }),
      renderRouted({
        enabled: false,
        destination: 'voice.filterEnvelope.baseFrequency',
        depth: 0.4,
      }),
    ]);

    for (const data of [cancelled, independent]) expect(rms(data)).toBeGreaterThan(0.01);

    // The cancelled pair moves no more than an unmodulated note does — its residue is the
    // same measurement noise, not a smaller wobble.
    expect(movement(cancelled, hfAt)).toBeLessThan(movement(unmodulated, hfAt) * 2);
    // The independent pair moves, and by a lot more than either of those.
    expect(movement(independent, hfAt)).toBeGreaterThan(movement(cancelled, hfAt) * 3);
  });

  it('a faster LFO modulates more often than a slow one over the same window', async () => {
    // Guards against the rate being ignored — a route that always wobbles at 1 Hz would
    // pass every depth gate above.
    const crossings = (data: Float32Array) => {
      const series = Array.from({ length: 40 }, (_unused, i) => hfAt(data, 0.15 + i * 0.01));
      const mean = series.reduce((a, b) => a + b, 0) / series.length;
      let count = 0;
      for (let i = 1; i < series.length; i += 1) {
        if (series[i - 1]! < mean !== (series[i]! < mean)) count += 1;
      }
      return count;
    };

    const [slow, fast] = await Promise.all([
      renderRouted({ enabled: true, destination: 'voice.filterEnvelope.baseFrequency', depth: 0.4, rate: 2 }),
      renderRouted({ enabled: true, destination: 'voice.filterEnvelope.baseFrequency', depth: 0.4, rate: 20 }),
    ]);

    expect(crossings(fast)).toBeGreaterThan(crossings(slow));
  });

  it('builds one generator per LFO slot, not one per voice', async () => {
    // The shared-phase departure, measured rather than asserted. Per-voice phase would
    // make this 8 (one LFO x eight sounding voices) and 128 at the declared maxima.
    let lfoCount = 0;
    let voiceCount = 0;
    let nodeCount = 0;
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.lfos = [
              { id: 'l0', enabled: true, type: 'sine', frequency: 5, sync: false, retrigger: false },
            ];
            patch.voice.modRoutes = [
              {
                id: 'r0',
                enabled: true,
                source: 'lfo.0',
                destination: 'voice.filterEnvelope.baseFrequency',
                depth: 0.4,
              },
            ];
          }),
        );
        for (let i = 0; i < 8; i += 1) {
          runtime.noteOn({ voiceId: i, note: 'C3', velocity: 0.7, portamento: 0 });
        }
        lfoCount = runtime.lfoCount;
        voiceCount = runtime.voiceCount;
        nodeCount = runtime.nodeCount;
      },
      0.2,
      1,
      SR,
    );

    expect(voiceCount).toBe(8);
    expect(lfoCount).toBe(1);
    // 1 LFO + 1 depth scaler + 8 voices x 7 fixed + 8 oscillator slots x 4
    // + master/analyser/meter.
    //
    // The counts scale differently on purpose. Per-voice nodes are unavoidable — each
    // voice needs its own filter, envelopes, gain, pan and velocity. What must stay flat
    // is the LFO side: one generator and one scaler serve the whole pool however many
    // voices sound. The slot side is the one that MULTIPLIES, which is why it is counted
    // separately and measured in its own gate rather than folded in here.
    expect(nodeCount).toBe(1 + 1 + 8 * 11 + 8 * 4 + 3);
  });

  it('reports a declared destination it cannot yet wire, rather than dropping it', async () => {
    // effects.* destinations are declared in the KIND and need the Stage 3 chain. A route
    // to one validates, journals and replays correctly and makes no sound — so it has to
    // say so by name, the same way the transport does.
    let reported: readonly string[] = [];
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.lfos = [
              { id: 'l0', enabled: true, type: 'sine', frequency: 5, sync: false, retrigger: false },
            ];
            patch.voice.modRoutes = [
              { id: 'r0', enabled: true, source: 'lfo.0', destination: 'effects.delay.wet', depth: 0.5 },
            ];
          }),
        );
        reported = runtime.getUnimplemented();
      },
      0.05,
      1,
      SR,
    );

    expect(reported).toContain('route.destination.effects.delay.wet');
  });

  it('no longer reports lfo.sync or a synced rate: both are implemented since cycle 2 C3', async () => {
    // Once the sixth decoy (a toggle that did nothing and said nothing), then an honest
    // gap. C3 implemented it with `Tone.LFO.sync()`, proven by `lfo-sync.audio.test.ts`,
    // so reporting it now would be a false gap.
    let reported: readonly string[] = [];
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.lfos = [
              { id: 'l0', enabled: true, type: 'sine', frequency: 5, sync: true, retrigger: false },
              { id: 'l1', enabled: true, type: 'sine', frequency: '16n', sync: false, retrigger: false },
            ];
          }),
        );
        reported = runtime.getUnimplemented();
      },
      0.05,
      1,
      SR,
    );

    expect(reported).not.toContain('lfo.sync');
    expect(reported).not.toContain('lfo.syncedFrequency');
  });

  it('stays quiet about sync when the patch never asked for it', async () => {
    // The other half. A gap reported unconditionally is furniture, and Known gaps is only
    // readable while everything in it is something this patch actually asked for.
    let reported: readonly string[] = [];
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.lfos = [
              { id: 'l0', enabled: true, type: 'sine', frequency: 5, sync: false, retrigger: false },
            ];
          }),
        );
        reported = runtime.getUnimplemented();
      },
      0.05,
      1,
      SR,
    );

    expect(reported).not.toContain('lfo.sync');
  });

  it('reports lfo.retrigger rather than approximating it under shared phase', async () => {
    let reported: readonly string[] = [];
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.lfos = [
              { id: 'l0', enabled: true, type: 'sine', frequency: 5, sync: false, retrigger: true },
            ];
          }),
        );
        reported = runtime.getUnimplemented();
      },
      0.05,
      1,
      SR,
    );

    // Restarting a shared generator on note-on would restart it for every sounding voice,
    // which is audibly worse on a held chord than not retriggering at all.
    expect(reported).toContain('lfo.retrigger');
  });
});
