/**
 * The 3D model API: inspect, view and lint .glb/.gltf files for three.js, say what a thing is (archetypes), and build
 * clean .glb files from a kind or a spec. Nothing here writes files: callers decide where bytes go.
 */
import { briefFor as briefWith, type Brief } from "../archetype/brief.js";
import { chooseArchetype, type ResolvedChoice } from "../archetype/check.js";
import { formatChecked } from "../archetype/format.js";
import { identify as identifyWith, type IdentifyResult } from "../archetype/identify.js";
import { loadLibrary } from "../archetype/library.js";
import { allKinds as kinds } from "../build/generators/index.js";
import { loadRecipes } from "../build/recipes.js";
import { BuildError } from "../build/params.js";
import type { ModelContract } from "./contract.js";
import { formatModelReport, type Detail } from "./format.js";
import { inspectModel as inspect, type ModelInfo } from "./inspect.js";
import { lintModel, type ModelReport } from "./lint.js";
import { viewModel as view } from "./view.js";

export { ModelError, loadGltf, loadGltfBytes } from "./gltf.js";
export type { ModelInfo, NodeInfo, PrimitiveInfo, TextureInfo } from "./inspect.js";
export { formatModelInfo, formatModelReport, formatModelFinding, type Detail } from "./format.js";
export { lintModel, sanitizeNodeName, WEB_BUDGET, type LintOptions, type ModelReport, type ModelCategoryScore } from "./lint.js";
export { MODEL_RULES, MODEL_CATEGORIES, type ModelFinding, type ModelRule, type ModelCategory, type ModelSeverity } from "./rules.js";
export { separateParts, partBoxes, type PartBox, type SeparatePart } from "./view.js";
export { checkContract, contractFromArchetype, contractFromModel, loadContract, type ModelContract, type Measure } from "./contract.js";
export { modelNeeds, checkModelSetup, extensionSupport, formatModelNeeds, formatSetupProblems, type ModelNeeds, type LoaderSetup, type ExtensionNote, type ExtensionSupport, type SetupProblem, type SetupId } from "./needs.js";
export { formatIdentify, formatArchetype, formatTree, formatChecked } from "../archetype/format.js";
export { chooseArchetype, compareArchetype, type ResolvedChoice, type Comparison } from "../archetype/check.js";
export { ArchetypeError, type ArchetypeLibrary } from "../archetype/library.js";
export type { IdentifyResult } from "../archetype/identify.js";
export type { Brief, KindRef } from "../archetype/brief.js";
export type { ResolvedArchetype, ArchetypePart } from "../archetype/types.js";
export { buildModel, type BuildRequest, type BuildResult } from "../build/run.js";
export { allKinds } from "../build/generators/index.js";
export { SPEC_HELP, SPEC_CHEAT, EXAMPLE_SPEC } from "../build/spec-help.js";
export { BuildError, type ParamDef } from "../build/params.js";
export type { Heightmap } from "../build/glb.js";

/** Reads a model from a path, or from the bytes of a .glb (`name` is then used in messages). */
export function inspectModel(source: string | Uint8Array, name?: string): ModelInfo {
  return inspect(source, name);
}

/** A model as text for an agent that cannot see pictures: front, side and top views in letters, parts, what does not touch. */
export function viewModel(source: string | Uint8Array | ModelInfo, options: { width?: number; only?: "front" | "side" | "top" } = {}): string {
  return view(typeof source === "string" || source instanceof Uint8Array ? inspect(source) : source, options);
}

export interface ModelLintRequest {
  /** What the model should be: an archetype id ("vehicle.wheeled.car") or a name in English or Dutch ("car", "helikopter"). */
  archetype?: string;
  contract?: ModelContract;
  maxTriangles?: number;
  maxTextureMb?: number;
  maxDrawCalls?: number;
  /** For bytes: the name used in messages. */
  name?: string;
}

export interface ModelLintResult {
  report: ModelReport;
  /** What the model was checked as, when an archetype was asked for. */
  checked?: ResolvedChoice;
  /** True when the lint found errors (a CLI exits 1, an MCP tool returns an error result). */
  failed: boolean;
}

/** Lints a .glb/.gltf (path or bytes), against an archetype by name when one is given. */
export function lintModelFile(source: string | Uint8Array, request: ModelLintRequest = {}): ModelLintResult {
  const checked = request.archetype === undefined ? undefined : chooseArchetype(request.archetype);
  const report = lintModel(inspect(source, request.name), {
    ...(checked ? { archetype: checked.archetype } : {}),
    ...(request.contract ? { contract: request.contract } : {}),
    ...(request.maxTriangles !== undefined ? { maxTriangles: request.maxTriangles } : {}),
    ...(request.maxTextureMb !== undefined ? { maxTextureMb: request.maxTextureMb } : {}),
    ...(request.maxDrawCalls !== undefined ? { maxDrawCalls: request.maxDrawCalls } : {}),
  });
  return { report, ...(checked ? { checked } : {}), failed: report.categories.some((c) => c.errors > 0) };
}

/** The lint as text: what it was checked as (with an archetype), then the scores and findings. */
export function formatLint(result: ModelLintResult, detail: Detail = "brief"): string {
  return `${result.checked ? formatChecked(result.checked, result.report.compared) : ""}${formatModelReport(result.report, detail)}`;
}

/** What a thing is (English or Dutch name or description): parts, size, pivots, conventions. */
export function identify(text: string): IdentifyResult {
  return identifyWith(text, loadLibrary());
}

/** One page to read before building a thing: the ready-made kind, parts, sizes, rules, mistakes, commands, spec cheat sheet. */
export function briefFor(text: string): Brief {
  return briefWith(text, loadLibrary());
}

/** The full spec of a ready-made recipe, to edit and build with `buildModel({ spec })`. */
export function recipeSpec(kind: string): Record<string, unknown> {
  const recipe = loadRecipes().get(kind);
  if (!recipe) throw new BuildError(`no recipe "${kind}" (known: ${[...loadRecipes().keys()].join(", ")}; house, terrain and sea are generators without a spec)`);
  return recipe.spec;
}

/** Every kind buildModel makes, with its parameters, as text. */
export function formatKinds(): string {
  const out: string[] = [];
  for (const g of kinds()) {
    out.push(`${g.kind}: ${g.description}`);
    for (const d of g.params) {
      const range = d.options ? d.options.join("|") : [d.min !== undefined && `min ${d.min}`, d.max !== undefined && `max ${d.max}`].filter(Boolean).join(", ");
      out.push(`  ${d.name} = ${String(d.default)}${range ? ` (${range})` : ""}  ${d.description}`);
    }
  }
  return `${out.join("\n")}\n`;
}

/** The ready-made recipes (data/recipes) with the archetype each is checked against, as text. */
export function formatRecipes(): string {
  const out = [...loadRecipes().values()].map((r) => `${r.kind}  (${r.archetype ?? "no archetype"}, ${r.params.length} parameter${r.params.length === 1 ? "" : "s"})\n  ${r.description}`);
  return `${out.join("\n")}\n\nBuild one with: threesmith model build <kind> -o <file>.glb   (parameters: threesmith model kinds)\nEdit one: threesmith model recipes <kind> > my.spec.json\n`;
}

/** The archetype library (data/archetypes), loaded once. */
export function archetypeLibrary() {
  return loadLibrary();
}
