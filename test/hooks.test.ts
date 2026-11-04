import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { postBash, postEdit, runHook, sessionStart, stop } from "../src/hooks/hooks.js";
import { formatDoctor } from "../src/doctor/doctor.js";
import { project } from "./helpers.js";

const bad = "import * as THREE from 'three';\nconst g = new THREE.Geometry();\n";
const ctx = () => ({ stateDir: mkdtempSync(join(tmpdir(), "threesmith-state-")) });

describe("hooks", () => {
  it("sends review errors of an edited file back", () => {
    const dir = project({ "package.json": "{}", "main.js": bad });
    const out = postEdit({ session_id: "s", cwd: dir, tool_input: { file_path: join(dir, "main.js") } }, ctx());
    expect(out?.decision).toBe("block");
    expect(out?.reason).toContain("geometry-class");
    expect(out?.reason).toContain("main.js:2");
  });

  it("stays quiet for clean code, other files and node_modules", () => {
    const dir = project({ "package.json": "{}", "ok.js": "import * as THREE from 'three';\nnew THREE.Scene();\n", "notes.md": "x" });
    expect(postEdit({ cwd: dir, tool_input: { file_path: join(dir, "ok.js") } }, ctx())).toBeUndefined();
    expect(postEdit({ cwd: dir, tool_input: { file_path: join(dir, "notes.md") } }, ctx())).toBeUndefined();
    expect(postEdit({ cwd: dir, tool_input: { file_path: join(dir, "node_modules", "x.js") } }, ctx())).toBeUndefined();
    expect(postEdit({ cwd: dir, tool_input: {} }, ctx())).toBeUndefined();
  });

  it("names open errors once before stopping, and confirms a fix", () => {
    const dir = project({ "package.json": "{}", "main.js": bad });
    const c = ctx();
    const file = join(dir, "main.js");
    postEdit({ session_id: "s2", cwd: dir, tool_input: { file_path: file } }, c);
    const first = stop({ session_id: "s2" }, c);
    expect(first?.decision).toBe("block");
    expect(stop({ session_id: "s2" }, c)).toBeUndefined(); // asks only once about the same errors
    writeFileSync(file, "import * as THREE from 'three';\nnew THREE.Scene();\n");
    const fixed = postEdit({ session_id: "s2", cwd: dir, tool_input: { file_path: file } }, c);
    expect(fixed?.hookSpecificOutput?.additionalContext).toContain("fixed");
    expect(stop({ session_id: "s2", stop_hook_active: true }, c)).toBeUndefined();
  });

  it("points at tools when command output has three.js problems", () => {
    expect(postBash({ tool_response: { stdout: "THREE.Geometry: has been removed" } })?.hookSpecificOutput?.additionalContext).toContain("three_api");
    expect(postBash({ tool_response: "The requested module 'three' does not provide an export named 'OrbitControls'" })).toBeDefined();
    expect(postBash({ tool_response: "all good" })).toBeUndefined();
  });

  it("starts a session with the installed version, only in three projects", () => {
    expect(sessionStart({ cwd: project({ "package.json": "{}" }) })).toBeUndefined();
    const dir = project({ "package.json": JSON.stringify({ dependencies: { three: "^0.187.0" } }) });
    expect(sessionStart({ cwd: dir })?.hookSpecificOutput?.additionalContext).toContain("depends on three");
    expect(sessionStart({ cwd: process.cwd() })?.hookSpecificOutput?.additionalContext).toMatch(/three r\d+/);
  });

  it("names asset paths in the edited file that will not load", () => {
    const dir = project({ "package.json": "{}", "public/Car.glb": "x", "main.js": "import * as THREE from 'three';\nnew THREE.Scene();\nloader.load('/car.glb');\nloader.load('/boat.glb');\n" });
    const out = postEdit({ cwd: dir, tool_input: { file_path: join(dir, "main.js") } }, ctx());
    const text = out?.hookSpecificOutput?.additionalContext ?? "";
    expect(text).toContain("main.js:3 [asset-case]");
    expect(text).toContain("main.js:4 [asset-missing]");
  });

  it("does not block on a finding marked as a false alarm", async () => {
    const { recordFeedback } = await import("../src/learn/feedback.js");
    const dir = project({ "package.json": "{}", "main.js": bad });
    recordFeedback({ rule: "geometry-class", snippet: "const g = new THREE.Geometry();" }, "wrong");
    expect(postEdit({ cwd: dir, tool_input: { file_path: join(dir, "main.js") } }, ctx())?.decision).toBeUndefined();
    recordFeedback({ rule: "geometry-class", snippet: "const g = new THREE.Geometry();" }, "right");
  });

  it("dispatches events", () => {
    expect(runHook("stop", {}, ctx())).toBeUndefined();
  });
});

describe("doctor format", () => {
  it("lists fixes", () => {
    expect(formatDoctor([{ name: "three", ok: false, detail: "missing", fix: "npm i three" }, { name: "node", ok: true, detail: "22" }])).toContain("fix: npm i three");
  });
});
