/**
 * src/tests/session-sync.test.ts — the sound survives a restart (C3b), headless.
 *
 * A real Dispatcher on the NullRuntime, a MemoryPersistence standing in for IndexedDB (the
 * IndexedDB twin is gated separately in `persistence.browser.test.ts`), and timers under the
 * test's control. "Restart" is a second engine opened on the same storage.
 */

import { describe, expect, it } from 'vitest';
import { createEngine } from '../app/create-engine';
import { AUTOSAVE_DELAY_MS, startSessionSync, type SessionSync } from '../app/session-sync';
import type { Dispatcher } from '../app/dispatcher';
import { MemoryPersistence } from '../core/ports';
import { NullRuntime } from '../core/runtime-contract';
import { defaultPreset, defaultSong } from '../core/state';
import { sessionOf } from '../core/session';

/** Timers that only fire when the test says so. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (fn: () => void) => {
      pending.set(next, fn);
      return next++;
    },
    clearTimer: (handle: unknown) => void pending.delete(handle as number),
    runAll() {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn();
    },
    get count() {
      return pending.size;
    },
  };
}

function boot(persistence: MemoryPersistence) {
  const dispatcher: Dispatcher = createEngine({ runtime: new NullRuntime() });
  const timers = manualTimers();
  const errors: unknown[] = [];
  const sync: SessionSync = startSessionSync({
    dispatcher,
    persistence,
    now: () => 1_700_000_000_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: (error) => errors.push(error),
  });
  return { dispatcher, timers, sync, errors };
}

const setAmplitude = (dispatcher: Dispatcher, value: number) =>
  dispatcher.dispatch({ type: 'setParam', path: 'voice.amplitude', value });

describe('the session survives a restart', () => {
  it('a fresh install restores nothing and dispatches nothing', async () => {
    const { dispatcher, sync } = boot(new MemoryPersistence());
    expect(await sync.ready).toEqual({ session: false, presets: 0, warnings: [] });
    expect(dispatcher.getState().revision).toBe(0);
  });

  it('an edit is autosaved once things go quiet, and comes back on the next launch', async () => {
    const storage = new MemoryPersistence();
    const first = boot(storage);
    await first.sync.ready;
    setAmplitude(first.dispatcher, 0.31);
    setAmplitude(first.dispatcher, 0.32);
    // One pending timer for the whole burst — a drag is not N writes.
    expect(first.timers.count).toBe(1);
    first.timers.runAll();
    await first.sync.flush();
    first.sync.dispose();

    const second = boot(storage);
    expect((await second.sync.ready).session).toBe(true);
    expect(second.dispatcher.getState().patch.voice.amplitude).toBe(0.32);
  });

  it('nothing is written before the restore has finished — the factory sound never lands on your work', async () => {
    const storage = new MemoryPersistence();
    const saved = sessionOf(
      { ...createEngine({ runtime: new NullRuntime() }).getState(), patch: { ...defaultPreset(), name: 'My Roll' } },
      1,
    );
    await storage.saveSession(saved);

    const { dispatcher, timers, sync } = boot(storage);
    // Before the restore completes: an edit, and every timer allowed to fire.
    setAmplitude(dispatcher, 0.9);
    timers.runAll();
    await sync.ready;
    await sync.flush();

    expect((await storage.loadSession())?.patch.name).toBe('My Roll');
    expect(dispatcher.getState().patch.name).toBe('My Roll');
  });

  it('the restore is the undo baseline: undo right after launch has nothing to take back', async () => {
    const storage = new MemoryPersistence();
    await storage.saveSession(sessionOf({ ...createEngine({ runtime: new NullRuntime() }).getState() }, 1));
    const { dispatcher, sync } = boot(storage);
    await sync.ready;
    expect(dispatcher.dispatch({ type: 'undo' }).status).toBe('rejected');

    // And edits after it undo normally, back to the restored state — not past it.
    setAmplitude(dispatcher, 0.2);
    expect(dispatcher.dispatch({ type: 'undo' }).status).toBe('applied');
    expect(dispatcher.dispatch({ type: 'undo' }).status).toBe('rejected');
  });

  it('a session saved by an older build is migrated on the way in', async () => {
    const storage = new MemoryPersistence();
    const old = structuredClone(sessionOf(createEngine({ runtime: new NullRuntime() }).getState(), 1)) as any;
    old.patch.schemaVersion = 5;
    delete old.patch.voice.filterEnvelope.linked;
    delete old.patch.voice.filter.drive;
    old.patch.voice.amplitude = 0.44;
    storage.plantSession(old);

    const { dispatcher, sync } = boot(storage);
    expect((await sync.ready).session).toBe(true);
    const patch = dispatcher.getState().patch;
    expect(patch.voice.amplitude).toBe(0.44);
    expect(patch.voice.filter.drive).toBe(0);
    expect(patch.voice.filterEnvelope.linked).toBe(false);
  });

  it('an unreadable session is skipped, and the app still autosaves', async () => {
    const storage = new MemoryPersistence();
    storage.plantSession({ kind: 'sag-session', schemaVersion: 1, patch: { nonsense: true }, song: defaultSong() });
    const { dispatcher, timers, sync } = boot(storage);
    expect((await sync.ready).session).toBe(false);
    setAmplitude(dispatcher, 0.5);
    timers.runAll();
    await sync.flush();
    expect((await storage.loadSession())?.patch.voice.amplitude).toBe(0.5);
  });

  it('flush writes a pending autosave straight away — the app is going to the background', async () => {
    const storage = new MemoryPersistence();
    const { dispatcher, timers, sync } = boot(storage);
    await sync.ready;
    setAmplitude(dispatcher, 0.27);
    expect(timers.count).toBe(1);
    await sync.flush();
    expect(timers.count).toBe(0);
    expect((await storage.loadSession())?.patch.voice.amplitude).toBe(0.27);
  });
});

describe('the library survives a restart', () => {
  it('a saved preset is stored at once and is back — as the player’s own — after a restart', async () => {
    const storage = new MemoryPersistence();
    const first = boot(storage);
    await first.sync.ready;
    first.dispatcher.dispatch({ type: 'savePreset', name: 'First Psy Melody', category: 'Lead' });
    await first.sync.flush();
    first.sync.dispose();

    const listed = await storage.listPresets();
    expect(listed.items.map((item) => item.name)).toEqual(['First Psy Melody']);
    // Factory presets are this build's, never storage's.
    expect(listed.items.every((item) => !item.factory)).toBe(true);

    const second = boot(storage);
    expect((await second.sync.ready).presets).toBe(1);
    const mine = Object.values(second.dispatcher.getState().presets).filter((p) => p.name === 'First Psy Melody');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.factory).toBe(false);
  });

  it('a deleted preset is deleted from storage too', async () => {
    const storage = new MemoryPersistence();
    const { dispatcher, sync } = boot(storage);
    await sync.ready;
    dispatcher.dispatch({ type: 'savePreset', name: 'Temp' });
    await sync.flush();
    const id = dispatcher.getState().patch.id;
    dispatcher.dispatch({ type: 'deletePreset', presetId: id });
    await sync.flush();
    expect((await storage.listPresets()).items).toEqual([]);
  });

  it('a stored copy cannot overwrite a factory preset', async () => {
    const storage = new MemoryPersistence();
    await storage.savePreset({ ...defaultPreset(), name: 'Hijacked', factory: false });
    const { dispatcher, sync } = boot(storage);
    await sync.ready;
    expect(dispatcher.getState().presets[defaultPreset().id]?.name).toBe(defaultPreset().name);
  });
});

it('waits the documented quiet time', () => {
  expect(AUTOSAVE_DELAY_MS).toBeGreaterThanOrEqual(300);
  expect(AUTOSAVE_DELAY_MS).toBeLessThanOrEqual(2000);
});
