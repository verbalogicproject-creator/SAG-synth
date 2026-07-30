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

/**
 * The frequency below which `fraction` of the spectrum's energy lies, expressed in
 * **octaves above 20 Hz**. How high the sound reaches, not how loud it is.
 *
 * Two choices here, both for the same reason — this exists to compare filter movement
 * taken from different starting cutoffs, and F80 turns on that comparison being fair.
 *
 * **Octaves, not Hz.** In Hz the identical musical gesture measures four times larger two
 * octaves up than two octaves down, so "did these two sweeps travel the same distance" is
 * unanswerable. In octaves the same gesture measures the same from anywhere, which is
 * exactly the claim `curve: octaves` makes.
 *
 * **An energy edge, not a centroid.** The obvious measure is the spectral centroid, and on
 * this material it barely works: a sawtooth's harmonics fall as 1/n, so the fundamental
 * carries most of the energy and holds the centre of mass nearly still. A two-octave cutoff
 * sweep on a C3 saw moves the energy-weighted centroid 0.45 octaves — real, but small
 * enough that a gate built on it would be measuring rounding.
 *
 * The default fraction is 0.99 for the same reason, and it was measured rather than picked.
 * The same sweep moved the 90% edge 1.78 octaves from a 800 Hz base and 0.24 from a 3200 Hz
 * one — not because the sweeps differ but because 90% of a C3 saw's energy sits below
 * 800 Hz, so the measure saturates and stops seeing the filter at all. At 99% it reads
 * 3.56 and 2.23. The edge tracks cutoff plus stopband decay rather than cutoff alone, which
 * is fair for comparing two renders at the same rolloff and would not be across different
 * ones.
 *
 * Bins below 20 Hz are excluded: no musical content, `log2` runs negative, and DC diverges.
 */
export function spectralEdgeOctaves(
  data: Float32Array,
  sampleRate: number,
  atSample = 0,
  fraction = 0.99,
  fftSize = 4096,
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
  const firstBin = Math.max(1, Math.ceil(20 / binHz));
  const mags: number[] = [];
  let total = 0;
  for (let k = firstBin; k < n / 2; k++) {
    const mag = re[k] * re[k] + im[k] * im[k];
    mags.push(mag);
    total += mag;
  }
  if (total <= 0) return 0;

  const target = total * fraction;
  let running = 0;
  for (let i = 0; i < mags.length; i++) {
    running += mags[i] as number;
    if (running >= target) return Math.log2(((firstBin + i) * binHz) / 20);
  }
  return Math.log2((((n / 2) - 1) * binHz) / 20);
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
