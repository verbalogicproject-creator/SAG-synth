#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';

/**
 * scripts/sag-observe.mjs — answer "is the synth making sound right now?"
 *
 * The observation log is JSONL and readable with `tail`, but raw rows do not answer the
 * question; they require someone to know which fields matter and what a healthy one looks
 * like. This does the interpretation, so the answer is one command rather than a habit.
 *
 * Usage:
 *   node scripts/sag-observe.mjs           # verdict on the last 30 seconds
 *   node scripts/sag-observe.mjs 120       # ...over a different window, in seconds
 *
 * It reports what it can see and refuses to imply more. The tap is at the output stage, so
 * a healthy verdict means the engine produced signal and nothing in the page suppressed
 * it. Device volume, a hardware mute, Bluetooth routing and a backgrounded tab are all
 * downstream of anything measurable from here.
 */

const LOG = '.sag/audio-observed.jsonl';
const windowSeconds = Number(process.argv[2] ?? 30);

if (!existsSync(LOG)) {
  console.log(`no observations yet — ${LOG} does not exist.`);
  console.log('start the dev server, open the app, and play a note.');
  process.exit(0);
}

const rows = readFileSync(LOG, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

if (rows.length === 0) {
  console.log('log exists but holds no parseable observations.');
  process.exit(0);
}

const newest = rows[rows.length - 1];
const cutoff = newest.observed_at - windowSeconds * 1000;
const recent = rows.filter((row) => row.observed_at >= cutoff);

const instances = [...new Set(recent.map((row) => row.instance_id))];
const sounded = recent.filter((row) => row.peak > 0.001);
const loudest = recent.reduce((best, row) => (row.peak > best.peak ? row : best), recent[0]);
const states = [...new Set(recent.map((row) => row.context_state))];
const gaps = [...new Set(recent.flatMap((row) => row.unimplemented ?? []))];
const ageSeconds = Math.round((Date.now() - newest.observed_at) / 1000);

const line = (label, value) => console.log(`  ${label.padEnd(22)}${value}`);

console.log(`\nSAG-synth — ${recent.length} observations in the last ${windowSeconds}s\n`);
line('last seen', ageSeconds < 5 ? 'just now' : `${ageSeconds}s ago`);
line('context state', states.join(', '));
line('engine instances', instances.length === 1 ? instances[0] : `${instances.length} — ${instances.join(', ')}`);
line('voices (max)', Math.max(...recent.map((row) => row.voices)));
line('peak (max)', loudest.peak.toFixed(4));
line('level (max dBFS)', Math.max(...recent.map((row) => row.level_db)).toFixed(1));
line('output muted', String(newest.destination_muted ?? 'unknown'));
if (gaps.length > 0) line('unimplemented', gaps.join(', '));

console.log('');

// The verdict, in the order the causes actually branch. Each check rules out one thing, so
// the first that fires is the most upstream explanation — reporting "no signal" while the
// context is suspended would send someone to look in the wrong place.
if (ageSeconds > 60) {
  console.log('STALE — nothing reported for over a minute. The page is closed, backgrounded,');
  console.log('or the dev server was restarted since it last posted.');
} else if (!states.includes('running')) {
  console.log('SUSPENDED — the AudioContext is not running, so nothing can sound whatever');
  console.log('the engine does. Needs a qualifying user gesture (pointerup, not pointerdown).');
} else if (instances.length > 1) {
  console.log(`LEAKED — ${instances.length} engine instances are alive at once. This is the`);
  console.log('hot-reload leak: each reload built a graph and the old ones kept summing.');
  console.log('Reload the tab. If it persists, import.meta.hot.dispose is not firing.');
} else if (newest.destination_muted === true) {
  console.log('MUTED AT THE OUTPUT — the engine is fine and the output stage is muted.');
} else if (sounded.length === 0) {
  console.log('SILENT — the context is running and one engine is alive, but no signal');
  console.log('reached the master bus in this window. Either nothing was played, or the');
  console.log('patch produces nothing. Play a note and re-run before concluding.');
} else {
  console.log(`SOUNDING — signal on ${sounded.length} of ${recent.length} observations,`);
  console.log(`peaking at ${loudest.peak.toFixed(3)}.`);
  console.log('');
  console.log('This means the engine produced signal and the page did not suppress it.');
  console.log('It does NOT mean sound left the speaker: device volume, a hardware mute,');
  console.log('Bluetooth routing and a backgrounded tab are all invisible from here.');
}
console.log('');
