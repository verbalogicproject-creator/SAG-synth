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
  monoSynthOptions,
  unsupportedOscillatorFeatures,
} from '../runtime';
import { rms, peak, estimatePitch, hfEnergyRatio } from '../test-harness/audio-assertions';
import { defaultPreset, defaultSong } from '../core/state';
import { PARAM_PATHS } from '../core/schemas';
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
          patch.voice.envelope = { attack: 0.4, decay: 0.1, sustain: 0.9, release: 0.3 };
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
    const short = { attack: 0.01, decay: 0.05, sustain: 0.8, release: 0.05 };

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
          patch.voice.envelope = { attack: 0.005, decay: 0.01, sustain: 1, release: 0.1 };
          mutate(patch);
        }),
      );
      runtime.noteOn({ voiceId: 0, note: 'C2', velocity: 0.9, portamento: 0 });
    }, 0.6);
  }

  /** A static cutoff: no envelope sweep, so the filter sits exactly where it is put. */
  function staticCutoff(patch: SynthPreset, hz: number): void {
    patch.voice.filterEnvelope = {
      attack: 0.001,
      decay: 0.001,
      sustain: 1,
      release: 0.001,
      baseFrequency: hz,
      octaves: 0,
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
        attack: 0.35,
        decay: 0.01,
        sustain: 1,
        release: 0.1,
        baseFrequency: 200,
        octaves: 5,
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
    const envelope = { attack: 0.3, decay: 0.01, sustain: 1, release: 0.1 };

    const [pinned, wide] = await Promise.all([
      renderFiltered((patch) => {
        patch.voice.filterEnvelope = { ...envelope, baseFrequency: 400, octaves: 0 };
      }),
      renderFiltered((patch) => {
        patch.voice.filterEnvelope = { ...envelope, baseFrequency: 400, octaves: 5 };
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

describe('ToneRuntime — oscillator mapping (Stage 2c)', () => {
  function renderOsc(mutate: (patch: SynthPreset) => void, seconds = 0.6): Promise<Float32Array> {
    return render((runtime) => {
      runtime.applyPatch(
        patchWith((patch) => {
          // Flat amp and a pinned, wide-open filter, so what the spectrum shows is the
          // OSCILLATOR and not a contour moving underneath it.
          patch.voice.envelope = { attack: 0.005, decay: 0.01, sustain: 1, release: 0.1 };
          patch.voice.filterEnvelope = {
            attack: 0.005,
            decay: 0.01,
            sustain: 1,
            release: 0.1,
            baseFrequency: 12000,
            octaves: 0,
          };
          mutate(patch);
        }),
      );
      runtime.noteOn({ voiceId: 0, note: 'A3', velocity: 0.8, portamento: 0 });
    }, seconds);
  }

  it('maps the type string, not just the four basic shapes', () => {
    const optionsFor = (mutate: (patch: SynthPreset) => void) =>
      monoSynthOptions(patchWith(mutate)).oscillator;

    expect(optionsFor((p) => { p.voice.oscillator.type = 'sawtooth'; }).type).toBe('sawtooth');
    // count > 1 selects the fat variant; count 1 must NOT, or every patch pays for an
    // extra oscillator producing an identical sound.
    expect(
      optionsFor((p) => { p.voice.oscillator.type = 'sawtooth'; p.voice.oscillator.count = 3; }).type,
    ).toBe('fatsawtooth');
    expect(optionsFor((p) => { p.voice.oscillator.type = 'pulse'; }).type).toBe('pulse');
    expect(optionsFor((p) => { p.voice.oscillator.type = 'pwm'; }).type).toBe('pwm');
  });

  it('applies base detune, which used to be modulatable but unset', async () => {
    // The decoy this stage closes: voice.oscillator.detune was a wired modulation
    // destination whose base value never reached the graph, so routing to it moved the
    // pitch and setting it did nothing.
    const data = await renderOsc((patch) => {
      patch.voice.oscillator.detune = 1200; // one octave up
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
        patch.voice.oscillator.count = 1;
        patch.voice.oscillator.spread = 40;
      }),
      renderOsc((patch) => {
        patch.voice.oscillator.count = 5;
        patch.voice.oscillator.spread = 40;
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
        patch.voice.oscillator.type = 'pulse';
        patch.voice.oscillator.width = 0; // square — even harmonics cancel
      }),
      renderOsc((patch) => {
        patch.voice.oscillator.type = 'pulse';
        patch.voice.oscillator.width = 0.8; // narrow pulse — much brighter
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
        patch.voice.oscillator.type = 'pulse';
        patch.voice.oscillator.width = 0;
      }),
      renderOsc((patch) => {
        patch.voice.oscillator.type = 'square';
      }),
    ]);

    const hf = (data: Float32Array) => hfEnergyRatio(data, SR, 3000, Math.floor(0.3 * SR));
    // A pulse at width 0 IS a square wave, so the two should sit close together.
    expect(Math.abs(hf(atZero) - hf(square))).toBeLessThan(Math.max(hf(square), 0.01));
  });

  it('names every combination the oscillator type cannot honour', () => {
    const gaps = (mutate: (patch: SynthPreset) => void) =>
      unsupportedOscillatorFeatures(patchWith(mutate).voice.oscillator);

    // noise is not an OmniOscillator type in any form; it sounds as a sawtooth.
    expect(gaps((p) => { p.voice.oscillator.type = 'noise'; })).toContain('oscillator.noise');
    // there is no fatpulse — unison and the pulse family are mutually exclusive in Tone.
    expect(
      gaps((p) => { p.voice.oscillator.type = 'pulse'; p.voice.oscillator.count = 3; }),
    ).toContain('oscillator.unison.pulse');
    // width belongs to PulseOscillator alone; pwm has no width at all.
    expect(
      gaps((p) => { p.voice.oscillator.type = 'pwm'; p.voice.oscillator.width = 0.5; }),
    ).toContain('oscillator.width.pwm');
    // ...and a legal patch reports nothing, or the check would pass by always complaining.
    expect(gaps((p) => { p.voice.oscillator.type = 'sawtooth'; p.voice.oscillator.count = 3; })).toEqual([]);
    expect(gaps((p) => { p.voice.oscillator.type = 'pulse'; p.voice.oscillator.width = 0.4; })).toEqual([]);
  });

  it('reports those gaps through the runtime, not just the pure function', async () => {
    let reported: readonly string[] = [];
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.oscillator.type = 'noise';
          }),
        );
        reported = runtime.getUnimplemented();
      },
      0.05,
      1,
      SR,
    );
    expect(reported).toContain('oscillator.noise');
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
    const mapped = monoSynthOptions(defaultPreset());
    expect(mapped.oscillator.type).toBeDefined();
    for (const path of [
      'voice.oscillator.type',
      'voice.envelope.attack',
      'voice.filter.type',
      'voice.filterEnvelope.baseFrequency',
    ]) {
      expect(UNMAPPED_PARAMS, `"${path}" is mapped but listed unmapped`).not.toContain(path);
    }
  });

  it('no longer lists the oscillator group, because Stage 2c mapped it', () => {
    // voice.oscillator.detune is the case that motivated the whole list: a live
    // modulation destination whose base value was dropped, so routing to it worked and
    // setting it did nothing. Now read, so it must be off the list AND actually applied —
    // the second half matters, since removing an entry is the easy way to fake progress.
    for (const path of [
      'voice.oscillator.detune',
      'voice.oscillator.count',
      'voice.oscillator.spread',
      'voice.oscillator.width',
    ]) {
      expect(UNMAPPED_PARAMS, `"${path}" is mapped now`).not.toContain(path);
    }
    const patch = defaultPreset();
    patch.voice.oscillator.detune = 550;
    expect(monoSynthOptions(patch).detune).toBe(550);
  });
});

describe('ToneRuntime — v0.1.0 honesty', () => {
  it('records the transport calls it cannot service instead of pretending', async () => {
    let reported: readonly string[] = [];
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        runtime.applySong(defaultSong());
        runtime.transport.play();
        runtime.transport.seek(4);
        reported = runtime.getUnimplemented();
      },
      0.05,
      1,
      SR,
    );

    // Silently no-opping would let a caller believe the sequencer works; throwing would
    // take the engine down mid-dispatch. Recording does neither.
    expect([...reported].sort()).toEqual(['applySong', 'transport.play', 'transport.seek']);
  });
});

// ---------------------------------------------------------------------------
// Modulation routing — KIND-synth_mod_route F73 / F74
// ---------------------------------------------------------------------------

describe('ToneRuntime — modulation routing', () => {
  const FLAT_AMP = { attack: 0.005, decay: 0.01, sustain: 1, release: 0.1 };

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
    mutate?: (patch: SynthPreset) => void;
  }): Promise<Float32Array> {
    return render(
      (runtime) => {
        runtime.applyPatch(
          patchWith((patch) => {
            patch.voice.envelope = { ...FLAT_AMP };
            // A pinned filter, so the only thing moving the cutoff is the route.
            patch.voice.filterEnvelope = {
              attack: 0.005,
              decay: 0.01,
              sustain: 1,
              release: 0.1,
              baseFrequency: 800,
              octaves: 0,
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
    // 1 LFO + 1 depth scaler + 8 voices x (synth + gain + panner) + master/analyser/meter.
    // The scaler count tracks ROUTES, not voices — one connection scaler fans out to the
    // whole pool, so this stays flat as polyphony rises just as the generator count does.
    expect(nodeCount).toBe(1 + 1 + 8 * 3 + 3);
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
