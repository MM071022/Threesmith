import { checkArchetype, compareArchetype, type Comparison } from "../archetype/check.js";
import { separateParts } from "./view.js";
import type { ResolvedArchetype } from "../archetype/types.js";
import { checkContract, type ModelContract } from "./contract.js";
import { inspectModel, transformPoint, type ModelInfo, type PrimitiveInfo } from "./inspect.js";
import { modelNeeds } from "./needs.js";
import { at } from "./num.js";
import { MODEL_CATEGORIES, MODEL_RULES, MODEL_WEIGHTS, type ModelCategory, type ModelFinding, type ModelSeverity } from "./rules.js";

export interface LintOptions {
  /** Triangle budget for the whole file; default 500,000 (a web page on an average phone or laptop). */
  maxTriangles?: number;
  /** Texture memory budget in MB; default 256. */
  maxTextureMb?: number;
  /** Draw calls (mesh and material pairs) above which an info is reported; default 150. */
  maxDrawCalls?: number;
  /** Node names, sizes and budget the model must keep. */
  contract?: ModelContract;
  /** What the model should be (see `model identify`): adds the archetype checks and category. */
  archetype?: ResolvedArchetype;
}

export interface ModelCategoryScore {
  category: ModelCategory;
  score: number;
  errors: number;
  warnings: number;
  infos: number;
}

export interface ModelReport {
  file: string;
  triangles: number;
  nodes: number;
  overall: number;
  /** The archetype id the model was checked against, when one was given. */
  archetype?: string;
  /** What the archetype check compared (parts found, nodes that matched nothing), when one was given. */
  compared?: Comparison;
  categories: ModelCategoryScore[];
  findings: ModelFinding[];
}

const PENALTY: Record<ModelSeverity, number> = { error: 12, warning: 4, info: 1 };
const RULE_CAP = 30;

/** The web defaults: what an average phone or laptop draws smoothly in a three.js page. */
export const WEB_BUDGET = { triangles: 500_000, textureMb: 256, drawCalls: 150, uncompressedMb: 10 };

/** Lints a model from a path or from the bytes of a .glb (`name` is then used in messages). */
export function lintModelFile(source: string | Uint8Array, options: LintOptions = {}, name?: string): ModelReport {
  return lintModel(inspectModel(source, name), options);
}

export function lintModel(info: ModelInfo, options: LintOptions = {}): ModelReport {
  const findings: ModelFinding[] = [];
  const add: Add = (rule, message, node, severity) => {
    const def = MODEL_RULES[rule];
    if (def) findings.push({ rule, category: def.category, severity: severity ?? def.severity, file: info.file, ...(node ? { node } : {}), message });
  };

  if (info.triangles === 0) {
    // Lines and points are a legal file with no surfaces to check, so they are not reported as a broken export.
    if (info.primitives.length > 0 && info.primitives.every((p) => !isSurface(p))) add("model/empty-geometry", "The file holds only lines or points, so it has no surfaces.", undefined, "info");
    else add("model/empty-geometry", "The file holds no triangles.");
  }
  checkRig(info, add);
  const uvReported = new Set<string>();
  const sheet = options.archetype?.sheet === true;
  for (const prims of primitivesByNode(info.primitives)) checkNode(info, prims, add, uvReported, sheet);
  checkTextures(info, options, add);
  checkSymmetry(info, add);
  checkThree(info, options, add);
  if (options.archetype?.sheet !== true) checkSeparateParts(info, add);
  if (options.contract) findings.push(...checkContract(info, options.contract));
  if (options.archetype && options.archetype.id !== "thing") findings.push(...checkArchetype(info, options.archetype));

  const budget = options.maxTriangles ?? WEB_BUDGET.triangles;
  if (info.triangles > budget) {
    add("model/triangle-budget", `${info.triangles.toLocaleString("en-US")} triangles; the budget is ${budget.toLocaleString("en-US")}${options.maxTriangles === undefined ? " (the web default)" : ""}.`);
  }
  if (info.materials.length > 32) add("model/many-materials", `${info.materials.length} materials; every one costs at least one draw call and one shader program in three.js.`);
  for (const m of info.materials) {
    // A word for glass, not a material that only contains it ("fiberglass", "glassfibre").
    if (!/(?:^|[^a-z])(?:glass|glazing|canopy|windscreen|windshield|windows?|visor|glas|ruit|ruiten)(?:$|[^a-z])/i.test(m.name) || /fib(?:er|re)|vezel/i.test(m.name)) continue;
    if (m.transmission || (m.alphaMode === "BLEND" && m.alpha < 0.95)) continue;
    // Dark, solid glass is a deliberate choice on a model with nothing behind it (a house without rooms).
    if (m.alphaMode !== "BLEND" && m.luminance < 0.15) continue;
    const why = m.alphaMode === "BLEND" ? `is BLEND with alpha ${m.alpha.toFixed(2)}, so it is as good as opaque` : m.alphaMode === "MASK" ? "is MASK (cut out or solid, never see-through)" : "is OPAQUE";
    add("model/opaque-glass", `Material "${m.name}" looks like glass but ${why}: nothing behind it shows.`);
  }

  const order: Record<ModelSeverity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule));
  const checked = options.archetype !== undefined && options.archetype.id !== "thing";
  const categories = (checked ? [...MODEL_CATEGORIES, "archetype" as const] : MODEL_CATEGORIES).map((c) => score(c, findings));
  // With an archetype check, it takes a fifth of the score and the other categories share the rest.
  const weight = (c: ModelCategory): number => (!checked ? MODEL_WEIGHTS[c] : c === "archetype" ? MODEL_WEIGHTS.archetype : MODEL_WEIGHTS[c] * (1 - MODEL_WEIGHTS.archetype));
  const overall = Math.round(categories.reduce((sum, c) => sum + c.score * weight(c.category), 0));
  return { file: info.file, triangles: info.triangles, nodes: info.nodes.length, overall, ...(checked && options.archetype ? { archetype: options.archetype.id, compared: compareArchetype(info, options.archetype) } : {}), categories, findings };
}

type Add = (rule: string, message: string, node?: string, severity?: ModelSeverity) => void;

/** A part that hangs in the air (a warning) or stands apart on the ground (an info) is usually a part put in the wrong place. */
function checkSeparateParts(info: ModelInfo, add: Add): void {
  for (const s of separateParts(info)) {
    const names = s.nodes.length > 3 ? `${s.nodes.slice(0, 3).join(", ")} and ${s.nodes.length - 3} more` : s.nodes.join(", ");
    add(
      "model/floating-part",
      `${names} ${s.nodes.length > 1 ? "do" : "does"} not touch the rest of the model: ${s.gap.toFixed(2)} m away${s.grounded ? ", standing on the ground" : ", in the air"} (compared by bounding boxes).`,
      s.nodes[0],
      s.grounded ? "info" : "warning",
    );
  }
}

/** What GLTFLoader names a node: PropertyBinding.sanitizeNodeName (white space to _, and [ ] . : / removed). */
export function sanitizeNodeName(name: string): string {
  return name.replace(/\s/g, "_").replace(/[[\].:/]/g, "");
}

function checkRig(info: ModelInfo, add: Add): void {
  const seen = new Set<string>();
  /** Names in use after cleaning, with how many times GLTFLoader has made them unique so far. */
  const names = new Map<string, number>();
  for (const n of info.nodes) {
    if (/^node_\d+$/.test(n.name)) add("model/unnamed-node", `Node ${n.index} has no name.`, n.path);
    else if (sanitizeNodeName(n.name) !== n.name) {
      add("model/renamed-on-load", `"${n.name}" becomes "${sanitizeNodeName(n.name)}" in three.js${/\.\d{3}$/.test(n.name) ? " (a .001 suffix is a duplicate name from the modelling tool)" : ""}, so getObjectByName("${n.name}") finds nothing (GLTFLoader keeps the original in userData.name).`, n.path);
    }
    const clean = sanitizeNodeName(n.name);
    if (seen.has(n.path)) add("model/duplicate-node-names", `Another node at ${n.path} has the same name.`, n.path);
    else if (!/^node_\d+$/.test(n.name) && names.has(clean)) {
      const count = (names.get(clean) ?? 0) + 1;
      names.set(clean, count);
      add("model/duplicate-node-names", `"${clean}" is also used at ${n.path}: GLTFLoader names this one "${clean}_${count}", so getObjectByName("${clean}") finds the other one.`, n.path, "warning");
    }
    if (!names.has(clean)) names.set(clean, 0);
    seen.add(n.path);
    if (n.mirrored) add("model/mirrored-node", `Scale ${n.scale.map((v) => v.toFixed(2)).join(", ")} mirrors this node and everything under it (three.js renders it with the winding flipped).`, n.path);
  }
  if (info.bounds && info.triangles > 0 && Math.abs(info.bounds.min[1]) > 0.05) {
    add("model/ground-offset", `The lowest point is at y = ${info.bounds.min[1].toFixed(3)}.`);
  }
}

interface EdgeStats {
  edges: number;
  open: number;
  flipped: number;
  /** Triangles that face against their own vertex normals (the visible kind of flip). */
  againstNormals: number;
  triangles: number;
  nonManifold: number;
  degenerate: number;
}

/** The primitives of each node, in file order. A mesh's parts join each other, so they are checked together. */
function primitivesByNode(prims: PrimitiveInfo[]): PrimitiveInfo[][] {
  const groups = new Map<number, PrimitiveInfo[]>();
  for (const prim of prims) {
    const group = groups.get(prim.node);
    if (group) group.push(prim);
    else groups.set(prim.node, [prim]);
  }
  return [...groups.values()];
}

/** Triangle primitives (list, strip, fan): the ones with a surface to check. */
function isSurface(prim: PrimitiveInfo): boolean {
  return prim.mode >= 4 && prim.mode <= 6;
}

/** Checks one node: its primitives are welded together, so a closed mesh split by material is still closed. */
function checkNode(info: ModelInfo, all: PrimitiveInfo[], add: Add, uvReported: Set<string>, sheet: boolean): void {
  const surfaces = all.filter(isSurface);
  if (surfaces.length === 0) return;
  const node = surfaces[0]?.nodeName ?? "";
  if (surfaces.some((p) => !p.hasNormals)) add("model/missing-normals", "The mesh has no NORMAL data, so GLTFLoader gives it flatShading.", node);
  // Compressed geometry cannot be read without its decoder: its attributes are checked, its triangles are not.
  const prims = surfaces.filter((p) => p.compressed === undefined);
  for (const prim of surfaces) {
    const mat = prim.material === undefined ? undefined : info.materials[prim.material];
    if (mat?.textured && !prim.hasUv) add("model/missing-uv", `Material "${mat.name}" uses a texture, but the mesh has no TEXCOORD_0.`, node);
    if (mat?.normalMapped && !prim.hasTangents) add("model/missing-tangents", `Material "${mat.name}" has a normal map, but the mesh has no TANGENT data.`, node);
    // UVs outside 0..1 only matter when a texture is sampled with them and does not repeat.
    if (prim.uvOutOfRange && mat?.textured && !mat.repeats && !uvReported.has(node)) {
      uvReported.add(node);
      add("model/uv-out-of-range", "Some UVs lie outside 0..1.", node);
    }
  }
  if (prims.length === 0) return;
  const edges = analyseEdges(prims, sheet);
  const triangles = prims.reduce((n, p) => n + p.triangles, 0);
  const againstNormals = prims.reduce((n, p) => n + trianglesAgainstNormals(p), 0);
  reportEdges(node, { ...edges, triangles, againstNormals }, add);
}

/** One finding per node and rule; the severity follows how much of the surface is affected. */
function reportEdges(node: string, e: EdgeStats, add: Add): void {
  const pct = (n: number, of: number) => `${((n / Math.max(of, 1)) * 100).toFixed(2)}%`;
  const severity = (ratio: number): ModelSeverity => (ratio >= 0.01 ? "error" : ratio >= 0.0005 ? "warning" : "info");
  if (e.againstNormals > 0) {
    add("model/flipped-faces", `${e.againstNormals.toLocaleString("en-US")} triangles (${pct(e.againstNormals, e.triangles)}) face against their own normals, so they light wrong and show as backfaces.`, node, severity(e.againstNormals / Math.max(e.triangles, 1)));
  }
  if (e.flipped > 0) {
    add("model/flipped-faces", `${e.flipped.toLocaleString("en-US")} edges (${pct(e.flipped, e.edges)}) join triangles that face opposite ways (the mesh has no normals to compare with).`, node, severity(e.flipped / Math.max(e.edges, 1)));
  }
  if (e.open > 0) {
    const ratio = e.open / Math.max(e.edges, 1);
    add("model/open-edges", `${e.open.toLocaleString("en-US")} open edges (${pct(e.open, e.edges)}) on a single-sided surface; seen from behind it is see-through.`, node, ratio >= 0.01 ? "warning" : "info");
  }
  if (e.nonManifold > 0) add("model/non-manifold", `${e.nonManifold.toLocaleString("en-US")} edges are shared by more than two triangles.`, node);
  if (e.degenerate > 0) add("model/degenerate-triangles", `${e.degenerate.toLocaleString("en-US")} triangles have no area.`, node);
}

/** Squared length of the cross product below which a triangle has no area (a sliver of a square millimetre or less). */
const FLAT_CROSS_SQUARED = 1e-18;

/** True when the triangle at these three indices has no area: its points repeat or lie on one line. */
function flatTriangle(p: Float64Array, i: number, j: number, k: number): boolean {
  const a = i * 3, b = j * 3, c = k * 3;
  const ux = at(p, b) - at(p, a), uy = at(p, b + 1) - at(p, a + 1), uz = at(p, b + 2) - at(p, a + 2);
  const vx = at(p, c) - at(p, a), vy = at(p, c + 1) - at(p, a + 1), vz = at(p, c + 2) - at(p, a + 2);
  const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
  return gx * gx + gy * gy + gz * gz < FLAT_CROSS_SQUARED;
}

/** Counts triangles whose geometric normal points against the sum of their vertex normals. */
export function trianglesAgainstNormals(prim: PrimitiveInfo): number {
  const n = prim.normals;
  if (!n) return 0;
  const p = prim.positions;
  let count = 0;
  for (let t = 0; t < prim.indices.length; t += 3) {
    const i = at(prim.indices, t) * 3, j = at(prim.indices, t + 1) * 3, k = at(prim.indices, t + 2) * 3;
    const ux = at(p, j) - at(p, i), uy = at(p, j + 1) - at(p, i + 1), uz = at(p, j + 2) - at(p, i + 2);
    const vx = at(p, k) - at(p, i), vy = at(p, k + 1) - at(p, i + 1), vz = at(p, k + 2) - at(p, i + 2);
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    if (gx * gx + gy * gy + gz * gz < FLAT_CROSS_SQUARED) continue;
    const dot = gx * (at(n, i) + at(n, j) + at(n, k)) + gy * (at(n, i + 1) + at(n, j + 1) + at(n, k + 1)) + gz * (at(n, i + 2) + at(n, j + 2) + at(n, k + 2));
    if (dot < 0) count++;
  }
  return count;
}

/**
 * Welds vertices by position across the primitives of one node and counts edge problems.
 * With `sheet`, an open edge that lies on the outer border of the surface (along x or z) is expected and not counted:
 * a terrain tile or a water plane ends there, and its neighbour continues it.
 */
export function analyseEdges(prims: PrimitiveInfo[], sheet = false): { edges: number; open: number; flipped: number; nonManifold: number; degenerate: number } {
  const weld = new Map<string, number>();
  /** x and z of each welded vertex, to tell border edges from holes. */
  const gx: number[] = [], gz: number[] = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  // Every primitive of a node shares the node's transform, so their local positions can be welded together.
  const ids = prims.map((prim) => {
    const id = new Uint32Array(prim.vertices);
    for (let v = 0; v < prim.vertices; v++) {
      const x = at(prim.positions, v * 3), z = at(prim.positions, v * 3 + 2);
      const key = `${Math.round(x * 1e5)},${Math.round(at(prim.positions, v * 3 + 1) * 1e5)},${Math.round(z * 1e5)}`;
      let w = weld.get(key);
      if (w === undefined) { w = weld.size; weld.set(key, w); gx.push(x); gz.push(z); }
      id[v] = w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    return id;
  });
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4;
  const onBorder = (a: number, b: number): boolean => {
    const ax = at(gx, a), bx = at(gx, b), az = at(gz, a), bz = at(gz, b);
    return (near(ax, minX) && near(bx, minX)) || (near(ax, maxX) && near(bx, maxX)) || (near(az, minZ) && near(bz, minZ)) || (near(az, maxZ) && near(bz, maxZ));
  };
  // value = uses * 16 + flags: 1 low->high, 2 high->low (the direction), 4 a use from a double-sided primitive, 8 a use from one with normals
  const edges = new Map<number, number>();
  const stride = 67108864;
  let degenerate = 0;
  prims.forEach((prim, p) => {
    const id = ids[p] as Uint32Array;
    const flags = (prim.doubleSided ? 4 : 0) | (prim.hasNormals ? 8 : 0);
    for (let t = 0; t < prim.indices.length; t += 3) {
      const i = at(prim.indices, t), j = at(prim.indices, t + 1), k = at(prim.indices, t + 2);
      const a = at(id, i), b = at(id, j), c = at(id, k);
      if (a === b || b === c || a === c || flatTriangle(prim.positions, i, j, k)) { degenerate++; continue; }
      for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
        const key = Math.min(from, to) * stride + Math.max(from, to);
        const dir = from < to ? 1 : 2;
        const old = edges.get(key) ?? 0;
        edges.set(key, (Math.floor(old / 16) + 1) * 16 + ((old % 16) | flags | dir));
      }
    }
  });
  let open = 0, flipped = 0, nonManifold = 0;
  for (const [key, value] of edges) {
    const uses = Math.floor(value / 16);
    const mask = value % 4;
    if (uses === 1) {
      // Only a single-sided surface has holes: seen from behind, a double-sided one is still closed.
      if ((value & 4) === 0 && !(sheet && onBorder(Math.floor(key / stride), key % stride))) open++;
    }
    else if (uses === 2 && mask !== 3 && (value & 8) === 0) flipped++;
    else if (uses > 2) nonManifold++;
  }
  return { edges: edges.size, open, flipped, nonManifold, degenerate };
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function checkTextures(info: ModelInfo, options: LintOptions, add: Add): void {
  for (const t of info.textures) {
    if (t.width === undefined || t.height === undefined) continue;
    const largest = Math.max(t.width, t.height);
    if (largest > 2048) add("model/texture-size", `${t.name} is ${t.width}x${t.height}${largest > 4096 ? ": above the 4096 many GPUs allow" : ""}.`, undefined, largest > 4096 ? "warning" : "info");
    if (!isPowerOfTwo(t.width) || !isPowerOfTwo(t.height)) add("model/texture-not-power-of-two", `${t.name} is ${t.width}x${t.height}.`);
  }
  const mb = info.textures.reduce((n, t) => n + t.megabytes, 0);
  const budget = options.maxTextureMb ?? WEB_BUDGET.textureMb;
  if (mb > budget) add("model/texture-memory", `About ${mb.toFixed(0)} MB of GPU memory for textures (with mipmaps); the budget is ${budget} MB.${info.textures.some((t) => t.format !== "ktx2") ? " KTX2 (npx @gltf-transform/cli uastc or etc1s) keeps them compressed on the GPU." : ""}`);
}

const SYMMETRY_SAMPLE = 200_000;

/** Reports models that are nearly mirror-symmetric in x, but with a few vertices that have no partner. */
function checkSymmetry(info: ModelInfo, add: Add): void {
  const b = info.bounds;
  if (!b || info.triangles === 0) return;
  const centre = (b.min[0] + b.max[0]) / 2;
  if (Math.abs(centre) > b.size[0] * 0.05) return;
  const tol = Math.max(b.size[0], b.size[1], b.size[2]) * 0.0005;
  const cell = tol * 2;
  const grid = new Map<string, true>();
  const key = (x: number, y: number, z: number) => `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
  const points: [number, number, number][] = [];
  for (const prim of info.primitives) {
    if (prim.compressed) continue;
    for (let v = 0; v < prim.vertices; v++) {
      const p = transformPoint(prim.world, at(prim.positions, v * 3), at(prim.positions, v * 3 + 1), at(prim.positions, v * 3 + 2));
      points.push(p);
      grid.set(key(p[0], p[1], p[2]), true);
    }
  }
  const step = Math.max(1, Math.floor(points.length / SYMMETRY_SAMPLE));
  let total = 0, matched = 0;
  const near = (x: number, y: number, z: number): boolean => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (grid.has(key(x + dx * cell, y + dy * cell, z + dz * cell))) return true;
    }
    return false;
  };
  for (let i = 0; i < points.length; i += step) {
    const p = points[i] as [number, number, number];
    total++;
    if (near(2 * centre - p[0], p[1], p[2])) matched++;
  }
  if (total === 0) return;
  const share = matched / total;
  if (share >= 0.6 && share < 0.999) {
    add("model/asymmetry", `${((1 - share) * 100).toFixed(1)}% of the vertices have no mirror partner within ${(tol * 1000).toFixed(1)} mm, while the rest matches (left and right should be equal).`);
  }
}

function score(category: ModelCategory, findings: ModelFinding[]): ModelCategoryScore {
  const mine = findings.filter((f) => f.category === category);
  const perRule = new Map<string, number>();
  for (const f of mine) perRule.set(f.rule, Math.min(RULE_CAP, (perRule.get(f.rule) ?? 0) + PENALTY[f.severity]));
  const value = 100 - [...perRule.values()].reduce((a, b) => a + b, 0);
  return {
    category,
    score: Math.max(0, Math.round(value)),
    errors: mine.filter((f) => f.severity === "error").length,
    warnings: mine.filter((f) => f.severity === "warning").length,
    infos: mine.filter((f) => f.severity === "info").length,
  };
}


/** The checks that are about three.js at runtime: draw calls, file size, units, origin, vertex colours, emissive, extensions. */
function checkThree(info: ModelInfo, options: LintOptions, add: Add): void {
  const surfaces = info.primitives.filter(isSurface);
  const drawCalls = surfaces.length;
  const maxDrawCalls = options.maxDrawCalls ?? WEB_BUDGET.drawCalls;
  if (drawCalls > maxDrawCalls) {
    const meshes = new Set(surfaces.map((p) => p.node)).size;
    add("model/draw-calls", `About ${drawCalls} draw calls (${meshes} meshes, ${info.materials.length} materials, one per mesh and material), more than ${maxDrawCalls}; each shadow-casting light draws them again.`);
  }

  const ext = new Set([...info.extensionsUsed, ...info.extensionsRequired]);
  const compressed = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_meshopt_compression", "KHR_texture_basisu"].some((e) => ext.has(e));
  const mb = info.bytes / 1048576;
  if (mb > WEB_BUDGET.uncompressedMb && !compressed) {
    add("model/uncompressed", `The file is ${mb.toFixed(1)} MB without Draco, meshopt or KTX2: npx @gltf-transform/cli optimize in.glb out.glb --compress draco --texture-compress webp usually makes it several times smaller.`);
  }

  const b = info.bounds;
  if (b && info.triangles > 0) {
    const largest = Math.max(...b.size);
    if (largest > 2000) add("model/scale-suspect", `The model is ${largest.toFixed(0)} m across: that is centimetres or millimetres read as metres, unless it is a whole landscape.`, undefined, "info");
    else if (largest > 0 && largest < 0.005) add("model/scale-suspect", `The model is ${(largest * 1000).toFixed(2)} mm across: three.js uses metres, so it was probably exported in the wrong unit.`);
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const across = Math.max(b.size[0], b.size[2]);
    const off = Math.hypot(cx, cz);
    // The origin should lie within the footprint, near its middle; a quarter of the size off is a moved pivot.
    if (off > 0.05 && off > 0.25 * across) {
      add("model/origin-off-centre", `The origin is ${off.toFixed(2)} m from the middle of the model (in x and z, the model is ${across.toFixed(2)} m across), so position and rotation act about a point beside it.`);
    }
  }

  const colored = surfaces.filter((p) => p.hasColors);
  if (colored.length) {
    const nodes = [...new Set(colored.map((p) => p.nodeName))];
    add("model/vertex-colors", `${nodes.length} mesh${nodes.length > 1 ? "es have" : " has"} vertex colours (COLOR_0): ${nodes.slice(0, 3).join(", ")}${nodes.length > 3 ? ", ..." : ""}. They multiply the material colour.`, nodes[0]);
  }
  for (const m of info.materials) {
    if (m.emissive && m.emissiveStrength > 1) add("model/emissive-strength", `Material "${m.name}" has emissive strength ${m.emissiveStrength} (emissiveIntensity in three.js).`);
  }
  const transmissive = info.materials.filter((m) => m.transmission);
  if (transmissive.length) add("model/transmission", `${transmissive.length} material${transmissive.length > 1 ? "s use" : " uses"} transmission (${transmissive.slice(0, 3).map((m) => m.name).join(", ")}).`);

  const needs = modelNeeds(info);
  for (const e of needs.extensions) {
    if (e.support === "unsupported") add("model/unsupported-extension", `${e.name}${e.required ? " (required)" : ""}: ${e.note}`, undefined, e.required ? "error" : "warning");
    else if (e.support === "plugin") add("model/unsupported-extension", `${e.name}${e.required ? " (required)" : ""}: ${e.note}`, undefined, e.required ? "warning" : "info");
  }
  for (const setup of needs.setups) add("model/needs-decoder", `Loading it needs ${setup.title}${setup.required ? "" : " (optional: the file has a fallback)"}.`);
  const packed = info.primitives.filter((p) => p.compressed);
  if (packed.length) {
    const kinds = [...new Set(packed.map((p) => p.compressed))].join(" and ");
    add("model/compressed-geometry", `${packed.length} primitive${packed.length > 1 ? "s are" : " is"} ${kinds} compressed: winding, holes and symmetry were not checked (only sizes from the accessor bounds).`);
  }
}
