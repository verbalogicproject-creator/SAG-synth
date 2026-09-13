/**
 * src/tests/native-bridge.browser.test.ts — the page answers an Android shell.
 *
 * Mirrors `hot-command-bridge.browser.test.ts`: same `connectHotCommandBridge`, a
 * different transport underneath it. What is actually under test here is
 * `nativeChannel()`'s translation between `window.AndroidBridge`/`window.__sagNative` and
 * the `HotChannel` shape — the bridge logic itself is already covered next door.
 *
 * Runs in the `dom` project because `window` needs a real DOM, same as its sibling.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { connectHotCommandBridge } from '../app/hot-command-bridge';
import { nativeChannel, NativeSagObserver } from '../app/native-bridge';
import type { CommandResult, SynthCommand } from '../core/commands';
import type { SynthAudioObservedEvent } from '../core/sag/events';

/** A fake `window.AndroidBridge` recorder, installed and torn down per test. */
function installFakeBridge() {
  const posted: string[] = [];
  const observed: string[] = [];
  const logged: string[] = [];
  window.AndroidBridge = {
    postResult: (json) => void posted.push(json),
    observe: (json) => void observed.push(json),
    log: (line) => void logged.push(line),
  };
  return { posted, observed, logged };
}

afterEach(() => {
  delete window.AndroidBridge;
  delete window.__sagNative;
});

const applied = (revision: number): CommandResult => ({
  commandId: '1',
  status: 'applied',
  revision,
});

describe('nativeChannel', () => {
  it('is null when no shell has injected AndroidBridge', () => {
    expect(nativeChannel()).toBeNull();
  });

  it('installs window.__sagNative.deliver and dispatches through it', () => {
    installFakeBridge();
    const channel = nativeChannel();
    expect(channel).not.toBeNull();

    const dispatch = (command: SynthCommand): CommandResult => {
      expect(command).toEqual({ type: 'noteOn', note: 'C3', velocity: 0.9 });
      return applied(1);
    };
    connectHotCommandBridge(channel!, dispatch);

    expect(window.__sagNative).toBeDefined();
    window.__sagNative!.deliver(
      JSON.stringify({ id: '1', command: { type: 'noteOn', note: 'C3', velocity: 0.9 } }),
    );
  });

  it('reports the result back through AndroidBridge.postResult under the same id', () => {
    const bridge = installFakeBridge();
    const channel = nativeChannel();
    connectHotCommandBridge(channel!, () => applied(7));

    window.__sagNative!.deliver(
      JSON.stringify({ id: 'req-9', command: { type: 'noteOn', note: 'C3', velocity: 0.9 } }),
    );

    expect(bridge.posted).toHaveLength(1);
    expect(JSON.parse(bridge.posted[0]!)).toEqual({ id: 'req-9', result: applied(7) });
  });

  it('logs an unhandled intent when nothing has registered for it', () => {
    const bridge = installFakeBridge();
    const channel = nativeChannel();
    connectHotCommandBridge(channel!, () => applied(1));

    window.__sagNative!.onIntent('sag://open/patch/42');

    expect(bridge.logged).toHaveLength(1);
    expect(bridge.logged[0]).toContain('sag://open/patch/42');
  });
});

describe('NativeSagObserver', () => {
  it('forwards an observation to AndroidBridge.observe as JSON', () => {
    const bridge = installFakeBridge();
    const observer = new NativeSagObserver();
    const event = {
      instance_id: 'abc123',
      observed_at: 1000,
      context_state: 'running',
      level_db: -6,
    } as unknown as SynthAudioObservedEvent;

    observer.observe(event);

    expect(bridge.observed).toEqual([JSON.stringify(event)]);
  });

  it('does nothing when there is no bridge to send to', () => {
    const observer = new NativeSagObserver();
    expect(() => observer.observe({} as SynthAudioObservedEvent)).not.toThrow();
  });
});
