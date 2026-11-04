import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { SourceFile } from "../review/source.js";

/**
 * The assets a three.js project loads, checked from the files alone: every model, texture, environment map, sound,
 * font or video path in the code is resolved the way the dev server and a static host would (public/, the page's
 * folder, the source file's folder), so the agent learns about a 404 before the browser shows an HTML page parsed as
 * a model. Also: paths that only work on a case-insensitive disk, decoder folders that are not there, glTF files that
 * need a decoder the code never sets up, very large textures, and asset files nothing refers to.
 */

export const MODEL_EXT = new Set([".glb", ".gltf", ".fbx", ".obj", ".stl", ".ply", ".dae", ".3ds", ".usdz", ".vrm", ".drc", ".3dm", ".pcd", ".vox"]);
export const TEXTURE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".ktx2", ".basis", ".hdr", ".exr", ".dds", ".tga", ".ktx"]);
const OTHER_EXT = new Set([".mp3", ".ogg", ".wav", ".m4a", ".mp4", ".webm", ".ttf", ".woff", ".woff2", ".bin"]);
const ALL_EXT = new Set([...MODEL_EXT, ...TEXTURE_EXT, ...OTHER_EXT]);
const SKIP_DIR = new Set(["node_modules", ".git", ".threesmith", "coverage", ".next", ".nuxt", ".svelte-kit", "dist", "build", "out"]);

export type AssetStatus = "ok" | "missing" | "case" | "remote" | "dynamic";

export interface AssetRef {
  /** The path as written in the code. */
  ref: string;
  file: string;
  line: number;
  status: AssetStatus;
  /** Where it was found, relative to the project. */
  resolved?: string;
  /** For "case": the file that exists with different capitals. For "missing": a file with the same name elsewhere. */
  hint?: string;
  bytes?: number;
}

export interface AssetProblem {
  severity: "error" | "warn" | "info";
  kind: "missing" | "case" | "decoder-folder" | "decoder-setup" | "large-texture" | "large-model" | "unused";
  file?: string;
  line?: number;
  message: string;
  fix: string;
}

export interface AssetReport {
  root: string;
  publicDir: string | null;
  refs: AssetRef[];
  /** Asset files on disk (relative), with size. */
  files: { file: string; bytes: number; width?: number; height?: number; extensions?: string[] }[];
  problems: AssetProblem[];
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Asset files under the project (skipping node_modules and build output). */
function listAssets(root: string, max = 4000): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= max) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) walk(p);
      } else if (ALL_EXT.has(extname(e.name).toLowerCase())) out.push(relative(root, p).split(sep).join("/"));
    }
  };
  walk(root);
  return out;
}

function readHead(path: string, bytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** Width and height of a PNG or JPEG from its header. */
export function imageSize(path: string): { width: number; height: number } | undefined {
  try {
    const b = readHead(path, 256 * 1024);
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = b[i + 1] as number;
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
    if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
      const kind = b.toString("ascii", 12, 16);
      if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (kind === "VP8L") {
        const v = b.readUInt32LE(21);
        return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    /* unreadable */
  }
  return undefined;
}

/** The glTF extensions a .glb or .gltf uses (extensionsUsed), read from its JSON without loading buffers. */
export function gltfExtensions(path: string): string[] | undefined {
  try {
    let json: string;
    if (path.toLowerCase().endsWith(".glb")) {
      const head = readHead(path, 20);
      if (head.length < 20 || head.readUInt32LE(0) !== 0x46546c67) return undefined;
      const len = head.readUInt32LE(12);
      if (head.readUInt32LE(16) !== 0x4e4f534a || len > 64 * 1024 * 1024) return undefined;
      json = readHead(path, 20 + len).subarray(20).toString("utf8");
    } else {
      if (statSync(path).size > 64 * 1024 * 1024) return undefined;
      json = readHead(path, statSync(path).size).toString("utf8");
    }
    const data = JSON.parse(json) as { extensionsUsed?: unknown };
    return Array.isArray(data.extensionsUsed) ? data.extensionsUsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return undefined;
  }
}

/** Decoder setups a glTF extension needs in three.js, and the code that shows it is done. */
export const GLTF_NEEDS: Record<string, { what: string; done: RegExp; fix: string }> = {
  KHR_draco_mesh_compression: {
    what: "Draco-compressed meshes",
    done: /setDRACOLoader\s*\(|useGLTF\s*\([^)]*,\s*(?:true|['"`])|useDraco|DRACOLoader/,
    fix: "const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/'); gltfLoader.setDRACOLoader(draco); (import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js')",
  },
  EXT_meshopt_compression: {
    what: "meshopt-compressed buffers",
    done: /setMeshoptDecoder\s*\(|useMeshopt|useGLTF\s*\([^)]*,\s*[^,)]*,\s*true/,
    fix: "gltfLoader.setMeshoptDecoder(MeshoptDecoder) with import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'",
  },
  KHR_texture_basisu: {
    what: "KTX2 (Basis) textures",
    done: /setKTX2Loader\s*\(|useKTX2/,
    fix: "const ktx2 = new KTX2Loader().setTranscoderPath('<folder with basis_transcoder.js/.wasm>').detectSupport(renderer); gltfLoader.setKTX2Loader(ktx2);",
  },
};

const LITERAL = /(['"`])((?:(?!\1)[^\n\\]|\\.){1,300})\1/g;

/** Asset references in one source file. */
function refsIn(f: SourceFile): { ref: string; offset: number; dynamic: boolean; prefixes: string[] }[] {
  const out: { ref: string; offset: number; dynamic: boolean; prefixes: string[] }[] = [];
  const prefixes = [...f.text.matchAll(/\.setPath\s*\(\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2] ?? "");
  for (const m of f.text.matchAll(LITERAL)) {
    const value = (m[2] ?? "").split(/[?#]/)[0] ?? "";
    const ext = extname(value).toLowerCase();
    if (!ALL_EXT.has(ext)) continue;
    if (/\s/.test(value) && !/^[^\s]+(?:\s[^\s]+){0,3}$/.test(value)) continue;
    // an import statement of an asset (Vite `import url from './a.glb'`) is resolved by the bundler the same way
    out.push({ ref: value, offset: m.index ?? 0, dynamic: m[1] === "`" && value.includes("${"), prefixes });
  }
  return out;
}

function findCase(root: string, rel: string): string | undefined {
  // walk the path segment by segment, matching without case
  const parts = rel.split("/").filter(Boolean);
  let dir = root;
  const found: string[] = [];
  for (const part of parts) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return undefined;
    }
    const exact = names.find((n) => n === part) ?? names.find((n) => n.toLowerCase() === part.toLowerCase());
    if (!exact) return undefined;
    found.push(exact);
    dir = join(dir, exact);
  }
  return found.join("/");
}

/** Does this exact path exist, with these exact capitals (also on a case-insensitive disk)? */
function existsExact(root: string, rel: string): boolean {
  const hit = findCase(root, rel);
  return hit !== undefined && hit === rel.split("/").filter(Boolean).join("/");
}

export function publicDirOf(root: string): string | null {
  return existsSync(join(root, "public")) && statSync(join(root, "public")).isDirectory() ? "public" : null;
}

export function checkAssets(root: string, files: SourceFile[], opts: { allText?: string } = {}): AssetReport {
  const base = resolve(root);
  const pub = publicDirOf(base);
  const onDisk = listAssets(base);
  const byName = new Map<string, string[]>();
  for (const a of onDisk) {
    const n = basename(a).toLowerCase();
    byName.set(n, [...(byName.get(n) ?? []), a]);
  }
  const refs: AssetRef[] = [];
  const problems: AssetProblem[] = [];
  const htmlDirs = [...new Set(files.filter((f) => /\.html?$/.test(f.path)).map((f) => dirname(f.path)))];

  for (const f of files) {
    for (const r of refsIn(f)) {
      const line = lineOf(f.text, r.offset);
      if (/^(?:https?:)?\/\//.test(r.ref) || r.ref.startsWith("data:") || r.ref.startsWith("blob:")) {
        refs.push({ ref: r.ref, file: f.path, line, status: "remote" });
        continue;
      }
      if (r.dynamic) {
        refs.push({ ref: r.ref, file: f.path, line, status: "dynamic" });
        continue;
      }
      const clean = r.ref.replace(/^\.\//, "");
      const candidates: string[] = [];
      const add = (p: string) => {
        const n = posixNormalize(p);
        if (n && !n.startsWith("..") && !candidates.includes(n)) candidates.push(n);
      };
      const withPrefixes = [r.ref, ...r.prefixes.map((p) => (p.endsWith("/") ? p : p + "/") + clean)];
      for (const ref of withPrefixes) {
        if (ref.startsWith("/")) {
          if (pub) add(`${pub}${ref}`);
          add(ref.slice(1));
          for (const h of htmlDirs) add(`${h}/${ref.slice(1)}`);
        } else {
          const c = ref.replace(/^\.\//, "");
          add(`${dirname(f.path)}/${c}`);
          if (pub) add(`${pub}/${c}`);
          add(c);
          for (const h of htmlDirs) add(`${h}/${c}`);
        }
      }
      const exact = candidates.find((c) => existsExact(base, c));
      if (exact) {
        let bytes: number | undefined;
        try {
          bytes = statSync(join(base, exact)).size;
        } catch {
          bytes = undefined;
        }
        refs.push({ ref: r.ref, file: f.path, line, status: "ok", resolved: exact, ...(bytes !== undefined ? { bytes } : {}) });
        continue;
      }
      const cased = candidates.map((c) => findCase(base, c)).find((x): x is string => !!x);
      if (cased) {
        refs.push({ ref: r.ref, file: f.path, line, status: "case", resolved: cased, hint: cased });
        problems.push({
          severity: "error",
          kind: "case",
          file: f.path,
          line,
          message: `"${r.ref}" only matches ${cased} with different capitals: it loads on macOS and Windows and is a 404 on Linux servers and most hosts.`,
          fix: `Write the path exactly as the file is named (${cased.replace(/^public\//, pub ? "/" : "")}), or rename the file.`,
        });
        continue;
      }
      const same = byName.get(basename(clean).toLowerCase());
      refs.push({ ref: r.ref, file: f.path, line, status: "missing", ...(same?.[0] ? { hint: same[0] } : {}) });
      problems.push({
        severity: "error",
        kind: "missing",
        file: f.path,
        line,
        message: `"${r.ref}" is not in the project (looked in ${candidates.slice(0, 3).join(", ")}${candidates.length > 3 ? ", ..." : ""}). The server answers with an HTML page, which the loader then fails to parse ("Unexpected token '<'").`,
        fix: same?.length
          ? `A file with that name is at ${same[0]}; ${pub && same[0]!.startsWith(`${pub}/`) ? `refer to it as "/${same[0]!.slice(pub.length + 1)}"` : pub ? `move it into ${pub}/ (served at /) or import it so the bundler copies it` : "fix the path"}.`
          : `Add the file${pub ? ` under ${pub}/ (served at /)` : ""}, or fix the path.`,
      });
    }
  }

  const all = opts.allText ?? files.map((f) => f.text).join("\n");
  // decoder folders on this server
  for (const f of files) {
    for (const m of f.text.matchAll(/\.set(Decoder|Transcoder)Path\s*\(\s*(['"`])([^'"`]+)\2/g)) {
      const path = m[3] ?? "";
      if (/^(?:https?:)?\/\//.test(path)) continue;
      const kind = m[1] === "Decoder" ? "draco" : "basis";
      const want = kind === "draco" ? ["draco_decoder.js", "draco_wasm_wrapper.js", "draco_decoder.wasm"] : ["basis_transcoder.js", "basis_transcoder.wasm"];
      const rel = path.replace(/^\.?\//, "").replace(/\/?$/, "/");
      const dirs = [pub ? `${pub}/${rel}` : undefined, rel].filter((x): x is string => !!x);
      const ok = dirs.some((d) => want.some((w) => existsSync(join(base, d, w))));
      if (!ok) {
        problems.push({
          severity: "error",
          kind: "decoder-folder",
          file: f.path,
          line: lineOf(f.text, m.index ?? 0),
          message: `${kind === "draco" ? "DRACOLoader" : "KTX2Loader"} looks for its ${kind === "draco" ? "decoder" : "transcoder"} in "${path}", but ${want[0]} is not there: compressed models fail to load.`,
          fix: `Copy node_modules/three/examples/jsm/libs/${kind === "draco" ? "draco/gltf/" : "basis/"} to ${pub ? `${pub}/${rel}` : rel}, or point it at a CDN (${kind === "draco" ? "https://www.gstatic.com/draco/versioned/decoders/1.5.7/" : "https://cdn.jsdelivr.net/npm/three@<version>/examples/jsm/libs/basis/"}).`,
        });
      }
    }
  }

  const fileInfo: AssetReport["files"] = [];
  const referenced = new Set(refs.filter((r) => r.resolved).map((r) => r.resolved as string));
  const refNames = new Set(refs.map((r) => basename(r.ref.split(/[?#]/)[0] ?? "").toLowerCase()));
  for (const a of onDisk) {
    const full = join(base, a);
    let bytes = 0;
    try {
      bytes = statSync(full).size;
    } catch {
      continue;
    }
    const ext = extname(a).toLowerCase();
    const info: AssetReport["files"][number] = { file: a, bytes };
    if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp") {
      const s = imageSize(full);
      if (s) {
        info.width = s.width;
        info.height = s.height;
        if (Math.max(s.width, s.height) > 4096)
          problems.push({
            severity: "warn",
            kind: "large-texture",
            file: a,
            message: `${a} is ${s.width}x${s.height}: above 4096 many phones and integrated GPUs cannot upload it, and it takes ${Math.round((s.width * s.height * 4 * 1.33) / 1048576)} MB of GPU memory.`,
            fix: "Resize it to 2048 (or 4096 at most), or ship it as KTX2 (npx @gltf-transform/cli etc1s / uastc).",
          });
      }
    }
    if (ext === ".glb" || ext === ".gltf") {
      const exts = gltfExtensions(full);
      if (exts) info.extensions = exts;
      const used = referenced.has(a) || refNames.has(basename(a).toLowerCase());
      for (const e of exts ?? []) {
        const need = GLTF_NEEDS[e];
        if (need && used && !need.done.test(all))
          problems.push({
            severity: "error",
            kind: "decoder-setup",
            file: a,
            message: `${a} uses ${e} (${need.what}), but no code sets that decoder up on the GLTFLoader: loading fails.`,
            fix: need.fix,
          });
      }
      if (bytes > 20 * 1048576 && !(exts ?? []).some((e) => e in GLTF_NEEDS))
        problems.push({
          severity: "info",
          kind: "large-model",
          file: a,
          message: `${a} is ${(bytes / 1048576).toFixed(1)} MB and not compressed.`,
          fix: "npx @gltf-transform/cli optimize in.glb out.glb --compress draco --texture-compress webp (then set up DRACOLoader).",
        });
    }
    fileInfo.push(info);
  }
  // unused: only files in the public folder or an assets folder, and only when nothing is built at runtime
  const dynamic = refs.some((r) => r.status === "dynamic");
  for (const a of onDisk) {
    if (referenced.has(a) || refNames.has(basename(a).toLowerCase())) continue;
    if (!(pub && a.startsWith(`${pub}/`)) && !/(^|\/)(assets|models|textures)\//.test(a)) continue;
    if (/(^|\/)(draco|basis|libs)\//.test(a) || /favicon|apple-touch|og[-_.]|icon/i.test(a)) continue;
    // .bin and texture files next to a .gltf are loaded by it
    if (onDisk.some((g) => g.endsWith(".gltf") && dirname(g) === dirname(a))) continue;
    const bytes = fileInfo.find((i) => i.file === a)?.bytes ?? 0;
    if (bytes < 50 * 1024) continue;
    problems.push({
      severity: "info",
      kind: "unused",
      file: a,
      message: `${a} (${(bytes / 1048576).toFixed(1)} MB) is not referred to by name in the code${dynamic ? " (some paths are built at runtime, so it may be used)" : ""}.`,
      fix: "Delete it if nothing loads it, so the build does not ship it.",
    });
  }
  const order = { error: 0, warn: 1, info: 2 };
  problems.sort((a, b) => order[a.severity] - order[b.severity]);
  return { root: base, publicDir: pub, refs, files: fileInfo, problems };
}

function posixNormalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length) out.pop();
      else return "..";
    } else out.push(part);
  }
  return out.join("/");
}

export function formatAssets(r: AssetReport, opts: { limit?: number } = {}): string {
  const counts = { ok: 0, missing: 0, case: 0, remote: 0, dynamic: 0 };
  for (const x of r.refs) counts[x.status]++;
  const out = [
    `Assets: ${r.refs.length} reference(s) in code (${counts.ok} found, ${counts.missing} missing, ${counts.case} wrong case, ${counts.remote} remote, ${counts.dynamic} built at runtime); ${r.files.length} asset file(s) on disk${r.publicDir ? `; ${r.publicDir}/ is served at /` : ""}.`,
  ];
  const limit = opts.limit ?? 30;
  for (const p of r.problems.slice(0, limit)) out.push(`${p.severity} ${p.file ?? ""}${p.line ? `:${p.line}` : ""} [asset-${p.kind}] ${p.message} Fix: ${p.fix}`);
  if (r.problems.length > limit) out.push(`+${r.problems.length - limit} more`);
  if (!r.problems.length) out.push("No asset problems.");
  return out.join("\n");
}
