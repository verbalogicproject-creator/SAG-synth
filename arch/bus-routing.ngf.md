---
format: ngf/0.0.3
kind: arch_card
card_name: bus-routing
title: arch/bus-routing — what the 0..63 channel system should be, argued against FL Studio
written: 2026-08-01
written_by:
  - Eyal Nof
  - Claude (Opus 5, 1M context)
edges:
  governs: "Phase G — the modular router; supersedes the mixer half of design/PHASE-5-BRIEF.md"
  companion_cards:
    - arch/contract.ngf.md
    - arch/sag-playwright.ngf.md
  measured_against: "src/tests/mixer-cost.audio.test.ts"
---

# §0. Why this card exists before any code

Eyal asked for a per-component router: a floating panel on each component with a channel
assignment 0–63, 0 meaning neutral, plus explicit in/out on the LFO and the effects so the
graph becomes genuinely modular. He also named FL Studio as the reference, on the grounds
that seeing how a DAW that already solved this actually solved it would simplify what we
are trying to build rather than complicate it.

He was right, and the single most useful thing the research returned is a **subtraction**:
two of the things the design was drifting toward are things FL does not do.

This card records the reference model, marks which parts are documented and which are
inference, and states what SAG-synth takes and refuses. It is written before Phase G's
contract because Phase 4 proved that declaring first is cheaper — and because a routing
schema is the most expensive thing in this project to get wrong.

# §1. The reference model, as documented

FL Studio separates **what makes sound** from **what processes it**, and the separation is
the whole design:

| layer | object | role |
|---|---|---|
| Channel Rack | a channel wrapping a generator | makes sound |
| Mixer | a numbered insert track | processes and sums |
| Playlist / Patterns | clips referencing channels | triggers; **no routing role at all** |

**The link between a channel and the mixer is a single integer.** The channel's "track
number" field takes one value; you type `1` and it goes to Insert 1. Many channels → one
insert is normal and expected. One channel → several inserts is **not** expressible at
this layer — fan-out is a mixer-to-mixer concern, one level up.

**The insert track** is a bus: fader, pan, a fixed ordered list of **10 effect slots**
processed top to bottom, and routing state. Reordering is a drag, not a graph edit. Each
slot has an on/off and a wet/dry, post-fader by default; pre-fader needs an explicit send
plugin in a slot rather than a native switch. Exceeding 10 means nesting a Patcher or
chaining across inserts.

**Routing between tracks** is an arrow from any insert to any other, or to Master. Multiple
simultaneous sends from one track are allowed. Every insert reaches Master by default
unless redirected; Master is the terminal node.

**Cycles are refused structurally, at the UI.** Once A sends to B, B is greyed out as a
destination on A — the cable will not connect. Not a warning, not a runtime check: the
illegal state is unrepresentable through the interface.

**The count is dynamic now, and used not to be.** 125 fixed inserts for most of FL's
history; FL Studio 2025 introduced dynamic mixer tracks, raising the cap to **500** with
add/delete and undo. No documented rationale was found for the original 125 — treat it as
a legacy fixed-array detail rather than a designed limit.

**A send is a level on an edge**, not a different kind of object. FL has no separate
"return track" type; an insert used as an effect bus is a role, not a type.

**Per-track delay/offset** exists for aligning tracks whose plugins add latency — orange
for automatic, blue for manually overridden.

*Confidence.* The slot count, the routing model, cycle prevention, the 125 → 500 change and
Patcher's purpose are documented. Three points are **lower-confidence and flagged as such
by the research**: the cost of an empty slot, the "0% send = sidechain-only" behaviour, and
the exact latency-compensation algorithm across a multi-hop graph. None of the three is
load-bearing for anything below.

# §2. What we take

**1 · One integer per source, not a list.**
`channel: number` on an oscillator slot, an LFO, an effect. Not `channels: number[]`. Fan-out
lives on the bus graph, where it can be validated once, instead of on every source, where it
would have to be validated N times. This is FL's Channel-Rack cardinality and it is the
single biggest simplification available.

**2 · A bus is a fixed ordered slot list.**
Which is what `src/runtime/tone-runtime.ts` already builds — one chain of five, in
`EFFECT_CHAIN_ORDER`, read from core. Phase G generalises that shape per bus instead of
inventing per-slot semantics. The existing constructor comment already states the rule
Phase G must not break: *"Reconnecting nodes mid-performance produces clicks"*, which is
why the chain is fixed-shape and bypass is `wet: 0`.

**3 · Cycles refused at assignment, not at render.**
Grey out the destination that would close a loop, exactly as FL does. A Web Audio graph
with a cycle is not a validation error — it is feedback that either explodes or stalls, and
it is discovered by ear. `KIND-synth_mod_route` §6 already excluded the modulation address
space from carrying cycles; a bus graph cannot use that dodge, so the refusal has to be
real and it has to be in `validate`, not in the runtime.

**4 · A send is a level on an edge.**
One edge type — `{from, to, level}` — with a route being the same edge at unity. Two data
structures for one relationship is how a schema acquires a migration it did not need.

**5 · Dynamic count with a cap, not a fixed array.**
FL's own 125 → 500 move is a documented admission that fixed bus arrays age badly. We
should not ship a fixed 64-slot array on day one for the same reason.

# §3. What we refuse, and the refusals are the valuable half

**63 is an address space, not 63 effect racks — and now it is measured.**
`src/tests/mixer-cost.audio.test.ts` on this device: **one full chain has read 0.25×,
0.29× and 0.35× realtime across isolated runs**, and cost is linear in chains, so the
crossing into unplayable lands somewhere between **three and four simultaneous chains**.

The spread is the honest form of the result — this is a wall-clock timing on a phone and
it moves with thermal state and load, which is why the gate in that file asserts a ratio
rather than an absolute. What does not move is the shape, and the shape is what decides:
**reverb alone is roughly half a chain's cost**, and a handful of chains is the ceiling.
FL affords 500 inserts because a desktop CPU and a native DSP engine can; a phone browser
cannot, and no amount of routing elegance changes that. **Any design in which a patch can
instantiate 63 reverbs is a design that stutters.** The number is how many addresses a
source may name, not how many chains exist.

*This is the one place the reference actively misleads*, and it is worth stating plainly
because the FL model is otherwise so directly transferable that it would be easy to inherit
the cardinality along with the topology.

**A disabled effect is not a cheap effect — measured, and it changes Phase G's priority.**
`1 chain (all wet 0)` reads **0.241× against a fully-wet chain's 0.237×**: the same number
within this device's noise. `Tone/effect/Effect.ts` explains it —
`this.input.fan(this._dryWet.a, this.effectSend)` sends the input down *both* legs, and
`wet` is only the crossfade position, so a switched-off reverb still runs its comb filters
over every sample and discards the result.

The decision rule for this was written down before the number was known, and it fires:
**per-slot node skipping is mandatory performance work in Phase G, not a design nicety**,
and any cap arithmetic must price a disabled slot at the full rate.

It also indicts the present tense, not just the plan. The factory patch ships with every
effect off and still pays for a reverb, a chorus, a delay, a waveshaper and five biquads in
order to produce a dry signal — roughly a quarter of realtime, on the target device, for
nothing. That is most of one bus, spent before the player touches anything.

**The fix must not be a disconnection**, which is the trap. The chain is fixed-shape
because reconnecting nodes mid-performance clicks — Phase C exists to kill exactly those.
So the shape is: a typed effect *slot* (G2) whose absence means the node was never built,
decided when the patch is applied rather than when a toggle is flipped. That is why G2 was
already the plan; this measurement only moves it from "cleaner" to "required."

**No Patcher, and no node-graph editor, for now.**
Patcher exists in FL to solve problems the flat model genuinely cannot: multi-output
instruments, multi-band parallel chains, fan-out from one source to several destinations.
We have none of those yet. The moment we do, the *problem* will name itself; building the
editor first would be building the answer to a question nobody has asked. §4.4's jackfield
is already deferred on the same reasoning.

**No typed return-bus.** Ableton enforces bus roles with a distinct track type; FL leaves it
a convention. **Take FL's flatness deliberately**, not by default: one bus type, roles by
use. A second type would double the schema for a distinction the runtime does not need.

**Per-bus latency compensation: not yet, and not silently.**
Web Audio's native nodes are zero-latency, so there is nothing to compensate today. That
stops being true the moment a WASM/AudioWorklet effect lands (D-1's upgrade path). The
honest move is to record it here as a known future field rather than half-build it now —
and to remember that the weakest-sourced part of the FL research is exactly this.

# §4. What this means for the existing declarations

- `SongTrack.volume/pan/muted/solo` are declared and read by nobody. They are the closest
  thing in the current schema to an insert track, and Phase G should either make them that
  or delete them. A declared field nothing reads is the defect class this project keeps
  closing.
- The 12 currently-unwired `effects.*` modulation destinations are unwired **because there
  is no per-chain modulator to point at them**. Per-bus chains make them wirable for the
  first time — that is a real payoff, not a side effect.
- F65 requires a migrated patch to *sound* the same, so a v4 patch must migrate to exactly
  one bus holding the same five effects in `EFFECT_CHAIN_ORDER`.
- The channel assignment is a parameter like any other: it needs a `PARAM_SPECS` entry, a
  minted `ctl-NNN`, and it will appear in the geometry harvest and the dead-controls sweep
  automatically. That is the substrate doing its job.

# §5. The open question this card does not settle

**What is a "component" that owns a channel assignment?** Eyal's ask names oscillators,
effects, the LFO and the EQ. FL's answer is that only *generators* carry a track number and
everything else is already on a track. Ours cannot be quite that, because our oscillator
slots sum inside one voice before any bus exists — an oscillator slot is not a channel in
FL's sense, it is closer to a Layer child.

So the honest options are:

1. **The voice is the channel.** Slots stay summed; one assignment per patch. Smallest
   change, closest to FL, and it does not deliver "per-oscillator routing".
2. **The slot is the channel.** Each slot leaves the voice separately. Delivers what was
   asked for, and multiplies the per-voice node count by the slot count — which the CPU
   probe says is the expensive direction.
3. **Both, via a Layer-like grouping.** FL's own answer to this exact tension.

This is a decision, not a detail, and it belongs to Eyal. Recording it unresolved is the
point: the previous phase's worst hour went into a claim nobody had checked, written down
as though it were settled.

# §6. Sources

FL Studio online manual (mixer), Image-Line forum release notes for the 2025 dynamic-mixer
change and the historical 125-track limit, Patcher documentation and community guides, and
an Ableton return-track reference for the contrast in §3. Gathered 2026-08-01; the three
lower-confidence points are marked in §1 and none of them carries a decision here.
