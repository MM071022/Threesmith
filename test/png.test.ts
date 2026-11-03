import { describe, expect, it } from "vitest";
import { blankness, diff } from "../src/check/diff.js";
import { decodePng, encodePng, type Image } from "../src/check/png.js";

function solid(w: number, h: number, rgb: [number, number, number]): Image {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
}

describe("png", () => {
  it("round-trips", () => {
    const img = solid(7, 5, [10, 200, 30]);
    img.data.set([1, 2, 3, 255], 8);
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(7);
    expect(back.height).toBe(5);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });
  it("rejects non-PNG", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow();
  });
});

describe("diff", () => {
  it("finds changed area", () => {
    const a = solid(10, 10, [0, 0, 0]);
    const b = solid(10, 10, [0, 0, 0]);
    for (let y = 2; y < 4; y++) for (let x = 3; x < 6; x++) b.data.set([255, 255, 255, 255], (y * 10 + x) * 4);
    const d = diff(a, b);
    expect(d.diffPixels).toBe(6);
    expect(d.box).toEqual({ x: 3, y: 2, width: 3, height: 2 });
    expect(diff(a, a).diffPixels).toBe(0);
  });
  it("tolerates tiny colour noise", () => {
    expect(diff(solid(4, 4, [100, 100, 100]), solid(4, 4, [105, 100, 100])).diffPixels).toBe(0);
  });
  it("reports size mismatch", () => {
    expect(diff(solid(4, 4, [0, 0, 0]), solid(5, 4, [0, 0, 0])).sizeMismatch).toBe(true);
  });
  it("detects blank frames", () => {
    expect(blankness(solid(50, 50, [20, 20, 20])).blank).toBe(true);
    const img = solid(50, 50, [20, 20, 20]);
    for (let i = 0; i < 1000; i++) img.data.set([255, 0, 0, 255], i * 4);
    expect(blankness(img).blank).toBe(false);
  });
});
