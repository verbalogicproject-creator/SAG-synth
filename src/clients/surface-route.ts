/**
 * src/clients/surface-route.ts — which surface a URL asks for.
 *
 * One predicate, in its own module because `main.tsx` mounts on import: anything that
 * imports it builds a React root, so the routing rule could not be tested where it was
 * first written. A bootstrap file should do nothing but bootstrap.
 */

/** `#debug` — the throwaway wall. Anything else is the instrument. */
export function isDebugSurface(hash: string): boolean {
  return hash.replace(/^#/, '').split('?')[0] === 'debug';
}

/** The two surfaces, named rather than passed around as a boolean. */
export type Surface = 'debug' | 'instrument';

/**
 * Which surface a native deep link asks for.
 *
 * The Android shell forwards a VIEW intent to the page as `__sagNative.onIntent(uri)`.
 * Nothing registered a listener for it, so every deep link reached the page and stopped
 * there — `native-bridge.ts` logged "onIntent received with no listener registered" and
 * that was the whole behaviour.
 *
 * Accepts the forms a shell actually sends, because an intent URI is not a URL and
 * `new URL()` disagrees with itself across engines about where the authority ends:
 *
 *     sagsynth://debug          host
 *     sagsynth:///debug         path
 *     sagsynth://open#debug     fragment
 *     sagsynth://              -> instrument
 *
 * Anything unrecognised is the instrument. A deep link that cannot be read should open
 * the thing the user was reaching for, not a diagnostic wall.
 */
export function surfaceFromIntent(uri: string): Surface {
  const afterScheme = uri.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/*/, '');
  const hashAt = afterScheme.indexOf('#');
  if (hashAt !== -1 && isDebugSurface(afterScheme.slice(hashAt))) return 'debug';
  const head = (hashAt === -1 ? afterScheme : afterScheme.slice(0, hashAt)).split(/[/?]/)[0];
  return head.toLowerCase() === 'debug' ? 'debug' : 'instrument';
}

/** The `location.hash` that mounts [surface]. Empty string is the instrument. */
export function hashForSurface(surface: Surface): string {
  return surface === 'debug' ? '#debug' : '';
}
