/**
 * src/clients/debug/OscillatorPanel.tsx — the oscillator section.
 *
 * Generated from `SIGNAL_CHAIN`'s oscillator section rather than a hand-written list, so
 * a parameter added to the chain appears here without touching this file. The filter
 * panel predates `groups.ts` and still carries its own ordering; this is what the pattern
 * looks like now.
 *
 * Throwaway like the rest of `debug/`. What it has to do is make Stage 2c audible: unison,
 * pulse width and base detune all reached the graph for the first time in that stage, and
 * an offline gate proving a spectrum moved is not the same as hearing it.
 */

import { SIGNAL_CHAIN } from '../../core/groups';
import { PARAM_SPECS } from '../../core/schemas';
import { getParam } from '../../core/params';
import type { EngineState } from '../../core/state';
import type { ParamPath, ParamValue } from '../../core/types';
import { ParamControl } from './ParamControl';

export interface OscillatorPanelProps {
  state: EngineState;
  onChange: (path: ParamPath, value: ParamValue) => void;
  /** Combinations this patch sets that its oscillator type cannot honour. */
  unsupported: readonly string[];
}

const LABELS: Partial<Record<string, string>> = {
  'voice.oscillator.type': 'shape',
  'voice.oscillator.detune': 'detune',
  'voice.oscillator.count': 'unison',
  'voice.oscillator.spread': 'spread',
  'voice.oscillator.width': 'pulse width',
};

const section = SIGNAL_CHAIN.find((s) => s.id === 'oscillator');

const warn: React.CSSProperties = {
  color: '#b58900',
  fontSize: '0.8rem',
  margin: '0.4rem 0 0',
};

export function OscillatorPanel({ state, onChange, unsupported }: OscillatorPanelProps) {
  const type = getParam(state, 'voice.oscillator.type');

  return (
    <>
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

      {/*
        Tone's type-string grammar is not the orthogonal parameter space these five
        controls imply: there is no fatpulse, and width belongs to pulse alone. Rather
        than disable controls — which would hide a real patch value that is still stored
        and still replayed — say what is being ignored right now.
      */}
      {unsupported.length > 0 && (
        <p style={warn}>
          {type === 'noise'
            ? 'noise needs a different voice shape than MonoSynth — sounding as sawtooth. '
            : ''}
          ignored for shape “{String(type)}”: {unsupported.join(', ')}
        </p>
      )}
    </>
  );
}
