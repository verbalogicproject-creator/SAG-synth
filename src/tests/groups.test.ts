/**
 * src/tests/groups.test.ts — the signal chain must cover the parameter surface.
 *
 * Without this, `groups.ts` is a suggestion. A parameter added to `PARAM_SPECS` and not
 * placed in a section would validate, journal, replay and never appear on any control
 * surface built from the chain — the exact "declared but unreachable" failure the
 * `voice.filter.frequency` decoy already cost us once.
 */

import { describe, expect, it } from 'vitest';
import {
  BAY_PATHS,
  NAV_TABS,
  SETTINGS_PATHS,
  SIGNAL_CHAIN,
  groupPaths,
  placedPaths,
  placementFor,
  sectionFor,
  slotCoveredPaths,
  tabPaths,
  type NavTabId,
  type SectionId,
} from '../core/groups';
import { PARAM_PATHS, PARAM_SPECS } from '../core/schemas';
import { MAX_LFOS, MAX_OSCILLATORS, MAX_ROUTES } from '../core/types';

describe('the signal chain covers the parameter surface', () => {
  it('places every declared address exactly once', () => {
    const placed = placedPaths();
    const covered = new Set<string>([...placed, ...slotCoveredPaths()]);
    const missing = PARAM_PATHS.filter((path) => !covered.has(path));
    expect(missing, 'addresses no section places').toEqual([]);
  });

  it('places nothing twice, which would draw the same control in two panels', () => {
    const placed = placedPaths();
    const duplicates = placed.filter((path, i) => placed.indexOf(path) !== i);
    expect(duplicates).toEqual([]);
  });

  it('places nothing that is not a real address', () => {
    const known = new Set<string>(PARAM_PATHS);
    for (const path of placedPaths()) {
      expect(known.has(path), `"${path}" is placed but is not a parameter address`).toBe(true);
    }
  });

  it('accounts for the slot families by prefix rather than by listing them', () => {
    // 3 oscillators x 9 keys + 4 LFOs x 5 keys + 8 routes x 4 keys. Listing 79 slot
    // addresses longhand would rot the moment one of the caps moved — and the oscillator
    // family only became a slot family at schema_version 3, which is exactly the kind of
    // move that would have rotted it.
    expect(slotCoveredPaths()).toHaveLength(MAX_OSCILLATORS * 9 + MAX_LFOS * 5 + MAX_ROUTES * 4);
  });

  it('gives every section a unique id and a non-empty label', () => {
    const ids = SIGNAL_CHAIN.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of SIGNAL_CHAIN) {
      expect(section.label.length, `${section.id} has no label`).toBeGreaterThan(0);
      expect(section.summary.length, `${section.id} has no summary`).toBeGreaterThan(0);
    }
  });

  it('gives every section either direct paths or a slot family, never neither', () => {
    for (const section of SIGNAL_CHAIN) {
      const hasContent = section.paths.length > 0 || section.slotPrefix !== undefined;
      expect(hasContent, `${section.id} is empty`).toBe(true);
    }
  });

  it('runs the audio path in signal order, with voicing last', () => {
    // Not cosmetic: a surface that walks this array is walking the audio path, so the
    // order IS the claim. Voicing is not in the signal path at all, hence last.
    const order = SIGNAL_CHAIN.map((section) => section.id);
    const expected: SectionId[] = [
      'oscillator',
      'filter',
      'amplifier',
      'lfo',
      'modulation',
      'effects',
      'eq',
      'output',
      'voicing',
    ];
    expect(order).toEqual(expected);
  });

  it('resolves a section for every address, including slot addresses', () => {
    for (const path of PARAM_PATHS) {
      expect(sectionFor(path), `"${path}" resolves to no section`).toBeDefined();
    }
  });

  it('puts the cutoff in the filter section, not wherever the schema happens to nest it', () => {
    // The one placement a reader is most likely to get wrong: the live cutoff lives on
    // the filter ENVELOPE in the schema, but belongs to the filter panel on any surface.
    expect(sectionFor('voice.filterEnvelope.baseFrequency')?.id).toBe('filter');
    expect(sectionFor('voice.envelope.attack')?.id).toBe('amplifier');
    expect(sectionFor('voice.pan')?.id).toBe('output');
  });

  it('places every modulation destination somewhere a surface can reach it', () => {
    // A destination a route can name but no panel can show is a cable to nowhere.
    for (const path of PARAM_PATHS) {
      const spec = PARAM_SPECS[path];
      if (spec.kind === 'number' && spec.modulation !== undefined) {
        expect(sectionFor(path), `destination "${path}" has no section`).toBeDefined();
      }
    }
  });
});

/**
 * The nav gate. `SIGNAL_CHAIN`'s own gate above proves the nine sections cover the
 * parameter surface; this proves the four tabs cover the nine sections. Without the
 * second half, a section could be placed and still be drawn by nothing — which is the
 * same "declared but unreachable" failure one layer up, and the reason the whole designed
 * surface is allowed to generate from a declaration.
 */
describe('the nav covers the signal chain', () => {
  const destinations = () =>
    [
      ...NAV_TABS.map((tab) => [`tab:${tab.id}`, tabPaths(tab)] as const),
      ['settings', [...SETTINGS_PATHS]] as const,
      ['bay', [...BAY_PATHS]] as const,
    ] as const;

  it('lands every declared address on exactly one destination', () => {
    // The gate the phase rests on, in both directions at once. Remove a section from a
    // tab and `missing` grows; draw one in two places and `twice` does.
    const seen = new Map<string, string[]>();
    for (const [name, paths] of destinations()) {
      for (const path of paths) seen.set(path, [...(seen.get(path) ?? []), name]);
    }

    const missing = PARAM_PATHS.filter((path) => !seen.has(path));
    expect(missing, 'addresses no tab, the settings screen or the bay draws').toEqual([]);

    const twice = [...seen].filter(([, where]) => where.length > 1);
    expect(twice, 'addresses drawn in two places').toEqual([]);
  });

  it('claims nothing that is not a real address', () => {
    const known = new Set<string>(PARAM_PATHS);
    for (const [name, paths] of destinations()) {
      for (const path of paths) {
        expect(known.has(path), `${name} claims "${path}", which is not an address`).toBe(true);
      }
    }
  });

  it('splits the 125 the way the design says it does', () => {
    // Written out rather than summed so a wrong split is a wrong LINE, not a wrong total.
    // Sections read whole, so a new parameter joins its tab silently — these counts are
    // the only thing that makes that convenience notice.
    const counts = Object.fromEntries(destinations().map(([name, p]) => [name, p.length]));

    expect(counts).toEqual({
      'tab:osc': 27, // three slots of nine
      'tab:adsr': 16, // nine amp (AHDSR adds hold + decay curve) + the six filter-envelope stages + its amp link
      'tab:filter': 32, // six filter (drive at 7) + twenty LFO + six EQ
      'tab:fx': 15, // twelve effects + three output
      settings: 3, // voicing
      bay: 32, // eight routes of four
    });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(PARAM_PATHS.length);
  });

  it('hands the filter envelope stages over without dropping or duplicating them', () => {
    // The one place layout and signal order disagree, and therefore the one place a
    // half-applied edit could open a hole. `adopts` on one tab and `omits` on another
    // point at the same array; this asserts the pairing rather than trusting it.
    const adopted = NAV_TABS.flatMap((tab) => tab.groups.flatMap((g) => [...(g.adopts ?? [])]));
    const omitted = NAV_TABS.flatMap((tab) => tab.groups.flatMap((g) => [...(g.omits ?? [])]));

    expect([...adopted].sort()).toEqual([...omitted].sort());
    for (const path of adopted) {
      // And the giver really did own it — an `omits` naming a path its sections never
      // held would subtract nothing and read as though it had.
      expect(sectionFor(path)?.id, `"${path}" is adopted from nowhere`).toBe('filter');
    }
  });

  it('runs the tabs in the order the nav bar draws them', () => {
    const order = NAV_TABS.map((tab) => tab.id);
    const expected: NavTabId[] = ['osc', 'adsr', 'filter', 'fx'];
    expect(order).toEqual(expected);
  });

  it('gives every tab and group a unique id, a label and something to draw', () => {
    const tabIds = NAV_TABS.map((tab) => tab.id);
    expect(new Set(tabIds).size).toBe(tabIds.length);

    for (const tab of NAV_TABS) {
      expect(tab.label.length, `${tab.id} has no label`).toBeGreaterThan(0);
      expect(tab.summary.length, `${tab.id} has no summary`).toBeGreaterThan(0);

      const groupIds = tab.groups.map((group) => group.id);
      expect(new Set(groupIds).size, `${tab.id} repeats a group id`).toBe(groupIds.length);

      for (const group of tab.groups) {
        expect(group.label.length, `${tab.id}/${group.id} has no label`).toBeGreaterThan(0);
        expect(groupPaths(group).length, `${tab.id}/${group.id} draws nothing`).toBeGreaterThan(0);
      }
    }
  });

  it('resolves a placement for every address', () => {
    for (const path of PARAM_PATHS) {
      expect(placementFor(path), `"${path}" is reachable from nowhere`).toBeDefined();
    }
  });

  it('puts the two envelopes on the same screen and the cutoff on the other one', () => {
    // The placements a reader is most likely to get wrong, named individually so the
    // failure says which one moved.
    expect(placementFor('voice.filterEnvelope.attack')).toMatchObject({
      where: 'tab',
      tab: { id: 'adsr' },
      group: { id: 'filter' },
    });
    expect(placementFor('voice.envelope.attack')).toMatchObject({
      where: 'tab',
      tab: { id: 'adsr' },
      group: { id: 'amp' },
    });
    // The live cutoff stays with the filter even though it is spelled as an envelope key.
    expect(placementFor('voice.filterEnvelope.baseFrequency')).toMatchObject({
      where: 'tab',
      tab: { id: 'filter' },
    });
    expect(placementFor('voice.pan')).toMatchObject({ where: 'tab', tab: { id: 'fx' } });
    expect(placementFor('voice.polyphony')).toEqual({ where: 'settings' });
    expect(placementFor('voice.modRoutes.0.depth')).toEqual({ where: 'bay' });
  });
});
