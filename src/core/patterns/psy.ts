/**
 * src/core/patterns/psy.ts — the psytrance bassline, as notes.
 *
 * The genre's bass is not a melody, it is a rhythm around the kick: the kick takes the
 * first 16th of every beat and the bass fills the rest, so the two never share the sub range
 * at the same instant. That gap IS the mix — "where the kick thumps, the bass ducks"
 * (dsokolovskiy.com). The scheduled duck (`duck.ts`) only polishes what the arrangement
 * already does.
 *
 * - **roll** — K B B B: bass on 16ths 2, 3, 4 of every beat. Twelve notes a bar.
 * - **gallop** — K . B B: bass on 16ths 3 and 4; the empty 16th after the kick is the gallop.
 *
 * The first bass note after each kick is softer (`firstVelocityRatio`, ~0.7): "lower in
 * velocity by some 30pct approx" (masteringmastering.co.uk), and exactly what Eyal's
 * reference roll shows. With velocity routed to the filter, it is also darker, which is
 * where the roll's forward lean comes from.
 *
 * Notes are short — `gate` is a fraction of a 16th, 0.5–0.75 per myloops.net ("MIDI note
 * length 50–75 ms" at 145 BPM, where a 16th is 103 ms) — because each note must be silent
 * before the next one starts.
 */

import type { Beats, NoteEvent, NoteName } from '../types';

export type PsyStyle = 'roll' | 'gallop';

export interface PsyPatternOptions {
  /** Default 'G1' (~49 Hz): Eyal's reference sits there, inside the usual F1–A1 range. */
  root?: NoteName;
  style?: PsyStyle;
  /** 1–16 bars of `beatsPerBar` beats. Default 1. */
  bars?: number;
  beatsPerBar?: number;
  /** Fraction of a 16th each bass note lasts. Default 0.6. */
  gate?: number;
  /** Velocity of the bass notes. Default 1. */
  velocity?: number;
  /** The first bass note of each beat, relative to `velocity`. Default 0.7. */
  firstVelocityRatio?: number;
  /**
   * Push the first bass note after each kick this many BEATS late, to clear the kick's sub
   * tail (myloops.net suggests 5–15 ms; at 145 BPM, 10 ms is ~0.024 beats). Default 0.
   */
  firstNudge?: Beats;
  /** The kick notes' display pitch. The kick voice plays its own `tune`. Default 'C3'. */
  kickNote?: NoteName;
  /**
   * Caller-supplied id prefix. Core never mints ids — replay must reproduce them exactly —
   * so ids are `${idPrefix}-b-<beat>-<step>` and `${idPrefix}-k-<beat>`.
   */
  idPrefix: string;
}

export interface PsyPattern {
  bass: NoteEvent[];
  kick: NoteEvent[];
  /** Beats the pattern spans; the natural loop end. */
  length: Beats;
}

const SIXTEENTH: Beats = 0.25;

/** Which 16ths of a beat (0 = the kick's) carry bass. */
const STEPS: Record<PsyStyle, readonly number[]> = {
  roll: [1, 2, 3],
  gallop: [2, 3],
};

export function psyPattern(options: PsyPatternOptions): PsyPattern {
  const root = options.root ?? 'G1';
  const style = options.style ?? 'roll';
  const bars = clampInt(options.bars ?? 1, 1, 16);
  const beatsPerBar = clampInt(options.beatsPerBar ?? 4, 1, 16);
  const gate = clamp(options.gate ?? 0.6, 0.05, 1);
  const velocity = clamp(options.velocity ?? 1, 0, 1);
  const firstRatio = clamp(options.firstVelocityRatio ?? 0.7, 0, 1);
  // At most half the note, so a nudged note can never end up zero or negative in length.
  const nudge = clamp(options.firstNudge ?? 0, 0, (SIXTEENTH * gate) / 2);
  const kickNote = options.kickNote ?? 'C3';
  const beats = bars * beatsPerBar;

  const bass: NoteEvent[] = [];
  const kick: NoteEvent[] = [];
  for (let beat = 0; beat < beats; beat += 1) {
    kick.push({
      noteId: `${options.idPrefix}-k-${beat}`,
      time: beat,
      duration: SIXTEENTH,
      note: kickNote,
      velocity: 1,
    });
    STEPS[style].forEach((step, index) => {
      const first = index === 0;
      bass.push({
        noteId: `${options.idPrefix}-b-${beat}-${step}`,
        time: beat + step * SIXTEENTH + (first ? nudge : 0),
        // A nudged note keeps its END where it was, so it cannot run into the next 16th.
        duration: SIXTEENTH * gate - (first ? nudge : 0),
        note: root,
        velocity: round(first ? velocity * firstRatio : velocity),
      });
    });
  }
  return { bass, kick, length: beats };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  return clamp(Math.round(value), min, max);
}

/** Six decimals: 0.7 * 1 should be 0.7 in a saved song, not 0.7000000000000001. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
