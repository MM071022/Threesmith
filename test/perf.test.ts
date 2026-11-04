import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { formatPerf, perf, stats, summarize } from "../src/check/perf.js";
import type { FrameRecord } from "../src/check/runtime.js";
import { gamePage } from "./run-helpers.js";

const have = !!findChromium();

const frame = (dt: number, o: Partial<{ cpu: number; calls: number; tris: number; programs: number; geometries: number; textures: number }> = {}): FrameRecord => [dt, o.cpu ?? 1, o.calls ?? 10, o.tris ?? 1000, o.programs ?? 2, o.geometries ?? 5, o.textures ?? 1];

describe("perf numbers", () => {
  it("computes percentiles", () => {
    expect(stats([])).toEqual({ p50: 0, p95: 0, p99: 0, max: 0, mean: 0 });
    const s = stats(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s).toEqual({ p50: 50, p95: 95, p99: 99, max: 100, mean: 50.5 });
  });

  it("names why the slowest frames were slow, checks budgets and compares with the last run", () => {
    const frames = [...Array.from({ length: 50 }, () => frame(16.7)), frame(80, { programs: 4, geometries: 9 }), frame(16.7, { programs: 4, geometries: 9 }), frame(40, { cpu: 30, programs: 4, geometries: 9 }), frame(16.7, { calls: 60, programs: 4, geometries: 9 })];
    const r = summarize(frames, { budget: { frameMs: 20, calls: 50 } });
    expect(r.slowest[0]).toMatchObject({ frame: 50, ms: 80 });
    expect(r.slowest[0]!.cause).toContain("2 shader program(s) compiled");
    expect(r.slowest[0]!.cause).toContain("uploaded 4 geometries");
    expect(r.slowest[1]!.cause).toContain("30 ms of JS");
    expect(r.calls.max).toBe(60);
    expect(r.budgets).toEqual([
      { metric: "frameMs", limit: 20, actual: 16.7, ok: true },
      { metric: "calls", limit: 50, actual: 60, ok: false },
    ]);
    expect(r.verdict).toBe("over budget");
    const again = summarize(frames.map((f) => [f[0] * 2, f[1], f[2] * 2, f[3], f[4], f[5], f[6]] as FrameRecord), { previous: r });
    expect(again.delta?.frameP95).toBe(16.7);
    expect(again.delta?.calls).toBeGreaterThan(9);
    expect(again.regressed).toBe(true);
    expect(again.verdict).toBe("worse than before");
  });
});

describe.skipIf(!have)("perf (needs Chromium)", () => {
  it("measures a page, catches a shader compile spike and compares the second run", async () => {
    const dir = gamePage();
    const written: Record<string, string> = {};
    const write = (p: string, d: string) => void (written[p] = d);
    const r = await perf({
      target: dir,
      wait: 300,
      seconds: 1.5,
      warmupMs: 200,
      steps: [{ type: "eval", js: "setTimeout(() => { const p = $('player'); for (let i = 0; i < 30; i++) { const m = p.clone(); m.material = new p.material.constructor({ color: 0xff0000, roughness: 0.3, flatShading: true }); m.geometry = p.geometry.clone(); m.position.x = i * 0.1; scene.add(m); } }, 700)" }],
      budget: { calls: 5 },
      write,
    });
    const text = formatPerf(r);
    expect(r.frames, text).toBeGreaterThan(20);
    expect(r.calls.max).toBeGreaterThanOrEqual(32);
    expect(r.budgets[0]!.ok).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.geometries).toBeGreaterThanOrEqual(32);
    expect(r.slowest.some((f) => /shader program|uploaded/.test(f.cause)), text).toBe(true);
    expect(r.file).toMatch(/\.threesmith[/\\]perf[/\\]index\.json$/);
    expect(Object.keys(written)).toEqual([r.file]);
    expect(text).toContain("SwiftShader");
    expect(text).toContain("no earlier run with this name");
  }, 60_000);

  it("compares with the last saved run", async () => {
    const dir = gamePage();
    const first = await perf({ target: dir, wait: 200, seconds: 0.7, warmupMs: 100 });
    expect(first.ok).toBe(true);
    expect(first.saved).toBe(true);
    const second = await perf({ target: dir, wait: 200, seconds: 0.7, warmupMs: 100 });
    expect(second.previous?.frames).toBe(first.frames);
    expect(second.delta?.calls).toBe(0);
    expect(formatPerf(second)).toMatch(/vs last run .*calls 0/);
  }, 60_000);
});
