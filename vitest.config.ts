import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';

// Three test projects with a filename convention agents can follow without asking:
//   *.audio.test.ts    -> headless chromium (real Web Audio, Tone.Offline renders)
//   *.browser.test.ts  -> headless chromium (DOM APIs with no audio: IndexedDB, File)
//   *.test.ts          -> plain Node (pure domain core, fast)
//
// audio and browser are split rather than merged so `--project audio` stays exactly the
// gate the build plan documents, and so a storage failure never reads as an audio one.
/**
 * Wall-clock benchmarks. They measure the machine, so they must not share it.
 *
 * `mixer-cost` asserts a cost RATIO it calls "contention-invariant", and that only holds when
 * contention is uniform over the run. Inside the parallel pool it is not: SAG-DAW slice 1's
 * `roll.browser.test.ts` made the `dom` project heavy enough that the full suite read
 * "one chain cost 53x the bare source" against a 17–20x norm, while the same gate passed
 * alone and passed with `dom` excluded. So it runs in its own project, in a LATER group
 * (`sequence.groupOrder`), after every other project has finished — still inside `npm test`,
 * never beside it.
 */
const BENCHMARKS = 'src/tests/mixer-cost.audio.test.ts';

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
          exclude: ['src/**/*.audio.test.ts', 'src/**/*.browser.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'audio',
          include: ['src/**/*.audio.test.ts'],
          exclude: [BENCHMARKS],
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
      {
        extends: true,
        test: {
          name: 'dom',
          include: ['src/**/*.browser.test.ts'],
          // App-level persistence off: every test file shares one origin, so the app's own
          // 'sag-synth' database would carry one test's autosave into the next. Storage is
          // tested directly (persistence.browser.test.ts) on per-test database names.
          setupFiles: ['src/test-harness/no-app-persistence.ts'],
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
      {
        extends: true,
        test: {
          name: 'bench',
          include: [BENCHMARKS],
          sequence: { groupOrder: 1 },
          browser: {
            enabled: true,
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
