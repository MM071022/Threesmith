import { describe, expect, it } from "vitest";
import { review } from "../src/review/review.js";
import { checkAssets } from "../src/scan/assets.js";
import { collect } from "../src/review/source.js";
import { triage } from "../src/doctor/triage.js";

// The site (docs/index.html) shows these two examples: keep what it says about them true.
describe("examples shown on the site", () => {
  it("agent-mistakes: 3 review errors, 2 asset paths that 404, the doctor's groups", () => {
    const dir = "examples/agent-mistakes";
    const r = review({ path: dir });
    expect(r.counts.error).toBe(3);
    const a = checkAssets(dir, collect(dir).files);
    expect(a.problems.filter((p) => p.severity === "error").map((p) => p.kind).sort()).toEqual(["case", "missing"]);
    const t = triage(dir);
    expect(t.groups.map((g) => g.id)).toEqual(expect.arrayContaining(["blank", "assets", "api"]));
  });

  it("agent-mistakes-fixed: 100/100 and every asset found", () => {
    const dir = "examples/agent-mistakes-fixed";
    const r = review({ path: dir });
    expect(r.score).toBe(100);
    expect(r.findings).toEqual([]);
    expect(checkAssets(dir, collect(dir).files).problems).toEqual([]);
  });
});
