/**
 * src/tests/schemas.test.ts — the validation boundary.
 *
 * F64/F61 say a bad command or document is refused BEFORE the reducer runs and before
 * any parameter reaches the audio graph. That only holds if the schemas actually reject
 * things, so every case below is a rejection the engine depends on.
 */

import { describe, expect, it } from 'vitest';
import {
  COMMAND_PAYLOAD_SCHEMAS,
  PresetSchema,
  SongSchema,
  migratePreset,
  migrateSong,
  validateCommand,
  validateParamValue,
} from '../core/schemas';
import { SYNTH_COMMAND_TYPES, setParam, setTrackParam } from '../core/commands';
import { defaultPreset, defaultSong } from '../core/state';
import { PRESET_SCHEMA_VERSION, SONG_SCHEMA_VERSION } from '../core/types';

describe('every command has a schema', () => {
  it('covers all 32 verbs with no orphans', () => {
    expect(Object.keys(COMMAND_PAYLOAD_SCHEMAS).sort()).toEqual([...SYNTH_COMMAND_TYPES].sort());
  });

  it('accepts a minimal valid payload for every verb', () => {
    const samples = {
      loadPreset: { type: 'loadPreset', presetId: 'factory-default' },
      savePreset: { type: 'savePreset', name: 'My Patch' },
      deletePreset: { type: 'deletePreset', presetId: 'p1' },
      setParam: setParam('voice.filter.frequency', 800),
      addLfo: {
        type: 'addLfo',
        config: {
          id: 'lfo-1',
          enabled: true,
          target: 'pitch',
          type: 'sine',
          frequency: 5,
          min: -10,
          max: 10,
          sync: false,
          retrigger: false,
        },
      },
      removeLfo: { type: 'removeLfo', lfoId: 'lfo-1' },
      setEffectEnabled: { type: 'setEffectEnabled', effectId: 'reverb', enabled: true },
      setMasterVolume: { type: 'setMasterVolume', db: -12 },
      newSong: { type: 'newSong' },
      loadSong: { type: 'loadSong', songId: 's1' },
      saveSong: { type: 'saveSong' },
      deleteSong: { type: 'deleteSong', songId: 's1' },
      importSongFile: { type: 'importSongFile', json: '{}' },
      addTrack: { type: 'addTrack', trackId: 't2' },
      removeTrack: { type: 'removeTrack', trackId: 't2' },
      renameTrack: { type: 'renameTrack', trackId: 't2', name: 'Lead' },
      setTrackParam: setTrackParam('t2', 'pan', -0.5),
      setStep: { type: 'setStep', trackId: 't1', stepIndex: 4, active: true, noteId: 'n-4' },
      setPatternLength: { type: 'setPatternLength', trackId: 't1', length: 32 },
      addNote: {
        type: 'addNote',
        trackId: 't1',
        note: { noteId: 'n-1', time: 0, duration: 0.5, note: 'C4', velocity: 0.8 },
      },
      removeNote: { type: 'removeNote', trackId: 't1', noteId: 'n-1' },
      setTempo: { type: 'setTempo', bpm: 128 },
      setSwing: { type: 'setSwing', amount: 0.2 },
      setTimeSignature: { type: 'setTimeSignature', n: 3 },
      play: { type: 'play' },
      stop: { type: 'stop' },
      pause: { type: 'pause' },
      setLoop: { type: 'setLoop', enabled: true, start: 0, end: 8 },
      noteOn: { type: 'noteOn', note: 'C4', velocity: 0.8 },
      noteOff: { type: 'noteOff', note: 'C4' },
      panic: { type: 'panic' },
      importMidi: { type: 'importMidi', bytes: 'TVRoZAAAAAY=' },
    } satisfies Record<(typeof SYNTH_COMMAND_TYPES)[number], unknown>;

    for (const type of SYNTH_COMMAND_TYPES) {
      const result = validateCommand(samples[type]);
      expect(result.ok, `${type}: ${result.ok ? '' : result.error}`).toBe(true);
    }
  });
});

describe('validateCommand rejects', () => {
  it('an unknown verb', () => {
    const result = validateCommand({ type: 'setReverbVibe', value: 11 });
    expect(result).toEqual({ ok: false, error: 'unknown command type "setReverbVibe"' });
  });

  it('a non-object', () => {
    expect(validateCommand('play').ok).toBe(false);
    expect(validateCommand(null).ok).toBe(false);
    expect(validateCommand([{ type: 'play' }]).ok).toBe(false);
  });

  it('an out-of-range tempo', () => {
    const result = validateCommand({ type: 'setTempo', bpm: 9000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('setTempo rejected');
  });

  it('an unknown parameter path — this is what makes ParamPath a contract', () => {
    const result = validateCommand({ type: 'setParam', path: 'voice.filter.vibe', value: 1 });
    expect(result.ok).toBe(false);
  });

  it('a parameter value of the wrong type for its path', () => {
    const result = validateCommand({ type: 'setParam', path: 'voice.filter.frequency', value: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('finite number');
  });

  it('a parameter value outside its declared range', () => {
    const result = validateCommand({ type: 'setParam', path: 'voice.filter.frequency', value: 44100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('out of range');
  });

  it('loadPreset with both presetId and preset, or neither', () => {
    expect(validateCommand({ type: 'loadPreset' }).ok).toBe(false);
    expect(
      validateCommand({ type: 'loadPreset', presetId: 'p1', preset: defaultPreset() }).ok,
    ).toBe(false);
  });

  it('setStep activating a step without a noteId (replay would lose note identity)', () => {
    expect(validateCommand({ type: 'setStep', trackId: 't1', stepIndex: 0, active: true }).ok).toBe(
      false,
    );
    // Deactivating needs no id — there is nothing to name.
    expect(validateCommand({ type: 'setStep', trackId: 't1', stepIndex: 0, active: false }).ok).toBe(
      true,
    );
  });

  it('a malformed note name', () => {
    expect(validateCommand({ type: 'noteOn', note: 'H9', velocity: 1 }).ok).toBe(false);
    expect(validateCommand({ type: 'noteOn', note: 'C4', velocity: 1 }).ok).toBe(true);
    expect(validateCommand({ type: 'noteOn', note: 'F#3', velocity: 0.5 }).ok).toBe(true);
    expect(validateCommand({ type: 'noteOn', note: 'Bb-1', velocity: 0.5 }).ok).toBe(true);
  });

  it('a velocity outside 0..1', () => {
    expect(validateCommand({ type: 'noteOn', note: 'C4', velocity: 127 }).ok).toBe(false);
  });

  it('non-base64 MIDI bytes', () => {
    expect(validateCommand({ type: 'importMidi', bytes: 'not bytes!' }).ok).toBe(false);
  });

  it('a loop whose end precedes its start', () => {
    expect(validateCommand({ type: 'setLoop', enabled: true, start: 8, end: 4 }).ok).toBe(false);
  });

  it('a track param whose value type does not match its path', () => {
    expect(validateCommand({ type: 'setTrackParam', trackId: 't1', path: 'muted', value: 0.5 }).ok).toBe(
      false,
    );
    expect(validateCommand({ type: 'setTrackParam', trackId: 't1', path: 'pan', value: 4 }).ok).toBe(
      false,
    );
  });
});

describe('decision D5 — custom wave shapes are refused with a reason', () => {
  it('names wavetable support rather than saying "invalid enum"', () => {
    const preset = defaultPreset();
    preset.voice.oscillator.type = 'custom' as never;
    const result = PresetSchema.safeParse(preset);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('wavetable');
    }
  });

  it('still accepts the seven shapes that do work', () => {
    for (const shape of ['sine', 'triangle', 'sawtooth', 'square', 'pulse', 'pwm', 'noise']) {
      const preset = defaultPreset();
      preset.voice.oscillator.type = shape as never;
      expect(PresetSchema.safeParse(preset).success, shape).toBe(true);
    }
  });
});

describe('validateParamValue', () => {
  it('accepts an in-range number', () => {
    expect(validateParamValue('voice.envelope.attack', 0.5)).toEqual({ ok: true });
  });

  it('rejects a non-integer where the spec demands one', () => {
    const result = validateParamValue('voice.polyphony', 4.5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('integer');
  });

  it('accepts both Hz and transport subdivisions for LFO frequency', () => {
    expect(validateParamValue('voice.lfos.0.frequency', 4).ok).toBe(true);
    expect(validateParamValue('voice.lfos.0.frequency', '8n').ok).toBe(true);
    expect(validateParamValue('voice.lfos.0.frequency', 'fast').ok).toBe(false);
  });

  it('enforces the enum on stealPolicy', () => {
    expect(validateParamValue('voice.stealPolicy', 'oldest').ok).toBe(true);
    expect(validateParamValue('voice.stealPolicy', 'quietest').ok).toBe(false);
  });
});

describe('document validation', () => {
  it('accepts the built-in defaults', () => {
    expect(PresetSchema.safeParse(defaultPreset()).success).toBe(true);
    expect(SongSchema.safeParse(defaultSong()).success).toBe(true);
  });

  it('rejects a preset missing a required slot (F64 — never partially applies)', () => {
    const preset = defaultPreset() as unknown as Record<string, unknown>;
    delete preset.voice;
    expect(PresetSchema.safeParse(preset).success).toBe(false);
  });

  it('rejects a song track without its preset snapshot (F68 self-containment)', () => {
    const song = defaultSong() as unknown as { tracks: Record<string, unknown>[] };
    delete song.tracks[0]!.presetSnapshot;
    expect(SongSchema.safeParse(song).success).toBe(false);
  });

  it('rejects more than MAX_LFOS lfos', () => {
    const preset = defaultPreset();
    preset.voice.lfos = Array.from({ length: 5 }, (_unused, i) => ({
      id: `lfo-${i}`,
      enabled: true,
      target: 'pitch' as const,
      type: 'sine' as const,
      frequency: 4,
      min: -5,
      max: 5,
      sync: false,
      retrigger: false,
    }));
    expect(PresetSchema.safeParse(preset).success).toBe(false);
  });
});

describe('migration (F65 / F69)', () => {
  it('defaults a versionless preset to version 1 without losing a slot', () => {
    const legacy = defaultPreset() as unknown as Record<string, unknown>;
    delete legacy.schemaVersion;
    const migrated = migratePreset(legacy);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      const parsed = PresetSchema.safeParse(migrated.value);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.schemaVersion).toBe(PRESET_SCHEMA_VERSION);
        expect(parsed.data.voice.filter.frequency).toBe(2000);
      }
    }
  });

  it('defaults a versionless song swing to 0', () => {
    const legacy = defaultSong() as unknown as Record<string, unknown>;
    delete legacy.schemaVersion;
    delete legacy.swing;
    delete legacy.swingSubdivision;
    const migrated = migrateSong(legacy);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      const parsed = SongSchema.safeParse(migrated.value);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.swing).toBe(0);
        expect(parsed.data.schemaVersion).toBe(SONG_SCHEMA_VERSION);
      }
    }
  });

  it('refuses a future version explicitly instead of coercing it', () => {
    const future = { ...defaultPreset(), schemaVersion: 99 };
    const result = migratePreset(future);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('newer than this build understands');

    const futureSong = { ...defaultSong(), schemaVersion: 99 };
    const songResult = migrateSong(futureSong);
    expect(songResult.ok).toBe(false);
  });
});
