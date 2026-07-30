# Three reference synths — what they are worth, and what may be taken

Pre-design-stage analysis of `/storage/emulated/0/Download/synths/`. Nothing was copied into
this repo, and the licensing section explains why that is not merely caution.

**Short answer to "do these help us go quicker":** one of them substantially, and not in the
way the question implies. The value is almost entirely in *reading* them, not extracting
from them — and the one worth reading most is the one we are least allowed to copy.

---

## Licensing, which decides the rest

| Project | Licence | Copy code? |
|---|---|---|
| `reactronica` | **MIT** | Yes, with attribution |
| `drumhaus` | **CC BY-NC-SA 4.0** | **No** |
| `javascript-software-synthesizer` (JSS-01) | **AGPL-3.0-or-later** | **No** |

**drumhaus** is Creative Commons *NonCommercial ShareAlike*. Taking code would (a) bar
SAG-synth from commercial use permanently and (b) force it under BY-NC-SA. Creative Commons
themselves advise against CC licences for software — they do not address source-vs-object
distribution or patents — so the position is also legally murkier than a software licence
would be. Read it; do not lift from it.

**JSS-01** is AGPL. Copying any of it makes SAG-synth AGPL, including the network-use
clause. That is a project-defining decision, not a dependency choice.

**reactronica** is MIT and genuinely free to use. It is also the smallest and, as below, the
one with the bug.

Reading all three for technique is unrestricted. Ideas are not copyrightable; expression is.

---

## drumhaus — the most valuable and the least usable

Nearly our exact stack: React 19, Vite 8, Vitest 4, Tone **15.5.25** against our 15.1.22.
And a layering that arrived at the same shape we did independently:

```
core/audio/canonical   ← state as truth
core/audio/bridge      ← state → audio
core/audio/engine/{context,fx,instrument,sequencer,transport,variation}
```

That is our `core/` → `runtime/` split under different names, which is worth something on
its own: two projects solving browser-synth-with-Tone converged on separating canonical
state from the audio graph.

### It answers Q2, the question blocking 0.3.0

Our open question is how `Tone.Transport`'s lookahead interacts with a pure allocator that
expects to decide at dispatch time. Drumhaus's `sequencer/precompute.ts` + `sequencer.ts`
show the working answer:

1. **Precompute the whole pattern** into `stepsByVariation: PrecomputedHit[][][]` —
   `[variation][step][hits]` — with velocities and accents already applied, *before*
   playback starts.
2. The `Tone.Sequence` callback receives `(time, step)` and does **array lookup only**. No
   computation, no allocation decisions.
3. `time` is threaded through everything downstream: `trigger(time, hit)`,
   `env.triggerAttack(time)`, `env.triggerRelease(time + hit.decaySeconds)`,
   `choke(time)`.

That is exactly what our own roadmap's Phase B proposed — "compile beat-domain note events
into stable, explicitly-ordered runtime schedules" — arrived at independently by someone
who shipped it. Convergent evidence is worth more than either plan alone.

**The adaptation we would still need:** their precompute produces *hits*; ours must produce
hits **plus the allocator's voiceId verdict**, because allocation lives in core and must
replay identically. That is the one genuinely novel part of our design and no reference has
it. The pattern still holds — precompute, then look up — the payload is just richer.

### The warning sign

`engine/tone-internals.ts` reaches into Tone's private API — `getTicksAtTime`,
`_state.cancel`, `cancelScheduledValues` on internals. Someone building a serious sequencer
on Tone ran out of public surface and went underneath it. Worth knowing before we promise
ourselves a clean 0.3.0.

### For 0.4.0 drums

A complete, tested drum machine on our stack, with sample caching, choke groups, variation
chaining and offline export. As a *reference* for what the work involves it is excellent.
As a source it is closed to us.

---

## reactronica — MIT, tiny, and demonstrates the bug

Fourteen files. `Song` → `Track` → `Instrument`/`Effect`, declarative React over Tone.

Notable convergence: it drives `Tone.Transport.bpm`, `.swing` and `.swingSubdivision` —
the exact three fields our `Song` document already declares and nothing yet consumes.

**But its sequencer callback is the failure mode our Q2 warns about**, in plain sight:

```js
new Tone.Sequence((_, step) => {
  step.notes.forEach((note) => {
    instrument.triggerAttackRelease(note.name, note.duration, undefined, note.velocity);
    //                                                        ^^^^^^^^^ the scheduled time, discarded
  });
});
```

The callback's first argument *is* the scheduled audio time, and it is named `_` and thrown
away. `undefined` means "now" — but Tone fires these callbacks **ahead** of the audio clock,
so every note lands at whatever moment the JS callback happened to run rather than where it
was scheduled. That is jitter by construction.

It also calls `onStepPlay` from inside the audio callback, which is a React state update on
the scheduling path.

So its value is inverted from what you would expect: **the MIT-licensed one is mainly useful
as the counter-example**, and drumhaus — which we cannot copy — is the one that does it
right. If we ever take reactronica code, take it knowing this.

---

## JSS-01 — AGPL, vanilla, off-stack

No React. `elements/{keyboard,panels,displays,midi,splash}` in plain TypeScript with SCSS.
Actively being refactored; its own README points elsewhere for a stable version.

Nothing here transplants: no React, AGPL, and a UI approach with none of our constraints.
Its `elements/midi` might be worth a look when MIDI input lands, as reading only.

---

## Does any of this make v0.2.0 quicker?

**Almost not at all, and that is not a criticism of them.**

The designed UI has a constraint none of these share: every control must generate from
`PARAM_SPECS` and dispatch a command, because the range belongs to the validator and the
journal has to record the change. All three hard-code their values, as any normal synth UI
does. Their components cannot transplant without becoming exactly what
`arch/clients.ngf.md` forbids — and we already have a design for v0.2.0.

Where they help is **later, and by being read**:

| Goal | Help | From |
|---|---|---|
| 0.3.0 sequencer | **High.** Precompute-then-lookup, and `time` threaded everywhere. Answers Q2 in practice. | drumhaus (read only) |
| 0.3.0 transport | Confirms `bpm`/`swing`/`swingSubdivision` are the right transport surface. | reactronica (MIT) |
| 0.4.0 drums | A full worked example on our stack — scope, not source. | drumhaus (read only) |
| v0.2.0 UI | Negligible. | — |

## Recommendation

1. **Copy nothing.** The one worth copying is licensed against it; the one licensed for it
   has a timing bug at its centre.
2. **Record the Q2 answer now, while it is in view** — precompute a schedule carrying the
   allocator's verdict, then let the audio callback do lookup and `trigger(time, …)` and
   nothing else. That closes the question the roadmap flags as blocking 0.3.0, on
   independent evidence rather than reasoning alone.
3. **Keep drumhaus reachable** when 0.4.0 drums start, as a scope reference. Note that
   `/storage/emulated/0/Download/synths/` is a downloads folder and will be cleared; if it
   matters later, clone from source rather than relying on it.
4. **Do not let this delay the design cycle.** It has no bearing on v0.2.0.
