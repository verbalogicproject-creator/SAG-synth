# 03 — ADSR Envelope, Filter, and LFO

## ADSR Envelope
ADSR shapes the amplitude (or any parameter) over the note's lifetime: **Attack** (0→peak), **Decay** (peak→sustain level), **Sustain** (held level while key is down), **Release** (sustain→0 after key-up) [web:6].

### Tone.js Envelope
```js
const synth = new Tone.Synth({
  envelope: {
    attack: 0.02,
    decay: 0.1,
    sustain: 0.3,
    release: 1,
  }
}).toDestination();

// live update
synth.envelope.attack = 0.5;
```
`Tone.AmplitudeEnvelope` and `Tone.Envelope` are also usable standalone to modulate arbitrary parameters (e.g., filter cutoff) rather than just amplitude — useful for a filter envelope separate from the amp envelope, which most "decent" synths include [web:6].

### Adding a Filter Envelope (common omission)
Many simple tutorials only wire ADSR to amplitude. A proper subtractive synth also needs a **filter envelope** — a second ADSR that modulates cutoff frequency, giving the classic "pluck"/"wah" filter sweep:

```js
const filterEnv = new Tone.FrequencyEnvelope({
  attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.5,
  baseFrequency: 200,
  octaves: 4,
});
filterEnv.connect(filter.frequency);
// trigger together with the amp envelope
filterEnv.triggerAttackRelease(duration, time);
```

### Raw Web Audio Envelope (no Tone.js)
Use `AudioParam` scheduling on a `GainNode`:
```js
function triggerEnvelope(gainParam, time, attack, decay, sustain, sustainLevel) {
  gainParam.cancelScheduledValues(time);
  gainParam.setValueAtTime(0, time);
  gainParam.linearRampToValueAtTime(1, time + attack);
  gainParam.linearRampToValueAtTime(sustainLevel, time + attack + decay);
}
function releaseEnvelope(gainParam, time, release) {
  gainParam.cancelScheduledValues(time);
  gainParam.setValueAtTime(gainParam.value, time);
  gainParam.linearRampToValueAtTime(0, time + release);
}
```
This pattern (`setValueAtTime` + `linearRampToValueAtTime`/`exponentialRampToValueAtTime`) is the core primitive underlying every envelope implementation, Tone.js included [web:45].

Use exponential ramps for frequency-related parameters (pitch, filter cutoff) since human pitch perception is logarithmic; use linear ramps for gain/amplitude to avoid the "can't ramp to 0" issue with exponential ramps (exponential ramps cannot target exactly 0).

## Filters

### BiquadFilterNode (native)
```js
const filter = audioCtx.createBiquadFilter();
filter.type = "lowpass"; // highpass, bandpass, lowshelf, highshelf, notch, allpass, peaking
filter.frequency.value = 350;
filter.Q.value = 1;
```

### Tone.Filter
```js
const filt = new Tone.Filter({
  type: "lowpass",
  frequency: 350,
  rolloff: -12,   // -12, -24, -48, -96 dB/octave
  Q: 1,
}).toDestination();
source.connect(filt);
```
Filter types and their use: lowpass (classic subtractive "brightness" control), highpass (thin out bass), bandpass (narrow resonant sweep), notch (remove a band), shelf filters (broad tonal EQ) [web:6].

`Tone.MonoSynth` bundles oscillator + filter + filter envelope + amp envelope in one instrument, which is the fastest path to a classic analog-style monosynth voice [web:46].

## LFO (Low Frequency Oscillator)
An LFO is a sub-audio-rate oscillator (typically 0.1–20 Hz) used purely as a modulation source, not heard directly. Common LFO targets: filter cutoff (wah/auto-filter), pitch/detune (vibrato), amplitude (tremolo), pan (auto-pan) [web:6].

### Tone.LFO
```js
const lfo = new Tone.LFO(4, 200, 2000); // 4 Hz, modulates between 200–2000
lfo.connect(filter.frequency);
lfo.start();
```

### Native oscillator-as-LFO pattern
```js
const lfo = new OscillatorNode(audioCtx, { type: "square", frequency: 30 });
const amp = new GainNode(audioCtx, { value: 1 });
lfo.connect(amp.gain);       // modulate gain (tremolo)
osc.connect(amp).connect(audioCtx.destination);
lfo.start();
```
Any `AudioParam` can be an LFO target by `.connect()`-ing an oscillator/LFO node directly into it — this is "modulation" in Web Audio: connecting one signal into another node's parameter input [web:6][web:45].

### Multiple LFOs / LFO Sync
A "decent" synth typically offers 2+ LFOs per voice/patch with selectable target (pitch/filter/amp/pan), waveform (sine/triangle/square/sample&hold/random), rate (free Hz or tempo-synced to `Tone.Transport`, e.g. "8n"), depth, and optional retrigger-on-note-on vs free-running phase.

```js
const lfo = new Tone.LFO({ frequency: "8n", min: 0, max: 1 }).sync().start(); // tempo-synced
```

## Putting It Together: MonoSynth-Style Voice
```js
const voice = new Tone.MonoSynth({
  oscillator: { type: "sawtooth" },
  envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.8 },
  filterEnvelope: {
    attack: 0.02, decay: 0.3, sustain: 0.2, release: 0.5,
    baseFrequency: 300, octaves: 3,
  },
  filter: { type: "lowpass", rolloff: -24, Q: 1 },
}).toDestination();

const vibrato = new Tone.LFO(5, -10, 10).start();
vibrato.connect(voice.detune);
```
Wrap this in `Tone.PolySynth(Tone.MonoSynth, options)` for polyphony — note that some modulation routings (like a shared LFO connected to `detune`) need per-voice wiring if you want independent phase per note; `PolySynth` re-creates the wrapped synth per voice automatically [web:46].
