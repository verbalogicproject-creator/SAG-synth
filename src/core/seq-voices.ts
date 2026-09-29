/**
 * src/core/seq-voices.ts — voice allocation for sequenced notes, decided at SCHEDULE time.
 *
 * This is the answer to LP1 ("transport lookahead versus an external allocator", filed in
 * ROADMAP.md since 0.1.17). The worry was that `Tone.Transport` schedules ahead of the audio
 * clock while `allocate()` decides "now", so a sequencer would have the allocator deciding
 * about voices whose notes have not started yet, against a voice table that describes the
 * present.
 *
 * It dissolves once two things are true, and this module makes both true:
 *
 * 1. **Sequenced notes never share a pool with live keys.** Each pitched track owns a pool;
 *    keys keep theirs in the dispatcher's `TransientState`. The two clocks never meet.
 * 2. **The pool only ever sees events in time order.** `eventsInWindow` sorts each window and
 *    windows arrive consecutively, so the pool's table is always "the state at the beat of
 *    the event being decided" — a future beat, consistently, never a mix of now and later.
 *
 * Under those two conditions the lookahead window changes WHEN the JavaScript runs, never
 * WHAT is decided. `seq-voices.test.ts` proves it by replaying the same bars through window
 * sizes from 1 ms to half a bar and requiring identical verdicts.
 *
 * The allocator is still core's pure `allocate()` (decision D1). Not journaled per note: the
 * pool is a function of the song and the position, so play/seek — already journaled — are
 * what replay needs (F59).
 */

import { allocate, applyAllocation } from './allocate';
import type { VoiceId, VoiceSlot } from './state';
import type { VoiceConfig } from './types';
import type { ScheduledEvent } from './schedule';

export interface SeqPool {
  voices: readonly VoiceSlot[];
  /** Which voice each sounding note owns, keyed `trackId/noteId`. */
  owners: ReadonlyMap<string, VoiceId>;
  /** Monotonic note-on counter: the 'oldest' policy's ordering key. */
  order: number;
}

export type SeqAction =
  | { kind: 'on'; voiceId: VoiceId; stolen?: VoiceId }
  | { kind: 'off'; voiceId: VoiceId };

export function emptySeqPool(): SeqPool {
  return { voices: [], owners: new Map(), order: 0 };
}

export function ownerKey(event: Pick<ScheduledEvent, 'trackId' | 'noteId'>): string {
  return `${event.trackId}/${event.noteId}`;
}

/**
 * Decide one event. Returns the new pool and what the runtime must do, or `null` when there
 * is nothing to do — an off for a note whose voice was since stolen or retriggered by
 * another note.
 */
export function seqStep(
  pool: SeqPool,
  event: ScheduledEvent,
  voice: Pick<VoiceConfig, 'polyphony' | 'stealPolicy'>,
): { pool: SeqPool; action: SeqAction | null } {
  const key = ownerKey(event);

  if (event.kind === 'off') {
    const voiceId = pool.owners.get(key);
    if (voiceId === undefined) return { pool, action: null };
    const owners = new Map(pool.owners);
    owners.delete(key);
    // The voice may have been retriggered by a newer note of the same pitch (allocate's
    // rule 1). Only the note that owns it now may release it.
    const stillOwned = [...owners.values()].includes(voiceId);
    if (stillOwned) return { pool: { ...pool, owners }, action: null };
    return {
      pool: { ...pool, owners, voices: pool.voices.filter((slot) => slot.voiceId !== voiceId) },
      action: { kind: 'off', voiceId },
    };
  }

  const request = { note: event.note, velocity: event.velocity, order: pool.order };
  const result = allocate(pool.voices, voice.polyphony, voice.stealPolicy, request);
  const owners = new Map(pool.owners);
  // Whoever owned this voice before — a stolen note, or the same pitch being retriggered —
  // no longer does. Its eventual off must be a no-op.
  for (const [owner, voiceId] of owners) if (voiceId === result.voiceId) owners.delete(owner);
  owners.set(key, result.voiceId);

  return {
    pool: {
      voices: applyAllocation(pool.voices, result, request),
      owners,
      order: pool.order + 1,
    },
    action:
      result.stolen === undefined
        ? { kind: 'on', voiceId: result.voiceId }
        : { kind: 'on', voiceId: result.voiceId, stolen: result.stolen.voiceId },
  };
}
