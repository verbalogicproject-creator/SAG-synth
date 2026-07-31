/**
 * src/clients/synth/tokens.ts — the palette and type, read off the design rather than chosen.
 *
 * Every value here was extracted from the `code.html` of each screen under
 * `design/stitch`, where the Tailwind config block at the top carries the system Eyal
 * drew. Counted across the seven screens, `#00dbe9` appears 28 times and `#131315` 27 —
 * those two carry the identity and everything else is scaffolding around them.
 *
 * **The secondary hues are NOT extracted, and that is the finding.** The mockups contain
 * three greens within a hair of each other (`#90db00`, `#a5fa00`, `#9ef000`), plus an
 * orange and a salmon used per screen. That is improvisation, not a system — a designed
 * screen can afford it and a generated surface cannot, because a control's colour has to
 * mean the same thing on every tab. So the state hues below are AUTHORED, one per meaning,
 * and `arch/design-system.ngf.md` records them at 4.6.
 *
 * Fonts are loaded by the shell, not here — this file states names, not network requests.
 */

/** The two that carry the identity. */
export const ACCENT = '#00dbe9';
export const SURFACE = '#131315';

export const COLOR = {
  accent: ACCENT,
  /** Near-white cyan, for text on the dark surface. */
  accentText: '#dbfcff',
  /** The accent at rest — used for tracks and inactive arcs. */
  accentDim: '#006970',

  surface: SURFACE,
  surfaceLowest: '#0e0e10',
  surfaceLow: '#1b1b1d',
  surfaceHigh: '#2a2a2c',
  surfaceVariant: '#353437',

  text: '#e5e1e4',
  textDim: '#849495',
  border: '#3b494b',

  /**
   * One hue, one meaning. Authored rather than extracted, per the note above.
   *
   * `ignored` — the patch sets it and the current shape cannot honour it, e.g. `width`
   *   on a sawtooth. The control works; the value has nowhere to land.
   * `overflow` — the routes at a destination ask for more travel than it has.
   * `clip`  — the output stage is limiting.
   * `unwired` — declared, validated, journalled, and reaching no audio node. This one is
   *   a DESTINATION state, so it belongs on a bay jack and never on a parameter's own
   *   control: `effects.delay.wet` is a live knob that no cable can reach.
   */
  ignored: '#ffb59a',
  overflow: '#ff5e07',
  clip: '#ffb4ab',
  unwired: '#5a5a5e',
} as const;

export const FONT = {
  /** Headings, labels, anything read as language. */
  display: "'Space Grotesk', system-ui, sans-serif",
  /** Numerals and addresses. Tabular, so a changing value does not jitter its neighbours. */
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;

/**
 * Touch targets. 44px is Apple's guideline and the floor everything here respects — the
 * debug wall's own note about the browser's ~4px range thumb is the reason it is stated
 * rather than assumed.
 */
export const TOUCH_MIN = 44;
