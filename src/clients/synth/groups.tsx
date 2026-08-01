/**
 * src/clients/synth/groups.tsx — the three groups that are not just a grid.
 *
 * Oscillators are a slot family, so one slot is on screen at a time behind A/B/C. The
 * envelopes want their shape drawn above the sliders that make it. Effects are cards with
 * their own ACTIVE/BYPASS, which is a COMMAND rather than a parameter.
 *
 * Everything else in the instrument is `ControlGrid`, and these three earn the exception
 * by being the places the design actually says something.
 */

import { useState } from 'react';
import { sectionPaths } from '../../core/groups';
import { PARAM_SPECS } from '../../core/schemas';
import { getParam } from '../../core/params';
import { defaultLfo, defaultPreset } from '../../core/state';
import {
  EFFECT_CHAIN_ORDER,
  EQ_BAND_FREQUENCIES,
  MAX_LFOS,
  type EffectId,
  type ParamPath,
} from '../../core/types';
import type { SynthCommand } from '../../core/commands';
import { ControlGrid } from './ControlGrid';
import { EnvelopeCurve, Toggle } from './controls';
import { propsFor, type SurfaceContext } from './controlProps';
import { COLOR, FONT, TOUCH_MIN } from './tokens';

const SLOT_NAMES = ['A', 'B', 'C'];

/**
 * A fresh slot, taken from the factory patch rather than written out again — the debug
 * wall has its own literal copy of these ten fields and a second one here would be a third
 * opinion about what an oscillator starts as.
 *
 * The id is minted in the client because core is forbidden from generating one: an id
 * invented inside a reducer would differ on replay and break the journal.
 */
function newSlot() {
  const base = defaultPreset().voice.oscillators[0]!;
  return { ...base, id: `osc-${Date.now().toString(36)}` };
}

/** Paths of one oscillator slot, in the order the panel draws them. */
function slotPaths(index: number): ParamPath[] {
  return sectionPaths('oscillator').filter((path) => path.startsWith(`voice.oscillators.${index}.`));
}

/**
 * One slot at a time, which is what the mockup draws and what a phone has room for.
 *
 * Only slots the patch actually holds get a tab. `voice.oscillators` is a list capped at
 * MAX_OSCILLATORS, and a route or a control pointed at a slot that does not exist is
 * correctly inert — offering a fourth letter would be offering a control that cannot work.
 */
export function OscillatorGroup({
  context,
  onCommand,
}: {
  context: SurfaceContext;
  onCommand: (command: SynthCommand) => void;
}) {
  const slots = context.state.patch.voice.oscillators;
  const [active, setActive] = useState(0);
  const index = Math.min(active, slots.length - 1);

  return (
    <div>
      <div style={styles.subBar} role="tablist" aria-label="oscillator slot">
        {slots.map((slot, i) => (
          <button
            key={slot.id}
            type="button"
            role="tab"
            aria-selected={i === index}
            onClick={() => setActive(i)}
            style={{ ...styles.subTab, ...(i === index ? styles.subTabOn : null) }}
          >
            {SLOT_NAMES[i] ?? String(i + 1)}
          </button>
        ))}
        {slots.length < SLOT_NAMES.length && (
          <button
            type="button"
            onClick={() => onCommand({ type: 'addOscillator', config: newSlot() })}
            style={styles.subTab}
            aria-label="add an oscillator slot"
          >
            +
          </button>
        )}
        {slots.length > 1 && (
          <button
            type="button"
            onClick={() =>
              onCommand({ type: 'removeOscillator', oscillatorId: slots[index]!.id })
            }
            style={styles.subTab}
            aria-label={`remove oscillator ${SLOT_NAMES[index]}`}
          >
            −
          </button>
        )}
      </div>
      <ControlGrid context={context} paths={slotPaths(index)} />
    </div>
  );
}

/** Paths of one LFO slot, in the order the panel draws them. */
function lfoPaths(index: number): ParamPath[] {
  return sectionPaths('lfo').filter((path) => path.startsWith(`voice.lfos.${index}.`));
}

/**
 * One LFO at a time, and only the ones the patch actually holds.
 *
 * This group exists because drawing all four slots unconditionally shipped twenty controls
 * that could not be changed: the factory patch has `lfos: []`, so every `setParam` at
 * `voice.lfos.N.*` was REJECTED by the reducer and silently discarded by the surface. The
 * whole tab looked finished and did nothing — the failure this project keeps shipping.
 *
 * `OscillatorGroup` above had already solved it. This is the same shape, and the fix is
 * that the surface now tells the truth about a slot family: what exists is drawn, what does
 * not exist is offered.
 */
export function LfoGroup({
  context,
  onCommand,
}: {
  context: SurfaceContext;
  onCommand: (command: SynthCommand) => void;
}) {
  const slots = context.state.patch.voice.lfos;
  const [active, setActive] = useState(0);
  const index = Math.min(active, slots.length - 1);

  return (
    <div>
      <div style={styles.subBar} role="tablist" aria-label="lfo slot">
        {slots.map((slot, i) => (
          <button
            key={slot.id}
            type="button"
            role="tab"
            aria-selected={i === index}
            onClick={() => setActive(i)}
            style={{ ...styles.subTab, ...(i === index ? styles.subTabOn : null) }}
          >
            {i + 1}
          </button>
        ))}
        {slots.length < MAX_LFOS && (
          <button
            type="button"
            onClick={() =>
              onCommand({
                type: 'addLfo',
                // Settings from core, id minted here — core must not generate one.
                config: { ...defaultLfo(), id: `lfo-${Date.now().toString(36)}` },
              })
            }
            style={styles.subTab}
            aria-label="add an lfo"
          >
            +
          </button>
        )}
        {slots.length > 0 && (
          <button
            type="button"
            onClick={() => onCommand({ type: 'removeLfo', lfoId: slots[index]!.id })}
            style={styles.subTab}
            aria-label={`remove lfo ${index + 1}`}
          >
            −
          </button>
        )}
      </div>
      {slots.length === 0 ? (
        // Honest empty state. Saying "no LFOs yet" is not a smaller surface than four dead
        // panels — it is the only one of the two that is true.
        <p style={styles.note}>
          No LFOs in this patch yet. Add one to modulate the filter, pitch or amplitude.
        </p>
      ) : (
        <ControlGrid context={context} paths={lfoPaths(index)} />
      )}
    </div>
  );
}

/** The curve, then the controls that shape it. */
export function EnvelopeGroup({
  context,
  stages,
  extra = [],
  label,
}: {
  context: SurfaceContext;
  /** attack, decay, sustain, release — in that order. */
  stages: readonly [ParamPath, ParamPath, ParamPath, ParamPath];
  extra?: readonly ParamPath[];
  label: string;
}) {
  const read = (path: ParamPath) => {
    const value = getParam(context.state, path);
    return typeof value === 'number' ? value : 0;
  };

  // The horizontal scale, taken from the spec rather than assumed: an attack that can
  // reach 20 s and one capped at 2 s must not draw the same picture for the same number.
  const attackSpec = PARAM_SPECS[stages[0]];
  const maxStage = attackSpec.kind === 'number' ? attackSpec.max : 1;

  return (
    <div>
      <div style={styles.curveFrame}>
        <EnvelopeCurve
          label={label}
          attack={read(stages[0])}
          decay={read(stages[1])}
          sustain={read(stages[2])}
          release={read(stages[3])}
          maxStage={maxStage}
          // Draggable: the handles dispatch the same `setParam` the sliders below do, so
          // the curve gains a second way to reach these four values and no second opinion
          // about what they are.
          stages={stages}
          onChange={context.onChange}
        />
      </div>
      <ControlGrid context={context} paths={[...stages, ...extra]} />
    </div>
  );
}

/**
 * Per-effect cards, in chain order, plus the output stage.
 *
 * ACTIVE/BYPASS is a `setEffectEnabled` command rather than a `setParam`, which is an
 * asymmetry in the contract — `effects.eq.enabled` IS a parameter while the other four
 * enables are verbs. Drawn identically here because a player cannot see the difference and
 * should not have to.
 */
export function EffectsGroup({
  context,
  outputPaths,
  onCommand,
}: {
  context: SurfaceContext;
  outputPaths: readonly ParamPath[];
  onCommand: (command: SynthCommand) => void;
}) {
  const effects = context.state.patch.effects;
  const all = sectionPaths('effects');

  return (
    <div style={styles.cards}>
      {EFFECT_CHAIN_ORDER.map((id: EffectId) => {
        const paths = all.filter((path) => path.startsWith(`effects.${id}.`));
        const enabled = effects[id].enabled;
        return (
          <section key={id} style={styles.card}>
            <header style={styles.cardHead}>
              <h3 style={styles.cardTitle}>{id}</h3>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={`${id} active`}
                onClick={() => onCommand({ type: 'setEffectEnabled', effectId: id, enabled: !enabled })}
                style={{
                  ...styles.bypass,
                  background: enabled ? COLOR.accent : 'transparent',
                  color: enabled ? COLOR.surfaceLowest : COLOR.textDim,
                  borderColor: enabled ? COLOR.accent : COLOR.border,
                }}
              >
                {enabled ? 'ACTIVE' : 'BYPASS'}
              </button>
            </header>
            <ControlGrid context={context} paths={paths} />
          </section>
        );
      })}

      <section style={styles.card}>
        <header style={styles.cardHead}>
          <h3 style={styles.cardTitle}>eq</h3>
          {/* A parameter, not a verb — so it is a Toggle like any other boolean. */}
          <Toggle
            {...propsFor(context, 'effects.eq.enabled', ['effects.eq.enabled'])}
            wording={['ACTIVE', 'BYPASS']}
          />
        </header>
        <ControlGrid
          context={context}
          paths={sectionPaths('eq').filter((path) => path !== 'effects.eq.enabled')}
        />
        <p style={styles.note}>
          Bands sit at {EQ_BAND_FREQUENCIES.join(', ')} Hz.
        </p>
      </section>

      <section style={styles.card}>
        <header style={styles.cardHead}>
          <h3 style={styles.cardTitle}>output</h3>
        </header>
        <ControlGrid context={context} paths={outputPaths} />
      </section>
    </div>
  );
}

/** Shared by the sub-tab bars, so the OSC letters and the FILTER/LFO/EQ row match. */
export const styles = {
  subBar: { display: 'flex', gap: '0.3rem', marginBottom: '0.5rem' },
  subTab: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    background: 'transparent',
    color: COLOR.textDim,
    // Longhand, not the `border` shorthand, because `subTabOn` overrides `borderColor`
    // alone — and React warns (correctly) that removing a longhand while a conflicting
    // shorthand is set produces a style that depends on render order. The control kit
    // already writes borders this way; this was the one place that did not.
    borderStyle: 'solid',
    borderWidth: 1,
    borderColor: COLOR.border,
    borderRadius: 4,
    fontFamily: FONT.display,
    fontSize: '0.8rem',
    letterSpacing: '0.06em',
    cursor: 'pointer',
  },
  subTabOn: { background: COLOR.surfaceHigh, color: COLOR.accentText, borderColor: COLOR.accent },
  curveFrame: { padding: '0 0.25rem 0.6rem' },
  cards: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  card: { background: COLOR.surfaceLowest, borderRadius: 6, padding: '0.6rem 0.5rem' },
  cardHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
    padding: '0 0.25rem 0.5rem',
  },
  cardTitle: {
    margin: 0,
    fontFamily: FONT.display,
    fontSize: '0.8rem',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: COLOR.accentText,
  },
  bypass: {
    minHeight: TOUCH_MIN,
    padding: '0 0.8rem',
    borderRadius: 4,
    borderStyle: 'solid',
    borderWidth: 1,
    fontFamily: FONT.mono,
    fontSize: '0.7rem',
    cursor: 'pointer',
  },
  note: {
    margin: '0.5rem 0.25rem 0',
    fontFamily: FONT.display,
    fontSize: '0.65rem',
    color: COLOR.textDim,
  },
} as const satisfies Record<string, React.CSSProperties>;
