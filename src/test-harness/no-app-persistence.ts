/**
 * src/test-harness/no-app-persistence.ts — browser test setup: the APP does not persist.
 *
 * Every `*.browser.test.ts` file runs on one origin, so the app's own 'sag-synth' IndexedDB
 * would carry one test's autosave into the next and make results depend on file order. The
 * storage itself is gated where it lives, on per-test database names
 * (`persistence.browser.test.ts`, `session-sync.test.ts`).
 */
(globalThis as { __sagNoPersistence__?: boolean }).__sagNoPersistence__ = true;
