# 05 — Deterministic Effects and Offline Audio Gates

## Aligned recommendation
Split audio effects into three tiers:
1. **Deterministic and gateable** — safe for exact replay/offline verification (journal bytes, allocator verdicts, dry synth renders, Freeverb parameter snapshots).
2. **Deterministic enough for runtime, but only tolerantly verifiable** — limiter, chorus, feedback delay, anything with lookahead or internal warmup.
3. **Non-deterministic at construction** — excluded from bit-reproducibility gates entirely (e.g. `Tone.Reverb`).

## Why Tone.Reverb was replaced with Freeverb parameters
The original pack specified `Tone.Reverb` with a `decay` time. `Tone.Reverb` generates a randomized noise impulse response at construction — its output is non-reproducible between runs, so it cannot appear in any determinism gate, and there is no stable parameter for a test to assert against. Freeverb's parameter set (`roomSize`, `dampening`, `wet`) is deterministic and directly assertable. `Tone.Reverb` may still be used later purely for sound quality, but that exclusion from bit-reproducibility gates needs to stay explicitly documented wherever it's used.

## Verification foundation: headless chromium via Tone.Offline
Tone.js cannot run in bare Node on the target host (Android/Termux/PRoot) — it crashes reaching for ALSA. All audio verification therefore runs in headless chromium via `Tone.Offline`, launched with `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage` under PRoot. This is stable and is the foundation of every audio gate.

```ts
const rendered = await Tone.Offline(async () => {
  const synth = new Tone.MonoSynth(opts);
  const fx = new Tone.Freeverb({ roomSize: 0.7, dampening: 2500, wet: 0.3 });
  synth.connect(fx);
  fx.toDestination();
  schedulePattern(synth, pattern);
}, 4);

const channel = rendered.getChannelData(0);
const peak = channel.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
```

## Open question: Tone.Limiter measurement anomaly (Q1)
`Tone.Limiter(-1)` measured a **higher** peak than no limiter at all — 3.3448 vs 3.0972 on the same source material. This is unresolved and may be a measurement artifact rather than a Tone bug; it currently blocks committing to a master-limiter design. Before treating it as a bug, follow-up research should:
- align both test renders to the same latency/lookahead compensation
- compare peak *after trimming leading latency* and after matching total render windows
- inspect whether meter logic reads inter-sample vs sample peaks differently
- confirm whether the limiter's lookahead shifts the signal in a way that breaks naive peak comparison between two separately-rendered buffers

This is the single most important open technical question carried into v0.2.0 research.

## Gate taxonomy summary
| Tier | Examples | Guarantee |
|---|---|---|
| A — exact | journal bytes, replayed engine state, allocator verdicts, note scheduling | byte-identical |
| B — exact/near-exact render | dry MonoSynth voice, dry pool with deterministic schedule, Freeverb | same environment/library version |
| C — tolerant | Limiter, Chorus, feedback Delay | statistical/envelope comparison only |
