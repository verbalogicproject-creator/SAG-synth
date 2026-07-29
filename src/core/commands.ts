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

/**
 * Move the playhead. Drives the runtime without touching `EngineState` — the playhead
 * lives in the audio clock, not the reducer — so it does not advance `revision`.
 */
export interface SeekCommand {
  type: 'seek';
  position: Beats;
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
// History commands
// ---------------------------------------------------------------------------

/**
 * Undo and redo are journaled like everything else, but the REDUCER never sees them —
 * `src/core/history.ts` interprets them by moving whole states between past and future.
 *
 * They exist as verbs rather than as a client-side cursor because of F59. If undo were
 * invisible to the journal, replaying it would rebuild the pre-undo state and live
 * state would silently disagree with its own history; an undo would also not survive a
 * reload. Journaling them keeps the journal the single truth, at the cost of two verbs.
 */
export interface UndoCommand {
  type: 'undo';
}

export interface RedoCommand {
  type: 'redo';
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
  | SeekCommand
  | SetLoopCommand
  | NoteOnCommand
  | NoteOffCommand
  | PanicCommand
  // midi
  | ImportMidiCommand
  // history
  | UndoCommand
  | RedoCommand;

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
  'seek',
  'setLoop',
  'noteOn',
  'noteOff',
  'panic',
  'importMidi',
  'undo',
  'redo',
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
 * Commands that drive the runtime without mutating `EngineState`, and therefore do NOT
 * advance `revision` (KIND-synth_command_applied §5). They are still validated, still
 * journaled, and still consume a `seq` — they are performance and playback gestures,
 * not document edits.
 *
 * `seek` and `panic` are here for the same structural reason as the note commands:
 * the playhead lives in the audio clock and held notes live in `TransientState`, so
 * neither has anything in `EngineState` to change. Replaying them through the reducer
 * is a no-op, which is exactly what F59 needs.
 */
export const TRANSIENT_COMMAND_TYPES = [
  'noteOn',
  'noteOff',
  'seek',
  'panic',
] as const satisfies readonly SynthCommandType[];

export type TransientCommandType = (typeof TRANSIENT_COMMAND_TYPES)[number];

/**
 * The latency subset of the above: these additionally bypass the dispatcher entirely,
 * calling the runtime synchronously and journaling asynchronously. Widening this set
 * changes the engine's latency profile; widening TRANSIENT_COMMAND_TYPES changes what
 * `revision` means. They are deliberately separate lists.
 */
export const HOT_PATH_COMMAND_TYPES = ['noteOn', 'noteOff'] as const satisfies readonly TransientCommandType[];

export type HotPathCommandType = (typeof HOT_PATH_COMMAND_TYPES)[number];

export function isHotPathCommand(command: SynthCommand): boolean {
  return (HOT_PATH_COMMAND_TYPES as readonly string[]).includes(command.type);
}

/**
 * Undo and redo RESTORE a revision rather than advancing one, and they are the only
 * commands the reducer refuses outright — `src/core/history.ts` handles them, because
 * they need the state stack and the reducer must stay a pure function of one state.
 */
export const HISTORY_COMMAND_TYPES = ['undo', 'redo'] as const satisfies readonly SynthCommandType[];

export type HistoryCommandType = (typeof HISTORY_COMMAND_TYPES)[number];

export function isHistoryCommand(command: SynthCommand): boolean {
  return (HISTORY_COMMAND_TYPES as readonly string[]).includes(command.type);
}

/** True when an accepted command bumps `EngineState.revision`. */
export function advancesRevision(command: SynthCommand): boolean {
  if (isHistoryCommand(command)) return false;
  return !(TRANSIENT_COMMAND_TYPES as readonly string[]).includes(command.type);
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
