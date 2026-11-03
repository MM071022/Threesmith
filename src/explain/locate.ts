import { readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { readLimited } from "../review/source.js";

const EXT = new Set([".js", ".mjs", ".ts", ".tsx", ".jsx", ".html", ".vue", ".svelte", ".glsl", ".vert", ".frag", ".vs", ".fs", ".wgsl"]);
const SKIP = new Set(["node_modules", "dist", "build", ".git", ".threesmith", "coverage"]);

/**
 * Find a line of shader code in the project, so a shader error that three reports against its compiled program
 * (with three's own prefix in front) can be pointed at the file and line the user wrote. Returns "file:line".
 */
export function locateCode(root: string, code: string, maxFiles = 2000): string | undefined {
  const needle = code.trim();
  if (needle.length < 6) return undefined;
  let seen = 0;
  const visit = (dir: string): string | undefined => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      if (e.isSymbolicLink() || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        const hit = visit(p);
        if (hit) return hit;
      } else if (e.isFile() && EXT.has(extname(e.name))) {
        if (++seen > maxFiles) return undefined;
        const text = readLimited(p);
        if (!text || !text.includes(needle)) continue;
        const lines = text.split("\n");
        const i = lines.findIndex((l) => l.includes(needle));
        if (i >= 0) return `${relative(root, p).split("\\").join("/")}:${i + 1}`;
      }
    }
    return undefined;
  };
  return visit(root);
}
