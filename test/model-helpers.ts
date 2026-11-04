import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";

const folders: string[] = [];
// The folders go when the test file is done, so a run leaves nothing behind in the temp folder.
afterAll(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new empty folder under the system temp folder, removed when the tests end. */
export function tempFolder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  folders.push(dir);
  return dir;
}

/** A temp folder with these files in it. */
export function makeProject(files: Record<string, string>): string {
  const root = tempFolder("threesmith-model-");
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** True where the test machine can make symbolic links (not on Windows without rights). */
export const CAN_SYMLINK: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), "threesmith-link-"));
  try {
    mkdirSync(join(dir, "target"));
    symlinkSync(join(dir, "target"), join(dir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

export interface TestMesh {
  positions: number[];
  indices: number[];
  normals?: number[];
  uv?: number[];
  tangents?: number[];
  material?: number;
}

export interface TestModel {
  meshes: TestMesh[];
  materials?: object[];
  /** One entry per node: name, mesh index and optional transform parts. */
  nodes?: { name?: string; mesh?: number; scale?: number[]; translation?: number[]; children?: number[] }[];
  /** Sizes of fake PNG images; each becomes image + texture with the same index. */
  images?: { width: number; height: number }[];
  roots?: number[];
}

function pad(buffer: Buffer, fill: number): Buffer {
  const extra = (4 - (buffer.length % 4)) % 4;
  return extra ? Buffer.concat([buffer, Buffer.alloc(extra, fill)]) : buffer;
}

function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  head.writeUInt32BE(0x89504e47, 0);
  head.writeUInt32BE(0x0d0a1a0a, 4);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

/** Writes a small binary glTF from plain arrays and returns its path. */
export function writeGlb(model: TestModel): string {
  const chunks: Buffer[] = [];
  const views: object[] = [];
  const accessors: object[] = [];
  let offset = 0;
  const addView = (data: Buffer, target?: number): number => {
    const padded = pad(data, 0);
    views.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...(target ? { target } : {}) });
    chunks.push(padded);
    offset += padded.length;
    return views.length - 1;
  };
  const addFloats = (values: number[], type: string, width: number): number => {
    const data = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => data.writeFloatLE(v, i * 4));
    const count = values.length / width;
    const bufferView = addView(data, 34962);
    accessors.push({ bufferView, componentType: 5126, count, type });
    return accessors.length - 1;
  };
  const meshes = model.meshes.map((m) => {
    const attributes: Record<string, number> = { POSITION: addFloats(m.positions, "VEC3", 3) };
    if (m.normals) attributes.NORMAL = addFloats(m.normals, "VEC3", 3);
    if (m.uv) attributes.TEXCOORD_0 = addFloats(m.uv, "VEC2", 2);
    if (m.tangents) attributes.TANGENT = addFloats(m.tangents, "VEC4", 4);
    const idx = Buffer.alloc(m.indices.length * 4);
    m.indices.forEach((v, i) => idx.writeUInt32LE(v, i * 4));
    const indices = addView(idx, 34963);
    accessors.push({ bufferView: indices, componentType: 5125, count: m.indices.length, type: "SCALAR" });
    return { primitives: [{ attributes, indices: accessors.length - 1, ...(m.material === undefined ? {} : { material: m.material }) }] };
  });
  const images = (model.images ?? []).map((img) => ({ bufferView: addView(png(img.width, img.height)), mimeType: "image/png" }));
  const nodes: NonNullable<TestModel["nodes"]> = model.nodes ?? model.meshes.map((_, i) => ({ name: `Mesh${i}`, mesh: i }));
  const json = {
    asset: { version: "2.0", generator: "threesmith-test" },
    scene: 0,
    scenes: [{ nodes: model.roots ?? nodes.map((_, i) => i).filter((i) => !nodes.some((n) => n.children?.includes(i))) }],
    nodes,
    meshes,
    materials: model.materials ?? [],
    textures: images.map((_, i) => ({ source: i })),
    images,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  };
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonChunk.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  const path = join(tempFolder("threesmith-glb-"), "model.glb");
  writeFileSync(path, Buffer.concat([header, jh, jsonChunk, bh, bin]));
  return path;
}

/** A closed box from y = 0 to y = 1 with outward faces, normals and UVs. */
export function box(width = 1, height = 1, depth = 1): TestMesh {
  const x = width / 2, z = depth / 2;
  const faces: { n: number[]; v: number[][] }[] = [
    { n: [0, 0, 1], v: [[-x, 0, z], [x, 0, z], [x, height, z], [-x, height, z]] },
    { n: [0, 0, -1], v: [[x, 0, -z], [-x, 0, -z], [-x, height, -z], [x, height, -z]] },
    { n: [1, 0, 0], v: [[x, 0, z], [x, 0, -z], [x, height, -z], [x, height, z]] },
    { n: [-1, 0, 0], v: [[-x, 0, -z], [-x, 0, z], [-x, height, z], [-x, height, -z]] },
    { n: [0, 1, 0], v: [[-x, height, z], [x, height, z], [x, height, -z], [-x, height, -z]] },
    { n: [0, -1, 0], v: [[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z]] },
  ];
  const mesh: TestMesh = { positions: [], indices: [], normals: [], uv: [] };
  faces.forEach((f, i) => {
    f.v.forEach((p, k) => {
      mesh.positions.push(...p);
      mesh.normals?.push(...f.n);
      mesh.uv?.push(k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0);
    });
    const b = i * 4;
    mesh.indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return mesh;
}

/** Rewrites the JSON chunk of a .glb file in place, so a test can change one field of it. */
export function editGlbJson(path: string, edit: (json: any) => void): string {
  const data = readFileSync(path);
  const jsonLength = data.readUInt32LE(12);
  const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString("utf8"));
  edit(json);
  const body = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4, 0x20)]);
  const header = Buffer.from(data.subarray(0, 12));
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(padded.length, 0);
  jsonHead.writeUInt32LE(0x4e4f534a, 4);
  const rest = data.subarray(20 + jsonLength);
  header.writeUInt32LE(12 + 8 + padded.length + rest.length, 8);
  writeFileSync(path, Buffer.concat([header, jsonHead, padded, rest]));
  return path;
}
