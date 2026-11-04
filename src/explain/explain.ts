import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiIndex } from "../api/index-builder.js";
import { levenshtein, resolve, suggest } from "../api/lookup.js";
import { CHUNK_HISTORY, shaderChunks } from "../review/parse.js";

/**
 * Explains runtime errors and warnings of three.js pages: what usually causes them and what to do. Agents see these
 * messages in the console, a test run or the headless check, and mostly guess; these are the causes real projects hit.
 */
export interface Explanation {
  id: string;
  title: string;
  cause: string;
  fix: string;
  /** Extra facts filled in from the message (the name that was not found, the right import path, ...). */
  detail?: string;
}

interface Pattern {
  id: string;
  re: RegExp;
  title: string;
  cause: string;
  fix: string;
  detail?: (m: RegExpExecArray, index?: ApiIndex) => string | undefined;
}

const where = (index: ApiIndex | undefined, name: string): string | undefined => {
  if (!index) return undefined;
  const ref = index.exports.get(name);
  if (ref) return `\`${name}\` exists in three r${index.install.release}: import { ${name} } from '${ref.importPath}';`;
  const s = suggest(index, name);
  return `\`${name}\` does not exist in three r${index.install.release}.${s.length ? ` Did you mean ${s.map((x) => "`" + x + "`").join(", ")}?` : ""}`;
};

/** What an unknown `#include <name>` became, from the chunk history and the installed chunk list. */
const chunkDetail = (index: ApiIndex | undefined, name: string): string | undefined => {
  const h = CHUNK_HISTORY[name];
  if (h) return `\`${name}\` ${h.to ? `was renamed to \`${h.to}\`` : "was removed"} in r${h.release}${h.note ? ` (${h.note})` : ""}.`;
  const chunks = index && shaderChunks(index.install.root);
  if (!chunks || !index) return undefined;
  if (chunks.has(name)) return `\`${name}\` exists in three r${index.install.release}; check that the page loads the same three version.`;
  const close = [...chunks].filter((c) => levenshtein(c, name, 4) <= 4).sort((a, b) => levenshtein(a, name, 4) - levenshtein(b, name, 4)).slice(0, 3);
  return `\`${name}\` is not a shader chunk of three r${index.install.release}.${close.length ? ` Did you mean ${close.map((c) => "`" + c + "`").join(", ")}?` : ""}`;
};

/** `this.x =` fields of a material class and its parents, read from the installed source. */
function materialFields(root: string, cls: string): string[] {
  const out = new Set<string>();
  for (let name: string | undefined = cls, depth = 0; name && depth < 6; depth++) {
    const p = join(root, "src", "materials", `${name}.js`);
    if (!existsSync(p)) break;
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(/\bthis\.([a-zA-Z]\w*)\s*=(?!=)/g)) if (!(m[1] ?? "").startsWith("is")) out.add(m[1] as string);
    name = new RegExp(String.raw`class\s+${name}\s+extends\s+(\w+)`).exec(src)?.[1];
  }
  return [...out];
}

/** The closest real property of a material, for "'x' is not a property of THREE.Y". */
const propertyDetail = (index: ApiIndex | undefined, prop: string, cls: string): string | undefined => {
  if (!index) return undefined;
  const r = resolve(index, cls);
  let props = r ? [...new Set(r.members.filter((m) => m.kind === "property" || m.kind === "setter" || m.kind === "getter").map((m) => m.name))] : [];
  if (!props.length) props = materialFields(index.install.root, cls);
  if (!props.length) return undefined;
  const close = props.filter((p) => levenshtein(p.toLowerCase(), prop.toLowerCase(), 3) <= 3).sort((a, b) => levenshtein(a, prop, 3) - levenshtein(b, prop, 3)).slice(0, 3);
  return close.length ? `${cls} has ${close.map((c) => "`" + c + "`").join(", ")}.` : `${cls} has no property like \`${prop}\`; three_api ${cls} lists them.`;
};

const PATTERNS: Pattern[] = [
  {
    id: "export-not-found",
    re: /does not provide an export named '([\w$]+)'/,
    title: "Import of a name the module does not export",
    cause: "The name is imported from the wrong module (an addon from 'three', a WebGPU class from 'three', or a name that was removed or renamed in this release).",
    fix: "Import it from where it lives (addons: 'three/addons/...', WebGPU and node materials: 'three/webgpu'). Look it up with three_api.",
    detail: (m, index) => where(index, m[1] ?? ""),
  },
  {
    id: "not-a-constructor",
    re: /(?:THREE\.)?([A-Z][\w$]*) is not a constructor/,
    title: "A three.js class that is not there",
    cause: "The class was removed or renamed (Geometry, Face3, *BufferGeometry), or it is an addon used as THREE.X without importing it.",
    fix: "Use the current name and import addons explicitly. three_api tells whether it exists and where.",
    detail: (m, index) => where(index, m[1] ?? ""),
  },
  {
    id: "bare-specifier",
    re: /Failed to resolve module specifier "(three[^"]*)"|Relative references must start with/,
    title: "The browser cannot resolve 'three'",
    cause: "The page uses ES module imports of 'three' without a bundler and without an import map.",
    fix: 'Add <script type="importmap">{"imports":{"three":"<path>/three.module.js","three/addons/":"<path>/examples/jsm/"}}</script> before the module script, or build with Vite.',
  },
  {
    id: "multiple-instances",
    re: /Multiple instances of Three\.js being imported/,
    title: "Two copies of three.js are loaded",
    cause: "Addons resolve 'three' to a different file than your code (CDN and node_modules mixed, or two versions installed). instanceof checks then fail and objects silently do not render.",
    fix: "Make every 'three' import resolve to one file: one import map entry, the same version for 'three' and 'three/addons/', `npm ls three` shows duplicates (dedupe them).",
  },
  {
    id: "undefined-geometry",
    re: /Cannot read propert(?:y|ies) of (?:undefined|null) \(reading '(isBufferGeometry|attributes|boundingSphere|index|groups|morphAttributes)'\)/,
    title: "A Mesh without a geometry",
    cause: "A Mesh, Points or Line got undefined as its geometry (a typo, or a geometry from a model that was not loaded yet).",
    fix: "Check the variable you pass to new THREE.Mesh(); for loaded models, create the mesh inside the load callback or after `await loader.loadAsync(url)`.",
  },
  {
    id: "used-before-load",
    re: /Cannot read propert(?:y|ies) of (?:undefined|null) \(reading '(scene|animations|position|rotation|scale|traverse|add|material|children)'\)/,
    title: "An object used before it exists",
    cause: "Most often a model from GLTFLoader used outside its callback: loading is asynchronous, so the variable is still undefined on the first frames.",
    fix: "Use `const gltf = await new GLTFLoader().loadAsync(url)` before starting the loop, or guard the code in the loop until the model is there.",
  },
  {
    id: "html-instead-of-model",
    re: /Unexpected token '?<'?|JSON\.parse: unexpected character|is not valid JSON|Invalid typed array length|Unsupported asset|glTF versions >=2\.0 are supported|Unexpected end of JSON input/,
    title: "A model or JSON file that is not what it claims to be",
    cause: "The URL returned an HTML page (a 404 page or the dev server's index.html) instead of the .gltf/.glb/.json file.",
    fix: "Fix the path (relative to the HTML page, or put the file in the public/ folder with Vite). The headless check lists failed requests with their URL.",
  },
  {
    id: "decoder-path",
    re: /(DRACOLoader|KTX2Loader|MeshoptDecoder)[^\n]*(?:decoder|transcoder|setDecoderPath|setTranscoderPath|not (?:set|found))|setDRACOLoader|setKTX2Loader|No DRACOLoader instance provided|setMeshoptDecoder must be called/,
    title: "A compressed model without its decoder",
    cause: "The model uses Draco, KTX2 or Meshopt compression, and the loader has no decoder configured.",
    fix: "new DRACOLoader().setDecoderPath('/draco/'), gltfLoader.setDRACOLoader(...); for KTX2: ktx2Loader.setTranscoderPath(...).detectSupport(renderer). Copy the decoder files from three/examples/jsm/libs/.",
  },
  {
    id: "nan-geometry",
    re: /computeBoundingSphere\(\): Computed radius is NaN|computeBoundingBox\(\): Computed min\/max have NaN values/,
    title: "NaN in vertex positions",
    cause: "The position attribute holds NaN: a division by zero or an undefined value when building the geometry.",
    fix: "Check the code that fills the Float32Array (and its length: itemSize 3 needs 3 numbers per vertex).",
  },
  {
    id: "context-lost",
    re: /CONTEXT_LOST_WEBGL|Context Lost|context lost/i,
    title: "The WebGL context was lost",
    cause: "The GPU ran out of memory or the browser reset it, often after creating many renderers or very large textures/render targets.",
    fix: "Create one renderer and reuse it; dispose() what you remove; keep textures at or below 4096; listen to 'webglcontextlost' to recover.",
  },
  {
    id: "too-many-contexts",
    re: /Too many active WebGL contexts/,
    title: "Too many WebGL contexts",
    cause: "A new WebGLRenderer is created repeatedly (each component mount, each frame or each scene) without dispose().",
    fix: "Create the renderer once. On teardown call renderer.dispose() and renderer.forceContextLoss().",
  },
  {
    id: "shader-error",
    re: /WebGLProgram: Shader Error|ERROR: 0:\d+:|Shader Error \d+ - VALIDATE_STATUS/,
    title: "A shader did not compile",
    cause: "GLSL error in a ShaderMaterial / RawShaderMaterial or in an onBeforeCompile patch.",
    fix: "Fix the line named below. WebGL 2 shaders in three use GLSL 3.00 ES via three's prefix: use `texture()` not `texture2D()` with RawShaderMaterial + glslVersion GLSL3, declare every uniform you use, and match types exactly (1.0 not 1 for floats).",
  },
  {
    id: "texture-no-image",
    re: /Texture marked for update but no image data found|Texture marked for update but image is incomplete/,
    title: "A texture flagged for upload before its image exists",
    cause: "texture.needsUpdate = true was set before the image finished loading.",
    fix: "Use TextureLoader (it sets needsUpdate itself), or set needsUpdate in the image's onload.",
  },
  {
    id: "cors",
    re: /Cross-Origin|CORS policy|tainted canvases|cross-origin/i,
    title: "A texture or model from another origin is blocked",
    cause: "The file is served from another domain without CORS headers.",
    fix: "Serve the file from your own origin, or from a host that sends Access-Control-Allow-Origin; TextureLoader sets crossOrigin='anonymous' already.",
  },
  {
    id: "file-protocol",
    re: /file:\/\/|ERR_FILE_NOT_FOUND|origin 'null' has been blocked/,
    title: "The page is opened as a file",
    cause: "ES modules, import maps and loaders do not work from file:// URLs.",
    fix: "Serve the folder over http (npx vite, npx serve, or threesmith check <folder>).",
  },
  {
    id: "webgpu-init",
    re: /WebGPURenderer: \.render\(\) called before the backend is initialized|Renderer: \.render\(\) called before the backend is initialized|renderAsync|before the backend is initialized|has not been initialized/,
    title: "WebGPURenderer used before init",
    cause: "WebGPURenderer initializes asynchronously; render() ran before that finished.",
    fix: "await renderer.init() before the first render(), or use renderer.setAnimationLoop(...), which waits for init.",
  },
  {
    id: "no-webgpu",
    re: /WebGPU is not available|navigator\.gpu is undefined|No available adapters|Unable to create WebGPU/i,
    title: "No WebGPU on this machine or browser",
    cause: "The browser, GPU or (in CI) the headless setup has no WebGPU adapter.",
    fix: "WebGPURenderer falls back to WebGL 2 by itself; do not require navigator.gpu. In CI, check with WebGL instead.",
  },
  {
    id: "include-not-resolved",
    re: /Can not resolve #include <([\w./]+)>/,
    title: "A shader includes a chunk that does not exist",
    cause: "A ShaderMaterial or onBeforeCompile patch uses `#include <name>` with a chunk this three version does not have (often a chunk renamed in a later release).",
    fix: "Use a name from THREE.ShaderChunk; three_fix renames encodings_fragment, encodings_pars_fragment and output_fragment.",
    detail: (m, index) => chunkDetail(index, m[1] ?? ""),
  },
  {
    id: "glsl-material-webgpu",
    re: /Material "(\w+)" is not compatible/,
    title: "A GLSL material under WebGPURenderer",
    cause: "WebGPURenderer only builds node materials; ShaderMaterial and RawShaderMaterial (GLSL) have no node version, so it draws a default material instead.",
    fix: "Rewrite the shader in TSL with a NodeMaterial (colorNode, positionNode, ...), or render with WebGLRenderer.",
  },
  {
    id: "not-a-property",
    re: /'([\w$]+)' is not a property of THREE\.([\w$]+)/,
    title: "A material option that does not exist",
    cause: "The option is misspelled, belongs to another material type, or was renamed (three ignores it and warns).",
    fix: "Use the material's real property name (three_api <Material> lists them).",
    detail: (m, index) => propertyDetail(index, m[1] ?? "", m[2] ?? ""),
  },
  {
    id: "add-not-object3d",
    re: /Object3D\.add: object not an instance of THREE\.Object3D/,
    title: "Something that is not an Object3D was added to the scene",
    cause: "Most often the glTF result (`scene.add(gltf)` instead of gltf.scene), TransformControls since r169 (add controls.getHelper()), a geometry or material, or an object from a second copy of three.",
    fix: "Add gltf.scene / controls.getHelper() / a Mesh; if it is a real Object3D, make every import resolve to one three (see multiple-instances).",
  },
  {
    id: "ktx2-detect-support",
    re: /KTX2Loader: Missing initialization with `?\.detectSupport/,
    title: "KTX2Loader used before detectSupport()",
    cause: "KTX2Loader picks a GPU texture format per device and needs the renderer for that.",
    fix: "ktx2Loader.detectSupport( renderer ) once after creating the renderer (after await renderer.init() with WebGPURenderer), then gltfLoader.setKTX2Loader( ktx2Loader ).",
  },
  {
    id: "needs-update-undefined",
    re: /Cannot set propert(?:y|ies) of undefined \(setting 'needsUpdate'\)|can't access property "needsUpdate"/,
    title: "needsUpdate set on something that does not exist",
    cause: "A ShaderMaterial with `lights: true` but without UniformsLib.lights in its uniforms (three sets needsUpdate on each light uniform), or code flagging a texture/attribute that is not there (material.map, geometry.attributes.color).",
    fix: "uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, { ... }]), or check that the texture/attribute exists before setting needsUpdate.",
  },
  {
    id: "controls-element",
    re: /Cannot set propert(?:y|ies) of undefined \(setting 'touchAction'\)|can't access property "touchAction"/,
    title: "Controls got something that is not an element",
    cause: "Controls were created with `document` (or another non-element) as their DOM element, so setting element.style.touchAction fails.",
    fix: "new OrbitControls( camera, renderer.domElement ).",
  },
  {
    id: "r3f-outside-canvas",
    re: /R3F: Hooks can only be used within the Canvas component/,
    title: "An R3F hook outside <Canvas>",
    cause: "useFrame, useThree or useLoader is called in a component that is not rendered inside <Canvas> (often the component that renders the Canvas itself).",
    fix: "Move the hook into a child component rendered inside <Canvas>.",
  },
  {
    id: "r3f-not-in-namespace",
    re: /R3F: ([\w$]+) is not part of the THREE namespace/,
    title: "A JSX element R3F does not know",
    cause: "Either HTML (<div>, <span>) inside <Canvas>, which only takes three objects, or a three class from an addon or library that was never registered.",
    fix: "Put HTML outside the Canvas or in drei's <Html>; register other classes with extend({ ClassName }) before using <className />.",
    detail: (m) => (/^(?:Div|Span|P|A|Button|Img|H[1-6]|Ul|Li|Section|Input|Label)$/.test(m[1] ?? "") ? `<${(m[1] ?? "").toLowerCase()}> is an HTML element: move it out of <Canvas> or wrap it in drei's <Html>.` : `Register it: import { ${m[1]} } from its module; extend({ ${m[1]} }).`),
  },
  {
    id: "import-outside-module",
    re: /Cannot use import statement outside a module/,
    title: "An ES module loaded as a classic script",
    cause: "A <script> without type=\"module\" contains `import` (three r161+ ships ES modules only), or Node runs the file as CommonJS.",
    fix: 'Use <script type="module"> (with an import map for \'three\'), or "type": "module" in package.json / an .mjs file for Node.',
  },
  {
    id: "feedback-loop",
    re: /Feedback loop formed between Framebuffer and active Texture/,
    title: "A render target reads its own texture",
    cause: "A material samples the texture of the render target it is being drawn into (for example a mirror or a ping-pong pass with one target).",
    fix: "Use two render targets and swap them each frame, or hide the object that uses the texture while rendering into the target.",
  },
  {
    id: "framebuffer-incomplete",
    re: /GL_INVALID_FRAMEBUFFER_OPERATION|Framebuffer is incomplete|FRAMEBUFFER_INCOMPLETE|Attachment has zero size/,
    title: "A render target that cannot be drawn into",
    cause: "The render target has size 0 (created before the canvas had a size), or a format/type the GPU cannot render to (float targets need EXT_color_buffer_float).",
    fix: "Give the render target a real size (setSize on resize), and prefer HalfFloatType over FloatType.",
  },
  {
    id: "invalid-operation",
    re: /WebGL: INVALID_OPERATION|GL_INVALID_OPERATION/,
    title: "WebGL rejected a call",
    cause: "Usually a texture whose format and type do not match (DataTexture data vs format/type), a uniform set with the wrong type, or a draw with attributes shorter than the index needs.",
    fix: "Check DataTexture format/type against its array, uniform types against the shader, and attribute lengths against the index; the headless check shows the first failing frame.",
  },
  {
    id: "texture-resized",
    re: /Texture has been resized from \((\d+)x(\d+)\) to \((\d+)x(\d+)\)/,
    title: "A texture larger than the GPU allows",
    cause: "The image is bigger than the GPU's maximum texture size, so three scaled it down on the CPU at load time.",
    fix: "Ship the texture at or below 4096 (2048 for mobile), ideally as KTX2.",
  },
  {
    id: "no-target-node",
    re: /PropertyBinding: No target node found for track: ([^\s]+?)\.?$/m,
    title: "An animation track that matches no object",
    cause: "The clip was made for another model or rig, or node names changed (three sanitizes names: spaces and dots become underscores).",
    fix: "Play clips on the model they came from, or rename the tracks to the target's node names (THREE.PropertyBinding.sanitizeNodeName).",
  },
  {
    id: "webgl-unavailable",
    re: /Error creating WebGL context|A WebGL context could not be created/,
    title: "No WebGL context",
    cause: "The browser or machine has WebGL disabled or blocklisted (or, in CI, runs without GPU emulation), or too many contexts are open.",
    fix: "Check chrome://gpu; in CI use the headless check (SwiftShader); create one renderer and dispose old ones.",
  },
  {
    id: "addon-deprecated",
    re: /(?:^|\s)([A-Z][\w$]*) has been deprecated\. Please use ([A-Z][\w$]*) instead/m,
    title: "An addon that was renamed",
    cause: "The addon class was replaced (RGBELoader by HDRLoader in r180, USDZLoader by USDLoader in r179).",
    fix: "Import the new class; three_fix rewrites RGBELoader to HDRLoader.",
    detail: (m, index) => where(index, m[2] ?? ""),
  },
  {
    id: "deprecated",
    re: /THREE\.([\w$]+):[^\n]*(?:deprecated|has been renamed|has been removed|is now|no longer)/i,
    title: "three.js says an API is deprecated or renamed",
    cause: "The code uses an API from an older release.",
    fix: "Run three_fix (pure renames) and three_review; look the new name up with three_api.",
    detail: (m, index) => (m[1] ? where(index, m[1]) : undefined),
  },
];

export function explain(message: string, index?: ApiIndex): Explanation[] {
  const out: Explanation[] = [];
  for (const p of PATTERNS) {
    const m = p.re.exec(message);
    if (!m) continue;
    const detail = p.detail?.(m, index);
    out.push({ id: p.id, title: p.title, cause: p.cause, fix: p.fix, ...(detail ? { detail } : {}) });
  }
  // "used before load" is a looser form of the geometry case; keep the more specific one only
  if (out.some((e) => e.id === "undefined-geometry")) return out.filter((e) => e.id !== "used-before-load");
  return out;
}

export interface ShaderError {
  stage: "vertex" | "fragment" | "unknown";
  /** Line in the shader that three compiled (with three's prefix). */
  line: number;
  message: string;
  /** The code on that line, as three printed it. */
  code?: string;
}

/** Read the errors out of three's "WebGLProgram: Shader Error" console message. */
export function parseShaderErrors(text: string): ShaderError[] {
  const out: ShaderError[] = [];
  const blocks = text.split(/\n(?=(?:VERTEX|FRAGMENT)\n)/);
  for (const block of blocks) {
    const stage = block.startsWith("VERTEX") ? "vertex" : block.startsWith("FRAGMENT") ? "fragment" : "unknown";
    const marked = /^>\s*(\d+):\s?(.*)$/m.exec(block);
    for (const m of block.matchAll(/ERROR: \d+:(\d+): (.+)/g)) {
      const line = Number(m[1]);
      out.push({
        stage,
        line,
        message: (m[2] ?? "").trim(),
        ...(marked && Number(marked[1]) === line ? { code: (marked[2] ?? "").trim() } : {}),
      });
    }
  }
  return out;
}

export function formatExplanations(list: Explanation[]): string {
  if (!list.length) return "No known three.js cause for this message. Look up the names in it with three_api, and run three_review.";
  return list
    .map((e) => [`${e.title} [${e.id}]`, `  cause: ${e.cause}`, `  fix: ${e.fix}`, ...(e.detail ? [`  ${e.detail}`] : [])].join("\n"))
    .join("\n\n");
}
