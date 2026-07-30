/**
 * src/clients/debug/FilterPanel.tsx — live control of the filter section.
 *
 * The first real control surface. Every control is generated from `PARAM_SPECS`, so the
 * ranges, units and legal values are the validator's, not a second copy that can drift
 * from it.
 *
 * Note what is NOT here: `voice.filter.frequency`. It used to be a decoy knob — in a
 * MonoSynth the filter envelope owns the cutoff, so it validated, journalled, replayed
 * and changed nothing you could hear — and it was declared in `UNMAPPED_PARAMS` to say
 * so. At schema_version 2 it was deleted outright, so this panel no longer has to
 * explain an absence. The live cutoff is `voice.filterEnvelope.baseFrequency`, labelled
 * "cutoff" below.
 *
 * The ordering below is now also declared as `SIGNAL_CHAIN`'s filter section in
 * `src/core/groups.ts`, which states it once for every surface instead of only this one.
 * This panel is throwaway and stays as it is; the designed surface reads the chain.
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
