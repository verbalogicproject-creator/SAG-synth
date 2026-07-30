# 07 — MIDI Import Aligned to Replayable Songs

## Aligned rule
Keep `@tonejs/midi` for parsing, but treat MIDI import as a **deterministic document-construction command**, not as a direct audio-event source. The original recommendation to adopt `@tonejs/midi` — including ticks-to-beats conversion and channel-10 drum detection — was adopted exactly and is now a gated behavior.

## Import pipeline
1. App layer receives an `ImportMidiCommandEnvelope` with an injected `commandId`, `createdAt`, and deterministic ID factories (see doc 04).
2. App layer parses the file using `@tonejs/midi`.
3. A converter maps tracks/notes/tempo map into core song objects **in beats**, never seconds.
4. Converter emits exactly one journal event (or a bounded, explicit series if import progress needs to be observable).
5. Runtime playback is a separate concern, deferred to v0.2.0 (see doc 06) — v0.1.0 parses without playing.

## Deterministic mapping rules to freeze
- input track index → deterministic `trackIdFor(index)`
- input note ordinal within track → deterministic `noteIdFor(trackIndex, noteIndex)`
- tick/time conversion → **beats**, never seconds
- MIDI channel 10 (index 9) → drum-track classification
- tempo map → stored as explicit tempo events in the song document, never flattened away into a single BPM

```ts
interface ImportedSongDoc {
  songId: string;
  name: string;
  tracks: Array<{
    trackId: string;
    midiChannel: number | null;
    isDrums: boolean;
    notes: NoteEvent[];
  }>;
  tempoMap: Array<{ atBeats: number; bpm: number }>;
}
```

## Playback consequence for v0.2.0
When autoplay ships, compile the imported song's beat-domain notes into the same transport/runtime schedule as hand-authored notes (doc 06). MIDI import must not create a privileged second playback path — it produces the same `NoteEvent[]` shape as manual editing, so both flow through one scheduler and one allocator.
