/**
 * src/app/session-sync.ts — the session survives a restart (cycle 2, C3b).
 *
 * Two jobs, in a fixed order:
 *
 * 1. RESTORE, once, at startup: the saved session (live sound + song) and the player's own
 *    presets go back in as ONE `restoreSession` command — one journal entry, and the undo
 *    baseline, so undo pressed right after launch cannot walk back to the factory sound.
 * 2. Then MIRROR: the session is autosaved shortly after the player stops changing things,
 *    and library changes (save, import, delete) are written straight away.
 *
 * The order is the whole safety argument. Autosave does not start until the restore has
 * finished: started earlier, its first write would be the factory sound the app booted
 * with, over the session it was about to restore. `session-sync.test.ts` gates exactly that.
 *
 * Storage is a MIRROR (`core/ports.ts`), never the source of truth. The journal stays in
 * memory — persisting every knob move and rehydrating from it is its own decision
 * (`dispatcher.ts` header) — so what survives is the state, not the history.
 *
 * Layer rule: `src/app/` — no tone, no react.
 */

import type { CommandResult, SynthCommand } from '../core/commands';
import type { PersistencePort } from '../core/ports';
import { libraryDiff, restoreCommand, sessionOf } from '../core/session';
import type { EngineState } from '../core/state';
import type { SynthPreset } from '../core/types';

/** Quiet time before an autosave. Long enough to skip every step of a knob drag. */
export const AUTOSAVE_DELAY_MS = 800;

export interface SessionSyncDeps {
  dispatcher: {
    getState(): EngineState;
    subscribe(listener: (update: { state: EngineState }) => void): () => void;
    dispatch(command: SynthCommand): CommandResult;
  };
  persistence: PersistencePort;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}

export interface RestoreReport {
  /** A saved session was found and put back. */
  session: boolean;
  /** How many of the player's presets came back. */
  presets: number;
  /** Library rows storage could not read — reported, not silently dropped. */
  warnings: string[];
}

export interface SessionSync {
  /** Resolves when the restore is done and the mirror is running. */
  ready: Promise<RestoreReport>;
  /** Write a pending autosave now — the app is going to the background. */
  flush(): Promise<void>;
  dispose(): void;
}

export function startSessionSync(deps: SessionSyncDeps): SessionSync {
  const { dispatcher, persistence } = deps;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let timer: unknown = null;
  let dirty = false;
  // Writes are chained, never concurrent: two overlapping saves could land out of order and
  // leave the OLDER session on disk.
  let writes: Promise<void> = Promise.resolve();

  const write = (job: () => Promise<void>): Promise<void> => {
    writes = writes.then(job).catch((error: unknown) => deps.onError?.(error));
    return writes;
  };

  const saveNow = (): Promise<void> => {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
    if (!dirty) return writes;
    dirty = false;
    const session = sessionOf(dispatcher.getState(), deps.now());
    return write(() => persistence.saveSession(session));
  };

  const ready = (async (): Promise<RestoreReport> => {
    const session = await persistence.loadSession();
    const listed = await persistence.listPresets();
    const loaded = await Promise.all(
      listed.items.filter((item) => !item.factory).map((item) => persistence.loadPreset(item.id)),
    );
    const presets = loaded.filter((preset): preset is SynthPreset => preset !== null);
    const warnings = listed.warnings.map((warning) => warning.message);

    if (!disposed && (session !== null || presets.length > 0)) {
      // No saved session but saved presets (a first run after an update that predates the
      // session store): the library comes back and the sound stays what it is.
      const base = session ?? sessionOf(dispatcher.getState(), deps.now());
      const result = dispatcher.dispatch(restoreCommand(base, presets));
      if (result.status !== 'applied') warnings.push(`restore refused: ${JSON.stringify(result)}`);
    }

    if (!disposed) {
      let last = dispatcher.getState();
      unsubscribe = dispatcher.subscribe(({ state }) => {
        if (state.presets !== last.presets) {
          const { put, remove } = libraryDiff(last.presets, state.presets);
          for (const preset of put) void write(() => persistence.savePreset(preset));
          for (const id of remove) void write(() => persistence.deletePreset(id));
        }
        if (state.patch !== last.patch || state.song !== last.song) {
          dirty = true;
          if (timer !== null) deps.clearTimer(timer);
          timer = deps.setTimer(() => {
            timer = null;
            void saveNow();
          }, AUTOSAVE_DELAY_MS);
        }
        last = state;
      });
    }
    return { session: session !== null, presets: presets.length, warnings };
  })();

  ready.catch((error: unknown) => deps.onError?.(error));

  return {
    ready,
    flush: saveNow,
    dispose() {
      disposed = true;
      unsubscribe?.();
      if (timer !== null) deps.clearTimer(timer);
    },
  };
}
