#!/usr/bin/env node
/**
 * Loco Lift — deterministic test of the quality governor's decision logic.
 *
 * ## Why this is not a browser test
 *
 * The obvious test — boot the game and watch the governor react — cannot work
 * here. Headless Chromium rasterises through SwiftShader, which renders this
 * city at roughly **0.3 fps**: measured frame deltas were 1433, 7216, 5566,
 * 5616 and 5249 ms. That is ~200x slower than the slowest real device, so
 * every frame trips the suspend/resume discard and the governor correctly
 * refuses to act on garbage. The environment cannot produce the 20-200 ms
 * frames the governor is designed to read.
 *
 * So the *integration* is proven in the browser (installed, ticking, wired to
 * SettingsStore) and the *decision logic* — the part with all the bugs — is
 * proven here, by driving `update()` with a synthetic frame-time sequence
 * through a fake context. Deterministic, exact, and runs in milliseconds.
 *
 * The TS is transformed in-memory with esbuild (already a Vite dependency),
 * so this tests the real source with no build step and no duplicated logic.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { transformSync } from 'esbuild';

/* ---- load the real module, transformed, with its one import stubbed ---- */

const dir = mkdtempSync(path.join(tmpdir(), 'gov-'));
const src = readFileSync('src/core/QualityGovernor.ts', 'utf8')
  .replace(`import { clamp } from './MathUtils';`, `const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));`)
  .replace(/^import type .*$/m, '');
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code;
const file = path.join(dir, 'gov.mjs');
writeFileSync(file, js);
const { QualityGovernor } = await import(file);

/* ------------------------------- harness ------------------------------- */

let pass = 0;
const fails = [];
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

// `document` is read for the hidden-tab guard; the module tolerates its
// absence, but make it explicit so the tests control it.
globalThis.document = { hidden: false };

const makeGov = (quality = 'ultra', renderScale = 1) => {
  const applied = [];
  let settings = { quality, renderScale };
  const g = new QualityGovernor({
    getSettings: () => settings,
    apply: (tier, scale) => {
      settings = { quality: tier, renderScale: scale };
      applied.push({ tier, scale });
    },
  });
  return { g, applied, settings: () => settings };
};

/** Feed `seconds` worth of frames, each `ms` long. */
const run = (g, ms, seconds) => {
  const n = Math.max(1, Math.round((seconds * 1000) / ms));
  for (let i = 0; i < n; i++) g.update({ rawDt: ms / 1000 }, ms / 1000);
};

/* --------------------------------- tests -------------------------------- */

console.log('--- 1. it steps DOWN under sustained slowness ---');
{
  const { g, applied } = makeGov();
  run(g, 40, 12); // 25 fps for 12 s
  ok(applied.length > 0, 'a downgrade was applied', JSON.stringify(applied[0] ?? null));
  ok(g.stats().downgrades > 0, 'downgrade counted', `${g.stats().downgrades}`);
  ok(g.stats().rung > 0, 'moved off the top rung', `rung ${g.stats().rung}`);
}

console.log('\n--- 2. it does NOT move at a healthy frame rate ---');
{
  const { g, applied } = makeGov();
  run(g, 16.7, 60); // 60 fps for a full minute
  ok(applied.length === 0, 'nothing was applied at 60 fps', `${applied.length} change(s)`);
  ok(g.stats().rung === 0, 'still on the top rung', `rung ${g.stats().rung}`);
}

console.log('\n--- 3. the dead band: 55 fps is left alone ---');
{
  const { g, applied } = makeGov();
  run(g, 18.2, 60); // 55 fps — below the up threshold, above the down threshold
  ok(applied.length === 0, 'no hunting in the dead band', `${applied.length} change(s)`);
}

console.log('\n--- 4. one huge hitch does not cost a tier ---');
{
  const { g, applied } = makeGov();
  for (let i = 0; i < 600; i++) {
    // 60 fps with a 900 ms stall every 100 frames
    g.update({ rawDt: (i % 100 === 0 ? 900 : 16.7) / 1000 }, 0.0167);
  }
  ok(applied.length === 0, 'median ignored the stalls', `${applied.length} change(s)`);
}

console.log('\n--- 5. it walks all the way down and stops at the bottom ---');
{
  const { g, applied } = makeGov();
  run(g, 200, 400); // 5 fps for a long time
  const s = g.stats();
  ok(s.rung === 7, 'reached the bottom rung', `rung ${s.rung} (${s.tier}@${s.scale})`);
  ok(s.tier === 'low' && s.scale === 0.55, 'bottom rung is low@0.55');
  const beforeCount = applied.length;
  run(g, 200, 200);
  ok(applied.length === beforeCount, 'it stops at the bottom instead of looping', `${applied.length - beforeCount} extra`);
}

console.log('\n--- 6. a 2 fps machine is helped, not ignored ---');
{
  // The bug this test exists for: an earlier version discarded every frame
  // over 400 ms as an outlier, going blind exactly when help was needed.
  const { g, applied } = makeGov();
  run(g, 500, 60);
  ok(applied.length > 0, 'a 500 ms frame counts as evidence', `${applied.length} change(s)`);
}

console.log('\n--- 7. a suspend/resume is still discarded ---');
{
  const { g, applied } = makeGov();
  for (let i = 0; i < 200; i++) g.update({ rawDt: 30 }, 30); // 30 s frames
  ok(applied.length === 0, '30 s deltas are ignored as suspend/resume', `${applied.length} change(s)`);
}

console.log('\n--- 8. a hidden tab does not degrade quality ---');
{
  const { g, applied } = makeGov();
  globalThis.document.hidden = true;
  run(g, 400, 120);
  globalThis.document.hidden = false;
  ok(applied.length === 0, 'nothing changed while backgrounded', `${applied.length} change(s)`);
}

console.log('\n--- 9. it never climbs above the player’s ceiling ---');
{
  const { g, applied } = makeGov('medium', 0.9);
  ok(g.stats().rung === 3, 'started at the medium rung', `rung ${g.stats().rung}`);
  run(g, 5, 600); // 200 fps — as fast as it could ever be
  ok(g.stats().rung >= 3, 'did not climb past the manual choice', `rung ${g.stats().rung}`);
  ok(applied.length === 0, 'no upgrade applied above the ceiling', `${applied.length} change(s)`);
}

console.log('\n--- 10. it recovers after a downgrade when the load clears ---');
{
  const { g, applied } = makeGov('ultra', 1);
  // The ceiling is rung 0, so recovery is permitted back up to the top.
  run(g, 40, 12);
  const afterDown = g.stats().rung;
  ok(afterDown > 0, 'downgraded first', `rung ${afterDown}`);
  run(g, 8, 200); // 125 fps for a long stretch
  const s = g.stats();
  ok(s.upgrades > 0, 'it recovered once the machine was comfortable', `${s.upgrades} upgrade(s)`);
  ok(s.rung < afterDown, 'the rung moved back up', `${afterDown} -> ${s.rung}`);
  ok(s.rung >= 0, 'and stayed within the ladder');
}

console.log('\n--- 11. pin() disables it entirely ---');
{
  const { g, applied } = makeGov();
  g.pin(true);
  run(g, 500, 120);
  ok(applied.length === 0, 'a pinned governor never acts', `${applied.length} change(s)`);
  ok(g.isPinned === true, 'and reports itself pinned');
}

console.log(`\n${fails.length === 0 ? 'ALL CHECKS PASSED' : `${fails.length} FAILED`}  (${pass} passed)`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length === 0 ? 0 : 1);
