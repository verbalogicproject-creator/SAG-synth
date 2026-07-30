/**
 * src/clients/debug/DebugApp.tsx — the throwaway control surface.
 *
 * Its only job is to prove the engine plays, and to make the SAG substrate visible while
 * doing it. It is deliberately ugly and will be deleted when the designed
 * `src/clients/ui/` lands; nothing here should be treated as a layout decision.
 *
 * On-screen keys are the PRIMARY input — development happens on Android, with no
 * physical keyboard. The QWERTY bindings are a secondary convenience.
 *
 * What this file is not allowed to do is talk to Tone.js. Every note goes through
 * `dispatcher.dispatch()`, so the journal is a complete record of the session and the
 * v0.2 SDK drives the identical path. `src/tests/contract.test.ts` enforces that.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ToneRuntime, UNMAPPED_PARAMS, unsupportedOscillatorFeatures } from '../../runtime';
import { createEngine } from '../../app/create-engine';
import { HttpSagObserver } from '../../app/http-observer';
import { MemorySagJournal } from '../../core/sag/events';
import { DEFAULT_PRESET_ID } from '../../core/state';
import type { Dispatcher } from '../../app/dispatcher';
import { clampOctave, isMusicalKey, noteForKey } from './keyboard';
import { VirtualKeyboard } from './VirtualKeyboard';
import { AmpPanel } from './AmpPanel';
import { FilterPanel } from './FilterPanel';
import { FxPanel } from './FxPanel';
import { ModPanel } from './ModPanel';
import { OscillatorPanel } from './OscillatorPanel';
import type { ParamPath, ParamValue } from '../../core/types';

/**
 * The engine handle, and it lives on `globalThis` rather than in this module.
 *
 * Not `useState(() => …)`: StrictMode invokes that initializer twice in development,
 * which would build two audio graphs and leave one orphaned.
 *
 * And not a plain module variable either, which is the subtler half. A module variable
 * dies with its module: when Vite hot-updates anything this file imports, it evaluates a
 * NEW copy of this module in which `engine` is `null`, and that copy dutifully builds a
 * second audio graph while the first is still connected to the destination. The
 * `hot.dispose` hook below is meant to prevent exactly that and only fires for the copy
 * that registered it — so an update arriving through a different boundary leaves the old
 * graph alive with nothing holding a reference to it.
 *
 * That is not a hypothesis. On 2026-07-30 the observation log recorded three engine ids
 * reporting in the same minute from one page, and the tab had gone silent — the symptom
 * this whole indirection exists to prevent, arriving anyway through the gap.
 *
 * A key on `globalThis` outlives module re-evaluation, so a fresh copy can find its
 * predecessor and tear it down. One graph per page, whichever module copy is asking.
 */
const ENGINE_KEY = '__sagSynthDebugEngine__';

type EngineHandle = {
  runtime: ToneRuntime;
  dispatcher: Dispatcher;
  journal: MemorySagJournal;
  observer: HttpSagObserver;
  /**
   * Identity of THIS engine instance, not the session.
   *
   * The point of it is the failure described under `import.meta.hot` below: when several
   * graphs are alive at once, every one emits observations under its own id, so the leak
   * shows up as two ids interleaved in the log rather than having to be deduced from a
   * synth that has gone quiet.
   */
  instanceId: string;
};

type EngineSlot = typeof globalThis & { [ENGINE_KEY]?: EngineHandle | null };

function slot(): EngineSlot {
  return globalThis as EngineSlot;
}

function disposeEngine(): void {
  const live = slot()[ENGINE_KEY];
  if (live == null) return;
  live.dispatcher.dispose();
  live.observer.dispose();
  slot()[ENGINE_KEY] = null;
}

// Reap the predecessor at module-evaluation time, which is the moment a hot update
// produces a second copy of this file. Running it here rather than only in `hot.dispose`
// covers the case that hook cannot: an update propagating through some other boundary,
// where the copy that registered the hook is not the copy being replaced.
if (import.meta.hot) disposeEngine();

function getEngine(): EngineHandle {
  const existing = slot()[ENGINE_KEY];
  if (existing != null) return existing;

  const runtime = new ToneRuntime();
  const journal = new MemorySagJournal();
  const built: EngineHandle = {
    runtime,
    journal,
    observer: new HttpSagObserver(),
    instanceId: crypto.randomUUID().slice(0, 8),
    dispatcher: createEngine({ runtime, overrides: { journal } }),
  };
  slot()[ENGINE_KEY] = built;
  return built;
}

/**
 * Tear the audio graph down before a hot update replaces this module.
 *
 * Without this, every HMR reload resets `engine` to null and builds a fresh
 * ToneRuntime — a new master Volume, Analyser and Meter, all still wired to the
 * destination — while the previous graph stays alive and summing. An editing session
 * with thirty saves ends with thirty live analysers and thirty orphaned voice pools on
 * one AudioContext.
 *
 * Not hypothetical tidiness: that accumulation is what silenced a long-running tab on
 * 2026-07-30, and it was identified only by opening a fresh one — after several rounds
 * of looking for the fault inside the engine, where it was never going to be.
 */
if (import.meta.hot) {
  import.meta.hot.dispose(disposeEngine);
}

/**
 * A real file served over HTTP, not a Blob built in JS.
 *
 * The first version generated a WAV into an object URL. That put my own encoder between
 * the question and the answer — the player reported `0:00 / 0:00`, meaning it never got
 * a duration, which is indistinguishable from a device that cannot play. A static file
 * the dev server hands over as `audio/wav` removes that variable entirely.
 */
const BEEP_URL = '/beep.wav';

interface Snapshot {
  revision: number;
  voices: number;
  held: string[];
  journalLength: number;
  lastEvent: string;
  /** Most recent refused command, kept until another one replaces it. */
  lastRejection: string;
}

export function DebugApp() {
  const { runtime, dispatcher, journal, observer, instanceId } = getEngine();
  /**
   * The AudioContext's own state, polled — never a boolean we set ourselves.
   *
   * An earlier version tracked `unlocked` as React state set after `unlock()` resolved.
   * That is wrong twice over: `AudioContext.resume()` resolves whether or not the
   * browser honoured it, and Android re-suspends the context whenever the tab is
   * backgrounded. Both leave the flag saying "unlocked" while the context is suspended
   * — and since the flag hid the unlock button, there was then no way back.
   */
  const [contextState, setContextState] = useState('suspended');
  const [contextTime, setContextTime] = useState(0);
  const [octave, setOctave] = useState(3);
  const [level, setLevel] = useState(Number.NEGATIVE_INFINITY);
  const [peak, setPeak] = useState(Number.NEGATIVE_INFINITY);
  const [unlockError, setUnlockError] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot>({
    revision: 0,
    voices: 0,
    held: [],
    journalLength: 0,
    lastEvent: '—',
    lastRejection: '',
  });

  const refresh = useCallback(() => {
    const transient = dispatcher.getTransient();
    const events = journal.read();
    const last = events.at(-1);
    // A REJECTED command is the quietest failure this engine has: validation refuses it,
    // the journal records it, and the control that sent it simply does not move. The EQ
    // toggle did exactly that for two stages — 'eq' was missing from the validator's
    // effect-id enum, so every click was refused and nothing said so. Rejections are rare
    // and always mean something, so the most recent one STICKS rather than scrolling past
    // in the last-event row.
    const rejected = [...events].reverse().find((event) => event.status === 'rejected');
    setSnapshot({
      revision: dispatcher.getState().revision,
      voices: transient.voices.length,
      held: [...transient.heldNotes.keys()],
      journalLength: events.length,
      lastEvent: last === undefined ? '—' : `#${last.seq} ${last.command_type} → ${last.status}`,
      lastRejection:
        rejected === undefined
          ? ''
          : `#${rejected.seq} ${rejected.command_type} — ${rejected.error ?? 'no reason given'}`,
    });
  }, [dispatcher, journal]);

  useEffect(() => dispatcher.subscribe(refresh), [dispatcher, refresh]);

  const unlock = useCallback(async () => {
    // Report what actually happened. `Tone.start()` resolving is not evidence the
    // browser honoured it, and a rejection here was previously swallowed entirely — so
    // a refused resume looked exactly like a working one.
    try {
      await dispatcher.unlock();
      const state = runtime.getContextState();
      setContextState(state);
      setUnlockError(state === 'running' ? '' : `resume() returned but state is "${state}"`);
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : String(error));
    }
  }, [dispatcher, runtime]);

  /**
   * Play velocity for the touch keyboard.
   *
   * A hardware keybed measures how fast a key falls; a touchscreen has no such axis, and
   * this surface sent a hardcoded 0.8 for every note. That made the whole velocity
   * section — `toAmplitude`, `toFilterOctaves`, and any route sourced from velocity —
   * impossible to hear on the device it is developed on, however well it gated offline.
   *
   * A slider is the crude answer. The designed surface should take velocity from where
   * the key was struck, which is what mobile synths do and what this cannot.
   *
   * Local React state on purpose: it is a property of the performance, not of the patch,
   * so it belongs nowhere near `EngineState` — the journal records the velocity that each
   * note actually carried, which is what replay needs.
   */
  const [velocity, setVelocity] = useState(0.8);

  const noteOn = useCallback(
    (note: string) => {
      dispatcher.dispatch({ type: 'noteOn', note, velocity });
    },
    [dispatcher, velocity],
  );

  const noteOff = useCallback(
    (note: string) => {
      dispatcher.dispatch({ type: 'noteOff', note });
    },
    [dispatcher],
  );

  /**
   * A knob turn is a document edit, so unlike a note it advances `revision` and lands on
   * the undo stack. Nothing here reaches the audio graph — the dispatcher's runtime sync
   * notices the patch reference changed and re-applies it.
   */
  const setParamValue = useCallback(
    (path: ParamPath, value: ParamValue) => {
      dispatcher.dispatch({ type: 'setParam', path, value });
    },
    [dispatcher],
  );

  // Level meter, peak hold, and context state. Polled rather than pushed — all read the
  // live audio graph, which is not state and must never become state. There is also no
  // event for the context being suspended out from under us.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const current = runtime.getLevel();
      setLevel(current);
      // Peak hold. A note's transient can easily fall between two animation frames, so
      // an instantaneous reading can show −∞ for audio that genuinely played — which
      // would send a diagnosis in exactly the wrong direction.
      setPeak((held) => (current > held ? current : held));
      setContextState(runtime.getContextState());
      setContextTime(runtime.getContextTime());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [runtime]);

  /**
   * Ship a measurement of the master bus to the dev server, twice a second.
   *
   * Separate from the meter loop above on purpose. That one runs on `requestAnimationFrame`
   * because it drives a display and should stop when the tab is hidden; this one runs on a
   * timer because a synth that goes quiet when backgrounded is exactly the thing worth
   * recording, and rAF would fall silent at the same moment as the evidence.
   *
   * 500 ms is chosen against what it must catch — a note's decay, a graph that stopped, a
   * second engine appearing. Fast enough to see any of those, slow enough that the buffer
   * holds a hundred seconds of history at its ceiling.
   */
  useEffect(() => {
    const id = setInterval(() => {
      observer.observe({
        ...runtime.observeAudio(),
        instance_id: instanceId,
        observed_at: Date.now(),
      });
    }, 500);
    return () => clearInterval(id);
  }, [runtime, observer, instanceId]);

  /**
   * Resume the context on any qualifying gesture, for as long as it is not running.
   *
   * `pointerdown` is deliberately NOT used. Per the HTML activation spec a `pointerdown`
   * only counts as a user activation when `pointerType` is "mouse" — on touch it is
   * `pointerup` that qualifies. That is the entire bug this replaces: tapping a piano
   * key called `Tone.start()` from `pointerdown`, the browser declined to resume, and
   * `resume()` resolved anyway, so the app believed it was unlocked and hid the button.
   */
  useEffect(() => {
    function resume(): void {
      if (runtime.getContextState() === 'running') return;
      void unlock();
    }
    window.addEventListener('pointerup', resume);
    window.addEventListener('click', resume);
    window.addEventListener('touchend', resume);
    return () => {
      window.removeEventListener('pointerup', resume);
      window.removeEventListener('click', resume);
      window.removeEventListener('touchend', resume);
    };
  }, [runtime, unlock]);

  // Secondary input: a physical keyboard, if one is ever attached.
  const heldKeys = useRef(new Map<string, string>());
  const octaveRef = useRef(octave);
  octaveRef.current = octave;

  useEffect(() => {
    function down(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();

      if (key === 'z') return setOctave((current) => clampOctave(current - 1));
      if (key === 'x') return setOctave((current) => clampOctave(current + 1));
      if (!isMusicalKey(key)) return;
      event.preventDefault();

      // Auto-repeat would fire noteOn dozens of times a second for one held key, which
      // the allocator retriggers into a stutter rather than a held note.
      if (event.repeat || heldKeys.current.has(key)) return;

      const note = noteForKey(key, octaveRef.current);
      if (note === null) return;
      // Store the note rather than recomputing it on keyup: the octave can change while
      // a key is held, and recomputing would release a note that is not sounding and
      // strand the original on forever.
      heldKeys.current.set(key, note);
      noteOn(note);
    }

    function up(event: KeyboardEvent): void {
      const key = event.key.toLowerCase();
      const note = heldKeys.current.get(key);
      if (note === undefined) return;
      heldKeys.current.delete(key);
      noteOff(note);
    }

    // A blur mid-chord never delivers keyup, which would leave every note sounding.
    function panic(): void {
      heldKeys.current.clear();
      dispatcher.dispatch({ type: 'panic' });
    }

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', panic);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', panic);
    };
  }, [dispatcher, noteOn, noteOff]);

  const unimplemented = runtime.getUnimplemented();
  const heldSet = new Set(snapshot.held);

  return (
    <main style={styles.page}>
      <h1 style={styles.h1}>SAG-synth — debug surface</h1>
      <p style={styles.sub}>
        Complete voice, modulation and effects chain. Every note goes through the
        dispatcher and lands in the journal. Disposable by design — the designed surface
        replaces this rather than restyling it.
      </p>

      {/*
        ALWAYS rendered, never conditional.

        Two earlier versions both got this wrong. The first hid it behind an `unlocked`
        flag we set ourselves, which left no way back when the browser declined to
        resume. The second showed it only while the context was not 'running' — better,
        but it still vanishes exactly when someone wants to confirm audio is armed or
        force a re-arm, and a control that disappears reads as a broken page rather than
        a healthy one. It now always shows, and always says which state it is in.
      */}
      <button
        type="button"
        onClick={() => void unlock()}
        style={{
          ...styles.unlock,
          borderColor: contextState === 'running' ? '#6ad48a' : '#e0a030',
          opacity: contextState === 'running' ? 0.7 : 1,
        }}
      >
        {contextState === 'running'
          ? '♪ audio running — tap to re-arm'
          : `▶ Tap to enable audio — context is ${contextState}`}
      </button>

      <section style={styles.panel}>
        <div style={styles.octaveRow}>
          <button
            type="button"
            style={styles.octaveButton}
            onClick={() => setOctave((current) => clampOctave(current - 1))}
          >
            − oct
          </button>
          <span style={styles.octaveLabel}>C{octave}</span>
          <button
            type="button"
            style={styles.octaveButton}
            onClick={() => setOctave((current) => clampOctave(current + 1))}
          >
            + oct
          </button>
        </div>
        <VirtualKeyboard
          octave={octave}
          held={heldSet}
          onNoteOn={noteOn}
          onNoteOff={noteOff}
        />
        <p style={styles.dim}>
          Multi-touch works — hold two or three keys for a chord. Slide across keys to
          glissando.
        </p>
      </section>

      <section style={styles.panel}>
        <h2 style={styles.h2}>Amp &amp; velocity</h2>
        <AmpPanel
          state={dispatcher.getState()}
          onChange={setParamValue}
          velocity={velocity}
          onVelocityChange={setVelocity}
        />
      </section>

      <section style={styles.panel}>
        <h2 style={styles.h2}>Oscillator</h2>
        <OscillatorPanel
          state={dispatcher.getState()}
          onChange={setParamValue}
          unsupported={unsupportedOscillatorFeatures(
            dispatcher.getState().patch.voice.oscillator,
          )}
        />
      </section>

      <section style={styles.panel}>
        <h2 style={styles.h2}>FX &amp; EQ</h2>
        <FxPanel
          state={dispatcher.getState()}
          onChange={setParamValue}
          onCommand={(command) => dispatcher.dispatch(command)}
        />
      </section>

      <section style={styles.panel}>
        <h2 style={styles.h2}>LFO &amp; routing</h2>
        <ModPanel
          state={dispatcher.getState()}
          onChange={setParamValue}
          onCommand={(command) => dispatcher.dispatch(command)}
        />
      </section>

      <section style={styles.panel}>
        <h2 style={styles.h2}>Filter</h2>
        <FilterPanel state={dispatcher.getState()} onChange={setParamValue} />
        <div style={styles.diagRow}>
          <button
            type="button"
            style={styles.diagButton}
            onClick={() => dispatcher.dispatch({ type: 'undo' })}
          >
            ↶ undo
          </button>
          <button
            type="button"
            style={styles.diagButton}
            onClick={() => dispatcher.dispatch({ type: 'redo' })}
          >
            ↷ redo
          </button>
          {/* A cutoff slider can be dragged to 20Hz, which is silence with no obvious
              way home — undo only walks back one edit at a time. */}
          <button
            type="button"
            style={styles.diagButton}
            onClick={() => dispatcher.dispatch({ type: 'loadPreset', presetId: DEFAULT_PRESET_ID })}
          >
            ⟲ reset patch
          </button>
        </div>
        <p style={styles.dim}>
          Every knob turn is a journalled command — watch revision climb, and undo walks
          it back through the same journal a replay would.
        </p>
      </section>

      <section style={styles.panel}>
        <h2 style={styles.h2}>Engine</h2>
        <dl style={styles.grid}>
          <dt style={styles.dt}>audio context</dt>
          <dd style={{ ...styles.dd, color: contextState === 'running' ? '#6ad48a' : '#e0a030' }}>
            {contextState}
          </dd>
          <dt style={styles.dt}>revision</dt>
          <dd style={styles.dd}>{snapshot.revision}</dd>
          <dt style={styles.dt}>sounding voices</dt>
          <dd style={styles.dd}>{snapshot.voices}</dd>
          <dt style={styles.dt}>held notes</dt>
          <dd style={styles.dd}>{snapshot.held.join(' ') || '—'}</dd>
          <dt style={styles.dt}>tone voices built</dt>
          <dd style={styles.dd}>{runtime.voiceCount}</dd>
          <dt style={styles.dt}>master level</dt>
          <dd style={styles.dd}>
            {Number.isFinite(level) ? `${level.toFixed(1)} dBFS` : '−∞'}
          </dd>
          <dt style={styles.dt}>peak held</dt>
          <dd style={{ ...styles.dd, color: Number.isFinite(peak) ? '#6ad48a' : undefined }}>
            {Number.isFinite(peak) ? `${peak.toFixed(1)} dBFS` : '−∞ (no signal yet)'}
          </dd>
        </dl>
        <p style={styles.dim}>
          revision stays at 0 while playing: notes are performance gestures, not document
          edits.
        </p>
      </section>

      {/* Diagnostics. Temporary — here to explain a silent synth, not to stay. */}
      <section style={{ ...styles.panel, borderColor: '#5a7fbf' }}>
        <h2 style={styles.h2}>Audio path diagnostics</h2>
        <dl style={styles.grid}>
          <dt style={styles.dt}>context clock</dt>
          <dd style={styles.dd}>{contextTime.toFixed(2)}s</dd>
          <dt style={styles.dt}>sample rate</dt>
          <dd style={styles.dd}>{runtime.getSampleRate()} Hz</dd>
        </dl>
        <p style={styles.dim}>
          The clock must be <strong>counting up</strong>. A context that says “running”
          with a frozen clock is a different fault from a suspended one.
        </p>
        <div style={styles.diagRow}>
          <button type="button" style={styles.diagButton} onClick={() => runtime.selfTest()}>
            ♪ Test tone (bypasses engine)
          </button>
          <button
            type="button"
            style={styles.diagButton}
            onClick={() => setPeak(Number.NEGATIVE_INFINITY)}
          >
            Reset peak
          </button>
        </div>
        <p style={styles.dim}>
          The test tone skips the voice pool, the patch and the master chain — but still
          goes through Web Audio. The player below does not: it is a plain WAV in an
          &lt;audio&gt; element, which has different autoplay rules and different routing.
        </p>

        <p style={{ ...styles.dim, marginTop: '1rem' }}>
          <strong>Plays here but not above → Web Audio is blocked. Silent here too →
          the device is not producing sound at all</strong> (media volume, audio focus, or
          a muted tab). While this is playing, Android&apos;s volume rocker controls MEDIA
          volume rather than the ringer — worth a press either way.
        </p>
        <audio src={BEEP_URL} controls preload="auto" style={styles.audio} />

        {unlockError !== '' && (
          <p style={{ ...styles.dim, color: 'crimson' }}>unlock reported: {unlockError}</p>
        )}
      </section>

      <section style={styles.panel}>
        <h2 style={styles.h2}>SAG journal</h2>
        <dl style={styles.grid}>
          <dt style={styles.dt}>events</dt>
          <dd style={styles.dd}>{snapshot.journalLength}</dd>
          <dt style={styles.dt}>last</dt>
          <dd style={styles.dd}>{snapshot.lastEvent}</dd>
          <dt style={{ ...styles.dt, color: snapshot.lastRejection === '' ? undefined : '#d33682' }}>
            last refused
          </dt>
          <dd style={{ ...styles.dd, color: snapshot.lastRejection === '' ? undefined : '#d33682' }}>
            {snapshot.lastRejection === '' ? 'none' : snapshot.lastRejection}
          </dd>
        </dl>
        <p style={styles.dim}>
          A refused command is the quietest failure here — validation rejects it, the
          journal records it, and the control that sent it just does not move. The EQ
          toggle did exactly that for two stages. This row sticks so a rejection cannot
          scroll past unseen.
        </p>
      </section>

      <section style={{ ...styles.panel, borderColor: '#b58900' }}>
        <h2 style={styles.h2}>Known gaps</h2>
        <dl style={styles.grid}>
          <dt style={styles.dt}>unmapped params</dt>
          <dd style={styles.dd}>{UNMAPPED_PARAMS.join(', ') || 'none'}</dd>
          <dt style={styles.dt}>calls not serviced</dt>
          <dd style={styles.dd}>{unimplemented.join(', ') || 'none'}</dd>
        </dl>
        <p style={styles.dim}>
          Schema version 2. <strong>All 97 declared addresses now reach the audio graph</strong>
          — voice, modulation routing, the effects chain, the EQ and the master stage. What
          is left is song playback: tracks, tempo and the step grid need Tone.Transport,
          which is v0.3.0, and that is what “applySong.transport” above means.
        </p>
        <p style={styles.dim}>
          The two rows above are read live from the runtime, but this paragraph is prose and
          prose goes stale. It claimed routing, EQ and the amp/pan bases were unmapped for
          three stages after they were mapped — a gaps panel listing gaps that no longer
          exist is worse than no panel, because it sends you looking for a fault that was
          fixed. Trust the rows; treat this sentence as dated.
        </p>
      </section>
    </main>
  );
}

const styles = {
  page: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    maxWidth: '46rem',
    margin: '0 auto',
    padding: '1rem 0.75rem 3rem',
    lineHeight: 1.5,
  },
  h1: { fontSize: '1.1rem', margin: '0 0 0.25rem' },
  h2: {
    fontSize: '0.75rem',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: '0 0 0.75rem',
    opacity: 0.6,
  },
  sub: { margin: '0 0 1rem', opacity: 0.7, fontSize: '0.8rem' },
  unlock: {
    fontSize: '1.1rem',
    padding: '1.1rem 2rem',
    cursor: 'pointer',
    width: '100%',
    marginBottom: '1rem',
    touchAction: 'manipulation',
  },
  panel: {
    border: '1px solid currentColor',
    borderRadius: 4,
    padding: '0.85rem',
    margin: '0 0 1rem',
    opacity: 0.95,
  },
  octaveRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    marginBottom: '0.75rem',
  },
  octaveButton: {
    fontSize: '1rem',
    padding: '0.6rem 1.1rem',
    cursor: 'pointer',
    touchAction: 'manipulation',
    fontFamily: 'inherit',
  },
  octaveLabel: { fontSize: '1rem', fontWeight: 700 },
  diagRow: { display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' },
  audio: { width: '100%', marginTop: '0.5rem' },
  diagButton: {
    fontSize: '0.9rem',
    padding: '0.7rem 1rem',
    cursor: 'pointer',
    touchAction: 'manipulation',
    fontFamily: 'inherit',
    flex: '1 1 auto',
  },
  grid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 1rem', margin: 0 },
  dt: { opacity: 0.6, fontSize: '0.8rem' },
  dd: { margin: 0, fontSize: '0.8rem' },
  dim: { opacity: 0.55, fontSize: '0.7rem', margin: '0.75rem 0 0' },
} as const satisfies Record<string, React.CSSProperties>;
