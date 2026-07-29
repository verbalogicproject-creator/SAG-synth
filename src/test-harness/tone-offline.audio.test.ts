import { describe, it, expect } from 'vitest';
import * as Tone from 'tone';
import { rms, peak, hfEnergyRatio } from './audio-assertions';

/**
 * Phase-1 substrate spike, kept as a permanent regression test.
 *
 * This proves the load-bearing claim of the whole verification strategy: that
 * real Tone.js audio behaviour is machine-assertable in headless chromium on
 * this machine. If this file ever goes red, every runtime-layer gate below it
 * is untrustworthy and the fan-out should stop.
 */

const SR = 44100;

describe('Tone.Offline rendering substrate', () => {
  it('renders a non-silent MonoSynth note', async () => {
    const buffer = await Tone.Offline(
      () => {
        const synth = new Tone.MonoSynth({
          oscillator: { type: 'sawtooth' },
          envelope: { attack: 0.2, decay: 0.1, sustain: 0.8, release: 0.3 },
        }).toDestination();
        synth.triggerAttack('C4', 0);
      },
      1,
      1,
      SR,
    );

    const data = buffer.getChannelData(0);
    expect(data.length).toBe(SR);
    expect(rms(data)).toBeGreaterThan(0.01);
  });

  it('shows the amp envelope attack ramp in the rendered buffer', async () => {
    const buffer = await Tone.Offline(
      () => {
        const synth = new Tone.MonoSynth({
          oscillator: { type: 'sawtooth' },
          envelope: { attack: 0.2, decay: 0.1, sustain: 0.8, release: 0.3 },
        }).toDestination();
        synth.triggerAttack('C4', 0);
      },
      1,
      1,
      SR,
    );

    const d = buffer.getChannelData(0);
    const early = rms(d, 0, Math.floor(0.01 * SR));
    const late = rms(d, Math.floor(0.19 * SR), Math.floor(0.2 * SR));
    // With a 0.2s attack, the first 10ms must be far quieter than the peak.
    expect(early).toBeLessThan(0.2 * late);
  });

  it('lowering filter cutoff measurably reduces high-frequency energy', async () => {
    const render = (cutoff: number) =>
      Tone.Offline(
        () => {
          const synth = new Tone.MonoSynth({
            oscillator: { type: 'sawtooth' },
            envelope: { attack: 0.001, decay: 0.1, sustain: 1, release: 0.1 },
            filter: { type: 'lowpass', rolloff: -24, Q: 1 },
            filterEnvelope: {
              attack: 0.001, decay: 0.001, sustain: 1, release: 0.001,
              baseFrequency: cutoff, octaves: 0,
            },
          }).toDestination();
          synth.triggerAttack('C3', 0);
        },
        0.5,
        1,
        SR,
      );

    const [dark, bright] = await Promise.all([render(400), render(16000)]);
    const at = Math.floor(0.2 * SR);
    const darkHf = hfEnergyRatio(dark.getChannelData(0), SR, 5000, at);
    const brightHf = hfEnergyRatio(bright.getChannelData(0), SR, 5000, at);
    expect(darkHf).toBeLessThan(brightHf);
  });

  /**
   * Determinism is the precondition for every other gate: if the same graph
   * renders differently run to run, no assertion below it means anything.
   * Reverb-free patches must be bit-reproducible (Tone.Reverb generates a noise
   * impulse response and is deliberately excluded from deterministic gates).
   */
  it('renders the same patch identically across runs', async () => {
    const render = () =>
      Tone.Offline(
        () => {
          const synth = new Tone.MonoSynth({
            oscillator: { type: 'square' },
            envelope: { attack: 0.01, decay: 0.1, sustain: 0.6, release: 0.2 },
          }).toDestination();
          synth.triggerAttackRelease('A3', 0.25, 0);
        },
        0.5,
        1,
        SR,
      );

    const [a, b] = await Promise.all([render(), render()]);
    const da = a.getChannelData(0);
    const db = b.getChannelData(0);

    expect(da.length).toBe(db.length);
    let maxDelta = 0;
    for (let i = 0; i < da.length; i++) {
      const d = Math.abs(da[i] - db[i]);
      if (d > maxDelta) maxDelta = d;
    }
    expect(maxDelta).toBe(0);
    expect(peak(da)).toBeGreaterThan(0.01); // guard against comparing silence
  });
});
