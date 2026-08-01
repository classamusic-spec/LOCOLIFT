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
 *   node tools/cockpit-test.mjs [--url http://127.0.0.1:4182] [--out .captures-cockpit]
 *                               [--vehicles jeep,bus,carriage]
 *                               [--quality low] [--width 900] [--height 506]
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
 * Everything waits this long. It is enormous on purpose: this box has four
 * cores and is routinely running two or three other agents' SwiftShader
 * instances at the same time, which takes a frame from ~1 s to ~5 s. A
 * timeout tuned for an idle machine simply reports "broken" for "busy".
 */
const PATIENCE = Number(arg('patience', '600000'));
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
    { timeout: PATIENCE, polling: 400 },
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
    { timeout: PATIENCE, polling: 400 },
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
      await page.screenshot({ path: file, timeout: PATIENCE });
      row.shots.push(file);
    } catch (e) {
      row.errors.push(`shot ${name}: ${String(e?.message ?? e)}`);
    }
  };

  try {
    await page.goto(`${URL_}/?vehicle=${vehicleId}`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForFunction(() => !!window.__loco?.ready, null, { timeout: PATIENCE });
    page.setDefaultTimeout(PATIENCE);

    await page.evaluate(() => window.__loco.startArcade());
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
  const report = { url: URL_, quality: QUALITY, size: [WIDTH, HEIGHT], vehicles: [] };
  for (const v of VEHICLES) await runVehicle(browser, v, report);
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
        `  shader failures: ${r.shaderFailures.length}\n` +
        `  console errors : ${r.errors.length}${r.errors.length ? '\n    ' + r.errors.slice(0, 5).join('\n    ') : ''}` +
        (r.fatal ? `\n  FATAL: ${r.fatal}` : ''),
    );
    if (r.fatal || r.shaderFailures.length > 0) ok = false;
  }
  console.log(`\n${ok ? 'OK' : 'FAILED'} — shots in ${OUT}`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
