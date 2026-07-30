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
 * SCOPE. `applyPatch` currently reads `oscillator.type`, `envelope`, `filter` and
 * `filterEnvelope`. Still to come, each with its own audio gate: oscillator unison
 * (`count`/`spread`/`width`), `velocity.*`, `lfos`, and the effects chain.
 *
 * Two kinds of honesty about what is missing, deliberately kept separate: adapter
 * methods this version cannot service are recorded at call time by `notImplemented`,
 * while contract parameters it does not read are listed statically in `UNMAPPED_PARAMS`.
 * The debug surface shows both, so nothing that does nothing looks like it works.
 */

import * as Tone from 'tone';
import type { Beats, FilterRolloff, FilterType, Song, SynthPreset } from '../core/types';
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

/**
 * Below this, treat the meter as silent.
 *
 * `Tone.Meter` smooths toward zero amplitude rather than snapping to it, and
 * `20·log₁₀` of a denormal float is a huge negative number, not `-Infinity` — a real
 * reading of **-2105.3 dBFS** was observed on device. Any caller checking
 * `Number.isFinite` therefore passes it straight through and prints nonsense.
 */
const SILENCE_FLOOR_DB = -100;

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
   * called from inside a handler for an event the browser counts as a user activation.
   * Idempotent: `Tone.start()` on an already running context resolves immediately.
   *
   * IMPORTANT: this resolving does NOT mean audio is running. `Tone.start()` calls
   * `AudioContext.resume()`, which resolves whether or not the browser honoured it —
   * so a caller that sets an `unlocked` flag on resolution will believe it succeeded
   * when it did not. Read `getContextState()` instead; that is the only truth.
   */
  async unlock(): Promise<void> {
    await Tone.start();
  }

  /**
   * The live AudioContext state: 'suspended' | 'running' | 'closed'.
   *
   * The single source of truth for "can this thing make a sound right now". Android
   * suspends the context whenever the tab is backgrounded, so this flips back to
   * 'suspended' long after a successful unlock, with no event a caller can rely on.
   */
  getContextState(): string {
    return Tone.getContext().state;
  }

  /**
   * The audio clock, in seconds.
   *
   * Diagnostic. A context reporting `running` whose clock is NOT advancing is a
   * different fault from one that is suspended, and the two are indistinguishable from
   * `state` alone — which is exactly the ambiguity that made a silent synth hard to
   * explain.
   */
  getContextTime(): number {
    return Tone.getContext().currentTime;
  }

  getSampleRate(): number {
    return Tone.getContext().sampleRate;
  }

  /**
   * Play a beep that bypasses everything this class does — no voice pool, no patch, no
   * master chain, straight to the destination.
   *
   * The one measurement that splits "this page cannot produce audio at all" from "our
   * signal path is broken". Without it, a silent synth has a dozen candidate causes and
   * no way to eliminate any of them.
   */
  selfTest(): void {
    const osc = new Tone.Oscillator(440, 'sine').toDestination();
    osc.volume.value = -12;
    const now = Tone.now();
    osc.start(now).stop(now + 0.3);
    // Free the node once it has finished sounding; disposing at stop time would cut it.
    setTimeout(() => osc.dispose(), 1000);
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
    if (typeof value !== 'number' || !Number.isFinite(value) || value < SILENCE_FLOOR_DB) {
      return Number.NEGATIVE_INFINITY;
    }
    return value;
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
 * Contract parameters this runtime deliberately does not read, and why.
 *
 * `voice.filter.frequency` collides with `voice.filterEnvelope.baseFrequency`. In
 * `Tone.MonoSynth` the filter's cutoff is driven ENTIRELY by the filter envelope — it
 * sweeps `baseFrequency` up to `baseFrequency × 2^octaves` — and the filter's own
 * `frequency` option is overwritten. Only one of our two parameters can be the cutoff.
 *
 * The shipped defaults settle which: `baseFrequency: 300, octaves: 3` is a designed
 * sweep to 2400 Hz. Treating `filter.frequency: 2000` as the base instead would sweep
 * to 16 kHz and make the factory patch a different, far brighter instrument. So
 * `filterEnvelope.baseFrequency` is authoritative — which is also the 1:1 name match
 * to Tone, and therefore the least surprising mapping.
 *
 * Listed here rather than silently skipped: the debug surface displays it, so a
 * parameter that does nothing says so instead of looking broken.
 */
export const UNMAPPED_PARAMS: readonly string[] = ['voice.filter.frequency'];

interface MonoSynthOptions {
  oscillator: { type: 'sine' | 'triangle' | 'sawtooth' | 'square' };
  envelope: { attack: number; decay: number; sustain: number; release: number };
  filter: { type: FilterType; Q: number; rolloff: FilterRolloff };
  filterEnvelope: {
    attack: number;
    decay: number;
    sustain: number;
    release: number;
    baseFrequency: number;
    octaves: number;
  };
}

/**
 * Translate a patch into `Tone.MonoSynth` options.
 *
 * Exported so an audio gate can assert the mapping without constructing a whole
 * runtime, and so each stage has one obvious place to widen.
 *
 * MonoSynth is oscillator + amp envelope + filter + filter envelope, which is close to
 * a 1:1 fit for our `VoiceConfig` — that near-isomorphism is why the Phase-1 harness
 * could already drive it with our parameter names. `FilterType` and `FilterRolloff` are
 * exact matches for Tone's `BiquadFilterType` and rolloff union, so both pass straight
 * through.
 *
 * Still not read (later stages, each with its own gate): oscillator `count` / `spread` /
 * `width`, `velocity.*`, and `lfos`.
 */
export function monoSynthOptions(patch: SynthPreset): MonoSynthOptions {
  const { oscillator, envelope, filter, filterEnvelope } = patch.voice;
  return {
    oscillator: { type: basicWaveShape(oscillator.type) },
    envelope: {
      attack: envelope.attack,
      decay: envelope.decay,
      sustain: envelope.sustain,
      release: envelope.release,
    },
    filter: {
      type: filter.type,
      Q: filter.Q,
      rolloff: filter.rolloff,
    },
    filterEnvelope: {
      attack: filterEnvelope.attack,
      decay: filterEnvelope.decay,
      sustain: filterEnvelope.sustain,
      release: filterEnvelope.release,
      // The cutoff. See UNMAPPED_PARAMS above for why this one and not filter.frequency.
      baseFrequency: filterEnvelope.baseFrequency,
      octaves: filterEnvelope.octaves,
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
