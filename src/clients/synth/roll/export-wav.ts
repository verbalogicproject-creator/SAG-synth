/**
 * src/clients/synth/roll/export-wav.ts — the EXPORT WAV button's whole job (C3c).
 *
 * Plan (core, pure), render (runtime, offline), encode (core, pure), save (app). Each step is
 * gated where it lives; this only strings them together and names the file.
 */

import { saveFile } from '../../../app/files';
import { exportPlan } from '../../../core/export';
import { safeFileName } from '../../../core/session';
import type { EngineState } from '../../../core/state';
import { encodeWav } from '../../../core/wav';
import { renderSong } from '../../../runtime';

export interface WavExportResult {
  ok: boolean;
  message: string;
}

export async function exportWav(state: EngineState, loops: number): Promise<WavExportResult> {
  const plan = exportPlan(state.song, loops, state.patch.voice.envelope.release);
  const { channels, sampleRate } = await renderSong({ patch: state.patch, song: plan.song, seconds: plan.renderSeconds });
  const wav = encodeWav(channels, sampleRate);
  const passes = state.song.loop.enabled ? `-${loops}x` : '';
  const name = safeFileName(`${state.song.name} ${state.patch.name}${passes}`, 'wav');
  const saved = saveFile(name, 'audio/wav', wav);
  const size = `${(wav.length / 1_048_576).toFixed(1)} MB`;
  return saved.ok
    ? { ok: true, message: `Saved ${plan.renderSeconds.toFixed(1)} s (${size}) to ${saved.where}` }
    : { ok: false, message: `Rendered, but saving failed: ${saved.error}` };
}
