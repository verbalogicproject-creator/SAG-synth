/**
 * src/clients/engine.ts — one audio graph per page, whichever surface is asking.
 *
 * Moved out of `DebugApp.tsx` at 4.6a, unchanged in behaviour and load-bearing in a new
 * way. While the debug wall was the only mount point, "the engine lives with the surface"
 * was harmless. Adding a second surface at `#debug` makes it the exact hazard the phase
 * plan names: two mount points are two ways to build two engines, and this project has
 * already silenced a tab that way once.
 *
 * The comments below are the ones written when that happened. They are kept verbatim
 * because they record a diagnosis, not a design.
 */

import { ToneRuntime } from '../runtime';
import { createEngine } from '../app/create-engine';
import { connectHotCommandBridge } from '../app/hot-command-bridge';
import { HttpSagObserver } from '../app/http-observer';
import { MemorySagJournal } from '../core/sag/events';
import type { Dispatcher } from '../app/dispatcher';

/**
 * The engine handle, and it lives on `globalThis` rather than in this module.
 *
 * Not `useState(() => …)`: StrictMode invokes that initializer twice in development,
 * which would build two audio graphs and leave one orphaned.
 *
 * And not a plain module variable either, which is the subtler half. A module variable
 * dies with its module: when Vite hot-updates anything this file imports, it evaluates a
 * NEW copy of this module in which `engine` is `null`, and that copy dutifully builds a
 * second audio graph while the first is still connected to the destination. The
 * `hot.dispose` hook below is meant to prevent exactly that and only fires for the copy
 * that registered it — so an update arriving through a different boundary leaves the old
 * graph alive with nothing holding a reference to it.
 *
 * That is not a hypothesis. On 2026-07-30 the observation log recorded three engine ids
 * reporting in the same minute from one page, and the tab had gone silent — the symptom
 * this whole indirection exists to prevent, arriving anyway through the gap.
 *
 * A key on `globalThis` outlives module re-evaluation, so a fresh copy can find its
 * predecessor and tear it down. One graph per page, whichever module copy is asking.
 */
// Renamed from __sagSynthDebugEngine__: it is no longer the debug wall's engine, it is
// the page's. The name mattering is the point — two surfaces must find the same slot.
const ENGINE_KEY = '__sagSynthEngine__';

export type EngineHandle = {
  runtime: ToneRuntime;
  dispatcher: Dispatcher;
  journal: MemorySagJournal;
  observer: HttpSagObserver;
  /**
   * Identity of THIS engine instance, not the session.
   *
   * The point of it is the failure described under `import.meta.hot` below: when several
   * graphs are alive at once, every one emits observations under its own id, so the leak
   * shows up as two ids interleaved in the log rather than having to be deduced from a
   * synth that has gone quiet.
   */
  instanceId: string;
};

type EngineSlot = typeof globalThis & { [ENGINE_KEY]?: EngineHandle | null };

function slot(): EngineSlot {
  return globalThis as EngineSlot;
}

function disposeEngine(): void {
  const live = slot()[ENGINE_KEY];
  if (live == null) return;
  live.dispatcher.dispose();
  live.observer.dispose();
  slot()[ENGINE_KEY] = null;
}

// Reap the predecessor at module-evaluation time, which is the moment a hot update
// produces a second copy of this file. Running it here rather than only in `hot.dispose`
// covers the case that hook cannot: an update propagating through some other boundary,
// where the copy that registered the hook is not the copy being replaced.
if (import.meta.hot) disposeEngine();

export function getEngine(): EngineHandle {
  const existing = slot()[ENGINE_KEY];
  if (existing != null) return existing;

  const runtime = new ToneRuntime();
  const journal = new MemorySagJournal();
  const built: EngineHandle = {
    runtime,
    journal,
    observer: new HttpSagObserver(),
    instanceId: crypto.randomUUID().slice(0, 8),
    dispatcher: createEngine({ runtime, overrides: { journal } }),
  };
  slot()[ENGINE_KEY] = built;
  return built;
}

/**
 * Tear the audio graph down before a hot update replaces this module.
 *
 * Without this, every HMR reload resets `engine` to null and builds a fresh
 * ToneRuntime — a new master Volume, Analyser and Meter, all still wired to the
 * destination — while the previous graph stays alive and summing. An editing session
 * with thirty saves ends with thirty live analysers and thirty orphaned voice pools on
 * one AudioContext.
 *
 * Not hypothetical tidiness: that accumulation is what silenced a long-running tab on
 * 2026-07-30, and it was identified only by opening a fresh one — after several rounds
 * of looking for the fault inside the engine, where it was never going to be.
 */
if (import.meta.hot) {
  import.meta.hot.dispose(disposeEngine);

  // Let the dev server play this engine. `'agent'` rather than `'ui'` so the journal
  // records who moved the knob, which is the distinction CommandSource exists for.
  connectHotCommandBridge(import.meta.hot, (command) => getEngine().dispatcher.dispatch(command, 'agent'));
}

