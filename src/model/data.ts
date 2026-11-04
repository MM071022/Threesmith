import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let root: string | undefined;

/**
 * The package's `data/<sub>` folder. Found by walking up from this module to the folder that has a package.json and a
 * data folder, so it works the same from `src/` (tests) and from `dist/` (the built package).
 */
export function dataDir(sub: string): string {
  if (!root) {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "data"))) break;
      const up = dirname(dir);
      if (up === dir) throw new Error(`cannot find the data folder above ${dirname(fileURLToPath(import.meta.url))}`);
      dir = up;
    }
    root = join(dir, "data");
  }
  return join(root, sub);
}
