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
 * **The selected channel is surface state, and it is the subject of every edit (C5c).**
 * A channel is a song track; which one is being edited is not — it is where the player is
 * looking, so it lives here and is remembered in localStorage as a convenience, never as
 * truth. Everything downstream is unchanged by it: the panels are handed a state whose
 * `patch` IS that channel's sound (`stateForChannel`), and every voice-scoped command
 * leaves here carrying the channel's id. FX and master stay shared until C7, so their
 * addresses go out bare — the same rule the reducer refuses on, read from one function
 * (`isChannelPath`) so a knob can never send what the reducer would refuse.
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
import { channelKind, isChannelPath, resolveChannel, stateForChannel } from '../../core/channels';
import { PARAM_SPECS } from '../../core/schemas';
import { WIRED_MOD_DESTINATIONS, type ParamPath, type ParamValue } from '../../core/types';
import type { SynthCommand } from '../../core/commands';
import { SynthPanels } from './SynthPanels';
import { ChannelBar } from './ChannelBar';
import { KickPanel } from './KickPanel';
import { SeqView } from './roll/SeqView';
import { RouteList } from './RouteList';
import { LibrarySheet } from './LibrarySheet';
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

/**
 * Which whole commands carry the selected channel. Exactly the patch verbs core accepts a
 * `trackId` on, minus the two that are about the LIBRARY rather than about a sound:
 * `importPreset` puts a document in the library and `deletePreset` takes one out, and
 * neither belongs to a channel.
 */
const CHANNEL_COMMANDS = new Set<SynthCommand['type']>([
  'loadPreset',
  'savePreset',
  'addOscillator',
  'removeOscillator',
  'addLfo',
  'removeLfo',
  'addRoute',
  'removeRoute',
]);

/** Where the selected channel is remembered. A convenience, never a source of truth. */
const CHANNEL_KEY = 'sag.synth.channel';

function readRemembered(): string | null {
  try {
    return localStorage.getItem(CHANNEL_KEY);
  } catch {
    // Private mode, or storage disabled — the surface just starts on the first channel.
    return null;
  }
}

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
  const [libraryOpen, setLibraryOpen] = useState(false);

  /**
   * Which view fills the middle: the synth's panels or the sequencer. A view switch, not a
   * surface: surfaces reload the page, and the loop must keep playing while you go and
   * turn the cutoff under it.
   */
  const [view, setView] = useState<'synth' | 'seq'>('synth');

  /**
   * Which channel is being edited. Remembered across launches, but never trusted: a
   * remembered id whose track is gone (deleted, or a different song restored) falls back to
   * the first synth channel rather than leaving the surface pointing at nothing.
   */
  const [remembered, setRemembered] = useState<string | null>(() => readRemembered());
  const selectChannel = useCallback((trackId: string) => {
    setRemembered(trackId);
    try {
      localStorage.setItem(CHANNEL_KEY, trackId);
    } catch {
      // Private mode, or storage disabled. The selection still works for this session.
    }
  }, []);
  const getPlayhead = useCallback(() => runtime.getPlayhead(), [runtime]);

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

  /**
   * The channel every edit and every played note is aimed at, as a ref so the dispatch
   * callbacks need not be rebuilt on every selection change — and so a callback captured by
   * a control mid-gesture still reads the channel that was selected when it started.
   *
   * `undefined` means "the live patch": no channel selected, or a kick channel is, which
   * has no synth patch for a voice address to land on.
   */
  const editTarget = useRef<string | undefined>(undefined);

  useEffect(
    () =>
      dispatcher.subscribe(() => {
        setState(dispatcher.getState());
        // From the pool the keys are actually playing into. Since C5a a note carrying a
        // `trackId` is held in that CHANNEL's pool, not the live patch's — so reading the
        // live one here left every key unlit the moment C5c started aiming the keyboard at
        // a channel. The keys made sound and looked dead.
        const transient = dispatcher.getTransient();
        const target = editTarget.current;
        const pool = target === undefined ? transient : transient.channels.get(target);
        setHeld(new Set(pool === undefined ? [] : pool.heldNotes.keys()));
      }),
    [dispatcher],
  );

  // Polled from the context rather than tracked as a flag we set ourselves: `resume()`
  // resolves whether or not the browser honoured it, and Android re-suspends whenever the
  // tab is backgrounded. A flag would say "running" with no way back.
  useEffect(() => {
    const timer = setInterval(() => {
      // Same string twice is a React bail-out, so this renders only on a real change. The
      // level used to be set here too, and changed on every poll while sound played — four
      // whole-app renders a second, on the main thread the transport's clock runs on.
      setContextState(runtime.getContextState());
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
    coalescer.current = createParamCoalescer((path, value, trackId) => {
      dispatcher.dispatch({ type: 'setParam', path, value, ...(trackId === undefined ? {} : { trackId }) });
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

  /**
   * A voice address is written to the selected channel; an FX or master address is written
   * to the shared bus. The coalescer is told which, so a drag still in flight when the
   * player switches channel lands where it was dragged.
   */
  const onChange = useCallback(
    (path: ParamPath, value: ParamValue) => {
      const target = isChannelPath(path) ? editTarget.current : undefined;
      coalescer.current?.change(path, value, target);
    },
    [],
  );

  /**
   * The same rule for whole commands. Only the verbs core accepts a `trackId` on are
   * aimed — read from `CHANNEL_COMMANDS` rather than decided at each call site, because a
   * verb aimed at a channel that cannot take one is a refusal the player would see as a
   * dead button.
   */
  const onCommand = useCallback(
    (command: SynthCommand) => {
      const aimed =
        CHANNEL_COMMANDS.has(command.type) && editTarget.current !== undefined
          ? { ...command, trackId: editTarget.current }
          : command;
      return dispatcher.dispatch(aimed as SynthCommand);
    },
    [dispatcher],
  );

  /** Commands that must reach the engine as they are — the channel bar's own verbs. */
  const onSongCommand = useCallback(
    (command: SynthCommand) => dispatcher.dispatch(command),
    [dispatcher],
  );

  const noteOn = useCallback(
    (note: string) =>
      dispatcher.dispatch({
        type: 'noteOn',
        note,
        velocity,
        ...(editTarget.current === undefined ? {} : { trackId: editTarget.current }),
      }),
    [dispatcher, velocity],
  );
  const noteOff = useCallback(
    (note: string) =>
      dispatcher.dispatch({
        type: 'noteOff',
        note,
        ...(editTarget.current === undefined ? {} : { trackId: editTarget.current }),
      }),
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

  const channel = resolveChannel(state, remembered);
  const channelId = channel?.id ?? null;
  const onKick = channel !== undefined && channelKind(channel) === 'kick';
  /** What the panels read: the same state, with the selected channel's sound as `patch`. */
  const channelState = stateForChannel(state, onKick ? null : channelId);
  // Assigned during render, read by the dispatch callbacks: they are stable across renders
  // on purpose, so the current selection reaches them through the ref rather than by
  // rebuilding every control's handler each time the player taps a different chip.
  editTarget.current = onKick || channelId === null ? undefined : channelId;

  const running = contextState === 'running';

  // Read through `getParam` rather than reached for by hand: the pad's Y target is chosen
  // at runtime, so there is no field on `state.patch` this could name.
  const padYValue = getParam(state, padTarget);
  const padY = typeof padYValue === 'number' ? padYValue : 0;

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <span style={styles.logo}>SAG</span>
        {/* The patch name opens the library (C3b) — where every synth puts its browser. */}
        {/*
          * The sound of the selected channel, and the way into the library.
          *
          * On a KICK channel it is neither: a kick has no `presetSnapshot`, so a preset
          * loaded here would have landed on the live patch instead — a sound changing
          * somewhere the player is not looking. Disabled, and it says why.
          */}
        <button
          type="button"
          disabled={onKick}
          onClick={() => setLibraryOpen(true)}
          style={{ ...styles.patchButton, ...(onKick ? styles.patchButtonOff : null) }}
          aria-label={
            onKick
              ? `${channel?.name ?? 'kick'} — a kick channel has no sound to load`
              : `${channelState.patch.name} — open the library`
          }
        >
          {onKick ? channel?.name : channelState.patch.name}
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={view === 'seq'}
          onClick={() => setView((current) => (current === 'seq' ? 'synth' : 'seq'))}
          style={{ ...styles.bay, color: view === 'seq' ? COLOR.accentText : COLOR.textDim }}
          aria-label={view === 'seq' ? 'show the synth panels' : 'show the sequencer'}
        >
          {view === 'seq' ? 'SYNTH' : 'SEQ'}
        </button>
        <button
          type="button"
          onClick={() => setBayOpen(true)}
          style={styles.bay}
          aria-label="open the routing bay"
        >
          MOD
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

      <ChannelBar
        tracks={state.song.tracks}
        selectedId={channelId}
        onSelect={selectChannel}
        onCommand={onSongCommand}
        startingPresetId={channelState.patch.id}
        trailing={<LevelReadout runtime={runtime} running={running} />}
      />

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

      <main style={view === 'seq' ? styles.seqMain : styles.main}>
        {view === 'seq' ? (
          <SeqView
            state={state}
            dispatch={onSongCommand}
            getPlayhead={getPlayhead}
            unlock={unlock}
            channelId={channelId}
          />
        ) : onKick && channel !== undefined ? (
          <KickPanel track={channel} onCommand={onSongCommand} />
        ) : (
          <SynthPanels state={channelState} onChange={onChange} onCommand={onCommand} />
        )}
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
              context={surfaceContext(channelState, onChange)}
              onCommand={onCommand}
            />
          </div>
        </div>
      )}

      {libraryOpen && (
        <div style={styles.overlay} role="dialog" aria-modal="true" aria-label="library">
          <header style={styles.overlayHead}>
            <h2 style={styles.overlayTitle}>LIBRARY</h2>
            <button
              type="button"
              onClick={() => setLibraryOpen(false)}
              style={styles.close}
              aria-label="close the library"
            >
              ✕
            </button>
          </header>
          <div style={styles.overlayBody}>
            <LibrarySheet state={channelState} onCommand={onCommand} />
          </div>
        </div>
      )}

      {/* The roll needs the height; its own keys column auditions, so the keyboard waits. */}
      {view === 'synth' && !onKick && <footer style={styles.footer}>
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
      </footer>}
    </div>
  );
}

/**
 * Output level in dB, polled — the only honest answer to "is it making a sound".
 *
 * Its own component with its own timer, so the four updates a second re-render one span and
 * not the instrument. While the sequencer plays nothing else re-renders at all (the pump
 * dispatches nothing per note), which is the point: a render is main-thread time, and the
 * Transport's tick callback runs on the main thread (`pump-stats.ts`).
 */
function LevelReadout({ runtime, running }: { runtime: { getLevel(): number }; running: boolean }) {
  const [level, setLevel] = useState(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const next = runtime.getLevel();
      // Whole-dB steps are all the readout shows; don't render for a sub-dB wobble.
      setLevel((previous) => (Math.round(previous) === Math.round(next) ? previous : next));
    }, 250);
    return () => clearInterval(timer);
  }, [runtime, running]);
  return (
    <span style={styles.level} aria-label="output level">
      {running ? (Number.isFinite(level) ? `${level.toFixed(0)} dB` : '−∞') : '—'}
    </span>
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
  patchButton: {
    flex: 1,
    minWidth: 0,
    minHeight: TOUCH_MIN,
    padding: '0 0.4rem',
    background: 'transparent',
    border: 'none',
    borderBottom: `1px dashed ${COLOR.border}`,
    color: COLOR.text,
    fontSize: '0.75rem',
    textAlign: 'left',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  patchButtonOff: { opacity: 0.5, cursor: 'default', borderBottomStyle: 'none' },
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
  seqMain: { flex: 1, minHeight: 0, overflow: 'hidden' },
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
