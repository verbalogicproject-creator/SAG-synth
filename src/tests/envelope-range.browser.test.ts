/**
 * src/tests/envelope-range.browser.test.ts — the short/long range switches and the filter's
 * link to the amp, mounted in the real envelope group.
 *
 * Eyal, 2026-09-18: "attack, decay and release to have a toggle that switches from 0s-20s to
 * 0s-2s … plus a toggle in filter to mirror the AMP AHDSR parameters to filter".
 */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialEngineState, type EngineState } from '../core/state';
import { reduce } from '../core/reduce';
import type { ParamPath, ParamValue } from '../core/types';
import { EnvelopeGroup } from '../clients/synth/groups';
import { surfaceContext } from '../clients/synth/controlProps';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  container.style.width = '360px';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

type Which = 'amp' | 'filter';

/** Mount one envelope group over `state`, writing every change back through the reducer's setter. */
async function mount(which: Which, start: EngineState, writes: Array<[ParamPath, ParamValue]> = []) {
  let state = start;
  const onChange = (path: ParamPath, value: ParamValue) => {
    writes.push([path, value]);
    state = setParam(state, path, value);
    // Already inside the act() of the click or slide that caused it.
    draw();
  };
  const prefix = which === 'amp' ? 'voice.envelope' : 'voice.filterEnvelope';
  const draw = () =>
      root.render(
        createElement(EnvelopeGroup, {
          context: surfaceContext(state, onChange),
          label: `${which} envelope`,
          stages: [`${prefix}.attack`, `${prefix}.decay`, `${prefix}.sustain`, `${prefix}.release`] as unknown as readonly [
            ParamPath,
            ParamPath,
            ParamPath,
            ParamPath,
          ],
          hold: `${prefix}.hold` as ParamPath,
          curve: `${prefix}.decayCurve` as ParamPath,
          ...(which === 'filter' ? { link: 'voice.filterEnvelope.linked' as ParamPath } : {}),
        }),
      );
  await act(async () => draw());
  return { get: () => state };
}

const input = (path: string) => container.querySelector(`input[data-sag-path="${path}"]`) as HTMLInputElement;
const rangeSwitch = (label: string) =>
  container.querySelector(`button[aria-label="${label} range"]`) as HTMLButtonElement | null;

/** Move a native range input to `position` (0..1000) the way React hears it. */
async function slide(path: string, position: number) {
  const el = input(path);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, String(position));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Through the reducer, so a write the validator would refuse fails the test instead of passing. */
function setParam(state: EngineState, path: ParamPath, value: ParamValue): EngineState {
  const result = reduce(state, { type: 'setParam', path, value } as never, { commandId: 'c', ts: 1 });
  if (result.status !== 'applied') throw new Error(`setParam ${path}=${String(value)}: ${result.status}`);
  return result.state;
}

function withValue(path: ParamPath, value: ParamValue): EngineState {
  return setParam(initialEngineState(), path, value);
}

describe('the short/long range switch', () => {
  it('sits beside the attack, decay and release labels — and not the hold or sustain', async () => {
    await mount('amp', initialEngineState());
    for (const name of ['attack', 'decay', 'release']) {
      const button = rangeSwitch(name);
      expect(button, `no range switch beside ${name}`).not.toBeNull();
      // Beside the label, in the slider's head row — the spot Eyal marked.
      const head = button!.closest('div');
      expect(head?.textContent?.toLowerCase()).toContain(name);
    }
    expect(rangeSwitch('hold')).toBeNull();
    expect(rangeSwitch('sustain')).toBeNull();
  });

  it('short (the default) spends the whole travel on 0–2 s; long on 0–20 s', async () => {
    const writes: Array<[ParamPath, ParamValue]> = [];
    await mount('amp', initialEngineState(), writes);
    expect(rangeSwitch('decay')!.textContent).toBe('2S');
    await slide('voice.envelope.decay', 1000);
    expect(writes.at(-1)).toEqual(['voice.envelope.decay', 2]);

    await act(async () => rangeSwitch('decay')!.click());
    expect(rangeSwitch('decay')!.textContent).toBe('20S');
    await slide('voice.envelope.decay', 1000);
    expect(writes.at(-1)).toEqual(['voice.envelope.decay', 20]);
    // Back to short for the next test — the choice is kept for the session on purpose.
    await slide('voice.envelope.decay', 50);
    await act(async () => rangeSwitch('decay')!.click());
    expect(rangeSwitch('decay')!.textContent).toBe('2S');
  });

  it('switching range writes nothing — it is a view of the travel, not a parameter', async () => {
    const writes: Array<[ParamPath, ParamValue]> = [];
    await mount('amp', initialEngineState(), writes);
    await act(async () => rangeSwitch('attack')!.click());
    await act(async () => rangeSwitch('attack')!.click());
    expect(writes).toEqual([]);
  });

  it('a value over 2 s shows long and refuses short until it fits, instead of pinning a lie', async () => {
    const writes: Array<[ParamPath, ParamValue]> = [];
    await mount('amp', withValue('voice.envelope.release', 5), writes);
    const button = rangeSwitch('release')!;
    expect(button.textContent).toBe('20S');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await act(async () => button.click());
    expect(rangeSwitch('release')!.textContent).toBe('20S');
    expect(writes).toEqual([]);
    // The thumb sits where 5 s really is on a 20 s travel.
    expect(Number(input('voice.envelope.release').value)).toBe(250);
  });

  it('is a real touch target that does not stretch the label row', async () => {
    await mount('amp', initialEngineState());
    const box = rangeSwitch('attack')!.getBoundingClientRect();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});

describe('the filter envelope linked to the amp', () => {
  it('offers the link on the filter envelope only', async () => {
    await mount('amp', initialEngineState());
    expect(container.querySelector('[data-sag-path="voice.filterEnvelope.linked"]')).toBeNull();
    await mount('filter', initialEngineState());
    expect(container.querySelector('[data-sag-path="voice.filterEnvelope.linked"]')).not.toBeNull();
  });

  it('linking draws the amp stages, drops the handles, and marks the filter stages ignored', async () => {
    const view = await mount('filter', initialEngineState());
    expect(container.querySelectorAll('[role="slider"][aria-label^="filter envelope"]').length).toBeGreaterThan(0);

    const toggle = container.querySelector('[data-sag-path="voice.filterEnvelope.linked"]') as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(view.get().patch.voice.filterEnvelope.linked).toBe(true);

    // No handles: a drag here would edit a stored value the filter is not running.
    expect(container.querySelectorAll('[role="slider"][aria-label^="filter envelope"]')).toHaveLength(0);
    // The curve names what it draws, with the AMP's numbers.
    const amp = view.get().patch.voice.envelope;
    const picture = container.querySelector('svg[role="img"]')!.getAttribute('aria-label')!;
    expect(picture).toContain('linked to amp');
    expect(picture).toContain(`decay ${amp.decay}s`);
    // And the filter's own stage sliders say why they are not in charge.
    expect(container.textContent).toContain('linked to the amp envelope');
  });
});
