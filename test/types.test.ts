import { describe, expect, it } from "vitest";
import { indexFor } from "../src/core.js";
import { checkTypes, explainTypeError, formatTypes, parseTsc, type Runner } from "../src/types/types.js";
import { project, THREE_DIR } from "./helpers.js";

const index = indexFor(".", THREE_DIR);
const out = [
  "src/main.ts(4,10): error TS2339: Property 'setPixelRatios' does not exist on type 'WebGLRenderer'.",
  "src/main.ts(1,10): error TS2305: Module '\"three\"' has no exported member 'OrbitControls'.",
  "src/main.ts(2,22): error TS2307: Cannot find module 'three/examples/js/controls/OrbitControls' or its corresponding type declarations.",
  "src/util.ts(9,3): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/main.ts(7,1): error TS2554: Expected 1-2 arguments, but got 0. Argument of type 'Vector3' ...",
].join("\n");

describe("type check", () => {
  it("parses tsc output in both formats", () => {
    const a = parseTsc(out, "/p");
    expect(a).toHaveLength(5);
    expect(a[0]).toMatchObject({ file: "src/main.ts", line: 4, col: 10, code: "TS2339" });
    const b = parseTsc("src/a.ts:3:7 - error TS2304: Cannot find name 'x'.", "/p");
    expect(b[0]).toMatchObject({ file: "src/a.ts", line: 3, code: "TS2304" });
  });

  it("answers three errors from the installed release", () => {
    const [prop, mod, missing, other, args] = parseTsc(out, "/p").map((e) => explainTypeError(e, index));
    expect(prop?.three).toBe(true);
    expect(prop?.hint).toContain("`setPixelRatio`");
    expect(mod?.hint).toContain("three/addons/controls/OrbitControls.js");
    expect(missing?.hint).toContain("examples/js was removed");
    expect(other?.three).toBe(false);
    expect(args?.three).toBe(true);
  });

  it("runs the project's tsc through a runner and keeps only three errors by default", () => {
    const dir = project({ "tsconfig.json": "{}", "package.json": "{}" });
    const runner: Runner = () => ({ status: 2, stdout: out, stderr: "" });
    const r = checkTypes(dir, { index, runner });
    expect(r.ran).toBe(true);
    expect(r.other).toBe(1);
    const text = formatTypes(r);
    expect(text).toMatch(/^tsc: 4 three.js type error\(s\), 1 other/);
    expect(text).not.toContain("not assignable to type 'number'");
    expect(formatTypes(r, { all: true })).toContain("not assignable");
  });

  it("says why it does not run", () => {
    expect(checkTypes(project({ "a.js": "" })).reason).toContain("no tsconfig.json");
    expect(checkTypes(project({ "tsconfig.json": "{}" })).reason).toContain("not installed");
  });
});
