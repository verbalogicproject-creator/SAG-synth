# Phase 4 — the design cycle, ready to start

Everything the interactive session needs, so it can begin cold. Written 2026-07-30 at
`10f5685`; revised the same evening at `208445c`, engine at v0.1.15, 363 tests green.

## What is already settled

- **The design exists.** `design/stitch/` — seven screens the engine can drive, with every
  design-vs-engine disagreement recorded in its README. `design/stitch/roadmap/` — eleven
  more, costed against the versions they would need.
- **The nav is four tabs: OSC · ADSR · FILTER · FX.** From `01-fx-and-master`, the earliest
  Stitch iteration, which is the only one matching the engine's actual scope. Later
  iterations grow to eight by adding DRUMS/SEQ/SONG/SAMPLE — none of which exists.
- **The guardrails are written.** `arch/contract.ngf.md` (risk areas) and
  `arch/clients.ngf.md` (safe-edit zone). `arch/design-system.ngf.md` does NOT exist — the
  cycle produces it.
- **The tokens are extracted.** `#00dbe9` accent on a `#131315` surface family, Space
  Grotesk for display, JetBrains Mono for numerals. Full list in `design/stitch/README.md`.
- **Modulation is drawn as a patch bay, not a table.** Eyal's call, from the Moog
  Subharmonicon (`design/references/05-subharmonicon-patch-bay.jpg`). Jacks and cables
  over `SIGNAL_CHAIN`'s existing panel order; see decision 2, which it half-settles.
- **Reference synths are out of scope.** See `design/reference-synths.md` — read-only
  value, licensing forbids extraction, and none of it bears on v0.2.0.

## The one rule everything else bends around

Every control generates from `PARAM_SPECS` and dispatches a command. The range belongs to
the validator; the journal records the change. A slider carrying its own `max` produces
values the dispatcher rejects — which is exactly how a control ends up silently doing
nothing, and this project has now shipped that bug five separate ways. The most recent two
are worth knowing before drawing anything: a distortion `amount` that moved the level
rather than the timbre, and then the same effect shipping at a default nobody could hear
switch on. **A control that appears to work is the failure mode here, not one that errors.**

The Stitch files are mockups, so every value in them is a literal. **The design decides how
it looks and where things sit. `PARAM_SPECS` keeps deciding what a knob's range is, and
`SIGNAL_CHAIN` keeps deciding what belongs in a panel.**

## Blocking decisions — the build cannot start without these

**1. One oscillator or three. — SETTLED: three, and the engine already has them.**

Eyal, 2026-07-30: *"more then one ocsilator will give better sound design"*, then *"Go, 3
slots"*. Built at 0.1.15, so this is no longer a fork the design cycle has to price — it
is a capability the surface has to draw.

`voice.oscillators` is a list capped at 3. Each slot carries `enabled`, `type`, `octave`,
`detune`, `count`, `spread`, `width`, `level`, `pan` — the design's A/B/C set minus
`PHASE`, `SYNC` and `VEL. SENS`, all three refused with reasons in KIND-synth_patch §5.
The debug `OscillatorPanel` draws one panel per filled slot with add and remove; that is
the throwaway version of what the designed surface needs.

**What this changes for the design:** the OSC tab is now a slot family, not a fixed panel.
Three slots × nine controls is a lot of surface on a phone, and the EXAKT reference's
lettered module tabs (A/B/C/D) are the obvious answer — they were drawn for exactly this.
It also triples the OSC panel's jack count on the patch bay, which is why this decision
had to land before decision 2 was drawn rather than after.

**2. Where routing and the EQ live in a four-tab nav. — ROUTING IS SETTLED: a patch bay.
The EQ is still open.**

Eyal, 2026-07-30, with the Moog Subharmonicon's patch bay circled
(`design/references/05-subharmonicon-patch-bay.jpg`): *"do we need some sort of
switchboard… for seperation of conceren?"*

Not for separation of concerns — that already exists and is mechanically enforced
(`core/` → `runtime/` → `app/` → `clients/`, gated in `contract.test.ts`). But as the
**routing surface** it is the right answer, and it dissolves the half of this question it
touches. A jack is a source, a jack is a destination, a cable is a `ModRoute`. That is not
a metaphor laid over the data — it is the data: `(source, destination, depth)`, five
sources, **thirty-one** destinations, eight cables.

Three reasons it beats the alternatives that were listed here:

- **The layout is already declared.** `SIGNAL_CHAIN` orders the panels, so a destination
  jack sits on the panel its parameter belongs to. Nothing new to lay out and no second
  list to drift — the same property that makes every control generate from `PARAM_SPECS`.
- **It is not a tab, so the four-tab nav survives intact.** A patch bay is an overlay
  across the panels with cables drawn between them, which is what "fold into FX / add a
  fifth tab / hide it behind a screen" were all working around. It also delivers the
  original brief's *"intuitive content aware pipeline"* and the Jupiter-Xm signal-flow
  grammar in the same gesture, rather than as a separate feature.
- **A cable is legible where a matrix row is not.** `lfo.0 → voice.pan, ±0.50` is
  something you read; a cable is something you see. The route-overflow indicator becomes
  a property of the drawing — two cables into one jack — instead of a warning banner.

**Where the reference has to stop, and this is the part the drawing does not have.** A
Moog bay is undeclared mono CV: any output into any input, and if it makes no sense you
find out by ear. Ours refuses undeclared destinations at the boundary (F71), and only 13
of the 31 are wired today. So **not every jack accepts every cable**, and the
surface has to say so *before* the cable is dropped — a jack that quietly accepts a lead
and produces nothing is the decoy-knob failure this project has now shipped five times.
Dimming or refusing the illegal targets while a cable is being dragged is the minimum.

**What is still open under this decision:**

- **The EQ still has no home.** Untouched by the patch bay: five band gains are
  destinations and get jacks, but the EQ *controls* are absent from the Stitch FX screen
  and need somewhere to live.
- **Does the patch bay replace `05-mod-matrix` or sit behind it?** The Stitch screen maps
  almost one-to-one onto `ModRoute` and is buildable as drawn. A bay is the better
  surface; the matrix is the better *list*. They may both be right at different sizes —
  bay in landscape, list in portrait — which is decision 3's business.
- **Cable count.** Eight routes is a lot of crossing lines on a phone. Whether cables are
  drawn between panels or terminate at a per-panel edge strip is a real layout question.

**3. Portrait or landscape as the primary posture.** The original brief said *"wide screen
shows keyboard full screen, then tabs for the rest"*. Every Stitch screen is portrait with
the keyboard as a bottom strip. Both are defensible; they produce different layouts.

**4. Is the preset browser in v0.2.0?** `savePreset` / `loadPreset` / `deletePreset` and
`IdbPersistence` all exist, are tested, and have never had a UI. The screen is designed
(`06-preset-browser`). It is the cheapest large feature available — but it is scope.

## Smaller decisions, needed before the relevant panel is built

**5. Bipolar modulation depth.** The design's mod matrix shows `+75%` / `−20%`; our `depth`
is `0..1` unipolar, so inverted modulation is inexpressible. Small change, probably worth
adopting, needs a contract bump. **The patch bay raises the stakes slightly**: polarity is
currently a property of the source (KIND §3.1) and invisible on a cable, so a bay either
shows it per-cable or the question of negative depth becomes harder to answer visually
than it is in a table.

**6. ADSR as a dragged curve or four sliders.** Both references show a curve with draggable
breakpoints. Significant component, real payoff.

**7. Waveform pickers: drawn glyphs or a named dropdown.** The design uses a dropdown; both
hardware references draw the shape.

**8. Secondary hues — system or improvisation.** Cyan is clearly the identity. The filter
screen uses orange for the response curve, green for env-amount, salmon for delay. Decide
whether those are semantic (per-section) or incidental.

## Things in the design the engine does not have

Not decisions so much as gaps to route around. Each is either "drop it" or "build it first".

- **Filter `DRIVE`** — nearest existing thing is `effects.distortion.amount`, which sits
  after the filter rather than inside it. A different sound.
- **Reverb `DECAY` and `PLATE`** — we specified Freeverb parameters deliberately, because
  `Tone.Reverb` generates a randomised impulse response and cannot be gated. No decay
  parameter exists.
- **Mod sources we lack** — envelopes, aftertouch, mod wheel, random. We have `lfo.0–3` and
  `velocity`.
- **`LFO RATE` as a mod destination** — excluded on purpose by KIND-synth_mod_route §6: a
  route whose destination is another route's source makes the graph cyclic and nothing
  declares an evaluation order.
- **Stereo master meters** — ours is mono.
- **The five-band EQ is absent from the design** — it exists in the engine and needs a home.
- **Only 13 of the 31 declared destinations are wired**, and the patch bay makes this
  urgent rather than academic. Cutoff, resonance, voice amplitude, voice pan, and per slot
  `detune` / `level` / `pan` reach the graph. The other eighteen — every `effects.*` and EQ
  band, plus per-slot `width` and `spread` — validate, journal and replay correctly and
  **make no sound**; the runtime reports each by name through `getUnimplemented()`. A table
  can list eighteen greyed rows and be honest. A bay draws eighteen jacks that look exactly
  like the thirteen that work, so it has to distinguish them in the drawing or it is a wall
  of decoys.

## Pending engine work that touches the UI

**Stage 3.5 — per-destination modulation curves. · Landed at 0.1.11.** This was the one
blocker on drawing a depth control, and it is gone. Each destination now declares its own
`curve` in `KIND-synth_mod_route` §3.2 — `octaves` for cutoff, `duckDb` for amplitude,
`linear` for the rest — and the depth control does **not** need to know any of that:

```ts
describeDepth('voice.filterEnvelope.baseFrequency', 0.5)  // '±2.00 oct'
describeDepth('voice.amplitude', 0.5)                     // '−30 dB'
describeDepth('voice.oscillator.detune', 0.5)             // '±600 cents'
```

`describeDepth(destination, depth)` is in `src/core/params.ts`. Read it; do not reimplement
the three cases in a component. The debug `ModPanel` already renders it under each route's
depth slider, which is the throwaway version of what the designed surface should show.

**The route-overflow indicator landed with it.** `modulationLoad(state)` in
`src/core/modulation.ts` returns one entry per destination the enabled routes point at,
with `reach`, `limit` and an `overflows` flag; `describeLoad(load)` renders the line. The
designed surface should show it somewhere — two deep routes at one destination lose travel
and Web Audio clamps silently, which is exactly the class of thing this instrument keeps
shipping. `ModPanel` has the throwaway version, and `mod-panel.browser.test.ts` gates that
it appears when it should and stays absent when it should not.

Two design consequences worth knowing before drawing anything:

- **A parameter resting at the end of its own range wastes half of every route.**
  `effects.distortion.wet` ships at 1.0, so any bipolar route there spends half its travel
  above full wet. The indicator flags it on the factory patch. Whether the fix is a
  different default, a `duckDb`-style curve, or just showing it, is a design call.
- **Two `duckDb` routes at one destination overflow upward** — the peak goes above the
  patch's own amplitude. Declared in KIND §3.3 rather than corrected, so the surface has to
  be able to say so rather than assume it cannot happen.

## Suggested shape for the session

Ask the blocking four first — they change what gets built, and decision 2 is now half an
answer rather than a question, so it needs less time than the others. Then produce
`arch/design-system.ngf.md` with the fixed palette and type, and a component spec naming
which Stitch screen each panel comes from and which `SIGNAL_CHAIN` section feeds it. Only
then dispatch the build, inside the arch cards.

**The patch bay is the one component with no Stitch screen behind it**, so it needs
specifying rather than transcribing. The minimum it has to express, all of it already in
the data: a jack per declared destination sitting on its own panel, a jack per source,
cables carrying depth, wired-versus-declared distinguished in the drawing, and illegal
targets refused while a cable is dragged. `describeDepth(destination, depth)` labels a
cable; `modulationLoad(state)` tells it when two cables into one jack ask for more travel
than the parameter has.

`taste-frontend-designer` reads those cards and is constrained by them. Note that the
installed `design-taste-frontend` skill self-declares *"not dashboards, not data tables, not
multi-step product UI"* — a synth control surface is what it excludes. `image-to-code`,
`imagegen-frontend-mobile` and `high-end-visual-design` fit better, and the Stitch build
skills (`stitch-build:react-components`) still need the Stitch MCP configured, which it is
not.
