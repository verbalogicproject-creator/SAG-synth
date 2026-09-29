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

import { ToneRuntime, TRANSPORT_LOOKAHEAD } from '../runtime';
import { createEngine } from '../app/create-engine';
import { connectHotCommandBridge } from '../app/hot-command-bridge';
import { HttpSagObserver } from '../app/http-observer';
import { nativeChannel, NativeSagObserver } from '../app/native-bridge';
import { releaseNotesWhenHidden } from '../app/release-on-hide';
import { MemorySagJournal } from '../core/sag/events';
import { IdbPersistence } from '../app/persistence';
import { startSessionSync, type SessionSync } from '../app/session-sync';
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
  /**
   * `HttpSagObserver` when there is a dev server to post to, `NativeSagObserver` when a
   * shell has taken its place. Only the former needs `dispose()` — the native one has no
   * buffer or timer to tear down — so `disposeEngine` below checks for the method rather
   * than widening this to a third, dispose-optional interface.
   */
  observer: HttpSagObserver | NativeSagObserver;
  /**
   * Identity of THIS engine instance, not the session.
   *
   * The point of it is the failure described under `import.meta.hot` below: when several
   * graphs are alive at once, every one emits observations under its own id, so the leak
   * shows up as two ids interleaved in the log rather than having to be deduced from a
   * synth that has gone quiet.
   */
  instanceId: string;
  /** Detaches the release-on-hide listeners; null where there is no document. */
  releaseOnHide: (() => void) | null;
  /**
   * The session mirror (C3b): restores the saved sound, song and library at startup, then
   * autosaves. Null where there is no IndexedDB (a Node test importing this module).
   */
  session: SessionSync | null;
};

/** One database per origin. The shell serves a fixed origin, so this survives restarts. */
const DB_NAME = 'sag-synth';

type EngineSlot = typeof globalThis & { [ENGINE_KEY]?: EngineHandle | null };

function slot(): EngineSlot {
  return globalThis as EngineSlot;
}

function disposeEngine(): void {
  const live = slot()[ENGINE_KEY];
  if (live == null) return;
  live.releaseOnHide?.();
  live.session?.dispose();
  live.dispatcher.dispose();
  if (live.observer instanceof HttpSagObserver) live.observer.dispose();
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

  const runtime = new ToneRuntime({ lookAhead: TRANSPORT_LOOKAHEAD });
  const journal = new MemorySagJournal();
  // A native shell, when present, is preferred over the dev-server channel: it is the one
  // that is actually reachable in a production bundle, and `nativeChannel()` is null in
  // every other context (including this project's own hosted build), so this never
  // changes behaviour for a plain browser.
  const built: EngineHandle = {
    runtime,
    journal,
    observer: nativeChannel() ? new NativeSagObserver() : new HttpSagObserver(),
    instanceId: crypto.randomUUID().slice(0, 8),
    dispatcher: createEngine({ runtime, overrides: { journal } }),
    releaseOnHide: null,
    session: null,
  };
  // `__sagNoPersistence__` is set by the browser test setup only (see
  // test-harness/no-app-persistence.ts); nothing in the app sets it.
  const persistenceOff = (globalThis as { __sagNoPersistence__?: boolean }).__sagNoPersistence__ === true;
  if (typeof indexedDB !== 'undefined' && !persistenceOff) {
    built.session = startSessionSync({
      dispatcher: built.dispatcher,
      persistence: new IdbPersistence(DB_NAME),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      // Surfaced, not swallowed: a storage failure is data loss in waiting, and the shell
      // serves console lines at /__sag/diagnostics.
      onError: (error) => console.error('[sag.session]', error),
    });
    void built.session.ready.then((report) => console.info(`[sag.session] ${JSON.stringify(report)}`));
  }
  // Swiping to the background mid-press never delivers pointerup, so a held note stayed
  // stuck for the life of the process. See app/release-on-hide.ts.
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    built.releaseOnHide = releaseNotesWhenHidden({ window, document }, (command) =>
      built.dispatcher.dispatch(command),
    );
    // Android may kill a backgrounded app without warning, so the pending autosave is
    // written the moment the page is hidden rather than 800 ms later.
    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') void built.session?.flush();
    };
    // `pagehide` means the page is going whatever the visibility state says.
    const flushOnPageHide = () => void built.session?.flush();
    document.addEventListener('visibilitychange', flushOnHide);
    window.addEventListener('pagehide', flushOnPageHide);
    const detachRelease = built.releaseOnHide;
    built.releaseOnHide = () => {
      detachRelease();
      document.removeEventListener('visibilitychange', flushOnHide);
      window.removeEventListener('pagehide', flushOnPageHide);
    };
  }
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
} else {
  // The production-legal path. `import.meta.hot` is always undefined in a built bundle,
  // so this branch is the ONLY way an external driver can reach a shipped instrument —
  // and it only fires when a native shell actually injected `window.AndroidBridge`.
  // A plain browser, including this project's own hosted build, sees `nativeChannel()`
  // return null and takes neither branch: no bridge, no behaviour change.
  const channel = nativeChannel();
  if (channel) {
    connectHotCommandBridge(channel, (command) => getEngine().dispatcher.dispatch(command, 'agent'));
  }
}

