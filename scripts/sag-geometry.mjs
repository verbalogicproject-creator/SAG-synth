#!/usr/bin/env node

/**
 * scripts/sag-geometry.mjs — measure where every declared control actually is.
 *
 * `public/sag-surface.json` is generated from `PARAM_SPECS` + `NAV_TABS` + the mint, so it
 * knows that `ctl-041` is the cutoff knob and lives on the FILTER tab. It does not know
 * whether that knob is on screen, how big it is, or whether a finger can hit it. Those are
 * not properties of a declaration — they are properties of a rendered page, and the only
 * honest way to learn them is to render the page and measure.
 *
 * That is this script. It drives the real dev server in real chromium at a real phone
 * viewport, walks the whole nav, and reads `getBoundingClientRect()` for every element
 * carrying a `data-sag-id`. The output joins to the SOT on that id.
 *
 * **Why the id is what makes this possible.** Identity was minted flat and opaque —
 * `ctl-041`, never `filter-knob-3` — specifically so that nothing about layout is encoded
 * in it. That decision has been paying nothing until now. Here it pays: the selector
 * `[data-sag-id="ctl-041"]` survives every restyle, retheme and reflow, because it names
 * the control rather than its position in a tree. Automation written against CSS paths
 * breaks on the first design pass; this does not.
 *
 * **What only a live measurement can catch.** A declaration cannot be wrong about a rect.
 * It can only be silent. So the failures this finds are a class the whole test suite is
 * structurally blind to: a control that renders at zero size, one pushed off-screen by a
 * sibling, one smaller than a fingertip, and one that is declared on a tab and never drawn
 * at all. `synth-tabs.browser.test.ts` proves reachability by clicking a mounted
 * component; it cannot prove that the shipped page puts the result somewhere usable.
 *
 * Plain `.mjs`, outside `tsconfig.json`'s `include`, for the same reason as its two
 * siblings: typing it would mean `@types/node`, which the contract refuses so that
 * `src/core/**` stays environment-free.
 *
 * Usage:
 *   npm run dev                 # in another terminal — this script does not start it
 *   npm run geometry
 *   npm run geometry -- --viewport 1024x768
 *
 * Exit codes: 0 harvest written and the join is clean, 1 a gate failed, 2 no page answered.
 */

import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const URL = process.env.SAG_URL ?? 'http://127.0.0.1:5173/';
const OUT = '.sag/surface-geometry.json';
const SOT = 'public/sag-surface.json';

/**
 * A phone in portrait, because that is what the surface was designed for and what the
 * instrument is played on. Measuring at a desktop width would report comfortable numbers
 * for a layout nobody uses.
 */
const DEFAULT_VIEWPORT = { width: 412, height: 915 };

/**
 * The smallest square a fingertip can reliably hit, and the same constant the control kit
 * styles against (`src/clients/synth/tokens.ts` TOUCH_MIN). Restated here rather than
 * imported because this file is outside the TypeScript program — and a second opinion
 * about a number is exactly the drift this project keeps finding, so the gate below
 * reports it as a warning and names the token rather than silently disagreeing with it.
 */
const TOUCH_MIN = 44;

/** PRoot/Termux cannot use the chromium sandbox — same flags as `vitest.config.ts`. */
const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

function parseViewport(argv) {
  const at = argv.indexOf('--viewport');
  if (at === -1) return DEFAULT_VIEWPORT;
  const match = /^(\d+)x(\d+)$/.exec(argv[at + 1] ?? '');
  if (match === null) {
    console.error('--viewport wants WIDTHxHEIGHT, e.g. 412x915');
    process.exit(2);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Every `data-sag-id` currently in the document, with its measured box.
 *
 * Runs inside the page, so `getBoundingClientRect()` is the browser's own answer after
 * layout — not a prediction from the stylesheet.
 */
function harvest(page) {
  return page.$$eval('[data-sag-id]', (nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);

      // The kit puts `data-sag-id` on a WRAPPER, not on the thing a finger lands on — a
      // Slider's wrapper includes its label row, so the wrapper's box overstates the
      // target by the height of some text. Measuring only the wrapper would report a
      // comfortable number for a control that is half the size it looks.
      //
      // So the hit box is measured separately: the largest interactive descendant, or
      // the node itself when it is the interactive one. Where they differ, the smaller
      // is the truth about whether a thumb can hit it.
      const interactive = [
        ...node.querySelectorAll('input, button, select, textarea, [role="slider"], [role="switch"]'),
      ];
      const target = interactive
        .map((element) => element.getBoundingClientRect())
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
      const hit = target ?? box;

      return {
        id: node.getAttribute('data-sag-id'),
        path: node.getAttribute('data-sag-path'),
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute('role'),
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
        hitWidth: Math.round(hit.width),
        hitHeight: Math.round(hit.height),
        /** True when the id names a wrapper rather than the element that takes the touch. */
        wrapped: target !== undefined,
        hidden: style.display === 'none' || style.visibility === 'hidden',
      };
    }),
  );
}

/**
 * Walk the nav the way a thumb would, recording everything that appears.
 *
 * Selection is by `aria-label`, never by index into a flat list of tabs. The labels are
 * part of the accessible contract and a screen reader depends on them, so a rename is a
 * deliberate act that should break this — whereas an index silently starts pointing at a
 * different tab the moment one is inserted.
 */
async function sweep(page, record) {
  const top = page.locator('[role="tablist"][aria-label="signal path"] [role="tab"]');
  const topCount = await top.count();
  if (topCount === 0) throw new Error('no top-level tabs — is this the synth surface?');

  for (let i = 0; i < topCount; i += 1) {
    await top.nth(i).click();
    const where = (await top.nth(i).innerText()).trim().toLowerCase();
    record(await harvest(page), where);

    // Sub-tabs and oscillator slot letters are both `role="tab"` inside their own
    // tablist. Re-counted on every pass because clicking one can change how many exist.
    const subs = page.locator('[role="tablist"]:not([aria-label="signal path"]) [role="tab"]');
    for (let j = 0; j < (await subs.count()); j += 1) {
      await subs.nth(j).click();
      record(await harvest(page), where);
      // Back to the top tab so the next sub-tab is chosen from the same starting state.
      await top.nth(i).click();
    }
  }

  // The bay is an overlay rather than a tab, so the sweep above cannot reach it.
  const bayButton = page.locator('[aria-label="open the routing bay"]');
  if ((await bayButton.count()) > 0) {
    await bayButton.first().click();
    record(await harvest(page), 'bay');
    const close = page.locator('[aria-label="close the routing bay"]');
    if ((await close.count()) > 0) await close.first().click();
  }
}

async function main() {
  const viewport = parseViewport(process.argv.slice(2));
  const sot = JSON.parse(readFileSync(SOT, 'utf8'));
  const declared = new Map(sot.controls.map((control) => [control.id, control]));

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const page = await browser.newPage({ viewport });

  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForSelector('[data-sag-id]', { timeout: 15_000 });
  } catch {
    await browser.close();
    console.error(`no page answered at ${URL} — is \`npm run dev\` running?`);
    process.exit(2);
  }

  /** id -> the sighting with the largest area, plus every place it was seen. */
  const seen = new Map();
  const record = (rows, where) => {
    for (const row of rows) {
      if (row.id === null) continue;
      const existing = seen.get(row.id);
      const area = row.width * row.height;
      if (existing === undefined) {
        seen.set(row.id, { ...row, seenOn: [where] });
      } else {
        if (!existing.seenOn.includes(where)) existing.seenOn.push(where);
        if (area > existing.width * existing.height) Object.assign(existing, row);
      }
    }
  };

  let swept = true;
  try {
    await sweep(page, record);
  } catch (error) {
    swept = false;
    console.error(`sweep stopped early: ${error.message}`);
  }

  await browser.close();

  const rows = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));

  // --- the join, which is the whole point of the exercise -------------------------
  const unknown = rows.filter((row) => !declared.has(row.id));
  const missing = [...declared.values()].filter((control) => !seen.has(control.id));
  const zeroSized = rows.filter((row) => row.width === 0 || row.height === 0);
  const offscreen = rows.filter(
    (row) => row.x + row.width <= 0 || row.x >= viewport.width || row.y + row.height <= 0,
  );
  // Judged on the hit box, not the wrapper. See `harvest`.
  const tooSmall = rows.filter(
    (row) => !zeroSized.includes(row) && Math.min(row.hitWidth, row.hitHeight) < TOUCH_MIN,
  );

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        url: URL,
        viewport,
        touchMin: TOUCH_MIN,
        counts: {
          declared: declared.size,
          measured: rows.length,
          missing: missing.length,
          unknown: unknown.length,
          zeroSized: zeroSized.length,
          offscreen: offscreen.length,
          belowTouchMin: tooSmall.length,
        },
        controls: rows,
      },
      null,
      2,
    )}\n`,
  );

  const say = (label, list, render = (row) => row.id) =>
    console.log(
      `${label.padEnd(24)} ${String(list.length).padStart(4)}` +
        (list.length > 0 ? `   ${list.slice(0, 8).map(render).join(' ')}` : ''),
    );

  console.log(`\n${URL}  ${viewport.width}x${viewport.height}\n`);
  console.log(`declared in the SOT       ${String(declared.size).padStart(4)}`);
  say('measured on screen', rows);
  say('declared, never drawn', missing, (control) => `${control.id}:${control.path ?? control.id}`);
  say('drawn, not declared', unknown);
  say('zero-sized', zeroSized);
  say('off-screen', offscreen);
  say(
    `below TOUCH_MIN (${TOUCH_MIN}px)`,
    tooSmall,
    (row) => `${row.id}(${row.hitWidth}x${row.hitHeight})`,
  );
  console.log(`\nwritten to ${OUT}\n`);

  // A rect this script measured that the mint has never heard of means the surface and
  // the SOT have diverged — the one failure that makes every other number meaningless,
  // because the join is what turns pixels into knowledge.
  if (unknown.length > 0) {
    console.error('a drawn control carries an id the mint does not declare.');
    process.exit(1);
  }
  if (!swept) process.exit(1);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
