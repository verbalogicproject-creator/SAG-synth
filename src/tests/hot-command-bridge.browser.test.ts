/**
 * src/tests/hot-command-bridge.browser.test.ts — the page answers the dev server.
 *
 * The bridge is four lines of logic and one of them is a correlation id, so what these
 * gate is not arithmetic — it is the contract between two files that cannot import each
 * other. `scripts/sag-command-plugin.mjs` is plain `.mjs` outside tsconfig, so nothing
 * type-checks the pair; the event names and the reply shape agree only because these
 * assert it.
 *
 * The hot channel is injected, so no dev server is needed. Runs in the `dom` project
 * rather than `core` because `src/app/` is the browser-facing layer and its tests belong
 * where its code can run.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  connectHotCommandBridge,
  HOT_COMMAND_EVENT,
  HOT_RESULT_EVENT,
  type HotChannel,
} from '../app/hot-command-bridge';
import type { CommandResult, SynthCommand } from '../core/commands';

/** A hot context that records what was sent and lets a test fire an inbound event. */
function fakeChannel() {
  const listeners = new Map<string, (data: unknown) => void>();
  const sent: { event: string; data: unknown }[] = [];
  const channel: HotChannel = {
    on: (event, callback) => void listeners.set(event, callback),
    send: (event, data) => void sent.push({ event, data }),
  };
  return {
    channel,
    sent,
    fire: (event: string, data: unknown) => listeners.get(event)?.(data),
    listens: (event: string) => listeners.has(event),
  };
}

const applied = (revision: number): CommandResult => ({
  commandId: 'c1',
  status: 'applied',
  revision,
});

describe('connectHotCommandBridge', () => {
  it('subscribes to the event the plugin actually sends', () => {
    // The two halves live in different languages and different type-checkers. If these
    // strings drift, every command times out as "no page answered" and looks like a
    // closed tab rather than a rename.
    const hot = fakeChannel();
    connectHotCommandBridge(hot.channel, () => applied(1));

    expect(hot.listens(HOT_COMMAND_EVENT)).toBe(true);
    expect(HOT_COMMAND_EVENT).toBe('sag:command');
    expect(HOT_RESULT_EVENT).toBe('sag:command-result');
  });

  it('dispatches the command and replies with the result under the same id', () => {
    const hot = fakeChannel();
    const dispatch = vi.fn((): CommandResult => applied(7));
    connectHotCommandBridge(hot.channel, dispatch);

    const command = { type: 'noteOn', note: 'C3', velocity: 0.9 } as unknown as SynthCommand;
    hot.fire(HOT_COMMAND_EVENT, { id: 'http-1', command });

    expect(dispatch).toHaveBeenCalledWith(command);
    expect(hot.sent).toEqual([
      { event: HOT_RESULT_EVENT, data: { id: 'http-1', result: applied(7) } },
    ]);
  });

  it('passes a rejection straight back rather than interpreting it', () => {
    // The validator's own message is the useful one. A bridge that summarised it would be
    // a second opinion on validity, which is the drift the `'eq'` bug was made of.
    const rejection: CommandResult = {
      commandId: 'c1',
      status: 'rejected',
      error: 'setEffectEnabled rejected — effectId: Invalid option',
      revision: 3,
    };
    const hot = fakeChannel();
    connectHotCommandBridge(hot.channel, () => rejection);

    hot.fire(HOT_COMMAND_EVENT, { id: 'http-2', command: {} as SynthCommand });

    expect((hot.sent[0]?.data as { result: CommandResult }).result).toEqual(rejection);
  });

  it('answers a throwing dispatch instead of leaving the caller to time out', () => {
    // `dispatch` builds an envelope before it validates, so a body that is not a command
    // at all can throw rather than reject. Without this the request hangs for the full
    // timeout and reports "no page answered", which points at the browser being closed —
    // the wrong place entirely.
    const hot = fakeChannel();
    connectHotCommandBridge(hot.channel, () => {
      throw new Error('envelope payload must be an object');
    });

    hot.fire(HOT_COMMAND_EVENT, { id: 'http-3', command: null as unknown as SynthCommand });

    const result = (hot.sent[0]?.data as { result: CommandResult }).result;
    expect(result.status).toBe('rejected');
    expect(result.error).toContain('envelope payload must be an object');
  });

  it('stays silent when there is no id to correlate on', () => {
    // The server resolves a pending request by id. A reply it cannot match would resolve
    // whichever request happened to be waiting, and answering the wrong caller is worse
    // than answering none.
    const hot = fakeChannel();
    const dispatch = vi.fn((): CommandResult => applied(1));
    connectHotCommandBridge(hot.channel, dispatch);

    hot.fire(HOT_COMMAND_EVENT, { command: { type: 'undo' } });
    hot.fire(HOT_COMMAND_EVENT, null);

    expect(dispatch).not.toHaveBeenCalled();
    expect(hot.sent).toEqual([]);
  });
});
