/**
 * src/clients/synth/controls/RateControl.tsx — an LFO rate, which is two things.
 *
 * `voice.lfos.N.frequency` holds either a number of hertz or a transport subdivision, and
 * the value's own type says which. So does this control: a number draws a knob, a string
 * draws the subdivision it is set to.
 *
 * **The subdivision side is not offered, and that is deliberate.** `syncLfos` reports
 * `lfo.syncedFrequency` and falls back to 1 Hz, because a subdivision means nothing
 * without a transport and v0.1.0 drives none. Drawing a picker for it would be building a
 * control that validates, journals, replays and makes the wrong sound — so a patch that
 * already carries one is shown, told the truth, and given a way back to hertz.
 *
 * When the transport lands at v0.3.0 this grows a picker from
 * `spec.subdivisions` and the note comes out. Nothing else changes.
 */

import { formatValue, fromTrack, stepOf, toTrack } from '../../../core/scale';
import { COLOR, FONT, TOUCH_MIN } from '../tokens';
import { Knob } from './Knob';
import { sagAttributes, type ControlProps } from './types';

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
      <div {...sagAttributes({ id, path })} style={styles.wrap}>
        <span style={styles.label}>{label}</span>
        <span style={styles.synced}>{value}</span>
        <span style={styles.reason}>
          synced rates need a transport — this LFO is running at 1 Hz
        </span>
        <button
          type="button"
          onClick={() => onChange(path, 1)}
          style={styles.revert}
          aria-label={`${label}: switch to hertz`}
        >
          use Hz
        </button>
      </div>
    );
  }

  return <Knob {...props} spec={asNumber} value={typeof value === 'number' ? value : 1} />;
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
  synced: { fontFamily: FONT.mono, fontSize: '1rem', color: COLOR.ignored },
  reason: {
    fontFamily: FONT.display,
    fontSize: '0.6rem',
    color: COLOR.ignored,
    textAlign: 'center',
  },
  revert: {
    minHeight: TOUCH_MIN,
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
