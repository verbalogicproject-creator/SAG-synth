/**
 * src/clients/synth/ChannelBar.tsx — the channel rack (C5c).
 *
 * FL's channel rack, squeezed onto a phone: one chip per channel, the selected one lit,
 * and the tabs below it edit whatever is lit. A chip is a `SongTrack` — a synth channel
 * plays its `presetSnapshot`, a kick channel plays its `kick` — so this bar adds no state
 * of its own beyond WHICH id is selected, which is a property of the surface and not of the
 * song (`SynthApp` owns it and remembers it in localStorage).
 *
 * **Mute and solo are on the chip, not in a sheet.** They are the two controls a player
 * reaches for while the loop is running, and burying them behind a second tap is what
 * makes a mixer feel slow. Everything else about a channel — its name, its fader, its pan,
 * deleting it — lives in the sheet behind `⋯`, which only the selected chip shows.
 *
 * **The chips scroll, the buttons do not.** On a 372 px screen six channels do not fit, and
 * a "+ SYNTH" that scrolls off the edge is a button nobody finds.
 */

import { useEffect, useRef, useState } from 'react';
import { channelKind, synthChannels } from '../../core/channels';
import { TRACK_PARAM_SPECS } from '../../core/song-params';
import type { SongTrack } from '../../core/types';
import type { SynthCommand } from '../../core/commands';
import { COLOR, FONT, TOUCH_MIN } from './tokens';

/**
 * The CPU guard, until C7's budget meter measures the real thing.
 *
 * Voices stay lazy, so an idle channel costs its LFOs and nothing else — but six psy
 * channels with their modulation running is already past what this phone rendered
 * comfortably in the mixer bench (`arch/bus-routing.ngf.md`). A named cap that says why is
 * better than a device that starts crackling with no explanation.
 */
export const MAX_SYNTH_CHANNELS = 6;

/** A psytrance kick tuned to the bass: ~2 octaves of fall, a 220 ms body. Ear-tunable. */
export const DEFAULT_KICK = { tune: 'G1', punch: 3, pitchDecay: 0.03, decay: 0.22, level: 0 } as const;

export interface ChannelBarProps {
  tracks: readonly SongTrack[];
  selectedId: string | null;
  onSelect: (trackId: string) => void;
  onCommand: (command: SynthCommand) => void;
  /** The preset a new synth channel starts from. */
  startingPresetId?: string;
  /** Id minting is the client's job — core never mints. */
  mintId?: () => string;
  /**
   * Drawn at the right end of the bar. The output level lives here rather than in the
   * header: at 372 px the header's six items squeezed the patch name down to "P.".
   */
  trailing?: React.ReactNode;
}

function defaultMint(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function ChannelBar({
  tracks,
  selectedId,
  onSelect,
  onCommand,
  startingPresetId,
  mintId = defaultMint,
  trailing,
}: ChannelBarProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  /**
   * The selected chip is scrolled into view whenever it changes.
   *
   * Found in a screenshot, not in a test: with four channels the bar scrolls, and a chip
   * selected from the sequencer (or by adding one) could sit entirely off the right edge —
   * so the panels below were editing a channel the player could not see.
   */
  const selectedChip = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    selectedChip.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selectedId]);
  const selected = tracks.find((track) => track.id === selectedId);
  const synthCount = tracks.filter((track) => channelKind(track) === 'synth').length;
  const full = synthCount >= MAX_SYNTH_CHANNELS;

  const addSynth = (): void => {
    if (full) return;
    const trackId = `ch-${mintId()}`;
    onCommand({
      type: 'addTrack',
      trackId,
      name: `Synth ${synthCount + 1}`,
      ...(startingPresetId === undefined ? {} : { presetId: startingPresetId }),
    });
    onSelect(trackId);
  };

  const addKick = (): void => {
    const trackId = `kick-${mintId()}`;
    onCommand({ type: 'addTrack', trackId, name: 'Kick' });
    onCommand({ type: 'setTrackKick', trackId, kick: { ...DEFAULT_KICK } });
    onSelect(trackId);
  };

  return (
    <>
      <div style={styles.bar} role="tablist" aria-label="channels">
        <div style={styles.chips}>
          {tracks.map((track) => {
            const on = track.id === selectedId;
            const kick = channelKind(track) === 'kick';
            return (
              <div
                key={track.id}
                ref={on ? selectedChip : null}
                style={{ ...styles.chip, ...(on ? styles.chipOn : null) }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  // The id, not the name: two channels may be called the same thing, and a
                  // surface that identified them by label would edit the wrong one.
                  data-channel={track.id}
                  onClick={() => onSelect(track.id)}
                  style={styles.chipName}
                  aria-label={`${track.name} — ${kick ? 'kick' : 'synth'} channel`}
                >
                  <span aria-hidden style={styles.glyph}>{kick ? '◉' : '∿'}</span>
                  {track.name}
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={track.muted}
                  onClick={() => onCommand({ type: 'setTrackParam', trackId: track.id, path: 'muted', value: !track.muted })}
                  style={{ ...styles.flag, ...(track.muted ? styles.flagOn : null) }}
                  aria-label={`mute ${track.name}`}
                >
                  M
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={track.solo}
                  onClick={() => onCommand({ type: 'setTrackParam', trackId: track.id, path: 'solo', value: !track.solo })}
                  style={{ ...styles.flag, ...(track.solo ? styles.flagSolo : null) }}
                  aria-label={`solo ${track.name}`}
                >
                  S
                </button>
                {on && (
                  <button
                    type="button"
                    onClick={() => setSheetOpen(true)}
                    style={styles.flag}
                    aria-label={`${track.name} settings`}
                  >
                    ⋯
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={addSynth}
          disabled={full}
          style={{ ...styles.add, ...(full ? styles.addOff : null) }}
          aria-label={full ? `the channel limit is ${MAX_SYNTH_CHANNELS} synth channels` : 'add a synth channel'}
          title={full ? `${MAX_SYNTH_CHANNELS} synth channels is the limit until the mixer lands (C7)` : undefined}
        >
          {/* Glyphs, not words: "+ SYNTH" and "+ KICK" spelled out took a third of a
              372 px bar, which is room the chips need. The accessible names carry the
              meaning, and the glyphs match the ones on the chips. */}
          +<span aria-hidden style={styles.glyph}>∿</span>
        </button>
        <button type="button" onClick={addKick} style={styles.add} aria-label="add a kick channel">
          +<span aria-hidden style={styles.glyph}>◉</span>
        </button>
        {trailing}
      </div>

      {sheetOpen && selected !== undefined && (
        <ChannelSheet
          track={selected}
          canDelete={tracks.length > 1}
          onCommand={onCommand}
          onClose={() => setSheetOpen(false)}
          onDeleted={() => {
            setSheetOpen(false);
            const next = tracks.find((track) => track.id !== selected.id);
            if (next !== undefined) onSelect(next.id);
          }}
        />
      )}
    </>
  );
}

/**
 * Everything about one channel that is not worth a permanent button: its name, its fader,
 * its pan, and deleting it.
 *
 * The fader and pan are here rather than nowhere: C5b gave every channel a real volume and
 * pan on its strip, and a control that exists in the engine and nowhere on the surface is
 * the same dead end as a knob that reaches no node.
 */
function ChannelSheet({
  track,
  canDelete,
  onCommand,
  onClose,
  onDeleted,
}: {
  track: SongTrack;
  canDelete: boolean;
  onCommand: (command: SynthCommand) => void;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(track.name);
  // Two taps, because a channel holds a sound you spent an evening on and there is no
  // confirm dialog on this surface. Undo brings it back either way.
  const [armed, setArmed] = useState(false);

  const rename = (): void => {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === track.name) return;
    onCommand({ type: 'renameTrack', trackId: track.id, name: trimmed });
  };

  return (
    <div style={styles.overlay} role="dialog" aria-modal="true" aria-label={`channel ${track.name}`}>
      <header style={styles.sheetHead}>
        <h2 style={styles.sheetTitle}>CHANNEL</h2>
        <button type="button" onClick={onClose} style={styles.close} aria-label="close the channel settings">
          ✕
        </button>
      </header>
      <div style={styles.sheetBody}>
        <label style={styles.field}>
          <span style={styles.fieldLabel}>NAME</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={rename}
            style={styles.input}
            aria-label="channel name"
          />
        </label>

        <label style={styles.field}>
          <span style={styles.fieldLabel}>VOLUME</span>
          <input
            type="range"
            min={TRACK_PARAM_SPECS.volume.min}
            max={TRACK_PARAM_SPECS.volume.max}
            step={TRACK_PARAM_SPECS.volume.step}
            value={track.volume}
            onChange={(event) =>
              onCommand({ type: 'setTrackParam', trackId: track.id, path: 'volume', value: Number(event.target.value) })
            }
            style={styles.range}
            aria-label="channel volume"
          />
          <span style={styles.readout}>{track.volume.toFixed(1)} dB</span>
        </label>

        <label style={styles.field}>
          <span style={styles.fieldLabel}>PAN</span>
          <input
            type="range"
            min={TRACK_PARAM_SPECS.pan.min}
            max={TRACK_PARAM_SPECS.pan.max}
            step={TRACK_PARAM_SPECS.pan.step}
            value={track.pan}
            onChange={(event) =>
              onCommand({ type: 'setTrackParam', trackId: track.id, path: 'pan', value: Number(event.target.value) })
            }
            style={styles.range}
            aria-label="channel pan"
          />
          <span style={styles.readout}>{track.pan === 0 ? 'C' : `${track.pan > 0 ? 'R' : 'L'}${Math.round(Math.abs(track.pan) * 100)}`}</span>
        </label>

        <button
          type="button"
          disabled={!canDelete}
          onClick={() => {
            if (!armed) {
              setArmed(true);
              return;
            }
            onCommand({ type: 'removeTrack', trackId: track.id });
            onDeleted();
          }}
          style={{ ...styles.delete, ...(armed ? styles.deleteArmed : null) }}
          aria-label={armed ? `really delete ${track.name}` : `delete ${track.name}`}
        >
          {canDelete ? (armed ? 'TAP AGAIN TO DELETE' : 'DELETE CHANNEL') : 'THE LAST CHANNEL STAYS'}
        </button>
      </div>
    </div>
  );
}

/** The synth channels a surface may target, in song order. Re-exported for the app. */
export { synthChannels };

const styles = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.3rem',
    padding: '0.3rem 0.4rem',
    background: COLOR.surfaceLowest,
    borderBottom: `1px solid ${COLOR.border}`,
  },
  chips: {
    display: 'flex',
    gap: '0.3rem',
    flex: 1,
    minWidth: 0,
    overflowX: 'auto',
    scrollbarWidth: 'none',
  },
  chip: {
    display: 'flex',
    alignItems: 'center',
    flex: '0 0 auto',
    border: `1px solid ${COLOR.border}`,
    borderRadius: 4,
    background: 'transparent',
  },
  chipOn: { borderColor: COLOR.accent, background: COLOR.accentDim },
  chipName: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    maxWidth: '7rem',
    minHeight: TOUCH_MIN / 1.3,
    padding: '0 0.4rem',
    background: 'transparent',
    border: 'none',
    color: COLOR.text,
    fontFamily: FONT.display,
    fontSize: '0.7rem',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    cursor: 'pointer',
  },
  glyph: { color: COLOR.accentText, fontSize: '0.75rem' },
  flag: {
    minWidth: '1.4rem',
    minHeight: TOUCH_MIN / 1.3,
    padding: 0,
    background: 'transparent',
    border: 'none',
    borderLeft: `1px solid ${COLOR.border}`,
    color: COLOR.textDim,
    fontFamily: FONT.mono,
    fontSize: '0.6rem',
    cursor: 'pointer',
  },
  flagOn: { color: COLOR.surface, background: COLOR.accent },
  flagSolo: { color: COLOR.accentText, background: COLOR.accentDim },
  add: {
    flex: '0 0 auto',
    minHeight: TOUCH_MIN / 1.3,
    padding: '0 0.4rem',
    background: 'transparent',
    border: `1px dashed ${COLOR.border}`,
    borderRadius: 4,
    color: COLOR.textDim,
    fontFamily: FONT.display,
    fontSize: '0.6rem',
    letterSpacing: '0.06em',
    cursor: 'pointer',
  },
  addOff: { opacity: 0.35, cursor: 'not-allowed' },
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 11,
    display: 'flex',
    flexDirection: 'column',
    background: COLOR.surface,
  },
  sheetHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.5rem 0.7rem',
    background: COLOR.surfaceLowest,
    borderBottom: `1px solid ${COLOR.border}`,
  },
  sheetTitle: {
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
  sheetBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.9rem',
    padding: '0.9rem 0.7rem',
    boxSizing: 'border-box',
    width: '100%',
  },
  field: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontFamily: FONT.mono,
    fontSize: '0.7rem',
    color: COLOR.textDim,
  },
  fieldLabel: { minWidth: '3.4rem', letterSpacing: '0.08em' },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: TOUCH_MIN,
    padding: '0 0.5rem',
    background: COLOR.surfaceLowest,
    color: COLOR.text,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 4,
    fontFamily: FONT.display,
    fontSize: '0.8rem',
  },
  range: { flex: 1, height: TOUCH_MIN / 2, touchAction: 'none', accentColor: COLOR.accent },
  // `flex: none` plus a modest width: at 372 px the row overflowed and clipped the
  // readout's last character against the screen edge.
  readout: { flex: 'none', minWidth: '3rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  delete: {
    minHeight: TOUCH_MIN,
    marginTop: '0.5rem',
    background: 'transparent',
    border: `1px solid ${COLOR.border}`,
    borderRadius: 4,
    color: COLOR.textDim,
    fontFamily: FONT.display,
    fontSize: '0.7rem',
    letterSpacing: '0.08em',
    cursor: 'pointer',
  },
  deleteArmed: { borderColor: COLOR.overflow, color: COLOR.overflow },
} as const satisfies Record<string, React.CSSProperties>;
