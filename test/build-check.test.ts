import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { buildCheck, bytesPerSource, detectBuild, formatBuild, type BuildRunner } from "../src/check/build.js";
import type { CheckOptions, CheckResult } from "../src/check/check.js";
import { project } from "./helpers.js";

const have = !!findChromium();
const VITE = resolve("node_modules/vite/bin/vite.js");

const copy = (rev: string) => `(function(){var a=1;typeof window<"u"&&(window.__THREE__?console.warn("WARNING: Multiple instances of Three.js being imported."):window.__THREE__="${rev}")})();`;

const okRun: BuildRunner = async () => ({ code: 0, output: "vite v8 building for production...\n✓ built in 1s", timedOut: false, ms: 1000 });
const passingCheck = async (o: CheckOptions): Promise<CheckResult> => ({ ok: true, url: `http://x/${o.target}`, issues: [], stats: { canvases: 1, contexts: ["webgl2"], frames: 10, threeRevision: "187", dominantColor: 0.5, webgpuAdapter: null } });

describe("build check on a fixture output (no npm, no browser)", () => {
  it("finds two copies of three, missing and wrongly cased assets, absolute URLs and missing decoders", async () => {
    const dir = project({
      "package.json": JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "^8.0.0" } }),
      "dist/index.html": `<!doctype html><script type="module" src="/assets/app.js"></script><!-- <img src="old.png"> -->`,
      "dist/assets/app.js": `${copy("187")}\nconst l=new GLTFLoader;l.load("models/Robot.glb");new RGBELoader().load("textures/sky.hdr");d.setDecoderPath("/draco/");/* "commented.png" */fetch("data/level.json");`,
      "dist/assets/vendor.js": copy("160"),
      "dist/models/robot.glb": "glTF",
      "dist/data/level.json": "{}",
      "dist/scene.gltf": JSON.stringify({ buffers: [{ uri: "scene.bin" }], images: [{ uri: "data:image/png;base64,AAAA" }] }),
    });
    let ran: string[] = [];
    const r = await buildCheck({ project: dir, run: async (cmd, args, o) => ((ran = [cmd, ...args, o.cwd]), okRun(cmd, args, o)), checkPage: passingCheck });
    expect(ran).toEqual(["npm", "run", "build", dir]);
    expect(r.tool).toBe("vite");
    expect(r.outDir).toBe("dist");
    const by = (k: string) => r.issues.filter((i) => i.kind === k);
    expect(r.three.copies.map((c) => c.revision)).toEqual(["187", "160"]);
    expect(by("three-duplicate")[0]!.message).toMatch(/2 copies of three are bundled \(r187 at dist\/assets\/app\.js:1:\d+, r160 at dist\/assets\/vendor\.js:1:\d+\)/);
    expect(by("asset-case")[0]).toMatchObject({ at: expect.stringMatching(/^dist\/assets\/app\.js:2:\d+$/), message: expect.stringContaining("references models/Robot.glb but the file is models/robot.glb") });
    const missing = by("asset-missing").map((i) => i.message);
    expect(missing).toContain("references textures/sky.hdr, which is not in dist.");
    expect(missing).toContain("scene.gltf references scene.bin, which is not next to it in the output.");
    expect(missing.join(" ")).not.toMatch(/commented|old\.png|level\.json/);
    expect(by("decoder-missing")[0]!.message).toMatch(/setDecoderPath\('\/draco\/'\) but draco_decoder\.wasm and draco_wasm_wrapper\.js are not/);
    expect(by("absolute-url")[0]!.message).toMatch(/dist\/index\.html:1:\d+ \/assets\/app\.js/);
    expect(r.assets).toEqual({ referenced: 4, missing: 2 });
    expect(r.ok).toBe(false);
    const text = formatBuild(r);
    expect(text).toContain("three r187, r160 x2");
    expect(text).toContain("fix: Make every package use one three");
  });

  it("serves a sub-path build under its base and passes a clean output", async () => {
    const dir = project({
      "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      "vite.config.ts": `import { defineConfig } from 'vite';\n// base: '/wrong/'\nexport default defineConfig({ base: '/repo/', build: { outDir: 'site' } });`,
      "site/index.html": `<script type="module" src="/repo/assets/app.js"></script>`,
      "site/assets/app.js": `${copy("187")}fetch("/repo/models/a.glb")`,
      "site/models/a.glb": "x",
    });
    expect(detectBuild(dir)).toEqual({ tool: "vite", script: "build", outDir: "site", base: "/repo/" });
    let seen: CheckOptions | undefined;
    const r = await buildCheck({ project: dir, run: okRun, checkPage: async (o) => ((seen = o), passingCheck(o)) });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(seen!.target.replaceAll("\\", "/")).toMatch(/\/repo$/);
    expect(seen!.root).toBeDefined();
    expect(r.check?.ok).toBe(true);
  });

  it("reports a failed build with the tail of its output, and a missing script", async () => {
    const dir = project({ "package.json": JSON.stringify({ scripts: { build: "webpack" } }), "pnpm-lock.yaml": "" });
    const failed = await buildCheck({ project: dir, run: async () => ({ code: 1, output: "ERROR in ./src/main.js\nModule not found: Error: Can't resolve 'three/addons/x.js'", timedOut: false, ms: 50 }) });
    expect(failed.command).toBe("pnpm run build");
    expect(failed.issues[0]).toMatchObject({ kind: "build-failed", message: "pnpm run build exited with code 1." });
    expect(formatBuild(failed)).toContain("| Module not found: Error: Can't resolve 'three/addons/x.js'");
    const none = await buildCheck({ project: dir, script: "dist", run: okRun });
    expect(none.issues[0]!.kind).toBe("no-build-script");
  });

  it("counts the bytes each source contributes from a source map", () => {
    // "abcdef": a-c from source 0, d-f from source 1
    expect([...bytesPerSource("abcdef", { sources: ["x.js", "node_modules/three/build/three.core.js"], mappings: "AAAA,GCAA" })]).toEqual([
      ["x.js", 3],
      ["node_modules/three/build/three.core.js", 3],
    ]);
  });
});

describe.skipIf(!have || !existsSync(VITE))("build check with a real vite build (needs Chromium)", () => {
  it("builds, finds one three and its size from the source map, and checks the built page", async () => {
    const dir = project({
      "package.json": JSON.stringify({ name: "fx", private: true, type: "module", scripts: { build: `node ${JSON.stringify(VITE)} build --sourcemap --base ./` } }),
      "index.html": `<!doctype html><html><body style="margin:0"><script type="module" src="./src/main.js"></script></body></html>`,
      "src/main.js": readFileSync(join(import.meta.dirname, "fixtures", "run", "game.js"), "utf8"),
    });
    symlinkSync(resolve("node_modules"), join(dir, "node_modules"), "dir");
    const r = await buildCheck({ project: dir, check: { wait: 800 } });
    const text = formatBuild(r);
    expect(r.build?.code, text).toBe(0);
    expect(r.three.copies).toHaveLength(1);
    expect(r.three.revisions).toEqual(["187"]);
    expect(r.three.kb).toBeGreaterThan(200);
    expect(r.issues.filter((i) => i.severity === "error"), text).toEqual([]);
    expect(r.check?.stats.threeRevision).toBe("187");
    expect(r.ok).toBe(true);
  }, 120_000);
});
