/**
 * src/clients/synth/RouteList.tsx — routing as a list, which is `05-mod-matrix` as drawn.
 *
 * Built before the jackfield on purpose. The bay is the one component in this phase with
 * no mockup and the plan names it the largest unknown, so the mitigation was declared in
 * advance: build the list first and there is never a state where the instrument has no way
 * to route. If the cables slip, this ships.
 *
 * It is also the honest home for the eighteen destinations that reach no audio node. A
 * jackfield drawing eighteen dead sockets identically to the thirteen live ones is a wall
 * of decoys; a list can simply say so on the row.
 *
 * Every control here is the same kit the tabs use, generated from `voice.modRoutes.N.*` —
 * so a route's depth obeys the same signed contract, prints through the same
 * `describeDepth`, and dispatches the same `setParam` as a knob on any other screen.
 */

import { describeDepth } from '../../core/params';
import { describeLoad, modulationLoad } from '../../core/modulation';
import { MAX_ROUTES, isDestinationWired, type ModDestination, type ParamPath } from '../../core/types';
import type { SynthCommand } from '../../core/commands';
import { renderControl } from './controls';
import { propsFor, type SurfaceContext } from './controlProps';
import { COLOR, FONT, TOUCH_MIN } from './tokens';

export interface RouteListProps {
  context: SurfaceContext;
  onCommand: (command: SynthCommand) => void;
}

/** A new route starts pointed at the cutoff, which is the one every player reaches for. */
function newRoute() {
  return {
    id: `route-${Date.now().toString(36)}`,
    enabled: true,
    source: 'lfo.0' as const,
    destination: 'voice.filterEnvelope.baseFrequency' as ModDestination,
    depth: 0.3,
  };
}

export function RouteList({ context, onCommand }: RouteListProps) {
  const { state } = context;
  const routes = state.patch.voice.modRoutes;
  const lfos = state.patch.voice.lfos;
  const loads = modulationLoad(state);
  const overflowing = loads.filter((load) => load.overflows);

  return (
    <div style={styles.wrap}>
      <header style={styles.stats}>
        <Stat label="routes" value={`${routes.filter((r) => r.enabled).length}/${routes.length}`} />
        <Stat label="targets" value={String(loads.length)} />
        <Stat
          label="overflow"
          value={String(overflowing.length)}
          tint={overflowing.length > 0 ? COLOR.overflow : undefined}
        />
      </header>

      {routes.length === 0 && (
        <p style={styles.empty}>
          No routes. A route takes one LFO or the velocity you played with, and moves a
          parameter with it.
        </p>
      )}

      {lfos.length === 0 && routes.length > 0 && (
        // Sources are declared for four LFOs whether or not the patch holds any, so a
        // route can point at `lfo.0` when there is no lfo.0 to point at. Saying so beats
        // drawing a route that looks connected.
        <p style={styles.warn}>This patch has no LFOs, so every route below has no source.</p>
      )}

      {routes.map((route, index) => {
        const at = (key: string) => `voice.modRoutes.${index}.${key}` as ParamPath;
        const within = ['enabled', 'source', 'destination', 'depth'].map(at);
        const wired = isDestinationWired(route.destination);
        const load = loads.find((candidate) => candidate.destination === route.destination);

        return (
          <section key={route.id} style={styles.row}>
            <div style={styles.rowHead}>
              <span style={styles.index}>{index + 1}</span>
              <div style={styles.enabled}>{renderControl(propsFor(context, at('enabled'), within))}</div>
              <button
                type="button"
                onClick={() => onCommand({ type: 'removeRoute', routeId: route.id })}
                style={styles.remove}
                aria-label={`remove route ${index + 1}`}
              >
                ✕
              </button>
            </div>

            <div style={styles.pickers}>
              {renderControl(propsFor(context, at('source'), within))}
              {renderControl(propsFor(context, at('destination'), within))}
            </div>

            <div style={styles.depth}>
              {renderControl(propsFor(context, at('depth'), within))}
              {/*
                What the depth means where it lands. The destination declares its own curve,
                so the same 0.4 reads as an octave span here and a duck in dB there —
                derived, never a switch in this file.
              */}
              <span style={styles.depthNote}>
                {describeDepth(route.destination, route.depth) ?? 'not modulatable'}
              </span>
            </div>

            {!wired && (
              <p style={styles.unwired}>
                Declared and replayable, but nothing is connected at the far end — this
                route moves no sound.
              </p>
            )}
            {load?.overflows === true && (
              <p style={styles.warn}>{describeLoad(load)}</p>
            )}
          </section>
        );
      })}

      {routes.length < MAX_ROUTES ? (
        <button
          type="button"
          onClick={() => onCommand({ type: 'addRoute', route: newRoute() })}
          style={styles.add}
        >
          + route
        </button>
      ) : (
        // No button at the cap. A press that the reducer refuses is a control that
        // appears to work, which is the failure this whole surface is armoured against.
        <p style={styles.empty}>All {MAX_ROUTES} route slots are in use.</p>
      )}

      {overflowing.length > 0 && (
        <div style={styles.overflowBox}>
          <strong>more travel than the parameter has</strong>
          <ul style={styles.overflowList}>
            {overflowing.map((load) => (
              <li key={load.destination}>{describeLoad(load)}</li>
            ))}
          </ul>
          <p style={styles.overflowNote}>
            Nothing is broken and nothing is being corrected. The depths are what the patch
            asked for; normalising them would make one route&apos;s effect depend on whether
            a sibling is enabled. Lower a depth, or accept the clamp.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <div style={styles.stat}>
      <span style={styles.statLabel}>{label}</span>
      <span style={{ ...styles.statValue, color: tint ?? COLOR.accentText }}>{value}</span>
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '0.6rem' },
  stats: {
    display: 'flex',
    gap: '0.5rem',
    padding: '0.5rem 0.6rem',
    background: COLOR.surfaceLowest,
    borderRadius: 6,
  },
  stat: { flex: '1 1 0', textAlign: 'center' },
  statLabel: {
    display: 'block',
    fontFamily: FONT.display,
    fontSize: '0.6rem',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: COLOR.textDim,
  },
  statValue: { fontFamily: FONT.mono, fontSize: '1rem', fontVariantNumeric: 'tabular-nums' },

  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    padding: '0.6rem',
    background: COLOR.surfaceLow,
    borderRadius: 6,
  },
  rowHead: { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  index: {
    fontFamily: FONT.mono,
    fontSize: '0.8rem',
    color: COLOR.textDim,
    minWidth: '1.2rem',
  },
  enabled: { flex: 1 },
  remove: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    background: 'transparent',
    color: COLOR.textDim,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 4,
    cursor: 'pointer',
  },
  pickers: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  depth: { display: 'flex', flexDirection: 'column', gap: '0.2rem' },
  depthNote: {
    fontFamily: FONT.mono,
    fontSize: '0.7rem',
    color: COLOR.accentText,
    textAlign: 'right',
  },

  unwired: {
    margin: 0,
    fontFamily: FONT.display,
    fontSize: '0.65rem',
    color: COLOR.unwired,
  },
  warn: { margin: 0, fontFamily: FONT.display, fontSize: '0.65rem', color: COLOR.overflow },

  add: {
    minHeight: TOUCH_MIN,
    background: 'transparent',
    color: COLOR.accentText,
    border: `1px solid ${COLOR.accent}`,
    borderRadius: 4,
    fontFamily: FONT.display,
    fontSize: '0.75rem',
    letterSpacing: '0.1em',
    cursor: 'pointer',
  },
  empty: {
    margin: 0,
    fontFamily: FONT.display,
    fontSize: '0.7rem',
    color: COLOR.textDim,
  },
  overflowBox: {
    padding: '0.6rem',
    border: `1px solid ${COLOR.overflow}`,
    borderRadius: 6,
    fontFamily: FONT.display,
    fontSize: '0.7rem',
    color: COLOR.text,
  },
  overflowList: { margin: '0.4rem 0 0', paddingLeft: '1.1rem' },
  overflowNote: { margin: '0.4rem 0 0', color: COLOR.textDim, fontSize: '0.65rem' },
} as const satisfies Record<string, React.CSSProperties>;
