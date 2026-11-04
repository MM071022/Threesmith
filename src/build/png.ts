/** A PNG writer for the texture maps of built models: filtered rows, so procedural noise compresses well. */
import { crc32, deflateSync } from "node:zlib";

/** Pixels that do not make a PNG of the given size. */
export class PngError extends Error {}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * An 8-bit RGB (3 channels) or RGBA (4 channels) PNG. Each row gets the filter that leaves the smallest numbers,
 * which compresses noise much better.
 */
export function encodePng(width: number, height: number, pixels: Uint8Array, channels: 3 | 4 = 3): Buffer {
  const stride = width * channels;
  if (pixels.length < stride * height) throw new PngError(`expected ${stride * height} bytes for ${width}x${height}, got ${pixels.length}`);
  const raw = Buffer.alloc((stride + 1) * height);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  const trial = new Uint8Array(stride);
  const filtered = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    cur.set(pixels.subarray(y * stride, (y + 1) * stride));
    let best = -1, bestCost = Infinity;
    for (let f = 0; f <= 4; f++) {
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? (cur[i - channels] as number) : 0, b = prev[i] as number, c = i >= channels ? (prev[i - channels] as number) : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const value = ((cur[i] as number) - pred) & 0xff;
        trial[i] = value;
        cost += value < 128 ? value : 256 - value;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = f;
        filtered.set(trial);
      }
    }
    raw[y * (stride + 1)] = best;
    raw.set(filtered, y * (stride + 1) + 1);
    prev.set(cur);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}
