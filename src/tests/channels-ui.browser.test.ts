/**
 * src/tests/channels-ui.browser.test.ts — C5c: the tabs edit whatever channel is lit.
 *
 * The whole surface was built to read `state.patch`, and C5c does NOT change that: it hands
 * the panels a state whose `patch` IS the selected channel's sound (`stateForChannel`) and
 * puts the channel's id on every voice-scoped command leaving `SynthApp`. That substitution
 * is invisible from inside a panel — which is exactly why it needs gating from outside one.
 *
 * Mounted against the REAL engine (`getEngine`), so every assertion below is the reducer's
 * answer, not a mock's. The engine is a singleton for the page, so these tests share a song:
 * each one measures a CHANGE it causes rather than an absolute count.
 */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SynthApp } from '../clients/synth/SynthApp';
import { getEngine } from '../clients/engine';
import { channelKind } from '../core/channels';
import type { EngineState } from '../core/state';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // The selected channel is remembered in localStorage; a test must not inherit the
  // previous one's choice.
  try {
    localStorage.removeItem('sag.synth.channel');
  } catch {
    // Storage disabled in this browser context; the surface falls back to the first channel.
  }
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  // The engine is a singleton for the whole page, so channels added by one test would
  // still be there for the next — and at the six-channel cap "+ SYNTH" changes its label
  // and stops responding, which reads as a mysterious failure three tests later.
  const engine = getEngine().dispatcher;
  for (const track of engine.getState().song.tracks.slice(1)) {
    engine.dispatch({ type: 'removeTrack', trackId: track.id });
  }
});

const mount = async () => {
  await act(async () => root.render(createElement(SynthApp)));
};

const click = async (element: Element | undefined) => {
  expect(element, 'the element under test is not on the page').toBeTruthy();
  await act(async () => (element as HTMLElement).click());
};

/** One frame, so the parameter coalescer flushes what a control just wrote. */
const frame = async () => {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
};

const byLabel = (label: string): HTMLElement | undefined =>
  (Array.from(container.querySelectorAll('[aria-label]')) as HTMLElement[]).find(
    (element) => element.getAttribute('aria-label') === label,
  );

const labelStartingWith = (prefix: string): HTMLElement | undefined =>
  (Array.from(container.querySelectorAll('[aria-label]')) as HTMLElement[]).find((element) =>
    (element.getAttribute('aria-label') ?? '').startsWith(prefix),
  );

/** The channel chips, in bar order. */
const chips = (): HTMLElement[] =>
  Array.from(container.querySelectorAll('[role="tab"][aria-selected]')) as HTMLElement[];

const selectedChip = (): HTMLElement | undefined =>
  chips().find((chip) => chip.getAttribute('aria-selected') === 'true');

const state = (): EngineState => getEngine().dispatcher.getState();

const trackNamed = (name: string) => state().song.tracks.find((track) => track.name === name);

/** Adds a synth channel and returns its track id. */
async function addSynthChannel(name?: string): Promise<string> {
  const before = new Set(state().song.tracks.map((track) => track.id));
  await click(byLabel('add a synth channel'));
  const added = state().song.tracks.find((track) => !before.has(track.id));
  expect(added, '+ SYNTH added no track').toBeTruthy();
  if (name !== undefined) {
    // The engine is shared across these tests, so names repeat unless a test claims one.
    getEngine().dispatcher.dispatch({ type: 'renameTrack', trackId: added!.id, name });
    await act(async () => {});
  }
  return added!.id;
}

describe('the channel bar', () => {
  it('+ SYNTH adds a channel, selects it, and leaves the others alone', async () => {
    await mount();
    const before = chips().length;
    const notes = state().song.tracks[0]!.notes.length;

    const added = await addSynthChannel();

    expect(chips()).toHaveLength(before + 1);
    expect(selectedChip()?.getAttribute('aria-label')).toContain('synth channel');
    expect(state().song.tracks.find((track) => track.id === added)?.notes).toEqual([]);
    // The channel that was there keeps its notes: adding is not a reset.
    expect(state().song.tracks[0]!.notes).toHaveLength(notes);
  });

  it('+ KICK adds a drum channel with a kick voice, and shows the kick panel instead of the tabs', async () => {
    await mount();
    await click(byLabel('add a kick channel'));

    const kick = state().song.tracks.find((track) => track.id === trackOf(selectedChip()!));
    expect(kick, 'no kick track was created').toBeTruthy();
    expect(channelKind(kick!)).toBe('kick');
    expect(kick!.kick, 'the kick channel has no kick voice').toBeTruthy();

    // The synth tabs are gone; the kick's own controls are there instead.
    expect(byLabel('kick decay'), 'the KICK panel is not showing').toBeTruthy();
    expect(container.querySelector('[role="tablist"][aria-label="signal path"]')).toBeNull();
    // And the keyboard is hidden: a kick channel has no keys to play.
    expect(byLabel('play velocity')).toBeUndefined();

    // The library button is dead here, and says why. Left live, a preset loaded from a
    // kick channel would land on the LIVE patch — a sound changing somewhere the player
    // is not looking.
    const library = labelStartingWith(`${kick!.name} \u2014 a kick channel`);
    expect(library, 'the header still offers to load a sound into a kick channel').toBeTruthy();
    expect((library as HTMLButtonElement).disabled).toBe(true);
  });

  it('a kick control writes to that channel, through setTrackKick', async () => {
    await mount();
    await click(byLabel('add a kick channel'));
    const id = trackOf(selectedChip()!);
    const before = state().song.tracks.find((track) => track.id === id)!.kick!.decay;

    const decay = rangeLabelled('kick decay')!;
    await act(async () => {
      setRangeValue(decay, before + 0.3);
    });

    const after = state().song.tracks.find((track) => track.id === id)!.kick!.decay;
    expect(after).toBeCloseTo(before + 0.3, 5);
  });
});

describe('the panels edit the selected channel', () => {
  it('switching channel switches the values the tabs show', async () => {
    await mount();
    const first = state().song.tracks.find((track) => channelKind(track) === 'synth')!.id;
    const second = await addSynthChannel();

    // Two different sounds, written through the reducer exactly as the surface would.
    const engine = getEngine().dispatcher;
    engine.dispatch({ type: 'setParam', path: 'voice.filter.Q', value: 2, trackId: first });
    engine.dispatch({ type: 'setParam', path: 'voice.filter.Q', value: 9, trackId: second });
    await act(async () => {});

    await click(tabNamed('FILTER'));
    // The second channel is the selected one — it was just added.
    expect(knobValue('resonance')).toBeCloseTo(9, 3);

    await click(chipFor(first));
    expect(knobValue('resonance')).toBeCloseTo(2, 3);
  });

  it('a knob writes to the selected channel and not to the live patch', async () => {
    await mount();
    const added = await addSynthChannel();
    const livePatchBefore = state().patch;

    await click(tabNamed('ADSR'));
    const slider = rangeLabelled('attack');
    expect(slider, 'no envelope slider on the ADSR tab').toBeTruthy();
    const before = state().song.tracks.find((candidate) => candidate.id === added)!
      .presetSnapshot.voice.envelope.attack;
    // The slider carries a 0..1000 TRACK POSITION, not seconds: what the address becomes
    // is `fromTrack`'s business, so this asserts the write landed and where, not a number
    // this test would be restating from the scale module.
    await act(async () => setRangeValue(slider!, Number(slider!.max) / 2));
    await frame();

    const track = state().song.tracks.find((candidate) => candidate.id === added)!;
    expect(track.presetSnapshot.voice.envelope.attack).toBeGreaterThan(before);
    // The live patch is what a note with no channel plays. It must not have moved.
    expect(state().patch).toBe(livePatchBefore);
  });

  it('the header names the selected channel’s sound, not the live patch', async () => {
    await mount();
    const first = state().song.tracks.find((track) => channelKind(track) === 'synth')!.id;
    const second = await addSynthChannel();
    getEngine().dispatcher.dispatch({ type: 'renameTrack', trackId: second, name: 'Lead' });
    await act(async () => {});

    const named = (id: string) =>
      state().song.tracks.find((track) => track.id === id)!.presetSnapshot.name;
    expect(libraryButton()?.textContent).toBe(named(second));

    await click(chipFor(first));
    expect(libraryButton()?.textContent).toBe(named(first));
  });
});

describe('the keyboard', () => {
  it('lights the key it is playing, on whichever channel is selected', async () => {
    // The regression Eyal found on the device: C5c aimed the keyboard at the selected
    // channel, and a note with a trackId is held in THAT channel's pool (C5a) — so the
    // surface, still reading the live patch's pool, drew every key unlit. The keys made
    // sound and looked dead, which reads as "the app is broken" long before anyone
    // suspects a pool.
    await mount();
    const id = await addSynthChannel('Keys Test');
    expect(id).toBeTruthy();

    const key = container.querySelector('[data-note="C3"]') as HTMLElement;
    expect(key, 'no keyboard on screen').toBeTruthy();
    const unlit = getComputedStyle(key).backgroundColor;

    await act(async () => {
      key.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, bubbles: true }));
    });
    expect(getComputedStyle(key).backgroundColor, 'the pressed key did not light up').not.toBe(unlit);
    // And the engine really is holding it, on the selected channel's pool.
    expect(getEngine().dispatcher.getTransient().channels.get(id)?.heldNotes.has('C3')).toBe(true);

    await act(async () => {
      key.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, bubbles: true }));
    });
    expect(getComputedStyle(key).backgroundColor, 'the key stayed lit after release').toBe(unlit);
  });
});

describe('the selection itself', () => {
  it('is remembered across a remount, and survives the channel being deleted', async () => {
    await mount();
    const added = await addSynthChannel();

    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(trackOf(selectedChip()!)).toBe(added);

    // Delete it from under the surface: the selection falls back rather than pointing at
    // a track that is not there.
    getEngine().dispatcher.dispatch({ type: 'removeTrack', trackId: added });
    await act(async () => {});
    expect(selectedChip(), 'nothing is selected after the selected channel went away').toBeTruthy();
    expect(trackOf(selectedChip()!)).not.toBe(added);
  });

  it('mute and solo are on the chip, and reach the track', async () => {
    await mount();
    const id = await addSynthChannel('Flags Test');
    const name = nameOf(id);

    await click(byLabel(`mute ${name}`));
    expect(state().song.tracks.find((track) => track.id === id)!.muted).toBe(true);
    await click(byLabel(`solo ${name}`));
    expect(state().song.tracks.find((track) => track.id === id)!.solo).toBe(true);
  });

  it('renames and deletes through the channel sheet', async () => {
    await mount();
    const id = await addSynthChannel('Sheet Test');
    await click(byLabel('Sheet Test settings'));
    const input = byLabel('channel name') as HTMLInputElement;
    await act(async () => {
      setInputValue(input, 'Acid');
      // React maps onBlur to the FOCUSOUT event, which bubbles; a plain 'blur' does not
      // reach it and the rename would silently never fire.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(trackNamed('Acid')?.id).toBe(id);

    // Two taps: the first arms, the second deletes.
    await click(byLabel('delete Acid'));
    expect(trackNamed('Acid'), 'one tap deleted the channel').toBeTruthy();
    await click(byLabel('really delete Acid'));
    expect(trackNamed('Acid')).toBeUndefined();
  });
});

// -- helpers ---------------------------------------------------------------

/** The track id behind a chip, found by the name in its label. */
function trackOf(chip: HTMLElement): string {
  const id = chip.getAttribute('data-channel');
  expect(id, 'a chip with no data-channel').toBeTruthy();
  return id!;
}

function chipFor(trackId: string): HTMLElement | undefined {
  return chips().find((chip) => chip.getAttribute('data-channel') === trackId);
}

/** The name a track has right now — labels are built from it, so lookups must be too. */
function nameOf(trackId: string): string {
  return getEngine().dispatcher.getState().song.tracks.find((track) => track.id === trackId)!.name;
}

/** A range input by its aria-label. Knobs are divs with role=slider; these are inputs. */
function rangeLabelled(prefix: string): HTMLInputElement | undefined {
  return (Array.from(container.querySelectorAll('input[type="range"]')) as HTMLInputElement[]).find(
    (input) => (input.getAttribute('aria-label') ?? '').startsWith(prefix),
  );
}


function tabNamed(label: string): HTMLElement | undefined {
  return (Array.from(container.querySelectorAll('[role="tab"]')) as HTMLElement[]).find(
    (tab) => tab.textContent?.trim().startsWith(label) && tab.getAttribute('aria-selected') !== null,
  );
}

function libraryButton(): HTMLElement | undefined {
  return labelStartingWith('') === undefined
    ? undefined
    : (Array.from(container.querySelectorAll('button[aria-label*="open the library"]')) as HTMLElement[])[0];
}

/** A knob's value, read from the ARIA it already publishes. */
function knobValue(label: string): number {
  const knob = (Array.from(container.querySelectorAll('[role="slider"]')) as HTMLElement[]).find(
    (element) => (element.getAttribute('aria-label') ?? '') === label,
  );
  expect(knob, `no control labelled "${label}"`).toBeTruthy();
  return Number(knob!.getAttribute('aria-valuenow'));
}

/** React listens to the native setter, so a plain `.value =` is not seen. */
function setRangeValue(input: HTMLInputElement, value: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
