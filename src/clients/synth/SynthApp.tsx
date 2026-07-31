/**
 * src/clients/synth/SynthApp.tsx — the instrument, mounted.
 *
 * Everything below the header is `SynthPanels`, which is state-free. This file is where
 * the engine is reached for, notes are dispatched and the audio context is unlocked —
 * exactly the jobs `DebugApp` does for the other surface, done once here so the panels
 * stay presentational.
 *
 * **One engine, whichever surface is showing.** `getEngine()` reads a `globalThis` slot
 * shared with the debug wall, so switching between `#debug` and the instrument reuses the
 * same audio graph rather than building a second one. That is not tidiness: three engine
 * ids reporting from one page is what silenced a tab on 2026-07-30, and adding a second
 * mount point is the phase plan's named way of doing it again.
 *
 * The header is deliberately thin. A patch stepper needs the preset browser and a bay
 * button needs the bay; both arrive at 4.6b, and drawing either now would be a control
 * that does nothing.
 */

import { useCallback, useEffect, useState } from 'react';
import { getEngine } from '../engine';
import { VirtualKeyboard } from '../debug/VirtualKeyboard';
import type { ParamPath, ParamValue } from '../../core/types';
import type { SynthCommand } from '../../core/commands';
import { SynthPanels } from './SynthPanels';
import { RouteList } from './RouteList';
import { surfaceContext } from './controlProps';
import { COLOR, FONT, TOUCH_MIN } from './tokens';

/**
 * Velocity's resolution, written here because velocity has nowhere else to live.
 *
 * Every other control on this surface reads its range from `PARAM_SPECS` and gate 6
 * refuses literals for exactly that reason. This one is not a parameter: play velocity is
 * a property of the performance, not of the patch, so it has no address and no spec. A
 * named constant rather than an inline number so the exception is visible as an exception.
 */
const VELOCITY_STEP = 0.01;

export function SynthApp() {
  const { dispatcher, runtime } = getEngine();

  const [state, setState] = useState(() => dispatcher.getState());
  const [contextState, setContextState] = useState(() => runtime.getContextState());
  const [octave, setOctave] = useState(3);

  /**
   * Velocity for the touch keyboard, held here rather than in the patch.
   *
   * A touchscreen has no strike speed, and this surface sending a fixed value is what made
   * the entire velocity section unhearable on the device it is developed on. Local state
   * because it is a property of the performance: the journal records the velocity each
   * note actually carried, which is what replay needs.
   */
  const [velocity, setVelocity] = useState(0.8);

  /**
   * Routing is an overlay, not a fifth tab.
   *
   * A route is a relationship between two addresses, so it has to be reachable from every
   * control that has one — which a place in the tab bar cannot be. `BAY_SECTION` in
   * `groups.ts` says the same thing in the declaration.
   */
  const [bayOpen, setBayOpen] = useState(false);

  /**
   * The keyboard folds away, because on a phone it is a third of the screen.
   *
   * Only the keys hide — the velocity and octave row stays, since those are what you set
   * before playing and hunting for them is worse than the space they cost.
   */
  const [keysOpen, setKeysOpen] = useState(true);

  /**
   * Held notes come from the dispatcher's TRANSIENT state, not from `EngineState`.
   *
   * A sounding note is not a document edit — it advances no revision and belongs nowhere
   * near the patch — so the keyboard's lit keys are read from where the engine actually
   * keeps them.
   */
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());

  useEffect(
    () =>
      dispatcher.subscribe(() => {
        setState(dispatcher.getState());
        setHeld(new Set(dispatcher.getTransient().heldNotes.keys()));
      }),
    [dispatcher],
  );

  // Polled from the context rather than tracked as a flag we set ourselves: `resume()`
  // resolves whether or not the browser honoured it, and Android re-suspends whenever the
  // tab is backgrounded. A flag would say "running" with no way back.
  useEffect(() => {
    const timer = setInterval(() => setContextState(runtime.getContextState()), 500);
    return () => clearInterval(timer);
  }, [runtime]);

  const unlock = useCallback(async () => {
    await dispatcher.unlock();
    setContextState(runtime.getContextState());
  }, [dispatcher, runtime]);

  const onChange = useCallback(
    (path: ParamPath, value: ParamValue) => {
      dispatcher.dispatch({ type: 'setParam', path, value });
    },
    [dispatcher],
  );

  const onCommand = useCallback(
    (command: SynthCommand) => dispatcher.dispatch(command),
    [dispatcher],
  );

  const noteOn = useCallback(
    (note: string) => dispatcher.dispatch({ type: 'noteOn', note, velocity }),
    [dispatcher, velocity],
  );
  const noteOff = useCallback(
    (note: string) => dispatcher.dispatch({ type: 'noteOff', note }),
    [dispatcher],
  );

  const running = contextState === 'running';

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <span style={styles.logo}>SAG</span>
        <span style={styles.patch}>{state.patch.name}</span>
        <button
          type="button"
          onClick={() => setBayOpen(true)}
          style={styles.bay}
          aria-label="open the routing bay"
        >
          ROUTING
        </button>
        <button
          type="button"
          onClick={unlock}
          style={{ ...styles.unlock, opacity: running ? 0.35 : 1 }}
          aria-label={running ? 'audio running' : 'start audio'}
        >
          {running ? '● live' : '▶ start'}
        </button>
      </header>

      <main style={styles.main}>
        <SynthPanels state={state} onChange={onChange} onCommand={onCommand} />
      </main>

      {bayOpen && (
        <div style={styles.overlay} role="dialog" aria-modal="true" aria-label="routing">
          <header style={styles.overlayHead}>
            <h2 style={styles.overlayTitle}>ROUTING</h2>
            <button
              type="button"
              onClick={() => setBayOpen(false)}
              style={styles.close}
              aria-label="close the routing bay"
            >
              ✕
            </button>
          </header>
          <div style={styles.overlayBody}>
            <RouteList
              context={surfaceContext(state, onChange)}
              onCommand={onCommand}
            />
          </div>
        </div>
      )}

      <footer style={styles.footer}>
        <label style={styles.velocity}>
          <span>vel</span>
          <input
            type="range"
            min={0}
            max={1}
            step={VELOCITY_STEP}
            value={velocity}
            onChange={(event) => setVelocity(Number(event.target.value))}
            style={styles.velocityTrack}
            aria-label="play velocity"
          />
          <span style={styles.velocityValue}>{velocity.toFixed(2)}</span>
          <button type="button" onClick={() => setOctave((o) => Math.max(0, o - 1))} style={styles.octave}>
            −
          </button>
          <span style={styles.velocityValue}>C{octave}</span>
          <button type="button" onClick={() => setOctave((o) => Math.min(7, o + 1))} style={styles.octave}>
            +
          </button>
          <button
            type="button"
            onClick={() => setKeysOpen((open) => !open)}
            style={styles.octave}
            aria-label={keysOpen ? 'hide the keyboard' : 'show the keyboard'}
            aria-expanded={keysOpen}
          >
            {keysOpen ? '⌄' : '⌃'}
          </button>
        </label>
        {keysOpen && (
          <VirtualKeyboard
            octave={octave}
            held={held}
            onNoteOn={noteOn}
            onNoteOff={noteOff}
          />
        )}
      </footer>
    </div>
  );
}

const styles = {
  app: {
    display: 'flex',
    flexDirection: 'column',
    // height, NOT minHeight. With a minimum the app grows to fit a tall tab, the BODY
    // becomes the scroller, and the footer scrolls away with everything else — which is
    // exactly the keyboard drifting off the bottom of the FX tab. Fixed height plus
    // `overflow: hidden` makes `main` the only thing that can scroll.
    height: '100dvh',
    overflow: 'hidden',
    background: COLOR.surface,
    color: COLOR.text,
    fontFamily: FONT.display,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    padding: '0.4rem 0.7rem',
    background: COLOR.surfaceLowest,
    borderBottom: `1px solid ${COLOR.border}`,
  },
  logo: {
    fontFamily: FONT.mono,
    fontSize: '0.9rem',
    letterSpacing: '0.2em',
    color: COLOR.accent,
  },
  patch: { flex: 1, fontSize: '0.75rem', color: COLOR.textDim },
  bay: {
    minHeight: TOUCH_MIN,
    padding: '0 0.7rem',
    background: 'transparent',
    color: COLOR.textDim,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 4,
    fontFamily: FONT.display,
    fontSize: '0.65rem',
    letterSpacing: '0.1em',
    cursor: 'pointer',
  },
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 10,
    display: 'flex',
    flexDirection: 'column',
    background: COLOR.surface,
  },
  overlayHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.5rem 0.7rem',
    background: COLOR.surfaceLowest,
    borderBottom: `1px solid ${COLOR.border}`,
  },
  overlayTitle: {
    margin: 0,
    fontFamily: FONT.display,
    fontSize: '0.8rem',
    letterSpacing: '0.16em',
    color: COLOR.accentText,
  },
  close: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    background: 'transparent',
    color: COLOR.text,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 4,
    cursor: 'pointer',
  },
  overlayBody: { flex: 1, overflowY: 'auto', padding: '0.7rem 0.6rem 2rem' },
  unlock: {
    minHeight: TOUCH_MIN,
    padding: '0 0.9rem',
    background: 'transparent',
    color: COLOR.accentText,
    border: `1px solid ${COLOR.accent}`,
    borderRadius: 4,
    fontFamily: FONT.mono,
    fontSize: '0.75rem',
    cursor: 'pointer',
  },
  // The panels scroll; the header and the keyboard do not, so the keys are always under
  // a thumb no matter how far down a tab runs.
  main: { flex: 1, overflowY: 'auto', minHeight: 0 },
  footer: {
    background: COLOR.surfaceLowest,
    borderTop: `1px solid ${COLOR.border}`,
    padding: '0.4rem 0.5rem 0.6rem',
  },
  velocity: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontFamily: FONT.mono,
    fontSize: '0.7rem',
    color: COLOR.textDim,
    marginBottom: '0.4rem',
  },
  velocityTrack: { flex: 1, height: TOUCH_MIN / 2, touchAction: 'none', accentColor: COLOR.accent },
  velocityValue: { fontVariantNumeric: 'tabular-nums', minWidth: '2.5rem', textAlign: 'center' },
  octave: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN / 1.4,
    background: 'transparent',
    color: COLOR.text,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 4,
    fontSize: '1rem',
    cursor: 'pointer',
  },
} as const satisfies Record<string, React.CSSProperties>;
