#!/usr/bin/env node
// Runs `threesmith hook <event>` for Claude Code with the hook input on stdin, using the same threesmith version as
// the plugin's MCP server (the version in .claude-plugin/plugin.json). Set THREESMITH_CLI to the path of a local
// dist/cli.js to use a build instead, and THREESMITH_HOOKS=0 to turn the hooks off.
// It fails open: when threesmith cannot run, is too old to know the event, or takes too long, it prints nothing and
// exits 0, so a hook never stands in the way.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const event = process.argv[2];
if (!event || process.env.THREESMITH_HOOKS === "0") process.exit(0);

let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  process.exit(0);
}

/**
 * Whether a protection can apply: a protect setting, or a threesmith.json with "protect" at or above the file's folder
 * (the places threesmith looks). Cheap, so most edits never start threesmith.
 */
function maybeProtected(file, cwd) {
  const set = (v) => Boolean(v && v.trim() && !v.trim().startsWith("${"));
  if (set(process.env.THREESMITH_PROTECT) || set(process.env.CLAUDE_PLUGIN_OPTION_PROTECT)) return true;
  if (!file) return false;
  for (let dir = dirname(resolve(cwd || process.cwd(), file)); ; dir = dirname(dir)) {
    const config = join(dir, "threesmith.json");
    if (existsSync(config) && readFileSync(config, "utf8").includes('"protect"')) return true;
    if (dirname(dir) === dir) return false;
  }
}

// Only protected paths, three.js-looking source files and three.js output are worth starting threesmith for.
try {
  const data = JSON.parse(input || "{}");
  const file = String(data?.tool_input?.file_path ?? data?.tool_input?.notebook_path ?? "");
  if (event === "pre-edit" && !maybeProtected(file, data?.cwd)) process.exit(0);
  if (event === "post-edit" && (!/\.(?:js|mjs|cjs|jsx|ts|tsx|html?|vue|svelte)$/.test(file) || /[\\/]node_modules[\\/]/.test(file))) process.exit(0);
  if (event === "post-bash") {
    const r = data?.tool_response;
    const text = typeof r === "string" ? r : `${r?.stdout ?? ""}\n${r?.stderr ?? ""}`;
    if (!/THREE\.|Three\.js|three\/(?:examples|addons|webgpu|tsl)|does not provide an export named|GLTFLoader|DRACOLoader|KTX2Loader|WebGL|R3F:/.test(text)) process.exit(0);
  }
} catch {
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let version = "latest";
try {
  version = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version ?? version;
} catch {
  // Use the latest release.
}
const local = process.env.THREESMITH_CLI;
const windows = process.platform === "win32";
const [command, args] = local
  ? [process.execPath, [local, "hook", event]]
  : [windows ? "npx.cmd" : "npx", ["-y", `threesmith@${version}`, "hook", event]];
const result = spawnSync(command, args, {
  input,
  encoding: "utf8",
  timeout: 110_000,
  shell: windows && !local,
  env: { ...process.env, THREESMITH_HOOK: "1" },
});
if (result.status === 0 && result.stdout?.trim().startsWith("{")) process.stdout.write(result.stdout);
process.exit(0);
