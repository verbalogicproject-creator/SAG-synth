/**
 * src/app/midi/midi-import.ts — the durable MidiImportPort.
 *
 * `src/core/ports.ts` declares the seam; this is the `@tonejs/midi`-backed adapter core
 * cannot host itself (layer rule D2: core imports only zod). Every identity and
 * timestamp the resulting `Song` carries comes from `MidiImportOptions`, never from this
 * file, so replaying the same bytes with the same options is a pure function — the
 * property F59 needs from anything the journal can contain.
 */

import { Midi } from '@tonejs/midi';
import type { MidiImportOptions, MidiImportPort, MidiImportResult, MidiImportWarning } from '../../core/ports';
import {
  LIMITS,
  SONG_SCHEMA_VERSION,
  STEPS_PER_BEAT,
  type NoteEvent,
  type Song,
  type SongTrack,
  type SourceMidiInfo,
  type TempoEvent,
} from '../../core/types';
import { defaultLoopRegion, defaultMasterConfig } from '../../core/state';

/**
 * Ticks, not seconds, survive a multi-tempo file exactly. `note.time` is derived from
 * `header.tempos` internally by @tonejs/midi and would silently re-bake whichever tempo
 * was in effect at parse time; `ticks / ppq` is tempo-independent, exactly like `Beats`
 * is defined to be (see the doc comment on `Beats` in core/types.ts).
 */
function ticksToBeats(ticks: number, ppq: number): number {
  return ticks / ppq;
}

/** Strip a trailing ".mid"/".midi" extension for a friendlier default song name. */
function nameFromFilename(filename: string | undefined): string | null {
  if (filename === undefined) return null;
  const stripped = filename.replace(/\.(mid|midi)$/i, '');
  return stripped.length > 0 ? stripped : null;
}

/**
 * `header.tempos` is not bounded by `LIMITS.bpm` the way `TempoEventSchema` is — a
 * corrupt or synthetic file can carry a tempo of 0 or 4000 bpm. Those events are
 * dropped (never clamped, which would silently misrepresent the source) and reported
 * with 'tempo-map-truncated' so the caller knows the map is incomplete.
 */
function buildTempoMap(
  tempos: readonly { ticks: number; bpm: number }[],
  ppq: number,
  warnings: MidiImportWarning[],
): TempoEvent[] {
  const inRange = tempos.filter((t) => Number.isFinite(t.bpm) && t.bpm >= LIMITS.bpm.min && t.bpm <= LIMITS.bpm.max);
  if (inRange.length < tempos.length) {
    warnings.push({
      code: 'tempo-map-truncated',
      message: `${tempos.length - inRange.length} tempo event(s) outside [${LIMITS.bpm.min}, ${LIMITS.bpm.max}] bpm were dropped`,
    });
  }
  return inRange.map((t) => ({ time: ticksToBeats(t.ticks, ppq), bpm: t.bpm }));
}

/** Musical end of a track's notes, in beats, for `patternLength` derivation. */
function trackLengthBeats(notes: readonly NoteEvent[]): number {
  let end = 0;
  for (const note of notes) {
    const noteEnd = note.time + note.duration;
    if (noteEnd > end) end = noteEnd;
  }
  return end;
}

function patternLengthFor(lengthBeats: number): number {
  const steps = Math.ceil(lengthBeats * STEPS_PER_BEAT);
  return Math.min(LIMITS.patternLength.max, Math.max(LIMITS.patternLength.min, steps));
}

/**
 * GM channel 10 is index 9 (@tonejs/midi's `track.channel` is 0-based). F70: flag it
 * rather than mapping it to pitched synthesis, which would make drum notes play at
 * whatever pitch the GM drum map assigns to that MIDI note number.
 */
const DRUM_CHANNEL = 9;

export class ToneMidiImport implements MidiImportPort {
  import(bytes: Uint8Array, options: MidiImportOptions): MidiImportResult {
    const midi = new Midi(bytes);
    const ppq = midi.header.ppq;
    const warnings: MidiImportWarning[] = [];

    const tempoMap = buildTempoMap(midi.header.tempos, ppq, warnings);
    const bpm = tempoMap[0]?.bpm ?? 120;

    const tracks: SongTrack[] = [];
    let hadDrumChannel = false;

    midi.tracks.forEach((track, trackIndex) => {
      const isDrum = track.channel === DRUM_CHANNEL;
      if (isDrum) hadDrumChannel = true;

      if (track.notes.length === 0) {
        warnings.push({
          code: 'empty-track',
          message: `track ${trackIndex} ("${track.name || 'untitled'}") has no notes and was skipped`,
          trackIndex,
        });
        return;
      }

      if (isDrum) {
        warnings.push({
          code: 'drum-channel',
          message: `track ${trackIndex} ("${track.name || 'untitled'}") is on MIDI channel 10 and flagged as a drum track`,
          trackIndex,
        });
      }

      if (track.pitchBends.length > 0 || Object.keys(track.controlChanges).length > 0) {
        warnings.push({
          code: 'unsupported-event',
          message: `track ${trackIndex} carries pitch bend or control change data that this importer does not map`,
          trackIndex,
        });
      }

      const notes: NoteEvent[] = track.notes.map((note, noteIndex) => ({
        noteId: options.noteIdFor(trackIndex, noteIndex),
        time: ticksToBeats(note.ticks, ppq),
        // A zero-length note (durationTicks === 0, e.g. a malformed noteOn/noteOff
        // pair) would fail NoteEventSchema's `positive()` check; floor it to the
        // smallest representable duration rather than dropping the note entirely.
        duration: Math.max(ticksToBeats(note.durationTicks, ppq), 1 / ppq),
        note: note.name,
        velocity: note.velocity,
      }));

      const songTrack: SongTrack = {
        id: options.trackIdFor(trackIndex),
        name: track.name || `Track ${trackIndex + 1}`,
        presetId: null,
        // Cloned per track, not shared. Handing every track the same object makes them
        // alias each other AND alias the caller's live patch, so one in-place edit
        // anywhere would silently rewrite every track's snapshot — the exact coupling
        // `preset_snapshot` exists to prevent (F68 self-containment).
        presetSnapshot: structuredClone(options.defaultPreset),
        notes,
        patternLength: patternLengthFor(trackLengthBeats(notes)),
        volume: 0,
        pan: 0,
        muted: false,
        solo: false,
        ...(isDrum ? { isDrum: true } : {}),
      };
      tracks.push(songTrack);
    });

    const sourceMidi: SourceMidiInfo = {
      filename: options.filename ?? '',
      importedAt: options.createdAt,
      trackCount: midi.tracks.length,
      hadDrumChannel,
    };

    const song: Song = {
      id: options.songId,
      name: nameFromFilename(options.filename) ?? (midi.header.name || midi.name || 'Imported Song'),
      schemaVersion: SONG_SCHEMA_VERSION,
      bpm,
      // @tonejs/midi's timeSignature is `[numerator, denominator]`; Song only models
      // the numerator (beats per bar), matching KIND-synth_song's `time_signature` slot.
      timeSignature: midi.header.timeSignatures[0]?.timeSignature[0] ?? 4,
      swing: 0,
      swingSubdivision: '16n',
      tracks,
      master: defaultMasterConfig(),
      loop: defaultLoopRegion(),
      createdAt: options.createdAt,
      updatedAt: options.createdAt,
      ...(tempoMap.length > 0 ? { tempoMap } : {}),
      sourceMidi,
    };

    return { song, warnings };
  }
}
