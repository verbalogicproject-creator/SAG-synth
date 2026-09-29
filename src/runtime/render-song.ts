/**
 * src/runtime/render-song.ts — the song, rendered faster than real time (cycle 2, C3c).
 *
 * A WAV export is the live engine run offline: a fresh `ToneRuntime` built INSIDE
 * `Tone.Offline`, given the patch and the (unrolled, see `core/export.ts`) song, with the
 * transport started at zero. Same voices, same effects, same master limiter, same sequencer
 * — so the file is what you heard, not a second opinion of it. The live engine is not
 * touched: the offline runtime lives on its own context and is disposed when done.
 *
 * The lookahead is the one knob set differently from the defaults: offline, Tone runs no
 * lookahead at all, so a Transport callback fires only once the simulated clock has passed
 * its time and the notes it books land a render block late. 50 ms restores the online shape
 * (the same setting `transport.audio.test.ts` uses).
 */

import * as Tone from 'tone';
import type { Song, SynthPreset } from '../core/types';
import { ToneRuntime } from './tone-runtime';

export const RENDER_LOOKAHEAD = 0.05;

export interface RenderedSong {
  channels: Float32Array[];
  sampleRate: number;
}

export async function renderSong(options: {
  patch: SynthPreset;
  song: Song;
  seconds: number;
  sampleRate?: number;
}): Promise<RenderedSong> {
  const sampleRate = options.sampleRate ?? 44100;
  let runtime: ToneRuntime | null = null;
  const buffer = await Tone.Offline(
    () => {
      runtime = new ToneRuntime({ lookAhead: RENDER_LOOKAHEAD });
      runtime.applyPatch(options.patch);
      runtime.applySong(options.song);
      runtime.transport.play();
    },
    options.seconds,
    2,
    sampleRate,
  );
  try {
    (runtime as ToneRuntime | null)?.dispose();
  } catch {
    // The offline context is already finished; nothing left to free but the objects.
  }
  const channels = [0, 1].map((index) => Float32Array.from(buffer.getChannelData(index)));
  return { channels, sampleRate };
}
