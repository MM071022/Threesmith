import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { createServer } from "../src/mcp/server.js";
import { gamePage } from "./run-helpers.js";

async function client(readOnly = false): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ readOnly }).connect(b);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(a);
  return c;
}

const textOf = (r: unknown): string => (r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === "text")?.text ?? "";

describe.skipIf(!findChromium())("run tools over mcp (needs Chromium)", () => {
  it("plays, saves a passing scenario through the journal, runs it and undoes the save", async () => {
    const c = await client();
    const dir = gamePage();
    writeFileSync(join(dir, "package.json"), "{}");
    const args = { target: dir, wait: 300, steps: [{ type: "press", key: " " }, { type: "frames", n: 10 }], expect: ["any: $('player').position.y > 0.5"] };
    const p = await c.callTool({ name: "three_play", arguments: { ...args, watch: ["$('player').position.y"] } });
    expect(p.isError).toBeFalsy();
    expect(textOf(p)).toContain("ok   any: $('player').position.y > 0.5");
    const saved = await c.callTool({ name: "three_scenario", arguments: { op: "save", name: "jump", ...args } });
    expect(textOf(saved)).toContain("saved .threesmith/scenarios/jump.json");
    expect(existsSync(join(dir, ".threesmith/scenarios/jump.json"))).toBe(true);
    const run = await c.callTool({ name: "three_scenario", arguments: { op: "run", path: dir } });
    expect(run.isError).toBeFalsy();
    const undo = await c.callTool({ name: "three_undo", arguments: { path: dir } });
    expect(textOf(undo)).toContain("removed .threesmith/scenarios/jump.json");
    const noClaims = await c.callTool({ name: "three_scenario", arguments: { op: "save", name: "x", target: dir } });
    expect(noClaims.isError).toBe(true);
  }, 90_000);

  it("refuses scenario saves and builds in a read-only session", async () => {
    const c = await client(true);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("three_build");
    const r = await c.callTool({ name: "three_scenario", arguments: { op: "save", name: "x", target: ".", expect: ["true"] } });
    expect(textOf(r)).toContain("read-only");
  });
});
