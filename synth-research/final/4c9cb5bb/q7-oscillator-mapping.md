---
title: "Mapping oscillator.type/count/spread/width onto Tone.MonoSynth's OmniOscillator options"
topic_id: q7
question: "What is the exact legal mapping from SAG-synth's five oscillator parameters onto Tone's oscillator type system, and is width audio-rate modulatable?"
tags: [tone.js, monosynth, omnioscillator, fatoscillator, pulse, pwm, width]
confidence: high
---

## Direct answer

`Tone.MonoSynth`'s oscillator is a `Tone.OmniOscillator`, which aggregates several underlying oscillator classes selected purely by the `type` string. Your five declared parameters (`type`, `count`, `spread`, `width`) map as follows, and the mapping is **type-gated, not always legal** — several of your parameters are silently ignored depending on which underlying oscillator class the `type` string selects. [verified — Tone.js OmniOscillator class documentation explicitly enumerates which members are active per type]

## Exact mapping table

| Your `oscillator.type` value | Tone `type` string | Underlying class | `count`/`spread` legal? | `width` legal? |
|---|---|---|---|---|
| sine | `"sine"` | Oscillator | No (ignored) | No |
| triangle | `"triangle"` | Oscillator | No (ignored) | No |
| sawtooth | `"sawtooth"` | Oscillator | No (ignored) | No |
| square | `"square"` | Oscillator | No (ignored) | No |
| pulse | `"pulse"` | PulseOscillator | No (ignored) | **Yes** — `.width` is the defining parameter |
| pwm | `"pwm"` | PWMOscillator | No (ignored) | No — uses `.modulationFrequency` instead, not `.width` |
| noise | not a Tone oscillator type at all | — | — | — |

[verified — OmniOscillator docs: "`.width` The width of the oscillator (only if the oscillator is set to 'pulse')"; "`.modulationFrequency` ... (only if the oscillator type is set to pwm)"; `.spread`/`.count` (via FatOscillator) documented separately as prefix-triggered, below]

## `count`/`spread` and the `fat*` prefix

`count` and `spread` are **only legal when `type` is prefixed with `"fat"`** — i.e., `"fatsine"`, `"fatsawtooth"`, `"fattriangle"`, `"fatsquare"`. This selects `FatOscillator`, which runs `count` detuned copies of the base waveform spread across `spread` cents total detune. [verified — OmniOscillator docs: "`.spread` The detune spread between the oscillators. If 'count' is set to 3 oscillators and the 'spread' is set to 40, the three oscillators would be detuned like this: [-20, 0, 20] for a total detune spread of 40 cents. See Tone.FatOscillator for more info."]

There is **no `fatpulse` or `fatpwm`** in the documented type system — `count`/`spread` and `pulse`/`pwm` are mutually exclusive families in Tone's `OmniOscillator` type-string grammar. [verified, by exhaustive absence in the documented type-prefix combinations: only "fm", "am", "fat" prefixes on the four *basic* types are documented, and "pwm"/"pulse" are listed as separate standalone types, not prefixable]

## Your five-parameter model does not map cleanly onto Tone's grammar

This is the key finding your current fallback-to-sawtooth behaviour is symptomatic of: **your parameter model (`type` + `count` + `spread` + `width` as simultaneously-available knobs) assumes an orthogonal parameter space that Tone's type-string grammar does not have.** Concretely:

- You cannot have unison (`count`/`spread`) on a `pulse` or `pwm` oscillator in Tone 15.x — if a user dials in `type: pulse, count: 3`, there is no legal Tone type string to construct; `count`/`spread` must be silently ignored or the UI must disable them for pulse/pwm types.
- You cannot have `width` on anything except `pulse` — for `pwm`, the closest analogous "duty-cycle-like" control is `modulationFrequency` (the rate at which pulse width is swept), a categorically different parameter, not a static width value.
- "noise" in your enum is not an oscillator type in Tone's OmniOscillator system at all — Tone's noise generator is a separate class, `Tone.Noise`, used by `Tone.NoiseSynth`, and is not selectable via `OmniOscillator.type`. `MonoSynth` does not support a noise oscillator through its standard oscillator property; if noise is required, it needs a structurally different voice path (e.g., swap in `NoiseSynth`-style construction for that voice, not a `type` string), which likely explains part of why your runtime falls back to sawtooth for unmapped types.

## What this contradicts

The runtime's current "fall back to sawtooth for unmapped shapes" behaviour is masking a **parameter-model mismatch, not a missing switch-case**. The fix is not simply adding more `case` branches for `pulse`/`pwm`/`noise` — it's deciding, per shape, which of `count`/`spread`/`width` are legal, disabling/ignoring the illegal ones explicitly (and stating that in the wire format / journal so replay is unambiguous), and giving `noise` its own non-`OmniOscillator` voice path.

## Is `width` settable at audio rate (modulatable) or only set?

**Only for `pulse` type, and yes it is audio-rate modulatable there.** `PulseOscillator.width` is documented as a `Tone.Signal`-backed member (following the general Tone.js pattern where oscillator parameters exposed as dot-properties on Signal-based classes are backed by real `AudioParam`s), meaning it accepts `.rampTo()`/connection from another node exactly like `frequency` or `detune` do. [reported/inferred — this is consistent with the general Tone.js source class design pattern documented across `Oscillator`/`PulseOscillator`, though this pack did not pull the literal `PulseOscillator` source file confirming `width` specifically extends `Signal` rather than being a plain JS getter/setter; **flag this specific claim as needing direct source-code confirmation** (check `tone/build/esm/source/oscillator/PulseOscillator.js` for whether `width` is constructed via `new Signal(...)` or a plain property) before relying on it as a modulation destination in your schema.] For `pwm`, there is no `width` property at all — attempting to route a modulation destination named `oscillator.width` at a `pwm`-typed voice has no legal target, and your 19-destination declared set needs to either exclude `pwm` voices from that destination or define what happens (likely: the route silently does nothing, which should be surfaced, not swallowed).

## Sources

- https://tonejs.github.io/docs/13.4.9/OmniOscillator
- https://tonejs.github.io/docs/15.1.22/classes/MonoSynth.html
- https://github.com/tonejs/tone.js/wiki/Sources
