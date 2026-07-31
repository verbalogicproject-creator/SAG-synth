/**
 * src/clients/synth/controls/GlyphButtons.tsx — a value space small enough to show whole.
 *
 * Serves both enums and the numbers that carry `choices`, because those are the same
 * control wearing two spec kinds: `voice.filter.rolloff` has four legal slopes and a
 * slider there would produce values the validator refuses.
 *
 * **A glyph is a decoration, never a filter.** The map below is a lookup with a fallback to
 * the value's own name, so an enum member added to the contract is drawn as text rather
 * than silently dropped — an option that exists in the schema and not on the screen is the
 * exact shape of every decoy this project has shipped.
 */

import { glyphFor } from './glyphs';
import { COLOR, FONT, TOUCH_MIN } from '../tokens';
import { sagAttributes, type ControlProps } from './types';


export function GlyphButtons({
  id,
  path,
  label,
  spec,
  value,
  onChange,
  state = 'live',
  reason,
}: ControlProps) {
  const options: readonly (string | number)[] =
    spec.kind === 'enum'
      ? spec.values
      : spec.kind === 'number' && spec.choices !== undefined
        ? spec.choices
        : [];

  if (options.length === 0) {
    throw new Error(`GlyphButtons drew "${path}", which has no declared value list.`);
  }

  const tint = state === 'ignored' ? COLOR.ignored : COLOR.accent;

  return (
    <div {...sagAttributes({ id, path })} style={styles.wrap}>
      <span style={styles.label}>{label}</span>
      <div style={styles.row} role="radiogroup" aria-label={label}>
        {options.map((option) => {
          const selected = option === value;
          return (
            <button
              key={String(option)}
              type="button"
              role="radio"
              aria-checked={selected}
              // The glyph is on the face; the name is what a screen reader says.
              aria-label={String(option)}
              title={String(option)}
              onClick={() => onChange(path, option)}
              style={{
                ...styles.button,
                background: selected ? tint : 'transparent',
                color: selected ? COLOR.surfaceLowest : COLOR.text,
                borderColor: selected ? tint : COLOR.border,
              }}
            >
              {glyphFor(option)}
            </button>
          );
        })}
      </div>
      {state === 'ignored' && reason !== undefined && <span style={styles.reason}>{reason}</span>}
    </div>
  );
}

const styles = {
  wrap: { display: 'block', width: '100%' },
  label: {
    display: 'block',
    fontFamily: FONT.display,
    fontSize: '0.65rem',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: COLOR.textDim,
    marginBottom: '0.25rem',
  },
  // Wraps rather than shrinking: eight filter types on a narrow phone become two rows of
  // real targets instead of one row of unhittable ones.
  row: { display: 'flex', flexWrap: 'wrap', gap: '0.25rem' },
  button: {
    flex: '1 1 auto',
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    borderRadius: 4,
    borderStyle: 'solid',
    borderWidth: 1,
    fontFamily: FONT.mono,
    fontSize: '0.85rem',
    cursor: 'pointer',
  },
  reason: { fontFamily: FONT.display, fontSize: '0.6rem', color: COLOR.ignored },
} as const satisfies Record<string, React.CSSProperties>;
