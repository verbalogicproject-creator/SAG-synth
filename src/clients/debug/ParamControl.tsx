/**
 * src/clients/debug/ParamControl.tsx — one control, generated from a parameter's spec.
 *
 * Deliberately generic rather than hand-built per parameter. `PARAM_SPECS` already
 * carries kind, range, unit, integer-ness and legal choices for all 70 declared paths,
 * so a control wall is a loop, not a design exercise — and a hand-built control is free
 * to disagree with the validator, which a generated one cannot.
 *
 * Every change dispatches `setParam`. Nothing here touches the audio graph, so a knob
 * turn is journalled, replayable and undoable exactly like any other edit, and the v0.2
 * SDK moves the same knob by dispatching the same command.
 */

import { formatValue, fromTrack, toTrack } from '../../core/scale';
import type { ParamSpec } from '../../core/schemas';
import type { ParamPath, ParamValue } from '../../core/types';

export interface ParamControlProps {
  path: ParamPath;
  label: string;
  spec: ParamSpec;
  value: ParamValue | undefined;
  onChange: (path: ParamPath, value: ParamValue) => void;
}

/** Track positions. The scaling itself lives in core/scale, shared with the kit. */
const SLIDER_STEPS = 500;

export function ParamControl({ path, label, spec, value, onChange }: ParamControlProps) {
  if (spec.kind === 'boolean') {
    return (
      <label style={styles.row}>
        <span style={styles.label}>{label}</span>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(path, event.target.checked)}
          style={styles.checkbox}
        />
      </label>
    );
  }

  if (spec.kind === 'enum') {
    return (
      <label style={styles.row}>
        <span style={styles.label}>{label}</span>
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(path, event.target.value)}
          style={styles.select}
        >
          {spec.values.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (spec.kind === 'frequency') {
    // number | string (Hz or a Tone subdivision). Left as free text until the LFO
    // section lands and can justify a proper sync/free toggle.
    return (
      <label style={styles.row}>
        <span style={styles.label}>{label}</span>
        <input
          type="text"
          value={value === undefined ? '' : String(value)}
          onChange={(event) => {
            const raw = event.target.value;
            const asNumber = Number(raw);
            onChange(path, raw !== '' && Number.isFinite(asNumber) ? asNumber : raw);
          }}
          style={styles.text}
        />
      </label>
    );
  }

  const current = typeof value === 'number' ? value : spec.min;

  // A restricted numeric parameter is a set of buttons, never a slider. `rolloff` has
  // exactly four legal slopes; a slider would generate values the validator rejects and
  // the audio graph has no behaviour for.
  if (spec.choices !== undefined) {
    return (
      <div style={styles.row}>
        <span style={styles.label}>{label}</span>
        <div style={styles.choices}>
          {spec.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => onChange(path, choice)}
              style={{
                ...styles.choice,
                background: choice === current ? '#6aa9ff' : 'transparent',
                color: choice === current ? '#0d0d10' : 'inherit',
              }}
            >
              {choice}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.row}>
      <span style={styles.label}>
        {label}
        <span style={styles.value}>{formatValue(current, spec)}</span>
      </span>
      <input
        type="range"
        min={0}
        max={SLIDER_STEPS}
        step={1}
        value={toTrack(current, spec) * SLIDER_STEPS}
        onChange={(event) => onChange(path, fromTrack(Number(event.target.value) / SLIDER_STEPS, spec))}
        style={styles.slider}
      />
    </div>
  );
}

const styles = {
  row: { display: 'block', margin: '0 0 0.85rem' },
  label: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.75rem',
    opacity: 0.75,
    marginBottom: '0.3rem',
  },
  value: { opacity: 0.9, fontVariantNumeric: 'tabular-nums' },
  // Tall enough to hit with a fingertip; the browser default is a ~4px target.
  slider: { width: '100%', height: '2rem', touchAction: 'none' },
  select: { width: '100%', padding: '0.6rem', fontFamily: 'inherit', fontSize: '0.9rem' },
  text: { width: '100%', padding: '0.6rem', fontFamily: 'inherit', fontSize: '0.9rem' },
  checkbox: { width: '1.5rem', height: '1.5rem' },
  choices: { display: 'flex', gap: '0.4rem' },
  choice: { flex: '1 1 0', padding: '0.6rem 0.2rem', fontSize: '0.8rem', cursor: 'pointer' },
} as const satisfies Record<string, React.CSSProperties>;
