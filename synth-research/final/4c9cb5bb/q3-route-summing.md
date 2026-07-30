---
title: "Handling multiple modulation routes summing into one AudioParam destination"
topic_id: q3
question: "What is standard handling when two full-depth routes drive the same destination beyond its declared range?"
tags: [web-audio, audioparam, modulation-matrix, summing, clamping]
confidence: medium
---

## Direct answer

Web Audio's native behaviour — **connections to an AudioParam sum additively**, and the resulting computed value is then clamped silently by the node/param's internal min/max at render time — is *verified* spec behaviour, not a bug you introduced. [verified — W3C Web Audio API spec: "If an AudioParam has any AudioNodes connected... the current value is used as an input, and the actual computedValue at each time is the sum..."] Given that, the accepted answer in production modulation matrices is closer to **"let it overflow, then clamp visibly at the destination"** than to auto-normalizing the sum — this matches both the analog-voltage mental model your Q3 already gestures at, and what mainstream soft-synth mod matrices actually do.

## What this contradicts

If SAG-synth's current implicit behaviour is "clamp happens silently at the node" with no indicator, that's the one part to fix — not the summing-and-clamping model itself, which is correct and standard. The gap is *visibility*, not *mechanism*.

## Evidence from production systems

- **Modular/Eurorack convention (VCV Rack)**: CV signals summed onto one input are expected to add, and going out of a destination's usable range is an accepted, common, and often creatively exploited outcome — the destination circuit (e.g., a VCO's exponential converter) just does whatever it does with an out-of-range voltage, up to its own physical limits. [reported — this is universal modular-synthesis practice, corroborated by VCV Rack documentation describing modulation as raw signal addition with no matrix-level renormalization]
- **VST3 / CLAP parameter+modulation model**: because both push all modulation into a normalized [0,1] parameter domain and the *host* or *plugin* clamps at that boundary, "sum then clamp at the edge, silently, per render block" is the de facto standard — it is what a normalized clamp naturally does, and neither spec defines an alternative auto-normalization step across multiple modulation sources targeting one parameter. [reported/inferred from the VST3 discussion in the CLAP forum thread, where normalization strategy is discussed purely in terms of single-parameter clamping, not cross-route rebalancing]
- **No major system auto-normalizes the sum of multiple routes.** Auto-normalization (e.g., dividing depth by the number of active routes on a destination) is not documented as standard behaviour anywhere surveyed; it would also break determinism/expectations when a route is toggled on/off, since every other route's effective depth would silently change — which is a much worse ergonomic and predictability problem than clipping. [inferred, but strongly supported by absence of any counter-example across all sources reviewed]

## What users expect to hear

Users of modular and mod-matrix synths broadly expect **clipping/limiting at the destination, not automatic rebalancing** — turning up two LFOs on the same filter cutoff and hearing the filter "run out of room" (get stuck at max/min for part of the cycle) is a known, accepted, even musically useful artifact in Eurorack-style patching, not treated as a bug. [reported — general modular-synthesis practice]

## Concrete recommendation for SAG-synth

1. Sum routes exactly as Web Audio already does at the AudioParam (no change needed to the underlying mechanism — do not build a software pre-sum/renormalize layer, since that adds a source of nondeterminism-adjacent complexity, i.e., a route's effect changing depending on sibling route state, which fights your "one command = one journal row" determinism goal rather than serving it).
2. Add a **visible overflow indicator** in the UI/journal — since you already declare each destination's range in the schema, compute `sum(route depths mapped to destination units)` at authoring/preview time and flag when it exceeds `[min, max]`, without changing runtime audio behaviour. This satisfies "clamp with a visible indicator" without touching the deterministic signal chain.
3. Do **not** cap route count. There is no evidence any studied system limits the number of routes per destination; capping would remove a legitimate (if extreme) patching pattern for no documented benefit.

## Sources

- https://www.w3.org/TR/webaudio-1.1/
- https://www.kvraudio.com/forum/viewtopic.php?t=574861&start=165
- https://surge-synthesizer.github.io/rack_xt_manual/
- https://publish.obsidian.md/arendleejessurun/Atlas/Musicianship/Synthesis/How+to+modulate+parameters+in+VCV+Rack
