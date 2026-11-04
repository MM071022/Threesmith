import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { imageSize } from "../src/model/images.js";
import { inspectModel } from "../src/model/inspect.js";
import { lintModel, lintModelFile } from "../src/model/lint.js";
import { checkModelSetup, extensionSupport, formatModelNeeds, modelNeeds } from "../src/model/needs.js";
import { viewModel } from "../src/model/view.js";
import { box, editGlbJson, writeGlb } from "./model-helpers.js";

const THREE_JSM = resolve("node_modules/three/examples/jsm");
const needsOf = (used: string[], required: string[] = []) => modelNeeds({ file: "m.glb", extensionsUsed: used, extensionsRequired: required });
const rules = (path: string) => lintModelFile(path).findings.map((f) => f.rule);

/** A box whose primitive claims Draco compression: no bufferView on its accessors, only min/max. */
function dracoBox(): string {
  return editGlbJson(writeGlb({ meshes: [box(2, 1, 4)] }), (j) => {
    j.extensionsUsed = ["KHR_draco_mesh_compression"];
    j.extensionsRequired = ["KHR_draco_mesh_compression"];
    const prim = j.meshes[0].primitives[0];
    prim.extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0, NORMAL: 1 } } };
    for (const a of j.accessors) delete a.bufferView;
    j.accessors[0].min = [-1, 0, -2];
    j.accessors[0].max = [1, 1, 2];
  });
}

describe("modelNeeds", () => {
  it("needs nothing for a plain file", () => {
    const needs = needsOf([]);
    expect(needs.setups).toEqual([]);
    expect(needs.code).toContain("import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';");
    expect(formatModelNeeds(needs)).toContain("A plain GLTFLoader reads it");
  });

  it("asks for a DRACOLoader, the meshopt decoder and a KTX2Loader with detectSupport", () => {
    const needs = needsOf(["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"], ["KHR_draco_mesh_compression"]);
    expect(Object.fromEntries(needs.setups.map((s) => [s.id, s.required]))).toEqual({ draco: true, meshopt: false, ktx2: false });
    const draco = needs.setups.find((s) => s.id === "draco")!;
    expect(draco.code).toContain("gltfLoader.setDRACOLoader(dracoLoader)");
    expect(needs.setups.find((s) => s.id === "meshopt")!.code).toBe("gltfLoader.setMeshoptDecoder(MeshoptDecoder);");
    const ktx2 = needs.setups.find((s) => s.id === "ktx2")!;
    expect(ktx2.code).toContain("ktx2Loader.detectSupport(renderer)");
    expect(ktx2.code).toContain("gltfLoader.setKTX2Loader(ktx2Loader)");
    expect(needs.code.indexOf("DRACOLoader")).toBeLessThan(needs.code.indexOf("loadAsync"));
  });

  it("merges EXT_ and KHR_meshopt_compression into one setup", () => {
    const needs = needsOf(["EXT_meshopt_compression", "KHR_meshopt_compression"]);
    expect(needs.setups).toHaveLength(1);
    expect(needs.setups[0]!.extensions).toEqual(["EXT_meshopt_compression", "KHR_meshopt_compression"]);
  });

  it("only names import paths that exist in the installed three", () => {
    const needs = needsOf(["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu", "KHR_gaussian_splatting"]);
    const paths = needs.setups.flatMap((s) => s.imports).map((line) => /'three\/addons\/(.+)'/.exec(line)![1]!);
    expect(paths).toHaveLength(4);
    for (const p of paths) expect(existsSync(`${THREE_JSM}/${p}`), p).toBe(true);
    expect(existsSync(`${THREE_JSM}/loaders/GLTFLoader.js`)).toBe(true);
    expect(existsSync(`${THREE_JSM}/libs/draco/draco_decoder.wasm`)).toBe(true);
    expect(existsSync(`${THREE_JSM}/libs/basis/basis_transcoder.wasm`)).toBe(true);
  });

  it("describes material and texture extensions, and flags ones GLTFLoader does not know", () => {
    const needs = needsOf(["KHR_materials_emissive_strength", "KHR_materials_transmission", "EXT_texture_webp", "KHR_materials_pbrSpecularGlossiness", "VENDOR_thing", "KHR_materials_variants"], ["VENDOR_thing"]);
    const by = Object.fromEntries(needs.extensions.map((e) => [e.name, e]));
    expect(by["KHR_materials_emissive_strength"]!.note).toContain("emissiveIntensity");
    expect(by["KHR_materials_transmission"]!.note).toContain("render target");
    expect(by["EXT_texture_webp"]!.support).toBe("core");
    expect(by["KHR_materials_pbrSpecularGlossiness"]!.support).toBe("unsupported");
    expect(by["VENDOR_thing"]).toMatchObject({ support: "unsupported", required: true });
    expect(by["KHR_materials_variants"]!.support).toBe("plugin");
    expect(extensionSupport("constructor")).toBeUndefined();
  });

  it("knows every extension GLTFLoader lists as supported", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(`${THREE_JSM}/loaders/GLTFLoader.js`, "utf8");
    const listed = [...source.slice(source.indexOf("supports the following glTF 2.0 extensions"), source.indexOf("supported by separately registered plugins")).matchAll(/^ \* - (\w+)$/gm)].map((m) => m[1]!);
    expect(listed.length).toBeGreaterThan(15);
    for (const name of listed) expect(["core", "setup"], name).toContain(extensionSupport(name)?.support);
  });
});

describe("checkModelSetup", () => {
  const draco = needsOf(["KHR_draco_mesh_compression"], ["KHR_draco_mesh_compression"]);
  const ktx2 = needsOf(["KHR_texture_basisu"]);

  it("reports a Draco model when no source calls setDRACOLoader, as an error when it is required", () => {
    const problems = checkModelSetup(draco, "import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';\nnew GLTFLoader().load('/m.glb');");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ setup: "draco", severity: "error", files: ["m.glb"] });
    expect(problems[0]!.fix).toContain("setDRACOLoader");
  });

  it("is quiet once the setup is there, in any of the source files", () => {
    const files = { "a.js": "import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';", "b.js": "loader.setDRACOLoader(new DRACOLoader());" };
    expect(checkModelSetup(draco, files)).toEqual([]);
    expect(checkModelSetup([draco, needsOf([])], Object.values(files))).toEqual([]);
  });

  it("catches a KTX2Loader without detectSupport", () => {
    const half = "import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';\nconst k = new KTX2Loader();\ngltfLoader.setKTX2Loader(k);";
    const problems = checkModelSetup(ktx2, half);
    expect(problems.map((p) => p.message).join(" ")).toMatch(/detectSupport/);
    expect(problems[0]!.severity).toBe("warning");
    expect(checkModelSetup(ktx2, `${half}\nk.detectSupport(renderer);`)).toEqual([]);
  });

  it("accepts drei's useGLTF for Draco and meshopt, and notes a project that loads no glTF at all", () => {
    expect(checkModelSetup(draco, "const { scene } = useGLTF('/m.glb');")).toEqual([]);
    expect(checkModelSetup(ktx2, "const { scene } = useGLTF('/m.glb');").map((p) => p.setup)).toEqual(["ktx2"]);
    expect(checkModelSetup(needsOf([]), "console.log(1)").map((p) => p.setup)).toEqual(["gltf-loader"]);
    expect(checkModelSetup([], "")).toEqual([]);
  });
});

describe("compressed and modern files", () => {
  it("reads a Draco file from its accessor bounds, and says what it could not check", () => {
    const path = dracoBox();
    const info = inspectModel(path);
    expect(info.extensionsRequired).toEqual(["KHR_draco_mesh_compression"]);
    expect(info.triangles).toBe(12);
    expect(info.bounds?.size).toEqual([2, 1, 4]);
    expect(info.primitives[0]!.compressed).toBe("draco");
    const found = rules(path);
    expect(found).toEqual(expect.arrayContaining(["model/needs-decoder", "model/compressed-geometry"]));
    expect(found).not.toContain("model/flipped-faces");
    expect(found).not.toContain("model/open-edges");
    expect(viewModel(info)).toContain("drawn as its bounding box");
  });

  it("reads a meshopt file whose fallback buffer is empty", () => {
    const path = editGlbJson(writeGlb({ meshes: [box()] }), (j) => {
      j.extensionsUsed = ["EXT_meshopt_compression"];
      j.buffers.push({ byteLength: 4096, extensions: { EXT_meshopt_compression: { fallback: true } } });
      j.bufferViews[0] = { buffer: 1, byteLength: 288, extensions: { EXT_meshopt_compression: { buffer: 0, byteLength: 100, byteStride: 12, count: 24, mode: "ATTRIBUTES" } } };
      j.accessors[0].min = [-0.5, 0, -0.5];
      j.accessors[0].max = [0.5, 1, 0.5];
    });
    const info = inspectModel(path);
    expect(info.primitives[0]!.compressed).toBe("meshopt");
    expect(info.bounds?.size).toEqual([1, 1, 1]);
  });

  it("reads WebP and KTX2 sizes, and counts KTX2 at a quarter of the memory", () => {
    const vp8x = Buffer.alloc(30);
    vp8x.write("RIFF", 0, "latin1");
    vp8x.write("WEBPVP8X", 8, "latin1");
    vp8x.writeUIntLE(1023, 24, 3);
    vp8x.writeUIntLE(511, 27, 3);
    expect(imageSize(vp8x)).toEqual({ width: 1024, height: 512, format: "webp" });
    const ktx = Buffer.alloc(32);
    Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ktx);
    ktx.writeUInt32LE(2048, 20);
    ktx.writeUInt32LE(2048, 24);
    expect(imageSize(ktx)).toEqual({ width: 2048, height: 2048, format: "ktx2" });
  });

  it("finds the image of a texture through KHR_texture_basisu", () => {
    const path = editGlbJson(writeGlb({ meshes: [box()], images: [{ width: 256, height: 256 }] }), (j) => {
      j.extensionsUsed = ["KHR_texture_basisu"];
      j.textures[0] = { extensions: { KHR_texture_basisu: { source: 0 } } };
    });
    const t = inspectModel(path).textures[0]!;
    expect(t).toMatchObject({ width: 256, extension: "KHR_texture_basisu" });
  });
});

describe("three.js runtime lint", () => {
  it("names the node GLTFLoader renames, and the second of two equal names", () => {
    const path = writeGlb({ meshes: [box()], nodes: [{ name: "Root", children: [1, 2] }, { name: "Wheel.001", mesh: 0 }, { name: "Group", children: [3] }, { name: "Root", mesh: 0, translation: [3, 0, 0] }], roots: [0] });
    const report = lintModelFile(path);
    const renamed = report.findings.find((f) => f.rule === "model/renamed-on-load")!;
    expect(renamed.message).toContain('"Wheel.001" becomes "Wheel001"');
    const dup = report.findings.find((f) => f.rule === "model/duplicate-node-names")!;
    expect(dup.message).toContain('"Root_1"');
  });

  it("warns at the web triangle budget by default", () => {
    expect(rules(writeGlb({ meshes: [box()] }))).not.toContain("model/triangle-budget");
    expect(lintModelFile(writeGlb({ meshes: [box()] }), { maxTriangles: 6 }).findings.find((f) => f.rule === "model/triangle-budget")?.message).not.toContain("web default");
  });

  it("notes textures above 2048 and warns above 4096", () => {
    const sev = (w: number) => lintModelFile(writeGlb({ meshes: [box()], images: [{ width: w, height: w }] })).findings.find((f) => f.rule === "model/texture-size")?.severity;
    expect(sev(2048)).toBeUndefined();
    expect(sev(4096)).toBe("info");
    expect(sev(8192)).toBe("warning");
  });

  it("counts draw calls, and flags a wrong unit, an origin beside the model and emissive strength", () => {
    const many = writeGlb({ meshes: [box(0.1, 0.1, 0.1)], nodes: Array.from({ length: 160 }, (_, i) => ({ name: `P${i}`, mesh: 0, translation: [(i % 16) * 0.1, 0, Math.floor(i / 16) * 0.1] })) });
    expect(lintModelFile(many).findings.find((f) => f.rule === "model/draw-calls")?.message).toMatch(/About 160 draw calls/);
    expect(rules(writeGlb({ meshes: [box(3000, 10, 10)] }))).toContain("model/scale-suspect");
    expect(rules(writeGlb({ meshes: [box(0.001, 0.001, 0.001)] }))).toContain("model/scale-suspect");
    expect(rules(writeGlb({ meshes: [box()], nodes: [{ name: "Off", mesh: 0, translation: [5, 0, 0] }] }))).toContain("model/origin-off-centre");
    const glow = writeGlb({ meshes: [{ ...box(), material: 0 }], materials: [{ name: "lamp", emissiveFactor: [1, 1, 1], extensions: { KHR_materials_emissive_strength: { emissiveStrength: 5 } } }] });
    expect(rules(glow)).toContain("model/emissive-strength");
  });

  it("reports an unsupported required extension as an error in the loading category", () => {
    const path = editGlbJson(writeGlb({ meshes: [box()] }), (j) => {
      j.extensionsUsed = ["VENDOR_magic"];
      j.extensionsRequired = ["VENDOR_magic"];
    });
    const report = lintModelFile(path);
    expect(report.findings.find((f) => f.rule === "model/unsupported-extension")).toMatchObject({ severity: "error", category: "loading" });
    expect(report.categories.find((c) => c.category === "loading")!.errors).toBe(1);
  });

  it("suggests compression for a big file without it", () => {
    const info = inspectModel(writeGlb({ meshes: [box()] }));
    const message = lintModel({ ...info, bytes: 12 * 1048576 }).findings.find((f) => f.rule === "model/uncompressed")?.message;
    expect(message).toContain("npx @gltf-transform/cli optimize in.glb out.glb --compress draco --texture-compress webp");
    expect(lintModel(info).findings.map((f) => f.rule)).not.toContain("model/uncompressed");
    expect(lintModel({ ...info, bytes: 12 * 1048576, extensionsUsed: ["KHR_draco_mesh_compression"] }).findings.map((f) => f.rule)).not.toContain("model/uncompressed");
  });
});
