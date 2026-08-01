/**
 * src/tests/dead-controls.browser.test.ts — nothing on screen may be a decoy.
 *
 * This project's signature failure has now shipped seven times, always wearing different
 * clothes: a velocity keyboard sending a hardcoded 0.8, an EQ toggle refused at validation,
 * a distortion `amount` that moved the level instead of the timbre, a `pan` that validated
 * and journalled into a node already down-mixed to mono, a `sync` flag nothing read, and
 * most recently an entire LFO tab — twenty controls addressing `voice.lfos.0..3.*` when
 * `defaultPreset()` ships `lfos: []`, so every one of them drew, accepted a touch, and did
 * nothing.
 *
 * They are all one bug: **a control is on screen for an address the patch cannot accept a
 * write to.** That sentence is mechanically checkable, so it becomes a gate rather than a
 * habit of looking. Eyal's framing, and it is the right one — if it is a signature error,
 * eradicate the class instead of the instance.
 *
 * **How it works.** Mount the real surface, sweep every tab and sub-tab exactly as a thumb
 * would, collect the `data-sag-path` of everything actually drawn, and for each one push a
 * DIFFERENT value through the real reducer. If reading it back does not return the new
 * value, that control is a decoy: it is drawn, it is addressable, and it cannot be changed.
 *
 * **What this deliberately does NOT flag.** A parameter the current shape cannot honour —
 * `width` on a sawtooth — still *writes*. The patch stores it, the DSP ignores it, and the
 * surface says so in amber via `ignoredIn`. That is a declared and visible state, not a
 * lie. The line this gate draws is exactly right: **stored-but-ignored is honest, refuses-
 * to-store is a decoy.**
 *
 * Generated from what is on screen rather than from a list, so a new panel, a new slot
 * family or a new tab is covered the day it is drawn, without this file being edited.
 */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getParam } from '../core/params';
import { reduce, validateAndReduce, type ReduceMeta } from '../core/reduce';
import { PARAM_SPECS } from '../core/schemas';
import { defaultPreset, initialEngineState } from '../core/state';
import type { EngineState } from '../core/state';
import type { ParamPath, ParamValue } from '../core/types';
import { SynthPanels } from '../clients/synth/SynthPanels';
import { RouteList } from '../clients/synth/RouteList';
import { surfaceContext } from '../clients/synth/controlProps';
import type { SynthCommand } from '../core/commands';
import { sweepSurface } from './sweep-surface';

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

const meta = (commandId: string): ReduceMeta => ({ commandId, ts: 1_700_000_000_000 });

/**
 * The state a player actually gets on first open — no slots added, nothing configured.
 *
 * Using the factory patch is the whole point. A test that first adds three oscillators and
 * four LFOs would prove the surface works once it has been set up, which is not the claim
 * anybody cares about. The claim is that what a player sees when the app loads is real.
 */
function factoryState(): EngineState {
  return { ...initialEngineState(), patch: defaultPreset() };
}

/**
 * A quarter and three quarters of the way up the range, whichever is further from where
 * the value already sits — so the probe stays comfortably distinct after any rounding the
 * spec applies, rather than landing on the current value and reading as "unchanged".
 */
function spread(min: number, max: number, current: ParamValue | undefined, integer: boolean) {
  const low = min + (max - min) * 0.25;
  const high = min + (max - min) * 0.75;
  const pick =
    typeof current === 'number' && Math.abs(current - low) < Math.abs(current - high) ? high : low;
  return integer ? Math.round(pick) : pick;
}

/** A legal value for `path` that differs from `current`. */
function differentValue(path: ParamPath, current: ParamValue | undefined): ParamValue {
  const spec = PARAM_SPECS[path];
  switch (spec.kind) {
    case 'boolean':
      return current !== true;
    case 'enum': {
      const other = spec.values.find((value) => value !== current);
      // A single-member enum cannot be changed and so cannot be proven live this way.
      return other ?? spec.values[0]!;
    }
    case 'number': {
      // `choices` means the range is documentation and these are the only legal values —
      // `voice.filter.rolloff` is -12|-24|-48|-96. Picking mid-range there would be
      // refused by the validator and would read as a dead control when it is a live one.
      if (spec.choices !== undefined) {
        const other = spec.choices.find((choice) => choice !== current);
        return other ?? spec.choices[0]!;
      }
      return spread(spec.min, spec.max, current, spec.integer === true);
    }
    case 'frequency':
      // Hz, which is always legal here; the subdivision strings are the sync-on form and
      // testing one of them would be testing `sync` rather than this address.
      return spread(spec.min, spec.max, current, false);
    default:
      // Unreachable for the four declared kinds — and deliberately loud, so a fifth kind
      // added to PARAM_SPECS cannot silently opt every control of that kind out of this
      // gate. An untested control is how the class being eradicated here got in.
      throw new Error(`differentValue: unhandled spec kind for "${path}"`);
  }
}

const visiblePaths = () =>
  [...container.querySelectorAll('[data-sag-path]')].map(
    (node) => node.getAttribute('data-sag-path') as ParamPath,
  );

const click = async (element: Element) => {
  await act(async () => {
    (element as HTMLElement).click();
  });
};

/**
 * Everything the surface draws for `state`, across every tab, group and slot.
 *
 * Shares `sweepSurface` with `synth-tabs.browser.test.ts` deliberately: that file proves
 * the declared addresses are REACHABLE, this one proves the reachable ones are LIVE. Same
 * walk, two claims, and the second is worthless without the first.
 */
async function drawnPaths(state: EngineState): Promise<Set<ParamPath>> {
  const seen = new Set<ParamPath>();
  await act(async () => {
    root.render(
      createElement(SynthPanels, { state, onChange: () => undefined, onCommand: () => undefined }),
    );
  });
  await sweepSurface(container, click, () => visiblePaths().forEach((path) => seen.add(path)));
  return seen;
}

describe('every control on screen is connected to the patch', () => {
  it('accepts a write at every address the factory surface draws', async () => {
    const state = factoryState();
    const drawn = [...(await drawnPaths(state))].sort();

    expect(drawn.length, 'the surface drew nothing').toBeGreaterThan(0);

    const dead: string[] = [];
    for (const path of drawn) {
      const before = getParam(state, path);
      const value = differentValue(path, before);
      const result = reduce(state, { type: 'setParam', path, value }, meta(`probe-${path}`));

      if (result.status !== 'applied') {
        dead.push(`${path} — reducer ${result.status}`);
        continue;
      }
      const after = getParam(result.state, path);
      if (after !== value) {
        // `undefined` after a write is the LFO bug exactly: the slot does not exist, so
        // there is nowhere for the value to land and no error either.
        dead.push(`${path} — wrote ${JSON.stringify(value)}, read back ${JSON.stringify(after)}`);
      }
    }

    expect(dead, `${dead.length} of ${drawn.length} drawn controls cannot be changed`).toEqual([]);
  });
});

/**
 * Every button that presses, pressed — and every command it produced, validated.
 *
 * The test above covers PARAMETERS: a control is drawn, `setParam` is pushed at its address,
 * the value must come back. That misses a whole sub-class, because not every control is a
 * parameter. `+ route`, `+ LFO`, the slot letters' `−`, and each effect's ACTIVE/BYPASS are
 * COMMANDS, and a command the reducer refuses is just as dead as an address that will not
 * take a write.
 *
 * That sub-class shipped too. `RouteList`'s `newRoute()` was born pointing at `lfo.0`, the
 * reducer refuses a route whose source names an empty LFO slot, and the factory patch holds
 * no LFOs — so `+ route` was rejected on every press a new player could make, and the
 * surface discarded the refusal in silence.
 *
 * So: click everything, capture what it dispatched, and run each command through the real
 * validator and reducer against the state it was dispatched from. Nothing may be refused.
 */
/** Every enabled button that is not navigation — tabs move the view, they do not command. */
const actionButtons = () =>
  [...container.querySelectorAll('button')].filter(
    (button) => !button.disabled && button.getAttribute('role') !== 'tab',
  );

describe('every button on screen dispatches a command the engine accepts', () => {
  it('is refused by nothing the factory surface offers to press', async () => {
    const state = factoryState();
    const sink: SynthCommand[] = [];
    const onCommand = (command: SynthCommand) => sink.push(command);

    // The four tabs and everything nested in them.
    await act(async () => {
      root.render(
        createElement(SynthPanels, { state, onChange: () => undefined, onCommand }),
      );
    });
    // Pressed at every resting state the walk passes through, not gathered and pressed at
    // the end: a button on the FILTER tab is detached from the document by the time the
    // walk reaches FX, and a detached node dispatches nothing.
    await sweepSurface(container, click, async () => {
      for (const button of actionButtons()) await click(button);
    });

    // The bay is an overlay that `sweepSurface` cannot reach, and it is where the dead
    // button actually lived. Mounted directly rather than through SynthApp so this test
    // still needs no engine, no audio context and no IndexedDB.
    await act(async () => {
      root.render(
        createElement(RouteList, { context: surfaceContext(state, () => undefined), onCommand }),
      );
    });
    for (const button of actionButtons()) await click(button);

    expect(sink.length, 'nothing on the surface dispatched a command').toBeGreaterThan(0);

    const refused = sink
      .map((command, index) => {
        const result = validateAndReduce(state, command, meta(`press-${index}`));
        return result.status === 'applied'
          ? null
          : `${command.type} — ${result.status}: ${'error' in result ? result.error : ''}`;
      })
      .filter((entry): entry is string => entry !== null);

    expect(refused, `${refused.length} of ${sink.length} presses were refused`).toEqual([]);
  });
});
