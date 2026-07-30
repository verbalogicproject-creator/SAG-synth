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
  MAX_OSCILLATORS,
  MAX_ROUTES,
  MODULATION_DESTINATIONS,
  NOTE_NAME_RE,
  PRESET_SCHEMA_VERSION,
  SONG_SCHEMA_VERSION,
  type EffectId,
  type LfoParamKey,
  type LfoParamPath,
  type ModCurve,
  type ModDestination,
  type ModRoute,
  type OscParamKey,
  type OscParamPath,
  type ParamPath,
  type ParamValue,
  type RouteParamKey,
  type RouteParamPath,
} from './types';
import { SYNTH_COMMAND_TYPES, type SynthCommand } from './commands';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const unit = () => z.number().min(0).max(1);

/** Normalised and signed — a modulation route's depth, and nothing else. See `SignedUnit`. */
const signedUnit = () => z.number().min(-1).max(1);
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

/**
 * KIND-synth_mod_route §3.1. Four LFO slots plus velocity; polarity is the source's
 * property, so there is nothing per-route to declare.
 */
export const MOD_SOURCES = ['lfo.0', 'lfo.1', 'lfo.2', 'lfo.3', 'velocity'] as const;
export const ModSourceSchema = z.enum(MOD_SOURCES);

/**
 * Projected from `MODULATION_DESTINATIONS` (KIND §3.2) rather than retyped. Retyping it
 * would create the second list this whole change exists to remove; `src/tests/contract.test.ts`
 * proves the projection against `PARAM_SPECS` in both directions (F72).
 */
export const MOD_DESTINATION_PATHS: readonly ModDestination[] = MODULATION_DESTINATIONS.map(
  (d) => d.path,
);
export const ModDestinationSchema = z.enum(
  MOD_DESTINATION_PATHS as unknown as [ModDestination, ...ModDestination[]],
);

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

export const EFFECT_IDS = ['distortion', 'chorus', 'delay', 'reverb', 'eq'] as const;
export const EffectIdSchema = z.enum(EFFECT_IDS);

/**
 * Compile-time completeness, in both directions.
 *
 * `'eq'` was added to the `EffectId` TYPE at schema_version 2 and not to this runtime
 * enum, so `setEffectEnabled` with `effectId: 'eq'` failed validation and was refused —
 * the EQ toggle in the UI did nothing at all, for two stages, while every other effect's
 * worked. Nothing caught it: the type had five members, the validator four, and no
 * assertion compared them.
 *
 * `satisfies` alone would only catch an EXTRA entry here. The `Exclude` below is what
 * catches a MISSING one, which is the direction that actually bit.
 */
type _EffectIdsAreExhaustive = Exclude<EffectId, (typeof EFFECT_IDS)[number]> extends never
  ? true
  : ['MISSING FROM EFFECT_IDS', Exclude<EffectId, (typeof EFFECT_IDS)[number]>];
const _effectIdsAreExhaustive: _EffectIdsAreExhaustive = true;
void _effectIdsAreExhaustive;

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

/** One oscillator slot. KIND-synth_patch §1.1. */
export const OscillatorConfigSchema = z.object({
  id: IdSchema,
  enabled: z.boolean(),
  type: SupportedWaveShapeSchema,
  octave: z.number().int().min(-2).max(2),
  detune: finite().min(-1200).max(1200),
  count: z.number().int().min(1).max(8),
  spread: finite().min(0).max(200),
  // Not unit(): Tone's pulse width runs -1..1 with 0 as square. See OscillatorConfig.
  width: finite().min(-1).max(1),
  level: unit(),
  pan: z.number().min(-1).max(1),
});

export const EnvelopeConfigSchema = z.object({
  attack: positive().max(20),
  decay: positive().max(20),
  sustain: unit(),
  release: positive().max(20),
});

export const FilterConfigSchema = z.object({
  type: FilterTypeSchema,
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
  type: LfoShapeSchema,
  frequency: LfoFrequencySchema,
  sync: z.boolean(),
  retrigger: z.boolean(),
});

/**
 * KIND-synth_mod_route §1. `destination` is gated by the declared vocabulary — F71.
 *
 * `depth` is `signedUnit()` rather than `unit()` since schema_version 4: the magnitude
 * scales, the sign inverts. Everything else normalised on this document stays `unit()`,
 * because negative is meaningless for a wet mix or a level and letting it through would
 * be a decoy the runtime silently absorbs.
 */
export const ModRouteSchema = z.object({
  id: IdSchema,
  enabled: z.boolean(),
  source: ModSourceSchema,
  destination: ModDestinationSchema,
  depth: signedUnit(),
});

export const VelocityConfigSchema = z.object({
  toAmplitude: unit(),
  toFilterOctaves: z.number().min(0).max(8),
});

export const VoiceConfigSchema = z.object({
  // At least one, at most MAX_OSCILLATORS. The floor is deliberate: a voice with no
  // oscillator slot is a well-formed document that can never make a sound, and silence
  // that validates is the failure mode this project keeps paying for. Muting is what
  // `enabled: false` is for, and that stays legal.
  oscillators: z.array(OscillatorConfigSchema).min(1).max(MAX_OSCILLATORS),
  envelope: EnvelopeConfigSchema,
  filter: FilterConfigSchema,
  filterEnvelope: FilterEnvelopeConfigSchema,
  lfos: z.array(LFOConfigSchema).max(MAX_LFOS),
  modRoutes: z.array(ModRouteSchema).max(MAX_ROUTES),
  polyphony: z.number().int().min(LIMITS.polyphony.min).max(LIMITS.polyphony.max),
  portamento: positive().max(5),
  stealPolicy: StealPolicySchema,
  velocity: VelocityConfigSchema,
  amplitude: unit(),
  pan: z.number().min(-1).max(1),
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

const eqBand = () => z.object({ gain: z.number().min(-18).max(18) });

export const EqConfigSchema = z.object({
  enabled: z.boolean(),
  band0: eqBand(),
  band1: eqBand(),
  band2: eqBand(),
  band3: eqBand(),
  band4: eqBand(),
});

export const EffectsConfigSchema = z.object({
  distortion: DistortionConfigSchema,
  chorus: ChorusConfigSchema,
  delay: DelayConfigSchema,
  reverb: ReverbConfigSchema,
  eq: EqConfigSchema,
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
  | {
      kind: 'number';
      min: number;
      max: number;
      unit?: string;
      integer?: boolean;
      /**
       * When present, the ONLY legal values — the range becomes documentation rather
       * than the constraint.
       *
       * `voice.filter.rolloff` is the case that forced this. Its TypeScript type is the
       * union `-12 | -24 | -48 | -96`, but declaring it as a range meant `setParam` with
       * `-50` validated cleanly: the type system called it impossible while the runtime
       * called it fine. Anything reaching the engine from outside TypeScript — the v0.2
       * SDK, imported JSON, a slider — could then hand the audio graph a value it has no
       * behaviour for.
       */
      choices?: readonly number[];
      /**
       * Presence declares this address a legal modulation destination. `perVoice` says
       * whether the runtime builds one modulator per sounding voice or one on the shared
       * chain; `curve` says how a normalised depth becomes travel here. All three are
       * transcribed from KIND-synth_mod_route §3.2.
       *
       * It hangs off the number variant on purpose. An enum or boolean spec cannot carry
       * it, so the type system already refuses to route an LFO at `voice.filter.type` or
       * `voice.polyphony` — modulating a discrete value has no continuous meaning, and
       * the alternative is letting the runtime invent a rounding rule.
       *
       * These blocks are written out by hand rather than folded in from
       * `MODULATION_DESTINATIONS`, so that getting one wrong is POSSIBLE and the F72
       * contract test has something real to catch. Deriving them would make the gate
       * vacuous.
       */
      modulation?: { perVoice: boolean; curve: ModCurve };
    }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'frequency' };

const num = (min: number, max: number, unit?: string, integer?: boolean): ParamSpec =>
  integer === undefined
    ? unit === undefined
      ? { kind: 'number', min, max }
      : { kind: 'number', min, max, unit }
    : { kind: 'number', min, max, unit, integer };

/** `num()` for an address declared modulatable in KIND-synth_mod_route §3.2. */
const modNum = (
  min: number,
  max: number,
  unit: string | undefined,
  perVoice: boolean,
  curve: ModCurve,
): ParamSpec => ({
  kind: 'number',
  min,
  max,
  ...(unit === undefined ? {} : { unit }),
  modulation: { perVoice, curve },
});

/**
 * Spec for each of the nine per-slot oscillator parameters, reused across every slot.
 *
 * Five carry a `modulation` block and four do not, and each exclusion has a reason F72
 * will hold us to: `enabled` and `type` are boolean and enum, which structurally cannot
 * carry one; `octave` is discrete and marked with `choices`, so a slider cannot generate
 * a value between two octaves and a route cannot point at it; `count` is an integer voice
 * count, where modulation would mean spawning and killing oscillators at audio rate.
 */
const OSC_PARAM_SPECS = {
  enabled: { kind: 'boolean' },
  type: { kind: 'enum', values: SUPPORTED_WAVE_SHAPES },
  octave: { kind: 'number', min: -2, max: 2, unit: 'oct', integer: true, choices: [-2, -1, 0, 1, 2] },
  detune: modNum(-1200, 1200, 'cents', true, 'linear'),
  count: num(1, 8, 'voices', true),
  spread: modNum(0, 200, 'cents', true, 'linear'),
  // -1..1 with 0 meaning square, matching Tone's PulseOscillator. See OscillatorConfig.
  width: modNum(-1, 1, undefined, true, 'linear'),
  level: modNum(0, 1, undefined, true, 'linear'),
  pan: modNum(-1, 1, undefined, true, 'linear'),
} as const satisfies Record<OscParamKey, ParamSpec>;

export const OSC_PARAM_KEYS = Object.keys(OSC_PARAM_SPECS) as OscParamKey[];

const oscParamSpecs = Object.fromEntries(
  Array.from({ length: MAX_OSCILLATORS }, (_unused, i) => i).flatMap((i) =>
    OSC_PARAM_KEYS.map((key) => [`voice.oscillators.${i}.${key}`, OSC_PARAM_SPECS[key]] as const),
  ),
) as Record<OscParamPath, ParamSpec>;

/** Spec for each of the five per-LFO parameters, reused across all MAX_LFOS slots. */
const LFO_PARAM_SPECS = {
  enabled: { kind: 'boolean' },
  type: { kind: 'enum', values: LFO_SHAPES },
  frequency: { kind: 'frequency' },
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
 * Spec for each of the four per-route parameters, reused across all MAX_ROUTES slots.
 *
 * `depth` carries no `modulation` block: a route's depth is not itself a destination.
 * Allowing that would let one route modulate another's depth, which makes the graph
 * cyclic — explicitly out of scope in KIND-synth_mod_route §6.
 */
const ROUTE_PARAM_SPECS = {
  enabled: { kind: 'boolean' },
  source: { kind: 'enum', values: MOD_SOURCES },
  destination: { kind: 'enum', values: MOD_DESTINATION_PATHS },
  depth: num(-1, 1),
} as const satisfies Record<RouteParamKey, ParamSpec>;

export const ROUTE_PARAM_KEYS = Object.keys(ROUTE_PARAM_SPECS) as RouteParamKey[];

const routeParamSpecs = Object.fromEntries(
  Array.from({ length: MAX_ROUTES }, (_unused, i) => i).flatMap((i) =>
    ROUTE_PARAM_KEYS.map(
      (key) => [`voice.modRoutes.${i}.${key}`, ROUTE_PARAM_SPECS[key]] as const,
    ),
  ),
) as Record<RouteParamPath, ParamSpec>;

/**
 * The finite, exhaustive parameter registry. Declared as `Record<ParamPath, ParamSpec>`
 * so the compiler refuses to build if a path in `ParamValueMap` has no spec — the
 * type union and the runtime table cannot drift apart.
 */
export const PARAM_SPECS: Record<ParamPath, ParamSpec> = {
  'voice.envelope.attack': num(0, 20, 's'),
  'voice.envelope.decay': num(0, 20, 's'),
  'voice.envelope.sustain': num(0, 1),
  'voice.envelope.release': num(0, 20, 's'),

  'voice.filter.type': { kind: 'enum', values: FILTER_TYPES },
  'voice.filter.Q': modNum(0, 30, undefined, true, 'linear'),
  // Four legal slopes, not a range. FILTER_ROLLOFFS already existed; the spec simply
  // was not using it, so `setParam('voice.filter.rolloff', -50)` validated cleanly.
  'voice.filter.rolloff': {
    kind: 'number',
    min: -96,
    max: -12,
    unit: 'dB/oct',
    integer: true,
    choices: FILTER_ROLLOFFS,
  },

  'voice.filterEnvelope.attack': num(0, 20, 's'),
  'voice.filterEnvelope.decay': num(0, 20, 's'),
  'voice.filterEnvelope.sustain': num(0, 1),
  'voice.filterEnvelope.release': num(0, 20, 's'),
  // The live cutoff. `voice.filter.frequency` used to sit beside this and do nothing —
  // in a MonoSynth the filter envelope owns the cutoff. Removed at schema_version 2.
  'voice.filterEnvelope.baseFrequency': modNum(20, 20000, 'Hz', true, 'octaves'),
  'voice.filterEnvelope.octaves': num(-8, 8, 'oct'),

  'voice.polyphony': num(LIMITS.polyphony.min, LIMITS.polyphony.max, 'voices', true),
  'voice.portamento': num(0, 5, 's'),
  'voice.stealPolicy': { kind: 'enum', values: STEAL_POLICIES },
  'voice.velocity.toAmplitude': num(0, 1),
  'voice.velocity.toFilterOctaves': num(0, 8, 'oct'),
  'voice.amplitude': modNum(0, 1, undefined, true, 'duckDb'),
  'voice.pan': modNum(-1, 1, undefined, true, 'linear'),

  'effects.distortion.amount': modNum(0, 1, undefined, false, 'linear'),
  'effects.distortion.wet': modNum(0, 1, undefined, false, 'linear'),
  'effects.chorus.frequency': num(0, 20, 'Hz'),
  'effects.chorus.delayTime': num(0, 20, 'ms'),
  'effects.chorus.depth': modNum(0, 1, undefined, false, 'linear'),
  'effects.chorus.wet': modNum(0, 1, undefined, false, 'linear'),
  'effects.delay.delayTime': num(0, 2, 's'),
  'effects.delay.feedback': modNum(0, 0.95, undefined, false, 'linear'),
  'effects.delay.wet': modNum(0, 1, undefined, false, 'linear'),
  'effects.reverb.roomSize': num(0, 1),
  'effects.reverb.dampening': num(20, 20000, 'Hz'),
  'effects.reverb.wet': modNum(0, 1, undefined, false, 'linear'),

  // Five-band graphic EQ. The band CENTRES are fixed (EQ_BAND_FREQUENCIES) and are not
  // parameters — only the gains move, which is what makes it graphic rather than
  // parametric.
  'effects.eq.enabled': { kind: 'boolean' },
  'effects.eq.band0.gain': modNum(-18, 18, 'dB', false, 'linear'),
  'effects.eq.band1.gain': modNum(-18, 18, 'dB', false, 'linear'),
  'effects.eq.band2.gain': modNum(-18, 18, 'dB', false, 'linear'),
  'effects.eq.band3.gain': modNum(-18, 18, 'dB', false, 'linear'),
  'effects.eq.band4.gain': modNum(-18, 18, 'dB', false, 'linear'),

  'master.volume': num(LIMITS.masterVolume.min, LIMITS.masterVolume.max, 'dB'),
  'master.limiterThreshold': num(-40, 0, 'dB'),

  ...oscParamSpecs,
  ...lfoParamSpecs,
  ...routeParamSpecs,
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
      // Checked after the range so the error names the nearer problem first.
      if (spec.choices !== undefined && !spec.choices.includes(value)) {
        return {
          ok: false,
          error: `${path} expects one of [${spec.choices.join(', ')}], received ${value}`,
        };
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

export const AddOscillatorPayloadSchema = z.object({
  type: z.literal('addOscillator'),
  config: OscillatorConfigSchema,
});

export const RemoveOscillatorPayloadSchema = z.object({
  type: z.literal('removeOscillator'),
  oscillatorId: IdSchema,
});

export const AddLfoPayloadSchema = z.object({
  type: z.literal('addLfo'),
  config: LFOConfigSchema,
});

export const RemoveLfoPayloadSchema = z.object({
  type: z.literal('removeLfo'),
  lfoId: IdSchema,
});

/** F71 lives here: `ModRouteSchema.destination` is the declared vocabulary, nothing wider. */
export const AddRoutePayloadSchema = z.object({
  type: z.literal('addRoute'),
  route: ModRouteSchema,
});

export const RemoveRoutePayloadSchema = z.object({
  type: z.literal('removeRoute'),
  routeId: IdSchema,
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
  addOscillator: AddOscillatorPayloadSchema,
  removeOscillator: RemoveOscillatorPayloadSchema,
  addLfo: AddLfoPayloadSchema,
  removeLfo: RemoveLfoPayloadSchema,
  addRoute: AddRoutePayloadSchema,
  removeRoute: RemoveRoutePayloadSchema,
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
 * The four destinations a version-1 LFO could name, mapped to the addresses that replaced
 * them. `amplitude` and `pan` had no parameter address at all in v1 — they were voice
 * properties with nothing in the document pointing at them, which is why v2 adds
 * `voice.amplitude` and `voice.pan` as real, declared base values.
 */
const V1_LFO_TARGET_TO_DESTINATION: Record<string, ModDestination> = {
  filterFrequency: 'voice.filterEnvelope.baseFrequency',
  pitch: 'voice.oscillators.0.detune',
  amplitude: 'voice.amplitude',
  pan: 'voice.pan',
};

/**
 * Rebuild a v1 LFO's `target`/`min`/`max` as a route.
 *
 * The one place this is an approximation rather than a translation: a v1 LFO named an
 * absolute min and max, so it could sweep asymmetrically about the patch's base value.
 * A route swings symmetrically by `depth x range`. Travel distance is therefore preserved
 * exactly and any asymmetric offset is not. Reproducing the offset would need a `bias`
 * slot, which KIND-synth_mod_route §2 deliberately does not declare — and no shipped
 * factory patch uses an asymmetric sweep, so nothing real loses its sound here.
 */
function routeFromLegacyLfo(lfo: Record<string, unknown>, index: number): ModRoute | null {
  const destination = V1_LFO_TARGET_TO_DESTINATION[String(lfo.target)];
  if (destination === undefined) return null;
  const spec = PARAM_SPECS[destination];
  const min = typeof lfo.min === 'number' ? lfo.min : 0;
  const max = typeof lfo.max === 'number' ? lfo.max : 0;
  const range = spec.kind === 'number' ? spec.max - spec.min : 1;
  const depth = range === 0 ? 0 : Math.min(1, Math.abs(max - min) / range);
  return {
    id: typeof lfo.id === 'string' ? `${lfo.id}-route` : `migrated-route-${index}`,
    enabled: lfo.enabled === true,
    source: `lfo.${Math.min(index, MAX_LFOS - 1) as 0 | 1 | 2 | 3}`,
    destination,
    depth,
  };
}

/** The v1 -> v2 step: routing, EQ, and the two new per-voice base values. */
function migratePresetV1ToV2(doc: Record<string, unknown>): void {
  const voice = doc.voice;
  if (typeof voice !== 'object' || voice === null) return;
  const v = voice as Record<string, unknown>;

  // The decoy cutoff. In a MonoSynth the filter envelope owns the frequency, so this
  // field never reached the audio graph — dropping it loses nothing that ever sounded.
  if (typeof v.filter === 'object' && v.filter !== null) {
    const filter = { ...(v.filter as Record<string, unknown>) };
    delete filter.frequency;
    v.filter = filter;
  }

  const legacyLfos = Array.isArray(v.lfos) ? (v.lfos as Record<string, unknown>[]) : [];
  const routes: ModRoute[] = [];
  v.lfos = legacyLfos.map((lfo, index) => {
    const route = routeFromLegacyLfo(lfo, index);
    if (route !== null && routes.length < MAX_ROUTES) routes.push(route);
    const { target: _target, min: _min, max: _max, ...rest } = lfo;
    return rest;
  });
  if (v.modRoutes === undefined) v.modRoutes = routes;

  if (v.amplitude === undefined) v.amplitude = 1;
  if (v.pan === undefined) v.pan = 0;

  if (typeof doc.effects === 'object' && doc.effects !== null) {
    const effects = doc.effects as Record<string, unknown>;
    if (effects.eq === undefined) {
      effects.eq = {
        enabled: false,
        band0: { gain: 0 },
        band1: { gain: 0 },
        band2: { gain: 0 },
        band3: { gain: 0 },
        band4: { gain: 0 },
      };
    }
  }
}

/**
 * v2 -> v3: the single `oscillator` dict becomes a one-entry `oscillators` list.
 *
 * The three fields the slot gained are written at the values that make them inaudible —
 * `level: 1`, `pan: 0`, `octave: 0` — because F65 at version 3 asks for more than slot
 * preservation: a v2 patch and its migrated form must SOUND the same. Anything else here
 * would be a tone decision applied to somebody's saved patch without asking.
 *
 * Routes move too. A stored route addressed at `voice.oscillator.detune` names an address
 * that no longer exists, and F71 refuses undeclared destinations at the boundary — so a
 * migration that left them alone would produce a document that validates as a patch and
 * fails as a command payload, which is the worst of both.
 */
function migratePresetV2ToV3(doc: Record<string, unknown>): void {
  const voice = doc.voice as Record<string, unknown> | undefined;
  if (voice === undefined || voice === null) return;

  const legacy = voice.oscillator as Record<string, unknown> | undefined;
  if (legacy !== undefined && voice.oscillators === undefined) {
    voice.oscillators = [
      {
        id: 'osc-0',
        enabled: true,
        octave: 0,
        level: 1,
        pan: 0,
        ...legacy,
      },
    ];
  }
  delete voice.oscillator;

  const routes = voice.modRoutes;
  if (Array.isArray(routes)) {
    for (const route of routes) {
      const entry = route as Record<string, unknown>;
      if (typeof entry.destination !== 'string') continue;
      if (entry.destination.startsWith('voice.oscillator.')) {
        entry.destination = entry.destination.replace('voice.oscillator.', 'voice.oscillators.0.');
      }
    }
  }
}

/**
 * F65 — a legacy patch migrates forward losslessly; an unknown FUTURE version is refused
 * explicitly rather than silently coerced.
 *
 * Note the defaulting rule, which the v2 bump exposed as a latent bug: a document with no
 * `schemaVersion` is a version-ONE document, not a current one. Defaulting it to
 * `PRESET_SCHEMA_VERSION` was harmless while that constant was 1 and would have silently
 * skipped every migration step the moment it moved.
 */
export function migratePreset(raw: unknown): MigrationResult<unknown> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'preset must be an object' };
  const doc = structuredClone(raw) as Record<string, unknown>;
  const version = doc.schemaVersion;
  if (version === undefined) doc.schemaVersion = 1;
  else if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { ok: false, error: 'preset schemaVersion must be an integer' };
  } else if (version > PRESET_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `preset schemaVersion ${version} is newer than this build understands (${PRESET_SCHEMA_VERSION})`,
    };
  }

  // Steps run in order and each is unconditional once entered, so a v1 document walks
  // 1 -> 2 -> 3 rather than jumping. A migration that skipped an intermediate step would
  // have to know every earlier shape, which is how migration chains rot.
  if (doc.schemaVersion === 1) {
    migratePresetV1ToV2(doc);
    doc.schemaVersion = 2;
  }
  if (doc.schemaVersion === 2) {
    migratePresetV2ToV3(doc);
    doc.schemaVersion = 3;
  }
  // 3 -> 4 has no step. Depth widened from 0..1 to -1..1, so every v3 document is already
  // a valid v4 one and there is nothing to rewrite. The step is written out rather than
  // omitted because the chain above is read as a ledger of shapes, and a version silently
  // missing from it looks like the bug it is elsewhere.
  if (doc.schemaVersion === 3) {
    doc.schemaVersion = 4;
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
