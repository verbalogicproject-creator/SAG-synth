/**
 * src/clients/synth/controls/Select.tsx — every enum, as a list.
 *
 * Buttons lost this on the device. Seven wave shapes or eight filter types each eat a full
 * row of a phone screen that holds about nine, and a route's destination holds all 31 —
 * that one was never a button row at all, it was a list wearing one. The glyph rides along
 * in the option text, so the picture is not the thing being traded away, only the space.
 *
 * **It labels addresses the way everything else does.** When an option resolves through
 * `controlForPath` — which is exactly the case here, since a destination IS a parameter
 * address — it is drawn as "filter cutoff" rather than
 * `voice.filterEnvelope.baseFrequency`, and grouped under its section. No prop asks for
 * that: an enum whose values are addresses should speak the vocabulary addresses already
 * have, or the bay becomes the one screen that calls the cutoff something else.
 *
 * **And it says which targets do nothing.** Eighteen of the thirty-one are declared,
 * validated, journalled, replayed and connected to no audio node. A picker that listed
 * them identically to the thirteen that work would be a wall of decoys — the specific
 * thing this stage exists to avoid.
 */

import { controlForPath, fullNameOf } from '../../../core/controls';
import { sectionFor } from '../../../core/groups';
import { isDestinationWired, type ModDestination, type ParamPath } from '../../../core/types';
import { optionLabel } from './glyphs';
import { COLOR, FONT, TOUCH_MIN } from '../tokens';
import { sagAttributes, type ControlProps } from './types';

/** The name for one option, in the vocabulary the rest of the surface uses. */
function describeOption(option: string): string {
  const control = controlForPath(option as ParamPath);
  // Not an address — a wave, a filter type, an LFO shape. The glyph comes with it, because
  // a list has room for the picture AND the word.
  if (control === undefined) return optionLabel(option);

  const name = fullNameOf(control);
  return isDestinationWired(option as ModDestination) ? name : `${name} — not wired`;
}

/** Which optgroup an option belongs under, or undefined when it is not an address. */
function groupOf(option: string): string | undefined {
  return sectionFor(option as ParamPath)?.label;
}

export function Select({
  id,
  path,
  label,
  spec,
  value,
  onChange,
  state = 'live',
  reason,
}: ControlProps) {
  if (spec.kind !== 'enum') {
    throw new Error(`Select drew "${path}", which is a ${spec.kind}. Widget choice is declared.`);
  }

  // Grouped in declared order, so the list reads down the signal path rather than
  // alphabetically — the same ordering `SIGNAL_CHAIN` gives every other surface.
  const groups = new Map<string, string[]>();
  for (const option of spec.values) {
    const group = groupOf(option) ?? '';
    groups.set(group, [...(groups.get(group) ?? []), option]);
  }

  const tint = state === 'ignored' ? COLOR.ignored : COLOR.accent;
  const current = typeof value === 'string' ? value : '';
  const unwiredChoice =
    controlForPath(current as ParamPath) !== undefined &&
    !isDestinationWired(current as ModDestination);

  return (
    <div {...sagAttributes({ id, path })} style={styles.wrap}>
      <span style={styles.label}>{label}</span>
      <select
        value={current}
        aria-label={label}
        onChange={(event) => onChange(path, event.target.value)}
        style={{ ...styles.select, borderColor: unwiredChoice ? COLOR.unwired : COLOR.border }}
      >
        {[...groups].map(([group, options]) =>
          group === '' ? (
            options.map((option) => (
              <option key={option} value={option}>
                {describeOption(option)}
              </option>
            ))
          ) : (
            <optgroup key={group} label={group}>
              {options.map((option) => (
                <option key={option} value={option}>
                  {describeOption(option)}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </select>
      {/* Said again under the closed picker, because the "— not wired" suffix is only
          visible while the list is open and this is the state that must not be missable. */}
      {unwiredChoice && <span style={styles.unwired}>reaches no audio node yet</span>}
      {state === 'ignored' && reason !== undefined && (
        <span style={{ ...styles.unwired, color: tint }}>{reason}</span>
      )}
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
    marginBottom: '0.2rem',
  },
  select: {
    width: '100%',
    minHeight: TOUCH_MIN,
    padding: '0 0.5rem',
    background: COLOR.surfaceHigh,
    color: COLOR.text,
    borderStyle: 'solid',
    borderWidth: 1,
    borderRadius: 4,
    fontFamily: FONT.mono,
    fontSize: '0.8rem',
  },
  unwired: {
    display: 'block',
    marginTop: '0.15rem',
    fontFamily: FONT.display,
    fontSize: '0.6rem',
    color: COLOR.unwired,
  },
} as const satisfies Record<string, React.CSSProperties>;
