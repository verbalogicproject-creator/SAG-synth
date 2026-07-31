/**
 * src/tests/route-list.browser.test.ts — routing, and the eighteen that go nowhere.
 *
 * The list is the routing surface that ships if the jackfield slips, so it carries the
 * whole obligation on its own: every route editable, every destination offered, and the
 * eighteen unwired ones distinguishable from the thirteen that work.
 *
 * That last one is the point of the stage. `route-wiring.audio.test.ts` proves which
 * thirteen move audio; this proves a player can tell which they picked.
 */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RouteList } from '../clients/synth/RouteList';
import { surfaceContext } from '../clients/synth/controlProps';
import { defaultPreset, initialEngineState } from '../core/state';
import type { EngineState } from '../core/state';
import type { SynthCommand } from '../core/commands';
import {
  MAX_ROUTES,
  UNWIRED_MOD_DESTINATIONS,
  WIRED_MOD_DESTINATIONS,
  type ModDestination,
  type ModRoute,
} from '../core/types';
import { PARAM_SPECS } from '../core/schemas';

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

function route(id: string, destination: ModDestination, depth = 0.3): ModRoute {
  return { id, enabled: true, source: 'lfo.0', destination, depth };
}

function stateWith(routes: readonly ModRoute[]): EngineState {
  const patch = defaultPreset();
  return {
    ...initialEngineState(),
    patch: {
      ...patch,
      voice: {
        ...patch.voice,
        lfos: [{ id: 'lfo-0', enabled: true, type: 'sine', frequency: 4, sync: false, retrigger: false }],
        modRoutes: [...routes],
      },
    },
  };
}

const commands: SynthCommand[] = [];

async function draw(state: EngineState): Promise<string> {
  commands.length = 0;
  await act(async () => {
    root.render(
      createElement(RouteList, {
        context: surfaceContext(state, () => undefined),
        onCommand: (command: SynthCommand) => commands.push(command),
      }),
    );
  });
  return container.textContent ?? '';
}

const click = async (element: Element) => {
  await act(async () => (element as HTMLElement).click());
};

describe('a route can be built and taken apart', () => {
  it('offers every declared destination, all thirty-one', () => {
    // The picker is generated from the enum, so a destination added to the contract
    // appears here without this file changing — and one dropped from the picker by hand
    // would be a target the schema accepts and the surface cannot reach.
    const spec = PARAM_SPECS['voice.modRoutes.0.destination'];
    if (spec.kind !== 'enum') throw new Error('expected an enum spec');

    expect(spec.values).toHaveLength(
      WIRED_MOD_DESTINATIONS.length + UNWIRED_MOD_DESTINATIONS.length,
    );
  });

  it('draws a picker holding all of them, grouped down the signal path', async () => {
    await draw(stateWith([route('r0', 'voice.filterEnvelope.baseFrequency')]));

    const select = container.querySelector('select[aria-label="destination"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.options).toHaveLength(31);
    // Grouped rather than a flat 31-item list.
    expect(select.querySelectorAll('optgroup').length).toBeGreaterThan(1);
  });

  it('adds and removes by id, and refuses to offer a ninth slot', async () => {
    await draw(stateWith([route('r0', 'voice.amplitude')]));
    await click(container.querySelector('[aria-label="remove route 1"]')!);
    expect(commands).toContainEqual({ type: 'removeRoute', routeId: 'r0' });

    const full = Array.from({ length: MAX_ROUTES }, (_unused, i) =>
      route(`r${i}`, 'voice.amplitude'),
    );
    const text = await draw(stateWith(full));
    // A press the reducer would refuse is a control that appears to work.
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '+ route')).toBe(
      false,
    );
    expect(text).toContain(`All ${MAX_ROUTES} route slots are in use`);
  });
});

describe('the eighteen that reach nothing say so', () => {
  it('marks an unwired destination on the row, not just in the list', async () => {
    // `effects.delay.wet` is a working parameter and a dead modulation target. A player
    // choosing it must be told the ROUTE does nothing, without being told the knob is
    // broken — those are different sentences about different things.
    const text = await draw(stateWith([route('r0', 'effects.delay.wet')]));

    expect(text).toContain('nothing is connected at the far end');
    expect(text).toContain('reaches no audio node yet');
  });

  it('says nothing of the sort about a wired one', async () => {
    // A warning that is always up is furniture, and thirteen destinations work perfectly.
    const text = await draw(stateWith([route('r0', 'voice.filterEnvelope.baseFrequency')]));

    expect(text).not.toContain('nothing is connected at the far end');
  });

  it('spells the far end in the same words as every other screen', async () => {
    // One vocabulary. The bay calling it `voice.filterEnvelope.baseFrequency` while the
    // filter tab calls it "cutoff" would make the two screens describe different synths.
    await draw(stateWith([route('r0', 'voice.filterEnvelope.baseFrequency')]));
    const select = container.querySelector('select[aria-label="destination"]') as HTMLSelectElement;

    expect(select.selectedOptions[0]?.textContent).toBe('filter cutoff');
    expect(container.textContent).not.toContain('baseFrequency');
  });
});

describe('what a depth means where it lands', () => {
  it('reads the destination curve rather than the raw number', async () => {
    // Same 0.5, two destinations, two meanings — octaves at the cutoff and dB at the
    // amplitude. Derived from the declared curve, never a switch in the component.
    const octaves = await draw(stateWith([route('r0', 'voice.filterEnvelope.baseFrequency', 0.5)]));
    expect(octaves).toContain('oct');

    const duck = await draw(stateWith([route('r0', 'voice.amplitude', 0.5)]));
    expect(duck).toContain('dB');
  });

  it('draws the sign, because a negative depth points the other way', async () => {
    const positive = await draw(stateWith([route('r0', 'voice.filterEnvelope.baseFrequency', 0.5)]));
    expect(positive).toContain('+');

    const negative = await draw(stateWith([route('r0', 'voice.filterEnvelope.baseFrequency', -0.5)]));
    expect(negative).toContain('−');
  });
});

describe('overflow is reported, never corrected', () => {
  it('names the destination and both ranges when the routes ask for too much', async () => {
    const text = await draw(
      stateWith([route('a', 'voice.pan', 0.8), route('b', 'voice.pan', 0.8)]),
    );

    expect(text).toContain('more travel than the parameter has');
    expect(text).toContain('Lower a depth, or accept the clamp');
  });

  it('stays quiet when the routes fit', async () => {
    const text = await draw(stateWith([route('a', 'voice.pan', 0.4)]));
    expect(text).not.toContain('more travel than the parameter has');
  });
});

describe('the list tells the truth about the patch around it', () => {
  it('says when a route has no source to be driven by', async () => {
    // Sources are declared for four LFOs whether the patch holds any or not, so a route
    // can point at lfo.0 when there is no lfo.0. A row that looked connected would be a
    // decoy assembled out of two correct halves.
    const patch = defaultPreset();
    const state: EngineState = {
      ...initialEngineState(),
      patch: {
        ...patch,
        voice: { ...patch.voice, lfos: [], modRoutes: [route('r0', 'voice.amplitude')] },
      },
    };

    expect(await draw(state)).toContain('no LFOs');
  });
});
