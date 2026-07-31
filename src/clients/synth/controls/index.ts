/**
 * src/clients/synth/controls/index.ts — the kit, and the one function that picks from it.
 *
 * `renderControl` exists so a panel never chooses a widget. The choice is declared on the
 * control registry and derived from the spec there — a number carrying `choices` is
 * buttons, an enum is buttons, a boolean is a toggle — and a panel that made the call
 * locally could hand a slider to `voice.filter.rolloff` and produce values the validator
 * refuses.
 */

import { createElement } from 'react';
import { controlById } from '../../../core/controls';
import { EnvelopeCurve } from './EnvelopeCurve';
import { GlyphButtons } from './GlyphButtons';
import { Knob } from './Knob';
import { RateControl } from './RateControl';
import { ModRing } from './ModRing';
import { Slider } from './Slider';
import { Toggle } from './Toggle';
import type { ControlProps } from './types';

export { EnvelopeCurve, GlyphButtons, Knob, ModRing, RateControl, Slider, Toggle };
export { sagAttributes } from './types';
export type { ControlProps, ControlState, ModulationReach } from './types';

/** Draw a control as its registry entry says it is drawn. */
export function renderControl(props: ControlProps) {
  const widget = controlById(props.id)?.widget;
  switch (widget) {
    case 'knob':
      return createElement(Knob, props);
    case 'slider':
      return createElement(Slider, props);
    case 'glyphs':
      return createElement(GlyphButtons, props);
    case 'toggle':
      return createElement(Toggle, props);
    case 'rate':
      return createElement(RateControl, props);
    default:
      // An id with no registry entry is a bug in the caller, not a control to improvise.
      // Silently drawing something would be the decoy this whole layer exists to prevent.
      throw new Error(`renderControl: "${props.id}" is not a declared control.`);
  }
}
