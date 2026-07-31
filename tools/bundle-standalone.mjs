/**
 * Loco Lift — single-file build.
 *
 * Produces one self-contained `.html` that can be opened from a USB stick, a
 * file:// path, an email attachment or any static host, with no sibling assets
 * and no network access of any kind.
 *
 *   node tools/bundle-standalone.mjs [--out dist-standalone/loco-lift.html] [--no-minify]
 *
 * How it works
 * ------------
 * The normal `vite build` emits three JS chunks that `import` each other, and
 * an inline `<script type="module">` cannot resolve a bare relative import. So
 * this script runs its own Vite build with `inlineDynamicImports` and no manual
 * chunking, which flattens everything into a single ES module, then folds that
 * module and the stylesheet into the HTML.
 *
 * Size, honestly
 * --------------
 * The output is ~3.8 MB, and roughly 2.2 MB of that is Rapier. We depend on
 * `@dimforge/rapier3d-compat`, which *already* ships its 1.6 MB WebAssembly
 * module base64-encoded inside its JavaScript — that is the entire point of the
 * `-compat` variant, and it is why a genuinely self-contained file is possible
 * at all. Nothing here re-encodes it; we inherit the encoding, and with it the
 * ~33 % base64 overhead. There is no smaller option short of switching to the
 * non-compat Rapier build, which would need a separate `.wasm` file next to the
 * HTML and would stop the file being standalone.
 *
 * Served over any normal host the file gzips to ~1.2 MB. Opened from disk it is
 * read at disk speed, so the size costs nothing but bytes on the medium.
 */
import { build } from 'vite';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const OUT = path.resolve(ROOT, arg('out', 'dist-standalone/loco-lift.html'));
const TMP = path.resolve(ROOT, 'node_modules/.loco-standalone');
const MINIFY = !flag('no-minify');

/** `</script>` inside a JS string literal would close the tag we are writing. */
const escapeForScript = (js) => js.replace(/<\/(script)/gi, '<\\/$1');

async function main() {
  await rm(TMP, { recursive: true, force: true });

  await build({
    root: ROOT,
    base: './',
    logLevel: 'warn',
    configFile: false,
    optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
    build: {
      target: 'es2022',
      outDir: TMP,
      emptyOutDir: true,
      sourcemap: false,
      cssCodeSplit: false,
      minify: MINIFY ? 'esbuild' : false,
      // No sibling files at any size: fonts, images and wasm all become
      // data: URIs. (Today the project ships none, but a future asset must
      // not silently break the single-file promise.)
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      reportCompressedSize: false,
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
          manualChunks: undefined,
        },
      },
    },
  });

  const html = await readFile(path.join(TMP, 'index.html'), 'utf8');

  /* ---- collect what the built page references ---- */
  const scriptSrc = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/i);
  if (!scriptSrc) throw new Error('no module script found in the built index.html');
  const cssHrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>/gi)];

  const js = await readFile(path.join(TMP, scriptSrc[1].replace(/^\.?\//, '')), 'utf8');
  const cssParts = [];
  for (const m of cssHrefs) {
    cssParts.push(await readFile(path.join(TMP, m[1].replace(/^\.?\//, '')), 'utf8'));
  }

  /* ---- fold everything into one document ---- */
  let out = html;
  out = out.replace(/\s*<link[^>]+rel="modulepreload"[^>]*>/gi, '');
  for (const m of cssHrefs) out = out.replace(m[0], '');
  out = out.replace(
    /<script[^>]+type="module"[^>]+src="[^"]+"[^>]*><\/script>/i,
    () => `<script type="module">\n${escapeForScript(js)}\n</script>`,
  );
  if (cssParts.length > 0) {
    out = out.replace('</head>', `<style>\n${cssParts.join('\n')}\n</style>\n</head>`);
  }

  // A single file is often opened from disk, where a stray relative request
  // would 404 silently. Assert we left none behind.
  const leftovers = [...out.matchAll(/(?:src|href)="(?!data:|#|https?:)([^"]+)"/gi)].map((m) => m[1]);
  if (leftovers.length > 0) {
    throw new Error(`standalone build still references external files: ${leftovers.join(', ')}`);
  }

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, out, 'utf8');
  await rm(TMP, { recursive: true, force: true });

  const bytes = (await stat(OUT)).size;
  const gz = gzipSync(Buffer.from(out)).length;
  console.log(
    [
      `standalone: ${path.relative(ROOT, OUT)}`,
      `  size      ${mb(bytes)}  (${mb(gz)} gzipped)`,
      `  js        ${mb(js.length)}   css ${kb(cssParts.join('').length)}`,
      `  minified  ${MINIFY ? 'yes' : 'no'}`,
      '  open it directly in a browser, or drop it on any static host',
    ].join('\n'),
  );
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

main().catch((err) => {
  console.error('[bundle-standalone] failed:', err);
  process.exit(1);
});
