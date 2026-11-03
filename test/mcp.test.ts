import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/server.js";
import { project, THREE_DIR } from "./helpers.js";

async function client(): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(b);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(a);
  return c;
}

const textOf = (r: unknown): string =>
  ((r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === "text")?.text) ?? "";

describe("mcp server", () => {
  it("lists the tools", async () => {
    const c = await client();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["three_api", "three_check", "three_review", "three_search", "three_version"]);
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

  it("reviews a directory", async () => {
    const c = await client();
    const dir = project({ "a.js": "import * as THREE from 'three';\nconst g = new THREE.Geometry();\n" });
    const r = await c.callTool({ name: "three_review", arguments: { target: dir, three: THREE_DIR } });
    expect(textOf(r)).toContain("Threesmith review");
    expect(JSON.stringify(r)).toContain("geometry-class");
  });

  it("says clearly when three is not installed", async () => {
    const c = await client();
    const dir = project({ "a.js": "x" });
    const r = await c.callTool({ name: "three_api", arguments: { query: "Mesh", path: dir } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("npm install three");
  });
});
