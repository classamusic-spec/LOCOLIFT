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
| `--layout-ms <n>` | `18000` | window for the layout-cost probe; `0` skips it |
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
sticks → drive **all three steering schemes** to full lock and back → measure
the **layout cost** of a sustained sweep → open the setup panel → switch to
left-handed + wheel steering → tap **Pause** → open Settings. Ten screenshots
per profile.

`centreOf()` presses the **centre** of a control. This is load-bearing and was
once wrong: the object spread ran after `x`/`y` and put the coordinates back at
the rect's top-left corner. Round controls hit-test by radius, so every pedal
press landed at 1.41 r and missed, and the harness reported `gas-no-throttle`
against a gas button that worked perfectly by hand. If you refactor that helper,
re-read the comment above it.

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
  Downgraded to the *warning* **control-below-fold** when the widget sits
  inside a scrollable dialog, where it is reachable, just not visible.
- **control-under-safe-area** — a control inside the simulated notch, the
  camera housing or the home indicator.
- **boot-splash-visible** — `#boot` is still painting after the game is up.
  This is the check that catches a black screen: the splash is opaque and sits
  over the canvas, so a stalled boot and a dead GPU look identical.
- **boot-error-overlay-after-ready** — a `role="alert"` card is up even though
  `window.__loco.ready` is true. `main.ts` arms a 45 s watchdog that writes an
  opaque `z-index: 9999` card into `#ui-root` with `innerHTML`. 45 s is not a
  generous budget for a 4.1 MB payload plus world generation on a phone on
  cellular, so the watchdog can fire while boot is perfectly healthy — and the
  card then covers the running game forever. `UISystem.init()` removes a stale
  card when it mounts, which covers the common ordering; this check is the
  backstop for the rest.
- **centre-band-intrusion** *(warning)* — something that actually paints (a
  background, a border, a shadow or a text leaf — transparent positioning boxes
  are skipped) overlaps the central 34 % of the width between 30 % and 78 % of
  the height. `ART_REFERENCE` §6 R1/R6: the driving line lives there and it
  stays clear. The band stops at 78 % because the chase camera puts the taxi's
  bumper about there, and the strip below it is the only place a wide chip can
  go once both bottom corners belong to thumbs.
- **scheme-starved-of-frames** *(warning)* — a steering scheme did not reach
  lock, but the control layer never got the frames to integrate the input in.
  A measurement that did not happen, not a bug.
- **layout-per-frame** — the game is taking a layout pass on more than half of
  the frames of a continuous steer-and-throttle sweep. See below.
- **no-rotate-prompt** — a portrait profile that failed to show the rotate gate.
- **gas-no-throttle / gas-no-motion / steer-\*-failed / steer-not-centring /
  multitouch-failed / input-stuck-after-release / pause-button-did-nothing /
  scheme-cannot-reach-lock / scheme-not-centring** — the control itself is
  broken, not just the layout.

### The layout-cost probe

The rule for the HUD and the touch layer is **zero layout per frame**. The way
that rule gets broken is subtle: writing an *unregistered* CSS custom property
is opaque to the style engine, which cannot prove the value does not feed
geometry, so it schedules a layout on every write. A HUD bar that drains over
four seconds then costs a layout per frame for four seconds. This codebase has
shipped that bug once (121 layouts across 121 sampled frames); the fix was to
write `transform`/`opacity` directly on elements that already declare
`will-change`, which is why `ScaleSlot` in `UITheme.ts` exists and why
`DestinationArrow` writes a whole `transform` string instead of a `--turn`
angle.

The probe holds **GAS**, starts a 60 Hz steering sweep *inside the page* (a
sweep driven over CDP would be capped by the round-trip time and would measure
the harness instead), and reads `Performance.getMetrics` either side:

```json
"layout": { "windowMs": 18000, "frames": 6, "layouts": 1,
            "recalcs": 43, "perFrame": 0.167, "perSecond": 0.06 }
```

Under SwiftShader the frame count is tiny, so read the **absolute** `layouts`
number: clean code produces a handful across the whole window regardless of how
many frames fit into it. `perFrame` is the number that matters on real hardware;
pass `--layout-ms 90000` when you want it to mean something here.

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
