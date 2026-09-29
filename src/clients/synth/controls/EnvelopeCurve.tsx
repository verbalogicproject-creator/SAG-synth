/**
 * src/clients/synth/controls/EnvelopeCurve.tsx — the shape four sliders are making, and now
 * three handles that make it directly.
 *
 * **The curve still renders from the values.** That was the design-cycle decision and it
 * survives dragging intact: a handle dispatches the identical `setParam` the slider beneath
 * it dispatches, then the curve redraws from the patch like it always did. There is no
 * second source of truth about an envelope, which is the only reason this was safe to add.
 *
 * **Time is drawn on a fixed axis** (Eyal, 2026-09-18: "when i change decay it only controls
 * the decay"). The widths used to be shares of their TOTAL, so a longer decay squeezed the
 * attack and hold on screen even though the sound never changed. Now each stage's width is a
 * function of its own seconds and of the axis, never of another stage — see `stageWidth`.
 *
 * **A handle is not a point on the path.** It looks like one, and the axis is compressive
 * (a log knee), so a requested pixel maps to seconds non-linearly. So each handle is a
 * HANDLE FOR ITS OWN
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
 * The axis is derived from the ranges rather than assumed: an envelope whose attack can
 * reach 20 s and one set to 2 s should not draw the same picture for the same number.
 */

import { useRef } from 'react';
import { fromTrack, stepOf, toTrack } from '../../../core/scale';
import { PARAM_SPECS } from '../../../core/schemas';
import type { DecayCurve, ParamPath, ParamValue } from '../../../core/types';
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
  /**
   * The travel of each time stage in seconds — the spec's range, or the short range the
   * player picked. Sets both the drawn axis (a stage at its maximum fills its whole slot)
   * and how far a handle drag moves the value. Omitted stages use their spec's maximum.
   */
  ranges?: Partial<Record<TimeStage, number>>;
  /** Amber when the envelope is drawn for a control the current shape ignores. */
  dimmed?: boolean;
  label?: string;
  /**
   * attack, decay, sustain, release — in that order. Present means draggable; absent means
   * the curve is the display-only picture it has always been.
   */
  stages?: readonly [ParamPath, ParamPath, ParamPath, ParamPath];
  onChange?: (path: ParamPath, value: ParamValue) => void;
  /**
   * AHDSR (schema_version 5): the hold, drawn as a plateau at the peak between the attack and
   * the decay — on the SAME time scale as the other stages. The first version scaled it
   * against its own 0.5 s range, and the first screenshot showed a 30 ms hold drawn as most of
   * the width beside a 60 ms decay drawn as a sliver: two scales, one picture, a lie. One
   * axis for all four times now (`stageWidth`): the same seconds draw the same width.
   */
  hold?: number;
  /** Present means the hold is draggable, like `stages`. */
  holdPath?: ParamPath;
  /** The decay's shape, so the picture curves the way the sound does. */
  decayCurve?: DecayCurve;
}

export type TimeStage = 'attack' | 'hold' | 'decay' | 'release';

/**
 * The knee of the time axis, in seconds. Below it a stage draws nearly linearly; above it,
 * logarithmically. A psytrance pluck lives at 0–100 ms and a pad at seconds, on one editor,
 * and a linear axis that fits 2 s draws a 30 ms hold as one pixel. 5 ms keeps the click
 * region readable without flattening the long end.
 */
export const TIME_KNEE = 0.005;

/**
 * How wide a stage of `seconds` draws, in units of the axis scale. The whole point of the
 * function is its signature: it takes ONE stage's seconds and that stage's range, and
 * nothing about the other stages, so changing the decay cannot move the attack or the hold.
 * Monotonic, zero at zero, and the same for the same seconds in any stage.
 */
export function stageWidth(seconds: number, range: number): number {
  const clamped = Math.min(Math.max(seconds, 0), Math.max(range, 0));
  return Math.log1p(clamped / TIME_KNEE);
}

/** Samples along the decay segment, so a shaped decay draws as a curve and not a line. */
const DECAY_SAMPLES = 12;

/**
 * How far along its fall a decay is, 0 (peak) .. 1 (sustain), at fraction `x` of its time.
 * The drawing's approximation of what the runtime schedules: Tone's exponential approach
 * reaches ~99.5% of the way (then a short linear ramp closes it), `logarithmic` is
 * `1 − (1 − x^3)` from `core/ahdsr.ts`, linear is linear.
 */
function decayProgress(shape: DecayCurve, x: number): number {
  if (shape === 'linear') return x;
  if (shape === 'logarithmic') return Math.pow(x, 3);
  return 1 - Math.exp(-5.3 * x);
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
  ranges = {},
  dimmed = false,
  label = 'envelope',
  stages,
  onChange,
  hold = 0,
  holdPath,
  decayCurve = 'linear',
}: EnvelopeCurveProps) {
  const inner = WIDTH - PAD * 2;
  const floor = HEIGHT - PAD;
  const ceiling = PAD;

  // Sustain is a LEVEL and has no duration, so it gets a fixed fifth of the width. The four
  // times share the rest on ONE axis: each has a slot as wide as its range would draw, and
  // the scale is set so all four slots at their maximum exactly fill it. A stage's width is
  // then `scale * stageWidth(its own seconds)` — no total, no normalisation, so a stage moves
  // only itself and what comes after it. The ranges ARE the zoom: short mode (2 s) spreads a
  // pluck wider than long mode (20 s) does.
  const held = inner * 0.2;
  const budget = inner - held;
  const rangeOf = (stage: TimeStage, path: ParamPath | undefined) => {
    const given = ranges[stage];
    if (given !== undefined) return given;
    const spec = path === undefined ? undefined : PARAM_SPECS[path];
    return spec?.kind === 'number' ? spec.max : stage === 'hold' ? 0.5 : 20;
  };
  const range = {
    attack: rangeOf('attack', stages?.[0] ?? 'voice.envelope.attack'),
    hold: rangeOf('hold', holdPath ?? 'voice.envelope.hold'),
    decay: rangeOf('decay', stages?.[1] ?? 'voice.envelope.decay'),
    release: rangeOf('release', stages?.[3] ?? 'voice.envelope.release'),
  };
  const slots = stageWidth(range.attack, range.attack) + stageWidth(range.hold, range.hold) +
    stageWidth(range.decay, range.decay) + stageWidth(range.release, range.release);
  const scale = slots > 0 ? budget / slots : 0;
  const scaled = [
    scale * stageWidth(attack, range.attack),
    scale * stageWidth(hold, range.hold),
    scale * stageWidth(decay, range.decay),
    scale * stageWidth(release, range.release),
  ];

  const level = Math.min(Math.max(sustain, 0), 1);
  const sustainY = floor - (floor - ceiling) * level;

  const x0 = PAD;
  const x1 = x0 + (scaled[0] ?? 0);
  const xHold = x1 + (scaled[1] ?? 0);
  const x2 = xHold + (scaled[2] ?? 0);
  const x3 = x2 + held;
  const x4 = x3 + (scaled[3] ?? 0);

  const decayPoints = Array.from({ length: DECAY_SAMPLES }, (_unused, i) => {
    const x = (i + 1) / DECAY_SAMPLES;
    const y = ceiling + (sustainY - ceiling) * decayProgress(decayCurve, x);
    return `L ${xHold + (x2 - xHold) * x} ${y}`;
  }).join(' ');

  const path = `M ${x0} ${floor} L ${x1} ${ceiling} L ${xHold} ${ceiling} ${decayPoints} L ${x3} ${sustainY} L ${x4} ${floor}`;
  const tint = dimmed ? COLOR.ignored : COLOR.accent;

  const gesture = useRef<Gesture | null>(null);
  const extraPointers = useRef(new Set<number>());

  /**
   * A path's spec with its travel narrowed to the chosen range, so a handle in short mode
   * moves 0–2 s across the same finger travel that long mode spends on 0–20 s.
   */
  const rangeFor = new Map<ParamPath, number>();
  if (stages !== undefined) {
    rangeFor.set(stages[0], range.attack);
    rangeFor.set(stages[1], range.decay);
    rangeFor.set(stages[3], range.release);
  }
  if (holdPath !== undefined) rangeFor.set(holdPath, range.hold);
  const specOf = (path: ParamPath) => {
    const spec = PARAM_SPECS[path];
    const max = rangeFor.get(path);
    return spec.kind === 'number' && max !== undefined ? { ...spec, max: Math.min(spec.max, max) } : spec;
  };

  /** The current value of a stage path, as a 0..1 track position. */
  const trackOf = (path: ParamPath, value: number): number => {
    const spec = specOf(path);
    return spec.kind === 'number' ? toTrack(value, spec) : 0;
  };

  const commit = (path: ParamPath, track: number) => {
    const spec = specOf(path);
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
          ...(holdPath === undefined ? [] : [{ key: 'hold', cx: xHold, cy: ceiling, x: holdPath, value: hold }]),
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
      const spec = specOf(handle.x);
      if (spec.kind === 'number') commit(handle.x, trackOf(handle.x, handle.value) + horizontal * stepOf(spec) / (spec.max - spec.min || 1));
    }
    if (vertical !== 0 && handle.y !== undefined) {
      const spec = specOf(handle.y);
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
        aria-label={`${label}: attack ${attack}s, hold ${hold}s, decay ${decay}s ${decayCurve}, sustain ${level}, release ${release}s`}
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
