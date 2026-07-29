# 04 — Effects Chain

## Available Tone.js Effects
Tone.js ships a broad effects library, all extending a common `Effect` base class with a `wet` control (0 = dry, 1 = fully processed) [web:51]:

| Effect | Class | Use |
|---|---|---|
| Reverb (convolution) | `Tone.Reverb` | Space/ambience |
| Reverb (algorithmic, cheap) | `Tone.Freeverb`, `Tone.JCReverb` | Lightweight ambience |
| Delay | `Tone.FeedbackDelay`, `Tone.PingPongDelay` | Echo |
| Chorus | `Tone.Chorus` | Thickening, stereo width |
| Phaser | `Tone.Phaser` | Sweeping notches |
| Distortion | `Tone.Distortion` | Waveshaping/drive |
| BitCrusher | `Tone.BitCrusher` | Lo-fi/digital degradation |
| Tremolo | `Tone.Tremolo` | Amplitude modulation |
| AutoPanner | `Tone.AutoPanner` | Automated stereo panning |
| AutoWah | `Tone.AutoWah` | Envelope-following filter sweep |
| AutoFilter | `Tone.AutoFilter` | LFO-driven filter sweep |
| PitchShift | `Tone.PitchShift` | Real-time transposition |
| FrequencyShifter | `Tone.FrequencyShifter` | Ring-mod style effect |
| Compressor / Limiter | `Tone.Compressor`, `Tone.Limiter` | Dynamics control, prevents clipping |
| StereoWidener | `Tone.StereoWidener` | Stereo width |
| Chebyshev | `Tone.Chebyshev` | Harmonic waveshaping distortion |

## Building a Chain
```js
const synth = new Tone.Synth();
const distortion = new Tone.Distortion(0.4);
const chorus = new Tone.Chorus(4, 2.5, 0.5);
const reverb = new Tone.Reverb({ decay: 2.5, wet: 0.5 });

synth.chain(distortion, chorus, reverb, Tone.Destination);
```
`.chain()` connects nodes serially in the order given, terminating at the destination [web:46].

## Parallel/Send-Style Routing
For a "send" bus (multiple voices sharing one reverb, more efficient and more realistic mixing than per-voice reverb):
```js
const reverbBus = new Tone.Reverb({ decay: 3, wet: 1 }).toDestination();
const delayBus = new Tone.Delay(0.2).toDestination();

voice1.connect(reverbBus);
voice1.connect(delayBus);
voice2.connect(reverbBus);
```
Each voice's *dry* signal still needs its own path to `Tone.Destination` — sends are additional parallel taps, not replacements, unless you want 100% wet.

## Master Bus Essentials (frequently forgotten)
Almost every real synth places a limiter/compressor before the final destination to avoid clipping when several voices/effects sum together:
```js
const limiter = new Tone.Limiter(-3).toDestination();
Tone.Destination.chain(limiter); // or route all voices' final output into limiter first
```
Also consider a master `Tone.Volume`/`Tone.Channel` node for a global level fader, and optionally a master EQ (`Tone.EQ3`).

## Per-Voice vs Global Effects Chain Architecture
Two common architectures:
1. **Insert per voice**: filter + distortion inserted directly in each voice's signal path (needed for filter/distortion since they should respond per-note).
2. **Global bus effects**: time-based effects (reverb, delay, chorus) usually shared across all voices via a send bus — cheaper on CPU and sounds more cohesive.

```js
class SynthEngine {
  constructor() {
    this.effectsBus = {
      chorus: new Tone.Chorus(4, 2.5, 0.5).start(),
      delay: new Tone.FeedbackDelay(0.25, 0.3),
      reverb: new Tone.Reverb(2.5),
      limiter: new Tone.Limiter(-1),
    };
    this.effectsBus.chorus.chain(
      this.effectsBus.delay,
      this.effectsBus.reverb,
      this.effectsBus.limiter,
      Tone.Destination
    );
    this.voice = new Tone.PolySynth(Tone.MonoSynth).connect(this.effectsBus.chorus);
  }
}
```

## Serializing Effect Parameters for Presets
Every Tone.js effect node exposes `.get()`, returning a plain object of its current parameters, and accepts the same shape via `.set(obj)`:
```js
const params = reverb.get();       // { decay: 2.5, wet: 0.5, preDelay: 0.01, ... }
reverb.set({ decay: 4 });
```
This `.get()`/`.set()` symmetry is the backbone of the preset system (see `07_preset_system.md`) — store the return of `.get()` verbatim in your preset JSON, and `.set()` it back on load [web:46].

## Custom Effects via AudioWorklet or WaveShaperNode
For bespoke distortion curves, use `WaveShaperNode` with a custom curve (a `Float32Array` mapping input amplitude to output amplitude):
```js
function makeDistortionCurve(amount) {
  const n = 44100;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + amount) * x * 20 * Math.PI / 180) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}
const shaper = audioCtx.createWaveShaper();
shaper.curve = makeDistortionCurve(50);
```
For anything stateful/sample-by-sample (e.g., custom bitcrusher, custom filter algorithm), use an `AudioWorkletProcessor` as in `02_oscillators_and_wave_shapes.md`.
