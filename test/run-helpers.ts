import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { project, THREE_DIR } from "./helpers.js";

/** A temp folder with index.html, three next to it (import map) and main.js: the fixture game, or the given script. */
export function gamePage(script?: string, extra: Record<string, string> = {}): string {
  const dir = project({
    "index.html": `<!doctype html><html><body style="margin:0"><script type="importmap">{"imports":{"three":"./three/three.module.js"}}</script><script type="module" src="./main.js"></script></body></html>`,
    "main.js": script ?? readFileSync(join(import.meta.dirname, "fixtures", "run", "game.js"), "utf8"),
    ...extra,
  });
  mkdirSync(join(dir, "three"), { recursive: true });
  cpSync(join(THREE_DIR, "build", "three.module.js"), join(dir, "three", "three.module.js"));
  cpSync(join(THREE_DIR, "build", "three.core.js"), join(dir, "three", "three.core.js"));
  return dir;
}
