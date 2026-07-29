/**
 * src/core/commands.ts — the complete command surface of SAG-synth.
 *
 * Decision D3: one command = one SAG event, and the event IS the command record
 * verbatim (not a summary). This union is therefore simultaneously
 *   - the UI's only way to mutate state,
 *   - the append-only journal's row payload,
 *   - the wire format of the v0.2 SAG-SDK.
 * Adding, renaming, or reshaping a member here is a wire-format change. The tripwire
 * test in src/tests/contract.test.ts fails loudly when this union moves.
 *
 * Imports nothing but sibling types (layer rule D2).
 */

import type {
  Beats,
  Decibels,
  EffectId,
  LFOConfig,
  NoteEvent,
  NoteName,
  ParamPath,
  ParamValue,
  ParamValueMap,
  PresetCategory,
  Song,
  SynthPreset,
  TrackParamPath,
  TrackParamValueMap,
  Unit,
} from './types';

// ---------------------------------------------------------------------------
// Patch commands
// ---------------------------------------------------------------------------

/** Exactly one of `presetId` / `preset` must be present — enforced by zod, not by TS. */
export interface LoadPresetCommand {
  type: 'loadPreset';
  presetId?: string;
  preset?: SynthPreset;
}

export interface SavePresetCommand {
  type: 'savePreset';
  name: string;
  category?: PresetCategory;
}

export interface DeletePresetCommand {
  type: 'deletePreset';
  presetId: string;
}

/**
 * `value` is widened to `ParamValue` deliberately. A per-path discriminated member
 * would push `SynthCommand` past 90 members and slow every downstream `switch`.
 * Call sites get exact typing from the `setParam()` helper below; the reducer gets
 * runtime typing from `PARAM_SPECS` in schemas.ts.
 */
export interface SetParamCommand {
  type: 'setParam';
  path: ParamPath;
  value: ParamValue;
}

export interface AddLfoCommand {
  type: 'addLfo';
  config: LFOConfig;
}

export interface RemoveLfoCommand {
  type: 'removeLfo';
  lfoId: string;
}

export interface SetEffectEnabledCommand {
  type: 'setEffectEnabled';
  effectId: EffectId;
  enabled: boolean;
}

/** Sugar for `setParam('master.volume', db)`; both are frozen in the surface. */
export interface SetMasterVolumeCommand {
  type: 'setMasterVolume';
  db: Decibels;
}

// ---------------------------------------------------------------------------
// Song commands
// ---------------------------------------------------------------------------

export interface NewSongCommand {
  type: 'newSong';
}

/** Exactly one of `songId` / `song` must be present. */
export interface LoadSongCommand {
  type: 'loadSong';
  songId?: string;
  song?: Song;
}

export interface SaveSongCommand {
  type: 'saveSong';
  name?: string;
}

export interface DeleteSongCommand {
  type: 'deleteSong';
  songId: string;
}

/** Raw `.synthsong.json` text; parsed and validated by the reducer, never trusted. */
export interface ImportSongFileCommand {
  type: 'importSongFile';
  json: string;
}

export interface AddTrackCommand {
  type: 'addTrack';
  /** Caller-supplied so replay reproduces track identity exactly. */
  trackId: string;
  presetId?: string;
  name?: string;
}

export interface RemoveTrackCommand {
  type: 'removeTrack';
  trackId: string;
}

export interface RenameTrackCommand {
  type: 'renameTrack';
  trackId: string;
  name: string;
}

export interface SetTrackParamCommand {
  type: 'setTrackParam';
  trackId: string;
  path: TrackParamPath;
  value: number | boolean;
}

/**
 * Toggles one cell of the 16-step grid. The grid is a projection: the reducer
 * materialises `active: true` into a `NoteEvent` at beat `stepIndex / STEPS_PER_BEAT`
 * and deletes the note covering that step on `active: false`. There is no separate
 * step store that could disagree with `track.notes`.
 */
export interface SetStepCommand {
  type: 'setStep';
  trackId: string;
  stepIndex: number;
  active: boolean;
  note?: NoteName;
  velocity?: Unit;
  /** Required when `active` is true so the materialised note has a stable identity. */
  noteId?: string;
}

export interface SetPatternLengthCommand {
  type: 'setPatternLength';
  trackId: string;
  length: number;
}

export interface AddNoteCommand {
  type: 'addNote';
  trackId: string;
  note: NoteEvent;
}

export interface RemoveNoteCommand {
  type: 'removeNote';
  trackId: string;
  noteId: string;
}

export interface SetTempoCommand {
  type: 'setTempo';
  bpm: number;
}

export interface SetSwingCommand {
  type: 'setSwing';
  amount: Unit;
}

export interface SetTimeSignatureCommand {
  type: 'setTimeSignature';
  n: number;
}

// ---------------------------------------------------------------------------
// Playback commands
// ---------------------------------------------------------------------------

export interface PlayCommand {
  type: 'play';
}

export interface StopCommand {
  type: 'stop';
}

export interface PauseCommand {
  type: 'pause';
}

export interface SetLoopCommand {
  type: 'setLoop';
  enabled: boolean;
  start?: Beats;
  end?: Beats;
}

/** Hot path — bypasses the reducer, does not advance `revision`. Still journaled. */
export interface NoteOnCommand {
  type: 'noteOn';
  note: NoteName;
  velocity: Unit;
}

/** Hot path — see NoteOnCommand. */
export interface NoteOffCommand {
  type: 'noteOff';
  note: NoteName;
}

/** All notes off, all voices released, transient state cleared. */
export interface PanicCommand {
  type: 'panic';
}

// ---------------------------------------------------------------------------
// MIDI commands
// ---------------------------------------------------------------------------

export interface ImportMidiCommand {
  type: 'importMidi';
  /** Base64 so the command stays JSON-serialisable and journal-replayable. */
  bytes: string;
  filename?: string;
  autoplay?: boolean;
}

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

export type SynthCommand =
  // patch
  | LoadPresetCommand
  | SavePresetCommand
  | DeletePresetCommand
  | SetParamCommand
  | AddLfoCommand
  | RemoveLfoCommand
  | SetEffectEnabledCommand
  | SetMasterVolumeCommand
  // song
  | NewSongCommand
  | LoadSongCommand
  | SaveSongCommand
  | DeleteSongCommand
  | ImportSongFileCommand
  | AddTrackCommand
  | RemoveTrackCommand
  | RenameTrackCommand
  | SetTrackParamCommand
  | SetStepCommand
  | SetPatternLengthCommand
  | AddNoteCommand
  | RemoveNoteCommand
  | SetTempoCommand
  | SetSwingCommand
  | SetTimeSignatureCommand
  // playback
  | PlayCommand
  | StopCommand
  | PauseCommand
  | SetLoopCommand
  | NoteOnCommand
  | NoteOffCommand
  | PanicCommand
  // midi
  | ImportMidiCommand;

export type SynthCommandType = SynthCommand['type'];

/** Narrow a `SynthCommand` to one member by its discriminant. */
export type CommandOf<T extends SynthCommandType> = Extract<SynthCommand, { type: T }>;

/**
 * Every command type name, as data. This array is the runtime half of the union and
 * the thing the drift tripwire snapshots. `satisfies` proves the two stay identical:
 * a member added to `SynthCommand` but not listed here fails to compile.
 */
export const SYNTH_COMMAND_TYPES = [
  'loadPreset',
  'savePreset',
  'deletePreset',
  'setParam',
  'addLfo',
  'removeLfo',
  'setEffectEnabled',
  'setMasterVolume',
  'newSong',
  'loadSong',
  'saveSong',
  'deleteSong',
  'importSongFile',
  'addTrack',
  'removeTrack',
  'renameTrack',
  'setTrackParam',
  'setStep',
  'setPatternLength',
  'addNote',
  'removeNote',
  'setTempo',
  'setSwing',
  'setTimeSignature',
  'play',
  'stop',
  'pause',
  'setLoop',
  'noteOn',
  'noteOff',
  'panic',
  'importMidi',
] as const satisfies readonly SynthCommandType[];

/** Compile-time completeness: fails if SYNTH_COMMAND_TYPES is missing a union member. */
type _CommandTypesAreExhaustive = Exclude<
  SynthCommandType,
  (typeof SYNTH_COMMAND_TYPES)[number]
> extends never
  ? true
  : ['MISSING FROM SYNTH_COMMAND_TYPES', Exclude<SynthCommandType, (typeof SYNTH_COMMAND_TYPES)[number]>];
const _commandTypesAreExhaustive: _CommandTypesAreExhaustive = true;
void _commandTypesAreExhaustive;

/**
 * Commands that take the latency hot path: they bypass the reducer, mutate only the
 * transient held-note set, call the runtime synchronously, journal asynchronously,
 * and do NOT advance `revision` (KIND-synth_command_applied §5).
 */
export const HOT_PATH_COMMAND_TYPES = ['noteOn', 'noteOff'] as const satisfies readonly SynthCommandType[];

export type HotPathCommandType = (typeof HOT_PATH_COMMAND_TYPES)[number];

export function isHotPathCommand(command: SynthCommand): boolean {
  return (HOT_PATH_COMMAND_TYPES as readonly string[]).includes(command.type);
}

// ---------------------------------------------------------------------------
// Dispatch envelope
// ---------------------------------------------------------------------------

/**
 * `'agent'` is the v0.2 SAG-SDK path. It is accepted by the envelope from v0.1.0
 * onward precisely so the SDK needs no domain change later.
 */
export type CommandSource = 'ui' | 'agent' | 'replay';

export const COMMAND_SOURCES = ['ui', 'agent', 'replay'] as const satisfies readonly CommandSource[];

export interface CommandEnvelope<C extends SynthCommand = SynthCommand> {
  /** uuid; stable across replay, becomes the event's `command_id`. */
  id: string;
  /** Epoch ms at dispatch. */
  ts: number;
  source: CommandSource;
  /** Mirrors `payload.type`; `assertEnvelopeConsistent` proves they agree. */
  type: C['type'];
  /** The command VERBATIM — F62 forbids dropping, defaulting, or normalising fields. */
  payload: C;
}

export type CommandStatus = 'applied' | 'rejected';

export interface CommandResult {
  commandId: string;
  status: CommandStatus;
  /** Present iff status is 'rejected' — zod message or invariant name. */
  error?: string;
  /** Engine revision AFTER this command; unchanged when rejected (F61). */
  revision: number;
}

/**
 * Pure envelope factory. `id` and `ts` are injected rather than generated so core
 * stays deterministic and replayable — a core that called `crypto.randomUUID()` or
 * `Date.now()` could not reproduce a journal.
 */
export function createEnvelope<C extends SynthCommand>(
  command: C,
  source: CommandSource,
  id: string,
  ts: number,
): CommandEnvelope<C> {
  return { id, ts, source, type: command.type as C['type'], payload: command };
}

/** F62 guard: the envelope's discriminant must not drift from the payload it carries. */
export function assertEnvelopeConsistent(envelope: CommandEnvelope): void {
  if (envelope.type !== envelope.payload.type) {
    throw new Error(
      `envelope.type "${envelope.type}" does not match payload.type "${envelope.payload.type}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Typed constructors (the ergonomic surface for the UI and the v0.2 SDK)
// ---------------------------------------------------------------------------

/** Exact per-path typing for `setParam`, which the widened command shape gives up. */
export function setParam<P extends ParamPath>(path: P, value: ParamValueMap[P]): SetParamCommand {
  return { type: 'setParam', path, value: value as ParamValue };
}

/** Exact per-path typing for `setTrackParam`. */
export function setTrackParam<P extends TrackParamPath>(
  trackId: string,
  path: P,
  value: TrackParamValueMap[P],
): SetTrackParamCommand {
  return { type: 'setTrackParam', trackId, path, value };
}

// ---------------------------------------------------------------------------
// Queries — read-only, emit nothing, never journaled
// ---------------------------------------------------------------------------

export type SynthQueryType =
  | 'getState'
  | 'listPresets'
  | 'listSongs'
  | 'exportSong'
  | 'exportPresetFile';

export const SYNTH_QUERY_TYPES = [
  'getState',
  'listPresets',
  'listSongs',
  'exportSong',
  'exportPresetFile',
] as const satisfies readonly SynthQueryType[];

export interface PresetSummary {
  id: string;
  name: string;
  category?: PresetCategory;
  factory: boolean;
  createdAt: number;
}

export interface SongSummary {
  id: string;
  name: string;
  bpm: number;
  trackCount: number;
  updatedAt: number;
}
