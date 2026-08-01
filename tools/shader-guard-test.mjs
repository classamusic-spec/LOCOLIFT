#!/usr/bin/env node
/**
 * Loco Lift — proves the shader link-failure fallback.
 *
 * Boots the game, confirms the frame is drawing, then deliberately corrupts
 * the grade pass's fragment shader at runtime and forces a recompile. The
 * assertion is that the game keeps rendering: `ShaderGuard` records the
 * failure, `RenderPipeline` drops the whole chain and forward-renders, and the
 * viewport still shows the district instead of the black screen a dead
 * mid-chain pass used to produce.
 *
 * Brightness is measured on the canvas pixels only — the HUD is DOM and draws
 * over the top regardless, which is exactly how the original bug hid.
 *
 *   node tools/shader-guard-test.mjs
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const URL_ = process.env.LOCO_URL ?? 'http://localhost:4173/';
const OUT = '.captures-shaderguard';

/**
 * Mean luma of a screenshot, 0..1. A dead render chain reads ~0.00.
 *
 * Measured from the *composited* screenshot, never by `drawImage`-ing the
 * WebGL canvas: with `preserveDrawingBuffer: false` the drawing buffer is
 * cleared at composite time, so reading it back outside the render loop
 * returns pure black for a perfectly healthy frame. That false negative would
 * make this test claim the fallback had failed every single run.
 *
 * The screenshot is sent back into the page and decoded through a 2D canvas,
 * which keeps this dependency-free — there is no PNG decoder in the tree.
 */
async function screenshotLuma(page, buffer) {
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  return page.evaluate(
    (url) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = 160;
          c.height = Math.max(1, Math.round((160 * img.height) / img.width));
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, c.width, c.height);
          const { data } = ctx.getImageData(0, 0, c.width, c.height);
          let sum = 0;
          for (let i = 0; i < data.length; i += 4) {
            sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          }
          resolve(sum / (data.length / 4));
        };
        img.onerror = () => reject(new Error('decode failed'));
        img.src = url;
      }),
    dataUrl,
  );
}

/**
 * Hide every DOM subtree that is not an ancestor of the canvas, so a
 * screenshot contains viewport pixels and nothing else.
 *
 * This is the whole point of the test. The HUD and touch controls are DOM and
 * draw *over* the canvas — that is precisely why the original black screen
 * looked like a normal frame in every capture. Measuring luma without hiding
 * them would reproduce the same blindness the guard exists to end.
 */
const hideOverlays = () => {
  const keep = new Set();
  for (let n = document.getElementById('gl'); n; n = n.parentElement) keep.add(n);
  const hidden = [];
  for (const el of document.querySelectorAll('body *')) {
    if (keep.has(el) || !keep.has(el.parentElement)) continue;
    hidden.push([el, el.style.visibility]);
    el.style.visibility = 'hidden';
  }
  window.__locoHidden = hidden;
  return hidden.length;
};

const restoreOverlays = () => {
  for (const [el, v] of window.__locoHidden ?? []) el.style.visibility = v;
  delete window.__locoHidden;
};

/** Corrupt the grade pass so its program cannot link, then force a recompile. */
const breakGradePass = () => {
  const fx = window.__locoFx;
  const pass = fx.composer.passes.find((p) => p.material?.name === 'LocoGrade');
  if (!pass) return 'no grade pass';
  // A call to a function that does not exist: same failure mode as the real
  // incident (a valid-looking call the driver refuses), without depending on
  // any one driver's tolerance for builtin shadowing.
  pass.material.fragmentShader = pass.material.fragmentShader.replace(
    'void main() {',
    'void main() {\n  gl_FragColor = locoThisFunctionDoesNotExist( vUv );\n',
  );
  pass.material.needsUpdate = true;
  return 'ok';
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
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const result = { steps: {}, problems: [], ok: false };
  try {
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__loco?.ready, null, { timeout: 180_000 });
    await page.evaluate(() => window.__loco.startArcade());
    await page.waitForTimeout(2500);

    const viewportShot = async (name) => {
      const n = await page.evaluate(hideOverlays);
      await page.waitForTimeout(400);
      const buf = await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      await page.evaluate(restoreOverlays);
      if (n === 0) result.problems.push('hid no overlays — luma may include HUD pixels');
      return screenshotLuma(page, buf);
    };

    result.steps.before = {
      luma: await viewportShot('1-healthy'),
      postEnabled: await page.evaluate(() => window.__locoFx.stats().postEnabled),
      failures: await page.evaluate(() => (window.__locoShaderFailures ?? []).length),
    };

    if (result.steps.before.postEnabled !== 1) {
      result.problems.push('post was not enabled to begin with — test proves nothing');
    }
    if (result.steps.before.luma < 0.02) {
      result.problems.push(`baseline frame is already black (luma ${result.steps.before.luma})`);
    }

    const broke = await page.evaluate(breakGradePass);
    if (broke !== 'ok') result.problems.push(`could not corrupt grade pass: ${broke}`);
    await page.waitForTimeout(2500);

    result.steps.after = {
      luma: await viewportShot('2-after-break'),
      postEnabled: await page.evaluate(() => window.__locoFx.stats().postEnabled),
      shaderBroken: await page.evaluate(() => window.__locoFx.stats().shaderBroken),
      failedShader: await page.evaluate(() => window.__locoFx.failedShader),
      failures: await page.evaluate(() =>
        (window.__locoShaderFailures ?? []).map((f) => `${f.name} (${f.stage})`),
      ),
    };

    const a = result.steps.after;
    if (a.failures.length === 0) result.problems.push('ShaderGuard recorded no failure');
    if (a.shaderBroken !== 1) result.problems.push('pipeline did not latch the failure');
    if (a.postEnabled !== 0) result.problems.push('pipeline did not disable post');
    if (a.luma < 0.02) {
      result.problems.push(`FALLBACK FAILED — viewport is black (luma ${a.luma})`);
    }

    result.ok = result.problems.length === 0;
  } catch (err) {
    result.problems.push(`harness: ${err?.message ?? String(err)}`);
  } finally {
    await writeFile(path.join(OUT, 'report.json'), JSON.stringify(result, null, 2));
    await browser.close();
  }

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main();
