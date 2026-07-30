/**
 * src/tests/mod-panel.browser.test.ts — the overflow indicator is actually visible.
 *
 * `modulation.test.ts` proves the arithmetic and `tone-runtime.audio.test.ts` proves the
 * arithmetic matches the audio. Neither proves the thing reaches a screen, and for a
 * feature whose entire content is *visibility* that is the gate that matters: an indicator
 * computed correctly and rendered nowhere is the silent clamp it was built to replace.
 *
 * `createElement` rather than JSX because the `dom` project's include glob is
 * `*.browser.test.ts`, and a `.tsx` would simply not be collected.
 */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModPanel } from '../clients/debug/ModPanel';
import { defaultPreset, initialEngineState } from '../core/state';
import type { EngineState } from '../core/state';
import type { ModRoute } from '../core/types';

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

function stateWith(routes: readonly ModRoute[]): EngineState {
  const patch = defaultPreset();
  return {
    ...initialEngineState(),
    patch: { ...patch, voice: { ...patch.voice, lfos: [lfo()], modRoutes: [...routes] } },
  };
}

function lfo() {
  return { id: 'lfo-0', enabled: true, type: 'sine' as const, frequency: 4, sync: false, retrigger: false };
}

function panRoute(id: string, depth: number): ModRoute {
  return { id, enabled: true, source: 'lfo.0', destination: 'voice.pan', depth };
}

async function renderPanel(state: EngineState): Promise<string> {
  await act(async () => {
    root.render(
      createElement(ModPanel, {
        state,
        onChange: () => undefined,
        onCommand: () => undefined,
      }),
    );
  });
  return container.textContent ?? '';
}

describe('ModPanel — the route-overflow indicator on screen', () => {
  it('says nothing when the routes fit, which is most of the time', async () => {
    // The half that keeps the warning meaningful. A banner that is always up is furniture.
    const text = await renderPanel(stateWith([panRoute('a', 0.4)]));

    expect(text).not.toContain('more travel than the parameter has');
  });

  it('names the destination and the numbers when they do not', async () => {
    const text = await renderPanel(stateWith([panRoute('a', 0.8), panRoute('b', 0.8)]));

    expect(text).toContain('more travel than the parameter has');
    expect(text).toContain('voice.pan');
    // The reach and the limit both, so the reading is "how far past" rather than "bad".
    expect(text).toContain('-1.60–1.60');
    expect(text).toContain('-1.00–1.00');
  });

  it('drops the warning again when a route is disabled — it tracks the patch', async () => {
    const routes = [panRoute('a', 0.8), panRoute('b', 0.8)];
    expect(await renderPanel(stateWith(routes))).toContain('more travel than the parameter has');

    const disabled = [routes[0] as ModRoute, { ...(routes[1] as ModRoute), enabled: false }];
    expect(await renderPanel(stateWith(disabled))).not.toContain(
      'more travel than the parameter has',
    );
  });

  it('shows what a depth means at its destination, not just the raw 0..1', async () => {
    // The other half of the Stage 3.5 surface, and the reason the curve had to land first.
    const text = await renderPanel(stateWith([panRoute('a', 0.4)]));

    expect(text).toContain('±0.40');
  });
});
