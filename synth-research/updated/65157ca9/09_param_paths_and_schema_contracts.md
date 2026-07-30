# 09 — Finite Parameter Paths, Exhaustive Specs, and Agent-Safe Mutation

## Aligned rule
`setParam` takes one of exactly **70 compile-time-known parameter paths** (`voice.filter.frequency`, `voice.lfos.2.target`, …), generated from a template-literal type, with a `Record<ParamPath, ParamSpec>` of ranges that the compiler checks for exhaustiveness. LFOs are capped at 4 specifically to keep that union finite.

This was not addressed in the original research pack at all — it is a new constraint that emerged from the agent-control requirement.

## Why this matters more here than in a UI-only synth
A stringly-typed path API is merely annoying in a local, human-only app. In a system where v0.2.0's whole point is letting an AI agent dispatch commands, it's worse: an arbitrary `string` path lets a misspelled parameter validate structurally, do nothing, and still pollute the journal silently. Finite compile-time paths give:
- autocomplete for UI and SDK authors
- exhaustiveness checks enforced by the compiler when adding a new parameter
- one canonical place to define ranges/defaults/coercions
- precise, machine-readable documentation for the agent SDK

## Suggested pattern
```ts
export type ParamPath =
  | 'voice.oscillator.type'
  | 'voice.filter.frequency'
  | 'voice.filter.Q'
  | 'voice.envelope.attack'
  | 'voice.filterEnvelope.baseFrequency'
  | 'voice.lfos.0.target'
  | 'voice.lfos.0.rateHz'
  | 'fx.delay.wet'
  | 'fx.reverb.roomSize';
  // ... finite union continues to exactly 70 entries

export interface ParamSpec<T = unknown> {
  kind: 'number' | 'enum' | 'boolean';
  min?: number;
  max?: number;
  allowed?: readonly T[];
}

export const PARAM_SPECS: Record<ParamPath, ParamSpec> = {
  'voice.filter.frequency': { kind: 'number', min: 20, max: 20000 },
  'voice.filter.Q': { kind: 'number', min: 0, max: 30 },
  // ... exhaustive, compiler-checked
};
```

## Recommendation
Generate three artifacts from one source definition to avoid drift between code and docs:
1. the TypeScript `ParamPath` union
2. the runtime validator/coercer
3. a Markdown reference table for humans / RAG / agent SDK consumers

## LFO cap rationale
Keep the 4-LFO cap unless a different parameter-addressing model is adopted (e.g., entity IDs plus field keys instead of a flat finite string union) — relaxing the cap without changing the addressing model would make the union impractically large to keep exhaustive.

## Custom oscillator / wavetable deferral
The original pack suggested dropping to `AudioWorkletNode`/`PeriodicWave` for custom oscillators. This is deliberately deferred (decision D5) in the current implementation. `'custom'` remains in the `WaveShape` union so the type doesn't need to change later, but the validator currently rejects it with an explicit error rather than silently accepting an unplayable patch.
