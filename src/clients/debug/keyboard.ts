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

/**
 * Where each drawn key's centre sits across the keyboard's width, paired with the semitone
 * it sounds. **Derived from the two tables above, never written out.**
 *
 * This exists because a piano keyboard's X axis is NOT linear in pitch, and assuming it is
 * shipped a pad on which four of the eight white keys played a different note than they
 * drew — C sounded C#, A sounded G#, B sounded A#, C sounded B. Eight equal-width white
 * keys span twelve semitones, but the semitones are not spread evenly across them: C→D is
 * two semitones of travel and E→F is one. `fraction * 12` is therefore wrong everywhere
 * except by accident.
 *
 * The anchors are what makes it right. Sorted by x they are monotonic in both axes, so a
 * piecewise-linear interpolation between them gives exactly the drawn note at any key's
 * centre and a continuous glide in between. Segment widths differ — E→F covers 0.125 of the
 * width for one semitone where F→F# covers 0.0625 — so the glide rate varies across the
 * keyboard, which is what a keyboard-SHAPED pitch surface should do.
 */
export interface KeyAnchor {
  /** Centre of the drawn key, as a fraction of the keyboard's width. */
  x: number;
  /** Semitone above the base octave's C. */
  semitone: number;
  label: string;
}

export const KEY_ANCHORS: readonly KeyAnchor[] = [
  ...WHITE_KEYS.map((key, index) => ({
    // White keys are laid out at equal widths, so key i spans [i/n, (i+1)/n).
    x: (index + 0.5) / WHITE_KEYS.length,
    semitone: key.offset,
    label: key.label,
  })),
  ...BLACK_KEYS.map((key) => ({
    // A black key is centred on the boundary between the white key it follows and the next.
    x: (key.afterWhite + 1) / WHITE_KEYS.length,
    semitone: key.offset,
    label: key.label,
  })),
].sort((a, b) => a.x - b.x);

/**
 * The note and detune at a horizontal position across the drawn keyboard.
 *
 * At a key's centre the detune is 0 and the note is exactly the one drawn there. Between
 * two centres the position interpolates, so a press between keys sounds between keys —
 * which is the entire reason to offer a pad instead of buttons.
 */
export function pitchAtFraction(
  fraction: number,
  baseOctave: number,
): { note: string; detuneCents: number } {
  const clamped = Math.min(Math.max(fraction, 0), 1);

  let semitone = KEY_ANCHORS[KEY_ANCHORS.length - 1]!.semitone;
  if (clamped <= KEY_ANCHORS[0]!.x) {
    semitone = KEY_ANCHORS[0]!.semitone;
  } else {
    for (let i = 1; i < KEY_ANCHORS.length; i += 1) {
      const low = KEY_ANCHORS[i - 1]!;
      const high = KEY_ANCHORS[i]!;
      if (clamped <= high.x) {
        const across = (clamped - low.x) / (high.x - low.x);
        semitone = low.semitone + across * (high.semitone - low.semitone);
        break;
      }
    }
  }

  const nearest = Math.round(semitone);
  return {
    note: noteName(baseOctave, nearest),
    detuneCents: (semitone - nearest) * CENTS_PER_SEMITONE,
  };
}

/** How a semitone divides into cents. Notation, not a parameter. */
const CENTS_PER_SEMITONE = 100;
