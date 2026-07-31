/**
 * src/tests/synth-shell.browser.test.ts — the keyboard stays where a thumb left it.
 *
 * Found by holding the thing: on a tall tab the keyboard scrolled off the bottom. Two
 * causes, both invisible in a unit test and both obvious on a phone.
 *
 * `minHeight: 100dvh` lets the app grow to fit its content, so the BODY becomes the
 * scroller and the footer goes with it. And `main { padding: 2rem }` sat in the shared
 * stylesheet as a bare element selector — dead for the debug wall, which sets its own
 * padding inline, and live on the instrument's scroll container, which is also a `<main>`.
 *
 * A layout regression has no exception and no failing assertion anywhere else, so it is
 * measured here directly.
 */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SynthApp } from '../clients/synth/SynthApp';

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

const mount = async () => {
  await act(async () => root.render(createElement(SynthApp)));
};

const click = async (element: Element) => {
  await act(async () => (element as HTMLElement).click());
};

const shell = () => container.firstElementChild as HTMLElement;

describe('the shell is the only thing that does not scroll', () => {
  it('fixes its own height instead of growing to fit a tall tab', async () => {
    await mount();
    const style = getComputedStyle(shell());

    // The bug in one assertion. A minimum lets the app exceed the viewport, and then the
    // page scrolls rather than the panel — taking the keyboard with it.
    expect(style.overflow).toBe('hidden');
    expect(shell().getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight + 1);
  });

  it('gives the scrolling job to the panel area and nowhere else', async () => {
    await mount();
    const panel = shell().querySelector('main')!;

    expect(getComputedStyle(panel).overflowY).toBe('auto');
    // And the shared stylesheet is not padding it from a distance.
    expect(getComputedStyle(panel).paddingTop).toBe('0px');
  });
});

describe('silence explains itself', () => {
  it('says the context is suspended instead of just being quiet', async () => {
    // The failure this surface reintroduced and the debug wall had already learned:
    // `Tone.start()` resolving is not evidence the browser honoured it, and a refused
    // resume looked exactly like a working one. A synth that makes no sound for a reason
    // it never states is the decoy pattern arriving through the one path no gate sees.
    await mount();

    const banner = container.querySelector('[aria-label="start audio"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('tap to start audio');
    expect(banner?.textContent).toContain('suspended');
  });

  it('reports the output level, which is the only honest answer to is it sounding', async () => {
    await mount();
    expect(container.querySelector('[aria-label="output level"]')).not.toBeNull();
  });
});

describe('the keyboard folds away', () => {
  it('hides the keys and keeps the row that sets up a note', async () => {
    // Velocity and octave stay: they are what you set BEFORE playing, and hunting for
    // them costs more than the strip they occupy.
    await mount();
    expect(container.querySelectorAll('[data-note]').length).toBeGreaterThan(0);

    await click(container.querySelector('[aria-label="hide the keyboard"]')!);

    expect(container.querySelectorAll('[data-note]')).toHaveLength(0);
    expect(container.querySelector('[aria-label="play velocity"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="show the keyboard"]')).not.toBeNull();
  });

  it('brings them back', async () => {
    await mount();
    await click(container.querySelector('[aria-label="hide the keyboard"]')!);
    await click(container.querySelector('[aria-label="show the keyboard"]')!);

    expect(container.querySelectorAll('[data-note]').length).toBeGreaterThan(0);
  });
});
