/**
 * src/tests/wav-sheet.browser.test.ts — the EXPORT WAV sheet (C3c), with a stand-in render.
 *
 * The render itself is gated in `render-song.audio.test.ts`; this checks the sheet asks for
 * what the player picked, says what happened, and cannot start a second render mid-render.
 */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialEngineState, type EngineState } from '../core/state';
import { SeqView } from '../clients/synth/roll/SeqView';
import type { WavExportResult } from '../clients/synth/roll/export-wav';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  container.style.width = '390px';
  container.style.height = '800px';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function looped(): EngineState {
  const state = initialEngineState();
  return { ...state, song: { ...state.song, loop: { enabled: true, start: 0, end: 4 } } };
}

const button = (label: string) => container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const radio = (text: string) =>
  [...container.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.startsWith(text)) as HTMLButtonElement;

async function mount(state: EngineState, exportWav: (s: EngineState, loops: number) => Promise<WavExportResult>) {
  await act(async () =>
    root.render(
      createElement(SeqView, {
        state,
        dispatch: () => undefined,
        getPlayhead: () => 0,
        unlock: () => Promise.resolve(),
        orientation: 'portrait',
        exportWav,
      }),
    ),
  );
  await act(async () => button('export a wav file').click());
}

describe('EXPORT WAV', () => {
  it('renders the number of passes picked, and says where the file went', async () => {
    const calls: number[] = [];
    await mount(looped(), async (_state, loops) => {
      calls.push(loops);
      return { ok: true, message: 'Saved 10.2 s (1.7 MB) to Download/SAG/x.wav' };
    });
    await act(async () => radio('8×').click());
    await act(async () => button('render and save').click());
    expect(calls).toEqual([8]);
    expect(container.textContent).toContain('Download/SAG/x.wav');
  });

  it('shows each choice with its length — longer passes, longer file', async () => {
    await mount(looped(), async () => ({ ok: true, message: '' }));
    const length = (text: string) => Number(radio(text).textContent!.split('·')[1]!.replace('s', ''));
    expect(length('16×')).toBeGreaterThan(length('1×'));
  });

  it('cannot start a second render while one is running', async () => {
    let finish: (value: WavExportResult) => void = () => {};
    let calls = 0;
    await mount(looped(), () => {
      calls += 1;
      return new Promise((resolve) => (finish = resolve));
    });
    await act(async () => button('render and save').click());
    expect(button('render and save').disabled).toBe(true);
    expect(button('render and save').textContent).toBe('RENDERING…');
    await act(async () => button('render and save').click());
    expect(calls).toBe(1);
    await act(async () => finish({ ok: true, message: 'done' }));
    expect(button('render and save').disabled).toBe(false);
  });

  it('a failed render says so instead of hanging', async () => {
    await mount(looped(), async () => {
      throw new Error('out of memory');
    });
    await act(async () => button('render and save').click());
    expect(container.textContent).toContain('Render failed');
    expect(button('render and save').disabled).toBe(false);
  });

  it('with the loop off, there is nothing to pick: the whole song', async () => {
    const state = initialEngineState();
    await mount({ ...state, song: { ...state.song, loop: { ...state.song.loop, enabled: false } } }, async () => ({
      ok: true,
      message: '',
    }));
    expect(container.querySelector('[aria-label="loop passes"]')).toBeNull();
    expect(container.textContent).toContain('the whole song');
  });
});
