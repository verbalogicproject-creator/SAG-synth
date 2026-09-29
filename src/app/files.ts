/**
 * src/app/files.ts — get a file the app made out to the player (cycle 2, C3b).
 *
 * Preset exports now, WAV renders next: both are "here are some bytes, put them where I can
 * find them". Two routes, one call:
 *
 * - inside the Android shell, `AndroidBridge.saveFile` writes to `Download/SAG/` — a WebView
 *   ignores `<a download>`, so the ordinary browser route does nothing there;
 * - in a browser, the ordinary route: a Blob and a clicked `<a download>`.
 *
 * Layer rule: `src/app/` — browser APIs yes, tone/react never.
 */

export type SaveResult = { ok: true; where: string } | { ok: false; error: string };

export type FileMime = 'application/json' | 'audio/wav';

function toBase64(bytes: Uint8Array): string {
  // Chunked: `String.fromCharCode(...bytes)` overflows the call stack on a WAV.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function saveFile(name: string, mime: FileMime, data: string | Uint8Array): SaveResult {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const bridge = typeof window === 'undefined' ? undefined : window.AndroidBridge;

  if (bridge?.saveFile !== undefined) {
    try {
      const reply = JSON.parse(bridge.saveFile(name, mime, toBase64(bytes))) as {
        ok: boolean;
        path?: string;
        error?: string;
      };
      return reply.ok ? { ok: true, where: reply.path ?? name } : { ok: false, error: reply.error ?? 'unknown' };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  if (typeof document === 'undefined') return { ok: false, error: 'nowhere to save a file' };
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { ok: true, where: `your downloads (${name})` };
}

/** Read a file the player picked in an `<input type="file">`, as text. */
export function readFileText(file: Blob): Promise<string> {
  return file.text();
}
