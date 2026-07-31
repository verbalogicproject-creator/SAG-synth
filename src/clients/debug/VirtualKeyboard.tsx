/**
 * src/clients/debug/VirtualKeyboard.tsx — on-screen keys.
 *
 * The primary input device for this project: development happens on Android, where there
 * is no physical keyboard, so the QWERTY bindings are a convenience and THIS is how the
 * synth is actually played.
 *
 * Built on Pointer Events rather than touch or mouse handlers. Two reasons:
 *   - each simultaneous finger arrives with its own `pointerId`, so chords work without
 *     any touch-list bookkeeping;
 *   - one code path covers finger, stylus and mouse, so the same surface is playable on
 *     a desktop without a second implementation.
 *
 * Release is handled on `window`, not on the key. A finger that slides off a key before
 * lifting never fires `pointerup` on that element, and the note would sound forever.
 */

import { useEffect, useRef } from 'react';
import { BLACK_KEYS, WHITE_KEYS, noteName } from './keyboard';

export interface VirtualKeyboardProps {
  octave: number;
  /** Notes currently sounding, for visual feedback. */
  held: ReadonlySet<string>;
  onNoteOn: (note: string) => void;
  onNoteOff: (note: string) => void;
}

const WHITE_COUNT = WHITE_KEYS.length;
const WHITE_WIDTH_PCT = 100 / WHITE_COUNT;
const BLACK_WIDTH_PCT = WHITE_WIDTH_PCT * 0.62;

export function VirtualKeyboard({ octave, held, onNoteOn, onNoteOff }: VirtualKeyboardProps) {
  /**
   * pointerId → the note that pointer started. The note is STORED rather than recomputed
   * on release: the octave can change while a key is held, and recomputing would release
   * a different note than the one sounding and strand the original on forever.
   */
  const active = useRef(new Map<number, string>());

  useEffect(() => {
    function release(event: PointerEvent): void {
      const note = active.current.get(event.pointerId);
      if (note === undefined) return;
      active.current.delete(event.pointerId);
      onNoteOff(note);
    }

    // `pointercancel` fires when the browser takes over the gesture — a scroll it decided
    // to own, or an incoming call. Without it those notes stick.
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, [onNoteOff]);

  function press(event: React.PointerEvent, note: string): void {
    // Stops the synthetic mouse events, text selection, and the long-press context menu
    // that Android fires on top of a touch.
    event.preventDefault();
    if (active.current.has(event.pointerId)) return;
    active.current.set(event.pointerId, note);
    onNoteOn(note);
  }

  /** Sliding onto a key with a finger already down plays it — glissando, as on a piano. */
  function slide(event: React.PointerEvent, note: string): void {
    if (event.buttons === 0 && event.pointerType === 'mouse') return;
    const current = active.current.get(event.pointerId);
    if (current === undefined || current === note) return;
    active.current.set(event.pointerId, note);
    onNoteOff(current);
    onNoteOn(note);
  }

  return (
    <div style={styles.board}>
      {WHITE_KEYS.map((key, index) => {
        const note = noteName(octave, key.offset);
        return (
          <button
            key={`w${index}`}
            type="button"
            // The note this key sends, on the DOM. Same reason every control carries
            // `data-sag-path`: a surface an agent can read is a surface a test can read.
            data-note={note}
            aria-label={note}
            onPointerDown={(event) => press(event, note)}
            onPointerEnter={(event) => slide(event, note)}
            onContextMenu={(event) => event.preventDefault()}
            style={{
              ...styles.white,
              left: `${index * WHITE_WIDTH_PCT}%`,
              width: `${WHITE_WIDTH_PCT}%`,
              background: held.has(note) ? '#6aa9ff' : '#fafafa',
            }}
          >
            <span style={styles.whiteLabel}>{note}</span>
          </button>
        );
      })}

      {BLACK_KEYS.map((key, index) => {
        const note = noteName(octave, key.offset);
        return (
          <button
            key={`b${index}`}
            type="button"
            data-note={note}
            aria-label={note}
            onPointerDown={(event) => press(event, note)}
            onPointerEnter={(event) => slide(event, note)}
            onContextMenu={(event) => event.preventDefault()}
            style={{
              ...styles.black,
              left: `${(key.afterWhite + 1) * WHITE_WIDTH_PCT - BLACK_WIDTH_PCT / 2}%`,
              width: `${BLACK_WIDTH_PCT}%`,
              background: held.has(note) ? '#2f6fd0' : '#1c1c1c',
            }}
          >
            <span style={styles.blackLabel}>{key.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const styles = {
  board: {
    position: 'relative',
    width: '100%',
    height: '13rem',
    // Without this the browser claims the gesture for scrolling or double-tap zoom and
    // steals notes mid-phrase. It is the single most important line for touch play.
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
  },
  white: {
    position: 'absolute',
    top: 0,
    height: '100%',
    border: '1px solid #333',
    borderRadius: '0 0 4px 4px',
    padding: 0,
    cursor: 'pointer',
    touchAction: 'none',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  black: {
    position: 'absolute',
    top: 0,
    height: '62%',
    border: '1px solid #000',
    borderRadius: '0 0 3px 3px',
    padding: 0,
    cursor: 'pointer',
    touchAction: 'none',
    zIndex: 2,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  whiteLabel: { fontSize: '0.7rem', color: '#444', paddingBottom: '0.5rem' },
  blackLabel: { fontSize: '0.6rem', color: '#ccc', paddingBottom: '0.35rem' },
} as const satisfies Record<string, React.CSSProperties>;
