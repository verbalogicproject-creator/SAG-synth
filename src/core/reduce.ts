/**
 * src/core/reduce.ts — the only thing that changes EngineState.
 *
 * Pure: `reduce(state, command, meta)` returns a NEW state and never mutates the one it
 * was given. That is not a style preference. F59 says replaying every accepted command
 * from `initialEngineState()` must reproduce the live state exactly, and a single
 * in-place write anywhere makes the live state depend on history the journal does not
 * carry.
 *
 * Nothing here reads a clock or generates an id. Both come from `meta`, which the
 * dispatcher fills from the command envelope — and the envelope is journaled, so a
 * replay reconstructs the same values. A reducer that called `crypto.randomUUID()`
 * would produce a different preset id on every replay and silently fail F59.
 */

import {
  MAX_LFOS,
  SONG_SCHEMA_VERSION,
  STEPS_PER_BEAT,
  type Beats,
  type EffectId,
  type NoteEvent,
  type Song,
  type SongTrack,
  type SynthPreset,
} from './types';
import {
  defaultLoopRegion,
  defaultMasterConfig,
  stepToBeats,
  type EngineState,
} from './state';
import { advancesRevision, type SynthCommand } from './commands';
import { PARAM_SPECS, SongSchema, migrateSong, validateCommand } from './schemas';
import type { MidiImportPort } from './ports';

export interface ReduceMeta {
  /**
   * The dispatching envelope's id. Doubles as the identity for any document this
   * command creates (`savePreset`, `newSong`, imported tracks). Using the command id
   * rather than a fresh uuid is what makes creation replayable: the id is already in
   * the journal.
   */
  commandId: string;
  /** The envelope's epoch-ms timestamp; the source of every createdAt/updatedAt. */
  ts: number;
  /** Required only for `importMidi`; core cannot parse MIDI itself (layer rule D2). */
  midi?: MidiImportPort;
}

export type ReduceResult =
  | { status: 'applied'; state: EngineState; warnings?: string[] }
  | { status: 'rejected'; error: string };

const rejected = (error: string): ReduceResult => ({ status: 'rejected', error });

// ---------------------------------------------------------------------------
// Immutable helpers
// ---------------------------------------------------------------------------

/**
 * Immutable deep write along a validated parameter path.
 *
 * Precondition: `keys` came from a `ParamPath` that zod already checked against
 * PARAM_SPECS, so every segment is known to exist. That is what licenses the casts —
 * this is not a general-purpose setter and must not be exported.
 */
function deepSet(target: unknown, keys: readonly string[], value: unknown): unknown {
  if (keys.length === 0) return value;
  const [head, ...rest] = keys as [string, ...string[]];
  if (Array.isArray(target)) {
    const copy = [...(target as unknown[])];
    const index = Number(head);
    copy[index] = deepSet(copy[index], rest, value);
    return copy;
  }
  const record = target as Record<string, unknown>;
  return { ...record, [head]: deepSet(record[head], rest, value) };
}

function withSong(state: EngineState, song: Song): EngineState {
  return { ...state, song };
}

function withPatch(state: EngineState, patch: SynthPreset): EngineState {
  return { ...state, patch };
}

function findTrack(song: Song, trackId: string): SongTrack | undefined {
  return song.tracks.find((track) => track.id === trackId);
}

/** Replace one track by id, leaving every other track object untouched. */
function mapTrack(song: Song, trackId: string, fn: (track: SongTrack) => SongTrack): Song {
  return { ...song, tracks: song.tracks.map((track) => (track.id === trackId ? fn(track) : track)) };
}

/** The half-open beat window a grid step occupies. */
function stepWindow(stepIndex: number): { start: Beats; end: Beats } {
  const start = stepToBeats(stepIndex);
  return { start, end: start + 1 / STEPS_PER_BEAT };
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export function reduce(
  state: EngineState,
  command: SynthCommand,
  meta: ReduceMeta,
): ReduceResult {
  const applied = (next: EngineState, warnings?: string[]): ReduceResult => ({
    status: 'applied',
    state: advancesRevision(command) ? { ...next, revision: next.revision + 1 } : next,
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  });

  switch (command.type) {
    // -- patch ------------------------------------------------------------

    case 'loadPreset': {
      const preset = command.preset ?? (command.presetId ? state.presets[command.presetId] : undefined);
      if (preset === undefined) return rejected(`no preset with id "${command.presetId}"`);
      return applied(withPatch(state, structuredClone(preset)));
    }

    case 'savePreset': {
      const saved: SynthPreset = {
        ...structuredClone(state.patch),
        id: meta.commandId,
        name: command.name,
        createdAt: meta.ts,
        factory: false,
        // Provenance chain for the preset browser (KIND-synth_patch `derived_from`).
        derivedFrom: state.patch.id,
        ...(command.category === undefined ? {} : { category: command.category }),
      };
      return applied({
        ...state,
        patch: saved,
        presets: { ...state.presets, [saved.id]: saved },
      });
    }

    case 'deletePreset': {
      const existing = state.presets[command.presetId];
      if (existing === undefined) return rejected(`no preset with id "${command.presetId}"`);
      // Factory presets are the shipped bundle. Deleting one would leave the library in
      // a state a fresh install cannot reproduce, so replay could not rebuild it.
      if (existing.factory === true) return rejected(`preset "${command.presetId}" is a factory preset`);
      const presets = { ...state.presets };
      delete presets[command.presetId];
      return applied({ ...state, presets });
    }

    case 'setParam': {
      const segments = command.path.split('.');
      const [root, ...rest] = segments as [string, ...string[]];
      if (root === 'master') {
        return applied(withSong(state, deepSet(state.song, ['master', ...rest], command.value) as Song));
      }
      if (root === 'effects') {
        return applied(withPatch(state, deepSet(state.patch, segments, command.value) as SynthPreset));
      }
      // 'voice.lfos.<i>.<key>' addresses a slot that may not be filled — the path union
      // is fixed at MAX_LFOS but the array is not.
      if (segments[1] === 'lfos') {
        const index = Number(segments[2]);
        if (state.patch.voice.lfos[index] === undefined) {
          return rejected(`no LFO at index ${index}; add one with addLfo first`);
        }
      }
      return applied(withPatch(state, deepSet(state.patch, segments, command.value) as SynthPreset));
    }

    case 'addLfo': {
      const lfos = state.patch.voice.lfos;
      if (lfos.length >= MAX_LFOS) return rejected(`at most ${MAX_LFOS} LFOs per patch`);
      if (lfos.some((lfo) => lfo.id === command.config.id)) {
        return rejected(`an LFO with id "${command.config.id}" already exists`);
      }
      return applied(
        withPatch(state, {
          ...state.patch,
          voice: { ...state.patch.voice, lfos: [...lfos, structuredClone(command.config)] },
        }),
      );
    }

    case 'removeLfo': {
      const lfos = state.patch.voice.lfos;
      if (!lfos.some((lfo) => lfo.id === command.lfoId)) {
        return rejected(`no LFO with id "${command.lfoId}"`);
      }
      return applied(
        withPatch(state, {
          ...state.patch,
          voice: { ...state.patch.voice, lfos: lfos.filter((lfo) => lfo.id !== command.lfoId) },
        }),
      );
    }

    case 'setEffectEnabled': {
      const effectId: EffectId = command.effectId;
      return applied(
        withPatch(state, {
          ...state.patch,
          effects: {
            ...state.patch.effects,
            [effectId]: { ...state.patch.effects[effectId], enabled: command.enabled },
          },
        }),
      );
    }

    case 'setMasterVolume':
      return applied(
        withSong(state, { ...state.song, master: { ...state.song.master, volume: command.db } }),
      );

    // -- song -------------------------------------------------------------

    case 'newSong': {
      const track: SongTrack = {
        id: `${meta.commandId}-t1`,
        name: 'Track 1',
        presetId: state.patch.id,
        presetSnapshot: structuredClone(state.patch),
        notes: [],
        patternLength: 16,
        volume: 0,
        pan: 0,
        muted: false,
        solo: false,
      };
      const song: Song = {
        id: meta.commandId,
        name: 'Untitled',
        schemaVersion: SONG_SCHEMA_VERSION,
        bpm: 120,
        timeSignature: 4,
        swing: 0,
        swingSubdivision: '16n',
        tracks: [track],
        master: defaultMasterConfig(),
        loop: defaultLoopRegion(),
        createdAt: meta.ts,
        updatedAt: meta.ts,
      };
      return applied(withSong(state, song));
    }

    case 'loadSong': {
      const song = command.song ?? (command.songId ? state.songs[command.songId] : undefined);
      if (song === undefined) return rejected(`no song with id "${command.songId}"`);
      return applied(withSong(state, structuredClone(song)));
    }

    case 'saveSong': {
      const song: Song = {
        ...structuredClone(state.song),
        ...(command.name === undefined ? {} : { name: command.name }),
        updatedAt: meta.ts,
      };
      return applied({ ...state, song, songs: { ...state.songs, [song.id]: song } });
    }

    case 'deleteSong': {
      if (state.songs[command.songId] === undefined) {
        return rejected(`no song with id "${command.songId}"`);
      }
      const songs = { ...state.songs };
      delete songs[command.songId];
      return applied({ ...state, songs });
    }

    case 'importSongFile': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(command.json);
      } catch (error) {
        return rejected(`song file is not valid JSON: ${(error as Error).message}`);
      }
      const migrated = migrateSong(parsed);
      if (!migrated.ok) return rejected(migrated.error);
      const validated = SongSchema.safeParse(migrated.value);
      if (!validated.success) {
        const issue = validated.error.issues[0];
        return rejected(`song file rejected — ${issue?.path.join('.')}: ${issue?.message}`);
      }
      return applied(withSong(state, validated.data as Song));
    }

    case 'addTrack': {
      if (findTrack(state.song, command.trackId) !== undefined) {
        return rejected(`a track with id "${command.trackId}" already exists`);
      }
      const source = command.presetId === undefined ? state.patch : state.presets[command.presetId];
      if (source === undefined) return rejected(`no preset with id "${command.presetId}"`);
      const track: SongTrack = {
        id: command.trackId,
        name: command.name ?? `Track ${state.song.tracks.length + 1}`,
        presetId: source.id,
        presetSnapshot: structuredClone(source),
        notes: [],
        patternLength: 16,
        volume: 0,
        pan: 0,
        muted: false,
        solo: false,
      };
      return applied(withSong(state, { ...state.song, tracks: [...state.song.tracks, track] }));
    }

    case 'removeTrack': {
      if (findTrack(state.song, command.trackId) === undefined) {
        return rejected(`no track with id "${command.trackId}"`);
      }
      return applied(
        withSong(state, {
          ...state.song,
          tracks: state.song.tracks.filter((track) => track.id !== command.trackId),
        }),
      );
    }

    case 'renameTrack': {
      if (findTrack(state.song, command.trackId) === undefined) {
        return rejected(`no track with id "${command.trackId}"`);
      }
      return applied(
        withSong(state, mapTrack(state.song, command.trackId, (track) => ({ ...track, name: command.name }))),
      );
    }

    case 'setTrackParam': {
      if (findTrack(state.song, command.trackId) === undefined) {
        return rejected(`no track with id "${command.trackId}"`);
      }
      return applied(
        withSong(
          state,
          mapTrack(state.song, command.trackId, (track) => ({ ...track, [command.path]: command.value })),
        ),
      );
    }

    case 'setStep': {
      const track = findTrack(state.song, command.trackId);
      if (track === undefined) return rejected(`no track with id "${command.trackId}"`);
      if (command.stepIndex >= track.patternLength) {
        return rejected(`step ${command.stepIndex} is beyond the pattern length ${track.patternLength}`);
      }
      const { start, end } = stepWindow(command.stepIndex);
      // Clear the window first either way, so toggling a step on twice replaces the note
      // rather than stacking a second one at the same beat.
      const kept = track.notes.filter((note) => note.time < start || note.time >= end);
      const notes: NoteEvent[] = command.active
        ? [
            ...kept,
            {
              noteId: command.noteId!,
              time: start,
              duration: 1 / STEPS_PER_BEAT,
              note: command.note ?? 'C4',
              velocity: command.velocity ?? 0.8,
            },
          ].sort((a, b) => a.time - b.time || a.noteId.localeCompare(b.noteId))
        : kept;
      return applied(withSong(state, mapTrack(state.song, command.trackId, (t) => ({ ...t, notes }))));
    }

    case 'setPatternLength': {
      if (findTrack(state.song, command.trackId) === undefined) {
        return rejected(`no track with id "${command.trackId}"`);
      }
      // Notes past the new end are KEPT, not truncated. Shortening a pattern is a view
      // change; silently destroying notes on a mis-drag would be unrecoverable, and
      // lengthening again brings them back.
      return applied(
        withSong(
          state,
          mapTrack(state.song, command.trackId, (track) => ({ ...track, patternLength: command.length })),
        ),
      );
    }

    case 'addNote': {
      const track = findTrack(state.song, command.trackId);
      if (track === undefined) return rejected(`no track with id "${command.trackId}"`);
      if (track.notes.some((note) => note.noteId === command.note.noteId)) {
        return rejected(`a note with id "${command.note.noteId}" already exists on this track`);
      }
      const notes = [...track.notes, structuredClone(command.note)].sort(
        (a, b) => a.time - b.time || a.noteId.localeCompare(b.noteId),
      );
      return applied(withSong(state, mapTrack(state.song, command.trackId, (t) => ({ ...t, notes }))));
    }

    case 'removeNote': {
      const track = findTrack(state.song, command.trackId);
      if (track === undefined) return rejected(`no track with id "${command.trackId}"`);
      if (!track.notes.some((note) => note.noteId === command.noteId)) {
        return rejected(`no note with id "${command.noteId}" on track "${command.trackId}"`);
      }
      return applied(
        withSong(
          state,
          mapTrack(state.song, command.trackId, (t) => ({
            ...t,
            notes: t.notes.filter((note) => note.noteId !== command.noteId),
          })),
        ),
      );
    }

    case 'setTempo':
      return applied(withSong(state, { ...state.song, bpm: command.bpm }));

    case 'setSwing':
      return applied(withSong(state, { ...state.song, swing: command.amount }));

    case 'setTimeSignature':
      return applied(withSong(state, { ...state.song, timeSignature: command.n }));

    // -- playback ---------------------------------------------------------

    case 'play':
      return applied({ ...state, transport: { status: 'playing' } });

    case 'stop':
      return applied({ ...state, transport: { status: 'stopped' } });

    case 'pause':
      // Pausing a stopped transport is a no-op rather than a rejection: it is a
      // harmless double-press, not an error worth surfacing to the user.
      return applied(
        state.transport.status === 'playing' ? { ...state, transport: { status: 'paused' } } : state,
      );

    case 'setLoop':
      return applied(
        withSong(state, {
          ...state.song,
          loop: {
            enabled: command.enabled,
            start: command.start ?? state.song.loop.start,
            end: command.end ?? state.song.loop.end,
          },
        }),
      );

    // Transient: these drive the runtime and TransientState only. Returning state
    // unchanged is what makes replaying them a no-op, which F59 requires.
    case 'seek':
    case 'noteOn':
    case 'noteOff':
    case 'panic':
      return applied(state);

    // -- midi -------------------------------------------------------------

    case 'importMidi': {
      if (meta.midi === undefined) {
        return rejected('importMidi requires a MidiImportPort; none was supplied to the reducer');
      }
      let bytes: Uint8Array;
      try {
        const binary = atob(command.bytes);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      } catch (error) {
        return rejected(`could not decode MIDI bytes: ${(error as Error).message}`);
      }
      let song: Song;
      let warnings: string[];
      try {
        // Every id derives from the command id, so a replay of this command rebuilds
        // byte-identical tracks and notes.
        const result = meta.midi.import(bytes, {
          songId: meta.commandId,
          trackIdFor: (trackIndex) => `${meta.commandId}-t${trackIndex}`,
          noteIdFor: (trackIndex, noteIndex) => `${meta.commandId}-t${trackIndex}n${noteIndex}`,
          defaultPreset: state.patch,
          createdAt: meta.ts,
          ...(command.filename === undefined ? {} : { filename: command.filename }),
        });
        song = result.song;
        warnings = result.warnings.map((warning) => `${warning.code}: ${warning.message}`);
      } catch (error) {
        return rejected(`MIDI import failed: ${(error as Error).message}`);
      }
      const validated = SongSchema.safeParse(song);
      if (!validated.success) {
        const issue = validated.error.issues[0];
        return rejected(`imported song rejected — ${issue?.path.join('.')}: ${issue?.message}`);
      }
      return applied(withSong(state, validated.data as Song), warnings);
    }
  }
}

/**
 * Validate then reduce — the path the dispatcher uses. Splitting them keeps `reduce`
 * usable on already-trusted input during replay, where re-validating every command
 * would double the cost of rebuilding a long journal.
 */
export function validateAndReduce(
  state: EngineState,
  input: unknown,
  meta: ReduceMeta,
): ReduceResult {
  const validation = validateCommand(input);
  if (!validation.ok) return rejected(validation.error);
  return reduce(state, validation.command, meta);
}

/** Every parameter path the reducer can write. Exported for the UI's control binding. */
export const WRITABLE_PARAM_PATHS = Object.keys(PARAM_SPECS);
