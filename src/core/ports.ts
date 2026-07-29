/**
 * src/core/ports.ts — the non-audio seams.
 *
 * `runtime-contract.ts` declares the audio seam; this file declares the other two.
 * Both exist for the same reason: the work they describe cannot live in core.
 * IndexedDB needs `indexedDB`, MIDI parsing needs `@tonejs/midi`, and the layer rule
 * (D2, enforced by src/tests/contract.test.ts) admits neither. So core declares the
 * shape and `src/app/` supplies the implementation, exactly as NullRuntime does.
 *
 * Note for anyone reading the KINDs: KIND-synth_patch's `source_repo` edge points at
 * `src/core/persistence/` and KIND-synth_song's at `src/core/midi/`. Both were written
 * before the purity rule was mechanically enforced and are now wrong — the real homes
 * are `src/app/persistence/` and `src/app/midi/`, behind the ports below.
 */

import type { PresetSummary, SongSummary } from './commands';
import type { Song, SynthPreset } from './types';
import type { SynthCommandAppliedEvent } from './sag/events';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * The storage seam. Every method is async because IndexedDB is; the in-memory
 * implementation below resolves immediately so pure tests never need a browser.
 *
 * Storage is a MIRROR of engine state, never the source of truth. The reducer owns
 * `EngineState.presets` / `.songs`; this port persists them so they survive a reload.
 */
export interface PersistencePort {
  savePreset(preset: SynthPreset): Promise<void>;
  loadPreset(id: string): Promise<SynthPreset | null>;
  listPresets(): Promise<PresetSummary[]>;
  deletePreset(id: string): Promise<void>;

  saveSong(song: Song): Promise<void>;
  loadSong(id: string): Promise<Song | null>;
  listSongs(): Promise<SongSummary[]>;
  deleteSong(id: string): Promise<void>;

  /**
   * The recovery snapshot, kept in a store separate from explicit user saves so a
   * crash never overwrites a deliberate one (KIND-synth_song optional slot `autosave`).
   */
  saveAutosave(song: Song): Promise<void>;
  loadAutosave(): Promise<Song | null>;

  /** Durable journal append. "Emitted" means this resolved — never "a backend saw it". */
  appendJournal(events: readonly SynthCommandAppliedEvent[]): Promise<void>;
  readJournal(fromSeq?: number): Promise<readonly SynthCommandAppliedEvent[]>;
  /** Persisted transport cursor; everything above it is pending flush. */
  loadLastAckedSeq(): Promise<number>;
  saveLastAckedSeq(seq: number): Promise<void>;

  dispose(): void;
}

/** In-memory implementation. Pure, Node-safe, and the default in tests. */
export class MemoryPersistence implements PersistencePort {
  private presets = new Map<string, SynthPreset>();
  private songs = new Map<string, Song>();
  private autosaveSlot: Song | null = null;
  private journal: SynthCommandAppliedEvent[] = [];
  private ackedSeq = -1;

  savePreset(preset: SynthPreset): Promise<void> {
    this.presets.set(preset.id, structuredClone(preset));
    return Promise.resolve();
  }

  loadPreset(id: string): Promise<SynthPreset | null> {
    const found = this.presets.get(id);
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  listPresets(): Promise<PresetSummary[]> {
    return Promise.resolve(
      [...this.presets.values()].map((preset) => ({
        id: preset.id,
        name: preset.name,
        ...(preset.category === undefined ? {} : { category: preset.category }),
        factory: preset.factory ?? false,
        createdAt: preset.createdAt,
      })),
    );
  }

  deletePreset(id: string): Promise<void> {
    this.presets.delete(id);
    return Promise.resolve();
  }

  saveSong(song: Song): Promise<void> {
    this.songs.set(song.id, structuredClone(song));
    return Promise.resolve();
  }

  loadSong(id: string): Promise<Song | null> {
    const found = this.songs.get(id);
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  listSongs(): Promise<SongSummary[]> {
    return Promise.resolve(
      [...this.songs.values()].map((song) => ({
        id: song.id,
        name: song.name,
        bpm: song.bpm,
        trackCount: song.tracks.length,
        updatedAt: song.updatedAt,
      })),
    );
  }

  deleteSong(id: string): Promise<void> {
    this.songs.delete(id);
    return Promise.resolve();
  }

  saveAutosave(song: Song): Promise<void> {
    this.autosaveSlot = structuredClone(song);
    return Promise.resolve();
  }

  loadAutosave(): Promise<Song | null> {
    return Promise.resolve(this.autosaveSlot ? structuredClone(this.autosaveSlot) : null);
  }

  appendJournal(events: readonly SynthCommandAppliedEvent[]): Promise<void> {
    this.journal.push(...events.map((event) => structuredClone(event)));
    return Promise.resolve();
  }

  readJournal(fromSeq = 0): Promise<readonly SynthCommandAppliedEvent[]> {
    return Promise.resolve(this.journal.filter((event) => event.seq >= fromSeq));
  }

  loadLastAckedSeq(): Promise<number> {
    return Promise.resolve(this.ackedSeq);
  }

  saveLastAckedSeq(seq: number): Promise<void> {
    if (seq > this.ackedSeq) this.ackedSeq = seq;
    return Promise.resolve();
  }

  dispose(): void {
    this.presets.clear();
    this.songs.clear();
    this.journal.length = 0;
    this.autosaveSlot = null;
    this.ackedSeq = -1;
  }
}

// ---------------------------------------------------------------------------
// MIDI import
// ---------------------------------------------------------------------------

export interface MidiImportWarning {
  code: 'drum-channel' | 'empty-track' | 'unsupported-event' | 'tempo-map-truncated';
  message: string;
  trackIndex?: number;
}

export interface MidiImportResult {
  song: Song;
  warnings: MidiImportWarning[];
}

/**
 * Every identity and timestamp the importer needs is INJECTED, never generated.
 * A parser that called `crypto.randomUUID()` would produce a different song on every
 * run, so `importMidi` could not be replayed from the journal and F59 would fail for
 * any session containing an import.
 */
export interface MidiImportOptions {
  songId: string;
  /** Stable per-track id, called with the source track index. */
  trackIdFor: (trackIndex: number) => string;
  /** Stable per-note id, called with the track index and the note index within it. */
  noteIdFor: (trackIndex: number, noteIndex: number) => string;
  /** Embedded into every track as `presetSnapshot` (F68 self-containment). */
  defaultPreset: SynthPreset;
  createdAt: number;
  filename?: string;
}

/** Bytes in, a valid `Song` out. Must satisfy SongSchema or throw. */
export interface MidiImportPort {
  import(bytes: Uint8Array, options: MidiImportOptions): MidiImportResult;
}
