# Refinements

Everything asked for or found that is not yet a plan stage. Kept here rather than in a
conversation, because a list that lives in a chat log is a list that gets lost.

**Status vocabulary:** `confirmed` — reproduced with evidence, cause known. `open` — asked
for, not built. `done` — shipped, with the commit. `blocked` — waiting on a decision.

**Swept 2026-08-01 at `444d328`.** R1–R5 and R7 are shipped; R6 moved from Phase 5 to
Phase G, which absorbed the mixer brief. The diagnoses below are left as written rather
than rewritten in the past tense — a record of what was wrong and why is worth more than a
tidy list, and every one of these was found by holding the thing rather than by a test.

**Still open: R6** (per-component channels — now Phase G, and the CPU probe has since
changed its terms; see below), **R8** (custom LFO shapes, a contract change), **R9**
(master mono/stereo) and **R10** (stereo meter), both Phase E.

New since this list was written, and not defects — measurements that move the plan:

- **A disabled effects chain costs what an engaged one costs** (0.241× vs 0.237×). Phase
  G's per-slot node skipping is required work, not a nicety. See `arch/bus-routing.ngf.md`.
- **`octaves` still steps.** `FrequencyEnvelope.octaves` writes `Scale.max` and has no
  parameter behind it, exactly as `baseFrequency` did before Phase C moved it to
  `filter.detune`. It is a knob, so it will want the same treatment.

---

## Confirmed defects

### R1 — the whole LFO tab is inert `done` — `ce8dade`

Reported from the device 2026-07-31 with a screenshot: *"none of the toggles nor knobs work
in LFO TAB."*

**Cause.** `defaultPreset()` in `src/core/state.ts:164` ships `lfos: []`. Every control on
that tab addresses `voice.lfos.0..3.*`, and **none of those slots exist**. `getParam`
returns undefined, `setParam` writes into a slot that is not there, and the controls draw
with fallback values while doing nothing. Roughly **20 controls** — four ON toggles, four
shape selects, four rate knobs, four syncs, four retriggers.

**Evidence.** Driven in a real browser: clicking `voice.lfos.0.enabled` leaves
`aria-checked="false"`, and a drag across `voice.lfos.0.frequency` changes nothing.

**The shape of the bug is the project's signature failure — a control that appears to
work — and this is the largest instance so far.** It is also a capability regression: the
debug wall CAN create LFOs (`ModPanel.tsx` dispatches `addLfo` / `removeLfo`); the designed
instrument cannot. The OSC tab already solves exactly this problem correctly, drawing only
slots the patch holds and offering `+` up to `MAX_OSCILLATORS`.

**Fix, recommended:** give the LFO section the same slot management the OSC tab has, and
ship the factory patch with one LFO so the tab is not empty on first open. The alternative —
having the factory patch ship four LFOs — makes every new patch pay for four oscillators of
modulation it did not ask for.

### R2 — the routing bay has nothing to route `done` — `51712b7`, gated in `9bb4733`

Same cause, different family: `modRoutes: []`. The bay declares **32 addresses** and the
geometry harvest measured none of them, because the overlay draws no controls for slots that
do not exist. `addRoute` exists and only the debug wall calls it. Overlaps with §4.4, which
is half-built (the list shipped in `c23c430`; the jackfield has not).

### R3 — every slider is half its declared touch target `done` — Phase A, gated by `npm run geometry`

`tokens.ts` declares `TOUCH_MIN = 44`. `Slider.tsx:72` sets the track to `TOUCH_MIN / 2`,
and the comment above it reads *"Tall enough to hit with a fingertip."* Measured hit box:
**22px on 14 sliders** — both envelopes. Found by `npm run geometry`; see
`arch/sag-playwright.ngf.md` §2.

### R4 — SAG identity sits on wrappers, not on interactive elements `done` — Phase A

All seven kit controls put `data-sag-id` on a wrapper `<div>`. The §4.2a plan and
`arch/clients` both say *"the outermost interactive element."* Consequence: any geometry
measured from the id overstates the hit area, and the harness had to learn to measure the
interactive descendant separately. Also note `Knob` has **no** interactive descendant at all
(a pointer-driven div), so it has no `role`/`input` for automation to find.

### R5 — the XY pad plays a different note than it draws `done` — B1, pitch now derived from the drawn key geometry

Four of eight drawn white keys sound wrong (C→C#, A→G#, B→A#, C→B). `pitchAt` maps X
linearly over twelve semitones; the drawn keyboard is eight equal-width white keys with
blacks overlaid. The geometry-derived gate in `xy-pad.browser.test.ts` now fails for exactly
this reason. **Waiting on Eyal:** send back to `implementer`, fix in place, or park.

---

## Asked for, not built

### R6 — mixer: a channel per oscillator and per effect `open` → Phase G

*"Each oscillator can have a separate track/channel"*, with FX routing, an FL-Studio-style
master mixer, buses, chains, and mono/stereo at every level. This is **Phase 5** and the
brief exists (`design/PHASE-5-BRIEF.md`) with the CPU probe measured. The measurement
already decided one open question: reverb is 74% of a chain's cost, so shared buses are
load-bearing rather than decorative.

### R7 — ADSR with draggable dots for shape modulation `done` — B2, `d94910f`

The envelope curve renders from the values and the sliders control it (a Phase 4 decision:
*"draggable later, no data-path change"*). This is the "later". Dots on the curve that drag
to set attack/decay/sustain/release directly, which is also the answer to the earlier
dogfood question about which points should be draggable.

Worth noting it composes with R3: a drag target on a curve has the same fingertip problem
the sliders just failed, and the geometry harness can measure it.

### R8 — LFOTool-style custom LFO shapes `open`

Drawing an arbitrary LFO shape rather than choosing from an enum. Deferred as a contract
change: `voice.lfos.N.type` is an enum today, and a custom shape is a curve, which is a new
value kind in `PARAM_SPECS` rather than a new enum member.

### R9 — master mono/stereo toggle `open`

One node, no contract change. Listed in the Phase 5 brief under "what lands before any of
it".

### R10 — stereo master meter `open`

The drawn meter is mono; the graph has been genuinely stereo since the panner fix at 0.1.16,
so `Tone.Meter({ channels: 2 })` makes it real. Phase 4.6b stretch goal.

---

## Done

- **Keyboard pinned to the bottom, with a hide toggle** — `d25d436`
- **Oscillator wave selector as a dropdown** — enum controls default to `select`
- **LFO shape as a dropdown** — same change (the controls draw correctly; R1 is that they
  do not *do* anything)
- **A synth that makes no sound says why** — `b34ce5c`, the missing unlock diagnostics
- **Routing as a list** so there is never a patch with no way to route — `c23c430`
