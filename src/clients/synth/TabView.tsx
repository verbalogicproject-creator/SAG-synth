/**
 * src/clients/synth/TabView.tsx — one tab, drawn from its declaration.
 *
 * Walks the `NAV_TABS` entry it is given: a sub-tab bar when the tab has more than one
 * group, then that group's controls. Which group needs a special layout is decided by its
 * identity, not by a flag on the declaration — `NAV_TABS` says what belongs together and
 * this file says what that looks like, which is the split the whole phase rests on.
 *
 * A group with nothing special about it is a `ControlGrid`, and most of them are.
 */

import { useState } from 'react';
import { groupPaths, type NavTab } from '../../core/groups';
import type { SynthCommand } from '../../core/commands';
import type { ParamPath } from '../../core/types';
import { ControlGrid } from './ControlGrid';
import {
  EffectsGroup,
  EnvelopeGroup,
  LfoGroup,
  OscillatorGroup,
  styles as groupStyles,
} from './groups';
import type { SurfaceContext } from './controlProps';
import { COLOR, FONT } from './tokens';

const AMP_STAGES = [
  'voice.envelope.attack',
  'voice.envelope.decay',
  'voice.envelope.sustain',
  'voice.envelope.release',
] as const;

const FILTER_STAGES = [
  'voice.filterEnvelope.attack',
  'voice.filterEnvelope.decay',
  'voice.filterEnvelope.sustain',
  'voice.filterEnvelope.release',
] as const;

export interface TabViewProps {
  tab: NavTab;
  context: SurfaceContext;
  onCommand: (command: SynthCommand) => void;
}

export function TabView({ tab, context, onCommand }: TabViewProps) {
  const [activeGroup, setActiveGroup] = useState(0);
  const index = Math.min(activeGroup, tab.groups.length - 1);
  const group = tab.groups[index]!;
  const paths = groupPaths(group) as ParamPath[];

  return (
    <div>
      {tab.groups.length > 1 && (
        <div style={groupStyles.subBar} role="tablist" aria-label={`${tab.label} sections`}>
          {tab.groups.map((candidate, i) => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              onClick={() => setActiveGroup(i)}
              style={{
                ...groupStyles.subTab,
                ...(i === index ? groupStyles.subTabOn : null),
                flex: '1 1 0',
              }}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      )}

      <p style={styles.summary}>{tab.summary}</p>

      {body()}
    </div>
  );

  function body() {
    if (tab.id === 'osc') {
      return <OscillatorGroup context={context} onCommand={onCommand} />;
    }
    if (tab.id === 'adsr') {
      return group.id === 'amp' ? (
        <EnvelopeGroup
          context={context}
          label="amp envelope"
          stages={AMP_STAGES}
          extra={paths.filter((path) => !AMP_STAGES.includes(path as (typeof AMP_STAGES)[number]))}
        />
      ) : (
        <EnvelopeGroup context={context} label="filter envelope" stages={FILTER_STAGES} />
      );
    }
    // A slot family, so only the slots the patch holds are drawn — see LfoGroup.
    if (group.id === 'lfo') {
      return <LfoGroup context={context} onCommand={onCommand} />;
    }
    if (tab.id === 'fx' ) {
      return (
        <EffectsGroup
          context={context}
          onCommand={onCommand}
          outputPaths={paths.filter((path) => !path.startsWith('effects.'))}
        />
      );
    }
    return <ControlGrid context={context} paths={paths} />;
  }
}

const styles = {
  summary: {
    margin: '0 0.25rem 0.6rem',
    fontFamily: FONT.display,
    fontSize: '0.7rem',
    color: COLOR.textDim,
  },
} as const satisfies Record<string, React.CSSProperties>;
