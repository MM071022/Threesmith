// Copies the version from package.json into every file that names it: the MCP Registry entry, the Claude Code
// plugin, and the Gemini CLI extension. `npm version <x>` runs this for you.
//
//   node scripts/sync-version.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const read = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
const write = (file, data) => writeFileSync(join(root, file), `${JSON.stringify(data, null, 2)}\n`);
const { version } = read("package.json");
const pin = (args) => args.map((a) => (/^threesmith(@.*)?$/.test(a) ? `threesmith@${version}` : a));

const server = read("server.json");
server.version = version;
for (const p of server.packages) p.version = version;
write("server.json", server);

const plugin = read("plugins/threesmith/.claude-plugin/plugin.json");
plugin.version = version;
write("plugins/threesmith/.claude-plugin/plugin.json", plugin);

const mcp = read("plugins/threesmith/.mcp.json");
for (const s of Object.values(mcp.mcpServers)) s.args = pin(s.args);
write("plugins/threesmith/.mcp.json", mcp);

const gemini = read("gemini-extension.json");
gemini.version = version;
for (const s of Object.values(gemini.mcpServers)) s.args = pin(s.args);
write("gemini-extension.json", gemini);

console.log(`version ${version} written to server.json, the Claude Code plugin and the Gemini CLI extension`);
