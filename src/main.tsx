/**
 * src/main.tsx — which surface mounts.
 *
 * `#debug` mounts the throwaway wall, anything else mounts the instrument. No router: one
 * comparison, no dependency, and the diagnostic surface that found six decoys stays
 * exactly one URL away rather than being deleted.
 *
 * **Exactly one of them, ever.** Both surfaces reach the same engine through
 * `src/clients/engine.ts`, but mounting both at once would still put two control surfaces
 * on one audio graph with two ideas of the patch. The ternary is the guarantee; a gate in
 * `shell.browser.test.ts` is the proof.
 *
 * Not reactive to hash CHANGES on purpose. Switching surfaces is a reload, which tears the
 * React tree down cleanly and leaves the engine slot on `globalThis` untouched — the audio
 * graph survives the trip, and no unmount path has to be written for something done twice
 * a day.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DebugApp } from './clients/debug';
import { SynthApp } from './clients/synth/SynthApp';
import { hashForSurface, isDebugSurface, surfaceFromIntent } from './clients/surface-route';
import { onNativeIntent } from './app/native-bridge';
import './index.css';

/**
 * A native deep link can choose the surface.
 *
 * `onNativeIntent` was exported and nothing ever registered a listener, so every VIEW
 * intent the Android shell forwarded reached the page, found no handler, and was logged
 * as "onIntent received with no listener registered". That is the whole reason this
 * exists.
 *
 * A RELOAD, not a re-render, for the reason stated below: this file mounts exactly one
 * surface on import and is not reactive to hash changes, so setting the hash on its own
 * would change the address bar and nothing else. Guarded against reloading when the
 * requested surface is the one already showing, which would otherwise be a loop.
 */
onNativeIntent((uri) => {
  const target = hashForSurface(surfaceFromIntent(uri));
  if (isDebugSurface(window.location.hash) === isDebugSurface(target)) return;
  window.location.hash = target;
  window.location.reload();
});

const Surface = isDebugSurface(window.location.hash) ? DebugApp : SynthApp;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Surface />
  </StrictMode>,
);
