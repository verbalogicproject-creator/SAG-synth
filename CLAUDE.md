# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SAG-synth is a browser synthesiser (React 19 + Tone.js + zod, Vite, TypeScript) built as an
AI-integrated instrument: every control is declared, addressable and observable. Every state
change is a command dispatched through one dispatcher, journaled as exactly one SAG event, and
replaying the journal must reconstruct live state byte-identically (undo stack included). That
constraint exists so an agent can drive the synth as a peer of the React UI over the same command
surface, and it explains most of the design decisions below.

## Commands

```bash
npm run dev          # Vite dev server on 0.0.0.0:5173 (bound to all interfaces on purpose: PRoot env, opened from an outside browser)
npm run build        # tsc --noEmit && vite build
npm run typecheck    # tsc --noEmit
npm test             # vitest run — all projects

npx vitest run --project core                   # pure Node tests only (fast)
npx vitest run --project audio                  # headless chromium, real Web Audio / Tone.Offline
npx vitest run --project dom                    # headless chromium, DOM/IndexedDB, no audio
npx vitest run src/tests/reduce.test.ts         # single file
npx vitest run src/tests/reduce.test.ts -t "name"  # single test
```

`npm run observe | command | geometry | mcp` and `vite.config.ts` reference `scripts/sag-*.mjs`
(dev-server plugins for the observation receiver and HTTP command bridge, plus an MCP server).
**The `scripts/` directory is currently absent from this checkout**, so `dev`/`build` will fail
to load `vite.config.ts` until it is restored.

### Test project is chosen by filename

| Suffix | Vitest project | Environment |
|---|---|---|
| `*.test.ts` | `core` | plain Node |
| `*.audio.test.ts` | `audio` | headless chromium (Playwright), real Web Audio |
| `*.browser.test.ts` | `dom` | headless chromium; `src/test-harness/no-app-persistence.ts` disables app autosave |

`src/tests/mixer-cost.audio.test.ts` is a wall-clock benchmark isolated in its own `bench`
project that runs after all others (`sequence.groupOrder`) — don't move it into the parallel pool.
Chromium runs with `--no-sandbox` because PRoot/Termux can't use the sandbox.

## Architecture: four layers, mechanically enforced

```
src/core/     zod only. No tone, no react, no DOM globals, no clock, no id generation.
src/runtime/  the ONLY subtree allowed to import `tone` (ToneRuntime implements core's RuntimeAdapter).
src/app/      adapters + dispatcher. May import zod, idb, @tonejs/midi. Never tone, react, src/runtime/, or src/clients/.
src/clients/  React UI. Never touches the audio graph — every note goes through the dispatcher.
```

These are gated by `src/tests/contract.test.ts` (scans static, side-effect, dynamic and `require`
imports). Violations fail the test suite. Adding to an allowlist there should be a deliberate decision.
The point: swapping `ToneRuntime` for `NullRuntime` makes the engine headless — that is the agent/SDK seam.

Key files:
- `src/core/index.ts` — public barrel of the domain core. `commands.ts` (verb union + envelopes),
  `schemas.ts` (`validateCommand`, `PARAM_PATHS`/`PARAM_SPECS`), `reduce.ts` (pure reducer),
  `history.ts` (undo/redo driver), `allocate.ts` (pure voice allocator), `runtime-contract.ts`
  (the audio seam), `ports.ts` (persistence/MIDI ports), `sag/events.ts` (journal + event KINDs).
- `src/app/dispatcher.ts` — the one place that wires validation → reducer/history → allocator →
  runtime → journal → persistence. `create-engine.ts` builds it with injected runtime/ids/clocks.
- `src/clients/engine.ts` — single engine per page, stored on `globalThis` (survives StrictMode
  double-init and Vite HMR; multiple engines previously silenced the tab).
- `src/main.tsx` — mounts `SynthApp` (instrument) or `DebugApp` (`#debug` hash). Exactly one, ever;
  switching surfaces is a reload.
- `src/app/hot-command-bridge.ts` / `http-observer.ts` — dev-only channels (via Vite plugins) to
  send commands to the page as source `'agent'` and receive audio observations.

## Invariants to preserve

- **The contract is frozen.** `contract.test.ts` lists verbs, param paths, event slots, effect
  order etc. longhand. Changing the command surface means bumping schema_version and updating
  those lists deliberately — never derive expectations from the code under test.
- **Determinism:** no `crypto.randomUUID()`, `Date.now()`, `performance.now()` below `src/app/`.
  Ids/timestamps are injected (e.g. MIDI importer takes id factories and `createdAt`; new docs derive
  ids from the command id).
- **Every dispatch consumes exactly one journal seq**, rejections included; invalid commands never
  reach the reducer or runtime. Validation happens once, in the dispatcher — don't add a second
  validation layer elsewhere.
- **Undo/redo are journaled commands**, handled by `history.ts`, not the reducer. `zustand`/`zundo`
  are installed but unused dead weight.
- **Voice allocation is decided in core** (`allocate.ts`, ties broken by `voiceId`); the runtime only
  executes. `Tone.PolySynth` is deliberately not used — manual pool of `MonoSynth`.
- **Note time is in beats** (quarter notes, plain numbers); conversion to Tone units happens only at the
  runtime boundary. `portamento` stays in seconds.
- **`setParam` paths are a finite union** with a range spec for every path (oscillators ≤ 3, LFOs ≤ 4,
  routes ≤ 8 keep it finite). Modulation destinations must be declared.
- Reverb uses Freeverb parameters (deterministic), not `Tone.Reverb`.
- `RuntimeAdapter` methods are synchronous except `unlock()`; the `noteOn`/`noteOff` hot path must not await.

## Design docs

`synth-research/` holds the original research pack (01–10). Read
`synth-research/00_implementation_alignment.md` first: it records where the implementation departs
from the pack and why, so don't re-apply recommendations it rejects. Source files carry long
header comments explaining decisions and past incidents — read them before changing a file's approach.
