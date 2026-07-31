/**
 * src/tests/control-kit.browser.test.ts — the kit, drawn.
 *
 * The controls are where five decoys have been born, so the gates here are about reaching
 * a screen and dispatching a legal command, not about looking right. The strongest one
 * renders all 119 declared controls: a widget that disagrees with its spec throws by
 * construction, so this is the check that the registry's derivation and the components'
 * expectations are the same opinion.
 *
 * `createElement` rather than JSX because the `dom` project collects `*.browser.test.ts`
 * and a `.tsx` would not be picked up.
 */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTROLS, labelWithin } from '../core/controls';
import { getParam } from '../core/params';
import { PARAM_SPECS } from '../core/schemas';
import { defaultPreset, initialEngineState } from '../core/state';
import type { ParamPath, ParamValue } from '../core/types';
import { GlyphButtons, Knob, Toggle, renderControl } from '../clients/synth/controls';

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

const state = () => ({ ...initialEngineState(), patch: defaultPreset() });

async function draw(element: React.ReactNode): Promise<void> {
  await act(async () => root.render(element));
}

const ALL_PATHS = CONTROLS.map((control) => control.path);

describe('every declared control can be drawn', () => {
  it('renders all 119 without a widget disagreeing with its spec', async () => {
    // Each component throws when handed the wrong spec kind, so this passing means the
    // registry's widget derivation and the components' expectations agree for every
    // address — including the four that carry `choices` and must never get a knob.
    const engine = state();
    const drawn: string[] = [];

    for (const control of CONTROLS) {
      await draw(
        createElement(
          'div',
          null,
          renderControl({
            id: control.id,
            path: control.path,
            label: labelWithin(control.path, ALL_PATHS),
            spec: PARAM_SPECS[control.path],
            value: getParam(engine, control.path),
            onChange: () => undefined,
          }),
        ),
      );
      const node = container.querySelector(`[data-sag-id="${control.id}"]`);
      if (node !== null) drawn.push(control.id);
    }

    expect(drawn, 'controls that drew nothing addressable').toHaveLength(CONTROLS.length);
  });

  it('puts both handles on the DOM, because they answer different questions', async () => {
    // data-sag-id is the permanent handle a journal row or a terminal query uses;
    // data-sag-path is the contract address. Losing either makes the surface unaddressable
    // in a way nothing else would report.
    const control = CONTROLS.find((c) => c.path === 'voice.filterEnvelope.baseFrequency')!;
    await draw(
      createElement(Knob, {
        id: control.id,
        path: control.path,
        label: 'cutoff',
        spec: PARAM_SPECS[control.path],
        value: 800,
        onChange: () => undefined,
      }),
    );

    const node = container.querySelector('[data-sag-id="ctl-011"]');
    expect(node).not.toBeNull();
    expect(node?.getAttribute('data-sag-path')).toBe('voice.filterEnvelope.baseFrequency');
  });

  it('refuses an id it has never heard of instead of improvising a widget', () => {
    expect(() =>
      renderControl({
        id: 'ctl-999',
        path: 'voice.amplitude',
        label: 'level',
        spec: PARAM_SPECS['voice.amplitude'],
        value: 1,
        onChange: () => undefined,
      }),
    ).toThrow(/not a declared control/);
  });
});

describe('a control dispatches what the validator accepts', () => {
  it('never emits a value outside the declared range', async () => {
    // The knob's own arithmetic is gated in scale.test.ts; this is the half that proves
    // the component uses it rather than its own.
    const emitted: ParamValue[] = [];
    const spec = PARAM_SPECS['voice.filterEnvelope.baseFrequency'];
    if (spec.kind !== 'number') throw new Error('expected a number spec');

    await draw(
      createElement(Knob, {
        id: 'ctl-011',
        path: 'voice.filterEnvelope.baseFrequency' as ParamPath,
        label: 'cutoff',
        spec,
        value: 800,
        onChange: (_path, value) => emitted.push(value),
      }),
    );

    const dial = container.querySelector('svg')!;
    await act(async () => {
      dial.dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: 1, clientY: 300, bubbles: true }),
      );
      // Far past the top of the travel — the clamp is the thing being tested.
      dial.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, clientY: -900, bubbles: true }),
      );
      dial.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    });

    expect(emitted.length).toBeGreaterThan(0);
    for (const value of emitted) {
      expect(typeof value).toBe('number');
      expect(value as number).toBeGreaterThanOrEqual(spec.min);
      expect(value as number).toBeLessThanOrEqual(spec.max);
    }
  });

  it('drags up for more, which is the only direction anyone expects', async () => {
    const emitted: number[] = [];
    const spec = PARAM_SPECS['voice.amplitude'];

    await draw(
      createElement(Knob, {
        id: 'ctl-018',
        path: 'voice.amplitude' as ParamPath,
        label: 'level',
        spec,
        value: 0.5,
        onChange: (_path, value) => emitted.push(value as number),
      }),
    );

    const dial = container.querySelector('svg')!;
    await act(async () => {
      dial.dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: 1, clientY: 300, bubbles: true }),
      );
      dial.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, clientY: 250, bubbles: true }),
      );
    });

    expect(emitted[0]).toBeGreaterThan(0.5);
  });
});

describe('nothing declared is silently dropped', () => {
  it('draws a button for every legal value, including ones with no glyph', async () => {
    // The glyph map is decoration with a fallback. An enum member added to the contract
    // and missing from the map must appear as text, never vanish — a value the schema
    // accepts and the screen omits is unreachable.
    const spec = PARAM_SPECS['voice.filter.type'];
    if (spec.kind !== 'enum') throw new Error('expected an enum spec');

    await draw(
      createElement(GlyphButtons, {
        id: 'ctl-004',
        path: 'voice.filter.type' as ParamPath,
        label: 'type',
        spec,
        value: 'lowpass',
        onChange: () => undefined,
      }),
    );

    const buttons = [...container.querySelectorAll('button')];
    expect(buttons).toHaveLength(spec.values.length);
    // Named for a screen reader even where the face is a glyph.
    for (const option of spec.values) {
      expect(buttons.some((button) => button.getAttribute('aria-label') === option)).toBe(true);
    }
  });

  it('shows the reason a control is ignored rather than just dimming it', async () => {
    // Amber alone reads as "disabled". The pan decoy survived 86 audio gates partly
    // because nothing on screen ever said what was wrong.
    await draw(
      createElement(Toggle, {
        id: 'ctl-040',
        path: 'voice.oscillators.0.enabled' as ParamPath,
        label: 'on',
        spec: PARAM_SPECS['voice.oscillators.0.enabled'],
        value: true,
        onChange: () => undefined,
        state: 'ignored',
        reason: 'a sawtooth has no width',
      }),
    );

    expect(container.textContent).toContain('a sawtooth has no width');
  });
});
