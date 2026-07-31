/**
 * src/core/ignored.ts — parameters a patch sets that the patch's own shape cannot honour.
 *
 * A control in this state is not broken and not disabled. The value is stored, validated,
 * journalled and replayed exactly; it simply has nowhere to land right now — `width` on a
 * sawtooth, unison on a pulse, an LFO synced to a transport that is not running. The
 * player needs to be told which, because "this control is broken" and "this control has
 * nothing to act on" look identical from the knob, and the EQ was reported broken twice
 * for exactly that reason.
 *
 * The runtime already knows all of this and says it as gap strings —
 * `oscillator.0.width.sawtooth` — routed through `notImplemented` for the debug wall. That
 * is the right vocabulary for a diagnostic list and the wrong one for a label under a
 * knob, so this answers the surface's question instead: given a patch and an address, what
 * sentence goes under the control.
 *
 * `ignored.test.ts` gates the two against each other, because a second opinion about the
 * engine is the defect this project has shipped six times.
 *
 * Layer rule D2: core, zod only. A fact about a patch, not about Tone.
 */

import type { ParamPath, SynthPreset } from './types';

export interface IgnoredNote {
  path: ParamPath;
  /** One line, in the player's vocabulary. Shown under the control, not behind a hover. */
  reason: string;
}

/**
 * Everything this patch asks for and cannot get, with the reason.
 *
 * Ordered by address so the list reads the same however the patch was built.
 */
export function ignoredIn(patch: SynthPreset): IgnoredNote[] {
  const notes: IgnoredNote[] = [];

  patch.voice.oscillators.forEach((slot, index) => {
    const at = (key: string) => `voice.oscillators.${index}.${key}` as ParamPath;

    if (slot.type === 'noise') {
      // Sounds as a sawtooth. A real noise slot is built around Tone.Noise, which is a
      // different source shape rather than another branch in `oscillatorOptions`.
      notes.push({ path: at('type'), reason: 'noise sounds as a sawtooth for now' });
    }
    if (slot.width !== 0 && slot.type !== 'pulse') {
      notes.push({ path: at('width'), reason: `only a pulse has width — this is a ${slot.type}` });
    }
    if (slot.count > 1 && (slot.type === 'pulse' || slot.type === 'pwm')) {
      const reason = `no unison on a ${slot.type}`;
      notes.push({ path: at('count'), reason });
      notes.push({ path: at('spread'), reason });
    }
  });

  patch.voice.lfos.forEach((lfo, index) => {
    const at = (key: string) => `voice.lfos.${index}.${key}` as ParamPath;

    if (typeof lfo.frequency === 'string') {
      notes.push({ path: at('frequency'), reason: 'a synced rate needs a transport — running at 1 Hz' });
    }
    if (lfo.sync) {
      notes.push({ path: at('sync'), reason: 'needs a transport, which nothing drives yet' });
    }
    if (lfo.retrigger) {
      // One generator serves every voice, so a per-note phase reset would restart the
      // modulation for every sounding note at once — audibly wrong on a held chord.
      notes.push({ path: at('retrigger'), reason: 'one LFO is shared by every voice' });
    }
  });

  return notes.sort((a, b) => a.path.localeCompare(b.path));
}

/** The sentence for one address, or nothing when the patch's shape can honour it. */
export function ignoredReason(patch: SynthPreset, path: ParamPath): string | undefined {
  return ignoredIn(patch).find((note) => note.path === path)?.reason;
}
