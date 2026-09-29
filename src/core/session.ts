/**
 * src/core/session.ts — what survives a restart, and what a file carries (cycle 2, C3b).
 *
 * Eyal: "persistence would be nice so I won't lose the sound I synthesize every time". The
 * storage exists (`IdbPersistence`, gated since Phase 2) and was never wired into the app;
 * this file is the part of wiring it that is a DECISION rather than plumbing, so it is pure
 * (D2) and runner-tested:
 *
 * - the SESSION document — the live sound and the song, as they were — and how a saved one
 *   is read back: migrated, then validated, so a session saved at preset v7 still loads at
 *   v9, and a document that cannot be made valid is refused rather than half-loaded;
 * - which library entries changed, so storage writes only what moved;
 * - the FILE format a preset travels in, for export and import. A file may hold one preset
 *   or many; import also takes a bare preset document, because that is what a person
 *   pasting JSON from somewhere else will have.
 */

import type { SynthCommand } from './commands';
import { PresetSchema, SongSchema, migratePreset, migrateSong } from './schemas';
import type { EngineState } from './state';
import type { Song, SynthPreset } from './types';

/**
 * 2 (C5): channels. A version-1 session was saved when every pitched track played the ONE
 * live patch, whatever its own `presetSnapshot` said (that copy was frozen at track creation
 * and never read). So reading a v1 session gives each synth track the live patch as its
 * sound — what it was actually playing. Without this, a melody would switch to a stale copy
 * of an old sound on the first launch after the update.
 */
export const SESSION_SCHEMA_VERSION = 2;

export interface SessionDoc {
  kind: 'sag-session';
  schemaVersion: number;
  /** Epoch ms. Stamped by the app layer, which owns the clock. */
  savedAt: number;
  patch: SynthPreset;
  song: Song;
}

/** Migrate then validate one preset document (F64). Null when it cannot be made valid. */
export function parsePresetDoc(raw: unknown): SynthPreset | null {
  const migrated = migratePreset(raw);
  if (!migrated.ok) return null;
  const parsed = PresetSchema.safeParse(migrated.value);
  return parsed.success ? (parsed.data as SynthPreset) : null;
}

export function parseSongDoc(raw: unknown): Song | null {
  const migrated = migrateSong(raw);
  if (!migrated.ok) return null;
  const parsed = SongSchema.safeParse(migrated.value);
  return parsed.success ? (parsed.data as Song) : null;
}

export function sessionOf(state: EngineState, savedAt: number): SessionDoc {
  return {
    kind: 'sag-session',
    schemaVersion: SESSION_SCHEMA_VERSION,
    savedAt,
    patch: state.patch,
    song: state.song,
  };
}

/**
 * A stored session, read back. Both halves must parse: restoring the sound with the song
 * refused (or the reverse) would be a restore that silently dropped half of it.
 */
export function parseSession(raw: unknown): SessionDoc | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const doc = raw as Record<string, unknown>;
  if (doc.kind !== 'sag-session') return null;
  if (typeof doc.schemaVersion !== 'number' || doc.schemaVersion > SESSION_SCHEMA_VERSION) return null;
  const patch = parsePresetDoc(doc.patch);
  const parsedSong = parseSongDoc(doc.song);
  if (patch === null || parsedSong === null) return null;
  const song =
    doc.schemaVersion < 2
      ? {
          ...parsedSong,
          tracks: parsedSong.tracks.map((track) =>
            track.isDrum === true ? track : { ...track, presetSnapshot: structuredClone(patch), presetId: patch.id },
          ),
        }
      : parsedSong;
  return {
    kind: 'sag-session',
    schemaVersion: SESSION_SCHEMA_VERSION,
    savedAt: typeof doc.savedAt === 'number' ? doc.savedAt : 0,
    patch,
    song,
  };
}

/** The player's own presets — the part of the library storage has to keep. */
export function userPresets(presets: Record<string, SynthPreset>): SynthPreset[] {
  return Object.values(presets).filter((preset) => preset.factory !== true);
}

/**
 * What storage must do to follow the library from `before` to `after`. By reference:
 * core documents are structurally shared, so an unchanged preset is the same object.
 */
export function libraryDiff(
  before: Record<string, SynthPreset>,
  after: Record<string, SynthPreset>,
): { put: SynthPreset[]; remove: string[] } {
  const put = userPresets(after).filter((preset) => before[preset.id] !== preset);
  const remove = userPresets(before)
    .map((preset) => preset.id)
    .filter((id) => after[id] === undefined);
  return { put, remove };
}

/** The one command that puts a saved session back, library included. */
export function restoreCommand(session: SessionDoc, presets: readonly SynthPreset[]): SynthCommand {
  return { type: 'restoreSession', patch: session.patch, song: session.song, presets: [...presets] };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const PRESET_FILE_KIND = 'sag-presets';
export const PRESET_FILE_VERSION = 1;

/** A preset file: one or many presets, pretty-printed so it reads and diffs as text. */
export function presetFile(presets: readonly SynthPreset[], exportedAt: number): string {
  return `${JSON.stringify({ kind: PRESET_FILE_KIND, version: PRESET_FILE_VERSION, exportedAt, presets }, null, 2)}\n`;
}

export interface PresetFileResult {
  presets: SynthPreset[];
  /** One line per document that could not be read, so an import can say what it skipped. */
  errors: string[];
}

/** Read a preset file — the wrapper, a bare preset, or a list of presets. */
export function parsePresetFile(text: string): PresetFileResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { presets: [], errors: ['not a JSON file'] };
  }
  const docs: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === PRESET_FILE_KIND
      ? Array.isArray((raw as { presets?: unknown }).presets)
        ? ((raw as { presets: unknown[] }).presets)
        : []
      : [raw];

  const presets: SynthPreset[] = [];
  const errors: string[] = [];
  docs.forEach((doc, index) => {
    const preset = parsePresetDoc(doc);
    if (preset === null) {
      const name = (doc as { name?: unknown } | null)?.name;
      errors.push(`preset ${index + 1}${typeof name === 'string' ? ` ("${name}")` : ''} is not a valid SAG preset`);
    } else {
      presets.push(preset);
    }
  });
  if (docs.length === 0) errors.push('the file holds no presets');
  return { presets, errors };
}

/** A file name a phone's Download folder accepts: letters, digits, dash, underscore. */
export function safeFileName(name: string, extension: string): string {
  const stem = name
    .normalize('NFKD')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${stem.length > 0 ? stem : 'sag'}.${extension}`;
}
