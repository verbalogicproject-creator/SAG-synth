/**
 * src/tests/fixtures.test.ts — the shipped fixtures must parse against the frozen
 * schemas, and the JSON copy of the default patch must not drift from the TS source.
 *
 * Fixtures are imported (Vite resolves JSON) rather than read with node:fs — this
 * project has no @types/node, and keeping it that way is one more guarantee that core
 * and its tests are not quietly acquiring a Node dependency.
 */

import { describe, expect, it } from 'vitest';
import defaultPresetFixture from '../../fixtures/default-preset.json';
import demoSongFixture from '../../fixtures/demo-song.json';
import demoMidiFixture from '../../fixtures/demo-midi.json';
import { PresetSchema, SongSchema, validateCommand } from '../core/schemas';
import { defaultPreset } from '../core/state';
import { NullRuntime } from '../core/runtime-contract';
import { MemorySagJournal, buildCommandAppliedEvent } from '../core/sag/events';
import { createEnvelope } from '../core/commands';

describe('fixtures/default-preset.json', () => {
  it('validates against PresetSchema', () => {
    const result = PresetSchema.safeParse(defaultPresetFixture);
    expect(result.success ? null : result.error.issues).toBeNull();
  });

  it('deep-equals defaultPreset() — the JSON copy cannot drift from the TS source', () => {
    expect(defaultPresetFixture).toEqual(defaultPreset());
  });
});

describe('fixtures/demo-song.json', () => {
  it('validates against SongSchema', () => {
    const result = SongSchema.safeParse(demoSongFixture);
    expect(result.success ? null : result.error.issues).toBeNull();
  });

  it('embeds a full preset snapshot per track (F68 self-containment)', () => {
    const song = SongSchema.parse(demoSongFixture);
    for (const track of song.tracks) {
      expect(PresetSchema.safeParse(track.presetSnapshot).success).toBe(true);
    }
  });

  it('carries note times in beats, so tempo is not baked into the notes', () => {
    const song = SongSchema.parse(demoSongFixture);
    const notes = song.tracks[0]!.notes;
    expect(notes.length).toBeGreaterThan(0);
    // The last note starts at beat 7.5 of an 8-beat loop. If these were seconds, at
    // 110 bpm the loop would be over long before the note played.
    expect(Math.max(...notes.map((n) => n.time))).toBeLessThan(song.loop.end);
  });

  it('gives every note a unique id, which removeNote depends on', () => {
    const song = SongSchema.parse(demoSongFixture);
    for (const track of song.tracks) {
      const ids = track.notes.map((n) => n.noteId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('round-trips through JSON byte-stably (F67)', () => {
    const song = SongSchema.parse(demoSongFixture);
    const once = JSON.stringify(song);
    const twice = JSON.stringify(SongSchema.parse(JSON.parse(once)));
    expect(twice).toBe(once);
  });
});

describe('fixtures/demo.mid', () => {
  it('is a valid importMidi payload', () => {
    const result = validateCommand({
      type: 'importMidi',
      bytes: demoMidiFixture.bytes,
      filename: demoMidiFixture.filename,
      autoplay: true,
    });
    expect(result.ok ? null : result.error).toBeNull();
  });

  it('decodes to bytes with a MIDI header chunk', () => {
    const binary = atob(demoMidiFixture.bytes);
    expect(binary.slice(0, 4)).toBe('MThd');
    expect(binary.length).toBe(351);
  });
});

describe('NullRuntime — the headless seam', () => {
  it('satisfies the adapter contract without an AudioContext', async () => {
    const runtime = new NullRuntime();
    await runtime.unlock();
    runtime.applyPatch(defaultPreset());
    runtime.noteOn({ voiceId: 0, note: 'C4', velocity: 0.8, portamento: 0 });
    expect(runtime.sounding).toHaveLength(1);
    runtime.noteOff({ voiceId: 0, note: 'C4' });
    expect(runtime.sounding).toHaveLength(0);

    runtime.transport.seek(4);
    expect(runtime.getPlayhead()).toBe(4);
    runtime.transport.stop();
    expect(runtime.getPlayhead()).toBe(0);

    runtime.dispose();
    expect(runtime.isDisposed).toBe(true);
    expect(runtime.calls.map((c) => c.method)).toEqual([
      'unlock',
      'applyPatch',
      'noteOn',
      'noteOff',
      'transport.seek',
      'transport.stop',
      'dispose',
    ]);
  });
});

describe('MemorySagJournal — F60 gapless seq', () => {
  it('accepts a contiguous run and refuses a gap', () => {
    const journal = new MemorySagJournal();
    expect(journal.lastSeq()).toBe(-1);

    for (let seq = 0; seq < 3; seq += 1) {
      const envelope = createEnvelope({ type: 'play' }, 'ui', `cmd-${seq}`, 1700000000000 + seq);
      journal.append(buildCommandAppliedEvent(envelope, { status: 'applied' }, { seq, revision: seq + 1 }));
    }
    expect(journal.lastSeq()).toBe(2);
    expect(journal.read()).toHaveLength(3);
    expect(journal.read(2)).toHaveLength(1);

    const envelope = createEnvelope({ type: 'stop' }, 'ui', 'cmd-x', 1700000000009);
    expect(() =>
      journal.append(buildCommandAppliedEvent(envelope, { status: 'applied' }, { seq: 7, revision: 4 })),
    ).toThrow(/seq gap/);
  });

  it('tracks the transport ack cursor without a backend', () => {
    const journal = new MemorySagJournal();
    expect(journal.lastAckedSeq()).toBe(-1);
    journal.markAcked(3);
    expect(journal.lastAckedSeq()).toBe(3);
    // Acks never move backwards.
    journal.markAcked(1);
    expect(journal.lastAckedSeq()).toBe(3);
  });
});
