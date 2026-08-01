/**
 * Harness for the three subsystems that were built but never constructed:
 * the chinchorreo (party bus), the progression ledger, and the relationship
 * ledger. Each was reachable only through a `GameDirector` option `main.ts`
 * never passed, so each was dead code at runtime.
 *
 * What this proves, by measurement:
 *   1. CHINCHORREO — the title entry starts the *party* controller, not the
 *      arcade shift it used to silently fall back to, and the crawl builds a
 *      real route with real stops that people actually board from.
 *   2. PROGRESSION — rep and cash move when a fare is delivered, and both
 *      survive a full page reload (they persist through `SaveSystem`).
 *   3. RELATIONSHIPS — a delivered ride is credited to that archetype's ledger
 *      and written to the save, which is what the story arcs stage off.
 *
 *   node tools/extras-test.mjs [--url http://127.0.0.1:4181] [--out .captures-extras]
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
const OUT = arg('out', '.captures-extras');
const QUALITY = arg('quality', 'low');
const SLOW = 300_000;

const failures = [];
const notes = [];

function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function note(label, value) {
  const line = `      ${label}: ${typeof value === 'object' ? JSON.stringify(value) : value}`;
  console.log(line);
  notes.push(line);
}

/** Park next to a point and wait for `ready` to become true. */
async function parkAt(page, x, z, ready, timeout = SLOW) {
  await page.evaluate(
    ([px, pz]) => {
      const y = window.__loco.groundY(px, pz);
      window.__loco.teleport(px + 1.4, y + 0.6, pz + 1.4, 0);
    },
    [x, z],
  );
  return page.waitForFunction(ready, null, { timeout }).then(
    () => true,
    () => false,
  );
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(SLOW);
  await page.addInitScript((q) => {
    localStorage.setItem(
      'locolift.settings.v1',
      JSON.stringify({ quality: q, renderScale: q === 'low' ? 0.6 : 1, shadows: q !== 'low' }),
    );
    // Start from a clean ledger so rep/ride deltas mean something — but only
    // once. This script runs on *every* navigation, and wiping the save on the
    // reload would delete the very thing the reload is meant to prove survived.
    if (!sessionStorage.getItem('locolift.harness.seeded')) {
      sessionStorage.setItem('locolift.harness.seeded', '1');
      localStorage.removeItem('locolift.save.v1');
    }
  }, QUALITY);

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const shots = [];
  const shot = async (name) => {
    const buf = await page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: SLOW });
    const s = PNG.brightness(buf);
    shots.push({ name, ...s });
    check(s.mean > 8 && s.nonBlack > 0.25, `frame "${name}" is drawn`, `mean=${s.mean.toFixed(1)}`);
  };

  try {
    /* =============================================== 2 + 3 first: free roam */
    await page.goto(URL_, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => !!window.__loco?.ready, null, { timeout: SLOW });
    await page.waitForFunction(() => window.__loco.roam().live, null, { timeout: SLOW });

    console.log('\n--- 2/3. progression + relationships are wired at all ---');
    const s0 = await page.evaluate(() => window.__loco.stats());
    note('stats at boot', {
      rep: s0.rep,
      rank: s0.rank,
      bank: s0.bank,
      arcStages: s0.arcStages,
      metPassengers: s0.metPassengers,
    });
    check(s0.rep >= 0, 'a Progression instance exists (rep is not the -1 sentinel)', String(s0.rep));
    check(s0.arcStages >= 0, 'a Relationships ledger exists (arcStages is not -1)', String(s0.arcStages));

    console.log('\n--- 2/3. deliver one fare and watch them move ---');
    await page
      .waitForFunction(() => window.__loco.waitingFares().length > 0, null, { timeout: SLOW })
      .catch(() => {});
    const fares = await page.evaluate(() => window.__loco.waitingFares());
    check(fares.length > 0, 'somebody is waiting', String(fares.length));
    if (fares.length === 0) throw new Error('nobody on the street');

    const gotIn = await parkAt(page, fares[0].x, fares[0].z, () => window.__loco.roam().hasPassenger);
    check(gotIn, 'a fare boarded');

    const dest = await page.evaluate(() => window.__loco.destination());
    note('destination', dest);
    const delivered = await parkAt(page, dest.x, dest.z, () => window.__loco.roam().completed > 0);
    check(delivered, 'the fare was delivered');
    await page.waitForTimeout(3000);

    const s1 = await page.evaluate(() => window.__loco.stats());
    note('stats after one fare', {
      rep: s1.rep,
      rank: s1.rank,
      bank: s1.bank,
      repThisShift: s1.repThisShift,
      metPassengers: s1.metPassengers,
    });
    check(s1.rep > s0.rep, 'rep accrued from the delivery', `${s0.rep} -> ${s1.rep}`);
    check(s1.repThisShift > 0, 'the shift ledger counted it', String(s1.repThisShift));
    check(s1.bank > s0.bank, 'cash was banked (free roam auto-banks)', `${s0.bank} -> ${s1.bank}`);
    check(
      s1.metPassengers > s0.metPassengers,
      'the relationship ledger recorded the ride',
      `${s0.metPassengers} -> ${s1.metPassengers}`,
    );

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('locolift.save.v1') ?? '{}'));
    const relKeys = Object.keys(saved.challengeBest ?? {}).filter((k) => k.startsWith('rel.'));
    note('save rel. keys', relKeys.map((k) => `${k}=${saved.challengeBest[k]}`));
    note('save rep.xp', saved.challengeBest?.['rep.xp']);
    check(relKeys.length > 0, 'the ride is written into the save under rel.*', JSON.stringify(relKeys));
    check(
      (saved.challengeBest?.['rep.xp'] ?? 0) > 0,
      'rep is written into the save under rep.xp',
      String(saved.challengeBest?.['rep.xp']),
    );
    await shot('01-after-fare');

    /* -------------------------------------------------- survive a reload */
    console.log('\n--- 2/3. …and survive a reload ---');
    await page.reload({ waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => !!window.__loco?.ready, null, { timeout: SLOW });
    const s2 = await page.evaluate(() => window.__loco.stats());
    note('stats after reload', { rep: s2.rep, rank: s2.rank, bank: s2.bank, metPassengers: s2.metPassengers });
    check(s2.rep === s1.rep, 'rep survived the reload', `${s1.rep} -> ${s2.rep}`);
    check(s2.bank === s1.bank, 'the bank survived the reload', `${s1.bank} -> ${s2.bank}`);
    check(
      s2.metPassengers === s1.metPassengers,
      'the relationship ledger survived the reload',
      `${s1.metPassengers} -> ${s2.metPassengers}`,
    );

    /* ============================================================ 1. party */
    console.log('\n--- 1. the chinchorreo starts, and is not the arcade fallback ---');
    await page.waitForFunction(() => window.__loco.roam().live, null, { timeout: SLOW });
    await page.evaluate(() => window.__loco.showTitle());
    await page.waitForTimeout(3000);
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.ll-title__menu .ll-mi__es')).map((n) => n.textContent),
    );
    note('title menu', labels);
    check(labels.includes('CHINCHORREO'), 'the title menu offers CHINCHORREO', JSON.stringify(labels));

    const items = await page.$$('.ll-title__menu .ll-mi');
    await items[labels.indexOf('CHINCHORREO')].click();
    await page.waitForFunction(() => window.__loco.state() === 'playing', null, { timeout: SLOW });
    await page.waitForFunction(() => window.__loco.party().running, null, { timeout: SLOW });

    const party = await page.evaluate(() => window.__loco.party());
    note('party()', party);
    check(party.wired, 'a PartyBusMode is wired into the director');
    check(
      party.isPartyRun,
      'the chinchorreo controller is the one running — NOT the arcade fallback',
    );
    check(party.stops > 0, 'the crawl built a real route', `${party.stops} stops`);
    check(party.phase === 'collect', 'it opened in the collect phase', party.phase);
    check(party.stop !== null, 'the first stop is targeted', JSON.stringify(party.stop));
    check(party.timeLeft > 30, 'the collect clock is running', `${party.timeLeft}s`);
    await shot('02-chinchorreo-start');

    if (party.stop) {
      console.log('\n--- 1. drive to the first stop and collect somebody ---');
      const boarded = await parkAt(
        page,
        party.stop.x,
        party.stop.z,
        () => window.__loco.party().aboard > 0,
        SLOW,
      );
      const after = await page.evaluate(() => window.__loco.party());
      note('party() at the first stop', after);
      check(boarded, 'people board the bus at a stop', `aboard=${after.aboard}`);
      check(after.collected > 0, 'the crawl counted them', String(after.collected));
      await shot('03-chinchorreo-aboard');
    }

    /* ============================================== 4. the ?entry= escape hatch */
    console.log('\n--- 4. ?entry=title still boots to the menu ---');
    await page.goto(`${URL_}/?entry=title`, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => !!window.__loco?.ready, null, { timeout: SLOW });
    await page.waitForTimeout(2000);
    const entryTitle = await page.evaluate(() => ({
      state: window.__loco.state(),
      title: !!document.querySelector('.ll-title'),
    }));
    note('?entry=title', entryTitle);
    check(entryTitle.state === 'title', '?entry=title opens on the menu', entryTitle.state);
    check(entryTitle.title, '…with the title screen mounted');

    console.log('\n--- console ---');
    const fatal = consoleErrors.filter((t) => !/favicon|Autoplay|AudioContext/i.test(t));
    check(fatal.length === 0, 'no console errors', JSON.stringify(fatal.slice(0, 5)));
    const sh = await page.evaluate(() => (window.__locoShaderFailures ?? []).slice());
    check(sh.length === 0, 'no shader link failures', JSON.stringify(sh));
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
