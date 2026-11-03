import { statSync, writeFileSync } from "node:fs";
import { findThree } from "../api/install.js";
import { collect } from "./source.js";

/**
 * Mechanical fixes for review findings: renames where the old and the new name mean exactly the same thing. Anything
 * that needs a decision (colorSpace of a texture, disposing, moving code out of the loop) is left to the agent.
 */
interface Fix {
  rule: string;
  re: RegExp;
  replace: (m: RegExpExecArray) => string;
  /** Release in which the new name exists; the fix is skipped for older installs. */
  introducedIn?: number;
}

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
];

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
}

export function fix(opts: { path: string; three?: string; write?: boolean; only?: string[] }): FixResult {
  const isDir = statSync(opts.path).isDirectory();
  const install = findThree(isDir ? opts.path : opts.path + "/..", opts.three);
  const release = install?.release ?? Number.POSITIVE_INFINITY;
  const collected = collect(opts.path);
  const base = isDir ? opts.path : opts.path + "/..";
  const files: FileFix[] = [];
  for (const f of collected.files) {
    if (!f.usesThree) continue;
    const edits: { start: number; end: number; text: string; rule: string }[] = [];
    for (const fx of FIXES) {
      if (opts.only && !opts.only.includes(fx.rule)) continue;
      if (fx.introducedIn !== undefined && release < fx.introducedIn) continue;
      for (const m of f.text.matchAll(new RegExp(fx.re.source, fx.re.flags))) {
        const start = m.index ?? 0;
        const text = fx.replace(m as RegExpExecArray);
        // an import list that already has the new name would get it twice
        if (fx.rule === "buffer-geometry-alias" || fx.rule === "merge-buffer-geometries") {
          const before = f.text.slice(Math.max(0, start - 400), start);
          const inImport = /import\s*\{[^}]*$/.test(before);
          if (inImport && new RegExp(String.raw`\b${text}\b`).test(f.text.slice(0, start + m[0].length + 400).split(/from\s+['"]/)[0] ?? "")) continue;
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
  return { release: install ? install.release : null, files, total: files.reduce((a, f) => a + f.count, 0), written: !!opts.write };
}

export function formatFix(r: FixResult): string {
  if (!r.total) return "Nothing to fix mechanically.";
  const lines = [r.written ? `Fixed ${r.total} place(s) in ${r.files.length} file(s):` : `Would fix ${r.total} place(s) in ${r.files.length} file(s) (add --write to apply):`];
  for (const f of r.files) lines.push(`  ${f.file}: ${f.count} (${f.rules.join(", ")})`);
  lines.push("Run `threesmith review` again; the rest needs a decision.");
  return lines.join("\n");
}

