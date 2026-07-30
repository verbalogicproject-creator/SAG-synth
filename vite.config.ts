import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error — plain .mjs, deliberately outside tsconfig's include. Typing it would
// mean adding @types/node, which the contract refuses so that core stays environment-free.
import { sagObserveReceiver } from './scripts/sag-observe-plugin.mjs';

// App build config only. Test configuration lives in vitest.config.ts.
export default defineConfig({
  // sagObserveReceiver applies only on `serve`, so the observation endpoint exists in the
  // dev server and in no built artifact.
  plugins: [react(), sagObserveReceiver()],
  server: {
    // Bound to all interfaces rather than loopback: the dev server is opened from a
    // browser outside this PRoot environment, where 127.0.0.1 is not the same host.
    // Audio can only be judged by ear, so being reachable is a requirement of the
    // build, not a convenience.
    host: '0.0.0.0',
    port: 5173,
  },
});
