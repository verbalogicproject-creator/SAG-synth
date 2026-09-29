/**
 * src/tests/transport.audio.test.ts — the transport, the kick and the duck, rendered.
 *
 * Receipts here say "scheduled and rendered offline", never "audible". Whether it sounds
 * like psytrance is Eyal's ear on the phone; what this file owns is that the notes land on
 * the sample the song asks for, that a sustain-0 bass is silent before the next 16th, that
 * the duck dips by the depth it was given and recovers in time, and that the kick is a
 * falling sine landing on its tune.
 *
 * Two things every timing gate here accounts for, both measured in this file rather than
 * assumed: the output stage's own 6 ms delay (`LATENCY`), and the offline context's default
 * lookAhead of 0, which `play` replaces with the online shape. LP1's *window* is not a thing
 * a render can measure; see `seq-voices.test.ts`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import * as Tone from 'tone';
import { estimatePitch, onsets, rms } from '../test-harness/audio-assertions';
import { renderTimeline } from '../test-harness/offline-render';
import { defaultPreset, defaultSong, defaultTrack, psyRollPreset } from '../core/state';
import { psyPattern } from '../core/patterns/psy';
import type { NoteEvent, Song, SongTrack, SynthPreset } from '../core/types';
import { ToneRuntime } from '../runtime/tone-runtime';
import { withSound } from '../test-harness/song-sound';

const SR = 44100;
const KICK = { tune: 'G1', punch: 3, pitchDecay: 0.03, decay: 0.22, level: 0 };

/** A plain sine through an open filter, so onsets and levels read cleanly. */
function sinePatch(envelope: SynthPreset['voice']['envelope']): SynthPreset {
  const base = defaultPreset();
  const slot = base.voice.oscillators[0]!;
  return {
    ...base,
    voice: {
      ...base.voice,
      amplitude: 1,
      pan: 0,
      oscillators: [{ ...slot, type: 'sine', count: 1, detune: 0, spread: 0, level: 1, pan: 0 }],
      envelope,
      velocity: { toAmplitude: 0, toFilterOctaves: 0 },
      filterEnvelope: {
        ...base.voice.filterEnvelope,
        attack: 0.001,
        decay: 0.001,
        sustain: 1,
        baseFrequency: 15000,
        octaves: 0,
      },
    },
  };
}

function track(id: string, notes: NoteEvent[], extra: Partial<SongTrack> = {}): SongTrack {
  return { ...defaultTrack(), id, name: id, notes, ...extra };
}

function song(tracks: SongTrack[], extra: Partial<Song> = {}): Song {
  return { ...defaultSong(), tracks, swing: 0, loop: { enabled: false, start: 0, end: 4 }, ...extra };
}

/**
 * The output stage's own delay, measured rather than assumed: the master `Tone.Limiter` is a
 * `DynamicsCompressorNode`, which in Chromium carries a fixed look-ahead pre-delay — 265
 * samples (6.0 ms) at 44.1 kHz when this was written. Every sound SAG makes, a live key
 * included, leaves that late; timing gates compare against it instead of pretending it is
 * zero.
 */
let LATENCY = 0;

beforeAll(async () => {
  const { data } = await renderTimeline(
    () => {
      const runtime = new ToneRuntime();
      runtime.applyPatch(sinePatch({ attack: 0.001, hold: 0, decay: 0.05, decayCurve: 'exponential', sustain: 0.8, release: 0.01 }));
      runtime.noteOn({ voiceId: 0, note: 'A4', velocity: 1, portamento: 0 });
    },
    { seconds: 0.05, sampleRate: SR },
  );
  const first = data.findIndex((x) => Math.abs(x) > 1e-4);
  expect(first, 'the latency probe never sounded').toBeGreaterThanOrEqual(0);
  LATENCY = first / SR;
  expect(LATENCY).toBeLessThan(0.02);
});

async function play(patch: SynthPreset, s: Song, seconds: number) {
  let runtime: ToneRuntime | undefined;
  const rendered = await renderTimeline(
    () => {
      // Online, Tone schedules 0.1 s ahead. Offline it defaults to 0, so a Transport
      // callback only runs once the simulated clock has PASSED its time and Tone clamps the
      // starts it schedules to "now" — up to one 128-sample block late, an artefact no
      // player hears. A lookahead restores the online shape of the problem.
      Tone.getContext().lookAhead = 0.05;
      runtime = new ToneRuntime();
      runtime.applyPatch(patch);
      // C5b: a channel plays its OWN snapshot, so the song has to carry the sound under
      // test rather than inheriting the live patch the way it did before channels existed.
      runtime.applySong(withSound(s, patch));
      runtime.transport.play();
    },
    { seconds, sampleRate: SR },
  );
  return { ...rendered, runtime: runtime! };
}

describe('transport — notes land where the song says', () => {
  it('renders sequenced notes offline at their beat times (120 BPM: a beat is 0.5 s)', async () => {
    const env = { attack: 0.001, hold: 0, decay: 0.05, decayCurve: 'exponential' as const, sustain: 0.8, release: 0.01 };
    const notes = [0.5, 1, 1.75].map((time, i) => ({ noteId: `n${i}`, time, duration: 0.2, note: 'A4', velocity: 1 }));
    const { data, runtime } = await play(sinePatch(env), song([track('t', notes)], { bpm: 120 }), 1.2);

    const found = onsets(data, SR, 0.05, 2);
    expect(found, 'the transport rendered nothing offline').toHaveLength(3);
    const expected = [0.25, 0.5, 0.875];
    // `onsets` reads 2 ms windows, so it reports up to one window late.
    found.forEach((t, i) => expect(Math.abs(t - LATENCY - expected[i]!)).toBeLessThan(0.0025));
    expect(runtime.getUnimplemented()).toEqual([]);
  });

  it('loops: a one-beat loop replays its note every beat', async () => {
    const env = { attack: 0.001, hold: 0, decay: 0.05, decayCurve: 'exponential' as const, sustain: 0.8, release: 0.01 };
    const s = song([track('t', [{ noteId: 'a', time: 0.25, duration: 0.2, note: 'A4', velocity: 1 }])], {
      bpm: 120,
      loop: { enabled: true, start: 0, end: 1 },
    });
    const { data } = await play(sinePatch(env), s, 1.6);
    const found = onsets(data, SR, 0.05, 2);
    // Beats 0.25, 1.25, 2.25 → 0.125 s, 0.625 s, 1.125 s.
    expect(found).toHaveLength(3);
    [0.125, 0.625, 1.125].forEach((t, i) => expect(Math.abs(found[i]! - LATENCY - t)).toBeLessThan(0.0025));
  });

  it('a sustain-0 bass at 145 BPM is silent before the next 16th starts', async () => {
    // The Psy Roll amp contour: gone in ~72 ms, so the 103 ms 16th has a real gap.
    const env = { attack: 0.002, hold: 0, decay: 0.07, decayCurve: 'exponential' as const, sustain: 0, release: 0.03 };
    const { bass } = psyPattern({ idPrefix: 'p', root: 'A2' });
    const { data, at } = await play(sinePatch(env), song([track('bass', bass)], { bpm: 145 }), 1.0);

    const sixteenth = 60 / 145 / 4;
    // Notes on 16ths 1, 2, 3 of the beat; the silence we need is just before 16ths 2 and 3.
    for (const step of [1, 2]) {
      const onset = step * sixteenth + LATENCY;
      const next = onset + sixteenth;
      expect(rms(data, at(onset + 0.005), at(onset + 0.02)), `16th ${step} never sounded`).toBeGreaterThan(0.05);
      expect(rms(data, at(next - 0.008), at(next - 0.001)), `16th ${step} still ringing into the next`).toBeLessThan(
        0.005,
      );
    }
  });
});

describe('transport — the note-triggered duck', () => {
  it('dips the pitched track by depthDb at each kick and is back by attack + release', async () => {
    // A steady tone, and a kick track that is MUTED: the duck follows its source's notes
    // regardless (pre-fader sidechain), and a silent kick keeps the measurement clean.
    const env = { attack: 0.001, hold: 0, decay: 0.01, decayCurve: 'exponential' as const, sustain: 1, release: 0.01 };
    const tone = track('tone', [{ noteId: 'hold', time: 0, duration: 8, note: 'A6', velocity: 1 }], {
      duck: { sourceTrackId: 'kick', depthDb: 3, attackMs: 1, releaseMs: 60 },
    });
    const kick = track('kick', [{ noteId: 'k', time: 1, duration: 0.25, note: 'C3', velocity: 1 }], {
      isDrum: true,
      muted: true,
      kick: KICK,
    });
    const { data, at } = await play(sinePatch(env), song([tone, kick], { bpm: 120 }), 1.0);

    const hit = 0.5 + LATENCY; // beat 1 at 120 BPM, as it leaves the output stage
    const level = (t: number) => rms(data, at(t), at(t + 0.002));
    const base = level(hit - 0.05);
    expect(base, 'the probe tone never sounded').toBeGreaterThan(0.1);
    const dipDb = 20 * Math.log10(level(hit + 0.0015) / base);
    expect(dipDb).toBeGreaterThan(-3.5);
    expect(dipDb).toBeLessThan(-2.5);
    expect(Math.abs(20 * Math.log10(level(hit + 0.065) / base))).toBeLessThan(0.25);
  });

  it('does nothing without a duck', async () => {
    const env = { attack: 0.001, hold: 0, decay: 0.01, decayCurve: 'exponential' as const, sustain: 1, release: 0.01 };
    const tone = track('tone', [{ noteId: 'hold', time: 0, duration: 8, note: 'A6', velocity: 1 }]);
    const kick = track('kick', [{ noteId: 'k', time: 1, duration: 0.25, note: 'C3', velocity: 1 }], {
      isDrum: true,
      muted: true,
      kick: KICK,
    });
    const { data, at } = await play(sinePatch(env), song([tone, kick], { bpm: 120 }), 1.0);
    const level = (t: number) => rms(data, at(t), at(t + 0.002));
    expect(Math.abs(20 * Math.log10(level(0.5015 + LATENCY) / level(0.45)))).toBeLessThan(0.1);
  });
});

describe('transport — the kick voice', () => {
  it('is a falling sine that lands on its tune and dies away', async () => {
    const kick = track('kick', [{ noteId: 'k', time: 0, duration: 0.25, note: 'C3', velocity: 1 }], {
      isDrum: true,
      kick: { ...KICK, tune: 'G1', decay: 0.3 },
    });
    const { data, at } = await play(sinePatch({ attack: 0.001, hold: 0, decay: 0.01, decayCurve: 'exponential', sustain: 1, release: 0.01 }), song([kick]), 0.6);

    expect(rms(data, at(LATENCY), at(LATENCY + 0.05)), 'the kick never sounded').toBeGreaterThan(0.05);
    // Early: well above G1 (the sweep). Settled: G1, ~49 Hz.
    const early = estimatePitch(data, SR, LATENCY, 12);
    const settled = estimatePitch(data, SR, LATENCY + 0.08, 80);
    expect(early).toBeGreaterThan(75);
    expect(settled).toBeGreaterThan(45);
    expect(settled).toBeLessThan(54);
    expect(rms(data, at(0.45), at(0.55))).toBeLessThan(rms(data, at(0.02), at(0.1)) * 0.1);
  });

  it('a muted kick track does not sound', async () => {
    const kick = track('kick', [{ noteId: 'k', time: 0, duration: 0.25, note: 'C3', velocity: 1 }], {
      isDrum: true,
      muted: true,
      kick: KICK,
    });
    const { data } = await play(sinePatch({ attack: 0.001, hold: 0, decay: 0.01, decayCurve: 'exponential', sustain: 1, release: 0.01 }), song([kick]), 0.3);
    expect(rms(data)).toBeLessThan(1e-4);
  });
});

describe('Psy Roll, end to end', () => {
  it('one bar of roll + kick + duck renders, stays under the ceiling, and leaves a gap before every 16th', async () => {
    const { bass, kick, length } = psyPattern({ idPrefix: 'p' });
    const s = song(
      [
        track('bass', bass, { duck: { sourceTrackId: 'kick', depthDb: 3, attackMs: 1, releaseMs: 60 } }),
        track('kick', kick, { isDrum: true, kick: KICK }),
      ],
      { bpm: 145, loop: { enabled: true, start: 0, end: length } },
    );
    const { data, at, runtime } = await play(psyRollPreset(), s, 1.8);

    expect(runtime.getUnimplemented()).toEqual([]);
    expect(rms(data, at(0.1), at(1.6)), 'silent').toBeGreaterThan(0.02);
    let top = 0;
    for (const x of data) top = Math.max(top, Math.abs(x));
    expect(top, 'past the safety clip').toBeLessThanOrEqual(1);

    // The last 16th of beat 2 (no kick there, only the roll): its tail must be quieter than
    // its body, or the notes are smearing into each other.
    const sixteenth = 60 / 145 / 4;
    const onset = 1 * 4 * sixteenth + 3 * sixteenth + LATENCY;
    const body = rms(data, at(onset + 0.005), at(onset + 0.03));
    const tail = rms(data, at(onset + sixteenth - 0.012), at(onset + sixteenth - 0.002));
    expect(tail).toBeLessThan(body * 0.25);
  });
});

describe('transport — the deadline stats see real lateness', () => {
  /**
   * A counter that always reads zero is the false green this project keeps finding. So the
   * wiring is proven BOTH ways, with the one knob that decides lateness offline: at the
   * online-shaped lookahead nothing is late, and at the offline default of 0 the pump runs
   * after its window has started (a block late, by construction), so it must count.
   */
  async function statsAt(lookAhead: number) {
    let runtime: ToneRuntime | undefined;
    await renderTimeline(
      () => {
        Tone.getContext().lookAhead = lookAhead;
        runtime = new ToneRuntime();
        runtime.applyPatch(sinePatch({ attack: 0.001, hold: 0, decay: 0.05, decayCurve: 'exponential', sustain: 0, release: 0.01 }));
        const { bass } = psyPattern({ idPrefix: 'p' });
        runtime.applySong(song([track('bass', bass)], { bpm: 145, loop: { enabled: true, start: 0, end: 4 } }));
        runtime.transport.play();
      },
      { seconds: 1.2, sampleRate: SR },
    );
    return runtime!.getTransportTiming().stats;
  }

  it('counts nothing late when the pump has its lookahead', async () => {
    const stats = await statsAt(0.05);
    expect(stats.events).toBeGreaterThan(10);
    expect(stats.lateEvents).toBe(0);
    // ≥ 0, not > 0: offline, one window of the play (observed: 1 of 24) runs with exactly 0
    // headroom — on its deadline, not past it. The claim that matters is the late count.
    expect(stats.minHeadroomMs!, JSON.stringify(stats)).toBeGreaterThanOrEqual(0);
  });

  it('counts late events when the pump runs after its window started', async () => {
    const stats = await statsAt(0);
    expect(stats.lateEvents).toBeGreaterThan(0);
    expect(stats.minHeadroomMs!).toBeLessThanOrEqual(0);
  });
});

describe('live keys do not wait for the transport’s lookahead', () => {
  it('a noteOn is scheduled at the audio clock, not a lookahead later (ONLINE context)', () => {
    // The lookahead is the SEQUENCER's buffer. Before C1 every live key was scheduled at
    // Tone.now() = currentTime + lookAhead — at the app's 0.2 s, a fifth of a second between
    // finger and sound.
    //
    // Online on purpose. An offline render cannot see this: `OfflineContext.now()` returns
    // its simulated time with no lookahead added, so `now()` and `currentTime` coincide
    // there. The first version of this gate rendered offline, passed, and still passed with
    // the bug put back. Scheduled times need no audible output, so a suspended online
    // context answers the question exactly.
    const context = Tone.getContext();
    const previous = context.lookAhead;
    context.lookAhead = 0.2;
    const runtime = new ToneRuntime();
    try {
      runtime.applyPatch(sinePatch({ attack: 0.001, hold: 0, decay: 0.05, decayCurve: 'exponential', sustain: 0.8, release: 0.01 }));
      const before = context.currentTime;
      runtime.noteOn({ voiceId: 0, note: 'A4', velocity: 1, portamento: 0 });
      const scheduled = runtime.lastScheduledTime(0)!;
      expect(scheduled).toBeDefined();
      expect(scheduled - before).toBeLessThan(0.05);
    } finally {
      runtime.dispose();
      context.lookAhead = previous;
    }
  });
});

describe('the pump is idempotent — the device bug', () => {
  /**
   * On the phone, Tone handed the pump the same window twice about once a bar: 182 page
   * errors ("Start time must be strictly greater than previous start time") in a minute, and
   * every bass note of a duplicated window attacked twice 0.1 ms apart. Offline, Tone's clock
   * never duplicates, so this gate does what Tone did online: it hands the pump the same
   * window again, itself.
   */
  it('skips and counts a window it is handed twice, and nothing throws', async () => {
    let runtime: ToneRuntime | undefined;
    let threw: unknown = null;
    await renderTimeline(
      (schedule) => {
        Tone.getContext().lookAhead = 0.05;
        runtime = new ToneRuntime();
        runtime.applyPatch(sinePatch({ attack: 0.001, hold: 0, decay: 0.05, decayCurve: 'exponential', sustain: 0, release: 0.01 }));
        const { bass, kick } = psyPattern({ idPrefix: 'p' });
        runtime.applySong(
          song([track('bass', bass), track('kick', kick, { isDrum: true, kick: KICK })], {
            bpm: 145,
            loop: { enabled: true, start: 0, end: 4 },
          }),
        );
        runtime.transport.play();
        // At 0.5 s, replay the window the pump last processed — exactly what Tone did.
        schedule(0.5, () => {
          const pump = runtime as unknown as { pump(time: number): void; lastPumpTime: number };
          try {
            pump.pump(pump.lastPumpTime);
            pump.pump(pump.lastPumpTime);
          } catch (error) {
            threw = error;
          }
        });
      },
      { seconds: 0.8, sampleRate: SR },
    );
    expect(threw).toBeNull();
    expect(runtime!.getTransportTiming().stats.duplicateWindows).toBe(2);
  });
});
