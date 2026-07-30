# Phase 4 — the design cycle, ready to start

Everything the interactive session needs, so it can begin cold. Written 2026-07-30 at
`10f5685`, engine at v0.1.10, 310 tests green.

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
- **Reference synths are out of scope.** See `design/reference-synths.md` — read-only
  value, licensing forbids extraction, and none of it bears on v0.2.0.

## The one rule everything else bends around

Every control generates from `PARAM_SPECS` and dispatches a command. The range belongs to
the validator; the journal records the change. A slider carrying its own `max` produces
values the dispatcher rejects — which is exactly how a control ends up silently doing
nothing, and this project has now shipped that bug three separate ways.

The Stitch files are mockups, so every value in them is a literal. **The design decides how
it looks and where things sit. `PARAM_SPECS` keeps deciding what a knob's range is, and
`SIGNAL_CHAIN` keeps deciding what belongs in a panel.**

## Blocking decisions — the build cannot start without these

**1. One oscillator or three.** The design has slots A/B/C, each with its own `OCTAVE`,
`PHASE`, `SYNC`, `LEVEL`, `PAN` and `VEL. SENS`. We have one oscillator and none of those
parameters. Taking it literally is a schema bump about the size of the whole v2 routing
change — new paths, new voice construction, a migration. Taking only its visual language
costs nothing. **This is the largest fork and it changes the shape of v0.2.0.**

**2. Where routing and the EQ live in a four-tab nav.** The eight-tab iterations give
modulation its own tab and the four-tab one has no home for either. The EQ is absent from
the Stitch FX screen entirely. Options: fold both into FX, add a fifth tab, or put routing
behind the mod-matrix screen reached from elsewhere.

**3. Portrait or landscape as the primary posture.** The original brief said *"wide screen
shows keyboard full screen, then tabs for the rest"*. Every Stitch screen is portrait with
the keyboard as a bottom strip. Both are defensible; they produce different layouts.

**4. Is the preset browser in v0.2.0?** `savePreset` / `loadPreset` / `deletePreset` and
`IdbPersistence` all exist, are tested, and have never had a UI. The screen is designed
(`06-preset-browser`). It is the cheapest large feature available — but it is scope.

## Smaller decisions, needed before the relevant panel is built

**5. Bipolar modulation depth.** The design's mod matrix shows `+75%` / `−20%`; our `depth`
is `0..1` unipolar, so inverted modulation is inexpressible. Small change, probably worth
adopting, needs a contract bump.

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

Still open under the same stage heading, and **not** a blocker: the route-overflow
indicator. Web Audio sums connections into an `AudioParam` and clamps silently, so two deep
routes at one destination lose travel with nothing saying so. The designed surface would
naturally want to show it; see ROADMAP.

## Suggested shape for the session

Ask the blocking four first — they change what gets built. Then produce
`arch/design-system.ngf.md` with the fixed palette and type, and a component spec naming
which Stitch screen each panel comes from and which `SIGNAL_CHAIN` section feeds it. Only
then dispatch the build, inside the arch cards.

`taste-frontend-designer` reads those cards and is constrained by them. Note that the
installed `design-taste-frontend` skill self-declares *"not dashboards, not data tables, not
multi-step product UI"* — a synth control surface is what it excludes. `image-to-code`,
`imagegen-frontend-mobile` and `high-end-visual-design` fit better, and the Stitch build
skills (`stitch-build:react-components`) still need the Stitch MCP configured, which it is
not.
