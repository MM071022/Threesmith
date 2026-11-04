import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { check as realCheck, formatCheck, type CheckOptions, type CheckResult, type IssueKind } from "./check.js";
import { stripComments } from "../review/source.js";
import { round } from "./util.js";

/**
 * Builds the project the way it ships (npm run build), then checks what came out: one copy of three, every asset the
 * bundle names is in the output (with the same letter case), absolute URLs that break when the site is served from a
 * sub-path (GitHub Pages), decoder files for Draco and KTX2, how big three is, and finally a headless check() of the
 * built page.
 */

export type BuildTool = "vite" | "webpack" | "parcel" | "next" | "rollup" | "esbuild" | "unknown";

export interface BuildRun {
  code: number | null;
  /** stdout and stderr together. */
  output: string;
  timedOut: boolean;
  ms: number;
}

/** Runs the build command; tests pass their own. */
export type BuildRunner = (command: string, args: string[], o: { cwd: string; timeoutMs: number }) => Promise<BuildRun>;

export interface BuildCheckOptions {
  /** Project folder (with package.json). */
  project: string;
  /** package.json script to run. Default "build". */
  script?: string;
  /** Output folder relative to the project; default from the tool's config, else dist, build or out. */
  outDir?: string;
  /** Deploy base ("/", "./", "/repo/"); default from the tool's config. */
  base?: string;
  /** Build timeout. Default 5 minutes. */
  timeoutMs?: number;
  /** Runs the build; false checks the output that is there without building. Default: the package manager. */
  run?: BuildRunner | false;
  /** Options for the headless check of the built page; false skips it. Default { wait: 1500 }. */
  check?: false | Omit<CheckOptions, "target" | "root">;
  /** Replaces check(), for tests. */
  checkPage?: typeof realCheck;
}

export type BuildIssueKind = "no-build-script" | "build-failed" | "no-output" | "three-duplicate" | "asset-missing" | "asset-case" | "case-conflict" | "absolute-url" | "decoder-missing" | IssueKind;

export interface BuildIssue {
  kind: BuildIssueKind;
  severity: "error" | "warn";
  message: string;
  /** Where: path relative to the project, with :line:col. */
  at?: string;
  fix?: string;
}

export interface ThreeCopy {
  /** File relative to the project. */
  file: string;
  revision: string;
}

export interface BuildResult {
  ok: boolean;
  project: string;
  tool: BuildTool;
  script?: string;
  /** What ran, e.g. "npm run build". */
  command?: string;
  build?: { code: number | null; ms: number; timedOut: boolean; tail: string[] };
  /** Output folder relative to the project. */
  outDir?: string;
  base: string;
  files: number;
  kb: number;
  three: {
    copies: ThreeCopy[];
    revisions: string[];
    /** Chunks that hold three: size and gzip size. */
    chunks: { file: string; kb: number; gzipKb: number }[];
    /** Bytes of three in the output, from the source maps (when the build wrote them). */
    kb?: number;
  };
  assets: { referenced: number; missing: number };
  issues: BuildIssue[];
  check?: CheckResult;
}

const MARKER = "Multiple instances of Three.js being imported";
const ASSET_EXT = "glb|gltf|hdr|exr|ktx2|png|jpe?g|webp|avif|gif|mp3|ogg|wav|m4a|mp4|webm|json|bin|wasm|drc|basis|fbx|obj|mtl|usdz|ttf|woff2?";
const ASSET_RE = new RegExp(`["'\`(]([^"'\`()\\s<>{}]*?\\.(?:${ASSET_EXT}))(?:[?#][^"'\`()\\s]*)?["'\`)]`, "gi");
const posixPath = (p: string) => p.split(sep).join("/");

/** Runs a command with a timeout and keeps its output. */
export const spawnRunner: BuildRunner = (command, args, o) =>
  new Promise((ok) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd: o.cwd, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, shell: process.platform === "win32" });
    let output = "";
    const keep = (d: Buffer) => {
      output += d.toString();
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, o.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      ok({ code: null, output: `${output}\n${e.message}`, timedOut, ms: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      ok({ code, output, timedOut, ms: Date.now() - started });
    });
  });

function packageManager(project: string): string {
  if (existsSync(join(project, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(project, "yarn.lock"))) return "yarn";
  if (existsSync(join(project, "bun.lockb")) || existsSync(join(project, "bun.lock"))) return "bun";
  return "npm";
}

function readConfig(project: string, names: string[]): string {
  for (const n of names) {
    const p = join(project, n);
    if (existsSync(p)) return stripComments(readFileSync(p, "utf8"));
  }
  return "";
}

const literal = (text: string, key: string): string | undefined => new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]*)["'\`]`).exec(text)?.[1];
const flag = (script: string, names: string[]): string | undefined => {
  for (const n of names) {
    const m = new RegExp(`(?:^|\\s)${n}(?:=|\\s+)["']?([^\\s"']+)`).exec(script);
    if (m) return m[1];
  }
  return undefined;
};

/** The build tool, output folder and deploy base, read from package.json and the tool's config where it is a plain string. */
export function detectBuild(project: string, script = "build"): { tool: BuildTool; script?: string; outDir?: string; base?: string } {
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as typeof pkg;
  } catch {
    pkg = {};
  }
  const cmd = pkg.scripts?.[script];
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const tools: BuildTool[] = ["vite", "next", "webpack", "parcel", "rollup", "esbuild"];
  const tool = tools.find((t) => cmd && new RegExp(`(^|[\\s/&;])${t}\\b`).test(cmd)) ?? tools.find((t) => t in deps) ?? "unknown";
  let outDir = cmd ? flag(cmd, ["--outDir", "--out-dir", "--dist-dir", "--output-path", "-o"]) : undefined;
  let base = cmd ? flag(cmd, ["--base", "--public-url"]) : undefined;
  if (tool === "vite") {
    const cfg = readConfig(project, ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts", "vite.config.cjs"]);
    outDir ??= literal(cfg, "outDir");
    base ??= literal(cfg, "base");
  } else if (tool === "next") {
    const cfg = readConfig(project, ["next.config.js", "next.config.mjs", "next.config.ts"]);
    outDir ??= "out"; // output: 'export' writes the static site to out/
    base ??= literal(cfg, "basePath");
  } else if (tool === "webpack") {
    const cfg = readConfig(project, ["webpack.config.js", "webpack.config.cjs", "webpack.config.mjs", "webpack.config.ts"]);
    outDir ??= /path\.(?:resolve|join)\(\s*__dirname\s*,\s*["'`]([^"'`]+)["'`]\s*\)/.exec(cfg)?.[1];
    base ??= literal(cfg, "publicPath");
  }
  return { tool, ...(cmd ? { script } : {}), ...(outDir ? { outDir: outDir.replace(/^\.\//, "").replace(/\/$/, "") } : {}), ...(base !== undefined ? { base } : {}) };
}

function listFiles(dir: string, max = 20_000): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (out.length >= max) return;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(posixPath(relative(dir, p)));
    }
  };
  walk(dir);
  return out.sort();
}

function lineCol(text: string, index: number): string {
  let line = 1;
  let last = -1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) {
    line++;
    last = i;
  }
  return `${line}:${index - last}`;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Bytes of a generated file that come from each source, from a source map's mappings. */
export function bytesPerSource(code: string, map: { sources: string[]; mappings: string }): Map<string, number> {
  const lines = code.split("\n").map((l) => l.length);
  const out = new Map<string, number>();
  let src = 0;
  const decode = (seg: string): number[] => {
    const vals: number[] = [];
    let value = 0;
    let shift = 0;
    for (const ch of seg) {
      const d = B64.indexOf(ch);
      if (d < 0) continue;
      value += (d & 31) << shift;
      if (d & 32) shift += 5;
      else {
        vals.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
    }
    return vals;
  };
  map.mappings.split(";").forEach((line, li) => {
    let col = 0;
    const segs = line ? line.split(",").map(decode) : [];
    const starts: { col: number; src: number | undefined }[] = [];
    for (const v of segs) {
      col += v[0] ?? 0;
      if (v.length >= 4) src += v[1] ?? 0;
      starts.push({ col, src: v.length >= 4 ? src : undefined });
    }
    const len = lines[li] ?? 0;
    starts.forEach((s, i) => {
      if (s.src === undefined) return;
      const end = starts[i + 1]?.col ?? len;
      const name = map.sources[s.src] ?? "?";
      out.set(name, (out.get(name) ?? 0) + Math.max(0, end - s.col));
    });
  });
  return out;
}

/** Checks a build output folder: three copies and size, asset references, letter case, absolute URLs, decoders. */
export function analyzeOutput(project: string, outDir: string, base: string): Pick<BuildResult, "files" | "kb" | "three" | "assets" | "issues"> {
  const root = resolve(project, outDir);
  const files = listFiles(root);
  const exact = new Set(files);
  const lower = new Map<string, string[]>();
  for (const f of files) lower.set(f.toLowerCase(), [...(lower.get(f.toLowerCase()) ?? []), f]);
  const issues: BuildIssue[] = [];
  const at = (file: string, text?: string, index?: number) => `${posixPath(join(outDir, file))}${text !== undefined && index !== undefined ? `:${lineCol(text, index)}` : ""}`;
  let bytes = 0;
  for (const f of files) bytes += statSync(join(root, f)).size;

  for (const group of lower.values()) {
    if (group.length > 1) issues.push({ kind: "case-conflict", severity: "warn", message: `${group.join(" and ")} differ only in letter case: one of them is lost on a case-insensitive disk (macOS, Windows) or zip.`, at: at(group[0]!), fix: "Rename one of them." });
  }

  // three: one marker string per copy (three.core's "Multiple instances" warning survives minification)
  const copies: ThreeCopy[] = [];
  const chunks: BuildResult["three"]["chunks"] = [];
  let threeBytes: number | undefined;
  const scripts = files.filter((f) => /\.(m?js|cjs)$/.test(f));
  const texts = new Map<string, string>();
  for (const f of scripts) {
    const text = readFileSync(join(root, f), "utf8");
    texts.set(f, text);
    let idx = text.indexOf(MARKER);
    if (idx < 0) continue;
    const size = Buffer.byteLength(text);
    chunks.push({ file: posixPath(join(outDir, f)), kb: round(size / 1024, 1), gzipKb: round(gzipSync(text).length / 1024, 1) });
    while (idx >= 0) {
      const near = text.slice(Math.max(0, idx - 800), idx + 300);
      const rev =
        /__THREE__\s*=\s*["'`](\d+(?:dev)?)["'`]/.exec(near)?.[1] ??
        /revision\s*:\s*["'`](\d+(?:dev)?)["'`]/.exec(near)?.[1] ??
        /\bREVISION\s*=\s*["'`](\d+(?:dev)?)["'`]/.exec(text)?.[1] ??
        "?";
      copies.push({ file: at(f, text, idx), revision: rev });
      idx = text.indexOf(MARKER, idx + MARKER.length);
    }
    const mapFile = `${f}.map`;
    if (exact.has(mapFile)) {
      try {
        const map = JSON.parse(readFileSync(join(root, mapFile), "utf8")) as { sources: string[]; mappings: string };
        for (const [source, n] of bytesPerSource(text, map)) if (/node_modules\/three\//.test(source)) threeBytes = (threeBytes ?? 0) + n;
      } catch {
        // an unreadable map: no exact size
      }
    }
  }
  const revisions = [...new Set(copies.map((c) => c.revision))];
  if (copies.length > 1) {
    issues.push({
      kind: "three-duplicate",
      severity: "error",
      message: `${copies.length} copies of three are bundled (${copies.map((c) => `r${c.revision} at ${c.file}`).join(", ")}). Objects from one copy fail instanceof checks in the other, and the page downloads three twice.`,
      at: copies[0]!.file,
      fix: `Make every package use one three: \`npm ls three\` shows who brings another; add "overrides": { "three": "$three" } to package.json${revisions.length > 1 ? " and align the versions" : ""}, and resolve.dedupe: ['three'] in the vite config. Import addons from 'three/addons/...', never from a second copy.`,
    });
  }

  // asset references in HTML, JS and CSS
  const baseDir = base && base.startsWith("/") ? base.replace(/\/?$/, "/") : "/";
  let referenced = 0;
  let missing = 0;
  const reported = new Set<string>();
  const lookup = (from: string, url: string): { found?: string; caseOf?: string } => {
    let u = url.split(/[?#]/)[0]!;
    try {
      u = decodeURI(u);
    } catch {
      // keep it as written
    }
    const candidates: string[] = [];
    if (u.startsWith("/")) {
      candidates.push(u.startsWith(baseDir) ? u.slice(baseDir.length) : u.slice(1));
    } else {
      candidates.push(posix.normalize(posix.join(posix.dirname(from), u)), posix.normalize(u));
    }
    for (const c of candidates) if (exact.has(c)) return { found: c };
    for (const c of candidates) {
      const other = lower.get(c.toLowerCase());
      if (other) return { caseOf: other[0]! };
    }
    return {};
  };
  const absolute: string[] = [];
  for (const f of files.filter((x) => /\.(html?|m?js|cjs|css)$/.test(x))) {
    const raw = texts.get(f) ?? readFileSync(join(root, f), "utf8");
    const text = /\.html?$/.test(f) ? raw.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length)) : /\.css$/.test(f) ? raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")) : stripComments(raw);
    for (const m of text.matchAll(ASSET_RE)) {
      const url = m[1]!;
      if (/^(?:[a-z]+:|\/\/)/i.test(url) || /(^|\/)\.[a-z0-9]+$/i.test(url) || url.includes("*") || url.includes("\\")) continue;
      const index = (m.index ?? 0) + 1;
      referenced++;
      const hit = lookup(f, url);
      const key = `${f}\0${url}`;
      if (hit.found || reported.has(key)) continue;
      reported.add(key);
      if (hit.caseOf) {
        issues.push({ kind: "asset-case", severity: "error", message: `references ${url} but the file is ${hit.caseOf}: works on macOS and Windows, 404 on Linux servers (GitHub Pages, Netlify, most hosts).`, at: at(f, raw, index), fix: `Use the exact name ${posix.basename(hit.caseOf)} in the code, or rename the file.` });
      } else {
        missing++;
        issues.push({
          kind: "asset-missing",
          severity: "error",
          message: `references ${url}, which is not in ${outDir}.`,
          at: at(f, raw, index),
          fix: "Put files loaded by URL in public/ (the build copies it as is), or import them so the bundler copies them: new URL('./model.glb', import.meta.url).href.",
        });
      }
    }
    if (baseDir === "/" && !/^\.\.?\//.test(base)) {
      const re = /\.html?$/.test(f) ? /\b(?:src|href)\s*=\s*["'](\/(?!\/)[^"']+)["']/g : /["'`](\/(?:assets|static|_next|models|textures)\/[^"'`\s]+)["'`]/g;
      for (const m of text.matchAll(re)) if (absolute.length < 50) absolute.push(`${at(f, raw, (m.index ?? 0) + m[0].indexOf(m[1]!))} ${m[1]}`);
    }
  }
  if (absolute.length) {
    issues.push({
      kind: "absolute-url",
      severity: "warn",
      message: `${absolute.length} URL(s) start at the site root, e.g. ${absolute.slice(0, 3).join("; ")}. That works at https://example.com/ but 404s when the site is served from a sub-path such as GitHub Pages (https://user.github.io/repo/).`,
      at: absolute[0]!.split(" ")[0]!,
      fix: "Set base: './' (or '/<repo>/') in vite.config, output.publicPath in webpack, basePath in next.config; load your own files with relative URLs.",
    });
  }

  // decoders set by path
  for (const [f, text] of texts) {
    for (const m of text.matchAll(/set(Decoder|Transcoder)Path\(\s*["'`]([^"'`]*)["'`]\s*\)/g)) {
      const dir = m[2]!;
      if (/^(?:[a-z]+:)?\/\//i.test(dir)) continue;
      const need = m[1] === "Decoder" ? ["draco_decoder.wasm", "draco_wasm_wrapper.js"] : ["basis_transcoder.wasm", "basis_transcoder.js"];
      const gone = need.filter((n) => !lookup(f, `${dir.replace(/\/?$/, "/")}${n}`).found && !lookup("index.html", `${dir.replace(/\/?$/, "/")}${n}`).found);
      if (gone.length) {
        const lib = m[1] === "Decoder" ? "draco" : "basis";
        issues.push({
          kind: "decoder-missing",
          severity: "error",
          message: `${m[1] === "Decoder" ? "DRACOLoader.setDecoderPath" : "KTX2Loader.setTranscoderPath"}('${dir}') but ${gone.join(" and ")} ${gone.length > 1 ? "are" : "is"} not in the output there: compressed models or textures will not load.`,
          at: at(f, text, m.index ?? 0),
          fix: `Copy node_modules/three/examples/jsm/libs/${lib}/ into public/${dir.replace(/^\.?\//, "")} (or point the path at a CDN such as https://www.gstatic.com/draco/versioned/decoders/1.5.7/).`,
        });
      }
    }
  }

  // glTF files: their buffers and images
  for (const f of files.filter((x) => x.endsWith(".gltf"))) {
    let json: { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
    try {
      json = JSON.parse(readFileSync(join(root, f), "utf8")) as typeof json;
    } catch {
      continue;
    }
    for (const uri of [...(json.buffers ?? []), ...(json.images ?? [])].map((x) => x.uri).filter((u): u is string => !!u && !u.startsWith("data:"))) {
      referenced++;
      const hit = lookup(f, uri);
      if (hit.found) continue;
      if (hit.caseOf) issues.push({ kind: "asset-case", severity: "error", message: `${f} references ${uri} but the file is ${hit.caseOf}: 404 on Linux servers.`, at: at(f), fix: "Match the name in the .gltf to the file." });
      else {
        missing++;
        issues.push({ kind: "asset-missing", severity: "error", message: `${f} references ${uri}, which is not next to it in the output.`, at: at(f), fix: "Copy the .bin and textures with the .gltf, or export one .glb." });
      }
    }
  }

  return {
    files: files.length,
    kb: round(bytes / 1024, 1),
    three: { copies, revisions, chunks, ...(threeBytes !== undefined ? { kb: round(threeBytes / 1024, 1) } : {}) },
    assets: { referenced, missing },
    issues,
  };
}

const findOutDir = (project: string, detected?: string): string | undefined => {
  for (const d of [detected, "dist", "build", "out"].filter((x): x is string => !!x)) {
    const p = resolve(project, d);
    if (existsSync(p) && statSync(p).isDirectory()) return d;
  }
  return undefined;
};

export async function buildCheck(opts: BuildCheckOptions): Promise<BuildResult> {
  const project = resolve(opts.project);
  const detected = detectBuild(project, opts.script ?? "build");
  const base = opts.base ?? detected.base ?? "/";
  const result: BuildResult = { ok: false, project, tool: detected.tool, ...(detected.script ? { script: detected.script } : {}), base, files: 0, kb: 0, three: { copies: [], revisions: [], chunks: [] }, assets: { referenced: 0, missing: 0 }, issues: [] };
  if (opts.run !== false) {
    if (!detected.script) {
      result.issues.push({ kind: "no-build-script", severity: "error", message: `package.json has no "${opts.script ?? "build"}" script.`, fix: 'Add one, e.g. "build": "vite build", or pass the script name.' });
      return result;
    }
    const pm = packageManager(project);
    result.command = `${pm} run ${detected.script}`;
    const run = await (opts.run ?? spawnRunner)(pm, ["run", detected.script], { cwd: project, timeoutMs: opts.timeoutMs ?? 300_000 });
    const tail = run.output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).filter((l) => l.trim()).slice(-30);
    result.build = { code: run.code, ms: run.ms, timedOut: run.timedOut, tail };
    if (run.timedOut || run.code !== 0) {
      result.issues.push({ kind: "build-failed", severity: "error", message: run.timedOut ? `${result.command} did not finish in ${Math.round((opts.timeoutMs ?? 300_000) / 1000)} s.` : `${result.command} exited with code ${run.code}.` });
      return result;
    }
  }
  const outDir = opts.outDir ?? findOutDir(project, detected.outDir);
  if (!outDir || !existsSync(resolve(project, outDir))) {
    result.issues.push({ kind: "no-output", severity: "error", message: `No output folder found (looked for ${[detected.outDir, "dist", "build", "out"].filter(Boolean).join(", ")}).`, fix: "Pass outDir." });
    return result;
  }
  result.outDir = posixPath(outDir);
  Object.assign(result, analyzeOutput(project, outDir, base));
  const outAbs = resolve(project, outDir);
  if (opts.check !== false) {
    if (!existsSync(join(outAbs, "index.html"))) {
      result.issues.push({ kind: "no-output", severity: "warn", message: `${result.outDir}/index.html is missing: the built page was not opened.` });
    } else {
      // A build for a sub-path (base "/repo/") only works under that path: serve it there.
      const sub = base.startsWith("/") ? base.split("/").filter(Boolean) : [];
      let tmp: string | undefined;
      let target = outAbs;
      let root: string | undefined;
      if (sub.length) {
        tmp = mkdtempSync(join(tmpdir(), "threesmith-site-"));
        const link = join(tmp, ...sub);
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(outAbs, link, "dir");
        target = link;
        root = tmp;
      }
      try {
        const c = await (opts.checkPage ?? realCheck)({ wait: 1500, stateDir: join(project, ".threesmith"), ...(opts.check ?? {}), target, ...(root ? { root } : {}) });
        result.check = c;
        for (const i of c.issues) result.issues.push({ kind: i.kind, severity: i.severity, message: `built page: ${i.message}` });
      } finally {
        if (tmp) rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
  result.ok = !result.issues.some((i) => i.severity === "error");
  return result;
}

export function formatBuild(r: BuildResult): string {
  const out = [`Threesmith build: ${r.ok ? "PASS" : "FAIL"} – ${r.project} (${r.tool}${r.command ? `, ${r.command}` : ""})`];
  if (r.build) out.push(`build: exit ${r.build.code}${r.build.timedOut ? " (timed out)" : ""} in ${round(r.build.ms / 1000, 1)} s`);
  if (r.build && (r.build.code !== 0 || r.build.timedOut)) out.push(...r.build.tail.map((l) => `  | ${l}`));
  if (r.outDir) {
    const t = r.three;
    const three = t.copies.length
      ? `three ${t.revisions.map((x) => "r" + x).join(", ")} x${t.copies.length}${t.kb !== undefined ? `, ${t.kb} KB of three (source map)` : ""}; chunks: ${t.chunks.map((c) => `${c.file} ${c.kb} KB (gzip ${c.gzipKb} KB)`).join(", ")}`
      : "no three copy found in the scripts";
    out.push(`output ${r.outDir}: ${r.files} files, ${r.kb} KB, base "${r.base}" · ${three}`);
    out.push(`assets: ${r.assets.referenced} referenced, ${r.assets.missing} missing`);
  }
  for (const i of r.issues) {
    out.push(`${i.severity === "error" ? "✖" : "▲"} [${i.kind}]${i.at ? ` ${i.at}` : ""} ${i.message}`);
    if (i.fix) out.push(`    fix: ${i.fix}`);
  }
  if (r.check) out.push("", formatCheck(r.check).split("\n").slice(0, 2).join("\n"), r.check.screenshot ? `screenshot: ${r.check.screenshot}` : "");
  return out.filter((l, i, a) => !(l === "" && i === a.length - 1)).join("\n");
}
