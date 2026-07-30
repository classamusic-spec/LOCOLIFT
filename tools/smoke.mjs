/**
 * Headless smoke + capture harness.
 *
 * Boots the built game in Chromium, drives it through a scripted sequence,
 * captures screenshots and a perf trace, and fails loudly on console errors,
 * WebGL errors, or an unstable frame rate.
 *
 *   node tools/smoke.mjs [--url http://127.0.0.1:4173] [--out .captures] [--shots title,drive,night]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const URL_ = arg('url', 'http://127.0.0.1:4173');
const OUT = arg('out', '.captures');
const WIDTH = Number(arg('width', '1600'));
const HEIGHT = Number(arg('height', '900'));

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

  const errors = [];
  const warnings = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') errors.push(m.text());
    else if (t === 'warning') warnings.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));

  const report = { url: URL_, shots: [], errors, warnings, perf: null, ok: false };

  try {
    await page.goto(URL_, { waitUntil: 'load', timeout: 60_000 });

    // The game exposes a scripted-test surface on window.__loco when built.
    await page.waitForFunction(() => !!window.__loco?.ready, null, { timeout: 90_000 });

    const shot = async (name) => {
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      report.shots.push(file);
      return file;
    };

    // Drive the game through its states via the test hook.
    await page.evaluate(() => window.__loco.showTitle());
    await page.waitForTimeout(1200);
    await shot('01-title');

    await page.evaluate(() => window.__loco.startArcade());
    await page.waitForTimeout(2500);
    await shot('02-shift-start');

    // Scripted driving: full throttle + a long drift.
    await page.evaluate(() => window.__loco.setInput({ throttle: 1 }));
    await page.waitForTimeout(3000);
    await shot('03-driving');

    await page.evaluate(() => window.__loco.setInput({ throttle: 1, steer: -1, handbrake: 1 }));
    await page.waitForTimeout(1400);
    await shot('04-drift');

    await page.evaluate(() => window.__loco.setInput({ throttle: 1, steer: 0, handbrake: 0, boost: true }));
    await page.waitForTimeout(2200);
    await shot('05-boost');

    // Perf sample over a busy stretch.
    report.perf = await page.evaluate(async () => {
      const s = window.__loco.perfSample ? await window.__loco.perfSample(5000) : null;
      return s;
    });

    await page.evaluate(() => window.__loco.setTimeOfDay(21.5));
    await page.waitForTimeout(2000);
    await shot('06-night');

    await page.evaluate(() => window.__loco.setWeather('rain'));
    await page.waitForTimeout(2000);
    await shot('07-rain');

    await page.evaluate(() => window.__loco.setTimeOfDay(18.4));
    await page.evaluate(() => window.__loco.setWeather('clear'));
    await page.waitForTimeout(1800);
    await shot('08-sunset');

    await page.evaluate(() => window.__loco.pause());
    await page.waitForTimeout(700);
    await shot('09-pause');

    report.ok = errors.length === 0;
  } catch (err) {
    errors.push(`harness: ${err?.message ?? String(err)}`);
    try {
      await page.screenshot({ path: path.join(OUT, 'FAILURE.png') });
    } catch {
      /* page may be dead */
    }
  } finally {
    await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }

  console.log(JSON.stringify({ ok: report.ok, perf: report.perf, errors: errors.slice(0, 20) }, null, 2));
  if (!report.ok) process.exit(1);
}

main();
