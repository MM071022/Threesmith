import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serveStatic } from "../src/check/server.js";
import { formatMarkdown } from "../src/review/format.js";
import { collect } from "../src/review/source.js";
import { project } from "./helpers.js";

describe("static server", () => {
  it("serves files and index.html, and nothing outside the folder", async () => {
    const outer = project({ "secret.txt": "top secret", "site/index.html": "<h1>hi</h1>", "site/app.js": "1" });
    mkdirSync(join(outer, "site", "sub"), { recursive: true });
    writeFileSync(join(outer, "site", "sub", "index.html"), "sub");
    const s = await serveStatic(join(outer, "site"));
    try {
      const get = async (p: string) => fetch(s.url + p);
      expect(await (await get("/")).text()).toBe("<h1>hi</h1>");
      expect(await (await get("/sub/")).text()).toBe("sub");
      expect((await get("/app.js")).headers.get("content-type")).toContain("javascript");
      expect((await get("/nope.js")).status).toBe(404);
      for (const evil of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/sub/../../secret.txt", "/%00"]) {
        const r = await get(evil);
        expect(r.status, evil).not.toBe(200);
        expect(await r.text()).not.toContain("top secret");
      }
    } finally {
      await s.close();
    }
  });
});

describe("collect", () => {
  it("reads a single file and skips minified and declaration files", () => {
    const dir = project({ "a.js": "import * as THREE from 'three';", "a.min.js": "x", "b.d.ts": "x", "node_modules/c.js": "x", "package.json": '{"dependencies":{"three":"1"}}' });
    expect(collect(dir).files.map((f) => f.path)).toEqual(["a.js"]);
    expect(collect(dir).packageJson?.dependencies).toEqual({ three: "1" });
    const single = collect(join(dir, "a.js"));
    expect(single.files.map((f) => f.path)).toEqual(["a.js"]);
    expect(single.packageJson).toBeDefined();
  });
});

describe("markdown", () => {
  it("escapes backslashes and pipes in table cells", () => {
    const md = formatMarkdown({
      path: ".", three: null, filesScanned: 1, threeFiles: 1, score: 90, grade: "A", categories: [], counts: { error: 1, warn: 0, info: 0 },
      findings: [{ rule: "r", category: "api", severity: "error", file: "a.js", line: 1, message: "m", fix: "use a|b and C:\\x", snippet: "" }],
    });
    expect(md).toContain("a\\|b and C:\\\\x");
  });
});
