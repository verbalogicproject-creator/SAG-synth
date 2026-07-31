/**
 * src/core/controls.ts — the control surface, given identity and words.
 *
 * `PARAM_SPECS` says what a parameter IS: a range, a unit, a modulation curve. `NAV_TABS`
 * says WHERE it is drawn. Neither says what the thing on screen is called, or gives it a
 * name an agent and a human can both point at. Those are the two gaps this file closes,
 * and they turn out to be the same gap.
 *
 * **Identity.** Every addressable control gets a mint: `ctl-NNN`, flat, opaque, append-only
 * and never reused. Not `Knob-17`, not `flt-03`. Widget and location are the least stable
 * facts about a control, so encoding either into the identity means a layout change renames
 * something that journal rows and graph nodes already point at. Three cases would have
 * broken a location-encoded id on the day it was written: `voice.filterEnvelope.attack` is
 * owned by the `filter` section and drawn on the ADSR tab, the action verbs belong to no
 * section at all, and the nav is planned to grow from four tabs to eight.
 *
 * Speakability is bought back with `scope` and `label`, which are METADATA. "filter cutoff",
 * "delay mix" and "osc a level" all resolve to an id; none of them is one. When a knob
 * becomes a slider the conversation changes and the identity does not.
 *
 * **Words.** `label` is authored, and it names what a player controls rather than how the
 * system is built. `voice.filter.Q` is "resonance". `voice.portamento` is "glide". The one
 * that matters most: `voice.filterEnvelope.baseFrequency` is "cutoff", because a MonoSynth
 * puts the live cutoff on the filter envelope and nobody playing an instrument cares.
 *
 * Before this file, that translation was hand-written per panel — `FilterPanel.tsx` and
 * `ModPanel.tsx` each independently spelled the same address "cutoff", neither gated. Two
 * uncoordinated naming opinions is the same shape of problem `NAV_TABS` removed one layer
 * up, and it scales with every surface added.
 *
 * **Scope.** Labels are deliberately NOT unique — there are four "mix"es and three
 * "level"s, because that is what those controls are called. `scope` is the qualifier that
 * makes the pair speakable and unique: "delay mix", "chorus mix". It is authored rather
 * than derived from the path because "amp env" and "filter env" both live under
 * `voice.*Envelope.*` and the path cannot tell them apart the way an ear can.
 *
 * Layer rule D2: core, so no react and no tone. Nothing here reads a clock or mints an id
 * at runtime — the mint is a literal, which is the only way append-only can be checked.
 */

import { PARAM_SPECS, type ParamSpec } from './schemas';
import type { ParamPath } from './types';

/** `ctl-NNN`. Opaque on purpose: the number carries no meaning and must not acquire one. */
export type ControlId = string;

/**
 * How a control is drawn. A rendering decision, recorded here so panels do not each make
 * it privately — and explicitly NOT part of the identity, because it is revisable.
 */
export type Widget = 'knob' | 'slider' | 'glyphs' | 'toggle';

export interface ParamControl {
  id: ControlId;
  /** The audio-graph address. The contract, the command payload and the journal all use it. */
  path: ParamPath;
  /** Qualifier that makes `label` unique and speakable: "delay", "osc a", "filter env". */
  scope: string;
  /** What a player calls it. Lower case; the surface decides its own casing. */
  label: string;
  widget: Widget;
}

/**
 * The default widget, derived from the contract rather than asserted.
 *
 * A number carrying `choices` is not a range — `voice.filter.rolloff` has four legal
 * slopes and a spec that says so — so it draws as buttons for the same reason an enum
 * does. Deriving that here rather than overriding it per control means a parameter that
 * gains `choices` stops being a knob automatically, instead of keeping a knob that can
 * reach values the engine will refuse.
 *
 * That leaves knob-or-slider as the only real decision, and the only thing overridden.
 */
function defaultWidget(spec: ParamSpec): Widget {
  switch (spec.kind) {
    case 'boolean':
      return 'toggle';
    case 'enum':
      return 'glyphs';
    case 'number':
      return spec.choices === undefined ? 'knob' : 'glyphs';
    case 'frequency':
      return 'knob';
  }
}

function c(id: string, path: ParamPath, scope: string, label: string, widget?: Widget): ParamControl {
  return { id, path, scope, label, widget: widget ?? defaultWidget(PARAM_SPECS[path]) };
}

/**
 * The mint. Order is `PARAM_PATHS` order as it stood when the file was written, and it is
 * frozen — ids are stated, never derived from position, so this array may be reordered for
 * readability without renaming anything. Appending is the only way to grow it.
 *
 * Written out longhand rather than generated per slot family on purpose. A loop keyed on
 * `MAX_OSCILLATORS` would renumber every id after the oscillators the day a fourth slot is
 * allowed, which is exactly the failure minting exists to prevent.
 *
 * Sliders where a knob reads worse: the eight envelope stages, the five EQ bands and the
 * master fader. Envelopes are read as a shape and EQ as a curve, and a row of knobs draws
 * neither.
 */
export const CONTROLS: readonly ParamControl[] = [
  // Amplifier envelope
  c('ctl-000', 'voice.envelope.attack', 'amp env', 'attack', 'slider'),
  c('ctl-001', 'voice.envelope.decay', 'amp env', 'decay', 'slider'),
  c('ctl-002', 'voice.envelope.sustain', 'amp env', 'sustain', 'slider'),
  c('ctl-003', 'voice.envelope.release', 'amp env', 'release', 'slider'),

  // Filter. "resonance" and "slope" rather than "Q" and "rolloff" — the second of each
  // pair is the name of an implementation, and no one reaches for a Q knob.
  c('ctl-004', 'voice.filter.type', 'filter', 'type'),
  c('ctl-005', 'voice.filter.Q', 'filter', 'resonance'),
  // Buttons, and not because this line says so — the spec carries `choices`.
  c('ctl-006', 'voice.filter.rolloff', 'filter', 'slope'),

  // Filter envelope. Its four stages are drawn on the ADSR tab and its two amounts on the
  // FILTER tab — the split `NAV_TABS` declares, visible here as two scopes.
  c('ctl-007', 'voice.filterEnvelope.attack', 'filter env', 'attack', 'slider'),
  c('ctl-008', 'voice.filterEnvelope.decay', 'filter env', 'decay', 'slider'),
  c('ctl-009', 'voice.filterEnvelope.sustain', 'filter env', 'sustain', 'slider'),
  c('ctl-010', 'voice.filterEnvelope.release', 'filter env', 'release', 'slider'),
  // The one every other name in this file is measured against.
  c('ctl-011', 'voice.filterEnvelope.baseFrequency', 'filter', 'cutoff'),
  c('ctl-012', 'voice.filterEnvelope.octaves', 'filter', 'env amount'),

  // Voicing
  c('ctl-013', 'voice.polyphony', 'voicing', 'voices'),
  c('ctl-014', 'voice.portamento', 'voicing', 'glide'),
  c('ctl-015', 'voice.stealPolicy', 'voicing', 'note steal'),

  // Velocity. Named as the routing it is, because that is what a player is setting up.
  c('ctl-016', 'voice.velocity.toAmplitude', 'velocity', 'to volume'),
  c('ctl-017', 'voice.velocity.toFilterOctaves', 'velocity', 'to cutoff'),

  // Output stage of the voice
  c('ctl-018', 'voice.amplitude', 'voice', 'level'),
  c('ctl-019', 'voice.pan', 'voice', 'pan'),

  // Effects. "drive" for the distortion's amount: it is a drive control, it simply sits
  // after the filter rather than inside it, which is a different sound and not a different
  // name. "mix" for every wet, because four effects with four names for one idea is worse.
  c('ctl-020', 'effects.distortion.amount', 'distortion', 'drive'),
  c('ctl-021', 'effects.distortion.wet', 'distortion', 'mix'),
  c('ctl-022', 'effects.chorus.frequency', 'chorus', 'rate'),
  c('ctl-023', 'effects.chorus.delayTime', 'chorus', 'delay'),
  c('ctl-024', 'effects.chorus.depth', 'chorus', 'depth'),
  c('ctl-025', 'effects.chorus.wet', 'chorus', 'mix'),
  c('ctl-026', 'effects.delay.delayTime', 'delay', 'time'),
  c('ctl-027', 'effects.delay.feedback', 'delay', 'feedback'),
  c('ctl-028', 'effects.delay.wet', 'delay', 'mix'),
  c('ctl-029', 'effects.reverb.roomSize', 'reverb', 'size'),
  c('ctl-030', 'effects.reverb.dampening', 'reverb', 'damping'),
  c('ctl-031', 'effects.reverb.wet', 'reverb', 'mix'),

  // EQ. Bands are numbered, not named by frequency: the centres live in
  // `EQ_BAND_FREQUENCIES` and a label that spelled "250 Hz" would drift the day that
  // array moves. The panel renders the frequency from the array.
  // "on", not "eq" — the scope already says eq, and "eq eq" is what reading the emitted
  // surface out loud caught. Matches every other enable toggle: "osc a on", "lfo 1 on".
  c('ctl-032', 'effects.eq.enabled', 'eq', 'on'),
  c('ctl-033', 'effects.eq.band0.gain', 'eq', 'band 1', 'slider'),
  c('ctl-034', 'effects.eq.band1.gain', 'eq', 'band 2', 'slider'),
  c('ctl-035', 'effects.eq.band2.gain', 'eq', 'band 3', 'slider'),
  c('ctl-036', 'effects.eq.band3.gain', 'eq', 'band 4', 'slider'),
  c('ctl-037', 'effects.eq.band4.gain', 'eq', 'band 5', 'slider'),

  // Master
  c('ctl-038', 'master.volume', 'master', 'volume', 'slider'),
  c('ctl-039', 'master.limiterThreshold', 'master', 'limiter'),

  // Oscillator A
  c('ctl-040', 'voice.oscillators.0.enabled', 'osc a', 'on'),
  c('ctl-041', 'voice.oscillators.0.type', 'osc a', 'wave'),
  c('ctl-042', 'voice.oscillators.0.octave', 'osc a', 'octave'),
  c('ctl-043', 'voice.oscillators.0.detune', 'osc a', 'detune'),
  c('ctl-044', 'voice.oscillators.0.count', 'osc a', 'unison'),
  c('ctl-045', 'voice.oscillators.0.spread', 'osc a', 'spread'),
  c('ctl-046', 'voice.oscillators.0.width', 'osc a', 'width'),
  c('ctl-047', 'voice.oscillators.0.level', 'osc a', 'level'),
  c('ctl-048', 'voice.oscillators.0.pan', 'osc a', 'pan'),

  // Oscillator B
  c('ctl-049', 'voice.oscillators.1.enabled', 'osc b', 'on'),
  c('ctl-050', 'voice.oscillators.1.type', 'osc b', 'wave'),
  c('ctl-051', 'voice.oscillators.1.octave', 'osc b', 'octave'),
  c('ctl-052', 'voice.oscillators.1.detune', 'osc b', 'detune'),
  c('ctl-053', 'voice.oscillators.1.count', 'osc b', 'unison'),
  c('ctl-054', 'voice.oscillators.1.spread', 'osc b', 'spread'),
  c('ctl-055', 'voice.oscillators.1.width', 'osc b', 'width'),
  c('ctl-056', 'voice.oscillators.1.level', 'osc b', 'level'),
  c('ctl-057', 'voice.oscillators.1.pan', 'osc b', 'pan'),

  // Oscillator C
  c('ctl-058', 'voice.oscillators.2.enabled', 'osc c', 'on'),
  c('ctl-059', 'voice.oscillators.2.type', 'osc c', 'wave'),
  c('ctl-060', 'voice.oscillators.2.octave', 'osc c', 'octave'),
  c('ctl-061', 'voice.oscillators.2.detune', 'osc c', 'detune'),
  c('ctl-062', 'voice.oscillators.2.count', 'osc c', 'unison'),
  c('ctl-063', 'voice.oscillators.2.spread', 'osc c', 'spread'),
  c('ctl-064', 'voice.oscillators.2.width', 'osc c', 'width'),
  c('ctl-065', 'voice.oscillators.2.level', 'osc c', 'level'),
  c('ctl-066', 'voice.oscillators.2.pan', 'osc c', 'pan'),

  // LFOs. One-based in speech because they are labelled 1–4 on every synth ever made,
  // and zero-based in the path because that is an array index. Both are true.
  c('ctl-067', 'voice.lfos.0.enabled', 'lfo 1', 'on'),
  c('ctl-068', 'voice.lfos.0.type', 'lfo 1', 'shape'),
  c('ctl-069', 'voice.lfos.0.frequency', 'lfo 1', 'rate'),
  c('ctl-070', 'voice.lfos.0.sync', 'lfo 1', 'sync'),
  c('ctl-071', 'voice.lfos.0.retrigger', 'lfo 1', 'retrigger'),

  c('ctl-072', 'voice.lfos.1.enabled', 'lfo 2', 'on'),
  c('ctl-073', 'voice.lfos.1.type', 'lfo 2', 'shape'),
  c('ctl-074', 'voice.lfos.1.frequency', 'lfo 2', 'rate'),
  c('ctl-075', 'voice.lfos.1.sync', 'lfo 2', 'sync'),
  c('ctl-076', 'voice.lfos.1.retrigger', 'lfo 2', 'retrigger'),

  c('ctl-077', 'voice.lfos.2.enabled', 'lfo 3', 'on'),
  c('ctl-078', 'voice.lfos.2.type', 'lfo 3', 'shape'),
  c('ctl-079', 'voice.lfos.2.frequency', 'lfo 3', 'rate'),
  c('ctl-080', 'voice.lfos.2.sync', 'lfo 3', 'sync'),
  c('ctl-081', 'voice.lfos.2.retrigger', 'lfo 3', 'retrigger'),

  c('ctl-082', 'voice.lfos.3.enabled', 'lfo 4', 'on'),
  c('ctl-083', 'voice.lfos.3.type', 'lfo 4', 'shape'),
  c('ctl-084', 'voice.lfos.3.frequency', 'lfo 4', 'rate'),
  c('ctl-085', 'voice.lfos.3.sync', 'lfo 4', 'sync'),
  c('ctl-086', 'voice.lfos.3.retrigger', 'lfo 4', 'retrigger'),

  // Modulation routes. These are the bay's jacks; the bay draws them as cables rather than
  // as four controls in a row, but they are addressable either way and the LIST view does
  // draw them as four controls in a row.
  c('ctl-087', 'voice.modRoutes.0.enabled', 'route 1', 'on'),
  c('ctl-088', 'voice.modRoutes.0.source', 'route 1', 'source'),
  c('ctl-089', 'voice.modRoutes.0.destination', 'route 1', 'destination'),
  c('ctl-090', 'voice.modRoutes.0.depth', 'route 1', 'depth'),

  c('ctl-091', 'voice.modRoutes.1.enabled', 'route 2', 'on'),
  c('ctl-092', 'voice.modRoutes.1.source', 'route 2', 'source'),
  c('ctl-093', 'voice.modRoutes.1.destination', 'route 2', 'destination'),
  c('ctl-094', 'voice.modRoutes.1.depth', 'route 2', 'depth'),

  c('ctl-095', 'voice.modRoutes.2.enabled', 'route 3', 'on'),
  c('ctl-096', 'voice.modRoutes.2.source', 'route 3', 'source'),
  c('ctl-097', 'voice.modRoutes.2.destination', 'route 3', 'destination'),
  c('ctl-098', 'voice.modRoutes.2.depth', 'route 3', 'depth'),

  c('ctl-099', 'voice.modRoutes.3.enabled', 'route 4', 'on'),
  c('ctl-100', 'voice.modRoutes.3.source', 'route 4', 'source'),
  c('ctl-101', 'voice.modRoutes.3.destination', 'route 4', 'destination'),
  c('ctl-102', 'voice.modRoutes.3.depth', 'route 4', 'depth'),

  c('ctl-103', 'voice.modRoutes.4.enabled', 'route 5', 'on'),
  c('ctl-104', 'voice.modRoutes.4.source', 'route 5', 'source'),
  c('ctl-105', 'voice.modRoutes.4.destination', 'route 5', 'destination'),
  c('ctl-106', 'voice.modRoutes.4.depth', 'route 5', 'depth'),

  c('ctl-107', 'voice.modRoutes.5.enabled', 'route 6', 'on'),
  c('ctl-108', 'voice.modRoutes.5.source', 'route 6', 'source'),
  c('ctl-109', 'voice.modRoutes.5.destination', 'route 6', 'destination'),
  c('ctl-110', 'voice.modRoutes.5.depth', 'route 6', 'depth'),

  c('ctl-111', 'voice.modRoutes.6.enabled', 'route 7', 'on'),
  c('ctl-112', 'voice.modRoutes.6.source', 'route 7', 'source'),
  c('ctl-113', 'voice.modRoutes.6.destination', 'route 7', 'destination'),
  c('ctl-114', 'voice.modRoutes.6.depth', 'route 7', 'depth'),

  c('ctl-115', 'voice.modRoutes.7.enabled', 'route 8', 'on'),
  c('ctl-116', 'voice.modRoutes.7.source', 'route 8', 'source'),
  c('ctl-117', 'voice.modRoutes.7.destination', 'route 8', 'destination'),
  c('ctl-118', 'voice.modRoutes.7.depth', 'route 8', 'depth'),
];

/**
 * Ids retired from `CONTROLS` — none yet, and the list exists so that removing a control
 * has somewhere honest to go. An id in here may never be minted again: journal rows and
 * graph nodes that reference it stay meaningful, and a reused id would silently retarget
 * every one of them.
 */
export const RETIRED_CONTROL_IDS: readonly ControlId[] = [];

const byId = new Map(CONTROLS.map((control) => [control.id, control]));
const byPath = new Map(CONTROLS.map((control) => [control.path, control]));

export function controlById(id: ControlId): ParamControl | undefined {
  return byId.get(id);
}

export function controlForPath(path: ParamPath): ParamControl | undefined {
  return byPath.get(path);
}

/** "filter cutoff", "delay mix" — the speakable name, built rather than stored. */
export function fullNameOf(control: ParamControl): string {
  return `${control.scope} ${control.label}`;
}

/**
 * Resolve anything a human or an agent might say into one control.
 *
 * Accepts an id, a `ParamPath`, a full name, or a bare label when that label happens to be
 * unambiguous. Returns `undefined` rather than guessing when a bare label is shared — four
 * effects have a "mix", and picking one of them silently is how the wrong knob gets turned.
 */
export function resolveControl(query: string): ParamControl | undefined {
  // Ids and paths are matched BEFORE case is folded. A `ParamPath` is camelCase and
  // `voice.filterenvelope.basefrequency` is not an address — lowering it first would make
  // the one form the contract actually uses the one form this function could not resolve.
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const exact = byId.get(trimmed) ?? byId.get(needle) ?? byPath.get(trimmed as ParamPath);
  if (exact !== undefined) return exact;

  const byFullName = CONTROLS.filter((control) => fullNameOf(control).toLowerCase() === needle);
  if (byFullName.length === 1) return byFullName[0];

  const byLabel = CONTROLS.filter((control) => control.label.toLowerCase() === needle);
  return byLabel.length === 1 ? byLabel[0] : undefined;
}
