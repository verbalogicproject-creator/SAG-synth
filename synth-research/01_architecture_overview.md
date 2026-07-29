# 01 — Synthesizer Architecture Overview

## Purpose
This document gives the high-level architecture for a browser-based JS/TypeScript synthesizer with ADSR, filters, LFO, multiple wave shapes, presets, effects, a step sequencer, song/preset save-load, and MIDI file import for autoplay. Use this as the map; other markdown files in this pack cover each subsystem in depth.

## Core Technology Choice
Two viable foundations exist:

1. **Tone.js** (recommended for fastest path to a full-featured synth) — a high-level Web Audio framework that wraps native nodes with musical abstractions (notes, time, Transport, envelopes, effects) [web:18][web:46].
2. **Raw Web Audio API** (recommended if you want full DSP control, custom wave shaping, or plan to write AudioWorklet DSP) — lower-level, more code, more control [web:45][web:12].

A pragmatic hybrid: use Tone.js for the transport/scheduling/effects/instrument layer, and drop to raw `AudioWorkletNode`/`PeriodicWave` for custom oscillator algorithms not exposed by Tone (e.g., wavetable morphing) [web:45][web:58].

## System Layers

```
┌─────────────────────────────────────────────┐
│  UI Layer (React/Svelte/Vue + Web Components) │
├─────────────────────────────────────────────┤
│  App State (voice params, presets, song data)  │
├─────────────────────────────────────────────┤
│  Sequencer / Transport (Tone.Transport,        │
│  Tone.Sequence/Part, MIDI scheduling)           │
├─────────────────────────────────────────────┤
│  Synth Engine (PolySynth voices: Oscillator →   │
│  Filter → Amp Envelope → Effects Chain)         │
├─────────────────────────────────────────────┤
│  Modulation Layer (LFOs → Filter/Pitch/Amp)     │
├─────────────────────────────────────────────┤
│  Effects Bus (Chorus, Delay, Reverb, Distortion)│
├─────────────────────────────────────────────┤
│  Web Audio API / AudioContext (native engine)   │
└─────────────────────────────────────────────┘
```

## Recommended Project Structure (TypeScript)

```
src/
  audio/
    context.ts          # AudioContext bootstrapping, Tone.start()
    engine/
      Voice.ts           # single voice: osc + filter + envelope
      SynthEngine.ts      # manages PolySynth / voice pool
      LFO.ts
      Effects.ts          # effects chain builder
    sequencer/
      Sequencer.ts        # step sequencer logic (Tone.Sequence/Part)
      MidiImporter.ts      # @tonejs/midi based file loader
    persistence/
      PresetStore.ts       # save/load preset JSON
      SongStore.ts          # save/load song/project JSON
  state/
    store.ts              # Zustand/Redux app state
  ui/
    components/
  types/
    synth-types.ts        # shared TS interfaces (see 09_data_models.md)
```

## Signal Flow Per Voice
Each polyphonic voice follows a classic subtractive-synth chain:

`Oscillator(s) → Mixer → Filter → VCA (Amp Envelope) → Voice Output → Effects Bus → Master Output`

Modulation sources (LFOs, envelope followers) tap into this chain as control signals rather than audio signals — e.g., an LFO modulates `filter.frequency` or `oscillator.detune` [web:6][web:45].

## Key Architectural Decisions to Make Early

| Decision | Options | Recommendation |
|---|---|---|
| Synthesis method | Subtractive, FM, AM, Wavetable | Subtractive as base engine; add FM/Wavetable as alternate oscillator modes [web:51] |
| Audio engine | Tone.js vs raw Web Audio vs AudioWorklet | Tone.js core + AudioWorklet for custom oscillators |
| Voice allocation | Fixed voice pool vs dynamic PolySynth | `Tone.PolySynth` handles allocation automatically [web:46] |
| State management | Redux/Zustand/Context | Any; keep synth params as serializable plain objects for easy preset save |
| Persistence | localStorage vs IndexedDB vs file export | IndexedDB for songs (larger), localStorage or JSON file export for presets |
| MIDI | Web MIDI API (hardware) vs @tonejs/midi (files) | Use both: @tonejs/midi for imported files, Web MIDI API optionally for live hardware input [web:29][web:33] |

## What People Commonly Forget (Preview)
See `10_extra_features_checklist.md` for the full list, but headline omissions are: audio context resume-on-gesture, voice stealing/polyphony limits, portamento/glide, velocity sensitivity, pitch bend/mod wheel, unison/detune stacking, master limiter/compressor to prevent clipping, keyboard velocity curves, and undo/redo for the sequencer.

## Cross-References
- Oscillators & wave shapes: `02_oscillators_and_wave_shapes.md`
- ADSR & filter & LFO: `03_envelope_filter_lfo.md`
- Effects: `04_effects_chain.md`
- Sequencer: `05_sequencer.md`
- MIDI file import: `06_midi_file_import.md`
- Presets: `07_preset_system.md`
- Song save/load: `08_song_persistence.md`
- Data models/types: `09_data_models.md`
- Forgotten features checklist: `10_extra_features_checklist.md`
