/**
 * src/clients/synth/controls/EnvelopeCurve.tsx — the shape four sliders are making.
 *
 * Display only. The sliders beneath it are the control, which is the decision from the
 * design cycle: a draggable curve is a second way to set the same four values, and until
 * it dispatches the identical `setParam` commands it is a second source of truth about a
 * patch. Making it draggable later changes no data path — that is why it was deferred
 * rather than designed around.
 *
 * Times are drawn on a shared scale so the segments stay comparable, and that scale is
 * derived from the specs rather than assumed: an envelope whose attack can reach 20 s and
 * one capped at 2 s should not draw the same picture for the same number.
 */

import { COLOR, FONT } from '../tokens';

const WIDTH = 240;
const HEIGHT = 64;
const PAD = 4;

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
}

export function EnvelopeCurve({
  attack,
  decay,
  sustain,
  release,
  maxStage,
  dimmed = false,
  label = 'envelope',
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

  return (
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
  );
}

const styles = {
  svg: { display: 'block', width: '100%', height: 64, fontFamily: FONT.mono },
} as const satisfies Record<string, React.CSSProperties>;
