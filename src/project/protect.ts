import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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

function envList(): string[] {
  const raw = process.env["THREESMITH_PROTECT"];
  if (!raw) return [];
  return raw.split(/[,:;]/).map((s) => s.trim()).filter(Boolean);
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
