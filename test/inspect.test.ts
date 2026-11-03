import { cpSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { check } from "../src/check/check.js";
import { formatScene } from "../src/check/inspect.js";
import { project, THREE_DIR } from "./helpers.js";

const have = !!findChromium();

function page(script: string, extra: Record<string, string> = {}): string {
  const dir = project({
    "index.html": `<!doctype html><html><body style="margin:0"><script type="importmap">{"imports":{"three":"./three/three.module.js","three/addons/":"./three/addons/"}}</script><script type="module" src="./main.js"></script></body></html>`,
    "main.js": script,
    ...extra,
  });
  mkdirSync(join(dir, "three"), { recursive: true });
  // like a real project: three installed next to the page, so explanations can name exact import paths
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(THREE_DIR, join(dir, "node_modules", "three"), "dir");
  cpSync(join(THREE_DIR, "build", "three.module.js"), join(dir, "three", "three.module.js"));
  cpSync(join(THREE_DIR, "build", "three.core.js"), join(dir, "three", "three.core.js"));
  return dir;
}

const base = (body: string) => `import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(400, 300);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x102030);
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
camera.position.set(0, 0, 5);
${body}
renderer.setAnimationLoop(() => renderer.render(scene, camera));
`;

const kinds = (r: Awaited<ReturnType<typeof check>>) => r.scene?.diagnoses.map((d) => d.kind) ?? [];

describe.skipIf(!have)("inspect (needs Chromium)", () => {
  it("reads the scene graph, camera and renderer stats", async () => {
    const r = await check({ target: page(base(`scene.add(new THREE.AmbientLight(0xffffff, 1)); const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); m.name = 'crate'; m.position.x = 1; scene.add(m);`)), wait: 500, inspect: true, leakMs: 300 });
    expect(r.scene?.found).toBe(true);
    expect(r.scene?.camera?.fov).toBe(60);
    expect(r.scene?.renderer?.calls).toBeGreaterThan(0);
    expect(r.scene?.nodes.some((n) => n.name === "crate" && n.geometry === "BoxGeometry" && n.vertices === 24)).toBe(true);
    expect(r.scene?.diagnoses.filter((d) => d.severity !== "info")).toEqual([]);
    expect(formatScene(r.scene!)).toContain('Mesh "crate"');
  }, 60_000);

  it("says why a lit scene is black", async () => {
    const r = await check({ target: page(base(`scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));`)), wait: 500, inspect: true, leakMs: 0 });
    expect(kinds(r)).toContain("no-light");
  }, 60_000);

  it("explains a blank frame without being asked: camera looking away", async () => {
    const r = await check({ target: page(base(`scene.add(new THREE.AmbientLight()); const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: 0xff0000 })); m.position.z = 10; scene.add(m);`)), wait: 500 });
    expect(r.issues.map((i) => i.kind)).toContain("blank");
    expect(kinds(r)).toContain("behind-camera");
    expect(kinds(r)).toContain("nothing-visible");
    expect(r.issues.some((i) => i.kind === "scene" && /None of the/.test(i.message))).toBe(true);
  }, 60_000);

  it("finds the camera inside an object, zero scale and hidden objects", async () => {
    const r = await check({ target: page(base(`
      const big = new THREE.Mesh(new THREE.SphereGeometry(20), new THREE.MeshBasicMaterial()); big.name = 'sky'; scene.add(big);
      const flat = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); flat.name = 'flat'; flat.scale.set(0, 0, 0); scene.add(flat);
      const ghost = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 })); ghost.name = 'ghost'; scene.add(ghost);`)), wait: 500, inspect: true, leakMs: 0 });
    const d = r.scene!.diagnoses;
    expect(d.find((x) => x.kind === "camera-inside")?.object).toContain("sky");
    expect(d.find((x) => x.kind === "zero-scale")?.object).toContain("flat");
    expect(d.find((x) => x.kind === "invisible-material")?.object).toContain("ghost");
  }, 60_000);

  it("catches a GPU memory leak", async () => {
    const r = await check({ target: page(base(`scene.add(new THREE.AmbientLight());
      let mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); scene.add(mesh);
      setInterval(() => { scene.remove(mesh); mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); scene.add(mesh); }, 30);`)), wait: 400, inspect: true, leakMs: 800 });
    expect(r.issues.map((i) => i.kind)).toContain("leak");
    expect(r.scene!.memory!.after.geometries).toBeGreaterThan(r.scene!.memory!.before.geometries);
  }, 60_000);

  it("maps a shader error to the user's file and line, and explains it", async () => {
    const dir = page(base(`import { frag } from './shader.js';
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.ShaderMaterial({ fragmentShader: frag })));`), {
      "shader.js": "export const frag = /* glsl */ `\nvoid main() {\n  gl_FragColor = vec4(colr, 1.0);\n}\n`;\n",
    });
    const r = await check({ target: dir, wait: 500 });
    const issue = r.issues.find((i) => i.shader?.length);
    expect(issue, JSON.stringify(r.issues, null, 1)).toBeDefined();
    expect(issue!.shader![0]!.message).toContain("colr");
    expect(issue!.shader![0]!.source).toBe("shader.js:3");
    expect(issue!.explanations?.[0]?.id).toBe("shader-error");
  }, 60_000);

  it("explains a wrong import with the right path", async () => {
    const r = await check({ target: page(`import { OrbitControls } from 'three';\nconsole.log(OrbitControls);`), wait: 300 });
    const e = r.issues.find((i) => i.explanations?.some((x) => x.id === "export-not-found"));
    expect(e).toBeDefined();
    expect(e!.explanations!.find((x) => x.id === "export-not-found")!.detail).toContain("three/addons/controls/OrbitControls.js");
  }, 60_000);
});
