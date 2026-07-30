# 01 — Replayable Architecture and Layer Boundaries

## Aligned dependency graph
```text
core/     zod only. No Tone, no React, no DOM globals, no filesystem.
runtime/  the ONLY subtree allowed to import tone.
app/      adapters + dispatcher. May import idb, @tonejs/midi. Never tone.
clients/  React. Never tone; every note goes through the dispatcher.
```
This differs from the original runtime-data-flow diagram (UI → App State → Sequencer/Transport → Synth Engine → Modulation → Effects), which is a data-flow view, not a dependency-direction contract. The dependency direction is what actually matters for replay: swapping `ToneRuntime` for a `NullRuntime` makes the whole engine headless — the v0.2.0 agent-SDK seam depends on that swap being trivial.

## Why this direction is sound
Tone.js is optimized for musical ergonomics, not replayable event sourcing — its Transport/Sequence/Synth/Effect abstractions are live audio constructs, not immutable state transitions. That's correct for the library's purpose, but it confirms the split: policy lives in `core/`, side effects live in `runtime/`.

## Mechanical enforcement
Import-contract tests should scan every source file for all four import forms — static, side-effect, dynamic, and `require` — and fail the build on any violation. Each gate should be verified by deliberately introducing the violation it exists to catch and confirming the test fails before trusting it.

## Suggested interfaces
```ts
export interface RuntimePort {
  noteOn(input: RuntimeNoteOn): void;
  noteOff(input: RuntimeNoteOff): void;
  setVoiceParam(input: RuntimeParamChange): void;
  setFxParam(input: RuntimeFxParamChange): void;
  applySong(snapshot: SongDoc): void;
  transport(command: TransportCommand): void;
  dispose(): void;
}
```

## Recommended additions
- Add an ESLint rule set mirroring the same import bans for faster local feedback than a full test run.
- Add a `DeterminismAssumptions.md` documenting exactly what replay guarantees cover: state bytes, journal bytes, offline-render tolerances, and explicitly excluded phenomena (e.g., non-deterministic reverb).
- Document the `NullRuntime` contract explicitly since it's the seam the future agent SDK depends on.
