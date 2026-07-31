/**
 * src/clients/synth/controls/ModRing.tsx — how far the routes can push this control.
 *
 * Drawn outside the value arc, spanning from where modulation can pull the parameter down
 * to where it can push it up. Non-interactive: a route is edited in the bay, and a ring
 * that could be dragged would be a second way to set a depth that the journal would record
 * identically and a player would remember differently.
 *
 * When the reach runs past the end of the travel the overhang is drawn in the overflow
 * hue rather than clipped away. That is the whole point — `modulationLoad()` already knows
 * the routes ask for more travel than the parameter has, and hiding it behind a clean arc
 * is how a clamp becomes invisible.
 */

import { COLOR } from '../tokens';
import type { ModulationReach } from './types';

const RADIUS = 32;
const START_ANGLE = 135;
const SWEEP = 270;

function polar(fraction: number, size: number): { x: number; y: number } {
  const angle = ((START_ANGLE + fraction * SWEEP) * Math.PI) / 180;
  return { x: size / 2 + RADIUS * Math.cos(angle), y: size / 2 + RADIUS * Math.sin(angle) };
}

function arc(from: number, to: number, size: number): string {
  const a = polar(from, size);
  const b = polar(to, size);
  const large = Math.abs(to - from) * SWEEP > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${RADIUS} ${RADIUS} 0 ${large} ${to > from ? 1 : 0} ${b.x} ${b.y}`;
}

export interface ModRingProps {
  /** Where the parameter sits now, 0..1. */
  track: number;
  reach: ModulationReach;
  size: number;
}

export function ModRing({ track, reach, size }: ModRingProps) {
  const low = track - reach.down;
  const high = track + reach.up;
  const insideLow = Math.max(low, 0);
  const insideHigh = Math.min(high, 1);

  return (
    <g pointerEvents="none">
      {insideHigh > insideLow && (
        <path
          d={arc(insideLow, insideHigh, size)}
          stroke={COLOR.accent}
          strokeWidth={2}
          fill="none"
          opacity={0.45}
          strokeLinecap="round"
        />
      )}
      {/* The overhang, drawn rather than clamped. */}
      {low < 0 && (
        <path
          d={arc(0, Math.min(-low, 0.12), size)}
          stroke={COLOR.overflow}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
        />
      )}
      {high > 1 && (
        <path
          d={arc(1 - Math.min(high - 1, 0.12), 1, size)}
          stroke={COLOR.overflow}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
        />
      )}
    </g>
  );
}
