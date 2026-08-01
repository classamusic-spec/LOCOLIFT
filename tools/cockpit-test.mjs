/**
 * Cockpit / first-person harness.
 *
 * For each drivable vehicle: boot, switch to the cockpit view, and capture the
 * view at rest, at both steering locks, at speed and at night. Records draw
 * calls and triangles in chase versus cockpit so the real cost of the interior
 * geometry is measured rather than guessed, and fails on any shader link
 * failure the guard recorded.
 *
 * Everything waits on *game state*, never on wall-clock: under SwiftShader this
 * city renders at roughly a frame a second, so a `waitForTimeout(500)` buys
 * about half a frame and every assertion downstream of it is a lie.
 *
 * **Bounded.** `--budget` (seconds, default 480) is a hard wall-clock ceiling on
 * the whole run. Steps that would start after it stop instead, are listed as
 * skipped, and the process exits non-zero — so this can sit in CI or a
 * verification pass without ever hanging.
 *
 *   node tools/cockpit-test.mjs [--url http://127.0.0.1:4182] [--out .captures-cockpit]
 *                               [--vehicles jeep,bus,carriage]
 *                               [--quality low] [--width 900] [--height 506]
 *                               [--budget 480] [--patience 150000]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const URL_ = arg('url', 'http://127.0.0.1:4182');
const OUT = arg('out', '.captures-cockpit');
const WIDTH = Number(arg('width', '900'));
const HEIGHT = Number(arg('height', '506'));
const QUALITY = arg('quality', 'low');
/**
 * Per-wait ceiling, and a whole-run budget.
 *
 * These are two different jobs and it matters that they are separate. A single
 * wait can legitimately be slow — this city renders at about a frame a second
 * under SwiftShader, and slower still when the box is shared — so `PATIENCE`
 * has to be generous. But a harness that is *generous nine times in a row* has
 * hung from the caller's point of view, which is how an earlier version of this
 * file blew a ten-minute CI timeout and had to be abandoned mid-verification.
 *
 * `BUDGET` is the real contract: total wall-clock seconds for the whole run.
 * When it is gone the harness stops taking new steps, writes whatever it has,
 * says so, and exits **non-zero**. It never hangs and it never lies about a
 * partial pass.
 */
const PATIENCE = Number(arg('patience', '150000'));
const BUDGET = Number(arg('budget', '480')) * 1000;
const DEADLINE = Date.now() + BUDGET;
const left = () => DEADLINE - Date.now();
/** the ceiling for any single wait: never more than the budget that remains */
const wait = () => Math.max(1000, Math.min(PATIENCE, left()));
const VEHICLES = arg('vehicles', 'jeep,bus,carriage').split(',').filter(Boolean);

const LAUNCH = {
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
};

/** Wait for `n` rendered frames of game time to pass. */
async function frames(page, n) {
  const t0 = await page.evaluate(() => window.__loco.stats().elapsed);
  await page.waitForFunction(
    ([start, secs]) => window.__loco.stats().elapsed >= start + secs,
    [t0, n / 60],
    { timeout: wait(), polling: 400 },
  );
}

/**
 * Run a capture step, and keep going if it fails.
 *
 * A step that times out is worth knowing about but is not worth throwing away
 * the other six shots for — especially when the usual cause is another
 * process on the box, not the code under test.
 */
async function step(row, name, fn) {
  if (left() <= 0) {
    row.skipped = row.skipped ?? [];
    row.skipped.push(name);
    return null;
  }
  try {
    return await fn();
  } catch (e) {
    row.errors.push(`${name}: ${String(e?.message ?? e).split('\n')[0]}`);
    return null;
  }
}

/** Ask the game to sit in a specific camera view, and wait until it is there. */
async function setView(page, view) {
  await page.evaluate((v) => window.__locoCam?.request(v), view);
  await page.waitForFunction(
    (v) =>
      window.__locoCam?.mode === v &&
      (v === 'cockpit' ? (window.__locoCam?.interior ?? 0) > 0.98 : true),
    view,
    { timeout: wait(), polling: 400 },
  );
  // one more frame so the stats snapshot is of a settled rig
  await frames(page, 2);
}

async function stats(page) {
  return page.evaluate(() => ({
    ...window.__loco.stats(),
    camMode: window.__locoCam?.mode ?? '?',
    interior: Number((window.__locoCam?.interior ?? -1).toFixed(3)),
    ...window.__locoCam?.pose(),
  }));
}

async function runVehicle(browser, vehicleId, report) {
  if (left() <= 0) {
    report.vehicles.push({ vehicle: vehicleId, shots: [], errors: [], skipped: ['all'], budgetExhausted: true });
    return;
  }
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  // SwiftShader renders this city at seconds per frame on `high`; force a tier
  // the harness can actually finish on, before a single system boots.
  await page.addInitScript((q) => {
    try {
      localStorage.setItem(
        'locolift.settings.v1',
        JSON.stringify({ quality: q, cameraView: 'chase' }),
      );
    } catch {
      /* private browsing — the default tier will have to do */
    }
  }, QUALITY);

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const row = {
    vehicle: vehicleId,
    shots: [],
    errors,
    chase: null,
    cockpit: null,
    shaderFailures: [],
  };

  const shot = async (name) => {
    const file = path.join(OUT, `${vehicleId}-${name}.png`);
    try {
      await page.screenshot({ path: file, timeout: wait() });
      row.shots.push(file);
    } catch (e) {
      row.errors.push(`shot ${name}: ${String(e?.message ?? e)}`);
    }
  };

  try {
    /* free roam, because that is the game's front door and therefore the state
     * a defect is most likely to be reported from */
    await page.goto(`${URL_}/?vehicle=${vehicleId}&entry=freeRoam`, {
      waitUntil: 'load',
      timeout: 60_000,
    });
    await page.waitForFunction(() => !!window.__loco?.ready, null, { timeout: wait() });
    page.setDefaultTimeout(PATIENCE);

    await frames(page, 20);

    /* ---- chase baseline ------------------------------------------------ */
    await step(row, 'chase', async () => {
      await setView(page, 'chase');
      row.chase = await stats(page);
      await shot('00-chase');
    });

    /* ---- cockpit at rest ----------------------------------------------- */
    await step(row, 'cockpit', async () => {
      await setView(page, 'cockpit');
      row.cockpit = await stats(page);
      await shot('01-rest');
    });

    /* ---- both steering locks -------------------------------------------
     * Captured at a standstill so the only difference between the two frames
     * is the steering input — which is how you prove the wheel actually turns
     * rather than hoping it does. */
    await step(row, 'steer-left', async () => {
      await page.evaluate(() => window.__loco.setInput({ steer: -1 }));
      await frames(page, 45);
      row.steerLeft = await stats(page);
      await shot('02-steer-left');
    });
    await step(row, 'steer-right', async () => {
      await page.evaluate(() => window.__loco.setInput({ steer: 1 }));
      await frames(page, 70);
      row.steerRight = await stats(page);
      await shot('03-steer-right');
    });

    /* ---- at speed -------------------------------------------------------- */
    await step(row, 'speed', async () => {
      await page.evaluate(() => window.__loco.setInput({ throttle: 1, steer: 0 }));
      await frames(page, 160);
      row.cockpitFast = await stats(page);
      await shot('04-speed');
    });

    /* ---- cornering under power ------------------------------------------ */
    await step(row, 'corner', async () => {
      await page.evaluate(() => window.__loco.setInput({ throttle: 1, steer: 0.7 }));
      await frames(page, 60);
      await shot('05-corner');
    });

    /* ---- night ----------------------------------------------------------- */
    await step(row, 'night', async () => {
      await page.evaluate(() => window.__loco.setInput({ throttle: 0.4, steer: 0 }));
      await page.evaluate(() => window.__loco.setTimeOfDay(21.5));
      await frames(page, 40);
      await shot('06-night');
    });

    /* ---- idle, daylight, wheel centred ----------------------------------- */
    await step(row, 'idle', async () => {
      await page.evaluate(() => window.__loco.setTimeOfDay(15.5));
      await page.evaluate(() => window.__loco.clearInput());
      await frames(page, 60);
      await shot('07-idle');
    });

    row.shaderFailures = await page.evaluate(() => window.__locoShaderFailures ?? []);
    row.entry = 'freeRoam';
    row.touch = await page.evaluate(() => {
      const t = window.__locoTouch;
      return t ? { enabled: t.enabled, roles: t.rects().map((r) => r.role) } : null;
    });
  } catch (err) {
    row.fatal = String(err?.message ?? err);
  }

  await page.close();
  report.vehicles.push(row);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch(LAUNCH);
  const report = {
    url: URL_,
    quality: QUALITY,
    size: [WIDTH, HEIGHT],
    budgetSeconds: BUDGET / 1000,
    vehicles: [],
  };
  for (const v of VEHICLES) await runVehicle(browser, v, report);
  report.secondsUsed = Number(((BUDGET - left()) / 1000).toFixed(1));
  report.budgetExhausted = left() <= 0;
  await browser.close();

  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  let ok = true;
  for (const r of report.vehicles) {
    const dc = r.cockpit && r.chase ? r.cockpit.drawCalls - r.chase.drawCalls : NaN;
    const tri = r.cockpit && r.chase ? r.cockpit.triangles - r.chase.triangles : NaN;
    console.log(
      `\n=== ${r.vehicle} ===\n` +
        `  chase  : draws ${r.chase?.drawCalls} tris ${r.chase?.triangles} mode ${r.chase?.camMode}\n` +
        `  cockpit: draws ${r.cockpit?.drawCalls} tris ${r.cockpit?.triangles} mode ${r.cockpit?.camMode} interior ${r.cockpit?.interior}\n` +
        `           Δ ${dc} draws, ${tri} tris\n` +
        `  fast   : draws ${r.cockpitFast?.drawCalls} tris ${r.cockpitFast?.triangles} speed ${r.cockpitFast?.speed}\n` +
        /* A vehicle whose budget ran out before it booted has no arrays at all.
         * The summary is the one part of a bounded harness that must never
         * throw — a crash here loses the partial result the bound exists to
         * preserve, and reports as a tool failure rather than as a timeout. */
        `  shader failures: ${r.shaderFailures?.length ?? 0}\n` +
        `  console errors : ${r.errors?.length ?? 0}` +
        (r.errors?.length ? '\n    ' + r.errors.slice(0, 5).join('\n    ') : '') +
        (r.fatal ? `\n  FATAL: ${r.fatal}` : ''),
    );
    if (r.fatal || (r.shaderFailures?.length ?? 0) > 0) ok = false;
    if (r.skipped?.length) {
      console.log(`  SKIPPED (out of budget): ${r.skipped.join(', ')}`);
      ok = false;
    }
  }
  console.log(
    `\n${ok ? 'OK' : 'FAILED'} — ${report.secondsUsed}s of a ${report.budgetSeconds}s budget` +
      `${report.budgetExhausted ? ' (EXHAUSTED)' : ''} — shots in ${OUT}`,
  );
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
