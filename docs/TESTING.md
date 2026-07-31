# Testing Loco Lift

Three harnesses, all headless, all offline. None of them downloads a browser —
they use the Chromium already on the box.

```
tools/smoke.mjs              desktop smoke + perf trace + screenshots
tools/mobile-test.mjs        seven emulated devices, real touch input, layout audit
tools/bundle-standalone.mjs  one self-contained .html you can open from disk
```

---

## Prerequisites

```bash
npm install                  # once
npm run build                # tsc --noEmit && vite build  →  dist/
```

If another module is mid-refactor and `tsc` fails on a file you do not own,
`npx vite build` produces `dist/` anyway (esbuild transpiles without type
checking). The harnesses only need `dist/`.

Chromium lives at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
Override with `CHROMIUM_PATH=…` if yours is elsewhere.
**Never run `npx playwright install`** — the pinned browser is the supported one.

Rendering goes through SwiftShader (software GL), so a single frame of this
scene can take seconds. Every screenshot in these tools has a 180 s budget.
Wall-clock runtimes below are for that software path; on real hardware they are
seconds, not minutes.

---

## 1. Desktop smoke

```bash
npm run preview &            # serves dist/ on :4173
npm run smoke                # → .captures/*.png + report.json
```

Drives the game through title → shift → drive → drift → boost → night → rain →
pause, samples the frame rate, and fails on any console error.

---

## 2. Mobile

```bash
npm run test:mobile                       # serves ./dist itself, no preview needed
npm run test:mobile -- --only phone-large-landscape
npm run test:mobile -- --url http://127.0.0.1:4173
npm run test:mobile:standalone            # audits the single-file build instead
```

Output: `.captures-mobile/<profile>-<step>.png` and `mobile-report.json`.
Exit code is non-zero if any profile reports a problem.

| flag | default | what it does |
|---|---|---|
| `--only <id>` | all | run a single device profile |
| `--shots key\|full` | `key` | 6 decisive screenshots, or all 10 |
| `--jobs <n>` | `2` | device profiles driven in parallel |
| `--dpr <n>` | `1` | cap the emulated device pixel ratio |
| `--out <dir>` | `.captures-mobile` | where PNGs and the report land |
| `--serve <dir>` | `dist` | directory the built-in static server serves |
| `--file <path>` | — | load a single-file build over `file://` instead |
| `--url <url>` | — | point at a server you already have running |

A full seven-profile `--shots full` run takes well over an hour under
SwiftShader. The defaults (`key` shots, two jobs) bring that to roughly 20–30
minutes; on hardware with a real GPU it is a couple of minutes.

### Device profiles

| id | viewport | dpr | simulated safe area |
|---|---|---|---|
| `phone-small-landscape` | 568×320 | 2 | — |
| `phone-small-portrait` | 320×568 | 2 | top 20 |
| `phone-large-landscape` | 932×430 | 3 | left/right 59, bottom 21 |
| `phone-large-portrait` | 430×932 | 3 | top 59, bottom 34 |
| `phone-android-landscape` | 915×412 | 2.625 | left/right 24 |
| `tablet-landscape` | 1180×820 | 2 | bottom 20 |
| `tablet-portrait` | 820×1180 | 2 | top 24, bottom 20 |

Each runs with `isMobile: true`, `hasTouch: true` and a real device user agent.

### What it actually does

Per profile, in order: load → wait for `window.__loco.ready` → inject the
simulated notch → title → start a shift → hold **GAS** and check the car
*moves* → sweep the steering thumbstick fully left, then fully right, then
release and check it re-centres → press **DRIFT** and **TURBO** together with
gas still held (three-finger multitouch) → release everything and check nothing
sticks → open the setup panel → switch to left-handed + wheel steering → tap
**Pause** → open Settings. Ten screenshots per profile.

Touch input is dispatched as genuine `PointerEvent`s with `pointerType: 'touch'`
at coordinates read from `window.__locoTouch.rects()`, so the harness presses
exactly where the player would, and asserts against `window.__locoTouch.channel`
— the same object the game's `Input` reads.

Waits are counted in **frames**, not milliseconds: `window.__locoTouch.counters()`
exposes how many frames the control layer has integrated, and the harness blocks
on that. Under SwiftShader the loop can fall to ~1 fps, where a `waitForTimeout`
of 500 ms means "zero frames" and every steering assertion fails for the wrong
reason.

### The audit

Runs at every step and reports:

- **page-scrolls** — the document overflows the viewport (pull-to-refresh bait).
- **canvas-not-full-bleed** — the WebGL canvas is not exactly the viewport.
- **overflow** — a visible UI element sticks out past an edge.
- **clipped-text** — `scrollWidth > clientWidth` inside an `overflow: hidden`
  box. Downgraded to a *warning* when the element opts into
  `text-overflow: ellipsis` or `-webkit-line-clamp`, which is deliberate.
- **control-too-small** — a touch target under 40 px in either axis.
- **control-offscreen**, **control-covered** — unreachable by a thumb.
- **control-under-safe-area** — a control inside the simulated notch, the
  camera housing or the home indicator.
- **no-rotate-prompt** — a portrait profile that failed to show the rotate gate.
- **gas-no-throttle / gas-no-motion / steer-\*-failed / steer-not-centring /
  multitouch-failed / input-stuck-after-release / pause-button-did-nothing** —
  the control itself is broken, not just the layout.

### Simulating a notch

`env(safe-area-inset-*)` cannot be forced from outside the page, so
`styles.css` routes every inset through four custom properties
(`--ll-safe-top/right/bottom/left`) that *default* to the `env()` values. The
harness overrides those four to fake any device. If you add UI that hugs an
edge, use `var(--pad)`, `var(--pad-r)`, `var(--pad-b)`, `var(--pad-l)` — never
`env()` directly, or the harness cannot see your bug.

### Testing touch on a desktop browser

`?touch=1` forces the on-screen controls on (`?touch=0` forces them off), and
they respond to a mouse. Handy in `npm run dev` without emulation.

---

## 3. Standalone single-file build

```bash
npm run standalone                                  # → dist-standalone/loco-lift.html
npm run standalone -- --out /tmp/loco.html
npm run standalone -- --no-minify                   # readable output for debugging
```

Then just open it: `xdg-open dist-standalone/loco-lift.html`, double-click it,
mail it, or drop it on any static host. It needs no sibling files and makes no
network request — the bundler fails loudly if a single non-`data:` `src`/`href`
survives.

**Size, honestly: ~3.7 MB (~1.25 MB gzipped over a real host).** About 2.2 MB of
that is Rapier. The project depends on `@dimforge/rapier3d-compat`, which ships
its ~1.6 MB WebAssembly module base64-encoded *inside its JavaScript* — that is
what makes a genuinely self-contained file possible at all, and it is also why
we eat base64's ~33 % overhead. Nothing re-encodes it here; the encoding is
inherited. The only way to shrink it materially is to switch to the non-compat
Rapier build with a separate `.wasm` file, which would mean it is no longer a
single file. That trade was not taken.

The single-file build is generated by a *second* Vite build with
`inlineDynamicImports` — the normal `dist/` build emits three chunks that
`import` each other, and an inline `<script type="module">` cannot resolve a
relative import.

Verify it the same way the harness does:

```bash
npm run test:mobile:standalone     # loads it over file:// in all profiles
```

---

## Manual checks worth doing on a real phone

The emulator cannot tell you these:

1. **Haptics.** `navigator.vibrate` is Android-only; iOS Safari has no haptics
   API at all. The setting exists and is honoured, but on iOS it does nothing.
2. **Sustained frame rate.** SwiftShader numbers are meaningless. Read
   `window.__loco.perfSample(5000)` on the device instead.
3. **Thumb reach.** Screenshots prove a control is on screen, not that it is
   comfortable. Use *Ajustar controles → Mover* to drag the clusters and check
   the range is enough for your hands.
4. **Fullscreen + orientation lock.** Android Chrome honours both from the
   rotate prompt; iOS Safari refuses the orientation lock, so the prompt is the
   only landscape hint there.
5. **Thermals.** Ten minutes of play on a warm phone is the real quality test.

---

## Adding a device profile

Add an entry to `PROFILES` in `tools/mobile-test.mjs`:

```js
{ id: 'foldable-inner', label: 'Foldable · unfolded', width: 1812, height: 2176,
  dpr: 2.4, ua: UA_ANDROID, safe: { top: 40, right: 0, bottom: 24, left: 0 } }
```

Nothing else needs changing; the runner and the audit are profile-agnostic.
