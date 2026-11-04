import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { firstSentence, parseDoc } from "./jsdoc.js";
import type { ApiEntry, Member, Param, ThreeInstall } from "./types.js";

interface ExportRef {
  /** Path relative to the package root, posix separators. */
  file: string;
  /** Local name in that file, or "default". */
  local: string;
  importPath: string;
}

export interface ApiIndex {
  install: ThreeInstall;
  /** Public symbol -> where it lives. */
  exports: Map<string, ExportRef>;
  /** Symbols only exported by three/webgpu. */
  webgpuOnly: Set<string>;
  getEntry(name: string): ApiEntry | undefined;
  allEntries(): ApiEntry[];
}

const ENTRY_FILES: { file: string; importPath: string }[] = [
  { file: "src/Three.js", importPath: "three" },
  { file: "src/Three.Core.js", importPath: "three" },
  { file: "src/Three.WebGPU.js", importPath: "three/webgpu" },
];

function read(root: string, rel: string): string | undefined {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
}

function resolveRel(fromFile: string, spec: string): string {
  return posix.normalize(posix.join(posix.dirname(fromFile), spec));
}

function addExports(
  root: string,
  file: string,
  importPath: string,
  map: Map<string, ExportRef>,
  seen = new Set<string>(),
): void {
  if (seen.has(file)) return;
  seen.add(file);
  const text = read(root, file);
  if (text === undefined) return;
  const add = (name: string, f: string, local: string) => {
    if (!map.has(name)) map.set(name, { file: f, local, importPath });
  };
  // export * from './x.js'
  for (const m of text.matchAll(/^export\s*\*\s*from\s*['"]([^'"]+)['"]/gm)) {
    const target = resolveRel(file, m[1] ?? "");
    const body = read(root, target);
    if (body === undefined) continue;
    if (/^export\s*\*\s*from/m.test(body)) addExports(root, target, importPath, map, seen);
    for (const d of body.matchAll(/^export\s+(?:const|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      add(d[1] ?? "", target, d[1] ?? "");
    }
    // names a file imports, so `import { A } from './A.js'; export { A };` points at A.js, where the class is
    const imported = new Map<string, { file: string; local: string }>();
    for (const d of body.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
      for (const part of (d[1] ?? "").split(",")) {
        const [a, b] = part.trim().split(/\s+as\s+/);
        if (a) imported.set(b ?? a, { file: resolveRel(target, d[2] ?? ""), local: a });
      }
    }
    for (const d of body.matchAll(/^export\s*\{([^}]+)\}\s*(?:from\s*['"]([^'"]+)['"])?/gm)) {
      for (const part of (d[1] ?? "").split(",")) {
        const [a, b] = part.trim().split(/\s+as\s+/);
        if (!a) continue;
        const pub = b ?? a;
        const via = d[2] ? undefined : imported.get(a);
        if (via) add(pub, via.file, via.local);
        else add(pub, d[2] ? resolveRel(target, d[2]) : target, a);
      }
    }
  }
  // import * as X from './x.js'; export { X };
  const namespaces = new Map<string, string>();
  for (const m of text.matchAll(/^import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/gm)) {
    namespaces.set(m[1] ?? "", resolveRel(file, m[2] ?? ""));
  }
  for (const m of text.matchAll(/^export\s*\{([^}]+)\}\s*;/gm)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part.trim();
      const target = namespaces.get(name);
      if (target) add(name, target, "*");
    }
  }
  // export { A, default as B } from './x.js'
  for (const m of text.matchAll(/^export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
    const target = resolveRel(file, m[2] ?? "");
    for (const part of (m[1] ?? "").split(",")) {
      const [a, b] = part.trim().split(/\s+as\s+/);
      if (!a) continue;
      add(b ?? a, target, a);
    }
  }
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "libs") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
}

function addAddons(root: string, map: Map<string, ExportRef>): void {
  const base = join(root, "examples", "jsm");
  if (!existsSync(base)) return;
  const files: string[] = [];
  walk(base, files);
  for (const abs of files) {
    const rel = relative(root, abs).split("\\").join("/");
    const sub = relative(base, abs).split("\\").join("/");
    if (sub === "Addons.js") continue;
    const text = readFileSync(abs, "utf8");
    const importPath = `three/addons/${sub}`;
    const add = (name: string, local: string) => {
      if (!/^[A-Z]/.test(name)) return;
      if (!map.has(name)) map.set(name, { file: rel, local, importPath });
    };
    for (const m of text.matchAll(/^export\s+(?:class|function|const)\s+([A-Za-z_$][\w$]*)/gm)) add(m[1] ?? "", m[1] ?? "");
    for (const m of text.matchAll(/^export\s*\{([^}]+)\}\s*;?\s*$/gm)) {
      for (const part of (m[1] ?? "").split(",")) {
        const [a, b] = part.trim().split(/\s+as\s+/);
        if (a) add(b ?? a, a);
      }
    }
  }
}

function paramsOf(doc: ReturnType<typeof parseDoc>): Param[] {
  return doc.params;
}

function argList(line: string): string {
  const m = /\(([^)]*)\)/.exec(line);
  return (m?.[1] ?? "").replace(/\s+/g, " ").trim();
}

function parseClassBody(body: string): { ctor: Param[]; members: Member[] } {
  const members: Member[] = [];
  let ctor: Param[] = [];
  const re = /^(\t+)\/\*\*([\s\S]*?)\*\/[ \t]*\n\1([^\n]*)$/gm;
  for (const m of body.matchAll(re)) {
    const indent = (m[1] ?? "").length;
    const doc = parseDoc(m[2] ?? "");
    const decl = (m[3] ?? "").trim();
    if (indent === 1) {
      const c = /^(static\s+)?(?:async\s+)?(get\s+|set\s+)?\*?([A-Za-z_$][\w$]*)\s*\(/.exec(decl);
      if (!c) continue;
      const name = c[3] ?? "";
      if (name === "constructor") {
        ctor = paramsOf(doc);
        continue;
      }
      const accessor = c[2]?.trim();
      const kind: Member["kind"] = accessor === "get" ? "getter" : accessor === "set" ? "setter" : c[1] ? "static-method" : "method";
      const args = doc.params.length
        ? doc.params.map((p) => (p.optional ? `${p.name}?` : p.name)).join(", ")
        : argList(decl);
      members.push({
        name,
        kind,
        signature: kind === "getter" || kind === "setter" ? name : `${c[1] ? "static " : ""}${name}( ${args} )`.replace("( )", "()"),
        description: doc.description,
        params: doc.params,
        ...(doc.returns ? { returns: doc.returns } : {}),
        ...(doc.type ? { type: doc.type } : {}),
        ...(doc.deprecated ? { deprecated: doc.deprecated } : {}),
      });
    } else if (indent === 2) {
      const p = /^this\.([A-Za-z_$][\w$]*)\s*=/.exec(decl);
      if (!p) continue;
      if (/=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/.test(decl)) {
        const args = doc.params.map((x) => (x.optional ? `${x.name}?` : x.name)).join(", ");
        members.push({
          name: p[1] ?? "",
          kind: "method",
          signature: `${p[1]}( ${args} )`.replace("(  )", "()"),
          description: doc.description,
          params: doc.params,
          ...(doc.returns ? { returns: doc.returns } : {}),
          ...(doc.deprecated ? { deprecated: doc.deprecated } : {}),
        });
        continue;
      }
      members.push({
        name: p[1] ?? "",
        kind: "property",
        signature: p[1] ?? "",
        description: doc.description,
        params: [],
        ...(doc.type ? { type: doc.type } : {}),
        ...(doc.default ? { default: doc.default } : {}),
        ...(doc.deprecated ? { deprecated: doc.deprecated } : {}),
      });
    }
  }
  return { ctor, members };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseEntry(root: string, name: string, ref: ExportRef): ApiEntry | undefined {
  const text = read(root, ref.file);
  if (text === undefined) return undefined;
  let local = ref.local;
  if (local === "default") {
    const d = /^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m.exec(text);
    local = d?.[1] ?? name;
  }
  const base = { file: ref.file, importPath: ref.importPath };
  if (local === "*") {
    return { name, kind: "constant", ...base, description: "Namespace object: a module imported as a whole (import * as ...).", constructorParams: [], members: [], value: "namespace" };
  }
  const classRe = new RegExp(
    String.raw`(?:/\*\*((?:(?!\*/)[\s\S])*)\*/\s*)?(?:export\s+(?:default\s+)?)?class\s+${escapeRe(local)}\b([^{]*)\{`,
  );
  const cm = classRe.exec(text);
  if (cm) {
    const doc = parseDoc(cm[1] ?? "");
    const ext = /extends\s+([A-Za-z_$][\w$.]*)/.exec(cm[2] ?? "");
    const start = cm.index + cm[0].length;
    const endIdx = text.indexOf("\n}\n", start);
    const body = text.slice(start, endIdx === -1 ? undefined : endIdx);
    const parsed = parseClassBody(body);
    return {
      name,
      kind: "class",
      ...base,
      ...(ext?.[1] ? { extends: ext[1] } : {}),
      description: doc.description,
      constructorParams: parsed.ctor,
      members: parsed.members,
      ...(doc.deprecated ? { deprecated: doc.deprecated } : {}),
    };
  }
  const constRe = new RegExp(
    String.raw`(?:/\*\*((?:(?!\*/)[\s\S])*)\*/\s*)?export\s+const\s+${escapeRe(local)}\s*=\s*([^;\n]+)`,
  );
  const km = constRe.exec(text);
  if (km) {
    const doc = parseDoc(km[1] ?? "");
    return {
      name,
      kind: "constant",
      ...base,
      description: doc.description,
      constructorParams: [],
      members: [],
      value: (km[2] ?? "").trim(),
      ...(doc.deprecated ? { deprecated: doc.deprecated } : {}),
    };
  }
  const fnRe = new RegExp(
    String.raw`(?:/\*\*((?:(?!\*/)[\s\S])*)\*/\s*)?(?:export\s+)?function\s+${escapeRe(local)}\s*\(([^)]*)\)`,
  );
  const fm = fnRe.exec(text);
  if (fm) {
    const doc = parseDoc(fm[1] ?? "");
    return {
      name,
      kind: "function",
      ...base,
      description: doc.description,
      constructorParams: doc.params,
      members: [],
      ...(doc.returns ? { returns: doc.returns } : {}),
      ...(doc.deprecated ? { deprecated: doc.deprecated } : {}),
    } as ApiEntry;
  }
  return undefined;
}

/** Build the API index for one installed three package. Parsing is lazy and cached. */
export function buildIndex(install: ThreeInstall): ApiIndex {
  const exports = new Map<string, ExportRef>();
  const webgpuOnly = new Set<string>();
  for (const e of ENTRY_FILES) {
    const before = new Set(exports.keys());
    addExports(install.root, e.file, e.importPath, exports);
    if (e.importPath === "three/webgpu") {
      for (const k of exports.keys()) if (!before.has(k)) webgpuOnly.add(k);
    }
  }
  addAddons(install.root, exports);

  const cache = new Map<string, ApiEntry | null>();
  const getEntry = (name: string): ApiEntry | undefined => {
    const hit = cache.get(name);
    if (hit !== undefined) return hit ?? undefined;
    const ref = exports.get(name);
    const entry = ref ? parseEntry(install.root, name, ref) : undefined;
    cache.set(name, entry ?? null);
    return entry;
  };
  return {
    install,
    exports,
    webgpuOnly,
    getEntry,
    allEntries() {
      const out: ApiEntry[] = [];
      for (const name of exports.keys()) {
        const e = getEntry(name);
        if (e) out.push(e);
      }
      return out;
    },
  };
}

export { firstSentence };
