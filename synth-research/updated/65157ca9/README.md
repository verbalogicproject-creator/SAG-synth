# aligned-synth-research

This archive is a second-pass research pack aligned to the actual implementation direction described in `00_implementation_alignment.md`: a replayable, journal-first, AI-agent-addressable synthesizer where every state change must survive deterministic replay, including undo/redo.

## Contents
1. `00_aligned_research_overview.md` — what changed and why, at a glance
2. `01_replayable_architecture.md` — four-layer dependency contract (core/runtime/app/clients)
3. `02_manual_voice_pool.md` — manual MonoSynth pool replacing PolySynth, with empirical clipping/collision findings
4. `03_time_model_and_transport_boundary.md` — beats-in-core vs seconds-at-runtime-boundary
5. `04_history_journal_and_deterministic_ids.md` — journaled undo/redo, injected IDs and timestamps
6. `05_effect_determinism_and_offline_testing.md` — Freeverb vs Tone.Reverb, Tone.Offline gates, open Limiter question (Q1)
7. `06_sequencer_v0_2_for_manual_pool.md` — Transport design over a manual pool, deferred to v0.2.0
8. `07_midi_import_for_replayable_songs.md` — deterministic MIDI import pipeline via @tonejs/midi
9. `08_per_voice_lfo_and_modulation.md` — per-voice LFO phase without exploding object count
10. `09_param_paths_and_schema_contracts.md` — the 70-path finite ParamPath union
11. `10_v0_2_research_questions_and_adoption_plan.md` — prioritized Q1-Q4 and phased delivery plan

## Source
Derived from `00_implementation_alignment.md`, which documents the delta between the original 10-doc greenfield synth research pack and what was actually built (SAG-synth), plus Tone.js/@tonejs/midi library behavior referenced therein.
