import { readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Protected paths: folders and files no Threesmith write may touch. They come from `"protect"` in the project's
 * threesmith.json and from $THREESMITH_PROTECT (separated by the path delimiter or commas). Every write Threesmith
 * makes to a project goes through the journal, which asks `assertWritable` first.
 */

export class ProtectedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtectedPathError";
  }
}

/** Patterns: a path relative to the project ("src/vendor", "public/models/*.glb") or absolute. `*` is one segment, `**` any. */
const patterns = new Map<string, string[]>();

function toRegex(glob: string): RegExp {
  const parts = glob.replace(/\\/g, "/").replace(/\/+$/, "");
  let re = "";
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i] as string;
    if (c === "*" && parts[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // a folder protects everything in it
  return new RegExp(`^${re}(?:/.*)?$`);
}

/** Reads the `protect` list of `<root>/threesmith.json` (once per root). */
export function protectFrom(root: string): string[] {
  const key = resolve(root);
  const hit = patterns.get(key);
  if (hit) return hit;
  let list: string[] = [];
  try {
    const data = JSON.parse(readFileSync(join(key, "threesmith.json"), "utf8")) as { protect?: unknown };
    if (Array.isArray(data.protect)) list = data.protect.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  } catch {
    /* no config */
  }
  patterns.set(key, list);
  return list;
}

/**
 * The protect setting: $THREESMITH_PROTECT, or the Claude Code plugin option (CLAUDE_PLUGIN_OPTION_PROTECT), separated
 * by commas or the path delimiter. An unfilled plugin placeholder ("${user_config.protect}") counts as empty.
 */
export function envList(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const raw of [env["THREESMITH_PROTECT"], env["CLAUDE_PLUGIN_OPTION_PROTECT"]]) {
    if (!raw || raw.trim().startsWith("${")) continue;
    out.push(...raw.split(new RegExp(`[,${delimiter === ";" ? ";" : ":"}]`)).map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

export interface Protection {
  /** The pattern that matched. */
  pattern: string;
  /** Where it was set: a threesmith.json, or the protect setting. */
  source: string;
  /** The write targets the protect list itself. */
  list?: boolean;
}

/** The nearest folder at or above `dir` with a threesmith.json that has a "protect" list. */
function configAbove(dir: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (protectFrom(d).length) return d;
    if (dirname(d) === d) return undefined;
  }
}

/**
 * Why `file` may not be written, for an agent's own edits (the Claude Code pre-edit hook): a "protect" list in a
 * threesmith.json at or above the file (patterns relative to that folder, and the list itself), or the protect setting
 * (absolute, or relative to `cwd`, the folder the agent runs in).
 */
export function protectionOf(file: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Protection | undefined {
  const full = resolve(cwd, file);
  const root = configAbove(dirname(full));
  if (root) {
    const config = join(root, "threesmith.json");
    if (full === config) return { pattern: "threesmith.json", source: config, list: true };
    const rel = relative(root, full).split(sep).join("/");
    for (const p of protectFrom(root)) {
      if (isAbsolute(p) ? full === resolve(p) || full.startsWith(resolve(p) + sep) : toRegex(p).test(rel)) return { pattern: p, source: config };
    }
  }
  for (const p of envList(env)) {
    const abs = resolve(cwd, p);
    if (full === abs || full.startsWith(abs + sep)) return { pattern: p, source: "the protect setting" };
    if (/[*?]/.test(p) && toRegex(p).test(relative(cwd, full).split(sep).join("/"))) return { pattern: p, source: "the protect setting" };
  }
  return undefined;
}

export function protectionMessage(file: string, p: Protection): string {
  return p.list
    ? `${file} holds the protect list; Threesmith refuses edits to it from the agent. Change it by hand if you mean to.`
    : `${file} is protected by "${p.pattern}" (${p.source}); it must stay byte-identical, so this edit is refused. Write somewhere else, or ask the user to change the protect list.`;
}

/** The pattern that protects `file` (absolute) in project `root`, or undefined when it may be written. */
export function protectedBy(root: string, file: string): string | undefined {
  const full = resolve(file);
  const rel = relative(resolve(root), full).split(sep).join("/");
  for (const p of [...protectFrom(root), ...envList()]) {
    if (isAbsolute(p)) {
      const abs = resolve(p);
      if (full === abs || full.startsWith(abs + sep)) return p;
      continue;
    }
    if (!rel.startsWith("..") && toRegex(p).test(rel)) return p;
  }
  return undefined;
}

export function assertWritable(root: string, file: string): void {
  const by = protectedBy(root, file);
  if (by) throw new ProtectedPathError(`${relative(root, file) || file} is protected by "${by}" (threesmith.json "protect" or THREESMITH_PROTECT); nothing was written.`);
}

/** Forget cached threesmith.json lists (tests, or after the config changed). */
export function resetProtect(): void {
  patterns.clear();
}
