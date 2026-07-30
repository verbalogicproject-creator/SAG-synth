---
title: "Five-band graphic EQ construction in Tone.js/Web Audio — node topology, Q values, and headroom"
topic_id: q6
question: "What is the correct 5-band construction (60/250/1k/4k/12k Hz, gain-only, ±18dB), and what happens to headroom when bands are boosted together?"
tags: [web-audio, tone.js, biquadfilternode, graphic-eq, headroom, peaking-filter]
confidence: high
---

## Direct answer

Use **five chained (series) `BiquadFilterNode` instances, each type `"peaking"`**, one per declared band, connected `input → band1 → band2 → band3 → band4 → band5 → output`. Do **not** use parallel-summed bands (that requires careful gain compensation to avoid a comb-filtered sum at the crossover regions and is the harder, non-standard approach); do **not** try to force `Tone.EQ3` to five bands — it is hardcoded to three (low/mid/high with crossover frequencies), not extensible to five. [verified — Tone.js EQ3 docs describe exactly "low, mid, and high gain as well as the low and high crossover frequencies," a fixed 3-band shelf/crossover design incompatible with 5 independent peaking bands]

## What this contradicts

If there was any assumption that `Tone.EQ3` could be parameterized up to 5 bands, or that parallel band-summing is the standard graphic-EQ topology, both are wrong — chained peaking filters in series is the textbook, universally-used graphic EQ topology (this is literally how every hardware and software graphic EQ works), and `Tone.EQ3` is architecturally a different, fixed-band-count design that cannot be extended.

## Node construction

```js
const bands = [60, 250, 1000, 4000, 12000].map(freq => {
  const filter = new Tone.Filter({
    type: "peaking",
    frequency: freq,
    Q: 1.0, // see Q-value discussion below
    gain: 0 // dB, modulation-destination AudioParam
  });
  return filter;
});
bands.reduce((prev, curr) => prev.connect(curr), input);
bands[bands.length - 1].connect(output);
```

`Tone.Filter` wraps a native `BiquadFilterNode` and exposes `.gain` as a `Tone.Param` (i.e., a `Tone.Signal`-backed wrapper around the underlying `AudioParam`), which satisfies your requirement that each band's gain be an audio-rate modulation destination — the native `BiquadFilterNode.gain` **is** an `AudioParam` per spec, so this requirement is met natively, no extra Gain-node wrapper needed (unlike your MonoSynth volume/amplitude case, `BiquadFilterNode.gain` for `"peaking"`/`"lowshelf"`/`"highshelf"` types is already declared in the Web Audio spec as an automatable `AudioParam` in dB). [verified — Web Audio EQ Cookbook and BiquadFilterNode spec: peaking/shelf filter types define `.gain` as a live parameter]

## Q values for five bands to sum flat at unity gain (all gains = 0 dB)

When every band's gain is 0 dB, a peaking filter is an identity filter regardless of Q — **any Q value produces a flat, unity response when gain=0**, because a peaking EQ's transfer function reduces to 1 at all frequencies when the boost/cut amount is zero. [verified — this follows directly from the standard peaking-filter biquad formula in the Audio EQ Cookbook: the filter coefficients collapse to an all-pass-at-unity-gain identity when the gain parameter A=1 (0 dB)] So "sum flat at unity gain" is guaranteed by the peaking-filter type itself and is not a Q-tuning problem — the actual design decision is about **bandwidth/overlap when bands are actually boosted or cut**, not about the neutral state.

For actual musical/graphic-EQ Q at these five centre frequencies with reasonably even octave spacing (60→250 is ~2 octaves, 250→1k is 2 octaves, 1k→4k is 2 octaves, 4k→12k is ~1.6 octaves), a **Q around 0.7–1.4** per band (equivalent to roughly 1–1.5 octave bandwidth) is the standard graphic-EQ convention, matching the bandwidth-per-octave the ISO 31-band/graphic-EQ tradition uses scaled down to 5 widely-spaced bands. [reported — general audio engineering convention for wide-band graphic EQs; the widely-cited Audio EQ Cookbook gives the Q-to-bandwidth conversion formula `BW = 2*asinh(1/(2Q))/ln(2)` octaves, letting you pick Q from a target bandwidth directly] Because your bands are far apart in frequency (each roughly 2 octaves apart), moderate Q values around 1.0 will not cause significant band-to-band interaction even under boost, which is the main practical benefit of choosing these particular five centre frequencies.

## Headroom when several bands are boosted together

Boosting multiple bands **is additive in dB at frequencies where their curves overlap**, and even at frequencies where they don't overlap much, the *broadband RMS/peak level* of the overall signal rises roughly in proportion to total boost energy — a full ±18dB range on 5 bands means a worst case of summing multiple +18dB boosts in an overlapping region, which will clip badly without downstream gain staging. [inferred, directly follows from linear superposition of biquad filter responses in series — verified property of cascaded LTI filters] Practically: reserve headroom downstream (this is exactly why a limiter/WaveShaper stage at the end of your effects chain, as discussed in Q1, matters — the EQ is a legitimate, expected source of the kind of peak overshoot that stage needs to catch), and consider **either an automatic makeup-gain reduction proportional to total positive boost across bands, or simply relying on your master limiter/clip stage** rather than trying to solve headroom inside the EQ itself. The former is more transparent to the user; the latter is simpler and consistent with treating your Q1 safety-clamp as the general answer to "something in the chain pushed a sample over ceiling."

## Sources

- https://tonejs.github.io/docs/r13/EQ3
- https://webaudio.github.io/Audio-EQ-Cookbook/audio-eq-cookbook.html
- https://gist.github.com/endolith/5455375
- https://developer.mozilla.org/en-US/docs/Web/API/BiquadFilterNode
