# 06 — v0.2 Sequencer and Transport Design for a Manual Voice Pool

## Aligned premise
v0.1.0 shipped **live keys only** — voice pool, full patch, effects, **no `Tone.Transport`, no sequencer, no MIDI autoplay**. The runtime's `applySong` and `transport.*` currently record that they were called and warn, rather than throwing or silently no-opping. Docs 05/06 from the original pack are therefore not yet consumed by the runtime, though the MIDI *import* path (parsing into the song document without playing it) is already active.

The right v0.2.0 question is not "how do I build a Tone.js step sequencer" but "how do I use Tone's scheduler while keeping voice assignment external and journal-visible."

## Recommended approach
Use `Tone.Transport` only as the clock and callback scheduler. Do not let `Tone.Part`/`Tone.Sequence` own musical truth if doing so would hide allocation or implicit ordering decisions — they are convenience wrappers, not the source of truth, in this architecture.

### Preferred v0.2 path
1. Keep song notes in core as `NoteEvent[]` in beats (see doc 03).
2. On playback start, compile a sorted runtime event list with explicit, documented tie-breakers:
   - `timeBeats` (primary)
   - event-kind priority (e.g., note-off before note-on at the same instant, if that is the chosen policy)
   - `trackId`, `noteId`, and pre-allocated `voiceId` as final tie-breakers
3. Feed each event into the **same core command surface** the UI/agent uses, but from within a transport-driven clock callback.
4. Runtime executes the emitted allocator verdicts against the manual `MonoSynth` pool from doc 02, applying the monotonic-clock collision guard.

## Open research question (Q2)
How do `Tone.Part`/`Tone.Sequence` scheduling and lookahead interact with a pool where an external pure function assigns the voice for each scheduled note? This needs dedicated investigation before v0.2.0 transport work begins — Tone's internal lookahead buffer may schedule several notes ahead of the audio clock, which could race with a core allocator that expects to decide allocation at dispatch time, not lookahead time.

## What still transfers unchanged
The original insight that the 16-step grid should be a **projection over one free-time note structure** remains correct and load-bearing: notes are stored as a free-time `NoteEvent[]`, and the grid is a view over it, not a competing representation. This means MIDI import and step editing write into one structure that cannot disagree with itself. Keep this exactly as-is.
