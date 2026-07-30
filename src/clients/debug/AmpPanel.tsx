/**
 * src/clients/debug/AmpPanel.tsx — the amplifier section, plus play velocity.
 *
 * Generated from `SIGNAL_CHAIN`'s amplifier section, so the amp envelope, the per-voice
 * base level and the two velocity-response parameters all appear here without this file
 * naming them.
 *
 * The play-velocity slider is NOT a patch parameter and deliberately sits apart from the
 * generated controls. It is how hard the touch keyboard strikes, which is a property of
 * the performance rather than of the sound — a hardware keybed would measure it and a
 * touchscreen has no such axis.
 */

import { SIGNAL_CHAIN } from '../../core/groups';
import { PARAM_SPECS } from '../../core/schemas';
import { getParam } from '../../core/params';
import type { EngineState } from '../../core/state';
import type { ParamPath, ParamValue } from '../../core/types';
import { ParamControl } from './ParamControl';

export interface AmpPanelProps {
  state: EngineState;
  onChange: (path: ParamPath, value: ParamValue) => void;
  velocity: number;
  onVelocityChange: (velocity: number) => void;
}

const LABELS: Partial<Record<string, string>> = {
  'voice.envelope.attack': 'attack',
  'voice.envelope.decay': 'decay',
  'voice.envelope.sustain': 'sustain',
  'voice.envelope.release': 'release',
  'voice.amplitude': 'level',
  'voice.velocity.toAmplitude': 'vel → level',
  'voice.velocity.toFilterOctaves': 'vel → filter',
};

const section = SIGNAL_CHAIN.find((s) => s.id === 'amplifier');

const row: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '7rem 1fr 4rem',
  gap: '0.5rem',
  alignItems: 'center',
  marginBottom: '0.35rem',
  paddingBottom: '0.5rem',
  borderBottom: '1px solid #333',
};

const label: React.CSSProperties = { color: '#8ab4f8', fontSize: '0.85rem' };
const readout: React.CSSProperties = { color: '#ddd', fontSize: '0.85rem', textAlign: 'right' };

export function AmpPanel({ state, onChange, velocity, onVelocityChange }: AmpPanelProps) {
  return (
    <>
      <div style={row}>
        <span style={label}>play velocity</span>
        <input
          type="range"
          min={0.05}
          max={1}
          step={0.01}
          value={velocity}
          onChange={(event) => onVelocityChange(Number(event.target.value))}
        />
        <span style={readout}>{velocity.toFixed(2)}</span>
      </div>

      {(section?.paths ?? []).map((path) => (
        <ParamControl
          key={path}
          path={path}
          label={LABELS[path] ?? path.split('.').pop() ?? path}
          spec={PARAM_SPECS[path]}
          value={getParam(state, path)}
          onChange={onChange}
        />
      ))}
    </>
  );
}
