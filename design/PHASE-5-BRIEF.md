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

## CPU is a contract input here, not an afterthought

Three Freeverbs, three chorus lines and fifteen EQ bands is the naive reading of
"per-channel chains", and this instrument is built on and for a phone. FL's model is
desktop. The slot model helps — a track with no reverb slot builds no reverb — but the
cap chosen in question 2 sets the worst case, and the worst case is what a patch can ask
for.

**A CPU probe belongs before 5.0, not after 5.1.** Render N parallel effect chains
offline and measure; the number decides the caps. Writing the KIND first and discovering
the phone cannot play it is the expensive order.

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
