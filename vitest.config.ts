import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';

// Two test projects with a filename convention agents can follow without asking:
//   *.audio.test.ts  -> headless chromium (real Web Audio, Tone.Offline renders)
//   *.test.ts        -> plain Node (pure domain core, fast)
export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'core',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.audio.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'audio',
          include: ['src/**/*.audio.test.ts'],
          browser: {
            enabled: true,
            // PRoot/Termux cannot use the chromium sandbox.
            provider: playwright({
              launchOptions: {
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
              },
            }),
            headless: true,
            screenshotFailures: false,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
