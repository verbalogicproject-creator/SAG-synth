/**
 * src/core/wav.ts — PCM samples to a .wav file, byte for byte (cycle 2, C3c).
 *
 * 16-bit little-endian PCM, interleaved — the one WAV every DAW, phone and browser opens. The
 * render is floating point; this is where it becomes integers, so the two decisions that can
 * hurt a file live here and are runner tests: clipping (a sample past ±1 is clamped, never
 * wrapped around into a loud click) and rounding (symmetric, so silence stays silence).
 *
 * Pure (D2): no Tone, no DOM. `src/runtime/render-song.ts` produces the samples and
 * `src/app/files.ts` puts the bytes in Download/SAG/.
 */

export const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

/** One float sample to a signed 16-bit integer: clamped to ±1, scaled, rounded. */
export function toInt16(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  const clamped = Math.max(-1, Math.min(1, sample));
  // `+ 0` folds -0 into 0: silence is one value, not two.
  return (clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)) + 0;
}

/**
 * Encode channels of equal length (stereo is `[left, right]`) as a 16-bit PCM WAV file.
 * Channels shorter than the first are padded with silence rather than refused.
 */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  if (channels.length === 0) throw new Error('encodeWav: no channels');
  const frames = channels[0]!.length;
  const count = channels.length;
  const dataBytes = frames * count * BYTES_PER_SAMPLE;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, count * BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < count; channel += 1) {
      view.setInt16(offset, toInt16(channels[channel]![frame] ?? 0), true);
      offset += BYTES_PER_SAMPLE;
    }
  }
  return bytes;
}
