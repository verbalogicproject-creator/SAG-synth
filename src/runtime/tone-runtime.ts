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
 * SCOPE. As of Stage 3 this reads **every one of the 97 declared parameter addresses**:
 * the voice (oscillator, both envelopes, filter, velocity, amplitude, pan), modulation
 * routing, the effects chain, the five-band EQ, and the master stage. What remains
 * unimplemented is song PLAYBACK — tracks, tempo, the step grid — which needs
 * `Tone.Transport` and is v0.3.0.
 *
 * The signal path, in order:
 *
 *   voice(MonoSynth -> Gain -> Panner) -> fxInput
 *     -> distortion -> chorus -> delay -> reverb -> eq x5
 *     -> master(Volume) -> limiter -> safety clip -> destination
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
import {
  CENTS_PER_OCTAVE,
  EQ_BAND_FREQUENCIES,
  FULL_DEPTH_DUCK_DB,
  FULL_DEPTH_OCTAVES,
} from '../core/types';
import type {
  Beats,
  EffectsConfig,
  FilterRolloff,
  FilterType,
  ModDestination,
  OscillatorConfig,
  Song,
  SynthPreset,
  Unit,
} from '../core/types';
import { PARAM_SPECS } from '../core/schemas';
import type { SynthAudioObservedEvent } from '../core/sag/events';
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
 * Drive at `amount: 1.0` — how far into the saturating part of the curve the signal is
 * pushed. The knee of `tanh(d·x)` sits at `|x| ≈ 1/d`, so this is really "the level above
 * which everything clips", read backwards.
 *
 * 12 was measured, not chosen. On the factory patch through the dispatcher, the crest
 * factor at the sustain runs 2.95 clean → 2.79 · 2.48 · 1.89 · 1.46 · 1.31 across
 * amount 0.1 → 1.0: a smooth, monotonic march from untouched to nearly square, using the
 * whole knob. At 50 the same sweep reached crest 1.37 by amount 0.2 and then had nowhere
 * left to go — four fifths of the control doing nothing distinguishable.
 *
 * The knee of `tanh(d·x)` sits at `|x| ≈ 1/d`, so this is really "the level above which
 * everything clips", read backwards. What makes 12 right rather than 50 is that the effect
 * has to bite at the level the instrument actually plays — a voice sustains near 0.1 — and
 * not at the ±1 full scale a curve is drawn for.
 */
const DISTORTION_MAX_DRIVE = 12;

/**
 * The level the makeup gain is measured against, as a peak amplitude.
 *
 * One MonoSynth voice through the factory patch arrives at the effects chain peaking near
 * 0.2 at its sustain, which is nowhere near the ±1 a waveshaper curve is drawn for. That
 * mismatch is the whole bug this replaced: at that level, Tone's own distortion curve is a
 * 2.5x gain and almost nothing else. It measured as louder and slightly duller, which is
 * exactly what it sounded like.
 *
 * Measured too. Taking the makeup reference at 0.3 left the level rising 0.4 → 3.9 dB
 * across the knob, so "more distortion" still partly meant "louder". At 0.2 — the level
 * the note actually holds — it runs 0.1 → 0.4 dB, which is flat enough that the knob
 * changes nothing but character.
 */
const DISTORTION_REFERENCE_PEAK = 0.2;

/** Curve resolution. WaveShaper interpolates linearly between entries. */
const DISTORTION_CURVE_POINTS = 1024;

/**
 * The transfer curve for one `amount`, and the makeup gain that keeps it level.
 *
 * `tanh` rather than Tone's own curve, and the reason is not taste. `Tone.Distortion`
 * builds `(3+k)·x·20°/(π + k·|x|)` with `k = 100·amount`, whose slope through the origin is
 * `(3+k)/9` — 0.33 at amount 0, 2.6 at 0.2, 11.4 at 1.0. The knob is therefore a **volume
 * control** with a saturation character attached, and on a signal peaking at 0.3 the
 * saturation is the part you cannot hear. Measured through the dispatcher on the factory
 * patch: enabling it raised the level 2.1 dB and *lowered* the absolute energy above 2 kHz
 * by 22%. "No distortion" is the correct description of that.
 *
 * `tanh(d·x)/tanh(d)` has slope `d/tanh(d)` at the origin and saturates at ±1, so amount
 * moves the KNEE and nothing else. The remaining level change is then removed outright by
 * a makeup gain measured on the curve rather than reasoned about — see below.
 */
function distortionCurve(amount: Unit): { curve: Float32Array; makeup: number } {
  const drive = amount * DISTORTION_MAX_DRIVE;
  // Below this the curve is indistinguishable from identity and `tanh(d)` underflows.
  const shape =
    drive < 1e-6 ? (x: number): number => x : (x: number): number => Math.tanh(drive * x) / Math.tanh(drive);

  const curve = new Float32Array(DISTORTION_CURVE_POINTS);
  for (let i = 0; i < DISTORTION_CURVE_POINTS; i++) {
    curve[i] = shape((i / (DISTORTION_CURVE_POINTS - 1)) * 2 - 1);
  }

  // Makeup, measured: run one cycle of a reference sine through the curve and compare RMS
  // in against RMS out. Computing it from the curve's own slope would only hold for the
  // linear region, which is precisely the region distortion is supposed to leave.
  //
  // The effect of this is that `amount` changes CHARACTER at constant loudness. Without it
  // the knob is a volume control wearing a distortion label, which is what it was.
  let inputEnergy = 0;
  let outputEnergy = 0;
  const cycle = 512;
  for (let i = 0; i < cycle; i++) {
    const x = DISTORTION_REFERENCE_PEAK * Math.sin((2 * Math.PI * i) / cycle);
    const y = shape(x);
    inputEnergy += x * x;
    outputEnergy += y * y;
  }
  return { curve, makeup: outputEnergy > 0 ? Math.sqrt(inputEnergy / outputEnergy) : 1 };
}

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

/**
 * Which per-voice destinations this stage can actually reach, and what each resolves to.
 *
 * Not every declared destination is wireable yet, and the gap is honest rather than
 * hidden: `voice.oscillator.width` and `.spread` need the unison/pulse oscillator mapping
 * that Stage 2 has not written, and every `effects.*` / `effects.eq.*` destination needs
 * the effects chain that Stage 3 will build. A route to one of those validates, journals
 * and replays correctly, and makes no sound — so `getUnimplemented()` reports it by name
 * the first time it is asked for.
 */
const PER_VOICE_DESTINATIONS = [
  'voice.filterEnvelope.baseFrequency',
  'voice.filter.Q',
  'voice.oscillator.detune',
  'voice.amplitude',
  'voice.pan',
] as const satisfies readonly ModDestination[];

type WirableDestination = (typeof PER_VOICE_DESTINATIONS)[number];

function isWirable(destination: ModDestination): destination is WirableDestination {
  return (PER_VOICE_DESTINATIONS as readonly string[]).includes(destination);
}

/**
 * How a normalised depth becomes an actual swing at one destination.
 *
 * `scale` is what a unit LFO gets multiplied by. `baseOverride` re-centres the parameter's
 * resting value when the modulation is not symmetric about it.
 */
interface RouteSwing {
  scale: number;
  baseOverride?: number;
}

/**
 * F73: depth is normalised, and what it scales against comes from the destination's own
 * declared curve (KIND §3.3) — the only reason one `depth: 0.5` can mean the same thing
 * on a Hz destination and a cents one.
 *
 * The curve is READ here rather than decided here. It used to be decided here, by name:
 * `voice.amplitude` was special-cased and everything else was linear, which meant the
 * runtime held a musical judgement no other consumer could see. A UI drawing a depth
 * control had no way to know whether to label it `±0.4`, `±2.0 oct` or `−18 dB`.
 *
 * - `linear` — halved, because the LFO is bipolar (KIND §3.1), so peak-to-peak travel is
 *   the full `depth × range`. A unipolar source doubles it back; see `rewireRoutes`.
 *
 * - `octaves` — a ratio, not an offset, so it carries no range at all. The scale is in
 *   CENTS and the connection lands on a detune input, which is where the exponent lives:
 *   the audio node computes `frequency × 2^(detune/1200)` for us, so the swing is
 *   relative to wherever the cutoff sits *at that instant* — including while the filter
 *   envelope is still moving it. Doing the same arithmetic here would need the base
 *   value, and the base value is not a constant.
 *
 * - `duckDb` — asymmetric. `voice.amplitude` is declared 0..1 and its base is **1.0**,
 *   the very top, so a symmetric swing spends half its travel above full scale, which no
 *   output can render; and gain is perceived logarithmically, so the half that does duck
 *   is a couple of dB. The peak therefore stays at the patch's own level and the trough
 *   falls `depth × 60` dB below it, which is also what a tremolo circuit does.
 *   Re-centring the resting gain on the midpoint of that span turns a bipolar generator
 *   into a one-directional duck without needing an offset node in the graph.
 */
function routeSwing(destination: ModDestination, depth: Unit, base: number): RouteSwing {
  const spec = PARAM_SPECS[destination];
  if (spec.kind !== 'number' || spec.modulation === undefined) return { scale: 0 };

  switch (spec.modulation.curve) {
    case 'duckDb': {
      const trough = base * Math.pow(10, (-depth * FULL_DEPTH_DUCK_DB) / 20);
      return { scale: (base - trough) / 2, baseOverride: (base + trough) / 2 };
    }
    case 'octaves':
      return { scale: depth * FULL_DEPTH_OCTAVES * CENTS_PER_OCTAVE };
    case 'linear':
      return { scale: (depth * (spec.max - spec.min)) / 2 };
  }
}

/**
 * The per-voice signal chain.
 *
 * `MonoSynth -> Gain -> Panner -> master`, and the two extra nodes are not decoration:
 * `voice.amplitude` and `voice.pan` are declared modulation destinations, and a
 * destination needs an audio-rate parameter to point at. MonoSynth exposes neither — its
 * `volume` is in dB, which is the wrong curve for tremolo, and it has no panning at all.
 */
interface VoiceNodes {
  synth: Tone.MonoSynth;
  gain: Tone.Gain;
  panner: Tone.Panner;
  /**
   * This note's velocity, as a signal.
   *
   * An LFO is a running generator with an output to connect; velocity is a scalar
   * captured once at note-on. `Tone.Signal` wraps a `ConstantSourceNode`, whose output
   * equals its value at every sample, which turns the scalar into something the routing
   * graph can treat exactly like an LFO — so nothing downstream of the source needs to
   * know which kind it is.
   *
   * One per voice, and per voice is the whole point: two voices sounding at once hold
   * different velocities, so unlike an LFO this cannot be one node fanned out to the pool.
   */
  velocity: Tone.Signal<'number'>;
}

export class ToneRuntime implements Runtime {
  private readonly master: Tone.Volume;
  private readonly analyser: Tone.Analyser;
  private readonly meter: Tone.Meter;

  /** Keyed by the voiceId CORE assigned. Built lazily — polyphony can be up to 32. */
  private readonly voices = new Map<VoiceId, VoiceNodes>();

  /**
   * One `Tone.LFO` per filled LFO slot — NOT one per voice.
   *
   * This is the shared-phase construction, and it is a deliberate, measured departure
   * from what KIND-synth_patch describes. See `SHARED_LFO_PHASE_DEPARTURE` below.
   */
  private readonly lfos = new Map<number, Tone.LFO>();

  /**
   * One depth scaler per live connection. Rebuilt wholesale on every rewire, which is why
   * they are a flat list rather than keyed by route id — nothing looks one up.
   */
  private readonly scalers: Tone.Gain[] = [];

  /** Last time scheduled on each voice; see MIN_EVENT_GAP_SECONDS. */
  private readonly lastEventTime = new Map<VoiceId, number>();

  private patch: SynthPreset | null = null;
  private disposed = false;

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

  constructor() {
    this.fxInput = new Tone.Gain(1);
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
    for (const scaler of this.scalers) scaler.dispose();
    this.scalers.length = 0;
    for (const lfo of this.lfos.values()) lfo.dispose();
    this.lfos.clear();
    for (const nodes of this.voices.values()) {
      nodes.synth.dispose();
      nodes.gain.dispose();
      nodes.panner.dispose();
      nodes.velocity.dispose();
    }
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
    for (const gap of unsupportedOscillatorFeatures(patch.voice.oscillator)) {
      this.notImplemented(gap);
    }
    this.patch = patch;
    for (const nodes of this.voices.values()) {
      nodes.synth.set(options);
      nodes.gain.gain.value = patch.voice.amplitude;
      nodes.panner.pan.value = patch.voice.pan;
    }
    this.applyEffects(patch.effects);
    this.syncLfos(patch);
    this.rewireRoutes(patch);
  }

  /**
   * Push the effects chain's parameters. The graph never changes shape.
   *
   * `enabled` is expressed as wet 0 rather than as a disconnection. An effect that is
   * switched off still carries a `wet` value in the patch, and the two must not fight: a
   * disabled reverb with `wet: 0.3` stored has to sound like no reverb, and re-enabling it
   * has to restore 0.3 without the UI having to remember it. Multiplying gets both.
   */
  private applyEffects(effects: EffectsConfig): void {
    const wetOf = (enabled: boolean, value: number) => (enabled ? value : 0);

    const { curve, makeup } = distortionCurve(effects.distortion.amount);
    this.distortionShaper.curve = curve;
    const distortionWet = wetOf(effects.distortion.enabled, effects.distortion.wet);
    // Linear crossfade, and the makeup rides on the wet leg only. Equal-power would keep
    // the loudness steadier through the middle of the knob, and would also mean wet 0 is
    // not quite unity dry — the wrong trade for a stage that has to disappear when off.
    this.distortionDry.gain.value = 1 - distortionWet;
    this.distortionWet.gain.value = distortionWet * makeup;

    this.chorus.frequency.value = effects.chorus.frequency;
    this.chorus.delayTime = effects.chorus.delayTime;
    this.chorus.depth = effects.chorus.depth;
    this.chorus.wet.value = wetOf(effects.chorus.enabled, effects.chorus.wet);

    this.delay.delayTime.value = effects.delay.delayTime;
    this.delay.feedback.value = effects.delay.feedback;
    this.delay.wet.value = wetOf(effects.delay.enabled, effects.delay.wet);

    this.reverb.roomSize.value = effects.reverb.roomSize;
    this.reverb.dampening = effects.reverb.dampening;
    this.reverb.wet.value = wetOf(effects.reverb.enabled, effects.reverb.wet);

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
      band.gain.value = effects.eq.enabled ? gains[index]! : 0;
    });
  }

  // -------------------------------------------------------------------------
  // Modulation
  // -------------------------------------------------------------------------

  /**
   * Build, update and retire the LFO generators to match the patch.
   *
   * Rate and shape are set here; the min/max swing is NOT, because a generator has no
   * single swing until you know what it is driving. Two routes from one LFO to a Hz
   * destination and a cents one need different amplitudes, so the swing belongs to the
   * connection and is applied in `rewireRoutes`.
   */
  private syncLfos(patch: SynthPreset): void {
    const configs = patch.voice.lfos;

    for (const [index, lfo] of this.lfos) {
      if (index >= configs.length) {
        lfo.dispose();
        this.lfos.delete(index);
      }
    }

    configs.forEach((config, index) => {
      // A subdivision string is only meaningful against Tone.Transport, which v0.1.0
      // does not drive. Treating it as a rate here would produce a silent, wrong tempo.
      if (typeof config.frequency === 'string') this.notImplemented('lfo.syncedFrequency');
      const frequency = typeof config.frequency === 'number' ? config.frequency : 1;

      let lfo = this.lfos.get(index);
      if (lfo === undefined) {
        lfo = new Tone.LFO({ frequency, type: config.type, min: -1, max: 1 });
        lfo.start();
        this.lfos.set(index, lfo);
      } else {
        lfo.frequency.value = frequency;
        lfo.type = config.type;
      }

      // Shared phase means one generator for every voice, so a per-note phase reset would
      // restart the modulation for every sounding note at once — audibly wrong on a held
      // chord. Reported rather than approximated.
      if (config.retrigger) this.notImplemented('lfo.retrigger');
    });
  }

  /**
   * Rebuild every modulation connection from scratch.
   *
   * Wholesale rather than diffed on purpose. A route's identity is not the thing the
   * audio graph cares about — the (source, destination, depth) triple is — so working out
   * which connections survived an edit costs more than remaking them, and gets the
   * disable/re-enable case wrong in ways that leave a stale connection modulating
   * something nothing points at any more.
   */
  private rewireRoutes(patch: SynthPreset): void {
    for (const lfo of this.lfos.values()) lfo.disconnect();
    for (const scaler of this.scalers) scaler.dispose();
    this.scalers.length = 0;

    // Amplitude ducking re-centres the resting gain, so any voice whose route was just
    // removed or re-depthed has to go back to the patch's own value first.
    for (const nodes of this.voices.values()) nodes.gain.gain.value = patch.voice.amplitude;

    for (const route of patch.voice.modRoutes) {
      if (!route.enabled) continue;
      if (!isWirable(route.destination)) {
        this.notImplemented(`route.destination.${route.destination}`);
        continue;
      }

      const swing = routeSwing(route.destination, route.depth, patch.voice.amplitude);

      // Velocity is per-voice, so it cannot share one scaler the way an LFO does — each
      // voice holds a different value and needs its own scaled connection. The two source
      // kinds therefore differ in TOPOLOGY, not just in which node they read from: an LFO
      // is one generator with one scaler fanned out; velocity is N sources with N scalers.
      if (route.source === 'velocity') {
        for (const nodes of this.voices.values()) {
          if (swing.baseOverride !== undefined) nodes.gain.gain.value = swing.baseOverride;
          // Unipolar: velocity runs 0..1 and only ever adds, so the scaler carries the
          // full swing rather than half of it the way a bipolar LFO does.
          const scaler = new Tone.Gain(swing.scale * 2);
          this.scalers.push(scaler);
          nodes.velocity.connect(scaler);
          scaler.connect(this.destinationParam(nodes, route.destination));
        }
        continue;
      }

      const lfo = this.lfos.get(Number(route.source.slice('lfo.'.length)));
      if (lfo === undefined) continue;

      // The scaling lives on the CONNECTION, not on the generator.
      //
      // Setting `lfo.min`/`lfo.max` per route looked equivalent and was not: one LFO
      // driving two destinations is the whole point of routes, and the second route
      // silently overwrote the first's swing. A cutoff route sharing an LFO with a pan
      // route came out modulating the cutoff by ±0.3 Hz. The generator now emits a unit
      // signal and every connection scales it for itself.
      const scaler = new Tone.Gain(swing.scale);
      this.scalers.push(scaler);
      lfo.connect(scaler);

      for (const nodes of this.voices.values()) {
        if (swing.baseOverride !== undefined) nodes.gain.gain.value = swing.baseOverride;
        scaler.connect(this.destinationParam(nodes, route.destination));
      }
    }
  }

  /**
   * The audio-rate parameter a destination resolves to on one voice.
   *
   * Note the cutoff: the address is `voice.filterEnvelope.baseFrequency` and the signal is
   * `synth.filter.detune`, not `.frequency`. That is the `octaves` curve being realised
   * rather than a mismatch. A BiquadFilterNode computes its own cutoff as
   * `frequency × 2^(detune/1200)`, so a swing delivered in cents is exponential by
   * construction and stays exponential about whatever `frequency` currently holds —
   * including while the filter envelope is still sweeping it. The wobble therefore rides
   * the sweep multiplicatively instead of adding a fixed number of Hz to it, which is what
   * a filter LFO is supposed to do and what modulating `.frequency` could not.
   *
   * `filter.detune` fans out to every biquad stage inside the filter, so the rolloff
   * setting does not change the depth.
   */
  private destinationParam(nodes: VoiceNodes, destination: WirableDestination): Tone.InputNode {
    switch (destination) {
      case 'voice.filterEnvelope.baseFrequency':
        return nodes.synth.filter.detune;
      case 'voice.filter.Q':
        return nodes.synth.filter.Q;
      case 'voice.oscillator.detune':
        return nodes.synth.detune;
      case 'voice.amplitude':
        return nodes.gain.gain;
      case 'voice.pan':
        return nodes.panner.pan;
    }
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------

  private voiceFor(voiceId: VoiceId): VoiceNodes {
    const existing = this.voices.get(voiceId);
    if (existing !== undefined) return existing;

    const synth = new Tone.MonoSynth(
      this.patch === null ? undefined : monoSynthOptions(this.patch),
    );
    const gain = new Tone.Gain(this.patch === null ? 1 : this.patch.voice.amplitude);
    const panner = new Tone.Panner(this.patch === null ? 0 : this.patch.voice.pan);
    synth.connect(gain);
    gain.connect(panner);
    // Into the head of the effects chain, NOT into master. Connecting to master here
    // routes every voice past distortion, chorus, delay, reverb and the EQ, and the
    // symptom is not silence — it is a chain whose every parameter reads correctly and
    // changes nothing, which is far harder to see.
    panner.connect(this.fxInput);

    // Built once with the voice, never per note. `Tone.Signal` owns a ConstantSourceNode
    // and starts it on construction — an AudioScheduledSourceNode throws if started
    // twice, so recreating this per note-on would fail on the second note of the session.
    const velocity = new Tone.Signal(0);

    const nodes: VoiceNodes = { synth, gain, panner, velocity };
    this.voices.set(voiceId, nodes);

    // Voices are built lazily, so a voice created AFTER the routes were wired would
    // otherwise be the one unmodulated note in a chord. Rewire so it joins the graph.
    if (this.patch !== null && this.patch.voice.modRoutes.length > 0) {
      this.rewireRoutes(this.patch);
    }
    return nodes;
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
    const nodes = this.voiceFor(request.voiceId);
    const time = this.nextEventTime(request.voiceId);
    const velocityConfig = this.patch?.voice.velocity;
    nodes.synth.portamento = request.portamento;

    // Defensive, and honestly so: no probe could make this cancel matter.
    //
    // The documented hazard is that a stolen voice is reassigned at the instant it is
    // released, so a pending write for the outgoing note could still land after the new
    // note's. It cannot happen here, because `nextEventTime` already makes every write on
    // a voice land strictly after the previous one — the monotonic clock that exists to
    // satisfy Tone's start-time assertion turns out to order these too. Replacing this
    // pair with a bare `.value =` passes every gate in the suite.
    //
    // Kept anyway. It costs nothing, and it stops being free insurance the moment
    // anything schedules a ramp on this signal rather than a step.
    nodes.velocity.cancelScheduledValues(time);
    nodes.velocity.setValueAtTime(request.velocity, time);

    if (velocityConfig !== undefined) {
      // Velocity already reaches the amp envelope through triggerAttack; `toAmplitude`
      // decides how MUCH of it lands. At 0 every note sounds at full level, at 1 velocity
      // passes through untouched, and the interpolation between is on the velocity rather
      // than the resulting gain so that a full-velocity note is unaffected either way.
      const scaled = 1 - velocityConfig.toAmplitude * (1 - request.velocity);

      // Harder notes open the filter. Applied to the envelope's base rather than through
      // a route, because it has to be settled before the attack begins — a modulation
      // arriving alongside the note would sweep in after the transient that carries most
      // of the brightness.
      if (this.patch !== null) {
        const base = this.patch.voice.filterEnvelope.baseFrequency;
        const octaves = request.velocity * velocityConfig.toFilterOctaves;
        nodes.synth.filterEnvelope.baseFrequency = base * Math.pow(2, octaves);
      }

      nodes.synth.triggerAttack(request.note, time, scaled);
      return;
    }

    nodes.synth.triggerAttack(request.note, time, request.velocity);
  }

  noteOff(request: RuntimeNoteOff): void {
    // A note-off for a voice that was never built is a no-op, not an error: core's
    // allocator may have stolen and reassigned the slot already.
    const nodes = this.voices.get(request.voiceId);
    if (nodes !== undefined) nodes.synth.triggerRelease(this.nextEventTime(request.voiceId));
  }

  /**
   * Release a voice core decided to reclaim. The dispatcher issues this immediately
   * before the `noteOn` that reuses the slot, so the release tail is cut short by the
   * new attack rather than ringing over it — which is exactly the same-instant collision
   * `nextEventTime` exists to survive.
   */
  steal(voiceId: VoiceId): void {
    const nodes = this.voices.get(voiceId);
    if (nodes !== undefined) nodes.synth.triggerRelease(this.nextEventTime(voiceId));
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

  /**
   * PARTIAL, and the partiality is the point.
   *
   * The master volume and limiter threshold live on the song rather than the patch, so
   * this is the only path they can arrive by — and without them the output stage would
   * run on a hardcoded trim forever. Everything else a song carries (tracks, tempo, the
   * step grid, scheduled parts) needs `Tone.Transport`, which v0.1.x does not drive.
   *
   * So it applies what it can and keeps reporting the rest, rather than doing neither. A
   * caller checking `getUnimplemented()` still learns that song PLAYBACK is missing; what
   * changes is that the mixer is no longer missing with it.
   */
  applySong(song: Song): void {
    this.master.volume.value = song.master.volume;
    this.limiter.threshold.value = song.master.limiterThreshold;
    this.notImplemented('applySong.transport');
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

    return {
      context_state: this.getContextState(),
      // `getLevel()` floors denormals and returns -Infinity for silence, which is right
      // in memory and unrepresentable in JSON — it serialises to null regardless. Mapping
      // it here makes the null deliberate and typed rather than a serialisation accident
      // that a consumer can coerce back to zero (F76).
      level_db: Number.isFinite(level) ? level : null,
      peak,
      rms: wave.length === 0 ? 0 : Math.sqrt(sumSquares / wave.length),
      voices: this.voices.size,
      sample_rate: this.getSampleRate(),
      unimplemented: this.getUnimplemented(),
      // One stage further down than everything above, and the reason is F79: a muted
      // output and a dead engine produce the same reading at the master node, while
      // having opposite causes. This is the last thing a page can see — Web Audio cannot
      // report whether a node is still connected to the destination, and the hardware is
      // invisible from here.
      destination_muted: Tone.getDestination().mute,
      destination_volume_db: Tone.getDestination().volume.value,
    };
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

  /**
   * How many `Tone.LFO` generators exist. The number the shared-phase departure is about:
   * it tracks filled LFO slots and is independent of polyphony and of route count.
   */
  get lfoCount(): number {
    return this.lfos.size;
  }

  /** Every Tone node this runtime owns. Used to measure the cost model, not by the app. */
  get nodeCount(): number {
    return this.lfos.size + this.scalers.length + this.voices.size * 4 + 3;
  }
}

/**
 * Departure from KIND-synth_patch §5, recorded here rather than left implicit.
 *
 * The KIND says every voice shares an LFO *configuration* while owning an independent
 * *phase*. This runtime gives every voice a shared phase: there is one `Tone.LFO` per
 * filled slot, connected to the corresponding parameter on each voice, because one
 * generator can feed many AudioParams.
 *
 * The arithmetic is the argument. Honouring per-voice phase means one generator per
 * (slot × sounding voice), so at the declared maxima — 4 LFOs, 32 voices — the pool goes
 * from **4 generators to 128**, and every one of them is an oscillator running whether or
 * not its voice is sounding. Shared phase is flat in polyphony; per-voice is a product.
 *
 * What it costs: `retrigger` cannot be honoured. Restarting a shared generator on note-on
 * restarts it for every sounding voice, so a held chord would jump its modulation each
 * time a new note arrived — worse than not retriggering. `retrigger: true` is therefore
 * recorded by `notImplemented('lfo.retrigger')` rather than approximated.
 *
 * What it does not cost: everything else. Rate, shape, depth, destination and enable all
 * behave exactly as declared, and free-running LFOs are what analogue polysynths mostly
 * did anyway.
 *
 * Revisit if per-voice phase turns out to matter musically. The fix is per-voice
 * generators behind the same route model — no contract change, since the KIND already
 * describes the stricter behaviour this falls short of.
 */
export const SHARED_LFO_PHASE_DEPARTURE = {
  kind: 'KIND-synth_patch §5 — per-voice LFO phase',
  implemented: 'shared phase: one Tone.LFO per slot, fanned out to every voice',
  generatorsSharedPhase: 4,
  generatorsPerVoicePhase: 128,
  unhonoured: ['lfo.retrigger'],
} as const;

/**
 * Contract parameters this runtime does not read yet, and which stage lands each.
 *
 * Listed rather than silently skipped: the debug surface displays them, so a parameter
 * that does nothing says so instead of looking broken.
 *
 * This list was briefly EMPTY and that was wrong. It had only ever tracked one entry —
 * `voice.filter.frequency`, a genuine decoy that collided with
 * `voice.filterEnvelope.baseFrequency` — and when schema_version 2 deleted that parameter
 * outright, emptying the list read as "everything is mapped now". It was not. Two dozen
 * addresses were, and still are, unread; they had been recorded in a prose SCOPE note at
 * the top of this file instead, which the UI cannot display. The panel showed
 * "unmapped: none" while a quarter of the surface did nothing.
 *
 * The sharpest case was `voice.oscillator.detune`: a wired MODULATION DESTINATION whose
 * own base value never reached the graph, so routing to it moved the pitch and setting it
 * did nothing. Fixed in Stage 2c, and the cause is worth keeping — the value was being
 * passed nested under `oscillator`, where `MonoSynth`'s constructor overwrites it with the
 * top-level `detune` default of 0. It typechecked and left the pitch exactly where it was.
 */
export const UNMAPPED_PARAMS: readonly string[] = [
  // EMPTY, and this time it means it.
  //
  // It read empty once before for the wrong reason: it had only ever tracked a single
  // decoy, and deleting that parameter at schema_version 2 made an untracked two dozen
  // look like zero. Three tests now guard both directions — every entry must be a real
  // address, and nothing the runtime demonstrably reads may be listed.
  //
  // What closed the rest: Stage 2c mapped the oscillator group, Stage 2d the velocity
  // response, and Stage 3 the effects chain and master stage. All 97 declared addresses
  // now reach the audio graph.
  //
  // Two kinds of gap remain, and neither belongs in a static list because both depend on
  // the patch rather than on the build:
  //   - combinations a shape cannot honour (`count` on a pulse oscillator, `width` on
  //     anything but pulse) — reported by `unsupportedOscillatorFeatures`
  //   - modulation routes to destinations with no per-voice target yet — reported by
  //     `rewireRoutes`
  // Both surface through `getUnimplemented()`, per patch, at the moment they matter.
];

/**
 * The four shapes Tone will accept a `fat` prefix on. `pulse` and `pwm` are standalone
 * types in the grammar, not prefixable — there is no `fatpulse`.
 */
type BasicShape = 'sine' | 'triangle' | 'sawtooth' | 'square';

/**
 * A discriminated union rather than one interface with optional fields, because that is
 * what Tone's `OmniOscillator` options actually are: `count`/`spread` exist only on the
 * `fat*` variants and `width` only on `pulse`. Modelling it flatly compiles and then
 * lets a caller build `{ type: 'pulse', count: 3 }`, which is precisely the illegal
 * combination this stage exists to stop being silent about.
 */
type OscillatorOptions =
  | { type: BasicShape }
  | { type: `fat${BasicShape}`; count: number; spread: number }
  | { type: 'pulse'; width: number }
  | { type: 'pwm' };

interface MonoSynthOptions {
  /**
   * Top level, NOT nested under `oscillator`, and the distinction is not cosmetic.
   * `MonoSynth`'s constructor does
   * `Object.assign(options.oscillator, { detune: options.detune })`, so a detune passed
   * inside the oscillator options is silently overwritten by the top-level default of 0.
   * Nesting it looked right, typechecked, and left the pitch exactly where it started.
   */
  detune: number;
  oscillator: OscillatorOptions;
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
 * Still not read (later stages, each with its own gate): `velocity.*` and the effects
 * chain. `lfos` are handled separately, by `syncLfos`, because they are generators rather
 * than voice options.
 */
export function monoSynthOptions(patch: SynthPreset): MonoSynthOptions {
  const { oscillator, envelope, filter, filterEnvelope } = patch.voice;
  return {
    detune: oscillator.detune,
    oscillator: oscillatorOptions(oscillator),
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

function basicShape(shape: string): BasicShape {
  switch (shape) {
    case 'sine':
    case 'triangle':
    case 'square':
      return shape;
    default:
      return 'sawtooth';
  }
}

/**
 * Our four oscillator parameters onto Tone's type-string grammar, which is not the
 * orthogonal parameter space they look like.
 *
 * `count` and `spread` exist only on `FatOscillator`, selected by prefixing one of the
 * four basic shapes with `fat`. `pulse` and `pwm` are standalone types that cannot take
 * that prefix — there is no `fatpulse` — so unison and pulse shapes are mutually
 * exclusive families. `width` belongs to `PulseOscillator` alone: `pwm` has no width at
 * all, only a rate at which width is swept. And `noise` is not an `OmniOscillator` type
 * in any form; it is a separate class needing a differently-shaped voice.
 *
 * Every combination this cannot honour is reported by `unsupportedOscillatorFeatures`
 * rather than dropped, which is the difference between a gap and the silent
 * fall-back-to-sawtooth this replaces.
 */
function oscillatorOptions(oscillator: OscillatorConfig): OscillatorOptions {
  const { type, count, spread, width } = oscillator;

  if (type === 'pulse') return { type: 'pulse', width };
  if (type === 'pwm') return { type: 'pwm' };

  const shape = basicShape(type);
  // count 1 is "no unison", and `fat<shape>` with count 1 is a needless extra oscillator
  // producing an identical sound, so the plain type is used.
  return count > 1 ? { type: `fat${shape}` as const, count, spread } : { type: shape };
}

/**
 * Parameters a patch sets that its own oscillator type cannot honour.
 *
 * Separate from `oscillatorOptions` so that function stays a pure translation — the
 * runtime calls this and routes each entry through `notImplemented`, so the debug surface
 * names them. Replay is unaffected either way: the patch is stored verbatim and the
 * mapping is deterministic, so what gets ignored is ignored identically every time.
 */
export function unsupportedOscillatorFeatures(oscillator: OscillatorConfig): string[] {
  const { type, count, width } = oscillator;
  const gaps: string[] = [];

  if (type === 'noise') {
    // Sounds as a sawtooth. Honouring it needs a voice built around Tone.Noise instead of
    // MonoSynth, which is a different voice shape rather than another case here.
    gaps.push('oscillator.noise');
  }
  if (count > 1 && (type === 'pulse' || type === 'pwm')) {
    gaps.push(`oscillator.unison.${type}`);
  }
  if (width !== 0 && type !== 'pulse') {
    gaps.push(`oscillator.width.${type}`);
  }
  return gaps;
}
