#!/usr/bin/env node
/**
 * Loco Lift — CPU performance audit.
 *
 * Answers "which system is spending the frame", per quality tier, using the
 * engine's per-system profiler (`window.__loco.profile`).
 *
 * ## What these numbers do and do not mean
 *
 * This container has no GPU: headless Chromium rasterises through SwiftShader.
 * So `renderMs` here is *software rasterisation* and says nothing about a real
 * machine's GPU time — discount it. What transfers cleanly is everything that
 * is pure JS/WASM and runs identically on any device:
 *
 *   - `fixed`  — physics and vehicle integration, run up to CONFIG.maxSubSteps
 *                times per frame. Reported as cost PER FRAME (already summed
 *                over the frame's sub-steps), which is the number that matters.
 *   - `update` — traffic, pedestrians, missions, scoring, audio.
 *   - `late`   — camera, HUD.
 *
 * `subStepsPerFrame` is the key diagnostic for choppiness: at 120Hz fixed with
 * 8 max sub-steps, a slow frame *demands more physics*, so per-frame CPU cost
 * rises as frame rate falls. A high value here means the fixed-step budget is
 * the problem, not the renderer.
 *
 * Usage: node tools/perf-audit.mjs [--url http://127.0.0.1:4173] [--ms 6000]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const URL_ = arg('url', 'http://127.0.0.1:4173');
const MS = Number(arg('ms', '6000'));
const OUT = arg('out', '.captures-perf');
const TIERS = arg('tiers', 'low,medium,high').split(',');

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

  const report = { url: URL_, sampleMs: MS, tiers: {} };

  for (const tier of TIERS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      // Quality is persisted, so stamp it before the app reads settings.
      await page.addInitScript((t) => {
        try {
          const k = 'locolift.settings.v1';
          const cur = JSON.parse(localStorage.getItem(k) ?? '{}');
          localStorage.setItem(k, JSON.stringify({ ...cur, quality: t }));
        } catch {
          /* private mode — the tier just stays default */
        }
      }, tier);

      await page.goto(`${URL_}/?entry=freeRoam`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__loco?.ready, null, { timeout: 300_000 });

      // Drive, so traffic/pedestrians/missions are doing real work rather than
      // idling at spawn. A parked car profiles nothing interesting.
      await page.evaluate(() => window.__loco.setInput({ throttle: 1 }));
      await page.waitForTimeout(3000);

      const prof = await page.evaluate((ms) => window.__loco.profile(ms), MS);
      const stats = await page.evaluate(() => window.__loco.stats());
      const fx = await page.evaluate(() => window.__locoFx?.stats?.() ?? null);
      const shaders = await page.evaluate(() => (window.__locoShaderFailures ?? []).length);
      await page.evaluate(() => window.__loco.clearInput());
      await page.screenshot({ path: path.join(OUT, `${tier}.png`) });

      report.tiers[tier] = { prof, stats, fx, shaders, errors };
      print(tier, prof, stats, fx);
    } catch (e) {
      report.tiers[tier] = { error: String(e?.message ?? e), errors };
      console.log(`\n${tier}: FAILED — ${e?.message ?? e}`);
    }
    await page.close();
  }

  await browser.close();
  await writeFile(path.join(OUT, 'perf.json'), JSON.stringify(report, null, 2));
  console.log(`\nwrote ${path.join(OUT, 'perf.json')}`);
}

function print(tier, p, s, fx) {
  console.log(`\n${'='.repeat(62)}\n${tier.toUpperCase()}  —  ${p.frames} frames sampled`);
  console.log(
    `draws ${s.drawCalls}  tris ${s.triangles.toLocaleString()}  ` +
      `programs ${s.programs}  post ${fx ? (fx.postEnabled ? 'on' : 'off') : '?'}`,
  );
  console.log(`sub-steps/frame ${p.subStepsPerFrame}   renderMs ${p.renderMs} (SwiftShader — ignore)`);
  const table = (label, rows) => {
    if (!rows.length) return;
    const total = rows.reduce((t, r) => t + r.ms, 0);
    console.log(`\n  ${label}  (total ${total.toFixed(2)} ms/frame)`);
    for (const r of rows.slice(0, 8)) {
      if (r.ms < 0.005) continue;
      console.log(`    ${r.name.padEnd(18)} ${r.ms.toFixed(3).padStart(9)} ms`);
    }
  };
  table('fixedUpdate (per frame, all sub-steps)', p.fixed);
  table('update', p.update);
  table('lateUpdate', p.late);
  console.log(`\n  CPU total (excl. render): ${(p.totalMs - p.renderMs).toFixed(2)} ms/frame`);
}

main();
