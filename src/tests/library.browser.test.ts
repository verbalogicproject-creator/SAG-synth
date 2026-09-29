/**
 * src/tests/library.browser.test.ts — the LIBRARY sheet (C3b), mounted.
 *
 * Commands are captured and replayed through the real reducer; the Android shell's
 * `saveFile` is stood in for by a fake that keeps what it was handed, so the export is
 * checked as the bytes that would land in Download/SAG/.
 */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SynthCommand } from '../core/commands';
import { reduce } from '../core/reduce';
import { parsePresetFile } from '../core/session';
import { defaultPreset, initialEngineState, type EngineState } from '../core/state';
import { LibrarySheet } from '../clients/synth/LibrarySheet';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let saved: Array<{ name: string; mime: string; base64: string }>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  saved = [];
  window.AndroidBridge = {
    postResult: () => {},
    observe: () => {},
    log: () => {},
    saveFile: (name, mime, base64) => {
      saved.push({ name, mime, base64 });
      return JSON.stringify({ ok: true, path: `Download/SAG/${name}` });
    },
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.AndroidBridge;
});

/** Mount over a live state: every command goes through the reducer and re-renders. */
async function mount(start: EngineState = initialEngineState()) {
  let state = start;
  const commands: SynthCommand[] = [];
  const draw = () => root.render(createElement(LibrarySheet, { state, onCommand }));
  function onCommand(command: SynthCommand) {
    commands.push(command);
    const result = reduce(state, command, { commandId: `cmd-${commands.length}`, ts: 1 });
    if (result.status !== 'applied') throw new Error(`${command.type} refused: ${JSON.stringify(result)}`);
    state = result.state;
    draw();
  }
  await act(async () => draw());
  return { get state() { return state; }, commands };
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  ) as HTMLButtonElement | undefined;

async function type(el: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const decode = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

describe('the library', () => {
  it('SAVE AS puts the current sound in the library under its name', async () => {
    const view = await mount();
    await type(container.querySelector('input[aria-label="preset name"]')!, 'First Psy Melody');
    await act(async () => button('SAVE')!.click());
    // The category is pre-filled from the current sound (the factory patch is a Lead).
    expect(view.commands.at(-1)).toMatchObject({ type: 'savePreset', name: 'First Psy Melody' });
    expect(button('load First Psy Melody')).toBeDefined();
    expect(container.textContent).toContain('MINE 1');
  });

  it('refuses to save without a name, and says so', async () => {
    const view = await mount();
    await type(container.querySelector('input[aria-label="preset name"]')!, '   ');
    await act(async () => button('SAVE')!.click());
    expect(view.commands).toEqual([]);
    expect(container.textContent).toContain('Give the sound a name first');
  });

  it('tapping a preset loads it', async () => {
    const view = await mount();
    const psy = Object.values(view.state.presets).find((p) => p.id !== view.state.patch.id)!;
    await act(async () => button(`load ${psy.name}`)!.click());
    expect(view.state.patch.id).toBe(psy.id);
  });

  it('delete takes two taps, and only your own presets have it', async () => {
    const view = await mount();
    for (const p of Object.values(view.state.presets)) expect(button(`delete ${p.name}`)).toBeUndefined();
    await type(container.querySelector('input[aria-label="preset name"]')!, 'Temp');
    await act(async () => button('SAVE')!.click());
    await act(async () => button('delete Temp')!.click());
    expect(view.commands.at(-1)?.type).toBe('savePreset');
    await act(async () => button('really delete Temp')!.click());
    expect(view.commands.at(-1)?.type).toBe('deletePreset');
    expect(button('load Temp')).toBeUndefined();
  });

  it('export hands the shell a JSON file that imports back as the same sound', async () => {
    const view = await mount();
    const psy = Object.values(view.state.presets).find((p) => p.name.toLowerCase().includes('psy'))!;
    await act(async () => button(`export ${psy.name}`)!.click());
    expect(saved).toHaveLength(1);
    expect(saved[0]!.mime).toBe('application/json');
    expect(saved[0]!.name.endsWith('.json')).toBe(true);
    const read = parsePresetFile(decode(saved[0]!.base64));
    expect(read.errors).toEqual([]);
    expect(read.presets[0]!.voice).toEqual(psy.voice);
    expect(container.textContent).toContain('Download/SAG/');
  });

  it('import reads a file, upgrades old presets, and names the bad ones', async () => {
    const view = await mount();
    const old = structuredClone({ ...defaultPreset(), id: 'from-a-friend', name: 'Friend Bass', factory: false }) as any;
    old.schemaVersion = 5;
    delete old.voice.filter.drive;
    delete old.voice.filterEnvelope.linked;
    const file = new File([JSON.stringify([old, { name: 'Junk' }])], 'friend.json', { type: 'application/json' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    await act(async () => {
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(view.commands.map((c) => c.type)).toEqual(['importPreset']);
    expect(view.state.presets['from-a-friend']?.voice.filter.drive).toBe(0);
    expect(container.textContent).toContain('Imported 1 preset.');
    expect(container.textContent).toContain('"Junk"');
  });

  it('a file holding a copy of a factory preset comes in as your own, not over the factory one', async () => {
    const view = await mount();
    const factory = defaultPreset();
    const file = new File([JSON.stringify({ ...factory, name: 'My Take' })], 'f.json');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    await act(async () => {
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(view.state.presets[factory.id]?.name).toBe(factory.name);
    expect(Object.values(view.state.presets).some((p) => p.name === 'My Take' && p.factory === false)).toBe(true);
  });
});
