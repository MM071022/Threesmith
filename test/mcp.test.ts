import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer, type ServerOptions } from "../src/mcp/server.js";
import { renderInstructions } from "../src/mcp/instructions.js";
import { ALL_TOOLS, TOOLSETS, enabledTools, readOnlyRefusal } from "../src/mcp/toolsets.js";
import { project, THREE_DIR } from "./helpers.js";

async function client(options: ServerOptions = {}): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(options).connect(b);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(a);
  return c;
}

const textOf = (r: unknown): string => (r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === "text")?.text ?? "";

describe("mcp server", () => {
  it("lists every tool of every set, each in exactly one set", async () => {
    const c = await client();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...ALL_TOOLS].sort());
    expect(new Set(ALL_TOOLS).size).toBe(ALL_TOOLS.length);
  });

  it("loads only the tool sets asked for, and the instructions name only those tools", async () => {
    const c = await client({ tools: "core" });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual([...TOOLSETS.core].sort());
    const text = c.getInstructions() ?? "";
    expect(text).toContain("three_doctor");
    expect(text).not.toContain("three_check");
    for (const m of text.matchAll(/\bthree_[a-z_]+/g)) expect(TOOLSETS.core as readonly string[]).toContain(m[0]);
    expect(() => enabledTools("nope")).toThrow(/unknown tool set/);
    expect(enabledTools("check").has("three_check")).toBe(true);
  });

  it("numbers the cheap steps and filters lines whose tools are off", () => {
    const all = renderInstructions("cheap", new Set(ALL_TOOLS));
    expect(all).toMatch(/\n1\. In a project you do not know yet/);
    const few = renderInstructions("cheap", new Set(["three_api"]));
    expect(few).not.toContain("three_review");
    expect(few).not.toContain("Follow these steps:\n1. In a project");
    expect(renderInstructions("premium", new Set(ALL_TOOLS), true)).toContain("read-only");
  });

  it("read-only leaves out undo and refuses writes but keeps dry runs", async () => {
    expect(readOnlyRefusal("three_fix", { write: true })).toContain("read-only");
    expect(readOnlyRefusal("three_fix", {})).toBeUndefined();
    const c = await client({ readOnly: true });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("three_undo");
    const dir = project({ "package.json": "{}", "a.js": "import * as THREE from 'three';\nnew THREE.BoxBufferGeometry();\n" });
    const r = await c.callTool({ name: "three_fix", arguments: { path: dir, write: true, three: THREE_DIR } });
    expect(r.isError).toBe(true);
    const dry = await c.callTool({ name: "three_fix", arguments: { path: dir, three: THREE_DIR } });
    expect(textOf(dry)).toContain("Would fix");
  });

  it("answers api, search and version from the pinned install", async () => {
    const c = await client();
    const api = await c.callTool({ name: "three_api", arguments: { query: "Mesh", three: THREE_DIR } });
    expect(textOf(api)).toContain("import { Mesh } from 'three'");
    const miss = await c.callTool({ name: "three_api", arguments: { query: "Geometry", three: THREE_DIR } });
    expect(miss.isError).toBe(true);
    const s = await c.callTool({ name: "three_search", arguments: { query: "orbit", three: THREE_DIR } });
    expect(textOf(s)).toContain("OrbitControls");
    const v = await c.callTool({ name: "three_version", arguments: { three: THREE_DIR } });
    expect(textOf(v)).toMatch(/three r\d+/);
  });

  it("reviews a directory with structured content, unsaved code and only_new", async () => {
    const c = await client();
    const dir = project({ "package.json": "{}", "a.js": "import * as THREE from 'three';\nconst g = new THREE.Geometry();\n" });
    const r = await c.callTool({ name: "three_review", arguments: { path: dir, three: THREE_DIR } });
    expect(textOf(r)).toMatch(/^review \d+\/100/);
    expect(textOf(r)).toContain("a.js:2 error [geometry-class]");
    const data = r.structuredContent as { ok: boolean; findings: { rule: string }[] };
    expect(data.ok).toBe(false);
    expect(data.findings.map((f) => f.rule)).toContain("geometry-class");
    // the older parameter name still works
    const old = await c.callTool({ name: "three_review", arguments: { target: dir, three: THREE_DIR } });
    expect(textOf(old)).toContain("geometry-class");
    const unsaved = await c.callTool({ name: "three_review", arguments: { path: dir, file: "b.js", code: "import * as THREE from 'three';\nnew THREE.Face3();\n", three: THREE_DIR } });
    expect(textOf(unsaved)).toContain("b.js:2 error [face3]");
    expect(textOf(unsaved)).not.toContain("[geometry-class]");
    const delta = await c.callTool({ name: "three_review", arguments: { path: dir, only_new: true, three: THREE_DIR } });
    expect(textOf(delta)).toContain("since the last review: 0 new, 0 fixed, 1 still open");
  });

  it("fixes with write through the journal and undoes it", async () => {
    const c = await client();
    const dir = project({ "package.json": "{}", "a.js": "import * as THREE from 'three';\nnew THREE.BoxBufferGeometry();\n" });
    const w = await c.callTool({ name: "three_fix", arguments: { path: dir, write: true, three: THREE_DIR } });
    expect(textOf(w)).toContain("three_undo");
    expect(readFileSync(join(dir, "a.js"), "utf8")).toContain("BoxGeometry");
    const u = await c.callTool({ name: "three_undo", arguments: { path: dir } });
    expect(textOf(u)).toContain("restored a.js");
    expect(readFileSync(join(dir, "a.js"), "utf8")).toContain("BoxBufferGeometry");
  });

  it("doctor, scan, assets, rules and feedback answer from the files", async () => {
    const c = await client();
    const dir = project({ "package.json": "{}", "a.js": "import * as THREE from 'three';\nnew THREE.Geometry();\nloader.load('/nope.glb');\n" });
    const d = await c.callTool({ name: "three_doctor", arguments: { path: dir } });
    expect(textOf(d)).toContain("Next:");
    expect((d.structuredContent as { next: string[] }).next.length).toBeGreaterThan(0);
    expect(textOf(await c.callTool({ name: "three_scan", arguments: { path: dir } }))).toContain("files using three (1)");
    const a = await c.callTool({ name: "three_assets", arguments: { path: dir } });
    expect(a.isError).toBe(true);
    expect(textOf(a)).toContain("asset-missing");
    expect(textOf(await c.callTool({ name: "three_rules", arguments: { query: "geometry" } }))).toContain("geometry-class");
    const f = await c.callTool({ name: "three_feedback", arguments: { path: dir, file: "a.js", line: 2, verdict: "wrong" } });
    expect(textOf(f)).toContain("Hidden from now on");
    const again = await c.callTool({ name: "three_review", arguments: { path: dir } });
    expect(textOf(again)).not.toContain("[geometry-class]");
    expect(textOf(again)).toContain("hidden");
    await c.callTool({ name: "three_feedback", arguments: { path: dir, file: "a.js", line: 2, rule: "geometry-class", verdict: "right" } });
  });

  it("says clearly when three is not installed", async () => {
    const c = await client();
    const dir = project({ "a.js": "x" });
    const r = await c.callTool({ name: "three_api", arguments: { query: "Mesh", path: dir } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("npm install three");
  });
});
