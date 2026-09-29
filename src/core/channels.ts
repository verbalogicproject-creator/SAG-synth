/**
 * src/core/channels.ts — channels, as the surface sees them (cycle 2, C5).
 *
 * A channel IS a song track (FL's channel rack): a synth channel plays its `presetSnapshot`,
 * a kick channel plays its `kick`. There is no second document for "channel". These helpers
 * are the pure decisions the UI and the dispatcher share — which channels exist, which one a
 * fresh session selects, and the one trick that keeps every panel unchanged:
 * `stateForChannel`, which hands a panel a state whose `patch` is the channel's sound.
 */

import type { EngineState } from './state';
import type { ParamPath, SongTrack, SynthPreset } from './types';

export type ChannelKind = 'synth' | 'kick';

export function channelKind(track: SongTrack): ChannelKind {
  return track.isDrum === true ? 'kick' : 'synth';
}

/** The synth channels, in song order. */
export function synthChannels(state: EngineState): SongTrack[] {
  return state.song.tracks.filter((track) => channelKind(track) === 'synth');
}

/**
 * The channel a surface should have selected: the remembered one if it still exists, else
 * the first synth channel, else the first channel of any kind, else none.
 */
export function resolveChannel(state: EngineState, remembered: string | null): SongTrack | undefined {
  const tracks = state.song.tracks;
  return (
    (remembered === null ? undefined : tracks.find((track) => track.id === remembered)) ??
    tracks.find((track) => channelKind(track) === 'synth') ??
    tracks[0]
  );
}

/**
 * The state a panel should read for `trackId`: identical, except `patch` is that synth
 * channel's sound. Every panel reads through `getParam(state, path)` and `state.patch`, so
 * binding a panel to a channel is this one substitution. A kick channel (or an unknown id)
 * returns the state unchanged — a kick has no synth patch.
 *
 * The FX paths read from this state too, and they must keep reading the SHARED bus until
 * C7, so `effects` stays the live patch's.
 */
export function stateForChannel(state: EngineState, trackId: string | null): EngineState {
  if (trackId === null) return state;
  const track = state.song.tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined || channelKind(track) !== 'synth') return state;
  const patch: SynthPreset = { ...track.presetSnapshot, effects: state.patch.effects };
  return { ...state, patch };
}

/** The sound a live key on `trackId` plays: the channel's, or the live patch. */
export function soundFor(state: EngineState, trackId: string | undefined): SynthPreset {
  if (trackId === undefined) return state.patch;
  const track = state.song.tracks.find((candidate) => candidate.id === trackId);
  return track !== undefined && channelKind(track) === 'synth' ? track.presetSnapshot : state.patch;
}

/**
 * Whether an address belongs to a CHANNEL or to the shared master bus.
 *
 * The enumeration, stated once: the address space has three roots — `voice.*` (the sound a
 * channel plays), `effects.*` (the shared FX chain) and `master.*` (the output stage). Only
 * the first is per channel; until C7 gives every channel its own inserts, the other two are
 * one bus shared by everything, so aiming them at a channel is refused rather than written
 * where no runtime reads.
 *
 * Both the reducer's refusal and the surface's "does this knob carry a trackId" decision
 * read THIS function, so a control can never send what the reducer would refuse.
 * `params.test.ts` gates that every declared address starts with one of the three roots.
 */
export function isChannelPath(path: ParamPath | string): boolean {
  return path.startsWith('voice.');
}
