/**
 * src/clients/debug/OscillatorPanel.tsx — the oscillator section, one panel per slot.
 *
 * Generated from `SIGNAL_CHAIN`'s oscillator section rather than a hand-written list, so
 * a parameter added to the chain appears here without touching this file. Since
 * schema_version 3 that section is a slot FAMILY rather than five fixed paths, which is
 * why this now draws a list with add and remove — the same shape `ModPanel` uses for LFOs
 * and routes, because it is the same problem.
 *
 * Throwaway like the rest of `debug/`. What it has to do is make three oscillators
 * audible: an offline gate proving two slots beat against each other is not the same as
 * hearing it, and every capability this project shipped without a control on this surface
 * was reported broken within the hour.
 */

import { SIGNAL_CHAIN } from '../../core/groups';
import { OSC_PARAM_KEYS, PARAM_SPECS } from '../../core/schemas';
import { getParam } from '../../core/params';
import type { EngineState } from '../../core/state';
import type { SynthCommand } from '../../core/commands';
import { MAX_OSCILLATORS, type ParamPath, type ParamValue } from '../../core/types';
import { ParamControl } from './ParamControl';

export interface OscillatorPanelProps {
  state: EngineState;
  onChange: (path: ParamPath, value: ParamValue) => void;
  onCommand: (command: SynthCommand) => void;
  /** Combinations this patch sets that its oscillator types cannot honour, per slot. */
  unsupported: readonly string[];
}

const LABELS: Partial<Record<string, string>> = {
  enabled: 'on',
  type: 'shape',
  octave: 'octave',
  detune: 'detune',
  count: 'unison',
  spread: 'spread',
  width: 'pulse width',
  level: 'level',
  pan: 'pan',
};

const section = SIGNAL_CHAIN.find((s) => s.id === 'oscillator');

const slot: React.CSSProperties = {
  border: '1px solid #333',
  borderRadius: 4,
  padding: '0.5rem',
  marginBottom: '0.5rem',
};

const head: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
  marginBottom: '0.4rem',
};

const button: React.CSSProperties = {
  padding: '0.35rem 0.7rem',
  background: '#1c1c1c',
  color: '#ddd',
  border: '1px solid #444',
  borderRadius: 4,
  fontFamily: 'inherit',
};

const warn: React.CSSProperties = { color: '#b58900', fontSize: '0.8rem', margin: '0.4rem 0 0' };
const dim: React.CSSProperties = { color: '#888', fontSize: '0.8rem' };

/** A new slot, neutral: audible immediately, and detuned by nothing until asked. */
function newSlot(index: number) {
  return {
    id: `osc-${index}-${Date.now().toString(36)}`,
    enabled: true,
    type: 'sawtooth' as const,
    octave: 0,
    detune: 0,
    count: 1,
    spread: 20,
    width: 0,
    level: 1,
    pan: 0,
  };
}

export function OscillatorPanel({ state, onChange, onCommand, unsupported }: OscillatorPanelProps) {
  const slots = state.patch.voice.oscillators;

  return (
    <>
      {slots.map((config, index) => {
        // Gaps are reported as `oscillator.<slot>.<what>`, so each panel shows only its own.
        const mine = unsupported.filter((gap) => gap.startsWith(`oscillator.${index}.`));
        return (
          <div key={config.id} style={slot}>
            <div style={head}>
              <strong style={{ color: config.enabled ? '#ddd' : '#666' }}>slot {index}</strong>
              <span style={dim}>{config.type}</span>
              {!config.enabled && <span style={dim}>muted — settings kept</span>}
              <span style={{ flex: 1 }} />
              <button
                type="button"
                style={button}
                disabled={slots.length === 1}
                title={slots.length === 1 ? 'a voice needs at least one slot' : undefined}
                onClick={() =>
                  onCommand({ type: 'removeOscillator', oscillatorId: config.id })
                }
              >
                remove
              </button>
            </div>

            {OSC_PARAM_KEYS.map((key) => {
              const path = `voice.oscillators.${index}.${key}` as ParamPath;
              return (
                <ParamControl
                  key={path}
                  path={path}
                  label={LABELS[key] ?? key}
                  spec={PARAM_SPECS[path]}
                  value={getParam(state, path)}
                  onChange={onChange}
                />
              );
            })}

            {/*
              Tone's type-string grammar is not the orthogonal parameter space these
              controls imply: there is no fatpulse, and width belongs to pulse alone.
              Rather than disable controls — which would hide a real patch value that is
              still stored and still replayed — say what is being ignored right now.
            */}
            {mine.length > 0 && (
              <p style={warn}>
                {config.type === 'noise'
                  ? 'noise needs a source shape this voice does not build — sounding as sawtooth. '
                  : ''}
                ignored for shape “{config.type}”: {mine.join(', ')}
              </p>
            )}
          </div>
        );
      })}

      <button
        type="button"
        style={button}
        disabled={slots.length >= MAX_OSCILLATORS}
        onClick={() => onCommand({ type: 'addOscillator', config: newSlot(slots.length) })}
      >
        + oscillator slot
      </button>

      <p style={dim}>
        {slots.length} of {section?.slotCount ?? MAX_OSCILLATORS} slots. Levels sum and
        nothing normalises them — three slots at 1.0 are three times the signal, and the
        limiter is what keeps that in range.
      </p>
    </>
  );
}
