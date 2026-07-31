/**
 * src/core/surface.ts — the whole control surface, as one readable document.
 *
 * Everything here already exists somewhere: `PARAM_SPECS` has the ranges, `NAV_TABS` has
 * the placement, `CONTROLS` has the identity and the words, `MODULATION_DESTINATIONS` has
 * the wiring. What did not exist was a single artifact that joins them, and the join is
 * the point — it is the difference between an agent being able to parse TypeScript and an
 * agent being able to answer "what is on the filter tab" from a file.
 *
 * Emitted to `public/sag-surface.json`, committed, and drift-gated by
 * `src/tests/surface.test.ts`. Committed rather than built-and-thrown-away because a diff
 * is the useful part: a pull request that moves a control between tabs, renames one, or
 * quietly drops one shows up as a change to this file, in a form a human reads without
 * running anything.
 *
 * **No timestamp, no version string, no generator name.** Those would make the file churn
 * on every run and turn a meaningful diff into noise. Core cannot read a clock anyway —
 * a constraint that happens to be exactly right here.
 *
 * **`unwired` is a property of the DESTINATION, not of the control.** This is the
 * distinction the surface has to get right and the one it is easiest to fumble.
 * `effects.delay.wet` is a live parameter: turn the knob and the sound changes, which
 * `tone-runtime.audio.test.ts` proves. It is only unwired as a modulation TARGET — a cable
 * pointed at it moves nothing. So the flag hangs off `modulation`, and a surface that
 * dimmed the FX tab's mix knob on the strength of it would be telling a lie about a
 * control that works.
 *
 * Layer rule D2: core, zod only. This builds a value; writing it to disk is the test's
 * job, because core does no I/O.
 */

import { CONTROLS, fullNameOf, type ParamControl } from './controls';
import { placementFor } from './groups';
import { PARAM_SPECS } from './schemas';
import { MODULATION_DESTINATIONS, PRESET_SCHEMA_VERSION, type ModCurve } from './types';

/** Where a control is reachable from. Mirrors `NavPlacement`, flattened for JSON. */
export type SurfaceLocation =
  | { readonly kind: 'tab'; readonly tab: string; readonly group: string }
  | { readonly kind: 'settings' }
  | { readonly kind: 'bay' };

export interface SurfaceModulation {
  /** How a normalised depth becomes travel here. */
  readonly curve: ModCurve;
  /** One modulator per sounding voice, or one on the shared chain. */
  readonly perVoice: boolean;
  /**
   * Whether a route pointed here reaches an audio node. Proven per destination by
   * `route-wiring.audio.test.ts`, in both directions.
   */
  readonly wired: boolean;
}

export interface SurfaceControl {
  readonly id: string;
  readonly path: string;
  /** The speakable name — what `resolveControl` answers to. */
  readonly name: string;
  readonly scope: string;
  readonly label: string;
  readonly widget: string;
  readonly location: SurfaceLocation;
  readonly kind: string;
  readonly range?: readonly [number, number];
  readonly unit?: string;
  /** Present when the value space is a short list rather than a range. */
  readonly choices?: readonly (string | number)[];
  /** Present only when this address is a declared modulation destination. */
  readonly modulation?: SurfaceModulation;
}

export interface Surface {
  readonly schemaVersion: number;
  readonly counts: {
    readonly controls: number;
    readonly destinations: number;
    readonly wired: number;
    readonly unwired: number;
  };
  readonly controls: readonly SurfaceControl[];
}

const modulationByPath = new Map(
  MODULATION_DESTINATIONS.map((destination) => [destination.path as string, destination]),
);

function locationOf(control: ParamControl): SurfaceLocation {
  const placement = placementFor(control.path);
  if (placement === undefined) {
    // Unreachable while `groups.test.ts` passes — it asserts every address resolves. Kept
    // as a value rather than a throw so the artifact can still be emitted and inspected
    // when something upstream is mid-edit.
    return { kind: 'bay' };
  }
  if (placement.where === 'tab') {
    return { kind: 'tab', tab: placement.tab.id, group: placement.group.id };
  }
  return { kind: placement.where };
}

function describe(control: ParamControl): SurfaceControl {
  const spec = PARAM_SPECS[control.path];
  const destination = modulationByPath.get(control.path);

  const base = {
    id: control.id,
    path: control.path,
    name: fullNameOf(control),
    scope: control.scope,
    label: control.label,
    widget: control.widget,
    location: locationOf(control),
    kind: spec.kind,
  } as const;

  const value =
    spec.kind === 'number'
      ? {
          range: [spec.min, spec.max] as const,
          ...(spec.unit === undefined ? {} : { unit: spec.unit }),
          ...(spec.choices === undefined ? {} : { choices: spec.choices }),
        }
      : spec.kind === 'enum'
        ? { choices: spec.values }
        : {};

  const modulation =
    destination === undefined
      ? {}
      : {
          modulation: {
            curve: destination.curve,
            perVoice: destination.perVoice,
            wired: destination.wired,
          },
        };

  return { ...base, ...value, ...modulation };
}

/**
 * The surface as data. Pure — same inputs, same bytes, which is what lets the emitted file
 * be compared rather than regenerated on trust.
 */
export function buildSurface(): Surface {
  const controls = CONTROLS.map(describe);
  const wired = MODULATION_DESTINATIONS.filter((destination) => destination.wired).length;

  return {
    schemaVersion: PRESET_SCHEMA_VERSION,
    counts: {
      controls: controls.length,
      destinations: MODULATION_DESTINATIONS.length,
      wired,
      unwired: MODULATION_DESTINATIONS.length - wired,
    },
    controls,
  };
}

/** The emitted form, byte-for-byte. One place decides the formatting. */
export function serialiseSurface(): string {
  return `${JSON.stringify(buildSurface(), null, 2)}\n`;
}
