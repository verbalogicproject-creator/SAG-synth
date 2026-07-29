/**
 * src/tests/allocate.test.ts — voice allocation (decision D1).
 *
 * The allocator runs twice for every note: once live, once during journal replay. Any
 * nondeterminism here shows up as a state divergence in F59, so the determinism cases
 * below matter as much as the musical ones.
 */

import { describe, expect, it } from 'vitest';
import { allocate, applyAllocation, releaseNote } from '../core/allocate';
import type { VoiceSlot } from '../core/state';

const slot = (voiceId: number, note: string, order: number): VoiceSlot => ({
  voiceId,
  note,
  velocity: 0.8,
  order,
});

const request = (note: string, order: number) => ({ note, velocity: 0.8, order });

describe('allocate', () => {
  it('takes voice 0 from an empty pool', () => {
    expect(allocate([], 8, 'oldest', request('C4', 0))).toEqual({ voiceId: 0 });
  });

  it('fills the lowest free id, not the next one up', () => {
    // Lowest-free rather than round-robin: the same command sequence must land on the
    // same voice ids every time it is replayed.
    const voices = [slot(0, 'C4', 0), slot(2, 'G4', 1)];
    expect(allocate(voices, 8, 'oldest', request('E4', 2))).toEqual({ voiceId: 1 });
  });

  it('retriggers the voice already sounding that note instead of burning a slot', () => {
    const voices = [slot(0, 'C4', 0), slot(1, 'E4', 1)];
    const result = allocate(voices, 8, 'oldest', request('C4', 2));
    expect(result).toEqual({ voiceId: 0 });
    expect(result.stolen).toBeUndefined();
  });

  it('steals the oldest voice when the pool is full', () => {
    const voices = [slot(0, 'C4', 5), slot(1, 'E4', 2), slot(2, 'G4', 9)];
    const result = allocate(voices, 3, 'oldest', request('B4', 10));
    expect(result.voiceId).toBe(1);
    expect(result.stolen).toEqual(slot(1, 'E4', 2));
  });

  it('breaks an order tie by lowest voiceId rather than array position', () => {
    // Two voices can share an order after a replay seeds them in one batch. Without an
    // explicit tie-break the victim would depend on array order.
    const shuffled = [slot(2, 'G4', 4), slot(0, 'C4', 4), slot(1, 'E4', 4)];
    expect(allocate(shuffled, 3, 'oldest', request('B4', 5)).voiceId).toBe(0);
  });

  it('reclaims an over-cap voice first when polyphony was just lowered', () => {
    // Voices 2 and 3 should not be sounding at all under a cap of 2. Taking one back
    // costs a note that is already over budget instead of a legitimate voice.
    const voices = [slot(0, 'C4', 9), slot(1, 'E4', 8), slot(2, 'G4', 1), slot(3, 'B4', 0)];
    const result = allocate(voices, 2, 'oldest', request('D5', 10));
    expect(result.voiceId).toBe(3);
    expect(result.stolen).toEqual(slot(3, 'B4', 0));
  });

  it('treats a cap below 1 as monophonic rather than allocating nothing', () => {
    expect(allocate([], 0, 'oldest', request('C4', 0))).toEqual({ voiceId: 0 });
    const voices = [slot(0, 'C4', 0)];
    expect(allocate(voices, 0, 'oldest', request('E4', 1)).voiceId).toBe(0);
  });

  it('is deterministic across repeated identical calls', () => {
    const voices = [slot(0, 'C4', 3), slot(1, 'E4', 1), slot(2, 'G4', 2)];
    const first = allocate(voices, 3, 'oldest', request('B4', 4));
    const second = allocate(voices, 3, 'oldest', request('B4', 4));
    expect(first).toEqual(second);
  });

  it('never mutates the pool it was given', () => {
    const voices = [slot(0, 'C4', 0)];
    const snapshot = structuredClone(voices);
    allocate(voices, 1, 'oldest', request('E4', 1));
    expect(voices).toEqual(snapshot);
  });
});

describe('applyAllocation', () => {
  it('records the new voice and evicts whatever held that id', () => {
    const voices = [slot(0, 'C4', 0), slot(1, 'E4', 1)];
    const next = applyAllocation(voices, { voiceId: 1, stolen: slot(1, 'E4', 1) }, request('G4', 2));
    expect(next).toEqual([slot(0, 'C4', 0), slot(1, 'G4', 2)]);
  });

  it('keeps one canonical ordering so equivalent histories compare equal', () => {
    const a = applyAllocation(
      applyAllocation([], { voiceId: 1 }, request('E4', 0)),
      { voiceId: 0 },
      request('C4', 1),
    );
    const b = applyAllocation(
      applyAllocation([], { voiceId: 0 }, request('C4', 1)),
      { voiceId: 1 },
      request('E4', 0),
    );
    expect(a.map((v) => v.voiceId)).toEqual([0, 1]);
    expect(a).toEqual(b);
  });
});

describe('releaseNote', () => {
  it('releases the voice sounding that note', () => {
    const voices = [slot(0, 'C4', 0), slot(1, 'E4', 1)];
    const { voices: next, released } = releaseNote(voices, 'C4');
    expect(released).toEqual(slot(0, 'C4', 0));
    expect(next).toEqual([slot(1, 'E4', 1)]);
  });

  it('is a no-op for a note that is not sounding', () => {
    const voices = [slot(0, 'C4', 0)];
    const { voices: next, released } = releaseNote(voices, 'G9');
    expect(released).toBeUndefined();
    expect(next).toEqual(voices);
  });
});
