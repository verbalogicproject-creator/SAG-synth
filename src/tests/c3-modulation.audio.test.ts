/**
 * src/tests/c3-modulation.audio.test.ts — cycle 2 C3, rendered.
 *
 * Eyal's asks: "assignable envelopes", a filter DRIVE, and a filter modulation rate that
 * can be 1/16, 1/8 or 1/4. Three mechanisms, each proven against a buffer:
 *
 * - `env.amp` / `env.filter` as route sources: per-voice, unipolar, following the contour.
 * - `voice.filter.drive`: saturation before the filter; 0 is a bypass.
 * - an LFO locked to the transport: its rate follows the TEMPO, and it moves only while the
 *   transport plays.
 */

import { describe, expect, it } from 'vitest';
import * as Tone from 'tone';
import { hfEnergyRatio, rms } from '../test-harness/audio-assertions';
import { renderTimeline } from '../test-harness/offline-render';
import { defaultPreset, defaultSong, defaultTrack } from '../core/state';
import type { EnvelopeConfig, LFOConfig, ModRoute, Song, SynthPreset } from '../core/types';
import { ToneRuntime } from '../runtime/tone-runtime';
import { withSound } from '../test-harness/song-sound';

const SR = 44100;

/** A sine through a wide-open filter, centred, so pan and harmonics read cleanly. */
function sinePatch(mutate: (patch: SynthPreset) => void = () => {}): SynthPreset {
  const base = defaultPreset();
  const slot = base.voice.oscillators[0]!;
  const patch: SynthPreset = {
    ...base,
    voice: {
      ...base.voice,
      amplitude: 1,
      pan: 0,
      oscillators: [{ ...slot, type: 'sine', count: 1, detune: 0, spread: 0, level: 1, pan: 0 }],
      envelope: { attack: 0.001, hold: 0, decay: 0.01, decayCurve: 'exponential', sustain: 1, release: 0.05 },
      velocity: { toAmplitude: 0, toFilterOctaves: 0 },
      filter: { ...base.voice.filter, type: 'lowpass', Q: 0.7, rolloff: -12, drive: 0 },
      filterEnvelope: {
        ...base.voice.filterEnvelope,
        attack: 0.001,
        hold: 0,
        decay: 0.001,
        sustain: 1,
        baseFrequency: 18000,
        octaves: 0,
        linked: false,
      },
      lfos: [],
      modRoutes: [],
    },
    effects: structuredClone(base.effects),
  };
  for (const effect of ['distortion', 'chorus', 'delay', 'reverb'] as const) patch.effects[effect].enabled = false;
  mutate(patch);
  return patch;
}

const route = (extra: Partial<ModRoute>): ModRoute => ({
  id: 'r0',
  enabled: true,
  source: 'lfo.0',
  destination: 'voice.pan',
  depth: 0.5,
  ...extra,
});

/** Render in stereo; `drive` builds the runtime inside the offline context. */
async function renderStereo(
  seconds: number,
  drive: (runtime: ToneRuntime, at: (s: number, fn: () => void) => void) => void,
) {
  const rendered = await renderTimeline(
    (at) => {
      Tone.getContext().lookAhead = 0.05;
      drive(new ToneRuntime(), at);
    },
    { seconds, sampleRate: SR, channels: 2 },
  );
  const [left, right] = rendered.channels as [Float32Array, Float32Array];
  return { left, right, at: rendered.at };
}

/** Right over left, in dB, over a stretch — positive is panned right. */
function balanceDb(left: Float32Array, right: Float32Array, from: number, to: number): number {
  const l = rms(left, from, to);
  const r = rms(right, from, to);
  return 20 * Math.log10((r + 1e-9) / (l + 1e-9));
}

describe('env.filter and env.amp as route sources — per voice, unipolar, following the contour', () => {
  /** Filter contour: peak for 100 ms, gone by 200 ms. Octaves 0, so it moves no cutoff. */
  const PLUCK: EnvelopeConfig = { attack: 0, hold: 0.1, decay: 0.1, decayCurve: 'linear', sustain: 0, release: 0.05 };

  async function panRender(routes: ModRoute[], amp?: EnvelopeConfig) {
    return renderStereo(0.6, (runtime) => {
      runtime.applyPatch(
        sinePatch((p) => {
          p.voice.filterEnvelope = { ...p.voice.filterEnvelope, ...PLUCK };
          if (amp !== undefined) p.voice.envelope = amp;
          p.voice.modRoutes = routes;
        }),
      );
      runtime.noteOn({ voiceId: 0, note: 'A3', velocity: 1, portamento: 0 });
    });
  }

  it('env.filter → pan: hard right while the contour is at its peak, centred once it has fallen', async () => {
    const [routed, plain] = await Promise.all([
      panRender([route({ source: 'env.filter', depth: 0.5 })]),
      panRender([]),
    ]);
    const early = [routed.at(0.03), routed.at(0.09)] as const;
    const late = [routed.at(0.35), routed.at(0.55)] as const;

    expect(rms(routed.right, ...early), 'the probe never sounded').toBeGreaterThan(0.05);
    expect(balanceDb(routed.left, routed.right, ...early), 'at the peak').toBeGreaterThan(20);
    expect(Math.abs(balanceDb(routed.left, routed.right, ...late)), 'after the decay').toBeLessThan(1);
    // Anti-vacuity: without the route the same note sits centred throughout.
    expect(Math.abs(balanceDb(plain.left, plain.right, ...early))).toBeLessThan(1);
  });

  it('is unipolar: a negative depth pans the other way and never past centre the wrong way', async () => {
    const routed = await panRender([route({ source: 'env.filter', depth: -0.5 })]);
    expect(balanceDb(routed.left, routed.right, routed.at(0.03), routed.at(0.09))).toBeLessThan(-20);
    expect(Math.abs(balanceDb(routed.left, routed.right, routed.at(0.35), routed.at(0.55)))).toBeLessThan(1);
  });

  it('env.amp → pan follows the AMP contour, down to its sustain', async () => {
    // Amp peak 1, sustain 0.5: pan +1 at the peak, +0.5 at the sustain — still right, less so.
    const amp: EnvelopeConfig = { attack: 0, hold: 0.1, decay: 0.05, decayCurve: 'linear', sustain: 0.5, release: 0.05 };
    const routed = await panRender([route({ source: 'env.amp', depth: 0.5 })], amp);
    const peak = balanceDb(routed.left, routed.right, routed.at(0.03), routed.at(0.09));
    const sustain = balanceDb(routed.left, routed.right, routed.at(0.3), routed.at(0.5));
    expect(peak).toBeGreaterThan(20);
    expect(sustain).toBeGreaterThan(3);
    expect(sustain).toBeLessThan(peak - 10);
  });

  it('each voice follows its own contour — a new note does not reset one already decayed', async () => {
    // Voice 0 at t=0 decays by 0.2 s; voice 1 starts at 0.3 s. If the source were shared,
    // voice 1's attack would re-pan voice 0 too. Voice 0 is A3 and voice 1 is A5, so the two
    // are separable by frequency: the LOW band must stay centred while the high one pans.
    const routed = await renderStereo(0.6, (runtime, at) => {
      runtime.applyPatch(
        sinePatch((p) => {
          p.voice.filterEnvelope = { ...p.voice.filterEnvelope, ...PLUCK };
          p.voice.modRoutes = [route({ source: 'env.filter', depth: 0.5 })];
        }),
      );
      runtime.noteOn({ voiceId: 0, note: 'A3', velocity: 1, portamento: 0 });
      at(0.3, () => runtime.noteOn({ voiceId: 1, note: 'A5', velocity: 1, portamento: 0 }));
    });
    const window = routed.at(0.34);
    // Low band (220 Hz) share of each channel: centred means equal in both.
    const lowLeft = 1 - hfEnergyRatio(routed.left, SR, 500, window, 4096);
    const lowRight = 1 - hfEnergyRatio(routed.right, SR, 500, window, 4096);
    // Voice 1 panned hard right, so the LEFT channel is almost all voice 0 (low)...
    expect(lowLeft).toBeGreaterThan(0.9);
    // ...and the right carries both, so its low share is well under the left's.
    expect(lowRight).toBeLessThan(0.7);
    expect(rms(routed.left, window, window + 4096), 'voice 0 went silent').toBeGreaterThan(0.05);
  });
});

describe('voice.filter.drive — saturation before the filter', () => {
  async function render(drive: number, live = false) {
    const { data } = await renderTimeline(
      (at) => {
        const runtime = new ToneRuntime();
        const patch = sinePatch((p) => {
          p.voice.filter.drive = live ? 0 : drive;
        });
        runtime.applyPatch(patch);
        runtime.noteOn({ voiceId: 0, note: 'A3', velocity: 1, portamento: 0 });
        if (live) {
          at(0.1, () => runtime.applyPatch({ ...patch, voice: { ...patch.voice, filter: { ...patch.voice.filter, drive } } }));
        }
      },
      { seconds: 0.5, sampleRate: SR },
    );
    return data;
  }

  it('0 adds nothing: a sine stays a sine', async () => {
    const clean = await render(0);
    expect(rms(clean, SR * 0.1, SR * 0.4), 'the probe never sounded').toBeGreaterThan(0.05);
    expect(hfEnergyRatio(clean, SR, 500, Math.round(SR * 0.2), 4096)).toBeLessThan(0.001);
  });

  it('driven, a sine grows the odd harmonics that saturation makes', async () => {
    const [clean, driven] = await Promise.all([render(0), render(0.8)]);
    const at = Math.round(SR * 0.2);
    expect(hfEnergyRatio(driven, SR, 500, at, 4096)).toBeGreaterThan(0.02);
    expect(hfEnergyRatio(driven, SR, 500, at, 4096)).toBeGreaterThan(20 * hfEnergyRatio(clean, SR, 500, at, 4096));
  });

  it('reaches a voice that is already sounding', async () => {
    const live = await render(0.8, true);
    expect(hfEnergyRatio(live, SR, 500, Math.round(SR * 0.01), 2048)).toBeLessThan(0.001);
    expect(hfEnergyRatio(live, SR, 500, Math.round(SR * 0.25), 4096)).toBeGreaterThan(0.02);
  });

  it('holds the level roughly steady: drive is character, not a volume knob', async () => {
    const [clean, driven] = await Promise.all([render(0), render(0.8)]);
    const ratio = rms(driven, SR * 0.1, SR * 0.4) / rms(clean, SR * 0.1, SR * 0.4);
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.5);
  });
});

describe('an LFO locked to the transport', () => {
  const LOCKED: LFOConfig = { id: 'l0', enabled: true, type: 'sine', frequency: '16n', sync: false, retrigger: false };

  /** One long held note on a song, so the transport runs while the LFO pans it. */
  function holdSong(bpm: number): Song {
    const track = { ...defaultTrack(), id: 't', name: 't', notes: [{ noteId: 'n', time: 0, duration: 16, note: 'A3' as const, velocity: 1 }] };
    return { ...defaultSong(), bpm, tracks: [track], swing: 0, loop: { enabled: false, start: 0, end: 16 } };
  }

  /** Pan swings, counted as sign changes of the stereo balance in 5 ms blocks. */
  function swings(left: Float32Array, right: Float32Array, from: number, to: number): number {
    const block = Math.round(SR * 0.005);
    let changes = 0;
    let last = 0;
    for (let i = from; i + block <= to; i += block) {
      const b = balanceDb(left, right, i, i + block);
      const sign = b > 3 ? 1 : b < -3 ? -1 : 0;
      if (sign !== 0 && last !== 0 && sign !== last) changes += 1;
      if (sign !== 0) last = sign;
    }
    return changes;
  }

  async function played(bpm: number, play: boolean) {
    return renderStereo(1.2, (runtime) => {
      const patch = sinePatch((p) => {
        p.voice.lfos = [LOCKED];
        p.voice.modRoutes = [route({ source: 'lfo.0', depth: 0.5 })];
      });
      runtime.applyPatch(patch);
      // C5b: the sequenced note plays the TRACK's sound, so the LFO has to be on it.
      runtime.applySong(withSound(holdSong(bpm), patch));
      if (play) runtime.transport.play();
      else runtime.noteOn({ voiceId: 0, note: 'A3', velocity: 1, portamento: 0 });
    });
  }

  it('a 16th at 120 bpm is 8 Hz: about 16 swings a second', async () => {
    const r = await played(120, true);
    expect(rms(r.right, r.at(0.2), r.at(1.1)), 'the note never sounded').toBeGreaterThan(0.05);
    const n = swings(r.left, r.right, r.at(0.1), r.at(1.1));
    expect(n).toBeGreaterThanOrEqual(14);
    expect(n).toBeLessThanOrEqual(18);
  });

  it('follows the tempo: the same 16th at 60 bpm swings half as often', async () => {
    const r = await played(60, true);
    const n = swings(r.left, r.right, r.at(0.1), r.at(1.1));
    expect(n).toBeGreaterThanOrEqual(6);
    expect(n).toBeLessThanOrEqual(10);
  });

  it('a locked sawtooth resets ON the step, not half a step late', async () => {
    // Web Audio's saw resets halfway through its cycle; `lfoPhase` starts a locked one at
    // 180° so each 1/16 ramp begins on the note. Positive depth: left at the start of every
    // step, right at its end, the jump on the boundary.
    const r = await renderStereo(1.2, (runtime) => {
      const patch = sinePatch((p) => {
        p.voice.lfos = [{ ...LOCKED, type: 'sawtooth' }];
        p.voice.modRoutes = [route({ source: 'lfo.0', depth: 0.5 })];
      });
      runtime.applyPatch(patch);
      runtime.applySong(withSound(holdSong(120), patch));
      runtime.transport.play();
    });
    // Transport time 0 is where the held note starts sounding.
    const onset = r.right.findIndex((x, i) => Math.abs(x) + Math.abs(r.left[i]!) > 1e-3);
    expect(onset, 'the note never sounded').toBeGreaterThan(0);
    const step = Math.round(SR * 0.125);
    const slice = Math.round(SR * 0.02);
    let starts = 0;
    let ends = 0;
    for (let k = 1; k <= 6; k += 1) {
      const boundary = onset + k * step;
      if (balanceDb(r.left, r.right, boundary + 5, boundary + 5 + slice) < -3) starts += 1;
      if (balanceDb(r.left, r.right, boundary - 5 - slice, boundary - 5) > 3) ends += 1;
    }
    expect(starts, 'steps that begin panned left').toBe(6);
    expect(ends, 'steps that end panned right').toBe(6);
  });

  it('sits still while the transport is stopped — the honest limit of a locked rate', async () => {
    const r = await played(120, false);
    expect(rms(r.right, r.at(0.2), r.at(1.1)), 'the live note never sounded').toBeGreaterThan(0.05);
    expect(swings(r.left, r.right, r.at(0.1), r.at(1.1))).toBe(0);
  });
});
