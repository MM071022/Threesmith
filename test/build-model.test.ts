import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { EXAMPLE_SPEC, allKinds, buildModel, formatModelInfo, inspectModel, lintModelFile, modelNeeds, sanitizeNodeName } from "../src/model/index.js";
import { box, writeGlb } from "./model-helpers.js";

// Building and linting the detailed ready-made models takes a few seconds on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

/** The bits of three's Object3D these tests read (three ships no types and adding @types/three is not worth it here). */
interface Object3D {
  name: string;
  type: string;
  matrixWorld: { elements: number[] };
  traverse(fn: (o: Object3D) => void): void;
  getObjectByName(name: string): Object3D | undefined;
  updateWorldMatrix(parents: boolean, children: boolean): void;
}
type Loader = new () => { parse(data: ArrayBuffer, path: string, onLoad: (gltf: { scene: Object3D }) => void, onError: (error: unknown) => void): void };

/** Parses .glb bytes with three's own GLTFLoader, in Node (no DOM: only files without textures). */
async function parse(glb: Uint8Array): Promise<{ scene: Object3D }> {
  const path: string = "three/examples/jsm/loaders/GLTFLoader.js";
  const { GLTFLoader } = (await import(path)) as { GLTFLoader: Loader };
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, "", resolve, reject));
}

describe("buildModel", () => {
  it("builds in memory: bytes, name, lint, info and a contract, and writes no file", () => {
    // The build module only computes: it imports nothing that writes files.
    expect(readFileSync(fileURLToPath(new URL("../src/build/run.ts", import.meta.url)), "utf8")).not.toMatch(/node:fs/);
    const built = buildModel({ kind: "crate", textures: false });
    expect(built.name).toBe("crate");
    expect(Buffer.from(built.glb.subarray(0, 4)).toString("latin1")).toBe("glTF");
    expect(built.info.triangles).toBeGreaterThan(0);
    expect(built.report.archetype).toBe("prop.crate");
    expect(built.contract.nodes?.length).toBe(built.info.nodes.length);
    expect(built.summary).toMatch(/^built crate\.glb: \d+ KB, /);
  });

  it("is deterministic, and a seed changes a kind that has one", () => {
    const a = buildModel({ kind: "house", seed: 7, textures: false }).glb;
    expect(Buffer.from(buildModel({ kind: "house", seed: 7, textures: false }).glb).equals(Buffer.from(a))).toBe(true);
    expect(Buffer.from(buildModel({ kind: "house", seed: 8, textures: false }).glb).equals(Buffer.from(a))).toBe(false);
    expect(() => buildModel({ kind: "crate", seed: 1 })).toThrow(/no seed parameter/);
  });

  it("names a spec build after the spec, and returns the heightmap of a terrain tile", () => {
    expect(buildModel({ spec: EXAMPLE_SPEC }).name).toBe("car");
    expect(buildModel({ spec: EXAMPLE_SPEC, name: "my-car.glb" }).name).toBe("my-car");
    const tile = buildModel({ kind: "terrain", params: { resolution: "33" }, textures: false });
    expect(tile.heightmap?.size).toBe(33);
    expect(tile.heightmap?.heights).toHaveLength(33 * 33);
  });

  it("builds files that need no decoder in three.js", () => {
    const built = buildModel({ kind: "barn" });
    expect(modelNeeds(built.info).setups).toEqual([]);
    expect(built.info.extensionsRequired).toEqual([]);
  });

  it("lints a sample of kinds clean: no errors or warnings, including the three.js checks", () => {
    for (const kind of ["car", "helicopter", "house", "tree", "chair", "street-lamp", "windmill", "sailboat"]) {
      const built = buildModel({ kind, textures: false });
      const bad = built.report.findings.filter((f) => f.severity !== "info").map((f) => `${f.rule} ${f.node ?? ""} ${f.message}`);
      expect(bad, kind).toEqual([]);
      expect(lintModelFile(built.glb).failed, kind).toBe(false);
    }
  });

  it("gives every node a unique name, so getObjectByName finds each part", () => {
    for (const k of allKinds().filter((k) => !["terrain", "sea"].includes(k.kind))) {
      const names = buildModel({ kind: k.kind, textures: false }).info.nodes.map((n) => n.name);
      expect(new Set(names).size, k.kind).toBe(names.length);
    }
  }, 60000);
});

describe("three's GLTFLoader reads a built model", () => {
  it("parses the bytes in Node and keeps every node name, pivot and mesh", async () => {
    const built = buildModel({ spec: EXAMPLE_SPEC, textures: false });
    const gltf = await parse(built.glb);
    const names: string[] = [];
    gltf.scene.traverse((o) => names.push(o.name));
    for (const n of built.info.nodes) expect(names, n.name).toContain(n.name);
    const wheel = gltf.scene.getObjectByName("Wheel_FL")!;
    expect(wheel.type).toBe("Mesh");
    const origin = built.info.nodes.find((n) => n.name === "Wheel_FL")!.origin;
    wheel.updateWorldMatrix(true, false);
    const e = wheel.matrixWorld.elements;
    expect([e[12], e[13], e[14]].map((v) => Number(v!.toFixed(4)))).toEqual(origin.map((v) => Number(v.toFixed(4))));
  });

  it("parses a mirrored assembly with the same names the file has", async () => {
    const built = buildModel({ kind: "sailboat", textures: false });
    const gltf = await parse(built.glb);
    const names = new Set<string>();
    gltf.scene.traverse((o) => names.add(o.name));
    for (const n of built.info.nodes) expect(names.has(n.name), n.name).toBe(true);
  });

  it("inspects the same model from bytes and from the parsed scene sizes", () => {
    const built = buildModel({ kind: "chair", textures: false });
    expect(inspectModel(built.glb).bounds).toEqual(built.info.bounds);
  });

  it("renames nodes exactly as the lint says it will", async () => {
    const names = ["Wheel.001", "Left Door", "a:b/c[0]", "Plain"];
    const path = writeGlb({ meshes: [box()], nodes: names.map((name, i) => ({ name, mesh: 0, translation: [i * 2, 0, 0] })) });
    const gltf = await parse(readFileSync(path));
    const loaded: string[] = [];
    gltf.scene.traverse((o) => loaded.push(o.name));
    for (const n of names) expect(loaded, n).toContain(sanitizeNodeName(n));
    expect(sanitizeNodeName("Left Door")).toBe("Left_Door");
  });
});

describe("model summary", () => {
  it("says how three.js loads it and how many draw calls it costs", () => {
    const text = formatModelInfo(buildModel({ spec: EXAMPLE_SPEC, textures: false }).info);
    expect(text).toContain("loads with: a plain GLTFLoader (no decoders)");
    expect(text).toMatch(/three\.js: about \d+ draw calls/);
  });
});
