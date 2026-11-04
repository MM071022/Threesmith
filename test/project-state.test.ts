import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatUndo, readJournal, undoJournal, writeFiles } from "../src/project/journal.js";
import { assertWritable, ProtectedPathError, resetProtect } from "../src/project/protect.js";
import { reviewDelta } from "../src/review/delta.js";
import { applyFeedback, fingerprint, readFeedback, recordFeedback } from "../src/learn/feedback.js";
import { project, reviewFiles } from "./helpers.js";

describe("journal and undo", () => {
  it("undoes a write, newest first, and removes files that were new", () => {
    const dir = project({ "package.json": "{}", "a.js": "old" });
    const id = writeFiles(dir, "test", "two files", [
      { file: "a.js", data: "new" },
      { file: "src/b.js", data: "made" },
    ]);
    expect(id).toBe(1);
    expect(readFileSync(join(dir, "a.js"), "utf8")).toBe("new");
    expect(readJournal(dir)[0]?.files.map((f) => f.file)).toEqual(["a.js", "src/b.js"]);
    expect(readFileSync(join(dir, ".threesmith/.gitignore"), "utf8")).toContain("journal/");
    const r = undoJournal(dir);
    expect(readFileSync(join(dir, "a.js"), "utf8")).toBe("old");
    expect(existsSync(join(dir, "src/b.js"))).toBe(false);
    expect(formatUndo(r)).toContain("restored a.js");
    expect(readJournal(dir)).toHaveLength(0);
  });

  it("leaves a file alone that was changed by hand after the write", () => {
    const dir = project({ "package.json": "{}", "a.js": "old" });
    writeFiles(dir, "test", "one", [{ file: "a.js", data: "new" }]);
    writeFileSync(join(dir, "a.js"), "hand");
    const r = undoJournal(dir);
    expect(readFileSync(join(dir, "a.js"), "utf8")).toBe("hand");
    expect(r.skipped[0]?.why).toContain("changed since");
  });

  it("refuses writes outside the project and into protected paths", () => {
    const dir = project({ "package.json": "{}", "threesmith.json": JSON.stringify({ protect: ["vendor", "public/*.glb"] }) });
    resetProtect();
    expect(() => writeFiles(dir, "t", "x", [{ file: "../x.js", data: "" }])).toThrow(/outside the project/);
    expect(() => writeFiles(dir, "t", "x", [{ file: "vendor/lib.js", data: "" }])).toThrow(ProtectedPathError);
    expect(() => assertWritable(dir, join(dir, "public/car.glb"))).toThrow(/protected by "public\/\*\.glb"/);
    expect(() => assertWritable(dir, join(dir, "public/models/car.glb"))).not.toThrow();
  });
});

describe("review delta", () => {
  it("splits new, open and fixed findings across reviews", () => {
    const dir = project({ "package.json": "{}", "a.js": "import * as THREE from 'three';\nconst g = new THREE.Geometry();\n" });
    const first = reviewDelta(dir, reviewFiles({ "a.js": "import * as THREE from 'three';\nconst g = new THREE.Geometry();\n" }));
    expect(first.first).toBe(true);
    const again = reviewDelta(dir, reviewFiles({ "a.js": "import * as THREE from 'three';\n\nconst g = new THREE.Geometry();\nconst b = new THREE.BoxBufferGeometry();\n" }));
    expect(again.first).toBe(false);
    expect(again.fresh.map((f) => f.rule)).toContain("buffer-geometry-alias");
    // moved one line down: still the same finding
    expect(again.open.map((f) => f.rule)).toContain("geometry-class");
  });
});

describe("feedback", () => {
  it("hides a finding marked wrong and rescores", () => {
    const code = "import * as THREE from 'three';\nconst g = new THREE.Geometry();\n";
    const r = reviewFiles({ "a.js": code });
    const f = r.findings.find((x) => x.rule === "geometry-class")!;
    expect(applyFeedback(r).learned.hidden).toBe(0);
    recordFeedback(f, "wrong");
    const after = applyFeedback(reviewFiles({ "b.js": code }));
    expect(after.review.findings.some((x) => x.rule === "geometry-class")).toBe(false);
    expect(after.learned.hidden).toBeGreaterThan(0);
    expect(after.review.score).toBeGreaterThanOrEqual(r.score ?? 0);
    // nothing but hashes and counters
    expect(JSON.stringify(readFeedback())).not.toContain("Geometry()");
    expect(fingerprint("x", "  a   b ")).toBe(fingerprint("x", "a b"));
    recordFeedback(f, "right");
    expect(applyFeedback(reviewFiles({ "c.js": code })).review.findings.some((x) => x.rule === "geometry-class")).toBe(true);
  });
});
