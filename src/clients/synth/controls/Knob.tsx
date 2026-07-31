/**
 * src/clients/synth/controls/Knob.tsx — the continuous control.
 *
 * Vertical drag, because a knob on a phone has no rotation a thumb can follow and every
 * hardware editor that tried circular dragging abandoned it. Full travel is one screen
 * height of movement; a second finger anywhere on the screen divides the rate by five, so
 * a fine adjustment needs no modifier key a phone does not have.
 *
 * Range, step, discreteness and log-versus-linear all come from the spec through
 * `src/core/scale.ts`. This file contains no number that describes a parameter — only
 * numbers that describe a gesture and an arc.
 */

import { useCallback, useRef, useState } from 'react';
import { formatValue, fromTrack, stepOf, toTrack } from '../../../core/scale';
import { COLOR, FONT, TOUCH_MIN } from '../tokens';
import { ModRing } from './ModRing';
import { sagAttributes, type ControlProps } from './types';

/** Pixels of vertical travel for the full range. About a thumb's comfortable sweep. */
const TRAVEL_PX = 220;
/** How much a second finger slows the drag. */
const FINE_DIVISOR = 5;

const SIZE = 64;
const RADIUS = 26;
/** The arc runs from 7 o'clock to 5 o'clock, the gap at the bottom reading as "off". */
const START_ANGLE = 135;
const SWEEP = 270;

function polar(fraction: number): { x: number; y: number } {
  const angle = ((START_ANGLE + fraction * SWEEP) * Math.PI) / 180;
  return { x: SIZE / 2 + RADIUS * Math.cos(angle), y: SIZE / 2 + RADIUS * Math.sin(angle) };
}

function arc(from: number, to: number): string {
  const a = polar(from);
  const b = polar(to);
  const large = (to - from) * SWEEP > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${b.x} ${b.y}`;
}

export function Knob({
  id,
  path,
  label,
  spec,
  value,
  onChange,
  state = 'live',
  reason,
  modulation,
}: ControlProps) {
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ pointer: number; startY: number; startTrack: number } | null>(null);
  const extraPointers = useRef(new Set<number>());

  if (spec.kind !== 'number') {
    throw new Error(`Knob drew "${path}", which is a ${spec.kind}. Widget choice is declared.`);
  }

  const current = typeof value === 'number' ? value : spec.min;
  const track = toTrack(current, spec);

  const commit = useCallback(
    (nextTrack: number) => onChange(path, fromTrack(nextTrack, spec)),
    [onChange, path, spec],
  );

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (gesture.current !== null) {
      // A second finger is the fine-drag modifier, not a second grab.
      extraPointers.current.add(event.pointerId);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, startY: event.clientY, startTrack: track };
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const active = gesture.current;
    if (active === null || event.pointerId !== active.pointer) return;

    const divisor = extraPointers.current.size > 0 ? FINE_DIVISOR : 1;
    // Up is more, which is the only direction anyone expects.
    const delta = (active.startY - event.clientY) / (TRAVEL_PX * divisor);
    commit(Math.min(Math.max(active.startTrack + delta, 0), 1));
  };

  const endGesture = (event: React.PointerEvent<SVGSVGElement>) => {
    extraPointers.current.delete(event.pointerId);
    if (gesture.current?.pointer !== event.pointerId) return;
    gesture.current = null;
    extraPointers.current.clear();
    setDragging(false);
  };

  const nudge = (event: React.KeyboardEvent<SVGSVGElement>) => {
    const step = stepOf(spec);
    const direction =
      event.key === 'ArrowUp' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    if (direction === 0) return;
    event.preventDefault();
    onChange(path, Math.min(Math.max(current + direction * step, spec.min), spec.max));
  };

  const tint = state === 'ignored' ? COLOR.ignored : COLOR.accent;

  return (
    <div {...sagAttributes({ id, path })} style={styles.wrap}>
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuenow={current}
        aria-valuetext={formatValue(current, spec)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onKeyDown={nudge}
        style={{ ...styles.dial, cursor: dragging ? 'grabbing' : 'grab' }}
      >
        <path d={arc(0, 1)} stroke={COLOR.accentDim} strokeWidth={3} fill="none" strokeLinecap="round" />
        {track > 0 && (
          <path d={arc(0, track)} stroke={tint} strokeWidth={3} fill="none" strokeLinecap="round" />
        )}
        {modulation !== undefined && <ModRing track={track} reach={modulation} size={SIZE} />}
        <line
          x1={SIZE / 2}
          y1={SIZE / 2}
          x2={polar(track).x}
          y2={polar(track).y}
          stroke={tint}
          strokeWidth={2}
          strokeLinecap="round"
          opacity={0.8}
        />
      </svg>

      <span style={styles.label}>{label}</span>
      <span style={{ ...styles.value, color: tint }}>{formatValue(current, spec)}</span>
      {state === 'ignored' && reason !== undefined && <span style={styles.reason}>{reason}</span>}
    </div>
  );
}

const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.15rem',
    minWidth: TOUCH_MIN,
  },
  // touchAction none or the browser scrolls the page instead of turning the knob.
  dial: { touchAction: 'none', outlineOffset: 2 },
  label: {
    fontFamily: FONT.display,
    fontSize: '0.65rem',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: COLOR.textDim,
  },
  value: { fontFamily: FONT.mono, fontSize: '0.7rem', fontVariantNumeric: 'tabular-nums' },
  reason: {
    fontFamily: FONT.display,
    fontSize: '0.6rem',
    color: COLOR.ignored,
    textAlign: 'center',
    maxWidth: 92,
  },
} as const satisfies Record<string, React.CSSProperties>;
