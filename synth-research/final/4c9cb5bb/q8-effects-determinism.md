---
title: "Determinism inventory across Tone.js effects for bit-reproducible offline rendering"
topic_id: q8
question: "Which of Distortion, Chorus, FeedbackDelay, Freeverb, Limiter, Compressor, EQ3, Filter are byte-identical across two offline runs?"
tags: [tone.js, determinism, offline-rendering, reverb, chorus, distortion]
confidence: medium
---

## Direct answer

Your established finding — `Tone.Reverb` is non-deterministic at construction because it generates a randomized impulse response — is **verified** and correctly reasoned; the mechanism is confirmed. Of the remaining eight effects, the honest classification, based on documented construction behaviour (this pack could not execute a byte-diff test itself, so per-effect claims below are **inferred from documented construction mechanics**, not measured, except where explicitly noted) is:

| Effect | Deterministic given identical input? | Source of any variance |
|---|---|---|
| `Tone.Reverb` | **No** — confirmed non-deterministic | Randomized impulse response generated at construction time [verified per your own established finding, and consistent with Freeverb-vs-Reverb distinction discussed in Tone.js docs/community] |
| `Tone.Freeverb` | **Yes**, deterministic | Freeverb is a fixed comb/allpass-filter network (the classic Schroeder/Jezar Freeverb algorithm) with no randomization step — it is parameterized entirely by `roomSize`, `dampening`, deterministic feedback coefficients [reported — Tone.js Freeverb docs describe only deterministic parameters: `.dampening`, no randomization mentioned; this is consistent with your own stated reason for choosing Freeverb over Reverb] |
| `Tone.Distortion` | **Yes**, deterministic | Implemented via `WaveShaperNode` with a curve computed from a fixed formula (`distortion` amount), no random seed involved [inferred from general Tone.js Effect architecture — WaveShaper-based effects use a pure-function curve generator] |
| `Tone.Chorus` | **Yes, but warm-up-dependent** | Built from LFO-modulated delay lines; deterministic given a fixed LFO phase at start, but its *audible* output depends on how much time has elapsed since the LFO/delay were started, so truncating/comparing two renders that start the LFO at different relative offsets (or that are not phase-aligned to context time zero) will show differences that are **not due to randomness but due to phase-alignment sensitivity** — this is the "deterministic-but-warm-up-dependent" category your question anticipates [inferred from Chorus's LFO+delay architecture, a very well-established pattern in Tone.js effect construction] |
| `Tone.FeedbackDelay` | **Yes, but warm-up/tail-dependent** | Feedback delay lines carry state (the delay buffer) across the render; two renders will be byte-identical only if both start from an identically-initialized (silent) delay buffer and run for the same duration relative to note-on — comparing different-length renders or renders with different pre-roll will show tail differences that are an artifact of buffer state, not nondeterminism [inferred from standard delay-line-with-feedback architecture] |
| `Tone.Limiter` | **Yes**, deterministic | Wraps `DynamicsCompressorNode`, a pure feedforward function of input signal and fixed parameters (threshold/knee/ratio/attack/release) with no random state [verified — W3C spec defines DynamicsCompressorNode purely in terms of its parameters and input signal, no randomization] |
| `Tone.Compressor` | **Yes**, deterministic | Same underlying node (`DynamicsCompressorNode`) as Limiter, same reasoning [verified, same basis as Limiter row] |
| `Tone.EQ3` | **Yes**, deterministic | Built from `BiquadFilterNode`s (via crossover filters) with parameters fully determined by frequency/gain settings, no randomization [verified — BiquadFilterNode is a pure deterministic IIR filter per spec] |
| `Tone.Filter` | **Yes**, deterministic | Direct `BiquadFilterNode` wrapper, same reasoning as EQ3 [verified] |

## What this contradicts

If there was any assumption that determinism issues might extend broadly across "any effect with an LFO or feedback path," that's worth refining: **Chorus and FeedbackDelay are not non-deterministic in the same sense Reverb is.** Reverb's problem is a **one-time random draw at construction** (a genuinely different, unseeded output every run). Chorus/FeedbackDelay's problem, if any appears in your test harness, will be a **phase/state-alignment artifact** — same inputs will always produce the same output, but only if the harness holds every timing relationship (LFO start phase, render start offset, buffer pre-fill) constant across the two runs being compared. This is a much more tractable, controllable class of nondeterminism than Reverb's, and conflating them would lead to over-engineering a seeding solution for effects that don't need one.

## Can Reverb's variance be seeded or pre-rendered?

Not via any documented public API — `Tone.Reverb`'s impulse-response generation is internal and not exposed as a seedable RNG parameter in the standard API surface reviewed. [inferred from absence of any seed/random-source parameter in the Tone.Reverb constructor options documented] The practical, and your own already-chosen, mitigation is exactly what you did: **avoid `Tone.Reverb` for anything requiring replay determinism, and use `Tone.Freeverb`** (or a convolution reverb fed by a *fixed, pre-rendered/loaded* impulse response file rather than Tone's randomized generator, if a convolution-quality reverb tail is eventually wanted) — pre-rendering a static IR asset once and loading it deterministically at runtime is the standard way studios/apps get convolution-reverb quality without introducing per-run randomness.

## Sources

- https://tonejs.github.io/docs/14.9.17/classes/Reverb.html
- https://tonejs.github.io/docs/14.7.58/Freeverb
- https://stackoverflow.com/questions/71596155/how-to-modify-effect-options-in-tone-js
- https://developer.mozilla.org/en-US/docs/Web/API/DynamicsCompressorNode
- https://tonejs.github.io/docs/r13/EQ3
