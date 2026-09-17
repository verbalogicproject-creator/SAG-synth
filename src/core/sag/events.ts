/**
 * src/core/sag/events.ts — the substrate contract.
 *
 * Implements KIND-synth_command_applied (declared and committed in the separate
 * sag-declarum-atlas-framework repo, tag v0.0.1, commit 0e6c144). Declare-before-emit
 * is already satisfied for all three synth KINDs — do NOT re-declare them.
 *
 * Field names here are snake_case on purpose: they ARE the KIND's required slots, and
 * `SYNTH_COMMAND_APPLIED_REQUIRED_SLOTS` below must match the KIND file slot-for-slot.
 * The patch and song DOCUMENTS use idiomatic camelCase instead, so the slot -> field
 * maps at the bottom of this file carry that translation explicitly and testably,
 * rather than leaving it as an assumption nobody ever checks.
 *
 * Substrate-honest note, corrected 2026-07-30. The earlier version of this comment said
 * "`~/kg-factory` does not exist on this host (probed 2026-07-29)", which was true of
 * `/root` and misleading in effect — it read as "there is no backend to talk to". There
 * is: kg-factory lives at `/data/data/com.termux/files/home/kg-factory`, and the route a
 * client would post to is `POST /api/sag/operation` (`backend/main.py:4129`, checked, not
 * recalled) behind an `X-Agent-Key` header. `sag-api-SOT.ngf.md` §1 records the same
 * "unreachable" claim being made and self-corrected elsewhere; this comment was a fossil
 * of it.
 *
 * What has NOT changed is what ships. This emits to a local append-only journal only.
 * `SagTransport` is the seam a backend would plug into; `NullSagTransport` is what
 * actually ships, and **no gate may depend on a live backend** — a rule that is about
 * test integrity rather than about reachability, so a reachable backend does not relax it.
 *
 * A note for whoever builds that transport. `sag-api-SOT.ngf.md` §2 mints one `scope_uri`
 * per repo — ours would be `sag://verbalogic/repo/SAG-synth` — and it is deliberately NOT
 * a slot on this event. The SOT's own bridge mapping puts it at journal level, not per
 * entry: the caller opens the journal as `JournalSchema(ns=scope_uri, ...)`. Per-event it
 * would be a constant on every row, and a constant cannot be falsified — there is no
 * F-check to write about a value that never varies. So it belongs on the `SagTransport`
 * implementation, declared once where the journal is opened, alongside the deterministic
 * `sha256(scope_uri + "\0" + kind + "\0" + event_id)` row id that makes replay idempotent.
 * Decided with Eyal 2026-07-31; the alternative was a framework tag for a decoration.
 */

import type { CommandSource, CommandStatus, SynthCommand, SynthCommandType } from '../commands';
import type { Song, SynthPreset } from '../types';

export const SYNTH_COMMAND_APPLIED_KIND = 'synth.command_applied';

/** Slot-for-slot from KIND-synth_command_applied §1. Order is the KIND's order. */
export const SYNTH_COMMAND_APPLIED_REQUIRED_SLOTS = [
  'command_id',
  'command_type',
  'payload',
  'status',
  'seq',
  'revision',
  'source',
  'ts',
] as const;

/** Slot-for-slot from KIND-synth_command_applied §2. */
export const SYNTH_COMMAND_APPLIED_OPTIONAL_SLOTS = [
  'error',
  'session_id',
  'song_id',
  'preset_id',
  'duration_us',
  'last_acked_seq',
] as const;

export interface SynthCommandAppliedEvent {
  /** Identity of the dispatched command; stable across replay. */
  command_id: string;
  /** Discriminant of the SynthCommand union. */
  command_type: SynthCommandType;
  /** The dispatched command VERBATIM (F62) — never a summary, never normalised. */
  payload: SynthCommand;
  status: CommandStatus;
  /** Monotonic, gapless within a session. Rejections consume a seq (F60). */
  seq: number;
  /** Engine revision AFTER this command; unchanged when rejected (F61). */
  revision: number;
  source: CommandSource;
  /** Epoch ms at dispatch. */
  ts: number;

  /** Present iff status is 'rejected'. */
  error?: string;
  session_id?: string;
  song_id?: string;
  preset_id?: string;
  /** Dispatch-to-applied microseconds — hot-path latency observability. */
  duration_us?: number;
  /** Transport cursor at emission; everything above it is pending flush. */
  last_acked_seq?: number;
}

export interface EventContext {
  seq: number;
  revision: number;
  sessionId?: string;
  songId?: string;
  presetId?: string;
  durationUs?: number;
  lastAckedSeq?: number;
}

/**
 * Pure event builder. Takes the envelope and the result and produces the event — no
 * clock, no uuid, no I/O, so a replay produces byte-identical events.
 */
export function buildCommandAppliedEvent(
  envelope: { id: string; ts: number; source: CommandSource; payload: SynthCommand },
  result: { status: CommandStatus; error?: string },
  context: EventContext,
): SynthCommandAppliedEvent {
  const event: SynthCommandAppliedEvent = {
    command_id: envelope.id,
    command_type: envelope.payload.type,
    payload: envelope.payload,
    status: result.status,
    seq: context.seq,
    revision: context.revision,
    source: envelope.source,
    ts: envelope.ts,
  };
  if (result.error !== undefined) event.error = result.error;
  if (context.sessionId !== undefined) event.session_id = context.sessionId;
  if (context.songId !== undefined) event.song_id = context.songId;
  if (context.presetId !== undefined) event.preset_id = context.presetId;
  if (context.durationUs !== undefined) event.duration_us = context.durationUs;
  if (context.lastAckedSeq !== undefined) event.last_acked_seq = context.lastAckedSeq;
  return event;
}

/** Structural check that an event carries every required slot with a usable value. */
export function hasRequiredSlots(event: unknown): event is SynthCommandAppliedEvent {
  if (typeof event !== 'object' || event === null) return false;
  const record = event as Record<string, unknown>;
  return SYNTH_COMMAND_APPLIED_REQUIRED_SLOTS.every(
    (slot) => record[slot] !== undefined && record[slot] !== null,
  );
}

// ---------------------------------------------------------------------------
// Journal + transport seam
// ---------------------------------------------------------------------------

/**
 * The append-only journal. It is simultaneously the SAG emission buffer, the
 * persistence log, and the v0.2 SDK wire format (decision D3) — one artifact serving
 * three masters, which is why the SDK needs no domain change later.
 */
export interface SagJournal {
  append(event: SynthCommandAppliedEvent): void;
  /** Every event at or above `fromSeq`, in seq order. */
  read(fromSeq?: number): readonly SynthCommandAppliedEvent[];
  /** Highest seq appended; -1 when empty. */
  lastSeq(): number;
  /** Highest seq a transport has acknowledged; everything above it is pending flush. */
  lastAckedSeq(): number;
  markAcked(seq: number): void;
}

// ---------------------------------------------------------------------------
// Audio observation — implements KIND-synth_audio_observed (framework tag v0.0.4)
// ---------------------------------------------------------------------------
//
// A DELIBERATELY SEPARATE STREAM from the command journal, for reasons the KIND's §5
// spells out and this comment must not let anyone forget: `synth_command_applied` is
// replay-critical — gapless by contract (F60), rejections still consuming a seq (F61),
// replay reconstructing state exactly (F59). Observations are periodic rather than caused,
// lossy-tolerant, and describe the world instead of changing it. Putting them in the same
// journal would fill the structure whose whole value is replayability with rows that
// cannot be replayed, and make a dropped sample indistinguishable from a sequence gap.

export const SYNTH_AUDIO_OBSERVED_KIND = 'synth.audio_observed';

/** Slot-for-slot from KIND-synth_audio_observed §1. Order is the KIND's order. */
export const SYNTH_AUDIO_OBSERVED_REQUIRED_SLOTS = [
  'instance_id',
  'observed_at',
  'context_state',
  'level_db',
  'peak',
  'rms',
  'voices',
] as const;

/** Slot-for-slot from KIND-synth_audio_observed §2. */
export const SYNTH_AUDIO_OBSERVED_OPTIONAL_SLOTS = [
  'session_id',
  'sample_rate',
  'unimplemented',
  'destination_muted',
  'destination_volume_db',
  'base_latency',
  'output_latency',
  'render_capacity',
  'underrun_ratio',
  'signal_hz',
  'dc_offset',
  'master_volume_db',
  'voice_detail',
  'context_time',
  'note',
] as const;

/**
 * Snake_case on purpose, like `SynthCommandAppliedEvent`: these field names ARE the KIND's
 * slots, so the two cannot drift without a contract test noticing.
 */
export interface SynthAudioObservedEvent {
  /**
   * Identity of the ENGINE INSTANCE, not the session.
   *
   * Two live ids at once is the hot-reload leak that cost five debugging rounds, visible
   * directly rather than deduced.
   */
  instance_id: string;
  /** Epoch ms, supplied by the caller — the runtime never reads a clock. */
  observed_at: number;
  /** 'running' | 'suspended' | 'closed'. The only truth about whether audio CAN sound. */
  context_state: string;
  /**
   * Master bus dBFS, or `null` when silent (F76).
   *
   * `null` rather than `-Infinity`, and the difference is not pedantic: JSON cannot carry
   * `-Infinity`, so it serialises to `null` anyway — and a consumer that reduced those
   * with `Math.max` read them as **zero** and reported full scale for a silent synth.
   * Declaring the null makes every consumer handle it instead of coercing it by accident.
   */
  level_db: number | null;
  peak: number;
  rms: number;
  /** Tone voices currently built in the pool. */
  voices: number;

  session_id?: string;
  sample_rate?: number;
  /** What the runtime was asked for and could not service, at observation time. */
  unimplemented?: readonly string[];
  /**
   * The OUTPUT stage, downstream of everything measured above (F79).
   *
   * Without these, a muted output and a dead engine are the same row — and they have
   * opposite causes: one is broken code, the other is working code nobody can hear.
   * This is as far down the chain as a page can see; Web Audio offers no way to ask
   * whether a node is still connected to the destination, and the hardware is invisible.
   */
  destination_muted?: boolean;
  destination_volume_db?: number;

  /**
   * What the audio thread is actually up against, when the browser will say.
   *
   * Added because the crackle report that started Phase C arrived as "there are cracks
   * when I play a note and change a parameter" — which was enough to find three real
   * defects and could not, by itself, distinguish any of them from the device simply
   * running out of headroom. The next such report should arrive with numbers.
   *
   * **Every one of these is optional, and the optionality is the contract.** They are
   * emitted only where the running browser offers them: `baseLatency` and `outputLatency`
   * exist on `AudioContext` and not on `OfflineAudioContext`, and `renderCapacity` is
   * Chromium-only. A key that is absent means "this browser did not say", which is a
   * different fact from zero and must never be fabricated into one — the same rule
   * `level_db`'s null already encodes (F76).
   */
  /** `AudioContext.baseLatency`, seconds — the buffer between the graph and the sink. */
  base_latency?: number;
  /** `AudioContext.outputLatency`, seconds — estimated total to the speaker. */
  output_latency?: number;
  /** Mean audio-thread load, 0..1. At 1 the thread is not keeping up. */
  render_capacity?: number;
  /**
   * Fraction of render quanta that underran since the last update, 0..1.
   *
   * The single most direct measure of a crackle there is: an underrun IS the click. It
   * rides alongside `render_capacity` because the two answer different questions — load
   * says how close to the edge, this says how often it went over.
   */
  underrun_ratio?: number;

  /**
   * What the signal IS, not just how loud it is.
   *
   * Added when the phone reported a steady -25 dB master level while nothing could be
   * heard. A level cannot distinguish an audible tone from a DC offset or a subsonic or
   * ultrasonic signal a phone speaker cannot reproduce; these can.
   *
   * `signal_hz` is half the zero-crossing rate of the analyser window -- a fundamental
   * estimate that is exact for a clean periodic wave and rough for a rich one, and
   * absent when the window has fewer than two crossings. `dc_offset` is the window mean:
   * a value near `peak` means the "level" is DC, which no speaker plays.
   */
  signal_hz?: number;
  dc_offset?: number;
  /** The master `Tone.Volume` setting, dB -- upstream of the limiter and the clip. */
  master_volume_db?: number;
  /**
   * One entry per built voice: its pitch, where its envelopes are right now, and its
   * filter cutoff. A voice that is built but closed reads `amp` 0; a stuck one does not.
   */
  voice_detail?: readonly {
    readonly id: string;
    readonly frequency_hz: number;
    readonly amp: number;
    readonly filter_hz: number;
    readonly slots: number;
  }[];

  /**
   * `AudioContext.currentTime`, seconds. Two observations give the audio clock's rate
   * against `observed_at`: at ~1.0 the render thread keeps real time, well below it the
   * thread is falling behind -- the load signal this browser does not otherwise publish
   * (`renderCapacity` is absent in Chrome and WebView on the phone this was measured on).
   */
  context_time?: number;

  /** Free-text marker for human-driven diagnosis, e.g. "after unlock tap". */
  note?: string;
}

/**
 * Where observations go. Same shape as `SagTransport` and deliberately not the same
 * interface — sharing one would invite sharing the journal too.
 *
 * F78: an implementation must never throw into the audio path, block a note, or grow
 * without bound. Telemetry that can take down the instrument it measures is worse than no
 * telemetry, so every implementation swallows its own failures.
 */
export interface SagObserver {
  observe(event: SynthAudioObservedEvent): void;
}

/** What ships outside development: records nothing, connects to nothing, costs nothing. */
export class NullSagObserver implements SagObserver {
  observe(event: SynthAudioObservedEvent): void {
    void event;
  }
}

/** Delivery seam. "Emitted" means durably appended locally, never "received by a backend". */
export interface SagTransport {
  /** Resolves with the highest seq the far end accepted. */
  send(events: readonly SynthCommandAppliedEvent[]): Promise<{ ackedSeq: number }>;
  readonly isConnected: boolean;
}

/** What v0.1.0 actually ships: acknowledges nothing, connects to nothing, loses nothing. */
export class NullSagTransport implements SagTransport {
  readonly isConnected = false;

  send(events: readonly SynthCommandAppliedEvent[]): Promise<{ ackedSeq: number }> {
    void events;
    return Promise.resolve({ ackedSeq: -1 });
  }
}

/** In-memory journal. Phase 2 wraps this with IndexedDB persistence; the shape is fixed. */
export class MemorySagJournal implements SagJournal {
  private events: SynthCommandAppliedEvent[] = [];
  private acked = -1;

  append(event: SynthCommandAppliedEvent): void {
    const expected = this.lastSeq() + 1;
    if (event.seq !== expected) {
      // F60 — a gap or a repeat means the journal is no longer replayable, and a
      // silently-wrong journal is worse than a loud failure.
      throw new Error(`journal seq gap: expected ${expected}, received ${event.seq}`);
    }
    this.events.push(event);
  }

  read(fromSeq = 0): readonly SynthCommandAppliedEvent[] {
    return this.events.filter((e) => e.seq >= fromSeq);
  }

  lastSeq(): number {
    return this.events.length === 0 ? -1 : this.events[this.events.length - 1]!.seq;
  }

  lastAckedSeq(): number {
    return this.acked;
  }

  markAcked(seq: number): void {
    if (seq > this.acked) this.acked = seq;
  }
}

// ---------------------------------------------------------------------------
// KIND slot maps — the declared-vs-implemented bridge
// ---------------------------------------------------------------------------
//
// The KIND files name slots in snake_case; the TS documents use camelCase. That
// translation is real and would otherwise live only in someone's head. Typing each map
// as `Record<string, keyof SynthPreset>` makes the compiler reject a slot pointing at a
// field that does not exist, and src/tests/contract.test.ts proves every REQUIRED slot
// from the KIND file appears here.

export const KIND_SYNTH_PATCH = 'synth_patch';

export const KIND_SYNTH_PATCH_REQUIRED_SLOTS = [
  'patch_id',
  'name',
  'schema_version',
  'voice',
  'effects',
  'created_at',
] as const;

export const KIND_SYNTH_PATCH_SLOT_MAP = {
  patch_id: 'id',
  name: 'name',
  schema_version: 'schemaVersion',
  voice: 'voice',
  effects: 'effects',
  created_at: 'createdAt',
  category: 'category',
  author: 'author',
  tags: 'tags',
  factory: 'factory',
  description: 'description',
  derived_from: 'derivedFrom',
} as const satisfies Record<string, keyof SynthPreset>;

export const KIND_SYNTH_SONG = 'synth_song';

export const KIND_SYNTH_SONG_REQUIRED_SLOTS = [
  'song_id',
  'name',
  'schema_version',
  'bpm',
  'time_signature',
  'tracks',
  'created_at',
  'updated_at',
] as const;

export const KIND_SYNTH_SONG_SLOT_MAP = {
  song_id: 'id',
  name: 'name',
  schema_version: 'schemaVersion',
  bpm: 'bpm',
  time_signature: 'timeSignature',
  tracks: 'tracks',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  swing: 'swing',
  swing_subdivision: 'swingSubdivision',
  // KIND optional slots `master_effects` and `master_volume` both land in `master`;
  // v0.1.0 has no master effects beyond the limiter, so the slot stays absent-but-legal.
  master_volume: 'master',
  loop: 'loop',
  tempo_map: 'tempoMap',
  source_midi: 'sourceMidi',
  autosave: 'autosave',
} as const satisfies Record<string, keyof Song>;
