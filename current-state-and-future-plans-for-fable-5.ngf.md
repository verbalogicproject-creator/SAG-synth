---
format: ngf/0.0.3
kind: arch_card
card_name: state-and-plans-for-fable-5
title: SAG-synth — current state, environment and forward plan, condensed for a cold reader
written: 2026-08-01
written_by:
  - Eyal Nof
  - Claude (Opus 5, 1M context)
edges:
  governs: "the whole repository — this is a briefing, not a boundary"
  companion_cards:
    - arch/contract.ngf.md        # what a UI pass may never touch
    - arch/clients.ngf.md         # how far a design pass may go
    - arch/sag-playwright.ngf.md  # the geometry harness and what it proved
  plan_of_record: "~/.claude/plans/happy-discovering-treasure.md — phases C through H"
  substrate: "sag-declarum-atlas-framework tag v0.0.10"
---

# §0. Who this is for and what is wanted

Written for a **cold reader with no conversation history** — `/plan-solo` forks into an
isolated context, so this document is not a summary of a discussion, it *is* the entire
context. Anything not written here does not exist for the reader.

**What is wanted back:** an enhancement / optimisation / upgrade plan. Specifically where this
codebase is leaving performance, sound quality or developer leverage on the table, given the
environment in §1 — which is unusual and rules out a lot of standard advice.

**What is not wanted:** a re-litigation of the stack choice (§5 records it and why), or advice
that assumes a desktop workstation, a CI server, or an x86 container.

---

# §1. Environment — read this before advising anything

```yaml
os:            Ubuntu 26.04 LTS ("Resolute Raccoon")
running_under: PRoot-Distro inside Termux, on Android
kernel:        6.17.0-PRoot-Distro
arch:          aarch64
cpu_cores:     8
memory:        14 GiB total, ~7 GiB available
node:          v24.18.0
npm:           11.16.0
```

**The phone is both the development machine and the target device.** There is no separate build
box, no CI runner, and no x86 anywhere. Every test, every build and every audio render happens
on the same hardware the instrument is played on. That is deliberate — it is why the CPU numbers
in §4 are trustworthy — and it means:

- Chromium is an **ARM64 Playwright** build, launched with `--no-sandbox --disable-setuid-sandbox
  --disable-dev-shm-usage` because PRoot cannot use the chromium sandbox.
- **`@types/node` is forbidden by contract**, so `src/core/**` stays environment-free. Node-only
  code lives in plain `.mjs` files outside `tsconfig.json`'s `include` (`scripts/*.mjs`).
- Anything requiring a native toolchain (C++, Rust, Emscripten) has a real setup cost here that
  it would not have on a workstation. Say so if you propose it.

---

# §2. What the project is

A browser synthesiser whose real purpose is to become an **AI-assisted music-production
framework for background music in games, apps and video** — the immediate downstream consumer
being `sag-video` (a separate monorepo at `~/openai/sag-video` in Termux home).

The framing that governs design decisions, in the author's words: it is an **AI-integrated
instrument designed to maximise the player's potential, not a machine for making AI music.** So
automation exists to stop spending the player's attention on whether a knob is wired, leaving
all of it for whether the sound is right.

It is also the first typed implementation of a "Universal I/O" architecture: the instrument and
the architecture diagram are meant to be one artifact. Every control is declared, addressable,
journalled and replayable.

---

# §3. Architecture, in one pass

**Layering, enforced by a test (`src/tests/contract.test.ts`):**

```
src/core/     zod only. No tone, no react, no DOM, no clock, no id generation.
src/runtime/  the only place `tone` is imported. Behind RuntimeAdapter/RuntimeReadout.
src/app/      adapters — dispatcher, persistence, midi import.
src/clients/  react. Two surfaces: the instrument, and a debug wall at #debug.
```

**Control dataflow — `dispatcher.dispatch(command, source)` is the only way anything changes:**

```
UI / agent / MIDI  →  validateCommand (zod)  →  reduce()  →  journal  →  syncRuntime
                                                                       ↳ applyPatch / applySong / transport
```

**Audio signal path, per voice then shared:**

```
slots×3 (osc → level → panner) → filter → ampEnvelope → gain → panner → fxInput
filterEnvelope ───────────────────────────────────────────────────────→ filter.frequency

fxInput → [distortionDry ∥ distortionShaper → distortionWet] → distortionOut
        → chorus → delay → reverb(Freeverb) → eq×5
        → master(Volume) → limiter → safetyClip → destination
                                          safetyClip ⇢ analyser, ⇢ meter
```

**Modulation is an overlay, not a stage.** `LFO(unit) → Gain(scale)` fans out to every voice's
target param; velocity is per-voice (`velocity → Gain(scale×2)`), because each voice holds a
different value. **13 of 31 declared destinations are wired**; the other 18 are drawn dim and
labelled "not wired" rather than hidden — the honesty rule below.

**Numbers:** 119 declared parameter addresses, all reaching audio. 39 command verbs, frozen and
gated. Preset schema v4, song schema v1. Framework KINDs at tag `v0.0.10`.

---

# §4. Measured facts — not estimates

All measured on the device described in §1.

**Effect chain cost** (`src/tests/mixer-cost.audio.test.ts`, wall-time / audio-time via
`Tone.Offline`; not live CPU, but a hard upper bound):

```
dry (no effects)         0.017x realtime
distortion only          0.013x        chorus only    0.072x
delay only               0.022x        freeverb only  0.187x
eq only (5 bands)        0.046x
1 full chain             0.247x        2 chains       0.499x
3 full chains            0.736x        4 chains       0.964x
6 full chains            1.548x        8 chains       2.177x
```

**Reverb is 74% of a chain's cost.** Net of the dry baseline a chain costs 0.230x and Freeverb
alone is 0.170x of it. Scaling is flat — ~0.24x per chain, no economies. **Four fixed chains
already render at 0.964x offline, which is unplayable live.**

**Surface geometry** (`npm run geometry`, real chromium at 412×915 on the device): 46 of 119
controls drawn on the factory patch, 0 below the 44 px touch minimum, 0 zero-sized, 0
off-screen. The 73 undrawn are fully accounted for: 3 behind the gear, 18 for oscillator slots
B/C the factory patch does not create, 32 in the routing bay, 20 for LFO slots that do not exist
until added.

**Test suite:** 491 tests across 34 files, three vitest projects — `core` (node), `audio`
(chromium, real Web Audio, `Tone.Offline` renders), `dom` (chromium, DOM without audio). Full
run ≈ 80 s on device.

---

# §5. Decisions already settled — please do not re-open without new evidence

**D-1 · The stack stays Web Audio + Tone.js 15.1.22.** Researched 2026-08-01. Python is out —
there is no browser runtime for real-time Python audio and the target is a phone browser. In the
browser Web Audio is the only option. Tone.js is maintained, TypeScript-native, and already
exposes AudioWorklet. The 2026 consensus is hybrid — WASM in an AudioWorklet for heavy DSP, JS
for glue — not replacement.

This is cheap rather than a bet: `src/runtime/tone-runtime.ts` is the **only** file importing
Tone, behind `RuntimeAdapter`/`RuntimeReadout`. Core, the 119 addresses, the journal and replay
are stack-independent, so a runtime swap is a single-file replacement and the question can be
re-asked at any time at the same low cost. **The upgrade path, when measurement demands it and
not before, is a Faust or Rust WASM AudioWorklet for specific DSP — reverb first.** Note WASM
runs up to ~66% slower than native, and Tone's own wiki names `ConvolverNode` the most expensive
node in the API, so that buys tunability, not free reverb. *(§1 applies: a native toolchain has
real setup cost here.)*

**D-2 · A planned 0–63 channel system is a bus ADDRESS SPACE, not 63 effect racks.** Forced by
the 0.964x measurement above. Many sources → few shared chains, which is what FL Studio actually
does. Any design letting a patch instantiate 63 reverbs is a design that stutters.

**D-3 · Honesty over completeness.** The project's signature bug, shipped seven times, is *a
control that appears to work*: a velocity keyboard sending a hardcoded 0.8; an EQ toggle refused
at validation; a distortion `amount` moving level instead of timbre; a `pan` into an
already-mono node; a `sync` flag nothing read; twenty LFO controls addressing slots the factory
patch does not create; a `+ route` button refused on every press. Two gates now close the class:
`dead-controls.browser.test.ts` proves every drawn address accepts a write **and** every drawn
button's command is accepted; `npm run geometry` proves every control is on screen at a usable
size. **Every gate in this repo is proven to fail before it is trusted.**

---

# §6. Known defects, diagnosed but unfixed

**The crackle — the live one.** Changing a parameter while a note sounds produces audible
crackle on the device. Diagnosis, from reading Tone's source:

1. `tone-runtime.ts` has **22 hot-path `.value =` writes and one ramp** in the whole file. A
   `.value` write is a discontinuous step — the classic zipper.
2. Worse: **there is no diffing.** `syncRuntime` compares whole documents and `setParam` returns
   a new patch for any change, so **one pointer move rewrites every parameter of every live
   voice, all effects and all LFOs**. Knobs dispatch per `pointermove`, unthrottled.
3. Worst: **`rewireRoutes` disposes and rebuilds the entire modulation graph on every
   `setParam`** — `lfo.disconnect()`, `scaler.dispose()`, then reconstruct and reconnect. The
   constructor's own comment says *"Reconnecting nodes mid-performance produces clicks"* as the
   reason the effects chain is never rewired. There is a second caller at `voiceFor` that does
   the same for every new voice, under notes already sounding.
4. Some writes reconstruct nodes outright: `Freeverb.dampening` builds **8 new IIR filters** per
   write; `Filter.rolloff` reconstructs N biquads **per live voice**.

Two traps found in Tone's source that any fix must encode: `Tone.Filter.gain` (EQ bands) and
`Tone.Limiter.threshold` are `convert: false` decibel params, so `rampTo` picks an *exponential*
ramp over raw signed dB — 0 dB becomes 1e-7 and crossing zero yields `NaN` / hold-then-jump. And
`filter.frequency` / `osc.frequency` are `overridden` by connected signals, so writes there are
already dead.

Also established: **`lookAhead` is already `0.1`**, so every write already lands 100 ms ahead —
`latencyHint` is not the fix. And **an offline render cannot see graph churn at all**
(`OfflineContext.render()` runs the whole clock before the first sample, so connect/disconnect
collapse onto time zero), which means churn must be gated by counting calls, not by measuring
audio.

**Other open items:** `arch/design-system.ngf.md` is referenced by two cards and does not exist; `tone-runtime.ts`'s
header still says `MonoSynth` and "97 parameter addresses" (it is slots×3 and 119); `ROADMAP.md`
says 376 tests and v0.1.17 (it is 491, and 13 commits have landed since).

---

# §7. What is built but unused — the cheap wins

Worth knowing before proposing anything new, because several "features" are already engine-complete:

- **`IdbPersistence`** — full `PersistencePort`, fully tested against real IndexedDB, and
  **never once constructed by any UI**. `src/clients/engine.ts` passes only a journal.
- **The entire sequencer data model** — `NoteEvent`, `SongTrack`, `Song`, `TempoEvent`,
  `LoopRegion`, `stepToBeats`/`beatsToStep`, and every command (`setStep`, `addNote`,
  `setTempo`, `play`, `setLoop`, `setTrackParam`, …). Validated, reduced, journalled,
  replay-proven. `setStep` already materialises a `NoteEvent`; the 16-step grid is declared a
  *projection*, never a rival store.
- **MIDI import** — produces real `NoteEvent`s with injected ids, determinism-tested. No UI
  dispatches it.
- **What is genuinely missing for a sequencer is one thing:** the runtime does not drive
  `Tone.Transport` at all. All four `TransportControl` methods and `applySong.transport` are
  `notImplemented`. `getPlayhead()` returns 0.
- **Stitch design screens already exist** for step-sequencer, piano-roll, song-mode, arpeggiator,
  drum-machine.
- **Dev-only agent seams:** `POST /__sag/command` plays the instrument from a terminal (the
  command schema *is* the wire protocol — no separate API), `POST /__sag/observe` logs what the
  master bus did, and `npm run geometry` joins `getBoundingClientRect()` to control identity.
  All three are Vite plugins marked `apply: 'serve'`, so they exist in dev and nowhere else.

---

# §8. The forward plan, condensed

Full version: `~/.claude/plans/happy-discovering-treasure.md`.

| Phase | What | Note |
|---|---|---|
| **C** | Clean audio — kill the crackle | Order is **gate → diff → ramp**, and that is load-bearing: ramping first adds 22 `cancelAndHoldAtTime` timeline walks per pointer move, which is *more* main-thread work than the steps it replaces |
| **D** | Persistence — a patch survives a reload | `importPreset` as a journalled 39th verb; storage mirrors state, never the reverse |
| **E** | Master mono/stereo, stereo meter, design-system card, **tag v0.2.0** | mono/stereo is a contract change, not "one node" |
| **F** | `architecture-router-wiring-system-atlas.ngf.mmd` | would be the **first non-`.md` NGF node in existence**; the kernel sanctions `.mmd` but never says how frontmatter is carried for it |
| **G** | The modular router — per-component channel assignment, FX as slotted instances, in/out per component | largest contract change in the project; see D-2 |
| **H** | Transport, step sequencer, timeline | data model done; needs a Transport driver and UI |

---

# §9. Where a cold reader should look first

```
src/runtime/tone-runtime.ts    the audio graph, and every defect in §6
src/core/types.ts              119 addresses, 31 mod destinations, all the caps
src/core/reduce.ts             39 verbs; the only thing that changes state
src/app/dispatcher.ts          validate → reduce → journal → runtime
src/core/controls.ts           the control registry, ctl-000..ctl-118
arch/contract.ngf.md           what a UI pass may never touch — read before editing core
design/REFINEMENTS.md          ten open items with evidence and status
ROADMAP.md                     prose history (stale on counts; see §6)
```

Verification, in this order — a red `--project audio` stops everything:

```bash
npx tsc --noEmit                        # silent
npx vitest run                          # 491 passing
npx vitest run --project audio          # if this fails, STOP
npm run build
npm run dev && npm run geometry         # must exit 0
```
