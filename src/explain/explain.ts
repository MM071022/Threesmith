import type { ApiIndex } from "../api/index-builder.js";
import { suggest } from "../api/lookup.js";

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
