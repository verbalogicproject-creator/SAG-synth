#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';

/**
 * scripts/sag-observe.mjs — answer "did the synth make sound?"
 *
 * The observation log is JSONL and readable with `tail`, but raw rows do not answer the
 * question; they require someone to know which fields matter and what a healthy one looks
 * like. This does the interpretation, so the answer is one command rather than a habit.
 *
 * Usage:
 *   node scripts/sag-observe.mjs           # the whole session
 *   node scripts/sag-observe.mjs 30        # ...restricted to the last N seconds
 *
 * Two corrections from the first live run, both worth keeping visible because the first
 * version of this script got them wrong in ways that produced confident nonsense:
 *
 * 1. **It answers "did it sound", not "is it sounding now".** The first version defaulted
 *    to a 30-second window, which landed entirely after the player had stopped, and
 *    reported SILENT for a session that had sounded perfectly well seconds earlier. The
 *    question a person actually asks is about the session.
 *
 * 2. **`null` means silence and must never be reduced numerically.** `level_db` is null on
 *    the wire when silent, because JSON cannot carry -Infinity. `Math.max` over those
 *    nulls returns **0**, and the first version duly reported a peak of `0.0 dBFS` — full
 *    scale — for a synth producing nothing. A fabricated reading is worse than a missing
 *    one.
 *
 * What a healthy verdict means: the engine produced signal and the page did not suppress
 * it. Device volume, a hardware mute, Bluetooth routing and a backgrounded tab are all
 * downstream of anything measurable from a page.
 */

const LOG = '.sag/audio-observed.jsonl';
const SIGNAL_FLOOR = 0.001;
const windowSeconds = process.argv[2] === undefined ? null : Number(process.argv[2]);

if (!existsSync(LOG)) {
  console.log(`no observations yet — ${LOG} does not exist.`);
  console.log('start the dev server, open the app, and play a note.');
  process.exit(0);
}

const all = readFileSync(LOG, 'utf8')
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

if (all.length === 0) {
  console.log('log exists but holds no parseable observations.');
  process.exit(0);
}

const newest = all[all.length - 1];
const rows =
  windowSeconds === null
    ? all
    : all.filter((row) => row.observed_at >= newest.observed_at - windowSeconds * 1000);

const started = rows[0].observed_at;
const spanSeconds = (newest.observed_at - started) / 1000;
const instances = [...new Set(rows.map((row) => row.instance_id))];
const sounded = rows.filter((row) => row.peak > SIGNAL_FLOOR);
const states = [...new Set(rows.map((row) => row.context_state))];
const gaps = [...new Set(rows.flatMap((row) => row.unimplemented ?? []))];
const ageSeconds = Math.round((Date.now() - newest.observed_at) / 1000);

/** Levels, with nulls EXCLUDED rather than coerced — see the header. */
const levels = rows.map((row) => row.level_db).filter((value) => typeof value === 'number');
const loudest = sounded.reduce((best, row) => (row.peak > best.peak ? row : best), sounded[0]);

const line = (label, value) => console.log(`  ${label.padEnd(24)}${value}`);
const at = (row) => `t+${((row.observed_at - started) / 1000).toFixed(1)}s`;

const scope = windowSeconds === null ? 'whole session' : `last ${windowSeconds}s`;
console.log(`\nSAG-synth — ${rows.length} observations over ${spanSeconds.toFixed(0)}s (${scope})\n`);
line('last seen', ageSeconds < 5 ? 'just now' : `${ageSeconds}s ago`);
line('context state', states.join(', '));
line(
  'engine instances',
  instances.length === 1 ? instances[0] : `${instances.length} — ${instances.join(', ')}`,
);
line('voices (max)', Math.max(...rows.map((row) => row.voices)));
line('observations w/ signal', `${sounded.length} of ${rows.length}`);
line('peak (max)', sounded.length > 0 ? loudest.peak.toFixed(4) : '—');
line('level (max dBFS)', levels.length > 0 ? Math.max(...levels).toFixed(1) : '— (silent throughout)');
line('output muted', String(newest.destination_muted ?? 'unknown'));
if (gaps.length > 0) line('unimplemented', gaps.join(', '));
if (sounded.length > 0) line('sounded during', `${at(sounded[0])} .. ${at(sounded[sounded.length - 1])}`);

console.log('');

// The verdict branches in causal order, so the first thing that fires is the most upstream
// explanation. Reporting "no signal" while the context is suspended would send someone
// looking in exactly the wrong place.
//
// Note the ordering choice that the first run got wrong: having sounded AT ALL is checked
// before staleness. A session that played and then went quiet is a success, not a fault,
// and saying STALE about it buries the answer the person came for.
if (!states.includes('running') && sounded.length === 0) {
  console.log('SUSPENDED — the AudioContext never ran in this window, so nothing could');
  console.log('sound whatever the engine did. Needs a qualifying user gesture');
  console.log('(pointerup, not pointerdown).');
} else if (instances.length > 1) {
  console.log(`LEAKED — ${instances.length} engine instances alive in this window. This is the`);
  console.log('hot-reload leak: each reload built a graph and the old ones kept summing.');
  console.log('Reload the tab. If it persists, import.meta.hot.dispose is not firing.');
} else if (newest.destination_muted === true) {
  console.log('MUTED AT THE OUTPUT — the engine is fine and the output stage is muted.');
} else if (sounded.length > 0) {
  console.log(`SOUNDED — signal on ${sounded.length} of ${rows.length} observations,`);
  console.log(`peaking at ${loudest.peak.toFixed(3)} (${Math.max(...levels).toFixed(1)} dBFS).`);
  if (ageSeconds > 20) {
    console.log(`Nothing since ${at(sounded[sounded.length - 1])}, which is expected if you stopped playing.`);
  }
  console.log('');
  console.log('The engine produced signal and the page did not suppress it. This does NOT');
  console.log('mean sound left the speaker: device volume, a hardware mute, Bluetooth');
  console.log('routing and a backgrounded tab are all invisible from here.');
} else if (ageSeconds > 60) {
  console.log('STALE and silent — nothing reported for over a minute and nothing sounded.');
  console.log('The page is closed, backgrounded, or the dev server restarted since.');
} else {
  console.log('SILENT — the context is running and one engine is alive, but no signal');
  console.log('reached the master bus. Either nothing was played, or the patch produces');
  console.log('nothing. Play a note and re-run before concluding it is broken.');
}
console.log('');
