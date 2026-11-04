import { existsSync } from "node:fs";
import { join } from "node:path";
import { levenshtein } from "../api/lookup.js";
import { CHUNK_HISTORY, closeOf, splitTop, customChunks, loopBodies, shaderChunks, shaderMaterials, callArgs, type GlslCode, type ShaderMaterialUse } from "./parse.js";
import type { SourceFile } from "./source.js";
import type { Ctx, Report, Rule } from "./types.js";

/**
 * Rules for GLSL handed to WebGLRenderer: ShaderMaterial, RawShaderMaterial and onBeforeCompile patches. They are
 * pinned to what the installed three does (the chunks of its ShaderChunk.js, the prefix WebGLProgram.js puts in front
 * of a shader). Broken shaders are `correctness` (nothing renders), outdated names are `api`: a separate category
 * would weigh every project without shaders as perfect in it and dilute the score.
 */

/** Files that can hold GLSL: three files, and shader modules or HTML pages that hold shader code. */
function glslFiles(ctx: Ctx): SourceFile[] {
  return ctx.files.filter((f) => f.usesThree || /\bgl_(?:Position|FragColor)\b|\bvoid\s+main\s*\(/.test(f.text));
}

const BUILTIN_VERTEX = ["modelMatrix", "modelViewMatrix", "projectionMatrix", "viewMatrix", "normalMatrix", "cameraPosition", "isOrthographic"];
const BUILTIN_FRAGMENT = ["viewMatrix", "cameraPosition", "isOrthographic"];
const PRECISION = String.raw`(?:(?:highp|mediump|lowp)\s+)?`;

function includes(ctx: Ctx, report: Report, patch: boolean): void {
  if (!ctx.install) return;
  const chunks = shaderChunks(ctx.install.root);
  if (!chunks) return;
  const custom = customChunks(ctx.files.map((f) => f.text).join("\n"));
  for (const f of glslFiles(ctx)) {
    for (const m of f.text.matchAll(/#include\s+<(\w+)>/g)) {
      const name = m[1] ?? "";
      if (chunks.has(name) || custom.has(name)) continue;
      const idx = m.index ?? 0;
      const isPatch = /\.replace(?:All)?\s*\(\s*['"`]\s*$/.test(f.text.slice(Math.max(0, idx - 40), idx));
      if (isPatch !== patch) continue;
      const h = CHUNK_HISTORY[name];
      const r = ctx.install.release;
      const what = h ? (h.to ? `was renamed to \`${h.to}\` in r${h.release}` : `was removed in r${h.release}`) : `is not a shader chunk of three r${r}`;
      const effect = patch ? "so this replace() matches nothing and the patch silently does nothing." : `so three throws "Can not resolve #include <${name}>".`;
      const close = h ? [] : [...chunks].filter((c) => levenshtein(c, name, 4) <= 4).sort((a, b) => levenshtein(a, name, 4) - levenshtein(b, name, 4)).slice(0, 2);
      const fix = h?.to
        ? `Use #include <${h.to}>${h.note ? ` (${h.note})` : ""}.`
        : h?.note
          ? `Drop the include: ${h.note}.`
          : close.length
            ? `Did you mean ${close.map((c) => `<${c}>`).join(" or ")}? List the chunks with Object.keys(THREE.ShaderChunk).`
            : "List the chunks with Object.keys(THREE.ShaderChunk), or register your own as THREE.ShaderChunk.name = '...'.";
      report(f, idx, { message: `\`#include <${name}>\` ${what}, ${effect}`, fix });
    }
  }
}

function each(ctx: Ctx, fn: (use: ShaderMaterialUse) => void): void {
  for (const use of shaderMaterials(ctx.files, ctx.three)) fn(use);
}

function find(code: GlslCode | undefined, re: RegExp): number | undefined {
  if (!code) return undefined;
  const m = re.exec(code.code);
  return m ? code.start + (m.index ?? 0) : undefined;
}

function isGlsl3(use: ShaderMaterialUse): boolean {
  return use.glsl3 || (use.raw && /^\s*#version\s+300\s+es/.test(use.vertex?.code ?? use.fragment?.code ?? ""));
}

/** Every block that runs later than setup: frame loops, event and GUI callbacks. */
function laterBlocks(f: SourceFile): { start: number; end: number }[] {
  const out = loopBodies(f);
  for (const m of f.text.matchAll(/\.(?:addEventListener|onChange|onFinishChange)\s*/g)) {
    const a = callArgs(f.text, (m.index ?? 0) + m[0].length);
    if (a) out.push(a);
  }
  return out;
}

export const SHADER_RULES: Rule[] = [
  {
    id: "shader-include-unknown",
    category: "correctness",
    severity: "error",
    title: "#include of a shader chunk that does not exist",
    message: "The shader includes a chunk that the installed three does not have.",
    fix: "Use a chunk name from THREE.ShaderChunk.",
    check(ctx, report) {
      includes(ctx, report, false);
    },
  },
  {
    id: "shader-patch-target-missing",
    category: "correctness",
    severity: "error",
    title: "onBeforeCompile replaces an #include that is not in the shader",
    message: "The patch replaces an #include that the installed three's shaders do not contain.",
    fix: "Replace an include the material's shader really has (see THREE.ShaderLib).",
    check(ctx, report) {
      includes(ctx, report, true);
    },
  },
  {
    id: "shader-glsl3-legacy",
    category: "correctness",
    severity: "error",
    title: "GLSL 1 names in a GLSL 3 shader",
    message: "With glslVersion GLSL3 three does not define `gl_FragColor`, so the fragment shader does not compile.",
    fix: "Declare `layout(location = 0) out highp vec4 fragColor;` (or any name) and write to it instead of gl_FragColor.",
    check(ctx, report) {
      each(ctx, (use) => {
        if (!isGlsl3(use)) return;
        const frag = find(use.fragment, /\bgl_FragColor\b/);
        if (frag !== undefined && use.fragment) report(use.fragment.file, frag);
        if (!use.raw) return; // ShaderMaterial #defines texture2D, varying and attribute for GLSL 3
        for (const code of [use.vertex, use.fragment]) {
          const legacyName = find(code, /\btexture2D\s*\(|\btextureCube\s*\(|^\s*(?:varying|attribute)\s/m);
          if (legacyName !== undefined && code) {
            report(code.file, legacyName, {
              message: "A RawShaderMaterial in GLSL 3.00 gets no compatibility defines: `texture2D`, `textureCube`, `varying` and `attribute` do not exist there.",
              fix: "Use texture(), `in`/`out` instead of attribute/varying, and an `out vec4` instead of gl_FragColor.",
            });
          }
        }
      });
    },
  },
  {
    id: "shader-version-directive",
    category: "correctness",
    severity: "error",
    title: "#version written in a shader that three already versions",
    message: "three puts `#version 300 es` in front of every ShaderMaterial shader, so a second #version is a compile error.",
    fix: "Delete the #version line (set glslVersion: THREE.GLSL3 if you want GLSL 3.00 syntax), or use RawShaderMaterial without glslVersion.",
    check(ctx, report) {
      each(ctx, (use) => {
        if (use.raw && !use.glsl3) return;
        for (const code of [use.vertex, use.fragment]) {
          const v = find(code, /^[ \t]*#version\b/m);
          if (v !== undefined && code) {
            report(code.file, v, use.raw ? { message: "glslVersion makes three write the #version line, so the one in the shader is a second one and does not compile.", fix: "Delete the #version line from the shader or the glslVersion option." } : undefined);
          }
        }
      });
    },
  },
  {
    id: "shader-builtin-redeclared",
    category: "correctness",
    severity: "error",
    title: "ShaderMaterial declares a uniform or attribute three already declares",
    message: "ShaderMaterial already declares this built-in, so declaring it again is a 'redefinition' compile error.",
    fix: "Delete the declaration (three provides modelMatrix, modelViewMatrix, projectionMatrix, viewMatrix, normalMatrix, cameraPosition, position, normal and uv), or use RawShaderMaterial.",
    check(ctx, report) {
      const vertex = new RegExp(String.raw`^[ \t]*(?:uniform\s+${PRECISION}(?:mat4|mat3|vec3|bool)\s+(${BUILTIN_VERTEX.join("|")})|(?:attribute|in)\s+${PRECISION}vec[23]\s+(position|normal|uv))\s*;`, "m");
      const fragment = new RegExp(String.raw`^[ \t]*uniform\s+${PRECISION}(?:mat4|vec3|bool)\s+(${BUILTIN_FRAGMENT.join("|")})\s*;`, "m");
      each(ctx, (use) => {
        if (use.raw) return;
        for (const [code, re] of [[use.vertex, vertex], [use.fragment, fragment]] as const) {
          if (!code) continue;
          const m = re.exec(code.code);
          if (m) report(code.file, code.start + (m.index ?? 0), { message: `ShaderMaterial already declares \`${m[1] ?? m[2]}\`, so declaring it again is a 'redefinition' compile error.` });
        }
      });
    },
  },
  {
    id: "shader-raw-undeclared",
    category: "correctness",
    severity: "error",
    title: "RawShaderMaterial uses a built-in it never declares",
    message: "RawShaderMaterial gets no built-in uniforms or attributes declared, so this name is an undeclared identifier.",
    fix: "Declare it yourself, e.g. `uniform mat4 projectionMatrix;` / `in vec3 position;`, or use ShaderMaterial.",
    check(ctx, report) {
      each(ctx, (use) => {
        if (!use.raw) return;
        for (const [code, names] of [[use.vertex, [...BUILTIN_VERTEX, "position"]], [use.fragment, BUILTIN_FRAGMENT]] as const) {
          if (!code || code.dynamic || /#include\b/.test(code.code)) continue;
          for (const n of names) {
            const used = new RegExp(String.raw`\b${n}\b`).exec(code.code);
            if (!used) continue;
            const declared = new RegExp(String.raw`\b(?:uniform|attribute|in)\s+${PRECISION}\w+\s+${n}\b|#define\s+${n}\b|\b\w+\s+${n}\s*[=;(]`).test(code.code);
            if (!declared) {
              report(code.file, code.start + (used.index ?? 0), { message: `RawShaderMaterial declares nothing for you, so \`${n}\` is an undeclared identifier.` });
              break;
            }
          }
        }
      });
    },
  },
  {
    id: "shader-raw-precision",
    category: "correctness",
    severity: "error",
    title: "RawShaderMaterial fragment shader without float precision",
    message: "A fragment shader has no default float precision, and RawShaderMaterial adds none, so it fails with 'No precision specified for (float)'.",
    fix: "Start the fragment shader with `precision highp float;` (after #version, if any).",
    check(ctx, report) {
      each(ctx, (use) => {
        const code = use.fragment;
        if (!use.raw || !code || code.dynamic || /#include\b/.test(code.code)) return;
        if (!/\bvoid\s+main\s*\(/.test(code.code) || /\bprecision\s+(?:highp|mediump|lowp)\s+float\s*;/.test(code.code)) return;
        report(code.file, code.start + Math.max(0, code.code.search(/\S/)));
      });
    },
  },
  {
    id: "shader-lights-no-uniforms",
    category: "correctness",
    severity: "error",
    title: "lights: true without the light uniforms",
    message: "With `lights: true` three writes the light uniforms every frame; without UniformsLib.lights in `uniforms` that throws \"Cannot set properties of undefined (setting 'needsUpdate')\".",
    fix: "uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, { ...your uniforms }]).",
    check(ctx, report) {
      each(ctx, (use) => {
        // only an inline uniforms object can be checked; a variable or a merge may hold the light uniforms
        if (!/\blights\s*:\s*true\b/.test(use.options) || !/\buniforms\s*:\s*\{/.test(use.options)) return;
        if (/\b(?:UniformsLib|ShaderLib|UniformsUtils)\b|\.\.\./.test(use.options) || /\bUniformsLib\b/.test(use.file.text)) return;
        report(use.file, use.at);
      });
    },
  },
  {
    id: "shader-uniform-not-object",
    category: "correctness",
    severity: "error",
    title: "Uniform given as a bare value",
    message: "Every entry of `uniforms` must be an object with a `value`; a bare value never reaches the shader.",
    fix: "Write { uTime: { value: 0 } } (or new THREE.Uniform(0)) and change uniforms.uTime.value later.",
    check(ctx, report) {
      each(ctx, (use) => {
        const m = /\buniforms\s*:\s*\{/.exec(use.options);
        if (!m) return;
        const open = use.optionsStart + (m.index ?? 0) + m[0].length - 1;
        const close = closeOf(use.file.text, open);
        if (close < 0) return;
        const body = use.file.text.slice(open + 1, close);
        const entries = splitTop(body).map((e) => ({ text: e.text, at: open + 1 + e.at }));
        for (const e of entries) {
          const kv = /^\s*(['"]?)([\w$]+)\1\s*:\s*([\s\S]*?)\s*$/.exec(e.text);
          if (!kv) continue;
          const v = kv[3] ?? "";
          if (/^-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?$|^(?:true|false)$|^new\s+(?:[\w$]+\.)?(?:Vector[234]|Color|Matrix[34]|Quaternion|Texture|DataTexture|CanvasTexture|VideoTexture)\s*\(|^\[/.test(v)) {
            report(use.file, e.at + e.text.search(/\S/), { message: `Uniform \`${kv[2]}\` is a bare value; three reads \`${kv[2]}.value\`, so the shader never gets it.`, fix: `${kv[2]}: { value: ${v.length > 40 ? "..." : v} }` });
          }
        }
      });
    },
  },
  {
    id: "shader-uniform-assign",
    category: "correctness",
    severity: "error",
    title: "Uniform object replaced by a value",
    message: "This replaces the uniform object with a plain value, so the shader keeps its old value.",
    fix: "Set the value: material.uniforms.uTime.value = t;",
    check(ctx, report) {
      for (const f of ctx.three) {
        for (const m of f.text.matchAll(/\.uniforms\s*(?:\.\s*([\w$]+)|\[\s*['"]([\w$]+)['"]\s*\])\s*=(?!=)\s*([^;\n]+)/g)) {
          const v = (m[3] ?? "").trim();
          if (!/^-?(?:\d+\.?\d*|\.\d+)\b|^new\s+(?:[\w$]+\.)?(?:Vector[234]|Color|Matrix[34]|Quaternion)\s*\(|^[\w$.]*(?:getElapsedTime|getElapsed|getDelta|performance\.now|Date\.now)\s*\(/.test(v)) continue;
          const name = m[1] ?? m[2];
          report(f, m.index ?? 0, { fix: `material.uniforms.${name}.value = ${v.length > 40 ? "..." : v};` });
        }
      }
    },
  },
  {
    id: "shader-defines-no-update",
    category: "correctness",
    severity: "warn",
    title: "defines changed without material.needsUpdate",
    message: "Changing `defines` after the first render does nothing until the material is recompiled.",
    fix: "Set material.needsUpdate = true after changing defines (it recompiles the shader, so do it on change, not every frame).",
    check(ctx, report) {
      for (const f of ctx.three) {
        for (const b of laterBlocks(f)) {
          const body = f.text.slice(b.start, b.end);
          if (/\.needsUpdate\s*=\s*true/.test(body)) continue;
          const m = /\.defines\s*(?:\.\s*[\w$]+|\[[^\]]+\])\s*=(?!=)|\bdelete\s+[\w$.]+\.defines\b/.exec(body);
          if (m) report(f, b.start + (m.index ?? 0));
        }
      }
    },
  },
  {
    id: "shader-depth-define-renamed",
    category: "api",
    severity: "warn",
    title: "USE_LOGDEPTHBUF / USE_REVERSEDEPTHBUF were renamed",
    message: "three r180 renamed these defines, so `#ifdef USE_LOGDEPTHBUF` is never true any more and the shader silently skips that code.",
    fix: "Use USE_LOGARITHMIC_DEPTH_BUFFER / USE_REVERSED_DEPTH_BUFFER.",
    introducedIn: 180,
    removedIn: 180,
    check(ctx, report) {
      for (const f of glslFiles(ctx)) for (const m of f.text.matchAll(/\bUSE_(?:LOGDEPTHBUF|REVERSEDEPTHBUF)\b/g)) report(f, m.index ?? 0);
    },
  },
  {
    id: "shader-inverse-transform-direction",
    category: "api",
    severity: "info",
    title: "inverseTransformDirection() is deprecated in GLSL",
    message: "The GLSL helper `inverseTransformDirection()` is deprecated since r185.",
    fix: "Use transformDirectionByInverseViewMatrix() for directions (transformNormalByInverseViewMatrix() for normals).",
    deprecatedIn: 185,
    introducedIn: 185,
    check(ctx, report) {
      for (const f of glslFiles(ctx)) {
        if (/\bvec3\s+inverseTransformDirection\s*\(/.test(f.text)) continue; // the project defines its own
        for (const m of f.text.matchAll(/\binverseTransformDirection\s*\(/g)) report(f, m.index ?? 0);
      }
    },
  },
  {
    id: "webgpu-glsl-material",
    category: "correctness",
    severity: "error",
    title: "GLSL material with WebGPURenderer",
    message: 'WebGPURenderer does not run GLSL: it logs \'Material "ShaderMaterial" is not compatible\' and draws a default node material instead.',
    fix: "Write the shader in TSL with a NodeMaterial (colorNode, positionNode, ...), or use WebGLRenderer.",
    check(ctx, report) {
      const project = /\bWebGPURenderer\b/.test(ctx.all) && !/\bWebGLRenderer\b/.test(ctx.all);
      for (const f of ctx.three) {
        // the whole project renders with WebGPU, or this file takes three from 'three/webgpu'
        if (!project && !(/from\s+['"]three\/webgpu['"]/.test(f.text) && !/\bWebGLRenderer\b/.test(f.text))) continue;
        for (const m of f.text.matchAll(/new\s+(?:[\w$]+\.)?(?:Raw)?ShaderMaterial\s*\(|\.onBeforeCompile\s*=(?!=)/g)) {
          if (m[0].includes("onBeforeCompile")) {
            report(f, m.index ?? 0, { message: "WebGPURenderer never calls onBeforeCompile, so this patch does nothing.", fix: "Change the material with TSL node properties (colorNode, positionNode, ...) instead." });
          } else report(f, m.index ?? 0);
        }
      }
    },
  },
  {
    id: "node-material-webgl",
    category: "correctness",
    severity: "error",
    title: "Node material with WebGLRenderer",
    message: "Node materials only work with WebGPURenderer since r164; WebGLRenderer cannot build them.",
    fix: "Use WebGPURenderer from 'three/webgpu' (it falls back to WebGL 2 by itself), or a classic material with WebGLRenderer.",
    introducedIn: 164,
    check(ctx, report) {
      if (!/\bWebGLRenderer\b/.test(ctx.all) || /\bWebGPURenderer\b/.test(ctx.all) || /\bsetNodesHandler\s*\(/.test(ctx.all)) return;
      // newer releases ship an addon that lets WebGLRenderer build node materials
      const handler = ctx.install && existsSync(join(ctx.install.root, "examples", "jsm", "tsl", "WebGLNodesHandler.js"));
      const fix = handler ? "Use WebGPURenderer from 'three/webgpu', or keep WebGLRenderer and call renderer.setNodesHandler( new WebGLNodesHandler() ) (three/addons/tsl/WebGLNodesHandler.js)." : undefined;
      for (const f of ctx.three) for (const m of f.text.matchAll(/new\s+(?:[\w$]+\.)?\w+NodeMaterial\s*\(/g)) report(f, m.index ?? 0, fix ? { message: "WebGLRenderer cannot build node materials by itself; without a nodes handler they do not render.", fix } : undefined);
    },
  },
];
