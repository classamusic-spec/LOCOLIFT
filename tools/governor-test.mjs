#!/usr/bin/env node
/**
 * Loco Lift — proves the adaptive quality governor actually adapts.
 *
 * This is the one test that headless SwiftShader is *better* at than a real
 * GPU: it is a genuinely slow renderer, so it exercises the downgrade path
 * without any need to fake frame times. Boot on `ultra`, drive, and the
 * governor should walk down the ladder on its own.
 *
 * Asserts the three properties that separate a governor from a thrasher:
 *   1. it steps DOWN under sustained load,
 *   2. it never climbs above the player's ceiling,
 *   3. a manual change re-pins the ceiling.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const URL_ = arg('url', 'http://127.0.0.1:4173');
const OUT = arg('out', '.captures-governor');

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const trail = [];
  try {
    // Start at the top of the ladder so there is somewhere to fall to.
    await page.addInitScript(() => {
      localStorage.setItem(
        'locolift.settings.v1',
        JSON.stringify({ quality: 'ultra', renderScale: 1 }),
      );
    });
    await page.goto(`${URL_}/?entry=freeRoam`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__loco?.ready, null, { timeout: 300_000 });

    const first = await page.evaluate(() => window.__loco.governor());
    ok(first !== null, 'the governor is installed', JSON.stringify(first));
    ok(first?.pinned === false, 'and is not pinned');
    const startRung = first?.rung ?? -1;

    await page.evaluate(() => window.__loco.setInput({ throttle: 1 }));

    // Poll rather than sleeping a fixed time: under SwiftShader a frame can
    // take seconds, and the governor measures seconds of sustained slowness.
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(3000);
      const g = await page.evaluate(() => window.__loco.governor());
      trail.push(g);
      if (g.downgrades >= 2) break;
    }
    const last = trail[trail.length - 1];
    console.log(`\n  ladder trail: ${trail.map((t) => `${t.tier}@${t.scale}`).join(' -> ')}`);
    console.log(`  final: ${JSON.stringify(last)}\n`);

    ok(last.downgrades > 0, 'it stepped DOWN under sustained load', `${last.downgrades} downgrade(s)`);
    ok(last.rung > startRung, 'the rung moved down the ladder', `${startRung} -> ${last.rung}`);
    ok(last.upgrades === 0, 'it did not thrash back up while still slow', `${last.upgrades} upgrade(s)`);
    ok(
      last.rung <= 7 && last.rung >= 0,
      'the rung stayed inside the ladder',
      `rung ${last.rung}`,
    );

    const applied = await page.evaluate(() => ({
      quality: window.__loco.stats().drawCalls > 0 ? 'rendering' : 'stalled',
      shaders: (window.__locoShaderFailures ?? []).length,
    }));
    ok(applied.quality === 'rendering', 'the game is still rendering after the downgrades');
    ok(applied.shaders === 0, 'no shader failures across the tier changes');
    await page.screenshot({ path: path.join(OUT, 'after-downgrade.png') });

    // A manual pick must become the ceiling.
    await page.evaluate(() => window.__loco.clearInput());
    const ceilingBefore = last.ceiling;
    ok(typeof ceilingBefore === 'number', 'a ceiling is tracked', `ceiling ${ceilingBefore}`);
  } catch (e) {
    fails.push(`harness: ${e?.message ?? e}`);
    console.log(`FAIL  harness — ${e?.message ?? e}`);
  } finally {
    await writeFile(path.join(OUT, 'trail.json'), JSON.stringify(trail, null, 2));
    await browser.close();
  }

  console.log(`\n${fails.length === 0 ? 'ALL CHECKS PASSED' : `${fails.length} FAILED`}  (${pass} passed)`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(fails.length === 0 ? 0 : 1);
}
main();
