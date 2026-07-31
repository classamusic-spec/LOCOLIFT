/**
 * One-shot capture runner: build → serve → drive → screenshot → tear down.
 *
 *   node tools/capture.mjs [--out .captures] [--skip-build] [--dev]
 *
 * Leaves PNGs + report.json in --out for the visual critic to review.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm, mkdir } from 'node:fs/promises';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const OUT = arg('out', '.captures');
const DEV = flag('dev');
const PORT = DEV ? 5173 : 4173;
const URL_ = `http://127.0.0.1:${PORT}`;

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on('error', reject);
  });

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 304) return true;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  return false;
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  if (!DEV && !flag('skip-build')) {
    console.log('› building…');
    await run('npx', ['vite', 'build']);
  }

  console.log(`› serving on ${URL_}…`);
  const server = spawn(
    'npx',
    DEV ? ['vite', '--port', String(PORT), '--host', '127.0.0.1'] : ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(d));

  const shutdown = () => {
    try {
      server.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  };
  process.on('exit', shutdown);
  process.on('SIGINT', () => {
    shutdown();
    process.exit(130);
  });

  const up = await waitForServer(URL_);
  if (!up) {
    shutdown();
    console.error('server never came up');
    process.exit(1);
  }

  let code = 0;
  try {
    await run('node', ['tools/smoke.mjs', '--url', URL_, '--out', OUT]);
  } catch {
    code = 1;
  }
  shutdown();
  await sleep(300);
  process.exit(code);
}

main();
