# 09 — Shared Data Models, State Management, and Voice Engine Wiring

## Why This Matters
Presets, songs, MIDI import, and the sequencer all need to agree on the same TypeScript interfaces. This document centralizes the canonical types and shows how to wire a `SynthEngine` class that ties oscillator/envelope/filter/LFO/effects together per the earlier docs.

## Canonical Types
```ts
// types/synth-types.ts

export type WaveShape = 'sine' | 'triangle' | 'sawtooth' | 'square' | 'pulse' | 'pwm' | 'noise' | 'custom';

export interface OscillatorConfig {
  type: WaveShape;
  detune?: number;      // cents
  count?: number;       // unison voices (fatsawtooth style)
  spread?: number;      // unison detune spread in cents
  width?: number;       // pulse width (0-1), only for 'pulse'/'pwm'
}

export interface EnvelopeConfig {
  attack: number; decay: number; sustain: number; release: number;
}

export interface FilterConfig {
  type: 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'lowshelf' | 'highshelf' | 'allpass' | 'peaking';
  frequency: number;
  Q: number;
  rolloff: -12 | -24 | -48 | -96;
}

export interface FilterEnvelopeConfig extends EnvelopeConfig {
  baseFrequency: number;
  octaves: number;
}

export interface LFOConfig {
  id: string;
  target: 'filterFrequency' | 'pitch' | 'amplitude' | 'pan';
  type: WaveShape;
  frequency: number | string; // Hz or Tone.js time string if synced
  min: number;
  max: number;
  sync: boolean;
}

export interface VoiceConfig {
  oscillator: OscillatorConfig;
  envelope: EnvelopeConfig;
  filter: FilterConfig;
  filterEnvelope?: FilterEnvelopeConfig;
  lfos: LFOConfig[];
  polyphony: number;    // max simultaneous voices
  portamento: number;   // glide time in seconds, 0 = off
}

export interface SynthPreset {
  id: string; name: string; category?: string; author?: string; createdAt: number;
  schemaVersion: number;
  voice: VoiceConfig;
  effects: Record<string, Record<string, unknown>>;
}
```

## SynthEngine Class (wiring everything together)
```ts
import * as Tone from 'tone';

export class SynthEngine {
  polySynth: Tone.PolySynth<Tone.MonoSynth>;
  lfoNodes: Map<string, Tone.LFO> = new Map();
  effects: Record<string, Tone.ToneAudioNode>;
  limiter: Tone.Limiter;

  constructor(config: VoiceConfig, effectsConfig: Record<string, Record<string, unknown>>) {
    this.polySynth = new Tone.PolySynth(Tone.MonoSynth, {
      oscillator: { type: config.oscillator.type as any },
      envelope: config.envelope,
      filter: config.filter,
      filterEnvelope: config.filterEnvelope,
    });
    this.polySynth.maxPolyphony = config.polyphony;

    this.effects = {
      chorus: new Tone.Chorus().set(effectsConfig.chorus ?? {}),
      delay: new Tone.FeedbackDelay().set(effectsConfig.delay ?? {}),
      reverb: new Tone.Reverb().set(effectsConfig.reverb ?? {}),
    };
    this.limiter = new Tone.Limiter(-1);

    this.polySynth.chain(
      this.effects.chorus, this.effects.delay, this.effects.reverb, this.limiter, Tone.Destination
    );

    config.lfos.forEach((lfoCfg) => this.addLFO(lfoCfg));
  }

  addLFO(cfg: LFOConfig) {
    const lfo = new Tone.LFO({ frequency: cfg.frequency, min: cfg.min, max: cfg.max, type: cfg.type as any });
    if (cfg.sync) lfo.sync();
    lfo.start();
    // NOTE: connecting to a PolySynth-wide param affects all voices identically;
    // per-voice modulation requires custom voice management instead of PolySynth.
    this.lfoNodes.set(cfg.id, lfo);
  }

  noteOn(note: string, velocity = 0.8, time?: Tone.Unit.Time) {
    this.polySynth.triggerAttack(note, time, velocity);
  }
  noteOff(note: string, time?: Tone.Unit.Time) {
    this.polySynth.triggerRelease(note, time);
  }

  exportPreset(name: string): SynthPreset {
    return {
      id: crypto.randomUUID(), name, createdAt: Date.now(), schemaVersion: 1,
      voice: this.currentVoiceConfig(), // map from polySynth.get() back into VoiceConfig shape
      effects: Object.fromEntries(Object.entries(this.effects).map(([k, n]) => [k, (n as any).get()])),
    };
  }

  dispose() {
    this.polySynth.dispose();
    Object.values(this.effects).forEach((e) => e.dispose());
    this.lfoNodes.forEach((l) => l.dispose());
    this.limiter.dispose();
  }
}
```

**Important limitation to design around**: `Tone.PolySynth` shares LFO routing across all voices since the LFO connects to a synth-level, not voice-level, parameter in most simple wiring. If truly independent per-voice modulation (e.g., each note gets its own vibrato phase) is required, manage a manual pool of `Tone.MonoSynth` instances yourself instead of `Tone.PolySynth`, instantiating an LFO per voice on note-on and disposing on note-off/steal.

## State Management (App-Level)
Recommend a state library that keeps synth parameters as **plain serializable objects**, since these need to flow directly into presets/songs without transformation. Zustand is lightweight and works well:
```ts
import { create } from 'zustand';

interface AppState {
  currentPreset: SynthPreset;
  currentSong: Song;
  setOscillatorType: (type: WaveShape) => void;
}

export const useSynthStore = create<AppState>((set) => ({
  currentPreset: defaultPreset,
  currentSong: defaultSong,
  setOscillatorType: (type) => set((s) => ({
    currentPreset: { ...s.currentPreset, voice: { ...s.currentPreset.voice, oscillator: { ...s.currentPreset.voice.oscillator, type } } }
  })),
}));

// Whenever state changes, push the new params into the live engine (one-way: UI -> engine)
useSynthStore.subscribe((state) => {
  engine.polySynth.set({ oscillator: { type: state.currentPreset.voice.oscillator.type } });
});
```
Keep a strict separation: **UI state (source of truth, serializable) → drives → live Tone.js audio nodes (derived, disposable, never the source of truth)**. This makes save/load trivial (you always serialize UI state, never audio node internals directly) and avoids stale-audio-node bugs.

## Voice Stealing / Polyphony Limits
```ts
this.polySynth.maxPolyphony = 8; // Tone.js will steal the oldest voice beyond this count
```
Set an explicit `maxPolyphony` rather than leaving it unbounded — unbounded polyphony on complex patches (many oscillators/effects per voice) can silently exhaust CPU and cause audio glitches/crackling on mobile devices.
