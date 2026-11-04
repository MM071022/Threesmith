import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../src/mcp/toolsets.js";

const plugin = (dir: string): string[] => readdirSync(`plugins/threesmith/${dir}`).filter((f) => !f.startsWith("."));

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
  it("lists every mcp tool in the readme, and names no tool that does not exist", () => {
    const readme = readFileSync("README.md", "utf8");
    for (const t of ALL_TOOLS) expect(readme, t).toContain(`\`${t}\``);
    const docs = ["README.md", "llms-install.md", "docs/llms.txt", "plugins/threesmith/README.md", ...plugin("skills").map((d) => `plugins/threesmith/skills/${d}/SKILL.md`), ...plugin("agents").map((f) => `plugins/threesmith/agents/${f}`)];
    for (const f of docs) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bthree_[a-z_]+[a-z]\b/g)) expect(ALL_TOOLS, `${f} names ${m[0]}`).toContain(m[0]);
    }
  });
  it("gives every skill and agent valid front matter", () => {
    for (const d of plugin("skills")) expect(readFileSync(`plugins/threesmith/skills/${d}/SKILL.md`, "utf8"), d).toMatch(new RegExp(`^---\\nname: ${d}\\ndescription: .+`));
    for (const f of plugin("agents")) expect(readFileSync(`plugins/threesmith/agents/${f}`, "utf8"), f).toMatch(new RegExp(`^---\\nname: ${f.replace(/\.md$/, "")}\\n`));
  });
});
