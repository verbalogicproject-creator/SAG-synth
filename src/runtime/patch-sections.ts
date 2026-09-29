/**
 * src/runtime/patch-sections.ts — which parts of a patch a write has to touch.
 *
 * Extracted from `ToneRuntime` in C5b (a pure move): with one instrument per channel, the
 * "what changed" question is asked once per channel instead of once, so it cannot live
 * inside the runtime that used to be the only asker.
 */

import type { SynthPreset } from '../core/types';

/**
 * The units `applyPatch` writes in, each one a piece of the graph that can be brought up
 * to date on its own.
 *
 * They exist because `applyPatch` used to write ALL of them on every call, and the
 * dispatcher calls it on every `pointermove`: `setParam` returns a new patch document for
 * any change, `syncRuntime` sees a new reference and pushes the whole thing. Turning the
 * reverb knob therefore rebuilt the distortion curve (a 1024-point `Float32Array` and a
 * `WaveShaper.curve` assignment), reconstructed Freeverb's dampening filters, re-`set` both
 * envelopes on every live voice, and disposed and rebuilt the entire modulation graph —
 * per move. That is the crackle.
 *
 * The order is the order they are applied in, and `getLastApplied()` reports in it.
 */
export const PATCH_SECTIONS = [
  'oscillators',
  'filter',
  'filterEnvelope',
  'envelope',
  'portamento',
  'pan',
  'distortion',
  'chorus',
  'delay',
  'reverb',
  'eq',
  'lfos',
  'routes',
] as const;

export type PatchSection = (typeof PATCH_SECTIONS)[number];

/**
 * What each section watches. Reference comparison, and that is not an approximation.
 *
 * Core documents are immutable and structurally shared — the reducer returns a new object
 * only along the path that changed — so `before.voice.filter !== after.voice.filter` is
 * exactly the question "did the filter change", answered in one pointer compare instead of
 * a deep walk. The same property `syncRuntime` already relies on at the document level
 * (`src/app/dispatcher.ts:322`); this is that idea one level down.
 *
 * A section may watch more than one input. `routes` watches three, and the third is the
 * one that will look redundant later, so: `rewireRoutes` calls
 * `routeSwing(destination, depth, patch.voice.amplitude)`, and BOTH of that function's
 * outputs are functions of the amplitude — the scaler's gain and, for the `duckDb` curve,
 * the re-centred resting base. `voice.amplitude` is therefore an input to the WIRING, not
 * merely a parameter, and a rewire that skipped it would leave a tremolo running at the old
 * depth around the wrong base while the knob read correctly. Do not remove it.
 */
export const SECTION_INPUTS: Record<PatchSection, readonly ((patch: SynthPreset) => unknown)[]> = {
  oscillators: [(p) => p.voice.oscillators],
  filter: [(p) => p.voice.filter],
  // Linked (schema_version 6), the filter contour runs the AMP stages, so an amp edit is a
  // filter-envelope edit too. The second input is null while unlinked: a constant, which
  // never dirties the section, so an unlinked amp edit costs the filter nothing.
  filterEnvelope: [(p) => p.voice.filterEnvelope, (p) => (p.voice.filterEnvelope.linked ? p.voice.envelope : null)],
  envelope: [(p) => p.voice.envelope],
  portamento: [(p) => p.voice.portamento],
  pan: [(p) => p.voice.pan],
  distortion: [(p) => p.effects.distortion],
  chorus: [(p) => p.effects.chorus],
  delay: [(p) => p.effects.delay],
  reverb: [(p) => p.effects.reverb],
  eq: [(p) => p.effects.eq],
  lfos: [(p) => p.voice.lfos],
  routes: [(p) => p.voice.modRoutes, (p) => p.voice.lfos, (p) => p.voice.amplitude],
};

/**
 * The sections `next` changes relative to `previous`, in `PATCH_SECTIONS` order.
 *
 * `previous === null` means nothing was ever written, so every section is dirty — which is
 * also the honest answer: before the first write there are no values to have kept.
 */
export function dirtySections(previous: SynthPreset | null, next: SynthPreset): PatchSection[] {
  return PATCH_SECTIONS.filter(
    (section) => previous === null || SECTION_INPUTS[section].some((read) => read(previous) !== read(next)),
  );
}
