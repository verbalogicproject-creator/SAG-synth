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
  type LFOConfig,
  type LoopRegion,
  type MasterConfig,
  type ModRoute,
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

/** One synth channel's keys and voices (cycle 2, C5): each channel has its own pool. */
export interface ChannelTransient {
  heldNotes: Map<NoteName, HeldNote>;
  voices: VoiceSlot[];
}

export interface TransientState {
  /** The live patch's keys — every `noteOn` sent without a `trackId`. */
  heldNotes: Map<NoteName, HeldNote>;
  voices: VoiceSlot[];
  /**
   * Per synth channel, keyed by track id. A channel's notes allocate from that channel's
   * polyphony and can never steal a voice from another channel or from the live patch.
   */
  channels: Map<string, ChannelTransient>;
  /** Increments on every note-on, on any channel; supplies `HeldNote.order`. */
  noteCounter: number;
}

export function initialTransientState(): TransientState {
  return { heldNotes: new Map(), voices: [], channels: new Map(), noteCounter: 0 };
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

/**
 * What a fresh LFO is, declared once.
 *
 * **No id**, because core is forbidden from minting one: an id invented inside a reducer
 * would differ on replay and break the journal. The caller adds it, exactly as
 * `OscillatorGroup` does for a new oscillator slot.
 *
 * This exists because two places already had their own literal opinion of a starting LFO —
 * the debug wall's `addLfo` button and, shortly, the instrument's. Two uncoordinated
 * answers to "what is an LFO by default" is the same shape as the duplicated `cutoff`
 * labels and the hand-maintained wired-destination list, both of which drifted.
 */
export function defaultLfo(): Omit<LFOConfig, 'id'> {
  return { enabled: true, type: 'sine', frequency: 4, sync: false, retrigger: false };
}

/**
 * What a fresh route is, declared once. Same no-id rule as `defaultLfo`.
 *
 * **`hasLfo` is not a preference, it is a correctness argument.** `reduce.ts` refuses a route
 * whose source names an empty LFO slot, and the factory patch ships `lfos: []` — so a route
 * born pointing at `lfo.0` is rejected on every fresh patch, which is exactly how the
 * instrument's `+ route` button came to be a decoy. Velocity needs no slot and always works,
 * so it is what a patch with no LFOs gets.
 *
 * The debug wall had already worked this out and the instrument had its own copy that had
 * not. That is the whole reason this lives in core: two literals, one of them wrong.
 */
export function defaultRoute(hasLfo: boolean): Omit<ModRoute, 'id'> {
  return {
    enabled: true,
    source: hasLfo ? 'lfo.0' : 'velocity',
    // The cutoff is the one every player reaches for first.
    destination: 'voice.filterEnvelope.baseFrequency',
    depth: 0.3,
  };
}

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
    // hold 0 + exponential decay: the ADSR this patch has always had (schema_version 5).
    envelope: { attack: 0.01, hold: 0, decay: 0.2, decayCurve: 'exponential', sustain: 0.4, release: 0.8 },
    filter: { type: 'lowpass', Q: 1, rolloff: -24, drive: 0 },
    filterEnvelope: {
      attack: 0.02,
      hold: 0,
      decay: 0.3,
      decayCurve: 'exponential',
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
      linked: false,
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

export const PSY_ROLL_PRESET_ID = 'factory-psy-roll';

/**
 * A rolling psytrance bass, built from the recipes rather than from taste — every value
 * below cites where it came from, and every one is a starting point for Eyal's ear, which
 * is the only gate that can say it sounds right.
 *
 * - **Two layers in one voice.** The genre builds the bass from a sine sub plus a
 *   filtered saw on top (myloops.net). Slot B is the sub at the note's own fundamental —
 *   the pattern sits at G1 (~49 Hz), so the note IS the sub; there is no octave-down
 *   layer to add. Slot A is the saw, "barely detuned — one or two unison voices".
 * - **Click, hold, then gone before the next 16th.** Eyal's AHDSR recipe: amp A 0 (the
 *   click — with the oscillator phase reset on every note, a zero attack is a clean, identical
 *   transient), H 30 ms (the body behind it), D 60 ms exponential, S 0. The filter envelope
 *   opens with the click and holds 15 ms before its 40 ms fall. At 145 BPM a 16th is 103 ms;
 *   0 + 30 + 60 = 90 ms, so each note is gone before the next or the roll smears. Sustain 0
 *   also stops the oscillators after A+H+D (the runtime's zero-sustain stop), so a rolling
 *   bass costs nothing between notes.
 * - **Cutoff 350 Hz, about an octave of envelope.** "Lowpass, cutoff 400 Hz–1 kHz, filter
 *   envelope depth roughly an octave". Velocity adds up to one more octave, so the softer
 *   first note after each kick is also darker — the roll's forward lean.
 * - **Mud cut.** EQ −3 dB at 250 and 530 Hz, the 300–500 Hz region every source says to
 *   clear. The EQ's lowest band is 250 Hz; a 30 Hz low-cut and 55–120 Hz shaping are
 *   gaps the ear pass will judge.
 * - **Everything wide or wet is off.** Chorus, delay and reverb would put the sub in
 *   stereo and smear the gaps. Distortion is off too: the recipe saturates only the top
 *   layer, above a 100–150 Hz high-pass, and this engine's single chain would drive the
 *   sub with it. Whether that matters is for the ear.
 * - **Polyphony 2, no portamento.** Poly-retrigger, "never legato"; two voices cover the
 *   release tail of one note overlapping the next attack.
 *
 * Phone speakers roll off below ~500 Hz (see `defaultVoiceConfig`), so on the phone's own
 * speaker this is mostly its saw harmonics. Judge it on headphones.
 */
export function psyRollPreset(): SynthPreset {
  const voice = defaultVoiceConfig();
  const effects = defaultEffectsConfig();
  return {
    id: PSY_ROLL_PRESET_ID,
    name: 'Psy Roll',
    schemaVersion: PRESET_SCHEMA_VERSION,
    voice: {
      ...voice,
      oscillators: [
        { ...voice.oscillators[0]!, id: 'osc-0', type: 'sawtooth', count: 2, spread: 8, level: 0.6 },
        { ...voice.oscillators[0]!, id: 'osc-1', type: 'sine', count: 1, spread: 0, level: 0.7 },
      ],
      envelope: { attack: 0, hold: 0.03, decay: 0.06, decayCurve: 'exponential', sustain: 0, release: 0.03 },
      filter: { type: 'lowpass', Q: 2, rolloff: -24, drive: 0 },
      filterEnvelope: {
        attack: 0,
        hold: 0.015,
        decay: 0.04,
        decayCurve: 'exponential',
        sustain: 0,
        release: 0.03,
        baseFrequency: 350,
        octaves: 1.3,
        linked: false,
      },
      polyphony: 2,
      portamento: 0,
      velocity: { toAmplitude: 0.6, toFilterOctaves: 1 },
    },
    effects: {
      ...effects,
      eq: { ...effects.eq, enabled: true, band0: { gain: -3 }, band1: { gain: -3 } },
    },
    createdAt: FACTORY_EPOCH_MS,
    category: 'Bass',
    author: 'SAG-synth',
    factory: true,
    description: 'Rolling psytrance bass: sine sub + barely detuned saw, gone before the next 16th.',
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
  const psy = psyRollPreset();
  const song = defaultSong();
  return {
    schemaVersion: ENGINE_SCHEMA_VERSION,
    revision: 0,
    patch: preset,
    song,
    presets: { [preset.id]: preset, [psy.id]: psy },
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
