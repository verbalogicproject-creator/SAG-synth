/**
 * src/core/export.ts — what a WAV export plays (cycle 2, C3c).
 *
 * Eyal asked for WAV export. The render is the live engine run offline on a copy of the song,
 * and the copy is decided here, purely:
 *
 * **The loop is UNROLLED, not looped.** Letting the transport loop and stopping it after N
 * passes leaks: the sequencer schedules ahead of the clock, so the first kick of pass N+1 is
 * already booked when the stop lands, and every export would end on a stray downbeat. So the
 * loop region is written out N times as a straight line, the copy has no loop, and the
 * transport simply runs out of notes. The release tail after that is the patch's own, not a
 * cut.
 *
 * Unrolling mirrors what looping does (`schedule.ts`): notes inside [loop.start, loop.end)
 * play each pass, a note crossing loop.end is cut at it (the loop's own note-off), and a note
 * outside the region never plays. Ids get a pass suffix so every note in the copy is unique.
 */

import type { Beats, NoteEvent, Song } from './types';

/** How long the sound is let ring after the last note, beyond the patch's release. */
export const EXPORT_TAIL_SECONDS = 1.5;
/** Longest release the tail waits for: a 20 s pad release is not worth 20 s of file. */
export const EXPORT_MAX_RELEASE_SECONDS = 4;
/** Longest export, in seconds of music. The file cap on the phone is 64 MB (~6 min). */
export const EXPORT_MAX_SECONDS = 300;

export interface ExportPlan {
  /** The song to render: no loop, notes laid out end to end, starting at beat 0. */
  song: Song;
  /** Beats of music. */
  beats: Beats;
  /** Seconds of music, before the tail. */
  musicSeconds: number;
  /** Seconds to render in total, tail included. */
  renderSeconds: number;
}

function lastNoteEnd(song: Song): Beats {
  let end = 0;
  for (const track of song.tracks) for (const note of track.notes) end = Math.max(end, note.time + note.duration);
  return end;
}

/**
 * The copy of `song` to render: its loop `loops` times, or — with the loop off — the whole
 * song once, up to the end of its last note (at least one bar, so an empty song still
 * renders a short silence rather than nothing).
 */
export function exportPlan(song: Song, loops: number, releaseSeconds: number): ExportPlan {
  const passes = Math.max(1, Math.floor(loops));
  const secondsPerBeat = 60 / song.bpm;
  const cap = Math.floor(EXPORT_MAX_SECONDS / secondsPerBeat);

  let beats: Beats;
  let tracks: Song['tracks'];
  if (song.loop.enabled && song.loop.end > song.loop.start) {
    const { start, end } = song.loop;
    const span = end - start;
    const fit = Math.max(1, Math.min(passes, Math.floor(cap / span)));
    beats = span * fit;
    tracks = song.tracks.map((track) => {
      const inside = track.notes.filter((note) => note.time >= start && note.time < end);
      const notes: NoteEvent[] = [];
      for (let pass = 0; pass < fit; pass += 1) {
        for (const note of inside) {
          notes.push({
            ...note,
            noteId: `${note.noteId}~${pass}`,
            time: note.time - start + pass * span,
            duration: Math.min(note.duration, end - note.time),
          });
        }
      }
      return { ...track, notes };
    });
  } else {
    beats = Math.min(Math.max(lastNoteEnd(song), song.timeSignature), cap);
    tracks = song.tracks.map((track) => ({ ...track, notes: track.notes.filter((note) => note.time < beats) }));
  }

  const musicSeconds = beats * secondsPerBeat;
  const tail = EXPORT_TAIL_SECONDS + Math.min(Math.max(releaseSeconds, 0), EXPORT_MAX_RELEASE_SECONDS);
  return {
    song: { ...song, tracks, loop: { ...song.loop, enabled: false } },
    beats,
    musicSeconds,
    renderSeconds: musicSeconds + tail,
  };
}
