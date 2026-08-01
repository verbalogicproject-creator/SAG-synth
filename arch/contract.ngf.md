---
format: ngf/0.0.3
kind: arch_card
card_name: contract
title: arch/contract — the engine core, and what a UI pass may never touch
written: 2026-07-30
written_by:
  - Eyal Nof
  - Claude (Opus 5, 1M context)
edges:
  governs: "src/core/** + src/runtime/** + src/app/**"
  companion_cards:
    - arch/clients.ngf.md
    - arch/design-system.ngf.md   # written by the design planning cycle, does not exist yet
  substrate: "sag-declarum-atlas-framework tag v0.0.10 — KIND-synth_patch, KIND-synth_song, KIND-synth_command_applied, KIND-synth_mod_route, KIND-synth_audio_observed"
---

# §0. Why this card exists

A frontend pass is dispatched with a mandate to change how things look and an equal
mandate not to break them. That second half is only enforceable if "what would break" is
written down somewhere the agent reads before it edits, rather than inferred from tone of
voice in a prompt.

Everything below is a **risk area**. Nothing here is a styling decision, and no design
goal justifies crossing it. If a design genuinely requires a change on this side of the
line, that is a finding to report upward, not a change to make.

# §1. main_files

```yaml
main_files:
  src/core/types.ts:          the frozen domain vocabulary; 119 parameter addresses, 36 command verbs
  src/core/commands.ts:       the command union — simultaneously UI API, journal row, and SDK wire format
  src/core/schemas.ts:        zod validation + PARAM_SPECS, the range/unit/choices registry
  src/core/groups.ts:         SIGNAL_CHAIN — section order and membership for any control surface
  src/core/reduce.ts:         the only function that changes EngineState
  src/core/state.ts:          EngineState shape and the factory defaults
  src/core/params.ts:         getParam — reads an address back out of state
  src/core/sag/events.ts:     KIND slot maps; the substrate correspondence
  src/core/runtime-contract.ts: the audio seam (RuntimeAdapter / RuntimeReadout / NullRuntime)
  src/runtime/tone-runtime.ts:  the ONLY file permitted to import `tone`
  src/app/dispatcher.ts:        validate -> reduce -> journal -> drive the runtime
  src/app/create-engine.ts:     assembles a Dispatcher; takes the runtime as a parameter
```

# §2. public_interfaces

What a client is allowed to use, and the only things it needs:

```yaml
public_interfaces:
  createEngine(deps) -> { dispatcher }:   src/app/create-engine.ts
  dispatcher.dispatch(command, source):   the ONLY way to change anything
  dispatcher.getState() -> EngineState:   read the current patch/song/history
  getParam(state, path) -> ParamValue:    read one address
  PARAM_SPECS[path] -> ParamSpec:         kind, min, max, unit, choices, modulation
  PARAM_PATHS: readonly ParamPath[]:      all 119, exhaustive
  SIGNAL_CHAIN / sectionFor(path):        src/core/groups.ts — layout derives from this
  runtime.getWaveform() / getLevel():     read-only observation for a scope or meter
```

# §3. risk_areas — do not touch

- **Never rename or remove a `ParamPath`.** The 119 addresses are a wire format: they are
  in the journal, in saved presets, in `KIND-synth_mod_route`'s destination vocabulary, and
  in the v0.2 SDK's surface. Renaming one to read better in a label breaks replay of every
  session ever recorded. Labels are a UI concern and belong in the UI; the address is not.
- **Never add, rename, or reshape a command verb.** Same reason, plus
  `src/tests/contract.test.ts` freezes the list of 36 longhand and will fail.
- **Never bypass `dispatch()` to reach the audio graph.** A control that calls the runtime
  directly produces sound with no journal row, which silently breaks F59 replay. Every
  control dispatches `setParam` like everything else.
- **Never import `tone` outside `src/runtime/`.** Mechanically enforced by
  `src/tests/contract.test.ts`; swapping `NullRuntime` in is what makes the engine headless
  and is the v0.2 SDK seam.
- **Never import `react` into `src/core/**` or `src/app/**`.** Same test.
- **Never edit the KIND slot maps** in `src/core/sag/events.ts`. They are transcribed from
  a separate repo and a contract test proves the correspondence.

  **This rule was crossed on 2026-08-01 and the crossing is recorded rather than tidied
  away.** Phase C's telemetry (X4) added four optional slots to
  `SYNTH_AUDIO_OBSERVED_OPTIONAL_SLOTS` — `base_latency`, `output_latency`,
  `render_capacity`, `underrun_ratio` — and the whole suite stayed green. Not because the
  addition was legitimate: because the second half of the sentence above was **not true of
  that KIND**. `synth_command_applied` had a `toEqual` freeze list; `synth_audio_observed`
  had none, so nothing was watching. A rule with no gate behind it is a comment, and this
  project's recurring defect is a thing that looks wired and is not — here, one layer up
  from the code.

  Two consequences, both open:

  1. **The freeze list now exists** (`contract.test.ts`, "freezes
     KIND-synth_audio_observed"), so the mirror cannot drift again unnoticed.
  2. **The mirror currently runs AHEAD of the declaration.** `KIND-synth_audio_observed`
     lives in `sag-declarum-atlas-framework` at tag `v0.0.10`, which is not present on this
     machine, so the four slots cannot be declared from here. Until they are, this is
     emit-before-declare and is a real violation of the substrate's own discipline, not a
     formality. The slots are additive and optional, so nothing downstream breaks — but a
     consumer validating against the published KIND will not recognise them.

  **What closing it needs**, so it is one edit rather than an investigation: add to
  `KIND-synth_audio_observed` §2 optional slots — `base_latency` (seconds,
  `AudioContext.baseLatency`), `output_latency` (seconds, `AudioContext.outputLatency`),
  `render_capacity` (0..1 mean audio-thread load), `underrun_ratio` (0..1 fraction of
  render quanta that underran). All four are absent-when-unavailable by design; see
  `telemetry.audio.test.ts` for the gate that asserts the absence.
- **Never change `PARAM_SPECS` ranges to suit a slider.** The spec is the validator. A
  control whose range disagrees with the spec produces values the dispatcher rejects, which
  looks like a broken knob and is actually a broken claim.
- **Never touch `src/tests/contract.test.ts` freeze lists.** They fail on purpose when the
  contract moves. Making a test pass is not the same as making the change safe.

# §4. safe_edit_points

See `arch/clients.ngf.md`. In this subtree there are none.

# §5. Verification a UI pass must leave green

```bash
npx tsc --noEmit          # prints nothing
npm run build             # exits 0
npx vitest run            # zero failures — 526 at 444d328, 2026-08-01
```

The count carries its commit because it moves on most of them, and a bare number in a card
is a claim that rots. What does not move is the zero.

If `src/tests/contract.test.ts` fails, a risk area was crossed. That is the signal to stop
and report, not to update the test.
