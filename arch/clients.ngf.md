---
format: ngf/0.0.3
kind: arch_card
card_name: clients
title: arch/clients — the control surface, and how far a design pass may go
written: 2026-07-30
written_by:
  - Eyal Nof
  - Claude (Opus 5, 1M context)
edges:
  governs: "src/clients/** + src/main.tsx + src/index.css + index.html"
  companion_cards:
    - arch/contract.ngf.md         # the risk areas; read that FIRST
    - arch/design-system.ngf.md    # palette and type; written by the design planning cycle
  design_references: "design/references/ — four images that set the target"
---

# §0. Why this card exists

This subtree is where a design pass belongs, and it is deliberately generous: everything
visual is fair game. The constraint is not on how it looks, it is on where the values come
from.

Read `arch/contract.ngf.md` before editing anything here.

# §1. main_files

**Refreshed 2026-08-01.** This section described `src/clients/debug/` as "the whole current
surface" and named `src/clients/ui/` as the surface to build. Neither is true: the designed
surface was built in Phase 4 and it is `src/clients/synth/`. A card describing a tree that
moved under it is the defect this project keeps closing, so the correction is dated rather
than silent.

```yaml
main_files:
  src/main.tsx:                          entry; `#debug` mounts the wall, anything else the instrument
  src/clients/surface-route.ts:          the one predicate deciding which
  src/index.css:                         global reset + base type
  index.html:                            the shell, including the viewport meta

  # The instrument — the real surface.
  src/clients/synth/SynthApp.tsx:        shell, engine singleton, unlock, keyboard, XY pad, param funnel
  src/clients/synth/SynthPanels.tsx:     the tabbed panel host
  src/clients/synth/groups.tsx:          which controls appear where, derived from core
  src/clients/synth/TabView.tsx:         tab + sub-tab chrome
  src/clients/synth/ControlGrid.tsx:     layout for a group of controls
  src/clients/synth/controls/:           the kit — Knob, Slider, Toggle, Select, RateControl,
                                         GlyphButtons, EnvelopeCurve, ModRing
  src/clients/synth/controlProps.ts:     ParamSpec -> control props, and the SAG attributes
  src/clients/synth/RouteList.tsx:       the modulation routing bay
  src/clients/synth/XYPad.tsx:           continuous pitch + a second axis
  src/clients/synth/param-coalescer.ts:  one dispatch per frame during a drag
  src/clients/synth/tokens.ts:           TOUCH_MIN, COLOR, FONT

  # The wall, still useful and still throwaway.
  src/clients/debug/DebugApp.tsx:        diagnostics surface at `#debug`
  src/clients/debug/VirtualKeyboard.tsx: multi-touch keys via Pointer Events — shared with the instrument
  src/clients/debug/keyboard.ts:         note-name maths and the drawn key geometry
```

**`src/clients/debug/` is throwaway by an explicit decision of Eyal's** — but it is no
longer the only surface, and two of its files are load-bearing for the instrument
(`VirtualKeyboard`, `keyboard.ts`). Deleting the wall means moving those, not dropping them.

# §2. public_interfaces

```yaml
public_interfaces:
  SynthApp():                                          mounted by src/main.tsx
  SynthPanels({state, onChange, onCommand}):           the panel seam
  renderControl(props):                                the control seam — src/clients/synth/controls
  VirtualKeyboard({onNoteOn, onNoteOff, octave}):      the play seam
  createParamCoalescer(dispatch, schedule?):           the drag-rate seam
  DebugApp():                                          the wall, at `#debug`
```

# §3. safe_edit_points

- **Everything visual**: layout, palette, type, spacing, motion, component structure,
  responsive rules, portrait vs landscape behaviour, tab structure.
- **New components** anywhere under `src/clients/`.
- **A new `src/clients/ui/` tree**, and switching `src/main.tsx` to mount it.
- **Labels and units shown to the user.** `PARAM_SPECS` supplies a machine range and a raw
  unit string; presenting `voice.filterEnvelope.baseFrequency` as "CUTOFF · 2.8 kHz" is a UI
  decision and entirely yours.
- **Control idiom per parameter.** A spec says `{kind:'number', min:20, max:20000}`; whether
  that is a knob, a slider, a numeric field or a dragged curve is a design call.
- `src/index.css`, `index.html`, and any new asset under `src/clients/`.

# §4. risk_areas

Local to this subtree — the engine-wide ones are in `arch/contract.ngf.md`.

- **Never hand-write a list of parameter addresses.** Derive from `SIGNAL_CHAIN` in
  `src/core/groups.ts` and `PARAM_SPECS` in `src/core/schemas.ts`. A hand-kept list is a
  second source of truth and will drift — `src/tests/groups.test.ts` proves the chain covers
  all **119** addresses exactly once, and nothing proves a copy in a component does. (It
  said 97 until 2026-08-01; the count moved at schema_version 3 when one oscillator became
  three slots, which is precisely why the rule exists.)
- **Never dispatch a parameter change without going through `SynthApp`'s `onChange`.** It
  is the funnel every control shares, and it is where drag-rate coalescing lives — one
  dispatch per animation frame instead of one per `pointermove`, which is what keeps the
  journal from recording hundreds of intermediate values per knob turn. A component
  reaching for `dispatcher.dispatch({type: 'setParam'})` directly bypasses it silently.
  **The XY pad is the one deliberate exception** and it is documented in
  `param-coalescer.ts`: its gesture interleaves `noteOn`/`noteOff` with `setParam`, so
  coalescing only the parameter half would reorder it behind the note. The rule that falls
  out — coalesce a stream of writes to one parameter, never one member of an ordered pair.
- **Never hard-code a range, unit, or legal value.** They live in the spec. A slider with
  its own `max` produces values the dispatcher rejects.
- **Never call the runtime directly from a component.** Dispatch a command.
- **Do not put audio state in React state.** `EngineState` is the source of truth and the
  dispatcher owns it; a component holding its own copy will drift on undo.
- **Keep the engine a module singleton with HMR disposal.** `src/clients/engine.ts` builds
  it at module scope, not in a `useState` initialiser, because StrictMode double-invokes and
  each invocation would build a second audio graph. The `import.meta.hot.dispose` hook is
  load-bearing: without it, thirty saves leave thirty live analysers summing into one
  `AudioContext`, and the synth goes quiet in a way that looks like a DSP bug and is not.
  The same reasoning now covers the render-capacity observer the runtime starts for
  telemetry — it holds a callback into the runtime, so an undisposed one keeps a whole
  instance alive across a reload.
- **Do not remove the audio-unlock affordance, and do not hide it behind a state flag.**
  `pointerdown` is not a user activation on touch and `resume()` resolves either way, so a
  self-set "unlocked" flag can lock the user out permanently with no way back. It is always
  visible on purpose. It may be restyled freely.

# §5. Platform constraints, established empirically

- **Mobile first, and the target device is an Android phone.** Landscape is the play
  posture: the keyboard is the full-bleed surface and panels move behind tabs.
- **Touch, not mouse.** Multi-touch chords need Pointer Events with pointer capture.
  Hover states are decoration here, never the only affordance.
- **Phone speakers roll off hard below ~500 Hz.** This shaped the factory patch and it
  should shape any demo or preset the UI ships with.
- **A meter reading of −2105 dBFS is reachable.** `Tone.Meter` returns denormal-derived
  values; the runtime floors at −100. Any new readout needs the same floor.

# §6. Verification a design pass must leave green

```bash
npx tsc --noEmit          # prints nothing
npm run build             # exits 0
npx vitest run            # zero failures — 526 at 444d328, 2026-08-01
npm run dev && npm run geometry   # exits 0; fails on any control below TOUCH_MIN
```

The count carries its commit because it moves on most of them. What does not move is the
zero — and `npm run geometry` is the one that only exists for this layer: it measures the
real page after layout and refuses a control a thumb cannot hit.

Plus an ear check on the device. The offline gates and the ear check are not substitutes:
the silence hunt established that a patch can pass every buffer assertion and still be
inaudible on a phone speaker.
