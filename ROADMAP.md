# SAG-synth roadmap — 0.1.10 → 0.2.0

Written 2026-07-30, revised the same day at commit `81a81bb`. Every number here was read
from the repo, not recalled; where something is unverified it says so.

---

## Where we actually are

**Version 0.1.10 — the engine is complete.** 310 tests across three projects. Build clean.
Preset schema version 2, framework KINDs at tag `v0.0.6`.

**All 97 declared parameter addresses reach the audio graph.** `UNMAPPED_PARAMS` is empty
and three tests keep it honest. The signal path:

```
voice(MonoSynth -> Gain -> Panner) -> fxInput
  -> distortion -> chorus -> delay -> reverb -> eq x5
  -> master -> limiter -> safety clip -> destination
```

**Playable today**: multi-touch keys with velocity, the full oscillator (unison, pulse
width, detune), both envelopes, the filter, four LFOs routing to five destinations,
velocity as a routing source, polyphony with stealing, the effects chain, the five-band EQ,
and a master stage that cannot exceed full scale. Undo, redo and journal replay across all
of it, plus live audio telemetry from the device.

**What is left is not engine work.** Song playback — tracks, tempo, the step grid — needs
`Tone.Transport`, which is v0.3.0. That is what `applySong.transport` reports.

### What the versions mean

The original plan said "ship v0.1.0 after Stage 4", and increments got bumped along the way
until the number and the plan disagreed. Settled as:

- **0.1.x** — the throwaway debug surface over a growing engine.
- **0.1.9+** — feature-complete engine, still on the debug surface. **Here, at 0.1.10.**

  0.1.9 was labelled "the last 0.1" when it shipped. That was a prediction and it did not
  hold: three separate EQ reports followed, each a genuinely different cause — a command
  refused at validation, bands measured under conditions no real patch has, and centres
  that left two of five controls inert. All three were found by playing the thing, none by
  reading it. The number keeps moving until the design stage starts; calling one of them
  final was the mistake, not the work that followed it.
- **0.2.0** — the designed instrument. Not a bump for its own sake: the release where the
  surface a player touches was designed rather than accreted.

Sequencer, transport and the agent SDK were originally also 0.2.0. They are now **0.3.0** —
reasoning at the end.

### Stages 2c–3, completed

| Stage | What it closed | Cost |
|---|---|---|
| **2c** oscillator | unison, pulse width, base detune; the `width` range corrected to Tone's −1..1 | found `detune` nested where MonoSynth overwrites it — it typechecked and left the pitch unmoved |
| **2d** velocity | `toAmplitude`, `toFilterOctaves`, velocity as a routing source | found the touch keyboard sending a hardcoded 0.8, making the whole section unhearable on-device |
| **2e** polyphony | stealing end to end, driven through the dispatcher | found two of my own gates weaker than their comments |
| **2f** telemetry | live audio observation from the device | its first run found the synth working and itself broken three ways |
| **3** effects | the chain, the EQ, the master stage, Q1 closed | found voices connected past the entire chain, and `'eq'` missing from the validator's enum |

Every one of those was found by a gate or by an ear check, not by reading the code.

---

## Stage 2c — oscillator mapping · *done*

Closes the largest unmapped group and carries two contract corrections that are free now
and expensive later.

Tone's `OmniOscillator` type-string grammar is **not orthogonal** to our four-parameter
model, which is what the sawtooth fallback has been hiding:

- `count`/`spread` require a `fat*` prefix and exist only on the four basic shapes
- `pulse` and `pwm` are standalone types that cannot take that prefix
- `pwm` has no `width` at all — it has `modulationFrequency`, a different parameter
- `noise` is not an `OmniOscillator` type; it needs a structurally different voice path

**Contract corrections, to land with the mapping and not after it:**

- `voice.oscillator.width` is declared `0..1` default `0.5`. Tone's is **`-1..1` with `0`
  meaning square**, default `0.2`. Half the range is unreachable and our default is a 75%
  duty cycle wearing the costume of a neutral one. Verified in
  `node_modules/tone/build/esm/source/oscillator/PulseOscillator.js` — `width` is a
  `Signal` (line 64), so it is genuinely audio-rate modulatable, on `pulse` only.
- Per shape, decide which of `count`/`spread`/`width` are legal and make illegal
  combinations **explicit in the wire format**, not silently ignored — replay has to be
  unambiguous about what a patch meant.
- Either give `noise` its own voice path or remove it from `SupportedWaveShape`.

**Gates**: spectrum of a `fat*` type differs from the plain type; pulse width changes the
harmonic series; a route to `voice.oscillator.width` on a non-pulse voice is reported
through `getUnimplemented()` rather than swallowed. Negative probe on each.

## Stage 2d — velocity response · *done*

Velocity already sounds — it is passed to `triggerAttack` and MonoSynth scales the amp
envelope. What is unread is the patch's control over *how much*.

Also completes the routing source union. `velocity` is currently declared and reported
unimplemented; the construction is settled: a **per-voice `ConstantSourceNode`**, whose
output equals its `offset` at every sample, connecting into the existing per-route scaler
exactly like an LFO — no special case downstream.

Two details that would otherwise cost a debugging round:

- It is an `AudioScheduledSourceNode`; `.start()` throws if called twice. Start once when
  the voice is built, then re-schedule `offset` per note.
- On a steal, `cancelScheduledValues(t)` then `setValueAtTime(v, t)`. Scheduled writes take
  precedence over `.value =`, and a bare assignment lets the previous note's velocity leak
  into the new attack.

**Gates**: `rms` scales with velocity and stops scaling at `toAmplitude: 0`; brightness
scales with `toFilterOctaves`; a stolen voice sounds the new note's velocity, not the old.

## Stage 2e — polyphony and stealing, end to end · *done*

The allocator is pure, tested and green in core. What is untested is the whole path under
overload: dispatch → allocate → steal → runtime, sounding.

**Gate**: onset count matches expected voices when more notes arrive than `polyphony`
allows, and the stolen voice is the one core nominated.

## Stage 3 — effects chain, EQ, and the master stage · *done*

The largest unmapped group: 20 addresses, none of which touch the graph today.

**Chain**: `distortion → chorus → delay → reverb → eq → master`, the order already declared
in `EFFECT_CHAIN_ORDER`.

**EQ**: five chained `Tone.Filter` instances of type `peaking` at 60 / 250 / 1k / 4k / 12k.
Not parallel-summed, and not an extended `EQ3` — that is hardcoded to three crossover bands.
`BiquadFilterNode.gain` is already an automatable `AudioParam` in dB, so each band gain is
a modulation destination natively, with none of the wrapper work `voice.amplitude` needed.
A peaking filter at 0 dB is identity at any Q, so "sums flat at unity" is free; Q ≈ 1.0
suits centres ~2 octaves apart.

**Master, and the resolution of Q1.** The limiter question is closed: `Tone.Limiter`
measuring a higher peak than no limiter is the textbook behaviour of a feedforward
compressor used as a peak-safety device, not an anomaly. Our test was wrong twice — it
compared two separately-rendered buffers, which are not sample-aligned when a node carries
internal latency, and it asserted "did the peak drop", which a compressor never promised.

No Web Audio node gives `|x| <= 1` by contract, so:

```
voices → mix → Tone.Limiter (musical) → WaveShaper hard clip → destination
```

The clip is a per-sample lookup: no latency, no state, nothing that costs determinism, and
no new parameter. It also absorbs the headroom that several boosted EQ bands will produce —
do not try to solve that inside the EQ.

**Gate discipline changes here.** Assert against the **ceiling**, on a **true-peak**
(4× upsampled) measurement, tapped at two points of **one** render. Diagnose with an impulse
before the 8-voice material. `STAGE1_MASTER_VOLUME_DB` retires and `master.volume` becomes
real.

Effects split by how far they can be gated: distortion, Freeverb, EQ and filter are
deterministic; chorus and feedback delay are deterministic but sensitive to phase and
buffer-state alignment between renders — a different and far more tractable problem than
`Tone.Reverb`'s construction randomness, and worth **measuring** rather than assuming,
since the research inferred it without running a byte-diff.

**Stage 3 green is the design stage's trigger.**

## Stage 3.5 — the modulation curve bump · *next*

Small, and it should land before the designed UI draws a depth control.

"One depth semantic across every destination" was the wrong target. No studied system tries
for it: 50% of a linear Hz range and 50% of a linear dB range are not the same amount of
modulation to a listener. VST3, Surge and Vital normalise the *interface* and let each
parameter declare its own *curve*.

- Add `curve` to each destination in `KIND-synth_mod_route` §3.2 and mirror it in
  `PARAM_SPECS.modulation`. The existing two-sided F72 check covers it for free.
- `db-unipolar-down` for amplitude — already implemented ad hoc, now permanent and the
  reference example.
- `exponential` for cutoff, so depth means **octaves**. Today it is linear in Hz and clamps
  at the bottom on deep routes.
- `linear` for cents and pan. `detune` needs nothing: it is already a log-frequency unit,
  which is exactly why pitch modulation felt right when cutoff and amplitude did not.

Also here: a **route-overflow indicator**. Web Audio sums connections into an `AudioParam`
and clamps silently, which is correct and standard — auto-normalising would make one route's
effect depend on whether a sibling is enabled, fighting determinism rather than serving it.
The gap is visibility. Compute the summed depth in destination units at authoring time and
flag it; the signal chain does not change.

## Stage 4 — the design stage · *triggered, Stage 3 is green*

Prep is done: `arch/contract.ngf.md` and `arch/clients.ngf.md` declare the risk areas and
the safe-edit zone, and the four reference images are in `design/references/` with the brief
recorded verbatim.

**Its own interactive planning cycle**, run when Stage 3 is green. It decides the palette and
type that become `arch/design-system.ngf.md`, the portrait/landscape rule, the tab set,
whether waveform pickers draw the shape and ADSR is a dragged curve, and the knob-vs-slider
vocabulary. Then `taste-frontend-designer` builds inside the arch cards.

The layout derives from `SIGNAL_CHAIN` in `src/core/groups.ts`, which is already gated to
cover all 97 addresses exactly once — that is what makes "content aware pipeline" mechanical
rather than aspirational.

**Skill note:** the installed `design-taste-frontend` skill self-declares *"Not dashboards,
not data tables, not multi-step product UI"*. A synth control surface is what it excludes.
Use `image-to-code`, `imagegen-frontend-mobile` and `high-end-visual-design`.

Output **replaces** the debug surface rather than following it.

## v0.2.0 — ship

Preset save/load on the designed surface, an ear pass over every stage, and the version bump.

---

## Why sequencer and SDK moved to 0.3.0

They were filed under 0.2.0 when 0.2.0 meant "everything after live keys". Three things
changed that:

1. **The designed UI became a milestone in its own right.** You set a specific visual target
   with references. That is a release, not a sub-task.
2. **Q2 is genuinely open and it is a research blocker, not a build task.** `Tone.Transport`
   schedules ahead of the audio clock while our allocator expects to decide at dispatch time.
   Nobody has measured the lookahead window against a pure allocator. Shipping a sequencer
   before that is answered means discovering it during the sequencer.
3. **The SDK's value depends on the surface being finished.** Its whole premise is an agent
   as a peer client of the UI over one command surface. That surface is still growing — 26
   addresses do not sound yet, and route curves are about to change.

Bundling them into 0.2.0 would mean the designed instrument waits on a transport question
nobody has researched. Splitting lets 0.2.0 ship a synth you can play and look at.

---

## Open, honestly

- **Transport lookahead versus an external allocator.** Blocks 0.3.0. Filed as LP1 in the
  final research pack, not yet investigated.
- **Do chorus and feedback delay actually byte-diff clean** under a harness holding phase
  and pre-roll constant? Classified by inference, never measured.
- **Per-voice LFO phase** stays declined. One `Tone.LFO` feeds every voice, so generator
  count tracks slots not polyphony — 1 for 8 voices, measured, against 128 at the declared
  maxima. The cost is `retrigger`, reported rather than approximated. Revisit only if it is
  missed in practice.
- **Whether normalised depth with per-destination curves is right for an *agent*-facing
  API.** The research answered it for plugin UIs. An agent setting `depth: 0.5` over a wire
  has different needs from a player turning a knob, and no surveyed system is agent-first.
- **The KIND schema as the unified API and wire protocol.** Eyal's standing insight, still
  uninvestigated. `src/core/commands.ts`, `src/core/schemas.ts` and the KIND files already
  encode one contract in three notations; the question is whether one can generate the other
  two. Naturally belongs with the SDK in 0.3.0.
