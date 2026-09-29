/**
 * src/clients/synth/roll/SeqView.tsx — the SEQ view: transport, piano roll, kick row, PSY.
 *
 * The one place the pattern editor meets the song. `PianoRoll` edits a note list; this file
 * decides WHICH note list (the first pitched track, and the first drum track for the kick
 * row) and turns every edit into the command that says it — `addNote`, `updateNote`,
 * `removeNote`, `setTrackNotes`. Nothing here touches the runtime: the transport is driven
 * by `play`/`stop`/`seek` commands like any other client would send, so the journal records
 * a session exactly as an agent over the bridge would have produced it.
 *
 * Lives beside the synth panels in `SynthApp`, not behind a `#surface`: switching surfaces
 * reloads the page (`main.tsx`), and a loop that stopped every time you went to turn the
 * cutoff would be a sequencer you could not sound-design with.
 *
 * Landscape is the roll's shape (see `PianoRoll`). In portrait the view keeps the transport
 * and the PSY sheet, and asks for the phone to be turned for the grid itself.
 *
 * WAV (C3c) is the one exception to "nothing here touches the runtime": it renders a COPY of
 * the song offline (`export-wav.ts`) — no journal row, because nothing about the session
 * changes, and no live node is touched.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { SynthCommand } from '../../../core/commands';
import type { EngineState } from '../../../core/state';
import { PSY_ROLL_PRESET_ID } from '../../../core/state';
import { psyPattern, type PsyStyle } from '../../../core/patterns/psy';
import type { Beats, KickConfig, NoteName, SongTrack } from '../../../core/types';
import { LIMITS } from '../../../core/types';
import { COLOR, FONT, TOUCH_MIN } from '../tokens';
import { PianoRoll, type RollTool } from './PianoRoll';
import { GRIDS, type GridName } from './roll-geometry';
import { exportWav as defaultExportWav, type WavExportResult } from './export-wav';
import { exportPlan } from '../../../core/export';

export interface SeqViewProps {
  state: EngineState;
  dispatch: (command: SynthCommand) => unknown;
  /** Transport position in beats, from the runtime readout. */
  getPlayhead: () => Beats;
  /** The gesture unlock; play must be pressed from a user gesture on Android. */
  unlock: () => Promise<void>;
  /** Id minting is the client's job — core never mints (types.ts, `NoteEvent.noteId`). */
  mintId?: () => string;
  /**
   * The channel being edited (C5d). The roll draws and writes ITS notes; every other synth
   * channel's notes are drawn behind as ghosts. A kick channel, an unknown id or nothing
   * selected falls back to the first pitched track, which is what this view did before
   * channels existed.
   */
  channelId?: string | null;
  /** Override the orientation media query. Tests pin it; the app leaves it unset. */
  orientation?: 'landscape' | 'portrait';
  /** The WAV export. Tests pass a stand-in; the app uses the real render. */
  exportWav?: (state: EngineState, loops: number) => Promise<WavExportResult>;
}

/** A psytrance kick tuned to the bass: ~2 octaves of fall, a 220 ms body. Ear-tunable. */
export function defaultKick(tune: NoteName): KickConfig {
  return { tune, punch: 3, pitchDecay: 0.03, decay: 0.22, level: 0 };
}

const PSY_ROOTS: readonly NoteName[] = ['E1', 'F1', 'F#1', 'G1', 'G#1', 'A1'];
const DUCK = { depthDb: 3, attackMs: 1, releaseMs: 60 };
const AUDITION_MS = 180;

function defaultMint(): string {
  return `n-${crypto.randomUUID().slice(0, 8)}`;
}

function useOrientation(forced: SeqViewProps['orientation']): 'landscape' | 'portrait' {
  const query = '(orientation: portrait)';
  const read = (): 'landscape' | 'portrait' =>
    typeof matchMedia === 'function' && matchMedia(query).matches ? 'portrait' : 'landscape';
  const [value, setValue] = useState(read);
  useEffect(() => {
    if (forced !== undefined || typeof matchMedia !== 'function') return;
    const list = matchMedia(query);
    const update = (): void => setValue(list.matches ? 'portrait' : 'landscape');
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [forced]);
  return forced ?? value;
}

/** Memoised for the same reason as `SynthPanels`: unrelated app state must not redraw the roll. */
export const SeqView = memo(function SeqView({
  state,
  dispatch,
  getPlayhead,
  unlock,
  mintId = defaultMint,
  channelId = null,
  orientation,
  exportWav = defaultExportWav,
}: SeqViewProps) {
  const layout = useOrientation(orientation);
  const { song } = state;
  const beatsPerBar = song.timeSignature;
  const selected = song.tracks.find((track) => track.id === channelId);
  const bass: SongTrack | undefined =
    selected !== undefined && selected.isDrum !== true
      ? selected
      : song.tracks.find((track) => track.isDrum !== true);
  /**
   * Every other synth channel's notes, in one list. Drawn dim and untouchable by the roll:
   * a psy bass is written against the line it has to dodge, and a roll that shows one
   * channel at a time cannot show that.
   */
  const ghostNotes = useMemo(
    () =>
      song.tracks
        .filter((track) => track.isDrum !== true && track.id !== bass?.id)
        .flatMap((track) => track.notes),
    [song.tracks, bass?.id],
  );
  const kick: SongTrack | undefined =
    song.tracks.find((track) => track.kick !== undefined) ?? song.tracks.find((track) => track.isDrum === true);

  const bars = song.loop.enabled ? Math.max(1, Math.round((song.loop.end - song.loop.start) / beatsPerBar)) : 1;
  const length = bars * beatsPerBar;

  const [gridName, setGridName] = useState<GridName>('1/16');
  const [tool, setTool] = useState<RollTool>('pencil');
  const [velocity] = useState(1);
  const [psyOpen, setPsyOpen] = useState(false);
  const [wavOpen, setWavOpen] = useState(false);

  const playing = state.transport.status === 'playing';
  const playhead = useCallback(
    () => (state.transport.status === 'stopped' ? null : getPlayhead()),
    [state.transport.status, getPlayhead],
  );

  const setBars = (count: number): void => {
    dispatch({ type: 'setLoop', enabled: true, start: 0, end: count * beatsPerBar });
  };

  const play = async (): Promise<void> => {
    await unlock();
    // The view shows a loop, so it plays one: a song that was never given a loop region
    // gets the one on screen rather than running off the end of the pattern.
    if (!song.loop.enabled) dispatch({ type: 'setLoop', enabled: true, start: 0, end: length });
    if (!playing) dispatch({ type: 'play' });
  };

  const stop = (): void => {
    dispatch({ type: 'stop' });
  };

  const setTempo = (bpm: number): void => {
    const clamped = Math.min(LIMITS.bpm.max, Math.max(LIMITS.bpm.min, Math.round(bpm)));
    if (clamped !== song.bpm) dispatch({ type: 'setTempo', bpm: clamped });
  };

  /** Auditioning plays the CHANNEL being edited, not whatever the live patch happens to be. */
  const audition = useCallback(
    (note: NoteName) => {
      const channel = bass === undefined ? {} : { trackId: bass.id };
      dispatch({ type: 'noteOn', note, velocity: 0.8, ...channel });
      setTimeout(() => dispatch({ type: 'noteOff', note, ...channel }), AUDITION_MS);
    },
    [dispatch, bass],
  );

  /** The kick track, created and given a kick voice if the song has none yet. */
  const ensureKick = (tune: NoteName): string => {
    if (kick !== undefined) {
      if (kick.kick === undefined) dispatch({ type: 'setTrackKick', trackId: kick.id, kick: defaultKick(tune) });
      return kick.id;
    }
    const trackId = `kick-${mintId()}`;
    dispatch({ type: 'addTrack', trackId, name: 'Kick' });
    dispatch({ type: 'setTrackKick', trackId, kick: defaultKick(tune) });
    return trackId;
  };

  const toggleKick = (beat: Beats): void => {
    const trackId = ensureKick(kick?.kick?.tune ?? 'G1');
    const existing = kick?.notes.find((hit) => Math.abs(hit.time - beat) < 1e-6);
    if (existing !== undefined) {
      dispatch({ type: 'removeNote', trackId, noteId: existing.noteId });
      return;
    }
    dispatch({
      type: 'addNote',
      trackId,
      note: { noteId: mintId(), time: beat, duration: 0.25, note: 'C3', velocity: 1 },
    });
  };

  const ducked = bass?.duck !== undefined;
  const toggleDuck = (): void => {
    if (bass === undefined) return;
    if (ducked) {
      dispatch({ type: 'setTrackDuck', trackId: bass.id, duck: null });
      return;
    }
    const sourceTrackId = ensureKick(kick?.kick?.tune ?? 'G1');
    dispatch({ type: 'setTrackDuck', trackId: bass.id, duck: { sourceTrackId, ...DUCK } });
  };

  // Kept in portrait too (C5d): the kick is what the bass is written around, so hiding it
  // to buy an octave of pitch range would cost the thing the roll is being read for.
  const drumLane = useMemo(
    () => ({ label: 'KICK', notes: kick?.notes ?? [], onToggle: toggleKick }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kick, layout, bass],
  );

  const transport = (
    <div style={styles.bar} role="toolbar" aria-label="transport">
      <button type="button" onClick={() => void play()} style={button(playing)} aria-label="play" aria-pressed={playing}>
        ▶
      </button>
      <button type="button" onClick={stop} style={button(false)} aria-label="stop">
        ■
      </button>
      <div style={styles.group}>
        <button type="button" onClick={() => setTempo(song.bpm - 1)} style={button(false)} aria-label="tempo down">
          −
        </button>
        <span style={styles.readout} aria-label="tempo">
          {song.bpm} BPM
        </span>
        <button type="button" onClick={() => setTempo(song.bpm + 1)} style={button(false)} aria-label="tempo up">
          +
        </button>
      </div>
      <div style={styles.group} role="radiogroup" aria-label="loop length">
        {[1, 2, 4].map((count) => (
          <button
            key={count}
            type="button"
            role="radio"
            aria-checked={bars === count}
            onClick={() => setBars(count)}
            style={button(bars === count)}
          >
            {count} BAR
          </button>
        ))}
      </div>
      {layout === 'landscape' && (
        <>
          <select
            value={gridName}
            onChange={(event) => setGridName(event.target.value as GridName)}
            style={styles.select}
            aria-label="snap"
          >
            {(Object.keys(GRIDS) as GridName[]).map((name) => (
              <option key={name} value={name}>
                {name === 'off' ? 'free' : name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setTool((current) => (current === 'pencil' ? 'eraser' : 'pencil'))}
            style={button(tool === 'eraser')}
            aria-label={tool === 'pencil' ? 'pencil tool — switch to eraser' : 'eraser tool — switch to pencil'}
          >
            {tool === 'pencil' ? '✎' : '⌫'}
          </button>
        </>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={ducked}
        onClick={toggleDuck}
        style={button(ducked)}
        aria-label="duck the bass on the kick"
        disabled={bass === undefined}
      >
        DUCK
      </button>
      <button type="button" onClick={() => setPsyOpen(true)} style={button(false)} aria-label="write a psytrance pattern">
        PSY
      </button>
      <button type="button" onClick={() => setWavOpen(true)} style={button(false)} aria-label="export a wav file">
        WAV
      </button>
    </div>
  );

  return (
    <div style={styles.root}>
      {transport}
      {bass !== undefined ? (
        <div style={styles.roll}>
          <PianoRoll
            notes={bass.notes}
            length={length}
            beatsPerBar={beatsPerBar}
            grid={GRIDS[gridName]}
            tool={tool}
            velocity={velocity}
            mintId={mintId}
            onAdd={(note) => dispatch({ type: 'addNote', trackId: bass.id, note })}
            onUpdate={(noteId, patch) => dispatch({ type: 'updateNote', trackId: bass.id, noteId, patch })}
            onRemove={(noteId) => dispatch({ type: 'removeNote', trackId: bass.id, noteId })}
            onSetNotes={(notes) => dispatch({ type: 'setTrackNotes', trackId: bass.id, notes })}
            onAudition={audition}
            onSeek={(beat) => dispatch({ type: 'seek', position: beat })}
            getPlayhead={playhead}
            drumLane={drumLane}
            ghostNotes={ghostNotes}
          />
        </div>
      ) : (
        <div style={styles.portrait}>
          <p>This song has no synth channel to edit. Add one with + on the channel bar.</p>
          <p style={styles.summary}>
            {kick?.notes.length ?? 0} kicks · {bars} bar{bars === 1 ? '' : 's'}
          </p>
        </div>
      )}
      {wavOpen && <WavSheet state={state} exportWav={exportWav} onClose={() => setWavOpen(false)} />}
      {psyOpen && (
        <PsySheet
          onClose={() => setPsyOpen(false)}
          onWrite={(options) => {
            setPsyOpen(false);
            writePsy(options);
          }}
        />
      )}
    </div>
  );

  function writePsy(options: PsyOptions): void {
    if (bass === undefined) return;
    const prefix = mintId();
    const pattern = psyPattern({
      idPrefix: prefix,
      root: options.root,
      style: options.style,
      bars: options.bars,
      beatsPerBar,
    });
    if (options.tempo) dispatch({ type: 'setTempo', bpm: 145 });
    // Onto the CHANNEL. Without the trackId this loaded the psy sound into the live patch,
    // which after C5b is not what the sequencer plays — the pattern would have arrived in
    // whatever sound the channel already had.
    if (options.sound) dispatch({ type: 'loadPreset', presetId: PSY_ROLL_PRESET_ID, trackId: bass.id });
    const kickId = ensureKick(options.root);
    // Retune an existing kick to the new key: a kick in the bass's key is the recipe.
    if (kick?.kick !== undefined && kick.kick.tune !== options.root) {
      dispatch({ type: 'setTrackKick', trackId: kickId, kick: { ...kick.kick, tune: options.root } });
    }
    dispatch({ type: 'setTrackNotes', trackId: bass.id, notes: pattern.bass });
    dispatch({ type: 'setTrackNotes', trackId: kickId, notes: pattern.kick });
    dispatch({ type: 'setTrackDuck', trackId: bass.id, duck: { sourceTrackId: kickId, ...DUCK } });
    dispatch({ type: 'setLoop', enabled: true, start: 0, end: pattern.length });
  }
});

interface PsyOptions {
  root: NoteName;
  style: PsyStyle;
  bars: number;
  tempo: boolean;
  sound: boolean;
}

function PsySheet({ onClose, onWrite }: { onClose: () => void; onWrite: (options: PsyOptions) => void }) {
  const [options, setOptions] = useState<PsyOptions>({ root: 'G1', style: 'roll', bars: 1, tempo: true, sound: true });
  const set = <K extends keyof PsyOptions>(key: K, value: PsyOptions[K]): void =>
    setOptions((current) => ({ ...current, [key]: value }));

  return (
    <div style={styles.sheet} role="dialog" aria-modal="true" aria-label="psytrance pattern">
      <h2 style={styles.sheetTitle}>PSY PATTERN</h2>
      <p style={styles.sheetNote}>
        Kick on every beat, bass in the gaps. Roll is K B B B, gallop is K · B B. The first note after each
        kick is 30% softer. Writing replaces the selected channel's notes and the kick's. Undo
        brings back what was there.
      </p>
      <div style={styles.group} role="radiogroup" aria-label="root">
        {PSY_ROOTS.map((root) => (
          <button key={root} type="button" role="radio" aria-checked={options.root === root} onClick={() => set('root', root)} style={button(options.root === root)}>
            {root}
          </button>
        ))}
      </div>
      <div style={styles.group} role="radiogroup" aria-label="style">
        {(['roll', 'gallop'] as const).map((style) => (
          <button key={style} type="button" role="radio" aria-checked={options.style === style} onClick={() => set('style', style)} style={button(options.style === style)}>
            {style.toUpperCase()}
          </button>
        ))}
      </div>
      <div style={styles.group} role="radiogroup" aria-label="bars">
        {[1, 2, 4].map((count) => (
          <button key={count} type="button" role="radio" aria-checked={options.bars === count} onClick={() => set('bars', count)} style={button(options.bars === count)}>
            {count} BAR
          </button>
        ))}
      </div>
      <label style={styles.check}>
        <input type="checkbox" checked={options.tempo} onChange={(event) => set('tempo', event.target.checked)} />
        145 BPM
      </label>
      <label style={styles.check}>
        <input type="checkbox" checked={options.sound} onChange={(event) => set('sound', event.target.checked)} />
        load the Psy Roll sound
      </label>
      <div style={styles.group}>
        <button type="button" onClick={onClose} style={button(false)} aria-label="cancel">
          CANCEL
        </button>
        <button type="button" onClick={() => onWrite(options)} style={button(true)} aria-label="write the pattern">
          WRITE
        </button>
      </div>
    </div>
  );
}

const WAV_LOOPS = [1, 4, 8, 16] as const;

/**
 * EXPORT WAV: how many passes of the loop, then render and save. The render runs the live
 * engine offline, faster than real time; on a phone that is seconds, so the sheet says it is
 * working and does not let a second press start a second render.
 */
function WavSheet({
  state,
  exportWav,
  onClose,
}: {
  state: EngineState;
  exportWav: (state: EngineState, loops: number) => Promise<WavExportResult>;
  onClose: () => void;
}) {
  const [loops, setLoops] = useState<number>(4);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<WavExportResult | null>(null);
  const looping = state.song.loop.enabled;
  const release = state.patch.voice.envelope.release;
  const seconds = (count: number) => exportPlan(state.song, count, release).renderSeconds;

  const run = async () => {
    setBusy(true);
    setStatus(null);
    try {
      setStatus(await exportWav(state, loops));
    } catch (error) {
      setStatus({ ok: false, message: `Render failed: ${String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.sheet} role="dialog" aria-modal="true" aria-label="export a wav file">
      <h2 style={styles.sheetTitle}>EXPORT WAV</h2>
      <p style={styles.sheetNote}>
        Renders the song with the current sound — the same engine you hear — as a 16-bit stereo WAV, and
        saves it to Download/SAG/. The loop is played the number of times you pick, then the sound rings out.
      </p>
      {looping ? (
        <div style={styles.group} role="radiogroup" aria-label="loop passes">
          {WAV_LOOPS.map((count) => (
            <button
              key={count}
              type="button"
              role="radio"
              aria-checked={loops === count}
              onClick={() => setLoops(count)}
              style={button(loops === count)}
            >
              {count}× · {seconds(count).toFixed(1)}s
            </button>
          ))}
        </div>
      ) : (
        <p style={styles.sheetNote}>The loop is off: the whole song, {seconds(1).toFixed(1)} s.</p>
      )}
      {status !== null && (
        <p role="status" style={{ ...styles.sheetNote, color: status.ok ? COLOR.accentText : COLOR.overflow }}>
          {status.message}
        </p>
      )}
      <div style={styles.group}>
        <button type="button" onClick={onClose} style={button(false)} aria-label="close">
          CLOSE
        </button>
        <button type="button" onClick={() => void run()} disabled={busy} style={button(true)} aria-label="render and save">
          {busy ? 'RENDERING…' : 'RENDER & SAVE'}
        </button>
      </div>
    </div>
  );
}

function button(on: boolean): React.CSSProperties {
  return {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN * 0.8,
    padding: '0 0.55rem',
    background: on ? COLOR.accentDim : 'transparent',
    color: on ? COLOR.accentText : COLOR.text,
    border: `1px solid ${on ? COLOR.accent : COLOR.border}`,
    borderRadius: 4,
    fontFamily: FONT.mono,
    fontSize: '0.7rem',
    cursor: 'pointer',
  };
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' },
  bar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.35rem',
    padding: '0.3rem 0.4rem',
    background: COLOR.surfaceLowest,
    borderBottom: `1px solid ${COLOR.border}`,
  },
  group: { display: 'flex', alignItems: 'center', gap: '0.25rem', flexWrap: 'wrap' },
  readout: { fontFamily: FONT.mono, fontSize: '0.7rem', color: COLOR.accentText, minWidth: '4.2rem', textAlign: 'center' },
  select: {
    minHeight: TOUCH_MIN * 0.8,
    background: COLOR.surfaceLowest,
    color: COLOR.text,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 4,
    fontFamily: FONT.mono,
    fontSize: '0.7rem',
  },
  roll: { flex: 1, minHeight: 0 },
  portrait: { padding: '1rem', color: COLOR.textDim, fontSize: '0.85rem', lineHeight: 1.5 },
  summary: { fontFamily: FONT.mono, fontSize: '0.75rem', color: COLOR.accentText },
  sheet: {
    position: 'absolute',
    inset: 0,
    zIndex: 5,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.7rem',
    padding: '0.8rem',
    overflowY: 'auto',
    background: COLOR.surface,
  },
  sheetTitle: { margin: 0, fontSize: '0.8rem', letterSpacing: '0.16em', color: COLOR.accentText },
  sheetNote: { margin: 0, fontSize: '0.75rem', color: COLOR.textDim, lineHeight: 1.5 },
  check: { display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: COLOR.text },
} as const satisfies Record<string, React.CSSProperties>;
