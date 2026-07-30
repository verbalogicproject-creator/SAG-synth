# 10 — v0.2 Research Questions and Adoption Plan

## Highest-priority open research threads (in the implementation's own priority order)
1. **Q1 — `Tone.Limiter` measurement anomaly.** What is the correct way to verify `Tone.Limiter` behavior in an offline render, and does its lookahead shift the signal in a way that breaks naive peak comparison between two separately-rendered buffers? (See doc 05.)
2. **Q2 — `Tone.Transport` with manual voice allocation.** How do `Tone.Part`/`Tone.Sequence` scheduling and lookahead interact with a pool where an external pure function assigns the voice for each scheduled note? (See doc 06.)
3. **Q3 — Per-voice LFO phase at scale.** Is there a cheaper construction than up to 4 × 32 `Tone.LFO` instances that still honors literal per-voice phase and retrigger semantics? (See doc 08.)
4. **Q4 — Deterministic effect inventory.** Which Tone effects are bit-reproducible across runs and which are not? `Tone.Reverb` is confirmed non-deterministic; a definitive list across the full effects catalog would let far more of the chain be gated. (See doc 05.)

## Suggested delivery plan

### Phase A — harden current v0.1.x foundations
- formalize a `DeterminismAssumptions.md` in-repo
- codify the runtime clock-collision policy (monotonic per-voice nudge) as a tested, documented invariant
- generate the param-path reference docs directly from the `PARAM_SPECS` source of truth
- build replay fixtures for presets, songs, and MIDI imports

### Phase B — v0.2 transport runtime
- compile beat-domain note events into stable, explicitly-ordered runtime schedules
- route every scheduled note event through the same dispatcher/history/allocator path as live UI/agent commands
- add transport control commands (start/stop/tempo-change) to the journal as first-class verbs
- add headless playback tests using `Tone.Offline`, resolving Q1 and Q2 before shipping autoplay

### Phase C — MIDI autoplay and agent SDK
- reuse the same schedule compiler for imported songs as for hand-authored ones (no privileged second playback path)
- expose the command envelope format (doc 04) as the stable, versioned SDK contract
- publish the finite parameter path catalog (doc 09) with examples as the agent-facing API reference

## What must remain frozen (explicitly preserved from the original pack)
Unless tests contradict them, these decisions should not be re-litigated by future research:
- self-contained songs with embedded `preset_snapshot` (not just a `preset_id` reference)
- the 16-step grid as a projection over one canonical `NoteEvent[]`
- effects chain order: `distortion → chorus → delay → reverb`
- `@tonejs/midi` for import, including ticks-to-beats and channel-10 drum detection
- canonical TypeScript-first data models, modulo the beats-not-seconds time-unit change (doc 03)

## Note on scope discipline
v0.1.0 deliberately shipped narrower than the original pack's full-instrument scope: live keys only, no transport, no sequencer, no MIDI autoplay. Any v0.2.0 research should respect that the runtime's `applySong`/`transport.*` currently warn-and-record rather than throw or silently no-op — that behavior is intentional scaffolding, not a bug to "fix" prematurely.
