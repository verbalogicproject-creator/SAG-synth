/**
 * src/clients/synth/KickPanel.tsx — what a kick channel shows instead of the synth tabs.
 *
 * A kick channel has no `presetSnapshot` to edit (core refuses a patch verb aimed at one),
 * so selecting it has to show the five things a `KickConfig` actually has. These are NOT
 * parameter addresses: they live on the SONG, are written with `setTrackKick`, and have no
 * ctl id — which is why this panel is hand-built rather than assembled from `PARAM_SPECS`,
 * and why the dead-control sweep does not walk it.
 *
 * Ranges and steps come from `KICK_PARAM_SPECS` in core, never from literals here: the
 * reducer validates against those bounds, a slider that could ask for more would produce a
 * refused command mid-drag, and `controls.test.ts` refuses a component that states its own
 * value space — the rule that caught this panel's first draft.
 *
 * C6 replaces this with the real kick synth (click, drive, sweep curve, tail shape). Until
 * then this is the whole surface of the kick, and it says so.
 */

import { KICK_PARAM_SPECS, KICK_TUNINGS, type SongParamSpec } from '../../core/song-params';
import type { KickConfig, SongTrack } from '../../core/types';
import type { SynthCommand } from '../../core/commands';
import { COLOR, FONT, TOUCH_MIN } from './tokens';

export interface KickPanelProps {
  track: SongTrack;
  onCommand: (command: SynthCommand) => void;
}

export function KickPanel({ track, onCommand }: KickPanelProps) {
  const kick = track.kick;
  if (kick === undefined) {
    return (
      <div style={styles.panel}>
        <p style={styles.note}>This drum channel has no kick voice yet. Draw a hit in SEQ and it gets one.</p>
      </div>
    );
  }

  // The whole config every time: `setTrackKick` takes a KickConfig, not a field, so a
  // partial write is not expressible — which is what keeps a half-written kick impossible.
  const write = (patch: Partial<KickConfig>): void => {
    onCommand({ type: 'setTrackKick', trackId: track.id, kick: { ...kick, ...patch } });
  };

  return (
    <div style={styles.panel}>
      <h2 style={styles.title}>KICK — {track.name}</h2>

      <label style={styles.field}>
        <span style={styles.label}>TUNE</span>
        <select
          value={kick.tune}
          onChange={(event) => write({ tune: event.target.value })}
          style={styles.select}
          aria-label="kick tune"
        >
          {KICK_TUNINGS.map((note) => (
            <option key={note} value={note}>
              {note}
            </option>
          ))}
        </select>
      </label>

      <Range
        label="PUNCH"
        aria="kick punch"
        value={kick.punch}
        spec={KICK_PARAM_SPECS.punch}
        format={(value) => `${value.toFixed(1)} oct`}
        onChange={(punch) => write({ punch })}
      />
      <Range
        label="SWEEP"
        aria="kick pitch decay"
        value={kick.pitchDecay}
        spec={KICK_PARAM_SPECS.pitchDecay}
        format={(value) => `${Math.round(value * 1000)} ms`}
        onChange={(pitchDecay) => write({ pitchDecay })}
      />
      <Range
        label="DECAY"
        aria="kick decay"
        value={kick.decay}
        spec={KICK_PARAM_SPECS.decay}
        format={(value) => `${Math.round(value * 1000)} ms`}
        onChange={(decay) => write({ decay })}
      />
      <Range
        label="LEVEL"
        aria="kick level"
        value={kick.level}
        spec={KICK_PARAM_SPECS.level}
        format={(value) => `${value.toFixed(1)} dB`}
        onChange={(level) => write({ level })}
      />

      <p style={styles.note}>
        Punch is how far the pitch falls, sweep is how fast it falls, decay is how long the body
        rings. The full kick synth — click, drive, sweep curve, tail — is C6.
      </p>
    </div>
  );
}

function Range({
  label,
  aria,
  value,
  spec,
  format,
  onChange,
}: {
  label: string;
  aria: string;
  value: number;
  spec: SongParamSpec;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label style={styles.field}>
      <span style={styles.label}>{label}</span>
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={styles.range}
        aria-label={aria}
      />
      <span style={styles.readout}>{format(value)}</span>
    </label>
  );
}

const styles = {
  panel: { display: 'flex', flexDirection: 'column', gap: '0.8rem', padding: '0.9rem 0.7rem 2rem' },
  title: {
    margin: 0,
    fontFamily: FONT.display,
    fontSize: '0.8rem',
    letterSpacing: '0.14em',
    color: COLOR.accentText,
  },
  field: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontFamily: FONT.mono,
    fontSize: '0.7rem',
    color: COLOR.textDim,
  },
  label: { minWidth: '3.6rem', letterSpacing: '0.08em' },
  range: { flex: 1, height: TOUCH_MIN / 2, touchAction: 'none', accentColor: COLOR.accent },
  readout: { minWidth: '4rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  select: {
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
    fontSize: '0.8rem',
  },
  note: { margin: 0, fontFamily: FONT.display, fontSize: '0.65rem', lineHeight: 1.5, color: COLOR.textDim },
} as const satisfies Record<string, React.CSSProperties>;
