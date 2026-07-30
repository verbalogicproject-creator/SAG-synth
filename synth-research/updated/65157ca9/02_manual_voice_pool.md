# 02 — Manual `MonoSynth` Voice Pool Instead of `PolySynth`

## Aligned recommendation
Do not use `Tone.PolySynth` as the domain allocator. Keep allocation and voice-stealing decisions in a pure function in the domain core (e.g. `src/core/allocate.ts`), keyed by an explicit `voiceId`. Use a runtime pool of `Tone.MonoSynth` instances purely as execution targets that carry out the core's verdict.

## Why the original recommendation changed
The first-pass pack recommended `Tone.PolySynth` because it "handles allocation automatically" — that convenience is precisely the problem here. Allocation and voice-stealing must produce the identical verdict during live play and during journal replay, years later, on a different machine. A library that decides internally, and hard-codes oldest-steal, cannot be replayed. So the decision moved out of the audio layer entirely.

Ties are broken explicitly by `voiceId` because `Array.prototype.sort` is stable but not guaranteed deterministic across equal keys on every JS engine — an explicit comparator is required rather than relying on incidental sort stability.

## Practical runtime design
```ts
interface VoiceSlot {
  voiceId: string;
  synth: Tone.MonoSynth;
  assignedNoteId: string | null;
  state: 'idle' | 'attack' | 'sustain' | 'release';
  lastEventOrdinal: number;
  lastRuntimeTimeSec: number;
}
```

### Deterministic allocation policy
1. Core receives `noteOn`.
2. Core selects a voice slot from immutable state via a pure function.
3. Ties are broken by explicit `voiceId` ordering, not incidental array order.
4. Core emits exactly one journal event containing the decided `voiceId`.
5. Runtime executes the exact verdict; it never re-decides anything.

## Empirical collision hazard (measured on target hardware)
Tone.js asserts a source's start time is strictly greater than its previous one — two events landing on the same voice at the same clock instant throw. This is not exotic: a voice-steal is issued immediately before the `noteOn` that reuses the slot, and under `Tone.Offline` the whole callback runs at one timestamp. Any manual voice pool needs a per-voice monotonic clock:

```ts
function monotonicVoiceTime(slot: VoiceSlot, requestedSec: number): number {
  const minStep = 0.0001; // 0.1 ms
  const next = requestedSec <= slot.lastRuntimeTimeSec
    ? slot.lastRuntimeTimeSec + minStep
    : requestedSec;
  slot.lastRuntimeTimeSec = next;
  return next;
}
```

## Why `MonoSynth` fits well
`Tone.MonoSynth`'s option shape is very close to a 1:1 fit for a voice model of oscillator + amp envelope + filter + filter envelope — this makes a manual pool much cheaper to build than expected, and is a point in favor of recommending MonoSynth pools over PolySynth generally, even outside strict-replay contexts.

## Gain-staging warning (measured)
Eight `MonoSynth` voices at velocity 1.0 through a -6 dB master peaked at 1.0122 — real clipping, since Web Audio hard-clips at ±1. Any voice-pool design must budget headroom (e.g., a master limiter/compressor, or per-voice gain scaling by expected max polyphony) rather than assuming "the allocator handles it."
