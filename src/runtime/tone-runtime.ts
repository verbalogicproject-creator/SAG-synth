/**
 * src/runtime/tone-runtime.ts — the audio backend.
 *
 * The ONLY file in the project allowed to import `tone`. `src/core/` is barred from it
 * by the layer rule and `src/app/` by its adapter allowlist, both enforced in
 * src/tests/contract.test.ts. That is not tidiness: swapping this class for
 * `NullRuntime` is what makes the engine headless, and a headless engine is the v0.2
 * SAG-SDK seam. One stray `import 'tone'` upstream and the SDK needs a browser.
 *
 * Why a pool of hand-built voices and never `Tone.PolySynth`: PolySynth owns voice
 * allocation and hard-codes oldest-steal. Decision D1 gives that decision to
 * `core/allocate.ts` as a pure function, because the same allocation has to happen
 * identically during live play and during journal replay. This class is told which voice
 * sounds and which dies; it never chooses.
 *
 * SCOPE. This reads **every one of the 119 declared parameter addresses**: the voice
 * (the oscillator slots, both envelopes, filter, velocity, amplitude, pan), modulation
 * routing, the effects chain, the five-band EQ, and the master stage. Since SAG-DAW slice 1
 * it also plays the SONG: a `Tone.Transport` pump schedules every track's notes on the
 * audio clock (`eventsInWindow`, `seq-voices.ts`), drum tracks fire a built-in kick, and a
 * note-triggered duck dips the channel it belongs to. Since cycle 2 C5b each pitched track
 * is a CHANNEL: its own `SynthInstrument` built from its `presetSnapshot`, with its own
 * fader, pan and duck (`channel-strip.ts`). What it still simplifies — one shared effects
 * chain for every channel, until C7's inserts — it reports by name.
 *
 * The signal path, in order. The voice was a `Tone.MonoSynth` until schema_version 3 and
 * could not stay one — MonoSynth is a single oscillator by construction, so a second slot
 * had nowhere to go. What replaced it is MonoSynth's own topology with the source stage
 * widened, read out of `Tone/instrument/MonoSynth.ts` rather than guessed at; see
 * `VoiceNodes`.
 *
 *   voice(slots x N (osc -> level -> pan) -> filter -> ampEnv -> Gain -> Panner)
 *     -> [per channel] duck(Gain) -> pan(Panner) -> fader(Volume) -> fxInput
 *     -> distortion -> chorus -> delay -> reverb -> eq x5
 *     -> master(Volume) -> limiter -> safety clip -> destination
 *   kick(MembraneSynth -> Volume) per drum track ------^ (joins at master)
 *   the live patch's own instrument (a key played with no channel) -> fxInput
 *
 * **The limiter delays everything by 6 ms.** `Tone.Limiter` is a `DynamicsCompressorNode`,
 * and Chromium's carries a fixed look-ahead pre-delay: 265 samples at 44.1 kHz, measured by
 * `transport.audio.test.ts`. Live keys pay it too. Relative timing is unaffected, since
 * everything shares the stage.
 *
 * **Writes are diffed and ramped, never wholesale and never stepped.** `applyPatch` runs
 * at pointer rate, so it pushes only the sections whose documents actually changed
 * (`PATCH_SECTIONS`) and every audio-rate value arrives through `writeParam`. Both exist
 * because turning a knob under a held note used to crack.
 *
 * Two kinds of honesty about what is missing, deliberately kept separate: adapter methods
 * this version cannot service are recorded at call time by `notImplemented`, while
 * contract parameters it does not read are listed statically in `UNMAPPED_PARAMS` — now
 * empty. The debug surface shows both, so nothing that does nothing looks like it works.
 *
 * READ TONE'S SOURCE BEFORE ASSUMING ANYTHING ABOUT IT. `node_modules/tone/build/esm/**`
 * ships the compiled sources, and the TypeScript ones clone from Tonejs/Tone.js at the
 * pinned tag. This file has been wrong about Tone twice in ways that typechecked and made
 * no sound: `detune` nested under `oscillator`, where `MonoSynth.js:35` overwrites it from
 * a top-level default; and `filter.frequency` assumed to be the only cutoff input, when
 * `Filter.js:117` connects `detune` to every biquad in the cascade and gives the
 * exponential path this file's `octaves` curve now depends on. Both were minutes of
 * reading and hours of guessing.
 */

import * as Tone from 'tone';
import { defaultMasterConfig } from '../core/state';
import { EQ_BAND_FREQUENCIES } from '../core/types';
import type { Beats, EffectsConfig, KickConfig, Song, SynthPreset } from '../core/types';
import { eventsInWindow, windowStartBeats, type ScheduledEvent } from '../core/schedule';
import { emptySeqPool, seqStep, type SeqPool } from '../core/seq-voices';
import {
  emptyPumpStats,
  isNewWindow,
  recordDuplicate,
  recordWindow,
  summarise,
  type PumpStats,
} from '../core/pump-stats';
import type { SynthAudioObservedEvent } from '../core/sag/events';
import { SynthInstrument } from './synth-instrument';
import { ChannelStrip } from './channel-strip';
import { dirtySections, type PatchSection } from './patch-sections';
export { PATCH_SECTIONS, type PatchSection } from './patch-sections';
import { MIN_EVENT_GAP_SECONDS, distortionCurve, writeParam, type WriteMode } from './tone-shared';
import type { VoiceId } from '../core/state';
import type {
  Runtime,
  RuntimeNoteOn,
  RuntimeNoteOff,
  TransportControl,
} from '../core/runtime-contract';

/**
 * Q for every EQ band, matched to the spacing rather than picked.
 *
 * `BW = 2·asinh(1/2Q)/ln2` octaves. The bands sit 1.080 octaves apart, and Q 1.3 gives
 * 1.084 octaves of bandwidth — so each band covers its own share of the spectrum and
 * little of its neighbour's. Q 1.0, the previous value, gives 1.388 octaves: sensible when
 * the centres were two octaves apart, and now wide enough that boosting two adjacent
 * bands would compound in the overlap rather than shaping two regions.
 *
 * Not load-bearing for transparency either way: a peaking filter at 0 dB gain is an
 * identity filter at any Q, so a flat EQ is exactly flat whatever this is.
 */
const EQ_BAND_Q = 1.3;

/**
 * The safety clip's transfer curve: everything outside ±1 is folded onto ±1.
 *
 * This is the resolution of open question Q1, and the question turned out to be wrong
 * rather than hard. `Tone.Limiter` measuring a HIGHER peak than no limiter is textbook
 * behaviour for a feedforward compressor used as a peak-safety device — it has knee,
 * attack and release, and a transient arriving faster than the attack passes through
 * before gain reduction engages. Nothing in the Web Audio spec gives
 * `DynamicsCompressorNode` a `|x| <= 1` guarantee, and no amount of tuning creates one.
 *
 * So the limiter does the musical work and this does the guaranteeing. Three points are
 * enough for a hard clip because `WaveShaper` interpolates linearly between curve
 * entries: -1 maps to -1, 0 to 0, +1 to +1, and anything beyond the ends saturates. Pure
 * per-sample lookup — no latency, no state, nothing that costs determinism.
 */
const HARD_CLIP_CURVE = new Float32Array([-1, 0, 1]);




/**
 * Sequenced voices live in the same `voices` map as live keys, so `applyPatch`, route
 * rewiring and the LFOs reach them with no second code path — but in their own id range,
 * so the dispatcher's allocator (ids 0..polyphony) and the sequencer's never collide.
 */
const SEQ_VOICE_BASE = 1_000_000;

/**
 * The runtime voice id for a pool slot. Each channel has its own instrument (C5b), so the
 * offset only has to separate the sequencer from live keys WITHIN one channel — the track
 * no longer needs to be part of the id.
 */
function seqVoiceId(poolVoice: VoiceId): VoiceId {
  return SEQ_VOICE_BASE + poolVoice;
}

/**
 * The pump's window, in Transport ticks: a 32nd note at Tone's default 192 PPQ, which is
 * 52 ms at 145 BPM. Any size gives the same verdicts (LP1, `seq-voices.test.ts`); smaller
 * only means more callbacks.
 */
const PUMP_TICKS = 24;

/**
 * How far ahead the Transport schedules on a real device: the sequencer's buffer.
 *
 * Tone's default is 0.1 s. The Transport's tick callback runs on the main thread, so any
 * stall longer than this plays the backlog late and bunched — Eyal's "off beat sometimes".
 * Doubling it costs the sequencer nothing audible (it is a delay between scheduling and
 * sounding, not between sounding notes) and costs a live key nothing either, because
 * interactive writes no longer wait for it (`immediate`). What it does cost is stop
 * latency: a stop lands up to this far after the press. Measured, not assumed: see
 * `[sag.transport.stats]` on the device before and after.
 */
export const TRANSPORT_LOOKAHEAD = 0.2;

export interface ToneRuntimeOptions {
  /** Set the context's lookahead. The app passes `TRANSPORT_LOOKAHEAD`; tests leave it. */
  lookAhead?: number;
}

/** A synthesised kick and its fader. `MembraneSynth` is exactly the two-envelope recipe. */
interface KickVoice {
  synth: Tone.MembraneSynth;
  volume: Tone.Volume;
  tune: string;
}

/**
 * `MembraneSynth.octaves` is NOT octaves. Tone documents it as "the number of octaves the
 * pitch envelope ramps", and implements it as `maxNote = hertz * this.octaves`
 * (`Tone/instrument/MembraneSynth.ts`, `setNote`) — a frequency MULTIPLIER. Its default of
 * 10 starts the sweep 3.3 octaves up, not 10. `KickConfig.punch` means real octaves, so it
 * is converted here, once, where the lie is.
 */
function kickOptions(kick: KickConfig): NonNullable<ConstructorParameters<typeof Tone.MembraneSynth>[0]> {
  return {
    octaves: Math.pow(2, kick.punch),
    pitchDecay: kick.pitchDecay,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: kick.decay, sustain: 0, release: 0.05 },
  };
}

function buildKick(kick: KickConfig, trackVolume: number, destination: Tone.InputNode): KickVoice {
  const volume = new Tone.Volume(kick.level + trackVolume);
  // Around the synth's effects chain, not through it: a kick through the bass's
  // distortion, reverb and duck would duck itself.
  volume.connect(destination);
  const synth = new Tone.MembraneSynth(kickOptions(kick)).connect(volume);
  return { synth, volume, tune: kick.tune };
}

function applyKick(voice: KickVoice, kick: KickConfig, trackVolume: number): void {
  voice.synth.set(kickOptions(kick));
  voice.tune = kick.tune;
  writeParam(voice.volume.volume, kick.level + trackVolume, 'ramp');
}

function triggerKick(voice: KickVoice, time: number, velocity: number): void {
  voice.synth.triggerAttack(voice.tune, time, velocity);
}

function disposeKick(voice: KickVoice): void {
  voice.synth.dispose();
  voice.volume.dispose();
}

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



/**
 * The slice of the Web Audio `AudioContext` this reads for telemetry, all of it optional.
 *
 * Declared structurally rather than imported because none of it is in the TypeScript DOM
 * library this project builds against: `renderCapacity` is Chromium-only, and even
 * `outputLatency` is absent from some lib versions. Typing it here keeps the reads honest
 * — every field is `| undefined`, which is exactly what a browser that does not implement
 * them returns, and forces the guard at the call site.
 */
interface RenderCapacityLike {
  start(options?: { updateInterval?: number }): void;
  stop(): void;
  onupdate: ((event: Event) => void) | null;
  readonly averageLoad?: number;
  readonly peakLoad?: number;
  readonly underrunRatio?: number;
}

interface LatencyReportingContext {
  baseLatency?: number;
  outputLatency?: number;
  renderCapacity?: RenderCapacityLike;
}

export class ToneRuntime implements Runtime {
  private readonly master: Tone.Volume;
  private readonly analyser: Tone.Analyser;
  private readonly meter: Tone.Meter;

  /**
   * The LIVE patch's instrument — voices, LFOs, routes (C4). Every channel has one of its
   * own (`channels` below); this one plays notes that name no channel, which is what every
   * journal written before C5 and the v0.2 SDK send. See `synth-instrument.ts`.
   */
  private readonly instrument: SynthInstrument;


  private patch: SynthPreset | null = null;
  private disposed = false;

  /**
   * Which sections the last `applyPatch` actually wrote. A diagnostic, not a contract —
   * it is not on `Runtime`, because `NullRuntime` has no graph to keep up to date.
   *
   * It exists because the thing worth gating here cannot be heard. An offline render
   * completes its clock pass before the first sample, so a disposed-and-rebuilt modulation
   * graph leaves no mark in the buffer at all (`src/test-harness/offline-render.ts`, and
   * its own test asserts that blindness). Churn is proven by counting what was written.
   */
  private lastApplied: readonly PatchSection[] = [];

  /** Whether `applySong` has ever run — its own `WriteMode` gate. See `applySong`. */
  private songApplied = false;

  /**
   * The most recent audio-thread load report, or `null` if this browser does not give one.
   *
   * Push, not pull: `AudioRenderCapacity` is an event source that has to be started and
   * then emits, so the value is cached here and read by `observeAudio`. Null is the
   * honest resting state — `observeAudio` omits the keys entirely rather than reporting a
   * zero nobody measured.
   */
  private renderLoad: { averageLoad: number; underrunRatio: number } | null = null;
  private renderCapacity: RenderCapacityLike | null = null;

  /** Methods called that this stage does not implement, in call order, deduplicated. */
  private readonly unimplemented = new Set<string>();

  /**
   * The chain, built once and never rewired.
   *
   * Every effect exists whether or not the patch enables it, and a disabled one is
   * bypassed by forcing its wet to 0 rather than by disconnecting it. Reconnecting nodes
   * mid-performance produces clicks, and a graph whose shape depends on parameter values
   * is a graph whose behaviour depends on the order the parameters arrived in — which is
   * exactly what replay must not have.
   *
   * Order is `EFFECT_CHAIN_ORDER`, read from core rather than restated here.
   */
  private readonly fxInput: Tone.Gain;

  // -- transport (SAG-DAW slice 1) ------------------------------------------
  /**
   * Captured at construction like every other node, because the offline harness restores
   * the global context before its clock runs (see `offline-render.ts`): a later
   * `Tone.getTransport()` would return the ONLINE transport and schedule nothing offline.
   */
  private readonly clock: ReturnType<typeof Tone.getTransport>;
  /** The latest song. The pump reads it on every window, so edits need no invalidation. */
  private song: Song | null = null;
  private pumpId: number | null = null;
  /** Deadline bookkeeping since the last play — see `pump-stats.ts`. */
  private pumpStats: PumpStats = emptyPumpStats();
  /** The last window the pump processed — the idempotence marker (`isNewWindow`). */
  private lastPumpTime = Number.NEGATIVE_INFINITY;
  /** Per kick track, the last start time handed to its oscillator. See `triggerKickAt`. */
  private readonly lastKickTime = new Map<string, number>();
  /** One schedule-time voice pool per pitched track — LP1, see `seq-voices.ts`. */
  private seqPools = new Map<string, SeqPool>();
  private readonly kicks = new Map<string, KickVoice>();
  /**
   * One strip per pitched track (C5b): its own instrument, fader, pan and duck. The live
   * patch's instrument above is the no-channel case — what a `noteOn` with no `trackId`
   * plays, which is every journal written before C5 and the v0.2 SDK.
   */
  private readonly channels = new Map<string, ChannelStrip>();
  /**
   * Distortion is four nodes rather than `Tone.Distortion`, and the split is what makes
   * the makeup gain possible at all.
   *
   * `Tone.Distortion` crossfades dry against wet INSIDE itself, so a compensating gain
   * placed after it would scale the dry path too and "wet 0 is a true bypass" — the
   * property the whole disabled-chain-is-transparent gate rests on — would stop holding.
   * Doing the mix here keeps the makeup inside the wet branch where it belongs, and keeps
   * bypass exact: at `wet: 0` the dry gain is 1, the wet gain is 0, and the signal is the
   * input sample for sample.
   */
  private readonly distortionDry: Tone.Gain;
  private readonly distortionShaper: Tone.WaveShaper;
  private readonly distortionWet: Tone.Gain;
  private readonly distortionOut: Tone.Gain;
  private readonly chorus: Tone.Chorus;
  private readonly delay: Tone.FeedbackDelay;
  private readonly reverb: Tone.Freeverb;
  private readonly eqBands: Tone.Filter[];
  private readonly limiter: Tone.Limiter;
  private readonly safetyClip: Tone.WaveShaper;

  constructor(options: ToneRuntimeOptions = {}) {
    if (options.lookAhead !== undefined) Tone.getContext().lookAhead = options.lookAhead;
    this.fxInput = new Tone.Gain(1);
    this.instrument = new SynthInstrument({ output: this.fxInput, report: (gap) => this.notImplemented(gap) });
    this.distortionDry = new Tone.Gain(1);
    // 4x oversampling: `tanh` at drive 50 is close enough to a hard clip that the
    // harmonics it generates run past Nyquist and fold back as inharmonic fizz. Aliasing
    // is a different noise from distortion and reads as a broken effect rather than a
    // driven one. One node on the shared chain, so the cost is paid once, not per voice.
    this.distortionShaper = new Tone.WaveShaper(distortionCurve(0.2).curve);
    this.distortionShaper.oversample = '4x';
    this.distortionWet = new Tone.Gain(0);
    this.distortionOut = new Tone.Gain(1);
    // Tone.Chorus is an LFO-modulated delay and does not run until started; an unstarted
    // one passes audio through unchanged, which reads as "chorus does nothing".
    this.chorus = new Tone.Chorus({ frequency: 4, delayTime: 2.5, depth: 0.5, wet: 0 }).start();
    this.delay = new Tone.FeedbackDelay({ delayTime: 0.25, feedback: 0.3, wet: 0 });
    // Freeverb, not Tone.Reverb: Reverb generates a randomised impulse response at
    // construction, so no assertion over its output is stable across runs. Freeverb is a
    // fixed comb/allpass network and is gateable.
    this.reverb = new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0 });

    // Five peaking filters IN SERIES, which is how every graphic EQ is built. Parallel
    // bands would need gain compensation to avoid comb-filtering where their skirts
    // overlap. A peaking filter at 0 dB is an identity filter at ANY Q, so a flat EQ is
    // exactly transparent and Q only starts to matter once a band is moved.
    this.eqBands = EQ_BAND_FREQUENCIES.map(
      (frequency) => new Tone.Filter({ type: 'peaking', frequency, Q: EQ_BAND_Q, gain: 0 }),
    );

    this.clock = Tone.getTransport();
    // Always 0. Tone swings every Transport callback that is not on a downbeat — the
    // pump's own callbacks included — so leaving it on would swing each off-beat twice.
    // Swing is applied in `eventsInWindow`, where it is a runner test.
    this.clock.swing = 0;

    this.master = new Tone.Volume(defaultMasterConfig().volume);
    this.limiter = new Tone.Limiter(defaultMasterConfig().limiterThreshold);
    this.safetyClip = new Tone.WaveShaper(HARD_CLIP_CURVE);

    this.analyser = new Tone.Analyser('waveform', WAVEFORM_SIZE);
    this.meter = new Tone.Meter();

    // The distortion stage is a parallel pair rather than a link, so it is wired by hand
    // and `connectSeries` picks the chain up at its output.
    this.fxInput.connect(this.distortionDry);
    this.distortionDry.connect(this.distortionOut);
    this.fxInput.connect(this.distortionShaper);
    this.distortionShaper.connect(this.distortionWet);
    this.distortionWet.connect(this.distortionOut);

    Tone.connectSeries(
      this.distortionOut,
      this.chorus,
      this.delay,
      this.reverb,
      ...this.eqBands,
      this.master,
      this.limiter,
      this.safetyClip,
    );
    this.safetyClip.toDestination();

    // Tapped AFTER the clip, so the telemetry reports what actually leaves rather than
    // what the mixer wanted. A limiter or a clip that is doing something is precisely the
    // thing an observer needs to see.
    this.safetyClip.connect(this.analyser);
    this.safetyClip.connect(this.meter);

    this.watchRenderCapacity();
  }

  /**
   * Subscribe to the audio thread's own load report, where the browser publishes one.
   *
   * Wrapped in a try/catch and silent on failure, per F78: telemetry that can take down
   * the instrument it measures is worse than no telemetry. Anything that goes wrong here
   * leaves `renderLoad` null, and `observeAudio` then omits the keys — which reads as
   * "this browser did not say" and is the truth.
   *
   * 1000 ms because this is a background health signal, not a meter. The observer wakes
   * the main thread on every update, and a synth that spent its own headroom measuring
   * its headroom would be its own bug report.
   */
  private watchRenderCapacity(): void {
    try {
      const raw = Tone.getContext().rawContext as unknown as LatencyReportingContext;
      const capacity = raw.renderCapacity;
      if (capacity === undefined) return;
      capacity.onupdate = (event: Event) => {
        const update = event as unknown as { averageLoad?: number; underrunRatio?: number };
        if (typeof update.averageLoad !== 'number') return;
        this.renderLoad = {
          averageLoad: update.averageLoad,
          underrunRatio: typeof update.underrunRatio === 'number' ? update.underrunRatio : 0,
        };
      };
      capacity.start({ updateInterval: 1 });
      this.renderCapacity = capacity;
    } catch {
      this.renderLoad = null;
    }
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
    // Before anything else. The capacity observer holds a callback into this instance, so
    // an undisposed one keeps a whole runtime alive across a hot reload — the same
    // two-live-instances leak `instance_id` exists to make visible.
    if (this.renderCapacity !== null) {
      try {
        this.renderCapacity.onupdate = null;
        this.renderCapacity.stop();
      } catch {
        // Already stopped, or the context went away first. Never throw out of dispose.
      }
      this.renderCapacity = null;
    }
    this.renderLoad = null;

    this.instrument.dispose();
    if (this.pumpId !== null) this.clock.clear(this.pumpId);
    this.pumpId = null;
    this.clock.stop();
    for (const kick of this.kicks.values()) disposeKick(kick);
    this.kicks.clear();
    for (const channel of this.channels.values()) channel.dispose();
    this.channels.clear();
    this.analyser.dispose();
    this.meter.dispose();
    this.master.dispose();
    this.disposed = true;
  }

  // -------------------------------------------------------------------------
  // Patch
  // -------------------------------------------------------------------------

  /**
   * F64 — never partial. Every live voice is updated, or none is: a section is written
   * across the whole pool or not at all, so a malformed patch cannot leave half the pool
   * on the old sound and half on the new.
   *
   * **Only what changed.** See `PATCH_SECTIONS`. The first call has no previous patch to
   * compare against and therefore writes everything, which is also the honest answer:
   * before it there are no values to have kept.
   *
   * **Why skipping is safe for a voice that did not exist yet.** Voices are built lazily,
   * so one can appear between two calls and miss the writes in between. It is correct
   * anyway because `voiceFor` constructs every node from the CURRENT patch — filter,
   * both envelopes, portamento, gain, pan and the slots, which is the same list this
   * method writes. That agreement is load-bearing rather than incidental: let the two
   * lists drift and a knob turned before the first note would apply to nothing. Gated by
   * `patch-diff.audio.test.ts`, "a voice built after a change matches one built before".
   */
  applyPatch(patch: SynthPreset): void {
    const previous = this.patch;
    const dirty = dirtySections(previous, patch);

    // Before the early return: `voiceFor` reads this to build new voices, so it has to be
    // the newest document even on a call that writes nothing.
    this.patch = patch;
    this.lastApplied = dirty;
    if (dirty.length === 0) {
      this.instrument.apply(patch, new Set(), 'step');
      return;
    }

    const wrote = new Set<PatchSection>(dirty);
    // Nothing was ever pushed into this graph before, so there is nothing to ramp from.
    const mode: WriteMode = previous === null ? 'step' : 'ramp';

    this.instrument.apply(patch, wrote, mode);
    this.applyEffects(patch.effects, wrote, mode);
  }

  /** Which sections the last `applyPatch` wrote, in `PATCH_SECTIONS` order. */
  getLastApplied(): readonly PatchSection[] {
    return this.lastApplied;
  }

  /**
   * How many times the modulation graph has been torn down and rebuilt.
   *
   * Playing a chord must not move this. See `attachVoiceToRoutes`, and
   * `patch-diff.audio.test.ts` for the gate — an offline render cannot hear a rebuild, so
   * this is the only way to assert one did not happen.
   */
  getRewireCount(): number {
    return this.instrument.getRewireCount();
  }

  /**
   * A note plays on the channel it names, or on the live patch when it names none. The
   * voice id is core's, and it is per channel — voice 0 of two channels is two voices.
   *
   * An unknown `trackId` falls back to the live instrument rather than dropping the note:
   * core already refuses a note aimed at a track that is not a synth channel, so reaching
   * here with one means the song changed between dispatch and this call, and a silent key
   * is worse than a key that plays the live sound.
   */
  private instrumentFor(trackId: string | undefined): SynthInstrument {
    if (trackId === undefined) return this.instrument;
    return this.channels.get(trackId)?.instrument ?? this.instrument;
  }

  noteOn(request: RuntimeNoteOn): void {
    this.instrumentFor(request.trackId).noteOn(request);
  }

  noteOff(request: RuntimeNoteOff): void {
    this.instrumentFor(request.trackId).noteOff(request);
  }

  steal(voiceId: VoiceId, trackId?: string): void {
    this.instrumentFor(trackId).steal(voiceId);
  }

  /**
   * Push the effects chain's parameters. The graph never changes shape.
   *
   * `enabled` is expressed as wet 0 rather than as a disconnection. An effect that is
   * switched off still carries a `wet` value in the patch, and the two must not fight: a
   * disabled reverb with `wet: 0.3` stored has to sound like no reverb, and re-enabling it
   * has to restore 0.3 without the UI having to remember it. Multiplying gets both.
   */
  private applyEffects(
    effects: EffectsConfig,
    wrote: ReadonlySet<PatchSection>,
    mode: WriteMode,
  ): void {
    const wetOf = (enabled: boolean, value: number) => (enabled ? value : 0);

    // Split five ways rather than gated once on `patch.effects`, because two of these
    // stages BUILD something on write: `distortionCurve` allocates a 1024-point
    // `Float32Array` and hands it to a `WaveShaper`, and `Freeverb.dampening` constructs
    // eight new IIR filter nodes. At one gate for the whole chain, moving the delay's
    // feedback would still pay for both.
    if (wrote.has('distortion')) {
      // The curve itself is a step and cannot be anything else — a `WaveShaper`'s transfer
      // function is a table, not an automatable value. The mix around it ramps, which is
      // what the wet and enable controls move.
      const { curve, makeup } = distortionCurve(effects.distortion.amount);
      this.distortionShaper.curve = curve;
      const distortionWet = wetOf(effects.distortion.enabled, effects.distortion.wet);
      // Linear crossfade, and the makeup rides on the wet leg only. Equal-power would keep
      // the loudness steadier through the middle of the knob, and would also mean wet 0 is
      // not quite unity dry — the wrong trade for a stage that has to disappear when off.
      writeParam(this.distortionDry.gain, 1 - distortionWet, mode);
      writeParam(this.distortionWet.gain, distortionWet * makeup, mode);
    }

    if (wrote.has('chorus')) {
      writeParam(this.chorus.frequency, effects.chorus.frequency, mode);
      this.chorus.delayTime = effects.chorus.delayTime;
      this.chorus.depth = effects.chorus.depth;
      writeParam(this.chorus.wet, wetOf(effects.chorus.enabled, effects.chorus.wet), mode);
    }

    if (wrote.has('delay')) {
      writeParam(this.delay.delayTime, effects.delay.delayTime, mode);
      writeParam(this.delay.feedback, effects.delay.feedback, mode);
      writeParam(this.delay.wet, wetOf(effects.delay.enabled, effects.delay.wet), mode);
    }

    if (wrote.has('reverb')) {
      writeParam(this.reverb.roomSize, effects.reverb.roomSize, mode);
      this.reverb.dampening = effects.reverb.dampening;
      writeParam(this.reverb.wet, wetOf(effects.reverb.enabled, effects.reverb.wet), mode);
    }

    if (wrote.has('eq')) {
      // The EQ needs no wet control: a peaking filter at 0 dB is an identity filter, so
      // "disabled" here is genuinely flat rather than an approximation of it.
      const gains = [
        effects.eq.band0.gain,
        effects.eq.band1.gain,
        effects.eq.band2.gain,
        effects.eq.band3.gain,
        effects.eq.band4.gain,
      ];
      this.eqBands.forEach((band, index) => {
        // `linear`, and it is load-bearing: `Tone.Filter.gain` is `convert: false`
        // decibels, so `rampTo` would schedule an exponential ramp over raw signed dB.
        // See `writeParam`.
        writeParam(band.gain, effects.eq.enabled ? gains[index]! : 0, mode, 'linear');
      });
    }
  }

  // -------------------------------------------------------------------------
  // Not implemented (yet) — recorded, never approximated
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
    console.warn(`ToneRuntime.${method} is not implemented yet; see getUnimplemented()`);
  }

  /** What this runtime was asked to do and could not. Empty is the expected value. */
  getUnimplemented(): readonly string[] {
    return [...this.unimplemented];
  }

  /**
   * The master stage, the tempo and loop, the kick voices and the duck — everything the
   * pump needs, pushed on every song change. Cheap by construction: the pump reads the
   * song reference each window, so a note edit costs a pointer assignment here and nothing
   * is rebuilt. What slice 1 simplifies is reported by `reportSongGaps`, not approximated.
   */
  applySong(song: Song): void {
    // Its own first-call flag rather than the patch's. The dispatcher applies a song at
    // construction, before any patch, so sharing one flag would make whichever ran second
    // ramp from a constructor default it never held.
    const mode: WriteMode = this.songApplied ? 'ramp' : 'step';
    this.songApplied = true;

    writeParam(this.master.volume, song.master.volume, mode);
    // `linear`: `Limiter.threshold` proxies `Compressor.threshold`, which Tone builds
    // `convert: false` — raw signed decibels, the same trap as the EQ bands.
    writeParam(this.limiter.threshold, song.master.limiterThreshold, mode, 'linear');

    this.song = song;
    if (this.clock.bpm.value !== song.bpm) this.clock.bpm.value = song.bpm;
    this.clock.timeSignature = song.timeSignature;
    const ppq = this.clock.PPQ;
    this.clock.loop = song.loop.enabled;
    this.clock.setLoopPoints(`${Math.round(song.loop.start * ppq)}i`, `${Math.round(song.loop.end * ppq)}i`);

    this.syncKicks(song);
    this.syncChannels(song);
    this.reportSongGaps(song);
  }

  /**
   * What a song asks for that slice 1 plays with a simplification — reported, never
   * approximated silently. Every pitched track plays the LIVE patch through one shared
   * effects chain; per-track presets and per-track mixing are the next layer
   * (HANDOFF-SAG-DAW.md §4.3), and until then `getUnimplemented()` says so.
   */
  private reportSongGaps(song: Song): void {
    if (song.tracks.some((track) => track.isDrum === true && track.kick === undefined && track.notes.length > 0)) {
      this.notImplemented('applySong.drumWithoutKick');
    }
    if (song.tempoMap !== undefined && song.tempoMap.length > 1) this.notImplemented('applySong.tempoMap');
  }

  /** One kick voice per drum track that has a `kick`, rebuilt only when its config changes. */
  private syncKicks(song: Song): void {
    const wanted = new Map<string, { kick: KickConfig; volume: number }>();
    for (const track of song.tracks) {
      if (track.kick !== undefined) wanted.set(track.id, { kick: track.kick, volume: track.volume });
    }
    for (const [trackId, voice] of this.kicks) {
      if (!wanted.has(trackId)) {
        disposeKick(voice);
        this.kicks.delete(trackId);
      }
    }
    for (const [trackId, { kick, volume }] of wanted) {
      const existing = this.kicks.get(trackId);
      if (existing === undefined) {
        this.kicks.set(trackId, buildKick(kick, volume, this.master));
        continue;
      }
      applyKick(existing, kick, volume);
    }
  }

  /**
   * One strip per pitched track: its sound, its fader and pan, its duck. Built on first
   * sight and then only updated — a strip is a whole instrument, so rebuilding one per
   * song edit would rebuild the modulation graph of a channel nobody touched.
   *
   * A removed track's strip is disposed. A drum track has no strip: its kick is a voice of
   * its own (`syncKicks`) and its `presetSnapshot` is required by F68 and ignored.
   */
  private syncChannels(song: Song): void {
    const pitched = song.tracks.filter((track) => track.isDrum !== true);
    const wanted = new Set(pitched.map((track) => track.id));
    for (const [trackId, channel] of this.channels) {
      if (wanted.has(trackId)) continue;
      channel.dispose();
      this.channels.delete(trackId);
    }
    for (const track of pitched) {
      let channel = this.channels.get(track.id);
      if (channel === undefined) {
        channel = new ChannelStrip({ output: this.fxInput, report: (gap) => this.notImplemented(gap) });
        this.channels.set(track.id, channel);
      }
      // Reference comparison, like every other diff here: an unchanged snapshot is the
      // same object, so an edit to one channel costs the others a pointer compare.
      channel.apply(track.presetSnapshot);
      channel.setMix(track.volume, track.pan);
      channel.setDuck(track.duck ?? null);
    }
  }

  readonly transport: TransportControl = {
    play: () => this.play(),
    stop: () => this.stop(),
    pause: () => this.pause(),
    seek: (position: Beats) => this.seek(position),
  };

  /**
   * How far ahead the pump is asked to look, and how often it runs. Tone's context
   * decides the first two; the pump window is ours. This is the number LP1 said nobody had
   * measured — it varies by device, so it is READ here rather than assumed, and a
   * schedule-time allocator makes the answer irrelevant to correctness (`seq-voices.ts`).
   */
  getTransportTiming(): {
    lookAhead: number;
    updateInterval: number;
    pumpBeats: number;
    bpm: number;
    stats: Record<string, number | null>;
  } {
    // `updateInterval` lives on `Context`, not `BaseContext`; an offline context has one too.
    const context = this.clock.context as unknown as { lookAhead: number; updateInterval?: number };
    return {
      lookAhead: context.lookAhead,
      updateInterval: context.updateInterval ?? 0,
      pumpBeats: PUMP_TICKS / this.clock.PPQ,
      bpm: this.clock.bpm.value,
      stats: summarise(this.pumpStats),
    };
  }

  private play(): void {
    // One line per play, into the console — which the Android shell records and serves at
    // `GET /__sag/diagnostics`. It is how LP1's number gets read ON THE DEVICE: the KIND
    // slot maps are frozen (arch/contract.ngf.md), and this is a fact about the platform,
    // not an observation of the signal, so it does not belong in `synth_audio_observed`.
    try {
      const raw = Tone.getContext().rawContext as unknown as LatencyReportingContext;
      console.info(
        `[sag.transport] ${JSON.stringify({
          ...this.getTransportTiming(),
          sampleRate: this.getSampleRate(),
          baseLatency: raw.baseLatency ?? null,
          outputLatency: raw.outputLatency ?? null,
        })}`,
      );
    } catch {
      // Telemetry never takes the instrument down (F78).
    }
    this.pumpStats = emptyPumpStats();
    this.lastPumpTime = Number.NEGATIVE_INFINITY;
    this.prebuildSequencedVoices();
    if (this.pumpId === null) {
      this.pumpId = this.clock.scheduleRepeat((time) => this.pump(time), `${PUMP_TICKS}i`, 0);
    }
    if (this.clock.state !== 'started') this.clock.start();
  }

  /**
   * Build every voice the sequencer could need BEFORE the first bar, on the press of play.
   *
   * Voices are otherwise built lazily — and the lazy build (a filter, two envelopes, two
   * signals, a gain, a panner and the slots, plus route wiring) used to run inside the first
   * pump callbacks, on the main thread, in exactly the window where a stall plays notes
   * late. A play press is a gesture handler; it can afford it.
   */
  private prebuildSequencedVoices(): void {
    const song = this.song;
    if (song === null) return;
    for (const track of song.tracks) {
      if (track.isDrum === true) continue;
      const channel = this.channels.get(track.id);
      if (channel === undefined) continue;
      // The CHANNEL's polyphony, not the live patch's: the pool the sequencer will
      // allocate from is sized by the sound that channel plays.
      for (let voice = 0; voice < track.presetSnapshot.voice.polyphony; voice += 1) {
        channel.instrument.prebuild(seqVoiceId(voice));
      }
    }
  }

  private pause(): void {
    this.clock.pause();
    this.releaseSequenced();
  }

  private stop(): void {
    // Tone's stop rewinds to tick 0 (`TickSource.stop` → `setTicksAtTime(0)`); pause does not.
    this.clock.stop();
    this.releaseSequenced();
  }

  private seek(position: Beats): void {
    this.clock.ticks = Math.round(position * this.clock.PPQ);
    // The audio clock still only moves forward, so `lastPumpTime` stays valid across a seek:
    // the next window is later in time even when it is earlier in the song.
    this.releaseSequenced();
  }

  /**
   * Release every sequenced voice now and forget the pools. After a stop, pause or seek the
   * next window starts somewhere the pools know nothing about, so they start empty — the
   * same way a fresh play does, which is what keeps every start deterministic.
   */
  private releaseSequenced(): void {
    for (const [trackId, pool] of this.seqPools) {
      const channel = this.channels.get(trackId);
      if (channel === undefined) continue;
      for (const voice of pool.voices) channel.releaseNow(seqVoiceId(voice.voiceId));
    }
    for (const channel of this.channels.values()) {
      if (channel.duckSource !== null) channel.resetDuck();
    }
    this.seqPools = new Map();
  }

  /**
   * One Transport callback: everything in the next `PUMP_TICKS`, scheduled on the audio
   * clock. `time` is where that window starts in AudioContext seconds, already a lookahead
   * in the future.
   */
  private pump(time: number): void {
    // Voices are built lazily, and a lazily built node reads the GLOBAL context. Transport
    // callbacks are not guaranteed to run while this runtime's context is the global one —
    // the offline harness restores the online context before its clock runs, and the first
    // sequenced note then built its voice on the wrong graph ("cannot connect to an
    // AudioNode belonging to a different audio context"). So the pump enters the context
    // this runtime was built in. `setContext` with a BaseContext is a bare assignment.
    const own = this.clock.context;
    const outer = Tone.getContext();
    if (outer === own) {
      this.pumpWindow(time);
      return;
    }
    Tone.setContext(own);
    try {
      this.pumpWindow(time);
    } finally {
      Tone.setContext(outer);
    }
  }

  private pumpWindow(time: number): void {
    const song = this.song;
    const patch = this.patch;
    if (song === null || patch === null || this.disposed) return;
    // Idempotent. Online, Tone sometimes hands the same window over twice; scheduling it
    // again attacked every bass note twice 0.1 ms apart and made the kick throw. See
    // `PumpStats.duplicateWindows` for how this was found.
    if (!isNewWindow(this.lastPumpTime, time)) {
      this.pumpStats = recordDuplicate(this.pumpStats);
      return;
    }
    this.lastPumpTime = time;
    const ppq = this.clock.PPQ;
    // Snapped to the pump grid, not read raw: raw tick reads drift, and drifting window
    // starts overlap (doubled notes) or gap (missing notes). See `windowStartBeats`.
    const from = windowStartBeats(this.clock.getTicksAtTime(time), PUMP_TICKS, ppq);
    const secondsPerBeat = 60 / this.clock.bpm.getValueAtTime(time);
    // Keyed by the SOURCE track: a channel ducks from whichever track its own duck names,
    // so one kick can duck several channels and two kicks can duck different ones.
    const duckTimes = new Map<string, number[]>();
    const scheduled: number[] = [];

    for (const event of eventsInWindow(song, from, PUMP_TICKS / ppq)) {
      const at = time + event.offset * secondsPerBeat;
      scheduled.push(at);
      if (event.drum) {
        if (event.kind !== 'on') continue;
        // The duck follows its source's notes whether or not the source is audible — a
        // pre-fader sidechain. See `ScheduledEvent.audible`.
        const hits = duckTimes.get(event.trackId);
        if (hits === undefined) duckTimes.set(event.trackId, [at]);
        else hits.push(at);
        const kick = this.kicks.get(event.trackId);
        if (kick !== undefined && event.audible) this.triggerKickAt(event.trackId, kick, at, event.velocity);
        continue;
      }
      // Offs are always processed, even for a track muted mid-note, so nothing sticks.
      if (event.kind === 'on' && !event.audible) continue;
      this.sequence(event, at);
    }

    for (const channel of this.channels.values()) {
      const source = channel.duckSource;
      if (source === null) continue;
      channel.scheduleDuck(duckTimes.get(source) ?? []);
    }
    this.recordPump(time, scheduled, song.timeSignature, ppq);
  }

  /**
   * Fold this window into the deadline stats, and every 8 bars say them out loud. The
   * console is the channel the Android shell records (`GET /__sag/diagnostics`), so on the
   * phone this is how a stall that played notes late shows up as a number, not a feeling.
   */
  private recordPump(time: number, scheduled: readonly number[], beatsPerBar: number, ppq: number): void {
    this.pumpStats = recordWindow(this.pumpStats, this.clock.context.currentTime, time, scheduled);
    const windowsPer8Bars = Math.max(1, Math.round((8 * beatsPerBar * ppq) / PUMP_TICKS));
    if (this.pumpStats.windows % windowsPer8Bars !== 0) return;
    try {
      console.info(`[sag.transport.stats] ${JSON.stringify(summarise(this.pumpStats))}`);
    } catch {
      // Telemetry never takes the instrument down (F78).
    }
  }

  private sequence(event: ScheduledEvent, at: number): void {
    const channel = this.channels.get(event.trackId);
    const sound = channel?.sound;
    // A track with no strip yet (or no sound applied) has nothing to play it — silence is
    // the honest outcome, and `applySong` builds a strip for every pitched track, so this
    // is the window between a song arriving and its first apply, not a steady state.
    if (channel === undefined || sound === undefined || sound === null) return;

    const pool = this.seqPools.get(event.trackId) ?? emptySeqPool();
    // The CHANNEL's voice config: polyphony and steal policy are properties of the sound
    // this track plays, not of whatever the live patch happens to be.
    const { pool: next, action } = seqStep(pool, event, sound.voice);
    this.seqPools.set(event.trackId, next);
    if (action === null) return;

    const voiceId = seqVoiceId(action.voiceId);
    if (action.kind === 'off') {
      channel.instrument.releaseAt(voiceId, at);
      return;
    }
    if (action.stolen !== undefined) {
      // The pool reuses the slot it stole, so this is the same runtime voice: release first,
      // attack strictly after, exactly as the dispatcher orders `steal` before `noteOn`.
      channel.instrument.releaseAt(seqVoiceId(action.stolen), at);
    }
    channel.instrument.startAt(
      { voiceId, note: event.note, velocity: event.velocity, portamento: sound.voice.portamento },
      at,
    );
  }

  /**
   * Start a kick, never at or before its previous start.
   *
   * Tone's `Source.start` ASSERTS that a restart is strictly later than the last start
   * (`Start time must be strictly greater than previous start time`), and an assertion
   * thrown inside a pump callback aborts the rest of that window. The idempotent pump
   * removes the duplicate windows that caused it on the device; this makes the kick safe on
   * its own terms too, the same monotonic rule every synth voice already follows
   * (`scheduledEventTime`).
   */
  private triggerKickAt(trackId: string, kick: KickVoice, at: number, velocity: number): void {
    const previous = this.lastKickTime.get(trackId);
    const time = previous === undefined ? at : Math.max(at, previous + MIN_EVENT_GAP_SECONDS);
    this.lastKickTime.set(trackId, time);
    triggerKick(kick, time, velocity);
  }

  // -------------------------------------------------------------------------
  // Readouts — observation only, never a source of truth
  // -------------------------------------------------------------------------

  /**
   * One measurement of what the master bus is actually carrying — KIND-synth_audio_observed.
   *
   * Returns the KIND's slots minus the two the runtime is not allowed to invent:
   * `instance_id` and `observed_at`. Both are injected by the caller, for the same reason
   * the dispatcher injects ids and timestamps — a layer that reads its own clock cannot be
   * driven deterministically by anything above it.
   *
   * Peak and RMS are computed here rather than by the caller because the analyser window
   * is the runtime's own; handing out a Float32Array and asking the app layer to reduce it
   * would put audio-shaped data in a layer that has no business holding any.
   */
  observeAudio(): Omit<SynthAudioObservedEvent, 'instance_id' | 'observed_at'> {
    const level = this.getLevel();
    const wave = this.getWaveform();
    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < wave.length; i += 1) {
      const sample = wave[i]!;
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
      sumSquares += sample * sample;
    }

    let mean = 0;
    let crossings = 0;
    for (let i = 0; i < wave.length; i += 1) mean += wave[i]!;
    mean = wave.length === 0 ? 0 : mean / wave.length;
    for (let i = 1; i < wave.length; i += 1) {
      if ((wave[i - 1]! - mean < 0) !== (wave[i]! - mean < 0)) crossings += 1;
    }
    const sampleRate = this.getSampleRate();
    const signal: Partial<SynthAudioObservedEvent> =
      crossings >= 2 && wave.length > 0 ? { signal_hz: (crossings / 2) * (sampleRate / wave.length) } : {};

    // Omitted — the key, not an empty list — while the transport plays. Each `.value` read
    // walks that param's automation timeline, and the sequencer is what fills those
    // timelines: on the phone this ran every 500 ms on the main thread, the thread whose
    // stalls play notes late (`pump-stats.ts`). The slot is optional in the KIND, and the
    // device checks that judge voices run with the transport stopped.
    const playing = this.clock.state === 'started';
    const voiceDetail = playing
      ? undefined
      : [...this.channels.values()].reduce<ReturnType<SynthInstrument['voiceDetail']>>(
          (all, channel) => [...all, ...channel.instrument.voiceDetail()],
          this.instrument.voiceDetail(),
        );

    return {
      ...signal,
      dc_offset: mean,
      master_volume_db: this.master.volume.value,
      ...(voiceDetail === undefined ? {} : { voice_detail: voiceDetail }),
      context_time: Tone.getContext().currentTime,
      context_state: this.getContextState(),
      // `getLevel()` floors denormals and returns -Infinity for silence, which is right
      // in memory and unrepresentable in JSON — it serialises to null regardless. Mapping
      // it here makes the null deliberate and typed rather than a serialisation accident
      // that a consumer can coerce back to zero (F76).
      level_db: Number.isFinite(level) ? level : null,
      peak,
      rms: wave.length === 0 ? 0 : Math.sqrt(sumSquares / wave.length),
      voices: this.voiceCount,
      sample_rate: this.getSampleRate(),
      unimplemented: this.getUnimplemented(),
      // One stage further down than everything above, and the reason is F79: a muted
      // output and a dead engine produce the same reading at the master node, while
      // having opposite causes. This is the last thing a page can see — Web Audio cannot
      // report whether a node is still connected to the destination, and the hardware is
      // invisible from here.
      destination_muted: Tone.getDestination().mute,
      destination_volume_db: Tone.getDestination().volume.value,
      ...this.latencyReport(),
    };
  }

  /**
   * What the platform will say about its own headroom — and nothing it will not.
   *
   * Spread into the event so an unavailable reading omits its KEY rather than emitting a
   * null or a zero. That distinction is the whole value: a `render_capacity` of 0 means
   * "measured, and the audio thread is idle"; an absent `render_capacity` means "this
   * browser does not publish one". Collapsing the two would put a reassuring number in
   * front of the exact situation nobody has data for.
   *
   * An offline render is the ordinary case for the second: `OfflineAudioContext` has no
   * `baseLatency` and no `outputLatency`, because there is no sink and no clock to be
   * late against. Every audio gate in this project therefore sees these keys absent, and
   * `telemetry.audio.test.ts` asserts exactly that rather than letting it pass unnoticed.
   */
  private latencyReport(): Partial<SynthAudioObservedEvent> {
    const report: Partial<SynthAudioObservedEvent> = {};
    let raw: LatencyReportingContext;
    try {
      raw = Tone.getContext().rawContext as unknown as LatencyReportingContext;
    } catch {
      return report;
    }

    if (typeof raw.baseLatency === 'number' && Number.isFinite(raw.baseLatency)) {
      report.base_latency = raw.baseLatency;
    }
    if (typeof raw.outputLatency === 'number' && Number.isFinite(raw.outputLatency)) {
      report.output_latency = raw.outputLatency;
    }
    if (this.renderLoad !== null) {
      report.render_capacity = this.renderLoad.averageLoad;
      report.underrun_ratio = this.renderLoad.underrunRatio;
    }
    return report;
  }

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

  /**
   * Where the listener is, in beats. Read at the context's `immediate()` time — the audio
   * clock itself — not at `now()`, which Tone defines as a lookahead in the future: a
   * playhead drawn from `now()` would run ahead of the sound by exactly the lookahead.
   */
  getPlayhead(): Beats {
    return this.clock.getTicksAtTime(this.clock.context.immediate()) / this.clock.PPQ;
  }


  /** How many channel strips exist — one per pitched track. Test affordance. */
  get channelCount(): number {
    return this.channels.size;
  }

  /** A channel's strip, for the gates that assert on one channel's sound. */
  channel(trackId: string): ChannelStrip | undefined {
    return this.channels.get(trackId);
  }

  // -- test affordances, mirroring NullRuntime ------------------------------

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** How many Tone voices have actually been built, across every channel and the live
   * patch. Proves the pool stays lazy. */
  get voiceCount(): number {
    let total = this.instrument.voiceCount;
    for (const channel of this.channels.values()) total += channel.voiceCount;
    return total;
  }

  /** How many `Tone.LFO` generators exist. See `SynthInstrument.lfoCount`. */
  get lfoCount(): number {
    return this.instrument.lfoCount;
  }

  /** How many oscillators are running. See `SynthInstrument.oscillatorCount`. */
  get oscillatorCount(): number {
    return this.instrument.oscillatorCount;
  }

  /** Every Tone node: the instruments' (live plus every channel), plus master, analyser
   * and meter. */
  get nodeCount(): number {
    let total = this.instrument.nodeCount + 3;
    for (const channel of this.channels.values()) total += channel.nodeCount;
    return total;
  }

  /** See `SynthInstrument.lastScheduledTime` — the online latency gate reads it. */
  lastScheduledTime(voiceId: VoiceId): number | undefined {
    return this.instrument.lastScheduledTime(voiceId);
  }

}
