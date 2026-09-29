/**
 * src/clients/synth/controls/RateControl.tsx — an LFO rate, which is two things.
 *
 * `voice.lfos.N.frequency` holds either a number of hertz or a transport subdivision, and
 * the value's own type says which. So does this control: a number draws a knob with a way
 * to lock it to the tempo, a string draws the note-length picker with a way back to hertz.
 *
 * Until cycle 2 C3 the subdivision side was refused: a subdivision meant nothing without a
 * transport, the runtime ran it at 1 Hz, and a picker would have been a control that made
 * the wrong sound. C3 locks such an LFO to the transport (`Tone.LFO.sync()`), so the picker
 * exists now — with the one sentence a player needs: it moves while the sequencer plays.
 */

import { formatValue, fromTrack, stepOf, subdivisionLabel, toTrack } from '../../../core/scale';
import { COLOR, FONT, TOUCH_MIN } from '../tokens';
import { Knob } from './Knob';
import { sagAttributes, type ControlProps } from './types';

/** What "lock to tempo" picks first: the psytrance rolling-bass rate. */
const FIRST_SUBDIVISION = '16n';

export function RateControl(props: ControlProps) {
  const { id, path, label, spec, value, onChange } = props;

  if (spec.kind !== 'frequency') {
    throw new Error(`RateControl drew "${path}", which is a ${spec.kind}. Widget choice is declared.`);
  }

  // The Hz half, expressed as a number spec so the knob and the shared scaling need no
  // special case. The bounds come from the contract, not from here.
  const asNumber = { kind: 'number', min: spec.min, max: spec.max, unit: spec.unit } as const;

  if (typeof value === 'string') {
    return (
      <div style={styles.wrap}>
        <span style={styles.label}>{label}</span>
        <select
          {...sagAttributes({ id, path })}
          value={value}
          aria-label={`${label}: note length`}
          onChange={(event) => onChange(path, event.target.value)}
          style={styles.select}
        >
          {/* A stored value outside the list (a triplet from an imported patch) is still
              drawn as itself rather than silently shown as the first option. */}
          {(spec.subdivisions.includes(value) ? spec.subdivisions : [value, ...spec.subdivisions]).map(
            (subdivision) => (
              <option key={subdivision} value={subdivision}>
                {subdivisionLabel(subdivision)}
              </option>
            ),
          )}
        </select>
        <span style={styles.note}>locked to the sequencer — moves while it plays</span>
        <button
          type="button"
          onClick={() => onChange(path, 1)}
          style={styles.switch}
          aria-label={`${label}: switch to hertz`}
        >
          use Hz
        </button>
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <Knob {...props} spec={asNumber} value={typeof value === 'number' ? value : 1} />
      <button
        type="button"
        onClick={() => onChange(path, FIRST_SUBDIVISION)}
        style={styles.switch}
        aria-label={`${label}: lock to tempo`}
      >
        tempo
      </button>
    </div>
  );
}

/** Re-exported so the kit's scaling helpers are visibly the ones in use. */
export const rateHelpers = { formatValue, fromTrack, stepOf, toTrack };

const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.2rem',
    maxWidth: 120,
  },
  label: {
    fontFamily: FONT.display,
    fontSize: '0.65rem',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: COLOR.textDim,
  },
  select: {
    minHeight: TOUCH_MIN,
    minWidth: 96,
    padding: '0 0.4rem',
    background: COLOR.surfaceHigh,
    color: COLOR.accent,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 4,
    fontFamily: FONT.mono,
    fontSize: '0.8rem',
  },
  note: {
    fontFamily: FONT.display,
    fontSize: '0.6rem',
    color: COLOR.textDim,
    textAlign: 'center',
  },
  switch: {
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: '0 0.6rem',
    background: 'transparent',
    color: COLOR.text,
    borderColor: COLOR.border,
    borderStyle: 'solid',
    borderWidth: 1,
    borderRadius: 4,
    fontFamily: FONT.display,
    fontSize: '0.7rem',
    cursor: 'pointer',
  },
} as const satisfies Record<string, React.CSSProperties>;
