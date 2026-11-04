import { loadLibrary } from "../archetype/library.js";
import { contractFromModel, type ModelContract } from "../model/contract.js";
import { inspectModel, type ModelInfo } from "../model/inspect.js";
import { lintModel, type ModelReport } from "../model/lint.js";
import { buildGlb, type Heightmap } from "./glb.js";
import { allKinds, buildKind } from "./generators/index.js";
import { BuildError, type ParamDef } from "./params.js";
import { buildSpec } from "./spec.js";

export interface BuildRequest {
  /** A ready-made kind (see `allKinds()`); then `params` are its parameters. */
  kind?: string;
  /** A full model spec (parsed JSON, see SPEC_HELP); then `params` override the spec's own parameters. */
  spec?: unknown;
  params?: Record<string, unknown>;
  /** Sets the `seed` parameter of a kind or spec that has one (the same seed always gives the same model). */
  seed?: number;
  /** False writes plain colours instead of texture maps (smaller files, or for materials of your own). Default true. */
  textures?: boolean;
  /** The model's name, for the file name and messages; default the kind, the spec's name, or "model". */
  name?: string;
}

export interface BuildResult {
  /** The .glb bytes. Nothing is written: the caller decides where the file goes. */
  glb: Uint8Array;
  /** The model's name; the file is meant to be `${name}.glb`. */
  name: string;
  /** The lint of the built model, against its archetype when the kind or spec names one. */
  report: ModelReport;
  info: ModelInfo;
  /** One line: size, triangles, nodes, score and what it was checked as. */
  summary: string;
  /** A contract that keeps the model as built (node names, size, triangle budget), to store as model.contract.json. */
  contract: ModelContract;
  /**
   * For a terrain tile: its ground as a height grid, for a heightfield collider in a physics engine. `heights[j * size + i]`
   * is the height at x = (i - (size - 1) / 2) * step, z = (j - (size - 1) / 2) * step.
   */
  heightmap?: Heightmap;
}

const nameOf = (spec: unknown): string | undefined => {
  const name = typeof spec === "object" && spec !== null ? (spec as Record<string, unknown>)["name"] : undefined;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
};

function paramsOf(request: BuildRequest): ParamDef[] {
  if (request.kind) return allKinds().find((k) => k.kind === request.kind)?.params ?? [];
  const params = typeof request.spec === "object" && request.spec !== null ? (request.spec as Record<string, unknown>)["params"] : undefined;
  return Array.isArray(params) ? (params as ParamDef[]) : [];
}

/**
 * Builds a model from a kind or a spec and lints it, all in memory. Deterministic: the same request gives the same bytes.
 * Throws BuildError (a ModelError) with a message an agent can act on.
 */
export function buildModel(request: BuildRequest): BuildResult {
  if (!request.kind && request.spec === undefined) throw new BuildError("give a kind (see `model kinds`) or a full spec (see `model spec`)");
  const params: Record<string, unknown> = { ...request.params };
  if (request.seed !== undefined) {
    if (!paramsOf(request).some((p) => p.name === "seed")) throw new BuildError(`${request.kind ?? "this spec"} has no seed parameter: it gives the same model every time`);
    params["seed"] ??= request.seed;
  }
  const built = request.kind ? buildKind(request.kind, { ...(request.spec as object | undefined), ...params }) : buildSpec(request.spec, params);
  const library = loadLibrary();
  if (built.archetype && !library.get(built.archetype)) throw new BuildError(`unknown archetype "${built.archetype}" (see \`model archetypes\`)`);
  const glb = new Uint8Array(buildGlb(built, { textures: request.textures !== false }));
  const name = (request.name ?? request.kind ?? nameOf(request.spec) ?? "model").replace(/\.glb$/i, "");
  const info = inspectModel(glb, `${name}.glb`);
  const report = lintModel(info, built.archetype ? { archetype: library.resolve(built.archetype) } : {});
  const size = info.bounds?.size.map((v) => v.toFixed(2)).join(" x ") ?? "?";
  const summary = `built ${name}.glb: ${(glb.length / 1024).toFixed(0)} KB, ${info.triangles.toLocaleString("en-US")} triangles, ${info.nodes.length} nodes, ${size} m (x y z), lint ${report.overall}/100${report.archetype ? ` (checked as ${report.archetype})` : ""}`;
  return { glb, name, report, info, summary, contract: contractFromModel(info), ...(built.heightmap ? { heightmap: built.heightmap } : {}) };
}
