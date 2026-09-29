/**
 * src/app/native-bridge.ts — lets an Android shell drive the synth the same way the dev
 * server does.
 *
 * `connectHotCommandBridge` already defines the one shape a driver needs — `HotChannel`,
 * `{on, send}` — so this is not a new protocol, it is a second implementation of that
 * same structural interface for a caller that is not Vite. `src/clients/engine.ts` wires
 * whichever one exists; both use the identical `connectHotCommandBridge` and the identical
 * `'sag:command'` / `'sag:command-result'` event names, so nothing downstream can tell
 * which transport carried a given command.
 *
 * PRODUCTION-LEGAL, unlike its dev-only sibling. `import.meta.hot` does not exist in a
 * built bundle, so the Vite bridge is inert there whatever a caller does — an Android
 * shell has no dev server to talk to. `window.AndroidBridge` is the one external driver a
 * production bundle is allowed to answer to, and it exists only when a native shell
 * injects it before the page loads. A plain browser — including this project's own
 * hosted build — never sees `window.AndroidBridge`, so `nativeChannel()` returns `null`
 * and every line below is dead code for it.
 *
 * Layer rule D2: `src/app/` is adapters — browser APIs (`window`) yes, `tone` and `react`
 * never.
 */

import type { SagObserver, SynthAudioObservedEvent } from '../core/sag/events';
import type { HotChannel } from './hot-command-bridge';

/**
 * The shell's own two objects, declared locally because nothing else in this project
 * needs to know they exist. `postResult`/`observe`/`log` take strings, not objects — the
 * shell is a WebView bridge, and those only carry strings (or primitives) across the JS
 * boundary reliably, so every payload here is `JSON.stringify`d before it crosses.
 */
declare global {
  interface Window {
    AndroidBridge?: {
      postResult(json: string): void;
      observe(json: string): void;
      log(line: string): void;
      /**
       * C3b, app-specific in the SAG shell: write a file to Download/SAG/. Optional — an
       * older shell does not have it, and `saveFile` in app/files.ts falls back.
       */
      saveFile?(name: string, mime: string, base64: string): string;
    };
    /**
     * The shell's half of the channel: it calls INTO the page rather than emitting a DOM
     * event, because a WebView bridge has no event bus of its own to dispatch onto.
     * `nativeChannel()` installs this object; the shell finds it by the fixed name.
     */
    __sagNative?: {
      deliver(json: string): void;
      onIntent(uri: string): void;
    };
  }
}

/** Registered by whoever calls `onIntent`-aware code; minimal on purpose — see below. */
let intentListener: ((uri: string) => void) | undefined;

/** Let a caller elsewhere in the app hear a deep link the shell forwards. Optional. */
export function onNativeIntent(listener: (uri: string) => void): void {
  intentListener = listener;
}

/**
 * `null` unless a native shell is actually present. Checked structurally — `typeof window
 * !== 'undefined'` first, because this file must not throw when evaluated somewhere
 * without a DOM (a Node-run unit test, for instance) before it even gets to ask about
 * `AndroidBridge`.
 */
export function nativeChannel(): HotChannel | null {
  if (typeof window === 'undefined' || !window.AndroidBridge) return null;
  const bridge = window.AndroidBridge;

  return {
    on(event, callback) {
      // Only one event flows this direction today — 'sag:command' — but the channel is
      // kept structurally generic so a second inbound event never needs a second global.
      if (event !== 'sag:command') return;
      window.__sagNative = {
        deliver: (json) => callback(JSON.parse(json) as unknown),
        onIntent: (uri) => {
          if (intentListener) intentListener(uri);
          else bridge.log(`onIntent received with no listener registered: ${uri}`);
        },
      };
    },
    send(_event, data) {
      // Only one event flows this direction today — 'sag:command-result' — the id is
      // already inside `data`, so nothing here needs to branch on `_event`.
      bridge.postResult(JSON.stringify(data));
    },
  };
}

/**
 * The native-shell twin of `HttpSagObserver`. No batching: `AndroidBridge.observe` is a
 * synchronous in-process call, not a network request, so the buffering/flush machinery
 * that exists there to survive a dropped connection has nothing to protect against here.
 * One call per observation, appended by the shell however it likes.
 */
export class NativeSagObserver implements SagObserver {
  observe(event: SynthAudioObservedEvent): void {
    if (typeof window === 'undefined' || !window.AndroidBridge) return;
    window.AndroidBridge.observe(JSON.stringify(event));
  }
}
