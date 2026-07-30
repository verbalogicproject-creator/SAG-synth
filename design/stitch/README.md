# The Stitch design — what was taken, and what was left

Eyal designed the synth in Google Stitch with Gemini and exported 36 screens. Seven are
here. This records which, why, and where each one disagrees with the engine — because a
design and an engine that disagree silently is how a control ends up looking broken.

Originals were at `/storage/emulated/0/Download/sag-synth-stitch/`, a downloads folder that
gets cleared.

## The finding that shaped the selection

The export contains several iterations, and **the earliest one is the closest fit.**
`fx_output` is still branded "EXAKT MOBILE" and carries a four-tab bar —
**OSC · ADSR · FILTER · FX** — which is exactly the scope of the engine that exists.

Later iterations grow to eight tabs (adding DRUMS, SEQ, SONG, SAMPLE) and the tab set keeps
changing between them, which is why the export holds nine `_nav` variants. That is a design
converging on a much larger instrument. Nothing wrong with it as a destination; it is not
what v0.2.0 can be.

**The four-tab bar is the canonical nav until the engine grows.**

## Taken

| Folder | From | Fit |
|---|---|---|
| `01-fx-and-master` | `fx_output` | Near-exact. Delay/chorus/reverb with per-effect ACTIVE·BYPASS, master meters and gain. Also the source of the four-tab nav. |
| `02-filter` | `sag_synth_filter_modulation_refined` | Near-exact. Type buttons, slope buttons, cutoff and env-amount knobs, response curve. |
| `03-oscillator` | `sag_synth_oscillator_engine_refined` | Visual language yes, structure no — see below. |
| `04-envelope` | `sag_synth_adsr_envelope_refined` | Buildable; we have both the amp and filter envelopes. |
| `05-mod-matrix` | `sag_synth_modulation_matrix` | Maps almost one-to-one onto `ModRoute`. |
| `06-preset-browser` | `preset_browser` | Buildable — `savePreset`/`loadPreset`/`deletePreset` and `IdbPersistence` all exist and are untouched by any UI. |
| `07-global-setup` | `sag_synth_global_setup` | Master and settings. |

## Left behind, and why

Every one of these is a screen for an engine that does not exist. Building the surface first
would produce controls that dispatch nothing.

- **Drums** (`drum_machine` ×3, `drum_sequencer`) — no drum engine at all.
- **Sequencer** (`step_sequencer`, `piano_roll_sequencer`) — needs `Tone.Transport`. v0.3.0,
  and blocked on an unresearched question about how its lookahead interacts with our pure
  allocator.
- **Song mode** (×4) — same dependency.
- **Sampler** (`sampler_editor`, `advanced_sampler_refined`, `key_mapper`) — no sampler.
- **Arpeggiator**, **macro performance** — nothing behind either.
- **Nine `_nav` variants** — the same screens with different tab bars. Iterations, not
  alternatives; keeping them would mean keeping the ambiguity.

## Where the design and the engine disagree

These are the reconciliations to settle in the design cycle. None is a fault in the design;
they are places it describes a synth we would have to build first.

**Oscillator — the biggest gap.** The design has **three oscillator slots (A/B/C)**, each
with its own `OCTAVE`, `PHASE`, `SYNC`, `LEVEL`, `PAN` and `VEL. SENS`. We have **one**
oscillator, and none of phase, sync or per-oscillator octave exists in the contract. Taking
this screen literally means a schema bump of roughly the size of the whole v2 routing
change. Taking its *visual language* costs nothing.

**Modulation matrix — close, with three specifics.**
- Sources shown: LFO 1–2, ENV 1–2, VELO, AFTCH, MOD W, RAND. We have `lfo.0–3` and
  `velocity`. Envelopes, aftertouch, mod wheel and random are not sources for us.
- `LFO RATE` appears as a destination. Ours deliberately excludes it
  (KIND-synth_mod_route §6): a route whose destination is another route's source makes the
  graph cyclic, and nothing declares an evaluation order.
- **Amount is bipolar** in the design (`+75%`, `−20%`). Our `depth` is `0..1` unipolar.
  Negative depth means inverted modulation and we cannot express it. This one is small and
  probably worth adopting.

**Filter.** `DRIVE` is not ours. The nearest existing thing is `effects.distortion.amount`,
which sits after the filter rather than inside it — a different sound.

**FX.** The design shows reverb `DECAY` and a `PLATE` type. We specified Freeverb
parameters (`roomSize`, `dampening`, `wet`) deliberately, because `Tone.Reverb` generates a
randomised impulse response and cannot be gated. No decay parameter exists. Also: the design
omits distortion, and omits the five-band EQ entirely.

**Master.** Stereo L/R meters. Our meter is mono.

## The tokens

Read from `code.html`. Tailwind via CDN, so the classes are inline and the palette is in a
config block at the top of each file.

```
primary          #dbfcff    near-white cyan, for text on dark
primary-fixed    #7df4ff
primary-fixed-dim #00dbe9   the accent that carries the identity
surface          #131315
surface-container-lowest #0e0e10
surface-container-low    #1b1b1d
surface-container-high   #2a2a2c
surface-variant  #353437
```

Secondary hues appear per screen — orange on the filter response curve, green on chorus and
env-amount, salmon on delay. Whether that is a system or per-screen improvisation is a
question for the design cycle.

Fonts: **Space Grotesk** (display) and **JetBrains Mono** (numerals and labels), plus
Material Symbols Outlined for icons.

## What must not be copied straight through

`arch/clients.ngf.md` forbids hand-written parameter lists and hard-coded ranges, and these
files are full of both — they are mockups, so every value in them is a literal. A slider
carrying its own `max` produces values the dispatcher rejects, which is exactly how a
control ends up silently doing nothing.

The design decides how it looks and where things sit. `PARAM_SPECS` keeps deciding what a
knob's range is, and `SIGNAL_CHAIN` keeps deciding what belongs in a panel.
