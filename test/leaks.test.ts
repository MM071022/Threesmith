import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { formatLeaks, judgeLeaks, leaks, trend } from "../src/check/leaks.js";
import type { MemorySnapshot } from "../src/check/runtime.js";
import type { PlayStep } from "../src/check/steps.js";
import { gamePage } from "./run-helpers.js";

const have = !!findChromium();

const snap = (n: number, o: Partial<MemorySnapshot> = {}): MemorySnapshot => ({ geometries: 3 + n, textures: 1, programs: 2, objects: 5, scenes: 1, byType: { Mesh: 3 }, undisposed: { BoxGeometry: n }, unreachable: 0, ...o });

describe("leak trends", () => {
  it("calls steady growth a leak, a cache that filled once not", () => {
    expect(trend([1, 2, 3, 4])).toMatchObject({ perCycle: 1, growing: true });
    expect(trend([5, 5, 5])).toMatchObject({ perCycle: 0, growing: false });
    expect(trend([3, 4, 3, 4])).toMatchObject({ growing: false });
    expect(trend([7])).toMatchObject({ growing: false });
  });

  it("names what grows and why", () => {
    const r = judgeLeaks([snap(0), snap(5), snap(7), snap(9), snap(11)], { warmupCycles: 1 });
    expect(r.metrics.geometries).toMatchObject({ perCycle: 2, growing: true, values: [10, 12, 14] });
    expect(r.growing).toEqual([{ kind: "undisposed", type: "BoxGeometry", perCycle: 2, last: 11 }]);
    expect(r.over).toEqual([{ metric: "geometries", perCycle: 2, budget: 0 }, { metric: "undisposed", perCycle: 2, budget: 0 }]);
    expect(r.verdict).toBe("leaking");
    expect(r.hints[0]).toMatch(/dispose\(\)/);
    expect(judgeLeaks([snap(0), snap(5), snap(7), snap(9), snap(11)], { budget: { geometries: 3, undisposed: 2 } }).verdict).toBe("ok");
    expect(judgeLeaks([snap(1), snap(1), snap(1), snap(1)]).verdict).toBe("ok");
  });
});

const cycle: PlayStep[] = [{ type: "eval", js: "app.load()" }, { type: "frames", n: 3 }, { type: "eval", js: "app.unload()" }];
const game = readFileSync(join(import.meta.dirname, "fixtures", "run", "game.js"), "utf8");

describe.skipIf(!have)("leaks (needs Chromium)", () => {
  it("finds geometries and materials that are never disposed, by type", async () => {
    const r = await leaks({ target: gamePage(`window.LEAK = true;\n${game}`), wait: 200, cycle, cycles: 4 });
    const text = formatLeaks(r);
    expect(r.completed).toBe(4);
    expect(r.verdict, text).toBe("leaking");
    expect(r.metrics.geometries?.perCycle).toBe(3);
    expect(r.metrics.objects?.growing).toBe(false);
    expect(r.growing.find((g) => g.type === "SphereGeometry")).toMatchObject({ kind: "undisposed", perCycle: 3 });
    expect(r.growing.find((g) => g.type === "MeshBasicMaterial")).toMatchObject({ perCycle: 3 });
    expect(r.metrics.heapKb).toBeDefined();
    expect(r.ok).toBe(false);
    expect(text).toContain("+3/cycle SphereGeometry");
    expect(text).toMatch(/fix: Objects leave the scene/);
  }, 60_000);

  it("passes when unload disposes, and reports a failing cycle step", async () => {
    const clean = await leaks({ target: gamePage(), wait: 200, cycle, cycles: 4 });
    expect(clean.verdict, formatLeaks(clean)).toBe("ok");
    expect(clean.ok).toBe(true);
    expect(clean.metrics.undisposed?.growing).toBe(false);
    const broken = await leaks({ target: gamePage(), wait: 200, cycle: [{ type: "eval", js: "app.reload()" }], cycles: 3 });
    expect(broken.completed).toBe(0);
    expect(broken.failed[0]?.error).toMatch(/app\.reload is not a function/);
    expect(broken.ok).toBe(false);
  }, 60_000);
});
