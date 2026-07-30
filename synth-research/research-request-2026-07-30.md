# Deep research request — SAG-synth v0.1.x → v0.2.0

Paste the section below to Perplexity (or any deep-research tool). Everything above the
rule is context for us, not part of the prompt.

**Why this exists.** The previous aligned pack (`synth-research/updated/65157ca9/`) was
generated from our own `00_implementation_alignment.md`, so most of it agreed with us —
including one factual error we had written, which came back as if confirmed. This request
is written to reduce that: it states what we have already established so the research does
not re-derive it, and asks explicitly for disagreement where we are wrong.

---

## Prompt

You are producing a technical research pack for **SAG-synth**, a browser synthesizer built
on Tone.js 15.1.22 + Web Audio, with a deterministic, replayable command core. I will give
you the current implementation state, then eight questions. Please answer the questions —
not the general topics they sit in.

### Hard constraints on your output

1. **Do not simply agree with the design below.** A previous research pass was generated
   from our own notes and repeated one of our factual errors back to us as confirmation.
   Where something here is wrong, obsolete, or has a better-known solution, say so
   directly and say what the evidence is. A pack that contradicts us usefully in two
   places is worth more than one that validates us in ten.
2. **Separate fact from inference.** Mark claims as: *verified* (documented behaviour,
   spec text, or source you can point at), *reported* (community consensus, blog, forum),
   or *inferred* (your reasoning). Attribute sources with URLs.
3. **Prefer specifics to architecture advice.** We have the architecture. We need node
   graphs, parameter units, known pitfalls, and measurement methodology.
4. **Web Audio / Tone.js version reality matters.** Tone 15.x. If an API changed between
   major versions, say which version you are describing.

### Deliverable

RAG-ready markdown, **one topic per file**, packed into **`sag-video-final.tar.gz`**.

Each file must be independently chunkable:

- YAML front matter: `title`, `topic_id`, `question`, `tags`, `confidence`
- Self-contained — no "as discussed above" references to other files
- Every code block tagged with its language
- A `## Sources` section at the end with URLs
- A `## What this contradicts` section when it disagrees with the state below

Also include a `README.md` indexing the files and a one-line summary of each answer.

---

## Current implementation state — established, do not re-derive

**Architecture.** Four enforced layers: `core/` (zod only) → `runtime/` (the only place
`tone` may be imported) → `app/` → `clients/` (React). Import purity is checked by a test.
Voice allocation is a pure function in core; the runtime executes its verdict and never
chooses. One command = one journal row = the v0.2 wire format.

**Voice chain.** A manual pool of `Tone.MonoSynth`, built lazily, each wired
`MonoSynth → Gain → Panner → master`. The Gain and Panner exist because `voice.amplitude`
and `voice.pan` are modulation destinations and need audio-rate parameters; MonoSynth
exposes neither (its `volume` is dB, the wrong curve for tremolo).

**Parameter surface.** 97 compile-time parameter addresses in a finite union, each with a
declared `{kind, min, max, unit, choices?}` spec. 36 command verbs. Preset schema
version 2.

**Modulation.** Routing is a first-class document, not a field on the LFO:

```ts
interface ModRoute {
  id: string;
  enabled: boolean;
  source: `lfo.${0|1|2|3}` | 'velocity';
  destination: ParamPath;  // must be one of 19 declared destinations
  depth: number;           // normalised 0..1
}
```

The legal destination set is declared in a schema file (`KIND-synth_mod_route`), each entry
carrying a `per_voice` flag, and a contract test fails if the schema and the code's
parameter specs disagree in either direction. Depth is normalised and scaled at the runtime
by the destination's **own declared range**, so one `depth: 0.5` means the same proportional
travel on a Hz destination and a cents one.

**LFO construction — measured.** One `Tone.LFO` per filled slot, connected to the
corresponding AudioParam on every voice. Generator count tracks slots, not slots ×
polyphony: **1 generator served 8 sounding voices**, flat as polyphony rises, versus 128 at
our declared maxima (4 slots × 32 voices) if each voice owned its phase. Depth scaling lives
on the connection (a `Tone.Gain` per route), not on the generator — setting `lfo.min/max`
per route meant a second route from the same LFO silently overwrote the first's swing.

The cost of shared phase is that `retrigger` cannot be honoured: restarting a shared
generator on note-on restarts it for every sounding voice, which is worse on a held chord
than not retriggering. It is reported as unimplemented rather than approximated.

**Measured findings you can treat as given.**

- Tone.js cannot run in bare Node on our host (Android / Termux / PRoot) — it reaches for
  ALSA and crashes. All audio verification runs in headless chromium via `Tone.Offline`
  with `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage`.
- Tone asserts a source's start time is strictly greater than its previous one. Two events
  on one voice at the same instant throw. We nudge by 0.1 ms per voice.
- Eight MonoSynth voices at velocity 1.0 through a −6 dB master peaked at **1.0122** — real
  clipping, since Web Audio hard-clips at ±1.
- `Tone.Meter` can return **−2105.3 dBFS** from a denormal; `Number.isFinite` passes it.
- A 20 ms RMS window cannot detect tremolo on a C3 (7.6 ms period): an *unmodulated* note
  measured 0.0124 of spread against 0.0177 for a real one. 40 ms separates them.
- Linear depth on a gain destination is perceptually wrong. Depth 0.3 as a ±0.15 linear
  swing is ~2.4 dB peak-to-peak and was reported from the device as inaudible. We changed
  amplitude routes to duck logarithmically: trough = peak − (depth × 60) dB.

---

## The eight questions

### Q1 — `Tone.Limiter` measured a *higher* peak than no limiter (highest priority)

`Tone.Limiter(-1)` on an 8-voice +6 dB overload measured peak **3.3448**, against **3.0972**
for the same material unlimited. Reproducible. `Tone.Limiter` wraps
`DynamicsCompressorNode` — knee and attack, no hard clamp.

We know the likely confounders (lookahead shifting the signal, comparing two separately
rendered buffers, inter-sample vs sample peak). What we need is **method**: how do you
correctly verify limiter behaviour in an offline render? Give a procedure precise enough to
implement — alignment, trimming, window matching, what to assert and with what tolerance.
Then: is `DynamicsCompressorNode` the right node for a master limiter at all, or is a
`WaveShaper` hard-clip stage (or a lookahead limiter built from `Tone.Gain` +
`Tone.Follower`) the standard answer for a guaranteed |x| ≤ 1?

### Q2 — Is range-proportional depth the right modulation model?

Our depth is normalised and scaled by each destination's declared min/max. That gives one
depth semantic across Hz, cents, dB and unit destinations — but we have already found two
places it reads wrong, both fixed by a per-destination curve rather than by the general
rule:

- **amplitude**: base sits at the top of its range, so bipolar modulation wastes half its
  travel going louder than full; and gain is perceived logarithmically
- **filter cutoff**: base 800 Hz in a 20–20000 Hz range means a deep route clamps at the
  bottom, and pitch/brightness are perceived logarithmically too

How do established systems model modulation depth — VCV Rack, Surge XT, Vital, Web Audio
Modules, the CLAP/VST3 parameter+modulation APIs? Specifically: is depth expressed as a
proportion of range, an absolute amount in the destination's unit, or a per-destination
curve? Is the bipolar-about-base model standard, or do they use unipolar with an explicit
polarity switch? Is there a principled general rule, or is per-destination curve choice
simply the accepted design?

### Q3 — Summing multiple routes into one destination

Two routes can name the same destination. In Web Audio, connections to an AudioParam sum,
so two full-depth routes can drive a parameter far outside its declared range. Clamping
happens silently at the node.

What is the standard handling — normalise the sum, clamp with a visible indicator, cap the
route count, or let it overflow as analogue voltage would? What does a modulation matrix
in a production synth do when destinations oversaturate, and what do users expect to hear?

### Q4 — Velocity as a modulation source

Our source union is `lfo.0..3 | velocity`. LFOs are running generators with a node to
connect; velocity is a scalar captured at note-on, with no node. It is currently
unimplemented and reported as such.

What is the correct Web Audio construction for a per-note scalar modulation source feeding
the same routing model as a continuous one? A per-voice `Tone.Signal` set at note-on? A
`ConstantSourceNode` per voice? Something else? Include how it interacts with the voice
being *reused* after a steal, since the value must change atomically with the new note.

### Q5 — Per-voice LFO phase without 128 generators

We chose shared phase and lost `retrigger`. The previously suggested hybrid — Tone LFOs for
global modulation, manual per-voice phase computed in scheduler tick callbacks only for
retriggered voice-local modulation — is the path we would take if retrigger turns out to
matter.

Concretely: what timing resolution does a `Tone.Transport.scheduleRepeat` or
`AudioContext` tick loop actually achieve for writing modulation values, and at what CPU
cost? Does audible stepping appear, and at what update rate does it stop? Is there a third
construction — a single oscillator with per-voice phase offsets via `DelayNode`, wavetable
lookup, or `PeriodicWave` — that gets per-voice phase without per-voice generators?

And the prior question: **does per-voice LFO phase matter musically enough to pay for?**
Analogue polysynths mostly ran free-shared LFOs, which suggests not — we would like that
checked rather than assumed.

### Q6 — Five-band graphic EQ construction and gain staging

We have declared `effects.eq` with five fixed bands (60 / 250 / 1k / 4k / 12k Hz), gain
only, ±18 dB, at the end of the effects chain. Not yet built.

`Tone.EQ3` is three-band. What is the correct five-band construction — chained
`BiquadFilterNode` peaking filters, parallel bands summed, or `Tone.Filter` instances? Give
the Q values that make five bands at those centres sum flat at unity gain, and say what
happens to headroom when several bands are boosted together. Each band gain is also a
modulation destination, so the construction must expose an audio-rate `AudioParam`.

### Q7 — Oscillator unison and pulse width in Tone

Our patch declares `oscillator.type` (sine / triangle / sawtooth / square / pulse / pwm /
noise), plus `count`, `spread`, `width`. The runtime currently maps only the four basic
shapes and falls back to sawtooth for the rest.

Tone encodes oscillator variants as type strings (`fatsawtooth`, `pwm`, `pulse`). Give the
exact mapping from our five parameters onto `Tone.MonoSynth`'s oscillator options: which
combinations are legal, which are silently ignored, how `count`/`spread` interact with the
`fat*` prefix, and whether `width` is settable as an AudioParam (it is a declared
modulation destination for us, so we need to know if it can be modulated at audio rate or
only set).

### Q8 — Which Tone effects are bit-reproducible offline

We know `Tone.Reverb` is not — it generates a randomised impulse response at construction,
which is why we specified Freeverb parameters instead.

We need the inventory: across `Tone.Distortion`, `Chorus`, `FeedbackDelay`, `Freeverb`,
`Limiter`, `Compressor`, `EQ3`, `Filter` — which produce byte-identical output across two
runs in the same environment, which are deterministic-but-warm-up-dependent, and which are
non-deterministic at construction. For each non-deterministic one, say what the source of
variance is and whether it can be seeded or pre-rendered.

---

## Lower priority, include only if the above are well covered

- **Transport with an external allocator.** When v0.2.0 adds `Tone.Transport`, its lookahead
  may schedule notes ahead of the audio clock while our pure allocator expects to decide at
  dispatch time. How large is the lookahead window, and how do you reconcile scheduled
  playback with an allocator that must produce identical verdicts on replay?
- **Multi-touch synth UI on Android Chrome.** We hit two real traps already: `pointerdown`
  is not a user activation for `AudioContext.resume()` on touch, and the promise resolves
  whether or not the browser honoured it. What else is known about latency, pointer capture
  for glissando across keys, and audio interruption on backgrounding?
