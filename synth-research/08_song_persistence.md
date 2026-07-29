# 08 — Song (Project) Save/Load

## What a "Song" Contains
Unlike a preset (one voice's sound), a song/project captures the *entire composition state*: BPM, time signature, all tracks (each referencing a preset), each track's pattern/sequence data, effect sends, mixer levels, and optionally imported-MIDI-derived data. This is the "Save Song" feature.

## Song Data Model
```ts
interface SongTrack {
  id: string;
  name: string;
  presetId: string;            // references a SynthPreset by id
  presetSnapshot?: SynthPreset; // optional: embed full preset so song is self-contained
  pattern: Step[] | PartEvent[]; // step-grid or free-time note events
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
}

interface Step { active: boolean; note?: string; velocity?: number; }
interface PartEvent { time: number; note: string; duration: number; velocity: number; }

interface Song {
  schemaVersion: number;
  id: string;
  name: string;
  bpm: number;
  timeSignature: number;
  swing: number;
  tracks: SongTrack[];
  masterEffects: Record<string, Record<string, unknown>>;
  createdAt: number;
  updatedAt: number;
}
```

**Important design decision**: embed a `presetSnapshot` copy of each track's preset inside the song, not just a `presetId` reference. This makes exported song files self-contained and portable (won't break if the referenced preset is later edited or deleted from the user's local preset library). Keep the `presetId` too, for convenience when both exist locally.

## Serialization
```ts
function serializeSong(song: Song): string {
  return JSON.stringify(song, null, 2);
}
function deserializeSong(json: string): Song {
  const data = JSON.parse(json);
  // run schema migration / validation here (see below)
  return data as Song;
}
```

## Storage: IndexedDB for the Song Library
Reuse the same `idb` wrapper pattern from `07_preset_system.md`:
```ts
export async function saveSong(song: Song) {
  const db = await dbPromise;
  song.updatedAt = Date.now();
  await db.put('songs', song);
}
export async function loadAllSongs(): Promise<Song[]> {
  const db = await dbPromise;
  return db.getAll('songs');
}
```

## File Export/Import (portable song files)
Mirrors the preset file export pattern — use a distinct file extension/mimetype convention, e.g. `.synthsong.json`:
```ts
function exportSongToFile(song: Song) {
  const blob = new Blob([JSON.stringify(song, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${song.name}.synthsong.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importSongFromFile(file: File): Promise<Song> {
  const text = await file.text();
  const song = JSON.parse(text);
  return migrateSongIfNeeded(song);
}
```

## Rebuilding Audio State from a Loaded Song
Loading a song is a "rehydration" step: deserialize JSON → recreate Tone.js instrument/effect instances → apply preset params → rebuild Tone.Sequence/Part objects from pattern data:
```ts
async function loadSongIntoEngine(song: Song, engine: SynthEngine) {
  engine.disposeAllTracks();          // clean up existing audio nodes
  Tone.Transport.bpm.value = song.bpm;
  Tone.Transport.timeSignature = song.timeSignature;
  Tone.Transport.swing = song.swing;

  for (const track of song.tracks) {
    const voice = engine.createTrackVoice(track.presetSnapshot ?? await lookupPreset(track.presetId));
    engine.attachPattern(track.id, voice, track.pattern);
    voice.volume.value = track.volume;
    voice.pan?.value?.setValueAtTime?.(track.pan, Tone.now());
  }
}
```

## Autosave Pattern
For a DAW-like feel, autosave to IndexedDB periodically (debounced) rather than requiring explicit "save":
```ts
import { debounce } from 'lodash-es';
const autosave = debounce((song: Song) => saveSong(song), 2000);
// call autosave(currentSongState) on every state mutation
```
Keep a separate "last saved" song snapshot in a `songs_autosave` store distinct from explicit user-named saves, and offer a "restore last session" prompt on app load if an autosave newer than the last explicit save is found.

## Schema Versioning & Migration
```ts
function migrateSongIfNeeded(raw: any): Song {
  if (raw.schemaVersion === 1) return raw as Song;
  if (raw.schemaVersion === undefined) {
    // migrate legacy format
    return { ...raw, schemaVersion: 1, swing: raw.swing ?? 0 };
  }
  throw new Error(`Unsupported song schema version: ${raw.schemaVersion}`);
}
```
Always bump `schemaVersion` when the shape changes, and write a migration function for each historical version — critical for not breaking users' saved songs after you ship updates.

## Undo/Redo (commonly forgotten, expected in any editor)
Keep the Song state as an immutable object and maintain an undo/redo stack of snapshots (or, more efficiently, of inverse-patches via a library like `immer` + `use-undo`/`zundo` if using Zustand):
```ts
import { temporal } from 'zundo';
const useSongStore = create(temporal((set) => ({ song: initialSong, /* actions */ })));
// useSongStore.temporal.getState().undo() / redo()
```
