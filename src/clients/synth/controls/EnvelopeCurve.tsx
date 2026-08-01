/**
 * src/clients/synth/controls/EnvelopeCurve.tsx — the shape four sliders are making, and now
 * three handles that make it directly.
 *
 * **The curve still renders from the values.** That was the design-cycle decision and it
 * survives dragging intact: a handle dispatches the identical `setParam` the slider beneath
 * it dispatches, then the curve redraws from the patch like it always did. There is no
 * second source of truth about an envelope, which is the only reason this was safe to add.
 *
 * **A handle is not a point on the path.** It looks like one, and treating it as one is the
 * trap: the three times share the width in proportion to each other
 * (`part / total * budget`), so moving one breakpoint's x moves every other breakpoint too.
 * Dragging the path would mean solving for a value that produces a requested pixel, with a
 * different answer depending on the other three. So each handle is a HANDLE FOR ITS OWN
 * PARAMETER, using `Knob`'s gesture: screen-pixel travel from where the finger went down,
 * added to the track position the value had at that moment, committed through `fromTrack`.
 *
 * Screen pixels rather than SVG units on purpose. The svg is `preserveAspectRatio="none"`,
 * so x is stretched to the rendered width while y is not — a delta in user units would mean
 * two different things on the two axes. Finger travel is the honest unit for a gesture.
 *
 * The handles are HTML over the svg, not `<circle>` inside it, for the same practical
 * reason `Slider`'s track is `TOUCH_MIN` tall: a 44px target does not fit inside a 64px-tall
 * viewBox without being clipped at the edges. Positioned by percentage, so they track the
 * curve at any width.
 *
 * Times are drawn on a shared scale derived from the specs rather than assumed: an envelope
 * whose attack can reach 20 s and one capped at 2 s should not draw the same picture for
 * the same number.
 */

import { useRef } from 'react';
import { fromTrack, stepOf, toTrack } from '../../../core/scale';
import { PARAM_SPECS } from '../../../core/schemas';
import type { ParamPath, ParamValue } from '../../../core/types';
import { COLOR, FONT, TOUCH_MIN } from '../tokens';

const WIDTH = 240;
const HEIGHT = 64;
const PAD = 4;

/**
 * Screen pixels of travel for a handle's full range, matching `Knob`'s TRAVEL_PX so the
 * two gestures feel like the same instrument.
 */
const TRAVEL_PX = 220;

/** Any second pointer is a fine-adjust modifier, again as `Knob` does it. */
const FINE_DIVISOR = 5;

export interface EnvelopeCurveProps {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** Longest a single stage can be, from the spec. Sets the horizontal scale. */
  maxStage: number;
  /** Amber when the envelope is drawn for a control the current shape ignores. */
  dimmed?: boolean;
  label?: string;
  /**
   * attack, decay, sustain, release — in that order. Present means draggable; absent means
   * the curve is the display-only picture it has always been.
   */
  stages?: readonly [ParamPath, ParamPath, ParamPath, ParamPath];
  onChange?: (path: ParamPath, value: ParamValue) => void;
}

/** One drag: which pointer, where it went down, and the track each axis started from. */
interface Gesture {
  pointer: number;
  startX: number;
  startY: number;
  x?: { path: ParamPath; track: number };
  y?: { path: ParamPath; track: number };
}

export function EnvelopeCurve({
  attack,
  decay,
  sustain,
  release,
  maxStage,
  dimmed = false,
  label = 'envelope',
  stages,
  onChange,
}: EnvelopeCurveProps) {
  const inner = WIDTH - PAD * 2;
  const floor = HEIGHT - PAD;
  const ceiling = PAD;

  // Sustain is a LEVEL and has no duration, so it gets a fixed quarter of the width. The
  // three real times share the rest in proportion to how much of their range they use —
  // a decay at 10% of its maximum draws a tenth of the time budget whatever that maximum
  // happens to be.
  const held = inner * 0.25;
  const budget = inner - held;
  const fractions = [attack, decay, release].map((seconds) =>
    maxStage <= 0 ? 0 : Math.min(Math.max(seconds / maxStage, 0), 1),
  );
  const total = fractions.reduce((sum, part) => sum + part, 0);
  // An all-zero envelope is a legitimate patch (a click), so share the width evenly rather
  // than dividing by zero and drawing nothing.
  const scaled = fractions.map((part) => (total === 0 ? budget / 3 : (part / total) * budget));

  const level = Math.min(Math.max(sustain, 0), 1);
  const sustainY = floor - (floor - ceiling) * level;

  const x0 = PAD;
  const x1 = x0 + (scaled[0] ?? 0);
  const x2 = x1 + (scaled[1] ?? 0);
  const x3 = x2 + held;
  const x4 = x3 + (scaled[2] ?? 0);

  const path = `M ${x0} ${floor} L ${x1} ${ceiling} L ${x2} ${sustainY} L ${x3} ${sustainY} L ${x4} ${floor}`;
  const tint = dimmed ? COLOR.ignored : COLOR.accent;

  const gesture = useRef<Gesture | null>(null);
  const extraPointers = useRef(new Set<number>());

  /** The current value of a stage path, as a 0..1 track position. */
  const trackOf = (path: ParamPath, value: number): number => {
    const spec = PARAM_SPECS[path];
    return spec.kind === 'number' ? toTrack(value, spec) : 0;
  };

  const commit = (path: ParamPath, track: number) => {
    const spec = PARAM_SPECS[path];
    if (spec.kind !== 'number' || onChange === undefined) return;
    onChange(path, fromTrack(Math.min(Math.max(track, 0), 1), spec));
  };

  /**
   * The three handles, each named by what it actually changes rather than by where it sits.
   *
   * The decay handle owns two parameters because the corner it sits on IS two parameters:
   * how long the fall takes, and how far it falls to. Every DAW draws that corner once.
   */
  const handles =
    stages === undefined
      ? []
      : [
          { key: 'attack', cx: x1, cy: ceiling, x: stages[0], value: attack },
          { key: 'decay', cx: x2, cy: sustainY, x: stages[1], value: decay, y: stages[2], yValue: sustain },
          { key: 'release', cx: x4, cy: floor, x: stages[3], value: release },
        ];

  const onPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    handle: (typeof handles)[number],
  ) => {
    if (gesture.current !== null) {
      // A second finger is the fine-adjust modifier, not a second grab.
      extraPointers.current.add(event.pointerId);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: { path: handle.x, track: trackOf(handle.x, handle.value) },
      ...(handle.y === undefined
        ? {}
        : { y: { path: handle.y, track: trackOf(handle.y, handle.yValue ?? 0) } }),
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (active === null || event.pointerId !== active.pointer) return;
    const divisor = extraPointers.current.size > 0 ? FINE_DIVISOR : 1;

    if (active.x !== undefined) {
      const delta = (event.clientX - active.startX) / (TRAVEL_PX * divisor);
      commit(active.x.path, active.x.track + delta);
    }
    if (active.y !== undefined) {
      // Up is more, which is the direction the curve draws it.
      const delta = (active.startY - event.clientY) / (TRAVEL_PX * divisor);
      commit(active.y.path, active.y.track + delta);
    }
  };

  const endGesture = (event: React.PointerEvent<HTMLButtonElement>) => {
    extraPointers.current.delete(event.pointerId);
    const active = gesture.current;
    if (active === null || event.pointerId !== active.pointer) return;
    gesture.current = null;
    extraPointers.current.clear();
  };

  /** Arrow keys, because a drag target with no keyboard is not a control. */
  const onKeyDown = (event: React.KeyboardEvent, handle: (typeof handles)[number]) => {
    const horizontal = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const vertical = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
    if (horizontal === 0 && vertical === 0) return;
    event.preventDefault();

    if (horizontal !== 0) {
      const spec = PARAM_SPECS[handle.x];
      if (spec.kind === 'number') commit(handle.x, trackOf(handle.x, handle.value) + horizontal * stepOf(spec) / (spec.max - spec.min || 1));
    }
    if (vertical !== 0 && handle.y !== undefined) {
      const spec = PARAM_SPECS[handle.y];
      if (spec.kind === 'number') {
        commit(handle.y, trackOf(handle.y, handle.yValue ?? 0) + vertical * stepOf(spec) / (spec.max - spec.min || 1));
      }
    }
  };

  return (
    <div style={styles.frame}>
      <svg
        width="100%"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: attack ${attack}s, decay ${decay}s, sustain ${level}, release ${release}s`}
        style={styles.svg}
      >
        <rect x={0} y={0} width={WIDTH} height={HEIGHT} fill={COLOR.surfaceLowest} rx={4} />
        {/* The sustain level, so the flat segment reads as a height and not just a line. */}
        <line
          x1={0}
          y1={sustainY}
          x2={WIDTH}
          y2={sustainY}
          stroke={COLOR.border}
          strokeWidth={1}
          strokeDasharray="2 4"
        />
        <path d={`${path} L ${x4} ${floor} L ${x0} ${floor} Z`} fill={tint} opacity={0.12} />
        <path d={path} stroke={tint} strokeWidth={2} fill="none" strokeLinejoin="round" />
      </svg>

      {handles.map((handle) => (
        <button
          key={handle.key}
          type="button"
          role="slider"
          aria-label={`${label} ${handle.key}`}
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={trackOf(handle.x, handle.value)}
          onPointerDown={(event) => onPointerDown(event, handle)}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          onKeyDown={(event) => onKeyDown(event, handle)}
          style={{
            ...styles.handle,
            left: `${(handle.cx / WIDTH) * 100}%`,
            top: `${(handle.cy / HEIGHT) * 100}%`,
          }}
        >
          <span style={{ ...styles.dot, background: tint }} />
        </button>
      ))}
    </div>
  );
}

const styles = {
  frame: { position: 'relative', width: '100%' },
  svg: { display: 'block', width: '100%', height: HEIGHT, fontFamily: FONT.mono },
  /**
   * TOUCH_MIN square and centred on the breakpoint. Transparent, because the visible dot
   * is the child — the target is deliberately much bigger than the thing it draws, which
   * is the whole point of it being an HTML overlay rather than an SVG circle.
   */
  handle: {
    position: 'absolute',
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    transform: 'translate(-50%, -50%)',
    padding: 0,
    background: 'transparent',
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    touchAction: 'none',
    cursor: 'grab',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    boxShadow: `0 0 0 2px ${COLOR.surfaceLowest}`,
  },
} as const satisfies Record<string, React.CSSProperties>;
