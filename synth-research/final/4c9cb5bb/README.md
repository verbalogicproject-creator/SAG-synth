# SAG-synth v0.1.x → v0.2.0 Research Pack

Index of topic files. Each file is self-contained and independently chunkable.

| File | Question | One-line summary |
|---|---|---|
| q1-limiter-true-peak.md | Q1 | `DynamicsCompressorNode` has no lookahead in the spec's default path and can overshoot; verify with an oversampled/upsampled true-peak measurement on a *single* offline render, not two separate renders — and prefer a WaveShaper hard-clip or a dedicated lookahead limiter for a guaranteed \|x\|≤1 ceiling. |
| q2-modulation-depth-model.md | Q2 | Range-proportional linear depth is not what mature systems do by default; Surge XT/Vital/VCV/VST3 all use per-destination curves (often exponential/log for freq and amplitude) with depth as a *signed* proportion of a curve-mapped range, not raw linear interpolation. |
| q3-route-summing.md | Q3 | Web Audio sums connections to an AudioParam natively (verified); production synths generally *allow* overflow/soft-clamp at the destination rather than auto-normalizing multiple routes, matching analog VCA-summing behavior, but expose a saturation/clip indicator. |
| q4-velocity-source.md | Q4 | A per-voice `ConstantSourceNode` (or Tone equivalent Signal) set atomically at note-on via `setValueAtTime` is the correct construction; the atomicity concern on voice steal is real and needs explicit same-tick param overwrite, not a ramp. |
| q5-per-voice-lfo-phase.md | Q5 | Tone.Transport tick loops and AudioParam automation have very different resolution; naive per-voice phase via JS callbacks will step audibly below ~200-500 Hz update rates. A single oscillator + per-voice DelayNode phase-offset is a known but imperfect trick. Analog polysynth history mostly supports shared/free-running LFOs — retrigger fidelity is a minor perceptual issue, not a must-fix. |
| q6-five-band-eq.md | Q6 | Tone.EQ3 is 3-band only (verified); five-band graphic EQ needs 5 chained BiquadFilterNode 'peaking' filters in series, not parallel-summed, with Q chosen for the target bandwidth-per-octave, and boosted bands do reduce headroom requiring a limiter downstream. |
| q7-oscillator-mapping.md | Q7 | Tone's OmniOscillator model maps `fat*` + count/spread and separate `pulse`/`pwm` types; `width` is only meaningful for `pulse` and is a Tone.Signal (audio-rate-settable) only in that mode, not in `pwm` or basic types. |
| q8-effects-determinism.md | Q8 | Tone.Reverb is non-deterministic at construction (randomized IR) — confirmed; Freeverb, EQ3, Filter, and Compressor/Limiter are deterministic given deterministic input, but comb/allpass-based effects like Freeverb and FeedbackDelay have warm-up/tail dependency across renders if buffer boundaries differ. |
| lp1-transport-lookahead.md | LP1 | Tone.Transport lookahead defaults to ~0.1s ("interactive") to ~larger values, and is independent of context.lookAhead; reconciling a pure allocator with scheduled playback requires the allocator to be called at *schedule time* with the *target* time as input, not at callback-fire time. |
| lp2-touch-audio-android.md | LP2 | `pointerdown` does count as user activation on Chrome for Android per the Autoplay Policy, but resume() promise resolution race conditions and backgrounding-driven context suspension are real, separately-documented traps. |

## Files
- q1-limiter-true-peak.md
- q2-modulation-depth-model.md
- q3-route-summing.md
- q4-velocity-source.md
- q5-per-voice-lfo-phase.md
- q6-five-band-eq.md
- q7-oscillator-mapping.md
- q8-effects-determinism.md
- lp1-transport-lookahead.md
- lp2-touch-audio-android.md
