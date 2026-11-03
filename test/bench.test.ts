import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { project, THREE_DIR } from "./helpers.js";

describe.skipIf(!existsSync("dist/index.js"))("bench grader", () => {
  it("passes modern code and fails legacy code on a task", async () => {
    // @ts-expect-error plain .mjs without types
    const { grade } = await import("../bench/grade.mjs");
    const good = await grade("cleanup", project({ "main.js": readFileSync("test/fixtures/modern.js", "utf8") }), { three: THREE_DIR });
    expect(good.pass).toBe(true);
    const bad = await grade("cleanup", project({ "main.js": readFileSync("test/fixtures/legacy.js", "utf8") }), { three: THREE_DIR });
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(" ")).toContain("unknown-symbol");
  });
});
