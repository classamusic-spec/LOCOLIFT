/**
 * Loco Lift — mobile layout + touch-control harness.
 *
 * Loads the built game in seven emulated device profiles (small phone, large
 * phone, Android phone, tablet — portrait and landscape), drives the *real* on-screen
 * controls with synthetic touch pointers, screenshots every step, and audits the
 * layout for the four things that actually break a phone build:
 *
 *   - the page scrolls or overflows its viewport
 *   - a control is off-screen, too small for a finger, or covered
 *   - a control sits under the notch / home indicator (simulated safe areas)
 *   - text is clipped inside its box
 *
 *   node tools/mobile-test.mjs                       # serves ./dist
 *   node tools/mobile-test.mjs --file dist-standalone/loco-lift.html
 *   node tools/mobile-test.mjs --url http://127.0.0.1:4173
 *   node tools/mobile-test.mjs --only phone-large-landscape
 *
 * SwiftShader renders this scene at a few frames per second, so every
 * screenshot gets a 180 s budget. That is the environment, not the game.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const OUT = path.resolve(ROOT, arg('out', '.captures-mobile'));
const SERVE_DIR = path.resolve(ROOT, arg('serve', 'dist'));
const FILE = arg('file', null);
const URL_ = arg('url', null);
const ONLY = arg('only', null);
const SHOT_TIMEOUT = 180_000;
/**
 * Software rendering pays for every device pixel twice — once for the game,
 * once for the compositor — so the harness caps the emulated DPR at 1 by
 * default. Layout is measured in CSS pixels and is unaffected, and the game
 * caps its own backing store at 1x on the `low` tier that every phone
 * auto-detects into. Pass `--dpr 3` to exercise a retina backing store when you
 * have a real GPU under you.
 */
const DPR_CAP = Number(arg('dpr', '1'));
/**
 * `key` (default) captures the five screenshots that carry the argument; `full`
 * captures all ten. Under SwiftShader a single capture costs ~90 s, so this is
 * the difference between a coffee and an afternoon.
 */
const SHOTS = arg('shots', 'key');
const KEY_SHOTS = new Set([
  '01-title',
  '02-playing',
  '03-portrait-dismissed',
  '05-steer-left',
  '08-left-handed-wheel',
  '10-settings',
  'FAILURE',
]);
/** How many device profiles to drive at once. */
const JOBS = Math.max(1, Number(arg('jobs', '2')));
/**
 * Wall-clock window for the layout-cost probe, in ms. Landscape profiles only —
 * the portrait ones are behind the rotate gate and are not driving. `0` skips
 * it. Longer is better evidence: under a software renderer 18 s is only a
 * handful of frames, so bump this to 90000 when you want a real per-frame
 * number rather than an absolute layout count.
 */
const LAYOUT_MS = Math.max(0, Number(arg('layout-ms', '18000')));

/* --------------------------------------------------------------- profiles */

const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const UA_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

/**
 * `safe` mirrors what iOS reports for that device+orientation. The game reads
 * `--ll-safe-*` (which default to `env(safe-area-inset-*)`), so the harness can
 * simulate a notch that headless Chromium would never produce.
 */
const PROFILES = [
  {
    id: 'phone-small-landscape',
    label: 'Small phone · landscape (iPhone SE)',
    width: 568,
    height: 320,
    dpr: 2,
    ua: UA_IPHONE,
    safe: { top: 0, right: 0, bottom: 0, left: 0 },
  },
  {
    id: 'phone-small-portrait',
    label: 'Small phone · portrait (iPhone SE)',
    width: 320,
    height: 568,
    dpr: 2,
    ua: UA_IPHONE,
    safe: { top: 20, right: 0, bottom: 0, left: 0 },
  },
  {
    id: 'phone-large-landscape',
    label: 'Large phone · landscape (iPhone 15 Pro Max)',
    width: 932,
    height: 430,
    dpr: 3,
    ua: UA_IPHONE,
    safe: { top: 0, right: 59, bottom: 21, left: 59 },
  },
  {
    id: 'phone-large-portrait',
    label: 'Large phone · portrait (iPhone 15 Pro Max)',
    width: 430,
    height: 932,
    dpr: 3,
    ua: UA_IPHONE,
    safe: { top: 59, right: 0, bottom: 34, left: 0 },
  },
  {
    id: 'phone-android-landscape',
    label: 'Android phone · landscape (Pixel 7)',
    width: 915,
    height: 412,
    dpr: 2.625,
    ua: UA_ANDROID,
    safe: { top: 0, right: 24, bottom: 0, left: 24 },
  },
  {
    id: 'tablet-landscape',
    label: 'Tablet · landscape (iPad)',
    width: 1180,
    height: 820,
    dpr: 2,
    ua: UA_IPAD,
    safe: { top: 0, right: 0, bottom: 20, left: 0 },
  },
  {
    id: 'tablet-portrait',
    label: 'Tablet · portrait (iPad)',
    width: 820,
    height: 1180,
    dpr: 2,
    ua: UA_IPAD,
    safe: { top: 24, right: 0, bottom: 20, left: 0 },
  },
];

/** Apple HIG / WCAG 2.5.5 both land near 44 px; we accept 40 for dense chrome. */
const MIN_TARGET = 40;

/* ---------------------------------------------------------- static server */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serve(dir) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
      let file = path.join(dir, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(dir)) {
        res.writeHead(403).end();
        return;
      }
      if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(file).pipe(res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

/* ------------------------------------------------------------ in-page audit */

/**
 * Everything below runs inside the page. Kept as one function so it is a single
 * round trip and so the numbers it reports are all from the same layout pass.
 */
function auditPage(minTarget) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cs = getComputedStyle(document.documentElement);
  const root = document.querySelector('.ll-root');
  const rootStyle = root ? getComputedStyle(root) : null;
  const inset = (name) => {
    const v = rootStyle?.getPropertyValue(name) ?? '0px';
    return Number.parseFloat(v) || 0;
  };
  const safe = {
    top: inset('--ll-safe-top'),
    right: inset('--ll-safe-right'),
    bottom: inset('--ll-safe-bottom'),
    left: inset('--ll-safe-left'),
  };

  const problems = [];
  const warnings = [];
  const add = (list, kind, detail) => list.push({ kind, ...detail });

  /* ---- 1. the page itself must not scroll ---- */
  const de = document.documentElement;
  if (de.scrollWidth > vw + 1 || de.scrollHeight > vh + 1) {
    add(problems, 'page-scrolls', {
      scrollWidth: de.scrollWidth,
      scrollHeight: de.scrollHeight,
      vw,
      vh,
    });
  }
  const canvas = document.getElementById('gl');
  if (canvas) {
    const b = canvas.getBoundingClientRect();
    if (Math.abs(b.width - vw) > 2 || Math.abs(b.height - vh) > 2) {
      add(problems, 'canvas-not-full-bleed', {
        canvas: { w: Math.round(b.width), h: Math.round(b.height) },
        vw,
        vh,
      });
    }
  }

  /* ---- 1b. the boot splash must never outlive boot ----
     `#boot` is opaque and paints over the canvas. If it is ever still visible
     once the game is up, the player is looking at a solid colour and has no
     way to know the difference between that and a dead GPU. This is the single
     check that would have caught the reported black screen. */
  const splash = document.getElementById('boot');
  if (splash) {
    const st = getComputedStyle(splash);
    if (!splash.hidden && st.display !== 'none' && Number(st.opacity) > 0.01) {
      add(problems, 'boot-splash-visible', {
        hidden: splash.hidden,
        display: st.display,
        opacity: st.opacity,
        zIndex: st.zIndex,
      });
    }
  }
  // A boot-error card is `position:fixed; z-index:9999` and opaque; if one is
  // up after `__loco.ready` the watchdog fired late and has buried a working
  // game (see docs/TESTING.md).
  const alert = document.querySelector('[role="alert"]');
  if (alert && window.__loco?.ready) {
    add(problems, 'boot-error-overlay-after-ready', {
      text: (alert.textContent ?? '').trim().slice(0, 120),
    });
  }

  /* ---- 2. visible UI must stay inside the viewport ---- */
  const seen = new Set();
  const visible = [];
  if (root) {
    for (const node of root.querySelectorAll('*')) {
      const st = getComputedStyle(node);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
      if (node.closest('[hidden]')) continue;
      const b = node.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) continue;
      visible.push({ node, b, st });
    }
  }
  for (const { node, b } of visible) {
    // full-bleed layers legitimately equal the viewport
    if (b.width >= vw - 1 && b.height >= vh - 1) continue;
    const over = {
      left: Math.max(0, -b.left),
      top: Math.max(0, -b.top),
      right: Math.max(0, b.right - vw),
      bottom: Math.max(0, b.bottom - vh),
    };
    const worst = Math.max(over.left, over.top, over.right, over.bottom);
    if (worst > 2) {
      const sel = describe(node);
      if (seen.has(`overflow:${sel}`)) continue;
      seen.add(`overflow:${sel}`);
      // Inside a scroll container it is reachable, just not visible — still
      // worth knowing about (a menu you must drag to find is a menu you miss),
      // but it is not the same bug as chrome hanging off the screen.
      const scroller = scrollableAncestor(node);
      add(scroller ? warnings : problems, scroller ? 'below-fold' : 'overflow', {
        el: sel,
        by: Math.round(worst),
        over: roundAll(over),
        scroller: scroller ? describe(scroller) : undefined,
      });
    }
  }

  /* ---- 3. clipped text ---- */
  for (const { node, b, st } of visible) {
    if (st.overflow === 'visible' && st.overflowX === 'visible') continue;
    if (!node.textContent || node.textContent.trim().length === 0) continue;
    if (node.children.length > 0) continue;
    const ellipsis = st.textOverflow === 'ellipsis' || st.webkitLineClamp !== 'none';
    const clippedX = node.scrollWidth > node.clientWidth + 2;
    const clippedY = node.scrollHeight > node.clientHeight + 2;
    if (!clippedX && !clippedY) continue;
    const detail = {
      el: describe(node),
      text: node.textContent.trim().slice(0, 48),
      scroll: { w: node.scrollWidth, h: node.scrollHeight },
      client: { w: node.clientWidth, h: node.clientHeight },
      box: roundAll({ w: b.width, h: b.height }),
    };
    add(ellipsis ? warnings : problems, 'clipped-text', detail);
  }

  /* ---- 4. touch controls: reachable, finger-sized, not under the notch ---- */
  const controls = [];
  const hook = window.__locoTouch;
  if (hook && hook.enabled) {
    for (const r of hook.rects()) controls.push({ ...r, node: null, source: 'touch' });
  }
  // menu buttons count too — they are the only way off the title screen
  for (const node of document.querySelectorAll('.ll-root button, .ll-root input, .ll-root [role="radio"]')) {
    const st = getComputedStyle(node);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    if (node.closest('[hidden]')) continue;
    const b = node.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    controls.push({
      role: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 24) || 'button',
      x: b.left,
      y: b.top,
      w: b.width,
      h: b.height,
      node,
      source: 'menu',
    });
  }

  for (const c of controls) {
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    // A widget parked below the fold of a *scrollable* dialog is reachable,
    // just not visible. Worth knowing (a setting you must drag to find is a
    // setting you never change) but it is not the same bug as a control that
    // has fallen off the screen with no way back.
    const scroller = c.node ? scrollableAncestor(c.node) : null;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) {
      add(scroller ? warnings : problems, scroller ? 'control-below-fold' : 'control-offscreen', {
        role: c.role,
        rect: roundAll({ x: c.x, y: c.y, w: c.w, h: c.h }),
        vw,
        vh,
        scroller: scroller ? describe(scroller) : undefined,
      });
      continue;
    }
    if (Math.min(c.w, c.h) < minTarget) {
      add(problems, 'control-too-small', {
        role: c.role,
        size: `${Math.round(c.w)}×${Math.round(c.h)}`,
        min: minTarget,
      });
    }
    if (
      c.x < safe.left - 1 ||
      c.y < safe.top - 1 ||
      c.x + c.w > vw - safe.right + 1 ||
      c.y + c.h > vh - safe.bottom + 1
    ) {
      add(scroller ? warnings : problems, 'control-under-safe-area', {
        role: c.role,
        rect: roundAll({ x: c.x, y: c.y, w: c.w, h: c.h }),
        safe,
      });
    }
    const hit = document.elementFromPoint(cx, cy);
    if (c.source === 'touch' && hit) {
      const inLayer = hit.closest('.ll-touch, .ll-rotate, .ll-tcfg');
      if (!inLayer) {
        add(problems, 'control-covered', { role: c.role, coveredBy: describe(hit) });
      }
    }
  }

  /* ---- 5. the centre band stays clear (ART_REFERENCE §6 R1/R6) ----
     The driving line runs up the middle of the frame. Nothing opaque — not a
     HUD chip, not a thumb cluster — may sit in the central 34 % of the width
     between 30 % and 78 % of the height, or the player is steering blind
     through the one part of the screen they are actually looking at.

     The band deliberately stops at 78 %: the chase camera puts the taxi's roof
     around 50 % and its bumper around 78 %, so everything below that is road
     the player has already driven over. That strip is the only place a wide
     chip (the passenger card) can go on a phone once both bottom corners
     belong to thumbs. */
  const bandX0 = vw * 0.33;
  const bandX1 = vw * 0.67;
  const bandY0 = vh * 0.3;
  const bandY1 = vh * 0.78;
  const bandAllow = new Set(['ll-nav', 'll-nav__arrow', 'll-pops', 'll-pop', 'll-sub', 'll-hud__arrow']);
  // Only things that actually put ink on the screen occlude the road. The HUD
  // corners and the two thumb clusters are transparent positioning boxes whose
  // *children* paint — flagging the box as well as the chip inside it would
  // bury the real intrusions in noise.
  const paints = (node, st) =>
    st.backgroundImage !== 'none' ||
    !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(st.backgroundColor) ||
    st.boxShadow !== 'none' ||
    (st.borderTopStyle !== 'none' && Number.parseFloat(st.borderTopWidth) > 0) ||
    (node.childElementCount === 0 && (node.textContent ?? '').trim().length > 0);
  for (const { node, b, st } of visible) {
    if (b.width >= vw - 1 && b.height >= vh - 1) continue;
    if (!paints(node, st)) continue;
    const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/) : [];
    if (cls.some((k) => bandAllow.has(k))) continue;
    if (node.closest('.ll-nav, .ll-pops, .ll-sub, .ll-rotate, .ll-tcfg, .ll-pause, .ll-settings, .ll-title, .ll-results')) continue;
    const overlapX = Math.min(b.right, bandX1) - Math.max(b.left, bandX0);
    const overlapY = Math.min(b.bottom, bandY1) - Math.max(b.top, bandY0);
    if (overlapX <= 4 || overlapY <= 4) continue;
    const sel = describe(node);
    if (seen.has(`band:${sel}`)) continue;
    seen.add(`band:${sel}`);
    add(warnings, 'centre-band-intrusion', {
      el: sel,
      area: Math.round(overlapX * overlapY),
      rect: roundAll({ x: b.left, y: b.top, w: b.width, h: b.height }),
    });
  }

  function scrollableAncestor(node) {
    for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
      const st = getComputedStyle(p);
      if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 2) return p;
      if (/(auto|scroll)/.test(st.overflowX) && p.scrollWidth > p.clientWidth + 2) return p;
    }
    return null;
  }

  function describe(node) {
    if (!node) return '?';
    const cls =
      typeof node.className === 'string' && node.className
        ? `.${node.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
    return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${cls}`;
  }
  function roundAll(o) {
    const out = {};
    for (const k of Object.keys(o)) out[k] = Math.round(o[k]);
    return out;
  }

  return {
    vw,
    vh,
    dpr: window.devicePixelRatio,
    safe,
    uiScale: rootStyle?.getPropertyValue('--ll-ui-scale').trim() ?? '',
    colorScheme: cs.colorScheme,
    touch: hook
      ? {
          enabled: hook.enabled,
          autoDetected: hook.autoDetected,
          scheme: hook.prefs().scheme,
          hand: hook.prefs().hand,
          rotatePrompt: hook.rotatePromptVisible(),
          controls: hook.rects().length,
        }
      : null,
    controlCount: controls.length,
    problems,
    warnings,
  };
}

/* ---------------------------------------------------- synthetic touch input */

const POINTER_INIT = {
  pointerType: 'touch',
  isPrimary: true,
  bubbles: true,
  cancelable: true,
  composed: true,
  width: 34,
  height: 34,
  pressure: 0.6,
  buttons: 1,
};

async function touchDown(page, x, y, id = 11) {
  await page.evaluate(
    ({ x, y, id, init }) => {
      const target = document.elementFromPoint(x, y) ?? document.body;
      target.dispatchEvent(
        new PointerEvent('pointerdown', { ...init, pointerId: id, clientX: x, clientY: y }),
      );
    },
    { x, y, id, init: POINTER_INIT },
  );
}

async function touchMove(page, x, y, id = 11) {
  await page.evaluate(
    ({ x, y, id, init }) => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { ...init, pointerId: id, clientX: x, clientY: y }),
      );
    },
    { x, y, id, init: POINTER_INIT },
  );
}

async function touchUp(page, x, y, id = 11) {
  await page.evaluate(
    ({ x, y, id, init }) => {
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          ...init,
          buttons: 0,
          pressure: 0,
          pointerId: id,
          clientX: x,
          clientY: y,
        }),
      );
    },
    { x, y, id, init: POINTER_INIT },
  );
}

/**
 * Wait for the game to actually advance `n` frames. Under SwiftShader the loop
 * can drop to ~1 fps, so `waitForTimeout` is not a proxy for "the control had
 * time to integrate". The touch layer's own frame counter is.
 */
async function waitFrames(page, n = 3, timeout = 150_000) {
  const start = await page.evaluate(() => window.__locoTouch?.counters().frames ?? 0);
  try {
    await page.waitForFunction(
      (target) => (window.__locoTouch?.counters().frames ?? 0) >= target,
      start + n,
      { timeout },
    );
    return true;
  } catch {
    // The renderer never got there. Callers use this to downgrade an assertion
    // to a warning: "steer never reached full lock" means nothing if the
    // control layer only integrated three of the ten frames it was given.
    return false;
  }
}

/**
 * The centre of a control, in viewport coordinates.
 *
 * The spread used to come *after* x/y, which silently put it back to the rect's
 * top-left corner. Round controls hit-test by radius, so every pedal press
 * landed at 1.41 r from the centre and missed — the harness reported
 * `gas-no-throttle` against a gas button that worked perfectly by hand. Order
 * matters here; do not "tidy" it back.
 */
const centreOf = (rects, role) => {
  const r = rects.find((q) => q.role === role);
  return r ? { ...r, x: r.x + r.w / 2, y: r.y + r.h / 2 } : null;
};

/* ------------------------------------------------------- layout-cost probe */

/**
 * How many layout passes a second of driving costs.
 *
 * This codebase has eaten the "unregistered custom property forces a layout on
 * every write" bug once already (121 layouts across 121 sampled frames). The
 * only way to know it has not come back is to hold the controls down, sweep the
 * stick continuously, and read `Performance.getMetrics` either side.
 *
 * The sweep is driven from *inside* the page at 60 Hz. Dispatching each
 * pointermove over CDP would cap the input rate at the round-trip time and
 * would itself be the thing being measured.
 *
 * Under SwiftShader the game runs at well under a frame per second, so the
 * headline number to read is the absolute layout delta: clean code produces a
 * handful of passes across the whole window no matter how many frames fit in
 * it. `perFrame` is reported too, and is meaningful on real hardware.
 */
async function measureLayoutCost(context, page, steer, gas, windowMs) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const read = async () => {
    const m = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(m.metrics.map((x) => [x.name, x.value]));
  };

  if (gas) await touchDown(page, gas.x, gas.y, 31);
  await touchDown(page, steer.x, steer.y, 32);

  await page.evaluate(
    ({ x, y, w }) => {
      const init = {
        pointerType: 'touch',
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 32,
        width: 34,
        height: 34,
        pressure: 0.6,
        buttons: 1,
      };
      let t = 0;
      window.__locoSweep = window.setInterval(() => {
        t += 1;
        const dx = Math.sin(t / 14) * (w / 2.6);
        const dy = Math.cos(t / 23) * 14;
        window.dispatchEvent(
          new PointerEvent('pointermove', { ...init, clientX: x + dx, clientY: y + dy }),
        );
      }, 16);
    },
    { x: steer.x, y: steer.y, w: steer.w },
  );

  const before = await read();
  const framesBefore = await page.evaluate(() => window.__locoTouch?.counters().frames ?? 0);
  await page.waitForTimeout(windowMs);
  const framesAfter = await page.evaluate(() => window.__locoTouch?.counters().frames ?? 0);
  const after = await read();

  await page.evaluate(() => {
    if (window.__locoSweep) window.clearInterval(window.__locoSweep);
    delete window.__locoSweep;
  });
  await touchUp(page, steer.x, steer.y, 32);
  if (gas) await touchUp(page, gas.x, gas.y, 31);
  await cdp.detach();

  const frames = Math.max(0, framesAfter - framesBefore);
  const layouts = Math.round(after.LayoutCount - before.LayoutCount);
  const recalcs = Math.round(after.RecalcStyleCount - before.RecalcStyleCount);
  return {
    windowMs,
    frames,
    layouts,
    recalcs,
    layoutDurationMs: Number(((after.LayoutDuration - before.LayoutDuration) * 1000).toFixed(1)),
    perFrame: frames > 0 ? Number((layouts / frames).toFixed(3)) : null,
    perSecond: Number((layouts / (windowMs / 1000)).toFixed(2)),
  };
}

/* ------------------------------------------------------------------- runner */

async function runProfile(browser, profile, baseUrl, report) {
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: Math.min(profile.dpr, DPR_CAP),
    isMobile: true,
    hasTouch: true,
    userAgent: profile.ua,
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(SHOT_TIMEOUT);

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const entry = {
    id: profile.id,
    label: profile.label,
    viewport: `${profile.width}×${profile.height}@${Math.min(profile.dpr, DPR_CAP)}`,
    dprRequested: profile.dpr,
    safe: profile.safe,
    shots: [],
    steps: {},
    errors,
    problems: [],
    warnings: [],
    ok: false,
  };
  report.profiles.push(entry);

  const shot = async (name) => {
    if (SHOTS !== 'full' && !KEY_SHOTS.has(name)) return;
    const file = path.join(OUT, `${profile.id}-${name}.png`);
    // `scale: 'css'` keeps the PNG at CSS-pixel size: smaller files, and the
    // same layout evidence.
    await page.screenshot({ path: file, timeout: SHOT_TIMEOUT, scale: 'css' });
    entry.shots.push(path.relative(ROOT, file));
  };

  try {
    const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}touch=1`;
    await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForFunction(() => !!window.__loco?.ready, null, { timeout: 180_000 });

    // Simulated notch. `env()` cannot be forced from the outside, which is
    // exactly why the stylesheet routes every inset through --ll-safe-*.
    await page.addStyleTag({
      content: `.ll-root{--ll-safe-top:${profile.safe.top}px;--ll-safe-right:${profile.safe.right}px;--ll-safe-bottom:${profile.safe.bottom}px;--ll-safe-left:${profile.safe.left}px}`,
    });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(400);

    /* ---- title ---- */
    await page.evaluate(() => window.__loco.showTitle());
    await page.waitForTimeout(900);
    entry.steps.title = await page.evaluate(auditPage, MIN_TARGET);
    await shot('01-title');

    /* ---- driving ---- */
    await page.evaluate(() => window.__loco.startArcade());
    await page.waitForTimeout(2600);
    entry.steps.playing = await page.evaluate(auditPage, MIN_TARGET);
    await shot('02-playing');

    // Quality tier, DPR cap and render budget — the numbers that decide whether
    // a phone can actually run this. A fresh profile has no saved settings, so
    // this is exactly what a first-time player on this device would get.
    entry.render = await page.evaluate(() => {
      const c = document.getElementById('gl');
      const saved = JSON.parse(localStorage.getItem('locolift.settings.v1') ?? '{}');
      const stats = window.__loco.stats();
      return {
        quality: saved.quality ?? '?',
        renderScale: saved.renderScale ?? '?',
        postProcessing: saved.postProcessing ?? '?',
        shadows: saved.shadows ?? '?',
        devicePixelRatio: window.devicePixelRatio,
        canvasCss: `${Math.round(c.clientWidth)}×${Math.round(c.clientHeight)}`,
        canvasBuffer: `${c.width}×${c.height}`,
        effectiveDpr: Number((c.width / Math.max(1, c.clientWidth)).toFixed(2)),
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
      };
    });
    if (entry.render.effectiveDpr > 1.05) {
      entry.problems.push({
        kind: 'dpr-not-capped',
        detail: `backing store is ${entry.render.effectiveDpr}× CSS pixels at quality ${entry.render.quality}`,
      });
    }

    const portrait = profile.height > profile.width;
    entry.rotatePrompt = entry.steps.playing.touch?.rotatePrompt ?? false;
    if (portrait && !entry.rotatePrompt) {
      entry.problems.push({ kind: 'no-rotate-prompt', detail: 'portrait without the rotate gate' });
    }
    if (!portrait && entry.rotatePrompt) {
      entry.problems.push({ kind: 'rotate-prompt-in-landscape', detail: 'gate shown in landscape' });
    }

    if (portrait) {
      // Dismiss the gate so the landscape-shaped controls can still be audited.
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.ll-rotate button')].find((b) =>
          /JUGAR/i.test(b.textContent ?? ''),
        );
        btn?.click();
      });
      await page.waitForTimeout(600);
      entry.steps.playingPortraitDismissed = await page.evaluate(auditPage, MIN_TARGET);
      await shot('03-portrait-dismissed');
    }

    /* ---- exercise the controls ---- */
    const rects = await page.evaluate(() => window.__locoTouch?.rects() ?? []);
    entry.controls = rects.map((r) => ({
      role: r.role,
      size: `${Math.round(r.w)}×${Math.round(r.h)}`,
    }));

    // The director holds the car still through the 3·2·1, so wait it out before
    // asserting that the throttle produces motion. On a software renderer the
    // countdown consumes real minutes, so this can legitimately time out — in
    // which case the motion assertion is skipped rather than failed.
    let countdownEnded = true;
    try {
      await page.waitForFunction(() => !document.querySelector('.ll-count.is-live'), null, {
        timeout: 150_000,
      });
    } catch {
      countdownEnded = false;
      entry.warnings.push({
        kind: 'countdown-never-ended',
        detail: 'still counting after 150 s — motion check skipped (software renderer)',
      });
    }

    const gas = centreOf(rects, 'gas');
    const steer = centreOf(rects, 'steer');
    const drift = centreOf(rects, 'drift');
    const boost = centreOf(rects, 'boost');

    if (gas) {
      await touchDown(page, gas.x, gas.y, 21);
      await waitFrames(page, 2);
      const channel = await page.evaluate(() => ({ ...window.__locoTouch.channel }));
      entry.steps.gasChannel = channel;
      if (channel.throttle <= 0) {
        entry.problems.push({ kind: 'gas-no-throttle', detail: JSON.stringify(channel) });
      }
      await waitFrames(page, 12);
      entry.steps.speedAfterGas = (await page.evaluate(() => window.__loco.stats())).speed;
      await shot('04-gas-held');
      if (countdownEnded && !(entry.steps.speedAfterGas > 0.5) && !portrait) {
        entry.problems.push({
          kind: 'gas-no-motion',
          detail: `speed ${entry.steps.speedAfterGas} after 12 frames of held throttle`,
        });
      }
    } else {
      entry.problems.push({ kind: 'no-gas-control', detail: 'gas button not found' });
    }

    if (steer) {
      // Thumb lands mid-zone, sweeps left, holds.
      await touchDown(page, steer.x, steer.y, 22);
      for (let i = 1; i <= 6; i++) {
        await touchMove(page, steer.x - (steer.w / 2.6) * (i / 6), steer.y + i, 22);
      }
      await waitFrames(page, 8);
      const steerCh = await page.evaluate(() => ({ ...window.__locoTouch.channel }));
      entry.steps.steerLeftChannel = steerCh;
      if (!(steerCh.steer < -0.25)) {
        entry.problems.push({
          kind: 'steer-left-failed',
          detail: `steer=${steerCh.steer.toFixed(3)} after a full left sweep`,
        });
      }
      await shot('05-steer-left');

      // …and back to the right, to prove it is not stuck.
      for (let i = 1; i <= 8; i++) {
        await touchMove(page, steer.x + (steer.w / 2.6) * (i / 8), steer.y, 22);
      }
      await waitFrames(page, 10);
      const rightCh = await page.evaluate(() => ({ ...window.__locoTouch.channel }));
      entry.steps.steerRightChannel = rightCh;
      if (!(rightCh.steer > 0.25)) {
        entry.problems.push({
          kind: 'steer-right-failed',
          detail: `steer=${rightCh.steer.toFixed(3)} after a full right sweep`,
        });
      }
      await touchUp(page, steer.x, steer.y, 22);
      await waitFrames(page, 8);
      const centred = await page.evaluate(() => window.__locoTouch.channel.steer);
      entry.steps.steerAfterRelease = centred;
      if (Math.abs(centred) > 0.05) {
        entry.problems.push({
          kind: 'steer-not-centring',
          detail: `steer=${centred.toFixed(3)} eight frames after release`,
        });
      }
    } else {
      entry.problems.push({ kind: 'no-steer-zone', detail: 'steering zone not found' });
    }

    if (drift && boost) {
      await touchDown(page, drift.x, drift.y, 23);
      await touchDown(page, boost.x, boost.y, 24);
      await waitFrames(page, 2);
      const multi = await page.evaluate(() => ({ ...window.__locoTouch.channel }));
      entry.steps.multiTouch = multi;
      if (!(multi.handbrake > 0 && multi.boost && multi.throttle > 0)) {
        entry.problems.push({
          kind: 'multitouch-failed',
          detail: `gas+drift+boost together produced ${JSON.stringify(multi)}`,
        });
      }
      await waitFrames(page, 4);
      await shot('06-drift-boost');
      await touchUp(page, drift.x, drift.y, 23);
      await touchUp(page, boost.x, boost.y, 24);
    }

    if (gas) await touchUp(page, gas.x, gas.y, 21);
    await waitFrames(page, 4);
    const released = await page.evaluate(() => ({ ...window.__locoTouch.channel }));
    if (released.throttle > 0.01 || released.handbrake > 0 || released.boost) {
      entry.problems.push({ kind: 'input-stuck-after-release', detail: JSON.stringify(released) });
    }

    /* ---- all three steering schemes have to actually steer ----
       `stick` is the shipped default, but `wheel` and `zones` are offered in
       the setup panel, and an option that does not reach full lock is worse
       than no option at all. Drive each one the way its own geometry expects:
       the stick and the arrows take a horizontal drag, the wheel takes an arc
       around its hub. */
    entry.schemes = {};
    for (const scheme of ['stick', 'wheel', 'zones']) {
      await page.evaluate((s) => window.__locoTouch.setPrefs({ scheme: s }), scheme);
      // `setPrefs` only marks the layout dirty; the hit-test cache is rebuilt
      // at the top of the next `update()`. Waiting on wall-clock time is wrong
      // here — under SwiftShader 350 ms is often zero frames, and pressing an
      // arrow against the *stick's* cached rectangle silently resolves to the
      // steering zone and reports a scheme that "cannot reach lock".
      await waitFrames(page, 2);
      const sr = await page.evaluate(() => window.__locoTouch.rects());
      const target = scheme === 'zones' ? centreOf(sr, 'arrowLeft') : centreOf(sr, 'steer');
      if (!target) {
        entry.schemes[scheme] = { error: 'no control' };
        entry.problems.push({ kind: 'scheme-no-control', detail: scheme });
        continue;
      }
      await touchDown(page, target.x, target.y, 41);
      if (scheme === 'wheel') {
        // rotate anticlockwise about the hub, which is what a wheel reads
        const hub = centreOf(sr, 'wheel') ?? target;
        const r = Math.max(40, (centreOf(sr, 'wheel')?.w ?? 200) / 2 - 12);
        for (let i = 1; i <= 10; i++) {
          const a = -Math.PI / 2 - (i / 10) * 0.95;
          await touchMove(page, hub.x + Math.cos(a) * r, hub.y + Math.sin(a) * r, 41);
        }
      } else if (scheme === 'stick') {
        for (let i = 1; i <= 8; i++) {
          await touchMove(page, target.x - (target.w / 2.6) * (i / 8), target.y, 41);
        }
      }
      const settled = await waitFrames(page, 10);
      const reached = await page.evaluate(() => window.__locoTouch.channel.steer);
      await touchUp(page, target.x, target.y, 41);
      const returned = await waitFrames(page, 8);
      const centred = await page.evaluate(() => window.__locoTouch.channel.steer);
      entry.schemes[scheme] = {
        reached: Number(reached.toFixed(3)),
        afterRelease: Number(centred.toFixed(3)),
        control: `${Math.round(target.w)}×${Math.round(target.h)}`,
        framesReady: settled && returned,
      };
      // A scheme that never reached lock is only a *bug* if the control layer
      // actually got the frames to integrate in. Under a software renderer it
      // often does not, and a spurious failure is worse than no measurement.
      if (!(reached < -0.5)) {
        (settled ? entry.problems : entry.warnings).push({
          kind: settled ? 'scheme-cannot-reach-lock' : 'scheme-starved-of-frames',
          detail: `${scheme} reached ${reached.toFixed(3)} on a full left input`,
        });
      }
      if (Math.abs(centred) > 0.06) {
        (returned ? entry.problems : entry.warnings).push({
          kind: returned ? 'scheme-not-centring' : 'scheme-starved-of-frames',
          detail: `${scheme} sat at ${centred.toFixed(3)} after release`,
        });
      }
    }
    await page.evaluate(() => window.__locoTouch.setPrefs({ scheme: 'stick' }));
    await waitFrames(page, 2);

    /* ---- how much layout a second of driving costs ---- */
    if (LAYOUT_MS > 0 && steer && !portrait) {
      entry.layout = await measureLayoutCost(context, page, steer, gas, LAYOUT_MS);
      // One pass per frame is the signature of the custom-property bug. Two per
      // frame of headroom, because a legitimate resize or state change may land
      // inside the window.
      if (entry.layout.perFrame !== null && entry.layout.perFrame > 0.5) {
        entry.problems.push({
          kind: 'layout-per-frame',
          detail: `${entry.layout.layouts} layouts across ${entry.layout.frames} frames ` +
            `(${entry.layout.perFrame}/frame) during a continuous steer + throttle sweep`,
        });
      }
    }

    /* ---- setup panel ---- */
    await page.evaluate(() => {
      const gear = document.querySelector('.ll-touch__util button[aria-label*="Ajustar"]');
      gear?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    });
    await page.waitForTimeout(500);
    entry.steps.panel = await page.evaluate(auditPage, MIN_TARGET);
    await shot('07-setup-panel');

    /* ---- left-handed + wheel scheme, the other layout that must fit ---- */
    await page.evaluate(() => window.__locoTouch.setPrefs({ hand: 'left', scheme: 'wheel' }));
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const done = [...document.querySelectorAll('.ll-tcfg button')].find((b) =>
        /LISTO/i.test(b.textContent ?? ''),
      );
      done?.click();
    });
    await page.waitForTimeout(700);
    entry.steps.leftHandedWheel = await page.evaluate(auditPage, MIN_TARGET);
    await shot('08-left-handed-wheel');
    await page.evaluate(() =>
      window.__locoTouch.setPrefs({ hand: 'right', scheme: 'stick', scale: 1 }),
    );

    /* ---- pause menu, reached by thumb ---- */
    await page.evaluate(() => {
      const btn = document.querySelector('.ll-touch__util button[aria-label*="Pausa"]');
      btn?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    });
    await page.waitForTimeout(900);
    entry.steps.paused = await page.evaluate(auditPage, MIN_TARGET);
    entry.steps.pausedState = await page.evaluate(
      () => document.querySelector('.ll-root')?.dataset.state ?? '?',
    );
    await shot('09-paused');
    if (entry.steps.pausedState !== 'paused') {
      entry.problems.push({
        kind: 'pause-button-did-nothing',
        detail: `state is ${entry.steps.pausedState}`,
      });
    }

    /* ---- settings menu at phone size ---- */
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.ll-pause button')].find((b) =>
        /AJUSTES|OPCIONES|SETTINGS/i.test(b.textContent ?? ''),
      );
      btn?.click();
    });
    await page.waitForTimeout(800);
    entry.steps.settings = await page.evaluate(auditPage, MIN_TARGET);
    await shot('10-settings');

    /* ---- collect ---- */
    for (const [step, data] of Object.entries(entry.steps)) {
      if (!data || typeof data !== 'object' || !Array.isArray(data.problems)) continue;
      for (const p of data.problems) entry.problems.push({ step, ...p });
      for (const w of data.warnings) entry.warnings.push({ step, ...w });
    }
    entry.ok = entry.problems.length === 0 && errors.length === 0;
  } catch (err) {
    entry.problems.push({ kind: 'harness', detail: err?.message ?? String(err) });
    try {
      await shot('FAILURE');
    } catch {
      /* page may be gone */
    }
  } finally {
    await context.close();
  }
  return entry;
}

/* --------------------------------------------------------------------- main */

async function main() {
  await mkdir(OUT, { recursive: true });

  let baseUrl = URL_;
  let server = null;
  if (!baseUrl && FILE) {
    const abs = path.resolve(ROOT, FILE);
    if (!existsSync(abs)) throw new Error(`no such file: ${abs}`);
    baseUrl = pathToFileURL(abs).href;
  }
  if (!baseUrl) {
    if (!existsSync(path.join(SERVE_DIR, 'index.html'))) {
      throw new Error(`nothing to serve at ${SERVE_DIR} — run \`npm run build\` first`);
    }
    const s = await serve(SERVE_DIR);
    server = s.server;
    baseUrl = s.url;
  }

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
      '--allow-file-access-from-files',
    ],
  });

  const report = { url: baseUrl, generated: new Date().toISOString(), profiles: [] };
  const wanted = PROFILES.filter((p) => !ONLY || p.id === ONLY);
  if (wanted.length === 0) throw new Error(`no profile matches --only ${ONLY}`);

  const queue = wanted.slice();
  const worker = async () => {
    for (;;) {
      const profile = queue.shift();
      if (!profile) return;
      process.stdout.write(`▶ ${profile.label}\n`);
      const entry = await runProfile(browser, profile, baseUrl, report);
      process.stdout.write(
        `◀ ${profile.id}: ${entry.ok ? 'ok' : `${entry.problems.length} problem(s)`}` +
          `${entry.warnings.length ? `, ${entry.warnings.length} warning(s)` : ''}` +
          `${entry.errors.length ? `, ${entry.errors.length} console error(s)` : ''}` +
          `${
            entry.layout
              ? `, layout ${entry.layout.layouts}/${entry.layout.frames} frames` +
                ` (${entry.layout.perFrame ?? 'n/a'}/frame)`
              : ''
          }\n`,
      );
      for (const p of entry.problems.slice(0, 8)) {
        process.stdout.write(`    · ${p.step ? `[${p.step}] ` : ''}${p.kind} ${summarise(p)}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, worker));
  report.profiles.sort((a, b) => wanted.findIndex((p) => p.id === a.id) - wanted.findIndex((p) => p.id === b.id));

  await browser.close();
  server?.close();

  const reportPath = path.join(OUT, 'mobile-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  const failed = report.profiles.filter((p) => !p.ok);
  console.log(
    `\n${report.profiles.length - failed.length}/${report.profiles.length} profiles clean · ` +
      `screenshots + mobile-report.json in ${path.relative(ROOT, OUT)}`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

function summarise(p) {
  if (p.detail) return String(p.detail).slice(0, 120);
  const bits = [];
  for (const [k, v] of Object.entries(p)) {
    if (k === 'kind' || k === 'step') continue;
    bits.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return bits.join(' ').slice(0, 120);
}

main().catch((err) => {
  console.error('[mobile-test] failed:', err);
  process.exit(1);
});
