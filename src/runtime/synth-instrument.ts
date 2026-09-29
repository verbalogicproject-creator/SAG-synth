/**
 * src/runtime/synth-instrument.ts — one playable synth: its voices, its LFOs, its routes.
 *
 * Moved out of `ToneRuntime` at cycle 2 C4, verbatim apart from the seam itself. Before
 * this, "the synth" and "the runtime" were one class: voices, modulation, the effects
 * chain, the transport and the kick all shared one set of fields. C5 gives every channel
 * its own instrument, and that is only possible once an instrument is a thing you can make
 * two of. Nothing about how a voice sounds changed here — every audio gate in the suite,
 * byte-for-byte assertions included, is the proof.
 *
 * What moved: the voice pool (built lazily, one per voice id), the LFO generators, the
 * route scalers, the per-voice monotonic clock, note on / off / steal, and the voice half of
 * `applyPatch` (oscillators, filter, both envelopes, portamento, pan, LFOs, routes).
 *
 * What stayed in `ToneRuntime`: the effects chain and master stage, the transport and its
 * pump, the kicks and the duck, telemetry, and deciding WHICH sections changed
 * (`PATCH_SECTIONS`) — the instrument is told what to write and writes it.
 *
 * Layer rule: `src/runtime/` — the only place `tone` is imported.
 */

import * as Tone from 'tone';
import { CENTS_PER_OCTAVE, FULL_DEPTH_DUCK_DB, FULL_DEPTH_OCTAVES, isPerVoiceSource, lfoSlotOf } from '../core/types';
import type {
  ModDestination,
  ModRoute,
  ModSource,
  OscillatorConfig,
  OscillatorIndex,
  SignedUnit,
  SynthPreset,
} from '../core/types';
import { PARAM_SPECS } from '../core/schemas';
import { effectiveFilterEnvelope, silentAfter } from '../core/ahdsr';
import type { VoiceId } from '../core/state';
import type { RuntimeNoteOff, RuntimeNoteOn } from '../core/runtime-contract';
import { AhdsrAmplitudeEnvelope, AhdsrFrequencyEnvelope, toneEnvelopeOptions } from './ahdsr-envelope';
import { MIN_EVENT_GAP_SECONDS, distortionCurve, immediate, writeParam, type WriteMode } from './tone-shared';
import type { PatchSection } from './tone-runtime';

/**
 * The level a voice's oscillators reach at the filter's input, which is where per-voice
 * DRIVE (`voice.filter.drive`, schema_version 7) bites. Not the 0.2 the master chain's
 * distortion is levelled at: before the amp envelope one saw slot peaks near 0.7 (full
 * scale, less the slot panner's 3 dB centre loss). Levelled here, the drive knob changes
 * character more than loudness on the signal it actually sees.
 */
export const VOICE_DRIVE_REFERENCE_PEAK = 0.7;

/** Nodes every voice owns before its slots — see `nodeCount`. */
const VOICE_FIXED_NODES = 11;

/**
 * The filter envelope's curve exponent, and it is not ours to choose freely.
 *
 * `FrequencyEnvelope` computes `baseFrequency * 2^(octaves * value^exponent)`. Its OWN
 * default is 1; `MonoSynth.getDefaults()` overrides it to 2, and every patch this project
 * has ever stored was voiced through that override. Rebuilding the voice by hand
 * inherited the 1 — which sounds like a detail and is not: on the factory patch it moved
 * the settled cutoff from 1.7 kHz to 2.8 kHz and multiplied the energy above 9 kHz by
 * roughly forty. Two distortion gates caught it; no human ear was consulted.
 *
 * Pinned rather than exposed, because F65 at schema_version 3 requires a v2 patch and its
 * migrated form to SOUND the same. Making it a parameter would be a new tone control, and
 * a new tone control whose default silently rewrites every saved patch is not a feature.
 */
const FILTER_ENVELOPE_EXPONENT = 2;

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
  'voice.amplitude',
  'voice.pan',
] as const satisfies readonly ModDestination[];

/**
 * The per-slot destinations that resolve to a real audio-rate parameter.
 *
 * `width` and `spread` are declared and deliberately absent. `spread` is a plain number
 * on `FatOscillator` — changing it rebuilds the internal oscillators, so there is no
 * param to connect to at all. `width` is a `Signal`, but only when the slot's type is
 * `pulse`; a destination that resolves on some patches and not others would be worse
 * than one that honestly reports itself unimplemented on all of them.
 */
const PER_SLOT_DESTINATION_KEYS = ['detune', 'level', 'pan'] as const;

type SlotDestinationKey = (typeof PER_SLOT_DESTINATION_KEYS)[number];

type WirableDestination =
  | (typeof PER_VOICE_DESTINATIONS)[number]
  | `voice.oscillators.${OscillatorIndex}.${SlotDestinationKey}`;

/** `voice.oscillators.<i>.<key>` split into its parts, or null if it is not one. */
function slotAddress(destination: string): { index: number; key: SlotDestinationKey } | null {
  const match = /^voice\.oscillators\.(\d+)\.(\w+)$/.exec(destination);
  if (match === null) return null;
  const key = match[2] as SlotDestinationKey;
  if (!(PER_SLOT_DESTINATION_KEYS as readonly string[]).includes(key)) return null;
  return { index: Number(match[1]), key };
}

function isWirable(destination: ModDestination): destination is WirableDestination {
  return (
    (PER_VOICE_DESTINATIONS as readonly string[]).includes(destination) ||
    slotAddress(destination) !== null
  );
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
 *
 * **The sign needs no code of its own, and that is worth stating rather than leaving to be
 * rediscovered.** A negative depth makes `scale` negative, `rewireRoutes` puts it in a
 * `Tone.Gain`, and a gain node with a negative value inverts its input — which is exactly
 * F82. It works only because the scaling lives on the CONNECTION rather than on the
 * generator; inverting a shared `Tone.LFO` would invert every route reading it. The one
 * thing checked rather than assumed is that Tone permits it: `Param.minValue` special-cases
 * `normalRange`, `positive`, `audioRange` and others to a floor, and `Gain` defaults to
 * `units: "gain"`, which is in none of those lists and falls through to the native
 * `GainNode.gain.minValue` — the full negative float range (`Tone/core/context/Param.ts`).
 * `duckDb` inverts too, and there it changes meaning rather than phase: the trough lands
 * ABOVE the base and the duck becomes a boost, declared in KIND §3.3 and reported by
 * `modulationLoad` rather than repaired here.
 */
function routeSwing(destination: ModDestination, depth: SignedUnit, base: number): RouteSwing {
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

/** Whether an LFO runs locked to the transport: a subdivision rate, or `sync` on. */
export function lfoLocked(config: { frequency: number | string; sync: boolean }): boolean {
  return config.sync || typeof config.frequency === 'string';
}

/**
 * What a generator has to be REBUILT for. Free-running Hz rates share one key, so a rate
 * knob glides on the same node; a locked LFO keys on its rate too, because a tempo-synced
 * rate cannot be re-set in place.
 */
function lfoBuildKey(config: { frequency: number | string; sync: boolean; type: string }): string {
  if (!lfoLocked(config)) return 'free';
  // Hz included too: once tempo-synced, the rate signal is driven by the bpm and a write to
  // it is overridden, so a locked Hz rate that changes has to be rebuilt as well.
  // And the shape: a locked sawtooth is built with its own phase (`lfoPhase`).
  return `locked:${String(config.frequency)}:${config.type}`;
}

/**
 * Where a generator starts its cycle, in degrees. Web Audio's sawtooth (and Tone's) is
 * `x/π` over (−π, π): it starts at 0 and RESETS HALFWAY through the cycle. Free-running
 * that is invisible; locked to the transport it puts the ramp's jump half a step after the
 * beat, so a 1/16 saw "pluck" on the filter lands between the notes. 180° starts the ramp
 * at its bottom on the step, and the reset falls on the next one. The other shapes already
 * begin their cycle on the step.
 */
export function lfoPhase(config: { frequency: number | string; sync: boolean; type: string }): number {
  return lfoLocked(config) && config.type === 'sawtooth' ? 180 : 0;
}

/**
 * The node a per-voice source is read from on one voice. Velocity is its scalar held in a
 * signal; the envelopes are the 0..1 contour each AHDSR runs (`contour` on the subclasses —
 * the signal Tone schedules, before the amp's gain or the filter's exponent and scale).
 */
function voiceSource(nodes: VoiceNodes, source: ModSource): Tone.ToneAudioNode {
  switch (source) {
    case 'env.amp':
      return nodes.amp.contour;
    case 'env.filter':
      return nodes.filterEnvelope.contour;
    default:
      return nodes.velocity;
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
/**
 * One oscillator slot inside one voice.
 *
 * `level` before `panner` so a slot's contribution is scaled before it is placed —
 * panning a silent slot is free, and the routing destinations `…N.level` and `…N.pan`
 * then point at two independent nodes rather than fighting over one gain.
 */
interface SlotNodes {
  osc: Tone.OmniOscillator<Tone.Oscillator>;
  level: Tone.Gain;
  panner: Tone.Panner;
}

/**
 * The voice, hand-built, since schema_version 3.
 *
 * It was a `Tone.MonoSynth` and could not stay one: MonoSynth is *one* oscillator by
 * construction, so a second slot had nowhere to go. What replaced it is not a different
 * design — it is MonoSynth's own topology with the oscillator stage widened, read out of
 * `Tone/instrument/MonoSynth.ts` rather than guessed at:
 *
 *   slots(osc -> level -> pan) -> filter -> ampEnvelope -> gain -> panner -> fxInput
 *   filterEnvelope ------------------------> filter.frequency
 *
 * The parts are all Tone's — `OmniOscillator`, `Filter`, `AmplitudeEnvelope`,
 * `FrequencyEnvelope` — assembled here instead of inside a class that assumed one source.
 */
interface VoiceNodes {
  /** As many as the patch declares, never more. A one-slot patch costs one oscillator. */
  slots: SlotNodes[];
  /**
   * Per-voice DRIVE before the filter (schema_version 7). The slots sum into `driveIn`,
   * which feeds two legs into the filter: `driveDry` (unity) and `driveShaper → driveWet`.
   * Drive 0 is dry 1 / wet 0 — an exact bypass, so a migrated patch renders sample-identical.
   * Above 0 the legs swap and the shaper's makeup rides the wet gain. The shaper always
   * exists, so moving the knob never rebuilds the graph under a sounding note.
   */
  driveIn: Tone.Gain;
  driveDry: Tone.Gain;
  driveShaper: Tone.WaveShaper;
  driveWet: Tone.Gain;
  filter: Tone.Filter;
  filterEnvelope: AhdsrFrequencyEnvelope;
  amp: AhdsrAmplitudeEnvelope;
  /**
   * The note's pitch, fanned out to every slot.
   *
   * One signal rather than one write per oscillator, because portamento is a ramp on a
   * single value: three slots ramping independently could drift apart mid-glide, and
   * `Signal.connect` overrides the target's own value, so the slots follow rather than sum.
   */
  frequency: Tone.Signal<'frequency'>;
  /** Glide time, held per voice because `setNote` needs it and it is patch-level. */
  portamento: number;
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

export interface SynthInstrumentOptions {
  /** Where every voice goes: the head of the effects chain. */
  output: Tone.InputNode;
  /** Something asked for that this instrument cannot do — see `ToneRuntime.getUnimplemented`. */
  report: (gap: string) => void;
}

export class SynthInstrument {
  /** Keyed by the voiceId CORE assigned. Built lazily — polyphony can be up to 32. */
  private readonly voices = new Map<VoiceId, VoiceNodes>();

  /**
   * One `Tone.LFO` per filled LFO slot — NOT one per voice.
   *
   * This is the shared-phase construction, and it is a deliberate, measured departure
   * from what KIND-synth_patch describes. See `SHARED_LFO_PHASE_DEPARTURE` below.
   */
  private readonly lfos = new Map<number, Tone.LFO>();
  /** What each generator was BUILT as — see `lfoBuildKey`. A change of key rebuilds it. */
  private readonly lfoKeys = new Map<number, string>();

  /**
   * The depth scalers, and the two collections mirror the two source TOPOLOGIES rather
   * than being an arbitrary split.
   *
   * An LFO is one generator with one scaler fanned out to every voice, so its scaler
   * belongs to the ROUTE and is looked up by route id. Velocity is per-voice — each voice
   * holds a different value — so it is N sources with N scalers, and those belong to the
   * VOICE.
   *
   * They used to be one flat list, on the reasoning that nothing ever looked one up.
   * Something does now: a voice built after the graph was wired has to JOIN it, and
   * joining means finding the route's existing scaler and connecting one more target to
   * it. The flat list forced the alternative — tear the whole graph down and rebuild it —
   * which meant every note of a chord disconnected and reconnected the modulation of the
   * notes already sounding. See `attachVoiceToRoutes`.
   */
  private readonly lfoScalers = new Map<string, Tone.Gain>();
  private readonly voiceScalers = new Map<VoiceId, Tone.Gain[]>();

  /**
   * How many times the modulation graph has been torn down and rebuilt. A diagnostic,
   * counted because it cannot be heard: an offline render completes its clock pass before
   * the first sample, so a dispose-and-rebuild leaves no mark in the buffer.
   */
  private rewireCount = 0;

  /** Last time scheduled on each voice; see MIN_EVENT_GAP_SECONDS. */
  private readonly lastEventTime = new Map<VoiceId, number>();

  /** The patch voices are built from. Set on every `apply`, even one that writes nothing. */
  private patch: SynthPreset | null = null;

  private readonly output: Tone.InputNode;
  private readonly report: (gap: string) => void;

  constructor(options: SynthInstrumentOptions) {
    this.output = options.output;
    this.report = options.report;
  }

  /**
   * Write the voice sections `ToneRuntime.applyPatch` found dirty, across every live voice.
   * The runtime decides WHAT changed (`PATCH_SECTIONS`); this writes it. See the notes on
   * `ToneRuntime.applyPatch` for why skipping clean sections is safe for voices built later.
   */
  apply(patch: SynthPreset, wrote: ReadonlySet<PatchSection>, mode: WriteMode): void {
    // Before the early return: `voiceFor` reads this to build new voices, so it has to be
    // the newest document even on a call that writes nothing.
    this.patch = patch;
    if (wrote.size === 0) return;
    if (wrote.has('oscillators')) {
      for (const [index, slot] of patch.voice.oscillators.entries()) {
        for (const gap of unsupportedOscillatorFeatures(slot, index)) this.report(gap);
      }
    }

    // Built once per write and shared by every voice: `distortionCurve` allocates a
    // Float32Array, and a knob drag with eight voices would otherwise allocate eight.
    const driveCurve = wrote.has('filter')
      ? distortionCurve(patch.voice.filter.drive, VOICE_DRIVE_REFERENCE_PEAK)
      : null;

    for (const nodes of this.voices.values()) {
      if (wrote.has('oscillators')) this.syncSlots(nodes, patch, mode);
      if (wrote.has('filter')) {
        // `type` and `rolloff` reconstruct biquads and cannot be ramped; `Q` can.
        nodes.filter.type = patch.voice.filter.type;
        writeParam(nodes.filter.Q, patch.voice.filter.Q, mode);
        nodes.filter.rolloff = patch.voice.filter.rolloff;
        this.writeDrive(nodes, patch.voice.filter.drive, driveCurve, mode);
      }
      if (wrote.has('filterEnvelope')) {
        nodes.filterEnvelope.set(frequencyEnvelopeOptions(patch));
        nodes.filterEnvelope.setAhdsr(effectiveFilterEnvelope(patch.voice));
        // The cutoff itself, in cents, on the one node in the voice that can ramp it.
        writeParam(
          nodes.filter.detune,
          baseFrequencyCents(patch.voice.filterEnvelope.baseFrequency),
          mode,
        );
      }
      if (wrote.has('envelope')) nodes.amp.setAhdsr(patch.voice.envelope);
      if (wrote.has('portamento')) nodes.portamento = patch.voice.portamento;
      if (wrote.has('pan')) writeParam(nodes.panner.pan, patch.voice.pan, mode);
      // `nodes.gain.gain` is deliberately absent. `voice.amplitude` reaches it through
      // `rewireRoutes` and nowhere else — see the note there.
    }

    if (wrote.has('lfos')) this.syncLfos(patch, mode);
    if (wrote.has('routes')) this.rewireRoutes(patch, mode);
  }

  /**
   * How many times the modulation graph has been torn down and rebuilt.
   *
   * Playing a chord must not move this. See `attachVoiceToRoutes`, and
   * `patch-diff.audio.test.ts` for the gate — an offline render cannot hear a rebuild, so
   * this is the only way to assert one did not happen.
   */
  getRewireCount(): number {
    return this.rewireCount;
  }

  // -- the sequencer's half: a voice at a time in the future ---------------------------

  /** Attack `request.voiceId` at `at`, strictly after anything already scheduled on it. */
  startAt(request: RuntimeNoteOn, at: number): void {
    this.startVoice(request, this.scheduledEventTime(request.voiceId, at));
  }

  /** Release a voice at `at` if it was ever built — a never-built voice has nothing to stop. */
  releaseAt(voiceId: VoiceId, at: number): void {
    const nodes = this.voices.get(voiceId);
    if (nodes !== undefined) this.release(nodes, this.scheduledEventTime(voiceId, at));
  }

  /** Release a voice now (stop, pause, seek), if it was ever built. */
  releaseNow(voiceId: VoiceId): void {
    const nodes = this.voices.get(voiceId);
    if (nodes !== undefined) this.release(nodes, this.nextEventTime(voiceId));
  }

  /** Build a voice ahead of need — see `ToneRuntime.prebuildSequencedVoices`. */
  prebuild(voiceId: VoiceId): void {
    this.voiceFor(voiceId);
  }

  /** `nextEventTime`, for a time in the future: strictly monotonic per voice. */
  private scheduledEventTime(voiceId: VoiceId, at: number): number {
    const previous = this.lastEventTime.get(voiceId);
    const time = previous === undefined ? at : Math.max(at, previous + MIN_EVENT_GAP_SECONDS);
    this.lastEventTime.set(voiceId, time);
    return time;
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
  private syncLfos(patch: SynthPreset, mode: WriteMode): void {
    const configs = patch.voice.lfos;

    for (const [index, lfo] of this.lfos) {
      if (index >= configs.length) {
        lfo.dispose();
        this.lfos.delete(index);
        this.lfoKeys.delete(index);
      }
    }

    configs.forEach((config, index) => {
      // Locked to the sequencer (cycle 2, C3): a subdivision rate ("16n") is a note length
      // and means something only against the transport, and `sync` asks for exactly that
      // lock. Both are `Tone.LFO.sync()` — the rate follows the tempo and the phase starts
      // with the bar (Tone restarts a synced source at every loop start). The price, and
      // it is the honest one: a locked LFO moves only while the transport plays, and sits
      // at its resting value when it stops.
      const locked = lfoLocked(config);
      const key = lfoBuildKey(config);

      let lfo = this.lfos.get(index);
      if (lfo !== undefined && this.lfoKeys.get(index) !== key) {
        // Locking, unlocking or changing the subdivision REBUILDS the generator: Tone's
        // tempo sync replaces the rate signal with a bpm-driven connection, and a synced
        // rate cannot be re-set in place. Routes rewire after this (`lfos` is an input of
        // the `routes` section), so the new generator is connected in the same pass.
        lfo.dispose();
        lfo = undefined;
        this.lfos.delete(index);
      }
      if (lfo === undefined) {
        lfo = new Tone.LFO({
          frequency: config.frequency,
          type: config.type,
          min: -1,
          max: 1,
          phase: lfoPhase(config),
        });
        if (locked) {
          lfo.sync().start(0);
          // A Tone trap, measured: `Transport.syncSignal` connects `bpm × ratio` into the
          // rate at once but zeroes the rate's own value with `signal.value = 0`, which lands
          // at `now()` — the audio clock PLUS the lookahead. For that window the two sum and
          // the LFO runs at double rate: 0.2 s online, so a MOD RATE switched on mid-play
          // started 1.6 cycles off the grid. Zeroed here at the audio clock instead.
          lfo.frequency.setValueAtTime(0, immediate());
        } else {
          lfo.start();
        }
        this.lfos.set(index, lfo);
        this.lfoKeys.set(index, key);
      } else {
        // A rate glide rather than a jump. `frequency` units ramp exponentially, which is
        // the right shape for a rate — halving reads as one step wherever you start. Only
        // reached for a free-running Hz rate: every locked change rebuilt above.
        if (typeof config.frequency === 'number') writeParam(lfo.frequency, config.frequency, mode);
        lfo.type = config.type;
      }

      // Shared phase means one generator for every voice, so a per-note phase reset would
      // restart the modulation for every sounding note at once — audibly wrong on a held
      // chord. Reported rather than approximated.
      if (config.retrigger) this.report('lfo.retrigger');
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
   *
   * Wholesale *when it runs*, that is, and it now runs in only one situation: the routing
   * itself changed. See the `routes` entry in `SECTION_INPUTS` for what wakes it and why
   * `voice.amplitude` is on that list.
   *
   * It used to also run on every new voice, which meant a chord's second note disposed and
   * reconnected the modulation of the note already sounding — the exact thing the effects
   * chain is fixed-shape to avoid, happening on every note. `voiceFor` now calls
   * `attachVoiceToRoutes` instead, which adds the new voice without touching anything
   * already connected.
   *
   * **This is the only writer of `nodes.gain.gain`.** There used to be a second, a plain
   * `nodes.gain.gain.value = patch.voice.amplitude` in `applyPatch`, and it was already
   * dead: this method ran last on every call and overwrote it in the same pass. Once the
   * call became conditional, keeping it would have been actively wrong — the amplitude
   * knob would have written the raw value while a duck route's `baseOverride` was the
   * value the graph needed, so a tremolo would jump to the wrong resting level, silently
   * and only with a route active. One writer, so the question cannot arise.
   */
  private rewireRoutes(patch: SynthPreset, mode: WriteMode): void {
    this.rewireCount += 1;
    for (const lfo of this.lfos.values()) lfo.disconnect();
    for (const scaler of this.lfoScalers.values()) scaler.dispose();
    this.lfoScalers.clear();
    for (const scalers of this.voiceScalers.values()) {
      for (const scaler of scalers) scaler.dispose();
    }
    this.voiceScalers.clear();

    // Amplitude ducking re-centres the resting gain, so any voice whose route was just
    // removed or re-depthed has to go back to the patch's own value first.
    for (const nodes of this.voices.values()) {
      writeParam(nodes.gain.gain, patch.voice.amplitude, mode);
    }

    for (const route of patch.voice.modRoutes) {
      const swing = this.swingFor(route, patch);
      if (swing === null) continue;

      // Velocity is per-voice, so it cannot share one scaler the way an LFO does — each
      // voice holds a different value and needs its own scaled connection. The two source
      // kinds therefore differ in TOPOLOGY, not just in which node they read from: an LFO
      // is one generator with one scaler fanned out; velocity is N sources with N scalers.
      const slot = lfoSlotOf(route.source);
      if (slot !== null) {
        const lfo = this.lfos.get(slot);
        if (lfo === undefined) continue;

        // The scaling lives on the CONNECTION, not on the generator.
        //
        // Setting `lfo.min`/`lfo.max` per route looked equivalent and was not: one LFO
        // driving two destinations is the whole point of routes, and the second route
        // silently overwrote the first's swing. A cutoff route sharing an LFO with a pan
        // route came out modulating the cutoff by ±0.3 Hz. The generator now emits a unit
        // signal and every connection scales it for itself.
        const scaler = new Tone.Gain(swing.scale);
        this.lfoScalers.set(route.id, scaler);
        lfo.connect(scaler);
      }

      for (const [voiceId, nodes] of this.voices) {
        this.wireVoiceToRoute(voiceId, nodes, route, swing, mode);
      }
    }
  }

  /**
   * The swing for a route, or `null` if it should not be wired at all.
   *
   * Split out because `rewireRoutes` and `attachVoiceToRoutes` must agree exactly on which
   * routes are live and how deep they swing — two copies of that decision is how a voice
   * ends up modulated differently depending on whether it existed when the patch landed.
   */
  private swingFor(route: ModRoute, patch: SynthPreset): RouteSwing | null {
    if (!route.enabled) return null;
    if (!isWirable(route.destination)) {
      this.report(`route.destination.${route.destination}`);
      return null;
    }
    return routeSwing(route.destination, route.depth, patch.voice.amplitude);
  }

  /** Connect one route to one voice, building a scaler only where velocity needs its own. */
  private wireVoiceToRoute(
    voiceId: VoiceId,
    nodes: VoiceNodes,
    route: ModRoute,
    swing: RouteSwing,
    mode: WriteMode,
  ): void {
    if (swing.baseOverride !== undefined) {
      writeParam(nodes.gain.gain, swing.baseOverride, mode);
    }
    const target = this.destinationParam(nodes, route.destination as WirableDestination);
    if (target === null) return;

    if (isPerVoiceSource(route.source)) {
      // Unipolar: velocity and the envelopes run 0..1 and only ever add, so the scaler
      // carries the full swing rather than half of it the way a bipolar LFO does.
      const scaler = new Tone.Gain(swing.scale * 2);
      const existing = this.voiceScalers.get(voiceId);
      if (existing === undefined) this.voiceScalers.set(voiceId, [scaler]);
      else existing.push(scaler);
      voiceSource(nodes, route.source).connect(scaler);
      scaler.connect(target);
      return;
    }

    // The route's scaler already exists and is already running. Fanning one more target
    // off it is the whole point of keying them by route: nothing is disposed, nothing is
    // disconnected, and no voice already sounding notices.
    this.lfoScalers.get(route.id)?.connect(target);
  }

  /**
   * Add a newly built voice to the modulation graph that is already running.
   *
   * Voices are built lazily, so one created after the routes were wired would otherwise be
   * the single unmodulated note in a chord. The old fix was to call `rewireRoutes` — which
   * worked, and cost every held note a disconnect and reconnect of its modulation on every
   * new note. The constructor comment on the effects chain states the rule this broke:
   * *"Reconnecting nodes mid-performance produces clicks."*
   *
   * This is the cheap half of that call. It touches only the new voice.
   */
  private attachVoiceToRoutes(
    voiceId: VoiceId,
    nodes: VoiceNodes,
    patch: SynthPreset,
    mode: WriteMode,
  ): void {
    for (const route of patch.voice.modRoutes) {
      const swing = this.swingFor(route, patch);
      if (swing !== null) this.wireVoiceToRoute(voiceId, nodes, route, swing, mode);
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
  private destinationParam(
    nodes: VoiceNodes,
    destination: WirableDestination,
  ): Tone.InputNode | null {
    const slot = slotAddress(destination);
    if (slot !== null) {
      // A route can point at a slot the patch has not added — the address space is fixed
      // at MAX_OSCILLATORS while the list is not. `null` rather than a throw: the caller
      // reports it and carries on, exactly as it does for an unwired destination.
      const nodesForSlot = nodes.slots[slot.index];
      if (nodesForSlot === undefined) return null;
      switch (slot.key) {
        case 'detune':
          return nodesForSlot.osc.detune;
        case 'level':
          return nodesForSlot.level.gain;
        case 'pan':
          return nodesForSlot.panner.pan;
      }
    }

    switch (destination) {
      case 'voice.filterEnvelope.baseFrequency':
        return nodes.filter.detune;
      case 'voice.filter.Q':
        return nodes.filter.Q;
      case 'voice.amplitude':
        return nodes.gain.gain;
      case 'voice.pan':
        return nodes.panner.pan;
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------

  /**
   * Build one slot's nodes and wire them into an existing voice.
   *
   * Started stopped. A slot added while a note is held joins from the NEXT note-on rather
   * than appearing mid-note — starting it here would sound a bare oscillator with no
   * envelope behind it, which is worse than a beat of silence.
   */
  private buildSlot(nodes: VoiceNodes, config: OscillatorConfig | undefined): SlotNodes {
    const osc = new Tone.OmniOscillator(
      config === undefined ? {} : oscillatorOptions(config),
    ) as Tone.OmniOscillator<Tone.Oscillator>;
    const level = new Tone.Gain(config === undefined ? 1 : slotGain(config));
    const panner = new Tone.Panner(config?.pan ?? 0);

    nodes.frequency.connect(osc.frequency);
    osc.chain(level, panner, nodes.driveIn);
    if (config !== undefined) osc.detune.value = slotDetune(config);

    return { osc, level, panner };
  }

  /**
   * Make a voice's slot nodes match the patch's slot count, building and disposing as
   * needed. Called on every `applyPatch`, so `addOscillator` reaches a live voice.
   */
  private syncSlots(nodes: VoiceNodes, patch: SynthPreset, mode: WriteMode): void {
    const wanted = patch.voice.oscillators;
    while (nodes.slots.length > wanted.length) {
      const slot = nodes.slots.pop();
      slot?.osc.dispose();
      slot?.level.dispose();
      slot?.panner.dispose();
    }
    while (nodes.slots.length < wanted.length) {
      nodes.slots.push(this.buildSlot(nodes, wanted[nodes.slots.length]));
    }
    for (const [index, config] of wanted.entries()) {
      const slot = nodes.slots[index];
      if (slot === undefined) continue;
      slot.osc.set(oscillatorOptions(config));
      writeParam(slot.osc.detune, slotDetune(config), mode);
      writeParam(slot.level.gain, slotGain(config), mode);
      writeParam(slot.panner.pan, config.pan, mode);
    }
  }

  /** Point one voice's drive stage at `drive`: the curve steps, the two legs ramp. */
  private writeDrive(
    nodes: VoiceNodes,
    drive: number,
    shaped: { curve: Float32Array; makeup: number } | null,
    mode: WriteMode,
  ): void {
    if (shaped === null) return;
    nodes.driveShaper.curve = shaped.curve;
    writeParam(nodes.driveDry.gain, drive > 0 ? 0 : 1, mode);
    writeParam(nodes.driveWet.gain, drive > 0 ? shaped.makeup : 0, mode);
  }

  private voiceFor(voiceId: VoiceId): VoiceNodes {
    const existing = this.voices.get(voiceId);
    if (existing !== undefined) return existing;

    const patch = this.patch;
    const filter = new Tone.Filter(
      patch === null
        ? undefined
        : {
            type: patch.voice.filter.type,
            Q: patch.voice.filter.Q,
            rolloff: patch.voice.filter.rolloff,
            // `detune` is deliberately NOT set here, and it was until a probe showed the
            // line could be deleted with all 121 audio gates still green. `voiceFor` is
            // only ever reached from `noteOn`, which writes the cutoff base into
            // `filter.detune` a few lines later — and its `velocityConfig !== undefined`
            // guard is false exactly when `patch` is null here, so the two can never
            // disagree. A constructor value that is always overwritten before a sample is
            // produced is a decoy, which is the one thing this file is least allowed to
            // grow. `noteOn` and `applyPatch` are the writers; see `baseFrequencyCents`.
          },
    );
    const filterEnvelope = new AhdsrFrequencyEnvelope(
      patch === null ? undefined : frequencyEnvelopeOptions(patch),
    );
    const amp = new AhdsrAmplitudeEnvelope(patch === null ? undefined : toneEnvelopeOptions(patch.voice.envelope));
    if (patch !== null) {
      // Tone's constructors take the ADSR; the hold and the decay shape are ours.
      amp.setAhdsr(patch.voice.envelope);
      filterEnvelope.setAhdsr(effectiveFilterEnvelope(patch.voice));
    }
    const frequency = new Tone.Signal({ units: 'frequency', value: 440 });
    const gain = new Tone.Gain(patch === null ? 1 : patch.voice.amplitude);
    // `channelCount: 2` is load-bearing, not tuning. `Tone.Panner` defaults to
    // `channelCount: 1` with `channelCountMode: 'explicit'`, so it DOWN-MIXES its input to
    // mono before panning. That was invisible while its input was a mono MonoSynth and
    // destructive the moment slots could place themselves upstream: a slot panned hard
    // left came out of here dead centre, 3 dB quieter and otherwise identical — a declared
    // parameter that validated, journalled, replayed and did nothing.
    //
    // At two channels the node follows the spec's STEREO panning law instead, which is
    // pass-through at pan 0 and pushes the existing image left or right otherwise. That
    // also removes the makeup gain the slots used to need: the slot panner's own 3 dB
    // centre loss is now the only one in the chain, which is exactly what a single
    // MonoSynth-fed panner cost before any of this.
    const panner = new Tone.Panner({ pan: patch === null ? 0 : patch.voice.pan, channelCount: 2 });

    const drive = patch === null ? 0 : patch.voice.filter.drive;
    const driveIn = new Tone.Gain(1);
    const driveDry = new Tone.Gain(drive > 0 ? 0 : 1);
    const shaped = distortionCurve(drive, VOICE_DRIVE_REFERENCE_PEAK);
    const driveShaper = new Tone.WaveShaper(shaped.curve);
    const driveWet = new Tone.Gain(drive > 0 ? shaped.makeup : 0);
    driveIn.connect(driveDry);
    driveIn.chain(driveShaper, driveWet);
    driveDry.connect(filter);
    driveWet.connect(filter);

    filter.chain(amp, gain);
    gain.connect(panner);
    // Exactly MonoSynth's wiring, and the reason the `octaves` cutoff curve still works:
    // the envelope drives `filter.frequency` while a route drives `filter.detune`, so the
    // sweep and the modulation compose multiplicatively instead of fighting over one param.
    filterEnvelope.connect(filter.frequency);
    // Into the head of the effects chain, NOT into master. Connecting to master here
    // routes every voice past distortion, chorus, delay, reverb and the EQ, and the
    // symptom is not silence — it is a chain whose every parameter reads correctly and
    // changes nothing, which is far harder to see.
    panner.connect(this.output);

    // Built once with the voice, never per note. `Tone.Signal` owns a ConstantSourceNode
    // and starts it on construction — an AudioScheduledSourceNode throws if started
    // twice, so recreating this per note-on would fail on the second note of the session.
    const velocity = new Tone.Signal(0);

    const nodes: VoiceNodes = {
      slots: [],
      driveIn,
      driveDry,
      driveShaper,
      driveWet,
      filter,
      filterEnvelope,
      amp,
      frequency,
      portamento: patch?.voice.portamento ?? 0,
      gain,
      panner,
      velocity,
    };
    // `'step'`: every node above was constructed from this patch, so these writes land on
    // the values they already hold. Ramping would be a no-op with a `cancelAndHoldAtTime`
    // attached to it.
    if (patch !== null) this.syncSlots(nodes, patch, 'step');
    this.voices.set(voiceId, nodes);

    // Voices are built lazily, so a voice created AFTER the routes were wired would
    // otherwise be the one unmodulated note in a chord. Rewire so it joins the graph.
    if (this.patch !== null && this.patch.voice.modRoutes.length > 0) {
      // `'step'` is right here where `rewireRoutes`'s `'ramp'` was not. This now touches
      // ONLY the voice just built, whose gain still holds the plain amplitude and has
      // never sounded — so a duck route's re-centred base is a first value, not a change.
      this.attachVoiceToRoutes(voiceId, nodes, this.patch, 'step');
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
    const now = immediate();
    const previous = this.lastEventTime.get(voiceId);
    const time =
      previous === undefined ? now : Math.max(now, previous + MIN_EVENT_GAP_SECONDS);
    this.lastEventTime.set(voiceId, time);
    return time;
  }

  noteOn(request: RuntimeNoteOn): void {
    this.startVoice(request, this.nextEventTime(request.voiceId));
  }

  /**
   * One note's attack, at `time` on the audio clock. Live keys pass "now"; the transport
   * passes a moment up to a lookahead window in the future.
   *
   * Every write in here is SCHEDULED at `time`, never `.value =`. For a live key the two are
   * the same thing — Tone's `.value` setter is `cancelScheduledValues(now)` +
   * `setValueAtTime(x, now)` (`Tone/core/context/Param.ts`) — but for a sequenced note a
   * `.value =` would land a lookahead EARLY, moving the cutoff of whatever note is still
   * ringing on this voice.
   */
  private startVoice(request: RuntimeNoteOn, time: number): void {
    const nodes = this.voiceFor(request.voiceId);
    const velocityConfig = this.patch?.voice.velocity;
    nodes.portamento = request.portamento;

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

      // Harder notes open the filter. Applied to the cutoff base rather than through a
      // route, because it has to be settled before the attack begins — a modulation
      // arriving alongside the note would sweep in after the transient that carries most
      // of the brightness.
      //
      // In CENTS, on `filter.detune`, and it has to be: the base moved there (see
      // `baseFrequencyCents`) and this used to write `filterEnvelope.baseFrequency = base *
      // 2^octaves`. Left alone it applied the base a second time, multiplying instead of
      // offsetting, and put the cutoff somewhere above nyquist. Sixteen gates caught it —
      // which is the only reason the pin was not shipped looking correct.
      //
      // Adding octaves as cents is the same arithmetic in the unit the axis is already in:
      // `2^octaves` in Hz IS `octaves * 1200` in cents.
      if (this.patch !== null) {
        const octaves = request.velocity * velocityConfig.toFilterOctaves;
        const cents =
          baseFrequencyCents(this.patch.voice.filterEnvelope.baseFrequency) + octaves * CENTS_PER_OCTAVE;
        nodes.filter.detune.cancelScheduledValues(time);
        nodes.filter.detune.setValueAtTime(cents, time);
      }

      this.attack(nodes, request.note, time, scaled);
      return;
    }

    this.attack(nodes, request.note, time, request.velocity);
  }

  /**
   * The attack, assembled from `MonoSynth._triggerEnvelopeAttack` with one change: every
   * slot starts, not one.
   *
   * The zero-sustain stop is Tone's and is kept for the same reason it exists there — a
   * percussive patch whose oscillators kept running after the envelope closed would burn
   * a voice's worth of CPU producing nothing.
   */
  private attack(nodes: VoiceNodes, note: string, time: number, velocity: number): void {
    this.setNote(nodes, note, time);
    nodes.amp.triggerAttack(time, velocity);
    nodes.filterEnvelope.triggerAttack(time);
    for (const slot of nodes.slots) slot.osc.start(time);
    if (nodes.amp.sustain === 0) {
      // attack + HOLD + decay: stopping at attack + decay would cut a held note at its peak.
      const silent =
        time +
        silentAfter({
          attack: nodes.amp.toSeconds(nodes.amp.attack),
          hold: nodes.amp.hold,
          decay: nodes.amp.toSeconds(nodes.amp.decay),
        });
      for (const slot of nodes.slots) slot.osc.stop(silent);
    }
  }

  /** `MonoSynth._triggerEnvelopeRelease`, widened the same way. */
  private release(nodes: VoiceNodes, time: number): void {
    nodes.amp.triggerRelease(time);
    nodes.filterEnvelope.triggerRelease(time);
    const stopAt = time + nodes.amp.toSeconds(nodes.amp.release);
    for (const slot of nodes.slots) slot.osc.stop(stopAt);
  }

  /**
   * Set the note, gliding if the patch asks for it and a note is already sounding.
   *
   * `Monophonic.setNote`, verbatim in behaviour including the 0.05 level threshold: a
   * glide only makes sense from a note you can still hear, and ramping from a released
   * voice would bend a silence into the new note's attack.
   */
  private setNote(nodes: VoiceNodes, note: string, time: number): void {
    const target = Tone.Frequency(note).toFrequency();
    if (nodes.portamento > 0 && nodes.amp.getValueAtTime(time) > 0.05) {
      nodes.frequency.exponentialRampTo(target, nodes.portamento, time);
    } else {
      nodes.frequency.setValueAtTime(target, time);
    }
  }

  noteOff(request: RuntimeNoteOff): void {
    // A note-off for a voice that was never built is a no-op, not an error: core's
    // allocator may have stolen and reassigned the slot already.
    const nodes = this.voices.get(request.voiceId);
    if (nodes !== undefined) this.release(nodes, this.nextEventTime(request.voiceId));
  }

  /**
   * Release a voice core decided to reclaim. The dispatcher issues this immediately
   * before the `noteOn` that reuses the slot, so the release tail is cut short by the
   * new attack rather than ringing over it — which is exactly the same-instant collision
   * `nextEventTime` exists to survive.
   */
  steal(voiceId: VoiceId): void {
    const nodes = this.voices.get(voiceId);
    if (nodes !== undefined) this.release(nodes, this.nextEventTime(voiceId));
  }

  // -- readouts -----------------------------------------------------------------------

  /** Per-voice state for `observeAudio`'s `voice_detail`. */
  voiceDetail(): Array<{ id: string; frequency_hz: number; amp: number; filter_hz: number; slots: number }> {
    return [...this.voices].map(([id, nodes]) => ({
      id: String(id),
      frequency_hz: Number(nodes.frequency.value),
      amp: Number(nodes.amp.value),
      filter_hz: Number(nodes.filter.frequency.value),
      slots: nodes.slots.length,
    }));
  }

  /**
   * When the last event on `voiceId` was scheduled, in context seconds. Test affordance: it
   * is the only way to see the live-key latency fix, because offline `Tone.now()` has no
   * lookahead in it (`OfflineContext.now()` returns the simulated time bare), so no offline
   * render can tell `now()` from `currentTime`. The gate reads this on the ONLINE context.
   */
  lastScheduledTime(voiceId: VoiceId): number | undefined {
    return this.lastEventTime.get(voiceId);
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

  /**
   * How many oscillators are running. The number the three-slot bump is about.
   *
   * It tracks slots x sounding voices, so it is the one count that grows multiplicatively
   * — unlike `lfoCount`, which the shared-phase construction made flat. Worth measuring
   * rather than assuming: at declared maxima this is 3 slots x 8 voices = 24 oscillator
   * objects, each of which is up to 8 more internally when unison is on.
   */
  get oscillatorCount(): number {
    let total = 0;
    for (const nodes of this.voices.values()) total += nodes.slots.length;
    return total;
  }

  /**
   * Every Tone node this instrument owns (the runtime adds its own master stage). Used to measure the cost model, not by the app.
   *
   * Eleven fixed nodes per voice — filter, filter envelope, amp envelope, frequency,
   * gain, panner, velocity, and the four of the drive stage (schema_version 7) — plus four
   * per oscillator slot. It was `voices * 4` while a
   * voice was a MonoSynth, which counted the MonoSynth as one node and was already a
   * simplification; now the slots are the point, so they are counted.
   */
  get nodeCount(): number {
    return (
      this.lfos.size + this.scalerCount + this.voices.size * VOICE_FIXED_NODES + this.oscillatorCount * 4
    );
  }

  /** Every live depth scaler, across both topologies. See `lfoScalers`/`voiceScalers`. */
  private get scalerCount(): number {
    let total = this.lfoScalers.size;
    for (const scalers of this.voiceScalers.values()) total += scalers.length;
    return total;
  }

  dispose(): void {
    for (const scaler of this.lfoScalers.values()) scaler.dispose();
    this.lfoScalers.clear();
    for (const scalers of this.voiceScalers.values()) {
      for (const scaler of scalers) scaler.dispose();
    }
    this.voiceScalers.clear();
    for (const lfo of this.lfos.values()) lfo.dispose();
    this.lfos.clear();
    this.lfoKeys.clear();
    for (const nodes of this.voices.values()) {
      for (const slot of nodes.slots) {
        slot.osc.dispose();
        slot.level.dispose();
        slot.panner.dispose();
      }
      nodes.filter.dispose();
      nodes.filterEnvelope.dispose();
      nodes.amp.dispose();
      nodes.frequency.dispose();
      nodes.gain.dispose();
      nodes.panner.dispose();
      nodes.velocity.dispose();
      nodes.driveIn.dispose();
      nodes.driveDry.dispose();
      nodes.driveShaper.dispose();
      nodes.driveWet.dispose();
    }
    this.voices.clear();
    this.lastEventTime.clear();
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

/**
 * `MonoSynthOptions` used to live here, and the lesson it carried is worth keeping now
 * that the type is gone: MonoSynth's constructor did
 * `Object.assign(options.oscillator, { detune: options.detune })`, so a detune passed
 * inside the oscillator options was silently overwritten by the top-level default of 0.
 * Nesting it looked right, typechecked, and left the pitch exactly where it started.
 *
 * The hand-built voice has no such trap because it writes `osc.detune.value` directly —
 * but the general shape of that bug is why this file's header says to read Tone's source
 * rather than infer its behaviour from its types.
 */

/**
 * What the frequency envelope's base is pinned to, in Hz — see `baseFrequencyCents`.
 *
 * 1 Hz, so that the cents offset carrying the real base is `1200·log2(hz)` with no origin
 * term to remember. It is never heard: the envelope's output is multiplied back up by
 * `filter.detune` before it reaches a biquad.
 */
const ENVELOPE_BASE_HZ = 1;

/**
 * The cutoff base as cents above `ENVELOPE_BASE_HZ`, which is where it now lives.
 *
 * **Why the base moved off the envelope.** `FrequencyEnvelope.baseFrequency` is a
 * JavaScript setter, not a parameter. It writes `Scale.min` and `Scale.max`, and `Scale`
 * is `Multiply(max−min) → Add(min)` — two signal values, stepped. There is nothing to
 * schedule an automation curve on, so the cutoff was the one control in the instrument
 * that could not be ramped even in principle. `filter.frequency` was no help either: the
 * envelope is connected into it, so Tone marks it `overridden` and every write is dead.
 *
 * **The algebra.** A `BiquadFilterNode` computes its own cutoff as
 * `frequency × 2^(detune/1200)`. Pin the envelope's base at 1 Hz and it sweeps
 * `1 → 2^octaves`; put `1200·log2(base)` cents on `detune` and the biquad multiplies them
 * back into `base → base·2^octaves`. Identical output, and now the base is on a `Signal`
 * that ramps.
 *
 * Two things fall out that are better than the thing being fixed:
 *
 * - **Cents are the right unit.** A linear ramp in cents is an exponential glide in Hz,
 *   which is how a cutoff sweep is supposed to move and what a linear Hz ramp never was.
 * - **The base and its modulation now share one parameter.** `filter.detune` was already
 *   the destination a `voice.filterEnvelope.baseFrequency` route wires to, because the
 *   `octaves` curve delivers its swing in cents. An `AudioParam` sums its intrinsic value
 *   with every connected signal, so base-plus-wobble composes for free rather than
 *   needing an offset node.
 *
 * **What this does NOT fix, stated so it is not claimed later.** `octaves` still steps —
 * it writes `Scale.max` and there is no parameter behind it either. And none of this was
 * ever a click: a stepped cutoff changes a biquad's coefficients, not its output, and the
 * state variables carry over. See the note in `param-change.audio.test.ts`.
 */
export function baseFrequencyCents(hz: number): number {
  return CENTS_PER_OCTAVE * Math.log2(Math.max(hz, ENVELOPE_BASE_HZ) / ENVELOPE_BASE_HZ);
}

/**
 * The filter envelope's options, which is the only part of the voice whose translation is
 * not a straight field copy.
 *
 * `baseFrequency` is deliberately NOT `patch.voice.filterEnvelope.baseFrequency`. The
 * envelope is pinned at `ENVELOPE_BASE_HZ` and the patch's cutoff rides on
 * `filter.detune` — see `baseFrequencyCents` for the algebra and the reason. The address
 * is still fully honoured; it simply arrives at a different node, which is the same move
 * `voice.filterEnvelope.baseFrequency` routes have always made.
 *
 * See UNMAPPED_PARAMS above for why any of this and not `filter.frequency`.
 */
export function frequencyEnvelopeOptions(patch: SynthPreset): {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  baseFrequency: number;
  octaves: number;
  exponent: number;
} {
  // The envelope the voice RUNS: the amp's stages when linked, the filter's own otherwise.
  const filterEnvelope = effectiveFilterEnvelope(patch.voice);
  return {
    attack: filterEnvelope.attack,
    decay: filterEnvelope.decay,
    sustain: filterEnvelope.sustain,
    release: filterEnvelope.release,
    baseFrequency: ENVELOPE_BASE_HZ,
    octaves: filterEnvelope.octaves,
    exponent: FILTER_ENVELOPE_EXPONENT,
  };
}

/**
 * A slot's total pitch offset in cents: its own detune plus its octave switch.
 *
 * Both land on one `detune` param because that is the only audio-rate pitch input an
 * oscillator has, and cents is the natural unit for both — an octave IS 1200 cents. Doing
 * it here rather than at two nodes also means a `…N.detune` route sums on top of the
 * octave rather than replacing it.
 */
export function slotDetune(slot: OscillatorConfig): number {
  return slot.detune + slot.octave * CENTS_PER_OCTAVE;
}

/**
 * A slot's gain, with `enabled` folded in.
 *
 * Disabled is level 0 rather than a disconnection, exactly as a bypassed effect is wet 0:
 * the slot keeps its stored level, muting is instant, and re-enabling restores the value
 * without the UI having to remember it. The oscillator keeps running — existence is the
 * cost, `enabled` is only the mute — which is why a one-slot patch builds one oscillator
 * per voice and a three-slot patch builds three whether or not two are muted.
 */
export function slotGain(slot: OscillatorConfig): number {
  return slot.enabled ? slot.level : 0;
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
export function oscillatorOptions(oscillator: OscillatorConfig): OscillatorOptions {
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
export function unsupportedOscillatorFeatures(
  oscillator: OscillatorConfig,
  slot: number,
): string[] {
  const { type, count, width } = oscillator;
  const gaps: string[] = [];

  if (type === 'noise') {
    // Sounds as a sawtooth. Honouring it needs a slot built around Tone.Noise, which is a
    // different source shape rather than another case in `oscillatorOptions`.
    gaps.push(`oscillator.${slot}.noise`);
  }
  if (count > 1 && (type === 'pulse' || type === 'pwm')) {
    gaps.push(`oscillator.${slot}.unison.${type}`);
  }
  if (width !== 0 && type !== 'pulse') {
    gaps.push(`oscillator.${slot}.width.${type}`);
  }
  return gaps;
}

