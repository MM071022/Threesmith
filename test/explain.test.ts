import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/api/index-builder.js";
import { findThree } from "../src/api/install.js";
import { explain, formatExplanations, parseShaderErrors } from "../src/explain/explain.js";
import { locateCode } from "../src/explain/locate.js";
import { project } from "./helpers.js";

const index = buildIndex(findThree(process.cwd())!);
const ids = (t: string) => explain(t, index).map((e) => e.id);

describe("explain", () => {
  it("names the right import path for a missing export", () => {
    const r = explain("SyntaxError: The requested module 'three' does not provide an export named 'OrbitControls'", index);
    expect(r[0]?.id).toBe("export-not-found");
    expect(r[0]?.detail).toContain("three/addons/controls/OrbitControls.js");
  });
  it("knows removed classes", () => {
    const r = explain("TypeError: THREE.Geometry is not a constructor", index);
    expect(r[0]?.id).toBe("not-a-constructor");
    expect(r[0]?.detail).toContain("does not exist");
  });
  it("recognises the common runtime failures", () => {
    expect(ids("Failed to resolve module specifier \"three\". Relative references must start with")).toContain("bare-specifier");
    expect(ids("WARNING: Multiple instances of Three.js being imported.")).toContain("multiple-instances");
    expect(ids("TypeError: Cannot read properties of undefined (reading 'isBufferGeometry')")).toEqual(["undefined-geometry"]);
    expect(ids("TypeError: Cannot read properties of undefined (reading 'scene')")).toContain("used-before-load");
    expect(ids("SyntaxError: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")).toContain("html-instead-of-model");
    expect(ids("THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN.")).toContain("nan-geometry");
    expect(ids("THREE.WebGLRenderer: Context Lost.")).toContain("context-lost");
    expect(ids("WARNING: Too many active WebGL contexts. Oldest context will be lost.")).toContain("too-many-contexts");
    expect(ids("Access to image at 'x' from origin 'y' has been blocked by CORS policy")).toContain("cors");
    expect(ids("THREE.GLTFLoader: No DRACOLoader instance provided.")).toContain("decoder-path");
    expect(ids("hello world")).toEqual([]);
    expect(formatExplanations([])).toContain("No known");
  });
  it("recognises shader, loader, module and R3F messages", () => {
    const one = (msg: string) => explain(msg, index);
    const inc = one("Uncaught Error: THREE.WebGLProgram: Can not resolve #include <encodings_fragment>");
    expect(inc.map((e) => e.id)).toContain("include-not-resolved");
    expect(inc.find((e) => e.id === "include-not-resolved")?.detail).toContain("colorspace_fragment");
    expect(one("THREE.WebGLProgram: Can not resolve #include <colorspace_fragmnt>").find((e) => e.id === "include-not-resolved")?.detail).toContain("colorspace_fragment");
    expect(ids('THREE.NodeBuilder: Material "ShaderMaterial" is not compatible.')).toContain("glsl-material-webgpu");
    const prop = one("THREE.Material: 'emisive' is not a property of THREE.MeshStandardMaterial.").find((e) => e.id === "not-a-property");
    expect(prop?.detail).toContain("emissive");
    expect(ids("THREE.Object3D.add: object not an instance of THREE.Object3D.")).toEqual(["add-not-object3d"]);
    expect(ids("Error: THREE.KTX2Loader: Missing initialization with `.detectSupport( renderer )`.")).toEqual(["ktx2-detect-support"]);
    expect(ids("TypeError: Cannot set properties of undefined (setting 'needsUpdate')")).toEqual(["needs-update-undefined"]);
    expect(ids("TypeError: Cannot set properties of undefined (setting 'touchAction')")).toEqual(["controls-element"]);
    expect(ids("Error: R3F: Hooks can only be used within the Canvas component!")).toEqual(["r3f-outside-canvas"]);
    const div = one("Error: R3F: Div is not part of the THREE namespace! Did you forget to extend?");
    expect(div[0]?.id).toBe("r3f-not-in-namespace");
    expect(div[0]?.detail).toContain("<div>");
    expect(one("R3F: LineMaterial is not part of the THREE namespace!")[0]?.detail).toContain("extend({ LineMaterial })");
    expect(ids("SyntaxError: Cannot use import statement outside a module")).toEqual(["import-outside-module"]);
    expect(ids("[.WebGL-0x1]GL_INVALID_OPERATION: Feedback loop formed between Framebuffer and active Texture.")).toContain("feedback-loop");
    expect(ids("[.WebGL-0x1]GL_INVALID_FRAMEBUFFER_OPERATION: Framebuffer is incomplete: Attachment has zero size.")).toEqual(["framebuffer-incomplete"]);
    expect(ids("WebGL: INVALID_OPERATION: texImage2D: type FLOAT but ArrayBufferView not Float32Array")).toEqual(["invalid-operation"]);
    expect(ids("THREE.WebGLRenderer: Texture has been resized from (8192x8192) to (4096x4096).")).toEqual(["texture-resized"]);
    expect(ids("THREE.PropertyBinding: No target node found for track: Armature.position.")).toEqual(["no-target-node"]);
    expect(ids("THREE.WebGLRenderer: A WebGL context could not be created. Reason: ")).toEqual(["webgl-unavailable"]);
    const rgbe = one("RGBELoader has been deprecated. Please use HDRLoader instead.");
    expect(rgbe.map((e) => e.id)).toEqual(["addon-deprecated"]);
    expect(rgbe[0]?.detail).toContain("three/addons/loaders/HDRLoader.js");
  });
  it("matches the real browser and runtime texts, as captured from Chromium, V8 and three r187", () => {
    // Captured in headless Chromium (SwiftShader WebGL) and Node 22.
    const chromium: [string, string][] = [
      ["Failed to resolve module specifier \"three\". Relative references must start with either \"/\", \"./\", or \"../\".", "bare-specifier"],
      ["The requested module 'three' does not provide an export named 'OrbitControls'", "export-not-found"],
      ["TypeError: THREE.OrbitControls is not a constructor", "not-a-constructor"],
      ["TypeError: Cannot read properties of undefined (reading 'scene')", "used-before-load"],
      ["TypeError: Cannot set properties of undefined (setting 'needsUpdate')", "needs-update-undefined"],
      ["SyntaxError: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON", "html-instead-of-model"],
      ["SyntaxError: Unexpected end of JSON input", "html-instead-of-model"],
      ["RangeError: Invalid typed array length: -1", "html-instead-of-model"],
      ["Cannot use import statement outside a module", "import-outside-module"],
      ["WARNING: Too many active WebGL contexts. Oldest context will be lost.", "too-many-contexts"],
      ["[.WebGL-0x3d4c001a3200] GL_INVALID_OPERATION: glDrawElements: Feedback loop formed between Framebuffer and active Texture.", "feedback-loop"],
      ["[.WebGL-0x3d4c001a3200] GL_INVALID_FRAMEBUFFER_OPERATION: glClear: Framebuffer is incomplete: Attachment has zero size.", "framebuffer-incomplete"],
      ["WebGL: INVALID_OPERATION: texImage2D: type FLOAT but ArrayBufferView not Float32Array", "invalid-operation"],
      ["Access to image at 'http://localhost:5402/img.png' from origin 'http://localhost:5401' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.", "cors"],
      ["SecurityError: Failed to execute 'toDataURL' on 'HTMLCanvasElement': Tainted canvases may not be exported.", "cors"],
      ["SecurityError: Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.", "cors"],
      ["SecurityError: Failed to execute 'texImage2D' on 'WebGL2RenderingContext': The image element contains cross-origin data, and may not be loaded.", "cors"],
      ["Access to script at 'file:///app/main.js' from origin 'null' has been blocked by CORS policy: Cross origin requests are only supported for protocol schemes: chrome, chrome-extension, chrome-untrusted, data, http, https, isolated-app.", "file-protocol"],
      ["Failed to load resource: net::ERR_FILE_NOT_FOUND", "file-protocol"],
      ["No available adapters.", "no-webgpu"],
      ["THREE.WebGPURenderer: WebGPU is not available, running under WebGL2 backend.", "no-webgpu"],
      // From the Chromium source (webgl_rendering_context_base.cc): printed for a real (GPU) context loss.
      ["WebGL: CONTEXT_LOST_WEBGL: loseContext: context lost", "context-lost"],
      // three r187 (Renderer.js).
      ['Error: THREE.Renderer: .render() called before the backend is initialized. Use "await renderer.init();" before rendering.', "webgpu-init"],
      ['THREE.Renderer: "renderAsync()" has been deprecated. Use "render()" and "await renderer.init();" when creating the renderer.', "webgpu-init"],
    ];
    for (const [msg, id] of chromium) expect(ids(msg), msg).toContain(id);
    // Firefox formats, from the SpiderMonkey source (ErrorNumbers.msg, JSONParser.cpp): not reproduced here.
    expect(ids("SyntaxError: JSON.parse: unexpected character at line 1 column 1 of the JSON data")).toContain("html-instead-of-model");
    expect(ids('TypeError: can\'t access property "needsUpdate", texture is undefined')).toContain("needs-update-undefined");
    expect(ids('TypeError: can\'t access property "requestAdapter", navigator.gpu is undefined')).toContain("no-webgpu");
    // R3F 9.8 and 8.18 (dist): the exact texts.
    expect(ids("Error: R3F: Hooks can only be used within the Canvas component!")).toEqual(["r3f-outside-canvas"]);
    expect(ids("Error: R3F: Div is not part of the THREE namespace! Did you forget to extend? See: https://docs.pmnd.rs/react-three-fiber/api/objects#using-3rd-party-objects-declaratively")[0]).toBe("r3f-not-in-namespace");
    expect(ids("Error: Some other library has not been initialized")).toEqual([]);
  });
  it("reads shader errors and their failing line", () => {
    const msg = `THREE.WebGLProgram: Shader Error 1282 - VALIDATE_STATUS false

Material Name:
Material Type: ShaderMaterial

Program Info Log: Fragment shader is not compiled.

FRAGMENT

ERROR: 0:120: 'colr' : undeclared identifier
ERROR: 0:120: 'assign' : cannot convert from 'const mediump float' to 'out highp 4-component vector of float'

  119: void main() {
> 120:   gl_FragColor = vec4(colr, 1.0);
  121: }`;
    const errs = parseShaderErrors(msg);
    expect(errs).toHaveLength(2);
    expect(errs[0]).toMatchObject({ stage: "fragment", line: 120, message: "'colr' : undeclared identifier", code: "gl_FragColor = vec4(colr, 1.0);" });
    expect(ids(msg)).toContain("shader-error");
  });
  it("finds the user's own line for a shader line", () => {
    const dir = project({ "src/shader.js": "export const frag = `\nvoid main() {\n  gl_FragColor = vec4(colr, 1.0);\n}`;\n", "node_modules/x.js": "gl_FragColor = vec4(colr, 1.0);" });
    expect(locateCode(dir, "gl_FragColor = vec4(colr, 1.0);")).toBe("src/shader.js:3");
    expect(locateCode(dir, "x")).toBeUndefined();
  });
});
