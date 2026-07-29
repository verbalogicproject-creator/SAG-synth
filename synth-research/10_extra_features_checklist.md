# 10 — Things Often Forgotten in a "Decent" Synthesizer (Checklist)

This document is a checklist of features and engineering details that are easy to miss when building a synthesizer, but expected in anything beyond a toy demo.

## Audio Context / Browser Requirements
- **User-gesture audio unlock**: browsers block audio until `Tone.start()` (or `audioContext.resume()`) is called from within a real user interaction (click/keydown). Always wire your "Play"/first key-press to this [web:46].
- **Visibility/suspend handling**: some browsers suspend the AudioContext when the tab is backgrounded; consider resuming on `visibilitychange`.
- **Sample-accurate scheduling**: never use `setTimeout`/`setInterval` for musical timing — always pass the `time` argument through to trigger calls [web:45][web:46].
- **Dispose everything**: call `.dispose()` on Tone.js nodes/synths that are no longer used (e.g., after switching presets or unloading a MIDI file) to avoid memory leaks [web:46].

## Voice / Performance Features
- **Polyphony limit & voice stealing** — cap `maxPolyphony`, decide oldest-note-steal vs quietest-note-steal behavior.
- **Portamento/glide** — smooth pitch slide between consecutive notes (`Tone.MonoSynth` has a `portamento` option); often forgotten but core to "synth feel."
- **Velocity sensitivity** — map MIDI/keyboard velocity to amplitude and optionally filter cutoff/brightness, not just raw volume.
- **Pitch bend & mod wheel** — MIDI CC 1 (mod wheel) commonly routed to vibrato depth or filter; pitch bend (CC in range ±2 semitones typical) needs smooth `detune`/`frequency` ramping.
- **Legato vs retrigger mode** — whether the envelope re-triggers on overlapping notes in mono mode or glides continuously.
- **Unison/detune stacking** — see `02_oscillators_and_wave_shapes.md`; a huge part of "fat" synth sound.
- **Aftertouch** (optional, advanced) — per-note pressure modulation, rarely implemented but nice for expressive playing.

## Modulation
- **Multiple LFOs per voice with selectable targets** (pitch, filter, amp, pan) — most synths ship 2+.
- **Modulation matrix / flexible routing** (advanced) — letting any modulation source route to any destination with adjustable depth, rather than hard-wired routings.
- **Envelope followers** (advanced) — using input amplitude to drive a filter sweep (as in `Tone.AutoWah`).
- **Key tracking** — filter cutoff or LFO rate that scales with note pitch (common on real analog synths), not just static.

## Filter & Envelope Completeness
- **Separate amp envelope and filter envelope** (see `03_envelope_filter_lfo.md`) — a common oversight is wiring ADSR only to volume.
- **Envelope curve shape** — linear vs exponential ramps sound very different; Tone.js supports curve options on `Tone.Envelope` (`attackCurve`, `releaseCurve`).
- **Filter resonance (Q) and multiple filter types/slopes** (-12/-24/-48 dB/oct).

## Mix / Master Bus
- **Master limiter/compressor** to prevent clipping when many voices/effects sum (`Tone.Limiter`) [see `04_effects_chain.md`].
- **Master volume control**, separate from individual voice/track volumes.
- **Per-track mute/solo** in the sequencer.
- **Metering/level display** (`Tone.Meter` or `AnalyserNode`) for visual feedback and to catch clipping.

## Sequencer/Song Completeness
- **Swing/groove** (`Tone.Transport.swing`) — see `05_sequencer.md`.
- **Multiple patterns per song, pattern chaining/arrangement view** — a step sequencer alone is a "pattern"; a real song usually chains several patterns in sequence (verse/chorus style) or has a timeline/arrangement view.
- **Undo/redo** for both sequencer edits and parameter tweaks.
- **Per-track effects sends** vs global effects — see `04_effects_chain.md`.
- **Metronome/click track** for reference while composing.
- **Loop region / punch-in-out** for the transport.

## MIDI-Specific
- **General MIDI program-to-preset mapping** and drum-channel (channel 10) handling on import — see `06_midi_file_import.md`.
- **Tempo-map support** (mid-song tempo changes) when importing MIDI, not just a single fixed BPM.
- **MIDI export** — letting users export their sequencer pattern as a `.mid` file (via `@tonejs/midi`'s write support), a frequently requested companion feature to import.
- **Web MIDI API for live hardware input** (optional but expected by "serious" users) — separate from file import, lets a real MIDI keyboard control the synth directly [web:33][web:39].

## Persistence-Specific
- **Schema versioning + migration** for both presets and songs (see `07_preset_system.md`, `08_song_persistence.md`).
- **Autosave** with recovery-on-reload prompt.
- **Export/import as portable JSON files**, not just local storage — critical for sharing presets/songs and for backup.
- **Preset categorization/tagging and search** in the library UI.
- **Validation/sanitization of imported JSON** (zod or similar) before applying untrusted data to the audio graph.

## UX/Accessibility
- **Keyboard-controllable virtual piano** (computer keyboard → notes) as a fallback when no MIDI hardware is present — libraries like Qwerty Hancock simplify this [web:14].
- **Visual waveform/oscilloscope display** (`AnalyserNode.getFloatTimeDomainData`) so users can see what they're shaping.
- **Spectrum analyzer** (`AnalyserNode.getFloatFrequencyData` or `Tone.FFT`) for filter/EQ visual feedback.
- **Responsive/touch support** for mobile — relevant given your interest in mobile LLM/app deployment; Web Audio + Tone.js both work on mobile Safari/Chrome, but iOS Safari has stricter autoplay/gesture rules worth testing early.
- **Latency awareness** — set `Tone.getContext().latencyHint = "interactive"` for lower-latency real-time playing versus `"playback"` for sequenced/background contexts.

## Testing/Debugging
- **CPU/performance profiling** — Web Audio glitches (crackling) often stem from too many nodes; profile with Chrome's Performance tab and the `AudioContext.outputLatency`/`baseLatency` properties.
- **Cross-browser testing** — Safari has historically had different Web Audio timing/latency behavior than Chrome/Firefox; test the sequencer specifically for drift.

## Suggested Library Shortlist (summary across this pack)
| Need | Library |
|---|---|
| Core synthesis/scheduling/effects | `tone` (Tone.js) [web:18] |
| MIDI file parsing/writing | `@tonejs/midi` [web:29] |
| Live MIDI hardware (optional) | native Web MIDI API, or `webmidi` (WebMidi.js) [web:39] |
| IndexedDB storage wrapper | `idb` |
| Schema validation | `zod` |
| State management | `zustand` (+ `zundo` for undo/redo) |
| Custom DSP beyond Tone.js | native `AudioWorkletProcessor` [web:45] |
| Virtual on-screen keyboard | `qwerty-hancock` or a custom component [web:14] |
