// Renders ready-made model kinds with three.js itself (headless Chromium, software WebGL) into docs/gallery/.
// node scripts/gallery.mjs [kind ...]   (needs `npm run build` first)
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { buildModel } from "../dist/model/index.js";
import { serveStatic } from "../dist/check/server.js";
import { findChromium, WEBGL_ARGS } from "../dist/check/browser.js";

const repo = resolve(import.meta.dirname, "..");
const out = join(repo, "docs", "gallery");
const kinds = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["car", "truck", "bus", "tractor", "helicopter", "airliner", "fighter", "sailboat", "ship", "train", "house", "church", "castle", "windmill", "wind-turbine", "tree", "palm", "conifer", "street-lamp", "traffic-light", "dragon", "rocket", "satellite", "terrain"];

const dir = mkdtempSync(join(tmpdir(), "threesmith-gallery-"));
const three = join(repo, "node_modules", "three");
cpSync(join(three, "build"), join(dir, "three", "build"), { recursive: true });
for (const sub of ["loaders", "utils", "environments"]) cpSync(join(three, "examples", "jsm", sub), join(dir, "three", "addons", sub), { recursive: true });
writeFileSync(
  join(dir, "index.html"),
  `<!doctype html><html><body style="margin:0;background:#0f1419">
<script type="importmap">{"imports":{"three":"./three/build/three.module.js","three/addons/":"./three/addons/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(640, 480);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1419);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
scene.add(sun, new THREE.HemisphereLight(0xbfd7ff, 0x30261c, 0.6));
const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.MeshStandardMaterial({ color: 0x1b232d, roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const camera = new THREE.PerspectiveCamera(35, 4 / 3, 0.01, 10000);
window.show = async (url) => {
  const gltf = await new GLTFLoader().loadAsync(url);
  const model = gltf.scene;
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(model);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  ground.scale.setScalar(r * 1.6); ground.position.y = box.min.y - 0.001;
  const dir = new THREE.Vector3(1, 0.55, 1.25).normalize();
  // far enough that the whole bounding sphere fits the narrower (vertical) field of view
  const dist = Math.max(r * 1.9, (sphere.radius * 1.08) / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)));
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = r / 100; camera.far = r * 20; camera.updateProjectionMatrix();
  camera.lookAt(center);
  sun.position.copy(center).add(new THREE.Vector3(r, r * 2, r * 0.6));
  sun.target.position.copy(center); sun.target.updateMatrixWorld();
  const s = sun.shadow.camera; s.left = s.bottom = -r * 1.2; s.right = s.top = r * 1.2; s.far = r * 6; s.updateProjectionMatrix();
  renderer.render(scene, camera);
  await new Promise((d) => requestAnimationFrame(() => d()));
  renderer.render(scene, camera);
  const tris = renderer.info.render.triangles;
  scene.remove(model);
  return tris;
};
window.ready = true;
</script></body></html>`,
);
mkdirSync(out, { recursive: true });
if (process.env.GALLERY_DIR_ONLY) { console.log(dir); process.exit(0); }
const server = await serveStatic(dir);
const executablePath = findChromium();
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: WEBGL_ARGS });
const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("page:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("console:", m.text()); });
page.on("response", (r) => { if (r.status() >= 400) console.error("http", r.status(), r.url()); });
await page.goto(`${server.url}/index.html`);
await page.waitForFunction("window.ready === true", null, { timeout: 180_000 });
const made = [];
for (const kind of kinds) {
  const r = buildModel({ kind });
  writeFileSync(join(dir, `${kind}.glb`), r.glb);
  const tris = await page.evaluate(`window.show('./${kind}.glb')`);
  await page.locator("canvas").screenshot({ path: join(out, `${kind}.jpg`), type: "jpeg", quality: 82 });
  made.push({ kind, summary: r.summary, score: r.report.overall, tris });
  console.log(`${kind}: ${r.summary}`);
}
// keep the renders of kinds not rendered this time
let all = [];
try {
  all = JSON.parse(readFileSync(join(out, "gallery.json"), "utf8"));
} catch {
  all = [];
}
for (const m of made) {
  const i = all.findIndex((g) => g.kind === m.kind);
  if (i >= 0) all[i] = m;
  else all.push(m);
}
writeFileSync(join(out, "gallery.json"), JSON.stringify(all, null, 1) + "\n");
await browser.close();
await server.close();
rmSync(dir, { recursive: true, force: true });
