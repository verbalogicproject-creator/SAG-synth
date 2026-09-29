/**
 * src/core/schedule.ts — which note events fall in a window of the song, as a pure function.
 *
 * The runtime's transport is a pump: every few tens of milliseconds `Tone.Transport` calls
 * back with an audio-clock time and a beat position, and the runtime asks THIS function what
 * happens in the next `length` beats. Nothing is pre-baked into a `Tone.Part`, so an edit
 * made while the loop plays lands on the next window with no invalidation step — the song
 * the pump reads is simply the latest one.
 *
 * Kept pure (no `tone`, per D2) so the decisions a sequencer makes — loop wrap, swing,
 * mute/solo, and the order of simultaneous events — are runner tests, not something found
 * out by ear on a phone.
 *
 * **The timeline is linear, and looping is the song's `loop` region.** `patternLength` is a
 * grid VIEW (`types.ts`), not a playback length: MIDI import writes notes far past it. So a
 * one-bar psytrance loop is `loop: { enabled, start: 0, end: 4 }`, not a 16-step pattern.
 */

import type { Beats, NoteName, Song, SongTrack, Unit } from './types';

export interface ScheduledEvent {
  /** Beats from the window's start, swing already applied. Never negative. */
  offset: Beats;
  kind: 'on' | 'off';
  trackId: string;
  noteId: string;
  note: NoteName;
  velocity: Unit;
  drum: boolean;
  /**
   * False for a muted track, or a non-solo track while another is soloed. The event is
   * still reported because a duck keyed to a muted kick keeps ducking — the way a pre-fader
   * sidechain send does in a DAW. Muting the kick to hear the bass alone should let you hear
   * the bass as it will sit in the mix, dips and all.
   */
  audible: boolean;
}

/**
 * How far swing delays a note at `beat`, in beats. Tone's own Transport formula
 * (`Transport._processTick`), transcribed rather than delegated: the runtime keeps
 * `Transport.swing` at 0, because Tone would otherwise swing the pump's own callbacks too
 * and every off-beat note would be delayed twice.
 *
 * `amount` 0..1; a pair is two subdivisions. The delay is a half-sine across the pair, so
 * the downbeat and the pair boundary never move and the off-beat moves most — by
 * `amount * pair / 3` at full swing.
 */
export function swingDelay(beat: Beats, amount: Unit, subdivision: '8n' | '16n'): Beats {
  if (amount <= 0) return 0;
  const pair = subdivision === '8n' ? 1 : 0.5;
  const within = ((beat % pair) + pair) % pair;
  const progress = within / pair;
  return Math.sin(progress * Math.PI) * amount * (pair / 3);
}

/**
 * Where a pump window starts, in beats, from the Transport's tick reading at the window's
 * time — SNAPPED to the pump's own grid.
 *
 * Found on the device, and it was both of Eyal's symptoms. Each window used to compute its
 * start from `getTicksAtTime(time)`, and online that reading drifts: 23.999999999995453 for
 * 24, 744.0000000000018 for 744. Windows computed independently from drifting reads do not
 * tile. A start that reads a hair EARLY overlaps the previous window, so an event on the
 * boundary is scheduled twice — a bass note attacked twice 0.1 ms apart (the crack), a kick
 * started twice (Tone asserts, the throw aborted the window and knocked the Transport into
 * re-delivering windows). A start that reads a hair LATE leaves a gap, and an event on the
 * boundary is scheduled by neither — a missing note (the "off beat").
 *
 * Tone fires the pump every `windowTicks` exactly, so the true start is always a multiple of
 * it; rounding to the nearest one removes the drift and makes consecutive windows tile by
 * construction. Pure so the tiling is a runner test.
 */
export function windowStartBeats(ticks: number, windowTicks: number, ppq: number): Beats {
  return (Math.round(ticks / windowTicks) * windowTicks) / ppq;
}

/** Tracks that can be heard right now: solo wins over everything, mute over the rest. */
export function audibleTrackIds(song: Song): Set<string> {
  const soloed = song.tracks.filter((track) => track.solo);
  const pool = soloed.length > 0 ? soloed : song.tracks;
  return new Set(pool.filter((track) => !track.muted).map((track) => track.id));
}

interface Segment {
  /** Song beats [from, to). */
  from: Beats;
  to: Beats;
  /** Where `from` sits relative to the window's start. */
  offset: Beats;
}

/**
 * The window, unrolled into the stretches of song time it actually covers. With the loop
 * on, a window that crosses `loop.end` continues at `loop.start`, possibly several times
 * over for a very short loop.
 */
function segments(song: Song, from: Beats, length: Beats): Segment[] {
  const { loop } = song;
  if (!loop.enabled) return [{ from, to: from + length, offset: 0 }];
  // Tone's loop test (`Transport._processTick`) is `ticks >= loopEnd`, nothing about
  // loopStart: playback that starts before the loop still wraps at its end, and a position
  // at or past the end jumps straight to the start. Mirrored exactly, or the pump and the
  // clock would disagree about where the song is.
  const out: Segment[] = [];
  let cursor = from >= loop.end ? loop.start : from;
  let consumed = 0;
  while (consumed < length) {
    const to = Math.min(loop.end, cursor + (length - consumed));
    // A remainder smaller than float resolution AT this beat adds nothing (7.9 + 1e-16 ===
    // 7.9), `consumed` stops advancing, and the loop never ends. Found by the LP1 test as an
    // out-of-memory worker; the pump would have hung a phone the same way.
    if (!(to > cursor)) break;
    out.push({ from: cursor, to, offset: consumed });
    consumed += to - cursor;
    cursor = to >= loop.end ? loop.start : to;
  }
  return out;
}

/**
 * The note-off beat of a note, clipped to the loop end when looping. A note that starts
 * inside the loop and would end past it must still stop at the wrap, or the transport jumps
 * back and the release never arrives: a stuck note.
 */
function offBeat(song: Song, time: Beats, duration: Beats): Beats {
  const end = time + duration;
  const { loop } = song;
  if (loop.enabled && time < loop.end) return Math.min(end, loop.end);
  return end;
}

/**
 * Every note-on and note-off in `[from, from + length)`, in the order they must be applied.
 *
 * Order: by offset; at equal offsets, **off before on** (a note ending exactly where the next
 * starts frees its voice first — the psytrance case, where the same G1 retriggers every 16th),
 * then by trackId, then noteId. The last two are what make the verdict a function of the
 * data rather than of array order, so the allocator downstream is replayable (F59).
 *
 * Window membership uses the note's UNSWUNG beat; swing only ever delays, so an event is
 * scheduled at most `pair / 3` beats after its window, which is still in the audio future.
 */
export function eventsInWindow(song: Song, from: Beats, length: Beats): ScheduledEvent[] {
  if (!(length > 0)) return [];
  const audible = audibleTrackIds(song);
  const events: ScheduledEvent[] = [];

  for (const segment of segments(song, from, length)) {
    for (const track of song.tracks) {
      collect(song, track, segment, audible.has(track.id), events);
    }
  }

  return events.sort(
    (a, b) =>
      a.offset - b.offset ||
      (a.kind === b.kind ? 0 : a.kind === 'off' ? -1 : 1) ||
      a.trackId.localeCompare(b.trackId) ||
      a.noteId.localeCompare(b.noteId),
  );
}

function collect(
  song: Song,
  track: SongTrack,
  segment: Segment,
  audible: boolean,
  out: ScheduledEvent[],
): void {
  const drum = track.isDrum === true;
  const place = (beat: Beats): Beats =>
    segment.offset + (beat - segment.from) + swingDelay(beat, song.swing, song.swingSubdivision);

  for (const note of track.notes) {
    const base = {
      trackId: track.id,
      noteId: note.noteId,
      note: note.note,
      velocity: note.velocity,
      drum,
      audible,
    };
    if (note.time >= segment.from && note.time < segment.to) {
      out.push({ ...base, kind: 'on', offset: place(note.time) });
    }
    // The off is swung by the ON's delay, so swing moves a note rather than stretching it.
    const off = offBeat(song, note.time, note.duration);
    if (off >= segment.from && off < segment.to) {
      const delay = swingDelay(note.time, song.swing, song.swingSubdivision);
      out.push({ ...base, kind: 'off', offset: segment.offset + (off - segment.from) + delay });
    }
    // A note clipped to the loop end has its off AT `loop.end`, which the half-open segment
    // [from, loop.end) excludes. Emit it at the segment's end instead.
    if (off === segment.to && song.loop.enabled && off === song.loop.end && note.time < off) {
      const delay = swingDelay(note.time, song.swing, song.swingSubdivision);
      out.push({ ...base, kind: 'off', offset: segment.offset + (off - segment.from) + delay });
    }
  }
}
