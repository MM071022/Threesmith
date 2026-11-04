import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAssets, formatAssets, gltfExtensions, imageSize } from "../src/scan/assets.js";
import { collect } from "../src/review/source.js";
import { formatProjectMap, scanProject } from "../src/scan/scan.js";
import { formatTriage, triage } from "../src/doctor/triage.js";
import { encodePng } from "../src/check/png.js";
import { project } from "./helpers.js";

function glb(json: object): Buffer {
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const chunk = Buffer.from(text);
  const out = Buffer.alloc(20 + chunk.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(chunk.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  chunk.copy(out, 20);
  return out;
}

const assets = (files: Record<string, string>) => {
  const dir = project(files);
  return { dir, r: checkAssets(dir, collect(dir).files) };
};

describe("assets", () => {
  it("finds public files at /, relative files, and misses", () => {
    const { r } = assets({
      "package.json": "{}",
      "public/models/car.glb": "x",
      "src/tex.png": "x",
      "src/main.js": "import * as THREE from 'three';\nloader.load('/models/car.glb');\nnew URL('./tex.png', import.meta.url);\nloader.load('/models/boat.glb');\nfetch(`/levels/${n}.glb`);\nload('https://example.com/a.glb');\n",
    });
    const by = Object.fromEntries(r.refs.map((x) => [x.ref, x.status]));
    expect(by["/models/car.glb"]).toBe("ok");
    expect(by["./tex.png"]).toBe("ok");
    expect(by["/models/boat.glb"]).toBe("missing");
    expect(by["/levels/${n}.glb"]).toBe("dynamic");
    expect(by["https://example.com/a.glb"]).toBe("remote");
    expect(formatAssets(r)).toContain("src/main.js:4 [asset-missing]");
  });

  it("catches a path that only works on a case-insensitive disk", () => {
    const { r } = assets({ "package.json": "{}", "public/Models/Car.glb": "x", "main.js": "import 'three';\nloader.load('/models/car.glb');\n" });
    expect(r.problems[0]?.kind).toBe("case");
    expect(r.problems[0]?.message).toContain("public/Models/Car.glb");
  });

  it("uses loader.setPath and suggests a file with the same name", () => {
    const { r } = assets({ "package.json": "{}", "public/gltf/ship.glb": "x", "assets/tree.glb": "x", "main.js": "import 'three';\nloader.setPath('/gltf/');\nloader.load('ship.glb');\nloader.load('/tree.glb');\n" });
    expect(r.refs.find((x) => x.ref === "ship.glb")?.status).toBe("ok");
    const miss = r.problems.find((p) => p.kind === "missing");
    expect(miss?.fix).toContain("assets/tree.glb");
  });

  it("checks decoder folders and glTF decoder setup", () => {
    const dir = project({
      "package.json": "{}",
      "main.js": "import 'three';\nconst d = new DRACOLoader();\nd.setDecoderPath('/draco/');\nloader.load('/car.glb');\nloader.load('/tree.glb');\n",
    });
    writeFileSync(join(dir, "car.glb"), glb({ asset: { version: "2.0" }, extensionsUsed: ["EXT_meshopt_compression"] }));
    writeFileSync(join(dir, "tree.glb"), glb({ asset: { version: "2.0" }, extensionsUsed: ["KHR_draco_mesh_compression"] }));
    expect(gltfExtensions(join(dir, "car.glb"))).toEqual(["EXT_meshopt_compression"]);
    const r = checkAssets(dir, collect(dir).files);
    const kinds = r.problems.map((p) => `${p.kind}:${p.file}`);
    expect(kinds).toContain("decoder-folder:main.js");
    expect(kinds).toContain("decoder-setup:car.glb");
    // Draco is set up in the code, so tree.glb is fine
    expect(kinds).not.toContain("decoder-setup:tree.glb");
  });

  it("reads image sizes and flags textures above 4096", () => {
    const dir = project({ "package.json": "{}", "main.js": "import 'three';\nnew TextureLoader().load('/big.png');\n" });
    writeFileSync(join(dir, "public.png"), "");
    const img = { width: 4100, height: 2, data: new Uint8Array(4100 * 2 * 4) };
    writeFileSync(join(dir, "big.png"), encodePng(img));
    expect(imageSize(join(dir, "big.png"))).toEqual({ width: 4100, height: 2 });
    const r = checkAssets(dir, collect(dir).files);
    expect(r.problems.some((p) => p.kind === "large-texture")).toBe(true);
  });
});

describe("scan", () => {
  it("maps the stack, files, renderer settings and notes", () => {
    const dir = project({
      "package.json": JSON.stringify({ name: "demo", scripts: { dev: "vite", build: "vite build" }, dependencies: { three: "^0.187.0" }, devDependencies: { vite: "^7.0.0" } }),
      "index.html": '<script type="module" src="/src/main.js"></script>',
      "src/main.js":
        "import * as THREE from 'three';\nimport { OrbitControls } from 'three/addons/controls/OrbitControls.js';\nconst renderer = new THREE.WebGLRenderer({ antialias: true });\nrenderer.toneMapping = THREE.ACESFilmicToneMapping;\nrenderer.setPixelRatio(Math.min(devicePixelRatio, 2));\nconst camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);\nnew OrbitControls(camera, renderer.domElement);\nrenderer.setAnimationLoop(() => renderer.render(scene, camera));\n",
    });
    const m = scanProject(join(dir, "src"));
    expect(m.root).toBe(dir);
    expect(m.stack.bundler).toBe("vite");
    expect(m.files[0]?.creates).toMatchObject({ WebGLRenderer: 1, PerspectiveCamera: 1, OrbitControls: 1 });
    expect(m.files[0]?.loop).toBe(8);
    expect(m.renderer["toneMapping"]).toBe("THREE.ACESFilmicToneMapping");
    expect(m.notes.join(" ")).toContain("not installed");
    const text = formatProjectMap(m);
    expect(text).toContain("stack: vite");
    expect(text).toContain("src/main.js (9 lines): WebGLRenderer PerspectiveCamera OrbitControls; loop at 8");
  });

  it("notes three and three/webgpu together", () => {
    const m = scanProject(project({ "package.json": "{}", "a.js": "import * as THREE from 'three';\nimport { WebGPURenderer } from 'three/webgpu';\nnew WebGPURenderer();\n" }));
    expect(m.notes.join(" ")).toContain("share one core");
  });
});

describe("doctor triage", () => {
  it("groups by cause, most urgent first, with next steps", () => {
    const dir = project({
      "package.json": "{}",
      "main.js": "import * as THREE from 'three';\nconst g = new THREE.BoxBufferGeometry(1, 1, 1);\nconst m = new THREE.MeshStandardMaterial();\nconst mesh = new THREE.Mesh(g, m);\nloader.load('/missing.glb');\n",
    });
    const t = triage(dir);
    expect(t.ok).toBe(false);
    expect(t.groups.map((g) => g.id)).toContain("assets");
    expect(t.groups[0]!.severity).toBe("error");
    const text = formatTriage(t);
    expect(text).toMatch(/^Threesmith doctor: /);
    expect(text).toContain("(three_fix)");
    expect(text).toContain("Next:");
    expect(t.next.join(" ")).toContain("three_fix");
  });
});
