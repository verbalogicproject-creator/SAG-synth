/**
 * src/tests/param-coalescing.browser.test.ts — a drag still reaches the engine.
 *
 * `param-coalescer.test.ts` proves the coalescer's own behaviour against an injected
 * scheduler, exactly and in node. It proves nothing about whether the thing is WIRED, and
 * that gap is the interesting one: the coalescer sits directly in front of every parameter
 * dispatch in the instrument, and the existing browser gates do not reach it.
 * `dead-controls.browser.test.ts` mounts `SynthPanels` with an `onChange` of its own, so
 * every one of the 119 addresses it writes bypasses this code entirely.
 *
 * So this mounts the real `SynthApp`, drags a real knob with real pointer events, waits
 * for a real animation frame, and asserts the value arrived. If the coalescer ever stops
 * flushing — a scheduler that never fires, a ref rebuilt on re-render, a flush that drains
 * into nothing — every knob in the instrument goes dead and this is the only test that
 * would notice.
 *
 * That is the same defect class the project keeps closing, one layer further out: not a
 * control that was never wired, but a control whose wiring was cut by something else.
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

/** Wait for a frame to have been rendered AND its callbacks to have run. */
async function frame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

function pointer(type: string, y: number): PointerEvent {
  return new PointerEvent(type, {
    pointerId: 1,
    bubbles: true,
    cancelable: true,
    clientX: 0,
    clientY: y,
  });
}

describe('a knob drag reaches the engine through the coalescer', () => {
  it('lands the final value of a many-move drag', async () => {
    await act(async () => root.render(createElement(SynthApp)));

    const knob = container.querySelector('[role="slider"][data-sag-id]');
    expect(knob, 'no knob was drawn').not.toBeNull();
    const before = Number(knob!.getAttribute('aria-valuenow'));

    // `setPointerCapture` rejects a pointer id that was never activated in this element,
    // and jsdom-free real chromium enforces it — so it is stubbed rather than fought.
    (knob as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () => {};
    (knob as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture =
      () => {};

    await act(async () => {
      knob!.dispatchEvent(pointer('pointerdown', 200));
    });
    // Twenty moves inside one gesture, upward, which the knob reads as "more".
    await act(async () => {
      for (let move = 1; move <= 20; move += 1) {
        knob!.dispatchEvent(pointer('pointermove', 200 - move * 4));
      }
    });
    await frame();
    await act(async () => {
      knob!.dispatchEvent(pointer('pointerup', 120));
    });
    await frame();

    const after = Number(container.querySelector('[role="slider"][data-sag-id]')!
      .getAttribute('aria-valuenow'));

    // The claim is only that the drag ARRIVED. How far the knob travelled is the knob's
    // own business and is gated where the knob is gated; asserting a specific number here
    // would make this test fail whenever `TRAVEL_PX` is retuned, which is a gate that
    // fails for the wrong reason.
    expect(after, `knob did not move (${before} -> ${after})`).not.toBe(before);
  });
});
