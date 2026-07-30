#!/usr/bin/env node

/**
 * scripts/sag-command.mjs — play the running synth from a terminal.
 *
 * The companion to `sag-observe.mjs`. That one answers "did it make sound"; this one is
 * how you make it try. Together they are a loop that does not need a person holding the
 * phone, which is the gap that cost five debugging rounds in v0.1.
 *
 * Usage:
 *   npm run command -- '{"type":"noteOn","note":"C3","velocity":0.9}'
 *   npm run command -- '[{"type":"setEffectEnabled","effectId":"distortion","enabled":true},
 *                        {"type":"noteOn","note":"C3","velocity":0.9}]'
 *   npm run command -- --gap 400 '[…]'      # ms between commands in a sequence
 *
 * A command's shape is `SynthCommand` from `src/core/commands.ts` — there is no separate
 * API schema to look up, which is the entire idea. Nothing is validated here: the command
 * goes through the same `validateCommand` gate the UI uses, and a rejection comes back
 * with the validator's own message rather than this script's opinion of it.
 *
 * Exit codes: 0 every command accepted, 1 at least one rejected, 2 could not reach a page.
 */

const ENDPOINT = process.env.SAG_ENDPOINT ?? 'http://127.0.0.1:5173/__sag/command';

const argv = process.argv.slice(2);
let gapMs = 250;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--gap') {
    gapMs = Number(argv[i + 1]);
    i += 1;
  } else {
    positional.push(argv[i]);
  }
}

if (positional.length === 0) {
  console.error('usage: npm run command -- \'{"type":"noteOn","note":"C3","velocity":0.9}\'');
  process.exit(2);
}

let parsed;
try {
  parsed = JSON.parse(positional.join(' '));
} catch (error) {
  console.error(`not JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const commands = Array.isArray(parsed) ? parsed : [parsed];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let rejected = 0;

for (const [index, command] of commands.entries()) {
  if (index > 0 && gapMs > 0) await sleep(gapMs);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });
  } catch (error) {
    console.error(`\ncannot reach ${ENDPOINT}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    console.error('  Is the dev server running? `npm run dev`.');
    process.exit(2);
  }

  const body = await response.json().catch(() => null);

  if (response.status === 504) {
    console.error(`\n${body?.error ?? 'no page answered'}`);
    if (body?.detail) console.error(`  ${body.detail}`);
    process.exit(2);
  }

  const label = command?.type ?? '(no type)';
  // 'applied', not 'accepted' — CommandStatus is 'applied' | 'rejected'. Guessing the
  // vocabulary rather than reading it would have printed every success as a failure.
  if (body?.status === 'applied') {
    console.log(`  ✓ ${label.padEnd(20)} revision ${body.revision}`);
  } else {
    rejected += 1;
    console.log(`  ✗ ${label.padEnd(20)} ${body?.error ?? `HTTP ${response.status}`}`);
  }
}

// The reason this prints at all: a rejected command is the quietest failure this engine
// has. It validates, it journals, and nothing happens — which is exactly how the EQ
// toggle did nothing for two stages while every test passed.
if (rejected > 0) {
  console.log(`\n${rejected} of ${commands.length} refused. Nothing was applied for those.`);
  process.exit(1);
}
