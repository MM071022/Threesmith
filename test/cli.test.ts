import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ci } from "../src/ci.js";
import { project, THREE_DIR } from "./helpers.js";

describe("ci receipt", () => {
  it("passes clean code and fails broken code", async () => {
    const good = await ci({ path: project({ "a.js": readFileSync("test/fixtures/modern.js", "utf8") }), three: THREE_DIR, minScore: 90 });
    expect(good.ok).toBe(true);
    expect(good.markdown).toContain("✅ pass");
    const bad = await ci({ path: project({ "a.js": readFileSync("test/fixtures/legacy.js", "utf8") }), three: THREE_DIR, minScore: 90 });
    expect(bad.ok).toBe(false);
    expect(bad.reasons.join(" ")).toContain("below the minimum");
    expect(bad.markdown).toContain("❌ fail");
  });
});

describe.skipIf(!existsSync("dist/cli.js"))("built cli", () => {
  it("prints version and exit codes", () => {
    expect(execFileSync("node", ["dist/cli.js", "--version"]).toString().trim()).toMatch(/^\d+\.\d+\.\d+/);
    const dir = project({ "a.js": "import * as THREE from 'three';\nnew THREE.Geometry();\n" });
    const r = spawnSync("node", ["dist/cli.js", "review", dir, "--three", THREE_DIR, "--fail-on", "error"]);
    expect(r.status).toBe(1);
    expect(r.stdout.toString()).toContain("geometry-class");
    const miss = spawnSync("node", ["dist/cli.js", "api", "Nope", "--three", THREE_DIR]);
    expect(miss.status).toBe(1);

    const badDisable = spawnSync("node", ["dist/cli.js", "review", dir, "--three", THREE_DIR, "--disable", "output-encodin"]);
    expect(badDisable.status).toBe(2);
    expect(badDisable.stderr.toString()).toContain('unknown rule "output-encodin" in --disable (did you mean output-encoding?)');

    const badFix = spawnSync("node", ["dist/cli.js", "fix", dir, "--only", "output-encodin"]);
    expect(badFix.status).toBe(2);
    expect(badFix.stderr.toString()).toContain('unknown rule "output-encodin" in --only (did you mean output-encoding?)');

    const disabled = spawnSync("node", ["dist/cli.js", "review", dir, "--three", THREE_DIR, "--disable", "geometry-class"]);
    expect(disabled.status).toBe(0);
    expect(disabled.stdout.toString()).not.toContain("geometry-class");

    // doctor and undo take the folder as an argument too, like review and scan
    const pos = spawnSync("node", ["dist/cli.js", "doctor", "examples/agent-mistakes", "--no-env"]).stdout.toString();
    expect(pos).toMatch(/^Threesmith doctor: \d+ error/);
    expect(spawnSync("node", ["dist/cli.js", "doctor", "--path", "examples/agent-mistakes", "--no-env"]).stdout.toString()).toBe(pos);
    expect(spawnSync("node", ["dist/cli.js", "undo", dir, "--list"]).stdout.toString()).toContain("No Threesmith writes");
  });
});
void join;
