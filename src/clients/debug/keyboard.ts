/**
 * src/clients/debug/keyboard.ts — QWERTY as a two-octave keyboard.
 *
 * The conventional tracker/DAW layout: the home row is the white keys and the row above
 * holds the black ones, so the shapes under your fingers match a piano.
 *
 *     w e   t y u   o p
 *    a s d f g h j k l ;
 */

const SEMITONE_BY_KEY: Readonly<Record<string, number>> = {
  a: 0, // C
  w: 1, // C#
  s: 2, // D
  e: 3, // D#
  d: 4, // E
  f: 5, // F
  t: 6, // F#
  g: 7, // G
  y: 8, // G#
  h: 9, // A
  u: 10, // A#
  j: 11, // B
  k: 12, // C (+1 octave)
  o: 13,
  l: 14,
  p: 15,
  ';': 16,
};

const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Octave range that keeps every generated name inside `NOTE_NAME_RE`. */
export const MIN_OCTAVE = 0;
export const MAX_OCTAVE = 8;

export function isMusicalKey(key: string): boolean {
  return key.toLowerCase() in SEMITONE_BY_KEY;
}

/**
 * Scientific pitch notation for a semitone offset above a base octave's C.
 *
 * Must satisfy `NOTE_NAME_RE` — the reducer validates it, so a malformed name surfaces
 * as a rejected command rather than a silently missing note.
 */
export function noteName(baseOctave: number, semitone: number): string {
  const absolute = baseOctave * 12 + semitone;
  const octave = Math.floor(absolute / 12);
  const pitchClass = PITCH_CLASSES[((absolute % 12) + 12) % 12]!;
  return `${pitchClass}${octave}`;
}

/** As `noteName`, but addressed by QWERTY key. Null if the key is not in the layout. */
export function noteForKey(key: string, baseOctave: number): string | null {
  const semitone = SEMITONE_BY_KEY[key.toLowerCase()];
  return semitone === undefined ? null : noteName(baseOctave, semitone);
}

/**
 * One octave of on-screen keys, plus the octave's closing C so the layout ends on a
 * white key. `offset` is the semitone above the base octave's C.
 */
export interface KeyDef {
  offset: number;
  label: string;
  black: boolean;
}

export const WHITE_KEYS: readonly KeyDef[] = [
  { offset: 0, label: 'C', black: false },
  { offset: 2, label: 'D', black: false },
  { offset: 4, label: 'E', black: false },
  { offset: 5, label: 'F', black: false },
  { offset: 7, label: 'G', black: false },
  { offset: 9, label: 'A', black: false },
  { offset: 11, label: 'B', black: false },
  { offset: 12, label: 'C', black: false },
];

/**
 * `afterWhite` is the index of the white key each black key sits to the right of, which
 * is what positions it over the correct gap. There is deliberately no black key after
 * index 2 (E) or 6 (B) — that is what makes a piano layout readable by touch.
 */
export const BLACK_KEYS: readonly (KeyDef & { afterWhite: number })[] = [
  { offset: 1, label: 'C#', black: true, afterWhite: 0 },
  { offset: 3, label: 'D#', black: true, afterWhite: 1 },
  { offset: 6, label: 'F#', black: true, afterWhite: 3 },
  { offset: 8, label: 'G#', black: true, afterWhite: 4 },
  { offset: 10, label: 'A#', black: true, afterWhite: 5 },
];

export function clampOctave(octave: number): number {
  return Math.min(MAX_OCTAVE, Math.max(MIN_OCTAVE, octave));
}
