/**
 * src/app/dispatcher.ts — the seam.
 *
 * Core ships the parts: a pure reducer, a pure allocator, a history driver, a journal,
 * and three ports. None of them talk to each other. This is the one place that wires
 * them, and therefore the one place where KIND-synth_command_applied's F-checks stop
 * being descriptions and start being enforced:
 *
 *   F60 — every dispatch consumes exactly one seq, rejections included. Enforced by
 *         `MemorySagJournal.append`, which throws on a gap rather than accepting a
 *         journal that can no longer be replayed.
 *   F61 — a command that fails validation never reaches the reducer, never touches the
 *         runtime, and emits the preceding revision.
 *   F62 — the event carries the dispatched command verbatim. See the note on validation
 *         below: this is easier to break than it looks.
 *
 * It lives in `src/app/` rather than `src/core/` because it owns I/O — a clock, an id
 * source, a runtime, durable storage. `src/tests/contract.test.ts` bars all of that from
 * core, which is what keeps `replay()` a pure function of a journal.
 *
 * Not done here, deliberately: rehydrating a dispatcher from a persisted journal after a
 * reload. `replay()` rebuilds the history, but restoring the seq and persistence cursors
 * alongside it is its own decision, and guessing at it would put a wrong cursor in the
 * durable store.
 */

import {
  assertEnvelopeConsistent,
  createEnvelope,
  isHotPathCommand,
  type CommandEnvelope,
  type CommandResult,
  type CommandSource,
  type CommandStatus,
  type SynthCommand,
} from '../core/commands';
import { allocate, applyAllocation, releaseNote } from '../core/allocate';
import { channelKind, soundFor } from '../core/channels';
import { applyToHistory, emittedRevision, initialHistory, type HistoryState } from '../core/history';
import { validateCommand } from '../core/schemas';
import {
  initialTransientState,
  type ChannelTransient,
  type EngineState,
  type TransientState,
} from '../core/state';
import type { MidiImportPort, PersistencePort } from '../core/ports';
import type { RuntimeAdapter } from '../core/runtime-contract';
import {
  MemorySagJournal,
  NullSagTransport,
  buildCommandAppliedEvent,
  type EventContext,
  type SagJournal,
  type SagTransport,
  type SynthCommandAppliedEvent,
} from '../core/sag/events';

/**
 * Everything impure the dispatcher needs, injected.
 *
 * `newId` and `now` have no defaults on purpose. A dispatcher that reached for
 * `crypto.randomUUID()` and `Date.now()` itself would produce a different journal on
 * every run, and the reducer already depends on both being stable — `savePreset` and
 * `newSong` take their new document's id straight from `meta.commandId`. Requiring the
 * caller to supply them costs two lines at the one wiring site and makes every test
 * deterministic by construction.
 */
export interface DispatcherDeps {
  runtime: RuntimeAdapter;
  /** Command id source. Must be unique per dispatch; ids become document ids. */
  newId: () => string;
  /** Epoch ms. */
  now: () => number;

  /** In-session seq authority. Throws on a gap, which is how F60 is enforced. */
  journal?: SagJournal;
  /** Delivery seam. v0.1.0 ships the null one — see the flush note below. */
  transport?: SagTransport;
  /** Durable mirror. Omit for a memory-only engine; tests mostly do. */
  persistence?: PersistencePort;
  /** Required only if `importMidi` will be dispatched; the reducer rejects it otherwise. */
  midi?: MidiImportPort;

  /** Groups a journal into one editing session; the replay unit. */
  sessionId?: string;
  /**
   * Monotonic clock in fractional milliseconds (`performance.now`). Supplied ⇒ every
   * event carries `duration_us`. Omitted ⇒ the slot is absent rather than guessed at.
   */
  monotonicNow?: () => number;
  /** Called when the async mirror fails. Errors are also retained on `flushErrors`. */
  onFlushError?: (error: unknown) => void;
}

export interface DispatchEvent {
  result: CommandResult;
  event: SynthCommandAppliedEvent;
  state: EngineState;
}

export type DispatchListener = (update: DispatchEvent) => void;

export class Dispatcher {
  private history: HistoryState = initialHistory();
  private transient: TransientState = initialTransientState();

  private readonly runtime: RuntimeAdapter;
  private readonly journal: SagJournal;
  private readonly transport: SagTransport;
  private readonly deps: DispatcherDeps;

  private readonly listeners = new Set<DispatchListener>();

  /**
   * Highest seq written to durable storage. Deliberately NOT the journal's acked
   * cursor: that one tracks the transport, and v0.1.0's transport never acknowledges
   * anything, so sharing them would re-append the entire journal on every dispatch.
   */
  private persistedSeq = -1;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly errors: unknown[] = [];

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
    this.runtime = deps.runtime;
    this.journal = deps.journal ?? new MemorySagJournal();
    this.transport = deps.transport ?? new NullSagTransport();

    /**
     * Push the initial patch immediately.
     *
     * This class's invariant is that the runtime reflects `EngineState`, and at
     * construction it does not: `syncRuntime` only fires when a reference CHANGES, so
     * without this the audio graph keeps whatever defaults its backend was built with
     * until the first patch edit. That was a real, measured bug — voices ran on Tone's
     * own MonoSynth defaults, and the very first `setParam` swapped the instrument out
     * from under the player, changing the sound for a reason no one could see.
     *
     * Not journalled, because nothing happened: no command was dispatched and no state
     * changed. It is the runtime being brought up to the state that already exists.
     *
     * The song goes with it, for the identical reason and against the identical bug. The
     * master volume and limiter threshold live on the SONG rather than the patch, so
     * without this line the output stage would run on whatever the backend defaulted to
     * until the first song edit — which for most sessions is never.
     */
    this.runtime.applyPatch(this.history.present.patch);
    this.runtime.applySong(this.history.present.song);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  getState(): EngineState {
    return this.history.present;
  }

  getHistory(): HistoryState {
    return this.history;
  }

  /** A copy — the hot path mutates its own transient state in place for latency. */
  getTransient(): TransientState {
    return {
      heldNotes: new Map(this.transient.heldNotes),
      voices: [...this.transient.voices],
      channels: new Map([...this.transient.channels].map(([trackId, pool]) => [
        trackId,
        { heldNotes: new Map(pool.heldNotes), voices: [...pool.voices] },
      ])),
      noteCounter: this.transient.noteCounter,
    };
  }

  /** Everything the async mirror failed to write. Empty is the only good value. */
  getFlushErrors(): readonly unknown[] {
    return this.errors;
  }

  subscribe(listener: DispatchListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Gesture unlock. Must be awaited from a real user gesture before the first sound. */
  unlock(): Promise<void> {
    return this.runtime.unlock();
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * The only way state changes. Synchronous by contract: `noteOn` must not await, so
   * the durable mirror and the transport run on a chain behind this call (see `flush`).
   */
  dispatch(command: SynthCommand, source: CommandSource = 'ui'): CommandResult {
    const startedAt = this.deps.monotonicNow?.();
    const envelope = createEnvelope(command, source, this.deps.newId(), this.deps.now());
    assertEnvelopeConsistent(envelope);

    // F61: validate BEFORE anything else. A rejected command consumes a seq and nothing
    // else — the reducer is never invoked and no audio node is touched.
    //
    // F62 trap: `validateCommand` returns zod's parsed output, and zod strips keys it
    // does not know about. Journalling that instead of `command` would put a quietly
    // different object in the journal than the caller dispatched, and — worse — the live
    // reducer would then see a different input than a replay does, because `replay()`
    // feeds raw payloads straight through with no validation step. So the parsed value
    // is discarded: zod is a GATE here, never a transformer.
    const validation = validateCommand(command);
    if (!validation.ok) {
      return this.finish(envelope, { status: 'rejected', error: validation.error },
        this.history.present.revision, startedAt);
    }

    if (isHotPathCommand(command)) {
      return this.dispatchHotPath(envelope, command, startedAt);
    }

    const before = this.history;
    const result = applyToHistory(this.history, command, {
      commandId: envelope.id,
      ts: envelope.ts,
      ...(this.deps.midi === undefined ? {} : { midi: this.deps.midi }),
    });
    const revision = emittedRevision(before, result);

    if (result.status === 'rejected') {
      return this.finish(envelope, { status: 'rejected', error: result.error }, revision, startedAt);
    }

    this.history = result.history;
    this.syncRuntime(before.present, result.history.present);
    // seek and panic advance nothing in EngineState, so the reducer returned it
    // untouched and `syncRuntime` had nothing to do. Their effect is entirely here.
    this.driveTransient(command);
    return this.finish(envelope, { status: 'applied' }, revision, startedAt);
  }

  /**
   * noteOn / noteOff. These bypass the reducer entirely — not as an optimisation, but
   * because everything they touch lives in `TransientState`, outside `EngineState`. If
   * a note changed reducer state, replaying a journal would have to reproduce which keys
   * were held at which instant, and F59 would be unsatisfiable.
   *
   * The allocator is still core's pure function (decision D1): it decides which voice
   * sounds and which dies, and the runtime only executes the verdict.
   */
  private dispatchHotPath(
    envelope: CommandEnvelope,
    command: SynthCommand,
    startedAt: number | undefined,
  ): CommandResult {
    const state = this.history.present;
    const trackId = (command as { trackId?: string }).trackId;
    const pool = this.poolFor(state, trackId);
    if (pool === null) {
      return this.finish(envelope, {
        status: 'rejected',
        error: `track "${trackId}" is not a synth channel — a note needs a sound to play`,
      }, state.revision, startedAt);
    }
    const channel = trackId === undefined ? {} : { trackId };

    if (command.type === 'noteOn') {
      const voice = soundFor(state, trackId).voice;
      const request = {
        note: command.note,
        velocity: command.velocity,
        order: this.transient.noteCounter,
      };
      const allocation = allocate(pool.voices, voice.polyphony, voice.stealPolicy, request);
      // Steal first: the runtime must release the old note before the slot is reused,
      // or the stolen voice's release tail plays over the new note on the same id.
      if (allocation.stolen !== undefined) {
        this.runtime.steal(allocation.stolen.voiceId, ...(trackId === undefined ? [] : [trackId]));
      }
      this.runtime.noteOn({
        voiceId: allocation.voiceId,
        note: command.note,
        velocity: command.velocity,
        portamento: voice.portamento,
        ...channel,
      });

      pool.voices = applyAllocation(pool.voices, allocation, request);
      pool.heldNotes.set(command.note, request);
      this.transient.noteCounter += 1;
    } else if (command.type === 'noteOff') {
      const { voices, released } = releaseNote(pool.voices, command.note);
      // A note-off for a note that was already stolen is a no-op, not an error: the key
      // is genuinely still down, the voice just went to someone else.
      if (released !== undefined) {
        this.runtime.noteOff({ voiceId: released.voiceId, note: released.note, ...channel });
      }
      pool.voices = voices;
      pool.heldNotes.delete(command.note);
    }

    // Hot-path commands never advance revision, so the emitted one is the current one.
    return this.finish(envelope, { status: 'applied' }, this.history.present.revision, startedAt);
  }

  /**
   * The voice pool a note plays in: the live patch's (no `trackId`), or that synth
   * channel's, created on first use. `null` when the track is not a synth channel.
   *
   * The live pool is `this.transient` itself — it has the same two fields — so the
   * pre-C5 path mutates exactly what it always did.
   */
  private poolFor(state: EngineState, trackId: string | undefined): ChannelTransient | null {
    if (trackId === undefined) return this.transient;
    const track = state.song.tracks.find((candidate) => candidate.id === trackId);
    if (track === undefined || channelKind(track) !== 'synth') return null;
    let pool = this.transient.channels.get(trackId);
    if (pool === undefined) {
      pool = { heldNotes: new Map(), voices: [] };
      this.transient.channels.set(trackId, pool);
    }
    return pool;
  }

  /** The transient commands that are not hot path: they drive the runtime and nothing else. */
  private driveTransient(command: SynthCommand): void {
    if (command.type === 'seek') {
      this.runtime.transport.seek(command.position);
      return;
    }
    if (command.type === 'panic') {
      for (const voice of this.transient.voices) {
        this.runtime.noteOff({ voiceId: voice.voiceId, note: voice.note });
      }
      this.transient.voices = [];
      this.transient.heldNotes.clear();
      for (const [trackId, pool] of this.transient.channels) {
        for (const voice of pool.voices) {
          this.runtime.noteOff({ voiceId: voice.voiceId, note: voice.note, trackId });
        }
      }
      this.transient.channels.clear();
      // `noteCounter` is NOT reset. It is the ordering key the 'oldest' steal policy
      // sorts on, and rewinding it would make notes played after a panic look older
      // than notes played before one.
    }
  }

  /**
   * Push whatever the reducer changed into the audio graph.
   *
   * Reference comparison rather than a per-command switch: the reducer is immutable, so
   * an unchanged sub-document is the SAME object, and a changed one never is. That also
   * makes undo and redo work for free — they swap in whole `EngineState`s, so every
   * changed branch re-syncs without knowing a thing about history.
   */
  private syncRuntime(before: EngineState, after: EngineState): void {
    if (after.patch !== before.patch) this.runtime.applyPatch(after.patch);
    if (after.song !== before.song) this.runtime.applySong(after.song);
    if (after.transport.status !== before.transport.status) {
      switch (after.transport.status) {
        case 'playing':
          this.runtime.transport.play();
          break;
        case 'paused':
          this.runtime.transport.pause();
          break;
        case 'stopped':
          this.runtime.transport.stop();
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Emission
  // -------------------------------------------------------------------------

  /** Build the event, append it, schedule the mirror, notify. One exit for every path. */
  private finish(
    envelope: CommandEnvelope,
    outcome: { status: CommandStatus; error?: string },
    revision: number,
    startedAt: number | undefined,
  ): CommandResult {
    const context: EventContext = {
      seq: this.journal.lastSeq() + 1,
      revision,
      lastAckedSeq: this.journal.lastAckedSeq(),
      ...(this.deps.sessionId === undefined ? {} : { sessionId: this.deps.sessionId }),
    };
    // KIND optional slots `song_id` / `preset_id` stay absent in v0.1.0. Filling them
    // needs a real per-command scope table — which verbs are song-scoped and which are
    // patch-scoped — and a wrong id in a journal is worse than an absent optional slot.
    const end = this.deps.monotonicNow?.();
    if (startedAt !== undefined && end !== undefined) {
      context.durationUs = Math.round((end - startedAt) * 1000);
    }

    const event = buildCommandAppliedEvent(envelope, outcome, context);
    // F60 lives here: MemorySagJournal throws if this seq is not exactly lastSeq() + 1.
    this.journal.append(event);
    this.scheduleFlush();

    const result: CommandResult = {
      commandId: envelope.id,
      status: outcome.status,
      revision,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    };

    const update: DispatchEvent = { result, event, state: this.history.present };
    for (const listener of this.listeners) listener(update);
    return result;
  }

  // -------------------------------------------------------------------------
  // The async mirror
  // -------------------------------------------------------------------------

  /**
   * Chained, never concurrent. Two overlapping flushes would interleave their reads of
   * `persistedSeq` and re-append the same events, and `appendJournal` is only idempotent
   * because it uses `put` — relying on that to paper over a race would be luck, not design.
   */
  private scheduleFlush(): void {
    this.flushChain = this.flushChain.then(() => this.flushOnce()).catch((error: unknown) => {
      this.errors.push(error);
      this.deps.onFlushError?.(error);
    });
  }

  private async flushOnce(): Promise<void> {
    const persistence = this.deps.persistence;
    if (persistence !== undefined) {
      const unpersisted = this.journal.read(this.persistedSeq + 1);
      if (unpersisted.length > 0) {
        await persistence.appendJournal(unpersisted);
        this.persistedSeq = unpersisted[unpersisted.length - 1]!.seq;
      }
    }

    // Nothing acknowledges anything in v0.1.0, so this returns immediately and the whole
    // journal stays pending — which is the correct state for a buffered emitter with no
    // backend. Sending into a disconnected transport on every dispatch would be a
    // growing no-op that only looked like progress.
    if (!this.transport.isConnected) return;

    const unsent = this.journal.read(this.journal.lastAckedSeq() + 1);
    if (unsent.length === 0) return;
    const { ackedSeq } = await this.transport.send(unsent);
    if (ackedSeq > this.journal.lastAckedSeq()) {
      this.journal.markAcked(ackedSeq);
      if (persistence !== undefined) await persistence.saveLastAckedSeq(ackedSeq);
    }
  }

  /** Await the pending mirror. Tests need this; so does a clean shutdown. */
  flush(): Promise<void> {
    return this.flushChain;
  }

  dispose(): void {
    this.listeners.clear();
    this.runtime.dispose();
    this.deps.persistence?.dispose();
  }
}
