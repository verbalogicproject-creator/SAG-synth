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

/** True when every band sits at 0 dB, i.e. the EQ is on and deliberately transparent. */
function bandsAtZero(state: EngineState): boolean {
  const eq = state.patch.effects.eq;
  return [eq.band0, eq.band1, eq.band2, eq.band3, eq.band4].every((band) => band.gain === 0);
}

/** Hz label for a band gain path, read from the declared centres rather than retyped. */
function bandLabel(path: ParamPath): string {
  const match = /^effects\.eq\.band(\d)\.gain$/.exec(path);
  if (match === null) return path;
  const hz = EQ_BAND_FREQUENCIES[Number(match[1])]!;
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
}

/**
 * What +18 dB on each band actually does to the FACTORY patch, measured.
 *
 * Not decoration. "The EQ doesn't work" was reported twice, and both times every band was
 * functioning exactly as designed — the factory cutoff settles near 2.8 kHz, so the top
 * band has nothing to lift and the bottom one is below what a phone reproduces. A player
 * cannot tell "this control is broken" from "this control has nothing to act on", and
 * without the numbers neither could I.
 *
 * Pinned by a gate on the factory patch, so a brighter default shows up as a failing test
 * rather than as a note that quietly became false.
 */
const BAND_REALITY: Record<string, string> = {
  'effects.eq.band0.gain': '+4 dB · below most phone speakers',
  'effects.eq.band1.gain': '+11 dB · the obvious one',
  'effects.eq.band2.gain': '+6 dB',
  'effects.eq.band3.gain': '+3 dB · near the default cutoff',
  'effects.eq.band4.gain': '±0 dB · nothing up there to lift',
};

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
              label={`${bandLabel(path)} Hz — ${BAND_REALITY[path] ?? ''}`}
              spec={PARAM_SPECS[path]}
              value={getParam(state, path)}
              onChange={onChange}
            />
          ))}
        {/*
          Three things make a working EQ look broken, and all three were reported as
          "EQ doesn't work" before this note existed. None is a defect; every one is
          invisible without being said.
        */}
        {effects.eq.enabled && bandsAtZero(state) && (
          <p style={dim}>
            Enabled and flat, so it is doing nothing — correctly. Unlike the effects above
            it has no wet control to announce itself; move a band.
          </p>
        )}
        <p style={dim}>
          The dB figures above are measured on the factory patch, whose filter settles near
          2.8 kHz. An EQ can only boost what is there — that is why the top band moves
          nothing and the bottom one moves something you cannot hear on a phone.{' '}
          <strong>Start with 250 Hz.</strong> Raise the filter cutoff and the upper bands
          come alive.
        </p>
      </div>

      <p style={dim}>
        Chain order is EFFECT_CHAIN_ORDER: {EFFECT_CHAIN_ORDER.join(' → ')} → master →
        limiter → safety clip. The clip is what guarantees the output never exceeds full
        scale; the limiter shapes, it does not promise a ceiling.
      </p>
    </>
  );
}
