/**
 * A dev server for the cockpit harness that does not reload the page.
 *
 * This repository is worked on by several agents at once, and Vite's default
 * behaviour — full page reload on any change under `src/` — means somebody
 * else saving a file mid-capture wipes `window.__loco`, kills the run and
 * produces a screenshot of a boot splash. Watching is disabled entirely, so a
 * page served here keeps running until it is closed.
 *
 *   npx vite --config tools/vite.cockpit.config.mjs --port 4182 --strictPort
 *
 * Modules are still read from disk at request time, so a fresh page load picks
 * up the current tree. Only the live-reload channel is gone.
 */
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    /* No live-reload channel: another agent saving a file must not wipe
     * `window.__loco` in the middle of a capture. The file watcher itself is
     * left on, so the module graph still invalidates and a *fresh* page load
     * picks up the current tree — which is exactly the behaviour a capture
     * harness wants, since it navigates per shot anyway. */
    hmr: false,
  },
  build: { target: 'es2022' },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
});
