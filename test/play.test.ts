import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { claimSubject, formatPlay, parseClaim, play } from "../src/check/play.js";
import { parsePlaySteps } from "../src/check/steps.js";
import { gamePage } from "./run-helpers.js";

const have = !!findChromium();

describe("claims and steps parsing", () => {
  it("reads claims in every form", () => {
    expect(parseClaim("$('p').position.y > 1 @ end")).toEqual({ js: "$('p').position.y > 1", at: "end" });
    expect(parseClaim("any: $('box').visible === false")).toEqual({ js: "$('box').visible === false", at: "any" });
    expect(parseClaim("always: info.render.calls < 200")).toEqual({ js: "info.render.calls < 200", at: "always" });
    expect(parseClaim("x == 2 @ step 3")).toEqual({ js: "x == 2", at: 3 });
    expect(parseClaim("x")).toEqual({ js: "x", at: "end" });
    expect(parseClaim({ js: "y", at: "any" })).toEqual({ js: "y", at: "any" });
    expect(() => parseClaim({ js: "y", at: "sometimes" as never })).toThrow(/at must be/);
  });

  it("finds the subject of a single comparison only", () => {
    expect(claimSubject("$('p').position.y > 1")).toBe("$('p').position.y");
    expect(claimSubject("$('a>b').visible === false")).toBe("$('a>b').visible");
    expect(claimSubject("a.b(x => x > 1)")).toBeUndefined();
    expect(claimSubject("a > 1 && b < 2")).toBeUndefined();
    expect(claimSubject("ok")).toBeUndefined();
  });

  it("checks the new step types", () => {
    expect(parsePlaySteps('[{"type":"frames","n":3},{"type":"hold","key":"a","ms":10},{"type":"eval","js":"1"},{"type":"until","js":"true"}]')).toHaveLength(4);
    expect(() => parsePlaySteps('[{"type":"eval","code":"1"}]')).toThrow(/"js" must be a string/);
    expect(() => parsePlaySteps('[{"type":"fly"}]')).toThrow(/unknown step/);
    expect(() => parsePlaySteps('[{"type":"click"}]')).toThrow(/selector/);
  });
});

describe.skipIf(!have)("play (needs Chromium)", () => {
  it("runs steps, samples watches and checks claims with values and frames", async () => {
    const r = await play({
      target: gamePage(),
      wait: 300,
      steps: [
        { type: "press", key: " " },
        { type: "frames", n: 10 },
        { type: "hold", key: "ArrowRight", ms: 300 },
        { type: "click", selector: "#hide" },
        { type: "until", js: "$('player').position.y === 0", timeout: 3000 },
        { type: "eval", js: "$('player').position.x > 0.5" },
      ],
      watch: ["$('player').position.y", "$('player').position", "$('box').visible", "nope.x"],
      expect: [
        "any: $('player').position.y > 0.5",
        "$('box').visible === false @ end",
        "always: info.render.calls < 10",
        "$('player').position.x > 0.5",
        "$('box').visible === true @ step 1",
        "any: $('player').position.y > 50",
        "always: $('box').visible",
      ],
    });
    const text = formatPlay(r);
    expect(r.steps.map((s) => s.ok)).toEqual([true, true, true, true, true, true]);
    expect(r.steps[5]!.value).toBe(true);
    const y = r.watch[0]!;
    expect(y.series.length).toBeGreaterThan(2);
    expect(y.max).toBeGreaterThan(0.5);
    expect(r.watch[1]!.end).toHaveLength(3);
    expect(r.watch[2]!.series.map((s) => s.v)).toEqual([true, false]);
    expect(r.watch[3]!.error).toMatch(/nope/);
    const [jump, hidden, calls, walked, before, high, always] = r.claims;
    expect(jump!.ok).toBe(true);
    expect(jump!.frame).toBeGreaterThan(0);
    expect(hidden!.ok).toBe(true);
    expect(calls!.ok).toBe(true);
    expect(walked!.ok).toBe(true);
    expect(before!.ok).toBe(true);
    expect(high!.ok).toBe(false);
    expect(high!.message).toMatch(/never held: \$\('player'\)\.position\.y moved between 0 and/);
    expect(always!.ok).toBe(false);
    expect(always!.step).toBe(4);
    expect(always!.message).toMatch(/(during|after) step 4/);
    expect(r.ok).toBe(false);
    expect(r.screenshot).toMatch(/play\.png$/);
    expect(text).toContain("claims: 2 of 7 FAILED");
    expect(text).toContain("$('box').visible: true @");
  }, 60_000);

  it("reports a failing until step and page errors", async () => {
    const r = await play({ target: gamePage(undefined, {}), wait: 200, steps: [{ type: "until", js: "$('player').position.y > 99", timeout: 300 }, { type: "eval", js: "boom()" }], expect: ["$('player') !== undefined"] });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.error).toMatch(/still not true after 300 ms \(last value false\)/);
    expect(r.issues.map((i) => i.kind)).toContain("step-failed");
    expect(r.claims[0]!.ok).toBe(true);
    expect(r.ok).toBe(false);
  }, 60_000);
});
