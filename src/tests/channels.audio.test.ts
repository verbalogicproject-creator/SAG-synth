/**
 * src/tests/channels.audio.test.ts — C5b: a channel is a sound of its own.
 *
 * Before this, every pitched track played the one live patch: two tracks were two lanes of
 * notes on one instrument, and `getUnimplemented()` said `applySong.perTrackPreset`. These
 * gates ask the questions only a rendered buffer can answer — is it really a different
 * sound, is the fader really a fader, does the duck dip only the channel it belongs to, and
 * (the one that matters most) is a channel strip TRANSPARENT when nothing is set on it.
 *
 * Renders are stereo, because pan is half of what a channel strip does.
 */

import { describe, expect, it } from 'vitest';
import * as Tone from 'tone';
import { defaultPreset, defaultSong, defaultTrack } from '../core/state';
import type { NoteEvent, Song, SongTrack, SynthPreset } from '../core/types';
import { ToneRuntime } from '../runtime/tone-runtime';
import { renderTimeline } from '../test-harness/offline-render';
import { hfEnergyRatio, rms } from '../test-harness/audio-assertions';

const SR = 44100;
const KICK = { tune: 'G1' as const, punch: 3, pitchDecay: 0.03, decay: 0.22, level: 0 };

/** A plain sine through an open filter: level and stereo read cleanly. */
function sinePatch(edit: (patch: SynthPreset) => void = () => {}): SynthPreset {
  const base = defaultPreset();
  const slot = base.voice.oscillators[0]!;
  const patch: SynthPreset = {
    ...base,
    voice: {
      ...base.voice,
      amplitude: 1,
      pan: 0,
      polyphony: 2,
      oscillators: [{ ...slot, type: 'sine', count: 1, detune: 0, spread: 0, level: 1, pan: 0 }],
      envelope: { attack: 0.005, hold: 0, decay: 0.05, decayCurve: 'exponential', sustain: 0.9, release: 0.02 },
      velocity: { toAmplitude: 0, toFilterOctaves: 0 },
      filterEnvelope: { ...base.voice.filterEnvelope, attack: 0.001, decay: 0.001, sustain: 1, baseFrequency: 16000, octaves: 0 },
      lfos: [],
      modRoutes: [],
    },
  };
  edit(patch);
  return patch;
}

/** The same voice, but a bright saw — a spectrum nothing can confuse with the sine. */
function sawPatch(): SynthPreset {
  return sinePatch((patch) => {
    patch.voice.oscillators = [{ ...patch.voice.oscillators[0]!, type: 'sawtooth' }];
  });
}

function track(id: string, sound: SynthPreset, notes: NoteEvent[], extra: Partial<SongTrack> = {}): SongTrack {
  return {
    ...defaultTrack(),
    id,
    name: id,
    notes,
    // NOT cloned: the reducer shares structure, and the runtime's section diff is a
    // reference compare. A clone per call would dirty every section on every applySong
    // and rebuild graphs that never moved — the artifact this helper must not introduce.
    presetSnapshot: sound,
    presetId: sound.id,
    ...extra,
  };
}

function song(tracks: SongTrack[], extra: Partial<Song> = {}): Song {
  return {
    ...defaultSong(),
    bpm: 120,
    tracks,
    swing: 0,
    loop: { enabled: false, start: 0, end: 4 },
    ...extra,
  };
}

const hold = (note: NoteEvent['note']): NoteEvent[] => [{ noteId: `n-${note}`, time: 0, duration: 4, note, velocity: 1 }];

async function render(seconds: number, drive: (runtime: ToneRuntime) => void) {
  let runtime: ToneRuntime | undefined;
  const rendered = await renderTimeline(
    () => {
      Tone.getContext().lookAhead = 0.05;
      runtime = new ToneRuntime();
      drive(runtime);
    },
    { seconds, sampleRate: SR, channels: 2 },
  );
  const [left, right] = rendered.channels as [Float32Array, Float32Array];
  return { left, right, at: rendered.at, runtime: runtime! };
}

/** Right over left in dB across a stretch; positive is panned right. */
function balanceDb(left: Float32Array, right: Float32Array, from: number, to: number): number {
  return 20 * Math.log10((rms(right, from, to) + 1e-9) / (rms(left, from, to) + 1e-9));
}

describe('a channel plays its own sound', () => {
  it('two channels render two spectra, each the one its own snapshot asked for', async () => {
    const sine = sinePatch();
    const saw = sawPatch();

    // The live patch is the SINE in every render below, so anything the saw channel does
    // can only have come from its own snapshot.
    const both = await render(0.5, (runtime) => {
      runtime.applyPatch(sine);
      runtime.applySong(song([track('a', sine, hold('A3')), track('b', saw, hold('A5'))]));
      runtime.transport.play();
    });
    const soloSine = await render(0.5, (runtime) => {
      runtime.applyPatch(sine);
      runtime.applySong(song([track('a', sine, hold('A3'))]));
      runtime.transport.play();
    });
    const soloSaw = await render(0.5, (runtime) => {
      runtime.applyPatch(sine);
      runtime.applySong(song([track('b', saw, hold('A5'))]));
      runtime.transport.play();
    });

    const window = [Math.round(SR * 0.15), Math.round(SR * 0.45)] as const;
    const bright = (data: Float32Array) => hfEnergyRatio(data, SR, 3000, window[0], window[1]);

    expect(rms(soloSine.left, ...window), 'the sine channel never sounded').toBeGreaterThan(0.02);
    expect(rms(soloSaw.left, ...window), 'the saw channel never sounded').toBeGreaterThan(0.02);
    // A saw at A5 through an open filter carries far more energy above 3 kHz than a sine
    // at A3 — which has none at all beyond its own partial.
    expect(bright(soloSaw.left)).toBeGreaterThan(bright(soloSine.left) * 5);
    // Playing them together keeps both: the mixed render is brighter than the sine alone
    // and louder than either.
    expect(bright(both.left)).toBeGreaterThan(bright(soloSine.left) * 2);
    expect(rms(both.left, ...window)).toBeGreaterThan(rms(soloSine.left, ...window));
    expect(both.runtime.channelCount).toBe(2);
    expect(both.runtime.getUnimplemented()).toEqual([]);
  });

  it('a live key aimed at a channel plays THAT channel, and the strip is transparent', async () => {
    // The strongest form of the claim: the same note, played live on a channel whose sound
    // is the sine, must render the same buffer as the pre-channel path (a live key on the
    // live patch) — a channel strip at its defaults adds nothing and takes nothing.
    const sine = sinePatch();
    const saw = sawPatch();

    const throughChannel = await render(0.4, (runtime) => {
      // The LIVE patch is the saw here, so playing the live instrument would be audibly
      // different; only routing by trackId can produce the sine.
      runtime.applyPatch(saw);
      runtime.applySong(song([track('a', sine, [])]));
      runtime.noteOn({ voiceId: 0, note: 'A3', velocity: 1, portamento: 0, trackId: 'a' });
    });
    const direct = await render(0.4, (runtime) => {
      runtime.applyPatch(sine);
      runtime.applySong(song([track('a', sine, [])]));
      runtime.noteOn({ voiceId: 0, note: 'A3', velocity: 1, portamento: 0 });
    });

    const from = Math.round(SR * 0.05);
    const to = Math.round(SR * 0.35);
    expect(rms(direct.left, from, to), 'the direct note never sounded').toBeGreaterThan(0.02);

    let worst = 0;
    for (let i = from; i < to; i += 1) worst = Math.max(worst, Math.abs(throughChannel.left[i]! - direct.left[i]!));
    // Chromium's offline renders are not bit-exact run to run (about 2e-6 on a busy
    // scenario), so this is the same-code noise floor, not zero.
    expect(worst, 'the channel strip changed the sound').toBeLessThan(1e-4);
  });

  it('the pool is sized by the CHANNEL, not by the live patch', async () => {
    // Polyphony belongs to the sound a channel plays. With the live patch polyphonic and
    // the channel monophonic, a second note must steal the first — and if the sequencer
    // read the live patch's polyphony instead, both would sound.
    const live = sinePatch();
    expect(live.voice.polyphony).toBeGreaterThan(1);
    const mono = sinePatch((patch) => {
      patch.voice.polyphony = 1;
      // A long release would let the stolen note ring through the window below.
      patch.voice.envelope = { ...patch.voice.envelope, release: 0.01 };
    });
    const notes: NoteEvent[] = [
      { noteId: 'low', time: 0, duration: 4, note: 'A2', velocity: 1 },
      { noteId: 'high', time: 1, duration: 4, note: 'A5', velocity: 1 },
    ];

    const [monophonic, polyphonic] = await Promise.all([
      render(1.2, (runtime) => {
        runtime.applyPatch(live);
        runtime.applySong(song([track('a', mono, notes)], { bpm: 120 }));
        runtime.transport.play();
      }),
      render(1.2, (runtime) => {
        runtime.applyPatch(live);
        runtime.applySong(song([track('a', sinePatch(), notes)], { bpm: 120 }));
        runtime.transport.play();
      }),
    ]);

    // Beat 1 at 120 BPM is 0.5 s; measure after both notes have started.
    const window = [Math.round(SR * 0.7), Math.round(SR * 1.1)] as const;
    // A2 is 110 Hz and A5 is 880: above 3 kHz only the saw-free sine pair's own partials
    // live, so compare the LOW end instead — energy below 300 Hz is the A2 alone.
    const low = (data: Float32Array) => 1 - hfEnergyRatio(data, SR, 300, window[0], window[1]);
    expect(rms(polyphonic.left, ...window), 'nothing sounded').toBeGreaterThan(0.02);
    // Both notes held: the low note is still a big share of the energy.
    expect(low(polyphonic.left)).toBeGreaterThan(0.3);
    // Monophonic: A2 was stolen by A5, so almost nothing is left down there.
    expect(low(monophonic.left)).toBeLessThan(0.1);
  });

  it('a note aimed at a track with no channel still sounds, on the live patch', async () => {
    // Core refuses a note aimed at anything but a synth channel, so this is the race where
    // the song changed under a note already dispatched. A silent key is the worse answer.
    const sine = sinePatch();
    const rendered = await render(0.3, (runtime) => {
      runtime.applyPatch(sine);
      runtime.applySong(song([track('a', sine, [])]));
      runtime.noteOn({ voiceId: 0, note: 'A3', velocity: 1, portamento: 0, trackId: 'gone' });
    });
    expect(rms(rendered.left, Math.round(SR * 0.05), Math.round(SR * 0.25))).toBeGreaterThan(0.02);
  });
});

describe('the channel strip', () => {
  it('the fader is a fader: −12 dB is a quarter of the amplitude', async () => {
    const sine = sinePatch();
    const at = async (volume: number) =>
      render(0.4, (runtime) => {
        runtime.applyPatch(sine);
        runtime.applySong(song([track('a', sine, hold('A3'), { volume })]));
        runtime.transport.play();
      });
    const [unity, quieter] = await Promise.all([at(0), at(-12)]);
    const window = [Math.round(SR * 0.1), Math.round(SR * 0.35)] as const;
    const ratio = rms(quieter.left, ...window) / rms(unity.left, ...window);
    // 10^(−12/20) = 0.251.
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.31);
  });

  it('the pan is a pan, and it does not collapse the channel to mono', async () => {
    const sine = sinePatch();
    const panned = await render(0.4, (runtime) => {
      runtime.applyPatch(sine);
      runtime.applySong(song([track('a', sine, hold('A3'), { pan: -1 })]));
      runtime.transport.play();
    });
    const window = [Math.round(SR * 0.1), Math.round(SR * 0.35)] as const;
    expect(balanceDb(panned.left, panned.right, ...window)).toBeLessThan(-20);

    // The stereo image SURVIVES the strip: a voice panned hard right inside the channel
    // still arrives right. `Tone.Panner` defaults to channelCount 1, which would have
    // downmixed this to the middle — see the constructor in `channel-strip.ts`.
    const wide = sinePatch((patch) => {
      patch.voice.pan = 1;
    });
    const rendered = await render(0.4, (runtime) => {
      runtime.applyPatch(sine);
      runtime.applySong(song([track('a', wide, hold('A3'))]));
      runtime.transport.play();
    });
    expect(balanceDb(rendered.left, rendered.right, ...window)).toBeGreaterThan(10);
  });

  it('the duck dips the channel it belongs to, and leaves the other one alone', async () => {
    const sine = sinePatch();
    const duck = { sourceTrackId: 'kick', depthDb: 12, attackMs: 1, releaseMs: 80 };
    // The control channel is not un-ducked, it is ducked from a DIFFERENT source — the
    // weaker version of this gate (no duck at all) passes even if the runtime sprays every
    // channel with every source's hits, because a channel with no duck ignores them.
    const otherDuck = { sourceTrackId: 'offbeat', depthDb: 12, attackMs: 1, releaseMs: 80 };
    const offbeatNotes: NoteEvent[] = [{ noteId: 'o0', time: 0.5, duration: 0.25, note: 'C3', velocity: 1 }];
    // −40 dB: the duck follows its source's notes whether or not the source is audible
    // (a pre-fader sidechain), so a near-silent kick still ducks — and stops its own
    // centred body from filling the window where the dip is measured.
    const quietKick = { ...KICK, level: -40 };
    const kickNotes: NoteEvent[] = [0, 1].map((beat) => ({ noteId: `k${beat}`, time: beat, duration: 0.25, note: 'C3', velocity: 1 }));
    // Hard-panned apart so one render measures both channels independently.
    const rendered = await render(1.2, (runtime) => {
      runtime.applyPatch(sine);
      runtime.applySong(
        song([
          track('ducked', sine, hold('A3'), { pan: -1, duck }),
          track('free', sine, hold('A4'), { pan: 1, duck: otherDuck }),
          track('kick', sine, kickNotes, { isDrum: true, kick: quietKick } as Partial<SongTrack>),
          track('offbeat', sine, offbeatNotes, { isDrum: true, kick: quietKick } as Partial<SongTrack>),
        ]),
      );
      runtime.transport.play();
    });

    // Compared against the same song with the duck taken off, because the kick itself is
    // centred and lands in BOTH channels: a before/after ratio inside one render measures
    // the kick as much as the dip. Against a duck-free twin, the kick is common to both
    // renders and what remains is the duck alone.
    const plain = await render(1.2, (runtime) => {
      runtime.applyPatch(sine);
      runtime.applySong(
        song([
          track('ducked', sine, hold('A3'), { pan: -1 }),
          track('free', sine, hold('A4'), { pan: 1 }),
          track('kick', sine, kickNotes, { isDrum: true, kick: quietKick } as Partial<SongTrack>),
          track('offbeat', sine, offbeatNotes, { isDrum: true, kick: quietKick } as Partial<SongTrack>),
        ]),
      );
      runtime.transport.play();
    });

    // The second kick is at beat 1 = 0.5 s; measure the window just after it.
    const after = [Math.round(SR * 0.52), Math.round(SR * 0.56)] as const;
    expect(rms(plain.left, ...after), 'the ducked channel never sounded').toBeGreaterThan(0.01);
    const duckedRatio = rms(rendered.left, ...after) / rms(plain.left, ...after);
    const freeRatio = rms(rendered.right, ...after) / rms(plain.right, ...after);

    // 12 dB down is 0.25; the release is already pulling it back, so the bound is loose.
    expect(duckedRatio, 'the ducked channel did not dip').toBeLessThan(0.6);
    // The other channel ducks from the offbeat track, whose last hit was at 0.25 s and has
    // long recovered: at 0.52 s it must be untouched. The kick's hits are not its hits.
    expect(freeRatio, 'the duck reached a channel it does not belong to').toBeGreaterThan(0.98);
    expect(freeRatio).toBeLessThan(1.02);
  });
});

describe('channels come and go', () => {
  it('a removed track takes its instrument with it, and the others are untouched', async () => {
    const sine = sinePatch();
    const saw = sawPatch();
    let counts: Record<string, number> = {};
    await render(0.4, (runtime) => {
      runtime.applyPatch(sine);
      runtime.applySong(song([track('a', sine, hold('A3')), track('b', saw, hold('A5'))]));
      runtime.transport.play();
      const two = runtime.channelCount;
      const removed = runtime.channel('b')!;
      const rewires = runtime.channel('a')!.instrument.getRewireCount();

      // Drop channel b, and move a knob on the REMAINING channel's sound. Spread rather
      // than cloned: the reducer shares structure, and the section diff is a reference
      // compare — a deep clone would dirty every section and rebuild what did not move.
      const edited: SynthPreset = {
        ...sine,
        voice: { ...sine.voice, filter: { ...sine.voice.filter, Q: 6 } },
      };
      runtime.applySong(song([track('a', edited, hold('A3'))]));

      counts = {
        two,
        after: runtime.channelCount,
        gone: runtime.channel('b') === undefined ? 1 : 0,
        // Dropped from the map is not freed: without the dispose, a removed channel leaks
        // a whole instrument — voices, LFOs, scalers — and keeps rendering into the bus.
        freed: removed.isDisposed ? 1 : 0,
        // A filter edit is not a modulation edit: channel a's graph must not be rebuilt.
        rewiresAdded: runtime.channel('a')!.instrument.getRewireCount() - rewires,
      };
    });
    expect(counts).toEqual({ two: 2, after: 1, gone: 1, freed: 1, rewiresAdded: 0 });
  });

  it('an edit to one channel does not rebuild the other', async () => {
    const sine = sinePatch();
    const saw = sawPatch();
    let rebuilt = -1;
    await render(0.3, (runtime) => {
      runtime.applyPatch(sine);
      const a = track('a', sine, hold('A3'));
      const b = track('b', saw, hold('A5'));
      runtime.applySong(song([a, b]));
      runtime.transport.play();
      const before = runtime.channel('b')!.instrument.getRewireCount();
      // Channel a gets a new LFO and a route — the one edit that DOES rewire a graph.
      const edited = sinePatch((patch) => {
        patch.voice.lfos = [{ id: 'l0', enabled: true, type: 'sine', frequency: 4, sync: false, retrigger: false }];
        patch.voice.modRoutes = [{ id: 'r0', source: 'lfo.0', destination: 'voice.pan', depth: 0.5, enabled: true }];
      });
      runtime.applySong(song([track('a', edited, hold('A3')), b]));
      rebuilt = runtime.channel('b')!.instrument.getRewireCount() - before;
    });
    expect(rebuilt, "channel b's modulation graph was rebuilt by an edit to channel a").toBe(0);
  });
});
