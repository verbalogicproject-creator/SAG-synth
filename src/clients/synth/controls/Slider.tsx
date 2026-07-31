/**
 * src/clients/synth/controls/Slider.tsx — the same parameter, read as a position.
 *
 * For the eight envelope stages, the five EQ bands and the master fader, where a row of
 * knobs draws neither a shape nor a curve. Identical contract to `Knob` and identical
 * scaling — the two differ in how they are read, never in what they can produce.
 *
 * A native `<input type="range">` rather than a hand-built track: it is keyboard
 * accessible, screen-reader accessible and thumb-draggable for free, and the only thing
 * wrong with it by default is a 4px hit target, which the styling below fixes.
 */

import { formatValue, fromTrack, toTrack } from '../../../core/scale';
import { COLOR, FONT, TOUCH_MIN } from '../tokens';
import { sagAttributes, type ControlProps } from './types';

/** Positions along the track. Fine enough that a drag feels continuous. */
const RESOLUTION = 1000;

export function Slider({
  id,
  path,
  label,
  spec,
  value,
  onChange,
  state = 'live',
  reason,
}: ControlProps) {
  if (spec.kind !== 'number') {
    throw new Error(`Slider drew "${path}", which is a ${spec.kind}. Widget choice is declared.`);
  }

  const current = typeof value === 'number' ? value : spec.min;
  const tint = state === 'ignored' ? COLOR.ignored : COLOR.accent;

  return (
    <div {...sagAttributes({ id, path })} style={styles.wrap}>
      <div style={styles.head}>
        <span style={styles.label}>{label}</span>
        <span style={{ ...styles.value, color: tint }}>{formatValue(current, spec)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={RESOLUTION}
        step={1}
        value={Math.round(toTrack(current, spec) * RESOLUTION)}
        aria-label={label}
        aria-valuetext={formatValue(current, spec)}
        onChange={(event) => onChange(path, fromTrack(Number(event.target.value) / RESOLUTION, spec))}
        style={{ ...styles.track, accentColor: tint }}
      />
      {state === 'ignored' && reason !== undefined && <span style={styles.reason}>{reason}</span>}
    </div>
  );
}

const styles = {
  wrap: { display: 'block', width: '100%' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  label: {
    fontFamily: FONT.display,
    fontSize: '0.65rem',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: COLOR.textDim,
  },
  value: { fontFamily: FONT.mono, fontSize: '0.7rem', fontVariantNumeric: 'tabular-nums' },
  // Tall enough to hit with a fingertip, and touchAction none so a drag turns the control
  // instead of scrolling the tab underneath it.
  track: { width: '100%', height: TOUCH_MIN / 2, touchAction: 'none' },
  reason: { fontFamily: FONT.display, fontSize: '0.6rem', color: COLOR.ignored },
} as const satisfies Record<string, React.CSSProperties>;
