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
  SIGNAL_CHAIN,
  placedPaths,
  sectionFor,
  slotCoveredPaths,
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
