/**
 * src/app/hot-command-bridge.ts — lets something outside the browser play the synth.
 *
 * The page-side half of `scripts/sag-command-plugin.mjs`. The dev server receives a
 * command over HTTP and forwards it on Vite's HMR socket; this listens, dispatches it,
 * and sends the result back. Paired with `HttpSagObserver` next door it closes the loop:
 * one channel to act, one to measure.
 *
 * DEVELOPMENT ONLY, and more emphatically than the observer. `import.meta.hot` is
 * `undefined` in a build, so this is inert there whatever a caller does — but the caller
 * still has to pass it in, so nothing here reaches for a Vite global on its own.
 *
 * Two design points worth stating because they are load-bearing:
 *
 * **It does not validate.** `dispatch` already runs `validateCommand`, which is the one
 * gate every command passes. A second copy of that judgement here would be a second list
 * to drift, and the `'eq'` bug is what that costs: a command refused at one layer while
 * every other layer believed it fine. A malformed command comes back as an ordinary
 * rejection with the validator's own message.
 *
 * **It dispatches as `'agent'`, not `'ui'`.** `CommandSource` already had the value, so an
 * HTTP-driven note is journalled as what it is and a replay can tell the two apart. That
 * is the whole reason the field exists, and it means this adapter needs no contract change.
 *
 * Layer rule D2: `src/app/` is adapters — browser APIs yes, `tone` and `react` never.
 */

import type { CommandResult, SynthCommand } from '../core/commands';

/** Server → page. Must match `COMMAND_EVENT` in the plugin. */
export const HOT_COMMAND_EVENT = 'sag:command';
/** Page → server. Must match `RESULT_EVENT` in the plugin. */
export const HOT_RESULT_EVENT = 'sag:command-result';

/**
 * The slice of Vite's hot context this needs, declared structurally.
 *
 * Taken as a parameter rather than read from `import.meta.hot` so the bridge is testable
 * without a dev server, and so a production bundle has no path to it at all.
 */
export interface HotChannel {
  on(event: string, callback: (data: unknown) => void): void;
  send(event: string, data: unknown): void;
}

export interface HotCommandRequest {
  id: string;
  command: SynthCommand;
}

export interface HotCommandReply {
  id: string;
  result: CommandResult | { status: 'rejected'; error: string; commandId: string; revision: number };
}

/**
 * Start answering commands from the dev server.
 *
 * `dispatch` is injected rather than imported so this file never reaches for the engine
 * singleton — the client owns that, and owning it in two places is how a second audio
 * graph gets built.
 */
export function connectHotCommandBridge(
  hot: HotChannel,
  dispatch: (command: SynthCommand) => CommandResult,
): void {
  hot.on(HOT_COMMAND_EVENT, (data) => {
    const request = data as Partial<HotCommandRequest> | null;
    // No id, no reply: the server correlates on it and a reply it cannot match would
    // silently resolve someone else's request.
    if (request === null || typeof request.id !== 'string') return;

    let result: HotCommandReply['result'];
    try {
      result = dispatch(request.command as SynthCommand);
    } catch (error) {
      // `dispatch` builds an envelope before it validates, so a body that is not an
      // object at all can throw rather than reject. Reported in the same shape as a
      // rejection, because from the caller's side it is one.
      result = {
        status: 'rejected',
        error: error instanceof Error ? error.message : String(error),
        commandId: request.id,
        revision: -1,
      };
    }

    hot.send(HOT_RESULT_EVENT, { id: request.id, result } satisfies HotCommandReply);
  });
}
