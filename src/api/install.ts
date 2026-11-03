import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ThreeInstall } from "./types.js";

/** Release number of a three version string: "0.187.0" -> 187, "0.183.2" -> 183. */
export function releaseOf(version: string): number {
  const m = /^0\.(\d+)/.exec(version.trim());
  return m ? Number(m[1]) : 0;
}

/**
 * Find the three package a project uses: walk up from `from` looking for
 * node_modules/three. `override` (a package dir) wins when given.
 */
export function findThree(from: string, override?: string): ThreeInstall | undefined {
  const candidates: string[] = [];
  if (override) candidates.push(resolve(override));
  else {
    let dir = resolve(from);
    for (;;) {
      candidates.push(join(dir, "node_modules", "three"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const root of candidates) {
    const pkg = join(root, "package.json");
    if (!existsSync(pkg)) continue;
    try {
      const json = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; version?: string };
      if (json.name === "three" && json.version) {
        return { root, version: json.version, release: releaseOf(json.version) };
      }
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}
