# 00 — Aligned Research Overview

## Purpose
This pack re-researches the synthesizer architecture against the implementation direction actually taken, described in `00_implementation_alignment.md`. The anchor constraint is: **every state change must be replayable byte-identically from the journal, including undo/redo**, because v0.2.0 gives an AI agent programmatic control of the synth as a peer client of the React UI over the same command surface.

That requirement changes several recommendations from the original greenfield research pack:
- prefer a **manual `Tone.MonoSynth` voice pool** over `Tone.PolySynth`
- keep **time in beats** inside the core model, converting to Tone units only at the runtime boundary
- make **undo/redo journaled commands**, not store-local cursors (zustand/zundo installed but unused)
- ban **clock reads and ID generation** below the app layer
- prefer **deterministic / directly-assertable effects parameters** (Freeverb over Tone.Reverb) over opaque randomized construction
- enforce a strict four-layer dependency graph (`core/` → `runtime/` → `app/` → `clients/`) mechanically via import-contract tests
- treat **exactly 70 finite, compile-time parameter paths** as the only mutation surface

## What stayed the same
Several original recommendations survived contact with the implementation unchanged: self-contained songs with embedded preset snapshots, the 16-step grid as a projection over one canonical free-time note-event list, the effects chain order (distortion → chorus → delay → reverb), `@tonejs/midi` for import, and the canonical TypeScript-first data models.

## Core thesis
Treat Tone.js as a **runtime executor**, not as the authority on allocation, history, IDs, tempo semantics, or persistence. The deterministic domain core decides *what happened*; Tone.js performs *how it sounds*.

## Scope note
v0.1.0 shipped live-keys only: voice pool, full patch, effects — no `Tone.Transport`, no sequencer, no MIDI autoplay. v0.2.0 is phased: sequencer/transport runtime, MIDI-import playback, designed UI, and the agent SDK. This pack targets that v0.2.0 phase directly.

## Cross-references
- `01_replayable_architecture.md` — layer boundaries and dependency enforcement
- `02_manual_voice_pool.md` — allocator design replacing PolySynth
- `03_time_model_and_transport_boundary.md` — beats vs seconds
- `04_history_journal_and_deterministic_ids.md` — journaled undo/redo, injected IDs
- `05_effect_determinism_and_offline_testing.md` — determinism gates, Freeverb, Limiter question
- `06_sequencer_v0_2_for_manual_pool.md` — Transport design over manual pool
- `07_midi_import_for_replayable_songs.md` — deterministic MIDI import pipeline
- `08_per_voice_lfo_and_modulation.md` — per-voice LFO phase without losing determinism
- `09_param_paths_and_schema_contracts.md` — finite parameter path union
- `10_v0_2_research_questions_and_adoption_plan.md` — prioritized open questions and delivery plan
