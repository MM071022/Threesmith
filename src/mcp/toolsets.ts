/**
 * Tool sets and the read-only policy of the MCP server. Each tool is in exactly one set, so a client can load only
 * what it needs (`threesmith mcp --tools core,run`), which keeps the tool list it pays for in every turn small.
 */

export const TOOLSETS = {
  core: [
    "three_doctor",
    "three_scan",
    "three_api",
    "three_search",
    "three_review",
    "three_types",
    "three_fix",
    "three_explain",
    "three_rules",
    "three_feedback",
    "three_undo",
    "three_version",
  ],
  run: ["three_check", "three_inspect"],
  live: ["three_session", "three_page"],
  build: ["three_assets"],
} as const satisfies Record<string, readonly string[]>;

export type Toolset = keyof typeof TOOLSETS;
export const TOOLSET_NAMES = Object.keys(TOOLSETS) as Toolset[];
export const ALL_TOOLS: readonly string[] = TOOLSET_NAMES.flatMap((s) => TOOLSETS[s] as readonly string[]);

export class ToolsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolsetError";
  }
}

/**
 * The tools a `--tools` list enables: set names and single tool names (`three_check` or `check`), separated by commas
 * or spaces. Empty or unset means all. Unknown names throw, naming the valid ones.
 */
export function enabledTools(list?: string | readonly string[]): Set<string> {
  const items = (typeof list === "string" ? list.split(/[\s,]+/) : (list ?? [])).map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return new Set(ALL_TOOLS);
  const out = new Set<string>();
  for (const item of items) {
    if (item === "all") for (const t of ALL_TOOLS) out.add(t);
    else if (Object.hasOwn(TOOLSETS, item)) for (const t of TOOLSETS[item as Toolset]) out.add(t);
    else if (ALL_TOOLS.includes(item)) out.add(item);
    else if (ALL_TOOLS.includes(`three_${item}`)) out.add(`three_${item}`);
    else throw new ToolsetError(`unknown tool set or tool "${item}"; use ${TOOLSET_NAMES.join(", ")}, all, or tool names such as three_check`);
  }
  return out;
}

/** Tools a read-only server leaves out: they always change project files. */
export const WRITE_ONLY_TOOLS: readonly string[] = ["three_undo"];

const DRY_RUN_TOOLS = new Set(["three_fix"]);

/** Why a read-only server refuses this call, or undefined when it may run. Dry runs still work. */
export function readOnlyRefusal(tool: string, args: Record<string, unknown>): string | undefined {
  const no = (what: string) => `read-only session: ${tool} ${what} is refused (the server was started with --read-only).`;
  if (WRITE_ONLY_TOOLS.includes(tool)) return no("writes files and");
  if (DRY_RUN_TOOLS.has(tool) && args["write"] === true) return no("with write: true") + " Leave write out to see the changes.";
  if ((tool === "three_check" || tool === "three_play") && (args["baseline"] !== undefined || args["update_baseline"] === true)) return no("with a baseline (it writes the picture into the project)");
  return undefined;
}

/** Reads a boolean switch such as THREESMITH_READ_ONLY: 1, true, yes or on. */
export function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}
