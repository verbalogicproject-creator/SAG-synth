/**
 * src/app/persistence/idb-persistence.ts — the durable PersistencePort.
 *
 * `src/core/ports.ts` declares the seam and ships `MemoryPersistence` as the reference
 * semantics; this class is the browser-durable twin. Every read/write clones (via
 * `structuredClone`, same as MemoryPersistence) so a caller can never mutate the copy
 * IndexedDB is holding, and every read re-validates (migrate then zod-parse) so a
 * document written by an older build never reaches the reducer half-shaped (F64).
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PresetSummary, SongSummary } from '../../core/commands';
import type { ListResult, PersistencePort, PersistenceWarning } from '../../core/ports';
import type { Song, SynthPreset } from '../../core/types';
import type { SynthCommandAppliedEvent } from '../../core/sag/events';
import { PresetSchema, SongSchema, migratePreset, migrateSong } from '../../core/schemas';
import { parseSession, type SessionDoc } from '../../core/session';

/**
 * The autosave and meta stores hold exactly one row each. IndexedDB still needs a key,
 * so both use a fixed out-of-line key rather than a keyPath — there is no field on
 * `Song` or on a bare number that would make a sensible in-line key.
 */
const AUTOSAVE_KEY = 'autosave';
const SESSION_KEY = 'session';
const LAST_ACKED_SEQ_KEY = 'lastAckedSeq';

interface SynthDbSchema extends DBSchema {
  presets: { key: string; value: SynthPreset };
  songs: { key: string; value: Song };
  autosave: { key: typeof AUTOSAVE_KEY; value: Song };
  journal: { key: number; value: SynthCommandAppliedEvent };
  meta: { key: typeof LAST_ACKED_SEQ_KEY; value: number };
  /** Version 2 (C3b). Holds whatever some build wrote; read through `parseSession`. */
  session: { key: typeof SESSION_KEY; value: unknown };
}

function openSynthDb(name: string): Promise<IDBPDatabase<SynthDbSchema>> {
  // Version 2 adds the session store (C3b). Stepped on `oldVersion` so a phone holding a
  // version-1 database gains the new store and keeps every row it already has.
  return openDB<SynthDbSchema>(name, 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('presets', { keyPath: 'id' });
        db.createObjectStore('songs', { keyPath: 'id' });
        db.createObjectStore('autosave');
        db.createObjectStore('journal', { keyPath: 'seq' });
        db.createObjectStore('meta');
      }
      if (oldVersion < 2) db.createObjectStore('session');
    },
  });
}

/** F64: migrate then validate; a document that fails either step is not returned at all. */
function parsePreset(raw: unknown): SynthPreset | null {
  const migrated = migratePreset(raw);
  if (!migrated.ok) return null;
  const parsed = PresetSchema.safeParse(migrated.value);
  return parsed.success ? (parsed.data as SynthPreset) : null;
}

function parseSong(raw: unknown): Song | null {
  const migrated = migrateSong(raw);
  if (!migrated.ok) return null;
  const parsed = SongSchema.safeParse(migrated.value);
  return parsed.success ? (parsed.data as Song) : null;
}

/**
 * Identify a row that failed to parse. `idb`'s generics say this is a `SynthPreset` or
 * a `Song`, but the row is whatever some past build actually wrote, so `id` cannot be
 * assumed to exist or to be a string — that is precisely why this row is being reported.
 */
function rowKey(raw: unknown): string {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : '<unknown id>';
}

export class IdbPersistence implements PersistencePort {
  private readonly dbPromise: Promise<IDBPDatabase<SynthDbSchema>>;

  constructor(dbName: string) {
    this.dbPromise = openSynthDb(dbName);
  }

  private db(): Promise<IDBPDatabase<SynthDbSchema>> {
    return this.dbPromise;
  }

  async savePreset(preset: SynthPreset): Promise<void> {
    const db = await this.db();
    await db.put('presets', structuredClone(preset));
  }

  async loadPreset(id: string): Promise<SynthPreset | null> {
    const db = await this.db();
    const found = await db.get('presets', id);
    return found === undefined ? null : parsePreset(structuredClone(found));
  }

  async listPresets(): Promise<ListResult<PresetSummary>> {
    const db = await this.db();
    const all = await db.getAll('presets');
    const items: PresetSummary[] = [];
    const warnings: PersistenceWarning[] = [];

    for (const raw of all) {
      const preset = parsePreset(structuredClone(raw));
      // A row that fails validation is still dropped rather than half-applied — same
      // stance as loadPreset — but it is now reported. A preset that vanishes from the
      // library with no explanation looks like data loss, because it is.
      if (preset === null) {
        warnings.push({
          code: 'unreadable-preset',
          key: rowKey(raw),
          message: `preset "${rowKey(raw)}" failed migration or validation and was omitted`,
        });
        continue;
      }
      items.push({
        id: preset.id,
        name: preset.name,
        ...(preset.category === undefined ? {} : { category: preset.category }),
        factory: preset.factory ?? false,
        createdAt: preset.createdAt,
      });
    }

    return { items, warnings };
  }

  async deletePreset(id: string): Promise<void> {
    const db = await this.db();
    await db.delete('presets', id);
  }

  async saveSong(song: Song): Promise<void> {
    const db = await this.db();
    await db.put('songs', structuredClone(song));
  }

  async loadSong(id: string): Promise<Song | null> {
    const db = await this.db();
    const found = await db.get('songs', id);
    return found === undefined ? null : parseSong(structuredClone(found));
  }

  async listSongs(): Promise<ListResult<SongSummary>> {
    const db = await this.db();
    const all = await db.getAll('songs');
    const items: SongSummary[] = [];
    const warnings: PersistenceWarning[] = [];

    for (const raw of all) {
      const song = parseSong(structuredClone(raw));
      if (song === null) {
        warnings.push({
          code: 'unreadable-song',
          key: rowKey(raw),
          message: `song "${rowKey(raw)}" failed migration or validation and was omitted`,
        });
        continue;
      }
      items.push({
        id: song.id,
        name: song.name,
        bpm: song.bpm,
        trackCount: song.tracks.length,
        updatedAt: song.updatedAt,
      });
    }

    return { items, warnings };
  }

  async deleteSong(id: string): Promise<void> {
    const db = await this.db();
    await db.delete('songs', id);
  }

  async saveAutosave(song: Song): Promise<void> {
    const db = await this.db();
    await db.put('autosave', structuredClone(song), AUTOSAVE_KEY);
  }

  async loadAutosave(): Promise<Song | null> {
    const db = await this.db();
    const found = await db.get('autosave', AUTOSAVE_KEY);
    return found === undefined ? null : parseSong(structuredClone(found));
  }

  async saveSession(session: SessionDoc): Promise<void> {
    const db = await this.db();
    await db.put('session', structuredClone(session), SESSION_KEY);
  }

  async loadSession(): Promise<SessionDoc | null> {
    const db = await this.db();
    const found = await db.get('session', SESSION_KEY);
    return found === undefined ? null : parseSession(structuredClone(found));
  }

  async appendJournal(events: readonly SynthCommandAppliedEvent[]): Promise<void> {
    const db = await this.db();
    const tx = db.transaction('journal', 'readwrite');
    // `put`, not `add`: a retried flush of the same seq must overwrite silently rather
    // than throw a constraint error — the durable store is written asynchronously and
    // may see the same batch twice, unlike MemorySagJournal's single in-process caller.
    await Promise.all([
      ...events.map((event) => tx.store.put(structuredClone(event))),
      tx.done,
    ]);
  }

  async readJournal(fromSeq = 0): Promise<readonly SynthCommandAppliedEvent[]> {
    const db = await this.db();
    // The 'journal' store's keyPath is `seq`, so a cursor over it is already ascending
    // seq order — no separate sort needed.
    const range = fromSeq <= 0 ? undefined : IDBKeyRange.lowerBound(fromSeq);
    const rows = await db.getAll('journal', range);
    return rows.map((row) => structuredClone(row));
  }

  async loadLastAckedSeq(): Promise<number> {
    const db = await this.db();
    const seq = await db.get('meta', LAST_ACKED_SEQ_KEY);
    return seq ?? -1;
  }

  async saveLastAckedSeq(seq: number): Promise<void> {
    const db = await this.db();
    // Read and write inside ONE readwrite transaction. Split across two, overlapping
    // flushes interleave their get/put and the lower seq can land last, rewinding the
    // cursor and re-sending events a transport already acknowledged. IndexedDB
    // serialises readwrite transactions over the same store, so this is atomic.
    const tx = db.transaction('meta', 'readwrite');
    const current = (await tx.store.get(LAST_ACKED_SEQ_KEY)) ?? -1;
    if (seq > current) await tx.store.put(seq, LAST_ACKED_SEQ_KEY);
    await tx.done;
  }

  dispose(): void {
    // Synchronous by contract (mirrors MemoryPersistence.dispose); closing an
    // already-open connection is safe and idempotent per the IndexedDB spec.
    this.dbPromise.then((db) => db.close()).catch(() => {
      // The connection failed to open in the first place; nothing to close.
    });
  }
}
