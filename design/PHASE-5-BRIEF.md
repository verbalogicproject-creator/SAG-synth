# Phase 5 — the mixer

**Status: proposal. Nothing here is settled and no code follows from it yet.**

Asked for on 2026-07-31, after playing v0.2.0 on the device: *"I want the correct
approach like the DAW FL Studio. Buses, modular, chains, control, customizability."*
Plus per-channel and master mono/stereo, and presets that compose.

The framing that got corrected first, and it matters: this is not buses **or** chains.
FL has both. Every insert track carries its own ordered chain of effect slots, *and*
routes to other tracks and to master. Offering a choice between the two was a smaller
question than the one being asked.

---

## What actually changes

Today the graph is fixed:

```
osc A ┐
osc B ┼─> filter ─> amp ─> [dist → chorus → delay → verb → eq] ─> master
osc C ┘                     one chain, one of each effect
```

What is being asked for:

```
osc A ─> track 1 ─┐   each track: volume, pan, mono/stereo,
osc B ─> track 2 ─┼──> an ORDERED list of effect slots,
osc C ─> track 3 ─┘    and an output pointing at another track or master
                          │
                    track 4 (a bus: nothing feeds it directly,
                             other tracks route into it)
                          │
                       master
```

### The contract change is bigger than the mixer

**Effects stop being singletons.** `effects.distortion.wet` is one address for one
distortion that always exists. In FL you can put three reverbs on three tracks, or none.
So effects become a slotted list with ids and types — exactly the shape `oscillators`,
`lfos` and `modRoutes` already took at schema_version 3, and for the same reason.

That is the largest change this repo's contract has had. It rewrites the address space
rather than extending it:

| | now | after |
|---|---|---|
| effect addresses | 18 fixed | `tracks.N.slots.M.<param>` — variable |
| modulation destinations | 31 | depends on the cap; 60–100 |
| `MODULATION_DESTINATIONS` | a literal table | generated over slot indices |
| `KIND-synth_patch` | one document = one instrument | tracks, slots, and a routing graph |
| schema_version | 4 | 5 |

**And presets compose.** *"A set of 2 or 3 oscillators saved as one preset"* means a
patch document can contain, or reference, other patch documents. That is a nested model
and it is a separate question from the mixer — arguably the harder one, because F63
(`decode(encode(p))` deep-equals) and F65 (a migrated patch **sounds** the same) both
have to keep holding across nesting.

---

## Open questions, to settle before 5.0 declares anything

1. **Effect instances: typed union or slot family?** `oscillators` is a homogeneous slot
   family — every slot has the same nine keys. Effect slots are not: a reverb and a delay
   have different parameters. Either the slot carries a discriminated union (`type` +
   type-specific params) or every slot carries every effect's parameters and ignores most.
   The first is honest and makes `ParamPath` harder to keep as a finite compile-time
   union; the second is a wall of decoys by construction. **Leaning: discriminated union,
   and accept that `ParamPath` generation gets more work.**

2. **How many tracks, and how many slots each?** Every cap becomes part of the address
   space, so this is a contract decision, not a preference. Three oscillators today.
   FL ships 125 inserts; a phone will not.

3. **Is the routing graph acyclic by construction or by validation?** Track A → track B →
   track A is a feedback loop that will produce either silence or a very loud noise.
   `KIND-synth_mod_route` §6 already refused cyclic modulation for the same reason and
   solved it by excluding the address; a track graph cannot use that trick.

4. **Mono/stereo — where does it sit in the chain?** Before the track's slots, or after?
   The answer changes what a stereo widener on a mono-collapsed track means. Note the
   0.1.16 lesson: `Tone.Panner` silently down-mixes to mono, and that shipped as a decoy
   through 86 audio gates.

5. **Migration.** A v4 patch has one shared chain. Does it migrate to one track holding
   the same five effects, or to three tracks each with a copy? F65 says the migrated patch
   must **sound** the same, which forces the first answer and should be stated.

---

## CPU is a contract input here — measured, 2026-07-31

`src/tests/mixer-cost.audio.test.ts`, run on the device under PRoot. `Tone.Offline`
renders as fast as it can, so these are **wall-time / audio-time ratios, not live CPU**.
They are a sound relative measure and a hard upper bound: a configuration that cannot
beat 1.0x offline has no chance live, where it also shares a thread with the UI and must
leave scheduling headroom.

```
dry (no effects)         34 ms   0.017x realtime
distortion only          26 ms   0.013x realtime
chorus only             145 ms   0.072x realtime
delay only               43 ms   0.022x realtime
freeverb only           375 ms   0.187x realtime
eq only (5 bands)        91 ms   0.046x realtime
1 full chain            495 ms   0.247x realtime
2 full chains           997 ms   0.499x realtime
3 full chains          1473 ms   0.736x realtime
4 full chains          1929 ms   0.964x realtime
6 full chains          3097 ms   1.548x realtime
8 full chains          4354 ms   2.177x realtime
```

### What the numbers say

**Reverb is the whole problem.** Net of the dry baseline, one full chain costs 0.230x and
`Freeverb` alone accounts for 0.170x of it — **74% of a chain's cost is one node.** Chorus
is 0.055x, EQ 0.029x, delay 0.005x, and distortion is inside the noise floor (it measured
*below* dry). A chain with everything except reverb costs about 0.060x — **roughly a
quarter the price.**

**Scaling is flat.** ~0.24x per additional chain, no economies. Four full chains render at
0.964x offline: that is already unplayable live, and it is only four.

### Three things this decides

1. **The slot model is not a nicety, it is the affordability argument.** Replicating
   today's fixed chain per track costs 0.23x each and dies at three tracks. A model where
   a track builds only the slots it declares makes a reverb-less track nearly free. This
   settles question 1 in favour of the discriminated union — a homogeneous slot carrying
   every effect's parameters could still build lazily, but only a typed slot lets a patch
   *say* "this track has no reverb," and the saying is what the runtime needs.

2. **Buses are load-bearing, not a feature.** One shared reverb bus that four tracks send
   to costs 0.170x once instead of 0.680x four times. FL's send architecture exists for
   exactly this reason, and the measurement reproduces it. Any cap in question 2 should be
   generous on tracks and slots and stingy on *reverb instances specifically*.

3. **`Tone.Freeverb` deserves a second look.** It is a JS-implemented comb/allpass network;
   `Tone.Reverb` is a native `ConvolverNode`. Freeverb was chosen at 0.1.x precisely
   because `Tone.Reverb`'s randomised impulse response cannot be gated deterministically —
   a good reason that now carries a measured price. Worth re-opening as: can a *fixed*
   impulse be generated once and fed to a convolver, keeping the gate and the native speed?
   **Not a Phase 5 blocker. Logged, not decided.**

### The cap this suggests

Not final — 5.0 decides it — but the measurement points at roughly **4–6 tracks, ~4 slots
each, with reverb only affordable on one or two shared buses.** The honest framing is that
the cap is not "how many tracks" but "how many reverbs," and the contract should make that
visible rather than let a patch discover it by stuttering.

---

## Order

Same shape as Phase 4, and for the same reason — the contract moves before any code.

| | | |
|---|---|---|
| **5.0** | CPU probe → answer the five questions → `KIND-synth_patch` rewrite, `KIND-synth_mixer_track` declared, tag, schema 5, migration | no UI, no runtime |
| **5.1** | Runtime graph rebuild: tracks, slots, routing, mono/stereo | the largest single piece of runtime work in the project |
| **5.2** | The mixer surface | `NAV_TABS` gains a tab or the bay gains a sibling |
| **5.3** | Composable preset library | the nested-document question, F63 and F65 held |

## What lands before any of it

Small, decided, and independent of everything above:

- **Master mono/stereo toggle** — one node, no contract change.
- **The XY pad** — already roadmapped as *"the cheapest thing here by a wide margin"*.
  X is continuous pitch via `noteOn` + `oscillators.N.detune`; Y drives one wired
  destination through `setParam`. No new command.

Both fit inside v0.2.x and neither is blocked by the mixer.
