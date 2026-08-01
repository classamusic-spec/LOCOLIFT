/**
 * A very small PNG reader, just enough to answer "is this screenshot black?".
 *
 * A headless SwiftShader run will happily produce a perfectly valid, perfectly
 * black frame when a shader fails to link or the camera ends up inside
 * geometry, and the log says nothing at all. Any harness that claims a frame
 * was drawn has to actually look at the pixels, so this decodes the screenshot
 * Chromium hands back: 8-bit, non-interlaced, colour type 2 (RGB) or 6 (RGBA),
 * which is all `page.screenshot()` ever emits.
 */
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunks(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  const out = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    out.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len; // length + type + data + crc
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode to `{ width, height, channels, pixels }` with 8-bit samples. */
export function decode(buf) {
  const cs = chunks(buf);
  const ihdr = cs.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('no IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error(`unsupported colour type ${colorType}`);

  const idat = Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = zlib.inflateSync(idat);

  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = src;
    src += stride;
    const out = y * stride;
    const prev = out - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[row + x];
      const a = x >= channels ? pixels[out + x - channels] : 0;
      const b = y > 0 ? pixels[prev + x] : 0;
      const c = y > 0 && x >= channels ? pixels[prev + x - channels] : 0;
      let v;
      switch (filter) {
        case 0:
          v = cur;
          break;
        case 1:
          v = cur + a;
          break;
        case 2:
          v = cur + b;
          break;
        case 3:
          v = cur + ((a + b) >> 1);
          break;
        case 4:
          v = cur + paeth(a, b, c);
          break;
        default:
          throw new Error(`bad filter ${filter}`);
      }
      pixels[out + x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/**
 * Mean luma (0–255) and the fraction of pixels that are not near-black.
 * A game frame that rendered sits well above both floors; a black screen or a
 * flat clear colour does not.
 */
export function brightness(buf) {
  const { width, height, channels, pixels } = decode(buf);
  let sum = 0;
  let lit = 0;
  let n = 0;
  // every 4th pixel in each direction is plenty and keeps this instant
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const i = y * width * channels + x * channels;
      const l = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
      sum += l;
      if (l > 24) lit++;
      n++;
    }
  }
  return { mean: n > 0 ? sum / n : 0, nonBlack: n > 0 ? lit / n : 0, width, height };
}

export const PNG = { decode, brightness };
export default PNG;
