/**
 * src/runtime/tone-runtime.ts — the audio backend.
 *
 * The ONLY file in the project allowed to import `tone`. `src/core/` is barred from it
 * by the layer rule and `src/app/` by its adapter allowlist, both enforced in
 * src/tests/contract.test.ts. That is not tidiness: swapping this class for
 * `NullRuntime` is what makes the engine headless, and a headless engine is the v0.2
 * SAG-SDK seam. One stray `import 'tone'` upstream and the SDK needs a browser.
 *
 * Why a pool of `MonoSynth` and never `Tone.PolySynth`: PolySynth owns voice allocation
 * and hard-codes oldest-steal. Decision D1 gives that decision to `core/allocate.ts` as
 * a pure function, because the same allocation has to happen identically during live
 * play and during journal replay. This class is told which voice sounds and which dies;
 * it never chooses.
 *
 * STAGE 1 SCOPE. `applyPatch` reads only `oscillator.type` and `envelope`. Filter,
 * filter envelope, LFOs, unison, velocity mapping and the effects chain arrive in
 * Stages 2-3. Unimplemented adapter methods are recorded and warned about rather than
 * throwing — see `notImplemented` below.
 */

import * as Tone from 'tone';
import type { Beats, Song, SynthPreset } from '../core/types';
import type { VoiceId } from '../core/state';
import type {
  Runtime,
  RuntimeNoteOn,
  RuntimeNoteOff,
  TransportControl,
} from '../core/runtime-contract';

/**
 * Provisional master trim for Stage 1.
 *
 * `defaultMasterConfig().volume` is -6 dB, but eight voices at velocity 1 measured a
 * peak of **1.0122** through that — real clipping, because Web Audio hard-clips at ±1.
 * Stage 3 replaces this with the patch's own master volume behind a limiter (open
 * question Q1). Until then the runtime buys headroom statically, rather than shipping a
 * gate that was relaxed to accommodate distortion.
 */
const STAGE1_MASTER_VOLUME_DB = -12;

/**
 * Minimum spacing between two scheduled events on the SAME voice, in seconds.
 *
 * Tone asserts that a source's start time is strictly greater than its previous one, so
 * two events landing on one voice at the same clock instant throw — which would take
 * down the whole `dispatch()` call. That happens constantly under `Tone.Offline` (the
 * callback runs synchronously, so every call reads the same `now`), and it is reachable
 * live too: `steal(id)` is issued immediately before the `noteOn` that reuses the slot,
 * and a fast retrigger of a held note lands on the voice it is already sounding.
 *
 * 0.1 ms is below the threshold of hearing for onset timing and far below one sample at
 * 44.1 kHz being audible as a shift, so nudging is inaudible.
 */
const MIN_EVENT_GAP_SECONDS = 1e-4;

/** Analyser window; only used by the debug readout, never by a gate. */
const WAVEFORM_SIZE = 1024;

export class ToneRuntime implements Runtime {
  private readonly master: Tone.Volume;
  private readonly analyser: Tone.Analyser;
  private readonly meter: Tone.Meter;

  /** Keyed by the voiceId CORE assigned. Built lazily — polyphony can be up to 32. */
  private readonly voices = new Map<VoiceId, Tone.MonoSynth>();

  /** Last time scheduled on each voice; see MIN_EVENT_GAP_SECONDS. */
  private readonly lastEventTime = new Map<VoiceId, number>();

  private patch: SynthPreset | null = null;
  private disposed = false;

  /** Methods called that this stage does not implement, in call order, deduplicated. */
  private readonly unimplemented = new Set<string>();

  constructor() {
    this.master = new Tone.Volume(STAGE1_MASTER_VOLUME_DB).toDestination();
    this.analyser = new Tone.Analyser('waveform', WAVEFORM_SIZE);
    this.meter = new Tone.Meter();
    this.master.connect(this.analyser);
    this.master.connect(this.meter);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Browsers refuse to start an AudioContext outside a user gesture, so this must be
   * awaited from inside a real click handler. Idempotent: `Tone.start()` on an already
   * running context resolves immediately.
   */
  async unlock(): Promise<void> {
    await Tone.start();
  }

  dispose(): void {
    for (const voice of this.voices.values()) voice.dispose();
    this.voices.clear();
    this.lastEventTime.clear();
    this.analyser.dispose();
    this.meter.dispose();
    this.master.dispose();
    this.disposed = true;
  }

  // -------------------------------------------------------------------------
  // Patch
  // -------------------------------------------------------------------------

  /**
   * F64 — never partial. Every live voice is updated, or none is: the options object is
   * built completely before a single `.set()` runs, so a malformed patch cannot leave
   * half the pool on the old sound and half on the new.
   */
  applyPatch(patch: SynthPreset): void {
    const options = monoSynthOptions(patch);
    this.patch = patch;
    for (const voice of this.voices.values()) voice.set(options);
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------

  private voiceFor(voiceId: VoiceId): Tone.MonoSynth {
    const existing = this.voices.get(voiceId);
    if (existing !== undefined) return existing;

    const voice = new Tone.MonoSynth(
      this.patch === null ? undefined : monoSynthOptions(this.patch),
    ).connect(this.master);
    this.voices.set(voiceId, voice);
    return voice;
  }

  /**
   * The clock, made strictly monotonic per voice.
   *
   * `Tone.now()` is re-read on every call, so this tracks the audio clock rather than
   * drifting from it; the only adjustment is the minimum gap that keeps Tone's
   * strictly-increasing assertion satisfied when two events land on one voice at the
   * same instant.
   */
  private nextEventTime(voiceId: VoiceId): number {
    const now = Tone.now();
    const previous = this.lastEventTime.get(voiceId);
    const time =
      previous === undefined ? now : Math.max(now, previous + MIN_EVENT_GAP_SECONDS);
    this.lastEventTime.set(voiceId, time);
    return time;
  }

  noteOn(request: RuntimeNoteOn): void {
    const voice = this.voiceFor(request.voiceId);
    voice.portamento = request.portamento;
    voice.triggerAttack(request.note, this.nextEventTime(request.voiceId), request.velocity);
  }

  noteOff(request: RuntimeNoteOff): void {
    // A note-off for a voice that was never built is a no-op, not an error: core's
    // allocator may have stolen and reassigned the slot already.
    const voice = this.voices.get(request.voiceId);
    if (voice !== undefined) voice.triggerRelease(this.nextEventTime(request.voiceId));
  }

  /**
   * Release a voice core decided to reclaim. The dispatcher issues this immediately
   * before the `noteOn` that reuses the slot, so the release tail is cut short by the
   * new attack rather than ringing over it — which is exactly the same-instant collision
   * `nextEventTime` exists to survive.
   */
  steal(voiceId: VoiceId): void {
    const voice = this.voices.get(voiceId);
    if (voice !== undefined) voice.triggerRelease(this.nextEventTime(voiceId));
  }

  // -------------------------------------------------------------------------
  // Not implemented in v0.1.0 (live keys only)
  // -------------------------------------------------------------------------

  /**
   * Records and warns once, rather than throwing.
   *
   * Throwing would be more honest in isolation but wrong in context: `applySong` is
   * called from the dispatcher's runtime sync, so any song-scoped command would blow up
   * mid-dispatch and take the engine with it. Silently ignoring it is the other failure
   * — it lets a caller believe the transport works. Recording it does neither: nothing
   * crashes, and `getUnimplemented()` says exactly what was asked for and not delivered.
   */
  private notImplemented(method: string): void {
    if (this.unimplemented.has(method)) return;
    this.unimplemented.add(method);
    console.warn(`ToneRuntime.${method} is not implemented in v0.1.0 (live keys only)`);
  }

  /** What this runtime was asked to do and could not. Empty is the expected value. */
  getUnimplemented(): readonly string[] {
    return [...this.unimplemented];
  }

  applySong(song: Song): void {
    void song;
    this.notImplemented('applySong');
  }

  readonly transport: TransportControl = {
    play: () => this.notImplemented('transport.play'),
    stop: () => this.notImplemented('transport.stop'),
    pause: () => this.notImplemented('transport.pause'),
    seek: () => this.notImplemented('transport.seek'),
  };

  // -------------------------------------------------------------------------
  // Readouts — observation only, never a source of truth
  // -------------------------------------------------------------------------

  getWaveform(): Float32Array {
    const values = this.analyser.getValue();
    return values instanceof Float32Array ? values : new Float32Array(0);
  }

  getLevel(): number {
    const value = this.meter.getValue();
    return typeof value === 'number' ? value : Number.NEGATIVE_INFINITY;
  }

  /** The playhead lives in Tone.Transport, which v0.1.0 does not drive. */
  getPlayhead(): Beats {
    return 0;
  }

  // -- test affordances, mirroring NullRuntime ------------------------------

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** How many Tone voices have actually been built. Proves the pool stays lazy. */
  get voiceCount(): number {
    return this.voices.size;
  }
}

/**
 * Translate a patch into `Tone.MonoSynth` options.
 *
 * Exported so an audio gate can assert the mapping without constructing a whole
 * runtime, and so Stage 2 has one obvious place to widen.
 *
 * MonoSynth is oscillator + amp envelope + filter + filter envelope, which is close to
 * a 1:1 fit for our `VoiceConfig` — that near-isomorphism is why the Phase-1 harness
 * could already drive it with our parameter names. Stage 1 deliberately reads only the
 * first two; the rest is Stage 2, and reading a field here before its gate exists would
 * make the runtime look more finished than it is.
 */
export function monoSynthOptions(patch: SynthPreset): {
  oscillator: { type: 'sine' | 'triangle' | 'sawtooth' | 'square' };
  envelope: { attack: number; decay: number; sustain: number; release: number };
} {
  const { oscillator, envelope } = patch.voice;
  return {
    oscillator: { type: basicWaveShape(oscillator.type) },
    envelope: {
      attack: envelope.attack,
      decay: envelope.decay,
      sustain: envelope.sustain,
      release: envelope.release,
    },
  };
}

/**
 * Stage 1 handles only the four basic periodic shapes.
 *
 * `pulse` and `pwm` need a width parameter and `noise` is a different node type
 * entirely; mapping them onto Tone's type-string encoding is the Stage 2 job listed as
 * a known hard spot. Falling back to `sawtooth` is a visible placeholder rather than a
 * silent wrong sound — the patch is unchanged, so widening the mapping later changes
 * only what is heard, never what is stored.
 */
function basicWaveShape(shape: string): 'sine' | 'triangle' | 'sawtooth' | 'square' {
  switch (shape) {
    case 'sine':
    case 'triangle':
    case 'square':
      return shape;
    default:
      return 'sawtooth';
  }
}
