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
import { ToneRuntime } from '../runtime';
import { rms, peak, estimatePitch } from '../test-harness/audio-assertions';
import { defaultPreset, defaultSong } from '../core/state';
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
