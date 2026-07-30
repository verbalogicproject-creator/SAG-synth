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
  /**
   * Pulse duty cycle, **-1..1, where 0 is a square wave** — Tone's own convention, and
   * only meaningful for `'pulse'`.
   *
   * Declared `0..1` with a default of `0.5` until 2026-07-30, which was wrong twice over:
   * half of Tone's range was unreachable, and 0.5 is a 75% duty cycle wearing the costume
   * of a neutral value. Corrected without a schema bump because the runtime had never
   * read this field, so no stored patch's sound could depend on it — widening a range and
   * moving a default are only safe together while the parameter is silent.
   *
   * Not meaningful for `'pwm'`, which has no width at all; its analogous control is the
   * rate at which width is swept.
   */
  width: number;
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

/**
 * Note what is NOT here: `frequency`.
 *
 * In a MonoSynth the filter ENVELOPE owns the cutoff — `filterEnvelope.baseFrequency` is
 * the value the graph actually follows. A `filter.frequency` field alongside it was a
 * decoy: it validated, journalled, replayed, and changed nothing you could hear. It was
 * listed in the runtime's `UNMAPPED_PARAMS` for exactly that reason. Removed at
 * schema_version 2 rather than left as a field the document carries and no one reads.
 */
export interface FilterConfig {
  type: FilterType;
  Q: number;
  rolloff: FilterRolloff;
}

export interface FilterEnvelopeConfig extends EnvelopeConfig {
  baseFrequency: number;
  octaves: number;
}

export interface LFOConfig {
  id: string;
  enabled: boolean;
  type: LfoShape;
  /**
   * Hz when `sync` is false; a Tone.js subdivision string ("8n", "4n.") when true.
   * Kept as a union rather than two fields so the patch document stays flat.
   */
  frequency: number | string;
  /** Lock the LFO phase to Tone.Transport. */
  sync: boolean;
  /** Restart the LFO phase on every note-on instead of running free. */
  retrigger: boolean;
}

// ---------------------------------------------------------------------------
// Modulation routing — implements KIND-synth_mod_route (framework tag v0.0.3)
// ---------------------------------------------------------------------------
//
// An LFO used to carry its own destination in a four-value `LfoTarget` union. That
// shape could not grow: one LFO drove exactly one thing, and the legal destination set
// was a TypeScript union nothing outside TypeScript could read.
//
// What replaced it is not "more destinations" — it is a different place for the
// declaration. `MODULATION_DESTINATIONS` below is transcribed slot-for-slot from
// KIND-synth_mod_route §3.2, and every consumer projects from it: the zod validator,
// the reducer, the runtime's resolver, the journal, the SDK, and the control surface
// that draws the cables. `src/tests/contract.test.ts` fails if this table and
// `PARAM_SPECS` disagree in EITHER direction (F72), which is what makes the KIND the
// authority here rather than a comment that fell out of date.

/**
 * Polarity is a property of the SOURCE, not of the route (KIND §3.1): an LFO swings
 * bipolar about the base value, a velocity source only adds. Putting a `bipolar` flag
 * on the route would let a patch claim a unipolar generator is bipolar — not a
 * configuration, just a claim the runtime would have to reconcile.
 */
export type ModSource = `lfo.${LfoIndex}` | 'velocity';

/**
 * KIND-synth_mod_route §3.2, verbatim and in the KIND's order.
 *
 * `perVoice` is not a hint. It decides whether the runtime builds one modulator per
 * sounding voice or one on the shared chain, which is the entire cost model for the
 * feature. Every entry is continuous and carries a declared numeric range in
 * `PARAM_SPECS` — that is what lets one normalised `depth` mean the same thing across
 * Hz, cents, dB and unit values (F73).
 *
 * Structural parameters are absent on purpose. A route to `voice.filter.type` or
 * `voice.polyphony` would be a well-formed document describing an incoherent
 * instruction, so F71 refuses it at the boundary rather than letting the runtime invent
 * a rounding rule for a discrete value.
 */
export const MODULATION_DESTINATIONS = [
  { path: 'voice.filterEnvelope.baseFrequency', perVoice: true },
  { path: 'voice.filter.Q', perVoice: true },
  { path: 'voice.oscillator.detune', perVoice: true },
  { path: 'voice.oscillator.width', perVoice: true },
  { path: 'voice.oscillator.spread', perVoice: true },
  { path: 'voice.amplitude', perVoice: true },
  { path: 'voice.pan', perVoice: true },
  { path: 'effects.distortion.amount', perVoice: false },
  { path: 'effects.distortion.wet', perVoice: false },
  { path: 'effects.chorus.depth', perVoice: false },
  { path: 'effects.chorus.wet', perVoice: false },
  { path: 'effects.delay.feedback', perVoice: false },
  { path: 'effects.delay.wet', perVoice: false },
  { path: 'effects.reverb.wet', perVoice: false },
  { path: 'effects.eq.band0.gain', perVoice: false },
  { path: 'effects.eq.band1.gain', perVoice: false },
  { path: 'effects.eq.band2.gain', perVoice: false },
  { path: 'effects.eq.band3.gain', perVoice: false },
  { path: 'effects.eq.band4.gain', perVoice: false },
] as const;

/**
 * Derived from the table, never written twice. Deliberately NOT constrained with
 * `satisfies readonly { path: ParamPath }[]`: `ParamPath` is built from `ParamValueMap`,
 * which reaches back here for a route's `destination` value type, and that constraint
 * would close the loop into a circular type. The correspondence is proven at runtime
 * instead, by the same contract test that carries F72 — which is also how the existing
 * `KIND_SYNTH_PATCH_SLOT_MAP` proves itself.
 */
export type ModDestination = (typeof MODULATION_DESTINATIONS)[number]['path'];

export interface ModRoute {
  /** Caller-supplied stable identity; `removeRoute` targets it and replay reproduces it. */
  id: string;
  /** A disabled route keeps its configuration and contributes nothing. F74 toggles this. */
  enabled: boolean;
  source: ModSource;
  destination: ModDestination;
  /** Normalised. Scaled at the runtime by the DESTINATION's own declared range (F73). */
  depth: Unit;
}

/** Hard cap on routes per patch, mirroring MAX_LFOS — keeps `ParamPath` a finite union. */
export const MAX_ROUTES = 8;
export type RouteIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

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
  /** The modulation graph. Capped at MAX_ROUTES. See KIND-synth_mod_route. */
  modRoutes: ModRoute[];
  /** Maximum simultaneous sounding voices. */
  polyphony: number;
  /** Glide time between notes, seconds. 0 = off. */
  portamento: Seconds;
  stealPolicy: StealPolicy;
  velocity: VelocityConfig;
  /**
   * Base per-voice gain, before velocity scaling. Exists so tremolo has somewhere to
   * point — a modulation destination needs a declared base value to swing around.
   */
  amplitude: Unit;
  /** Base per-voice position, -1 (hard left) .. 1 (hard right). Autopan's destination. */
  pan: number;
}

/** Hard cap on LFOs per patch — bounds `ParamPath` to a finite union. */
export const MAX_LFOS = 4;
export type LfoIndex = 0 | 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Effects chain
// ---------------------------------------------------------------------------

export type EffectId = 'distortion' | 'chorus' | 'delay' | 'reverb' | 'eq';

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

/**
 * Centre frequencies of the five graphic-EQ bands, Hz. Fixed — see `EqConfig`.
 *
 * 250 Hz to 5 kHz, spaced by equal RATIO rather than equal difference: 5000/250 is 20,
 * and 20^(1/4) ≈ 2.115, so every neighbour sits 1.08 octaves above the last. Pitch is
 * perceived logarithmically, so equal ratios are what "evenly spaced" means to an ear —
 * linear spacing would crowd four of the five bands into the top of the range.
 *
 * The span was chosen against the device rather than tradition. The previous set ran
 * 60 Hz to 12 kHz, which is the textbook spread and was measured, on the factory patch,
 * as **+4.14 dB at 60 Hz and +0.12 dB at 12 kHz** — one band below what a phone speaker
 * reproduces and one with no content to lift above a 2.8 kHz cutoff. Two of five controls
 * did nothing audible, which is how a working EQ gets reported as broken twice.
 *
 * Free to change because band CENTRES are not parameters: the addresses are
 * `effects.eq.bandN.gain` and a saved patch stores gains. No schema bump, no migration.
 */
export const EQ_BAND_FREQUENCIES = [250, 530, 1120, 2360, 5000] as const;

export type EqBandIndex = 0 | 1 | 2 | 3 | 4;

/** One band. An object rather than a bare number so `frequency`/`Q` can be added later
 *  without moving every parameter address. */
export interface EqBandConfig {
  gain: Decibels;
}

/**
 * Five-band graphic EQ at fixed frequencies — the band centres are NOT parameters.
 *
 * It sits on the patch's effects chain rather than on the song's master bus, which is
 * where a mixer EQ would live. The reason is routing: modulation routes are patch-level,
 * and a route pointing at a song-level destination would be a cross-document reference.
 * Here, each band gain is an ordinary modulation destination and the EQ travels with the
 * preset, which for a synth is the more useful behaviour anyway.
 */
export interface EqConfig {
  enabled: boolean;
  band0: EqBandConfig;
  band1: EqBandConfig;
  band2: EqBandConfig;
  band3: EqBandConfig;
  band4: EqBandConfig;
}

/** Fixed serial chain order: distortion -> chorus -> delay -> reverb -> eq -> master. */
export interface EffectsConfig {
  distortion: DistortionConfig;
  chorus: ChorusConfig;
  delay: DelayConfig;
  reverb: ReverbConfig;
  eq: EqConfig;
}

export const EFFECT_CHAIN_ORDER: readonly EffectId[] = [
  'distortion',
  'chorus',
  'delay',
  'reverb',
  'eq',
];

export interface MasterConfig {
  volume: Decibels;
  /** Master limiter threshold, dB. See open question Q1 — the absolute peak gate is unproven. */
  limiterThreshold: Decibels;
}

// ---------------------------------------------------------------------------
// Patch document — implements KIND-synth_patch
// ---------------------------------------------------------------------------

export type PresetCategory = 'Bass' | 'Lead' | 'Pad' | 'Keys' | 'Drum' | 'FX';

/**
 * 2 — the modulation-routing bump. Version 1 patches carry `voice.filter.frequency`,
 * per-LFO `target`/`min`/`max`, and no `modRoutes` / `eq` / `voice.pan` / `voice.amplitude`.
 * `migratePreset` reconstructs all of it; see F65 in KIND-synth_patch.
 */
export const PRESET_SCHEMA_VERSION = 2;

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

/**
 * `target`, `min` and `max` were removed at schema_version 2. A destination is now a
 * route's business, and the range a route travels is derived from the destination's own
 * spec — so an LFO carrying its own min/max was a second, unreconcilable opinion about
 * how far a parameter may move.
 */
export type LfoParamKey = 'enabled' | 'type' | 'frequency' | 'sync' | 'retrigger';

export type LfoParamPath = `voice.lfos.${LfoIndex}.${LfoParamKey}`;

type LfoParamValue<K extends LfoParamKey> = K extends 'type'
  ? LfoShape
  : K extends 'frequency'
    ? number | string
    : boolean;

type LfoParamValueMap = {
  [P in LfoParamPath]: P extends `voice.lfos.${LfoIndex}.${infer K extends LfoParamKey}`
    ? LfoParamValue<K>
    : never;
};

export type RouteParamKey = 'enabled' | 'source' | 'destination' | 'depth';

export type RouteParamPath = `voice.modRoutes.${RouteIndex}.${RouteParamKey}`;

type RouteParamValue<K extends RouteParamKey> = K extends 'enabled'
  ? boolean
  : K extends 'source'
    ? ModSource
    : K extends 'destination'
      ? ModDestination
      : Unit;

type RouteParamValueMap = {
  [P in RouteParamPath]: P extends `voice.modRoutes.${RouteIndex}.${infer K extends RouteParamKey}`
    ? RouteParamValue<K>
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
  'voice.amplitude': Unit;
  'voice.pan': number;

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

  'effects.eq.enabled': boolean;
  'effects.eq.band0.gain': Decibels;
  'effects.eq.band1.gain': Decibels;
  'effects.eq.band2.gain': Decibels;
  'effects.eq.band3.gain': Decibels;
  'effects.eq.band4.gain': Decibels;

  'master.volume': Decibels;
  'master.limiterThreshold': Decibels;
}

export type ParamValueMap = FixedParamValueMap & LfoParamValueMap & RouteParamValueMap;

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
