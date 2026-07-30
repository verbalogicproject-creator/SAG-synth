/**
 * src/core/state.ts — the engine state shape, its initial value, and the transient
 * (non-reducer) state that the latency hot path owns.
 *
 * The split matters. F59 says: replaying every `status: "applied"` command through the
 * pure reducer from `initialEngineState()` yields state deep-equal to the live engine.
 * `noteOn` / `noteOff` bypass the reducer, so anything they touch MUST live outside
 * `EngineState` or F59 becomes unsatisfiable. Held notes and voice slots are therefore
 * `TransientState`, never serialized, never journaled into the reducer's world.
 */

import {
  PRESET_SCHEMA_VERSION,
  SONG_SCHEMA_VERSION,
  STEPS_PER_BEAT,
  type Beats,
  type EffectsConfig,
  type LoopRegion,
  type MasterConfig,
  type NoteName,
  type Song,
  type SongTrack,
  type SynthPreset,
  type Unit,
  type VoiceConfig,
} from './types';

export const ENGINE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Reducer state
// ---------------------------------------------------------------------------

export type TransportStatus = 'stopped' | 'playing' | 'paused';

/**
 * Only what a command can set. The playhead is deliberately absent: it advances in
 * the audio clock, not in the reducer, so it would break replay determinism. Read it
 * from `RuntimeReadout.getPlayhead()`.
 */
export interface TransportState {
  status: TransportStatus;
}

export interface EngineState {
  schemaVersion: number;
  /** Advanced by every accepted non-hot-path command. Never advanced on rejection (F61). */
  revision: number;
  /** The live patch — what the voice pool is currently voicing. */
  patch: SynthPreset;
  /** The live song — what the transport is currently sequencing. */
  song: Song;
  /** Preset library, keyed by patch id. Seeded with the factory bundle. */
  presets: Record<string, SynthPreset>;
  /** Song library, keyed by song id. */
  songs: Record<string, Song>;
  transport: TransportState;
}

// ---------------------------------------------------------------------------
// Transient state — hot path only, outside the reducer
// ---------------------------------------------------------------------------

export type VoiceId = number;

export interface HeldNote {
  note: NoteName;
  velocity: Unit;
  /** Monotonic counter at note-on; the ordering key for the 'oldest' steal policy. */
  order: number;
}

export interface VoiceSlot {
  voiceId: VoiceId;
  note: NoteName;
  velocity: Unit;
  order: number;
}

export interface TransientState {
  heldNotes: Map<NoteName, HeldNote>;
  voices: VoiceSlot[];
  /** Increments on every note-on; supplies `HeldNote.order`. */
  noteCounter: number;
}

export function initialTransientState(): TransientState {
  return { heldNotes: new Map(), voices: [], noteCounter: 0 };
}

export interface AllocationResult {
  voiceId: VoiceId;
  /** The voice that had to be released to make room, when the pool was full. */
  stolen?: VoiceSlot;
}

/**
 * Decision D1 — allocation and stealing are a PURE FUNCTION in core; the runtime only
 * executes the verdict. This is the signature Phase 2 implements; declaring it here
 * stops two parallel agents from inventing incompatible allocators.
 */
export type Allocator = (
  voices: readonly VoiceSlot[],
  cap: number,
  policy: VoiceConfig['stealPolicy'],
  request: { note: NoteName; velocity: Unit; order: number },
) => AllocationResult;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Fixed identity and timestamp. `initialEngineState()` must be a pure constant so two
 * replays of the same journal produce byte-identical state; a generated uuid or
 * `Date.now()` here would silently break F59.
 */
export const DEFAULT_PRESET_ID = 'factory-default';
export const DEFAULT_SONG_ID = 'song-default';
export const DEFAULT_TRACK_ID = 'track-1';
/** 2026-01-01T00:00:00Z — a constant epoch for the shipped factory bundle. */
export const FACTORY_EPOCH_MS = 1767225600000;

export function defaultVoiceConfig(): VoiceConfig {
  return {
    // ONE slot, not three. The cap is what a patch may hold, not what it must: a
    // single-oscillator factory patch costs exactly what it did before the bump, and a
    // second slot is something a player adds when they want it.
    //
    // width 0 is a square wave in Tone's convention — the neutral value. It was 0.5,
    // which reads neutral and is a 75% duty cycle.
    oscillators: [
      {
        id: 'osc-0',
        enabled: true,
        type: 'sawtooth',
        octave: 0,
        detune: 0,
        count: 1,
        spread: 20,
        width: 0,
        // Unity and centred, for the same reason `amplitude` is: these are base values a
        // route swings around, so a non-neutral default would quietly bias every patch.
        level: 1,
        pan: 0,
      },
    ],
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.8 },
    filter: { type: 'lowpass', Q: 1, rolloff: -24 },
    filterEnvelope: {
      attack: 0.02,
      decay: 0.3,
      // Measured, not taste: at baseFrequency 300 with sustain 0.2 the filter settles at
      // 300 x 2^0.6 ~= 455Hz, which left the factory patch with ZERO energy above 1kHz
      // and half the loudness of a bare Tone MonoSynth. Phone speakers roll off hard
      // below ~500Hz, so the shipped default was effectively inaudible on the device
      // this is developed on. 800Hz settling to 800 x 2^1.8 ~= 2.8kHz keeps the sweep
      // dramatic while staying in a range a small speaker can reproduce.
      sustain: 0.6,
      release: 0.5,
      baseFrequency: 800,
      octaves: 3,
    },
    lfos: [],
    modRoutes: [],
    polyphony: 8,
    portamento: 0,
    stealPolicy: 'oldest',
    velocity: { toAmplitude: 1, toFilterOctaves: 1 },
    // Unity gain, centred. These are the base values modulation routes swing around, so
    // the defaults must be neutral: a tremolo route on a voice already at 0.5 would
    // quietly halve the patch.
    amplitude: 1,
    pan: 0,
  };
}

export function defaultEffectsConfig(): EffectsConfig {
  return {
    // 0.5, and measured rather than picked. Distortion ships DISABLED, so this is not a
    // neutral resting value the way a flat EQ is — it is what you get the moment you
    // switch it on, and "on" has to be unmistakably on. At the previous 0.2 the crest
    // factor fell 16% and the effect was reported from the device as not working, three
    // times. At 0.5 it falls 43% with the level moving 0.1 dB: the sound changes and the
    // loudness does not. `audible the moment it is switched on` gates this.
    distortion: { enabled: false, amount: 0.5, wet: 1 },
    chorus: { enabled: false, frequency: 4, delayTime: 2.5, depth: 0.5, wet: 0.5 },
    delay: { enabled: false, delayTime: 0.25, feedback: 0.3, wet: 0.3 },
    reverb: { enabled: false, roomSize: 0.7, dampening: 3000, wet: 0.3 },
    // Flat and off. An EQ that ships with a curve is a tone decision hiding in a default.
    eq: {
      enabled: false,
      band0: { gain: 0 },
      band1: { gain: 0 },
      band2: { gain: 0 },
      band3: { gain: 0 },
      band4: { gain: 0 },
    },
  };
}

export function defaultMasterConfig(): MasterConfig {
  return { volume: -6, limiterThreshold: -1 };
}

export function defaultLoopRegion(): LoopRegion {
  return { enabled: false, start: 0, end: 4 };
}

export function defaultPreset(): SynthPreset {
  return {
    id: DEFAULT_PRESET_ID,
    name: 'Init Saw',
    schemaVersion: PRESET_SCHEMA_VERSION,
    voice: defaultVoiceConfig(),
    effects: defaultEffectsConfig(),
    createdAt: FACTORY_EPOCH_MS,
    category: 'Lead',
    author: 'SAG-synth',
    factory: true,
    description: 'Bright sawtooth lead with a moving filter — the blank canvas patch.',
  };
}

export function defaultTrack(preset: SynthPreset = defaultPreset()): SongTrack {
  return {
    id: DEFAULT_TRACK_ID,
    name: 'Track 1',
    presetId: preset.id,
    presetSnapshot: preset,
    notes: [],
    patternLength: 16,
    volume: 0,
    pan: 0,
    muted: false,
    solo: false,
  };
}

export function defaultSong(): Song {
  return {
    id: DEFAULT_SONG_ID,
    name: 'Untitled',
    schemaVersion: SONG_SCHEMA_VERSION,
    bpm: 120,
    timeSignature: 4,
    swing: 0,
    swingSubdivision: '16n',
    tracks: [defaultTrack()],
    master: defaultMasterConfig(),
    loop: defaultLoopRegion(),
    createdAt: FACTORY_EPOCH_MS,
    updatedAt: FACTORY_EPOCH_MS,
  };
}

export function initialEngineState(): EngineState {
  const preset = defaultPreset();
  const song = defaultSong();
  return {
    schemaVersion: ENGINE_SCHEMA_VERSION,
    revision: 0,
    patch: preset,
    song,
    presets: { [preset.id]: preset },
    songs: {},
    transport: { status: 'stopped' },
  };
}

// ---------------------------------------------------------------------------
// Grid <-> beats projection
// ---------------------------------------------------------------------------

/** Step index -> musical position. The 16-step grid is a view, not a store. */
export function stepToBeats(stepIndex: number): Beats {
  return stepIndex / STEPS_PER_BEAT;
}

/** Musical position -> the step that contains it. */
export function beatsToStep(beats: Beats): number {
  return Math.floor(beats * STEPS_PER_BEAT);
}

/** Effects are applied in this order by the runtime; core only records it. */
export { EFFECT_CHAIN_ORDER } from './types';
