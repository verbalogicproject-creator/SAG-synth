# 07 — Preset Save/Load System

## Design Goal
A preset captures the *entire sound-defining state* of one synth voice/patch: oscillator settings, envelope(s), filter, LFOs, and effects-chain parameters — as a single serializable JSON object, independent of the audio graph itself.

## Leveraging Tone.js `.get()`/`.set()`
Every Tone.js node (instruments and effects) implements `.get()` (returns current param values as plain object) and `.set(obj)` (applies params). This is the cleanest foundation for presets [web:46]:

```ts
function exportPreset(synth: Tone.MonoSynth, effects: Record<string, Tone.ToneAudioNode>): SynthPreset {
  return {
    id: crypto.randomUUID(),
    name: "My Preset",
    createdAt: Date.now(),
    voice: synth.get(),                 // oscillator, envelope, filter, filterEnvelope...
    effects: Object.fromEntries(
      Object.entries(effects).map(([key, node]) => [key, (node as any).get()])
    ),
  };
}

function applyPreset(synth: Tone.MonoSynth, effects: Record<string, Tone.ToneAudioNode>, preset: SynthPreset) {
  synth.set(preset.voice);
  for (const [key, params] of Object.entries(preset.effects)) {
    (effects[key] as any).set(params);
  }
}
```

## Preset Data Model (TypeScript)
```ts
interface SynthPreset {
  id: string;
  name: string;
  category?: string;          // "Bass", "Lead", "Pad", "Keys", "Drum", "FX"
  author?: string;
  createdAt: number;
  voice: {
    oscillator: { type: string; count?: number; spread?: number };
    envelope: { attack: number; decay: number; sustain: number; release: number };
    filter: { type: string; frequency: number; Q: number; rolloff: number };
    filterEnvelope?: { attack: number; decay: number; sustain: number; release: number; baseFrequency: number; octaves: number };
    lfos?: Array<{ target: string; type: string; frequency: number | string; min: number; max: number; sync: boolean }>;
  };
  effects: Record<string, Record<string, unknown>>; // effect name -> its .get() output
}
```

## Storage Options

### 1. localStorage (simplest, good for small preset counts)
```ts
const PRESET_KEY = "synth.presets";

function savePresetToLocalStorage(preset: SynthPreset) {
  const all = JSON.parse(localStorage.getItem(PRESET_KEY) ?? "[]");
  all.push(preset);
  localStorage.setItem(PRESET_KEY, JSON.stringify(all));
}

function loadPresetsFromLocalStorage(): SynthPreset[] {
  return JSON.parse(localStorage.getItem(PRESET_KEY) ?? "[]");
}
```
Limitation: ~5-10MB total storage quota shared across the whole origin; fine for hundreds of small preset JSON blobs but not for embedded audio samples.

### 2. IndexedDB (recommended for a real preset library, esp. if presets ever embed sample data)
Use a small wrapper library like `idb` (by Jake Archibald) for ergonomics:
```bash
npm install idb
```
```ts
import { openDB } from 'idb';

const dbPromise = openDB('synth-db', 1, {
  upgrade(db) {
    db.createObjectStore('presets', { keyPath: 'id' });
    db.createObjectStore('songs', { keyPath: 'id' });
  },
});

export async function savePreset(preset: SynthPreset) {
  const db = await dbPromise;
  await db.put('presets', preset);
}
export async function getAllPresets(): Promise<SynthPreset[]> {
  const db = await dbPromise;
  return db.getAll('presets');
}
export async function deletePreset(id: string) {
  const db = await dbPromise;
  await db.delete('presets', id);
}
```

### 3. File Export/Import (portable, shareable presets — commonly expected feature)
```ts
function downloadPresetAsFile(preset: SynthPreset) {
  const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${preset.name}.synthpreset.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadPresetFromFile(file: File): Promise<SynthPreset> {
  const text = await file.text();
  return JSON.parse(text);
}
```
Recommendation: support all three — IndexedDB as the primary local library, plus file export/import for sharing presets between users/devices, mirroring how most VST/hardware synth software works.

## Preset Library / Browser UI Considerations
- Group presets by category/tag (Bass, Lead, Pad, etc.) and support search/filter.
- Store a "factory presets" JSON bundle shipped with the app (read-only, seeded into IndexedDB on first load) plus a "user presets" set that can be created/edited/deleted.
- Version your preset schema (`schemaVersion: 1`) so future format changes can be migrated when loading older presets.
- Consider a "randomize" button that generates plausible random parameter values within tasteful ranges — a delightful and commonly-expected synth feature.

## Validating Presets on Load
Because `.set()` will silently ignore unknown keys, validate/sanitize incoming preset JSON (especially from imported files) with a schema validator (e.g., `zod`) before applying, to avoid corrupt/malicious data crashing the audio graph:
```ts
import { z } from 'zod';
const EnvelopeSchema = z.object({ attack: z.number(), decay: z.number(), sustain: z.number(), release: z.number() });
const PresetSchema = z.object({ id: z.string(), name: z.string(), voice: z.object({ envelope: EnvelopeSchema }).passthrough() });
PresetSchema.parse(incomingJson);
```
