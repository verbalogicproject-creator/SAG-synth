/**
 * Shared audio assertion helpers for *.audio.test.ts files.
 *
 * These are the primitives every runtime-layer gate is written against, so that
 * "does this synth module work" is a machine-checkable question rather than a
 * listening opinion. Pure functions over Float32Array — no Tone, no DOM.
 */

/** Root-mean-square level over a sample window. The basic "is there sound" measure. */
export function rms(data: Float32Array, from = 0, to = data.length): number {
  const lo = Math.max(0, from);
  const hi = Math.min(data.length, to);
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, hi - lo));
}

/** Absolute peak sample. Used for the limiter gate (must never exceed 1.0). */
export function peak(data: Float32Array, from = 0, to = data.length): number {
  const lo = Math.max(0, from);
  const hi = Math.min(data.length, to);
  let max = 0;
  for (let i = lo; i < hi; i++) {
    const v = Math.abs(data[i]);
    if (v > max) max = v;
  }
  return max;
}

/**
 * Largest sample-to-sample discontinuity. Voice stealing that clicks shows up
 * here as a big jump; a declicked steal keeps this small.
 */
export function maxDiscontinuity(data: Float32Array, from = 0, to = data.length): number {
  const lo = Math.max(1, from);
  const hi = Math.min(data.length, to);
  let max = 0;
  for (let i = lo; i < hi; i++) {
    const d = Math.abs(data[i] - data[i - 1]);
    if (d > max) max = d;
  }
  return max;
}

/**
 * Note-onset times in seconds, found by short-window energy rising past
 * `threshold` after being below it. Used to verify sequencer timing/swing.
 */
export function onsets(
  data: Float32Array,
  sampleRate: number,
  threshold = 0.02,
  windowMs = 5,
): number[] {
  const win = Math.max(1, Math.floor((windowMs / 1000) * sampleRate));
  const found: number[] = [];
  let armed = true;
  for (let start = 0; start + win <= data.length; start += win) {
    const level = rms(data, start, start + win);
    if (armed && level > threshold) {
      found.push(start / sampleRate);
      armed = false;
    } else if (!armed && level < threshold * 0.5) {
      armed = true;
    }
  }
  return found;
}

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
function fftRadix2(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * Spectral energy above `aboveHz`, as a fraction of total spectral energy.
 * This is the filter gate: lowering cutoff must drop this substantially.
 * Hann-windowed, analysed over the first power-of-two window at `atSample`.
 */
export function hfEnergyRatio(
  data: Float32Array,
  sampleRate: number,
  aboveHz: number,
  atSample = 0,
  fftSize = 8192,
): number {
  const n = 1 << Math.floor(Math.log2(fftSize));
  if (atSample + n > data.length) atSample = Math.max(0, data.length - n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))); // Hann
    re[i] = (data[atSample + i] ?? 0) * w;
  }
  fftRadix2(re, im);

  const binHz = sampleRate / n;
  const cutBin = Math.floor(aboveHz / binHz);
  let total = 0;
  let high = 0;
  for (let k = 1; k < n / 2; k++) {
    const mag = re[k] * re[k] + im[k] * im[k];
    total += mag;
    if (k >= cutBin) high += mag;
  }
  return total > 0 ? high / total : 0;
}

/** Convenience: the same measure in decibels, for "drops >= 20 dB" style gates. */
export function hfEnergyDb(
  data: Float32Array,
  sampleRate: number,
  aboveHz: number,
  atSample = 0,
): number {
  const ratio = hfEnergyRatio(data, sampleRate, aboveHz, atSample);
  return 10 * Math.log10(Math.max(ratio, 1e-12));
}

/**
 * Fundamental frequency estimate (Hz) via zero-crossing rate over a short
 * window. Coarse but sufficient for the portamento glide gate, where we only
 * assert the pitch sits strictly between start and target mid-glide.
 */
export function estimatePitch(
  data: Float32Array,
  sampleRate: number,
  atSeconds: number,
  windowMs = 50,
): number {
  const start = Math.floor(atSeconds * sampleRate);
  const win = Math.floor((windowMs / 1000) * sampleRate);
  const end = Math.min(data.length, start + win);

  // Measure between the FIRST and LAST upward crossing rather than across the
  // whole window: a fixed window truncates a partial cycle and biases the
  // estimate low (a 50ms window at 440Hz reads 420Hz).
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = start + 1; i < end; i++) {
    if (data[i - 1] <= 0 && data[i] > 0) {
      if (first < 0) first = i;
      last = i;
      count++;
    }
  }
  if (count < 2 || last <= first) return 0;
  return ((count - 1) * sampleRate) / (last - first);
}
