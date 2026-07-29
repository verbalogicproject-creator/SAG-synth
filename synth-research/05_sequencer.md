# 05 — Step Sequencer

## Transport: The Global Clock
`Tone.Transport` is the app-wide sample-accurate timekeeper. All scheduled musical events (loops, sequences, parts) run relative to it [web:49][web:52].

```js
Tone.Transport.bpm.value = 120;
Tone.Transport.timeSignature = 4; // beats per bar (numerator)
Tone.Transport.start();
Tone.Transport.stop();
Tone.Transport.pause();
Tone.Transport.position; // "bars:beats:sixteenths"
Tone.Transport.seconds;
```
**Critical rule**: never use `setInterval`/`setTimeout` to drive musical timing — JS timers drift. Always use Transport-scheduled callbacks and pass through the `time` argument to `triggerAttackRelease` calls [web:46][web:45].

## Tone.Sequence (fixed-grid step sequencer)
Best fit for a classic 16-step grid sequencer:
```js
const synth = new Tone.Synth().toDestination();
const notes = ["C4", ["E4", "D4", "E4"], "G4", ["A4", "G4"]]; // sub-arrays = subdivisions
const seq = new Tone.Sequence((time, note) => {
  synth.triggerAttackRelease(note, "8n", time);
}, notes, "8n").start(0);
Tone.Transport.start();
```
Sub-arrays inside the notes array automatically subdivide that step (Tidal-style pattern notation) [web:38][web:52].

## Tone.Part (flexible, arbitrary-time event list)
Better fit when notes don't sit on a fixed grid (e.g., after MIDI import, or a piano-roll style editor):
```js
const part = new Tone.Part((time, value) => {
  synth.triggerAttackRelease(value.note, value.duration, time, value.velocity);
}, [
  { time: 0, note: "C4", duration: "8n", velocity: 0.8 },
  { time: "0:2", note: "E4", duration: "4n", velocity: 0.6 },
]).start(0);
```

## Tone.Loop (simplest periodic callback)
For drum machines or simpler repeated triggers:
```js
const loop = new Tone.Loop((time) => {
  kick.triggerAttackRelease("C1", "8n", time);
}, "4n").start(0);
```

## Multi-Track Grid Step Sequencer Pattern (drum machine style)
A common UI: N rows (instruments/notes) × M steps (columns), each cell toggled active/inactive. Implemented via `Tone.Transport.scheduleRepeat`:
```js
let currentStep = 0;
const totalSteps = 16;
const grid = rows.map(() => new Array(totalSteps).fill(false));

Tone.Transport.scheduleRepeat((time) => {
  rows.forEach((row, rowIndex) => {
    if (grid[rowIndex][currentStep]) {
      row.synth.triggerAttackRelease(row.note, "16n", time);
    }
  });
  Tone.Draw.schedule(() => updatePlayheadUI(currentStep), time); // sync visuals
  currentStep = (currentStep + 1) % totalSteps;
}, "16n");
```
`Tone.Draw.schedule()` synchronizes DOM/visual updates to the exact audio event time (rather than firing immediately), keeping playhead animation and audio in sync [web:46].

## Changing BPM Live
```js
// If Transport is already running, ramp smoothly rather than jumping:
Tone.Transport.bpm.rampTo(140, 0.5);
```
Reactive frameworks (Svelte/React) should update `Tone.Transport.bpm.value` in an effect/watcher tied to a BPM slider, only while Transport is playing, to avoid stale values [web:44].

## Start/Stop/Reset Pattern
```js
async function play() {
  await Tone.start();          // must run inside a user gesture handler
  Tone.Transport.start();
}
function stop() {
  Tone.Transport.stop();
  currentStep = 0;
}
function pause() {
  Tone.Transport.pause();
}
```

## Polyphonic Multi-Track Sequencer Data Model
For a track-based sequencer (each track = one instrument/synth patch), keep a serializable pattern object per track, independent from the audio nodes themselves — this both drives playback and is what you persist to song files (see `08_song_persistence.md`):
```ts
interface Step { active: boolean; note?: string; velocity?: number; }
interface Track { id: string; instrumentPresetId: string; steps: Step[]; }
interface Pattern { bpm: number; stepsPerBar: number; tracks: Track[]; }
```

## Swing / Groove (commonly forgotten)
Real sequencers offset every other 16th note slightly late for a "swing" feel:
```js
Tone.Transport.swing = 0.2;     // 0-1 amount
Tone.Transport.swingSubdivision = "16n";
```
This is built into `Tone.Transport` directly [web:49].

## Recording Live Input into the Sequencer
To let a user play notes live and have them recorded into a Part/Sequence, capture `noteOn`/`noteOff` timestamps against `Tone.Transport.getSecondsAtTime` or `Tone.Transport.position` at trigger time, then push `{time, note, duration, velocity}` entries into a `Tone.Part`.
