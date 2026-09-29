/**
 * src/clients/synth/LibrarySheet.tsx — the sound library (cycle 2, C3b).
 *
 * Eyal: "persistence would be useful, and an asset library". The Stitch `preset_browser`
 * screen is the shape (categories, a list, SAVE AS), folded into one phone column.
 *
 * Everything here is an ordinary command — `savePreset`, `loadPreset`, `deletePreset`,
 * `importPreset` — so the library is journaled and undoable like any edit, and the session
 * mirror (`app/session-sync.ts`) is what writes it to storage. This file never touches
 * storage itself. Files go out through `app/files.ts` (Download/SAG/ on the phone) and come
 * in through a file input, read by the pure `parsePresetFile`, which upgrades old presets.
 */

import { useRef, useState } from 'react';
import type { SynthCommand } from '../../core/commands';
import { PRESET_CATEGORIES } from '../../core/schemas';
import { parsePresetFile, presetFile, safeFileName } from '../../core/session';
import type { EngineState } from '../../core/state';
import type { PresetCategory, SynthPreset } from '../../core/types';
import { saveFile } from '../../app/files';
import { COLOR, FONT, TOUCH_MIN } from './tokens';

type Filter = 'all' | 'mine' | PresetCategory;

export interface LibrarySheetProps {
  state: EngineState;
  onCommand: (command: SynthCommand) => void;
}

export function LibrarySheet({ state, onCommand }: LibrarySheetProps) {
  const [name, setName] = useState(state.patch.factory === true ? '' : state.patch.name);
  const [category, setCategory] = useState<PresetCategory | ''>(state.patch.category ?? '');
  const [filter, setFilter] = useState<Filter>('all');
  const [status, setStatus] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const all = Object.values(state.presets).sort(
    (a, b) => Number(a.factory === true) - Number(b.factory === true) || a.name.localeCompare(b.name),
  );
  const shown = all.filter((preset) =>
    filter === 'all' ? true : filter === 'mine' ? preset.factory !== true : preset.category === filter,
  );
  const categories = PRESET_CATEGORIES.filter((c) => all.some((preset) => preset.category === c));
  const mine = all.filter((preset) => preset.factory !== true);

  const save = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setStatus('Give the sound a name first.');
      return;
    }
    onCommand({ type: 'savePreset', name: trimmed, ...(category === '' ? {} : { category }) });
    setStatus(`Saved “${trimmed}” to your library.`);
  };

  const exportPresets = (presets: SynthPreset[], fileName: string) => {
    const result = saveFile(safeFileName(fileName, 'json'), 'application/json', presetFile(presets, Date.now()));
    setStatus(result.ok ? `Exported to ${result.where}` : `Export failed: ${result.error}`);
  };

  const importFile = async (file: File) => {
    const read = parsePresetFile(await file.text());
    for (const preset of read.presets) {
      // A file holding a copy of a FACTORY preset would be refused as-is (the bundle is
      // this build's); it comes in as the player's own under a fresh id instead.
      const clash = state.presets[preset.id]?.factory === true;
      onCommand({
        type: 'importPreset',
        preset: clash ? { ...preset, id: `imported-${crypto.randomUUID()}`, factory: false } : preset,
      });
    }
    const imported = `Imported ${read.presets.length} preset${read.presets.length === 1 ? '' : 's'}.`;
    setStatus(read.errors.length === 0 ? imported : `${imported} Skipped: ${read.errors.join('; ')}`);
    setFilter('mine');
  };

  return (
    <div style={styles.wrap}>
      <section style={styles.saveBox} aria-label="save the current sound">
        <span style={styles.label}>SAVE AS</span>
        <div style={styles.saveRow}>
          <input
            type="text"
            value={name}
            placeholder="name this sound"
            aria-label="preset name"
            onChange={(event) => setName(event.target.value)}
            style={styles.input}
          />
          <select
            value={category}
            aria-label="preset category"
            onChange={(event) => setCategory(event.target.value as PresetCategory | '')}
            style={styles.select}
          >
            <option value="">—</option>
            {PRESET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button type="button" onClick={save} style={styles.primary}>
            SAVE
          </button>
        </div>
        <p style={styles.note}>Your current sound and song are also saved automatically.</p>
      </section>

      <div role="tablist" aria-label="library filter" style={styles.chips}>
        {(['all', 'mine', ...categories] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            style={{ ...styles.chip, ...(filter === f ? styles.chipOn : null) }}
          >
            {f === 'all' ? 'ALL' : f === 'mine' ? `MINE ${mine.length}` : f.toUpperCase()}
          </button>
        ))}
      </div>

      {status !== null && (
        <p role="status" style={styles.status}>
          {status}
        </p>
      )}

      <ul style={styles.list} aria-label="presets">
        {shown.length === 0 && <li style={styles.note}>Nothing here yet — SAVE AS puts your sound in.</li>}
        {shown.map((preset) => {
          const current = preset.id === state.patch.id;
          const own = preset.factory !== true;
          return (
            <li key={preset.id} style={{ ...styles.row, ...(current ? styles.rowOn : null) }}>
              <button
                type="button"
                onClick={() => {
                  onCommand({ type: 'loadPreset', presetId: preset.id });
                  setStatus(`Loaded “${preset.name}”.`);
                }}
                style={styles.load}
                aria-label={`load ${preset.name}`}
              >
                <span style={styles.name}>{preset.name}</span>
                <span style={styles.meta}>
                  {[preset.category, own ? 'mine' : 'factory'].filter(Boolean).join(' · ')}
                </span>
              </button>
              <button
                type="button"
                onClick={() => exportPresets([preset], preset.name)}
                style={styles.icon}
                aria-label={`export ${preset.name}`}
              >
                ⤓
              </button>
              {own && (
                <button
                  type="button"
                  onClick={() => {
                    if (confirmDelete !== preset.id) {
                      setConfirmDelete(preset.id);
                      return;
                    }
                    setConfirmDelete(null);
                    onCommand({ type: 'deletePreset', presetId: preset.id });
                    setStatus(`Deleted “${preset.name}”. Undo brings it back.`);
                  }}
                  style={{ ...styles.icon, ...(confirmDelete === preset.id ? styles.danger : null) }}
                  aria-label={confirmDelete === preset.id ? `really delete ${preset.name}` : `delete ${preset.name}`}
                >
                  {confirmDelete === preset.id ? 'SURE?' : '✕'}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <footer style={styles.footer}>
        <button type="button" onClick={() => fileInput.current?.click()} style={styles.secondary}>
          IMPORT
        </button>
        <button
          type="button"
          disabled={mine.length === 0}
          onClick={() => exportPresets(mine, 'sag-library')}
          style={{ ...styles.secondary, opacity: mine.length === 0 ? 0.4 : 1 }}
        >
          EXPORT ALL MINE
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          aria-label="import a preset file"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file !== undefined) void importFile(file);
          }}
        />
      </footer>
    </div>
  );
}

const button = {
  minHeight: TOUCH_MIN,
  minWidth: TOUCH_MIN,
  border: `1px solid ${COLOR.border}`,
  borderRadius: 4,
  background: 'transparent',
  color: COLOR.text,
  fontFamily: FONT.display,
  fontSize: '0.7rem',
  letterSpacing: '0.08em',
  cursor: 'pointer',
} as const;

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '0.7rem' },
  saveBox: { background: COLOR.surfaceLow, borderRadius: 6, padding: '0.6rem 0.7rem' },
  label: { fontFamily: FONT.display, fontSize: '0.65rem', letterSpacing: '0.1em', color: COLOR.textDim },
  saveRow: { display: 'flex', gap: '0.4rem', marginTop: '0.35rem' },
  input: {
    flex: '1 1 auto',
    minWidth: 0,
    minHeight: TOUCH_MIN,
    padding: '0 0.6rem',
    background: COLOR.surfaceHigh,
    color: COLOR.text,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 4,
    fontFamily: FONT.mono,
    fontSize: '0.85rem',
  },
  select: {
    minHeight: TOUCH_MIN,
    background: COLOR.surfaceHigh,
    color: COLOR.text,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 4,
    fontFamily: FONT.mono,
    fontSize: '0.75rem',
  },
  primary: { ...button, padding: '0 0.9rem', background: COLOR.accent, color: COLOR.surfaceLowest, borderColor: COLOR.accent },
  secondary: { ...button, flex: '1 1 0', padding: '0 0.6rem' },
  note: { margin: '0.4rem 0 0', fontFamily: FONT.display, fontSize: '0.65rem', color: COLOR.textDim },
  status: { margin: 0, fontFamily: FONT.display, fontSize: '0.7rem', color: COLOR.accentText },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '0.3rem' },
  chip: { ...button, padding: '0 0.6rem', color: COLOR.textDim },
  chipOn: { color: COLOR.surfaceLowest, background: COLOR.accent, borderColor: COLOR.accent },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.3rem' },
  row: {
    display: 'flex',
    alignItems: 'stretch',
    gap: '0.3rem',
    background: COLOR.surfaceLow,
    borderRadius: 4,
    border: `1px solid transparent`,
  },
  rowOn: { borderColor: COLOR.accent },
  load: {
    ...button,
    flex: '1 1 auto',
    border: 'none',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '0.3rem 0.6rem',
    textAlign: 'left',
  },
  name: { fontFamily: FONT.mono, fontSize: '0.85rem', color: COLOR.text },
  meta: { fontFamily: FONT.display, fontSize: '0.6rem', color: COLOR.textDim, letterSpacing: '0.06em' },
  icon: { ...button, border: 'none', color: COLOR.textDim, fontSize: '0.9rem' },
  danger: { color: COLOR.surfaceLowest, background: COLOR.overflow, fontSize: '0.6rem' },
  footer: { display: 'flex', gap: '0.4rem' },
} as const satisfies Record<string, React.CSSProperties>;
