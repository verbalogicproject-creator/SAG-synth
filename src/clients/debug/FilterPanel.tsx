/**
 * src/clients/debug/FilterPanel.tsx — live control of the filter section.
 *
 * The first real control surface. Every control is generated from `PARAM_SPECS`, so the
 * ranges, units and legal values are the validator's, not a second copy that can drift
 * from it.
 *
 * Note what is NOT here: `voice.filter.frequency`. It is in `UNMAPPED_PARAMS` — in a
 * MonoSynth the filter envelope owns the cutoff, so exposing it would be a decoy knob
 * that validates, journals, replays, and changes nothing you can hear. The live cutoff
 * is `voice.filterEnvelope.baseFrequency`, labelled "cutoff" below.
 */

import { PARAM_SPECS } from '../../core/schemas';
import { getParam } from '../../core/params';
import type { EngineState } from '../../core/state';
import type { ParamPath, ParamValue } from '../../core/types';
import { ParamControl } from './ParamControl';

export interface FilterPanelProps {
  state: EngineState;
  onChange: (path: ParamPath, value: ParamValue) => void;
}

/**
 * Ordered as a hardware filter section reads, not as the schema happens to be shaped:
 * the shaping controls first, then the contour that moves them.
 */
const CONTROLS: readonly { path: ParamPath; label: string }[] = [
  { path: 'voice.filter.type', label: 'type' },
  { path: 'voice.filterEnvelope.baseFrequency', label: 'cutoff' },
  { path: 'voice.filter.Q', label: 'resonance' },
  { path: 'voice.filter.rolloff', label: 'slope' },
  { path: 'voice.filterEnvelope.octaves', label: 'env amount' },
  { path: 'voice.filterEnvelope.attack', label: 'env attack' },
  { path: 'voice.filterEnvelope.decay', label: 'env decay' },
  { path: 'voice.filterEnvelope.sustain', label: 'env sustain' },
  { path: 'voice.filterEnvelope.release', label: 'env release' },
];

export function FilterPanel({ state, onChange }: FilterPanelProps) {
  return (
    <>
      {CONTROLS.map(({ path, label }) => (
        <ParamControl
          key={path}
          path={path}
          label={label}
          spec={PARAM_SPECS[path]}
          value={getParam(state, path)}
          onChange={onChange}
        />
      ))}
    </>
  );
}
