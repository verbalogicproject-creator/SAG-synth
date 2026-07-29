/**
 * src/core/schemas.ts — zod validation for every document and every command payload.
 *
 * This is the only file in core that imports a third-party package, and `zod` is the
 * only one it may import (layer rule D2, enforced by src/tests/contract.test.ts).
 *
 * F64 / F61: nothing partially applies. A command or document that fails validation is
 * rejected before the reducer runs and before any parameter reaches the audio graph.
 */

import { z } from 'zod';
import {
  LIMITS,
  MAX_LFOS,
  NOTE_NAME_RE,
  PRESET_SCHEMA_VERSION,
  SONG_SCHEMA_VERSION,
  type LfoParamKey,
  type LfoParamPath,
  type ParamPath,
  type ParamValue,
} from './types';
import { SYNTH_COMMAND_TYPES, type SynthCommand } from './commands';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const unit = () => z.number().min(0).max(1);
const positive = () => z.number().nonnegative().finite();
const finite = () => z.number().finite();

export const NoteNameSchema = z
  .string()
  .regex(NOTE_NAME_RE, 'expected scientific pitch notation, e.g. "C4" or "F#3"');

export const IdSchema = z.string().min(1).max(128);

export const WAVE_SHAPES = [
  'sine',
  'triangle',
  'sawtooth',
  'square',
  'pulse',
  'pwm',
  'noise',
  'custom',
] as const;

export const SUPPORTED_WAVE_SHAPES = WAVE_SHAPES.filter((w) => w !== 'custom') as unknown as readonly [
  'sine',
  'triangle',
  'sawtooth',
  'square',
  'pulse',
  'pwm',
  'noise',
];

export const WaveShapeSchema = z.enum(WAVE_SHAPES);

/**
 * Decision D5 — 'custom' stays in the type union but is refused at the boundary, with
 * a message that names the reason rather than a bare "invalid enum value".
 */
export const SupportedWaveShapeSchema = WaveShapeSchema.refine((v) => v !== 'custom', {
  message: "wave shape 'custom' requires wavetable support (AudioWorklet), deferred past v0.1.0",
});

export const LFO_SHAPES = ['sine', 'triangle', 'sawtooth', 'square'] as const;
export const LfoShapeSchema = z.enum(LFO_SHAPES);

export const LFO_TARGETS = ['filterFrequency', 'pitch', 'amplitude', 'pan'] as const;
export const LfoTargetSchema = z.enum(LFO_TARGETS);

export const FILTER_TYPES = [
  'lowpass',
  'highpass',
  'bandpass',
  'notch',
  'lowshelf',
  'highshelf',
  'allpass',
  'peaking',
] as const;
export const FilterTypeSchema = z.enum(FILTER_TYPES);

export const FILTER_ROLLOFFS = [-12, -24, -48, -96] as const;
export const FilterRolloffSchema = z.union([
  z.literal(-12),
  z.literal(-24),
  z.literal(-48),
  z.literal(-96),
]);

export const STEAL_POLICIES = ['oldest'] as const;
export const StealPolicySchema = z.enum(STEAL_POLICIES);

export const EFFECT_IDS = ['distortion', 'chorus', 'delay', 'reverb'] as const;
export const EffectIdSchema = z.enum(EFFECT_IDS);

export const PRESET_CATEGORIES = ['Bass', 'Lead', 'Pad', 'Keys', 'Drum', 'FX'] as const;
export const PresetCategorySchema = z.enum(PRESET_CATEGORIES);

export const SWING_SUBDIVISIONS = ['8n', '16n'] as const;
export const SwingSubdivisionSchema = z.enum(SWING_SUBDIVISIONS);

/** Hz, or a Tone.js subdivision string when the LFO is transport-synced. */
export const LfoFrequencySchema = z.union([
  z.number().positive().max(200),
  z.string().regex(/^\d*(1|2|4|8|16|32|64)n\.?t?$/, 'expected a Tone subdivision like "8n" or "4n."'),
]);

// ---------------------------------------------------------------------------
// Voice / effects documents
// ---------------------------------------------------------------------------

export const OscillatorConfigSchema = z.object({
  type: SupportedWaveShapeSchema,
  detune: finite().min(-1200).max(1200),
  count: z.number().int().min(1).max(8),
  spread: finite().min(0).max(200),
  width: unit(),
});

export const EnvelopeConfigSchema = z.object({
  attack: positive().max(20),
  decay: positive().max(20),
  sustain: unit(),
  release: positive().max(20),
});

export const FilterConfigSchema = z.object({
  type: FilterTypeSchema,
  frequency: z.number().min(20).max(20000),
  Q: z.number().min(0).max(30),
  rolloff: FilterRolloffSchema,
});

export const FilterEnvelopeConfigSchema = EnvelopeConfigSchema.extend({
  baseFrequency: z.number().min(20).max(20000),
  octaves: z.number().min(-8).max(8),
});

export const LFOConfigSchema = z.object({
  id: IdSchema,
  enabled: z.boolean(),
  target: LfoTargetSchema,
  type: LfoShapeSchema,
  frequency: LfoFrequencySchema,
  min: finite(),
  max: finite(),
  sync: z.boolean(),
  retrigger: z.boolean(),
});

export const VelocityConfigSchema = z.object({
  toAmplitude: unit(),
  toFilterOctaves: z.number().min(0).max(8),
});

export const VoiceConfigSchema = z.object({
  oscillator: OscillatorConfigSchema,
  envelope: EnvelopeConfigSchema,
  filter: FilterConfigSchema,
  filterEnvelope: FilterEnvelopeConfigSchema,
  lfos: z.array(LFOConfigSchema).max(MAX_LFOS),
  polyphony: z.number().int().min(LIMITS.polyphony.min).max(LIMITS.polyphony.max),
  portamento: positive().max(5),
  stealPolicy: StealPolicySchema,
  velocity: VelocityConfigSchema,
});

export const DistortionConfigSchema = z.object({
  enabled: z.boolean(),
  amount: unit(),
  wet: unit(),
});

export const ChorusConfigSchema = z.object({
  enabled: z.boolean(),
  frequency: z.number().min(0).max(20),
  delayTime: z.number().min(0).max(20),
  depth: unit(),
  wet: unit(),
});

export const DelayConfigSchema = z.object({
  enabled: z.boolean(),
  delayTime: positive().max(2),
  feedback: z.number().min(0).max(0.95),
  wet: unit(),
});

export const ReverbConfigSchema = z.object({
  enabled: z.boolean(),
  roomSize: unit(),
  dampening: z.number().min(20).max(20000),
  wet: unit(),
});

export const EffectsConfigSchema = z.object({
  distortion: DistortionConfigSchema,
  chorus: ChorusConfigSchema,
  delay: DelayConfigSchema,
  reverb: ReverbConfigSchema,
});

export const MasterConfigSchema = z.object({
  volume: z.number().min(LIMITS.masterVolume.min).max(LIMITS.masterVolume.max),
  limiterThreshold: z.number().min(-40).max(0),
});

// ---------------------------------------------------------------------------
// Patch document — KIND-synth_patch
// ---------------------------------------------------------------------------

export const PresetSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(200),
  schemaVersion: z.number().int().min(1),
  voice: VoiceConfigSchema,
  effects: EffectsConfigSchema,
  createdAt: z.number().int().nonnegative(),

  category: PresetCategorySchema.optional(),
  author: z.string().max(200).optional(),
  tags: z.array(z.string().max(60)).max(32).optional(),
  factory: z.boolean().optional(),
  description: z.string().max(500).optional(),
  derivedFrom: IdSchema.optional(),
});

// ---------------------------------------------------------------------------
// Song document — KIND-synth_song
// ---------------------------------------------------------------------------

export const NoteEventSchema = z.object({
  noteId: IdSchema,
  time: positive(),
  duration: z.number().positive().finite(),
  note: NoteNameSchema,
  velocity: unit(),
});

export const SongTrackSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(200),
  presetId: IdSchema.nullable(),
  presetSnapshot: PresetSchema,
  notes: z.array(NoteEventSchema),
  patternLength: z
    .number()
    .int()
    .min(LIMITS.patternLength.min)
    .max(LIMITS.patternLength.max),
  volume: z.number().min(LIMITS.trackVolume.min).max(LIMITS.trackVolume.max),
  pan: z.number().min(-1).max(1),
  muted: z.boolean(),
  solo: z.boolean(),
  isDrum: z.boolean().optional(),
});

export const TempoEventSchema = z.object({
  time: positive(),
  bpm: z.number().min(LIMITS.bpm.min).max(LIMITS.bpm.max),
});

export const LoopRegionSchema = z
  .object({
    enabled: z.boolean(),
    start: positive(),
    end: positive(),
  })
  .refine((l) => l.end > l.start, { message: 'loop end must be after loop start' });

export const SourceMidiInfoSchema = z.object({
  filename: z.string().max(300),
  importedAt: z.number().int().nonnegative(),
  trackCount: z.number().int().nonnegative(),
  hadDrumChannel: z.boolean(),
});

export const SongSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(200),
  schemaVersion: z.number().int().min(1),
  bpm: z.number().min(LIMITS.bpm.min).max(LIMITS.bpm.max),
  timeSignature: z
    .number()
    .int()
    .min(LIMITS.timeSignature.min)
    .max(LIMITS.timeSignature.max),
  swing: unit(),
  swingSubdivision: SwingSubdivisionSchema,
  tracks: z.array(SongTrackSchema).max(64),
  master: MasterConfigSchema,
  loop: LoopRegionSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),

  tempoMap: z.array(TempoEventSchema).optional(),
  sourceMidi: SourceMidiInfoSchema.optional(),
  autosave: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Parameter registry — open question Q2 resolved
// ---------------------------------------------------------------------------

export type ParamSpec =
  | { kind: 'number'; min: number; max: number; unit?: string; integer?: boolean }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'frequency' };

const num = (min: number, max: number, unit?: string, integer?: boolean): ParamSpec =>
  integer === undefined
    ? unit === undefined
      ? { kind: 'number', min, max }
      : { kind: 'number', min, max, unit }
    : { kind: 'number', min, max, unit, integer };

/** Spec for each of the eight per-LFO parameters, reused across all MAX_LFOS slots. */
const LFO_PARAM_SPECS = {
  enabled: { kind: 'boolean' },
  target: { kind: 'enum', values: LFO_TARGETS },
  type: { kind: 'enum', values: LFO_SHAPES },
  frequency: { kind: 'frequency' },
  min: num(-20000, 20000),
  max: num(-20000, 20000),
  sync: { kind: 'boolean' },
  retrigger: { kind: 'boolean' },
} as const satisfies Record<LfoParamKey, ParamSpec>;

export const LFO_PARAM_KEYS = Object.keys(LFO_PARAM_SPECS) as LfoParamKey[];

const lfoParamSpecs = Object.fromEntries(
  Array.from({ length: MAX_LFOS }, (_unused, i) => i).flatMap((i) =>
    LFO_PARAM_KEYS.map((key) => [`voice.lfos.${i}.${key}`, LFO_PARAM_SPECS[key]] as const),
  ),
) as Record<LfoParamPath, ParamSpec>;

/**
 * The finite, exhaustive parameter registry. Declared as `Record<ParamPath, ParamSpec>`
 * so the compiler refuses to build if a path in `ParamValueMap` has no spec — the
 * type union and the runtime table cannot drift apart.
 */
export const PARAM_SPECS: Record<ParamPath, ParamSpec> = {
  'voice.oscillator.type': { kind: 'enum', values: SUPPORTED_WAVE_SHAPES },
  'voice.oscillator.detune': num(-1200, 1200, 'cents'),
  'voice.oscillator.count': num(1, 8, 'voices', true),
  'voice.oscillator.spread': num(0, 200, 'cents'),
  'voice.oscillator.width': num(0, 1),

  'voice.envelope.attack': num(0, 20, 's'),
  'voice.envelope.decay': num(0, 20, 's'),
  'voice.envelope.sustain': num(0, 1),
  'voice.envelope.release': num(0, 20, 's'),

  'voice.filter.type': { kind: 'enum', values: FILTER_TYPES },
  'voice.filter.frequency': num(20, 20000, 'Hz'),
  'voice.filter.Q': num(0, 30),
  'voice.filter.rolloff': num(-96, -12, 'dB/oct', true),

  'voice.filterEnvelope.attack': num(0, 20, 's'),
  'voice.filterEnvelope.decay': num(0, 20, 's'),
  'voice.filterEnvelope.sustain': num(0, 1),
  'voice.filterEnvelope.release': num(0, 20, 's'),
  'voice.filterEnvelope.baseFrequency': num(20, 20000, 'Hz'),
  'voice.filterEnvelope.octaves': num(-8, 8, 'oct'),

  'voice.polyphony': num(LIMITS.polyphony.min, LIMITS.polyphony.max, 'voices', true),
  'voice.portamento': num(0, 5, 's'),
  'voice.stealPolicy': { kind: 'enum', values: STEAL_POLICIES },
  'voice.velocity.toAmplitude': num(0, 1),
  'voice.velocity.toFilterOctaves': num(0, 8, 'oct'),

  'effects.distortion.amount': num(0, 1),
  'effects.distortion.wet': num(0, 1),
  'effects.chorus.frequency': num(0, 20, 'Hz'),
  'effects.chorus.delayTime': num(0, 20, 'ms'),
  'effects.chorus.depth': num(0, 1),
  'effects.chorus.wet': num(0, 1),
  'effects.delay.delayTime': num(0, 2, 's'),
  'effects.delay.feedback': num(0, 0.95),
  'effects.delay.wet': num(0, 1),
  'effects.reverb.roomSize': num(0, 1),
  'effects.reverb.dampening': num(20, 20000, 'Hz'),
  'effects.reverb.wet': num(0, 1),

  'master.volume': num(LIMITS.masterVolume.min, LIMITS.masterVolume.max, 'dB'),
  'master.limiterThreshold': num(-40, 0, 'dB'),

  ...lfoParamSpecs,
};

export const PARAM_PATHS = Object.keys(PARAM_SPECS) as ParamPath[];

export function isParamPath(value: unknown): value is ParamPath {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PARAM_SPECS, value);
}

export type ParamValidation = { ok: true } | { ok: false; error: string };

/** Validates a `setParam` value against its path's spec. Used by the payload schema. */
export function validateParamValue(path: ParamPath, value: ParamValue): ParamValidation {
  const spec: ParamSpec | undefined = PARAM_SPECS[path];
  // Callable from untyped boundaries (JSON, the v0.2 SDK, zod refinements that keep
  // running after an earlier issue), so an unknown path must return an error, not throw.
  if (spec === undefined) {
    return { ok: false, error: `unknown parameter path "${String(path)}"` };
  }
  switch (spec.kind) {
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true }
        : { ok: false, error: `${path} expects a boolean, received ${typeof value}` };
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value)
        ? { ok: true }
        : { ok: false, error: `${path} expects one of [${spec.values.join(', ')}], received ${String(value)}` };
    case 'frequency':
      return LfoFrequencySchema.safeParse(value).success
        ? { ok: true }
        : { ok: false, error: `${path} expects Hz or a Tone subdivision string, received ${String(value)}` };
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: `${path} expects a finite number, received ${String(value)}` };
      }
      if (spec.integer === true && !Number.isInteger(value)) {
        return { ok: false, error: `${path} expects an integer, received ${value}` };
      }
      if (value < spec.min || value > spec.max) {
        return { ok: false, error: `${path} out of range [${spec.min}, ${spec.max}], received ${value}` };
      }
      return { ok: true };
    }
  }
}

const ParamPathSchema = z.string().refine(isParamPath, {
  message: 'unknown parameter path',
}) as unknown as z.ZodType<ParamPath>;

// ---------------------------------------------------------------------------
// Command payload schemas
// ---------------------------------------------------------------------------

const oneOf = <T extends Record<string, unknown>>(a: keyof T & string, b: keyof T & string) =>
  (value: T, ctx: z.RefinementCtx) => {
    const hasA = value[a] !== undefined;
    const hasB = value[b] !== undefined;
    if (hasA === hasB) {
      ctx.addIssue({
        code: 'custom',
        message: `exactly one of "${a}" or "${b}" is required`,
      });
    }
  };

export const LoadPresetPayloadSchema = z
  .object({
    type: z.literal('loadPreset'),
    presetId: IdSchema.optional(),
    preset: PresetSchema.optional(),
  })
  .superRefine(oneOf('presetId', 'preset'));

export const SavePresetPayloadSchema = z.object({
  type: z.literal('savePreset'),
  name: z.string().min(1).max(200),
  category: PresetCategorySchema.optional(),
});

export const DeletePresetPayloadSchema = z.object({
  type: z.literal('deletePreset'),
  presetId: IdSchema,
});

export const SetParamPayloadSchema = z
  .object({
    type: z.literal('setParam'),
    path: ParamPathSchema,
    value: z.union([z.number(), z.boolean(), z.string()]),
  })
  .superRefine((value, ctx) => {
    // zod v4 still runs this refinement when `path` already failed its own check, so
    // the unknown-path case is reported once, by the path check, and skipped here.
    if (!isParamPath(value.path)) return;
    const result = validateParamValue(value.path, value.value);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.error, path: ['value'] });
    }
  });

export const AddLfoPayloadSchema = z.object({
  type: z.literal('addLfo'),
  config: LFOConfigSchema,
});

export const RemoveLfoPayloadSchema = z.object({
  type: z.literal('removeLfo'),
  lfoId: IdSchema,
});

export const SetEffectEnabledPayloadSchema = z.object({
  type: z.literal('setEffectEnabled'),
  effectId: EffectIdSchema,
  enabled: z.boolean(),
});

export const SetMasterVolumePayloadSchema = z.object({
  type: z.literal('setMasterVolume'),
  db: z.number().min(LIMITS.masterVolume.min).max(LIMITS.masterVolume.max),
});

export const NewSongPayloadSchema = z.object({ type: z.literal('newSong') });

export const LoadSongPayloadSchema = z
  .object({
    type: z.literal('loadSong'),
    songId: IdSchema.optional(),
    song: SongSchema.optional(),
  })
  .superRefine(oneOf('songId', 'song'));

export const SaveSongPayloadSchema = z.object({
  type: z.literal('saveSong'),
  name: z.string().min(1).max(200).optional(),
});

export const DeleteSongPayloadSchema = z.object({
  type: z.literal('deleteSong'),
  songId: IdSchema,
});

export const ImportSongFilePayloadSchema = z.object({
  type: z.literal('importSongFile'),
  json: z.string().min(2).max(20_000_000),
});

export const AddTrackPayloadSchema = z.object({
  type: z.literal('addTrack'),
  trackId: IdSchema,
  presetId: IdSchema.optional(),
  name: z.string().min(1).max(200).optional(),
});

export const RemoveTrackPayloadSchema = z.object({
  type: z.literal('removeTrack'),
  trackId: IdSchema,
});

export const RenameTrackPayloadSchema = z.object({
  type: z.literal('renameTrack'),
  trackId: IdSchema,
  name: z.string().min(1).max(200),
});

export const SetTrackParamPayloadSchema = z
  .object({
    type: z.literal('setTrackParam'),
    trackId: IdSchema,
    path: z.enum(['volume', 'pan', 'muted', 'solo']),
    value: z.union([z.number(), z.boolean()]),
  })
  .superRefine((value, ctx) => {
    const numeric = value.path === 'volume' || value.path === 'pan';
    if (numeric && typeof value.value !== 'number') {
      ctx.addIssue({ code: 'custom', message: `${value.path} expects a number`, path: ['value'] });
      return;
    }
    if (!numeric && typeof value.value !== 'boolean') {
      ctx.addIssue({ code: 'custom', message: `${value.path} expects a boolean`, path: ['value'] });
      return;
    }
    if (value.path === 'volume' && typeof value.value === 'number') {
      if (value.value < LIMITS.trackVolume.min || value.value > LIMITS.trackVolume.max) {
        ctx.addIssue({ code: 'custom', message: 'volume out of range', path: ['value'] });
      }
    }
    if (value.path === 'pan' && typeof value.value === 'number') {
      if (value.value < -1 || value.value > 1) {
        ctx.addIssue({ code: 'custom', message: 'pan out of range [-1, 1]', path: ['value'] });
      }
    }
  });

export const SetStepPayloadSchema = z
  .object({
    type: z.literal('setStep'),
    trackId: IdSchema,
    stepIndex: z.number().int().min(0).max(LIMITS.patternLength.max - 1),
    active: z.boolean(),
    note: NoteNameSchema.optional(),
    velocity: unit().optional(),
    noteId: IdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.active && value.noteId === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'noteId is required when activating a step so replay reproduces note identity',
        path: ['noteId'],
      });
    }
  });

export const SetPatternLengthPayloadSchema = z.object({
  type: z.literal('setPatternLength'),
  trackId: IdSchema,
  length: z.number().int().min(LIMITS.patternLength.min).max(LIMITS.patternLength.max),
});

export const AddNotePayloadSchema = z.object({
  type: z.literal('addNote'),
  trackId: IdSchema,
  note: NoteEventSchema,
});

export const RemoveNotePayloadSchema = z.object({
  type: z.literal('removeNote'),
  trackId: IdSchema,
  noteId: IdSchema,
});

export const SetTempoPayloadSchema = z.object({
  type: z.literal('setTempo'),
  bpm: z.number().min(LIMITS.bpm.min).max(LIMITS.bpm.max),
});

export const SetSwingPayloadSchema = z.object({
  type: z.literal('setSwing'),
  amount: unit(),
});

export const SetTimeSignaturePayloadSchema = z.object({
  type: z.literal('setTimeSignature'),
  n: z.number().int().min(LIMITS.timeSignature.min).max(LIMITS.timeSignature.max),
});

export const PlayPayloadSchema = z.object({ type: z.literal('play') });
export const StopPayloadSchema = z.object({ type: z.literal('stop') });
export const PausePayloadSchema = z.object({ type: z.literal('pause') });

export const SeekPayloadSchema = z.object({
  type: z.literal('seek'),
  /** Beats from the start of the song. Bounded so a stray value cannot hang playback. */
  position: z.number().nonnegative().finite().max(100_000),
});

export const SetLoopPayloadSchema = z
  .object({
    type: z.literal('setLoop'),
    enabled: z.boolean(),
    start: positive().optional(),
    end: positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.start !== undefined && value.end !== undefined && value.end <= value.start) {
      ctx.addIssue({ code: 'custom', message: 'loop end must be after loop start', path: ['end'] });
    }
  });

export const NoteOnPayloadSchema = z.object({
  type: z.literal('noteOn'),
  note: NoteNameSchema,
  velocity: unit(),
});

export const NoteOffPayloadSchema = z.object({
  type: z.literal('noteOff'),
  note: NoteNameSchema,
});

export const PanicPayloadSchema = z.object({ type: z.literal('panic') });

export const UndoPayloadSchema = z.object({ type: z.literal('undo') });
export const RedoPayloadSchema = z.object({ type: z.literal('redo') });

/** Base64, RFC 4648 alphabet with optional padding. */
export const Base64Schema = z
  .string()
  .min(4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'expected base64-encoded bytes');

export const ImportMidiPayloadSchema = z.object({
  type: z.literal('importMidi'),
  bytes: Base64Schema,
  filename: z.string().max(300).optional(),
  autoplay: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// The command schema
// ---------------------------------------------------------------------------

/**
 * Keyed by discriminant rather than built with `z.discriminatedUnion`, because three
 * members carry a `.superRefine` wrapper that a discriminated union will not accept.
 * `Record<SynthCommandType, ...>` keeps it exhaustive at compile time regardless.
 */
export const COMMAND_PAYLOAD_SCHEMAS = {
  loadPreset: LoadPresetPayloadSchema,
  savePreset: SavePresetPayloadSchema,
  deletePreset: DeletePresetPayloadSchema,
  setParam: SetParamPayloadSchema,
  addLfo: AddLfoPayloadSchema,
  removeLfo: RemoveLfoPayloadSchema,
  setEffectEnabled: SetEffectEnabledPayloadSchema,
  setMasterVolume: SetMasterVolumePayloadSchema,
  newSong: NewSongPayloadSchema,
  loadSong: LoadSongPayloadSchema,
  saveSong: SaveSongPayloadSchema,
  deleteSong: DeleteSongPayloadSchema,
  importSongFile: ImportSongFilePayloadSchema,
  addTrack: AddTrackPayloadSchema,
  removeTrack: RemoveTrackPayloadSchema,
  renameTrack: RenameTrackPayloadSchema,
  setTrackParam: SetTrackParamPayloadSchema,
  setStep: SetStepPayloadSchema,
  setPatternLength: SetPatternLengthPayloadSchema,
  addNote: AddNotePayloadSchema,
  removeNote: RemoveNotePayloadSchema,
  setTempo: SetTempoPayloadSchema,
  setSwing: SetSwingPayloadSchema,
  setTimeSignature: SetTimeSignaturePayloadSchema,
  play: PlayPayloadSchema,
  stop: StopPayloadSchema,
  pause: PausePayloadSchema,
  seek: SeekPayloadSchema,
  setLoop: SetLoopPayloadSchema,
  noteOn: NoteOnPayloadSchema,
  noteOff: NoteOffPayloadSchema,
  panic: PanicPayloadSchema,
  importMidi: ImportMidiPayloadSchema,
  undo: UndoPayloadSchema,
  redo: RedoPayloadSchema,
} satisfies Record<(typeof SYNTH_COMMAND_TYPES)[number], z.ZodType>;

export type CommandValidation =
  | { ok: true; command: SynthCommand }
  | { ok: false; error: string };

/**
 * The single validation entry point. Returns a message rather than throwing, because
 * a rejected command still emits a `status: "rejected"` SAG event carrying the reason
 * (F61) — the dispatcher needs the string, not a stack trace.
 */
export function validateCommand(input: unknown): CommandValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'command must be an object' };
  }
  const type = (input as { type?: unknown }).type;
  if (typeof type !== 'string' || !(type in COMMAND_PAYLOAD_SCHEMAS)) {
    return { ok: false, error: `unknown command type "${String(type)}"` };
  }
  const schema = COMMAND_PAYLOAD_SCHEMAS[type as keyof typeof COMMAND_PAYLOAD_SCHEMAS];
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
    return { ok: false, error: `${type} rejected — ${where}${first?.message ?? 'invalid payload'}` };
  }
  return { ok: true, command: parsed.data as SynthCommand };
}

// ---------------------------------------------------------------------------
// Document migration — F65 / F69
// ---------------------------------------------------------------------------

export type MigrationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * F65 — a legacy patch with no `schemaVersion` migrates to 1 losslessly; an unknown
 * FUTURE version is refused explicitly rather than silently coerced.
 */
export function migratePreset(raw: unknown): MigrationResult<unknown> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'preset must be an object' };
  const doc = { ...(raw as Record<string, unknown>) };
  const version = doc.schemaVersion;
  if (version === undefined) doc.schemaVersion = PRESET_SCHEMA_VERSION;
  else if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { ok: false, error: 'preset schemaVersion must be an integer' };
  } else if (version > PRESET_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `preset schemaVersion ${version} is newer than this build understands (${PRESET_SCHEMA_VERSION})`,
    };
  }
  return { ok: true, value: doc };
}

/** F69 — same contract for songs, with `swing` defaulted to 0 on legacy documents. */
export function migrateSong(raw: unknown): MigrationResult<unknown> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'song must be an object' };
  const doc = { ...(raw as Record<string, unknown>) };
  const version = doc.schemaVersion;
  if (version === undefined) {
    doc.schemaVersion = SONG_SCHEMA_VERSION;
    if (doc.swing === undefined) doc.swing = 0;
    if (doc.swingSubdivision === undefined) doc.swingSubdivision = '16n';
  } else if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { ok: false, error: 'song schemaVersion must be an integer' };
  } else if (version > SONG_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `song schemaVersion ${version} is newer than this build understands (${SONG_SCHEMA_VERSION})`,
    };
  }
  return { ok: true, value: doc };
}
