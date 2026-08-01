/**
 * Loco Lift — geometry LOD census.
 *
 * Boots the real game headlessly, parks the Jeep at a fixed set of named
 * viewpoints, and at each one records:
 *
 *   - `perfSample` draw calls + triangles (what the renderer actually submits)
 *   - the per-layer, frustum-aware triangle census from `window.__locoCensus`
 *     (dev builds only — see `World.installCensusHook`)
 *   - a screenshot, so a triangle cut can be judged by eye and not only by the
 *     number it moved
 *
 * Repeats the whole sweep per quality tier. Asserts no shader link failure —
 * SwiftShader will happily rasterise a program a real driver rejects, so the
 * pixels are not evidence on their own.
 *
 *   node tools/lod-census.mjs --url http://127.0.0.1:4183 --out .lod/before \
 *        [--tiers high,ultra] [--views wide-fort,street-core]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const URL_ = arg('url', 'http://127.0.0.1:4183');
const OUT = arg('out', '.lod/census');
const WIDTH = Number(arg('width', '1600'));
const HEIGHT = Number(arg('height', '900'));
const TIERS = arg('tiers', 'low,medium,high,ultra').split(',');
const ONLY = arg('views', '').split(',').filter(Boolean);
const SHOTS = arg('shots', '1') !== '0';

/**
 * The viewpoints. `y` is metres above the ground the teleport lands on — the
 * respawn drops the Jeep, so an elevated view is held by parking it on a roof
 * or the fort rampart, which is exactly where a player ends up after a jump.
 * `heading` is radians of yaw.
 */
const VIEWS = [
  // Street level, deep in the colonial core: the common case.
  { id: 'street-core', x: -80, y: 32, z: -60, heading: 1.6 },
  // The elevated wide shot: high over the district looking back across it.
  // This is the frame that blows the budget — the whole city is in frustum.
  { id: 'wide-city', x: -120, y: 120, z: 150, heading: -2.5 },
  // From the fort, along the seaward wall — the postcard, and the second-worst
  // case: fort + district + coast + ocean all at once.
  { id: 'wide-fort', x: -366, y: 70, z: -168, heading: 1.2 },
  // The plaza.
  { id: 'plaza', x: -127, y: 33, z: -18, heading: 0.6 },
  // Beach / coast.
  { id: 'coast-beach', x: -252, y: 6, z: 298, heading: -1.4 },
  // The Piñones chinchorro strip, east along the coast.
  { id: 'pinones', x: 430, y: 8, z: 300, heading: 3.0 },
  // El Perlo on the seaward slope under the fort wall.
  { id: 'el-perlo', x: -300, y: 26, z: -215, heading: 2.2 },
  // El Torro — the wall road along the north rampart.
  { id: 'el-torro', x: -86, y: 21, z: -270, heading: 3.1 },
  // Waterfront looking back at the whole skyline from the sea side.
  { id: 'wide-sea', x: -35, y: 45, z: 330, heading: 3.14 },
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
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const views = ONLY.length ? VIEWS.filter((v) => ONLY.includes(v.id)) : VIEWS;
  const report = { url: URL_, rows: [], census: {}, errors: [], shaderFailures: [] };

  for (const tier of TIERS) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    page.on('console', (m) => {
      if (m.type() === 'error') report.errors.push(`[${tier}] ${m.text()}`);
    });
    page.on('pageerror', (e) => report.errors.push(`[${tier}] pageerror: ${e.message}`));

    // The world is built at the tier the store reports at boot, so the tier has
    // to be in place before the page script runs — a runtime switch only
    // re-skins what already exists.
    await page.addInitScript((t) => {
      const preset = {
        low: { renderScale: 0.7, shadows: false, postProcessing: false, bloom: false, motionBlur: false, ssao: false },
        medium: { renderScale: 0.85, shadows: true, postProcessing: true, bloom: true, motionBlur: false, ssao: false },
        high: { renderScale: 1, shadows: true, postProcessing: true, bloom: true, motionBlur: true, ssao: true },
        ultra: { renderScale: 1, shadows: true, postProcessing: true, bloom: true, motionBlur: true, ssao: true },
      }[t];
      localStorage.setItem('locolift.settings.v1', JSON.stringify({ quality: t, ...preset }));
    }, tier);

    await page.goto(URL_, { waitUntil: 'load', timeout: 180_000 });
    await page.waitForFunction(() => !!window.__loco?.ready, null, { timeout: 300_000 });
    page.setDefaultTimeout(300_000);

    await page.evaluate(() => window.__loco.startArcade());
    // SwiftShader takes seconds per frame; give the first frames room to land.
    await page.waitForTimeout(6000);

    const stats = await page.evaluate(() => ({
      ...window.__loco.stats(),
      ...(window.__locoWorldStats?.() ?? {}),
    }));
    report.census[`${tier}/static`] = stats;

    for (const v of views) {
      await page.evaluate(
        ([x, y, z, h]) => {
          window.__loco.teleport(x, y, z, h);
          // hold the Jeep still so the camera settles and nothing streams in
          window.__loco.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: 1 });
        },
        [v.x, v.y, v.z, v.heading],
      );
      /* A frame takes seconds under SwiftShader, so `perfSample(ms)` routinely
       * captures zero frames and reports zeroes. `stats()` reads
       * `renderer.info` directly — the same counters, with no dependency on how
       * many frames elapsed. Wait long enough for two or three frames so the
       * per-layer LOD passes have run against the new camera before reading. */
      /* Park it first. `respawn` leaves the Jeep with whatever momentum the
       * last viewpoint gave it, and a chase camera still swinging through a
       * turn is a different frustum from a parked one — enough to move the
       * triangle count by 30 % between two runs of the same viewpoint. */
      await page.waitForTimeout(6000);
      await page
        .waitForFunction(() => (window.__loco.stats().speed ?? 9) < 0.25, null, {
          timeout: 240_000,
        })
        .catch(() => {});
      await page.waitForTimeout(9000);
      /* A frame can take four seconds under SwiftShader, and `renderer.info`
       * holds the *previous* frame's counters until the next one lands — read
       * too early and one viewpoint reports its neighbour's numbers. Wait for
       * the engine clock to move on by several frames before trusting it. */
      const t0 = (await page.evaluate(() => window.__loco.stats())).elapsed;
      await page
        .waitForFunction((t) => (window.__loco.stats().elapsed ?? 0) > t + 0.28, t0, {
          timeout: 120_000,
        })
        .catch(() => {});
      const s = await page.evaluate(() => window.__loco.stats());
      const perf = {
        drawCalls: s.drawCalls,
        triangles: s.triangles,
        programs: s.programs,
        frameMs: 0,
      };
      const census = await page.evaluate(() => window.__locoCensus?.() ?? []);
      report.rows.push({ tier, view: v.id, ...perf });
      report.census[`${tier}/${v.id}`] = census;
      if (SHOTS) {
        try {
          await page.screenshot({
            path: path.join(OUT, `${tier}-${v.id}.png`),
            timeout: 300_000,
          });
        } catch (err) {
          // A wide viewpoint can take minutes per frame on SwiftShader; a
          // missing screenshot must not cost the whole measurement run.
          report.errors.push(`[${tier}/${v.id}] screenshot: ${err?.message ?? err}`);
        }
      }
      process.stdout.write(
        `${tier.padEnd(7)} ${v.id.padEnd(13)} calls=${String(perf.drawCalls).padStart(5)} tris=${String(perf.triangles).padStart(9)}\n`,
      );
    }

    const fails = await page.evaluate(
      () => (window.__locoShaderFailures ?? []).map((f) => `${f.name} (${f.stage}): ${f.log}`),
    );
    for (const f of fails) report.shaderFailures.push(`[${tier}] ${f}`);
    await page.close();
  }

  await browser.close();
  await writeFile(path.join(OUT, 'census.json'), JSON.stringify(report, null, 1));

  /* ---- the table ---- */
  const BUDGET_TRIS = 1_600_000;
  const BUDGET_CALLS = 900;
  console.log('\n| tier | view | draw calls | triangles | over |');
  console.log('|---|---|---:|---:|---|');
  for (const r of report.rows) {
    const over = r.triangles > BUDGET_TRIS || r.drawCalls > BUDGET_CALLS ? 'OVER' : '';
    console.log(
      `| ${r.tier} | ${r.view} | ${r.drawCalls} | ${r.triangles.toLocaleString()} | ${over} |`,
    );
  }
  const worst = report.rows.reduce((a, b) => (b.triangles > a.triangles ? b : a), report.rows[0]);
  console.log(`\nworst: ${worst.tier}/${worst.view} = ${worst.triangles.toLocaleString()} tris, ${worst.drawCalls} calls`);
  console.log(`shaderFailures: ${report.shaderFailures.length}`);
  for (const f of report.shaderFailures) console.log('  ', f);
  if (report.errors.length) {
    console.log(`console errors: ${report.errors.length}`);
    for (const e of report.errors.slice(0, 10)) console.log('  ', e);
  }
  if (report.shaderFailures.length > 0) process.exit(1);
}

main();
