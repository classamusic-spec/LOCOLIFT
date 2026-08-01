/**
 * Free-roam entry harness.
 *
 * Drives the real game headlessly through the loop the free-roam design
 * promises, and fails loudly if any step of it is not true:
 *
 *   boot ──► roaming, clock NOT running ──► pickup ──► clock armed
 *        ──► drop-off ──► roaming again, carry-over on the dial
 *
 * Every claim is *measured*: the roaming clock is sampled twice seconds apart
 * and asserted not to fall; the armed clock is sampled twice and asserted to
 * fall; the carry-over is read off the next fare's allowance. Screenshots are
 * taken at each step and checked for a non-black frame, and the shader guard's
 * failure list is read explicitly — a program that fails to link black-screens
 * the game and SwiftShader will not say a word about it.
 *
 *   node tools/freeroam-test.mjs [--url http://127.0.0.1:4181] [--out .captures-freeroam]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from './png-probe.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const URL_ = arg('url', 'http://127.0.0.1:4181');
const OUT = arg('out', '.captures-freeroam');
const WIDTH = Number(arg('width', '1280'));
const HEIGHT = Number(arg('height', '720'));
/**
 * SwiftShader renders this scene at about one frame a second, and the engine
 * clamps `dt` to 1/15 s — so game time runs at roughly 1/15 of wall time and
 * every wait below has to be sized in wall seconds, not game seconds. `low`
 * keeps that merely slow rather than unusable; pass `--quality high` to
 * exercise the full pipeline.
 */
const QUALITY = arg('quality', 'low');

/** Wall-clock budget for anything that has to wait on game time. */
const SLOW = 300_000;
/** Wall seconds that buy roughly half a second of game time. */
const SAMPLE_MS = 8000;

const failures = [];
const notes = [];

function check(ok, label, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(line);
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function note(label, value) {
  const line = `      ${label}: ${typeof value === 'object' ? JSON.stringify(value) : value}`;
  console.log(line);
  notes.push(line);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
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
  page.setDefaultTimeout(SLOW);
  await page.addInitScript((q) => {
    // Written before the first script runs, so `main.ts` skips its first-run
    // auto-detect and opens on exactly this tier.
    localStorage.setItem(
      'locolift.settings.v1',
      JSON.stringify({ quality: q, renderScale: q === 'low' ? 0.6 : 1, shadows: q !== 'low' }),
    );
  }, QUALITY);

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const shots = [];
  const shot = async (name) => {
    const file = path.join(OUT, `${name}.png`);
    const buf = await page.screenshot({ path: file, timeout: SLOW });
    const stats = PNG.brightness(buf);
    shots.push({ name, file, ...stats });
    check(
      stats.mean > 8 && stats.nonBlack > 0.25,
      `frame "${name}" is drawn`,
      `mean=${stats.mean.toFixed(1)} nonBlack=${(stats.nonBlack * 100).toFixed(1)}%`,
    );
    return file;
  };

  try {
    await page.goto(URL_, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => !!window.__loco?.ready, null, { timeout: SLOW });

    /* ---------------------------------------------------- 1. the front door */
    console.log('\n--- 1. boot lands in free roam ---');
    // The engine gates gameplay behind the HUD's 3·2·1. Wait it out.
    await page.waitForFunction(() => window.__loco.roam().live, null, { timeout: SLOW });
    const boot = await page.evaluate(() => window.__loco.roam());
    note('roam()', boot);
    check(boot.state === 'playing', 'opens in "playing", not the title screen', boot.state);
    check(boot.mode === 'freeRide', 'opening mode is freeRide', boot.mode);
    check(!boot.fareActive && !boot.hasPassenger, 'nobody is in the car yet');
    check(
      boot.hudLabel === 'SIN CARRERA',
      'the dial says SIN CARRERA, not TIEMPO',
      boot.hudLabel,
    );
    check(boot.hudDigits.trim() === '—', 'the dial shows no number', JSON.stringify(boot.hudDigits));
    check(boot.hudPrompt.length > 0, 'a prompt tells the player to find a fare', boot.hudPrompt);
    check(boot.hudFare === '0', 'the fare chip opens at $0, not last run’s total', boot.hudFare);
    // `FreeRide.start` turns discovery mode on: more people out, waiting much
    // longer, taller beacons, heard from further away. Without it "go and find
    // somebody" is a fight with a respawn timer.
    check(
      boot.waitingBudget >= 8,
      'discovery mode widened the street (more people waiting at once)',
      String(boot.waitingBudget),
    );
    check(
      boot.waitPatience > 3,
      'discovery mode made them wait far longer than the arcade default of 1×',
      `${boot.waitPatience}×`,
    );

    const shaderFailures = await page.evaluate(() => (window.__locoShaderFailures ?? []).slice());
    check(shaderFailures.length === 0, 'no shader programs failed to link', JSON.stringify(shaderFailures));

    await shot('01-freeroam');

    /* ------------------------------------ 2. the clock is genuinely stopped */
    console.log('\n--- 2. the clock is NOT running while roaming ---');
    const t0 = await page.evaluate(() => window.__loco.roam());
    await page.waitForTimeout(SAMPLE_MS);
    const t1 = await page.evaluate(() => window.__loco.roam());
    note('sample A', { hudClock: t0.hudClock, clock: t0.clock });
    note('sample B (+8s wall clock)', { hudClock: t1.hudClock, clock: t1.clock });
    check(t0.hudClock === 0, 'HUD dial reads 0 at boot', String(t0.hudClock));
    check(
      t1.hudClock >= t0.hudClock,
      'HUD dial did not fall while roaming',
      `${t0.hudClock} -> ${t1.hudClock}`,
    );
    check(
      t1.clock >= t0.clock,
      'free roam mirror did not fall while roaming',
      `${t0.clock} -> ${t1.clock}`,
    );

    /* ----------------------------------------------- 3. go and find somebody */
    console.log('\n--- 3. drive to a waiting fare ---');
    // People are spawned by the mission system once the run goes live, one
    // attempt every 1.4 *game* seconds — about 20 wall seconds out here.
    await page
      .waitForFunction(() => window.__loco.waitingFares().length > 0, null, { timeout: SLOW })
      .catch(() => {});
    const waiting = await page.evaluate(() => window.__loco.waitingFares());
    note('waiting fares on the street', waiting.length);
    check(waiting.length > 0, 'the street has people standing on it', JSON.stringify(waiting.slice(0, 3)));
    if (waiting.length === 0) throw new Error('no waiting fares to pick up');

    const target = waiting[0];
    note('nearest fare', target);

    // Park right next to them, stopped: `pickupSnapRadius` is 2.6 m and a full
    // stop inside it always works, whatever the speed.
    const picked = await page.evaluate(async (t) => {
      const y = window.__loco.groundY(t.x, t.z);
      window.__loco.teleport(t.x + 1.4, y + 0.6, t.z + 1.4, 0);
      return window.__loco.roam();
    }, target);
    note('after teleport', { hasPassenger: picked.hasPassenger });

    await page.waitForFunction(() => window.__loco.roam().hasPassenger, null, { timeout: SLOW });

    /* ------------------------------------------ 4. the pickup arms the clock */
    console.log('\n--- 4. the pickup arms the clock ---');
    const armed = await page.evaluate(() => window.__loco.roam());
    note('roam()', armed);
    note('destination', await page.evaluate(() => window.__loco.destination()));
    check(armed.hasPassenger, 'somebody is in the car');
    check(armed.fareActive, 'free roam reports the fare as active');
    check(armed.accepted >= 1, 'the fare was counted as accepted', String(armed.accepted));
    check(armed.rideAllowance > 0, 'the ride was given a deadline', `${armed.rideAllowance}s`);
    check(
      armed.hudClock > 5,
      'the HUD dial was slammed to the deadline',
      `${armed.hudClock}s (ride has ${armed.rideSecondsLeft}s)`,
    );
    check(
      Math.abs(armed.hudClock - armed.rideSecondsLeft) < 6,
      'the dial and the ride deadline are the same number',
      `hud=${armed.hudClock} ride=${armed.rideSecondsLeft}`,
    );
    check(armed.hudLabel === 'TIEMPO', 'the dial label went back to TIEMPO', armed.hudLabel);
    check(armed.hudPrompt === '', 'the roam prompt is gone while a fare is aboard');

    await shot('02-fare-aboard');

    const a0 = await page.evaluate(() => window.__loco.roam());
    await page.waitForTimeout(SAMPLE_MS);
    const a1 = await page.evaluate(() => window.__loco.roam());
    note('armed sample A', { hudClock: a0.hudClock, ride: a0.rideSecondsLeft });
    note('armed sample B (+8s)', { hudClock: a1.hudClock, ride: a1.rideSecondsLeft });
    check(
      a1.rideSecondsLeft < a0.rideSecondsLeft,
      'the ride clock IS counting down now',
      `${a0.rideSecondsLeft} -> ${a1.rideSecondsLeft}`,
    );
    check(
      a1.hudClock < a0.hudClock,
      'the HUD dial IS counting down now',
      `${a0.hudClock} -> ${a1.hudClock}`,
    );

    /* --------------------------------------------------- 5. make the delivery */
    console.log('\n--- 5. deliver, and return to roaming ---');
    const dest = await page.evaluate(() => window.__loco.destination());
    check(dest !== null, 'the fare has a destination', JSON.stringify(dest));
    const beforeDrop = await page.evaluate(() => window.__loco.roam());

    await page.evaluate((d) => {
      const y = window.__loco.groundY(d.x, d.z);
      window.__loco.teleport(d.x, y + 0.6, d.z, 0);
    }, dest);

    await page.waitForFunction(() => window.__loco.roam().completed > 0, null, { timeout: SLOW });
    // let the drop-off's `shift:timeAdded` land on the HUD
    await page.waitForTimeout(4000);

    const dropped = await page.evaluate(() => window.__loco.roam());
    note('roam()', dropped);
    check(dropped.completed >= 1, 'the fare was delivered', String(dropped.completed));
    check(!dropped.hasPassenger && !dropped.fareActive, 'the car is empty again');
    check(dropped.banked >= 1, 'free roam banked the fare', String(dropped.banked));
    check(dropped.state === 'playing', 'still playing — free roam has no results screen', dropped.state);
    check(dropped.mode === 'freeRide', 'still in free roam', dropped.mode);
    check(dropped.hudPrompt.length > 0, 'the "find a fare" prompt is back', dropped.hudPrompt);
    check(
      dropped.hudClock > 0,
      'the delivery bonus is sitting on the dial as carry-over',
      `${dropped.hudClock}s (was ${beforeDrop.hudClock}s mid-fare)`,
    );
    check(
      dropped.hudLabel === 'BONO',
      '…and it is labelled as carry-over, not as a countdown',
      dropped.hudLabel,
    );

    await shot('03-after-dropoff');

    /* ---------------------------------------------- 6. the carry-over is real */
    console.log('\n--- 6. unspent time carries into the next fare ---');
    const c0 = await page.evaluate(() => window.__loco.roam());
    await page.waitForTimeout(SAMPLE_MS);
    const c1 = await page.evaluate(() => window.__loco.roam());
    check(
      c1.hudClock < c0.hudClock,
      'the carry-over decays while you look for the next fare',
      `${c0.hudClock} -> ${c1.hudClock}`,
    );

    const next = await page.evaluate(() => window.__loco.waitingFares());
    check(next.length > 0, 'the street re-populated after the delivery', String(next.length));
    if (next.length > 0) {
      const carryBefore = (await page.evaluate(() => window.__loco.roam())).hudClock;
      await page.evaluate(async (t) => {
        const y = window.__loco.groundY(t.x, t.z);
        window.__loco.teleport(t.x + 1.4, y + 0.6, t.z + 1.4, 0);
      }, next[0]);
      await page.waitForFunction(() => window.__loco.roam().hasPassenger, null, { timeout: SLOW });
      const second = await page.evaluate(() => window.__loco.roam());
      note('carry at pickup', carryBefore);
      note('second fare', {
        allowance: second.rideAllowance,
        left: second.rideSecondsLeft,
        hud: second.hudClock,
      });
      check(second.accepted >= 2, 'the second fare was accepted', String(second.accepted));
      check(
        second.rideAllowance > carryBefore,
        'the second fare’s allowance includes the carry-over on top of its own par',
        `allowance=${second.rideAllowance} carry=${carryBefore}`,
      );
      check(
        Math.abs(second.hudClock - second.rideSecondsLeft) < 6,
        'the dial still equals the real deadline on the second fare',
        `hud=${second.hudClock} ride=${second.rideSecondsLeft}`,
      );
      await shot('04-second-fare');
    }

    /* ------------------------------------------- 7. the title is still reachable */
    console.log('\n--- 7. the title screen is not orphaned ---');
    await page.evaluate(() => window.__loco.pause());
    await page.waitForTimeout(3000);
    const paused = await page.evaluate(() => ({
      state: window.__loco.state(),
      quit: !!document.querySelector('.ll-pause button.ll-btn--danger'),
    }));
    check(paused.state === 'paused', 'pause works while roaming', paused.state);
    check(paused.quit, 'the pause menu offers SALIR AL TÍTULO');
    await shot('05-pause');

    await page.click('.ll-pause button.ll-btn--danger');
    await page.waitForTimeout(3000);
    const titled = await page.evaluate(() => ({
      state: window.__loco.state(),
      title: !!document.querySelector('.ll-title'),
      modes: Array.from(document.querySelectorAll('.ll-title__menu .ll-mi__es')).map(
        (n) => n.textContent,
      ),
    }));
    check(titled.state === 'title', 'quitting lands on the title screen', titled.state);
    check(titled.title, 'the title screen is mounted');
    check(
      titled.modes.includes('PASEO LIBRE') && titled.modes.includes('TURNO ARCADE'),
      'PASEO LIBRE and TURNO ARCADE are both on the menu',
      JSON.stringify(titled.modes),
    );
    await shot('06-title');

    /* the two buttons still do what they say */
    const menu = await page.$$('.ll-title__menu .ll-mi');
    const labels = titled.modes;
    const freeIdx = labels.indexOf('PASEO LIBRE');
    await menu[freeIdx].click();
    await page.waitForFunction(() => window.__loco.roam().live, null, { timeout: SLOW });
    const backFree = await page.evaluate(() => window.__loco.roam());
    check(
      backFree.state === 'playing' && backFree.mode === 'freeRide',
      'PASEO LIBRE starts free roam',
      `${backFree.state}/${backFree.mode}`,
    );
    check(backFree.hudLabel === 'SIN CARRERA', '…with an honest dial', backFree.hudLabel);
    await shot('07-title-freeride');

    await page.evaluate(() => window.__loco.showTitle());
    await page.waitForTimeout(3000);
    const menu2 = await page.$$('.ll-title__menu .ll-mi');
    await menu2[labels.indexOf('TURNO ARCADE')].click();
    await page.waitForFunction(() => window.__loco.roam().live, null, { timeout: SLOW });
    const arcade = await page.evaluate(() => window.__loco.roam());
    check(
      arcade.state === 'playing' && arcade.mode === 'arcade',
      'TURNO ARCADE starts a timed shift',
      `${arcade.state}/${arcade.mode}`,
    );
    check(arcade.hudClock > 30, 'the arcade shift opens with a real clock', `${arcade.hudClock}s`);
    check(arcade.hudLabel === 'TIEMPO', 'the arcade dial says TIEMPO', arcade.hudLabel);
    check(arcade.hudFare === '0', 'the arcade shift opens at $0', arcade.hudFare);
    check(
      arcade.waitingBudget < 8 && arcade.waitPatience === 1,
      'discovery mode was switched back off for the timed shift',
      `budget=${arcade.waitingBudget} patience=${arcade.waitPatience}×`,
    );
    const arc0 = arcade.hudClock;
    await page.waitForTimeout(SAMPLE_MS);
    const arc1 = await page.evaluate(() => window.__loco.roam());
    check(arc1.hudClock < arc0, 'the arcade clock counts down', `${arc0} -> ${arc1.hudClock}`);
    await shot('08-arcade');

    /* -------------------------------------------------------------- 8. errors */
    console.log('\n--- 8. console ---');
    const fatal = consoleErrors.filter((t) => !/favicon|Autoplay|AudioContext/i.test(t));
    check(fatal.length === 0, 'no console errors', JSON.stringify(fatal.slice(0, 5)));
    const finalShaders = await page.evaluate(() => (window.__locoShaderFailures ?? []).slice());
    check(finalShaders.length === 0, 'still no shader link failures', JSON.stringify(finalShaders));
  } catch (err) {
    check(false, 'harness ran to completion', String(err && err.stack ? err.stack : err));
    try {
      await shot('99-crash');
    } catch {
      /* ignore */
    }
  } finally {
    await writeFile(
      path.join(OUT, 'report.json'),
      JSON.stringify({ url: URL_, shots, failures, notes, consoleErrors }, null, 2),
    );
    await browser.close();
  }

  console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILED`}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
