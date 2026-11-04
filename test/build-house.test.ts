import { describe, expect, it, vi } from "vitest";
import { buildGlb } from "../src/build/glb.js";
import { buildKind, GENERATORS, generatorFor } from "../src/build/generators/index.js";
import { resolveParams, random } from "../src/build/params.js";
import { contractFromModel } from "../src/model/contract.js";
import { inspectModel } from "../src/model/inspect.js";
import { lintModelFile } from "../src/model/lint.js";
import { buildModel, formatKinds, lintModelFile as lintAs } from "../src/model/index.js";
import { sha, writeScene } from "./build-helpers.js";

// Building and linting the detailed ready-made models takes a few seconds on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

const house = (input: Record<string, unknown> = {}) => writeScene(buildKind("house", input));

describe("house", () => {
  it("builds a clean house with the default parameters", () => {
    const path = house();
    const report = lintModelFile(path);
    expect(report.findings.filter((f) => f.severity !== "info")).toEqual([]);
    expect(report.overall).toBeGreaterThanOrEqual(95);
    const info = inspectModel(path);
    expect(info.nodes.map((n) => n.path)).toEqual(["House", "House/Walls", "House/Roof", "House/Windows", "House/Doorway", "House/Door", "House/Chimney"]);
    expect(info.bounds?.min[1]).toBeCloseTo(0);
  });

  it("has the size the parameters ask for", () => {
    const info = inspectModel(house({ width: 10, depth: 7, floors: 3, floorHeight: 3, roofRise: 2, overhang: 0.5, chimney: false }));
    expect(info.bounds?.size[0]).toBeCloseTo(11);
    expect(info.bounds?.size[2]).toBeCloseTo(8);
    expect(info.bounds?.size[1]).toBeCloseTo(3 * 3 + 2);
    expect(info.nodes.some((n) => n.name === "Chimney")).toBe(false);
  });

  it("builds every roof shape and a one-floor house without findings", () => {
    for (const input of [{ roof: "flat" }, { roof: "hip" }, { roof: "hip", width: 8, depth: 8 }, { floors: 1, windowsPerFloor: 0, windowsPerSide: 0 }, { width: 14, depth: 6 }]) {
      const report = lintModelFile(house(input));
      expect(report.findings.filter((f) => f.severity !== "info"), JSON.stringify(input)).toEqual([]);
    }
  });

  it("is deterministic, and the seed changes only the colours", () => {
    const a = buildGlb(buildKind("house", { seed: 7 }));
    expect(sha(a)).toBe(sha(buildGlb(buildKind("house", { seed: 7 }))));
    const sizeOf = (seed: number) => inspectModel(house({ seed })).bounds?.size;
    expect(sizeOf(1)).toEqual(sizeOf(2));
    const colours = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => sha(buildGlb(buildKind("house", { seed })))));
    expect(colours.size).toBeGreaterThan(1);
  });

  it("keeps the windows off the door and inside the walls", () => {
    const info = inspectModel(house({ floors: 1, windowsPerFloor: 3 }));
    const windows = info.primitives.filter((p) => p.nodeName === "House/Windows");
    expect(windows.length).toBe(2);
    expect(windows[0]!.triangles).toBeGreaterThan(0);
  });

  it("refuses more windows than a wall holds, and names the limit", () => {
    expect(() => buildKind("house", { width: 3, windowsPerFloor: 12 })).toThrow(/windowsPerFloor 12 does not fit on a 3 m wall \(at most 1\)/);
    expect(() => buildKind("house", { depth: 4, windowsPerSide: 3 })).toThrow(/windowsPerSide 3 does not fit on a 4 m wall \(at most 2\)/);
  });

  it("builds the most windows a wall holds without findings", () => {
    for (const input of [{ width: 9, windowsPerFloor: 5 }, { depth: 10.8, windowsPerSide: 6 }, { width: 3, windowsPerFloor: 1 }]) {
      const report = lintModelFile(house(input));
      expect(report.findings.filter((f) => f.severity !== "info"), JSON.stringify(input)).toEqual([]);
    }
  });

  it("writes a contract that the model passes", () => {
    const path = house();
    const contract = contractFromModel(inspectModel(path));
    expect(lintModelFile(path, { contract }).findings.filter((f) => f.rule.startsWith("model/contract"))).toEqual([]);
  });
});

describe("parameters", () => {
  const defs = GENERATORS["house"]!.params;
  it("rejects unknown names, bad values and out-of-range numbers with a clear message", () => {
    expect(() => buildKind("house", { colour: "red" })).toThrow(/unknown parameter "colour"/);
    expect(() => buildKind("house", { roof: "dome" })).toThrow(/must be one of flat, gable, hip/);
    expect(() => buildKind("house", { floors: 0 })).toThrow(/at least 1/);
    expect(() => buildKind("house", { floors: 2.5 })).toThrow(/whole number/);
    expect(() => buildKind("house", { width: "wide" })).toThrow(/must be a number/);
    expect(() => buildKind("house", { chimney: "maybe" })).toThrow(/true or false/);
    expect(() => buildKind("starfighter")).toThrow(/unknown model kind "starfighter"/);
  });

  it("does not take the names of Object.prototype for kinds", () => {
    for (const kind of ["constructor", "toString", "__proto__"]) {
      expect(() => buildKind(kind), kind).toThrow(/unknown model kind/);
      expect(() => generatorFor(kind), kind).toThrow(/unknown model kind/);
    }
  });

  it("converts strings from the command line", () => {
    expect(resolveParams(defs, { floors: "3", chimney: "false", roof: "hip", width: "9.5" }, "house")).toMatchObject({ floors: 3, chimney: false, roof: "hip", width: 9.5 });
  });

  it("gives the same random numbers for the same seed", () => {
    const a = random(5), b = random(5);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("model build and model kinds", () => {
  it("lists the kinds with their parameters", () => {
    const text = formatKinds();
    expect(text).toContain("house:");
    expect(text).toContain("roof = gable (flat|gable|hip)");
  });

  it("builds in memory, gives a summary and a contract the model keeps", () => {
    const built = buildModel({ kind: "house", params: { floors: "3", roof: "hip" } });
    expect(built.summary).toMatch(/built house\.glb: .* triangles, 7 nodes, .* lint (9\d|100)\/100/);
    const lint = lintAs(built.glb, { contract: built.contract });
    expect(lint.failed).toBe(false);
    expect(lint.report.overall).toBeGreaterThanOrEqual(95);
  });

  it("reports a bad parameter", () => {
    expect(() => buildModel({ kind: "house", params: { floors: "0" } })).toThrow(/floors/);
  });
});
