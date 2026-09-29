/**
 * src/runtime/channel-strip.ts — one channel of the mixer: a sound, a fader, a pan, a duck.
 *
 * C5b. Before this, every pitched track played the ONE live patch through one shared chain,
 * and `getUnimplemented()` said so (`applySong.perTrackPreset`, `applySong.perTrackMix`).
 * A channel now owns a `SynthInstrument` built from its track's `presetSnapshot`, so two
 * channels are two different sounds rather than two lanes of notes on one.
 *
 * The chain, per channel:
 *
 * ```
 *   SynthInstrument -> duck(Gain) -> pan(Panner) -> fader(Volume) -> the shared FX input
 * ```
 *
 * **The duck moved, and that is a deliberate, audible change.** It used to sit between the
 * EQ and master, so the kick dipped the whole mix INCLUDING the effect tails. Here it dips
 * one channel before the FX, which is what a psytrance sidechain means: the bass gets out of
 * the kick's way while the reverb keeps breathing. Recorded in the C5 plan rather than
 * discovered later.
 *
 * **Why the fader is a `Tone.Volume` and the duck a `Tone.Gain`.** `SongTrack.volume` is
 * decibels, and `Volume` is the node that takes decibels with the right curve. The duck is
 * scheduled as a linear gain multiplier (`duckPoints` in core), and writing that onto a dB
 * param would apply an exponential ramp to a signed dB value — the `writeParam` trap.
 */

import * as Tone from 'tone';
import type { DuckConfig, SynthPreset } from '../core/types';
import type { VoiceId } from '../core/state';
import { duckPoints } from '../core/duck';
import { SynthInstrument } from './synth-instrument';
import { dirtySections } from './patch-sections';
import { PARAM_RAMP_SECONDS, immediate, writeParam, type WriteMode } from './tone-shared';

export interface ChannelStripOptions {
  /** Where this channel goes: the head of the shared effects chain. */
  output: Tone.InputNode;
  /** Something asked for that cannot be done — see `ToneRuntime.getUnimplemented`. */
  report: (gap: string) => void;
}

export class ChannelStrip {
  readonly instrument: SynthInstrument;
  private readonly duckGain: Tone.Gain;
  private readonly panner: Tone.Panner;
  private readonly fader: Tone.Volume;

  /** The snapshot this channel was last built from — the diff input for the next apply. */
  private patch: SynthPreset | null = null;
  private volumeDb: number | null = null;
  private pan: number | null = null;
  private duck: DuckConfig | null = null;

  constructor(options: ChannelStripOptions) {
    this.duckGain = new Tone.Gain(1);
    // `channelCount: 2` is load-bearing, and the default is the trap. `Tone.Panner` sets
    // `channelCount: 1` with `channelCountMode: 'explicit'` (Panner.js:38-46), so a stereo
    // input is DOWNMIXED TO MONO before it is panned. At the default this strip silently
    // collapsed every channel's stereo image — the per-voice pan and anything an LFO does
    // to it — which no level assertion would have caught. Found by the locked-LFO pan gate.
    this.panner = new Tone.Panner({ pan: 0, channelCount: 2 });
    this.fader = new Tone.Volume(0);
    this.instrument = new SynthInstrument({ output: this.duckGain, report: options.report });
    this.duckGain.connect(this.panner);
    this.panner.connect(this.fader);
    this.fader.connect(options.output);
  }

  /**
   * Push this channel's sound. Only the sections that changed are written, by exactly the
   * same rule `applyPatch` uses for the live patch — a knob moved on channel A must not
   * rebuild channel B's modulation graph, and must not rebuild the parts of A that did
   * not move either.
   */
  apply(patch: SynthPreset): void {
    const previous = this.patch;
    const dirty = dirtySections(previous, patch);
    this.patch = patch;
    // Even a write of nothing hands the instrument the newest document: voices are built
    // lazily and `voiceFor` reads it.
    const mode: WriteMode = previous === null ? 'step' : 'ramp';
    this.instrument.apply(patch, new Set(dirty), mode);
  }

  /** The sound this channel is playing, or null before the first `apply`. */
  get sound(): SynthPreset | null {
    return this.patch;
  }

  /** The fader and the pan, written only when they move. */
  setMix(volumeDb: number, pan: number): void {
    const mode: WriteMode = this.volumeDb === null ? 'step' : 'ramp';
    if (this.volumeDb !== volumeDb) {
      // `linear`: `Volume.volume` is decibels, so an exponential ramp over a signed dB
      // value would take the wrong path (and cannot pass through 0 at all).
      writeParam(this.fader.volume, volumeDb, mode, 'linear');
      this.volumeDb = volumeDb;
    }
    if (this.pan !== pan) {
      writeParam(this.panner.pan, pan, mode);
      this.pan = pan;
    }
  }

  /** The duck this channel listens with, or null. Taking one away resets the gain to unity. */
  setDuck(duck: DuckConfig | null): void {
    if (this.duck !== null && duck === null) this.resetDuck();
    this.duck = duck;
  }

  get duckSource(): string | null {
    return this.duck?.sourceTrackId ?? null;
  }

  /**
   * Write one window's dips. The curve is anchored at the level the gain actually has at
   * the first hit — which may still be recovering from a hit in the previous window — so a
   * window boundary can never step the gain.
   */
  scheduleDuck(times: readonly number[]): void {
    const duck = this.duck;
    if (duck === null || times.length === 0) return;
    const gain = this.duckGain.gain;
    const first = times[0]!;
    const start = gain.getValueAtTime(first);
    gain.cancelScheduledValues(first);
    for (const point of duckPoints(times, duck, start)) {
      if (point.kind === 'set') gain.setValueAtTime(point.gain, point.time);
      else gain.linearRampToValueAtTime(point.gain, point.time);
    }
  }

  resetDuck(): void {
    const now = immediate();
    const gain = this.duckGain.gain;
    const held = gain.getValueAtTime(now);
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(held, now);
    gain.linearRampToValueAtTime(1, now + PARAM_RAMP_SECONDS);
  }

  releaseNow(voiceId: VoiceId): void {
    this.instrument.releaseNow(voiceId);
  }

  dispose(): void {
    this.instrument.dispose();
    this.duckGain.dispose();
    this.panner.dispose();
    this.fader.dispose();
  }

  /**
   * Whether this strip's nodes were freed. Read off the fader, which is disposed with the
   * rest: a removed channel that keeps its instrument alive leaks a whole synth per
   * channel, and nothing audible would say so.
   */
  get isDisposed(): boolean {
    return this.fader.disposed;
  }

  /** Test affordances, mirroring the runtime's. */
  get voiceCount(): number {
    return this.instrument.voiceCount;
  }

  get nodeCount(): number {
    return this.instrument.nodeCount + 3;
  }
}
