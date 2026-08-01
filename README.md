# SAG-synth

A browser synthesiser built as an **AI-integrated instrument designed to maximise the
player's potential — not a machine for making AI music.** Every control it draws is
declared, addressable and observable, so an assistive layer can reason about the instrument
instead of guessing at it; the point of automating correctness is to stop spending the
player's attention on whether a knob is wired, so all of it goes to whether the sound is
right.

It is also a working synth. Subtractive, polyphonic, three oscillator slots per voice, two
envelopes, a modulation router, a five-effect chain and a five-band EQ — playable from a
phone.

```
npm install
npm run dev
```

---

## What is actually here

**A complete engine.** 119 declared parameter addresses, every one of which reaches the
audio graph — `UNMAPPED_PARAMS` is empty and three tests keep it that way. Commands are
validated, reduced, journalled and replayable; undo and redo swap whole states, so the
audio graph re-syncs without knowing history exists.

**The signal path, per voice:**

```
slots x N (osc -> level -> pan) -> filter -> ampEnv -> gain -> panner -> fxInput
filterEnvelope ------------------------------> filter.frequency
cutoff base + velocity, in cents ------------> filter.detune   (routes sum here too)

fxInput -> distortion -> chorus -> delay -> reverb -> eq x5
        -> master -> limiter -> safety clip -> destination
```

The chain is fixed-shape and never rewired: a disabled effect is `wet: 0`, not a
disconnection, because reconnecting nodes mid-performance clicks and a graph whose shape
depends on parameter values is a graph whose behaviour depends on arrival order — which is
exactly what replay must not have.

**Changes are diffed and ramped.** The dispatcher pushes a patch on every `pointermove`, so
`applyPatch` writes only the sections whose documents actually changed — reference
comparison, which is exact because core documents are immutable and structurally shared —
and every audio-rate value arrives through a 20 ms ramp rather than a step. A new voice
joins the running modulation graph instead of forcing it to be rebuilt, and the client
coalesces a drag to one dispatch per animation frame. All of that exists because turning a
knob under a held note used to crack.

**Modulation** is LFO and velocity sources scaled onto destinations, with the scaling on the
*connection* rather than the generator, so one LFO can drive a cutoff and a pan at different
depths. Depth is signed: magnitude scales against the destination's declared curve, sign
inverts direction.

**What is not here yet:** song playback. Tracks, tempo and the step grid are declared,
validated and replay-proven in `src/core/`, but nothing drives `Tone.Transport`. MIDI import
produces real note events and has no UI. See the roadmap.

## Running it

| | |
|---|---|
| `npm run dev` | the instrument |
| `npm run build` | typecheck + production build |
| `npm test` | all three vitest projects |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run geometry` | measures the real page in chromium; exits non-zero on any control below the touch minimum (needs `npm run dev` running) |
| `npm run observe` / `npm run command` | drive and inspect a running instrument through the dev-only SAG seams |

Tests run in three projects: `core` under node, and `audio` (`*.audio.test.ts`) and `dom`
(`*.browser.test.ts`) in real headless chromium — real layout, real
`getBoundingClientRect`, real Web Audio.

## Layout

```
src/core/       pure domain — zod only. No tone, no react, no DOM, no clock, no id minting.
src/runtime/    the ONLY place `tone` may be imported.
src/app/        engine, dispatcher, journal, persistence.
src/clients/    React surface.
src/test-harness/  offline rendering and audio assertions.
arch/           architecture cards (`*.ngf.md`) — the reasoning, not the API docs.
```

The layer rule is enforced by a test, not by convention. Swapping `ToneRuntime` for
`NullRuntime` is what makes the engine headless, and one stray `import 'tone'` upstream
would mean the headless path needs a browser.

## How this codebase is written

Three habits explain most of what looks unusual:

**Comments say why, and are expected to be true.** A comment asserting something the code
does not do is treated as a defect of the same class as a broken control — it has caused
real ones here, and when it happens the correction is recorded in place with its date and
its reason rather than quietly edited away.

**Every gate is proven to fail before it is trusted.** A test that has never been observed
red is not evidence. Commit messages record which mutation was applied and which assertions
died, because a green suite is only as good as its ability to go red.

**The recurring defect class is a control that appears to work** — one that validates,
journals, replays and changes no sound. Seven have shipped. `src/tests/dead-controls.browser.test.ts`
exists to make the eighth impossible: it draws every declared address, writes to each, and
presses every button, with vacuity guards so it cannot silently end up testing nothing.

## Environment

Developed and targeted on the same device: Ubuntu under PRoot on Android, `aarch64`,
Node 24, 8 cores. Playwright's chromium is the ARM64 build. The phone is both the
development machine and the target, which is why the CPU probe
(`src/tests/mixer-cost.audio.test.ts`) is a real constraint rather than a curiosity —
one full effects chain renders at roughly a third of realtime here, and cost is linear in
chains, so three or four simultaneous chains is the ceiling.

That probe also measured the thing nobody had: **a chain with every effect disabled costs
what an engaged one costs.** Tone fans an effect's input down both the dry and wet legs and
`wet` is only the crossfade position, so a switched-off reverb still runs its comb filters
and discards the result. The factory patch therefore spends about a quarter of realtime
producing a dry signal. Fixing it needs typed effect slots whose absence means the node was
never built — see `arch/bus-routing.ngf.md`.

## Documents

| | |
|---|---|
| `ROADMAP.md` | the engine reference and phase history |
| `arch/contract.ngf.md` | the command/document contract |
| `arch/clients.ngf.md` | the control surface and its instrumentation |
| `arch/bus-routing.ngf.md` | the 0..63 channel model, argued against FL Studio |
| `arch/sag-playwright.ngf.md` | what SAG identity and browser automation are worth together — including where they are not |
| `design/` | phase briefs, refinements, reference material |

## Status

Pre-1.0 and moving. The engine is stable; the surface and the routing model are not
finished. See `ROADMAP.md` for what has shipped and what has not.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
