/**
 * Loco Lift — shader link-failure guard.
 *
 * Why this file exists, in one sentence: a single GLSL program that fails to
 * link inside the post chain turns the entire game into a black screen, and
 * the headless capture rig cannot see it happen.
 *
 * The concrete incident: `LocoSpeedFX` declared `vec2 step`, which hides the
 * `step()` builtin for the rest of that scope. SwiftShader — the software
 * rasteriser behind headless Chromium, and therefore behind every screenshot
 * in `.captures/` — accepts the shadowing. Desktop and mobile drivers reject
 * the program outright:
 *
 * ```
 * ERROR: 0:188: 'step' : function name expected
 * WebGL: INVALID_OPERATION: useProgram: program not valid
 * ```
 *
 * Because `SpeedFX` sits mid-chain, its dead program meant nothing downstream
 * ever received scene colour: HUD and touch controls drew fine over a black
 * viewport. Every capture looked perfect. Two failures compounded there — one
 * shader bug, and one architecture that had no answer for it.
 *
 * This module fixes the second. `installShaderGuard` intercepts three's link
 * error, extracts the material name (three prepends `#define SHADER_NAME` to
 * every program, so the name survives into `getShaderSource`) plus the exact
 * offending source lines, logs one readable diagnostic, and hands the failure
 * to a callback. `RenderPipeline` uses that callback to drop to a plain
 * forward render, so a broken pass costs a grade — never the game.
 *
 * `tools/glsl-lint.mjs` fixes the first, catching builtin shadowing statically
 * so it never reaches a driver at all.
 */

/** One failed program link, resolved to something a human can act on. */
export interface ShaderFailure {
  /** Material name from `#define SHADER_NAME`, or `'unknown'`. */
  name: string;
  /** `'vertex' | 'fragment' | 'link'` — which stage actually failed. */
  stage: 'vertex' | 'fragment' | 'link';
  /** Driver info log, trimmed. */
  log: string;
  /** The offending source lines with a `>` marker, ready to print. */
  excerpt: string;
}

type GL = WebGLRenderingContext | WebGL2RenderingContext;

/** What we actually receive. See the cast in `installShaderGuard`. */
type ShaderErrorHandler = (
  gl: GL,
  program: WebGLProgram,
  vs: WebGLShader,
  fs: WebGLShader,
) => void;

/**
 * Minimal shape of the renderer this guard needs.
 *
 * `onShaderError` is typed loosely on purpose: three's `.d.ts` declares the
 * second parameter as *its own* `WebGLProgram` wrapper class, while
 * `WebGLProgram.js` passes the raw `WebGLProgram` handle from the GL context.
 * The runtime object is the DOM one — it has to be, or `getProgramInfoLog`
 * could not accept it — so this module types against DOM handles and casts at
 * the assignment, which is the one place the two disagree.
 */
interface ShaderErrorHost {
  debug: {
    checkShaderErrors: boolean;
    onShaderError: unknown;
  };
}

/**
 * Everything that has failed to link this session, newest last.
 *
 * The capture harness asserts this is empty. A screenshot cannot prove a
 * shader compiled — SwiftShader compiled the broken `SpeedFX` happily — so the
 * only honest check is to read the failures the driver actually reported.
 */
export const SHADER_FAILURES: ShaderFailure[] = [];

const listeners = new Set<(f: ShaderFailure) => void>();

/** Observe link failures. Replays anything already recorded. */
export function onShaderFailure(fn: (f: ShaderFailure) => void): () => void {
  listeners.add(fn);
  for (const f of SHADER_FAILURES) safely(fn, f);
  return () => listeners.delete(fn);
}

/**
 * Route three's shader link errors into `SHADER_FAILURES` and the listeners.
 *
 * Install this immediately after the renderer is created and before anything
 * compiles. It *replaces* three's own console reporting, which is why the
 * handler prints its own diagnostic — a silent guard would be strictly worse
 * than no guard. Returns an uninstall function.
 */
export function installShaderGuard(renderer: ShaderErrorHost): () => void {
  const previous = renderer.debug.onShaderError;

  const handler: ShaderErrorHandler = (gl, program, vs, fs): void => {
    let failure: ShaderFailure;
    try {
      failure = describe(gl, program, vs, fs);
    } catch {
      // Never let diagnostics throw inside three's compile path — that would
      // convert a recoverable bad pass into a hard boot failure.
      failure = { name: 'unknown', stage: 'link', log: '', excerpt: '' };
    }

    SHADER_FAILURES.push(failure);
    console.error(
      `[shader] ${failure.name} failed to compile (${failure.stage})\n` +
        `${failure.log}\n${failure.excerpt}`,
    );
    for (const fn of listeners) safely(fn, failure);
  };

  renderer.debug.onShaderError = handler;

  // Three skips the whole check — and therefore this handler — when it is off.
  renderer.debug.checkShaderErrors = true;

  if (typeof window !== 'undefined') {
    (window as unknown as { __locoShaderFailures?: ShaderFailure[] }).__locoShaderFailures =
      SHADER_FAILURES;
  }

  return () => {
    renderer.debug.onShaderError = previous;
  };
}

function safely(fn: (f: ShaderFailure) => void, f: ShaderFailure): void {
  try {
    fn(f);
  } catch (err) {
    console.error('[shader] guard listener threw:', err);
  }
}

function describe(gl: GL, program: WebGLProgram, vs: WebGLShader, fs: WebGLShader): ShaderFailure {
  const vsLog = (gl.getShaderInfoLog(vs) ?? '').trim();
  const fsLog = (gl.getShaderInfoLog(fs) ?? '').trim();
  const vsOk = gl.getShaderParameter(vs, gl.COMPILE_STATUS) as boolean;
  const fsOk = gl.getShaderParameter(fs, gl.COMPILE_STATUS) as boolean;

  const stage: ShaderFailure['stage'] = !fsOk ? 'fragment' : !vsOk ? 'vertex' : 'link';
  const shader = stage === 'fragment' ? fs : vs;
  const log =
    stage === 'fragment'
      ? fsLog
      : stage === 'vertex'
        ? vsLog
        : (gl.getProgramInfoLog(program) ?? '').trim();

  const source = gl.getShaderSource(shader) ?? '';
  return { name: shaderName(source), stage, log, excerpt: excerpt(source, log) };
}

/**
 * Three prepends `#define SHADER_NAME <material.name>` to every program it
 * builds, so the material name is recoverable from the driver-side source even
 * though `onShaderError` is not handed the material itself.
 */
function shaderName(source: string): string {
  return /^\s*#define\s+SHADER_NAME\s+(\S+)/m.exec(source)?.[1] ?? 'unknown';
}

/** Pull `ERROR: 0:<line>` out of the info log and quote around it. */
function excerpt(source: string, log: string): string {
  const line = Number(/ERROR:\s*\d+:(\d+)/.exec(log)?.[1] ?? NaN);
  if (!Number.isFinite(line)) return '';
  const lines = source.split('\n');
  const from = Math.max(0, line - 4);
  const to = Math.min(lines.length, line + 3);
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    out.push(`${i + 1 === line ? '>' : ' '} ${String(i + 1).padStart(4)}  ${lines[i]}`);
  }
  return out.join('\n');
}
