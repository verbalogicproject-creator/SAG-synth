---
title: "How established modular/synth systems model modulation depth — proportional-of-range vs per-destination curve"
topic_id: q2
question: "Is SAG-synth's range-proportional linear depth model the right general rule, or does the industry use per-destination curves?"
tags: [modulation, depth, vcv-rack, surge-xt, vital, vst3, clap, curve-mapping]
confidence: medium
---

## Direct answer

The industry answer is **per-destination curve, not a single general linear rule** — and your own two counterexamples (amplitude, filter cutoff) are exactly the two textbook cases that motivate that design in every mature system examined. Range-proportional *linear* depth is a reasonable normalized-value convention (0..1) for the *host-facing* number, but the *mapping from that normalized number to the actual parameter travel* is expected to be per-parameter and frequently logarithmic/exponential, never a single universal rule. [reported, cross-validated across VST3, VCV Rack, and general modular-synthesis practice]

## What this contradicts

Framing this as "one depth semantic across Hz, cents, dB and unit destinations" being the design target is the part to walk back. A single semantic for the *interface* (0..1 normalized depth, consistent sign convention) is good and matches VST3's approach; a single semantic for the *resulting audible travel* is not something any studied system tries to achieve, because it is not perceptually meaningful — 50% of a linear Hz range and 50% of a linear dB range are not "the same amount of modulation" to a listener, by design.

## How VST3 models it

VST3's parameter+modulation API **forces all parameter and modulation values into a normalized [0,1] range at the host/automation layer**, and pushes the scaling-and-curve responsibility entirely onto the plugin. [reported — KVR forum thread on CLAP, describing the VST3 rationale directly] This is functionally similar to what you already do (normalized `depth: 0..1`), but the crucial detail is: **the curve from normalized to actual parameter units is plugin-defined per-parameter**, not derived from a generic linear min/max scale. A filter-frequency example given in that same discussion is explicit: automating from 20 Hz to 80 Hz is "three out of ten octaves, about 30%" of the normalized range **using a logarithmic mapping** — i.e., the reference implementation for a frequency parameter in VST3 is logarithmic-by-default, not linear-by-default. [reported]

## How VCV Rack / Eurorack-style modulation works

Eurorack-style (and VCV Rack, which models it faithfully) is **not curve-per-destination at all — it's raw CV voltage summed directly onto a linear control input**, with the *musical* result (e.g., 1V/octave pitch CV producing exponential frequency change) coming from the *destination circuit's own transfer function*, not from any depth-curve applied at the modulation source. [reported — VCV Rack module manual describes bipolar/unipolar knob toggling and raw depth-as-attenuation, with the destination doing all the curve work] This maps onto Web Audio surprisingly well: `AudioParam.detune` (cents) is inherently exponential in perceptual pitch already, so linear depth on a `detune` cents-destination is *already* perceptually reasonable without a special curve — cents is a log-frequency unit by construction. This is a case where your "proportional to declared range" rule is fine, because the unit itself (cents) already encodes the correct perceptual curve. Hz-domain filter cutoff destinations do not have this property, which is exactly your Q2 counterexample.

## How Surge XT / Vital handle it

Surge XT and Vital (both widely documented, open-source, commonly cited as reference implementations for modern soft-synth modulation matrices) use a **modulation depth as a signed bipolar amount layered on top of the base value, with the destination parameter's own display/skew curve determining perceptual linearity** — i.e., depth is a proportion, but "proportion of what" is answered per-parameter by that parameter's skew/curve setting, not by raw linear min-max. [reported — Surge XT documentation and VCV Rack XT manual describe per-knob modulation display switching to show inbound modulation depth relative to the knob's own (possibly non-linear) travel] Vital's UI explicitly shows modulation as an arc overlaid on a knob whose rotation is *already* the parameter's perceptual curve (e.g., a log-frequency knob), so depth automatically inherits that curve for free — this is architecturally the cleanest solution and matches "per-destination curve is the accepted design," not an exception to a general rule.

## Bipolar-about-base vs unipolar-with-polarity-switch

Both conventions are standard and coexist even within single synths:

- **Bipolar-about-base** (your current model) is standard for LFO-style continuous sources where "back and forth around the current setting" is the natural mental model — this is the default in VCV Rack's stock LFO and in most subtractive synth filter/pitch LFO routings. [reported]
- **Unipolar with explicit polarity toggle** is common specifically because bipolar-about-base wastes half the travel when the base sits near an end of a *perceptually asymmetric* destination — VCV Rack's own LFO module documentation calls out an explicit "offset" button specifically to switch between these two modes, which is direct evidence that neither is universally correct and systems expose the choice rather than picking one. [reported — VCV Rack LFO manual, "click the offset button to enable bipolar modulation" implies unipolar is the non-offset default]

## Concrete recommendation for your two known-bad cases

- **Amplitude**: switch to a curve where depth expresses **dB of travel below the base**, unipolar-down by default (matches what you already implemented ad hoc: "trough = peak − depth×60 dB"). This is not a workaround, it is the standard answer — do not treat it as a special case to eventually generalize away; keep it as a permanent per-destination curve, and consider making it the reference example for how future gain-like destinations should be declared.
- **Filter cutoff**: switch cutoff-Hz destinations to an **exponential/log mapping** (e.g., depth maps to octave travel rather than raw Hz travel), matching the VST3 20→80 Hz example above and standard subtractive-synth filter LFO behavior, where "filter LFO depth" is near-universally expressed and perceived in octaves, not Hz.
- **General rule**: adopt "depth is a normalized 0..1 (or -1..1) value; each destination's schema entry declares its own curve (linear, log/exponential, or dB-unipolar) used to convert that normalized value into actual parameter travel" — this is consistent with VST3's model and is very close to a one-line change to your existing `ParamPath`/destination schema (add a `curve` field alongside `{kind, min, max, unit}`).

## Sources

- https://www.kvraudio.com/forum/viewtopic.php?t=574861&start=165
- https://surge-synthesizer.github.io/rack_xt_manual/
- https://publish.obsidian.md/arendleejessurun/Atlas/Musicianship/Synthesis/How+to+modulate+parameters+in+VCV+Rack
- https://surge-synthesizer.github.io/manual-xt/
