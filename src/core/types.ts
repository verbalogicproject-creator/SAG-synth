/**
 * src/core/types.ts — the frozen domain vocabulary of SAG-synth v0.1.0.
 *
 * Layer rule (decision D2): `src/core/**` imports ONLY `zod` and its own siblings.
 * No `tone`, no `react`, no DOM globals — core must run under plain Node so that the
 * v0.2 SAG-SDK can drive the engine headlessly. This file imports nothing at all.
 *
 * Substrate anchor: KIND-synth_patch.ngf.md and KIND-synth_song.ngf.md declare the
 * document slots these types implement. `src/core/sag/events.ts` carries the explicit
 * slot -> field maps, and `src/tests/contract.test.ts` proves they stay in sync.
 */

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * Musical time in quarter notes, NOT seconds.
 *
 * Research doc 08 modelled note times in seconds; this contract deliberately
 * departs from it. Seconds bind a note to the tempo it was written at, so
 * `setTempo` would have to rewrite every note in the song and a `tempoMap`
 * would make note times ambiguous. Beats are tempo-independent, make the
 * 16-step grid a pure projection (step i sits at beat i / STEPS_PER_BEAT),
 * and convert back to the seconds `@tonejs/midi` reports via the tempo map.
 */
export type Beats = number;

/** Decibels, full-scale (0 dB = unity gain). */
export type Decibels = number;

/** Seconds — used only for envelope stages and effect times, never for note placement. */
export type Seconds = number;

/** Normalised 0..1 control value (velocity, wet, depth, ...). */
export type Unit = number;

/** Scientific pitch notation, e.g. "C4", "F#3", "Bb-1". Validated by NOTE_NAME_RE. */
export type NoteName = string;

// ---------------------------------------------------------------------------
// Oscillator / envelope / filter / LFO
// ---------------------------------------------------------------------------

export type WaveShape =
  | 'sine'
  | 'triangle'
  | 'sawtooth'
  | 'square'
  | 'pulse'
  | 'pwm'
  | 'noise'
  | 'custom';

/**
 * Decision D5 — no AudioWorklet in v0.1.0. `'custom'` stays in `WaveShape` so the
 * union does not have to change when wavetables land, but the zod validator rejects
 * it with an explicit error rather than silently accepting an unplayable patch.
 */
export type SupportedWaveShape = Exclude<WaveShape, 'custom'>;

/** Tone.LFO only accepts the four basic periodic shapes. */
export type LfoShape = Extract<WaveShape, 'sine' | 'triangle' | 'sawtooth' | 'square'>;

export interface OscillatorConfig {
  type: SupportedWaveShape;
  /** Cents. */
  detune: number;
  /** Unison voice count (fat* oscillators). 1 = no unison. */
  count: number;
  /** Unison detune spread, cents. */
  spread: number;
  /** Pulse width 0..1 — only meaningful for 'pulse' / 'pwm'. */
  width: Unit;
}

export interface EnvelopeConfig {
  attack: Seconds;
  decay: Seconds;
  sustain: Unit;
  release: Seconds;
}

export type FilterType =
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'notch'
  | 'lowshelf'
  | 'highshelf'
  | 'allpass'
  | 'peaking';

export type FilterRolloff = -12 | -24 | -48 | -96;

export interface FilterConfig {
  type: FilterType;
  frequency: number;
  Q: number;
  rolloff: FilterRolloff;
}

export interface FilterEnvelopeConfig extends EnvelopeConfig {
  baseFrequency: number;
  octaves: number;
}

export type LfoTarget = 'filterFrequency' | 'pitch' | 'amplitude' | 'pan';

export interface LFOConfig {
  id: string;
  enabled: boolean;
  target: LfoTarget;
  type: LfoShape;
  /**
   * Hz when `sync` is false; a Tone.js subdivision string ("8n", "4n.") when true.
   * Kept as a union rather than two fields so the patch document stays flat.
   */
  frequency: number | string;
  min: number;
  max: number;
  /** Lock the LFO phase to Tone.Transport. */
  sync: boolean;
  /** Restart the LFO phase on every note-on instead of running free. */
  retrigger: boolean;
}

/**
 * Voice-stealing policy. Single-member union in v0.1.0 (locked scope), declared as a
 * union rather than a literal so adding 'quietest' | 'newest' later is additive.
 */
export type StealPolicy = 'oldest';

export interface VelocityConfig {
  /** How much velocity scales amplitude. 0 = ignore velocity, 1 = full range. */
  toAmplitude: Unit;
  /** How many octaves of filter cutoff a full-velocity note adds. */
  toFilterOctaves: number;
}

export interface VoiceConfig {
  oscillator: OscillatorConfig;
  envelope: EnvelopeConfig;
  filter: FilterConfig;
  filterEnvelope: FilterEnvelopeConfig;
  /**
   * Patch-level, not voice-level (KIND-synth_patch §5): every voice in the pool gets
   * the same LFO *configuration* while owning an independent *phase*. Per-voice LFO
   * configs would explode the preset schema for no v1 benefit.
   */
  lfos: LFOConfig[];
  /** Maximum simultaneous sounding voices. */
  polyphony: number;
  /** Glide time between notes, seconds. 0 = off. */
  portamento: Seconds;
  stealPolicy: StealPolicy;
  velocity: VelocityConfig;
}

/** Hard cap on LFOs per patch — bounds `ParamPath` to a finite union. */
export const MAX_LFOS = 4;
export type LfoIndex = 0 | 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Effects chain
// ---------------------------------------------------------------------------

export type EffectId = 'distortion' | 'chorus' | 'delay' | 'reverb';

export interface DistortionConfig {
  enabled: boolean;
  amount: Unit;
  wet: Unit;
}

export interface ChorusConfig {
  enabled: boolean;
  frequency: number;
  delayTime: number;
  depth: Unit;
  wet: Unit;
}

export interface DelayConfig {
  enabled: boolean;
  delayTime: Seconds;
  feedback: Unit;
  wet: Unit;
}

/**
 * Freeverb parameters, not Tone.Reverb's. Open question Q3 flagged `Tone.Reverb` as
 * nondeterministic — it generates a random noise impulse response, so no buffer-level
 * assertion over it can be stable. Freeverb is algorithmic and deterministic, which is
 * what the Phase-4 audio gates need. Convolution reverb is an additive post-v1 change.
 */
export interface ReverbConfig {
  enabled: boolean;
  roomSize: Unit;
  dampening: number;
  wet: Unit;
}

/** Fixed serial chain order: distortion -> chorus -> delay -> reverb -> master. */
export interface EffectsConfig {
  distortion: DistortionConfig;
  chorus: ChorusConfig;
  delay: DelayConfig;
  reverb: ReverbConfig;
}

export const EFFECT_CHAIN_ORDER: readonly EffectId[] = ['distortion', 'chorus', 'delay', 'reverb'];

export interface MasterConfig {
  volume: Decibels;
  /** Master limiter threshold, dB. See open question Q1 — the absolute peak gate is unproven. */
  limiterThreshold: Decibels;
}

// ---------------------------------------------------------------------------
// Patch document — implements KIND-synth_patch
// ---------------------------------------------------------------------------

export type PresetCategory = 'Bass' | 'Lead' | 'Pad' | 'Keys' | 'Drum' | 'FX';

export const PRESET_SCHEMA_VERSION = 1;

export interface SynthPreset {
  /** KIND slot `patch_id`. */
  id: string;
  name: string;
  /** KIND slot `schema_version`. */
  schemaVersion: number;
  voice: VoiceConfig;
  effects: EffectsConfig;
  /** KIND slot `created_at`, epoch ms. */
  createdAt: number;

  category?: PresetCategory;
  author?: string;
  tags?: string[];
  /** Read-only shipped bundle seeded on first load; user patches are false/absent. */
  factory?: boolean;
  description?: string;
  /** KIND slot `derived_from` — patch_id this was saved from. */
  derivedFrom?: string;
}

// ---------------------------------------------------------------------------
// Song document — implements KIND-synth_song
// ---------------------------------------------------------------------------

/** Grid resolution: the 16-step UI row is a projection at 16th notes. */
export const STEPS_PER_BEAT = 4;

export interface NoteEvent {
  /**
   * Caller-supplied stable identity. `removeNote` targets it, and replay must
   * reproduce it exactly — which is why core never generates ids itself.
   */
  noteId: string;
  time: Beats;
  duration: Beats;
  note: NoteName;
  velocity: Unit;
}

export interface SongTrack {
  /** KIND slot `track_id`. */
  id: string;
  name: string;
  /** KIND slot `preset_id`. null when this track's patch was never saved to the library. */
  presetId: string | null;
  /**
   * KIND slot `preset_snapshot`, required not optional (F68 self-containment): an
   * exported song must load on a machine whose library has none of these preset ids.
   */
  presetSnapshot: SynthPreset;
  /** Free-time note list. The step grid is a projection over this, never a rival store. */
  notes: NoteEvent[];
  /** Grid length in steps (STEPS_PER_BEAT steps per beat). */
  patternLength: number;
  volume: Decibels;
  /** -1 (hard left) .. 1 (hard right). */
  pan: number;
  muted: boolean;
  solo: boolean;
  /** F70 — MIDI channel 10 imports flag this instead of mapping to pitched synthesis. */
  isDrum?: boolean;
}

export interface TempoEvent {
  time: Beats;
  bpm: number;
}

export interface LoopRegion {
  enabled: boolean;
  start: Beats;
  end: Beats;
}

export interface SourceMidiInfo {
  filename: string;
  importedAt: number;
  trackCount: number;
  hadDrumChannel: boolean;
}

export type SwingSubdivision = '8n' | '16n';

export const SONG_SCHEMA_VERSION = 1;

export interface Song {
  /** KIND slot `song_id`. */
  id: string;
  name: string;
  /** KIND slot `schema_version` — versioned independently of SynthPreset. */
  schemaVersion: number;
  bpm: number;
  /** KIND slot `time_signature` — beats per bar (numerator). */
  timeSignature: number;
  swing: Unit;
  swingSubdivision: SwingSubdivision;
  tracks: SongTrack[];
  /** KIND slots `master_volume` + master limiter. */
  master: MasterConfig;
  /** KIND slot `loop`. */
  loop: LoopRegion;
  /** KIND slot `created_at`, epoch ms. */
  createdAt: number;
  /** KIND slot `updated_at`, epoch ms — advanced on every save including autosave. */
  updatedAt: number;

  /** KIND slot `tempo_map` — mid-song tempo changes preserved from MIDI import (F70). */
  tempoMap?: TempoEvent[];
  /** KIND slot `source_midi`. */
  sourceMidi?: SourceMidiInfo;
  /** KIND slot `autosave` — distinguishes the recovery snapshot from explicit saves. */
  autosave?: boolean;
}

// ---------------------------------------------------------------------------
// Parameter addressing — open question Q2, resolved here
// ---------------------------------------------------------------------------
//
// `setParam.path` must be a finite union, never `string`, or the SDK loses its
// contract and the reducer loses exhaustiveness. `ParamValueMap` is the single
// source of truth: it yields both the path union (`keyof`) and each path's value
// type. `PARAM_SPECS` in schemas.ts is declared as `Record<ParamPath, ParamSpec>`,
// so the compiler refuses to build if a path has no range spec.

export type LfoParamKey =
  | 'enabled'
  | 'target'
  | 'type'
  | 'frequency'
  | 'min'
  | 'max'
  | 'sync'
  | 'retrigger';

export type LfoParamPath = `voice.lfos.${LfoIndex}.${LfoParamKey}`;

type LfoParamValue<K extends LfoParamKey> = K extends 'target'
  ? LfoTarget
  : K extends 'type'
    ? LfoShape
    : K extends 'frequency'
      ? number | string
      : K extends 'enabled' | 'sync' | 'retrigger'
        ? boolean
        : number;

type LfoParamValueMap = {
  [P in LfoParamPath]: P extends `voice.lfos.${LfoIndex}.${infer K extends LfoParamKey}`
    ? LfoParamValue<K>
    : never;
};

interface FixedParamValueMap {
  'voice.oscillator.type': SupportedWaveShape;
  'voice.oscillator.detune': number;
  'voice.oscillator.count': number;
  'voice.oscillator.spread': number;
  'voice.oscillator.width': Unit;

  'voice.envelope.attack': Seconds;
  'voice.envelope.decay': Seconds;
  'voice.envelope.sustain': Unit;
  'voice.envelope.release': Seconds;

  'voice.filter.type': FilterType;
  'voice.filter.frequency': number;
  'voice.filter.Q': number;
  'voice.filter.rolloff': FilterRolloff;

  'voice.filterEnvelope.attack': Seconds;
  'voice.filterEnvelope.decay': Seconds;
  'voice.filterEnvelope.sustain': Unit;
  'voice.filterEnvelope.release': Seconds;
  'voice.filterEnvelope.baseFrequency': number;
  'voice.filterEnvelope.octaves': number;

  'voice.polyphony': number;
  'voice.portamento': Seconds;
  'voice.stealPolicy': StealPolicy;
  'voice.velocity.toAmplitude': Unit;
  'voice.velocity.toFilterOctaves': number;

  'effects.distortion.amount': Unit;
  'effects.distortion.wet': Unit;
  'effects.chorus.frequency': number;
  'effects.chorus.delayTime': number;
  'effects.chorus.depth': Unit;
  'effects.chorus.wet': Unit;
  'effects.delay.delayTime': Seconds;
  'effects.delay.feedback': Unit;
  'effects.delay.wet': Unit;
  'effects.reverb.roomSize': Unit;
  'effects.reverb.dampening': number;
  'effects.reverb.wet': Unit;

  'master.volume': Decibels;
  'master.limiterThreshold': Decibels;
}

export type ParamValueMap = FixedParamValueMap & LfoParamValueMap;

export type ParamPath = keyof ParamValueMap & string;

export type ParamValue = number | boolean | string;

/** Per-track mix parameters addressed by `setTrackParam`. */
export type TrackParamPath = 'volume' | 'pan' | 'muted' | 'solo';

export interface TrackParamValueMap {
  volume: Decibels;
  pan: number;
  muted: boolean;
  solo: boolean;
}

// ---------------------------------------------------------------------------
// Validation constants shared by schemas.ts and the runtime layer
// ---------------------------------------------------------------------------

/** Scientific pitch notation: letter, optional accidental(s), octave -1..9. */
export const NOTE_NAME_RE = /^[A-Ga-g](#{1,2}|b{1,2}|x)?(-1|[0-9])$/;

export const LIMITS = {
  bpm: { min: 20, max: 300 },
  timeSignature: { min: 1, max: 16 },
  polyphony: { min: 1, max: 32 },
  patternLength: { min: 1, max: 64 },
  velocity: { min: 0, max: 1 },
  swing: { min: 0, max: 1 },
  trackVolume: { min: -60, max: 12 },
  masterVolume: { min: -60, max: 6 },
} as const;
