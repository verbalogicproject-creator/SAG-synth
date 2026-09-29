/**
 * src/tests/session.test.ts — the session document and the preset file format, pure.
 */

import { describe, expect, it } from 'vitest';
import {
  libraryDiff,
  parsePresetFile,
  parseSession,
  presetFile,
  safeFileName,
  sessionOf,
} from '../core/session';
import { defaultPreset, initialEngineState, psyRollPreset } from '../core/state';

const mine = (name: string) => ({ ...defaultPreset(), id: `user-${name}`, name, factory: false });

describe('preset files', () => {
  it('round-trips one or many presets through the file format', () => {
    const presets = [mine('A'), mine('B')];
    const read = parsePresetFile(presetFile(presets, 1));
    expect(read.errors).toEqual([]);
    expect(read.presets.map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('also takes a bare preset document and a plain list — what someone pasting JSON has', () => {
    expect(parsePresetFile(JSON.stringify(mine('Bare'))).presets.map((p) => p.name)).toEqual(['Bare']);
    expect(parsePresetFile(JSON.stringify([mine('X'), mine('Y')])).presets).toHaveLength(2);
  });

  it('upgrades an old preset on import', () => {
    const old = structuredClone(mine('Old')) as any;
    old.schemaVersion = 5;
    delete old.voice.filter.drive;
    delete old.voice.filterEnvelope.linked;
    const [preset] = parsePresetFile(JSON.stringify(old)).presets;
    expect(preset?.schemaVersion).toBe(7);
    expect(preset?.voice.filter.drive).toBe(0);
  });

  it('keeps the good presets and names the bad ones', () => {
    const read = parsePresetFile(JSON.stringify([mine('Good'), { name: 'Broken', voice: 1 }]));
    expect(read.presets.map((p) => p.name)).toEqual(['Good']);
    expect(read.errors).toEqual(['preset 2 ("Broken") is not a valid SAG preset']);
  });

  it('says so for a file that is not JSON, or holds nothing', () => {
    expect(parsePresetFile('not json').errors).toEqual(['not a JSON file']);
    expect(parsePresetFile(presetFile([], 1)).errors).toEqual(['the file holds no presets']);
  });
});

describe('the session document', () => {
  it('refuses a session from a newer build, or one missing half of itself', () => {
    const session = sessionOf(initialEngineState(), 1);
    expect(parseSession(session)).not.toBeNull();
    expect(parseSession({ ...session, schemaVersion: 99 })).toBeNull();
    expect(parseSession({ ...session, song: undefined })).toBeNull();
    expect(parseSession({ ...session, kind: 'other' })).toBeNull();
  });

  it('v1 → v2 (C5): every synth track takes the live patch — the sound it actually played', () => {
    // Before C5 every pitched track played `state.patch`; its snapshot was a stale copy
    // from track creation. Reading it as-is would switch the song to an old sound.
    const state = initialEngineState();
    const stale = { ...psyRollPreset(), id: 'stale' };
    const v1 = {
      ...sessionOf(state, 1),
      schemaVersion: 1,
      song: {
        ...state.song,
        tracks: [
          { ...state.song.tracks[0]!, presetSnapshot: stale, presetId: 'stale' },
          { ...state.song.tracks[0]!, id: 'drums', isDrum: true, presetSnapshot: stale, presetId: 'stale' },
        ],
      },
    };
    const read = parseSession(v1)!;
    expect(read.schemaVersion).toBe(2);
    expect(read.song.tracks[0]!.presetSnapshot).toEqual(state.patch);
    expect(read.song.tracks[0]!.presetId).toBe(state.patch.id);
    // A drum track has no synth sound to migrate.
    expect(read.song.tracks[1]!.presetId).toBe('stale');

    // A v2 session is read as saved.
    expect(parseSession({ ...v1, schemaVersion: 2 })!.song.tracks[0]!.presetId).toBe('stale');
  });
});

describe('libraryDiff', () => {
  it('writes only the player’s presets that changed, and deletes the removed ones', () => {
    const a = mine('A');
    const b = mine('B');
    const before = { [a.id]: a, [b.id]: b, [psyRollPreset().id]: psyRollPreset() };
    const renamed = { ...b, name: 'B2' };
    const c = mine('C');
    const after = { [b.id]: renamed, [c.id]: c, [psyRollPreset().id]: psyRollPreset() };
    const diff = libraryDiff(before, after);
    expect(diff.put.map((p) => p.name).sort()).toEqual(['B2', 'C']);
    expect(diff.remove).toEqual([a.id]);
  });
});

describe('safeFileName', () => {
  it('makes a name a phone accepts', () => {
    expect(safeFileName('First Psy Melody!', 'json')).toBe('First-Psy-Melody.json');
    expect(safeFileName('///', 'wav')).toBe('sag.wav');
  });
});
