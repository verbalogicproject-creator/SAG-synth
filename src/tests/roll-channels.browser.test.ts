/**
 * src/tests/roll-channels.browser.test.ts — C5d: one roll, one channel at a time.
 *
 * The roll used to edit "the first pitched track" and nothing else could be seen. It now
 * edits the SELECTED channel and draws every other synth channel's notes behind it as
 * ghosts — context a psytrance bass is written against, since the whole point of the
 * pattern is where it sits between the kicks.
 *
 * Every command goes through the real `validateAndReduce`, so a gesture passes only if it
 * produced a command the engine accepted.
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
let channelId: string | null;
let minted: number;
/** The audition's note-off arrives on a 180 ms timer, which can outlive the test. */
let mounted: boolean;

function render(): void {
  if (!mounted) return;
  root.render(
    createElement(SeqView, {
      state,
      dispatch,
      getPlayhead: () => 0,
      unlock: async () => {},
      mintId: () => `m${(minted += 1)}`,
      channelId,
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

/** Two synth channels: 'track-1' with a G1 roll, 'lead' with a C4 line an octave up. */
const BASS: NoteEvent[] = [0, 0.25, 0.5].map((time, index) => ({
  noteId: `b${index}`,
  time,
  duration: 0.15,
  note: 'G1',
  velocity: 1,
}));
const LEAD: NoteEvent[] = [0.75, 1.25].map((time, index) => ({
  noteId: `l${index}`,
  time,
  duration: 0.2,
  note: 'C4',
  velocity: 0.9,
}));

function seed(command: SynthCommand): void {
  const result = validateAndReduce(state, command, { commandId: `seed-${commands.length}`, ts: 1 });
  if (result.status !== 'applied') throw new Error(`${command.type}: ${result.error}`);
  state = result.state;
}

async function mount(selected: string | null = 'track-1'): Promise<void> {
  state = initialEngineState();
  seed({ type: 'setTrackNotes', trackId: 'track-1', notes: BASS });
  seed({ type: 'addTrack', trackId: 'lead', name: 'Lead' });
  seed({ type: 'setTrackNotes', trackId: 'lead', notes: LEAD });
  channelId = selected;
  await act(async () => render());
}

beforeEach(() => {
  container = document.createElement('div');
  container.style.width = '800px';
  container.style.height = '400px';
  document.body.appendChild(container);
  root = createRoot(container);
  commands = [];
  rejected = [];
  minted = 0;
  mounted = true;
});

afterEach(async () => {
  mounted = false;
  await act(async () => root.unmount());
  container.remove();
  expect(rejected, 'the engine refused a command the view sent').toEqual([]);
});

const grid = (): HTMLElement => container.querySelector('[aria-label="piano roll grid"]') as HTMLElement;
const solidIds = (): string[] =>
  Array.from(container.querySelectorAll('[data-note-id]')).map((el) => el.getAttribute('data-note-id')!);
const ghostIds = (): string[] =>
  Array.from(container.querySelectorAll('[data-ghost-note-id]')).map((el) => el.getAttribute('data-ghost-note-id')!);

describe('the roll follows the selected channel', () => {
  it('draws the selected channel solid and the others as ghosts', async () => {
    await mount('track-1');
    expect(solidIds().sort()).toEqual(['b0', 'b1', 'b2']);
    expect(ghostIds().sort()).toEqual(['l0', 'l1']);

    // Switch channel: the two swap roles, and nothing was dispatched to do it — selection
    // is surface state, not a song edit.
    const before = commands.length;
    channelId = 'lead';
    await act(async () => render());
    expect(solidIds().sort()).toEqual(['l0', 'l1']);
    expect(ghostIds().sort()).toEqual(['b0', 'b1', 'b2']);
    expect(commands).toHaveLength(before);
  });

  it('a ghost note is untouchable: a tap on one edits the selected channel instead', async () => {
    await mount('track-1');
    const ghost = container.querySelector('[data-ghost-note-id="l0"]') as HTMLElement;
    expect(ghost, 'no ghost note was drawn').toBeTruthy();
    // The decision Eyal made: ghosts are pure background. Not a target for a finger, and
    // not announced to a screen reader either.
    expect(getComputedStyle(ghost).pointerEvents).toBe('none');
    expect(ghost.getAttribute('aria-hidden')).toBe('true');

    const box = ghost.getBoundingClientRect();
    await act(async () => {
      grid().dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 1,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
          bubbles: true,
        }),
      );
      grid().dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    });

    // Whatever that tap did, it happened on the EDITED channel — the ghost's own channel
    // is untouched.
    expect(state.song.tracks.find((track) => track.id === 'lead')!.notes.map((note) => note.noteId)).toEqual([
      'l0',
      'l1',
    ]);
    for (const command of commands) {
      if ('trackId' in command) expect(command.trackId).not.toBe('lead');
    }
  });

  it('edits land on the selected channel, and leave the other one alone', async () => {
    await mount('lead');
    const before = state.song.tracks.find((track) => track.id === 'track-1')!.notes;

    const box = grid().getBoundingClientRect();
    await act(async () => {
      grid().dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: 1, clientX: box.left + 200, clientY: box.top + 120, bubbles: true }),
      );
      grid().dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 1, clientX: box.left + 200, clientY: box.top + 120, bubbles: true }),
      );
    });

    const added = commands.filter((command) => command.type === 'addNote');
    expect(added, 'the tap drew nothing').toHaveLength(1);
    expect((added[0] as { trackId: string }).trackId).toBe('lead');
    expect(state.song.tracks.find((track) => track.id === 'track-1')!.notes).toBe(before);
  });

  it('a kick channel selected falls back to the first synth channel, rather than drawing nothing', async () => {
    await mount('track-1');
    seed({ type: 'addTrack', trackId: 'kick', name: 'Kick' });
    seed({ type: 'setTrackKick', trackId: 'kick', kick: { tune: 'G1', punch: 3, pitchDecay: 0.03, decay: 0.22, level: 0 } });
    channelId = 'kick';
    await act(async () => render());

    // The kick has its own lane; the roll keeps editing a channel that has pitches.
    expect(solidIds().sort()).toEqual(['b0', 'b1', 'b2']);
  });

  it('auditioning a key plays the selected channel’s sound', async () => {
    await mount('lead');
    const keys = container.querySelector('[aria-label^="keys"]') as HTMLElement;
    const key = keys.querySelector('[data-pitch]') as HTMLElement;
    await act(async () => {
      keys.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, clientX: 10, clientY: 40, bubbles: true }));
      key.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, clientX: 10, clientY: 40, bubbles: true }));
    });

    const notes = commands.filter((command) => command.type === 'noteOn');
    expect(notes, 'the key auditioned nothing').toHaveLength(1);
    expect((notes[0] as { trackId?: string }).trackId).toBe('lead');
  });
});

describe('the keys column scrolls pitch', () => {
  it('a drag moves the range; a tap does not', async () => {
    await mount('track-1');
    const keys = container.querySelector('[aria-label^="keys"]') as HTMLElement;
    const scroller = grid();
    scroller.scrollTop = 300;
    const before = scroller.scrollTop;

    // A drag DOWN reveals lower pitches: the content follows the finger. The release is
    // dispatched ON A KEY, which is where a real thumb lifts — a release on the column's
    // empty edge would let a "drags audition too" bug through, because the handler finds
    // no pitch under it either way.
    const key = keys.querySelector('[data-pitch]') as HTMLElement;
    await act(async () => {
      keys.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, clientX: 10, clientY: 200, bubbles: true }));
      keys.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: 10, clientY: 240, bubbles: true }));
      keys.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: 10, clientY: 280, bubbles: true }));
      key.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, clientX: 10, clientY: 280, bubbles: true }));
    });
    expect(scroller.scrollTop, 'the keys drag did not scroll the roll').toBeLessThan(before);

    // ...and a drag is not an audition. A note under a scrolling thumb is noise.
    expect(commands.filter((command) => command.type === 'noteOn')).toHaveLength(0);
  });

  it('the octave buttons move the range by twelve rows', async () => {
    await mount('track-1');
    const scroller = grid();
    scroller.scrollTop = 200;
    const before = scroller.scrollTop;

    // Twelve ROWS, measured off a drawn key rather than restated as a number here: a
    // button that moved the range by one row would satisfy "it moved" and be useless.
    const rowHeight = (container.querySelector('[data-pitch]') as HTMLElement).getBoundingClientRect().height;
    expect(rowHeight).toBeGreaterThan(0);

    await act(async () => (container.querySelector('[aria-label="scroll down an octave"]') as HTMLElement).click());
    const down = scroller.scrollTop;
    expect(down - before).toBeCloseTo(12 * rowHeight, 0);

    await act(async () => (container.querySelector('[aria-label="scroll up an octave"]') as HTMLElement).click());
    expect(scroller.scrollTop).toBe(before);
  });
});
