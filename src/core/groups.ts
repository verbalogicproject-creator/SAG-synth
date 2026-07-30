/**
 * src/core/groups.ts — the signal chain, declared once.
 *
 * Every control surface needs to know two things the parameter registry does not say:
 * which parameters belong together, and what order the sections come in. `PARAM_SPECS`
 * gives each address a range and a unit; it does not say that cutoff and resonance are
 * the same knob cluster, or that the filter comes after the oscillator.
 *
 * The alternative — laying that out by hand in the UI — makes the layout a second,
 * unverifiable opinion about the signal path. `EFFECT_CHAIN_ORDER` already establishes
 * the precedent that chain order lives in core and the runtime reads it; this extends
 * the same idea to the whole instrument.
 *
 * Order here is SIGNAL ORDER, not schema order: oscillator into filter into amplifier
 * into effects into output, the way a hardware panel reads left to right. That is why
 * this cannot be derived from `PARAM_SPECS` by string-prefix grouping — `voice.envelope`
 * shapes the amplifier and sorts nowhere near `voice.amplitude`, and `voice.pan` is an
 * output-stage control that happens to live under `voice.`.
 *
 * Deliberately NOT a KIND yet. `KIND-gui_element` exists in the framework but declares
 * Aria's AI-pushed cards (table / card / list / alert / note / graph) — a different
 * shape for a different product, and force-fitting it would make the declaration a lie.
 * Promoting this to a `KIND-synth_control_surface` is the design stage's call, once
 * there is a designed surface to declare. Declaring a KIND for a shape nobody has
 * designed inverts declare-before-emit rather than honouring it.
 *
 * Layer rule D2: core, so no react and no tone. This is data about parameters, not a
 * rendering decision — how a section is drawn stays entirely with the client.
 */

import { PARAM_PATHS } from './schemas';
import { MAX_LFOS, MAX_OSCILLATORS, MAX_ROUTES, type ParamPath } from './types';

export type SectionId =
  | 'oscillator'
  | 'filter'
  | 'amplifier'
  | 'lfo'
  | 'modulation'
  | 'effects'
  | 'eq'
  | 'output'
  | 'voicing';

export interface Section {
  id: SectionId;
  /** Panel heading. Short — these sit in a header bar, not a sentence. */
  label: string;
  /**
   * One line on what the section does to the sound, for a surface that wants to explain
   * itself. Not a tooltip per control; that belongs to the individual spec.
   */
  summary: string;
  /**
   * Addresses in the order they should be presented, which is not always the order they
   * are declared. Slot-indexed families (LFOs, routes) are listed by their `voice.lfos.N`
   * / `voice.modRoutes.N` prefix instead, because how many slots a surface shows depends
   * on how many are filled.
   */
  paths: readonly ParamPath[];
  /** Prefix of a repeated slot family this section owns, if any. */
  slotPrefix?: string;
  /** How many slots that family can hold. */
  slotCount?: number;
}

/**
 * The chain, in signal order. A control surface that walks this array top to bottom is
 * walking the audio path.
 */
export const SIGNAL_CHAIN: readonly Section[] = [
  {
    id: 'oscillator',
    label: 'OSC',
    summary: 'The raw waveforms, summed, before anything shapes them.',
    // A slot family since schema_version 3, the same shape as LFO and ROUTING below.
    // Before that it was five fixed paths, and the surface drew exactly one oscillator
    // because that was all there was to draw.
    paths: [],
    slotPrefix: 'voice.oscillators',
    slotCount: MAX_OSCILLATORS,
  },
  {
    id: 'filter',
    label: 'FILTER',
    summary: 'Removes frequencies, and the contour that moves the cutoff while a note sounds.',
    paths: [
      'voice.filter.type',
      // Labelled "cutoff" on any surface. The filter envelope owns it — see the note on
      // FilterConfig in types.ts for why there is no `voice.filter.frequency`.
      'voice.filterEnvelope.baseFrequency',
      'voice.filter.Q',
      'voice.filter.rolloff',
      'voice.filterEnvelope.octaves',
      'voice.filterEnvelope.attack',
      'voice.filterEnvelope.decay',
      'voice.filterEnvelope.sustain',
      'voice.filterEnvelope.release',
    ],
  },
  {
    id: 'amplifier',
    label: 'AMP',
    summary: 'The volume contour of a single note, and how hard you played it.',
    paths: [
      'voice.envelope.attack',
      'voice.envelope.decay',
      'voice.envelope.sustain',
      'voice.envelope.release',
      'voice.amplitude',
      'voice.velocity.toAmplitude',
      'voice.velocity.toFilterOctaves',
    ],
  },
  {
    id: 'lfo',
    label: 'LFO',
    summary: 'Free-running shapes. They generate movement; routing decides what moves.',
    paths: [],
    slotPrefix: 'voice.lfos',
    slotCount: MAX_LFOS,
  },
  {
    id: 'modulation',
    label: 'ROUTING',
    summary: 'The patch cables: which source drives which destination, and how far.',
    paths: [],
    slotPrefix: 'voice.modRoutes',
    slotCount: MAX_ROUTES,
  },
  {
    id: 'effects',
    label: 'FX',
    summary: 'The serial chain after the voices are mixed together.',
    paths: [
      'effects.distortion.amount',
      'effects.distortion.wet',
      'effects.chorus.frequency',
      'effects.chorus.delayTime',
      'effects.chorus.depth',
      'effects.chorus.wet',
      'effects.delay.delayTime',
      'effects.delay.feedback',
      'effects.delay.wet',
      'effects.reverb.roomSize',
      'effects.reverb.dampening',
      'effects.reverb.wet',
    ],
  },
  {
    id: 'eq',
    label: 'EQ',
    summary: 'Five fixed bands, last in the chain before the output stage.',
    paths: [
      'effects.eq.enabled',
      'effects.eq.band0.gain',
      'effects.eq.band1.gain',
      'effects.eq.band2.gain',
      'effects.eq.band3.gain',
      'effects.eq.band4.gain',
    ],
  },
  {
    id: 'output',
    label: 'OUT',
    summary: 'Where the sound sits in the stereo field, and how loud it leaves.',
    paths: ['voice.pan', 'master.volume', 'master.limiterThreshold'],
  },
  {
    id: 'voicing',
    label: 'VOICING',
    summary: 'How notes share the voice pool. Structural, not part of the signal path.',
    paths: ['voice.polyphony', 'voice.portamento', 'voice.stealPolicy'],
  },
];

/** Every address the chain places directly, ignoring slot families. */
export function placedPaths(): ParamPath[] {
  return SIGNAL_CHAIN.flatMap((section) => [...section.paths]);
}

/**
 * Addresses in a slot family the chain covers by prefix. Split out from `placedPaths()`
 * because the two are checked differently: a directly-placed path must appear exactly
 * once, while a slot path is covered by its family and never listed individually.
 */
export function slotCoveredPaths(): ParamPath[] {
  const prefixes = SIGNAL_CHAIN.flatMap((section) =>
    section.slotPrefix === undefined ? [] : [`${section.slotPrefix}.`],
  );
  return PARAM_PATHS.filter((path) => prefixes.some((prefix) => path.startsWith(prefix)));
}

/** The section owning an address, or undefined if the chain does not place it. */
export function sectionFor(path: ParamPath): Section | undefined {
  return SIGNAL_CHAIN.find(
    (section) =>
      section.paths.includes(path) ||
      (section.slotPrefix !== undefined && path.startsWith(`${section.slotPrefix}.`)),
  );
}
