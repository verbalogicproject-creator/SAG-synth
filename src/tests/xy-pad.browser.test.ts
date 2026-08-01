/**
 * src/tests/xy-pad.browser.test.ts — the pad reports a position, not a key.
 *
 * The whole point of an XY pad over a keyboard is that a press between two notes sounds
 * between two notes. A stepped keyboard would pass every other assertion here and fail
 * only the mid-way one — that is the assertion this file exists for.
 *
 * `createElement` rather than JSX because the `dom` project collects `*.browser.test.ts`
 * and a `.tsx` would not be picked up.
 */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PARAM_SPECS } from '../core/schemas';
import { BLACK_KEYS, WHITE_KEYS, noteName } from '../clients/debug/keyboard';
import { XYPad } from '../clients/synth/XYPad';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OCTAVE = 3;
const Y_TARGET = 'voice.amplitude' as const;
const SPEC = PARAM_SPECS[Y_TARGET];
if (SPEC.kind !== 'number') throw new Error('expected a number spec');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  // A fixed width makes the fraction-of-width math in the pad deterministic, rather than
  // depending on whatever the browser's default viewport happens to be.
  container.style.width = '360px';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function draw(props: {
  onPitch: (note: string, detuneCents: number, velocity: number) => void;
  onRelease: (note: string) => void;
  onChange: (path: string, value: number) => void;
  yValue?: number;
}): Promise<void> {
  await act(async () => {
    root.render(
      createElement(XYPad, {
        octave: OCTAVE,
        yTarget: Y_TARGET,
        yValue: props.yValue ?? 0.5,
        onPitch: props.onPitch,
        onRelease: props.onRelease,
        onChange: props.onChange,
      }),
    );
  });
}

function pad(): HTMLElement {
  return container.querySelector('[role="slider"]')!;
}

function rect(): DOMRect {
  return pad().getBoundingClientRect();
}

function press(clientX: number, clientY: number, pointerId = 1): void {
  pad().dispatchEvent(
    new PointerEvent('pointerdown', { pointerId, clientX, clientY, bubbles: true }),
  );
}

function release(pointerId = 1): void {
  pad().dispatchEvent(new PointerEvent('pointerup', { pointerId, bubbles: true }));
}

/**
 * The drawn white keys, measured after layout rather than computed.
 *
 * This is the whole point of the rewrite. The previous version of these tests derived
 * its expectation from `fractionX = 6.3 / 12` — the pad's OWN semitone model. When
 * implementation and gate share an assumption, the gate cannot fail for that assumption
 * being wrong, and this one did not: the pad maps X linearly over twelve semitones while
 * the keyboard it draws is eight equal-width white keys with blacks overlaid. Different
 * geometries, one of them invisible to the test.
 *
 * So the expectation now comes from `getBoundingClientRect()` on the keys the browser
 * actually painted. That is a second description of the surface which shares nothing with
 * `pitchAt`, which is the only kind of second description worth having.
 */
function whiteKeyBoxes(): DOMRect[] {
  const reference = container.querySelector('[aria-hidden="true"]');
  expect(reference, 'the pad drew no key reference').not.toBeNull();

  // The whites are laid out first, then the blacks are overlaid — so the leading
  // WHITE_KEYS.length children are the white keys. Asserted rather than assumed: if the
  // drawing order ever changes, this fails loudly instead of measuring the wrong boxes.
  const drawn = [...reference!.children];
  expect(drawn.length, 'drew a different number of keys than are declared').toBe(
    WHITE_KEYS.length + BLACK_KEYS.length,
  );

  return drawn.slice(0, WHITE_KEYS.length).map((key) => key.getBoundingClientRect());
}

describe('X axis: the note a key plays is the note it shows', () => {
  it('plays each drawn white key when pressed at that key’s centre', async () => {
    const pitches: { note: string; detuneCents: number }[] = [];
    await draw({
      onPitch: (note, detuneCents) => pitches.push({ note, detuneCents }),
      onRelease: () => undefined,
      onChange: () => undefined,
    });

    const padBox = rect();
    const boxes = whiteKeyBoxes();
    const played: string[] = [];

    for (let index = 0; index < boxes.length; index += 1) {
      pitches.length = 0;
      const box = boxes[index]!;
      // One pointer id throughout, released between presses. Chromium refuses
      // `setPointerCapture` for an id it never saw go down, so inventing a fresh id per
      // key throws inside the component rather than testing it.
      await act(async () => {
        press(box.left + box.width / 2, padBox.top + padBox.height / 2);
        release();
      });
      played.push(pitches[0]?.note ?? 'nothing');
    }

    // A key that draws a C and sounds a C# is the exact failure this instrument has
    // shipped five times in other clothes: a working engine behind a dishonest surface.
    const expected = WHITE_KEYS.map((key) => noteName(OCTAVE, key.offset));
    expect(played, 'a drawn key played a note other than the one it shows').toEqual(expected);
  });

  it('detunes toward the neighbour when pressed between two key centres', async () => {
    // The reason for a pad over a keyboard: the space between the keys has to mean
    // something. Measured from the drawn centres, so it stays true if the keys move.
    const pitches: { note: string; detuneCents: number }[] = [];
    await draw({
      onPitch: (note, detuneCents) => pitches.push({ note, detuneCents }),
      onRelease: () => undefined,
      onChange: () => undefined,
    });

    const padBox = rect();
    const boxes = whiteKeyBoxes();
    const first = boxes[0]!;
    const second = boxes[1]!;
    const between = (first.left + first.width / 2 + second.left + second.width / 2) / 2;

    await act(async () => press(between, padBox.top + padBox.height / 2));

    expect(pitches.length).toBeGreaterThan(0);
    expect(Math.abs(pitches[0]!.detuneCents), 'a press between two keys snapped to one').toBeGreaterThan(0);
  });
});

describe('Y axis: the chosen parameter, read from its own spec', () => {
  it('reads the spec max at the top of the pad', async () => {
    const changes: number[] = [];
    await draw({
      onPitch: () => undefined,
      onRelease: () => undefined,
      onChange: (_path, value) => changes.push(value),
    });

    const r = rect();
    await act(async () => press(r.left + r.width / 2, r.top));

    expect(changes[0]).toBeCloseTo(SPEC.max, 5);
  });

  it('reads the spec min at the bottom of the pad', async () => {
    const changes: number[] = [];
    await draw({
      onPitch: () => undefined,
      onRelease: () => undefined,
      onChange: (_path, value) => changes.push(value),
    });

    const r = rect();
    await act(async () => press(r.left + r.width / 2, r.top + r.height));

    expect(changes[0]).toBeCloseTo(SPEC.min, 5);
  });
});

describe('release', () => {
  it('fires onRelease with the note that was sounding', async () => {
    const released: string[] = [];
    await draw({
      onPitch: () => undefined,
      onRelease: (note) => released.push(note),
      onChange: () => undefined,
    });

    const r = rect();
    await act(async () => {
      press(r.left, r.top + r.height / 2);
      release();
    });

    expect(released).toEqual([noteName(OCTAVE, 0)]);
  });
});

describe('addressability', () => {
  it('carries data-sag-path on its outermost element', async () => {
    await draw({ onPitch: () => undefined, onRelease: () => undefined, onChange: () => undefined });
    expect(container.firstElementChild?.getAttribute('data-sag-path')).toBe(Y_TARGET);
  });
});
