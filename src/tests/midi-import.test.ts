/**
 * src/tests/midi-import.test.ts — ToneMidiImport against the frozen MidiImportPort
 * contract. `@tonejs/midi` is a pure binary parser (no DOM, no AudioContext), so this
 * runs under the plain-Node `core` project rather than `*.browser.test.ts`.
 *
 * Fixture is imported as JSON and decoded with atob, not node:fs — this project has no
 * @types/node (see src/tests/fixtures.test.ts for the same convention).
 */

import { describe, expect, it } from 'vitest';
import demoMidiFixture from '../../fixtures/demo-midi.json';
import { ToneMidiImport } from '../app/midi';
import type { MidiImportOptions } from '../core/ports';
import { SongSchema } from '../core/schemas';
import { defaultPreset } from '../core/state';

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const CREATED_AT = 1769731200000; // 2026-01-30T00:00:00Z, arbitrary fixed epoch

/** Deterministic, injected identities — never crypto.randomUUID() or Date.now(). */
function makeOptions(): MidiImportOptions {
  return {
    songId: 'song-imported-1',
    trackIdFor: (trackIndex) => `track-${trackIndex}`,
    noteIdFor: (trackIndex, noteIndex) => `note-${trackIndex}-${noteIndex}`,
    defaultPreset: defaultPreset(),
    createdAt: CREATED_AT,
    filename: demoMidiFixture.filename,
  };
}

describe('ToneMidiImport — fixtures/demo.mid', () => {
  const bytes = bytesFromBase64(demoMidiFixture.bytes);

  it('imports a Song that satisfies SongSchema', () => {
    const result = new ToneMidiImport().import(bytes, makeOptions());
    expect(() => SongSchema.parse(result.song)).not.toThrow();
  });

  it('carries both tempo events into song.tempoMap, in beats', () => {
    const result = new ToneMidiImport().import(bytes, makeOptions());
    const song = result.song;
    expect(song.bpm).toBeCloseTo(110, 3);
    expect(song.tempoMap).toBeDefined();
    expect(song.tempoMap).toHaveLength(2);
    expect(song.tempoMap![0]!.time).toBe(0);
    expect(song.tempoMap![0]!.bpm).toBeCloseTo(110, 3);
    // Second tempo event is at tick 1920 with ppq 480 -> beat 4, not the 2.18s
    // @tonejs/midi reports — proof the conversion uses ticks, not seconds.
    expect(song.tempoMap![1]!.time).toBeCloseTo(4, 6);
    expect(song.tempoMap![1]!.bpm).toBeCloseTo(88, 3);
  });

  it('flags the channel-10 track as a drum track and warns', () => {
    const result = new ToneMidiImport().import(bytes, makeOptions());
    const drumTrack = result.song.tracks.find((t) => t.isDrum === true);
    expect(drumTrack).toBeDefined();
    expect(drumTrack!.name).toBe('Drums');
    expect(result.warnings.some((w) => w.code === 'drum-channel')).toBe(true);
  });

  it('imports the documented 2 tracks and 28 notes total, with every id injected', () => {
    const result = new ToneMidiImport().import(bytes, makeOptions());
    const song = result.song;
    expect(song.tracks).toHaveLength(2);
    const totalNotes = song.tracks.reduce((sum, t) => sum + t.notes.length, 0);
    expect(totalNotes).toBe(28);
    for (const track of song.tracks) {
      expect(track.id.startsWith('track-')).toBe(true);
      for (const note of track.notes) {
        expect(note.noteId.startsWith('note-')).toBe(true);
      }
      // F68: every track is self-contained, even before any preset is saved to a library.
      expect(track.presetId).toBeNull();
      expect(track.presetSnapshot).toEqual(defaultPreset());
    }
  });

  it('is deterministic: the same bytes and the same options produce a deep-equal song (F59)', () => {
    const first = new ToneMidiImport().import(bytes, makeOptions());
    const second = new ToneMidiImport().import(bytes, makeOptions());
    expect(second.song).toEqual(first.song);
    expect(second.warnings).toEqual(first.warnings);
  });

  it('flags source_midi metadata from the injected options, not from wall-clock time', () => {
    const result = new ToneMidiImport().import(bytes, makeOptions());
    expect(result.song.sourceMidi).toEqual({
      filename: demoMidiFixture.filename,
      importedAt: CREATED_AT,
      trackCount: 2,
      hadDrumChannel: true,
    });
  });
});

describe('ToneMidiImport — synthetic edge cases', () => {
  it('skips a zero-note track and emits empty-track, without adding it to song.tracks', () => {
    // Minimal single-track, no-note MIDI file (format 0, so @tonejs/midi does not
    // shift the track away the way it does track 0 of a format-1 file): header chunk
    // + a track chunk containing only an end-of-track meta event.
    const emptyMidiBase64 =
      'TVRoZAAAAAYAAAABAeBNVHJrAAAABAD/LwA=';
    const bytes = bytesFromBase64(emptyMidiBase64);
    const result = new ToneMidiImport().import(bytes, makeOptions());
    expect(result.song.tracks).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === 'empty-track')).toBe(true);
  });
});
