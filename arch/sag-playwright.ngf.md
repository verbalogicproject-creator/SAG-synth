---
format: ngf/0.0.3
kind: arch_card
card_name: sag-playwright
title: arch/sag-playwright — what SAG and Playwright are worth together, and what they are not
written: 2026-07-31
written_by:
  - Eyal Nof
  - Claude (Opus 5, 1M context)
edges:
  governs: "scripts/sag-geometry.mjs + .sag/surface-geometry.json"
  companion_cards:
    - arch/contract.ngf.md
    - arch/clients.ngf.md
  related_work: "termux-camera automation in sag-video (services/sag-engine/src/sag_video/capabilities.py)"
---

# §0. The claim, stated so it can be wrong

The claim under test is:

> **SAG identity and browser automation are each crippled alone, and together they produce
> a kind of knowledge neither can produce.**

This card exists because that sentence is exactly the sort of thing that sounds true and
costs a week. So it is written as a claim with evidence attached, and §4 is a list of
places the synergy is **not** real — because a claim that cannot lose is not a claim.

# §1. What each half is blind to

**Playwright without SAG** drives a page by CSS path or pixel position. Every selector
encodes layout, so the first design pass breaks every script. `sag-command-plugin.mjs`'s
own header records the pain in this repo's history: *"driving a headless browser to click
pixels, three times."*

**SAG without Playwright** declares a surface it cannot see. `public/sag-surface.json`
knows `ctl-041` is the cutoff knob on the FILTER tab, its range, its unit and its curve. It
does not know whether that knob is on screen, how big it is, or whether a thumb can hit it.
Those are not properties of a declaration. **A declaration cannot be wrong about a rect; it
can only be silent.**

**Together**, `[data-sag-id="ctl-041"]` is a selector that survives every restyle — because
identity was minted flat and opaque (`ctl-041`, never `filter-knob-3`) precisely so that no
layout fact is encoded in it. That decision was made before there was anything to spend it
on. This is what it was minted for.

The output is a **join**, and the join is the artifact: a rect keyed by an id that means
something. Rects without identity are a picture. Identity without rects is a claim.

# §2. Evidence — the first run, 2026-07-31

`npm run geometry` against the live dev server, real chromium, 412x915 portrait, on the
device. Two findings, neither reachable by any other gate in this project:

**1. Every slider ships at half its declared touch minimum.**
`tokens.ts` declares `TOUCH_MIN = 44`. `Slider.tsx:72` sets the track to `TOUCH_MIN / 2`,
and the comment directly above it reads *"Tall enough to hit with a fingertip."* The
measured hit box is **22px on 14 sliders** — the amplitude and filter envelopes, which is
to say the most-used controls on the instrument. The comment asserts the opposite of what
the code does, which is the same defect class as `BAND_REALITY`'s imaginary gate and the
mixer probe's imaginary failing assertion.

No existing gate could see this. `synth-tabs.browser.test.ts` proves a control is
*reachable* by clicking a mounted component; reachable and hittable are different claims,
and only one of them is about pixels.

**2. The harness's own first answer was wrong, and the harness caught it.**
The first run reported 41px, not 22px. Every control in the kit put `data-sag-id` on a
**wrapper** `<div>`, not on the element that takes the touch — so the wrapper's box included
the label row and overstated the target by the height of some text.

`arch/clients` and the §4.2a plan both say the attributes go on *"the outermost interactive
element."* Seven of seven controls put them on a non-interactive wrapper. That was a real
divergence between the declared instrumentation contract and the built one, and it means:

> **Geometry is only as honest as the element the identity sits on.**

`harvest()` measures both — the wrapper box and the largest interactive descendant — and
judges `TOUCH_MIN` against the second, so the reading is right regardless of where the
attributes sit.

**Both are fixed as of Phase A** (2026-08-01). The sliders are `TOUCH_MIN`, and all seven
controls now carry their attributes on the interactive element: `Knob` → its
`role="slider"` svg, `Slider` → the `<input>`, `Toggle` → the `<button>`, `Select` → the
`<select>`, `RateControl` → its button, `GlyphButtons` → the `role="radiogroup"` (N radios
*are* the control, so the group is the smallest element that means "this parameter"). The
page now measures zero below `TOUCH_MIN`, and **that is a gate**: `npm run geometry` exits
non-zero on any control smaller than a fingertip. Proven by shrinking one slider back and
watching it exit 1.

# §3. What this makes possible that nothing else does

- **A touch-target gate on the real page.** Not a lint rule about CSS; a measurement of
  what the browser did after layout, at the viewport the instrument is played at.
- **"Declared but never drawn," proven.** The first run reported 53 of 119 unmeasured and
  the breakdown accounts for all of them: 3 behind the gear (never opened), 18 belonging to
  oscillator slots B and C (the factory patch ships one slot, so they correctly do not
  exist), and **32 bay addresses that the bay overlay does not draw with SAG attributes** —
  which is honest, because §4.4's jackfield is still unbuilt.
- **Geometry the agent layer needs.** §4.2a says spatial awareness must come from
  `getBoundingClientRect()` at runtime, never baked coordinates, because *"a live rect is
  correct after every layout change, a frozen coordinate is a guess."* This is that runtime.
- **A closed loop with no person in it.** Playwright opens the page, `/__sag/command` plays
  the instrument, `/__sag/observe` logs what the master bus did, and the geometry says where
  everything was while it happened. All four pieces already existed; none is new.

# §4. Where the synergy is NOT real

The honest half of the card.

**It is not "Playwright unlocks real-browser testing."** The `audio` and `dom` vitest
projects have used Playwright's chromium since v0.1 — real CSS, real layout, real
`getBoundingClientRect`, real Web Audio. Anything measurable about a *mounted component* was
already available and needed no harness. What `sag-geometry.mjs` adds is the **whole running
application**: the real bundle, the real stylesheet cascade, the real nav, the real
`AudioContext` unlock path. The distinction is component versus app, not fake versus real.

**It does not replace the ear, and replacing it is not the goal.** Eyal's framing, stated
2026-07-31 and worth recording because it decides what this whole layer is for: SAG-synth is
an **AI-integrated instrument designed to maximise the player's potential — not a machine
for making AI music.** So the point of automating correctness is not to move judgement to
the machine; it is to stop spending the player's attention on whether a knob is wired, so
all of it goes to whether the sound is right. The harness narrows the human check from
*correctness plus taste* down to taste — which is the half that was always the person's, and
the half the step sequencer and everything after it are being built to serve.

That is also why the foundation has to be exact rather than approximately fine. An assistive
layer reasons about the instrument through these declarations; a surface that lies to the
substrate produces an assistant that confidently points at the wrong knob.

**It is not free coverage.** The sweep reaches what it is told to reach. It did not open
the settings screen, so those three controls report as missing. A gate that cannot tell
"legitimately absent" from "broken" is a gate that gets disabled, so the script reports the
breakdown and only *fails* on the one condition that is unambiguous: a drawn control whose
id the mint has never heard of, which means the surface and the SOT have diverged.

**The ids are load-bearing, and that is a dependency, not a win.** If identity were ever
derived from layout, every conclusion in this card would rot on the next redesign.

# §5. Relation to the termux-camera loop

Eyal built an autonomous vision loop before Playwright was available here: codex issuing
termux commands and taking its own screenshots — not a human pasting images. The capability
is declared in `sag-video` at `services/sag-engine/src/sag_video/capabilities.py`
(`"termux_camera": "termux-camera-photo"`). *Verified: that declaration exists at that path.
The workflow around it is described here as Eyal described it, not as something read.*

The two are **complementary, and the axis is not automation**, since both are autonomous:

| | termux camera / screenshot | Playwright + SAG |
|---|---|---|
| sees | pixels of anything on the device | structure inside one browser |
| returns | an image needing a vision model | integers joined to `ctl-NNN` |
| precision | approximate, OCR-dependent | exact, post-layout |
| scope | any app, OS chrome, the physical screen | only what the browser renders |
| cost | a vision inference per look | a `$$eval` |

The camera answers *"what does it look like"* for anything. The harvest answers *"what is
it, and exactly where"* for one app. Neither supersedes the other: the camera reaches where
Playwright cannot go, and the harvest is exact where the camera can only estimate.

The interesting composition is using them together — a camera frame of the real device, and
a geometry harvest that turns a region of that frame into a control **id** rather than a
guess. That is the missing Universal I/O row, the shared visual language between a human and
an agent, and it is now one join away rather than a research project.

# §6. Running it

```
npm run dev                       # separate terminal; the script does not start it
npm run geometry
npm run geometry -- --viewport 1024x768
```

Writes `.sag/surface-geometry.json`. Exit 0 clean, 1 a gate failed, 2 no page answered.

Plain `.mjs` outside `tsconfig.json` for the same reason as its two siblings: typing it
would mean `@types/node`, which the contract refuses so `src/core/**` stays
environment-free.
