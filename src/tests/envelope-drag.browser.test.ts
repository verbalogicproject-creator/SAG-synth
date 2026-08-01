/**
 * src/tests/envelope-drag.browser.test.ts — the handles move their own parameter, and only it.
 *
 * The design decision this file defends: a handle is a HANDLE FOR ITS OWN PARAMETER, not a
 * point on the path. The three times share the drawn width in proportion to each other, so
 * a handle that tried to honour a requested pixel position would have to solve for a value
 * whose answer depends on the other two — and dragging attack would silently rewrite decay
 * and release to keep the picture consistent.
 *
 * So the assertion is not "the curve looks right". It is that one drag produces `setParam`
 * at exactly one address, and that the other three stages are never written. That is the
 * property "no second source of truth about a patch" reduces to when the second way of
 * setting a value is a gesture.
 */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PARAM_SPECS } from '../core/schemas';
import type { ParamPath, ParamValue } from '../core/types';
import { EnvelopeCurve } from '../clients/synth/controls/EnvelopeCurve';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STAGES = [
  'voice.envelope.attack',
  'voice.envelope.decay',
  'voice.envelope.sustain',
  'voice.envelope.release',
] as const satisfies readonly [ParamPath, ParamPath, ParamPath, ParamPath];

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

interface Write {
  path: ParamPath;
  value: ParamValue;
}

async function draw(writes: Write[]): Promise<void> {
  await act(async () => {
    root.render(
      createElement(EnvelopeCurve, {
        // Mid-range on every stage, so a drag has room to move in either direction and a
        // clamp at an end cannot be mistaken for a handle that does nothing.
        attack: 1,
        decay: 1,
        sustain: 0.5,
        release: 1,
        maxStage: 20,
        stages: STAGES,
        onChange: (path: ParamPath, value: ParamValue) => writes.push({ path, value }),
      }),
    );
  });
}

const handle = (name: string): HTMLElement =>
  container.querySelector(`[aria-label="envelope ${name}"]`) as HTMLElement;

/** A drag, in the shape `Knob` and the pad both use: down, move, up, one pointer. */
async function drag(name: string, dx: number, dy: number): Promise<void> {
  const target = handle(name);
  expect(target, `no handle named ${name}`).not.toBeNull();
  const box = target.getBoundingClientRect();
  const startX = box.left + box.width / 2;
  const startY = box.top + box.height / 2;

  await act(async () => {
    target.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: startX, clientY: startY, bubbles: true }),
    );
    target.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 1,
        clientX: startX + dx,
        clientY: startY + dy,
        bubbles: true,
      }),
    );
    target.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
  });
}

describe('the envelope handles', () => {
  it('draws one handle per breakpoint', async () => {
    await draw([]);
    for (const name of ['attack', 'decay', 'release']) {
      expect(handle(name), `${name} handle missing`).not.toBeNull();
    }
  });

  it('is a real touch target, not just a dot', async () => {
    // A 10px dot is a decoration. The thing a finger has to hit is the button around it,
    // and `npm run geometry` cannot see this one because it carries no data-sag-id.
    await draw([]);
    const box = handle('attack').getBoundingClientRect();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  it('moves attack to the right and touches nothing else', async () => {
    const writes: Write[] = [];
    await draw(writes);
    await drag('attack', 60, 0);

    expect(writes.length, 'the drag wrote nothing').toBeGreaterThan(0);
    expect([...new Set(writes.map((w) => w.path))]).toEqual(['voice.envelope.attack']);

    const spec = PARAM_SPECS['voice.envelope.attack'];
    if (spec.kind !== 'number') throw new Error('expected a number spec');
    expect(Number(writes[writes.length - 1]!.value)).toBeGreaterThan(1);
  });

  it('moves release without disturbing attack or decay', async () => {
    const writes: Write[] = [];
    await draw(writes);
    await drag('release', -50, 0);

    expect([...new Set(writes.map((w) => w.path))]).toEqual(['voice.envelope.release']);
    expect(Number(writes[writes.length - 1]!.value)).toBeLessThan(1);
  });

  it('gives the decay corner both of the parameters it actually is', async () => {
    // The one handle that owns two addresses, because the corner IS two addresses: how
    // long the fall takes, and how far it falls to. Dragging it diagonally must move both.
    const writes: Write[] = [];
    await draw(writes);
    await drag('decay', 40, -40);

    const paths = new Set(writes.map((w) => w.path));
    expect(paths).toEqual(new Set(['voice.envelope.decay', 'voice.envelope.sustain']));

    const lastDecay = [...writes].reverse().find((w) => w.path === 'voice.envelope.decay')!;
    const lastSustain = [...writes].reverse().find((w) => w.path === 'voice.envelope.sustain')!;
    expect(Number(lastDecay.value), 'right should lengthen the decay').toBeGreaterThan(1);
    expect(Number(lastSustain.value), 'up should raise the sustain').toBeGreaterThan(0.5);
  });

  it('stays display-only when it is given no stages', async () => {
    // The curve predates the handles and is still used as a picture. Passing no `stages`
    // must draw no targets rather than draw dead ones.
    await act(async () => {
      root.render(
        createElement(EnvelopeCurve, {
          attack: 1,
          decay: 1,
          sustain: 0.5,
          release: 1,
          maxStage: 20,
        }),
      );
    });
    expect(container.querySelectorAll('[role="slider"]')).toHaveLength(0);
  });
});
