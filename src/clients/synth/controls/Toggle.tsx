/**
 * src/clients/synth/controls/Toggle.tsx — the boolean.
 *
 * Wording is the caller's, because the same `boolean` means "on" on an oscillator slot and
 * "active / bypass" on an effect card, and those are different promises to a player. The
 * default is the plain one; the FX cards pass their own.
 */

import { COLOR, FONT, TOUCH_MIN } from '../tokens';
import { sagAttributes, type ControlProps } from './types';

export interface ToggleProps extends ControlProps {
  /** Defaults to on / off. Effects pass ACTIVE / BYPASS. */
  wording?: readonly [on: string, off: string];
}

export function Toggle({
  id,
  path,
  label,
  spec,
  value,
  onChange,
  state = 'live',
  reason,
  wording = ['on', 'off'],
}: ToggleProps) {
  if (spec.kind !== 'boolean') {
    throw new Error(`Toggle drew "${path}", which is a ${spec.kind}. Widget choice is declared.`);
  }

  const on = value === true;
  const tint = state === 'ignored' ? COLOR.ignored : COLOR.accent;

  return (
    <div {...sagAttributes({ id, path })} style={styles.wrap}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(path, !on)}
        style={{
          ...styles.button,
          background: on ? tint : 'transparent',
          color: on ? COLOR.surfaceLowest : COLOR.textDim,
          borderColor: on ? tint : COLOR.border,
        }}
      >
        <span style={styles.name}>{label}</span>
        <span style={styles.state}>{on ? wording[0] : wording[1]}</span>
      </button>
      {state === 'ignored' && reason !== undefined && <span style={styles.reason}>{reason}</span>}
    </div>
  );
}

const styles = {
  wrap: { display: 'block' },
  button: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
    width: '100%',
    minHeight: TOUCH_MIN,
    padding: '0 0.7rem',
    borderRadius: 4,
    borderStyle: 'solid',
    borderWidth: 1,
    cursor: 'pointer',
  },
  name: {
    fontFamily: FONT.display,
    fontSize: '0.7rem',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  state: { fontFamily: FONT.mono, fontSize: '0.65rem', opacity: 0.85 },
  reason: { fontFamily: FONT.display, fontSize: '0.6rem', color: COLOR.ignored },
} as const satisfies Record<string, React.CSSProperties>;
