/**
 * src/test-harness/song-sound.ts — put a sound on a song's channels.
 *
 * Before C5 every pitched track played the one live patch, so an audio gate could apply a
 * patch, apply a song built from `defaultTrack()`, and hear the patch. A track now plays its
 * OWN `presetSnapshot` (`channel-strip.ts`), so a gate that wants the whole song to sound
 * like one patch has to say so — which is the same rule the session v1 → v2 migration
 * applies to a saved session, for the same reason.
 *
 * Drum tracks are left alone: they carry a snapshot because F68 makes it required, and they
 * ignore it.
 */

import type { Song, SynthPreset } from '../core/types';

export function withSound(song: Song, patch: SynthPreset): Song {
  return {
    ...song,
    tracks: song.tracks.map((track) =>
      track.isDrum === true
        ? track
        : { ...track, presetSnapshot: structuredClone(patch), presetId: patch.id },
    ),
  };
}
