---
title: "Tone.Transport lookahead and reconciling scheduled playback with a pure allocator"
topic_id: lp1
question: "How large is Tone.Transport's lookahead, and how do you reconcile ahead-of-time scheduling with an allocator that must produce identical verdicts on replay?"
tags: [tone.js, transport, lookahead, scheduling, determinism, voice-allocation]
confidence: medium
---

## Direct answer

`Tone.Transport`'s scheduling lookahead is governed by the same `context.lookAhead`/`updateInterval` mechanism used generally across Tone's Clock system, tunable via the `latencyHint` context option (`"interactive"`, `"playback"`, `"balanced"`), and is **independent of, and layered on top of**, `AudioContext`'s own rendering lookahead. [verified — Tone.js Context docs describe `lookAhead` and `updateInterval` as constructor-level settings; Transport is built on Tone's Clock, which uses this same mechanism] The exact numeric default is context-dependent rather than a fixed universal constant across all Tone versions — do not hardcode a specific millisecond value in your design without reading it directly off your instantiated `Tone.getContext().lookAhead` at runtime, since it varies by `latencyHint` and by browser. [inferred — flagged because this pack did not find one authoritative fixed number for Tone 15.1.22 specifically]

## The reconciliation problem, restated precisely

Your allocator is defined as a pure function that produces a verdict from state-at-a-given-instant. `Tone.Transport`'s lookahead means the *audio engine* wants to know what to play some milliseconds before it's actually heard, but your allocator is specified to decide "at dispatch time." The tension is real: if "dispatch time" means "when the command is journaled" and Transport wants the note scheduled ahead of the audio clock, there are two different clocks in play (command-journal time vs. Transport/audio time).

## Reconciliation approach

The standard, and only architecturally sound, answer for a system that must **replay identically** is: **call the allocator with the *target playback time* as an explicit input, at journal-write time, and schedule the resulting voice assignment against that same target time** — not "decide when the audio engine callback fires." Concretely:

1. When a command is journaled, compute (or accept) the intended playback time `t_play` (this may be "now" for live playing, or a scheduled future time for a sequenced/Transport-driven note).
2. Call the pure allocator with `t_play` and the *current voice state as of t_play* (not as of wall-clock dispatch time) as its inputs. This requires your allocator's "current state" model to be a function of time, not of "the moment the JS callback ran" — i.e., voice-state transitions (note-on/note-off/steal) need to be represented in your journal as timestamped events on a timeline, and "state at time X" needs to be a query against that timeline, not a live mutable variable.
3. Because Web Audio scheduling (via `AudioParam.setValueAtTime` and `source.start(t_play)`) is itself designed to schedule ahead of the current audio clock, the runtime layer that *executes* the allocator's verdict is naturally compatible with lookahead — it schedules the node graph changes for `t_play`, and Transport's lookahead simply determines *how far in advance* the JS-side scheduling call happens relative to `t_play`, which has no bearing on the allocator's *decision* as long as the decision was computed from the correct point-in-time state.
4. On replay, feed the journal back through the same "state at time X" query mechanism with the same `t_play` values recorded in the journal, and the allocator will reproduce the identical verdict — determinism is preserved because the allocator's inputs (declared voice state as of a given timestamp) are exactly reproduced, independent of how far ahead of real-time the *scheduling call itself* happened to run.

This effectively means: **push the "when do we actually decide" question out of the runtime and into the journal's time semantics.** The allocator should never be called with "wall clock now" implicitly baked in — it must always take an explicit time parameter, and your journal must record that time parameter per command, not just the command content. If your current v0.2 wire format already timestamps each row, this is likely already close to compatible; the risk is specifically if any part of the runtime currently calls the allocator using the JS callback's `Date.now()`-adjacent wall time rather than the audio-timeline `t_play`.

## Sources

- https://tonejs.github.io/docs/14.7.34/Context
- https://github.com/tonejs/tone.js/wiki/Transport
- https://tonejs.github.io/docs/r13/Transport
