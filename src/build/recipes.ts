import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../model/data.js";
import { BuildError, type ParamDef } from "./params.js";

const DIR = dataDir("recipes");

/** A ready-made model spec with parameters, shipped as data in data/recipes/*.json. */
export interface Recipe {
  kind: string;
  description: string;
  archetype?: string;
  params: ParamDef[];
  /** The full spec; its parameters come from `params`. */
  spec: Record<string, unknown>;
}

let cached: Map<string, Recipe> | undefined;

export function loadRecipes(dir: string = DIR): Map<string, Recipe> {
  if (dir === DIR && cached) return cached;
  const out = new Map<string, Recipe>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const spec = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    const kind = file.replace(/\.json$/, "");
    if (typeof spec["name"] !== "string" || typeof spec["description"] !== "string") throw new BuildError(`recipe ${kind}: needs a "name" and a "description"`);
    if (out.has(kind)) throw new BuildError(`recipe ${kind}: defined twice`);
    out.set(kind, {
      kind,
      description: spec["description"],
      ...(typeof spec["archetype"] === "string" ? { archetype: spec["archetype"] } : {}),
      params: (Array.isArray(spec["params"]) ? spec["params"] : []) as ParamDef[],
      spec,
    });
  }
  if (dir === DIR) cached = out;
  return out;
}
