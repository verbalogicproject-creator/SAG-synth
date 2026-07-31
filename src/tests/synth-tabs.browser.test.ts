/**
 * src/tests/synth-tabs.browser.test.ts — everything the nav claims is reachable by hand.
 *
 * `groups.test.ts` proves the declaration covers all 119 addresses. That is arithmetic. It
 * says nothing about whether a finger can get to them, and "declared, validated, journalled
 * and unreachable" is the failure this project has shipped six times.
 *
 * So this one clicks. It walks every tab, every sub-tab and every oscillator slot, collects
 * the `data-sag-path` of everything actually on screen, and compares that against what
 * `NAV_TABS` says the four tabs own. Generated from the declaration, so a contract change
 * surfaces here without this file being edited.
 */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NAV_TABS, tabPaths } from '../core/groups';
import { defaultPreset, initialEngineState } from '../core/state';
import type { EngineState } from '../core/state';
import type { ParamPath } from '../core/types';
import type { SynthCommand } from '../core/commands';
import { SynthPanels } from '../clients/synth/SynthPanels';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** Three sounding slots, so the whole oscillator family is addressable. */
function fullState(): EngineState {
  const patch = defaultPreset();
  const slot = patch.voice.oscillators[0]!;
  return {
    ...initialEngineState(),
    patch: {
      ...patch,
      voice: {
        ...patch.voice,
        oscillators: [slot, { ...slot, id: 'osc-1' }, { ...slot, id: 'osc-2' }],
      },
    },
  };
}

async function mount(state: EngineState, sink?: { commands: SynthCommand[] }) {
  await act(async () => {
    root.render(
      createElement(SynthPanels, {
        state,
        onChange: () => undefined,
        onCommand: (command: SynthCommand) => sink?.commands.push(command),
      }),
    );
  });
}

const click = async (element: Element) => {
  await act(async () => {
    (element as HTMLElement).click();
  });
};

const visiblePaths = () =>
  [...container.querySelectorAll('[data-sag-path]')].map(
    (node) => node.getAttribute('data-sag-path') as ParamPath,
  );

/** Every button that switches something, in the order a finger would find them. */
const tabButtons = () => [...container.querySelectorAll('[role="tab"]')];

/**
 * Walk the whole surface and record everything that appears. Sub-tabs and slot letters are
 * both `role="tab"`, so re-reading the list after each click handles the nesting without
 * this test knowing the structure — which is the point, since the structure is declared.
 */
async function sweep(state: EngineState): Promise<Set<string>> {
  const seen = new Set<string>();
  await mount(state);

  for (let top = 0; top < NAV_TABS.length; top += 1) {
    await click(tabButtons()[top]!);
    visiblePaths().forEach((path) => seen.add(path));

    // Everything after the top-level tabs is a sub-tab or a slot letter.
    let inner = NAV_TABS.length;
    while (inner < tabButtons().length) {
      await click(tabButtons()[inner]!);
      visiblePaths().forEach((path) => seen.add(path));
      inner += 1;
      // Re-select the top tab's row in case the click changed how many inner tabs exist.
      await click(tabButtons()[top]!);
    }
  }

  return seen;
}

describe('the four tabs reach everything they claim', () => {
  it('draws every address NAV_TABS assigns to a tab', async () => {
    const claimed = NAV_TABS.flatMap((tab) => tabPaths(tab));
    const seen = await sweep(fullState());

    const missing = claimed.filter((path) => !seen.has(path));
    expect(missing, 'declared on a tab and reachable from nowhere').toEqual([]);
  });

  it('draws nothing that belongs to the settings screen or the bay', async () => {
    // The other direction. Voicing lives behind the gear and routing lives in an overlay;
    // a route's depth appearing on the FX tab would mean the nav declaration and the
    // panels disagree about what a tab is.
    const seen = await sweep(fullState());
    const strays = [...seen].filter(
      (path) => path.startsWith('voice.modRoutes.') || path === 'voice.polyphony',
    );

    expect(strays, 'a tab drew something it does not own').toEqual([]);
  });

  it('gives every drawn control its permanent handle as well as its address', async () => {
    await mount(fullState());
    const nodes = [...container.querySelectorAll('[data-sag-path]')];

    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(
        node.getAttribute('data-sag-id'),
        node.getAttribute('data-sag-path') ?? 'a control with no address',
      ).toMatch(/^ctl-\d{3}$/);
    }
  });
});

describe('the surface speaks in commands', () => {
  it('bypasses an effect with a command rather than by editing the patch', async () => {
    // `setEffectEnabled` is a verb while `effects.eq.enabled` is a parameter — an
    // asymmetry a player cannot see. What matters is that both go through the dispatcher,
    // so both are journalled and replayable.
    const sink = { commands: [] as SynthCommand[] };
    await mount(fullState(), sink);
    await click(tabButtons()[3]!);

    const bypass = container.querySelector('[aria-label="delay active"]');
    expect(bypass).not.toBeNull();
    await click(bypass!);

    // Every effect ships bypassed, so the first press turns one ON. Asserting `false`
    // here would have been asserting my assumption about the factory patch rather than
    // what the button does.
    expect(sink.commands).toContainEqual({
      type: 'setEffectEnabled',
      effectId: 'delay',
      enabled: true,
    });
  });

  it('adds and removes oscillator slots by id, never by position', async () => {
    // Position is what the list reorders; the id is what replay reproduces.
    const sink = { commands: [] as SynthCommand[] };
    await mount(fullState(), sink);
    await click(tabButtons()[0]!);

    await click(container.querySelector('[aria-label="remove oscillator A"]')!);
    expect(sink.commands).toContainEqual({ type: 'removeOscillator', oscillatorId: 'osc-0' });
  });

  it('offers no fourth slot, because a fourth slot cannot work', async () => {
    // MAX_OSCILLATORS is three. A plus button at the cap would dispatch a command the
    // reducer refuses, which is a control that appears to work.
    await mount(fullState());
    await click(tabButtons()[0]!);

    expect(container.querySelector('[aria-label="add an oscillator slot"]')).toBeNull();
  });
});

describe('a control that cannot be honoured says so on screen', () => {
  it('marks a width the patch sets on a shape that has none', async () => {
    // The `ignored` state, drawn. Amber alone reads as "disabled", so the reason is on the
    // screen rather than behind a hover a phone does not have.
    const state = fullState();
    const slot = state.patch.voice.oscillators[0]!;
    const withWidth: EngineState = {
      ...state,
      patch: {
        ...state.patch,
        voice: {
          ...state.patch.voice,
          oscillators: [{ ...slot, type: 'sawtooth', width: 0.5 }, ...state.patch.voice.oscillators.slice(1)],
        },
      },
    };

    await mount(withWidth);
    await click(tabButtons()[0]!);

    expect(container.textContent).toContain('only a pulse has width');
  });

  it('says nothing of the sort about the factory patch', async () => {
    // A state that is always showing is furniture, and the first thing a player sees must
    // not be a wall of amber.
    await mount(fullState());
    await click(tabButtons()[0]!);

    expect(container.textContent).not.toContain('only a pulse has width');
  });
});
