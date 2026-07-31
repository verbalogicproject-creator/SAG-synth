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
