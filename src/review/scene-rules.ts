import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { assignedName, buildExports, callArgs, closeOf, esc, legacy, loopBodies, splitTop, usesOf } from "./parse.js";
import type { SourceFile } from "./source.js";
import type { Ctx, Report, Rule } from "./types.js";

/**
 * Rules for loaders, modules, controls, animation, buffers, cameras, shadows, post-processing, React Three Fiber and
 * the deprecations of recent releases. Each comes from a mistake that renders nothing, the wrong thing or slowly, and
 * each version claim was checked against the three source of that release or the migration guide.
 */

const newRe = (cls: string): RegExp => new RegExp(String.raw`new\s+(?:[\w$]+\.)?(?:${cls})\s*\(`, "g");

/** First `new Cls(` in the project, with the variable it is assigned to. */
function created(ctx: Ctx, cls: string): { f: SourceFile; at: number; name?: string }[] {
  const out: { f: SourceFile; at: number; name?: string }[] = [];
  for (const f of ctx.three) {
    for (const m of f.text.matchAll(newRe(cls))) {
      const name = assignedName(f.text, m.index ?? 0);
      out.push({ f, at: m.index ?? 0, ...(name ? { name } : {}) });
    }
  }
  return out;
}

/** WebGPURenderer re-uploads DynamicDrawUsage buffers every frame without needsUpdate (renderers/common/Attributes.js). */
function webgpuDynamic(ctx: Ctx): boolean {
  return /\bWebGPURenderer\b/.test(ctx.all) && !/\bWebGLRenderer\b/.test(ctx.all) && /\bDynamicDrawUsage\b/.test(ctx.all);
}

/** Uses of `name` or `this.name` as a whole identifier. */
function refs(text: string, name: string): { at: number; after: string }[] {
  return [...text.matchAll(new RegExp(String.raw`(?<![\w$.])(?:this\.)?${esc(name)}(?![\w$])`, "g"))].map((m) => ({
    at: m.index ?? 0,
    after: text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40),
  }));
}

const CONTROLS = "OrbitControls|MapControls|TrackballControls|ArcballControls|FlyControls|FirstPersonControls|TransformControls|PointerLockControls";
const BUNDLERS = /^(?:vite|webpack|parcel|rollup|esbuild|snowpack|wmr|astro|next|nuxt|@sveltejs\/kit|@vitejs\/[\w-]+|@web\/dev-server|react-scripts|@angular\/cli|gatsby|vue-cli-service|@vue\/cli-service|turbopack|rspack|@rspack\/cli|bun)$/;

/** Deprecations of recent releases, from the `@deprecated` warnings in the installed source. */
const DEPRECATED: { re: RegExp; since: number; what: (m: RegExpExecArray) => string; use: (m: RegExpExecArray) => string }[] = [
  {
    re: /\.(render|compute|clear|clearColor|clearDepth|clearStencil|hasFeature|initTexture)Async\s*\(/,
    since: 181,
    what: (m) => `\`${m[1]}Async()\``,
    use: (m) => `await renderer.init() once, then call ${m[1]}() (setAnimationLoop waits for init by itself).`,
  },
  { re: /\.detectSupportAsync\s*\(/, since: 181, what: () => "`KTX2Loader.detectSupportAsync()`", use: () => "await renderer.init(), then ktx2Loader.detectSupport(renderer)." },
  { re: /\.(fromScene|fromEquirectangular|fromCubemap)Async\s*\(/, since: 181, what: (m) => `\`PMREMGenerator.${m[1]}Async()\``, use: (m) => `await renderer.init(), then ${m[1]}().` },
  { re: /\.getColorBufferType\s*\(/, since: 182, what: () => "`getColorBufferType()`", use: () => "getOutputBufferType()." },
  { re: /\.setDecoderConfig\s*\(/, since: 185, what: () => "`DRACOLoader.setDecoderConfig()` (removed in r194)", use: () => "Drop it: DRACOLoader will always use the WASM decoder." },
  { re: /\bSVGLoader\.createShapes\s*\(/, since: 185, what: () => "`SVGLoader.createShapes()`", use: () => "shapePath.toShapes() for each path of the SVG data." },
  { re: /\blineColorNode\b/, since: 185, what: () => "`Line2NodeMaterial.lineColorNode`", use: () => "colorNode." },
  { re: /\biridescenceThicknessRange\b/, since: 187, what: () => "`iridescenceThicknessRange`", use: () => "iridescenceThicknessMinimum and iridescenceThicknessMaximum." },
  { re: /\.library\.addLight\s*\(/, since: 187, what: () => "`renderer.library.addLight()`", use: () => "CustomLight.registerNode( CustomLightNode )." },
];

const TSL_RENAMED: Record<string, { to: string; since: number }> = {
  directionToColor: { to: "packNormalToRGB", since: 185 },
  colorToDirection: { to: "unpackRGBToNormal", since: 185 },
  directionToFaceDirection: { to: "negateOnBackSide", since: 185 },
  PI2: { to: "TWO_PI", since: 181 },
};

/** Names a file imports from 'three/tsl' (local -> imported). */
export function tslImports(f: SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of f.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]three\/tsl['"]/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const [imported, local] = part.trim().split(/\s+as\s+/);
      if (imported) out.set((local ?? imported).trim(), imported.trim());
    }
  }
  return out;
}

/** Function components (capitalized, returning JSX): their body ranges. */
function componentBodies(f: SourceFile): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const res = [
    /function\s+[A-Z][\w$]*\s*\([^)]*\)\s*(?::[^{]+)?\{/g,
    /(?:const|let)\s+[A-Z][\w$]*\s*(?::[^=]+)?=\s*(?:(?:React\.)?(?:memo|forwardRef)\s*\(\s*)?(?:function\s*[\w$]*\s*\([^)]*\)|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)\s*\{/g,
  ];
  for (const re of res) {
    for (const m of f.text.matchAll(re)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = closeOf(f.text, open);
      if (close < 0) continue;
      if (/\breturn\s*\(?\s*<[\w>]/.test(f.text.slice(open, close))) out.push({ start: open, end: close });
    }
  }
  return out;
}

/** Blank everything in a component body that does not run on every render: hook arguments and nested functions. */
function renderOnly(body: string): string {
  const mask = body.split("");
  const blank = (a: number, b: number) => {
    for (let i = a; i < b && i < mask.length; i++) if (mask[i] !== "\n") mask[i] = " ";
  };
  for (const m of body.matchAll(/\buse[A-Z][\w$]*\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = closeOf(body, open);
    if (close > 0) blank(open, close);
  }
  for (const m of body.matchAll(/=>\s*|\bfunction\b[^{(]*\([^)]*\)\s*/g)) {
    const i = (m.index ?? 0) + m[0].length;
    if (body[i] === "{") {
      const close = closeOf(body, i);
      if (close > 0) blank(i, close);
    } else if (m[0].startsWith("=>")) {
      // expression body: up to the next , ) } ; at this depth
      let depth = 0;
      let j = i;
      for (; j < body.length; j++) {
        const c = body[j];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
          if (depth === 0) break;
          depth--;
        } else if ((c === "," || c === ";") && depth === 0) break;
      }
      blank(i, j);
    }
  }
  return mask.join("");
}

function deprecationRule(ctx: Ctx, report: Report): void {
  for (const f of ctx.three) {
    for (const d of DEPRECATED) {
      if (ctx.release < d.since) continue;
      for (const m of f.text.matchAll(new RegExp(d.re.source, "g"))) {
        const mm = m as RegExpExecArray;
        report(f, m.index ?? 0, { message: `${d.what(mm)} is deprecated since r${d.since}.`, fix: `Use ${d.use(mm)}` });
      }
    }
    // THREE.Source / an imported Source only, not any class called Source
    if (ctx.release >= 186) {
      const nsNames = [...f.namespaces].map(esc).join("|") || "THREE";
      const re = f.named.get("Source") === "Source" ? /new\s+Source\s*\(/g : new RegExp(String.raw`new\s+(?:${nsNames})\.Source\s*\(`, "g");
      for (const m of f.text.matchAll(re)) report(f, m.index ?? 0, { message: "`Source` was renamed `TextureSource` in r186.", fix: "Use new THREE.TextureSource( data )." });
    }
  }
}

export const SCENE_RULES: Rule[] = [
  // ---- modules and imports ----
  {
    id: "tsl-import-path",
    category: "correctness",
    severity: "error",
    title: "TSL imported from the wrong module",
    message: "This name is not exported by the module it is imported from.",
    fix: "Import TSL functions from 'three/tsl' and WebGPU classes from 'three/webgpu'.",
    check(ctx, report) {
      const b = ctx.install && buildExports(ctx.install.root);
      if (!b || !ctx.install) return;
      for (const f of ctx.three) {
        for (const m of f.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](three|three\/webgpu|three\/tsl)['"]/g)) {
          const mod = m[2] as "three" | "three/webgpu" | "three/tsl";
          const own = mod === "three" ? b.three : mod === "three/webgpu" ? b.webgpu : b.tsl;
          const listStart = (m.index ?? 0) + m[0].indexOf("{");
          for (const part of splitTop(m[1] ?? "")) {
            const name = part.text.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "";
            if (!name || own.has(name) || /^type\s/.test(part.text.trim())) continue;
            let where: string | undefined;
            if (mod !== "three/tsl") {
              if (!b.tsl.has(name)) continue; // unknown-symbol explains the rest
              where = "three/tsl";
            } else where = b.webgpu.has(name) ? "three/webgpu" : b.three.has(name) ? "three" : undefined;
            report(f, listStart + 1 + part.at + part.text.search(/\S/), {
              message: `\`${name}\` is not exported by '${mod}' in three r${ctx.install.release}${where ? `; it lives in '${where}'` : ""}, so the import fails ("does not provide an export named").`,
              fix: where ? `import { ${name} } from '${where}';` : "Look the name up with `threesmith api`.",
            });
          }
        }
      }
    },
  },
  {
    id: "three-src-import",
    category: "correctness",
    severity: "error",
    title: "Importing from three/src next to three",
    message: "'three/src/...' is a second copy of three next to 'three' (build/three.module.js), so instanceof / isX checks between the two fail and three warns about multiple instances.",
    fix: "Import everything from 'three' (or 'three/webgpu', 'three/tsl', 'three/addons/...').",
    check(ctx, report) {
      if (!/from\s+['"]three(?:\/webgpu|\/tsl|\/addons\/[^'"]*|\/examples\/jsm\/[^'"]*)?['"]/.test(ctx.all)) return;
      for (const f of ctx.three) for (const m of f.text.matchAll(/from\s+['"]three\/src\//g)) report(f, m.index ?? 0);
    },
  },
  {
    id: "importmap-missing",
    category: "correctness",
    severity: "error",
    title: "Bare 'three' import in a page without an import map",
    message: "The page imports 'three' by its bare name but has no import map and the project has no bundler, so the browser fails with \"Failed to resolve module specifier\".",
    fix: 'Add <script type="importmap">{ "imports": { "three": "<url>/build/three.module.js", "three/addons/": "<url>/examples/jsm/" } }</script> before the module script, or use a bundler such as Vite.',
    check(ctx, report) {
      const deps = { ...ctx.packageJson?.dependencies, ...ctx.packageJson?.devDependencies };
      if (Object.keys(deps).some((d) => BUNDLERS.test(d))) return;
      if (ctx.files.some((f) => /(?:^|\/)(?:vite|webpack|rollup|esbuild|parcel|astro|next|nuxt|svelte)\.config\.\w+$/.test(f.path))) return;
      const bare = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]three(?:\/[^'"]*)?['"]/;
      for (const f of ctx.files) {
        if (!/\.html?$/.test(f.path) || /type\s*=\s*["']importmap["']/.test(f.raw)) continue;
        for (const m of f.raw.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)) {
          const attrs = m[1] ?? "";
          if (!/type\s*=\s*["']module["']/.test(attrs)) continue;
          let hit = bare.test(m[2] ?? "");
          const src = /\bsrc\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1];
          if (!hit && src && !/^(?:https?:)?\/\//.test(src)) {
            const want = join(dirname(f.path), src.replace(/^\//, "")).split("\\").join("/");
            const target = ctx.files.find((x) => x.path === want);
            hit = !!target && bare.test(target.text);
          }
          if (hit) report(f, m.index ?? 0);
        }
      }
    },
  },
  {
    id: "addon-path-extension",
    category: "correctness",
    severity: "warn",
    title: "Addon import without .js",
    message: "The addon path has no `.js`; browsers with an import map and Node ESM do not add extensions, so the import fails there (some bundlers hide it).",
    fix: "Write the full file name, e.g. 'three/addons/controls/OrbitControls.js'.",
    check(ctx, report) {
      if (!ctx.install) return;
      const root = ctx.install.root;
      for (const f of ctx.three) {
        for (const m of f.text.matchAll(/(?:from\s*|import\s*\(\s*)['"]three\/(?:addons|examples\/jsm)\/([^'"]+)['"]/g)) {
          const rel = m[1] ?? "";
          if (!/\.\w+$/.test(rel) && existsSync(join(root, "examples", "jsm", rel + ".js"))) report(f, m.index ?? 0, { fix: `Use '${m[0].includes("examples/jsm") ? "three/examples/jsm" : "three/addons"}/${rel}.js'.` });
        }
      }
    },
  },
  {
    id: "rgbe-loader-deprecated",
    category: "api",
    severity: "info",
    title: "RGBELoader is now HDRLoader",
    message: "`RGBELoader` was renamed `HDRLoader` in r180; the old name is a deprecated subclass that only warns.",
    fix: "import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'; and use new HDRLoader() (same API).",
    deprecatedIn: 180,
    introducedIn: 180,
    check(ctx, report) {
      for (const f of ctx.three) {
        const m = /\bimport\b[^;]*\bRGBELoader\b|new\s+(?:[\w$]+\.)?RGBELoader\b/.exec(f.text);
        if (m) report(f, m.index);
      }
    },
  },
  {
    id: "deprecated-loader",
    category: "api",
    severity: "warn",
    title: "Loader that three is phasing out",
    message: "This loader is deprecated.",
    fix: "Convert the files to glTF.",
    introducedIn: 179,
    check(ctx, report) {
      const table: Record<string, { since: number; message: string; fix: string }> = {
        USDZLoader: { since: 179, message: "`USDZLoader` is deprecated since r179.", fix: "Use USDLoader from 'three/addons/loaders/USDLoader.js'." },
        VTKLoader: { since: 184, message: "`VTKLoader` is deprecated since r184 and will be removed in r194.", fix: "Export the VTK files to glTF and load them with GLTFLoader." },
        LWOLoader: { since: 185, message: "`LWOLoader` is deprecated since r185 and will be removed in r195.", fix: "Export the LWO files to glTF and load them with GLTFLoader." },
      };
      for (const f of ctx.three) {
        for (const m of f.text.matchAll(/from\s+['"]three\/(?:addons|examples\/jsm)\/loaders\/(USDZLoader|VTKLoader|LWOLoader)\.js['"]/g)) {
          const t = table[m[1] ?? ""];
          if (t && ctx.release >= t.since) report(f, m.index ?? 0, { message: t.message, fix: t.fix });
        }
      }
    },
  },

  // ---- loaders ----
  {
    id: "ktx2-no-detect-support",
    category: "correctness",
    severity: "error",
    title: "KTX2Loader without detectSupport(renderer)",
    message: "KTX2Loader throws \"Missing initialization with `.detectSupport( renderer )`\" on the first .ktx2 texture.",
    fix: "ktx2Loader.detectSupport( renderer ) once the renderer exists (after await renderer.init() for WebGPURenderer).",
    check(ctx, report) {
      if (/\.detectSupport(?:Async)?\s*\(/.test(ctx.all)) return;
      const c = created(ctx, "KTX2Loader")[0];
      if (c) report(c.f, c.at);
    },
  },
  {
    id: "decoder-not-attached",
    category: "correctness",
    severity: "error",
    title: "Draco / KTX2 / Meshopt decoder never handed to GLTFLoader",
    message: "The decoder is created but never given to the GLTFLoader, so compressed models fail.",
    fix: "gltfLoader.setDRACOLoader( dracoLoader ) / setKTX2Loader( ktx2Loader ) / setMeshoptDecoder( MeshoptDecoder ).",
    check(ctx, report) {
      if (!/\bGLTFLoader\b/.test(ctx.all)) return;
      const cases: [string, RegExp, string, string][] = [
        ["DRACOLoader", /setDRACOLoader\s*\(/, "No DRACOLoader instance provided", "gltfLoader.setDRACOLoader( dracoLoader );"],
        ["KTX2Loader", /setKTX2Loader\s*\(/, "setKTX2Loader must be called before loading KTX2 textures", "gltfLoader.setKTX2Loader( ktx2Loader );"],
      ];
      for (const [cls, attached, error, fix] of cases) {
        if (attached.test(ctx.all)) continue;
        for (const c of created(ctx, cls)) {
          // used on its own (dracoLoader.load / ktx2Loader.load) is fine
          if (!c.name || refs(ctx.all, c.name).some((r) => /^\s*\.\s*(?:load|loadAsync|parse|decodeDracoFile|decodeGeometry)\s*\(/.test(r.after))) continue;
          report(c.f, c.at, { message: `The ${cls} is never passed to the GLTFLoader, so a compressed model throws "${error}".`, fix });
        }
      }
      if (/setMeshoptDecoder\s*\(/.test(ctx.all)) return;
      for (const f of ctx.three) {
        const m = /import\s*\{[^}]*\bMeshoptDecoder\b[^}]*\}\s*from/.exec(f.text);
        if (m) report(f, m.index, { message: "MeshoptDecoder is imported but never set, so meshopt models throw \"setMeshoptDecoder must be called before loading compressed files\".", fix: "gltfLoader.setMeshoptDecoder( MeshoptDecoder );" });
      }
    },
  },
  {
    id: "file-loader-no-return",
    category: "api",
    severity: "error",
    title: "FileLoader.load() returns nothing",
    message: "Since r184 FileLoader.load() and ImageBitmapLoader.load() return undefined; the result only arrives in onLoad.",
    fix: "Use the onLoad callback, or const data = await loader.loadAsync( url ).",
    introducedIn: 184,
    removedIn: 184,
    check(ctx, report) {
      for (const f of ctx.three) {
        for (const m of f.text.matchAll(/=\s*new\s+(?:[\w$]+\.)?(?:FileLoader|ImageBitmapLoader)\s*\([^)]*\)\s*\.\s*load\s*\(/g)) report(f, m.index ?? 0);
        // a name that only ever holds a FileLoader in this file
        const names = created({ ...ctx, three: [f] }, "FileLoader|ImageBitmapLoader").flatMap((c) => (c.name ? [c.name] : []));
        for (const n of new Set(names)) {
          if (new RegExp(String.raw`\b${esc(n)}\s*=\s*(?!new\s+(?:[\w$]+\.)?(?:FileLoader|ImageBitmapLoader)\b)\S`).test(f.text)) continue;
          for (const m of f.text.matchAll(new RegExp(String.raw`=\s*(?:this\.)?${esc(n)}\s*\.\s*load\s*\(`, "g"))) report(f, m.index ?? 0);
        }
      }
    },
  },

  // ---- controls ----
  {
    id: "transform-controls-add",
    category: "correctness",
    severity: "error",
    title: "TransformControls added to the scene",
    message: "Since r169 TransformControls is not an Object3D: scene.add(controls) logs \"object not an instance of THREE.Object3D\" and no gizmo shows.",
    fix: "scene.add( controls.getHelper() );",
    introducedIn: 169,
    check(ctx, report) {
      for (const c of created(ctx, "TransformControls")) {
        if (!c.name) continue;
        const f = c.f;
        for (const m of f.text.matchAll(new RegExp(String.raw`\.add\s*\((?:[^()]*,)?\s*(?:this\.)?${esc(c.name)}\s*[,)]`, "g"))) report(f, m.index ?? 0, { fix: `scene.add( ${c.name}.getHelper() );` });
      }
    },
  },
  {
    id: "controls-document",
    category: "correctness",
    severity: "error",
    title: "Controls given `document` as their element",
    message: "Controls need an element: with `document` they set document.style.touchAction and throw \"Cannot set properties of undefined (setting 'touchAction')\".",
    fix: "Pass the canvas: new OrbitControls( camera, renderer.domElement ).",
    check(ctx, report) {
      for (const f of ctx.three) for (const m of f.text.matchAll(new RegExp(String.raw`new\s+(?:[\w$]+\.)?(?:${CONTROLS})\s*\(\s*[\w$.]+\s*,\s*document\s*\)`, "g"))) report(f, m.index ?? 0);
    },
  },
  {
    id: "controls-no-element",
    category: "correctness",
    severity: "warn",
    title: "Controls without a DOM element",
    message: "Controls created without a DOM element listen to nothing (since r175 they need one), so mouse and touch do nothing.",
    fix: "new OrbitControls( camera, renderer.domElement ), or call controls.connect( element ) later.",
    check(ctx, report) {
      if (/\.connect\s*\(\s*[\w$.]+\s*\)/.test(ctx.all)) return;
      for (const f of ctx.three) for (const m of f.text.matchAll(new RegExp(String.raw`new\s+(?:[\w$]+\.)?(?:${CONTROLS})\s*\(\s*[\w$.]+\s*\)`, "g"))) report(f, m.index ?? 0);
    },
  },

  // ---- animation ----
  {
    id: "mixer-never-updated",
    category: "correctness",
    severity: "error",
    title: "AnimationMixer is never updated",
    message: "An AnimationMixer only animates when mixer.update(delta) runs every frame; this one is never updated, so the model stays in its bind pose.",
    fix: "In the animation loop: mixer.update( timer.getDelta() ); (or clock.getDelta()).",
    check(ctx, report) {
      for (const c of created(ctx, "AnimationMixer")) {
        if (!c.name) continue;
        const uses = refs(ctx.all, c.name).filter((r) => !/^\s*(?::[^=]+)?=(?!=)/.test(r.after));
        if (uses.some((r) => /^\s*\??\.\s*update\s*\(/.test(r.after))) continue;
        // handed on (pushed to an array, returned, passed to a function): someone else may update it
        if (uses.some((r) => !/^\s*\??\.\s*(?:clipAction|existingAction|addEventListener|stopAllAction|timeScale|setTime|time\b|uncacheRoot|uncacheClip|uncacheAction)/.test(r.after))) continue;
        if (/export\s/.test(c.f.text.slice(Math.max(0, c.at - 60), c.at))) continue;
        report(c.f, c.at);
      }
    },
  },
  {
    id: "clip-action-unused",
    category: "correctness",
    severity: "warn",
    title: "clipAction() without play()",
    message: "clipAction() only creates the action; nothing plays until .play() is called on it.",
    fix: "mixer.clipAction( clip ).play();",
    check(ctx, report) {
      for (const f of ctx.three) {
        for (const m of f.text.matchAll(/\.clipAction\s*\(/g)) {
          const open = (m.index ?? 0) + m[0].length - 1;
          const close = closeOf(f.text, open);
          if (close < 0 || /^\s*\??\./.test(f.text.slice(close + 1, close + 20))) continue;
          const before = f.text.slice(Math.max(0, (m.index ?? 0) - 200), m.index ?? 0).replace(/[\w$.[\]]*$/, "");
          const assign = /(?:(?:const|let|var)\s+)?([\w$]+)\s*=\s*$/.exec(before);
          if (assign?.[1] && !/[=!<>]=\s*$|=>\s*$/.test(before)) {
            if (refs(f.text, assign[1]).length <= 1) report(f, m.index ?? 0);
          } else if (/(?:^|[;{}])\s*$/.test(before) && !/\b(?:return|await|yield)\s*$/.test(before)) report(f, m.index ?? 0);
        }
      }
    },
  },

  // ---- buffers ----
  {
    id: "instanced-no-needs-update",
    category: "correctness",
    severity: "error",
    title: "Instances changed every frame without needsUpdate",
    message: "setMatrixAt()/setColorAt() only change the CPU copy; after the first frame the GPU sees nothing until instanceMatrix.needsUpdate (instanceColor.needsUpdate) is set.",
    fix: "After the loop over instances: mesh.instanceMatrix.needsUpdate = true; (and mesh.instanceColor.needsUpdate = true).",
    check(ctx, report) {
      if (!/InstancedMesh|<instancedMesh\b/.test(ctx.all) || /BatchedMesh/.test(ctx.all) || webgpuDynamic(ctx)) return;
      const matrixOk = /instanceMatrix\s*\.\s*needsUpdate\s*=\s*true/.test(ctx.all);
      const colorOk = /instanceColor\s*\.\s*needsUpdate\s*=\s*true/.test(ctx.all);
      for (const f of ctx.three) {
        for (const b of loopBodies(f)) {
          const body = f.text.slice(b.start, b.end);
          const m = !matrixOk ? /\.setMatrixAt\s*\(/.exec(body) : null;
          if (m) report(f, b.start + m.index);
          const c = !colorOk ? /\.setColorAt\s*\(/.exec(body) : null;
          if (c) report(f, b.start + c.index, { message: "setColorAt() only changes the CPU copy; after the first frame the GPU sees nothing until instanceColor.needsUpdate is set.", fix: "mesh.instanceColor.needsUpdate = true; after the loop." });
        }
      }
    },
  },
  {
    id: "attribute-no-needs-update",
    category: "correctness",
    severity: "error",
    title: "Vertex data changed every frame without needsUpdate",
    message: "The attribute is written in the frame loop but never flagged, so the GPU keeps the old vertices.",
    fix: "After writing: geometry.attributes.position.needsUpdate = true; (and computeVertexNormals() / computeBoundingSphere() if they depend on it).",
    check(ctx, report) {
      if (webgpuDynamic(ctx)) return;
      const write = /\.set(?:XY|XYZ|XYZW)\s*\(|\.(?:attributes\s*\.\s*[\w$]+|getAttribute\s*\([^)]*\))\s*\.\s*(?:array\s*\[[^\]]+\]\s*=(?!=)|set[XYZW]\s*\(|set\s*\()/;
      for (const f of ctx.three) {
        if (/needsUpdate\s*=\s*true|\.version\s*\+\+|\+\+\s*[\w$.]+\.version\b/.test(f.text)) continue;
        for (const b of loopBodies(f)) {
          const m = write.exec(f.text.slice(b.start, b.end));
          if (m) report(f, b.start + m.index);
        }
      }
    },
  },
  legacy("update-range-removed", "updateRange was replaced by addUpdateRange()", /\.updateRange\b/, "`BufferAttribute.updateRange` was deprecated in r159 and removed in r169.", "attribute.clearUpdateRanges(); attribute.addUpdateRange( start, count ); attribute.needsUpdate = true;", { deprecatedIn: 159, removedIn: 169, introducedIn: 159 }),

  // ---- camera and depth ----
  {
    id: "camera-aspect-fixed",
    category: "correctness",
    severity: "warn",
    title: "Camera aspect never matches the canvas",
    message: "The camera keeps a fixed aspect (1 when left out) and it is never set from the canvas size, so the picture is stretched.",
    fix: "new THREE.PerspectiveCamera( 60, width / height, 0.1, 100 ), and on resize: camera.aspect = width / height; camera.updateProjectionMatrix();",
    check(ctx, report) {
      if (ctx.three.some((f) => f.r3f)) return;
      for (const c of created(ctx, "PerspectiveCamera")) {
        if (!c.name) continue;
        const a = callArgs(c.f.text, c.at + c.f.text.slice(c.at).indexOf("("));
        const args = a ? splitTop(c.f.text.slice(a.start, a.end)).map((p) => p.text.trim()) : [];
        const aspect = args[1];
        if (aspect !== undefined && !/^\d*\.?\d+$/.test(aspect)) continue;
        const n = esc(c.name);
        if (new RegExp(String.raw`\b${n}\s*\.\s*aspect\s*=(?!=)`).test(ctx.all)) continue;
        if (!new RegExp(String.raw`\.render\s*\(\s*[\w$.]+\s*,\s*(?:this\.)?${n}\s*\)|RenderPass\s*\(\s*[\w$.]+\s*,\s*(?:this\.)?${n}\s*\)`).test(c.f.text)) continue;
        // views, scissor rects, render targets and XR cameras have their own aspect
        if (/setRenderTarget\s*\(|setScissor\s*\(|setViewport\s*\(|\.xr\b/.test(c.f.text)) continue;
        const size = /setSize\s*\(\s*(\d+)\s*,\s*(\d+)/.exec(ctx.all);
        if (size && Math.abs(Number(size[1]) / Number(size[2]) - Number(aspect ?? 1)) < 0.01) continue;
        report(c.f, c.at);
      }
    },
  },
  {
    id: "raycast-mouse-window",
    category: "correctness",
    severity: "warn",
    title: "Pointer coordinates from the window, canvas sized from a container",
    message: "The pointer is normalized by the window size while the canvas is sized from its container, so raycasts pick the wrong objects.",
    fix: "const r = renderer.domElement.getBoundingClientRect(); pointer.x = ( ( e.clientX - r.left ) / r.width ) * 2 - 1; pointer.y = - ( ( e.clientY - r.top ) / r.height ) * 2 + 1;",
    check(ctx, report) {
      if (!/setSize\s*\([^)]*\b(?:clientWidth|offsetWidth|getBoundingClientRect|contentRect)\b/.test(ctx.all) || /setSize\s*\(\s*(?:window\.)?innerWidth\b/.test(ctx.all)) return;
      for (const f of ctx.three) for (const m of f.text.matchAll(/\bclient[XY]\s*\/\s*(?:window\.)?inner(?:Width|Height)\b/g)) report(f, m.index ?? 0);
    },
  },

  // ---- shadows, textures, loops ----
  {
    id: "cast-shadow-no-receiver",
    category: "correctness",
    severity: "warn",
    title: "Shadows are cast but nothing receives them",
    message: "Objects cast shadows but no object has receiveShadow, so the shadow map is rendered and never shown.",
    fix: "Set receiveShadow = true on the ground and other meshes that should show shadows.",
    check(ctx, report) {
      if (/receiveShadow/.test(ctx.all)) return;
      if (!/shadowMap\s*\.\s*enabled\s*=\s*true|shadowMap\s*:\s*\{[^}]*enabled\s*:\s*true|<Canvas\b[^>]*\bshadows\b/.test(ctx.all)) return;
      // a mesh the project itself makes cast (a light casting onto objects an addon builds says nothing)
      for (const f of ctx.three) {
        for (const m of f.text.matchAll(/([\w$]+)\s*\.castShadow\s*=\s*true/g)) {
          if (/light|sun|lamp|spot/i.test(m[1] ?? "")) continue;
          report(f, m.index ?? 0);
          return;
        }
      }
    },
  },
  {
    id: "gltf-texture-flipy",
    category: "correctness",
    severity: "warn",
    title: "Texture put on a glTF material without flipY = false",
    message: "glTF UVs expect textures with flipY = false, but TextureLoader flips them, so this texture shows upside down on the model.",
    fix: "texture.flipY = false; (and texture.colorSpace = THREE.SRGBColorSpace for color maps) before assigning it.",
    check(ctx, report) {
      if (!/\bGLTFLoader\b/.test(ctx.all) || !/\bTextureLoader\b/.test(ctx.all) || /\bflipY\b/.test(ctx.all)) return;
      for (const f of ctx.three) {
        // textures this file loads with TextureLoader
        const loaders = created({ ...ctx, three: [f] }, "TextureLoader").flatMap((c) => (c.name ? [esc(c.name)] : []));
        const recv = [...loaders, String.raw`new\s+(?:[\w$]+\.)?TextureLoader\s*\([^)]*\)`].join("|");
        const textures = new Set([...f.text.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?(?:${recv})\s*\.\s*load(?:Async)?\s*\(`, "g"))].map((m) => m[1] as string));
        if (!textures.size) continue;
        for (const m of f.text.matchAll(/\.traverse\s*\(/g)) {
          const open = (m.index ?? 0) + m[0].length - 1;
          const close = closeOf(f.text, open);
          if (close < 0) continue;
          const body = f.text.slice(open, close);
          for (const a of body.matchAll(/\.material\s*\.\s*(?:map|emissiveMap|normalMap|roughnessMap|metalnessMap|aoMap|alphaMap)\s*=(?!=)\s*([\w$]+)\s*[;\n)}]/g)) {
            if (textures.has(a[1] ?? "")) report(f, open + (a.index ?? 0));
          }
        }
      }
    },
  },
  {
    id: "double-animation-loop",
    category: "correctness",
    severity: "error",
    title: "The same loop runs on setAnimationLoop and requestAnimationFrame",
    message: "This function is driven by setAnimationLoop and also schedules itself with requestAnimationFrame, so it runs twice per frame (double speed, double cost).",
    fix: "Remove the requestAnimationFrame call; setAnimationLoop already calls the function every frame.",
    check(ctx, report) {
      for (const f of ctx.three) {
        const names = [...f.text.matchAll(/setAnimationLoop\s*\(\s*(?:this\.)?([\w$]+)\s*\)/g)].map((m) => m[1] as string).filter((n) => n !== "null");
        for (const n of new Set(names)) for (const m of f.text.matchAll(new RegExp(String.raw`requestAnimationFrame\s*\(\s*(?:this\.)?${esc(n)}\s*\)`, "g"))) report(f, m.index ?? 0);
      }
    },
  },
  {
    id: "stencil-not-enabled",
    category: "correctness",
    severity: "error",
    title: "Stencil used but the renderer has no stencil buffer",
    message: "The renderer's `stencil` option is false by default since r163, so stencilWrite / stencilFunc do nothing.",
    fix: "new THREE.WebGLRenderer( { stencil: true } ) (R3F: <Canvas gl={{ stencil: true }}>), or stencilBuffer: true on the render target.",
    introducedIn: 163,
    check(ctx, report) {
      if (/\bstencil\s*:\s*true|stencilBuffer\s*:\s*true/.test(ctx.all)) return;
      for (const f of ctx.three) {
        const m = /\bstencilWrite\s*[:=]\s*\{?\s*true/.exec(f.text);
        if (m) {
          report(f, m.index);
          return;
        }
      }
    },
  },

  // ---- color ----
  {
    id: "composer-no-output-pass",
    category: "color",
    severity: "warn",
    title: "EffectComposer without OutputPass",
    message: "Since r155 tone mapping and the sRGB conversion only happen when rendering to the screen, so an EffectComposer without OutputPass shows dark, linear colors.",
    fix: "composer.addPass( new OutputPass() ); as the last pass (import { OutputPass } from 'three/addons/postprocessing/OutputPass.js').",
    introducedIn: 155,
    check(ctx, report) {
      if (/\bOutputPass\b|GammaCorrectionShader/.test(ctx.all)) return;
      // three's own EffectComposer only (pmndrs' postprocessing handles color space itself)
      for (const c of created(ctx, "EffectComposer")) if (/from\s+['"]three\/(?:addons|examples\/jsm)\/postprocessing\/EffectComposer\.js['"]/.test(c.f.text)) report(c.f, c.at);
    },
  },
  {
    id: "composer-double-gamma",
    category: "color",
    severity: "warn",
    title: "OutputPass and GammaCorrectionShader together",
    message: "OutputPass already converts to sRGB, so a GammaCorrectionShader pass as well applies the gamma twice and washes the image out.",
    fix: "Remove the ShaderPass( GammaCorrectionShader ); keep OutputPass as the last pass.",
    check(ctx, report) {
      for (const f of ctx.three) if (/new\s+(?:[\w$]+\.)?OutputPass\s*\(/.test(f.text)) for (const m of f.text.matchAll(/new\s+(?:[\w$]+\.)?ShaderPass\s*\(\s*(?:[\w$]+\.)?GammaCorrectionShader\b/g)) report(f, m.index ?? 0);
    },
  },
  {
    id: "env-map-intensity-ignored",
    category: "color",
    severity: "warn",
    title: "envMapIntensity does not scale scene.environment",
    message: "Since r163 `envMapIntensity` only scales a material's own envMap; with scene.environment it is replaced by scene.environmentIntensity.",
    fix: "Set scene.environmentIntensity (or give the material its own envMap).",
    introducedIn: 163,
    check(ctx, report) {
      if (!/\.environment\s*=(?!=)/.test(ctx.all) || /environmentIntensity|\benvMap\s*[:=](?!=)/.test(ctx.all)) return;
      for (const f of ctx.three) {
        const m = /\benvMapIntensity\s*[:=](?!=)(?!\s*1(?:\.0*)?\b)/.exec(f.text);
        if (m) {
          report(f, m.index);
          return;
        }
      }
    },
  },

  // ---- everyday mistakes ----
  {
    id: "add-gltf-result",
    category: "correctness",
    severity: "error",
    title: "The glTF result added instead of gltf.scene",
    message: "GLTFLoader hands over an object holding scene, animations and cameras, not an Object3D: scene.add(gltf) logs \"object not an instance of THREE.Object3D\" and the model never shows.",
    fix: "scene.add( gltf.scene );",
    check(ctx, report) {
      for (const f of ctx.three) {
        if (!/\bGLTFLoader\b/.test(f.text)) continue;
        const loaders = new Set(created({ ...ctx, three: [f] }, "GLTFLoader").flatMap((c) => (c.name ? [c.name] : [])));
        const recv = [...loaders].map(esc).concat(String.raw`new\s+(?:[\w$]+\.)?GLTFLoader\s*\([^)]*\)`).join("|");
        const results = new Set<string>();
        for (const m of f.text.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*await\s+(?:this\.)?(?:${recv})\s*\.\s*(?:loadAsync|parseAsync)\s*\(`, "g"))) results.add(m[1] as string);
        for (const m of f.text.matchAll(new RegExp(String.raw`(?:${recv})\s*\.\s*(?:load|parse)\s*\(`, "g"))) {
          const open = (m.index ?? 0) + m[0].length - 1;
          const close = closeOf(f.text, open);
          if (close < 0) continue;
          const cb = splitTop(f.text.slice(open + 1, close))[1]?.text ?? "";
          const p = /^\s*(?:async\s*)?(?:\(\s*([\w$]+)\s*\)|([\w$]+))\s*=>|^\s*function\s*[\w$]*\s*\(\s*([\w$]+)/.exec(cb);
          const name = p?.[1] ?? p?.[2] ?? p?.[3];
          if (name) results.add(name);
        }
        for (const n of results) for (const m of f.text.matchAll(new RegExp(String.raw`\.add\s*\(\s*${esc(n)}\s*\)`, "g"))) report(f, m.index ?? 0, { fix: `scene.add( ${n}.scene );` });
      }
    },
  },
  {
    id: "render-args-swapped",
    category: "correctness",
    severity: "error",
    title: "render(camera, scene)",
    message: "render() takes the scene first and the camera second; swapped, nothing is drawn.",
    fix: "renderer.render( scene, camera );",
    check(ctx, report) {
      for (const f of ctx.three) {
        for (const m of f.text.matchAll(/\.render\s*\(\s*((?:this\.)?\w*[cC]amera\w*)\s*,\s*((?:this\.)?\w*[sS]cene\w*)\s*\)/g)) {
          if (/[sS]cene/.test(m[1] ?? "")) continue;
          report(f, m.index ?? 0, { fix: `renderer.render( ${m[2]}, ${m[1]} );` });
        }
      }
    },
  },
  {
    id: "color-assign-number",
    category: "correctness",
    severity: "error",
    title: "Color property replaced by a number or string",
    message: "`material.color` is a THREE.Color; assigning a number or string replaces it, so the shader gets no valid color.",
    fix: "material.color.set( 0xff0000 ); (set() takes hex numbers, CSS strings and other Colors).",
    check(ctx, report) {
      const re = /\b(?:[\w$]*[mM]aterial[\w$]*|mat|[\w$]*[lL]ight[\w$]*)(?:\s*\[[^\]]+\])?\s*\.\s*(color|emissive|specular|sheenColor|specularColor|attenuationColor|groundColor)\s*=(?!=)\s*(0x[\da-fA-F]+\b|'[^'\n]*'|"[^"\n]*")/g;
      for (const f of ctx.three) for (const m of f.text.matchAll(re)) report(f, m.index ?? 0, { fix: `.${m[1]}.set( ${m[2]} );` });
    },
  },
  {
    id: "rotation-degrees",
    category: "correctness",
    severity: "warn",
    title: "Rotation in degrees",
    message: "Rotations are in radians; 90 here is about 14 turns, not a quarter turn.",
    fix: "Use radians: Math.PI / 2 for 90°, or THREE.MathUtils.degToRad( 90 ).",
    check(ctx, report) {
      const deg = String.raw`-?(?:45|90|180|270|360)(?![\d.])`;
      for (const f of ctx.three) {
        for (const m of f.text.matchAll(new RegExp(String.raw`\.rotation\s*\.\s*[xyz]\s*[-+]?=(?!=)\s*(${deg})|\.rotation\s*\.\s*set\s*\(\s*(?:[^,()]+,\s*){0,2}(${deg})\s*[,)]`, "g"))) {
          const d = Math.abs(Number(m[1] ?? m[2]));
          report(f, m.index ?? 0, { message: `Rotations are in radians; ${d} here is about ${(d / (2 * Math.PI)).toFixed(0)} turns, not ${d} degrees.`, fix: `Use radians: THREE.MathUtils.degToRad( ${d} ) (${{ 45: "Math.PI / 4", 90: "Math.PI / 2", 180: "Math.PI", 270: "Math.PI * 1.5", 360: "Math.PI * 2" }[d]}).` });
        }
      }
    },
  },
  {
    id: "clock-elapsed-and-delta",
    category: "correctness",
    severity: "error",
    title: "getElapsedTime() and getDelta() on the same Clock",
    message: "Clock.getElapsedTime() calls getDelta() itself, so a getDelta() after it returns almost 0 and motion driven by it stops.",
    fix: "Call getDelta() once per frame and add it up for the elapsed time, or use THREE.Timer (timer.update(); timer.getDelta(); timer.getElapsed()).",
    check(ctx, report) {
      for (const c of created(ctx, "Clock")) {
        if (!c.name) continue;
        const n = esc(c.name);
        const f = c.f;
        if (!new RegExp(String.raw`(?<![\w$.])(?:this\.)?${n}\s*\.\s*getDelta\s*\(`).test(f.text)) continue;
        for (const m of f.text.matchAll(new RegExp(String.raw`(?<![\w$.])(?:this\.)?${n}\s*\.\s*getElapsedTime\s*\(`, "g"))) report(f, m.index ?? 0);
      }
    },
  },
  {
    id: "linewidth-ignored",
    category: "correctness",
    severity: "warn",
    title: "linewidth above 1 on a basic line material",
    message: "WebGL and WebGPU always draw line primitives one pixel wide, so this linewidth is ignored.",
    fix: "For thick lines use Line2 with LineMaterial ({ linewidth }) from 'three/addons/lines/', or a mesh such as TubeGeometry.",
    check(ctx, report) {
      for (const f of ctx.three) {
        if (/\bSVGRenderer\b/.test(f.text)) continue; // SVGRenderer draws linewidth
        for (const m of f.text.matchAll(/new\s+(?:[\w$]+\.)?(?:LineBasicMaterial|LineDashedMaterial)\s*\(\s*\{/g)) {
          const open = (m.index ?? 0) + m[0].length - 1;
          const close = closeOf(f.text, open);
          const w = close > 0 ? /\blinewidth\s*:\s*(\d*\.?\d+)/.exec(f.text.slice(open, close)) : null;
          if (w && Number(w[1]) > 1) report(f, open + w.index);
        }
      }
    },
  },

  // ---- renamed options and deprecations ----
  {
    id: "text-geometry-height",
    category: "api",
    severity: "warn",
    title: "TextGeometry `height` is now `depth`",
    message: "TextGeometry's `height` was renamed `depth` in r163 and is ignored since r173, so the text gets the default depth of 50.",
    fix: "Rename the option to depth.",
    deprecatedIn: 163,
    removedIn: 173,
    introducedIn: 163,
    check(ctx, report) {
      for (const f of ctx.three) {
        for (const m of f.text.matchAll(newRe("TextGeometry"))) {
          const a = callArgs(f.text, (m.index ?? 0) + m[0].length - 1);
          if (!a) continue;
          const opts = splitTop(f.text.slice(a.start, a.end))[1];
          if (!opts || !/^\s*\{/.test(opts.text) || /\bdepth\s*:/.test(opts.text)) continue;
          const h = /\bheight\s*:/.exec(opts.text);
          if (h) report(f, a.start + opts.at + h.index);
        }
      }
    },
  },
  legacy("reverse-depth-buffer-option", "reverseDepthBuffer was renamed reversedDepthBuffer", /\breverseDepthBuffer\s*:/, "The renderer option `reverseDepthBuffer` was renamed `reversedDepthBuffer` in r179; the old name is ignored.", "new THREE.WebGLRenderer( { reversedDepthBuffer: true } )", { removedIn: 179, introducedIn: 179 }),
  legacy("color-buffer-type-option", "colorBufferType was renamed outputBufferType", /\bcolorBufferType\s*:/, "The WebGPURenderer option `colorBufferType` was renamed `outputBufferType` in r182; the old name is ignored.", "new WebGPURenderer( { outputBufferType: THREE.HalfFloatType } )", { removedIn: 182, introducedIn: 182 }),
  legacy("pcf-soft-shadow", "PCFSoftShadowMap is deprecated", /\bPCFSoftShadowMap\b/, "`PCFSoftShadowMap` is deprecated since r182: WebGLRenderer uses PCFShadowMap instead (now soft too), and WebGPURenderer removed it in r186.", "renderer.shadowMap.type = THREE.PCFShadowMap;", { severity: "info", deprecatedIn: 182, introducedIn: 182 }),
  {
    id: "post-processing-renamed",
    category: "api",
    severity: "info",
    title: "PostProcessing is now RenderPipeline",
    message: "`PostProcessing` was renamed `RenderPipeline` in r183; the old name is a deprecated subclass that only warns.",
    fix: "Use new RenderPipeline( renderer ) (same API), imported from 'three/webgpu'.",
    deprecatedIn: 183,
    introducedIn: 183,
    check(ctx, report) {
      for (const f of ctx.three) {
        if (!/['"]three\/webgpu['"]/.test(f.text)) continue;
        for (const m of f.text.matchAll(newRe("PostProcessing"))) report(f, m.index ?? 0);
      }
    },
  },
  {
    id: "deprecated-api",
    category: "api",
    severity: "info",
    title: "API deprecated in a recent release",
    message: "This API is deprecated.",
    fix: "Use its replacement.",
    introducedIn: 181,
    check: deprecationRule,
  },
  {
    id: "tsl-renamed",
    category: "api",
    severity: "info",
    title: "Renamed TSL function",
    message: "This TSL function was renamed.",
    fix: "Use the new name.",
    introducedIn: 181,
    check(ctx, report) {
      for (const f of ctx.three) {
        const imported = tslImports(f);
        for (const [local, name] of imported) {
          const r = TSL_RENAMED[name];
          if (!r || local !== name || ctx.release < r.since) continue;
          for (const at of usesOf(f.text, name)) report(f, at, { message: `TSL \`${name}\` was renamed \`${r.to}\` in r${r.since}; the old name is a deprecated alias.`, fix: `Use ${r.to} (imported from 'three/tsl').` });
        }
      }
    },
  },

  // ---- lifecycle ----
  {
    id: "dispose-without-super",
    category: "lifecycle",
    severity: "warn",
    title: "dispose() override that skips the parent's cleanup",
    message: "This class overrides dispose() without super.dispose(), so the parent's own cleanup never runs and its GPU resources leak.",
    fix: "Call super.dispose(); inside your dispose().",
    check(ctx, report) {
      // the three classes whose dispose() frees something of their own (checked in the installed source)
      const frees: Record<string, string> = {
        InstancedMesh: "instanceMatrix, instanceColor and the morph texture",
        BatchedMesh: "its geometry and data textures",
        DirectionalLight: "the shadow map",
        PointLight: "the shadow map",
        SpotLight: "the shadow map",
      };
      for (const f of ctx.three) {
        const nsNames = [...f.namespaces].map(esc).join("|") || "THREE";
        const re = new RegExp(String.raw`class\s+[\w$]+\s+extends\s+(?:(?:${nsNames})\.)?(${Object.keys(frees).join("|")})\b[^{]*\{`, "g");
        for (const m of f.text.matchAll(re)) {
          const base = m[1] ?? "";
          if (!m[0].includes(".") && f.named.get(base) !== base) continue; // a class of that name that is not three's
          const open = (m.index ?? 0) + m[0].length - 1;
          const close = closeOf(f.text, open);
          if (close < 0) continue;
          const body = f.text.slice(open, close);
          const d = /(?:^|[;}\s])dispose\s*\(\s*\)\s*\{/.exec(body);
          if (!d) continue;
          const dOpen = open + d.index + d[0].length - 1;
          const dClose = closeOf(f.text, dOpen);
          if (dClose > 0 && !/super\s*\.\s*dispose\s*\(/.test(f.text.slice(dOpen, dClose))) {
            report(f, open + d.index + d[0].search(/dispose/), { message: `This ${base} subclass overrides dispose() without super.dispose(), so ${frees[base]} of ${base} are never freed.` });
          }
        }
      }
    },
  },

  // ---- React Three Fiber ----
  {
    id: "r3f-set-state-in-frame",
    category: "performance",
    severity: "warn",
    title: "React state set inside useFrame",
    message: "Calling a useState setter in useFrame re-renders the component up to 60 times a second; R3F's docs say never setState there.",
    fix: "Mutate the object through a ref (ref.current.position.x += delta) and keep React state for discrete changes.",
    check(ctx, report) {
      for (const f of ctx.three) {
        if (!f.r3f) continue;
        const setters = [...f.text.matchAll(/\[\s*[\w$]+\s*,\s*(set[\w$]+)\s*\]\s*=\s*(?:React\.)?useState\b/g)].map((m) => m[1] as string);
        if (!setters.length) continue;
        const re = new RegExp(String.raw`(?<![\w$.])(?:${setters.map(esc).join("|")})\s*\(`, "g");
        for (const b of loopBodies(f)) {
          if (!/\buseFrame\s*\(/.test(f.text.slice(Math.max(0, b.start - 120), b.start))) continue;
          for (const m of f.text.slice(b.start, b.end).matchAll(re)) report(f, b.start + (m.index ?? 0));
        }
      }
    },
  },
  {
    id: "r3f-render-without-priority",
    category: "performance",
    severity: "error",
    title: "Rendering inside useFrame without a render priority",
    message: "R3F keeps rendering by itself unless useFrame gets a render priority, so this render() draws every frame twice.",
    fix: "Pass a priority to take over the loop: useFrame(({ gl, scene, camera }) => { gl.render(scene, camera) }, 1).",
    check(ctx, report) {
      for (const f of ctx.three) {
        if (!f.r3f) continue;
        for (const m of f.text.matchAll(/\buseFrame\s*\(/g)) {
          const open = (m.index ?? 0) + m[0].length - 1;
          const close = closeOf(f.text, open);
          if (close < 0) continue;
          const parts = splitTop(f.text.slice(open + 1, close));
          if (parts.length !== 1) continue;
          const r = /\b(?:gl|renderer|composer)\s*\.\s*render\s*\(/.exec(parts[0]?.text ?? "");
          if (r) report(f, open + 1 + (parts[0]?.at ?? 0) + r.index);
        }
      }
    },
  },
  {
    id: "r3f-new-in-render",
    category: "performance",
    severity: "warn",
    title: "Geometry or material created on every render",
    message: "A geometry, material or texture is created in the component body, so every re-render makes a new one and the old one leaks until R3F disposes it.",
    fix: "Wrap it: const geometry = useMemo(() => new THREE.BoxGeometry(), []); (or use the JSX element <boxGeometry />).",
    check(ctx, report) {
      const heavy = new RegExp(String.raw`new\s+(?:[\w$]+\.)?(?:\w+Geometry|\w+Material|TextureLoader|CanvasTexture|DataTexture|WebGLRenderTarget|RenderTarget)\s*\(`, "g");
      for (const f of ctx.three) {
        if (!f.r3f) continue;
        for (const b of componentBodies(f)) {
          const body = renderOnly(f.text.slice(b.start + 1, b.end));
          for (const m of body.matchAll(heavy)) report(f, b.start + 1 + (m.index ?? 0));
        }
      }
    },
  },
];
