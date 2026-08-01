/**
 * Fast geometry captures from `tools/cockpit-preview.html`.
 *
 * One vehicle, no city — a frame costs milliseconds instead of seconds, which
 * is the difference between iterating on a dashboard and guessing at one.
 *
 *   node tools/cockpit-shots.mjs --out .captures-cockpit-geo
 *                                [--vehicles jeep,bus,carriage]
 *                                [--width 1280] [--height 720]
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const URL_ = arg('url', 'http://127.0.0.1:4182');
const OUT = arg('out', '.captures-cockpit-geo');
const W = Number(arg('width', '1280'));
const H = Number(arg('height', '720'));
const VEHICLES = arg('vehicles', 'jeep,bus,carriage').split(',').filter(Boolean);

/** The angles worth looking at, per vehicle. */
const VIEWS = [
  { id: 'a-forward', p: 'steer=0' },
  { id: 'b-steer-left', p: 'steer=-0.6' },
  { id: 'c-steer-right', p: 'steer=0.6' },
  { id: 'd-down', p: 'steer=0.2&pitch=-22' },
  { id: 'e-left', p: 'steer=0&yaw=42' },
  { id: 'f-right', p: 'steer=0&yaw=-42' },
  { id: 'g-back', p: 'steer=0&yaw=155&pitch=-6' },
  { id: 'h-night', p: 'steer=0&night=1' },
  { id: 'i-external', p: 'ext=1' },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  for (const v of VEHICLES) {
    for (const view of VIEWS) {
      const url = `${URL_}/tools/cockpit-preview.html?v=${v}&${view.p}`;
      await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
      await page.waitForFunction(() => !!window.__preview, null, { timeout: 90_000 });
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(OUT, `${v}-${view.id}.png`), timeout: 90_000 });
    }
    const info = await page.evaluate(() => {
      const r = window.__preview.renderer.info.render;
      return { calls: r.calls, triangles: r.triangles };
    });
    console.log(`${v}: ${info.calls} draws, ${info.triangles} tris (model + stand-in street)`);
  }

  await browser.close();
  if (errors.length) {
    console.log('errors:\n  ' + errors.slice(0, 10).join('\n  '));
    process.exitCode = 1;
  } else {
    console.log(`OK — shots in ${OUT}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
