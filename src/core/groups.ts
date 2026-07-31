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

/** Every address a section holds, slot families expanded, in presentation order. */
export function sectionPaths(id: SectionId): ParamPath[] {
  const section = SIGNAL_CHAIN.find((candidate) => candidate.id === id);
  if (section === undefined) return [];
  if (section.slotPrefix === undefined) return [...section.paths];
  const prefix = `${section.slotPrefix}.`;
  return PARAM_PATHS.filter((path) => path.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// The nav: nine sections onto four tabs.
// ---------------------------------------------------------------------------

/**
 * `SIGNAL_CHAIN` says what the audio path is. It does not say what a screen is, and on a
 * phone those are different questions — nine panels is a scroll, four tabs is an
 * instrument. That mapping is the one piece of layout knowledge nothing here declared,
 * and a hand-written copy of it inside a component is precisely how a parameter becomes
 * unreachable: it validates, it journals, it replays, and no control draws it.
 *
 * So the nav is declared, and the coverage gate in `src/tests/groups.test.ts` asserts in
 * both directions — every address reaches exactly one destination, and every address a
 * tab claims is real. Adding a parameter to `PARAM_SPECS` without placing it fails the
 * suite rather than shipping a knob nobody can find.
 *
 * Groups are stated as whole SECTIONS rather than lists of addresses, so a parameter
 * added to a placed section appears on its tab automatically. The count assertions are
 * what stop that convenience from hiding a wrong split.
 */

/**
 * The one place layout and signal order genuinely disagree.
 *
 * These four belong to the `filter` section — they are the contour that moves the cutoff,
 * and the chain is right to own them there. But a player hunting for an envelope looks at
 * the envelope screen, so the ADSR tab draws them beside the amp envelope, which is also
 * what `04-envelope`'s `AMP | FILTER` sub-tabs already proposed.
 *
 * Declared once and read from both sides — the tab that takes them and the tab that gives
 * them up point at this same array, so the two cannot drift into either a duplicate or a
 * hole. The gate checks that anyway, because "cannot drift" is a claim, not a fact.
 */
const FILTER_ENVELOPE_STAGES: readonly ParamPath[] = [
  'voice.filterEnvelope.attack',
  'voice.filterEnvelope.decay',
  'voice.filterEnvelope.sustain',
  'voice.filterEnvelope.release',
];

export type NavTabId = 'osc' | 'adsr' | 'filter' | 'fx';

/** A sub-tab. One group is one thing on screen at a time. */
export interface NavGroup {
  /** Unique within its tab, not globally — `filter` names a group on two different tabs. */
  id: string;
  /** The sub-tab's own label. A tab with one group draws no sub-tab bar. */
  label: string;
  /** Sections drawn here, whole, in the order they should read. */
  sections: readonly SectionId[];
  /** Addresses drawn here that `sections` does not own. */
  adopts?: readonly ParamPath[];
  /** Addresses `sections` owns that another group draws instead. */
  omits?: readonly ParamPath[];
}

export interface NavTab {
  id: NavTabId;
  /** The nav bar label. These are four buttons on a phone — keep them short. */
  label: string;
  /** One line on what the tab is for. */
  summary: string;
  groups: readonly NavGroup[];
}

export const NAV_TABS: readonly NavTab[] = [
  {
    id: 'osc',
    label: 'OSC',
    summary: 'The waveforms and how they sit against each other.',
    // A/B/C are slot indices, not groups — the family's own `slotCount` says how many
    // there are, and declaring three sub-tabs here would fix at three what the schema
    // already made variable.
    groups: [{ id: 'slots', label: 'SLOTS', sections: ['oscillator'] }],
  },
  {
    id: 'adsr',
    label: 'ADSR',
    summary: 'Both contours: what a note does to the volume, and to the cutoff.',
    groups: [
      { id: 'amp', label: 'AMP', sections: ['amplifier'] },
      { id: 'filter', label: 'FILTER', sections: [], adopts: FILTER_ENVELOPE_STAGES },
    ],
  },
  {
    id: 'filter',
    label: 'FILTER',
    summary: 'What is removed from the sound, what moves it, and the tone at the end.',
    groups: [
      { id: 'filter', label: 'FILTER', sections: ['filter'], omits: FILTER_ENVELOPE_STAGES },
      { id: 'lfo', label: 'LFO', sections: ['lfo'] },
      { id: 'eq', label: 'EQ', sections: ['eq'] },
    ],
  },
  {
    id: 'fx',
    label: 'FX',
    summary: 'The serial chain after the voices mix, and the output stage.',
    groups: [{ id: 'fx', label: 'FX', sections: ['effects', 'output'] }],
  },
];

/**
 * Behind the gear, not on a tab. Voicing is structural — polyphony and portamento change
 * how notes share the voice pool rather than what any one note sounds like, and putting
 * them in the signal path would be a claim that is not true.
 */
export const SETTINGS_SECTION: SectionId = 'voicing';

/**
 * An overlay, not a fifth tab. Routing is about the relationship between two addresses,
 * so it is reachable from every control that has one rather than from one place in a bar.
 */
export const BAY_SECTION: SectionId = 'modulation';

/** Every address a group draws, in order. */
export function groupPaths(group: NavGroup): ParamPath[] {
  const omitted = new Set<string>(group.omits ?? []);
  const owned = group.sections.flatMap((id) =>
    sectionPaths(id).filter((path) => !omitted.has(path)),
  );
  return [...owned, ...(group.adopts ?? [])];
}

/** Every address a tab draws, across all its groups. */
export function tabPaths(tab: NavTab): ParamPath[] {
  return tab.groups.flatMap(groupPaths);
}

export const SETTINGS_PATHS: readonly ParamPath[] = sectionPaths(SETTINGS_SECTION);
export const BAY_PATHS: readonly ParamPath[] = sectionPaths(BAY_SECTION);

/** Where an address is reachable from. `undefined` means it is not — which is a bug. */
export type NavPlacement =
  | { where: 'tab'; tab: NavTab; group: NavGroup }
  | { where: 'settings' }
  | { where: 'bay' };

export function placementFor(path: ParamPath): NavPlacement | undefined {
  for (const tab of NAV_TABS) {
    for (const group of tab.groups) {
      if (groupPaths(group).includes(path)) return { where: 'tab', tab, group };
    }
  }
  if (SETTINGS_PATHS.includes(path)) return { where: 'settings' };
  if (BAY_PATHS.includes(path)) return { where: 'bay' };
  return undefined;
}
