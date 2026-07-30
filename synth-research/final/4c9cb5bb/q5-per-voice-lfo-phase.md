---
title: "Per-voice LFO phase resolution, CPU cost, and whether it is musically worth the complexity"
topic_id: q5
question: "What timing resolution/CPU cost does a Transport tick loop achieve for modulation writes, and does per-voice LFO phase matter enough to build?"
tags: [tone.js, transport, lfo, per-voice-phase, retrigger, delaynode]
confidence: medium
---

## Direct answer

A `Tone.Transport.scheduleRepeat` / JS-callback-driven tick loop is **not** an audio-rate mechanism — its resolution is bounded by `context.updateInterval` (Tone's clock polling interval) plus `context.lookAhead`, which together define the total scheduling latency, and is documented to be tunable but is fundamentally a JS-thread polling loop, not a sample-accurate audio graph node. [verified — Tone.js Context docs: "context.updateInterval + context.lookAhead gives you the total latency between scheduling an event and hearing it"] This means writing modulation values from a scheduler tick will produce audible stepping at low LFO rates unless the update interval is pushed very small, at real CPU cost, and it will never match the sample-accurate smoothness of a real `AudioParam`/`Tone.LFO` connection.

## What this contradicts

If the implicit assumption behind the "hybrid" plan is that a Transport tick loop can substitute for a real per-voice oscillator with acceptable smoothness at a reasonable update rate, that assumption needs testing before committing — the JS-callback approach is a control-rate mechanism bolted onto an audio-rate problem, and the stepping artifact is not a minor implementation detail, it is the central risk of that whole approach.

## Timing resolution and stepping

- Tone's default context settings historically use a `lookAhead` scheme, with `updateInterval` values on the order of tens of milliseconds by default depending on the `latencyHint` (`"interactive"`, `"playback"`, `"balanced"`) — smaller values reduce latency/stepping at the cost of more frequent JS execution (i.e., higher CPU/battery use, worse on your stated Android/Termux/mobile target). [verified — `latencyHint` documented as a constructor option; `updateInterval`/`lookAhead` documented as the mechanism]
- Because each tick is a JS callback writing a value (likely via `setValueAtTime` for a short future window, or worse, `.value =` direct assignment), the *effective* update rate for the parameter is capped at 1/updateInterval — e.g., a 20ms updateInterval caps modulation writes at 50 Hz, which is below the ~40-64 Hz threshold where humans reliably stop perceiving discrete steps in a slowly varying control signal for many parameters (this specific number is *inferred* by analogy to general control-rate/audio-rate perceptual thresholds in DSP literature; no source in this pack directly measured it for LFO destinations specifically — flag as **inferred**, needs an actual perceptual test in your Chromium/Tone.Offline harness, consistent with your own "measured, not assumed" standard).
- **Recommendation for empirical determination**: since you already have a `Tone.Offline` + headless Chromium measurement harness (per your Measured Findings), the correct way to answer "at what update rate does stepping stop" is to render the same modulation destination at several tick rates (e.g., 20, 50, 100, 200 Hz) and run the same kind of RMS-window or spectral-analysis test you used for tremolo detection, looking for spectral artifacts (aliasing sidebands) at the tick frequency — this is a measurement your own methodology is already equipped to run, and should be done rather than estimated. [inferred methodology, not a sourced number]

## Alternative construction: single oscillator + per-voice phase offset

- **`DelayNode`-based phase offset** is a real, documented technique: connecting one shared oscillator through a per-voice `DelayNode` whose delay time equals `(phaseOffset / (2π)) / lfoFrequency` produces a phase-shifted copy of the same waveform without a second oscillator. This works cleanly for **sine** waves (a delayed sine is still a pure sine) but distorts non-sinusoidal shapes if the LFO frequency changes dynamically, since `DelayNode` delay changes cause pitch-shifting/scrubbing artifacts on the delayed signal if not held constant. [inferred from general Web Audio delay-line theory; not directly sourced for LFO-phase-offset use specifically — mark as **inferred**, verify empirically before relying on it for non-sine shapes]
- **`PeriodicWave`-based per-voice oscillator** (i.e., what you already rejected — one `Tone.LFO`/`OscillatorNode` per voice) remains the only construction with zero fidelity compromise, and its cost is exactly the 128-generator number you already measured — this pack does not find a genuinely free alternative; the DelayNode trick is a partial win (works for sine, adds a delay node not a full oscillator) rather than a full solution for arbitrary retrigger fidelity across all LFO shapes.

## Does per-voice LFO phase matter musically enough to pay for?

**No — this is well-supported historically, and your instinct to check rather than assume is correct.** [reported]

- Classic analog polysynths (Prophet-5, Jupiter-8, and the broader multi-voice analog polysynth generation) predominantly used **one shared LFO circuit distributed to all voices**, precisely because building N independent LFO circuits per voice was itself the expensive, avoided option in analog hardware — this is common knowledge in synthesizer design history repeated across synth-DIY and vintage-synth technical documentation, though this pack did not pull a single canonical citation with a direct quote; treat the general claim as **reported** (widely repeated in the synth-history community) rather than **verified** against a primary schematic source, and note this as a specific gap: if this claim matters enough to build on, verify against an actual service manual (e.g., Prophet-5 or Jupiter-8 service documentation) rather than relying on this pack's secondary characterization.
- The perceptual consequence — shared phase means all voices' modulation is correlated/in lock-step, losing per-note stereo/chorus-like phase spread — is a known, accepted "character" of vintage analog polysynths, not a flaw musicians historically fought to fix; many modern virtual-analog synths intentionally emulate this shared-phase behaviour rather than "fixing" it with per-voice phase, further supporting that per-voice phase is a nice-to-have, not a correctness requirement.
- Given this, your existing decision (report `retrigger` as unimplemented rather than approximate it) is the right call, and the cost/benefit strongly favors **not** building the hybrid scheduler-tick system unless a specific patch design is found where correlated/shared-phase LFOs are audibly and specifically wrong for your use case (e.g., a wide chorus/unison patch where decorrelated phase is the entire point) — in which case the per-voice full-oscillator approach (accepting its generator cost at your actual observed polyphony, not the theoretical 128 max) is more defensible than the scheduler-tick hybrid.

## Sources

- https://tonejs.github.io/docs/14.7.34/Context
- https://github.com/tonejs/tone.js/wiki/Transport
- https://tonejs.github.io/docs/r13/Transport
