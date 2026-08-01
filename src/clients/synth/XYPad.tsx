/**
 * src/clients/synth/XYPad.tsx — the touch surface that replaces the keyboard.
 *
 * A piano key gives you twelve fixed positions; this pad gives you the same octave with
 * no positions at all. X is continuous pitch — the nearest semitone plus the REMAINDER
 * between it and its neighbour, reported as a detune in cents, so a press that lands
 * between two keys sounds between two keys instead of snapping to one of them. Y drives
 * one chosen parameter, top is `spec.max` and bottom is `spec.min`, read from
 * `PARAM_SPECS` through `fromTrack` exactly as `Knob` does — this file states no number
 * that describes a parameter, only numbers that describe the gesture and the geometry.
 *
 * The piano keys underneath are `VirtualKeyboard`'s own geometry, drawn at reduced
 * opacity and `pointerEvents: 'none'` — a pitch reference a thumb can read, not a second
 * set of buttons fighting the pad for the same touch.
 */

import { useCallback, useRef } from 'react';
import { fromTrack, formatValue } from '../../core/scale';
import { PARAM_SPECS } from '../../core/schemas';
import type { ParamPath } from '../../core/types';
import { BLACK_KEYS, WHITE_KEYS, pitchAtFraction } from '../debug/keyboard';
import { COLOR, FONT } from './tokens';

export interface XYPadProps {
  /** Lowest octave shown, same meaning as VirtualKeyboard's `octave`. */
  octave: number;
  /** Parameter the Y axis drives. Caller guarantees it is a number spec. */
  yTarget: ParamPath;
  /** Current value of yTarget, for the readout. */
  yValue: number;
  /** Fires on press and on every move while held. */
  onPitch: (note: string, detuneCents: number, velocity: number) => void;
  /** Fires on release. */
  onRelease: (note: string) => void;
  /** Y axis, dispatched as a normal parameter edit. */
  onChange: (path: ParamPath, value: number) => void;
}

/**
 * Velocity is wrong to derive from Y here — Y already drives the chosen parameter. A
 * constant stands in until the caller owns velocity some other way (a third axis, a
 * pressure-sensitive pointer, whatever v0.2 decides).
 */
const CONSTANT_VELOCITY = 0.8;

/** Reference-only opacity for the keys drawn underneath the pad. */
const KEY_REFERENCE_OPACITY = 0.45;

const WHITE_COUNT = WHITE_KEYS.length;
const WHITE_WIDTH_PCT = 100 / WHITE_COUNT;
const BLACK_WIDTH_PCT = WHITE_WIDTH_PCT * 0.62;

export function XYPad({ octave, yTarget, yValue, onPitch, onRelease, onChange }: XYPadProps) {
  const spec = PARAM_SPECS[yTarget];
  if (spec.kind !== 'number') {
    throw new Error(`XYPad's Y axis was pointed at "${yTarget}", which is a ${spec.kind}.`);
  }

  const padRef = useRef<HTMLDivElement>(null);
  /** The pointer currently playing, and the note it last sounded — so a slide across the
   *  pad releases the note it actually started rather than whatever is under the finger
   *  when it lifts. */
  const gesture = useRef<{ pointerId: number; note: string } | null>(null);

  const play = useCallback(
    (clientX: number, clientY: number) => {
      const rect = padRef.current?.getBoundingClientRect();
      if (rect === undefined || rect.width === 0 || rect.height === 0) return;

      const fractionX = (clientX - rect.left) / rect.width;
      const fractionY = (clientY - rect.top) / rect.height;
      const { note, detuneCents } = pitchAtFraction(fractionX, octave);

      onPitch(note, detuneCents, CONSTANT_VELOCITY);
      // Top of the pad is the maximum: the track runs opposite to screen Y.
      const track = 1 - Math.min(Math.max(fractionY, 0), 1);
      onChange(yTarget, fromTrack(track, spec));

      return note;
    },
    [octave, onChange, onPitch, spec, yTarget],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.current !== null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const note = play(event.clientX, event.clientY);
    if (note === undefined) return;
    gesture.current = { pointerId: event.pointerId, note };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (active === null || event.pointerId !== active.pointerId) return;
    const note = play(event.clientX, event.clientY);
    if (note !== undefined) active.note = note;
  };

  const endGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (active === null || event.pointerId !== active.pointerId) return;
    gesture.current = null;
    onRelease(active.note);
  };

  return (
    <div data-sag-path={yTarget} style={styles.wrap}>
      <div
        ref={padRef}
        role="slider"
        aria-label={`${yTarget} pad`}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuenow={yValue}
        aria-valuetext={formatValue(yValue, spec)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        style={styles.pad}
      >
        <div style={styles.reference} aria-hidden="true">
          {WHITE_KEYS.map((_key, index) => (
            <div
              key={`w${index}`}
              style={{
                ...styles.white,
                left: `${index * WHITE_WIDTH_PCT}%`,
                width: `${WHITE_WIDTH_PCT}%`,
              }}
            />
          ))}
          {BLACK_KEYS.map((key, index) => (
            <div
              key={`b${index}`}
              style={{
                ...styles.black,
                left: `${(key.afterWhite + 1) * WHITE_WIDTH_PCT - BLACK_WIDTH_PCT / 2}%`,
                width: `${BLACK_WIDTH_PCT}%`,
              }}
            />
          ))}
        </div>
      </div>
      <span style={styles.value}>{formatValue(yValue, spec)}</span>
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100%' },
  pad: {
    position: 'relative',
    width: '100%',
    // Same height as VirtualKeyboard, which is what it replaces.
    height: '13rem',
    background: COLOR.surfaceLowest,
    border: `1px solid ${COLOR.border}`,
    borderRadius: '0.5rem',
    overflow: 'hidden',
    // Without this the browser claims the gesture for scrolling instead of playing.
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
    cursor: 'crosshair',
  },
  reference: {
    position: 'absolute',
    inset: 0,
    opacity: KEY_REFERENCE_OPACITY,
    pointerEvents: 'none',
  },
  white: {
    position: 'absolute',
    top: 0,
    height: '100%',
    background: COLOR.text,
    border: `1px solid ${COLOR.border}`,
  },
  black: {
    position: 'absolute',
    top: 0,
    height: '62%',
    background: COLOR.surfaceHigh,
    border: `1px solid ${COLOR.border}`,
    zIndex: 2,
  },
  value: {
    fontFamily: FONT.mono,
    fontSize: '0.7rem',
    fontVariantNumeric: 'tabular-nums',
    color: COLOR.accentText,
    alignSelf: 'flex-end',
  },
} as const satisfies Record<string, React.CSSProperties>;
