/**
 * src/tests/fx-panel.browser.test.ts — the FX controls exist and dispatch what they claim.
 *
 * Written because distortion was reported as not working three times, and the last link in
 * the chain had never been tested: everything from `validateCommand` down to the rendered
 * buffer was gated, but "is there a distortion toggle on the panel, and does ticking it
 * send `setEffectEnabled` for the right effect" was assumed. That assumption is exactly the
 * one the `'eq'` bug broke — the audio was perfect for two stages while the command was
 * refused before it ever reached the graph.
 *
 * `createElement` rather than JSX because the `dom` project's include glob is
 * `*.browser.test.ts`, and a `.tsx` would simply not be collected.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FxPanel } from '../clients/debug/FxPanel';
import { EFFECT_CHAIN_ORDER } from '../core/types';
import { initialEngineState } from '../core/state';
import type { SynthCommand } from '../core/commands';
import type { ParamPath, ParamValue } from '../core/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let commands: SynthCommand[];
let changes: [ParamPath, ParamValue][];

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  commands = [];
  changes = [];
  await act(async () => {
    root.render(
      createElement(FxPanel, {
        state: initialEngineState(),
        onChange: (path: ParamPath, value: ParamValue) => changes.push([path, value]),
        onCommand: (command: SynthCommand) => commands.push(command),
      }),
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** The checkbox sitting next to a given effect's name in its header. */
function toggleFor(effectId: string): HTMLInputElement {
  const heading = Array.from(container.querySelectorAll('strong')).find(
    (element) => element.textContent === effectId,
  );
  expect(heading, `no "${effectId}" section on the FX panel`).toBeDefined();
  const box = heading?.parentElement?.querySelector('input[type="checkbox"]');
  expect(box, `"${effectId}" has no enable toggle`).toBeTruthy();
  return box as HTMLInputElement;
}

/**
 * Drive a controlled range input the way a finger does. React listens for the native
 * `input` event and reads the value off its own descriptor, so assigning `.value`
 * directly is invisible to it — the prototype setter is the part that makes it real.
 */
function setRangeValue(input: HTMLInputElement, value: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('FxPanel — every effect in the chain is reachable', () => {
  it('renders a section and a toggle for every effect, distortion included', () => {
    // Breadth on purpose. The one that was broken was the one nobody thought to check.
    for (const effectId of EFFECT_CHAIN_ORDER) {
      expect(toggleFor(effectId).checked).toBe(false);
    }
  });

  it('sends setEffectEnabled with the right id when distortion is ticked', async () => {
    const box = toggleFor('distortion');
    await act(async () => {
      box.click();
    });

    expect(commands).toEqual([{ type: 'setEffectEnabled', effectId: 'distortion', enabled: true }]);
  });

  it('gives distortion its drive and mix controls, not just a toggle', () => {
    // An effect that can be switched on but not adjusted is half a control. Both of
    // distortion's declared parameters are in the `effects` section of SIGNAL_CHAIN, so
    // both must reach the panel.
    const text = container.textContent ?? '';
    expect(text).toContain('drive');
    expect(text).toContain('mix');
  });

  it('moves the drive control through setParam on the declared path', async () => {
    // The slider carries POSITIONS, not the parameter's own units — `ParamControl` maps
    // them through the spec on the way out. That is the property `arch/clients.ngf.md`
    // asks for: a control carrying its own max produces values the dispatcher rejects,
    // which is how a knob ends up silently doing nothing. So this asserts what comes OUT
    // of the control, in the parameter's units, rather than what the markup says.
    const drive = Array.from(container.querySelectorAll('span'))
      .find((element) => element.textContent?.startsWith('drive'))
      ?.parentElement?.querySelector('input[type="range"]') as HTMLInputElement | undefined;
    expect(drive, 'no slider under the "drive" label').toBeTruthy();

    await act(async () => {
      setRangeValue(drive!, Number(drive!.max));
    });

    expect(changes).toHaveLength(1);
    const [path, value] = changes[0]!;
    expect(path).toBe('effects.distortion.amount');
    expect(typeof value === 'number' && value >= 0 && value <= 1, `drive emitted ${value}`).toBe(
      true,
    );
  });
});
