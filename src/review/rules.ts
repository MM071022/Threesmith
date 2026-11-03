import { existsSync } from "node:fs";
import { join } from "node:path";
import { suggest } from "../api/lookup.js";
import { blockAt } from "./source.js";
import type { SourceFile } from "./source.js";
import type { Ctx, Report, Rule } from "./types.js";

function each(ctx: Ctx, re: RegExp, report: Report, pick: (m: RegExpExecArray, f: SourceFile) => boolean = () => true): void {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  for (const f of ctx.three) {
    for (const m of f.text.matchAll(new RegExp(re.source, flags))) {
      if (pick(m as RegExpExecArray, f)) report(f, m.index ?? 0);
    }
  }
}

/** Regex source that matches a three class via namespace (THREE.X) or a bare import. */
function ns(f: SourceFile): string {
  return f.namespaces.size ? `(?:(?:${[...f.namespaces].join("|")})\\.)` : "(?:THREE\\.)";
}

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
  ];
  for (const re of res) {
    for (const m of f.text.matchAll(re)) {
      const b = blockAt(f.text, (m.index ?? 0) + m[0].length - 1);
      if (b) out.push(b);
    }
  }
  return out;
}

function inLoops(ctx: Ctx, re: RegExp, report: Report, pick: (name: string, f: SourceFile) => boolean = () => true): void {
  for (const f of ctx.three) {
    for (const b of loopBodies(f)) {
      const body = f.text.slice(b.start, b.end);
      for (const m of body.matchAll(new RegExp(re.source, "g"))) {
        if (pick(m[1] ?? "", f)) report(f, b.start + (m.index ?? 0));
      }
    }
  }
}

function legacy(
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

const ALLOC = "Vector2|Vector3|Vector4|Quaternion|Matrix3|Matrix4|Euler|Color|Box3|Sphere|Raycaster|Plane|Ray|Spherical";
const HEAVY = "BufferGeometry|BoxGeometry|SphereGeometry|PlaneGeometry|CylinderGeometry|TorusGeometry|ExtrudeGeometry|TextGeometry|TextureLoader|GLTFLoader|WebGLRenderer|WebGLRenderTarget|CanvasTexture|MeshStandardMaterial|MeshBasicMaterial|MeshPhysicalMaterial|MeshPhongMaterial|MeshLambertMaterial|ShaderMaterial|SpriteMaterial|LineBasicMaterial|PointsMaterial";

export const RULES: Rule[] = [
  // ---- api: outdated or removed code ----
  legacy("geometry-class", "THREE.Geometry was removed", /\b(?:THREE\.)Geometry\b(?!\w)|new\s+Geometry\s*\(/, "`THREE.Geometry` no longer exists; every geometry is a BufferGeometry.", "Use BufferGeometry with setAttribute('position', new Float32BufferAttribute(...)) or setFromPoints().", { removedIn: 125 }),
  legacy("face3", "THREE.Face3 was removed", /\bFace3\b/, "`Face3` was removed together with Geometry.", "Write indices with geometry.setIndex() and attributes with setAttribute().", { removedIn: 125 }),
  legacy("geometry-vertices", "geometry.vertices / geometry.faces do not exist", /\b(?:geometry|geo|geom)\.(?:vertices|faces)\b/, "BufferGeometry has no `vertices` or `faces` arrays.", "Read geometry.attributes.position (and geometry.index) instead.", { removedIn: 125 }),
  legacy("compute-face-normals", "computeFaceNormals was removed", /\.computeFaceNormals\s*\(/, "`computeFaceNormals()` belonged to Geometry.", "Call computeVertexNormals() on the BufferGeometry.", { removedIn: 125 }),
  legacy("buffer-geometry-alias", "XBufferGeometry aliases were removed", /\b(?:Box|Sphere|Plane|Cylinder|Circle|Cone|Torus|TorusKnot|Ring|Lathe|Extrude|Shape|Tube|Icosahedron|Octahedron|Tetrahedron|Dodecahedron|Polyhedron|Parametric|Capsule|Edges|Wireframe)BufferGeometry\b/, "`BoxBufferGeometry` and friends were renamed; the plain name is the BufferGeometry now.", "Drop the 'Buffer': BoxBufferGeometry -> BoxGeometry, PlaneBufferGeometry -> PlaneGeometry, ...", { removedIn: 144 }),
  legacy("image-utils-load-texture", "ImageUtils.loadTexture was removed", /\bImageUtils\.loadTexture\b/, "`ImageUtils.loadTexture` is gone.", "Use new THREE.TextureLoader().load(url) (or loadAsync).", {}),
  legacy("three-math", "THREE.Math is now THREE.MathUtils", /\bTHREE\.Math\.(?!PI\b)\w+/, "`THREE.Math` was renamed.", "Use THREE.MathUtils (degToRad, clamp, lerp, ...).", { removedIn: 113, introducedIn: 113 }),
  legacy("output-encoding", "renderer.outputEncoding was replaced", /\boutputEncoding\b/, "`outputEncoding` was replaced by `outputColorSpace`.", "renderer.outputColorSpace = THREE.SRGBColorSpace (the default since r152, so usually delete the line).", { category: "color", removedIn: 162, introducedIn: 152 }),
  legacy("texture-encoding", "texture.encoding / *Encoding constants were replaced", /\b(?:sRGBEncoding|LinearEncoding|GammaEncoding|RGBEEncoding|LogLuvEncoding|BasicDepthPacking)\b(?<!BasicDepthPacking)|\b(?:texture|map|tex)\.encoding\b/, "Texture `encoding` and the *Encoding constants were replaced by colorSpace.", "texture.colorSpace = THREE.SRGBColorSpace for color maps; leave data maps (normal, roughness) as NoColorSpace.", { category: "color", removedIn: 162, introducedIn: 152 }),
  legacy("legacy-lights", "renderer.useLegacyLights was removed", /\buseLegacyLights\b/, "`useLegacyLights` was only a migration switch and is removed.", "Delete it and scale light intensities for physical units (PointLight/SpotLight intensity in candela, decay 2).", { removedIn: 165, introducedIn: 155 }),
  legacy("gamma-output", "gammaOutput / gammaFactor were removed", /\b(?:gammaOutput|gammaFactor|gammaInput)\b/, "The gamma flags were replaced by color management.", "Set renderer.outputColorSpace (default sRGB) and give color textures texture.colorSpace = THREE.SRGBColorSpace.", { category: "color", introducedIn: 152 }),
  legacy("merge-buffer-geometries", "mergeBufferGeometries was renamed", /\bmerge(?:BufferGeometries|BufferAttributes)\b/, "`mergeBufferGeometries` / `mergeBufferAttributes` were renamed in BufferGeometryUtils.", "Use mergeGeometries / mergeAttributes (import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js').", { removedIn: 151, introducedIn: 151 }),
  legacy("examples-js", "examples/js scripts were removed", /three\/examples\/js\/|examples\/js\//, "The non-module `examples/js` builds were removed.", "Use ES modules from 'three/addons/...' and an import map.", { severity: "error", removedIn: 148 }),
  legacy("apply-matrix", "applyMatrix was renamed applyMatrix4", /\.applyMatrix\s*\(/, "`applyMatrix()` was renamed.", "Use applyMatrix4().", {}),
  legacy("renderer-context", "renderer.context is deprecated", /\brenderer\.context\b/, "`renderer.context` was replaced by a method.", "Use renderer.getContext().", {}),
  {
    id: "addons-path",
    category: "api",
    severity: "info",
    title: "Use three/addons/ instead of three/examples/jsm/",
    message: "`three/examples/jsm/...` still works, but `three/addons/...` is the documented path and the one import maps use.",
    fix: "Replace 'three/examples/jsm/' with 'three/addons/'.",
    check(ctx, report) {
      each(ctx, /['"]three\/examples\/jsm\//, report);
    },
  },
  {
    id: "clock-deprecated",
    category: "api",
    severity: "info",
    title: "THREE.Clock is deprecated",
    message: "`Clock` is deprecated since r183.",
    fix: "Use THREE.Timer (timer.update(); timer.getDelta()).",
    deprecatedIn: 183,
    introducedIn: 183,
    check(ctx, report) {
      for (const f of ctx.three) {
        for (const m of f.text.matchAll(new RegExp(`new\\s+(${ns(f)})?Clock\\s*\\(`, "g"))) {
          if (m[1] || f.named.get("Clock") === "Clock") report(f, m.index ?? 0);
        }
      }
    },
  },
  {
    id: "unknown-symbol",
    category: "api",
    severity: "error",
    title: "Symbol does not exist in the installed three",
    message: "This name is not exported by the installed three version.",
    fix: "Check the name with `threesmith api <Name>`.",
    check(ctx, report) {
      const index = ctx.index;
      if (!index) return;
      const known = new Set(["Geometry", "Face3", "ImageUtils", "Math", "sRGBEncoding", "LinearEncoding", "GammaEncoding", "RGBEEncoding", "LogLuvEncoding"]);
      const isLegacy = (n: string) => known.has(n) || /BufferGeometry$/.test(n);
      for (const f of ctx.three) {
        const sourceOf = (n: string, mod: string) => {
          if (isLegacy(n)) return;
          const ref = index.exports.get(n);
          if (!ref) {
            if (!/^[A-Z]/.test(n) || /^(?:[A-Z][A-Z0-9_]+)$/.test(n) && !index.exports.has(n) && n.length < 3) return;
            const s = suggest(index, n);
            return { message: `\`${n}\` is not exported by three r${index.install.release}.${s.length ? ` Did you mean ${s.map((x) => "`" + x + "`").join(", ")}?` : ""}` };
          }
          if (ref.importPath.startsWith("three/addons/")) {
            return { message: `\`${n}\` is not part of the core package in r${index.install.release}; it lives in \`${ref.importPath}\`.`, fix: `import { ${n} } from '${ref.importPath}';` };
          }
          if (mod === "three" && index.webgpuOnly.has(n)) {
            return { message: `\`${n}\` is only exported from 'three/webgpu', not from 'three'.`, fix: `import { ${n} } from 'three/webgpu';` };
          }
        };
        for (const [local, imported] of f.named) {
          const mod = /from\s+['"]three\/webgpu['"]/.test(f.text) && !new RegExp(String.raw`\{[^}]*\b${imported}\b[^}]*\}\s*from\s*['"]three['"]`).test(f.text) ? "three/webgpu" : "three";
          const r = sourceOf(imported, mod);
          if (r) {
            const idx = f.text.search(new RegExp(String.raw`\b${local}\b`));
            report(f, idx < 0 ? 0 : idx, r);
          }
        }
        for (const nsName of f.namespaces) {
          const mod = f.namespaceFrom.get(nsName) ?? "three";
          const seen = new Set<string>();
          for (const m of f.text.matchAll(new RegExp(String.raw`(?<![\w$'"\`.])${nsName}\.([A-Za-z_$][\w$]*)`, "g"))) {
            const n = m[1] ?? "";
            if (!/^[A-Z]/.test(n) || seen.has(n)) continue;
            seen.add(n);
            const r = sourceOf(n, mod);
            if (r) report(f, m.index ?? 0, r);
          }
        }
        // addon file imports: does the file exist in this version?
        for (const m of f.text.matchAll(/from\s+['"]three\/(?:addons|examples\/jsm)\/([^'"]+)['"]/g)) {
          const rel = m[1] ?? "";
          const exists = [...index.exports.values()].some((r) => r.importPath === `three/addons/${rel}`) || addonFileExists(index.install.root, rel);
          if (!exists) report(f, m.index ?? 0, { message: `\`three/addons/${rel}\` does not exist in three r${index.install.release}.`, fix: "Look the class up with `threesmith api <Name>` for its current path." });
        }
      }
    },
  },

  // ---- correctness: things that render nothing or the wrong thing ----
  {
    id: "shadows-not-enabled",
    category: "correctness",
    severity: "error",
    title: "Shadows are requested but the renderer has shadows off",
    message: "`castShadow`/`receiveShadow` is set but `renderer.shadowMap.enabled = true` is missing, so no shadow will ever draw.",
    fix: "renderer.shadowMap.enabled = true; and set light.castShadow = true on at least one light.",
    check(ctx, report) {
      if (/shadowMap\s*\.\s*enabled\s*=\s*true|shadowMap\s*:\s*\{[^}]*enabled\s*:\s*true/.test(ctx.all)) return;
      if (!/(?:WebGL|WebGPU)Renderer/.test(ctx.all)) return;
      const f = ctx.three.find((x) => /\.(?:castShadow|receiveShadow)\s*=\s*true/.test(x.text));
      const m = f && /\.(?:castShadow|receiveShadow)\s*=\s*true/.exec(f.text);
      if (f && m) report(f, m.index);
    },
  },
  {
    id: "no-lights",
    category: "correctness",
    severity: "warn",
    title: "Lit materials but no light or environment",
    message: "The scene uses lit materials (Standard/Physical/Lambert/Phong/Toon) but no light, environment map or background environment is created, so meshes render black.",
    fix: "Add a light (new THREE.AmbientLight / DirectionalLight / HemisphereLight) or set scene.environment (for example from RoomEnvironment).",
    check(ctx, report) {
      const lit = /\b(?:MeshStandardMaterial|MeshPhysicalMaterial|MeshLambertMaterial|MeshPhongMaterial|MeshToonMaterial)\b/;
      const f = ctx.three.find((x) => lit.test(x.text));
      if (!f) return;
      if (/\b\w*Light\s*\(|\.environment\s*=|environment\s*:|RoomEnvironment|RGBELoader|HDRLoader|EXRLoader|PMREMGenerator|LightProbe/.test(ctx.all)) return;
      // a model loader may bring its own lights via KHR_lights_punctual, so only warn without loaders
      if (/GLTFLoader|FBXLoader|ColladaLoader|OBJLoader/.test(ctx.all)) return;
      report(f, f.text.search(lit));
    },
  },
  {
    id: "camera-near-zero",
    category: "correctness",
    severity: "error",
    title: "Camera near plane is 0",
    message: "A perspective camera with near = 0 breaks the depth buffer (z-fighting or nothing visible).",
    fix: "Use a small positive near such as 0.1 and keep far/near below about 1e6.",
    check(ctx, report) {
      each(ctx, /PerspectiveCamera\s*\(\s*[^,()]+,\s*[^,()]+,\s*0(?:\.0+)?\s*[,)]|camera\.near\s*=\s*0(?:\.0+)?\s*;/, report);
    },
  },
  {
    id: "controls-damping-no-update",
    category: "correctness",
    severity: "warn",
    title: "Damping is on but controls.update() is never called",
    message: "`enableDamping` only works when controls.update() runs every frame.",
    fix: "Call controls.update() inside the animation loop.",
    check(ctx, report) {
      if (/\b(?:controls|orbit|trackball|fly|pointerlock|transform)\w*\.update\s*\(/i.test(ctx.all)) return;
      each(ctx, /\.enableDamping\s*=\s*true|enableDamping\s*:\s*true/, report);
    },
  },
  {
    id: "renderer-not-attached",
    category: "correctness",
    severity: "error",
    title: "Renderer canvas is never added to the page",
    message: "A renderer is created but `renderer.domElement` is never appended and no `canvas` option is given, so nothing shows.",
    fix: "document.body.appendChild(renderer.domElement) or pass { canvas } to the renderer.",
    check(ctx, report) {
      const f = ctx.three.find((x) => /new\s+(?:\w+\.)?(?:WebGL|WebGPU)Renderer\s*\(/.test(x.text));
      if (!f) return;
      if (/\.domElement\b|canvas\s*[:,}]|\bcanvas\s*\)/.test(ctx.all) || /<canvas/.test(ctx.files.map((x) => x.raw).join("\n"))) return;
      report(f, f.text.search(/new\s+(?:\w+\.)?(?:WebGL|WebGPU)Renderer\s*\(/));
    },
  },
  {
    id: "never-renders",
    category: "correctness",
    severity: "error",
    title: "Nothing ever calls render()",
    message: "A renderer is created but neither `renderer.render(...)` nor `setAnimationLoop` / a render pipeline is used, so no frame is drawn.",
    fix: "Call renderer.render(scene, camera) in your animation loop, or use renderer.setAnimationLoop(...).",
    check(ctx, report) {
      const f = ctx.three.find((x) => /new\s+(?:\w+\.)?(?:WebGL|WebGPU)Renderer\s*\(/.test(x.text));
      if (!f) return;
      if (/\.render\s*\(|setAnimationLoop|\.renderAsync\s*\(|EffectComposer|RenderPipeline|PostProcessing/.test(ctx.all)) return;
      report(f, f.text.search(/new\s+(?:\w+\.)?(?:WebGL|WebGPU)Renderer\s*\(/));
    },
  },
  {
    id: "resize-no-projection",
    category: "correctness",
    severity: "error",
    title: "aspect changes without updateProjectionMatrix()",
    message: "`camera.aspect` is assigned but `camera.updateProjectionMatrix()` is never called, so the picture stays stretched.",
    fix: "After changing aspect (or fov/near/far) call camera.updateProjectionMatrix().",
    check(ctx, report) {
      if (/updateProjectionMatrix/.test(ctx.all)) return;
      each(ctx, /\.aspect\s*=(?!=)/, report);
    },
  },
  {
    id: "webgpu-no-init",
    category: "correctness",
    severity: "warn",
    title: "WebGPURenderer used without await renderer.init()",
    message: "WebGPURenderer is asynchronous. Calling render() before init has finished fails or draws nothing.",
    fix: "await renderer.init() before the first render(), or drive frames with renderer.setAnimationLoop().",
    check(ctx, report) {
      if (/\.init\s*\(\s*\)|setAnimationLoop/.test(ctx.all)) return;
      each(ctx, /new\s+(?:\w+\.)?WebGPURenderer\s*\(/, report);
    },
  },
  {
    id: "cdn-unpinned",
    category: "correctness",
    severity: "warn",
    title: "three.js loaded from a CDN without a version",
    message: "Loading `three` from a CDN without a pinned version breaks the page whenever a release changes the API.",
    fix: "Pin it: https://cdn.jsdelivr.net/npm/three@0.187.0/build/three.module.js (and the same version for addons).",
    check(ctx, report) {
      for (const f of ctx.files) {
        for (const m of f.text.matchAll(/(?:unpkg\.com|cdn\.jsdelivr\.net\/npm|esm\.sh)\/three(?![@\w-])/g)) report(f, m.index ?? 0);
      }
    },
  },
  {
    id: "types-mismatch",
    category: "correctness",
    severity: "warn",
    title: "three and @types/three versions differ",
    message: "`three` and `@types/three` should have the same minor version, or the types describe an API that is not installed.",
    fix: "Install matching versions: npm i three@X.Y.Z @types/three@X.Y.Z.",
    check(ctx, report) {
      const d = { ...ctx.packageJson?.dependencies, ...ctx.packageJson?.devDependencies };
      const t = /(\d+)\.(\d+)/.exec(d["three"] ?? "");
      const y = /(\d+)\.(\d+)/.exec(d["@types/three"] ?? "");
      const f = ctx.three[0];
      if (t && y && f && t[2] !== y[2]) report(f, 0, { message: `three is ${d["three"]} but @types/three is ${d["@types/three"]}.` });
    },
  },

  // ---- performance ----
  {
    id: "alloc-in-loop",
    category: "performance",
    severity: "warn",
    title: "Math objects allocated every frame",
    message: "A Vector/Matrix/Quaternion/Color is created with `new` inside the per-frame loop. That produces garbage every frame and causes stutter from garbage collection.",
    fix: "Create the object once outside the loop (const _v = new THREE.Vector3()) and reuse it with .set()/.copy().",
    check(ctx, report) {
      inLoops(ctx, new RegExp(String.raw`new\s+(?:(?:\w+)\.)?(${ALLOC})\s*\(`), report);
    },
  },
  {
    id: "create-heavy-in-loop",
    category: "performance",
    severity: "error",
    title: "Geometry/material/loader created every frame",
    message: "A geometry, material, loader or renderer is created inside the per-frame loop. This leaks GPU memory and recompiles shaders each frame.",
    fix: "Create it once at startup and reuse it; change properties or transforms in the loop instead.",
    check(ctx, report) {
      inLoops(ctx, new RegExp(String.raw`new\s+(?:\w+\.)?(${HEAVY})\s*\(`), report);
    },
  },
  {
    id: "traverse-in-loop",
    category: "performance",
    severity: "warn",
    title: "Scene search every frame",
    message: "`traverse`, `getObjectByName` or `getObjectByProperty` runs inside the per-frame loop and walks the whole scene graph each frame.",
    fix: "Find the object once, keep a reference, and use it in the loop.",
    check(ctx, report) {
      inLoops(ctx, /\.(traverse|getObjectByName|getObjectByProperty|getObjectById)\s*\(/, report);
    },
  },
  {
    id: "pixel-ratio-uncapped",
    category: "performance",
    severity: "warn",
    title: "Pixel ratio is not capped",
    message: "`setPixelRatio(devicePixelRatio)` renders up to 9-16x the pixels on high-density screens.",
    fix: "renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));",
    check(ctx, report) {
      each(ctx, /setPixelRatio\s*\(\s*(?:window\.)?devicePixelRatio\s*\)/, report);
    },
  },
  {
    id: "shadow-map-huge",
    category: "performance",
    severity: "warn",
    title: "Shadow map larger than 4096",
    message: "Shadow maps above 4096 cost a lot of memory and fill rate and are not supported on every GPU.",
    fix: "Use 2048 or 4096 and tighten the light's shadow camera bounds instead.",
    check(ctx, report) {
      each(ctx, /mapSize\.(?:width|height)\s*=\s*(\d+)/, report, (m) => Number(m[1]) > 4096);
    },
  },
  {
    id: "many-meshes-no-instancing",
    category: "performance",
    severity: "warn",
    title: "Hundreds of Meshes created in a loop",
    message: "A loop of 500 or more iterations creates individual Mesh objects. Each is its own draw call.",
    fix: "Use THREE.InstancedMesh (one draw call) or BatchedMesh for differing geometry.",
    check(ctx, report) {
      for (const f of ctx.three) {
        for (const m of f.text.matchAll(/for\s*\([^;)]*;[^;)]*<=?\s*(\d{3,})\s*;[^)]*\)\s*\{/g)) {
          if (Number(m[1]) < 500) continue;
          const b = blockAt(f.text, (m.index ?? 0) + m[0].length - 1);
          if (b && new RegExp(`new\\s+${ns(f)}?Mesh\\s*\\(`).test(f.text.slice(b.start, b.end)) && !/Instanced/.test(f.text.slice(b.start, b.end))) report(f, m.index ?? 0);
        }
      }
    },
  },
  {
    id: "animation-loop",
    category: "performance",
    severity: "info",
    title: "requestAnimationFrame instead of setAnimationLoop",
    message: "`renderer.setAnimationLoop` is the supported loop: it also runs in WebXR and pauses correctly.",
    fix: "renderer.setAnimationLoop((time) => { ...; renderer.render(scene, camera); });",
    check(ctx, report) {
      if (/setAnimationLoop/.test(ctx.all)) return;
      each(ctx, /requestAnimationFrame\s*\(/, report);
    },
  },

  // ---- lifecycle ----
  {
    id: "no-resize-handling",
    category: "lifecycle",
    severity: "warn",
    title: "Canvas never follows the window size",
    message: "A renderer and camera exist but nothing reacts to a resize (no resize listener or ResizeObserver).",
    fix: "On resize: camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);",
    check(ctx, report) {
      const f = ctx.three.find((x) => /new\s+(?:\w+\.)?(?:WebGL|WebGPU)Renderer\s*\(/.test(x.text));
      if (!f || !/PerspectiveCamera|OrthographicCamera/.test(ctx.all)) return;
      if (/['"]resize['"]|ResizeObserver|\.onresize\b/.test(ctx.all)) return;
      // a fixed-size canvas on purpose: setSize with literal numbers and no use of the window size
      if (/setSize\s*\(\s*\d+\s*,\s*\d+/.test(ctx.all) && !/innerWidth|clientWidth/.test(ctx.all)) return;
      report(f, f.text.search(/new\s+(?:\w+\.)?(?:WebGL|WebGPU)Renderer\s*\(/));
    },
  },
  {
    id: "no-dispose",
    category: "lifecycle",
    severity: "warn",
    title: "Objects are removed but never disposed",
    message: "Objects are removed from the scene, but `dispose()` is never called. Geometries, materials and textures stay in GPU memory.",
    fix: "Call geometry.dispose(), material.dispose() and texture.dispose() when you remove an object for good (and renderer.dispose() on teardown).",
    check(ctx, report) {
      if (/\.dispose\s*\(/.test(ctx.all)) return;
      for (const f of ctx.three) {
        const m = /\b(?:scene|group|\w*[gG]roup|\w*[sS]cene)\.(?:remove|clear)\s*\(/.exec(f.text);
        if (m) {
          report(f, m.index);
          return;
        }
      }
    },
  },
  {
    id: "texture-colorspace-missing",
    category: "color",
    severity: "warn",
    title: "Color textures without colorSpace",
    message: "Textures loaded with TextureLoader are used as color maps but `colorSpace` is never set, so colors look washed out or too dark.",
    fix: "texture.colorSpace = THREE.SRGBColorSpace; (not for normal/roughness/metalness data maps).",
    introducedIn: 152,
    check(ctx, report) {
      if (/colorSpace/.test(ctx.all)) return;
      for (const f of ctx.three) {
        if (!/TextureLoader/.test(f.text)) continue;
        const m = /\bmap\s*:|\.map\s*=(?!=)|\bemissiveMap\b/.exec(f.text);
        if (m) {
          report(f, m.index);
          return;
        }
      }
    },
  },
  {
    id: "color-management-off",
    category: "color",
    severity: "warn",
    title: "Color management is switched off",
    message: "`ColorManagement.enabled = false` disables the conversion between sRGB and linear and breaks lighting accuracy.",
    fix: "Remove the line (the default is true) and fix texture color spaces instead.",
    check(ctx, report) {
      each(ctx, /ColorManagement\.enabled\s*=\s*false/, report);
    },
  },
];

function addonFileExists(root: string, rel: string): boolean {
  return existsSync(join(root, "examples", "jsm", rel));
}
