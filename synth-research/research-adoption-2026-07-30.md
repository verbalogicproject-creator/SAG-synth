# Adoption note — what the final research pack changes

Read against `synth-research/final/4c9cb5bb/`. Records decisions and actions only; the
reasoning and sources are in the pack.

The instruction to contradict us worked. Four of the ten files argue against something we
had written, and three of those are right.

---

## 1. Q1 is resolved. It was never an anomaly.

**Status change: open question Q1 → closed, with a design consequence.**

We recorded `Tone.Limiter(-1)` measuring peak 3.3448 against 3.0972 unlimited as an
unexplained result blocking Stage 3, and planned to hunt for the root cause. The pack's
answer: this is the **textbook behaviour of a feedforward compressor used as a peak-safety
device**, not a measurement bug. `DynamicsCompressorNode` has knee, attack and release and
no contractual ceiling; a transient arriving faster than the attack passes through before
gain reduction engages. A known Stack Overflow report describes the same effect.

Two things follow, and the second is the one that matters.

**Our assertion tests the wrong invariant.** The fallback we had written down —
*"comparative gate (limited peak < unlimited peak)"* — is not a weaker version of the right
check, it is a check of something a compressor never promised. A compressor converges
toward its threshold over its release time; it is not obliged to reduce every transient.
The correct assertion is against the **ceiling**, not against the unlimited render:

```
truePeak(post) <= ceiling + epsilon        // e.g. ceiling -1 dBFS, epsilon 0.1 dB
```

**And the node cannot deliver that ceiling.** Nothing in the Web Audio spec gives
`DynamicsCompressorNode` a `|x| <= 1` guarantee. The standard answer is two stages: a
musical limiter, then a `WaveShaperNode` hard clip at the ceiling as a safety net. A
WaveShaper with curve `[-1, 0, 1]` is a pure per-sample lookup — zero added latency, no
history-dependent state, so it costs nothing in determinism and needs no new parameter.

**Actions for Stage 3**

- Master chain becomes `voices → mix → Tone.Limiter (musical) → WaveShaper clamp → destination`.
- Assert against the ceiling, never against the unlimited render.
- Measure **true peak** — upsample 4× before taking the max. Sample peak systematically
  under-reads the reconstructed waveform, and comparing a sample peak before a node with a
  sample peak after it is not comparing the same quantity.
- Tap **one** render at two points rather than comparing two separate renders. Two renders
  are not guaranteed sample-aligned if any node carries internal latency, and misalignment
  manufactures exactly the result we saw.
- Diagnose with an impulse first, not the 8-voice material.

## 2. "One depth semantic across all destinations" — walk it back

**Contract change, and it makes the amplitude fix permanent rather than provisional.**

We designed depth as a proportion of each destination's declared linear range, and called
one semantic across Hz, cents, dB and unit destinations the goal. No studied system tries
to achieve that, because it is not perceptually meaningful: 50% of a linear Hz range and
50% of a linear dB range are not the same amount of modulation to a listener.

What VST3, Surge XT and Vital actually do: depth is a normalised 0..1 at the interface, and
**each parameter declares its own curve** for turning that into real travel. Vital gets it
for free by drawing modulation as an arc on a knob whose rotation is already the
parameter's perceptual curve.

So the ad-hoc dB duck we added for tremolo is not a workaround to generalise away later —
it is the standard answer, and should become the reference example.

Eurorack is the instructive counter-case: it applies no curve at the source at all, because
the destination's own transfer function does the work. That is why **cents needs no special
handling** — `detune` is already a log-frequency unit, so linear depth on it is already
perceptually right. Hz cutoff has no such property, which is exactly where we felt it.

**Actions**

- Add a `curve` field to each destination in `KIND-synth_mod_route` §3.2 and mirror it in
  `PARAM_SPECS.modulation` — the same two-sided F72 check covers it for free.
- Curves: `linear` (cents, pan, unit destinations), `db-unipolar-down` (amplitude, already
  implemented), `exponential` (cutoff — depth should mean **octaves**, not Hz).
- Cutoff is currently linear-in-Hz and clamps at the bottom on deep routes. It was reported
  as sounding good, so this is an improvement to schedule, not a defect to rush.

## 3. Route summing — we already do it right

The pack argues against auto-normalising the sum of several routes into one destination,
and no surveyed system does it. Normalising would make one route's effect depend on whether
a sibling is enabled, which fights the determinism model rather than serving it. Overflow
and clamp is standard, expected, and musically useful.

**The gap is visibility, not mechanism.** Do not build a pre-sum layer.

**Action:** compute `sum(depth mapped to destination units)` at authoring time from the
schema and flag when it leaves `[min, max]`. UI only; the signal chain does not change.

Also: our `MAX_ROUTES = 8` cap exists to keep the parameter path union finite, not to limit
patching. That reason still holds and is unaffected.

## 4. Velocity as a source — directly implementable

A per-voice `ConstantSourceNode` (or `Tone.Signal`), whose output equals its `offset` at
every sample. It connects into the existing per-route `Tone.Gain` scaler exactly like an
LFO, so **velocity needs no special case anywhere downstream of the source**.

Two details that would have cost a debugging round:

- `ConstantSourceNode` is an `AudioScheduledSourceNode` — `.start()` throws if called
  twice. Start it once when the voice is built, then re-schedule `offset` per note, the way
  an envelope is re-triggered.
- On a steal, `offset.cancelScheduledValues(t)` then `offset.setValueAtTime(v, t)`. Use the
  scheduling methods, not `.value =` — scheduled writes take precedence over property
  assignment, and a bare assignment can let the previous note's velocity leak into the new
  attack.

## 5. Five-band EQ — build it in series

Five chained `Tone.Filter` instances of type `peaking`, not parallel-summed and not an
extended `EQ3` (which is hardcoded to three crossover bands and cannot be widened).

Two facts that simplify the build:

- `BiquadFilterNode.gain` is already an automatable `AudioParam` in dB for peaking and
  shelf types, so each band gain is a modulation destination **natively** — no Gain wrapper
  like the one `voice.amplitude` needed.
- A peaking filter at 0 dB is an identity filter at any Q. "Five bands sum flat at unity"
  is free and is not a Q-tuning problem; Q only matters once a band is actually boosted.
  Q ≈ 1.0 at our centres, which sit ~2 octaves apart, gives negligible band interaction.

Boosting several bands adds in dB where curves overlap and will clip — which is precisely
what the Q1 WaveShaper safety stage is for. Do not solve headroom inside the EQ.

## 6. The oscillator model does not fit Tone's grammar — and `width` is wrong today

The pack's finding: our parameter model treats `type`, `count`, `spread`, `width` as
orthogonal, and Tone's type-string grammar is not. `count`/`spread` require a `fat*` prefix
and exist only on the four basic shapes; `pulse` and `pwm` are standalone types that cannot
take that prefix; `pwm` has no `width` at all (it has `modulationFrequency`, a different
thing); and **`noise` is not an `OmniOscillator` type** — it is a separate class needing a
structurally different voice path.

So the sawtooth fallback is masking a model mismatch, not a missing `case`.

**Verified here, beyond the pack.** The pack flagged its claim about `width` being
audio-rate as needing source confirmation. Checked
`node_modules/tone/build/esm/source/oscillator/PulseOscillator.js`:

- Line 64 — `this.width = new Signal({...})`. **Audio-rate modulation confirmed.**
- But the semantics do not match ours. Tone's `width` runs **−1..1 with 0 meaning a square
  wave** (50% duty cycle), default `0.2`. Ours is declared `0..1` with default `0.5`.

Two consequences: our range reaches only half of Tone's space, so narrow pulses on one side
are unreachable; and our default of 0.5 is **not neutral** — in Tone's terms it is a 75%
duty cycle, so a patch switching to `pulse` would jump to an off-centre pulse rather than a
square.

This is free to fix right now and expensive later: `pulse` is unmapped, so the value has
never reached the audio graph and no saved patch depends on it. The same "cheapest moment"
argument that justified the Stage 2.5 bump applies.

**Actions**

- Widen `voice.oscillator.width` to −1..1, default 0. Both are contract changes and both
  should land together with the oscillator mapping, not after it.
- Decide per shape which of `count`/`spread`/`width` are legal, and make illegal
  combinations explicit in the wire format so replay is unambiguous — not silently ignored.
- Give `noise` its own voice path or drop it from `SupportedWaveShape`.
- `voice.oscillator.width` is a declared modulation destination but only has a target on
  `pulse`-typed voices. A route to it on any other type must be reported through
  `getUnimplemented()`, the way unwireable destinations already are.

## 7. Effect determinism — two different problems, don't conflate them

`Tone.Reverb` is non-deterministic because of a **one-time random draw at construction**.
`Tone.Chorus` and `Tone.FeedbackDelay` are fully deterministic functions of their input;
what varies is **phase and buffer state alignment** between two renders. Same inputs always
give the same output provided the harness holds LFO start phase, render offset and pre-roll
constant.

That is a much more tractable class, and conflating the two would mean building a seeding
mechanism for effects that need none. Distortion, Limiter, Compressor, EQ3, Filter and
Freeverb are all deterministic.

Caveat the pack states plainly: it could not run a byte-diff, so everything except the
Reverb mechanism is inferred from construction. Worth measuring in Stage 3 rather than
trusting.

---

## Not adopted

- **Per-voice LFO phase** (Q5) stays declined. The pack agrees the perceptual cost is
  minor and that analogue polysynths mostly ran free-shared LFOs. Revisit only if
  `retrigger` is missed in practice.
- **Transport lookahead** (LP1) and **Android touch** (LP2) are v0.2.0 reading, filed
  rather than acted on.

## Correction to a claim in the pack

LP2 says `pointerdown` **does** count as a user activation on Chrome for Android. Our own
device testing found the opposite behaviour badly enough that we rebuilt the unlock flow
around it — `resume()` resolved while the context stayed suspended, and a self-set
`unlocked` flag hid the button permanently. Whatever the spec says, the always-visible
button plus a polled `AudioContext.state` is what actually works on the target device.
Treat the pack's claim as unconfirmed here; `arch/clients.ngf.md` keeps the rule.
