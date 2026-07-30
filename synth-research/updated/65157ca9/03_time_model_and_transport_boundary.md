# 03 — Time Model: Beats in Core, Tone Units at the Runtime Boundary

## Aligned rule
Store musical note positions and durations as **beats** (quarter notes, plain number) in the domain model. Convert to seconds / Tone time values only at the runtime boundary, and nowhere else.

```ts
export type Beats = number; // quarter notes as a plain number, branded in practice

export interface NoteEvent {
  noteId: string;
  pitch: number;
  time: Beats;
  duration: Beats;
  velocity: number;
}
```

## Why this changed from the original pack
The original pack showed note events carrying `time: number` alongside Tone subdivision strings (`"0:2"`, `"8n"`), following `Tone.Part`'s native mixed-time convention. That binds a note to the tempo it was written at — `setTempo` would have to rewrite every note in the song, and a tempo map would make note times ambiguous (which of two tempos applies at a boundary?). Beats make tempo a pure presentation concern and keep `setTempo` a one-field edit that replays cleanly.

Tone's time strings are additionally stringly-typed: `"0:2"` cannot be validated by a schema, arithmetic on it needs a parser, and it means different things under different time signatures. Conversion to Tone's units happens at the runtime boundary and nowhere else in the codebase.

## Exception: portamento stays in seconds
`portamento` (glide time) remains in seconds, not beats — it's a glide duration, not a musical position, so it should not scale with tempo. This is a deliberate asymmetry, not an oversight.

## Conversion boundary
```ts
function beatsToSeconds(beats: number, bpm: number): number {
  return (60 / bpm) * beats;
}

function runtimeNote(event: NoteEvent, bpm: number) {
  return {
    atSec: beatsToSeconds(event.time, bpm),
    durSec: beatsToSeconds(event.duration, bpm),
  };
}
```

## Consequence for the sequencer (v0.2.0)
Keep song notes in core as `NoteEvent[]` in beats. On playback, compile a runtime schedule either as:
- **precompiled schedule** — convert all events to absolute seconds for the current transport segment (simpler), or
- **tick/step cursor** — advance a beat cursor and dispatch notes live from the core schedule (necessary if tempo changes or live edits during playback must remain journal-visible).
