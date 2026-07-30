# 00 — Implementation Alignment: what we built, and where it departs from this pack

**Written:** 2026-07-30
**Audience:** whoever produced docs 01–10 (Perplexity deep-research), and anyone
extending that research for v0.2.0.
**Status of the pack:** still load-bearing. This is a delta, not a retraction.

---

## Why this document exists

Docs 01–10 were commissioned before any code existed, and they did their job — the data
models, the preset/song split, the MIDI-import mapping and the effects-chain ordering all
survived contact with the implementation essentially intact. Several went in verbatim.

But the project acquired a constraint the research was never told about, and that
constraint overrode a handful of the pack's recommendations. Anyone doing follow-up
research needs to know which recommendations we did not take and why, or the next round
will re-recommend them.

**The constraint: every state change must be replayable.** SAG-synth is instrumented
against an event substrate. Every mutation is dispatched as one command, emits exactly
one journal event, and replaying that journal must reconstruct the live state
*byte-identically* — including the undo stack. This exists because v0.2.0 gives an AI
agent programmatic control of the synth as a peer client of the React UI, over the same
command surface the UI uses. The journal is that wire format.

That single requirement is behind most of what follows.

---

## 1. `Tone.PolySynth` — rejected

**Pack says** (01, decision table): *"Voice allocation | Fixed voice pool vs dynamic
PolySynth | `Tone.PolySynth` handles allocation automatically."* Doc 03 wraps MonoSynth
in PolySynth for polyphony.

**We use** a manually managed pool of `Tone.MonoSynth`, keyed by a `voiceId` that a
**pure function in the domain core** assigns (`src/core/allocate.ts`).

**Why.** "Handles allocation automatically" is precisely the problem. Allocation and
voice-stealing must produce the same verdict during live play and during journal replay,
years later, on a different machine. A library that decides internally — and hard-codes
oldest-steal — cannot be replayed. So the decision moved out of the audio layer entirely:
core decides which voice sounds and which dies, and `ToneRuntime` only executes the
verdict. Ties are broken explicitly by `voiceId` because `Array.prototype.sort` is stable
but not deterministic across equal keys on every engine.

**Credit where due:** doc 09 (line 130) already identified the escape hatch — *"manage a
manual pool of `Tone.MonoSynth` instances yourself instead of `Tone.PolySynth`"* — but
framed it as a consequence of wanting per-voice LFO phase. Our reason is stronger and
applies from the first note, not just to modulation.

## 2. `zustand` + `zundo` for undo/redo — installed, then not used

**Pack says** (10, tooling table): *"State management | `zustand` (+ `zundo` for
undo/redo)"*. Doc 08 shows a `temporal` store from zundo.

**We use** a pure reducer with a separate history driver (`src/core/history.ts`), and
`undo`/`redo` are **journaled commands** like any other verb.

**Why.** A client-side undo cursor makes live state disagree with its own history. If the
journal doesn't record the undo, replaying it rebuilds the *pre*-undo state — so the undo
would not survive a reload, and the journal would stop being the single source of truth.
Making undo a recorded verb keeps replay honest.

This forced a second split: the reducer is a pure function of **one** state and one
command, so it cannot implement undo (which needs a stack). It refuses `undo`/`redo`
outright and a driver above it owns the past/future stacks. Both libraries remain in
`package.json` and are dead weight; a future cleanup should remove them.

## 3. Note time is in **beats**, not seconds or Tone time-strings

**Pack says** (05, 08): note events carry `time: number` alongside Tone subdivision
strings (`"0:2"`, `"8n"`), following `Tone.Part`'s native mixed-time convention.

**We use** `time: Beats` and `duration: Beats`, where `Beats` is quarter notes as a plain
number.

**Why.** Seconds bind a note to the tempo it was written at. `setTempo` would have to
rewrite every note in the song, and a `tempoMap` would make note times ambiguous — which
of the two tempos applies? Beats make tempo a pure presentation concern and keep
`setTempo` a one-field edit that replays cleanly.

Tone's time strings are additionally *stringly-typed* — `"0:2"` cannot be validated by a
schema, arithmetic on it needs a parser, and it means different things under different
time signatures. Conversion to Tone's units happens at the runtime boundary and nowhere
else.

Note that `portamento` **remains in seconds**, per doc 09 — it's a glide time, not a
musical position, so it should not scale with tempo.

## 4. Layering is enforced mechanically, and differs from doc 01's diagram

**Pack says** (01): UI → App State → Sequencer/Transport → Synth Engine → Modulation →
Effects.

**We use** four layers with a strict dependency direction:

```
core/     zod only. No Tone, no React, no DOM globals, no filesystem.
runtime/  the ONLY subtree allowed to import `tone`.
app/      adapters + the dispatcher. May import idb, @tonejs/midi. Never `tone`.
clients/  React. Never `tone` — every note goes through the dispatcher.
```

**Why the difference.** Doc 01's stack is a *runtime data-flow* diagram, which is fine as
far as it goes; ours is a *dependency* graph, and the direction is what matters. Swapping
`ToneRuntime` for a `NullRuntime` makes the whole engine headless, and that swap is the
v0.2.0 agent-SDK seam. One stray `import 'tone'` in `app/` and the agent path needs a
browser.

These are not conventions. `src/tests/contract.test.ts` scans every source file for all
four import forms (static, side-effect, dynamic, `require`) and fails the build on a
violation. Every gate was verified by deliberately introducing the violation it exists to
catch and confirming it fails.

## 5. Reverb is specified with **Freeverb** parameters, not `Tone.Reverb`

**Pack says** (04): `Tone.Reverb` with a `decay` time.

**We use** `roomSize` / `dampening` / `wet` — i.e. the Freeverb parameter set.

**Why.** `Tone.Reverb` generates a *randomised noise impulse response* at construction.
That makes its output non-reproducible between runs, so it cannot appear in any
determinism gate, and there is no stable parameter for a test to assert against.
Freeverb's parameters are deterministic and directly assertable. `Tone.Reverb` may still
be used later for sound quality, but it is excluded from bit-reproducibility gates and
that exclusion needs to stay documented.

## 6. Nothing in the domain core may generate an id or read a clock

Not addressed by the pack, and it touches every doc that shows a constructor.

`crypto.randomUUID()` and `Date.now()` are **banned below the app layer**. Ids and
timestamps are injected: the command envelope takes them as parameters, `savePreset` and
`newSong` derive the new document's id from the command id, and the MIDI importer takes
`songId` / `trackIdFor(trackIndex)` / `noteIdFor(trackIndex, noteIndex)` / `createdAt`
from its caller. `initialEngineState()` is a pure constant with a frozen factory epoch.

**Why.** A parser that called `randomUUID()` would produce a different song on every run,
so a MIDI import could not be replayed. This is the single most invasive constraint in
the codebase and it should be assumed in any future code sample.

## 7. Parameter paths are a finite, compile-time union

Not addressed by the pack. `setParam` takes one of exactly **70** paths
(`voice.filter.frequency`, `voice.lfos.2.target`, …), generated from a template-literal
type, with a `Record<ParamPath, ParamSpec>` of ranges that the compiler checks for
exhaustiveness. LFOs are capped at 4 specifically to keep that union finite.

An arbitrary `string` path would let an agent (v0.2.0's whole point) dispatch a
misspelled parameter that validates fine and silently does nothing.

## 8. v0.1.0 scope was narrowed after the research

The pack scopes a full instrument. Shipping order changed on 2026-07-30:

- **v0.1.0 — live keys only.** Voice pool, full patch, effects. **No `Tone.Transport`,
  no sequencer, no MIDI autoplay.** The runtime's `applySong` and `transport.*` record
  that they were called and warn, rather than throwing or silently no-opping.
- **v0.2.0 — phased.** Sequencer/transport runtime, MIDI-import playback, the designed
  UI, and the agent SDK.

Docs 05 (sequencer) and 06 (MIDI import) are therefore **not yet consumed by the
runtime** — though 06 already drove the *import* path, which parses into the song
document without playing it.

## 9. AudioWorklet and wavetables deferred

Doc 01 suggests dropping to `AudioWorkletNode` / `PeriodicWave` for custom oscillators.
Deferred entirely (decision D5). `'custom'` remains in the `WaveShape` union so the type
doesn't have to change later, but the validator rejects it with an explicit error rather
than accepting an unplayable patch.

---

## Empirical findings the research could not have known

Measured on the actual target (Android / Termux / PRoot, headless chromium, Tone.js
15.1.22). These are the kind of thing worth folding into future research.

1. **Tone.js cannot run in bare Node** on this host — it crashes reaching for ALSA. All
   audio verification runs in headless chromium via `Tone.Offline`, which required
   `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage` under PRoot. This
   works and is stable; it is the foundation of every audio gate.

2. **Tone asserts a source's start time is strictly greater than its previous one.** Two
   events landing on the same voice at the same clock instant *throw*. This is not
   exotic — a voice-steal is issued immediately before the `noteOn` that reuses the slot,
   and under `Tone.Offline` the whole callback runs at one timestamp. Any manual voice
   pool needs a per-voice monotonic clock. We nudge collisions forward by 0.1 ms.

3. **Eight MonoSynth voices at velocity 1.0 through a −6 dB master peaked at 1.0122** —
   real clipping, since Web Audio hard-clips at ±1. Any doc recommending a voice pool
   should say something about headroom; "PolySynth handles it" does not cover gain
   staging.

4. **`Tone.Limiter(-1)` measured a *higher* peak than no limiter at all** — 3.3448 vs
   3.0972 on the same source material. This is unresolved and may be a measurement
   artifact rather than a Tone bug; it is tracked as open question Q1 and currently
   blocks committing to a master-limiter design. **A follow-up research question worth
   asking:** what is the correct way to verify `Tone.Limiter` behaviour in an offline
   render, and does its look-ahead shift the signal in a way that breaks naive
   peak comparison between two separately-rendered buffers?

5. **`Tone.MonoSynth`'s option shape is very close to a 1:1 fit** for a
   voice model of oscillator + amp envelope + filter + filter envelope. This made the
   manual pool much cheaper than expected and is a point in favour of recommending
   MonoSynth pools over PolySynth generally.

---

## What the pack got right and we kept unchanged

Worth stating, so the delta above isn't read as a verdict on the whole pack:

- **Self-contained songs** (08) — each track embeds a full `preset_snapshot` rather than
  a `preset_id` reference, so an exported song doesn't break when the referenced preset
  is edited or deleted. Adopted verbatim; it's now a falsifiable gate.
- **The 16-step grid as a projection** (05) — notes are stored as a free-time
  `NoteEvent[]` and the grid is a view over it, not a competing representation. This
  turned out to be load-bearing: it means MIDI import and step editing write into one
  structure that cannot disagree with itself.
- **Effects chain order** (04) — `distortion → chorus → delay → reverb`, adopted exactly
  and now a frozen constant.
- **Preset `.get()`/`.set()` symmetry** (07) — kept, but as a runtime-layer convenience
  only. The storage contract is the core document; presets are never scraped from audio
  node internals.
- **`@tonejs/midi` for import** (06), including the ticks-to-beats conversion and
  channel-10 drum detection. Adopted; the tempo-map handling is now gated.
- **Canonical TS data models** (09) — the shapes are close to what shipped, modulo the
  time-unit change in §3.

---

## If you are writing follow-up research for v0.2.0

Useful, in rough priority order:

1. **Q1 above** — the `Tone.Limiter` measurement question.
2. **`Tone.Transport` + a manual voice pool.** Doc 05 assumes `Tone.Part` feeding a
   PolySynth. How do `Part`/`Sequence` scheduling and lookahead interact with a pool
   where an external pure function assigns the voice for each scheduled note?
3. **Per-voice LFO phase.** Our patch spec says all voices share an LFO *configuration*
   but own independent *phase* (that's what a `retrigger` flag means). Honouring that
   literally implies up to 4 × 32 `Tone.LFO` instances. Is there a cheaper construction?
4. **Deterministic offline rendering of effects.** Which Tone effects are
   bit-reproducible across runs and which are not? We know `Tone.Reverb` is not. A
   definitive list would let us gate far more of the chain.
