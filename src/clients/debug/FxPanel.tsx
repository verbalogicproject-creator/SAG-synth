/**
 * src/clients/debug/FxPanel.tsx — the effects chain and the EQ.
 *
 * Generated from `SIGNAL_CHAIN`'s `effects` and `eq` sections, so the chain drawn here is
 * the chain declared in core rather than a second opinion about it. The order the panels
 * appear in IS `EFFECT_CHAIN_ORDER`.
 *
 * The enable toggles are their own command (`setEffectEnabled`) rather than a parameter,
 * because that is how the contract models them — an effect's `enabled` is not an address
 * in the 97, it is a verb. The runtime expresses a disabled effect as wet 0 while leaving
 * the stored wet value alone, so switching one off and back on restores the sound you had
 * without this panel having to remember it.
 */

import { SIGNAL_CHAIN } from '../../core/groups';
import { EFFECT_CHAIN_ORDER, EQ_BAND_FREQUENCIES, type EffectId } from '../../core/types';
import { PARAM_SPECS } from '../../core/schemas';
import { getParam } from '../../core/params';
import type { EngineState } from '../../core/state';
import type { ParamPath, ParamValue } from '../../core/types';
import type { SynthCommand } from '../../core/commands';
import { ParamControl } from './ParamControl';

export interface FxPanelProps {
  state: EngineState;
  onChange: (path: ParamPath, value: ParamValue) => void;
  onCommand: (command: SynthCommand) => void;
}

const LABELS: Partial<Record<string, string>> = {
  'effects.distortion.amount': 'drive',
  'effects.distortion.wet': 'mix',
  'effects.chorus.frequency': 'rate',
  'effects.chorus.delayTime': 'delay',
  'effects.chorus.depth': 'depth',
  'effects.chorus.wet': 'mix',
  'effects.delay.delayTime': 'time',
  'effects.delay.feedback': 'feedback',
  'effects.delay.wet': 'mix',
  'effects.reverb.roomSize': 'size',
  'effects.reverb.dampening': 'damping',
  'effects.reverb.wet': 'mix',
};

const fxSection = SIGNAL_CHAIN.find((s) => s.id === 'effects');
const eqSection = SIGNAL_CHAIN.find((s) => s.id === 'eq');

/** Hz label for a band gain path, read from the declared centres rather than retyped. */
function bandLabel(path: ParamPath): string {
  const match = /^effects\.eq\.band(\d)\.gain$/.exec(path);
  if (match === null) return path;
  const hz = EQ_BAND_FREQUENCIES[Number(match[1])]!;
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
}

const group: React.CSSProperties = {
  border: '1px solid #333',
  borderRadius: 4,
  padding: '0.5rem',
  marginBottom: '0.5rem',
};

const head: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  marginBottom: '0.4rem',
};

const dim: React.CSSProperties = { color: '#888', fontSize: '0.8rem' };

export function FxPanel({ state, onChange, onCommand }: FxPanelProps) {
  const effects = state.patch.effects;

  return (
    <>
      {EFFECT_CHAIN_ORDER.filter((id): id is Exclude<EffectId, 'eq'> => id !== 'eq').map((id) => {
        const paths = (fxSection?.paths ?? []).filter((path) => path.startsWith(`effects.${id}.`));
        const enabled = effects[id].enabled;
        return (
          <div key={id} style={group}>
            <div style={head}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) =>
                  onCommand({ type: 'setEffectEnabled', effectId: id, enabled: event.target.checked })
                }
              />
              <strong style={{ color: enabled ? '#ddd' : '#666' }}>{id}</strong>
              {!enabled && <span style={dim}>bypassed — values kept</span>}
            </div>
            {paths.map((path) => (
              <ParamControl
                key={path}
                path={path}
                label={LABELS[path] ?? path.split('.').pop() ?? path}
                spec={PARAM_SPECS[path]}
                value={getParam(state, path)}
                onChange={onChange}
              />
            ))}
          </div>
        );
      })}

      <div style={group}>
        <div style={head}>
          <input
            type="checkbox"
            checked={effects.eq.enabled}
            onChange={(event) =>
              onCommand({ type: 'setEffectEnabled', effectId: 'eq', enabled: event.target.checked })
            }
          />
          <strong style={{ color: effects.eq.enabled ? '#ddd' : '#666' }}>eq</strong>
          <span style={dim}>fixed bands, gain only</span>
        </div>
        {(eqSection?.paths ?? [])
          .filter((path) => path !== 'effects.eq.enabled')
          .map((path) => (
            <ParamControl
              key={path}
              path={path}
              label={`${bandLabel(path)} Hz`}
              spec={PARAM_SPECS[path]}
              value={getParam(state, path)}
              onChange={onChange}
            />
          ))}
      </div>

      <p style={dim}>
        Chain order is EFFECT_CHAIN_ORDER: {EFFECT_CHAIN_ORDER.join(' → ')} → master →
        limiter → safety clip. The clip is what guarantees the output never exceeds full
        scale; the limiter shapes, it does not promise a ceiling.
      </p>
    </>
  );
}
