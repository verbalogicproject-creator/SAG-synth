/**
 * src/tests/render-song.audio.test.ts — the WAV export's render (C3c).
 *
 * The psytrance pattern, looped twice at 145 BPM, rendered by the same path the EXPORT WAV
 * button takes: `exportPlan` unrolls the loop, `renderSong` runs the live engine offline.
 */

import { describe, expect, it } from 'vitest';
import { exportPlan } from '../core/export';
import { psyPattern } from '../core/patterns/psy';
import { defaultSong, defaultTrack, psyRollPreset } from '../core/state';
import type { Song } from '../core/types';
import { encodeWav } from '../core/wav';
import { renderSong } from '../runtime/render-song';
import { withSound } from '../test-harness/song-sound';
import { rms } from '../test-harness/audio-assertions';

const KICK = { tune: 'G1' as const, punch: 3, pitchDecay: 0.03, decay: 0.22, level: 0 };

function psySong(): Song {
  const pattern = psyPattern({ idPrefix: 'p' });
  return {
    ...defaultSong(),
    bpm: 145,
    swing: 0,
    loop: { enabled: true, start: 0, end: pattern.length },
    tracks: [
      { ...defaultTrack(), id: 'bass', name: 'bass', notes: pattern.bass },
      { ...defaultTrack(), id: 'kick', name: 'kick', isDrum: true, notes: pattern.kick, kick: KICK },
    ],
  };
}

const beat = 60 / 145;
const energy = (data: Float32Array, sr: number, from: number, to: number) =>
  rms(data, Math.round(from * sr), Math.round(to * sr));

describe('renderSong', () => {
  it('renders every kick of every pass, and no downbeat of a pass that was never asked for', async () => {
    const patch = psyRollPreset();
    const plan = exportPlan(withSound(psySong(), patch), 2, patch.voice.envelope.release);
    const { channels, sampleRate } = await renderSong({ patch, song: plan.song, seconds: plan.renderSeconds });
    const left = channels[0]!;

    expect(Math.abs(left.length - plan.renderSeconds * sampleRate)).toBeLessThanOrEqual(1);
    // Each of the 8 beats (2 passes x 4) opens with a kick: loud in the first 30 ms.
    const hits = Array.from({ length: 8 }, (_unused, k) => energy(left, sampleRate, k * beat, k * beat + 0.03));
    for (const [k, hit] of hits.entries()) expect(hit, `beat ${k}`).toBeGreaterThan(0.05);

    // Where pass 3 would start there is only the fading tail of pass 2 — no new kick.
    const end = plan.musicSeconds;
    const phantom = energy(left, sampleRate, end + 0.005, end + 0.035);
    expect(phantom, 'a downbeat after the last pass').toBeLessThan(Math.min(...hits) / 4);
  });

  it('encodes to a WAV of the right size', async () => {
    const patch = psyRollPreset();
    const plan = exportPlan(withSound(psySong(), patch), 1, 0);
    const { channels, sampleRate } = await renderSong({ patch, song: plan.song, seconds: plan.renderSeconds });
    const wav = encodeWav(channels, sampleRate);
    expect(wav.length).toBe(44 + channels[0]!.length * 2 * 2);
  });
});
