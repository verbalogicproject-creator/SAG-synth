/**
 * src/tests/controls.test.ts — identity and words, both checked.
 *
 * Two gates in one file because they guard one file. The identity half is the harder of
 * the two: an id that changes is worse than an id that never existed, because journal rows
 * and graph nodes keep pointing at it and now mean something else. There is no way to
 * observe that at runtime — a renumbered mint compiles, renders and sounds identical — so
 * the append-only property has to be structural, which is what the retirement gate below
 * makes it.
 *
 * The words half is the cheaper one and still worth gating: before this file the same
 * address was independently spelled "cutoff" in two panels, and nothing would have noticed
 * a third panel calling it "base frequency".
 */

import { describe, expect, it } from 'vitest';
import {
  CONTROLS,
  RETIRED_CONTROL_IDS,
  controlById,
  controlForPath,
  fullNameOf,
  labelWithin,
  resolveControl,
} from '../core/controls';
import { NAV_TABS, tabPaths } from '../core/groups';
import { PARAM_PATHS, PARAM_SPECS } from '../core/schemas';

const ID_PATTERN = /^ctl-\d{3}$/;

const indexOf = (id: string) => Number.parseInt(id.slice('ctl-'.length), 10);

describe('every control has an identity that cannot move', () => {
  it('mints one control for every declared address, and nothing else', () => {
    const missing = PARAM_PATHS.filter((path) => controlForPath(path) === undefined);
    expect(missing, 'addresses with no control').toEqual([]);

    const known = new Set<string>(PARAM_PATHS);
    const unreal = CONTROLS.filter((control) => !known.has(control.path));
    expect(unreal.map((c) => c.path), 'controls for addresses that do not exist').toEqual([]);

    expect(CONTROLS).toHaveLength(PARAM_PATHS.length);
  });

  it('gives every control a unique, well-formed id', () => {
    const ids = CONTROLS.map((control) => control.id);
    expect(new Set(ids).size, 'two controls share an id').toBe(ids.length);
    for (const id of ids) expect(id, `"${id}" is not ctl-NNN`).toMatch(ID_PATTERN);
  });

  it('never mints an id that was retired', () => {
    // The rule that makes an id permanent. A retired id still means what it meant; handing
    // it to a different control silently retargets every journal row that carries it.
    const retired = new Set<string>(RETIRED_CONTROL_IDS);
    const reused = CONTROLS.filter((control) => retired.has(control.id));
    expect(reused.map((c) => c.id), 'live controls holding retired ids').toEqual([]);
  });

  it('leaves no hole in the id space, which is what makes the mint append-only', () => {
    // The structural half, and the only check that can catch a renumbering. Live ids plus
    // retired ids must tile 0..N with no gaps and no repeats. Appending keeps that true.
    // Deleting a control without retiring its id opens a hole; renumbering opens one and
    // duplicates another. Neither is visible any other way.
    const all = [...CONTROLS.map((control) => control.id), ...RETIRED_CONTROL_IDS];
    const indices = all.map(indexOf).sort((a, b) => a - b);
    const expected = Array.from({ length: all.length }, (_unused, i) => i);

    expect(indices, 'the id space is not dense — an id was removed or renumbered').toEqual(
      expected,
    );
  });

  it('resolves an id and a path back to the same control', () => {
    for (const control of CONTROLS) {
      expect(controlById(control.id)).toBe(control);
      expect(controlForPath(control.path)).toBe(control);
    }
  });
});

describe('every control has a name a player would use', () => {
  it('labels everything, in the surface-agnostic form', () => {
    for (const control of CONTROLS) {
      expect(control.label.length, `${control.id} has no label`).toBeGreaterThan(0);
      expect(control.scope.length, `${control.id} has no scope`).toBeGreaterThan(0);
      // Lower case and untrimmed-free: casing is the surface's decision, and a stray space
      // would break `resolveControl` in a way nothing else would report.
      expect(control.label, `${control.id} label is not bare lower case`).toBe(
        control.label.trim().toLowerCase(),
      );
      expect(control.scope, `${control.id} scope is not bare lower case`).toBe(
        control.scope.trim().toLowerCase(),
      );
    }
  });

  it('keeps scope + label unique, which is what makes it speakable', () => {
    // Labels themselves are deliberately NOT unique — four effects have a "mix" because
    // that is what the control is called. The pair is what has to identify one thing.
    const names = CONTROLS.map(fullNameOf);
    const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
    expect(duplicates, 'two controls answer to the same spoken name').toEqual([]);
  });

  it('names the cutoff after the sound, not after the schema', () => {
    // The address this whole layer exists for: the live cutoff lives on the filter
    // ENVELOPE because a MonoSynth puts it there, and no player has ever asked for a
    // base frequency.
    const cutoff = controlForPath('voice.filterEnvelope.baseFrequency');
    expect(cutoff?.label).toBe('cutoff');
    expect(fullNameOf(cutoff!)).toBe('filter cutoff');

    // Two more where the schema name would have leaked through.
    expect(controlForPath('voice.filter.Q')?.label).toBe('resonance');
    expect(controlForPath('voice.portamento')?.label).toBe('glide');
  });

  it('resolves anything a person or an agent would actually say', () => {
    const cutoff = controlForPath('voice.filterEnvelope.baseFrequency');

    expect(resolveControl('ctl-011')).toBe(cutoff);
    expect(resolveControl('voice.filterEnvelope.baseFrequency')).toBe(cutoff);
    expect(resolveControl('filter cutoff')).toBe(cutoff);
    expect(resolveControl('  Filter Cutoff  ')).toBe(cutoff);
    // A bare label resolves only when it happens to be unambiguous.
    expect(resolveControl('cutoff')).toBe(cutoff);
    expect(resolveControl('glide')).toBe(controlForPath('voice.portamento'));
  });

  it('refuses to guess when a name is shared', () => {
    // The half that matters. Four effects have a "mix" and three things have a "level";
    // picking one silently is how the wrong knob gets turned by an agent that was sure.
    expect(resolveControl('mix')).toBeUndefined();
    expect(resolveControl('level')).toBeUndefined();
    expect(resolveControl('attack')).toBeUndefined();
    // And the qualified forms still work, so the refusal costs nothing.
    expect(resolveControl('delay mix')?.path).toBe('effects.delay.wet');
    expect(resolveControl('amp env attack')?.path).toBe('voice.envelope.attack');
    expect(resolveControl('filter env attack')?.path).toBe('voice.filterEnvelope.attack');
  });

  it('shortens a name only as far as the drawn set allows', () => {
    // What the three debug panels were each deciding privately, and what two of them
    // decided differently for the same address.
    const filterPanel = [
      'voice.filterEnvelope.baseFrequency',
      'voice.filter.Q',
      'voice.filterEnvelope.attack',
    ] as const;
    // Nothing else on that panel is called "attack", so the bare label is unambiguous.
    expect(labelWithin('voice.filterEnvelope.attack', filterPanel)).toBe('attack');
    expect(labelWithin('voice.filterEnvelope.baseFrequency', filterPanel)).toBe('cutoff');

    // Put both envelopes in one set and it has to qualify — and qualify BOTH, not
    // whichever happened to come second.
    const bothEnvelopes = ['voice.envelope.attack', 'voice.filterEnvelope.attack'] as const;
    expect(labelWithin('voice.envelope.attack', bothEnvelopes)).toBe('amp env attack');
    expect(labelWithin('voice.filterEnvelope.attack', bothEnvelopes)).toBe('filter env attack');

    // The FX case: one effect card has a unique "mix"; the whole tab does not.
    expect(labelWithin('effects.delay.wet', ['effects.delay.wet', 'effects.delay.feedback'])).toBe(
      'mix',
    );
    expect(labelWithin('effects.delay.wet', ['effects.delay.wet', 'effects.chorus.wet'])).toBe(
      'delay mix',
    );
  });

  it('says nothing about an address that does not exist', () => {
    expect(resolveControl('ctl-999')).toBeUndefined();
    expect(resolveControl('warp drive')).toBeUndefined();
    expect(resolveControl('')).toBeUndefined();
  });
});

describe('the widget follows the contract rather than a preference', () => {
  it('draws each spec kind as something that can express it', () => {
    for (const control of CONTROLS) {
      const spec = PARAM_SPECS[control.path];
      switch (spec.kind) {
        case 'boolean':
          expect(control.widget, `${control.id} is a boolean`).toBe('toggle');
          break;
        case 'enum':
          // Buttons up to eight values, a list beyond. The only address past the line is
          // a route's destination, at 31 — and thirty-one buttons is not a glyph row.
          expect(control.widget, `${control.id} is an enum of ${spec.values.length}`).toBe(
            spec.values.length > 8 ? 'select' : 'glyphs',
          );
          break;
        case 'number':
          // A number with `choices` is a short list wearing a range, and a knob there can
          // reach values the engine refuses — `voice.filter.rolloff` is exactly that.
          if (spec.choices !== undefined) {
            expect(control.widget, `${control.id} has fixed choices`).toBe('glyphs');
          } else {
            expect(['knob', 'slider'], `${control.id} is a continuous number`).toContain(
              control.widget,
            );
          }
          break;
        case 'frequency':
          // Its own widget, not a knob. The value is a number of hertz OR a transport
          // subdivision, and a knob cannot express the second — `RateControl` reads the
          // value's type to decide which it is looking at.
          expect(control.widget, `${control.id} is a frequency`).toBe('rate');
          break;
      }
    }
  });

  it('puts the envelopes and the EQ on sliders, because they are read as a shape', () => {
    for (const path of ['voice.envelope.attack', 'voice.filterEnvelope.release'] as const) {
      expect(controlForPath(path)?.widget).toBe('slider');
    }
    expect(controlForPath('effects.eq.band2.gain')?.widget).toBe('slider');
    expect(controlForPath('master.volume')?.widget).toBe('slider');
    // And the cutoff is not a slider — it is the knob the whole panel is built around.
    expect(controlForPath('voice.filterEnvelope.baseFrequency')?.widget).toBe('knob');
  });
});

describe('no client keeps its own copy of the vocabulary', () => {
  // Read through Vite rather than node:fs — this repo does not carry @types/node, and a
  // gate is not worth a dependency.
  const sources = import.meta.glob('../clients/**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  it('finds client files to check, so the gate cannot pass by reading nothing', () => {
    // A glob that silently matches zero files is a green test that checks nothing, which
    // is the failure mode of every grep-shaped gate.
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it('never writes a range, a step or a unit into a component', () => {
    // Gate 6 from the phase plan. The mockups are full of literal min/max/step attributes
    // and copying one through is how a control produces values the dispatcher rejects —
    // the control looks right, moves smoothly and is silently refused.
    //
    // The kit is allowed `min={0} max={RESOLUTION}` on a track, because that is a count of
    // positions and not a claim about the parameter; the values it emits come from
    // `fromTrack`, which reads the spec. So the pattern targets literals that look like a
    // PARAMETER's bounds — anything that is not 0, 1 or a named constant.
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      if (!file.includes('/synth/')) continue;
      for (const line of source.split('\n')) {
        const match = /\b(min|max|step)=\{(-?\d+(?:\.\d+)?)\}/.exec(line);
        if (match === null) continue;
        if (['0', '1'].includes(match[2]!)) continue;
        offenders.push(`${file}: ${line.trim()}`);
      }
    }

    expect(offenders, 'a control is stating a range instead of reading its spec').toEqual([]);
  });

  it('never maps an address to a name outside core', () => {
    // The regression this closes. Three debug panels each grew a private label table
    // because each had to choose a name and had nowhere to record the choice; two of them
    // then disagreed about `voice.filterEnvelope.baseFrequency`. Catching the CLASS
    // matters more than catching those three: the fourth panel is the one nobody diffs.
    const patterns = [
      // 'voice.filter.Q': 'resonance'
      /'(?:voice|effects|master)\.[\w.]+'\s*:\s*'/,
      // { path: 'voice.filter.Q', label: 'resonance' }
      /path:\s*'(?:voice|effects|master)\.[\w.]+'\s*,\s*label:\s*'/,
    ];

    const offenders: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      for (const line of source.split('\n')) {
        if (patterns.some((pattern) => pattern.test(line))) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }

    expect(offenders, 'a client is naming an address instead of asking CONTROLS').toEqual([]);
  });
});

describe('the control layer agrees with the nav layer', () => {
  it('gives every control on a tab a label the tab can draw', () => {
    // The join the surface actually performs: NAV_TABS says what a tab holds, CONTROLS
    // says what to call it. A path in one and not the other is a blank knob.
    for (const tab of NAV_TABS) {
      for (const path of tabPaths(tab)) {
        expect(controlForPath(path), `${tab.id} draws "${path}" with no control`).toBeDefined();
      }
    }
  });
});
