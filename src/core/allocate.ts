/**
 * src/core/allocate.ts — voice allocation and stealing, as a pure function.
 *
 * Decision D1: core decides which voice sounds and which voice dies; the runtime only
 * executes the verdict. Tone.PolySynth was rejected precisely because it hides this
 * decision inside the library and hard-codes oldest-steal.
 *
 * Every branch here must be deterministic. `allocate` runs on the hot path during live
 * play AND again during journal replay, and if the two disagree the reconstructed state
 * diverges from the live one (F59). That is why ties are broken explicitly rather than
 * left to array order or `Set` iteration order.
 */

import type { NoteName, Unit, VoiceConfig } from './types';
import type { AllocationResult, VoiceSlot } from './state';

export interface AllocationRequest {
  note: NoteName;
  velocity: Unit;
  /** Monotonic note-on counter; the ordering key for the 'oldest' policy. */
  order: number;
}

/**
 * Lowest `order` wins, ties broken by lowest `voiceId`.
 *
 * The tie-break is not decorative — two voices can share an `order` after a replay seeds
 * them in one batch — but the reason it is needed is narrower than it first looks, and
 * the version of this comment that cited engine-dependent sorting was wrong. ES2019
 * mandates that `Array.prototype.sort` is stable, and this function does not sort at all;
 * it scans.
 *
 * The real hazard is that both scanning and stable sorting resolve a tie by **input
 * order**, and input order is a property of how the array was built rather than of the
 * state it represents. A live session and a replay can hold the same logical voices in a
 * different arrangement and would then steal different ones. Comparing `voiceId` makes
 * the verdict a function of the data alone, which is what F59 actually requires.
 */
function oldest(voices: readonly VoiceSlot[]): VoiceSlot {
  let victim = voices[0]!;
  for (const voice of voices) {
    if (voice.order < victim.order) victim = voice;
    else if (voice.order === victim.order && voice.voiceId < victim.voiceId) victim = voice;
  }
  return victim;
}

function selectVictim(voices: readonly VoiceSlot[], policy: VoiceConfig['stealPolicy']): VoiceSlot {
  switch (policy) {
    case 'oldest':
      return oldest(voices);
  }
}

/**
 * Decide which voice should play `request.note`.
 *
 * Order of preference:
 *   1. A voice already sounding this note — retrigger it rather than burning a second
 *      slot. Holding C4 and pressing C4 again is one voice on real hardware.
 *   2. The lowest free voice id below the cap. Lowest-free rather than next-round-robin
 *      so the same command sequence always lands on the same ids.
 *   3. A voice sounding ABOVE the cap, if polyphony was just lowered. Those slots are
 *      already over budget, so reclaiming one costs a note that should not be sounding
 *      anyway — cheaper than stealing a legitimate voice.
 *   4. Otherwise steal per policy.
 */
export function allocate(
  voices: readonly VoiceSlot[],
  cap: number,
  policy: VoiceConfig['stealPolicy'],
  request: AllocationRequest,
): AllocationResult {
  // The schema bounds polyphony to [1, 32], but allocate is also reachable from the
  // v0.2 SDK and from replayed journals written by other builds.
  const limit = Math.max(1, Math.floor(cap));

  const retrigger = voices.find((voice) => voice.note === request.note);
  if (retrigger !== undefined) return { voiceId: retrigger.voiceId };

  const used = new Set(voices.map((voice) => voice.voiceId));
  for (let voiceId = 0; voiceId < limit; voiceId += 1) {
    if (!used.has(voiceId)) return { voiceId };
  }

  const overCap = voices.filter((voice) => voice.voiceId >= limit);
  const victim = overCap.length > 0 ? oldest(overCap) : selectVictim(voices, policy);
  return { voiceId: victim.voiceId, stolen: victim };
}

/**
 * The transient bookkeeping that follows an allocation. Kept beside `allocate` so the
 * two cannot drift, but deliberately separate: `allocate` decides, this records.
 */
export function applyAllocation(
  voices: readonly VoiceSlot[],
  result: AllocationResult,
  request: AllocationRequest,
): VoiceSlot[] {
  const next = voices.filter((voice) => voice.voiceId !== result.voiceId);
  next.push({
    voiceId: result.voiceId,
    note: request.note,
    velocity: request.velocity,
    order: request.order,
  });
  // Sorted by voiceId so the transient state has one canonical representation and two
  // equivalent histories compare equal.
  return next.sort((a, b) => a.voiceId - b.voiceId);
}

/** Release whichever voice is sounding `note`; a no-op when none is. */
export function releaseNote(
  voices: readonly VoiceSlot[],
  note: NoteName,
): { voices: VoiceSlot[]; released?: VoiceSlot } {
  const released = voices.find((voice) => voice.note === note);
  if (released === undefined) return { voices: [...voices] };
  return { voices: voices.filter((voice) => voice.voiceId !== released.voiceId), released };
}
