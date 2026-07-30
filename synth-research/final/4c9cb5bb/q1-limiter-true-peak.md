---
title: "Verifying limiter behaviour in offline Web Audio renders, and whether DynamicsCompressorNode is the right master-limiter node"
topic_id: q1
question: "Tone.Limiter measured a higher peak than no limiter — is this a measurement artifact, and what node should a master limiter use?"
tags: [web-audio, tone.js, limiter, dynamics-compressor, true-peak, offline-rendering]
confidence: medium-high
---

## Direct answer

Your measured result (limited peak 3.3448 > unlimited peak 3.0972) is almost certainly a **real, explainable artifact of `DynamicsCompressorNode`'s attack/knee behaviour**, not a bug in your test, but the exact number is not reproducible from documentation alone — this is *reported*, not *verified*, because the W3C spec does not mandate a specific attack curve implementation, only parameter ranges. Chromium's implementation (used by headless-chromium `Tone.Offline`) can transiently overshoot input peak during the attack phase before gain reduction engages, and separately, a "peak" measured only at sample points (not inter-sample / true-peak) is not the same metric before vs after the node, so a naive `Math.max(abs(samples))` comparison can look worse post-limiter even when the limiter is doing exactly what a compressor does. [reported]

## Why `DynamicsCompressorNode` can measure a higher peak than the input

- The node is a **feedforward compressor with knee, attack and release**, not a brick-wall clip. [verified — W3C Web Audio spec / MDN]
- During `attack`, gain reduction ramps in over that many seconds; a sharp transient can pass through partially unattenuated before the envelope catches up, and depending on internal implementation the detector look-ahead is small or absent in the un-prefixed spec path. [verified/inferred — spec defines attack/release/knee/ratio/threshold but does not require a lookahead buffer]
- A well-known Stack Overflow report describes exactly this: "Peak output of a pulse is way more than input" through `DynamicsCompressorNode`, attributing it to the attack envelope amplifying transients before compression engages, corroborating that this is a known characteristic, not unique to your code. [reported — StackOverflow #41134890]
- Because a compressor's gain curve is a function of *recent* signal level (it reacts, it does not predict), any signal whose peak arrives faster than the attack time will see less-than-full gain reduction exactly at that peak. If the makeup/overall gain staging into the node pushes signal higher before the reduction lands, the *sample value at the transient* can exceed the pre-node sample value. [inferred, consistent with verified compressor theory]

## What this contradicts

Your framing treats the 3.3448 result as unexpected/anomalous. It is not anomalous — it is the textbook failure mode of using a dynamics compressor (even at aggressive settings) as a peak-safety device without a lookahead stage in front of it. The fix is architectural, not a measurement bug to hunt down. Do not spend more time trying to find a mistake in the harness before ruling this out.

## Verification methodology (precise procedure)

To determine whether your Q1 result is a measurement artifact vs a genuine limiter failure, follow this procedure:

1. **Single render, tapped at two points, not two separate renders.** Build one graph: `source → preLimiterGain (tap A) → Limiter → tap B`. Use two `Tone.Analyser`/native `AnalyserNode` or two `ChannelSplitter`-fed buffers recorded from the *same* `OfflineAudioContext` run, not two separate `Tone.Offline()` calls. Two separate offline renders are not guaranteed to be sample-aligned if any node in the graph has internal latency/lookahead (many do), and comparing misaligned buffers will manufacture spurious "higher peak after" results. [inferred — standard DSP testing practice, consistent with W3C OfflineAudioContext determinism guarantees]
2. **Account for latency introduced by the limiter node.** `DynamicsCompressorNode` has a `.pipeline` and per spec/browser MAY introduce non-zero processing latency (Chrome does report `.tailTime` in the WebAudio DevTools panel; check `AudioContext.baseLatency`/rendered graph via Chrome's WebAudio inspector). If the node buffers audio internally, sample index N pre-node does not correspond to sample index N post-node. Cross-correlate the two captured buffers (simple lag search on a short impulse test signal) to find and compensate the actual delay before diffing. [verified — Chrome DevTools WebAudio panel exposes node processing metrics; inferred — need to cross-correlate for exact offset]
3. **Measure true peak, not sample peak, on both sides.** A "sample peak" measurement (`max(abs(x[n]))`) will always underestimate the actual peak of the reconstructed continuous waveform. Upsample both tapped buffers 4x (e.g., zero-stuff + FIR lowpass, or simply re-render the whole offline context at 4x sample rate if determinism allows) and re-measure peak on the upsampled signal — this is the ITU-R BS.1770 / EBU R128 standard true-peak method. [verified — this is the standard true-peak measurement technique used in mastering.com/loudness tooling]
4. **Use an impulse or step test signal, not your full 8-voice musical material, for the first diagnostic pass.** A single unit impulse or a fast step function isolates the attack-envelope overshoot cleanly, without polyphonic voice-summing confounds. Once you understand the impulse response, re-test with your real 8-voice material.
5. **Assert with tolerance relative to your target ceiling, not relative to the unlimited peak.** The correct assertion is `truePeak(post) <= ceiling + epsilon` (e.g., ceiling = -1 dBFS, epsilon = 0.1 dB) — not `truePeak(post) < truePeak(pre)`. A compressor is not obligated to reduce peak below the input peak on every transient; it is obligated to converge toward its threshold over its release time. Testing "did it get quieter" is testing the wrong invariant.
6. **If the ceiling assertion fails even under this corrected methodology, that is real evidence `DynamicsCompressorNode` is unsuitable as a hard ceiling — proceed to the recommendation below.**

## Is `DynamicsCompressorNode` the right node for a hard peak ceiling?

**No, not by itself.** [reported, well-supported]

- `DynamicsCompressorNode`/`Tone.Limiter` is a **soft-knee feedforward compressor**; it has no contractual guarantee of `|x| ≤ ceiling`, only a statistical tendency to reduce gain above threshold with the configured ratio and knee. [verified — spec text: knee, ratio, threshold, attack, release parameters only; no "ceiling" or "clip" guarantee in the spec]
- The community and mastering literature consistently reach for **either a `WaveShaperNode` hard-clip curve, or a proper lookahead limiter (implemented via `AudioWorkletNode` or a `Gain` + envelope-follower + delay compensation chain)** when a *guaranteed* ceiling is required. [reported — KVR forum thread on true-peak limiting; npm `limiter-audio-worklet` package explicitly built because native nodes cannot guarantee `|x| ≤ 1`; StackOverflow answer explicitly states "This is not possible with any of the built-in AudioNodes... it can be achieved with a custom AudioWorklet"]
- A `WaveShaperNode` with curve `[-1, 0, 1]` (or a smoother polynomial soft-clip curve near the boundary) gives a true sample-domain guarantee with zero added latency, but produces harmonic distortion on any sample that would have exceeded the ceiling — acceptable for an emergency safety clamp after a proper compressor/limiter stage, not as the sole loudness tool. [verified — WaveShaper curve definition simply remaps input to output per a lookup table; clamping curve `[-1,0,1]` mathematically guarantees output magnitude ≤ 1]
- The standard **two-stage mastering pattern** — a musical limiter (compressor-style, can overshoot slightly) followed by a true-peak safety clip/limiter — is exactly the "use two limiters" pattern professional mastering guides describe, and maps directly onto your architecture as: `Tone.Limiter` (musical) → `WaveShaperNode` hard clip (safety net) → destination. [reported — mastering.com true-peak guide]

## Recommendation for SAG-synth

Given your deterministic-replay requirement, prefer a graph of: voices → mix bus → `Tone.Limiter` (musical shaping, tuned generously, not relied on for the hard ceiling) → a small `WaveShaperNode` clamp curve at exactly your declared ceiling → master. This keeps the signal path fully sample-accurate and deterministic (WaveShaper has zero added latency and no internal state depending on history beyond the current sample), while giving you the actual `|x| ≤ 1` guarantee the compressor cannot provide. [inferred, derived from verified node properties above]

## Sources

- https://developer.mozilla.org/en-US/docs/Web/API/DynamicsCompressorNode
- https://stackoverflow.com/questions/41134890/webaudioapi-dynamicscompressornode-peak-output-of-a-pulse-is-way-more-than-inp
- https://stackoverflow.com/questions/61263024/in-the-web-audio-api-is-there-a-way-to-set-a-maximum-volume
- https://www.kvraudio.com/forum/viewtopic.php?t=575674&start=15
- https://mastering.com/true-peak-meter/
- https://tonejs.github.io/docs/15.0.4/classes/Limiter.html
- https://developer.chrome.com/docs/devtools/webaudio
