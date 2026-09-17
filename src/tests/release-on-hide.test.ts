import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../app/dispatcher';
import { releaseNotesWhenHidden } from '../app/release-on-hide';
import { NullRuntime } from '../core/runtime-contract';
import { MemorySagJournal } from '../core/sag/events';

function page(visibility = 'visible') {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: visibility });
  return { win, doc, targets: { window: win, document: doc } };
}

function engine() {
  const runtime = new NullRuntime();
  let ids = 0;
  let clock = 1_700_000_000_000;
  const dispatcher = new Dispatcher({
    runtime,
    journal: new MemorySagJournal(),
    newId: () => `cmd-${ids++}`,
    now: () => clock++,
  });
  return { runtime, dispatcher };
}

const noteOffs = (runtime: NullRuntime) => runtime.calls.filter((c) => c.method === 'noteOff');

describe('notes are released when the page is hidden', () => {
  it('backgrounding mid-press releases the held note (the stuck G4)', () => {
    const { runtime, dispatcher } = engine();
    const { doc, targets } = page();
    releaseNotesWhenHidden(targets, (c) => dispatcher.dispatch(c));

    dispatcher.dispatch({ type: 'noteOn', note: 'G4', velocity: 1 });
    // The finger lifts on the launcher: no pointerup ever reaches the page.
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));

    expect(noteOffs(runtime).map((c) => c.arg)).toEqual([{ voiceId: 0, note: 'G4' }]);
    expect(dispatcher.getTransient().voices).toEqual([]);
  });

  it('becoming visible again releases nothing', () => {
    const sent: string[] = [];
    const { doc, targets } = page('hidden');
    releaseNotesWhenHidden(targets, (c) => sent.push(c.type));
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(sent).toEqual([]);
  });

  it('pagehide releases too', () => {
    const sent: string[] = [];
    const { win, targets } = page();
    releaseNotesWhenHidden(targets, (c) => sent.push(c.type));
    win.dispatchEvent(new Event('pagehide'));
    expect(sent).toEqual(['panic']);
  });

  it('the disposer detaches both listeners', () => {
    const sent: string[] = [];
    const { win, doc, targets } = page();
    const dispose = releaseNotesWhenHidden(targets, (c) => sent.push(c.type));
    dispose();
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('pagehide'));
    expect(sent).toEqual([]);
  });

  it('a throwing dispatch does not escape the handler', () => {
    const { win, targets } = page();
    releaseNotesWhenHidden(targets, () => {
      throw new Error('engine gone');
    });
    expect(() => win.dispatchEvent(new Event('pagehide'))).not.toThrow();
  });
});
