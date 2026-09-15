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
 * The header is deliberately thin. The bay button is here because the bay is; the patch
 * stepper is not, because it needs the preset browser and drawing it now would be a
 * control that does nothing.
 *
 * The footer offers two play surfaces over the same three commands. `VirtualKeyboard`
 * sends discrete notes; `XYPad` sends a note plus a detune, so a press between two keys
 * sounds between two keys. Neither needs anything the engine does not already take.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getEngine } from '../engine';
import { useAudioObservation } from '../use-audio-observation';
import { VirtualKeyboard } from '../debug/VirtualKeyboard';
import { controlForPath, fullNameOf } from '../../core/controls';
import { getParam } from '../../core/params';
import { PARAM_SPECS } from '../../core/schemas';
import { WIRED_MOD_DESTINATIONS, type ParamPath, type ParamValue } from '../../core/types';
import type { SynthCommand } from '../../core/commands';
import { SynthPanels } from './SynthPanels';
import { RouteList } from './RouteList';
import { XYPad } from './XYPad';
import { surfaceContext } from './controlProps';
import { createParamCoalescer, type ParamCoalescer } from './param-coalescer';
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

/**
 * What the pad's Y axis may be pointed at: every wired destination that is a plain number.
 *
 * Generated rather than listed. Offering an UNWIRED destination here would be a Y axis that
 * moves a validated, journalled value reaching no audio node — a slider that does nothing,
 * which is the failure the whole surface is armoured against. `isDestinationWired` already
 * knows which are which, so this cannot drift when the runtime wires more of them.
 */
const PAD_Y_TARGETS: readonly ParamPath[] = WIRED_MOD_DESTINATIONS.filter(
  (path) => PARAM_SPECS[path]?.kind === 'number',
);

/** The pad's detune is written to the oscillators, so it obeys their declared range. */
const DETUNE_SPEC = PARAM_SPECS['voice.oscillators.0.detune'];

export function SynthApp() {
  const { dispatcher, runtime, observer, instanceId } = getEngine();

  // The instrument reports too, not just the debug wall. This surface is the one being
  // played when the question is "is it crackling on the phone", and it emitted nothing
  // at all until now -- so render_capacity and underrun_ratio, which exist precisely to
  // answer that, had never produced a reading on a device.
  useAudioObservation(runtime, observer, instanceId);

  const [state, setState] = useState(() => dispatcher.getState());
  const [contextState, setContextState] = useState(() => runtime.getContextState());
  /**
   * Why the unlock did not take, when it did not.
   *
   * `Tone.start()` resolving is not evidence the browser honoured it, and a rejection here
   * was swallowed entirely in the first version of this file — so a refused resume looked
   * exactly like a working one, which is the same silent-failure the debug wall was taught
   * to report and this surface then had to learn again.
   */
  const [unlockError, setUnlockError] = useState('');
  /** Output level in dB, polled. The only honest answer to "is it making a sound". */
  const [level, setLevel] = useState(Number.NEGATIVE_INFINITY);
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

  /** Which play surface the footer shows, and what the pad's Y axis drives. */
  const [padMode, setPadMode] = useState(false);
  const [padTarget, setPadTarget] = useState<ParamPath>(
    () => PAD_Y_TARGETS[0] ?? 'voice.amplitude',
  );

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
    const timer = setInterval(() => {
      setContextState(runtime.getContextState());
      setLevel(runtime.getLevel());
    }, 250);
    return () => clearInterval(timer);
  }, [runtime]);

  const unlock = useCallback(async () => {
    try {
      await dispatcher.unlock();
      const state = runtime.getContextState();
      setContextState(state);
      setUnlockError(state === 'running' ? '' : `resume() returned but the context is "${state}"`);
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : String(error));
    }
  }, [dispatcher, runtime]);

  /**
   * Every parameter change in the instrument funnels through here — knobs, sliders, the
   * XY pad, the envelope handles, the routing bay — which is why the coalescer sits at
   * this one point rather than inside each control.
   *
   * A ref, not state: it must survive re-renders without being rebuilt, or a drag would
   * lose its pending value every time the value it is changing re-renders the app.
   */
  const coalescer = useRef<ParamCoalescer | null>(null);
  if (coalescer.current === null) {
    coalescer.current = createParamCoalescer((path, value) => {
      dispatcher.dispatch({ type: 'setParam', path, value });
    });
  }

  // `requestAnimationFrame` does not fire in a hidden tab, so a value left pending when
  // the phone locks or the player switches away would sit there until they came back.
  useEffect(() => {
    const flush = (): void => coalescer.current?.flush();
    document.addEventListener('visibilitychange', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      flush();
    };
  }, []);

  const onChange = useCallback((path: ParamPath, value: ParamValue) => {
    coalescer.current?.change(path, value);
  }, []);

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

  /**
   * The pad's gesture: which note is sounding, and what the patch's detune was before the
   * finger touched it.
   *
   * A ref rather than state because it changes on every pointermove and nothing renders
   * from it — putting it in state would re-render the whole app at pointer rate.
   */
  const padGesture = useRef<{ note: string; baseDetune: readonly number[]; sent: number } | null>(
    null,
  );

  /**
   * Fires on press AND on every move while held, so it must diff.
   *
   * Two things would go wrong without the diff. A `noteOn` per move stacks voices until the
   * polyphony cap evicts them, which sounds like a stuck chord; and a `setParam` per move
   * fills the journal with thousands of identical writes.
   *
   * The detune is written to every oscillator slot — that is what "continuous pitch" means
   * against this contract, since `voice.oscillators.N.detune` is the wired address for it.
   * It is an OFFSET from whatever the patch already had, and the base is restored on
   * release: playing an instrument must not quietly rewrite the patch you are playing.
   */
  const onPadPitch = useCallback(
    (note: string, detuneCents: number) => {
      const slots = dispatcher.getState().patch.voice.oscillators;
      let active = padGesture.current;

      if (active === null) {
        active = { note, baseDetune: slots.map((slot) => slot.detune), sent: Number.NaN };
        padGesture.current = active;
        dispatcher.dispatch({ type: 'noteOn', note, velocity });
      } else if (active.note !== note) {
        dispatcher.dispatch({ type: 'noteOff', note: active.note });
        dispatcher.dispatch({ type: 'noteOn', note, velocity });
        active.note = note;
      }

      if (DETUNE_SPEC.kind !== 'number') return;
      const rounded = Math.round(detuneCents);
      // Detune is an integer spec, so most moves land on the value already sent.
      if (rounded === active.sent) return;
      active.sent = rounded;

      slots.forEach((_slot, index) => {
        const base = active.baseDetune[index] ?? 0;
        const value = Math.min(DETUNE_SPEC.max, Math.max(DETUNE_SPEC.min, base + rounded));
        dispatcher.dispatch({
          type: 'setParam',
          path: `voice.oscillators.${index}.detune` as ParamPath,
          value,
        });
      });
    },
    [dispatcher, velocity],
  );

  const onPadRelease = useCallback(
    (note: string) => {
      const active = padGesture.current;
      padGesture.current = null;
      dispatcher.dispatch({ type: 'noteOff', note });

      // Put the patch back exactly as it was found.
      active?.baseDetune.forEach((base, index) => {
        dispatcher.dispatch({
          type: 'setParam',
          path: `voice.oscillators.${index}.detune` as ParamPath,
          value: base,
        });
      });
    },
    [dispatcher],
  );

  const running = contextState === 'running';

  // Read through `getParam` rather than reached for by hand: the pad's Y target is chosen
  // at runtime, so there is no field on `state.patch` this could name.
  const padYValue = getParam(state, padTarget);
  const padY = typeof padYValue === 'number' ? padYValue : 0;

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <span style={styles.logo}>SAG</span>
        <span style={styles.patch}>{state.patch.name}</span>
        <span style={styles.level} aria-label="output level">
          {running ? (Number.isFinite(level) ? `${level.toFixed(0)} dB` : '−∞') : '—'}
        </span>
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
          // Not "start audio" — the banner owns that job now, and two controls answering
          // to one name is ambiguous for a screen reader and for a test.
          aria-label="audio status" 
        >
          {running ? '● live' : '▶ start'}
        </button>
      </header>

      {!running && (
        /*
         * A banner, not a corner button. Android suspends the context whenever the tab is
         * backgrounded, so this state is reached constantly and silently — and a synth
         * that makes no sound for a reason it never states is the exact failure this
         * project keeps shipping, arriving through the one path no gate can see.
         */
        <button type="button" onClick={unlock} style={styles.banner} aria-label="start audio">
          <strong>▶ tap to start audio</strong>
          <span style={styles.bannerNote}>
            {unlockError === ''
              ? `the audio context is ${contextState} — Android suspends it whenever the tab loses focus`
              : unlockError}
          </span>
        </button>
      )}

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
            role="switch"
            aria-checked={padMode}
            onClick={() => setPadMode((on) => !on)}
            style={styles.octave}
            aria-label="glide pad"
          >
            {padMode ? 'PAD' : 'KEYS'}
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
        {keysOpen && !padMode && (
          <VirtualKeyboard
            octave={octave}
            held={held}
            onNoteOn={noteOn}
            onNoteOff={noteOff}
          />
        )}
        {keysOpen && padMode && (
          <div style={styles.pad}>
            <label style={styles.padTarget}>
              <span>Y</span>
              <select
                value={padTarget}
                onChange={(event) => setPadTarget(event.target.value as ParamPath)}
                aria-label="what the pad's vertical axis drives"
                style={styles.padSelect}
              >
                {PAD_Y_TARGETS.map((path) => {
                  const control = controlForPath(path);
                  return (
                    <option key={path} value={path}>
                      {control === undefined ? path : fullNameOf(control)}
                    </option>
                  );
                })}
              </select>
            </label>
            <XYPad
              octave={octave}
              yTarget={padTarget}
              yValue={padY}
              onPitch={onPadPitch}
              onRelease={onPadRelease}
              onChange={onChange}
            />
          </div>
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
  level: {
    fontFamily: FONT.mono,
    fontSize: '0.7rem',
    color: COLOR.accentText,
    minWidth: '3.2rem',
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  },
  banner: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.2rem',
    width: '100%',
    padding: '0.7rem',
    background: COLOR.accentDim,
    color: COLOR.accentText,
    border: 'none',
    borderBottom: `1px solid ${COLOR.accent}`,
    fontFamily: FONT.display,
    fontSize: '0.85rem',
    textAlign: 'left',
    cursor: 'pointer',
  },
  bannerNote: { fontSize: '0.65rem', opacity: 0.85 },
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
  pad: { display: 'flex', flexDirection: 'column', gap: '0.35rem', padding: '0 0.5rem 0.5rem' },
  padTarget: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    fontFamily: FONT.display,
    fontSize: '0.65rem',
    letterSpacing: '0.08em',
    color: COLOR.textDim,
  },
  padSelect: {
    flex: 1,
    minWidth: 0,
    minHeight: TOUCH_MIN,
    background: COLOR.surfaceLowest,
    color: COLOR.text,
    borderStyle: 'solid',
    borderWidth: 1,
    borderColor: COLOR.border,
    borderRadius: 4,
    fontFamily: FONT.mono,
    fontSize: '0.75rem',
  },
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
