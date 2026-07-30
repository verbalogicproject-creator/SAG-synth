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
import { ToneRuntime, UNMAPPED_PARAMS } from '../../runtime';
import { createEngine } from '../../app/create-engine';
import { MemorySagJournal } from '../../core/sag/events';
import type { Dispatcher } from '../../app/dispatcher';
import { clampOctave, isMusicalKey, noteForKey } from './keyboard';
import { VirtualKeyboard } from './VirtualKeyboard';

/**
 * Module-scope singleton, built on first use.
 *
 * Not `useState(() => …)`: StrictMode invokes that initializer twice in development,
 * which would build two audio graphs and leave one orphaned, silently doubling the
 * voice count and the CPU cost.
 */
let engine: { runtime: ToneRuntime; dispatcher: Dispatcher; journal: MemorySagJournal } | null =
  null;

function getEngine(): NonNullable<typeof engine> {
  if (engine === null) {
    const runtime = new ToneRuntime();
    const journal = new MemorySagJournal();
    engine = { runtime, journal, dispatcher: createEngine({ runtime, overrides: { journal } }) };
  }
  return engine;
}

interface Snapshot {
  revision: number;
  voices: number;
  held: string[];
  journalLength: number;
  lastEvent: string;
}

export function DebugApp() {
  const { runtime, dispatcher, journal } = getEngine();
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
  const [snapshot, setSnapshot] = useState<Snapshot>({
    revision: 0,
    voices: 0,
    held: [],
    journalLength: 0,
    lastEvent: '—',
  });

  const refresh = useCallback(() => {
    const transient = dispatcher.getTransient();
    const events = journal.read();
    const last = events.at(-1);
    setSnapshot({
      revision: dispatcher.getState().revision,
      voices: transient.voices.length,
      held: [...transient.heldNotes.keys()],
      journalLength: events.length,
      lastEvent: last === undefined ? '—' : `#${last.seq} ${last.command_type} → ${last.status}`,
    });
  }, [dispatcher, journal]);

  useEffect(() => dispatcher.subscribe(refresh), [dispatcher, refresh]);

  const unlock = useCallback(async () => {
    await dispatcher.unlock();
    setContextState(runtime.getContextState());
  }, [dispatcher, runtime]);

  const noteOn = useCallback(
    (note: string) => {
      dispatcher.dispatch({ type: 'noteOn', note, velocity: 0.8 });
    },
    [dispatcher],
  );

  const noteOff = useCallback(
    (note: string) => {
      dispatcher.dispatch({ type: 'noteOff', note });
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
        Stage 1 vertical slice. Every note goes through the dispatcher and lands in the
        journal. Disposable by design.
      </p>

      {/* Driven by the context's own state, so it comes BACK if Android re-suspends
          after backgrounding. Hiding this on a flag we set ourselves is what made the
          synth unrecoverably silent. */}
      {contextState !== 'running' && (
        <button type="button" onClick={() => void unlock()} style={styles.unlock}>
          ▶ Tap to enable audio — context is {contextState}
        </button>
      )}

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
          The test tone skips the voice pool, the patch and the master chain entirely — a
          plain 440Hz oscillator straight to the output. If you hear it but not the keys,
          the fault is in our signal path. If you hear neither, it is the page or the
          device.
        </p>
      </section>

      <section style={styles.panel}>
        <h2 style={styles.h2}>SAG journal</h2>
        <dl style={styles.grid}>
          <dt style={styles.dt}>events</dt>
          <dd style={styles.dd}>{snapshot.journalLength}</dd>
          <dt style={styles.dt}>last</dt>
          <dd style={styles.dd}>{snapshot.lastEvent}</dd>
        </dl>
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
          voice.filter.frequency collides with voice.filterEnvelope.baseFrequency — in a
          MonoSynth the envelope owns the cutoff, so only one can be it. baseFrequency
          wins; see UNMAPPED_PARAMS in tone-runtime.ts.
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
