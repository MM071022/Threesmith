import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findThree } from "../api/install.js";
import { collect, lineOf, type SourceFile } from "../review/source.js";
import { checkAssets, type AssetReport } from "./assets.js";

/**
 * A map of a three.js project from its files, in one call: the stack (bundler, framework, TypeScript, versions of
 * three and the libraries around it), the pages and how they load three, every file that uses three with what it
 * makes (renderer, cameras, lights, controls, loaders, the animation loop) and the renderer's settings, and the assets
 * it loads. It is what an agent needs before its first edit in a project it does not know.
 */

export interface FileMap {
  file: string;
  lines: number;
  /** three, three/webgpu, three/tsl, three/addons/... */
  imports: string[];
  /** Notable things the file creates, with counts: WebGLRenderer, PerspectiveCamera, OrbitControls, GLTFLoader, ... */
  creates: Record<string, number>;
  /** Line of the animation loop (setAnimationLoop, requestAnimationFrame, useFrame). */
  loop?: number;
  /** Assets referenced (count). */
  assets: number;
  /** React Three Fiber component file. */
  r3f: boolean;
}

export interface PageMap {
  file: string;
  /** Module scripts the page starts. */
  scripts: string[];
  /** three version from an import map or CDN URL, if any. */
  cdn?: string;
  importMap: boolean;
}

export interface ProjectMap {
  root: string;
  name?: string;
  three: { installed?: string; release?: number; declared?: string; types?: string; typesDeclared?: string; webgpu: boolean };
  stack: { bundler: string; framework: string[]; typescript: boolean; scripts: Record<string, string>; libraries: Record<string, string> };
  pages: PageMap[];
  files: FileMap[];
  /** Renderer settings found in the code (first assignment wins). */
  renderer: Record<string, string>;
  assets: AssetReport;
  /** Short notes an agent should know before editing. */
  notes: string[];
}

const LIBS = [
  "@react-three/fiber",
  "@react-three/drei",
  "@react-three/postprocessing",
  "@react-three/rapier",
  "@react-three/xr",
  "@dimforge/rapier3d-compat",
  "@dimforge/rapier3d",
  "cannon-es",
  "postprocessing",
  "three-stdlib",
  "three-mesh-bvh",
  "@pmndrs/uikit",
  "lil-gui",
  "dat.gui",
  "stats.js",
  "gsap",
  "camera-controls",
  "troika-three-text",
  "@theatre/core",
  "leva",
  "zustand",
];

const CREATES = [
  "WebGLRenderer",
  "WebGPURenderer",
  "Scene",
  "PerspectiveCamera",
  "OrthographicCamera",
  "AmbientLight",
  "HemisphereLight",
  "DirectionalLight",
  "PointLight",
  "SpotLight",
  "RectAreaLight",
  "OrbitControls",
  "MapControls",
  "TrackballControls",
  "PointerLockControls",
  "FirstPersonControls",
  "TransformControls",
  "GLTFLoader",
  "DRACOLoader",
  "KTX2Loader",
  "TextureLoader",
  "HDRLoader",
  "RGBELoader",
  "EXRLoader",
  "FBXLoader",
  "OBJLoader",
  "FontLoader",
  "AudioLoader",
  "EffectComposer",
  "InstancedMesh",
  "BatchedMesh",
  "ShaderMaterial",
  "RawShaderMaterial",
  "NodeMaterial",
  "AnimationMixer",
  "Raycaster",
  "PMREMGenerator",
  "CSS2DRenderer",
  "CSS3DRenderer",
  "VRButton",
  "ARButton",
];

const RENDERER_SETTINGS = ["toneMapping", "toneMappingExposure", "outputColorSpace", "shadowMap.enabled", "shadowMap.type", "setPixelRatio", "setSize", "antialias", "localClippingEnabled", "xr.enabled"];

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The project folder: the nearest folder at or above `path` with a package.json, else `path`. */
export function projectRootOf(path: string): string {
  let start = resolve(path);
  try {
    if (!statSync(start).isDirectory()) start = dirname(start);
  } catch {
    /* as given */
  }
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(join(d, "package.json"))) return d;
    if (dirname(d) === d) return start;
  }
}

function mapFile(f: SourceFile): FileMap {
  const imports = new Set<string>();
  for (const m of f.text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? "";
    if (/^three(\/|$)|^@react-three\//.test(spec)) imports.add(spec);
  }
  const creates: Record<string, number> = {};
  for (const name of CREATES) {
    const n = [...f.text.matchAll(new RegExp(String.raw`new\s+(?:[A-Za-z_$][\w$]*\.)?${name}\s*\(`, "g"))].length;
    if (n) creates[name] = n;
  }
  const r3f = /from\s+['"]@react-three\/fiber['"]/.test(f.text);
  if (r3f) {
    if (/<Canvas\b/.test(f.text)) creates["<Canvas>"] = (f.text.match(/<Canvas\b/g) ?? []).length;
    const gltf = (f.text.match(/\buseGLTF\s*\(/g) ?? []).length;
    if (gltf) creates["useGLTF"] = gltf;
  }
  const loop = /setAnimationLoop\s*\(|requestAnimationFrame\s*\(|useFrame\s*\(/.exec(f.text);
  const assets = (f.text.match(/['"`][^'"`\n]+\.(?:glb|gltf|fbx|obj|hdr|exr|ktx2|png|jpe?g|webp|mp3|ogg|wav)(?:\?[^'"`\n]*)?['"`]/gi) ?? []).length;
  return { file: f.path, lines: f.raw.split("\n").length, imports: [...imports].sort(), creates, ...(loop ? { loop: lineOf(f.text, loop.index) } : {}), assets, r3f };
}

function mapPage(f: SourceFile): PageMap {
  const scripts = [...f.raw.matchAll(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/g)].map((m) => m[1] ?? "");
  if (/<script[^>]*type=["']module["'][^>]*>(?!\s*<\/script>)/.test(f.raw) && !scripts.length) scripts.push("(inline module)");
  const cdn = /(?:unpkg\.com|jsdelivr\.net\/npm|cdnjs\.cloudflare\.com\/ajax\/libs|esm\.sh|skypack\.dev)\/three(?:@|\/)(?:r)?([\d.]+)/.exec(f.raw)?.[1];
  return { file: f.path, scripts, ...(cdn ? { cdn } : {}), importMap: /type=["']importmap["']/.test(f.raw) };
}

export function scanProject(path: string): ProjectMap {
  const root = projectRootOf(path);
  const pkg = readJson(join(root, "package.json")) ?? {};
  const deps = { ...((pkg["dependencies"] as Record<string, string>) ?? {}), ...((pkg["devDependencies"] as Record<string, string>) ?? {}) };
  const install = findThree(root);
  const typesPkg = readJson(join(root, "node_modules", "@types", "three", "package.json"));
  const collected = collect(root);
  const threeFiles = collected.files.filter((f) => f.usesThree || /from\s+['"]@react-three\//.test(f.text));
  const files = threeFiles.filter((f) => !/\.html?$/.test(f.path)).map(mapFile);
  const pages = collected.files.filter((f) => /\.html?$/.test(f.path)).map(mapPage);
  // inline module scripts in pages that use three count as three files too
  for (const f of threeFiles.filter((x) => /\.html?$/.test(x.path))) files.push(mapFile(f));

  const has = (name: string) => name in deps || existsSync(join(root, name));
  const bundler = has("vite") || ["vite.config.js", "vite.config.ts", "vite.config.mjs"].some((c) => existsSync(join(root, c)))
    ? "vite"
    : has("next")
      ? "next"
      : has("webpack")
        ? "webpack"
        : has("parcel")
          ? "parcel"
          : has("esbuild")
            ? "esbuild"
            : has("rollup")
              ? "rollup"
              : pages.some((p) => p.importMap || p.cdn)
                ? "none (import map / CDN)"
                : "none";
  const framework = ["react", "vue", "svelte", "solid-js", "@angular/core", "next", "nuxt", "astro", "@sveltejs/kit"].filter((d) => d in deps);
  const libraries: Record<string, string> = {};
  for (const l of LIBS) if (deps[l]) libraries[l] = deps[l] as string;
  const scripts = Object.fromEntries(Object.entries((pkg["scripts"] as Record<string, string>) ?? {}).filter(([k]) => /^(dev|start|build|preview|test|serve|lint)$/.test(k)));

  const renderer: Record<string, string> = {};
  const all = threeFiles.map((f) => f.text).join("\n");
  for (const s of RENDERER_SETTINGS) {
    const re = s.startsWith("set")
      ? new RegExp(String.raw`\.${s}\s*\(([^)\n]{0,80})\)`)
      : s === "antialias"
        ? /antialias\s*:\s*(true|false)/
        : new RegExp(String.raw`\.${s.replace(".", String.raw`\.`)}\s*=\s*([^;\n]{1,80})`);
    const m = re.exec(all);
    if (m) renderer[s] = (m[1] ?? "").trim();
  }

  const assets = checkAssets(root, collected.files);
  const notes: string[] = [];
  const declared = deps["three"];
  const webgpu = /from\s+['"]three\/webgpu['"]|WebGPURenderer/.test(all);
  if (!install && declared) notes.push("three is in package.json but not installed: run npm install (api and review are exact only with node_modules/three).");
  if (!install && !declared && pages.some((p) => p.cdn)) notes.push(`three comes from a CDN (${pages.find((p) => p.cdn)?.cdn}); pin that version and keep addons on the same version.`);
  if (typesPkg && install) {
    const tr = Number(/^0\.(\d+)/.exec(String(typesPkg["version"] ?? ""))?.[1]);
    if (tr && tr !== install.release) notes.push(`@types/three is r${tr} but three is r${install.release}: types and runtime disagree.`);
  }
  if (webgpu && /from\s+['"]three['"]/.test(all)) notes.push("Both 'three' and 'three/webgpu' are imported: with WebGPURenderer import everything from 'three/webgpu' (and TSL from 'three/tsl'), or two copies of three get loaded.");
  if (libraries["@react-three/fiber"]) notes.push("React Three Fiber project: the scene lives in JSX under <Canvas>; per-frame code goes in useFrame (no setState there, no new objects per frame).");
  if (!files.some((f) => f.loop !== undefined) && files.length && !libraries["@react-three/fiber"]) notes.push("No animation loop found (setAnimationLoop / requestAnimationFrame): the scene renders once at most.");
  const errors = assets.problems.filter((p) => p.severity === "error").length;
  if (errors) notes.push(`${errors} asset problem(s): see assets below (three_assets for all).`);

  return {
    root,
    ...(typeof pkg["name"] === "string" ? { name: pkg["name"] } : {}),
    three: {
      ...(install ? { installed: install.version, release: install.release } : {}),
      ...(declared ? { declared } : {}),
      ...(typesPkg ? { types: String(typesPkg["version"]) } : {}),
      ...(deps["@types/three"] ? { typesDeclared: deps["@types/three"] } : {}),
      webgpu,
    },
    stack: { bundler, framework, typescript: existsSync(join(root, "tsconfig.json")) || files.some((f) => /\.tsx?$/.test(f.file)), scripts, libraries },
    pages,
    files,
    renderer,
    assets,
    notes,
  };
}

export function formatProjectMap(m: ProjectMap, detail: "brief" | "full" = "brief"): string {
  const out: string[] = [];
  const t = m.three;
  out.push(`${m.name ?? "project"} at ${m.root}`);
  out.push(
    `three: ${t.installed ? `r${t.release} (${t.installed}) installed` : "not installed"}${t.declared ? `, package.json ${t.declared}` : ""}${t.types ? `, @types/three ${t.types}` : ""}${t.webgpu ? ", WebGPU" : ""}`,
  );
  const s = m.stack;
  out.push(`stack: ${s.bundler}${s.framework.length ? ` + ${s.framework.join(", ")}` : ""}${s.typescript ? ", TypeScript" : ", JavaScript"}${Object.keys(s.libraries).length ? `; ${Object.entries(s.libraries).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`);
  if (Object.keys(s.scripts).length) out.push(`scripts: ${Object.entries(s.scripts).map(([k, v]) => `${k}="${v}"`).join("  ")}`);
  for (const p of m.pages.slice(0, detail === "full" ? 50 : 5)) out.push(`page ${p.file}: ${p.scripts.join(", ") || "no module script"}${p.importMap ? ", import map" : ""}${p.cdn ? `, three ${p.cdn} from CDN` : ""}`);
  if (Object.keys(m.renderer).length) out.push(`renderer: ${Object.entries(m.renderer).map(([k, v]) => `${k}=${v}`).join("; ")}`);
  out.push(`files using three (${m.files.length}):`);
  const shown = detail === "full" ? m.files : m.files.slice(0, 25);
  for (const f of shown) {
    const made = Object.entries(f.creates).map(([k, n]) => (n > 1 ? `${k}x${n}` : k)).join(" ");
    const imp = detail === "full" ? `  imports: ${f.imports.join(", ")}` : "";
    out.push(`  ${f.file} (${f.lines} lines)${made ? `: ${made}` : ""}${f.loop ? `; loop at ${f.loop}` : ""}${f.assets ? `; ${f.assets} asset ref(s)` : ""}${imp}`);
  }
  if (m.files.length > shown.length) out.push(`  +${m.files.length - shown.length} more (detail full)`);
  const a = m.assets;
  const missing = a.problems.filter((p) => p.severity === "error");
  out.push(`assets: ${a.refs.length} referenced, ${a.files.length} on disk${a.publicDir ? `, ${a.publicDir}/ served at /` : ""}${missing.length ? `, ${missing.length} problem(s)` : ""}`);
  for (const p of (detail === "full" ? a.problems : missing).slice(0, detail === "full" ? 40 : 6)) out.push(`  ${p.severity} ${p.file ?? ""}${p.line ? `:${p.line}` : ""} [asset-${p.kind}] ${p.message}`);
  if (detail === "full") for (const f of a.files.filter((x) => x.extensions?.length)) out.push(`  ${f.file}: glTF extensions ${f.extensions!.join(", ")}`);
  for (const n of m.notes) out.push(`note: ${n}`);
  return out.join("\n");
}
