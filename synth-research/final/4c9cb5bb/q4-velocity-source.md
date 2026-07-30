---
title: "Constructing a per-note scalar (velocity) modulation source in Web Audio for a shared routing model"
topic_id: q4
question: "What is the correct Web Audio construction for velocity as a modulation source, and how does it interact with voice stealing/reuse?"
tags: [web-audio, tone.js, velocity, constantsourcenode, voice-stealing, modulation-source]
confidence: high
---

## Direct answer

A **per-voice `ConstantSourceNode`** (native Web Audio) — or its Tone.js equivalent, a per-voice `Tone.Signal` — whose `.offset` (or `.value`) is set with `setValueAtTime` at the exact note-on time is the correct and idiomatic construction. This gives you a real audio-rate node output that can be connected into your existing `ModRoute` → `Tone.Gain` depth-scaling pattern exactly like an LFO output, with no special-casing needed in the routing/summing code downstream. [verified — ConstantSourceNode is explicitly documented by MDN as usable "like a constructible AudioParam," and is the standard technique for feeding a fixed value into things that expect a live audio-rate signal]

## Why this is the right node

- `ConstantSourceNode.offset` is itself an `AudioParam`, and the node's **output equals `offset`'s value at every sample** — it is literally designed for "I have a scalar I want to treat as an audio-rate signal" use cases. [verified — MDN: "The output's value is always the same as the value of the offset parameter"]
- Because it's a real node with an output, it connects directly into the same `Tone.Gain`-per-route depth-scaling stage your LFO routes already use, so **velocity requires zero special-casing in the mixing/summing graph** — it looks exactly like a (non-oscillating) LFO to everything downstream of the source. [inferred, direct consequence of the verified node behaviour, and consistent with your ModRoute source union already listing `velocity` alongside `lfo.0..3` as siblings]
- A documented pattern (Josh Reiss's Web Audio API book/course materials) explicitly demonstrates using one `ConstantSourceNode`'s `.offset` fed into multiple gain/parameter destinations simultaneously as a shared scalar control — directly analogous to broadcasting one note's velocity to several modulation destinations at once. [reported — "Constant sources in the Web Audio API" video, part of Reiss's Web Audio API book companion series]

## Setting the value atomically at note-on

Use `constantSource.offset.setValueAtTime(velocityValue, noteOnTime)` — **not** `.value =` assignment — because `AudioParam` scheduling methods take precedence over direct property assignment and guarantee sample-accurate timing relative to your other scheduled events (this matches your existing 0.1ms-nudge discipline for simultaneous starts on one voice). [verified — MDN Web Audio best practices: "if you're using any of the AudioParam's defined methods... they will take precedence over... property setting... if your website... requires timing and scheduling, it's best to stick with the AudioParam methods"]

## Interaction with voice stealing/reuse

This is the part that needs explicit handling, and your framing of the risk ("the value must change atomically with the new note") is correct:

1. **Do not `dispose()`/recreate the `ConstantSourceNode` per note.** `ConstantSourceNode` (like `OscillatorNode`) is a `AudioScheduledSourceNode` and per spec **can only be started once** — calling `.start()` twice throws. If you're pooling voices (as your MonoSynth pool already does), the velocity `ConstantSourceNode` should be started **once** at voice-pool construction time (like your LFOs) and then have its `offset` **re-scheduled** on every note-on/steal, exactly like re-triggering an envelope on a reused voice. [verified — AudioScheduledSourceNode.start() spec: "InvalidStateError... if start has already been called"]
2. On a steal, call `offset.cancelScheduledValues(stealTime)` followed by `offset.setValueAtTime(newVelocity, stealTime)` to guarantee the old note's velocity value cannot leak into the new note's attack — this is the same discipline you already apply to avoid the "start time must be strictly greater than previous" assertion failures, just applied to a `AudioParam` rather than a source start time.
3. Because this write is scheduled at the *same instant* as the new note's envelope trigger and oscillator retune, and both go through your existing per-voice 0.1ms nudge discipline for ordering, no additional synchronization primitive is needed — the atomicity requirement is satisfied by scheduling both at the identical (nudged) timestamp within the same command-processing tick, which your journal-per-command model already guarantees are applied together.

## Sources

- https://developer.mozilla.org/en-US/docs/Web/API/ConstantSourceNode
- https://www.youtube.com/watch?v=SvVNCQTZzws
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices
- https://www.w3.org/TR/webaudio-1.1/
