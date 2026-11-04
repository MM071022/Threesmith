// Builds a local copy of the Claude Code plugin that runs this checkout's build instead of `npx threesmith@<version>`,
// for trying the plugin before a release. npm run plugin:local, then: claude --plugin-dir <the folder it prints>
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const cli = join(repo, "dist", "cli.js");
if (!existsSync(cli)) {
  console.error("dist/cli.js is missing: run npm run build first.");
  process.exit(1);
}
const out = process.argv[2] ? resolve(process.argv[2]) : join(homedir(), ".threesmith-dev-plugin");
rmSync(out, { recursive: true, force: true });
cpSync(join(repo, "plugins", "threesmith"), out, { recursive: true });

// the MCP server: this build, full detail
const mcpFile = join(out, ".mcp.json");
const mcp = JSON.parse(readFileSync(mcpFile, "utf8"));
mcp.mcpServers.threesmith.command = "node";
mcp.mcpServers.threesmith.args = [cli, "mcp", "--tier", "premium"];
writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + "\n");

// the hooks: this build too (THREESMITH_CLI still wins when set)
const runFile = join(out, "hooks", "run.mjs");
const run = readFileSync(runFile, "utf8");
const from = "const local = process.env.THREESMITH_CLI;";
if (!run.includes(from)) throw new Error("hooks/run.mjs changed: update scripts/plugin-local.mjs");
writeFileSync(runFile, run.replace(from, `const local = process.env.THREESMITH_CLI || ${JSON.stringify(cli)};`));

console.log(`Local plugin ready in ${out}`);
console.log(`Start Claude Code with it:  claude --plugin-dir "${out}"`);
console.log("Rebuild after a change: npm run build && npm run plugin:local");
