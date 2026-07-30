/**
 * src/app/create-engine.ts — the composition root's helper.
 *
 * Wires a `Dispatcher` out of the pieces core declares. Note what it does NOT do: it
 * never imports `src/runtime/`. The runtime arrives as a parameter, so this file — and
 * therefore all of `src/app/` — stays free of Tone.js even transitively.
 *
 * That is the whole point. The v0.2 SAG-SDK constructs an engine with `NullRuntime` and
 * no audio graph at all; if this file reached for `ToneRuntime` directly, importing it
 * would pull Tone into a headless process. The client picks the backend, exactly as it
 * already picks the persistence backend.
 */

import { Dispatcher, type DispatcherDeps } from './dispatcher';
import type { RuntimeAdapter } from '../core/runtime-contract';

export interface CreateEngineOptions {
  /** The audio backend. `ToneRuntime` in a browser, `NullRuntime` headless. */
  runtime: RuntimeAdapter;
  /** Everything else is optional; sensible browser defaults are filled in below. */
  overrides?: Partial<Omit<DispatcherDeps, 'runtime'>>;
}

/**
 * Browser-default id and clock sources.
 *
 * `Dispatcher` requires both rather than defaulting them, because a core that generated
 * its own ids could not reproduce a journal. Supplying them is this layer's job, and
 * this is the one place in the app that is allowed to be non-deterministic.
 */
export function createEngine(options: CreateEngineOptions): Dispatcher {
  return new Dispatcher({
    runtime: options.runtime,
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    ...options.overrides,
  });
}
