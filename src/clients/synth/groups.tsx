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
import { defaultLfo, defaultPreset, defaultRoute } from '../../core/state';
import {
  EFFECT_CHAIN_ORDER,
  EQ_BAND_FREQUENCIES,
  MAX_LFOS,
  MAX_ROUTES,
  type EffectId,
  type ModSource,
  type ParamPath,
} from '../../core/types';
import type { SynthCommand } from '../../core/commands';
import { ControlGrid } from './ControlGrid';
import { EnvelopeCurve, Toggle, renderControl } from './controls';
import { MOD_RATES, modRateCommands, readModRate, type ModRate } from '../../core/mod-rate';
import { propsFor, type SurfaceContext } from './controlProps';
import type { ControlProps } from './controls';
import { effectiveFilterEnvelope } from '../../core/ahdsr';
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
function newSlot(count: number, revision: number) {
  const base = defaultPreset().voice.oscillators[0]!;
  // Indexed by count and revision rather than a clock, like the LFO and route slots: two
  // adds inside one millisecond mint the same id, which the reducer then refuses as a
  // duplicate — a button that works except when pressed quickly.
  return { ...base, id: `osc-${count}-${revision}` };
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
            onClick={() =>
              onCommand({
                type: 'addOscillator',
                config: newSlot(slots.length, context.state.revision),
              })
            }
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
  const routes = context.state.patch.voice.modRoutes;
  const [active, setActive] = useState(0);
  const index = Math.min(active, slots.length - 1);

  // An LFO is not a sound. It is a source, and it reaches audio only through a route — so
  // an LFO with no route pointed at it runs, validates, journals and is completely silent.
  // That is what "the LFO isn't working" turned out to mean: the panel looked finished and
  // never mentioned the one thing standing between it and a sound.
  const source = `lfo.${index}`;
  const pointingHere = routes.filter((route) => route.source === source);
  const drivingHere = pointingHere.filter((route) => route.enabled);

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
                // Indexed by length and revision rather than a clock: two adds inside one
                // millisecond produce the same id, which the reducer then refuses.
                config: { ...defaultLfo(), id: `lfo-${slots.length}-${context.state.revision}` },
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
        //
        // It also no longer promises that adding one will modulate anything. It said
        // "add one to modulate the filter, pitch or amplitude", and adding one modulates
        // nothing until a route exists — a sentence the button could not deliver on.
        <p style={styles.note}>
          No LFOs in this patch yet. An LFO is a source: add one, then route it to a
          destination to hear it.
        </p>
      ) : (
        <>
          {drivingHere.length === 0 && (
            <div style={styles.unrouted}>
              <p style={styles.unroutedNote}>
                {pointingHere.length === 0
                  ? 'This LFO drives nothing. It runs, but an LFO only reaches audio through a route.'
                  : `This LFO has ${pointingHere.length} route${pointingHere.length === 1 ? '' : 's'}, all disabled — so it moves nothing.`}
              </p>
              {pointingHere.length === 0 &&
                (routes.length < MAX_ROUTES ? (
                  <button
                    type="button"
                    onClick={() =>
                      onCommand({
                        type: 'addRoute',
                        route: {
                          ...defaultRoute(true),
                          source: source as ModSource,
                          id: `route-${routes.length}-${context.state.revision}`,
                        },
                      })
                    }
                    style={styles.unroutedAction}
                  >
                    route it to the filter cutoff
                  </button>
                ) : (
                  // No button at the cap, for the same reason RouteList draws none: a press
                  // the reducer refuses is a control that appears to work.
                  <span style={styles.unroutedNote}>
                    All {MAX_ROUTES} route slots are in use — free one in ROUTING.
                  </span>
                ))}
            </div>
          )}
          <ControlGrid context={context} paths={lfoPaths(index)} />
        </>
      )}
    </div>
  );
}

const MOD_RATE_LABELS: Record<ModRate, string> = { note: 'NOTE', '16n': '1/16', '8n': '1/8', '4n': '1/4' };

/**
 * MOD RATE: NOTE | 1/16 | 1/8 | 1/4 — how often the cutoff moves (cycle 2, C3; Eyal's "filter
 * mod rate per note, 1/16, 1/8, 1/4").
 *
 * Sugar, on purpose: NOTE is the filter envelope, and 1/x is one LFO locked to the tempo and
 * routed into the cutoff. The row reads the patch (`readModRate`) and dispatches the ordinary
 * commands `modRateCommands` returns, so the LFO and ROUTING tabs show exactly what it did
 * and can take it further — a different shape, a second destination.
 */
export function ModRateGroup({
  context,
  onCommand,
}: {
  context: SurfaceContext;
  onCommand: (command: SynthCommand) => void;
}) {
  const reading = readModRate(context.state.patch);
  const [refusal, setRefusal] = useState<string | null>(null);

  const choose = (rate: ModRate) => {
    const result = modRateCommands(context.state.patch, rate, {
      // Minted here — core must not generate an id. Revision-indexed like the other adds.
      lfoId: `lfo-modrate-${context.state.revision}`,
      routeId: `route-modrate-${context.state.revision}`,
    });
    if (!result.ok) {
      setRefusal(result.reason);
      return;
    }
    setRefusal(null);
    for (const command of result.commands) onCommand(command);
  };

  const depthPath =
    reading.binding === undefined ? undefined : (`voice.modRoutes.${reading.binding.routeIndex}.depth` as ParamPath);

  return (
    <div style={styles.modRate}>
      <div style={styles.modRateHead}>
        <span style={styles.modRateLabel}>MOD RATE</span>
        <div role="radiogroup" aria-label="filter mod rate" style={styles.modRateChoices}>
          {MOD_RATES.map((rate) => {
            const on = reading.rate === rate;
            return (
              <button
                key={rate}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => choose(rate)}
                style={{ ...styles.modRateChoice, ...(on ? styles.modRateChoiceOn : null) }}
              >
                {MOD_RATE_LABELS[rate]}
              </button>
            );
          })}
        </div>
      </div>
      <p style={styles.note}>
        {reading.rate === 'note'
          ? 'Once per note: the filter envelope moves the cutoff (ADSR → FILTER).'
          : `An LFO locked to the tempo moves the cutoff every ${MOD_RATE_LABELS[reading.rate]} — while the sequencer plays. Shape it on the LFO tab.`}
      </p>
      {refusal !== null && <p style={styles.warn}>{refusal}</p>}
      {reading.rate !== 'note' && depthPath !== undefined && (
        <div style={styles.modRateDepth}>
          {renderControl(propsFor(context, depthPath, [depthPath]))}
        </div>
      )}
    </div>
  );
}

/** Short mode's travel for attack, decay and release: a psytrance pluck lives well inside it. */
export const SHORT_RANGE_SECONDS = 2;

type RangeMode = 'short' | 'long';
type RangedStage = 'attack' | 'decay' | 'release';

/**
 * The short/long choice per address, kept for the session so switching AMP ↔ FILTER (which
 * remounts the group) does not forget it. A VIEW of the travel, not a parameter: it is not in
 * the patch, the journal or a preset, because it changes what a drag can reach, never what
 * the patch sounds like.
 */
const rangeChoices = new Map<ParamPath, RangeMode>();

/**
 * Short while the value fits in it, long otherwise. A stored 5 s decay cannot be drawn on a
 * 0–2 s travel without pinning the thumb at the end and lying about where it is, so a value
 * over the short range forces long, and the switch to short is refused until it fits.
 */
function effectiveRange(path: ParamPath, value: number): RangeMode {
  if (value > SHORT_RANGE_SECONDS) return 'long';
  return rangeChoices.get(path) ?? 'short';
}

function RangeSwitch({
  mode,
  label,
  locked,
  onToggle,
}: {
  mode: RangeMode;
  label: string;
  /** True when the value does not fit the short range, so short is not offered. */
  locked: boolean;
  onToggle: () => void;
}) {
  const long = mode === 'long';
  return (
    <button
      type="button"
      aria-label={`${label} range`}
      aria-pressed={long}
      aria-disabled={locked}
      title={locked ? `over ${SHORT_RANGE_SECONDS} s — shorten it to use the short range` : undefined}
      onClick={() => {
        if (!locked) onToggle();
      }}
      style={styles.rangeSwitch}
    >
      <span
        style={{
          ...styles.rangePill,
          color: long ? COLOR.surfaceLowest : COLOR.accent,
          background: long ? COLOR.accent : 'transparent',
          opacity: locked ? 0.6 : 1,
        }}
      >
        {long ? '20S' : '2S'}
      </span>
    </button>
  );
}

/** The curve, then the controls that shape it. */
export function EnvelopeGroup({
  context,
  stages,
  hold,
  curve,
  link,
  extra = [],
  label,
}: {
  context: SurfaceContext;
  /** attack, decay, sustain, release — in that order. */
  stages: readonly [ParamPath, ParamPath, ParamPath, ParamPath];
  /** AHDSR: the hold stage and the decay shape (schema_version 5). */
  hold: ParamPath;
  curve: ParamPath;
  /**
   * The filter envelope's link to the amp (schema_version 6). While it is on, the curve draws
   * the stages the filter actually RUNS — the amp's, via `effectiveFilterEnvelope` — with no
   * handles, and the stage sliders below show the filter's own stored values as ignored.
   */
  link?: ParamPath;
  extra?: readonly ParamPath[];
  label: string;
}) {
  // Re-render on a range switch; the choice itself lives in `rangeChoices`.
  const [, setRevision] = useState(0);
  const read = (path: ParamPath) => {
    const value = getParam(context.state, path);
    return typeof value === 'number' ? value : 0;
  };

  const linked = link !== undefined && getParam(context.state, link) === true;
  const runs = linked ? effectiveFilterEnvelope(context.state.patch.voice) : undefined;

  const ranged: ReadonlyArray<[RangedStage, ParamPath]> = [
    ['attack', stages[0]],
    ['decay', stages[1]],
    ['release', stages[3]],
  ];
  const specMax = (path: ParamPath) => {
    const spec = PARAM_SPECS[path];
    return spec.kind === 'number' ? spec.max : SHORT_RANGE_SECONDS;
  };
  const modeOf = (path: ParamPath) => effectiveRange(path, read(path));
  const travel = (path: ParamPath) => (modeOf(path) === 'short' ? SHORT_RANGE_SECONDS : specMax(path));

  const ranges = Object.fromEntries(ranged.map(([stage, path]) => [stage, travel(path)]));
  const shape = runs?.decayCurve ?? getParam(context.state, curve);
  const decayCurve = shape === 'linear' || shape === 'logarithmic' ? shape : 'exponential';

  const adjust = (props: ControlProps): ControlProps => {
    const entry = ranged.find(([, path]) => path === props.path);
    if (entry === undefined || props.spec.kind !== 'number') return props;
    const path = entry[1];
    const mode = modeOf(path);
    return {
      ...props,
      spec: { ...props.spec, max: travel(path) },
      accessory: (
        <RangeSwitch
          mode={mode}
          label={props.label}
          locked={read(path) > SHORT_RANGE_SECONDS}
          onToggle={() => {
            rangeChoices.set(path, mode === 'short' ? 'long' : 'short');
            setRevision((n) => n + 1);
          }}
        />
      ),
    };
  };

  return (
    <div>
      {link !== undefined && <ControlGrid context={context} paths={[link]} />}
      <div style={styles.curveFrame}>
        <EnvelopeCurve
          label={linked ? `${label} (linked to amp)` : label}
          attack={runs?.attack ?? read(stages[0])}
          decay={runs?.decay ?? read(stages[1])}
          sustain={runs?.sustain ?? read(stages[2])}
          release={runs?.release ?? read(stages[3])}
          ranges={ranges}
          // Draggable: the handles dispatch the same `setParam` the sliders below do, so
          // the curve gains a second way to reach these values and no second opinion about
          // what they are. Linked, the drawn stages are the amp's, and a handle here would
          // edit a stored value the filter is not running — so there are none.
          stages={linked ? undefined : stages}
          hold={runs?.hold ?? read(hold)}
          holdPath={linked ? undefined : hold}
          decayCurve={decayCurve}
          onChange={context.onChange}
        />
      </div>
      {/* AHDSR order: attack, hold, decay, the decay's shape, sustain, release. */}
      <ControlGrid
        context={context}
        paths={[stages[0], hold, stages[1], curve, stages[2], stages[3], ...extra]}
        adjust={adjust}
      />
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
  modRate: {
    background: COLOR.surfaceLow,
    borderRadius: 6,
    padding: '0.6rem 0.75rem',
    marginBottom: '0.6rem',
  },
  modRateHead: { display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' },
  modRateLabel: {
    fontFamily: FONT.display,
    fontSize: '0.65rem',
    letterSpacing: '0.08em',
    color: COLOR.textDim,
  },
  modRateChoices: { display: 'flex', gap: '0.3rem', flex: '1 1 auto' },
  modRateChoice: {
    flex: '1 1 0',
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    background: 'transparent',
    color: COLOR.textDim,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 4,
    fontFamily: FONT.mono,
    fontSize: '0.75rem',
    cursor: 'pointer',
  },
  modRateChoiceOn: { color: COLOR.surfaceLowest, background: COLOR.accent, borderColor: COLOR.accent },
  modRateDepth: { maxWidth: 160, marginTop: '0.4rem' },
  /**
   * The range switch sits in the slider's label row, so it must not make that row 44px
   * tall. The button IS 44px (a real touch target); negative margins let it overhang the
   * row instead of stretching it — the same trick as the envelope handles, a big target
   * around a small visible pill.
   */
  rangeSwitch: {
    minWidth: TOUCH_MIN,
    height: TOUCH_MIN,
    margin: '-12px 0',
    padding: 0,
    background: 'transparent',
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  rangePill: {
    fontFamily: FONT.mono,
    fontSize: '0.6rem',
    letterSpacing: '0.04em',
    padding: '0.1rem 0.35rem',
    borderRadius: 3,
    border: `1px solid ${COLOR.accent}`,
  },
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
  unrouted: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
    alignItems: 'flex-start',
    margin: '0 0 0.6rem',
    padding: '0.5rem 0.6rem',
    borderStyle: 'solid',
    borderWidth: 1,
    borderColor: COLOR.unwired,
    borderRadius: 4,
  },
  unroutedNote: {
    margin: 0,
    fontFamily: FONT.display,
    fontSize: '0.65rem',
    lineHeight: 1.5,
    color: COLOR.unwired,
  },
  unroutedAction: {
    minHeight: TOUCH_MIN,
    padding: '0 0.8rem',
    background: 'transparent',
    color: COLOR.accentText,
    borderStyle: 'solid',
    borderWidth: 1,
    borderColor: COLOR.accent,
    borderRadius: 4,
    fontFamily: FONT.display,
    fontSize: '0.65rem',
    letterSpacing: '0.08em',
    cursor: 'pointer',
  },
  note: {
    margin: '0.5rem 0.25rem 0',
    fontFamily: FONT.display,
    fontSize: '0.65rem',
    color: COLOR.textDim,
  },
  warn: {
    margin: '0.4rem 0.25rem 0',
    fontFamily: FONT.display,
    fontSize: '0.65rem',
    color: COLOR.ignored,
  },
} as const satisfies Record<string, React.CSSProperties>;
