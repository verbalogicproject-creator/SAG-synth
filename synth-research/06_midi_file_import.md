# 06 — MIDI File Import for Sequencer Autoplay

## Library: @tonejs/midi
The standard tool for parsing `.mid`/`.smf` files into a Tone.js-friendly JSON structure. Wraps the lower-level `midi-file` parser [web:29][web:40].

```bash
npm install @tonejs/midi
```

```ts
import { Midi } from '@tonejs/midi';

// Browser — load from URL
const midi = await Midi.fromUrl('path/to/song.mid');

// Browser — load from <input type="file">
async function loadMidiFile(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  const midi = new Midi(arrayBuffer);
  return midi;
}

// Node.js — raw buffer
import fs from 'fs';
const midiData = fs.readFileSync('test.mid');
const midi = new Midi(midiData);
```

## Parsed MIDI Structure
```ts
midi.name;             // track name from first track
midi.header.tempos;    // tempo change events
midi.header.timeSignatures;
midi.tracks.forEach(track => {
  track.name;
  track.instrument;    // { number, family, name }
  track.notes.forEach(note => {
    note.name;         // e.g. "C4"
    note.midi;         // MIDI note number
    note.time;         // absolute start time in seconds
    note.duration;     // seconds
    note.velocity;     // 0-1 normalized
  });
  track.controlChanges; // CC automation (mod wheel, sustain pedal, etc.)
});
```

## Scheduling Parsed MIDI onto the Transport for Autoplay
This is the core "load a MIDI file into the sequencer for autoplay" pattern [web:37]:

```ts
async function scheduleMidiForPlayback(midi: Midi, synthEngine: SynthEngine) {
  Tone.Transport.cancel(); // clear previous schedule
  Tone.Transport.bpm.value = midi.header.tempos[0]?.bpm ?? 120;

  const now = Tone.now() + 0.5;
  const synths: Tone.PolySynth[] = [];

  midi.tracks.forEach((track) => {
    if (track.notes.length === 0) return;
    // one polysynth per track, or map track -> existing engine voice/preset
    const synth = new Tone.PolySynth(Tone.Synth, {
      envelope: { attack: 0.02, decay: 0.1, sustain: 0.3, release: 1 },
    }).toDestination();
    synths.push(synth);

    track.notes.forEach((note) => {
      Tone.Transport.schedule((time) => {
        synth.triggerAttackRelease(note.name, note.duration, time, note.velocity);
      }, note.time);
    });
  });

  return synths; // keep references for disposal/stop
}
```

Alternative approach using `Tone.Part` per track (recommended — integrates with your existing sequencer engine rather than bypassing it):
```ts
function midiTrackToPart(track, synth) {
  return new Tone.Part((time, note) => {
    synth.triggerAttackRelease(note.name, note.duration, time, note.velocity);
  }, track.notes.map(n => ({ time: n.time, name: n.name, duration: n.duration, velocity: n.velocity })))
  .start(0);
}
```

## Mapping MIDI Tracks to Synth Presets/Channels
Real MIDI files contain multiple tracks/channels, often intended for different instruments (`track.instrument.family`, e.g. "piano", "brass", "drums" per GM Program mapping). For a full-featured autoplay:
1. Iterate `midi.tracks`, create one synth voice group per track.
2. Optionally auto-map `track.instrument.number` (General MIDI program number 0-127) to a preset preset from your library (e.g., 0-7 = pianos → your "Piano" preset; 33-40 = bass → your "Bass" preset).
3. Respect drum channel: MIDI channel 10 (index 9) is conventionally percussion — map notes to a drum-kit sample map rather than pitched synthesis.
4. Handle tempo/time-signature changes mid-file via `midi.header.tempos` array — schedule `Tone.Transport.bpm` changes at each tempo event's `time`.

## Stopping / Cleaning Up
```ts
function stopMidiPlayback(synths: Tone.PolySynth[]) {
  Tone.Transport.stop();
  Tone.Transport.cancel();
  synths.forEach(s => s.dispose());
}
```

## File Input UI Pattern
```html
<input type="file" accept=".mid,.midi" id="midi-upload" />
```
```ts
document.getElementById('midi-upload').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files[0];
  const arrayBuffer = await file.arrayBuffer();
  const midi = new Midi(arrayBuffer);
  await scheduleMidiForPlayback(midi, synthEngine);
  await Tone.start();
  Tone.Transport.start();
});
```

## Alternative / Supporting Libraries
- `midi-file` — low-level binary MIDI parser/encoder that `@tonejs/midi` is built on; useful if you need raw MIDI event access [web:29].
- `midi-json-parser` — alternative parser producing plain JSON, usable in browser or Node [web:36].
- **Web MIDI API** (`navigator.requestMIDIAccess()`) — for *live* hardware MIDI controllers/keyboards feeding notes into your synth in real time (distinct from file playback, but often wanted alongside it) [web:33][web:39]. Optionally combine with `WebMidi.js` for a friendlier event API (`input.addListener('noteon', ...)`) [web:39].

## Exporting Sequencer Patterns Back to MIDI (bonus)
`@tonejs/midi` also supports writing: build a `new Midi()`, add tracks/notes, and call `.toArray()` to get a `Uint8Array` you can save as a `.mid` file — useful if you want an "export song as MIDI" feature alongside your native song format [web:29].
