import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildIndex, type ApiIndex } from "./api/index-builder.js";
import { findThree } from "./api/install.js";

const cache = new Map<string, ApiIndex>();

/** The API index of the three a project uses, cached per install. */
export function indexFor(from: string, threeDir?: string): ApiIndex {
  const start = resolve(from);
  let dir = start;
  try {
    if (!statSync(start).isDirectory()) dir = dirname(start);
  } catch {
    /* use as given */
  }
  const install = findThree(dir, threeDir);
  if (!install) {
    throw new Error(
      `three is not installed at or above ${dir}. Run \`npm install three\` in the project, or pass --three <path to node_modules/three>.`,
    );
  }
  const hit = cache.get(install.root);
  if (hit) return hit;
  const index = buildIndex(install);
  cache.set(install.root, index);
  return index;
}
