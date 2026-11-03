import type { Image } from "./png.js";

export interface DiffResult {
  sizeMismatch: boolean;
  diffPixels: number;
  totalPixels: number;
  /** Fraction of pixels that differ (0..1). */
  ratio: number;
  /** Bounding box of the changed area, if any. */
  box?: { x: number; y: number; width: number; height: number };
  /** Red where different, dimmed original elsewhere. */
  image?: Image;
}

export interface DiffOptions {
  /** Per-channel difference (0..255) that counts as "different". Default 16. */
  threshold?: number;
}

export function diff(a: Image, b: Image, opts: DiffOptions = {}): DiffResult {
  const threshold = opts.threshold ?? 16;
  if (a.width !== b.width || a.height !== b.height) {
    return { sizeMismatch: true, diffPixels: a.width * a.height, totalPixels: a.width * a.height, ratio: 1 };
  }
  const total = a.width * a.height;
  const out = new Uint8Array(total * 4);
  let count = 0;
  let minX = a.width;
  let minY = a.height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs((a.data[o] as number) - (b.data[o] as number)),
      Math.abs((a.data[o + 1] as number) - (b.data[o + 1] as number)),
      Math.abs((a.data[o + 2] as number) - (b.data[o + 2] as number)),
    );
    if (d > threshold) {
      count++;
      const x = i % a.width;
      const y = (i / a.width) | 0;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      out[o] = 255;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 255;
    } else {
      out[o] = (a.data[o] as number) >> 2;
      out[o + 1] = (a.data[o + 1] as number) >> 2;
      out[o + 2] = (a.data[o + 2] as number) >> 2;
      out[o + 3] = 255;
    }
  }
  return {
    sizeMismatch: false,
    diffPixels: count,
    totalPixels: total,
    ratio: total ? count / total : 0,
    ...(count ? { box: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } } : {}),
    image: { width: a.width, height: a.height, data: out },
  };
}

export interface BlankResult {
  blank: boolean;
  /** Share of pixels with the most common color (0..1). */
  dominant: number;
}

/** A picture where (almost) every pixel has the same color: nothing was drawn. */
export function blankness(img: Image, minDominant = 0.995): BlankResult {
  const counts = new Map<number, number>();
  const total = img.width * img.height;
  const step = Math.max(1, Math.floor(total / 50_000));
  let seen = 0;
  let best = 0;
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    // quantize a little so noise and dithering do not hide a blank frame
    const key = ((img.data[o] as number) >> 3) * 1024 + ((img.data[o + 1] as number) >> 3) * 32 + ((img.data[o + 2] as number) >> 3);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > best) best = n;
    seen++;
  }
  const dominant = seen ? best / seen : 1;
  return { blank: dominant >= minDominant, dominant };
}
