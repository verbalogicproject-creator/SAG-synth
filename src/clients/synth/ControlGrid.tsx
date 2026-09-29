/**
 * src/clients/synth/ControlGrid.tsx — a set of addresses, drawn.
 *
 * The default layout for any group with nothing special about it. Knobs and buttons flow
 * in a grid; sliders take the full width, because an envelope stage or an EQ band read as
 * a length and a narrow column throws that away.
 *
 * The widget choice is not made here — `renderControl` reads it off the registry. This
 * file decides how wide something is and nothing else.
 */

import { controlForPath } from '../../core/controls';
import type { ParamPath } from '../../core/types';
import { renderControl, type ControlProps } from './controls';
import { propsFor, type SurfaceContext } from './controlProps';
import { COLOR } from './tokens';

export interface ControlGridProps {
  context: SurfaceContext;
  paths: readonly ParamPath[];
  /** Names are shortened against this set — defaults to the grid's own paths. */
  within?: readonly ParamPath[];
  /**
   * A last word on one control's props before it draws — how the envelope narrows a stage's
   * travel to its short range and puts the range switch beside the label. Layout-level only:
   * identity, value and the change handler are the registry's and the patch's.
   */
  adjust?: (props: ControlProps) => ControlProps;
}

export function ControlGrid({ context, paths, within, adjust }: ControlGridProps) {
  const scope = within ?? paths;

  return (
    <div style={styles.grid}>
      {paths.map((path) => {
        const wide = controlForPath(path)?.widget === 'slider';
        return (
          <div key={path} style={wide ? styles.wide : styles.cell}>
            {renderControl(adjust === undefined ? propsFor(context, path, scope) : adjust(propsFor(context, path, scope)))}
          </div>
        );
      })}
    </div>
  );
}

const styles = {
  grid: {
    display: 'grid',
    // Wide enough for a knob and its readout; the count follows the screen rather than a
    // breakpoint, so a phone in landscape simply fits more.
    gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
    gap: '0.9rem 0.5rem',
    alignItems: 'start',
    padding: '0.9rem 0.75rem',
    background: COLOR.surfaceLow,
    borderRadius: 6,
  },
  cell: { display: 'flex', justifyContent: 'center' },
  wide: { gridColumn: '1 / -1' },
} as const satisfies Record<string, React.CSSProperties>;
