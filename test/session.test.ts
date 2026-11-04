import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { formatErrors, listSessions, pageOp, startSession, stopAll } from "../src/session/session.js";
import { project, THREE_DIR } from "./helpers.js";

const have = !!findChromium();

function page(script: string): string {
  const dir = project({
    "index.html": `<!doctype html><html><body style="margin:0"><button id="go">go</button><script type="importmap">{"imports":{"three":"./three/three.module.js"}}</script><script type="module">${script}</script></body></html>`,
  });
  mkdirSync(join(dir, "three"), { recursive: true });
  cpSync(join(THREE_DIR, "build", "three.module.js"), join(dir, "three", "three.module.js"));
  cpSync(join(THREE_DIR, "build", "three.core.js"), join(dir, "three", "three.core.js"));
  return dir;
}

const scene = `
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(320, 240);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 4/3, 0.1, 100);
camera.position.z = 4;
scene.add(new THREE.AmbientLight(0xffffff, 2));
const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x44aa88 }));
box.name = 'box';
scene.add(box);
let speed = 0;
document.getElementById('go').addEventListener('click', () => { speed = 0.5; });
renderer.setAnimationLoop(() => { box.position.x += speed * 0.016; renderer.render(scene, camera); });
`;

afterAll(async () => {
  await stopAll();
});

describe.skipIf(!have)("live page (needs Chromium)", () => {
  it("starts once and answers eval, steps, until, screenshot and inspect", async () => {
    const s = await startSession({ target: page(scene), wait: 500 }, "t1");
    expect(s.threeRevision).toBe("187");
    expect(s.objects).toBeGreaterThan(1);
    expect(listSessions().map((x) => x.name)).toContain("t1");

    const pos = await pageOp({ op: "eval", js: "$('box').position" }, "t1");
    expect(pos.value).toEqual([0, 0, 0]);
    const many = await pageOp({ op: "eval", js: "const n = scene.children.length; return { n, cam: camera.position };" }, "t1");
    expect(many.value).toEqual({ n: 2, cam: [0, 0, 4] });

    await pageOp({ op: "steps", steps: [{ type: "click", selector: "#go" }] }, "t1");
    const moved = await pageOp({ op: "until", js: "$('box').position.x > 0.05", timeout: 5000 }, "t1");
    expect(moved.ok).toBe(true);

    const shot = await pageOp({ op: "screenshot" }, "t1");
    expect(shot.image?.length).toBeGreaterThan(100);
    expect(shot.text).not.toContain("nothing visible");
    const inspect = await pageOp({ op: "inspect" }, "t1");
    expect(inspect.text).toContain("box");

    const bad = await pageOp({ op: "eval", js: "$('nope').position" }, "t1");
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("error");
  }, 60_000);

  it("reports new page errors after each answer", async () => {
    await startSession({ target: page(scene + "\nwindow.boom = () => setTimeout(() => { throw new Error('kaboom'); });"), wait: 300 }, "t2");
    await pageOp({ op: "eval", js: "boom()" }, "t2");
    const next = await pageOp({ op: "frames", n: 5 }, "t2");
    expect(formatErrors(next.errors)).toContain("kaboom");
    const after = await pageOp({ op: "frames", n: 1 }, "t2");
    expect(after.errors).toEqual([]);
  }, 60_000);
});

describe("live page without a session", () => {
  it("says how to start one", async () => {
    await expect(pageOp({ op: "screenshot" }, "none")).rejects.toThrow(/three_session op start/);
  });
});
