/**
 * src/clients/synth/SynthPanels.tsx — the four tabs and the bar that switches them.
 *
 * Presentational and state-free: it receives an `EngineState` and two callbacks and owns
 * nothing but which tab is showing. The engine, the audio graph and the dispatcher stay
 * where they are — 4.6 mounts this beside the debug wall, and a panel that reached for a
 * runtime would make two mount points into two engines, which this project has already
 * done twice by accident.
 *
 * The tab list is `NAV_TABS`, not a literal. That is the whole point of 4.1: the bar and
 * the coverage gate read the same declaration, so a tab cannot exist without its contents
 * being reachable and a parameter cannot be added without landing somewhere.
 */

import { useMemo, useState } from 'react';
import { NAV_TABS } from '../../core/groups';
import type { SynthCommand } from '../../core/commands';
import type { EngineState } from '../../core/state';
import type { ParamPath, ParamValue } from '../../core/types';
import { TabView } from './TabView';
import { surfaceContext } from './controlProps';
import { COLOR, FONT, TOUCH_MIN } from './tokens';

export interface SynthPanelsProps {
  state: EngineState;
  onChange: (path: ParamPath, value: ParamValue) => void;
  onCommand: (command: SynthCommand) => void;
}

export function SynthPanels({ state, onChange, onCommand }: SynthPanelsProps) {
  const [active, setActive] = useState(0);
  const tab = NAV_TABS[Math.min(active, NAV_TABS.length - 1)]!;

  // `ignoredIn` and `modulationLoad` each walk the whole patch, so they run once per
  // render rather than once per control.
  const context = useMemo(() => surfaceContext(state, onChange), [state, onChange]);

  return (
    <div style={styles.shell}>
      <nav style={styles.bar} role="tablist" aria-label="signal path">
        {NAV_TABS.map((candidate, index) => {
          const on = candidate.id === tab.id;
          return (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={`panel-${candidate.id}`}
              onClick={() => setActive(index)}
              style={{
                ...styles.tab,
                color: on ? COLOR.accentText : COLOR.textDim,
                borderBottomColor: on ? COLOR.accent : 'transparent',
              }}
            >
              {candidate.label}
            </button>
          );
        })}
      </nav>

      <div id={`panel-${tab.id}`} role="tabpanel" style={styles.body}>
        <TabView tab={tab} context={context} onCommand={onCommand} />
      </div>
    </div>
  );
}

const styles = {
  shell: {
    background: COLOR.surface,
    color: COLOR.text,
    fontFamily: FONT.display,
    minHeight: '100%',
  },
  bar: {
    display: 'flex',
    position: 'sticky',
    top: 0,
    zIndex: 2,
    background: COLOR.surfaceLowest,
    borderBottom: `1px solid ${COLOR.border}`,
  },
  tab: {
    flex: '1 1 0',
    minHeight: TOUCH_MIN,
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    fontFamily: FONT.display,
    fontSize: '0.75rem',
    letterSpacing: '0.14em',
    cursor: 'pointer',
  },
  body: { padding: '0.6rem 0.5rem 2rem' },
} as const satisfies Record<string, React.CSSProperties>;
