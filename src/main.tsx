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
import { isDebugSurface } from './clients/surface-route';
import './index.css';

const Surface = isDebugSurface(window.location.hash) ? DebugApp : SynthApp;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Surface />
  </StrictMode>,
);
