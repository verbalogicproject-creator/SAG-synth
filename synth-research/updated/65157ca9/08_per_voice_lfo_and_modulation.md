# 08 — Per-Voice LFO Phase Without Losing Determinism

## Aligned problem
The patch spec says all voices share an LFO **configuration** but own independent **phase** — that's what a `retrigger` flag means. Taken literally, that implies up to 4 × 32 `Tone.LFO` instances (4 LFOs per voice, 32-voice pool), which is expensive.

## Why this differs from the original recommendation
The original pack's doc 09 already identified the escape hatch — "manage a manual pool of `Tone.MonoSynth` instances yourself instead of `Tone.PolySynth`" — but framed it as a consequence of wanting per-voice LFO phase specifically. The actual reason for the manual pool is stronger and applies from the first note (replayability), not just to modulation — but that original insight is exactly what now needs to be extended to LFO phase management.

## Architectural answer
Determinism does not require shared node instances; it requires stable rules. Separate:
- **configuration** in core (`rate`, `depth`, `shape`, `target`, `retrigger`) — same for all voices of a patch
- **phase policy** in core (`free-run`, `reset-on-note`, `resume-on-reuse`) — explicit and testable
- **node construction** in runtime — however many objects that policy requires

```ts
interface LfoSpec {
  lfoId: string;
  target: 'filterCutoff' | 'detune' | 'amp';
  shape: 'sine' | 'triangle' | 'square' | 'sawtooth';
  rateHz: number;
  depth: number;
  retrigger: boolean;
}

interface VoiceRuntimeModState {
  lfoPhase: Record<string, number>; // lfoId -> 0..1 cycle position
}
```

## Candidate implementations
- **Option A — per-voice `Tone.LFO` instances.** Best semantic match; each voice owns its own LFOs. Simple, but CPU scales with `voices × lfos`.
- **Option B — compute modulation in runtime tick callbacks.** Represent phase as numeric runtime state, write directly into target params on each scheduler tick. Fewer objects, more manual code, timing resolution becomes the implementer's problem.
- **Option C — hybrid.** Tone LFOs for always-on global modulation; manual per-voice phase only for retriggered voice-local modulation.

## Open research question (Q3)
Is there a cheaper construction than one `Tone.LFO` per voice per LFO slot that still honors literal per-voice phase and retrigger semantics under replay? This is unresolved and flagged as a priority for v0.2.0 research.

## Recommended phased plan
- v0.2.0: implement **one voice-local LFO path** first (pitch or filter cutoff), verify replay semantics end-to-end, then generalize to all 4 slots.
- cap voice count and LFO count aggressively during profiling before committing to Option A at scale.
- test retrigger semantics offline with golden phase expectations exactly at note-on boundaries.
