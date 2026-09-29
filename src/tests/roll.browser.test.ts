/**
 * src/tests/roll.browser.test.ts — the piano roll, tapped and dragged in a real browser.
 *
 * Every command the view dispatches goes through the REAL `validateAndReduce`, and the view
 * is re-rendered from the state that produced. So a gesture passes only if it produced the
 * right command AND the engine accepted it — a payload the schema would refuse fails here,
 * not on the phone.
 *
 * "Exactly one command per gesture" is asserted wherever it is claimed: it is the
 * `c3ad760` lesson (a drag that dispatches per pointermove floods the journal and undo).
 */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateAndReduce } from '../core/reduce';
import { initialEngineState, type EngineState } from '../core/state';
import type { SynthCommand } from '../core/commands';
import type { NoteEvent } from '../core/types';
import { SeqView } from '../clients/synth/roll/SeqView';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let state: EngineState;
let commands: SynthCommand[];
let rejected: string[];
let minted: number;

function render(): void {
  root.render(
    createElement(SeqView, {
      state,
      dispatch,
      getPlayhead: () => 0,
      unlock: async () => {},
      mintId: () => `m${(minted += 1)}`,
      orientation: 'landscape',
    }),
  );
}

function dispatch(command: SynthCommand): void {
  commands.push(command);
  const result = validateAndReduce(state, command, { commandId: `c${commands.length}`, ts: 1 });
  if (result.status === 'applied') {
    state = result.state;
    render();
  } else {
    rejected.push(`${command.type}: ${result.error}`);
  }
}

async function mount(notes: NoteEvent[] = []): Promise<void> {
  state = initialEngineState();
  if (notes.length > 0) {
    const result = validateAndReduce(state, { type: 'setTrackNotes', trackId: 'track-1', notes }, { commandId: 'seed', ts: 1 });
    if (result.status !== 'applied') throw new Error(result.error);
    state = result.state;
  }
  await act(async () => render());
}

beforeEach(() => {
  container = document.createElement('div');
  // A landscape phone, roughly: the roll gets ~750 px of grid across one 4-beat bar.
  container.style.width = '800px';
  container.style.height = '400px';
  document.body.appendChild(container);
  root = createRoot(container);
  commands = [];
  rejected = [];
  minted = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  expect(rejected, 'the engine refused a command the view sent').toEqual([]);
});

const grid = (): HTMLElement => container.querySelector('[aria-label="piano roll grid"]') as HTMLElement;
const noteEl = (id: string): HTMLElement | null => container.querySelector(`[data-note-id="${id}"]`);
const edits = (): SynthCommand[] => commands.filter((c) => c.type !== 'noteOn' && c.type !== 'noteOff');

async function gesture(target: HTMLElement, from: { x: number; y: number }, to = from): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: from.x, clientY: from.y, bubbles: true }));
  });
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2, bubbles: true }));
    target.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: to.x, clientY: to.y, bubbles: true }));
  });
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: to.x, clientY: to.y, bubbles: true }));
  });
}

function centreOf(element: HTMLElement, fraction = 0.3): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width * fraction, y: box.top + box.height / 2 };
}

const G1 = (noteId: string, time: number, velocity = 1): NoteEvent => ({ noteId, time, duration: 0.15, note: 'G1', velocity });

/**
 * Pixels per 16th, read off a drawn 0.15-beat note. The note is drawn 1 px narrower than its
 * span (the gap between neighbours), so the span is the drawn width + 1 — reading the bare
 * width lands a tap a hair short of the grid line it was aimed at.
 */
function perSixteenthOf(element: HTMLElement): number {
  return (element.getBoundingClientRect().width + 1) / 0.15 / 4;
}

describe('the piano roll', () => {
  it('opens on the notes and draws each one with a readable label', async () => {
    await mount([G1('a', 0.25, 0.7), G1('b', 0.5)]);
    expect(noteEl('a')?.getAttribute('aria-label')).toBe('G1 · 1.1.2 · vel 70%');
    const box = noteEl('a')!.getBoundingClientRect();
    const view = grid().getBoundingClientRect();
    expect(box.top, 'the roll did not scroll to the notes').toBeGreaterThanOrEqual(view.top);
    expect(box.bottom).toBeLessThanOrEqual(view.bottom);
    // Landscape, one bar across: a 16th must clear a thumb-sized fraction of the 44 px floor.
    expect(perSixteenthOf(noteEl('a')!)).toBeGreaterThan(40);
  });

  it('a tap on an empty cell adds exactly one 16th, on that row, at that 16th', async () => {
    await mount([G1('a', 0.25)]);
    const a = noteEl('a')!.getBoundingClientRect();
    // Two 16ths to the right of note a, same row: beat 0.75.
    const perSixteenth = perSixteenthOf(noteEl('a')!);
    await gesture(grid(), { x: a.left + perSixteenth * 2 + 3, y: a.top + a.height / 2 });
    expect(edits()).toEqual([
      { type: 'addNote', trackId: 'track-1', note: { noteId: 'm1', time: 0.75, duration: 0.25, note: 'G1', velocity: 1 } },
    ]);
    expect(noteEl('m1')).not.toBeNull();
  });

  it('dragging a note’s body moves it with one updateNote', async () => {
    await mount([G1('a', 0.25)]);
    const a = noteEl('a')!;
    const perSixteenth = perSixteenthOf(a);
    const start = centreOf(a, 0.2);
    await gesture(grid(), start, { x: start.x + perSixteenth * 2, y: start.y - 22 * 2 });
    expect(edits()).toEqual([{ type: 'updateNote', trackId: 'track-1', noteId: 'a', patch: { time: 0.75, note: 'A1' } }]);
    expect(noteEl('a')?.getAttribute('aria-label')).toBe('A1 · 1.1.4 · vel 100%');
  });

  it('dragging a note’s end resizes it with one updateNote', async () => {
    await mount([G1('a', 0.25)]);
    const a = noteEl('a')!;
    const box = a.getBoundingClientRect();
    const perSixteenth = perSixteenthOf(a);
    const end = { x: box.right - 3, y: box.top + box.height / 2 };
    await gesture(grid(), end, { x: end.x + perSixteenth, y: end.y });
    expect(edits()).toHaveLength(1);
    expect(edits()[0]).toMatchObject({ type: 'updateNote', noteId: 'a', patch: { duration: 0.5 } });
  });

  it('a tap on a note that goes nowhere dispatches nothing', async () => {
    await mount([G1('a', 0.25)]);
    await gesture(grid(), centreOf(noteEl('a')!, 0.2));
    expect(edits()).toEqual([]);
  });

  it('the eraser removes what it is swiped across', async () => {
    await mount([G1('a', 0.25), G1('b', 0.5)]);
    await act(async () => {
      (container.querySelector('[aria-label^="pencil tool"]') as HTMLElement).click();
    });
    const from = centreOf(noteEl('a')!, 0.2);
    const to = centreOf(noteEl('b')!, 0.2);
    await gesture(grid(), from, to);
    expect(edits()).toEqual([
      { type: 'removeNote', trackId: 'track-1', noteId: 'a' },
      { type: 'removeNote', trackId: 'track-1', noteId: 'b' },
    ]);
  });

  it('a velocity drag on one bar commits one updateNote', async () => {
    await mount([G1('a', 0.25), G1('b', 0.5)]);
    const lane = container.querySelector('[aria-label^="velocity lane"]') as HTMLElement;
    const bar = container.querySelector('[data-velocity-of="a"]') as HTMLElement;
    const laneBox = lane.getBoundingClientRect();
    const x = bar.getBoundingClientRect().left + 2;
    await gesture(lane, { x, y: laneBox.top + 5 }, { x, y: laneBox.top + laneBox.height * 0.3 });
    expect(edits()).toEqual([{ type: 'updateNote', trackId: 'track-1', noteId: 'a', patch: { velocity: 0.7 } }]);
  });

  it('a velocity swipe across several notes commits one setTrackNotes', async () => {
    await mount([G1('a', 0.25), G1('b', 0.5), G1('c', 0.75)]);
    const lane = container.querySelector('[aria-label^="velocity lane"]') as HTMLElement;
    const laneBox = lane.getBoundingClientRect();
    const y = laneBox.top + laneBox.height * 0.5;
    const left = (id: string) => (container.querySelector(`[data-velocity-of="${id}"]`) as HTMLElement).getBoundingClientRect().left + 2;
    await gesture(lane, { x: left('a'), y }, { x: left('c'), y });
    expect(edits()).toHaveLength(1);
    expect(edits()[0]!.type).toBe('setTrackNotes');
    expect(state.song.tracks[0]!.notes.map((n) => n.velocity)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('the SEQ view around it', () => {
  it('the kick row makes a kick track with a kick voice, then toggles hits', async () => {
    await mount();
    const lane = container.querySelector('[aria-label^="KICK lane"]') as HTMLElement;
    const box = lane.getBoundingClientRect();
    await act(async () => {
      lane.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: box.left + 3, clientY: box.top + 5, bubbles: true }));
    });
    expect(edits().map((c) => c.type)).toEqual(['addTrack', 'setTrackKick', 'addNote']);
    const kick = state.song.tracks.find((t) => t.kick !== undefined)!;
    expect(kick.notes.map((n) => n.time)).toEqual([0]);
    await act(async () => {
      lane.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: box.left + 3, clientY: box.top + 5, bubbles: true }));
    });
    expect(state.song.tracks.find((t) => t.kick !== undefined)!.notes).toEqual([]);
  });

  it('PSY writes a rolling bass, a kick on every beat, the duck and the loop — and loads the sound', async () => {
    await mount();
    await act(async () => {
      (container.querySelector('[aria-label="write a psytrance pattern"]') as HTMLElement).click();
    });
    await act(async () => {
      (container.querySelector('[aria-label="write the pattern"]') as HTMLElement).click();
    });
    const types = edits().map((c) => c.type);
    expect(types).toEqual([
      'setTempo',
      'loadPreset',
      'addTrack',
      'setTrackKick',
      'setTrackNotes',
      'setTrackNotes',
      'setTrackDuck',
      'setLoop',
    ]);
    const bass = state.song.tracks.find((t) => t.isDrum !== true)!;
    const kick = state.song.tracks.find((t) => t.kick !== undefined)!;
    expect(bass.notes).toHaveLength(12);
    expect(kick.notes.map((n) => n.time)).toEqual([0, 1, 2, 3]);
    expect(bass.duck?.sourceTrackId).toBe(kick.id);
    expect(state.song.bpm).toBe(145);
    // C5d: the sound lands on the CHANNEL, not on the live patch. After C5b the sequencer
    // plays each track's own snapshot, so loading it into `state.patch` would have written
    // the pattern into whatever sound the channel already had.
    expect(bass.presetSnapshot.name).toBe('Psy Roll');
    expect(state.patch.name).not.toBe('Psy Roll');
    expect(state.song.loop).toEqual({ enabled: true, start: 0, end: 4 });
    // And the roll now shows them — ON SCREEN. The first screenshot of this view had PSY
    // write a G1 roll while the grid sat on C2: every note in the DOM, none visible.
    expect(container.querySelectorAll('[data-note-id]')).toHaveLength(12);
    const view = grid().getBoundingClientRect();
    const first = container.querySelector('[data-note-id]')!.getBoundingClientRect();
    expect(first.top, 'the roll did not scroll to the written notes').toBeGreaterThanOrEqual(view.top);
    expect(first.bottom).toBeLessThanOrEqual(view.bottom);
    expect(container.querySelectorAll('[data-drum-note-id]')).toHaveLength(4);
  });

  it('play sets a loop when the song has none, then plays; stop stops', async () => {
    await mount();
    await act(async () => {
      (container.querySelector('[aria-label="play"]') as HTMLElement).click();
    });
    expect(edits().map((c) => c.type)).toEqual(['setLoop', 'play']);
    expect(state.transport.status).toBe('playing');
    await act(async () => {
      (container.querySelector('[aria-label="stop"]') as HTMLElement).click();
    });
    expect(state.transport.status).toBe('stopped');
  });

  it('portrait draws the roll itself, with the kick lane kept (C5d, layout A)', async () => {
    // Until C5d this view asked the player to turn the phone sideways. Eyal chose layout A:
    // the same roll, taller, time scrolling sideways — so portrait is now a roll, and the
    // kick lane stays, because the bass is written around it.
    state = initialEngineState();
    await act(async () =>
      root.render(
        createElement(SeqView, {
          state,
          dispatch,
          getPlayhead: () => 0,
          unlock: async () => {},
          orientation: 'portrait',
        }),
      ),
    );
    expect(grid(), 'portrait drew no grid').not.toBeNull();
    expect(container.textContent).not.toContain('Turn the phone sideways');
    expect(container.querySelector('[aria-label="KICK lane — tap a 16th to toggle"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="write a psytrance pattern"]')).not.toBeNull();
  });
});
