import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const { version } = json("package.json");

describe("manifests", () => {
  it("carry the package version (run `node scripts/sync-version.mjs`)", () => {
    expect(json("server.json").version).toBe(version);
    expect(json("server.json").packages[0].version).toBe(version);
    expect(json("plugins/threesmith/.claude-plugin/plugin.json").version).toBe(version);
    expect(json("plugins/threesmith/.mcp.json").mcpServers.threesmith.args).toContain(`threesmith@${version}`);
    expect(json("gemini-extension.json").version).toBe(version);
    expect(json("gemini-extension.json").mcpServers.threesmith.args).toContain(`threesmith@${version}`);
  });
  it("name the same mcp server and plugin", () => {
    expect(json("server.json").name).toBe(json("package.json").mcpName);
    const market = json(".claude-plugin/marketplace.json");
    expect(market.plugins[0].source).toBe("./plugins/threesmith");
    expect(json("plugins/threesmith/.claude-plugin/plugin.json").name).toBe(market.plugins[0].name);
  });
  it("keep hooks pointing at the runner and the skill front matter valid", () => {
    const hooks = json("plugins/threesmith/hooks/hooks.json");
    const cmds = JSON.stringify(hooks);
    for (const e of ["post-edit", "post-bash", "stop", "session-start"]) expect(cmds).toContain(`run.mjs\\" ${e}`);
    const skill = readFileSync("plugins/threesmith/skills/threesmith/SKILL.md", "utf8");
    expect(skill).toMatch(/^---\nname: threesmith\ndescription: .+\n---/);
    expect(readFileSync("plugins/threesmith/agents/three-reviewer.md", "utf8")).toMatch(/^---\nname: three-reviewer\n/);
  });
  it("lists every mcp tool in the readme", () => {
    const readme = readFileSync("README.md", "utf8");
    for (const t of ["three_api", "three_search", "three_review", "three_fix", "three_check", "three_inspect", "three_explain", "three_version"]) expect(readme).toContain(t);
  });
});
