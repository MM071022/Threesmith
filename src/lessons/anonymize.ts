import { bundledLessons } from "./library.js";

/**
 * Makes free text safe to keep as a lesson: no names, paths, links, e-mail addresses, codes, keys or source code.
 * What is left is three.js vocabulary and plain words. The bundled lessons follow the same rules (a test runs every
 * one of them through this and expects it unchanged), so a lesson learned on one machine says nothing about a person
 * or a project.
 */

export interface Scrubbed {
  text: string;
  /** What was replaced, by kind (name, path, file, url, email, code, n, date). */
  replaced: Record<string, number>;
}

export interface ScrubContext {
  /** Extra names that are no one's own, such as the exports and members of the installed three. */
  knownNames?: Iterable<string>;
  /** Names of the project (components, files, its own name): replaced wherever they appear. */
  projectNames?: Iterable<string>;
}

/** three.js classes, members and constants, and the R3F and drei names lessons talk about. */
const THREE_NAMES = new Set(
  `THREE Object3D Scene Group Mesh SkinnedMesh InstancedMesh BatchedMesh Points Line LineSegments LineLoop Sprite Bone
  Skeleton Camera PerspectiveCamera OrthographicCamera CubeCamera ArrayCamera WebGLRenderer WebGPURenderer
  WebGLRenderTarget RenderTarget Raycaster Timer Clock Color ColorManagement MathUtils Vector2 Vector3 Vector4
  Quaternion Euler Matrix3 Matrix4 Box3 Sphere Plane Ray Frustum Spherical BufferGeometry BufferAttribute
  Float32BufferAttribute InstancedBufferAttribute BoxGeometry PlaneGeometry SphereGeometry CylinderGeometry
  CapsuleGeometry TorusGeometry ExtrudeGeometry ShapeGeometry TubeGeometry TextGeometry Geometry Face3
  BoxBufferGeometry PlaneBufferGeometry Material MeshBasicMaterial MeshStandardMaterial MeshPhysicalMaterial
  MeshLambertMaterial MeshPhongMaterial MeshToonMaterial MeshNormalMaterial MeshMatcapMaterial ShaderMaterial
  RawShaderMaterial LineBasicMaterial LineMaterial PointsMaterial SpriteMaterial ShadowMaterial NodeMaterial
  Texture CanvasTexture VideoTexture DataTexture CubeTexture DepthTexture CompressedTexture Light AmbientLight
  HemisphereLight DirectionalLight PointLight SpotLight RectAreaLight LightProbe CameraHelper AxesHelper
  GridHelper Box3Helper AnimationMixer AnimationClip AnimationAction PropertyBinding Loader LoadingManager
  TextureLoader FileLoader ImageLoader ImageBitmapLoader GLTFLoader DRACOLoader KTX2Loader MeshoptDecoder
  FBXLoader OBJLoader MTLLoader HDRLoader RGBELoader EXRLoader FontLoader Font OrbitControls MapControls
  TrackballControls PointerLockControls TransformControls FlyControls Controls EffectComposer RenderPass
  OutputPass ShaderPass UnrealBloomPass GammaCorrectionShader RenderPipeline PostProcessing PMREMGenerator
  RoomEnvironment Line2 LineGeometry LineSegments2 SkeletonUtils BufferGeometryUtils WebGL WebGL2 WebGPU
  SRGBColorSpace LinearSRGBColorSpace NoColorSpace NoToneMapping ACESFilmicToneMapping AgXToneMapping
  NeutralToneMapping LinearToneMapping ReinhardToneMapping PCFShadowMap PCFSoftShadowMap VSMShadowMap
  BasicShadowMap DoubleSide FrontSide BackSide LoopOnce LoopRepeat GLSL3 sRGBEncoding LinearEncoding
  Float32Array Uint16Array Uint32Array Int32Array Canvas Html Suspense Clone Environment OrbitControls
  useFrame useThree useLoader useGLTF useMemo useRef useEffect useState invalidate extend
  KHR_draco_mesh_compression KHR_texture_basisu EXT_meshopt_compression
  add remove clone copy set dispose render traverse lookAt update play load loadAsync parse compile compileAsync
  setSize setPixelRatio setAnimationLoop setClearColor setMatrixAt setColorAt getMatrixAt setDrawRange
  setFromObject setFromPoints getCenter getSize getWorldPosition updateProjectionMatrix updateMatrixWorld
  computeBoundingSphere computeBoundingBox computeVertexNormals setAttribute setIndex getAttribute
  getObjectByName getObjectByProperty getBoundingClientRect getContext getDelta getElapsedTime
  intersectObject intersectObjects setFromCamera forceContextLoss setDecoderPath setTranscoderPath
  setDRACOLoader setKTX2Loader setMeshoptDecoder detectSupport detectSupportAsync listenToKeyEvents connect
  disconnect fromScene fromEquirectangular crossFadeTo findByName setLoop setHex setStyle degToRad radToDeg
  mergeGeometries mergeAttributes sanitizeNodeName applyMatrix4 toDataURL preventDefault stopPropagation
  clearDepth clear init dedupe overrides importmap clientX clientY clientWidth clientHeight devicePixelRatio
  domElement outputColorSpace outputEncoding colorSpace encoding toneMapping toneMapped shadowMap castShadow
  receiveShadow needsUpdate instanceMatrix instanceColor frustumCulled boundingSphere depthWrite depthTest
  renderOrder alphaTest alphaToCoverage transparent opacity polygonOffset polygonOffsetFactor
  logarithmicDepthBuffer reversedDepthBuffer preserveDrawingBuffer autoClear flipY mapSize normalBias bias
  enableDamping clampWhenFinished userData isMesh emissiveMap normalMap roughnessMap metalnessMap aoMap
  displacementMap alphaMap colorNode positionNode onBeforeCompile customProgramCacheKey glslVersion
  isWebGPUBackend forceWebGL useLegacyLights physicallyCorrectLights gammaOutput transpilePackages
  crossOrigin linewidth sizeAttenuation uniforms uTime colorspace_fragment tonemapping_fragment BASE_URL PI min max
  ReactCurrentOwner onLoad NaN Div texture2D gl_FragColor gl_Position boxGeometry planeGeometry meshStandardMaterial primitive`.split(/\s+/).filter(Boolean),
);

/** Words written with a capital or in camelCase that are tools, platforms, formats or web terms, not names. */
const TECH_WORDS = new Set(
  `three three.js threejs threesmith webgl webgl2 webgpu wgsl glsl tsl gltf glb fbx obj draco ktx2 basis meshopt
  gltfpack gltf-transform hdr exr png jpg jpeg webp svg wasm json html css dom cdn unpkg jsdelivr esm cjs ssr spa
  vite webpack rollup esbuild parcel next.js nextjs next nuxt react react-dom vue svelte angular r3f fiber drei rapier
  javascript typescript node node.js npm pnpm yarn chrome chromium firefox safari edge swiftshader blender github
  pages netlify vercel cors gpu cpu fps srgb rgb pbr aces agx hdri ios android macos windows linux mac claude codex
  cursor copilot gemini bolt lovable playwright vitest jest moire peter mozilla moz khronos basis-universal
  gltf-pipeline webassembly commonjs node_modules phong access allow origin control content wsl ui ux hud vr xr webxr ao ssao msaa fxaa smaa taa lod ndc mime http https url urls api apis
  sdk cli id ids ok wi-fi uv uvs rgba mb gb kb hz`.split(/\s+/).filter(Boolean),
);

/** JavaScript words: the language, not anyone's code. */
const LANGUAGE_WORDS = new Set(
  `const let var function return import export from default class extends new this super async await null undefined
  true false typeof instanceof void yield static get set of in if else for while do switch case break continue try
  catch finally throw window document self navigator console instanceof globalThis requestAnimationFrame
  addEventListener removeEventListener ResizeObserver Promise Math Error TypeError ReferenceError SyntaxError RangeError
  DOMException`.split(/\s+/).filter(Boolean),
);

/** English words that often start a sentence in a lesson. The rest comes from the words the bundled lessons use. */
const STARTS = new Set(
  `a an the use set call check add keep make do don't never always when if this that these those after before with
  without in on each every load give put wrap move pass read turn open run serve import pick copy clone raise lower
  scale compute mark remove dispose create look find log show hide write declare return take switch install match
  test start stop tune prefer leave delete export convert host change render draw guard swap reset let lessons
  most some many both any only one two it its they there here what why how where which who but and or so then
  since until while because once no unexpected failed lift bring circles handle ask shrink cap low allocate regular
  tear walk multiply port common addon animated normalized uncaught warning error couldn't can't don't doesn't isn't won't`.split(/\s+/).filter(Boolean),
);

/** Files that every web project has: not a name of anyone's project. */
const COMMON_FILES = new Set(
  `package.json package-lock.json tsconfig.json index.html index.js main.js main.ts vite.config.js vite.config.ts
  next.config.js next.config.mjs webpack.config.js three.module.js three.core.js three.webgpu.js three.tsl.js
  three.js three.min.js draco_decoder.wasm draco_decoder.js draco_wasm_wrapper.js basis_transcoder.wasm
  basis_transcoder.js meshopt_decoder.module.js`.split(/\s+/).filter(Boolean),
);

/** Folder names that say nothing about a project: package folders of three and the usual web layout. */
const GENERIC_SEGMENTS = new Set(
  `three @react-three fiber drei examples jsm js libs addons loaders controls postprocessing utils lines geometries
  environments objects renderers shaders tsl webgpu build src dist public assets static models textures images
  draco basis node_modules next dynamic app pages components scene model`.split(/\s+/).filter(Boolean),
);

const FILE_EXT =
  "js|mjs|cjs|ts|tsx|jsx|vue|svelte|json|html|css|glb|gltf|bin|fbx|obj|mtl|blend|png|jpe?g|webp|ktx2|basis|hdr|exr|svg|wasm|glsl|wgsl|frag|vert|map|txt|md|log|zip|py|sh|ps1|bat|exe|dll|so|dylib|yml|yaml|toml|xml|csv";

/** Units after a number (`16ms`, `4k`, `1080p`, `120hz`): a measurement, not a code. */
const UNIT = /^\d+(?:[.,]\d+)?(?:k|m|km|cm|mm|kg|g|s|ms|us|ns|h|min|hz|fps|px|vh|vw|em|rem|mb|gb|kb|mib|gib|x|d|deg|p|bit|bits|st|nd|rd|th)$/i;

/** Tokens with digits that are words of the trade. */
const TECH_CODES =
  /^(?:r\d{2,3}|[1-4]d|0x[0-9a-f]{1,8}|webgl[12]?|glsl[1-3]|es[56]|es20\d\d|float(?:16|32|64)|u?int(?:8|16|32)|utf-?(?:8|16)|x86(?:_64)?|arm64|ktx2|h26[45]|vp[89]|av1|sha(?:1|256)|md5|vector[234]|matrix[34]|box[23]|object3d|line2|mp[34]|http2|v\d{1,2})$/i;

let english: Set<string> | undefined;

/** Lowercase words of the bundled lessons plus common sentence starts: a capitalized one of them starting a sentence is no name. */
function englishWords(): Set<string> {
  if (english) return english;
  const words = new Set(STARTS);
  for (const l of bundledLessons()) {
    for (const t of [l.title, l.symptom, l.cause, l.fix, l.test ?? "", ...l.tags]) for (const w of t.match(/\b[a-z][a-z']+\b/g) ?? []) words.add(w);
  }
  english = words;
  return words;
}

/** True for a word of the vocabulary or a plain inflection of one (flickering, placed, circles, quickly). */
function englishForm(word: string, words: Set<string>): boolean {
  if (words.has(word)) return true;
  for (const [end, add] of [["s", ""], ["es", ""], ["ed", ""], ["ed", "e"], ["d", ""], ["ing", ""], ["ing", "e"], ["ly", ""]] as const) {
    if (!word.endsWith(end) || word.length - end.length < 3) continue;
    const stem = word.slice(0, -end.length) + add;
    if (words.has(stem)) return true;
    // A doubled last letter: "stopped", "setting".
    if (add === "" && /(\w)\1$/.test(stem) && words.has(stem.slice(0, -1))) return true;
  }
  return false;
}

function known(context: ScrubContext): (name: string) => boolean {
  const extra = new Set(context.knownNames ?? []);
  return (name: string) => {
    const bare = name.replace(/\(\)$/, "");
    const one = (n: string) => THREE_NAMES.has(n) || extra.has(n) || TECH_WORDS.has(n.toLowerCase()) || LANGUAGE_WORDS.has(n);
    if (one(bare) || (/[a-z]s$/.test(bare) && one(bare.slice(0, -1)))) return true;
    // THREE.SRGBColorSpace, renderer.shadowMap.enabled: every part known, or a lowercase plain word.
    const parts = bare.split(".");
    return parts.length > 1 && parts.every((p) => THREE_NAMES.has(p) || extra.has(p) || /^[a-z]+$/.test(p));
  };
}

/** True for a name that belongs to three.js, R3F, drei or the web platform (and so is no one's own). */
export function isKnownName(name: string, context: ScrubContext = {}): boolean {
  return known(context)(name);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A path made only of package and layout folders (three/addons/loaders/GLTFLoader.js) is not anyone's. */
function genericPath(path: string, isKnown: (n: string) => boolean): boolean {
  const parts = path.replace(/^\.{0,2}\//, "").split(/[\\/]/).filter(Boolean);
  if (!parts.length) return false;
  return parts.every((p, i) => {
    if (GENERIC_SEGMENTS.has(p) || COMMON_FILES.has(p)) return true;
    if (i !== parts.length - 1) return false;
    const base = p.replace(/\.[\w]+$/, "");
    return isKnown(base) || GENERIC_SEGMENTS.has(base) || base === "*";
  });
}

/**
 * Replaces everything that could name a person, a project or a machine.
 * Replacements are `<name>`, `<path>`, `<file>`, `<url>`, `<email>`, `<code>`, `<n>` and `<date>`.
 */
export function scrubText(input: string, context: ScrubContext = {}): Scrubbed {
  const isKnown = known(context);
  const replaced: Record<string, number> = {};
  const mark = (kind: string) => {
    replaced[kind] = (replaced[kind] ?? 0) + 1;
    return `<${kind}>`;
  };
  let text = input.replace(/\r\n?/g, "\n");

  // Source code: fenced blocks, inline code that is not a known name, declarations and code-looking stretches.
  text = text.replace(/```[\s\S]*?(?:```|$)/g, () => mark("code"));
  text = text.replace(/`([^`\n]{1,200})`/g, (all, inner: string) => (isKnown(inner.trim()) ? all : mark("code")));
  text = text.replace(/<\/?[A-Za-z][\w.]*(?:\s[^<>\n]*)?\/?>/g, (tag) => (/^<(?:name|path|file|url|email|code|n|date)>$/.test(tag) ? tag : mark("code")));
  text = text.replace(/\b(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*\s*\([^)\n]*\)[^\n.]*/g, () => mark("code"));
  text = text.replace(/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::\s*[\w<>[\]|]+)?\s*=\s*[^\n,;]+?(?=[,;\n]|\.\s|\.?$)/g, () => mark("code"));
  text = text.replace(/[^\n.;]*(?:=>|\{|\}|===|!==|&&|\|\|)[^\n.;]*/g, (all) => (all.trim() ? ` ${mark("code")}` : all));

  // Links, e-mail addresses and paths.
  text = text.replace(/\b(?:https?|ftp|file|ssh|git|wss?):\/\/[\w-]\S*|\bwww\.[\w-]+\.\S+/gi, (url) => (/^https?:\/\/localhost(?::\d+)?\/?$/i.test(url) ? url : mark("url")));
  text = text.replace(/[\w.+-]+@(?=[A-Za-z])[\w-]+(?:\.[\w-]+)+/g, () => mark("email"));
  text = text.replace(/(?:\b[A-Za-z]:|\\\\[\w.-]+)[\\/][^\s"'`,;)]*/g, () => mark("path"));
  text = text.replace(/(^|[\s("'=])((?:~|\.{1,2})?\/(?:[\w.@*-]+\/)+[\w.@*-]*)/g, (all, lead: string, path: string) => (genericPath(path, isKnown) ? all : `${lead}${mark("path")}`));
  text = text.replace(/(^|[\s("'=])~(?=[\s,.;)]|$)/g, (_all, lead: string) => `${lead}${mark("path")}`);
  text = text.replace(/(?<![\w<@/-])@?[\w.-]+(?:[\\/][\w.*-]+)+\/?/g, (found) => {
    // A full stop after a path ends the sentence.
    const path = found.replace(/\.+$/, "");
    const end = found.slice(path.length);
    if (!/[\\/]/.test(path) || /^\d+\/\d+$/.test(path)) return found;
    if (genericPath(path, isKnown)) return found;
    // A slash between plain words ("and/or", "next/dynamic") is prose; a path has an extension or several folders.
    if (!new RegExp(`\\.(?:${FILE_EXT})$`, "i").test(path) && path.split(/[\\/]/).length < 3) return found;
    return mark("path") + end;
  });
  text = text.replace(new RegExp(`(?<![\\w<./-])\\.?[\\w-]+(?:\\.[\\w-]+)*\\.(?:${FILE_EXT})\\b`, "gi"), (file) => {
    if (COMMON_FILES.has(file.toLowerCase()) || isKnown(file.replace(/\.\w+$/, "")) || TECH_WORDS.has(file.toLowerCase())) return file;
    // ".glb", ".gltf": an extension on its own is a format, not a file.
    if (/^\.\w+$/.test(file)) return file;
    return mark("file");
  });

  // Codes, keys, ids and dates.
  text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, () => mark("code"));
  text = text.replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?Z?)?\b/g, () => mark("date"));
  text = text.replace(/\b(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{20,}\b/g, () => mark("code"));
  text = text.replace(/\b[0-9a-f]{12,}\b/gi, (hex) => (/\d/.test(hex) ? mark("code") : hex));
  text = text.replace(/\b\d{6,}\b/g, () => mark("n"));
  text = text.replace(/\b(?=\w*\d)(?=\w*[A-Za-z])\w+\b/g, (token) => (UNIT.test(token) || TECH_CODES.test(token) || isKnown(token) ? token : mark("code")));

  // Names of the project, as written there.
  const own = [...new Set(context.projectNames ?? [])]
    .map((n) => n.trim())
    .filter((n) => n.length >= 3 && !isKnown(n))
    .sort((a, b) => b.length - a.length);
  for (const name of own) {
    // A lowercase word ("player") is an ordinary word too; a plain word with a capital is replaced only as written.
    if (/^[a-z]+$/.test(name)) continue;
    const plain = /^[A-Z][a-z]+$/.test(name);
    text = text.replace(new RegExp(`(?<![\\w<])${escape(name)}(?![\\w>])`, plain ? "g" : "gi"), () => mark("name"));
  }

  // Identifiers that are not known: snake_case, camelCase and coined PascalCase compounds.
  text = text.replace(/(?<![\w<@.$/])(?:[A-Za-z_$][A-Za-z0-9$]*(?:_[A-Za-z0-9]+)+|[a-z$]+[A-Z][\w$]*|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)(?![\w>$])/g, (id: string, offset: number, all: string) => {
    if (isKnown(id)) return id;
    // A file every web project has (draco_decoder.wasm) keeps its name.
    const file = /^[\w.-]*/.exec(all.slice(offset))?.[0] ?? "";
    return COMMON_FILES.has(file.toLowerCase()) ? id : mark("name");
  });
  // The member after a known name (THREE.Foo, renderer.fooBar) is checked on its own.
  text = text.replace(/(?<=[\w)\]]\.)([A-Za-z_$][\w$]*)\b/g, (member: string) => {
    if (/^[a-z]+$/.test(member) || isKnown(member)) return member;
    return mark("name");
  });

  // Words with a capital: a name, unless it is known, an acronym, or an ordinary word starting a sentence.
  const words = englishWords();
  text = text.replace(/(^|[^\p{L}\p{N}_<.])([A-Z][\p{L}\p{N}_'’]*[\p{L}\p{N}_])/gu, (all, before: string, word: string, offset: number) => {
    if (/[\p{N}_]/u.test(word)) return all;
    const bare = word.replace(/['’]s$/, "");
    if (isKnown(bare) || /^[A-Z]{2,6}s?$/.test(bare)) return all;
    const head = text.slice(0, offset + before.length).replace(/[\s"'(*_-]+$/, "");
    const startsSentence = head === "" || /[.!?:;\n]$/.test(head) || /(?:^|\n)\s*(?:[-*•]|\d+[.)])$/.test(head);
    if (startsSentence && englishForm(bare.toLowerCase(), words)) return all;
    return `${before}${mark("name")}${word.slice(bare.length)}`;
  });

  text = text
    .replace(/(<(\w+)>)(?:[ \t/&+-]*<\2>)+/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, replaced };
}

/** Share of the words that were replaced: a lesson that is mostly placeholders says nothing. */
export function placeholderShare(text: string): number {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 1;
  return tokens.filter((t) => /<\w+>/.test(t)).length / tokens.length;
}
