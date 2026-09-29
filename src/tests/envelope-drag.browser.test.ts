/**
 * src/tests/envelope-drag.browser.test.ts — the handles move their own parameter, and only it.
 *
 * The design decision this file defends: a handle is a HANDLE FOR ITS OWN PARAMETER, not a
 * point on the path. The time axis is compressive (a log knee), so a requested pixel maps to
 * seconds non-linearly, and a handle that tried to honour one would be solving the axis
 * instead of moving a value.
 *
 * The axis itself is gated at the bottom: since 2026-09-18 it is fixed, so changing one
 * stage moves only that stage and the ones after it.
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
        ranges: { attack: 20, decay: 20, release: 20 },
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
          ranges: { attack: 20, decay: 20, release: 20 },
        }),
      );
    });
    expect(container.querySelectorAll('[role="slider"]')).toHaveLength(0);
  });
});

describe('the AHDSR hold handle (schema_version 5)', () => {
  it('is drawn when a hold path is given, and dragging it writes only the hold', async () => {
    const writes: Write[] = [];
    await act(async () => {
      root.render(
        createElement(EnvelopeCurve, {
          attack: 0,
          decay: 1,
          sustain: 0.5,
          release: 1,
          ranges: { attack: 20, decay: 20, release: 20 },
          stages: STAGES,
          hold: 0.1,
          holdPath: 'voice.envelope.hold',
          decayCurve: 'logarithmic',
          onChange: (path: ParamPath, value: ParamValue) => writes.push({ path, value }),
        }),
      );
    });
    expect(handle('hold'), 'no hold handle').not.toBeNull();
    await drag('hold', 40, 0);
    expect(writes.length).toBeGreaterThan(0);
    expect(new Set(writes.map((w) => w.path))).toEqual(new Set(['voice.envelope.hold']));
    expect(writes.at(-1)!.value as number).toBeGreaterThan(0.1);
  });

  it('is absent without a hold path — the ADSR curve is unchanged', async () => {
    await draw([]);
    expect(handle('hold')).toBeNull();
  });
});

describe('the AHDSR curve tells the truth about time', () => {
  /** Draw the Psy Roll's amp envelope, with one override, and read where the handles sit. */
  async function handlesFor(overrides: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(
        createElement(EnvelopeCurve, {
          attack: 0.01,
          decay: 0.06,
          sustain: 0,
          release: 0.03,
          ranges: { attack: 2, decay: 2, release: 2 },
          stages: STAGES,
          hold: 0.03,
          holdPath: 'voice.envelope.hold',
          decayCurve: 'exponential',
          onChange: () => {},
          ...overrides,
        }),
      );
    });
    const x = (name: string) => {
      const box = handle(name).getBoundingClientRect();
      return box.left + box.width / 2;
    };
    return { attack: x('attack'), hold: x('hold'), decay: x('decay'), release: x('release') };
  }

  it('changing the decay moves only the decay and what follows it — Eyal, 2026-09-18', async () => {
    // The ask this axis exists for: "when i change decay it only controlls the decay". The
    // widths used to be shares of their total, so a longer decay squeezed attack and hold.
    const short = await handlesFor({ decay: 0.06 });
    const long = await handlesFor({ decay: 1.5 });
    expect(long.attack).toBeCloseTo(short.attack, 3);
    expect(long.hold).toBeCloseTo(short.hold, 3);
    expect(long.decay - short.decay, 'a longer decay should draw longer').toBeGreaterThan(20);
  });

  it('changing the attack leaves the hold and decay widths alone', async () => {
    const a = await handlesFor({ attack: 0.005 });
    const b = await handlesFor({ attack: 0.8 });
    expect(b.hold - b.attack).toBeCloseTo(a.hold - a.attack, 3);
    expect(b.decay - b.hold).toBeCloseTo(a.decay - a.hold, 3);
  });

  it('one scale for every stage: the same seconds draw the same width, longer draws wider', async () => {
    // Found by the first screenshot of the AHDSR editor: a 30 ms hold drawn as most of the
    // width beside a 60 ms decay drawn as a sliver, because the hold was scaled against its
    // own 0.5 s range. Hold and release are both 30 ms in the Psy Roll; decay is 60.
    const x = await handlesFor();
    const holdWidth = x.hold - x.attack;
    const decayWidth = x.decay - x.hold;
    expect(holdWidth).toBeGreaterThan(4);
    expect(decayWidth).toBeGreaterThan(holdWidth);

    const release = await handlesFor({ hold: 0.03, release: 0.03, sustain: 0 });
    // Release runs from the end of the sustain segment to the last handle; the sustain
    // segment's width is fixed, so compare release against the hold directly.
    const releaseOnly = await handlesFor({ release: 0 });
    expect(release.release - releaseOnly.release).toBeCloseTo(holdWidth, 1);
  });

  it('the short range is a zoom: the same pluck draws wider in 2 s than in 20 s', async () => {
    const zoomed = await handlesFor({ ranges: { attack: 2, decay: 2, release: 2 } });
    const wide = await handlesFor({ ranges: { attack: 20, decay: 20, release: 20 } });
    expect(zoomed.decay - zoomed.hold).toBeGreaterThan(wide.decay - wide.hold);
  });

  it('in the short range a full drag reaches 2 s, not 20', async () => {
    const writes: Write[] = [];
    await act(async () => {
      root.render(
        createElement(EnvelopeCurve, {
          attack: 0,
          decay: 1,
          sustain: 0.5,
          release: 1,
          ranges: { attack: 2, decay: 2, release: 2 },
          stages: STAGES,
          onChange: (path: ParamPath, value: ParamValue) => writes.push({ path, value }),
        }),
      );
    });
    await drag('attack', 400, 0);
    expect(writes.at(-1)!.value).toBe(2);
  });
});
