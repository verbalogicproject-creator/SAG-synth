# Design references

The v0.2.0 UI target, set by Eyal on 2026-07-30; the patch-bay reference added the same evening. Copied into the repo because the
originals were in `/storage/emulated/0/Download/` on the phone — a downloads folder that
gets cleared.

**The brief, verbatim:** *"mobile first responsive design so wide screen shows keyboard
full screen then there are other tabs for sequencer, FXs, filter/EQ/LFO. different waves
like square, sine, adsr. orginized in intuitive content aware pipeline."*

| File | What it is for |
|---|---|
| `01-jupiter-xm-layout-grammar.jpg` | **Layout grammar.** Roland Jupiter-Xm. Labelled section strips in signal order (OSC → LFO → FILTER → ENVELOPE → AMP → EFFECTS), panel above, keyboard below. Take the *organisation*, not the styling. |
| `02-exakt-lite-visual-language.jpg` | **Visual language.** Sonicbits EXAKT Lite. Dark slate panels, centred header bars, arc-indicator knobs each with a numeric readout box beneath, lettered tabs for repeated modules, a draggable envelope curve, a live waveform scope, keyboard as a persistent bottom strip. This is the closest single image to the target. |
| `03-exakt-in-context-and-peers.jpg` | The same plugin in a browser, plus a strip of peer synths (ToneZ, OB-Xd) for range. Note ToneZ's output-row EQ. |
| `04-current-debug-keyboard-before.jpg` | **The before.** Our throwaway debug keyboard in landscape. |
| `05-subharmonicon-patch-bay.jpg` | **The routing surface.** Moog Subharmonicon, patch bay circled by Eyal. Not a styling reference — a *shape* reference: modulation drawn as jacks and cables rather than as a table of rows. See PHASE-4-BRIEF decision 2, which it settles. |

## Two readings that need confirming before the design cycle commits to them

1. *"different waves like square, sine, adsr"* is read as **shapes drawn, not named** —
   waveform pickers showing the glyph rather than a text dropdown, and ADSR as a curve you
   drag rather than four sliders. Both references do it this way. It is a component-set
   decision, so it changes real work if the reading is wrong.
2. **Landscape is the play posture** (keyboard full-bleed, panels behind tabs) and portrait
   is the edit posture (panel above, keyboard below, as both hardware references show).
   The brief states the landscape half explicitly and leaves portrait implied.

## What the engine already gives the design for free

- `PARAM_SPECS` — 97 addresses with kind, range, unit, legal values, and whether each is a
  modulation destination. Panels generate; they are not laid out by hand.
- `SIGNAL_CHAIN` in `src/core/groups.ts` — section order and membership, so the tab
  structure derives from the audio path rather than restating it. This is what makes
  "content aware pipeline" mechanical instead of aspirational.
- Four LFO slots and eight route slots as indexed families — EXAKT's A/B/C/D module tabs
  map onto them directly.
- `runtime.getWaveform()` — the scope in reference 02 is already in the runtime contract.

## What is still missing

- **Sequencer.** Nothing exists; it is v0.2.0 by the agreed roadmap. Do not pull it forward.
- `arch/design-system.ngf.md` — the fixed palette and type. The design planning cycle
  writes it; until then there is no palette to honour.
