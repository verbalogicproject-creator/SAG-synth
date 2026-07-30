/**
 * src/tests/osc-panel.browser.test.ts — three slots are reachable, not just implemented.
 *
 * The engine gates prove two detuned oscillators beat. They cannot prove there is a way to
 * add the second one, and on this project that gap is not theoretical: velocity shipped
 * behind a keyboard sending a hardcoded 0.8, the EQ toggle was refused at validation for
 * two stages, and distortion shipped at a default nobody could hear switch on. Every one
 * of those was a working engine with no honest control in front of it.
 *
 * `createElement` rather than JSX because the `dom` project's glob is `*.browser.test.ts`.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OscillatorPanel, SLOT_LABELS } from '../clients/debug/OscillatorPanel';
import { OSC_PARAM_KEYS } from '../core/schemas';
import { reduce } from '../core/reduce';
import { initialEngineState, type EngineState } from '../core/state';
import { MAX_OSCILLATORS, type ParamPath, type ParamValue } from '../core/types';
import type { SynthCommand } from '../core/commands';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let commands: SynthCommand[];
let changes: [ParamPath, ParamValue][];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  commands = [];
  changes = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderPanel(state: EngineState): Promise<string> {
  await act(async () => {
    root.render(
      createElement(OscillatorPanel, {
        state,
        onChange: (path: ParamPath, value: ParamValue) => changes.push([path, value]),
        onCommand: (command: SynthCommand) => commands.push(command),
        unsupported: [],
      }),
    );
  });
  return container.textContent ?? '';
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((element) =>
    element.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
}

/** Run real commands through the real reducer — no hand-built state shapes. */
function stateWithSlots(count: number): EngineState {
  let state = initialEngineState();
  for (let i = state.patch.voice.oscillators.length; i < count; i += 1) {
    const result = reduce(
      state,
      {
        type: 'addOscillator',
        config: {
          id: `osc-${i}`,
          enabled: true,
          type: 'sawtooth',
          octave: 0,
          detune: 0,
          count: 1,
          spread: 20,
          width: 0,
          level: 1,
          pan: 0,
        },
      },
      { commandId: `c${i}`, ts: 1 },
    );
    if (result.status !== 'applied') throw new Error(result.error);
    state = result.state;
  }
  return state;
}

describe('OscillatorPanel — the slots are reachable', () => {
  it('draws one panel per filled slot, and no panel for a slot the patch has not added', async () => {
    // The factory patch ships with one. Drawing three would offer controls that address
    // slots the reducer refuses — a decoy, which is the failure this whole surface exists
    // to avoid.
    const text = await renderPanel(stateWithSlots(1));
    expect(text).toContain('slot 0');
    expect(text).not.toContain('slot 1');

    expect(await renderPanel(stateWithSlots(3))).toContain('slot 2');
  });

  it('gives every declared per-slot parameter a control', async () => {
    // Generated from OSC_PARAM_KEYS, so a key added to the contract appears here without
    // this file changing — and a key that stops being drawn fails.
    const text = await renderPanel(stateWithSlots(1));
    for (const key of OSC_PARAM_KEYS) {
      expect(text, `no control for "${key}"`).toContain(SLOT_LABELS[key] ?? key);
    }
  });

  it('adds a slot through the command, not by mutating state', async () => {
    await renderPanel(stateWithSlots(1));
    await act(async () => button('oscillator slot')?.click());

    expect(commands).toHaveLength(1);
    expect(commands[0]?.type).toBe('addOscillator');
  });

  it('stops offering to add once the cap is full', async () => {
    await renderPanel(stateWithSlots(MAX_OSCILLATORS));
    expect(button('oscillator slot')?.disabled).toBe(true);
  });

  it('refuses to remove the last slot, matching what the reducer would say', async () => {
    // A voice with no oscillator is a well-formed document that can never sound. The
    // reducer rejects it; the control must not offer it, or the surface promises something
    // the engine will refuse.
    await renderPanel(stateWithSlots(1));
    expect(button('remove')?.disabled).toBe(true);

    await renderPanel(stateWithSlots(2));
    expect(button('remove')?.disabled).toBe(false);
  });

  it('addresses the right slot when a control moves', async () => {
    // The indexed path is the part a hand-written panel gets wrong: every control on
    // slot 1 writing to slot 0 looks completely normal until two slots differ.
    await renderPanel(stateWithSlots(2));
    const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
    expect(boxes).toHaveLength(2);

    await act(async () => (boxes[1] as HTMLInputElement).click());
    expect(changes).toEqual([['voice.oscillators.1.enabled', false]]);
  });
});
