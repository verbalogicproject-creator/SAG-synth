/**
 * src/tests/persistence.browser.test.ts — IdbPersistence against real IndexedDB.
 *
 * Runs in headless chromium (the `dom` vitest project) because jsdom/node have no
 * IndexedDB. Each test gets its own database name so tests never interfere, and the
 * database is dropped in `afterEach` so a failed run leaves nothing behind for the next.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { deleteDB, openDB } from 'idb';
import { IdbPersistence } from '../app/persistence';
import { defaultPreset, defaultSong } from '../core/state';
import type { SynthCommandAppliedEvent } from '../core/sag/events';

let dbNames: string[] = [];

function uniqueDbName(): string {
  const name = `sag-synth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  dbNames.push(name);
  return name;
}

afterEach(async () => {
  await Promise.all(dbNames.map((name) => deleteDB(name)));
  dbNames = [];
});

function makeEvent(seq: number, overrides: Partial<SynthCommandAppliedEvent> = {}): SynthCommandAppliedEvent {
  return {
    command_id: `cmd-${seq}`,
    command_type: 'setTempo',
    payload: { type: 'setTempo', bpm: 120 },
    status: 'applied',
    seq,
    revision: seq + 1,
    source: 'ui',
    ts: 1_700_000_000_000 + seq,
    ...overrides,
  };
}

describe('IdbPersistence — presets', () => {
  it('round-trips a preset and clones on write and read', async () => {
    const persistence = new IdbPersistence(uniqueDbName());
    const preset = defaultPreset();

    await persistence.savePreset(preset);
    preset.name = 'mutated after save';

    const loaded = await persistence.loadPreset(preset.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe('Init Saw');

    loaded!.name = 'mutated after load';
    const loadedAgain = await persistence.loadPreset(preset.id);
    expect(loadedAgain?.name).toBe('Init Saw');

    persistence.dispose();
  });

  it('returns null for a preset id that was never saved', async () => {
    const persistence = new IdbPersistence(uniqueDbName());
    await expect(persistence.loadPreset('does-not-exist')).resolves.toBeNull();
    persistence.dispose();
  });

  it('lists preset summaries with derived fields', async () => {
    const persistence = new IdbPersistence(uniqueDbName());
    const preset = defaultPreset();
    await persistence.savePreset(preset);

    const { items, warnings } = await persistence.listPresets();
    expect(items).toEqual([
      {
        id: preset.id,
        name: preset.name,
        category: preset.category,
        factory: true,
        createdAt: preset.createdAt,
      },
    ]);
    expect(warnings).toEqual([]);
    persistence.dispose();
  });

  it('reports an unreadable row instead of silently omitting it', async () => {
    const dbName = uniqueDbName();
    const persistence = new IdbPersistence(dbName);
    const good = defaultPreset();
    await persistence.savePreset(good);

    const raw = await openDB(dbName, 1);
    await raw.put('presets', { id: 'corrupt-1', name: 'broken', voice: {}, effects: {} });
    raw.close();

    const { items, warnings } = await persistence.listPresets();
    // The good preset still lists — one bad row must not hide the library...
    expect(items.map((summary) => summary.id)).toEqual([good.id]);
    // ...but the drop is named, so a caller can tell the user which one went missing.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('unreadable-preset');
    expect(warnings[0]?.key).toBe('corrupt-1');
    persistence.dispose();
  });

  it('deletes a preset', async () => {
    const persistence = new IdbPersistence(uniqueDbName());
    const preset = defaultPreset();
    await persistence.savePreset(preset);
    await persistence.deletePreset(preset.id);
    await expect(persistence.loadPreset(preset.id)).resolves.toBeNull();
    persistence.dispose();
  });

  it('F64: a preset stored by an older/corrupt build fails validation and loads as null, not partially', async () => {
    const dbName = uniqueDbName();
    const persistence = new IdbPersistence(dbName);
    // Force-open the same database outside the port to write a document the port
    // itself would never produce — simulating data from a stale build.
    const raw = await openDB(dbName, 1);
    await raw.put('presets', { id: 'corrupt-1', name: 'broken', voice: {}, effects: {} });
    raw.close();

    await expect(persistence.loadPreset('corrupt-1')).resolves.toBeNull();
    persistence.dispose();
  });

  it('migrates a legacy preset with no schemaVersion instead of rejecting it', async () => {
    const dbName = uniqueDbName();
    const persistence = new IdbPersistence(dbName);
    const legacy = defaultPreset() as unknown as Record<string, unknown>;
    delete legacy.schemaVersion;
    legacy.id = 'legacy-1';

    const raw = await openDB(dbName, 1);
    await raw.put('presets', legacy);
    raw.close();

    const loaded = await persistence.loadPreset('legacy-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.schemaVersion).toBe(1);
    persistence.dispose();
  });
});

describe('IdbPersistence — songs', () => {
  it('round-trips a song and clones on write and read', async () => {
    const persistence = new IdbPersistence(uniqueDbName());
    const song = defaultSong();

    await persistence.saveSong(song);
    song.name = 'mutated after save';

    const loaded = await persistence.loadSong(song.id);
    expect(loaded?.name).toBe('Untitled');

    loaded!.name = 'mutated after load';
    const loadedAgain = await persistence.loadSong(song.id);
    expect(loadedAgain?.name).toBe('Untitled');
    persistence.dispose();
  });

  it('lists song summaries with derived fields', async () => {
    const persistence = new IdbPersistence(uniqueDbName());
    const song = defaultSong();
    await persistence.saveSong(song);

    const { items, warnings } = await persistence.listSongs();
    expect(items).toEqual([
      {
        id: song.id,
        name: song.name,
        bpm: song.bpm,
        trackCount: song.tracks.length,
        updatedAt: song.updatedAt,
      },
    ]);
    expect(warnings).toEqual([]);
    persistence.dispose();
  });

  it('reports an unreadable song row rather than dropping it silently', async () => {
    const dbName = uniqueDbName();
    const persistence = new IdbPersistence(dbName);
    const good = defaultSong();
    await persistence.saveSong(good);

    const raw = await openDB(dbName, 1);
    await raw.put('songs', { id: 'corrupt-song', name: 'broken' });
    raw.close();

    const { items, warnings } = await persistence.listSongs();
    expect(items.map((summary) => summary.id)).toEqual([good.id]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('unreadable-song');
    expect(warnings[0]?.key).toBe('corrupt-song');
    persistence.dispose();
  });

  it('deletes a song', async () => {
    const persistence = new IdbPersistence(uniqueDbName());
    const song = defaultSong();
    await persistence.saveSong(song);
    await persistence.deleteSong(song.id);
    await expect(persistence.loadSong(song.id)).resolves.toBeNull();
    persistence.dispose();
  });

  it('F64: a corrupt stored song loads as null, never partially', async () => {
    const dbName = uniqueDbName();
    const persistence = new IdbPersistence(dbName);
    const raw = await openDB(dbName, 1);
    await raw.put('songs', { id: 'corrupt-song', name: 'broken' });
    raw.close();

    await expect(persistence.loadSong('corrupt-song')).resolves.toBeNull();
    persistence.dispose();
  });
});

describe('IdbPersistence — autosave', () => {
  it('keeps a single slot, separate from explicit saves', async () => {
    const persistence = new IdbPersistence(uniqueDbName());
    const song = defaultSong();

    await expect(persistence.loadAutosave()).resolves.toBeNull();

    await persistence.saveAutosave(song);
    const first = await persistence.loadAutosave();
    expect(first?.id).toBe(song.id);

    const second = { ...song, name: 'recovered' };
    await persistence.saveAutosave(second);
    const latest = await persistence.loadAutosave();
    expect(latest?.name).toBe('recovered');

    // An autosave must never appear in the explicit song library.
    await expect(persistence.loadSong(song.id)).resolves.toBeNull();
    persistence.dispose();
  });
});

describe('IdbPersistence — journal', () => {
  it('appends and reads back in ascending seq order regardless of insertion order', async () => {
    const persistence = new IdbPersistence(uniqueDbName());
    await persistence.appendJournal([makeEvent(2), makeEvent(0), makeEvent(1)]);

    const all = await persistence.readJournal();
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2]);
    persistence.dispose();
  });

  it('readJournal(fromSeq) filters inclusively from that seq', async () => {
    const persistence = new IdbPersistence(uniqueDbName());
    await persistence.appendJournal([makeEvent(0), makeEvent(1), makeEvent(2), makeEvent(3)]);

    const fromTwo = await persistence.readJournal(2);
    expect(fromTwo.map((e) => e.seq)).toEqual([2, 3]);
    persistence.dispose();
  });

  it('is idempotent for a repeated seq: last write wins, no throw', async () => {
    const persistence = new IdbPersistence(uniqueDbName());
    await persistence.appendJournal([makeEvent(0)]);
    await expect(
      persistence.appendJournal([makeEvent(0, { status: 'rejected', error: 'retry' })]),
    ).resolves.toBeUndefined();

    const all = await persistence.readJournal();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('rejected');
    persistence.dispose();
  });

  it('clones on read so mutating a returned row cannot corrupt the store', async () => {
    const persistence = new IdbPersistence(uniqueDbName());
    await persistence.appendJournal([makeEvent(0)]);

    const rows = await persistence.readJournal();
    (rows[0] as SynthCommandAppliedEvent).status = 'rejected';

    const rowsAgain = await persistence.readJournal();
    expect(rowsAgain[0]?.status).toBe('applied');
    persistence.dispose();
  });
});

describe('IdbPersistence — lastAckedSeq', () => {
  it('defaults to -1 and only advances forward', async () => {
    const persistence = new IdbPersistence(uniqueDbName());
    await expect(persistence.loadLastAckedSeq()).resolves.toBe(-1);

    await persistence.saveLastAckedSeq(5);
    await expect(persistence.loadLastAckedSeq()).resolves.toBe(5);

    await persistence.saveLastAckedSeq(2);
    await expect(persistence.loadLastAckedSeq()).resolves.toBe(5);

    await persistence.saveLastAckedSeq(9);
    await expect(persistence.loadLastAckedSeq()).resolves.toBe(9);
    persistence.dispose();
  });

  it('stays monotonic when two flushes overlap', async () => {
    // The dispatcher flushes the journal asynchronously, so two saveLastAckedSeq calls
    // can be in flight at once. A read-then-write across two transactions lets the
    // lower seq land last and silently rewind the cursor, which would make the engine
    // re-send events a transport had already acknowledged.
    const persistence = new IdbPersistence(uniqueDbName());
    await Promise.all([persistence.saveLastAckedSeq(9), persistence.saveLastAckedSeq(5)]);
    await expect(persistence.loadLastAckedSeq()).resolves.toBe(9);

    await Promise.all([persistence.saveLastAckedSeq(3), persistence.saveLastAckedSeq(12)]);
    await expect(persistence.loadLastAckedSeq()).resolves.toBe(12);
    persistence.dispose();
  });
});
