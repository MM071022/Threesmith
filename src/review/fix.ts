import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findThree } from "../api/install.js";
import { CHUNK_RENAMES, customChunks, esc, stringEnd } from "./parse.js";
import { tslImports } from "./scene-rules.js";
import { collect, type SourceFile } from "./source.js";

/**
 * Mechanical fixes for review findings: renames where the old and the new name mean exactly the same thing (checked in
 * the source of the release that renamed them), and a few rewrites with only one possible intent (render(scene, camera),
 * color.set(), getHelper(), the missing `.js`). Anything that needs a decision (colorSpace of a texture, disposing,
 * moving code out of the loop) is left to the agent.
 */
interface Env {
  /** Root of the installed three, when found. */
  root?: string;
  /** All reviewed text joined. */
  all: string;
}

interface Fix {
  rule: string;
  re: RegExp;
  replace: (m: RegExpExecArray) => string;
  /** Release in which the new name exists; the fix is skipped for older installs. */
  introducedIn?: number;
  /** Only in files where this holds. */
  when?: (f: SourceFile, env: Env) => boolean;
  /** Only matches where this holds. */
  pick?: (m: RegExpExecArray, f: SourceFile, env: Env) => boolean;
  /** Match code only: string contents are blanked first (identifier renames must not touch messages). */
  code?: boolean;
  /** The new name may already be in the same import list: skip the edit there instead of importing it twice. */
  importGuard?: boolean;
}

/** `text` with the contents of string literals blanked (same length), so identifier renames skip messages. */
function codeOnly(text: string): string {
  const out = text.split("");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "'" && c !== '"' && c !== "`") continue;
    const end = stringEnd(text, i);
    for (let j = i + 1; j < end && j < text.length; j++) if (out[j] !== "\n") out[j] = " ";
    i = end;
  }
  return out.join("");
}

const importsWebgpu = (f: SourceFile): boolean => /['"]three\/webgpu['"]/.test(f.text);
const chunk = (old: string, env: Env): string | undefined => (customChunks(env.all).has(old) ? undefined : CHUNK_RENAMES[old]);
const CHUNKS = Object.keys(CHUNK_RENAMES).join("|");
const TSL: Record<string, [string, number]> = { directionToColor: ["packNormalToRGB", 185], colorToDirection: ["unpackRGBToNormal", 185], directionToFaceDirection: ["negateOnBackSide", 185], PI2: ["TWO_PI", 181] };

const BUFFER = "Box|Sphere|Plane|Cylinder|Circle|Cone|Torus|TorusKnot|Ring|Lathe|Extrude|Shape|Tube|Icosahedron|Octahedron|Tetrahedron|Dodecahedron|Polyhedron|Parametric|Capsule|Edges|Wireframe";

export const FIXES: Fix[] = [
  { rule: "buffer-geometry-alias", re: new RegExp(String.raw`\b(${BUFFER})BufferGeometry\b`, "g"), replace: (m) => `${m[1]}Geometry` },
  { rule: "three-math", re: /\bTHREE\.Math\.(?!PI\b)(\w+)/g, replace: (m) => `THREE.MathUtils.${m[1]}`, introducedIn: 113 },
  { rule: "apply-matrix", re: /\.applyMatrix\s*\(/g, replace: () => ".applyMatrix4(" },
  { rule: "merge-buffer-geometries", re: /\bmergeBufferGeometries\b/g, replace: () => "mergeGeometries", introducedIn: 151 },
  { rule: "merge-buffer-geometries", re: /\bmergeBufferAttributes\b/g, replace: () => "mergeAttributes", introducedIn: 151 },
  { rule: "addons-path", re: /(['"])three\/examples\/jsm\//g, replace: (m) => `${m[1]}three/addons/` },
  { rule: "output-encoding", re: /\.outputEncoding\s*=\s*(?:THREE\.)?sRGBEncoding\b/g, replace: () => ".outputColorSpace = THREE.SRGBColorSpace", introducedIn: 152 },
  { rule: "texture-encoding", re: /\.encoding\s*=\s*THREE\.sRGBEncoding\b/g, replace: () => ".colorSpace = THREE.SRGBColorSpace", introducedIn: 152 },
  { rule: "texture-encoding", re: /\.encoding\s*=\s*THREE\.LinearEncoding\b/g, replace: () => ".colorSpace = THREE.NoColorSpace", introducedIn: 152 },
  { rule: "pixel-ratio-uncapped", re: /setPixelRatio\s*\(\s*((?:window\.)?devicePixelRatio)\s*\)/g, replace: (m) => `setPixelRatio( Math.min( ${m[1]}, 2 ) )` },
  // shader chunks renamed in r154 with the same GLSL
  {
    rule: "shader-patch-target-missing",
    re: new RegExp(String.raw`(\.replace(?:All)?\s*\(\s*['"\`]\s*#include\s+<)(${CHUNKS})>`, "g"),
    replace: (m) => `${m[1]}${CHUNK_RENAMES[m[2] ?? ""]}>`,
    pick: (m, _f, env) => !!chunk(m[2] ?? "", env),
    introducedIn: 154,
  },
  {
    rule: "shader-include-unknown",
    re: new RegExp(String.raw`(?<!\.replace(?:All)?\s*\(\s*['"\`]\s*)#include\s+<(${CHUNKS})>`, "g"),
    replace: (m) => `#include <${CHUNK_RENAMES[m[1] ?? ""]}>`,
    pick: (m, _f, env) => !!chunk(m[1] ?? "", env),
    introducedIn: 154,
  },
  { rule: "shader-depth-define-renamed", re: /\bUSE_LOGDEPTHBUF\b/g, replace: () => "USE_LOGARITHMIC_DEPTH_BUFFER", introducedIn: 180 },
  { rule: "shader-depth-define-renamed", re: /\bUSE_REVERSEDEPTHBUF\b/g, replace: () => "USE_REVERSED_DEPTH_BUFFER", introducedIn: 180 },
  {
    // `#define inverseTransformDirection transformDirectionByInverseViewMatrix` in r185+ common.glsl.js
    rule: "shader-inverse-transform-direction",
    re: /\binverseTransformDirection(?=\s*\()/g,
    replace: () => "transformDirectionByInverseViewMatrix",
    when: (f) => !/\bvec3\s+inverseTransformDirection\s*\(/.test(f.text),
    introducedIn: 185,
  },
  // RGBELoader is `class RGBELoader extends HDRLoader {}` plus a warning since r180
  { rule: "rgbe-loader-deprecated", re: /\bRGBELoader\b/g, replace: () => "HDRLoader", code: true, when: (f) => !/\bHDRLoader\b/.test(f.text) && /\bimport\b[^;]*\bRGBELoader\b/.test(f.text), introducedIn: 180 },
  { rule: "rgbe-loader-deprecated", re: /(['"])three\/(addons|examples\/jsm)\/loaders\/RGBELoader\.js\1/g, replace: (m) => `${m[1]}three/${m[2]}/loaders/HDRLoader.js${m[1]}`, when: (f) => !/\bHDRLoader\b/.test(f.text), introducedIn: 180 },
  // WebGLRenderer replaces PCFSoftShadowMap by PCFShadowMap itself since r182
  { rule: "pcf-soft-shadow", re: /\bPCFSoftShadowMap\b/g, replace: () => "PCFShadowMap", code: true, importGuard: true, introducedIn: 182 },
  // PostProcessing is `class PostProcessing extends RenderPipeline {}` plus a warning since r183
  { rule: "post-processing-renamed", re: /\bPostProcessing\b/g, replace: () => "RenderPipeline", code: true, importGuard: true, when: importsWebgpu, introducedIn: 183 },
  { rule: "reverse-depth-buffer-option", re: /\breverseDepthBuffer(\s*:)/g, replace: (m) => `reversedDepthBuffer${m[1]}`, introducedIn: 179 },
  { rule: "color-buffer-type-option", re: /\bcolorBufferType(\s*:)/g, replace: (m) => `outputBufferType${m[1]}`, when: importsWebgpu, introducedIn: 182 },
  {
    rule: "text-geometry-height",
    re: /(new\s+(?:[\w$]+\.)?TextGeometry\s*\([^{}()]*\{[^{}]*?)\bheight(\s*:)/g,
    replace: (m) => `${m[1]}depth${m[2]}`,
    pick: (m, f) => !/^[^{}]*\bdepth\s*:/.test(f.text.slice((m.index ?? 0) + m[0].length)),
    introducedIn: 163,
  },
  {
    rule: "transform-controls-add",
    re: /(\.add\s*\(\s*)((?:this\.)?[\w$]+)(\s*\))/g,
    replace: (m) => `${m[1]}${m[2]}.getHelper()${m[3]}`,
    pick: (m, f) => new RegExp(String.raw`\b${esc((m[2] ?? "").replace(/^this\./, ""))}\s*=\s*new\s+(?:[\w$]+\.)?TransformControls\s*\(`).test(f.text),
    introducedIn: 169,
  },
  {
    rule: "addon-path-extension",
    re: /((?:from\s*|import\s*\(\s*)['"]three\/(?:addons|examples\/jsm)\/)([^'"]+)(['"])/g,
    replace: (m) => `${m[1]}${m[2]}.js${m[3]}`,
    pick: (m, _f, env) => !!env.root && !/\.\w+$/.test(m[2] ?? "") && existsSync(join(env.root, "examples", "jsm", `${m[2]}.js`)),
  },
  {
    rule: "render-args-swapped",
    re: /(\.render\s*\(\s*)((?:this\.)?\w*[cC]amera\w*)(\s*,\s*)((?:this\.)?\w*[sS]cene\w*)(\s*\))/g,
    replace: (m) => `${m[1]}${m[4]}${m[3]}${m[2]}${m[5]}`,
    pick: (m) => !/[sS]cene/.test(m[2] ?? ""),
  },
  {
    rule: "color-assign-number",
    re: /(\b(?:[\w$]*[mM]aterial[\w$]*|mat|[\w$]*[lL]ight[\w$]*)(?:\s*\[[^\]]+\])?\s*\.\s*(?:color|emissive|specular|sheenColor|specularColor|attenuationColor|groundColor))\s*=(?!=)\s*(0x[\da-fA-F]+\b|'[^'\n]*'|"[^"\n]*")/g,
    replace: (m) => `${m[1]}.set( ${m[2]} )`,
  },
  ...Object.entries(TSL).map(
    ([old, [to, since]]): Fix => ({
      rule: "tsl-renamed",
      re: new RegExp(String.raw`(?<![\w$.])${old}(?![\w$])`, "g"),
      replace: () => to,
      code: true,
      importGuard: true,
      when: (f) => tslImports(f).get(old) === old,
      introducedIn: since,
    }),
  ),
];

/**
 * Fixes that rewrite code rather than rename it (one intent only, but more than a name changes). They run only when
 * asked for: `rewrites: true`, or their rule id in `only`. A dry run counts what they would change.
 */
export const REWRITE_RULES: ReadonlySet<string> = new Set(["transform-controls-add", "addon-path-extension", "render-args-swapped", "color-assign-number"]);

export interface FileFix {
  file: string;
  count: number;
  rules: string[];
  /** Text after the fixes. */
  fixed: string;
}

export interface FixResult {
  release: number | null;
  files: FileFix[];
  total: number;
  written: boolean;
  /** Places the rewrites would change when they were not asked for, per rule. */
  rewritesSkipped?: Record<string, number>;
}

export function fix(opts: { path: string; three?: string; write?: boolean; only?: string[]; rewrites?: boolean }): FixResult {
  const isDir = statSync(opts.path).isDirectory();
  const install = findThree(isDir ? opts.path : opts.path + "/..", opts.three);
  const release = install?.release ?? Number.POSITIVE_INFINITY;
  const collected = collect(opts.path);
  const base = isDir ? opts.path : opts.path + "/..";
  const files: FileFix[] = [];
  const skipped: Record<string, number> = {};
  const glsl = (f: SourceFile) => f.usesThree || /#include\s+<|\bgl_(?:Position|FragColor)\b/.test(f.text);
  const env: Env = { ...(install ? { root: install.root } : {}), all: collected.files.filter(glsl).map((f) => f.text).join("\n") };
  for (const f of collected.files) {
    if (!glsl(f)) continue;
    const edits: { start: number; end: number; text: string; rule: string }[] = [];
    let code: string | undefined;
    for (const fx of FIXES) {
      if (opts.only && !opts.only.includes(fx.rule)) continue;
      if (fx.introducedIn !== undefined && release < fx.introducedIn) continue;
      if (!f.usesThree && !fx.rule.startsWith("shader-")) continue;
      if (fx.when && !fx.when(f, env)) continue;
      const source = fx.code ? (code ??= codeOnly(f.text)) : f.text;
      for (const m of source.matchAll(new RegExp(fx.re.source, fx.re.flags))) {
        if (fx.pick && !fx.pick(m as RegExpExecArray, f, env)) continue;
        const start = m.index ?? 0;
        const text = fx.replace(m as RegExpExecArray);
        // an import list that already has the new name would get it twice
        if (fx.importGuard || fx.rule === "buffer-geometry-alias" || fx.rule === "merge-buffer-geometries") {
          const before = f.text.slice(Math.max(0, start - 400), start);
          const inImport = /import\s*\{[^}]*$/.test(before);
          if (inImport && new RegExp(String.raw`\b${text}\b`).test(f.text.slice(0, start + m[0].length + 400).split(/from\s+['"]/)[0] ?? "")) continue;
        }
        if (REWRITE_RULES.has(fx.rule) && !opts.rewrites && !opts.only?.includes(fx.rule)) {
          skipped[fx.rule] = (skipped[fx.rule] ?? 0) + 1;
          continue;
        }
        edits.push({ start, end: start + m[0].length, text, rule: fx.rule });
      }
    }
    if (!edits.length) continue;
    // comments were blanked with the same length, so offsets in `text` are offsets in `raw`
    edits.sort((a, b) => b.start - a.start);
    let out = f.raw;
    let last = Number.POSITIVE_INFINITY;
    let count = 0;
    const rules = new Set<string>();
    for (const e of edits) {
      if (e.end > last) continue; // overlapping edit
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
      last = e.start;
      count++;
      rules.add(e.rule);
    }
    files.push({ file: f.path, count, rules: [...rules].sort(), fixed: out });
  }
  if (opts.write) {
    for (const f of files) writeFileSync(`${base}/${f.file}`.replace(/\/\.\//, "/"), f.fixed);
  }
  return {
    release: install ? install.release : null,
    files,
    total: files.reduce((a, f) => a + f.count, 0),
    written: !!opts.write,
    ...(Object.keys(skipped).length ? { rewritesSkipped: skipped } : {}),
  };
}

export function formatFix(r: FixResult): string {
  const rw = Object.entries(r.rewritesSkipped ?? {});
  const rwLine = rw.length
    ? `Rewrites not applied (more than a rename; check them, then pass rewrites: true / --rewrites or the rule in only): ${rw.map(([k, n]) => `${k} x${n}`).join(", ")}.`
    : "";
  if (!r.total) return rwLine ? `Nothing to rename mechanically.\n${rwLine}` : "Nothing to fix mechanically.";
  const lines = [r.written ? `Fixed ${r.total} place(s) in ${r.files.length} file(s):` : `Would fix ${r.total} place(s) in ${r.files.length} file(s) (add --write to apply):`];
  for (const f of r.files) lines.push(`  ${f.file}: ${f.count} (${f.rules.join(", ")})`);
  if (rwLine) lines.push(rwLine);
  lines.push("Run `threesmith review` again; the rest needs a decision.");
  return lines.join("\n");
}

