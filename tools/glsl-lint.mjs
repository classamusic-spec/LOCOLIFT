#!/usr/bin/env node
/**
 * Loco Lift — static GLSL lint.
 *
 * Catches the one class of shader bug that no test in this repo could see: a
 * local, uniform or varying whose name collides with a GLSL builtin function.
 * The declaration hides the builtin for the rest of the scope, so a later call
 * to it fails to parse.
 *
 * `LocoSpeedFX` shipped with `vec2 step` at the top of `main()` and
 * `step( 0.55, seed )` forty lines below. SwiftShader — the software
 * rasteriser behind headless Chromium, so behind every screenshot this repo
 * has ever taken — accepted it. Real drivers rejected the program:
 *
 *   ERROR: 0:188: 'step' : function name expected
 *
 * That pass sits mid-chain, so nothing downstream of it received scene colour
 * and the game rendered its HUD over a black viewport on every real GPU while
 * every capture looked correct.
 *
 * Typechecking cannot see inside a template literal and screenshots come from
 * a compiler that does not care, so this runs as part of `npm run build`.
 *
 *   node tools/glsl-lint.mjs [--quiet]
 *
 * Exit code 1 on any finding.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

/** GLSL ES 1.00 and 3.00 builtin functions. */
const BUILTINS = new Set(
  `radians degrees sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh
   pow exp log exp2 log2 sqrt inversesqrt
   abs sign floor trunc round roundEven ceil fract mod modf min max clamp mix step smoothstep
   isnan isinf floatBitsToInt floatBitsToUint intBitsToFloat uintBitsToFloat
   frexp ldexp fma
   packSnorm2x16 unpackSnorm2x16 packUnorm2x16 unpackUnorm2x16 packHalf2x16 unpackHalf2x16
   length distance dot cross normalize faceforward reflect refract
   matrixCompMult outerProduct transpose determinant inverse
   lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual any all not
   texture texture2D texture2DProj texture2DLod texture2DProjLod
   textureCube textureCubeLod textureSize texelFetch texelFetchOffset
   textureProj textureLod textureOffset textureProjLod textureProjOffset
   textureLodOffset textureProjLodOffset textureGrad textureGradOffset
   textureProjGrad textureProjGradOffset
   dFdx dFdy fwidth`
    .trim()
    .split(/\s+/),
);

const TYPE =
  '(?:float|int|uint|bool|void' +
  '|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|bvec2|bvec3|bvec4' +
  '|mat2|mat3|mat4|mat2x2|mat2x3|mat2x4|mat3x2|mat3x3|mat3x4|mat4x2|mat4x3|mat4x4' +
  '|sampler2D|samplerCube|sampler2DArray|sampler3D|sampler2DShadow)';

const QUALIFIER = '(?:const|uniform|varying|attribute|in|out|inout|highp|mediump|lowp|flat|smooth)';

/**
 * A declaration is a type followed by an identifier followed by `=`, `;`, `,`,
 * `)` or `[`. Requiring one of those terminators is what keeps ordinary calls
 * like `float x = step(a, b)` from matching — there, `step` is followed by `(`
 * with no type in front of it.
 */
const DECL = new RegExp(`\\b(?:${QUALIFIER}\\s+)*${TYPE}\\s+([A-Za-z_]\\w*)\\s*(?=[=;,)\\[])`, 'g');

/** Only look inside strings that are plausibly GLSL. */
const LOOKS_LIKE_GLSL = /\b(?:gl_FragColor|gl_Position|void\s+main\s*\(|varying|uniform\s+\w)/;

const roots = ['src'];
const files = [];
for (const root of roots) walk(root);

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (extname(p) === '.ts' || extname(p) === '.glsl') files.push(p);
  }
}

const findings = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (extname(file) === '.ts' && !LOOKS_LIKE_GLSL.test(src)) continue;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    DECL.lastIndex = 0;
    let m;
    while ((m = DECL.exec(line)) !== null) {
      if (BUILTINS.has(m[1])) {
        findings.push({ file, line: i + 1, name: m[1], text: line.trim() });
      }
    }
  }
}

const quiet = process.argv.includes('--quiet');
if (findings.length === 0) {
  if (!quiet) console.log(`glsl-lint: OK — ${files.length} files, no builtin shadowing`);
  process.exit(0);
}

for (const f of findings) {
  console.error(`${f.file}:${f.line}  declares '${f.name}', hiding the GLSL builtin of that name`);
  console.error(`    ${f.text}`);
}
console.error(
  `\nglsl-lint: ${findings.length} finding(s). Rename each one.\n` +
    `A variable named after a builtin hides it for the rest of the scope; the\n` +
    `program then fails to link on real drivers while SwiftShader accepts it,\n` +
    `so captures stay green and players get a black screen.`,
);
process.exit(1);
