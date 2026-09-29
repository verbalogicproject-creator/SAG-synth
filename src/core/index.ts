/**
 * src/core/index.ts — the frozen public surface of the domain core.
 *
 * Phase 2+ agents, the app layer, and the v0.2 SAG-SDK import from here. Anything not
 * re-exported is an internal detail and may move without a wire-format change.
 *
 * Layer rule (D2): this subtree imports `zod` and nothing else. No `tone`, no `react`,
 * no DOM globals — proven mechanically by src/tests/contract.test.ts.
 */

export * from './types';
export * from './commands';
export * from './state';
export * from './schemas';
export * from './allocate';
export * from './schedule';
export * from './seq-voices';
export * from './duck';
export * from './patterns/psy';
export * from './reduce';
export * from './history';
export * from './runtime-contract';
export * from './ports';
export * from './params';
export * from './modulation';
export * from './groups';
export * from './sag/events';
