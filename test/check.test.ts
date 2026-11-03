import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { check } from "../src/check/check.js";
import { project, THREE_DIR } from "./helpers.js";

const have = !!findChromium();

function page(script: string): string {
  const dir = project({
    "index.html": `<!doctype html><html><body style="margin:0"><script type="importmap">{"imports":{"three":"./three/three.module.js"}}</script><script type="module">${script}</script></body></html>`,
  });
  mkdirSync(join(dir, "three"), { recursive: true });
  cpSync(join(THREE_DIR, "build", "three.module.js"), join(dir, "three", "three.module.js"));
  cpSync(join(THREE_DIR, "build", "three.core.js"), join(dir, "three", "three.core.js"));
  return dir;
}

const scene = (color: string, withLight = true) => `
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(400, 300);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101820);
const camera = new THREE.PerspectiveCamera(60, 4/3, 0.1, 100);
camera.position.z = 3;
${withLight ? "scene.add(new THREE.AmbientLight(0xffffff, 2));" : ""}
const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: ${color} }));
scene.add(mesh);
renderer.setAnimationLoop(() => { renderer.render(scene, camera); });
`;

describe.skipIf(!have)("headless check (needs Chromium)", () => {
  it("passes a working WebGL scene and reports the revision", async () => {
    const r = await check({ target: page(scene("0x44aa88")), wait: 800 });
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.stats.canvases).toBe(1);
    expect(r.stats.contexts.some((c) => c.startsWith("webgl"))).toBe(true);
    expect(r.stats.threeRevision).toBe("187");
  }, 60_000);

  it("fails a blank scene", async () => {
    const dir = page(scene("0x44aa88").replace("scene.add(mesh);", ""));
    const r = await check({ target: dir, wait: 500 });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.kind)).toContain("blank");
  }, 60_000);

  it("reports page errors, missing files and no canvas", async () => {
    const dir = page(`import * as THREE from 'three'; throw new Error('boom ' + THREE.REVISION);`);
    writeFileSync(join(dir, "index.html"), `<!doctype html><script type="module">throw new Error('boom')</script><img src="missing.png">`);
    const r = await check({ target: dir, wait: 300 });
    const kinds = r.issues.map((i) => i.kind);
    expect(r.ok).toBe(false);
    expect(kinds).toContain("page-error");
    expect(kinds).toContain("request-failed");
    expect(kinds).toContain("no-canvas");
  }, 60_000);

  it("creates, matches and catches a changed baseline", async () => {
    const dir = page(scene("0x44aa88"));
    const base = { target: dir, wait: 600, baseline: "home" };
    expect((await check(base)).baseline?.status).toBe("created");
    const same = await check(base);
    expect(same.baseline?.status).toBe("match");
    expect(same.ok).toBe(true);
    writeFileSync(join(dir, "index.html"), (await import("node:fs")).readFileSync(join(dir, "index.html"), "utf8").replace("0x44aa88", "0xff3300"));
    const changed = await check(base);
    expect(changed.ok).toBe(false);
    expect(changed.baseline?.status).toBe("diff");
    expect(changed.baseline?.diffImage).toBeTruthy();
    const updated = await check({ ...base, updateBaseline: true });
    expect(updated.baseline?.status).toBe("updated");
  }, 120_000);
});
