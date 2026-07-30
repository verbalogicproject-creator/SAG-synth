/**
 * src/clients/debug/ModPanel.tsx — LFO and modulation routing, enough to hear it.
 *
 * A patch ships with no LFOs and no routes, so without a way to create them the whole
 * routing feature is unreachable from the device and can only be verified by a rendered
 * buffer. An offline gate and an ear check are not substitutes for each other: the
 * silence hunt established that a patch can pass every buffer assertion and still be
 * inaudible on a phone speaker.
 *
 * Throwaway, like the rest of `debug/`. The designed surface draws routing as cables
 * between panels; this draws it as a list, which is the same information with none of
 * the taste.
 *
 * Every control dispatches a command. `addLfo` / `addRoute` create slots; everything
 * after that is `setParam` on `voice.lfos.<i>.<key>` and `voice.modRoutes.<i>.<key>`,
 * exactly as the SDK would do it.
 */

import { MODULATION_DESTINATIONS, type ModDestination, type ParamPath, type ParamValue } from '../../core/types';
import { PARAM_SPECS } from '../../core/schemas';
import { getParam } from '../../core/params';
import type { EngineState } from '../../core/state';
import type { SynthCommand } from '../../core/commands';
import { ParamControl } from './ParamControl';

export interface ModPanelProps {
  state: EngineState;
  onChange: (path: ParamPath, value: ParamValue) => void;
  onCommand: (command: SynthCommand) => void;
}

/**
 * Destinations the runtime can actually wire today, in the order a player would reach
 * for them. The rest are declared in the KIND and land with Stage 2's unison work and
 * Stage 3's effects chain; offering them here would be offering a control that does
 * nothing, which is the decoy problem `voice.filter.frequency` already cost us.
 */
const SOURCES: readonly { value: 'lfo.0' | 'lfo.1' | 'lfo.2' | 'lfo.3' | 'velocity'; label: string }[] = [
  { value: 'lfo.0', label: 'LFO 0' },
  { value: 'lfo.1', label: 'LFO 1' },
  { value: 'lfo.2', label: 'LFO 2' },
  { value: 'lfo.3', label: 'LFO 3' },
  { value: 'velocity', label: 'velocity' },
];

const WIRED_DESTINATIONS: readonly { path: ModDestination; label: string }[] = [
  { path: 'voice.filterEnvelope.baseFrequency', label: 'cutoff — filter sweep' },
  { path: 'voice.filter.Q', label: 'resonance' },
  { path: 'voice.oscillator.detune', label: 'pitch — vibrato' },
  { path: 'voice.amplitude', label: 'level — tremolo' },
  { path: 'voice.pan', label: 'pan — autopan' },
];

const PENDING_COUNT = MODULATION_DESTINATIONS.length - WIRED_DESTINATIONS.length;

const row: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
  flexWrap: 'wrap',
  marginBottom: '0.4rem',
};

const button: React.CSSProperties = {
  padding: '0.35rem 0.7rem',
  background: '#1c1c1c',
  color: '#ddd',
  border: '1px solid #444',
  borderRadius: 4,
  fontFamily: 'inherit',
  fontSize: '0.85rem',
};

const slot: React.CSSProperties = {
  border: '1px solid #333',
  borderRadius: 4,
  padding: '0.5rem',
  marginBottom: '0.5rem',
};

const dim: React.CSSProperties = { color: '#888', fontSize: '0.8rem' };

export function ModPanel({ state, onChange, onCommand }: ModPanelProps) {
  const { lfos, modRoutes } = state.patch.voice;

  return (
    <>
      <div style={row}>
        <button
          type="button"
          style={button}
          onClick={() =>
            onCommand({
              type: 'addLfo',
              config: {
                id: `lfo-${lfos.length}-${state.revision}`,
                enabled: true,
                type: 'sine',
                frequency: 4,
                sync: false,
                retrigger: false,
              },
            })
          }
        >
          + LFO
        </button>
        <button
          type="button"
          style={button}
          onClick={() =>
            onCommand({
              type: 'addRoute',
              route: {
                id: `route-${modRoutes.length}-${state.revision}`,
                enabled: true,
                // Velocity when there is no LFO yet: it needs no slot, and the reducer
                // rejects a route naming an empty one.
                source: lfos.length > 0 ? 'lfo.0' : 'velocity',
                destination: 'voice.filterEnvelope.baseFrequency',
                depth: 0.3,
              },
            })
          }
        >
          + route
        </button>
        {lfos.length === 0 && (
          <span style={dim}>no LFO yet — a new route will use velocity as its source</span>
        )}
      </div>

      {lfos.map((lfo, index) => (
        <div key={lfo.id} style={slot}>
          <div style={row}>
            <strong>LFO {index}</strong>
            <button
              type="button"
              style={button}
              onClick={() => onCommand({ type: 'removeLfo', lfoId: lfo.id })}
            >
              remove
            </button>
          </div>
          {(['enabled', 'type', 'frequency'] as const).map((key) => {
            const path = `voice.lfos.${index}.${key}` as ParamPath;
            return (
              <ParamControl
                key={path}
                path={path}
                label={key === 'frequency' ? 'rate' : key}
                spec={PARAM_SPECS[path]}
                value={getParam(state, path)}
                onChange={onChange}
              />
            );
          })}
        </div>
      ))}

      {modRoutes.map((route, index) => (
        <div key={route.id} style={slot}>
          <div style={row}>
            <strong>route {index}</strong>
            {/* Velocity needs no LFO slot, so it is selectable even with none added. */}
            <select
              value={route.source}
              onChange={(event) =>
                onChange(
                  `voice.modRoutes.${index}.source` as ParamPath,
                  event.target.value as ParamValue,
                )
              }
              style={button}
            >
              {SOURCES.filter(
                (source) => source.value === 'velocity' || Number(source.value.slice(4)) < lfos.length,
              ).map((source) => (
                <option key={source.value} value={source.value}>
                  {source.label}
                </option>
              ))}
            </select>
            <span style={dim}>→</span>
            <select
              value={route.destination}
              onChange={(event) =>
                onChange(
                  `voice.modRoutes.${index}.destination` as ParamPath,
                  event.target.value as ParamValue,
                )
              }
              style={{ ...button, flex: 1, minWidth: '10rem' }}
            >
              {WIRED_DESTINATIONS.map((destination) => (
                <option key={destination.path} value={destination.path}>
                  {destination.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              style={button}
              onClick={() => onCommand({ type: 'removeRoute', routeId: route.id })}
            >
              remove
            </button>
          </div>
          {(['enabled', 'depth'] as const).map((key) => {
            const path = `voice.modRoutes.${index}.${key}` as ParamPath;
            return (
              <ParamControl
                key={path}
                path={path}
                label={key}
                spec={PARAM_SPECS[path]}
                value={getParam(state, path)}
                onChange={onChange}
              />
            );
          })}
        </div>
      ))}

      <p style={dim}>
        {WIRED_DESTINATIONS.length} of {MODULATION_DESTINATIONS.length} declared destinations
        are wired. The other {PENDING_COUNT} — oscillator width and spread, and every
        effects and EQ band — validate and replay correctly but make no sound until the
        unison mapping and the effects chain land. The runtime names each one it was asked
        for and could not deliver, under Known gaps.
      </p>
    </>
  );
}
