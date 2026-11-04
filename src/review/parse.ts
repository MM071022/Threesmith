import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blockAt } from "./source.js";
import type { SourceFile } from "./source.js";
import type { Ctx, Report, Rule } from "./types.js";

/**
 * Small, offset-preserving parsing helpers for the rules: matching brackets, string literals, the GLSL code a
 * ShaderMaterial gets, and the tables of the installed three (shader chunk names, the export lists of its builds).
 */

/** Index of the closing quote of the string literal that starts at `i` (template literals with `${}` included). */
export function stringEnd(text: string, i: number): number {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === q) return j;
    if (q !== "`" && c === "\n") return j;
    if (q === "`" && c === "$" && text[j + 1] === "{") {
      const close = closeOf(text, j + 1);
      if (close < 0) return text.length;
      j = close;
    }
  }
  return text.length;
}

const CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Index of the bracket that closes the one at `open` ("(", "[" or "{"), skipping strings; -1 when unbalanced. */
export function closeOf(text: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      i = stringEnd(text, i);
      continue;
    }
    if (c in CLOSE) stack.push(CLOSE[c] as string);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** The (...) argument list of a call whose name ends right before `at` (where "(" is expected after spaces). */
export function callArgs(text: string, at: number): { start: number; end: number } | undefined {
  const open = text.indexOf("(", at);
  if (open < 0 || text.slice(at, open).trim()) return undefined;
  const end = closeOf(text, open);
  return end < 0 ? undefined : { start: open + 1, end };
}

/** Split `text` at its top-level commas (not inside brackets or strings); each part with its offset in `text`. */
export function splitTop(text: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      i = stringEnd(text, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if ((c === "," && depth === 0) || i === text.length) {
      out.push({ text: text.slice(from, i), at: from });
      from = i + 1;
    }
  }
  return out.filter((p) => p.text.trim());
}

/** Escape a string for use inside a RegExp. */
export function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The variable a `new X(...)` at `at` is assigned to (`const x = new X(`, `x = new X(`, `this.x = new X(`). */
export function assignedName(text: string, at: number): string | undefined {
  const before = text.slice(Math.max(0, at - 120), at);
  const m = /(?:(?:const|let|var)\s+|this\.|\b)([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>[\]]+\s*)?=\s*$/.exec(before);
  return m?.[1];
}

/** Every use of `name` as a whole word, as offsets. */
export function usesOf(text: string, name: string): number[] {
  return [...text.matchAll(new RegExp(String.raw`(?<![\w$.])${esc(name)}(?![\w$])`, "g"))].map((m) => m.index ?? 0);
}

// ---- GLSL handed to ShaderMaterial / RawShaderMaterial ----

export interface GlslCode {
  file: SourceFile;
  /** Offset of the code in `file.text`. */
  start: number;
  code: string;
  /** The code has `${...}` pieces (or was not fully resolved), so "is X declared" checks must stay quiet. */
  dynamic: boolean;
}

export interface ShaderMaterialUse {
  file: SourceFile;
  /** Offset of `new ...ShaderMaterial(`. */
  at: number;
  raw: boolean;
  /** Text of the options object and its offset. */
  options: string;
  optionsStart: number;
  glsl3: boolean;
  vertex?: GlslCode;
  fragment?: GlslCode;
}

function literalAt(file: SourceFile, i: number): GlslCode | undefined {
  const q = file.text[i];
  if (q !== "`" && q !== "'" && q !== '"') return undefined;
  const end = stringEnd(file.text, i);
  const code = file.text.slice(i + 1, end);
  return { file, start: i + 1, code, dynamic: q === "`" && code.includes("${") };
}

/** Resolve the value of `vertexShader:` / `fragmentShader:` to its GLSL, when it is a literal or a plain constant. */
function resolveValue(files: SourceFile[], file: SourceFile, at: number): GlslCode | undefined {
  const text = file.text;
  let i = at;
  while (/\s/.test(text[i] ?? "")) i++;
  const lit = literalAt(file, i);
  if (lit) return lit;
  const dom = /^document\s*\.\s*(?:getElementById\s*\(\s*['"]([\w-]+)['"]\s*\)|querySelector\s*\(\s*['"]#([\w-]+)['"]\s*\))\s*\.\s*(?:textContent|innerHTML|innerText)/.exec(text.slice(i, i + 160));
  if (dom) {
    const id = dom[1] ?? dom[2] ?? "";
    const re = new RegExp(String.raw`<script\b[^>]*\bid\s*=\s*["']${esc(id)}["'][^>]*>([\s\S]*?)</script>`);
    // the page itself, or else the one page that has this id (several pages: which one loads this script is unknown)
    const pages = /\.html?$/.test(file.path) ? [file] : files.filter((f) => /\.html?$/.test(f.path) && re.test(f.raw));
    if (pages.length !== 1 || !pages[0]) return undefined;
    const page = pages[0];
    const m = re.exec(page.raw);
    if (!m) return undefined;
    return { file: page, start: (m.index ?? 0) + m[0].indexOf(">") + 1, code: m[1] ?? "", dynamic: false };
  }
  const id = /^([A-Za-z_$][\w$]*)\s*(?:\.\s*trim\s*\(\s*\)\s*)?(?=[,}\s)])/.exec(text.slice(i, i + 80));
  if (!id?.[1]) return undefined;
  return resolveConst(files, file, id[1]);
}

/** A `const name = <string literal>` in this file, or `export const name = ...` in another one. */
export function resolveConst(files: SourceFile[], file: SourceFile, name: string): GlslCode | undefined {
  const decl = new RegExp(String.raw`(?:const|let|var)\s+${esc(name)}\s*=\s*`, "g");
  const first = (f: SourceFile): GlslCode | undefined => {
    for (const m of f.text.matchAll(decl)) {
      const lit = literalAt(f, (m.index ?? 0) + m[0].length);
      if (lit) return lit;
    }
    return undefined;
  };
  const own = first(file);
  if (own || new RegExp(String.raw`(?:const|let|var)\s+${esc(name)}\b`).test(file.text)) return own;
  // imported: only when exactly one module exports it
  if (!new RegExp(String.raw`import\s*\{[^}]*\b${esc(name)}\b[^}]*\}\s*from`).test(file.text)) return undefined;
  const exporters = files.filter((f) => f !== file && new RegExp(String.raw`export\s+(?:const|let|var)\s+${esc(name)}\b`).test(f.text));
  return exporters.length === 1 && exporters[0] ? first(exporters[0]) : undefined;
}

function valueAfter(options: string, key: string): number | undefined {
  const m = new RegExp(String.raw`(?<![\w$.])${key}\s*(:|(?=\s*[,}]))`).exec(options);
  if (!m) return undefined;
  return (m.index ?? 0) + m[0].length;
}

/** Every `new ShaderMaterial({...})` / `new RawShaderMaterial({...})` with an inline options object. */
export function shaderMaterials(files: SourceFile[], scope: SourceFile[]): ShaderMaterialUse[] {
  const out: ShaderMaterialUse[] = [];
  for (const file of scope) {
    for (const m of file.text.matchAll(/new\s+(?:[\w$]+\.)?(RawShaderMaterial|ShaderMaterial)\s*\(\s*\{/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = closeOf(file.text, open);
      if (close < 0) continue;
      const options = file.text.slice(open, close + 1);
      const raw = m[1] === "RawShaderMaterial";
      const use: ShaderMaterialUse = { file, at: m.index ?? 0, raw, options, optionsStart: open, glsl3: /\bglslVersion\s*:\s*(?:[\w$]+\.)?GLSL3\b/.test(options) };
      for (const [key, slot] of [["vertexShader", "vertex"], ["fragmentShader", "fragment"]] as const) {
        const v = valueAfter(options, key);
        if (v === undefined) continue;
        // shorthand `{ vertexShader }` resolves the constant of the same name
        const code = options[v - 1] === ":" ? resolveValue(files, file, open + v) : resolveConst(files, file, key);
        if (code) use[slot] = code;
      }
      out.push(use);
    }
  }
  return out;
}

/** Offsets inside GLSL code are offsets in its file. */
export function at(code: GlslCode, index: number): number {
  return code.start + index;
}

// ---- tables of the installed three ----

const chunkCache = new Map<string, Set<string> | undefined>();

/** Names of the shader chunks `#include <...>` can resolve in the installed three. */
export function shaderChunks(root: string): Set<string> | undefined {
  if (chunkCache.has(root)) return chunkCache.get(root);
  let keys: Set<string> | undefined;
  const p = join(root, "src", "renderers", "shaders", "ShaderChunk.js");
  if (existsSync(p)) {
    const src = readFileSync(p, "utf8");
    const body = /export const ShaderChunk\s*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1];
    if (body) keys = new Set([...body.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1] as string));
    if (keys && keys.size < 50) keys = undefined;
  }
  chunkCache.set(root, keys);
  return keys;
}

/** Shader chunks that were renamed or removed, from the migration guide and the ShaderChunk.js of each release. */
export const CHUNK_HISTORY: Record<string, { to?: string; release: number; note?: string }> = {
  encodings_fragment: { to: "colorspace_fragment", release: 154 },
  encodings_pars_fragment: { to: "colorspace_pars_fragment", release: 154 },
  output_fragment: { to: "opaque_fragment", release: 154 },
  lightmap_fragment: { release: 164, note: "inline its GLSL into your shader" },
  uv2_pars_vertex: { release: 151, note: "aoMap and lightMap use the uv chunks with texture channels now" },
  uv2_vertex: { release: 151, note: "aoMap and lightMap use the uv chunks with texture channels now" },
  uv2_pars_fragment: { release: 151, note: "aoMap and lightMap use the uv chunks with texture channels now" },
  distanceRGBA_vert: { to: "distance_vert", release: 182, note: "the shader changed too, so check the result" },
  distanceRGBA_frag: { to: "distance_frag", release: 182, note: "the shader changed too, so check the result" },
  cube_uv_reflection_fragment: { release: 187, note: "PMREMs are cube render targets now" },
  lights_pars_maps: { to: "envmap_physical_pars_fragment", release: 95 },
  lights_pars: { release: 91, note: "it was split into lights_pars_begin and lights_pars_maps" },
  lights_template: { release: 91, note: "it was split into lights_fragment_begin, lights_fragment_maps and lights_fragment_end" },
  normal_fragment: { release: 91, note: "it was split into normal_fragment_begin and normal_fragment_maps" },
};

/** Chunk renames where the new chunk has exactly the old GLSL (checked against r153 and r154), safe for `fix`. */
export const CHUNK_RENAMES: Record<string, string> = {
  encodings_fragment: "colorspace_fragment",
  encodings_pars_fragment: "colorspace_pars_fragment",
  output_fragment: "opaque_fragment",
};

/** Chunks the project registers itself (`ShaderChunk.name = ...`). */
export function customChunks(all: string): Set<string> {
  const out = new Set<string>();
  for (const m of all.matchAll(/ShaderChunk\s*(?:\.\s*(\w+)|\[\s*['"`](\w+)['"`]\s*\])\s*=(?!=)/g)) out.add((m[1] ?? m[2]) as string);
  return out;
}

export interface BuildExports {
  three: Set<string>;
  webgpu: Set<string>;
  tsl: Set<string>;
}

const exportCache = new Map<string, BuildExports | undefined>();

function exportNames(path: string): Set<string> | undefined {
  if (!existsSync(path)) return undefined;
  const out = new Set<string>();
  for (const m of readFileSync(path, "utf8").matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const t = part.trim();
      if (!t) continue;
      const [name, alias] = t.split(/\s+as\s+/);
      out.add((alias ?? name ?? "").trim());
    }
  }
  return out;
}

/** What `three`, `three/webgpu` and `three/tsl` export in the installed build. */
export function buildExports(root: string): BuildExports | undefined {
  if (exportCache.has(root)) return exportCache.get(root);
  const three = exportNames(join(root, "build", "three.module.js"));
  const webgpu = exportNames(join(root, "build", "three.webgpu.js"));
  const tsl = exportNames(join(root, "build", "three.tsl.js"));
  const r = three && webgpu && tsl && tsl.size > 100 ? { three, webgpu, tsl } : undefined;
  exportCache.set(root, r);
  return r;
}

// ---- per-frame code ----

const LOOP_NAMES = "animate|render|update|tick|loop|frame|draw|onFrame|renderLoop|mainLoop|gameLoop|animation";

/** Bodies of functions that run every frame. */
export function loopBodies(f: SourceFile): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const res = [
    new RegExp(String.raw`function\s+(?:${LOOP_NAMES})\w*\s*\([^)]*\)\s*\{`, "g"),
    new RegExp(String.raw`(?:const|let|var)\s+(?:${LOOP_NAMES})\w*\s*=\s*(?:async\s*)?(?:function\s*\w*\s*)?\([^)]*\)\s*(?:=>\s*)?\{`, "g"),
    new RegExp(String.raw`^\s*(?:async\s+)?(?:${LOOP_NAMES})\w*\s*\([^)]*\)\s*\{`, "gm"),
    /setAnimationLoop\(\s*(?:async\s*)?(?:function\s*\w*\s*)?\([^)]*\)\s*(?:=>\s*)?\{/g,
    /requestAnimationFrame\(\s*(?:async\s*)?(?:function\s*\w*\s*)?\([^)]*\)\s*(?:=>\s*)?\{/g,
    // React Three Fiber runs useFrame callbacks every frame
    /\buseFrame\(\s*(?:async\s*)?(?:function\s*\w*\s*\([^)]*\)|\([^)]*\)\s*=>|[\w$]+\s*=>)\s*\{/g,
  ];
  for (const re of res) {
    for (const m of f.text.matchAll(re)) {
      const b = blockAt(f.text, (m.index ?? 0) + m[0].length - 1);
      if (b) out.push(b);
    }
  }
  return out;
}


// ---- helpers shared by the rule files ----

export function each(ctx: Ctx, re: RegExp, report: Report, pick: (m: RegExpExecArray, f: SourceFile) => boolean = () => true): void {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  for (const f of ctx.three) {
    for (const m of f.text.matchAll(new RegExp(re.source, flags))) {
      if (pick(m as RegExpExecArray, f)) report(f, m.index ?? 0);
    }
  }
}

/** Regex source that matches a three class via namespace (THREE.X) or a bare import. */
export function ns(f: SourceFile): string {
  return f.namespaces.size ? `(?:(?:${[...f.namespaces].join("|")})\\.)` : "(?:THREE\\.)";
}

export function inLoops(ctx: Ctx, re: RegExp, report: Report, pick: (name: string, f: SourceFile) => boolean = () => true): void {
  for (const f of ctx.three) {
    for (const b of loopBodies(f)) {
      const body = f.text.slice(b.start, b.end);
      for (const m of body.matchAll(new RegExp(re.source, "g"))) {
        if (pick(m[1] ?? "", f)) report(f, b.start + (m.index ?? 0));
      }
    }
  }
}

export function legacy(
  id: string,
  title: string,
  re: RegExp,
  message: string,
  fix: string,
  extra: Partial<Rule> = {},
): Rule {
  return {
    id,
    category: "api",
    severity: "warn",
    title,
    message,
    fix,
    check(ctx, report) {
      each(ctx, re, report);
    },
    ...extra,
  };
}

