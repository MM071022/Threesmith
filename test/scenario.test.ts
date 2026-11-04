import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import type { PlayOptions, PlayResult } from "../src/check/play.js";
import { formatJunit, formatScenarios, loadScenarios, parseScenario, runScenarios, saveScenario, ScenarioError, scenarioFromPlay } from "../src/check/scenario.js";
import { project } from "./helpers.js";
import { gamePage } from "./run-helpers.js";

const have = !!findChromium();

const fakeRun = (ok: boolean): PlayResult => ({
  ok,
  url: "http://x/index.html",
  steps: [],
  watch: [],
  claims: [
    { text: "a > 1 @ end", js: "a > 1", at: "end", ok: true, message: "held (a was 2)" },
    { text: "any: b", js: "b", at: "any", ok, message: ok ? "first held" : "never held: b stayed false", ...(ok ? {} : { value: false }) },
  ],
  issues: ok ? [] : [{ kind: "page-error", severity: "error", message: "x is <undefined> & broken" }],
  stats: { ms: 10, frames: 1, threeRevision: "187", scene: true },
});

describe("scenarios", () => {
  it("makes a scenario file with relative paths and claim texts, and reads it back", () => {
    const dir = project({ "web/index.html": "" });
    const made = scenarioFromPlay(dir, "jump", { target: join(dir, "web"), steps: [{ type: "press", key: " " }], expect: ["any: x > 1", { js: "y", at: 2 }], watch: ["x"], wait: 200 });
    expect(made.file).toBe(".threesmith/scenarios/jump.json");
    expect(made.path).toBe(join(dir, ".threesmith", "scenarios", "jump.json"));
    expect(JSON.parse(made.json)).toEqual({ name: "jump", target: "web", wait: 200, steps: [{ type: "press", key: " " }], watch: ["x"], expect: ["any: x > 1", "y @ step 2"] });
    expect(() => scenarioFromPlay(dir, "bad name", { target: dir })).toThrow(ScenarioError);
    expect(() => scenarioFromPlay(dir, "out", { target: "/elsewhere", expect: ["x"] })).toThrow(/outside the project/);
    expect(() => parseScenario({ steps: [{ type: "fly" }], expect: ["x"] }, "s")).toThrow(/"steps": step 1: unknown step/);
    expect(() => parseScenario({ expect: [] }, "s")).toThrow(/at least one claim/);
  });

  it("saves only a passing run, through the given writer", async () => {
    const dir = project({ "index.html": "" });
    const writes: [string, string][] = [];
    const write = (p: string, d: string) => void writes.push([p, d]);
    const opts: PlayOptions = { target: dir, expect: ["a > 1 @ end", "any: b"] };
    const failed = await saveScenario(dir, "s1", opts, { write, play: async () => fakeRun(false) });
    expect(failed.saved).toBe(false);
    expect(writes).toEqual([]);
    let played: PlayOptions | undefined;
    const saved = await saveScenario(dir, "s1", opts, { write, play: async (o) => ((played = o), fakeRun(true)) });
    expect(saved.saved).toBe(true);
    expect(played?.target).toBe(dir);
    expect(played?.name).toBe("s1");
    expect(writes[0]![0]).toBe(saved.path);
    mkdirSync(join(dir, ".threesmith", "scenarios"), { recursive: true });
    writeFileSync(saved.path, writes[0]![1]);
    await expect(saveScenario(dir, "s1", opts, { write, play: async () => fakeRun(true) })).rejects.toThrow(/exists/);
    expect(loadScenarios(dir).map((s) => s.scenario.name)).toEqual(["s1"]);
    writeFileSync(join(dir, ".threesmith", "scenarios", "broken.json"), "{");
    expect(() => loadScenarios(dir)).toThrow(/broken\.json/);
  });

  it("runs scenarios and writes JUnit XML", async () => {
    const dir = project({ "index.html": "" });
    for (const name of ["a", "b"]) {
      const m = scenarioFromPlay(dir, name, { target: dir, expect: ["a > 1 @ end", "any: b"] });
      mkdirSync(join(dir, ".threesmith", "scenarios"), { recursive: true });
      writeFileSync(m.path, m.json);
    }
    const results = await runScenarios(dir, { play: async (o) => fakeRun(o.name === "a") });
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(formatScenarios(results)).toContain("1 of 2 scenarios passed");
    expect(formatScenarios(results)).toContain("FAIL any: b  -> never held: b stayed false");
    const xml = formatJunit(results);
    expect(xml).toContain('<testsuites name="threesmith" tests="5" failures="1" errors="1"');
    expect(xml).toContain('<testsuite name="scenario.b" tests="3" failures="1" errors="1"');
    expect(xml).toContain("x is &lt;undefined&gt; &amp; broken");
    expect((await runScenarios(dir, { name: "a", play: async () => fakeRun(true) })).map((r) => r.name)).toEqual(["a"]);
  });
});

describe.skipIf(!have)("scenario round trip (needs Chromium)", () => {
  it("saves a passing play run and runs it again", async () => {
    const dir = gamePage();
    const opts: PlayOptions = { target: dir, wait: 200, steps: [{ type: "click", selector: "#hide" }], expect: ["$('box').visible === false @ end", "always: $('player').position.y === 0"] };
    const saved = await saveScenario(dir, "hide-box", opts);
    expect(saved.saved, JSON.stringify(saved.result.claims)).toBe(true);
    expect(JSON.parse(readFileSync(saved.path, "utf8")).target).toBeUndefined();
    const [r] = await runScenarios(dir);
    expect(r!.ok).toBe(true);
    expect(r!.screenshot).toMatch(/play-hide-box\.png$/);
  }, 60_000);
});
