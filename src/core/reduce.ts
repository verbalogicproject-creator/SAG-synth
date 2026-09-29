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
  MAX_OSCILLATORS,
  MAX_ROUTES,
  SONG_SCHEMA_VERSION,
  STEPS_PER_BEAT,
  lfoSlotOf,
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
import { isChannelPath } from './channels';
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

/** Beat order, ties by id — the one order every note list is kept in. */
function sortNotes(notes: NoteEvent[]): NoteEvent[] {
  return notes.sort((a, b) => a.time - b.time || a.noteId.localeCompare(b.noteId));
}

function withoutDuck(track: SongTrack): SongTrack {
  const { duck: _removed, ...rest } = track;
  return rest;
}

/** Replace one track by id, leaving every other track object untouched. */
function mapTrack(song: Song, trackId: string, fn: (track: SongTrack) => SongTrack): Song {
  return { ...song, tracks: song.tracks.map((track) => (track.id === trackId ? fn(track) : track)) };
}

/**
 * The patch verbs a channel can be the target of (C5). Everything else ignores `trackId`
 * — it is not even on their shapes.
 */
const CHANNEL_VERBS = new Set<SynthCommand['type']>([
  'setParam',
  'loadPreset',
  'savePreset',
  'addOscillator',
  'removeOscillator',
  'addLfo',
  'removeLfo',
  'addRoute',
  'removeRoute',
]);

function channelTarget(command: SynthCommand): string | null {
  if (!CHANNEL_VERBS.has(command.type)) return null;
  const trackId = (command as { trackId?: string }).trackId;
  return trackId === undefined ? null : trackId;
}

/**
 * A patch verb aimed at a channel (C5). The channel is CONTEXT, not a second implementation:
 * the verb runs through the very same case below against a view of the state whose `patch`
 * is the track's `presetSnapshot`, and whatever patch comes out is written back into the
 * track. So "set the cutoff" means one thing whichever sound it lands on, and a fix to a
 * verb fixes it for every channel at once.
 *
 * What does NOT move: the live `state.patch` (still the target of every verb sent without a
 * `trackId`) and the shared FX chain — until C7's inserts, `effects.*` belongs to the master
 * bus, so aiming one at a channel is refused rather than quietly written somewhere the
 * runtime never reads.
 */
function reduceOnChannel(state: EngineState, command: SynthCommand, trackId: string, meta: ReduceMeta): ReduceResult {
  const track = findTrack(state.song, trackId);
  if (track === undefined) return { status: 'rejected', error: `no track with id "${trackId}"` };
  if (track.isDrum === true) {
    return { status: 'rejected', error: `track "${trackId}" is a kick channel — it has no synth patch to edit` };
  }
  if (command.type === 'setParam' && !isChannelPath(command.path)) {
    return {
      status: 'rejected',
      error: `"${command.path}" belongs to the shared master bus until inserts (C7) — send it without a trackId`,
    };
  }

  const { trackId: _channel, ...bare } = command as SynthCommand & { trackId?: string };
  // A preset is a sound plus its FX, and until C7 the FX a channel is heard through is the
  // shared bus — so a preset saved from a channel captures the bus, not the snapshot's own
  // (unplayed) `effects`. That is what `stateForChannel` shows the panels, too.
  const view = command.type === 'savePreset'
    ? { ...track.presetSnapshot, effects: state.patch.effects }
    : track.presetSnapshot;
  const result = reduce({ ...state, patch: view }, bare as SynthCommand, meta);
  if (result.status !== 'applied') return result;

  const sound = result.state.patch;
  // A saved or loaded preset becomes the channel's named sound; an edit keeps the name.
  const presetId = command.type === 'savePreset' || command.type === 'loadPreset' ? sound.id : track.presetId;
  const song = mapTrack(state.song, trackId, (current) => ({ ...current, presetSnapshot: sound, presetId }));
  return { ...result, state: { ...result.state, patch: state.patch, song } };
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

  const channel = channelTarget(command);
  if (channel !== null) return reduceOnChannel(state, command, channel, meta);

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

    case 'importPreset': {
      const existing = state.presets[command.preset.id];
      if (existing?.factory === true) {
        return rejected(`preset "${command.preset.id}" is a factory preset and cannot be replaced`);
      }
      const imported: SynthPreset = { ...structuredClone(command.preset), factory: false };
      return applied({ ...state, presets: { ...state.presets, [imported.id]: imported } });
    }

    case 'restoreSession': {
      // The factory bundle comes from this build, never from storage: a saved copy of a
      // factory preset is an older build's opinion of it. So only non-factory ids are
      // taken from the saved library, and one that collides with a factory id is dropped.
      const presets = { ...state.presets };
      for (const preset of command.presets) {
        if (presets[preset.id]?.factory === true) continue;
        presets[preset.id] = { ...structuredClone(preset), factory: false };
      }
      return applied({
        ...state,
        patch: structuredClone(command.patch),
        song: structuredClone(command.song),
        presets,
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
      // Oscillator slots have the same hazard as LFOs below: the path union is fixed at
      // MAX_OSCILLATORS while the array holds however many the patch added.
      if (segments[1] === 'oscillators') {
        const index = Number(segments[2]);
        if (state.patch.voice.oscillators[index] === undefined) {
          return rejected(`no oscillator at index ${index}; add one with addOscillator first`);
        }
      }
      // 'voice.lfos.<i>.<key>' addresses a slot that may not be filled — the path union
      // is fixed at MAX_LFOS but the array is not.
      if (segments[1] === 'lfos') {
        const index = Number(segments[2]);
        if (state.patch.voice.lfos[index] === undefined) {
          return rejected(`no LFO at index ${index}; add one with addLfo first`);
        }
      }
      // Routes have the same shape and therefore the same hazard.
      if (segments[1] === 'modRoutes') {
        const index = Number(segments[2]);
        if (state.patch.voice.modRoutes[index] === undefined) {
          return rejected(`no route at index ${index}; add one with addRoute first`);
        }
      }
      return applied(withPatch(state, deepSet(state.patch, segments, command.value) as SynthPreset));
    }

    case 'addOscillator': {
      const slots = state.patch.voice.oscillators;
      if (slots.length >= MAX_OSCILLATORS) {
        return rejected(`at most ${MAX_OSCILLATORS} oscillator slots per patch`);
      }
      if (slots.some((slot) => slot.id === command.config.id)) {
        return rejected(`an oscillator with id "${command.config.id}" already exists`);
      }
      return applied(
        withPatch(state, {
          ...state.patch,
          voice: {
            ...state.patch.voice,
            oscillators: [...slots, structuredClone(command.config)],
          },
        }),
      );
    }

    case 'removeOscillator': {
      const slots = state.patch.voice.oscillators;
      if (!slots.some((slot) => slot.id === command.oscillatorId)) {
        return rejected(`no oscillator with id "${command.oscillatorId}"`);
      }
      // The floor that `VoiceConfigSchema.min(1)` states as a document invariant, enforced
      // here as a command one. A voice with no slots is well-formed and permanently
      // silent, and silence that validates is the failure this project keeps paying for.
      // Muting is what `enabled` is for and stays available.
      if (slots.length === 1) {
        return rejected('a voice needs at least one oscillator slot; disable it instead');
      }
      return applied(
        withPatch(state, {
          ...state.patch,
          voice: {
            ...state.patch.voice,
            oscillators: slots.filter((slot) => slot.id !== command.oscillatorId),
          },
        }),
      );
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

    case 'addRoute': {
      const routes = state.patch.voice.modRoutes;
      if (routes.length >= MAX_ROUTES) return rejected(`at most ${MAX_ROUTES} routes per patch`);
      if (routes.some((route) => route.id === command.route.id)) {
        return rejected(`a route with id "${command.route.id}" already exists`);
      }
      // The source names an LFO SLOT, and the slot may be empty — `lfos` is an array
      // capped at MAX_LFOS, not a fixed-length one. A route pointing at an empty slot
      // would validate cleanly and then modulate nothing. Rejecting it here puts the
      // failure in the journal instead of leaving it silent in the audio graph.
      const slot = lfoSlotOf(command.route.source);
      if (slot !== null) {
        if (state.patch.voice.lfos[slot] === undefined) {
          return rejected(`route source "${command.route.source}" has no LFO in that slot`);
        }
      }
      return applied(
        withPatch(state, {
          ...state.patch,
          voice: {
            ...state.patch.voice,
            modRoutes: [...routes, structuredClone(command.route)],
          },
        }),
      );
    }

    case 'removeRoute': {
      const routes = state.patch.voice.modRoutes;
      if (!routes.some((route) => route.id === command.routeId)) {
        return rejected(`no route with id "${command.routeId}"`);
      }
      return applied(
        withPatch(state, {
          ...state.patch,
          voice: {
            ...state.patch.voice,
            modRoutes: routes.filter((route) => route.id !== command.routeId),
          },
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
      // A duck keyed to the removed track would point at nothing and dip on nothing —
      // harmless to the audio, but a dangling reference the next reader has to explain.
      return applied(
        withSong(state, {
          ...state.song,
          tracks: state.song.tracks
            .filter((track) => track.id !== command.trackId)
            .map((track) => (track.duck?.sourceTrackId === command.trackId ? withoutDuck(track) : track)),
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

    case 'updateNote': {
      const track = findTrack(state.song, command.trackId);
      if (track === undefined) return rejected(`no track with id "${command.trackId}"`);
      if (!track.notes.some((note) => note.noteId === command.noteId)) {
        return rejected(`no note with id "${command.noteId}" on track "${command.trackId}"`);
      }
      const notes = sortNotes(
        track.notes.map((note) => (note.noteId === command.noteId ? { ...note, ...command.patch } : note)),
      );
      return applied(withSong(state, mapTrack(state.song, command.trackId, (t) => ({ ...t, notes }))));
    }

    case 'setTrackNotes': {
      if (findTrack(state.song, command.trackId) === undefined) {
        return rejected(`no track with id "${command.trackId}"`);
      }
      // The schema already refuses duplicates; the reducer refuses them again because it
      // is also reached by replay of journals written by other builds, like `addNote`.
      const ids = new Set(command.notes.map((note) => note.noteId));
      if (ids.size !== command.notes.length) return rejected('duplicate noteId in setTrackNotes');
      const notes = sortNotes(structuredClone(command.notes));
      return applied(withSong(state, mapTrack(state.song, command.trackId, (t) => ({ ...t, notes }))));
    }

    case 'setTrackKick': {
      if (findTrack(state.song, command.trackId) === undefined) {
        return rejected(`no track with id "${command.trackId}"`);
      }
      // Giving a track a kick makes it a drum track. Taking the kick away leaves `isDrum`
      // alone: a MIDI channel-10 import was a drum track before it had a kick.
      return applied(
        withSong(
          state,
          mapTrack(state.song, command.trackId, (track) => {
            if (command.kick === null) {
              const { kick: _removed, ...rest } = track;
              return rest;
            }
            return { ...track, isDrum: true, kick: { ...command.kick } };
          }),
        ),
      );
    }

    case 'setTrackDuck': {
      const track = findTrack(state.song, command.trackId);
      if (track === undefined) return rejected(`no track with id "${command.trackId}"`);
      if (command.duck === null) {
        return applied(withSong(state, mapTrack(state.song, command.trackId, withoutDuck)));
      }
      const sourceId = command.duck.sourceTrackId;
      if (sourceId === command.trackId) return rejected('a track cannot duck on its own notes');
      const source = findTrack(state.song, sourceId);
      if (source === undefined) return rejected(`no track with id "${sourceId}" to duck on`);
      if (source.isDrum !== true) {
        return rejected(`track "${sourceId}" is not a drum track; ducking follows a kick, not a melody`);
      }
      const duck = { ...command.duck };
      return applied(withSong(state, mapTrack(state.song, command.trackId, (t) => ({ ...t, duck }))));
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

    // -- history ----------------------------------------------------------

    // Deliberately refused here. Undo needs the state stack, and giving the reducer
    // access to history would make it a function of more than (state, command) — the
    // exact property F59's replay proof depends on. src/core/history.ts owns these.
    case 'undo':
    case 'redo':
      return rejected(`${command.type} is handled by the history driver, not the reducer`);
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
