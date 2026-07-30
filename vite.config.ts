import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error — plain .mjs, deliberately outside tsconfig's include. Typing it would
// mean adding @types/node, which the contract refuses so that core stays environment-free.
import { sagObserveReceiver } from './scripts/sag-observe-plugin.mjs';
// @ts-expect-error — see above; the same reason applies to this one.
import { sagCommandBridge } from './scripts/sag-command-plugin.mjs';

// App build config only. Test configuration lives in vitest.config.ts.
export default defineConfig({
  // Both SAG plugins apply only on `serve`, so neither endpoint exists in a built
  // artifact. That matters more for the command bridge than for the observer: one
  // reports, the other plays the instrument.
  plugins: [react(), sagObserveReceiver(), sagCommandBridge()],
  server: {
    // Bound to all interfaces rather than loopback: the dev server is opened from a
    // browser outside this PRoot environment, where 127.0.0.1 is not the same host.
    // Audio can only be judged by ear, so being reachable is a requirement of the
    // build, not a convenience.
    host: '0.0.0.0',
    port: 5173,
  },
});
