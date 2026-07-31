/**
 * src/clients/synth/controls/glyphs.ts — a picture where a picture reads faster.
 *
 * Shared by the button row and the dropdown, which is the whole reason it is a file. A
 * wave called `∿ sine` in a list and `∿` on a button is one vocabulary; two copies of this
 * map would be two, and this project has spent a day removing exactly that shape of
 * duplication.
 *
 * **A lookup with a fallback, never a filter.** An enum member added to the contract and
 * missing from this map is drawn as its own name. A value the schema accepts and the
 * screen omits is unreachable, which is the failure every gate here exists to catch.
 */

const GLYPHS: Record<string, string> = {
  sine: '∿',
  triangle: '△',
  sawtooth: '◺',
  square: '⊓',
  pulse: '∏',
  pwm: '⊐',
  noise: '▨',

  lowpass: 'LP',
  highpass: 'HP',
  bandpass: 'BP',
  notch: 'NO',
  lowshelf: 'LS',
  highshelf: 'HS',
  allpass: 'AP',
  peaking: 'PK',

  '-12': '12',
  '-24': '24',
  '-48': '48',
  '-96': '96',
};

/** The face of a button: a glyph if there is one, otherwise the value itself. */
export function glyphFor(option: string | number): string {
  return GLYPHS[String(option)] ?? String(option);
}

/**
 * The line in a dropdown: the glyph AND the name.
 *
 * A list has room for both, and a bare `∿` in a menu is a puzzle rather than a shortcut —
 * the glyph earns its place on a button, where the label is already beside it.
 */
export function optionLabel(option: string | number): string {
  const glyph = GLYPHS[String(option)];
  return glyph === undefined ? String(option) : `${glyph}  ${option}`;
}
