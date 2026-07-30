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

```yaml
main_files:
  src/main.tsx:                        entry; mounts DebugApp
  src/index.css:                       global reset + base type
  index.html:                          the shell, including the viewport meta
  src/clients/debug/DebugApp.tsx:      the whole current surface — engine singleton, panels, diagnostics
  src/clients/debug/VirtualKeyboard.tsx: multi-touch keys via Pointer Events
  src/clients/debug/keyboard.ts:       note-name maths for the key row
  src/clients/debug/ParamControl.tsx:  ONE control, generated from a ParamSpec
  src/clients/debug/FilterPanel.tsx:   filter section; a worked example of a generated panel
```

**`src/clients/debug/` is throwaway by an explicit decision of Eyal's.** The designed
surface is a new `src/clients/ui/`, not a restyle of this. Reuse what is useful, delete the
rest; nothing in `debug/` is owed backwards compatibility.

# §2. public_interfaces

```yaml
public_interfaces:
  DebugApp():                            mounted by src/main.tsx
  ParamControl({path, label, spec, value, onChange}):  the control seam
  VirtualKeyboard({onNoteOn, onNoteOff, octave}):      the play seam
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
  all 97 addresses exactly once, and nothing proves a copy in a component does.
- **Never hard-code a range, unit, or legal value.** They live in the spec. A slider with
  its own `max` produces values the dispatcher rejects.
- **Never call the runtime directly from a component.** Dispatch a command.
- **Do not put audio state in React state.** `EngineState` is the source of truth and the
  dispatcher owns it; a component holding its own copy will drift on undo.
- **Keep the engine a module singleton with HMR disposal.** `DebugApp.tsx` builds the engine
  at module scope, not in a `useState` initialiser, because StrictMode double-invokes and
  each invocation would build a second audio graph. The `import.meta.hot.dispose` hook is
  load-bearing: without it, thirty saves leave thirty live analysers summing into one
  `AudioContext`, and the synth goes quiet in a way that looks like a DSP bug and is not.
  Whatever replaces `DebugApp.tsx` must keep both.
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
npx vitest run            # 251 tests, zero failures
```

Plus an ear check on the device. The offline gates and the ear check are not substitutes:
the silence hunt established that a patch can pass every buffer assertion and still be
inaudible on a phone speaker.
