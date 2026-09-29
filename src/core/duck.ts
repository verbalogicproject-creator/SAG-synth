/**
 * src/core/duck.ts — the gain curve a note-triggered duck writes, as a pure function.
 *
 * Every kick hit dips the ducked track: down to `-depthDb` over `attackMs`, back to unity
 * over `releaseMs`. This is what a psytrance "sidechain" is asked to do (2–4 dB, fastest
 * attack, 40–70 ms, back at 0 dB before the first bass 16th, which at 145 BPM is 103 ms
 * after the kick) — scheduled on the audio clock from the kick's KNOWN note times, rather
 * than reacting to the kick's audio the way a compressor would. Web Audio's compressor has
 * no sidechain input at all (spec issue #246), and an envelope follower lags its own
 * smoothing; a schedule lands on the sample.
 *
 * Points are linear in GAIN, not dB. Over a 1 ms attack and a ~60 ms release at 3 dB the
 * two differ by a fraction of a dB, and linear ramps are what `AudioParam` does natively.
 */

import type { DuckConfig } from './types';

export interface DuckPoint {
  /** Seconds, on whatever clock the kick times were given in. */
  time: number;
  /** Linear gain. */
  gain: number;
  /** `set` jumps (only ever used to anchor a curve), `ramp` is a linear ramp ending here. */
  kind: 'set' | 'ramp';
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * The automation for a run of kick hits (seconds, ascending).
 *
 * When a hit arrives before the previous recovery finished, the recovery is cut where it
 * stands and the new dip starts from that level — so overlapping hits never step the gain
 * and never dip deeper than `depthDb`. `startGain` is where the curve stands at the first
 * hit, for a caller that is continuing a curve from an earlier window.
 */
export function duckPoints(kickTimes: readonly number[], duck: Pick<DuckConfig, 'depthDb' | 'attackMs' | 'releaseMs'>, startGain = 1): DuckPoint[] {
  const floor = dbToGain(-Math.max(0, duck.depthDb));
  const attack = Math.max(0, duck.attackMs) / 1000;
  const release = Math.max(0, duck.releaseMs) / 1000;
  const points: DuckPoint[] = [];

  for (let index = 0; index < kickTimes.length; index += 1) {
    const t = kickTimes[index]!;
    const from = index === 0 ? startGain : gainAt(points, t);
    const next = kickTimes[index + 1];

    // Anchor the dip at the level the curve actually has at `t`.
    points.push({ time: t, gain: from, kind: 'set' });
    const bottom = t + attack;
    const top = bottom + release;

    if (next !== undefined && next < bottom) {
      // The next hit lands mid-attack: stop at the level reached by then.
      points.push({ time: next, gain: lerp(from, floor, (next - t) / (attack || 1)), kind: 'ramp' });
      continue;
    }
    points.push({ time: bottom, gain: floor, kind: 'ramp' });
    if (next !== undefined && next < top) {
      points.push({ time: next, gain: lerp(floor, 1, (next - bottom) / (release || 1)), kind: 'ramp' });
      continue;
    }
    points.push({ time: top, gain: 1, kind: 'ramp' });
  }
  return points;
}

/** The curve's value at `time`, by the same linear interpolation `AudioParam` performs. */
export function gainAt(points: readonly DuckPoint[], time: number): number {
  let previous: DuckPoint | undefined;
  for (const point of points) {
    if (point.time > time) {
      if (previous === undefined) return 1;
      if (point.kind === 'set') return previous.gain;
      const span = point.time - previous.time;
      return span <= 0 ? point.gain : lerp(previous.gain, point.gain, (time - previous.time) / span);
    }
    previous = point;
  }
  return previous?.gain ?? 1;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}
