/**
 * src/tests/filter-link.audio.test.ts — a linked filter envelope sounds like the amp's stages.
 *
 * Eyal's ask: "a toggle in filter to mirror the AMP AHDSR parameters to filter so they do the
 * same". `linked` (schema_version 6) is resolved in one pure place, `effectiveFilterEnvelope`;
 * these renders prove the runtime honours it — at voice build, on a live voice, and when the
 * amp is edited while linked, which is the case a diff could silently miss.
 */

import { describe, expect, it } from 'vitest';
import * as Tone from 'tone';
import { ToneRuntime } from '../runtime';
import { rms } from '../test-harness/audio-assertions';
import { renderTimeline } from '../test-harness/offline-render';
import { defaultPreset } from '../core/state';
import type { EnvelopeConfig, SynthPreset } from '../core/types';

const SR = 44100;

/** The psy pluck on the amp: the click, a hold, a fast log decay to nothing. */
const AMP: EnvelopeConfig = { attack: 0, hold: 0.03, decay: 0.12, decayCurve: 'logarithmic', sustain: 0.3, release: 0.05 };
/** The filter's own stages: slow and wide open — nothing like the amp. */
const OWN = { attack: 0.3, hold: 0, decay: 1.5, decayCurve: 'linear' as const, sustain: 1, release: 1 };

function patch(filter: 'linked' | 'own' | 'copied amp'): SynthPreset {
  const base = defaultPreset();
  const stages = filter === 'copied amp' ? AMP : OWN;
  return {
    ...base,
    voice: {
      ...base.voice,
      envelope: AMP,
      filterEnvelope: {
        ...base.voice.filterEnvelope,
        ...stages,
        baseFrequency: 200,
        octaves: 5,
        linked: filter === 'linked',
      },
    },
  };
}

async function render(
  drive: (runtime: ToneRuntime, at: (seconds: number, fn: () => void) => void) => void,
): Promise<Float32Array> {
  const { data } = await renderTimeline(
    (at) => {
      const runtime = new ToneRuntime();
      drive(runtime, at);
    },
    { seconds: 0.6, sampleRate: SR },
  );
  return data;
}

const play = (runtime: ToneRuntime) => runtime.noteOn({ voiceId: 0, note: 'C3', velocity: 1, portamento: 0 });

function maxDiff(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  return worst;
}

describe('linked renders exactly as the amp stages copied into the filter by hand', () => {
  it('for a voice built after the patch', async () => {
    const [linked, copied, own] = await Promise.all([
      render((r) => {
        r.applyPatch(patch('linked'));
        play(r);
      }),
      render((r) => {
        r.applyPatch(patch('copied amp'));
        play(r);
      }),
      render((r) => {
        r.applyPatch(patch('own'));
        play(r);
      }),
    ]);

    expect(rms(linked, 0, linked.length), 'the probe never sounded').toBeGreaterThan(0.005);
    expect(maxDiff(linked, copied)).toBeLessThan(1e-6);
    // The anti-vacuity half: the filter's own stages sound different, so the equality above
    // is the link working, not the filter envelope doing nothing either way.
    expect(maxDiff(linked, own)).toBeGreaterThan(0.05);
  });

  it('for a live voice when the link is switched on', async () => {
    // The voice is built with the filter's own stages and plays a note; the link arrives
    // while it rings, and the NEXT note on that same voice must run the amp's stages.
    const sequence = (second: 'linked' | 'copied amp') =>
      render((r, at) => {
        r.applyPatch(patch('own'));
        play(r);
        at(0.2, () => {
          r.noteOff({ voiceId: 0, note: 'C3' });
          r.applyPatch(patch(second));
        });
        at(0.3, () => play(r));
      });
    const [switched, copied] = await Promise.all([sequence('linked'), sequence('copied amp')]);
    expect(rms(switched, Math.round(0.3 * SR), switched.length), 'the second note never sounded').toBeGreaterThan(0.005);
    expect(maxDiff(switched, copied)).toBeLessThan(1e-6);
  });
});

describe('an amp edit while linked reaches the filter', () => {
  async function applied(linked: boolean): Promise<readonly string[]> {
    let sections: readonly string[] = [];
    await Tone.Offline(
      () => {
        const runtime = new ToneRuntime();
        const before = patch(linked ? 'linked' : 'own');
        runtime.applyPatch(before);
        runtime.applyPatch({ ...before, voice: { ...before.voice, envelope: { ...AMP, decay: 0.5 } } });
        sections = runtime.getLastApplied();
      },
      0.01,
      1,
      SR,
    );
    return sections;
  }

  it('linked: the amp edit rewrites the filter envelope too', async () => {
    expect(await applied(true)).toEqual(['filterEnvelope', 'envelope']);
  });

  it('unlinked: the amp edit costs the filter nothing', async () => {
    expect(await applied(false)).toEqual(['envelope']);
  });
});
