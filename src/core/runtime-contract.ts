/**
 * src/core/runtime-contract.ts — the audio seam.
 *
 * Decision D2: core declares what an audio backend must do; `src/runtime/` implements
 * it with Tone.js and is the ONLY layer allowed to import `tone`. Because the app layer
 * depends on this interface rather than on Tone, swapping in `NullRuntime` turns the
 * whole engine headless — and that swap IS the v0.2 SAG-SDK seam. Nothing else has to
 * change for Claude Code to drive the synth as a peer client of the React UI.
 *
 * Every method is synchronous except `unlock()`. The hot path (`noteOn`/`noteOff`)
 * must not await anything.
 */

import type { Beats, NoteName, Song, SynthPreset, Unit } from './types';
import type { VoiceId, VoiceSlot } from './state';

export interface RuntimeNoteOn {
  /** Assigned by core's pure allocator (decision D1); the runtime never chooses. */
  voiceId: VoiceId;
  note: NoteName;
  velocity: Unit;
  /** Glide time in seconds, taken from the patch at dispatch time. */
  portamento: number;
  /**
   * The synth channel this note plays on (C5). Absent: the live patch. Voice ids are per
   * channel — voice 0 of one channel and voice 0 of another are different voices.
   */
  trackId?: string;
}

export interface RuntimeNoteOff {
  voiceId: VoiceId;
  note: NoteName;
  trackId?: string;
}

export interface TransportControl {
  play(): void;
  stop(): void;
  pause(): void;
  seek(position: Beats): void;
}

export interface RuntimeAdapter {
  /**
   * Gesture unlock. Browsers refuse to start an AudioContext outside a user gesture,
   * so the app layer must await this from a click handler before the first sound.
   * Idempotent — calling it on an already-running context resolves immediately.
   */
  unlock(): Promise<void>;

  /** Push the whole patch into the audio graph. Never partial — F64. */
  applyPatch(patch: SynthPreset): void;

  noteOn(request: RuntimeNoteOn): void;
  noteOff(request: RuntimeNoteOff): void;

  /**
   * Release a voice the allocator decided to reclaim. Core decides; runtime executes.
   * `trackId` names the channel whose pool it belongs to; absent means the live patch.
   */
  steal(voiceId: VoiceId, trackId?: string): void;

  /** Rebuild tracks, tempo, swing, loop, and scheduled parts from the song document. */
  applySong(song: Song): void;

  transport: TransportControl;

  /** Release every audio node. Locked v1 scope calls this "dispose discipline". */
  dispose(): void;
}

/** Read-only observation of the live audio graph. Never a source of truth for state. */
export interface RuntimeReadout {
  /** Time-domain samples for the oscilloscope. Empty array when silent or headless. */
  getWaveform(): Float32Array;
  /** Master output level in dB full-scale; -Infinity when silent. */
  getLevel(): number;
  /** Transport playhead. Lives here, not in EngineState — it is not reducer state. */
  getPlayhead(): Beats;
}

export type Runtime = RuntimeAdapter & RuntimeReadout;

/**
 * No-op backend. Every gate that does not assert on sound runs against this under plain
 * Node, with no browser and no AudioContext. It also records what it was asked to do,
 * so Phase-2 reducer tests can assert the runtime was driven correctly without rendering
 * a single sample.
 */
export class NullRuntime implements Runtime {
  readonly calls: Array<{ method: string; arg?: unknown }> = [];

  /** Keyed by `voiceKey`: voice ids repeat across channels. */
  private activeVoices = new Map<string, VoiceSlot>();
  private playhead: Beats = 0;
  private disposed = false;

  private record(method: string, arg?: unknown): void {
    this.calls.push(arg === undefined ? { method } : { method, arg });
  }

  unlock(): Promise<void> {
    this.record('unlock');
    return Promise.resolve();
  }

  applyPatch(patch: SynthPreset): void {
    this.record('applyPatch', patch.id);
  }

  noteOn(request: RuntimeNoteOn): void {
    this.record('noteOn', request);
    this.activeVoices.set(voiceKey(request.voiceId, request.trackId), {
      voiceId: request.voiceId,
      note: request.note,
      velocity: request.velocity,
      order: this.activeVoices.size,
    });
  }

  noteOff(request: RuntimeNoteOff): void {
    this.record('noteOff', request);
    this.activeVoices.delete(voiceKey(request.voiceId, request.trackId));
  }

  steal(voiceId: VoiceId, trackId?: string): void {
    // The live patch records the bare id, as before C5, so older assertions still read it.
    this.record('steal', trackId === undefined ? voiceId : { voiceId, trackId });
    this.activeVoices.delete(voiceKey(voiceId, trackId));
  }

  applySong(song: Song): void {
    this.record('applySong', song.id);
  }

  transport: TransportControl = {
    play: () => this.record('transport.play'),
    stop: () => {
      this.record('transport.stop');
      this.playhead = 0;
    },
    pause: () => this.record('transport.pause'),
    seek: (position: Beats) => {
      this.record('transport.seek', position);
      this.playhead = position;
    },
  };

  dispose(): void {
    this.record('dispose');
    this.activeVoices.clear();
    this.disposed = true;
  }

  getWaveform(): Float32Array {
    return new Float32Array(0);
  }

  getLevel(): number {
    return Number.NEGATIVE_INFINITY;
  }

  getPlayhead(): Beats {
    return this.playhead;
  }

  // -- test affordances, not part of the RuntimeAdapter contract ------------

  get isDisposed(): boolean {
    return this.disposed;
  }

  get sounding(): readonly VoiceSlot[] {
    return [...this.activeVoices.values()];
  }

  reset(): void {
    this.calls.length = 0;
    this.activeVoices.clear();
    this.playhead = 0;
    this.disposed = false;
  }
}

function voiceKey(voiceId: VoiceId, trackId: string | undefined): string {
  return `${trackId ?? ''}#${voiceId}`;
}
