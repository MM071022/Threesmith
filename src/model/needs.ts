/**
 * What a glTF file needs from three.js to load: decoders to set up on GLTFLoader, plugins to register, and what each
 * extension turns into. Checked against GLTFLoader, DRACOLoader and KTX2Loader of three r187 (examples/jsm/loaders).
 */
import type { ModelInfo } from "./inspect.js";

export type SetupId = "draco" | "meshopt" | "ktx2" | "gaussian-splatting";

/** One setup a file needs on its GLTFLoader before `load()`. */
export interface LoaderSetup {
  id: SetupId;
  /** The glTF extensions that need it. */
  extensions: string[];
  /** True when one of them is in extensionsRequired: without the setup GLTFLoader throws or loads nothing. */
  required: boolean;
  /** One line: what to set up. */
  title: string;
  /** Import lines (three/addons/... paths that exist in three's examples/jsm). */
  imports: string[];
  /** The setup code, using a GLTFLoader named `gltfLoader` and, for KTX2, a renderer named `renderer`. */
  code: string;
  /** What GLTFLoader does when the setup is missing. */
  without: string;
  notes: string[];
}

export type ExtensionSupport = "core" | "setup" | "plugin" | "metadata" | "unsupported";

export interface ExtensionNote {
  name: string;
  required: boolean;
  /** core: GLTFLoader reads it by itself; setup: needs a decoder on the loader; plugin: needs gltfLoader.register(); metadata: ignored on purpose; unsupported: three.js drops it. */
  support: ExtensionSupport;
  /** What it becomes in three.js, or what to do. */
  note: string;
}

export interface ModelNeeds {
  file: string;
  extensionsUsed: string[];
  extensionsRequired: string[];
  extensions: ExtensionNote[];
  setups: LoaderSetup[];
  /** The whole loader setup as one snippet (imports, setups, then the load). */
  code: string;
}

const SETUPS: Record<SetupId, Omit<LoaderSetup, "extensions" | "required">> = {
  draco: {
    id: "draco",
    title: "a DRACOLoader on the GLTFLoader (KHR_draco_mesh_compression)",
    imports: ["import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';"],
    code: ["const dracoLoader = new DRACOLoader();", "// Optional: serve the decoder yourself (copy node_modules/three/examples/jsm/libs/draco/ to public/draco/).", "// dracoLoader.setDecoderPath('/draco/');", "gltfLoader.setDRACOLoader(dracoLoader);"].join("\n"),
    without: "GLTFLoader throws \"No DRACOLoader instance provided\".",
    notes: [
      "Without setDecoderPath, DRACOLoader loads its decoder from three/examples/jsm/libs/draco/ next to DRACOLoader.js (a new URL(..., import.meta.url) that Vite and webpack 5 copy). Set a path when you serve it from elsewhere or a CDN.",
      "Make one DRACOLoader and share it between loaders: each one starts its own decoder workers.",
    ],
  },
  meshopt: {
    id: "meshopt",
    title: "the meshopt decoder on the GLTFLoader (EXT_meshopt_compression / KHR_meshopt_compression)",
    imports: ["import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';"],
    code: "gltfLoader.setMeshoptDecoder(MeshoptDecoder);",
    without: "GLTFLoader throws \"setMeshoptDecoder must be called before loading compressed files\" (when the file requires it), or reads the fallback buffers when there are any.",
    notes: ["The decoder is small and needs no extra files to serve: its WebAssembly is inside the module."],
  },
  ktx2: {
    id: "ktx2",
    title: "a KTX2Loader with detectSupport(renderer) on the GLTFLoader (KHR_texture_basisu)",
    imports: ["import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';"],
    code: ["const ktx2Loader = new KTX2Loader();", "// Optional: serve the transcoder yourself (copy node_modules/three/examples/jsm/libs/basis/ to public/basis/).", "// ktx2Loader.setTranscoderPath('/basis/');", "ktx2Loader.detectSupport(renderer); // with WebGPURenderer: await renderer.init() first", "gltfLoader.setKTX2Loader(ktx2Loader);"].join("\n"),
    without: "GLTFLoader throws \"setKTX2Loader must be called before loading KTX2 textures\" (when required), or uses the fallback image; a KTX2Loader without detectSupport throws \"Missing initialization with .detectSupport( renderer )\".",
    notes: [
      "detectSupport needs the renderer that will draw the textures: it picks the GPU format (ASTC, BC7, ETC2...) to transcode to.",
      "Without setTranscoderPath, KTX2Loader loads basis_transcoder.js and .wasm from three/examples/jsm/libs/basis/ next to KTX2Loader.js.",
    ],
  },
  "gaussian-splatting": {
    id: "gaussian-splatting",
    title: "the GLTFGaussianSplatLoaderExtension plugin (KHR_gaussian_splatting, WebGPURenderer only)",
    imports: ["import { GLTFGaussianSplatLoaderExtension } from 'three/addons/loaders/GLTFGaussianSplatLoaderExtension.js';"],
    code: "gltfLoader.register((parser) => new GLTFGaussianSplatLoaderExtension(parser));",
    without: "the splats are not loaded.",
    notes: ["GaussianSplat needs WebGPURenderer; it is not registered by default for that reason."],
  },
};

/** Which setup an extension needs. */
const NEEDS: Record<string, SetupId> = {
  KHR_draco_mesh_compression: "draco",
  EXT_meshopt_compression: "meshopt",
  KHR_meshopt_compression: "meshopt",
  KHR_texture_basisu: "ktx2",
  KHR_gaussian_splatting: "gaussian-splatting",
};

/** What GLTFLoader (r187) does with each extension it knows. Anything else is unsupported. */
const KNOWN: Record<string, { support: ExtensionSupport; note: string }> = {
  KHR_draco_mesh_compression: { support: "setup", note: "Draco geometry: needs a DRACOLoader (setDRACOLoader)." },
  EXT_meshopt_compression: { support: "setup", note: "meshopt buffers: needs setMeshoptDecoder(MeshoptDecoder)." },
  KHR_meshopt_compression: { support: "setup", note: "meshopt buffers: needs setMeshoptDecoder(MeshoptDecoder)." },
  KHR_texture_basisu: { support: "setup", note: "KTX2 / Basis textures: needs a KTX2Loader with detectSupport(renderer). They stay compressed on the GPU (about a quarter of the memory of PNG or JPEG)." },
  KHR_gaussian_splatting: { support: "plugin", note: "Gaussian splats: register GLTFGaussianSplatLoaderExtension (WebGPURenderer only)." },
  KHR_mesh_quantization: { support: "core", note: "Integer vertex attributes, read as they are; the node scale undoes the quantization. No setup." },
  KHR_texture_transform: { support: "core", note: "Becomes texture.offset, .repeat and .rotation (one transform per texture)." },
  KHR_lights_punctual: { support: "core", note: "Becomes PointLight, SpotLight and DirectionalLight in physical units (candela, lux): exports from modelling tools are often far too bright or too dim, so check the intensities." },
  KHR_materials_unlit: { support: "core", note: "Becomes MeshBasicMaterial: lights and shadows do not affect it." },
  KHR_materials_emissive_strength: { support: "core", note: "Becomes emissiveIntensity; above 1 it only glows with tone mapping and a bloom pass." },
  KHR_materials_clearcoat: { support: "core", note: "MeshPhysicalMaterial clearcoat, clearcoatRoughness, clearcoatNormalMap." },
  KHR_materials_sheen: { support: "core", note: "MeshPhysicalMaterial sheen, sheenColor, sheenRoughness (cloth, velvet)." },
  KHR_materials_transmission: { support: "core", note: "MeshPhysicalMaterial transmission: the renderer draws the opaque scene into an extra render target for it every frame." },
  KHR_materials_volume: { support: "core", note: "MeshPhysicalMaterial thickness, attenuationColor, attenuationDistance (with transmission)." },
  KHR_materials_ior: { support: "core", note: "MeshPhysicalMaterial ior." },
  KHR_materials_specular: { support: "core", note: "MeshPhysicalMaterial specularIntensity, specularColor." },
  KHR_materials_iridescence: { support: "core", note: "MeshPhysicalMaterial iridescence, iridescenceIOR, iridescenceThicknessRange." },
  KHR_materials_anisotropy: { support: "core", note: "MeshPhysicalMaterial anisotropy, anisotropyRotation (brushed metal)." },
  KHR_materials_dispersion: { support: "core", note: "MeshPhysicalMaterial dispersion (with transmission)." },
  KHR_materials_diffuse_roughness: { support: "core", note: "MeshPhysicalMaterial diffuseRoughness." },
  EXT_materials_bump: { support: "core", note: "Becomes bumpMap and bumpScale." },
  EXT_texture_webp: { support: "core", note: "WebP textures, decoded by the browser; GLTFLoader uses the fallback image when the browser cannot decode WebP." },
  EXT_texture_avif: { support: "core", note: "AVIF textures, decoded by the browser; GLTFLoader uses the fallback image when the browser cannot decode AVIF (older browsers)." },
  EXT_mesh_gpu_instancing: { support: "core", note: "Becomes an InstancedMesh: one draw call for every copy." },
  KHR_materials_variants: { support: "plugin", note: "Not built in: register the plugin from takahirox/three-gltf-extensions to switch variants; without it the default materials load." },
  KHR_animation_pointer: { support: "plugin", note: "Not built in: register needle-tools/three-animation-pointer; without it those animation channels are dropped." },
  MSFT_texture_dds: { support: "plugin", note: "Not built in: register the plugin from takahirox/three-gltf-extensions." },
  NEEDLE_progressive: { support: "plugin", note: "Not built in: register needle-tools/gltf-progressive." },
  KHR_xmp_json_ld: { support: "metadata", note: "Asset metadata (author, licence); GLTFLoader ignores it, nothing to do." },
  KHR_materials_pbrSpecularGlossiness: { support: "unsupported", note: "Not supported by GLTFLoader: convert the materials with npx @gltf-transform/cli metalrough in.glb out.glb." },
};

/** What GLTFLoader in three r187 knows about an extension (support and a note), or undefined for one it does not know. */
export function extensionSupport(name: string): { support: ExtensionSupport; note: string } | undefined {
  return Object.hasOwn(KNOWN, name) ? KNOWN[name] : undefined;
}

/** The loaders, decoders and plugins a model needs in three.js, from its extensionsUsed and extensionsRequired. */
export function modelNeeds(info: Pick<ModelInfo, "file" | "extensionsUsed" | "extensionsRequired">): ModelNeeds {
  const required = new Set(info.extensionsRequired);
  const used = [...new Set([...info.extensionsUsed, ...info.extensionsRequired])].sort();
  const extensions: ExtensionNote[] = used.map((name) => {
    const known = extensionSupport(name);
    return {
      name,
      required: required.has(name),
      support: known?.support ?? "unsupported",
      note: known?.note ?? `GLTFLoader does not know this extension: ${required.has(name) ? "it is required, so the data it holds is lost and GLTFLoader warns 'Unknown extension'" : "it is optional, so the file loads without it"}. Register a plugin with gltfLoader.register() if you need it.`,
    };
  });
  const byId = new Map<SetupId, LoaderSetup>();
  for (const name of used) {
    const id = Object.hasOwn(NEEDS, name) ? NEEDS[name] : undefined;
    if (!id) continue;
    const setup = byId.get(id) ?? { ...SETUPS[id], extensions: [], required: false };
    setup.extensions.push(name);
    setup.required ||= required.has(name);
    byId.set(id, setup);
  }
  const setups = [...byId.values()];
  return { file: info.file, extensionsUsed: info.extensionsUsed, extensionsRequired: info.extensionsRequired, extensions, setups, code: loaderCode(setups, info.file) };
}

function loaderCode(setups: LoaderSetup[], file: string): string {
  const name = file.split(/[\\/]/).pop() || "model.glb";
  return [
    "import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';",
    ...setups.flatMap((s) => s.imports),
    "",
    "const gltfLoader = new GLTFLoader();",
    ...setups.map((s) => s.code),
    `const gltf = await gltfLoader.loadAsync('/${name}');`,
    "scene.add(gltf.scene);",
  ].join("\n");
}

/** The model needs as text for an agent. */
export function formatModelNeeds(needs: ModelNeeds): string {
  const out: string[] = [`${needs.file}: ${needs.extensionsUsed.length ? `uses ${needs.extensionsUsed.join(", ")}` : "uses no extensions"}${needs.extensionsRequired.length ? `; requires ${needs.extensionsRequired.join(", ")}` : ""}`];
  if (needs.setups.length === 0) out.push("  A plain GLTFLoader reads it: no decoders to set up.");
  for (const s of needs.setups) {
    out.push("", `needs ${s.title}${s.required ? " [required]" : " [optional: the file has a fallback]"}`, `  without it: ${s.without}`, ...s.notes.map((n) => `  - ${n}`));
  }
  const rest = needs.extensions.filter((e) => e.support !== "setup");
  if (rest.length) out.push("", "extensions:", ...rest.map((e) => `  ${e.name}${e.required ? " (required)" : ""}: ${e.support}. ${e.note}`));
  out.push("", "loader code:", ...needs.code.split("\n").map((l) => `  ${l}`));
  return `${out.join("\n")}\n`;
}

/** A setup a project's code is missing for the models it loads. */
export interface SetupProblem {
  setup: SetupId | "gltf-loader";
  severity: "error" | "warning" | "info";
  /** The models that need it. */
  files: string[];
  message: string;
  /** The code that fixes it. */
  fix: string;
}

/** Signs in source code that a setup is done. Each entry is a list of patterns that must all be there. */
const DONE: Record<SetupId, { all: RegExp[]; part?: { has: RegExp; missing: RegExp; message: string }[] }> = {
  draco: { all: [/\bsetDRACOLoader\s*\(/] },
  meshopt: { all: [/\bsetMeshoptDecoder\s*\(/] },
  ktx2: {
    all: [/\bsetKTX2Loader\s*\(/],
    part: [{ has: /\bKTX2Loader\b/, missing: /\.detectSupport\s*\(/, message: "a KTX2Loader is made but detectSupport(renderer) is never called, so it throws on the first texture" }],
  },
  "gaussian-splatting": { all: [/\bGLTFGaussianSplatLoaderExtension\b/, /\.register\s*\(/] },
};

/**
 * Compares what the models need with what the project's source does, and returns the setups that are missing (a model
 * uses Draco, but no source file calls setDRACOLoader). Pure: give the needs of every model and the text of the source
 * files (one string, a list, or a map of file name to text). drei's useGLTF sets up Draco and meshopt by itself.
 */
export function checkModelSetup(needs: ModelNeeds | ModelNeeds[], sources: string | string[] | Record<string, string>): SetupProblem[] {
  const list = Array.isArray(needs) ? needs : [needs];
  const text = typeof sources === "string" ? sources : (Array.isArray(sources) ? sources : Object.values(sources)).join("\n");
  const problems: SetupProblem[] = [];
  if (list.length === 0) return problems;
  const drei = /\buseGLTF\b/.test(text);
  if (!/\bGLTFLoader\b/.test(text) && !drei) {
    problems.push({
      setup: "gltf-loader",
      severity: "info",
      files: list.map((n) => n.file),
      message: "No source file uses GLTFLoader (or drei's useGLTF), so nothing seems to load these models yet.",
      fix: "import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';\nconst gltf = await new GLTFLoader().loadAsync('/model.glb');",
    });
  }
  const ids = [...new Set(list.flatMap((n) => n.setups.map((s) => s.id)))];
  for (const id of ids) {
    const users = list.filter((n) => n.setups.some((s) => s.id === id));
    const setups = users.flatMap((n) => n.setups.filter((s) => s.id === id));
    const required = setups.some((s) => s.required);
    const files = users.map((n) => n.file);
    const def = SETUPS[id];
    const fix = [...def.imports, def.code].join("\n");
    // drei's useGLTF makes a DRACOLoader (decoder from a CDN) and sets the meshopt decoder by default.
    if (drei && (id === "draco" || id === "meshopt")) continue;
    const check = DONE[id];
    if (!check.all.every((re) => re.test(text))) {
      problems.push({
        setup: id,
        severity: required ? "error" : "warning",
        files,
        message: `${list.length === 1 ? files[0] : `${files.length} models (${files.slice(0, 3).join(", ")}${files.length > 3 ? ", ..." : ""})`} need ${def.title}, but no source file sets it up. Without it ${def.without}`,
        fix,
      });
      continue;
    }
    for (const part of check.part ?? []) {
      if (part.has.test(text) && !part.missing.test(text)) problems.push({ setup: id, severity: required ? "error" : "warning", files, message: `${files.join(", ")}: ${part.message}.`, fix });
    }
  }
  return problems;
}

export function formatSetupProblems(problems: SetupProblem[]): string {
  if (problems.length === 0) return "model setup: every model's loader needs are set up in the source.\n";
  const out: string[] = [];
  for (const p of problems) out.push(`${p.severity} [model/setup-${p.setup}] ${p.message}`, ...p.fix.split("\n").map((l) => `    ${l}`));
  return `${out.join("\n")}\n`;
}
