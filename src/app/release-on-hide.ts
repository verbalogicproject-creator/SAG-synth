/**
 * Release every sounding note when the page stops being visible.
 *
 * WHY. The keyboards release a note on `pointerup` or `pointercancel`. Swiping the app to
 * the background mid-press fires neither — the finger lifts on the launcher, not on the
 * page — so the note stayed held for as long as the process lived. Observed on the phone
 * 2026-09-17: a G4 at 392 Hz, amp envelope at sustain, sounding in the background and
 * still there on return, which read as "the synth has no sound" for most of a session.
 *
 * `visibilitychange` to hidden covers backgrounding and screen-off; `pagehide` covers a
 * page being unloaded or put in the back-forward cache without a visibility change.
 * `panic` is the existing all-notes-off, so this adds no new release path to get wrong.
 *
 * Takes its event targets as arguments rather than reading `window`/`document`, so the
 * decision is a plain Node test.
 */
import type { SynthCommand } from '../core/commands';

export interface HideTargets {
  window: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  document: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & {
    readonly visibilityState: string;
  };
}

/** Returns the disposer. */
export function releaseNotesWhenHidden(
  targets: HideTargets,
  dispatch: (command: SynthCommand) => void,
): () => void {
  const panic = (): void => {
    try {
      dispatch({ type: 'panic' });
    } catch {
      // Never throw out of a lifecycle handler; a failed release must not break unload.
    }
  };
  const onVisibility = (): void => {
    if (targets.document.visibilityState === 'hidden') panic();
  };
  targets.document.addEventListener('visibilitychange', onVisibility);
  targets.window.addEventListener('pagehide', panic);
  return () => {
    targets.document.removeEventListener('visibilitychange', onVisibility);
    targets.window.removeEventListener('pagehide', panic);
  };
}
